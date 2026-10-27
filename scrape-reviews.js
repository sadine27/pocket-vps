/* ============================================================
   T3 / Daura Thakali — Google Maps review scraper
   Run this in the browser DevTools Console, on the REVIEWS panel
   of your own Google Maps listing. Public data, your own business.

   HOW TO USE
   1. Open Google Maps, search your restaurant, click it.
   2. Click the "Reviews" tab so the review list is showing.
   3. (Recommended) Sort -> "Newest" for stable ordering.
   4. Press F12 -> "Console" tab.
   5. Paste this whole file, press Enter.
   6. Wait. It scrolls to the bottom by itself and prints progress.
      560 reviews takes roughly 3-6 minutes. Do not touch the tab.
   7. It downloads "t3-reviews.json" when done.

   If Chrome refuses to let you paste, type   allow pasting   in the
   console first, press Enter, then paste.
   ============================================================ */

(async () => {
  const SETTLE_ROUNDS = 6;    // consecutive no-growth scrolls before we call it done
  const SCROLL_PAUSE  = 700;  // ms between scrolls; raise if your connection is slow

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reviewNodes = () => Array.from(document.querySelectorAll('div[data-review-id]'))
    // Google marks both the review AND the owner reply with data-review-id; keep outer ones
    .filter((n) => !n.parentElement.closest('div[data-review-id]'));

  // ---- find the scrollable reviews pane by walking up from a review ----
  function findScroller() {
    const first = reviewNodes()[0];
    if (!first) return null;
    let el = first.parentElement;
    while (el && el !== document.body) {
      const s = getComputedStyle(el).overflowY;
      if ((s === 'auto' || s === 'scroll') && el.scrollHeight > el.clientHeight + 50) return el;
      el = el.parentElement;
    }
    return null;
  }

  const scroller = findScroller();
  if (!scroller) {
    console.error('Could not find the reviews list. Make sure the Reviews tab is open and at least one review is visible.');
    return;
  }

  // ---- 1. scroll until the list stops growing ----
  console.log('Scrolling to load every review...');
  let seen = 0, flat = 0;
  while (flat < SETTLE_ROUNDS) {
    scroller.scrollTop = scroller.scrollHeight;
    await sleep(SCROLL_PAUSE);
    const n = reviewNodes().length;
    if (n > seen) { seen = n; flat = 0; console.log('  loaded ' + n); }
    else flat++;
  }
  console.log('Done scrolling. ' + seen + ' reviews in the DOM.');

  // ---- 2. expand every "More" and reveal untranslated originals ----
  // Buttons are matched by their accessible label / text so this survives
  // Google renaming its CSS classes.
  function clickAll() {
    let hits = 0;
    for (const b of document.querySelectorAll('button')) {
      const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toLowerCase();
      if (/\bsee more\b|^\s*more\s*$/.test(label) || /see original|show original/.test(label)) {
        try { b.click(); hits++; } catch (e) { /* detached node, ignore */ }
      }
    }
    return hits;
  }
  console.log('Expanding truncated reviews...');
  for (let i = 0; i < 6; i++) {
    const n = clickAll();
    console.log('  clicked ' + n + ' buttons');
    await sleep(1200);
    if (!n) break;
  }

  // ---- 3. extract ----
  const stars = (node) => {
    const el = node.querySelector('[role="img"][aria-label*="star"], [aria-label*="Rated"]');
    if (!el) return null;
    const m = (el.getAttribute('aria-label') || '').match(/([1-5])(?:[.,]\d)?\s*star|Rated\s*([1-5])/i);
    return m ? Number(m[1] || m[2]) : null;
  };

  const out = [];
  for (const node of reviewNodes()) {
    // The owner reply lives in a nested block; grab it first, then exclude it.
    const replyBlock = node.querySelector('div[class*="CDe7pd"]')
      || Array.from(node.querySelectorAll('div')).find((d) => /Response from the owner/i.test(d.textContent || ''));
    const replyText = replyBlock
      ? (replyBlock.innerText || '').replace(/^\s*Response from the owner.*?\n/i, '').trim()
      : '';

    // Review body = longest text block that is not inside the reply block.
    let best = '';
    for (const el of node.querySelectorAll('span, div')) {
      if (replyBlock && replyBlock.contains(el)) continue;
      if (el.querySelector('span, div')) continue;         // leaf nodes only
      const t = (el.innerText || '').trim();
      if (t.length > best.length) best = t;
    }

    out.push({
      review_id: node.getAttribute('data-review-id') || null,
      reviewer: (node.querySelector('div[class*="d4r55"]')?.innerText || '').trim() || null,
      stars: stars(node),
      date: (node.querySelector('span[class*="rsqaWe"]')?.innerText || '').trim() || null,
      review: best,
      reply: replyText || null,
    });
  }

  const withStars = out.filter((r) => r.stars != null).length;
  const withReply = out.filter((r) => r.reply).length;
  console.log('EXTRACTED ' + out.length + ' | with stars: ' + withStars + ' | with reply: ' + withReply);
  console.log('longest review: ' + Math.max(...out.map((r) => (r.review || '').length)) + ' chars (was 372 before scraping)');
  console.table(out.slice(0, 5));

  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 't3-reviews.json';
  a.click();
  window.__t3 = out;   // also left on the page as window.__t3 if the download is blocked
  console.log('Saved t3-reviews.json to your Downloads folder.');
})();
