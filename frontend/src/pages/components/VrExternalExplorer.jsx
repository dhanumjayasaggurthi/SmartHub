import React, { useState, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import LoadingSpinner from './LoadingSpinner';
import VrExternalTable from './VrExternalTable';
import { apiJson } from '../../utils/apiClient';
import { facetOptions, passesFacets, haColors } from './vrExternalFacets';

import searchIcon from "/icons/JJ_Icon_Search_RGB.svg";
import filterIcon from "/icons/JJ_Icon_Filter.svg";
import closeIcon from "/icons/JJ_Icon_Close.svg";
import downloadIcon from "/icons/JJ_Icon_Download_PDF_RGB.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";

// Virtual Regulator -> External. FDA press releases from the RSS feed
// (DEV_RAW.UNSTRUCTURED_EXPLORER.FDA_PRESS_RELEASE_RSS).
// Same look as ChunkExplorer (filter rail, KPI band, cards) so the tab doesn't
// feel like a different app. The feed only has title / summary / date, so the
// action type, therapeutic area, products and signals are read out of the text
// with the keyword rules below. Table is small - we pull it once and slice here.

const TINTS = {
  red: "url(#jj-red-tint)",
  ink: "url(#jj-ink-tint)",
  gray: "url(#jj-gray-tint)",
  white: "url(#jj-white-tint)",
};
const Icon = ({ src, alt = "", className = "w-4 h-4", tint = "red" }) => (
  <img src={src} alt={alt} className={className} style={tint ? { filter: TINTS[tint] } : undefined} />
);

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

/* ============================== classification ============================== */

// first match wins (title first, then summary)
const CATEGORIES = [
  { id: 'enforcement', label: 'Enforcement', color: '#9e0000', re: /consent decree|warning letter|recall|court|injunction|seiz|import alert|illegal|crack(s)? down|fraud/i },
  { id: 'eua', label: 'Emergency use (EUA)', color: '#ff6017', re: /emergency use authori[sz]ation|\bEUA\b/i },
  { id: 'approval', label: 'Drug & biologic approvals', color: '#328714', re: /\bapprov/i },
  { id: 'device', label: 'Device authorizations', color: '#0f68b2', re: /authori[sz]|clear(s|ance)|device|diagnostic test/i },
  { id: 'input', label: 'Public input', color: '#8c3bbb', re: /seeks|public (input|feedback|comment)|feedback|request for (information|comment)|draft guidance|listening session/i },
  { id: 'policy', label: 'Policy & programs', color: '#b8860b', re: /regulation|rule|guidance|launch|pilot|program|takes steps|initiative|framework|announce|plan|strategy|update/i },
];
const OTHER = { id: 'other', label: 'Other', color: '#a39992' };
const ALL_CATS = [...CATEGORIES, OTHER];
const CAT_BY_ID = Object.fromEntries(ALL_CATS.map(c => [c.id, c]));

const AREAS = [
  { id: 'oncology', label: 'Oncology', re: /cancer|tumou?r|oncolog|carcinoma|lymphoma|leuk[a]?emia|myeloma|metastatic|sarcoma|melanoma|glioma/i },
  { id: 'rare', label: 'Rare disease', re: /\brare\b|orphan|sanfilippo|alexander disease|polycythemia|dermatomyositis|duchenne|huntington|\bALS\b/i },
  { id: 'genecell', label: 'Gene & cell therapy', re: /gene therapy|cell therapy|car-t|viral immunotherapy|gene[- ]edit|crispr/i },
  { id: 'infectious', label: 'Infectious disease', re: /infect|virus|viral(?! immunotherapy)|vaccin|bacteri|antibiotic|antimicrobial|parasit|screwworm|covid|influenza|measles|hiv|hepatitis|malaria/i },
  { id: 'neuro', label: 'Neurology', re: /neuro|alzheimer|parkinson|epilep|seizure|multiple sclerosis|migraine|alexander disease|dementia/i },
  { id: 'immuno', label: 'Immunology & derm', re: /dermat|psoria|lupus|arthritis|eczema|autoimmun|myositis/i },
  { id: 'cardio', label: 'Cardio-metabolic', re: /cardi|heart|hypertension|diabet|obesity|metabolic|cholesterol|kidney|glucose/i },
  { id: 'pediatric', label: 'Pediatrics', re: /pediatric|paediatric|child|infant|newborn|neonat|aged \d+ (years|months)/i },
  { id: 'food', label: 'Food & nutrition', re: /\bfood\b|nutrition|formula|dietary|botanical|supplement|nutrient/i },
  { id: 'vet', label: 'Animal health', re: /animal(?! (test|stud))|veterinar|cattle|livestock|screwworm|\bdogs?\b|sheep/i },
  { id: 'devices', label: 'Medical devices', re: /device|wearable|robotic|implant|diagnostic|sensor/i },
];
const AREA_BY_ID = Object.fromEntries(AREAS.map(a => [a.id, a]));

const SIGNALS = [
  { id: 'first', label: 'First-of-kind', test: (t) => /\bfirst\b/i.test(t) },
  { id: 'accelerated', label: 'Accelerated approval', test: (t, d) => /accelerated approval/i.test(`${t} ${d}`) },
  { id: 'expedited', label: 'Expedited pathway', test: (t, d) => /breakthrough|priority review|fast track|orphan drug|expedite/i.test(`${t} ${d}`) },
];
const SIGNAL_BY_ID = Object.fromEntries(SIGNALS.map(s => [s.id, s]));

// "approved Fayuvi (rebisufligene etisparvovec-xxxx)" -> Fayuvi / rebisufligene...
const PRODUCT_RE = /\b([A-Z][A-Za-z0-9-]{1,}(?: [A-Z][A-Za-z0-9-]+)?)\s*\(([a-z][a-z0-9 ,-]{2,60}?)\)/g;
const NOT_PRODUCTS = new Set(['FDA', 'The', 'This', 'Drug', 'Administration', 'Drug Administration', 'Food', 'Emergency', 'Use', 'Authorization', 'Use Authorization']);

function productsOf(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(PRODUCT_RE)) {
    const brand = m[1];
    if (NOT_PRODUCTS.has(brand) || seen.has(brand)) continue;
    seen.add(brand);
    out.push({ brand, generic: m[2].trim() });
  }
  return out;
}

