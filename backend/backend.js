const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const express = require("express");
const axios = require("axios");
const XLSX = require("xlsx");
const exportsDb = require("./db.js");

const app = express();
const PORT = Number(process.env.API_PORT || 3001);
const UI_PORT = Number(process.env.UI_PORT || 3002);
const HOST = process.env.HOST || "127.0.0.1";
// Anchored to this file's own folder (backend/) rather than process.cwd(),
// so paths resolve correctly no matter where `node backend.js` is launched from.
const ROOT = __dirname;

const ORGS_FILE = process.env.NS_ORGS_FILE || "orgs.json";
// exports/ is now only a transient working folder — the export script writes
// CSVs there while a run is in progress (needed so an interrupted run can
// resume), but a *finished* file is moved into the database (db.js) and
// removed from disk. Anything left behind older than this many days is
// flushed automatically. See backfillAndFlushExports() below.
const EXPORTS_DIR = path.resolve(ROOT, "exports");
const PROGRESS_DIR = path.resolve(EXPORTS_DIR, "progress");
const EXPORT_RETENTION_DAYS = 30;
fs.mkdirSync(EXPORTS_DIR, { recursive: true });
fs.mkdirSync(PROGRESS_DIR, { recursive: true });
const UI_BASE_URL = process.env.UI_BASE_URL || `http://localhost:${UI_PORT}`;
// HOST/PORT are for internal binding (e.g. 127.0.0.1 behind a reverse proxy) —
// never the address NetSuite should redirect back to. This is that public
// address instead. Set it explicitly in production; falling back to HOST:PORT
// is only correct for local dev, where nothing sits in front of this server.
const PUBLIC_API_BASE_URL = process.env.PUBLIC_API_BASE_URL || `http://${HOST}:${PORT}`;
const allowedOrigins = new Set([
  UI_BASE_URL,
  `http://localhost:${UI_PORT}`,
  `http://127.0.0.1:${UI_PORT}`
]);
const ALLOWED_PAYMENT_TYPES = new Set([
  "vendorpayment",
  "customerpayment",
  "depositapplication",
  "journalentry"
]);

