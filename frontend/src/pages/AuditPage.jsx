import React, {
  useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle, memo, useInsertionEffect,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useRBAC } from '../context/RBACContext';
import { useMsal } from '@azure/msal-react';
import { logAuditEvent } from '../utils/auditLog';
import { apiFetch } from '../utils/apiClient';
import { usePerfTier, measureTier } from '../utils/perfTier';

import leaderIcon from '/icons/JJ_Icon_Leader_RGB.svg';
import loginIcon from '/icons/JJ_Icon_Login_RGB.svg';
import databaseIcon from '/icons/JJ_Icon_Database_RGB.svg';
import globeIcon from '/icons/JJ_Icon_Globe_RGB.svg';
import shieldIcon from '/icons/JJ_Icon_Shield_RGB.svg';
import searchIcon from '/icons/JJ_Icon_Search_RGB.svg';
import refreshIcon from '/icons/JJ_Icon_Refresh_RGB.svg';
import closeIcon from '/icons/JJ_Icon_Close.svg';
import chevronIcon from '/icons/JJ_Icon_Chevron_Right.svg';
import timeIcon from '/icons/JJ_Icon_Time_RGB.svg';
import filterIcon from '/icons/JJ_Icon_Filter.svg';
import deleteIcon from '/icons/JJ_Icon_Delete_RGB.svg';
import alertIcon from '/icons/JJ_Icon_Alert_RGB.svg';
import lockIcon from '/icons/JJ_Icon_Lock_black.svg';
import peopleIcon from '/icons/JJ_Icon_Community_RGB.svg';
import chartIcon from '/icons/JJ_Icon_Graph_Chart_RGB.svg';
import logoutIcon from '/icons/JJ_Icon_Log_Out_RGB.svg';
import timerIcon from '/icons/JJ_Icon_Timer_RGB.svg';

// ─── taxonomy ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;
const LIVE_POLL_MS = 15_000;
const STATS_POLL_MS = 60_000;
const ACTIVE_POLL_MS = 30_000;
const INTRO_KEY = 'smarthub:audit-intro-seen';
const LIVE_KEY = 'smarthub:audit-live';

// Tailwind palette from tailwind.config.js, repeated because dots, bars and
// canvas strokes are coloured per event at runtime.
const ACCENT = {
  red: '#eb1700', maroon: '#9e0000', green: '#328714', blue: '#0f68b2',
  orange: '#ff6017', violet: '#8c3bbb', gray: '#6e6259',
};

// action key → [label, accent]
const ACTION_META = {
  role_assigned: ['Role Assigned', ACCENT.green],
  role_removed: ['Role Removed', ACCENT.maroon],
  role_created: ['Role Created', ACCENT.blue],
  role_updated: ['Role Updated', ACCENT.orange],
  role_reset: ['Role Reset', ACCENT.violet],
  role_deleted: ['Role Deleted', ACCENT.maroon],
  role_access_customized: ['Access Customized', ACCENT.violet],
  role_access_reset: ['Access Reset', ACCENT.gray],
  user_login: ['User Login', ACCENT.green],
  user_logout: ['User Logout', ACCENT.gray],
  session_timeout: ['Session Timeout', ACCENT.orange],
  page_access: ['Page Access', ACCENT.violet],
  audit_log_deleted: ['Log Entry Deleted', ACCENT.maroon],
  audit_edit_mode_accessed: ['Audit Edit Mode', ACCENT.maroon],
  'in-page-audit': ['In-Page Audit', ACCENT.blue],
  bdc_review_accepted: ['Rule Approved', ACCENT.green],
  bdc_review_rejected: ['Rule Rejected', ACCENT.maroon],
  bdc_review_failed_rows_downloaded: ['Failed Rows Downloaded', ACCENT.blue],
  bdc_review_failed_rows_viewed: ['Failed Rows Viewed', ACCENT.violet],
  streamsets_secret_viewed: ['Secret Viewed', ACCENT.maroon],
  communication_sent: ['Communication Sent', ACCENT.green],
  communication_test_sent: ['Communication Test', ACCENT.gray],
  communication_template_created: ['Template Created', ACCENT.blue],
  communication_template_updated: ['Template Updated', ACCENT.orange],
  communication_template_deleted: ['Template Deleted', ACCENT.maroon],
};

const CAT_NAMES = ['Roles', 'Access', 'Data', 'Navigation', 'Admin'];
const CATS = {
  Roles: { c: ACCENT.red, icon: leaderIcon },
  Access: { c: ACCENT.green, icon: loginIcon },
  Data: { c: ACCENT.blue, icon: databaseIcon },
  Navigation: { c: ACCENT.violet, icon: globeIcon },
  Admin: { c: ACCENT.orange, icon: shieldIcon },
};

// Mirrors _CATEGORY_SQL in backend/audit.py — if you add a bucket there, add it here.
const categoryOf = (action = '') => {
  if (action.startsWith('role_')) return 'Roles';
  if (['user_login', 'user_logout', 'session_timeout'].includes(action)) return 'Access';
  if (action.startsWith('audit_')) return 'Admin';
  if (action.startsWith('page_') || action.startsWith('in-page')) return 'Navigation';
  return 'Data';
};

// Events normally take their category's colour and icon; these read better
// with their own (a logout or timeout isn't a "green" sign-in).
const ACTION_LOOK = {
  user_logout: { c: ACCENT.red, icon: logoutIcon },
  session_timeout: { c: ACCENT.orange, icon: timerIcon },
};
const colorOf = (action = '') => ACTION_LOOK[action]?.c || CATS[categoryOf(action)].c;
const iconOf = (action = '') => ACTION_LOOK[action]?.icon || CATS[categoryOf(action)].icon;

// Mirrors _SENSITIVE_ACTIONS in backend/audit.py.
const SENSITIVE = new Set(['role_deleted', 'role_removed', 'streamsets_secret_viewed', 'audit_log_deleted', 'audit_edit_mode_accessed']);

const ACRONYMS = new Set(['bdc', 'ai', 'api', 'csv', 'dq', 'dqe', 'it', 'id', 'url', 'sql', 's3', 'rag', 'vr', 'epod', 'fda', 'prd', 'qa', 'dev', 'ui', 'pdf', 'rim', 'gra', 'nipo', 'immbot', 'haq', 'mcp']);
const prettify = (key = '') => key.toLowerCase().split(/[_\-\s]+/).filter(Boolean)
  .map(w => (ACRONYMS.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
const metaFor = (action = '') => ACTION_META[action] || ACTION_META[action.toLowerCase()] || [prettify(action), ACCENT.gray];

const RANGE_LABEL = { '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days', all: 'all time' };

// ─── small helpers ──────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
// 12-hour clock everywhere on the page: 9:05:12 PM, and hour labels like 9 PM.
const hhmmss = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) : '—');
// The same time split up so the seconds sit small after the minutes: 10:10:05 PM
const timeParts = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const [hms, ap] = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).split(' ');
  const cut = hms.lastIndexOf(':');
  return { hm: hms.slice(0, cut), ss: hms.slice(cut), ap };
};
const Clock = ({ iso }) => {
  const t = timeParts(iso);
  if (!t) return '—';
  return <>{t.hm}<span className="ms">{t.ss}</span> {t.ap}</>;
};
const hr12 = (h) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const hrRange = (h) => `${h % 12 || 12}:00 – ${h % 12 || 12}:59 ${h < 12 ? 'AM' : 'PM'}`;
const relTime = (iso) => {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`;
};
const dayLabel = (iso) => {
  const d = new Date(iso), today = new Date(), yest = new Date();
  yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' });
};
const initialsOf = (name = '') => {
  const base = name.includes('@') ? name.split('@')[0] : name;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || '?';
  return (words[0][0] + words[1][0]).toUpperCase();
};
const AVATAR_INK = [ACCENT.blue, ACCENT.green, ACCENT.violet, ACCENT.maroon, ACCENT.orange, ACCENT.gray];
const avatarInk = (email = '') => {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) % 997;
  return AVATAR_INK[h % AVATAR_INK.length];
};
const plural = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString()} ${n === 1 ? one : many}`;

// Hour buckets on the server are Eastern, so the dial reads the clock in Eastern too.
const EASTERN_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const easternParts = (d = new Date()) => {
  const p = Object.fromEntries(EASTERN_FMT.formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, minute: +p.minute, second: +p.second };
};

const readStore = (store, key) => { try { return window[store].getItem(key); } catch { return null; } };
const writeStore = (store, key, v) => { try { window[store].setItem(key, v); } catch { /* private mode */ } };
// Note: prefers-reduced-motion is deliberately not used to switch animations
// off. Windows Cloud PCs report it by default (OS animations are off there);
// the welcome screens keep animating on them, and so does this page.

// ─── fetching ───────────────────────────────────────────────────────────────

class RequestError extends Error {
  constructor(message, status) { super(message); this.name = 'RequestError'; this.status = status; }
}

const withQuery = (path, qs, extra = {}) => {
  const p = new URLSearchParams(qs);
  Object.entries(extra).forEach(([k, v]) => p.set(k, String(v)));
  const s = p.toString();
  return s ? `${path}?${s}` : path;
};

async function getJson(path, signal) {
  const res = await apiFetch(path, { signal });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.detail || ''; } catch { /* not JSON */ }
    throw new RequestError(typeof detail === 'string' && detail ? detail : `${res.status} ${res.statusText}`, res.status);
  }
  try {
    return await res.json();
  } catch {
    throw new RequestError('The server sent an unexpected response.', 502);
  }
}

const isAbort = (e) => e?.name === 'AbortError';

// What a person should read when a request fails. null means "say nothing":
// the app is already redirecting to sign-in.
function describeError(err) {
  if (!err) return '';
  if (err.redirecting) return null;
  if (err.status === 401) return 'Your session has expired. Sign in again to continue.';
  if (err.status === 403) return 'You don’t have permission to do that.';
  if (err.status === 404) return 'That entry no longer exists.';
  if (err.status === 503) return 'The audit database is unavailable right now. Try again in a minute.';
  if (err.status >= 500) return 'The server hit a problem. Try again in a moment.';
  if (err instanceof TypeError) return 'Couldn’t reach the server. Check your connection and try again.';
  return err.message || 'Something went wrong.';
}

// One request per input change, the previous one cancelled, the last good
// data kept on screen while the next loads (so filters never flash empty).
function useResource(load, deps, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled, sig: null });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) return undefined;
    const ctl = new AbortController();
    const sig = JSON.stringify(deps);
    setState(s => ({ ...s, loading: true, error: null, sig }));
    loadRef.current(ctl.signal)
      .then(data => { if (!ctl.signal.aborted) setState({ data, error: null, loading: false, sig }); })
      .catch(error => { if (!ctl.signal.aborted && !isAbort(error)) setState(s => ({ ...s, error, loading: false, sig })); });
    return () => ctl.abort();
  }, [...deps, nonce, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => setNonce(n => n + 1), []);
  const setData = useCallback((fn) => setState(s => ({ ...s, data: typeof fn === 'function' ? fn(s.data) : fn })), []);
  return { ...state, reload, setData };
}

// Re-run fn every ms while the tab is visible, and once when it comes back.
function useVisiblePoll(fn, ms, enabled = true) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return undefined;
    const t = setInterval(() => { if (!document.hidden) fnRef.current(); }, ms);
    const onVis = () => { if (!document.hidden) fnRef.current(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [ms, enabled]);
}

// ─── styles (scoped under .al, injected once) ───────────────────────────────

