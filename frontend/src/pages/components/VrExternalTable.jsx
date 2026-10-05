import React, { useState, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import LoadingSpinner from './LoadingSpinner';
import { apiJson } from '../../utils/apiClient';
import { facetOptions, passesFacets, pickedCount, haColors, NOT_MAPPED } from './vrExternalFacets';

import searchIcon from "/icons/JJ_Icon_Search_RGB.svg";
import closeIcon from "/icons/JJ_Icon_Close.svg";
import downloadIcon from "/icons/JJ_Icon_Download_PDF_RGB.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import filterIcon from "/icons/JJ_Icon_Filter.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";

// Virtual Regulator -> External, any table that isn't the press release feed.
// We don't know the columns up front so everything here is worked out from
// whatever SELECT * gives back: profile on Explore, plain grid on Data table.

const TINTS = {
  red: "url(#jj-red-tint)",
  ink: "url(#jj-ink-tint)",
  gray: "url(#jj-gray-tint)",
};
const Icon = ({ src, alt = "", className = "w-4 h-4", tint = "red" }) => (
  <img src={src} alt={alt} className={className} style={tint ? { filter: TINTS[tint] } : undefined} />
);

const PAGE = 100;
const TZ = 'America/New_York';
const BAR_COLORS = ['#eb1700', '#0f68b2', '#328714', '#8c3bbb', '#ff6017', '#b8860b'];

const isEmpty = (v) => v == null || v === '';
const isUrl = (v) => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());
const looksLikeDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([T ][\d:.]+)?/.test(v);

function show(v) {
  if (isEmpty(v)) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function fmtDate(v) {
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ });
}

function niceName(col) {
  return col.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function highlight(text, q) {
  if (!q || !text) return text;
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text).split(new RegExp(`(${safe})`, 'ig')).map((p, i) =>
    p.toLowerCase() === q.toLowerCase() ? <mark key={i} className="bg-jj-yellow-01/70 text-inherit rounded-sm">{p}</mark> : p
  );
}

function toCsv(columns, rows) {
  const esc = (v) => {
    const s = show(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
}

// per column: how full it is, how many distinct values, what type it smells like
function profile(columns, rows) {
  return columns.map((name, i) => {
    const counts = new Map();
    let filled = 0, dates = 0, nums = 0, longest = 0;
    for (const r of rows) {
      const v = r[i];
      if (isEmpty(v)) continue;
      filled++;
      const s = show(v);
      longest = Math.max(longest, s.length);
      if (typeof v === 'number') nums++;
      else if (looksLikeDate(v)) dates++;
      counts.set(s, (counts.get(s) || 0) + 1);
    }
    const kind = filled && dates === filled ? 'date' : filled && nums === filled ? 'number' : 'text';
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, count]) => ({ value, count }));
    return { name, index: i, filled, distinct: counts.size, kind, longest, top };
  });
}

/* ============================== pieces ============================== */

function Card({ className = '', children }) {
  return <div className={`bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] ${className}`}>{children}</div>;
}

