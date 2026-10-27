// fix-batching.js — process EVERY update in a poll, not just the first one.
//
// Proven by execution 3736 (2026-08-18, Nepal 21:11:27): one poll carried two button
// taps, 115989635 and 115989636. Both reached Is Callback. Only 115989635 came out of
// Handle Callback. The second tap vanished with no error anywhere.
//
// Cause: five Code nodes run in "Run Once for All Items" mode, read $json -- which in
// that mode is ITEM 0 ONLY -- and return a single-element array. Any second, third or
// tenth item in the same batch is silently discarded. It affects both paths:
//   * Parse Review / Build Prompt / Extract Draft / Build Msg -> only the first REVIEW
//     of a batch ever gets drafted.
//   * Handle Callback -> only the first BUTTON TAP of a batch ever gets acted on.
//
// Fix: keep the all-items mode (Parse Review must be able to drop non-text updates,
// which per-item mode cannot express) and loop $input.all() explicitly. Nodes below
// Parse Review are index-aligned 1:1 with it, because HTTP Request and Code nodes both
// emit one output item per input item, so $('Parse Review').all()[i] is the right
// partner for input item i.
//
// pairedItem is set on every emitted item. Without it, hand-built items lose n8n's
// lineage tracking and the downstream $('Node').item lookups in Save Offset Msg,
// Save Offset Ok and Clear Buttons throw "can't determine which item to use".
//
// Usage: node fix-batching.js
const fs = require('fs');
const path = require('path');
const { getWorkflow, putWorkflow } = require('./n8n-client');

const WF = process.env.WF_ID || 'ELk9R3m7jeGK5VAF';

const PARSE_REVIEW = `// One poll can carry several updates. A bare $json here would read item 0 only and
// drop the rest, so loop explicitly.
const out = [];
$input.all().forEach(function (item, i) {
  const u = item.json;
  const msg = u.message || {};
  const t = msg.text || '';
  // Photos, stickers, voice notes and joins are not reviews - skip them quietly
  // rather than throwing, which would mark the whole execution failed.
  if (!t) { return; }
  const mm = t.match(/^([1-5])\\/5\\s+([\\s\\S]+)$/);
  out.push({ json: {
    stars: mm ? parseInt(mm[1], 10) : 3,
    reviewText: mm ? mm[2] : t,
    chatId: msg.chat.id,
    updateId: u.update_id
  }, pairedItem: { item: i } });
});
return out;`;

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

// One item per review in the batch, index-aligned with Parse Review.
const reviews = $('Parse Review').all();
const out = [];

