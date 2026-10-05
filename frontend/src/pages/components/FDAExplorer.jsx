import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import LoadingSpinner from './LoadingSpinner';
import { apiFetch, downloadFile } from '../../utils/apiClient';

import downloadIcon from "/icons/JJ_Icon_Download_PDF_RGB.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import closeIcon from "/icons/JJ_Icon_Close.svg";
import searchIcon from "/icons/JJ_Icon_Search_RGB.svg";
import filterIcon from "/icons/JJ_Icon_Filter.svg";
import chevronDownIcon from "/icons/JJ_Icon_Chevron_Down.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import infoIcon from "/icons/JJ_Icon_Info_RGB.svg";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// Same tint filters as Unstructured.jsx (declared once via <IconDefs/> in
// that parent page, which is always mounted above this component).
const ICON_TINTS = { red: "url(#jj-red-tint)", ink: "url(#jj-ink-tint)", gray: "url(#jj-gray-tint)", white: "url(#jj-white-tint)" };
const Icon = ({ src, alt = "", className = "w-4 h-4", tint = "ink" }) => (
  <img src={src} alt={alt} className={className} style={tint ? { filter: ICON_TINTS[tint] } : undefined} />
);

// Self-contained sibling of NipoExplorer.jsx - same pattern, own small copies
// of the generic UI primitives, dropped into the FDA tab. Backed entirely by
// /api/fda/*, which reads vector_embedding.crl_ai_matches - one row per FDA
// CRL letter <-> Pink Sheet row match, already flat (no grouping needed).

const FALLBACK_COLORS = ["#ff6017", "#8c3bbb", "#004685", "#9e0000", "#3b5a0d"];
const DECISION_COLORS = { YES: "#328714", NO: "#eb1700", "(UNSPECIFIED)": "#6e6259" };

function useDebounced(value, delay = 400) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}


function formatCompact(n) {
  if (n == null || isNaN(n)) return n;
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function formatEasternTimestamp(ts) {
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }) + ' ET';
}

