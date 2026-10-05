import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import LoadingSpinner from '../../components/LoadingSpinner';
import TableCopier from './TableCopier';
import { apiFetch, downloadFile } from '../../../utils/apiClient';
import { useInPageLog } from '../useInPageLog';
import {
  IconDefs, Icon, CopyIcon, Pager, ExplorerTree,
  ConfirmDestructiveModal, TextModal, SavePromptModal, ResultsSkeleton,
} from '../shared/studioParts';
import {
  PAGE_SIZE_OPTIONS, DEFAULT_COL_WIDTH, MIN_COL_WIDTH, MAX_COL_WIDTH,
  EXPORT_FORMATS, FILTER_OPS, STATIC_SUGGESTIONS,
  fetchJson, cellText, formatWhen, leadKeywordHint, sqlTokenAtCaret, caretPixelPos,
  tokenizeSql, TOKEN_COLORS, parseTableRefs, resolveRef, clauseAtCaret, rankSuggestions,
} from '../shared/studioHelpers';

import refreshIcon from "/icons/JJ_Icon_Refresh_RGB.svg";
import downloadIcon from "/icons/JJ_Icon_Download_PDF_RGB.svg";
import chevronDownIcon from "/icons/JJ_Icon_Chevron_Down.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import playIcon from "/icons/JJ_Icon_Video_Play_RGB.svg";
import filterIcon from "/icons/JJ_Icon_Filter.svg";
import saveIcon from "/icons/JJ_Icon_Save_RGB.svg";
import deleteIcon from "/icons/JJ_Icon_Delete_RGB.svg";
import addIcon from "/icons/JJ_Icon_Add.svg";
import closeIcon from "/icons/JJ_Icon_Close.svg";
import timeIcon from "/icons/JJ_Icon_Time_RGB.svg";
import sfIcon from "/icons/snowflake_badge.svg";

/* ==========================================================================
   Data Studio — Snowflake worksheet console layout.

   The page is a three-column console: object explorer, worksheet (editor over
   results), and a query-profile rail. Every worksheet tab owns its own result
   view, so switching tabs restores what that worksheet last returned instead
   of clearing the grid.
   ========================================================================== */

const LS = {
  tabs: 'snowflake.tabs',
  activeTab: 'snowflake.activeTab',
  theme: 'snowflake.editorTheme',
  pageSize: 'snowflake.pageSize',
  profile: 'snowflake.profilePanel',
  explorer: 'snowflake.explorerCollapsed',
};

const readLocal = (key, fallback = null) => {
  try { return window.localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const writeLocal = (key, value) => {
  try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
};

/* ------------------------------- palette --------------------------------- */
// Console surfaces sit outside the J&J accent palette on purpose: this page is
// a data tool, so the chrome stays neutral and the brand accents are reserved
// for state (running / failed / staged edits).
const C = {
  line: '#dfe3e8',
  lineSoft: '#eceff2',
  panel: '#f5f7f9',
  panelSoft: '#fbfcfd',
  ink: '#1a1d21',
  muted: '#5c6670',
  faint: '#8a949e',
  primary: '#11567f',
  primaryHover: '#0d4363',
  accent: '#29b5e8',
  accentSoft: '#e3f2fa',
  green: '#1f8f4e',
  red: '#c02b2b',
  redSoft: '#fcf1f1',
  amber: '#b8730d',
  amberSoft: '#fdf3e3',
  violet: '#7b3fe4',
};

const EMPTY_VIEW = {
  status: 'idle',          // idle | starting | running | success | failed | cancelled
  jobId: null,
  meta: null,
  error: null,
  rows: [],
  columns: [],
  page: 1,
  totalPages: 1,
  rowCount: null,
  sort: [],
  filters: [],
  widths: {},
  loading: false,
  // data-editor only
  tableMeta: null,
  keyColumns: [],
  edits: {},
  deleted: [],
  newRows: [],
  notice: null,
};

const newQueryTab = (n) => ({ id: `q${Date.now()}_${n}`, kind: 'query', name: `Worksheet ${n}`, sql: '' });
const newCopierTab = () => ({ id: `copier${Date.now()}`, kind: 'copier', name: 'Table Copier' });

/* --------------------------- column type marks --------------------------- */

const typeMark = (dataType) => {
  const t = (dataType || '').toUpperCase();
  if (/(DATE|TIME|TIMESTAMP)/.test(t)) return 'time';
  if (/(NUMBER|INT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL)/.test(t)) return '#';
  if (/(BOOL)/.test(t)) return 'T|F';
  if (/(VARIANT|OBJECT|ARRAY)/.test(t)) return '{ }';
  return 'Ab';
};

const TypeMark = ({ dataType }) => {
  const mark = typeMark(dataType);
  if (mark === 'time') {
    return <Icon src={timeIcon} className="w-2.5 h-2.5 flex-shrink-0" tint="gray" alt="date or timestamp column" />;
  }
  return <span className="flex-shrink-0 font-mono text-[9.5px] text-[#8a949e]">{mark}</span>;
};

/* ============================ syntax highlighting ========================= */
/**
 * A textarea can't colour its own text, so a <pre> sits behind it painting
 * coloured tokens while the textarea on top keeps its text transparent. Both
 * share identical font metrics, padding and scroll offsets.
 */
function HighlightLayer({ text, theme, scrollTop, scrollLeft }) {
  const palette = TOKEN_COLORS[theme] || TOKEN_COLORS.light || TOKEN_COLORS.dark;
  const tokens = useMemo(() => tokenizeSql(text || ''), [text]);
  return (
    <div aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
      <pre
        className="m-0 px-4 py-3 whitespace-pre-wrap break-words text-[12.5px] font-mono leading-[1.7]"
        style={{ transform: `translate(${-scrollLeft}px, ${-scrollTop}px)` }}
      >
        {tokens.map((token, i) => (
          <span
            key={i}
            style={{
              color: palette[token.kind] || palette.plain,
              fontStyle: token.kind === 'comment' ? 'italic' : undefined,
            }}
          >
            {token.text}
          </span>
        ))}
        {'\n'}
      </pre>
    </div>
  );
}

function LineGutter({ text, height }) {
  const count = Math.max(1, (text || '').split('\n').length);
  return (
    <div
      className="flex-shrink-0 w-[42px] py-3 pr-[11px] text-right font-mono text-[12.5px] leading-[1.7] text-[#5c6670] select-none bg-[#fbfcfd] border-r border-[#eceff2] overflow-hidden"
      style={{ height }}
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, i) => <div key={i}>{i + 1}</div>)}
    </div>
  );
}

/* ===================== column filter popover (results grid) ================ */

