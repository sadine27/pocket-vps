// rag-eval.js — measures the thing that actually matters for this system:
// given a review in ANY of the four language styles, do the retrieved few-shot
// pairs come from the right complaint topic?
//
// Raw cosine values are not comparable across embedding models (e5 is strongly
// anisotropic — every pair sits in a high, narrow band — while paraphrase-MiniLM
// spreads out), so an absolute similarity threshold tells you nothing. Ranking
// does: precision@3 over topic labels, plus MRR of the first correct hit.
// Each query is deliberately NOT a paraphrase of any stored review, and several
// query the topic in a language it was not stored in, so cross-lingual retrieval
// is what is being scored rather than string overlap.
const GATEWAY = process.env.GATEWAY || 'http://127.0.0.1:8082';
const K = Number(process.env.K || 3);

const QUERIES = [
  ['romanized-ne', 'hamro order aauna dherai ber lagyo',              'slow_service'],
  ['devanagari',   'खाना आउन धेरै समय लाग्यो',                             'slow_service'],
  ['english',      'we sat waiting forever before anything arrived',   'slow_service'],
  ['romanized-ne', 'momo ekdum tasty thiyo',                           'food_praise'],
  ['devanagari',   'खानाको स्वाद एकदम राम्रो थियो',                          'food_praise'],
  ['english',      'the curry tasted amazing',                         'food_praise'],
  ['romanized-ne', 'staff le ramro sanga kura garena',                 'rude_staff'],
  ['english',      'the man at the counter spoke to us disrespectfully', 'rude_staff'],
  ['devanagari',   'कर्मचारीले नराम्रो व्यवहार गरे',                          'rude_staff'],
  ['romanized-ne', 'paisa dherai liyo khana ko lagi',                  'pricing'],
  ['english',      'way too expensive for what you get',               'pricing'],
  ['devanagari',   'खानामा केही फोहोर वस्तु भेटियो',                        'hygiene'],
  ['english',      'there was something disgusting in my food',        'hygiene'],
  ['romanized-ne', 'ma le mangeko bhanda arkai khana aayo',            'wrong_order'],
  ['english',      'they served us a completely different dish',       'wrong_order'],
  ['english',      'could not find anywhere to park the car',          'parking'],
];

async function search(text) {
  const r = await fetch(GATEWAY + '/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, k: K }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error('search failed ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return (await r.json()).pairs || [];
}

(async () => {
  let hits = 0, total = 0, mrrSum = 0, top1 = 0;
  const perLang = {};
  for (const [lang, q, want] of QUERIES) {
    const pairs = await search(q);
    const got = pairs.map((p) => p.source);
    const correct = got.filter((s) => s === want).length;
    const rank = got.indexOf(want);
    hits += correct; total += K;
    if (rank === 0) top1++;
    mrrSum += rank >= 0 ? 1 / (rank + 1) : 0;
    perLang[lang] = perLang[lang] || { c: 0, n: 0 };
    perLang[lang].c += correct; perLang[lang].n += K;
    const mark = rank === 0 ? 'OK ' : rank > 0 ? '~  ' : 'MISS';
    console.log(mark, lang.padEnd(13), JSON.stringify(q).padEnd(52), 'want', want.padEnd(13), '->', got.join(', '));
  }
  console.log('\nprecision@' + K + ':', (hits / total).toFixed(3), '(' + hits + '/' + total + ')');
  console.log('top-1 accuracy:', (top1 / QUERIES.length).toFixed(3), '(' + top1 + '/' + QUERIES.length + ')');
  console.log('MRR:', (mrrSum / QUERIES.length).toFixed(3));
  for (const [l, v] of Object.entries(perLang)) console.log('  ' + l.padEnd(13), (v.c / v.n).toFixed(3));
  // Few-shot prompting tolerates some noise, but the top hit should be the right
  // topic most of the time or the drafts get steered by irrelevant examples.
  const pass = top1 / QUERIES.length >= 0.75 && hits / total >= 0.6;
  console.log(pass ? 'RAG_OK' : 'RAG_WEAK');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
