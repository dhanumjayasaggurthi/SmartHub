/*
  Reads the whole live screen so the assistant can see, understand, point at, and
  act on anything that's actually rendered — no per-page tagging, no fixed list of
  "allowed" buttons.

  captureScreen() returns:
    {
      route, title, url,
      viewport: {w, h}, scroll: {y, maxY},
      text,                                   // visible page text (de-noised)
      controls: [{ ref, kind, label, sel }],  // things you can click/type into
      elements: [{ ref, tag, role, text, sel }], // headings, rows, cells, cards... to point at
    }

  Every captured node is stamped with data-assistant-ref (e.g. "e42") AND carries a
  CSS-path `sel`, so the executor can re-find it by ref first and fall back to the
  selector after a React re-render. Reference ANYTHING by its ref.

  Honest limits (browser security, not us): we can't read cross-origin iframes,
  other browser tabs, or anything outside this web app's DOM.
*/

const SKIP = '[data-assistant-skip], script, style, noscript, svg, link, meta';
const CAP = { text: 12000, controls: 250, elements: 400 };

// ref -> { el, sel }. Held in JS so a ref still resolves even after React strips
// the data-assistant-ref attribute on re-render (the element object lives on here).
const REGISTRY = new Map();

export function resolveRef(r) {
  const hit = REGISTRY.get(r);
  if (!hit) return null;
  if (hit.el && hit.el.isConnected) return hit.el;     // still the same live node
  if (hit.sel) { try { return document.querySelector(hit.sel); } catch {} } // re-find by path
  return null;
}

export function captureScreen() {
  // clear last run's ref stamps + registry so numbering stays fresh and small
  document.querySelectorAll('[data-assistant-ref]').forEach((el) => el.removeAttribute('data-assistant-ref'));
  REGISTRY.clear();
  let seq = 0;
  const ref = (el, sel) => {
    const r = `e${seq++}`;
    el.setAttribute('data-assistant-ref', r);
    REGISTRY.set(r, { el, sel });
    return r;
  };

  const title =
    document.querySelector('h1')?.innerText?.trim() || document.title || '';

  return {
    route: location.pathname,
    url: location.href,
    title: title.slice(0, 160),
    viewport: { w: innerWidth, h: innerHeight },
    scroll: { y: Math.round(scrollY), maxY: Math.round(document.body.scrollHeight - innerHeight) },
    controls: controls(ref).slice(0, CAP.controls),
    elements: elements(ref).slice(0, CAP.elements),
    tables: tables(),
    tour_outline: tourOutline(ref).slice(0, 70),
    text: visibleText().slice(0, CAP.text),
  };
}

