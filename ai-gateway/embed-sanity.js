// embed-sanity.js — gate for any embedding model before it backs the RAG index.
//
// Liveness proves nothing: a model with a mismatched tensor map loads and returns
// NaN, and one with a SentencePiece vocab mis-declared as WordPiece loads, returns
// finite vectors, and silently maps every out-of-vocab word to the same token. Both
// happened here. So this checks three things in order, cheapest first:
//   1. tokenization  — distinct sentences must produce distinct token sequences
//   2. numerics      — 384 finite, non-zero dims
//   3. semantics     — same meaning across scripts must beat different topics
// Env: EMBED_URL (default :8084), E5=1 to add the e5 "query: " prefix, BATCHED=1.
const http = require('http');
const { URL: URLC } = require('url');

const ENDPOINT = process.env.EMBED_URL || 'http://127.0.0.1:8084/v1/embeddings';
const P = process.env.E5 ? 'query: ' : ''; // e5 is prefix-trained; without it you measure the wrong thing

const S = {
  A: 'khana ekdam mitho thiyo',                 // romanized Nepali: the food was very tasty
  B: 'the food was delicious',                  // English, same meaning as A
  C: 'खाना धेरै मीठो थियो',                           // Devanagari Nepali, same meaning as A
  D: 'खानाको स्वाद राम्रो थिएन',                       // Devanagari Nepali: the food did not taste good
  E: 'the waiter was extremely rude and slow',  // English, service complaint
  F: 'सेवा ज्यादै ढिलो थियो',                          // Devanagari Nepali: the service was very slow
};

function post(path, body) {
  return new Promise((res, rej) => {
    const u = new URLC(path.startsWith('http') ? path : new URLC(ENDPOINT).origin + path);
    const d = Buffer.from(JSON.stringify(body));
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': d.length } },
      (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => {
        try { res(JSON.parse(b)); } catch (e) { rej(new Error('HTTP ' + x.statusCode + ': ' + b.slice(0, 300))); } }); });
    r.on('error', rej); r.end(d);
  });
}

const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};
const flat = (e) => (Array.isArray(e[0]) ? e[0] : e); // MEAN pooling gives a flat vector

// A vocab declared with the wrong tokenizer type still "works": in-vocab whole words
// resolve and everything else collapses onto one fallback id, so unrelated sentences
// become byte-identical. Catch that here, where the cause is obvious.
async function checkTokenizer(keys) {
  const seen = new Map();
  let ok = true;
  console.log('--- tokenization ---');
  for (const k of keys) {
    const out = await post('/tokenize', { content: P + S[k], with_pieces: true });
    const toks = out.tokens || [];
    const ids = toks.map((t) => (typeof t === 'object' ? t.id : t));
    const pieces = toks.map((t) => (typeof t === 'object' ? t.piece : t));
    const sig = ids.join(',');
    console.log(k, '|', ids.length, 'tok |', JSON.stringify(pieces));
    if (seen.has(sig)) { console.log('  !! identical token sequence to ' + seen.get(sig)); ok = false; }
    seen.set(sig, k);
    // one distinct id repeated across most of a sentence means OOV is collapsing
    if (ids.length >= 4 && new Set(ids).size <= Math.ceil(ids.length / 3)) {
      console.log('  !! ' + new Set(ids).size + ' distinct ids across ' + ids.length + ' tokens — OOV collapse');
      ok = false;
    }
  }
  return ok;
}

async function embedAll(keys) {
  const vec = {};
  if (process.env.BATCHED) {
    const out = await post(ENDPOINT, { model: 'embed', input: keys.map((k) => P + S[k]) });
    if (!out.data) throw new Error('no data: ' + JSON.stringify(out).slice(0, 300));
    out.data.forEach((d, i) => (vec[keys[i]] = flat(d.embedding)));
  } else {
    for (const k of keys) {
      const out = await post(ENDPOINT, { model: 'embed', input: P + S[k] });
      if (!out.data) throw new Error('no data: ' + JSON.stringify(out).slice(0, 300));
      vec[k] = flat(out.data[0].embedding);
    }
  }
  return vec;
}

(async () => {
  const keys = Object.keys(S);
  const tokOk = await checkTokenizer(keys);

  const vec = await embedAll(keys);
  const dims = vec.A.length;
  const finite = Object.values(vec).every((v) => v.every(Number.isFinite));
  const nonzero = Object.values(vec).every((v) => v.some((x) => x !== 0));
  console.log('\n--- numerics ---');
  console.log('dims:', dims, '| all finite:', finite, '| all non-zero:', nonzero,
    '|', process.env.BATCHED ? 'batched' : 'one request per sentence');

  console.log('\n--- semantics ---');
  const pairs = [
    ['A', 'B', 'same meaning, romanized Nepali vs English', 'HIGH'],
    ['A', 'C', 'same meaning, romanized vs Devanagari',     'HIGH'],
    ['B', 'C', 'same meaning, English vs Devanagari',       'HIGH'],
    ['E', 'F', 'slow service, English vs Devanagari',       'HIGH'],
    ['C', 'D', 'food praise vs food complaint',             'MID'],
    ['B', 'E', 'food praise vs rude waiter',                'LOW'],
    ['C', 'F', 'food praise vs slow service',               'LOW'],
  ];
  for (const [x, y, why, want] of pairs) {
    console.log(cos(vec[x], vec[y]).toFixed(4), ' ', x + '~' + y, ' want ' + want.padEnd(4), ' ', why);
  }

  // The bar: every cross-script restatement of the SAME meaning must score above
  // every pair that shares a script but not a topic. Anything less and retrieval
  // will match on language rather than on what the reviewer actually said.
  const sameMeaning = Math.min(cos(vec.A, vec.B), cos(vec.A, vec.C), cos(vec.B, vec.C), cos(vec.E, vec.F));
  const diffTopic = Math.max(cos(vec.B, vec.E), cos(vec.C, vec.F));
  console.log('\nworst same-meaning:', sameMeaning.toFixed(4), '| best different-topic:', diffTopic.toFixed(4),
    '| margin:', (sameMeaning - diffTopic).toFixed(4));
  const pass = tokOk && dims === 384 && finite && nonzero && sameMeaning > diffTopic + 0.1;
  console.log(pass ? 'EMBED_SANE' : 'EMBED_BROKEN' + (tokOk ? '' : ' (tokenizer)'));
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
