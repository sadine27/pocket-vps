// reset-pairs.js — empty the RAG corpus for one business before a full re-ingest.
//
// ingest.js replaces a pair when the same review comes back (id = sha1(biz|review)),
// but it cannot know about pairs that vanished from the source. The v2 scrape changed
// which review represents each deduplicated reply, and 39 pairs were newly rejected as
// praise-on-a-complaint, so the old rows would linger as orphans and keep being
// retrieved. A full wipe followed by a full ingest is the only state that matches the
// corpus file on disk.
//
// Back up first — this is destructive and there is no undo:
//   cp ~/server/rag/rag.db ~/server/rag/rag.db.bak
//
// Run inside proot with the gateway's own Node:
//   proot-distro login ubuntu -- env -i PATH=/usr/local/node/bin:/usr/bin:/bin \
//     HOME=/root /usr/local/node/bin/node .../ai-gateway/reset-pairs.js b1
const Database = require('better-sqlite3');

const BIZ = process.argv[2];
if (!BIZ) { console.error('usage: reset-pairs.js <business_id>'); process.exit(1); }

const DB_PATH = process.env.RAG_DB || '/data/data/com.termux/files/home/server/rag/rag.db';
const VEC0 = process.env.VEC0 || '/data/data/com.termux/files/home/server/rag/vec0.so';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.loadExtension(VEC0);

const before = db.prepare('SELECT COUNT(*) AS c FROM pairs_meta').get().c;
const doomed = db.prepare('SELECT rowid FROM pairs_meta WHERE business_id = ?').all(BIZ);
console.log('pairs in rag.db  : ' + before);
console.log('pairs for ' + BIZ + '     : ' + doomed.length);

if (!doomed.length) { console.log('nothing to do'); process.exit(0); }

// vec0 rejects a bound parameter for rowid, so build a validated integer literal list.
const ids = doomed.map((r) => {
  const n = Number(r.rowid);
  if (!Number.isInteger(n) || n < 0) throw new Error('bad rowid: ' + r.rowid);
  return String(n);
}).join(',');

db.exec('DELETE FROM pairs_vec WHERE rowid IN (' + ids + ')');
db.prepare('DELETE FROM pairs_meta WHERE business_id = ?').run(BIZ);

const meta = db.prepare('SELECT COUNT(*) AS c FROM pairs_meta').get().c;
const vecs = db.prepare('SELECT COUNT(*) AS c FROM pairs_vec').get().c;
console.log('remaining meta   : ' + meta + '   (vectors: ' + vecs + ')');
if (meta !== vecs) console.log('WARNING: meta and vector counts disagree');
console.log('ready for a full ingest');
