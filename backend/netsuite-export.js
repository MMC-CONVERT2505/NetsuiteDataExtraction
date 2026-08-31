const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
require("dotenv").config({ quiet: true });
const axios = require("axios");
const OAuth = require("oauth-1.0a");
const pLimitModule = require("p-limit");
const pLimit = typeof pLimitModule === "function" ? pLimitModule : pLimitModule.default;

// --- CONFIGURATION ---
const ACCOUNT_ID = process.env.NS_ACCOUNT_ID || "";
const AUTH_MODE = (process.env.NS_AUTH_MODE || "oauth2").toLowerCase();
const CONSUMER_KEY =
  process.env.NS_CONSUMER_KEY || "";
const CONSUMER_SECRET =
  process.env.NS_CONSUMER_SECRET || "";
const TOKEN_ID =
  process.env.NS_TOKEN_ID || "";
const TOKEN_SECRET =
  process.env.NS_TOKEN_SECRET || "";
const OAUTH2_CLIENT_ID = process.env.NS_OAUTH2_CLIENT_ID || "";
const OAUTH2_CLIENT_SECRET = process.env.NS_OAUTH2_CLIENT_SECRET || "";
const OAUTH2_CERTIFICATE_ID = process.env.NS_OAUTH2_CERTIFICATE_ID || "";
const OAUTH2_PRIVATE_KEY_PATH = process.env.NS_OAUTH2_PRIVATE_KEY_PATH || "";
const OAUTH2_PRIVATE_KEY = process.env.NS_OAUTH2_PRIVATE_KEY || "";
const OAUTH2_SCOPE = process.env.NS_OAUTH2_SCOPE || "rest_webservices";
const OAUTH2_ACCESS_TOKEN = process.env.NS_OAUTH2_ACCESS_TOKEN || "";
const OAUTH2_REFRESH_TOKEN = process.env.NS_OAUTH2_REFRESH_TOKEN || "";
const OAUTH2_TOKEN_URL =
  process.env.NS_OAUTH2_TOKEN_URL ||
  (ACCOUNT_ID
    ? `https://${ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`
    : "");

const START_DATE = process.env.NS_START_DATE || "01/01/2025";
const END_DATE = process.env.NS_END_DATE || "31/03/2025";
const PAYMENT_TYPES = (process.env.NS_PAYMENT_TYPES || "depositapplication")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const PAGE_LIMIT = Number(process.env.NS_PAGE_LIMIT || 1000);
const CONCURRENCY = Number(process.env.NS_CONCURRENCY || 2);
const WRITE_BATCH_SIZE = Number(process.env.NS_WRITE_BATCH || 200);
const PROGRESS_FILE = process.env.NS_PROGRESS_FILE || "netsuite_export_progress.json";
const QUERY_MODE = (process.env.NS_QUERY_MODE || "auto").toLowerCase();
const SOURCE_MODE = (process.env.NS_SOURCE_MODE || "auto").toLowerCase();
const FETCH_APPLY_MODE = (process.env.NS_FETCH_APPLY || "auto").toLowerCase();
const OUTPUT_MODE = (process.env.NS_OUTPUT_MODE || "accounting").toLowerCase();
const SUBSIDIARY_ID = String(process.env.NS_SUBSIDIARY_ID || "").trim();
const SUBSIDIARY_ID_NUM =
  SUBSIDIARY_ID && /^\d+$/.test(SUBSIDIARY_ID) ? Number(SUBSIDIARY_ID) : null;
const MIN_REQUEST_INTERVAL_MS = Math.max(
  100,
  Number(process.env.NS_MIN_REQUEST_INTERVAL_MS || 2000)
);
const MAX_REQUEST_INTERVAL_MS = Math.max(
  MIN_REQUEST_INTERVAL_MS,
  Number(process.env.NS_MAX_REQUEST_INTERVAL_MS || 10000)
);
const DEPOSITAPP_MAX_CONCURRENCY = Math.max(
  1,
  Number(process.env.NS_DEPOSITAPP_MAX_CONCURRENCY || 1)
);
const JOURNAL_MAX_CONCURRENCY = Math.max(
  1,
  Number(process.env.NS_JOURNAL_MAX_CONCURRENCY || 1)
);
const JOURNAL_MIN_INTERVAL_MS = Math.max(
  700,
  Number(process.env.NS_JOURNAL_MIN_INTERVAL_MS || 1800)
);
const HEARTBEAT_SEC = Math.max(2, Number(process.env.NS_HEARTBEAT_SEC || 3));
const APPLY_DETAIL_CONCURRENCY = Math.max(
  1,
  Number(process.env.NS_APPLY_DETAIL_CONCURRENCY || 1)
);
const FAILED_IDS_FILE = process.env.NS_FAILED_IDS_FILE || "netsuite_failed_ids.json";
const OUTPUT_FILE = process.env.NS_OUTPUT_FILE || "";
const OUTPUT_PREFIX = String(process.env.NS_OUTPUT_PREFIX || "").trim();
const DISABLE_CSV_OUTPUT = String(process.env.NS_DISABLE_CSV_OUTPUT || "").trim() === "1";
const DEBUG_JSON_DIR = String(process.env.NS_DEBUG_JSON_DIR || "").trim();
const DEBUG_JSON_FILE = String(process.env.NS_DEBUG_JSON_FILE || "").trim();
const DEBUG_JSON_MAX = Math.max(0, Number(process.env.NS_DEBUG_JSON_MAX || 0));
let debugJsonWritten = 0;
let supportsTransactionArAcct = true;

const ALL_COLUMNS = [
  "links",
  "applied",
  "apply",
  "autoApply",
  "balance",
  "cleared",
  "createdDate",
  "credit",
  "currency",
  "custbody_celigo_shpfy_ispickup",
  "custbody_etail_b2b_order_paid",
  "custbody_nondeductible_ref_tran",
  "customer",
  "customForm",
  "deposit",
  "exchangeRate",
  "excludeFromGLNumbering",
  "id",
  "lastModifiedDate",
  "location",
  "payment",
  "pending",
  "postingPeriod",
  "prevDate",
  "status",
  "subsidiary",
  "toBeEmailed",
  "total",
  "tranDate",
  "tranId",
  "transactionNumber",
  "unapplied",
  "undepFunds",
  "apply_amount",
  "apply_date",
  "apply_doc_id",
  "apply_doc_refName",
  "apply_account_id",
  "apply_account_refName",
  "apply_refNum",
  "apply_type",
  "account",
  "account_id",
  "account_refName",
  "paymentOperation",
  "memo"
];

