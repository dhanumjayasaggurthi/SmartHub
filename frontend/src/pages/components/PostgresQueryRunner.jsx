import React, { useState, useEffect, useRef, useCallback } from 'react';
import LoadingSpinner from './LoadingSpinner';
import { apiFetch, downloadFile } from '../../utils/apiClient';

import refreshIcon from "/icons/JJ_Icon_Refresh_RGB.svg";
import downloadIcon from "/icons/JJ_Icon_Download_PDF_RGB.svg";
import chevronDownIcon from "/icons/JJ_Icon_Chevron_Down.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import chevronLeftIcon from "/icons/JJ_Icon_Chevron_Left.svg";
import infoIcon from "/icons/JJ_Icon_Info_RGB.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import playIcon from "/icons/JJ_Icon_Video_Play_RGB.svg";
import pgIcon from "/icons/postgres_badge.svg";

const TINTS = {
  red: "url(#jj-red-tint)",
  ink: "url(#jj-ink-tint)",
  gray: "url(#jj-gray-tint)",
  white: "url(#jj-white-tint)",
};
const Icon = ({ src, alt = "", className = "w-4 h-4", tint = "red" }) => (
  <img src={src} alt={alt} className={className} style={tint ? { filter: TINTS[tint] } : undefined} />
);
const CopyIcon = ({ className = "w-3 h-3" }) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500];

// A statement whose leading keyword falls in here mutates data/schema -
// purely a client-side hint (button color, banner) for a snappier feel;
// the backend re-validates and is the actual authority on this.
const DESTRUCTIVE_HINT_RE = /^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|VACUUM|REINDEX|CLUSTER|REFRESH|DO|CALL|COMMENT|LOCK)\b/i;

function leadKeywordHint(sql) {
  const m = DESTRUCTIVE_HINT_RE.exec(sql || '');
  return m ? m[1].toUpperCase() : null;
}