const STYLE_ID = 'audit-log-styles';
const CSS = `
.al { --red:#eb1700; --maroon:#9e0000; --green:#328714; --blue:#0f68b2; --orange:#ff6017; --violet:#8c3bbb;
  --g1:#f1efed; --g2:#e8e6e3; --g3:#d5cfc9; --g4:#cbc4bc; --g5:#a39992; --g6:#81766f; --g7:#6e6259; --g8:#312c2a; --paper:#f1efed;
  --display:'JohnsonDisplay', Arial, sans-serif; --text:'JohnsonText', Arial, sans-serif;
  --ease:cubic-bezier(.16,1,.3,1); --soft:cubic-bezier(.22,1,.36,1); --card-shadow:0 18px 38px -30px rgba(49,44,42,.75);
  position:relative; height:100%; overflow:hidden; font-family:var(--text); color:var(--g8); background:var(--paper); }
.al *, .al *::before, .al *::after { box-sizing:border-box; }
/* only the weights we ship: 300, 400, 700 (bold tags would otherwise ask for 'bolder', e.g. 900) */
.al b, .al strong { font-weight:700; }
.al button { font:inherit; color:inherit; cursor:pointer; }
.al button:disabled { cursor:default; }
.al input, .al select { font:inherit; color:inherit; }
.al :focus-visible { outline:2px solid rgba(235,23,0,.55); outline-offset:2px; }
.al .scroll { height:100%; overflow:auto; overflow-x:hidden; scroll-behavior:smooth; }
/* thin scrollbars, audit log only: jj-gray-04 thumb, jj-gray-05 on hover */
.al, .al * { scrollbar-width:thin; scrollbar-color:var(--g4) transparent; }
.al :hover { scrollbar-color:var(--g5) transparent; }
.al ::-webkit-scrollbar { width:6px; height:6px; }
.al ::-webkit-scrollbar-track, .al ::-webkit-scrollbar-corner { background:transparent; }
.al ::-webkit-scrollbar-thumb { background:var(--g4); border-radius:9999px; }
.al ::-webkit-scrollbar-thumb:hover { background:var(--g5); }
.al .num { font-variant-numeric:tabular-nums; }
.al .ms { font-size:.72em; color:var(--g5); letter-spacing:.01em; }
.al .cap { font-size:10px; letter-spacing:.2em; text-transform:uppercase; color:var(--g7); }
.al .ic { display:inline-block; flex:none; width:16px; height:16px; background:currentColor;
  -webkit-mask:var(--i) center/contain no-repeat; mask:var(--i) center/contain no-repeat; }
.al .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }

@keyframes al-rise { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:none; } }
@keyframes al-soft { from { opacity:0; transform:translateY(12px); filter:blur(8px); } to { opacity:1; transform:none; filter:blur(0); } }
@keyframes al-soft-lite { from { opacity:0; transform:translateY(12px) scale(.985); } to { opacity:1; transform:none; } }
@keyframes al-sweep { to { transform:translateX(100%); } }
@keyframes al-fade { from { opacity:0; } to { opacity:1; } }
@keyframes al-ring { 0% { opacity:.6; transform:scale(.8); } 100% { opacity:0; transform:scale(2.1); } }
@keyframes al-halo { 0%,100% { opacity:.55; } 50% { opacity:.95; } }
@keyframes al-bar { from { transform:translateX(-100%); } to { transform:translateX(100%); } }
@keyframes al-spin { to { transform:rotate(360deg); } }
@keyframes al-flash { 0% { background:rgba(235,23,0,.10); } 100% { background:#fff; } }
@keyframes al-slidein { from { opacity:0; transform:translateY(-12px) scale(.985); } to { opacity:1; transform:none; } }
@keyframes al-pop { 0% { transform:scale(.6); opacity:0; } 70% { transform:scale(1.06); } 100% { transform:scale(1); opacity:1; } }

/* intro */
.al .intro { position:absolute; inset:0; z-index:90; display:grid; place-items:center; cursor:pointer;
  background:radial-gradient(80% 70% at 50% 50%, rgba(255,255,255,.97) 0%, rgba(241,239,237,.98) 70%);
  transition:opacity .9s var(--soft), visibility .9s; will-change:opacity; }
.al .intro.gone { opacity:0; visibility:hidden; pointer-events:none; }
.al .intro .box { display:flex; flex-direction:column; align-items:center; gap:24px; width:min(420px,78%); }
.al .intro .orb { position:relative; width:96px; height:96px; display:grid; place-items:center; }
.al .intro .orb i { position:absolute; inset:0; border-radius:50%; border:1px solid rgba(235,23,0,.45); animation:al-ring 2s ease-out infinite; }
.al .intro .orb i:nth-child(2) { border-color:rgba(15,104,178,.4); animation-delay:.66s; }
.al .intro .orb b { width:28px; height:28px; border-radius:8px; background:linear-gradient(140deg,var(--red),var(--violet));
  box-shadow:0 0 30px rgba(235,23,0,.45); animation:al-halo 1.6s ease-in-out infinite; }
.al .intro .step { font-family:var(--display); font-size:16px; letter-spacing:.02em; min-height:20px; }
.al .intro .track { position:relative; overflow:hidden; width:100%; height:2px; border-radius:9px; background:rgba(163,153,146,.35); }
.al .intro .track span { position:absolute; inset:0; background:linear-gradient(90deg,transparent,var(--red) 45%,var(--violet) 72%,transparent); animation:al-bar 1.15s ease-in-out infinite; }

/* top bar */
.al .topbar { position:sticky; top:0; z-index:30; height:60px; display:flex; align-items:center; gap:16px;
  padding:0 clamp(18px,3vw,44px); background:#fff; border-bottom:1px solid var(--g2); }
.al .brand { display:flex; align-items:center; gap:14px; min-width:0; padding:0; border:0; background:none; font:inherit; color:inherit; text-align:left; cursor:pointer; }
.al .brand img { width:96px; height:auto; display:block; }
.al .brand .sep { width:1px; height:28px; background:rgba(163,153,146,.6); }
.al .brand .t1 { font-family:var(--display); font-weight:700; font-size:13px; letter-spacing:.16em; text-transform:uppercase; }
.al .brand .t2 { font-size:9.5px; letter-spacing:.22em; text-transform:uppercase; color:var(--g7); margin-top:3px; }
.al .topbar .right { margin-left:auto; display:flex; align-items:center; gap:10px; }
.al .pill { display:inline-flex; align-items:center; gap:9px; height:32px; padding:0 13px; border-radius:999px; background:rgba(255,255,255,.8);
  border:1px solid rgba(110,98,89,.16); box-shadow:0 10px 26px -20px rgba(49,44,42,.6); font-size:10px; letter-spacing:.16em;
  text-transform:uppercase; color:var(--g7); white-space:nowrap; }
.al .pill.edit { color:var(--maroon); background:rgba(235,23,0,.05); border-color:rgba(235,23,0,.3); }
.al .dot { position:relative; width:7px; height:7px; border-radius:50%; background:var(--green); box-shadow:0 0 10px rgba(50,135,20,.55); flex:none; }
.al .dot::after { content:''; position:absolute; inset:0; border-radius:50%; border:1px solid rgba(50,135,20,.7); animation:al-ring 2.4s ease-out infinite; }
.al .dot.off { background:var(--g5); box-shadow:none; }
.al .dot.off::after { display:none; }
.al .switch { display:inline-flex; align-items:center; gap:8px; height:32px; padding:0 12px 0 8px; border-radius:999px; border:1px solid var(--g2);
  background:#fff; font-size:11px; color:var(--g7); transition:border-color .2s, background .2s, color .2s; }
.al .switch .knob { position:relative; width:26px; height:15px; border-radius:9px; background:var(--g3); transition:background .25s; }
.al .switch .knob::after { content:''; position:absolute; top:2px; left:2px; width:11px; height:11px; border-radius:50%; background:#fff;
  box-shadow:0 1px 3px rgba(0,0,0,.2); transition:transform .3s var(--ease); }
.al .switch.on { border-color:rgba(50,135,20,.35); background:rgba(50,135,20,.06); color:var(--green); }
.al .switch.on .knob { background:var(--green); }
.al .switch.on .knob::after { transform:translateX(11px); }
.al .btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; height:34px; padding:0 14px; border-radius:10px;
  border:1px solid var(--g2); background:#fff; font-size:12px; color:var(--g7); white-space:nowrap;
  transition:transform .25s var(--ease), box-shadow .25s, background .2s, border-color .2s, color .2s, opacity .2s; }
.al .btn:hover:not(:disabled) { background:var(--g1); color:var(--g8); }
.al .btn:disabled { opacity:.45; }
.al .btn.icon { width:34px; padding:0; }
/* Filters button while its panel is open */
.al .btn.filters.on { border-color:var(--red); background:var(--red); color:#fff; box-shadow:0 10px 22px -12px rgba(235,23,0,.6); }
.al .btn.filters.on:hover { background:var(--red); color:#fff; }
.al .btn.filters.on .badge-n { background:#fff; color:var(--red); }
.al .btn.solid { background:var(--red); border-color:var(--red); color:#fff; font-family:var(--display); font-weight:700; letter-spacing:.03em;
  box-shadow:0 14px 28px -14px rgba(235,23,0,.6); }
.al .btn.solid:hover:not(:disabled) { transform:translateY(-2px); box-shadow:0 20px 36px -16px rgba(235,23,0,.55); background:var(--red); color:#fff; }
.al .btn.danger { border-color:rgba(235,23,0,.3); background:rgba(235,23,0,.05); color:var(--maroon); }
.al .btn.danger:hover:not(:disabled) { background:rgba(235,23,0,.1); color:var(--maroon); }
.al .btn.spinning .ic { animation:al-spin .9s var(--ease) infinite; }
.al .spinner { width:13px; height:13px; border-radius:50%; border:2px solid rgba(255,255,255,.45); border-top-color:#fff; animation:al-spin .75s linear infinite; }

/* hero */
.al .hero { position:relative; height:clamp(250px,30vh,300px); overflow:hidden; border-bottom:1px solid var(--g2);
  background:linear-gradient(180deg,#ffffff 0%,#f1efed 100%); }
.al .hero::before { content:''; position:absolute; inset:0; pointer-events:none;
  background-image:radial-gradient(circle, rgba(163,153,146,.38) 1px, transparent 1.2px); background-size:22px 22px; }
.al .hero { contain:layout paint; }
.al .hero canvas { position:absolute; inset:0; width:100%; height:100%; display:block; transform:translateZ(0); }
.al .hero canvas.bg { pointer-events:none; opacity:0; transition:opacity 1.6s var(--soft); }
.al .hero canvas.bg.on { opacity:1; }
.al .hero .fx { position:absolute; inset:0; opacity:0; transition:opacity 1.6s var(--soft); }
.al .hero .fx.on { opacity:1; }
.al .hero .lanes { position:absolute; inset:0; pointer-events:none; }
.al .hero .pk { position:absolute; left:0; top:0; background-size:100% 100%; background-repeat:no-repeat; will-change:transform,opacity; pointer-events:none; }
.al .hero .dial { position:absolute; width:0; height:0; pointer-events:none; }
.al .hero .bar { position:absolute; left:calc(var(--R) * -.04); bottom:0; width:calc(var(--R) * .08); height:var(--blen); border-radius:99px;
  background:var(--red); opacity:.4; transform-origin:50% 100%; transition:transform 1.2s var(--soft), opacity .3s; }
.al .hero .bar.now { opacity:.85; }
.al .hero .bar.future { background:#a39992; opacity:.32; }
.al .hero .bar.hover { opacity:1; }
.al .hero .rings { position:absolute; left:0; top:0; }
.al .hero .hr { position:absolute; transform:translate(-50%,-50%); font-family:var(--text); font-size:max(9px, calc(var(--R) * .07)); line-height:1; color:#a39992; white-space:nowrap; padding:2px 6px; border-radius:99px; background:rgba(255,255,255,.94); }
.al .hero .hr.major { color:var(--g8); font-weight:700; }
.al .hero .half { position:absolute; left:0; top:calc(var(--R) * .3); transform:translate(-50%,-50%); font-family:var(--text); font-weight:700; font-size:max(8px, calc(var(--R) * .065)); letter-spacing:.18em; color:var(--red); line-height:1; }
.al .hero .ring { position:absolute; left:calc(var(--R) * -.96); top:calc(var(--R) * -.96); width:calc(var(--R) * 1.92); height:calc(var(--R) * 1.92);
  border-radius:50%; border:1.3px solid var(--c); will-change:transform,opacity;
  box-shadow:0 0 0 4px color-mix(in srgb, var(--c) 22%, transparent), inset 0 0 0 4px color-mix(in srgb, var(--c) 22%, transparent); }
.al .hero .ring.strong { border-width:1.8px; box-shadow:0 0 0 6px color-mix(in srgb, var(--c) 23%, transparent), inset 0 0 0 6px color-mix(in srgb, var(--c) 23%, transparent); }
.al .hero .breath { position:absolute; left:calc(-1 * (var(--core) + 3px)); top:calc(-1 * (var(--core) + 3px)); width:calc(var(--core) * 2 + 6px); height:calc(var(--core) * 2 + 6px);
  border-radius:50%; border:1px solid rgba(235,23,0,.22); animation:al-breath 3.6s ease-in-out infinite alternate; }
@keyframes al-breath { from { opacity:.35; transform:scale(1); } to { opacity:1; transform:scale(1.025); } }
.al .hero .hand { position:absolute; left:0; top:0; width:0; height:0; transition:transform 1s linear; }
.al .hero .hand i { position:absolute; left:-.8px; width:1.6px; border-radius:2px; top:calc(var(--R) * -.97); height:calc(var(--R) * .146); background:var(--red); }
.al .hero .hand b { position:absolute; width:6.4px; height:6.4px; left:-3.2px; top:calc(var(--R) * -.97 - 3.2px); border-radius:50%; background:var(--red);
  box-shadow:0 0 10px 3px rgba(235,23,0,.3); }
.al .hero .count { position:absolute; transform:translate(-50%,-50%); font-family:var(--display); line-height:1; white-space:nowrap; color:var(--g8); pointer-events:none;
  opacity:0; transition:opacity 1.2s var(--soft); }
.al .hero .count.on { opacity:1; }
.al .hero .veil { position:absolute; inset:0 auto 0 0; width:46%; pointer-events:none;
  background:linear-gradient(90deg, rgba(255,255,255,.9) 0%, rgba(255,255,255,.7) 55%, rgba(255,255,255,0) 100%); }
.al .hero-in { position:relative; height:100%; max-width:1580px; margin:0 auto; padding:0 clamp(18px,3vw,44px);
  display:flex; flex-direction:column; justify-content:center; align-items:flex-start; pointer-events:none; }
.al .hero-in > * { pointer-events:auto; opacity:0; }
.al .hero.play .hero-in > * { animation:al-soft 1.6s var(--soft) both; }
.al.lite .hero.play .hero-in > * { animation-name:al-soft-lite; }
.al .hero.play .hero-in > :nth-child(1) { animation-delay:.1s; }
.al .hero.play .hero-in > :nth-child(2) { animation-delay:.25s; }
.al .hero.play .hero-in > :nth-child(3) { animation-delay:.45s; }
.al .hero.play .hero-in > :nth-child(4) { animation-delay:.6s; }
.al .eyebrow { display:inline-flex; align-items:center; gap:10px; padding:7px 14px 7px 11px; border-radius:999px; background:rgba(255,255,255,.85);
  border:1px solid rgba(110,98,89,.24); box-shadow:0 12px 30px -22px rgba(49,44,42,.7); font-size:10px; letter-spacing:.22em; text-transform:uppercase; color:var(--blue); }
.al .eyebrow .dot { width:6px; height:6px; }
.al .hero h1 { font-family:var(--display); font-weight:700; font-size:clamp(30px,1.8vw + 1.6vh,46px); line-height:1; letter-spacing:-.03em; margin:clamp(12px,2vh,18px) 0 0; }
.al .hero h1 em { font-weight:300; color:var(--red); }
.al .hero .lede { font-weight:300; font-size:13px; line-height:1.55; color:var(--g7); max-width:400px; margin:12px 0 0; }
.al .online { display:flex; align-items:center; gap:10px; margin-top:16px; padding:0; border:0; background:none; font-size:12px; color:var(--g7); min-height:26px; }
.al .online .faces { display:flex; }
.al .online .faces .av { width:26px; height:26px; font-size:9.5px; margin-left:-6px; box-shadow:0 0 0 2px #ffffff; transition:transform .3s var(--ease); }
.al .online .faces .av:first-child { margin-left:0; }
.al .online .faces .av::after { display:none; }
.al .online:hover .faces .av { transform:translateY(-2px); }
.al .online b { color:var(--green); font-weight:400; }

/* command bar */
.al .cmd { position:sticky; top:60px; z-index:25; background:var(--paper); border-bottom:1px solid var(--g2); }
.al .cmd-in { max-width:1580px; margin:0 auto; padding:10px clamp(18px,3vw,44px); display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
.al .cmd-in + .cmd-in { padding-top:0; }
.al .tabs, .al .seg { position:relative; display:flex; gap:2px; padding:3px; }
.al .tabs { border-radius:12px; background:#fff; border:1px solid var(--g2); }
.al .tabs button { position:relative; z-index:1; display:inline-flex; align-items:center; gap:7px; height:30px; padding:0 14px; border:0; border-radius:9px;
  background:transparent; font-family:var(--display); font-size:13px; color:var(--g7); transition:color .3s var(--soft); }
.al .tabs button .ic { width:14px; height:14px; }
.al .tabs button.on { color:#fff; }
.al .ink { position:absolute; top:3px; bottom:3px; left:0; transition:transform .5s var(--soft), width .5s var(--soft); }
.al .tabs .ink { border-radius:9px; background:var(--red); box-shadow:0 8px 18px -8px rgba(235,23,0,.6); }
.al .seg { border-radius:999px; background:#fff; border:1px solid var(--g2); gap:2px; box-shadow:0 6px 16px -14px rgba(49,44,42,.5); }
.al .seg button { position:relative; z-index:1; height:28px; padding:0 13px; border:0; border-radius:999px; background:transparent; font-size:11.5px; color:var(--g7);
  transition:color .35s var(--soft); }
.al .seg button:hover:not(.on) { color:var(--g8); }
.al .seg button.on { color:#fff; transition-delay:.14s; }   /* turns white as the bud arrives */
/* the active "bud": a red pill with a soft top sheen that springs to its new spot */
.al .seg .ink { border-radius:999px; background:linear-gradient(180deg, rgba(255,255,255,.18), rgba(255,255,255,0) 60%), var(--red);
  box-shadow:0 6px 14px -6px rgba(235,23,0,.55), inset 0 1px 0 rgba(255,255,255,.25);
  transition:transform .6s cubic-bezier(.34,1.35,.5,1), width .6s cubic-bezier(.34,1.35,.5,1); }
.al .search { position:relative; flex:1 1 280px; min-width:220px; }
.al .search > .ic { position:absolute; left:13px; top:50%; margin-top:-8px; color:var(--g5); transition:color .2s; pointer-events:none; }
.al .search input { width:100%; height:38px; padding:0 70px 0 38px; border-radius:12px; border:1px solid var(--g2); background:#fff; outline:none;
  font-size:13px; transition:border-color .2s, box-shadow .25s; }
.al .search input:focus { border-color:var(--red); box-shadow:0 0 0 4px rgba(235,23,0,.08); }
.al .search:focus-within > .ic { color:var(--red); }
.al .kbd { display:inline-grid; place-items:center; min-width:20px; height:20px; padding:0 5px; border-radius:6px; border:1px solid var(--g3);
  border-bottom-width:2px; background:#fff; font-size:10.5px; color:var(--g7); }
.al .search > .kbd { position:absolute; right:10px; top:50%; margin-top:-10px; }
.al .search > .clear { position:absolute; right:38px; top:50%; margin-top:-11px; width:22px; height:22px; border:0; border-radius:6px; background:var(--g1);
  display:grid; place-items:center; color:var(--g7); }
.al .search > .clear .ic { width:10px; height:10px; }
.al .chips { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.al .chip { display:inline-flex; align-items:center; gap:7px; height:30px; padding:0 12px; border-radius:999px; border:1px solid var(--g2); background:#fff;
  font-size:12px; color:var(--g7); transition:all .3s var(--soft); }
.al .chip i { width:7px; height:7px; border-radius:50%; background:var(--c, var(--g5)); transition:background .3s; }
.al .chip b { font-weight:400; font-size:11px; color:var(--g5); }
.al .chip:hover { border-color:var(--c, var(--g4)); color:var(--g8); transform:translateY(-1px); }
.al .chip.on { background:var(--c, var(--g8)); border-color:var(--c, var(--g8)); color:#fff; box-shadow:0 10px 20px -12px var(--c, rgba(0,0,0,.5)); }
.al .chip.on i { background:#fff; }
.al .chip.on b { color:rgba(255,255,255,.82); }
.al .ap { position:relative; }
.al .ap-btn { display:inline-flex; align-items:center; gap:8px; height:30px; max-width:280px; padding:0 30px 0 12px; border-radius:999px; border:1px solid var(--g2);
  background:#fff; font-size:12px; color:var(--g7); position:relative; transition:border-color .25s, color .25s, box-shadow .25s; }
.al .ap-btn > span:first-of-type { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.al .ap-btn::after { content:''; position:absolute; right:13px; top:50%; margin-top:-4px; width:5px; height:5px; border-right:1.5px solid var(--g5);
  border-bottom:1.5px solid var(--g5); transform:rotate(45deg); transition:transform .3s var(--soft); }
.al .ap.open .ap-btn::after { transform:translateY(2px) rotate(-135deg); }
.al .ap-btn:hover, .al .ap.open .ap-btn { border-color:var(--g4); color:var(--g8); }
.al .ap-btn.on { border-color:var(--c); color:var(--g8); padding-right:52px; }
.al .ap-btn.on > i { width:7px; height:7px; border-radius:50%; background:var(--c); flex:none; }
.al .ap-x { position:absolute; right:26px; top:50%; margin-top:-9px; width:18px; height:18px; border-radius:50%; display:grid; place-items:center; background:var(--g1); color:var(--g7); }
.al .ap-x .ic { width:8px; height:8px; }
.al .ap-x:hover { background:var(--red); color:#fff; }
.al .ap-pop { position:absolute; left:0; top:calc(100% + 8px); z-index:40; width:320px; border-radius:16px; background:#fff; border:1px solid var(--g2);
  box-shadow:0 24px 48px -20px rgba(49,44,42,.45); overflow:hidden; animation:al-pop-in .28s var(--soft) both; transform-origin:top left; }
@keyframes al-pop-in { from { opacity:0; transform:translateY(-6px) scale(.98); } to { opacity:1; transform:none; } }
.al .ap-search { position:relative; padding:10px; border-bottom:1px solid var(--g2); }
.al .ap-search .ic { position:absolute; left:21px; top:50%; margin-top:-6.5px; color:var(--g5); }
.al .ap-search input { width:100%; height:34px; padding:0 12px 0 32px; border-radius:10px; border:1px solid var(--g2); background:var(--g1); outline:none; font-size:12.5px; }
.al .ap-search input:focus { border-color:var(--red); background:#fff; }
.al .ap-list { max-height:min(360px, 50vh); overflow:auto; padding:6px; overscroll-behavior:contain; }
.al .ap-h { position:sticky; top:-6px; z-index:1; display:flex; align-items:center; gap:8px; padding:10px 10px 6px; background:#fff;
  font-size:9.5px; letter-spacing:.18em; text-transform:uppercase; color:var(--g7); }
.al .ap-h i { width:7px; height:7px; border-radius:50%; background:var(--c); }
.al .ap-h b { margin-left:auto; font-weight:400; letter-spacing:0; color:var(--g5); }
.al .ap-o { display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:9px; font-size:12.5px; color:var(--g8); cursor:pointer; }
.al .ap-o span:first-child { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.al .ap-o.hi { background:var(--g1); }
.al .ap-o.sel { color:var(--red); }
.al .ap-tick { color:var(--red); font-size:12px; }
.al .ap-empty { padding:16px 10px; font-size:12px; color:var(--g7); }
/* search suggestions */
.al .sg { position:relative; }
.al .sg-pop { position:absolute; left:0; right:0; top:calc(100% + 8px); z-index:45; min-width:300px; max-height:min(420px, 60vh); overflow:auto; overscroll-behavior:contain;
  padding:6px; border-radius:16px; background:#fff; border:1px solid var(--g2); box-shadow:0 24px 48px -20px rgba(49,44,42,.45);
  animation:al-pop-in .28s var(--soft) both; transform-origin:top left; }
.al .sg-g + .sg-g { margin-top:4px; padding-top:4px; border-top:1px solid var(--g1); }
.al .sg-h { display:flex; align-items:center; gap:8px; padding:8px 10px 5px; font-size:9.5px; letter-spacing:.18em; text-transform:uppercase; color:var(--g7); }
.al .sg-h button { margin-left:auto; border:0; background:none; padding:0; font:inherit; letter-spacing:.08em; color:var(--g5); cursor:pointer; }
.al .sg-h button:hover { color:var(--red); }
.al .sg-o { display:flex; align-items:center; gap:10px; padding:7px 10px; border-radius:10px; font-size:12.5px; color:var(--g8); cursor:pointer;
  transition:background-color .18s; }
.al .sg-o.hi { background:var(--g1); }
.al .sg-o.hi .sg-ic { background:#fff; }
.al .sg-ic { flex:none; width:24px; height:24px; border-radius:8px; display:grid; place-items:center; background:var(--g1); color:var(--g7); transition:background-color .18s; }
.al .sg-ic i { width:8px; height:8px; border-radius:50%; background:var(--c); }
.al .sg-o .av { flex:none; width:24px; height:24px; font-size:9px; }
.al .sg-t { flex:1; min-width:0; display:flex; flex-direction:column; }
.al .sg-t > span, .al .sg-t small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.al .sg-t small { font-size:11px; color:var(--g5); }
.al .sg-t mark { background:none; color:var(--red); font-weight:700; }
.al .sg-m { flex:none; font-size:11px; color:var(--g5); }
.al .sg-foot { display:flex; align-items:center; gap:4px; margin-top:4px; padding:8px 10px 4px; border-top:1px solid var(--g1); font-size:10.5px; color:var(--g5); }
.al .sg-foot .kbd { min-width:18px; height:18px; font-size:10px; margin-left:4px; }
.al .sg-foot .kbd:first-child { margin-left:0; }
.al .adv.open > div { animation:al-unclip 0s .5s both; }
@keyframes al-unclip { to { overflow:visible; } }
.al .badge-n { display:inline-grid; place-items:center; min-width:18px; height:18px; padding:0 5px; border-radius:9px; background:var(--red); color:#fff; font-size:10px; }
.al .adv { display:grid; grid-template-rows:0fr; transition:grid-template-rows .5s var(--soft), border-color .3s; border-top:1px solid transparent; }
.al .adv > div { overflow:hidden; }
.al .adv.open { grid-template-rows:1fr; border-top-color:var(--g2); }
.al .adv-in { max-width:1580px; margin:0 auto; padding:10px clamp(18px,3vw,44px); display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
.al .field { height:34px; padding:0 12px; border-radius:10px; border:1px solid var(--g2); background:#fff; outline:none; font-size:12px; transition:border-color .2s; }
.al .field:focus { border-color:var(--red); }
.al .views { margin-left:auto; display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.al .views button { height:28px; padding:0 12px; border-radius:999px; border:1px dashed var(--g4); background:transparent; font-size:11.5px; color:var(--g7); transition:all .2s; }
.al .views button:hover { border-style:solid; border-color:var(--red); color:var(--red); background:#fff; }
.al .progress { position:absolute; left:0; right:0; bottom:-1px; height:2px; overflow:hidden; opacity:0; transition:opacity .3s; }
.al .progress.on { opacity:1; }
.al .progress span { position:absolute; inset:0; background:linear-gradient(90deg,transparent,var(--red) 45%,var(--violet) 72%,transparent); transform:translateX(-100%); }
.al .progress.on span { animation:al-bar 1.15s ease-in-out infinite; }

/* layout */
.al .wrap { max-width:1580px; margin:0 auto; padding:22px clamp(18px,3vw,44px) 40px; }
.al .stream-grid { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:22px; align-items:start; }
.al .card { background:#fff; border:1px solid var(--g2); border-radius:18px; box-shadow:var(--card-shadow); }
.al .card-h { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:16px 18px 0; }
.al .card-b { padding:14px 18px 18px; }
.al .muted { font-size:12px; color:var(--g7); }
.al .summary { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:14px; }
.al .summary .count { font-family:var(--display); font-weight:300; font-size:26px; letter-spacing:-.02em; line-height:1; margin-right:4px; }
.al .summary .of { font-size:12px; color:var(--g7); margin-right:6px; }
.al .summary .spacer { flex:1; }
.al .tag { display:inline-flex; align-items:center; gap:6px; height:26px; padding:0 6px 0 10px; border-radius:999px; background:#fff; border:1px solid var(--g2);
  font-size:11.5px; color:var(--g8); animation:al-pop .35s var(--ease) both; max-width:260px; }
.al .tag span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.al .tag button { flex:none; width:18px; height:18px; border:0; border-radius:50%; background:var(--g1); display:grid; place-items:center; color:var(--g7); padding:0; }
.al .tag button .ic { width:8px; height:8px; }
.al .tag button:hover { background:var(--red); color:#fff; }
.al .linkbtn { border:0; background:none; padding:0; font-size:12px; color:var(--red); }
.al .linkbtn:hover { text-decoration:underline; }
.al .banner { display:flex; align-items:center; gap:12px; padding:12px 16px; margin-bottom:14px; border-radius:14px;
  background:repeating-linear-gradient(-45deg,rgba(235,23,0,.04) 0 12px,rgba(235,23,0,.07) 12px 24px); border:1px solid rgba(235,23,0,.3); color:var(--maroon); font-size:12px;
  animation:al-rise .5s var(--ease) both; }
.al .banner .grow { flex:1; }
.al .inline-err { display:flex; align-items:center; gap:10px; padding:10px 14px; margin-bottom:14px; border-radius:12px; background:rgba(235,23,0,.05);
  border:1px solid rgba(235,23,0,.25); color:var(--maroon); font-size:12px; }
.al .inline-err .grow { flex:1; }

/* timeline */
.al .group { margin-bottom:22px; }
.al .group-h { position:sticky; top:var(--al-stick,160px); z-index:5; display:flex; align-items:center; gap:12px; padding:8px 0 10px;
  background:linear-gradient(180deg,var(--paper) 70%,rgba(241,239,237,0)); }
.al .group-h .gl { font-family:var(--display); font-weight:400; font-size:15px; }
.al .group-h .gs { font-size:10px; letter-spacing:.2em; text-transform:uppercase; color:var(--g5); }
.al .group-h .line { flex:1; height:1px; background:linear-gradient(90deg,var(--g3),transparent); }
.al .group-h .gc { font-size:11px; color:var(--g7); }
.al .group-h .av { width:26px; height:26px; font-size:10px; }
.al .tl { position:relative; transition:opacity .35s var(--soft); }
.al .tl.dim { opacity:.5; pointer-events:none; }
.al .tl::before { content:''; position:absolute; left:87px; top:6px; bottom:6px; width:2px; border-radius:2px; background:linear-gradient(180deg,var(--g2),var(--g3) 50%,var(--g2)); }
.al .row { position:relative; display:grid; grid-template-columns:74px 28px minmax(0,1fr); align-items:center; margin-bottom:8px;
  animation:al-rise .6s var(--soft) both; scroll-margin-top:calc(var(--al-stick,160px) + 48px); scroll-margin-bottom:24px; }
.al .row .when { text-align:right; padding-right:2px; }
.al .row .when .t { font-size:12px; color:var(--g8); }
.al .row .when .r { font-size:10.5px; color:var(--g5); margin-top:2px; }
.al .row .node { position:relative; justify-self:center; width:12px; height:12px; border-radius:50%; background:#fff; border:2.5px solid var(--c);
  transition:transform .35s var(--ease), box-shadow .35s; }
.al .row:hover .node, .al .row.sel .node { transform:scale(1.35); box-shadow:0 0 0 5px color-mix(in srgb, var(--c) 16%, transparent); }
.al .row.sens .node { background:var(--c); }
.al .ev { position:relative; display:grid; grid-template-columns:34px minmax(0,1fr) minmax(0,210px) 14px; align-items:center; gap:14px; width:100%;
  padding:11px 14px 11px 12px; border-radius:14px; background:#fff; border:1px solid var(--g2); overflow:hidden; text-align:left;
  transition:transform .35s var(--soft), box-shadow .35s, border-color .25s, background .25s; }
.al .ev::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--c); opacity:0; transition:opacity .25s; }
.al .ev:hover { transform:translateX(4px); border-color:color-mix(in srgb, var(--c) 40%, var(--g2)); box-shadow:0 16px 32px -24px rgba(49,44,42,.6); }
.al .ev:hover::before, .al .row.sel .ev::before, .al .row.kf .ev::before { opacity:1; }
.al .row.sel .ev { border-color:var(--c); box-shadow:0 16px 34px -22px color-mix(in srgb, var(--c) 60%, transparent); background:color-mix(in srgb, var(--c) 4%, #fff); }
.al .row.kf .ev { outline:2px solid color-mix(in srgb, var(--c) 45%, transparent); outline-offset:2px; }
.al .row.fresh { animation:al-slidein .7s var(--soft) both; }
.al .row.fresh .ev { animation:al-flash 2.8s ease-out both; }
.al .ev .badge { width:34px; height:34px; border-radius:10px; display:grid; place-items:center; background:color-mix(in srgb, var(--c) 9%, #fff); color:var(--c); }
.al .ev .main { min-width:0; }
.al .ev .top { display:flex; align-items:center; gap:8px; min-width:0; }
.al .ev .lbl { font-family:var(--display); font-weight:400; font-size:14px; color:var(--c); white-space:nowrap; }
.al .ev .tgt { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:1px 8px; border-radius:6px; background:var(--g1);
  border:1px solid var(--g2); font-size:11px; color:var(--g7); }
.al .ev .flag { flex:none; display:inline-flex; align-items:center; gap:4px; height:18px; padding:0 7px; border-radius:999px; font-size:9.5px; letter-spacing:.1em;
  text-transform:uppercase; color:var(--maroon); background:rgba(235,23,0,.08); border:1px solid rgba(235,23,0,.22); }
.al .ev .flag .ic { width:9px; height:9px; }
.al .ev .new { flex:none; height:18px; padding:0 7px; border-radius:999px; font-size:9.5px; letter-spacing:.12em; text-transform:uppercase; color:#fff;
  background:var(--red); display:inline-flex; align-items:center; }
.al .ev .det { margin-top:4px; font-size:12px; color:var(--g7); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.al .ev mark { background:rgba(251,224,88,.55); color:inherit; border-radius:3px; padding:0 1px; }
.al .ev .who { display:flex; align-items:center; gap:10px; min-width:0; }
.al .ev .who .n { font-size:12px; font-weight:400; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.al .ev .who .e { font-size:10.5px; color:var(--g5); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:1px; }
.al .ev .chev { width:10px; height:10px; color:var(--g4); transition:transform .3s var(--ease), color .2s; }
.al .ev:hover .chev { transform:translateX(3px); color:var(--c); }
.al .row .pick { position:absolute; left:-30px; top:50%; margin-top:-9px; width:18px; height:18px; accent-color:var(--red); cursor:pointer; }
.al .stream-col.editing { padding-left:30px; }
.al .av { position:relative; flex:none; width:30px; height:30px; border-radius:50%; display:inline-grid; place-items:center; overflow:visible;
  font-family:var(--display); font-weight:400; font-size:11px; color:var(--ink); background:color-mix(in srgb, var(--ink) 12%, #fff); }
.al .av img { width:100%; height:100%; border-radius:50%; object-fit:cover; display:block; }
.al .av.on::after { content:''; position:absolute; right:-1px; bottom:-1px; width:9px; height:9px; border-radius:50%; background:var(--green); border:2px solid #fff; }
.al .av.sm { width:20px; height:20px; font-size:8px; }
.al .av.sm::after { width:7px; height:7px; border-width:1.5px; }
.al .skel { position:relative; overflow:hidden; border-radius:14px; border:1px solid var(--g2); background:#fff; }
.al .skel::after { content:''; position:absolute; inset:0; background:linear-gradient(90deg,transparent,var(--g1) 50%,transparent); transform:translateX(-100%); animation:al-sweep 1.3s linear infinite; animation-delay:inherit; will-change:transform; }
.al .skel-row { height:60px; margin:0 0 8px 102px; }
.al .skel-line { height:12px; border-radius:6px; margin-bottom:10px; }
.al .empty { text-align:center; padding:56px 24px; border:1px dashed var(--g3); border-radius:18px; background:#fff; animation:al-rise .6s var(--ease) both; }
.al .empty .big { font-family:var(--display); font-weight:300; font-size:28px; color:var(--g7); }
.al .empty p { color:var(--g7); font-size:13px; margin:10px auto 20px; max-width:440px; line-height:1.5; }
.al .empty .acts { display:flex; justify-content:center; gap:8px; }
.al .empty .orbit { width:70px; height:70px; margin:0 auto 18px; border-radius:50%; border:1px dashed var(--g4); position:relative; animation:al-spin 14s linear infinite; }
.al .empty .orbit::after { content:''; position:absolute; top:-4px; left:50%; margin-left:-4px; width:8px; height:8px; border-radius:50%; background:var(--red); }
.al .empty.err { border-style:solid; border-color:rgba(235,23,0,.3); }
.al .empty.err .orbit { border-color:rgba(235,23,0,.4); animation-duration:6s; }
.al .pager { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; padding:12px 0 12px 102px; }
.al .pager .pg { display:flex; align-items:center; gap:4px; }
.al .pager .pg button { min-width:32px; height:32px; padding:0 8px; border-radius:9px; border:1px solid transparent; background:transparent; font-size:12px; color:var(--g7); transition:all .2s; }
.al .pager .pg button:hover:not(:disabled) { background:#fff; border-color:var(--g2); }
.al .pager .pg button.on { background:var(--red); color:#fff; box-shadow:0 8px 16px -8px rgba(235,23,0,.6); }
.al .pager .pg button:disabled:not(.on) { opacity:.35; }
.al .newpill { position:absolute; left:50%; top:calc(var(--al-stick,160px) + 14px); z-index:26; transform:translate(-50%,-20px); opacity:0; pointer-events:none;
  display:inline-flex; align-items:center; gap:8px; height:34px; padding:0 16px; border-radius:999px; border:0; background:var(--g8); color:#fff;
  font-size:12px; box-shadow:0 16px 30px -14px rgba(0,0,0,.5); transition:all .5s var(--soft); }
.al .newpill.show { transform:translate(-50%,0); opacity:1; pointer-events:auto; }
.al .newpill i { width:6px; height:6px; border-radius:50%; background:var(--red); }

/* rail */
.al .rail { position:sticky; top:calc(var(--al-stick,160px) + 16px); display:flex; flex-direction:column; gap:14px;
  max-height:calc(var(--al-h,100vh) - var(--al-stick,160px) - 32px); overflow-y:auto; overscroll-behavior:contain;
  margin:-6px -10px; padding:6px 10px 12px; }
.al .rail .card { flex-shrink:0; }
.al .rail .card { animation:al-rise .7s var(--soft) both; }
.al .prow { display:flex; align-items:center; gap:10px; width:100%; padding:7px 8px; border:0; border-radius:10px; background:transparent; text-align:left; transition:background .2s; }
.al .prow:hover { background:var(--g1); }
.al .prow .n { font-size:12px; font-weight:400; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.al .prow .e { font-size:10.5px; color:var(--g5); margin-top:1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.al .donut { display:grid; grid-template-columns:120px 1fr; gap:16px; align-items:center; }
.al .donut svg { transform:rotate(-90deg); overflow:visible; display:block; }
.al .donut circle.seg { fill:none; stroke-width:14; cursor:pointer; transition:stroke-dasharray 1.2s var(--soft), stroke-width .25s; }
.al .donut circle.seg:hover { stroke-width:18; }
.al .donut .mid { position:relative; justify-self:center; }
.al .donut .mid .lbl { position:absolute; inset:0; display:grid; place-items:center; text-align:center; pointer-events:none; }
.al .donut .mid .lbl b { display:block; font-family:var(--display); font-weight:300; font-size:24px; line-height:1; }
.al .donut .mid .lbl span { font-size:9px; letter-spacing:.18em; text-transform:uppercase; color:var(--g7); }
.al .mix-list { display:flex; flex-direction:column; gap:6px; }
.al .mix-list button { display:flex; align-items:center; gap:8px; border:0; background:none; padding:3px 0; text-align:left; font-size:12px; color:var(--g7); }
.al .mix-list button:hover { color:var(--g8); }
.al .mix-list i { width:8px; height:8px; border-radius:3px; background:var(--c); }
.al .mix-list b { margin-left:auto; font-weight:400; color:var(--g8); }
.al .bars { display:flex; flex-direction:column; gap:11px; }
.al .barrow { display:block; width:100%; border:0; background:none; padding:0; text-align:left; }
.al .barrow .top { display:flex; align-items:center; gap:8px; margin-bottom:5px; font-size:12px; }
.al .barrow .top .nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; transition:color .2s; }
.al .barrow .top b { font-weight:400; color:var(--g7); }
.al .barrow .top .sw { width:8px; height:8px; border-radius:3px; background:var(--c); flex:none; }
.al .barrow .track { height:5px; border-radius:5px; background:var(--g1); overflow:hidden; }
.al .barrow .fill { height:100%; border-radius:5px; background:var(--c, var(--red)); transform-origin:left; transition:transform 1.2s var(--soft); }
.al .barrow:hover .nm { color:var(--red); }
.al .watch { display:flex; flex-direction:column; gap:8px; }
.al .watch button { display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:12px; border:1px solid rgba(235,23,0,.18); background:rgba(235,23,0,.03); text-align:left;
  transition:transform .3s var(--soft), border-color .2s; }
.al .watch button:hover { transform:translateX(3px); border-color:var(--red); }
.al .watch .ic { color:var(--maroon); width:14px; height:14px; }
.al .watch .w1 { font-size:12px; font-weight:400; color:var(--maroon); }
.al .watch .w2 { font-size:10.5px; color:var(--g7); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.al .ok { display:flex; align-items:center; gap:10px; font-size:12px; color:var(--g7); }

/* analytics */
.al .an-grid { display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); gap:18px; }
.al .an-grid > .card { display:flex; flex-direction:column; animation:al-rise .7s var(--soft) both; }
.al .an-grid > .card > .card-b { flex:1; display:flex; flex-direction:column; }
.al .span-8 { grid-column:span 8; } .al .span-4 { grid-column:span 4; } .al .span-7 { grid-column:span 7; } .al .span-5 { grid-column:span 5; } .al .span-12 { grid-column:span 12; }
.al .big-n { font-family:var(--display); font-weight:300; font-size:36px; line-height:1; letter-spacing:-.02em; }
.al .big-n small { font-family:var(--text); font-size:13px; color:var(--g7); letter-spacing:0; margin-left:4px; }
.al .hours { display:flex; align-items:flex-end; gap:4px; flex:1; min-height:150px; margin-top:16px; }
.al .hours span { flex:1; min-width:3px; border-radius:5px 5px 2px 2px; background:rgba(235,23,0,.35); transform-origin:bottom; transform:scaleY(0);
  transition:transform 1s var(--soft), background .2s; }
.al .hours.grown span { transform:scaleY(1); }
.al .hours span.now { background:var(--red); box-shadow:0 0 16px rgba(235,23,0,.4); }
.al .hours span.future { background:repeating-linear-gradient(-45deg,var(--g1) 0 4px,var(--g2) 4px 8px); }
.al .hours span:hover { background:var(--maroon); }
.al .axis { display:flex; gap:4px; margin-top:8px; font-size:10.5px; color:var(--g5); }
.al .axis span { flex:1; min-width:3px; white-space:nowrap; }
.al .area { position:relative; flex:1; min-height:200px; margin-top:14px; }
.al .area svg { position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
.al .area .line { fill:none; stroke:var(--red); stroke-width:2; vector-effect:non-scaling-stroke; stroke-linejoin:round; }
.al .area .reveal { transform-origin:left; transform:scaleX(0); transition:transform 1.4s var(--soft); }
.al .area.grown .reveal { transform:scaleX(1); }
.al .area .cross { position:absolute; top:0; bottom:0; width:1px; background:var(--g4); pointer-events:none; }
.al .area .pt { position:absolute; width:11px; height:11px; margin:-5.5px 0 0 -5.5px; border-radius:50%; background:#fff; border:2.5px solid var(--red); pointer-events:none; }
.al .area-axis { display:flex; justify-content:space-between; margin-top:8px; font-size:10.5px; color:var(--g5); }
.al .heat { display:flex; flex-direction:column; gap:3px; margin-top:14px; }
.al .heat .hrow { display:grid; grid-template-columns:30px repeat(24,minmax(0,1fr)); gap:3px; animation:al-rise .6s var(--soft) both; }
.al .heat .axis-row { animation-delay:.42s; }
.al .heat .hl { font-size:10px; color:var(--g5); display:flex; align-items:center; }
.al .heat .cell { aspect-ratio:1/1; border-radius:4px; background:var(--g1); transition:transform .2s var(--ease); }
.al .heat .cell:hover { transform:scale(1.4); outline:2px solid #fff; box-shadow:0 4px 10px rgba(0,0,0,.2); position:relative; z-index:2; }
.al .heat .hx { font-size:9.5px; color:var(--g5); white-space:nowrap; }
.al .scale { display:flex; align-items:center; gap:6px; font-size:10.5px; color:var(--g5); }
.al .scale i { width:12px; height:12px; border-radius:3px; }

/* people */
.al .people-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:16px; }
.al .person { position:relative; padding:18px; text-align:left; border-radius:18px; background:linear-gradient(160deg,#ffffff,#f1efed); border:1px solid rgba(110,98,89,.16);
  box-shadow:var(--card-shadow); animation:al-rise .6s var(--soft) both; transition:transform .35s var(--soft), border-color .35s, box-shadow .35s; overflow:hidden; }
.al .person:hover { transform:translateY(-6px); border-color:rgba(235,23,0,.45); box-shadow:0 28px 52px -26px rgba(235,23,0,.3); }
.al .person .hd { display:flex; align-items:center; gap:12px; padding-right:40px; }
.al .person .av { width:44px; height:44px; font-size:15px; }
.al .person .nm { font-family:var(--display); font-weight:400; font-size:16px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.al .person .em { font-size:11px; color:var(--g5); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.al .person .rank { position:absolute; top:14px; right:16px; font-family:var(--display); font-style:italic; font-weight:300; font-size:28px; color:var(--g3); transition:color .3s; }
.al .person:hover .rank { color:var(--red); }
.al .person .stats { display:flex; gap:22px; margin:16px 0 12px; }
.al .person .stats b { display:block; font-family:var(--display); font-weight:300; font-size:24px; line-height:1; }
.al .person .stats b.sm { font-size:16px; line-height:24px; }
.al .person .stats span { font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--g7); }
.al .person svg { width:100%; height:40px; display:block; }
.al .person .acts { display:flex; flex-wrap:wrap; gap:5px; margin-top:12px; }
.al .person .acts span { display:inline-flex; align-items:center; gap:5px; height:22px; padding:0 8px; border-radius:999px; background:var(--g1); font-size:10.5px; color:var(--g7); }
.al .person .acts i { width:6px; height:6px; border-radius:50%; background:var(--c); }
.al .skel-card { height:230px; border-radius:18px; }

/* drawer */
.al .scrim { position:absolute; inset:0; z-index:60; background:rgba(49,44,42,.18); opacity:0; visibility:hidden; transition:opacity .45s var(--soft), visibility .45s; }
.al .scrim.show { opacity:1; visibility:visible; }
.al .drawer { position:absolute; top:0; right:0; bottom:0; z-index:61; width:min(480px,100%); background:#fff; border-left:1px solid var(--g2);
  box-shadow:-30px 0 60px -30px rgba(49,44,42,.4); transform:translateX(104%); visibility:hidden;
  transition:transform .6s var(--soft), visibility 0s linear .6s; will-change:transform; display:flex; flex-direction:column; outline:none; }
.al .drawer.show { transform:none; visibility:visible; transition:transform .6s var(--soft), visibility 0s; }
.al .dr-head { position:relative; padding:22px 24px 20px; overflow:hidden; border-bottom:1px solid var(--g2);
  background:linear-gradient(150deg, color-mix(in srgb, var(--c) 10%, #fff), #fff 70%); }
.al .dr-head::after { content:''; position:absolute; right:-60px; top:-60px; width:200px; height:200px; border-radius:50%; pointer-events:none;
  border:1px solid color-mix(in srgb, var(--c) 25%, transparent);
  box-shadow:0 0 0 30px color-mix(in srgb, var(--c) 5%, transparent), 0 0 0 60px color-mix(in srgb, var(--c) 3%, transparent); }
.al .dr-head .x { position:absolute; right:16px; top:16px; z-index:1; }
.al .dr-head .cat { display:inline-flex; align-items:center; gap:8px; font-size:10px; letter-spacing:.2em; text-transform:uppercase; color:var(--c); }
.al .dr-head .cat .ic { width:14px; height:14px; }
.al .dr-head h2 { font-family:var(--display); font-weight:700; font-size:28px; letter-spacing:-.02em; margin:10px 40px 4px 0; }
.al .dr-head .when { font-size:12px; color:var(--g7); }
.al .dr-head .when b { font-family:var(--display); font-weight:300; font-size:22px; color:var(--g8); margin-right:8px; }
.al .dr-body { flex:1; overflow:auto; padding:20px 24px; display:flex; flex-direction:column; gap:18px; }
.al .dr-body > * { flex-shrink:0; min-width:0; animation:al-rise .55s var(--soft) both; }
.al .dr-body > :nth-child(2) { animation-delay:.05s; } .al .dr-body > :nth-child(3) { animation-delay:.1s; }
.al .dr-body > :nth-child(4) { animation-delay:.15s; } .al .dr-body > :nth-child(5) { animation-delay:.2s; }
.al .whobox { display:flex; align-items:center; gap:12px; padding:12px; border-radius:14px; background:var(--g1); }
.al .whobox .av { width:42px; height:42px; font-size:14px; }
.al .whobox .n { font-weight:400; font-size:14px; }
.al .whobox .e { font-size:11.5px; color:var(--g7); margin-top:2px; word-break:break-all; }
.al .whobox .btn { margin-left:auto; height:30px; font-size:11px; }
.al .quote { font-size:14px; line-height:1.6; padding-left:14px; border-left:3px solid var(--c); word-break:break-word; }
.al .meta { display:grid; grid-template-columns:1.3fr 1fr 1fr; gap:1px; border-radius:14px; overflow:hidden; border:1px solid var(--g2); background:var(--g2); }
.al .meta div { background:#fff; padding:11px 13px; min-width:0; }
.al .meta .k { font-size:9.5px; letter-spacing:.18em; text-transform:uppercase; color:var(--g5); }
.al .meta .v { margin-top:4px; font-size:12px; word-break:break-all; }
.al .ctx { position:relative; display:flex; flex-direction:column; gap:2px; }
.al .ctx::before { content:''; position:absolute; left:7px; top:8px; bottom:8px; width:1.5px; background:var(--g2); }
.al .ctx button { position:relative; display:flex; align-items:center; gap:12px; padding:7px 8px 7px 0; border:0; background:none; text-align:left; border-radius:8px; }
.al .ctx button:hover:not(:disabled) { background:var(--g1); }
.al .ctx button i { position:relative; z-index:1; width:15px; height:15px; border-radius:50%; background:#fff; border:2.5px solid var(--c); flex:none; }
.al .ctx button.me i { background:var(--c); box-shadow:0 0 0 4px color-mix(in srgb, var(--c) 20%, transparent); }
.al .ctx .l { font-size:12px; font-weight:400; color:var(--c); white-space:nowrap; }
.al .ctx .d { font-size:11px; color:var(--g7); flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.al .ctx .t { font-size:10.5px; color:var(--g5); }
.al .dr-foot { display:flex; flex-wrap:wrap; gap:8px; padding:14px 24px; border-top:1px solid var(--g2); background:var(--paper); }
.al .dr-nav { margin-left:auto; display:flex; gap:6px; }
.al .dr-empty { flex:1; display:grid; place-items:center; padding:30px; text-align:center; }

/* floating bits */
.al .bulk { position:absolute; left:50%; bottom:24px; z-index:50; transform:translate(-50%,140px); display:flex; align-items:center; gap:14px; padding:10px 10px 10px 20px;
  border-radius:16px; background:var(--g8); color:#fff; box-shadow:0 24px 50px -20px rgba(0,0,0,.6); transition:transform .55s var(--soft); font-size:13px; }
.al .bulk.show { transform:translate(-50%,0); }
.al .bulk b { font-family:var(--display); font-weight:400; font-size:18px; }
.al .bulk .btn { height:32px; }
.al .bulk .btn.ghost { background:transparent; border-color:rgba(255,255,255,.2); color:#fff; }
.al .bulk .btn.ghost:hover:not(:disabled) { background:rgba(255,255,255,.08); color:#fff; }
.al .modal-bg { position:absolute; inset:0; z-index:80; display:grid; place-items:center; background:rgba(49,44,42,.28); opacity:0; visibility:hidden; transition:opacity .35s, visibility .35s; }
.al .modal-bg.show { opacity:1; visibility:visible; }
.al .modal { width:min(420px,90%); padding:26px; border-radius:20px; background:#fff; box-shadow:0 40px 80px -30px rgba(0,0,0,.5); transform:scale(.95) translateY(10px); transition:transform .45s var(--soft); }
.al .modal-bg.show .modal { transform:none; }
.al .modal .mi { width:48px; height:48px; border-radius:14px; display:grid; place-items:center; background:rgba(235,23,0,.08); color:var(--red); margin-bottom:16px; }
.al .modal .mi .ic { width:22px; height:22px; }
.al .modal h3 { font-family:var(--display); font-weight:700; font-size:20px; margin:0 0 6px; }
.al .modal p { font-size:13px; color:var(--g7); line-height:1.55; margin:0 0 22px; }
.al .modal .acts { display:flex; justify-content:flex-end; gap:8px; }
.al .keys { display:grid; grid-template-columns:auto 1fr; gap:10px 16px; align-items:center; font-size:13px; color:var(--g7); margin-bottom:20px; }
.al .keys > span:nth-child(odd) { display:flex; gap:4px; }
.al .toast { position:absolute; right:24px; bottom:24px; z-index:90; display:flex; align-items:center; gap:10px; padding:12px 16px; border-radius:14px; background:#fff;
  border:1px solid var(--g2); box-shadow:0 24px 40px -20px rgba(49,44,42,.5); font-size:12.5px; transform:translateY(20px); opacity:0; transition:all .45s var(--soft); pointer-events:none; max-width:min(420px,80%); }
.al .toast.show { transform:none; opacity:1; }
.al .toast > i { flex:none; width:20px; height:20px; border-radius:50%; background:var(--green); display:grid; place-items:center; color:#fff; font-style:normal; font-size:11px; }
.al .toast.bad > i { background:var(--red); }
.al .tip { position:fixed; z-index:95; pointer-events:none; padding:8px 11px; border-radius:10px; background:var(--g8); color:#fff; font-size:11.5px; line-height:1.4;
  box-shadow:0 12px 24px -10px rgba(0,0,0,.5); opacity:0; transform:translate(-50%, calc(-100% - 12px)); transition:opacity .15s; white-space:nowrap; left:0; top:0; }
.al .tip.show { opacity:1; }
.al .tip.wrap { white-space:normal; max-width:320px; overflow-wrap:anywhere; text-align:center; }
.al .tip.wrap b { font-weight:400; }
.al .tip .t2 { color:var(--g4); font-size:10.5px; }
.al .foot { max-width:1580px; margin:0 auto; padding:0 clamp(18px,3vw,44px) 30px; display:flex; flex-wrap:wrap; gap:14px; align-items:center; font-size:11px; color:var(--g5); }
.al .foot .kbd { margin:0 2px; }
.al .foot .r { margin-left:auto; }

@media (max-width:1180px) {
  .al .stream-grid { grid-template-columns:1fr; }
  .al .rail { position:static; display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); max-height:none; overflow:visible; margin:0; padding:0; }
  .al .span-8, .al .span-4, .al .span-7, .al .span-5 { grid-column:span 12; }
}
@media (max-width:900px) {
  .al .hero { height:auto; padding:28px 0 210px; }
  .al .hero .veil { width:100%; height:60%; background:linear-gradient(180deg, rgba(255,255,255,.92), rgba(255,255,255,0)); }
  .al .topbar .pill, .al .brand .sep, .al .brand .txt { display:none; }
  .al .ev { grid-template-columns:34px minmax(0,1fr) 14px; }
  .al .ev .who { display:none; }
  .al .tl::before { left:79px; }
  .al .row { grid-template-columns:66px 28px minmax(0,1fr); }
  .al .skel-row, .al .pager { margin-left:0; padding-left:0; }
}
`;

