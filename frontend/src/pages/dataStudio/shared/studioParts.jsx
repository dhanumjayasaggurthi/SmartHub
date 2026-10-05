import React, { useState, useEffect, useRef, useCallback } from 'react';
import { fetchJson, formatBytes, formatCount } from './studioHelpers';

import refreshIcon from "/icons/JJ_Icon_Refresh_RGB.svg";
import chevronDownIcon from "/icons/JJ_Icon_Chevron_Down.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import chevronLeftIcon from "/icons/JJ_Icon_Chevron_Left.svg";
import searchIcon from "/icons/JJ_Icon_Search_RGB.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import closeIcon from "/icons/JJ_Icon_Close.svg";
import sfIcon from "/icons/snowflake_badge.svg";

/* ==========================================================================
   Shared pieces for the Data Studio panes: icon tinting, the
   object explorer, the pager, skeletons and the modals.
   ========================================================================== */

// feColorMatrix repaints an icon based only on its shape and alpha, so the
// same J&J glyph works in red / ink / gray / white without four copies of it.
const IconDefs = () => (
  <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
    <filter id="jj-red-tint" colorInterpolationFilters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 0.9216  0 0 0 0 0.0902  0 0 0 0 0  0 0 0 1 0" />
    </filter>
    <filter id="jj-ink-tint" colorInterpolationFilters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 0.1020  0 0 0 0 0.1137  0 0 0 0 0.1294  0 0 0 1 0" />
    </filter>
    <filter id="jj-gray-tint" colorInterpolationFilters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 0.3608  0 0 0 0 0.4000  0 0 0 0 0.4392  0 0 0 1 0" />
    </filter>
    <filter id="jj-white-tint" colorInterpolationFilters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0" />
    </filter>
    <filter id="jj-blue-tint" colorInterpolationFilters="sRGB">
      <feColorMatrix type="matrix" values="0 0 0 0 0.0667  0 0 0 0 0.3373  0 0 0 0 0.4980  0 0 0 1 0" />
    </filter>
  </svg>
);

const TINTS = {
  red: 'url(#jj-red-tint)',
  ink: 'url(#jj-ink-tint)',
  gray: 'url(#jj-gray-tint)',
  white: 'url(#jj-white-tint)',
  blue: 'url(#jj-blue-tint)',
};

const Icon = ({ src, alt = '', className = 'w-4 h-4', tint = 'red' }) => (
  <img src={src} alt={alt} className={className} style={tint ? { filter: TINTS[tint] } : undefined} />
);

const CopyIcon = ({ className = 'w-3 h-3' }) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

/* ------------------------------ object marks ------------------------------ */

const ObjectMark = ({ kind }) => {
  const spec = {
    database: { label: 'DB', bg: '#11567f' },
    schema: { label: 'S', bg: '#7b3fe4' },
    table: { label: 'T', bg: '#29b5e8' },
    view: { label: 'V', bg: '#1f8f4e' },
  }[kind] || { label: 'T', bg: '#29b5e8' };
  return (
    <span
      className="flex-shrink-0 w-[15px] h-[15px] rounded-[3px] text-white text-[8.5px] font-bold flex items-center justify-center"
      style={{ background: spec.bg }}
      aria-hidden="true"
    >
      {spec.label}
    </span>
  );
};

/* ------------------------------- skeletons ------------------------------- */

const SkeletonLine = ({ w = '100%', h = 10 }) => (
  <div className="animate-pulse rounded bg-[#eceff2]" style={{ width: w, height: h }} />
);

const TreeRowSkeleton = ({ count = 3 }) => (
  <div className="py-1 space-y-1.5">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="flex items-center gap-2 px-2 py-1">
        <SkeletonLine w={`${60 + (i % 3) * 20}px`} h={9} />
      </div>
    ))}
  </div>
);

