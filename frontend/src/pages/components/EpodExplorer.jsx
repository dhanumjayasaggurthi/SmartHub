import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import LoadingSpinner from './LoadingSpinner';
import { apiFetch, downloadFile } from '../../utils/apiClient';

import downloadIcon from "/icons/JJ_Icon_Download_PDF_RGB.svg";
import chevronDownIcon from "/icons/JJ_Icon_Chevron_Down.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import infoIcon from "/icons/JJ_Icon_Info_RGB.svg";
import closeIcon from "/icons/JJ_Icon_Close.svg";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// Self-contained sibling of PostgresQueryRunner.jsx - same pattern: this
// file owns its own small copies of the generic UI primitives it needs
// (Icon, Card, Pager, DetailModal, the dependency-free charts, etc.) rather
// than importing them from Unstructured.jsx, so it can be dropped into any
// page. It relies on the SVG tint filters (#jj-red-tint etc.) that
// Unstructured.jsx's <IconDefs /> already renders once at the page level.

const TINTS = {
  red: "url(#jj-red-tint)",
  ink: "url(#jj-ink-tint)",
  gray: "url(#jj-gray-tint)",
  white: "url(#jj-white-tint)",
};
const Icon = ({ src, alt = "", className = "w-4 h-4", tint = "red" }) => (
  <img src={src} alt={alt} className={className} style={tint ? { filter: TINTS[tint] } : undefined} />
);

const FALLBACK_COLORS = ["#ff6017", "#8c3bbb", "#004685", "#9e0000", "#3b5a0d"];

/* ============================== shared helpers (mirrors Unstructured.jsx) ============================== */

function useElementWidth() {
  const [width, setWidth] = useState(0);
  const observerRef = useRef(null);
  const setRef = useCallback((el) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (el) {
      const ro = new ResizeObserver(entries => {
        const w = entries[0]?.contentRect?.width;
        if (w != null) setWidth(w);
      });
      ro.observe(el);
      observerRef.current = ro;
      setWidth(el.clientWidth);
    } else {
      setWidth(0);
    }
  }, []);
  return [width, setRef];
}

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

function formatTimeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return formatEasternTimestamp(ts);
}

