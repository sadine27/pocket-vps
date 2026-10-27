// apply-glossary.js — teach the 4B the romanized Nepali it does not know, for ~15 tokens.
//
// The failure this fixes: on "khana ma dhunga thiyo, staff pani rude" the model wrote
// "food issues". dhunga is a STONE. A stone in the rice is a hygiene incident; "food
// issues" is what you write about a bland curry. That is a vocabulary gap, not a
// style gap, and no amount of prompt-rule tightening closes it.
//
// WHY THE TABLE IS NOT FREQUENCY-GATED
// check-glossary-terms.js measured all 1352 real reviews: dhunga appears ONCE, chaina
// once, sodnu once, thap three times. Frequency says drop them. Frequency is the wrong
// test here - that single dhunga review is the most damaging review in the whole set.
// What makes breadth affordable is the injection design: only terms that actually
// appear in THIS review reach the prompt, so an unused entry costs literally zero
// tokens at inference. The corpus tells us what is common; it cannot tell us what is
// expensive to get wrong. So the table is broad on the complaint side by choice.
//
// THE STAFF-NAME NOTE
// Also measured: "tej" is in 739 of 1352 reviews and "bahadur" in 362 - Tej Bahadur,
// the security guard, is named in roughly 55% of all reviews, spelled bdr / bhadur /
// bhadr / badhur / taj. Without this note the model can thank a guest "for mentioning
// our BDR service". It fires only when an honorific or a Bahadur spelling is present.
//
// Cost: typically 10-30 prompt tokens, ~4-11s on this phone. The prompt stays far
// under the 300s ceiling that killed the first real draft.
//
// Usage: node apply-glossary.js
const fs = require('fs');
const path = require('path');
const { getWorkflow, putWorkflow } = require('./n8n-client');

const WF = process.env.WF_ID || 'ELk9R3m7jeGK5VAF';