function CardTitle({ title, sub, right }) {
  return (
    <>
      <div className="flex items-center justify-between mb-1 gap-2">
        <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08 truncate">{title}</div>
        {right}
      </div>
      {sub && <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">{sub}</div>}
    </>
  );
}

function Bars({ rows, color, active, onPick }) {
  const max = Math.max(1, ...rows.map(r => r.count));
  return (
    <div className="flex flex-col gap-2">
      {rows.map(r => {
        const on = active === r.value;
        return (
          <div
            key={r.value}
            onClick={() => onPick(r.value)}
            title={on ? 'Click to remove filter' : 'Click to filter'}
            className={`rounded cursor-pointer hover:bg-jj-gray-01/60 ${active != null && !on ? 'opacity-50' : ''}`}
          >
            <div className="flex justify-between text-[11px] font-johnson-text mb-[3px]">
              <span className={`truncate pr-2 text-jj-gray-08 ${on ? 'font-bold' : ''}`}>{r.value}</span>
              <span className="text-jj-gray-08 tabular-nums flex-shrink-0">{r.count}</span>
            </div>
            <div className="h-[9px] rounded bg-jj-gray-01">
              <div className="h-full rounded" style={{ width: `${(r.count / max) * 100}%`, minWidth: 4, background: color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Cell({ value, q }) {
  if (isEmpty(value)) return <span className="italic text-jj-gray-05">null</span>;
  if (isUrl(value)) {
    return (
      <a href={value} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-jj-blue-03 hover:text-jj-red break-all">
        {value.length > 60 ? `${value.slice(0, 60)}…` : value} ↗
      </a>
    );
  }
  return <span className="line-clamp-3 break-words">{highlight(show(value), q)}</span>;
}

function RowDrawer({ columns, row, title, onClose }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = () => {
    const obj = Object.fromEntries(columns.map((c, i) => [c, row[i]]));
    navigator.clipboard?.writeText(JSON.stringify(obj, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="w-full max-w-[560px] h-full bg-white shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex-shrink-0 px-5 py-4 border-b border-jj-gray-02 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10.5px] font-johnson-text uppercase tracking-wider text-jj-gray-06">Record</div>
            <h3 className="font-johnson-display font-bold text-[17px] leading-snug text-jj-gray-08 break-words mt-0.5">{title || 'Row detail'}</h3>
          </div>
          <button onClick={onClose} className="flex-shrink-0 p-1"><Icon src={closeIcon} alt="Close" tint="ink" className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-2">
          {columns.map((c, i) => (
            <div key={c} className="flex text-xs font-johnson-text border-b border-jj-gray-01 last:border-0 py-2">
              <div className="w-[38%] text-jj-gray-06 flex-shrink-0 pr-2 break-words">{c}</div>
              <div className="w-[62%] text-jj-gray-08 break-words whitespace-pre-wrap">
                {isEmpty(row[i]) ? <span className="italic text-jj-gray-05">null</span>
                  : isUrl(row[i]) ? <a href={row[i]} target="_blank" rel="noreferrer" className="text-jj-blue-03 hover:text-jj-red break-all">{row[i]} ↗</a>
                  : show(row[i])}
              </div>
            </div>
          ))}
        </div>
        <div className="flex-shrink-0 px-5 py-3.5 border-t border-jj-gray-02">
          <button onClick={copy} className="w-full px-[18px] py-[9px] rounded-full border border-jj-gray-03 text-[12.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01">
            {copied ? 'Copied' : 'Copy as JSON'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// thin bar at the top while a reload runs over data already on screen
function RefreshBar({ on }) {
  if (!on) return null;
  return (
    <div className="flex-shrink-0 h-[3px] bg-jj-red/15 overflow-hidden" role="status" aria-label="Refreshing">
      <div className="h-full w-full bg-jj-red animate-pulse" />
    </div>
  );
}

function LoadFailed({ what, error, onRetry }) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-red-50 border border-jj-maroon-05 text-jj-maroon-05 text-sm font-johnson-text">
      <Icon src={alertIcon} className="w-4 h-4 flex-shrink-0" />
      <span className="flex-1 min-w-0 break-words">Couldn't load {what}: {error}</span>
      {onRetry && <button onClick={onRetry} className="flex-shrink-0 text-xs text-jj-blue-03 underline">Retry</button>}
    </div>
  );
}

/* ============================== table picker rail ============================== */

function FacetBlock({ facet, selected, onToggle, colorOf }) {
  const [open, setOpen] = useState(true);
  const max = Math.max(1, ...facet.options.map(o => o.count));
  return (
    <div className="border-b border-jj-gray-01">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-[18px] py-3 text-left hover:bg-jj-gray-01/50 transition-colors">
        <span className="text-[11px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-07">
          {facet.label}
          {selected.length > 0 && (
            <span className="ml-2 inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium normal-case tracking-normal">{selected.length}</span>
          )}
        </span>
        <Icon src={chevronRightIcon} tint="gray" className={`w-2.5 h-2.5 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="px-[18px] pb-3">
          {facet.options.map(o => {
            const checked = selected.includes(o.value);
            const color = colorOf?.(o.value);
            return (
              <label key={o.value} className="flex flex-col gap-1.5 py-1.5 px-1 -mx-1 rounded cursor-pointer hover:bg-jj-gray-01/60">
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={checked} onChange={() => onToggle(o.value)} className="accent-[#0f68b2] flex-shrink-0" />
                  {color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />}
                  <span className={`flex-1 truncate text-[12.5px] font-johnson-text ${checked ? 'font-bold' : 'font-medium'} ${o.value === NOT_MAPPED ? 'italic text-jj-gray-06' : 'text-jj-gray-08'}`} title={o.value}>{o.value}</span>
                  <span className="text-[11px] font-johnson-text text-jj-gray-06 tabular-nums flex-shrink-0">{o.count}</span>
                </div>
                <div className="h-[4px] rounded-full bg-jj-gray-01 ml-[22px]">
                  <div className={`h-full rounded-full ${color ? '' : 'bg-jj-blue-03'}`} style={{ width: `${Math.round((o.count / max) * 100)}%`, background: color }} />
                </div>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TableRail({ tables, allSources, picked, onPicked, activeId, onOpenTable, logInPage }) {
  const [collapsed, setCollapsed] = useState(false);
  const colors = useMemo(() => haColors(allSources || tables), [allSources, tables]);
  const facets = useMemo(() => facetOptions(tables, picked), [tables, picked]);
  const matching = useMemo(() => tables.filter(t => passesFacets(t, picked)), [tables, picked]);
  const n = pickedCount(picked);

  const toggle = (facet, value) => {
    const list = picked[facet.id] || [];
    const on = list.includes(value);
    onPicked({ ...picked, [facet.id]: on ? list.filter(v => v !== value) : [...list, value] });
    logInPage?.(on ? 'filter_remove' : 'filter_add', `VR External: ${on ? 'removed' : 'added'} ${facet.label} filter "${value}"`);
  };

  if (collapsed) {
    return (
      <div className="w-10 flex-shrink-0 bg-white border-r border-jj-gray-02 flex flex-col items-center pt-3">
        <button onClick={() => setCollapsed(false)} title="Expand filters" className="relative p-1.5 rounded hover:bg-jj-gray-01">
          <Icon src={filterIcon} tint="ink" className="w-[13px] h-[13px]" />
          {n > 0 && <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[15px] h-[15px] px-0.5 rounded-full bg-jj-red text-white text-[9px] font-medium">{n}</span>}
        </button>
      </div>
    );
  }

  return (
    <div className="w-[252px] flex-shrink-0 bg-white border-r border-jj-gray-02 flex flex-col overflow-hidden">
      <div className="px-[18px] pt-4 pb-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2 text-[13px] font-johnson-text font-bold text-jj-gray-08">
          <Icon src={filterIcon} tint="ink" className="w-[13px] h-[13px]" />
          Sources
          {n > 0 && <span className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium">{n}</span>}
        </div>
        <button onClick={() => onPicked({})} disabled={n === 0} className="text-[11px] font-johnson-text text-jj-blue-03 disabled:opacity-40">Clear all</button>
        <button onClick={() => setCollapsed(true)} title="Collapse filters" className="p-1 rounded hover:bg-jj-gray-01">
          <Icon src={chevronRightIcon} tint="gray" className="w-2.5 h-2.5 rotate-180" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {facets.map(f => (
          <FacetBlock key={f.id} facet={f} selected={picked[f.id] || []} onToggle={(v) => toggle(f, v)}
            colorOf={f.id === 'site' ? (v) => colors.get(v) : undefined} />
        ))}
        <div className="px-[18px] pt-3 pb-3">
          <div className="text-[11px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-07 mb-1.5">
            Tables <span className="font-normal normal-case tracking-normal text-jj-gray-05">{matching.length}</span>
          </div>
          {matching.map(t => (
            <button
              key={t.id}
              onClick={() => onOpenTable?.(t.id)}
              title={t.table}
              className={`w-full text-left px-2 py-1.5 -mx-2 rounded text-[12px] font-johnson-text truncate transition-colors ${
                t.id === activeId ? 'bg-jj-red/10 text-jj-red font-medium' : 'text-jj-gray-08 hover:bg-jj-gray-01'
              }`}
            >
              {t.label}
            </button>
          ))}
          {matching.length === 0 && <div className="text-[11.5px] font-johnson-text text-jj-gray-05 py-1">No tables match.</div>}
        </div>
      </div>
      <div className="flex-shrink-0 px-[18px] py-3 border-t border-jj-gray-01 text-[10.5px] font-johnson-text text-jj-gray-05 leading-relaxed">
        Filters come from EXTERNAL_FDA_MAPPING. Counts are tables.
      </div>
    </div>
  );
}

/* ============================== main ============================== */

export default function VrExternalTable({ source, sources = [], facets = {}, onFacetsChange, onOpenTable, noMatch, logInPage, activeTab, onBusyChange, onSynced, canViewSql, reloadKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const firstLoad = useRef(true);

  const [query, setQuery] = useState('');
  const [picks, setPicks] = useState({}); // column -> value, from clicking the bars
  const [sort, setSort] = useState({ col: null, desc: true });
  const [page, setPage] = useState(0);
  const [showSql, setShowSql] = useState(false);
  const [openRow, setOpenRow] = useState(null);
  const [attempt, setAttempt] = useState(0);

  const name = source?.label || 'table';

  useEffect(() => {
    let dead = false;
    const bypass = !firstLoad.current;
    firstLoad.current = false;
    setLoading(true);
    setError(null);
    onBusyChange?.(true);
    apiJson(`/api/vr-external/table/${encodeURIComponent(source.id)}${bypass ? '?bypass_cache=true' : ''}`)
      .then(res => {
        if (dead) return;
        setData(res);
        onSynced?.(Date.now());
      })
      .catch(e => { if (!dead) setError(e.message || `Failed to load ${name}`); })
      .finally(() => {
        if (dead) return;
        setLoading(false);
        onBusyChange?.(false);
      });
    return () => { dead = true; onBusyChange?.(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, source.id, attempt]);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const t = setTimeout(() => logInPage?.('filter_add', `VR External (${name}): searched "${q}"`), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => { setPage(0); }, [query, picks, sort]);

  const columns = useMemo(() => data?.columns || [], [data]);
  const all = useMemo(() => data?.rows || [], [data]);
  const q = query.trim().toLowerCase();

  const rows = useMemo(() => {
    const pickList = Object.entries(picks).map(([c, v]) => [columns.indexOf(c), v]);
    let out = all.filter(r => {
      for (const [i, v] of pickList) if (show(r[i]) !== v) return false;
      if (q && !r.some(v => show(v).toLowerCase().includes(q))) return false;
      return true;
    });
    if (sort.col != null) {
      const i = columns.indexOf(sort.col);
      out = [...out].sort((a, b) => {
        const x = a[i], y = b[i];
        if (isEmpty(x)) return 1;
        if (isEmpty(y)) return -1;
        const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : show(x).localeCompare(show(y), undefined, { numeric: true });
        return sort.desc ? -cmp : cmp;
      });
    }
    return out;
  }, [all, columns, picks, q, sort]);

  const prof = useMemo(() => profile(columns, rows), [columns, rows]);

  // columns worth charting: repeat values, not ids or free text
  const groupable = useMemo(() => prof
    .filter(p => p.kind === 'text' && p.distinct >= 2 && p.distinct <= 40 && p.longest <= 80 && p.distinct < rows.length)
    .slice(0, 6), [prof, rows.length]);

  const dateCol = prof.find(p => p.kind === 'date' && p.filled);
  const latest = useMemo(() => {
    if (!dateCol) return null;
    return rows.reduce((m, r) => (!isEmpty(r[dateCol.index]) && (!m || r[dateCol.index] > m) ? r[dateCol.index] : m), null);
  }, [rows, dateCol]);

  // best guess at a title for the drawer
  const titleIdx = useMemo(() => {
    const hit = columns.findIndex(c => /^(title|name|subject|headline)$/i.test(c));
    if (hit >= 0) return hit;
    return columns.findIndex(c => /title|name|subject/i.test(c));
  }, [columns]);

  const avgFill = prof.length && rows.length ? Math.round(prof.reduce((a, p) => a + p.filled, 0) / (prof.length * rows.length) * 100) : 0;

  /* ---------- actions ---------- */
  const pick = (col, value) => {
    const on = picks[col] === value;
    setPicks(p => {
      const next = { ...p };
      if (on) delete next[col]; else next[col] = value;
      return next;
    });
    logInPage?.(on ? 'filter_remove' : 'filter_add', `VR External (${name}): ${on ? 'removed' : 'added'} ${col} = "${value}"`);
  };
  const clearAll = () => { setPicks({}); setQuery(''); };
  const sortBy = (col) => setSort(s => (s.col === col ? { col, desc: !s.desc } : { col, desc: true }));

  const openDetail = (r) => {
    setOpenRow(r);
    logInPage?.('open_detail', `VR External (${name}): opened a row`);
  };

  const download = () => {
    const blob = new Blob([toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${source.id}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    logInPage?.('download', `VR External (${name}): downloaded ${rows.length} rows`);
  };

  const btn = "flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01 whitespace-nowrap";

  const tables = sources.filter(t => t.kind === 'table');
  const rail = tables.length > 0 && (
    <TableRail
      tables={tables}
      allSources={sources}
      picked={facets}
      onPicked={(p) => onFacetsChange?.(p)}
      activeId={source.id}
      onOpenTable={onOpenTable}
      logInPage={logInPage}
    />
  );
  const retry = () => setAttempt(a => a + 1);

  if (!data && !noMatch && (loading || error)) {
    return (
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {rail}
        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center p-10 gap-2">
            <LoadingSpinner />
            <div className="text-xs font-johnson-text text-jj-gray-06">Loading {name}…</div>
          </div>
        ) : (
          <div className="flex-1 min-w-0 p-5"><LoadFailed what={name} error={error} onRetry={retry} /></div>
        )}
      </div>
    );
  }

  const chips = [
    ...Object.entries(picks).map(([c, v]) => ({ key: `p-${c}`, text: `${niceName(c)}: ${v}`, clear: () => pick(c, v) })),
    ...(q ? [{ key: 'q', text: `Search: ${query.trim()}`, clear: () => setQuery('') }] : []),
  ];
  const pageRows = rows.slice(page * PAGE, (page + 1) * PAGE);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));

  const searchBox = (
    <div className="relative w-[280px] max-w-full">
      <Icon src={searchIcon} tint="gray" className="w-[13px] h-[13px] absolute left-2.5 top-[9px]" />
      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={`Search ${name}…`}
        className="w-full pl-8 pr-2 py-2 text-xs font-johnson-text rounded-lg border border-jj-gray-03 bg-white focus:outline-none focus:border-jj-blue-03"
      />
    </div>
  );

  const meta = source.meta;

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden">
    {rail}
    {noMatch ? (
      <div className="flex-1 min-w-0 p-5">
        <Card className="px-5 py-10 text-center">
          <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">No tables match these filters</div>
          <div className="text-xs font-johnson-text text-jj-gray-06 mt-1">Try another combination or clear a filter.</div>
          <button onClick={() => onFacetsChange?.({})} className="mt-3 text-xs font-johnson-text text-jj-blue-03 underline">Clear all filters</button>
        </Card>
      </div>
    ) : (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden" aria-busy={loading}>
      <RefreshBar on={loading} />
      {error && (
        <div className="flex-shrink-0 px-5 pt-3.5">
          <LoadFailed what={`the latest ${name} rows (showing the last good load)`} error={error} onRetry={retry} />
        </div>
      )}
      <div className="flex-shrink-0 px-5 pt-3.5 flex items-center gap-2 flex-wrap">
        {searchBox}
        {chips.map(c => (
          <span key={c.key} className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-white border border-jj-gray-03 text-[11px] font-johnson-text text-jj-gray-08">
            {c.text}
            <button onClick={c.clear} className="hover:opacity-60"><Icon src={closeIcon} alt="Remove" tint="gray" className="w-2 h-2" /></button>
          </span>
        ))}
        {chips.length > 0 && <button onClick={clearAll} className="text-[11px] font-johnson-text text-jj-blue-03 underline">Clear all</button>}
      </div>

      {/* ============ EXPLORE ============ */}
      {activeTab !== 'table' && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-5 flex flex-col gap-3.5">
            <div className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden flex-shrink-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
              {[
                { label: 'Rows', value: rows.length.toLocaleString(), sub: rows.length === all.length ? (data?.truncated ? `first ${all.length.toLocaleString()} loaded` : 'all rows') : `of ${all.length.toLocaleString()} loaded` },
                { label: 'Columns', value: columns.length, sub: `${groupable.length} groupable` },
                { label: 'Completeness', value: `${avgFill}%`, sub: 'cells with a value' },
                { label: dateCol ? `Latest ${niceName(dateCol.name)}` : 'Latest date', value: latest ? fmtDate(latest) : '—', sub: dateCol ? dateCol.name : 'no date column' },
              ].map(k => (
                <div key={k.label} className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                  <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1 truncate">{k.label}</div>
                  <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums truncate">{k.value}</div>
                  <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5 truncate">{k.sub}</div>
                </div>
              ))}
            </div>

            {data?.truncated && (
              <div className="text-[11px] font-johnson-text text-jj-gray-06 px-1">
                Table is bigger than {all.length.toLocaleString()} rows, only the first {all.length.toLocaleString()} are loaded here.
              </div>
            )}

            {!all.length ? (
              <Card className="px-5 py-10 text-center">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">No rows in {name} yet</div>
                <div className="text-xs font-johnson-text text-jj-gray-06 mt-1">They show up here after the next load.</div>
              </Card>
            ) : !rows.length ? (
              <Card className="px-5 py-10 text-center">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Nothing matches</div>
                <button onClick={clearAll} className="mt-3 text-xs font-johnson-text text-jj-blue-03 underline">Clear all filters</button>
              </Card>
            ) : (
              <>
                {groupable.length > 0 && (
                  <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
                    {groupable.map((p, i) => (
                      <Card key={p.name} className="px-5 py-4 min-w-0">
                        <CardTitle
                          title={niceName(p.name)}
                          sub={`Top values · ${p.distinct} distinct · click to filter`}
                        />
                        <Bars rows={p.top} color={BAR_COLORS[i % BAR_COLORS.length]} active={picks[p.name] ?? null} onPick={(v) => pick(p.name, v)} />
                      </Card>
                    ))}
                  </div>
                )}

                <Card className="px-5 py-4 flex-shrink-0">
                  <CardTitle title="Columns" sub="How full each column is for the rows in view" />
                  <div className="grid gap-x-8 gap-y-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                    {prof.map(p => {
                      const pct = rows.length ? Math.round(p.filled / rows.length * 100) : 0;
                      return (
                        <div key={p.name} className="min-w-0">
                          <div className="flex justify-between text-[11px] font-johnson-text mb-[3px] gap-2">
                            <span className="truncate text-jj-gray-08" title={p.name}>{p.name}</span>
                            <span className="text-jj-gray-06 tabular-nums flex-shrink-0">{p.kind} · {pct}%</span>
                          </div>
                          <div className="h-[6px] rounded bg-jj-gray-01">
                            <div className="h-full rounded" style={{ width: `${pct}%`, background: pct < 50 ? '#ff6017' : '#0f68b2' }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              </>
            )}
          </div>
        </div>
      )}

      {/* ============ DATA TABLE ============ */}
      {activeTab === 'table' && (
        <div className="flex-1 min-h-0 flex flex-col gap-3.5 p-5 overflow-hidden">
          <div className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="flex-shrink-0 flex items-center justify-between gap-3 px-[18px] py-3 border-b border-jj-gray-01 flex-wrap">
              <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                {name} <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{rows.length.toLocaleString()} of {all.length.toLocaleString()}{data?.truncated ? '+' : ''}</span>
              </div>
              <div className="flex items-center gap-3">
                {canViewSql && data?.sql && (
                  <button onClick={() => setShowSql(s => !s)} className="text-[11px] font-johnson-text text-jj-blue-03 underline">{showSql ? 'Hide SQL' : 'View SQL'}</button>
                )}
                <button onClick={download} disabled={loading || !rows.length} className={btn}>
                  <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />Download CSV
                </button>
              </div>
            </div>
            {meta && (
              <div className="flex-shrink-0 flex items-center gap-x-3 gap-y-1 flex-wrap px-[18px] py-2 border-b border-jj-gray-01 text-[11px] font-johnson-text text-jj-gray-06">
                {meta.site && <span><span className="text-jj-gray-05">Health authority</span> <b className="text-jj-gray-08 font-medium">{meta.site}</b></span>}
                {meta.region && <span><span className="text-jj-gray-05">Region</span> <b className="text-jj-gray-08 font-medium">{meta.region}</b></span>}
                {meta.feed && <span><span className="text-jj-gray-05">Feed</span> <b className="text-jj-gray-08 font-medium">{meta.feed}</b></span>}
                {meta.website && <a href={meta.website} target="_blank" rel="noreferrer" className="text-jj-blue-03 hover:text-jj-red truncate max-w-[360px]">Source feed ↗</a>}
              </div>
            )}
            {showSql && data?.sql && (
              <pre className="flex-shrink-0 mx-[18px] mt-3 bg-jj-gray-08 text-white text-[11px] rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-40">{data.sql}</pre>
            )}
            <div className="flex-1 min-h-0 overflow-auto">
              <table className="border-separate border-spacing-0 text-xs font-johnson-text" style={{ minWidth: '100%' }}>
                <thead className="sticky top-0 z-[5]">
                  <tr className="bg-[#faf9f8]">
                    {columns.map(c => (
                      <th
                        key={c}
                        onClick={() => sortBy(c)}
                        className="px-3 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-jj-gray-06 whitespace-nowrap border-b border-r border-jj-gray-02 last:border-r-0 cursor-pointer hover:bg-jj-gray-02"
                      >
                        {c}{sort.col === c ? (sort.desc ? ' ▼' : ' ▲') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r, ri) => (
                    <tr key={page * PAGE + ri} onClick={() => openDetail(r)} className="hover:bg-jj-blue-03/5 cursor-pointer align-top">
                      {r.map((v, i) => (
                        <td key={i} className="px-3 py-2.5 border-b border-r border-jj-gray-01 last:border-r-0 text-jj-gray-08 max-w-[360px] min-w-[90px]">
                          <Cell value={v} q={query.trim()} />
                        </td>
                      ))}
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={Math.max(1, columns.length)} className="px-3 py-8 text-center text-jj-gray-06">No rows match the current filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-2.5 border-t border-jj-gray-01 text-[11.5px] font-johnson-text text-jj-gray-06">
                <span className="tabular-nums">
                  {(page * PAGE + 1).toLocaleString()}–{Math.min(rows.length, (page + 1) * PAGE).toLocaleString()} of {rows.length.toLocaleString()}
                </span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setPage(p => p - 1)} disabled={page === 0} className={btn}>Prev</button>
                  <span className="tabular-nums">{page + 1} / {pages}</span>
                  <button onClick={() => setPage(p => p + 1)} disabled={page >= pages - 1} className={btn}>Next</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {openRow && (
        <RowDrawer
          columns={columns}
          row={openRow}
          title={titleIdx >= 0 ? show(openRow[titleIdx]) : null}
          onClose={() => setOpenRow(null)}
        />
      )}
    </div>
    )}
    </div>
  );
}