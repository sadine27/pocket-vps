// normalize-pairs.js — build the RAG corpus for T3 Thakali.
//
// Divyesh's rule (2026-08-18): boilerplate is acceptable on 4-5* praise, but not
// on 1-3*. Negative reviews are the reputation-critical path and must get a reply
// that engages with the actual complaint. The two bands are therefore filtered on
// different rules:
//
//   PRAISE (4-5*, or unrated with no complaint signal)
//     Keep ONE copy of each distinct reply template. 150 identical rows would make
//     every retrieval return 8 copies of the same text, and the model would simply
//     transcribe it.
//   COMPLAINT (1-3*, or complaint signal in the text)
//     Keep only pairs whose reply owns the problem. A praise template pasted onto a
//     bad review is the exact mistake this bot exists to stop making, so those are
//     diverted to rejected-mismatches.json as evidence rather than deleted.
//
// Inputs (any or all; merged on review text):
//   Desktop/T3/t3-reviews-v2.json      full scrape: 1850 reviews, complete replies
//   Desktop/T3/t3-reviews.json         v1 scrape, superseded but harmless to merge
//   Desktop/T3/reviews_structured.txt  hand-copied, no stars
// Outputs:
//   rag-ingest/pairs-2026-08.json      [{business_id, review, reply, source, stars, band}]
//   rag-ingest/rejected-mismatches.json
//   rag-ingest/board-stats.json        counts behind the board report
//
// Usage: node normalize-pairs.js
const fs = require('fs');
const path = require('path');

const BIZ = 'b1';
const V2 = 'scrape-v2-2026-08';
const T3 = path.join(process.env.USERPROFILE, 'Desktop', 'T3');
const OUT = path.join(__dirname, 'rag-ingest');

const norm = (s) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
const key = (s) => norm(s).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');

// Google renders a relative date in the same block as the text. On a review with no
// words it is all the scraper found (330 rows), and it occasionally leaks onto the
// front of a reply (6 rows).
const REL_DATE = /^(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i;

// Rating-only reviews: Google renders profile and aspect metadata where the text
// would be, and the scraper captured that. None of it is a review. Anchored on the
// metadata's own punctuation so "Food was amazing" is never caught.
const JUNK_REVIEW = /^(local guide\b|\d+\s+(reviews?|photos?)\b|(food|service|atmosphere|meal type|price per person|recommended dishes|parking space|dietary restrictions)\s*:)/i;

// Review text that reads like a complaint even with no star rating attached.
const COMPLAINT = new RegExp([
  'worst', 'bad', 'poor', 'rude', 'slow', 'late', 'cold', 'stale', 'dirty', 'unhygien',
  'overpriced', 'expensive', 'costly', 'scam', 'cheat', 'disappoint', 'terrible', 'awful',
  'not good', 'not worth', 'never (come|go|again)', 'waste of', 'avoid', 'wrong order',
  'khattam', 'najani', 'ramro chaina', 'ramro xaina', 'mitho chaina', 'mitho xaina',
  'dhunga', 'jhur', 'bekar', 'mahango', 'dhilo',
].join('|'), 'i');

// A reply that congratulates the guest. Fine on praise, damning on a complaint.
const PRAISE_REPLY = /glad\b|delighted|kind words|thank you so much for giving us ratings|happy to hear|pleased to hear/i;
// A reply that actually owns the problem.
const APOLOGY_REPLY = /sorry|apolog|regret|we (will|.ll) (work|review|address|look|improve)|did ?n.?t meet|take (this|your) (matter|feedback)/i;
// An opening that congratulates before saying anything else.
const OPENS_WARM = /^[^.!?]{0,90}\b(thank you|thanks|glad|delighted|happy|pleased)\b/i;

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}]/gu;