const ACCOUNTING_COLUMNS = [
  "id",
  "transactionNumber",
  "tranId",
  "tranDate",
  "status",
  "customer",
  "subsidiary",
  "currency",
  "exchangeRate",
  "total",
  "payment",
  "unapplied",
  "applied",
  "account",
  "account_id",
  "account_refName",
  "memo",
  "apply_amount",
  "apply_date",
  "apply_doc_id",
  "apply_doc_refName",
  "apply_account_id",
  "apply_account_refName",
  "apply_refNum",
  "apply_type",
  "lastModifiedDate"
];

const JOURNAL_COLUMNS = [
  "id",
  "transactionNumber",
  "tranId",
  "tranDate",
  "postingPeriod_refName",
  "subsidiary_id",
  "subsidiary_refName",
  "currency_refName",
  "exchangeRate",
  "memo",
  "line_index",
  "line_account_id",
  "line_account_refName",
  "line_debit",
  "line_credit",
  "line_memo",
  "line_name_id",
  "line_name_refName",
  "line_department_id",
  "line_department_refName",
  "line_location_id",
  "line_location_refName",
  "line_class_id",
  "line_class_refName",
  "lastModifiedDate",
  "recordType"
];

function getColumnsForType(paymentType) {
  if (String(paymentType || "").toLowerCase() === "journalentry") {
    return JOURNAL_COLUMNS;
  }
  return OUTPUT_MODE === "full" ? ALL_COLUMNS : ACCOUNTING_COLUMNS;
}

const baseUrl = `https://${ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
const recordApiBase = `https://${ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/record/v1`;
const RECORDTYPE_TO_TXTYPE = {
  vendorpayment: "VendPymt",
  customerpayment: "CustPymt",
  customerdeposit: "CustDep",
  depositapplication: "DepAppl",
  journalentry: "Journal"
};

const RECORDTYPE_TO_RECORD_API = {
  journalentry: "journalEntry",
  advintercompanyjournalentry: "advInterCompanyJournalEntry",
  intercompanyjournalentry: "interCompanyJournalEntry"
};

const oauth = OAuth({
  consumer: { key: CONSUMER_KEY, secret: CONSUMER_SECRET },
  signature_method: "HMAC-SHA256",
  hash_function(baseString, key) {
    return crypto.createHmac("sha256", key).update(baseString).digest("base64");
  }
});

const token = { key: TOKEN_ID, secret: TOKEN_SECRET };
let oauth2AccessToken = "";
let oauth2ExpiresAtMs = 0;
// The env-supplied access token is good exactly once; after it ages out we must
// go get a fresh one rather than handing back the same dead string forever.
let staticAccessTokenUsed = false;
let oauth2TokenPromise = null;

const http = axios.create({
  httpsAgent: new https.Agent({
    keepAlive: true,
    maxSockets: Math.max(64, CONCURRENCY * 4),
    maxFreeSockets: 32
  }),
  timeout: 30000
});

let globalThrottleUntil = 0;
let requestIntervalMs = MIN_REQUEST_INTERVAL_MS;
let nextRequestAt = 0;
let pacingLock = Promise.resolve();
const applyDocAccountCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeDebugJson(kind, paymentType, paymentId, payload) {
  if (!DEBUG_JSON_DIR && !DEBUG_JSON_FILE) return;
  if (DEBUG_JSON_MAX > 0 && debugJsonWritten >= DEBUG_JSON_MAX) return;
  try {
    const safeType = String(paymentType || "payment").replace(/[^a-z0-9_-]+/gi, "_");
    const safeKind = String(kind || "detail").replace(/[^a-z0-9_-]+/gi, "_");
    const safeId = String(paymentId || "unknown").replace(/[^a-z0-9_-]+/gi, "_");
    const entry = {
      seq: debugJsonWritten + 1,
      kind: safeKind,
      paymentType: safeType,
      paymentId: safeId,
      data: payload
    };
    if (DEBUG_JSON_DIR) {
      const dir = path.resolve(DEBUG_JSON_DIR);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const file = path.join(
        dir,
        `${String(debugJsonWritten + 1).padStart(6, "0")}_${safeType}_${safeKind}_${safeId}.json`
      );
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
    }
    if (DEBUG_JSON_FILE) {
      const file = path.resolve(DEBUG_JSON_FILE);
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
    }
    debugJsonWritten += 1;
  } catch (error) {
    // Do not fail export for debug writes.
  }
}

async function waitForRequestSlot() {
  let release;
  const prev = pacingLock;
  pacingLock = new Promise((resolve) => {
    release = resolve;
  });

  await prev;
  try {
    const now = Date.now();
    const waitMs = Math.max(0, nextRequestAt - now);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    nextRequestAt = Date.now() + requestIntervalMs;
  } finally {
    release();
  }
}

function flattenValue(value) {
  if (Array.isArray(value)) {
    return value.map(flattenValue).join("; ");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([k, v]) => `${k}:${flattenValue(v)}`)
      .join("; ");
  }
  return value ?? "";
}

