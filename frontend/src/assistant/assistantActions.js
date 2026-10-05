// Runs the on-screen things the assistant asks for: navigate, highlight, and
// "do_action" — actually clicking buttons / typing into fields for the user.
// When it acts, a visible cursor glides to the target and clicks, so the user
// sees what's happening.

import { resolveRef } from './captureScreen';

export function runAction(action, navigate, opts = {}) {
  if (!action || !action.name) return;
  // A safety net around every action type, not just do_action's own internal one
  // (below): whatever goes wrong in the browser while carrying out something the
  // model asked for, it must never be able to crash the whole portal. Log it,
  // don't let it propagate.
  const guard = (fn) => {
    try {
      const result = fn();
      if (result && typeof result.catch === 'function') {
        result.catch((err) => console.error('[assistant] action failed:', action.name, err));
      }
      return result;
    } catch (err) {
      console.error('[assistant] action failed:', action.name, err);
    }
  };
  switch (action.name) {
    case 'navigate_to':        return guard(() => navigateTo(action.args, navigate));
    case 'highlight_on_screen': return guard(() => highlight(action.args));
    case 'do_action':          return guard(() => doAction(action.args));
    case 'guide_tour':         return guard(() => guideTour(action.args, navigate, opts));
    default: return;
  }
}

// actions whose label implies a consequential/irreversible change — these get a
// confirmation step in the UI before the agent is allowed to click them.
// Kept to genuinely destructive/hard-to-undo verbs. "Save"/"Submit"/"Validate"/
// "Run"/"Execute"/"Compile" used to be in this list too, which meant nearly every
// routine DQ action (running a validation, saving a form) popped the same scary
// confirm dialog as an actual delete — that trains people to reflexively click
// Allow, which defeats the point of having the confirm step at all.
const DESTRUCTIVE = /\b(delete|remove|reject|discard|clear|reset|drop|approve|deny|overwrite)\b/i;

export function describeAction(action) {
  const args = action?.args || {};
  // the model points at things by `target`; `action_id` is only a deprecated alias.
  // reading action_id alone meant target-based actions resolved to 'this' and never
  // tripped the destructive check, silently skipping the confirm dialog.
  const id = args.target || args.action_id;
  const el = id ? byId(id) : null;
  const label = el ? labelOf(el) : (id || args.value || 'this');
  return { label, destructive: DESTRUCTIVE.test(label) };
}

export async function executeAction(action) {
  return doAction(action.args);
}

function labelOf(el) {
  return (el.getAttribute('aria-label') || el.value || el.innerText || el.textContent || '')
    .replace(/\s+/g, ' ').trim().slice(0, 60);
}

// Every real route, with the other names the same page goes by. A page's
// heading, its sidebar label and its route routinely differ, so the model can
// end up constructing a route out of a name it saw on screen — asking for
// "Structured Explorer (Find it)" (sidebar: "Structured Explorer") produced /structured-explorer,
// which no route matches, so the user got a blank page while the assistant
// reported success. Resolving here means a near-miss lands on the right page and
// a genuine miss reports failure instead of navigating nowhere.
//
// Keep in sync with backend/assistant/tools.py PAGES.
const ROUTE_ALIASES = {
  '/dashboard': ['home', 'landing'],
  '/dqe': ['data-quality', 'dataquality', 'quality', 'checks', 'it-checks', 'business-checks', 'rules'],
  '/rag': ['rags', 'knowledge-base', 'knowledge-bases'],
  '/fuzzy-match': ['fuzzy', 'fuzzymatch', 'matching'],
  '/data-type-validation': ['type-validation', 'datatype-validation'],
  '/data-api': ['data-api-export', 'api-export', 'exports'],
  '/unstructured-explorer': ['unstructured'],
  '/data-studio': [
    'datastudio', 'studio', 'snowflake', 'snowflake-sql',
    'sql-worksheet', 's3', 's3-explorer', 'buckets', 'table-copier',
    'index-health', 'indexer', 'indexes', 'postgres-indexes',
    'streamsets', 'streamsets-extractor', 'pipeline-extractor',
  ],
  '/gra-data-domains': [
    'structured-explorer', 'structured-packages', 'structured', 'find-it',
    'data-domains', 'gra-domains', 'domains', 'structured-data-domains',
  ],
  '/ai-assistant': ['assistant', 'chatbot', 'regwiz'],
  '/user-management': ['users', 'user-mgmt', 'roles', 'permissions', 'rbac'],
  '/communication-center': ['communications', 'comms', 'email-users', 'notifications', 'announcements', 'broadcast'],
  '/audit': ['audit-log', 'audit-trail', 'activity-log'],
};

const KNOWN_ROUTES = new Set(Object.keys(ROUTE_ALIASES));
// Routes that exist but aren't user-navigable targets from chat.
const EXTRA_VALID_ROUTES = new Set(['/audit-edit', '/audit-edit-force']);

export function resolveRoute(route) {
  if (typeof route !== 'string' || !route.startsWith('/')) return null;
  // Compare on the path only; params are carried separately.
  const path = route.split('?')[0].replace(/\/+$/, '') || '/';
  if (KNOWN_ROUTES.has(path) || EXTRA_VALID_ROUTES.has(path)) return path;
  const slug = path.slice(1).toLowerCase();
  for (const [real, aliases] of Object.entries(ROUTE_ALIASES)) {
    if (aliases.includes(slug)) return real;
  }
  return null;
}

