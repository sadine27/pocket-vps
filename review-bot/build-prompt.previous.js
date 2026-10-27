// Build the RAG-grounded prompt: system rules + tone + retrieved few-shot pairs.
// Retrieval is best-effort - if RAG Search failed (gateway down) pairs is empty and
// we fall back to a zero-shot prompt rather than dropping the review on the floor.
const prev = $('Parse Review').item.json;
const pairs = ($json && Array.isArray($json.pairs)) ? $json.pairs : [];

const NAME = 'T3 Thakali';   // full name: T3 Thakali & Multi Food Gallery
const TONE = 'warm, humble, family-run; never defensive';
const negative = prev.stars <= 3;

const cut = function (s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '\u2026' : s;
};

// Show examples from the SAME band only. A praise example sitting in front of a
// complaint is what produced replies like "We're glad our food reminded you of
// Lalgadh" on a 2-star review: the retrieved text pulls harder than the rules do.
// Pairs ingested before the band tag exists have no .band, so fall back to all.
const sameBand = pairs.filter(function (p) {
  return p.band ? (negative ? p.band === 'complaint' : p.band === 'praise') : false;
});
const chosen = sameBand.length ? sameBand : pairs;

let examples = '';
chosen.slice(0, 8).forEach(function (p, i) {
  examples += '\n[EXAMPLE ' + (i + 1) + ']\nReview: "' + cut(p.review, 200) + '"\nReply: "' + cut(p.reply, 300) + '"\n';
});

const shared = [
  'You are the Google Reviews responder for ' + NAME + ', a Thakali restaurant in Nepal.',
  'Rules:',
  '- Always reply in English. The review may be Nepali, romanized Nepali, Hindi, or English with slang. Understand it fully, but your reply is always English.',
  '- 1-3 sentences, max 80 words. Warm and natural. No markdown, no emoji, never sign off.',
  '- Never argue, never blame, never promise refunds or compensation, never mention the review language or that you are an AI.',
  'Tone profile: ' + TONE
];

// The negative branch is the reputation-critical path and gets hard prohibitions,
// because this is precisely where the human replies went wrong.
const banded = negative ? [
  'This review is ' + prev.stars + '/5. Treat it as a complaint. These rules override everything else:',
  '- Do NOT open with "Thank you". Open by acknowledging what went wrong.',
  '- Never say you are glad, delighted, happy or pleased about anything in this review.',
  '- Name the specific thing they complained about, using their own words.',
  '- Apologize once, without excuses, then state ONE concrete action already being taken.',
  '- If the review is sarcastic, mocking or insulting, read what it actually means and answer the complaint underneath it. Never mistake an insult for a compliment.'
] : [
  'This review is ' + prev.stars + '/5. Thank the guest sincerely and mention the specific thing they praised - a dish, a staff member by name, or the service.'
];

const system = shared.concat(banded).concat(
  examples ? ['Style examples from our own past replies - match tone and structure only, never copy them:' + examples] : []
).join('\n');

const user = 'Review (original text): ' + prev.reviewText + '\nStars: ' + prev.stars + '/5';

return [{ json: {
  ragCount: chosen.length,
  band: negative ? 'complaint' : 'praise',
  body: {
    model: 'qwen3.5-4b',
    stream: false,
    max_tokens: 220,
    temperature: 0.4,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  }
} }];