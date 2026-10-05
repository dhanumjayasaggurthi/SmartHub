import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import LoadingSpinner from './LoadingSpinner';
import { apiFetch, downloadFile } from '../../utils/apiClient';

import downloadIcon from "/icons/JJ_Icon_Download_PDF_RGB.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import infoIcon from "/icons/JJ_Icon_Info_RGB.svg";
import chevronDownIcon from "/icons/JJ_Icon_Chevron_Down.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import closeIcon from "/icons/JJ_Icon_Close.svg";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// Self-contained sibling of EpodExplorer.jsx - same pattern, own small copies
// of the generic UI primitives, dropped into the Nipo tab. Backed entirely
// by /api/nipo/*, which reads rimdocs_nipo.doc_chunks (~294M chunk rows,
// the only table in that schema - there's no ingestion_log here). Every
// dashboard number below is a document, i.e. chunk rows grouped by
// document_id, not a raw chunk row.

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

// Matches the /api/nipo/data/{id} endpoint's own ceiling.
const CHUNK_FETCH_LIMIT = 500;

function DetailModal({ record, onClose }) {
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!record?.document_id) { setFull(null); return; }
    setLoading(true);
    // 500 is the endpoint's ceiling - fetch the lot rather than a 50-chunk
    // teaser, since this panel is where you come to read the whole document.
    fetchJson(`${API_BASE_URL}/api/nipo/data/${record.document_id}?chunk_limit=${CHUNK_FETCH_LIMIT}`)
      .then(setFull)
      .catch(() => setFull(null))
      .finally(() => setLoading(false));
  }, [record?.document_id]);

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
          <h3 className="font-johnson-display font-bold text-lg text-jj-gray-08">Document detail</h3>
          <button onClick={onClose}><img src={closeIcon} alt="Close" className="w-4 h-4" style={{ filter: 'url(#jj-ink-tint)' }} /></button>
        </div>
        <div className="p-5 space-y-0">
          {Object.entries(record).map(([k, v]) => (
            <div key={k} className="flex text-xs font-johnson-text border-b border-jj-gray-01 py-2.5">
              <div className="w-1/3 text-jj-gray-06 flex-shrink-0">{k}</div>
              <div className="w-2/3 text-jj-gray-08 break-words whitespace-pre-wrap leading-relaxed">{v === null || v === undefined || v === '' ? <span className="italic text-jj-gray-05">null</span> : cellDisplayText(v)}</div>
            </div>
          ))}
        </div>
        <div className="px-5 pb-5">
          <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08 mb-2.5 pt-2">
            Chunks {full ? `(${full.chunks?.length ?? 0} of ${record.chunk_count})` : ""}
            {full && (full.chunks?.length ?? 0) < (record.chunk_count ?? 0) && (
              <span className="ml-2 font-normal text-[11px] text-jj-gray-05">
                capped at {CHUNK_FETCH_LIMIT} per document
              </span>
            )}
          </div>
          {loading && <div className="py-6 flex justify-center"><LoadingSpinner /></div>}
          {!loading && full?.chunks?.length > 0 && (
            <div className="space-y-2">
              {full.chunks.map(c => (
                <div key={c.chunk_id} className="border border-jj-gray-02 rounded-xl px-3.5 py-2.5">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-johnson-text font-bold text-jj-gray-07">Chunk {c.chunk_number}</span>
                    <span className={`text-[10.5px] font-johnson-text ${String(c.embedding_status).toUpperCase() === 'FAILED' ? 'text-jj-red' : 'text-jj-gray-05'}`}>
                      {c.embedding_status || 'unspecified'}{c.embedding_error ? ` — ${c.embedding_error}` : ""}
                    </span>
                  </div>
                  <div className="text-[11.5px] font-johnson-text text-jj-gray-07 leading-relaxed whitespace-pre-wrap break-words">{c.chunk_text || "—"}</div>
                </div>
              ))}
            </div>
          )}
          {!loading && full && full.chunks?.length === 0 && (
            <div className="text-xs font-johnson-text text-jj-gray-06">No chunks found.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================== dependency-free charts (mirrors EpodExplorer.jsx) ============================== */

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
        <img src={alertIcon} className="w-4 h-4" alt="" />
        {message}
      </div>
      <button onClick={onRetry} className="underline flex-shrink-0">Retry</button>
    </div>
  );
}

