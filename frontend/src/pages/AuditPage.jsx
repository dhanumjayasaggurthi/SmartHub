import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useRBAC } from '../context/RBACContext';
import { useMsal } from '@azure/msal-react';
import { logAuditEvent } from '../utils/auditLog';
import { apiFetch } from '../utils/apiClient';

import auditIcon from "/icons/JJ_Icon_Stationery_RGB.svg";

const PAGE_SIZE = 20;

// The only hex values in this file. They are the Tailwind palette from
// tailwind.config.js, repeated here because dots, bars and row accents are
// coloured per event at runtime and a class name can't be built dynamically.
const ACCENT = {
  red:    '#eb1700',  // jj-red
  maroon: '#9e0000',  // jj-maroon-05
  green:  '#328714',  // jj-green-03
  blue:   '#0f68b2',  // jj-blue-03
  orange: '#ff6017',  // jj-orange-03
  violet: '#8c3bbb',  // jj-violet-03
  gray:   '#6e6259',  // jj-gray-07
};

// action key → [label, accent]
const ACTION_META = {
  role_assigned:   ['Role Assigned',   ACCENT.green],
  role_removed:    ['Role Removed',    ACCENT.maroon],
  role_created:    ['Role Created',    ACCENT.blue],
  role_updated:    ['Role Updated',    ACCENT.orange],
  role_reset:      ['Role Reset',      ACCENT.violet],
  role_deleted:    ['Role Deleted',    ACCENT.maroon],
  role_access_customized: ['Access Customized', ACCENT.violet],
  role_access_reset:      ['Access Reset',      ACCENT.gray],
  user_login:      ['User Login',      ACCENT.green],
  user_logout:     ['User Logout',     ACCENT.gray],
  session_timeout: ['Session Timeout', ACCENT.orange],
  page_access:     ['Page Access',     ACCENT.violet],
  page_refreshed:  ['Page Refreshed',  ACCENT.blue],
  audit_log_deleted:        ['Log Entry Deleted', ACCENT.maroon],
  audit_edit_mode_accessed: ['Audit Edit Mode',   ACCENT.maroon],
  'in-page-audit':                ['In-Page Audit', ACCENT.blue],
  'in-page-extraction-pipelines': ['Pipeline Run',  ACCENT.violet],
  bdc_review_accepted: ['Rule Approved', ACCENT.green],
  bdc_review_rejected: ['Rule Rejected', ACCENT.maroon],
  bdc_review_failed_rows_downloaded: ['Failed Rows Downloaded', ACCENT.blue],
  bdc_review_failed_rows_viewed:     ['Failed Rows Viewed',     ACCENT.violet],
  communication_sent:             ['Communication Sent', ACCENT.green],
  communication_test_sent:        ['Communication Test', ACCENT.gray],
  communication_template_created: ['Template Created',   ACCENT.blue],
  communication_template_updated: ['Template Updated',   ACCENT.orange],
  communication_template_deleted: ['Template Deleted',   ACCENT.maroon],
};

const CATS = ['Roles', 'Access', 'Data', 'Navigation', 'Admin'];
const CAT_COLOR = {
  Roles: ACCENT.red, Access: ACCENT.green, Data: ACCENT.blue,
  Navigation: ACCENT.violet, Admin: ACCENT.orange,
};

// Mirrors _CATEGORY_SQL in backend/audit.py — if you add a bucket there, add it here.
const categoryOf = (action = '') => {
  if (action.startsWith('role_')) return 'Roles';
  if (['user_login', 'user_logout', 'session_timeout'].includes(action)) return 'Access';
  if (action.startsWith('audit_')) return 'Admin';
  if (action.startsWith('page_') || action.startsWith('in-page')) return 'Navigation';
  return 'Data';
};

// Anything the log contains that isn't in ACTION_META yet still needs a
// readable label — 'BDC_COMPILATION_STARTED' reads as 'Bdc Compilation Started'
// rather than shouting from the dropdown.
const prettify = (key = '') =>
  key.toLowerCase().replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const metaFor = (action = '') =>
  ACTION_META[action] || ACTION_META[action.toLowerCase()] || [prettify(action), ACCENT.gray];

const hhmmss = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour12: false }) : '—');

