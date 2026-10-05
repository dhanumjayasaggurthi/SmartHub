import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import LoadingSpinner from './LoadingSpinner';
import { apiFetch, downloadFile } from '../../utils/apiClient';

import searchIcon from "/icons/JJ_Icon_Search_RGB.svg";
import filterIcon from "/icons/JJ_Icon_Filter.svg";
import closeIcon from "/icons/JJ_Icon_Close.svg";
import downloadIcon from "/icons/JJ_Icon_Download_PDF_RGB.svg";
import chevronDownIcon from "/icons/JJ_Icon_Chevron_Down.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import infoIcon from "/icons/JJ_Icon_Info_RGB.svg";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// Shared explorer for the chunk-level Snowflake tables (one row per chunk, doc
// fields repeated), so every "document" number is COUNT(DISTINCT DOC_ID).
// Looks like the RimDocs explorer but is self-contained like EpodExplorer - the
// tint filters (#jj-red-tint etc.) come from <IconDefs /> in Unstructured.jsx.

const TINTS = {
  red: "url(#jj-red-tint)",
  ink: "url(#jj-ink-tint)",
  gray: "url(#jj-gray-tint)",
  white: "url(#jj-white-tint)",
};
const Icon = ({ src, alt = "", className = "w-4 h-4", tint = "red" }) => (
  <img src={src} alt={alt} className={className} style={tint ? { filter: TINTS[tint] } : undefined} />
);

/* ============================== config ============================== */

// Column widths / colours shared by every chunk explorer. What each explorer
// shows (filters, charts, table order...) comes in through the `config` prop -
// see ImmbotExplorer.jsx / VirtualRegulatorExplorer.jsx.

const COL_WIDTHS = {
  FILE_NAME: 200, OBJECT_NAME: 280, JJ_NUMBER: 170, JJ_TITLE: 320, DOMAIN: 110, SOURCE: 150,
  A_STATUS: 120, R_VERSION_LABEL: 140, STATUS: 120, R_OBJECT_TYPE: 140, JJ_LEGACY_OBJ_TYPE: 170,
  DOCUMENT_TYPE: 150, VEEVA_TYPE: 140, JJ_SUBMISSION_TYPE: 170, CHUNK_TOTAL: 110, MATCHING_CHUNKS: 150,
  PAGES_TOTAL: 110, FILE_SIZE: 100, INGESTED_AT: 170, UPDATED_AT: 170, LAST_MODIFIED: 170, CREATED_AT: 170,
  OBJ_ID: 160, R_OBJECT_ID: 160, DOC_ID: 220, ORIGINAL_FILE_NAME: 200, FILE_HASH: 220, FILE_PATH: 360,
  CHUNK_INDEX: 100, CHUNK_LEVEL: 110, SECTION_TITLE: 280, PAGE_START: 100, PAGE_END: 100,
  CONTENT_TYPES: 150, CHUNK_TEXT: 420, CHUNK_ID: 220,
  PROTOCOL_ID: 170, GENERIC: 130, PHASE: 80, PRIMARY_INDICATION: 220, INSIGHT_THERAPEUTIC_AREA: 170,
  CODI_MDM: 130, CODI_VTMF: 120, ARTIFACT_NAME: 130, PRIMARY_GROUP: 190, CLINICAL_TRIAL_ID: 170,
  RIMDOCS_PRODUCT_DISPLAY_NAME: 220, INSIGHT_FAMILY_CODE: 150, INSIGHT_FAMILY_NAME: 150,
  TA_TRIAL_INDICATION: 150, PROTOCOL_APPROVED_RIMDOCS: 210, TOM_HISTORICAL: 140, CD_MIGRATED_SOURCE: 170,
  DCTM_OBJ_LINK: 380, CONTENT_LOCATION: 360, R_VERSION_LABEL_VIZ: 220, OBJECT_NAME_VIZ: 280,
  PRODUCT_NAME: 130, EDMS_NUMBER: 160, TITLE: 320, NAME: 280, VERSION_LABEL: 110, MODIFIED: 140,
  MODIFIED_BY: 130, RANKING: 100, S3_PATH: 380,
};
const MIN_COL_WIDTH = 60;
const NUMERIC_COLS = new Set(['CHUNK_TOTAL', 'MATCHING_CHUNKS', 'PAGES_TOTAL', 'FILE_SIZE', 'CHUNK_INDEX', 'PAGE_START', 'PAGE_END', 'PHASE', 'ADAPTOR_JOB_RUN_ID', 'RANKING']);
const TIME_COLS = new Set(['INGESTED_AT', 'UPDATED_AT', 'LAST_MODIFIED', 'CREATED_AT']);

const STATUS_COLORS = { Approved: "#328714", Superseded: "#0f68b2", Withdrawn: "#eb1700", Retired: "#a39992" };
const INGESTION_COLORS = { SUCCESS: "#328714", ERROR: "#ff6017", FAILED: "#ff6017", RUNNING: "#0f68b2", PENDING: "#0f68b2" };
const TRIAL_COLORS = { Active: "#0f68b2", Completed: "#328714", "CSR Completed": "#53ce76", Closed: "#6e6259", Archived: "#a39992" };
const PHASE_COLORS = { 0: "#fbc02d", 1: "#8c3bbb", 2: "#0f68b2", 3: "#328714", 4: "#ff6017" };
const LEVEL_COLORS = { section: "#0f68b2", split: "#ff6017", page: "#328714" };
const CONTENT_COLORS = { text: "#0f68b2", table: "#328714", chart: "#8c3bbb", image: "#ff6017" };
const FALLBACK_COLORS = ["#8c3bbb", "#004685", "#9e0000", "#3b5a0d", "#ff6017", "#53ce76", "#b19beb"];

function colorFrom(map, value, i) {
  const hit = map[value] || map[String(value || '').toUpperCase()] || map[String(value || '').toLowerCase()];
  return hit || FALLBACK_COLORS[i % FALLBACK_COLORS.length];
}

/* ============================== small helpers ============================== */

function useDebounced(value, delay = 400) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

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

function formatCompact(n) {
  if (n == null || isNaN(n)) return n;
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function formatBytes(n) {
  if (n == null || isNaN(n)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let val = Math.abs(n);
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${n < 0 ? '-' : ''}${val.toFixed(i === 0 ? 0 : 2).replace(/\.00$/, '')} ${units[i]}`;
}

function formatEastern(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return String(ts);
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// CONTENT_TYPES is a json array stored as text: ["table", "text"]
function parseContentTypes(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// the view stores some missing values as the text "nan"
function blank(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  return s === '' || s === 'nan';
}

function cellText(v) {
  if (blank(v)) return '';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

async function fetchJson(url) {
  const res = await apiFetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${res.status})`);
  }
  return res.json();
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

/* ============================== shared UI ============================== */

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
      {onRetry && <button onClick={onRetry} className="underline flex-shrink-0">Retry</button>}
    </div>
  );
}