// styles must be in the DOM before the first paint, otherwise the drawer,
// scrim and bulk bar show unstyled for a frame and then animate out
function injectAuditStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const tag = document.createElement('style');
  tag.id = STYLE_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
injectAuditStyles();

function useAuditStyles() {
  // runs before layout effects and paint, covers HMR removing the tag
  useInsertionEffect(injectAuditStyles, []);
}

// ─── presentational bits ────────────────────────────────────────────────────

const Ic = ({ src, size, style, className = '' }) => (
  <span aria-hidden="true" className={`ic ${className}`}
    style={{ '--i': `url("${src}")`, ...(size ? { width: size, height: size } : null), ...style }} />
);

const Avatar = memo(function Avatar({ email = '', name, photo, online, small, className = '' }) {
  return (
    <span className={`av ${online ? 'on' : ''} ${small ? 'sm' : ''} ${className}`} style={{ '--ink': avatarInk(email) }} title={name || email}>
      {photo ? <img src={photo} alt="" /> : initialsOf(name || email)}
    </span>
  );
});

const Highlight = ({ text, q }) => {
  const s = String(text ?? '');
  if (!q) return s;
  const parts = s.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'));
  return parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <React.Fragment key={i}>{p}</React.Fragment>));
};

// A pill/segmented control whose highlight slides to the active option.
function SlidingInk({ wrapRef, activeKey, attr }) {
  const inkRef = useRef(null);
  useEffect(() => {
    const wrap = wrapRef.current, ink = inkRef.current;
    if (!wrap || !ink) return undefined;
    const place = () => {
      const btn = wrap.querySelector(`[${attr}="${activeKey}"]`);
      if (!btn) { ink.style.width = '0px'; return; }
      ink.style.width = `${btn.offsetWidth}px`;
      ink.style.transform = `translateX(${btn.offsetLeft - 3}px)`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(wrap);
    document.fonts?.ready.then(place).catch(() => {});
    return () => ro.disconnect();
  }, [wrapRef, activeKey, attr]);
  return <span className="ink" ref={inkRef} style={{ left: 3 }} />;
}

function Segmented({ options, value, onChange, label }) {
  const ref = useRef(null);
  return (
    <div className="seg" ref={ref} role="radiogroup" aria-label={label}>
      <SlidingInk wrapRef={ref} activeKey={value} attr="data-k" />
      {options.map(([k, text]) => (
        <button key={k} type="button" data-k={k} role="radio" aria-checked={value === k}
          className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{text}</button>
      ))}
    </div>
  );
}

// Grows from 0 on mount so charts animate in; false while reduced motion is on.
function useGrown(dep) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    setGrown(false);
    let r2;
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setGrown(true)); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  }, [dep]);
  return grown;
}