function enrich(r) {
  const t = r.TITLE || '';
  const d = r.DESCRIPTION || '';
  // the agency name has "Food" and "Drug" in it - drop it before tagging areas
  const both = `${t} ${d}`.replace(/(U\.S\. )?Food and Drug Administration/gi, 'FDA');
  const cat = CATEGORIES.find(c => c.re.test(t)) || CATEGORIES.find(c => c.re.test(d)) || OTHER;
  const areas = AREAS.filter(a => a.re.test(both)).map(a => a.id);
  const signals = SIGNALS.filter(s => s.test(t, d)).map(s => s.id);
  const ts = r.PUBLISHED_ISO ? new Date(r.PUBLISHED_ISO).getTime() : null;
  return { ...r, cat: cat.id, areas, signals, products: productsOf(d), ts };
}

/* ============================== helpers ============================== */

const DAY = 24 * 60 * 60 * 1000;
const TZ = 'America/New_York';

const PERIODS = [
  { id: '30', label: '30d', long: 'last 30 days', days: 30 },
  { id: '90', label: '90d', long: 'last 90 days', days: 90 },
  { id: '180', label: '6m', long: 'last 6 months', days: 180 },
  { id: 'all', label: 'All', long: 'all time', days: null },
];

function fmtDate(v, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleDateString('en-US', { ...opts, timeZone: TZ });
}

function daysAgo(ts) {
  if (!ts) return '';
  const n = Math.floor((Date.now() - ts) / DAY);
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 30) return `${n}d ago`;
  const m = Math.round(n / 30);
  return `${m}mo ago`;
}

