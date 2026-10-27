// ingest.js — monthly ritual: (review -> reply) pairs JSON -> rag.db (upsert + re-embed)
// Usage (inside proot):
//   node ingest.js [pairs-YYYY-MM.json]     # ingest file (default: rag-ingest/pairs-2026-08.json)
//   node ingest.js [file] --test            # ALSO run 5 sample queries, print top-3 each
const fs = require('fs');
const llama = require('./llama');
const rag = require('./db');

const FILE = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2]
  : '/data/data/com.termux/files/home/server/rag-ingest/pairs-2026-08.json';
const TEST = process.argv.includes('--test');
const BATCH = 8;
const GATEWAY = process.env.GATEWAY || 'http://127.0.0.1:8082';

// Get the embed model running WITHOUT becoming its parent. ingest is a one-shot
// process, usually launched from a short-lived `proot-distro login`; a llama child
// of that session freezes the moment the tracer exits (port bound, /health dead).
// So ask the long-lived gateway to spawn it and let the gateway own it. Only if the
// gateway is down do we spawn locally — which is safe only from a persistent shell.
async function ensureEmbed() {
  try {
    const r = await fetch(GATEWAY + '/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'warmup', k: 1 }),
      signal: AbortSignal.timeout(120000),
    });
    if (r.ok) { console.log('embed model ready (owned by ai-gateway)'); return; }
    console.log('gateway warmup returned ' + r.status + ', falling back to local spawn');
  } catch (e) {
    console.log('gateway unreachable (' + e.message + ') — spawning embed model locally.');
    console.log('WARNING: only safe from a persistent session; a one-shot proot login will freeze it.');
  }
  await llama.ensureModel('embed');
}

// texts must already carry their e5 prefix (asPassage for stored side, asQuery for
// the search side) — this does not add one, so the two sides can't get mixed up here.
async function embedBatch(texts) {
  const r = await fetch('http://127.0.0.1:8084/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: texts, model: 'e5-small' }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error('embed batch failed: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const byIndex = new Map((j.data || []).map((d) => [d.index, d.embedding]));
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    const v = byIndex.get(i);
    if (!v || v.length !== rag.DIMS) throw new Error('missing/invalid embedding at index ' + i);
    out.push(v);
  }
  return out;
}

async function main() {
  if (!fs.existsSync(FILE)) { console.log('file not found: ' + FILE); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const pairs = Array.isArray(raw) ? raw : (raw.pairs || []);
  if (!pairs.length) { console.log('no pairs in file'); process.exit(1); }
  for (const p of pairs) {
    if (!p.business_id || !p.review || !p.reply) { console.log('SKIP malformed pair:', JSON.stringify(p).slice(0, 120)); }
  }

  console.log('ingesting ' + pairs.length + ' pairs from ' + FILE + ' (embed model on :8084)');
  await ensureEmbed();

  const t0 = Date.now();
  let done = 0;
  for (let i = 0; i < pairs.length; i += BATCH) {
    const slice = pairs.slice(i, i + BATCH);
    const vecs = await embedBatch(slice.map((p) => rag.asPassage(p.review)));
    for (let j = 0; j < slice.length; j++) {
      const p = slice[j];
      if (!p.business_id || !p.review || !p.reply) continue;
      rag.upsertPair(String(p.business_id), String(p.review), String(p.reply), p.source, vecs[j], p.band);
      done++;
    }
    if (done % 100 < BATCH) console.log(done + '/' + pairs.length + ' pairs');
  }
  console.log('DONE: ' + done + ' pairs in ' + Math.round((Date.now() - t0) / 1000) + 's');

  if (TEST) {
    console.log('\n=== TEST QUERIES (top 3) ===');
    const queries = [
      ['Nepali devanagari', 'मोमो एकदम मिठो थियो तर पर्खाइ लामो भयो'],
      ['Romanized Nepali', 'khana ramro thiyo tara waiter le dherai time lagayo'],
      ['Hindi', 'खाना अच्छा था पर महंगा लगा'],
      ['English', 'The momos were amazing, service was a bit slow though'],
      ['Slang/mixed', 'momo ekdum mitho but bill ali dherai aayo'],
    ];
    for (const [label, q] of queries) {
      await ensureEmbed();
      const emb = await fetch('http://127.0.0.1:8084/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: rag.asQuery(q), model: 'e5-small' }),
        signal: AbortSignal.timeout(60000),
      });
      const j = await emb.json();
      const vec = j.data && j.data[0] && j.data[0].embedding;
      console.log('\n--- ' + label + ': ' + q);
      for (const p of rag.search(vec, 3, null)) {
        console.log('  [' + p.business_id + '] d=' + p.distance.toFixed(4) + ' R:' + p.review.slice(0, 70) + ' | A:' + p.reply.slice(0, 70));
      }
    }
  }
}

main().catch((e) => { console.log('FAILED:', e && e.message || e); process.exit(1); });