// [alternate spellings joined by |, meaning]. First spelling is only a label; the
// spelling the guest actually used is what gets shown to the model.
const TERMS = [
  // foreign object / hygiene - rare in the corpus, catastrophic when it happens
  ['dhunga|dhungaa|dhungo', 'a stone/pebble'], ['kapal|kesh', 'hair'],
  ['kira|kiraa', 'an insect/worm'], ['jhinga|jhingaa|jhinge', 'a fly'],
  ['makura', 'a spider'], ['fohor|fohar|fohori', 'dirty/filthy'],
  ['safa|sapha', 'clean'], ['baasi|basi', 'stale/left over'],
  ['sadeko|kuhiyeko|bigreko', 'rotten/spoiled'], ['gandha|gandhaune', 'a bad smell'],
  ['birami', 'sick/ill'], ['banta|bantaa', 'vomiting'], ['jwaro', 'fever'],
  // taste and cooking
  ['mitho|mito|mitho', 'tasty'], ['amitho|amito', 'not tasty'], ['swad|swaad', 'taste'],
  ['nunilo|nunilo', 'too salty'], ['noon|nun', 'salt'], ['piro|piro', 'spicy hot'],
  ['guliyo', 'sweet'], ['amilo', 'sour'], ['tito', 'bitter'],
  ['chiso|chiso', 'cold'], ['tato|taato', 'hot (temperature)'],
  ['kachho|kaccha|nagaleko', 'raw/undercooked'], ['poleko|jaleko', 'burnt'],
  // dishes
  ['khana|khaana|khanaa', 'food/a meal'], ['khaja|khaaja', 'a snack'],
  ['bhat|bhaat', 'rice'], ['dal|daal', 'lentil soup'],
  ['sabji|tarkari|sabzi', 'vegetable curry'], ['masu|maasu', 'meat'],
  ['kukhura', 'chicken'], ['khasi', 'mutton'], ['machha|maccha', 'fish'],
  ['achar|achaar', 'pickle'], ['dahi', 'curd/yoghurt'], ['jhol', 'gravy/broth'],
  ['momo|momos|momocha', 'dumplings'], ['sekuwa', 'grilled meat'],
  ['thukpa', 'noodle soup'], ['sukuti', 'dried meat'], ['gundruk', 'fermented greens'],
  ['dhido|dhedo|dhindo', 'a millet/buckwheat staple'], ['aloo|alu', 'potato'],
  ['thali|thakali set', 'a platter meal'], ['chiya|chiyaa', 'tea'],
  ['lassi', 'a yoghurt drink'], ['roti', 'flatbread'], ['paani', 'water'],
  // price and billing
  ['mahango|mahngo|maango', 'expensive'], ['sasto', 'cheap'], ['paisa|paisaa', 'money'],
  ['thagyo|thageko|thagi', 'cheated/overcharged'],
  // service and speed
  ['dhilo|dhila', 'slow/late'], ['chito|chhito', 'fast/quickly'],
  ['sewa|sarbis|sebha', 'service'], ['kaam', 'work'],
  ['thap|thapp', 'a refill/extra helping'], ['pugena|pugdaina', 'not enough'],
  ['sodnu|sodhda|sodhe', 'to ask'], ['parkhinu|kurnu|kureko', 'to wait'],
  ['aayena|aaena', 'did not come'], ['diyena|dienan', 'did not give'],
  // staff behaviour
  ['badtamiji|badtameez|badmasi', 'rude/ill-mannered'], ['ghamandi', 'arrogant'],
  ['byabahar|byavahar|bebhar', 'behaviour'], ['bolyo|bolne|bolchan', 'spoke/speaks'],
  ['helchakryai|waasta', 'neglect/not caring'],
  // judgement
  ['ramro|ramrai|rmro', 'good'], ['naramro', 'bad'], ['kharab|kharaab', 'bad/spoiled'],
  ['bekar|bekaar', 'useless'], ['jhur', 'lousy'], ['dami|damii', 'great'],
  ['ekdam|ekdum|ekdamai', 'very/completely'], ['dherai|dhrai', 'a lot/very'],
  ['sarai|sarhai', 'very'], ['sabai', 'all/everything'], ['thik|thikai', 'okay/fine'],
  ['matra|matrai', 'only'],
  // people and address
  //
  // THE ADDRESS HONORIFICS ARE DELIBERATELY NOT LISTED HERE. They used to be, glossed
  // as 'elder brother (polite)' and 'the surname Bahadur', and on 2026-08-18 a 5-star
  // review produced: "it is a pleasure to have Tej Bahadur assist you AS YOUR ELDER
  // BROTHER". The gloss is an English noun phrase, so the model dropped it straight
  // into the sentence. Worse, the table and NAMES_LINE were saying opposite things
  // about the same word - the table called dai a brother, NAMES_LINE called it polite
  // address and not a name - and the model followed the table.
  // NAMES_LINE already covers every one of these and fires on the same trigger, so
  // listing them here bought nothing and cost a wrong reply. Content words go in the
  // Word meanings line; forms of address do not, because there is nothing to reflect.
  ['manche|manxe|manis', 'person'], ['sathi|saathi', 'friend'],
  ['haru', 'plural marker'],
  // grammar glue - these carry the negation, which is what a complaint turns on
  ['thiyo|thiye', 'was/were'], ['bhayo|bhaye', 'happened/became'],
  ['aayo|aae', 'came'], ['gayo|gaye', 'went'], ['diyo|diye', 'gave'],
  ['garyo|gare|garnu', 'did/to do'], ['lagyo|laagyo|lageyo', 'felt/seemed'],
  ['cha|chha|xa', 'is'], ['chaina|xaina|chhaina', 'is NOT / there is none'],
  ['ani', 'and/then'], ['tara', 'but'], ['pani|poni|ponii', 'also/too (or: water)'],
  ['malai', 'to me'], ['hami|hamro|hamile', 'we/our'], ['yaha|yahan|yaha ko', 'here'],
  ['kina', 'why'], ['kasto|kasari', 'what kind of/how'], ['jasto', 'like/as'],
  ['pheri|feri', 'again'], ['sadhai', 'always'], ['najik|najikai', 'near'],
  ['gunaso', 'a complaint'], ['mafi|maaf', 'apology/forgiveness'],
  ['dhanyabad|dhanyawad', 'thank you'], ['namaste|namaskar', 'a greeting'],
  ['chahi|chai', 'as for'], ['euta|euta', 'one'],
];

