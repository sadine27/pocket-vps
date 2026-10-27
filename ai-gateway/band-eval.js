// band-eval.js — does retrieval bring back band-APPROPRIATE examples?
//
// rag-eval.js scored topic labels that only the synthetic sample pairs carried, so
// its 0.813 / 0.896 / 0.458 baseline cannot be compared against the real corpus and
// is not reported here. What matters now is different and directly measurable: the
// Build Prompt node keeps only same-band examples, so a complaint must retrieve
// complaint pairs. If it retrieves praise pairs, the model is shown "we're so glad
// you loved our food" while answering someone who found a stone in their rice.
//
// Scored per query: how many of the top K carry the band the query deserves.
// Queries are written in all four styles the restaurant actually receives and none
// is a paraphrase of a stored review, so cross-lingual retrieval is what is scored.
//
// Run inside proot with the gateway's Node. K defaults to the workflow's 24.
const GATEWAY = process.env.GATEWAY || 'http://127.0.0.1:8082';
const K = Number(process.env.K || 24);
const BIZ = process.env.BIZ || 'b1';

const QUERIES = [
  // style          query text                                                    band the reply must match
  ['romanized-ne', 'hamro order aauna dherai ber lagyo',                          'complaint'],
  ['romanized-ne', 'staff le ramro sanga kura garena, ekdam jhur',                'complaint'],
  ['romanized-ne', 'khana ma kapal bhetiyo',                                      'complaint'],
  ['devanagari',   'खाना आउन धेरै समय लाग्यो',                                        'complaint'],
  ['devanagari',   'कर्मचारीले नराम्रो व्यवहार गरे',                                     'complaint'],
  ['hindi',        'खाना बहुत महंगा था और स्वाद भी अच्छा नहीं',                            'complaint'],
  ['english',      'we sat waiting forever before anything arrived',              'complaint'],
  ['english',      'way too expensive for what you get',                          'complaint'],
  ['english',      'there was something disgusting in my food',                   'complaint'],
  ['english-slang','food was mid tbh, service even worse',                        'complaint'],
  ['romanized-ne', 'momo ekdum tasty thiyo, ekdam ramro',                         'praise'],
  ['romanized-ne', 'staff ekdam milansar, ambience pani ramro',                   'praise'],
  ['devanagari',   'खानाको स्वाद एकदम राम्रो थियो',                                   'praise'],
  ['hindi',        'खाना बहुत स्वादिष्ट था और सेवा भी अच्छी',                             'praise'],
  ['english',      'the thakali set was excellent and staff were friendly',       'praise'],
  ['english-slang','honestly slaps, best thakali near the airport',               'praise'],
];

(async function () {
  const rows = [];
  for (const [style, text, want] of QUERIES) {
    const r = await fetch(GATEWAY + '/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, k: K, business_id: BIZ }),
      signal: AbortSignal.timeout(180000),
    });
    if (!r.ok) { console.log('FAIL ' + r.status + ' on: ' + text); continue; }
    const pairs = (await r.json()).pairs || [];
    const match = pairs.filter((p) => p.band === want);
    // The workflow shows the model the first 8 that survive band filtering.
    rows.push({ style, want, text, hits: match.length, k: pairs.length, top1: pairs[0] && pairs[0].band, shown: Math.min(match.length, 8) });
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('style', 14) + pad('want', 11) + pad('same-band', 11) + pad('top-1', 11) + 'query');
  for (const r of rows) {
    console.log(pad(r.style, 14) + pad(r.want, 11) + pad(r.hits + '/' + r.k, 11) + pad(r.top1 || '-', 11) + r.text.slice(0, 44));
  }

  const grp = (w) => rows.filter((r) => r.want === w);
  const avg = (a, f) => a.length ? (a.reduce((s, x) => s + f(x), 0) / a.length) : 0;
  console.log('');
  for (const w of ['complaint', 'praise']) {
    const g = grp(w);
    console.log(w + ': top-1 correct ' + g.filter((r) => r.top1 === w).length + '/' + g.length +
                ' | mean same-band in top-' + K + ' ' + avg(g, (r) => r.hits).toFixed(1) +
                ' | mean examples actually shown ' + avg(g, (r) => r.shown).toFixed(1) + '/8');
  }
  const starved = rows.filter((r) => r.shown < 3);
  console.log('');
  console.log(starved.length ? 'STARVED (<3 examples shown): ' + starved.length + ' queries -> ' +
    starved.map((r) => r.style + ':' + r.want).join(', ') : 'no query fell below 3 usable examples');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