// Resolves to { ok, detail } once we know where the user actually ended up.
async function navigateTo({ route, params, then_click } = {}, navigate) {
  const resolved = resolveRoute(route);
  if (!resolved) {
    // Throwing (rather than returning) lets the guard in runAction report a
    // failed ack, so the model's next turn says something true instead of
    // claiming it navigated somewhere it didn't.
    throw new Error(
      `No page at "${route}". Ask the user which page they meant rather than guessing.`
    );
  }
  const qs = params && Object.keys(params).length
    ? '?' + new URLSearchParams(
        Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
      ).toString()
    : '';
  navigate(`${resolved}${qs}`);

  // PermissionRoute (and a few pages) bounce to /dashboard when the role can't
  // open the place, so check where we really landed before reporting success.
  // Poll instead of a fixed wait: done as soon as the URL has held for a beat.
  const here = () => window.location.pathname.replace(/\/+$/, '') || '/';
  const kept = () => {
    const now = new URLSearchParams(window.location.search);
    return Object.entries(params || {}).every(([k, v]) => now.get(k) === String(v));
  };
  const started = Date.now();
  let steadySince = 0;
  while (Date.now() - started < 1500) {
    await wait(40);
    if (here() === resolved && kept()) {
      if (!steadySince) steadySince = Date.now();
      else if (Date.now() - steadySince >= 120) break;   // held long enough - no redirect came
    } else if (steadySince || Date.now() - started > 400) {
      break;                                              // bounced away, or never arrived
    }
  }
  const landed = here();
  if (landed !== resolved) {
    return { ok: false, detail: `The portal sent the user to ${landed} instead of ${resolved} - most likely no access.` };
  }
  // and that the page kept what we asked for - a page that ignores or rewrites a
  // param (a tab the role can't see, a mode it doesn't support) means nothing changed
  const now = new URLSearchParams(window.location.search);
  const lost = Object.entries(params || {}).filter(([k, v]) => now.get(k) !== String(v));
  if (lost.length) {
    return { ok: false, detail: `Opened ${resolved} but the page didn't keep ${lost.map(([k, v]) => `${k}=${v}`).join(', ')} - the view may not have changed.` };
  }

  // some places are a button on the page rather than a URL (e.g. Table Copier)
  if (then_click) {
    let el = null;
    for (let t = 0; t < 3000 && !el; t += 60) { el = findEl(then_click); if (!el) await wait(60); }
    if (!el) return { ok: false, detail: `Opened ${resolved} but couldn't find "${then_click}" to open it.` };
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await wait(80);
    try { el.click(); } catch { return { ok: false, detail: `Couldn't click "${then_click}".` }; }
  }
  return { ok: true, detail: '' };
}

async function highlight({ target, targets, region, note } = {}) {
  ensureTourStyle();
  // a new highlight replaces any previous one, so repeated calls never stack up
  document.querySelectorAll('[data-assistant-hl]').forEach((n) => n.remove());

  // resolve the rect(s) to spotlight
  let rects = [], firstEl = null;
  if (region && region.w && region.h) {
    rects = [{ left: region.x, top: region.y, width: region.w, height: region.h }];
  } else {
    const list = (targets && targets.length ? targets : [target]).map(findEl).filter(Boolean);
    if (!list.length) {
      // last resort: the target might be a field the general resolver missed
      // (e.g. an unusual placeholder wording) — try the form-control-only pool.
      const fallback = (targets && targets.length ? targets : [target]).map(findFormControl).filter(Boolean);
      if (!fallback.length) {
        console.warn('[assistant] highlight_on_screen: could not resolve target(s)', targets || target);
        return false;
      }
      list.push(...fallback);
    }
    firstEl = list[0];
    firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await wait(150);
    await walkAvatarTo(firstEl);            // she leads you there, same as the tour
    rects = list.map((el) => el.getBoundingClientRect());
  }

  const nodes = [];
  const blocker = document.createElement('div');
  blocker.className = 'jjt-block'; blocker.setAttribute('data-assistant-tour', '');
  document.body.appendChild(blocker); nodes.push(blocker);
  // keep the assistant's own panel/avatar readable while everything else dims
  const selfEl = document.querySelector('[data-assistant-root]');
  const holes = selfEl ? rects.concat([selfEl.getBoundingClientRect()]) : rects;
  dimNode(holes, nodes, rects);             // one dim, a clean hole + ring at every target

  // optional explanation card — same chrome as the tour, minus the stepper
  if (note) {
    const heading = rects.length > 1
      ? `${rects.length} items`
      : ((firstEl && labelOf(firstEl)) ? labelOf(firstEl).slice(0, 48) : 'Highlight');
    const card = document.createElement('div');
    card.className = 'jjt-card';
    card.setAttribute('data-assistant-tour', '');
    card.setAttribute('data-assistant-skip', '');
    card.innerHTML =
      `<div class="jjt-head"><span class="jjt-ico">${tourCompass()}</span>` +
        `<span class="jjt-title">${esc(heading)}</span>` +
        `<button class="jjt-x" data-hl="close" aria-label="Close">\u2715</button></div>` +
      `<div class="jjt-body">${esc(note)}</div>` +
      `<div class="jjt-foot"><span style="flex:1 1 auto"></span>` +
        `<button class="jjt-btn jjt-next" data-hl="close">Got it</button></div>`;
    document.body.appendChild(card); nodes.push(card);
    placeCard(card);
    card.querySelectorAll('[data-hl="close"]').forEach((b) =>
      b.addEventListener('click', (ev) => { ev.stopPropagation(); clear(); }));
  }

  // tag every node so the next highlight (above) can clear this one
  nodes.forEach((n) => n.setAttribute('data-assistant-hl', ''));

  // dismiss on click anywhere / Esc / Got it / timeout — never traps the user
  let done = false;
  function clear() {
    if (done) return; done = true;
    window.removeEventListener('keydown', onKey);
    nodes.forEach((n) => { n.style.transition = 'opacity .2s'; n.style.opacity = '0'; setTimeout(() => n.remove(), 220); });
    returnAvatarHome();
  }
  const onKey = (e) => { if (e.key === 'Escape') clear(); };
  window.addEventListener('keydown', onKey);
  blocker.addEventListener('click', clear);
  setTimeout(clear, note ? Math.min(9000, Math.max(3500, readMs(note))) : 2800);
  return true;
}

