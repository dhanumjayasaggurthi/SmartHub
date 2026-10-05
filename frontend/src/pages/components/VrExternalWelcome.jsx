import React, { useMemo, useState } from 'react';
import { groupByHa, haOf, regionOf, initialsOf, isYes, haColors, NOT_MAPPED } from './vrExternalFacets';

import searchIcon from "/icons/JJ_Icon_Search_RGB.svg";
import globeIcon from "/icons/JJ_Icon_Globe_RGB.svg";
import databaseIcon from "/icons/JJ_Icon_Database_RGB.svg";
import dashboardIcon from "/icons/JJ_Icon_Dashboard_RGB.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import chevronLeftIcon from "/icons/JJ_Icon_Chevron_Left.svg";
import closeIcon from "/icons/JJ_Icon_Close.svg";

// Virtual Regulator -> External landing. Step 1 pick a health authority,
// step 2 pick one of its tables, then the page opens the data for it.
// Everything here comes off /api/vr-external/sources, no extra calls.
//
// Layout: light side panel on the left (intro, search, stats, regions) and a
// card grid on the right that stretches to fill the height, so on a normal
// screen everything fits without scrolling. Below lg it stacks and scrolls.
// HA colours come from haColors() so they match the facet rail.

const TINTS = {
  red: "url(#jj-red-tint)",
  ink: "url(#jj-ink-tint)",
  gray: "url(#jj-gray-tint)",
  white: "url(#jj-white-tint)",
};
const Icon = ({ src, alt = "", className = "w-4 h-4", tint = "red" }) => (
  <img src={src} alt={alt} className={className} style={tint ? { filter: TINTS[tint] } : undefined} />
);

const fmtNum = (n) => Number(n).toLocaleString();
const compact = (n) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const rowsOf = (t) => {
  const n = Number(t.meta?.row_count);
  return t.meta?.row_count !== null && t.meta?.row_count !== '' && Number.isFinite(n) ? n : null;
};

const STYLES = `
@keyframes vrw-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes vrw-shine { from { background-position: -200% 0; } to { background-position: 200% 0; } }
.vrw-rise { animation: vrw-rise .4s cubic-bezier(.2,.7,.3,1) both; }
.vrw-dots { background-image: radial-gradient(rgba(49,44,42,.07) 1px, transparent 1px); background-size: 14px 14px; }
.vrw-shimmer { background: linear-gradient(90deg, #f6f4f2 25%, #eeebe8 50%, #f6f4f2 75%); background-size: 200% 100%; animation: vrw-shine 1.4s linear infinite; }
.vrw-scroll { scrollbar-width: thin; scrollbar-color: #e8e6e3 transparent; }
@media (prefers-reduced-motion: reduce) { .vrw-rise, .vrw-shimmer { animation: none; } }
`;