function FilterPopover({ column, current, onApply, onClear, onClose }) {
  const [op, setOp] = useState(current?.op || 'contains');
  const [value, setValue] = useState(
    current?.values ? current.values.join('\n') : (current?.value ?? '')
  );
  const spec = FILTER_OPS.find(f => f.id === op);
  const isList = op === 'in' || op === 'not_in';

  const apply = () => {
    if (!spec.needsValue) { onApply({ col: column, op }); return; }
    if (isList) {
      const values = value.split(/[\n,]/).map(v => v.trim()).filter(Boolean);
      if (!values.length) return;
      onApply({ col: column, op, values });
      return;
    }
    onApply({ col: column, op, value });
  };

  return (
    <div
      className="absolute z-30 top-full left-0 mt-1 w-[236px] bg-white border border-[#dfe3e8] rounded-md shadow-lg p-2.5"
      onClick={e => e.stopPropagation()}
    >
      <div className="text-[10.5px] font-bold uppercase tracking-wider text-[#8a949e] mb-1.5 truncate">{column}</div>
      <select
        value={op}
        onChange={e => setOp(e.target.value)}
        className="w-full border border-[#dfe3e8] rounded px-2 py-1.5 text-[12px] font-johnson-text mb-1.5"
      >
        {FILTER_OPS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select>
      {spec.needsValue && (
        isList ? (
          <textarea
            autoFocus
            rows={3}
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="One value per line"
            className="w-full border border-[#dfe3e8] rounded px-2 py-1.5 text-[12px] font-mono resize-none focus:outline-none focus:border-[#29b5e8]"
          />
        ) : (
          <input
            autoFocus
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
            placeholder="Value"
            className="w-full border border-[#dfe3e8] rounded px-2 py-1.5 text-[12px] font-mono focus:outline-none focus:border-[#29b5e8]"
          />
        )
      )}
      <div className="flex items-center justify-between gap-2 mt-2.5">
        <button onClick={onClear} className="text-[11.5px] font-johnson-text text-[#5c6670] hover:text-[#1a1d21]">Clear</button>
        <div className="flex items-center gap-1.5">
          <button onClick={onClose} className="px-2.5 py-1 rounded border border-[#dfe3e8] text-[11.5px] font-johnson-text hover:bg-[#f5f7f9]">Cancel</button>
          <button onClick={apply} className="px-2.5 py-1 rounded bg-[#11567f] text-white text-[11.5px] font-johnson-text hover:bg-[#0d4363]">Apply</button>
        </div>
      </div>
    </div>
  );
}

/* ============================== data grid ================================= */

function DataGrid({
  columns, rows, widths, setWidths,
  sort, onSort, filters, onFilter,
  loading, emptyMessage,
  editable = false,
  columnMeta = {},
  edits = {},
  deleted = [],
  newRows = [],
  onEditCell, onToggleDelete, onEditNewCell, onRemoveNewRow, onCellClick,
}) {
  const [openFilter, setOpenFilter] = useState(null);
  const resizeRef = useRef(null);
  const deletedSet = useMemo(() => new Set(deleted), [deleted]);

  useEffect(() => {
    const close = () => setOpenFilter(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const startResize = (e, name) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { name, startX: e.clientX, startWidth: widths[name] || DEFAULT_COL_WIDTH };
    const onMove = (ev) => {
      const state = resizeRef.current;
      if (!state) return;
      const next = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, state.startWidth + (ev.clientX - state.startX)));
      setWidths(w => ({ ...w, [state.name]: next }));
    };
    const onUp = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const filterFor = (name) => (filters || []).find(f => f.col === name) || null;
  const sortFor = (name) => (sort || []).find(s => s.col === name) || null;

  if (!columns || columns.length === 0) {
    return <div className="px-3 py-8 text-center text-[#5c6670] text-[12.5px] font-johnson-text">{emptyMessage}</div>;
  }

  return (
    <table className="text-[12.5px] font-johnson-text" style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
      <thead className="sticky top-0 z-[10]">
        <tr className="bg-[#fbfcfd]">
          {editable && <th className="w-[38px] px-2 py-2 border-b border-r border-[#dfe3e8]" />}
          {columns.map(col => {
            const name = col.name;
            const activeFilter = filterFor(name);
            const activeSort = sortFor(name);
            const meta = columnMeta[name];
            const dataType = meta?.data_type || col.type;
            return (
              <th
                key={name}
                style={{ width: widths[name] || DEFAULT_COL_WIDTH }}
                className="relative px-3 py-2 text-left select-none border-b border-r border-[#dfe3e8] bg-[#fbfcfd]"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <button
                    onClick={e => onSort(name, e.shiftKey)}
                    title="Sort by this column · shift-click to add to the sort"
                    className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
                  >
                    <TypeMark dataType={dataType} />
                    {meta?.is_primary_key && <span className="text-[9px] font-bold text-[#b8730d] flex-shrink-0">PK</span>}
                    <span className="truncate text-[12px] font-medium text-[#1a1d21]">{name}</span>
                    {activeSort && (
                      <span className="flex-shrink-0 text-[#11567f] text-[10px]">
                        {activeSort.dir === 'asc' ? '▲' : '▼'}
                        {(sort || []).length > 1 ? (sort.indexOf(activeSort) + 1) : ''}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); setOpenFilter(openFilter === name ? null : name); }}
                    title="Filter this column"
                    className={`flex-shrink-0 p-0.5 rounded ${activeFilter ? 'bg-[#e3f2fa]' : 'hover:bg-[#eceff2]'}`}
                  >
                    <Icon src={filterIcon} className="w-2.5 h-2.5" tint="gray" />
                  </button>
                </div>
                <div className="text-[10px] text-[#8a949e] truncate pl-[18px]">{dataType}</div>
                {openFilter === name && (
                  <FilterPopover
                    column={name}
                    current={activeFilter}
                    onApply={f => { onFilter(f); setOpenFilter(null); }}
                    onClear={() => { onFilter({ col: name, op: null }); setOpenFilter(null); }}
                    onClose={() => setOpenFilter(null)}
                  />
                )}
                <span
                  onMouseDown={e => startResize(e, name)}
                  className="absolute top-0 right-0 h-full w-[5px] cursor-col-resize hover:bg-[#29b5e8]/50"
                />
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => {
          const rowEdits = edits[rowIndex] || {};
          const isDeleted = deletedSet.has(rowIndex);
          return (
            <tr key={rowIndex} className={isDeleted ? 'bg-[#fcf1f1] line-through text-[#8a949e]' : 'hover:bg-[#f7fbfd]'}>
              {editable && (
                <td className="px-2 py-1 border-b border-r border-[#eceff2] text-center align-middle no-underline">
                  <button
                    onClick={() => onToggleDelete(rowIndex)}
                    title={isDeleted ? 'Keep this row' : 'Mark this row for deletion'}
                    className="p-1 rounded hover:bg-[#eceff2]"
                  >
                    <Icon src={isDeleted ? refreshIcon : deleteIcon} className="w-3 h-3" tint={isDeleted ? null : 'gray'} />
                  </button>
                </td>
              )}
              {columns.map((col, colIndex) => {
                const name = col.name;
                const dirty = Object.prototype.hasOwnProperty.call(rowEdits, name);
                const value = dirty ? rowEdits[name] : row[colIndex];
                const meta = columnMeta[name];
                const cellEditable = editable && !isDeleted && (meta ? meta.editable : true);
                return (
                  <td
                    key={name}
                    style={{ width: widths[name] || DEFAULT_COL_WIDTH, boxShadow: dirty ? 'inset 2px 0 0 #b8730d' : undefined }}
                    onDoubleClick={() => !editable && onCellClick?.(name, row[colIndex])}
                    className={`px-3 py-1 align-top border-b border-r border-[#eceff2] ${dirty ? 'bg-[#fdf3e3]' : ''}`}
                  >
                    {cellEditable ? (
                      <input
                        value={value === null || value === undefined ? '' : cellText(value)}
                        onChange={e => onEditCell(rowIndex, name, e.target.value)}
                        placeholder={value === null ? 'null' : ''}
                        className="w-full bg-transparent text-[12.5px] font-johnson-text text-[#1a1d21] focus:outline-none focus:bg-white focus:ring-1 focus:ring-[#29b5e8] rounded px-1 -mx-1"
                      />
                    ) : (
                      <div className="truncate text-[#1a1d21] cursor-default" title={cellText(value) ?? 'null'}>
                        {value === null || value === undefined
                          ? <span className="italic text-[#8a949e]">null</span>
                          : cellText(value)}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}

        {editable && newRows.map((draft, i) => (
          <tr key={`new-${i}`} className="bg-[#f1f9f4]">
            <td className="px-2 py-1 border-b border-r border-[#eceff2] text-center align-middle">
              <button onClick={() => onRemoveNewRow(i)} title="Discard this new row" className="p-1 rounded hover:bg-[#eceff2]">
                <Icon src={closeIcon} className="w-3 h-3" tint="gray" />
              </button>
            </td>
            {columns.map(col => {
              const meta = columnMeta[col.name];
              return (
                <td key={col.name} style={{ width: widths[col.name] || DEFAULT_COL_WIDTH }} className="px-3 py-1 border-b border-r border-[#eceff2]">
                  {meta && !meta.editable ? (
                    <span className="text-[11px] italic text-[#8a949e]">not editable</span>
                  ) : (
                    <input
                      value={draft[col.name] ?? ''}
                      onChange={e => onEditNewCell(i, col.name, e.target.value)}
                      placeholder={meta?.nullable === false ? 'required' : 'null'}
                      className="w-full bg-transparent text-[12.5px] font-johnson-text text-[#1a1d21] focus:outline-none focus:bg-white focus:ring-1 focus:ring-[#29b5e8] rounded px-1 -mx-1"
                    />
                  )}
                </td>
              );
            })}
          </tr>
        ))}

        {rows.length === 0 && newRows.length === 0 && !loading && (
          <tr>
            <td colSpan={(columns.length || 1) + (editable ? 1 : 0)} className="px-3 py-8 text-center text-[#5c6670]">
              {emptyMessage}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/* ============================ query profile rail ========================== */

function ProfileRow({ label, value, tone }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-[12px]">
      <span className="text-[#5c6670] flex-shrink-0">{label}</span>
      <span className="tabular-nums text-right truncate" style={{ color: tone || C.ink }}>{value}</span>
    </div>
  );
}

function QueryProfile({ view, tab, serverInfo, dirtyCount, onClose }) {
  const rows = [];
  if (tab.kind === 'data') {
    rows.push({ label: 'State', value: 'Editable grid' });
    rows.push({ label: 'Row key', value: view.tableMeta?.primary_key?.join(', ') || 'every column', tone: view.tableMeta?.primary_key?.length ? C.ink : C.amber });
    rows.push({ label: 'Staged', value: dirtyCount ? `${dirtyCount} change${dirtyCount === 1 ? '' : 's'}` : 'None', tone: dirtyCount ? C.amber : C.ink });
    rows.push({ label: 'Applied as', value: 'One transaction' });
  } else if (view.status === 'running' || view.status === 'starting') {
    rows.push({ label: 'State', value: view.status === 'starting' ? 'Starting…' : 'Running…', tone: C.primary });
    rows.push({ label: 'Bytes scanned', value: '—', tone: C.faint });
    rows.push({ label: 'Rows', value: '—', tone: C.faint });
  } else if (view.status === 'failed') {
    rows.push({ label: 'State', value: 'Failed', tone: C.red });
    rows.push({ label: 'Failed after', value: view.meta?.elapsed_ms != null ? `${(view.meta.elapsed_ms / 1000).toFixed(2)} s` : '—' });
    rows.push({ label: 'Rows', value: '0' });
  } else if (view.status === 'cancelled') {
    rows.push({ label: 'State', value: 'Cancelled', tone: C.muted });
  } else if (view.status === 'success' && view.meta) {
    rows.push({ label: 'Duration', value: `${(view.meta.elapsed_ms / 1000).toFixed(2)} s` });
    if (view.meta.bytes_scanned != null) rows.push({ label: 'Bytes scanned', value: view.meta.bytes_scanned_human || `${view.meta.bytes_scanned}` });
    rows.push({
      label: view.meta.returns_rows ? 'Rows' : 'Rows affected',
      value: (view.meta.returns_rows ? (view.rowCount ?? 0) : (view.meta.rows_affected ?? 0)).toLocaleString(),
    });
    if (view.meta.from_cache != null) rows.push({ label: 'Cache', value: view.meta.from_cache ? 'Local hit' : 'Miss', tone: view.meta.from_cache ? C.green : C.ink });
  } else {
    rows.push({ label: 'State', value: 'Nothing run yet', tone: C.faint });
  }
  rows.push({ label: 'Warehouse', value: serverInfo?.warehouse || 'default' });
  rows.push({ label: 'Role', value: serverInfo?.role || 'default' });

  const columns = tab.kind === 'data' ? view.columns : (view.meta?.columns || []);

  return (
    <div className="w-[236px] flex-shrink-0 border-l border-[#dfe3e8] bg-[#fbfcfd] flex flex-col min-h-0">
      <div className="flex-shrink-0 flex items-center h-[38px] px-3 border-b border-[#dfe3e8]">
        <div className="text-[12px] font-medium text-[#1a1d21]">Query profile</div>
        <button onClick={onClose} title="Hide panel" className="ml-auto w-[22px] h-[22px] flex items-center justify-center rounded hover:bg-[#eceff2]">
          <Icon src={closeIcon} className="w-2.5 h-2.5" tint="gray" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {rows.map(r => <ProfileRow key={r.label} {...r} />)}

        {columns.length > 0 && (
          <>
            <div className="mt-4 mb-2 text-[10.5px] font-bold uppercase tracking-[.09em] text-[#8a949e]">
              Columns · {columns.length}
            </div>
            {columns.map(col => (
              <div key={col.name} className="py-1.5 border-t border-[#eceff2]">
                <div className="flex items-center gap-1.5">
                  <TypeMark dataType={col.data_type || col.type} />
                  <span className="text-[12px] truncate">{col.name}</span>
                  {col.is_primary_key && <span className="text-[9px] font-bold text-[#b8730d]">PK</span>}
                </div>
                <div className="pl-[18px] text-[10.5px] text-[#8a949e] truncate">{col.data_type || col.type}</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/* ================================ the page =============================== */

export default function SnowflakePane() {
  const logInPage = useInPageLog();

  /* ---------------------------- connection ---------------------------- */
  const [connState, setConnState] = useState('checking');
  const [connError, setConnError] = useState(null);
  const [serverInfo, setServerInfo] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchJson('/api/snowflake/health')
      .then(data => { if (!cancelled) { setServerInfo(data); setConnState('ready'); } })
      .catch(err => {
        if (cancelled) return;
        if (err.status === 503) { setConnState('unconfigured'); setConnError(err.message); }
        else { setConnState('error'); setConnError(err.message); }
      });
    return () => { cancelled = true; };
  }, []);

  /* ------------------------------ worksheets --------------------------- */
  const [tabs, setTabs] = useState(() => {
    try {
      const stored = JSON.parse(readLocal(LS.tabs, 'null'));
      if (Array.isArray(stored) && stored.length) return stored;
    } catch { /* fall through */ }
    return [newQueryTab(1)];
  });
  const [activeId, setActiveId] = useState(() => readLocal(LS.activeTab, '') || null);
  const active = tabs.find(t => t.id === activeId) || tabs[0];
  const activeIdRef = useRef(active.id);
  useEffect(() => { activeIdRef.current = active.id; }, [active.id]);

  useEffect(() => {
    // Only query drafts are worth persisting; data-editor tabs are cheap to reopen.
    const persisted = tabs.filter(t => t.kind === 'query').map(t => ({ ...t }));
    writeLocal(LS.tabs, JSON.stringify(persisted));
    writeLocal(LS.activeTab, active.id);
  }, [tabs, active.id]);

  const [views, setViews] = useState(() => ({ [active.id]: EMPTY_VIEW }));
  const view = views[active.id] || EMPTY_VIEW;

  const patchView = useCallback((id, patch) => {
    setViews(v => ({ ...v, [id]: { ...(v[id] || EMPTY_VIEW), ...patch } }));
  }, []);
  const patchActive = useCallback((patch) => patchView(activeIdRef.current, patch), [patchView]);

  const setTabSql = (id, sql) => setTabs(ts => ts.map(t => (t.id === id ? { ...t, sql } : t)));
  const queryText = active.sql || '';
  const setQueryText = (sql) => setTabSql(active.id, typeof sql === 'function' ? sql(queryText) : sql);

  const addTab = () => {
    const tab = newQueryTab(tabs.length + 1);
    setTabs(ts => [...ts, tab]);
    setViews(v => ({ ...v, [tab.id]: EMPTY_VIEW }));
    setActiveId(tab.id);
  };

  const addCopierTab = () => {
    const existing = tabs.find(t => t.kind === 'copier');
    if (existing) { setActiveId(existing.id); return; }
    const tab = newCopierTab();
    setTabs(ts => [...ts, tab]);
    setActiveId(tab.id);
  };

  const closeTab = (id) => {
    setTabs(ts => {
      const next = ts.filter(t => t.id !== id);
      const list = next.length ? next : [newQueryTab(1)];
      if (id === activeIdRef.current) setActiveId(list[list.length - 1].id);
      return list;
    });
    setViews(v => { const next = { ...v }; delete next[id]; return next; });
  };

  /* ------------------------------ layout ------------------------------ */
  const [explorerCollapsed, setExplorerCollapsed] = useState(() => readLocal(LS.explorer) === '1');
  const toggleExplorer = () => setExplorerCollapsed(c => {
    const next = !c;
    writeLocal(LS.explorer, next ? '1' : '0');
    return next;
  });

  const [profileOpen, setProfileOpen] = useState(() => readLocal(LS.profile, '1') !== '0');
  const toggleProfile = () => setProfileOpen(p => {
    writeLocal(LS.profile, p ? '0' : '1');
    return !p;
  });

  const [editorTheme, setEditorTheme] = useState(() => (readLocal(LS.theme) === 'dark' ? 'dark' : 'light'));
  const toggleEditorTheme = () => setEditorTheme(t => {
    const next = t === 'dark' ? 'light' : 'dark';
    writeLocal(LS.theme, next);
    logInPage('sf_editor_theme', `Switched the query editor to ${next} mode`);
    return next;
  });

  const [editorHeight, setEditorHeight] = useState(180);
  const startEditorResize = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorHeight;
    const onMove = (ev) => setEditorHeight(Math.max(84, Math.min(560, startH + (ev.clientY - startY))));
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const resultsPaneRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else resultsPaneRef.current?.requestFullscreen?.();
  };

  /* ------------------------------ editor ------------------------------ */
  const editorRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [editorScroll, setEditorScroll] = useState({ top: 0, left: 0 });

  const copyQueryText = async () => {
    if (!queryText.trim()) return;
    try {
      await navigator.clipboard.writeText(queryText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const [sqlSuggest, setSqlSuggest] = useState(null);
  const objectCacheRef = useRef({});
  const updateSuggestRef = useRef(() => {});

  const defaultDb = serverInfo?.default_database || null;
  const defaultSchema = serverInfo?.default_schema || null;

  const refKey = useCallback((ref) => {
    const parts = ref.parts;
    if (parts.length >= 3) return parts.slice(-3);
    if (parts.length === 2) return defaultDb ? [defaultDb, parts[0], parts[1]] : null;
    return defaultDb && defaultSchema ? [defaultDb, defaultSchema, parts[0]] : null;
  }, [defaultDb, defaultSchema]);

  const ensureObjects = useCallback((context) => {
    const cache = objectCacheRef.current;
    const key = context.join('.');
    if (cache[key] !== undefined) return;
    cache[key] = 'loading';
    const settle = (items) => { cache[key] = items; updateSuggestRef.current(editorRef.current); };
    const enc = encodeURIComponent;
    if (context.length === 0) {
      fetchJson('/api/snowflake/databases')
        .then(data => settle((data.databases || []).map(d => ({ text: d, kind: 'database' }))))
        .catch(() => settle([]));
    } else if (context.length === 1) {
      fetchJson(`/api/snowflake/schemas?database=${enc(context[0])}`)
        .then(data => settle((data.schemas || []).map(sc => ({ text: sc, kind: 'schema' }))))
        .catch(() => settle([]));
    } else if (context.length === 2) {
      fetchJson(`/api/snowflake/tables?database=${enc(context[0])}&schema=${enc(context[1])}`)
        .then(data => settle((data.tables || []).map(t => ({
          text: t.name,
          kind: t.kind === 'table' ? 'table' : 'view',
          detail: t.kind === 'table' ? 'table' : 'view',
        }))))
        .catch(() => settle([]));
    } else if (context.length === 3) {
      fetchJson(`/api/snowflake/columns?database=${enc(context[0])}&schema=${enc(context[1])}&table=${enc(context[2])}`)
        .then(data => settle((data.columns || []).map(c => ({
          text: c.name, kind: 'column', detail: c.data_type, pk: c.is_primary_key,
        }))))
        .catch(() => settle([]));
    } else {
      settle([]);
    }
  }, []);

  const columnsInScope = useCallback((refs) => {
    const out = [];
    refs.forEach(ref => {
      const parts = refKey(ref);
      if (!parts) return;
      const cached = objectCacheRef.current[parts.join('.')];
      if (cached === undefined) { ensureObjects(parts); return; }
      if (cached === 'loading' || !Array.isArray(cached)) return;
      cached.forEach(col => out.push({ ...col, source: ref.alias || ref.table }));
    });
    return out;
  }, [ensureObjects, refKey]);

  const updateSqlSuggest = useCallback((ta) => {
    if (!ta) { setSqlSuggest(null); return; }
    const caret = ta.selectionStart;
    if (caret !== ta.selectionEnd) { setSqlSuggest(null); return; }
    const { word, context } = sqlTokenAtCaret(ta.value, caret);
    const refs = parseTableRefs(ta.value);
    const clause = clauseAtCaret(ta.value, caret);
    let items;

    if (context.length > 0 && context.length <= 3) {
      let lookup = context;
      if (context.length === 1) {
        const ref = resolveRef(refs, context[0]);
        const resolved = ref && refKey(ref);
        if (resolved) lookup = resolved;
      }
      const objects = objectCacheRef.current[lookup.join('.')];
      if (objects === undefined || objects === 'loading') {
        ensureObjects(lookup);
        setSqlSuggest(null);
        return;
      }
      items = rankSuggestions(objects, word, clause).slice(0, 14);
    } else {
      if (word.length < 2) { setSqlSuggest(null); return; }
      const databases = Array.isArray(objectCacheRef.current['']) ? objectCacheRef.current[''] : [];
      const pool = [...columnsInScope(refs), ...STATIC_SUGGESTIONS, ...databases];
      items = rankSuggestions(pool, word, clause).slice(0, 12);
    }

    if (!items || items.length === 0) { setSqlSuggest(null); return; }
    const pos = caretPixelPos(ta, caret);
    setSqlSuggest({
      items,
      index: 0,
      left: ta.offsetLeft + pos.left,
      top: ta.offsetTop + pos.top,
      lineHeight: pos.lineHeight,
      boxHeight: ta.offsetTop + ta.clientHeight,
    });
  }, [ensureObjects, columnsInScope, refKey]);

  useEffect(() => { updateSuggestRef.current = updateSqlSuggest; }, [updateSqlSuggest]);

  const acceptSuggestion = (item) => {
    const ta = editorRef.current;
    if (!ta || !item) return;
    const caret = ta.selectionStart;
    const { start } = sqlTokenAtCaret(ta.value, caret);
    const chains = ['database', 'schema', 'table', 'view'].includes(item.kind);
    const suffix = chains ? '.' : (item.kind === 'function' || /[ (]$/.test(item.text) ? '' : ' ');
    const insert = item.text + suffix;
    const next = ta.value.slice(0, start) + insert + ta.value.slice(caret);
    setQueryText(next);
    setSqlSuggest(null);
    requestAnimationFrame(() => {
      ta.focus();
      const p = start + insert.length;
      ta.setSelectionRange(p, p);
      if (chains) updateSuggestRef.current(ta);
    });
  };

  const insertIntoEditor = (text) => {
    const ta = editorRef.current;
    if (!ta) { setQueryText(q => (q ? `${q} ` : '') + text); return; }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const next = ta.value.slice(0, start) + text + ta.value.slice(end);
    setQueryText(next);
    requestAnimationFrame(() => {
      ta.focus();
      const p = start + text.length;
      ta.setSelectionRange(p, p);
    });
  };

  /* ---------------------------- paging config -------------------------- */
  const [pageSize, setPageSize] = useState(() => {
    const stored = parseInt(readLocal(LS.pageSize, ''), 10);
    return PAGE_SIZE_OPTIONS.includes(stored) ? stored : 100;
  });
  const [cellDetail, setCellDetail] = useState(null);

  /* --------------------------- history / saved ------------------------ */
  const [panel, setPanel] = useState(null); // history | saved | null
  const [history, setHistory] = useState([]);
  const [saved, setSaved] = useState([]);
  const [savePromptOpen, setSavePromptOpen] = useState(false);

  const loadHistory = useCallback(() => {
    fetchJson('/api/snowflake/history?limit=50')
      .then(data => setHistory(data.history || []))
      .catch(() => { /* the panel just stays empty */ });
  }, []);

  const loadSaved = useCallback(() => {
    fetchJson('/api/snowflake/saved')
      .then(data => setSaved(data.saved || []))
      .catch(() => { /* the panel just stays empty */ });
  }, []);

  useEffect(() => {
    if (connState !== 'ready') return;
    loadHistory();
    loadSaved();
  }, [connState, loadHistory, loadSaved]);

  /* ------------------------------- jobs -------------------------------- */
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savePreview, setSavePreview] = useState(null);
  const [textModal, setTextModal] = useState(null);

  const pollRef = useRef({});
  const runSeqRef = useRef({});
  const stopPolling = (id) => {
    if (pollRef.current[id]) { clearTimeout(pollRef.current[id]); delete pollRef.current[id]; }
  };
  useEffect(() => () => Object.keys(pollRef.current).forEach(stopPolling), []);

  const fetchPage = useCallback(async (tabId, jid, pageNum, size, sortVal, filterVal, seq) => {
    patchView(tabId, { loading: true });
    try {
      const data = await fetchJson(`/api/snowflake/query/${jid}/rows`, {
        method: 'POST',
        body: { page: pageNum, page_size: size, sort: sortVal, filters: filterVal },
      });
      if (seq !== undefined && seq !== runSeqRef.current[tabId]) return;
      patchView(tabId, {
        rows: data.rows || [],
        page: data.page,
        rowCount: data.total_rows,
        totalPages: data.total_pages || 1,
        loading: false,
      });
    } catch (err) {
      if (seq !== undefined && seq !== runSeqRef.current[tabId]) return;
      patchView(tabId, { error: err.message || 'Failed to fetch rows', loading: false });
    }
  }, [patchView]);

  const applyFinished = useCallback((tabId, jid, data, seq, firstPage) => {
    const patch = { meta: data, rowCount: data.row_count };
    if (data.status === 'success') {
      patch.status = 'success';
      if (data.returns_rows && firstPage) {
        patch.rows = firstPage.rows || [];
        patch.page = firstPage.page || 1;
        patch.rowCount = firstPage.total_rows;
        patch.totalPages = firstPage.total_pages || 1;
      }
    } else if (data.status === 'failed') {
      patch.status = 'failed';
      patch.error = data.error || 'Query failed';
    } else {
      patch.status = data.status;
    }
    patchView(tabId, patch);
    if (data.status === 'success' && data.returns_rows && !firstPage) {
      fetchPage(tabId, jid, 1, pageSize, [], [], seq);
    }
    loadHistory();
  }, [fetchPage, pageSize, loadHistory, patchView]);

  const pollStatus = useCallback((tabId, jid, seq) => {
    pollRef.current[tabId] = setTimeout(async () => {
      try {
        const data = await fetchJson(`/api/snowflake/query/${jid}/status?wait_ms=10000`);
        if (seq !== runSeqRef.current[tabId]) return;
        if (data.status === 'running') { pollStatus(tabId, jid, seq); return; }
        applyFinished(tabId, jid, data, seq);
      } catch (err) {
        if (seq !== runSeqRef.current[tabId]) return;
        patchView(tabId, { status: 'failed', error: err.message || 'Lost connection while checking the query status' });
      }
    }, 0);
  }, [applyFinished, patchView]);

  const submitQuery = async (tabId, sql, confirm) => {
    const seq = runSeqRef.current[tabId];
    try {
      const data = await fetchJson('/api/snowflake/query', {
        method: 'POST',
        body: { sql, confirm, wait_ms: 2500, page_size: pageSize },
      });
      if (seq !== runSeqRef.current[tabId]) return;
      logInPage('sf_query_run', `Ran Snowflake query${confirm ? ' (confirmed destructive)' : ''}: ${sql.slice(0, 300)}`);
      patchView(tabId, { jobId: data.job_id });
      if (data.status && data.status !== 'running') {
        applyFinished(tabId, data.job_id, data, seq, data.first_page);
        return;
      }
      patchView(tabId, { status: 'running' });
      pollStatus(tabId, data.job_id, seq);
    } catch (err) {
      if (seq !== runSeqRef.current[tabId]) return;
      if (err.status === 409 && err.body?.detail?.requires_confirmation) {
        setPendingConfirm({ ...err.body.detail, sql, tabId });
        patchView(tabId, { status: 'idle' });
      } else {
        patchView(tabId, { status: 'failed', error: err.message || 'Failed to start the query' });
      }
    } finally {
      setConfirming(false);
    }
  };

  // Ctrl/⌘+Enter with a selection runs just the selection, as every SQL client does.
  const currentStatement = () => {
    const ta = editorRef.current;
    if (ta && ta.selectionStart !== ta.selectionEnd) {
      return ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
    }
    return queryText.trim();
  };

  const resetRunState = (tabId, previousJobId) => {
    stopPolling(tabId);
    // Hand the previous job's Snowflake session straight back to the pool.
    if (previousJobId) {
      apiFetch(`/api/snowflake/query/${previousJobId}`, { method: 'DELETE' }).catch(() => {});
    }
    patchView(tabId, { ...EMPTY_VIEW, status: 'starting' });
  };

  const runQuery = () => {
    const sql = currentStatement();
    if (!sql || view.status === 'running' || view.status === 'starting') return;
    const tabId = active.id;
    runSeqRef.current[tabId] = (runSeqRef.current[tabId] || 0) + 1;
    resetRunState(tabId, view.jobId);
    submitQuery(tabId, sql, false);
  };

  const cancelQuery = async () => {
    if (!view.jobId) return;
    stopPolling(active.id);
    logInPage('sf_query_cancel', `Cancelled a running Snowflake query (job ${view.jobId})`);
    try { await apiFetch(`/api/snowflake/query/${view.jobId}/cancel`, { method: 'POST' }); } catch { /* best effort */ }
    patchActive({ status: 'cancelled' });
  };

  /* --------------------------- data editor tabs ------------------------ */
  const loadTablePage = useCallback(async (tabId, target, pageNum, size, sortVal, filterVal) => {
    patchView(tabId, { loading: true, error: null });
    try {
      const data = await fetchJson('/api/snowflake/table/rows', {
        method: 'POST',
        body: {
          database: target.database,
          schema: target.schema,
          table: target.table,
          page: pageNum,
          page_size: size,
          sort: sortVal,
          filters: filterVal,
        },
      });
      patchView(tabId, {
        columns: data.columns || [],
        rows: data.rows || [],
        tableMeta: { primary_key: data.primary_key || [], editable: data.editable },
        keyColumns: (data.primary_key || []),
        page: data.page,
        rowCount: data.total_rows,
        totalPages: data.total_pages || 1,
        loading: false,
        status: 'success',
      });
    } catch (err) {
      patchView(tabId, { error: err.message || 'Failed to read the table', loading: false, status: 'failed' });
    }
  }, [patchView]);

  const openDataEditor = (database, schema, tableName) => {
    const existing = tabs.find(t => t.kind === 'data'
      && t.table.database === database && t.table.schema === schema && t.table.table === tableName);
    const tab = existing || {
      id: `d${Date.now()}`,
      kind: 'data',
      name: tableName,
      table: { database, schema, table: tableName },
    };
    if (!existing) setTabs(ts => [...ts, tab]);
    setViews(v => ({ ...v, [tab.id]: EMPTY_VIEW }));
    setActiveId(tab.id);
    logInPage('sf_data_editor_open', `Opened the data editor for ${database}.${schema}.${tableName}`);
    loadTablePage(tab.id, tab.table, 1, pageSize, [], []);
  };

  const dirtyCount = useMemo(
    () => Object.keys(view.edits || {}).length + (view.deleted || []).length + (view.newRows || []).length,
    [view.edits, view.deleted, view.newRows],
  );

  const columnMetaByName = useMemo(() => {
    const map = {};
    (view.columns || []).forEach(c => { map[c.name] = c; });
    return map;
  }, [view.columns]);

  const clearPendingEdits = () => patchActive({ edits: {}, deleted: [], newRows: [] });

  const editCell = (rowIndex, col, value) => {
    const colIndex = (view.columns || []).findIndex(c => c.name === col);
    const originalRaw = view.rows[rowIndex]?.[colIndex];
    const original = originalRaw === null || originalRaw === undefined ? '' : cellText(originalRaw);
    const rowEdits = { ...(view.edits[rowIndex] || {}) };
    if (value === original) delete rowEdits[col];
    else rowEdits[col] = value;
    const nextEdits = { ...view.edits };
    if (Object.keys(rowEdits).length === 0) delete nextEdits[rowIndex];
    else nextEdits[rowIndex] = rowEdits;
    patchActive({ edits: nextEdits });
  };

  const toggleDelete = (rowIndex) => {
    const set = new Set(view.deleted);
    if (set.has(rowIndex)) set.delete(rowIndex);
    else set.add(rowIndex);
    patchActive({ deleted: [...set] });
  };

  const editNewCell = (i, col, value) => {
    patchActive({ newRows: view.newRows.map((row, idx) => (idx === i ? { ...row, [col]: value } : row)) });
  };

  const buildChanges = () => {
    const changes = [];
    const originalOf = (rowIndex) => {
      const row = view.rows[rowIndex];
      const obj = {};
      view.columns.forEach((c, i) => { obj[c.name] = row[i]; });
      return obj;
    };
    const deletedSet = new Set(view.deleted);
    Object.entries(view.edits).forEach(([rowIndex, rowEdits]) => {
      const idx = Number(rowIndex);
      if (deletedSet.has(idx)) return; // a delete supersedes its own edits
      const values = {};
      Object.entries(rowEdits).forEach(([col, value]) => { values[col] = value === '' ? null : value; });
      changes.push({ kind: 'update', original: originalOf(idx), values });
    });
    deletedSet.forEach(idx => changes.push({ kind: 'delete', original: originalOf(idx) }));
    view.newRows.forEach(draft => {
      const values = {};
      Object.entries(draft).forEach(([col, value]) => { if (value !== '' && value !== undefined) values[col] = value; });
      if (Object.keys(values).length) changes.push({ kind: 'insert', values });
    });
    return changes;
  };

  const previewSave = async () => {
    const changes = buildChanges();
    if (!changes.length) return;
    setSaving(true);
    patchActive({ error: null });
    try {
      const data = await fetchJson('/api/snowflake/table/mutate', {
        method: 'POST',
        body: {
          database: active.table.database,
          schema: active.table.schema,
          table: active.table.table,
          changes,
          key_columns: view.keyColumns.length ? view.keyColumns : null,
        },
      });
      setSavePreview({ ...data, changes, tabId: active.id });
    } catch (err) {
      patchActive({ error: err.message || 'Could not prepare the changes' });
    } finally {
      setSaving(false);
    }
  };

  const applySave = async () => {
    if (!savePreview) return;
    setSaving(true);
    try {
      const data = await fetchJson('/api/snowflake/table/mutate', {
        method: 'POST',
        body: {
          database: active.table.database,
          schema: active.table.schema,
          table: active.table.table,
          changes: savePreview.changes,
          key_columns: view.keyColumns.length ? view.keyColumns : null,
          confirm: true,
        },
      });
      logInPage('sf_data_editor_save',
        `Applied ${data.summary} to ${active.table.database}.${active.table.schema}.${active.table.table}`);
      setSavePreview(null);
      patchActive({ edits: {}, deleted: [], newRows: [], notice: `Applied ${data.summary}.` });
      setTimeout(() => patchView(active.id, { notice: null }), 6000);
      loadTablePage(active.id, active.table, view.page, pageSize, view.sort, view.filters);
    } catch (err) {
      setSavePreview(null);
      patchActive({ error: err.message || 'Changes were not applied' });
    } finally {
      setSaving(false);
    }
  };

  /* --------------------------- grid interactions ----------------------- */
  const reload = (patch) => {
    const next = { ...view, ...patch };
    if (active.kind === 'data') {
      loadTablePage(active.id, active.table, patch.page ?? 1, patch.pageSize ?? pageSize, next.sort, next.filters);
    } else if (view.jobId && view.meta) {
      fetchPage(active.id, view.jobId, patch.page ?? 1, patch.pageSize ?? pageSize, next.sort, next.filters, runSeqRef.current[active.id]);
    }
  };

  const handleSort = (col, additive) => {
    const existing = view.sort.find(s => s.col === col);
    const flipped = existing && existing.dir === 'asc' ? 'desc' : 'asc';
    let next;
    if (!additive) next = [{ col, dir: existing ? flipped : 'asc' }];
    else if (existing) next = view.sort.map(s => (s.col === col ? { col, dir: flipped } : s));
    else next = [...view.sort, { col, dir: 'asc' }];
    patchActive({ sort: next });
    reload({ sort: next, page: 1 });
  };

  const handleFilter = (f) => {
    const without = view.filters.filter(x => x.col !== f.col);
    const next = f.op ? [...without, f] : without;
    patchActive({ filters: next });
    reload({ filters: next, page: 1 });
  };

  const clearFilters = () => {
    patchActive({ filters: [] });
    reload({ filters: [], page: 1 });
  };

  const goToPage = (n) => {
    const clamped = Math.max(1, Math.min(view.totalPages || 1, n));
    if (clamped === view.page && !view.loading) return;
    reload({ page: clamped });
  };

  const changePageSize = (n) => {
    setPageSize(n);
    writeLocal(LS.pageSize, String(n));
    reload({ page: 1, pageSize: n });
  };

  const setWidths = (updater) => {
    const next = typeof updater === 'function' ? updater(view.widths) : updater;
    patchActive({ widths: next });
  };

  /* ------------------------------ exports ------------------------------ */
  const [exportOpen, setExportOpen] = useState(false);
  useEffect(() => {
    if (!exportOpen) return undefined;
    const close = () => setExportOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [exportOpen]);

  const downloadResults = (fmt) => {
    if (!view.jobId) return;
    const params = new URLSearchParams({ fmt });
    if (view.sort.length) params.set('sort_json', JSON.stringify(view.sort));
    if (view.filters.length) params.set('filters_json', JSON.stringify(view.filters));
    logInPage('sf_query_download', `Downloaded the full Snowflake result set (job ${view.jobId}) as ${fmt.toUpperCase()}`);
    downloadFile(`/api/snowflake/query/${view.jobId}/download?${params}`, `snowflake_results.${fmt}`)
      .catch(err => patchActive({ error: err.message || 'Download failed' }));
  };

  /* ------------------------ saved / history actions -------------------- */
  const saveCurrentQuery = async (name, shared) => {
    try {
      await fetchJson('/api/snowflake/saved', { method: 'POST', body: { name, sql: queryText, shared } });
      setSavePromptOpen(false);
      loadSaved();
      setPanel('saved');
      logInPage('sf_query_saved', `Saved the query "${name}"`);
    } catch (err) {
      patchActive({ error: err.message || 'Could not save the query' });
      setSavePromptOpen(false);
    }
  };

  const deleteSaved = async (id) => {
    try { await fetchJson(`/api/snowflake/saved/${id}`, { method: 'DELETE' }); loadSaved(); }
    catch (err) { patchActive({ error: err.message || 'Could not delete the saved query' }); }
  };

  const clearHistory = async () => {
    try { await fetchJson('/api/snowflake/history', { method: 'DELETE' }); setHistory([]); }
    catch (err) { patchActive({ error: err.message || 'Could not clear the history' }); }
  };

  const openInNewTab = (sql, name) => {
    const tab = { ...newQueryTab(tabs.length + 1), sql, name: name || `Worksheet ${tabs.length + 1}` };
    setTabs(ts => [...ts, tab]);
    setViews(v => ({ ...v, [tab.id]: EMPTY_VIEW }));
    setActiveId(tab.id);
  };

  /* --------------------------- explorer actions ------------------------ */
  const previewTable = (database, schema, tableName) => {
    const sql = `SELECT *\nFROM "${database}"."${schema}"."${tableName}"\nLIMIT 100`;
    const tabId = active.kind === 'query' ? active.id : null;
    if (tabId) {
      setTabSql(tabId, sql);
      runSeqRef.current[tabId] = (runSeqRef.current[tabId] || 0) + 1;
      resetRunState(tabId, view.jobId);
      submitQuery(tabId, sql, false);
    } else {
      openInNewTab(sql, tableName);
    }
  };

  const showDdl = async (database, schema, name, kind) => {
    try {
      const data = await fetchJson(
        `/api/snowflake/ddl?database=${encodeURIComponent(database)}&schema=${encodeURIComponent(schema)}&name=${encodeURIComponent(name)}&kind=${kind}`,
      );
      setTextModal({ title: `${database}.${schema}.${name}`, body: data.ddl || '(no DDL returned)' });
    } catch (err) {
      patchActive({ error: err.message || 'Could not read the DDL' });
    }
  };

  /* ------------------------------- render ------------------------------ */
  const leadHint = leadKeywordHint(queryText);
  const isData = active.kind === 'data';
  const isCopier = active.kind === 'copier';
  const gridColumns = isData
    ? (view.columns || []).map(c => ({ name: c.name, type: c.data_type }))
    : (view.meta?.columns || []);
  const canEdit = isData && view.tableMeta?.editable && (serverInfo?.allow_writes !== false);
  const busy = view.status === 'running' || view.status === 'starting';
  const hasGrid = isData ? (view.columns || []).length > 0 : (view.status === 'success' && view.meta?.returns_rows);

  const resultMeta = (() => {
    if (busy) return `Running in ${serverInfo?.warehouse || 'Snowflake'}…`;
    if (isData) return `${(view.rowCount ?? 0).toLocaleString()} rows · ${(view.columns || []).length} columns · editable`;
    if (view.status === 'failed') return 'Failed';
    if (view.status === 'cancelled') return 'Cancelled';
    if (view.status === 'success' && view.meta) {
      return view.meta.returns_rows
        ? `${(view.rowCount ?? 0).toLocaleString()} rows · ${(view.meta.elapsed_ms / 1000).toFixed(2)} s`
        : `${(view.meta.rows_affected ?? 0).toLocaleString()} rows affected · ${(view.meta.elapsed_ms / 1000).toFixed(2)} s`;
    }
    return 'Nothing run yet';
  })();

  if (connState === 'checking') {
    return <div className="flex-1 min-w-0 flex items-center justify-center p-10"><LoadingSpinner /></div>;
  }

  if (connState === 'unconfigured') {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center p-10">
        <div className="max-w-md text-center">
          <IconDefs />
          <Icon src={sfIcon} className="w-6 h-6 mx-auto mb-2" tint={null} />
          <div className="text-[13px] font-johnson-text text-[#5c6670]">
            Snowflake isn&apos;t configured for Data Studio yet. Add a{' '}
            <code className="text-[11.5px] bg-[#f5f7f9] px-1 py-0.5 rounded">snowflake_query_runner</code>{' '}
            section to the backend config to switch it on.
          </div>
          {connError && <div className="mt-2 text-[11.5px] text-[#8a949e]">{connError}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex overflow-hidden bg-white text-[#1a1d21] font-johnson-text">
      <IconDefs />

      {/* ------------------------------ explorer ------------------------------ */}
      {explorerCollapsed ? (
        <div className="w-[38px] flex-shrink-0 border-r border-[#dfe3e8] bg-[#fbfcfd] flex flex-col items-center pt-2.5 gap-3">
          <button onClick={toggleExplorer} title="Show database objects" className="p-1.5 rounded hover:bg-[#eceff2]">
            <Icon src={chevronRightIcon} className="w-3 h-3" tint="gray" />
          </button>
          <Icon src={sfIcon} className="w-4 h-4" tint={null} />
        </div>
      ) : (
        <div className="w-[250px] flex-shrink-0 border-r border-[#dfe3e8] bg-white">
          <ExplorerTree
            onInsert={insertIntoEditor}
            onPreview={previewTable}
            onEditData={openDataEditor}
            onShowDdl={showDdl}
            onCollapse={toggleExplorer}
            logInPage={logInPage}
          />
        </div>
      )}

      {/* ------------------------------ worksheet ----------------------------- */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">

        {/* worksheet bar */}
        <div className="flex-shrink-0 flex items-center gap-3 h-[48px] px-3.5 border-b border-[#dfe3e8]">
          <div className="flex-1 min-w-0 flex items-center gap-2 overflow-hidden">
            <Icon src={sfIcon} className="w-4 h-4 flex-shrink-0" tint={null} />
            <span className="min-w-0 truncate text-[14px] font-medium tracking-[-.01em]">
              {isData ? `${active.table.database}.${active.table.schema}.${active.table.table}` : active.name}
            </span>
            {isData && dirtyCount > 0 && (
              <span className="flex-shrink-0 text-[11px] text-[#b8730d] bg-[#fdf3e3] rounded px-2 py-0.5">
                {dirtyCount} staged
              </span>
            )}
          </div>

          <div className="flex-shrink-0 flex items-center gap-2">
            {serverInfo && (
              <div
                className="hidden md:flex items-center gap-2 h-[30px] px-2.5 border border-[#dfe3e8] rounded text-[12px] text-[#1a1d21]"
                title={`${serverInfo.account} · ${serverInfo.role || 'default role'} · ${serverInfo.warehouse || 'default warehouse'}`}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: connState === 'error' ? C.red : C.green }} />
                <span className="truncate max-w-[130px]">{serverInfo.role || 'default role'}</span>
                <span className="text-[#8a949e]">·</span>
                <span className="truncate max-w-[110px]">{serverInfo.warehouse || 'default wh'}</span>
                {serverInfo.allow_writes === false && <span className="text-[#b8730d]">· read-only</span>}
              </div>
            )}
            <button
              onClick={() => { setPanel(p => (p === 'history' ? null : 'history')); loadHistory(); }}
              className={`h-[30px] px-3 rounded border text-[12px] ${panel === 'history' ? 'border-[#11567f] text-[#11567f] bg-[#e3f2fa]' : 'border-[#dfe3e8] hover:bg-[#f5f7f9]'}`}
            >
              History
            </button>
            <button
              onClick={() => { setPanel(p => (p === 'saved' ? null : 'saved')); loadSaved(); }}
              className={`h-[30px] px-3 rounded border text-[12px] ${panel === 'saved' ? 'border-[#11567f] text-[#11567f] bg-[#e3f2fa]' : 'border-[#dfe3e8] hover:bg-[#f5f7f9]'}`}
            >
              Saved
            </button>
            {!isData && !isCopier && (
              <button
                onClick={busy ? cancelQuery : runQuery}
                disabled={!busy && !queryText.trim()}
                className={`flex items-center gap-2 h-[30px] px-4 rounded text-white text-[12.5px] font-medium disabled:opacity-50 ${
                  busy ? 'bg-[#5c6670] hover:bg-[#4a5560]' : leadHint ? 'bg-[#9e0000] hover:opacity-90' : 'bg-[#11567f] hover:bg-[#0d4363]'
                }`}
                title="⌘/Ctrl + Enter runs the selection, or the whole worksheet"
              >
                {!busy && <Icon src={playIcon} className="w-2.5 h-2.5" tint="white" />}
                {busy ? 'Cancel' : leadHint ? `Run ${leadHint}` : 'Run'}
              </button>
            )}
            {isData && dirtyCount > 0 && (
              <button
                onClick={previewSave}
                disabled={saving}
                className="flex items-center gap-2 h-[30px] px-4 rounded bg-[#9e0000] text-white text-[12.5px] font-medium hover:opacity-90 disabled:opacity-50"
              >
                <Icon src={saveIcon} className="w-3 h-3" tint="white" />
                {saving ? 'Working…' : `Review ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        </div>

        {/* worksheet tabs */}
        <div className="flex-shrink-0 flex items-stretch h-[34px] px-1.5 bg-[#f5f7f9] border-b border-[#dfe3e8] overflow-x-auto">
          {tabs.map(tab => {
            const isActive = tab.id === active.id;
            const tabView = views[tab.id] || EMPTY_VIEW;
            const dot = tabView.status === 'failed' ? C.red
              : tabView.status === 'success' ? C.green
                : tabView.status === 'running' || tabView.status === 'starting' ? C.accent : C.faint;
            return (
              <div
                key={tab.id}
                className="group flex items-center gap-2 px-3 max-w-[230px] cursor-pointer"
                style={{ background: isActive ? '#ffffff' : 'transparent', boxShadow: isActive ? `inset 0 -2px 0 ${C.accent}` : 'none' }}
                onClick={() => setActiveId(tab.id)}
              >
                {tab.kind === 'data'
                  ? <span className="flex-shrink-0 text-[10px] font-bold text-[#b8730d]">EDIT</span>
                  : tab.kind === 'copier'
                    ? <span className="flex-shrink-0 text-[10px] font-bold text-[#11567f]">COPY</span>
                    : <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: dot }} />}
                <span className="truncate text-[12.5px]">{tab.name}</span>
                <button
                  onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                  title="Close worksheet"
                  className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-0.5 rounded hover:bg-[#eceff2]"
                >
                  <Icon src={closeIcon} className="w-2.5 h-2.5" tint="gray" />
                </button>
              </div>
            );
          })}
          <button onClick={addTab} title="New worksheet" className="w-[30px] flex items-center justify-center hover:bg-[#eceff2]">
            <Icon src={addIcon} className="w-3 h-3" tint="gray" />
          </button>
          <button
            onClick={addCopierTab}
            title="Copy a table or schema"
            className="flex-shrink-0 flex items-center gap-1.5 px-2.5 ml-1 text-[11.5px] text-[#5c6670] hover:bg-[#eceff2] rounded"
          >
            <CopyIcon className="w-2.5 h-2.5" />
            Copy tables
          </button>
        </div>

        {connState === 'error' && (
          <div className="flex-shrink-0 flex items-start gap-2 px-3.5 py-2 bg-[#fcf1f1] border-b border-[#f0d2d2] text-[12px] text-[#c02b2b]">
            <Icon src={alertIcon} className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            {connError || 'Could not reach the Data Studio Snowflake API.'}
          </div>
        )}

        {/* copier worksheets take over the whole body below the tabs */}
        {isCopier && (
          <div className="flex-1 min-h-0">
            <TableCopier serverInfo={serverInfo} />
          </div>
        )}

        {/* editor (query worksheets only) */}
        {!isCopier && !isData && (
          <>
            <div className="flex-shrink-0 flex bg-white border-b border-[#dfe3e8] overflow-hidden" style={{ height: editorHeight }}>
              <LineGutter text={queryText} height={editorHeight} />
              <div className="relative flex-1 min-w-0">
                <HighlightLayer
                  text={queryText}
                  theme={editorTheme}
                  scrollTop={editorScroll.top}
                  scrollLeft={editorScroll.left}
                />
                <textarea
                  ref={editorRef}
                  value={queryText}
                  onChange={e => { setQueryText(e.target.value); updateSqlSuggest(e.target); }}
                  onFocus={() => ensureObjects([])}
                  onClick={() => setSqlSuggest(null)}
                  onBlur={() => setTimeout(() => setSqlSuggest(null), 150)}
                  onScroll={e => {
                    setSqlSuggest(null);
                    setEditorScroll({ top: e.target.scrollTop, left: e.target.scrollLeft });
                  }}
                  onKeyDown={e => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                      e.preventDefault();
                      setSqlSuggest(null);
                      runQuery();
                      return;
                    }
                    if (sqlSuggest) {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setSqlSuggest(s => ({ ...s, index: (s.index + 1) % s.items.length })); }
                      else if (e.key === 'ArrowUp') { e.preventDefault(); setSqlSuggest(s => ({ ...s, index: (s.index - 1 + s.items.length) % s.items.length })); }
                      else if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); acceptSuggestion(sqlSuggest.items[sqlSuggest.index]); }
                      else if (e.key === 'Escape') { e.preventDefault(); setSqlSuggest(null); }
                    }
                  }}
                  spellCheck={false}
                  placeholder={'SELECT *\nFROM "MY_DB"."PUBLIC"."MY_TABLE"\nLIMIT 100'}
                  className="relative z-[1] w-full h-full px-4 py-3 bg-transparent text-transparent caret-[#11567f] text-[12.5px] font-mono leading-[1.7] resize-none focus:outline-none placeholder-[#8a949e] selection:bg-[#29b5e8]/25"
                />
                {sqlSuggest && (
                  <div
                    className="absolute z-20 min-w-[220px] max-w-[520px] w-max max-h-[188px] overflow-y-auto rounded-md shadow-lg border border-[#dfe3e8] bg-white text-[12px] font-mono"
                    style={{
                      left: Math.max(0, Math.min(sqlSuggest.left, (editorRef.current?.clientWidth || 800) - 240)),
                      ...(sqlSuggest.boxHeight - sqlSuggest.top < 140
                        ? { bottom: `calc(100% - ${sqlSuggest.top - sqlSuggest.lineHeight}px)` }
                        : { top: sqlSuggest.top + 2 }),
                    }}
                  >
                    {sqlSuggest.items.map((item, i) => {
                      const isActive = i === sqlSuggest.index;
                      const badge = { column: 'C', function: 'f', schema: 'S', database: 'D', view: 'V', table: 'T' }[item.kind] || 'K';
                      const badgeColor = {
                        column: C.green, function: C.violet, schema: C.violet,
                        database: C.primary, table: C.accent, view: C.green,
                      }[item.kind] || C.primary;
                      return (
                        <div
                          key={`${item.kind}-${item.source || ''}-${item.text}`}
                          onMouseDown={e => { e.preventDefault(); acceptSuggestion(item); }}
                          onMouseEnter={() => setSqlSuggest(sg => ({ ...sg, index: i }))}
                          className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer ${isActive ? 'bg-[#e3f2fa] text-[#1a1d21]' : 'text-[#5c6670]'}`}
                        >
                          <span className="w-[13px] text-center text-[9px] font-bold flex-shrink-0" style={{ color: badgeColor }}>{badge}</span>
                          <span className="whitespace-nowrap">{item.text}</span>
                          {item.pk && <span className="flex-shrink-0 text-[8.5px] font-bold text-[#b8730d]">PK</span>}
                          {(item.detail || item.source) && (
                            <span className="ml-auto pl-3 flex-shrink-0 text-[9.5px] whitespace-nowrap text-[#8a949e]">
                              {item.source ? `${item.source}${item.detail ? ` · ${item.detail}` : ''}` : item.detail}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* editor toolbar + splitter */}
            <div className="flex-shrink-0 flex items-center gap-2 h-[30px] px-3.5 bg-[#fbfcfd] border-b border-[#dfe3e8]">
              <span className="text-[11px] text-[#8a949e] truncate">
                One statement per run · destructive statements ask first · ⌘/Ctrl+Enter runs · Tab accepts a suggestion
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <button onClick={copyQueryText} className="flex items-center gap-1.5 h-[22px] px-2 rounded border border-[#dfe3e8] text-[11px] hover:bg-[#f5f7f9]">
                  <CopyIcon />{copied ? 'Copied' : 'Copy'}
                </button>
                <button onClick={() => setSavePromptOpen(true)} disabled={!queryText.trim()} className="h-[22px] px-2 rounded border border-[#dfe3e8] text-[11px] hover:bg-[#f5f7f9] disabled:opacity-40">
                  Save
                </button>
                <button onClick={toggleEditorTheme} className="h-[22px] px-2 rounded border border-[#dfe3e8] text-[11px] hover:bg-[#f5f7f9]">
                  {editorTheme === 'dark' ? '☀ Light' : '☾ Dark'}
                </button>
              </div>
            </div>
            <div
              onMouseDown={startEditorResize}
              onDoubleClick={() => setEditorHeight(180)}
              title="Drag to resize · double-click to reset"
              className="flex-shrink-0 h-[7px] bg-[#f5f7f9] border-b border-[#dfe3e8] flex items-center justify-center cursor-row-resize group"
            >
              <div className="w-[34px] h-[2px] rounded bg-[#c8d0d8] group-hover:bg-[#8a949e]" />
            </div>
          </>
        )}

        {/* results + profile */}
        {!isCopier && (
        <div className="flex-1 min-h-0 flex min-w-0">
          <div ref={resultsPaneRef} className="flex-1 min-w-0 flex flex-col min-h-0 bg-white">

            <div className="flex-shrink-0 min-w-0 flex items-center flex-wrap gap-y-2 gap-x-3.5 min-h-[38px] px-3.5 py-1 border-b border-[#dfe3e8]">
              <div className="flex-shrink-0 flex items-center gap-3">
                <span className="text-[12.5px] font-medium" style={{ boxShadow: `inset 0 -2px 0 ${C.accent}` }}>
                  {isData ? 'Table data' : 'Results'}
                </span>
                {!isData && hasGrid && (
                  <button onClick={toggleFullscreen} className="text-[12.5px] text-[#5c6670] hover:text-[#1a1d21]">
                    {isFullscreen ? 'Exit full screen' : 'Full screen'}
                  </button>
                )}
              </div>

              <div className="flex-1 min-w-0 text-[12px] text-[#5c6670] tabular-nums truncate">{resultMeta}</div>

              <div className="ml-auto flex-shrink-0 flex items-center gap-2">
                {view.filters.length > 0 && (
                  <button
                    onClick={clearFilters}
                    className="inline-flex items-center gap-1.5 max-w-[200px] px-2 py-[3px] rounded bg-[#e3f2fa] text-[11.5px] text-[#11567f]"
                    title="Clear all column filters"
                  >
                    <Icon src={filterIcon} className="w-2.5 h-2.5 flex-shrink-0" tint="ink" />
                    <span className="truncate">{view.filters.length} filter{view.filters.length === 1 ? '' : 's'}</span>
                    <Icon src={closeIcon} className="w-2.5 h-2.5 flex-shrink-0" tint="gray" />
                  </button>
                )}
                {canEdit && (
                  <button
                    onClick={() => patchActive({ newRows: [...view.newRows, {}] })}
                    className="flex items-center gap-1.5 h-[26px] px-2.5 rounded border border-[#dfe3e8] text-[12px] hover:bg-[#f5f7f9]"
                  >
                    <Icon src={addIcon} className="w-2.5 h-2.5" tint="gray" />Add row
                  </button>
                )}
                {isData && dirtyCount > 0 && (
                  <button onClick={clearPendingEdits} className="h-[26px] px-2.5 rounded border border-[#dfe3e8] text-[12px] hover:bg-[#f5f7f9]">
                    Revert {dirtyCount}
                  </button>
                )}
                {isData && (
                  <button
                    onClick={() => loadTablePage(active.id, active.table, view.page, pageSize, view.sort, view.filters)}
                    title="Reload this page of rows"
                    className="h-[26px] w-[26px] flex items-center justify-center rounded border border-[#dfe3e8] hover:bg-[#f5f7f9]"
                  >
                    <Icon src={refreshIcon} className="w-3 h-3" tint="gray" />
                  </button>
                )}
                {!isData && hasGrid && view.jobId && (view.rowCount ?? 0) > 0 && (
                  <span className="relative">
                    <button
                      onClick={e => { e.stopPropagation(); setExportOpen(o => !o); }}
                      className="flex items-center gap-1.5 h-[26px] px-2.5 rounded border border-[#dfe3e8] text-[12px] hover:bg-[#f5f7f9]"
                    >
                      <Icon src={downloadIcon} className="w-3 h-3" tint="gray" />Download
                      <Icon src={chevronDownIcon} className="w-2.5 h-2.5" tint="gray" />
                    </button>
                    {exportOpen && (
                      <div className="absolute right-0 top-full mt-1 z-30 w-[150px] bg-white border border-[#dfe3e8] rounded-md shadow-lg py-1">
                        {EXPORT_FORMATS.map(f => (
                          <button
                            key={f.id}
                            onClick={() => { setExportOpen(false); downloadResults(f.id); }}
                            className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-[#f5f7f9]"
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                )}
                {!profileOpen && (
                  <button onClick={toggleProfile} className="h-[26px] px-2.5 rounded border border-[#dfe3e8] text-[12px] hover:bg-[#f5f7f9]">
                    Profile
                  </button>
                )}
              </div>
            </div>

            {view.notice && (
              <div className="flex-shrink-0 px-3.5 py-2 border-b border-[#eceff2] text-[12px] text-[#1f8f4e] bg-[#f1f9f4]">
                {view.notice}
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-auto">
              {!isData && view.status === 'idle' && (
                <div className="px-3 py-10 text-center text-[#5c6670] text-[12.5px]">
                  Write a Snowflake statement above and hit Run. Or pick a table in the explorer to preview it, or open it in the editable grid.
                </div>
              )}
              {busy && <div className="p-2"><ResultsSkeleton cols={5} rows={10} /></div>}
              {view.error && (
                <div className="p-4">
                  <div className="max-w-[760px] flex items-start gap-2.5 px-3.5 py-3 rounded-md bg-[#fcf1f1] border border-[#f0d2d2] text-[12.5px] text-[#c02b2b] whitespace-pre-wrap">
                    <Icon src={alertIcon} className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="font-medium">{view.error}</div>
                      <button
                        onClick={() => navigator.clipboard?.writeText(view.error)}
                        className="mt-2.5 h-[27px] px-3 rounded border border-[#dfe3e8] bg-white text-[12px] text-[#1a1d21]"
                      >
                        Copy error
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {!isData && view.status === 'cancelled' && (
                <div className="px-3 py-10 text-center text-[#5c6670] text-[12.5px]">Query cancelled.</div>
              )}
              {!isData && view.status === 'success' && view.meta && !view.meta.returns_rows && (
                <div className="px-3 py-10 text-center text-[#5c6670] text-[12.5px]">
                  Statement executed — {(view.meta.rows_affected ?? 0).toLocaleString()} row{view.meta.rows_affected === 1 ? '' : 's'} affected. Nothing to display.
                </div>
              )}
              {isData && view.loading && (view.rows || []).length === 0 && !view.error && (
                <div className="p-2"><ResultsSkeleton cols={6} rows={10} /></div>
              )}
              {hasGrid && !busy && (
                <DataGrid
                  columns={gridColumns}
                  rows={view.rows}
                  widths={view.widths}
                  setWidths={setWidths}
                  sort={view.sort}
                  onSort={handleSort}
                  filters={view.filters}
                  onFilter={handleFilter}
                  loading={view.loading}
                  emptyMessage={isData ? 'No rows match the current filters.' : 'Ran fine — no rows on this page.'}
                  editable={canEdit}
                  columnMeta={isData ? columnMetaByName : {}}
                  edits={view.edits}
                  deleted={view.deleted}
                  newRows={isData ? view.newRows : []}
                  onEditCell={editCell}
                  onToggleDelete={toggleDelete}
                  onEditNewCell={editNewCell}
                  onRemoveNewRow={i => patchActive({ newRows: view.newRows.filter((_, idx) => idx !== i) })}
                  onCellClick={(col, value) => setCellDetail({ title: col, body: cellText(value) ?? 'null' })}
                />
              )}
            </div>

            {hasGrid && (
              <div className="flex-shrink-0 flex items-center gap-3 flex-wrap min-h-[32px] px-3.5 py-1 border-t border-[#dfe3e8] bg-[#fbfcfd]">
                <div className="flex items-center gap-2 text-[11.5px] text-[#5c6670] tabular-nums">
                  {(view.rowCount ?? 0).toLocaleString()} row{view.rowCount === 1 ? '' : 's'}
                  <select
                    value={pageSize}
                    onChange={e => changePageSize(Number(e.target.value))}
                    disabled={view.loading}
                    className="ml-1 h-[24px] border border-[#dfe3e8] rounded px-1.5 text-[11.5px] bg-white"
                  >
                    {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n} / page</option>)}
                  </select>
                </div>
                <div className="ml-auto">
                  <Pager page={view.page} totalPages={view.totalPages || 1} loading={view.loading} onGo={goToPage} />
                </div>
              </div>
            )}
          </div>

          {profileOpen && (
            <QueryProfile
              view={view}
              tab={active}
              serverInfo={serverInfo}
              dirtyCount={dirtyCount}
              onClose={toggleProfile}
            />
          )}

          {/* history / saved dock */}
          {panel && (
            <div className="w-[290px] flex-shrink-0 border-l border-[#dfe3e8] bg-white flex flex-col min-h-0">
              <div className="flex-shrink-0 flex items-center h-[38px] px-3 border-b border-[#dfe3e8]">
                <span className="text-[12px] font-medium">{panel === 'history' ? 'Query history' : 'Saved queries'}</span>
                <div className="ml-auto flex items-center gap-1">
                  {panel === 'history' && history.length > 0 && (
                    <button onClick={clearHistory} className="text-[11px] text-[#5c6670] hover:text-[#c02b2b]">Clear</button>
                  )}
                  <button onClick={() => setPanel(null)} className="p-1 rounded hover:bg-[#f5f7f9]">
                    <Icon src={closeIcon} className="w-2.5 h-2.5" tint="gray" />
                  </button>
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {panel === 'history' && history.length === 0 && (
                  <div className="p-3.5 text-[12px] text-[#8a949e]">Nothing here yet — run a query.</div>
                )}
                {panel === 'history' && history.map(h => (
                  <button
                    key={h.id}
                    onClick={() => (active.kind === 'query' ? setTabSql(active.id, h.sql) : openInNewTab(h.sql))}
                    className="w-full text-left px-3 py-2.5 border-b border-[#eceff2] hover:bg-[#fbfcfd]"
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: h.status === 'success' ? C.green : C.red }} />
                      <span className="text-[10.5px] text-[#8a949e] tabular-nums">
                        {formatWhen(h.created_at)} · {(h.elapsed_ms / 1000).toFixed(1)}s
                        {h.row_count != null ? ` · ${h.row_count.toLocaleString()} rows` : ''}
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-[#1a1d21] line-clamp-2 break-words">{h.sql}</div>
                    {h.error && <div className="mt-1 text-[10px] text-[#c02b2b] line-clamp-2">{h.error}</div>}
                  </button>
                ))}

                {panel === 'saved' && saved.length === 0 && (
                  <div className="p-3.5 text-[12px] text-[#8a949e]">No saved queries yet.</div>
                )}
                {panel === 'saved' && saved.map(s => (
                  <div key={s.id} className="group px-3 py-2.5 border-b border-[#eceff2] hover:bg-[#fbfcfd]">
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => openInNewTab(s.sql, s.name)} className="flex-1 min-w-0 text-left">
                        <div className="text-[12.5px] font-medium truncate">{s.name}</div>
                        <div className="text-[10.5px] text-[#8a949e]">
                          {formatWhen(s.updated_at)}{s.shared ? ' · shared' : ''}{!s.owned ? ` · ${s.user_email}` : ''}
                        </div>
                      </button>
                      {s.owned && (
                        <button onClick={() => deleteSaved(s.id)} title="Delete this saved query" className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[#eceff2]">
                          <Icon src={deleteIcon} className="w-3 h-3" tint="gray" />
                        </button>
                      )}
                    </div>
                    <div className="mt-1 text-[10.5px] font-mono text-[#5c6670] line-clamp-2 break-words">{s.sql}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        )}
      </div>

      {/* -------------------------------- modals ------------------------------- */}
      <ConfirmDestructiveModal
        info={pendingConfirm}
        confirming={confirming}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const info = pendingConfirm;
          setPendingConfirm(null);
          setConfirming(true);
          patchView(info.tabId, { status: 'starting' });
          submitQuery(info.tabId, info.sql, true);
        }}
      />

      <TextModal title={textModal?.title} body={textModal?.body} onClose={() => setTextModal(null)} />
      <TextModal title={cellDetail?.title} body={cellDetail?.body} onClose={() => setCellDetail(null)} />

      <SavePromptModal
        open={savePromptOpen}
        initialName={active.kind === 'query' ? active.name : ''}
        onCancel={() => setSavePromptOpen(false)}
        onSave={saveCurrentQuery}
      />

      {savePreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="px-5 py-4 border-b border-[#dfe3e8]">
              <h3 className="font-johnson-display font-bold text-[15px]">
                Apply {savePreview.summary} to {active.kind === 'data' ? active.table.table : ''}?
              </h3>
              <p className="mt-1 text-[12px] text-[#5c6670]">
                Rows are matched on {savePreview.key_columns?.join(', ') || 'every column'}. Everything runs in one transaction —
                if any statement touches more or fewer rows than the single row it targets, the whole batch is rolled back.
              </p>
            </div>
            <div className="flex-1 overflow-auto px-5 py-3 space-y-1.5">
              {savePreview.statements.map((s, i) => (
                <pre key={i} className="text-[11.5px] font-mono text-[#1a1d21] bg-[#f5f7f9] rounded px-3 py-2 whitespace-pre-wrap break-words">
                  {s.sql}
                </pre>
              ))}
            </div>
            <div className="px-5 py-4 border-t border-[#dfe3e8] flex items-center justify-end gap-2.5">
              <button onClick={() => setSavePreview(null)} className="px-4 py-2 rounded border border-[#dfe3e8] text-[12.5px] hover:bg-[#f5f7f9]">
                Cancel
              </button>
              <button
                onClick={applySave}
                disabled={saving}
                className="px-4 py-2 rounded bg-[#9e0000] text-white text-[12.5px] font-medium hover:opacity-90 disabled:opacity-50"
              >
                {saving ? 'Applying…' : 'Apply changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}