// ---- guide mode: walk the user through several things, explaining each ----
// The model sends ordered steps [{ route?, target?, say }]. For each step we
// (optionally) navigate, walk the avatar over, ring the element, and show a
// callout with the explanation, paced to reading time. Esc stops the tour.

let tourAbort = false;
let tourResolve = null; // resolver for the current step's user action (Next/Back/Close)

// buttons + Esc funnel through here to advance/retreat/close the current step
function tourAct(action) {
  if (tourResolve) { const r = tourResolve; tourResolve = null; r(action); }
}

// stop a running guide tour immediately (called when the user sends a new command
// or hits Stop) so its leftover steps don't keep walking/talking over the new one.
export function stopTour() {
  tourAbort = true;
  tourAct('close');
  clearTourVisuals();
}

async function guideTour({ title, steps } = {}, navigate, opts = {}) {
  if (!Array.isArray(steps) || !steps.length) return;
  tourAbort = false;

  const onKey = (e) => { if (e.key === 'Escape') { tourAbort = true; opts.cancel?.(); tourAct('close'); } };
  window.addEventListener('keydown', onKey);

  // audio for each step, keyed by index — a step's fetch can be kicked off while
  // an earlier step is still on screen, so by the time we get there it's ready
  const prepCache = {};
  const prepFor = (idx) => {
    if (!opts.prepare || !steps[idx]) return null;
    if (!(idx in prepCache)) prepCache[idx] = opts.prepare(steps[idx].say);
    return prepCache[idx];
  };

  try {
    let i = 0;
    while (i >= 0 && i < steps.length && !tourAbort) {
      const step = steps[i] || {};
      const prep = prepFor(i);

      if (step.route && navigate) {
        try { await navigateTo({ route: step.route, params: step.params }, navigate); } catch (err) { console.warn('[assistant] tour step navigation failed', err); }
      }

      // the target may render a moment after navigation - poll briefly instead of a fixed wait
      let el = step.target ? findEl(step.target) : null;
      for (let t = 0; step.target && !el && t < 1200 && !tourAbort; t += 60) { await wait(60); el = findEl(step.target); }

      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await wait(120);
        await walkAvatarTo(el);
      }
      if (tourAbort) break;

      // spotlight + ring + the card; card.action resolves on Next / Back / Close
      const card = tourCallout(el, step.say || '', i, steps.length, step.title || title);

      // get next step's audio inflight now — it has the whole time this step
      // is being read out loud + waiting on Next to arrive, instead of nothing
      prepFor(i + 1);

      // start the point gesture + speech together; don't block — let buttons interrupt
      const handle = prep ? await prep : null;
      if (tourAbort) { card.clear(); break; }   // stopped while this step's voice was downloading
      const av = el ? avatar() : null;
      if (av) av.classList.add('assistant-acting');
      let speaking;
      if (handle && opts.play) speaking = Promise.resolve(opts.play(handle));
      else if (opts.speak) speaking = Promise.resolve(opts.speak(step.say));
      else speaking = tourSleep(readMs(step.say));
      Promise.resolve(speaking).finally(() => { if (av) av.classList.remove('assistant-acting'); });

      // once the narration finishes, move on by itself — user can still click
      // Back/Close/Next early and that wins the race
      const auto = Promise.resolve(speaking).then(() => 'next');
      const action = await Promise.race([card.action, auto]);   // 'next' | 'back' | 'close' (Esc -> 'close')
      // end this step's line if it's still playing - a full cancel only on close,
      // so the next steps' prefetched narration survives a Next/Back
      if (action === 'close' || tourAbort) opts.cancel?.();
      else (opts.skip || opts.cancel)?.();
      if (av) av.classList.remove('assistant-acting');
      card.clear();

      if (action === 'close' || tourAbort) break;
      if (action === 'back') i = Math.max(0, i - 1);
      else i += 1;
      if (i >= 0 && i < steps.length && !tourAbort) await wait(80);
    }
  } finally {
    window.removeEventListener('keydown', onKey);
    clearTourVisuals();
    returnAvatarHome();
    tourResolve = null;
  }
}

const readMs = (txt) => Math.min(9000, Math.max(2400, (String(txt || '').trim().split(/\s+/).length) * 330));

async function tourSleep(ms) {
  for (let t = 0; t < ms; t += 120) { if (tourAbort) return; await wait(120); }
}

function clearTourVisuals() {
  document.querySelectorAll('[data-assistant-tour]').forEach((n) => n.remove());
}