// No entry may repeat a spelling, and none may collide with a common English word -
// a bad match injects a wrong meaning, which is worse than injecting nothing.
const EN_COLLIDE = new Set(['pet', 'ma', 'ra', 'set', 're', 'na', 'ko', 'pan', 'tar', 'sat', 'don']);

const HONORIFIC = 'dai|daju|bhai|vai|didi|bdr|bhadur|bhadr|badhur|bahadur';
const NAMES_LINE = 'Names: BDR/bhadur/bhadr = the surname Bahadur (Tej Bahadur is our security guard). dai/daju/bhai/vai/didi are polite address, not names.';

const BUILD_PROMPT = `// Build the RAG-grounded prompt: system rules + tone + retrieved few-shot pairs.
// Retrieval is best-effort - if RAG Search failed (gateway down) pairs is empty and
// we fall back to a zero-shot prompt rather than dropping the review on the floor.
//
// SIZE BUDGET (measured 2026-08-18): the phone reads a prompt at 2.83 tok/s and writes
// at 1.94 tok/s, and n8n aborts the HTTP request at 300s regardless of the node's own
// timeout setting. 8 examples at 300 chars = 885 tokens = 313s of reading alone, which
// is what made the first real draft fail. Keep the prompt near 475 tokens.
const NAME = 'T3 Thakali';   // full name: T3 Thakali & Multi Food Gallery
const TONE = 'warm, humble, family-run; never defensive';

const cut = function (s, n) {
  s = String(s || '').replace(/\\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '\\u2026' : s;
};

// GLOSSARY. Generated by apply-glossary.js - edit there, not here.
// Only the entries that MATCH the review in hand are sent, so an entry that never
// fires costs nothing. That is why rare-but-severe words (dhunga = stone, appearing
// in 1 of 1352 real reviews) are worth carrying.
const GLOSS = ${JSON.stringify(TERMS)};
const HONORIFIC = /\\b(?:${HONORIFIC})\\b/i;
const MAX_TERMS = 10;   // see the worst-case budget in apply-glossary.js --test

const decode = function (reviewText) {
  const flat = ' ' + String(reviewText || '').toLowerCase().replace(/[^a-z0-9\\s]/g, ' ') + ' ';
  const seen = {};
  const hits = [];
  for (let i = 0; i < GLOSS.length && hits.length < MAX_TERMS; i++) {
    const meaning = GLOSS[i][1];
    if (seen[meaning]) continue;
    const m = flat.match(new RegExp('\\\\b(' + GLOSS[i][0] + ')\\\\b'));
    if (!m) continue;
    seen[meaning] = 1;
    // Show the spelling the guest actually used, not the canonical one.
    hits.push(m[1] + ' = ' + meaning);
  }
  const lines = [];
  if (hits.length) lines.push('Word meanings: ' + hits.join('; '));
  // Tej Bahadur, the security guard, is named in ~55% of reviews under six spellings.
  // Without this the model thanks guests for "our BDR service".
  if (HONORIFIC.test(String(reviewText || ''))) {
    lines.push(${JSON.stringify(NAMES_LINE)});
  }
  return lines;
};

// One item per review in the batch, index-aligned with Parse Review.
const reviews = $('Parse Review').all();
const out = [];

$input.all().forEach(function (item, i) {
  const prev = reviews[i].json;
  const pairs = (item.json && Array.isArray(item.json.pairs)) ? item.json.pairs : [];
  const negative = prev.stars <= 3;

  // Show examples from the SAME band only. This began as the fix for replies like
  // "We're glad our food reminded you of Lalgadh" on a 2-star review. Complaints now
  // carry no examples at all (see below), so what this still guards is the praise
  // side: a complaint example sitting in front of a 5-star review.
  // Pairs ingested before the band tag exists have no .band, so fall back to all.
  const sameBand = pairs.filter(function (p) {
    return p.band ? (negative ? p.band === 'complaint' : p.band === 'praise') : false;
  });
  const chosen = sameBand.length ? sameBand : pairs;

  // HOW MANY EXAMPLES - BAND-DEPENDENT, AND ON A COMPLAINT IT IS ZERO.
  //
  // Measured 2026-08-18 on "khana ma dhunga thiyo, staff pani rude" (dhunga = stone),
  // with the glossary decoding dhunga correctly in every single run:
  //     3 examples -> "the food was not ready"
  //     3 examples, reworded rules -> "the food was cold"
  //     1 example  -> "your food was cold"
  //     0 examples -> "your meal had a stone in it"
  // A retrieved reply pulls harder than the glossary, the rules and the review text
  // combined. One example is already too many, so on the reputation-critical path the
  // examples do not get a vote at all. This is not a tuning knob to be re-opened.
  //
  // Praise is the opposite. Three examples produced the warmer reply, and it picked up
  // the guest's own address form ("Tej Dai" rather than the full name); boilerplate on
  // praise is acceptable here by design. What it costs is time: praise@3 measured 236.9s
  // against n8n's hard 300s ceiling, leaving 63s. A long review spends that margin on
  // prompt tokens, so it drops to 2 rather than discovering the abort in production.
  // Complaints carry no examples and land near 150s, so they are never at risk.
  const LONG_REVIEW = 320;   // chars; ~63s of margin at 2.83 tok/s buys about this much
  const nExamples = negative ? 0
    : (String(prev.reviewText || '').length > LONG_REVIEW ? 2 : 3);

  let examples = '';
  chosen.slice(0, nExamples).forEach(function (p, n) {
    examples += '\\n[' + (n + 1) + '] Review: "' + cut(p.review, 100) + '"\\nReply: "' + cut(p.reply, 200) + '"\\n';
  });

  const shared = [
    'You are the Google Reviews responder for ' + NAME + ', a Thakali restaurant in Nepal.',
    'Rules:',
    '- Reply in English always. The review may be Nepali, romanized Nepali, Hindi or English slang; understand it fully, answer in English. A "Word meanings" line translates words the guest used - treat those meanings as part of what they actually said, but never quote a meaning back as a phrase in your reply, and never address or describe anyone as brother, sister, elder or younger.',
    '- 1-3 sentences, max 80 words. Warm, natural. No markdown, no emoji, no sign-off.',
    '- Never argue, never blame, never promise refunds, never mention the review language or that you are an AI.',
    'Tone: ' + TONE
  ];

  // The negative branch is the reputation-critical path and gets hard prohibitions,
  // because this is precisely where the human replies went wrong.
  const banded = negative ? [
    'This review is ' + prev.stars + '/5. It is a complaint. These override everything above:',
    '- Do NOT open with "Thank you". Open by naming what went wrong.',
    '- Never say glad, delighted, happy or pleased about anything here.',
    '- Name the specific thing they complained about, in plain English, using the Word meanings where given. Never soften a concrete complaint into a vague one.',
    '- Apologize once, no excuses, then state ONE concrete action being taken.',
    '- If it is sarcastic or insulting, answer the complaint underneath it. Never mistake an insult for a compliment.'
  ] : [
    'This review is ' + prev.stars + '/5. Thank the guest and mention the specific thing they praised - a dish, a staff member by name, or the service.'
  ];

  const system = shared.concat(banded).concat(
    examples ? ['Examples from our own past replies - match tone and structure only, never copy:' + examples] : []
  ).join('\\n');

  // The decoding aid sits next to the text it decodes, in the user turn.
  const aid = decode(prev.reviewText);
  const user = ['Review (original text): ' + prev.reviewText, 'Stars: ' + prev.stars + '/5']
    .concat(aid).join('\\n');

  out.push({ json: {
    ragCount: chosen.length,
    shown: Math.min(chosen.length, nExamples),
    band: negative ? 'complaint' : 'praise',
    glossLines: aid.length,
    promptChars: system.length + user.length,
    body: {
      model: 'qwen3.5-4b',
      stream: false,
      max_tokens: 120,
      temperature: 0.4,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    }
  }, pairedItem: { item: i } });
});

return out;`;