const SkeletonLines = ({ n = 4 }) => (
  <div aria-hidden="true">{Array.from({ length: n }, (_, i) => (
    <div key={i} className="skel skel-line" style={{ width: `${92 - i * 13}%` }} />
  ))}</div>
);

function ErrorCard({ error, onRetry, title = 'Couldn’t load audit events' }) {
  const msg = describeError(error);
  if (msg === null) return null;
  return (
    <div className="empty err" role="alert">
      <div className="orbit" />
      <div className="big">{title}</div>
      <p>{msg}</p>
      {onRetry && <div className="acts"><button type="button" className="btn solid" onClick={onRetry}>Try again</button></div>}
    </div>
  );
}

// ─── action type picker ─────────────────────────────────────────────────────
// Searchable, grouped by category in the category colours, keyboard-driven
// (arrows, Enter, Esc, type to filter). Replaces the native <select>, whose
// open list can't be styled and showed every action in one long column.

function ActionPicker({ value, options, unavailable, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const flat = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hits = options.filter(o => !needle || o.label.toLowerCase().includes(needle) || o.key.toLowerCase().includes(needle));
    const out = needle ? [] : [{ key: '', label: 'Any action type' }];
    CAT_NAMES.forEach(cat => {
      const items = hits.filter(o => categoryOf(o.key) === cat);
      if (items.length) out.push({ header: cat, n: items.length }, ...items);
    });
    return out;
  }, [options, q]);
  const choices = flat.filter(x => !x.header);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setQ('');
    const i = Math.max(0, options.findIndex(o => o.key === value) + (value ? 1 : 0));
    setHi(value ? i : 0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setHi(0); }, [q]);
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  const pick = (key) => { setOpen(false); if (key !== value) onChange(key); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(i => Math.min(choices.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (choices[hi]) pick(choices[hi].key); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); wrapRef.current?.querySelector('.ap-btn')?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  const current = value ? metaFor(value)[0] : unavailable ? 'Action types unavailable' : 'Any action type';
  let ci = -1;
  return (
    <div className={`ap ${open ? 'open' : ''}`} ref={wrapRef} onKeyDown={e => { if (open) onKey(e); }}>
      <button type="button" className={`ap-btn ${value ? 'on' : ''}`} aria-haspopup="listbox" aria-expanded={open}
        style={value ? { '--c': colorOf(value) } : undefined} onClick={() => setOpen(o => !o)}>
        {value && <i />}<span>{current}</span>
        {value && (
          <span className="ap-x" role="button" tabIndex={-1} aria-label="Clear action type"
            onClick={(e) => { e.stopPropagation(); onChange(''); }}><Ic src={closeIcon} /></span>
        )}
      </button>
      {open && (
        <div className="ap-pop">
          <div className="ap-search">
            <Ic src={searchIcon} size={13} />
            <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Find an action…" aria-label="Find an action"
              aria-controls="al-action-list" aria-activedescendant={choices[hi] ? `al-ap-${hi}` : undefined} autoComplete="off" />
          </div>
          <div className="ap-list" id="al-action-list" role="listbox" ref={listRef} aria-label="Action types">
            {choices.length === 0 && <div className="ap-empty">No actions match “{q}”.</div>}
            {flat.map((x) => {
              if (x.header) {
                return <div key={`h-${x.header}`} className="ap-h" style={{ '--c': CATS[x.header].c }}><i />{x.header}<b>{x.n}</b></div>;
              }
              ci += 1;
              const i = ci;
              return (
                <div key={x.key || 'any'} id={`al-ap-${i}`} data-i={i} role="option" aria-selected={x.key === value}
                  className={`ap-o ${i === hi ? 'hi' : ''} ${x.key === value ? 'sel' : ''}`}
                  onPointerMove={() => setHi(i)} onClick={() => pick(x.key)}>
                  <span>{x.label}</span>{x.key === value && <span className="ap-tick">✓</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── search suggestions ─────────────────────────────────────────────────────
// One dropdown used by every free-text box on the page. The caller builds the
// groups; this handles opening, arrows/Enter/Esc and keeping focus in the input
// while an option is clicked.

const RECENT_KEY = 'smarthub:audit-recent';
const readRecent = () => {
  try {
    const v = JSON.parse(readStore('localStorage', RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x).slice(0, 6) : [];
  } catch { return []; }
};

// people, targets and actions from the events currently in view (same filters
// as the stream), debounced and cached per term + filters for a short while
const suggestCache = new Map();
const SUGGEST_FRESH_MS = 30000;
function useServerSuggest(text, filters, enabled) {
  const url = `/api/audit/suggest?${new URLSearchParams({ ...filters, q: text.trim().toLowerCase() })}`;
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const hit = suggestCache.get(url);
    if (hit && Date.now() - hit.at < SUGGEST_FRESH_MS) { setData(hit.data); return undefined; }
    const ac = new AbortController();
    const t = setTimeout(() => {
      getJson(url, ac.signal)
        .then(d => {
          if (suggestCache.size > 200) suggestCache.clear();
          suggestCache.set(url, { at: Date.now(), data: d });
          setData(d);
        })
        .catch(() => { /* suggestions are a nicety — the search itself still works */ });
    }, 160);
    return () => { clearTimeout(t); ac.abort(); };
  }, [url, enabled]);
  return enabled ? data : null;
}

function Suggest({ id, label, className, groups, onEnter, children }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const wrapRef = useRef(null);
  const listRef = useRef(null);
  const items = useMemo(() => groups.flatMap(g => g.items), [groups]);
  const sig = items.map(i => i.id).join('|');
  const show = open && items.length > 0;

  useEffect(() => { setHi(-1); }, [sig]);
  useEffect(() => {
    if (hi >= 0) listRef.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const pick = (it) => { setOpen(false); setHi(-1); it.run(); };
  const onKeyDown = (e) => {
    if (e.target.tagName !== 'INPUT') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!show) setOpen(true); else setHi(i => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      if (!show) return;
      e.preventDefault();
      setHi(i => Math.max(-1, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (show && items[hi]) pick(items[hi]);
      else { setOpen(false); onEnter?.(); }
    } else if (e.key === 'Escape') {
      if (!show) return;
      e.preventDefault(); e.stopPropagation();
      setOpen(false);
    } else if (e.key === 'Tab') setOpen(false);
  };

  let n = -1;
  return (
    <div className={className} ref={wrapRef} onKeyDown={onKeyDown} onInput={() => setOpen(true)}
      onFocus={e => { if (e.target.tagName === 'INPUT') setOpen(true); }}
      onBlur={e => { if (!wrapRef.current?.contains(e.relatedTarget)) setOpen(false); }}>
      {children({
        role: 'combobox', 'aria-expanded': show, 'aria-controls': id, 'aria-autocomplete': 'list',
        'aria-activedescendant': show && hi >= 0 ? `${id}-${hi}` : undefined,
      })}
      {show && (
        <div className="sg-pop" id={id} role="listbox" aria-label={label} ref={listRef} onMouseDown={e => e.preventDefault()}>
          {groups.map(g => g.items.length > 0 && (
            <div key={g.title} className="sg-g" role="group" aria-label={g.title}>
              <div className="sg-h">{g.title}{g.extra}</div>
              {g.items.map(it => {
                n += 1;
                const i = n;
                return (
                  <div key={it.id} id={`${id}-${i}`} data-i={i} role="option" aria-selected={i === hi}
                    className={`sg-o ${i === hi ? 'hi' : ''}`} onPointerMove={() => { if (hi !== i) setHi(i); }} onClick={() => pick(it)}>
                    {it.lead}
                    <span className="sg-t"><span>{it.label}</span>{it.sub && <small>{it.sub}</small>}</span>
                    {it.meta != null && <span className="sg-m num">{it.meta}</span>}
                  </div>
                );
              })}
            </div>
          ))}
          <div className="sg-foot" aria-hidden="true"><span className="kbd">↑</span><span className="kbd">↓</span> to move <span className="kbd">↵</span> to pick <span className="kbd">esc</span> to close</div>
        </div>
      )}
    </div>
  );
}

const SgIcon = ({ src }) => <span className="sg-ic"><Ic src={src} size={12} /></span>;
const SgDot = ({ c }) => <span className="sg-ic"><i style={{ '--c': c }} /></span>;

// ─── tooltip (one element, moved directly, no re-renders on mousemove) ──────

function useTooltip() {
  const ref = useRef(null);
  return useMemo(() => ({
    ref,
    show(title, sub, x, y) {
      const el = ref.current;
      if (!el) return;
      el.replaceChildren();
      const b = document.createElement('b'); b.textContent = title; el.appendChild(b);
      if (sub) { const d = document.createElement('div'); d.className = 't2'; d.textContent = sub; el.appendChild(d); }
      el.style.left = `${x}px`; el.style.top = `${y}px`;
      el.classList.add('show');
    },
    hide() { ref.current?.classList.remove('show'); },
  }), []);
}

// ─── hero dial ──────────────────────────────────────────────────────────────
// Events travel five lanes (one per category) into a 24h dial whose bars are
// today's hourly volume.
//
// Built for GPU-less Cloud PCs. Nothing here is redrawn per frame:
//   - everything that never moves (lanes, halo, rings, labels, the core disc)
//     is painted once per resize onto one canvas;
//   - everything that moves is a small element animated only through
//     transform and opacity (Web Animations / CSS transitions), which the
//     browser's compositor moves on its own thread without repainting. Each
//     packet is one pre-rendered sprite (tail, glow and head together) sliding
//     along its lane, each arrival ring is one circle scaling out, the bars
//     grow with scaleY and flash with opacity.
// So the main thread is idle while the scene runs, and only the few small
// rectangles that actually move are touched each frame — on a CPU-only
// machine that is the difference between stutter and glide.

const LANE_Y = [0.17, 0.34, 0.49, 0.63, 0.8];
const GLIDE = 'cubic-bezier(.32,.12,.68,.88)';     // near-linear, soft at both ends
const RING_EASE = 'cubic-bezier(.22,1,.36,1)';

// Keep the big count inside the white disc: start at the full size and
// shrink to the disc width when the number is too wide.
const fitCount = (el) => {
  const fs = Number(el.dataset.fs), max = Number(el.dataset.max);
  if (!fs || !max) return;
  el.style.fontSize = `${fs}px`;
  const w = el.offsetWidth;
  if (w > max) el.style.fontSize = `${fs * max / w}px`;
};

const HeroDial = forwardRef(function HeroDial({ hourly, mix, started, scrollRoot, tip, onOpenAnalytics }, ref) {
  const bgRef = useRef(null);
  const fxRef = useRef(null);
  const countRef = useRef(null);
  const dataRef = useRef({ hourly, mix, today: 0 });
  const today = hourly.reduce((a, b) => a + b, 0);
  dataRef.current.hourly = hourly;
  dataRef.current.today = today;
  dataRef.current.mix = mix;
  const cbRef = useRef({ tip, onOpenAnalytics });
  cbRef.current = { tip, onOpenAnalytics };
  const engine = useRef({ start() {}, pulse() {}, update() {} });

  useImperativeHandle(ref, () => ({ pulse: (cat) => engine.current.pulse(cat) }), []);

  useEffect(() => {
    const bg = bgRef.current, fx = fxRef.current;
    if (!bg || !fx) return undefined;
    const TAU = Math.PI * 2;
    const CAT_C = CAT_NAMES.map(c => CATS[c].c);
    const hex = (c, a) => c + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
    const dpr = Math.min(2, window.devicePixelRatio || 1);   // the static layer is painted rarely, so keep it crisp
    // wall clock: 12 slots, the face shows the current half of the day (AM or PM)
    const BAR = Array.from({ length: 12 }, (_, slot) => (slot / 12) * 360);
    const halfStart = () => (easternParts().hour >= 12 ? 12 : 0);

    let w = 0, h = 0, g = null, started = false, visible = true, hover = -1;
    const lanes = CAT_NAMES.map((cat, i) => ({ cat, c: CAT_C[i], fy: LANE_Y[i], next: 0, e: null }));

    // ── sprites: one image per colour/size, tail + glow + head together ──
    const sprites = {};
    const spriteOf = (c, bright) => {
      const key = `${c}${bright ? 'b' : ''}`;
      if (sprites[key]) return sprites[key];
      const tail = bright ? 150 : 110, pad = bright ? 17 : 12, H = pad * 2, W = tail + pad;
      const s = document.createElement('canvas'); s.width = W * 2; s.height = H * 2;
      const x = s.getContext('2d'); x.scale(2, 2);
      const lg = x.createLinearGradient(0, 0, tail, 0);
      lg.addColorStop(0, hex(c, 0)); lg.addColorStop(1, hex(c, 0.75));
      x.strokeStyle = lg; x.lineWidth = bright ? 2 : 1.4; x.lineCap = 'round';
      x.beginPath(); x.moveTo(0, pad); x.lineTo(tail, pad); x.stroke();
      const rg = x.createRadialGradient(tail, pad, 0, tail, pad, pad);
      rg.addColorStop(0, hex(c, 0.5)); rg.addColorStop(0.3, hex(c, 0.16)); rg.addColorStop(1, hex(c, 0));
      x.fillStyle = rg; x.fillRect(tail - pad, 0, pad * 2, H);
      x.fillStyle = c; x.beginPath(); x.arc(tail, pad, bright ? 3.2 : 2.3, 0, TAU); x.fill();
      sprites[key] = { url: s.toDataURL(), W, H, tail, pad };
      return sprites[key];
    };

    // ── DOM for the moving parts ──
    fx.replaceChildren();
    const lanesBox = document.createElement('div'); lanesBox.className = 'lanes';
    const dial = document.createElement('div'); dial.className = 'dial';
    const ringsBox = document.createElement('div'); ringsBox.className = 'rings';
    const breath = document.createElement('div'); breath.className = 'breath';
    const hand = document.createElement('div'); hand.className = 'hand'; hand.innerHTML = '<i></i><b></b>';
    const bars = BAR.map(() => { const el = document.createElement('i'); el.className = 'bar'; dial.appendChild(el); return el; });
    // hour labels live above the rings and lanes (with a white backing) so the
    // glow and the packets pass under them instead of through the text
    const hourLabels = BAR.map((_, n) => {
      const el = document.createElement('span'); el.className = `hr${n % 3 === 0 ? ' major' : ''}`; el.textContent = String(n || 12);
      const a = (n / 12) * TAU - Math.PI / 2;
      el.style.left = `calc(var(--R) * ${(Math.cos(a) * 1.05).toFixed(4)})`;
      el.style.top = `calc(var(--R) * ${(Math.sin(a) * 1.05).toFixed(4)})`;
      return el;
    });
    const halfTag = document.createElement('span'); halfTag.className = 'half';
    dial.append(ringsBox, ...hourLabels, breath, halfTag, hand);
    fx.append(lanesBox, dial);

    const geomOf = () => {
      if (w < 900) { const R = 92; return { cx: w / 2, cy: h - R - 16, R, core: R * 0.42, b0: R * 0.49, b1: R * 0.8 }; }
      const R = Math.min(h * 0.44, w * 0.2);
      return { cx: w - Math.max(R * 1.35, Math.min(220, w * 0.13)), cy: h / 2, R, core: R * 0.42, b0: R * 0.49, b1: R * 0.8 };
    };

    const paintStatic = () => {
      const { cx, cy, R } = g;
      bg.width = Math.max(1, Math.round(w * dpr)); bg.height = Math.max(1, Math.round(h * dpr));
      const c = bg.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (w >= 900) {
        c.lineWidth = 1;
        lanes.forEach(ln => {
          const e = ln.e, gr = c.createLinearGradient(e.sx, e.sy, e.ex, e.ey);
          gr.addColorStop(0, hex(ln.c, 0)); gr.addColorStop(0.35, hex(ln.c, 0.05)); gr.addColorStop(1, hex(ln.c, 0.13));
          c.strokeStyle = gr; c.beginPath(); c.moveTo(e.sx, e.sy); c.lineTo(e.ex, e.ey); c.stroke();
        });
      }
      const halo = c.createRadialGradient(cx, cy, g.core, cx, cy, R * 1.25);
      halo.addColorStop(0, 'rgba(255,255,255,.92)'); halo.addColorStop(0.55, 'rgba(255,255,255,.4)'); halo.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = halo; c.beginPath(); c.arc(cx, cy, R * 1.25, 0, TAU); c.fill();
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(235,23,0,.1)'; c.beginPath(); c.arc(cx, cy, R * 0.98, 0, TAU); c.stroke();
      c.strokeStyle = 'rgba(163,153,146,.18)'; c.beginPath(); c.arc(cx, cy, R * 1.12, 0, TAU); c.stroke();
      c.fillStyle = '#a39992'; c.font = `${Math.max(9, R * 0.07)}px JohnsonText, Arial`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = '#fff'; c.shadowColor = 'rgba(49,44,42,.16)'; c.shadowBlur = 22; c.shadowOffsetY = 6;
      c.beginPath(); c.arc(cx, cy, g.core, 0, TAU); c.fill();
      c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetY = 0;
      // shrink the caption until it fits inside the white disc
      const caption = 'E V E N T S   T O D A Y', capMax = g.core * 1.5;
      let capSize = Math.max(8, R * 0.072);
      c.fillStyle = '#6e6259'; c.font = `${capSize}px JohnsonText, Arial`;
      const capW = c.measureText(caption).width;
      if (capW > capMax) { capSize = Math.max(5, capSize * capMax / capW); c.font = `${capSize}px JohnsonText, Arial`; }
      c.fillText(caption, cx, cy + R * 0.19);
    };

    const layout = () => {
      w = fx.clientWidth; h = fx.clientHeight;
      if (w < 2 || h < 2) return;
      g = geomOf();
      lanes.forEach(ln => {
        const sy = h * ln.fy, e = { sx: -30, sy, ex: g.cx - g.core * 1.14, ey: g.cy + (sy - g.cy) * 0.12 };
        e.ang = (Math.atan2(e.ey - e.sy, e.ex - e.sx) * 180) / Math.PI;
        ln.e = e;
      });
      const { cx, cy, R } = g;
      dial.style.cssText = `left:${cx}px;top:${cy}px;--R:${R}px;--core:${g.core}px;--b0:${g.b0}px;--blen:${g.b1 - g.b0}px`;
      if (countRef.current) {
        countRef.current.style.cssText = `left:${cx}px;top:${cy - R * 0.06}px;font-size:${R * 0.3}px`;
        countRef.current.dataset.fs = String(R * 0.3);
        countRef.current.dataset.max = String(g.core * 1.5);
        fitCount(countRef.current);
      }
      paintStatic();
      renderBars(false);
      placeHand();
    };

    // ── bars: transform-only growth, opacity-only flash ──
    let barKey = '';
    const renderBars = (animate = true) => {
      if (!g) return;
      const curH = easternParts().hour, h0 = curH >= 12 ? 12 : 0;
      const hrs = dataRef.current.hourly, max = Math.max(1, ...hrs.slice(h0, h0 + 12));
      halfTag.textContent = h0 ? 'PM' : 'AM';
      const key = `${hrs.join(',')}|${curH}|${started}|${g.R}`;
      if (key === barKey && animate) return;
      barKey = key;
      bars.forEach((el, slot) => {
        const hr = h0 + slot;
        const future = hr > curH;
        const len = future ? 0.09 : started ? (hrs[hr] ? 0.1 + 0.9 * hrs[hr] / max : 0.05) : 0.001;
        el.className = `bar${future ? ' future' : ''}${hr === curH ? ' now' : ''}${hover === slot ? ' hover' : ''}`;
        el.style.transitionDelay = animate ? `${slot * 40}ms` : '0ms';
        el.style.transform = `rotate(${BAR[slot]}deg) translateY(calc(-1 * var(--b0))) scaleY(${len.toFixed(4)})`;
      });
    };

    const flash = (hr) => {
      const el = bars[hr % 12];
      if (!el || el.classList.contains('future')) return;
      const base = el.classList.contains('hover') ? 1 : el.classList.contains('now') ? 0.85 : 0.4;
      el.animate([{ opacity: Math.min(1, base + 0.45) }, { opacity: base }], { duration: 1100, easing: 'cubic-bezier(.22,1,.36,1)' });
    };

    // ── hand: a rotation set every few seconds; it moves a quarter degree a minute ──
    const placeHand = () => {
      const p = easternParts();
      const deg = (((p.hour % 12) + p.minute / 60 + p.second / 3600) / 12) * 360;
      hand.style.transform = `rotate(${deg.toFixed(3)}deg)`;
    };

    // ── packets ──
    const live = new Set();
    const send = (ln, { fast = false, at = 0 } = {}) => {
      if (!ln.e || w < 900) return;
      const sp = spriteOf(ln.c, fast);
      const el = document.createElement('span');
      el.className = 'pk';
      el.style.cssText = `width:${sp.W}px;height:${sp.H}px;margin:${-sp.pad}px 0 0 ${-sp.tail}px;transform-origin:${sp.tail}px ${sp.pad}px;background-image:url(${sp.url})`;
      lanesBox.appendChild(el);
      const { sx, sy, ex, ey, ang } = ln.e;
      const dur = fast ? 2600 : 5600 + Math.random() * 2200;
      const anim = el.animate([
        { transform: `translate(${sx}px,${sy}px) rotate(${ang}deg)`, opacity: 0 },
        { opacity: fast ? 1 : 0.8, offset: 0.07 },
        { opacity: fast ? 1 : 0.8, offset: 0.9 },
        { transform: `translate(${ex}px,${ey}px) rotate(${ang}deg)`, opacity: 0 },
      ], { duration: dur, easing: GLIDE, fill: 'both' });
      if (at) anim.currentTime = at * dur;
      live.add(anim);
      anim.onfinish = () => {
        live.delete(anim);
        el.remove();
        ring(ln.c, fast);
        flash(easternParts().hour);
      };
    };

    const ring = (c, strong) => {
      if (!g) return;
      const el = document.createElement('span');
      el.className = `ring${strong ? ' strong' : ''}`;
      el.style.setProperty('--c', c);
      ringsBox.appendChild(el);
      const grow = strong ? 1 + 0.26 / 0.96 : 1 + 0.16 / 0.96;
      const anim = el.animate([
        { transform: 'scale(1)', opacity: 0 },
        { opacity: strong ? 0.6 : 0.32, offset: 0.08 },
        { transform: `scale(${grow})`, opacity: 0 },
      ], { duration: strong ? 2800 : 2300, easing: RING_EASE, fill: 'both' });
      anim.onfinish = () => el.remove();
    };

    const rateOf = (i) => {
      const m = dataRef.current.mix || {};
      const total = CAT_NAMES.reduce((s, c) => s + (m[c] || 0), 0);
      return 0.45 + 1.8 * ((m[CAT_NAMES[i]] || 0) / (total || 1));
    };

    // one slow scheduler instead of a frame loop
    const tick = () => {
      if (!started || document.hidden || !visible) return;
      const now = performance.now();
      lanes.forEach((ln, i) => {
        if (now >= ln.next) { send(ln); ln.next = now + (1500 + Math.random() * 2600) / rateOf(i); }
      });
    };
    const sched = setInterval(tick, 200);
    const handTimer = setInterval(() => { if (!document.hidden) { placeHand(); renderBars(); } }, 5000);

    // pause packets in flight while hidden/off screen, resume where they were
    const setRunning = (run) => live.forEach(a => (run ? a.play() : a.pause()));
    const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; setRunning(visible && !document.hidden); },
      { root: scrollRoot?.current || null });
    io.observe(fx);
    const onVis = () => setRunning(visible && !document.hidden);
    document.addEventListener('visibilitychange', onVis);

    const ro = new ResizeObserver(layout);
    ro.observe(fx);
    layout();
    document.fonts?.ready.then(() => { if (g) paintStatic(); if (countRef.current) fitCount(countRef.current); }).catch(() => {});

    // ── hover / click ──
    const local = (ev) => { const b = fx.getBoundingClientRect(); return [ev.clientX - b.left, ev.clientY - b.top]; };
    const setHover = (hr) => {
      if (hr === hover) return;
      if (hover >= 0) bars[hover].classList.remove('hover');
      hover = hr;
      if (hover >= 0) bars[hover].classList.add('hover');
    };
    const onMove = (ev) => {
      if (!g) return;
      const [x, y] = local(ev), dx = x - g.cx, dy = y - g.cy, r = Math.hypot(dx, dy);
      const t = cbRef.current.tip;
      if (r < g.core) {
        setHover(-1); fx.style.cursor = 'pointer';
        t.show(`${dataRef.current.today.toLocaleString()} events today`, 'Open analytics', ev.clientX, ev.clientY);
        return;
      }
      if (r > g.b0 * 0.9 && r < g.R * 0.95) {
        let a = Math.atan2(dy, dx) + Math.PI / 2;
        if (a < 0) a += TAU;
        const slot = Math.round((a / TAU) * 12) % 12, hr = halfStart() + slot;
        setHover(slot); fx.style.cursor = 'pointer';
        const future = hr > easternParts().hour;
        t.show(`${hrRange(hr)} ET`, future ? 'yet to come' : plural(dataRef.current.hourly[hr], 'event'), ev.clientX, ev.clientY);
        return;
      }
      setHover(-1); fx.style.cursor = 'default'; t.hide();
    };
    const onLeave = () => { setHover(-1); cbRef.current.tip.hide(); };
    const onClick = (ev) => {
      if (!g) return;
      const [x, y] = local(ev);
      if (Math.hypot(x - g.cx, y - g.cy) < g.R * 0.95) { cbRef.current.tip.hide(); cbRef.current.onOpenAnalytics(); }
    };
    fx.addEventListener('mousemove', onMove);
    fx.addEventListener('mouseleave', onLeave);
    fx.addEventListener('click', onClick);

    engine.current = {
      start() {
        if (started) return;
        started = true;
        bg.classList.add('on'); fx.classList.add('on'); countRef.current?.classList.add('on');
        renderBars(true);
        const now = performance.now();
        lanes.forEach((ln, i) => { send(ln, { at: 0.15 + i * 0.13 }); ln.next = now + 900 + i * 500; });
      },
      pulse(cat) {
        const ln = lanes[Math.max(0, CAT_NAMES.indexOf(cat))];
        if (w >= 900) send(ln, { fast: true, at: 0.1 });
        else { ring(ln.c, true); flash(easternParts().hour); }
      },
      update() { renderBars(true); },
    };

    return () => {
      clearInterval(sched); clearInterval(handTimer);
      ro.disconnect(); io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      fx.removeEventListener('mousemove', onMove);
      fx.removeEventListener('mouseleave', onLeave);
      fx.removeEventListener('click', onClick);
      live.forEach(a => a.cancel());
      engine.current = { start() {}, pulse() {}, update() {} };
    };
  }, [scrollRoot]);

  useEffect(() => { if (started) engine.current.start(); }, [started]);
  useEffect(() => { engine.current.update(); }, [hourly]);

  // the count eases to its value with a short text tween (a few small repaints, then idle)
  useEffect(() => {
    const el = countRef.current;
    if (!el || !started) return undefined;
    const from = Number(el.dataset.v || 0), to = today;
    el.dataset.v = String(to);
    // size for the final number; the tween never shows more digits than that
    el.textContent = to.toLocaleString();
    fitCount(el);
    if (from === to) { el.textContent = to.toLocaleString(); return undefined; }
    let raf = 0;
    const t0 = performance.now(), dur = from === 0 ? 1600 : 700;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (to - from) * e).toLocaleString();
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [today, started]);

  return (
    <>
      <canvas ref={bgRef} className="bg" aria-hidden="true" />
      <div ref={fxRef} className="fx" role="img"
        aria-label={`Today's activity by hour (Eastern), shown as a 12-hour clock for the current AM or PM: ${today} events today. Click to open analytics.`} />
      <span ref={countRef} className="count num" aria-hidden="true">0</span>
    </>
  );
});

// ─── intro (first visit per session; doubles as the initial loading state) ──

const INTRO_STEPS = ['Opening audit log', 'Loading entries', 'Resolving people', 'Ready'];

function Intro({ show, ready, onDone }) {
  const [step, setStep] = useState(0);
  const [minDone, setMinDone] = useState(false);
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) { setMounted(true); return undefined; }
    const t = setTimeout(() => setMounted(false), 1000);
    return () => clearTimeout(t);
  }, [show]);
  useEffect(() => {
    if (!show) return undefined;
    const t1 = setTimeout(() => setMinDone(true), 1300);
    const t2 = setTimeout(onDone, 8000); // never hold the page hostage to a slow request
    const t3 = setInterval(() => setStep(s => Math.min(s + 1, INTRO_STEPS.length - 2)), 450);
    return () => { clearTimeout(t1); clearTimeout(t2); clearInterval(t3); };
  }, [show, onDone]);
  useEffect(() => {
    if (!show || !ready || !minDone) return undefined;
    setStep(INTRO_STEPS.length - 1);
    const t = setTimeout(onDone, 380);
    return () => clearTimeout(t);
  }, [show, ready, minDone, onDone]);
  if (!mounted) return null;
  return (
    <div className={`intro ${show ? '' : 'gone'}`} onClick={onDone} aria-hidden={!show} title="Click to skip">
      <div className="box">
        <div className="orb"><i /><i /><b /></div>
        <div className="step" role="status">{INTRO_STEPS[step]}</div>
        <div className="track"><span /></div>
        <div className="cap">Global Regulatory Affairs · SmartHub</div>
      </div>
    </div>
  );
}

// ─── rail + analytics building blocks ───────────────────────────────────────

function Donut({ mix, total, size = 120, onPick, tip }) {
  const grown = useGrown(`${total}-${mix.length}`);
  const r = 48, circ = 2 * Math.PI * r;
  // the hole is only ~80px wide, so long counts get smaller, and millions go short (1.2M)
  const totalText = total >= 1e6
    ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(total)
    : total.toLocaleString();
  const fitSize = totalText.length <= 4 ? 24 : totalText.length <= 6 ? 19 : 16;
  const totalSize = Math.min(24, Math.round(fitSize * size / 120));
  let off = 0;
  return (
    <div className="mid">
      <svg viewBox="0 0 120 120" width={size} height={size} role="img" aria-label="Events by category">
        <circle cx="60" cy="60" r={r} fill="none" stroke="#f1efed" strokeWidth="14" />
        {mix.map(m => {
          const len = (m.count / (total || 1)) * circ;
          const el = (
            <circle key={m.cat} className="seg" cx="60" cy="60" r={r} stroke={CATS[m.cat].c}
              strokeDasharray={`${grown ? Math.max(0, len - 2) : 0} ${circ}`} strokeDashoffset={-off}
              onMouseMove={e => tip.show(m.cat, plural(m.count, 'event'), e.clientX, e.clientY)}
              onMouseLeave={() => tip.hide()}
              onClick={() => { tip.hide(); onPick(m.cat); }} />
          );
          off += len;
          return el;
        })}
      </svg>
      <div className="lbl"><div><b className="num" style={{ fontSize: totalSize }} title={total.toLocaleString()}>{totalText}</b><span>events</span></div></div>
    </div>
  );
}

function BarList({ rows, onPick, colorOf, leadOf, labelOf, empty = 'Nothing in range.' }) {
  const grown = useGrown(rows.map(r => r.key).join('|'));
  if (!rows.length) return <div className="ok">{empty}</div>;
  const max = rows[0].count || 1;
  return (
    <div className="bars">
      {rows.map(r => (
        <button key={r.key} type="button" className="barrow" onClick={() => onPick(r.key)} style={{ '--c': colorOf(r.key) }}>
          <div className="top">{leadOf(r.key)}<span className="nm">{labelOf(r.key)}</span><b className="num">{r.count.toLocaleString()}</b></div>
          <div className="track"><div className="fill" style={{ transform: `scaleX(${grown ? r.count / max : 0})` }} /></div>
        </button>
      ))}
    </div>
  );
}

function WatchList({ items, nameOf, onOpen, showTarget }) {
  if (!items.length) return <div className="ok"><span className="dot" />Nothing sensitive in this view.</div>;
  return (
    <div className="watch">
      {items.map(e => (
        <button key={e.id} type="button" onClick={() => onOpen(e.id)}>
          <Ic src={alertIcon} />
          <span style={{ minWidth: 0 }}>
            <div className="w1">{metaFor(e.action)[0]}</div>
            <div className="w2">{nameOf(e.performed_by) || e.performed_by || '—'}{showTarget && e.target ? ` · ${e.target}` : ''} · {relTime(e.timestamp)}</div>
          </span>
        </button>
      ))}
    </div>
  );
}

const mixFrom = (actions = []) => {
  const m = {};
  actions.forEach(({ action, count }) => { const c = categoryOf(action); m[c] = (m[c] || 0) + count; });
  return CAT_NAMES.filter(c => m[c]).map(c => ({ cat: c, count: m[c] })).sort((a, b) => b.count - a.count);
};

function AreaChart({ daily, tip }) {
  const grown = useGrown(daily.map(d => d.count).join(','));
  const [hover, setHover] = useState(-1);
  const ref = useRef(null);
  const W = 1000, H = 200;
  const vals = daily.map(d => d.count);
  const max = Math.max(1, ...vals) * 1.15;
  const pts = vals.map((v, i) => [vals.length > 1 ? (i / (vals.length - 1)) * W : W / 2, H - (v / max) * H]);
  let d = pts.length ? `M${pts[0][0]} ${pts[0][1]}` : '';
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], mx = (x0 + x1) / 2;
    d += ` C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`;
  }
  const onMove = (ev) => {
    if (!vals.length) return;
    const r = ref.current.getBoundingClientRect();
    const i = Math.round(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * (vals.length - 1));
    setHover(i);
    const x = vals.length > 1 ? i / (vals.length - 1) : 0.5, y = 1 - vals[i] / max;
    const day = new Date(`${daily[i].date}T12:00:00`);
    tip.show(plural(vals[i], 'event'), day.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' }),
      r.left + r.width * x, r.top + r.height * y);
  };
  const hx = hover >= 0 && vals.length > 1 ? (hover / (vals.length - 1)) * 100 : 50;
  const hy = hover >= 0 ? (1 - vals[hover] / max) * 100 : 0;
  return (
    <div ref={ref} className={`area ${grown ? 'grown' : ''}`} onMouseMove={onMove} onMouseLeave={() => { setHover(-1); tip.hide(); }}
      role="img" aria-label="Daily event volume over the last 30 days">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="al-area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#eb1700" stopOpacity=".22" /><stop offset="1" stopColor="#eb1700" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map(f => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="#e8e6e3" strokeDasharray="4 6" vectorEffect="non-scaling-stroke" />
        ))}
        {d && (
          <g className="reveal">
            <path d={`${d} L${W} ${H} L0 ${H} Z`} fill="url(#al-area-fill)" />
            <path className="line" d={d} />
          </g>
        )}
      </svg>
      {hover >= 0 && <><div className="cross" style={{ left: `${hx}%` }} /><div className="pt" style={{ left: `${hx}%`, top: `${hy}%` }} /></>}
    </div>
  );
}

function Hours({ hourly, currentHour, tip }) {
  const grown = useGrown(hourly.join(','));
  const max = Math.max(1, ...hourly);
  return (
    <>
      <div className={`hours ${grown ? 'grown' : ''}`} role="img" aria-label="Event volume by hour today (Eastern)">
        {hourly.map((v, h) => (
          <span key={h} className={h > currentHour ? 'future' : h === currentHour ? 'now' : ''}
            style={{ height: `${h > currentHour ? 8 : Math.max(4, (v / max) * 100)}%`, transitionDelay: `${h * 22}ms` }}
            onMouseMove={e => tip.show(`${hrRange(h)} ET`, h > currentHour ? 'yet to come' : plural(v, 'event'), e.clientX, e.clientY)}
            onMouseLeave={() => tip.hide()} />
        ))}
      </div>
      <div className="axis">{hourly.map((_, h) => <span key={h}>{h % 3 === 0 ? hr12(h) : ''}</span>)}</div>
    </>
  );
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function Heat({ heat, tip }) {
  const maxHeat = Math.max(1, ...heat.flat());
  const onMove = (e) => {
    const d = e.target.dataset;
    if (d.h === undefined) { tip.hide(); return; }
    tip.show(`${DOW[d.r]} ${hrRange(+d.h)} ET`, plural(heat[d.r][d.h], 'event'), e.clientX, e.clientY);
  };
  return (
    <div className="heat" role="img" aria-label="Events by weekday and hour (Eastern)" onMouseMove={onMove} onMouseLeave={() => tip.hide()}>
      {heat.map((row, r) => (
        <div key={r} className="hrow" style={{ animationDelay: `${r * 60}ms` }}>
          <span className="hl">{DOW[r]}</span>
          {row.map((v, h) => (
            <span key={h} className="cell" data-r={r} data-h={h}
              style={v ? { background: `rgba(235,23,0,${(0.08 + 0.92 * v / maxHeat).toFixed(2)})` } : undefined} />
          ))}
        </div>
      ))}
      <div className="hrow axis-row"><span />{Array.from({ length: 24 }, (_, h) => <span key={h} className="hx">{h % 6 === 0 ? hr12(h) : ''}</span>)}</div>
    </div>
  );
}

function AnalyticsView({ res, today, nameOf, photoOf, onlineSet, tip, onCat, onAction, onUser, onOpen }) {
  const a = res.data;
  if (!a && res.loading) {
    return (
      <div className="an-grid" aria-busy="true" aria-label="Loading analytics">
        {['span-8', 'span-4', 'span-7', 'span-5', 'span-4', 'span-4', 'span-4'].map((s, i) => (
          <div key={i} className={`card ${s}`} style={{ minHeight: 260 }}><div className="card-b" style={{ paddingTop: 22 }}><SkeletonLines n={5} /></div></div>
        ))}
      </div>
    );
  }
  if (!a) return <ErrorCard error={res.error} onRetry={res.reload} title="Couldn’t load analytics" />;

  const hourly = today?.hourly || a.hourly || new Array(24).fill(0);
  const peak = hourly.indexOf(Math.max(...hourly));
  const mix = mixFrom(a.actions);
  const daily = a.daily || [];
  const total30 = daily.reduce((s, d) => s + d.count, 0);
  const half = Math.floor(daily.length / 2);
  const prev = daily.slice(0, half).reduce((s, d) => s + d.count, 0);
  const cur = daily.slice(half).reduce((s, d) => s + d.count, 0);
  const trend = prev ? Math.round(((cur - prev) / prev) * 100) : null;
  const heat = a.heat || Array.from({ length: 7 }, () => new Array(24).fill(0));
  const topActions = (a.actions || []).slice(0, 7).map(x => ({ key: x.action, count: x.count }));
  const topPeople = (a.actors || []).slice(0, 7).map(x => ({ key: x.email, count: x.count }));

  return (
    <>
      {res.error && <InlineError error={res.error} onRetry={res.reload} what="analytics" />}
      <div className="an-grid" style={{ opacity: res.loading ? 0.6 : 1, transition: 'opacity .35s' }}>
        <div className="card span-8">
          <div className="card-h"><span className="cap">Today by hour · these filters</span>
            <span className="muted">{hourly.some(Boolean) ? `Busiest hour ${hr12(peak)}` : 'No activity yet today'}</span></div>
          <div className="card-b">
            <div className="big-n num">{hourly.reduce((s, v) => s + v, 0).toLocaleString()}<small>events</small></div>
            <Hours hourly={hourly} currentHour={today?.current_hour ?? a.current_hour ?? easternParts().hour} tip={tip} />
          </div>
        </div>
        <div className="card span-4" style={{ animationDelay: '.06s' }}>
          <div className="card-h"><span className="cap">Category mix · these filters</span></div>
          <div className="card-b" style={{ alignItems: 'center', gap: 16 }}>
            {mix.length ? (
              <>
                <div className="donut" style={{ gridTemplateColumns: '1fr' }}><Donut mix={mix} total={a.matched ?? 0} size={170} onPick={onCat} tip={tip} /></div>
                <div className="mix-list" style={{ width: '100%' }}>
                  {mix.map(m => (
                    <button key={m.cat} type="button" style={{ '--c': CATS[m.cat].c }} onClick={() => onCat(m.cat)}>
                      <i />{m.cat}<b className="num">{m.count.toLocaleString()} · {Math.round((m.count / (a.matched || 1)) * 100)}%</b>
                    </button>
                  ))}
                </div>
              </>
            ) : <div className="ok">Nothing to break down yet.</div>}
          </div>
        </div>
        <div className="card span-7" style={{ animationDelay: '.12s' }}>
          <div className="card-h"><span className="cap">Daily volume · last 30 days</span>
            {trend !== null && <span className="muted" style={{ color: trend >= 0 ? 'var(--green)' : 'var(--maroon)' }}>
              {trend >= 0 ? '▲' : '▼'} {Math.abs(trend)}% vs prior {half} days</span>}</div>
          <div className="card-b">
            <div className="big-n num">{total30.toLocaleString()}<small>events</small></div>
            <AreaChart daily={daily} tip={tip} />
            {daily.length > 0 && (
              <div className="area-axis">
                <span>{new Date(`${daily[0].date}T12:00:00`).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}</span>
                <span>{new Date(`${daily[half].date}T12:00:00`).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}</span>
                <span>Today</span>
              </div>
            )}
          </div>
        </div>
        <div className="card span-5" style={{ animationDelay: '.18s' }}>
          <div className="card-h"><span className="cap">When it happens · weekday × hour</span>
            <span className="scale">less {[0.08, 0.3, 0.55, 0.8, 1].map(x => <i key={x} style={{ background: `rgba(235,23,0,${x})` }} />)} more</span></div>
          <div className="card-b"><Heat heat={heat} tip={tip} /></div>
        </div>
        <div className="card span-4" style={{ animationDelay: '.24s' }}>
          <div className="card-h"><span className="cap">Top actions</span></div>
          <div className="card-b">
            <BarList rows={topActions} onPick={onAction} colorOf={k => CATS[categoryOf(k)].c}
              leadOf={() => <span className="sw" />} labelOf={k => metaFor(k)[0]} />
          </div>
        </div>
        <div className="card span-4" style={{ animationDelay: '.3s' }}>
          <div className="card-h"><span className="cap">Most active people</span></div>
          <div className="card-b">
            <BarList rows={topPeople} onPick={onUser} colorOf={avatarInk}
              leadOf={k => <Avatar email={k} name={nameOf(k)} photo={photoOf(k)} online={onlineSet.has(k)} small />}
              labelOf={k => nameOf(k) || k} />
          </div>
        </div>
        <div className="card span-4" style={{ animationDelay: '.36s' }}>
          <div className="card-h"><span className="cap">Sensitive events · these filters</span>
            <span className="muted" style={{ color: a.sensitive_count ? 'var(--maroon)' : undefined }}>{(a.sensitive_count || 0).toLocaleString()}</span></div>
          <div className="card-b"><WatchList items={a.sensitive || []} nameOf={nameOf} onOpen={onOpen} showTarget /></div>
        </div>
      </div>
    </>
  );
}

function PeopleView({ res, nameOf, photoOf, onlineSet, onUser, onClear }) {
  const list = res.data?.people;
  if (!list && res.loading) {
    return (
      <div className="people-grid" aria-busy="true" aria-label="Loading people">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="skel skel-card" style={{ animationDelay: `${i * 60}ms` }} />)}
      </div>
    );
  }
  if (!list) return <ErrorCard error={res.error} onRetry={res.reload} title="Couldn’t load people" />;
  if (!list.length) {
    return (
      <div className="empty"><div className="orbit" /><div className="big">Nobody matches these filters</div>
        <p>Try a wider time range or clear the search.</p>
        <div className="acts"><button type="button" className="btn solid" onClick={onClear}>Reset filters</button></div></div>
    );
  }
  return (
    <>
      {res.error && <InlineError error={res.error} onRetry={res.reload} what="people" />}
      <div className="people-grid" style={{ opacity: res.loading ? 0.6 : 1, transition: 'opacity .35s' }}>
        {list.map((p, i) => {
          const ink = avatarInk(p.email);
          const max = Math.max(1, ...p.daily);
          const pts = p.daily.map((v, k) => `${((k / Math.max(1, p.daily.length - 1)) * 300).toFixed(1)},${(38 - (v / max) * 34).toFixed(1)}`).join(' ');
          const online = onlineSet.has(p.email);
          return (
            <button key={p.email} type="button" className="person" style={{ animationDelay: `${Math.min(i, 12) * 45}ms` }} onClick={() => onUser(p.email)}
              aria-label={`Show events by ${nameOf(p.email) || p.email}`}>
              <span className="rank">{pad(i + 1)}</span>
              <div className="hd">
                <Avatar email={p.email} name={nameOf(p.email)} photo={photoOf(p.email)} online={online} />
                <div style={{ minWidth: 0 }}><div className="nm">{nameOf(p.email) || p.email}</div>{nameOf(p.email) && <div className="em">{p.email}</div>}</div>
              </div>
              <div className="stats">
                <div><b className="num">{p.count.toLocaleString()}</b><span>Events</span></div>
                <div><b className="num" style={p.sensitive ? { color: 'var(--maroon)' } : undefined}>{p.sensitive.toLocaleString()}</b><span>Sensitive</span></div>
                <div><b className="sm" style={online ? { color: 'var(--green)' } : undefined}>{online ? 'Online' : relTime(p.last_seen) || '—'}</b><span>Last seen</span></div>
              </div>
              <svg viewBox="0 0 300 40" preserveAspectRatio="none" aria-hidden="true">
                <polyline points={`0,40 ${pts} 300,40`} fill={ink} fillOpacity=".08" stroke="none" />
                <polyline points={pts} fill="none" stroke={ink} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              </svg>
              <div className="acts">
                {p.top_actions.map(t => (
                  <span key={t.action} style={{ '--c': colorOf(t.action) }}><i />{metaFor(t.action)[0]} · {t.count.toLocaleString()}</span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

function InlineError({ error, onRetry, what }) {
  const msg = describeError(error);
  if (msg === null) return null;
  return (
    <div className="inline-err" role="alert">
      <Ic src={alertIcon} size={14} />
      <span className="grow">Couldn’t refresh {what}. {msg} Showing the last loaded data.</span>
      {onRetry && <button type="button" className="btn" style={{ height: 28 }} onClick={onRetry}>Retry</button>}
    </div>
  );
}

// ─── the page ───────────────────────────────────────────────────────────────

let lastAuditEditAccessLog = { path: null, at: 0 };

const ROUTE_DEFAULTS = { view: 'stream', q: '', cat: 'all', action: '', range: '30d', group: 'Time', page: 1, user: '', from: '', to: '', adv: false, event: '' };
const VIEWS = ['stream', 'analytics', 'people'];
const RANGES = ['24h', '7d', '30d', 'all'];
const GROUPS = ['Time', 'User', 'Action'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function AuditPage({ editable = false, forceSilent = false }) {
  useAuditStyles();
  const tier = usePerfTier();
  useEffect(() => measureTier(5), []);
  const { user } = useAuth();
  const email = user?.email || user?.username || 'unknown';
  const { instance, accounts } = useMsal();
  const { hasRole } = useRBAC();
  const canDelete = editable && hasRole('admin');

  useEffect(() => {
    if (!editable) return;
    const path = forceSilent ? '/audit-edit-force' : '/audit-edit';
    const now = Date.now();
    if (lastAuditEditAccessLog.path === path && now - lastAuditEditAccessLog.at < 1000) return;
    lastAuditEditAccessLog = { path, at: now };
    logAuditEvent('audit_edit_mode_accessed', email, path,
      forceSilent ? 'Navigated to Audit Log Edit Mode (silent deletions)' : 'Navigated to Audit Log Edit Mode');
  }, [editable, forceSilent]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── URL is the source of truth for every filter and view, so a link pasted
  // into a ticket lands on the same rows, tab and open event. Unknown values
  // fall back to defaults instead of breaking the page. ──────────────────────
  const [params, setParams] = useSearchParams();
  const route = useMemo(() => {
    const pick = (k, allowed) => (allowed.includes(params.get(k)) ? params.get(k) : ROUTE_DEFAULTS[k]);
    const cat = params.get('cat');
    const date = (k) => (DATE_RE.test(params.get(k) || '') ? params.get(k) : '');
    return {
      view: pick('view', VIEWS),
      q: (params.get('q') || '').slice(0, 200),
      cat: CAT_NAMES.includes(cat) ? cat : 'all',
      action: (params.get('action') || '').slice(0, 120),
      range: pick('range', RANGES),
      group: pick('group', GROUPS),
      page: Math.max(1, parseInt(params.get('page') || '1', 10) || 1),
      user: (params.get('user') || '').slice(0, 200),
      from: date('from'),
      to: date('to'),
      adv: params.get('adv') === '1',
      event: (params.get('event') || '').slice(0, 80),
    };
  }, [params]);
  const routeRef = useRef(route);
  routeRef.current = route;

  const go = useCallback((patch, { replace = false } = {}) => {
    setParams((prev) => {
      // Start from the address bar, not `prev`: a debounced box firing a moment
      // after another change can hold an older `prev` and would undo it.
      const next = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : prev);
      const filterChanged = ['q', 'cat', 'action', 'range', 'user', 'from', 'to'].some(k => k in patch);
      const full = filterChanged && !('page' in patch) ? { ...patch, page: 1 } : patch;
      Object.entries(full).forEach(([k, v]) => {
        if (v === ROUTE_DEFAULTS[k] || v === '' || v === null || v === undefined || v === false) next.delete(k);
        else next.set(k, v === true ? '1' : String(v));
      });
      return next;
    }, { replace });
  }, [setParams]);

  // filters only (no page) — the key every aggregate is fetched by
  const qs = useMemo(() => new URLSearchParams({
    ...(route.q && { search: route.q }),
    ...(route.action && { action: route.action }),
    ...(route.cat !== 'all' && { category: route.cat }),
    ...(route.range !== 'all' && { range: route.range }),
    ...(route.user && { performed_by: route.user }),
    ...(route.from && { date_from: route.from }),
    ...(route.to && { date_to: route.to }),
  }).toString(), [route.q, route.action, route.cat, route.range, route.user, route.from, route.to]);

  // ── data ───────────────────────────────────────────────────────────────────
  const logs = useResource(sig => getJson(withQuery('/api/audit/logs', qs, { page: route.page, page_size: PAGE_SIZE }), sig), [qs, route.page]);
  const analytics = useResource(sig => getJson(withQuery('/api/audit/analytics', qs), sig), [qs]);
  const stats = useResource(sig => getJson('/api/audit/stats', sig), []);
  const actionTypes = useResource(sig => getJson('/api/audit/actions', sig), []);
  const active = useResource(sig => getJson('/api/audit/active-users', sig), []);
  const people = useResource(sig => getJson(withQuery('/api/audit/people', qs), sig), [qs], route.view === 'people');
  const context = useResource(sig => getJson(`/api/audit/logs/${encodeURIComponent(route.event)}/context`, sig), [route.event], !!route.event);

  useVisiblePoll(stats.reload, STATS_POLL_MS);
  useVisiblePoll(active.reload, ACTIVE_POLL_MS);

  const total = logs.data?.total ?? 0;
  const rows = useMemo(() => logs.data?.logs || [], [logs.data]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(route.page, totalPages);

  // Narrowing the filters can leave us past the last page — step back.
  useEffect(() => {
    if (!logs.loading && !logs.error && logs.data && total > 0 && route.page > totalPages) go({ page: totalPages }, { replace: true });
  }, [logs.loading, logs.error, logs.data, total, route.page, totalPages, go]);

  // ── UI state ───────────────────────────────────────────────────────────────
  const scrollRef = useRef(null);
  const cmdRef = useRef(null);
  const rootRef = useRef(null);

  // styled tooltip with the full text for anything cut off with ellipsis
  const cutRef = useRef(null);
  const showFullText = (e) => {
    let el = e.target;
    while (el && el !== e.currentTarget) {
      if (el.nodeType === 1 && getComputedStyle(el).textOverflow === 'ellipsis') {
        if (el.title || el.scrollWidth <= el.clientWidth) return;
        const r = el.getBoundingClientRect();
        const x = Math.min(Math.max(r.left + r.width / 2, 170), window.innerWidth - 170);
        tip.ref.current?.classList.add('wrap');
        tip.show(el.textContent.trim(), '', x, r.top);
        cutRef.current = el;
        return;
      }
      el = el.parentElement;
    }
  };
  const hideFullText = (e) => {
    const el = cutRef.current;
    if (!el || (e.type === 'mouseout' && el.contains(e.relatedTarget))) return;
    cutRef.current = null;
    tip.hide();
    tip.ref.current?.classList.remove('wrap');
  };

  const heroRef = useRef(null);
  const searchRef = useRef(null);
  const tabsRef = useRef(null);
  const drawerRef = useRef(null);
  const returnFocusRef = useRef(null);
  const tip = useTooltip();

  const [searchDraft, setSearchDraft] = useState(route.q);
  const [userDraft, setUserDraft] = useState(route.user);
  const [selected, setSelected] = useState(() => new Set());
  const [selectingAll, setSelectingAll] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirm, setConfirm] = useState(null);   // { ids }
  const [showKeys, setShowKeys] = useState(false);
  const [toast, setToast] = useState(null);       // { msg, bad }
  const [focusIdx, setFocusIdx] = useState(-1);
  const [fresh, setFresh] = useState(() => new Set());
  const [unseen, setUnseen] = useState(0);
  const [live, setLive] = useState(() => readStore('localStorage', LIVE_KEY) !== '0');
  const [intro, setIntro] = useState(() => !readStore('sessionStorage', INTRO_KEY) && !params.get('event'));
  const [heroStarted, setHeroStarted] = useState(() => !intro);
  const [userNames, setUserNames] = useState({});
  const [userPhotos, setUserPhotos] = useState({});

  useEffect(() => { setSearchDraft(route.q); }, [route.q]);
  useEffect(() => { setUserDraft(route.user); }, [route.user]);
  useEffect(() => { setSelected(new Set()); setFocusIdx(-1); setUnseen(0); }, [qs]);
  useEffect(() => { setFocusIdx(-1); }, [route.page, route.view]);

  const toastTimer = useRef(null);
  const flash = useCallback((msg, bad = false) => {
    setToast({ msg, bad });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(t => (t ? { ...t, hide: true } : t)), 2800);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // the banner starts once the intro has mostly faded, so the two never
  // compete for the same frames
  const heroTimer = useRef(null);
  const finishIntro = useCallback(() => {
    setIntro(false);
    writeStore('sessionStorage', INTRO_KEY, '1');
    clearTimeout(heroTimer.current);
    heroTimer.current = setTimeout(() => setHeroStarted(true), 350);
  }, []);
  useEffect(() => () => clearTimeout(heroTimer.current), []);

  // sticky offsets follow the command bar's real height (it grows with Filters)
  useEffect(() => {
    const cmd = cmdRef.current, root = rootRef.current;
    if (!cmd || !root) return undefined;
    const sync = () => {
      root.style.setProperty('--al-stick', `${60 + cmd.offsetHeight}px`);
      root.style.setProperty('--al-h', `${root.clientHeight}px`);   // the rail scrolls inside this
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(cmd);
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  // ── people names + photos from Graph (one lookup per address per session) ──
  const photoUrlsRef = useRef({});
  const askedRef = useRef({});
  const graphBackoffRef = useRef(0);
  const resolvePeople = useCallback(async (emails) => {
    const wanted = [...new Set(emails.filter(e => e && e.includes('@')).map(e => e.toLowerCase()))]
      .filter(e => !askedRef.current[e] && !e.endsWith('@apikey.local'))
      .slice(0, 40);
    if (!wanted.length || !accounts.length || Date.now() < graphBackoffRef.current) return;
    wanted.forEach(e => { askedRef.current[e] = true; });
    try {
      const tokenRes = await instance.acquireTokenSilent({ scopes: ['User.Read.All'], account: accounts[0] });
      const auth = { Authorization: `Bearer ${tokenRes.accessToken}` };
      const results = await Promise.all(wanted.map(async (addr) => {
        const out = { key: addr };
        try {
          const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(addr)}?$select=displayName`, { headers: auth });
          if (r.ok) out.name = (await r.json()).displayName;
        } catch { /* keep showing the email */ }
        try {
          const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(addr)}/photo/$value`, { headers: auth });
          if (r.ok) out.photo = URL.createObjectURL(await r.blob());
        } catch { /* initials instead */ }
        return out;
      }));
      const names = {}, photos = {};
      results.forEach(({ key, name, photo }) => {
        if (name) names[key] = name;
        if (photo) { photos[key] = photo; photoUrlsRef.current[key] = photo; }
      });
      if (Object.keys(names).length) setUserNames(prev => ({ ...prev, ...names }));
      if (Object.keys(photos).length) setUserPhotos(prev => ({ ...prev, ...photos }));
    } catch {
      wanted.forEach(e => { delete askedRef.current[e]; }); // token failed — retry, but not on every render
      graphBackoffRef.current = Date.now() + 60_000;
    }
  }, [accounts, instance]);

  useEffect(() => { resolvePeople(rows.map(l => l.performed_by)); }, [rows, resolvePeople]);
  useEffect(() => {
    const a = analytics.data;
    if (a) resolvePeople([...(a.actors || []).map(x => x.email), ...(a.sensitive || []).map(x => x.performed_by)]);
  }, [analytics.data, resolvePeople]);
  useEffect(() => { if (people.data) resolvePeople(people.data.people.map(p => p.email)); }, [people.data, resolvePeople]);
  useEffect(() => { if (active.data) resolvePeople((active.data.users || []).map(u => u.email)); }, [active.data, resolvePeople]);
  useEffect(() => { if (context.data) resolvePeople(context.data.around.map(e => e.performed_by)); }, [context.data, resolvePeople]);
  useEffect(() => () => { Object.values(photoUrlsRef.current).forEach(u => URL.revokeObjectURL(u)); }, []);

  const nameOf = useCallback((addr = '') => userNames[(addr || '').toLowerCase()] || '', [userNames]);
  const photoOf = useCallback((addr = '') => userPhotos[(addr || '').toLowerCase()] || '', [userPhotos]);
  const onlineSet = useMemo(() => new Set((active.data?.users || []).map(u => (u.email || '').toLowerCase())), [active.data]);
  const isOnline = useCallback((addr = '') => onlineSet.has((addr || '').toLowerCase()), [onlineSet]);

  // ── live: poll page 1, flash what's new, send it into the dial ─────────────
  const knownRef = useRef({ qs: null, ids: new Set(), newest: 0 });
  useEffect(() => {
    if (route.page !== 1 || !logs.data) return;
    const k = knownRef.current;
    if (k.qs !== qs) knownRef.current = { qs, ids: new Set(), newest: 0 };
    logs.data.logs.forEach(l => knownRef.current.ids.add(l.id));
    const top = logs.data.logs[0];
    if (top) knownRef.current.newest = Math.max(knownRef.current.newest, Date.parse(top.timestamp) || 0);
  }, [logs.data, qs, route.page]);

  const freshTimers = useRef([]);
  useEffect(() => () => freshTimers.current.forEach(clearTimeout), []);
  const markFresh = useCallback((ids) => {
    setFresh(prev => new Set([...prev, ...ids]));
    freshTimers.current.push(setTimeout(() => setFresh(prev => {
      const next = new Set(prev); ids.forEach(id => next.delete(id)); return next;
    }), 4500));
  }, []);

  const logsSetData = logs.setData;
  useEffect(() => {
    if (!live || route.view !== 'stream') return undefined;
    let ctl = null, stopped = false;
    const tick = async () => {
      if (document.hidden) return;
      ctl?.abort();
      ctl = new AbortController();
      try {
        const data = await getJson(withQuery('/api/audit/logs', qs, { page: 1, page_size: PAGE_SIZE }), ctl.signal);
        if (stopped) return;
        const k = knownRef.current;
        if (k.qs !== qs) {
          // opened on a later page: this first answer is the baseline, not news
          knownRef.current = { qs, ids: new Set(data.logs.map(l => l.id)), newest: Math.max(0, ...data.logs.map(l => Date.parse(l.timestamp) || 0)) };
          return;
        }
        const incoming = data.logs.filter(l => !k.ids.has(l.id) && (Date.parse(l.timestamp) || 0) > k.newest);
        data.logs.forEach(l => k.ids.add(l.id));
        if (!incoming.length) return;
        k.newest = Math.max(k.newest, ...incoming.map(l => Date.parse(l.timestamp) || 0));
        if (routeRef.current.page === 1) {
          logsSetData(prev => ({ ...data, total: Math.max(data.total, (prev?.total || 0) + incoming.length) }));
          markFresh(incoming.map(l => l.id));
        } else {
          setUnseen(n => n + incoming.length);
        }
      } catch { /* live is best-effort; the next tick tries again */ }
    };
    const t = setInterval(tick, LIVE_POLL_MS);
    return () => { stopped = true; clearInterval(t); ctl?.abort(); };
  }, [live, route.view, qs, logsSetData, markFresh]);

  // ── the banner dial: one fresh source (/today, cached 5s on the server)
  // polled every 15s while Live is on and every minute otherwise. The same
  // response carries the newest events, so a packet flies for exactly the
  // events that just moved the count. ─────────────────────────────────────
  const [today, setToday] = useState(null);
  useEffect(() => {
    let ctl = null, stopped = false, seeded = false, newest = 0;
    const seen = new Set();
    const tick = async () => {
      if (document.hidden && seeded) return;
      ctl?.abort();
      ctl = new AbortController();
      try {
        const data = await getJson('/api/audit/today', ctl.signal);
        if (stopped) return;
        const fresh = seeded ? data.latest.filter(e => !seen.has(e.id) && (Date.parse(e.timestamp) || 0) > newest) : [];
        data.latest.forEach(e => { seen.add(e.id); newest = Math.max(newest, Date.parse(e.timestamp) || 0); });
        if (seen.size > 2000) { seen.clear(); data.latest.forEach(e => seen.add(e.id)); }
        seeded = true;
        setToday(data);
        if (live) fresh.slice(0, 6).forEach((e, i) => setTimeout(() => heroRef.current?.pulse(categoryOf(e.action)), i * 380));
      } catch { /* keep the last numbers; the next tick tries again */ }
    };
    tick();
    const t = setInterval(tick, live ? LIVE_POLL_MS : STATS_POLL_MS);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { stopped = true; clearInterval(t); ctl?.abort(); document.removeEventListener('visibilitychange', onVis); };
  }, [live]);
  const dialHourly = useMemo(() => today?.hourly || stats.data?.hourly_today || new Array(24).fill(0), [today, stats.data]);

  const toggleLive = useCallback(() => {
    setLive(v => {
      writeStore('localStorage', LIVE_KEY, v ? '0' : '1');
      return !v;
    });
  }, []);
  useEffect(() => { if (!live) setUnseen(0); }, [live]);

  // ── actions ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (searchDraft === route.q) return undefined;
    const t = setTimeout(() => {
      const q = searchDraft.trim();
      go({ q, event: '' }, { replace: true });
      logAuditEvent('in-page-audit', email, '', q ? `Searched audit log for "${q}"` : 'Cleared audit log search');
    }, 350);
    return () => clearTimeout(t);
  }, [searchDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (userDraft === route.user) return undefined;
    const t = setTimeout(() => {
      const u = userDraft.trim();
      go({ user: u, event: '' }, { replace: true });
      if (u) logAuditEvent('in-page-audit', email, '', `Filtered audit log by user "${u}"`);
    }, 450);
    return () => clearTimeout(t);
  }, [userDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToStream = useCallback(() => {
    const sc = scrollRef.current, cmd = cmdRef.current;
    if (!sc || !cmd) return;
    const hero = sc.querySelector('.hero');
    const y = hero ? hero.offsetTop + hero.offsetHeight - 60 : 0;
    if (sc.scrollTop > y + 4 || sc.scrollTop < y - 4) sc.scrollTo({ top: y, behavior: 'smooth' });
  }, []);

  const setView = (view) => {
    if (view === route.view) return;
    go({ view, event: '' });
    logAuditEvent('in-page-audit', email, '', `Opened audit log ${view} view`);
  };
  const setCategory = useCallback((cat) => {
    go({ cat, action: '', event: '' });
    logAuditEvent('in-page-audit', email, '', cat === 'all' ? 'Cleared event filter' : `Filtered audit log by ${cat}`);
  }, [go, email]);
  const setAction = (action) => {
    go({ action, cat: 'all', event: '' });
    logAuditEvent('in-page-audit', email, '', action ? `Filtered by action "${metaFor(action)[0]}"` : 'Cleared event filter');
  };
  const setRange = (range) => {
    go({ range, event: '' });
    logAuditEvent('in-page-audit', email, '', `Set audit log time range to ${range}`);
  };
  const setUserFilter = useCallback((addr) => {
    go({ user: addr, adv: !!addr, event: '', view: 'stream' });
    if (addr) logAuditEvent('in-page-audit', email, '', `Filtered audit log by user "${addr}"`);
  }, [go, email]);
  const clearAll = () => {
    go({ q: '', action: '', cat: 'all', range: ROUTE_DEFAULTS.range, user: '', from: '', to: '', event: '' });
    setSearchDraft(''); setUserDraft('');
    logAuditEvent('in-page-audit', email, '', 'Cleared all audit log filters');
  };
  // logo or title: back to the plain stream, every filter and open event dropped
  const goHome = () => {
    setParams(new URLSearchParams());
    setSearchDraft(''); setUserDraft('');
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    logAuditEvent('in-page-audit', email, '', 'Went to Audit Log home');
  };
  const changePage = useCallback((next) => {
    if (next === page || next < 1 || next > totalPages) return;
    go({ page: next, event: '' });
    setUnseen(0);
    logAuditEvent('in-page-audit', email, '', `Navigated to page ${next} of audit log`);
    const sc = scrollRef.current, col = sc?.querySelector('.stream-col');
    if (sc && col) {
      const top = col.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - (60 + (cmdRef.current?.offsetHeight || 0)) - 8;
      if (sc.scrollTop > top) sc.scrollTo({ top, behavior: 'smooth' });
    }
  }, [page, totalPages, go, email]);

  const refreshSeen = useRef(false);
  const refresh = () => {
    logAuditEvent('in-page-audit', email, '', 'Refresh clicked on Audit Log');
    refreshSeen.current = false;
    setRefreshing(true);
    logs.reload(); analytics.reload(); stats.reload(); active.reload(); actionTypes.reload();
    if (route.view === 'people') people.reload();
    if (route.event) context.reload();
  };
  useEffect(() => {
    if (!refreshing) return;
    if (logs.loading || analytics.loading) { refreshSeen.current = true; return; }
    if (!refreshSeen.current) return;          // reloads haven't started yet
    setRefreshing(false);
    if (logs.error) flash('Refresh failed. Showing the last loaded data.', true);
    else flash('Up to date');
  }, [refreshing, logs.loading, analytics.loading, logs.error, flash]);

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await apiFetch(withQuery('/api/audit/export', qs));
      if (!res.ok) throw new RequestError(`${res.status} ${res.statusText}`, res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit_log_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      flash('Export downloaded');
      logAuditEvent('in-page-audit', email, '', 'Exported audit log to CSV');
    } catch (err) {
      const msg = describeError(err);
      if (msg !== null) flash(`Export failed. ${msg}`, true);
    } finally {
      setExporting(false);
    }
  };

  const reloadAfterDelete = () => {
    getJson('/api/audit/today').then(setToday).catch(() => {}); logs.reload(); stats.reload(); analytics.reload(); actionTypes.reload(); if (route.view === 'people') people.reload(); };

  const runDelete = async (ids) => {
    if (!canDelete || !ids.length) return;
    setDeleting(true);
    try {
      const silent = forceSilent ? '?silent=true' : '';
      const res = ids.length === 1
        ? await apiFetch(`/api/audit/logs/${encodeURIComponent(ids[0])}${silent}`, { method: 'DELETE' })
        : await apiFetch(`/api/audit/logs${silent}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      if (!res.ok && res.status !== 404) throw new RequestError(`${res.status} ${res.statusText}`, res.status);
      const gone = new Set(ids);
      setSelected(prev => new Set([...prev].filter(id => !gone.has(id))));
      if (gone.has(route.event)) go({ event: '' }, { replace: true });
      setConfirm(null);
      reloadAfterDelete();
      flash(`${plural(ids.length, 'entry', 'entries')} deleted`);
    } catch (err) {
      const msg = describeError(err);
      if (msg !== null) flash(`Delete failed. ${msg}`, true);
    } finally {
      setDeleting(false);
    }
  };

  const selectAllMatching = async () => {
    if (selected.size) { setSelected(new Set()); return; }
    setSelectingAll(true);
    try {
      const data = await getJson(withQuery('/api/audit/logs/ids', qs));
      setSelected(new Set(data.ids || []));
    } catch (err) {
      const msg = describeError(err);
      if (msg !== null) flash(`Couldn’t select entries. ${msg}`, true);
    } finally {
      setSelectingAll(false);
    }
  };

  const toggleOne = useCallback((id) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);

  // ── detail drawer ──────────────────────────────────────────────────────────
  const openEvent = useCallback((id) => {
    if (!routeRef.current.event) returnFocusRef.current = document.activeElement;
    go({ event: id });
  }, [go]);
  const closeEvent = useCallback(() => {
    go({ event: '' });
    const el = returnFocusRef.current;
    returnFocusRef.current = null;
    if (el && document.contains(el)) setTimeout(() => el.focus?.({ preventScroll: true }), 50);
  }, [go]);

  const detailFromList = route.event ? rows.find(l => l.id === route.event) : null;
  const detailFromCtx = route.event && context.data?.event?.id === route.event ? context.data.event : null;
  const detail = detailFromList || detailFromCtx;
  const lastDetailRef = useRef(null);
  if (detail) lastDetailRef.current = detail;
  const shownDetail = detail || (route.event ? null : lastDetailRef.current);
  const detailIdx = detail ? rows.findIndex(l => l.id === detail.id) : -1;

  useEffect(() => {
    if (route.event) {
      const t = setTimeout(() => drawerRef.current?.querySelector('.x')?.focus({ preventScroll: true }), 80);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [route.event]);

  // ── keyboard ───────────────────────────────────────────────────────────────
  const keyRef = useRef(null);
  keyRef.current = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target || {};
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable;
    if (e.key === 'Escape') {
      if (confirm) { if (!deleting) setConfirm(null); return; }
      if (showKeys) { setShowKeys(false); return; }
      if (typing) { t.blur?.(); return; }
      if (route.event) { closeEvent(); return; }
      setFocusIdx(-1);
      return;
    }
    if (typing || confirm || showKeys || intro) return;
    if (!rootRef.current || !document.body.contains(rootRef.current)) return;
    switch (e.key) {
      case '/': e.preventDefault(); searchRef.current?.focus(); break;
      case '?': setShowKeys(true); break;
      case 'j': case 'k': {
        if (route.event) {
          const n = detailIdx + (e.key === 'j' ? 1 : -1);
          if (detailIdx >= 0 && rows[n]) openEvent(rows[n].id);
          break;
        }
        if (route.view !== 'stream' || !rows.length) break;
        setFocusIdx(i => Math.max(0, Math.min(rows.length - 1, i + (e.key === 'j' ? 1 : -1))));
        break;
      }
      case 'Enter':
        if (route.view === 'stream' && rows[focusIdx] && !route.event && !['BUTTON', 'A'].includes(t.tagName)) { e.preventDefault(); openEvent(rows[focusIdx].id); }
        break;
      case 'ArrowRight': if (route.view === 'stream' && !route.event) changePage(page + 1); break;
      case 'ArrowLeft': if (route.view === 'stream' && !route.event) changePage(page - 1); break;
      case '1': setView('stream'); break;
      case '2': setView('analytics'); break;
      case '3': setView('people'); break;
      case 'l': case 'L': toggleLive(); break;
      default:
    }
  };
  useEffect(() => {
    const onKey = (e) => keyRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (focusIdx < 0) return;
    rootRef.current?.querySelectorAll('.tl .row')[focusIdx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusIdx]);

  // ── derived ────────────────────────────────────────────────────────────────
  const groups = useMemo(() => {
    const out = [];
    const byKey = new Map();
    rows.forEach((log) => {
      const key = route.group === 'User' ? (log.performed_by || '—').toLowerCase()
        : route.group === 'Action' ? log.action
          : new Date(log.timestamp).toDateString();
      let g = byKey.get(key);
      if (!g) {
        g = { key, items: [], sample: log };
        byKey.set(key, g);
        out.push(g);
      }
      g.items.push(log);
    });
    return out;
  }, [rows, route.group]);

  const catCounts = analytics.data?.categories || {};
  const catTotal = CAT_NAMES.reduce((s, c) => s + (catCounts[c] || 0), 0);
  const actionOptions = useMemo(() => (actionTypes.data?.actions || [])
    .map(key => ({ key, label: metaFor(key)[0] }))
    .sort((a, b) => a.label.localeCompare(b.label)), [actionTypes.data]);
  const advCount = [route.user, route.from, route.to].filter(Boolean).length;

  // ── search suggestions ─────────────────────────────────────────────────────
  const [recent, setRecent] = useState(readRecent);
  const rememberSearch = useCallback((q) => {
    if (q.length < 2) return;
    setRecent(prev => {
      const next = [q, ...prev.filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 6);
      writeStore('localStorage', RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  // a search that's been left in place for a moment is worth remembering;
  // the half-typed ones in between aren't
  useEffect(() => {
    if (!route.q) return undefined;
    const t = setTimeout(() => rememberSearch(route.q), 2500);
    return () => clearTimeout(t);
  }, [route.q, rememberSearch]);
  const forgetSearches = () => { setRecent([]); writeStore('localStorage', RECENT_KEY, '[]'); };

  // Suggestions only ever offer what's in the events currently in view: the
  // same range, category, person and dates as the stream (the text being
  // typed and the action are left out, so a pick can switch them).
  const suggestFilters = useMemo(() => ({
    ...(route.cat !== 'all' && { category: route.cat }),
    ...(route.range !== 'all' && { range: route.range }),
    ...(route.user && { performed_by: route.user }),
    ...(route.from && { date_from: route.from }),
    ...(route.to && { date_to: route.to }),
  }), [route.cat, route.range, route.user, route.from, route.to]);

  const searchServer = useServerSuggest(searchDraft, suggestFilters, !!searchDraft.trim());
  const userServer = useServerSuggest(userDraft, suggestFilters, route.adv);

  // people in view: the server's matches plus whoever is on screen (so a
  // display name from the directory can be matched too, not just the email)
  const findPeople = useCallback((text, server, limit) => {
    const k = text.trim().toLowerCase();
    const pool = new Map();
    const add = (e, n = 0) => {
      if (!e) return;
      const a = e.toLowerCase();
      pool.set(a, Math.max(pool.get(a) || 0, n || 0));
    };
    (server?.people || []).forEach(p => add(p.email, p.count));
    if (!route.user) {
      rows.forEach(r => add(r.performed_by));
      (analytics.data?.actors || []).forEach(a => add(a.email, a.count));
    }
    const out = [];
    pool.forEach((n, addr) => {
      const name = (userNames[addr] || '').toLowerCase();
      if (k && !addr.includes(k) && !name.includes(k)) return;
      const starts = !k || addr.startsWith(k) || name.startsWith(k) || name.includes(` ${k}`);
      out.push({ addr, n, starts });
    });
    return out.sort((a, b) => (b.starts - a.starts) || (b.n - a.n) || a.addr.localeCompare(b.addr)).slice(0, limit);
  }, [rows, analytics.data, userNames, route.user]);

  const personItem = (addr, n, text, run, prefix) => ({
    id: `${prefix}-${addr}`,
    lead: <Avatar email={addr} name={nameOf(addr)} photo={photoOf(addr)} online={isOnline(addr)} small />,
    label: <Highlight text={nameOf(addr) || addr} q={text} />,
    sub: nameOf(addr) ? <Highlight text={addr} q={text} /> : (isOnline(addr) ? 'Active now' : null),
    meta: n ? plural(n, 'event') : null,
    run,
  });

  const searchGroups = useMemo(() => {
    const text = searchDraft.trim();
    const k = text.toLowerCase();
    const clearAnd = (patch, msg) => {
      setSearchDraft('');
      go({ q: '', event: '', ...patch });
      logAuditEvent('in-page-audit', email, '', msg);
    };
    if (!k) {
      return [
        { title: 'Recent searches', extra: <button type="button" onClick={forgetSearches}>Clear</button>,
          items: recent.map(r => ({ id: `r-${r}`, lead: <SgIcon src={timeIcon} />, label: r, run: () => { setSearchDraft(r); go({ q: r, event: '' }); } })) },
      ];
    }
    const inView = (searchServer?.actions || []).map(a => ({ key: a.action, label: metaFor(a.action)[0], n: a.count }));
    const actions = inView.filter(o => o.label.toLowerCase().includes(k) || o.key.toLowerCase().includes(k)).slice(0, 4);
    const catN = {};
    inView.forEach(o => { const c = categoryOf(o.key); catN[c] = (catN[c] || 0) + o.n; });
    const cats = CAT_NAMES.filter(c => catN[c] && c !== route.cat && c.toLowerCase().includes(k));
    const targets = (searchServer?.targets || []).filter(t => t.target.toLowerCase().includes(k)).slice(0, 4);
    return [
      { title: 'Search',
        items: [{ id: 'go', lead: <SgIcon src={searchIcon} />, label: <>Search for “<b>{text}</b>”</>,
          run: () => { go({ q: text, event: '' }); rememberSearch(text); } }] },
      { title: 'People',
        items: findPeople(text, searchServer, 4).map(p => personItem(p.addr, p.n, text,
          () => { clearAnd({ user: p.addr, adv: true }, `Filtered audit log by user "${p.addr}"`); setUserDraft(p.addr); }, 'p')) },
      { title: 'Actions',
        items: actions.map(o => ({ id: `a-${o.key}`, lead: <SgDot c={colorOf(o.key)} />, label: <Highlight text={o.label} q={text} />,
          sub: categoryOf(o.key), meta: plural(o.n, 'event'),
          run: () => clearAnd({ action: o.key, cat: 'all' }, `Filtered by action "${o.label}"`) })) },
      { title: 'Categories',
        items: cats.map(c => ({ id: `c-${c}`, lead: <SgDot c={CATS[c].c} />, label: <Highlight text={c} q={text} />,
          meta: plural(catN[c], 'event'), run: () => clearAnd({ cat: c, action: '' }, `Filtered audit log by ${c}`) })) },
      { title: 'Targets',
        items: targets.map(t => ({ id: `t-${t.target}`, lead: <SgIcon src={globeIcon} />, label: <Highlight text={t.target} q={text} />,
          meta: plural(t.count, 'event'), run: () => { setSearchDraft(t.target); go({ q: t.target, event: '' }); rememberSearch(t.target); } })) },
      { title: 'Recent searches',
        items: recent.filter(r => r.toLowerCase() !== k && r.toLowerCase().includes(k)).slice(0, 3)
          .map(r => ({ id: `r-${r}`, lead: <SgIcon src={timeIcon} />, label: <Highlight text={r} q={text} />, run: () => { setSearchDraft(r); go({ q: r, event: '' }); } })) },
    ];
  }, [searchDraft, searchServer, recent, route.cat, findPeople, nameOf, photoOf, isOnline, go, email]); // eslint-disable-line react-hooks/exhaustive-deps

  const userGroups = useMemo(() => {
    const text = userDraft.trim();
    const choose = (addr) => {
      setUserDraft(addr);
      go({ user: addr, event: '' }, { replace: true });
      logAuditEvent('in-page-audit', email, '', `Filtered audit log by user "${addr}"`);
    };
    return [{
      title: text ? 'People' : 'Most active in view',
      items: findPeople(text, userServer, 7).map(p => personItem(p.addr, p.n, text, () => choose(p.addr), 'u')),
    }];
  }, [userDraft, userServer, findPeople, nameOf, photoOf, isOnline, go, email]); // eslint-disable-line react-hooks/exhaustive-deps

  const tags = [
    route.cat !== 'all' && ['cat', route.cat, { cat: 'all' }],
    route.action && ['action', metaFor(route.action)[0], { action: '' }],
    route.q && ['q', `“${route.q}”`, { q: '' }],
    route.user && ['user', nameOf(route.user) || route.user, { user: '' }],
    route.from && ['from', `from ${route.from}`, { from: '' }],
    route.to && ['to', `to ${route.to}`, { to: '' }],
  ].filter(Boolean);

  const firstLoad = logs.loading && !logs.data;
  const showEmpty = !logs.loading && !logs.error && logs.data && rows.length === 0;
  const activeUsers = active.data?.users || [];
  const pageNums = useMemo(() => {
    const nums = [...new Set([1, page - 1, page, page + 1, totalPages])].filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);
    return nums.flatMap((p, i) => (i && p - nums[i - 1] > 1 ? [`gap${p}`, p] : [p]));
  }, [page, totalPages]);
  const overlayOpen = !!route.event || !!confirm || showKeys;

  // ── render ─────────────────────────────────────────────────────────────────
  let rowIndex = 0;
  return (
    <div className={`al ${tier === 'full' ? '' : 'lite'}`} ref={rootRef} onMouseOver={showFullText} onMouseOut={hideFullText} onWheel={hideFullText}>
      <div className="scroll" ref={scrollRef} aria-hidden={overlayOpen ? true : undefined}>

        <header className="topbar">
          <button type="button" className="brand" onClick={goHome} title="Audit Log home">
            <img src="/sh_logo.png" alt="GRA SmartHub" draggable={false} />
            <span className="sep" />
            <div className="txt"><div className="t1">Audit Log</div><div className="t2">Global Regulatory Affairs</div></div>
          </button>
          <div className="right">
            {canDelete && <span className="pill edit"><Ic src={lockIcon} size={11} />{forceSilent ? 'Edit mode · silent' : 'Edit mode'}</span>}
            <span className="pill" title="Entries in the audit log">
              <span className={`dot ${stats.error && !stats.data ? 'off' : ''}`} />
              {stats.data ? `${stats.data.total.toLocaleString()} entries recorded` : stats.error ? 'Totals unavailable' : 'Counting entries…'}
            </span>
            <button type="button" className={`switch ${live ? 'on' : ''}`} onClick={toggleLive} aria-pressed={live}
              title="Stream new events as they happen (L)"><span className="knob" />Live</button>
            <button type="button" className={`btn icon ${refreshing ? 'spinning' : ''}`} onClick={refresh} disabled={refreshing}
              title="Refresh" aria-label="Refresh"><Ic src={refreshIcon} /></button>
            <button type="button" className="btn icon" onClick={() => setShowKeys(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
              <span style={{ fontSize: 13 }}>?</span></button>
            <button type="button" className="btn solid" onClick={exportCsv} disabled={exporting} aria-busy={exporting}>
              {exporting ? <><span className="spinner" />Exporting…</> : 'Export CSV'}
            </button>
          </div>
        </header>

        <section className={`hero ${heroStarted ? 'play' : ''}`}>
          <HeroDial ref={heroRef} hourly={dialHourly} mix={analytics.data?.categories} started={heroStarted}
            scrollRoot={scrollRef} tip={tip} onOpenAnalytics={() => { setView('analytics'); scrollToStream(); }} />
          <div className="veil" />
          <div className="hero-in">
            <span className="eyebrow"><span className={`dot ${live ? '' : 'off'}`} />{live ? 'Recording · live' : 'Recording · governed trail'}</span>
            <h1>Nothing happens<br /><em>off the record.</em></h1>
            <p className="lede">Who did what, where and when, across SmartHub. Search it, slice it, export it.</p>
            <button type="button" className="online" onClick={() => { setView('people'); scrollToStream(); }}>
              {activeUsers.length > 0 && (
                <span className="faces">{activeUsers.slice(0, 5).map(u => (
                  <Avatar key={u.email} email={u.email} name={nameOf(u.email)} photo={photoOf(u.email)} />
                ))}</span>
              )}
              <span>{active.data
                ? (activeUsers.length ? <><b>{plural(activeUsers.length, 'person', 'people')}</b> active right now</> : 'Nobody else active right now')
                : active.error ? 'Activity unavailable' : 'Checking who’s active…'}</span>
            </button>
          </div>
        </section>

        <nav className="cmd" ref={cmdRef} aria-label="Audit log filters">
          <div className="cmd-in">
            <div className="tabs" ref={tabsRef} role="tablist" aria-label="Views">
              <SlidingInk wrapRef={tabsRef} activeKey={route.view} attr="data-view" />
              {[['stream', 'Stream', timeIcon], ['analytics', 'Analytics', chartIcon], ['people', 'People', peopleIcon]].map(([v, label, ic]) => (
                <button key={v} type="button" role="tab" data-view={v} aria-selected={route.view === v}
                  className={route.view === v ? 'on' : ''} onClick={() => setView(v)}><Ic src={ic} />{label}</button>
              ))}
            </div>
            <Suggest id="al-sg-search" label="Search suggestions" className="search sg" groups={searchGroups}
              onEnter={() => { const q = searchDraft.trim(); go({ q, event: '' }, { replace: true }); if (q) rememberSearch(q); }}>
              {aria => (
                <>
                  <input ref={searchRef} type="text" value={searchDraft} onChange={e => setSearchDraft(e.target.value)} maxLength={200}
                    aria-label="Search audit events" placeholder="Search people, actions, targets or details" autoComplete="off" {...aria} />
                  <Ic src={searchIcon} />
                  {searchDraft && (
                    <button type="button" className="clear" title="Clear search" aria-label="Clear search"
                      onClick={() => { setSearchDraft(''); searchRef.current?.focus(); }}><Ic src={closeIcon} /></button>
                  )}
                  <span className="kbd" aria-hidden="true">/</span>
                </>
              )}
            </Suggest>
            <Segmented label="Time range" options={[['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'All']]} value={route.range} onChange={setRange} />
            <button type="button" className={`btn filters ${route.adv ? 'on' : ''}`} aria-expanded={route.adv} onClick={() => go({ adv: !route.adv }, { replace: true })}>
              <Ic src={filterIcon} size={13} />Filters{advCount > 0 && <span className="badge-n">{advCount}</span>}
            </button>
          </div>
          <div className="cmd-in">
            <div className="chips" role="group" aria-label="Category">
              <button type="button" className={`chip ${route.cat === 'all' && !route.action ? 'on' : ''}`} onClick={() => setCategory('all')}
                aria-pressed={route.cat === 'all' && !route.action}>
                All events {analytics.data && <b className="num">{catTotal.toLocaleString()}</b>}
              </button>
              {/* hide a category with no events in this range, unless it's the one picked */}
              {CAT_NAMES.filter(c => !analytics.data || catCounts[c] > 0 || route.cat === c).map(c => (
                <button key={c} type="button" className={`chip ${route.cat === c ? 'on' : ''}`} style={{ '--c': CATS[c].c }}
                  onClick={() => setCategory(c)} aria-pressed={route.cat === c}>
                  <i />{c} {analytics.data && <b className="num">{(catCounts[c] || 0).toLocaleString()}</b>}
                </button>
              ))}
            </div>
            <ActionPicker value={route.action} onChange={setAction} unavailable={!!actionTypes.error && !actionTypes.data}
              options={route.action && !actionOptions.some(a => a.key === route.action)
                ? [...actionOptions, { key: route.action, label: metaFor(route.action)[0] }] : actionOptions} />
          </div>
          <div className={`adv ${route.adv ? 'open' : ''}`}>
            <div inert={!route.adv}>
              <div className="adv-in">
                <Suggest id="al-sg-user" label="People" className="sg" groups={userGroups}
                  onEnter={() => go({ user: userDraft.trim(), event: '' }, { replace: true })}>
                  {aria => (
                    <input className="field" type="text" value={userDraft} onChange={e => setUserDraft(e.target.value)} maxLength={200}
                      placeholder="Person or email" aria-label="Filter by person" autoComplete="off" style={{ width: 230 }} {...aria} />
                  )}
                </Suggest>
                <span className="cap">From</span>
                <input className="field" type="date" value={route.from} max={route.to || undefined} aria-label="From date"
                  onChange={e => go({ from: e.target.value, event: '' }, { replace: true })} />
                <span className="cap">To</span>
                <input className="field" type="date" value={route.to} min={route.from || undefined} aria-label="To date"
                  onChange={e => go({ to: e.target.value, event: '' }, { replace: true })} />
                <div className="views">
                  <button type="button" style={{ borderStyle: 'solid' }} onClick={clearAll}>Clear all</button>
                </div>
              </div>
            </div>
          </div>
          <div className={`progress ${(logs.loading && logs.data) || (route.view === 'analytics' && analytics.loading && analytics.data) || (route.view === 'people' && people.loading && people.data) ? 'on' : ''}`} aria-hidden="true"><span /></div>
        </nav>

        <main className="wrap">
          {route.view === 'stream' && (
            <div className="stream-grid">
              <div className={`stream-col ${canDelete ? 'editing' : ''}`}>
                <div className="summary">
                  <span className="count num">{logs.data ? total.toLocaleString() : '—'}</span>
                  <span className="of">{total === 1 ? 'event' : 'events'} · {RANGE_LABEL[route.range]}</span>
                  {tags.map(([k, label, patch]) => (
                    <span key={k} className="tag"><span>{label}</span>
                      <button type="button" aria-label={`Remove ${label} filter`} onClick={() => go({ ...patch, event: '' })}><Ic src={closeIcon} /></button>
                    </span>
                  ))}
                  {tags.length > 1 && <button type="button" className="linkbtn" onClick={clearAll}>Clear all</button>}
                  <span className="spacer" />
                  {canDelete && (
                    <button type="button" className="btn" style={{ height: 30 }} onClick={selectAllMatching} disabled={selectingAll || !total}>
                      {selectingAll ? 'Selecting…' : selected.size ? 'Clear selection' : `Select all ${total.toLocaleString()}`}
                    </button>
                  )}
                  <span className="cap">Group</span>
                  <Segmented label="Group by" options={GROUPS.map(g => [g, g])} value={route.group} onChange={g => go({ group: g }, { replace: true })} />
                </div>

                {canDelete && (
                  <div className="banner"><Ic src={lockIcon} /><span className="grow"><b>Admin edit mode.</b>{' '}
                    {forceSilent ? 'Deletions are permanent and are NOT written to the log.' : 'Deletions are permanent and are themselves written to the log.'}</span></div>
                )}

                {logs.error && logs.data && <InlineError error={logs.error} onRetry={logs.reload} what="events" />}

                {firstLoad && (
                  <div aria-busy="true" aria-label="Loading audit events">
                    {Array.from({ length: 7 }, (_, i) => <div key={i} className="skel skel-row" style={{ animationDelay: `${i * 70}ms` }} />)}
                  </div>
                )}

                {!logs.data && logs.error && <ErrorCard error={logs.error} onRetry={logs.reload} />}

                {showEmpty && (
                  <div className="empty"><div className="orbit" /><div className="big">Nothing matches these filters</div>
                    <p>Widen the time range or clear the search to see more.</p>
                    <div className="acts"><button type="button" className="btn solid" onClick={clearAll}>Reset filters</button></div></div>
                )}

                {rows.length > 0 && groups.map(g => {
                  const s = g.sample;
                  const cat = categoryOf(s.action);
                  const head = route.group === 'User'
                    ? { lead: <Avatar email={s.performed_by} name={nameOf(s.performed_by)} photo={photoOf(s.performed_by)} online={isOnline(s.performed_by)} />,
                      label: nameOf(s.performed_by) || s.performed_by || '—', sub: s.performed_by || '' }
                    : route.group === 'Action'
                      ? { lead: <Ic src={iconOf(s.action)} style={{ color: colorOf(s.action) }} />, label: metaFor(s.action)[0], sub: cat }
                      : { lead: null, label: dayLabel(s.timestamp), sub: new Date(s.timestamp).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) };
                  return (
                    <section key={g.key} className="group" aria-label={head.label}>
                      <div className="group-h">{head.lead}<span className="gl">{head.label}</span><span className="gs">{head.sub}</span>
                        <span className="line" /><span className="gc num">{plural(g.items.length, 'event')}</span></div>
                      <div className={`tl ${logs.loading ? 'dim' : ''}`}>
                        {g.items.map((log) => {
                          const i = rowIndex++;
                          return (
                            <EventRow key={log.id} log={log} index={i} q={route.q} selected={route.event === log.id} focused={focusIdx === i}
                              fresh={fresh.has(log.id)} canDelete={canDelete} checked={selected.has(log.id)} onToggle={toggleOne} onOpen={openEvent}
                              name={nameOf(log.performed_by)} photo={photoOf(log.performed_by)} online={isOnline(log.performed_by)} />
                          );
                        })}
                      </div>
                    </section>
                  );
                })}

                {rows.length > 0 && (
                  <nav className="pager" aria-label="Pagination">
                    <span className="muted">Showing {((page - 1) * PAGE_SIZE + 1).toLocaleString()}–{Math.min(page * PAGE_SIZE, total).toLocaleString()} of {total.toLocaleString()}</span>
                    <div className="pg">
                      <button type="button" onClick={() => changePage(page - 1)} disabled={page === 1} aria-label="Previous page">←</button>
                      {pageNums.map(p => (typeof p === 'string'
                        ? <button key={p} type="button" disabled aria-hidden="true">…</button>
                        : <button key={p} type="button" className={p === page ? 'on' : ''} disabled={p === page} aria-current={p === page ? 'page' : undefined}
                          onClick={() => changePage(p)}>{p}</button>))}
                      <button type="button" onClick={() => changePage(page + 1)} disabled={page === totalPages} aria-label="Next page">→</button>
                    </div>
                  </nav>
                )}
              </div>

              <Rail analytics={analytics.data} analyticsLoading={analytics.loading} active={active.data} activeLoading={active.loading}
                nameOf={nameOf} photoOf={photoOf} isOnline={isOnline} tip={tip} onUser={setUserFilter} onCat={setCategory} onOpen={openEvent} />
            </div>
          )}

          {route.view === 'analytics' && (
            <AnalyticsView res={analytics} today={!route.q && !route.action && route.cat === 'all' && !route.user && !route.from && !route.to ? today : null} nameOf={nameOf} photoOf={photoOf} onlineSet={onlineSet} tip={tip}
              onCat={(c) => { setCategory(c); go({ view: 'stream' }); }}
              onAction={(a) => { setAction(a); go({ view: 'stream' }); }}
              onUser={setUserFilter} onOpen={openEvent} />
          )}

          {route.view === 'people' && (
            <PeopleView res={people} nameOf={nameOf} photoOf={photoOf} onlineSet={onlineSet} onUser={setUserFilter} onClear={clearAll} />
          )}
        </main>

        <footer className="foot">
          <span>Shortcuts: <span className="kbd">/</span> search · <span className="kbd">J</span><span className="kbd">K</span> move · <span className="kbd">↵</span> open · <span className="kbd">←</span><span className="kbd">→</span> page · <span className="kbd">Esc</span> close · <span className="kbd">?</span> all</span>
          <span className="r">Filters live in the URL, so a copied link opens this exact view.</span>
        </footer>
      </div>

      <button type="button" className={`newpill ${unseen > 0 && route.view === 'stream' ? 'show' : ''}`} inert={!(unseen > 0 && route.view === 'stream')}
        onClick={() => { setUnseen(0); changePage(1); }}><i />{plural(unseen, 'new event')}</button>

      <div className={`scrim ${route.event ? 'show' : ''}`} onClick={closeEvent} aria-hidden="true" />
      <aside ref={drawerRef} className={`drawer ${route.event ? 'show' : ''}`} role="dialog" aria-modal="true" aria-label="Event detail"
        inert={!route.event} style={{ '--c': shownDetail ? colorOf(shownDetail.action) : ACCENT.gray }}>
        {route.event && !shownDetail && !(context.error && !context.loading && context.sig === JSON.stringify([route.event])) && (
          <><div className="dr-head"><button type="button" className="btn icon x" onClick={closeEvent} aria-label="Close"><Ic src={closeIcon} size={12} /></button>
            <div style={{ height: 70 }}><SkeletonLines n={3} /></div></div>
          <div className="dr-body"><SkeletonLines n={6} /></div></>
        )}
        {route.event && !shownDetail && context.error && !context.loading && context.sig === JSON.stringify([route.event]) && (
          <><div className="dr-head"><button type="button" className="btn icon x" onClick={closeEvent} aria-label="Close"><Ic src={closeIcon} size={12} /></button>
            <h2 style={{ fontSize: 22 }}>Event unavailable</h2></div>
          <div className="dr-empty"><div><p className="muted" style={{ marginBottom: 16 }}>
            {context.error?.status === 404 ? 'This entry no longer exists. It may have been deleted.' : describeError(context.error) || 'This event couldn’t be loaded.'}</p>
            {context.error?.status !== 404 && <button type="button" className="btn solid" onClick={context.reload}>Try again</button>}</div></div></>
        )}
        {shownDetail && (
          <EventDetail key={shownDetail.id} log={shownDetail} name={nameOf(shownDetail.performed_by)} photo={photoOf(shownDetail.performed_by)}
            online={isOnline(shownDetail.performed_by)}
            around={context.data?.event?.id === shownDetail.id ? context.data.around : null} aroundLoading={context.loading} aroundError={context.error}
            canDelete={canDelete} deleting={deleting}
            hasPrev={detailIdx > 0} hasNext={detailIdx >= 0 && detailIdx < rows.length - 1}
            onPrev={() => detailIdx > 0 && openEvent(rows[detailIdx - 1].id)}
            onNext={() => detailIdx >= 0 && rows[detailIdx + 1] && openEvent(rows[detailIdx + 1].id)}
            onClose={closeEvent} onOpen={openEvent}
            onFilterUser={() => { closeEvent(); setUserFilter(shownDetail.performed_by); }}
            onDelete={() => setConfirm({ ids: [shownDetail.id] })} />
        )}
      </aside>

      <div className={`bulk ${canDelete && selected.size > 0 ? 'show' : ''}`} inert={!(canDelete && selected.size > 0)}>
        <span><b className="num">{selected.size.toLocaleString()}</b> selected</span>
        <button type="button" className="btn ghost" onClick={() => setSelected(new Set())}>Clear</button>
        <button type="button" className="btn solid" onClick={() => setConfirm({ ids: [...selected] })} disabled={deleting}>
          <Ic src={deleteIcon} size={13} />Delete selected</button>
      </div>

      <div className={`modal-bg ${confirm || showKeys ? 'show' : ''}`} onClick={e => { if (e.target === e.currentTarget && !deleting) { setConfirm(null); setShowKeys(false); } }}>
        {confirm && (
          <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="al-confirm-t">
            <div className="mi"><Ic src={deleteIcon} /></div>
            <h3 id="al-confirm-t">Delete {plural(confirm.ids.length, 'entry', 'entries')}?</h3>
            <p>This can’t be undone. {forceSilent ? 'Silent mode: the deletion will NOT be written to the audit log.' : 'The deletion itself is written to the audit log under your name.'}</p>
            <div className="acts">
              <button type="button" className="btn" onClick={() => setConfirm(null)} disabled={deleting} autoFocus>Cancel</button>
              <button type="button" className="btn solid" onClick={() => runDelete(confirm.ids)} disabled={deleting}>
                {deleting ? <><span className="spinner" />Deleting…</> : 'Delete permanently'}</button>
            </div>
          </div>
        )}
        {!confirm && showKeys && (
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="al-keys-t">
            <h3 id="al-keys-t">Keyboard shortcuts</h3>
            <p style={{ marginBottom: 16 }}>Work the log without leaving the keyboard.</p>
            <div className="keys">
              <span><span className="kbd">/</span></span><span>Focus search</span>
              <span><span className="kbd">J</span><span className="kbd">K</span></span><span>Move down / up (or next / previous in the detail panel)</span>
              <span><span className="kbd">↵</span></span><span>Open focused event</span>
              <span><span className="kbd">←</span><span className="kbd">→</span></span><span>Previous / next page</span>
              <span><span className="kbd">1</span><span className="kbd">2</span><span className="kbd">3</span></span><span>Stream · Analytics · People</span>
              <span><span className="kbd">L</span></span><span>Live on / off</span>
              <span><span className="kbd">Esc</span></span><span>Close panel</span>
            </div>
            <div className="acts"><button type="button" className="btn solid" onClick={() => setShowKeys(false)} autoFocus>Got it</button></div>
          </div>
        )}
      </div>

      <div className={`toast ${toast && !toast.hide ? 'show' : ''} ${toast?.bad ? 'bad' : ''}`} role="status" aria-live="polite">
        <i>{toast?.bad ? '!' : '✓'}</i><span>{toast?.msg}</span>
      </div>
      <div className="tip" ref={tip.ref} />
      <Intro show={intro} ready={!!logs.data || !!logs.error} onDone={finishIntro} />
    </div>
  );
}

const Rail = memo(function Rail({ analytics, analyticsLoading, active, activeLoading, nameOf, photoOf, isOnline, tip, onUser, onCat, onOpen }) {
  const activeUsers = active?.users || [];
  const railMix = useMemo(() => mixFrom(analytics?.actions), [analytics]);
  const railTop = useMemo(() => (analytics?.actors || []).slice(0, 5).map(x => ({ key: x.email, count: x.count })), [analytics]);
  return (
    <aside className="rail" aria-label="Summary">
      <div className="card">
        <div className="card-h"><span className="cap">Event mix · these results</span></div>
        <div className="card-b">
          {!analytics ? (analyticsLoading ? <SkeletonLines n={4} /> : <div className="ok">Unavailable.</div>)
            : railMix.length === 0 ? <div className="ok">Nothing to break down yet.</div> : (
              <div className="donut">
                <Donut mix={railMix} total={analytics.matched ?? 0} onPick={onCat} tip={tip} />
                <div className="mix-list">
                  {railMix.map(m => (
                    <button key={m.cat} type="button" style={{ '--c': CATS[m.cat].c }} onClick={() => onCat(m.cat)}>
                      <i />{m.cat}<b className="num">{Math.round((m.count / (analytics.matched || 1)) * 100)}%</b>
                    </button>
                  ))}
                </div>
              </div>
            )}
        </div>
      </div>
      <div className="card" style={{ animationDelay: '.07s' }}>
        <div className="card-h"><span className="cap">Active now</span>
          <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--green)' }}>
            <span className={`dot ${activeUsers.length ? '' : 'off'}`} />{active ? `${active.count} online` : '—'}</span></div>
        <div className="card-b">
          {!active && activeLoading ? <SkeletonLines n={3} />
            : !active ? <div className="ok">Activity unavailable.</div>
              : activeUsers.length === 0 ? <div className="ok">Nobody active in the last {active.timeout_minutes ?? 5} minutes.</div>
                : activeUsers.map(u => (
                  <button key={u.email} type="button" className="prow" onClick={() => onUser(u.email)}>
                    <Avatar email={u.email} name={nameOf(u.email)} photo={photoOf(u.email)} online />
                    <span style={{ minWidth: 0, flex: 1 }}><div className="n">{nameOf(u.email) || u.email}</div>{nameOf(u.email) && <div className="e">{u.email}</div>}</span>
                  </button>
                ))}
        </div>
      </div>
      <div className="card" style={{ animationDelay: '.14s' }}>
        <div className="card-h"><span className="cap">Needs a look</span>
          {analytics && <span className="muted" style={{ color: analytics.sensitive_count ? 'var(--maroon)' : undefined }}>
            {plural(analytics.sensitive_count || 0, 'sensitive event')}</span>}</div>
        <div className="card-b">
          {!analytics ? (analyticsLoading ? <SkeletonLines n={3} /> : <div className="ok">Unavailable.</div>)
            : <WatchList items={(analytics.sensitive || []).slice(0, 4)} nameOf={nameOf} onOpen={onOpen} />}
        </div>
      </div>
      <div className="card" style={{ animationDelay: '.21s' }}>
        <div className="card-h"><span className="cap">Most active</span></div>
        <div className="card-b">
          {!analytics ? (analyticsLoading ? <SkeletonLines n={4} /> : <div className="ok">Unavailable.</div>) : (
            <BarList rows={railTop} onPick={onUser} colorOf={avatarInk}
              leadOf={k => <Avatar email={k} name={nameOf(k)} photo={photoOf(k)} online={isOnline(k)} small />}
              labelOf={k => nameOf(k) || k} empty="Nobody in range." />
          )}
        </div>
      </div>
    </aside>
  );
});

const EventRow = memo(function EventRow({ log, index, q, selected, focused, fresh, canDelete, checked, onToggle, onOpen, name, photo, online }) {
  const [label] = metaFor(log.action);
  const sens = SENSITIVE.has(log.action);
  const who = log.performed_by || '';
  const cls = ['row', selected && 'sel', focused && 'kf', sens && 'sens', fresh && 'fresh'].filter(Boolean).join(' ');
  return (
    <div className={cls} style={{ '--c': colorOf(log.action), animationDelay: fresh ? undefined : `${Math.min(index, 14) * 30}ms` }}>
      {canDelete && (
        <input type="checkbox" className="pick" checked={checked} aria-label={`Select ${label} at ${hhmmss(log.timestamp)}`} onChange={() => onToggle(log.id)} />
      )}
      <div className="when"><div className="t num"><Clock iso={log.timestamp} /></div><div className="r">{relTime(log.timestamp)}</div></div>
      <span className="node" aria-hidden="true" />
      <button type="button" className="ev" onClick={() => onOpen(log.id)} aria-label={`${label} by ${name || who || 'unknown'} at ${hhmmss(log.timestamp)}`}>
        <span className="badge"><Ic src={iconOf(log.action)} /></span>
        <span className="main">
          <span className="top">
            <span className="lbl"><Highlight text={label} q={q} /></span>
            {log.target && <span className="tgt"><Highlight text={log.target} q={q} /></span>}
            {sens && <span className="flag"><Ic src={alertIcon} />Sensitive</span>}
            {fresh && <span className="new">New</span>}
          </span>
          <span className="det" style={{ display: 'block' }}><Highlight text={log.details || '—'} q={q} /></span>
        </span>
        <span className="who">
          <Avatar email={who} name={name} photo={photo} online={online} />
          <span style={{ minWidth: 0 }}>
            <span className="n" style={{ display: 'block' }}><Highlight text={name || who || '—'} q={q} /></span>
            {name && <span className="e" style={{ display: 'block' }}><Highlight text={who} q={q} /></span>}
          </span>
        </span>
        <Ic src={chevronIcon} className="chev" />
      </button>
    </div>
  );
});

function EventDetail({ log, name, photo, online, around, aroundLoading, aroundError, canDelete, deleting, hasPrev, hasNext,
  onPrev, onNext, onClose, onOpen, onFilterUser, onDelete }) {
  const [label] = metaFor(log.action);
  const cat = categoryOf(log.action);
  const when = new Date(log.timestamp);
  const meta = [
    ['Target', log.target || '—'],
    ['Category', cat],
    ['Action key', log.action],
  ];
  return (
    <>
      <div className="dr-head">
        <button type="button" className="btn icon x" onClick={onClose} title="Close (Esc)" aria-label="Close"><Ic src={closeIcon} size={12} /></button>
        <div className="cat"><Ic src={iconOf(log.action)} />{cat}{SENSITIVE.has(log.action) && <span style={{ color: 'var(--maroon)' }}> · Sensitive</span>}</div>
        <h2>{label}</h2>
        <div className="when"><b className="num"><Clock iso={log.timestamp} /></b>
          {when.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · {relTime(log.timestamp)}</div>
      </div>
      <div className="dr-body">
        <div className="whobox">
          <Avatar email={log.performed_by} name={name} photo={photo} online={online} />
          <div style={{ minWidth: 0 }}><div className="n">{name || log.performed_by || '—'}</div>{name && <div className="e">{log.performed_by}</div>}</div>
          {log.performed_by && <button type="button" className="btn" onClick={onFilterUser}>All by this person</button>}
        </div>
        <div className="quote">{log.details || 'No details recorded for this event.'}</div>
        <div className="meta">
          {meta.map(([k, v]) => <div key={k}><div className="k">{k}</div><div className="v">{v}</div></div>)}
        </div>
        <div>
          <div className="cap" style={{ marginBottom: 8 }}>Around this moment · same person</div>
          {around ? (
            <div className="ctx">
              {around.map(x => (
                <button key={x.id} type="button" className={x.id === log.id ? 'me' : ''} disabled={x.id === log.id}
                  style={{ '--c': colorOf(x.action) }} onClick={() => onOpen(x.id)}>
                  <i /><span className="l">{metaFor(x.action)[0]}</span><span className="d">{x.details || x.target || '—'}</span>
                  <span className="t num">{relTime(x.timestamp)}</span>
                </button>
              ))}
            </div>
          ) : aroundLoading ? <SkeletonLines n={3} /> : <div className="ok">{describeError(aroundError) || 'Unavailable.'}</div>}
        </div>
      </div>
      <div className="dr-foot">
        {canDelete && <button type="button" className="btn danger" onClick={onDelete} disabled={deleting}><Ic src={deleteIcon} size={13} />Delete</button>}
        <div className="dr-nav">
          <button type="button" className="btn icon" onClick={onPrev} disabled={!hasPrev} title="Newer (K)" aria-label="Newer event">↑</button>
          <button type="button" className="btn icon" onClick={onNext} disabled={!hasNext} title="Older (J)" aria-label="Older event">↓</button>
        </div>
      </div>
    </>
  );
}