// inject the tour stylesheet once — hover/focus states, dots, caret and animations need real CSS
function ensureTourStyle() {
  if (document.getElementById('assistant-tour-style')) return;
  const s = document.createElement('style');
  s.id = 'assistant-tour-style';
  s.textContent = `
.jjt-block{position:fixed;inset:0;z-index:2147483638;background:transparent}
.jjt-dim{position:fixed;inset:0;z-index:2147483640;pointer-events:none}
.jjt-ring{stroke:#eb1700;stroke-width:2px;filter:drop-shadow(0 0 4px rgba(235,23,0,.55))}
.jjt-caret{position:fixed;z-index:2147483647;width:14px;height:14px;background:#fff;transform:rotate(45deg)}
.jjt-card{position:fixed;z-index:2147483647;width:280px;max-width:calc(100vw - 16px);background:#fff;border:1px solid #e8e6e3;border-radius:12px;overflow:hidden;pointer-events:auto;box-shadow:0 14px 36px rgba(49,44,42,.30),0 2px 8px rgba(49,44,42,.10);font-family:'JohnsonText',Arial,sans-serif;color:#312c2a;-webkit-font-smoothing:antialiased}
.jjt-head{display:flex;align-items:center;gap:7px;padding:8px 10px;background:#eb1700;color:#fff}
.jjt-head svg{display:block;width:13px;height:13px}
.jjt-title{flex:1 1 auto;font-family:'JohnsonDisplay',Arial,sans-serif;font-weight:700;font-size:12px;letter-spacing:.2px;line-height:1.2}
.jjt-x{all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;font-size:11px;line-height:1;color:#fff;opacity:.8;transition:background .15s,opacity .15s}
.jjt-x:hover{opacity:1;background:rgba(255,255,255,.18)}
.jjt-x:focus-visible{outline:2px solid #fff;outline-offset:1px}
.jjt-body{padding:10px;font-size:12px;line-height:1.4;color:#312c2a}
.jjt-foot{display:flex;align-items:center;gap:8px;padding:7px 10px;border-top:1px solid #f1efed}
.jjt-dots{display:flex;align-items:center;gap:4px;flex:1 1 auto;overflow:hidden}
.jjt-dot{width:5px;height:5px;border-radius:99px;background:#d5cfc9;transition:width .25s,background .25s;flex:0 0 auto}
.jjt-dot.done{background:#f0a99d}
.jjt-dot.now{width:14px;background:#eb1700}
.jjt-count{font-size:10.5px;color:#81766f;white-space:nowrap;font-variant-numeric:tabular-nums}
.jjt-btn{all:unset;cursor:pointer;font-family:'JohnsonText',Arial,sans-serif;font-weight:700;font-size:11px;padding:5px 9px;border-radius:7px;white-space:nowrap;transition:background .15s,transform .05s,box-shadow .15s}
.jjt-btn:focus-visible{outline:2px solid #eb1700;outline-offset:2px}
.jjt-back{color:#6e6259}
.jjt-back:hover{background:#f1efed}
.jjt-back[disabled]{opacity:.35;cursor:default}
.jjt-back[disabled]:hover{background:none}
.jjt-next{background:#eb1700;color:#fff;box-shadow:0 2px 8px rgba(235,23,0,.30)}
.jjt-next:hover{background:#d11400}
.jjt-next:active{transform:translateY(1px);box-shadow:0 1px 4px rgba(235,23,0,.30)}
@media (prefers-reduced-motion:no-preference){
 .jjt-card{animation:jjt-in .22s cubic-bezier(.16,1,.3,1) both}
 .jjt-caret{animation:jjt-fade .22s ease both}
 .jjt-ring{animation:jjt-pulse 1.9s ease-in-out infinite}
}
@keyframes jjt-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
@keyframes jjt-fade{from{opacity:0}to{opacity:1}}
@keyframes jjt-pulse{0%,100%{stroke-width:2px;opacity:1}50%{stroke-width:3px;opacity:.7}}
`;
  document.head.appendChild(s);
}

