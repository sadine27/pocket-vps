// check-glossary-terms.js — how many reviews actually contain each candidate term.
//
// build-glossary.js ranks every token, which surfaces staff names and English typos
// alongside the words that matter. This pass goes the other way: take the Nepali/Hindi
// vocabulary a reply would need to understand, and check which of them the corpus
// actually supports. Terms with zero hits are dropped rather than shipped on a hunch.
//
// Usage: node check-glossary-terms.js
const fs = require('fs');

const SRC = process.env.SCRAPE || 'C:/Users/divye/Desktop/T3/t3-reviews-v2.json';
const REL_DATE = /^(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i;

// Grouped by what a reply actually has to get right.
const GROUPS = {
  'FOREIGN OBJECT / HYGIENE': ['dhunga', 'dhunga', 'kapal', 'kira', 'jhinga', 'jhingaa', 'makura', 'fohor', 'fohar', 'safa', 'baasi', 'basi', 'sadeko'],
  'TASTE / QUALITY': ['mitho', 'amitho', 'swadilo', 'swad', 'nunilo', 'noon', 'nun', 'piro', 'guliyo', 'amilo', 'tito', 'chiso', 'tato', 'kachho', 'nasakeko'],
  'FOOD ITEMS': ['khana', 'khaja', 'bhat', 'dal', 'sabji', 'tarkari', 'masu', 'kukhura', 'khasi', 'machha', 'achar', 'dahi', 'jhol', 'momo', 'momos', 'sekuwa', 'thukpa', 'sukuti', 'gundruk', 'dhido', 'sel', 'aloo', 'alu', 'thali', 'chiya', 'lassi', 'roti', 'paani'],
  'PRICE / BILLING': ['mahango', 'mahngo', 'sasto', 'paisa', 'thagyo', 'thageko', 'bill'],
  'SERVICE / SPEED': ['dhilo', 'chito', 'sewa', 'sarbis', 'kaam', 'thap', 'pugena', 'kam', 'sodnu', 'sodhda', 'parkhinu'],
  'JUDGEMENT': ['ramro', 'naramro', 'kharab', 'bekar', 'jhur', 'dami', 'ekdam', 'dherai', 'sabai', 'thik', 'matra'],
  'PEOPLE / ADDRESS': ['dai', 'daju', 'bhai', 'vai', 'didi', 'bahadur', 'bdr', 'bhadur', 'bhadr', 'badhur', 'manche', 'manxe', 'sathi', 'haru'],
  'GRAMMAR GLUE': ['thiyo', 'bhayo', 'aayo', 'gayo', 'diyo', 'garyo', 'lagyo', 'cha', 'xa', 'chaina', 'xaina', 'chha', 'ani', 'ra', 'tara', 'pani', 'malai', 'hami', 'yaha', 'ko', 'ma', 'lai', 'kina', 'kasto', 'jasto', 'pheri', 'sadhai', 'aauchuu', 'najikai', 'gunaso', 'mafi', 'dhanyabad', 'namaste'],
};

const rows = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const texts = rows
  .map((r) => String(r.review || '').replace(/\s+/g, ' ').trim())
  .filter((t) => t && !REL_DATE.test(t));

const count = (term) => {
  const re = new RegExp('\\b' + term + '\\b', 'i');
  const hits = texts.filter((t) => re.test(t));
  return { n: hits.length, ex: hits.length ? hits[0].slice(0, 78) : '' };
};

console.log('corpus: ' + texts.length + ' reviews with real text\n');
let keep = 0;
let drop = 0;
Object.keys(GROUPS).forEach((g) => {
  console.log('--- ' + g);
  const seen = new Set();
  GROUPS[g].forEach((term) => {
    if (seen.has(term)) return;
    seen.add(term);
    const { n, ex } = count(term);
    if (n === 0) { drop++; return; }
    keep++;
    console.log('  ' + String(n).padStart(4) + '  ' + term.padEnd(12) + ' ' + ex);
  });
  console.log('');
});
console.log('terms with corpus support: ' + keep + ' | zero hits, dropped: ' + drop);
