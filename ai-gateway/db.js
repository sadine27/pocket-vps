// db.js — rag.db access: sqlite-vec kNN + pairs metadata (shared by server.js + ingest.js)
// vec0 stores the embeddings; pairs_meta rows are rowid-aligned with pairs_vec rows.
const Database = require('better-sqlite3');

const DIMS = 384;
const DB_PATH = process.env.RAG_DB || '/data/data/com.termux/files/home/server/rag/rag.db';
const VEC0 = process.env.VEC0 || '/data/data/com.termux/files/home/server/rag/vec0.so';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.loadExtension(VEC0);
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS pairs_vec USING vec0(review_embedding float[${DIMS}]);
  CREATE TABLE IF NOT EXISTS pairs_meta (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    review TEXT NOT NULL,
    reply TEXT NOT NULL,
    source TEXT,
    band TEXT,
    created_at INTEGER
  );
`);

// band was added after the first ingest, so existing databases need it bolted on.
// CREATE TABLE IF NOT EXISTS above is a no-op once the table exists.
if (!db.prepare("PRAGMA table_info(pairs_meta)").all().some((c) => c.name === 'band')) {
  db.exec('ALTER TABLE pairs_meta ADD COLUMN band TEXT');
}

// Normalize before embedding AND at ingest: NFC, lowercase, strip emoji, collapse ws.
function normalize(s) {
  return String(s)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}️‍]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // e5-small tops out at 512 tokens and llama-server rejects anything that will
    // not fit one physical batch. A guest writing an essay must not fail the whole
    // ingest, and the opening of a review carries the complaint anyway.
    .slice(0, 1200);
}

// multilingual-e5 is prefix-trained and the prefix is not optional — omitting it
// measurably degrades retrieval. Which pair to use depends on the task, though:
// "query:"/"passage:" is for ASYMMETRIC retrieval (short query -> long document),
// while e5's guidance for SYMMETRIC similarity is "query:" on both sides. Matching
// a review against other reviews is symmetric — same length, same register — so
// that is the default here. E5_ASYMMETRIC=1 restores the query/passage pairing.
// Changing this changes stored vectors, so it requires a full re-ingest.
const asQuery = (s) => 'query: ' + normalize(s);
const asPassage = (s) => (process.env.E5_ASYMMETRIC ? 'passage: ' : 'query: ') + normalize(s);

function jsonVec(vec) { return JSON.stringify(Array.from(vec)); }

// kNN over the review embeddings; filters by business_id in JS after an over-fetch
// (vec0's MATCH-k scans nearest-first, so k*8 then filter is a fair approximation).
function search(vec, k, businessId) {
  const fetchK = businessId ? Math.min(k * 8, 256) : k;
  const rows = db.prepare(
    `SELECT v.rowid AS rowid, v.distance AS distance
     FROM pairs_vec v
     WHERE v.review_embedding MATCH ?
     ORDER BY v.distance LIMIT ?`
  ).all(jsonVec(vec), fetchK);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.rowid);
  const metas = db.prepare(
    `SELECT rowid, business_id, review, reply, source, band
     FROM pairs_meta WHERE rowid IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  const byRow = new Map(metas.map((m) => [m.rowid, m]));
  const out = [];
  for (const r of rows) {
    const m = byRow.get(r.rowid);
    if (!m) continue;
    if (businessId && m.business_id !== businessId) continue;
    out.push({ business_id: m.business_id, review: m.review, reply: m.reply, source: m.source, band: m.band, distance: r.distance });
    if (out.length >= k) break;
  }
  return out;
}

// Upsert with rowid alignment: meta delete+insert first (fresh auto rowid), then vec.
// If SQLite reused a deleted rowid for the vec row, delete that stale vec row and retry.
// sqlite-vec's vec0 rejects a BOUND parameter for rowid ("Only integers are allows
// for primary key values") while accepting an integer literal, so rowids are
// interpolated. Safe because they come from lastInsertRowid, never from user input —
// asRowid() enforces that so the interpolation can never carry anything but digits.
function asRowid(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error('bad rowid: ' + v);
  return String(n);
}

function upsertPair(biz, review, reply, source, vec, band) {
  const crypto = require('crypto');
  const id = crypto.createHash('sha1').update(biz + '|' + review).digest('hex');
  const row = db.prepare('SELECT rowid FROM pairs_meta WHERE id = ?').get(id);
  if (row) db.exec('DELETE FROM pairs_vec WHERE rowid = ' + asRowid(row.rowid));
  db.prepare('DELETE FROM pairs_meta WHERE id = ?').run(id);
  const info = db.prepare(
    'INSERT INTO pairs_meta (id, business_id, review, reply, source, band, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, biz, review, reply, source || null, band || null, Date.now());
  const rowid = asRowid(info.lastInsertRowid);
  const vecJson = jsonVec(vec);
  const ins = () => db.prepare('INSERT INTO pairs_vec (rowid, review_embedding) VALUES (' + rowid + ', ?)').run(vecJson);
  try {
    ins();
  } catch (e) {
    // SQLite reused a rowid whose vec row outlived its meta row — clear and retry
    if (!String(e.message).includes('UNIQUE')) throw e;
    db.exec('DELETE FROM pairs_vec WHERE rowid = ' + rowid);
    ins();
  }
  return id;
}

module.exports = { db, DIMS, normalize, asQuery, asPassage, search, upsertPair };