// Honorifics. The house style opens nearly every reply "Thank you so much, Sir," —
// including to Sharmila, Meghna and Bhuwa. The bot cannot know a guest's gender from
// a Google display name, and a wrong guess is worse than none, so the examples are
// stripped neutral. To restore the house style, delete this function's body.
// The comma that introduced the honorific has to go with it, or every reply reads
// "Thank you so much, for your review" and the corpus teaches that comma splice.
const deHonorific = (s) => s
  .replace(/,\s*(sir|ma[’']?am|madam)\s*,\s*/gi, ' ')          // "much, Sir, for" -> "much for"
  .replace(/,?\s*(sir|ma[’']?am|madam)\s*(?=[.!?])/gi, '')      // "expectations, Sir." -> "expectations."
  .replace(/,?\s*\b(sir|ma[’']?am|madam)\b\s*/gi, ' ')          // anything left over
  .replace(/\s+([,.!?])/g, '$1')
  .replace(/,\s*,/g, ',')
  .replace(/\s{2,}/g, ' ')
  .trim();

// A reply arrives as "<full text>! <emoji> …" — the trailing ellipsis is Google's
// line-clamp marker sitting in the DOM, not a truncation of the text itself (1350 of
// 1381 clipped replies end on a finished sentence). Drop the marker and the emoji,
// and only if what remains still ends mid-thought, cut back to the last full stop.
// The hand-copied file marks an unanswered review with a bracketed note rather than
// leaving the field empty. It is not a reply and must never reach the corpus.
const PLACEHOLDER = /^\[.*\]$|no owner reply found/i;

const cleanReply = (s, source) => {
  let out = norm(s).replace(REL_DATE, '');
  if (PLACEHOLDER.test(out)) return '';
  const wasClipped = /…\s*$/.test(out);
  out = out.replace(/…\s*$/, '');
  out = deHonorific(out.replace(EMOJI, ''));
  out = norm(out);
  // Only the v1 scrape truncated: it read innerText, which returns just the visually
  // rendered text, so Google's line clamp cut the reply mid-word. v2 reads textContent
  // and comes back whole - its trailing ellipsis is the clamp MARKER, not a cut. Cutting
  // v2 back to the last full stop would amputate "We are so glad that you loved our food
  // and service, we look forward to serving you again" off 670 replies, since that clause
  // carries no terminator of its own.
  if (wasClipped && source !== V2 && !/[.!?。]\s*$/.test(out)) {
    const m = out.match(/^[\s\S]*[.!?。]/);
    if (m) out = m[0].trim();
  }
  return out;
};

// ---------- load ----------
const rows = [];
const loadJson = (file, source) => {
  const p = path.join(T3, file);
  if (!fs.existsSync(p)) return 0;
  const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const r of arr) {
    rows.push({
      review: norm(r.review), reply: norm(r.reply),
      stars: r.stars == null ? null : r.stars, source,
    });
  }
  return arr.length;
};

const nV2 = loadJson('t3-reviews-v2.json', V2);
const nV1 = loadJson('t3-reviews.json', 'scrape-2026-08');

let nTxt = 0;
const txtPath = path.join(T3, 'reviews_structured.txt');
if (fs.existsSync(txtPath)) {
  const raw = fs.readFileSync(txtPath, 'utf8').replace(/\r\n/g, '\n');
  for (const block of raw.split(/\n---\n/)) {
    const rm = block.match(/\nReview:\n([\s\S]*?)(?=\nReply:|\n*$)/);
    const pm = block.match(/\nReply:\n(?:Owner reply date:.*\n)?([\s\S]*?)$/);
    if (!rm) continue;
    rows.push({ review: norm(rm[1]), reply: norm(pm ? pm[1] : ''), stars: null, source: 'manual-copy-2026-08' });
    nTxt++;
  }
}

// ---------- merge the sources on review text ----------
// Where two sources hold the same review, take the stars from whichever has them and
// the longer reply, since the older scrape genuinely truncated.
const merged = new Map();
let dateOnly = 0, tooShort = 0;
for (const r of rows) {
  if (!r.review || r.review.length < 4) { tooShort++; continue; }
  if (REL_DATE.test(r.review)) { dateOnly++; continue; }
  const k = key(r.review).slice(0, 80);
  if (!k) { tooShort++; continue; }
  const cur = merged.get(k);
  if (!cur) { merged.set(k, r); r.replySource = r.source; continue; }
  if (r.stars != null && cur.stars == null) cur.stars = r.stars;
  // Track where the winning reply came from, not just where the review came from:
  // only a v1 reply may be cut back, and the two can arrive from different files.
  if ((r.reply || '').length > (cur.reply || '').length) { cur.reply = r.reply; cur.replySource = r.source; }
  if (r.review.length > cur.review.length) cur.review = r.review;
}

// ---------- band + filter ----------
const kept = [], rejected = [];
let noReply = 0, dupReply = 0, junkReview = 0;

for (const r of merged.values()) {
  if (JUNK_REVIEW.test(r.review)) { junkReview++; continue; }
  r.reply = cleanReply(r.reply, r.replySource || r.source);
  if (!r.reply || r.reply.length < 25) { noReply++; continue; }

  const negative = (r.stars != null && r.stars <= 3) || (r.stars == null && COMPLAINT.test(r.review));
  const band = negative ? 'complaint' : 'praise';
  const rec = { business_id: BIZ, review: r.review, reply: r.reply, source: r.source, stars: r.stars, band };

  if (band === 'complaint') {
    // Reject on any congratulation, including one with an apology bolted on after.
    // "Lalgad ko taste ayo khana ma" is a Nepali insult — it likens the food to a
    // leprosy hospital — and it was answered "Thank you, Sir. We're glad our food
    // reminded you of Lalgadh. Sorry to hear...". Half an apology does not redeem
    // thanking someone for an insult, and keeping it teaches that exact reflex.
    if (PRAISE_REPLY.test(r.reply) || OPENS_WARM.test(r.reply)) {
      rejected.push({
        stars: r.stars, review: r.review, reply: r.reply,
        why: APOLOGY_REPLY.test(r.reply) ? 'thanks the guest for a complaint, then apologises'
                                         : 'praise template on a negative review',
      });
      continue;
    }
    if (!APOLOGY_REPLY.test(r.reply)) {
      rejected.push({ stars: r.stars, review: r.review, reply: r.reply, why: 'negative review, reply acknowledges nothing' });
      continue;
    }
    kept.push(rec);
  } else {
    kept.push(rec);
  }
}

// One copy of each distinct reply, in BOTH bands. The complaint band has its own
// reused template ("We are extremely sorry for an unpleasant experience...") and
// eight copies of it would crowd out the eight different examples retrieval is
// supposed to supply. Keep the instance with the longest review, since a richer
// review makes the better few-shot demonstration.
const byReply = new Map();
for (const rec of kept) {
  const rk = key(rec.reply).slice(0, 120);
  const cur = byReply.get(rk);
  if (!cur) { byReply.set(rk, rec); continue; }
  dupReply++;
  if (rec.review.length > cur.review.length) byReply.set(rk, rec);
}
kept.length = 0;
kept.push(...byReply.values());

// ---------- board evidence ----------
// Counted on the raw scrape, before any of the filtering above, because the board is
// being shown what was actually posted to Google — not what survived our pipeline.
const posted = rows.filter((r) => r.source === 'scrape-v2-2026-08' && r.reply && r.reply.length > 10);
const tally = new Map();
const sample = new Map();
for (const r of posted) {
  const cleaned = cleanReply(r.reply, V2);
  const k = key(cleaned).slice(0, 120);
  tally.set(k, (tally.get(k) || 0) + 1);
  if (!sample.has(k)) sample.set(k, cleaned);
}
const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
const low = posted.filter((r) => r.stars != null && r.stars <= 3);

// One digit per posted reply, in the order Google shows them: 1-6 name the six most
// reused templates, 0 means individually written. The board report renders this as a
// grid of squares so the repetition is visible without reading a single number.
const rank = new Map();
ranked.slice(0, 6).forEach(([k], i) => rank.set(k, i + 1));
const gridSequence = posted.map((r) => rank.get(key(cleanReply(r.reply, V2)).slice(0, 120)) || 0).join('');
const boardStats = {
  reviews_scraped: rows.filter((r) => r.source === 'scrape-v2-2026-08').length,
  replies_posted: posted.length,
  distinct_replies: ranked.length,
  repeated_replies: ranked.filter((t) => t[1] > 1).reduce((s, t) => s + t[1], 0),
  top_templates: ranked.slice(0, 8).map(([k, n]) => ({ count: n, text: sample.get(k) })),
  low_star_replied: low.length,
  low_star_distinct: new Set(low.map((r) => key(cleanReply(r.reply, V2)).slice(0, 120))).size,
  mismatches: rejected.length,
  mismatches_by_star: rejected.reduce((a, r) => { a[r.stars] = (a[r.stars] || 0) + 1; return a; }, {}),
  top6_total: ranked.slice(0, 6).reduce((s, t) => s + t[1], 0),
  grid_sequence: gridSequence,
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'pairs-2026-08.json'), JSON.stringify(kept, null, 2));
fs.writeFileSync(path.join(OUT, 'rejected-mismatches.json'), JSON.stringify(rejected, null, 2));
fs.writeFileSync(path.join(OUT, 'board-stats.json'), JSON.stringify(boardStats, null, 2));

const byBand = (b) => kept.filter((x) => x.band === b).length;
console.log('sources              : v2', nV2, '| v1', nV1, '| hand-copy', nTxt);
console.log('raw rows read        :', rows.length);
console.log('  dropped, date only :', dateOnly, '(rating-only review, no words)');
console.log('  dropped, too short :', tooShort);
console.log('unique reviews       :', merged.size);
console.log('  dropped, junk text :', junkReview);
console.log('  dropped, no reply  :', noReply);
console.log('  dropped, dup reply :', dupReply, '(that exact reply is already kept once)');
console.log('  dropped, MISMATCH  :', rejected.length, '-> rejected-mismatches.json');
console.log('KEPT                 :', kept.length, '= praise', byBand('praise'), '+ complaint', byBand('complaint'));
console.log('  complaint w/ stars :', kept.filter((x) => x.band === 'complaint' && x.stars != null).length);
console.log('board: posted', boardStats.replies_posted, '| distinct', boardStats.distinct_replies,
            '| top template used', boardStats.top_templates[0] && boardStats.top_templates[0].count, 'times');
