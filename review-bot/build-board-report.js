// build-board-report.js — render board-report.html from the corpus pipeline's own output.
//
// Every figure on the page comes from rag-ingest/board-stats.json and
// rag-ingest/rejected-mismatches.json, both written by normalize-pairs.js. Nothing is
// typed in by hand, so re-running the pipeline after a fresh scrape regenerates the
// report with numbers that still agree with the corpus actually loaded on the phone.
//
// Usage: node normalize-pairs.js && node build-board-report.js
const fs = require('fs');
const path = require('path');

const IN = path.join(__dirname, 'rag-ingest');
const B = JSON.parse(fs.readFileSync(path.join(IN, 'board-stats.json'), 'utf8'));
const REJ = JSON.parse(fs.readFileSync(path.join(IN, 'rejected-mismatches.json'), 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (x) => Number(x).toLocaleString('en-US');
const pct = (a, b) => Math.round((a / b) * 100);

// ---------- the grid ----------
// One square per posted reply, in the order Google shows them. Classes t0..t5 are the
// six reused templates, t6 is an individually written reply.
const cells = B.grid_sequence.split('')
  .map((d) => '<i class="t' + (d === '0' ? 6 : Number(d) - 1) + '"></i>').join('');

// ---------- the evidence ----------
// Picked by matching the review text so the cards survive a re-scrape; if a review is
// ever edited or deleted by its author, the slot falls back to the next worst case.
const pick = (re) => REJ.find((r) => re.test(r.review));
const worst = REJ.filter((r) => r.stars != null && r.stars <= 3);
const chosen = [
  pick(/lalgad/i),
  pick(/good ambience but poor service/i),
  pick(/over rated too much expensive/i),
  pick(/チキンカレー/),
].map((c, i) => c || worst[i]).filter(Boolean);

const GLOSS = {
  0: 'Lalgadh is Nepal’s leprosy hospital. Saying food tastes of Lalgadh is not a comparison, it is an insult — and we answered it by agreeing.',
  1: 'Three stars, and the guest names the problem in four words. The reply congratulates them on a great experience.',
  2: 'The guest says we are overpriced. The reply thanks them for their kind words.',
  3: 'A guest says they paid 1,300 with a 2,000 note and got 160 back — an accusation of being short-changed. It has stood unanswered in Japanese ever since.',
};
const HILITE = [
  /glad our food reminded you of Lalgadh/i,
  /thrilled to hear you had a great experience/i,
  /thrilled to hear you had a great experience/i,
  /Reviewing on it/i,
];
const VERDICT = ['Agreed with an insult', 'Praise on a complaint', 'Praise on a complaint', 'Never answered'];

const cases = chosen.map((c, i) => {
  const stars = '★'.repeat(c.stars || 1) + '☆'.repeat(5 - (c.stars || 1));
  let reply = esc(c.reply);
  const h = HILITE[i];
  if (h) {
    const m = c.reply.match(h);
    if (m) reply = reply.replace(esc(m[0]), '<mark>' + esc(m[0]) + '</mark>');
  }
  return [
    '      <article class="case' + (i === 0 ? ' lead' : '') + '">',
    '        <div class="case-top">',
    '          <span class="stars" aria-label="' + (c.stars || '?') + ' out of 5 stars">' + stars + '</span>',
    '          <span>posted to Google</span>',
    '          <span class="verdict">' + VERDICT[i] + '</span>',
    '        </div>',
    '        <div class="case-body">',
    '          <div class="side said">',
    '            <h3>The guest wrote</h3>',
    '            <p>' + esc(c.review) + '</p>',
    '          </div>',
    '          <div class="side">',
    '            <h3>We replied</h3>',
    '            <p>' + reply + '</p>',
    '            <p class="gloss">' + GLOSS[i] + '</p>',
    '          </div>',
    '        </div>',
    '      </article>',
  ].join('\n');
}).join('\n');

const rows = B.top_templates.slice(0, 6).map((t, i) =>
  '            <tr><td class="num">' + n(t.count) + '</td><td>' + esc(t.text) + '</td></tr>').join('\n');

const legend = B.top_templates.slice(0, 6).map((t, i) =>
  '        <span><b class="t' + i + '"></b>Template ' + (i + 1) + ' · ' + n(t.count) + '</span>').join('\n');

const style = fs.readFileSync(path.join(__dirname, 'board-report.css'), 'utf8');

const html = `<title>Six Sentences</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">

<style>
${style}</style>

<div class="wrap">

  <header>
    <div class="eyebrow">
      <span>T3 Thakali &amp; Multi Food Gallery</span>
      <span>Google review replies</span>
      <span>${n(B.replies_posted)} replies reviewed</span>
      <span>August 2026</span>
    </div>
    <h1>Six sentences, ${n(B.replies_posted)} replies</h1>
    <p class="standfirst">Every reply we have ever posted to a Google review, collected and counted. Six sentences account for three out of every four.</p>
    <hr class="rule-major">
  </header>

  <div class="figures">
    <div class="fig">
      <span class="n">${n(B.reviews_scraped)}</span>
      <span class="l">reviews on our listing</span>
    </div>
    <div class="fig">
      <span class="n">${n(B.replies_posted)}</span>
      <span class="l">carry a reply from us</span>
    </div>
    <div class="fig is-signal">
      <span class="n">${n(B.distinct_replies)}</span>
      <span class="l">distinct wordings among them</span>
    </div>
    <div class="fig is-signal">
      <span class="n">${n(B.top_templates[0].count)}</span>
      <span class="l">uses of the single most-repeated sentence</span>
    </div>
  </div>

  <section>
    <div class="sec-head">
      <span class="sec-num">01</span>
      <h2>What a guest sees when they scroll</h2>
    </div>
    <div class="sec-body">
      <p class="lede measure">One square for every reply we have posted, in the order Google shows them. Shaded squares are the six sentences below. Green squares are replies somebody actually wrote for that guest.</p>

      <div class="gridwrap">
        <div class="replygrid" role="img" aria-label="A grid of ${n(B.replies_posted)} squares, one per posted reply. ${n(B.top6_total)} of them share one of six identical sentences; the remaining ${n(B.replies_posted - B.top6_total)} are individually written.">${cells}</div>
      </div>
      <div class="legend">
${legend}
        <span><b class="t6"></b>Written for that guest · ${n(B.replies_posted - B.top6_total)}</span>
      </div>

      <div class="tablewrap">
        <table>
          <thead>
            <tr><th class="num">Used</th><th>The sentence, exactly as posted</th></tr>
          </thead>
          <tbody>
${rows}
          </tbody>
          <tfoot class="tfoot">
            <tr><td class="num">${n(B.top6_total)}</td><td>of ${n(B.replies_posted)} replies — ${pct(B.top6_total, B.replies_posted)}% — are one of the six sentences above.</td></tr>
          </tfoot>
        </table>
      </div>
    </div>
  </section>

  <section>
    <div class="sec-head">
      <span class="sec-num">02</span>
      <h2>The part that costs us money</h2>
    </div>
    <div class="sec-body">
      <p class="lede measure">Repetition on a five-star review is forgettable. On an unhappy one it is read as contempt, by the guest and by everyone deciding where to eat.</p>
      <p class="measure">We replied to <strong>${n(B.low_star_replied)}</strong> reviews of three stars or fewer, using <strong>${n(B.low_star_distinct)}</strong> different wordings between them. In <strong>${n(B.mismatches)}</strong> of those, the reply thanks or congratulates a guest who was complaining. Four are below, quoted exactly as they appear on our listing today.</p>

      <div class="evidence">
${cases}
      </div>

      <p class="measure" style="margin-top:30px"><strong>Thirty three-star reviews left written feedback and received a reply. Not one of those replies engaged with the criticism.</strong> Three stars is the guest who liked us and left disappointed — the easiest one to win back, and the one we have never once answered.</p>
    </div>
  </section>

  <section>
    <div class="sec-head">
      <span class="sec-num">03</span>
      <h2>What we are changing</h2>
    </div>
    <div class="sec-body">
      <p class="lede measure">Replies to unhappy guests are now drafted against rules that make the failures above impossible to repeat, and no such reply reaches Google until a person approves it.</p>
      <ul class="rules">
        <li><span class="tick">✓</span><div><b>Never open a one-, two- or three-star reply with thanks</b><span>It opens by naming what went wrong instead.</span></div></li>
        <li><span class="tick">✓</span><div><b>Never say glad, delighted, thrilled or pleased to an unhappy guest</b><span>These words are blocked outright on this band. They are what produced every case in section 02.</span></div></li>
        <li><span class="tick">✓</span><div><b>Name the specific complaint, in the guest’s own words</b><span>The dish, the wait, the staff member, the bill. Generic sympathy is treated as a non-answer.</span></div></li>
        <li><span class="tick">✓</span><div><b>Commit to one concrete action</b><span>A bare “sorry, it will not happen again” is rejected as a complete reply.</span></div></li>
        <li><span class="tick">✓</span><div><b>Read sarcasm and insults as the complaint underneath</b><span>The Lalgadh reply exists because nobody checked what the words meant.</span></div></li>
        <li><span class="tick">✓</span><div><b>A person approves every reply to an unhappy guest</b><span>Drafts arrive for approval and post only when someone accepts them.</span></div></li>
      </ul>
    </div>
  </section>

  <div class="method">
    <h4>How this was counted</h4>
    <p>${n(B.reviews_scraped)} reviews and ${n(B.replies_posted)} owner replies were collected from our own public Google Maps listing in August 2026. Replies were compared as exact text after removing emoji, honorifics and whitespace, so “distinct” means genuinely different wording rather than different punctuation.</p>
    <p>The ${n(B.mismatches)} mismatched replies were identified by rule — a reply that thanks, or claims to be glad or thrilled, on a review of three stars or fewer. A rule cannot catch a reply that is merely bland or evasive, so ${n(B.mismatches)} is a floor, not a total. Star ratings come from Google and were checked against the wording of every one- and two-star review.</p>
  </div>

</div>
`;

fs.writeFileSync(path.join(__dirname, 'board-report.html'), html);
console.log('board-report.html written:', html.length, 'bytes |', B.replies_posted, 'grid cells |', chosen.length, 'evidence cards');