const ChartSkeleton = ({ height = 220 }) => (
  <div style={{ height }} className="flex items-center justify-center"><LoadingSpinner /></div>
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

function Pill({ value, color }) {
  return (
    <span
      className="inline-flex items-center gap-[5px] text-[11px] font-johnson-text font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap"
      style={{ background: `${color}17`, color }}
    >
      <span className="w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: color }} />
      {value}
    </span>
  );
}

function ContentChips({ value }) {
  const types = parseContentTypes(value);
  if (!types.length) return <span className="italic text-jj-gray-05">null</span>;
  return (
    <span className="inline-flex gap-1">
      {types.map(t => (
        <span key={t} className="text-[10.5px] px-1.5 py-[1px] rounded" style={{ background: `${colorFrom(CONTENT_COLORS, t, 0)}14`, color: colorFrom(CONTENT_COLORS, t, 0) }}>
          {t}
        </span>
      ))}
    </span>
  );
}

function renderCell(col, v) {
  if (col === 'CONTENT_TYPES') return <ContentChips value={v} />;
  if (blank(v)) return <span className="italic text-jj-gray-05">null</span>;
  if (col === 'A_STATUS') return <Pill value={v} color={STATUS_COLORS[v] || '#6e6259'} />;
  if (col === 'STATUS') return <Pill value={v} color={INGESTION_COLORS[String(v).toUpperCase()] || '#6e6259'} />;
  if (col === 'CHUNK_LEVEL') return <Pill value={v} color={LEVEL_COLORS[String(v).toLowerCase()] || '#6e6259'} />;
  if (col === 'FILE_SIZE') return formatBytes(Number(v));
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (col === 'CODI_MDM') return <Pill value={v} color={TRIAL_COLORS[v] || '#6e6259'} />;
  if (TIME_COLS.has(col)) return formatEastern(v);
  if (NUMERIC_COLS.has(col)) return Number(v).toLocaleString();
  return cellText(v);
}

// Cursor-following tooltip, same as the other explorers.
function useChartTip() {
  const [tip, setTip] = useState(null);
  const show = (e, rows) => setTip({ x: e.clientX, y: e.clientY, rows });
  const hide = () => setTip(null);
  const node = tip ? (
    <div
      className="fixed z-[60] pointer-events-none rounded-lg bg-jj-gray-08 text-white shadow-xl px-3 py-2"
      style={{
        left: Math.min(tip.x + 14, window.innerWidth - 240),
        top: (() => {
          const est = tip.rows.length * 20 + 16;
          return tip.y + 14 + est > window.innerHeight ? Math.max(8, tip.y - est - 10) : tip.y + 14;
        })(),
      }}
    >
      {tip.rows.map((r, i) => r.header ? (
        <div key={i} className="text-[11px] font-johnson-text font-bold mb-1 whitespace-nowrap">{r.label}</div>
      ) : (
        <div key={i} className="flex items-center gap-2 text-[11px] font-johnson-text whitespace-nowrap leading-relaxed">
          {r.color && <span className="w-2 h-2 rounded-[2px] flex-shrink-0" style={{ background: r.color }} />}
          <span className="text-white/70">{r.label}</span>
          <span className="ml-auto pl-4 tabular-nums">{typeof r.value === 'number' ? r.value.toLocaleString() : r.value}</span>
        </div>
      ))}
    </div>
  ) : null;
  return { show, hide, node };
}

/* ============================== charts ============================== */

function Donut({ segments, title }) {
  const tip = useChartTip();
  const R = 26, C = 2 * Math.PI * R;
  const total = segments.reduce((a, s) => a + s.count, 0);
  const rows = [
    { label: title, header: true },
    ...segments.map(s => ({ label: s.label, value: s.count, color: s.color })),
    { label: 'Total', value: total },
  ];
  let offset = 0;
  return (
    <>
      <svg width="64" height="64" viewBox="0 0 64 64" className="flex-shrink-0 -rotate-90">
        <circle cx="32" cy="32" r={R} fill="none" stroke="#f1efed" strokeWidth="9" />
        {segments.map((s, i) => {
          const dash = total ? (s.count / total) * C : 0;
          const el = (
            <circle key={i} cx="32" cy="32" r={R} fill="none" stroke={s.color} strokeWidth="9"
              strokeDasharray={`${dash} ${C}`} strokeDashoffset={-offset}
              onMouseMove={(e) => tip.show(e, rows)} onMouseLeave={tip.hide} />
          );
          offset += dash;
          return el;
        })}
      </svg>
      {tip.node}
    </>
  );
}

// label column sized to the longest label (11px text, ~6.3px per char)
function fitLabelWidth(labels, max) {
  const longest = Math.max(0, ...labels.map(l => String(l).length));
  return Math.min(max, Math.max(48, Math.ceil(longest * 6.3) + 6));
}

// one row per group, stacked by series. data: [{ label, [series]: n }]
function StackedBars({ data, series, colors, labelWidth: maxLabel = 180, unit = 'Documents', onPick }) {
  const tip = useChartTip();
  const labelWidth = fitLabelWidth(data.map(d => d.label), maxLabel);
  const totals = data.map(row => series.reduce((a, s) => a + (row[s] || 0), 0));
  const max = Math.max(...totals, 1);
  return (
    <div>
      <div className="flex items-center gap-3 flex-wrap text-[10px] font-johnson-text text-jj-gray-07 mb-3">
        {series.map(s => (
          <span key={s} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-[2px] inline-block" style={{ background: colors[s] }} />{s}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {data.map((row, i) => {
          const present = series.filter(s => (row[s] || 0) > 0);
          return (
            <div
              key={row.label}
              onClick={onPick ? () => onPick(row.raw) : undefined}
              className={`flex items-center gap-2.5 rounded hover:bg-jj-gray-01/60 ${onPick ? 'cursor-pointer' : 'cursor-default'}`}
              onMouseMove={(e) => tip.show(e, [
                { label: row.label, header: true },
                ...present.map(s => ({ label: s, value: row[s], color: colors[s] })),
                { label: `Total ${unit.toLowerCase()}`, value: totals[i] },
              ])}
              onMouseLeave={tip.hide}
            >
              <span className="text-left text-[11px] font-johnson-text text-jj-gray-07 flex-shrink-0 truncate" title={row.label} style={{ width: labelWidth }}>{row.label}</span>
              <div className="flex-1 min-w-0">
                <div className="flex h-[15px] rounded overflow-hidden" style={{ width: `${(totals[i] / max) * 100}%`, minWidth: Math.max(8, present.length * 4) }}>
                  {present.map(s => (
                    <div key={s} style={{ flex: `${row[s]} 1 0%`, background: colors[s], minWidth: 4 }} />
                  ))}
                </div>
              </div>
              <span className="w-[42px] text-right text-[11px] font-johnson-text text-jj-gray-08 tabular-nums flex-shrink-0">{formatCompact(totals[i])}</span>
            </div>
          );
        })}
      </div>
      {tip.node}
    </div>
  );
}

// data: [{ label, raw, count, extra?, color? }]
function RankedBars({ data, unit = 'Documents', extraLabel, onPick, compact, labelWidth: maxLabel = 220 }) {
  const tip = useChartTip();
  const labelWidth = fitLabelWidth(data.map(d => d.label), maxLabel);
  const max = Math.max(...data.map(d => d.count), 1);
  if (compact) {
    return (
      <div className="flex flex-col gap-2">
        {data.map(d => (
          <div
            key={d.label}
            onClick={onPick ? () => onPick(d.raw) : undefined}
            className={`flex items-center gap-2.5 rounded hover:bg-jj-gray-01/60 ${onPick ? 'cursor-pointer' : 'cursor-default'}`}
            onMouseMove={(e) => tip.show(e, [
              { label: d.label, header: true },
              { label: unit, value: d.count, color: d.color || '#0f68b2' },
              ...(extraLabel && d.extra != null ? [{ label: extraLabel, value: d.extra }] : []),
            ])}
            onMouseLeave={tip.hide}
          >
            <span className="text-left text-[11px] font-johnson-text text-jj-gray-07 flex-shrink-0 truncate" title={d.label} style={{ width: labelWidth }}>{d.label}</span>
            <div className="flex-1 min-w-0">
              <div className="h-[15px] rounded" style={{ width: `${(d.count / max) * 100}%`, minWidth: 4, background: d.color || 'linear-gradient(90deg,#0f68b2,#004685)' }} />
            </div>
            <span className="w-[42px] text-right text-[11px] font-johnson-text text-jj-gray-08 tabular-nums flex-shrink-0">{formatCompact(d.count)}</span>
          </div>
        ))}
        {tip.node}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {data.map(d => (
        <div
          key={d.label}
          onClick={onPick ? () => onPick(d.raw) : undefined}
          className={`rounded hover:bg-jj-gray-01/60 ${onPick ? 'cursor-pointer' : 'cursor-default'}`}
          onMouseMove={(e) => tip.show(e, [
            { label: d.label, header: true },
            { label: unit, value: d.count, color: d.color || '#0f68b2' },
            ...(extraLabel && d.extra != null ? [{ label: extraLabel, value: d.extra }] : []),
          ])}
          onMouseLeave={tip.hide}
        >
          <div className="flex justify-between text-[11px] font-johnson-text mb-[3px]">
            <span className="text-jj-gray-08 truncate pr-2">{d.label}</span>
            <span className="text-jj-gray-08 tabular-nums flex-shrink-0">{formatCompact(d.count)}</span>
          </div>
          <div className="h-[9px] rounded bg-jj-gray-01">
            <div
              className="h-full rounded"
              style={{ width: `${(d.count / max) * 100}%`, background: d.color || 'linear-gradient(90deg,#0f68b2,#004685)' }}
            />
          </div>
        </div>
      ))}
      {tip.node}
    </div>
  );
}

function ColumnChart({ data, unit = 'Documents' }) {
  const tip = useChartTip();
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div className="flex flex-col">
      <div className="flex items-end gap-2.5 border-b border-jj-gray-02 px-0.5" style={{ height: 170 }}>
        {data.map(d => (
          <div
            key={d.label}
            className="flex-1 h-full flex flex-col items-center justify-end gap-1 min-w-0 cursor-default rounded hover:bg-jj-gray-01/60"
            onMouseMove={(e) => tip.show(e, [{ label: d.label, header: true }, { label: unit, value: d.count, color: '#328714' }])}
            onMouseLeave={tip.hide}
          >
            <span className="text-[9.5px] font-johnson-text text-jj-gray-07 tabular-nums">{formatCompact(d.count)}</span>
            <div className="w-full max-w-[30px] rounded-t-[5px]" style={{ height: `${(d.count / max) * 78}%`, minHeight: 3, background: 'linear-gradient(180deg,#53ce76,#328714)' }} />
          </div>
        ))}
      </div>
      <div className="flex gap-2.5 px-0.5 pt-1.5">
        {data.map(d => (
          <div key={d.label} className="flex-1 text-center text-[9px] font-johnson-text text-jj-gray-06 truncate" title={d.label}>{d.label}</div>
        ))}
      </div>
      {tip.node}
    </div>
  );
}

function TrendLine({ data, granularity, height = 230, unit = 'Documents' }) {
  const tip = useChartTip();
  const [containerWidth, containerRef] = useElementWidth();
  const [hoverIdx, setHoverIdx] = useState(null);
  const padL = 46, padR = 28, padT = 16, padB = 26;
  const minStep = granularity === 'hour' ? 88 : 68;
  const contentW = Math.min(12000 - padL - padR, Math.max(1, data.length - 1) * minStep);
  const w = Math.max(containerWidth, padL + padR + contentW);
  const plotW = w - padL - padR;
  const plotH = height - padT - padB;
  const max = Math.max(...data.map(d => d.count), 1);
  const niceMax = (() => {
    const rough = max / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rough || 1)));
    const norm = rough / mag;
    return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag * 4;
  })();
  const stepX = data.length > 1 ? plotW / (data.length - 1) : 0;
  const pts = data.map((d, i) => ({ ...d, x: padL + (data.length > 1 ? i * stepX : plotW / 2), y: padT + plotH - (d.count / niceMax) * plotH }));
  const labelEvery = stepX && stepX < minStep - 1 ? Math.ceil(minStep / stepX) : 1;
  const line = pts.reduce((path, p, i) => {
    if (i === 0) return `M${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    const p0 = pts[i - 2] || pts[i - 1], p1 = pts[i - 1], p3 = pts[i + 1] || p;
    const c1x = p1.x + (p.x - p0.x) / 6, c1y = p1.y + (p.y - p0.y) / 6;
    const c2x = p.x - (p3.x - p1.x) / 6, c2y = p.y - (p3.y - p1.y) / 6;
    return `${path} C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }, '');
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${padT + plotH} L${pts[0].x.toFixed(1)},${padT + plotH} Z`;
  const RED = '#d13c2e';
  const hovered = hoverIdx != null ? pts[hoverIdx] : null;
  return (
    <div ref={containerRef} className="w-full">
      {containerWidth > 0 && (
        <div className={w > containerWidth ? 'overflow-x-auto pb-1' : undefined}>
          <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} style={{ display: 'block' }}
            onMouseLeave={() => { setHoverIdx(null); tip.hide(); }}>
            <defs>
              <linearGradient id="chunkTrendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={RED} stopOpacity="0.16" />
                <stop offset="100%" stopColor={RED} stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 0.25, 0.5, 0.75, 1].map(f => (
              <g key={f}>
                <line x1={padL} x2={w - padR} y1={padT + plotH * (1 - f)} y2={padT + plotH * (1 - f)} stroke="#eceae7" />
                <text x={padL - 10} y={padT + plotH * (1 - f) + 4} textAnchor="end" className="fill-jj-gray-06" style={{ font: '11px "Johnson Text", sans-serif' }}>
                  {f === 0 ? '0' : formatCompact(niceMax * f)}
                </text>
              </g>
            ))}
            {pts.length > 1 && <path d={area} fill="url(#chunkTrendFill)" />}
            {hovered && <line x1={hovered.x} x2={hovered.x} y1={padT} y2={padT + plotH} stroke={RED} strokeDasharray="3 3" opacity="0.35" />}
            {pts.length > 1 && <path d={line} fill="none" stroke={RED} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
            {pts.map((p, i) => (
              <g key={i}>
                <rect x={p.x - Math.max(stepX, 8) / 2} y={padT} width={Math.max(stepX, 8)} height={plotH} fill="transparent"
                  onMouseMove={(e) => {
                    setHoverIdx(i);
                    tip.show(e, [{ label: periodLabel(p.period, granularity), header: true }, { label: unit, value: p.count, color: RED }]);
                  }} />
                <circle cx={p.x} cy={p.y} r={hoverIdx === i ? 6 : data.length > 60 ? 2.5 : 4.5} fill={RED} stroke="white" strokeWidth="1.5" pointerEvents="none" />
                {i % labelEvery === 0 && (
                  <text x={p.x} y={height - 6} textAnchor={pts.length === 1 ? 'middle' : i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}
                    className="fill-jj-gray-06" style={{ font: '10.5px "Johnson Text", sans-serif' }}>
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

/* ============================== filter rail ============================== */

function FacetGroup({ col, label, selected, onChange, state, onOpen }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // after a Reload wipes the cached values, refetch if this group is open
  useEffect(() => {
    if (open && !state) onOpen(col);
  }, [open, state, col, onOpen]);
  const options = state?.values || [];
  const shown = options.filter(o => String(o.value).toLowerCase().includes(query.toLowerCase()));
  const max = Math.max(1, ...options.map(o => o.count || 0));
  const dot = (v, i) => col === 'A_STATUS' ? colorFrom(STATUS_COLORS, v, i)
    : col === 'STATUS' ? colorFrom(INGESTION_COLORS, v, i)
    : col === 'CHUNK_LEVEL' ? colorFrom(LEVEL_COLORS, v, i)
    : col === 'CONTENT_TYPE' ? colorFrom(CONTENT_COLORS, v, i)
    : col === 'CODI_MDM' ? colorFrom(TRIAL_COLORS, v, i)
    : col === 'PHASE' ? colorFrom(PHASE_COLORS, v, i)
    : '#0f68b2';

  return (
    <div className="border-b border-jj-gray-01 last:border-0">
      <button
        onClick={() => { if (!open) onOpen(col); setOpen(o => !o); }}
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
          {options.length > 8 && (
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Narrow list…"
              className="w-full mb-2 px-2.5 py-1.5 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
            />
          )}
          <div className="max-h-56 overflow-y-auto overflow-x-hidden">
            {state?.loading && <div className="text-xs font-johnson-text text-jj-gray-06 py-1.5">Loading…</div>}
            {state?.error && (
              <div className="py-1.5">
                <div className="text-xs font-johnson-text text-jj-maroon-05 mb-1">Couldn't load values.</div>
                <button onClick={() => onOpen(col, true)} className="text-xs font-johnson-text text-jj-blue-03 underline">Retry</button>
              </div>
            )}
            {state?.values && shown.length === 0 && (
              <div className="text-xs font-johnson-text text-jj-gray-06 py-1.5">No values found</div>
            )}
            {shown.map((o, i) => {
              const val = String(o.value);
              const checked = selected.includes(val);
              const color = dot(val, i);
              return (
                <label key={val} className="flex flex-col gap-1.5 py-2 px-1 -mx-1 rounded cursor-pointer hover:bg-jj-gray-01/60">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onChange(checked ? selected.filter(v => v !== val) : [...selected, val])}
                      className="accent-[#0f68b2] flex-shrink-0"
                    />
                    <span className={`flex-1 truncate text-[12.5px] font-johnson-text ${checked ? 'font-bold' : 'font-medium'} text-jj-gray-08`} title={val}>{val}</span>
                    <span className="text-[11px] font-johnson-text text-jj-gray-06 tabular-nums flex-shrink-0" title="documents">{formatCompact(o.count)}</span>
                  </div>
                  <div className="h-[5px] rounded-full bg-jj-gray-01 ml-[22px]">
                    <div className="h-full rounded-full" style={{ width: `${Math.round((o.count / max) * 100)}%`, background: color }} />
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================== modals / drawer ============================== */

function SqlModal({ modal, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!modal) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(modal.sql || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* text is still selectable */ }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
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
              <pre className="text-xs font-mono bg-jj-gray-08 text-white/90 rounded-xl p-4 overflow-x-auto whitespace-pre-wrap break-words">{modal.sql}</pre>
              <button onClick={copy} className="mt-3 px-3 py-1.5 rounded-full border border-jj-gray-03 text-xs font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01">
                {copied ? 'Copied' : 'Copy SQL'}
              </button>
            </>
          ) : (
            <div className="text-xs font-johnson-text text-jj-gray-06">No query has run yet for this card.</div>
          )}
        </div>
      </div>
    </div>
  );
}


function ChunkText({ api, chunkId }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let alive = true;
    fetchJson(`${api}/chunk?chunk_id=${encodeURIComponent(chunkId)}`)
      .then(d => alive && setState({ text: d.chunk?.CHUNK_TEXT || '' }))
      .catch(e => alive && setState({ error: e.message }));
    return () => { alive = false; };
  }, [api, chunkId]);
  if (state.loading) return <div className="py-3"><LoadingSpinner /></div>;
  if (state.error) return <div className="text-xs text-jj-maroon-05 py-2">{state.error}</div>;
  return (
    <div className="mt-2 text-[12px] leading-relaxed font-johnson-text text-jj-gray-08 whitespace-pre-wrap break-words bg-[#faf9f8] border border-jj-gray-02 rounded-lg p-3 max-h-[360px] overflow-y-auto">
      {state.text || <span className="italic text-jj-gray-05">empty</span>}
    </div>
  );
}

// Right-side panel: document metadata + its chunk outline. Click a chunk to
// pull the full text.
function DocumentDrawer({ api, metaFields, logKey, docId, focusChunkId, onClose, logInPage, allowDistinct, initialDistinct, onDistinctChange }) {
  const [distinct, setDistinct] = useState(!!(allowDistinct && initialDistinct));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(() => new Set(focusChunkId ? [focusChunkId] : []));
  const [q, setQ] = useState('');
  const [showMeta, setShowMeta] = useState(true);

  const load = useCallback(() => {
    setError(null);
    setData(null);
    fetchJson(`${api}/document?doc_id=${encodeURIComponent(docId)}${distinct ? '&distinct_chunks=true' : ''}`)
      .then(setData)
      .catch(e => setError(e.message));
  }, [api, docId, distinct]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const doc = data?.document || {};
  const chunks = data?.chunks || [];
  const needle = q.trim().toLowerCase();
  const shownChunks = needle
    ? chunks.filter(c => `${c.SECTION_TITLE || ''} ${c.PREVIEW || ''}`.toLowerCase().includes(needle))
    : chunks;

  const toggle = (id) => {
    setOpen(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else { next.add(id); logInPage(`${logKey}_chunk_view`, `Opened chunk ${id} in ${doc.FILE_NAME || docId}`); }
      return next;
    });
  };

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="w-full max-w-[640px] h-full bg-white shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex-shrink-0 px-5 py-4 border-b border-jj-gray-02 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10.5px] font-johnson-text uppercase tracking-wider text-jj-gray-06">Document</div>
            <h3 className="font-johnson-display font-bold text-[17px] text-jj-gray-08 break-words">{doc.OBJECT_NAME || doc.FILE_NAME || docId}</h3>
            {doc.JJ_TITLE && <div className="text-xs font-johnson-text text-jj-gray-07 mt-1 break-words">{doc.JJ_TITLE}</div>}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {doc.A_STATUS && <Pill value={doc.A_STATUS} color={STATUS_COLORS[doc.A_STATUS] || '#6e6259'} />}
              {doc.STATUS && <Pill value={doc.STATUS} color={INGESTION_COLORS[String(doc.STATUS).toUpperCase()] || '#6e6259'} />}
              {!blank(doc.PROTOCOL_ID) && <span className="text-[11px] font-johnson-text font-medium text-jj-gray-08">{doc.PROTOCOL_ID}</span>}
              {!blank(doc.GENERIC) && <span className="text-[11px] font-johnson-text text-jj-gray-07">{doc.GENERIC}{doc.PHASE != null ? ` · Phase ${doc.PHASE}` : ''}</span>}
              {doc.FILE_NAME && <span className="text-[11px] font-johnson-text text-jj-gray-05">{doc.FILE_NAME}</span>}
            </div>
          </div>
          <button onClick={onClose} className="flex-shrink-0 p-1"><Icon src={closeIcon} alt="Close" tint="ink" className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && <div className="p-4"><ErrorBanner message={error} onRetry={load} /></div>}
          {!data && !error && <div className="py-16"><LoadingSpinner /></div>}
          {data && (
            <>
              <div className="border-b border-jj-gray-01">
                <button onClick={() => setShowMeta(s => !s)} className="w-full flex items-center gap-2 px-5 py-3 text-[11px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-07 hover:bg-jj-gray-01/50">
                  <Icon src={showMeta ? chevronDownIcon : chevronRightIcon} tint="gray" className="w-2.5 h-2.5" />
                  Metadata
                </button>
                {showMeta && (
                  <div className="px-5 pb-4">
                    {[...metaFields.filter(f => f in doc), ...Object.keys(doc).filter(f => !metaFields.includes(f))].map(f => (
                      <div key={f} className="flex text-xs font-johnson-text border-b border-jj-gray-01 last:border-0 py-2">
                        <div className="w-[38%] text-jj-gray-06 flex-shrink-0">{f}</div>
                        <div className="w-[62%] text-jj-gray-08 break-words">{renderCell(f, doc[f])}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="px-5 pt-4 pb-2 flex items-center justify-between gap-3">
                <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                  Chunks <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{shownChunks.length.toLocaleString()}{needle ? ` of ${chunks.length.toLocaleString()}` : ''}</span>
                </div>
                {allowDistinct && (
                  <label className="flex items-center gap-1.5 text-[11.5px] font-johnson-text text-jj-gray-07 cursor-pointer whitespace-nowrap ml-auto" title="Hide chunks repeated by the metadata join">
                    <input
                      type="checkbox"
                      checked={distinct}
                      onChange={e => {
                        const next = e.target.checked;
                        logInPage(`${logKey}_distinct_chunks`, `${next ? 'Enabled' : 'Disabled'} distinct chunks in document panel`);
                        setDistinct(next);
                        onDistinctChange?.(next);
                      }}
                      className="accent-[#0f68b2]"
                    />
                    Distinct chunks
                  </label>
                )}
                <div className="relative w-[220px]">
                  <Icon src={searchIcon} tint="gray" className="w-3 h-3 absolute left-2.5 top-[9px]" />
                  <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find in sections / text…"
                    className="w-full pl-8 pr-2 py-[7px] text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03" />
                </div>
              </div>
              <div className="px-5 pb-6 flex flex-col gap-2">
                {shownChunks.map(c => {
                  const isOpen = open.has(c.CHUNK_ID);
                  return (
                    <div key={c.CHUNK_ID} className={`border rounded-xl px-3.5 py-2.5 ${isOpen ? 'border-jj-blue-03/50 bg-jj-blue-03/[.03]' : 'border-jj-gray-02'}`}>
                      <button onClick={() => toggle(c.CHUNK_ID)} className="w-full text-left">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10.5px] font-johnson-text text-jj-gray-05 tabular-nums">#{c.CHUNK_INDEX}</span>
                          {c.CHUNK_LEVEL && <Pill value={c.CHUNK_LEVEL} color={LEVEL_COLORS[String(c.CHUNK_LEVEL).toLowerCase()] || '#6e6259'} />}
                          <span className="text-[12.5px] font-johnson-text font-medium text-jj-gray-08 truncate flex-1 min-w-0">{c.SECTION_TITLE || 'Untitled section'}</span>
                          <span className="text-[10.5px] font-johnson-text text-jj-gray-06 tabular-nums flex-shrink-0">
                            p.{c.PAGE_START}{c.PAGE_END != null && c.PAGE_END !== c.PAGE_START ? `–${c.PAGE_END}` : ''}
                          </span>
                          <ContentChips value={c.CONTENT_TYPES} />
                        </div>
                        {!isOpen && c.PREVIEW && (
                          <div className="text-[11.5px] font-johnson-text text-jj-gray-06 mt-1 line-clamp-2">{c.PREVIEW}</div>
                        )}
                      </button>
                      {isOpen && <ChunkText api={api} chunkId={c.CHUNK_ID} />}
                    </div>
                  );
                })}
                {shownChunks.length === 0 && <div className="text-xs font-johnson-text text-jj-gray-06 py-6 text-center">No chunks match.</div>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ============================== breakdown tree ============================== */

function bLabel(v) {
  if (blank(v)) return '(blank)';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v).trim();
}

// flat [a, b, c, docs, chunks] rows -> 3 level tree
function buildTree(rows) {
  const top = new Map();
  let docs = 0, chunks = 0;
  rows.forEach(([a, b, c, d, n]) => {
    docs += d; chunks += n;
    const ka = bLabel(a), kb = bLabel(b);
    if (!top.has(ka)) top.set(ka, { key: ka, label: ka, raw: a, docs: 0, chunks: 0, kids: new Map() });
    const na = top.get(ka);
    na.docs += d; na.chunks += n;
    if (!na.kids.has(kb)) na.kids.set(kb, { key: `${ka}\u0000${kb}`, label: kb, raw: b, docs: 0, chunks: 0, leaves: [] });
    const nb = na.kids.get(kb);
    nb.docs += d; nb.chunks += n;
    nb.leaves.push({ label: bLabel(c), raw: c, docs: d, chunks: n });
  });
  const sort = (arr) => arr.sort((x, y) => (x.label === '(blank)') - (y.label === '(blank)') || y.docs - x.docs);
  return {
    docs, chunks,
    nodes: sort([...top.values()]).map(na => ({ ...na, kids: sort([...na.kids.values()]).map(nb => ({ ...nb, leaves: sort(nb.leaves) })) })),
  };
}

function filterTree(tree, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return tree;
  const hit = (s) => s.toLowerCase().includes(needle);
  const nodes = tree.nodes.map(a => {
    const aHit = hit(a.label);
    const kids = a.kids.map(b => {
      const bHit = hit(b.label);
      const leaves = aHit || bHit ? b.leaves : b.leaves.filter(l => hit(l.label));
      return !aHit && !bHit && !leaves.length ? null : { ...b, leaves };
    }).filter(Boolean);
    return !aHit && !kids.length ? null : { ...a, kids };
  }).filter(Boolean);
  return { ...tree, nodes };
}

function BreakdownTree({ tree, openA, openB, toggleA, toggleB, onDrill }) {
  const grid = { gridTemplateColumns: 'minmax(0,1fr) 150px 100px 100px 80px' };
  const drill = (path, title) => (
    <button
      onClick={(e) => { e.stopPropagation(); onDrill(path); }}
      title={title}
      className="opacity-0 group-hover:opacity-100 text-[10.5px] font-johnson-text text-jj-blue-03 underline transition-opacity"
    >
      View docs
    </button>
  );
  return (
    <div className="font-johnson-text">
      <div className="grid px-[18px] bg-[#faf9f8] border-b border-jj-gray-01 sticky top-0 z-[5]" style={grid}>
        {['Category', 'Share', 'Documents', 'Chunks', ''].map((h, i) => (
          <div key={i} className={`text-[10.5px] font-bold uppercase tracking-wider text-jj-gray-06 py-2 ${i >= 2 ? 'text-right pl-2' : 'pr-2'}`}>{h}</div>
        ))}
      </div>
      <div className="grid px-[18px] bg-jj-blue-03/[.06] border-b border-jj-gray-01 text-[12.5px] font-bold text-jj-gray-08" style={grid}>
        <div className="py-[9px]">Grand total</div>
        <div />
        <div className="py-[9px] text-right tabular-nums">{tree.docs.toLocaleString()}</div>
        <div className="py-[9px] text-right tabular-nums">{tree.chunks.toLocaleString()}</div>
        <div />
      </div>
      {tree.nodes.map(a => {
        const aOpen = openA.has(a.key);
        const share = tree.docs ? (a.docs / tree.docs) * 100 : 0;
        return (
          <React.Fragment key={a.key}>
            <div onClick={() => toggleA(a.key)} className="group grid px-[18px] border-b border-jj-gray-01/60 text-[12.5px] cursor-pointer hover:bg-[#faf9f8]" style={grid}>
              <div className="py-[9px] pr-2 flex items-center gap-2 font-bold text-jj-gray-08 min-w-0">
                <Icon src={aOpen ? chevronDownIcon : chevronRightIcon} tint="ink" className="w-[9px] h-[9px] flex-shrink-0" />
                <span className="truncate">{a.label}</span>
              </div>
              <div className="py-[9px] px-2 flex items-center">
                <div className="w-full h-[6px] rounded-[3px] bg-jj-gray-01">
                  <div className="h-full rounded-[3px] bg-jj-blue-03" style={{ width: `${share}%` }} />
                </div>
              </div>
              <div className="py-[9px] text-right tabular-nums text-jj-gray-08">{a.docs.toLocaleString()}</div>
              <div className="py-[9px] text-right tabular-nums text-jj-gray-07">{a.chunks.toLocaleString()}</div>
              <div className="py-[9px] flex justify-end">{drill([a.raw], `View documents in "${a.label}"`)}</div>
            </div>
            {aOpen && a.kids.map(b => {
              const bOpen = openB.has(b.key);
              return (
                <React.Fragment key={b.key}>
                  <div onClick={() => toggleB(b.key)} className="group grid px-[18px] border-b border-jj-gray-01/60 text-[12px] cursor-pointer hover:bg-[#faf9f8]" style={grid}>
                    <div className="py-2 pr-2 pl-[26px] flex items-center gap-2 text-jj-gray-08 min-w-0">
                      <Icon src={bOpen ? chevronDownIcon : chevronRightIcon} tint="gray" className="w-2 h-2 flex-shrink-0" />
                      <span className="truncate">{b.label}</span>
                    </div>
                    <div />
                    <div className="py-2 text-right tabular-nums text-jj-gray-08">{b.docs.toLocaleString()}</div>
                    <div className="py-2 text-right tabular-nums text-jj-gray-07">{b.chunks.toLocaleString()}</div>
                    <div className="py-2 flex justify-end">{drill([a.raw, b.raw], `View documents in "${a.label} / ${b.label}"`)}</div>
                  </div>
                  {bOpen && b.leaves.map((l, i) => (
                    <div key={i} onClick={() => onDrill([a.raw, b.raw, l.raw])}
                      className={`group grid px-[18px] border-b border-jj-gray-01/40 text-[11.5px] text-jj-gray-07 hover:bg-jj-blue-03/[.07] cursor-pointer ${i % 2 ? 'bg-[#faf9f8]' : ''}`} style={grid}>
                      <div className="py-[7px] pr-2 pl-[52px] truncate">{l.label}</div>
                      <div />
                      <div className="py-[7px] text-right tabular-nums">{l.docs.toLocaleString()}</div>
                      <div className="py-[7px] text-right tabular-nums">{l.chunks.toLocaleString()}</div>
                      <div className="py-[7px] flex justify-end">{drill([a.raw, b.raw, l.raw], `View documents in "${l.label}"`)}</div>
                    </div>
                  ))}
                </React.Fragment>
              );
            })}
          </React.Fragment>
        );
      })}
      {tree.nodes.length === 0 && <div className="px-3 py-8 text-center text-jj-gray-06 text-xs">No matches.</div>}
    </div>
  );
}

/* ============================== main ============================== */

export default function ChunkExplorer({ config, logInPage, activeTab, onTabChange, onBusyChange, onSynced, canViewSql, reloadKey }) {
  const {
    apiPath, label: LABEL, logKey, filters: FILTERS, searches: SEARCHES,
    docTableOrder: DOC_TABLE_ORDER, chunkTableOrder: CHUNK_TABLE_ORDER, metaFields,
    defaultDimension, defaultLevels, trial = false, compoundPhase: showCompoundPhase = false,
    kpis = ['chunks', 'pages', 'size'], distinctChunks: allowDistinct = false,
    views = null, Drawer = DocumentDrawer,
  } = config;
  const API = `${API_BASE_URL}${apiPath}`;
  const FILTER_LABELS = useMemo(() => Object.fromEntries(FILTERS.map(f => [f.col, f.label])), [FILTERS]);
  const EMPTY_SEARCH = useMemo(() => Object.fromEntries(SEARCHES.map(s => [s.col, ''])), [SEARCHES]);
  // chart dropdown + breakdown pickers. CHUNK_LEVEL isn't a doc-level column so
  // it can't be a breakdown level (backend rejects it too).
  const DIMENSIONS = FILTERS.filter(f => f.col !== 'CONTENT_TYPE');
  const BREAKDOWN_DIMENSIONS = DIMENSIONS.filter(f => f.col !== 'CHUNK_LEVEL');

  /* ---------- filters ---------- */
  const [filters, setFilters] = useState({});
  const [search, setSearch] = useState(EMPTY_SEARCH);
  const debouncedSearch = useDebounced(search);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [facetState, setFacetState] = useState({});

  const scope = useMemo(() => {
    const f = {};
    Object.entries(filters).forEach(([k, v]) => { if (v && v.length) f[k] = v; });
    const s = {};
    Object.entries(debouncedSearch).forEach(([k, v]) => { if (v.trim()) s[k] = v.trim(); });
    return { filters: f, search: s };
  }, [filters, debouncedSearch]);
  const scopeKey = JSON.stringify(scope);

  const scopeParams = useCallback((extra = {}) => {
    const p = new URLSearchParams();
    if (Object.keys(scope.filters).length) p.set('filters', JSON.stringify(scope.filters));
    if (Object.keys(scope.search).length) p.set('search', JSON.stringify(scope.search));
    Object.entries(extra).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
    return p;
  }, [scope]);

  // log search boxes once typing settles
  const lastSearch = useRef(debouncedSearch);
  useEffect(() => {
    const prev = lastSearch.current;
    lastSearch.current = debouncedSearch;
    Object.keys(debouncedSearch).forEach(col => {
      if (prev[col] === debouncedSearch[col]) return;
      if (debouncedSearch[col]) logInPage('filter_add', `${LABEL}: set ${col} search to "${debouncedSearch[col]}"`);
      else logInPage('filter_remove', `${LABEL}: cleared ${col} search`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const setFilterValues = (col, vals) => {
    const prev = filters[col] || [];
    const added = vals.filter(v => !prev.includes(v));
    const removed = prev.filter(v => !vals.includes(v));
    const label = FILTER_LABELS[col] || col;
    if (added.length) logInPage('filter_add', `${LABEL}: added ${label} filter: ${added.join(', ')}`);
    if (removed.length) logInPage('filter_remove', `${LABEL}: removed ${label} filter: ${removed.join(', ')}`);
    setFilters(f => ({ ...f, [col]: vals }));
  };

  // clicking a chart bar adds (or removes) that value as a filter
  const toggleFilterValue = (col, raw) => {
    if (blank(raw)) return;
    const val = String(raw);
    const cur = filters[col] || [];
    setFilterValues(col, cur.includes(val) ? cur.filter(v => v !== val) : [...cur, val]);
  };

  const clearAll = () => {
    logInPage('filter_clear', `${LABEL}: cleared all filters`);
    setFilters({});
    setSearch(EMPTY_SEARCH);
  };

  const activeFilterCount = Object.values(scope.filters).reduce((a, v) => a + v.length, 0) + Object.keys(scope.search).length;

  const chips = [
    ...Object.entries(scope.filters).flatMap(([col, vals]) => vals.map(v => ({
      key: `${col}:${v}`, text: `${FILTER_LABELS[col] || col}: ${v}`,
      onRemove: () => setFilterValues(col, (filters[col] || []).filter(x => x !== v)),
    }))),
    ...Object.entries(scope.search).map(([col, v]) => ({
      key: `s:${col}`, text: `${col} ~ "${v}"`,
      onRemove: () => setSearch(s => ({ ...s, [col]: '' })),
    })),
  ];

  const facetRef = useRef({});
  facetRef.current = facetState;
  const loadFacet = useCallback((col, force = false) => {
    const cur = facetRef.current[col];
    if (!force && (cur?.values || cur?.loading)) return;
    setFacetState(p => ({ ...p, [col]: { loading: true } }));
    fetchJson(`${API}/filter-options?column=${col}`)
      .then(d => setFacetState(p => ({ ...p, [col]: { values: d.values || [] } })))
      .catch(() => setFacetState(p => ({ ...p, [col]: { error: true } })));
  }, [API]);

  /* ---------- load bookkeeping ---------- */
  // Each section remembers what it last loaded so flipping tabs doesn't refetch;
  // a new reloadKey (Reload button) refetches with bypass_cache.
  const loadedKeys = useRef({});
  const usedReload = useRef({});
  const claim = (slot, key) => {
    if (loadedKeys.current[slot] === key) return null;
    loadedKeys.current[slot] = key;
    const bypass = usedReload.current[slot] !== undefined && usedReload.current[slot] !== reloadKey;
    usedReload.current[slot] = reloadKey;
    return { bypass };
  };
  const reqIds = useRef({});
  const nextReq = (slot) => { reqIds.current[slot] = (reqIds.current[slot] || 0) + 1; return reqIds.current[slot]; };
  const isLatest = (slot, id) => reqIds.current[slot] === id;

  // reload also refreshes the facet counts
  useEffect(() => {
    if (reloadKey) setFacetState({});
  }, [reloadKey]);

  /* ---------- explore ---------- */
  const [summary, setSummary] = useState({ loading: false });
  const [charts, setCharts] = useState({});
  const [granularity, setGranularity] = useState('day');
  const [dimension, setDimension] = useState(defaultDimension);

  const loadChart = useCallback(async (name, extra, bypass) => {
    const id = nextReq(`chart-${name}`);
    setCharts(c => ({ ...c, [name]: { ...(c[name] || {}), loading: true, error: null } }));
    try {
      const d = await fetchJson(`${API}/chart/${name}?${scopeParams({ ...extra, bypass_cache: bypass ? 'true' : '' })}`);
      if (isLatest(`chart-${name}`, id)) setCharts(c => ({ ...c, [name]: { rows: d.rows || [], sql: d.sql } }));
    } catch (e) {
      if (isLatest(`chart-${name}`, id)) setCharts(c => ({ ...c, [name]: { rows: [], error: e.message } }));
    }
  }, [API, scopeParams]);

  const loadSummary = useCallback(async (bypass) => {
    const id = nextReq('summary');
    setSummary(s => ({ ...s, loading: true, error: null }));
    try {
      const d = await fetchJson(`${API}/summary?${scopeParams({ bypass_cache: bypass ? 'true' : '' })}`);
      if (isLatest('summary', id)) {
        setSummary({ ...d, loading: false });
        onSynced?.(Date.now());
      }
    } catch (e) {
      if (isLatest('summary', id)) setSummary({ loading: false, error: e.message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeParams]);

  const loadExplore = useCallback((bypass) => {
    loadSummary(bypass);
    const names = ['ingestion-status', 'chunk-level', 'content-types', 'chunks-per-doc'];
    if (trial) names.push('trial-status');
    if (showCompoundPhase) names.push('compound-phase');
    if (!defaultDimension) names.push('top-docs');
    names.forEach(n => loadChart(n, {}, bypass));
  }, [loadSummary, loadChart, trial, showCompoundPhase, defaultDimension]);

  useEffect(() => {
    if (activeTab !== 'explore' || views?.explore) return;
    const c = claim('explore', `${scopeKey}|${reloadKey}`);
    if (c) loadExplore(c.bypass);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, scopeKey, reloadKey]);

  useEffect(() => {
    if (activeTab !== 'explore' || views?.explore) return;
    const c = claim('over-time', `${scopeKey}|${reloadKey}|${granularity}`);
    if (c) loadChart('over-time', { granularity }, c.bypass);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, scopeKey, reloadKey, granularity]);

  useEffect(() => {
    if (activeTab !== 'explore' || !defaultDimension) return;
    const c = claim('by-dimension', `${scopeKey}|${reloadKey}|${dimension}`);
    if (c) loadChart('by-dimension', { dimension }, c.bypass);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, scopeKey, reloadKey, dimension]);

  const chartRows = (name) => charts[name]?.rows || [];

  const ingestionSegments = useMemo(() => chartRows('ingestion-status').map(([status, n], i) => ({
    label: status || '(blank)', count: n, color: colorFrom(INGESTION_COLORS, status, i),
  })), [charts]); // eslint-disable-line react-hooks/exhaustive-deps

  // compound x phase, top 15 compounds by documents
  const compoundPhase = useMemo(() => {
    const rows = chartRows('compound-phase');
    const phaseName = (p) => (blank(p) ? 'No phase' : `Phase ${p}`);
    const series = [...new Set(rows.map(r => phaseName(r[1])))].sort((a, b) => (a === 'No phase') - (b === 'No phase') || a.localeCompare(b));
    const byCompound = new Map();
    rows.forEach(([cmp, ph, n]) => {
      const k = bLabel(cmp);
      if (!byCompound.has(k)) byCompound.set(k, { label: k, raw: cmp });
      const row = byCompound.get(k);
      row[phaseName(ph)] = (row[phaseName(ph)] || 0) + n;
    });
    const total = (r) => series.reduce((t, s) => t + (r[s] || 0), 0);
    const data = [...byCompound.values()].sort((a, b) => total(b) - total(a)).slice(0, 15);
    const colors = Object.fromEntries(series.map((s, i) => [s, s === 'No phase' ? '#a39992' : colorFrom(PHASE_COLORS, s.replace('Phase ', ''), i)]));
    return { data, series, colors };
  }, [charts]); // eslint-disable-line react-hooks/exhaustive-deps

  const trialSegments = useMemo(() => chartRows('trial-status').map(([v, n], i) => ({
    label: bLabel(v), raw: v, count: n, color: colorFrom(TRIAL_COLORS, v, i),
  })), [charts]); // eslint-disable-line react-hooks/exhaustive-deps

  const colorBars = (name, map) => chartRows(name).map(([v, n], i) => ({ label: bLabel(v), raw: v, count: n, color: colorFrom(map, v, i) }));

  const docs = summary.documents;
  const successPct = docs ? Math.round(((summary.success_documents || 0) / docs) * 1000) / 10 : null;

  const [sqlModal, setSqlModal] = useState(null);
  const openSql = (title, sql) => {
    logInPage('sql_view', `${LABEL}: viewed SQL for "${title}"`);
    setSqlModal({ title, sql });
  };
  const SqlLink = ({ title, sql }) => canViewSql && sql ? (
    <button onClick={() => openSql(title, sql)} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline">SQL</button>
  ) : null;

  const chartBody = (name, render, height) => {
    const c = charts[name];
    if (!c || c.loading) return <ChartSkeleton height={height} />;
    if (c.error) return <CardUnavailable message={c.error} onRetry={() => loadChart(name, name === 'over-time' ? { granularity } : name === 'by-dimension' ? { dimension } : {}, false)} />;
    if (!c.rows.length) return <NoData />;
    return render(c.rows);
  };

  /* ---------- data table ---------- */
  const [mode, setMode] = useState('documents');
  const [sortCol, setSortCol] = useState('FILE_NAME');
  const [sortAsc, setSortAsc] = useState(true);
  const [pageSize, setPageSize] = useState(50);
  // Distinct chunks only touches chunk lists (Chunks table + document panel),
  // never documents, KPIs or charts.
  const [distinctChunks, setDistinctChunks] = useState(true); // on by default wherever the option exists
  const useDistinct = allowDistinct && distinctChunks && mode === 'chunks';
  const tableBaseKey = `${scopeKey}|${mode}|${sortCol}|${sortAsc}|${pageSize}|${useDistinct}`;
  // page resets to 1 whenever anything but the page itself changes
  const [pageState, setPageState] = useState({ key: tableBaseKey, page: 1 });
  const page = pageState.key === tableBaseKey ? pageState.page : 1;
  const [table, setTable] = useState({ columns: [], rows: [], total_count: 0, total_pages: 1, loading: false });
  const [colWidths, setColWidths] = useState({});
  const [dataScrollWidth, dataScrollRef] = useElementWidth();
  const [drawer, setDrawer] = useState(null); // { docId, chunkId? }

  const loadTable = useCallback(async (bypass) => {
    const id = nextReq('table');
    setTable(t => ({ ...t, loading: true, error: null }));
    try {
      const d = await fetchJson(`${API}/rows?${scopeParams({
        mode, page, page_size: pageSize, sort_col: sortCol, sort_dir: sortAsc ? 'asc' : 'desc',
        distinct_chunks: useDistinct ? 'true' : '',
        bypass_cache: bypass ? 'true' : '',
      })}`);
      if (isLatest('table', id)) {
        setTable({ ...d, loading: false });
        onSynced?.(Date.now());
      }
    } catch (e) {
      if (isLatest('table', id)) setTable(t => ({ ...t, rows: [], loading: false, error: e.message }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeParams, mode, page, pageSize, sortCol, sortAsc, useDistinct]);

  useEffect(() => {
    if (activeTab !== 'table') return;
    const c = claim('table', `${tableBaseKey}|${page}|${reloadKey}`);
    if (c) loadTable(c.bypass);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, tableBaseKey, page, reloadKey]);

  const switchMode = (m) => {
    if (m === mode) return;
    logInPage(`${logKey}_mode_change`, `${LABEL}: data table switched to ${m}`);
    setMode(m);
    const allowed = m === 'documents' ? DOC_TABLE_ORDER : CHUNK_TABLE_ORDER;
    if (!allowed.includes(sortCol) && sortCol !== 'FILE_NAME') { setSortCol('FILE_NAME'); setSortAsc(true); }
  };

  const tableRows = useMemo(
    () => (table.rows || []).map(r => Object.fromEntries(table.columns.map((c, i) => [c, r[i]]))),
    [table.rows, table.columns]
  );
  const visibleCols = useMemo(() => {
    const order = mode === 'documents' ? DOC_TABLE_ORDER : CHUNK_TABLE_ORDER;
    const cols = table.columns || [];
    return [...order.filter(c => cols.includes(c)), ...cols.filter(c => !order.includes(c))];
  }, [table.columns, mode, DOC_TABLE_ORDER, CHUNK_TABLE_ORDER]);
  const colW = (c) => colWidths[c] ?? COL_WIDTHS[c] ?? 150;
  const tableWidth = visibleCols.reduce((a, c) => a + colW(c), 0);

  const handleSort = (col) => {
    const nextAsc = sortCol === col ? !sortAsc : true;
    logInPage('sort_change', `${LABEL}: sorted by ${col} (${nextAsc ? 'asc' : 'desc'})`);
    setSortCol(col);
    setSortAsc(nextAsc);
  };

  const goToPage = (n) => {
    const p = Math.max(1, Math.min(table.total_pages || 1, n));
    if (p !== page) logInPage('pagination', `${LABEL}: went to page ${p}`);
    setPageState({ key: tableBaseKey, page: p });
  };

  const resizeRef = useRef(null);
  const startResize = (e, col) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { col, x: e.clientX, w: colW(col) };
    const move = (ev) => {
      const st = resizeRef.current;
      if (!st) return;
      setColWidths(w => ({ ...w, [st.col]: Math.max(MIN_COL_WIDTH, st.w + ev.clientX - st.x) }));
    };
    const up = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  const downloadPage = () => {
    logInPage('csv_download', `${LABEL}: downloaded ${mode} page ${page} (${tableRows.length} rows)`);
    const esc = (v) => {
      const s = cellText(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [visibleCols.join(','), ...tableRows.map(r => visibleCols.map(c => esc(r[c])).join(','))];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${logKey}_${mode}_page_${page}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const downloadAll = () => {
    logInPage('csv_download', `${LABEL}: downloaded all ${mode} (${table.total_count} rows)`);
    const p = scopeParams({ mode, sort_col: sortCol, sort_dir: sortAsc ? 'asc' : 'desc', distinct_chunks: useDistinct ? 'true' : '' });
    downloadFile(`${apiPath}/rows/download?${p}`, `${logKey}_${mode}.csv`);
  };

  const openRow = (r) => {
    if (!r.DOC_ID) return;
    logInPage('row_detail_view', `${LABEL}: opened ${r.FILE_NAME || r.DOC_ID}${mode === 'chunks' ? ` chunk #${r.CHUNK_INDEX}` : ''}`);
    setDrawer({ docId: r.DOC_ID, chunkId: mode === 'chunks' ? r.CHUNK_ID : null });
  };

  /* ---------- breakdown ---------- */
  const [levels, setLevels] = useState(defaultLevels || []);
  const [breakdown, setBreakdown] = useState({ rows: [], loading: false });
  const [bSearch, setBSearch] = useState('');
  const [openA, setOpenA] = useState(new Set());
  const [openB, setOpenB] = useState(new Set());

  const loadBreakdown = useCallback(async (bypass) => {
    const id = nextReq('breakdown');
    setBreakdown(b => ({ ...b, loading: true, error: null }));
    try {
      const d = await fetchJson(`${API}/breakdown?${scopeParams({ levels: levels.join(','), bypass_cache: bypass ? 'true' : '' })}`);
      if (isLatest('breakdown', id)) setBreakdown({ rows: d.rows || [], sql: d.sql, loading: false });
    } catch (e) {
      if (isLatest('breakdown', id)) setBreakdown({ rows: [], loading: false, error: e.message });
    }
  }, [API, scopeParams, levels]);

  useEffect(() => {
    if (activeTab !== 'breakdown') return;
    const c = claim('breakdown', `${scopeKey}|${levels.join(',')}|${reloadKey}`);
    if (c) loadBreakdown(c.bypass);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, scopeKey, levels, reloadKey]);

  const tree = useMemo(() => buildTree(breakdown.rows), [breakdown.rows]);
  const shownTree = useMemo(() => filterTree(tree, bSearch), [tree, bSearch]);
  const searching = bSearch.trim().length > 0;
  const effOpenA = searching ? new Set(shownTree.nodes.map(n => n.key)) : openA;
  const effOpenB = searching ? new Set(shownTree.nodes.flatMap(n => n.kids.map(k => k.key))) : openB;
  const toggleSet = (setter) => (key) => setter(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const setLevel = (i, col) => {
    const next = [...levels];
    const clash = next.indexOf(col);
    if (clash !== -1) next[clash] = next[i]; // swap so the three stay distinct
    next[i] = col;
    logInPage(`${logKey}_breakdown_levels`, `${LABEL}: breakdown levels ${next.join(' → ')}`);
    setLevels(next);
    setOpenA(new Set());
    setOpenB(new Set());
  };

  const topLeaves = useMemo(() => {
    const m = new Map();
    breakdown.rows.forEach(r => {
      const k = bLabel(r[2]);
      m.set(k, (m.get(k) || 0) + r[3]);
    });
    return [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 15);
  }, [breakdown.rows]);

  // "View docs": filter to that branch and jump to the documents table.
  // (blank) can't be expressed as an IN filter, so that level is skipped.
  const drillDown = (path) => {
    const next = { ...filters };
    path.forEach((raw, i) => { if (!blank(raw)) next[levels[i]] = [String(raw)]; });
    logInPage('breakdown_drilldown', `${LABEL}: drilled into ${path.map(bLabel).join(' / ')}`);
    setFilters(next);
    setMode('documents');
    onTabChange?.('table');
  };

  const exportBreakdown = () => {
    logInPage('csv_download', `${LABEL}: exported breakdown`);
    const esc = (v) => { const s = cellText(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [[...levels, 'DOCUMENTS', 'CHUNKS'].join(','), ...breakdown.rows.map(r => r.map(esc).join(','))];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${logKey}_breakdown.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  /* ---------- custom views ---------- */
  // An explorer can swap in its own screens per tab (config.views) - they get the
  // same filters, reload and document panel as the built-in ones through ctx.
  const [viewBusy, setViewBusy] = useState({});
  const CustomView = views?.[activeTab] || null;
  const ctx = {
    api: API,
    scope,
    scopeKey,
    scopeParams,
    reloadKey,
    filters,
    searchText: search,
    canViewSql,
    logInPage,
    label: LABEL,
    logKey,
    // true once per slot after a Reload, so that fetch skips the server cache
    takeBypass: (slot) => {
      const bypass = usedReload.current[slot] !== undefined && usedReload.current[slot] !== reloadKey;
      usedReload.current[slot] = reloadKey;
      return bypass;
    },
    setBusy: (slot, on) => setViewBusy(b => (b[slot] === on ? b : { ...b, [slot]: on })),
    synced: () => onSynced?.(Date.now()),
    openSql,
    toggleFilter: toggleFilterValue,
    setFilter: setFilterValues,
    setSearchText: (col, text) => setSearch(s => ({ ...s, [col]: text })),
    openDoc: (docId, chunkId = null) => docId && setDrawer({ docId, chunkId }),
    goTab: (id) => onTabChange?.(id),
  };

  /* ---------- busy ---------- */
  const busy = summary.loading || table.loading || breakdown.loading || Object.values(charts).some(c => c.loading)
    || (!!CustomView && Object.values(viewBusy).some(Boolean));
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  /* ============================== render ============================== */

  const btn = "flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01";
  const selectCls = "border border-jj-gray-03 rounded-lg px-2 py-1 text-[11.5px] font-johnson-text text-jj-gray-08 bg-white focus:outline-none focus:border-jj-blue-03";

  return (
    <div className="flex-1 min-h-0 flex">
      {/* ── filter rail ── */}
      {railCollapsed ? (
        <div className="w-10 flex-shrink-0 bg-white border-r border-jj-gray-02 flex flex-col items-center pt-3 gap-2">
          <button onClick={() => setRailCollapsed(false)} title="Expand filters" className="relative p-1.5 rounded hover:bg-jj-gray-01">
            <Icon src={filterIcon} tint="ink" className="w-[13px] h-[13px]" />
            {activeFilterCount > 0 && (
              <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[15px] h-[15px] px-0.5 rounded-full bg-jj-red text-white text-[9px] font-medium">{activeFilterCount}</span>
            )}
          </button>
        </div>
      ) : (
        <div className="w-[252px] flex-shrink-0 bg-white border-r border-jj-gray-02 flex flex-col overflow-hidden">
          <div className="px-[18px] pt-4 pb-3 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2 text-[13px] font-johnson-text font-bold text-jj-gray-08">
              <Icon src={filterIcon} tint="ink" className="w-[13px] h-[13px]" />
              Refine
              {activeFilterCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium">{activeFilterCount}</span>
              )}
            </div>
            <button onClick={clearAll} disabled={activeFilterCount === 0} className="text-[11px] font-johnson-text text-jj-blue-03 disabled:opacity-40">Clear all</button>
            <button onClick={() => setRailCollapsed(true)} title="Collapse filters" className="p-1 rounded hover:bg-jj-gray-01">
              <Icon src={chevronRightIcon} tint="gray" className="w-2.5 h-2.5 rotate-180" />
            </button>
          </div>
          <div className="px-[18px] pb-3.5 space-y-2 border-b border-jj-gray-01 flex-shrink-0">
            {SEARCHES.map(({ col, ph }) => (
              <div key={col} className="relative">
                <Icon src={searchIcon} tint="gray" className="w-[13px] h-[13px] absolute left-2.5 top-[9px]" />
                <input
                  value={search[col]}
                  onChange={e => setSearch(s => ({ ...s, [col]: e.target.value }))}
                  placeholder={ph}
                  className="w-full pl-8 pr-2 py-2 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
                />
              </div>
            ))}
            <div className="text-[10px] font-johnson-text text-jj-gray-06">Applies after you stop typing.</div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {FILTERS.map(({ col, label }) => (
              <FacetGroup
                key={col}
                col={col}
                label={label}
                selected={filters[col] || []}
                onChange={(vals) => setFilterValues(col, vals)}
                state={facetState[col]}
                onOpen={loadFacet}
              />
            ))}
          </div>
          <div className="flex-shrink-0 px-[18px] py-3.5 border-t border-jj-gray-01 text-[10.5px] font-johnson-text text-jj-gray-05 leading-relaxed">
            Counts are documents. Charts &amp; table follow your filters.
          </div>
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {chips.length > 0 && (
          <div className="flex-shrink-0 px-5 pt-3.5 flex items-center gap-2 flex-wrap">
            {chips.map(chip => (
              <span key={chip.key} className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-white border border-jj-gray-03 text-[11px] font-johnson-text text-jj-gray-08">
                {chip.text}
                <button onClick={chip.onRemove} className="hover:opacity-60"><Icon src={closeIcon} alt="Remove" tint="gray" className="w-2 h-2" /></button>
              </span>
            ))}
            <button onClick={clearAll} className="text-[11px] font-johnson-text text-jj-blue-03 underline">Clear all</button>
          </div>
        )}

        {CustomView && <CustomView ctx={ctx} />}

        {/* ============ EXPLORE ============ */}
        {activeTab === 'explore' && !CustomView && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="p-5 flex flex-col gap-3.5">
              {summary.error && <ErrorBanner message={`Couldn't load summary: ${summary.error}`} onRetry={() => loadSummary(false)} />}

              <div className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden flex-shrink-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
                <div className="bg-white px-5 py-4 flex items-center gap-4 min-w-0">
                  {ingestionSegments.length > 0
                    ? <Donut segments={ingestionSegments} title="Ingestion status (documents)" />
                    : <div className="w-16 h-16 rounded-full border-[9px] border-jj-gray-01 flex-shrink-0" />}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide">Documents</div>
                      <SqlLink title="Summary" sql={summary.sql} />
                    </div>
                    <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums" title={docs != null ? docs.toLocaleString() : undefined}>
                      {summary.loading && docs == null ? '…' : docs != null ? formatCompact(docs) : '—'}
                    </div>
                    <div className="text-[11px] font-johnson-text mt-1.5">
                      {successPct != null
                        ? <span className="font-medium text-jj-green-03">{successPct}% ingested OK</span>
                        : <span className="text-jj-gray-05">distinct DOC_ID</span>}
                    </div>
                  </div>
                </div>
                {trial && (
                <div className="bg-white px-5 py-4 flex items-center gap-4 min-w-0">
                  {trialSegments.length > 0
                    ? <Donut segments={trialSegments} title="Trial status (documents)" />
                    : <div className="w-16 h-16 rounded-full border-[9px] border-jj-gray-01 flex-shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1.5">Trial status</div>
                    {charts['trial-status']?.loading && !trialSegments.length && <div className="text-[11px] font-johnson-text text-jj-gray-05">…</div>}
                    {trialSegments.slice(0, 4).map(s => (
                      <button
                        key={s.label}
                        onClick={() => toggleFilterValue('CODI_MDM', s.raw)}
                        title={`Filter to ${s.label}`}
                        className="w-full flex items-center gap-1.5 text-[11.5px] font-johnson-text leading-[1.55] hover:opacity-70"
                      >
                        <span className="w-[7px] h-[7px] rounded-full flex-shrink-0" style={{ background: s.color }} />
                        <span className="text-jj-gray-08 truncate text-left">{s.label}</span>
                        <span className="ml-auto pl-2 text-jj-gray-06 tabular-nums">{formatCompact(s.count)}</span>
                      </button>
                    ))}
                    {trialSegments.length > 4 && <div className="text-[10.5px] font-johnson-text text-jj-gray-05">+{trialSegments.length - 4} more</div>}
                  </div>
                </div>
                )}
                {kpis.map(id => ({
                  chunks: { label: 'Chunks', value: summary.chunks, sub: docs ? `avg ${(summary.chunks / docs).toFixed(1)} per document` : 'rows in table' },
                  pages: { label: 'Pages', value: summary.pages, sub: docs ? `avg ${Math.round(summary.pages / docs)} per document` : 'PAGES_TOTAL' },
                  protocols: { label: 'Protocols', value: summary.protocols, sub: summary.compounds != null ? `${summary.compounds} compounds · ${(summary.objects || 0).toLocaleString()} objects` : 'distinct PROTOCOL_ID' },
                  size: { label: 'Size', value: summary.size_bytes, fmt: formatBytes, sub: summary.files != null ? `${summary.files.toLocaleString()} files` : '' },
                }[id])).map(k => (
                  <div key={k.label} className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                    <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1">{k.label}</div>
                    <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums" title={k.value != null ? k.value.toLocaleString() : undefined}>
                      {summary.loading && k.value == null ? '…' : k.value != null ? (k.fmt ? k.fmt(k.value) : formatCompact(k.value)) : '—'}
                    </div>
                    <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5 truncate">{k.sub}</div>
                  </div>
                ))}
              </div>

              <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(430px, 1fr))' }}>
                {showCompoundPhase && (
                <Card className="px-5 py-4 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Documents by compound &amp; phase</div>
                    <SqlLink title="Documents by compound & phase" sql={charts['compound-phase']?.sql} />
                  </div>
                  <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">Top 15 compounds · distinct DOC_ID · click a compound to filter</div>
                  {chartBody('compound-phase', () => (
                    <StackedBars data={compoundPhase.data} series={compoundPhase.series} colors={compoundPhase.colors}
                      onPick={(raw) => toggleFilterValue('GENERIC', raw)} />
                  ))}
                </Card>
                )}
                {defaultDimension ? (
                <Card className="px-5 py-4 min-w-0">
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08 whitespace-nowrap">Documents by</div>
                      <select value={dimension} onChange={e => { logInPage(`${logKey}_dimension_change`, `${LABEL}: chart by ${e.target.value}`); setDimension(e.target.value); }} className={selectCls}>
                        {DIMENSIONS.map(d => <option key={d.col} value={d.col}>{d.label}</option>)}
                      </select>
                    </div>
                    <SqlLink title={`Documents by ${FILTER_LABELS[dimension]}`} sql={charts['by-dimension']?.sql} />
                  </div>
                  <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">Top 15 · click a bar to filter</div>
                  {chartBody('by-dimension', (rows) => (
                    <RankedBars
                      data={rows.map(([v, d, n]) => ({ label: bLabel(v), raw: v, count: d, extra: n }))}
                      extraLabel="Chunks"
                      compact
                      onPick={(raw) => toggleFilterValue(dimension, raw)}
                    />
                  ))}
                </Card>
                ) : (
                <Card className="px-5 py-4 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Largest documents</div>
                    <SqlLink title="Largest documents" sql={charts['top-docs']?.sql} />
                  </div>
                  <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">Top 15 by chunk count · click to open the document</div>
                  {chartBody('top-docs', (rows) => (
                    <RankedBars
                      data={rows.map(([fname, ch, pg, docId]) => ({ label: bLabel(fname), raw: docId, count: ch || 0, extra: pg }))}
                      unit="Chunks"
                      extraLabel="Pages"
                      compact
                      labelWidth={320}
                      onPick={(docId) => { if (docId) setDrawer({ docId, chunkId: null }); }}
                    />
                  ))}
                </Card>
                )}
              </div>


              <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
                {trial && (
                <Card className="px-5 py-4 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Trial status</div>
                    <SqlLink title="Trial status" sql={charts['trial-status']?.sql} />
                  </div>
                  <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">Documents per CODI_MDM · click to filter</div>
                  {chartBody('trial-status', () => (
                    <RankedBars data={colorBars('trial-status', TRIAL_COLORS)} onPick={(raw) => toggleFilterValue('CODI_MDM', raw)} />
                  ), 170)}
                </Card>
                )}
                <Card className="px-5 py-4 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Chunk levels</div>
                    <SqlLink title="Chunk levels" sql={charts['chunk-level']?.sql} />
                  </div>
                  <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">Chunks per CHUNK_LEVEL</div>
                  {chartBody('chunk-level', () => (
                    <RankedBars data={colorBars('chunk-level', LEVEL_COLORS)} unit="Chunks" onPick={(raw) => toggleFilterValue('CHUNK_LEVEL', raw)} />
                  ), 170)}
                </Card>
                <Card className="px-5 py-4 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Content types</div>
                    <SqlLink title="Content types" sql={charts['content-types']?.sql} />
                  </div>
                  <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">Chunks containing each type (a chunk can have several)</div>
                  {chartBody('content-types', () => (
                    <RankedBars data={colorBars('content-types', CONTENT_COLORS)} unit="Chunks" onPick={(raw) => toggleFilterValue('CONTENT_TYPE', raw)} />
                  ), 170)}
                </Card>
                <Card className="px-5 py-4 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Chunks per document</div>
                    <SqlLink title="Chunks per document" sql={charts['chunks-per-doc']?.sql} />
                  </div>
                  <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">How many documents fall in each size band</div>
                  {chartBody('chunks-per-doc', (rows) => (
                    <ColumnChart data={rows.map(([b, n]) => ({ label: b, count: n }))} />
                  ), 170)}
                </Card>
              </div>

              <Card className="px-5 py-4 flex-shrink-0">
                <div className="flex items-center justify-between mb-1 gap-2">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Documents ingested over time</div>
                  <div className="flex items-center gap-3">
                    <div className="flex bg-jj-gray-01 border border-jj-gray-02 rounded-full p-[2px] gap-0.5">
                      {['hour', 'day', 'week', 'month'].map(g => (
                        <button key={g} onClick={() => setGranularity(g)}
                          className={`px-2.5 py-[3px] rounded-full text-[10.5px] font-johnson-text capitalize ${granularity === g ? 'bg-jj-gray-08 text-white' : 'text-jj-gray-07 hover:text-jj-gray-08'}`}>
                          {g}
                        </button>
                      ))}
                    </div>
                    <SqlLink title="Documents over time" sql={charts['over-time']?.sql} />
                  </div>
                </div>
                <div className="text-[10px] font-johnson-text text-jj-gray-05 mb-2.5">Distinct DOC_ID by INGESTED_AT</div>
                {chartBody('over-time', (rows) => (
                  <TrendLine data={rows.map(([p, n]) => ({ period: p, count: n }))} granularity={granularity} />
                ), 230)}
              </Card>
            </div>
          </div>
        )}

        {/* ============ DATA TABLE ============ */}
        {activeTab === 'table' && !CustomView && (
          <div className="flex-1 min-h-0 flex flex-col gap-3.5 p-5 overflow-hidden">
            {table.error && <ErrorBanner message={table.error} onRetry={() => loadTable(false)} />}
            <div className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 flex items-center justify-between gap-3 px-[18px] py-3 border-b border-jj-gray-01 flex-wrap">
                <div className="flex items-center gap-4">
                  <div className="flex bg-jj-gray-01 border border-jj-gray-02 rounded-full p-[2px] gap-0.5">
                    {[{ id: 'documents', label: 'Documents' }, { id: 'chunks', label: 'Chunks' }].map(m => (
                      <button key={m.id} onClick={() => switchMode(m.id)}
                        className={`px-3.5 py-[5px] rounded-full text-[11.5px] font-johnson-text ${mode === m.id ? 'bg-jj-gray-08 text-white font-medium' : 'text-jj-gray-07 hover:text-jj-gray-08'}`}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                    {mode === 'documents' ? 'Matching documents' : useDistinct ? 'Distinct chunks' : 'Matching chunks'}{' '}
                    <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{(table.total_count || 0).toLocaleString()}</span>
                  </div>
                  {allowDistinct && mode === 'chunks' && (
                    <label className="flex items-center gap-1.5 text-[11.5px] font-johnson-text text-jj-gray-07 cursor-pointer" title="Hide chunks repeated by the metadata join (same document, chunk #, level and text)">
                      <input
                        type="checkbox"
                        checked={distinctChunks}
                        onChange={e => {
                          const next = e.target.checked;
                          logInPage(`${logKey}_distinct_chunks`, `${LABEL}: ${next ? 'enabled' : 'disabled'} distinct chunks`);
                          setDistinctChunks(next);
                        }}
                        className="accent-[#0f68b2]"
                      />
                      Distinct chunks
                    </label>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {canViewSql && table.sql && (
                    <button onClick={() => openSql('Data table (current page)', `${table.sql};\n\n-- row count\n${table.count_sql || ''};`)} className="text-[11px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
                  )}
                  <button onClick={downloadPage} disabled={table.loading || !tableRows.length} className={btn} title="Current page only">
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />Download page
                  </button>
                  <button onClick={downloadAll} disabled={table.loading || !table.total_count} className={btn} title="Every matching row, full chunk text">
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />Download all ({(table.total_count || 0).toLocaleString()})
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 relative">
                {table.loading && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10"><LoadingSpinner /></div>
                )}
                <div ref={dataScrollRef} className="h-full overflow-auto">
                  <table className="text-xs font-johnson-text" style={{ tableLayout: 'fixed', width: Math.max(tableWidth, dataScrollWidth) }}>
                    <colgroup>
                      {visibleCols.map((c, i) => (
                        <col key={c} style={{ width: colW(c) + (i === visibleCols.length - 1 ? Math.max(0, dataScrollWidth - tableWidth) : 0) }} />
                      ))}
                    </colgroup>
                    <thead className="sticky top-0 z-[5]">
                      <tr className="bg-[#faf9f8]">
                        {visibleCols.map(c => (
                          <th key={c} onClick={() => handleSort(c)}
                            className="relative px-3 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-jj-gray-06 cursor-pointer select-none whitespace-nowrap overflow-hidden hover:bg-jj-gray-02 border-b border-r border-jj-gray-02">
                            {c}{sortCol === c ? (sortAsc ? ' ▲' : ' ▼') : ''}
                            <div
                              onClick={e => e.stopPropagation()}
                              onMouseDown={e => startResize(e, c)}
                              onDoubleClick={e => { e.stopPropagation(); setColWidths(w => { const n = { ...w }; delete n[c]; return n; }); }}
                              title="Drag to resize · double-click to reset"
                              className="absolute top-0 right-0 h-full w-[7px] cursor-col-resize hover:bg-jj-blue-03/30"
                            />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.map((r, i) => (
                        <tr key={`${page}-${i}-${r.CHUNK_ID || r.DOC_ID}`} onClick={() => openRow(r)} className="hover:bg-jj-blue-03/5 cursor-pointer">
                          {visibleCols.map(c => (
                            <td key={c}
                              title={c === 'CHUNK_TEXT' || c === 'JJ_TITLE' || c === 'FILE_PATH' || c === 'SECTION_TITLE' ? cellText(r[c]) : undefined}
                              className={`px-3 py-2.5 truncate border-b border-r border-jj-gray-01 ${c === 'FILE_NAME' ? 'font-medium text-jj-gray-08' : 'text-jj-gray-07'} ${NUMERIC_COLS.has(c) ? 'text-right tabular-nums' : ''}`}>
                              {renderCell(c, r[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {!table.loading && !table.error && tableRows.length === 0 && (
                        <tr><td colSpan={visibleCols.length || 1} className="px-3 py-8 text-center text-jj-gray-06">No rows match the current filters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-2.5 border-t border-jj-gray-01">
                <div className="flex items-center gap-2 text-[11.5px] font-johnson-text text-jj-gray-06 tabular-nums">
                  <Icon src={infoIcon} className="w-3.5 h-3.5" />
                  {(table.total_count || 0).toLocaleString()} {mode}
                  {table.elapsed_ms != null && <span className="text-jj-gray-05">· {table.elapsed_ms.toLocaleString()} ms{table.cached ? ' · cached' : ''}</span>}
                  <span className="text-jj-gray-05">· click a row to open the document</span>
                  <select value={pageSize} disabled={table.loading}
                    onChange={e => { logInPage('page_size_change', `${LABEL}: page size ${e.target.value}`); setPageSize(Number(e.target.value)); }}
                    className="ml-2 border border-jj-gray-03 rounded-lg px-2 py-1 font-johnson-text">
                    {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}/page</option>)}
                  </select>
                </div>
                <Pager page={page} totalPages={table.total_pages || 1} loading={table.loading} onGo={goToPage} />
              </div>
            </div>
          </div>
        )}

        {/* ============ BREAKDOWN ============ */}
        {activeTab === 'breakdown' && !CustomView && (
          <div className="flex-1 min-h-0 flex gap-3.5 p-5 overflow-hidden">
            <Card className="flex-1 min-w-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-3 border-b border-jj-gray-01 gap-3 flex-wrap">
                <div>
                  <div className="text-[13.5px] font-johnson-text font-bold text-jj-gray-08">Breakdown</div>
                  <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-0.5">
                    {levels.map(l => FILTER_LABELS[l]).join(' → ')} · distinct DOC_ID · follows your filters
                  </div>
                </div>
                <div className="flex items-center gap-3.5">
                  <button onClick={exportBreakdown} disabled={!breakdown.rows.length} className={btn}>
                    <Icon src={downloadIcon} tint="ink" className="w-3 h-3" />Export
                  </button>
                  {canViewSql && breakdown.sql && (
                    <button onClick={() => openSql('Breakdown', breakdown.sql)} className="text-[11px] font-johnson-text text-jj-blue-03 underline">View SQL</button>
                  )}
                </div>
              </div>
              <div className="flex-shrink-0 flex items-center gap-2 px-[18px] py-2.5 border-b border-jj-gray-01 flex-wrap">
                {levels.map((lvl, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <span className="text-jj-gray-05 text-xs">→</span>}
                    <select value={lvl} onChange={e => setLevel(i, e.target.value)} className={selectCls}>
                      {BREAKDOWN_DIMENSIONS.map(d => <option key={d.col} value={d.col}>{d.label}</option>)}
                    </select>
                  </React.Fragment>
                ))}
                <div className="relative flex-1 min-w-[180px] max-w-[280px] ml-2">
                  <Icon src={searchIcon} tint="gray" className="w-3 h-3 absolute left-2.5 top-[9px]" />
                  <input value={bSearch} onChange={e => setBSearch(e.target.value)} placeholder="Search the tree…"
                    className="w-full pl-8 pr-2 py-[7px] text-xs font-johnson-text rounded-lg border border-jj-gray-03 bg-[#faf9f8] focus:outline-none focus:border-jj-blue-03 focus:bg-white" />
                </div>
                <button disabled={searching} onClick={() => { setOpenA(new Set(tree.nodes.map(n => n.key))); setOpenB(new Set(tree.nodes.flatMap(n => n.kids.map(k => k.key)))); }}
                  className="px-3.5 py-[7px] rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01">Expand all</button>
                <button disabled={searching} onClick={() => { setOpenA(new Set()); setOpenB(new Set()); }}
                  className="px-3.5 py-[7px] rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01">Collapse all</button>
              </div>
              <div className="flex-1 min-h-0 relative">
                {breakdown.loading && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10"><LoadingSpinner /></div>
                )}
                <div className="h-full overflow-auto">
                  {breakdown.error && <div className="p-4"><ErrorBanner message={breakdown.error} onRetry={() => loadBreakdown(false)} /></div>}
                  {!breakdown.loading && !breakdown.error && !breakdown.rows.length && (
                    <div className="px-3 py-8 text-center text-jj-gray-06 text-xs font-johnson-text">No data.</div>
                  )}
                  {!breakdown.error && breakdown.rows.length > 0 && (
                    <BreakdownTree tree={shownTree} openA={effOpenA} openB={effOpenB}
                      toggleA={toggleSet(setOpenA)} toggleB={toggleSet(setOpenB)} onDrill={drillDown} />
                  )}
                </div>
              </div>
              <div className="flex-shrink-0 px-[18px] py-2.5 border-t border-jj-gray-01 text-[11px] font-johnson-text text-jj-gray-06">
                Click a row to expand · "View docs" filters the data table to that branch
              </div>
            </Card>

            <Card className="w-[300px] flex-shrink-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 px-[18px] py-3 border-b border-jj-gray-01">
                <div className="text-[13.5px] font-johnson-text font-bold text-jj-gray-08">Top {FILTER_LABELS[levels[2]]?.toLowerCase()}</div>
                <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-0.5">Documents across current filters</div>
              </div>
              <div className="flex-1 overflow-y-auto px-[18px] py-3.5 flex flex-col gap-[11px]">
                {breakdown.loading && <ChartSkeleton height={200} />}
                {!breakdown.loading && topLeaves.map(a => (
                  <div key={a.label} title={`${a.label}: ${a.count.toLocaleString()}`}>
                    <div className="flex justify-between text-[11.5px] font-johnson-text mb-[3px]">
                      <span className="text-jj-gray-08 truncate pr-2">{a.label}</span>
                      <span className="tabular-nums flex-shrink-0 text-jj-gray-08">{formatCompact(a.count)}</span>
                    </div>
                    <div className="h-2 rounded-[3px] bg-jj-gray-01">
                      <div className="h-full rounded-[3px] bg-jj-gray-08" style={{ width: `${(a.count / (topLeaves[0]?.count || 1)) * 100}%` }} />
                    </div>
                  </div>
                ))}
                {!breakdown.loading && !topLeaves.length && <NoData />}
              </div>
            </Card>
          </div>
        )}
      </div>

      <SqlModal modal={sqlModal} onClose={() => setSqlModal(null)} />
      {drawer && (
        <Drawer
          api={API}
          metaFields={metaFields}
          logKey={logKey}
          key={`${drawer.docId}|${drawer.chunkId || ''}`}
          docId={drawer.docId}
          focusChunkId={drawer.chunkId}
          allowDistinct={allowDistinct}
          initialDistinct={distinctChunks}
          onDistinctChange={setDistinctChunks}
          onClose={() => setDrawer(null)}
          logInPage={logInPage}
        />
      )}
    </div>
  );
}

function Pager({ page, totalPages, loading, onGo }) {
  const [draft, setDraft] = useState(String(page));
  useEffect(() => { setDraft(String(page)); }, [page]);
  const commit = () => {
    const n = parseInt(draft, 10);
    if (!Number.isNaN(n)) onGo(n);
    else setDraft(String(page));
  };
  const b = "px-2.5 py-1.5 rounded-lg border border-jj-gray-03 text-[11.5px] font-johnson-text disabled:opacity-40 hover:bg-jj-gray-01";
  return (
    <div className="flex items-center gap-1.5">
      <button onClick={() => onGo(1)} disabled={page <= 1 || loading} className={b}>«</button>
      <button onClick={() => onGo(page - 1)} disabled={page <= 1 || loading} className={b}>Prev</button>
      <span className="flex items-center gap-1.5 text-[11.5px] font-johnson-text text-jj-gray-07 tabular-nums">
        <input
          type="number" min="1" max={totalPages} value={draft} disabled={loading}
          onChange={e => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); e.target.blur(); } }}
          className="w-[62px] border border-jj-gray-03 rounded-lg px-2 py-1 text-center font-johnson-text tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          aria-label="Go to page"
        />
        of {totalPages.toLocaleString()}
      </span>
      <button onClick={() => onGo(page + 1)} disabled={page >= totalPages || loading} className={b}>Next</button>
      <button onClick={() => onGo(totalPages)} disabled={page >= totalPages || loading} className={b}>»</button>
    </div>
  );
}
// building blocks for explorers that bring their own views (VirtualRegulatorExplorer)
export {
  Icon, Card, ErrorBanner, ChartSkeleton, NoData, CardUnavailable, Pill, ContentChips,
  Donut, RankedBars, ColumnChart, TrendLine, Pager, SqlModal, ChunkText, DocumentDrawer,
  useDebounced, useChartTip, fetchJson, formatCompact, formatBytes, formatEastern, blank, bLabel,
  cellText, colorFrom, parseContentTypes, renderCell,
  LEVEL_COLORS, CONTENT_COLORS, INGESTION_COLORS, FALLBACK_COLORS,
};