const DRYRUN = `// draft-dryrun.js — run the workflow's exact draft path from the phone, and time it.
//
// GENERATED by apply-glossary.js - do not edit here.
//
// The prompt is not re-implemented: build-prompt.node.js is the verbatim source of the
// n8n "Build Prompt" node, called with shimmed n8n globals. An earlier hand-copied
// version of this file drifted the moment the node changed, which made a passing
// dry-run meaningless. Now the two cannot disagree.
//
// Usage (inside proot, with the gateway's Node):
//   node draft-dryrun.js "khana ma dhunga thiyo, staff pani rude" 1
const buildPrompt = require('./build-prompt.node.js');

const GATEWAY = process.env.GATEWAY || 'http://127.0.0.1:8082';
const BIZ = process.env.BIZ || 'b1';
const reviewText = process.argv[2] || 'khana ma dhunga thiyo, staff pani rude';
const stars = Number(process.argv[3] || 1);

(async function () {
  const t0 = Date.now();
  const sr = await fetch(GATEWAY + '/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: reviewText, k: 24, business_id: BIZ }),
    signal: AbortSignal.timeout(180000),
  });
  let pairs = (await sr.json()).pairs || [];
  // PAIRS=0 strips the retrieved few-shot examples so their pull on the wording can be
  // measured separately from the prompt rules.
  if (process.env.PAIRS !== undefined) pairs = pairs.slice(0, Number(process.env.PAIRS));
  const tSearch = Date.now() - t0;

  // Stand in for the two n8n globals the node touches: its own input (the RAG Search
  // response) and the Parse Review node it reads the review back from.
  const prev = { stars: stars, reviewText: reviewText, chatId: 0, updateId: 0 };
  const built = buildPrompt(
    { all: function () { return [{ json: { pairs: pairs } }]; } },
    function () { return { all: function () { return [{ json: prev }]; } }; }
  )[0].json;

  const body = built.body;
  const system = body.messages[0].content;
  const user = body.messages[1].content;

  console.log('band            : ' + built.band);
  console.log('pairs returned  : ' + pairs.length + ' | shown ' + built.shown);
  console.log('glossary lines  : ' + built.glossLines);
  console.log('prompt chars    : ' + built.promptChars);
  console.log('search took     : ' + (tSearch / 1000).toFixed(1) + 's');
  console.log('--- USER TURN ---');
  console.log(user);

  const t1 = Date.now();
  const cr = await fetch(GATEWAY + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(900000),
  });
  const out = await cr.json();
  const tChat = Date.now() - t1;
  const tm = out.timings || {};

  console.log('--- TIMING ---');
  console.log('prompt tokens   : ' + tm.prompt_n + ' at ' + (tm.prompt_per_second || 0).toFixed(2) + ' tok/s');
  console.log('generated       : ' + tm.predicted_n + ' at ' + (tm.predicted_per_second || 0).toFixed(2) + ' tok/s');
  console.log('draft took      : ' + (tChat / 1000).toFixed(1) + 's');
  console.log('TOTAL           : ' + ((tSearch + tChat) / 1000).toFixed(1) + 's   (n8n aborts the draft call at 300s)');
  console.log('VERDICT         : ' + (tChat < 270000 ? 'FITS with margin' : tChat < 300000 ? 'fits, but thin margin' : 'STILL TOO SLOW'));
  console.log('--- DRAFT ---');
  console.log((out.choices && out.choices[0] && out.choices[0].message.content) || JSON.stringify(out).slice(0, 300));
  void system;
})().catch(function (e) { console.error('FAILED:', e.message); process.exit(1); });
`;