const relTime = (iso) => {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`;
};

const dayLabel = (iso) => {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' });
};

const initialsOf = (name = '') =>
  name.split(/[\s._@]/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';

// Stable colour per person, picked from the palette above
const AVATAR_INK = [ACCENT.blue, ACCENT.green, ACCENT.violet, ACCENT.maroon, ACCENT.orange, ACCENT.gray];
const avatarInk = (email = '') => {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) % 997;
  return AVATAR_INK[h % AVATAR_INK.length];
};

// ── shared class strings ─────────────────────────────────────────────────────
const CARD    = 'bg-white rounded-xl border border-jj-gray-02';
const CAP     = 'font-johnson-text text-xs uppercase tracking-widest text-jj-gray-07';
const BIG_NUM = 'font-johnson-display font-light text-2xl leading-none text-jj-gray-08 tabular-nums';
const META    = 'font-johnson-text text-xs text-jj-gray-07';
const BODY    = 'font-johnson-text text-sm text-jj-gray-08';

const BTN_GHOST = 'h-8 px-3 rounded-lg border border-jj-gray-02 bg-white font-johnson-text text-xs text-jj-gray-07 hover:bg-jj-gray-01 transition-colors disabled:opacity-40';
const BTN_SOLID = 'h-8 px-4 rounded-lg border border-jj-red bg-jj-red font-johnson-text text-xs text-white hover:bg-jj-maroon-05 transition-colors disabled:opacity-40';
const FIELD     = 'h-9 px-3 rounded-lg border border-jj-gray-02 bg-white font-johnson-text text-xs text-jj-gray-08 outline-none focus:border-jj-red';

const chipCls = (active) =>
  `h-8 px-3 rounded-full border font-johnson-text text-xs transition-colors ${
    active ? 'bg-jj-red border-jj-red text-white' : 'bg-white border-jj-gray-02 text-jj-gray-07 hover:bg-jj-gray-01'}`;

const segCls = (active) =>
  `h-6 px-3 rounded-md border-0 font-johnson-text text-xs transition-colors ${
    active ? 'bg-white text-jj-red' : 'bg-transparent text-jj-gray-07 hover:text-jj-gray-08'}`;

const tabCls = (active) =>
  `h-14 px-4 border-0 bg-transparent font-johnson-text text-sm transition-colors border-b-2 ${
    active ? 'text-jj-gray-08 border-jj-red' : 'text-jj-gray-07 border-transparent hover:text-jj-gray-08'}`;

const pagerCls = (disabled) =>
  `h-8 px-3 rounded-lg border border-jj-gray-02 bg-white font-johnson-text text-xs text-jj-gray-07 transition-colors ${
    disabled ? 'opacity-40 cursor-default' : 'hover:bg-jj-gray-01'}`;

const SAVED_VIEWS = [
  { label: 'Security review', patch: { cat: 'Roles',      range: '7d',  q: '' } },
  { label: 'Access issues',   patch: { cat: 'Access',     range: '7d',  q: 'timeout' } },
  { label: 'Admin trail',     patch: { cat: 'Admin',      range: 'all', q: '' } },
  { label: 'Rule decisions',  patch: { cat: 'Data',       range: '30d', q: 'rule' } },
  { label: 'Navigation',      patch: { cat: 'Navigation', range: '24h', q: '' } },
];

const Avatar = ({ email, name, photo, box = 'w-7 h-7', text = 'text-xs' }) => {
  const ink = avatarInk(email);
  return (
    <span
      className={`${box} ${text} shrink-0 rounded-full inline-flex items-center justify-center overflow-hidden font-johnson-display font-medium`}
      style={{ backgroundColor: `${ink}14`, color: ink }}
    >
      {photo
        ? <img src={photo} alt={name || email} className={`${box} object-cover`} />
        : initialsOf(name || email)}
    </span>
  );
};

let lastAuditEditAccessLog = { path: null, at: 0 };

export default function AuditPage({ editable = false, forceSilent = false }) {
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
    logAuditEvent(
      'audit_edit_mode_accessed', email, path,
      forceSilent ? 'Navigated to Audit Log Edit Mode (silent deletions)' : 'Navigated to Audit Log Edit Mode'
    );
  }, [editable, forceSilent]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── URL is the source of truth for everything the server filters on, so a
  // filtered view can be pasted into a ticket and land on the same rows ──────
  const [params, setParams] = useSearchParams();
  const route = useMemo(() => ({
    view:  params.get('view') === 'analytics' ? 'analytics' : 'stream',
    q:      params.get('q') || '',
    cat:    params.get('cat') || 'all',
    action: params.get('action') || '',
    range: params.get('range') || '7d',
    group: params.get('group') || 'Time',
    page:  Math.max(1, parseInt(params.get('page') || '1', 10) || 1),
    user:  params.get('user') || '',
    from:  params.get('from') || '',
    to:    params.get('to') || '',
    adv:   params.get('adv') === '1',
    event: params.get('event') || '',
  }), [params]);

  const go = useCallback((patch, { replace = false } = {}) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      Object.entries(patch).forEach(([k, v]) => {
        const empty = v === '' || v === null || v === undefined || v === false
          || (k === 'page' && v === 1) || (k === 'cat' && v === 'all')
          || (k === 'range' && v === '7d') || (k === 'group' && v === 'Time')
          || (k === 'view' && v === 'stream');
        if (empty) next.delete(k);
        else next.set(k, v === true ? '1' : String(v));
      });
      return next;
    }, { replace });
  }, [setParams]);

  const [logs, setLogs]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [deleting, setDeleting]       = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectingAll, setSelectingAll] = useState(false);

  const [stats, setStats]         = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [actionTypes, setActionTypes] = useState([]);
  const [activeUsers, setActiveUsers] = useState(null);
  const [userNames, setUserNames] = useState({});
  const [userPhotos, setUserPhotos] = useState({});
  const [toast, setToast] = useState('');

  const photoUrlsRef = useRef({});
  const askedRef = useRef({});
  const toastRef = useRef(null);
  const searchRef = useRef(null);

  // Search box types locally and lands in the URL a beat later, so every
  // keystroke doesn't fire a request (and doesn't spam the audit log).
  const [searchDraft, setSearchDraft] = useState(route.q);
  useEffect(() => { setSearchDraft(route.q); }, [route.q]);

  const flash = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setToast(''), 2400);
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(route.page, totalPages);

  const filterParams = useCallback((extra = {}) => new URLSearchParams({
    ...(route.q      && { search: route.q }),
    ...(route.action && { action: route.action }),
    ...(route.cat !== 'all'   && { category: route.cat }),
    ...(route.range !== 'all' && { range: route.range }),
    ...(route.user   && { performed_by: route.user }),
    ...(route.from   && { date_from: route.from }),
    ...(route.to     && { date_to: route.to }),
    ...extra,
  }), [route.q, route.action, route.cat, route.range, route.user, route.from, route.to]);

  // ── data ────────────────────────────────────────────────────────────────────
  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/audit/logs?${filterParams({ page: route.page, page_size: PAGE_SIZE })}`);
      if (!res.ok) throw new Error(`GET /api/audit/logs — ${res.status} ${res.statusText}`);
      const data = await res.json();
      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.message);
      setLogs([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [filterParams, route.page]);

  const fetchAnalytics = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/audit/analytics?${filterParams()}`);
      if (res.ok) setAnalytics(await res.json());
    } catch { /* charts are secondary — the stream still works without them */ }
  }, [filterParams]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await apiFetch('/api/audit/stats');
      if (res.ok) setStats(await res.json());
    } catch { /* silent */ }
  }, []);

  // DISTINCT action from the log, so the dropdown only ever offers choices
  // that can actually return rows.
  const fetchActionTypes = useCallback(async () => {
    try {
      const res = await apiFetch('/api/audit/actions');
      if (res.ok) {
        const data = await res.json();
        setActionTypes((data.actions || [])
          .map(key => ({ key, label: metaFor(key)[0] }))
          .sort((a, b) => a.label.localeCompare(b.label)));
      }
    } catch { /* dropdown just falls back to "All actions" */ }
  }, []);

  const fetchActiveUsers = useCallback(async () => {
    try {
      const res = await apiFetch('/api/audit/active-users');
      if (res.ok) setActiveUsers(await res.json());
    } catch { /* silent */ }
  }, []);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);
  useEffect(() => { fetchAnalytics(); }, [fetchAnalytics]);
  useEffect(() => { fetchStats(); }, [fetchStats]);
  useEffect(() => { fetchActionTypes(); }, [fetchActionTypes]);

  useEffect(() => {
    fetchActiveUsers();
    const t = setInterval(fetchActiveUsers, 30_000);
    return () => clearInterval(t);
  }, [fetchActiveUsers]);

  useEffect(() => { setSelectedIds([]); }, [route.q, route.action, route.cat, route.range, route.user, route.from, route.to]);

  // Narrowing the filters can leave us past the last page — step back instead
  // of showing an empty stream with "page 7 of 2" underneath it.
  useEffect(() => {
    if (!loading && !error && total > 0 && route.page > Math.ceil(total / PAGE_SIZE)) {
      go({ page: 1 }, { replace: true });
    }
  }, [loading, error, total, route.page, go]);

  // ── display names + photos from Graph ───────────────────────────────────────
  const resolvePeople = useCallback(async (emails) => {
    // askedRef keeps us from hammering Graph for people who simply have no
    // photo or no directory entry — one lookup per address per session.
    const wanted = [...new Set(emails.filter(e => e && e.includes('@')))]
      .filter(e => !askedRef.current[e.toLowerCase()])
      .slice(0, 40);
    if (!wanted.length || !accounts.length) return;
    wanted.forEach(e => { askedRef.current[e.toLowerCase()] = true; });

    try {
      const tokenRes = await instance.acquireTokenSilent({ scopes: ['User.Read.All'], account: accounts[0] });
      const auth = { Authorization: `Bearer ${tokenRes.accessToken}` };

      const results = await Promise.all(wanted.map(async (addr) => {
        const key = addr.toLowerCase();
        const out = { key };
        try {
          const r = await fetch(
            `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(addr)}?$select=displayName`,
            { headers: auth }
          );
          if (r.ok) out.name = (await r.json()).displayName;
        } catch { /* leave the email showing */ }
        try {
          const r = await fetch(
            `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(addr)}/photo/$value`,
            { headers: auth }
          );
          if (r.ok) out.photo = URL.createObjectURL(await r.blob());
        } catch { /* initials avatar instead */ }
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
      // token failed — let these addresses be retried on the next page of logs
      wanted.forEach(e => { delete askedRef.current[e.toLowerCase()]; });
    }
  }, [accounts, instance]);

  useEffect(() => {
    resolvePeople(logs.map(l => l.performed_by));
  }, [logs]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (analytics?.actors?.length) resolvePeople(analytics.actors.map(a => a.email));
  }, [analytics]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    Object.values(photoUrlsRef.current).forEach(url => URL.revokeObjectURL(url));
  }, []);

  const nameOf  = (addr = '') => userNames[addr.toLowerCase()] || '';
  const photoOf = (addr = '') => userPhotos[addr.toLowerCase()] || '';

  // ── actions ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (searchDraft === route.q) return;
    const t = setTimeout(() => {
      go({ q: searchDraft, page: 1, event: '' }, { replace: true });
      logAuditEvent('in-page-audit', email, '',
        searchDraft ? `Searched audit log for "${searchDraft}"` : 'Cleared audit log search');
    }, 350);
    return () => clearTimeout(t);
  }, [searchDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  const setCategory = (cat) => {
    go({ cat, action: '', page: 1, event: '' });
    logAuditEvent('in-page-audit', email, '', cat === 'all' ? 'Cleared event filter' : `Filtered audit log by ${cat}`);
  };

  const setAction = (action) => {
    go({ action, cat: 'all', page: 1, event: '' });
    logAuditEvent('in-page-audit', email, '',
      action ? `Filtered by action "${metaFor(action)[0]}"` : 'Cleared event filter');
  };

  // One dropdown covers both: a category bucket or a single action type.
  const eventFilterValue = route.action ? `act:${route.action}` : route.cat !== 'all' ? `cat:${route.cat}` : '';
  const onEventFilterChange = (value) => {
    if (!value) { go({ cat: 'all', action: '', page: 1, event: '' }); logAuditEvent('in-page-audit', email, '', 'Cleared event filter'); }
    else if (value.startsWith('cat:')) setCategory(value.slice(4));
    else setAction(value.slice(4));
  };

  const setRange = (range) => {
    go({ range, page: 1, event: '' });
    logAuditEvent('in-page-audit', email, '', `Set audit log time range to ${range}`);
  };

  const setUserFilter = (addr) => {
    go({ user: addr, adv: !!addr, page: 1, event: '' });
    if (addr) logAuditEvent('in-page-audit', email, '', `Filtered audit log by user "${addr}"`);
  };

  const clearAll = () => {
    go({ q: '', action: '', cat: 'all', range: '7d', user: '', from: '', to: '', page: 1, event: '' });
    setSearchDraft('');
    logAuditEvent('in-page-audit', email, '', 'Cleared all audit log filters');
  };

  const changePage = (next) => {
    if (next === page || next < 1 || next > totalPages) return;
    go({ page: next, event: '' });
    logAuditEvent('in-page-audit', email, '', `Navigated to page ${next} of audit log`);
  };

  const refresh = () => {
    logAuditEvent('in-page-audit', email, '', 'Refresh clicked on Audit Log');
    fetchLogs(); fetchAnalytics(); fetchStats(); fetchActiveUsers();
  };

  const exportCsv = async () => {
    try {
      const res = await apiFetch(`/api/audit/export?${filterParams()}`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit_log_${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      flash('Export downloaded');
      logAuditEvent('in-page-audit', email, '', 'Exported audit log to CSV');
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteOne = async (logId) => {
    if (!canDelete) return;
    if (!window.confirm('Delete this audit log entry? This cannot be undone.')) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/audit/logs/${logId}${forceSilent ? '?silent=true' : ''}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete log entry');
      setSelectedIds(prev => prev.filter(id => id !== logId));
      go({ event: '' }, { replace: true });
      await fetchLogs();
      fetchStats(); fetchAnalytics();
      flash('Entry deleted');
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  const deleteSelected = async () => {
    if (!canDelete || !selectedIds.length) return;
    const n = selectedIds.length;
    if (!window.confirm(`Delete ${n} selected log entr${n === 1 ? 'y' : 'ies'}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/audit/logs${forceSilent ? '?silent=true' : ''}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      if (!res.ok) throw new Error('Failed to delete selected entries');
      setSelectedIds([]);
      await fetchLogs();
      fetchStats(); fetchAnalytics();
      flash(`${n} entr${n === 1 ? 'y' : 'ies'} deleted`);
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  const selectAllMatching = async () => {
    if (selectedIds.length) { setSelectedIds([]); return; }
    setSelectingAll(true);
    try {
      const res = await apiFetch(`/api/audit/logs/ids?${filterParams()}`);
      if (!res.ok) throw new Error('Failed to select all matching entries');
      const data = await res.json();
      setSelectedIds(data.ids || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setSelectingAll(false);
    }
  };

  const toggleOne = (id) =>
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  // ── keyboard ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target || {};
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable;
      if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'Escape') { if (typing) t.blur?.(); else if (route.event) go({ event: '' }); }
      else if (!typing && e.key === 'ArrowRight') changePage(page + 1);
      else if (!typing && e.key === 'ArrowLeft') changePage(page - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // rebinds each render so it always sees the current page/route

  // ── derived ─────────────────────────────────────────────────────────────────
  const groups = useMemo(() => {
    const out = [];
    logs.forEach((log) => {
      const [label] = metaFor(log.action);
      const key = route.group === 'User' ? (log.performed_by || '—')
        : route.group === 'Action' ? log.action
        : new Date(log.timestamp).toDateString();
      let g = out.find(x => x.key === key);
      if (!g) {
        g = {
          key,
          label: route.group === 'User' ? (nameOf(log.performed_by) || log.performed_by || '—')
            : route.group === 'Action' ? label
            : dayLabel(log.timestamp),
          sub: route.group === 'User' ? (log.performed_by || '')
            : route.group === 'Action' ? log.action
            : new Date(log.timestamp).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }),
          items: [],
        };
        out.push(g);
      }
      g.items.push(log);
    });
    return out;
  }, [logs, route.group, userNames]); // eslint-disable-line react-hooks/exhaustive-deps

  const mix = useMemo(() => {
    if (!analytics?.actions?.length) return [];
    const counts = {};
    let sum = 0;
    analytics.actions.forEach(({ action, count }) => {
      const c = categoryOf(action);
      counts[c] = (counts[c] || 0) + count;
      sum += count;
    });
    return CATS.filter(c => counts[c])
      .map(c => ({ cat: c, count: counts[c], pct: Math.round((counts[c] / (sum || 1)) * 100) }))
      .sort((a, b) => b.count - a.count);
  }, [analytics]);

  const topActions = useMemo(() => (analytics?.actions || []).slice(0, 6).map(({ action, count }) => {
    const [label] = metaFor(action);
    return { action, label, count, cat: categoryOf(action) };
  }), [analytics]);

  const topActors = useMemo(() => (analytics?.actors || []).slice(0, 5), [analytics]);

  const hourly = analytics?.hourly || [];
  const maxHour = Math.max(1, ...hourly);
  const currentHour = analytics?.current_hour ?? new Date().getHours();
  const peakHour = hourly.length ? hourly.indexOf(Math.max(...hourly)) : null;
  const daily = analytics?.daily || [];
  const maxDay = Math.max(1, ...daily.map(d => d.count));

  const detail = route.event ? logs.find(l => l.id === route.event) : null;
  const hasFilters = !!(route.q || route.action || route.user || route.from || route.to
    || route.cat !== 'all' || route.range !== '7d');
  const isStream = route.view === 'stream';
  const showEmpty = !loading && !error && logs.length === 0;

  const rangeLabel = { '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days', all: 'all time' }[route.range];

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div className="h-full overflow-auto bg-jj-gray-01 font-johnson-text text-jj-gray-08">

      {loading && (
        <div aria-hidden="true" className="sticky top-0 z-30 h-0.5 bg-jj-red/10">
          <span className="block h-0.5 w-3/5 bg-jj-red" />
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-20 bg-white border-b border-jj-gray-02">
        <div className="max-w-[1580px] mx-auto px-6 h-14 flex items-center gap-4">
          <span className="w-7 h-7 shrink-0 rounded-lg bg-jj-red flex items-center justify-center">
            <img src={auditIcon} alt="" aria-hidden="true" className="w-4 h-4"
              style={{ filter: 'brightness(0) invert(1)' }} />
          </span>
          <span className="font-johnson-display text-base font-medium whitespace-nowrap">Audit Log</span>
          <span className="w-px h-5 shrink-0 bg-jj-gray-02" />

          <nav className="flex items-center gap-1 h-full">
            <button type="button" className={tabCls(isStream)} onClick={() => go({ view: 'stream' })}>Stream</button>
            <button type="button" className={tabCls(!isStream)} onClick={() => go({ view: 'analytics', event: '' })}>Analytics</button>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {canDelete && (
              <span className="px-3 py-1 rounded-full bg-jj-red/5 border border-jj-red/30 font-johnson-text text-xs text-jj-maroon-05">
                {forceSilent ? 'Edit mode · silent' : 'Edit mode'}
              </span>
            )}
            <button type="button" className={BTN_GHOST} onClick={refresh}>Refresh</button>
            <button type="button" className={BTN_SOLID} onClick={exportCsv}>Export CSV</button>
          </div>
        </div>

        {isStream && (
          <div className="border-t border-jj-gray-02 bg-jj-gray-01">
            <div className="max-w-[1580px] mx-auto px-6 py-2.5 flex flex-wrap items-center gap-2.5">
              <div className="relative flex-1 min-w-[16rem]">
                <input
                  ref={searchRef}
                  type="text"
                  value={searchDraft}
                  onChange={e => setSearchDraft(e.target.value)}
                  aria-label="Search audit events"
                  placeholder="Search people, actions, targets or details…    /"
                  className={`${FIELD} w-full text-sm pr-9`}
                />
                {searchDraft && (
                  <button
                    type="button"
                    title="Clear search"
                    onClick={() => setSearchDraft('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded border-0 bg-transparent font-johnson-text text-sm text-jj-gray-07 hover:text-jj-gray-08"
                  >×</button>
                )}
              </div>

              <div className="relative">
                <select
                  value={eventFilterValue}
                  onChange={e => onEventFilterChange(e.target.value)}
                  aria-label="Filter events"
                  className={`${FIELD} h-9 pr-9 appearance-none cursor-pointer max-w-[15rem] truncate ${
                    eventFilterValue ? 'border-jj-red text-jj-red font-medium' : ''}`}
                >
                  <option value="">All events</option>
                  <optgroup label="Categories">
                    {CATS.map(c => (
                      <option key={c} value={`cat:${c}`} className="text-jj-gray-08 font-normal">{c}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Action types">
                    {actionTypes.map(a => (
                      <option key={a.key} value={`act:${a.key}`} className="text-jj-gray-08 font-normal">{a.label}</option>
                    ))}
                  </optgroup>
                </select>
                <span aria-hidden="true"
                  className={`pointer-events-none absolute right-3 top-1/2 -mt-1 w-1.5 h-1.5 rotate-45 border-r border-b ${
                    eventFilterValue ? 'border-jj-red' : 'border-jj-gray-05'}`} />
              </div>

              <div className="ml-auto flex items-center gap-1.5">
                <div className="flex p-0.5 rounded-lg bg-jj-gray-01 border border-jj-gray-02">
                  {['24h', '7d', '30d', 'all'].map(r => (
                    <button key={r} type="button" className={segCls(route.range === r)} onClick={() => setRange(r)}>
                      {r.toUpperCase()}
                    </button>
                  ))}
                </div>
                <button type="button" className={chipCls(route.adv || !!route.user)}
                  onClick={() => go({ adv: !route.adv }, { replace: true })}>Advanced</button>
              </div>
            </div>

            {route.adv && (
              <div className="border-t border-jj-gray-02 bg-white">
                <div className="max-w-[1580px] mx-auto px-6 py-2.5 flex flex-wrap items-center gap-2.5">
                  <input
                    type="text"
                    value={route.user}
                    onChange={e => go({ user: e.target.value, page: 1 }, { replace: true })}
                    aria-label="Filter by person"
                    placeholder="Filter by person or email…"
                    className={`${FIELD} flex-1 min-w-[15rem]`}
                  />
                  <span className={CAP}>From</span>
                  <input type="date" value={route.from} aria-label="From date"
                    onChange={e => go({ from: e.target.value, page: 1 }, { replace: true })}
                    className={`${FIELD} text-jj-gray-07`} />
                  <span className={CAP}>To</span>
                  <input type="date" value={route.to} aria-label="To date"
                    onChange={e => go({ to: e.target.value, page: 1 }, { replace: true })}
                    className={`${FIELD} text-jj-gray-07`} />
                  {hasFilters && (
                    <button type="button" onClick={clearAll}
                      className="h-9 px-3 rounded-lg border border-jj-red/30 bg-white font-johnson-text text-xs text-jj-maroon-05 hover:bg-jj-red/5 transition-colors">
                      Clear all filters
                    </button>
                  )}
                  <span className="ml-auto flex flex-wrap items-center gap-1.5">
                    <span className={CAP}>Views</span>
                    {SAVED_VIEWS.map(v => (
                      <button key={v.label} type="button"
                        onClick={() => { go({ ...v.patch, action: '', user: '', from: '', to: '', page: 1, event: '' }); setSearchDraft(v.patch.q); }}
                        className="h-7 px-3 rounded-full border border-jj-gray-02 bg-white font-johnson-text text-xs text-jj-gray-07 hover:bg-jj-gray-01 transition-colors">
                        {v.label}
                      </button>
                    ))}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </header>

      {/* Stream */}
      {isStream && (
        <main className="max-w-[1580px] mx-auto px-6 pt-5 pb-12 flex flex-wrap items-start gap-4">
          <div className="flex-1 min-w-[36rem]">

            <div className="flex flex-wrap items-center gap-2.5 mb-3">
              <span className={META}>
                {total.toLocaleString()} {total === 1 ? 'event' : 'events'} · {rangeLabel}
              </span>
              <span className="w-px h-4 bg-jj-gray-02" />
              <span className={CAP}>Group</span>
              <div className="flex p-0.5 rounded-lg bg-jj-gray-01 border border-jj-gray-02">
                {['Time', 'User', 'Action'].map(g => (
                  <button key={g} type="button" className={segCls(route.group === g)}
                    onClick={() => go({ group: g }, { replace: true })}>{g}</button>
                ))}
              </div>

              {canDelete && (
                <span className="ml-auto flex items-center gap-2">
                  <button type="button" className={BTN_GHOST} onClick={selectAllMatching} disabled={selectingAll || !total}>
                    {selectingAll ? 'Selecting…' : selectedIds.length ? 'Clear selection' : `Select all ${total.toLocaleString()} matching`}
                  </button>
                  {selectedIds.length > 0 && (
                    <>
                      <span className="font-johnson-text text-xs text-jj-maroon-05">{selectedIds.length.toLocaleString()} selected</span>
                      <button type="button" className={BTN_SOLID} onClick={deleteSelected} disabled={deleting}>Delete selected</button>
                    </>
                  )}
                </span>
              )}
            </div>

            {canDelete && (
              <div className="px-4 py-3 mb-3 rounded-xl bg-jj-red/5 border border-jj-red/30">
                <p className="font-johnson-text text-xs text-jj-maroon-05">
                  {forceSilent
                    ? 'Admin edit mode (silent) — deletions are permanent and are NOT written to the log.'
                    : 'Admin edit mode — deletions are permanent and are themselves written to the log.'}
                </p>
              </div>
            )}

            {loading && (
              <div className={`${CARD} overflow-hidden`} aria-busy="true" aria-label="Loading audit events">
                {[78, 62, 88, 54, 70, 82, 60].map((w, i) => (
                  <div key={i} className={`flex items-center gap-4 px-4 py-4 ${i === 0 ? '' : 'border-t border-jj-gray-01'}`}>
                    <span className="w-16 h-2.5 shrink-0 rounded bg-jj-gray-01" />
                    <span className="w-2.5 h-2.5 shrink-0 rounded-full bg-jj-gray-01" />
                    <span className="flex-1 h-2.5 rounded bg-jj-gray-01" style={{ maxWidth: `${w}%` }} />
                    <span className="w-7 h-7 shrink-0 ml-auto rounded-full bg-jj-gray-01" />
                    <span className="w-20 h-2.5 shrink-0 rounded bg-jj-gray-01" />
                  </div>
                ))}
              </div>
            )}

            {!loading && error && (
              <div className={`${CARD} border-jj-red/30 px-7 py-10 text-center`}>
                <p className={`${CAP} text-jj-maroon-05`}>Request failed</p>
                <p className="mt-3 font-johnson-display font-light text-2xl text-jj-gray-08">Couldn’t load audit events</p>
                <p className={`${META} mt-2.5`}>{error}</p>
                <div className="flex justify-center gap-2 mt-5">
                  <button type="button" className={BTN_SOLID} onClick={fetchLogs}>Try again</button>
                  <button type="button" className={BTN_GHOST}
                    onClick={() => { navigator.clipboard?.writeText(error); flash('Error details copied'); }}>
                    Copy details
                  </button>
                </div>
              </div>
            )}

            {showEmpty && (
              <div className="bg-white rounded-xl border border-dashed border-jj-gray-03 px-7 py-14 text-center">
                <p className="font-johnson-display font-light text-2xl text-jj-gray-07">No events match these filters</p>
                <p className={`${META} mt-2.5 mb-5`}>Widen the time range or clear the search to see more.</p>
                <button type="button" className={BTN_SOLID} onClick={clearAll}>Reset filters</button>
              </div>
            )}

            {!loading && !error && groups.map(group => (
              <div key={group.key} className="mb-4">
                <div className="flex items-center gap-2.5 px-0.5 pb-2">
                  <span className="font-johnson-display text-sm font-medium text-jj-gray-08">{group.label}</span>
                  <span className={CAP}>{group.sub}</span>
                  <span className="flex-1 h-px bg-jj-gray-02" />
                  <span className={`${META} tabular-nums`}>
                    {group.items.length} {group.items.length === 1 ? 'event' : 'events'}
                  </span>
                </div>

                <div className={`${CARD} overflow-hidden`}>
                  {group.items.map((log, i) => {
                    const [label, ink] = metaFor(log.action);
                    const who = log.performed_by || '';
                    const selected = route.event === log.id;
                    return (
                      <div
                        key={log.id}
                        onClick={() => go({ event: selected ? '' : log.id })}
                        className={`grid items-center gap-4 px-4 py-2.5 cursor-pointer transition-colors
                          ${i === 0 ? '' : 'border-t border-jj-gray-01'}
                          ${selected ? 'bg-jj-red/5' : 'bg-white hover:bg-jj-gray-01'}`}
                        style={{
                          gridTemplateColumns: `${canDelete ? '16px ' : ''}72px 12px minmax(0,1fr) minmax(0,180px) 10px`,
                          boxShadow: selected ? `inset 3px 0 0 ${ink}` : 'none',
                        }}
                      >
                        {canDelete && (
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(log.id)}
                            aria-label="Select event"
                            onClick={e => e.stopPropagation()}
                            onChange={() => toggleOne(log.id)}
                            className="w-3.5 h-3.5 accent-jj-red cursor-pointer"
                          />
                        )}
                        <div>
                          <p className="font-johnson-text text-xs text-jj-gray-08 tabular-nums">{hhmmss(log.timestamp)}</p>
                          <p className="font-johnson-text text-xs text-jj-gray-05 mt-0.5">{relTime(log.timestamp)}</p>
                        </div>
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: ink }} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-johnson-text text-sm font-medium whitespace-nowrap" style={{ color: ink }}>
                              {label}
                            </span>
                            {log.target && (
                              <span className="shrink min-w-0 truncate px-2 py-px rounded border border-jj-gray-02 bg-jj-gray-01 font-johnson-text text-xs text-jj-gray-07">
                                {log.target}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 truncate font-johnson-text text-xs text-jj-gray-07">{log.details || '—'}</p>
                        </div>
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Avatar email={who} name={nameOf(who)} photo={photoOf(who)} />
                          <div className="min-w-0">
                            <p className="truncate font-johnson-text text-xs font-medium text-jj-gray-08">
                              {nameOf(who) || who || '—'}
                            </p>
                            {nameOf(who) && <p className="truncate font-johnson-text text-xs text-jj-gray-05 mt-0.5">{who}</p>}
                          </div>
                        </div>
                        <span className={`w-1.5 h-1.5 rotate-[-45deg] border-r border-b ${selected ? 'border-jj-red' : 'border-jj-gray-05'}`} />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {!loading && !error && logs.length > 0 && (
              <div className={`${CARD} flex flex-wrap items-center justify-between gap-2.5 px-4 py-3`}>
                <p className={META}>
                  Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()}
                </p>
                <div className="flex items-center gap-2">
                  <button type="button" className={pagerCls(page === 1)} onClick={() => changePage(page - 1)} disabled={page === 1}>Previous</button>
                  <span className={`${META} tabular-nums`}>{page} / {totalPages}</span>
                  <button type="button" className={pagerCls(page === totalPages)} onClick={() => changePage(page + 1)} disabled={page === totalPages}>Next</button>
                </div>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <aside className="flex-1 min-w-[18rem] max-w-[23rem] sticky top-[7.5rem] flex flex-col gap-3.5">
            {detail ? (
              <DetailPanel
                log={detail}
                name={nameOf(detail.performed_by)}
                photo={photoOf(detail.performed_by)}
                canDelete={canDelete}
                deleting={deleting}
                onClose={() => go({ event: '' })}
                onFilterUser={() => setUserFilter(detail.performed_by)}
                onCopy={() => { navigator.clipboard?.writeText(JSON.stringify(detail, null, 2)); flash('Event JSON copied'); }}
                onDelete={() => deleteOne(detail.id)}
              />
            ) : (
              <>
                <div className={`${CARD} p-4`}>
                  <p className={`${CAP} mb-3`}>At a glance</p>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      [stats?.today, 'events today'],
                      [stats?.role_changes, 'role changes'],
                      [stats?.total, 'entries all time'],
                      [stats?.unique_users, 'people seen'],
                    ].map(([value, label]) => (
                      <div key={label}>
                        <p className={BIG_NUM}>{value == null ? '—' : value.toLocaleString()}</p>
                        <p className="font-johnson-text text-xs text-jj-gray-07 mt-1.5">{label}</p>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 mt-3.5 pt-3 border-t border-jj-gray-02">
                    <span className={META}>Matching these filters</span>
                    <span className="ml-auto font-johnson-text text-xs text-jj-gray-08 tabular-nums">{total.toLocaleString()}</span>
                  </div>
                </div>

                <div className={`${CARD} p-4`}>
                  <div className="flex items-center justify-between gap-2.5 mb-3">
                    <p className={CAP}>Active now</p>
                    <span className="font-johnson-text text-xs text-jj-green-03">
                      {activeUsers ? `${activeUsers.count} online` : '—'}
                    </span>
                  </div>
                  {activeUsers?.users?.length ? (
                    <div className="flex flex-col gap-0.5">
                      {activeUsers.users.map(u => (
                        <button key={u.email} type="button" onClick={() => setUserFilter(u.email)}
                          className="flex items-center gap-2.5 w-full p-2 border-0 rounded-lg bg-transparent text-left hover:bg-jj-gray-01 transition-colors">
                          <Avatar email={u.email} name={nameOf(u.email)} photo={photoOf(u.email)} box="w-8 h-8" />
                          <span className="flex-1 min-w-0">
                            <span className="block truncate font-johnson-text text-xs font-medium text-jj-gray-08">
                              {nameOf(u.email) || u.email}
                            </span>
                            <span className="block truncate font-johnson-text text-xs text-jj-gray-05 mt-0.5">{u.email}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className={META}>Nobody active in the last {activeUsers?.timeout_minutes ?? 5} minutes.</p>
                  )}
                </div>

                <MixCard title="Event mix · these results" mix={mix} onPick={setCategory} />
              </>
            )}
          </aside>
        </main>
      )}

      {/* Analytics */}
      {!isStream && (
        <main className="max-w-[1580px] mx-auto px-6 pt-5 pb-12 grid gap-4 grid-cols-[repeat(auto-fit,minmax(20rem,1fr))]">
          <div className={`${CARD} col-span-full p-5`}>
            <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
              <div>
                <p className={CAP}>Volume · today by hour</p>
                <p className="mt-2 font-johnson-display font-light text-3xl leading-none text-jj-gray-08 tabular-nums">
                  {(stats?.today ?? 0).toLocaleString()}
                  <span className="font-johnson-text text-sm text-jj-gray-07"> events</span>
                </p>
              </div>
              <p className={META}>
                {peakHour == null || !hourly.some(Boolean)
                  ? 'No activity recorded today yet'
                  : `Busiest hour ${String(peakHour).padStart(2, '0')}:00 · ${rangeLabel} selected in Stream`}
              </p>
            </div>
            <div role="img" aria-label="Event volume by hour for today" className="flex items-end gap-1 h-32">
              {(hourly.length ? hourly : new Array(24).fill(0)).map((v, h) => (
                <span key={h}
                  title={`${String(h).padStart(2, '0')}:00 — ${h > currentHour ? 'yet to come' : `${v} ${v === 1 ? 'event' : 'events'}`}`}
                  className={`flex-1 min-w-[3px] rounded ${h > currentHour ? 'bg-jj-gray-01' : h === currentHour ? 'bg-jj-red' : 'bg-jj-red/40'}`}
                  style={{ height: v > 0 ? `${Math.round(8 + 112 * (v / maxHour))}px` : '3px' }} />
              ))}
            </div>
            <div className="flex gap-1 mt-2">
              {new Array(24).fill(0).map((_, h) => (
                <span key={h} className="flex-1 min-w-[3px] font-johnson-text text-xs text-jj-gray-05 text-left">
                  {h % 6 === 0 ? `${String(h).padStart(2, '0')}:00` : ''}
                </span>
              ))}
            </div>
          </div>

          <div className={`${CARD} p-5`}>
            <p className={`${CAP} mb-4`}>Volume · last 7 days</p>
            <div className="flex items-end gap-2.5 h-28">
              {daily.map((d, i) => (
                <span key={d.date} title={`${d.date} — ${d.count} events`}
                  className={`flex-1 rounded ${i === daily.length - 1 ? 'bg-jj-red' : 'bg-jj-red/40'}`}
                  style={{ height: `${Math.max(3, Math.round((d.count / maxDay) * 104))}px` }} />
              ))}
            </div>
            <div className="flex gap-2.5 mt-2">
              {daily.map(d => (
                <span key={d.date} className="flex-1 text-center font-johnson-text text-xs text-jj-gray-07">
                  {new Date(`${d.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2)}
                </span>
              ))}
            </div>
          </div>

          <MixCard title="Category mix · these filters" mix={mix} onPick={(c) => { setCategory(c); go({ view: 'stream' }); }} />

          <div className={`${CARD} p-5`}>
            <p className={`${CAP} mb-4`}>Most active people</p>
            {topActors.length === 0 && <p className={META}>Nothing in range.</p>}
            <div className="flex flex-col gap-3">
              {topActors.map(a => (
                <button key={a.email} type="button" onClick={() => { setUserFilter(a.email); go({ view: 'stream' }); }}
                  className="block w-full p-0 border-0 bg-transparent text-left">
                  <span className="flex items-center gap-2.5 mb-1.5">
                    <span className="flex-1 truncate font-johnson-text text-xs text-jj-gray-08">{nameOf(a.email) || a.email}</span>
                    <span className="font-johnson-text text-xs text-jj-gray-07 tabular-nums">{a.count.toLocaleString()}</span>
                  </span>
                  <span className="block h-1 rounded bg-jj-gray-01">
                    <span className="block h-1 rounded bg-jj-red"
                      style={{ width: `${Math.round((a.count / (topActors[0]?.count || 1)) * 100)}%` }} />
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className={`${CARD} p-5`}>
            <p className={`${CAP} mb-4`}>Top actions</p>
            {topActions.length === 0 && <p className={META}>Nothing in range.</p>}
            <div className="flex flex-col gap-3">
              {topActions.map(t => (
                <button key={t.action} type="button" onClick={() => { setAction(t.action); go({ view: 'stream' }); }}
                  className="flex items-center gap-2.5 w-full p-0 border-0 bg-transparent text-left">
                  <span className="w-2 h-2 shrink-0 rounded-full" style={{ backgroundColor: CAT_COLOR[t.cat] }} />
                  <span className="flex-1 min-w-0 truncate font-johnson-text text-xs text-jj-gray-08">{t.label}</span>
                  <span className="w-20 h-1 shrink-0 rounded bg-jj-gray-01">
                    <span className="block h-1 rounded"
                      style={{ width: `${Math.round((t.count / (topActions[0]?.count || 1)) * 100)}%`, backgroundColor: CAT_COLOR[t.cat] }} />
                  </span>
                  <span className="w-10 text-right font-johnson-text text-xs text-jj-gray-07 tabular-nums">
                    {t.count.toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </main>
      )}

      <footer className="max-w-[1580px] mx-auto px-6 pb-8 flex flex-wrap items-center gap-2.5 font-johnson-text text-xs text-jj-gray-05">
        <span>Shortcuts: <b className="font-medium text-jj-gray-07">/</b> search · <b className="font-medium text-jj-gray-07">← →</b> page · <b className="font-medium text-jj-gray-07">esc</b> close detail</span>
        <span className="ml-auto">Filters live in the URL — copy the address to share this exact view.</span>
      </footer>

      {toast && (
        <div className="fixed right-6 bottom-6 z-40 px-4 py-3 rounded-xl bg-white border border-jj-gray-02 shadow-lg font-johnson-text text-xs text-jj-gray-08">
          {toast}
        </div>
      )}
    </div>
  );
}

function MixCard({ title, mix, onPick }) {
  return (
    <div className={`${CARD} p-4`}>
      <p className={`${CAP} mb-3`}>{title}</p>
      {mix.length === 0 ? (
        <p className={META}>Nothing to break down yet.</p>
      ) : (
        <>
          <div className="flex h-2 rounded overflow-hidden bg-jj-gray-01 mb-3">
            {mix.map(m => (
              <span key={m.cat} style={{ width: `${m.pct}%`, backgroundColor: CAT_COLOR[m.cat] }} />
            ))}
          </div>
          <div className="flex flex-col gap-2.5">
            {mix.map(m => (
              <button key={m.cat} type="button" onClick={() => onPick(m.cat)}
                className="flex items-center gap-2.5 w-full p-0 border-0 bg-transparent text-left">
                <span className="w-2 h-2 shrink-0 rounded-full" style={{ backgroundColor: CAT_COLOR[m.cat] }} />
                <span className="flex-1 font-johnson-text text-xs text-jj-gray-07">{m.cat}</span>
                <span className="font-johnson-text text-xs text-jj-gray-08 tabular-nums">{m.pct}%</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function DetailPanel({ log, name, photo, canDelete, deleting, onClose, onFilterUser, onCopy, onDelete }) {
  const [label, ink] = metaFor(log.action);
  const when = new Date(log.timestamp);
  const meta = [
    ['Event ID', log.id],
    ['Action key', log.action],
    ['Target', log.target || '—'],
    ['Source IP', log.ip_address || '—'],
    ['Category', categoryOf(log.action)],
    // Local time, like every other time on this page. toISOString() is
    // always UTC, which put this one field 4-5 hours off the rest.
    ['Recorded', `${when.toLocaleDateString('en-CA')} ${when.toLocaleTimeString('en-GB', { hour12: false })}`],
  ];

  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className="flex items-center justify-between gap-2.5 px-4 py-3 border-b border-jj-gray-02 bg-jj-gray-01">
        <span className={CAP}>Event detail</span>
        <button type="button" title="Close" onClick={onClose}
          className="w-6 h-6 rounded border border-jj-gray-02 bg-white font-johnson-text text-sm leading-none text-jj-gray-07 hover:bg-jj-gray-01 transition-colors">×</button>
      </div>

      <div className="p-4">
        <div className="flex items-center gap-2.5 mb-3.5">
          <span className="w-8 h-8 shrink-0 rounded-full border-l-4"
            style={{ backgroundColor: `${ink}14`, borderLeftColor: ink }} />
          <div className="min-w-0">
            <p className="font-johnson-text text-base font-medium" style={{ color: ink }}>{label}</p>
            <p className="font-johnson-text text-xs text-jj-gray-05 mt-0.5">{categoryOf(log.action)} · {log.action}</p>
          </div>
        </div>

        <div className="flex items-baseline gap-2.5 pb-3.5 mb-3.5 border-b border-jj-gray-02">
          <p className={BIG_NUM}>{hhmmss(log.timestamp)}</p>
          <p className={META}>
            {when.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · {relTime(log.timestamp)}
          </p>
        </div>

        <div className="flex items-center gap-2.5 p-2.5 mb-3 rounded-lg bg-jj-gray-01 border border-jj-gray-02">
          <Avatar email={log.performed_by} name={name} photo={photo} box="w-9 h-9" text="text-sm" />
          <div className="min-w-0 flex-1">
            <p className="font-johnson-text text-xs font-medium text-jj-gray-08">{name || log.performed_by || '—'}</p>
            <p className="truncate font-johnson-text text-xs text-jj-gray-05 mt-0.5">{log.performed_by}</p>
          </div>
        </div>

        <p className={`${BODY} leading-relaxed mb-3`}>{log.details || 'No details recorded for this event.'}</p>

        <div className="grid grid-cols-2 gap-3 p-3 rounded-lg bg-jj-gray-01 border border-jj-gray-02">
          {meta.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <p className={`${CAP} mb-1`}>{k}</p>
              <p className="font-johnson-text text-xs text-jj-gray-08 break-all">{v}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2 mt-3.5">
          <button type="button" className={BTN_GHOST} onClick={onFilterUser}>All by this person</button>
          <button type="button" className={BTN_GHOST} onClick={onCopy}>Copy JSON</button>
          {canDelete && (
            <button type="button" disabled={deleting} onClick={onDelete}
              className="h-8 px-3 rounded-lg border border-jj-red/30 bg-jj-red/5 font-johnson-text text-xs text-jj-maroon-05 hover:bg-jj-red/10 transition-colors disabled:opacity-40">
              Delete entry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}