// An ordered, deduped list of every meaningful thing on the page — sections, headings,
// charts, tables, cards, tabs and primary buttons — top-to-bottom. This is the canonical
// "explain everything" checklist: the model is told to make exactly one tour step per item
// so nothing gets skipped. Sub-parts are collapsed into their labelled container so we point
// at "Dataset Health" once, not at each of its cells.
function tourOutline(ref) {
  const SEL =
    'h1,h2,h3,h4,h5,h6,[role="heading"], section,[role="region"], ' +
    'table,[role="table"],[role="grid"], svg[aria-label],canvas,[class*="chart"],[class*="graph"],[class*="gauge"], ' +
    '[data-assistant-id],[role="tab"], button,a[href], ' +
    '[class*="card"],[class*="tile"],[class*="metric"],[class*="kpi"],[class*="panel"],[class*="widget"]';

  const isContainer = (el) =>
    el.hasAttribute('data-assistant-id') ||
    el.matches('section,[role="region"],[class*="card"],[class*="panel"],[class*="tile"],[class*="widget"]');
  const keepAlways = (el) =>
    el.hasAttribute('data-assistant-id') ||
    /^(svg|canvas|table)$/.test(el.tagName.toLowerCase()) ||
    el.matches('[role="table"],[role="grid"]') ||
    /chart|graph|gauge/.test(el.className?.toString?.() || '');

  let nodes = [...document.querySelectorAll(SEL)].filter((el) => !inAssistant(el) && !skipped(el) && isVisible(el));
  const set = new Set(nodes);

  // collapse: drop a node if it sits inside another captured *container* (unless it's a
  // chart/table/explicitly-tagged element, which always stay as their own stop)
  nodes = nodes.filter((el) => {
    if (keepAlways(el)) return true;
    let p = el.parentElement;
    while (p) { if (set.has(p) && isContainer(p)) return false; p = p.parentElement; }
    return true;
  });

  // reading order (top-to-bottom, then left-to-right)
  nodes.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return Math.abs(ra.top - rb.top) > 8 ? ra.top - rb.top : ra.left - rb.left;
  });

  const out = [];
  const seen = new Set();
  for (const el of nodes) {
    if (seen.has(el)) continue; seen.add(el);
    const desc = clean(el.getAttribute('data-assistant-desc'));
    const label =
      clean(el.getAttribute('aria-label') || el.getAttribute('title') ||
            el.querySelector('h1,h2,h3,h4,h5,h6')?.innerText || el.innerText || el.textContent).slice(0, 90) ||
      (keepAlways(el) ? 'chart' : '');
    if (!label && !desc) continue;
    const sel = cssPath(el);
    const manual = el.getAttribute('data-assistant-id');
    if (manual) REGISTRY.set(manual, { el, sel });
    out.push({ ref: manual || ref(el, sel), label, desc: desc || undefined, sel });
  }
  return out;
}

// pull tables as real rows/columns so the model reads exact, correctly-paired values
// (e.g. which pass rate belongs to which dataset) instead of a flattened text blob.
function tables() {
  const out = [];
  const tbls = document.querySelectorAll('table, [role="table"], [role="grid"]');
  for (const tbl of tbls) {
    if (inAssistant(tbl) || !isVisible(tbl)) continue;
    const headers = [...tbl.querySelectorAll('thead th, thead td, [role="columnheader"]')]
      .map((h) => clean(h.innerText)).filter(Boolean);

    const rowEls = tbl.querySelectorAll('tbody tr, [role="row"]');
    const list = rowEls.length ? rowEls : tbl.querySelectorAll('tr');
    const rows = [];
    for (const tr of list) {
      if (tr.querySelector('th') && !tr.querySelector('td')) continue; // header row
      const cells = [...tr.querySelectorAll('td, th, [role="cell"], [role="gridcell"]')]
        .map((c) => clean(c.innerText));
      if (cells.length && cells.some(Boolean)) rows.push(cells);
      if (rows.length >= 80) break;
    }
    if (rows.length) out.push({ caption: clean(tbl.querySelector('caption')?.innerText) || undefined, headers, rows });
    if (out.length >= 10) break;
  }
  return out;
}

function isVisible(el) {
  if (!el) return false;
  // genuinely hidden things (inactive tab panels, collapsed menus) stay out, but we do
  // NOT require the element to be in the viewport — a "what's on the page" tour needs to
  // see below-the-fold sections too (it scrolls to each one). That viewport filter was
  // why some sections got skipped.
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const s = getComputedStyle(el);
  if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
  return true;
}

function inAssistant(el) { return !!el.closest?.('[data-assistant-root]'); }
// decoration a page opts out of (canvases, repeated controls) - kept out of every list,
// not just the page text, so it can't crowd the tour or the payload
function skipped(el) { return !!el.closest?.('[data-assistant-skip]'); }

// short, reasonably stable CSS path — fallback when the ref attr gets wiped on re-render
function cssPath(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (!parent) { parts.unshift(tag); break; }
    const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
    const idx = sibs.indexOf(node) + 1;
    parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
    node = parent;
  }
  return parts.join(' > ');
}

function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

function visibleText() {
  const root = document.body;
  if (!root) return '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || inAssistant(p) || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      if (!isVisible(p)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const parts = [];
  let n;
  while ((n = walker.nextNode())) { const t = clean(n.textContent); if (t) parts.push(t); }
  return parts.join('\n');
}