app.use((req, res, next) => {
  const origin = String(req.headers.origin || "");
  if (!origin || allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || UI_BASE_URL);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

app.use(express.json());

const jobs = new Map();
// Live child process per running jobId, so a cancel request from the UI has
// something to actually kill. Cleared as soon as the process exits either way.
const childProcesses = new Map();
const interactiveAuthByOrg = new Map();
const pendingAuthStates = new Map();
const runtimeProfiles = new Map();
const RUNTIME_ONLY_MODE = false;
let orgsWriteChain = Promise.resolve();

// --- App login (gates use of the whole tool, separate from NetSuite's own OAuth) ---
const APP_USERNAME = String(process.env.APP_USERNAME || "");
const APP_PASSWORD = String(process.env.APP_PASSWORD || "");
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const sessions = new Map(); // token -> { expiresAtMs }
// Hit directly via full-page browser navigation/redirect (no custom headers reach these),
// so they can't carry our Authorization bearer token and must stay outside the session guard.
const PUBLIC_API_PATHS = new Set(["/api/login", "/api/session/status", "/api/auth/login", "/api/auth/callback"]);

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function isSessionValid(token) {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (session.expiresAtMs <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

app.use((req, res, next) => {
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  if (!isSessionValid(getBearerToken(req))) {
    return res.status(401).json({ ok: false, error: "Not logged in." });
  }
  next();
});

app.post("/api/login", (req, res) => {
  if (!APP_USERNAME || !APP_PASSWORD) {
    return res.status(503).json({
      ok: false,
      error: "App login is not configured. Ask whoever manages this server to set APP_USERNAME and APP_PASSWORD."
    });
  }
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  if (!timingSafeStringEqual(username, APP_USERNAME) || !timingSafeStringEqual(password, APP_PASSWORD)) {
    return res.status(401).json({ ok: false, error: "Incorrect username or password." });
  }
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { expiresAtMs: Date.now() + SESSION_TTL_MS });
  res.json({ ok: true, token });
});

app.get("/api/session/status", (req, res) => {
  res.json({ authenticated: isSessionValid(getBearerToken(req)) });
});
const DEFAULT_SUITEQL_RETRY_MS = 1200;
const MAX_SUITEQL_RETRIES = 3;
const MAX_SPREADSHEET_CONVERSION_BYTES = Number(
  process.env.NS_XLSX_MAX_INPUT_BYTES || 25 * 1024 * 1024
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "org";
}

function countFailedIds(failedIdsFile, paymentTypes) {
  try {
    const fullPath = path.resolve(ROOT, failedIdsFile);
    if (!fs.existsSync(fullPath)) return 0;
    const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    return paymentTypes.reduce(
      (sum, type) => sum + (Array.isArray(data[type]) ? data[type].length : 0),
      0
    );
  } catch {
    return 0;
  }
}

// Scans a chunk of the export script's stdout for progress markers and updates
// the job's live progress summary in place. Cheap regex parsing of lines the
// script already logs (see [INFO]/[HEARTBEAT]/[DONE] in netsuite-export.js) —
// no protocol change needed between the two processes.
// `total_written`/`Total written` in the script's own logs is scoped per payment
// type (resets for each type), so we track each type's count separately and sum
// them for the overall total — otherwise the total would visibly drop every time
// the export moves on to the next data type.
function updateJobProgress(progress, text) {
  for (const m of text.matchAll(/\[INFO\] Export start: (\w+),/g)) {
    progress.currentType = m[1];
    if (!(m[1] in progress.perTypeWritten)) progress.perTypeWritten[m[1]] = 0;
  }
  for (const m of text.matchAll(/\[HEARTBEAT\] (\w+) .*?total_written=(\d+)/g)) {
    progress.perTypeWritten[m[1]] = Number(m[2]);
  }
  for (const m of text.matchAll(/\[DONE\] No more records for (\w+)\. Total written=(\d+)/g)) {
    progress.perTypeWritten[m[1]] = Number(m[2]);
    if (!progress.completedTypes.includes(m[1])) progress.completedTypes.push(m[1]);
  }
  for (const m of text.matchAll(/\[SUCCESS\] All records fetched for (\w+)\. SessionTotal=\d+ FileTotal=(\d+)/g)) {
    progress.perTypeWritten[m[1]] = Number(m[2]);
    if (!progress.completedTypes.includes(m[1])) progress.completedTypes.push(m[1]);
  }
  // NetSuite hands back the total matching-record count on the very first page
  // of the same ID query we already run — no separate count query needed. Once
  // every requested type has reported its expected count, totalExpected turns
  // the progress bar from a blind sweep into a real percentage.
  for (const m of text.matchAll(/\[INFO\] (\w+) totalResults=(\d+)/g)) {
    progress.perTypeExpected[m[1]] = Number(m[2]);
  }
  progress.totalWritten = Object.values(progress.perTypeWritten).reduce((a, b) => a + b, 0);
  const knowsAllExpected = progress.types.every((t) => t in progress.perTypeExpected);
  progress.totalExpected = knowsAllExpected
    ? Object.values(progress.perTypeExpected).reduce((a, b) => a + b, 0)
    : 0;
}

function readOrgsConfig() {
  const absPath = path.resolve(ROOT, ORGS_FILE);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Orgs config not found: ${absPath}`);
  }
  return JSON.parse(fs.readFileSync(absPath, "utf8"));
}

// Moves one just-finished job's output files into the database and deletes
// them from disk. Only ever called for a job that reached "completed" — a
// failed/interrupted run's files stay on disk untouched, since those are
// exactly what the resume-on-retry logic in netsuite-export.js needs.
function migrateJobFilesToDb(job) {
  const orgSlug = slugify(job.orgName || "");
  const types = (job.progress && job.progress.types) || [];
  for (const type of types) {
    const name = `${job.runTag}_${type}.csv`;
    const full = path.join(EXPORTS_DIR, name);
    try {
      if (!fs.existsSync(full)) continue;
      const st = fs.statSync(full);
      const content = fs.readFileSync(full);
      exportsDb.insertExport({
        fileName: name,
        orgSlug,
        ext: ".csv",
        sizeBytes: st.size,
        content,
        createdAt: st.mtime.toISOString()
      });
      fs.unlinkSync(full);
    } catch (error) {
      console.log(`[WARN] Could not move ${name} into the database: ${error.message}`);
    }
  }
}

// Best-effort org attribution for files that predate per-job org tracking —
// matches the same way the old disk-scanning file list used to (a saved
// org's slug appearing anywhere in the filename). Files with no match are
// still migrated (never left orphaned on disk) but won't show under any
// company's history until they age out via retention.
function guessOrgSlugForFilename(lowerName) {
  try {
    const orgs = (readOrgsConfig().orgs || []);
    for (const org of orgs) {
      const slug = slugify(org.name);
      if (slug && lowerName.includes(slug)) return slug;
    }
  } catch {
    // orgs.json missing/unreadable — fall through
  }
  return "unknown";
}

// A run genuinely still in flight saves progress constantly (every page, at
// minimum every few seconds). If a progress file hasn't been touched in this
// long while still claiming "in_progress," nobody is ever coming back to
// resume it — treat it as abandoned rather than protecting it forever.
const ABANDONED_IN_PROGRESS_DAYS = 7;

// Runs once at startup: sweeps exports/ for anything left over from before
// this feature existed (or from a run that finished while the server was
// down and never got migrated), moves finished CSVs into the database,
// discards now-unsupported raw-JSON leftovers, and then flushes everything
// — old and newly-migrated alike — past the retention window. A file that's
// still mid-run and resumable (has a recent "in_progress" progress record)
// is left completely alone, on disk, exactly as-is.
function backfillAndFlushExports() {
  const inProgressRunTags = new Set();
  const abandonedRunTags = new Set();
  try {
    for (const pf of fs.readdirSync(PROGRESS_DIR)) {
      if (!pf.startsWith("progress_") || !pf.endsWith(".json")) continue;
      const progressPath = path.join(PROGRESS_DIR, pf);
      try {
        const data = JSON.parse(fs.readFileSync(progressPath, "utf8"));
        const runTag = pf.replace(/^progress_/, "").replace(/\.json$/, "");
        const anyInProgress = Object.values(data).some((v) => v && v.status === "in_progress");
        if (!anyInProgress) continue;
        const ageMs = Date.now() - fs.statSync(progressPath).mtimeMs;
        const abandonedMs = ABANDONED_IN_PROGRESS_DAYS * 24 * 60 * 60 * 1000;
        if (ageMs < abandonedMs) {
          inProgressRunTags.add(runTag);
        } else {
          abandonedRunTags.add(runTag);
        }
      } catch {
        // one unreadable progress file shouldn't block the rest
      }
    }
  } catch {
    // PROGRESS_DIR unreadable — proceed with an empty protected set
  }

  let migrated = 0;
  let discardedLegacy = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(EXPORTS_DIR, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue; // skips the progress/ subfolder
    const name = entry.name;
    const lowerName = name.toLowerCase();
    const ext = path.extname(name).toLowerCase();
    const full = path.join(EXPORTS_DIR, name);

    const isResumable = [...inProgressRunTags].some((tag) => name.startsWith(`${tag}_`));
    if (isResumable) continue;

    if (ext === ".csv") {
      try {
        const st = fs.statSync(full);
        const content = fs.readFileSync(full);
        const orgSlug = guessOrgSlugForFilename(lowerName);
        exportsDb.insertExport({
          fileName: name,
          orgSlug,
          ext: ".csv",
          sizeBytes: st.size,
          content,
          createdAt: st.mtime.toISOString()
        });
        fs.unlinkSync(full);
        migrated++;
      } catch (error) {
        console.log(`[WARN] Could not migrate ${name} into the database: ${error.message}`);
      }
    } else if (ext === ".jsonl" || ext === ".json") {
      // Raw-JSON export output was retired; anything here predates that.
      try {
        fs.unlinkSync(full);
        discardedLegacy++;
      } catch {
        // not worth failing startup over
      }
    }
  }

  // Its files are handled above like any other unprotected file — this just
  // clears out the now-stale "in_progress" marker itself, so a re-run of
  // that exact company/dates starts clean instead of trying to resume into
  // a file that no longer exists on disk (it's in the database now).
  let abandonedCleared = 0;
  for (const tag of abandonedRunTags) {
    try {
      fs.unlinkSync(path.join(PROGRESS_DIR, `progress_${tag}.json`));
      abandonedCleared++;
    } catch {
      // already gone — fine either way
    }
  }

  const cutoff = new Date(Date.now() - EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const flushed = exportsDb.deleteOlderThan(cutoff);

  console.log(
    `[INFO] Export storage: moved ${migrated} file(s) into the database, ` +
      `discarded ${discardedLegacy} legacy raw-JSON file(s), flushed ${flushed.length} ` +
      `export(s) older than ${EXPORT_RETENTION_DAYS} days, cleared ${abandonedCleared} ` +
      `abandoned in-progress marker(s) untouched for ${ABANDONED_IN_PROGRESS_DAYS}+ days.`
  );
}

function getOrgByName(orgName) {
  const config = readOrgsConfig();
  const org = (config.orgs || []).find((o) => String(o.name || "") === String(orgName || ""));
  if (!org) {
    throw new Error(`Org not found: ${orgName}`);
  }
  return { org, defaults: config.defaults || {} };
}

function writeOrgsConfig(config) {
  const absPath = path.resolve(ROOT, ORGS_FILE);
  const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmpPath, absPath);
}

// Serializes read-modify-write access to orgs.json within this process only.
// Does not protect against a second backend instance or a manual edit happening at the same time.
function withOrgsWriteLock(mutator) {
  const run = orgsWriteChain.then(mutator, mutator);
  orgsWriteChain = run.then(() => {}, () => {});
  return run;
}

function requireField(org, fieldName) {
  const value = org[fieldName];
  if (!String(value || "").trim()) {
    throw new Error(`Missing '${fieldName}' for org '${org.name || org.accountId}'.`);
  }
  return String(value).trim();
}

function getPrivateKeyPem(org) {
  const inline = String(org.privateKeyPem || "").trim();
  if (inline) {
    return inline.replace(/\\n/g, "\n");
  }
  const privateKeyPath = String(org.privateKeyPath || "").trim();
  if (privateKeyPath) {
    return fs.readFileSync(path.resolve(ROOT, privateKeyPath), "utf8");
  }
  throw new Error(`Missing 'privateKeyPem/privateKeyPath' for org '${org.name || org.accountId}'.`);
}

function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function buildClientAssertionJwt(org) {
  const accountId = requireField(org, "accountId");
  const clientId = requireField(org, "clientId");
  const certificateId = requireField(org, "certificateId");
  const tokenUrl =
    org.tokenUrl ||
    `https://${accountId}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;
  const scope = String(org.scope || "rest_webservices");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "PS256", typ: "JWT", kid: certificateId };
  const payload = {
    iss: clientId,
    scope,
    aud: tokenUrl,
    iat: now,
    exp: now + 300
  };

  const keyPem = getPrivateKeyPem(org);
  const h = base64UrlEncode(JSON.stringify(header));
  const p = base64UrlEncode(JSON.stringify(payload));
  const unsigned = `${h}.${p}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), {
    key: keyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  });
  return { tokenUrl, jwt: `${unsigned}.${base64UrlEncode(signature)}` };
}

function createRuntimeOrg(input) {
  const orgName = String(input?.orgName || "").trim();
  const accountId = String(input?.accountId || "").trim();
  const clientId = String(input?.clientId || "").trim();
  const certificateId = String(input?.certificateId || "").trim();
  const privateKeyPem = String(input?.privateKeyPem || "").trim();
  const scope = String(input?.scope || "rest_webservices").trim() || "rest_webservices";
  const tokenUrl = String(input?.tokenUrl || "").trim();

  if (!orgName) throw new Error("orgName is required.");
  if (!accountId) throw new Error("accountId is required.");
  if (!clientId) throw new Error("clientId is required.");
  if (!certificateId) throw new Error("certificateId is required.");
  if (!privateKeyPem) throw new Error("privateKeyPem is required.");

  return {
    name: orgName,
    accountId,
    clientId,
    certificateId,
    privateKeyPem,
    scope,
    tokenUrl
  };
}

async function testOrgConnection(org) {
  const { tokenUrl, jwt } = buildClientAssertionJwt(org);
  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set(
    "client_assertion_type",
    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
  );
  params.set("client_assertion", jwt);

  const resp = await axios.post(tokenUrl, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30000,
    validateStatus: () => true
  });

  if (resp.status < 200 || resp.status >= 300 || !resp.data?.access_token) {
    const details = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || {});
    throw new Error(`Token request failed: HTTP ${resp.status} ${details}`);
  }
  return resp.data.access_token;
}

function makeRandomId() {
  return crypto.randomBytes(16).toString("hex");
}

async function exchangeAuthorizationCode(org, code, redirectUri) {
  const accountId = requireField(org, "accountId");
  const clientId = requireField(org, "clientId");
  const clientSecret = requireField(org, "clientSecret");
  const tokenUrl =
    org.tokenUrl ||
    `https://${accountId}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;

  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("code", code);
  params.set("redirect_uri", redirectUri);

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const resp = await axios.post(tokenUrl, params.toString(), {
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    timeout: 30000,
    validateStatus: () => true
  });

  if (resp.status < 200 || resp.status >= 300 || !resp.data?.access_token) {
    const details = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || {});
    throw new Error(`Authorization code exchange failed: HTTP ${resp.status} ${details}`);
  }

  return {
    accessToken: resp.data.access_token,
    refreshToken: resp.data.refresh_token || "",
    expiresInSec: Number(resp.data.expires_in || 3600)
  };
}

async function refreshAccessToken(org, refreshToken) {
  const accountId = requireField(org, "accountId");
  const clientId = requireField(org, "clientId");
  const clientSecret = requireField(org, "clientSecret");
  const tokenUrl =
    org.tokenUrl ||
    `https://${accountId}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;

  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", refreshToken);

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const resp = await axios.post(tokenUrl, params.toString(), {
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    timeout: 30000,
    validateStatus: () => true
  });

  if (resp.status < 200 || resp.status >= 300 || !resp.data?.access_token) {
    const details = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || {});
    throw new Error(`Refresh token exchange failed: HTTP ${resp.status} ${details}`);
  }

  return {
    accessToken: resp.data.access_token,
    // NetSuite may or may not rotate the refresh token on each use; keep the old one if none returned.
    refreshToken: resp.data.refresh_token || refreshToken,
    expiresInSec: Number(resp.data.expires_in || 3600)
  };
}

// Returns a usable access token for an interactively-logged-in org, silently
// refreshing it via the stored refresh token if the access token has expired.
// Returns null if there's no session or the refresh itself fails (session expired for real).
async function getValidInteractiveAccessToken(orgName) {
  const session = interactiveAuthByOrg.get(orgName);
  if (!session) return null;
  if (session.accessToken && session.expiresAtMs > Date.now() + 5000) {
    return session.accessToken;
  }
  if (!session.refreshToken) return null;
  try {
    const { org } = getOrgByName(orgName);
    const tokenData = await refreshAccessToken(org, session.refreshToken);
    interactiveAuthByOrg.set(orgName, {
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAtMs: Date.now() + Math.max(60, tokenData.expiresInSec - 60) * 1000
    });
    return tokenData.accessToken;
  } catch {
    return null;
  }
}

async function runSuiteQl(org, accessToken, query) {
  const accountId = requireField(org, "accountId");
  const url =
    `https://${accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=1000&offset=0`;

  for (let attempt = 1; attempt <= MAX_SUITEQL_RETRIES; attempt++) {
    const resp = await axios.post(
      url,
      { q: query },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          prefer: "transient",
          "Content-Type": "application/json"
        },
        timeout: 30000,
        validateStatus: () => true
      }
    );

    if (resp.status !== 429 || attempt === MAX_SUITEQL_RETRIES) {
      return resp;
    }

    const retryAfterSec = Number(resp.headers?.["retry-after"] || 0);
    const backoffMs = retryAfterSec > 0
      ? retryAfterSec * 1000
      : DEFAULT_SUITEQL_RETRY_MS * Math.pow(2, attempt - 1);
    await sleep(backoffMs);
  }

  return { status: 429, data: { error: "CONCURRENCY_LIMIT_EXCEEDED" } };
}

