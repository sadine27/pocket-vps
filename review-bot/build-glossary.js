// build-glossary.js — find which romanized Nepali/Hindi words actually appear in T3's
// reviews, ranked by how many reviews contain them.
//
// Why this exists: on "khana ma dhunga thiyo, staff pani rude" the 4B wrote "food
// issues" instead of "a stone in the food". That is a vocabulary gap, not a style
// gap, and the cheapest fix is to hand the model the words it does not know. But a
// glossary is only worth its tokens if it covers the words that REALLY show up, so
// this ranks candidates off the 1850-review scrape rather than off my guesses.
//
// The English filter below is deliberately rough. Its job is to cut noise so the top
// of the list is readable; the final term list is curated by hand from this output.
//
// Usage: node build-glossary.js [topN]
const fs = require('fs');
const path = require('path');

const SRC = process.env.SCRAPE || 'C:/Users/divye/Desktop/T3/t3-reviews-v2.json';
const TOP = Number(process.argv[2] || 220);

// Common English + restaurant-domain words. Not exhaustive on purpose - anything that
// slips through is discarded during curation, and a missing word only costs one line.
const EN = new Set(('a about after again all also always am amazing an and any anyone are area around as at atmosphere ate authentic available awesome back bad bar be because been before behind being best better big bit bland both bought breakfast but buy by cafe call came can cannot chair chairs cheap check chicken clean cleanliness close closed cold come comes comfortable coming cost costly could counter customer customers cute day days deal decent decor definitely delicious dessert did didn dine dining dinner dirty dish dishes do does doesn don done drink drinks each eat eaten eating egg enjoy enjoyed enough even ever every everything excellent expensive experience extra fair family fantastic far fast favorite favourite feel felt few find fine first food for found free fresh friendly friends from front full get gave give given go going good got great had half has have having he her here high highly him his home hot hotel hour hours how however hygiene i if in inside is it item items just keep kind kitchen know lack lacked large last late less like liked little lot loved love lovely low lunch made main make man management manager many may me meal meals meat memorable men menu might minutes momo momos money more morning most mostly much must my near need never new next nice night no none not nothing now of off often ok okay old on once one only open or order ordered orders other our out outside over overall owner people perfect person pick place places pleasant please plenty poor portion portions premium presentation prep price prices pricey pricing pure quality quantity quick quite rate rating really reasonable recommend recommended restaurant review rice right room rooms rude sad said same sat sauce say seating see seem seems served service serving set several she shop should side simple since sit site situated slow small so some someone something soon soup space special spicy spot staff standard star stars still stop street strongly stuff such sure sweet table tables taken taste tasted tastes tasty tea team than thank thanks that the their them then there these they thing things think this those though three time times tip tips to today together too took top total totally tried try trying two under until up us use used usual value variety vary vege veg vegetarian very view visit visited visiting waiter waiting want was wasn watch water way we well went were what when where which while who why will wish with within without won wonderful worst worth would wow yes yet you your yummy').split(/\s+/));

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const rows = Array.isArray(raw) ? raw : (raw.reviews || []);
const REL_DATE = /^(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i;

const docFreq = new Map();   // token -> number of reviews containing it
const sample = new Map();    // token -> one review snippet showing it in use
let scanned = 0;

rows.forEach((r) => {
  const text = String(r.review || '').replace(/\s+/g, ' ').trim();
  if (!text || REL_DATE.test(text)) return;
  scanned++;
  const toks = new Set(
    text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length >= 3 && !EN.has(w))
  );
  toks.forEach((w) => {
    docFreq.set(w, (docFreq.get(w) || 0) + 1);
    if (!sample.has(w)) sample.set(w, text.slice(0, 90));
  });
});

const ranked = [...docFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);

console.log('scanned ' + scanned + ' reviews with text (of ' + rows.length + ' records)');
console.log('distinct non-English candidate tokens: ' + docFreq.size);
console.log('\nrank  reviews  token          example');
ranked.forEach(([w, n], i) => {
  console.log(
    String(i + 1).padStart(4) + '  ' + String(n).padStart(7) + '  ' + w.padEnd(14) + ' ' + sample.get(w)
  );
});

const out = path.join(__dirname, 'rag-ingest', 'glossary-candidates.json');
fs.writeFileSync(out, JSON.stringify(
  ranked.map(([w, n]) => ({ token: w, reviews: n, example: sample.get(w) })), null, 2));
console.log('\nwrote ' + out);
