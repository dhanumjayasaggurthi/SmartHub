import React, { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import { useRBAC } from '../context/RBACContext';

// J&J Custom Icons
import checkCircleIcon from "/icons/JJ_Icon_Check_RGB.svg";
import alertTriangleIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import xCircleIcon from "/icons/JJ_Icon_Close.svg";
import searchIcon from "/icons/JJ_Icon_Search_RGB.svg";
import databaseIcon from "/icons/JJ_Icon_Database_RGB.svg";
import loadingIcon from "/icons/JJ_Icon_Loading.svg";
import chevronDownIcon from "/icons/JJ_Icon_Chevron_Down.svg";
import chevronLeftIcon from "/icons/JJ_Icon_Chevron_Left.svg";
import { apiFetch, apiEventSource, downloadFile } from '../utils/apiClient';

// ─── Design tokens (v2 redesign) ─────────────────────────────────────────────
const C = {
  bg: '#f7f5f3', panel: '#ffffff', panelSoft: '#faf9f8',
  border: '#e8e6e3', borderSoft: '#f1efed', borderInput: '#d5cfc9',
  text: '#312c2a', text2: '#6e6259', muted: '#81766f', faint: '#a39992',
  red: '#eb1700', fail: '#9e0000', warn: '#c94b0c', warnDot: '#ff6017',
  pass: '#328714', blue: '#0f68b2', hl: '#fdf3d7',
};
const font = "'JohnsonText', Arial, sans-serif";
const fontDisplay = "'JohnsonDisplay', Arial, sans-serif";
const label = { fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: C.faint };
const microLabel = { fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.muted };

const DV_KEYFRAMES = `
@keyframes dvExpand { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes dvPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(235,23,0,0.3); } 50% { box-shadow: 0 0 0 5px rgba(235,23,0,0); } }
@keyframes dvFlow { from { background-position: 0 0; } to { background-position: 0 -16px; } }
@keyframes dvStripe { from { background-position: 0 0; } to { background-position: 28px 0; } }
.dv-lift { transition: border-color .2s, transform .2s, box-shadow .2s; }
.dv-lift:hover { border-color: #cbc4bc !important; transform: translateY(-2px); box-shadow: 0 6px 16px rgba(49,44,42,.08); }
.dv-rowbtn { transition: background .2s; }
.dv-rowbtn:hover { background: #faf9f8; }
.dv-runbtn { transition: box-shadow .25s, transform .15s; }
.dv-runbtn:hover:not(:disabled) { box-shadow: 0 5px 22px rgba(235,23,0,.42); transform: translateY(-1px); }
.dv-runbtn:active:not(:disabled) { transform: translateY(0); }
.dv-ghostbtn { transition: border-color .2s, background .2s, transform .15s; }
.dv-ghostbtn:hover { border-color: #a39992; background: #faf9f8; transform: translateY(-1px); }
`;

// ─── Beta badge ──────────────────────────────────────────────────────────────
const SHOW_BETA_BADGE = true;
const BetaBadge = () => {
  if (!SHOW_BETA_BADGE) return null;
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
      padding: '3px 9px', borderRadius: 4, fontFamily: font,
      color: C.red, background: 'rgba(235,23,0,0.07)', border: '1px solid rgba(235,23,0,0.35)',
    }}>Beta</span>
  );
};

// ─── Icon Wrapper ─────────────────────────────────────────────────────────────
const Icon = ({ src, alt, className = "w-6 h-6", color }) => {
  const getColorFilter = (colorClass) => {
    if (!colorClass) return {};
    const c = color || colorClass;
    if (c.includes('jj-green-03') || c.includes('text-green'))
      return { filter: 'brightness(0) saturate(100%) invert(37%) sepia(87%) saturate(1158%) hue-rotate(71deg) brightness(91%) contrast(93%)' };
    if (c.includes('jj-maroon-05') || c.includes('text-red'))
      return { filter: 'brightness(0) saturate(100%) invert(13%) sepia(97%) saturate(6477%) hue-rotate(359deg) brightness(91%) contrast(99%)' };
    if (c.includes('jj-orange-03'))
      return { filter: 'brightness(0) saturate(100%) invert(48%) sepia(97%) saturate(2446%) hue-rotate(347deg) brightness(102%) contrast(105%)' };
    if (c.includes('jj-blue-03'))
      return { filter: 'brightness(0) saturate(100%) invert(37%) sepia(93%) saturate(1535%) hue-rotate(189deg) brightness(91%) contrast(101%)' };
    if (c.includes('jj-red'))
      return { filter: 'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)' };
    if (c.includes('jj-gray-08'))
      return { filter: 'brightness(0) saturate(100%) invert(15%) sepia(7%) saturate(806%) hue-rotate(346deg) brightness(95%) contrast(89%)' };
    if (c.includes('jj-gray-06'))
      return { filter: 'brightness(0) saturate(100%) invert(50%) sepia(6%) saturate(656%) hue-rotate(346deg) brightness(92%) contrast(88%)' };
    if (c.includes('jj-gray-05'))
      return { filter: 'brightness(0) saturate(100%) invert(65%) sepia(6%) saturate(556%) hue-rotate(346deg) brightness(92%) contrast(88%)' };
    if (c.includes('jj-gray-04'))
      return { filter: 'brightness(0) saturate(100%) invert(82%) sepia(6%) saturate(356%) hue-rotate(346deg) brightness(92%) contrast(88%)' };
    if (c.includes('white') || c.includes('invert'))
      return { filter: 'brightness(0) invert(1)' };
    return {};
  };
  return <img src={src} alt={alt} className={className} style={getColorFilter(className)} />;
};

// ─── Constants ────────────────────────────────────────────────────────────────
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const RECENT_RUNS_KEY = 'dv_recent_runs_v2';

const SOURCE_META = {
  insight7:   { label: 'Insight7',   color: 'jj-red' },
  rimdocs:    { label: 'RIMDocs',    color: 'jj-red' },
  snowflake:  { label: 'Snowflake',  color: 'jj-blue-03' },
  postgresql: { label: 'PostgreSQL', color: 'jj-blue-03' },
  docubridge: { label: 'DocuBridge', color: 'jj-blue-03' },
  denodo:     { label: 'Denodo',     color: 'jj-orange-03' },
  sqlserver:  { label: 'Lift',       color: 'jj-maroon-05' },
  grail:      { label: 'Grail',      color: 'jj-maroon-05' },
  databricks: { label: 'Databricks', color: 'jj-orange-03' },
};

// ─── Toast ────────────────────────────────────────────────────────────────────
const Toast = memo(({ message, type = 'success', onClose }) => {
  useEffect(() => {
    const t = setTimeout(onClose, type === 'error' ? 10000 : 5000);
    return () => clearTimeout(t);
  }, [onClose, type]);

  const configs = {
    success: { bg: 'bg-jj-green-03', icon: checkCircleIcon },
    error:   { bg: 'bg-jj-maroon-05', icon: alertTriangleIcon },
    info:    { bg: 'bg-jj-blue-03', icon: checkCircleIcon },
  };
  const { bg, icon } = configs[type] || configs.info;

  return (
    <div className="fixed top-6 right-6 z-[9999] animate-slide-in">
      <div className={`${bg} text-white px-5 py-4 rounded-lg shadow-2xl flex items-center gap-3 min-w-[320px] max-w-md border border-white border-opacity-20`}>
        <Icon src={icon} alt={type} className="w-5 h-5 flex-shrink-0 text-white" />
        <p className="font-johnson-text text-sm flex-1">{message}</p>
        <button onClick={onClose} className="hover:opacity-70 transition-opacity ml-2">
          <Icon src={xCircleIcon} alt="Close" className="w-4 h-4 text-white" />
        </button>
      </div>
    </div>
  );
});
Toast.displayName = 'Toast';

// ─── Error Boundary ───────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error, info) { console.error('DataValidation Error:', error, info); }
  render() {
    if (this.state.hasError) return (
      <div className="min-h-screen flex items-center justify-center bg-jj-gray-01 p-6">
        <div className="bg-white rounded-xl shadow-xl p-8 max-w-lg w-full border-t-4 border-jj-red">
          <div className="flex items-start gap-4 mb-6">
            <div className="w-12 h-12 bg-red-50 rounded-lg flex items-center justify-center flex-shrink-0">
              <Icon src={alertTriangleIcon} alt="Error" className="w-7 h-7 text-jj-maroon-05" />
            </div>
            <div>
              <h2 className="font-johnson-display text-xl text-jj-gray-08 mb-1" style={{ lineHeight: '110%' }}>Something went wrong</h2>
              <p className="font-johnson-text text-sm text-jj-gray-06">An unexpected error occurred while loading Data Validation.</p>
            </div>
          </div>
          <button onClick={() => window.location.reload()}
            className="w-full py-3 rounded-lg font-johnson-text font-bold text-sm bg-jj-red text-white hover:bg-jj-maroon-05 transition-colors duration-200">
            Reload Page
          </button>
        </div>
      </div>
    );
    return this.props.children;
  }
}