function buildRow(data, columns) {
  const normalized = { ...data };
  if (normalized.account === undefined && normalized.arAcct !== undefined) {
    normalized.account = normalized.arAcct;
  }
  const refFields = [
    "account",
    "customer",
    "subsidiary",
    "currency",
    "location",
    "deposit",
    "postingPeriod",
    "line_account",
    "line_name",
    "line_department",
    "line_location",
    "line_class"
  ];
  for (const field of refFields) {
    const ref = normalized[field];
    if (ref && typeof ref === "object" && !Array.isArray(ref)) {
      if (ref.id !== undefined && normalized[`${field}_id`] === undefined) {
        normalized[`${field}_id`] = ref.id;
      }
      if (ref.refName !== undefined && normalized[`${field}_refName`] === undefined) {
        normalized[`${field}_refName`] = ref.refName;
      }
    }
  }
  const row = {};
  for (const col of columns) {
    row[col] = flattenValue(normalized[col]);
  }
  return row;
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (text.includes('"') || text.includes(",") || text.includes("\n") || text.includes("\r")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

async function appendRowsToCsv(filename, rows, writeHeader, columns) {
  if (!rows.length && !writeHeader) return;
  const lines = [];
  if (writeHeader) {
    lines.push(columns.join(","));
  }
  for (const row of rows) {
    lines.push(columns.map((col) => escapeCsv(row[col])).join(","));
  }
  const payload = `${lines.join("\n")}\n`;
  await fs.promises.appendFile(filename, payload, "utf8");
}

function loadProgress(paymentType) {
  try {
    if (!fs.existsSync(PROGRESS_FILE)) {
      return { offset: 0, record_index: 0, status: "new" };
    }
    const raw = fs.readFileSync(PROGRESS_FILE, "utf8");
    const progress = JSON.parse(raw);
    return progress[paymentType] || { offset: 0, record_index: 0, status: "new" };
  } catch {
    return { offset: 0, record_index: 0, status: "new" };
  }
}

function saveProgress(paymentType, offset, recordIndex, status = "in_progress") {
  let progress = {};
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    }
  } catch {
    progress = {};
  }
  progress[paymentType] = { offset, record_index: recordIndex, status };
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), "utf8");
}

function appendFailedIds(paymentType, ids) {
  if (!ids.length) return;
  let data = {};
  try {
    if (fs.existsSync(FAILED_IDS_FILE)) {
      data = JSON.parse(fs.readFileSync(FAILED_IDS_FILE, "utf8"));
    }
  } catch {
    data = {};
  }
  const prev = new Set(data[paymentType] || []);
  for (const id of ids) prev.add(String(id));
  data[paymentType] = Array.from(prev);
  fs.writeFileSync(FAILED_IDS_FILE, JSON.stringify(data, null, 2), "utf8");
}

function clearFailedIds(paymentType) {
  if (!fs.existsSync(FAILED_IDS_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(FAILED_IDS_FILE, "utf8"));
    if (data[paymentType]) {
      delete data[paymentType];
      fs.writeFileSync(FAILED_IDS_FILE, JSON.stringify(data, null, 2), "utf8");
    }
  } catch {
    // Ignore a corrupt failed-ids file; a fresh run will recreate it as needed.
  }
}

function authHeader(method, url) {
  const requestData = { url, method };
  const headerObj = oauth.toHeader(oauth.authorize(requestData, token));
  return `${headerObj.Authorization}, realm="${ACCOUNT_ID}"`;
}

