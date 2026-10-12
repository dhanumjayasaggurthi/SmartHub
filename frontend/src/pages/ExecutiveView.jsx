import { useState, useEffect, useMemo, useRef, createContext, useContext } from 'react';

import chevronRight  from "/icons/JJ_Icon_Chevron_Right.svg";
import recordsSrc    from "/icons/JJ_Icon_Unfold_All_More.svg";
import closeSrc      from "/icons/JJ_Icon_Close.svg";
import backgroundSrc from "/background.png";
import logoSrc       from "/sh_logo.png";

import LoadingSpinner from './components/LoadingSpinner';
import { apiFetch } from '../utils/apiClient';

/* ═══════════════════════════════════════════════════════════════════════════
   Executive View — Business Defined Checks
   Single-page layout: enterprise health → check dimensions →
   Component / Domain / Rule drill columns + scope panel.
   The drill hierarchy and every API call match the previous version; only
   the presentation changed.
   ═════════════════════════════════════════════════════════════════════════ */

const TARGET = 95;   // pass-rate target (green)
const FLOOR  = 80;   // escalation floor (blue reference line)

const F = {
  red:    'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)',
  gray06: 'brightness(0) saturate(100%) invert(50%) sepia(6%) saturate(656%) hue-rotate(346deg) brightness(92%) contrast(88%)',
  gray07: 'brightness(0) saturate(100%) invert(42%) sepia(6%) saturate(656%) hue-rotate(346deg) brightness(92%) contrast(88%)',
};

const Ic = ({ src, className = 'w-4 h-4', filter = F.gray07, style = {} }) => (
  <img src={src} alt="" className={className} style={{ filter, flexShrink: 0, ...style }} />
);

// Bar colour bands, kept next to passColor so the legend can't drift from it.
const PASS_BANDS = [
  { color: '#328714', label: `${TARGET}%+` },
  { color: '#0f68b2', label: `85-${TARGET - 1}%` },
  { color: '#e06c00', label: '75-84%' },
  { color: '#eb1700', label: 'Below 75%' },
];

const passColor = (p) =>
  p === null || p === undefined ? '#a39992'
    : p >= TARGET ? '#328714'
    : p >= 85     ? '#0f68b2'
    : p >= 75     ? '#e06c00'
    : '#eb1700';

const DIMENSION_COLORS = {
  Completeness: '#0f68b2',
  Consistency:  '#8c3bbb',
  Validity:     '#328714',
  Timeliness:   '#e06c00',
  Uniqueness:   '#eb1700',
};

// 'YYYY-MM-DD' goes through Date() as UTC midnight, which renders as the
// previous day east of Greenwich — so 2026-01-01 showed up as "Dec 25".
// Build the date in local time instead.
const parseRunDate = (d) => {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  const dt = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(d);
  return isNaN(dt.getTime()) ? null : dt;
};

const monthLabel = (d) => {
  const dt = parseRunDate(d);
  return dt ? dt.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) : String(d ?? '—');
};

const dayLabel = (d) => {
  const dt = parseRunDate(d);
  return dt ? dt.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }) : null;
};

// Pass percentages arrive as strings in some views. Anything that isn't a
// real number is "not scored", never 0 — averaging a null in as 0 quietly
// drags the enterprise number down.
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const clampPct = (v) => Math.max(0, Math.min(100, v));

// "1B_DQR_Consistency_v1" / "DQR_Consistency" -> "Consistency"
// Trailing version tokens (v1, v12) are dropped before we take the last word,
// otherwise every versioned rule lands in "Unclassified".
const dimensionOf = (row) => {
  const raw = row.rule_title || row.rule_type || row.rule_id || '';
  const parts = String(raw).split('_').filter(Boolean);
  while (parts.length > 1 && /^v\d+$/i.test(parts[parts.length - 1])) parts.pop();
  const word = parts[parts.length - 1] || '';
  if (!word || /^v\d+$/i.test(word)) return 'Unclassified';
  return word.charAt(0).toUpperCase() + word.slice(1);
};

const isTrue = (v) => v === true || String(v).toUpperCase() === 'TRUE';

const avgOf = (list) => {
  const scored = list.map(r => numOrNull(r.pass_percentage)).filter(n => n !== null);
  return scored.length
    ? Math.round(scored.reduce((s, n) => s + n, 0) / scored.length)
    : null;
};

/* ── Data access (unchanged endpoints) ─────────────────────────────────── */

// The rule-input table endpoint is paginated at 200 rows max, so walk it.
async function fetchRuleInput() {
  const MAX_PAGES = 100;   // 20k rules — well past anything real
  const all = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await apiFetch(`/api/admin/dq-tables/rule-input?page=${page}&page_size=200`);
    if (!res.ok) throw new Error(res.statusText || `HTTP ${res.status}`);
    const data = await res.json();
    const cols = (data.columns || []).map(c => c.toLowerCase());
    (data.rows || []).forEach(row => {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      all.push(obj);
    });
    totalPages = Math.min(data.total_pages || 1, MAX_PAGES);
    page += 1;
  } while (page <= totalPages);
  return all;
}

// Trends are one request per rule, so cap how many are in flight at once.
// Without this a few hundred active rules opens a few hundred sockets and
// hammers Snowflake on every page load.
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

async function fetchRuleStats(deltaMode = false) {
  const res = await apiFetch(`/api/rules?delta_mode=${deltaMode}`);
  if (!res.ok) throw new Error(res.statusText);
  const rules = await res.json();
  const map = {};
  rules.forEach(r => { map[r.rule_id] = r; });
  return map;
}

const trendCache = new Map();

// Refresh has to drop this, otherwise the trend charts keep serving the
// numbers from the first load no matter how many times you hit the button.
function clearTrendCache() {
  trendCache.clear();
}

async function loadTrend(ruleId, deltaMode = false) {
  const key = `${ruleId}|${deltaMode}`;
  if (trendCache.has(key)) return trendCache.get(key);
  const res = await apiFetch(`/api/trends/${ruleId}?delta_mode=${deltaMode}`);
  if (!res.ok) throw new Error(res.statusText);
  const data = await res.json();
  trendCache.set(key, data);
  return data;
}

// Average pass rate per execution date across a set of rules.
// Note: rules that ran on different dates land in different buckets, so a
// bucket's `rules` count is how many rules actually reported that day, not
// the size of the scope. Buckets covering fewer than half the scope are
// flagged as partial so the delta doesn't get read as a real movement.
// One bar per month: each rule's runs in a month are averaged first, then
// those per-rule numbers are averaged, so a rule that ran 3 times that month
// doesn't outweigh one that ran once. `date` keeps the latest run in the month.
function averageSeries(series) {
  const avg = (a) => a.reduce((s, n) => s + n, 0) / a.length;
  const byMonth = new Map(); // 'YYYY-MM' -> { date, perRule: Map(ruleIdx -> [vals]) }
  series.forEach((points, i) => {
    (points || []).forEach(p => {
      const n = numOrNull(p?.pass_percentage);
      const dt = parseRunDate(p?.date);
      if (!dt || n === null) return;
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      if (!byMonth.has(key)) byMonth.set(key, { date: p.date, perRule: new Map() });
      const b = byMonth.get(key);
      if (parseRunDate(b.date) < dt) b.date = p.date;
      if (!b.perRule.has(i)) b.perRule.set(i, []);
      b.perRule.get(i).push(n);
    });
  });
  const total = series.length || 1;
  return [...byMonth.values()]
    .map(({ date, perRule }) => {
      const vals = [...perRule.values()].map(avg);
      return {
        date,
        pass_percentage: Math.round(avg(vals) * 10) / 10,
        rules: vals.length,
        partial: vals.length < total / 2,
      };
    })
    .sort((a, b) => parseRunDate(a.date) - parseRunDate(b.date));
}