async function fetchJson(url, opts) {
  const res = await apiFetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${res.status})`);
  }
  return res.json();
}

function Pager({ page, totalPages, loading, onGo }) {
  const [draft, setDraft] = useState(String(page));
  useEffect(() => { setDraft(String(page)); }, [page]);
  const commit = () => {
    const n = parseInt(draft, 10);
    if (!Number.isNaN(n)) onGo(n);
    else setDraft(String(page));
  };
  const btn = "px-2.5 py-1.5 rounded-lg border border-jj-gray-03 text-[11.5px] font-johnson-text disabled:opacity-40 hover:bg-jj-gray-01";
  return (
    <div className="flex items-center gap-1.5">
      <button onClick={() => onGo(1)} disabled={page <= 1 || loading} className={btn} title="First page">«</button>
      <button onClick={() => onGo(page - 1)} disabled={page <= 1 || loading} className={btn} title="Previous page">Prev</button>
      <span className="flex items-center gap-1.5 text-[11.5px] font-johnson-text text-jj-gray-07 tabular-nums">
        <input
          type="number"
          min="1"
          max={totalPages}
          value={draft}
          disabled={loading}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); e.target.blur(); } }}
          className="w-[62px] border border-jj-gray-03 rounded-lg px-2 py-1 text-center font-johnson-text tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          aria-label="Go to page"
        />
        of {totalPages.toLocaleString()}
      </span>
      <button onClick={() => onGo(page + 1)} disabled={page >= totalPages || loading} className={btn} title="Next page">Next</button>
      <button onClick={() => onGo(totalPages)} disabled={page >= totalPages || loading} className={btn} title="Last page">»</button>
    </div>
  );
}

// The /data list already returns every column - no separate detail fetch
// needed (unlike Nipo, which aggregates and has to fetch chunks separately).
function DetailModal({ record, onClose }) {
  if (!record) return null;
  const cellDisplayText = (v) => {
    if (typeof v === 'object' && v !== null) {
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return String(v);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-jj-gray-02 sticky top-0 bg-white z-10">
          <h3 className="font-johnson-display font-bold text-lg text-jj-gray-08">Match detail</h3>
          <button onClick={onClose}><img src={closeIcon} alt="Close" className="w-4 h-4" style={{ filter: 'url(#jj-ink-tint)' }} /></button>
        </div>
        <div className="p-5 space-y-0">
          {Object.entries(record).map(([k, v]) => (
            <div key={k} className="flex text-xs font-johnson-text border-b border-jj-gray-01 py-2.5">
              <div className="w-1/3 text-jj-gray-06 flex-shrink-0">{k}</div>
              <div className="w-2/3 text-jj-gray-08 break-words whitespace-pre-wrap">{v === null || v === undefined || v === '' ? <span className="italic text-jj-gray-05">null</span> : cellDisplayText(v)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Copy-to-clipboard glyph (two overlapping sheets) - inherits text color via
// currentColor so it matches whatever button it's dropped into.
const CopyIcon = ({ className = "w-3 h-3" }) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

// "View SQL" modal shared by every chart, KPI band and data table in all
// three FDA dashboards - shows the exact query that ran, with bound params
// already inlined by the backend's _render_sql_for_display.
function SqlModal({ modal, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!modal) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(modal.sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable - text is still selectable
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-jj-gray-02 sticky top-0 bg-white">
          <div>
            <h3 className="font-johnson-display font-bold text-lg text-jj-gray-08">Query</h3>
            <div className="text-xs font-johnson-text text-jj-gray-06">{modal.title}</div>
          </div>
          <button onClick={onClose}><Icon src={closeIcon} alt="Close" tint="ink" className="w-4 h-4" /></button>
        </div>
        <div className="p-5">
          {modal.sql ? (
            <>
              <div className="relative">
                <pre className="text-xs font-mono bg-jj-gray-08 text-white/90 rounded-xl p-4 pr-12 overflow-x-auto whitespace-pre-wrap break-words">
                  {modal.sql}
                </pre>
                <button
                  onClick={handleCopy}
                  title={copied ? "Copied" : "Copy SQL"}
                  className={`absolute top-2.5 right-2.5 p-1.5 rounded-lg border transition-colors ${
                    copied ? "text-jj-green-03 border-jj-green-03/50" : "text-white/60 border-white/20 hover:text-white hover:border-white/40"
                  }`}
                >
                  {copied ? "✓" : <CopyIcon className="w-3.5 h-3.5" />}
                </button>
              </div>
              <button
                onClick={handleCopy}
                className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-jj-gray-03 text-xs font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
              >
                <CopyIcon />
                {copied ? "Copied" : "Copy SQL"}
              </button>
            </>
          ) : (
            <div className="text-xs font-johnson-text text-jj-gray-06">
              No query has run yet for this card - it'll appear here after the data loads.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================== dependency-free charts (mirrors NipoExplorer.jsx) ============================== */

const ChartSkeleton = ({ height = 240 }) => (
  <div style={{ height }} className="flex items-center justify-center">
    <LoadingSpinner />
  </div>
);

const NoData = () => (
  <div className="text-xs font-johnson-text text-jj-gray-06 py-10 text-center">No data for current filters.</div>
);

const CardUnavailable = ({ message, onRetry }) => (
  <div className="py-9 px-3 text-center">
    <div className="text-xs font-johnson-text text-jj-maroon-05 mb-1.5 break-words">{message}</div>
    <button onClick={onRetry} className="text-xs font-johnson-text text-jj-blue-03 underline">Retry</button>
  </div>
);

function useChartTip() {
  const [tip, setTip] = useState(null);
  const show = (e, rows) => setTip({ x: e.clientX, y: e.clientY, rows });
  const hide = () => setTip(null);
  const node = tip ? (
    <div
      className="fixed z-[60] pointer-events-none rounded-lg bg-jj-gray-08 text-white shadow-xl px-3 py-2"
      style={{
        left: Math.min(tip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 220),
        top: (() => {
          const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
          const estHeight = tip.rows.length * 20 + 16;
          return tip.y + 14 + estHeight > winH ? Math.max(8, tip.y - estHeight - 10) : tip.y + 14;
        })(),
      }}
    >
      {tip.rows.map((r, i) => r.header ? (
        <div key={i} className="text-[11px] font-johnson-text font-bold mb-1 whitespace-nowrap">{r.label}</div>
      ) : (
        <div key={i} className="flex items-center gap-2 text-[11px] font-johnson-text whitespace-nowrap leading-relaxed">
          {r.color && <span className="w-2 h-2 rounded-[2px] flex-shrink-0" style={{ background: r.color }} />}
          <span className="text-white/70">{r.label}</span>
          <span className="ml-auto pl-4 tabular-nums">{r.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  ) : null;
  return { show, hide, node };
}

function StatusDonut({ segments, headerLabel = 'Breakdown' }) {
  const tip = useChartTip();
  const R = 26, C = 2 * Math.PI * R;
  const total = segments.reduce((a, s) => a + s.count, 0);
  const tipRows = [
    { label: headerLabel, header: true },
    ...segments.map(s => ({ label: s.status, value: s.count, color: s.color })),
    { label: 'Total', value: total },
  ];
  let offset = 0;
  return (
    <>
    <svg width="64" height="64" viewBox="0 0 64 64" className="flex-shrink-0 -rotate-90">
      <circle cx="32" cy="32" r={R} fill="none" stroke="#f1efed" strokeWidth="9" />
      {segments.map((s, i) => {
        const dash = s.frac * C;
        const el = (
          <circle key={i} cx="32" cy="32" r={R} fill="none" stroke={s.color} strokeWidth="9"
            strokeDasharray={`${dash} ${C}`} strokeDashoffset={-offset}
            style={{ cursor: 'default' }}
            onMouseMove={(e) => tip.show(e, tipRows)}
            onMouseLeave={tip.hide}
          />
        );
        offset += dash;
        return el;
      })}
    </svg>
    {tip.node}
    </>
  );
}

function RankedBars({ data, formatValue = formatCompact }) {
  const tip = useChartTip();
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div className="flex flex-col gap-2">
      {data.map((d, i) => (
        <div
          key={`${d.area}-${i}`}
          className="cursor-default rounded hover:bg-jj-gray-01/60"
          onMouseMove={(e) => tip.show(e, [
            { label: d.area, header: true },
            { label: 'Value', value: d.count, color: '#0f68b2' },
          ])}
          onMouseLeave={tip.hide}
        >
          <div className="flex justify-between text-[11px] font-johnson-text mb-[3px]">
            <span className="text-jj-gray-08 truncate pr-2">{d.area}</span>
            <span className="text-jj-gray-08 tabular-nums flex-shrink-0">{formatValue(d.count)}</span>
          </div>
          <div className="h-[9px] rounded bg-jj-gray-01">
            <div className="h-full rounded" style={{ width: `${(d.count / max) * 100}%`, background: 'linear-gradient(90deg,#0f68b2,#004685)' }} />
          </div>
        </div>
      ))}
      {tip.node}
    </div>
  );
}

function Card({ className = "", children }) {
  return (
    <div className={`bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] ${className}`}>
      {children}
    </div>
  );
}

function ErrorBanner({ message, onRetry }) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-3 rounded-xl bg-red-50 border border-jj-maroon-05 text-jj-maroon-05 text-sm font-johnson-text">
      <div className="flex items-center gap-2">
        <Icon src={alertIcon} tint="red" className="w-4 h-4" />
        {message}
      </div>
      <button onClick={onRetry} className="underline flex-shrink-0">Retry</button>
    </div>
  );
}

/* ============================== filter rail ============================== */

function FdaFacetGroup({ label, column, selected, onChange, options, loading }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const toggleValue = (val) => {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);
  };
  const sorted = [...(options || [])].sort((a, b) => (b.count || 0) - (a.count || 0));
  const shown = query ? sorted.filter(o => String(o.value ?? "").toLowerCase().includes(query.toLowerCase())) : sorted;
  const maxCount = Math.max(1, ...sorted.map(o => o.count || 0));

  return (
    <div className="border-b border-jj-gray-01 last:border-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-[18px] py-3.5 text-left hover:bg-jj-gray-01/50 transition-colors"
      >
        <span className="text-[11px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-07">
          {label}
          {selected.length > 0 && (
            <span className="ml-2 inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium normal-case tracking-normal">
              {selected.length}
            </span>
          )}
        </span>
        <span className="text-jj-gray-06 text-[10px]"><Icon src={open ? chevronDownIcon : chevronRightIcon} tint="gray" className="w-2.5 h-2.5 flex-shrink-0" /></span>
      </button>
      {open && (
        <div className="px-[18px] pb-3.5">
          {(sorted.length > 8) && (
            <div className="relative mb-2">
              <Icon src={searchIcon} tint="gray" className="w-[11px] h-[11px] absolute left-2 top-[8px]" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Narrow list…"
                className="w-full pl-6 pr-2 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
              />
            </div>
          )}
          {loading && <div className="text-xs font-johnson-text text-jj-gray-06 py-1.5">Loading…</div>}
          {!loading && shown.length === 0 && (
            <div className="text-xs font-johnson-text text-jj-gray-06 py-1.5">No values found</div>
          )}
          {!loading && shown.map(({ value, count }) => {
            const valKey = String(value);
            const checked = selected.includes(valKey);
            const pct = Math.round((count / maxCount) * 100);
            return (
              <label key={valKey} className="flex flex-col gap-1.5 py-2 px-1 -mx-1 rounded cursor-pointer hover:bg-jj-gray-01/60">
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={checked} onChange={() => toggleValue(valKey)} className="accent-[#0f68b2] flex-shrink-0" />
                  <span className={`flex-1 truncate text-[12.5px] font-johnson-text ${checked ? 'font-bold text-jj-gray-08' : 'font-medium text-jj-gray-08'}`}>
                    {value == null ? '(unspecified)' : value}
                  </span>
                  <span className="text-[11px] font-johnson-text text-jj-gray-06 tabular-nums flex-shrink-0">{formatCompact(count)}</span>
                </div>
                <div className="h-[5px] rounded-full bg-jj-gray-01 ml-[22px]">
                  <div className="h-full rounded-full bg-jj-blue-03" style={{ width: `${pct}%` }} />
                </div>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DecisionPill({ value }) {
  const key = String(value || "").toUpperCase();
  const color = DECISION_COLORS[key] || "#6e6259";
  return (
    <span
      className="inline-flex items-center gap-[5px] text-[11px] font-johnson-text font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap"
      style={{ background: `${color}17`, color }}
    >
      <span className="w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: color }} />
      {value || "Unknown"}
    </span>
  );
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join("; ") : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadClientCsv(filename, columns, rows) {
  const lines = [columns.map(csvEscape).join(",")];
  rows.forEach(r => lines.push(columns.map(c => csvEscape(r[c])).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const FDA_TABLE_COLUMNS = [
  { key: "fda_sponsor", label: "FDA sponsor", sortCol: "fda_sponsor", bold: true, minWidth: 200 },
  { key: "fda_product", label: "FDA product", sortCol: "fda_product", minWidth: 220 },
  { key: "pink_sponsor_product", label: "Pink sponsor/product", sortCol: "pink_sponsor_product", minWidth: 260 },
  { key: "pink_indication", label: "Indication", sortCol: "pink_indication", minWidth: 220 },
  { key: "llm_decision", label: "Match", sortCol: "llm_decision", minWidth: 90 },
  { key: "sim_score", label: "Score", sortCol: "sim_score", minWidth: 80 },
  { key: "method", label: "Method", sortCol: "method", minWidth: 110 },
  { key: "fda_letter_date", label: "FDA letter date", sortCol: "fda_letter_date", minWidth: 140 },
  { key: "created_at", label: "Matched at", sortCol: "created_at", minWidth: 170 },
];

const ALL_COLUMNS = [
  "id", "fda_id", "fda_file_name", "fda_status", "fda_letter_date", "fda_sponsor", "fda_product",
  "pink_row_num", "pink_sponsor_product", "pink_indication", "pink_issues", "pink_activity", "pink_date_announced",
  "method", "sim_score", "llm_decision", "llm_rationale", "created_at",
];

/* ============================== FDA tab ============================== */
// Backed by /api/fda/* - seven dashboards over seven related tables in the
// vector_embedding schema: 'crl_matches' (crl_ai_matches, CRL <-> Pink Sheet
// matches), 'crl_letters' (crl_letters, the raw ingested CRL letters
// themselves), 'crl_pink_letters' (crl_pink_letters, the Pink Sheet
// writeups those CRLs get matched against), 'ectd_docs' (ectd_docs, the
// eCTD submission document index), 'fda_letters_v2' (fda_crl_letters, a
// richer re-ingest of crl_letters with a real date column and more fields),
// 'milvexian_metadata' (milvexian_metadata, the same Documentum-style
// document index as ectd_docs, scoped to the milvexian program) and
// 'rim_facility_index' (rimdocs_facility_index_unified, AI-extracted
// facility records pulled out of RIM documents). `dashboard` (see
// FDA_DASHBOARDS in Unstructured.jsx) picks which one renders below.
export default function FDAExplorer({ logInPage, activeTab, onBusyChange, dashboard }) {
  if (dashboard === 'crl_letters') {
    return <CrlLettersExplorer logInPage={logInPage} activeTab={activeTab} onBusyChange={onBusyChange} />;
  }
  if (dashboard === 'crl_pink_letters') {
    return <PinkLettersExplorer logInPage={logInPage} activeTab={activeTab} onBusyChange={onBusyChange} />;
  }
  if (dashboard === 'ectd_docs') {
    return <EctdDocsExplorer logInPage={logInPage} activeTab={activeTab} onBusyChange={onBusyChange} />;
  }
  if (dashboard === 'fda_letters_v2') {
    return <FdaLettersV2Explorer logInPage={logInPage} activeTab={activeTab} onBusyChange={onBusyChange} />;
  }
  if (dashboard === 'milvexian_metadata') {
    return <MilvexianMetadataExplorer logInPage={logInPage} activeTab={activeTab} onBusyChange={onBusyChange} />;
  }
  if (dashboard === 'rim_facility_index') {
    return <FacilityIndexExplorer logInPage={logInPage} activeTab={activeTab} onBusyChange={onBusyChange} />;
  }
  return <CrlMatchesExplorer logInPage={logInPage} activeTab={activeTab} onBusyChange={onBusyChange} />;
}

function CrlMatchesExplorer({ logInPage, activeTab, onBusyChange }) {
  /* ---------- Dashboard ---------- */
  const [summary, setSummary] = useState(null);
  const [decisionChart, setDecisionChart] = useState([]);
  const [methodChart, setMethodChart] = useState([]);
  const [topSponsorsChart, setTopSponsorsChart] = useState([]);
  const [chartsLoading, setChartsLoading] = useState(true);
  const [chartsError, setChartsError] = useState(null);
  const [cardErrors, setCardErrors] = useState({});
  const [decisionSql, setDecisionSql] = useState("");
  const [methodSql, setMethodSql] = useState("");
  const [sponsorsSql, setSponsorsSql] = useState("");
  const [sqlModal, setSqlModal] = useState(null);
  const openSqlModal = (payload) => setSqlModal(payload);

  const loadDashboard = useCallback(() => {
    setChartsLoading(true);
    setChartsError(null);
    Promise.allSettled([
      fetchJson(`${API_BASE_URL}/api/fda/summary`),
      fetchJson(`${API_BASE_URL}/api/fda/charts/decision`),
      fetchJson(`${API_BASE_URL}/api/fda/charts/method`),
      fetchJson(`${API_BASE_URL}/api/fda/charts/top-sponsors?limit=10`),
    ]).then(([summaryRes, decisionRes, methodRes, sponsorsRes]) => {
      const errors = {};
      if (summaryRes.status === "fulfilled") setSummary(summaryRes.value);
      else errors.summary = summaryRes.reason?.message || "Failed to load summary";

      if (decisionRes.status === "fulfilled") { setDecisionChart(decisionRes.value.rows || []); setDecisionSql(decisionRes.value.sql || ""); }
      else errors.decision = decisionRes.reason?.message || "Failed to load chart";

      if (methodRes.status === "fulfilled") { setMethodChart(methodRes.value.rows || []); setMethodSql(methodRes.value.sql || ""); }
      else errors.method = methodRes.reason?.message || "Failed to load chart";

      if (sponsorsRes.status === "fulfilled") { setTopSponsorsChart(sponsorsRes.value.rows || []); setSponsorsSql(sponsorsRes.value.sql || ""); }
      else errors.sponsors = sponsorsRes.reason?.message || "Failed to load chart";

      setCardErrors(errors);
      if (summaryRes.status === "rejected" && Object.keys(errors).length === 4) {
        setChartsError(errors.summary);
      }
      setChartsLoading(false);
    });
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  // Business-friendly labels for the raw yes/no decision - "Confirmed" reads
  // as a completed review, "Needs review" as a call to action, where "YES"/
  // "NO" alone would read as a database value rather than a status.
  const decisionLabel = (raw) => {
    const key = String(raw || "").toUpperCase();
    if (key === "YES") return "Confirmed match";
    if (key === "NO") return "Needs review";
    return "Unclassified";
  };

  const decisionFallbackIdx = useRef({ i: 0 });
  const decisionSegments = useMemo(() => {
    const sum = decisionChart.reduce((a, r) => a + (r.count || 0), 0);
    if (!sum) return { segments: [], total: 0 };
    decisionFallbackIdx.current.i = 0;
    const sorted = [...decisionChart].sort((a, b) => b.count - a.count);
    return {
      total: sum,
      segments: sorted.map(r => ({
        status: decisionLabel(r.decision),
        color: DECISION_COLORS[String(r.decision || "").toUpperCase()] || FALLBACK_COLORS[decisionFallbackIdx.current.i++ % FALLBACK_COLORS.length],
        frac: r.count / sum,
        count: r.count,
      })),
    };
  }, [decisionChart]);

  const methodBars = useMemo(() => methodChart.map(r => ({ area: r.method, count: r.count })), [methodChart]);
  const sponsorBars = useMemo(() => topSponsorsChart.map(r => ({ area: r.fda_sponsor, count: r.count })), [topSponsorsChart]);

  /* ---------- Data table ---------- */
  const [filters, setFilters] = useState({});
  const [searchSponsor, setSearchSponsor] = useState("");
  const [searchProduct, setSearchProduct] = useState("");
  const [searchPinkSponsorProduct, setSearchPinkSponsorProduct] = useState("");
  const [searchIndication, setSearchIndication] = useState("");
  const debouncedSponsor = useDebounced(searchSponsor);
  const debouncedProduct = useDebounced(searchProduct);
  const debouncedPinkSponsorProduct = useDebounced(searchPinkSponsorProduct);
  const debouncedIndication = useDebounced(searchIndication);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortCol, setSortCol] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState(null);
  const [dataSql, setDataSql] = useState("");

  const [facets, setFacets] = useState({});
  const [facetsLoading, setFacetsLoading] = useState(true);

  const [detailRow, setDetailRow] = useState(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const filtersParam = useMemo(() => {
    const parts = Object.entries(filters)
      .filter(([, vals]) => vals && vals.length > 0)
      .map(([col, vals]) => `${col}:${vals.join("||")}`);
    return parts.join(",");
  }, [filters]);
  const activeFilterCount = Object.values(filters).reduce((n, vals) => n + (vals?.length || 0), 0);

  useEffect(() => { setPage(1); }, [filtersParam, debouncedSponsor, debouncedProduct, debouncedPinkSponsorProduct, debouncedIndication, pageSize]);

  useEffect(() => {
    const controller = new AbortController();
    setFacetsLoading(true);
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    const qs = params.toString() ? `?${params.toString()}` : "";
    fetchJson(`${API_BASE_URL}/api/fda/facets${qs}`, { signal: controller.signal })
      .then(data => { setFacets(data); setFacetsLoading(false); })
      .catch(() => setFacetsLoading(false));
    return () => controller.abort();
  }, [filtersParam]);

  const buildDataQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    if (debouncedSponsor) params.set("search_fda_sponsor", debouncedSponsor);
    if (debouncedProduct) params.set("search_fda_product", debouncedProduct);
    if (debouncedPinkSponsorProduct) params.set("search_pink_sponsor_product", debouncedPinkSponsorProduct);
    if (debouncedIndication) params.set("search_pink_indication", debouncedIndication);
    params.set("sort_col", sortCol);
    params.set("sort_dir", sortDir);
    return params;
  }, [filtersParam, debouncedSponsor, debouncedProduct, debouncedPinkSponsorProduct, debouncedIndication, sortCol, sortDir]);

  useEffect(() => {
    const controller = new AbortController();
    setRowsLoading(true);
    setRowsError(null);
    const params = buildDataQuery();
    params.set("page", String(page));
    params.set("page_size", String(pageSize));
    fetchJson(`${API_BASE_URL}/api/fda/data?${params.toString()}`, { signal: controller.signal })
      .then(data => {
        setRows(data.rows || []);
        setTotal(data.total || 0);
        setTotalPages(data.total_pages || 1);
        setDataSql(data.sql || "");
        setRowsLoading(false);
      })
      .catch(e => {
        if (e.name === "AbortError") return;
        setRowsError(e.message || "Failed to load FDA matches");
        setRowsLoading(false);
      });
    return () => controller.abort();
  }, [buildDataQuery, page, pageSize]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  };

  const cellFor = (row, col) => {
    switch (col) {
      case "sim_score":
        return row.sim_score != null ? Number(row.sim_score).toFixed(3) : "—";
      case "created_at":
        return row.created_at ? formatEasternTimestamp(row.created_at) : "—";
      default:
        return row[col] ?? "—";
    }
  };

  const downloadPageCsv = () => {
    logInPage("export_page", `Downloaded current page (${rows.length} rows) of FDA matches`);
    downloadClientCsv("fda_crl_ai_matches_page.csv", ALL_COLUMNS, rows);
  };

  const downloadAllCsv = async () => {
    setDownloadingAll(true);
    logInPage("export_all", `Downloaded all ${total.toLocaleString()} matching FDA matches`);
    try {
      const params = buildDataQuery();
      await downloadFile(`/api/fda/data/download?${params.toString()}`, "fda_crl_ai_matches.csv");
    } catch (e) {
      setRowsError(e.message || "Download failed");
    } finally {
      setDownloadingAll(false);
    }
  };

  const busy = chartsLoading || rowsLoading;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const matchesTableCardRef = useRef(null);
  const [matchesFullscreen, setMatchesFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setMatchesFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  const toggleMatchesFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else matchesTableCardRef.current?.requestFullscreen?.();
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ============ DASHBOARD ============ */}
      {activeTab === "explore" && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-5 flex flex-col gap-3.5 min-h-full">
            {chartsError && <ErrorBanner message={`Couldn't load the FDA dashboard: ${chartsError}`} onRetry={loadDashboard} />}
            {!chartsError && !chartsLoading && Object.keys(cardErrors).length > 0 && (
              <div className="px-4 py-2.5 rounded-xl bg-jj-gray-01 border border-jj-gray-02 text-xs font-johnson-text text-jj-gray-07">
                Some cards couldn't load ({Object.keys(cardErrors).length} of 4).
              </div>
            )}

            {/* KPI band */}
            <div className="flex items-center justify-between flex-shrink-0">
              <span />
              {summary?.sql && (
                <button onClick={() => openSqlModal({ title: "KPI summary", sql: summary.sql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
              )}
            </div>
            <div className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">CRL letters reviewed</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.total_matches) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">matched against Pink Sheet filings</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Confirmed matches</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary?.match_rate != null ? `${summary.match_rate}%` : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">{summary ? `${formatCompact(summary.matches_confirmed)} of ${formatCompact(summary.total_matches)} letters` : "verified by AI review"}</div>
              </div>
              <div className={`bg-white px-5 py-4 flex flex-col justify-center min-w-0`}>
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Needs manual review</div>
                <div className={`font-johnson-display font-bold text-[26px] leading-none tabular-nums ${summary?.matches_rejected ? "text-jj-red" : "text-jj-gray-08"}`}>
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.matches_rejected) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">letters the AI couldn't confidently match</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Sponsors covered</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_sponsors) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">unique companies represented</div>
              </div>
            </div>

            {/* Match outcome + top sponsors */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Match outcome</div>
                  {decisionSql && <button onClick={() => openSqlModal({ title: "Match outcome", sql: decisionSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">how many CRL letters were confidently matched vs. flagged for review</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.decision ? (
                  <CardUnavailable message={cardErrors.decision} onRetry={loadDashboard} />
                ) : decisionSegments.segments.length ? (
                  <div className="flex items-center gap-5">
                    <StatusDonut segments={decisionSegments.segments} headerLabel="Match outcome" />
                    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                      {decisionSegments.segments.map(s => (
                        <div key={s.status} className="flex items-center gap-2 text-[11.5px] font-johnson-text">
                          <span className="w-2 h-2 rounded-[2px] flex-shrink-0" style={{ background: s.color }} />
                          <span className="text-jj-gray-08 truncate flex-1">{s.status}</span>
                          <span className="text-jj-gray-06 tabular-nums">{Math.round(s.frac * 100)}%</span>
                          <span className="text-jj-gray-08 font-medium tabular-nums w-12 text-right">{formatCompact(s.count)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : <NoData />}
              </Card>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Sponsors with the most CRLs</div>
                  {sponsorsSql && <button onClick={() => openSqlModal({ title: "Sponsors with the most CRLs", sql: sponsorsSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">companies most frequently receiving Complete Response Letters</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.sponsors ? (
                  <CardUnavailable message={cardErrors.sponsors} onRetry={loadDashboard} />
                ) : sponsorBars.length ? (
                  <RankedBars data={sponsorBars} />
                ) : <NoData />}
              </Card>
            </div>

            {/* How matches were verified - full width */}
            <Card className="px-5 py-4 flex-shrink-0">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">How matches were verified</div>
                {methodSql && <button onClick={() => openSqlModal({ title: "How matches were verified", sql: methodSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
              </div>
              <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">review approach used to confirm each CRL-to-filing match</div>
              {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.method ? (
                <CardUnavailable message={cardErrors.method} onRetry={loadDashboard} />
              ) : methodBars.length ? (
                <RankedBars data={methodBars} />
              ) : <NoData />}
            </Card>
          </div>
        </div>
      )}

      {/* ============ DATA TABLE ============ */}
      {activeTab === "table" && (
        <div className="flex-1 min-h-0 flex">
          {/* Filter rail */}
          <div className="w-[252px] flex-shrink-0 bg-white border-r border-jj-gray-02 flex flex-col overflow-hidden">
            <div className="px-[18px] pt-4 pb-3 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2 text-[13px] font-johnson-text font-bold text-jj-gray-08">
                <Icon src={filterIcon} tint="ink" className="w-[13px] h-[13px]" />
                Refine
                {activeFilterCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium">
                    {activeFilterCount}
                  </span>
                )}
              </div>
              <button onClick={() => setFilters({})} disabled={activeFilterCount === 0} className="text-[11px] font-johnson-text text-jj-blue-03 disabled:opacity-40">
                Clear all
              </button>
            </div>
            <div className="px-[18px] pb-3.5 space-y-2 border-b border-jj-gray-01 flex-shrink-0">
              {[
                { value: searchSponsor, set: setSearchSponsor, ph: "FDA sponsor contains…" },
                { value: searchProduct, set: setSearchProduct, ph: "FDA product contains…" },
                { value: searchPinkSponsorProduct, set: setSearchPinkSponsorProduct, ph: "Pink sponsor/product contains…" },
                { value: searchIndication, set: setSearchIndication, ph: "Indication contains…" },
              ].map(({ value, set, ph }) => (
                <div key={ph} className="relative">
                  <Icon src={searchIcon} tint="gray" className="w-[13px] h-[13px] absolute left-2.5 top-[9px]" />
                  <input
                    value={value}
                    onChange={e => set(e.target.value)}
                    placeholder={ph}
                    className="w-full pl-8 pr-2 py-2 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
                  />
                </div>
              ))}
              <div className="text-[10px] font-johnson-text text-jj-gray-06">Applies after you stop typing.</div>
            </div>
            <div className="flex-1 overflow-y-auto">
              <FdaFacetGroup
                label="Decision"
                column="llm_decision"
                selected={filters.llm_decision || []}
                onChange={vals => setFilters(prev => ({ ...prev, llm_decision: vals }))}
                options={facets.llm_decision || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Method"
                column="method"
                selected={filters.method || []}
                onChange={vals => setFilters(prev => ({ ...prev, method: vals }))}
                options={facets.method || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="FDA status"
                column="fda_status"
                selected={filters.fda_status || []}
                onChange={vals => setFilters(prev => ({ ...prev, fda_status: vals }))}
                options={facets.fda_status || []}
                loading={facetsLoading}
              />
            </div>
          </div>

          {/* Main content */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-5 gap-0">
            {rowsError && <ErrorBanner message={rowsError} onRetry={() => setPage(p => p)} />}
            <div ref={matchesTableCardRef} className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-3 border-b border-jj-gray-01">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                  Matching records <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{total.toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-2.5">
                  {dataSql && (
                    <button onClick={() => openSqlModal({ title: "Data table (current page)", sql: dataSql })} className="text-[11px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
                  )}
                  <button
                    onClick={downloadPageCsv}
                    disabled={rowsLoading || rows.length === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Downloads the current page only"
                  >
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    Download page
                  </button>
                  <button
                    onClick={downloadAllCsv}
                    disabled={rowsLoading || downloadingAll || total === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Streams every matching row as CSV - no row cap"
                  >
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    {downloadingAll ? "Preparing…" : `Download all (${total.toLocaleString()})`}
                  </button>
                  <button
                    onClick={toggleMatchesFullscreen}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
                    title={matchesFullscreen ? "Exit full screen" : "View the table full screen"}
                  >
                    {matchesFullscreen ? "⤳ Exit full screen" : "⛶ Full screen"}
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 relative">
                {rowsLoading && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10">
                    <LoadingSpinner />
                  </div>
                )}
                <div className="h-full overflow-auto">
                  <table className="text-[12px] font-johnson-text border-collapse" style={{ width: "max-content", minWidth: "100%" }}>
                    <thead className="sticky top-0 z-[5]">
                      <tr className="bg-jj-gray-01 text-jj-gray-07 text-[11px] uppercase tracking-wider">
                        {FDA_TABLE_COLUMNS.map(col => (
                          <th
                            key={col.key}
                            onClick={() => col.sortCol && toggleSort(col.sortCol)}
                            style={{ minWidth: col.minWidth }}
                            className={`text-left px-3 py-2.5 font-bold select-none whitespace-nowrap ${col.sortCol ? "cursor-pointer" : ""}`}
                          >
                            {col.label} {col.sortCol && sortCol === col.sortCol ? (sortDir === "asc" ? "▲" : "▼") : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr
                          key={row.id ?? i}
                          onClick={() => {
                            logInPage("row_detail_view", `Opened FDA match detail for ${row.fda_sponsor || row.id || "row " + i}`);
                            setDetailRow(row);
                          }}
                          className="border-t border-jj-gray-01 hover:bg-jj-gray-01/50 cursor-pointer"
                        >
                          {FDA_TABLE_COLUMNS.map(col => (
                            <td
                              key={col.key}
                              style={{ minWidth: col.minWidth, maxWidth: col.minWidth * 2 }}
                              className={`px-3 py-2 truncate ${col.bold ? "font-medium text-jj-gray-08" : "text-jj-gray-07"}`}
                              title={typeof cellFor(row, col.key) === "string" ? cellFor(row, col.key) : undefined}
                            >
                              {col.key === "llm_decision" && row.llm_decision ? <DecisionPill value={row.llm_decision} /> : cellFor(row, col.key)}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {!rowsLoading && rows.length === 0 && (
                        <tr>
                          <td colSpan={FDA_TABLE_COLUMNS.length} className="px-3 py-8 text-center text-jj-gray-06">
                            {rowsError ? "Couldn't load matches." : "No matches match the current filters."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-2.5 border-t border-jj-gray-01">
                <div className="flex items-center gap-2 text-[11.5px] font-johnson-text text-jj-gray-06 tabular-nums">
                  <Icon src={infoIcon} tint="ink" className="w-3.5 h-3.5" />
                  {total.toLocaleString()} rows
                  <select
                    value={pageSize}
                    onChange={e => setPageSize(Number(e.target.value))}
                    disabled={rowsLoading}
                    className="ml-2 border border-jj-gray-03 rounded-lg px-2 py-1 font-johnson-text"
                  >
                    {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}/page</option>)}
                  </select>
                </div>
                <Pager page={page} totalPages={totalPages} loading={rowsLoading} onGo={setPage} />
              </div>
            </div>
          </div>
        </div>
      )}

      <DetailModal record={detailRow} onClose={() => setDetailRow(null)} />
      <SqlModal modal={sqlModal} onClose={() => setSqlModal(null)} />
    </div>
  );
}

/* ============================== CRL Letters dashboard ============================== */
// Backed by /api/fda/letters/* (vector_embedding.crl_letters) - the raw CRL
// letters themselves, before AI matching. Kept to business-relevant columns:
// no local_path (file system detail), no meta_json (duplicates notes/other
// columns as JSON) and no method_version (every row is 'crl_v1' today, so
// it's not something a business user would ever slice by).

const LETTERS_STATUS_COLORS = { APPROVED: "#328714", UNAPPROVED: "#eb1700", "(UNSPECIFIED)": "#6e6259" };

const LETTERS_TABLE_COLUMNS = [
  { key: "id", label: "ID", sortCol: "id", minWidth: 70 },
  { key: "sponsor", label: "Sponsor", sortCol: "sponsor", bold: true, minWidth: 200 },
  { key: "product_name", label: "Product", sortCol: "product_name", minWidth: 220 },
  { key: "application_type", label: "Application type", sortCol: "application_type", minWidth: 130 },
  { key: "submission_id", label: "Submission ID", sortCol: "submission_id", minWidth: 150 },
  { key: "status", label: "Status", sortCol: "status", minWidth: 110 },
  { key: "letter_date", label: "Letter date", sortCol: "letter_date", minWidth: 120 },
  { key: "letter_text", label: "Letter text", minWidth: 340 },
];

const LETTERS_ALL_COLUMNS = [
  "id", "file_name", "status", "sponsor", "product_name", "application_type",
  "submission_id", "letter_date", "notes", "letter_text", "processed_at",
];

function LettersStatusPill({ value }) {
  const key = String(value || "").toUpperCase();
  const color = LETTERS_STATUS_COLORS[key] || "#6e6259";
  return (
    <span
      className="inline-flex items-center gap-[5px] text-[11px] font-johnson-text font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap capitalize"
      style={{ background: `${color}17`, color }}
    >
      <span className="w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: color }} />
      {value || "Unknown"}
    </span>
  );
}

function CrlLettersExplorer({ logInPage, activeTab, onBusyChange }) {
  /* ---------- Dashboard ---------- */
  const [summary, setSummary] = useState(null);
  const [statusChart, setStatusChart] = useState([]);
  const [appTypeChart, setAppTypeChart] = useState([]);
  const [topSponsorsChart, setTopSponsorsChart] = useState([]);
  const [byYearChart, setByYearChart] = useState([]);
  const [chartsLoading, setChartsLoading] = useState(true);
  const [chartsError, setChartsError] = useState(null);
  const [cardErrors, setCardErrors] = useState({});
  const [statusSql, setStatusSql] = useState("");
  const [appTypeSql, setAppTypeSql] = useState("");
  const [sponsorsSql, setSponsorsSql] = useState("");
  const [byYearSql, setByYearSql] = useState("");
  const [sqlModal, setSqlModal] = useState(null);
  const openSqlModal = (payload) => setSqlModal(payload);

  const loadDashboard = useCallback(() => {
    setChartsLoading(true);
    setChartsError(null);
    Promise.allSettled([
      fetchJson(`${API_BASE_URL}/api/fda/letters/summary`),
      fetchJson(`${API_BASE_URL}/api/fda/letters/charts/status`),
      fetchJson(`${API_BASE_URL}/api/fda/letters/charts/application-type`),
      fetchJson(`${API_BASE_URL}/api/fda/letters/charts/top-sponsors?limit=10`),
      fetchJson(`${API_BASE_URL}/api/fda/letters/charts/by-year`),
    ]).then(([summaryRes, statusRes, appTypeRes, sponsorsRes, yearRes]) => {
      const errors = {};
      if (summaryRes.status === "fulfilled") setSummary(summaryRes.value);
      else errors.summary = summaryRes.reason?.message || "Failed to load summary";

      if (statusRes.status === "fulfilled") { setStatusChart(statusRes.value.rows || []); setStatusSql(statusRes.value.sql || ""); }
      else errors.status = statusRes.reason?.message || "Failed to load chart";

      if (appTypeRes.status === "fulfilled") { setAppTypeChart(appTypeRes.value.rows || []); setAppTypeSql(appTypeRes.value.sql || ""); }
      else errors.appType = appTypeRes.reason?.message || "Failed to load chart";

      if (sponsorsRes.status === "fulfilled") { setTopSponsorsChart(sponsorsRes.value.rows || []); setSponsorsSql(sponsorsRes.value.sql || ""); }
      else errors.sponsors = sponsorsRes.reason?.message || "Failed to load chart";

      if (yearRes.status === "fulfilled") { setByYearChart(yearRes.value.rows || []); setByYearSql(yearRes.value.sql || ""); }
      else errors.byYear = yearRes.reason?.message || "Failed to load chart";

      setCardErrors(errors);
      if (summaryRes.status === "rejected" && Object.keys(errors).length === 5) {
        setChartsError(errors.summary);
      }
      setChartsLoading(false);
    });
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const statusFallbackIdx = useRef({ i: 0 });
  const statusSegments = useMemo(() => {
    const sum = statusChart.reduce((a, r) => a + (r.count || 0), 0);
    if (!sum) return { segments: [], total: 0 };
    statusFallbackIdx.current.i = 0;
    const sorted = [...statusChart].sort((a, b) => b.count - a.count);
    return {
      total: sum,
      segments: sorted.map(r => ({
        status: r.status === "(unspecified)" ? "Unspecified" : r.status.charAt(0) + r.status.slice(1).toLowerCase(),
        color: LETTERS_STATUS_COLORS[String(r.status || "").toUpperCase()] || FALLBACK_COLORS[statusFallbackIdx.current.i++ % FALLBACK_COLORS.length],
        frac: r.count / sum,
        count: r.count,
      })),
    };
  }, [statusChart]);

  const appTypeBars = useMemo(() => appTypeChart.map(r => ({ area: r.application_type, count: r.count })), [appTypeChart]);
  const sponsorBars = useMemo(() => topSponsorsChart.map(r => ({ area: r.sponsor, count: r.count })), [topSponsorsChart]);
  const yearBars = useMemo(() => byYearChart.map(r => ({ area: r.year, count: r.count })), [byYearChart]);

  /* ---------- Data table ---------- */
  const [filters, setFilters] = useState({});
  const [selectedYears, setSelectedYears] = useState([]);
  const [searchSponsor, setSearchSponsor] = useState("");
  const [searchProduct, setSearchProduct] = useState("");
  const [searchSubmission, setSearchSubmission] = useState("");
  const debouncedSponsor = useDebounced(searchSponsor);
  const debouncedProduct = useDebounced(searchProduct);
  const debouncedSubmission = useDebounced(searchSubmission);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortCol, setSortCol] = useState("processed_at");
  const [sortDir, setSortDir] = useState("desc");

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState(null);
  const [dataSql, setDataSql] = useState("");

  const [facets, setFacets] = useState({});
  const [facetsLoading, setFacetsLoading] = useState(true);

  const [detailRow, setDetailRow] = useState(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const filtersParam = useMemo(() => {
    const parts = Object.entries(filters)
      .filter(([, vals]) => vals && vals.length > 0)
      .map(([col, vals]) => `${col}:${vals.join("||")}`);
    return parts.join(",");
  }, [filters]);
  const yearsParam = useMemo(() => selectedYears.join(","), [selectedYears]);
  const activeFilterCount = Object.values(filters).reduce((n, vals) => n + (vals?.length || 0), 0) + selectedYears.length;

  useEffect(() => { setPage(1); }, [filtersParam, yearsParam, debouncedSponsor, debouncedProduct, debouncedSubmission, pageSize]);

  useEffect(() => {
    const controller = new AbortController();
    setFacetsLoading(true);
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    if (yearsParam) params.set("years", yearsParam);
    const qs = params.toString() ? `?${params.toString()}` : "";
    fetchJson(`${API_BASE_URL}/api/fda/letters/facets${qs}`, { signal: controller.signal })
      .then(data => { setFacets(data); setFacetsLoading(false); })
      .catch(() => setFacetsLoading(false));
    return () => controller.abort();
  }, [filtersParam, yearsParam]);

  const buildDataQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    if (yearsParam) params.set("years", yearsParam);
    if (debouncedSponsor) params.set("search_sponsor", debouncedSponsor);
    if (debouncedProduct) params.set("search_product_name", debouncedProduct);
    if (debouncedSubmission) params.set("search_submission_id", debouncedSubmission);
    params.set("sort_col", sortCol);
    params.set("sort_dir", sortDir);
    return params;
  }, [filtersParam, yearsParam, debouncedSponsor, debouncedProduct, debouncedSubmission, sortCol, sortDir]);

  useEffect(() => {
    const controller = new AbortController();
    setRowsLoading(true);
    setRowsError(null);
    const params = buildDataQuery();
    params.set("page", String(page));
    params.set("page_size", String(pageSize));
    fetchJson(`${API_BASE_URL}/api/fda/letters/data?${params.toString()}`, { signal: controller.signal })
      .then(data => {
        setRows(data.rows || []);
        setTotal(data.total || 0);
        setTotalPages(data.total_pages || 1);
        setDataSql(data.sql || "");
        setRowsLoading(false);
      })
      .catch(e => {
        if (e.name === "AbortError") return;
        setRowsError(e.message || "Failed to load CRL letters");
        setRowsLoading(false);
      });
    return () => controller.abort();
  }, [buildDataQuery, page, pageSize]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  };

  const cellFor = (row, col) => {
    switch (col) {
      case "processed_at":
        return row.processed_at ? formatEasternTimestamp(row.processed_at) : "—";
      default:
        return row[col] ?? "—";
    }
  };

  const downloadPageCsv = () => {
    logInPage("export_page", `Downloaded current page (${rows.length} rows) of CRL letters`);
    downloadClientCsv("fda_crl_letters_page.csv", LETTERS_ALL_COLUMNS, rows);
  };

  const downloadAllCsv = async () => {
    setDownloadingAll(true);
    logInPage("export_all", `Downloaded all ${total.toLocaleString()} matching CRL letters`);
    try {
      const params = buildDataQuery();
      await downloadFile(`/api/fda/letters/data/download?${params.toString()}`, "fda_crl_letters.csv");
    } catch (e) {
      setRowsError(e.message || "Download failed");
    } finally {
      setDownloadingAll(false);
    }
  };

  const busy = chartsLoading || rowsLoading;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const lettersTableCardRef = useRef(null);
  const [lettersFullscreen, setLettersFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setLettersFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  const toggleLettersFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else lettersTableCardRef.current?.requestFullscreen?.();
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ============ DASHBOARD ============ */}
      {activeTab === "explore" && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-5 flex flex-col gap-3.5 min-h-full">
            {chartsError && <ErrorBanner message={`Couldn't load the CRL letters dashboard: ${chartsError}`} onRetry={loadDashboard} />}
            {!chartsError && !chartsLoading && Object.keys(cardErrors).length > 0 && (
              <div className="px-4 py-2.5 rounded-xl bg-jj-gray-01 border border-jj-gray-02 text-xs font-johnson-text text-jj-gray-07">
                Some cards couldn't load ({Object.keys(cardErrors).length} of 5).
              </div>
            )}

            {/* KPI band */}
            <div className="flex items-center justify-between flex-shrink-0">
              <span />
              {summary?.sql && (
                <button onClick={() => openSqlModal({ title: "KPI summary", sql: summary.sql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
              )}
            </div>
            <div className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">CRL letters received</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.total_letters) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">ingested from FDA Complete Response Letters</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Approval rate</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary?.approval_rate != null ? `${summary.approval_rate}%` : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">{summary ? `${formatCompact(summary.approved_count)} of ${formatCompact(summary.total_letters)} letters` : "eventually approved after CRL"}</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className={`font-johnson-display font-bold text-[26px] leading-none tabular-nums ${summary?.unapproved_count ? "text-jj-red" : "text-jj-gray-08"}`}>
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.unapproved_count) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1 mt-1">Still unapproved</div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">no approval on record yet</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Sponsors covered</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_sponsors) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">{summary ? `across ${formatCompact(summary.distinct_products)} products` : "unique companies represented"}</div>
              </div>
            </div>

            {/* Approval status + applications by type */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Approval status</div>
                  {statusSql && <button onClick={() => openSqlModal({ title: "Approval status", sql: statusSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">how many CRL letters have since been approved vs. remain unapproved</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.status ? (
                  <CardUnavailable message={cardErrors.status} onRetry={loadDashboard} />
                ) : statusSegments.segments.length ? (
                  <div className="flex items-center gap-5">
                    <StatusDonut segments={statusSegments.segments} headerLabel="Approval status" />
                    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                      {statusSegments.segments.map(s => (
                        <div key={s.status} className="flex items-center gap-2 text-[11.5px] font-johnson-text">
                          <span className="w-2 h-2 rounded-[2px] flex-shrink-0" style={{ background: s.color }} />
                          <span className="text-jj-gray-08 truncate flex-1">{s.status}</span>
                          <span className="text-jj-gray-06 tabular-nums">{Math.round(s.frac * 100)}%</span>
                          <span className="text-jj-gray-08 font-medium tabular-nums w-12 text-right">{formatCompact(s.count)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : <NoData />}
              </Card>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Applications by type</div>
                  {appTypeSql && <button onClick={() => openSqlModal({ title: "Applications by type", sql: appTypeSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">CRL letters split between BLA and NDA submissions</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.appType ? (
                  <CardUnavailable message={cardErrors.appType} onRetry={loadDashboard} />
                ) : appTypeBars.length ? (
                  <RankedBars data={appTypeBars} />
                ) : <NoData />}
              </Card>
            </div>

            {/* Top sponsors + letters over time */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Sponsors with the most CRLs</div>
                  {sponsorsSql && <button onClick={() => openSqlModal({ title: "Sponsors with the most CRLs", sql: sponsorsSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">companies most frequently receiving Complete Response Letters</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.sponsors ? (
                  <CardUnavailable message={cardErrors.sponsors} onRetry={loadDashboard} />
                ) : sponsorBars.length ? (
                  <RankedBars data={sponsorBars} />
                ) : <NoData />}
              </Card>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">CRL letters by year</div>
                  {byYearSql && <button onClick={() => openSqlModal({ title: "CRL letters by year", sql: byYearSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">volume of letters received, by the year on the letter itself</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.byYear ? (
                  <CardUnavailable message={cardErrors.byYear} onRetry={loadDashboard} />
                ) : yearBars.length ? (
                  <RankedBars data={yearBars} />
                ) : <NoData />}
              </Card>
            </div>
          </div>
        </div>
      )}

      {/* ============ DATA TABLE ============ */}
      {activeTab === "table" && (
        <div className="flex-1 min-h-0 flex">
          {/* Filter rail */}
          <div className="w-[252px] flex-shrink-0 bg-white border-r border-jj-gray-02 flex flex-col overflow-hidden">
            <div className="px-[18px] pt-4 pb-3 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2 text-[13px] font-johnson-text font-bold text-jj-gray-08">
                <Icon src={filterIcon} tint="ink" className="w-[13px] h-[13px]" />
                Refine
                {activeFilterCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium">
                    {activeFilterCount}
                  </span>
                )}
              </div>
              <button onClick={() => { setFilters({}); setSelectedYears([]); }} disabled={activeFilterCount === 0} className="text-[11px] font-johnson-text text-jj-blue-03 disabled:opacity-40">
                Clear all
              </button>
            </div>
            <div className="px-[18px] pb-3.5 space-y-2 border-b border-jj-gray-01 flex-shrink-0">
              {[
                { value: searchSponsor, set: setSearchSponsor, ph: "Sponsor contains…" },
                { value: searchProduct, set: setSearchProduct, ph: "Product contains…" },
                { value: searchSubmission, set: setSearchSubmission, ph: "Submission ID contains…" },
              ].map(({ value, set, ph }) => (
                <div key={ph} className="relative">
                  <Icon src={searchIcon} tint="gray" className="w-[13px] h-[13px] absolute left-2.5 top-[9px]" />
                  <input
                    value={value}
                    onChange={e => set(e.target.value)}
                    placeholder={ph}
                    className="w-full pl-8 pr-2 py-2 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
                  />
                </div>
              ))}
              <div className="text-[10px] font-johnson-text text-jj-gray-06">Applies after you stop typing.</div>
            </div>
            <div className="flex-1 overflow-y-auto">
              <FdaFacetGroup
                label="ID"
                column="id"
                selected={filters.id || []}
                onChange={vals => setFilters(prev => ({ ...prev, id: vals }))}
                options={facets.id || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Approval status"
                column="status"
                selected={filters.status || []}
                onChange={vals => setFilters(prev => ({ ...prev, status: vals }))}
                options={facets.status || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Application type"
                column="application_type"
                selected={filters.application_type || []}
                onChange={vals => setFilters(prev => ({ ...prev, application_type: vals }))}
                options={facets.application_type || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Letter year"
                column="year"
                selected={selectedYears}
                onChange={vals => setSelectedYears(vals)}
                options={facets.year || []}
                loading={facetsLoading}
              />
            </div>
          </div>

          {/* Main content */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-5 gap-0">
            {rowsError && <ErrorBanner message={rowsError} onRetry={() => setPage(p => p)} />}
            <div ref={lettersTableCardRef} className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-3 border-b border-jj-gray-01">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                  Matching records <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{total.toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-2.5">
                  {dataSql && (
                    <button onClick={() => openSqlModal({ title: "Data table (current page)", sql: dataSql })} className="text-[11px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
                  )}
                  <button
                    onClick={downloadPageCsv}
                    disabled={rowsLoading || rows.length === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Downloads the current page only"
                  >
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    Download page
                  </button>
                  <button
                    onClick={downloadAllCsv}
                    disabled={rowsLoading || downloadingAll || total === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Streams every matching row as CSV - no row cap"
                  >
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    {downloadingAll ? "Preparing…" : `Download all (${total.toLocaleString()})`}
                  </button>
                  <button
                    onClick={toggleLettersFullscreen}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
                    title={lettersFullscreen ? "Exit full screen" : "View the table full screen"}
                  >
                    {lettersFullscreen ? "⤳ Exit full screen" : "⛶ Full screen"}
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 relative">
                {rowsLoading && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10">
                    <LoadingSpinner />
                  </div>
                )}
                <div className="h-full overflow-auto">
                  <table className="text-[12px] font-johnson-text border-collapse" style={{ width: "max-content", minWidth: "100%" }}>
                    <thead className="sticky top-0 z-[5]">
                      <tr className="bg-jj-gray-01 text-jj-gray-07 text-[11px] uppercase tracking-wider">
                        {LETTERS_TABLE_COLUMNS.map(col => (
                          <th
                            key={col.key}
                            onClick={() => col.sortCol && toggleSort(col.sortCol)}
                            style={{ minWidth: col.minWidth }}
                            className={`text-left px-3 py-2.5 font-bold select-none whitespace-nowrap ${col.sortCol ? "cursor-pointer" : ""}`}
                          >
                            {col.label} {col.sortCol && sortCol === col.sortCol ? (sortDir === "asc" ? "▲" : "▼") : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr
                          key={row.id ?? i}
                          onClick={() => {
                            logInPage("row_detail_view", `Opened CRL letter detail for ${row.sponsor || row.file_name || "row " + i}`);
                            setDetailRow(row);
                          }}
                          className="border-t border-jj-gray-01 hover:bg-jj-gray-01/50 cursor-pointer"
                        >
                          {LETTERS_TABLE_COLUMNS.map(col => (
                            <td
                              key={col.key}
                              style={{ minWidth: col.minWidth, maxWidth: col.minWidth * 2 }}
                              className={`px-3 py-2 truncate ${col.bold ? "font-medium text-jj-gray-08" : "text-jj-gray-07"}`}
                              title={typeof cellFor(row, col.key) === "string" ? cellFor(row, col.key) : undefined}
                            >
                              {col.key === "status" && row.status ? <LettersStatusPill value={row.status} /> : cellFor(row, col.key)}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {!rowsLoading && rows.length === 0 && (
                        <tr>
                          <td colSpan={LETTERS_TABLE_COLUMNS.length} className="px-3 py-8 text-center text-jj-gray-06">
                            {rowsError ? "Couldn't load CRL letters." : "No letters match the current filters."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-2.5 border-t border-jj-gray-01">
                <div className="flex items-center gap-2 text-[11.5px] font-johnson-text text-jj-gray-06 tabular-nums">
                  <Icon src={infoIcon} tint="ink" className="w-3.5 h-3.5" />
                  {total.toLocaleString()} rows
                  <select
                    value={pageSize}
                    onChange={e => setPageSize(Number(e.target.value))}
                    disabled={rowsLoading}
                    className="ml-2 border border-jj-gray-03 rounded-lg px-2 py-1 font-johnson-text"
                  >
                    {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}/page</option>)}
                  </select>
                </div>
                <Pager page={page} totalPages={totalPages} loading={rowsLoading} onGo={setPage} />
              </div>
            </div>
          </div>
        </div>
      )}

      <DetailModal record={detailRow} onClose={() => setDetailRow(null)} />
      <SqlModal modal={sqlModal} onClose={() => setSqlModal(null)} />
    </div>
  );
}
/* ============================== Pink Sheet Letters dashboard ============================== */
// Backed by /api/fda/pink-letters/* (vector_embedding.crl_pink_letters) -
// the Pink Sheet CRL writeups that crl_ai_matches lines CRL letters up
// against. No id/primary key on this table, so there's no per-row detail
// fetch - clicking a row just opens the already-loaded row data, same as
// the other two dashboards' detail modal.
//
// All 5 real columns are business text already (nothing to hide), but
// Indication and Issues both follow a consistent "{category} - text" shape,
// so the backend pulls that leading category out as two derived filters:
// therapeutic_area and issue_category.

const PINK_OUTCOME_COLORS = { "MENTIONS APPROVAL": "#328714", "NO APPROVAL MENTIONED": "#6e6259" };

const PINK_TABLE_COLUMNS = [
  { key: "Sponsor & Product", label: "Sponsor & product", sortCol: "Sponsor & Product", bold: true, minWidth: 260 },
  { key: "Indication", label: "Indication", sortCol: "Indication", minWidth: 260 },
  { key: "Issues", label: "Issues", sortCol: "Issues", minWidth: 280 },
  { key: "Date Announced", label: "Date announced", sortCol: "Date Announced", minWidth: 170 },
  { key: "Activity", label: "Activity", minWidth: 380 },
];

const PINK_ALL_COLUMNS = ["Sponsor & Product", "Indication", "Issues", "Date Announced", "Activity"];

function PinkLettersExplorer({ logInPage, activeTab, onBusyChange }) {
  /* ---------- Dashboard ---------- */
  const [summary, setSummary] = useState(null);
  const [areaChart, setAreaChart] = useState([]);
  const [issueChart, setIssueChart] = useState([]);
  const [outcomeChart, setOutcomeChart] = useState([]);
  const [byYearChart, setByYearChart] = useState([]);
  const [chartsLoading, setChartsLoading] = useState(true);
  const [chartsError, setChartsError] = useState(null);
  const [cardErrors, setCardErrors] = useState({});
  const [areaSql, setAreaSql] = useState("");
  const [issueSql, setIssueSql] = useState("");
  const [outcomeSql, setOutcomeSql] = useState("");
  const [byYearSql, setByYearSql] = useState("");
  const [sqlModal, setSqlModal] = useState(null);
  const openSqlModal = (payload) => setSqlModal(payload);

  const loadDashboard = useCallback(() => {
    setChartsLoading(true);
    setChartsError(null);
    Promise.allSettled([
      fetchJson(`${API_BASE_URL}/api/fda/pink-letters/summary`),
      fetchJson(`${API_BASE_URL}/api/fda/pink-letters/charts/therapeutic-area?limit=12`),
      fetchJson(`${API_BASE_URL}/api/fda/pink-letters/charts/issue-category?limit=12`),
      fetchJson(`${API_BASE_URL}/api/fda/pink-letters/charts/approval-outcome`),
      fetchJson(`${API_BASE_URL}/api/fda/pink-letters/charts/by-year`),
    ]).then(([summaryRes, areaRes, issueRes, outcomeRes, yearRes]) => {
      const errors = {};
      if (summaryRes.status === "fulfilled") setSummary(summaryRes.value);
      else errors.summary = summaryRes.reason?.message || "Failed to load summary";

      if (areaRes.status === "fulfilled") { setAreaChart(areaRes.value.rows || []); setAreaSql(areaRes.value.sql || ""); }
      else errors.area = areaRes.reason?.message || "Failed to load chart";

      if (issueRes.status === "fulfilled") { setIssueChart(issueRes.value.rows || []); setIssueSql(issueRes.value.sql || ""); }
      else errors.issue = issueRes.reason?.message || "Failed to load chart";

      if (outcomeRes.status === "fulfilled") { setOutcomeChart(outcomeRes.value.rows || []); setOutcomeSql(outcomeRes.value.sql || ""); }
      else errors.outcome = outcomeRes.reason?.message || "Failed to load chart";

      if (yearRes.status === "fulfilled") { setByYearChart(yearRes.value.rows || []); setByYearSql(yearRes.value.sql || ""); }
      else errors.byYear = yearRes.reason?.message || "Failed to load chart";

      setCardErrors(errors);
      if (summaryRes.status === "rejected" && Object.keys(errors).length === 5) {
        setChartsError(errors.summary);
      }
      setChartsLoading(false);
    });
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const outcomeFallbackIdx = useRef({ i: 0 });
  const outcomeSegments = useMemo(() => {
    const sum = outcomeChart.reduce((a, r) => a + (r.count || 0), 0);
    if (!sum) return { segments: [], total: 0 };
    outcomeFallbackIdx.current.i = 0;
    const sorted = [...outcomeChart].sort((a, b) => b.count - a.count);
    return {
      total: sum,
      segments: sorted.map(r => ({
        status: r.outcome === "MENTIONS APPROVAL" ? "Mentions approval" : "No approval mentioned",
        color: PINK_OUTCOME_COLORS[String(r.outcome || "").toUpperCase()] || FALLBACK_COLORS[outcomeFallbackIdx.current.i++ % FALLBACK_COLORS.length],
        frac: r.count / sum,
        count: r.count,
      })),
    };
  }, [outcomeChart]);

  const areaBars = useMemo(() => areaChart.map(r => ({ area: r.area, count: r.count })), [areaChart]);
  const issueBars = useMemo(() => issueChart.map(r => ({ area: r.category, count: r.count })), [issueChart]);
  const yearBars = useMemo(() => byYearChart.map(r => ({ area: r.year, count: r.count })), [byYearChart]);

  /* ---------- Data table ---------- */
  const [filters, setFilters] = useState({});
  const [searchSponsorProduct, setSearchSponsorProduct] = useState("");
  const [searchIndication, setSearchIndication] = useState("");
  const [searchIssues, setSearchIssues] = useState("");
  const [searchActivity, setSearchActivity] = useState("");
  const debouncedSponsorProduct = useDebounced(searchSponsorProduct);
  const debouncedIndication = useDebounced(searchIndication);
  const debouncedIssues = useDebounced(searchIssues);
  const debouncedActivity = useDebounced(searchActivity);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortCol, setSortCol] = useState("Sponsor & Product");
  const [sortDir, setSortDir] = useState("asc");

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState(null);
  const [dataSql, setDataSql] = useState("");

  const [facets, setFacets] = useState({});
  const [facetsLoading, setFacetsLoading] = useState(true);

  const [detailRow, setDetailRow] = useState(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const filtersParam = useMemo(() => {
    const parts = Object.entries(filters)
      .filter(([, vals]) => vals && vals.length > 0)
      .map(([col, vals]) => `${col}:${vals.join("||")}`);
    return parts.join(",");
  }, [filters]);
  const activeFilterCount = Object.values(filters).reduce((n, vals) => n + (vals?.length || 0), 0);

  useEffect(() => { setPage(1); }, [filtersParam, debouncedSponsorProduct, debouncedIndication, debouncedIssues, debouncedActivity, pageSize]);

  useEffect(() => {
    const controller = new AbortController();
    setFacetsLoading(true);
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    const qs = params.toString() ? `?${params.toString()}` : "";
    fetchJson(`${API_BASE_URL}/api/fda/pink-letters/facets${qs}`, { signal: controller.signal })
      .then(data => { setFacets(data); setFacetsLoading(false); })
      .catch(() => setFacetsLoading(false));
    return () => controller.abort();
  }, [filtersParam]);

  const buildDataQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    if (debouncedSponsorProduct) params.set("search_sponsor_product", debouncedSponsorProduct);
    if (debouncedIndication) params.set("search_indication", debouncedIndication);
    if (debouncedIssues) params.set("search_issues", debouncedIssues);
    if (debouncedActivity) params.set("search_activity", debouncedActivity);
    params.set("sort_col", sortCol);
    params.set("sort_dir", sortDir);
    return params;
  }, [filtersParam, debouncedSponsorProduct, debouncedIndication, debouncedIssues, debouncedActivity, sortCol, sortDir]);

  useEffect(() => {
    const controller = new AbortController();
    setRowsLoading(true);
    setRowsError(null);
    const params = buildDataQuery();
    params.set("page", String(page));
    params.set("page_size", String(pageSize));
    fetchJson(`${API_BASE_URL}/api/fda/pink-letters/data?${params.toString()}`, { signal: controller.signal })
      .then(data => {
        setRows(data.rows || []);
        setTotal(data.total || 0);
        setTotalPages(data.total_pages || 1);
        setDataSql(data.sql || "");
        setRowsLoading(false);
      })
      .catch(e => {
        if (e.name === "AbortError") return;
        setRowsError(e.message || "Failed to load Pink Sheet letters");
        setRowsLoading(false);
      });
    return () => controller.abort();
  }, [buildDataQuery, page, pageSize]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  };

  const downloadPageCsv = () => {
    logInPage("export_page", `Downloaded current page (${rows.length} rows) of Pink Sheet letters`);
    downloadClientCsv("fda_crl_pink_letters_page.csv", PINK_ALL_COLUMNS, rows);
  };

  const downloadAllCsv = async () => {
    setDownloadingAll(true);
    logInPage("export_all", `Downloaded all ${total.toLocaleString()} matching Pink Sheet letters`);
    try {
      const params = buildDataQuery();
      await downloadFile(`/api/fda/pink-letters/data/download?${params.toString()}`, "fda_crl_pink_letters.csv");
    } catch (e) {
      setRowsError(e.message || "Download failed");
    } finally {
      setDownloadingAll(false);
    }
  };

  const busy = chartsLoading || rowsLoading;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const pinkTableCardRef = useRef(null);
  const [pinkFullscreen, setPinkFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setPinkFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  const togglePinkFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else pinkTableCardRef.current?.requestFullscreen?.();
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ============ DASHBOARD ============ */}
      {activeTab === "explore" && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-5 flex flex-col gap-3.5 min-h-full">
            {chartsError && <ErrorBanner message={`Couldn't load the Pink Sheet letters dashboard: ${chartsError}`} onRetry={loadDashboard} />}
            {!chartsError && !chartsLoading && Object.keys(cardErrors).length > 0 && (
              <div className="px-4 py-2.5 rounded-xl bg-jj-gray-01 border border-jj-gray-02 text-xs font-johnson-text text-jj-gray-07">
                Some cards couldn't load ({Object.keys(cardErrors).length} of 5).
              </div>
            )}

            {/* KPI band */}
            <div className="flex items-center justify-between flex-shrink-0">
              <span />
              {summary?.sql && (
                <button onClick={() => openSqlModal({ title: "KPI summary", sql: summary.sql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
              )}
            </div>
            <div className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Pink Sheet CRL writeups</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.total_letters) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">matched against FDA CRL letters</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Mentions approval</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary?.approved_mention_rate != null ? `${summary.approved_mention_rate}%` : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">{summary ? `${formatCompact(summary.approved_mention_count)} of ${formatCompact(summary.total_letters)} writeups` : "based on the Activity narrative"}</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Therapeutic areas</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_therapeutic_areas) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">distinct areas represented</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Issue categories</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_issue_categories) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">distinct issue types cited</div>
              </div>
            </div>

            {/* Approval outcome + top therapeutic areas */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Approval outcome</div>
                  {outcomeSql && <button onClick={() => openSqlModal({ title: "Approval outcome", sql: outcomeSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">whether the Activity narrative mentions an eventual approval</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.outcome ? (
                  <CardUnavailable message={cardErrors.outcome} onRetry={loadDashboard} />
                ) : outcomeSegments.segments.length ? (
                  <div className="flex items-center gap-5">
                    <StatusDonut segments={outcomeSegments.segments} headerLabel="Approval outcome" />
                    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                      {outcomeSegments.segments.map(s => (
                        <div key={s.status} className="flex items-center gap-2 text-[11.5px] font-johnson-text">
                          <span className="w-2 h-2 rounded-[2px] flex-shrink-0" style={{ background: s.color }} />
                          <span className="text-jj-gray-08 truncate flex-1">{s.status}</span>
                          <span className="text-jj-gray-06 tabular-nums">{Math.round(s.frac * 100)}%</span>
                          <span className="text-jj-gray-08 font-medium tabular-nums w-12 text-right">{formatCompact(s.count)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : <NoData />}
              </Card>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Top therapeutic areas</div>
                  {areaSql && <button onClick={() => openSqlModal({ title: "Top therapeutic areas", sql: areaSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">where CRL activity concentrates, by therapeutic area</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.area ? (
                  <CardUnavailable message={cardErrors.area} onRetry={loadDashboard} />
                ) : areaBars.length ? (
                  <RankedBars data={areaBars} />
                ) : <NoData />}
              </Card>
            </div>

            {/* Top issue categories + by year */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Top issue categories</div>
                  {issueSql && <button onClick={() => openSqlModal({ title: "Top issue categories", sql: issueSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">the most common reasons cited across CRLs</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.issue ? (
                  <CardUnavailable message={cardErrors.issue} onRetry={loadDashboard} />
                ) : issueBars.length ? (
                  <RankedBars data={issueBars} />
                ) : <NoData />}
              </Card>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Writeups by year</div>
                  {byYearSql && <button onClick={() => openSqlModal({ title: "Writeups by year", sql: byYearSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">volume of Pink Sheet CRL writeups, by year announced</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.byYear ? (
                  <CardUnavailable message={cardErrors.byYear} onRetry={loadDashboard} />
                ) : yearBars.length ? (
                  <RankedBars data={yearBars} />
                ) : <NoData />}
              </Card>
            </div>
          </div>
        </div>
      )}

      {/* ============ DATA TABLE ============ */}
      {activeTab === "table" && (
        <div className="flex-1 min-h-0 flex">
          {/* Filter rail */}
          <div className="w-[252px] flex-shrink-0 bg-white border-r border-jj-gray-02 flex flex-col overflow-hidden">
            <div className="px-[18px] pt-4 pb-3 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2 text-[13px] font-johnson-text font-bold text-jj-gray-08">
                <Icon src={filterIcon} tint="ink" className="w-[13px] h-[13px]" />
                Refine
                {activeFilterCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium">
                    {activeFilterCount}
                  </span>
                )}
              </div>
              <button onClick={() => setFilters({})} disabled={activeFilterCount === 0} className="text-[11px] font-johnson-text text-jj-blue-03 disabled:opacity-40">
                Clear all
              </button>
            </div>
            <div className="px-[18px] pb-3.5 space-y-2 border-b border-jj-gray-01 flex-shrink-0">
              {[
                { value: searchSponsorProduct, set: setSearchSponsorProduct, ph: "Sponsor/product contains…" },
                { value: searchIndication, set: setSearchIndication, ph: "Indication contains…" },
                { value: searchIssues, set: setSearchIssues, ph: "Issues contains…" },
                { value: searchActivity, set: setSearchActivity, ph: "Activity contains…" },
              ].map(({ value, set, ph }) => (
                <div key={ph} className="relative">
                  <Icon src={searchIcon} tint="gray" className="w-[13px] h-[13px] absolute left-2.5 top-[9px]" />
                  <input
                    value={value}
                    onChange={e => set(e.target.value)}
                    placeholder={ph}
                    className="w-full pl-8 pr-2 py-2 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
                  />
                </div>
              ))}
              <div className="text-[10px] font-johnson-text text-jj-gray-06">Applies after you stop typing.</div>
            </div>
            <div className="flex-1 overflow-y-auto">
              <FdaFacetGroup
                label="Therapeutic area"
                column="therapeutic_area"
                selected={filters.therapeutic_area || []}
                onChange={vals => setFilters(prev => ({ ...prev, therapeutic_area: vals }))}
                options={facets.therapeutic_area || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Issue category"
                column="issue_category"
                selected={filters.issue_category || []}
                onChange={vals => setFilters(prev => ({ ...prev, issue_category: vals }))}
                options={facets.issue_category || []}
                loading={facetsLoading}
              />
            </div>
          </div>

          {/* Main content */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-5 gap-0">
            {rowsError && <ErrorBanner message={rowsError} onRetry={() => setPage(p => p)} />}
            <div ref={pinkTableCardRef} className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-3 border-b border-jj-gray-01">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                  Matching records <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{total.toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-2.5">
                  {dataSql && (
                    <button onClick={() => openSqlModal({ title: "Data table (current page)", sql: dataSql })} className="text-[11px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
                  )}
                  <button
                    onClick={downloadPageCsv}
                    disabled={rowsLoading || rows.length === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Downloads the current page only"
                  >
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    Download page
                  </button>
                  <button
                    onClick={downloadAllCsv}
                    disabled={rowsLoading || downloadingAll || total === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Streams every matching row as CSV - no row cap"
                  >
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    {downloadingAll ? "Preparing…" : `Download all (${total.toLocaleString()})`}
                  </button>
                  <button
                    onClick={togglePinkFullscreen}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
                    title={pinkFullscreen ? "Exit full screen" : "View the table full screen"}
                  >
                    {pinkFullscreen ? "⤳ Exit full screen" : "⛶ Full screen"}
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 relative">
                {rowsLoading && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10">
                    <LoadingSpinner />
                  </div>
                )}
                <div className="h-full overflow-auto">
                  <table className="text-[12px] font-johnson-text border-collapse" style={{ width: "max-content", minWidth: "100%" }}>
                    <thead className="sticky top-0 z-[5]">
                      <tr className="bg-jj-gray-01 text-jj-gray-07 text-[11px] uppercase tracking-wider">
                        {PINK_TABLE_COLUMNS.map(col => (
                          <th
                            key={col.key}
                            onClick={() => col.sortCol && toggleSort(col.sortCol)}
                            style={{ minWidth: col.minWidth }}
                            className={`text-left px-3 py-2.5 font-bold select-none whitespace-nowrap ${col.sortCol ? "cursor-pointer" : ""}`}
                          >
                            {col.label} {col.sortCol && sortCol === col.sortCol ? (sortDir === "asc" ? "▲" : "▼") : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr
                          key={i}
                          onClick={() => {
                            logInPage("row_detail_view", `Opened Pink Sheet letter detail for ${row["Sponsor & Product"] || "row " + i}`);
                            setDetailRow(row);
                          }}
                          className="border-t border-jj-gray-01 hover:bg-jj-gray-01/50 cursor-pointer"
                        >
                          {PINK_TABLE_COLUMNS.map(col => (
                            <td
                              key={col.key}
                              style={{ minWidth: col.minWidth, maxWidth: col.minWidth * 2 }}
                              className={`px-3 py-2 truncate ${col.bold ? "font-medium text-jj-gray-08" : "text-jj-gray-07"}`}
                              title={typeof row[col.key] === "string" ? row[col.key] : undefined}
                            >
                              {row[col.key] ?? "—"}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {!rowsLoading && rows.length === 0 && (
                        <tr>
                          <td colSpan={PINK_TABLE_COLUMNS.length} className="px-3 py-8 text-center text-jj-gray-06">
                            {rowsError ? "Couldn't load Pink Sheet letters." : "No letters match the current filters."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-2.5 border-t border-jj-gray-01">
                <div className="flex items-center gap-2 text-[11.5px] font-johnson-text text-jj-gray-06 tabular-nums">
                  <Icon src={infoIcon} tint="ink" className="w-3.5 h-3.5" />
                  {total.toLocaleString()} rows
                  <select
                    value={pageSize}
                    onChange={e => setPageSize(Number(e.target.value))}
                    disabled={rowsLoading}
                    className="ml-2 border border-jj-gray-03 rounded-lg px-2 py-1 font-johnson-text"
                  >
                    {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}/page</option>)}
                  </select>
                </div>
                <Pager page={page} totalPages={totalPages} loading={rowsLoading} onGo={setPage} />
              </div>
            </div>
          </div>
        </div>
      )}

      <DetailModal record={detailRow} onClose={() => setDetailRow(null)} />
      <SqlModal modal={sqlModal} onClose={() => setSqlModal(null)} />
    </div>
  );
}

/* ============================== eCTD Documents dashboard ============================== */
// Backed by /api/fda/ectd/* (vector_embedding.ectd_docs) - ~1M rows, one row
// per document in the eCTD submission structure. No id/primary key on this
// table (r_object_id is a Documentum internal id, not a stable numeric key),
// so there's no per-row detail fetch - clicking a row just opens the
// already-loaded row data, same as the Pink Sheet Letters dashboard.
//
// Every column is shown, in table order - checkbox facets (with a "Narrow
// list…" search) for the lower-cardinality columns, free-text search boxes
// for identifiers/titles/file paths where a facet wouldn't be useful.

const ECTD_STATUS_COLORS = { APPROVED: "#328714", DRAFT: "#eb1700", "(UNSPECIFIED)": "#6e6259" };

const ECTD_TABLE_COLUMNS = [
  { key: "jj_prod_disp_name", label: "Product", sortCol: "jj_prod_disp_name", bold: true, minWidth: 170 },
  { key: "product_trade_name", label: "Trade name", sortCol: "product_trade_name", minWidth: 150 },
  { key: "product_generic_name", label: "Generic name", sortCol: "product_generic_name", minWidth: 150 },
  { key: "inn_names", label: "INN name", sortCol: "inn_names", minWidth: 140 },
  { key: "product_code", label: "Product code", sortCol: "product_code", minWidth: 160 },
  { key: "jj_title", label: "Document title", sortCol: "jj_title", minWidth: 260 },
  { key: "jj_number", label: "Document number", sortCol: "jj_number", minWidth: 170 },
  { key: "a_status", label: "Status", sortCol: "a_status", minWidth: 110 },
  { key: "r_version_label", label: "Version", sortCol: "r_version_label", minWidth: 150 },
  { key: "i_latest_flag", label: "Latest?", sortCol: "i_latest_flag", minWidth: 80 },
  { key: "r_link_cnt", label: "Link count", sortCol: "r_link_cnt", minWidth: 90 },
  { key: "primary_group", label: "Group", sortCol: "primary_group", minWidth: 130 },
  { key: "subgroup", label: "Subgroup", sortCol: "subgroup", minWidth: 110 },
  { key: "artifact_name", label: "Artifact", sortCol: "artifact_name", minWidth: 220 },
  { key: "jj_artifact_short_name", label: "Artifact (short)", sortCol: "jj_artifact_short_name", minWidth: 150 },
  { key: "ectd_section", label: "eCTD section", sortCol: "ectd_section", minWidth: 110 },
  { key: "jj_ectd_leafname", label: "eCTD leaf name", sortCol: "jj_ectd_leafname", minWidth: 160 },
  { key: "jj_ectd_leaftitle", label: "eCTD leaf title", sortCol: "jj_ectd_leaftitle", minWidth: 160 },
  { key: "r_object_id", label: "Object ID", sortCol: "r_object_id", minWidth: 140 },
  { key: "object_name", label: "Object name", sortCol: "object_name", minWidth: 260 },
  { key: "Link", label: "Link", sortCol: "Link", minWidth: 280 },
  { key: "Path", label: "Path", sortCol: "Path", minWidth: 280 },
  { key: "nas_path", label: "NAS path", sortCol: "nas_path", minWidth: 320 },
];

const ECTD_ALL_COLUMNS = [
  "Link", "r_object_id", "object_name", "a_status", "jj_title", "r_version_label", "jj_number",
  "i_latest_flag", "r_link_cnt", "product_code", "jj_prod_disp_name", "inn_names",
  "product_generic_name", "product_trade_name", "primary_group", "subgroup", "artifact_name",
  "jj_artifact_short_name", "ectd_section", "jj_ectd_leafname", "jj_ectd_leaftitle", "Path", "nas_path",
];

function EctdStatusPill({ value }) {
  const key = String(value || "").toUpperCase();
  const color = ECTD_STATUS_COLORS[key] || "#6e6259";
  return (
    <span
      className="inline-flex items-center gap-[5px] text-[11px] font-johnson-text font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap capitalize"
      style={{ background: `${color}17`, color }}
    >
      <span className="w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: color }} />
      {value || "Unknown"}
    </span>
  );
}

function EctdDocsExplorer({ logInPage, activeTab, onBusyChange }) {
  /* ---------- Dashboard ---------- */
  const [summary, setSummary] = useState(null);
  const [statusChart, setStatusChart] = useState([]);
  const [groupChart, setGroupChart] = useState([]);
  const [topProductsChart, setTopProductsChart] = useState([]);
  const [topSectionsChart, setTopSectionsChart] = useState([]);
  const [chartsLoading, setChartsLoading] = useState(true);
  const [chartsError, setChartsError] = useState(null);
  const [cardErrors, setCardErrors] = useState({});
  const [statusSql, setStatusSql] = useState("");
  const [groupSql, setGroupSql] = useState("");
  const [productsSql, setProductsSql] = useState("");
  const [sectionsSql, setSectionsSql] = useState("");
  const [sqlModal, setSqlModal] = useState(null);
  const openSqlModal = (payload) => setSqlModal(payload);

  const loadDashboard = useCallback(() => {
    setChartsLoading(true);
    setChartsError(null);
    Promise.allSettled([
      fetchJson(`${API_BASE_URL}/api/fda/ectd/summary`),
      fetchJson(`${API_BASE_URL}/api/fda/ectd/charts/status`),
      fetchJson(`${API_BASE_URL}/api/fda/ectd/charts/primary-group`),
      fetchJson(`${API_BASE_URL}/api/fda/ectd/charts/top-products?limit=12`),
      fetchJson(`${API_BASE_URL}/api/fda/ectd/charts/top-sections?limit=12`),
    ]).then(([summaryRes, statusRes, groupRes, productsRes, sectionsRes]) => {
      const errors = {};
      if (summaryRes.status === "fulfilled") setSummary(summaryRes.value);
      else errors.summary = summaryRes.reason?.message || "Failed to load summary";

      if (statusRes.status === "fulfilled") { setStatusChart(statusRes.value.rows || []); setStatusSql(statusRes.value.sql || ""); }
      else errors.status = statusRes.reason?.message || "Failed to load chart";

      if (groupRes.status === "fulfilled") { setGroupChart(groupRes.value.rows || []); setGroupSql(groupRes.value.sql || ""); }
      else errors.group = groupRes.reason?.message || "Failed to load chart";

      if (productsRes.status === "fulfilled") { setTopProductsChart(productsRes.value.rows || []); setProductsSql(productsRes.value.sql || ""); }
      else errors.products = productsRes.reason?.message || "Failed to load chart";

      if (sectionsRes.status === "fulfilled") { setTopSectionsChart(sectionsRes.value.rows || []); setSectionsSql(sectionsRes.value.sql || ""); }
      else errors.sections = sectionsRes.reason?.message || "Failed to load chart";

      setCardErrors(errors);
      if (summaryRes.status === "rejected" && Object.keys(errors).length === 5) {
        setChartsError(errors.summary);
      }
      setChartsLoading(false);
    });
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const statusFallbackIdx = useRef({ i: 0 });
  const statusSegments = useMemo(() => {
    const sum = statusChart.reduce((a, r) => a + (r.count || 0), 0);
    if (!sum) return { segments: [], total: 0 };
    statusFallbackIdx.current.i = 0;
    const sorted = [...statusChart].sort((a, b) => b.count - a.count);
    return {
      total: sum,
      segments: sorted.map(r => ({
        status: r.status === "(unspecified)" ? "Unspecified" : r.status.charAt(0) + r.status.slice(1).toLowerCase(),
        color: ECTD_STATUS_COLORS[String(r.status || "").toUpperCase()] || FALLBACK_COLORS[statusFallbackIdx.current.i++ % FALLBACK_COLORS.length],
        frac: r.count / sum,
        count: r.count,
      })),
    };
  }, [statusChart]);

  const groupBars = useMemo(() => groupChart.map(r => ({
    area: r.group_label === "(unspecified)" ? "Unspecified" : r.group_label.charAt(0) + r.group_label.slice(1).toLowerCase(),
    count: r.count,
  })), [groupChart]);
  const productBars = useMemo(() => topProductsChart.map(r => ({ area: r.jj_prod_disp_name, count: r.count })), [topProductsChart]);
  const sectionBars = useMemo(() => topSectionsChart.map(r => ({ area: r.ectd_section, count: r.count })), [topSectionsChart]);

  /* ---------- Data table ---------- */
  const [filters, setFilters] = useState({});
  const [searchTitle, setSearchTitle] = useState("");
  const [searchNumber, setSearchNumber] = useState("");
  const [searchVersionLabel, setSearchVersionLabel] = useState("");
  const [searchObjectId, setSearchObjectId] = useState("");
  const [searchObjectName, setSearchObjectName] = useState("");
  const [searchLink, setSearchLink] = useState("");
  const [searchPath, setSearchPath] = useState("");
  const [searchNasPath, setSearchNasPath] = useState("");
  const debouncedTitle = useDebounced(searchTitle);
  const debouncedNumber = useDebounced(searchNumber);
  const debouncedVersionLabel = useDebounced(searchVersionLabel);
  const debouncedObjectId = useDebounced(searchObjectId);
  const debouncedObjectName = useDebounced(searchObjectName);
  const debouncedLink = useDebounced(searchLink);
  const debouncedPath = useDebounced(searchPath);
  const debouncedNasPath = useDebounced(searchNasPath);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortCol, setSortCol] = useState("jj_number");
  const [sortDir, setSortDir] = useState("asc");

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState(null);
  const [dataSql, setDataSql] = useState("");

  const [facets, setFacets] = useState({});
  const [facetsLoading, setFacetsLoading] = useState(true);

  const [detailRow, setDetailRow] = useState(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const filtersParam = useMemo(() => {
    const parts = Object.entries(filters)
      .filter(([, vals]) => vals && vals.length > 0)
      .map(([col, vals]) => `${col}:${vals.join("||")}`);
    return parts.join(",");
  }, [filters]);
  const activeFilterCount = Object.values(filters).reduce((n, vals) => n + (vals?.length || 0), 0);

  useEffect(() => {
    setPage(1);
  }, [filtersParam, debouncedTitle, debouncedNumber, debouncedVersionLabel, debouncedObjectId, debouncedObjectName, debouncedLink, debouncedPath, debouncedNasPath, pageSize]);

  useEffect(() => {
    const controller = new AbortController();
    setFacetsLoading(true);
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    const qs = params.toString() ? `?${params.toString()}` : "";
    fetchJson(`${API_BASE_URL}/api/fda/ectd/facets${qs}`, { signal: controller.signal })
      .then(data => { setFacets(data); setFacetsLoading(false); })
      .catch(() => setFacetsLoading(false));
    return () => controller.abort();
  }, [filtersParam]);

  const buildDataQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    if (debouncedTitle) params.set("search_jj_title", debouncedTitle);
    if (debouncedNumber) params.set("search_jj_number", debouncedNumber);
    if (debouncedVersionLabel) params.set("search_r_version_label", debouncedVersionLabel);
    if (debouncedObjectId) params.set("search_r_object_id", debouncedObjectId);
    if (debouncedObjectName) params.set("search_object_name", debouncedObjectName);
    if (debouncedLink) params.set("search_link", debouncedLink);
    if (debouncedPath) params.set("search_path", debouncedPath);
    if (debouncedNasPath) params.set("search_nas_path", debouncedNasPath);
    params.set("sort_col", sortCol);
    params.set("sort_dir", sortDir);
    return params;
  }, [filtersParam, debouncedTitle, debouncedNumber, debouncedVersionLabel, debouncedObjectId, debouncedObjectName, debouncedLink, debouncedPath, debouncedNasPath, sortCol, sortDir]);

  useEffect(() => {
    const controller = new AbortController();
    setRowsLoading(true);
    setRowsError(null);
    const params = buildDataQuery();
    params.set("page", String(page));
    params.set("page_size", String(pageSize));
    fetchJson(`${API_BASE_URL}/api/fda/ectd/data?${params.toString()}`, { signal: controller.signal })
      .then(data => {
        setRows(data.rows || []);
        setTotal(data.total || 0);
        setTotalPages(data.total_pages || 1);
        setDataSql(data.sql || "");
        setRowsLoading(false);
      })
      .catch(e => {
        if (e.name === "AbortError") return;
        setRowsError(e.message || "Failed to load eCTD documents");
        setRowsLoading(false);
      });
    return () => controller.abort();
  }, [buildDataQuery, page, pageSize]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  };

  const downloadPageCsv = () => {
    logInPage("export_page", `Downloaded current page (${rows.length} rows) of eCTD documents`);
    downloadClientCsv("fda_ectd_docs_page.csv", ECTD_ALL_COLUMNS, rows);
  };

  const downloadAllCsv = async () => {
    setDownloadingAll(true);
    logInPage("export_all", `Downloaded all ${total.toLocaleString()} matching eCTD documents`);
    try {
      const params = buildDataQuery();
      await downloadFile(`/api/fda/ectd/data/download?${params.toString()}`, "fda_ectd_docs.csv");
    } catch (e) {
      setRowsError(e.message || "Download failed");
    } finally {
      setDownloadingAll(false);
    }
  };

  const busy = chartsLoading || rowsLoading;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const ectdTableCardRef = useRef(null);
  const [ectdFullscreen, setEctdFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setEctdFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  const toggleEctdFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else ectdTableCardRef.current?.requestFullscreen?.();
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ============ DASHBOARD ============ */}
      {activeTab === "explore" && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-5 flex flex-col gap-3.5 min-h-full">
            {chartsError && <ErrorBanner message={`Couldn't load the eCTD documents dashboard: ${chartsError}`} onRetry={loadDashboard} />}
            {!chartsError && !chartsLoading && Object.keys(cardErrors).length > 0 && (
              <div className="px-4 py-2.5 rounded-xl bg-jj-gray-01 border border-jj-gray-02 text-xs font-johnson-text text-jj-gray-07">
                Some cards couldn't load ({Object.keys(cardErrors).length} of 5).
              </div>
            )}

            {/* KPI band */}
            <div className="flex items-center justify-between flex-shrink-0">
              <span />
              {summary?.sql && (
                <button onClick={() => openSqlModal({ title: "KPI summary", sql: summary.sql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
              )}
            </div>
            <div className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">eCTD documents</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.total_docs) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">indexed across the submission structure</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Approved</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary?.approval_rate != null ? `${summary.approval_rate}%` : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">{summary ? `${formatCompact(summary.approved_count)} of ${formatCompact(summary.total_docs)} documents` : "final approved status"}</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Products</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_products) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">distinct products represented</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">eCTD sections</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_sections) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">distinct sections filed against</div>
              </div>
            </div>

            {/* Status + primary group */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Document status</div>
                  {statusSql && <button onClick={() => openSqlModal({ title: "Document status", sql: statusSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">documents still in draft vs. formally approved</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.status ? (
                  <CardUnavailable message={cardErrors.status} onRetry={loadDashboard} />
                ) : statusSegments.segments.length ? (
                  <div className="flex items-center gap-5">
                    <StatusDonut segments={statusSegments.segments} headerLabel="Document status" />
                    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                      {statusSegments.segments.map(s => (
                        <div key={s.status} className="flex items-center gap-2 text-[11.5px] font-johnson-text">
                          <span className="w-2 h-2 rounded-[2px] flex-shrink-0" style={{ background: s.color }} />
                          <span className="text-jj-gray-08 truncate flex-1">{s.status}</span>
                          <span className="text-jj-gray-06 tabular-nums">{Math.round(s.frac * 100)}%</span>
                          <span className="text-jj-gray-08 font-medium tabular-nums w-12 text-right">{formatCompact(s.count)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : <NoData />}
              </Card>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Drug substance vs. drug product</div>
                  {groupSql && <button onClick={() => openSqlModal({ title: "Drug substance vs. drug product", sql: groupSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">where documentation volume concentrates</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.group ? (
                  <CardUnavailable message={cardErrors.group} onRetry={loadDashboard} />
                ) : groupBars.length ? (
                  <RankedBars data={groupBars} />
                ) : <NoData />}
              </Card>
            </div>

            {/* Top products + top sections */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Products with the most documents</div>
                  {productsSql && <button onClick={() => openSqlModal({ title: "Products with the most documents", sql: productsSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">largest eCTD document counts by product</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.products ? (
                  <CardUnavailable message={cardErrors.products} onRetry={loadDashboard} />
                ) : productBars.length ? (
                  <RankedBars data={productBars} />
                ) : <NoData />}
              </Card>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Most-used eCTD sections</div>
                  {sectionsSql && <button onClick={() => openSqlModal({ title: "Most-used eCTD sections", sql: sectionsSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">submission sections with the most documents filed</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.sections ? (
                  <CardUnavailable message={cardErrors.sections} onRetry={loadDashboard} />
                ) : sectionBars.length ? (
                  <RankedBars data={sectionBars} />
                ) : <NoData />}
              </Card>
            </div>
          </div>
        </div>
      )}

      {/* ============ DATA TABLE ============ */}
      {activeTab === "table" && (
        <div className="flex-1 min-h-0 flex">
          {/* Filter rail */}
          <div className="w-[252px] flex-shrink-0 bg-white border-r border-jj-gray-02 flex flex-col overflow-hidden">
            <div className="px-[18px] pt-4 pb-3 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2 text-[13px] font-johnson-text font-bold text-jj-gray-08">
                <Icon src={filterIcon} tint="ink" className="w-[13px] h-[13px]" />
                Refine
                {activeFilterCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium">
                    {activeFilterCount}
                  </span>
                )}
              </div>
              <button onClick={() => setFilters({})} disabled={activeFilterCount === 0} className="text-[11px] font-johnson-text text-jj-blue-03 disabled:opacity-40">
                Clear all
              </button>
            </div>
            <div className="px-[18px] pb-3.5 space-y-2 border-b border-jj-gray-01 flex-shrink-0">
              {[
                { value: searchTitle, set: setSearchTitle, ph: "Document title contains…" },
                { value: searchNumber, set: setSearchNumber, ph: "Document number contains…" },
                { value: searchVersionLabel, set: setSearchVersionLabel, ph: "Version label contains…" },
                { value: searchObjectId, set: setSearchObjectId, ph: "Object ID contains…" },
                { value: searchObjectName, set: setSearchObjectName, ph: "Object name contains…" },
                { value: searchLink, set: setSearchLink, ph: "Link contains…" },
                { value: searchPath, set: setSearchPath, ph: "Path contains…" },
                { value: searchNasPath, set: setSearchNasPath, ph: "NAS path contains…" },
              ].map(({ value, set, ph }) => (
                <div key={ph} className="relative">
                  <Icon src={searchIcon} tint="gray" className="w-[13px] h-[13px] absolute left-2.5 top-[9px]" />
                  <input
                    value={value}
                    onChange={e => set(e.target.value)}
                    placeholder={ph}
                    className="w-full pl-8 pr-2 py-2 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
                  />
                </div>
              ))}
              <div className="text-[10px] font-johnson-text text-jj-gray-06">Applies after you stop typing.</div>
            </div>
            <div className="flex-1 overflow-y-auto">
              <FdaFacetGroup
                label="Status"
                column="a_status"
                selected={filters.a_status || []}
                onChange={vals => setFilters(prev => ({ ...prev, a_status: vals }))}
                options={facets.a_status || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Group"
                column="primary_group"
                selected={filters.primary_group || []}
                onChange={vals => setFilters(prev => ({ ...prev, primary_group: vals }))}
                options={facets.primary_group || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Subgroup"
                column="subgroup"
                selected={filters.subgroup || []}
                onChange={vals => setFilters(prev => ({ ...prev, subgroup: vals }))}
                options={facets.subgroup || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Latest?"
                column="i_latest_flag"
                selected={filters.i_latest_flag || []}
                onChange={vals => setFilters(prev => ({ ...prev, i_latest_flag: vals }))}
                options={facets.i_latest_flag || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Link count"
                column="r_link_cnt"
                selected={filters.r_link_cnt || []}
                onChange={vals => setFilters(prev => ({ ...prev, r_link_cnt: vals }))}
                options={facets.r_link_cnt || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Product code"
                column="product_code"
                selected={filters.product_code || []}
                onChange={vals => setFilters(prev => ({ ...prev, product_code: vals }))}
                options={facets.product_code || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Product"
                column="jj_prod_disp_name"
                selected={filters.jj_prod_disp_name || []}
                onChange={vals => setFilters(prev => ({ ...prev, jj_prod_disp_name: vals }))}
                options={facets.jj_prod_disp_name || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="INN name"
                column="inn_names"
                selected={filters.inn_names || []}
                onChange={vals => setFilters(prev => ({ ...prev, inn_names: vals }))}
                options={facets.inn_names || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Generic name"
                column="product_generic_name"
                selected={filters.product_generic_name || []}
                onChange={vals => setFilters(prev => ({ ...prev, product_generic_name: vals }))}
                options={facets.product_generic_name || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Trade name"
                column="product_trade_name"
                selected={filters.product_trade_name || []}
                onChange={vals => setFilters(prev => ({ ...prev, product_trade_name: vals }))}
                options={facets.product_trade_name || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Artifact"
                column="artifact_name"
                selected={filters.artifact_name || []}
                onChange={vals => setFilters(prev => ({ ...prev, artifact_name: vals }))}
                options={facets.artifact_name || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Artifact (short)"
                column="jj_artifact_short_name"
                selected={filters.jj_artifact_short_name || []}
                onChange={vals => setFilters(prev => ({ ...prev, jj_artifact_short_name: vals }))}
                options={facets.jj_artifact_short_name || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="eCTD section"
                column="ectd_section"
                selected={filters.ectd_section || []}
                onChange={vals => setFilters(prev => ({ ...prev, ectd_section: vals }))}
                options={facets.ectd_section || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="eCTD leaf name"
                column="jj_ectd_leafname"
                selected={filters.jj_ectd_leafname || []}
                onChange={vals => setFilters(prev => ({ ...prev, jj_ectd_leafname: vals }))}
                options={facets.jj_ectd_leafname || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="eCTD leaf title"
                column="jj_ectd_leaftitle"
                selected={filters.jj_ectd_leaftitle || []}
                onChange={vals => setFilters(prev => ({ ...prev, jj_ectd_leaftitle: vals }))}
                options={facets.jj_ectd_leaftitle || []}
                loading={facetsLoading}
              />
            </div>
          </div>

          {/* Main content */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-5 gap-0">
            {rowsError && <ErrorBanner message={rowsError} onRetry={() => setPage(p => p)} />}
            <div ref={ectdTableCardRef} className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-3 border-b border-jj-gray-01">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                  Matching records <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{total.toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-2.5">
                  {dataSql && (
                    <button onClick={() => openSqlModal({ title: "Data table (current page)", sql: dataSql })} className="text-[11px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
                  )}
                  <button
                    onClick={downloadPageCsv}
                    disabled={rowsLoading || rows.length === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Downloads the current page only"
                  >
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    Download page
                  </button>
                  <button
                    onClick={downloadAllCsv}
                    disabled={rowsLoading || downloadingAll || total === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Streams every matching row as CSV - no row cap"
                  >
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    {downloadingAll ? "Preparing…" : `Download all (${total.toLocaleString()})`}
                  </button>
                  <button
                    onClick={toggleEctdFullscreen}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
                    title={ectdFullscreen ? "Exit full screen" : "View the table full screen"}
                  >
                    {ectdFullscreen ? "⤳ Exit full screen" : "⛶ Full screen"}
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 relative">
                {rowsLoading && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10">
                    <LoadingSpinner />
                  </div>
                )}
                <div className="h-full overflow-auto">
                  <table className="text-[12px] font-johnson-text border-collapse" style={{ width: "max-content", minWidth: "100%" }}>
                    <thead className="sticky top-0 z-[5]">
                      <tr className="bg-jj-gray-01 text-jj-gray-07 text-[11px] uppercase tracking-wider">
                        {ECTD_TABLE_COLUMNS.map(col => (
                          <th
                            key={col.key}
                            onClick={() => col.sortCol && toggleSort(col.sortCol)}
                            style={{ minWidth: col.minWidth }}
                            className={`text-left px-3 py-2.5 font-bold select-none whitespace-nowrap ${col.sortCol ? "cursor-pointer" : ""}`}
                          >
                            {col.label} {col.sortCol && sortCol === col.sortCol ? (sortDir === "asc" ? "▲" : "▼") : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr
                          key={i}
                          onClick={() => {
                            logInPage("row_detail_view", `Opened eCTD document detail for ${row.jj_number || row.jj_title || "row " + i}`);
                            setDetailRow(row);
                          }}
                          className="border-t border-jj-gray-01 hover:bg-jj-gray-01/50 cursor-pointer"
                        >
                          {ECTD_TABLE_COLUMNS.map(col => (
                            <td
                              key={col.key}
                              style={{ minWidth: col.minWidth, maxWidth: col.minWidth * 2 }}
                              className={`px-3 py-2 truncate ${col.bold ? "font-medium text-jj-gray-08" : "text-jj-gray-07"}`}
                              title={typeof row[col.key] === "string" ? row[col.key] : undefined}
                            >
                              {col.key === "a_status" && row.a_status ? <EctdStatusPill value={row.a_status} /> : (row[col.key] ?? "—")}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {!rowsLoading && rows.length === 0 && (
                        <tr>
                          <td colSpan={ECTD_TABLE_COLUMNS.length} className="px-3 py-8 text-center text-jj-gray-06">
                            {rowsError ? "Couldn't load eCTD documents." : "No documents match the current filters."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-2.5 border-t border-jj-gray-01">
                <div className="flex items-center gap-2 text-[11.5px] font-johnson-text text-jj-gray-06 tabular-nums">
                  <Icon src={infoIcon} tint="ink" className="w-3.5 h-3.5" />
                  {total.toLocaleString()} rows
                  <select
                    value={pageSize}
                    onChange={e => setPageSize(Number(e.target.value))}
                    disabled={rowsLoading}
                    className="ml-2 border border-jj-gray-03 rounded-lg px-2 py-1 font-johnson-text"
                  >
                    {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}/page</option>)}
                  </select>
                </div>
                <Pager page={page} totalPages={totalPages} loading={rowsLoading} onGo={setPage} />
              </div>
            </div>
          </div>
        </div>
      )}

      <DetailModal record={detailRow} onClose={() => setDetailRow(null)} />
      <SqlModal modal={sqlModal} onClose={() => setSqlModal(null)} />
    </div>
  );
}

/* ============================== FDA CRL Letters dashboard ============================== */
// Backed by /api/fda/fda-letters/* (vector_embedding.fda_crl_letters) - a
// richer re-ingest of crl_letters: adds application_number,normalized
// sponsor_norm/product_norm, indication and evidence_quote, and (unlike
// crl_letters' free-text letter_date) a real crl_date_iso DATE column, so
// the by-year chart and the derived "Year" facet use EXTRACT() directly
// instead of the SPLIT_PART parsing crl_letters needs.
//
// Every column is shown - checkbox facets (with "Narrow list…" search) for
// the lower-cardinality columns, free-text search boxes for identifiers/
// long-form fields. join_key (an internal join hash), meta_json (duplicate
// JSON) and method_version (every row is 'crl_v2') get no filter - nothing
// meaningful to search or facet on a random hash/JSON blob/constant.

const FDA_LETTERS_V2_STATUS_COLORS = { APPROVED: "#328714", UNAPPROVED: "#eb1700", "(UNSPECIFIED)": "#6e6259" };

const FDA_LETTERS_V2_TABLE_COLUMNS = [
  { key: "id", label: "ID", sortCol: "id", minWidth: 70 },
  { key: "sponsor", label: "Sponsor", sortCol: "sponsor", bold: true, minWidth: 200 },
  { key: "sponsor_norm", label: "Sponsor (normalized)", sortCol: "sponsor_norm", minWidth: 180 },
  { key: "product_name", label: "Product", sortCol: "product_name", minWidth: 200 },
  { key: "product_norm", label: "Product (normalized)", sortCol: "product_norm", minWidth: 180 },
  { key: "application_type", label: "Application type", sortCol: "application_type", minWidth: 130 },
  { key: "application_number", label: "Application number", sortCol: "application_number", minWidth: 170 },
  { key: "submission_id", label: "Submission ID", sortCol: "submission_id", minWidth: 150 },
  { key: "status", label: "Status", sortCol: "status", minWidth: 110 },
  { key: "letter_date", label: "Letter date (raw)", sortCol: "letter_date", minWidth: 140 },
  { key: "crl_date_iso", label: "CRL date", sortCol: "crl_date_iso", minWidth: 120 },
  { key: "indication", label: "Indication", sortCol: "indication", minWidth: 220 },
  { key: "notes", label: "Notes", minWidth: 320 },
  { key: "evidence_quote", label: "Evidence quote", minWidth: 320 },
  { key: "letter_text", label: "Letter text", minWidth: 320 },
  { key: "file_name", label: "File name", sortCol: "file_name", minWidth: 220 },
  { key: "local_path", label: "Local path", sortCol: "local_path", minWidth: 280 },
  { key: "join_key", label: "Join key", sortCol: "join_key", minWidth: 220 },
  { key: "meta_json", label: "Meta JSON", minWidth: 260 },
  { key: "method_version", label: "Method version", sortCol: "method_version", minWidth: 120 },
  { key: "processed_at", label: "Processed at", sortCol: "processed_at", minWidth: 170 },
];

const FDA_LETTERS_V2_ALL_COLUMNS = [
  "id", "file_name", "local_path", "status", "letter_text", "submission_id", "application_type",
  "product_name", "letter_date", "sponsor", "notes", "application_number", "crl_date_iso",
  "sponsor_norm", "product_norm", "indication", "evidence_quote", "join_key", "meta_json",
  "method_version", "processed_at",
];

function FdaLettersV2StatusPill({ value }) {
  const key = String(value || "").toUpperCase();
  const color = FDA_LETTERS_V2_STATUS_COLORS[key] || "#6e6259";
  return (
    <span
      className="inline-flex items-center gap-[5px] text-[11px] font-johnson-text font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap capitalize"
      style={{ background: `${color}17`, color }}
    >
      <span className="w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: color }} />
      {value || "Unknown"}
    </span>
  );
}

function FdaLettersV2Explorer({ logInPage, activeTab, onBusyChange }) {
  /* ---------- Dashboard ---------- */
  const [summary, setSummary] = useState(null);
  const [statusChart, setStatusChart] = useState([]);
  const [appTypeChart, setAppTypeChart] = useState([]);
  const [topSponsorsChart, setTopSponsorsChart] = useState([]);
  const [topIndicationsChart, setTopIndicationsChart] = useState([]);
  const [byYearChart, setByYearChart] = useState([]);
  const [chartsLoading, setChartsLoading] = useState(true);
  const [chartsError, setChartsError] = useState(null);
  const [cardErrors, setCardErrors] = useState({});
  const [statusSql, setStatusSql] = useState("");
  const [appTypeSql, setAppTypeSql] = useState("");
  const [sponsorsSql, setSponsorsSql] = useState("");
  const [indicationsSql, setIndicationsSql] = useState("");
  const [byYearSql, setByYearSql] = useState("");
  const [sqlModal, setSqlModal] = useState(null);
  const openSqlModal = (payload) => setSqlModal(payload);

  const loadDashboard = useCallback(() => {
    setChartsLoading(true);
    setChartsError(null);
    Promise.allSettled([
      fetchJson(`${API_BASE_URL}/api/fda/fda-letters/summary`),
      fetchJson(`${API_BASE_URL}/api/fda/fda-letters/charts/status`),
      fetchJson(`${API_BASE_URL}/api/fda/fda-letters/charts/application-type`),
      fetchJson(`${API_BASE_URL}/api/fda/fda-letters/charts/top-sponsors?limit=10`),
      fetchJson(`${API_BASE_URL}/api/fda/fda-letters/charts/top-indications?limit=10`),
      fetchJson(`${API_BASE_URL}/api/fda/fda-letters/charts/by-year`),
    ]).then(([summaryRes, statusRes, appTypeRes, sponsorsRes, indicationsRes, yearRes]) => {
      const errors = {};
      if (summaryRes.status === "fulfilled") setSummary(summaryRes.value);
      else errors.summary = summaryRes.reason?.message || "Failed to load summary";

      if (statusRes.status === "fulfilled") { setStatusChart(statusRes.value.rows || []); setStatusSql(statusRes.value.sql || ""); }
      else errors.status = statusRes.reason?.message || "Failed to load chart";

      if (appTypeRes.status === "fulfilled") { setAppTypeChart(appTypeRes.value.rows || []); setAppTypeSql(appTypeRes.value.sql || ""); }
      else errors.appType = appTypeRes.reason?.message || "Failed to load chart";

      if (sponsorsRes.status === "fulfilled") { setTopSponsorsChart(sponsorsRes.value.rows || []); setSponsorsSql(sponsorsRes.value.sql || ""); }
      else errors.sponsors = sponsorsRes.reason?.message || "Failed to load chart";

      if (indicationsRes.status === "fulfilled") { setTopIndicationsChart(indicationsRes.value.rows || []); setIndicationsSql(indicationsRes.value.sql || ""); }
      else errors.indications = indicationsRes.reason?.message || "Failed to load chart";

      if (yearRes.status === "fulfilled") { setByYearChart(yearRes.value.rows || []); setByYearSql(yearRes.value.sql || ""); }
      else errors.byYear = yearRes.reason?.message || "Failed to load chart";

      setCardErrors(errors);
      if (summaryRes.status === "rejected" && Object.keys(errors).length === 6) {
        setChartsError(errors.summary);
      }
      setChartsLoading(false);
    });
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const statusFallbackIdx = useRef({ i: 0 });
  const statusSegments = useMemo(() => {
    const sum = statusChart.reduce((a, r) => a + (r.count || 0), 0);
    if (!sum) return { segments: [], total: 0 };
    statusFallbackIdx.current.i = 0;
    const sorted = [...statusChart].sort((a, b) => b.count - a.count);
    return {
      total: sum,
      segments: sorted.map(r => ({
        status: r.status === "(unspecified)" ? "Unspecified" : r.status.charAt(0) + r.status.slice(1).toLowerCase(),
        color: FDA_LETTERS_V2_STATUS_COLORS[String(r.status || "").toUpperCase()] || FALLBACK_COLORS[statusFallbackIdx.current.i++ % FALLBACK_COLORS.length],
        frac: r.count / sum,
        count: r.count,
      })),
    };
  }, [statusChart]);

  const appTypeBars = useMemo(() => appTypeChart.map(r => ({ area: r.application_type, count: r.count })), [appTypeChart]);
  const sponsorBars = useMemo(() => topSponsorsChart.map(r => ({ area: r.sponsor, count: r.count })), [topSponsorsChart]);
  const indicationBars = useMemo(() => topIndicationsChart.map(r => ({ area: r.indication, count: r.count })), [topIndicationsChart]);
  const yearBars = useMemo(() => byYearChart.map(r => ({ area: r.year, count: r.count })), [byYearChart]);

  /* ---------- Data table ---------- */
  const [filters, setFilters] = useState({});
  const [selectedYears, setSelectedYears] = useState([]);
  const [searchId, setSearchId] = useState("");
  const [searchSponsor, setSearchSponsor] = useState("");
  const [searchProduct, setSearchProduct] = useState("");
  const [searchSubmission, setSearchSubmission] = useState("");
  const [searchAppNumber, setSearchAppNumber] = useState("");
  const [searchFileName, setSearchFileName] = useState("");
  const [searchLocalPath, setSearchLocalPath] = useState("");
  const [searchLetterDate, setSearchLetterDate] = useState("");
  const [searchNotes, setSearchNotes] = useState("");
  const [searchEvidenceQuote, setSearchEvidenceQuote] = useState("");
  const [searchLetterText, setSearchLetterText] = useState("");
  const debouncedId = useDebounced(searchId);
  const debouncedSponsor = useDebounced(searchSponsor);
  const debouncedProduct = useDebounced(searchProduct);
  const debouncedSubmission = useDebounced(searchSubmission);
  const debouncedAppNumber = useDebounced(searchAppNumber);
  const debouncedFileName = useDebounced(searchFileName);
  const debouncedLocalPath = useDebounced(searchLocalPath);
  const debouncedLetterDate = useDebounced(searchLetterDate);
  const debouncedNotes = useDebounced(searchNotes);
  const debouncedEvidenceQuote = useDebounced(searchEvidenceQuote);
  const debouncedLetterText = useDebounced(searchLetterText);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortCol, setSortCol] = useState("processed_at");
  const [sortDir, setSortDir] = useState("desc");

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState(null);
  const [dataSql, setDataSql] = useState("");

  const [facets, setFacets] = useState({});
  const [facetsLoading, setFacetsLoading] = useState(true);

  const [detailRow, setDetailRow] = useState(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const filtersParam = useMemo(() => {
    const parts = Object.entries(filters)
      .filter(([, vals]) => vals && vals.length > 0)
      .map(([col, vals]) => `${col}:${vals.join("||")}`);
    return parts.join(",");
  }, [filters]);
  const yearsParam = useMemo(() => selectedYears.join(","), [selectedYears]);
  const activeFilterCount = Object.values(filters).reduce((n, vals) => n + (vals?.length || 0), 0) + selectedYears.length;
  const debouncedSearches = [debouncedId, debouncedSponsor, debouncedProduct, debouncedSubmission, debouncedAppNumber, debouncedFileName, debouncedLocalPath, debouncedLetterDate, debouncedNotes, debouncedEvidenceQuote, debouncedLetterText];

  useEffect(() => { setPage(1); }, [filtersParam, yearsParam, pageSize, ...debouncedSearches]);

  useEffect(() => {
    const controller = new AbortController();
    setFacetsLoading(true);
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    if (yearsParam) params.set("years", yearsParam);
    const qs = params.toString() ? `?${params.toString()}` : "";
    fetchJson(`${API_BASE_URL}/api/fda/fda-letters/facets${qs}`, { signal: controller.signal })
      .then(data => { setFacets(data); setFacetsLoading(false); })
      .catch(() => setFacetsLoading(false));
    return () => controller.abort();
  }, [filtersParam, yearsParam]);

  const buildDataQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    if (yearsParam) params.set("years", yearsParam);
    if (debouncedId) params.set("search_id", debouncedId);
    if (debouncedSponsor) params.set("search_sponsor", debouncedSponsor);
    if (debouncedProduct) params.set("search_product_name", debouncedProduct);
    if (debouncedSubmission) params.set("search_submission_id", debouncedSubmission);
    if (debouncedAppNumber) params.set("search_application_number", debouncedAppNumber);
    if (debouncedFileName) params.set("search_file_name", debouncedFileName);
    if (debouncedLocalPath) params.set("search_local_path", debouncedLocalPath);
    if (debouncedLetterDate) params.set("search_letter_date", debouncedLetterDate);
    if (debouncedNotes) params.set("search_notes", debouncedNotes);
    if (debouncedEvidenceQuote) params.set("search_evidence_quote", debouncedEvidenceQuote);
    if (debouncedLetterText) params.set("search_letter_text", debouncedLetterText);
    params.set("sort_col", sortCol);
    params.set("sort_dir", sortDir);
    return params;
  }, [filtersParam, yearsParam, sortCol, sortDir, ...debouncedSearches]);

  useEffect(() => {
    const controller = new AbortController();
    setRowsLoading(true);
    setRowsError(null);
    const params = buildDataQuery();
    params.set("page", String(page));
    params.set("page_size", String(pageSize));
    fetchJson(`${API_BASE_URL}/api/fda/fda-letters/data?${params.toString()}`, { signal: controller.signal })
      .then(data => {
        setRows(data.rows || []);
        setTotal(data.total || 0);
        setTotalPages(data.total_pages || 1);
        setDataSql(data.sql || "");
        setRowsLoading(false);
      })
      .catch(e => {
        if (e.name === "AbortError") return;
        setRowsError(e.message || "Failed to load FDA CRL letters");
        setRowsLoading(false);
      });
    return () => controller.abort();
  }, [buildDataQuery, page, pageSize]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  };

  const downloadPageCsv = () => {
    logInPage("export_page", `Downloaded current page (${rows.length} rows) of FDA CRL letters`);
    downloadClientCsv("fda_crl_letters_extended_page.csv", FDA_LETTERS_V2_ALL_COLUMNS, rows);
  };

  const downloadAllCsv = async () => {
    setDownloadingAll(true);
    logInPage("export_all", `Downloaded all ${total.toLocaleString()} matching FDA CRL letters`);
    try {
      const params = buildDataQuery();
      await downloadFile(`/api/fda/fda-letters/data/download?${params.toString()}`, "fda_crl_letters_extended.csv");
    } catch (e) {
      setRowsError(e.message || "Download failed");
    } finally {
      setDownloadingAll(false);
    }
  };

  const busy = chartsLoading || rowsLoading;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const lettersV2TableCardRef = useRef(null);
  const [lettersV2Fullscreen, setLettersV2Fullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setLettersV2Fullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  const toggleLettersV2Fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else lettersV2TableCardRef.current?.requestFullscreen?.();
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ============ DASHBOARD ============ */}
      {activeTab === "explore" && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-5 flex flex-col gap-3.5 min-h-full">
            {chartsError && <ErrorBanner message={`Couldn't load the FDA CRL letters dashboard: ${chartsError}`} onRetry={loadDashboard} />}
            {!chartsError && !chartsLoading && Object.keys(cardErrors).length > 0 && (
              <div className="px-4 py-2.5 rounded-xl bg-jj-gray-01 border border-jj-gray-02 text-xs font-johnson-text text-jj-gray-07">
                Some cards couldn't load ({Object.keys(cardErrors).length} of 6).
              </div>
            )}

            {/* KPI band */}
            <div className="flex items-center justify-between flex-shrink-0">
              <span />
              {summary?.sql && (
                <button onClick={() => openSqlModal({ title: "KPI summary", sql: summary.sql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
              )}
            </div>
            <div className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">CRL letters received</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.total_letters) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">ingested from FDA Complete Response Letters</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Approval rate</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary?.approval_rate != null ? `${summary.approval_rate}%` : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">{summary ? `${formatCompact(summary.approved_count)} of ${formatCompact(summary.total_letters)} letters` : "eventually approved after CRL"}</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Sponsors covered</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_sponsors) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">unique companies represented</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Indications</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_indications) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">distinct indications cited</div>
              </div>
            </div>

            {/* Approval status + applications by type */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Approval status</div>
                  {statusSql && <button onClick={() => openSqlModal({ title: "Approval status", sql: statusSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">how many CRL letters have since been approved vs. remain unapproved</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.status ? (
                  <CardUnavailable message={cardErrors.status} onRetry={loadDashboard} />
                ) : statusSegments.segments.length ? (
                  <div className="flex items-center gap-5">
                    <StatusDonut segments={statusSegments.segments} headerLabel="Approval status" />
                    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                      {statusSegments.segments.map(s => (
                        <div key={s.status} className="flex items-center gap-2 text-[11.5px] font-johnson-text">
                          <span className="w-2 h-2 rounded-[2px] flex-shrink-0" style={{ background: s.color }} />
                          <span className="text-jj-gray-08 truncate flex-1">{s.status}</span>
                          <span className="text-jj-gray-06 tabular-nums">{Math.round(s.frac * 100)}%</span>
                          <span className="text-jj-gray-08 font-medium tabular-nums w-12 text-right">{formatCompact(s.count)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : <NoData />}
              </Card>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Applications by type</div>
                  {appTypeSql && <button onClick={() => openSqlModal({ title: "Applications by type", sql: appTypeSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">CRL letters split between BLA and NDA submissions</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.appType ? (
                  <CardUnavailable message={cardErrors.appType} onRetry={loadDashboard} />
                ) : appTypeBars.length ? (
                  <RankedBars data={appTypeBars} />
                ) : <NoData />}
              </Card>
            </div>

            {/* Top sponsors + top indications */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Sponsors with the most CRLs</div>
                  {sponsorsSql && <button onClick={() => openSqlModal({ title: "Sponsors with the most CRLs", sql: sponsorsSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">companies most frequently receiving Complete Response Letters</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.sponsors ? (
                  <CardUnavailable message={cardErrors.sponsors} onRetry={loadDashboard} />
                ) : sponsorBars.length ? (
                  <RankedBars data={sponsorBars} />
                ) : <NoData />}
              </Card>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Top indications</div>
                  {indicationsSql && <button onClick={() => openSqlModal({ title: "Top indications", sql: indicationsSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">indications most frequently cited across CRL letters</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.indications ? (
                  <CardUnavailable message={cardErrors.indications} onRetry={loadDashboard} />
                ) : indicationBars.length ? (
                  <RankedBars data={indicationBars} />
                ) : <NoData />}
              </Card>
            </div>

            {/* CRL letters by year - full width */}
            <Card className="px-5 py-4 flex-shrink-0">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">CRL letters by year</div>
                {byYearSql && <button onClick={() => openSqlModal({ title: "CRL letters by year", sql: byYearSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
              </div>
              <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">volume of letters received, by the year on the letter itself</div>
              {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.byYear ? (
                <CardUnavailable message={cardErrors.byYear} onRetry={loadDashboard} />
              ) : yearBars.length ? (
                <RankedBars data={yearBars} />
              ) : <NoData />}
            </Card>
          </div>
        </div>
      )}

      {/* ============ DATA TABLE ============ */}
      {activeTab === "table" && (
        <div className="flex-1 min-h-0 flex">
          {/* Filter rail */}
          <div className="w-[252px] flex-shrink-0 bg-white border-r border-jj-gray-02 flex flex-col overflow-hidden">
            <div className="px-[18px] pt-4 pb-3 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2 text-[13px] font-johnson-text font-bold text-jj-gray-08">
                <Icon src={filterIcon} tint="ink" className="w-[13px] h-[13px]" />
                Refine
                {activeFilterCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium">
                    {activeFilterCount}
                  </span>
                )}
              </div>
              <button onClick={() => { setFilters({}); setSelectedYears([]); }} disabled={activeFilterCount === 0} className="text-[11px] font-johnson-text text-jj-blue-03 disabled:opacity-40">
                Clear all
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-[18px] pb-3.5 space-y-2 border-b border-jj-gray-01">
              {[
                { value: searchId, set: setSearchId, ph: "ID contains…" },
                { value: searchSponsor, set: setSearchSponsor, ph: "Sponsor contains…" },
                { value: searchProduct, set: setSearchProduct, ph: "Product contains…" },
                { value: searchSubmission, set: setSearchSubmission, ph: "Submission ID contains…" },
                { value: searchAppNumber, set: setSearchAppNumber, ph: "Application number contains…" },
                { value: searchFileName, set: setSearchFileName, ph: "File name contains…" },
                { value: searchLocalPath, set: setSearchLocalPath, ph: "Local path contains…" },
                { value: searchLetterDate, set: setSearchLetterDate, ph: "Letter date (raw) contains…" },
                { value: searchNotes, set: setSearchNotes, ph: "Notes contains…" },
                { value: searchEvidenceQuote, set: setSearchEvidenceQuote, ph: "Evidence quote contains…" },
                { value: searchLetterText, set: setSearchLetterText, ph: "Letter text contains…" },
              ].map(({ value, set, ph }) => (
                <div key={ph} className="relative">
                  <Icon src={searchIcon} tint="gray" className="w-[13px] h-[13px] absolute left-2.5 top-[9px]" />
                  <input
                    value={value}
                    onChange={e => set(e.target.value)}
                    placeholder={ph}
                    className="w-full pl-8 pr-2 py-2 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
                  />
                </div>
              ))}
              <div className="text-[10px] font-johnson-text text-jj-gray-06">Applies after you stop typing.</div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <FdaFacetGroup
                label="Approval status"
                column="status"
                selected={filters.status || []}
                onChange={vals => setFilters(prev => ({ ...prev, status: vals }))}
                options={facets.status || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Application type"
                column="application_type"
                selected={filters.application_type || []}
                onChange={vals => setFilters(prev => ({ ...prev, application_type: vals }))}
                options={facets.application_type || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Indication"
                column="indication"
                selected={filters.indication || []}
                onChange={vals => setFilters(prev => ({ ...prev, indication: vals }))}
                options={facets.indication || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Sponsor (normalized)"
                column="sponsor_norm"
                selected={filters.sponsor_norm || []}
                onChange={vals => setFilters(prev => ({ ...prev, sponsor_norm: vals }))}
                options={facets.sponsor_norm || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Product (normalized)"
                column="product_norm"
                selected={filters.product_norm || []}
                onChange={vals => setFilters(prev => ({ ...prev, product_norm: vals }))}
                options={facets.product_norm || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="CRL year"
                column="year"
                selected={selectedYears}
                onChange={vals => setSelectedYears(vals)}
                options={facets.year || []}
                loading={facetsLoading}
              />
            </div>
          </div>

          {/* Main content */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-5 gap-0">
            {rowsError && <ErrorBanner message={rowsError} onRetry={() => setPage(p => p)} />}
            <div ref={lettersV2TableCardRef} className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-3 border-b border-jj-gray-01">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                  Matching records <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{total.toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-2.5">
                  {dataSql && (
                    <button onClick={() => openSqlModal({ title: "Data table (current page)", sql: dataSql })} className="text-[11px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
                  )}
                  <button
                    onClick={downloadPageCsv}
                    disabled={rowsLoading || rows.length === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Downloads the current page only"
                  >
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    Download page
                  </button>
                  <button
                    onClick={downloadAllCsv}
                    disabled={rowsLoading || downloadingAll || total === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Streams every matching row as CSV - no row cap"
                  >
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    {downloadingAll ? "Preparing…" : `Download all (${total.toLocaleString()})`}
                  </button>
                  <button
                    onClick={toggleLettersV2Fullscreen}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
                    title={lettersV2Fullscreen ? "Exit full screen" : "View the table full screen"}
                  >
                    {lettersV2Fullscreen ? "⤳ Exit full screen" : "⛶ Full screen"}
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 relative">
                {rowsLoading && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10">
                    <LoadingSpinner />
                  </div>
                )}
                <div className="h-full overflow-auto">
                  <table className="text-[12px] font-johnson-text border-collapse" style={{ width: "max-content", minWidth: "100%" }}>
                    <thead className="sticky top-0 z-[5]">
                      <tr className="bg-jj-gray-01 text-jj-gray-07 text-[11px] uppercase tracking-wider">
                        {FDA_LETTERS_V2_TABLE_COLUMNS.map(col => (
                          <th
                            key={col.key}
                            onClick={() => col.sortCol && toggleSort(col.sortCol)}
                            style={{ minWidth: col.minWidth }}
                            className={`text-left px-3 py-2.5 font-bold select-none whitespace-nowrap ${col.sortCol ? "cursor-pointer" : ""}`}
                          >
                            {col.label} {col.sortCol && sortCol === col.sortCol ? (sortDir === "asc" ? "▲" : "▼") : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr
                          key={row.id ?? i}
                          onClick={() => {
                            logInPage("row_detail_view", `Opened FDA CRL letter detail for ${row.sponsor || row.file_name || "row " + i}`);
                            setDetailRow(row);
                          }}
                          className="border-t border-jj-gray-01 hover:bg-jj-gray-01/50 cursor-pointer"
                        >
                          {FDA_LETTERS_V2_TABLE_COLUMNS.map(col => {
                            const raw = row[col.key];
                            const display = raw != null && typeof raw === "object" ? JSON.stringify(raw) : raw;
                            return (
                              <td
                                key={col.key}
                                style={{ minWidth: col.minWidth, maxWidth: col.minWidth * 2 }}
                                className={`px-3 py-2 truncate ${col.bold ? "font-medium text-jj-gray-08" : "text-jj-gray-07"}`}
                                title={typeof display === "string" ? display : undefined}
                              >
                                {col.key === "status" && row.status ? <FdaLettersV2StatusPill value={row.status} /> : (display ?? "—")}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                      {!rowsLoading && rows.length === 0 && (
                        <tr>
                          <td colSpan={FDA_LETTERS_V2_TABLE_COLUMNS.length} className="px-3 py-8 text-center text-jj-gray-06">
                            {rowsError ? "Couldn't load FDA CRL letters." : "No letters match the current filters."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-2.5 border-t border-jj-gray-01">
                <div className="flex items-center gap-2 text-[11.5px] font-johnson-text text-jj-gray-06 tabular-nums">
                  <Icon src={infoIcon} tint="ink" className="w-3.5 h-3.5" />
                  {total.toLocaleString()} rows
                  <select
                    value={pageSize}
                    onChange={e => setPageSize(Number(e.target.value))}
                    disabled={rowsLoading}
                    className="ml-2 border border-jj-gray-03 rounded-lg px-2 py-1 font-johnson-text"
                  >
                    {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}/page</option>)}
                  </select>
                </div>
                <Pager page={page} totalPages={totalPages} loading={rowsLoading} onGo={setPage} />
              </div>
            </div>
          </div>
        </div>
      )}

      <DetailModal record={detailRow} onClose={() => setDetailRow(null)} />
      <SqlModal modal={sqlModal} onClose={() => setSqlModal(null)} />
    </div>
  );
}

/* ============================== Milvexian Metadata dashboard ============================== */
// Backed by /api/fda/milvexian/* (vector_embedding.milvexian_metadata) -
// ~776K rows, same Documentum-style document index shape as eCTD Documents,
// scoped to the milvexian program. No id/primary key on this table
// (r_object_id is a Documentum internal id, not a stable numeric key), so
// there's no per-row detail fetch - clicking a row just opens the
// already-loaded row data, same as the other file-index dashboards.
//
// One extra column vs. ectd_docs - a_content_type (e.g. 'msw15', 'msw14') -
// and a single Path column instead of separate Link/Path columns. Every
// column is shown, in table order - checkbox facets (with a "Narrow list…"
// search) for the lower-cardinality columns, free-text search boxes for
// identifiers/titles/file paths where a facet wouldn't be useful.

const MILVEXIAN_STATUS_COLORS = { APPROVED: "#328714", DRAFT: "#eb1700", "(UNSPECIFIED)": "#6e6259" };

const MILVEXIAN_TABLE_COLUMNS = [
  { key: "jj_prod_disp_name", label: "Product", sortCol: "jj_prod_disp_name", bold: true, minWidth: 170 },
  { key: "product_trade_name", label: "Trade name", sortCol: "product_trade_name", minWidth: 150 },
  { key: "product_generic_name", label: "Generic name", sortCol: "product_generic_name", minWidth: 150 },
  { key: "inn_names", label: "INN name", sortCol: "inn_names", minWidth: 140 },
  { key: "product_code", label: "Product code", sortCol: "product_code", minWidth: 160 },
  { key: "jj_title", label: "Document title", sortCol: "jj_title", minWidth: 260 },
  { key: "jj_number", label: "Document number", sortCol: "jj_number", minWidth: 170 },
  { key: "a_status", label: "Status", sortCol: "a_status", minWidth: 110 },
  { key: "a_content_type", label: "Content type", sortCol: "a_content_type", minWidth: 120 },
  { key: "r_version_label", label: "Version", sortCol: "r_version_label", minWidth: 150 },
  { key: "i_latest_flag", label: "Latest?", sortCol: "i_latest_flag", minWidth: 80 },
  { key: "r_link_cnt", label: "Link count", sortCol: "r_link_cnt", minWidth: 90 },
  { key: "primary_group", label: "Group", sortCol: "primary_group", minWidth: 130 },
  { key: "subgroup", label: "Subgroup", sortCol: "subgroup", minWidth: 110 },
  { key: "artifact_name", label: "Artifact", sortCol: "artifact_name", minWidth: 220 },
  { key: "jj_artifact_short_name", label: "Artifact (short)", sortCol: "jj_artifact_short_name", minWidth: 150 },
  { key: "ectd_section", label: "eCTD section", sortCol: "ectd_section", minWidth: 110 },
  { key: "jj_ectd_leafname", label: "eCTD leaf name", sortCol: "jj_ectd_leafname", minWidth: 160 },
  { key: "jj_ectd_leaftitle", label: "eCTD leaf title", sortCol: "jj_ectd_leaftitle", minWidth: 160 },
  { key: "r_object_id", label: "Object ID", sortCol: "r_object_id", minWidth: 140 },
  { key: "object_name", label: "Object name", sortCol: "object_name", minWidth: 260 },
  { key: "Path", label: "Path", sortCol: "Path", minWidth: 280 },
  { key: "nas_path", label: "NAS path", sortCol: "nas_path", minWidth: 320 },
];

const MILVEXIAN_ALL_COLUMNS = [
  "Path", "r_object_id", "object_name", "a_content_type", "a_status", "jj_title", "r_version_label",
  "jj_number", "i_latest_flag", "r_link_cnt", "product_code", "jj_prod_disp_name", "inn_names",
  "product_generic_name", "product_trade_name", "primary_group", "subgroup", "artifact_name",
  "jj_artifact_short_name", "ectd_section", "jj_ectd_leafname", "jj_ectd_leaftitle", "nas_path",
];

function MilvexianStatusPill({ value }) {
  const key = String(value || "").toUpperCase();
  const color = MILVEXIAN_STATUS_COLORS[key] || "#6e6259";
  return (
    <span
      className="inline-flex items-center gap-[5px] text-[11px] font-johnson-text font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap capitalize"
      style={{ background: `${color}17`, color }}
    >
      <span className="w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: color }} />
      {value || "Unknown"}
    </span>
  );
}

function MilvexianMetadataExplorer({ logInPage, activeTab, onBusyChange }) {
  /* ---------- Dashboard ---------- */
  const [summary, setSummary] = useState(null);
  const [statusChart, setStatusChart] = useState([]);
  const [groupChart, setGroupChart] = useState([]);
  const [topProductsChart, setTopProductsChart] = useState([]);
  const [topSectionsChart, setTopSectionsChart] = useState([]);
  const [contentTypeChart, setContentTypeChart] = useState([]);
  const [chartsLoading, setChartsLoading] = useState(true);
  const [chartsError, setChartsError] = useState(null);
  const [cardErrors, setCardErrors] = useState({});
  const [statusSql, setStatusSql] = useState("");
  const [groupSql, setGroupSql] = useState("");
  const [productsSql, setProductsSql] = useState("");
  const [sectionsSql, setSectionsSql] = useState("");
  const [contentTypeSql, setContentTypeSql] = useState("");
  const [sqlModal, setSqlModal] = useState(null);
  const openSqlModal = (payload) => setSqlModal(payload);

  const loadDashboard = useCallback(() => {
    setChartsLoading(true);
    setChartsError(null);
    Promise.allSettled([
      fetchJson(`${API_BASE_URL}/api/fda/milvexian/summary`),
      fetchJson(`${API_BASE_URL}/api/fda/milvexian/charts/status`),
      fetchJson(`${API_BASE_URL}/api/fda/milvexian/charts/primary-group`),
      fetchJson(`${API_BASE_URL}/api/fda/milvexian/charts/top-products?limit=12`),
      fetchJson(`${API_BASE_URL}/api/fda/milvexian/charts/top-sections?limit=12`),
      fetchJson(`${API_BASE_URL}/api/fda/milvexian/charts/content-type`),
    ]).then(([summaryRes, statusRes, groupRes, productsRes, sectionsRes, contentTypeRes]) => {
      const errors = {};
      if (summaryRes.status === "fulfilled") setSummary(summaryRes.value);
      else errors.summary = summaryRes.reason?.message || "Failed to load summary";

      if (statusRes.status === "fulfilled") { setStatusChart(statusRes.value.rows || []); setStatusSql(statusRes.value.sql || ""); }
      else errors.status = statusRes.reason?.message || "Failed to load chart";

      if (groupRes.status === "fulfilled") { setGroupChart(groupRes.value.rows || []); setGroupSql(groupRes.value.sql || ""); }
      else errors.group = groupRes.reason?.message || "Failed to load chart";

      if (productsRes.status === "fulfilled") { setTopProductsChart(productsRes.value.rows || []); setProductsSql(productsRes.value.sql || ""); }
      else errors.products = productsRes.reason?.message || "Failed to load chart";

      if (sectionsRes.status === "fulfilled") { setTopSectionsChart(sectionsRes.value.rows || []); setSectionsSql(sectionsRes.value.sql || ""); }
      else errors.sections = sectionsRes.reason?.message || "Failed to load chart";

      if (contentTypeRes.status === "fulfilled") { setContentTypeChart(contentTypeRes.value.rows || []); setContentTypeSql(contentTypeRes.value.sql || ""); }
      else errors.contentType = contentTypeRes.reason?.message || "Failed to load chart";

      setCardErrors(errors);
      if (summaryRes.status === "rejected" && Object.keys(errors).length === 6) {
        setChartsError(errors.summary);
      }
      setChartsLoading(false);
    });
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const statusFallbackIdx = useRef({ i: 0 });
  const statusSegments = useMemo(() => {
    const sum = statusChart.reduce((a, r) => a + (r.count || 0), 0);
    if (!sum) return { segments: [], total: 0 };
    statusFallbackIdx.current.i = 0;
    const sorted = [...statusChart].sort((a, b) => b.count - a.count);
    return {
      total: sum,
      segments: sorted.map(r => ({
        status: r.status === "(unspecified)" ? "Unspecified" : r.status.charAt(0) + r.status.slice(1).toLowerCase(),
        color: MILVEXIAN_STATUS_COLORS[String(r.status || "").toUpperCase()] || FALLBACK_COLORS[statusFallbackIdx.current.i++ % FALLBACK_COLORS.length],
        frac: r.count / sum,
        count: r.count,
      })),
    };
  }, [statusChart]);

  const groupBars = useMemo(() => groupChart.map(r => ({
    area: r.group_label === "(unspecified)" ? "Unspecified" : r.group_label.charAt(0) + r.group_label.slice(1).toLowerCase(),
    count: r.count,
  })), [groupChart]);
  const productBars = useMemo(() => topProductsChart.map(r => ({ area: r.jj_prod_disp_name, count: r.count })), [topProductsChart]);
  const sectionBars = useMemo(() => topSectionsChart.map(r => ({ area: r.ectd_section, count: r.count })), [topSectionsChart]);
  const contentTypeBars = useMemo(() => contentTypeChart.map(r => ({ area: r.content_type_label, count: r.count })), [contentTypeChart]);

  /* ---------- Data table ---------- */
  const [filters, setFilters] = useState({});
  const [searchTitle, setSearchTitle] = useState("");
  const [searchNumber, setSearchNumber] = useState("");
  const [searchVersionLabel, setSearchVersionLabel] = useState("");
  const [searchObjectId, setSearchObjectId] = useState("");
  const [searchObjectName, setSearchObjectName] = useState("");
  const [searchPath, setSearchPath] = useState("");
  const [searchNasPath, setSearchNasPath] = useState("");
  const debouncedTitle = useDebounced(searchTitle);
  const debouncedNumber = useDebounced(searchNumber);
  const debouncedVersionLabel = useDebounced(searchVersionLabel);
  const debouncedObjectId = useDebounced(searchObjectId);
  const debouncedObjectName = useDebounced(searchObjectName);
  const debouncedPath = useDebounced(searchPath);
  const debouncedNasPath = useDebounced(searchNasPath);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortCol, setSortCol] = useState("jj_number");
  const [sortDir, setSortDir] = useState("asc");

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState(null);
  const [dataSql, setDataSql] = useState("");

  const [facets, setFacets] = useState({});
  const [facetsLoading, setFacetsLoading] = useState(true);

  const [detailRow, setDetailRow] = useState(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const filtersParam = useMemo(() => {
    const parts = Object.entries(filters)
      .filter(([, vals]) => vals && vals.length > 0)
      .map(([col, vals]) => `${col}:${vals.join("||")}`);
    return parts.join(",");
  }, [filters]);
  const activeFilterCount = Object.values(filters).reduce((n, vals) => n + (vals?.length || 0), 0);

  useEffect(() => {
    setPage(1);
  }, [filtersParam, debouncedTitle, debouncedNumber, debouncedVersionLabel, debouncedObjectId, debouncedObjectName, debouncedPath, debouncedNasPath, pageSize]);

  useEffect(() => {
    const controller = new AbortController();
    setFacetsLoading(true);
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    const qs = params.toString() ? `?${params.toString()}` : "";
    fetchJson(`${API_BASE_URL}/api/fda/milvexian/facets${qs}`, { signal: controller.signal })
      .then(data => { setFacets(data); setFacetsLoading(false); })
      .catch(() => setFacetsLoading(false));
    return () => controller.abort();
  }, [filtersParam]);

  const buildDataQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    if (debouncedTitle) params.set("search_jj_title", debouncedTitle);
    if (debouncedNumber) params.set("search_jj_number", debouncedNumber);
    if (debouncedVersionLabel) params.set("search_r_version_label", debouncedVersionLabel);
    if (debouncedObjectId) params.set("search_r_object_id", debouncedObjectId);
    if (debouncedObjectName) params.set("search_object_name", debouncedObjectName);
    if (debouncedPath) params.set("search_path", debouncedPath);
    if (debouncedNasPath) params.set("search_nas_path", debouncedNasPath);
    params.set("sort_col", sortCol);
    params.set("sort_dir", sortDir);
    return params;
  }, [filtersParam, debouncedTitle, debouncedNumber, debouncedVersionLabel, debouncedObjectId, debouncedObjectName, debouncedPath, debouncedNasPath, sortCol, sortDir]);

  useEffect(() => {
    const controller = new AbortController();
    setRowsLoading(true);
    setRowsError(null);
    const params = buildDataQuery();
    params.set("page", String(page));
    params.set("page_size", String(pageSize));
    fetchJson(`${API_BASE_URL}/api/fda/milvexian/data?${params.toString()}`, { signal: controller.signal })
      .then(data => {
        setRows(data.rows || []);
        setTotal(data.total || 0);
        setTotalPages(data.total_pages || 1);
        setDataSql(data.sql || "");
        setRowsLoading(false);
      })
      .catch(e => {
        if (e.name === "AbortError") return;
        setRowsError(e.message || "Failed to load Milvexian documents");
        setRowsLoading(false);
      });
    return () => controller.abort();
  }, [buildDataQuery, page, pageSize]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  };

  const downloadPageCsv = () => {
    logInPage("export_page", `Downloaded current page (${rows.length} rows) of Milvexian documents`);
    downloadClientCsv("fda_milvexian_metadata_page.csv", MILVEXIAN_ALL_COLUMNS, rows);
  };

  const downloadAllCsv = async () => {
    setDownloadingAll(true);
    logInPage("export_all", `Downloaded all ${total.toLocaleString()} matching Milvexian documents`);
    try {
      const params = buildDataQuery();
      await downloadFile(`/api/fda/milvexian/data/download?${params.toString()}`, "fda_milvexian_metadata.csv");
    } catch (e) {
      setRowsError(e.message || "Download failed");
    } finally {
      setDownloadingAll(false);
    }
  };

  const busy = chartsLoading || rowsLoading;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const milvexianTableCardRef = useRef(null);
  const [milvexianFullscreen, setMilvexianFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setMilvexianFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  const toggleMilvexianFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else milvexianTableCardRef.current?.requestFullscreen?.();
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ============ DASHBOARD ============ */}
      {activeTab === "explore" && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-5 flex flex-col gap-3.5 min-h-full">
            {chartsError && <ErrorBanner message={`Couldn't load the Milvexian documents dashboard: ${chartsError}`} onRetry={loadDashboard} />}
            {!chartsError && !chartsLoading && Object.keys(cardErrors).length > 0 && (
              <div className="px-4 py-2.5 rounded-xl bg-jj-gray-01 border border-jj-gray-02 text-xs font-johnson-text text-jj-gray-07">
                Some cards couldn't load ({Object.keys(cardErrors).length} of 6).
              </div>
            )}

            {/* KPI band */}
            <div className="flex items-center justify-between flex-shrink-0">
              <span />
              {summary?.sql && (
                <button onClick={() => openSqlModal({ title: "KPI summary", sql: summary.sql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
              )}
            </div>
            <div className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Milvexian documents</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.total_docs) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">indexed across the submission structure</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Approved</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary?.approval_rate != null ? `${summary.approval_rate}%` : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">{summary ? `${formatCompact(summary.approved_count)} of ${formatCompact(summary.total_docs)} documents` : "final approved status"}</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Products</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_products) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">distinct products represented</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">eCTD sections</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_sections) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">distinct sections filed against</div>
              </div>
            </div>

            {/* Status + primary group */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Document status</div>
                  {statusSql && <button onClick={() => openSqlModal({ title: "Document status", sql: statusSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">documents still in draft vs. formally approved</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.status ? (
                  <CardUnavailable message={cardErrors.status} onRetry={loadDashboard} />
                ) : statusSegments.segments.length ? (
                  <div className="flex items-center gap-5">
                    <StatusDonut segments={statusSegments.segments} headerLabel="Document status" />
                    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                      {statusSegments.segments.map(s => (
                        <div key={s.status} className="flex items-center gap-2 text-[11.5px] font-johnson-text">
                          <span className="w-2 h-2 rounded-[2px] flex-shrink-0" style={{ background: s.color }} />
                          <span className="text-jj-gray-08 truncate flex-1">{s.status}</span>
                          <span className="text-jj-gray-06 tabular-nums">{Math.round(s.frac * 100)}%</span>
                          <span className="text-jj-gray-08 font-medium tabular-nums w-12 text-right">{formatCompact(s.count)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : <NoData />}
              </Card>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Drug substance vs. drug product</div>
                  {groupSql && <button onClick={() => openSqlModal({ title: "Drug substance vs. drug product", sql: groupSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">where documentation volume concentrates</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.group ? (
                  <CardUnavailable message={cardErrors.group} onRetry={loadDashboard} />
                ) : groupBars.length ? (
                  <RankedBars data={groupBars} />
                ) : <NoData />}
              </Card>
            </div>

            {/* Top products + top sections */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Products with the most documents</div>
                  {productsSql && <button onClick={() => openSqlModal({ title: "Products with the most documents", sql: productsSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">largest Milvexian document counts by product</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.products ? (
                  <CardUnavailable message={cardErrors.products} onRetry={loadDashboard} />
                ) : productBars.length ? (
                  <RankedBars data={productBars} />
                ) : <NoData />}
              </Card>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Most-used eCTD sections</div>
                  {sectionsSql && <button onClick={() => openSqlModal({ title: "Most-used eCTD sections", sql: sectionsSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">submission sections with the most documents filed</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.sections ? (
                  <CardUnavailable message={cardErrors.sections} onRetry={loadDashboard} />
                ) : sectionBars.length ? (
                  <RankedBars data={sectionBars} />
                ) : <NoData />}
              </Card>
            </div>

            {/* Content type - full width */}
            <Card className="px-5 py-4 flex-shrink-0">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Documents by content type</div>
                {contentTypeSql && <button onClick={() => openSqlModal({ title: "Documents by content type", sql: contentTypeSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
              </div>
              <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">document volume by content type code (e.g. msw15, msw14)</div>
              {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.contentType ? (
                <CardUnavailable message={cardErrors.contentType} onRetry={loadDashboard} />
              ) : contentTypeBars.length ? (
                <RankedBars data={contentTypeBars} />
              ) : <NoData />}
            </Card>
          </div>
        </div>
      )}

      {/* ============ DATA TABLE ============ */}
      {activeTab === "table" && (
        <div className="flex-1 min-h-0 flex">
          {/* Filter rail */}
          <div className="w-[252px] flex-shrink-0 bg-white border-r border-jj-gray-02 flex flex-col overflow-hidden">
            <div className="px-[18px] pt-4 pb-3 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2 text-[13px] font-johnson-text font-bold text-jj-gray-08">
                <Icon src={filterIcon} tint="ink" className="w-[13px] h-[13px]" />
                Refine
                {activeFilterCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium">
                    {activeFilterCount}
                  </span>
                )}
              </div>
              <button onClick={() => setFilters({})} disabled={activeFilterCount === 0} className="text-[11px] font-johnson-text text-jj-blue-03 disabled:opacity-40">
                Clear all
              </button>
            </div>
            <div className="px-[18px] pb-3.5 space-y-2 border-b border-jj-gray-01 flex-shrink-0">
              {[
                { value: searchTitle, set: setSearchTitle, ph: "Document title contains…" },
                { value: searchNumber, set: setSearchNumber, ph: "Document number contains…" },
                { value: searchVersionLabel, set: setSearchVersionLabel, ph: "Version label contains…" },
                { value: searchObjectId, set: setSearchObjectId, ph: "Object ID contains…" },
                { value: searchObjectName, set: setSearchObjectName, ph: "Object name contains…" },
                { value: searchPath, set: setSearchPath, ph: "Path contains…" },
                { value: searchNasPath, set: setSearchNasPath, ph: "NAS path contains…" },
              ].map(({ value, set, ph }) => (
                <div key={ph} className="relative">
                  <Icon src={searchIcon} tint="gray" className="w-[13px] h-[13px] absolute left-2.5 top-[9px]" />
                  <input
                    value={value}
                    onChange={e => set(e.target.value)}
                    placeholder={ph}
                    className="w-full pl-8 pr-2 py-2 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
                  />
                </div>
              ))}
              <div className="text-[10px] font-johnson-text text-jj-gray-06">Applies after you stop typing.</div>
            </div>
            <div className="flex-1 overflow-y-auto">
              <FdaFacetGroup
                label="Status"
                column="a_status"
                selected={filters.a_status || []}
                onChange={vals => setFilters(prev => ({ ...prev, a_status: vals }))}
                options={facets.a_status || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Content type"
                column="a_content_type"
                selected={filters.a_content_type || []}
                onChange={vals => setFilters(prev => ({ ...prev, a_content_type: vals }))}
                options={facets.a_content_type || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Group"
                column="primary_group"
                selected={filters.primary_group || []}
                onChange={vals => setFilters(prev => ({ ...prev, primary_group: vals }))}
                options={facets.primary_group || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Subgroup"
                column="subgroup"
                selected={filters.subgroup || []}
                onChange={vals => setFilters(prev => ({ ...prev, subgroup: vals }))}
                options={facets.subgroup || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Latest?"
                column="i_latest_flag"
                selected={filters.i_latest_flag || []}
                onChange={vals => setFilters(prev => ({ ...prev, i_latest_flag: vals }))}
                options={facets.i_latest_flag || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Link count"
                column="r_link_cnt"
                selected={filters.r_link_cnt || []}
                onChange={vals => setFilters(prev => ({ ...prev, r_link_cnt: vals }))}
                options={facets.r_link_cnt || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Product code"
                column="product_code"
                selected={filters.product_code || []}
                onChange={vals => setFilters(prev => ({ ...prev, product_code: vals }))}
                options={facets.product_code || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Product"
                column="jj_prod_disp_name"
                selected={filters.jj_prod_disp_name || []}
                onChange={vals => setFilters(prev => ({ ...prev, jj_prod_disp_name: vals }))}
                options={facets.jj_prod_disp_name || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="INN name"
                column="inn_names"
                selected={filters.inn_names || []}
                onChange={vals => setFilters(prev => ({ ...prev, inn_names: vals }))}
                options={facets.inn_names || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Generic name"
                column="product_generic_name"
                selected={filters.product_generic_name || []}
                onChange={vals => setFilters(prev => ({ ...prev, product_generic_name: vals }))}
                options={facets.product_generic_name || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Trade name"
                column="product_trade_name"
                selected={filters.product_trade_name || []}
                onChange={vals => setFilters(prev => ({ ...prev, product_trade_name: vals }))}
                options={facets.product_trade_name || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Artifact"
                column="artifact_name"
                selected={filters.artifact_name || []}
                onChange={vals => setFilters(prev => ({ ...prev, artifact_name: vals }))}
                options={facets.artifact_name || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Artifact (short)"
                column="jj_artifact_short_name"
                selected={filters.jj_artifact_short_name || []}
                onChange={vals => setFilters(prev => ({ ...prev, jj_artifact_short_name: vals }))}
                options={facets.jj_artifact_short_name || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="eCTD section"
                column="ectd_section"
                selected={filters.ectd_section || []}
                onChange={vals => setFilters(prev => ({ ...prev, ectd_section: vals }))}
                options={facets.ectd_section || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="eCTD leaf name"
                column="jj_ectd_leafname"
                selected={filters.jj_ectd_leafname || []}
                onChange={vals => setFilters(prev => ({ ...prev, jj_ectd_leafname: vals }))}
                options={facets.jj_ectd_leafname || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="eCTD leaf title"
                column="jj_ectd_leaftitle"
                selected={filters.jj_ectd_leaftitle || []}
                onChange={vals => setFilters(prev => ({ ...prev, jj_ectd_leaftitle: vals }))}
                options={facets.jj_ectd_leaftitle || []}
                loading={facetsLoading}
              />
            </div>
          </div>

          {/* Main content */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-5 gap-0">
            {rowsError && <ErrorBanner message={rowsError} onRetry={() => setPage(p => p)} />}
            <div ref={milvexianTableCardRef} className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-3 border-b border-jj-gray-01">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                  Matching records <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{total.toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-2.5">
                  {dataSql && (
                    <button onClick={() => openSqlModal({ title: "Data table (current page)", sql: dataSql })} className="text-[11px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
                  )}
                  <button
                    onClick={downloadPageCsv}
                    disabled={rowsLoading || rows.length === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Downloads the current page only"
                  >
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    Download page
                  </button>
                  <button
                    onClick={downloadAllCsv}
                    disabled={rowsLoading || downloadingAll || total === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Streams every matching row as CSV - no row cap"
                  >
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    {downloadingAll ? "Preparing…" : `Download all (${total.toLocaleString()})`}
                  </button>
                  <button
                    onClick={toggleMilvexianFullscreen}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
                    title={milvexianFullscreen ? "Exit full screen" : "View the table full screen"}
                  >
                    {milvexianFullscreen ? "⤳ Exit full screen" : "⛶ Full screen"}
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 relative">
                {rowsLoading && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10">
                    <LoadingSpinner />
                  </div>
                )}
                <div className="h-full overflow-auto">
                  <table className="text-[12px] font-johnson-text border-collapse" style={{ width: "max-content", minWidth: "100%" }}>
                    <thead className="sticky top-0 z-[5]">
                      <tr className="bg-jj-gray-01 text-jj-gray-07 text-[11px] uppercase tracking-wider">
                        {MILVEXIAN_TABLE_COLUMNS.map(col => (
                          <th
                            key={col.key}
                            onClick={() => col.sortCol && toggleSort(col.sortCol)}
                            style={{ minWidth: col.minWidth }}
                            className={`text-left px-3 py-2.5 font-bold select-none whitespace-nowrap ${col.sortCol ? "cursor-pointer" : ""}`}
                          >
                            {col.label} {col.sortCol && sortCol === col.sortCol ? (sortDir === "asc" ? "▲" : "▼") : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr
                          key={i}
                          onClick={() => {
                            logInPage("row_detail_view", `Opened Milvexian document detail for ${row.jj_number || row.jj_title || "row " + i}`);
                            setDetailRow(row);
                          }}
                          className="border-t border-jj-gray-01 hover:bg-jj-gray-01/50 cursor-pointer"
                        >
                          {MILVEXIAN_TABLE_COLUMNS.map(col => (
                            <td
                              key={col.key}
                              style={{ minWidth: col.minWidth, maxWidth: col.minWidth * 2 }}
                              className={`px-3 py-2 truncate ${col.bold ? "font-medium text-jj-gray-08" : "text-jj-gray-07"}`}
                              title={typeof row[col.key] === "string" ? row[col.key] : undefined}
                            >
                              {col.key === "a_status" && row.a_status ? <MilvexianStatusPill value={row.a_status} /> : (row[col.key] ?? "—")}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {!rowsLoading && rows.length === 0 && (
                        <tr>
                          <td colSpan={MILVEXIAN_TABLE_COLUMNS.length} className="px-3 py-8 text-center text-jj-gray-06">
                            {rowsError ? "Couldn't load Milvexian documents." : "No documents match the current filters."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-2.5 border-t border-jj-gray-01">
                <div className="flex items-center gap-2 text-[11.5px] font-johnson-text text-jj-gray-06 tabular-nums">
                  <Icon src={infoIcon} tint="ink" className="w-3.5 h-3.5" />
                  {total.toLocaleString()} rows
                  <select
                    value={pageSize}
                    onChange={e => setPageSize(Number(e.target.value))}
                    disabled={rowsLoading}
                    className="ml-2 border border-jj-gray-03 rounded-lg px-2 py-1 font-johnson-text"
                  >
                    {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}/page</option>)}
                  </select>
                </div>
                <Pager page={page} totalPages={totalPages} loading={rowsLoading} onGo={setPage} />
              </div>
            </div>
          </div>
        </div>
      )}

      <DetailModal record={detailRow} onClose={() => setDetailRow(null)} />
      <SqlModal modal={sqlModal} onClose={() => setSqlModal(null)} />
    </div>
  );
}


/* ============================== RIM Facility Index dashboard ============================== */
// Backed by /api/fda/facility-index/* (vector_embedding.rimdocs_facility_index_unified,
// ~74M rows) - AI-extracted facility records (name, address, responsibility,
// confidence) pulled out of RIM documents. Every column is shown except the
// raw embedding vector itself (hundreds/thousands of floats - not something
// anyone reads), shown instead as its dimension count. City and State are
// pulled out of address_json as their own derived filters - "what state is
// this facility in" is a real business question this table can answer.

const FACILITY_PLACEBO_COLORS = { YES: "#8c3bbb", NO: "#0f68b2", "(UNSPECIFIED)": "#6e6259" };

const FACILITY_TABLE_COLUMNS = [
  { key: "facility_name", label: "Facility name", sortCol: "facility_name", bold: true, minWidth: 240 },
  { key: "city", label: "City", minWidth: 140 },
  { key: "state", label: "State", minWidth: 130 },
  { key: "address_full", label: "Address", sortCol: "address_full", minWidth: 300 },
  { key: "address_json", label: "Address JSON", minWidth: 260 },
  { key: "responsibility", label: "Responsibility", sortCol: "responsibility", minWidth: 240 },
  { key: "confidence", label: "Confidence", sortCol: "confidence", minWidth: 100 },
  { key: "model_confidence", label: "Model confidence", sortCol: "model_confidence", minWidth: 130 },
  { key: "rule_confidence", label: "Rule confidence", sortCol: "rule_confidence", minWidth: 130 },
  { key: "placebo_label", label: "Placebo?", sortCol: "placebo_label", minWidth: 90 },
  { key: "status", label: "Status", sortCol: "status", minWidth: 100 },
  { key: "evidence", label: "Evidence", minWidth: 300 },
  { key: "file_name", label: "Source file", sortCol: "file_name", minWidth: 220 },
  { key: "mime_type", label: "MIME type", sortCol: "mime_type", minWidth: 100 },
  { key: "nas_path", label: "NAS path", sortCol: "nas_path", minWidth: 320 },
  { key: "doc_sha256", label: "Document hash", sortCol: "doc_sha256", minWidth: 220 },
  { key: "raw_content", label: "Raw content", sortCol: "raw_content", minWidth: 320 },
  { key: "embedding_dims", label: "Embedding dims", sortCol: "embedding_dims", minWidth: 120 },
  { key: "method_version", label: "Method version", sortCol: "method_version", minWidth: 130 },
  { key: "processed_at", label: "Processed at", sortCol: "processed_at", minWidth: 170 },
  { key: "extracted_at", label: "Extracted at", sortCol: "extracted_at", minWidth: 170 },
];

const FACILITY_ALL_COLUMNS = [
  "id", "file_name", "mime_type", "nas_path", "raw_content", "status",
  "processed_at", "doc_sha256", "facility_name", "address_full", "address_json", "responsibility",
  "evidence", "model_confidence", "rule_confidence", "confidence", "placebo_label",
  "method_version", "extracted_at", "city", "state", "embedding_dims",
];

function FacilityPlaceboPill({ value }) {
  const key = String(value || "").toUpperCase();
  const color = FACILITY_PLACEBO_COLORS[key] || "#6e6259";
  return (
    <span
      className="inline-flex items-center gap-[5px] text-[11px] font-johnson-text font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap capitalize"
      style={{ background: `${color}17`, color }}
    >
      <span className="w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: color }} />
      {value || "Unknown"}
    </span>
  );
}

function FacilityIndexExplorer({ logInPage, activeTab, onBusyChange }) {
  /* ---------- Dashboard ---------- */
  const [summary, setSummary] = useState(null);
  const [facilitiesChart, setFacilitiesChart] = useState([]);
  const [responsibilityChart, setResponsibilityChart] = useState([]);
  const [placeboChart, setPlaceboChart] = useState([]);
  const [citiesChart, setCitiesChart] = useState([]);
  const [confidenceBandChart, setConfidenceBandChart] = useState([]);
  const [chartsLoading, setChartsLoading] = useState(true);
  const [chartsError, setChartsError] = useState(null);
  const [cardErrors, setCardErrors] = useState({});
  const [facilitiesSql, setFacilitiesSql] = useState("");
  const [responsibilitySql, setResponsibilitySql] = useState("");
  const [placeboSql, setPlaceboSql] = useState("");
  const [citiesSql, setCitiesSql] = useState("");
  const [confidenceBandSql, setConfidenceBandSql] = useState("");
  const [sqlModal, setSqlModal] = useState(null);
  const openSqlModal = (payload) => setSqlModal(payload);

  const loadDashboard = useCallback(() => {
    setChartsLoading(true);
    setChartsError(null);
    Promise.allSettled([
      fetchJson(`${API_BASE_URL}/api/fda/facility-index/summary`),
      fetchJson(`${API_BASE_URL}/api/fda/facility-index/charts/top-facilities?limit=12`),
      fetchJson(`${API_BASE_URL}/api/fda/facility-index/charts/responsibility?limit=12`),
      fetchJson(`${API_BASE_URL}/api/fda/facility-index/charts/placebo-label`),
      fetchJson(`${API_BASE_URL}/api/fda/facility-index/charts/top-cities?limit=12`),
      fetchJson(`${API_BASE_URL}/api/fda/facility-index/charts/confidence-band`),
    ]).then(([summaryRes, facilitiesRes, responsibilityRes, placeboRes, citiesRes, confidenceRes]) => {
      const errors = {};
      if (summaryRes.status === "fulfilled") setSummary(summaryRes.value);
      else errors.summary = summaryRes.reason?.message || "Failed to load summary";

      if (facilitiesRes.status === "fulfilled") { setFacilitiesChart(facilitiesRes.value.rows || []); setFacilitiesSql(facilitiesRes.value.sql || ""); }
      else errors.facilities = facilitiesRes.reason?.message || "Failed to load chart";

      if (responsibilityRes.status === "fulfilled") { setResponsibilityChart(responsibilityRes.value.rows || []); setResponsibilitySql(responsibilityRes.value.sql || ""); }
      else errors.responsibility = responsibilityRes.reason?.message || "Failed to load chart";

      if (placeboRes.status === "fulfilled") { setPlaceboChart(placeboRes.value.rows || []); setPlaceboSql(placeboRes.value.sql || ""); }
      else errors.placebo = placeboRes.reason?.message || "Failed to load chart";

      if (citiesRes.status === "fulfilled") { setCitiesChart(citiesRes.value.rows || []); setCitiesSql(citiesRes.value.sql || ""); }
      else errors.cities = citiesRes.reason?.message || "Failed to load chart";

      if (confidenceRes.status === "fulfilled") { setConfidenceBandChart(confidenceRes.value.rows || []); setConfidenceBandSql(confidenceRes.value.sql || ""); }
      else errors.confidence = confidenceRes.reason?.message || "Failed to load chart";

      setCardErrors(errors);
      if (summaryRes.status === "rejected" && Object.keys(errors).length === 6) {
        setChartsError(errors.summary);
      }
      setChartsLoading(false);
    });
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const placeboFallbackIdx = useRef({ i: 0 });
  const placeboSegments = useMemo(() => {
    const sum = placeboChart.reduce((a, r) => a + (r.count || 0), 0);
    if (!sum) return { segments: [], total: 0 };
    placeboFallbackIdx.current.i = 0;
    const sorted = [...placeboChart].sort((a, b) => b.count - a.count);
    return {
      total: sum,
      segments: sorted.map(r => ({
        status: r.label === "(unspecified)" ? "Unspecified" : r.label.charAt(0) + r.label.slice(1).toLowerCase(),
        color: FACILITY_PLACEBO_COLORS[String(r.label || "").toUpperCase()] || FALLBACK_COLORS[placeboFallbackIdx.current.i++ % FALLBACK_COLORS.length],
        frac: r.count / sum,
        count: r.count,
      })),
    };
  }, [placeboChart]);

  const facilityBars = useMemo(() => facilitiesChart.map(r => ({ area: r.facility_name, count: r.count })), [facilitiesChart]);
  const responsibilityBars = useMemo(() => responsibilityChart.map(r => ({ area: r.responsibility, count: r.count })), [responsibilityChart]);
  const cityBars = useMemo(() => citiesChart.map(r => ({ area: r.city, count: r.count })), [citiesChart]);
  const confidenceBars = useMemo(() => confidenceBandChart.map(r => ({ area: r.band, count: r.count })), [confidenceBandChart]);

  /* ---------- Data table ---------- */
  const [filters, setFilters] = useState({});
  const [searchFacilityName, setSearchFacilityName] = useState("");
  const [searchAddress, setSearchAddress] = useState("");
  const [searchFileName, setSearchFileName] = useState("");
  const [searchDocSha, setSearchDocSha] = useState("");
  const [searchNasPath, setSearchNasPath] = useState("");
  const [searchRawContent, setSearchRawContent] = useState("");
  const debouncedFacilityName = useDebounced(searchFacilityName);
  const debouncedAddress = useDebounced(searchAddress);
  const debouncedFileName = useDebounced(searchFileName);
  const debouncedDocSha = useDebounced(searchDocSha);
  const debouncedNasPath = useDebounced(searchNasPath);
  const debouncedRawContent = useDebounced(searchRawContent);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortCol, setSortCol] = useState("processed_at");
  const [sortDir, setSortDir] = useState("desc");

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState(null);
  const [dataSql, setDataSql] = useState("");

  const [facets, setFacets] = useState({});
  const [facetsLoading, setFacetsLoading] = useState(true);

  const [detailRow, setDetailRow] = useState(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const filtersParam = useMemo(() => {
    const parts = Object.entries(filters)
      .filter(([, vals]) => vals && vals.length > 0)
      .map(([col, vals]) => `${col}:${vals.join("||")}`);
    return parts.join(",");
  }, [filters]);
  const activeFilterCount = Object.values(filters).reduce((n, vals) => n + (vals?.length || 0), 0);

  useEffect(() => {
    setPage(1);
  }, [filtersParam, debouncedFacilityName, debouncedAddress, debouncedFileName, debouncedDocSha, debouncedNasPath, debouncedRawContent, pageSize]);

  useEffect(() => {
    const controller = new AbortController();
    setFacetsLoading(true);
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    const qs = params.toString() ? `?${params.toString()}` : "";
    fetchJson(`${API_BASE_URL}/api/fda/facility-index/facets${qs}`, { signal: controller.signal })
      .then(data => { setFacets(data); setFacetsLoading(false); })
      .catch(() => setFacetsLoading(false));
    return () => controller.abort();
  }, [filtersParam]);

  const buildDataQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    if (debouncedFacilityName) params.set("search_facility_name", debouncedFacilityName);
    if (debouncedAddress) params.set("search_address_full", debouncedAddress);
    if (debouncedFileName) params.set("search_file_name", debouncedFileName);
    if (debouncedDocSha) params.set("search_doc_sha256", debouncedDocSha);
    if (debouncedNasPath) params.set("search_nas_path", debouncedNasPath);
    if (debouncedRawContent) params.set("search_raw_content", debouncedRawContent);
    params.set("sort_col", sortCol);
    params.set("sort_dir", sortDir);
    return params;
  }, [filtersParam, debouncedFacilityName, debouncedAddress, debouncedFileName, debouncedDocSha, debouncedNasPath, debouncedRawContent, sortCol, sortDir]);

  useEffect(() => {
    const controller = new AbortController();
    setRowsLoading(true);
    setRowsError(null);
    const params = buildDataQuery();
    params.set("page", String(page));
    params.set("page_size", String(pageSize));
    fetchJson(`${API_BASE_URL}/api/fda/facility-index/data?${params.toString()}`, { signal: controller.signal })
      .then(data => {
        setRows(data.rows || []);
        setTotal(data.total || 0);
        setTotalPages(data.total_pages || 1);
        setDataSql(data.sql || "");
        setRowsLoading(false);
      })
      .catch(e => {
        if (e.name === "AbortError") return;
        setRowsError(e.message || "Failed to load facility records");
        setRowsLoading(false);
      });
    return () => controller.abort();
  }, [buildDataQuery, page, pageSize]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  };

  const cellFor = (row, col) => {
    if (col === "confidence" || col === "model_confidence" || col === "rule_confidence") {
      return row[col] != null ? `${Math.round(Number(row[col]) * 100)}%` : "—";
    }
    if (col === "processed_at") return row.processed_at ? formatEasternTimestamp(row.processed_at) : "—";
    if (col === "extracted_at") return row.extracted_at ? formatEasternTimestamp(row.extracted_at) : "—";
    const raw = row[col];
    if (raw != null && typeof raw === "object") return JSON.stringify(raw);
    return raw ?? "—";
  };

  const downloadPageCsv = () => {
    logInPage("export_page", `Downloaded current page (${rows.length} rows) of facility records`);
    downloadClientCsv("fda_rim_facility_index_page.csv", FACILITY_ALL_COLUMNS, rows);
  };

  const downloadAllCsv = async () => {
    setDownloadingAll(true);
    logInPage("export_all", `Downloaded all ${total.toLocaleString()} matching facility records`);
    try {
      const params = buildDataQuery();
      await downloadFile(`/api/fda/facility-index/data/download?${params.toString()}`, "fda_rim_facility_index.csv");
    } catch (e) {
      setRowsError(e.message || "Download failed");
    } finally {
      setDownloadingAll(false);
    }
  };

  const busy = chartsLoading || rowsLoading;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const facilityTableCardRef = useRef(null);
  const [facilityFullscreen, setFacilityFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setFacilityFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  const toggleFacilityFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else facilityTableCardRef.current?.requestFullscreen?.();
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ============ DASHBOARD ============ */}
      {activeTab === "explore" && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-5 flex flex-col gap-3.5 min-h-full">
            {chartsError && <ErrorBanner message={`Couldn't load the RIM facility index dashboard: ${chartsError}`} onRetry={loadDashboard} />}
            {!chartsError && !chartsLoading && Object.keys(cardErrors).length > 0 && (
              <div className="px-4 py-2.5 rounded-xl bg-jj-gray-01 border border-jj-gray-02 text-xs font-johnson-text text-jj-gray-07">
                Some cards couldn't load ({Object.keys(cardErrors).length} of 6).
              </div>
            )}

            {/* KPI band */}
            <div className="flex items-center justify-between flex-shrink-0">
              <span />
              {summary?.sql && (
                <button onClick={() => openSqlModal({ title: "KPI summary", sql: summary.sql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
              )}
            </div>
            <div className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Facility records</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.total_records) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">extracted from RIM documents</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Distinct facilities</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_facilities) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">unique facilities named</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Source documents</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_documents) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">distinct RIM documents behind these records</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Avg. confidence</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary?.avg_confidence != null ? `${summary.avg_confidence}%` : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">across all extracted records</div>
              </div>
            </div>

            {/* Placebo split + confidence bands */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Placebo-related records</div>
                  {placeboSql && <button onClick={() => openSqlModal({ title: "Placebo-related records", sql: placeboSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">share of records flagged as placebo-related</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.placebo ? (
                  <CardUnavailable message={cardErrors.placebo} onRetry={loadDashboard} />
                ) : placeboSegments.segments.length ? (
                  <div className="flex items-center gap-5">
                    <StatusDonut segments={placeboSegments.segments} headerLabel="Placebo-related" />
                    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                      {placeboSegments.segments.map(s => (
                        <div key={s.status} className="flex items-center gap-2 text-[11.5px] font-johnson-text">
                          <span className="w-2 h-2 rounded-[2px] flex-shrink-0" style={{ background: s.color }} />
                          <span className="text-jj-gray-08 truncate flex-1">{s.status}</span>
                          <span className="text-jj-gray-06 tabular-nums">{Math.round(s.frac * 100)}%</span>
                          <span className="text-jj-gray-08 font-medium tabular-nums w-12 text-right">{formatCompact(s.count)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : <NoData />}
              </Card>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Extraction confidence</div>
                  {confidenceBandSql && <button onClick={() => openSqlModal({ title: "Extraction confidence", sql: confidenceBandSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">how much of the extraction is high-confidence vs. needs review</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.confidence ? (
                  <CardUnavailable message={cardErrors.confidence} onRetry={loadDashboard} />
                ) : confidenceBars.length ? (
                  <RankedBars data={confidenceBars} />
                ) : <NoData />}
              </Card>
            </div>

            {/* Top facilities + top cities */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Most-mentioned facilities</div>
                  {facilitiesSql && <button onClick={() => openSqlModal({ title: "Most-mentioned facilities", sql: facilitiesSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">facilities appearing in the most extracted records</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.facilities ? (
                  <CardUnavailable message={cardErrors.facilities} onRetry={loadDashboard} />
                ) : facilityBars.length ? (
                  <RankedBars data={facilityBars} />
                ) : <NoData />}
              </Card>
              <Card className="px-5 py-4 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Top cities</div>
                  {citiesSql && <button onClick={() => openSqlModal({ title: "Top cities", sql: citiesSql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">where facility activity concentrates geographically</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.cities ? (
                  <CardUnavailable message={cardErrors.cities} onRetry={loadDashboard} />
                ) : cityBars.length ? (
                  <RankedBars data={cityBars} />
                ) : <NoData />}
              </Card>
            </div>

            {/* Responsibility - full width */}
            <Card className="px-5 py-4 flex-shrink-0">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Facility responsibility</div>
                {responsibilitySql && <button onClick={() => openSqlModal({ title: "Facility responsibility", sql: responsibilitySql })} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>}
              </div>
              <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">what each facility is responsible for (manufacture, testing, packaging, release)</div>
              {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.responsibility ? (
                <CardUnavailable message={cardErrors.responsibility} onRetry={loadDashboard} />
              ) : responsibilityBars.length ? (
                <RankedBars data={responsibilityBars} />
              ) : <NoData />}
            </Card>
          </div>
        </div>
      )}

      {/* ============ DATA TABLE ============ */}
      {activeTab === "table" && (
        <div className="flex-1 min-h-0 flex">
          {/* Filter rail */}
          <div className="w-[252px] flex-shrink-0 bg-white border-r border-jj-gray-02 flex flex-col overflow-hidden">
            <div className="px-[18px] pt-4 pb-3 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2 text-[13px] font-johnson-text font-bold text-jj-gray-08">
                <Icon src={filterIcon} tint="ink" className="w-[13px] h-[13px]" />
                Refine
                {activeFilterCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium">
                    {activeFilterCount}
                  </span>
                )}
              </div>
              <button onClick={() => setFilters({})} disabled={activeFilterCount === 0} className="text-[11px] font-johnson-text text-jj-blue-03 disabled:opacity-40">
                Clear all
              </button>
            </div>
            <div className="flex-shrink-0 overflow-y-auto px-[18px] pb-3.5 space-y-2 border-b border-jj-gray-01" style={{ maxHeight: "50%" }}>
              {[
                { value: searchFacilityName, set: setSearchFacilityName, ph: "Facility name contains…" },
                { value: searchAddress, set: setSearchAddress, ph: "Address contains…" },
                { value: searchFileName, set: setSearchFileName, ph: "Source file contains…" },
                { value: searchDocSha, set: setSearchDocSha, ph: "Document hash contains…" },
                { value: searchNasPath, set: setSearchNasPath, ph: "NAS path contains…" },
                { value: searchRawContent, set: setSearchRawContent, ph: "Raw content contains…" },
              ].map(({ value, set, ph }) => (
                <div key={ph} className="relative">
                  <Icon src={searchIcon} tint="gray" className="w-[13px] h-[13px] absolute left-2.5 top-[9px]" />
                  <input
                    value={value}
                    onChange={e => set(e.target.value)}
                    placeholder={ph}
                    className="w-full pl-8 pr-2 py-2 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
                  />
                </div>
              ))}
              <div className="text-[10px] font-johnson-text text-jj-gray-06">Applies after you stop typing.</div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <FdaFacetGroup
                label="Status"
                column="status"
                selected={filters.status || []}
                onChange={vals => setFilters(prev => ({ ...prev, status: vals }))}
                options={facets.status || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Placebo?"
                column="placebo_label"
                selected={filters.placebo_label || []}
                onChange={vals => setFilters(prev => ({ ...prev, placebo_label: vals }))}
                options={facets.placebo_label || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="Responsibility"
                column="responsibility"
                selected={filters.responsibility || []}
                onChange={vals => setFilters(prev => ({ ...prev, responsibility: vals }))}
                options={facets.responsibility || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="MIME type"
                column="mime_type"
                selected={filters.mime_type || []}
                onChange={vals => setFilters(prev => ({ ...prev, mime_type: vals }))}
                options={facets.mime_type || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="City"
                column="city"
                selected={filters.city || []}
                onChange={vals => setFilters(prev => ({ ...prev, city: vals }))}
                options={facets.city || []}
                loading={facetsLoading}
              />
              <FdaFacetGroup
                label="State"
                column="state"
                selected={filters.state || []}
                onChange={vals => setFilters(prev => ({ ...prev, state: vals }))}
                options={facets.state || []}
                loading={facetsLoading}
              />
            </div>
          </div>

          {/* Main content */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-5 gap-0">
            {rowsError && <ErrorBanner message={rowsError} onRetry={() => setPage(p => p)} />}
            <div ref={facilityTableCardRef} className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-3 border-b border-jj-gray-01">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                  Matching records <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{total.toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-2.5">
                  {dataSql && (
                    <button onClick={() => openSqlModal({ title: "Data table (current page)", sql: dataSql })} className="text-[11px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
                  )}
                  <button
                    onClick={downloadPageCsv}
                    disabled={rowsLoading || rows.length === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Downloads the current page only"
                  >
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    Download page
                  </button>
                  <button
                    onClick={downloadAllCsv}
                    disabled={rowsLoading || downloadingAll || total === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Streams every matching row as CSV - no row cap"
                  >
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />
                    {downloadingAll ? "Preparing…" : `Download all (${total.toLocaleString()})`}
                  </button>
                  <button
                    onClick={toggleFacilityFullscreen}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
                    title={facilityFullscreen ? "Exit full screen" : "View the table full screen"}
                  >
                    {facilityFullscreen ? "⤳ Exit full screen" : "⛶ Full screen"}
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 relative">
                {rowsLoading && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10">
                    <LoadingSpinner />
                  </div>
                )}
                <div className="h-full overflow-auto">
                  <table className="text-[12px] font-johnson-text border-collapse" style={{ width: "max-content", minWidth: "100%" }}>
                    <thead className="sticky top-0 z-[5]">
                      <tr className="bg-jj-gray-01 text-jj-gray-07 text-[11px] uppercase tracking-wider">
                        {FACILITY_TABLE_COLUMNS.map(col => (
                          <th
                            key={col.key}
                            onClick={() => col.sortCol && toggleSort(col.sortCol)}
                            style={{ minWidth: col.minWidth }}
                            className={`text-left px-3 py-2.5 font-bold select-none whitespace-nowrap ${col.sortCol ? "cursor-pointer" : ""}`}
                          >
                            {col.label} {col.sortCol && sortCol === col.sortCol ? (sortDir === "asc" ? "▲" : "▼") : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr
                          key={row.id ?? i}
                          onClick={() => {
                            logInPage("row_detail_view", `Opened facility detail for ${row.facility_name || "row " + i}`);
                            setDetailRow(row);
                          }}
                          className="border-t border-jj-gray-01 hover:bg-jj-gray-01/50 cursor-pointer"
                        >
                          {FACILITY_TABLE_COLUMNS.map(col => (
                            <td
                              key={col.key}
                              style={{ minWidth: col.minWidth, maxWidth: col.minWidth * 2 }}
                              className={`px-3 py-2 truncate ${col.bold ? "font-medium text-jj-gray-08" : "text-jj-gray-07"}`}
                              title={typeof cellFor(row, col.key) === "string" ? cellFor(row, col.key) : undefined}
                            >
                              {col.key === "placebo_label" && row.placebo_label ? <FacilityPlaceboPill value={row.placebo_label} /> : cellFor(row, col.key)}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {!rowsLoading && rows.length === 0 && (
                        <tr>
                          <td colSpan={FACILITY_TABLE_COLUMNS.length} className="px-3 py-8 text-center text-jj-gray-06">
                            {rowsError ? "Couldn't load facility records." : "No records match the current filters."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-2.5 border-t border-jj-gray-01">
                <div className="flex items-center gap-2 text-[11.5px] font-johnson-text text-jj-gray-06 tabular-nums">
                  <Icon src={infoIcon} tint="ink" className="w-3.5 h-3.5" />
                  {total.toLocaleString()} rows
                  <select
                    value={pageSize}
                    onChange={e => setPageSize(Number(e.target.value))}
                    disabled={rowsLoading}
                    className="ml-2 border border-jj-gray-03 rounded-lg px-2 py-1 font-johnson-text"
                  >
                    {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}/page</option>)}
                  </select>
                </div>
                <Pager page={page} totalPages={totalPages} loading={rowsLoading} onGo={setPage} />
              </div>
            </div>
          </div>
        </div>
      )}

      <DetailModal record={detailRow} onClose={() => setDetailRow(null)} />
      <SqlModal modal={sqlModal} onClose={() => setSqlModal(null)} />
    </div>
  );
}