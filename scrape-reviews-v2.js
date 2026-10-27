/* ============================================================
   T3 Thakali — Google Maps review scraper  v2
   Run in DevTools Console on the Reviews panel of your listing.

   Fixes over v1:
   - v1 stopped at 170/560. Scrolling now nudges up before each push
     (Google only fetches the next page when the scroll event moves)
     and waits far longer before deciding the list is finished.
   - v1 returned clipped replies ("...") on 142 of 160. Cause: innerText
     returns only what is VISUALLY rendered, and Google line-clamps long
     replies. textContent returns the whole string from the DOM, clipped
     or not. Everything below reads textContent.
   - v1 put "Local Guide - 6 reviews" or the reviewer's own name in the
     review field for rating-only reviews. Those lines are now filtered
     and such reviews come back with review: null, which is honest.

   HOW TO USE
   1. Google Maps -> your listing -> "Reviews" tab -> sort "Newest".
   2. F12 -> Console.  (If Chrome blocks paste: type  allow pasting  first.)
   3. Paste this whole file, Enter.
   4. Leave the tab alone. 560 reviews takes 8-15 minutes; it logs progress
      and stops on its own. It downloads t3-reviews-v2.json when done.
   ============================================================ */

(async () => {
  const SETTLE_ROUNDS = 15;   // v1 used 6 and quit early on a slow fetch
  const SCROLL_PAUSE  = 1100;
  const MAX_MINUTES   = 25;   // hard stop so it can never spin forever

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  const reviewNodes = () => Array.from(document.querySelectorAll('div[data-review-id]'))
    // Google tags the owner reply with data-review-id too; keep only outermost
    .filter((n) => !n.parentElement.closest('div[data-review-id]'));

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
  if (!scroller) { console.error('Reviews list not found. Open the Reviews tab first.'); return; }

  // ---- 1. load every review ----
  console.log('Scrolling. This is the slow part - leave the tab alone.');
  const deadline = Date.now() + MAX_MINUTES * 60000;
  let seen = 0, flat = 0;
  while (flat < SETTLE_ROUNDS && Date.now() < deadline) {
    scroller.scrollTop = scroller.scrollHeight - 400;   // nudge back...
    await sleep(60);
    scroller.scrollTop = scroller.scrollHeight;         // ...then push, so the
    await sleep(SCROLL_PAUSE);                          // scroll event actually fires
    const n = reviewNodes().length;
    if (n > seen) { seen = n; flat = 0; console.log('  loaded ' + n); }
    else flat++;
  }
  console.log('Loaded ' + seen + ' reviews' + (Date.now() >= deadline ? ' (hit the time cap)' : ''));

  // ---- 2. expand everything that can be expanded ----
  // Matched on the button's own words, so a Google CSS-class rename cannot break it.
  const WANT = /^(more|see more|read more|show more|see original|show original|translate)$/;
  function clickAll() {
    let hits = 0;
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      const label = (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (WANT.test(label)) { try { b.click(); hits++; } catch (e) {} }
    }
    return hits;
  }
  for (let i = 0; i < 8; i++) {
    const n = clickAll();
    console.log('  expanded ' + n);
    if (!n) break;
    await sleep(1400);
  }

  // ---- 3. extract ----
  // Lines Google renders inside a review that are metadata, not the review.
  const JUNK = /^(local guide|\d+ reviews?|\d+ photos?|response from the owner|food|service|atmosphere|meal type|price per person|recommended dishes|parking space|dietary restrictions|new|edited)\b/i;

  const starsOf = (node) => {
    const el = node.querySelector('[role="img"][aria-label*="star"], [role="img"][aria-label*="Star"], [aria-label*="Rated"]');
    const m = (el && el.getAttribute('aria-label') || '').match(/([1-5])(?:[.,]\d)?\s*star|Rated\s*([1-5])/i);
    return m ? Number(m[1] || m[2]) : null;
  };

  const out = [];
  for (const node of reviewNodes()) {
    const reviewer = txt(node.querySelector('div[class*="d4r55"]')) || null;

    // Owner reply block, grabbed first so it can be excluded from the review body.
    const replyBlock = node.querySelector('div[class*="CDe7pd"]')
      || Array.from(node.querySelectorAll('div')).find((d) => /Response from the owner/i.test(d.textContent || ''));
    const reply = replyBlock
      ? txt(replyBlock).replace(/^Response from the owner\s*(a|\d+)?\s*\S*\s*(ago)?\s*/i, '').trim() || null
      : null;

    // Review body: prefer Google's own text container, fall back to the longest
    // leaf that is not metadata and not the reviewer's name.
    let review = txt(node.querySelector('span[class*="wiI7pd"]')) || txt(node.querySelector('div[class*="MyEned"]'));
    if (!review) {
      let best = '';
      for (const el of node.querySelectorAll('span, div')) {
        if (replyBlock && replyBlock.contains(el)) continue;
        if (el.querySelector('span, div')) continue;
        const t = txt(el);
        if (t.length > best.length && !JUNK.test(t) && t !== reviewer) best = t;
      }
      review = best;
    }
    if (JUNK.test(review) || review === reviewer || review.length < 3) review = null;

    // The per-aspect scores Google shows under some reviews - useful signal.
    const aspects = {};
    for (const m of txt(node).matchAll(/\b(Food|Service|Atmosphere):\s*([1-5])\b/g)) aspects[m[1].toLowerCase()] = Number(m[2]);

    out.push({
      review_id: node.getAttribute('data-review-id') || null,
      reviewer, stars: starsOf(node),
      date: txt(node.querySelector('span[class*="rsqaWe"]')) || null,
      review, reply,
      aspects: Object.keys(aspects).length ? aspects : null,
    });
  }

  const clipped = out.filter((r) => r.reply && /…\s*$/.test(r.reply)).length;
  const dist = {}; out.forEach((r) => { dist[r.stars] = (dist[r.stars] || 0) + 1; });
  console.log('EXTRACTED ' + out.length);
  console.log('  with stars : ' + out.filter((r) => r.stars != null).length + '  ' + JSON.stringify(dist));
  console.log('  with text  : ' + out.filter((r) => r.review).length);
  console.log('  with reply : ' + out.filter((r) => r.reply).length + '   still clipped: ' + clipped + ' (v1 had 142)');
  console.log('  longest    : review ' + Math.max(...out.map((r) => (r.review || '').length)) +
              ' / reply ' + Math.max(...out.map((r) => (r.reply || '').length)));
  console.table(out.slice(0, 5));

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = 't3-reviews-v2.json';
  a.click();
  window.__t3 = out;
  console.log('Saved t3-reviews-v2.json');
})();