async function fetchJson(url, opts) {
  const res = await apiFetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((body && (typeof body.detail === 'string' ? body.detail : body.detail?.message)) || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Postgres json/jsonb (and array) columns arrive as real objects/arrays, not
// strings - plain String(v) on those gives "[object Object]". Render them as
// compact JSON text instead, same as psql/DBeaver would.
function cellDisplayText(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// SQL suggestions for the query editor: keywords, PostgreSQL functions, and
// (dot-aware) live schema/table/column names pulled from the explorer
// endpoints - same idea as Data Studio's Snowflake autocomplete.
// ---------------------------------------------------------------------------
const PG_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'WITH', 'AS', 'ON', 'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'ILIKE',
  'BETWEEN', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC', 'NULLS LAST',
  'JOIN', 'LEFT JOIN', 'INNER JOIN', 'FULL OUTER JOIN', 'CROSS JOIN', 'UNION ALL', 'UNION',
  'OVER', 'PARTITION BY', 'EXISTS', 'ANY', 'ALL', 'RETURNING', 'ON CONFLICT', 'DO NOTHING',
  'DO UPDATE SET', 'VALUES', 'SET', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE',
  'ALTER TABLE', 'DROP TABLE', 'TRUNCATE', 'EXPLAIN', 'EXPLAIN ANALYZE', 'CONFLICT',
];
const PG_FUNCTIONS = [
  'COUNT(', 'SUM(', 'AVG(', 'MIN(', 'MAX(', 'COALESCE(', 'NULLIF(', 'CAST(',
  'TO_DATE(', 'TO_CHAR(', 'TO_NUMBER(', 'TO_TIMESTAMP(', 'DATE_TRUNC(', 'AGE(', 'NOW()',
  'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'ROW_NUMBER() OVER (', 'RANK() OVER (', 'DENSE_RANK() OVER (',
  'STRING_AGG(', 'ARRAY_AGG(', 'JSONB_BUILD_OBJECT(', 'JSONB_AGG(', 'UNNEST(', 'GENERATE_SERIES(',
  'TRIM(', 'UPPER(', 'LOWER(', 'LENGTH(', 'SUBSTRING(', 'REPLACE(', 'CONCAT(', 'CONCAT_WS(',
  'REGEXP_REPLACE(', 'REGEXP_MATCHES(', 'EXTRACT(', 'DATE_PART(',
];
const PG_STATIC_SUGGESTIONS = [
  ...PG_KEYWORDS.map(w => ({ text: w, kind: 'keyword' })),
  ...PG_FUNCTIONS.map(w => ({ text: w, kind: 'function' })),
];

// The word being typed at the caret: [start, end) plus its text. Dot-aware:
// for "my_schema.my_ta|" returns word "my_ta" with context ["my_schema"] so
// the dropdown can offer tables of my_schema (and columns for a 2-part chain).
function sqlTokenAtCaret(text, caret) {
  let start = caret;
  while (start > 0 && /[A-Za-z0-9_$"]/.test(text[start - 1])) start--;
  const word = text.slice(start, caret).replace(/"/g, '');
  const context = [];
  let i = start;
  while (i > 0 && text[i - 1] === '.') {
    let j = i - 1;
    while (j > 0 && /[A-Za-z0-9_$"]/.test(text[j - 1])) j--;
    const part = text.slice(j, i - 1).replace(/"/g, '');
    if (!part) break;
    context.unshift(part);
    i = j;
  }
  return { start, word, context };
}

// Caret pixel position inside a textarea, via an offscreen mirror div that
// clones the textarea's text metrics up to the caret.
function caretPixelPos(ta, caret) {
  const style = window.getComputedStyle(ta);
  const mirror = document.createElement('div');
  for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'border', 'boxSizing', 'whiteSpace', 'wordWrap', 'overflowWrap', 'tabSize']) {
    mirror.style[prop] = style[prop];
  }
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.width = ta.clientWidth + 'px';
  mirror.textContent = ta.value.slice(0, caret);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const pos = { left: marker.offsetLeft, top: marker.offsetTop + marker.offsetHeight };
  document.body.removeChild(mirror);
  return { left: pos.left - ta.scrollLeft, top: pos.top - ta.scrollTop };
}



const SkeletonLine = ({ w = '100%', h = 10 }) => (
  <div className="animate-pulse rounded bg-jj-gray-02" style={{ width: w, height: h }} />
);

const TreeRowSkeleton = ({ depth = 0, count = 3 }) => (
  <div style={{ paddingLeft: depth * 14 }} className="py-1 space-y-1.5">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="flex items-center gap-2 px-2 py-1">
        <SkeletonLine w={`${60 + (i % 3) * 20}px`} h={9} />
      </div>
    ))}
  </div>
);

function ResultsSkeleton({ cols = 6, rows = 10 }) {
  return (
    <table className="w-full text-xs font-johnson-text">
      <thead>
        <tr className="bg-[#faf9f8]">
          {Array.from({ length: cols }).map((_, i) => (
            <th key={i} className="px-3 py-2.5 border-b border-r border-jj-gray-02">
              <SkeletonLine w="70%" h={9} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }).map((_, r) => (
          <tr key={r}>
            {Array.from({ length: cols }).map((_, c) => (
              <td key={c} className="px-3 py-2.5 border-b border-r border-jj-gray-01">
                <SkeletonLine w={`${40 + ((r * 7 + c * 13) % 50)}%`} h={9} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* --------------------------------- pager --------------------------------- */

function Pager({ page, totalPages, loading, onGo, approximate }) {
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
          value={draft}
          disabled={loading}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); e.target.blur(); } }}
          className="w-[62px] border border-jj-gray-03 rounded-lg px-2 py-1 text-center font-johnson-text tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          aria-label="Go to page"
        />
        of {approximate ? '~' : ''}{totalPages.toLocaleString()}
      </span>
      <button onClick={() => onGo(page + 1)} disabled={loading} className={btn} title="Next page">Next</button>
      <button onClick={() => onGo(totalPages)} disabled={page >= totalPages || loading} className={btn} title="Last page">»</button>
    </div>
  );
}

/* ------------------------------ explorer tree ----------------------------- */

function ExplorerTree({ onInsert, onPreview, logInPage, onCollapse }) {
  const [databases, setDatabases] = useState(null);   // null = loading, [] = loaded empty
  const [dbError, setDbError] = useState(null);
  const [expandedDb, setExpandedDb] = useState(null);
  const [expandedSchema, setExpandedSchema] = useState(null); // `${db}.${schema}`
  const [expandedTable, setExpandedTable] = useState(null);   // `${db}.${schema}.${table}`
  const schemasRef = useRef({});   // db -> schemas[] | 'loading' | Error
  const tablesRef = useRef({});    // db.schema -> tables[] | 'loading' | Error
  const columnsRef = useRef({});   // db.schema.table -> columns[] | 'loading' | Error
  const [, forceTick] = useState(0);
  const rerender = () => forceTick(t => t + 1);

  const loadDatabases = useCallback((bypassCache = false) => {
    setDatabases(null);
    setDbError(null);
    fetchJson(`/api/postgres/databases${bypassCache ? '?bypass_cache=true' : ''}`)
      .then(data => setDatabases(data.databases || []))
      .catch(err => setDbError(err.message || 'Failed to load databases'));
  }, []);

  useEffect(() => { loadDatabases(); }, [loadDatabases]);

  const toggleDb = (db) => {
    if (expandedDb === db) { setExpandedDb(null); return; }
    setExpandedDb(db);
    logInPage?.('pg_explorer_expand', `Expanded Postgres database "${db}"`);
    if (schemasRef.current[db] === undefined) {
      schemasRef.current[db] = 'loading';
      rerender();
      fetchJson(`/api/postgres/schemas?database=${encodeURIComponent(db)}`)
        .then(data => { schemasRef.current[db] = data.schemas || []; rerender(); })
        .catch(err => { schemasRef.current[db] = err; rerender(); });
    }
  };

  const toggleSchema = (db, schema) => {
    const key = `${db}.${schema}`;
    if (expandedSchema === key) { setExpandedSchema(null); return; }
    setExpandedSchema(key);
    logInPage?.('pg_explorer_expand', `Expanded Postgres schema "${key}"`);
    if (tablesRef.current[key] === undefined) {
      tablesRef.current[key] = 'loading';
      rerender();
      fetchJson(`/api/postgres/tables?database=${encodeURIComponent(db)}&schema=${encodeURIComponent(schema)}`)
        .then(data => { tablesRef.current[key] = data.tables || []; rerender(); })
        .catch(err => { tablesRef.current[key] = err; rerender(); });
    }
  };

  const toggleTable = (db, schema, table) => {
    const key = `${db}.${schema}.${table}`;
    if (expandedTable === key) { setExpandedTable(null); return; }
    setExpandedTable(key);
    logInPage?.('pg_explorer_expand', `Expanded Postgres table "${key}"`);
    if (columnsRef.current[key] === undefined) {
      columnsRef.current[key] = 'loading';
      rerender();
      fetchJson(`/api/postgres/columns?database=${encodeURIComponent(db)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`)
        .then(data => { columnsRef.current[key] = data.columns || []; rerender(); })
        .catch(err => { columnsRef.current[key] = err; rerender(); });
    }
  };

  const formatBytes = (n) => {
    if (n == null) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let val = n, i = 0;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  };
  const formatCount = (n) => {
    if (n == null) return '';
    if (n >= 1_000_000_000) return `~${(n / 1_000_000_000).toFixed(1)}B rows`;
    if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M rows`;
    if (n >= 1_000) return `~${(n / 1_000).toFixed(1)}K rows`;
    return `~${n} rows`;
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-shrink-0 flex items-center justify-between px-3 py-2.5 border-b border-jj-gray-02">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-jj-gray-06">
          <Icon src={pgIcon} className="w-3.5 h-3.5 rounded-full" tint={null} />
          Explorer
        </div>
        <button onClick={() => loadDatabases(true)} title="Refresh databases" className="p-1 rounded hover:bg-jj-gray-01">
          <Icon src={refreshIcon} className="w-3.5 h-3.5" tint="gray" />
        </button>
      </div>
      <div className="flex items-center justify-end px-3 pt-1.5">
        <button onClick={onCollapse} title="Collapse explorer" className="flex items-center gap-1 text-[10.5px] font-johnson-text text-jj-gray-06 hover:text-jj-gray-08 px-1.5 py-0.5 rounded hover:bg-jj-gray-01">
          <Icon src={chevronLeftIcon} className="w-2.5 h-2.5" tint="gray" />
          Collapse
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 py-1.5 text-[12px] font-johnson-text">
        {databases === null && !dbError && <TreeRowSkeleton depth={0} count={5} />}
        {dbError && (
          <div className="p-2.5">
            <div className="text-[11px] text-jj-maroon-05 mb-1.5">{dbError}</div>
            <button onClick={() => loadDatabases(true)} className="text-[11px] text-jj-blue-03 underline">Retry</button>
          </div>
        )}
        {databases && databases.length === 0 && (
          <div className="p-2.5 text-[11px] text-jj-gray-06">No databases visible to this role.</div>
        )}
        {databases && databases.map(db => (
          <div key={db}>
            <button
              onClick={() => toggleDb(db)}
              className="w-full flex items-center gap-1 px-1.5 py-1 rounded hover:bg-jj-gray-01 text-left"
            >
              <Icon src={expandedDb === db ? chevronDownIcon : chevronRightIcon} className="w-2.5 h-2.5 flex-shrink-0" tint="gray" />
              <Icon src={pgIcon} className="w-3.5 h-3.5 flex-shrink-0 rounded-full" tint={null} />
              <span className="truncate text-jj-gray-08">{db}</span>
            </button>
            {expandedDb === db && (
              <div className="pl-4">
                {schemasRef.current[db] === 'loading' && <TreeRowSkeleton depth={0} count={3} />}
                {schemasRef.current[db] instanceof Error && (
                  <div className="px-2 py-1 text-[11px] text-jj-maroon-05">{schemasRef.current[db].message}</div>
                )}
                {Array.isArray(schemasRef.current[db]) && schemasRef.current[db].length === 0 && (
                  <div className="px-2 py-1 text-[11px] text-jj-gray-06">No schemas.</div>
                )}
                {Array.isArray(schemasRef.current[db]) && schemasRef.current[db].map(schema => {
                  const schemaKey = `${db}.${schema}`;
                  return (
                    <div key={schema}>
                      <button
                        onClick={() => toggleSchema(db, schema)}
                        className="w-full flex items-center gap-1 px-1.5 py-1 rounded hover:bg-jj-gray-01 text-left"
                      >
                        <Icon src={expandedSchema === schemaKey ? chevronDownIcon : chevronRightIcon} className="w-2.5 h-2.5 flex-shrink-0" tint="gray" />
                        <span className="truncate text-jj-gray-08">{schema}</span>
                      </button>
                      {expandedSchema === schemaKey && (
                        <div className="pl-4">
                          {tablesRef.current[schemaKey] === 'loading' && <TreeRowSkeleton depth={0} count={4} />}
                          {tablesRef.current[schemaKey] instanceof Error && (
                            <div className="px-2 py-1 text-[11px] text-jj-maroon-05">{tablesRef.current[schemaKey].message}</div>
                          )}
                          {Array.isArray(tablesRef.current[schemaKey]) && tablesRef.current[schemaKey].length === 0 && (
                            <div className="px-2 py-1 text-[11px] text-jj-gray-06">No tables.</div>
                          )}
                          {Array.isArray(tablesRef.current[schemaKey]) && tablesRef.current[schemaKey].map(t => {
                            const tableKey = `${schemaKey}.${t.name}`;
                            return (
                              <div key={t.name}>
                                <div className="group w-full flex items-center gap-1 px-1.5 py-1 rounded hover:bg-jj-gray-01">
                                  <button onClick={() => toggleTable(db, schema, t.name)} className="flex items-center gap-1 flex-1 min-w-0 text-left">
                                    <Icon src={expandedTable === tableKey ? chevronDownIcon : chevronRightIcon} className="w-2.5 h-2.5 flex-shrink-0" tint="gray" />
                                    <span className="truncate text-jj-gray-08">{t.name}</span>
                                    <span className="flex-shrink-0 text-[9.5px] uppercase tracking-wide text-jj-gray-05">{t.kind === 'view' ? 'view' : t.kind === 'materialized_view' ? 'mview' : ''}</span>
                                  </button>
                                  <button
                                    onClick={() => onPreview(db, schema, t.name)}
                                    title="Preview 100 rows"
                                    className="opacity-0 group-hover:opacity-100 flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-jj-gray-03 text-jj-gray-07 hover:bg-white"
                                  >
                                    Preview
                                  </button>
                                  <button
                                    onClick={() => onInsert(`${schema}.${t.name}`)}
                                    title="Insert into editor"
                                    className="opacity-0 group-hover:opacity-100 flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-jj-gray-03 text-jj-gray-07 hover:bg-white"
                                  >
                                    Insert
                                  </button>
                                </div>
                                <div className="pl-4 pb-0.5 text-[10px] text-jj-gray-05">
                                  {formatCount(t.est_rows)}{t.size_bytes != null ? ` · ${formatBytes(t.size_bytes)}` : ''}
                                </div>
                                {expandedTable === tableKey && (
                                  <div className="pl-4">
                                    {columnsRef.current[tableKey] === 'loading' && <TreeRowSkeleton depth={0} count={5} />}
                                    {columnsRef.current[tableKey] instanceof Error && (
                                      <div className="px-2 py-1 text-[11px] text-jj-maroon-05">{columnsRef.current[tableKey].message}</div>
                                    )}
                                    {Array.isArray(columnsRef.current[tableKey]) && columnsRef.current[tableKey].map(col => (
                                      <button
                                        key={col.name}
                                        onClick={() => onInsert(col.name)}
                                        title={`${col.data_type}${col.nullable ? '' : ' · NOT NULL'}${col.is_primary_key ? ' · PK' : ''}`}
                                        className="w-full flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-jj-gray-01 text-left"
                                      >
                                        {col.is_primary_key && <span className="text-[9px] text-jj-orange-03 font-bold flex-shrink-0">PK</span>}
                                        <span className="truncate text-jj-gray-07">{col.name}</span>
                                        <span className="flex-shrink-0 text-[9.5px] text-jj-gray-05">{col.data_type}</span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------- destructive confirm modal -------------------------- */

function ConfirmDestructiveModal({ info, onCancel, onConfirm, confirming }) {
  if (!info) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-5">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-9 h-9 rounded-full bg-jj-maroon-05/10 flex items-center justify-center">
            <Icon src={alertIcon} className="w-4.5 h-4.5" tint="red" />
          </div>
          <div className="min-w-0">
            <h3 className="font-johnson-display font-bold text-[15px] text-jj-gray-08">
              Confirm {info.statement_type} statement
            </h3>
            <p className="mt-1 text-xs font-johnson-text text-jj-gray-06">{info.message}</p>
            {info.warning && (
              <p className="mt-2 text-xs font-johnson-text text-jj-maroon-05 bg-red-50 border border-jj-maroon-05/30 rounded-lg px-2.5 py-2">
                {info.warning}
              </p>
            )}
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2.5">
          <button onClick={onCancel} className="px-4 py-2 rounded-full border border-jj-gray-03 text-xs font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={confirming}
            className="px-4 py-2 rounded-full bg-jj-maroon-05 text-white text-xs font-johnson-text font-medium hover:opacity-90 disabled:opacity-50"
          >
            {confirming ? 'Running…' : `Run ${info.statement_type}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================================ main component ================================ */

export default function PostgresQueryRunner({ logInPage }) {
  const [connState, setConnState] = useState('checking'); // checking | ready | unconfigured | error
  const [connError, setConnError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchJson('/api/postgres/databases')
      .then(() => { if (!cancelled) setConnState('ready'); })
      .catch(err => {
        if (cancelled) return;
        if (err.status === 503) { setConnState('unconfigured'); setConnError(err.message); }
        else { setConnState('error'); setConnError(err.message); }
      });
    return () => { cancelled = true; };
  }, []);

  const [queryText, setQueryText] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('postgres.sidebarCollapsed') === '1'; } catch { return false; }
  });
  const toggleSidebar = () => {
    setSidebarCollapsed(c => {
      const next = !c;
      try { localStorage.setItem('postgres.sidebarCollapsed', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };
  const [editorTheme, setEditorTheme] = useState(() => {
    try { return localStorage.getItem('postgres.editorTheme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });
  const toggleEditorTheme = () => {
    setEditorTheme(t => {
      const next = t === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('postgres.editorTheme', next); } catch { /* ignore */ }
      return next;
    });
  };
  const [copied, setCopied] = useState(false);
  const copyQueryText = async () => {
    if (!queryText.trim()) return;
    try {
      await navigator.clipboard.writeText(queryText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const editorRef = useRef(null);
  const resultsCardRef = useRef(null);

  // Drag-to-resize divider above the results table, Snowflake-style: down
  // grows the editor / shrinks the table, up does the opposite.
  const [editorHeight, setEditorHeight] = useState(150);
  const editorHeightTouchedRef = useRef(false);
  const startEditorResize = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorHeight;
    const onMove = (ev) => { editorHeightTouchedRef.current = true; setEditorHeight(Math.max(72, Math.min(560, startH + (ev.clientY - startY)))); };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  const toggleResultsFullscreen = () => {
    logInPage?.('pg_fullscreen_toggle', document.fullscreenElement ? 'Exited full screen on Postgres query results' : 'Entered full screen on Postgres query results');
    if (document.fullscreenElement) document.exitFullscreen();
    else resultsCardRef.current?.requestFullscreen?.();
  };

  // SQL autocomplete: { items, index, left, top } | null when closed. Static
  // keywords/functions plus (dot-aware) live schema -> table -> column names,
  // fetched lazily and cached per context - same idea as the Snowflake runner.
  const [sqlSuggest, setSqlSuggest] = useState(null);
  const sqlObjectsCacheRef = useRef({}); // '' | schema | schema.table -> items[] | 'loading'

  const ensureSqlObjects = useCallback((context) => {
    const cache = sqlObjectsCacheRef.current;
    const ctxKey = context.join('.');
    if (cache[ctxKey] !== undefined) return;
    cache[ctxKey] = 'loading';
    const settle = (items) => { cache[ctxKey] = items; updateSqlSuggestRef.current(editorRef.current); };
    if (context.length === 0) {
      fetchJson('/api/postgres/schemas')
        .then(data => settle((data.schemas || []).map(s => ({ text: s, kind: 'schema' }))))
        .catch(() => settle([]));
    } else if (context.length === 1) {
      fetchJson(`/api/postgres/tables?schema=${encodeURIComponent(context[0])}`)
        .then(data => settle((data.tables || []).map(t => ({ text: t.name, kind: t.kind === 'view' ? 'view' : 'table' }))))
        .catch(() => settle([]));
    } else if (context.length === 2) {
      fetchJson(`/api/postgres/columns?schema=${encodeURIComponent(context[0])}&table=${encodeURIComponent(context[1])}`)
        .then(data => settle((data.columns || []).map(c => ({ text: c.name, kind: 'column' }))))
        .catch(() => settle([]));
    } else {
      settle([]);
    }
  }, []);

  const updateSqlSuggest = useCallback((ta) => {
    if (!ta) return setSqlSuggest(null);
    const caret = ta.selectionStart;
    if (caret !== ta.selectionEnd) return setSqlSuggest(null);
    const { word, context } = sqlTokenAtCaret(ta.value, caret);
    const lower = word.toLowerCase();
    let items;
    if (context.length > 0 && context.length <= 2) {
      const objects = sqlObjectsCacheRef.current[context.join('.')];
      if (objects === undefined || objects === 'loading') {
        ensureSqlObjects(context);
        return setSqlSuggest(null); // reopens via updateSqlSuggestRef once the fetch lands
      }
      items = objects
        .filter(o => !lower || o.text.toLowerCase().includes(lower))
        .sort((a, b) => {
          const ap = a.text.toLowerCase().startsWith(lower) ? 0 : 1;
          const bp = b.text.toLowerCase().startsWith(lower) ? 0 : 1;
          return ap - bp || a.text.localeCompare(b.text);
        })
        .slice(0, 10);
    } else {
      if (word.length < 2) return setSqlSuggest(null);
      const schemas = Array.isArray(sqlObjectsCacheRef.current['']) ? sqlObjectsCacheRef.current[''] : [];
      const pool = [...PG_STATIC_SUGGESTIONS, ...schemas];
      const starts = pool.filter(s => s.text.toLowerCase().startsWith(lower) && s.text.toLowerCase() !== lower);
      const contains = pool.filter(s => !s.text.toLowerCase().startsWith(lower) && s.text.toLowerCase().includes(lower));
      items = [...starts, ...contains].slice(0, 8);
    }
    if (!items || items.length === 0) return setSqlSuggest(null);
    const pos = caretPixelPos(ta, caret);
    setSqlSuggest({ items, index: 0, left: Math.min(pos.left, ta.clientWidth - 240), top: pos.top });
  }, [ensureSqlObjects]);
  const updateSqlSuggestRef = useRef(updateSqlSuggest);
  useEffect(() => { updateSqlSuggestRef.current = updateSqlSuggest; }, [updateSqlSuggest]);

  const acceptSqlSuggestion = (item) => {
    const ta = editorRef.current;
    if (!ta || !item) return;
    const caret = ta.selectionStart;
    const { start } = sqlTokenAtCaret(ta.value, caret);
    const chains = item.kind === 'schema' || item.kind === 'table' || item.kind === 'view';
    const insert = item.text + (chains ? '.' : (item.kind === 'function' || /[ (]$/.test(item.text) ? '' : ' '));
    const next = ta.value.slice(0, start) + insert + ta.value.slice(caret);
    setQueryText(next);
    setSqlSuggest(null);
    requestAnimationFrame(() => {
      ta.focus();
      const p = start + insert.length;
      ta.setSelectionRange(p, p);
      if (chains) updateSqlSuggestRef.current(ta);
    });
  };


  const [status, setStatus] = useState('idle'); // idle | starting | running | success | failed | cancelled
  const [jobId, setJobId] = useState(null);
  const [meta, setMeta] = useState(null); // status payload from the backend
  const [error, setError] = useState(null);
  const [pendingConfirm, setPendingConfirm] = useState(null); // { message, statement_type, warning } | null
  const [confirming, setConfirming] = useState(false);

  const [pageRows, setPageRows] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [pageLoading, setPageLoading] = useState(false);
  const [sort, setSort] = useState(null); // { col, dir }
  const [rowCount, setRowCount] = useState(null);
  const [rowCountIsEstimate, setRowCountIsEstimate] = useState(false);
  const [refiningCount, setRefiningCount] = useState(false);

  const pollRef = useRef(null);
  const stopPolling = () => { if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; } };
  useEffect(() => stopPolling, []);

  const fetchPage = useCallback(async (jid, pageNum, size, sortVal) => {
    setPageLoading(true);
    try {
      const params = new URLSearchParams({ page: pageNum, page_size: size });
      if (sortVal) { params.set('sort_col', sortVal.col); params.set('sort_dir', sortVal.dir); }
      const data = await fetchJson(`/api/postgres/query/${jid}/rows?${params}`);
      setPageRows(data.rows);
      setPage(data.page);
      setRowCount(data.total_rows);
      setRowCountIsEstimate(data.row_count_is_estimate);
    } catch (err) {
      setError(err.message || 'Failed to fetch rows');
    } finally {
      setPageLoading(false);
    }
  }, []);

  const pollStatus = useCallback((jid) => {
    pollRef.current = setTimeout(async () => {
      try {
        const data = await fetchJson(`/api/postgres/query/${jid}/status`);
        if (data.status === 'running') { pollStatus(jid); return; }
        setMeta(data);
        setRowCount(data.row_count);
        setRowCountIsEstimate(data.row_count_is_estimate);
        if (data.status === 'success') {
          setStatus('success');
          if (data.returns_rows) fetchPage(jid, 1, pageSize, null);
        } else if (data.status === 'failed') {
          setStatus('failed');
          setError(data.error || 'Query failed');
        } else {
          setStatus(data.status);
        }
      } catch (err) {
        setStatus('failed');
        setError(err.message || 'Lost connection while checking query status');
      }
    }, 900);
  }, [fetchPage, pageSize]);

  const resetRunState = () => {
    stopPolling();
    setError(null);
    setMeta(null);
    setPageRows([]);
    setSort(null);
    setPage(1);
    setJobId(null);
    setRowCount(null);
    setRowCountIsEstimate(false);
  };

  const submitQuery = async (confirm) => {
    const sql = queryText.trim();
    if (!sql) return;
    try {
      const data = await fetchJson('/api/postgres/query', {
        method: 'POST',
        body: { sql, confirm },
      });
      logInPage?.('pg_query_run', `Ran Postgres query${confirm ? ' (confirmed destructive)' : ''}: ${sql.slice(0, 300)}`);
      setJobId(data.job_id);
      setStatus('running');
      pollStatus(data.job_id);
    } catch (err) {
      if (err.status === 409 && err.body?.detail?.requires_confirmation) {
        setPendingConfirm(err.body.detail);
        setStatus('idle');
      } else {
        setStatus('failed');
        setError(err.message || 'Failed to start query');
      }
    } finally {
      setConfirming(false);
    }
  };

  const runQuery = () => {
    if (!queryText.trim() || status === 'running' || status === 'starting') return;
    resetRunState();
    setStatus('starting');
    submitQuery(false);
  };

  const confirmDestructive = () => {
    setConfirming(true);
    submitQuery(true);
  };

  const cancelQuery = async () => {
    if (!jobId) return;
    stopPolling();
    logInPage?.('pg_query_cancel', `Cancelled running Postgres query (job ${jobId})`);
    try { await apiFetch(`/api/postgres/query/${jobId}/cancel`, { method: 'POST' }); } catch { /* best-effort */ }
    setStatus('cancelled');
  };

  const goToPage = (n) => {
    if (!jobId || !meta) return;
    const total = Math.max(1, Math.ceil((rowCount || 1) / pageSize));
    const clamped = Math.max(1, Math.min(total, n));
    fetchPage(jobId, clamped, pageSize, sort);
  };

  const changePageSize = (n) => {
    setPageSize(n);
    if (jobId && meta) fetchPage(jobId, 1, n, sort);
  };

  const handleSort = (col) => {
    if (!jobId || !meta || pageLoading) return;
    const next = sort && sort.col === col ? { col, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' };
    setSort(next);
    fetchPage(jobId, 1, pageSize, next);
  };

  const refineExactCount = async () => {
    if (!jobId) return;
    setRefiningCount(true);
    try {
      const data = await fetchJson(`/api/postgres/query/${jobId}/count`, { method: 'POST' });
      setRowCount(data.row_count);
      setRowCountIsEstimate(false);
    } catch (err) {
      setError(err.message || 'Failed to compute exact count');
    } finally {
      setRefiningCount(false);
    }
  };

  const downloadCsv = () => {
    if (!jobId) return;
    logInPage?.('pg_query_csv_download', `Downloaded full Postgres query result set (job ${jobId}) as CSV`);
    downloadFile(`/api/postgres/query/${jobId}/download`, 'postgres_query_results.csv');
  };

  const insertIntoEditor = (text) => {
    const ta = editorRef.current;
    if (!ta) { setQueryText(q => (q ? q + ' ' : '') + text); return; }
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

  const previewTable = (db, schema, table) => {
    const sql = `SELECT * FROM "${schema}"."${table}" LIMIT 100`;
    setQueryText(sql);
    resetRunState();
    setStatus('starting');
    fetchJson('/api/postgres/query', { method: 'POST', body: { sql, confirm: false } })
      .then(data => {
        logInPage?.('pg_query_run', `Previewed Postgres table ${schema}.${table}`);
        setJobId(data.job_id);
        setStatus('running');
        pollStatus(data.job_id);
      })
      .catch(err => { setStatus('failed'); setError(err.message || 'Failed to start preview'); });
  };

  const leadHint = leadKeywordHint(queryText);
  const totalPages = rowCount ? Math.max(1, Math.ceil(rowCount / pageSize)) : 1;

  if (connState === 'checking') {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center p-10">
        <LoadingSpinner />
      </div>
    );
  }

  if (connState === 'unconfigured') {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center p-10">
        <div className="max-w-md text-center">
          <Icon src={infoIcon} className="w-6 h-6 mx-auto mb-2" tint="gray" />
          <div className="text-sm font-johnson-text text-jj-gray-07">
            Postgres Query Runner isn't configured yet. Add a <code className="text-[11px] bg-jj-gray-01 px-1 py-0.5 rounded">postgres_query_runner</code> section to the backend config to enable it.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 flex overflow-hidden">
      {sidebarCollapsed ? (
        <div className="w-[36px] flex-shrink-0 border-r border-jj-gray-02 bg-white flex flex-col items-center pt-2.5 gap-3">
          <button onClick={toggleSidebar} title="Expand explorer" className="p-1.5 rounded hover:bg-jj-gray-01">
            <Icon src={chevronRightIcon} className="w-3 h-3" tint="gray" />
          </button>
          <Icon src={pgIcon} className="w-4 h-4 rounded-full flex-shrink-0" tint={null} />
        </div>
      ) : (
        <div className="w-[280px] flex-shrink-0 border-r border-jj-gray-02 bg-white">
          <ExplorerTree onInsert={insertIntoEditor} onPreview={previewTable} logInPage={logInPage} onCollapse={toggleSidebar} />
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col p-5 overflow-hidden">
        {connState === 'error' && (
          <div className="flex-shrink-0 mb-3 flex items-start gap-2 px-3 py-2 rounded-xl bg-red-50 border border-jj-maroon-05/40 text-xs font-johnson-text text-jj-maroon-05">
            <Icon src={alertIcon} className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            {connError || 'Could not reach the Postgres Query Runner API.'}
          </div>
        )}

        <div className="flex-shrink-0 bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] overflow-hidden">
          <div className={`relative px-5 py-4 ${editorTheme === 'dark' ? 'bg-jj-gray-08' : 'bg-white border-b border-jj-gray-02'}`}>
            <div className="absolute top-2.5 right-2.5 z-[5] flex items-center gap-1.5">
              <button
                onClick={copyQueryText}
                title="Copy SQL"
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10.5px] font-johnson-text border transition-colors ${
                  editorTheme === 'dark' ? 'text-white/70 border-white/25 hover:text-white hover:border-white/50' : 'text-jj-gray-07 border-jj-gray-03 hover:text-jj-gray-08 hover:bg-white'
                }`}
              >
                <CopyIcon />
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                onClick={toggleEditorTheme}
                title={editorTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                className={`px-2.5 py-1 rounded-full text-[10.5px] font-johnson-text border transition-colors ${
                  editorTheme === 'dark' ? 'text-white/70 border-white/25 hover:text-white hover:border-white/50' : 'text-jj-gray-07 border-jj-gray-03 hover:text-jj-gray-08 hover:bg-white'
                }`}
              >
                {editorTheme === 'dark' ? '☀ Light' : '☾ Dark'}
              </button>
            </div>
            <textarea
              ref={editorRef}
              value={queryText}
              onChange={e => { setQueryText(e.target.value); updateSqlSuggest(e.target); }}
              onFocus={() => ensureSqlObjects([])}
              onClick={() => setSqlSuggest(null)}
              onBlur={() => setTimeout(() => setSqlSuggest(null), 150)}
              onScroll={() => setSqlSuggest(null)}
              onKeyDown={e => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); setSqlSuggest(null); runQuery(); return; }
                if (sqlSuggest) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setSqlSuggest(s => ({ ...s, index: (s.index + 1) % s.items.length })); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setSqlSuggest(s => ({ ...s, index: (s.index - 1 + s.items.length) % s.items.length })); }
                  else if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); acceptSqlSuggestion(sqlSuggest.items[sqlSuggest.index]); }
                  else if (e.key === 'Escape') { e.preventDefault(); setSqlSuggest(null); }
                }
              }}
              spellCheck={false}
              placeholder='SELECT * FROM "public"."my_table" LIMIT 100'
              className={`w-full bg-transparent text-xs font-mono leading-relaxed resize-none focus:outline-none pr-36 ${
                editorTheme === 'dark' ? 'text-white/90 placeholder-white/30' : 'text-jj-gray-08 placeholder-jj-gray-05'
              }`}
              style={{ caretColor: editorTheme === 'dark' ? '#69d0ff' : '#0f68b2', height: editorHeight }}
            />
            {sqlSuggest && (
              <div
                className={`absolute z-20 min-w-[220px] max-w-[520px] w-max max-h-[200px] overflow-y-auto rounded-lg shadow-xl border text-xs font-mono ${
                  editorTheme === 'dark' ? 'bg-[#3d3835] border-white/15' : 'bg-white border-jj-gray-02'
                }`}
                style={{ left: 20 + Math.max(0, Math.min(sqlSuggest.left, (editorRef.current?.clientWidth || 800) - 280)), top: 16 + sqlSuggest.top }}
              >
                {sqlSuggest.items.map((item, i) => (
                  <div
                    key={item.text}
                    onMouseDown={e => { e.preventDefault(); acceptSqlSuggestion(item); }}
                    onMouseEnter={() => setSqlSuggest(s => ({ ...s, index: i }))}
                    className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer ${
                      i === sqlSuggest.index
                        ? (editorTheme === 'dark' ? 'bg-jj-blue-03/40 text-white' : 'bg-jj-blue-03/10 text-jj-gray-08')
                        : (editorTheme === 'dark' ? 'text-white/80' : 'text-jj-gray-07')
                    }`}
                  >
                    <span className={`w-[13px] text-center text-[9px] font-bold rounded-sm flex-shrink-0 ${
                      item.kind === 'column' ? 'text-jj-green-03'
                      : item.kind === 'function' ? 'text-jj-orange-03'
                      : item.kind === 'schema' ? 'text-jj-blue-05'
                      : item.kind === 'table' || item.kind === 'view' ? 'text-jj-red'
                      : 'text-jj-blue-03'
                    }`}>{
                      item.kind === 'column' ? 'C'
                      : item.kind === 'function' ? 'f'
                      : item.kind === 'schema' ? 'S'
                      : item.kind === 'view' ? 'V'
                      : item.kind === 'table' ? 'T'
                      : 'K'
                    }</span>
                    <span className="whitespace-nowrap">{item.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2.5 px-[18px] py-2 border-t border-jj-gray-01 flex-wrap">
            <span className="text-[10.5px] font-johnson-text text-jj-gray-05">
              Full PostgreSQL supported · destructive statements ask for confirmation · ⌘/Ctrl+Enter runs · Tab/Enter accepts a suggestion
            </span>
          </div>
          <div className="flex items-center gap-2.5 px-[18px] py-3 border-t border-jj-gray-01 flex-wrap">
            <button
              onClick={runQuery}
              disabled={status === 'running' || status === 'starting' || !queryText.trim()}
              className={`flex items-center gap-[7px] px-[18px] py-2 rounded-full text-white text-xs font-johnson-text font-medium disabled:opacity-50 transition-colors ${
                leadHint ? 'bg-jj-maroon-05 hover:opacity-90' : 'bg-jj-blue-03 hover:bg-jj-blue-05'
              }`}
            >
              <Icon src={playIcon} tint="white" className="w-3 h-3" />
              {status === 'running' || status === 'starting' ? 'Running…' : leadHint ? `Run ${leadHint}` : 'Run query'}
              <span className="text-white/50 font-normal">⌘⏎</span>
            </button>
            {(status === 'running' || status === 'starting') && (
              <button onClick={cancelQuery} className="px-4 py-2 rounded-full border border-jj-gray-03 text-xs font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01">
                Cancel
              </button>
            )}
            {status === 'success' && meta && (
              <span className="inline-flex items-center gap-1.5 text-[11.5px] font-johnson-text text-jj-green-03 bg-jj-green-03/10 rounded-full px-3 py-1 tabular-nums">
                <span className="w-1.5 h-1.5 rounded-full bg-jj-green-03" />
                Success{meta.returns_rows
                  ? ` · ${rowCountIsEstimate ? '~' : ''}${(rowCount ?? 0).toLocaleString()} row${rowCount === 1 ? '' : 's'}`
                  : ` · ${(meta.rows_affected ?? 0).toLocaleString()} row${meta.rows_affected === 1 ? '' : 's'} affected`}
                {' · '}{(meta.elapsed_ms / 1000).toFixed(1)}s
              </span>
            )}
            {(status === 'running' || status === 'starting') && (
              <span className="inline-flex items-center gap-1.5 text-[11.5px] font-johnson-text text-jj-blue-03 bg-jj-blue-03/10 rounded-full px-3 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-jj-blue-03 animate-pulse" />
                {status === 'starting' ? 'Starting…' : 'Running in Postgres…'}
              </span>
            )}
            {status === 'cancelled' && (
              <span className="text-[11.5px] font-johnson-text text-jj-gray-06">Cancelled.</span>
            )}
            <span className="ml-auto flex items-center gap-2">
              {status === 'success' && meta?.returns_rows && (
                <button
                  onClick={toggleResultsFullscreen}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
                  title={isFullscreen ? 'Exit full screen' : 'View the results full screen'}
                >
                  {isFullscreen ? '⤳ Exit full screen' : '⛶ Full screen'}
                </button>
              )}
              {status === 'success' && meta?.returns_rows && jobId && rowCount > 0 && (
                <button onClick={downloadCsv} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01">
                  <Icon src={downloadIcon} className="w-3 h-3" />
                  Download CSV
                </button>
              )}
            </span>
          </div>
        </div>

        {/* Expander above the results table: drag to trade space between the
            editor and the table (down = bigger editor, up = bigger table);
            double-click resets. Same interaction as the SF Query Runner. */}
        <div
          onMouseDown={startEditorResize}
          onDoubleClick={() => { editorHeightTouchedRef.current = false; setEditorHeight(150); }}
          title="Drag to resize · double-click to reset"
          className="flex-shrink-0 h-[14px] cursor-row-resize flex items-center justify-center group"
        >
          <div className="w-14 h-[4px] rounded-full bg-jj-gray-03 group-hover:bg-jj-gray-05" />
        </div>

        <div ref={resultsCardRef} className="mt-0 flex-1 min-h-0 bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex flex-col overflow-hidden">
          <div className="flex-1 min-h-0 relative overflow-auto">
            {status === 'idle' && (
              <div className="px-3 py-8 text-center text-jj-gray-06 text-xs font-johnson-text">
                Write any PostgreSQL statement above and hit Run query. Destructive statements (INSERT/UPDATE/DELETE/DDL) ask for confirmation first.
              </div>
            )}
            {(status === 'starting' || (status === 'running' && !meta)) && (
              <div className="p-2">
                <ResultsSkeleton cols={5} rows={10} />
              </div>
            )}
            {status === 'failed' && error && (
              <div className="p-4">
                <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-red-50 border border-jj-maroon-05/40 text-xs font-johnson-text text-jj-maroon-05 whitespace-pre-wrap">
                  <Icon src={alertIcon} className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  {error}
                </div>
              </div>
            )}
            {status === 'cancelled' && (
              <div className="px-3 py-8 text-center text-jj-gray-06 text-xs font-johnson-text">Query cancelled.</div>
            )}
            {status === 'success' && meta && !meta.returns_rows && (
              <div className="px-3 py-8 text-center text-jj-gray-06 text-xs font-johnson-text">
                Statement executed successfully - {(meta.rows_affected ?? 0).toLocaleString()} row{meta.rows_affected === 1 ? '' : 's'} affected. Nothing to display.
              </div>
            )}
            {status === 'success' && meta && meta.returns_rows && pageLoading && pageRows.length === 0 && (
              <div className="p-2"><ResultsSkeleton cols={meta.columns?.length || 5} rows={10} /></div>
            )}
            {status === 'success' && meta && meta.returns_rows && (pageRows.length > 0 || (!pageLoading && meta)) && (
              <table className="text-xs font-johnson-text w-full" style={{ tableLayout: 'auto' }}>
                <thead className="sticky top-0 z-[5]">
                  <tr className="bg-[#faf9f8]">
                    {(meta.columns || []).map(col => (
                      <th
                        key={col}
                        onClick={() => handleSort(col)}
                        title="Sort by this column"
                        className="px-3 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-jj-gray-06 cursor-pointer select-none whitespace-nowrap border-b border-r border-jj-gray-02 hover:bg-jj-gray-02"
                      >
                        {col}{sort?.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r, idx) => (
                    <tr key={idx} className="hover:bg-jj-blue-03/5">
                      {r.map((v, i) => (
                        <td key={i} className="px-3 py-2.5 text-jj-gray-08 truncate max-w-[320px] border-b border-r border-jj-gray-01">
                          {v === null || v === undefined || v === '' ? <span className="italic text-jj-gray-05">null</span> : cellDisplayText(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {pageRows.length === 0 && !pageLoading && (
                    <tr>
                      <td colSpan={meta.columns?.length || 1} className="px-3 py-8 text-center text-jj-gray-06">
                        Query ran fine, no rows on this page.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>

          {status === 'success' && meta && meta.returns_rows && (
            <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-2.5 border-t border-jj-gray-01 flex-wrap gap-2">
              <div className="flex items-center gap-2 text-[11.5px] font-johnson-text text-jj-gray-06 tabular-nums">
                <Icon src={infoIcon} className="w-3.5 h-3.5" />
                {rowCountIsEstimate ? '~' : ''}{(rowCount ?? 0).toLocaleString()} row{rowCount === 1 ? '' : 's'}
                {rowCountIsEstimate && (
                  <button onClick={refineExactCount} disabled={refiningCount} className="text-jj-blue-03 underline disabled:opacity-50">
                    {refiningCount ? 'Counting…' : 'get exact count'}
                  </button>
                )}
                <select value={pageSize} onChange={e => changePageSize(Number(e.target.value))} disabled={pageLoading} className="ml-2 border border-jj-gray-03 rounded-lg px-2 py-1 font-johnson-text">
                  {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}/page</option>)}
                </select>
              </div>
              <Pager page={page} totalPages={totalPages} loading={pageLoading} onGo={goToPage} approximate={rowCountIsEstimate} />
            </div>
          )}
        </div>
      </div>

      <ConfirmDestructiveModal
        info={pendingConfirm}
        confirming={confirming}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => { const info = pendingConfirm; setPendingConfirm(null); confirmDestructive(info); }}
      />
    </div>
  );
}