// "FDA CANADIAN_THERAPEUTICS_PROD_ENG_XML" under "Canadian Therapeutics" -> "Prod ENG XML"
function prettyTable(label, ha) {
  const haWords = String(ha || '').toLowerCase().split(/[\s_-]+/).filter(Boolean);
  let words = String(label || '').replace(/^FDA\s+/i, '').split(/[\s_]+/).filter(Boolean);
  while (words.length && haWords.includes(words[0].toLowerCase())) words = words.slice(1);
  if (!words.length) return 'Main feed';
  return words
    .map(w => (/^(xml|rss|eng|fr|api|eua|usa?|cdc)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

/* ------------------------------ small parts ------------------------------ */

function Chip({ children, tone = 'gray' }) {
  const tones = {
    gray: 'bg-[#f6f4f2] text-jj-gray-07 border-jj-gray-02',
    green: 'bg-[#328714]/[.08] text-[#2a6e12] border-[#328714]/20',
    blue: 'bg-jj-blue-03/[.08] text-jj-blue-03 border-jj-blue-03/20',
    red: 'bg-jj-red/[.07] text-jj-red border-jj-red/20',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-[1px] rounded-full border text-[10.5px] font-johnson-text whitespace-nowrap ${tones[tone]}`}>
      {tone === 'green' && <span className="w-[5px] h-[5px] rounded-full bg-[#328714]" />}
      {children}
    </span>
  );
}

function Badge({ name, color, size = 'md' }) {
  const text = initialsOf(name);
  const box = size === 'lg' ? 'w-14 h-14 rounded-2xl text-[18px]' : 'w-10 h-10 rounded-xl text-[13px]';
  return (
    <span
      className={`flex items-center justify-center flex-shrink-0 font-johnson-display font-bold tracking-wide ${box} ${text.length > 3 ? '!text-[11px]' : ''}`}
      style={{ background: `linear-gradient(135deg, ${color}24, ${color}0a)`, color, boxShadow: `inset 0 0 0 1px ${color}2e` }}
    >
      {text}
    </span>
  );
}

function SearchBox({ value, onChange, placeholder }) {
  return (
    <div className="relative w-full">
      <Icon src={searchIcon} tint="gray" className="absolute left-3.5 top-[12px] w-[13px] h-[13px]" />
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-10 pr-9 py-2.5 rounded-xl border border-jj-gray-02 bg-white font-johnson-text text-[13px] text-jj-gray-08 placeholder:text-jj-gray-05 shadow-[0_1px_2px_rgba(49,44,42,.04)] focus:outline-none focus:border-jj-red/40 focus:ring-4 focus:ring-jj-red/[.08] transition-shadow"
      />
      {value && (
        <button onClick={() => onChange('')} title="Clear" className="absolute right-2.5 top-[9px] p-1.5 rounded-full hover:bg-jj-gray-01">
          <Icon src={closeIcon} tint="gray" className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  );
}

// pastel stat tile
function Tile({ value, label, color, title }) {
  return (
    <div className="rounded-xl px-3.5 py-3 min-w-0" style={{ background: `${color}0f`, boxShadow: `inset 0 0 0 1px ${color}1f` }} title={title}>
      <div className="font-johnson-display font-bold text-[22px] leading-none tabular-nums truncate" style={{ color }}>{value}</div>
      <div className="mt-1.5 text-[10px] font-johnson-text uppercase tracking-wider text-jj-gray-06 truncate">{label}</div>
    </div>
  );
}

// light side panel shell
function Panel({ children }) {
  return (
    <aside className="vrw-rise vrw-scroll lg:w-[330px] xl:w-[350px] flex-shrink-0 relative overflow-hidden lg:overflow-y-auto rounded-[20px] border border-jj-gray-03 bg-white shadow-[0_1px_3px_rgba(49,44,42,.05)]">
      <div className="vrw-dots absolute inset-x-0 top-0 h-[220px] opacity-80 pointer-events-none" style={{ maskImage: 'linear-gradient(to bottom, #000, transparent)', WebkitMaskImage: 'linear-gradient(to bottom, #000, transparent)' }} />
      <div className="absolute -top-20 -right-16 w-[260px] h-[260px] rounded-full bg-jj-red/[.06] blur-3xl pointer-events-none" />
      <div className="absolute top-40 -left-24 w-[240px] h-[240px] rounded-full bg-jj-blue-03/[.05] blur-3xl pointer-events-none" />
      <div className="relative p-6 flex flex-col gap-5">{children}</div>
    </aside>
  );
}

function SectionLabel({ children, right }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10.5px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-06">{children}</span>
      {right}
    </div>
  );
}

// rows grow into the free height up to rowMax, so a handful of cards don't
// turn into tall empty boxes; scrolls only when the cards can't fit
function FillGrid({ children, min = 250, rowMin = 118, rowMax = 172 }) {
  return (
    <div
      className="vrw-scroll flex-1 min-h-0 lg:overflow-y-auto grid gap-3.5 p-[2px] -m-[2px] content-start"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gridAutoRows: `minmax(${rowMin}px, ${rowMax}px)` }}
    >
      {children}
    </div>
  );
}

/* ============================== step 1 ============================== */

function HaPicker({ sources, onPickHa, onOpenSource }) {
  const [q, setQ] = useState('');
  const [region, setRegion] = useState('all');

  const groups = useMemo(() => groupByHa(sources), [sources]);
  const colors = useMemo(() => haColors(sources), [sources]);
  const press = sources.find(s => s.kind === 'press');

  const regions = useMemo(() => {
    const counts = new Map();
    groups.forEach(g => g.regions.forEach(r => counts.set(r, (counts.get(r) || 0) + 1)));
    return [...counts.entries()]
      .sort((a, b) => (a[0] === NOT_MAPPED) - (b[0] === NOT_MAPPED) || b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [groups]);

  const needle = q.trim().toLowerCase();
  const shown = groups.filter(g =>
    (region === 'all' || g.regions.includes(region)) &&
    (!needle || g.name.toLowerCase().includes(needle) || g.tables.some(t => String(t.label).toLowerCase().includes(needle)))
  );
  const tableCount = groups.reduce((n, g) => n + g.tables.length, 0);
  const rowCount = groups.reduce((n, g) => n + g.rows, 0);
  const loadedCount = groups.reduce((n, g) => n + g.tables.filter(t => isYes(t.meta?.loaded)).length, 0);
  const maxTables = Math.max(1, ...groups.map(g => g.tables.length));
  const realRegions = regions.filter(([r]) => r !== NOT_MAPPED).length;

  return (
    <div className="lg:h-full flex flex-col lg:flex-row gap-4 p-5">
      <Panel>
        <div>
          <div className="inline-flex items-center gap-2 px-2.5 py-[3px] rounded-full bg-jj-red/[.07] text-jj-red text-[10.5px] font-johnson-text font-medium tracking-wide">
            <span className="w-1.5 h-1.5 rounded-full bg-jj-red animate-pulse" />
            Virtual Regulator · External
          </div>
          <h2 className="mt-3 font-johnson-display font-bold text-[26px] leading-[1.15] text-jj-gray-08">
            Every regulator feed,{' '}
            <span className="bg-gradient-to-r from-jj-red to-[#ff6017] bg-clip-text text-transparent">one place.</span>
          </h2>
          <p className="mt-2 text-[12.5px] font-johnson-text text-jj-gray-06 leading-relaxed">
            Pick a health authority to browse its feeds, or open the FDA press release dashboard.
          </p>
        </div>

        <SearchBox value={q} onChange={setQ} placeholder="Search an authority or table…" />

        <div className="grid grid-cols-2 gap-2">
          <Tile value={groups.length} label="Authorities" color="#eb1700" />
          <Tile value={tableCount} label="Tables" color="#0f68b2" />
          <Tile value={rowCount ? compact(rowCount) : '—'} label="Rows loaded" color="#328714" title={rowCount ? fmtNum(rowCount) : undefined} />
          <Tile value={`${loadedCount}/${tableCount}`} label="In DH" color="#8c3bbb" />
        </div>

        {press && (
          <button
            onClick={() => (onOpenSource ? onOpenSource(press.id) : onPickHa(haOf(press)))}
            className="group relative overflow-hidden flex items-center gap-3 rounded-2xl px-4 py-3.5 text-left bg-gradient-to-br from-[#fff1ee] to-[#fff8f2] border border-jj-red/20 hover:border-jj-red/45 hover:shadow-[0_8px_22px_rgba(235,23,0,.12)] hover:-translate-y-[1px] transition-all"
          >
            <span className="absolute -right-6 -bottom-10 w-24 h-24 rounded-full bg-jj-red/[.06]" />
            <span className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-white shadow-[0_1px_3px_rgba(235,23,0,.15)]">
              <Icon src={dashboardIcon} tint="red" className="w-[18px] h-[18px]" />
            </span>
            <span className="relative flex-1 min-w-0">
              <span className="block text-[10px] uppercase tracking-wider text-jj-red/80 font-johnson-text font-medium">Featured dashboard</span>
              <span className="block font-johnson-display font-bold text-[14.5px] leading-tight text-jj-gray-08 truncate">{press.label || 'FDA Press Releases'}</span>
            </span>
            <Icon src={chevronRightIcon} tint="red" className="relative w-3 h-3 group-hover:translate-x-1 transition-transform" />
          </button>
        )}

        {regions.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <SectionLabel right={<span className="text-[10.5px] font-johnson-text text-jj-gray-05">{realRegions} {realRegions === 1 ? 'region' : 'regions'}</span>}>Regions</SectionLabel>
            {[['all', groups.length], ...regions].map(([r, n]) => {
              const on = region === r;
              return (
                <button
                  key={r}
                  onClick={() => setRegion(r)}
                  className={`relative flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-colors ${on ? 'bg-jj-red/[.07]' : 'hover:bg-[#f7f5f3]'}`}
                >
                  <Icon src={globeIcon} tint={on ? 'red' : 'gray'} className="w-3 h-3 flex-shrink-0" />
                  <span className={`flex-1 min-w-0 truncate text-[12.5px] font-johnson-text ${on ? 'text-jj-red font-medium' : 'text-jj-gray-07'} ${r === NOT_MAPPED ? 'italic' : ''}`}>
                    {r === 'all' ? 'All regions' : r}
                  </span>
                  <span className={`text-[11px] tabular-nums font-johnson-text ${on ? 'text-jj-red' : 'text-jj-gray-05'}`}>{n}</span>
                </button>
              );
            })}
          </div>
        )}
      </Panel>

      <section className="flex-1 min-w-0 min-h-0 flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3 px-1">
          <div className="flex items-baseline gap-2.5">
            <h3 className="font-johnson-display font-bold text-[18px] text-jj-gray-08">Health authorities</h3>
            <span className="text-[12px] font-johnson-text text-jj-gray-05 tabular-nums">{shown.length} of {groups.length}</span>
          </div>
          {(needle || region !== 'all') && (
            <button onClick={() => { setQ(''); setRegion('all'); }} className="text-[11.5px] font-johnson-text text-jj-blue-03 hover:underline">Reset</button>
          )}
        </div>

        {shown.length === 0 ? (
          <div className="flex-1 min-h-[240px] flex flex-col items-center justify-center bg-white/70 border border-dashed border-jj-gray-03 rounded-[20px] text-center px-5">
            <div className="w-12 h-12 rounded-full bg-jj-red/[.06] flex items-center justify-center">
              <Icon src={searchIcon} tint="red" className="w-5 h-5" />
            </div>
            <div className="mt-3 text-[14px] font-johnson-display font-bold text-jj-gray-08">No health authorities match</div>
            <div className="mt-1 text-[12px] font-johnson-text text-jj-gray-06">Try another name or region.</div>
          </div>
        ) : (
          <FillGrid min={240} rowMin={124} rowMax={164}>
            {shown.map((g, i) => {
              const color = colors.get(g.name) || '#a39992';
              const muted = g.name === NOT_MAPPED;
              return (
                <button
                  key={g.name}
                  onClick={() => onPickHa(g.name)}
                  style={{ animationDelay: `${Math.min(i, 14) * 35}ms`, '--ha': color, '--ha-b': `${color}4d`, background: `linear-gradient(160deg, #fff 55%, ${color}0b)` }}
                  className="vrw-rise group relative overflow-hidden text-left border-[1.5px] border-[color:var(--ha-b)] rounded-[18px] px-4 py-3.5 shadow-[0_1px_3px_rgba(49,44,42,.04)] hover:-translate-y-[2px] hover:shadow-[0_12px_28px_rgba(49,44,42,.10)] hover:border-[color:var(--ha)] transition-all duration-200 flex flex-col"
                >
                  <span className="absolute left-0 top-4 bottom-4 w-[3px] rounded-r-full" style={{ background: color }} />
                  <span className="absolute -right-8 -top-8 w-28 h-28 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-300" style={{ background: `radial-gradient(circle, ${color}1c, transparent 70%)` }} />

                  <div className="relative flex items-start gap-3">
                    <Badge name={g.name} color={color} />
                    <div className="min-w-0 flex-1">
                      <div className={`font-johnson-display font-bold text-[14.5px] leading-snug line-clamp-2 ${muted ? 'italic text-jj-gray-06' : 'text-jj-gray-08'}`} title={g.name}>{g.name}</div>
                      <div className="mt-0.5 text-[11px] font-johnson-text text-jj-gray-05 truncate">{g.regions.join(', ')}</div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="font-johnson-display font-bold text-[22px] leading-none tabular-nums" style={{ color }}>{g.tables.length}</div>
                      <div className="text-[9.5px] font-johnson-text uppercase tracking-wider text-jj-gray-05 mt-1">{g.tables.length === 1 ? 'table' : 'tables'}</div>
                    </div>
                  </div>

                  <div className="flex-1 min-h-[10px]" />
                  <div className="relative h-[4px] rounded-full bg-[#f3f1ef] overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(g.tables.length / maxTables) * 100}%`, background: `linear-gradient(90deg, ${color}99, ${color})` }} />
                  </div>
                  <div className="relative mt-2.5 flex items-center gap-1.5 min-w-0">
                    <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
                      {g.hasRows && <span className="text-[11px] font-johnson-text text-jj-gray-06 tabular-nums whitespace-nowrap" title={`${fmtNum(g.rows)} rows`}>{compact(g.rows)} rows</span>}
                      {g.feeds.slice(0, 2).map(f => <Chip key={f}>{f}</Chip>)}
                      {g.tables.some(t => t.kind === 'press') && <Chip tone="red">Dashboard</Chip>}
                    </div>
                    <span className="flex items-center gap-1 text-[11px] font-johnson-text font-medium flex-shrink-0 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" style={{ color }}>
                      Explore <Icon src={chevronRightIcon} tint="gray" className="w-2.5 h-2.5" />
                    </span>
                  </div>
                </button>
              );
            })}
          </FillGrid>
        )}
      </section>
    </div>
  );
}