function startOfWeek(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function startOfMonth(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function highlight(text, q) {
  if (!q || !text) return text;
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text).split(new RegExp(`(${safe})`, 'ig')).map((p, i) =>
    p.toLowerCase() === q.toLowerCase() ? <mark key={i} className="bg-jj-yellow-01/70 text-inherit rounded-sm">{p}</mark> : p
  );
}

function csvOf(rows) {
  const cols = [
    ['Published', r => r.PUBLISHED_TS],
    ['Action type', r => CAT_BY_ID[r.cat].label],
    ['Title', r => r.TITLE],
    ['Summary', r => r.DESCRIPTION],
    ['Products', r => r.products.map(p => `${p.brand} (${p.generic})`).join('; ')],
    ['Therapeutic areas', r => r.areas.map(a => AREA_BY_ID[a].label).join('; ')],
    ['Signals', r => r.signals.map(s => SIGNAL_BY_ID[s].label).join('; ')],
    ['Source', r => r.SOURCE_NAME],
    ['URL', r => r.ITEM_URL],
    ['Loaded', r => r.LOAD_TS],
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(c => c[0]).join(','), ...rows.map(r => cols.map(c => esc(c[1](r))).join(','))].join('\n');
}

function useElementWidth() {
  const [width, setWidth] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(e => setWidth(e[0].contentRect.width));
    ro.observe(ref.current);
    setWidth(ref.current.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [width, ref];
}

// same tooltip as ChunkExplorer
function useChartTip() {
  const [tip, setTip] = useState(null);
  const show = (e, rows) => setTip({ x: e.clientX, y: e.clientY, rows });
  const hide = () => setTip(null);
  const node = tip ? ReactDOM.createPortal(
    <div
      className="fixed z-[60] pointer-events-none rounded-lg bg-jj-gray-08 text-white shadow-xl px-3 py-2"
      style={{
        left: Math.min(tip.x + 14, window.innerWidth - 260),
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
          <span className="ml-auto pl-4 tabular-nums">{r.value}</span>
        </div>
      ))}
    </div>,
    document.body
  ) : null;
  return { show, hide, node };
}

/* ============================== small pieces ============================== */

function Card({ className = '', children }) {
  return (
    <div className={`bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] ${className}`}>
      {children}
    </div>
  );
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

function Pill({ id }) {
  const c = CAT_BY_ID[id] || OTHER;
  return (
    <span
      className="inline-flex items-center gap-[5px] text-[11px] font-johnson-text font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap"
      style={{ background: `${c.color}17`, color: c.color }}
    >
      <span className="w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: c.color }} />
      {c.label}
    </span>
  );
}

function Tag({ children, tone = 'gray' }) {
  const cls = tone === 'red' ? 'bg-jj-red/[.08] text-jj-red' : tone === 'blue' ? 'bg-jj-blue-03/[.08] text-jj-blue-03' : 'bg-jj-gray-01 text-jj-gray-07';
  return <span className={`inline-flex items-center text-[10.5px] font-johnson-text px-1.5 py-[1px] rounded whitespace-nowrap ${cls}`}>{children}</span>;
}

function Delta({ now, prev }) {
  if (prev == null) return null;
  const diff = now - prev;
  if (diff === 0) return <span className="text-jj-gray-05">flat vs prior period</span>;
  return (
    <span className={diff > 0 ? 'text-jj-green-03 font-medium' : 'text-jj-maroon-05 font-medium'}>
      {diff > 0 ? '▲' : '▼'} {Math.abs(diff)} <span className="text-jj-gray-05 font-normal">vs prior period</span>
    </span>
  );
}

function Donut({ segments }) {
  const tip = useChartTip();
  const R = 26, C = 2 * Math.PI * R;
  const total = segments.reduce((a, s) => a + s.count, 0);
  const rows = [{ label: 'Releases by action type', header: true }, ...segments.map(s => ({ label: s.label, value: s.count, color: s.color }))];
  let offset = 0;
  return (
    <>
      <svg width="64" height="64" viewBox="0 0 64 64" className="flex-shrink-0 -rotate-90" onMouseMove={(e) => tip.show(e, rows)} onMouseLeave={tip.hide}>
        <circle cx="32" cy="32" r={R} fill="none" stroke="#f1efed" strokeWidth="9" />
        {segments.map((s, i) => {
          const dash = total ? (s.count / total) * C : 0;
          const el = <circle key={i} cx="32" cy="32" r={R} fill="none" stroke={s.color} strokeWidth="9" strokeDasharray={`${Math.max(0, dash - 1.5)} ${C}`} strokeDashoffset={-offset} />;
          offset += dash;
          return el;
        })}
      </svg>
      {tip.node}
    </>
  );
}

// ChunkExplorer-style bars: label + count on top, thin bar below
function RankedBars({ rows, active, onPick, empty }) {
  const tip = useChartTip();
  const max = Math.max(1, ...rows.map(r => r.count));
  if (!rows.length) return <div className="text-xs font-johnson-text text-jj-gray-06 py-8 text-center">{empty || 'No data for current filters.'}</div>;
  return (
    <div className="flex flex-col gap-2">
      {rows.map(r => {
        const on = active.includes(r.id);
        return (
          <div
            key={r.id}
            onClick={() => onPick(r.id)}
            onMouseMove={(e) => tip.show(e, [{ label: r.label, header: true }, { label: 'Releases', value: r.count, color: r.color }, { label: on ? 'Click to remove filter' : 'Click to filter', value: '' }])}
            onMouseLeave={tip.hide}
            className={`rounded cursor-pointer hover:bg-jj-gray-01/60 ${active.length && !on ? 'opacity-50' : ''}`}
          >
            <div className="flex justify-between text-[11px] font-johnson-text mb-[3px]">
              <span className={`truncate pr-2 text-jj-gray-08 ${on ? 'font-bold' : ''}`}>{r.label}</span>
              <span className="text-jj-gray-08 tabular-nums flex-shrink-0">{r.count}</span>
            </div>
            <div className="h-[9px] rounded bg-jj-gray-01">
              <div className="h-full rounded" style={{ width: `${(r.count / max) * 100}%`, minWidth: 4, background: r.color }} />
            </div>
          </div>
        );
      })}
      {tip.node}
    </div>
  );
}

// stacked columns (week or month) by action type
function Activity({ rows, periodDays }) {
  const tip = useChartTip();
  const [w, ref] = useElementWidth();

  const { buckets, monthly } = useMemo(() => {
    const dated = rows.filter(r => r.ts);
    if (!dated.length) return { buckets: [], monthly: false };
    const end = Date.now();
    const start = periodDays ? end - periodDays * DAY : Math.min(...dated.map(r => r.ts));
    const monthly = (end - start) / DAY > 200;
    const keyOf = monthly ? startOfMonth : startOfWeek;
    const map = new Map();
    for (let k = keyOf(start); k <= end;) {
      map.set(k, { key: k, total: 0, byCat: {} });
      if (monthly) { const d = new Date(k); k = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(); } else k += 7 * DAY;
    }
    dated.forEach(r => {
      const b = map.get(keyOf(r.ts));
      if (!b) return;
      b.total += 1;
      b.byCat[r.cat] = (b.byCat[r.cat] || 0) + 1;
    });
    return { buckets: [...map.values()], monthly };
  }, [rows, periodDays]);

  const H = 190, padL = 26, padB = 22, padT = 8;
  const innerW = Math.max(120, w - padL);
  const max = Math.max(1, ...buckets.map(b => b.total));
  const top = max <= 4 ? max : Math.ceil(max / 2) * 2;
  const ticks = top <= 4 ? Array.from({ length: top + 1 }, (_, i) => i) : [0, top / 2, top];
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const slotW = buckets.length ? innerW / buckets.length : innerW;
  const barW = Math.max(4, Math.min(22, slotW * 0.56));
  const every = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(innerW / 58))));
  const used = ALL_CATS.filter(c => rows.some(r => r.cat === c.id));

  return (
    <div ref={ref}>
      {!buckets.length ? (
        <div className="text-xs font-johnson-text text-jj-gray-06 flex items-center justify-center" style={{ height: H }}>No dated releases for current filters.</div>
      ) : w > 0 && (
        <svg width={w} height={H} className="block">
          {ticks.map(t => (
            <g key={t}>
              <line x1={padL} x2={w} y1={y(t)} y2={y(t)} stroke="#e8e6e3" strokeDasharray={t === 0 ? undefined : '3 4'} />
              <text x={padL - 7} y={y(t) + 3.5} textAnchor="end" fill="#a39992" style={{ fontSize: 10 }}>{t}</text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const cx = padL + slotW * i + slotW / 2;
            let acc = 0;
            const head = `${monthly ? 'Month of' : 'Week of'} ${fmtDate(b.key)}`;
            const tipRows = [
              { label: head, header: true },
              ...ALL_CATS.filter(c => b.byCat[c.id]).map(c => ({ label: c.label, value: b.byCat[c.id], color: c.color })),
              { label: 'Total', value: b.total },
            ];
            return (
              <g key={b.key} onMouseMove={(e) => tip.show(e, tipRows)} onMouseLeave={tip.hide}>
                <rect x={cx - slotW / 2} y={padT} width={slotW} height={H - padT - padB} fill="transparent" />
                {ALL_CATS.filter(c => b.byCat[c.id]).map(c => {
                  const v = b.byCat[c.id];
                  const y1 = y(acc + v), y0 = y(acc);
                  acc += v;
                  return <rect key={c.id} x={cx - barW / 2} y={y1 + 1} width={barW} height={Math.max(2, y0 - y1 - 2)} rx={3} fill={c.color} />;
                })}
                {i % every === 0 && (
                  <text x={cx} y={H - 6} textAnchor="middle" fill="#81766f" style={{ fontSize: 10 }}>
                    {monthly ? fmtDate(b.key, { month: 'short', year: '2-digit' }) : fmtDate(b.key, { month: 'short', day: 'numeric' })}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 mt-2">
        {used.map(c => (
          <span key={c.id} className="inline-flex items-center gap-1.5 text-[10.5px] font-johnson-text text-jj-gray-07">
            <span className="w-2 h-2 rounded-[2px]" style={{ background: c.color }} />{c.label}
          </span>
        ))}
      </div>
      {tip.node}
    </div>
  );
}

// checkbox facet in the left rail, counts reflect the other filters
function Facet({ label, options, selected, onToggle, dot, showDots = false, note }) {
  const [open, setOpen] = useState(false);
  const max = Math.max(1, ...options.map(o => o.count));
  return (
    <div className="border-b border-jj-gray-01 last:border-0">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-[18px] py-3.5 text-left hover:bg-jj-gray-01/50 transition-colors">
        <span className="text-[11px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-07">
          {label}
          {selected.length > 0 && (
            <span className="ml-2 inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium normal-case tracking-normal">{selected.length}</span>
          )}
        </span>
        <Icon src={chevronRightIcon} tint="gray" className={`w-2.5 h-2.5 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="px-[18px] pb-3.5">
          {note && <div className="text-[10.5px] font-johnson-text text-jj-gray-05 -mt-1 mb-1.5">{note}</div>}
          {options.length === 0 && <div className="text-xs font-johnson-text text-jj-gray-06 py-1.5">Nothing for current filters</div>}
          {options.map(o => {
            const checked = selected.includes(o.id);
            return (
              <label key={o.id} className="flex flex-col gap-1.5 py-2 px-1 -mx-1 rounded cursor-pointer hover:bg-jj-gray-01/60">
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={checked} onChange={() => onToggle(o.id)} className="accent-[#0f68b2] flex-shrink-0" />
                  {showDots && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: o.color }} />}
                  <span className={`flex-1 truncate text-[12.5px] font-johnson-text ${checked ? 'font-bold' : 'font-medium'} text-jj-gray-08`} title={o.label}>{o.label}</span>
                  <span className="text-[11px] font-johnson-text text-jj-gray-06 tabular-nums flex-shrink-0">{o.count}</span>
                </div>
                <div className="h-[5px] rounded-full bg-jj-gray-01 ml-[22px]">
                  <div className="h-full rounded-full" style={{ width: `${Math.round((o.count / max) * 100)}%`, background: dot || o.color }} />
                </div>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================== detail drawer ============================== */

function ReleaseDrawer({ item, onClose, onOpenLink }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = () => {
    navigator.clipboard?.writeText(item.ITEM_URL || '').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const meta = [
    ['Published', item.PUBLISHED_TS],
    ['Issued by', item.CREATOR],
    ['Source', item.SOURCE_NAME],
    ['Loaded', item.LOAD_TS ? String(item.LOAD_TS).replace('T', ' ').slice(0, 19) : null],
    ['URL', item.ITEM_URL],
  ];

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="w-full max-w-[560px] h-full bg-white shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex-shrink-0 px-5 py-4 border-b border-jj-gray-02 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10.5px] font-johnson-text uppercase tracking-wider text-jj-gray-06">FDA press release · {fmtDate(item.ts, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</div>
            <h3 className="font-johnson-display font-bold text-[17px] leading-snug text-jj-gray-08 break-words mt-0.5">{item.TITLE}</h3>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <Pill id={item.cat} />
              {item.signals.map(s => <Tag key={s} tone="red">{SIGNAL_BY_ID[s].label}</Tag>)}
            </div>
          </div>
          <button onClick={onClose} className="flex-shrink-0 p-1"><Icon src={closeIcon} alt="Close" tint="ink" className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-5 py-4 border-b border-jj-gray-01">
            <div className="text-[11px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-07 mb-2">Summary</div>
            <p className="text-[12.5px] font-johnson-text text-jj-gray-08 leading-relaxed">{item.DESCRIPTION || 'No summary in the feed.'}</p>
          </div>

          {item.products.length > 0 && (
            <div className="px-5 py-4 border-b border-jj-gray-01">
              <div className="text-[11px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-07 mb-2">Products</div>
              {item.products.map(p => (
                <div key={p.brand} className="flex text-xs font-johnson-text py-1.5">
                  <div className="w-[38%] font-bold text-jj-gray-08 flex-shrink-0">{p.brand}</div>
                  <div className="w-[62%] text-jj-gray-07 break-words">{p.generic}</div>
                </div>
              ))}
            </div>
          )}

          {item.areas.length > 0 && (
            <div className="px-5 py-4 border-b border-jj-gray-01">
              <div className="text-[11px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-07 mb-2">Therapeutic areas</div>
              <div className="flex flex-wrap gap-1.5">{item.areas.map(a => <Tag key={a}>{AREA_BY_ID[a].label}</Tag>)}</div>
            </div>
          )}

          <div className="px-5 py-4">
            <div className="text-[11px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-07 mb-1">Record</div>
            {meta.map(([k, v]) => (
              <div key={k} className="flex text-xs font-johnson-text border-b border-jj-gray-01 last:border-0 py-2">
                <div className="w-[38%] text-jj-gray-06 flex-shrink-0">{k}</div>
                <div className="w-[62%] text-jj-gray-08 break-all">{v || <span className="italic text-jj-gray-05">null</span>}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-shrink-0 px-5 py-3.5 border-t border-jj-gray-02 flex items-center gap-2">
          <a
            href={item.ITEM_URL}
            target="_blank"
            rel="noreferrer"
            onClick={() => onOpenLink(item)}
            className="flex-1 text-center px-[18px] py-[9px] rounded-full bg-jj-red text-white text-[12.5px] font-johnson-text font-medium hover:bg-[#c91400] transition-colors shadow-[0_2px_8px_rgba(235,23,0,.25)]"
          >
            Read on fda.gov ↗
          </a>
          <button onClick={copy} className="px-[18px] py-[9px] rounded-full border border-jj-gray-03 text-[12.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01">
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ============================== main ============================== */

// the header dropdown picks the table. press releases keep their own dashboard,
// anything else goes to the generic table view.
export default function VrExternalExplorer({ source, ...props }) {
  if (source && source.kind !== 'press') return <VrExternalTable source={source} {...props} />;
  return <PressReleases {...props} />;
}

function PressReleases({ logInPage, activeTab, onBusyChange, onSynced, canViewSql, reloadKey, sources = [], facets = {}, onFacetsChange, onOpenTable }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const firstLoad = useRef(true);

  const [railCollapsed, setRailCollapsed] = useState(false);
  const [period, setPeriod] = useState('all');
  const [cats, setCats] = useState([]);
  const [areas, setAreas] = useState([]);
  const [signals, setSignals] = useState([]);
  const [query, setQuery] = useState('');
  const [sortDesc, setSortDesc] = useState(true);
  const [showSql, setShowSql] = useState(false);
  const [openItem, setOpenItem] = useState(null);
  const [feedLimit, setFeedLimit] = useState(15);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let dead = false;
    const bypass = !firstLoad.current;
    firstLoad.current = false;
    setLoading(true);
    setError(null);
    onBusyChange?.(true);
    apiJson(`/api/vr-external/items${bypass ? '?bypass_cache=true' : ''}`)
      .then(res => {
        if (dead) return;
        setData(res);
        onSynced?.(Date.now());
      })
      .catch(e => { if (!dead) setError(e.message || 'Failed to load press releases'); })
      .finally(() => {
        if (dead) return;
        setLoading(false);
        onBusyChange?.(false);
      });
    // leaving mid-load (scope / table switch) must not leave the header on "Syncing…"
    return () => { dead = true; onBusyChange?.(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, attempt]);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const t = setTimeout(() => logInPage?.('filter_add', `VR External: searched "${q}"`), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => { setFeedLimit(15); }, [period, cats, areas, signals, query]);

  const all = useMemo(() => (data?.items || []).map(enrich), [data]);
  const periodDays = PERIODS.find(p => p.id === period)?.days ?? null;
  const q = query.trim().toLowerCase();

  // skip = leave one dimension out (so facet counts show siblings); shift = previous period
  const pass = useMemo(() => {
    const now = Date.now();
    return (r, skip = null, shift = 0) => {
      if (periodDays) {
        if (!r.ts) return false;
        const hi = now - shift * periodDays * DAY;
        if (r.ts > hi || r.ts < hi - periodDays * DAY) return false;
      }
      if (skip !== 'cat' && cats.length && !cats.includes(r.cat)) return false;
      if (skip !== 'area' && areas.length && !areas.some(a => r.areas.includes(a))) return false;
      if (skip !== 'signal' && signals.length && !signals.some(s => r.signals.includes(s))) return false;
      if (q && !`${r.TITLE} ${r.DESCRIPTION} ${r.products.map(p => `${p.brand} ${p.generic}`).join(' ')}`.toLowerCase().includes(q)) return false;
      return true;
    };
  }, [periodDays, cats, areas, signals, q]);

  const rows = useMemo(() => {
    const out = all.filter(r => pass(r));
    out.sort((a, b) => sortDesc ? (b.ts || 0) - (a.ts || 0) : (a.ts || 0) - (b.ts || 0));
    return out;
  }, [all, pass, sortDesc]);

  const prevRows = useMemo(() => (periodDays ? all.filter(r => pass(r, null, 1)) : null), [all, pass, periodDays]);

  const facetCounts = useMemo(() => {
    const count = (skip, list, has) => {
      const base = all.filter(r => pass(r, skip));
      return list.map(x => ({ ...x, count: base.filter(r => has(r, x.id)).length })).filter(x => x.count > 0 || false);
    };
    return {
      cat: count('cat', ALL_CATS, (r, id) => r.cat === id).sort((a, b) => b.count - a.count),
      area: count('area', AREAS, (r, id) => r.areas.includes(id)).sort((a, b) => b.count - a.count),
      signal: count('signal', SIGNALS, (r, id) => r.signals.includes(id)).sort((a, b) => b.count - a.count),
    };
  }, [all, pass]);

  const kpis = useMemo(() => {
    const n = (list, fn) => (list ? list.filter(fn).length : null);
    const isAuth = r => ['approval', 'device', 'eua'].includes(r.cat);
    const isFirst = r => r.signals.includes('first');
    const isFast = r => r.signals.includes('accelerated') || r.signals.includes('expedited');
    const dated = rows.filter(r => r.ts);
    const spanDays = periodDays || (dated.length ? Math.max(7, (Date.now() - Math.min(...dated.map(r => r.ts))) / DAY) : 7);
    return {
      auth: n(rows, isAuth), authPrev: n(prevRows, isAuth),
      first: n(rows, isFirst), firstPrev: n(prevRows, isFirst),
      fast: n(rows, isFast), fastPrev: n(prevRows, isFast),
      perWeek: rows.length / (spanDays / 7),
          };
  }, [rows, prevRows, periodDays]);

  const catSegments = useMemo(() => ALL_CATS
    .map(c => ({ label: c.label, color: c.color, count: rows.filter(r => r.cat === c.id).length }))
    .filter(s => s.count), [rows]);

  const products = useMemo(() => {
    const out = [];
    rows.forEach(r => r.products.forEach(p => out.push({ ...p, item: r })));
    return out;
  }, [rows]);

  const insights = useMemo(() => {
    const out = [];
    if (!rows.length) return out;
    const byCat = facetCounts.cat.filter(c => !cats.length || cats.includes(c.id));
    const top = byCat[0];
    if (top && cats.length !== 1) out.push(<><b>{top.label}</b> make up {top.count} of {rows.length} releases ({Math.round(top.count / rows.length * 100)}%).</>);
    const firsts = rows.filter(r => r.signals.includes('first'));
    if (firsts.length) out.push(<><b>{firsts.length} first-of-kind</b> action{firsts.length === 1 ? '' : 's'}; latest: {firsts[0].TITLE}.</>);
    const topArea = [...facetCounts.area].sort((a, b) => b.count - a.count)[0];
    if (topArea && areas.length !== 1) out.push(<><b>{topArea.label}</b> is the most mentioned therapeutic area ({topArea.count}).</>);
    const eua = rows.filter(r => r.cat === 'eua').length;
    if (eua) out.push(<><b>{eua} Emergency Use Authorization{eua === 1 ? '' : 's'}</b> in view.</>);
    const enf = rows.filter(r => r.cat === 'enforcement').length;
    if (enf) out.push(<><b>{enf} enforcement action{enf === 1 ? '' : 's'}</b>, worth a compliance read.</>);
    return out.slice(0, 4);
  }, [rows, facetCounts, cats, areas]);

  // health authority facet - same one as the table page (counts are tables).
  // ticking one opens the first table that fits, since press releases are FDA only.
  const extTables = useMemo(() => sources.filter(s => s.kind === 'table'), [sources]);
  const haColorMap = useMemo(() => haColors(sources), [sources]);
  const haOptions = useMemo(() => {
    const site = facetOptions(extTables, facets).find(f => f.id === 'site');
    return (site?.options || []).map(o => ({ id: o.value, label: o.value, count: o.count, color: haColorMap.get(o.value) || '#a39992' }));
  }, [extTables, facets, haColorMap]);
  const pickedHas = facets.site || [];
  const toggleHa = (name) => {
    const on = pickedHas.includes(name);
    const next = { ...facets, site: on ? pickedHas.filter(x => x !== name) : [...pickedHas, name] };
    onFacetsChange?.(next);
    logInPage?.(on ? 'filter_remove' : 'filter_add', `VR External: ${on ? 'removed' : 'added'} Health authority filter "${name}"`);
    if (!on) {
      const first = extTables.find(t => passesFacets(t, next));
      if (first) onOpenTable?.(first.id);
    }
  };

  const lastLoad = useMemo(() => all.reduce((m, r) => (!m || (r.LOAD_TS || '') > m ? r.LOAD_TS : m), null), [all]);

  /* ---------- actions ---------- */
  const toggler = (dim, list, setList, labelOf) => (id) => {
    const on = list.includes(id);
    setList(on ? list.filter(x => x !== id) : [...list, id]);
    logInPage?.(on ? 'filter_remove' : 'filter_add', `VR External: ${on ? 'removed' : 'added'} ${dim} filter "${labelOf(id)}"`);
  };
  const toggleCat = toggler('action type', cats, setCats, id => CAT_BY_ID[id].label);
  const toggleArea = toggler('therapeutic area', areas, setAreas, id => AREA_BY_ID[id].label);
  const toggleSignal = toggler('signal', signals, setSignals, id => SIGNAL_BY_ID[id].label);
  const changePeriod = (id) => {
    if (id === period) return;
    setPeriod(id);
    logInPage?.('filter_add', `VR External: period set to ${PERIODS.find(p => p.id === id).long}`);
  };
  const clearAll = () => { setCats([]); setAreas([]); setSignals([]); setQuery(''); setPeriod('all'); };
  const activeFilterCount = cats.length + areas.length + signals.length + (q ? 1 : 0) + (period !== 'all' ? 1 : 0);

  const openDetail = (r) => {
    setOpenItem(r);
    logInPage?.('open_detail', `VR External: opened "${r.TITLE}"`);
  };
  const openLink = (r) => logInPage?.('open_link', `VR External: opened fda.gov link for "${r.TITLE}"`);

  const download = () => {
    const blob = new Blob([csvOf(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fda_press_releases_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    logInPage?.('download', `VR External: downloaded ${rows.length} press releases`);
  };

  const btn = "flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01 whitespace-nowrap";

  /* ---------- load / error ---------- */
  if (loading && !data) {
    return <div className="flex-1 flex items-center justify-center p-10"><LoadingSpinner /></div>;
  }
  if (error && !data) {
    return (
      <div className="flex-1 p-5">
        <LoadFailed what="FDA press releases" error={error} onRetry={() => setAttempt(a => a + 1)} />
      </div>
    );
  }

  const chips = [
    ...cats.map(id => ({ key: `c-${id}`, text: CAT_BY_ID[id].label, clear: () => toggleCat(id) })),
    ...areas.map(id => ({ key: `a-${id}`, text: AREA_BY_ID[id].label, clear: () => toggleArea(id) })),
    ...signals.map(id => ({ key: `s-${id}`, text: SIGNAL_BY_ID[id].label, clear: () => toggleSignal(id) })),
    ...(q ? [{ key: 'q', text: `Search: ${query.trim()}`, clear: () => setQuery('') }] : []),
    ...(period !== 'all' ? [{ key: 'p', text: PERIODS.find(p => p.id === period).long, clear: () => changePeriod('all') }] : []),
  ];

  const latest = rows.find(r => r.ts) || rows[0];

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
          <div className="px-[18px] pb-3.5 space-y-2.5 border-b border-jj-gray-01 flex-shrink-0">
            <div className="relative">
              <Icon src={searchIcon} tint="gray" className="w-[13px] h-[13px] absolute left-2.5 top-[9px]" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Title, summary or product…"
                className="w-full pl-8 pr-2 py-2 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03"
              />
            </div>
            <div>
              <div className="text-[10px] font-johnson-text text-jj-gray-06 mb-1.5">Published</div>
              <div className="flex bg-jj-gray-01 border border-jj-gray-02 rounded-full p-[2px] gap-0.5">
                {PERIODS.map(p => (
                  <button
                    key={p.id}
                    onClick={() => changePeriod(p.id)}
                    className={`flex-1 py-[4px] rounded-full text-[11px] font-johnson-text ${period === p.id ? 'bg-jj-gray-08 text-white font-medium' : 'text-jj-gray-07 hover:text-jj-gray-08'}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {haOptions.length > 0 && (
              <Facet label="Health authority" options={haOptions} selected={pickedHas} onToggle={toggleHa} showDots/>
            )}
            <Facet label="Action type" options={facetCounts.cat} selected={cats} onToggle={toggleCat} />
            <Facet label="Therapeutic area" options={facetCounts.area} selected={areas} onToggle={toggleArea} dot="#0f68b2" />
            <Facet label="Signals" options={facetCounts.signal} selected={signals} onToggle={toggleSignal} dot="#eb1700" />
          </div>
          <div className="flex-shrink-0 px-[18px] py-3.5 border-t border-jj-gray-01 text-[10.5px] font-johnson-text text-jj-gray-05 leading-relaxed">
            Counts are press releases. Types, areas and signals are read from the title &amp; summary text.
          </div>
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col overflow-hidden" aria-busy={loading}>
        <RefreshBar on={loading} />
        {error && (
          <div className="flex-shrink-0 px-5 pt-3.5">
            <LoadFailed what="the latest press releases (showing the last good load)" error={error} onRetry={() => setAttempt(a => a + 1)} />
          </div>
        )}
        {chips.length > 0 && (
          <div className="flex-shrink-0 px-5 pt-3.5 flex items-center gap-2 flex-wrap">
            {chips.map(c => (
              <span key={c.key} className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-white border border-jj-gray-03 text-[11px] font-johnson-text text-jj-gray-08">
                {c.text}
                <button onClick={c.clear} className="hover:opacity-60"><Icon src={closeIcon} alt="Remove" tint="gray" className="w-2 h-2" /></button>
              </span>
            ))}
            <button onClick={clearAll} className="text-[11px] font-johnson-text text-jj-blue-03 underline">Clear all</button>
          </div>
        )}

        {/* ============ EXPLORE ============ */}
        {activeTab !== 'table' && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="p-5 flex flex-col gap-3.5">
              {/* KPI band */}
              <div className="grid gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden flex-shrink-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
                <div className="bg-white px-5 py-4 flex items-center gap-4 min-w-0">
                  {catSegments.length ? <Donut segments={catSegments} /> : <div className="w-16 h-16 rounded-full border-[9px] border-jj-gray-01 flex-shrink-0" />}
                  <div className="min-w-0">
                    <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide">Press releases</div>
                    <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums mt-1">{rows.length}</div>
                    <div className="text-[11px] font-johnson-text mt-1.5 truncate">
                      {prevRows ? <Delta now={rows.length} prev={prevRows.length} /> : <span className="text-jj-gray-05">of {all.length} loaded</span>}
                    </div>
                  </div>
                </div>
                {[
                  { label: 'Approvals & authorizations', value: kpis.auth, prev: kpis.authPrev, sub: rows.length ? `${Math.round(kpis.auth / rows.length * 100)}% of releases` : '' },
                  { label: 'First-of-kind', value: kpis.first, prev: kpis.firstPrev, sub: 'novel products & firsts' },
                  { label: 'Expedited pathways', value: kpis.fast, prev: kpis.fastPrev, sub: 'accelerated, breakthrough, priority' },
                  { label: 'Pace', value: kpis.perWeek.toFixed(1), sub: 'releases per week' },
                ].map(k => (
                  <div key={k.label} className="bg-white px-5 py-4 flex flex-col justify-center min-w-0">
                    <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide mb-1 truncate">{k.label}</div>
                    <div className="font-johnson-display font-bold text-[26px] leading-none text-jj-gray-08 tabular-nums">{k.value}</div>
                    <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-1.5 truncate">
                      {k.prev != null ? <Delta now={k.value} prev={k.prev} /> : k.sub}
                    </div>
                  </div>
                ))}
              </div>

              {!rows.length ? (
                <Card className="px-5 py-10 text-center">
                  <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">{all.length ? 'No press releases match' : 'No press releases loaded yet'}</div>
                  <div className="text-xs font-johnson-text text-jj-gray-06 mt-1">{all.length ? 'Widen the period or clear a filter.' : 'They show up here after the next RSS load.'}</div>
                  {all.length > 0 && <button onClick={clearAll} className="mt-3 text-xs font-johnson-text text-jj-blue-03 underline">Clear all filters</button>}
                </Card>
              ) : (
                <>
                  {/* latest + takeaways */}
                  <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
                    {latest && (
                      <Card className="px-5 py-4 min-w-0 flex flex-col">
                        <CardTitle
                          title="Latest release"
                          right={<span className="text-[11px] font-johnson-text text-jj-gray-06 whitespace-nowrap">{fmtDate(latest.ts, { weekday: 'short', month: 'short', day: 'numeric' })} · {daysAgo(latest.ts)}</span>}
                        />
                        <button onClick={() => openDetail(latest)} className="text-left mt-2 group">
                          <div className="font-johnson-display font-bold text-[15px] leading-snug text-jj-gray-08 group-hover:text-jj-red transition-colors">{latest.TITLE}</div>
                        </button>
                        <p className="text-xs font-johnson-text text-jj-gray-07 leading-relaxed mt-1.5 line-clamp-3">{latest.DESCRIPTION}</p>
                        <div className="flex items-center gap-1.5 flex-wrap mt-3">
                          <Pill id={latest.cat} />
                          {latest.signals.map(s => <Tag key={s} tone="red">{SIGNAL_BY_ID[s].label}</Tag>)}
                          {latest.areas.slice(0, 2).map(a => <Tag key={a}>{AREA_BY_ID[a].label}</Tag>)}
                        </div>
                        <div className="flex-1" />
                        <div className="flex items-center gap-2 mt-4">
                          <button onClick={() => openDetail(latest)} className={btn}>View details</button>
                          <a href={latest.ITEM_URL} target="_blank" rel="noreferrer" onClick={() => openLink(latest)} className={btn}>Open on fda.gov ↗</a>
                        </div>
                      </Card>
                    )}
                    <Card className="px-5 py-4 min-w-0">
                      <CardTitle title="Key takeaways" sub="Worked out from the releases in view" />
                      <ul className="flex flex-col gap-2.5">
                        {insights.map((t, i) => (
                          <li key={i} className="flex gap-2.5 text-xs font-johnson-text text-jj-gray-07 leading-relaxed">
                            <span className="flex-shrink-0 w-[18px] h-[18px] rounded-full bg-jj-red/10 text-jj-red text-[10px] font-bold flex items-center justify-center mt-[1px]">{i + 1}</span>
                            <span className="min-w-0 [&_b]:text-jj-gray-08">{t}</span>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  </div>

                  {/* activity + action mix */}
                  <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
                    <Card className="px-5 py-4 min-w-0">
                      <CardTitle title="Release activity" sub={`Press releases per ${(periodDays || 999) > 200 ? 'week / month' : 'week'} by action type · hover for detail`} />
                      <Activity rows={rows} periodDays={periodDays} />
                    </Card>
                    <Card className="px-5 py-4 min-w-0">
                      <CardTitle title="What FDA is doing" sub="Releases by action type · click to filter" />
                      <RankedBars rows={facetCounts.cat} active={cats} onPick={toggleCat} />
                    </Card>
                  </div>

                  {/* areas + products */}
                  <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
                    <Card className="px-5 py-4 min-w-0">
                      <CardTitle title="Therapeutic areas" sub="Mentioned in title or summary · click to filter" />
                      <RankedBars rows={facetCounts.area.slice(0, 8).map(a => ({ ...a, color: 'linear-gradient(90deg,#0f68b2,#004685)' }))} active={areas} onPick={toggleArea} empty="No therapeutic areas detected." />
                    </Card>
                    <Card className="px-5 py-4 min-w-0">
                      <CardTitle title="Regulatory signals" sub="Click to filter" />
                      <RankedBars rows={facetCounts.signal.map(s => ({ ...s, color: '#eb1700' }))} active={signals} onPick={toggleSignal} empty="No signals for current filters." />
                    </Card>
                    <Card className="px-5 py-4 min-w-0 flex flex-col">
                      <CardTitle
                        title="Products named"
                        sub="Brand (generic) from release summaries · click to open"
                        right={<span className="text-[11px] font-johnson-text text-jj-gray-05 tabular-nums">{products.length}</span>}
                      />
                      {products.length ? (
                        <div className="flex flex-col -mx-2 max-h-[236px] overflow-y-auto">
                          {products.map((p, i) => (
                            <button key={`${p.brand}-${i}`} onClick={() => openDetail(p.item)} className="flex items-center gap-2 px-2 py-[7px] rounded text-left hover:bg-jj-gray-01/60">
                              <span className="w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: CAT_BY_ID[p.item.cat].color }} />
                              <span className="text-xs font-johnson-text font-bold text-jj-gray-08 flex-shrink-0">{p.brand}</span>
                              <span className="text-[11px] font-johnson-text text-jj-gray-06 truncate flex-1 min-w-0">{p.generic}</span>
                              <span className="text-[10.5px] font-johnson-text text-jj-gray-05 tabular-nums flex-shrink-0">{fmtDate(p.item.ts, { month: 'short', day: 'numeric' })}</span>
                            </button>
                          ))}
                        </div>
                      ) : <div className="text-xs font-johnson-text text-jj-gray-06 py-8 text-center">No product names in view.</div>}
                    </Card>
                  </div>

                  {/* feed */}
                  <Card className="flex-shrink-0 overflow-hidden">
                    <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-jj-gray-01">
                      <div>
                        <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
                          Press releases <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{rows.length}</span>
                        </div>
                        <div className="text-[10px] font-johnson-text text-jj-gray-05 mt-0.5">Click a release for summary, products and tags</div>
                      </div>
                      <div className="flex bg-jj-gray-01 border border-jj-gray-02 rounded-full p-[2px] gap-0.5">
                        {[{ id: true, label: 'Newest' }, { id: false, label: 'Oldest' }].map(o => (
                          <button key={o.label} onClick={() => setSortDesc(o.id)}
                            className={`px-3 py-[3px] rounded-full text-[10.5px] font-johnson-text ${sortDesc === o.id ? 'bg-jj-gray-08 text-white' : 'text-jj-gray-07 hover:text-jj-gray-08'}`}>
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      {rows.slice(0, feedLimit).map(r => (
                        <div key={r.ITEM_KEY} onClick={() => openDetail(r)} className="group flex items-start gap-4 px-5 py-3 border-b border-jj-gray-01 last:border-0 hover:bg-jj-blue-03/[.03] cursor-pointer">
                          <div className="w-[46px] flex-shrink-0 text-center pt-[2px]">
                            <div className="text-[10px] font-johnson-text font-bold uppercase text-jj-red leading-none">{r.ts ? fmtDate(r.ts, { month: 'short' }) : ''}</div>
                            <div className="font-johnson-display font-bold text-[18px] leading-tight text-jj-gray-08">{r.ts ? fmtDate(r.ts, { day: 'numeric' }) : '—'}</div>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-[12.5px] font-johnson-text font-bold text-jj-gray-08 leading-snug group-hover:text-jj-red transition-colors">{highlight(r.TITLE, query.trim())}</div>
                            <div className="text-[11.5px] font-johnson-text text-jj-gray-06 leading-relaxed mt-0.5 line-clamp-1">{highlight(r.DESCRIPTION, query.trim())}</div>
                            <div className="flex items-center gap-1 flex-wrap mt-1.5">
                              {r.products.map(p => <Tag key={p.brand} tone="blue">{p.brand}</Tag>)}
                              {r.signals.map(s => <Tag key={s} tone="red">{SIGNAL_BY_ID[s].label}</Tag>)}
                              {r.areas.slice(0, 2).map(a => <Tag key={a}>{AREA_BY_ID[a].label}</Tag>)}
                            </div>
                          </div>
                          <div className="flex-shrink-0 w-[190px] flex justify-end pt-[1px]"><Pill id={r.cat} /></div>
                        </div>
                      ))}
                    </div>
                    {rows.length > feedLimit && (
                      <div className="px-5 py-3 border-t border-jj-gray-01 flex justify-center">
                        <button onClick={() => setFeedLimit(n => n + 15)} className={btn}>Show more · {rows.length - feedLimit} left</button>
                      </div>
                    )}
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
                  Press releases <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{rows.length} of {all.length}</span>
                  {lastLoad && <span className="font-normal text-jj-gray-05 text-[11px] ml-2">· feed loaded {fmtDate(lastLoad)}</span>}
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
              {showSql && data?.sql && (
                <pre className="flex-shrink-0 mx-[18px] mt-3 bg-jj-gray-08 text-white text-[11px] rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-40">{data.sql}</pre>
              )}
              <div className="flex-1 min-h-0 overflow-auto">
                <table className="w-full min-w-[1080px] border-separate border-spacing-0 text-xs font-johnson-text" style={{ tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: 118 }} />
                    <col style={{ width: 200 }} />
                    <col />
                    <col style={{ width: 180 }} />
                    <col style={{ width: 210 }} />
                    <col style={{ width: 56 }} />
                  </colgroup>
                  <thead className="sticky top-0 z-[5]">
                    <tr className="bg-[#faf9f8]">
                      {['Published', 'Action type', 'Press release', 'Products', 'Areas & signals', ''].map((h, i) => (
                        <th
                          key={i}
                          onClick={i === 0 ? () => setSortDesc(s => !s) : undefined}
                          className={`px-3 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-jj-gray-06 whitespace-nowrap border-b border-r border-jj-gray-02 last:border-r-0 ${i === 0 ? 'cursor-pointer hover:bg-jj-gray-02' : ''}`}
                        >
                          {h}{i === 0 ? (sortDesc ? ' ▼' : ' ▲') : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.ITEM_KEY} onClick={() => openDetail(r)} className="hover:bg-jj-blue-03/5 cursor-pointer align-top">
                        <td className="px-3 py-2.5 border-b border-r border-jj-gray-01">
                          <div className="text-jj-gray-08 font-medium tabular-nums whitespace-nowrap">{fmtDate(r.ts)}</div>
                          <div className="text-[10.5px] text-jj-gray-05 mt-0.5">{daysAgo(r.ts)}</div>
                        </td>
                        <td className="px-3 py-2.5 border-b border-r border-jj-gray-01"><Pill id={r.cat} /></td>
                        <td className="px-3 py-2.5 border-b border-r border-jj-gray-01 min-w-0">
                          <div className="font-medium text-jj-gray-08 leading-snug">{highlight(r.TITLE, query.trim())}</div>
                          <div className="text-[11.5px] text-jj-gray-06 leading-relaxed mt-0.5 line-clamp-2">{highlight(r.DESCRIPTION, query.trim())}</div>
                        </td>
                        <td className="px-3 py-2.5 border-b border-r border-jj-gray-01">
                          {r.products.length ? r.products.map(p => (
                            <div key={p.brand} className="leading-snug mb-1 last:mb-0 min-w-0">
                              <span className="font-bold text-jj-gray-08">{p.brand}</span>
                              <div className="text-[10.5px] text-jj-gray-06 truncate" title={p.generic}>{p.generic}</div>
                            </div>
                          )) : <span className="italic text-jj-gray-05">none</span>}
                        </td>
                        <td className="px-3 py-2.5 border-b border-r border-jj-gray-01">
                          <div className="flex flex-wrap gap-1">
                            {r.signals.map(s => <Tag key={s} tone="red">{SIGNAL_BY_ID[s].label}</Tag>)}
                            {r.areas.slice(0, 3).map(a => <Tag key={a}>{AREA_BY_ID[a].label}</Tag>)}
                            {!r.signals.length && !r.areas.length && <span className="italic text-jj-gray-05">none</span>}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 border-b border-jj-gray-01 text-center">
                          <a
                            href={r.ITEM_URL}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => { e.stopPropagation(); openLink(r); }}
                            title="Open on fda.gov"
                            className="text-jj-blue-03 hover:text-jj-red text-[13px]"
                          >
                            ↗
                          </a>
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-8 text-center text-jj-gray-06">No press releases match the current filters.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {openItem && <ReleaseDrawer item={openItem} onClose={() => setOpenItem(null)} onOpenLink={openLink} />}
    </div>
  );
}