function requireEnv(name, value) {
  if (!String(value || "").trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

function validateAuthConfig() {
  requireEnv("NS_ACCOUNT_ID", ACCOUNT_ID);
  if (SUBSIDIARY_ID && SUBSIDIARY_ID_NUM === null) {
    throw new Error(`Invalid NS_SUBSIDIARY_ID: ${SUBSIDIARY_ID}. Expected numeric internal id.`);
  }
  if (AUTH_MODE === "oauth1") {
    requireEnv("NS_CONSUMER_KEY", CONSUMER_KEY);
    requireEnv("NS_CONSUMER_SECRET", CONSUMER_SECRET);
    requireEnv("NS_TOKEN_ID", TOKEN_ID);
    requireEnv("NS_TOKEN_SECRET", TOKEN_SECRET);
    return;
  }
  if (AUTH_MODE === "oauth2") {
    if (OAUTH2_ACCESS_TOKEN) {
      return;
    }
    requireEnv("NS_OAUTH2_CLIENT_ID", OAUTH2_CLIENT_ID);
    requireEnv("NS_OAUTH2_CERTIFICATE_ID", OAUTH2_CERTIFICATE_ID);
    requireEnv("NS_OAUTH2_SCOPE", OAUTH2_SCOPE);
    requireEnv("NS_OAUTH2_TOKEN_URL", OAUTH2_TOKEN_URL);
    if (!OAUTH2_PRIVATE_KEY_PATH && !OAUTH2_PRIVATE_KEY) {
      throw new Error(
        "Missing OAuth2 private key. Set NS_OAUTH2_PRIVATE_KEY_PATH or NS_OAUTH2_PRIVATE_KEY."
      );
    }
    return;
  }
  throw new Error(`Unsupported NS_AUTH_MODE: ${AUTH_MODE}. Use oauth2 or oauth1.`);
}

function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function loadOAuth2PrivateKey() {
  if (OAUTH2_PRIVATE_KEY) {
    return OAUTH2_PRIVATE_KEY.replace(/\\n/g, "\n");
  }
  if (OAUTH2_PRIVATE_KEY_PATH) {
    return fs.readFileSync(path.resolve(OAUTH2_PRIVATE_KEY_PATH), "utf8");
  }
  return "";
}

function buildClientAssertionJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "PS256", typ: "JWT", kid: OAUTH2_CERTIFICATE_ID };
  const payload = {
    iss: OAUTH2_CLIENT_ID,
    scope: OAUTH2_SCOPE,
    aud: OAUTH2_TOKEN_URL,
    iat: now,
    exp: now + 300
  };
  const jwtHeader = base64UrlEncode(JSON.stringify(header));
  const jwtPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedJwt = `${jwtHeader}.${jwtPayload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsignedJwt), {
    key: loadOAuth2PrivateKey(),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  });
  return `${unsignedJwt}.${base64UrlEncode(signature)}`;
}

async function fetchOAuth2AccessToken() {
  // The backend hands interactive ("Login with NetSuite") runs a token it just
  // minted, so use that as-is the first time.
  if (OAUTH2_ACCESS_TOKEN && !staticAccessTokenUsed) {
    staticAccessTokenUsed = true;
    oauth2AccessToken = OAUTH2_ACCESS_TOKEN;
    // NetSuite gives ~60 min; renew a little early rather than discover it dead.
    oauth2ExpiresAtMs = Date.now() + 50 * 60 * 1000;
    return oauth2AccessToken;
  }

  // Past that first hour the handed-over token is dead and cannot be reused —
  // swap it for a fresh one using the refresh token. This is what keeps long
  // exports alive; without it every later request 401s and no rows get written.
  if (OAUTH2_REFRESH_TOKEN && OAUTH2_CLIENT_ID && OAUTH2_CLIENT_SECRET) {
    const params = new URLSearchParams();
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", OAUTH2_REFRESH_TOKEN);
    const basic = Buffer.from(`${OAUTH2_CLIENT_ID}:${OAUTH2_CLIENT_SECRET}`).toString("base64");
    const resp = await http.request({
      method: "POST",
      url: OAUTH2_TOKEN_URL,
      data: params.toString(),
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      timeout: 30000,
      validateStatus: () => true
    });
    if (resp.status >= 200 && resp.status < 300 && resp.data?.access_token) {
      const expiresInSec = Number(resp.data.expires_in || 3600);
      oauth2AccessToken = resp.data.access_token;
      oauth2ExpiresAtMs = Date.now() + Math.max(60, expiresInSec - 60) * 1000;
      console.log(
        `[INFO] Renewed NetSuite access token (good for ~${Math.round(expiresInSec / 60)} min).`
      );
      return oauth2AccessToken;
    }
    const details =
      typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || {});
    console.log(`[WARN] Access token renewal failed: HTTP ${resp.status} ${details}`);
  }

  if (OAUTH2_ACCESS_TOKEN) {
    // No refresh credentials available (older saved company). Nothing better to
    // offer than the original token — it will 401 once NetSuite expires it.
    oauth2AccessToken = OAUTH2_ACCESS_TOKEN;
    oauth2ExpiresAtMs = Date.now() + 5 * 60 * 1000;
    return oauth2AccessToken;
  }

  if (OAUTH2_CLIENT_SECRET) {
    const params = new URLSearchParams();
    params.set("grant_type", "client_credentials");
    params.set("scope", OAUTH2_SCOPE);
    const basic = Buffer.from(`${OAUTH2_CLIENT_ID}:${OAUTH2_CLIENT_SECRET}`).toString("base64");
    const resp = await http.request({
      method: "POST",
      url: OAUTH2_TOKEN_URL,
      data: params.toString(),
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      timeout: 30000,
      validateStatus: () => true
    });
    if (resp.status < 200 || resp.status >= 300) {
      const bodyText =
        typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || {});
      throw new Error(`OAuth2 token request failed: HTTP ${resp.status} ${bodyText}`);
    }
    const accessToken = resp.data?.access_token;
    const expiresInSec = Number(resp.data?.expires_in || 3600);
    if (!accessToken) {
      throw new Error("OAuth2 token response missing access_token.");
    }
    oauth2AccessToken = accessToken;
    oauth2ExpiresAtMs = Date.now() + Math.max(60, expiresInSec - 60) * 1000;
    return oauth2AccessToken;
  }

  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set(
    "client_assertion_type",
    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
  );
  params.set("client_assertion", buildClientAssertionJwt());

  const resp = await http.request({
    method: "POST",
    url: OAUTH2_TOKEN_URL,
    data: params.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30000,
    validateStatus: () => true
  });

  if (resp.status < 200 || resp.status >= 300) {
    const bodyText = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || {});
    throw new Error(`OAuth2 token request failed: HTTP ${resp.status} ${bodyText}`);
  }

  const accessToken = resp.data?.access_token;
  const expiresInSec = Number(resp.data?.expires_in || 3600);
  if (!accessToken) {
    throw new Error("OAuth2 token response missing access_token.");
  }

  oauth2AccessToken = accessToken;
  oauth2ExpiresAtMs = Date.now() + Math.max(60, expiresInSec - 60) * 1000;
  return oauth2AccessToken;
}

async function getOAuth2AccessToken(forceRefresh = false) {
  if (!forceRefresh && oauth2AccessToken && oauth2ExpiresAtMs > Date.now() + 5000) {
    return oauth2AccessToken;
  }
  if (!oauth2TokenPromise) {
    oauth2TokenPromise = fetchOAuth2AccessToken().finally(() => {
      oauth2TokenPromise = null;
    });
  }
  return oauth2TokenPromise;
}

async function getAuthHeader(method, url, forceRefresh = false) {
  if (AUTH_MODE === "oauth2") {
    const accessToken = await getOAuth2AccessToken(forceRefresh);
    return `Bearer ${accessToken}`;
  }
  return authHeader(method, url);
}

function normalizeDateForSuiteQl(input) {
  const text = String(input || "").trim();
  if (!text) {
    throw new Error("Date is empty. Set NS_START_DATE / NS_END_DATE.");
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    let a = Number(slash[1]);
    let b = Number(slash[2]);
    const y = Number(slash[3]);

    // If first part > 12 we treat input as DD/MM/YYYY, else MM/DD/YYYY.
    if (a > 12) {
      [a, b] = [b, a];
    }
    const mm = String(a).padStart(2, "0");
    const dd = String(b).padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }

  throw new Error(`Unsupported date format: ${input}. Use YYYY-MM-DD or DD/MM/YYYY.`);
}

function parseDateOnlyUtc(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  return Date.UTC(y, mo, d);
}

function isTranDateInRange(tranDateStr) {
  const tranUtc = parseDateOnlyUtc(tranDateStr);
  if (tranUtc === null) return true;
  const startUtc = parseDateOnlyUtc(normalizeDateForSuiteQl(START_DATE));
  const endUtc = parseDateOnlyUtc(normalizeDateForSuiteQl(END_DATE));
  if (startUtc !== null && tranUtc < startUtc) return false;
  if (endUtc !== null && tranUtc > endUtc) return false;
  return true;
}

async function safeSignedRequest(method, url, options = {}) {
  const maxRetries = 8;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const headers = { ...(options.headers || {}) };
    const now = Date.now();
    if (now < globalThrottleUntil) {
      await sleep(globalThrottleUntil - now);
    }
    await waitForRequestSlot();

    try {
      headers.Authorization = await getAuthHeader(
        method,
        url,
        AUTH_MODE === "oauth2" && attempt > 1
      );
      const response = await http.request({
        method,
        url,
        data: options.data,
        headers,
        timeout: options.timeout || 30000,
        validateStatus: () => true
      });

      if (response.status >= 200 && response.status < 300) {
        if (requestIntervalMs > MIN_REQUEST_INTERVAL_MS) {
          requestIntervalMs = Math.max(MIN_REQUEST_INTERVAL_MS, requestIntervalMs - 50);
        }
        return response;
      }

      if (response.status === 401 && AUTH_MODE === "oauth2") {
        oauth2AccessToken = "";
        oauth2ExpiresAtMs = 0;
        continue;
      }

      if (response.status === 429) {
        const retryAfterHeader = response.headers["retry-after"];
        const retryAfterSec = Number.isFinite(Number(retryAfterHeader))
          ? Number(retryAfterHeader)
          : Math.min(10, Math.pow(2, attempt - 1));
        const jitterMs = Math.floor(Math.random() * 700);
        globalThrottleUntil = Math.max(
          globalThrottleUntil,
          Date.now() + retryAfterSec * 1000 + jitterMs
        );
        requestIntervalMs = Math.min(
          MAX_REQUEST_INTERVAL_MS,
          Math.max(requestIntervalMs * 1.4, retryAfterSec * 500)
        );
        console.log(`[THROTTLE] 429 on ${url}. Retry in ${retryAfterSec}s.`);
        console.log(`[THROTTLE] Adaptive pacing interval -> ${Math.round(requestIntervalMs)}ms`);
        await sleep(retryAfterSec * 1000);
        continue;
      }

      if (response.status >= 500 && response.status < 600) {
        const backoffMs = Math.min(15000, 500 * Math.pow(2, attempt - 1));
        await sleep(backoffMs);
        continue;
      }

      const shouldLog400 = !(response.status === 400 && options.suppress400Log);
      const bodyText =
        typeof response.data === "string"
          ? response.data
          : JSON.stringify(response.data || {});
      if (shouldLog400) {
        console.log(`[WARN] HTTP ${response.status} on ${url}`);
        if (bodyText) {
          console.log(`[WARN] Response body: ${bodyText}`);
        }
      }
      return response;
    } catch (error) {
      const backoffMs = Math.min(15000, 500 * Math.pow(2, attempt - 1));
      if (attempt === maxRetries) {
        console.log(`[ERROR] Request failed after retries: ${url}`);
        console.log(error.message);
        return null;
      }
      await sleep(backoffMs);
    }
  }
  return null;
}

async function fetchApplyDetails(paymentType, paymentId) {
  const recordApiType = RECORDTYPE_TO_RECORD_API[paymentType.toLowerCase()] || paymentType;
  const url = `${recordApiBase}/${recordApiType}/${paymentId}/apply`;
  const resp = await safeSignedRequest("GET", url);
  if (!resp || resp.status !== 200) return [];

  const items = resp.data?.items || [];
  const results = [];
  const missingDetailHrefs = [];

  for (const item of items) {
    const hasEnoughData =
      item.amount !== undefined ||
      item.applyDate !== undefined ||
      item.refNum !== undefined ||
      item.type !== undefined ||
      item.doc !== undefined;
    if (hasEnoughData) {
      results.push(item);
      continue;
    }
    const href = (item.links || []).find((l) => l.rel === "self")?.href;
    if (href) {
      missingDetailHrefs.push(href);
    }
  }

  if (!missingDetailHrefs.length) {
    return results;
  }

  const limit = pLimit(APPLY_DETAIL_CONCURRENCY);
  const detailTasks = missingDetailHrefs.map((href) =>
    limit(async () => {
      const detailResp = await safeSignedRequest("GET", href);
      if (detailResp && detailResp.status === 200) {
        return detailResp.data;
      }
      return null;
    })
  );

  const detailItems = await Promise.all(detailTasks);
  for (const item of detailItems) {
    if (item) results.push(item);
  }

  return results;
}

function flattenApply(applyItem) {
  return {
    apply_amount: applyItem.amount,
    apply_date: applyItem.applyDate,
    apply_doc_id: applyItem.doc?.id,
    apply_doc_refName: applyItem.doc?.refName,
    apply_account_id: applyItem.apply_account_id,
    apply_account_refName: applyItem.apply_account_refName,
    apply_refNum: applyItem.refNum,
    apply_type: applyItem.type
  };
}

function buildJournalRows(detailData, columns) {
  const base = {
    ...detailData,
    recordType: detailData.recordType || "journalentry"
  };
  const lineItems = Array.isArray(detailData?.line?.items) ? detailData.line.items : [];
  if (!lineItems.length) {
    return [buildRow(base, columns)];
  }

  const rows = [];
  for (let i = 0; i < lineItems.length; i++) {
    const line = lineItems[i] || {};
    const lineName = line.entity || line.name || null;
    const rowData = {
      ...base,
      line_index: i + 1,
      line_account: line.account || null,
      line_debit: line.debit ?? "",
      line_credit: line.credit ?? "",
      line_memo: line.memo ?? "",
      line_name: lineName,
      line_department: line.department || null,
      line_location: line.location || null,
      line_class: line.class || null
    };
    rows.push(buildRow(rowData, columns));
  }
  return rows;
}

function detectDifferentRecordTypeError(respData) {
  const details = Array.isArray(respData?.["o:errorDetails"]) ? respData["o:errorDetails"] : [];
  for (const d of details) {
    const text = String(d?.detail || "");
    const m = text.match(/different type:\s*([a-z0-9_]+)\s*from/i);
    if (m && m[1]) {
      return m[1].trim();
    }
  }
  return "";
}

function toRecordApiType(typeName) {
  const key = String(typeName || "").trim().toLowerCase();
  if (!key) return "";
  return RECORDTYPE_TO_RECORD_API[key] || typeName;
}

async function fetchApplyDocAccount(docId) {
  const key = String(docId || "").trim();
  if (!key || !/^\d+$/.test(key)) {
    return { apply_account_id: "", apply_account_refName: "" };
  }
  if (applyDocAccountCache.has(key)) {
    return applyDocAccountCache.get(key);
  }

  // Apply-side document account is not consistently available as `account` in SuiteQL.
  // Use `arAcct` from transaction and silently fallback when unavailable for a record type.
  const url = `${baseUrl}?limit=1&offset=0`;
  const headers = { prefer: "transient", "Content-Type": "application/json" };

  const tryQuery = async (query, options = {}) => {
    const response = await safeSignedRequest("POST", url, {
      headers,
      data: { q: query },
      timeout: 30000,
      suppress400Log: options.suppress400Log
    });
    if (!response) return null;
    if (response.status !== 200) return null;
    const item = response.data?.items?.[0] || {};
    const id = String(item.apply_account_id || "");
    const refName = String(item.apply_account_refName || "");
    if (!id && !refName) return null;
    return { apply_account_id: id, apply_account_refName: refName };
  };

  const arAcctQuery = [
    "SELECT arAcct AS apply_account_id,",
    "BUILTIN.DF(arAcct) AS apply_account_refName",
    "FROM transaction",
    `WHERE id = ${key}`
  ].join(" ");

  const mainlineQuery = [
    "SELECT tl.account AS apply_account_id,",
    "BUILTIN.DF(tl.account) AS apply_account_refName",
    "FROM transactionLine tl",
    `WHERE tl.transaction = ${key}`,
    "AND tl.mainline = 'T'"
  ].join(" ");

  let resolved = null;

  if (supportsTransactionArAcct) {
    const arAcctResp = await safeSignedRequest("POST", url, {
      headers,
      data: { q: arAcctQuery },
      timeout: 30000,
      suppress400Log: true
    });

    if (arAcctResp && arAcctResp.status === 200) {
      const item = arAcctResp.data?.items?.[0] || {};
      const id = String(item.apply_account_id || "");
      const refName = String(item.apply_account_refName || "");
      if (id || refName) {
        resolved = { apply_account_id: id, apply_account_refName: refName };
      }
    } else if (arAcctResp && arAcctResp.status === 400) {
      const bodyText =
        typeof arAcctResp.data === "string"
          ? arAcctResp.data
          : JSON.stringify(arAcctResp.data || {});
      if (bodyText.includes("Unknown identifier 'arAcct'")) {
        supportsTransactionArAcct = false;
        console.log("[INFO] SuiteQL field transaction.arAcct is unavailable in this account. Using mainline account fallback.");
      }
    }
  }

  if (!resolved) {
    resolved = await tryQuery(mainlineQuery);
  }

  resolved ||= {
    apply_account_id: "",
    apply_account_refName: ""
  };

  applyDocAccountCache.set(key, resolved);
  return resolved;
}

async function fetchPaymentDetail(paymentType, paymentId) {
  const columns = getColumnsForType(paymentType);
  const requestedRecordType = toRecordApiType(paymentType);
  const requestDetail = async (recordApiType) => {
    const detailUrl = `${recordApiBase}/${recordApiType}/${paymentId}?expandSubResources=true`;
    return safeSignedRequest("GET", detailUrl, { timeout: 30000 });
  };

  let detailResp = await requestDetail(requestedRecordType);
  if (!detailResp) {
    console.log(`[WARN] Failed to fetch payment ${paymentId} after retries.`);
    return null;
  }

  if (detailResp.status === 400) {
    const detectedType = detectDifferentRecordTypeError(detailResp.data);
    if (detectedType) {
      let retryResp = await requestDetail(toRecordApiType(detectedType));
      if (retryResp && retryResp.status === 200) {
        detailResp = retryResp;
      }
    }
  }

  if (detailResp.status !== 200) {
    const bodyText =
      typeof detailResp.data === "string"
        ? detailResp.data
        : JSON.stringify(detailResp.data || {});
    console.log(`[WARN] Failed to fetch payment ${paymentId} (HTTP ${detailResp.status}) ${bodyText}`);
    return null;
  }

  const detailData = detailResp.data;
  writeDebugJson("detail", paymentType, paymentId, detailData);
  if (!isTranDateInRange(detailData.tranDate)) {
    return [];
  }

  if (paymentType.toLowerCase() === "journalentry") {
    return buildJournalRows(detailData, columns);
  }

  let applyItems = [];
  const needsApplyColumns = columns.some((c) => c.startsWith("apply_"));
  const shouldFetchApply =
    FETCH_APPLY_MODE === "true" ||
    (FETCH_APPLY_MODE === "auto" && needsApplyColumns);
  const hasAppliedValue = Number(detailData.applied || 0) !== 0;
  const hasUnappliedValue = Number(detailData.unapplied || 0) !== 0;
  const hasApplySection = detailData.apply !== undefined && detailData.apply !== null;

  if (shouldFetchApply && (hasAppliedValue || hasUnappliedValue || hasApplySection)) {
    const expandedApplyItems = detailData?.apply?.items;
    if (Array.isArray(expandedApplyItems) && expandedApplyItems.length > 0) {
      applyItems = expandedApplyItems;
    } else {
      applyItems = await fetchApplyDetails(paymentType, paymentId);
    }
  }

  if (!applyItems.length) {
    return [buildRow(detailData, columns)];
  }

  const rows = [];
  for (const applyItem of applyItems) {
    writeDebugJson("apply", paymentType, paymentId, applyItem);
    const applyDocId = applyItem?.doc?.id;
    const applyAccount = await fetchApplyDocAccount(applyDocId);
    const combined = { ...detailData, ...flattenApply({ ...applyItem, ...applyAccount }) };
    rows.push(buildRow(combined, columns));
  }
  return rows;
}

function buildSuiteQlQuery(paymentType) {
  const startIso = normalizeDateForSuiteQl(START_DATE);
  const endIso = normalizeDateForSuiteQl(END_DATE);
  const txType = RECORDTYPE_TO_TXTYPE[paymentType.toLowerCase()] || paymentType;
  const subsidiaryClause =
    SUBSIDIARY_ID_NUM !== null ? `AND transaction.subsidiary = ${SUBSIDIARY_ID_NUM}` : "";

  const byType = [
    "SELECT id FROM transaction",
    `WHERE tranDate >= TO_DATE('${startIso}', 'YYYY-MM-DD')`,
    `AND tranDate <= TO_DATE('${endIso}', 'YYYY-MM-DD')`,
    subsidiaryClause,
    `AND type = '${txType}'`,
    "ORDER BY id"
  ].filter(Boolean).join(" ");

  const byRecordType = [
    "SELECT id FROM transaction",
    `WHERE tranDate >= TO_DATE('${startIso}', 'YYYY-MM-DD')`,
    `AND tranDate <= TO_DATE('${endIso}', 'YYYY-MM-DD')`,
    subsidiaryClause,
    `AND recordType = '${paymentType}'`,
    "ORDER BY id"
  ].filter(Boolean).join(" ");

  if (QUERY_MODE === "type") return [byType];
  if (QUERY_MODE === "recordtype") return [byRecordType];
  return [byType, byRecordType];
}

function getSourceModeForType(paymentType) {
  if (SUBSIDIARY_ID_NUM !== null) return "suiteql";
  if (SOURCE_MODE === "suiteql" || SOURCE_MODE === "recordlist") return SOURCE_MODE;
  return "suiteql";
}

function getEffectiveConcurrency(paymentType) {
  const key = paymentType.toLowerCase();
  if (key === "depositapplication") {
    return Math.min(CONCURRENCY, DEPOSITAPP_MAX_CONCURRENCY);
  }
  if (key === "journalentry") {
    return Math.min(CONCURRENCY, JOURNAL_MAX_CONCURRENCY);
  }
  return CONCURRENCY;
}

async function queryIds(paymentType, offset) {
  const url = `${baseUrl}?limit=${PAGE_LIMIT}&offset=${offset}`;
  const queries = buildSuiteQlQuery(paymentType);
  for (let i = 0; i < queries.length; i++) {
    const payload = { q: queries[i] };
    const response = await safeSignedRequest("POST", url, {
      headers: { prefer: "transient", "Content-Type": "application/json" },
      data: payload
    });
    if (response && response.status === 200) {
      if (i > 0) {
        console.log(`[INFO] Query fallback worked at offset ${offset}.`);
      }
      logExpectedTotal(paymentType, response.data?.totalResults);
      return response.data?.items || [];
    }
  }

  console.log(`[ERROR] Query failed at offset ${offset}`);
  return null;
}

// NetSuite returns the total matching-record count on every page of this same
// query — free progress info, no separate count query required. Logged so the
// backend can turn a blind progress sweep into a real "640 of 1,238" bar.
function logExpectedTotal(paymentType, totalResults) {
  if (Number.isFinite(totalResults)) {
    console.log(`[INFO] ${paymentType} totalResults=${totalResults}`);
  }
}

async function listIdsFromRecordApi(paymentType, offset) {
  const recordApiType = RECORDTYPE_TO_RECORD_API[paymentType.toLowerCase()] || paymentType;
  const url = `${recordApiBase}/${recordApiType}?limit=${PAGE_LIMIT}&offset=${offset}`;
  const response = await safeSignedRequest("GET", url);
  if (!response || response.status !== 200) {
    console.log(`[ERROR] Record list fetch failed at offset ${offset}`);
    return null;
  }
  logExpectedTotal(paymentType, response.data?.totalResults);
  return response.data?.items || [];
}

async function exportPayments(paymentType) {
  const columns = getColumnsForType(paymentType);
  const state = loadProgress(paymentType);
  const autoNamed = !OUTPUT_FILE && !!OUTPUT_PREFIX;
  const filename = path.resolve(
    OUTPUT_FILE || (OUTPUT_PREFIX ? `${OUTPUT_PREFIX}_${paymentType}.csv` : `${paymentType}.csv`)
  );
  const wasInProgress =
    state.status === "in_progress" && (Number(state.offset) > 0 || Number(state.record_index) > 0);

  let offset;
  let resumeIndex;
  if (autoNamed && !wasInProgress) {
    // Fresh run for this org/date-range/type signature: clear any stale output
    // and failed-id state from a previous run so results never mix or duplicate.
    if (!DISABLE_CSV_OUTPUT && fs.existsSync(filename)) {
      fs.unlinkSync(filename);
    }
    clearFailedIds(paymentType);
    offset = 0;
    resumeIndex = 0;
    saveProgress(paymentType, 0, 0, "in_progress");
  } else {
    offset = state.offset || 0;
    resumeIndex = state.record_index || 0;
  }

  let firstWrite = !DISABLE_CSV_OUTPUT && !fs.existsSync(filename);
  let totalWritten = DISABLE_CSV_OUTPUT
    ? 0
    : firstWrite
      ? 0
      : (() => {
          try {
            const existing = fs.readFileSync(filename, "utf8");
            const lines = existing.split(/\r?\n/).filter(Boolean);
            return Math.max(0, lines.length - 1);
          } catch {
            return 0;
          }
        })();
  let sessionWritten = 0;
  // Distinguishes "ran out of records" (a real finish) from "could not reach
  // NetSuite" (internet dropped, auth died). Only a real finish may mark this
  // type completed — otherwise the saved offset has to survive so a re-run
  // resumes here instead of wiping the partial CSV and starting over.
  let idFetchFailedAt = -1;

  const effectiveConcurrency = getEffectiveConcurrency(paymentType);
  const sourceModeForType = getSourceModeForType(paymentType);
  const baseInterval = requestIntervalMs;
  if (paymentType.toLowerCase() === "journalentry") {
    requestIntervalMs = Math.max(requestIntervalMs, JOURNAL_MIN_INTERVAL_MS);
  }

  console.log(
    `[INFO] Export start: ${paymentType}, source_mode=${sourceModeForType}, date_range=${START_DATE}..${END_DATE}, offset=${offset}, resume_index=${resumeIndex}, concurrency=${effectiveConcurrency}, request_interval_ms=${requestIntervalMs}`
  );

  while (true) {
    let records = null;
    if (sourceModeForType === "recordlist") {
      records = await listIdsFromRecordApi(paymentType, offset);
    } else {
      records = await queryIds(paymentType, offset);
      if (!records) {
        console.log(
          `[WARN] SuiteQL ID query failed for ${paymentType} offset=${offset}. Falling back to record API list.`
        );
        records = await listIdsFromRecordApi(paymentType, offset);
      }
    }
    if (!records) {
      idFetchFailedAt = offset;
      console.log(
        `[ERROR] Could not reach NetSuite for ${paymentType} at offset=${offset}. ` +
          `Stopping here and keeping progress so this can be resumed.`
      );
      break;
    }
    if (!records.length) {
      console.log(`[DONE] No more records for ${paymentType}. Total written=${totalWritten}`);
      break;
    }

    const ids = records.map((r) => r.id).filter(Boolean);
    const limit = pLimit(effectiveConcurrency);
    const doneRowsByIndex = new Map();
    let flushIndex = resumeIndex;
    let outputBuffer = [];
    let flushLock = Promise.resolve();
    let completedInPage = 0;
    const failedIds = [];
    const pageTotal = Math.max(0, ids.length - resumeIndex);
    const heartbeat = setInterval(() => {
      console.log(
        `[HEARTBEAT] ${paymentType} page_offset=${offset} completed=${completedInPage}/${pageTotal} total_written=${totalWritten} interval_ms=${Math.round(requestIntervalMs)}`
      );
    }, HEARTBEAT_SEC * 1000);

    const flushReady = async () => {
      while (doneRowsByIndex.has(flushIndex)) {
        const rows = doneRowsByIndex.get(flushIndex) || [];
        doneRowsByIndex.delete(flushIndex);
        if (rows.length) outputBuffer.push(...rows);

        if (outputBuffer.length >= WRITE_BATCH_SIZE) {
          if (!DISABLE_CSV_OUTPUT) {
          await appendRowsToCsv(filename, outputBuffer, firstWrite, columns);
          }
          totalWritten += outputBuffer.length;
          sessionWritten += outputBuffer.length;
          console.log(
            `[INFO] Exported ${outputBuffer.length}. SessionTotal=${sessionWritten} FileTotal=${totalWritten}`
          );
          outputBuffer = [];
          firstWrite = false;
        }

        flushIndex += 1;
        saveProgress(paymentType, offset, flushIndex);
      }
    };

    const tasks = ids.map((paymentId, index) => {
      if (index < resumeIndex) return Promise.resolve();
      return limit(async () => {
        const rows = await fetchPaymentDetail(paymentType, paymentId);
        if (rows === null) {
          failedIds.push(paymentId);
          doneRowsByIndex.set(index, []);
        } else {
          doneRowsByIndex.set(index, rows);
        }
        completedInPage += 1;
        flushLock = flushLock.then(flushReady);
        await flushLock;
      });
    });

    try {
      await Promise.all(tasks);
      await flushLock;
    } finally {
      clearInterval(heartbeat);
    }

    if (outputBuffer.length) {
      if (!DISABLE_CSV_OUTPUT) {
        await appendRowsToCsv(filename, outputBuffer, firstWrite, columns);
      }
      totalWritten += outputBuffer.length;
      sessionWritten += outputBuffer.length;
      console.log(
        `[INFO] Exported final ${outputBuffer.length}. SessionTotal=${sessionWritten} FileTotal=${totalWritten}`
      );
      firstWrite = false;
    }

    if (failedIds.length) {
      console.log(`[WARN] ${failedIds.length} records failed on page offset=${offset}. Cooling down before retry...`);
      // A record only reaches this point after 6 failed attempts already. Retrying
      // immediately just hits the same sustained NetSuite throttle again — give the
      // rate-limit window real time to clear before trying these specific IDs again.
      await sleep(20000);
      console.log(`[INFO] Retrying ${failedIds.length} record(s)...`);
      const retryRows = [];
      const stillFailed = [];
      const retryLimit = pLimit(1);
      const retryTasks = failedIds.map((id) =>
        retryLimit(async () => {
          const rows = await fetchPaymentDetail(paymentType, id);
          if (rows === null) {
            stillFailed.push(id);
            return;
          }
          if (rows.length) retryRows.push(...rows);
        })
      );
      await Promise.all(retryTasks);
      if (retryRows.length) {
        if (!DISABLE_CSV_OUTPUT) {
          await appendRowsToCsv(filename, retryRows, firstWrite, columns);
        }
        totalWritten += retryRows.length;
        sessionWritten += retryRows.length;
        firstWrite = false;
        console.log(
          `[INFO] Recovered ${retryRows.length} rows from retry. SessionTotal=${sessionWritten} FileTotal=${totalWritten}`
        );
      }
      if (stillFailed.length) {
        appendFailedIds(paymentType, stillFailed);
        console.log(
          `[WARN] ${stillFailed.length} rows still failed. Logged to ${FAILED_IDS_FILE} for later retry.`
        );
      }
    }

    if (ids.length < PAGE_LIMIT) {
      console.log(
        `[SUCCESS] All records fetched for ${paymentType}. SessionTotal=${sessionWritten} FileTotal=${totalWritten}`
      );
      break;
    }

    offset += PAGE_LIMIT;
    resumeIndex = 0;
    saveProgress(paymentType, offset, 0);
  }

  if (idFetchFailedAt >= 0) {
    // Deliberately do NOT touch the progress file here. Whatever the last
    // successful flush wrote is the correct resume point; overwriting it —
    // or marking this type "completed" — is what would cause the next run to
    // delete the partial CSV and start from zero.
    requestIntervalMs = Math.max(MIN_REQUEST_INTERVAL_MS, baseInterval);
    throw new Error(
      `${paymentType}: lost connection to NetSuite at offset=${idFetchFailedAt}. ` +
        `${totalWritten} row(s) already saved — run the same export again ` +
        `(same company and same dates) to carry on from here.`
    );
  }

  saveProgress(paymentType, 0, 0, "completed");
  requestIntervalMs = Math.max(MIN_REQUEST_INTERVAL_MS, baseInterval);
  if (DISABLE_CSV_OUTPUT) {
    console.log(
      `[SUCCESS] Export complete (CSV auto-write disabled). SessionTotal=${sessionWritten}, FileTotal=${totalWritten}`
    );
  } else {
    console.log(
      `[SUCCESS] Export complete -> ${filename} (SessionTotal=${sessionWritten}, FileTotal=${totalWritten})`
    );
  }
}

async function main() {
  validateAuthConfig();
  console.log(`[INFO] Auth mode: ${AUTH_MODE}`);
  for (const paymentType of PAYMENT_TYPES) {
    await exportPayments(paymentType);
  }
}

main().catch((err) => {
  console.error("[FATAL] Export crashed:", err);
  process.exitCode = 1;
});