// fields whose value should never leave the browser (passwords, tokens, card
// numbers, ssn, etc). We still describe the field itself so the assistant can
// point at it or type into it — we just never read what's already in it.
const SENSITIVE_TYPES = new Set(['password', 'hidden']);
const SENSITIVE_NAME = /pass(word)?|secret|token|ssn|ccnum|card[-_]?number|cvv|pin\b/i;

function isSensitive(el) {
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (SENSITIVE_TYPES.has(type)) return true;
  const hints = `${el.name || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''}`;
  return SENSITIVE_NAME.test(hints);
}

function labelFor(el) {
  if (isSensitive(el)) {
    return clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || 'sensitive field').slice(0, 80);
  }
  return clean(
    el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
    el.value || el.innerText || el.textContent
  ).slice(0, 80);
}

function controls(ref) {
  const nodes = document.querySelectorAll(
    'button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"], ' +
    'input, select, textarea, [contenteditable="true"], [onclick], [tabindex]'
  );
  const out = [];
  for (const el of nodes) {
    if (inAssistant(el) || skipped(el) || !isVisible(el) || el.disabled) continue;
    const label = labelFor(el);
    if (!label) continue;
    const tag = el.tagName.toLowerCase();
    const kind = tag === 'input' ? (el.type || 'input')
      : tag === 'textarea' || el.isContentEditable ? 'input'
      : tag === 'select' ? 'select'
      : el.getAttribute('role') === 'tab' ? 'tab'
      : tag === 'a' ? 'link' : 'button';
    const sel = cssPath(el);
    const manual = el.getAttribute('data-assistant-id');
    if (manual) REGISTRY.set(manual, { el, sel });
    out.push({ ref: manual || ref(el, sel), kind, label, sel });
  }
  return out;
}

// non-interactive things worth pointing at: headings, table rows/cells, list items,
// labelled regions, cards. Kept to elements that carry their own short text.
function elements(ref) {
  const nodes = document.querySelectorAll(
    'h1,h2,h3,h4,h5,h6, th,td,tr, li, label, summary, figcaption, figure, ' +
    'section, nav, main, aside, header, footer, ' +
    '[role="row"],[role="cell"],[role="gridcell"],[role="heading"],[role="region"],' +
    '[role="listitem"],[role="navigation"],[role="tab"],[role="tabpanel"],[role="img"], ' +
    '[data-assistant-id], [aria-label], [title], [data-tooltip], ' +
    // charts / graphs have no text of their own — capture the container so the tour can point at it
    'svg[aria-label], canvas, [class*="chart"], [class*="graph"], [class*="gauge"], ' +
    '[class*="card"], [class*="tile"], [class*="metric"], [class*="kpi"], [class*="widget"], [class*="panel"]'
  );
  const out = [];
  const seen = new Set();
  for (const el of nodes) {
    if (inAssistant(el) || skipped(el) || !isVisible(el)) continue;
    if (seen.has(el)) continue; seen.add(el);

    // a human-readable name even when the element has no text of its own (icons, charts)
    const desc = clean(el.getAttribute('data-assistant-desc'));
    const label = clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-tooltip'));
    let text = clean(el.innerText || el.textContent).slice(0, 160);
    if (!text) text = label || desc;                         // chart/icon: fall back to its label
    const isChart = /svg|canvas/.test(el.tagName.toLowerCase()) ||
      /chart|graph|gauge/.test(el.className?.toString?.() || '');
    if (!text && !isChart) continue;                          // nothing useful to point at

    const sel = cssPath(el);
    const manual = el.getAttribute('data-assistant-id');
    if (manual) REGISTRY.set(manual, { el, sel });
    out.push({
      ref: manual || ref(el, sel),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || (isChart ? 'chart' : undefined),
      text: text || (isChart ? 'chart' : ''),
      desc: desc || undefined,                               // authored description if the page provided one
      sel,
    });
  }
  return out;
}