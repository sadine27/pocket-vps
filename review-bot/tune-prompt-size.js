// tune-prompt-size.js — fit the draft request inside n8n's 300-second ceiling.
//
// Measured on the phone (Helio G85, Qwen3.5-4B Q4_K_M), after --mlock and -b 512 were
// applied and changed nothing: prompt processing 2.83 tok/s, generation 1.94 tok/s.
// Those numbers are the SoC's ceiling, not a configuration problem.
//
// The draft that failed carried 8 examples with replies cut at 300 chars: 885 prompt
// tokens = 313s of reading before a single word is generated. n8n aborted the HTTP
// request at 300896ms despite the node's own timeout being set to 900000ms, so 300s is
// a ceiling imposed above the node and cannot be raised from the node's options.
//
// Budget, at the measured rates, for a worst case under 300s:
//   3 examples + tightened rules  ~= 475 prompt tokens -> ~168s
//   max_tokens 120 (real replies run 45-60) -> <= 62s
//   worst case ~230s, typical ~195s
//
// What is deliberately NOT sacrificed: the band filter, the hard prohibitions on the
// complaint path, and the fallback to unfiltered pairs when nothing carries a band.
// Only the number and length of examples were cut, because that is the only term in
// the budget that scales.
//
// Usage: node tune-prompt-size.js
const fs = require('fs');
const path = require('path');
const { getWorkflow, putWorkflow } = require('./n8n-client');

const WF = process.env.WF_ID || 'ELk9R3m7jeGK5VAF';

const JS_CODE = `// Build the RAG-grounded prompt: system rules + tone + retrieved few-shot pairs.
// Retrieval is best-effort - if RAG Search failed (gateway down) pairs is empty and
// we fall back to a zero-shot prompt rather than dropping the review on the floor.
//
// SIZE BUDGET (measured 2026-08-18): the phone reads a prompt at 2.83 tok/s and writes
// at 1.94 tok/s, and n8n aborts the HTTP request at 300s regardless of the node's own
// timeout setting. 8 examples at 300 chars = 885 tokens = 313s of reading alone, which
// is what made the first real draft fail. Keep the prompt near 475 tokens.
const prev = $('Parse Review').item.json;
const pairs = ($json && Array.isArray($json.pairs)) ? $json.pairs : [];

const NAME = 'T3 Thakali';   // full name: T3 Thakali & Multi Food Gallery
const TONE = 'warm, humble, family-run; never defensive';
const negative = prev.stars <= 3;

const cut = function (s, n) {
  s = String(s || '').replace(/\\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '\\u2026' : s;
};

// Show examples from the SAME band only. A praise example sitting in front of a
// complaint is what produced replies like "We're glad our food reminded you of
// Lalgadh" on a 2-star review: the retrieved text pulls harder than the rules do.
// Pairs ingested before the band tag exists have no .band, so fall back to all.
const sameBand = pairs.filter(function (p) {
  return p.band ? (negative ? p.band === 'complaint' : p.band === 'praise') : false;
});
const chosen = sameBand.length ? sameBand : pairs;

// Three examples is what the time budget allows. They are the three NEAREST matches,
// so the cut costs the weakest examples rather than the best ones.
let examples = '';
chosen.slice(0, 3).forEach(function (p, i) {
  examples += '\\n[' + (i + 1) + '] Review: "' + cut(p.review, 100) + '"\\nReply: "' + cut(p.reply, 200) + '"\\n';
});

const shared = [
  'You are the Google Reviews responder for ' + NAME + ', a Thakali restaurant in Nepal.',
  'Rules:',
  '- Reply in English always. The review may be Nepali, romanized Nepali, Hindi or English slang; understand it fully, answer in English.',
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
  '- Name the specific thing they complained about, in their own words.',
  '- Apologize once, no excuses, then state ONE concrete action being taken.',
  '- If it is sarcastic or insulting, answer the complaint underneath it. Never mistake an insult for a compliment.'
] : [
  'This review is ' + prev.stars + '/5. Thank the guest and mention the specific thing they praised - a dish, a staff member by name, or the service.'
];

const system = shared.concat(banded).concat(
  examples ? ['Examples from our own past replies - match tone and structure only, never copy:' + examples] : []
).join('\\n');

const user = 'Review (original text): ' + prev.reviewText + '\\nStars: ' + prev.stars + '/5';

return [{ json: {
  ragCount: chosen.length,
  shown: Math.min(chosen.length, 3),
  band: negative ? 'complaint' : 'praise',
  promptChars: system.length + user.length,
  body: {
    model: 'qwen3.5-4b',
    stream: false,
    max_tokens: 120,
    temperature: 0.4,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  }
} }];`;

(async function () {
  const wf = await getWorkflow(WF);
  const bp = (wf.nodes || []).find((nd) => nd.name === 'Build Prompt');
  if (!bp) throw new Error('Build Prompt node not found');

  const before = bp.parameters.jsCode || '';
  fs.writeFileSync(path.join(__dirname, 'build-prompt.previous.js'), before);
  bp.parameters.jsCode = JS_CODE;

  console.log('workflow : ' + wf.name + ' | nodes ' + wf.nodes.length + ' | active ' + wf.active);
  console.log('Build Prompt jsCode: ' + before.length + ' chars -> ' + JS_CODE.length + ' chars');
  console.log('  examples 8 -> 3 | review cut 200 -> 100 | reply cut 300 -> 200 | max_tokens 220 -> 120');
  console.log('  previous version saved to build-prompt.previous.js');

  await putWorkflow(WF, wf);
  const after = await getWorkflow(WF);
  const check = (after.nodes || []).find((nd) => nd.name === 'Build Prompt');
  console.log(check.parameters.jsCode === JS_CODE ? 'confirmed: live workflow updated' : 'MISMATCH after save');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