function ResultsSkeleton({ cols = 6, rows = 10 }) {
  return (
    <table className="w-full text-[12.5px] font-johnson-text">
      <thead>
        <tr className="bg-[#fbfcfd]">
          {Array.from({ length: cols }).map((_, i) => (
            <th key={i} className="px-3 py-2.5 border-b border-r border-[#dfe3e8]">
              <SkeletonLine w="70%" h={9} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }).map((_, r) => (
          <tr key={r}>
            {Array.from({ length: cols }).map((_, c) => (
              <td key={c} className="px-3 py-2.5 border-b border-r border-[#eceff2]">
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
  const btn = 'h-[24px] min-w-[24px] px-1.5 flex items-center justify-center rounded border border-[#dfe3e8] bg-white text-[11.5px] disabled:opacity-40 hover:bg-[#f5f7f9]';
  return (
    <div className="flex items-center gap-1.5">
      <button onClick={() => onGo(1)} disabled={page <= 1 || loading} className={btn} title="First page">
        <Icon src={chevronLeftIcon} className="w-2 h-2" tint="gray" alt="First page" />
      </button>
      <button onClick={() => onGo(page - 1)} disabled={page <= 1 || loading} className={`${btn} px-2`} title="Previous page">Prev</button>
      <span className="flex items-center gap-1.5 text-[11.5px] text-[#5c6670] tabular-nums">
        <input
          type="number"
          min="1"
          value={draft}
          disabled={loading}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); e.target.blur(); } }}
          className="w-[58px] h-[24px] border border-[#dfe3e8] rounded px-1.5 text-center tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          aria-label="Go to page"
        />
        of {approximate ? '~' : ''}{(totalPages || 1).toLocaleString()}
      </span>
      <button onClick={() => onGo(page + 1)} disabled={loading || page >= totalPages} className={`${btn} px-2`} title="Next page">Next</button>
      <button onClick={() => onGo(totalPages)} disabled={page >= totalPages || loading} className={btn} title="Last page">
        <Icon src={chevronRightIcon} className="w-2 h-2" tint="gray" alt="Last page" />
      </button>
    </div>
  );
}

/* ----------------------------- explorer tree ----------------------------- */

// A missing grant is a normal state, not a fault — render it as a quiet line
// rather than a paragraph of red the person can do nothing about.
const NodeError = ({ error, onRetry }) => {
  if (error?.status === 403) {
    return <div className="px-2 py-1 text-[11px] italic text-[#8a949e]">No access with this role</div>;
  }
  return (
    <div className="px-2 py-1">
      <div className="text-[11px] text-[#c02b2b] line-clamp-3" title={error?.message}>{error?.message}</div>
      {onRetry && <button onClick={onRetry} className="text-[11px] text-[#11567f] underline">Retry</button>}
    </div>
  );
};

function ExplorerTree({ onInsert, onPreview, onEditData, onShowDdl, onCollapse, logInPage }) {
  const [databases, setDatabases] = useState(null); // null = loading, [] = loaded and empty
  const [dbError, setDbError] = useState(null);
  const [search, setSearch] = useState('');
  const [expandedDb, setExpandedDb] = useState(null);
  const [expandedSchema, setExpandedSchema] = useState(null); // `${db}.${schema}`
  const [expandedTable, setExpandedTable] = useState(null);   // `${db}.${schema}.${table}`
  const schemasRef = useRef({});
  const tablesRef = useRef({});
  const columnsRef = useRef({});
  const [, forceTick] = useState(0);
  const rerender = useCallback(() => forceTick(t => t + 1), []);

  const loadDatabases = useCallback((bypassCache = false) => {
    setDatabases(null);
    setDbError(null);
    fetchJson(`/api/snowflake/databases${bypassCache ? '?bypass_cache=true' : ''}`)
      .then(data => setDatabases(data.databases || []))
      .catch(err => setDbError(err));
  }, []);

  useEffect(() => { loadDatabases(); }, [loadDatabases]);

  const toggleDb = (db) => {
    if (expandedDb === db) { setExpandedDb(null); return; }
    setExpandedDb(db);
    logInPage?.('sf_explorer_expand', `Expanded Snowflake database "${db}"`);
    if (schemasRef.current[db] === undefined) {
      schemasRef.current[db] = 'loading';
      rerender();
      fetchJson(`/api/snowflake/schemas?database=${encodeURIComponent(db)}`)
        .then(data => { schemasRef.current[db] = data.schemas || []; rerender(); })
        .catch(err => { schemasRef.current[db] = err; rerender(); });
    }
  };

  const toggleSchema = (db, schema) => {
    const key = `${db}.${schema}`;
    if (expandedSchema === key) { setExpandedSchema(null); return; }
    setExpandedSchema(key);
    logInPage?.('sf_explorer_expand', `Expanded Snowflake schema "${key}"`);
    if (tablesRef.current[key] === undefined) {
      tablesRef.current[key] = 'loading';
      rerender();
      fetchJson(`/api/snowflake/tables?database=${encodeURIComponent(db)}&schema=${encodeURIComponent(schema)}`)
        .then(data => { tablesRef.current[key] = data.tables || []; rerender(); })
        .catch(err => { tablesRef.current[key] = err; rerender(); });
    }
  };

  const toggleTable = (db, schema, table) => {
    const key = `${db}.${schema}.${table}`;
    if (expandedTable === key) { setExpandedTable(null); return; }
    setExpandedTable(key);
    if (columnsRef.current[key] === undefined) {
      columnsRef.current[key] = 'loading';
      rerender();
      fetchJson(`/api/snowflake/columns?database=${encodeURIComponent(db)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`)
        .then(data => { columnsRef.current[key] = data.columns || []; rerender(); })
        .catch(err => { columnsRef.current[key] = err; rerender(); });
    }
  };

  const matchesSearch = (name) => !search || name.toLowerCase().includes(search.toLowerCase());
  const rowBtn = 'w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#f5f7f9] text-left';
  const chip = 'flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-[#dfe3e8] text-[#5c6670] bg-white hover:bg-[#f5f7f9]';

  return (
    <div className="flex flex-col h-full min-h-0 bg-white">
      <div className="flex-shrink-0 flex items-center gap-2 h-[48px] px-3 border-b border-[#dfe3e8]">
        <Icon src={sfIcon} className="w-4 h-4 flex-shrink-0" tint={null} />
        <div className="text-[12.5px] font-medium text-[#1a1d21]">Database objects</div>
        <div className="ml-auto flex items-center gap-0.5">
          <button onClick={() => loadDatabases(true)} title="Refresh databases" className="w-[24px] h-[24px] flex items-center justify-center rounded hover:bg-[#f5f7f9]">
            <Icon src={refreshIcon} className="w-3 h-3" tint="gray" alt="Refresh databases" />
          </button>
          <button onClick={onCollapse} title="Hide the explorer" className="w-[24px] h-[24px] flex items-center justify-center rounded hover:bg-[#f5f7f9]">
            <Icon src={chevronLeftIcon} className="w-2.5 h-2.5" tint="gray" alt="Hide the explorer" />
          </button>
        </div>
      </div>

      <div className="flex-shrink-0 px-2.5 py-2">
        <div className="flex items-center gap-2 h-[29px] px-2.5 border border-[#dfe3e8] rounded focus-within:border-[#29b5e8]">
          <Icon src={searchIcon} className="w-3 h-3 flex-shrink-0" tint="gray" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search objects"
            className="flex-1 min-w-0 bg-transparent text-[12.5px] font-johnson-text focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-3 text-[12.5px] font-johnson-text">
        {databases === null && !dbError && <TreeRowSkeleton count={5} />}
        {dbError && <NodeError error={dbError} onRetry={() => loadDatabases(true)} />}
        {databases && databases.length === 0 && (
          <div className="p-2.5 text-[11.5px] text-[#8a949e]">No databases visible to this role.</div>
        )}
        {databases && databases.filter(matchesSearch).map(db => (
          <div key={db}>
            <button onClick={() => toggleDb(db)} className={`${rowBtn} font-medium`}>
              <Icon src={expandedDb === db ? chevronDownIcon : chevronRightIcon} className="w-2.5 h-2.5 flex-shrink-0" tint="gray" />
              <ObjectMark kind="database" />
              <span className="truncate text-[#1a1d21]">{db}</span>
            </button>

            {expandedDb === db && (
              <div className="pl-3.5">
                {schemasRef.current[db] === 'loading' && <TreeRowSkeleton count={3} />}
                {schemasRef.current[db] instanceof Error && <NodeError error={schemasRef.current[db]} />}
                {Array.isArray(schemasRef.current[db]) && schemasRef.current[db].length === 0 && (
                  <div className="px-2 py-1 text-[11.5px] text-[#8a949e]">No schemas.</div>
                )}
                {Array.isArray(schemasRef.current[db]) && schemasRef.current[db].map(schema => {
                  const schemaKey = `${db}.${schema}`;
                  return (
                    <div key={schema}>
                      <button onClick={() => toggleSchema(db, schema)} className={rowBtn}>
                        <Icon src={expandedSchema === schemaKey ? chevronDownIcon : chevronRightIcon} className="w-2.5 h-2.5 flex-shrink-0" tint="gray" />
                        <ObjectMark kind="schema" />
                        <span className="truncate text-[#1a1d21]">{schema}</span>
                      </button>

                      {expandedSchema === schemaKey && (
                        <div className="pl-3.5">
                          {tablesRef.current[schemaKey] === 'loading' && <TreeRowSkeleton count={4} />}
                          {tablesRef.current[schemaKey] instanceof Error && <NodeError error={tablesRef.current[schemaKey]} />}
                          {Array.isArray(tablesRef.current[schemaKey]) && tablesRef.current[schemaKey].length === 0 && (
                            <div className="px-2 py-1 text-[11.5px] text-[#8a949e]">No tables.</div>
                          )}
                          {Array.isArray(tablesRef.current[schemaKey]) && tablesRef.current[schemaKey].filter(t => matchesSearch(t.name)).map(t => {
                            const tableKey = `${schemaKey}.${t.name}`;
                            const isView = t.kind === 'view' || t.kind === 'materialized_view';
                            return (
                              <div key={t.name}>
                                <div className="group w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#f5f7f9]">
                                  <button onClick={() => toggleTable(db, schema, t.name)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                                    <Icon src={expandedTable === tableKey ? chevronDownIcon : chevronRightIcon} className="w-2.5 h-2.5 flex-shrink-0" tint="gray" />
                                    <ObjectMark kind={isView ? 'view' : 'table'} />
                                    <span className="truncate text-[#1a1d21]">{t.name}</span>
                                    <span className="flex-shrink-0 text-[10px] text-[#8a949e] tabular-nums">
                                      {formatCount(t.est_rows)}
                                    </span>
                                  </button>
                                  <button onClick={() => onPreview(db, schema, t.name)} title="Preview 100 rows" className={`opacity-0 group-hover:opacity-100 ${chip}`}>
                                    Preview
                                  </button>
                                  {!isView && (
                                    <button onClick={() => onEditData(db, schema, t.name)} title="Open the editable data grid" className={`opacity-0 group-hover:opacity-100 ${chip}`}>
                                      Edit
                                    </button>
                                  )}
                                  <button onClick={() => onShowDdl(db, schema, t.name, isView ? 'VIEW' : 'TABLE')} title="Show DDL" className={`opacity-0 group-hover:opacity-100 ${chip}`}>
                                    DDL
                                  </button>
                                </div>
                                {t.size_bytes != null && (
                                  <div className="pl-[38px] pb-0.5 text-[10px] text-[#8a949e]">{formatBytes(t.size_bytes)}</div>
                                )}
                                {expandedTable === tableKey && (
                                  <div className="pl-3.5">
                                    {columnsRef.current[tableKey] === 'loading' && <TreeRowSkeleton count={5} />}
                                    {columnsRef.current[tableKey] instanceof Error && <NodeError error={columnsRef.current[tableKey]} />}
                                    {Array.isArray(columnsRef.current[tableKey]) && columnsRef.current[tableKey].map(col => (
                                      <button
                                        key={col.name}
                                        onClick={() => onInsert(col.name)}
                                        title={`${col.data_type}${col.nullable ? '' : ' · NOT NULL'}${col.is_primary_key ? ' · PK' : ''} — click to insert`}
                                        className="w-full flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-[#f5f7f9] text-left"
                                      >
                                        {col.is_primary_key && <span className="text-[9px] text-[#b8730d] font-bold flex-shrink-0">PK</span>}
                                        <span className="truncate text-[#5c6670]">{col.name}</span>
                                        <span className="ml-auto flex-shrink-0 text-[9.5px] text-[#8a949e]">{col.data_type}</span>
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

/* ------------------------------- modals ---------------------------------- */

function ConfirmDestructiveModal({ info, onCancel, onConfirm, confirming }) {
  if (!info) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-9 h-9 rounded-full bg-[#fcf1f1] flex items-center justify-center">
            <Icon src={alertIcon} className="w-4 h-4" tint={null} />
          </div>
          <div className="min-w-0">
            <h3 className="font-johnson-display font-bold text-[15px] text-[#1a1d21]">
              Confirm {info.statement_type} statement
            </h3>
            <p className="mt-1 text-[12.5px] font-johnson-text text-[#5c6670]">{info.message}</p>
            {info.warning && (
              <p className="mt-2 text-[12.5px] font-johnson-text text-[#c02b2b] bg-[#fcf1f1] border border-[#f0d2d2] rounded px-2.5 py-2">
                {info.warning}
              </p>
            )}
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2.5">
          <button onClick={onCancel} className="px-4 py-2 rounded border border-[#dfe3e8] text-[12.5px] font-johnson-text hover:bg-[#f5f7f9]">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={confirming}
            className="px-4 py-2 rounded bg-[#9e0000] text-white text-[12.5px] font-johnson-text font-medium hover:opacity-90 disabled:opacity-50"
          >
            {confirming ? 'Running…' : `Run ${info.statement_type}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function TextModal({ title, body, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!title) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#dfe3e8]">
          <h3 className="font-johnson-display font-bold text-[14px] text-[#1a1d21] truncate">{title}</h3>
          <div className="flex items-center gap-2">
            <button onClick={copy} className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#dfe3e8] text-[11px] font-johnson-text text-[#5c6670] hover:bg-[#f5f7f9]">
              <CopyIcon />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={onClose} className="p-1 rounded hover:bg-[#f5f7f9]">
              <Icon src={closeIcon} className="w-3 h-3" tint="gray" alt="Close" />
            </button>
          </div>
        </div>
        <pre className="flex-1 overflow-auto px-5 py-4 text-[11.5px] font-mono text-[#1a1d21] whitespace-pre-wrap break-words">
          {body}
        </pre>
      </div>
    </div>
  );
}

function SavePromptModal({ open, initialName, onCancel, onSave }) {
  const [name, setName] = useState(initialName || '');
  const [shared, setShared] = useState(false);
  useEffect(() => { if (open) { setName(initialName || ''); setShared(false); } }, [open, initialName]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-5">
        <h3 className="font-johnson-display font-bold text-[15px] text-[#1a1d21]">Save this query</h3>
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onSave(name.trim(), shared); }}
          placeholder="Name it something you'll recognise"
          className="mt-3 w-full border border-[#dfe3e8] rounded px-3 py-2 text-[12.5px] font-johnson-text focus:outline-none focus:border-[#29b5e8]"
        />
        <label className="mt-3 flex items-center gap-2 text-[12px] font-johnson-text text-[#5c6670]">
          <input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} />
          Share with everyone who can use this page
        </label>
        <div className="mt-5 flex items-center justify-end gap-2.5">
          <button onClick={onCancel} className="px-4 py-2 rounded border border-[#dfe3e8] text-[12.5px] font-johnson-text hover:bg-[#f5f7f9]">
            Cancel
          </button>
          <button
            onClick={() => onSave(name.trim(), shared)}
            disabled={!name.trim()}
            className="px-4 py-2 rounded bg-[#11567f] text-white text-[12.5px] font-johnson-text font-medium hover:bg-[#0d4363] disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export {
  IconDefs, Icon, TINTS, CopyIcon, ObjectMark, Pager, ExplorerTree,
  ConfirmDestructiveModal, TextModal, SavePromptModal,
  ResultsSkeleton, SkeletonLine, TreeRowSkeleton,
};