/* ── Small primitives ──────────────────────────────────────────────────── */

/* Replay phase: 0 = settled, 1 = collapsing bars back to zero after a refresh. */
const ReplayContext = createContext(0);

const KEYFRAMES = `
@keyframes exec-rise { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:none; } }
@keyframes exec-slide { from { opacity:0; transform:translateX(-16px); } to { opacity:1; transform:none; } }
@keyframes exec-pulse { 0% { opacity:.85; transform:scale(1); } 70% { opacity:0; transform:scale(2.8); } 100% { opacity:0; } }
@keyframes exec-spin { to { transform:rotate(360deg); } }
@keyframes exec-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
`;

function useCountUp(value, ms = 900) {
  const phase = useContext(ReplayContext);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (value === null || value === undefined || phase === 1) { setShown(0); return; }
    let raf, t0;
    const step = (t) => {
      if (!t0) t0 = t;
      const p = Math.min(1, (t - t0) / ms);
      setShown(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms, phase]);
  return shown;
}

// Flips true one frame after mount so bars/rings animate from zero.
// While the replay phase is 1 (just after a refresh) it stays false, so every
// bar transitions back down to 0 before rising to the new value.
function useMounted(deps = []) {
  const phase = useContext(ReplayContext);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(false);
    const t = setTimeout(() => setMounted(true), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, phase]);
  return mounted && phase === 0;
}

function SeverityChip({ severity, compact = false }) {
  const s = String(severity || '').toUpperCase();
  const map = {
    CRITICAL: ['#eb1700', 'rgba(235,23,0,0.08)'],
    HIGH:     ['#e06c00', 'rgba(224,108,0,0.09)'],
    MEDIUM:   ['#0f68b2', 'rgba(15,104,178,0.08)'],
    LOW:      ['#81766f', 'rgba(129,118,111,0.10)'],
  };
  const [color, bg] = map[s] || map.LOW;
  return (
    <span
      className="font-johnson-text font-bold rounded flex-shrink-0"
      style={{
        color, backgroundColor: bg,
        fontSize: compact ? '9.5px' : '11px',
        letterSpacing: '.08em',
        padding: compact ? '3px 6px' : '3px 8px',
      }}
    >
      {s || 'N/A'}
    </span>
  );
}

function EmptyState({ title, message }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <Ic src={recordsSrc} className="w-8 h-8 mb-3" filter={F.gray06} />
      <p className="font-johnson-display text-base font-bold text-jj-gray-08">{title}</p>
      <p className="font-johnson-text text-sm text-jj-gray-06 mt-1 max-w-md">{message}</p>
    </div>
  );
}

/* ── Enterprise health ring ────────────────────────────────────────────── */