// shared spotlight pieces so single highlights and the guided tour render identically
function tourCompass() {
  return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9" stroke="#fff" stroke-width="1.7"/>' +
    '<path d="M15.6 8.4l-2.1 5.1-5.1 2.1 2.1-5.1 5.1-2.1z" fill="#fff"/></svg>';
}
// dim the whole screen with a bright hole punched at EACH rect (clean for 1 or many targets),
// and draw the red ring in the SAME svg using the SAME coords, so ring and hole always line up
let dimSeq = 0;
function dimNode(rects, nodes, ringRects) {
  const W = innerWidth, H = innerHeight, pad = 6, rad = 10;
  const id = `jjtmask${++dimSeq}`;
  const box = (b) => ({
    x: Math.round(b.left - pad), y: Math.round(b.top - pad),
    w: Math.round(b.width + pad * 2), h: Math.round(b.height + pad * 2),
  });
  const holes = rects.map((b) => {
    const r = box(b);
    return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${rad}" ry="${rad}" fill="#000"/>`;
  }).join('');
  const rings = (ringRects || []).map((b) => {
    const r = box(b);
    return `<rect class="jjt-ring" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${rad}" ry="${rad}" fill="none"/>`;
  }).join('');
  const wrap = document.createElement('div');
  wrap.className = 'jjt-dim'; wrap.setAttribute('data-assistant-tour', '');
  wrap.innerHTML =
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="position:fixed;inset:0;width:100%;height:100%;display:block">` +
    `<defs><mask id="${id}"><rect width="${W}" height="${H}" fill="#fff"/>${holes}</mask></defs>` +
    `<rect width="${W}" height="${H}" fill="#1c1614" fill-opacity="0.52" mask="url(#${id})"/>` +
    rings +
    `</svg>`;
  document.body.appendChild(wrap); nodes.push(wrap); return wrap;
}
// pinned small, bottom-center of the viewport — out of the way of whatever's
// being highlighted, and consistent regardless of where the target sits.
// Coordinates are rounded to whole pixels: a fractional (e.g. "612.5px") fixed
// position lands the card on a half-pixel, which the browser anti-aliases —
// that's what was reading as "blurry" text/edges on the card.
const CARD_BOTTOM_GAP = 18;
function placeCard(card) {
  const cw = card.offsetWidth, ch = card.offsetHeight;
  const top = window.innerHeight - ch - CARD_BOTTOM_GAP;
  const left = (window.innerWidth - cw) / 2;
  card.style.top = `${Math.round(Math.max(8, top))}px`;
  card.style.left = `${Math.round(Math.max(8, left))}px`;
}

// spotlight + ring + step card for one tour step. Returns { action, clear },
// where action is a Promise resolving to 'next' | 'back' | 'close'.
function tourCallout(el, text, idx, total, title) {
  ensureTourStyle();
  const nodes = [];
  const rect = el ? el.getBoundingClientRect() : null;

  // full-screen click blocker so the page stays inert while the tour runs
  const blocker = document.createElement('div');
  blocker.className = 'jjt-block';
  blocker.setAttribute('data-assistant-tour', '');
  document.body.appendChild(blocker); nodes.push(blocker);

  if (rect) { dimNode([rect], nodes, [rect]); }
  else { blocker.style.background = 'rgba(28,22,20,.52)'; } // no target: dim the whole screen

  // the card
  const last = idx >= total - 1;
  const dots = Array.from({ length: total }, (_, k) => {
    const cls = k < idx ? ' done' : (k === idx ? ' now' : '');
    return `<span class="jjt-dot${cls}"></span>`;
  }).join('');
  const card = document.createElement('div');
  card.className = 'jjt-card';
  card.setAttribute('data-assistant-tour', '');
  card.setAttribute('data-assistant-skip', '');
  card.innerHTML =
    `<div class="jjt-head"><span class="jjt-ico">${tourCompass()}</span>` +
      `<span class="jjt-title">${esc(title || 'Guide')}</span>` +
      `<button class="jjt-x" data-act="close" aria-label="Close">\u2715</button></div>` +
    `<div class="jjt-body">${esc(text)}</div>` +
    `<div class="jjt-foot"><div class="jjt-dots">${dots}</div>` +
      `<span class="jjt-count">${idx + 1} / ${total}</span>` +
      `<button class="jjt-btn jjt-back" data-act="back"${idx > 0 ? '' : ' disabled'}>\u2190 Back</button>` +
      `<button class="jjt-btn jjt-next" data-act="next">${last ? 'Done' : 'Next \u2192'}</button></div>`;
  document.body.appendChild(card); nodes.push(card);

  placeCard(card);

  // buttons (and Esc, via tourAct) resolve the step
  const action = new Promise((resolve) => { tourResolve = resolve; });
  card.querySelectorAll('button[data-act]').forEach((b) => {
    b.addEventListener('click', () => { if (b.disabled) return; tourAct(b.getAttribute('data-act')); });
  });

  const clear = () => nodes.forEach((n) => { n.style.transition = 'opacity .2s'; n.style.opacity = '0'; setTimeout(() => n.remove(), 220); });
  return { action, clear };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function doAction({ action_id, target, action, value } = {}) {
  const rawTarget = target || action_id;
  let el = findEl(rawTarget);

  // Nothing resolved at all, but a value was given — that only makes sense for a
  // field, so go straight to the form-control-only pool instead of just giving up.
  if (!el && value != null && value !== '') el = findFormControl(rawTarget);
  if (!el) { console.warn('[assistant] do_action: could not resolve target', rawTarget); return false; }

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await wait(180); // let the scroll settle before measuring

  const walked = await walkAvatarTo(el);
  if (!walked) await moveCursorTo(el); // no avatar on this page -> arrow cursor

  const a = walked ? avatar() : null;
  if (a) { a.classList.add('assistant-acting'); await wait(140); } // reach out

  let tag = el.tagName.toLowerCase();
  // pick the verb: explicit `action`, else infer from value + element type
  let verb = (action || '').toLowerCase();
  if (!verb) verb = (value != null && value !== '' && (tag === 'input' || tag === 'textarea' || el.isContentEditable)) ? 'type'
    : (value != null && tag === 'select') ? 'select' : 'click';

  // Verify the resolved element can actually do what's being asked before acting on
  // it — this is what catches the exact failure that used to happen silently: the
  // target text matched a <th> instead of the real search <input>, so 'type' would
  // quietly degrade into clicking a column header with nobody ever told it failed.
  // One retry, scoped to form controls only, before giving up.
  const needsField = verb === 'type' || verb === 'fill';
  const needsSelect = verb === 'select';
  const wrongKind = (needsField && !(tag === 'input' || tag === 'textarea' || el.isContentEditable))
    || (needsSelect && tag !== 'select');
  if (wrongKind) {
    const retry = findFormControl(rawTarget);
    if (retry && retry !== el) {
      el = retry;
      tag = el.tagName.toLowerCase();
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await wait(200);
    } else {
      console.warn('[assistant] do_action: resolved element cannot perform', verb, '— target was', rawTarget, el);
      if (a) a.classList.remove('assistant-acting');
      if (walked) returnAvatarHome();
      return false;
    }
  }

  // The walk/wait choreography above can take the better part of a second — long
  // enough for an unrelated re-render (a polling refresh, another state update)
  // to detach or replace the node we resolved earlier. Acting on a stale/detached
  // reference either silently does nothing, or — worse, this is the mechanism
  // behind a real crash seen in production — a click on a button whose own click
  // handler removes it from the DOM (e.g. a conditionally-rendered "Clear all"
  // that disappears once filters are empty) can throw synchronously from deep
  // inside React's own reconciler if the surrounding DOM has shifted underneath
  // it. Re-resolve fresh right before acting instead of trusting the older ref.
  if (!el.isConnected) {
    const fresh = findEl(rawTarget) || findFormControl(rawTarget);
    if (!fresh) {
      console.warn('[assistant] do_action: target detached from the page before the action ran, and could not be re-resolved —', rawTarget);
      if (a) a.classList.remove('assistant-acting');
      if (walked) returnAvatarHome();
      return false;
    }
    el = fresh;
    tag = el.tagName.toLowerCase();
  }

  // Whatever happens inside the native DOM interaction below — including a
  // synchronous exception surfacing from React's own commit in response to it
  // (the exact crash mechanism above) — must never be allowed to escape uncaught
  // and take the whole app down. Contain it, log it, and let the assistant say
  // it hit a problem rather than white-screening the portal.
  let ok = true;
  try {
    switch (verb) {
      case 'type':
      case 'fill':
        el.focus();
        if (el.isContentEditable) { el.textContent = value ?? ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
        else { setNativeValue(el, value ?? ''); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
        walked ? pulseAt(el) : clickPulse();
        break;
      case 'select':
        setNativeValue(el, value ?? '');
        el.dispatchEvent(new Event('change', { bubbles: true }));
        walked ? pulseAt(el) : clickPulse();
        break;
      case 'hover':
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        break;
      case 'focus':
        el.focus();
        break;
      case 'scroll':
      case 'scrollto':
        break; // already scrolled into view above
      case 'check':
        if (el.type === 'checkbox' || el.type === 'radio') { if (!el.checked) el.click(); }
        else el.click();
        walked ? pulseAt(el) : clickPulse();
        break;
      default: // click
        walked ? pulseAt(el) : clickPulse();
        el.click();
    }
  } catch (err) {
    console.error('[assistant] do_action: the interaction itself threw — contained, not crashing the app.', { verb, target: rawTarget, err });
    ok = false;
  }

  if (walked) {
    await wait(140);
    if (a) a.classList.remove('assistant-acting');
    returnAvatarHome();
  }
  return ok;
}

// Resolve whatever the model points at: a ref/id we stamped, a raw CSS selector,
// or visible text. Returns the best matching live element, or null.
function findEl(target) {
  if (!target) return null;
  if (target instanceof Element) return target;
  if (typeof target === 'object') target = target.ref || target.selector || target.sel || target.text || '';
  const t = String(target).trim();
  if (!t) return null;

  // the durable registry from capture time — survives React stripping the attribute
  const reg = resolveRef(t);
  if (reg) return reg;

  const tries = [
    `[data-assistant-id="${cssEscape(t)}"]`,
    `[data-assistant-ref="${cssEscape(t)}"]`,
    `[data-assistant-auto="${cssEscape(t)}"]`,
  ];
  for (const sel of tries) { const el = document.querySelector(sel); if (el) return el; }

  // looks like a CSS selector? try it directly
  if (/[#.[>: ]/.test(t)) { try { const el = document.querySelector(t); if (el) return el; } catch {} }

  // otherwise treat it as visible text — prefer the smallest exact match, then a contains
  return byText(t);
}

// text a form control is identified by — these have no meaningful innerText, so
// byText() used to be unable to match them at all (an <input> was never even a
// candidate). Mirrors captureScreen.js's own labelFor() so "the search box" from
// the model resolves against exactly what it was told the box is called.
function fieldLabel(el) {
  const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
  return norm(
    el.getAttribute('aria-label') || el.getAttribute('placeholder') || label ||
    el.name || el.value || ''
  );
}

const FORM_SEL = 'input, textarea, select, [contenteditable="true"]';

function byText(text) {
  const want = norm(text);
  if (!want) return null;
  const cands = document.querySelectorAll(
    'button,a,[role="button"],[role="tab"],[role="heading"],[role="row"],[role="cell"],' +
    `label,summary,figcaption,h1,h2,h3,h4,h5,h6,th,td,li,strong,b,span,p,div,${FORM_SEL}`
  );
  const isField = (el) => el.matches(FORM_SEL);
  let best = null, bestScore = 0;
  const wantWords = new Set(want.split(' ').filter((w) => w.length > 2));

  for (const el of cands) {
    if (el.closest('[data-assistant-root]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const field = isField(el);
    const txt = field ? fieldLabel(el) : norm(el.innerText || el.textContent);
    if (!txt || txt.length > 400) continue; // skip giant containers
    // a bare, unlabeled field (no placeholder/aria-label/name) can't be text-matched —
    // don't let it fall through to matching on empty string against everything
    if (field && !txt) continue;

    let score = 0;
    if (txt === want) score = 1000 - txt.length;                         // exact, tightest wins
    else if (txt.includes(want)) score = 700 - (txt.length - want.length); // element holds the target — smallest such element
    else if (want.includes(txt) && txt.length >= 3) score = 350 + txt.length; // model was more verbose — longest contained label
    else {                                                                // word overlap
      let hit = 0; for (const w of new Set(txt.split(' '))) if (wantWords.has(w)) hit++;
      if (hit >= 2 || (hit === 1 && wantWords.size === 1)) score = 120 + hit * 10 - txt.length / 20;
    }
    // a field matching by its own placeholder/aria-label/name is exactly what the
    // model meant by "the X box/field/input" — nudge it ahead of a same-scoring
    // static element (headers, cells, etc. are never actually what "the search
    // box" refers to, even if they happen to share a word).
    if (field && score > 0) score += 15;
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return bestScore > 0 ? best : null;
}

// Search restricted to actual form controls (input/textarea/select/contenteditable),
// scored the same way as byText(). Used as the verification/retry path in doAction():
// if a 'type' or 'select' resolved to something that isn't actually an editable
// field (the exact failure mode above — target text coincidentally matched a
// column header instead of the real input), this is the second, narrower attempt
// before giving up.
function findFormControl(text) {
  const want = norm(text);
  if (!want) return null;
  const wantWords = new Set(want.split(' ').filter((w) => w.length > 2));
  let best = null, bestScore = 0;
  for (const el of document.querySelectorAll(FORM_SEL)) {
    if (el.closest('[data-assistant-root]') || el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const txt = fieldLabel(el);
    if (!txt) continue;
    let score = 0;
    if (txt === want) score = 1000 - txt.length;
    else if (txt.includes(want)) score = 700 - (txt.length - want.length);
    else if (want.includes(txt) && txt.length >= 3) score = 350 + txt.length;
    else {
      let hit = 0; for (const w of new Set(txt.split(' '))) if (wantWords.has(w)) hit++;
      if (hit >= 1) score = 120 + hit * 10 - txt.length / 20; // looser here — this pool is already field-only
    }
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

const byId = findEl; // back-compat for describeAction
const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));

// React-controlled inputs ignore plain .value sets; go through the native setter.
// Pick the setter that matches the element type — using the <input> setter on a
// <select> throws ("Illegal invocation"), which broke every 'select' action.
function setNativeValue(el, value) {
  const proto =
    el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
    : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  try { setter ? setter.call(el, value) : (el.value = value); }
  catch { el.value = value; }
}

// ---- the avatar walking across the screen ----
// Instead of parking in the corner, the assistant face glides over to whatever
// it's about to touch, does a little walk-bob on the way, then heads back home.
// Falls back to the small arrow cursor if the avatar isn't on the page.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const avatar = () => document.querySelector('[data-assistant-avatar]');

function ensureWalkStyle() {
  if (document.getElementById('assistant-walk-style')) return;
  const s = document.createElement('style');
  s.id = 'assistant-walk-style';
  s.textContent =
    '@keyframes assistant-bob{0%,100%{transform:translateY(0) rotate(0)}' +
    '25%{transform:translateY(-5px) rotate(-4deg)}75%{transform:translateY(-5px) rotate(4deg)}}' +
    '.assistant-walking > *{animation:assistant-bob .42s ease-in-out infinite}';
  document.head.appendChild(s);
}

// move the avatar so it stands just beside `el`, returns true if it actually walked
// steady human-ish pace, in CSS px per millisecond
const WALK_SPEED = 1.4;
const WALK_MIN_MS = 200;
const WALK_MAX_MS = 480;

// current translate already applied to the avatar (so we can walk on from here)
function currentXY(a) {
  const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/.exec(a.style.transform || '');
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
}

// the avatar's resting (untransformed) centre — derived from where it is now MINUS
// its current translate, so we never have to snap it home to measure (that snap was
// the "jumping").
function homeCenter(a) {
  const r = a.getBoundingClientRect();
  const t = currentXY(a);
  return { cx: r.left + r.width / 2 - t.x, cy: r.top + r.height / 2 - t.y };
}

let lastPose = null;

// Choose stand-point vs kneel-point. The odds depend on WHERE the element sits (kneeling to
// point at something up top looks wrong, so that's gated out), with a bit of randomness and a
// no-repeat nudge so she doesn't do the exact same gesture every single time.
const POSE = { topZone: 0.45, lowZone: 0.62, lowKneel: 0.7, midKneel: 0.25, repeatPenalty: 0.5 };
function pickPointPose(centerY) {
  const f = centerY / innerHeight;
  let kneelOdds;
  if (f < POSE.topZone) kneelOdds = 0;                    // high on screen -> always stand
  else if (f < POSE.lowZone) kneelOdds = POSE.midKneel;   // middle -> occasionally kneel
  else kneelOdds = POSE.lowKneel;                         // low -> usually kneel
  if (lastPose === 'kneel') kneelOdds *= POSE.repeatPenalty; // avoid kneeling twice in a row as often
  const pose = Math.random() < kneelOdds ? 'kneel' : 'stand';
  lastPose = pose;
  return pose;
}

async function walkAvatarTo(el) {
  const a = avatar();
  if (!a || !el) return false;
  ensureWalkStyle();

  const aw = a.offsetWidth || 120;
  const ah = a.offsetHeight || 200;
  const m = 10;          // screen margin
  const gap = 14;        // space between her and the element
  const home = homeCenter(a);
  const t = el.getBoundingClientRect();
  const tcx = t.left + t.width / 2;

  // stand to one SIDE of the element so she never covers it. Prefer the left; flip to
  // the right if there isn't room, and fall back to left if the right is off-screen too.
  let side = (t.left - gap - aw) > m ? 'left' : 'right';
  if (side === 'right' && (t.right + gap + aw) > innerWidth - m) side = 'left';

  let cx = side === 'left' ? (t.left - gap - aw / 2) : (t.right + gap + aw / 2);
  let cy = t.top + t.height / 2;

  // keep her fully on screen
  cx = Math.max(aw / 2 + m, Math.min(innerWidth - aw / 2 - m, cx));
  cy = Math.max(ah / 2 + m, Math.min(innerHeight - ah / 2 - m, cy));

  const dx = cx - home.cx;
  const dy = cy - home.cy;

  // pick her pose like a person would — usually kneel for low things, stand for higher
  // ones, but with some randomness and a no-repeat nudge so it doesn't feel scripted.
  a.dataset.point = pickPointPose(t.top + t.height / 2);

  const from = currentXY(a);
  const travel = Math.hypot(dx - from.x, dy - from.y);
  const elementDir = cx < tcx ? '1' : '-1'; // element is to her right (1) or left (-1)
  if (travel < 2) { a.dataset.dir = elementDir; return true; }
  const ms = Math.min(WALK_MAX_MS, Math.max(WALK_MIN_MS, travel / WALK_SPEED));

  a.dataset.dir = (dx - from.x) >= 0 ? '1' : '-1'; // face the way she's walking
  a.style.transition = `transform ${ms}ms linear`;
  a.classList.add('assistant-walking');
  a.style.transform = `translate(${dx}px, ${dy}px)`;
  await wait(ms);
  a.classList.remove('assistant-walking');
  a.dataset.dir = elementDir; // arrived — turn to face the element so the point lands on it
  return true;
}

function returnAvatarHome() {
  const a = avatar();
  if (!a) return;
  const from = currentXY(a);
  const travel = Math.hypot(from.x, from.y);
  if (travel < 2) { a.style.transform = 'none'; return; }
  const ms = Math.min(WALK_MAX_MS, Math.max(WALK_MIN_MS, travel / WALK_SPEED));
  a.dataset.dir = from.x > 0 ? '-1' : '1'; // walking back toward the corner
  a.style.transition = `transform ${ms}ms linear`;
  a.classList.add('assistant-walking');
  a.style.transform = 'none';
  setTimeout(() => a.classList.remove('assistant-walking'), ms);
}

// a tap ripple centred on an element (used when the avatar itself does the click)
function pulseAt(el) {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const ring = document.createElement('div');
  ring.style.cssText =
    `position:fixed;z-index:99998;left:0;top:0;width:16px;height:16px;border-radius:50%;` +
    `border:2px solid var(--jj-red, #eb1700);pointer-events:none;transform:translate(${x}px,${y}px) scale(.4);` +
    `opacity:.9;transition:transform .4s ease-out,opacity .4s ease-out;`;
  document.body.appendChild(ring);
  requestAnimationFrame(() => {
    ring.style.transform = `translate(${x}px,${y}px) scale(2.6)`;
    ring.style.opacity = '0';
  });
  setTimeout(() => ring.remove(), 450);
}

// ---- the visible cursor ----
let cursorEl = null;
function cursor() {
  if (cursorEl) return cursorEl;
  cursorEl = document.createElement('div');
  cursorEl.setAttribute('aria-hidden', 'true');
  cursorEl.style.cssText =
    'position:fixed;z-index:99999;left:0;top:0;width:22px;height:22px;pointer-events:none;' +
    'transition:transform .6s cubic-bezier(.22,1,.36,1);opacity:0;will-change:transform;';
  cursorEl.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
    '<path d="M5 3l14 7-6 1.5L10 18 5 3z" fill="#eb1700" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cursorEl);
  return cursorEl;
}

function moveCursorTo(el) {
  const c = cursor();
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  c.style.opacity = '1';
  c.style.transform = `translate(${x}px, ${y}px)`;
  return new Promise((res) => setTimeout(res, 650));
}

function clickPulse() {
  const c = cursor();
  const ring = document.createElement('div');
  const m = (c.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/) || []);
  const x = m[1] || 0, y = m[2] || 0;
  ring.style.cssText =
    `position:fixed;z-index:99998;left:0;top:0;width:14px;height:14px;border-radius:50%;` +
    `border:2px solid var(--jj-red, #eb1700);pointer-events:none;transform:translate(${x}px,${y}px) scale(0.4);` +
    `opacity:.9;transition:transform .4s ease-out, opacity .4s ease-out;`;
  document.body.appendChild(ring);
  requestAnimationFrame(() => {
    ring.style.transform = `translate(${x}px,${y}px) scale(2.4)`;
    ring.style.opacity = '0';
  });
  setTimeout(() => ring.remove(), 450);
  // fade the cursor out a moment later
  setTimeout(() => { if (cursorEl) cursorEl.style.opacity = '0'; }, 1200);
}