(async function () {
  // Sanity-check the table before it goes anywhere near the live workflow.
  const bad = TERMS.filter((t) => !Array.isArray(t) || t.length !== 2 || !t[0] || !t[1]);
  if (bad.length) throw new Error('malformed glossary entries: ' + JSON.stringify(bad).slice(0, 200));

  const spelt = new Map();
  TERMS.forEach((t) => {
    new RegExp('\\b(' + t[0] + ')\\b');   // throws on an unparseable alternation
    t[0].split('|').forEach((s) => {
      if (EN_COLLIDE.has(s)) throw new Error('spelling "' + s + '" collides with an English word');
      if (spelt.has(s) && spelt.get(s) !== t[1]) {
        throw new Error('spelling "' + s + '" is claimed by both "' + spelt.get(s) + '" and "' + t[1] + '"');
      }
      spelt.set(s, t[1]);
    });
  });

  // Compile-only syntax check of the generated node source. node --check parses without
  // executing, so nothing in the generated string can run here.
  const tmp = path.join(process.env.TEMP || __dirname, 'build-prompt.check.js');
  fs.writeFileSync(tmp, BUILD_PROMPT);
  require('child_process').execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  fs.unlinkSync(tmp);

  console.log('glossary: ' + TERMS.length + ' entries covering ' + spelt.size + ' distinct spellings');
  console.log('checks   : regexes parse, no English collisions, no conflicting spellings, node --check clean');

  // --test shows what the model would actually be handed, without touching n8n.
  if (process.argv.includes('--test')) {
    const HON = new RegExp('\\b(?:' + HONORIFIC + ')\\b', 'i');
    const decode = (t) => {
      const flat = ' ' + String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ') + ' ';
      const seen = {};
      const hits = [];
      for (let i = 0; i < TERMS.length && hits.length < 10; i++) {
        if (seen[TERMS[i][1]]) continue;
        const m = flat.match(new RegExp('\\b(' + TERMS[i][0] + ')\\b'));
        if (!m) continue;
        seen[TERMS[i][1]] = 1;
        hits.push(m[1] + ' = ' + TERMS[i][1]);
      }
      const lines = [];
      if (hits.length) lines.push('Word meanings: ' + hits.join('; '));
      if (HON.test(String(t || ''))) lines.push(NAMES_LINE);
      return lines;
    };
    const samples = [
      'khana ma dhunga thiyo, staff pani rude',
      'Worst service Bhat ma dhunga paryo',
      'Khana chai sabai Ramro xa. Service was also good.',
      'Momo ani khana haru ek dam ramro ra Security service dai Tej Bahadur nice and helpful',
      'One of the worst service paila jasto kaie chaina nah ta thap khana sodnu aayo',
      'The food was delicious and the staff were friendly.',
      'khana ekdam mahango cha ra dhilo service, waiter ko byabahar naramro thiyo',
    ];
    console.log('\n--- what the model gets ---');
    samples.forEach((s) => {
      const out = decode(s);
      const chars = out.join('\n').length;
      console.log('\n> ' + s);
      console.log(out.length ? out.map((l) => '  ' + l).join('\n') : '  (no terms matched)');
      console.log('  [+' + chars + ' chars, roughly ' + Math.round(chars / 3.6) + ' tokens]');
    });
    // Worst case: a review dense enough to hit the term cap AND trigger the name note.
    // The old fixed "471 base" assumed 3 examples on every band. Complaints now carry
    // ZERO examples, so that number modelled a prompt that can no longer be built. Both
    // bands are anchored on measured on-phone runs instead (2026-08-18), and the aid is
    // priced as the marginal cost on top at the measured 2.83 tok/s prompt rate.
    const worst = decode('dai le dhunga ra kapal bhetiyo, khana chiso ra nunilo thiyo, '
      + 'momo baasi thiyo, dal pugena, service dhilo, byabahar naramro, khana mahango cha');
    const wc = worst.join('\n').length;
    const wtok = Math.round(wc / 3.6);
    console.log('\n--- worst case ---');
    worst.forEach((l) => console.log('  ' + l));
    console.log('  +' + wc + ' chars ~= ' + wtok + ' tokens ~= ' + (wtok / 2.83).toFixed(0) + 's of extra reading');
    const AID_S = wtok / 2.83;
    console.log('  measured anchors, full pipeline on the phone:');
    console.log('    complaint, 0 examples : 149.9s   <- the band the glossary actually fires on');
    console.log('    praise,    3 examples : 236.9s   <- the tight one');
    console.log('  worst case = praise@3 carrying the FULL aid: '
      + (236.9 + AID_S).toFixed(0) + 's vs the 300s ceiling');
    console.log('  a complaint cannot reach that: 0 examples, and its 149.9s already carries a 29-token aid.');
    console.log('  a praise review long enough to be at risk drops to 2 examples (LONG_REVIEW guard).');

    console.log('\n--test: nothing deployed.');
    return;
  }

  // Emit the phone-side test. It wraps the node source in a module and requires it, so
  // the dry-run executes the EXACT code the workflow runs - the old hand-copied dry-run
  // silently drifted out of date the moment the node changed.
  const gw = path.join(__dirname, 'ai-gateway');
  fs.writeFileSync(path.join(gw, 'build-prompt.node.js'),
    '// GENERATED by apply-glossary.js - do not edit. Verbatim source of the n8n\n'
    + '// "Build Prompt" node, wrapped so a test can call it with shimmed n8n globals.\n'
    + 'module.exports = function ($input, $) {\n' + BUILD_PROMPT + '\n};\n');
  fs.writeFileSync(path.join(gw, 'draft-dryrun.js'), DRYRUN);
  console.log('emitted  : ai-gateway/build-prompt.node.js + ai-gateway/draft-dryrun.js');

  if (process.argv.includes('--emit-only')) {
    console.log('--emit-only: phone test regenerated, live workflow untouched.');
    return;
  }

  const wf = await getWorkflow(WF);
  // Timestamped, because this script is run more than once. A fixed filename meant the
  // second deploy overwrote the genuine pre-glossary snapshot with an already-glossaried
  // one, quietly destroying the only copy of the state we would want to roll back to.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const backup = path.join(__dirname, 'backups', 'workflow-' + stamp + '.json');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, JSON.stringify(wf, null, 2));
  console.log('backup             : ' + path.relative(__dirname, backup));
  const bp = wf.nodes.find((n) => n.name === 'Build Prompt');
  if (!bp) throw new Error('Build Prompt node not found');
  console.log('Build Prompt jsCode: ' + bp.parameters.jsCode.length + ' -> ' + BUILD_PROMPT.length + ' chars');
  console.log('  (node source only - the prompt itself grows only by the terms that match)');
  bp.parameters.jsCode = BUILD_PROMPT;

  await putWorkflow(WF, wf);
  const after = await getWorkflow(WF);
  const check = after.nodes.find((n) => n.name === 'Build Prompt');
  console.log(check.parameters.jsCode === BUILD_PROMPT
    ? 'confirmed: live workflow updated'
    : 'MISMATCH after save');
})().catch(function (e) { console.error('FAILED: ' + e.message); process.exit(1); });