async function fetchFarmsForOrg(org, accessToken) {
  const subsidiaryResp = await runSuiteQl(
    org,
    accessToken,
    "SELECT id, name FROM subsidiary ORDER BY name"
  );

  if (subsidiaryResp.status >= 200 && subsidiaryResp.status < 300) {
    const items = (subsidiaryResp.data?.items || []).map((item) => ({
      id: String(item.id || ""),
      name: String(item.name || item.fullname || item.companyname || item.id || "")
    }));
    return { farms: items, source: "subsidiary", warning: "" };
  }

  const locationResp = await runSuiteQl(
    org,
    accessToken,
    "SELECT id, name FROM location ORDER BY name"
  );
  if (locationResp.status >= 200 && locationResp.status < 300) {
    const items = (locationResp.data?.items || []).map((item) => ({
      id: String(item.id || ""),
      name: String(item.name || item.fullname || item.companyname || item.id || "")
    }));
    return {
      farms: items,
      source: "location",
      warning: "Subsidiary list unavailable for this role/account. Showing locations."
    };
  }

  const subDetails =
    typeof subsidiaryResp.data === "string"
      ? subsidiaryResp.data
      : JSON.stringify(subsidiaryResp.data || {});
  const locDetails =
    typeof locationResp.data === "string"
      ? locationResp.data
      : JSON.stringify(locationResp.data || {});

  return {
    farms: [],
    source: "none",
    warning:
      `Could not load subsidiary/location list. ` +
      `Subsidiary HTTP ${subsidiaryResp.status}: ${subDetails}. ` +
      `Location HTTP ${locationResp.status}: ${locDetails}.`
  };
}