async function fetchJson(url, opts) {
  // apiFetch attaches the bearer token and accepts a full URL or a bare path.
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
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-jj-gray-02 sticky top-0 bg-white">
          <h3 className="font-johnson-display font-bold text-lg text-jj-gray-08">Record detail</h3>
          <button onClick={onClose}><Icon src={closeIcon} alt="Close" tint="ink" className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-0">
          {Object.entries(record).map(([k, v]) => (
            <div key={k} className="flex text-xs font-johnson-text border-b border-jj-gray-01 py-2.5">
              <div className="w-1/3 text-jj-gray-06 flex-shrink-0">{k}</div>
              <div className="w-2/3 text-jj-gray-08 break-words">{v === null || v === undefined || v === '' ? <span className="italic text-jj-gray-05">null</span> : cellDisplayText(v)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================== dependency-free charts (mirrors Unstructured.jsx) ============================== */

const ChartSkeleton = ({ height = 240 }) => (
  <div style={{ height }} className="flex items-center justify-center">
    <LoadingSpinner />
  </div>
);

const NoData = () => (
  <div className="text-xs font-johnson-text text-jj-gray-06 py-10 text-center">No data for current filters.</div>
);

// Shown inside a card whose endpoint failed while the others loaded fine
// (e.g. a backend that doesn't serve this chart yet).
const CardUnavailable = ({ message, onRetry }) => (
  <div className="py-9 px-3 text-center">
    <div className="text-xs font-johnson-text text-jj-maroon-05 mb-1.5 break-words">{message}</div>
    <button onClick={onRetry} className="text-xs font-johnson-text text-jj-blue-03 underline">Retry</button>
  </div>
);

function useChartTip() {
  const [tip, setTip] = useState(null); // { x, y, rows }
  const show = (e, rows) => setTip({ x: e.clientX, y: e.clientY, rows });
  const hide = () => setTip(null);
  const node = tip ? (
    <div
      className="fixed z-[60] pointer-events-none rounded-lg bg-jj-gray-08 text-white shadow-xl px-3 py-2"
      style={{
        left: Math.min(tip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 220),
        // rough height guess (header + rows, ~20px each) so the tooltip
        // flips above the cursor instead of running off the bottom edge
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

function RankedBars({ data }) {
  const tip = useChartTip();
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div className="flex flex-col gap-2">
      {data.map(d => (
        <div
          key={d.area}
          className="cursor-default rounded hover:bg-jj-gray-01/60"
          onMouseMove={(e) => tip.show(e, [
            { label: d.area, header: true },
            { label: 'Records', value: d.count, color: '#0f68b2' },
          ])}
          onMouseLeave={tip.hide}
        >
          <div className="flex justify-between text-[11px] font-johnson-text mb-[3px]">
            <span className="text-jj-gray-08 truncate pr-2">{d.area}</span>
            <span className="text-jj-gray-08 tabular-nums flex-shrink-0">{formatCompact(d.count)}</span>
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

function periodLabel(iso, granularity) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  if (granularity === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (granularity === 'hour') {
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', timeZone: 'UTC' })}`;
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function TrendLine({ data, granularity = 'month', height = 240 }) {
  const tip = useChartTip();
  const [containerWidth, containerRef] = useElementWidth();
  const [hoverIdx, setHoverIdx] = useState(null);
  const h = height;
  const padL = 46, padR = 28, padT = 16, padB = 26;
  // Every point gets a fixed minimum width so its label never has to fight
  // its neighbors for room - hour labels ("Jun 19, 8 AM") need more room
  // than day/week/month ones, so the floor is wider for hour granularity.
  // Once there are more points than fit at that width, the chart just gets
  // wider than the card and the wrapper below scrolls horizontally instead
  // of thinning labels or squeezing points together.
  //
  // That width is capped, though: at Hour granularity across a long date
  // range there can be thousands of points, and minStepX * thousands would
  // make an SVG hundreds of thousands of pixels wide - past what browsers
  // reliably paint (it renders corrupted/squished until something forces a
  // full re-layout, which is why switching granularity or reloading "fixed"
  // it). MAX_CHART_WIDTH keeps the chart in territory every browser handles
  // cleanly; label thinning (below) only ever kicks in once we're actually
  // up against that cap.
  const MAX_CHART_WIDTH = 12000;
  const minStepX = granularity === 'hour' ? 88 : 68;
  const contentPlotW = Math.min(MAX_CHART_WIDTH - padL - padR, Math.max(1, data.length - 1) * minStepX);
  const w = Math.max(containerWidth, padL + padR + contentPlotW);
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const max = Math.max(...data.map(d => d.count), 1);
  // Round the axis ceiling up to a clean step (like the 0/500/1K/1.5K/2K
  // reference) instead of using the raw max as the top gridline.
  const niceMax = (() => {
    const rough = max / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rough || 1)));
    const norm = rough / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    return step * 4;
  })();
  const stepX = data.length > 1 ? plotW / (data.length - 1) : 0;
  const points = data.map((d, i) => ({
    x: padL + i * stepX,
    y: padT + plotH - (d.count / niceMax) * plotH,
    ...d,
  }));
  // Every point gets its own label at the target minStepX spacing. The only
  // time that's not achievable is when MAX_CHART_WIDTH above capped the
  // chart (an extreme point count, mainly Hour granularity over a long
  // range) - in that one case, fall back to thinning labels so they don't
  // overlap, since the chart itself can't grow any wider to fit them all.
  const labelEvery = stepX < minStepX - 1 ? Math.max(1, Math.ceil(minStepX / stepX)) : 1;
  // Gentle Catmull-Rom -> cubic-Bezier smoothing so the line reads as a trend,
  // not a jagged EKG - falls back to a straight segment between any two
  // points that isn't part of a fuller run (start/end of the series).
  const linePath = points.reduce((path, p, i) => {
    if (i === 0) return `M${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    const p0 = points[i - 2] || points[i - 1];
    const p1 = points[i - 1];
    const p2 = p;
    const p3 = points[i + 1] || p;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    return `${path} C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }, '');
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${padT + plotH} L${points[0].x.toFixed(1)},${padT + plotH} Z`;
  const RED = '#d13c2e';
  const hovered = hoverIdx != null ? points[hoverIdx] : null;
  const scrollable = w > containerWidth;
  return (
    <div ref={containerRef} className="w-full">
      {containerWidth > 0 && (
      <div className={scrollable ? 'overflow-x-auto pb-1' : undefined}>
      <svg
        width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}
        onMouseLeave={() => { setHoverIdx(null); tip.hide(); }}
      >
        <defs>
          <linearGradient id="trendAreaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={RED} stopOpacity="0.16" />
            <stop offset="100%" stopColor={RED} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map(f => (
          <g key={f}>
            <line x1={padL} x2={w - padR} y1={padT + plotH * (1 - f)} y2={padT + plotH * (1 - f)} stroke="#eceae7" strokeWidth="1" />
            <text x={padL - 10} y={padT + plotH * (1 - f) + 4} textAnchor="end" className="fill-jj-gray-06" style={{ font: '11px "Johnson Text", sans-serif' }}>
              {f === 0 ? '0' : formatCompact(niceMax * f)}
            </text>
          </g>
        ))}
        <path d={areaPath} fill="url(#trendAreaFill)" stroke="none" />
        {hovered && (
          <line x1={hovered.x} x2={hovered.x} y1={padT} y2={padT + plotH} stroke={RED} strokeWidth="1" strokeDasharray="3 3" opacity="0.35" />
        )}
        <path
          d={linePath} fill="none" stroke={RED} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"
          style={{ filter: 'drop-shadow(0 1px 1px rgba(209,60,46,0.15))' }}
        />
        {points.map((p, i) => (
          <g key={i}>
            {/* Wide invisible hit target - the visible dot alone is too small
                to hover reliably, especially with many points packed together. */}
            <rect
              x={p.x - stepX / 2} y={padT} width={Math.max(stepX, 4)} height={plotH} fill="transparent"
              className="cursor-default"
              onMouseMove={(e) => {
                setHoverIdx(i);
                tip.show(e, [
                  { label: periodLabel(p.period, granularity), header: true },
                  { label: 'Documents', value: p.count, color: RED },
                ]);
              }}
            />
            <circle
              cx={p.x} cy={p.y} r={hoverIdx === i ? 6 : data.length > 60 ? 2.5 : 4.5}
              fill={RED} stroke="white" strokeWidth={hoverIdx === i ? 2 : 1.5}
              style={{ transition: 'r 0.1s ease, stroke-width 0.1s ease' }}
              pointerEvents="none"
            />
            {/* Every point gets its own label at normal ranges - labelEvery
                only thins them out when MAX_CHART_WIDTH capped the chart. */}
            {i % labelEvery === 0 && (
              <text
                x={p.x} y={h - 6}
                textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
                className="fill-jj-gray-06" style={{ font: '10.5px "Johnson Text", sans-serif' }}
              >
                {periodLabel(p.period, granularity)}
              </text>
            )}
          </g>
        ))}
      </svg>
      </div>
      )}
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
        <Icon src={alertIcon} className="w-4 h-4" />
        {message}
      </div>
      <button onClick={onRetry} className="underline flex-shrink-0">Retry</button>
    </div>
  );
}

/* ============================== filter rail ============================== */

function epodFacetValueLabel(column, value) {
  if (value === null || value === undefined) return '(blank)';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function EpodFacetGroup({ label, column, selected, onChange, options, loading }) {
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
        <Icon src={open ? chevronDownIcon : chevronRightIcon} tint="gray" className="w-2.5 h-2.5 flex-shrink-0" />
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
                    {epodFacetValueLabel(column, value)}
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


/* ============================== EPOD tab ============================== */
// EPOD chunks come from Postgres (regulatory.epod_extracts_core.doc_chunks),
// not Snowflake, so this is a self-contained explorer with its own two
// sub-tabs - Explore (aggregate charts across the whole table) and Data
// table (filterable/sortable/paginated grid over doc_chunks) - same shape
// as the RimDocs Explore/Data table tabs above, backed by /api/epod/*.

const CHUNK_LEVEL_COLORS = { section: "#0f68b2", split: "#ff6017", page: "#328714" };
const CONTENT_TYPE_COLORS = { text: "#0f68b2", table: "#328714", chart: "#8c3bbb", image: "#ff6017" };
const INGESTION_STATUS_COLORS = { SUCCESS: "#328714", FAILED: "#eb1700", ERROR: "#eb1700", PENDING: "#0f68b2", RETRY: "#8c3bbb" };

// 45900 -> "44.8 KB", 1250000000 -> "1.16 GB" - file_size is bytes.
function formatBytes(n) {
  if (n == null || isNaN(n)) return null;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let val = Math.abs(n);
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  const sign = n < 0 ? "-" : "";
  return `${sign}${val.toFixed(i === 0 ? 0 : 2).replace(/\.00$/, "")} ${units[i]}`;
}

function EpodLevelPill({ value }) {
  const color = CHUNK_LEVEL_COLORS[String(value || "").toLowerCase()] || "#6e6259";
  return (
    <span
      className="inline-flex items-center gap-[5px] text-[11px] font-johnson-text font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap"
      style={{ background: `${color}17`, color }}
    >
      <span className="w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: color }} />
      {value || "Unspecified"}
    </span>
  );
}

function IngestionStatusPill({ value }) {
  const key = String(value || "").toUpperCase();
  const color = INGESTION_STATUS_COLORS[key] || "#6e6259";
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

// Same ranked-bars visual as RankedBars, but labeled/tooltipped in bytes -
// for the largest-documents-by-file-size card, where formatCompact's plain
// number would read as a meaningless raw byte count.
function SizeBars({ data }) {
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
            { label: "Size", value: 0, color: "#0f68b2" },
          ])}
          onMouseLeave={tip.hide}
        >
          <div className="flex justify-between text-[11px] font-johnson-text mb-[3px]">
            <span className="text-jj-gray-08 truncate pr-2">{d.area}</span>
            <span className="text-jj-gray-08 tabular-nums flex-shrink-0">{formatBytes(d.count)}</span>
          </div>
          <div className="h-[9px] rounded bg-jj-gray-01">
            <div className="h-full rounded" style={{ width: `${(d.count / max) * 100}%`, background: "linear-gradient(90deg,#0f68b2,#004685)" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function formatContentTypes(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.map(v => String(v).charAt(0).toUpperCase() + String(v).slice(1)).join(", ");
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

// Every column /api/epod/data returns, in table order. The API has always
// sent all of these - the grid just used to render ten of them. chunk_text
// and content_types carry no sortCol because ordering a text body or a
// text[] server-side isn't meaningful.
const EPOD_TABLE_COLUMNS = [
  { key: "file_name", label: "File name", sortCol: "file_name", bold: true, minWidth: 230 },
  { key: "doc_id", label: "Doc ID", sortCol: "doc_id", minWidth: 150 },
  { key: "chunk_id", label: "Chunk ID", sortCol: "chunk_id", minWidth: 150 },
  { key: "file_path", label: "File path", sortCol: "file_path", minWidth: 300 },
  { key: "section_title", label: "Section", sortCol: "section_title", minWidth: 220 },
  { key: "chunk_level", label: "Level", sortCol: "chunk_level", minWidth: 110 },
  { key: "chunk_index", label: "Chunk #", sortCol: "chunk_index", minWidth: 90 },
  { key: "chunk_total", label: "Chunks in doc", sortCol: "chunk_total", minWidth: 120 },
  { key: "page_start", label: "Page start", sortCol: "page_start", minWidth: 100 },
  { key: "page_end", label: "Page end", sortCol: "page_end", minWidth: 100 },
  { key: "content_types", label: "Content", minWidth: 150 },
  { key: "chunk_text", label: "Preview", minWidth: 340 },
  { key: "chunk_vector", label: "Embedding", minWidth: 150 },
  { key: "created_at", label: "Created", sortCol: "created_at", minWidth: 170 },
  { key: "updated_at", label: "Updated", sortCol: "updated_at", minWidth: 170 },
  // ingestion_log columns - null on datasets with no log table.
  { key: "ingestion_status", label: "Ingestion", sortCol: "ingestion_status", minWidth: 130 },
  { key: "ingestion_error_message", label: "Ingestion error", sortCol: "ingestion_error_message", minWidth: 260 },
  { key: "retry_count", label: "Retries", sortCol: "retry_count", minWidth: 90 },
  { key: "doc_file_size", label: "Doc size", sortCol: "doc_file_size", minWidth: 100 },
  { key: "doc_file_hash", label: "Doc hash", sortCol: "doc_file_hash", minWidth: 200 },
  { key: "doc_last_modified", label: "Doc modified", sortCol: "doc_last_modified", minWidth: 170 },
  { key: "doc_ingested_at", label: "Ingested", sortCol: "doc_ingested_at", minWidth: 170 },
  { key: "doc_log_updated_at", label: "Log updated", sortCol: "doc_log_updated_at", minWidth: 170 },
  { key: "log_chunk_count", label: "Log chunks", sortCol: "log_chunk_count", minWidth: 110 },
  { key: "log_pages_total", label: "Log pages", sortCol: "log_pages_total", minWidth: 110 },
];

export default function EpodExplorer({ logInPage, activeTab, onBusyChange, dataset }) {
  /* ---------- Explore (aggregate charts, whole table) ---------- */
  const [summary, setSummary] = useState(null);
  const [chunkLevelChart, setChunkLevelChart] = useState([]);
  const [contentTypesChart, setContentTypesChart] = useState([]);
  const [topDocsChart, setTopDocsChart] = useState([]);
  const [trendChart, setTrendChart] = useState([]);
  const [ingestionStatusChart, setIngestionStatusChart] = useState([]);
  const [largestDocsChart, setLargestDocsChart] = useState([]);
  const [ingestionVolumeChart, setIngestionVolumeChart] = useState([]);
  const [chartsLoading, setChartsLoading] = useState(true);
  const [chartsError, setChartsError] = useState(null);
  const [cardErrors, setCardErrors] = useState({});

  // Every EPOD fetch carries the selected dataset (doc_chunks_<suffix> /
  // ingestion_log_<suffix> pair) as a query param - omitted entirely when
  // null, in which case the backend just uses its own default dataset.
  const dsQuery = useCallback((extra) => {
    const params = new URLSearchParams(extra || {});
    if (dataset) params.set("dataset", dataset);
    const s = params.toString();
    return s ? `?${s}` : "";
  }, [dataset]);

  const loadExplore = useCallback(() => {
    setChartsLoading(true);
    setChartsError(null);
    Promise.allSettled([
      fetchJson(`${API_BASE_URL}/api/epod/summary${dsQuery()}`),
      fetchJson(`${API_BASE_URL}/api/epod/charts/chunk-level${dsQuery()}`),
      fetchJson(`${API_BASE_URL}/api/epod/charts/content-types${dsQuery()}`),
      fetchJson(`${API_BASE_URL}/api/epod/charts/top-documents${dsQuery({ limit: 10 })}`),
      fetchJson(`${API_BASE_URL}/api/epod/charts/chunks-over-time${dsQuery()}`),
      fetchJson(`${API_BASE_URL}/api/epod/charts/ingestion-status${dsQuery()}`),
      fetchJson(`${API_BASE_URL}/api/epod/charts/largest-documents${dsQuery({ limit: 10 })}`),
      fetchJson(`${API_BASE_URL}/api/epod/charts/ingestion-volume-over-time${dsQuery()}`),
    ]).then(([summaryRes, levelRes, typesRes, docsRes, trendRes, ingestStatusRes, largestRes, ingestVolRes]) => {
      const errors = {};
      if (summaryRes.status === "fulfilled") setSummary(summaryRes.value);
      else errors.summary = summaryRes.reason?.message || "Failed to load summary";

      if (levelRes.status === "fulfilled") setChunkLevelChart(levelRes.value.rows || []);
      else errors.level = levelRes.reason?.message || "Failed to load chart";

      if (typesRes.status === "fulfilled") setContentTypesChart(typesRes.value.rows || []);
      else errors.types = typesRes.reason?.message || "Failed to load chart";

      if (docsRes.status === "fulfilled") setTopDocsChart(docsRes.value.rows || []);
      else errors.docs = docsRes.reason?.message || "Failed to load chart";

      if (trendRes.status === "fulfilled") setTrendChart(trendRes.value.rows || []);
      else errors.trend = trendRes.reason?.message || "Failed to load chart";

      if (ingestStatusRes.status === "fulfilled") setIngestionStatusChart(ingestStatusRes.value.rows || []);
      else errors.ingestStatus = ingestStatusRes.reason?.message || "Failed to load chart";

      if (largestRes.status === "fulfilled") setLargestDocsChart(largestRes.value.rows || []);
      else errors.largest = largestRes.reason?.message || "Failed to load chart";

      if (ingestVolRes.status === "fulfilled") setIngestionVolumeChart(ingestVolRes.value.rows || []);
      else errors.ingestVol = ingestVolRes.reason?.message || "Failed to load chart";

      setCardErrors(errors);
      if (summaryRes.status === "rejected" && Object.keys(errors).length === 8) {
        setChartsError(errors.summary);
      }
      setChartsLoading(false);
    });
  }, [dsQuery]);

  useEffect(() => { loadExplore(); }, [loadExplore]);

  const chunkLevelFallbackIdx = useRef({ i: 0 });
  const chunkLevelSegments = useMemo(() => {
    const sum = chunkLevelChart.reduce((a, r) => a + (r.count || 0), 0);
    if (!sum) return { segments: [], total: 0 };
    chunkLevelFallbackIdx.current.i = 0;
    const sorted = [...chunkLevelChart].sort((a, b) => b.count - a.count);
    return {
      total: sum,
      segments: sorted.map(r => ({
        status: r.chunk_level,
        color: CHUNK_LEVEL_COLORS[String(r.chunk_level || "").toLowerCase()] || FALLBACK_COLORS[chunkLevelFallbackIdx.current.i++ % FALLBACK_COLORS.length],
        frac: r.count / sum,
        count: r.count,
      })),
    };
  }, [chunkLevelChart]);

  const ingestionStatusFallbackIdx = useRef({ i: 0 });
  const ingestionStatusSegments = useMemo(() => {
    const sum = ingestionStatusChart.reduce((a, r) => a + (r.count || 0), 0);
    if (!sum) return { segments: [], total: 0 };
    ingestionStatusFallbackIdx.current.i = 0;
    const sorted = [...ingestionStatusChart].sort((a, b) => b.count - a.count);
    return {
      total: sum,
      segments: sorted.map(r => ({
        status: r.status,
        color: INGESTION_STATUS_COLORS[String(r.status || "").toUpperCase()] || FALLBACK_COLORS[ingestionStatusFallbackIdx.current.i++ % FALLBACK_COLORS.length],
        frac: r.count / sum,
        count: r.count,
      })),
    };
  }, [ingestionStatusChart]);

  const contentTypesBars = useMemo(
    () => contentTypesChart.map(r => ({ area: r.content_type, count: r.count })),
    [contentTypesChart]
  );
  const topDocsBars = useMemo(
    () => topDocsChart.map(r => ({ area: r.file_name, count: r.count })),
    [topDocsChart]
  );
  const largestDocsBars = useMemo(
    () => largestDocsChart.map(r => ({ area: r.file_name, count: r.file_size })),
    [largestDocsChart]
  );
  const trendPoints = useMemo(
    () => trendChart.map(r => ({ period: r.period, count: r.count })),
    [trendChart]
  );
  const ingestionVolumePoints = useMemo(
    () => ingestionVolumeChart.map(r => ({ period: r.period, count: r.count })),
    [ingestionVolumeChart]
  );


  /* ---------- Data table ---------- */
  const [filters, setFilters] = useState({});
  const [searchFileName, setSearchFileName] = useState("");
  const [searchSectionTitle, setSearchSectionTitle] = useState("");
  const [searchChunkText, setSearchChunkText] = useState("");
  const [searchDocId, setSearchDocId] = useState("");
  const [searchFilePath, setSearchFilePath] = useState("");
  const [searchChunkId, setSearchChunkId] = useState("");
  const [searchIngestionError, setSearchIngestionError] = useState("");
  const debouncedFileName = useDebounced(searchFileName);
  const debouncedSectionTitle = useDebounced(searchSectionTitle);
  const debouncedChunkText = useDebounced(searchChunkText);
  const debouncedDocId = useDebounced(searchDocId);
  const debouncedFilePath = useDebounced(searchFilePath);
  const debouncedChunkId = useDebounced(searchChunkId);
  const debouncedIngestionError = useDebounced(searchIngestionError);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortCol, setSortCol] = useState("file_name");
  const [sortDir, setSortDir] = useState("asc");

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState(null);

  const [facets, setFacets] = useState({});
  const [facetsLoading, setFacetsLoading] = useState(true);

  const [detailRow, setDetailRow] = useState(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  // Full-screen the table card only (not the whole page), same as the FDA
  // tables. Tracking fullscreenchange rather than our own flag keeps the
  // label right when the user leaves with Esc.
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

  useEffect(() => { setPage(1); }, [filtersParam, debouncedFileName, debouncedSectionTitle, debouncedChunkText,
    debouncedDocId, debouncedFilePath, debouncedChunkId, debouncedIngestionError, pageSize]);

  // Different datasets can have different facet values (or no ingestion_log
  // at all) - clear filters/search/page rather than carrying over
  // selections that may no longer mean anything.
  useEffect(() => {
    setFilters({});
    setSearchFileName("");
    setSearchSectionTitle("");
    setSearchChunkText("");
    setSearchDocId("");
    setPage(1);
  }, [dataset]);

  useEffect(() => {
    const controller = new AbortController();
    setFacetsLoading(true);
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    if (dataset) params.set("dataset", dataset);
    const qs = params.toString() ? `?${params.toString()}` : "";
    fetchJson(`${API_BASE_URL}/api/epod/facets${qs}`, { signal: controller.signal })
      .then(data => { setFacets(data); setFacetsLoading(false); })
      .catch(() => setFacetsLoading(false));
    return () => controller.abort();
  }, [filtersParam, dataset]);

  const buildDataQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (filtersParam) params.set("filters", filtersParam);
    if (debouncedFileName) params.set("search_file_name", debouncedFileName);
    if (debouncedSectionTitle) params.set("search_section_title", debouncedSectionTitle);
    if (debouncedChunkText) params.set("search_chunk_text", debouncedChunkText);
    if (debouncedDocId) params.set("search_doc_id", debouncedDocId);
    if (debouncedFilePath) params.set("search_file_path", debouncedFilePath);
    if (debouncedChunkId) params.set("search_chunk_id", debouncedChunkId);
    if (debouncedIngestionError) params.set("search_ingestion_error_message", debouncedIngestionError);
    if (dataset) params.set("dataset", dataset);
    params.set("sort_col", sortCol);
    params.set("sort_dir", sortDir);
    return params;
  }, [filtersParam, debouncedFileName, debouncedSectionTitle, debouncedChunkText, debouncedDocId,
      debouncedFilePath, debouncedChunkId, debouncedIngestionError, dataset, sortCol, sortDir]);


  useEffect(() => {
    const controller = new AbortController();
    setRowsLoading(true);
    setRowsError(null);
    const params = buildDataQuery();
    params.set("page", String(page));
    params.set("page_size", String(pageSize));
    fetchJson(`${API_BASE_URL}/api/epod/data?${params.toString()}`, { signal: controller.signal })
      .then(data => {
        setRows(data.rows || []);
        setTotal(data.total || 0);
        setTotalPages(data.total_pages || 1);
        setRowsLoading(false);
      })
      .catch(e => {
        if (e.name === "AbortError") return;
        setRowsError(e.message || "Failed to load EPOD chunks");
        setRowsLoading(false);
      });
    return () => controller.abort();
  }, [buildDataQuery, page, pageSize]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  };

  const TIMESTAMP_COLUMNS = ["created_at", "updated_at", "doc_last_modified", "doc_ingested_at", "doc_log_updated_at"];

  const cellFor = (row, col) => {
    if (TIMESTAMP_COLUMNS.includes(col)) {
      return row[col] ? formatEasternTimestamp(row[col]) : "—";
    }
    switch (col) {
      case "content_types":
        return formatContentTypes(row.content_types) || "—";
      case "doc_file_size":
        return row.doc_file_size != null ? formatBytes(row.doc_file_size) : "—";
      case "chunk_text":
        return row.chunk_text || "—";
      case "chunk_vector":
        // The raw pgvector never leaves the server - the API sends its
        // dimension count plus a short prefix, which is what a grid cell can
        // usefully show. Full values live in the detail panel.
        return row.chunk_vector_dims != null
          ? `${Number(row.chunk_vector_dims).toLocaleString()}-dim`
          : "—";
      default: {
        const v = row[col];
        // 0 is a real value for retry_count / chunk_index / page numbers -
        // only null and empty string collapse to the em dash.
        if (v === null || v === undefined || v === "") return "—";
        return String(v);
      }
    }
  };

  const downloadPageCsv = () => {
    logInPage("export_page", `Downloaded current page (${rows.length} rows) of EPOD chunks`);
    downloadClientCsv(
      `epod_${dataset || "default"}_doc_chunks_page.csv`,
      [
        "chunk_id", "doc_id", "file_name", "file_path", "chunk_index", "chunk_total", "chunk_level",
        "section_title", "page_start", "page_end", "content_types", "chunk_text",
        "chunk_vector_dims", "chunk_vector_preview", "created_at", "updated_at",
        "doc_file_size", "doc_file_hash", "doc_last_modified", "doc_ingested_at", "doc_log_updated_at",
        "ingestion_status", "ingestion_error_message", "retry_count", "log_chunk_count", "log_pages_total",
      ],
      rows
    );
  };

  const downloadAllCsv = async () => {
    setDownloadingAll(true);
    logInPage("export_all", `Downloaded all ${total.toLocaleString()} matching EPOD chunks`);
    try {
      const params = buildDataQuery();
      await downloadFile(`/api/epod/data/download?${params.toString()}`, "epod_doc_chunks.csv");
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
      {/* ============ EXPLORE ============ */}
      {activeTab === "explore" && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-5 flex flex-col gap-3.5 min-h-full">
            {chartsError && <ErrorBanner message={`Couldn't load EPOD summary/charts: ${chartsError}`} onRetry={loadExplore} />}
            {!chartsError && !chartsLoading && Object.keys(cardErrors).length > 0 && (
              <div className="px-4 py-2.5 rounded-xl bg-jj-gray-01 border border-jj-gray-02 text-xs font-johnson-text text-jj-gray-07">
                Some cards couldn't load ({Object.keys(cardErrors).length} of 8).
              </div>
            )}
            {!chartsLoading && summary && summary.has_log === false && (
              <div className="px-4 py-2.5 rounded-xl bg-jj-gray-01 border border-jj-gray-02 text-xs font-johnson-text text-jj-gray-07">
                This dataset has no matching ingestion_log table, so size, ingestion status, and retry metrics below aren't available - doc_chunks metrics are shown as normal.
              </div>
            )}

            {/* KPI band - doc_chunks facts */}
            <div className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Total chunks</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.total_chunks) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">doc_chunks rows</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Distinct documents</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.distinct_documents) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">{summary ? `${formatCompact(summary.distinct_files)} distinct files` : "by doc_id"}</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Avg chunks / doc</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? summary.avg_chunks_per_doc : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">total ÷ distinct documents</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Chunks with tables</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.chunks_with_tables) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">content_types ⊇ table</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Chunks with charts</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.chunks_with_charts) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">content_types ⊇ chart</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Last updated</div>
                <div className="font-johnson-display font-bold text-[15px] leading-tight text-jj-gray-08">
                  {chartsLoading && !summary ? "…" : summary?.last_updated ? formatTimeAgo(new Date(summary.last_updated).getTime()) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">max(updated_at)</div>
              </div>
            </div>

            {/* KPI band - ingestion_log facts (document/pipeline level) */}
            <div className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Total ingested size</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary?.total_size_bytes != null ? formatBytes(summary.total_size_bytes) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">ingestion_log.file_size</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Ingestion success rate</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary?.ingestion_success_rate != null ? `${summary.ingestion_success_rate}%` : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">{summary ? `${formatCompact(summary.docs_success)} of ${formatCompact(summary.total_documents_logged)} docs` : "SUCCESS status"}</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Failed / pending</div>
                <div className={`font-johnson-display font-bold text-[26px] leading-none tabular-nums ${summary && (summary.docs_failed || summary.docs_pending) ? "text-jj-red" : "text-jj-gray-08"}`}>
                  {chartsLoading && !summary ? "…" : summary ? `${formatCompact(summary.docs_failed)} / ${formatCompact(summary.docs_pending)}` : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">documents needing attention</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Documents retried</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary ? formatCompact(summary.docs_with_retries) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">retry_count &gt; 0</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Avg pages / doc</div>
                <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">
                  {chartsLoading && !summary ? "…" : summary?.avg_pages_per_doc != null ? summary.avg_pages_per_doc : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">ingestion_log.pages_total</div>
              </div>
              <div className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">Last ingested</div>
                <div className="font-johnson-display font-bold text-[15px] leading-tight text-jj-gray-08">
                  {chartsLoading && !summary ? "…" : summary?.last_ingested_at ? formatTimeAgo(new Date(summary.last_ingested_at).getTime()) : "—"}
                </div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5">max(ingested_at)</div>
              </div>
            </div>

            {/* Charts row 1: chunk level donut + content types */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08 mb-1">Chunk level breakdown</div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">section vs. split vs. page, by chunk_level</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.level ? (
                  <CardUnavailable message={cardErrors.level} onRetry={loadExplore} />
                ) : chunkLevelSegments.segments.length ? (
                  <div className="flex items-center gap-5">
                    <StatusDonut segments={chunkLevelSegments.segments} headerLabel="Chunk Level" />
                    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                      {chunkLevelSegments.segments.map(s => (
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
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08 mb-1">Content types</div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">chunks containing each type, from content_types</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.types ? (
                  <CardUnavailable message={cardErrors.types} onRetry={loadExplore} />
                ) : contentTypesBars.length ? (
                  <RankedBars data={contentTypesBars} />
                ) : <NoData />}
              </Card>
            </div>

            {/* Charts row 2: ingestion status donut + largest documents */}
            <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
              <Card className="px-5 py-4 min-w-0">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08 mb-1">Ingestion status</div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">ingestion_log.status - pipeline health, all logged documents</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.ingestStatus ? (
                  <CardUnavailable message={cardErrors.ingestStatus} onRetry={loadExplore} />
                ) : ingestionStatusSegments.segments.length ? (
                  <div className="flex items-center gap-5">
                    <StatusDonut segments={ingestionStatusSegments.segments} headerLabel="Ingestion Status" />
                    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                      {ingestionStatusSegments.segments.map(s => (
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
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08 mb-1">Largest documents</div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">ingestion_log.file_size, largest first</div>
                {chartsLoading ? <ChartSkeleton height={140} /> : cardErrors.largest ? (
                  <CardUnavailable message={cardErrors.largest} onRetry={loadExplore} />
                ) : largestDocsBars.length ? (
                  <SizeBars data={largestDocsBars} />
                ) : <NoData />}
              </Card>
            </div>

            {/* Top documents by chunk count - full width */}
            <Card className="px-5 py-4 flex-shrink-0">
              <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08 mb-1">Top documents by chunk count</div>
              <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-3">file_name with the most chunks</div>
              {chartsLoading ? <ChartSkeleton /> : cardErrors.docs ? (
                <CardUnavailable message={cardErrors.docs} onRetry={loadExplore} />
              ) : topDocsBars.length ? (
                <RankedBars data={topDocsBars} />
              ) : <NoData />}
            </Card>

            {/* Chunks ingested over time - full width */}
            <Card className="px-5 py-4 flex-shrink-0">
              <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08 mb-1">Chunks ingested over time</div>
              <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">Chunks per day, based on created_at</div>
              {chartsLoading ? <ChartSkeleton /> : cardErrors.trend ? (
                <CardUnavailable message={cardErrors.trend} onRetry={loadExplore} />
              ) : trendPoints.length ? (
                <TrendLine data={trendPoints} granularity="day" />
              ) : <NoData />}
            </Card>

            {/* Documents ingested over time - full width */}
            <Card className="px-5 py-4 flex-shrink-0">
              <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08 mb-1">Documents ingested over time</div>
              <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">Documents per day, based on ingestion_log.ingested_at</div>
              {chartsLoading ? <ChartSkeleton /> : cardErrors.ingestVol ? (
                <CardUnavailable message={cardErrors.ingestVol} onRetry={loadExplore} />
              ) : ingestionVolumePoints.length ? (
                <TrendLine data={ingestionVolumePoints} granularity="day" />
              ) : <NoData />}
            </Card>
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
                value={searchFileName}
                onChange={e => setSearchFileName(e.target.value)}
                placeholder="Search file name…"
                className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
              />
              <input
                value={searchSectionTitle}
                onChange={e => setSearchSectionTitle(e.target.value)}
                placeholder="Search section title…"
                className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
              />
              <input
                value={searchChunkText}
                onChange={e => setSearchChunkText(e.target.value)}
                placeholder="Search chunk text…"
                className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
              />
              <input
                value={searchDocId}
                onChange={e => setSearchDocId(e.target.value)}
                placeholder="Search doc ID…"
                className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
              />
              <input
                value={searchChunkId}
                onChange={e => setSearchChunkId(e.target.value)}
                placeholder="Search chunk ID…"
                className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
              />
              <input
                value={searchFilePath}
                onChange={e => setSearchFilePath(e.target.value)}
                placeholder="Search file path…"
                className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
              />
              {summary?.has_log !== false && (
                <input
                  value={searchIngestionError}
                  onChange={e => setSearchIngestionError(e.target.value)}
                  placeholder="Search ingestion error…"
                  className="w-full px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
                />
              )}
            </div>
            <EpodFacetGroup
              label="Chunk level"
              column="chunk_level"
              selected={filters.chunk_level || []}
              onChange={vals => setFilters(prev => ({ ...prev, chunk_level: vals }))}
              options={facets.chunk_level || []}
              loading={facetsLoading}
            />
            <EpodFacetGroup
              label="Content types"
              column="content_types"
              selected={filters.content_types || []}
              onChange={vals => setFilters(prev => ({ ...prev, content_types: vals }))}
              options={facets.content_types || []}
              loading={facetsLoading}
            />
            {summary?.has_log !== false && (
              <>
                <EpodFacetGroup
                  label="Ingestion status"
                  column="ingestion_status"
                  selected={filters.ingestion_status || []}
                  onChange={vals => setFilters(prev => ({ ...prev, ingestion_status: vals }))}
                  options={facets.ingestion_status || []}
                  loading={facetsLoading}
                />
                <EpodFacetGroup
                  label="Retry count"
                  column="retry_count"
                  selected={filters.retry_count || []}
                  onChange={vals => setFilters(prev => ({ ...prev, retry_count: vals }))}
                  options={facets.retry_count || []}
                  loading={facetsLoading}
                />
              </>
            )}
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
                        {EPOD_TABLE_COLUMNS.map(col => (
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
                          key={row.chunk_id ?? i}
                          onClick={() => {
                            logInPage("row_detail_view", `Opened EPOD chunk detail for ${row.file_name || row.chunk_id || "row " + i}`);
                            setDetailRow(row);
                          }}
                          className="border-t border-jj-gray-01 hover:bg-jj-gray-01/50 cursor-pointer"
                        >
                          {EPOD_TABLE_COLUMNS.map(col => (
                            <td
                              key={col.key}
                              style={{ minWidth: col.minWidth, maxWidth: col.minWidth * 2 }}
                              className={`px-3 py-2 truncate ${col.bold ? "font-medium text-jj-gray-08" : "text-jj-gray-07"}`}
                              title={col.key === "chunk_vector"
                                ? (row.chunk_vector_preview || undefined)
                                : (typeof cellFor(row, col.key) === "string" ? cellFor(row, col.key) : undefined)}
                            >
                              {col.key === "chunk_level" && row.chunk_level ? <EpodLevelPill value={row.chunk_level} />
                                : col.key === "ingestion_status" && row.ingestion_status ? <IngestionStatusPill value={row.ingestion_status} />
                                : cellFor(row, col.key)}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {!rowsLoading && rows.length === 0 && (
                        <tr>
                          <td colSpan={EPOD_TABLE_COLUMNS.length} className="px-3 py-8 text-center text-jj-gray-06">
                            {rowsError ? "Couldn't load chunks." : "No chunks match the current filters."}
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
    </div>
  );
}