$input.all().forEach(function (item, i) {
  const prev = reviews[i].json;
  const pairs = (item.json && Array.isArray(item.json.pairs)) ? item.json.pairs : [];
  const negative = prev.stars <= 3;

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
  chosen.slice(0, 3).forEach(function (p, n) {
    examples += '\\n[' + (n + 1) + '] Review: "' + cut(p.review, 100) + '"\\nReply: "' + cut(p.reply, 200) + '"\\n';
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

  out.push({ json: {
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
  }, pairedItem: { item: i } });
});

return out;`;

const EXTRACT_DRAFT = `// One model response per review in the batch, index-aligned with Parse Review.
const reviews = $('Parse Review').all();
const prompts = $('Build Prompt').all();
const out = [];

$input.all().forEach(function (item, i) {
  const prev = reviews[i].json;
  const r = item.json;
  let c = (r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '';

  c = c.replace(/<think>[\\s\\S]*?<\\/think>/gi, '');
  c = c.replace(/^\\s*(?:reply|response|answer|draft)\\s*:\\s*/i, '');
  c = c.replace(/\\*\\*|__|\`+/g, '');
  c = c.replace(/^#+\\s*/gm, '');
  c = c.replace(/\\s+/g, ' ').trim();
  c = c.replace(/^["'\\u201c\\u201d]+|["'\\u201c\\u201d]+$/g, '').trim();
  if (c.length > 4000) c = c.slice(0, 3997) + '...';

  const failed = !c;
  if (failed) c = 'Draft failed - the model did not respond. Please reply manually.';

  let ragCount = 0;
  try { ragCount = prompts[i].json.ragCount || 0; } catch (e) { ragCount = 0; }

  out.push({ json: {
    draft: c, failed: failed, stars: prev.stars, reviewText: prev.reviewText,
    chatId: prev.chatId, updateId: prev.updateId, ragCount: ragCount
  }, pairedItem: { item: i } });
});

return out;`;

const BUILD_MSG = `const esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
const stamp = Date.now();
const out = [];

$input.all().forEach(function (item, i) {
  const d = item.json;
  const tag = d.ragCount ? ' \\u00b7 ' + d.ragCount + ' similar' : ' \\u00b7 no RAG';
  const head = d.failed ? '\\u26a0\\ufe0f Draft FAILED:' : '\\u270f\\ufe0f Draft reply:';
  const text = '\\u2b50 ' + d.stars + '/5' + tag + '\\n' + esc(d.reviewText) +
               '\\n\\n' + head + '\\n' + esc(d.draft);
  // Suffix the index: a whole batch is built inside the same millisecond, so the bare
  // timestamp would hand every message in it the same callback_data.
  out.push({ json: {
    chatId: d.chatId, text: text, rid: stamp + '_' + i, updateId: d.updateId
  }, pairedItem: { item: i } });
});

return out;`;

const HANDLE_CALLBACK = `// Several taps can land in one poll, so loop - reading $json would act on the first
// tap only and silently discard the rest (proven by execution 3736).
const unesc = function (s) { return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); };
const esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
const out = [];

$input.all().forEach(function (item, i) {
  const u = item.json;
  const cb = u.callback_query || {};
  const data = cb.data || '';
  const from = (cb.from && cb.from.id) || 0;
  const msg = cb.message || {};
  // The draft is read back out of the message that was tapped, not from stored state.
  // That is what makes an OLD message in the backlog still approvable.
  const draftMatch = (msg.text || '').match(/Draft reply:\\n([\\s\\S]*)$/);
  const draft = draftMatch ? unesc(draftMatch[1].trim()) : '';
  const action = data.startsWith('approve_') ? 'approve' : (data.startsWith('reject_') ? 'reject' : 'unknown');

  // A FAILED draft carries no "Draft reply:" section, so approving one would hand back
  // an empty reply to paste. Say so instead.
  let text;
  if (action === 'approve') {
    text = draft ? '\\u2705 APPROVED \\u2014 paste this reply on Google:\\n\\n' + esc(draft)
                 : '\\u26a0\\ufe0f That message had no draft to approve.';
  } else if (action === 'reject') {
    text = '\\u274c Rejected \\u2014 nothing will be posted.';
  } else {
    text = 'Unknown button.';
  }
  const toast = action === 'approve' ? (draft ? 'Approved \\u2705' : 'No draft on that one')
              : (action === 'reject' ? 'Rejected \\u274c' : 'Unknown button');

  out.push({ json: {
    action: action, from: from, draft: draft, text: text, toast: toast,
    chatId: msg.chat ? msg.chat.id : '',
    messageId: msg.message_id || 0,
    cbId: cb.id || '',
    authorized: from === YOUR_TELEGRAM_USER_ID,
    updateId: u.update_id || 0
  }, pairedItem: { item: i } });
});

return out;`;

const PATCH = {
  'Parse Review': PARSE_REVIEW,
  'Build Prompt': BUILD_PROMPT,
  'Extract Draft': EXTRACT_DRAFT,
  'Build Msg': BUILD_MSG,
  'Handle Callback': HANDLE_CALLBACK,
};

(async function () {
  const wf = await getWorkflow(WF);
  fs.writeFileSync(path.join(__dirname, 'demo-workflow.before-batching-fix.json'), JSON.stringify(wf, null, 2));

  console.log(wf.name + ' | nodes ' + wf.nodes.length + ' | active ' + wf.active);
  Object.keys(PATCH).forEach((name) => {
    const n = wf.nodes.find((x) => x.name === name);
    if (!n) throw new Error(name + ' not found');
    if (n.parameters.mode && n.parameters.mode !== 'runOnceForAllItems') {
      throw new Error(name + ' is in mode ' + n.parameters.mode + ' - the loop rewrite assumes all-items');
    }
    console.log('  ' + name.padEnd(16) + ' ' + n.parameters.jsCode.length + ' chars -> ' + PATCH[name].length + ' chars');
    n.parameters.jsCode = PATCH[name];
  });
  console.log('  backup           : demo-workflow.before-batching-fix.json');

  await putWorkflow(WF, wf);

  const after = await getWorkflow(WF);
  const bad = Object.keys(PATCH).filter((name) => {
    const n = after.nodes.find((x) => x.name === name);
    return !n || n.parameters.jsCode !== PATCH[name];
  });
  console.log(bad.length ? '\nMISMATCH after save: ' + bad.join(', ') : '\nconfirmed: all 5 code nodes now loop over every item');
})().catch(function (e) { console.error('FAILED: ' + e.message); process.exit(1); });
