const path = require("path");
const { DatabaseSync } = require("node:sqlite");

// Finished exports used to sit as loose CSVs in exports/ forever, with nothing
// ever cleaning them up. They live here instead: one row per file, the actual
// bytes stored as a BLOB, so exports/ is only ever a transient working folder
// (the export script still writes there mid-run, for resume) — never the
// long-term home for a finished file. See backend.js for the migration and
// the 3-day retention sweep that both use this module.
const DB_PATH = path.join(__dirname, "data.db");
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL UNIQUE,
    org_slug TEXT NOT NULL,
    ext TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    content BLOB NOT NULL,
    created_at TEXT NOT NULL
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_exports_org ON exports(org_slug)");
db.exec("CREATE INDEX IF NOT EXISTS idx_exports_created ON exports(created_at)");

// Saved companies used to live in backend/orgs.json — a file that has to
// exist before the app can do anything, and that someone has to remember to
// copy by hand onto every new server. A missing table just starts empty
// instead of throwing, so a fresh deployment never hits "Orgs config not
// found" — companies get added straight through the "Add a company" screen,
// no file transfer required.
db.exec(`
  CREATE TABLE IF NOT EXISTS orgs (
    name TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_secret TEXT NOT NULL,
    scope TEXT NOT NULL,
    auth_method TEXT NOT NULL,
    redirect_uri TEXT,
    token_url TEXT,
    created_at TEXT NOT NULL
  )
`);

function hasExport(fileName) {
  return Boolean(db.prepare("SELECT 1 FROM exports WHERE file_name = ?").get(fileName));
}

function insertExport({ fileName, orgSlug, ext, sizeBytes, content, createdAt }) {
  if (hasExport(fileName)) return false;
  db.prepare(
    `INSERT INTO exports (file_name, org_slug, ext, size_bytes, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(fileName, orgSlug, ext, sizeBytes, content, createdAt);
  return true;
}

// Metadata only — used for listings, never pulls the BLOB into memory.
function listExportsForOrgSlug(orgSlug) {
  const rows = db
    .prepare(
      `SELECT file_name, ext, size_bytes, created_at FROM exports
       WHERE org_slug = ? ORDER BY created_at DESC`
    )
    .all(orgSlug);
  return rows.map((r) => ({
    name: r.file_name,
    ext: r.ext,
    sizeBytes: r.size_bytes,
    modifiedAt: r.created_at
  }));
}

function getExportMeta(fileName) {
  const r = db
    .prepare("SELECT file_name, ext, size_bytes, created_at FROM exports WHERE file_name = ?")
    .get(fileName);
  if (!r) return null;
  return { name: r.file_name, ext: r.ext, sizeBytes: r.size_bytes, modifiedAt: r.created_at };
}

// Full row including the BLOB — only called at actual download time.
function getExport(fileName) {
  const r = db
    .prepare("SELECT file_name, ext, size_bytes, content, created_at FROM exports WHERE file_name = ?")
    .get(fileName);
  if (!r) return null;
  return {
    fileName: r.file_name,
    ext: r.ext,
    sizeBytes: r.size_bytes,
    content: Buffer.from(r.content),
    createdAt: r.created_at
  };
}

function deleteOlderThan(cutoffIso) {
  const rows = db.prepare("SELECT file_name FROM exports WHERE created_at < ?").all(cutoffIso);
  if (rows.length) {
    db.prepare("DELETE FROM exports WHERE created_at < ?").run(cutoffIso);
  }
  return rows.map((r) => r.file_name);
}

function rowToOrg(r) {
  return {
    name: r.name,
    accountId: r.account_id,
    clientId: r.client_id,
    clientSecret: r.client_secret,
    scope: r.scope,
    authMethod: r.auth_method,
    redirectUri: r.redirect_uri || "",
    tokenUrl: r.token_url || ""
  };
}

function listOrgs() {
  return db.prepare("SELECT * FROM orgs ORDER BY name").all().map(rowToOrg);
}

function countOrgs() {
  return db.prepare("SELECT COUNT(*) AS c FROM orgs").get().c;
}

function getOrg(name) {
  const r = db.prepare("SELECT * FROM orgs WHERE name = ?").get(name);
  return r ? rowToOrg(r) : null;
}

// A single atomic statement — no separate read-modify-write steps, so unlike
// the old file-based approach this needs no in-process write lock to stay
// safe under concurrent requests.
function upsertOrg(org) {
  db.prepare(
    `INSERT INTO orgs (name, account_id, client_id, client_secret, scope, auth_method, redirect_uri, token_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       account_id=excluded.account_id, client_id=excluded.client_id, client_secret=excluded.client_secret,
       scope=excluded.scope, auth_method=excluded.auth_method, redirect_uri=excluded.redirect_uri, token_url=excluded.token_url`
  ).run(
    org.name,
    org.accountId,
    org.clientId,
    org.clientSecret,
    org.scope,
    org.authMethod,
    org.redirectUri || null,
    org.tokenUrl || null,
    org.createdAt || new Date().toISOString()
  );
}

function deleteOrg(name) {
  return db.prepare("DELETE FROM orgs WHERE name = ?").run(name).changes > 0;
}

module.exports = {
  hasExport,
  insertExport,
  listExportsForOrgSlug,
  getExportMeta,
  getExport,
  deleteOlderThan,
  listOrgs,
  countOrgs,
  getOrg,
  upsertOrg,
  deleteOrg
};
