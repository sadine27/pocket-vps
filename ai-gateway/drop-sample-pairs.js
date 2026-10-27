// drop-sample-pairs.js — one-off maintenance: remove the synthetic sample pairs
// from rag.db now that the real T3 Thakali corpus is ingested.
//
// The 24 sample pairs were hand-written placeholders used to build and test the
// retrieval stack before any real data existed. They still rank above real reviews
// (a fabricated "waiter le dherai time lagayo" pair is a near-exact match for a real
// one) and every slot they take is a real example the model does not get to see.
//
// Selection is exact rather than clever: every pair ingested from the real corpus
// carries a band ('praise' or 'complaint'), and the samples predate that column, so
// band IS NULL identifies precisely the sample rows and nothing else. The script
// prints what it will remove, removes it, and prints the result.
//
// Run inside proot with the gateway's own Node:
//   proot-distro login ubuntu -- env -i PATH=/usr/local/node/bin:/usr/bin:/bin \
//     HOME=/root /usr/local/node/bin/node .../ai-gateway/drop-sample-pairs.js
const Database = require('better-sqlite3');

const DB_PATH = process.env.RAG_DB || '/data/data/com.termux/files/home/server/rag/rag.db';
const VEC0 = process.env.VEC0 || '/data/data/com.termux/files/home/server/rag/vec0.so';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.loadExtension(VEC0);

const doomed = db.prepare('SELECT rowid, source, review FROM pairs_meta WHERE band IS NULL').all();
const total = db.prepare('SELECT COUNT(*) AS c FROM pairs_meta').get().c;

console.log('pairs in rag.db      : ' + total);
console.log('sample rows (no band): ' + doomed.length);
for (const r of doomed) console.log('  - [' + (r.source || 'null') + '] ' + r.review.slice(0, 60));

if (!doomed.length) { console.log('nothing to do'); process.exit(0); }

// vec0 rejects a bound parameter for rowid, so build a validated literal list.
const ids = doomed.map((r) => {
  const n = Number(r.rowid);
  if (!Number.isInteger(n) || n < 0) throw new Error('bad rowid: ' + r.rowid);
  return String(n);
}).join(',');

db.exec('DELETE FROM pairs_vec WHERE rowid IN (' + ids + ')');
db.prepare('DELETE FROM pairs_meta WHERE band IS NULL').run();

const left = db.prepare('SELECT COUNT(*) AS c FROM pairs_meta').get().c;
const vecs = db.prepare('SELECT COUNT(*) AS c FROM pairs_vec').get().c;
const bands = db.prepare('SELECT band, COUNT(*) AS c FROM pairs_meta GROUP BY band').all();
console.log('remaining pairs      : ' + left + '   (vectors: ' + vecs + ')');
console.log('by band              : ' + bands.map((b) => b.band + '=' + b.c).join(', '));
if (left !== vecs) console.log('WARNING: meta and vector counts disagree - re-run ingest.js');