// ─── Cascade Picker — unchanged behavior from the previous version ───────────
function CascadePicker({
  databases, schemas, tables, loadingDatabases, loadingSchemas, loadingTables,
  selectedDatabase, selectedSchema, selectedTable,
  onSelectDatabase, onSelectSchema, onSelectTable,
  hasDatabase, hasSchema, accent, globalSearch,
}) {
  const [expanded, setExpanded] = useState(true);
  const [dbSearch, setDbSearch] = useState('');
  const [schSearch, setSchSearch] = useState('');
  const [search, setSearch] = useState('');
  const [qualifiedQuery, setQualifiedQuery] = useState('');
  const [qualifiedFocused, setQualifiedFocused] = useState(false);
  const filteredDatabases = (dbSearch.trim()
    ? (databases || []).filter(d => typeof d === 'string' && d.toLowerCase().includes(dbSearch.toLowerCase()))
    : (databases || [])).filter(d => typeof d === 'string');
  const filteredSchemas = (schSearch.trim()
    ? (schemas || []).filter(s => typeof s === 'string' && s.toLowerCase().includes(schSearch.toLowerCase()))
    : (schemas || [])).filter(s => typeof s === 'string');
  const filteredTables = (search.trim()
    ? (tables || []).filter(t => typeof t === 'string' && t.toLowerCase().includes(search.toLowerCase()))
    : (tables || [])).filter(t => typeof t === 'string');
  useEffect(() => { setSchSearch(''); setSearch(''); }, [selectedDatabase]);
  useEffect(() => { setSearch(''); }, [selectedSchema]);

  const findMatch = (list, part) => {
    const lower = part.toLowerCase();
    return (list || []).find(x => typeof x === 'string' && x.toLowerCase() === lower);
  };

  const levels = [...(hasDatabase ? ['database'] : []), ...(hasSchema ? ['schema'] : []), 'table'];
  const listForLevel = lvl => (lvl === 'database' ? databases : lvl === 'schema' ? schemas : tables);
  const loadingForLevel = lvl => (lvl === 'database' ? loadingDatabases : lvl === 'schema' ? loadingSchemas : loadingTables);

  useEffect(() => {
    const committed = qualifiedQuery.split('.').slice(0, -1).map(p => p.trim()).filter(Boolean);
    committed.forEach((part, i) => {
      const lvl = levels[i];
      if (!lvl || lvl === 'table') return;
      const current = lvl === 'database' ? selectedDatabase : selectedSchema;
      if (current === part) return;
      const match = findMatch(listForLevel(lvl), part);
      if (match) { lvl === 'database' ? onSelectDatabase(match) : onSelectSchema(match); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qualifiedQuery, databases, schemas]);

  const qParts = qualifiedQuery.split('.').map(p => p.trim());
  const qDepth = Math.min(qParts.length - 1, levels.length - 1);
  const qPartial = qParts[qParts.length - 1] || '';
  const matchLevel = lvl => (listForLevel(lvl) || [])
    .filter(x => typeof x === 'string' && x.toLowerCase().includes(qPartial.toLowerCase()))
    .map(value => ({ value, level: lvl }));
  const qLevel = qDepth === 0 ? 'table' : levels[qDepth];
  const qLoading = loadingForLevel(qLevel);
  const [qShowCount, setQShowCount] = useState(8);
  useEffect(() => { setQShowCount(8); }, [qPartial, qLevel]);
  const qAllMatches = qLoading ? [] : matchLevel(qLevel);
  const qSuggestions = qAllMatches.slice(0, qShowCount);
  const qRemaining = qAllMatches.length - qSuggestions.length;
  const awaitingGlobal = !!globalSearch && qDepth === 0 && qPartial.trim().length >= 3;

  const pickSuggestion = (s, lvl) => {
    if (lvl === 'table') {
      onSelectTable(s);
      setExpanded(false);
      setQualifiedQuery('');
      setQualifiedFocused(false);
      return;
    }
    const idx = levels.indexOf(lvl);
    const prefix = levels.slice(0, idx).map(l => (l === 'database' ? selectedDatabase : selectedSchema)).filter(Boolean);
    setQualifiedQuery([...prefix, s, ''].join('.'));
  };

  const [globalResults, setGlobalResults] = useState([]);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [globalError, setGlobalError] = useState('');
  const [globalHasMore, setGlobalHasMore] = useState(false);
  const [globalNextOffset, setGlobalNextOffset] = useState(0);
  useEffect(() => {
    if (!globalSearch || qDepth !== 0 || qPartial.trim().length < 3 || qSuggestions.length > 0) {
      setGlobalResults([]);
      setGlobalError('');
      setGlobalHasMore(false);
      setGlobalNextOffset(0);
      return;
    }
    const q = qPartial.trim();
    setGlobalLoading(true);
    setGlobalError('');
    const t = setTimeout(() => {
      globalSearch(q, 0, 0)
        .then(({ results, truncated, nextOffset }) => {
          setGlobalResults(results || []);
          setGlobalHasMore(!!truncated);
          setGlobalNextOffset(nextOffset || 0);
        })
        .catch(e => { setGlobalResults([]); setGlobalHasMore(false); setGlobalError(e?.message || 'Search failed'); })
        .finally(() => setGlobalLoading(false));
    }, 400);
    return () => { clearTimeout(t); setGlobalLoading(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qPartial, qDepth]);

  const loadMoreGlobal = () => {
    if (!globalSearch || globalLoading || !globalHasMore) return;
    const q = qPartial.trim();
    setGlobalLoading(true);
    globalSearch(q, 20, globalNextOffset)
      .then(({ results, truncated, nextOffset }) => {
        setGlobalResults(prev => [...prev, ...(results || [])]);
        setGlobalHasMore(!!truncated);
        setGlobalNextOffset(nextOffset || globalNextOffset);
      })
      .catch(e => setGlobalError(e?.message || 'Search failed'))
      .finally(() => setGlobalLoading(false));
  };

  const [pendingPick, setPendingPick] = useState(null);
  useEffect(() => {
    if (!pendingPick) return;
    const { database, schema, table } = pendingPick;
    if (hasDatabase && selectedDatabase !== database) {
      if (!loadingDatabases && (databases || []).includes(database)) onSelectDatabase(database);
      return;
    }
    if (hasSchema && selectedSchema !== schema) {
      if (!loadingSchemas && (schemas || []).includes(schema)) onSelectSchema(schema);
      return;
    }
    if (!loadingTables && (tables || []).includes(table)) {
      onSelectTable(table);
      setPendingPick(null);
      setExpanded(false);
      setQualifiedQuery('');
      setQualifiedFocused(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPick, databases, schemas, tables, loadingDatabases, loadingSchemas, loadingTables, selectedDatabase, selectedSchema]);

  // If the lists finish loading and the picked table still isn't in them (it was
  // dropped, renamed, or the user lacks access), nothing above ever fires and
  // the "Opening…" spinner sticks around for good. Give up after a grace period.
  useEffect(() => {
    if (!pendingPick) return;
    const t = setTimeout(() => {
      setPendingPick(null);
      setGlobalError(`Couldn't open ${pendingPick.table} — try selecting it from the lists below.`);
    }, 15000);
    return () => clearTimeout(t);
  }, [pendingPick]);

  const pickGlobalResult = r => {
    setGlobalResults([]);
    setPendingPick({ database: r.database, schema: r.schema, table: r.table });
  };

  const selectedDbRef = useRef(null);
  const selectedSchRef = useRef(null);
  const selectedTblRef = useRef(null);
  useEffect(() => {
    if (!expanded) return;
    const id = requestAnimationFrame(() => {
      selectedDbRef.current?.scrollIntoView({ block: 'nearest' });
      selectedSchRef.current?.scrollIntoView({ block: 'nearest' });
      selectedTblRef.current?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(id);
  }, [expanded, loadingDatabases, loadingSchemas, loadingTables]);
  const cols = [hasDatabase, hasSchema, true].filter(Boolean).length;
  const gridColsClass = cols === 3 ? 'grid-cols-3' : cols === 2 ? 'grid-cols-2' : 'grid-cols-1';

  return (
    <div className="rounded-lg border border-jj-gray-02 bg-white">
      <button
        onClick={() => setExpanded(p => !p)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          {hasDatabase && (
            <>
              <span className={`font-johnson-text text-sm ${selectedDatabase ? 'text-jj-gray-08' : 'text-jj-gray-04'}`}>{selectedDatabase || 'Choose database'}</span>
              {hasSchema && <span className="text-jj-gray-04">›</span>}
            </>
          )}
          {hasSchema && (
            <>
              <span className={`font-johnson-text text-sm ${selectedSchema ? 'text-jj-gray-08' : 'text-jj-gray-04'}`}>{selectedSchema || 'Choose schema'}</span>
              <span className="text-jj-gray-04">›</span>
            </>
          )}
          <span className={`font-johnson-text text-sm font-bold ${selectedTable ? 'text-jj-gray-08' : 'text-jj-gray-04'}`}>{selectedTable || 'Choose table'}</span>
        </div>
        <Icon src={chevronDownIcon} alt="" className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} color="jj-gray-06" />
      </button>

      {expanded && (
        <div className="border-t border-jj-gray-02 p-3">
          <div className="mb-2.5 relative">
            <div className="relative">
              <Icon src={searchIcon} alt="" className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-jj-gray-05" />
              <input
                type="text"
                value={qualifiedQuery}
                onChange={e => setQualifiedQuery(e.target.value)}
                onFocus={() => setQualifiedFocused(true)}
                onBlur={() => setTimeout(() => setQualifiedFocused(false), 150)}
                onKeyDown={e => { if (e.key === 'Enter' && qSuggestions.length) { e.preventDefault(); pickSuggestion(qSuggestions[0].value, qSuggestions[0].level); } }}
                placeholder={hasDatabase && hasSchema ? 'Search database.schema.table…' : hasSchema ? 'Search schema.table…' : hasDatabase ? 'Search database.table…' : 'Search table…'}
                className={`w-full pl-8 pr-2.5 py-2 rounded-lg font-johnson-text text-sm bg-white border ${accent === 'blue' ? 'border-jj-blue-03' : 'border-jj-red'} border-opacity-40 text-jj-gray-08 outline-none transition-all`}
              />
            </div>
            {qualifiedFocused && qPartial.trim() !== '' && (
              <div
                onScroll={e => {
                  const el = e.target;
                  if (el.scrollHeight - el.scrollTop - el.clientHeight > 40) return;
                  if (qRemaining > 0) { setQShowCount(c => c + 20); return; }
                  loadMoreGlobal();
                }}
                className="absolute z-20 top-full left-0 right-0 mt-1 rounded-lg border border-jj-gray-02 bg-white shadow-lg max-h-80 overflow-y-auto"
              >
                {qLoading ? (
                  <div className="flex items-center justify-center h-12"><Icon src={loadingIcon} alt="" className="w-3.5 h-3.5 animate-spin" color="jj-gray-05" /></div>
                ) : qSuggestions.length === 0 && !awaitingGlobal ? (
                  <p className="font-johnson-text text-xs text-jj-gray-05 px-3 py-2.5">
                    No matches for "{qPartial}"
                  </p>
                ) : qSuggestions.map(({ value, level }) => {
                  const idx = levels.indexOf(level);
                  const crumb = levels.slice(0, idx)
                    .map(l => (l === 'database' ? selectedDatabase : selectedSchema))
                    .filter(Boolean).join(' › ');
                  return (
                    <button
                      key={`${level}-${value}`}
                      onClick={() => pickSuggestion(value, level)}
                      className="flex items-center justify-between gap-2 w-full text-left px-3 py-2 font-johnson-text text-xs text-jj-gray-08 hover:bg-jj-gray-01 border-b border-jj-gray-01 last:border-b-0"
                    >
                      <span className="min-w-0">
                        <span className="block break-words">{value}</span>
                        {crumb && <span className="block text-[10px] text-jj-gray-05 truncate">{crumb}</span>}
                      </span>
                      <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-jj-gray-04">{level}</span>
                    </button>
                  );
                })}
                {globalLoading && globalResults.length === 0 && (
                  <div className="flex items-center justify-center h-12"><Icon src={loadingIcon} alt="" className="w-3.5 h-3.5 animate-spin" color="jj-gray-05" /></div>
                )}
                {!globalLoading && globalError && (
                  <p className="font-johnson-text text-[10px] text-jj-maroon-05 px-3 py-2">
                    Couldn't search other databases: {globalError}
                  </p>
                )}
                {!globalLoading && !globalError && awaitingGlobal && qSuggestions.length === 0 && globalResults.length === 0 && (
                  <p className="font-johnson-text text-xs text-jj-gray-05 px-3 py-2.5">
                    No matches for "{qPartial}"
                  </p>
                )}
                {globalResults.map(r => (
                  <button
                    key={`global-${r.database}-${r.schema}-${r.table}`}
                    onClick={() => pickGlobalResult(r)}
                    className="flex items-center justify-between gap-2 w-full text-left px-3 py-2 font-johnson-text text-xs text-jj-gray-08 hover:bg-jj-gray-01 border-b border-jj-gray-01 last:border-b-0"
                  >
                    <span className="min-w-0">
                      <span className="block break-words">{r.table}</span>
                      <span className="block text-[10px] text-jj-gray-05 truncate">{[r.database, r.schema].filter(Boolean).join(' › ')}</span>
                    </span>
                    <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-jj-gray-04">table</span>
                  </button>
                ))}
                {globalLoading && globalResults.length > 0 && (
                  <>
                    {[0, 1, 2].map(i => (
                      <div key={`skeleton-${i}`} className="px-3 py-2 border-b border-jj-gray-01 last:border-b-0">
                        <div className="h-3 w-2/3 rounded bg-jj-gray-02 animate-pulse mb-1.5" />
                        <div className="h-2.5 w-1/3 rounded bg-jj-gray-01 animate-pulse" />
                      </div>
                    ))}
                  </>
                )}
                {pendingPick && (
                  <p className="font-johnson-text text-[10px] text-jj-gray-05 px-3 py-2 flex items-center gap-1.5">
                    <Icon src={loadingIcon} alt="" className="w-3 h-3 animate-spin" color="jj-gray-05" />
                    Opening {pendingPick.table}…
                  </p>
                )}
              </div>
            )}
          </div>
          <div className={`grid ${gridColsClass} rounded-lg border border-jj-gray-02 overflow-hidden`}>
            {hasDatabase && (
              <div className="border-r border-jj-gray-02">
                <div className="px-2.5 py-1.5 bg-jj-gray-01 font-johnson-text text-[10px] font-bold uppercase tracking-wide text-jj-gray-05">Database</div>
                <div className="p-1.5 border-b border-jj-gray-02">
                  <div className="relative">
                    <Icon src={searchIcon} alt="" className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-jj-gray-05" />
                    <input
                      type="text"
                      value={dbSearch}
                      onChange={e => setDbSearch(e.target.value)}
                      placeholder="Search…"
                      className={`w-full pl-6 pr-2 py-1.5 rounded-md font-johnson-text text-xs bg-white border ${accent === 'blue' ? 'border-jj-blue-03' : 'border-jj-red'} border-opacity-40 text-jj-gray-08 outline-none transition-all`}
                    />
                  </div>
                </div>
                <div className="max-h-[220px] overflow-y-auto overflow-x-hidden">
                  {loadingDatabases ? (
                    <div className="flex items-center justify-center h-16"><Icon src={loadingIcon} alt="" className="w-3.5 h-3.5 animate-spin" color="jj-gray-05" /></div>
                  ) : filteredDatabases.length === 0 ? (
                    <p className="font-johnson-text text-xs text-jj-gray-05 px-2.5 py-3">{dbSearch ? `No matches for "${dbSearch}"` : 'No databases found'}</p>
                  ) : filteredDatabases.map(db => (
                    <button
                      key={db}
                      title={db}
                      ref={db === selectedDatabase ? selectedDbRef : null}
                      onClick={() => onSelectDatabase(db)}
                      className={`block w-full text-left px-2.5 py-2 font-johnson-text text-xs break-words border-b border-jj-gray-01 last:border-b-0 border-l-2 ${
                        db === selectedDatabase ? `${accent === 'blue' ? 'border-l-jj-blue-03 bg-blue-50 text-jj-blue-03' : 'border-l-jj-red bg-red-50 text-jj-red'} font-bold` : 'border-l-transparent text-jj-gray-08 hover:bg-jj-gray-01'
                      }`}
                    >
                      {db}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {hasSchema && (
              <div className="border-r border-jj-gray-02">
                <div className="px-2.5 py-1.5 bg-jj-gray-01 font-johnson-text text-[10px] font-bold uppercase tracking-wide text-jj-gray-05">Schema</div>
                <div className="p-1.5 border-b border-jj-gray-02">
                  <div className="relative">
                    <Icon src={searchIcon} alt="" className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-jj-gray-05" />
                    <input
                      type="text"
                      value={schSearch}
                      onChange={e => setSchSearch(e.target.value)}
                      placeholder="Search…"
                      className={`w-full pl-6 pr-2 py-1.5 rounded-md font-johnson-text text-xs bg-white border ${accent === 'blue' ? 'border-jj-blue-03' : 'border-jj-red'} border-opacity-40 text-jj-gray-08 outline-none transition-all`}
                    />
                  </div>
                </div>
                <div className="max-h-[220px] overflow-y-auto overflow-x-hidden">
                  {loadingSchemas ? (
                    <div className="flex items-center justify-center h-16"><Icon src={loadingIcon} alt="" className="w-3.5 h-3.5 animate-spin" color="jj-gray-05" /></div>
                  ) : filteredSchemas.length === 0 ? (
                    <p className="font-johnson-text text-xs text-jj-gray-05 px-2.5 py-3">{schSearch ? `No matches for "${schSearch}"` : 'No schemas found'}</p>
                  ) : filteredSchemas.map(sch => (
                    <button
                      key={sch}
                      title={sch}
                      ref={sch === selectedSchema ? selectedSchRef : null}
                      onClick={() => onSelectSchema(sch)}
                      className={`block w-full text-left px-2.5 py-2 font-johnson-text text-xs break-words border-b border-jj-gray-01 last:border-b-0 border-l-2 ${
                        sch === selectedSchema ? `${accent === 'blue' ? 'border-l-jj-blue-03 bg-blue-50 text-jj-blue-03' : 'border-l-jj-red bg-red-50 text-jj-red'} font-bold` : 'border-l-transparent text-jj-gray-08 hover:bg-jj-gray-01'
                      }`}
                    >
                      {sch}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="px-2.5 py-1.5 bg-jj-gray-01 font-johnson-text text-[10px] font-bold uppercase tracking-wide text-jj-gray-05 flex justify-between">
                <span>Table</span><span>{filteredTables.length}</span>
              </div>
              <div className="p-1.5 border-b border-jj-gray-02">
                <div className="relative">
                  <Icon src={searchIcon} alt="" className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-jj-gray-05" />
                  <input
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search…"
                    className={`w-full pl-6 pr-2 py-1.5 rounded-md font-johnson-text text-xs bg-white border ${accent === 'blue' ? 'border-jj-blue-03' : 'border-jj-red'} border-opacity-40 text-jj-gray-08 outline-none transition-all`}
                  />
                </div>
              </div>
              <div className="max-h-[220px] overflow-y-auto overflow-x-hidden">
                {loadingTables ? (
                  <div className="flex items-center justify-center h-16"><Icon src={loadingIcon} alt="" className="w-3.5 h-3.5 animate-spin" color="jj-gray-05" /></div>
                ) : filteredTables.length === 0 ? (
                  <p className="font-johnson-text text-xs text-jj-gray-05 px-2.5 py-3">{search ? `No matches for "${search}"` : 'No tables found'}</p>
                ) : filteredTables.map(t => (
                  <button
                    key={t}
                    title={t}
                    ref={t === selectedTable ? selectedTblRef : null}
                    onClick={() => { onSelectTable(t); setExpanded(false); }}
                    className={`flex items-start justify-between gap-2 w-full text-left px-2.5 py-2 font-johnson-text text-xs break-words border-b border-jj-gray-01 last:border-b-0 border-l-2 ${
                      t === selectedTable ? `${accent === 'blue' ? 'border-l-jj-blue-03 bg-blue-50 text-jj-blue-03' : 'border-l-jj-red bg-red-50 text-jj-red'} font-bold` : 'border-l-transparent text-jj-gray-08 hover:bg-jj-gray-01'
                    }`}
                  >
                    <span className="min-w-0 break-words">{t}</span>
                    {t === selectedTable && <Icon src={checkCircleIcon} alt="" className="w-3 h-3 flex-shrink-0 mt-0.5" color={accent === 'blue' ? 'jj-blue-03' : 'jj-red'} />}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── v2: status visual tokens ─────────────────────────────────────────────────
const STATUS_TOKENS = {
  pass:    { color: C.pass,  glyph: '✓', dot: 'rgba(50,135,20,0.09)',  chip: 'rgba(50,135,20,0.35)',  bar: 'rgba(50,135,20,0.45)',  text: 'Pass' },
  warn:    { color: C.warn,  glyph: '!', dot: 'rgba(255,96,23,0.1)',   chip: 'rgba(255,96,23,0.4)',   bar: 'rgba(255,96,23,0.5)',   text: 'Warn' },
  fail:    { color: C.fail,  glyph: '✕', dot: 'rgba(158,0,0,0.08)',    chip: 'rgba(158,0,0,0.35)',    bar: 'rgba(158,0,0,0.55)',    text: 'Fail' },
  skipped: { color: C.faint, glyph: '–', dot: 'rgba(163,153,146,0.12)',chip: 'rgba(163,153,146,0.4)', bar: 'rgba(163,153,146,0.35)',text: 'Skipped' },
  neutral: { color: C.text2, glyph: '·', dot: 'rgba(110,98,89,0.09)',  chip: 'rgba(110,98,89,0.3)',   bar: 'rgba(110,98,89,0.25)',  text: 'N/A' },
};

// ─── v2: expandable check row ─────────────────────────────────────────────────
const CheckRow = ({ status, title, summary, expanded, onToggle, children }) => {
  const t = STATUS_TOKENS[status] || STATUS_TOKENS.neutral;
  const inner = (
    <>
      <span style={{ width: 20, height: 20, borderRadius: '50%', background: t.dot, color: t.color, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>{t.glyph}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color: C.text, width: 150, flex: 'none' }}>{title}</span>
      <span style={{ fontSize: 13, color: C.text2, flex: 1, minWidth: 0 }}>{summary}</span>
      <span style={{ ...microLabel, color: t.color, border: `1px solid ${t.chip}`, borderRadius: 4, padding: '3px 9px', flex: 'none' }}>{t.text}</span>
      {children && (
        <span style={{ fontSize: 10, color: C.faint, flex: 'none', transition: 'transform .25s', transform: expanded ? 'rotate(180deg)' : 'none' }}>▼</span>
      )}
    </>
  );
  return (
    <div style={{ borderTop: `1px solid ${C.borderSoft}`, boxShadow: `inset 3px 0 0 ${t.bar}` }}>
      {children ? (
        <button onClick={onToggle} className="dv-rowbtn" style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 16, padding: '15px 24px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: font }}>
          {inner}
        </button>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '15px 24px' }}>{inner}</div>
      )}
      {children && expanded && (
        <div style={{ padding: '4px 24px 18px 60px', animation: 'dvExpand .25s ease-out' }}>{children}</div>
      )}
    </div>
  );
};

const th = (align = 'left') => ({ textAlign: align, padding: align === 'right' ? '6px 18px 6px 0' : '6px 18px 6px 0', ...microLabel, color: C.faint, borderBottom: `1px solid ${C.border}` });
const td = { padding: '8px 18px 8px 0', color: C.text2, borderBottom: `1px solid ${C.borderSoft}`, fontVariantNumeric: 'tabular-nums' };

// ─── v2: results checklist ────────────────────────────────────────────────────
function ResultsChecklist({ result, onDownload, downloading }) {
  const [exp, setExp] = useState({ mismatches: true });
  const toggle = id => setExp(p => ({ ...p, [id]: !p[id] }));

  const sourceRef = [result.source_database, result.source_schema, result.source_table].filter(Boolean).join('.');
  const targetRef = [result.target_database, result.target_schema, result.target_table].filter(Boolean).join('.');

  const st = {
    rowCount: result.row_count.match ? 'pass' : 'fail',
    // Backend counts a schema mismatch towards FAILED, so showing it as a
    // warning here left the banner saying "failed" with nothing marked failed.
    schema: result.schema_comparison.match ? 'pass' : 'fail',
    types: result.data_type_validation.skipped
      ? 'skipped'
      : result.data_type_validation.match
        ? 'pass'
        : (result.data_type_validation.major_mismatches ? 'warn' : 'pass'),
    nulls: result.null_checks.skipped ? 'skipped' : (result.null_checks.match ? 'pass' : 'warn'),
    dups: result.duplicate_checks.skipped ? 'skipped' : (result.duplicate_checks.match ? 'pass' : 'warn'),
    aggregates: !result.aggregate_checks || result.aggregate_checks.skipped
      ? 'skipped'
      : (result.aggregate_checks.match ? 'pass' : 'fail'),
    missing: result.missing_records.skipped ? 'skipped' : (result.missing_records.count === 0 ? 'pass' : 'fail'),
    extra: result.extra_records.skipped ? 'skipped' : (result.extra_records.count === 0 ? 'pass' : 'fail'),
    mismatches: result.data_mismatches.skipped ? 'skipped' : (result.data_mismatches.not_applicable ? 'neutral' : (result.data_mismatches.count === 0 ? 'pass' : 'fail')),
    matchPct: result.additional_metrics.match_percentage === null ? 'skipped' : (result.additional_metrics.match_percentage >= 99.9 ? 'pass' : 'warn'),
  };
  const all = Object.values(st);
  const counts = { pass: all.filter(s => s === 'pass').length, warn: all.filter(s => s === 'warn').length, fail: all.filter(s => s === 'fail').length, other: all.filter(s => s !== 'pass' && s !== 'warn' && s !== 'fail').length };

  // Conic status ring: proportional segments per outcome.
  const total = all.length;
  const deg = n => (n / total) * 360;
  const stops = [];
  let acc = 0;
  [['#328714', counts.pass], ['#ff6017', counts.warn], ['#9e0000', counts.fail], ['#cbc4bc', counts.other]].forEach(([col, n]) => {
    if (!n) return;
    stops.push(`${col} ${acc}deg ${acc + deg(n)}deg`);
    acc += deg(n);
  });
  const ring = `conic-gradient(${stops.join(', ')})`;

  const overall = {
    PASSED:  { color: C.pass, glyph: '✓', title: 'Validation passed',      border: 'rgba(50,135,20,0.28)', tint: 'rgba(50,135,20,0.06)' },
    WARNING: { color: C.warn, glyph: '!', title: 'Passed with warnings',   border: 'rgba(255,96,23,0.3)',  tint: 'rgba(255,96,23,0.07)' },
    FAILED:  { color: C.fail, glyph: '✕', title: 'Validation failed',      border: 'rgba(158,0,0,0.25)',   tint: 'rgba(158,0,0,0.06)' },
  }[result.overall_status] || { color: C.text2, glyph: '·', title: result.overall_status, border: C.border, tint: 'transparent' };

  const subtitleParts = [
    counts.fail > 0 && `${counts.fail} failed`,
    counts.warn > 0 && `${counts.warn} warning${counts.warn > 1 ? 's' : ''}`,
  ].filter(Boolean);
  const subtitle = result.overall_status === 'PASSED'
    ? `All ${total} checks passed`
    : subtitleParts.length
      ? `${subtitleParts.join(' · ')} of ${total} checks`
      : `${total} checks run`;

  const rowDelta = result.row_count.target - result.row_count.source;
  const srcSampled = result.missing_records.sample_size;
  const tgtSampled = result.extra_records.sample_size;
  const isPartial = !result.missing_records.skipped && (
    (result.row_count.source > 0 && srcSampled < result.row_count.source) ||
    (result.row_count.target > 0 && tgtSampled < result.row_count.target)
  );
  const pct = (sampled, totalRows) => (totalRows > 0 ? ` (${((sampled / totalRows) * 100).toFixed(1)}%)` : '');

  const panel = { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden', boxShadow: '0 1px 3px rgba(49,44,42,0.05)' };
  const groupHead = { padding: '16px 24px 6px 24px', ...label };
  const statCard = { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 4, boxShadow: '0 1px 3px rgba(49,44,42,0.05)' };
  const statNum = { fontFamily: fontDisplay, fontSize: 22, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>

      {/* Verdict banner */}
      <div style={{ background: `linear-gradient(135deg, ${overall.tint} 0%, #ffffff 45%)`, border: `1px solid ${overall.border}`, borderRadius: 14, padding: '22px 26px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap', boxShadow: '0 1px 3px rgba(49,44,42,0.05)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{ width: 62, height: 62, borderRadius: '50%', background: ring, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19, fontWeight: 700, color: overall.color }}>{overall.glyph}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ fontFamily: fontDisplay, fontWeight: 700, fontSize: 23, lineHeight: '110%', color: overall.color }}>{overall.title}</div>
            <div style={{ fontSize: 13, color: C.muted }}>
              {subtitle} · completed in {result.duration_seconds}s
              {result.key_column
                ? ` · keyed on ${result.key_column}${result.key_column_auto ? ' (auto-detected)' : ''}`
                : ' · full row-by-row match (no key column)'}
            </div>
            <div style={{ fontSize: 12, color: C.faint }}>{sourceRef} → {targetRef}</div>
          </div>
        </div>
        <button onClick={onDownload} disabled={downloading} className="dv-ghostbtn"
          style={{ border: `1px solid ${C.borderInput}`, background: '#fff', cursor: 'pointer', fontFamily: font, fontSize: 13, fontWeight: 700, color: C.text, borderRadius: 10, padding: '11px 20px', opacity: downloading ? 0.5 : 1 }}>
          {downloading ? 'Preparing…' : 'Download report (.xlsx)'}
        </button>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <div className="dv-lift" style={statCard}>
          <span style={{ ...microLabel, color: C.faint }}>Source rows</span>
          <span style={statNum}>{result.row_count.source.toLocaleString()}</span>
        </div>
        <div className="dv-lift" style={statCard}>
          <span style={{ ...microLabel, color: C.faint }}>Target rows</span>
          <span style={statNum}>{result.row_count.target.toLocaleString()}</span>
        </div>
        <div className="dv-lift" style={{ ...statCard, border: rowDelta !== 0 ? '1px solid rgba(158,0,0,0.3)' : statCard.border }}>
          <span style={{ ...microLabel, color: rowDelta !== 0 ? C.fail : C.faint }}>Row delta</span>
          <span style={{ ...statNum, color: rowDelta !== 0 ? C.fail : C.text }}>{rowDelta > 0 ? `+${rowDelta.toLocaleString()}` : rowDelta.toLocaleString()}</span>
        </div>
        <div className="dv-lift" style={statCard}>
          <span style={{ ...microLabel, color: C.faint }}>Sampled match</span>
          <span style={{ ...statNum, color: st.matchPct === 'pass' ? C.pass : st.matchPct === 'warn' ? C.warn : C.faint }}>
            {result.additional_metrics.match_percentage === null ? '—' : `${result.additional_metrics.match_percentage}%`}
          </span>
        </div>
      </div>

      {/* Notices */}
      {result.schema_comparison.scope_note && (
        <div style={{ fontSize: 12.5, color: C.warn, padding: '0 4px' }}><strong>Schema mismatch:</strong> <span style={{ color: C.text2 }}>{result.schema_comparison.scope_note}</span></div>
      )}
      {result.key_column_issue && (
        <div style={{ fontSize: 12.5, color: C.warn, padding: '0 4px' }}><strong>Key column issue:</strong> <span style={{ color: C.text2 }}>{result.key_column_issue}</span></div>
      )}
      {!result.missing_records.skipped && (
        <div style={{ fontSize: 12.5, color: C.muted, padding: '0 4px' }}>
          Sampled <strong style={{ color: C.text }}>{srcSampled.toLocaleString()}</strong> of {result.row_count.source.toLocaleString()} source rows{pct(srcSampled, result.row_count.source)} and{' '}
          <strong style={{ color: C.text }}>{tgtSampled.toLocaleString()}</strong> of {result.row_count.target.toLocaleString()} target rows{pct(tgtSampled, result.row_count.target)} for record-level checks.
          {isPartial && ' Raise the sample limit for a more complete comparison.'}
        </div>
      )}

      {/* Structure */}
      <div style={panel}>
        <div style={groupHead}>Structure</div>
        <CheckRow status={st.rowCount} title="Row count"
          summary={<>{result.row_count.source.toLocaleString()} source · {result.row_count.target.toLocaleString()} target{!result.row_count.match && <> — <strong style={{ color: C.fail }}>{Math.abs(rowDelta).toLocaleString()} rows {rowDelta < 0 ? 'short' : 'over'}</strong></>}</>} />
        <CheckRow status={st.schema} title="Schema match"
          summary={result.schema_comparison.match
            ? `All ${result.schema_comparison.common_columns} columns present on both sides`
            : `${result.schema_comparison.source_only_columns.length} only in source · ${result.schema_comparison.target_only_columns.length} only in target · ${result.schema_comparison.common_columns} common columns used for all checks below`}
          expanded={!!exp.schema} onToggle={() => toggle('schema')}
        >
          {(result.schema_comparison.source_only_columns.length > 0 || result.schema_comparison.target_only_columns.length > 0) ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {result.schema_comparison.scope_note && (
                <div style={{ fontSize: 12.5, color: C.text2, lineHeight: 1.5, maxWidth: 720 }}>{result.schema_comparison.scope_note}</div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {result.schema_comparison.source_only_columns.map(c => (
                  <span key={`s-${c}`} style={{ fontSize: 12, fontWeight: 500, color: C.text, background: C.borderSoft, borderRadius: 6, padding: '4px 10px' }}>source only: <strong>{c}</strong></span>
                ))}
                {result.schema_comparison.target_only_columns.map(c => (
                  <span key={`t-${c}`} style={{ fontSize: 12, fontWeight: 500, color: C.text, background: C.borderSoft, borderRadius: 6, padding: '4px 10px' }}>target only: <strong>{c}</strong></span>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: C.text2 }}>Both tables expose the same {result.schema_comparison.common_columns} column(s).</div>
          )}
        </CheckRow>
        <CheckRow status={st.types} title="Data types"
          summary={result.data_type_validation.skipped
            ? (result.data_type_validation.skip_reason || 'Not evaluated')
            : (result.data_type_validation.match
              ? `All ${result.data_type_validation.checked_columns} checked columns match`
              : (result.data_type_validation.major_mismatches
                ? `${result.data_type_validation.major_mismatches} incompatible${result.data_type_validation.minor_mismatches ? `, ${result.data_type_validation.minor_mismatches} length/precision only` : ''}`
                : `${result.data_type_validation.mismatched_columns} column(s) differ in length/precision only`))}
          expanded={!!exp.types} onToggle={result.data_type_validation.mismatches.length > 0 ? () => toggle('types') : undefined}
        >
          {result.data_type_validation.mismatches.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: 480 }}>
                <thead><tr><th style={th()}>Column</th><th style={th()}>Source type</th><th style={th()}>Target type</th><th style={th()}>Impact</th></tr></thead>
                <tbody>
                  {result.data_type_validation.mismatches.map((m, i) => {
                    // Length/precision differences read as noise next to a real
                    // class change, so don't paint them the same colour.
                    const major = m.severity !== 'minor';
                    const tone = major ? C.fail : C.muted;
                    return (
                      <tr key={i}>
                        <td style={{ ...td, fontWeight: 700, color: C.text }}>{m.column}</td>
                        <td style={{ ...td, color: tone, fontWeight: 500 }}>{m.source_type}</td>
                        <td style={{ ...td, color: tone, fontWeight: 500 }}>{m.target_type}</td>
                        <td style={{ ...td, color: tone, fontWeight: 700, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                          {major ? 'Incompatible' : 'Length only'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CheckRow>
      </div>

      {/* Quality */}
      <div style={panel}>
        <div style={groupHead}>Quality</div>
        <CheckRow status={st.nulls} title="Null counts"
          summary={result.null_checks.skipped
            ? (result.null_checks.skip_reason || 'Not evaluated')
            : (result.null_checks.match
              ? `Match across all ${result.null_checks.columns.length} columns`
              : `${result.null_checks.mismatched_columns} column(s) differ in null counts`)}
          expanded={!!exp.nulls} onToggle={!result.null_checks.skipped && result.null_checks.columns.length > 0 ? () => toggle('nulls') : undefined}
        >
          {!result.null_checks.skipped && result.null_checks.columns.length > 0 && (
            <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: 560 }}>
                <thead>
                  <tr>
                    <th style={th()}>Column</th><th style={th()}>Source type</th><th style={th()}>Target type</th>
                    <th style={th('right')}>Source nulls</th><th style={th('right')}>Target nulls</th><th style={th()}></th>
                  </tr>
                </thead>
                <tbody>
                  {result.null_checks.columns.map(col => (
                    <tr key={col.column}>
                      <td style={{ ...td, fontWeight: 700, color: C.text }}>{col.column}</td>
                      <td style={{ ...td, color: col.type_match ? C.text2 : C.warn, fontWeight: col.type_match ? 400 : 700 }}>{col.source_type}</td>
                      <td style={{ ...td, color: col.type_match ? C.text2 : C.warn, fontWeight: col.type_match ? 400 : 700 }}>{col.target_type}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{col.source_nulls.toLocaleString()}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{col.target_nulls.toLocaleString()}</td>
                      <td style={{ ...td, color: col.match ? C.pass : C.fail, fontWeight: 700 }}>{col.match ? '✓' : '✕'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CheckRow>
        <CheckRow status={st.dups} title="Duplicates"
          summary={result.duplicate_checks.skipped
            ? (result.duplicate_checks.skip_reason || 'Not evaluated')
            : <>
                {result.duplicate_checks.source_duplicates.toLocaleString()} duplicate groups in source · {result.duplicate_checks.target_duplicates.toLocaleString()} in target
                {result.duplicate_checks.excluded_columns?.length ? ` (${result.duplicate_checks.excluded_columns.length} col excluded from grouping)` : ''}
              </>} />

        <CheckRow status={st.aggregates} title="Full-table aggregates"
          summary={!result.aggregate_checks || result.aggregate_checks.skipped
            ? (result.aggregate_checks?.skip_reason || 'Not evaluated')
            : result.aggregate_checks.match
              ? `${result.aggregate_checks.checked_columns} column(s) agree across all rows`
              : `${result.aggregate_checks.mismatch_count?.toLocaleString()} aggregate difference(s) across all rows`}
          expanded={!!exp.aggregates}
          onToggle={result.aggregate_checks?.mismatches?.length > 0 ? () => toggle('aggregates') : undefined}
        >
          {result.aggregate_checks?.mismatches?.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <p style={{ fontSize: 12, color: C.text2, margin: '0 0 10px 0' }}>
                These compare every row, not the sample — a difference here is real data drift.
              </p>
              <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: 480 }}>
                <thead><tr><th style={th()}>Column</th><th style={th()}>Metric</th><th style={th()}>Source</th><th style={th()}>Target</th></tr></thead>
                <tbody>
                  {result.aggregate_checks.mismatches.map((m, i) => (
                    <tr key={i}>
                      <td style={{ ...td, fontWeight: 700, color: C.text }}>{m.column}</td>
                      <td style={{ ...td, color: C.muted }}>{m.metric === 'non_null' ? 'non-null count' : m.metric}</td>
                      <td style={{ ...td, color: C.fail, fontWeight: 500 }}>{String(m.source)}</td>
                      <td style={{ ...td, color: C.fail, fontWeight: 500 }}>{String(m.target)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CheckRow>
      </div>

      {/* Record-level */}
      <div style={panel}>
        <div style={{ ...groupHead, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <span style={label}>
            Record-level{result.key_column
              ? ` · keyed on ${result.key_column}${result.key_column_auto ? ' (auto)' : ''}`
              : ' · row-by-row (no key)'}
          </span>
          {!result.missing_records.skipped && (
            <span style={{ fontSize: 12, color: C.faint, letterSpacing: 0, textTransform: 'none', fontWeight: 400 }}>sampled {srcSampled.toLocaleString()} rows per side</span>
          )}
        </div>
        <CheckRow status={st.missing} title="Missing records"
          summary={result.missing_records.skipped
            ? (result.missing_records.skip_reason || 'Not evaluated')
            : `${result.missing_records.count.toLocaleString()} source records not found in target`}
          expanded={!!exp.missing} onToggle={result.missing_records.sample.length > 0 ? () => toggle('missing') : undefined}
        >
          {result.missing_records.sample.length > 0 && (
            <>
              <div style={{ overflowX: 'auto', maxHeight: 280, overflowY: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: 560 }}>
                  <thead><tr>{Object.keys(result.missing_records.sample[0]).map(k => <th key={k} style={{ ...th(), whiteSpace: 'nowrap' }}>{k}</th>)}</tr></thead>
                  <tbody>
                    {result.missing_records.sample.map((row, i) => (
                      <tr key={i}>{Object.keys(result.missing_records.sample[0]).map(k => <td key={k} style={{ ...td, whiteSpace: 'nowrap' }}>{String(row[k] ?? '')}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 12, color: C.faint, paddingTop: 10 }}>Showing {result.missing_records.sample.length} of {result.missing_records.count.toLocaleString()} — the full list is in the downloadable report.</div>
            </>
          )}
        </CheckRow>
        <CheckRow status={st.extra} title="Extra records"
          summary={result.extra_records.skipped
            ? (result.extra_records.skip_reason || 'Not evaluated')
            : `${result.extra_records.count.toLocaleString()} target records without a source match`}
          expanded={!!exp.extra} onToggle={result.extra_records.sample.length > 0 ? () => toggle('extra') : undefined}
        >
          {result.extra_records.sample.length > 0 && (
            <>
              <div style={{ overflowX: 'auto', maxHeight: 280, overflowY: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: 560 }}>
                  <thead><tr>{Object.keys(result.extra_records.sample[0]).map(k => <th key={k} style={{ ...th(), whiteSpace: 'nowrap' }}>{k}</th>)}</tr></thead>
                  <tbody>
                    {result.extra_records.sample.map((row, i) => (
                      <tr key={i}>{Object.keys(result.extra_records.sample[0]).map(k => <td key={k} style={{ ...td, whiteSpace: 'nowrap' }}>{String(row[k] ?? '')}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 12, color: C.faint, paddingTop: 10 }}>Showing {result.extra_records.sample.length} of {result.extra_records.count.toLocaleString()} — the full list is in the downloadable report.</div>
            </>
          )}
        </CheckRow>
        <CheckRow status={st.mismatches} title="Value mismatches"
          summary={result.data_mismatches.skipped
            ? (result.data_mismatches.skip_reason || 'Not evaluated')
            : (result.data_mismatches.not_applicable
              ? 'No key column to align fields'
              : `${(result.data_mismatches.mismatched_row_count ?? 0).toLocaleString()} keyed record(s) differ · ${result.data_mismatches.count.toLocaleString()} field(s) total`)}
          expanded={!!exp.mismatches}
          onToggle={!result.data_mismatches.not_applicable && result.data_mismatches.sample.length > 0 ? () => toggle('mismatches') : undefined}
        >
          {!result.data_mismatches.not_applicable && result.data_mismatches.sample.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxHeight: 420, overflowY: 'auto' }}>
              {result.data_mismatches.sample.map((m, i) => {
                const cols = Object.keys(m.source_row);
                const mismatched = new Set(m.mismatched_columns);
                return (
                  <div key={i} style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', flex: 'none' }}>
                    <div style={{ padding: '9px 14px', background: C.panelSoft, fontSize: 12, color: C.muted }}>
                      Key <strong style={{ color: C.text }}>{String(m.key)}</strong> · {m.mismatched_columns.length} field{m.mismatched_columns.length > 1 ? 's' : ''} differ{m.mismatched_columns.length > 1 ? '' : 's'}
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%', minWidth: 400 }}>
                        <thead>
                          <tr>
                            <th style={{ padding: '7px 14px', borderTop: `1px solid ${C.borderSoft}` }}></th>
                            {cols.map(c => (
                              <th key={c} style={{ textAlign: 'left', padding: '7px 14px', ...microLabel, color: mismatched.has(c) ? C.text : C.faint, borderTop: `1px solid ${C.borderSoft}`, whiteSpace: 'nowrap' }}>{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {[['Source', m.source_row], ['Target', m.target_row]].map(([side, row]) => (
                            <tr key={side}>
                              <td style={{ padding: '7px 14px', fontSize: 11, fontWeight: 700, color: C.muted, borderTop: `1px solid ${C.borderSoft}`, background: C.panelSoft, whiteSpace: 'nowrap' }}>{side}</td>
                              {cols.map(c => (
                                <td key={c} style={{ padding: '7px 14px', color: mismatched.has(c) ? C.text : C.text2, fontWeight: mismatched.has(c) ? 700 : 400, background: mismatched.has(c) ? C.hl : 'transparent', borderTop: `1px solid ${C.borderSoft}`, whiteSpace: 'nowrap' }}>{String(row[c] ?? '')}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
              <div style={{ fontSize: 12, color: C.faint }}>Showing {result.data_mismatches.sample.length} of {(result.data_mismatches.mismatched_row_count ?? result.data_mismatches.count).toLocaleString()} mismatched records — the differing fields are highlighted.</div>
            </div>
          )}
        </CheckRow>
        <CheckRow status={st.matchPct} title="Sampled match"
          summary={result.additional_metrics.match_percentage === null
            ? (result.missing_records.skip_reason || 'Not evaluated')
            : `${result.additional_metrics.match_percentage}% of sampled rows match exactly`} />
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
function DataValidation({ onBack }) {
  const { hasPermission } = useRBAC();
  const canRun = hasPermission('runDataValidation');

  const ENVIRONMENTS = [
    { id: 'dev', label: 'DEV' },
    { id: 'qa', label: 'QA' },
    { id: 'prod', label: 'PROD' },
  ];
  const [selectedEnv, setSelectedEnv] = useState('prod');
  const [expandedSourceId, setExpandedSourceId] = useState(null);
  const [sources, setSources] = useState([]);
  const [loadingSources, setLoadingSources] = useState(true);
  const [selectedSource, setSelectedSource] = useState(null);
  const sourceLevels = useMemo(
    () => sources.find(s => s.id === selectedSource)?.levels || [],
    [sources, selectedSource]
  );
  const sourceHasDatabase = sourceLevels.includes('database');
  const sourceHasSchema = sourceLevels.includes('schema');

  const [sourceDatabases, setSourceDatabases] = useState([]);
  const [loadingSourceDatabases, setLoadingSourceDatabases] = useState(false);
  const [selectedSourceDatabase, setSelectedSourceDatabase] = useState(null);
  const [sourceSchemas, setSourceSchemas] = useState([]);
  const [loadingSourceSchemas, setLoadingSourceSchemas] = useState(false);
  const [selectedSourceSchema, setSelectedSourceSchema] = useState(null);
  const [sourceTables, setSourceTables] = useState([]);
  const [loadingSourceTables, setLoadingSourceTables] = useState(false);
  const [selectedSourceTable, setSelectedSourceTable] = useState(null);

  const [targetDatabases, setTargetDatabases] = useState([]);
  const [loadingTargetDatabases, setLoadingTargetDatabases] = useState(true);
  const [selectedTargetDatabase, setSelectedTargetDatabase] = useState(null);
  const [targetSchemas, setTargetSchemas] = useState([]);
  const [loadingTargetSchemas, setLoadingTargetSchemas] = useState(false);
  const [selectedTargetSchema, setSelectedTargetSchema] = useState(null);
  const [targetTables, setTargetTables] = useState([]);
  const [loadingTargetTables, setLoadingTargetTables] = useState(false);
  const [selectedTargetTable, setSelectedTargetTable] = useState(null);

  const [keyColumn, setKeyColumn] = useState('');
  const [keyColumnOptions, setKeyColumnOptions] = useState([]);
  const [loadingKeyColumnOptions, setLoadingKeyColumnOptions] = useState(false);
  const [sampleLimit, setSampleLimit] = useState(20000);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ pct: 0, message: '' });
  const [result, setResult] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [toast, setToast] = useState(null);
  const esRef = useRef(null);

  // v2: setup panel visibility + recent runs (client-side, localStorage)
  const [setupOpen, setSetupOpen] = useState(true);
  const [recentRuns, setRecentRuns] = useState(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_RUNS_KEY) || '[]'); } catch { return []; }
  });
  const sourceRequestRef = useRef(null);

  const fetchJson = useCallback(async (url) => {
    const res = await apiFetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.detail || `HTTP ${res.status}`);
    }
    return res.json();
  }, []);

  useEffect(() => {
    setLoadingSources(true);
    (async () => {
      try {
        const data = await fetchJson(`${API_BASE_URL}/api/data-validation/sources`);
        setSources(data.sources || []);
      } catch (e) {
        console.error('Failed to load source systems:', e);
      } finally {
        setLoadingSources(false);
      }
    })();
  }, [fetchJson]);

  useEffect(() => {
    setSelectedTargetDatabase(null);
    setSelectedTargetSchema(null);
    setSelectedTargetTable(null);
    setTargetSchemas([]);
    setTargetTables([]);
    (async () => {
      setLoadingTargetDatabases(true);
      try {
        const data = await fetchJson(`${API_BASE_URL}/api/data-validation/target-databases?env=${encodeURIComponent(selectedEnv)}`);
        setTargetDatabases(data.databases || []);
      } catch (e) {
        setToast({ message: `Could not load Snowflake databases: ${e.message}`, type: 'error' });
      } finally {
        setLoadingTargetDatabases(false);
      }
    })();
  }, [fetchJson, selectedEnv]);

  useEffect(() => {
    setSelectedSourceDatabase(null);
    setSelectedSourceSchema(null);
    setSelectedSourceTable(null);
    setSourceDatabases([]);
    setSourceSchemas([]);
    setSourceTables([]);
    if (!selectedSource) return;

    const requestedKey = `${selectedSource}::${selectedEnv}`;
    sourceRequestRef.current = requestedKey;

    if (sourceHasDatabase) {
      setLoadingSourceDatabases(true);
      (async () => {
        try {
          const data = await fetchJson(`${API_BASE_URL}/api/data-validation/source-databases?source_system=${encodeURIComponent(selectedSource)}&env=${encodeURIComponent(selectedEnv)}`);
          if (sourceRequestRef.current !== requestedKey) return;
          setSourceDatabases(data.databases || []);
        } catch (e) {
          if (sourceRequestRef.current !== requestedKey) return;
          setToast({ message: `Could not load databases: ${e.message}`, type: 'error' });
        } finally {
          if (sourceRequestRef.current === requestedKey) setLoadingSourceDatabases(false);
        }
      })();
    } else if (sourceHasSchema) {
      setLoadingSourceSchemas(true);
      (async () => {
        try {
          const data = await fetchJson(`${API_BASE_URL}/api/data-validation/source-schemas?source_system=${encodeURIComponent(selectedSource)}&env=${encodeURIComponent(selectedEnv)}`);
          if (sourceRequestRef.current !== requestedKey) return;
          setSourceSchemas(data.schemas || []);
        } catch (e) {
          if (sourceRequestRef.current !== requestedKey) return;
          setToast({ message: `Could not load schemas: ${e.message}`, type: 'error' });
        } finally {
          if (sourceRequestRef.current === requestedKey) setLoadingSourceSchemas(false);
        }
      })();
    } else {
      setLoadingSourceTables(true);
      (async () => {
        try {
          const data = await fetchJson(`${API_BASE_URL}/api/data-validation/source-tables?source_system=${encodeURIComponent(selectedSource)}&env=${encodeURIComponent(selectedEnv)}`);
          if (sourceRequestRef.current !== requestedKey) return;
          setSourceTables(data.tables || []);
        } catch (e) {
          if (sourceRequestRef.current !== requestedKey) return;
          setToast({ message: `Could not load tables: ${e.message}`, type: 'error' });
        } finally {
          if (sourceRequestRef.current === requestedKey) setLoadingSourceTables(false);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSource, selectedEnv]);

  useEffect(() => {
    if (!sourceHasDatabase || !selectedSourceDatabase) return;
    setSelectedSourceSchema(null);
    setSelectedSourceTable(null);
    setSourceSchemas([]);
    setSourceTables([]);

    const params = new URLSearchParams({ source_system: selectedSource, database: selectedSourceDatabase, env: selectedEnv });
    if (sourceHasSchema) {
      setLoadingSourceSchemas(true);
      (async () => {
        try {
          const data = await fetchJson(`${API_BASE_URL}/api/data-validation/source-schemas?${params}`);
          setSourceSchemas(data.schemas || []);
        } catch (e) {
          setToast({ message: `Could not load schemas: ${e.message}`, type: 'error' });
        } finally {
          setLoadingSourceSchemas(false);
        }
      })();
    } else {
      setLoadingSourceTables(true);
      (async () => {
        try {
          const data = await fetchJson(`${API_BASE_URL}/api/data-validation/source-tables?${params}`);
          setSourceTables(data.tables || []);
        } catch (e) {
          setToast({ message: `Could not load tables: ${e.message}`, type: 'error' });
        } finally {
          setLoadingSourceTables(false);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSourceDatabase]);

  useEffect(() => {
    if (!sourceHasSchema || !selectedSourceSchema) return;
    setSelectedSourceTable(null);
    setSourceTables([]);
    setLoadingSourceTables(true);

    const params = new URLSearchParams({ source_system: selectedSource, schema: selectedSourceSchema, env: selectedEnv });
    if (sourceHasDatabase && selectedSourceDatabase) params.set('database', selectedSourceDatabase);

    (async () => {
      try {
        const data = await fetchJson(`${API_BASE_URL}/api/data-validation/source-tables?${params}`);
        setSourceTables(data.tables || []);
      } catch (e) {
        setToast({ message: `Could not load tables: ${e.message}`, type: 'error' });
      } finally {
        setLoadingSourceTables(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSourceSchema]);

  useEffect(() => {
    if (!selectedTargetDatabase) return;
    setSelectedTargetSchema(null);
    setSelectedTargetTable(null);
    setTargetSchemas([]);
    setTargetTables([]);
    setLoadingTargetSchemas(true);
    (async () => {
      try {
        const data = await fetchJson(`${API_BASE_URL}/api/data-validation/target-schemas?database=${encodeURIComponent(selectedTargetDatabase)}&env=${encodeURIComponent(selectedEnv)}`);
        setTargetSchemas(data.schemas || []);
      } catch (e) {
        setToast({ message: `Could not load Snowflake schemas: ${e.message}`, type: 'error' });
      } finally {
        setLoadingTargetSchemas(false);
      }
    })();
  }, [selectedTargetDatabase, fetchJson, selectedEnv]);

  useEffect(() => {
    if (!selectedTargetDatabase || !selectedTargetSchema) return;
    setSelectedTargetTable(null);
    setTargetTables([]);
    setLoadingTargetTables(true);
    (async () => {
      try {
        const params = new URLSearchParams({ database: selectedTargetDatabase, schema: selectedTargetSchema, env: selectedEnv });
        const data = await fetchJson(`${API_BASE_URL}/api/data-validation/target-tables?${params}`);
        setTargetTables(data.tables || []);
      } catch (e) {
        setToast({ message: `Could not load Snowflake tables: ${e.message}`, type: 'error' });
      } finally {
        setLoadingTargetTables(false);
      }
    })();
  }, [selectedTargetDatabase, selectedTargetSchema, fetchJson, selectedEnv]);

  useEffect(() => {
    setKeyColumnOptions([]);
    setKeyColumn('');
    if (!selectedSource || !selectedSourceTable || !selectedTargetDatabase || !selectedTargetSchema || !selectedTargetTable) return;
    setLoadingKeyColumnOptions(true);
    // Switching tables quickly fires overlapping requests; without this the
    // slower one lands last and the picker ends up listing another table's columns.
    let stale = false;
    (async () => {
      try {
        const params = new URLSearchParams({
          source_system: selectedSource,
          source_table: selectedSourceTable,
          target_database: selectedTargetDatabase,
          target_schema: selectedTargetSchema,
          target_table: selectedTargetTable,
          env: selectedEnv,
        });
        if (selectedSourceDatabase) params.set('source_database', selectedSourceDatabase);
        if (selectedSourceSchema) params.set('source_schema', selectedSourceSchema);
        const data = await fetchJson(`${API_BASE_URL}/api/data-validation/common-columns?${params}`);
        if (stale) return;
        setKeyColumnOptions(data.columns || []);
      } catch (e) {
        if (!stale) setToast({ message: `Could not load columns: ${e.message}`, type: 'error' });
      } finally {
        if (!stale) setLoadingKeyColumnOptions(false);
      }
    })();
    return () => { stale = true; };
  }, [selectedSource, selectedSourceDatabase, selectedSourceSchema, selectedSourceTable,
      selectedTargetDatabase, selectedTargetSchema, selectedTargetTable, fetchJson, selectedEnv]);

  useEffect(() => () => esRef.current?.close(), []);

  // Persist a compact recent-runs history on every completed run.
  useEffect(() => {
    if (!result) return;
    try {
      const entry = {
        label: SOURCE_META[selectedSource]?.label || selectedSource,
        table: result.source_table,
        status: result.overall_status,
        ts: Date.now(),
      };
      const runs = [entry, ...recentRuns].slice(0, 4);
      localStorage.setItem(RECENT_RUNS_KEY, JSON.stringify(runs));
      setRecentRuns(runs);
    } catch { /* storage unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const canRunValidation = Boolean(
    canRun && !running &&
    selectedSource &&
    (!sourceHasDatabase || selectedSourceDatabase) &&
    (!sourceHasSchema || selectedSourceSchema) &&
    selectedSourceTable &&
    selectedTargetDatabase && selectedTargetSchema && selectedTargetTable
  );

  // Closing the EventSource drops the HTTP connection, which is what the
  // server watches for — it stops the run at its next checkpoint rather than
  // finishing every remaining stage against the warehouse.
  const handleCancelValidation = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setRunning(false);
    setProgress({ pct: 0, message: '' });
    setToast({ message: 'Validation cancelled.', type: 'info' });
  }, []);

  const handleRunValidation = useCallback(() => {
    if (!canRunValidation) return;
    // A previous stream can still be open if the last run errored out; leaving
    // it running would keep pushing progress events into this one.
    esRef.current?.close();
    setRunning(true);
    setResult(null);
    setProgress({ pct: 0, message: 'Starting…' });

    const params = new URLSearchParams({
      source_system: selectedSource,
      source_table: selectedSourceTable,
      target_database: selectedTargetDatabase,
      target_schema: selectedTargetSchema,
      target_table: selectedTargetTable,
      env: selectedEnv,
    });
    if (sourceHasDatabase && selectedSourceDatabase) params.set('source_database', selectedSourceDatabase);
    if (sourceHasSchema && selectedSourceSchema) params.set('source_schema', selectedSourceSchema);
    if (keyColumn.trim()) params.set('key_column', keyColumn.trim());
    if (sampleLimit) params.set('sample_limit', String(sampleLimit));

    const es = apiEventSource(`/api/data-validation/run?${params.toString()}`);
    esRef.current = es;
    let terminal = false;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'progress') {
          setProgress({ pct: data.pct, message: data.message });
        } else if (data.type === 'result') {
          setResult(data.result);
          setSetupOpen(false);
        } else if (data.type === 'error') {
          terminal = true;
          setToast({ message: data.message, type: 'error' });
          // Don't wait for `done` — if the stream dies right after the error
          // the button stays disabled and the user is stuck on a fake spinner.
          setRunning(false);
        } else if (data.type === 'done') {
          terminal = true;
          setRunning(false);
          es.close();
        }
      } catch (e) { console.error('SSE parse error:', e); }
    };

    es.onerror = () => {
      if (terminal) return;
      terminal = true;
      setToast({ message: 'Connection lost while running the validation.', type: 'error' });
      setRunning(false);
      es.close();
    };
  }, [canRunValidation, selectedSource, sourceHasDatabase, sourceHasSchema, selectedSourceDatabase,
      selectedSourceSchema, selectedSourceTable, selectedTargetDatabase, selectedTargetSchema,
      selectedTargetTable, keyColumn, sampleLimit, selectedEnv]);

  const handleDownloadReport = useCallback(async () => {
    if (!result) return;
    setDownloading(true);
    try {
      const res = await apiFetch(`/api/data-validation/prepare-download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      });
      if (!res.ok) throw new Error((await res.json())?.detail || `HTTP ${res.status}`);
      const { token } = await res.json();
      downloadFile(`/api/data-validation/download-report?token=${token}`, 'validation_report.xlsx');
    } catch (e) {
      setToast({ message: `Could not prepare report: ${e.message}`, type: 'error' });
    } finally {
      setDownloading(false);
    }
  }, [result]);

  // Preview of what the backend's auto-detect will land on, so the user isn't
  // guessing what "Auto-detect" means before they run.
  const autoKeyGuess = useMemo(() => {
    const scored = keyColumnOptions.filter(c => c.sortable !== false && (c.suggested_score || 0) > 0);
    if (!scored.length) return null;
    return scored.reduce((a, b) => (b.suggested_score > a.suggested_score ? b : a)).name;
  }, [keyColumnOptions]);

  const sourceRefText = [selectedSourceDatabase, selectedSourceSchema, selectedSourceTable].filter(Boolean).join('.');
  const targetRefText = [selectedTargetDatabase, selectedTargetSchema, selectedTargetTable].filter(Boolean).join('.');
  const sourceLabel = SOURCE_META[selectedSource]?.label || sources.find(s => s.id === selectedSource)?.label || null;

  const runStatusColor = s => (s === 'PASSED' ? C.pass : s === 'WARNING' ? C.warnDot : C.fail);
  const runStatusText = s => (s === 'PASSED' ? 'Passed' : s === 'WARNING' ? 'Warning' : 'Failed');
  const fmtRunTime = ts => {
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    return sameDay ? `today ${time}` : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const nodeCard = { border: `1px solid ${C.border}`, background: C.panelSoft, borderRadius: 10, padding: '13px 14px', display: 'flex', flexDirection: 'column', gap: 3 };
  const railPanel = { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden', boxShadow: '0 1px 3px rgba(49,44,42,0.05)' };

  return (
    <ErrorBoundary>
      <style>{DV_KEYFRAMES}</style>
      <div style={{
        minHeight: '100vh', fontFamily: font, color: C.text, paddingBottom: 56,
        backgroundColor: C.bg,
        backgroundImage: 'linear-gradient(rgba(49,44,42,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(49,44,42,0.035) 1px, transparent 1px)',
        backgroundSize: '44px 44px',
      }}>
        <div style={{ height: 2, background: 'linear-gradient(90deg, #eb1700 0%, rgba(235,23,0,0.35) 34%, transparent 72%)' }} />

        {/* Header */}
        <div style={{ maxWidth: 1560, margin: '0 auto', padding: '30px 36px 0 36px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, paddingBottom: 26 }}>
            {onBack && (
              <button onClick={onBack} aria-label="Back" className="dv-ghostbtn"
                style={{ width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, background: '#fff', border: `1px solid ${C.border}`, cursor: 'pointer', flex: 'none', marginTop: 22 }}>
                <Icon src={chevronLeftIcon} alt="" className="w-4 h-4" color="jj-gray-06" />
              </button>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.red, animation: 'dvPulse 2.4s ease-in-out infinite' }} />
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: C.faint }}>Data Quality Engine</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <h1 style={{ margin: 0, fontFamily: fontDisplay, fontWeight: 700, fontSize: 32, lineHeight: '110%', color: C.text }}>Data Validation</h1>
                <BetaBadge />
              </div>
              <p style={{ margin: '2px 0 0 0', fontSize: 14, color: C.muted, maxWidth: 640, textWrap: 'pretty' }}>
                Compare any source table against its Snowflake target — structure, quality, and record-level checks in one run.
              </p>
            </div>
          </div>
        </div>

        <div style={{ maxWidth: 1560, margin: '0 auto', padding: '0 36px', display: 'grid', gridTemplateColumns: 'minmax(300px, 372px) 1fr', gap: 22, alignItems: 'start' }}>

          {/* ══ Setup rail ══ */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={railPanel}>
              <div style={{ padding: '18px 20px 14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={label}>Comparison</span>
                <button onClick={() => setSetupOpen(p => !p)}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', fontFamily: font, fontSize: 12, fontWeight: 700, color: C.red, padding: 0 }}>
                  {setupOpen ? 'Hide pickers' : 'Change'}
                </button>
              </div>
              <div style={{ padding: '0 20px 4px 20px' }}>
                <div style={nodeCard}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.red, boxShadow: '0 0 6px rgba(235,23,0,0.45)', flex: 'none' }} />
                    <span style={{ ...microLabel, letterSpacing: '0.14em' }}>
                      Source{sourceLabel ? ` · ${sourceLabel}` : ''}{selectedEnv !== 'default' && selectedSource ? ` · ${selectedEnv.toUpperCase()}` : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: sourceRefText ? C.text : C.faint, paddingLeft: 16, wordBreak: 'break-all' }}>
                    {sourceRefText || 'Choose a source table'}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0 5px 17px' }}>
                  <div style={{ width: 2, height: 18, backgroundImage: 'linear-gradient(rgba(235,23,0,0.55) 50%, transparent 50%)', backgroundSize: '2px 8px', animation: 'dvFlow 1.1s linear infinite' }} />
                  <span style={{ fontSize: 11, color: C.faint }}>compared against</span>
                </div>
                <div style={nodeCard}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.blue, boxShadow: '0 0 6px rgba(15,104,178,0.4)', flex: 'none' }} />
                    <span style={{ ...microLabel, letterSpacing: '0.14em' }}>Target · Snowflake</span>
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: targetRefText ? C.text : C.faint, paddingLeft: 16, wordBreak: 'break-all' }}>
                    {targetRefText || 'Choose a target table'}
                  </div>
                </div>
              </div>

              <div style={{ padding: '16px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <label style={microLabel}>Key column</label>
                  <select
                    value={keyColumn}
                    onChange={e => setKeyColumn(e.target.value)}
                    disabled={loadingKeyColumnOptions}
                    style={{ border: `1px solid ${C.borderInput}`, borderRadius: 8, padding: '8px 6px', fontSize: 13, fontWeight: 500, color: C.text, background: '#fff', fontFamily: font, outline: 'none', width: '100%', opacity: loadingKeyColumnOptions ? 0.5 : 1 }}>
                    <option value="">
                      {loadingKeyColumnOptions ? 'Loading…' : autoKeyGuess ? `Auto-detect (${autoKeyGuess})` : 'Auto-detect (row-by-row)'}
                    </option>
                    {keyColumnOptions.map(col => (
                      // sortable === false means the type can't be ordered in SQL;
                      // the run would reject it, so don't let it be picked here.
                      <option key={col.name} value={col.name} disabled={col.sortable === false}>
                        {col.name} · {col.type}{col.sortable === false ? ' (not sortable)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <label style={microLabel}>Sample limit</label>
                  <input
                    type="number" min={100} max={200000} step={1000}
                    value={sampleLimit}
                    onChange={e => setSampleLimit(e.target.value === '' ? '' : Number(e.target.value))}
                    onBlur={e => {
                      const n = Number(e.target.value);
                      setSampleLimit(Number.isFinite(n) && n > 0 ? Math.max(100, Math.min(200000, n)) : 20000);
                    }}
                    style={{ border: `1px solid ${C.borderInput}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, fontWeight: 500, color: C.text, background: '#fff', fontFamily: font, outline: 'none', width: '100%' }}
                  />
                </div>
                <div style={{ gridColumn: '1 / -1', fontSize: 11.5, color: C.faint, lineHeight: 1.45, textWrap: 'pretty' }}>
                  Full-table checks always run; the limit only caps record-level sampling. Auto-detect picks the most likely identifier column, and falls back to a full row-by-row match if the key turns out to be non-unique or nullable.
                </div>
              </div>

              <div style={{ padding: '4px 20px 20px 20px' }}>
                {running ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ height: 9, borderRadius: 999, background: C.borderSoft, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 999, backgroundColor: C.red,
                        backgroundImage: 'linear-gradient(135deg, rgba(255,255,255,0.28) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.28) 50%, rgba(255,255,255,0.28) 75%, transparent 75%)',
                        backgroundSize: '28px 28px', animation: 'dvStripe 0.7s linear infinite',
                        boxShadow: '0 0 8px rgba(235,23,0,0.35)', transition: 'width 0.3s ease', width: `${progress.pct}%`,
                      }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: C.muted, gap: 12 }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{progress.message}</span>
                      <span style={{ fontWeight: 700, color: C.text }}>{Math.round(progress.pct)}%</span>
                      <button onClick={handleCancelValidation} className="dv-ghostbtn"
                        style={{
                          border: `1px solid ${C.borderInput}`, background: C.panel, cursor: 'pointer',
                          fontFamily: font, fontSize: 11, fontWeight: 700, color: C.text2,
                          borderRadius: 7, padding: '5px 12px', letterSpacing: '0.08em', textTransform: 'uppercase',
                        }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={handleRunValidation} disabled={!canRunValidation} className="dv-runbtn"
                    style={{
                      width: '100%', border: 'none', cursor: canRunValidation ? 'pointer' : 'not-allowed',
                      fontFamily: font, fontSize: 14, fontWeight: 700, color: '#fff',
                      background: canRunValidation ? 'linear-gradient(180deg, #ff2d12 0%, #eb1700 60%, #d31400 100%)' : '#cbc4bc',
                      borderRadius: 10, padding: '14px 0', letterSpacing: '0.08em', textTransform: 'uppercase',
                      boxShadow: canRunValidation ? '0 3px 14px rgba(235,23,0,0.28)' : 'none',
                    }}>
                    Run validation
                  </button>
                )}
                {!canRun && (
                  <p style={{ fontSize: 12, color: C.faint, margin: '10px 0 0 0' }}>You don't have permission to run IT validations.</p>
                )}
              </div>
            </div>

            {recentRuns.length > 0 && (
              <div style={railPanel}>
                <div style={{ padding: '16px 20px 10px 20px', ...label }}>Recent runs</div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {recentRuns.map((r, i) => (
                    <div key={i} className="dv-rowbtn" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', borderTop: `1px solid ${C.borderSoft}` }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: runStatusColor(r.status), flex: 'none' }} />
                      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.table}</span>
                        <span style={{ fontSize: 11, color: C.faint }}>{r.label} → Snowflake · {fmtRunTime(r.ts)}</span>
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, color: r.status === 'WARNING' ? C.warn : runStatusColor(r.status) }}>{runStatusText(r.status)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ══ Main column ══ */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>

            {setupOpen && (
              <div style={{ ...railPanel, animation: 'dvExpand .25s ease-out' }}>
                <div style={{ padding: '18px 24px 12px 24px', ...label }}>1 · Source system</div>
                <div style={{ padding: '0 24px 18px 24px' }}>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {(loadingSources ? [] : sources).map(s => {
                      const meta = SOURCE_META[s.id] || { label: s.label, color: 'jj-gray-06' };
                      const active = selectedSource === s.id;
                      const hasEnvChoice = (s.environments || []).length > 0;
                      const expanded = expandedSourceId === s.id;
                      const envOptions = ENVIRONMENTS.filter(e => (s.environments || []).includes(e.id));
                      return (
                        <div key={s.id} className="relative">
                          <button
                            onClick={() => {
                              if (!s.configured) return;
                              if (hasEnvChoice) {
                                setExpandedSourceId(p => (p === s.id ? null : s.id));
                              } else {
                                setSelectedSource(s.id);
                                setSelectedEnv('default');
                              }
                            }}
                            disabled={!s.configured}
                            title={!s.configured ? 'Not configured (or could not connect) in data_validation_config.ini' : ''}
                            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all text-left ${
                              active ? 'border-jj-red bg-red-50' :
                              !s.configured ? 'border-jj-gray-02 bg-jj-gray-01 opacity-50 cursor-not-allowed' :
                              'border-jj-gray-02 bg-white hover:border-jj-gray-04 hover:bg-jj-gray-01'
                            }`}
                          >
                            <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${active ? 'bg-jj-red' : 'bg-jj-gray-01'}`}>
                              <Icon src={databaseIcon} alt="" className="w-5 h-5" color={active ? 'white' : meta.color} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className={`font-johnson-display text-sm ${active ? 'text-jj-red' : 'text-jj-gray-08'}`} style={{ lineHeight: '110%' }}>{s.label}</p>
                              <p className="font-johnson-text text-xs text-jj-gray-05">
                                {!s.configured ? 'Not configured' : active ? (hasEnvChoice ? `${selectedEnv.toUpperCase()} selected` : 'Selected') : 'Configured'}
                              </p>
                            </div>
                            {s.configured && hasEnvChoice && (
                              <Icon src={chevronDownIcon} alt="" className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} color="jj-gray-06" />
                            )}
                          </button>
                          {s.configured && hasEnvChoice && expanded && (
                            <div className="absolute z-10 top-full left-0 right-0 mt-1 rounded-lg border border-jj-gray-02 bg-white shadow-lg overflow-hidden">
                              {envOptions.map(e => (
                                <button
                                  key={e.id}
                                  onClick={() => {
                                    setSelectedSource(s.id);
                                    setSelectedEnv(e.id);
                                    setExpandedSourceId(null);
                                  }}
                                  className={`block w-full text-left px-4 py-2 font-johnson-text text-xs font-bold tracking-wide border-b border-jj-gray-01 last:border-b-0 ${
                                    active && selectedEnv === e.id ? 'bg-red-50 text-jj-red' : 'text-jj-gray-08 hover:bg-jj-gray-01'
                                  }`}
                                >
                                  {e.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {loadingSources && (
                      <div className="col-span-3 flex items-center justify-center h-16 gap-2">
                        <Icon src={loadingIcon} alt="" className="w-4 h-4 animate-spin" color="jj-gray-05" />
                        <span className="font-johnson-text text-xs text-jj-gray-05">Loading source systems…</span>
                      </div>
                    )}
                  </div>
                </div>

                {selectedSource && (
                  <div style={{ borderTop: `1px solid ${C.borderSoft}`, padding: '18px 24px 22px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
                      <span style={{ ...microLabel, color: C.red }}>2 · {sourceLabel}{selectedEnv !== 'default' ? ` · ${selectedEnv.toUpperCase()}` : ''} (source)</span>
                      <CascadePicker
                        databases={sourceDatabases} schemas={sourceSchemas} tables={sourceTables}
                        loadingDatabases={loadingSourceDatabases} loadingSchemas={loadingSourceSchemas} loadingTables={loadingSourceTables}
                        selectedDatabase={selectedSourceDatabase} selectedSchema={selectedSourceSchema} selectedTable={selectedSourceTable}
                        onSelectDatabase={setSelectedSourceDatabase} onSelectSchema={setSelectedSourceSchema} onSelectTable={setSelectedSourceTable}
                        hasDatabase={sourceHasDatabase} hasSchema={sourceHasSchema} accent="red"
                        globalSearch={async (q, limit, offset) => {
                          const params = new URLSearchParams({ source_system: selectedSource, query: q, env: selectedEnv, limit: String(limit || 20), offset: String(offset || 0) });
                          const data = await fetchJson(`${API_BASE_URL}/api/data-validation/source-table-search?${params}`);
                          return { results: data.results || [], truncated: !!data.truncated, nextOffset: data.next_offset || 0 };
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
                      <span style={{ ...microLabel, color: C.blue }}>3 · Snowflake (target)</span>
                      <CascadePicker
                        databases={targetDatabases} schemas={targetSchemas} tables={targetTables}
                        loadingDatabases={loadingTargetDatabases} loadingSchemas={loadingTargetSchemas} loadingTables={loadingTargetTables}
                        selectedDatabase={selectedTargetDatabase} selectedSchema={selectedTargetSchema} selectedTable={selectedTargetTable}
                        onSelectDatabase={setSelectedTargetDatabase} onSelectSchema={setSelectedTargetSchema} onSelectTable={setSelectedTargetTable}
                        hasDatabase={true} hasSchema={true} accent="blue"
                        globalSearch={async (q, limit, offset) => {
                          const params = new URLSearchParams({ query: q, env: selectedEnv, limit: String(limit || 20), offset: String(offset || 0) });
                          const data = await fetchJson(`${API_BASE_URL}/api/data-validation/target-table-search?${params}`);
                          return { results: data.results || [], truncated: !!data.truncated, nextOffset: data.next_offset || 0 };
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {result ? (
              <ResultsChecklist result={result} onDownload={handleDownloadReport} downloading={downloading} />
            ) : !setupOpen && (
              <div style={{ ...railPanel, padding: '40px 24px', textAlign: 'center' }}>
                <p style={{ fontSize: 13, color: C.faint, margin: 0 }}>Pick a source and target table, then run a validation to see results here.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </ErrorBoundary>
  );
}

export default DataValidation;