/* ============================== filter rail ============================== */

function NipoFacetGroup({ label, column, selected, onChange, options, loading }) {
  // Collapsed by default - with several facets the rail is otherwise a wall
  // of checkboxes and the search inputs get pushed off screen. The count
  // badge on the header still shows what's active while collapsed.
  const [open, setOpen] = useState(false);
  const toggleValue = (val) => {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);
  };
  const sorted = [...(options || [])].sort((a, b) => (b.count || 0) - (a.count || 0));
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
        <img
          src={open ? chevronDownIcon : chevronRightIcon}
          alt=""
          className="w-2.5 h-2.5 flex-shrink-0"
          style={{ filter: 'url(#jj-gray-tint)' }}
        />
      </button>
      {open && (
        <div className="px-[18px] pb-3.5">
          {loading && <div className="text-xs font-johnson-text text-jj-gray-06 py-1.5">Loading…</div>}
          {!loading && sorted.length === 0 && (
            <div className="text-xs font-johnson-text text-jj-gray-06 py-1.5">No values found</div>
          )}
          {!loading && sorted.map(({ value, count }) => {
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

const NIPO_TABLE_COLUMNS = [
  { key: "filename", label: "File name", sortCol: "filename", bold: true, minWidth: 230 },
  { key: "title", label: "Title", sortCol: "title", minWidth: 260 },
  { key: "protocol_number", label: "Protocol #", sortCol: "protocol_number", minWidth: 140 },
  { key: "indication", label: "Indication", sortCol: "indication", minWidth: 200 },
  { key: "application_type", label: "Application type", sortCol: "application_type", minWidth: 150 },
  { key: "chunk_count", label: "Chunks", sortCol: "chunk_count", minWidth: 90 },
  { key: "first_created_at", label: "First chunk", sortCol: "first_created_at", minWidth: 170 },
  { key: "last_created_at", label: "Last chunk", sortCol: "last_created_at", minWidth: 170 },
];

const DOC_COLUMNS = [
  "document_id", "filename", "title", "indication", "indication_code",
  "application_type", "application_number", "protocol_number",
  "chunk_count", "first_created_at", "last_created_at",
];

/* ============================== Nipo tab ============================== */
// Backed by /api/nipo/* (rimdocs_nipo.doc_chunks, grouped by document_id) -
// a single dashboard + data table, no dataset picker (unlike EPOD) since
// Nipo is one fixed schema.

export default function NipoExplorer({ logInPage, activeTab, onBusyChange }) {
  /* ---------- Dashboard ---------- */
  const [summary, setSummary] = useState(null);
  const [byIndicationChart, setByIndicationChart] = useState([]);
  const [byApplicationTypeChart, setByApplicationTypeChart] = useState([]);
  const [chartsLoading, setChartsLoading] = useState(true);
  const [chartsError, setChartsError] = useState(null);
  const [cardErrors, setCardErrors] = useState({});

  const loadDashboard = useCallback(() => {
    setChartsLoading(true);
    setChartsError(null);
    Promise.allSettled([
      fetchJson(`${API_BASE_URL}/api/nipo/summary`),
      fetchJson(`${API_BASE_URL}/api/nipo/charts/by-indication?limit=10`),
      fetchJson(`${API_BASE_URL}/api/nipo/charts/by-application-type?limit=10`),
    ]).then(([summaryRes, indicationRes, appTypeRes]) => {
      const errors = {};
      if (summaryRes.status === "fulfilled") setSummary(summaryRes.value);
      else errors.summary = summaryRes.reason?.message || "Failed to load summary";

      if (indicationRes.status === "fulfilled") setByIndicationChart(indicationRes.value.rows || []);
      else errors.indication = indicationRes.reason?.message || "Failed to load chart";

      if (appTypeRes.status === "fulfilled") setByApplicationTypeChart(appTypeRes.value.rows || []);
      else errors.appType = appTypeRes.reason?.message || "Failed to load chart";

      setCardErrors(errors);
      if (summaryRes.status === "rejected" && Object.keys(errors).length === 3) {
        setChartsError(errors.summary);
      }
      setChartsLoading(false);
    });
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const indicationBars = useMemo(() => byIndicationChart.map(r => ({ area: r.indication, count: r.count })), [byIndicationChart]);
  const appTypeBars = useMemo(() => byApplicationTypeChart.map(r => ({ area: r.application_type, count: r.count })), [byApplicationTypeChart]);

  /* ---------- Data table ---------- */
  const [filters, setFilters] = useState({});
  const [searchFilename, setSearchFilename] = useState("");
  const [searchTitle, setSearchTitle] = useState("");
  const [searchProtocolNumber, setSearchProtocolNumber] = useState("");
  const [searchDocumentId, setSearchDocumentId] = useState("");
  const debouncedFilename = useDebounced(searchFilename);
  const debouncedTitle = useDebounced(searchTitle);
  const debouncedProtocolNumber = useDebounced(searchProtocolNumber);
  const debouncedDocumentId = useDebounced(searchDocumentId);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortCol, setSortCol] = useState("last_created_at");
  const [sortDir, setSortDir] = useState("desc");

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState(null);

  const [facets, setFacets] = useState({});
  const [facetsLoading, setFacetsLoading] = useState(true);

  const [detailRow, setDetailRow] = useState(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  // Full-screen the table card only (not the whole page). Listening to
  // fullscreenchange instead of tracking our own flag keeps the button label
  // correct when the user leaves with Esc.
  const tableCardRef = useRef(null);
  const [tableFullscreen, setTableFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setTableFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  const toggleTableFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else tableCardRef.current?.requestFullscreen?.();
  };

  const filtersParam = useMemo(() => {
    const parts = Object.entries(filters)
      .filter(([, vals]) => vals && vals.length > 0)
      .map(([col, vals]) => `${col}:${vals.join("||")}`);
    return parts.join(",");
  }, [filters]);
  const activeFilterCount = Object.values(filters).reduce((n, vals) => n + (vals?.length || 0), 0);

  useEffect(() => { setPage(1); }, [filtersParam, debouncedFilename, debouncedTitle, debouncedProtocolNumber, debouncedDocumentId, pageSize]);

  useEffect(() => {
    const controller = new AbortController();
    setFacetsLoading(true);
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    const qs = params.toString() ? `?${params.toString()}` : "";
    fetchJson(`${API_BASE_URL}/api/nipo/facets${qs}`, { signal: controller.signal })
      .then(data => { setFacets(data); setFacetsLoading(false); })
      .catch(() => setFacetsLoading(false));
    return () => controller.abort();
  }, [filtersParam]);

  const buildDataQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    if (debouncedFilename) params.set("search_filename", debouncedFilename);
    if (debouncedTitle) params.set("search_title", debouncedTitle);
    if (debouncedProtocolNumber) params.set("search_protocol_number", debouncedProtocolNumber);
    if (debouncedDocumentId) params.set("search_document_id", debouncedDocumentId);
    params.set("sort_col", sortCol);
    params.set("sort_dir", sortDir);
    return params;
  }, [filtersParam, debouncedFilename, debouncedTitle, debouncedProtocolNumber, debouncedDocumentId, sortCol, sortDir]);

  useEffect(() => {
    const controller = new AbortController();
    setRowsLoading(true);
    setRowsError(null);
    const params = buildDataQuery();
    params.set("page", String(page));
    params.set("page_size", String(pageSize));
    fetchJson(`${API_BASE_URL}/api/nipo/data?${params.toString()}`, { signal: controller.signal })
      .then(data => {
        setRows(data.rows || []);
        setTotal(data.total || 0);
        setTotalPages(data.total_pages || 1);
        setRowsLoading(false);
      })
      .catch(e => {
        if (e.name === "AbortError") return;
        setRowsError(e.message || "Failed to load Nipo documents");
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
      case "first_created_at":
        return row.first_created_at ? formatEasternTimestamp(row.first_created_at) : "—";
      case "last_created_at":
        return row.last_created_at ? formatEasternTimestamp(row.last_created_at) : "—";
      default:
        return row[col] ?? "—";
    }
  };

  const downloadPageCsv = () => {
    logInPage("export_page", `Downloaded current page (${rows.length} rows) of Nipo documents`);
    downloadClientCsv("nipo_documents_page.csv", DOC_COLUMNS, rows);
  };

  const downloadAllCsv = async () => {
    setDownloadingAll(true);
    logInPage("export_all", `Downloaded all ${total.toLocaleString()} matching Nipo documents`);
    try {
      const params = buildDataQuery();
      await downloadFile(`/api/nipo/data/download?${params.toString()}`, "nipo_documents.csv");
    } catch (e) {
      setRowsError(e.message || "Download failed");
    } finally {
      setDownloadingAll(false);
    }
  };

  const busy = chartsLoading || rowsLoading;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ============ DASHBOARD ============ */}
      {activeTab === "explore" && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-5 flex flex-col gap-3.5 min-h-full">
            {chartsError && <ErrorBanner message={`Couldn't load Nipo summary/charts: ${chartsError}`} onRetry={loadDashboard} />}
            {!chartsError && !chartsLoading && Object.keys(cardErrors).length > 0 && (
              <div className="px-4 py-2.5 rounded-xl bg-jj-gray-01 border border-jj-gray-02 text-xs font-johnson-text text-jj-gray-07">
                Some cards couldn't load ({Object.keys(cardErrors).length} of 6).
              </div>
            )}

            {/* KPI band */}
            <div className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Total documents</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.total_documents) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">distinct document_id in doc_chunks</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Indications</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_indications) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">distinct indication values</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Protocols</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_protocols) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">distinct protocol_number values</div>
              </div>
            </div>

            {/* By indication + by application type */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08 mb-1">Documents by indication</div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">top 10 indications, by document count</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.indication ? (
                  <CardUnavailable message={cardErrors.indication} onRetry={loadDashboard} />
                ) : indicationBars.length ? (
                  <RankedBars data={indicationBars} />
                ) : <NoData />}
              </Card>
              <Card className="px-5 py-4 min-w-0">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08 mb-1">Documents by application type</div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">top 10 application types, by document count</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.appType ? (
                  <CardUnavailable message={cardErrors.appType} onRetry={loadDashboard} />
                ) : appTypeBars.length ? (
                  <RankedBars data={appTypeBars} />
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
          <div className="w-[260px] flex-shrink-0 bg-white border-r border-jj-gray-02 overflow-y-auto">
            <div className="px-[18px] py-3.5 flex items-center justify-between border-b border-jj-gray-02">
              <span className="text-[12.5px] font-johnson-text font-bold text-jj-gray-08">Filters</span>
              {activeFilterCount > 0 && (
                <button onClick={() => setFilters({})} className="text-[11px] font-johnson-text text-jj-blue-03 underline">
                  Clear all
                </button>
              )}
            </div>
            <div className="px-[18px] py-3.5 space-y-2.5 border-b border-jj-gray-02">
              <input
                value={searchFilename}
                onChange={e => setSearchFilename(e.target.value)}
                placeholder="Search file name…"
                className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
              />
              <input
                value={searchTitle}
                onChange={e => setSearchTitle(e.target.value)}
                placeholder="Search title…"
                className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
              />
              <input
                value={searchProtocolNumber}
                onChange={e => setSearchProtocolNumber(e.target.value)}
                placeholder="Search protocol #…"
                className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
              />
              <input
                value={searchDocumentId}
                onChange={e => setSearchDocumentId(e.target.value)}
                placeholder="Search document ID…"
                className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
              />
            </div>
            <NipoFacetGroup
              label="Indication"
              column="indication"
              selected={filters.indication || []}
              onChange={vals => setFilters(prev => ({ ...prev, indication: vals }))}
              options={facets.indication || []}
              loading={facetsLoading}
            />
            <NipoFacetGroup
              label="Application type"
              column="application_type"
              selected={filters.application_type || []}
              onChange={vals => setFilters(prev => ({ ...prev, application_type: vals }))}
              options={facets.application_type || []}
              loading={facetsLoading}
            />
            <NipoFacetGroup
              label="Embedding status"
              column="embedding_status"
              selected={filters.embedding_status || []}
              onChange={vals => setFilters(prev => ({ ...prev, embedding_status: vals }))}
              options={facets.embedding_status || []}
              loading={facetsLoading}
            />
          </div>

          {/* Main content */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-5 gap-0">
            {rowsError && <ErrorBanner message={rowsError} onRetry={() => setPage(p => p)} />}
            <div ref={tableCardRef} className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-3 border-b border-jj-gray-01">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                  Matching records <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{total.toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <button
                    onClick={downloadPageCsv}
                    disabled={rowsLoading || rows.length === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Downloads the current page only"
                  >
                    <img src={downloadIcon} className="w-3 h-3" alt="" />
                    Download page
                  </button>
                  <button
                    onClick={downloadAllCsv}
                    disabled={rowsLoading || downloadingAll || total === 0}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01"
                    title="Streams every matching document as CSV - no row cap"
                  >
                    <img src={downloadIcon} className="w-3 h-3" alt="" />
                    {downloadingAll ? "Preparing…" : `Download all (${total.toLocaleString()})`}
                  </button>
                  <button
                    onClick={toggleTableFullscreen}
                    className="flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
                    title={tableFullscreen ? "Exit full screen" : "View the table full screen"}
                  >
                    {tableFullscreen ? "⤳ Exit full screen" : "⛶ Full screen"}
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
                        {NIPO_TABLE_COLUMNS.map(col => (
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
                          key={row.document_id ?? i}
                          onClick={() => {
                            logInPage("row_detail_view", `Opened Nipo document detail for ${row.filename || row.document_id || "row " + i}`);
                            setDetailRow(row);
                          }}
                          className="border-t border-jj-gray-01 hover:bg-jj-gray-01/50 cursor-pointer"
                        >
                          {NIPO_TABLE_COLUMNS.map(col => (
                            <td
                              key={col.key}
                              style={{ minWidth: col.minWidth, maxWidth: col.minWidth * 2 }}
                              className={`px-3 py-2 truncate ${col.bold ? "font-medium text-jj-gray-08" : "text-jj-gray-07"}`}
                              title={typeof cellFor(row, col.key) === "string" ? cellFor(row, col.key) : undefined}
                            >
                              {cellFor(row, col.key)}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {!rowsLoading && rows.length === 0 && (
                        <tr>
                          <td colSpan={NIPO_TABLE_COLUMNS.length} className="px-3 py-8 text-center text-jj-gray-06">
                            {rowsError ? "Couldn't load documents." : "No documents match the current filters."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-2.5 border-t border-jj-gray-01">
                <div className="flex items-center gap-2 text-[11.5px] font-johnson-text text-jj-gray-06 tabular-nums">
                  <img src={infoIcon} className="w-3.5 h-3.5" alt="" />
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
    </div>
  );
}