// Returns only the file(s) a specific job actually produced, so the UI can show
// "your download" without mixing in every export anyone has ever run for this org.
function jobOutputFiles(job) {
  if (!job || !job.runTag) return [];
  const rows = [];
  const types = (job.progress && job.progress.types) || [];
  for (const type of types) {
    const name = `${job.runTag}_${type}.csv`;
    // Once the job completes, its files move into the database (and off
    // disk) almost immediately — check there first so the "ready to
    // download" screen doesn't go blank the moment that migration runs.
    const dbMeta = exportsDb.getExportMeta(name);
    if (dbMeta) {
      rows.push({ name, ext: dbMeta.ext, sizeBytes: dbMeta.sizeBytes, modifiedAt: dbMeta.modifiedAt });
      continue;
    }
    const full = path.join(EXPORTS_DIR, name);
    if (fs.existsSync(full)) {
      const st = fs.statSync(full);
      rows.push({ name, ext: ".csv", sizeBytes: st.size, modifiedAt: st.mtime.toISOString() });
    }
  }
  if (job.rawJsonFile) {
    const full = path.join(EXPORTS_DIR, job.rawJsonFile);
    if (fs.existsSync(full)) {
      const st = fs.statSync(full);
      rows.push({ name: job.rawJsonFile, ext: ".jsonl", sizeBytes: st.size, modifiedAt: st.mtime.toISOString() });
    }
  }
  rows.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
  return rows;
}

