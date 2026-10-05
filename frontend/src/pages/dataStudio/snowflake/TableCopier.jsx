import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { fetchJson } from '../shared/studioHelpers';
import { apiEventSource } from '../../../utils/apiClient';
import { IconDefs, Icon } from '../shared/studioParts';

import playIcon from "/icons/JJ_Icon_Video_Play_RGB.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import chevronDownIcon from "/icons/JJ_Icon_Chevron_Down.svg";
import sfIcon from "/icons/snowflake_badge.svg";

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
  greenSoft: '#e9f6ee',
  red: '#c02b2b',
  redSoft: '#fcf1f1',
  amber: '#b8730d',
  amberSoft: '#fdf3e3',
};

// Sentinel for the "not in the list yet" entry of the target schema picker.
const NEW_SCHEMA = '__new_schema__';

const STATUS_DOT = {
  pending: C.faint,
  running: C.accent,
  success: C.green,
  failed: C.red,
};

const LOG_COLOR = {
  info: C.muted,
  success: C.green,
  warn: C.amber,
  error: C.red,
};

function fmtElapsed(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${String(rem).padStart(2, '0')}s`;
}

function fmtN(n) {
  return (n ?? 0).toLocaleString();
}

/* ------------------------------ small pieces ------------------------------ */

const Field = ({ label, children, hint }) => (
  <label className="flex flex-col gap-1">
    <span className="text-[11px] font-medium text-[#5c6670] uppercase tracking-wide">{label}</span>
    {children}
    {hint && <span className="text-[11px] text-[#8a949e]">{hint}</span>}
  </label>
);

const Select = ({ value, onChange, options, placeholder, disabled }) => (
  <div className="relative">
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      className="w-full h-[32px] pl-2.5 pr-7 rounded border border-[#dfe3e8] bg-white text-[12.5px] appearance-none disabled:bg-[#f5f7f9] disabled:text-[#8a949e]"
    >
      <option value="">{placeholder}</option>
      {options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return <option key={opt.value} value={opt.value}>{opt.label}</option>;
      })}
    </select>
    <Icon src={chevronDownIcon} className="w-2.5 h-2.5 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" tint="gray" />
  </div>
);

const Pill = ({ active, onClick, children, disabled }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`h-[30px] px-3 rounded text-[12.5px] border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
      active ? 'border-[#11567f] bg-[#e3f2fa] text-[#11567f] font-medium' : 'border-[#dfe3e8] hover:bg-[#f5f7f9]'
    }`}
  >
    {children}
  </button>
);

const Badge = ({ status }) => {
  const label = { pending: 'queued', running: 'copying', success: 'done', failed: 'failed' }[status] || status;
  const bg = { pending: C.panel, running: C.accentSoft, success: C.greenSoft, failed: C.redSoft }[status] || C.panel;
  const fg = { pending: C.muted, running: C.primary, success: C.green, failed: C.red }[status] || C.muted;
  return (
    <span className="inline-flex items-center gap-1.5 h-[20px] px-2 rounded text-[10.5px] font-medium" style={{ background: bg, color: fg }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_DOT[status] || C.faint }} />
      {label}
    </span>
  );
};

const ProgressBar = ({ pct, tone = C.primary }) => (
  <div className="h-[6px] rounded-full bg-[#eceff2] overflow-hidden">
    <div
      className="h-full rounded-full transition-all duration-300"
      style={{ width: `${Math.max(pct == null ? 0 : pct, pct === 0 ? 0 : 2)}%`, background: tone }}
    />
  </div>
);

/* --------------------------------- main ----------------------------------- */

export default function TableCopier({ serverInfo }) {
  // Where writes go through a second Snowflake login, the target side of the
  // form has to be browsed with those credentials - the two logins do not see
  // the same databases, which is the whole reason for the split.
  const writeProfile = serverInfo?.write_profile?.configured ? serverInfo.write_profile : null;
  const targetProfile = writeProfile ? 'write' : 'read';
  const credLabel = (p) => (p?.user ? `${p.user}${p.role ? ` / ${p.role}` : ''}` : null);
  const readLabel = credLabel(serverInfo);
  const writeLabel = credLabel(writeProfile);

  // catalogue caches, keyed by profile:database / profile:database:schema
  const [databases, setDatabases] = useState([]);
  const [targetDatabases, setTargetDatabases] = useState([]);
  const [schemaCache, setSchemaCache] = useState({});
  const [tableCache, setTableCache] = useState({});

  const [form, setForm] = useState({
    copyType: 'table',        // table | tables | schema
    mode: 'clone',            // clone | insert
    ifExists: 'fail',         // fail | overwrite | append
    sourceDatabase: '', sourceSchema: '', sourceTable: '', sourceTables: [],
    targetDatabase: '', targetSchema: '', targetTable: '',
    parallelism: '',
  });

  const [customSchema, setCustomSchema] = useState(false);
  const [objectFilter, setObjectFilter] = useState('');
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [formError, setFormError] = useState(null);
  const [errorCode, setErrorCode] = useState(null);

  const [plan, setPlan] = useState(null);        // preview payload, pre-confirm
  const [planning, setPlanning] = useState(false);
  // Names ticked off in the preview. The plan is the last chance to drop the
  // handful of tables nobody wants without going back and picking 70 by hand.
  const [excluded, setExcluded] = useState(() => new Set());

  const [job, setJob] = useState(null);           // live/completed job status payload
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const pollRef = useRef(null);
  const streamRef = useRef(null);
  const sinceLogRef = useRef(0);
  const logBoxRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingDbs(true);
    const load = (profile) => fetchJson(`/api/snowflake/databases?profile=${profile}`).then(d => d.databases || []);
    Promise.all([load('read'), targetProfile === 'write' ? load('write') : null])
      .then(([read, write]) => {
        if (cancelled) return;
        setDatabases(read);
        setTargetDatabases(write || read);
      })
      .catch(e => { if (!cancelled) setFormError(e.message); })
      .finally(() => { if (!cancelled) setLoadingDbs(false); });
    return () => { cancelled = true; };
  }, [targetProfile]);

  const loadSchemas = useCallback((db, profile = 'read') => {
    const key = `${profile}:${db}`;
    if (!db || schemaCache[key]) return;
    fetchJson(`/api/snowflake/schemas?database=${encodeURIComponent(db)}&profile=${profile}`)
      .then(d => setSchemaCache(prev => ({ ...prev, [key]: d.schemas || [] })))
      .catch(() => setSchemaCache(prev => ({ ...prev, [key]: [] })));
  }, [schemaCache]);

  const loadTables = useCallback((db, schema, profile = 'read') => {
    const key = `${profile}:${db}:${schema}`;
    if (!db || !schema || tableCache[key]) return;
    fetchJson(`/api/snowflake/tables?database=${encodeURIComponent(db)}&schema=${encodeURIComponent(schema)}&profile=${profile}`)
      .then(d => setTableCache(prev => ({
        ...prev,
        // Views are copyable too - they land as a table built from what they
        // return. External tables are not, so those stay out.
        [key]: (d.tables || []).filter(t => t.kind !== 'external_table'),
      })))
      .catch(() => setTableCache(prev => ({ ...prev, [key]: [] })));
  }, [tableCache]);

  const set = (patch) => setForm(f => ({ ...f, ...patch }));

  // reset any live plan/job once the form changes underneath it
  const clearPlan = () => { setPlan(null); setExcluded(new Set()); setFormError(null); setErrorCode(null); };

  /* ------------------------------- polling -------------------------------- */

  const stopPolling = () => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    if (streamRef.current) { streamRef.current.close(); streamRef.current = null; }
  };

  // Merge a frame into whatever is on screen. Log lines arrive once and are
  // appended; everything else is the job's current state and replaces it.
  const applyFrame = useCallback((jobId, patch, newLogs) => {
    setJob(prev => {
      if (prev && prev.job_id !== jobId) return prev;
      const base = prev || { job_id: jobId, logs: [] };
      return {
        ...base,
        ...patch,
        logs: newLogs?.length ? [...(base.logs || []), ...newLogs] : (base.logs || []),
      };
    });
  }, []);

  const pollOnce = useCallback(async (jobId) => {
    try {
      const data = await fetchJson(
        `/api/snowflake/copy/${jobId}/status?wait_ms=4000&since_log=${sinceLogRef.current}`,
      );
      sinceLogRef.current = data.log_count;
      const { logs, ...rest } = data;
      applyFrame(jobId, rest, logs);
      if (data.status === 'running') {
        pollRef.current = setTimeout(() => pollOnce(jobId), 300);
      }
    } catch (e) {
      setJob(prev => (prev ? { ...prev, status: 'failed', errorNote: e.message } : prev));
    }
  }, [applyFrame]);

  /**
   * Follow the job over SSE so a log line shows up when it is written rather
   * than at the next poll. Anything that stops the stream - a proxy that will
   * not hold it open, a dropped connection - falls back to polling, which is
   * slower to update but works anywhere.
   */
  const watchJob = useCallback((jobId) => {
    stopPolling();
    let streamed = false;

    const fallback = (why) => {
      if (streamRef.current) { streamRef.current.close(); streamRef.current = null; }
      if (why) console.info('Copy stream unavailable, polling instead:', why);
      pollRef.current = setTimeout(() => pollOnce(jobId), 200);
    };

    const stream = apiEventSource(
      `/api/snowflake/copy/${jobId}/stream?since_log=${sinceLogRef.current}`,
    );
    streamRef.current = stream;

    stream.addEventListener('logs', (e) => {
      streamed = true;
      const data = JSON.parse(e.data);
      sinceLogRef.current = data.log_count;
      applyFrame(jobId, { log_count: data.log_count }, data.logs);
    });

    stream.addEventListener('progress', (e) => {
      streamed = true;
      applyFrame(jobId, JSON.parse(e.data), null);
    });

    stream.addEventListener('done', () => {
      if (streamRef.current === stream) {
        stream.close();
        streamRef.current = null;
      }
    });

    stream.addEventListener('error', (err) => {
      // Once frames have arrived the job is being followed properly; an error
      // after that is the stream ending, not a stream that never worked.
      if (!streamed) fallback(err?.message || 'no data');
      else if (streamRef.current === stream) { stream.close(); streamRef.current = null; }
    });
  }, [applyFrame, pollOnce]);

  useEffect(() => () => stopPolling(), []);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [job?.logs?.length]);

  /* --------------------------------- actions ------------------------------- */

  const buildBody = (confirm, overrides = {}) => ({
    copy_type: form.copyType,
    mode: overrides.mode || form.mode,
    if_exists: form.ifExists,
    source_database: form.sourceDatabase,
    source_schema: form.sourceSchema,
    source_table: form.copyType === 'table' ? form.sourceTable : null,
    source_tables: form.copyType === 'tables' ? form.sourceTables : null,
    target_database: form.targetDatabase,
    target_schema: form.targetSchema,
    target_table: form.copyType === 'table' ? (form.targetTable || form.sourceTable) : null,
    parallelism: form.parallelism ? Number(form.parallelism) : null,
    confirm,
  });

  const validate = () => {
    if (!form.sourceDatabase || !form.sourceSchema) return 'Pick a source database and schema.';
    if (form.copyType === 'table' && !form.sourceTable) return 'Pick a source table.';
    if (form.copyType === 'tables' && form.sourceTables.length === 0) return 'Pick at least one table or view.';
    if (!form.targetDatabase || !form.targetSchema) return 'Pick a target database and schema.';
    return null;
  };

  const runPreview = async (overrides = {}) => {
    const err = validate();
    if (err) { setFormError(err); setErrorCode(null); return; }
    setFormError(null);
    setErrorCode(null);
    setPlanning(true);
    try {
      const data = await fetchJson('/api/snowflake/copy/start',
        { method: 'POST', body: buildBody(false, overrides) });
      setExcluded(new Set());
      setPlan(data);
    } catch (e) {
      setFormError(e.message);
      setErrorCode(e.body?.detail?.code || null);
    } finally {
      setPlanning(false);
    }
  };

  const startCopy = async () => {
    setStarting(true);
    setFormError(null);
    try {
      const body = buildBody(true);
      // Dropping anything turns the job into a copy of exactly what is left,
      // whatever it started life as.
      if (excluded.size) {
        body.copy_type = 'tables';
        body.source_tables = keptItems.map(i => i.name);
        body.source_table = null;
        body.target_table = null;
      }
      const data = await fetchJson('/api/snowflake/copy/start', { method: 'POST', body });
      sinceLogRef.current = 0;
      setJob({
        job_id: data.job_id, status: 'running', copy_type: form.copyType, mode: form.mode,
        source: plan?.source, target: plan?.target,
        tables_total: data.tables_total, tables_done: 0, tables_failed: 0,
        rows_copied: 0, est_rows_total: keptRows, percent: 0,
        elapsed_ms: 0, tables: [], logs: [],
      });
      setPlan(null);
      watchJob(data.job_id);
    } catch (e) {
      setFormError(e.message);
    } finally {
      setStarting(false);
    }
  };

  const cancelCopy = async () => {
    if (!job) return;
    setCancelling(true);
    try {
      await fetchJson(`/api/snowflake/copy/${job.job_id}/cancel`, { method: 'POST' });
    } catch (e) {
      setFormError(e.message);
    } finally {
      setCancelling(false);
    }
  };

  const resetAll = () => {
    stopPolling();
    setJob(null);
    setPlan(null);
    setFormError(null);
  };

  /* --------------------------------- render -------------------------------- */

  const planItems = plan?.items || [];
  const canExclude = planItems.length > 1 && !planItems.some(i => i.detail);
  const keptItems = canExclude ? planItems.filter(i => !excluded.has(i.name)) : planItems;
  const keptRows = keptItems.reduce((sum, i) => sum + (i.est_rows || 0), 0);

  const busy = job && job.status === 'running';
  const finished = job && job.status !== 'running';

  const sourceSchemas = schemaCache[`read:${form.sourceDatabase}`] || [];
  const targetSchemas = schemaCache[`${targetProfile}:${form.targetDatabase}`] || [];
  const sourceObjects = tableCache[`read:${form.sourceDatabase}:${form.sourceSchema}`] || [];
  const sourceTables = sourceObjects.map(t => ({
    value: t.name,
    label: t.kind === 'view' ? `${t.name}  (view)`
      : t.kind === 'materialized_view' ? `${t.name}  (materialized view)`
        : t.name,
  }));
  const sourceIsView = ['view', 'materialized_view'].includes(
    sourceObjects.find(t => t.name === form.sourceTable)?.kind,
  );
  const filteredObjects = useMemo(() => {
    const needle = objectFilter.trim().toLowerCase();
    return needle ? sourceObjects.filter(t => t.name.toLowerCase().includes(needle)) : sourceObjects;
  }, [sourceObjects, objectFilter]);
  // A mixed selection copies each object the right way; all-views changes what
  // the mode pills mean, same as picking a single view does.
  const selectedObjects = sourceObjects.filter(t => form.sourceTables.includes(t.name));
  const allSelectedAreViews = selectedObjects.length > 0
    && selectedObjects.every(t => t.kind === 'view' || t.kind === 'materialized_view');
  const viewWording = form.copyType === 'tables' ? allSelectedAreViews : sourceIsView;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-white text-[#1a1d21] font-johnson-text">
      <IconDefs />

      <div className="flex-shrink-0 flex items-center gap-2.5 h-[48px] px-4 border-b border-[#dfe3e8]">
        <Icon src={sfIcon} className="w-4 h-4" tint={null} />
        <span className="text-[14px] font-medium tracking-[-.01em]">Table &amp; Schema Copier</span>
        {serverInfo?.allow_writes === false && (
          <span className="text-[11px] text-[#b8730d] bg-[#fdf3e3] rounded px-2 py-0.5">read-only deployment</span>
        )}
        {writeLabel && (
          <span
            className="text-[11px] text-[#11567f] bg-[#e3f2fa] rounded px-2 py-0.5 truncate"
            title={`Reads use ${readLabel}, writes use ${writeLabel}`}
          >
            two logins: {readLabel} → {writeLabel}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {!job && (
          <div className="max-w-3xl flex flex-col gap-5">
            {/* copy type + mode */}
            <div className="flex flex-wrap gap-6">
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-[#5c6670] uppercase tracking-wide">What to copy</span>
                <div className="flex gap-2">
                  <Pill active={form.copyType === 'table'} onClick={() => { set({ copyType: 'table' }); clearPlan(); }}>One object</Pill>
                  <Pill active={form.copyType === 'tables'} onClick={() => { set({ copyType: 'tables' }); clearPlan(); }}>Several</Pill>
                  <Pill active={form.copyType === 'schema'} onClick={() => { set({ copyType: 'schema' }); clearPlan(); }}>Whole schema</Pill>
                </div>
                {form.copyType === 'schema' && (
                  <span className="text-[11px] text-[#8a949e]">Tables and views, everything in the schema.</span>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-[#5c6670] uppercase tracking-wide">How</span>
                <div className="flex gap-2">
                  <Pill
                    active={form.mode === 'clone'}
                    onClick={() => { set({ mode: 'clone', ifExists: form.ifExists === 'append' ? 'fail' : form.ifExists }); clearPlan(); }}
                  >
                    {viewWording ? 'Recreate as view' : 'Clone (instant)'}
                  </Pill>
                  <Pill active={form.mode === 'insert'} onClick={() => { set({ mode: 'insert' }); clearPlan(); }}>
                    {viewWording ? 'Copy rows into a table' : 'Copy rows (parallel)'}
                  </Pill>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-[#5c6670] uppercase tracking-wide">If the target exists</span>
                <div className="flex gap-2">
                  <Pill active={form.ifExists === 'fail'} onClick={() => { set({ ifExists: 'fail' }); clearPlan(); }}>Stop</Pill>
                  <Pill active={form.ifExists === 'overwrite'} onClick={() => { set({ ifExists: 'overwrite' }); clearPlan(); }}>Overwrite</Pill>
                  <Pill active={form.ifExists === 'append'} disabled={form.mode === 'clone'} onClick={() => { set({ ifExists: 'append' }); clearPlan(); }}>Append rows</Pill>
                </div>
              </div>
            </div>

            <div className="text-[12px] text-[#5c6670] bg-[#fbfcfd] border border-[#eceff2] rounded p-3">
              {viewWording
                ? (form.mode === 'clone'
                  ? 'The view is recreated in the target schema from its own DDL, with every reference to the source schema re-pointed at the target one. No rows move — whatever it selects from has to already exist in the target schema, and if it does not, Snowflake says so and the job reports that error.'
                  : 'The view is run once and what it returns is written out as an ordinary table. A snapshot: it will not follow the view, and it does not inherit the view\'s secure or masking properties.')
                : (form.mode === 'clone'
                  ? 'Clone is a zero-copy CREATE ... CLONE — it finishes in a couple of seconds no matter how many rows are in the source, because Snowflake links the new object to the same micro-partitions instead of moving data.'
                  : 'Copy rows actually moves data with INSERT ... SELECT. Large tables are split into chunks by hash and copied in parallel across pooled connections, so this is the mode to use for appending into an existing table.')}
              <div className="mt-2 pt-2 border-t border-[#eceff2]">
                These two choices are about tables. Any view in the selection is recreated as a view either
                way, with its references re-pointed at the target schema — pick a view on its own if you want
                it written out as a table instead.
              </div>
              {writeLabel && (
                <div className="mt-2 pt-2 border-t border-[#eceff2]">
                  Writes here run as <span className="font-medium">{writeLabel}</span>. Where that login can also read
                  the source, Snowflake does the copy internally as usual. Where it cannot, the preview says so and the
                  rows are carried across by the portal instead — which rules out clone, since a clone needs one role
                  that can see both sides.
                </div>
              )}
            </div>

            {/* source / target pickers */}
            <div className="grid grid-cols-2 gap-5">
              <div className="flex flex-col gap-3 p-3.5 border border-[#dfe3e8] rounded-lg">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12px] font-semibold text-[#1a1d21]">Source</span>
                  {writeLabel && readLabel && (
                    <span className="text-[10.5px] text-[#8a949e] truncate" title={`Browsed and read as ${readLabel}`}>
                      read as {readLabel}
                    </span>
                  )}
                </div>
                <Field label="Database">
                  <Select
                    value={form.sourceDatabase}
                    options={databases}
                    placeholder={loadingDbs ? 'Loading…' : 'Choose a database'}
                    onChange={v => { set({ sourceDatabase: v, sourceSchema: '', sourceTable: '' }); clearPlan(); loadSchemas(v, 'read'); }}
                  />
                </Field>
                <Field label="Schema">
                  <Select
                    value={form.sourceSchema}
                    options={sourceSchemas}
                    placeholder="Choose a schema"
                    disabled={!form.sourceDatabase}
                    onChange={v => {
                      setObjectFilter('');
                      set({ sourceSchema: v, sourceTable: '', sourceTables: [] });
                      clearPlan();
                      loadTables(form.sourceDatabase, v, 'read');
                    }}
                  />
                </Field>
                {form.copyType === 'tables' && (
                  <Field
                    label={`Tables and views${form.sourceTables.length ? ` · ${form.sourceTables.length} selected` : ''}`}
                    hint="They keep their names in the target schema."
                  >
                    <div className="border border-[#dfe3e8] rounded">
                      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[#eceff2] bg-[#fbfcfd]">
                        <input
                          value={objectFilter}
                          onChange={e => setObjectFilter(e.target.value)}
                          placeholder="Filter"
                          disabled={!form.sourceSchema}
                          className="flex-1 min-w-0 h-[24px] px-2 rounded border border-[#dfe3e8] text-[11.5px]"
                        />
                        <button
                          type="button"
                          disabled={!filteredObjects.length}
                          onClick={() => {
                            const names = filteredObjects.map(t => t.name);
                            const allOn = names.every(n => form.sourceTables.includes(n));
                            set({
                              sourceTables: allOn
                                ? form.sourceTables.filter(n => !names.includes(n))
                                : Array.from(new Set([...form.sourceTables, ...names])),
                            });
                            clearPlan();
                          }}
                          className="flex-shrink-0 text-[11px] text-[#11567f] hover:underline disabled:opacity-40"
                        >
                          {filteredObjects.length && filteredObjects.every(t => form.sourceTables.includes(t.name))
                            ? 'Clear these' : 'Select these'}
                        </button>
                      </div>
                      <div className="max-h-[190px] overflow-y-auto">
                        {!form.sourceSchema && (
                          <div className="px-2.5 py-2 text-[11.5px] text-[#8a949e]">Pick a schema first.</div>
                        )}
                        {form.sourceSchema && !filteredObjects.length && (
                          <div className="px-2.5 py-2 text-[11.5px] text-[#8a949e]">Nothing matches that.</div>
                        )}
                        {filteredObjects.map(t => {
                          const checked = form.sourceTables.includes(t.name);
                          return (
                            <label
                              key={t.name}
                              className="flex items-center gap-2 px-2.5 py-1 text-[12px] hover:bg-[#fbfcfd] cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  set({
                                    sourceTables: checked
                                      ? form.sourceTables.filter(n => n !== t.name)
                                      : [...form.sourceTables, t.name],
                                  });
                                  clearPlan();
                                }}
                                className="flex-shrink-0"
                              />
                              <span className="flex-1 min-w-0 truncate" title={t.name}>{t.name}</span>
                              {t.kind !== 'table' && (
                                <span className="flex-shrink-0 text-[10.5px] text-[#8a949e]">view</span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </Field>
                )}
                {form.copyType === 'table' && (
                  <Field
                    label="Table or view"
                    hint={sourceIsView
                      ? 'A view can be recreated as a view, or written out as a table — pick above.'
                      : undefined}
                  >
                    <Select
                      value={form.sourceTable}
                      options={sourceTables}
                      placeholder="Choose a table or view"
                      disabled={!form.sourceSchema}
                      onChange={v => { set({ sourceTable: v, targetTable: form.targetTable || v }); clearPlan(); }}
                    />
                  </Field>
                )}
              </div>

              <div className="flex flex-col gap-3 p-3.5 border border-[#dfe3e8] rounded-lg">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12px] font-semibold text-[#1a1d21]">Target</span>
                  {writeLabel && (
                    <span className="text-[10.5px] text-[#8a949e] truncate" title={`Browsed and written as ${writeLabel}`}>
                      written as {writeLabel}
                    </span>
                  )}
                </div>
                <Field label="Database">
                  <Select
                    value={form.targetDatabase}
                    options={targetDatabases}
                    placeholder={loadingDbs ? 'Loading…' : 'Choose a database'}
                    onChange={v => {
                      setCustomSchema(false);
                      set({ targetDatabase: v, targetSchema: '' });
                      clearPlan();
                      loadSchemas(v, targetProfile);
                    }}
                  />
                </Field>
                <Field label="Schema">
                  <Select
                    value={customSchema ? NEW_SCHEMA : form.targetSchema}
                    options={[{ value: NEW_SCHEMA, label: '+ New schema…' }, ...targetSchemas]}
                    placeholder="Choose a schema"
                    disabled={!form.targetDatabase}
                    onChange={v => {
                      const isNew = v === NEW_SCHEMA;
                      setCustomSchema(isNew);
                      set({ targetSchema: isNew ? '' : v });
                      clearPlan();
                    }}
                  />
                </Field>
                {customSchema && (
                  <Field
                    label="New schema name"
                    hint={form.targetSchema
                      ? `${form.targetSchema} will be created if it isn't there already.`
                      : 'It is created as part of the copy.'}
                  >
                    <input
                      value={form.targetSchema}
                      onChange={e => { set({ targetSchema: e.target.value }); clearPlan(); }}
                      placeholder="SCHEMA_NAME"
                      spellCheck={false}
                      autoComplete="off"
                      className="w-full h-[32px] px-2.5 rounded border border-[#dfe3e8] text-[12.5px]"
                    />
                  </Field>
                )}
                {form.copyType === 'table' && (
                  <Field label="Table name" hint="Leave blank to keep the source name">
                    <input
                      value={form.targetTable}
                      onChange={e => { set({ targetTable: e.target.value }); clearPlan(); }}
                      placeholder={form.sourceTable || 'target_table_name'}
                      className="w-full h-[32px] px-2.5 rounded border border-[#dfe3e8] text-[12.5px]"
                    />
                  </Field>
                )}
                {form.copyType !== 'table' && (
                  <div className="text-[11px] text-[#8a949e]">
                    {form.copyType === 'tables'
                      ? 'Every selected object keeps its name. A target schema that does not exist yet is created as part of the copy.'
                      : 'A target schema that doesn\'t exist yet is created as part of the copy.'}
                  </div>
                )}
              </div>
            </div>

            {form.mode === 'insert' && (
              <Field label="Parallel chunks per table" hint="Leave blank to size it automatically from the row count (up to 8)">
                <input
                  type="number" min="1" max="8" value={form.parallelism}
                  onChange={e => { set({ parallelism: e.target.value }); clearPlan(); }}
                  placeholder="auto"
                  className="w-[140px] h-[32px] px-2.5 rounded border border-[#dfe3e8] text-[12.5px]"
                />
              </Field>
            )}

            {formError && (
              <div className="flex items-start gap-2 px-3 py-2 bg-[#fcf1f1] border border-[#f0d2d2] rounded text-[12px] text-[#c02b2b]">
                <Icon src={alertIcon} className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  {formError}
                  {errorCode === 'clone_needs_one_role' && (
                    <button
                      type="button"
                      onClick={() => {
                        set({ mode: 'insert' });
                        clearPlan();
                        runPreview({ mode: 'insert' });
                      }}
                      className="mt-2 block h-[28px] px-3 rounded bg-[#11567f] text-white text-[12px] font-medium hover:bg-[#0d4363]"
                    >
                      Copy rows instead
                    </button>
                  )}
                </div>
              </div>
            )}

            {!plan && (
              <button
                onClick={() => runPreview()}
                disabled={planning}
                className="self-start h-[34px] px-4 rounded bg-[#11567f] text-white text-[12.5px] font-medium hover:bg-[#0d4363] disabled:opacity-50"
              >
                {planning ? 'Checking…' : 'Preview copy'}
              </button>
            )}

            {plan && (
              <div className="border border-[#dfe3e8] rounded-lg overflow-hidden">
                <div className="px-3.5 py-2.5 bg-[#f5f7f9] border-b border-[#dfe3e8] flex items-center justify-between gap-3">
                  <span className="text-[12.5px] font-medium">
                    {keptItems.length} object{keptItems.length === 1 ? '' : 's'} · {fmtN(keptRows)} rows (estimated)
                    {excluded.size > 0 && (
                      <span className="ml-2 font-normal text-[11.5px] text-[#b8730d]">{excluded.size} left out</span>
                    )}
                  </span>
                  <span className="flex items-center gap-2 text-[11px] text-[#5c6670]">
                    {plan.route === 'transfer' && (
                      <span className="px-1.5 py-0.5 rounded bg-[#fdf3e3] text-[#b8730d]">through the portal</span>
                    )}
                    {plan.source} → {plan.target}
                  </span>
                </div>
                {canExclude && (
                  <div className="flex items-center gap-3 px-3.5 py-1.5 border-b border-[#eceff2] text-[11px] text-[#8a949e]">
                    <span>
                      {plan.single_statement && excluded.size === 0
                        ? 'Copied by one CREATE SCHEMA … CLONE, which brings the views and everything else across too. Untick anything and it clones table by table instead.'
                        : "Untick anything you don't want copied."}
                    </span>
                    <button
                      type="button"
                      onClick={() => setExcluded(excluded.size ? new Set() : new Set(planItems.map(i => i.name)))}
                      className="ml-auto text-[#11567f] hover:underline"
                    >
                      {excluded.size ? 'Tick all' : 'Untick all'}
                    </button>
                  </div>
                )}
                <div className="max-h-[220px] overflow-y-auto divide-y divide-[#eceff2]">
                  {planItems.map(item => {
                    const dropped = canExclude && excluded.has(item.name);
                    const row = (
                      <>
                        <span className={`flex-1 min-w-0 truncate ${dropped ? 'line-through text-[#b0b8c0]' : ''}`}>
                          {item.detail || item.name}
                        </span>
                        <span className={`flex-shrink-0 ml-3 ${dropped ? 'text-[#c8d0d8]' : 'text-[#5c6670]'}`}>
                          {fmtN(item.est_rows)} rows · {
                            item.strategy === 'clone' ? 'clone'
                              : item.strategy === 'view_ddl' ? 'view → view'
                                : item.strategy === 'transfer' ? 'row transfer'
                                  : item.strategy === 'view' ? 'view → table'
                                    : `${item.est_chunks} chunk${item.est_chunks === 1 ? '' : 's'}`
                          }
                        </span>
                      </>
                    );
                    if (!canExclude) {
                      return (
                        <div key={item.name} className="flex items-center justify-between px-3.5 py-2 text-[12px]">
                          {row}
                        </div>
                      );
                    }
                    return (
                      <label
                        key={item.name}
                        className="flex items-center gap-2.5 px-3.5 py-2 text-[12px] hover:bg-[#fbfcfd] cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={!dropped}
                          onChange={() => setExcluded(prev => {
                            const next = new Set(prev);
                            if (next.has(item.name)) next.delete(item.name);
                            else next.add(item.name);
                            return next;
                          })}
                          className="flex-shrink-0"
                        />
                        {row}
                      </label>
                    );
                  })}
                </div>
                {plan.warnings?.length > 0 && (
                  <div className="px-3.5 py-2 bg-[#fdf3e3] text-[11.5px] text-[#b8730d]">
                    {plan.warnings.join(' · ')}
                  </div>
                )}
                <div className="flex items-center gap-2 px-3.5 py-2.5 bg-white border-t border-[#dfe3e8]">
                  <button
                    onClick={startCopy}
                    disabled={starting || keptItems.length === 0}
                    className="flex items-center gap-2 h-[32px] px-4 rounded bg-[#11567f] text-white text-[12.5px] font-medium hover:bg-[#0d4363] disabled:opacity-50"
                  >
                    <Icon src={playIcon} className="w-2.5 h-2.5" tint="white" />
                    {starting ? 'Starting…' : 'Start copy'}
                  </button>
                  <button onClick={() => setPlan(null)} className="h-[32px] px-3 rounded border border-[#dfe3e8] text-[12.5px] hover:bg-[#f5f7f9]">
                    Back
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {job && (
          <div className="max-w-4xl flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Badge status={job.status === 'running' ? 'running' : job.status === 'success' ? 'success' : job.status === 'partial' ? 'running' : job.status === 'cancelled' ? 'pending' : 'failed'} />
                <span className="text-[13px] font-medium truncate">{job.source} → {job.target}</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-[11.5px] text-[#8a949e]">{fmtElapsed(job.elapsed_ms)}</span>
                {busy && (
                  <button
                    onClick={cancelCopy}
                    disabled={cancelling}
                    className="h-[28px] px-3 rounded border border-[#dfe3e8] text-[12px] hover:bg-[#f5f7f9] disabled:opacity-50"
                  >
                    {cancelling ? 'Cancelling…' : 'Cancel'}
                  </button>
                )}
                {finished && (
                  <button onClick={resetAll} className="h-[28px] px-3 rounded bg-[#11567f] text-white text-[12px] hover:bg-[#0d4363]">
                    New copy
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[11.5px] text-[#5c6670]">
                <span>
                  {/* Steps, not objects: a whole-schema clone is one statement
                      covering everything in it. */}
                  {job.tables_done}/{job.tables_total} step{job.tables_total === 1 ? '' : 's'}
                  {job.objects_total > job.tables_total && ` (${fmtN(job.objects_total)} objects)`}
                  {' · '}{fmtN(job.rows_copied)} of {fmtN(job.est_rows_total)} rows
                </span>
                <span>{job.percent != null ? `${job.percent}%` : '—'}</span>
              </div>
              <ProgressBar pct={job.percent} tone={job.status === 'failed' ? C.red : job.status === 'partial' ? C.amber : C.primary} />
            </div>

            {job.tables?.length > 0 && (
              <div className="border border-[#dfe3e8] rounded-lg overflow-hidden">
                <div className="max-h-[240px] overflow-y-auto divide-y divide-[#eceff2]">
                  {job.tables.map(t => {
                    const pct = t.est_rows ? Math.min(100, Math.round((t.rows_copied / t.est_rows) * 100))
                      : (t.status === 'success' ? 100 : t.chunks_total ? Math.round((t.chunks_done / t.chunks_total) * 100) : 0);
                    return (
                      <div key={t.name} className="px-3.5 py-2.5">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[12.5px] font-medium truncate">{t.name === '__schema__' ? job.source : t.name}</span>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className="text-[11px] text-[#8a949e]">
                              {fmtN(t.rows_copied)}{t.est_rows ? ` / ${fmtN(t.est_rows)}` : ''} rows
                              {t.chunks_total > 1 ? ` · ${t.chunks_done}/${t.chunks_total} chunks` : ''}
                            </span>
                            <Badge status={t.status} />
                          </div>
                        </div>
                        <ProgressBar pct={t.status === 'failed' ? 100 : pct} tone={t.status === 'failed' ? C.red : t.status === 'success' ? C.green : C.accent} />
                        {t.error && <div className="mt-1 text-[11px] text-[#c02b2b] truncate" title={t.error}>{t.error}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-[#5c6670] uppercase tracking-wide">Activity log</span>
              <div
                ref={logBoxRef}
                className="h-[220px] overflow-y-auto bg-[#1a1d21] rounded-lg p-3 font-mono text-[11.5px] leading-[1.6]"
              >
                {(job.logs || []).length === 0 && <div className="text-[#5c6670]">Waiting for the first update…</div>}
                {(job.logs || []).map((l, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-[#5c6670] flex-shrink-0">{new Date(l.ts * 1000).toLocaleTimeString()}</span>
                    <span style={{ color: LOG_COLOR[l.level] || '#c9d1d9' }} className="whitespace-pre-wrap break-all">{l.message}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}