function HealthPanel({ score, delta, rules, domains, components, belowTarget }) {
  const mounted = useMounted([score]);
  const shown = useCountUp(score ?? 0);
  const C = 2 * Math.PI * 62;
  const color = passColor(score);

  const Stat = ({ label, value, valueColor = '#ffffff' }) => (
    <div className="flex-1 min-w-0">
      <p className="m-0 font-johnson-display text-[17px] font-bold" style={{ color: valueColor }}>{value}</p>
      <p className="m-0 mt-0.5 font-johnson-text text-[11px] text-jj-gray-05">{label}</p>
    </div>
  );

  return (
    <div
      className="relative overflow-hidden rounded-[20px] px-6 pt-6 pb-5 bg-white border border-jj-gray-02"
      style={{ animation: 'exec-rise .5s cubic-bezier(.2,.8,.2,1) both' }}
    >
      <img
        src={backgroundSrc} alt=""
        className="absolute pointer-events-none"
        style={{ top: -150, right: -180, width: 560, opacity: 0.06 }}
      />
      <div className="relative">
        <p className="m-0 font-johnson-text text-[10.5px] font-bold uppercase tracking-[.16em] text-jj-gray-06">
          GRA - Data quality indicators
        </p>

        <div className="flex items-center gap-6 mt-4">
          <div className="relative flex-shrink-0" style={{ width: 150, height: 150 }}>
            <svg width="150" height="150" viewBox="0 0 150 150" style={{ display: 'block', transform: 'rotate(-90deg)' }}>
              <circle cx="75" cy="75" r="62" fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth="13" />
              <circle
                cx="75" cy="75" r="62" fill="none" stroke={color} strokeWidth="13" strokeLinecap="round"
                strokeDasharray={C}
                strokeDashoffset={mounted ? C * (1 - (score ?? 0) / 100) : C}
                style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(.2,.8,.2,1)' }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <div className="flex items-baseline gap-0.5 font-johnson-display font-bold text-jj-gray-08">
                <span style={{ fontSize: 46, lineHeight: 1 }}>{score === null ? '—' : shown}</span>
                <span className="text-jj-gray-05" style={{ fontSize: 18 }}>%</span>
              </div>
              <span className="font-johnson-text text-jj-gray-06" style={{ fontSize: 10.5, letterSpacing: '.08em', marginTop: 2 }}>
                PASS RATE
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-3.5 min-w-0">
            <div>
              <p className="m-0 font-johnson-text text-[11px] text-jj-gray-06">vs previous run</p>
              <p
                className="m-0 mt-1 font-johnson-display text-xl font-bold leading-none"
                style={{ color: delta === null ? '#a39992' : delta >= 0 ? '#2f9e50' : '#d94e0f' }}
              >
                {delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta} pts`}
              </p>
            </div>
            <div>
              <p className="m-0 font-johnson-text text-[11px] text-jj-gray-06">Target</p>
              <p className="m-0 mt-1 font-johnson-display text-xl font-bold leading-none text-jj-gray-08">{TARGET}%</p>
            </div>
            <div>
              <p className="m-0 font-johnson-text text-[11px] text-jj-gray-06">Rules below target</p>
              <p className="m-0 mt-1 font-johnson-display text-xl font-bold leading-none" style={{ color: '#d94e0f' }}>
                {belowTarget}
              </p>
            </div>
          </div>
        </div>

        <div className="flex gap-2.5 mt-5 pt-4" style={{ borderTop: '1px solid rgba(0,0,0,0.08)' }}>
          <Stat label="Components" value={components} valueColor="#312c2a" />
          <Stat label="Domains" value={domains} valueColor="#312c2a" />
          <Stat label="Active rules" value={rules} valueColor="#312c2a" />
        </div>
      </div>
    </div>
  );
}

/* ── Pass rate over time ───────────────────────────────────────────────── */

// Placeholder bars so the trend card reads as "chart loading" instead of a
// blank panel during the second or so before history lands.
const SKELETON_HEIGHTS = [58, 72, 64, 81, 69, 88, 76, 62, 84, 71];
const SHIMMER = {
  background: 'linear-gradient(90deg, #f0eeec 25%, #e4e1de 50%, #f0eeec 75%)',
  backgroundSize: '200% 100%',
  animation: 'exec-shimmer 1.4s linear infinite',
};

function TrendSkeleton({ labelH }) {
  return (
    <>
      <div className="relative flex-1 min-h-0" style={{ minHeight: 118 + labelH, marginTop: 14 }}>
        <div className="absolute left-0 right-0" style={{ top: labelH, bottom: 0 }}>
          <div className="absolute left-0 right-0" style={{ bottom: `${TARGET}%`, borderTop: '1px dashed #e0dcd8' }} />
          <div className="absolute left-0 right-0" style={{ bottom: `${FLOOR}%`, borderTop: '1px dashed #e0dcd8' }} />
        </div>
        <div className="flex gap-3.5 h-full">
          {SKELETON_HEIGHTS.map((h, i) => (
            <div key={i} className="flex flex-col h-full" style={{ flex: 1, maxWidth: 46 }}>
              <div className="flex justify-center" style={{ height: labelH, alignItems: 'center' }}>
                <span style={{ ...SHIMMER, width: 22, height: 9, borderRadius: 2, display: 'block' }} />
              </div>
              <div className="flex-1 flex flex-col justify-end items-center">
                <div style={{ ...SHIMMER, width: '95%', height: `${h}%`, borderRadius: '5px 5px 2px 2px' }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex gap-3.5 mt-2">
        {SKELETON_HEIGHTS.map((_, i) => (
          <span key={i} className="flex justify-center" style={{ flex: 1, maxWidth: 46 }}>
            <span style={{ ...SHIMMER, width: 26, height: 8, borderRadius: 2, display: 'block' }} />
          </span>
        ))}
      </div>
    </>
  );
}

function TrendBars({ series, scopeLabel, loading, failed }) {
  const points = useMemo(() => series.slice(-10), [series]);
  const mounted = useMounted([points.map(p => p.date).join('|')]);

  const LABEL_H = 18;   // the % caption sits in its own strip above the plot

  return (
    <div
      className="relative overflow-hidden h-full flex flex-col bg-white border border-jj-gray-02 rounded-2xl px-5 pt-4 pb-3.5"
      style={{ animation: 'exec-rise .5s .24s cubic-bezier(.2,.8,.2,1) both' }}
    >
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h3 className="m-0 font-johnson-display text-[15px] font-bold text-jj-gray-08">Pass rate over time</h3>
          <p className="m-0 mt-1 font-johnson-text text-xs text-jj-gray-06">{scopeLabel}</p>
        </div>
        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          <div className="flex items-center gap-3.5 font-johnson-text text-[11px] text-jj-gray-06">
            <span className="flex items-center gap-1.5">
              <span style={{ width: 14, borderTop: '1px dashed #328714' }} />Target {TARGET}%
            </span>
            <span className="flex items-center gap-1.5">
              <span style={{ width: 14, borderTop: '1px dashed #0f68b2' }} />Floor {FLOOR}%
            </span>
          </div>
          <div className="flex items-center gap-3 font-johnson-text text-[11px] text-jj-gray-06">
            {PASS_BANDS.map(b => (
              <span key={b.label} className="flex items-center gap-1.5">
                <span style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: b.color }} />{b.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {loading && points.length === 0 ? (
        <TrendSkeleton labelH={LABEL_H} />
      ) : points.length === 0 ? (
        <div
          className="flex-1 flex items-center justify-center font-johnson-text text-xs text-jj-gray-05 text-center px-6"
          style={{ minHeight: 118, marginTop: 14 }}
        >
          {failed
            ? 'Trend history could not be loaded. The rule trends view may be unavailable.'
            : 'No run history recorded for this scope yet.'}
        </div>
      ) : (
        <>
          <div className="relative flex-1 min-h-0" style={{ minHeight: 118 + LABEL_H, marginTop: 14 }}>
            {/* Reference lines cover the plot area only, so they line up with the bars. */}
            <div className="absolute left-0 right-0" style={{ top: LABEL_H, bottom: 0 }}>
              <div className="absolute left-0 right-0" style={{ bottom: `${TARGET}%`, borderTop: '1px dashed #328714', opacity: .7 }} />
              <div className="absolute left-0 right-0" style={{ bottom: `${FLOOR}%`, borderTop: '1px dashed #0f68b2', opacity: .5 }} />
            </div>
            <div className="flex gap-3.5 h-full">
              {points.map((p, i) => (
                <div
                  key={p.date}
                  className="flex flex-col h-full"
                  style={{ flex: 1, maxWidth: 46 }}
                  title={`${monthLabel(p.date)} · ${p.pass_percentage}%${p.rules > 1 ? ` (avg of ${p.rules} rules)` : ''}${p.partial ? ' — partial run' : ''}`}
                >
                  <span
                    className="font-johnson-display text-[11px] font-bold text-center"
                    style={{
                      height: LABEL_H,
                      lineHeight: `${LABEL_H}px`,
                      color: passColor(p.pass_percentage),
                      opacity: mounted ? 1 : 0,
                      transition: `opacity .5s ease ${i * 0.04}s`,
                    }}
                  >
                    {Math.round(p.pass_percentage)}%
                  </span>
                  <div className="flex-1 flex flex-col justify-end items-center">
                    <div
                      style={{
                        width: '95%',
                        height: `${mounted ? clampPct(p.pass_percentage) : 0}%`,
                        borderRadius: '5px 5px 2px 2px',
                        backgroundColor: passColor(p.pass_percentage),
                        transition: `height .9s cubic-bezier(.2,.8,.2,1) ${i * 0.05}s`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="flex gap-3.5 mt-2">
            {points.map(p => (
              <span key={p.date} className="text-center font-johnson-text text-[10.5px] text-jj-gray-06" style={{ flex: 1, maxWidth: 46 }}>
                {monthLabel(p.date)}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Stat cards ────────────────────────────────────────────────────────── */

function StatCard({ label, value, valueColor = '#312c2a', suffix, delay = 0, children }) {
  return (
    <div
      className="bg-white border border-jj-gray-02 rounded-2xl px-5 py-4"
      style={{ animation: `exec-rise .5s ${delay}s cubic-bezier(.2,.8,.2,1) both` }}
    >
      <p className="m-0 font-johnson-text text-[11px] font-bold uppercase tracking-[.1em] text-jj-gray-06">{label}</p>
      <div className="flex items-end gap-2 mt-2.5">
        <span className="font-johnson-display text-[32px] font-bold leading-none" style={{ color: valueColor }}>{value}</span>
        {suffix && <span className="font-johnson-text text-xs text-jj-gray-06 pb-1">{suffix}</span>}
      </div>
      {children}
    </div>
  );
}

/* ── Dimension rail ─────────────────────────────────────────────────────── */

function DimensionCard({ label, avg, meta, selected, onClick, compact = false }) {
  const color = passColor(avg);
  const pad = compact ? 'px-4 pt-4' : 'px-5 pt-5';
  return (
    <button
      onClick={onClick}
      className={`relative overflow-hidden block w-full h-full text-left bg-white rounded-2xl ${pad} pb-0 flex flex-col`}
      style={{
        border: `1px solid ${selected ? 'rgba(235,23,0,0.32)' : '#e8e6e3'}`,
        boxShadow: selected ? '0 12px 28px rgba(49,44,42,0.10)' : '0 1px 2px rgba(49,44,42,0.03)',
        transform: selected ? 'translateY(-3px)' : 'none',
        transition: 'transform .22s cubic-bezier(.2,.8,.2,1), box-shadow .22s ease, border-color .22s ease',
      }}
    >
      <span
        className="absolute top-0 left-0 right-0 rounded-t-2xl"
        style={{ height: 3, backgroundColor: color, opacity: selected ? 1 : .7, transition: 'opacity .2s ease' }}
      />

      <div className="flex items-start justify-between gap-2.5">
        <span
          className="font-johnson-display font-bold text-jj-gray-08 truncate"
          style={{ fontSize: compact ? 14.5 : 17 }}
          title={label}
        >
          {label}
        </span>
        <span
          className="flex-shrink-0 flex items-center justify-center rounded-lg border border-jj-gray-02"
          style={{ width: compact ? 24 : 28, height: compact ? 24 : 28 }}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M2.5 11.5L11.5 2.5M11.5 2.5H4.5M11.5 2.5V9.5" stroke="#8c8377" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>

      <p className="m-0 mt-1.5 font-johnson-text text-jj-gray-05" style={{ fontSize: compact ? 11.5 : 12.5 }}>{meta}</p>

      <p
        className="m-0 mt-2.5 font-johnson-display font-bold leading-none"
        style={{ color, fontSize: compact ? 26 : 32 }}
      >
        {avg === null ? '—' : `${avg}%`}
      </p>

      <div
        className={`flex items-center justify-between gap-2 mt-auto ${compact ? 'pt-3 -mx-4 px-4 py-2' : 'pt-4 -mx-5 px-5 py-2.5'}`}
        style={{ borderTop: '1px solid #f1efed', backgroundColor: '#fbfaf9' }}
      >
        <span className="font-johnson-text font-bold text-jj-gray-08" style={{ fontSize: compact ? 11 : 12 }}>Click to view trends</span>
        <Ic src={chevronRight} className="w-3 h-3" filter={F.gray07} />
      </div>
    </button>
  );
}

/* ── Drill columns: Component → Domain → Rule ────────────────────────────── */

function DrillItem({ item, selected, onClick, severity, index }) {
  const mounted = useMounted([item.value, item.pass]);
  const color = passColor(item.pass);
  return (
    <button
      onClick={onClick}
      className="relative block w-full text-left rounded-[10px] px-3 py-2.5"
      style={{
        border: `1px solid ${selected ? 'rgba(235,23,0,0.35)' : 'transparent'}`,
        backgroundColor: selected ? '#fdf4f2' : '#ffffff',
        boxShadow: selected ? '0 6px 18px rgba(49,44,42,0.08)' : 'none',
        transform: selected ? 'translateX(2px)' : 'none',
        transition: 'background-color .18s ease, border-color .18s ease, box-shadow .18s ease, transform .18s ease',
        animation: `exec-rise .32s ${Math.min(index * 0.03, 0.3)}s cubic-bezier(.2,.8,.2,1) both`,
      }}
    >
      <span
        className="absolute left-0 rounded-full"
        style={{ top: 10, bottom: 10, width: 3, backgroundColor: selected ? '#eb1700' : 'transparent' }}
      />
      <div className="flex items-center gap-2 min-w-0">
        {severity
          ? <SeverityChip severity={item.severity} compact />
          : <span className="flex-shrink-0" style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: color }} />}
        <span
          className="flex-1 min-w-0 font-johnson-text text-jj-gray-08 truncate"
          style={{ fontSize: severity ? 11.5 : 12.5, fontWeight: selected ? 700 : 400 }}
          title={item.label}
        >
          {item.label}
        </span>
        <span className="font-johnson-display text-[12.5px] font-bold flex-shrink-0" style={{ color }}>
          {item.na ? 'NA' : item.pass === null ? '—' : `${item.pass}%`}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <div className="flex-1 rounded-full bg-jj-gray-01 overflow-hidden" style={{ height: 4 }}>
          <div
            className="h-full rounded-full"
            style={{
              width: `${mounted ? (item.pass ?? 0) : 0}%`,
              backgroundColor: color,
              transition: 'width .9s cubic-bezier(.2,.8,.2,1)',
            }}
          />
        </div>
        <span className="font-johnson-text text-[10.5px] text-jj-gray-05 whitespace-nowrap">{item.meta}</span>
      </div>
    </button>
  );
}

function DrillColumn({ label, items, selected, onPick, emptyText, severity, last }) {
  return (
    <div
      className="min-w-0"
      style={{
        borderRight: last ? 'none' : '1px solid #f1efed',
        animation: 'exec-slide .34s cubic-bezier(.2,.8,.2,1) both',
      }}
    >
      <div className="flex items-baseline justify-between gap-2 px-3.5 pt-3.5 pb-2.5">
        <span className="font-johnson-text text-[10.5px] font-bold uppercase tracking-[.14em] text-jj-gray-06">{label}</span>
        <span className="font-johnson-text text-[11px] text-jj-gray-05">
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </span>
      </div>
      <div className="px-2.5 pb-3.5 flex flex-col gap-1.5" style={{ maxHeight: 392, overflowY: 'auto' }}>
        {items.length === 0
          ? <p className="m-2 mx-3 font-johnson-text text-xs text-jj-gray-05 leading-relaxed">{emptyText}</p>
          : items.map((item, i) => (
              <DrillItem
                key={item.value}
                item={item}
                index={i}
                severity={severity}
                selected={selected === item.value}
                onClick={() => onPick(selected === item.value ? null : item.value)}
              />
            ))}
      </div>
    </div>
  );
}

/* ── Scope / rule panel ────────────────────────────────────────────────── */

function ScoreRing({ score, size = 132, stroke = 12 }) {
  const mounted = useMounted([score]);
  const shown = useCountUp(score ?? 0);
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const color = passColor(score);
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={mounted ? C * (1 - (score ?? 0) / 100) : C}
          style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(.2,.8,.2,1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="flex items-baseline gap-0.5 font-johnson-display font-bold text-jj-gray-08">
          <span style={{ fontSize: Math.round(size * 0.29), lineHeight: 1 }}>{score === null ? '—' : shown}</span>
          <span className="text-jj-gray-05" style={{ fontSize: Math.round(size * 0.12) }}>%</span>
        </div>
        <span className="font-johnson-text text-jj-gray-06" style={{ fontSize: 10, letterSpacing: '.08em', marginTop: 2 }}>
          PASS RATE
        </span>
      </div>
    </div>
  );
}

function ScopePanel({ rule, scoped, scopeTitle, scopeDelta, series, seriesLoading, seriesFailed, onPickRule, deltaMode, activeDim, onPickDim }) {
  const list = rule ? [rule] : scoped;
  const pct = avgOf(list);
  const mounted = useMounted([rule ? rule.rule_id : scopeTitle, pct]);
  const recent = useMemo(() => series.slice(-14), [series]);

  // Dimension breakdown of whatever is currently in scope. Hidden once a
  // single rule is selected — one rule is one dimension, nothing to split.
  const scopeDims = useMemo(() => {
    if (rule) return [];
    const g = {};
    scoped.forEach(r => { const d = dimensionOf(r); (g[d] = g[d] || []).push(r); });
    return Object.entries(g)
      .map(([label, rows]) => {
        const subs = new Set(rows.map(r => r.domain || 'Unassigned')).size;
        return { label, avg: avgOf(rows), meta: `${subs} sub-domain${subs === 1 ? '' : 's'}` };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [scoped, rule]);

  const attention = useMemo(
    () => scoped
      .map(r => ({ r, n: numOrNull(r.pass_percentage) }))
      .filter(x => x.n !== null)
      .sort((a, b) => a.n - b.n)
      .slice(0, 6)
      .map(x => x.r),
    [scoped]
  );

  const detailRows = rule ? [
    ['Rule ID',      rule.rule_id],
    ['Severity',     rule.severity],
    ['Target table', rule.target_table],
    ['Component',    rule.component_name],
    ['Connection',   rule.connection_type],
    ['Rule type',    rule.rule_type],
    ['Cadence',      deltaMode ? 'Semi-Monthly' : 'Quarterly'],
  ].filter(([, v]) => v) : [];

  return (
    <div className="bg-white border border-jj-gray-02 rounded-[20px] overflow-hidden">
      <div className="px-6 pt-5 pb-5 border-b border-jj-gray-01" style={{ paddingTop: 22 }}>
        <p className="m-0 font-johnson-text text-xs font-bold uppercase tracking-[.14em] text-jj-gray-06">
          {rule ? 'Selected rule' : 'Current scope'}
        </p>
        <h3 className="m-0 mt-2.5 font-johnson-display text-2xl font-bold leading-tight text-jj-gray-08">
          {rule ? (rule.rule_title || rule.rule_id) : scopeTitle}
        </h3>
        <p className="m-0 mt-2 font-johnson-text text-sm text-jj-gray-06 leading-relaxed">
          {rule
            ? `${rule.component_name || 'Unassigned'} › ${rule.domain || 'Unassigned'}`
            : `${scoped.length} ${scoped.length === 1 ? 'rule' : 'rules'} in scope`}
        </p>
        <div className="flex items-center gap-6 mt-5">
          <div className="flex flex-col items-center gap-2.5 flex-shrink-0">
            <ScoreRing score={pct} />
            {scopeDelta !== null && (
              <span
                className="font-johnson-text text-xs font-bold rounded-md px-2.5 py-1.5"
                style={{
                  color: scopeDelta >= 0 ? '#328714' : '#eb1700',
                  backgroundColor: scopeDelta >= 0 ? 'rgba(50,135,20,0.08)' : 'rgba(235,23,0,0.08)',
                }}
              >
                {scopeDelta >= 0 ? '+' : ''}{scopeDelta} pts vs previous
              </span>
            )}
          </div>

          {scopeDims.length > 0 && (
            <div
              className="flex-1 min-w-0 grid gap-2.5"
              style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))', justifyItems: 'stretch' }}
            >
              {scopeDims.slice(0, 6).map(d => (
                <DimensionCard
                  key={d.label}
                  compact
                  label={d.label}
                  avg={d.avg}
                  meta={d.meta}
                  selected={activeDim === d.label}
                  onClick={() => onPickDim && onPickDim(activeDim === d.label ? null : d.label)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {rule ? (
        <div className="px-6 pt-5 pb-6">
          {rule.rule_description && (
            <p className="m-0 mb-4 font-johnson-text text-sm leading-relaxed text-jj-gray-08">{rule.rule_description}</p>
          )}
          {detailRows.map(([label, value]) => (
            <div key={label} className="flex gap-3 py-3 border-t border-jj-gray-01">
              <span className="font-johnson-text text-sm text-jj-gray-06 flex-shrink-0" style={{ width: 124 }}>{label}</span>
              <span className="flex-1 font-johnson-text text-sm font-bold text-jj-gray-08 break-words">{value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-6 pt-5 pb-6">
          <p className="m-0 mb-3.5 font-johnson-text text-xs font-bold uppercase tracking-[.14em] text-jj-gray-06">
            Needs attention
          </p>
          {attention.length === 0 ? (
            <p className="m-0 font-johnson-text text-xs text-jj-gray-05">No scored rules in this scope yet.</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {attention.map(r => (
                <button
                  key={r.rule_id}
                  onClick={() => onPickRule(r)}
                  className="flex flex-col items-stretch gap-2 w-full text-left px-4 py-3.5 rounded-xl bg-white border border-jj-gray-02"
                  style={{ transition: 'border-color .18s ease, transform .18s ease' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#cbc4bc'; e.currentTarget.style.transform = 'translateX(2px)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#e8e6e3'; e.currentTarget.style.transform = 'none'; }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <SeverityChip severity={r.severity} compact />
                    <span className="flex-1 font-johnson-text text-sm font-bold text-jj-gray-08 truncate">
                      {dimensionOf(r)} · {r.domain || 'Unassigned'}
                    </span>
                    <span className="font-johnson-display text-base font-bold flex-shrink-0" style={{ color: passColor(Number(r.pass_percentage)) }}>
                      {Math.round(Number(r.pass_percentage))}%
                    </span>
                  </div>
                  <span className="font-johnson-text text-xs text-jj-gray-06 truncate">
                    {(r.component_name || 'Unassigned')} › {(r.domain || 'Unassigned')}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="px-6 pb-6">
        <p className="m-0 mb-2 font-johnson-text text-[10.5px] font-bold uppercase tracking-[.14em] text-jj-gray-06">
          {rule ? 'Rule history' : 'Scope history'}
        </p>
        {seriesLoading && recent.length === 0 ? (
          <div style={{ height: 96 }} />
        ) : recent.length === 0 ? (
          <p className="m-0 font-johnson-text text-xs text-jj-gray-05" style={{ minHeight: 96 }}>
            {seriesFailed
              ? 'Trend history unavailable.'
              : 'No run history recorded for this scope yet.'}
          </p>
        ) : (
          <>
            <div className="flex gap-1.5" style={{ height: 96 }}>
              {recent.map(p => (
                <div key={p.date} className="flex flex-col h-full" style={{ flex: 1, maxWidth: 44 }}>
                  <span
                    className="font-johnson-display text-[9.5px] font-bold text-center"
                    style={{ height: 14, lineHeight: '14px', color: passColor(p.pass_percentage) }}
                  >
                    {Math.round(p.pass_percentage)}%
                  </span>
                  <div className="flex-1 flex flex-col justify-end">
                    <div
                      className="rounded-t"
                      title={`${monthLabel(p.date)} · ${p.pass_percentage}%${p.partial ? ' — partial run' : ''}`}
                      style={{
                        height: `${mounted ? Math.max(4, clampPct(p.pass_percentage)) : 0}%`,
                        backgroundColor: passColor(p.pass_percentage),
                        opacity: .9,
                        transition: 'height .8s cubic-bezier(.2,.8,.2,1)',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-1.5 mt-1.5">
              {recent.map(p => (
                <span
                  key={p.date}
                  className="text-center font-johnson-text text-[10px] text-jj-gray-06"
                  style={{ flex: 1, maxWidth: 44 }}
                >
                  {monthLabel(p.date)}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function ExecutiveView({
  embedded = false,
  showHeader = !embedded,
  deltaMode = false,
  onDeltaModeChange,
  onExitExec,
  onBack,
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [phase, setPhase] = useState(0);

  const replayTimer = useRef(null);

  // Refresh: drop every bar/ring/counter to zero, then reload and rise again.
  const handleRefresh = () => {
    if (refreshing) return;
    clearTrendCache();
    setRefreshing(true);
    setPhase(1);
    clearTimeout(replayTimer.current);
    replayTimer.current = setTimeout(() => { setPhase(0); setRefreshKey(k => k + 1); }, 620);
  };

  useEffect(() => () => clearTimeout(replayTimer.current), []);
  const [rules, setRules]     = useState([]);
  // Domains parked in DQ_RULE_INPUT with no rule yet (RULE_ID null). Shown as NA.
  const [emptyDomains, setEmptyDomains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Drill state — the Domain → Rule hierarchy.
  const [dim, setDim]   = useState(null);
  const [dom, setDom]   = useState(null);
  const [ruleId, setRuleId] = useState(null);

  const [history, setHistory] = useState({});
  const cadenceRef = useRef(deltaMode);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyFailed, setHistoryFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([fetchRuleInput(), fetchRuleStats(deltaMode).catch(() => ({}))])
      .then(([input, stats]) => {
        if (cancelled) return;
        const active = input.filter(r => isTrue(r.is_active));
        const real = active.filter(r => r.rule_id);
        const used = new Set(real.map(r => r.domain || 'Unassigned'));
        setEmptyDomains([...new Set(active.filter(r => !r.rule_id && r.domain).map(r => r.domain))].filter(d => !used.has(d)));
        setRules(real.map(r => ({
          ...r,
          // /api/rules is the source of truth for severity + latest score;
          // fall back to the rule-input row when a column is present there.
          severity: stats[r.rule_id]?.severity ?? r.severity ?? null,
          rule_title: stats[r.rule_id]?.rule_title ?? r.rule_title ?? null,
          rule_description: stats[r.rule_id]?.rule_description ?? r.rule_description ?? '',
          target_table: stats[r.rule_id]?.target_table ?? r.target_table ?? null,
          pass_percentage: stats[r.rule_id]?.pass_percentage ?? null,
          status: stats[r.rule_id]?.status ?? null,
        })));
      })
      .catch(() => { if (!cancelled) setError('Failed to load rule inventory.'); })
      .finally(() => { if (!cancelled) { setLoading(false); setRefreshing(false); } });

    return () => { cancelled = true; };
  }, [refreshKey, deltaMode]);

  // Load every rule's trend once; enterprise and scope series are averaged
  // out of this map, so drilling never refetches.
  useEffect(() => {
    if (!rules.length) { setHistory({}); setHistoryLoading(false); setHistoryFailed(false); return; }
    let cancelled = false;
    setHistoryLoading(true);
    // Only wipe on a cadence switch — quarterly numbers must not sit under a
    // semi-monthly label. A plain refresh keeps the old bars up until the new
    // ones land, otherwise every chart blinks out for a second.
    if (cadenceRef.current !== deltaMode) {
      setHistory({});
      cadenceRef.current = deltaMode;
    }
    const ids = rules.map(r => r.rule_id);
    let errors = 0;
    mapLimit(ids, 6, id =>
      loadTrend(id, deltaMode)
        .then(d => [id, d])
        .catch(() => { errors += 1; return [id, []]; }))
      .then(pairs => {
        if (cancelled) return;
        setHistory(Object.fromEntries(pairs));
        // Every call failing means the trends view itself is gone, not that
        // these rules have no history. Say so rather than showing blank charts.
        setHistoryFailed(errors === ids.length);
      })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [rules, deltaMode]);

  const clearAll = () => { setDim(null); setDom(null); setRuleId(null); };

  /* Scoping ------------------------------------------------------------- */
  const byDim = useMemo(() => rules.filter(r => !dim || dimensionOf(r) === dim), [rules, dim]);
  const byDom  = useMemo(() => byDim.filter(r => !dom || (r.domain || 'Unassigned') === dom), [byDim, dom]);
  const scoped = byDom;

  const rollup = (list, key, metaFn) => {
    const g = {};
    list.forEach(r => { const v = r[key] || 'Unassigned'; (g[v] = g[v] || []).push(r); });
    return Object.entries(g)
      .map(([value, rows]) => ({ value, label: value, pass: avgOf(rows), meta: metaFn(rows) }))
      .sort((a, b) => (a.pass ?? 101) - (b.pass ?? 101));
  };

  const domainItems = useMemo(
    () => [
      ...rollup(byDim, 'domain', rows => `${rows.length} ${rows.length === 1 ? 'rule' : 'rules'}`),
      ...(dim ? [] : emptyDomains.map(d => ({ value: d, label: d, pass: null, na: true, meta: '0 rules' }))),
    ],
    [byDim, dim, emptyDomains]
  );
  const ruleItems = useMemo(
    () => dom
      ? byDom.map(r => ({
          value: r.rule_id,
          label: `${dimensionOf(r)} · ${r.rule_id}`,
          pass: r.pass_percentage === null || r.pass_percentage === undefined ? null : Math.round(Number(r.pass_percentage)),
          meta: r.status || '',
          severity: r.severity,
        })).sort((a, b) => (a.pass ?? 101) - (b.pass ?? 101))
      : [],
    [byDom, dom]
  );

  const dimensions = useMemo(() => {
    const g = {};
    rules.forEach(r => { const c = dimensionOf(r); (g[c] = g[c] || []).push(r); });
    return Object.entries(g)
      .map(([label, rows]) => {
        const domainCount = new Set(rows.map(r => r.domain || 'Unassigned')).size;
        return {
          label,
          avg: avgOf(rows),
          meta: `${domainCount} sub-domain${domainCount === 1 ? '' : 's'}`,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rules]);

  const selectedRule = useMemo(() => rules.find(r => r.rule_id === ruleId) || null, [rules, ruleId]);

  /* Series -------------------------------------------------------------- */
  const seriesFor = (list) => averageSeries(list.map(r => history[r.rule_id] || []));
  const enterpriseSeries = useMemo(() => seriesFor(rules), [rules, history]);
  const scopeSeries      = useMemo(() => seriesFor(selectedRule ? [selectedRule] : scoped), [scoped, selectedRule, history]);

  // Two adjacent buckets can hold different rule populations (rules run on
  // different dates). Comparing a full run against a one-rule straggler
  // produces a headline swing that means nothing, so skip partial buckets.
  const deltaOf = (series) => {
    const solid = series.filter(p => !p.partial);
    if (solid.length < 2) return null;
    const a = solid[solid.length - 2].pass_percentage;
    const b = solid[solid.length - 1].pass_percentage;
    return Math.round((b - a) * 10) / 10;
  };

  const score = avgOf(rules);
  const domainStats = useMemo(() => {
    const g = {};
    rules.forEach(r => { const v = r.domain || 'Unassigned'; (g[v] = g[v] || []).push(r); });
    return [
      ...Object.entries(g).map(([d, rows]) => ({ domain: d, pass: avgOf(rows) })),
      ...emptyDomains.map(d => ({ domain: d, pass: null, na: true })),
    ];
  }, [rules, emptyDomains]);
  // No CRITICAL rules exist in every instance, so treat HIGH as at-risk too.
  const escalated = rules.filter(r => ['CRITICAL', 'HIGH'].includes(String(r.severity || '').toUpperCase()));
  const escalatedAtRisk = escalated.filter(r => r.pass_percentage !== null && Number(r.pass_percentage) < TARGET).length;
  const hasSeverity = rules.some(r => r.severity);
  const belowFloor = rules.filter(r => r.pass_percentage !== null && Number(r.pass_percentage) < FLOOR).length;
  const pipsMounted = useMounted([domainStats.length]);

  const scopeTitle = dom || (dim ? `${dim} checks` : 'Global Regulatory Affairs');
  const scopeLabel = `${scopeTitle} · ${scoped.length} ${scoped.length === 1 ? 'rule' : 'rules'} · ${deltaMode ? 'semi-monthly' : 'quarterly'} runs`;

  const crumbs = [
    { label: dim ? `${dim} checks` : 'All checks', onClick: clearAll },
    ...(dom ? [{ label: dom, onClick: () => setRuleId(null) }] : []),
    ...(ruleId ? [{ label: ruleId, onClick: () => {} }] : []),
  ];

  const dirty = !!(dim || dom || ruleId);

  const lastRunLabel = enterpriseSeries.length
    ? dayLabel(enterpriseSeries[enterpriseSeries.length - 1].date)
    : null;

  if (loading && !rules.length) {
    return (
      <div className={`flex items-center justify-center ${embedded ? 'flex-1 min-h-0' : 'h-full'} bg-jj-gray-01`}>
        <LoadingSpinner />
      </div>
    );
  }
  if (error)         return <div className="bg-jj-gray-01 h-full"><EmptyState title="Error loading data" message={error} /></div>;
  if (!rules.length) return <div className="bg-jj-gray-01 h-full"><EmptyState title="No rules found" message="No active rules are configured in DQ_RULE_INPUT." /></div>;

  return (
    <ReplayContext.Provider value={phase}>
    <div className={`flex flex-col ${embedded ? 'flex-1 min-h-0' : 'h-full'} bg-jj-gray-01`}>
      <style>{KEYFRAMES}</style>

      {showHeader && (
        <div className="flex items-center justify-between gap-6 px-7 bg-white border-b border-jj-gray-02" style={{ height: 62 }}>
          <div className="flex items-center gap-4 min-w-0">
            <img src={logoSrc} alt="GRA SmartHub" style={{ height: 26, width: 'auto', display: 'block', flexShrink: 0 }} />
            <div className="flex items-center gap-2 font-johnson-text text-[12.5px] text-jj-gray-06 min-w-0">
              <span>Data Quality Engine</span>
              <span className="text-jj-gray-04">/</span>
              <span>Business Defined Checks</span>
              <span className="text-jj-gray-04">/</span>
              <span className="text-jj-gray-08 font-bold">Executive View</span>
            </div>
          </div>

          <div className="flex items-center gap-3.5">
            <div className="flex items-center gap-1.5 font-johnson-text text-xs text-jj-gray-06">
              <span className="relative flex" style={{ width: 7, height: 7 }}>
                <span className="absolute inset-0 rounded-full" style={{ backgroundColor: '#328714', animation: 'exec-pulse 2.6s ease-out infinite' }} />
                <span className="relative rounded-full" style={{ width: 7, height: 7, backgroundColor: '#328714' }} />
              </span>
              {lastRunLabel ? `Last run ${lastRunLabel}` : (deltaMode ? 'Semi-Monthly data' : 'Quarterly data')}
            </div>

            {/* Cadence toggle — the parent (BusinessDefinedChecks) owns delta mode. */}
            <div className="flex p-[3px] rounded-full bg-jj-gray-01 border border-jj-gray-02">
              {[['Quarterly', false], ['Semi-Monthly', true]].map(([label, isDelta]) => {
                const on = deltaMode === isDelta;
                return (
                  <button
                    key={label}
                    onClick={() => onDeltaModeChange && onDeltaModeChange(isDelta)}
                    className="px-3.5 py-1.5 rounded-full font-johnson-text text-xs"
                    style={{
                      fontWeight: on ? 700 : 400,
                      color: on ? '#ffffff' : '#81766f',
                      backgroundColor: on ? '#312c2a' : 'transparent',
                      cursor: onDeltaModeChange ? 'pointer' : 'default',
                      transition: 'background-color .2s ease, color .2s ease',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <button
              onClick={handleRefresh}
              className="flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-jj-gray-03 bg-white hover:border-jj-red hover:text-jj-red font-johnson-text text-[12.5px] text-jj-gray-08"
              style={{ transition: 'border-color .18s ease, color .18s ease' }}
            >
              <span
                style={{
                  width: 11, height: 11, borderRadius: '50%', display: 'inline-block',
                  border: '2px solid #d5cfc9', borderTopColor: '#eb1700',
                  animation: refreshing ? 'exec-spin .7s linear infinite' : 'none',
                }}
              />
              Refresh
            </button>

            {onExitExec && (
              <button
                onClick={onExitExec}
                title="Back to the full Business Defined Checks workspace"
                className="flex items-center gap-2 px-3.5 py-1.5 rounded-full font-johnson-text text-[12.5px] font-bold text-white"
                style={{ backgroundColor: '#8c3bbb', transition: 'opacity .18s ease' }}
              >
                Standard View
              </button>
            )}

            {onBack && (
              <button
                onClick={onBack}
                className="flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-jj-gray-03 bg-white hover:border-jj-red hover:text-jj-red font-johnson-text text-[12.5px] text-jj-gray-08"
                style={{ transition: 'border-color .18s ease, color .18s ease' }}
              >
                Switch Check Type
              </button>
            )}
          </div>
        </div>
      )}

      {/* Bars/rings/counters read the replay phase from context. */}
      <div className="flex-1 overflow-auto">
        {/* Hero */}
        <div className="grid gap-4 px-7 pt-6 items-stretch" style={{ gridTemplateColumns: '392px minmax(0,1fr) 560px' }}>
          <HealthPanel
            score={score}
            delta={deltaOf(enterpriseSeries)}
            rules={rules.length}
            domains={domainStats.length}
            components={new Set(rules.map(r => r.component_name || 'Unassigned')).size}
            belowTarget={rules.filter(r => r.pass_percentage !== null && Number(r.pass_percentage) < TARGET).length}
          />

          {/* Check dimensions */}
          <div className="min-w-0 flex flex-col">
            <div className="flex items-baseline justify-between gap-4 mb-3">
              <h2 className="m-0 font-johnson-display text-sm font-bold uppercase tracking-[.1em] text-jj-gray-06">Check dimensions</h2>
              <span className="font-johnson-text text-xs text-jj-gray-05">Select a dimension to scope the hierarchy below</span>
            </div>
            <div
              className="grid gap-2.5 flex-1 min-h-0"
              style={{ gridTemplateColumns: `repeat(${Math.max(Math.min(dimensions.length, 3), 1)}, minmax(0,1fr))` }}
            >
              {dimensions.map(c => (
                <DimensionCard
                  key={c.label}
                  {...c}
                  selected={dim === c.label}
                  onClick={() => { const next = dim === c.label ? null : c.label; clearAll(); setDim(next); }}
                />
              ))}
            </div>

            {/* KPIs sit under the dimension rail, same three columns. */}
            <div className="grid gap-2.5 mt-2.5" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
              <StatCard
                label={hasSeverity ? 'High-severity rules at risk' : `Rules below ${FLOOR}% floor`}
                value={hasSeverity ? escalatedAtRisk : belowFloor}
                valueColor="#eb1700"
                suffix={hasSeverity ? `of ${escalated.length} high or critical` : `of ${rules.length} rules`}
                delay={0.06}
              >
                <div className="h-1.5 rounded-full bg-jj-gray-01 mt-3.5 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: hasSeverity
                        ? `${escalated.length ? Math.round((escalatedAtRisk / escalated.length) * 100) : 0}%`
                        : `${rules.length ? Math.round((belowFloor / rules.length) * 100) : 0}%`,
                      backgroundColor: '#eb1700',
                      transition: 'width 1s cubic-bezier(.2,.8,.2,1)',
                    }}
                  />
                </div>
              </StatCard>

              <StatCard
                label="Rules meeting target"
                value={rules.filter(r => r.pass_percentage !== null && Number(r.pass_percentage) >= TARGET).length}
                valueColor="#328714"
                suffix={`of ${rules.length} rules`}
                delay={0.12}
              >
                <p className="m-0 mt-3.5 font-johnson-text text-xs text-jj-gray-06">
                  {rules.filter(r => r.pass_percentage === null).length} rules not yet scored
                </p>
              </StatCard>

              <StatCard
                label="Domains meeting target"
                value={domainStats.filter(d => d.pass !== null && d.pass >= TARGET).length}
                valueColor="#328714"
                suffix={`of ${domainStats.length} domains`}
                delay={0.18}
              >
                <div className="flex gap-1 mt-3.5">
                  {domainStats.map(d => (
                    <div
                      key={d.domain}
                      title={`${d.domain} · ${d.na ? 'NA' : d.pass === null ? '—' : `${d.pass}%`}`}
                      style={{
                        flex: 1, height: 18, borderRadius: 3,
                        backgroundColor: passColor(d.pass),
                        opacity: pipsMounted ? .9 : .15,
                        transition: 'opacity .7s ease',
                      }}
                    />
                  ))}
                </div>
              </StatCard>
            </div>
          </div>

          {/* Pass rate over time — enterprise-wide until a dimension narrows it. */}
          <div className="min-w-0 flex flex-col">
            <div className="flex items-baseline gap-4 mb-3">
              <h2 className="m-0 font-johnson-display text-sm font-bold uppercase tracking-[.1em] text-jj-gray-06">Trend</h2>
            </div>
            <div className="flex-1 min-h-0">
              <TrendBars series={scopeSeries} scopeLabel={scopeLabel} loading={historyLoading} failed={historyFailed} />
            </div>
          </div>
        </div>

        {/* Drill + scope panel */}
        {/* Rule column only appears once a domain is picked; until then the
            drill card stays narrow and the scope panel takes the room. */}
        <div className="flex gap-4 px-7 py-5 items-start">
          <div
            className="bg-white border border-jj-gray-02 rounded-[20px] overflow-hidden flex-shrink-0"
            style={{
              width: dom ? 'calc(100% - 796px)' : 460,
              transition: 'width .42s cubic-bezier(.2,.8,.2,1)',
            }}
          >
            <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-jj-gray-01">
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                {crumbs.map((c, i) => (
                  <span key={`${c.label}-${i}`} className="flex items-center gap-1.5">
                    {i > 0 && <Ic src={chevronRight} className="w-3 h-3" filter={F.gray06} />}
                    <button
                      onClick={c.onClick}
                      className="px-2.5 py-1 rounded-lg font-johnson-text text-[12.5px]"
                      style={{
                        fontWeight: i === crumbs.length - 1 ? 700 : 400,
                        color: i === crumbs.length - 1 ? '#312c2a' : '#0f68b2',
                        backgroundColor: i === crumbs.length - 1 ? '#f1efed' : 'transparent',
                      }}
                    >
                      {c.label}
                    </button>
                  </span>
                ))}
              </div>
              <button
                onClick={clearAll}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-jj-gray-02 bg-white font-johnson-text text-[11.5px]"
                style={{ color: dirty ? '#eb1700' : '#cbc4bc' }}
              >
                <Ic src={closeSrc} className="w-2.5 h-2.5" filter={dirty ? F.red : F.gray06} />
                Clear selection
              </button>
            </div>

            {/* Rule column stays mounted at zero width so the open/close
                animates instead of popping in. */}
            <div
              className="grid"
              style={{
                gridTemplateColumns: dom ? '1fr 1fr' : '1fr 0fr',
                transition: 'grid-template-columns .42s cubic-bezier(.2,.8,.2,1)',
              }}
            >
              <DrillColumn
                label="Domain" items={domainItems} selected={dom}
                onPick={v => { setDom(v); setRuleId(null); }}
                emptyText="No regulatory domains in this scope."
                last={!dom}
              />
              <div
                className="min-w-0 overflow-hidden"
                style={{
                  opacity: dom ? 1 : 0,
                  pointerEvents: dom ? 'auto' : 'none',
                  transition: 'opacity .3s ease',
                }}
                aria-hidden={!dom}
              >
                <DrillColumn
                  label="Rule" items={ruleItems} selected={ruleId}
                  onPick={v => setRuleId(v)}
                  emptyText="No rules under this domain."
                  severity last
                />
              </div>
            </div>
          </div>

          <div className="flex-1 min-w-0">
          <ScopePanel
            rule={selectedRule}
            scoped={scoped}
            scopeTitle={scopeTitle}
            scopeDelta={deltaOf(scopeSeries)}
            series={scopeSeries}
            seriesLoading={historyLoading}
            seriesFailed={historyFailed}
            deltaMode={deltaMode}
            activeDim={dim}
            onPickDim={d => { clearAll(); setDim(d); }}
            onPickRule={r => {
              setDom(r.domain || 'Unassigned');
              setRuleId(r.rule_id);
            }}
          />
          </div>
        </div>
      </div>
    </div>
    </ReplayContext.Provider>
  );
}