function csvTextToRows(csvText) {
  const workbook = XLSX.read(csvText, { type: "string" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
}

function withDownloadMeta(rows, sourceFile) {
  const exportedAt = new Date().toISOString();
  return (rows || []).map((row) => ({
    ...row,
    source_file: sourceFile,
    exported_at: exportedAt
  }));
}

function runtimeOnlyDisabled(res) {
  return res.status(410).json({
    ok: false,
    error: "This endpoint is disabled. Use /api/runtime/connect and /api/runtime/export."
  });
}

app.get("/api/orgs", (req, res) => {
  if (RUNTIME_ONLY_MODE) {
    return runtimeOnlyDisabled(res);
  }
  try {
    const config = readOrgsConfig();
    const orgs = (config.orgs || []).map((org) => ({
      name: org.name,
      accountId: org.accountId,
      authMethod: org.authMethod === "interactive" ? "interactive" : "m2m"
    }));
    res.json({ orgs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Saves a company that authenticates via OAuth 2.0 Authorization Code Grant
// (interactive NetSuite login) instead of a certificate. No certificate/private
// key needed, but a human has to click "Login with NetSuite" the first time
// (and roughly weekly thereafter, whenever the refresh token itself expires).
app.post("/api/orgs/interactive", async (req, res) => {
  if (RUNTIME_ONLY_MODE) {
    return runtimeOnlyDisabled(res);
  }
  try {
    const orgName = String(req.body?.orgName || "").trim();
    const accountId = String(req.body?.accountId || "").trim();
    const clientId = String(req.body?.clientId || "").trim();
    const clientSecret = String(req.body?.clientSecret || "").trim();
    const redirectUri = String(req.body?.redirectUri || "").trim();
    const scope = String(req.body?.scope || "rest_webservices").trim() || "rest_webservices";

    if (!orgName) throw new Error("orgName is required.");
    if (!accountId) throw new Error("accountId is required.");
    if (!clientId) throw new Error("clientId is required.");
    if (!clientSecret) throw new Error("clientSecret is required.");

    const result = await withOrgsWriteLock(() => {
      const config = readOrgsConfig();
      const orgs = config.orgs || [];
      const idx = orgs.findIndex((o) => String(o.name || "") === orgName);
      const upsert = Boolean(req.body?.upsert);
      if (idx >= 0 && !upsert) {
        const err = new Error(
          `An org named "${orgName}" already exists. Retry with upsert:true to overwrite its saved credentials.`
        );
        err.statusCode = 409;
        throw err;
      }

      const record = {
        name: orgName,
        accountId,
        clientId,
        clientSecret,
        scope,
        authMethod: "interactive"
      };
      if (redirectUri) record.redirectUri = redirectUri;

      if (idx >= 0) orgs[idx] = record;
      else orgs.push(record);
      config.orgs = orgs;
      writeOrgsConfig(config);
      return { name: record.name, accountId: record.accountId, created: idx < 0 };
    });

    res.json({
      ok: true,
      ...result,
      redirectUriUsed: result && req.body?.redirectUri
        ? req.body.redirectUri
        : `${PUBLIC_API_BASE_URL}/api/auth/callback`
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
  }
});

app.delete("/api/orgs/:name", async (req, res) => {
  if (RUNTIME_ONLY_MODE) {
    return runtimeOnlyDisabled(res);
  }
  try {
    const targetName = String(req.params.name || "");
    const result = await withOrgsWriteLock(() => {
      const config = readOrgsConfig();
      const orgs = config.orgs || [];
      const idx = orgs.findIndex((o) => String(o.name || "") === targetName);
      if (idx < 0) {
        const err = new Error(`Org not found: ${targetName}`);
        err.statusCode = 404;
        throw err;
      }
      orgs.splice(idx, 1);
      config.orgs = orgs;
      writeOrgsConfig(config);
      return targetName;
    });
    res.json({ ok: true, removed: result });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, error: error.message });
  }
});

app.post("/api/runtime/connect", async (req, res) => {
  try {
    const org = createRuntimeOrg(req.body || {});
    const accessToken = await testOrgConnection(org);
    const farmResult = await fetchFarmsForOrg(org, accessToken);
    const files = exportsDb.listExportsForOrgSlug(slugify(org.name));
    const runtimeId = makeRandomId();

    runtimeProfiles.set(runtimeId, {
      id: runtimeId,
      org,
      createdAt: Date.now()
    });

    res.json({
      ok: true,
      runtimeId,
      orgName: org.name,
      files,
      farms: farmResult.farms,
      farmSource: farmResult.source,
      farmWarning: farmResult.warning
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/auth/login", async (req, res) => {
  if (RUNTIME_ONLY_MODE) {
    return runtimeOnlyDisabled(res);
  }
  try {
    const orgName = String(req.query.orgName || "");
    const { org } = getOrgByName(orgName);
    const accountId = requireField(org, "accountId");
    const clientId = requireField(org, "clientId");
    const scope = encodeURIComponent(String(org.scope || "rest_webservices"));
    const redirectUri = org.redirectUri || `${PUBLIC_API_BASE_URL}/api/auth/callback`;
    const state = makeRandomId();
    pendingAuthStates.set(state, { orgName, redirectUri });

    const authorizeUrl =
      `https://${accountId}.app.netsuite.com/app/login/oauth2/authorize.nl` +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${scope}` +
      `&state=${encodeURIComponent(state)}`;

    res.redirect(authorizeUrl);
  } catch (error) {
    res.status(400).send(error.message);
  }
});

app.post("/api/auth/exchange", async (req, res) => {
  if (RUNTIME_ONLY_MODE) {
    return runtimeOnlyDisabled(res);
  }
  try {
    const code = String(req.body?.code || "");
    const state = String(req.body?.state || "");
    if (!code || !state || !pendingAuthStates.has(state)) {
      throw new Error("Invalid OAuth state/code. Start login again.");
    }

    const stateData = pendingAuthStates.get(state);
    pendingAuthStates.delete(state);

    const { org } = getOrgByName(stateData.orgName);
    const tokenData = await exchangeAuthorizationCode(org, code, stateData.redirectUri);
    interactiveAuthByOrg.set(stateData.orgName, {
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAtMs: Date.now() + Math.max(60, tokenData.expiresInSec - 60) * 1000
    });

    res.json({ ok: true, orgName: stateData.orgName });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/auth/callback", async (req, res) => {
  if (RUNTIME_ONLY_MODE) {
    return res.redirect(`${UI_BASE_URL}/?auth=error&message=${encodeURIComponent("Runtime-only mode enabled")}`);
  }
  try {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    if (!code || !state || !pendingAuthStates.has(state)) {
      throw new Error("Invalid OAuth callback state/code.");
    }
    const stateData = pendingAuthStates.get(state);
    pendingAuthStates.delete(state);

    const { org } = getOrgByName(stateData.orgName);
    const tokenData = await exchangeAuthorizationCode(org, code, stateData.redirectUri);
    interactiveAuthByOrg.set(stateData.orgName, {
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAtMs: Date.now() + Math.max(60, tokenData.expiresInSec - 60) * 1000
    });

    res.redirect(
      `${UI_BASE_URL}/?auth=ok&org=${encodeURIComponent(stateData.orgName)}`
    );
  } catch (error) {
    res.redirect(`${UI_BASE_URL}/?auth=error&message=${encodeURIComponent(error.message)}`);
  }
});

app.get("/api/auth/status", async (req, res) => {
  if (RUNTIME_ONLY_MODE) {
    return runtimeOnlyDisabled(res);
  }
  try {
    const orgName = String(req.query.orgName || "");
    const accessToken = await getValidInteractiveAccessToken(orgName);
    if (!accessToken) {
      return res.json({ connected: false, farms: [] });
    }
    const { org } = getOrgByName(orgName);
    const farmResult = await fetchFarmsForOrg(org, accessToken);
    res.json({
      connected: true,
      farms: farmResult.farms,
      farmSource: farmResult.source,
      farmWarning: farmResult.warning
    });
  } catch (error) {
    res.status(400).json({ connected: false, error: error.message });
  }
});

async function fetchFileCabinetFiles(org, accessToken) {
  const query = "SELECT id, name, folder, url FROM File ORDER BY id DESC";
  const resp = await runSuiteQl(org, accessToken, query);

  if (resp.status < 200 || resp.status >= 300) {
    const details = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || {});
    throw new Error(`File query failed: HTTP ${resp.status} ${details}`);
  }

  return (resp.data?.items || []).map((row) => ({
    id: String(row.id || ""),
    name: String(row.name || ""),
    folder: String(row.folder || ""),
    url: String(row.url || "")
  }));
}

// Multiple exports can run at once — different companies, or the same
// company with different dates, never touch the same files. The one real
// collision is two runs sharing a runTag (same company + same date range):
// they'd write the same progress file and CSV out from under each other
// even if the record types picked differ, since progress is one JSON file
// per runTag with every type as a key inside it. So the lock is per-runTag,
// not global.
function findRunningJobByRunTag(runTag) {
  for (const [id, job] of jobs) {
    if (job.status === "running" && job.runTag === runTag) return id;
  }
  return null;
}

app.post("/api/export", async (req, res) => {
  if (RUNTIME_ONLY_MODE) {
    return runtimeOnlyDisabled(res);
  }
  try {
    const orgName = String(req.body?.orgName || "");
    const startDate = String(req.body?.startDate || "");
    const endDate = String(req.body?.endDate || "");
    const paymentTypes = Array.isArray(req.body?.paymentTypes)
      ? req.body.paymentTypes.map((v) => String(v).trim()).filter(Boolean)
      : [];
    const invalidTypes = paymentTypes.filter((t) => !ALLOWED_PAYMENT_TYPES.has(t.toLowerCase()));
    const farmId = String(req.body?.farmId || "").trim();
    const connectionMode = String(req.body?.connectionMode || "saved").toLowerCase();
    const concurrency = Number(req.body?.concurrency || 0);
    const minRequestIntervalMs = Number(req.body?.minRequestIntervalMs || 0);
    const maxRequestIntervalMs = Number(req.body?.maxRequestIntervalMs || 0);
    const depositappMaxConcurrency = Number(req.body?.depositappMaxConcurrency || 0);
    const rawJsonEnabled = req.body?.rawJsonEnabled !== false;
    const rawJsonMax = Number(req.body?.rawJsonMax || -1);

    if (!orgName || !startDate || !endDate || !paymentTypes.length) {
      return res
        .status(400)
        .json({ error: "orgName, startDate, endDate, paymentTypes are required." });
    }
    if (invalidTypes.length) {
      return res.status(400).json({
        ok: false,
        error: `Unsupported paymentTypes: ${invalidTypes.join(", ")}`
      });
    }
    if (concurrency && (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 40)) {
      return res.status(400).json({ ok: false, error: "concurrency must be between 1 and 40." });
    }
    if (
      minRequestIntervalMs &&
      (!Number.isFinite(minRequestIntervalMs) || minRequestIntervalMs < 100 || minRequestIntervalMs > 5000)
    ) {
      return res.status(400).json({
        ok: false,
        error: "minRequestIntervalMs must be between 100 and 5000."
      });
    }
    if (
      maxRequestIntervalMs &&
      (!Number.isFinite(maxRequestIntervalMs) || maxRequestIntervalMs < 500 || maxRequestIntervalMs > 60000)
    ) {
      return res.status(400).json({
        ok: false,
        error: "maxRequestIntervalMs must be between 500 and 60000."
      });
    }
    if (
      depositappMaxConcurrency &&
      (!Number.isFinite(depositappMaxConcurrency) ||
        depositappMaxConcurrency < 1 ||
        depositappMaxConcurrency > 10)
    ) {
      return res.status(400).json({
        ok: false,
        error: "depositappMaxConcurrency must be between 1 and 10."
      });
    }

    const { org } = getOrgByName(orgName);
    const accountId = requireField(org, "accountId");

    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const logs = [];
    const orgSlug = slugify(orgName);
    const runTag = `${orgSlug}_${startDate}_${endDate}`
      .replace(/[^a-zA-Z0-9_\-]+/g, "_");

    const conflictingJobId = findRunningJobByRunTag(runTag);
    if (conflictingJobId) {
      return res.status(409).json({
        ok: false,
        error:
          `This company and date range is already being exported (job: ${conflictingJobId}). ` +
          "Wait for it to finish, or pick different dates."
      });
    }

    const rawJsonFile = rawJsonEnabled ? `raw_${runTag}_${jobId}.jsonl` : "";
    jobs.set(jobId, {
      status: "running",
      logs,
      startedAt: new Date().toISOString(),
      runTag,
      rawJsonFile,
      // Kept so a browser that reloads mid-export can be handed back everything
      // it needs to redraw the progress screen for this run.
      orgName,
      startDate,
      endDate,
      farmId,
      progress: {
        totalWritten: 0,
        totalExpected: 0,
        currentType: paymentTypes[0] || "",
        completedTypes: [],
        types: paymentTypes,
        perTypeWritten: {},
        perTypeExpected: {}
      }
    });

    const env = {
      ...process.env,
      NS_AUTH_MODE: "oauth2",
      NS_ACCOUNT_ID: accountId,
      NS_START_DATE: startDate,
      NS_END_DATE: endDate,
      NS_PAYMENT_TYPES: paymentTypes.join(","),
      NS_OUTPUT_FILE: "",
      NS_OUTPUT_PREFIX: `exports/${runTag}`,
      NS_PROGRESS_FILE: `exports/progress/progress_${runTag}.json`,
      NS_FAILED_IDS_FILE: `exports/progress/failed_ids_${runTag}.json`,
      NS_DISABLE_CSV_OUTPUT: "0"
    };
    if (rawJsonEnabled) {
      env.NS_DEBUG_JSON_FILE = `exports/${rawJsonFile}`;
      env.NS_DEBUG_JSON_MAX = String(Number.isFinite(rawJsonMax) ? rawJsonMax : -1);
    } else {
      env.NS_DEBUG_JSON_FILE = "";
      env.NS_DEBUG_JSON_MAX = "0";
    }
    if (concurrency) {
      env.NS_CONCURRENCY = String(concurrency);
    }
    if (minRequestIntervalMs) {
      env.NS_MIN_REQUEST_INTERVAL_MS = String(minRequestIntervalMs);
    }
    if (maxRequestIntervalMs) {
      env.NS_MAX_REQUEST_INTERVAL_MS = String(maxRequestIntervalMs);
    }
    if (depositappMaxConcurrency) {
      env.NS_DEPOSITAPP_MAX_CONCURRENCY = String(depositappMaxConcurrency);
    }

    // Login with NetSuite (OAuth2 Authorization Code Grant) is the only
    // supported connection method — certificate/private-key auth was removed.
    if (connectionMode !== "interactive") {
      return res.status(400).json({
        ok: false,
        error: `"${orgName}" is not connected via Login with NetSuite. Remove it and add it again through that flow.`
      });
    }
    const accessToken = await getValidInteractiveAccessToken(orgName);
    if (!accessToken) {
      return res.status(400).json({ ok: false, error: "NetSuite login expired. Login again." });
    }
    env.NS_OAUTH2_ACCESS_TOKEN = accessToken;
    // A NetSuite access token only lives ~60 minutes, and a big export easily
    // runs longer than that. Hand the child the refresh credentials as well so
    // it can renew mid-run; without them every request past the first hour
    // 401s, and the export keeps "completing" records while writing no rows.
    const session = interactiveAuthByOrg.get(orgName);
    if (session?.refreshToken) {
      env.NS_OAUTH2_REFRESH_TOKEN = session.refreshToken;
      env.NS_OAUTH2_CLIENT_ID = requireField(org, "clientId");
      env.NS_OAUTH2_CLIENT_SECRET = requireField(org, "clientSecret");
    }
    if (farmId) {
      env.NS_SUBSIDIARY_ID = farmId;
    }

    if (org.tokenUrl) {
      env.NS_OAUTH2_TOKEN_URL = String(org.tokenUrl);
    }

    const child = spawn(process.execPath, ["netsuite-export.js"], {
      cwd: ROOT,
      env
    });
    childProcesses.set(jobId, child);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      logs.push(text);
      if (logs.length > 400) logs.shift();
      const job = jobs.get(jobId);
      if (job?.progress) updateJobProgress(job.progress, text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      logs.push(text);
      if (logs.length > 400) logs.shift();
    });

    child.on("close", (code) => {
      childProcesses.delete(jobId);
      const job = jobs.get(jobId);
      if (!job) return;
      job.status = code === 0 ? "completed" : job.cancelRequested ? "cancelled" : "failed";
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      job.failedCount = countFailedIds(env.NS_FAILED_IDS_FILE, paymentTypes);
      if (job.status === "completed") {
        migrateJobFilesToDb(job);
      }
    });

    res.json({
      ok: true,
      jobId,
      rawJsonFile: rawJsonEnabled ? `raw_${runTag}_${jobId}.jsonl` : ""
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/runtime/export", async (req, res) => {
  try {
    const runtimeId = String(req.body?.runtimeId || "").trim();
    const runtimeProfile = runtimeProfiles.get(runtimeId);
    if (!runtimeId || !runtimeProfile) {
      return res.status(400).json({
        ok: false,
        error: "Invalid or expired runtime session. Please connect again."
      });
    }

    const org = runtimeProfile.org;
    const orgName = String(req.body?.orgName || org.name || "").trim() || "runtime_org";
    const startDate = String(req.body?.startDate || "");
    const endDate = String(req.body?.endDate || "");
    const paymentTypes = Array.isArray(req.body?.paymentTypes)
      ? req.body.paymentTypes.map((v) => String(v).trim()).filter(Boolean)
      : [];
    const invalidTypes = paymentTypes.filter((t) => !ALLOWED_PAYMENT_TYPES.has(t.toLowerCase()));
    const farmId = String(req.body?.farmId || "").trim();
    const concurrency = Number(req.body?.concurrency || 0);
    const minRequestIntervalMs = Number(req.body?.minRequestIntervalMs || 0);
    const maxRequestIntervalMs = Number(req.body?.maxRequestIntervalMs || 0);
    const depositappMaxConcurrency = Number(req.body?.depositappMaxConcurrency || 0);
    const rawJsonEnabled = req.body?.rawJsonEnabled !== false;
    const rawJsonMax = Number(req.body?.rawJsonMax || -1);

    if (!startDate || !endDate || !paymentTypes.length) {
      return res
        .status(400)
        .json({ ok: false, error: "startDate, endDate, paymentTypes are required." });
    }
    if (invalidTypes.length) {
      return res.status(400).json({
        ok: false,
        error: `Unsupported paymentTypes: ${invalidTypes.join(", ")}`
      });
    }
    if (concurrency && (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 40)) {
      return res.status(400).json({ ok: false, error: "concurrency must be between 1 and 40." });
    }
    if (
      minRequestIntervalMs &&
      (!Number.isFinite(minRequestIntervalMs) || minRequestIntervalMs < 100 || minRequestIntervalMs > 5000)
    ) {
      return res.status(400).json({
        ok: false,
        error: "minRequestIntervalMs must be between 100 and 5000."
      });
    }
    if (
      maxRequestIntervalMs &&
      (!Number.isFinite(maxRequestIntervalMs) || maxRequestIntervalMs < 500 || maxRequestIntervalMs > 60000)
    ) {
      return res.status(400).json({
        ok: false,
        error: "maxRequestIntervalMs must be between 500 and 60000."
      });
    }
    if (
      depositappMaxConcurrency &&
      (!Number.isFinite(depositappMaxConcurrency) ||
        depositappMaxConcurrency < 1 ||
        depositappMaxConcurrency > 10)
    ) {
      return res.status(400).json({
        ok: false,
        error: "depositappMaxConcurrency must be between 1 and 10."
      });
    }

    const accountId = requireField(org, "accountId");
    const clientId = requireField(org, "clientId");
    const certificateId = requireField(org, "certificateId");
    const privateKeyPem = getPrivateKeyPem(org);
    const scope = String(org.scope || "rest_webservices");

    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const logs = [];
    const orgSlug = slugify(orgName);
    const runTag = `${orgSlug}_${startDate}_${endDate}`
      .replace(/[^a-zA-Z0-9_\-]+/g, "_");

    const conflictingJobId = findRunningJobByRunTag(runTag);
    if (conflictingJobId) {
      return res.status(409).json({
        ok: false,
        error:
          `This company and date range is already being exported (job: ${conflictingJobId}). ` +
          "Wait for it to finish, or pick different dates."
      });
    }

    const rawJsonFile = rawJsonEnabled ? `raw_${runTag}_${jobId}.jsonl` : "";
    jobs.set(jobId, {
      status: "running",
      logs,
      startedAt: new Date().toISOString(),
      runTag,
      rawJsonFile,
      // Kept so a browser that reloads mid-export can be handed back everything
      // it needs to redraw the progress screen for this run.
      orgName,
      startDate,
      endDate,
      farmId,
      progress: {
        totalWritten: 0,
        totalExpected: 0,
        currentType: paymentTypes[0] || "",
        completedTypes: [],
        types: paymentTypes,
        perTypeWritten: {},
        perTypeExpected: {}
      }
    });

    const env = {
      ...process.env,
      NS_AUTH_MODE: "oauth2",
      NS_ACCOUNT_ID: accountId,
      NS_START_DATE: startDate,
      NS_END_DATE: endDate,
      NS_PAYMENT_TYPES: paymentTypes.join(","),
      NS_OUTPUT_FILE: "",
      NS_OUTPUT_PREFIX: `exports/${runTag}`,
      NS_PROGRESS_FILE: `exports/progress/progress_${runTag}.json`,
      NS_FAILED_IDS_FILE: `exports/progress/failed_ids_${runTag}.json`,
      NS_DISABLE_CSV_OUTPUT: "0",
      NS_OAUTH2_CLIENT_ID: clientId,
      NS_OAUTH2_CERTIFICATE_ID: certificateId,
      NS_OAUTH2_PRIVATE_KEY: privateKeyPem,
      NS_OAUTH2_PRIVATE_KEY_PATH: "",
      NS_OAUTH2_SCOPE: scope
    };
    if (rawJsonEnabled) {
      env.NS_DEBUG_JSON_FILE = `exports/${rawJsonFile}`;
      env.NS_DEBUG_JSON_MAX = String(Number.isFinite(rawJsonMax) ? rawJsonMax : -1);
    } else {
      env.NS_DEBUG_JSON_FILE = "";
      env.NS_DEBUG_JSON_MAX = "0";
    }
    if (concurrency) {
      env.NS_CONCURRENCY = String(concurrency);
    }
    if (minRequestIntervalMs) {
      env.NS_MIN_REQUEST_INTERVAL_MS = String(minRequestIntervalMs);
    }
    if (maxRequestIntervalMs) {
      env.NS_MAX_REQUEST_INTERVAL_MS = String(maxRequestIntervalMs);
    }
    if (depositappMaxConcurrency) {
      env.NS_DEPOSITAPP_MAX_CONCURRENCY = String(depositappMaxConcurrency);
    }
    if (farmId) {
      env.NS_SUBSIDIARY_ID = farmId;
    }
    if (org.tokenUrl) {
      env.NS_OAUTH2_TOKEN_URL = String(org.tokenUrl);
    }

    const child = spawn(process.execPath, ["netsuite-export.js"], {
      cwd: ROOT,
      env
    });
    childProcesses.set(jobId, child);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      logs.push(text);
      if (logs.length > 400) logs.shift();
      const job = jobs.get(jobId);
      if (job?.progress) updateJobProgress(job.progress, text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      logs.push(text);
      if (logs.length > 400) logs.shift();
    });

    child.on("close", (code) => {
      childProcesses.delete(jobId);
      const job = jobs.get(jobId);
      if (!job) return;
      job.status = code === 0 ? "completed" : job.cancelRequested ? "cancelled" : "failed";
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      job.failedCount = countFailedIds(env.NS_FAILED_IDS_FILE, paymentTypes);
      if (job.status === "completed") {
        migrateJobFilesToDb(job);
      }
    });

    res.json({
      ok: true,
      jobId,
      rawJsonFile: rawJsonEnabled ? `raw_${runTag}_${jobId}.jsonl` : ""
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

// Lets a freshly-loaded page find export(s) already in flight, so a refresh
// reconnects to a live run instead of dropping back to step 1. Since more
// than one export can run at once now, this returns every running job — the
// frontend only auto-reconnects through this list when there's exactly one
// (with several running, guessing which is "yours" would risk showing a
// browser someone else's in-progress export instead). A browser that already
// knows its own jobId skips this and asks for that job by id directly.
// Must stay ABOVE /api/jobs/:jobId or that route would swallow "active".
app.get("/api/jobs/active", (req, res) => {
  const running = [];
  for (const [jobId, job] of jobs) {
    if (job.status !== "running") continue;
    const { logs, ...rest } = job;
    running.push({ jobId, ...rest, outputFiles: jobOutputFiles(job) });
  }
  res.json({ jobs: running });
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json({ ...job, outputFiles: jobOutputFiles(job) });
});

// Lets the UI stop a running export — e.g. the user picked the wrong dates.
// Killing the child mid-run is exactly as safe as a dropped connection: the
// progress file stays wherever the last successful save left it, so the same
// company/dates can be re-run afterward and it resumes rather than starting
// over. Marked "cancelled" (not "failed") so the UI can say what actually
// happened, and this also frees the runTag immediately for a corrected retry.
app.post("/api/jobs/:jobId/cancel", (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }
  if (job.status !== "running") {
    return res.status(400).json({ ok: false, error: `This export already ${job.status}.` });
  }
  const child = childProcesses.get(jobId);
  if (!child) {
    return res.status(400).json({ ok: false, error: "No running process found for this export." });
  }
  job.cancelRequested = true;
  child.kill();
  res.json({ ok: true });
});

app.get("/api/netsuite/files", async (req, res) => {
  if (RUNTIME_ONLY_MODE) {
    return runtimeOnlyDisabled(res);
  }
  try {
    const orgName = String(req.query.orgName || "");
    const { org } = getOrgByName(orgName);

    const accessToken = await getValidInteractiveAccessToken(orgName);
    if (!accessToken) {
      return res.status(401).json({ ok: false, error: "NetSuite login expired. Login again." });
    }

    const files = await fetchFileCabinetFiles(org, accessToken);
    res.json({ ok: true, files });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/files", (req, res) => {
  try {
    const orgName = String(req.query.orgName || "");
    const files = exportsDb.listExportsForOrgSlug(slugify(orgName));
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Finished files live in the database now (see db.js / migrateJobFilesToDb),
// not on disk — so a download reads the row's BLOB instead of a file path.
// Raw-JSON export was retired earlier, so every row here is a CSV; xlsx is
// built from it on the fly exactly as before, just sourced from the blob.
app.get("/api/files/download", (req, res) => {
  try {
    const fileName = String(req.query.name || "");
    const format = String(req.query.format || "xlsx").toLowerCase();
    const row = exportsDb.getExport(path.basename(fileName));
    if (!row) {
      throw new Error(`File not found: ${fileName}`);
    }
    if (row.ext !== ".csv") {
      throw new Error(`Unsupported file type: ${row.ext}`);
    }
    if (!["csv", "xlsx"].includes(format)) {
      return res.status(400).json({ error: "Unsupported format. Use csv or xlsx." });
    }

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${row.fileName}"`);
      return res.send(row.content);
    }

    if (row.sizeBytes > MAX_SPREADSHEET_CONVERSION_BYTES) {
      return res.status(413).json({
        error: `File is too large to convert to XLSX in memory (${Math.ceil(row.sizeBytes / 1024 / 1024)} MB). Download CSV instead; Excel can open CSV files.`
      });
    }
    const csvText = row.content.toString("utf8");
    const rows = csvTextToRows(csvText);
    const outRows = withDownloadMeta(rows, row.fileName);
    const worksheet = XLSX.utils.json_to_sheet(outRows, { skipHeader: false });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Export");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const xlsxName = row.fileName.replace(/\.csv$/i, ".xlsx");

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${xlsxName}"`);
    return res.send(buffer);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

backfillAndFlushExports();
// Files only need checking a few times a day for the 3-day window to be
// meaningful; this just catches anything the per-job migration missed.
setInterval(backfillAndFlushExports, 6 * 60 * 60 * 1000);

const server = app.listen(PORT, HOST);

server.on("listening", () => {
  if (!server.address()) {
    return;
  }
  console.log(`Backend API running at http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Backend API cannot start because http://${HOST}:${PORT} is already in use. ` +
        "Stop the existing process or set API_PORT to another port."
    );
  } else {
    console.error(`Backend API failed to start: ${error.message}`);
  }
  process.exit(1);
});
