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

module.exports = {
  hasExport,
  insertExport,
  listExportsForOrgSlug,
  getExportMeta,
  getExport,
  deleteOlderThan
};