/* ============================== step 2 ============================== */

function TablePicker({ ha, sources, onPickTable, onBack }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('rows');
  const tables = useMemo(() => sources.filter(s => haOf(s) === ha), [sources, ha]);
  const color = useMemo(() => haColors(sources).get(ha) || '#a39992', [sources, ha]);
  const website = tables.map(t => t.meta?.website).find(Boolean);
  const regions = [...new Set(tables.map(regionOf))];
  const feeds = [...new Set(tables.map(t => t.meta?.feed).filter(Boolean))];
  const totalRows = tables.reduce((n, t) => n + (rowsOf(t) || 0), 0);
  const loaded = tables.filter(t => isYes(t.meta?.loaded)).length;
  const maxRows = Math.max(1, ...tables.map(t => rowsOf(t) || 0));

  const needle = q.trim().toLowerCase();
  const shown = tables
    .filter(t => !needle || `${t.label} ${t.table} ${prettyTable(t.label, ha)}`.toLowerCase().includes(needle))
    .sort((a, b) => {
      const pressFirst = (b.kind === 'press') - (a.kind === 'press');
      if (pressFirst) return pressFirst;
      return sort === 'rows'
        ? (rowsOf(b) ?? -1) - (rowsOf(a) ?? -1)
        : prettyTable(a.label, ha).localeCompare(prettyTable(b.label, ha));
    });

  return (
    <div className="lg:h-full flex flex-col lg:flex-row gap-4 p-5">
      <Panel>
        <button onClick={onBack} className="self-start inline-flex items-center gap-1.5 px-2.5 py-1 -ml-2.5 -mt-1 rounded-full text-[11.5px] font-johnson-text text-jj-gray-06 hover:text-jj-gray-08 hover:bg-[#f7f5f3] transition-colors">
          <Icon src={chevronLeftIcon} tint="gray" className="w-2.5 h-2.5" />
          All health authorities
        </button>

        <div className="flex items-center gap-3.5">
          <Badge name={ha} color={color} size="lg" />
          <div className="min-w-0">
            <h2 className="font-johnson-display font-bold text-[22px] leading-tight text-jj-gray-08 break-words">{ha}</h2>
            <div className="mt-1 flex items-center gap-1 text-[11.5px] font-johnson-text text-jj-gray-06">
              <Icon src={globeIcon} tint="gray" className="w-[11px] h-[11px]" />{regions.join(', ')}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Tile value={tables.length} label={tables.length === 1 ? 'Table' : 'Tables'} color={color} />
          <Tile value={totalRows ? compact(totalRows) : '—'} label="Rows" color="#0f68b2" title={totalRows ? fmtNum(totalRows) : undefined} />
          <Tile value={`${loaded}/${tables.length}`} label="In DH" color="#328714" />
        </div>

        {(feeds.length > 0 || website) && (
          <div className="flex flex-col gap-2">
            <SectionLabel>Source</SectionLabel>
            <div className="flex items-center gap-1.5 flex-wrap">
              {feeds.map(f => <Chip key={f}>{f} feed</Chip>)}
            </div>
            {website && (
              <a href={website} target="_blank" rel="noreferrer"
                className="group flex items-center gap-2 px-3 py-2.5 rounded-xl border border-jj-gray-02 bg-white hover:border-jj-blue-03/40 hover:bg-jj-blue-03/[.03] transition-colors min-w-0">
                <Icon src={globeIcon} tint="gray" className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="flex-1 min-w-0 truncate text-[12px] font-johnson-text text-jj-blue-03" title={website}>{website.replace(/^https?:\/\//, '')}</span>
                <span className="text-jj-blue-03 text-[12px]">↗</span>
              </a>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <SectionLabel>Find a table</SectionLabel>
          <SearchBox value={q} onChange={setQ} placeholder="Filter tables…" />
          <div className="flex items-center bg-[#f7f5f3] rounded-xl p-[3px] gap-0.5">
            {[['rows', 'Most rows'], ['name', 'A–Z']].map(([id, label]) => (
              <button key={id} onClick={() => setSort(id)}
                className={`flex-1 py-[5px] rounded-[9px] text-[11.5px] font-johnson-text transition-all ${sort === id ? 'bg-white text-jj-red font-medium shadow-[0_1px_3px_rgba(49,44,42,.08)]' : 'text-jj-gray-06 hover:text-jj-gray-08'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </Panel>

      <section className="flex-1 min-w-0 min-h-0 flex flex-col gap-3">
        <div className="flex items-baseline gap-2.5 px-1">
          <h3 className="font-johnson-display font-bold text-[18px] text-jj-gray-08">Pick a table</h3>
          <span className="text-[12px] font-johnson-text text-jj-gray-05 tabular-nums">{shown.length} of {tables.length}</span>
        </div>

        {shown.length === 0 ? (
          <div className="flex-1 min-h-[220px] flex flex-col items-center justify-center bg-white/70 border border-dashed border-jj-gray-03 rounded-[20px] text-center px-5">
            <div className="text-[14px] font-johnson-display font-bold text-jj-gray-08">No tables match "{q.trim()}"</div>
            <button onClick={() => setQ('')} className="mt-2 text-xs font-johnson-text text-jj-blue-03 underline">Clear filter</button>
          </div>
        ) : (
          <FillGrid min={260} rowMin={132} rowMax={168}>
            {shown.map((t, i) => {
              const m = t.meta || {};
              const rows = rowsOf(t);
              const isPress = t.kind === 'press';
              const c = isPress ? '#eb1700' : color;
              return (
                <button
                  key={t.id}
                  onClick={() => onPickTable(t.id)}
                  style={{ animationDelay: `${Math.min(i, 14) * 35}ms`, '--ha': c, '--ha-b': `${c}4d`, background: isPress ? 'linear-gradient(150deg, #fff4f1, #fff9f5)' : `linear-gradient(160deg, #fff 55%, ${c}0b)` }}
                  className={`vrw-rise group relative overflow-hidden text-left rounded-[18px] px-4 py-3.5 border-[1.5px] border-[color:var(--ha-b)] transition-all duration-200 flex flex-col hover:-translate-y-[2px] hover:shadow-[0_12px_28px_rgba(49,44,42,.10)] hover:border-[color:var(--ha)] ${isPress ? '' : 'shadow-[0_1px_3px_rgba(49,44,42,.04)]'}`}
                >
                  <span className="absolute left-0 top-4 bottom-4 w-[3px] rounded-r-full" style={{ background: c }} />
                  <div className="relative flex items-start gap-3">
                    <span className="flex items-center justify-center w-10 h-10 rounded-xl flex-shrink-0" style={{ background: isPress ? '#fff' : `${c}12`, boxShadow: isPress ? '0 1px 3px rgba(235,23,0,.15)' : undefined }}>
                      <Icon src={isPress ? dashboardIcon : databaseIcon} tint="red" className="w-[17px] h-[17px]" />
                    </span>
                    <div className="min-w-0 flex-1">
                      {/* long underscore names wrap anywhere, full label on hover */}
                      <div className="font-johnson-display font-bold text-[14.5px] leading-snug text-jj-gray-08 [overflow-wrap:anywhere] line-clamp-2" title={t.label}>
                        {isPress ? (t.label || 'FDA Press Releases') : prettyTable(t.label, ha)}
                      </div>
                      <div className="mt-0.5 text-[10px] font-mono text-jj-gray-05 truncate" title={t.table || t.label}>
                        {isPress ? 'KPIs · trends · action types · signals' : (t.table || t.label)}
                      </div>
                    </div>
                  </div>

                  <div className="flex-1 min-h-[10px]" />
                  {rows != null && (
                    <>
                      <div className="relative flex items-baseline justify-between">
                        <span className="font-johnson-display font-bold text-[20px] leading-none tabular-nums" style={{ color: c }}>{fmtNum(rows)}</span>
                        <span className="text-[9.5px] font-johnson-text uppercase tracking-wider text-jj-gray-05">rows</span>
                      </div>
                      <div className="relative mt-1.5 h-[4px] rounded-full bg-[#f3f1ef] overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${Math.max(3, (rows / maxRows) * 100)}%`, background: `linear-gradient(90deg, ${c}99, ${c})` }} />
                      </div>
                    </>
                  )}
                  <div className="relative mt-2.5 flex items-center gap-1.5 min-w-0">
                    <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
                      {isPress && <Chip tone="red">Dashboard</Chip>}
                      {m.feed && <Chip>{m.feed}</Chip>}
                      {isYes(m.loaded) && <Chip tone="green">Loaded in DH</Chip>}
                      {isYes(m.cdc) && <Chip tone="blue">CDC</Chip>}
                    </div>
                    <span className="flex items-center gap-1 text-[11px] font-johnson-text font-medium flex-shrink-0 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" style={{ color: c }}>
                      Open <Icon src={chevronRightIcon} tint="gray" className="w-2.5 h-2.5" />
                    </span>
                  </div>
                </button>
              );
            })}
          </FillGrid>
        )}
      </section>
    </div>
  );
}

/* ============================== loading ============================== */

function WelcomeSkeleton() {
  return (
    <div className="lg:h-full flex flex-col lg:flex-row gap-4 p-5" role="status" aria-label="Loading health authorities">
      <div className="lg:w-[330px] xl:w-[350px] flex-shrink-0 rounded-[20px] border border-jj-gray-02 bg-white p-6 space-y-4">
        <div className="vrw-shimmer h-5 w-40 rounded-full" />
        <div className="vrw-shimmer h-7 w-[85%] rounded-lg" />
        <div className="vrw-shimmer h-4 w-full rounded" />
        <div className="vrw-shimmer h-10 w-full rounded-xl" />
        <div className="grid grid-cols-2 gap-2">
          {[0, 1, 2, 3].map(i => <div key={i} className="vrw-shimmer h-[62px] rounded-xl" />)}
        </div>
        <div className="vrw-shimmer h-[68px] w-full rounded-2xl" />
        {[0, 1, 2].map(i => <div key={i} className="vrw-shimmer h-8 w-full rounded-xl" />)}
      </div>
      <div className="flex-1 min-h-0 flex flex-col gap-3">
        <div className="vrw-shimmer h-6 w-52 rounded" />
        <div className="flex-1 grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gridAutoRows: 'minmax(124px, 1fr)' }}>
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="bg-white border-[1.5px] border-jj-gray-02 rounded-[18px] p-4 flex flex-col">
              <div className="flex gap-3">
                <div className="vrw-shimmer w-10 h-10 rounded-xl" />
                <div className="flex-1 space-y-2 pt-1">
                  <div className="vrw-shimmer h-3.5 w-3/4 rounded" />
                  <div className="vrw-shimmer h-3 w-1/2 rounded" />
                </div>
              </div>
              <div className="flex-1" />
              <div className="vrw-shimmer h-[4px] w-full rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================== main ============================== */

export default function VrExternalWelcome({ sources, loading, ha, onPickHa, onPickTable, onOpenSource, onBack }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden">
      <style>{STYLES}</style>
      {loading ? (
        <WelcomeSkeleton />
      ) : ha ? (
        <TablePicker key={ha} ha={ha} sources={sources} onPickTable={onPickTable} onBack={onBack} />
      ) : (
        <HaPicker sources={sources} onPickHa={onPickHa} onOpenSource={onOpenSource} />
      )}
    </div>
  );
}