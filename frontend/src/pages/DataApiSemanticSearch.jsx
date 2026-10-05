import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../utils/apiClient';
import { readJson } from './dataApiDocs';

/* Semantic search is configured entirely here; nothing about a table, model or
   response shape lives in code. Two scopes:
     - per alias (this API): on/off, columns, modes, tuning, response template
     - shared library: embedding models, which model built which column
       (shared by every API that publishes the table), versioned templates.
   Every save is validated by the server against the live source catalog and
   rejected with a report if anything would not work. */

const FIELD =
  'w-full px-3 py-2 rounded-lg border border-jj-gray-03 bg-white font-johnson-text text-xs text-jj-gray-08 focus:outline-none focus:ring-2 focus:ring-jj-blue-03';
const Label = ({ children }) => (
  <label className="block text-[11px] font-johnson-text text-jj-gray-06 mb-1">{children}</label>
);
const Hint = ({ children }) => (
  <p className="font-johnson-text text-[11px] text-jj-gray-05 mt-1">{children}</p>
);
const GhostButton = ({ children, className = '', ...rest }) => (
  <button {...rest} className={`px-3 py-2 rounded-lg border border-jj-gray-03 bg-white font-johnson-text text-xs text-jj-gray-08 hover:bg-jj-gray-01 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${className}`}>{children}</button>
);
const DarkButton = ({ children, className = '', ...rest }) => (
  <button {...rest} className={`px-3 py-2 rounded-lg bg-jj-gray-08 text-white font-johnson-text text-xs hover:bg-jj-gray-07 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${className}`}>{children}</button>
);
const Card = ({ title, subtitle, action, children }) => (
  <div className="bg-white border border-jj-gray-02 rounded-xl overflow-hidden">
    <div className="flex items-center justify-between px-5 py-4 border-b border-jj-gray-01">
      <div>
        <h3 className="font-johnson-display text-[15px] text-jj-gray-08">{title}</h3>
        {subtitle && <p className="font-johnson-text text-[11px] text-jj-gray-05 mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
    {children}
  </div>
);
const Pill = ({ tone = 'gray', children }) => {
  const tones = {
    green: 'bg-jj-green-03/10 text-jj-green-03',
    gray: 'bg-jj-gray-02 text-jj-gray-06',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-50 text-jj-red',
  };
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-johnson-text ${tones[tone]}`}>{children}</span>;
};

const MODES = [
  { id: 'hybrid', label: 'Hybrid (meaning + keywords)' },
  { id: 'dense', label: 'Meaning only' },
  { id: 'sparse', label: 'Keywords only' },
];
const DEFAULTS = {
  enabled: true, vector_column: '', metric: 'cosine', text_column: '', text_search_config: '',
  modes: null, default_mode: '', rrf_k: 60, dense_weight: 1, sparse_weight: 1, candidate_pool: 50,
  keyword_timeout_ms: 3000, semantic_timeout_ms: '', allow_exact: false, contract_id: '',
};
const CONTRACT_STARTER = JSON.stringify({
  matches_key: 'matches',
  lookups: { doc: { schema: 'schema_name', table: 'document_table', key: 'document_key', on: 'document_key' } },
  fields: { chunk_id: 'chunk_id', chunk_text: 'chunk_text' },
  objects: { document_metadata: { title: 'doc.title' } },
}, null, 2);

async function call(path, options = {}) {
  const res = await apiFetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await readJson(res);
  return { ok: res.ok, status: res.status, data };
}

const errorText = (data, status) => {
  const d = data?.detail;
  if (typeof d === 'string') return d;
  if (d?.message) return d.message;
  return `HTTP ${status}`;
};

/* ─────────────────────────────── report ─────────────────────────────── */

function Report({ report }) {
  if (!report) return null;
  const { errors = [], warnings = [], info = {} } = report;
  const rows = info.row_estimate;
  return (
    <div className="space-y-2">
      {errors.map((e, i) => (
        <p key={`e${i}`} role="alert" className="font-johnson-text text-xs text-jj-red bg-red-50 rounded-lg px-3 py-2">{e}</p>
      ))}
      {warnings.map((w, i) => (
        <p key={`w${i}`} className="font-johnson-text text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2">{w}</p>
      ))}
      {!errors.length && (
        <p className="font-johnson-text text-xs text-jj-green-03 bg-jj-green-03/10 rounded-lg px-3 py-2">
          {report.saved ? 'Saved. ' : 'All checks passed. '}
          {info.note || ''}
        </p>
      )}
      {(rows !== undefined || info.vector || info.keyword || info.embedding_test) && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-johnson-text text-[11px] text-jj-gray-06 bg-jj-gray-01/60 rounded-lg px-3 py-2">
          {rows !== undefined && <span>Rows (planner estimate): {rows === null ? 'not analyzed' : rows.toLocaleString()}</span>}
          {info.model && <span>Model: {info.model}</span>}
          {info.vector && <span>Vectors: {info.vector.type}({info.vector.dimensions ?? 'variable'}), pgvector {info.vector.pgvector}</span>}
          {info.vector && <span>ANN indexes: {info.vector.ann_indexes.join(', ') || 'none'}</span>}
          {info.keyword && <span>Keyword: {info.keyword.column} ({info.keyword.config})</span>}
          {info.contract && <span>Response template: {info.contract}</span>}
          {info.shared_with && <span>Column also used by: {info.shared_with.join(', ')}</span>}
          {info.embedding_test && <span>Embedding test: {info.embedding_test.dimensions} dims in {info.embedding_test.ms} ms</span>}
        </div>
      )}
      {(info.semantic_plan || info.keyword_plan) && (
        <details className="font-johnson-text text-[11px] text-jj-gray-06">
          <summary className="cursor-pointer">Query plans (planner only; nothing was executed)</summary>
          <pre className="mt-1 p-2 rounded bg-jj-gray-08 text-jj-gray-02 overflow-x-auto text-[10px]">
            {[...(info.semantic_plan || []), '', ...(info.keyword_plan || [])].join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}

/* ─────────────────────────── alias editor ─────────────────────────── */

function AliasEditor({ apiId, table, library, onDone, showToast }) {
  const [state, setState] = useState(null);
  const [form, setForm] = useState(DEFAULTS);
  const [modelId, setModelId] = useState('');
  const [rebuilt, setRebuilt] = useState(false);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState('');
  const [testEmbedding, setTestEmbedding] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const r = await call(`/data-api/${apiId}/tables/${table.id}/search`);
      if (!live) return;
      if (!r.ok) { showToast(`Could not load settings: ${errorText(r.data, r.status)}`, 'error'); return; }
      setState(r.data);
      const saved = r.data.settings || {};
      const opts = r.data.options || {};
      const next = { ...DEFAULTS, ...saved };
      next.vector_column = saved.vector_column ?? (opts.vector_columns?.[0]?.name || '');
      next.text_column = saved.text_column ?? (opts.text_columns?.find((c) => c.gin_configs.length)?.name || '');
      next.text_search_config = saved.text_search_config || '';
      next.contract_id = saved.contract_id || '';
      next.semantic_timeout_ms = saved.semantic_timeout_ms ?? '';
      setForm(next);
      setModelId(r.data.registrations?.[next.vector_column]?.model_id || '');
    })();
    return () => { live = false; };
  }, [apiId, table.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const opts = state?.options || {};
  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setReport(null); };
  const vec = (opts.vector_columns || []).find((c) => c.name === form.vector_column);
  const txt = (opts.text_columns || []).find((c) => c.name === form.text_column);
  const registered = state?.registrations?.[form.vector_column];
  const changingModel = registered && modelId && registered.model_id !== modelId;
  const available = useMemo(() => {
    const a = [];
    if (form.vector_column) a.push('dense');
    if (form.text_column) a.push('sparse');
    if (a.length === 2) a.unshift('hybrid');
    return a;
  }, [form.vector_column, form.text_column]);
  const modes = (form.modes || available).filter((m) => available.includes(m));
  const models = (library.models || []).filter((m) => !vec?.dimensions || m.dimensions === vec.dimensions);

  const payload = () => {
    const settings = {
      ...form,
      vector_column: form.vector_column || null,
      text_column: form.text_column || null,
      text_search_config: form.text_search_config || null,
      contract_id: form.contract_id || null,
      modes: modes.length ? modes : null,
      default_mode: modes.includes(form.default_mode) ? form.default_mode : null,
      rrf_k: Number(form.rrf_k), dense_weight: Number(form.dense_weight), sparse_weight: Number(form.sparse_weight),
      candidate_pool: Number(form.candidate_pool), keyword_timeout_ms: Number(form.keyword_timeout_ms),
      semantic_timeout_ms: form.semantic_timeout_ms === '' || form.semantic_timeout_ms == null ? null : Number(form.semantic_timeout_ms),
    };
    return {
      settings,
      registration: form.vector_column && modelId ? { [form.vector_column]: modelId } : null,
      replace_registration: rebuilt,
    };
  };

  const validate = async () => {
    setBusy('validate');
    const r = await call(`/data-api/${apiId}/tables/${table.id}/search/validate`, {
      method: 'POST', body: { ...payload(), planner: true, test_embedding: testEmbedding },
    });
    setBusy('');
    setReport(r.ok ? r.data : { errors: [errorText(r.data, r.status)] });
  };
  const save = async () => {
    setBusy('save');
    const r = await call(`/data-api/${apiId}/tables/${table.id}/search`, { method: 'PUT', body: payload() });
    setBusy('');
    if (r.ok) { setReport(r.data); showToast(`Semantic search saved for /${table.alias}`); onDone(true); return; }
    setReport(r.status === 422 && r.data?.detail?.errors ? r.data.detail : { errors: [errorText(r.data, r.status)] });
  };
  const remove = async () => {
    setBusy('remove');
    const r = await call(`/data-api/${apiId}/tables/${table.id}/search`, { method: 'DELETE' });
    setBusy('');
    if (r.ok) { showToast(`Semantic search removed from /${table.alias}`); onDone(true); }
    else showToast(errorText(r.data, r.status), 'error');
  };

  if (!state) return <p className="px-5 py-4 font-johnson-text text-xs text-jj-gray-05">Reading the table's catalog…</p>;
  if (!opts.supported) {
    return <p className="px-5 py-4 font-johnson-text text-xs text-jj-gray-06">{opts.reason || 'Semantic search is not available for this table.'}</p>;
  }

  return (
    <div className="px-5 py-4 bg-jj-gray-01/60 border-t border-jj-gray-02 space-y-4">
      <div className="flex flex-wrap items-center gap-3 font-johnson-text text-[11px] text-jj-gray-06">
        <span>Rows (estimate): <b>{opts.row_estimate == null ? 'not analyzed' : opts.row_estimate.toLocaleString()}</b></span>
        <span>Unique key: <b>{opts.unique_key?.length ? opts.unique_key.join(', ') : 'none (required)'}</b></span>
        <label className="flex items-center gap-1.5 ml-auto">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Search enabled for this alias
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <Label>Embedding column</Label>
          <select className={FIELD} value={form.vector_column} onChange={(e) => { set('vector_column', e.target.value); setModelId(state.registrations?.[e.target.value]?.model_id || ''); setRebuilt(false); }}>
            <option value="">None (keywords only)</option>
            {(opts.vector_columns || []).map((c) => (
              <option key={c.name} value={c.name}>{c.name} · {c.type}({c.dimensions ?? 'variable'}) · index: {c.ann_metrics.join('/') || 'none'}</option>
            ))}
          </select>
        </div>
        <div>
          <Label>Model that built this column (shared)</Label>
          <select className={FIELD} value={modelId} onChange={(e) => { setModelId(e.target.value); setReport(null); }} disabled={!form.vector_column}>
            <option value="">{models.length ? 'Choose a model' : 'No model with matching dimensions — add one below'}</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.deployment}, {m.dimensions})</option>)}
          </select>
          {registered && <Hint>Registered: {registered.model_name}. Every API publishing this table uses it.</Hint>}
          {changingModel && (
            <label className="flex items-start gap-1.5 mt-1 font-johnson-text text-[11px] text-amber-800">
              <input type="checkbox" checked={rebuilt} onChange={(e) => setRebuilt(e.target.checked)} className="mt-0.5" />
              I confirm this column's vectors were rebuilt with the new model.
            </label>
          )}
        </div>
        <div>
          <Label>Metric</Label>
          <select className={FIELD} value={form.metric} onChange={(e) => set('metric', e.target.value)} disabled={!form.vector_column}>
            <option value="cosine">Cosine</option>
            <option value="inner_product">Inner product</option>
          </select>
        </div>
        <div>
          <Label>Keyword column</Label>
          <select className={FIELD} value={form.text_column} onChange={(e) => { set('text_column', e.target.value); set('text_search_config', ''); }}>
            <option value="">None (meaning only)</option>
            {(opts.text_columns || []).map((c) => (
              <option key={c.name} value={c.name}>{c.name} · {c.gin_configs.length ? `index: ${c.gin_configs.join(', ')}` : 'no full-text index'}</option>
            ))}
          </select>
        </div>
        <div>
          <Label>Text search configuration</Label>
          <select className={FIELD} value={form.text_search_config} onChange={(e) => set('text_search_config', e.target.value)} disabled={!form.text_column}>
            <option value="">Use the index's configuration</option>
            {(txt?.gin_configs || []).filter((c) => !c.startsWith('(')).map((c) => <option key={c} value={c}>{c}</option>)}
            {txt?.type === 'tsvector' && ['english', 'simple'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <Label>Response template</Label>
          <select className={FIELD} value={form.contract_id} onChange={(e) => set('contract_id', e.target.value)}>
            <option value="">Default (rank, scores, row)</option>
            {(library.contracts || []).map((c) => <option key={c.id} value={c.id}>{c.name} v{c.version}</option>)}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <span className="font-johnson-text text-[11px] text-jj-gray-06">Modes callers may use:</span>
        {MODES.filter((m) => available.includes(m.id)).map((m) => (
          <label key={m.id} className="flex items-center gap-1.5 font-johnson-text text-xs text-jj-gray-08">
            <input type="checkbox" checked={modes.includes(m.id)}
              onChange={(e) => set('modes', e.target.checked ? [...modes, m.id] : modes.filter((x) => x !== m.id))} />
            {m.label}
          </label>
        ))}
        <select className={`${FIELD} w-44`} value={modes.includes(form.default_mode) ? form.default_mode : ''} onChange={(e) => set('default_mode', e.target.value)}>
          <option value="">Default: {modes[0] || '—'}</option>
          {modes.map((m) => <option key={m} value={m}>Default: {m}</option>)}
        </select>
      </div>

      <details>
        <summary className="cursor-pointer font-johnson-text text-xs text-jj-gray-07">Tuning and limits</summary>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mt-3">
          <div><Label>Fusion constant (RRF k)</Label><input type="number" className={FIELD} value={form.rrf_k} onChange={(e) => set('rrf_k', e.target.value)} /></div>
          <div><Label>Meaning weight</Label><input type="number" step="0.1" className={FIELD} value={form.dense_weight} onChange={(e) => set('dense_weight', e.target.value)} /></div>
          <div><Label>Keyword weight</Label><input type="number" step="0.1" className={FIELD} value={form.sparse_weight} onChange={(e) => set('sparse_weight', e.target.value)} /></div>
          <div><Label>Candidates per search (≤1000)</Label><input type="number" className={FIELD} value={form.candidate_pool} onChange={(e) => set('candidate_pool', e.target.value)} /></div>
          <div><Label>Keyword timeout (ms)</Label><input type="number" className={FIELD} value={form.keyword_timeout_ms} onChange={(e) => set('keyword_timeout_ms', e.target.value)} /></div>
          <div><Label>Semantic timeout (ms)</Label><input type="number" className={FIELD} value={form.semantic_timeout_ms} onChange={(e) => set('semantic_timeout_ms', e.target.value)} placeholder={`server default ${library.defaults?.semantic_timeout_ms ?? 5000}`} /></div>
        </div>
        <Hint>If keyword search exceeds its timeout, results fall back to meaning-only with a warning instead of failing.
          If semantic search exceeds its timeout the request fails with a message naming that step: check the query plan
          (Validate) before raising it.</Hint>
        <label className="flex items-start gap-1.5 mt-3 font-johnson-text text-xs text-jj-gray-08">
          <input type="checkbox" checked={form.allow_exact} onChange={(e) => set('allow_exact', e.target.checked)} className="mt-0.5" />
          <span>
            Allow exact search (reads every row: ~{opts.row_estimate == null ? '?' : opts.row_estimate.toLocaleString()} here).
            Keep off for large tables.
          </span>
        </label>
      </details>

      <Report report={report} />

      <div className="flex flex-wrap items-center gap-2">
        <DarkButton onClick={save} disabled={!!busy || (changingModel && !rebuilt)}>{busy === 'save' ? 'Saving…' : 'Save'}</DarkButton>
        <GhostButton onClick={validate} disabled={!!busy}>{busy === 'validate' ? 'Checking…' : 'Validate'}</GhostButton>
        <label className="flex items-center gap-1.5 font-johnson-text text-[11px] text-jj-gray-06">
          <input type="checkbox" checked={testEmbedding} onChange={(e) => setTestEmbedding(e.target.checked)} />
          include one test embedding call
        </label>
        <span className="flex-1" />
        {state.settings && <GhostButton onClick={remove} disabled={!!busy}>Remove search settings</GhostButton>}
        <GhostButton onClick={() => onDone(false)} disabled={!!busy}>Close</GhostButton>
      </div>
    </div>
  );
}

/* ─────────────────────────── shared library ─────────────────────────── */

const EMPTY_MODEL = { name: '', deployment: '', dimensions: 1536, endpoint: '', api_version: '', api_key_env: 'AZURE_OPENAI_EMBED_API_KEY', query_prefix: '', send_dimensions: false };

function ModelForm({ initial, allowedHosts, onSaved, onCancel, showToast }) {
  const [m, setM] = useState(initial || EMPTY_MODEL);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setM((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    setBusy(true); setErr('');
    const body = { ...m, dimensions: Number(m.dimensions) };
    const r = initial?.id
      ? await call(`/data-api/search/models/${initial.id}`, { method: 'PUT', body })
      : await call('/data-api/search/models', { method: 'POST', body });
    setBusy(false);
    if (r.ok) { showToast(`Model ${body.name} saved`); onSaved(); } else setErr(errorText(r.data, r.status));
  };
  return (
    <div className="px-5 py-4 bg-jj-gray-01/60 border-b border-jj-gray-02 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div><Label>Name</Label><input className={FIELD} value={m.name} onChange={(e) => set('name', e.target.value)} placeholder="rimdocs-embed" /></div>
        <div><Label>Azure deployment</Label><input className={FIELD} value={m.deployment} onChange={(e) => set('deployment', e.target.value)} placeholder="text-embedding-3-small" /></div>
        <div><Label>Dimensions it returns</Label><input type="number" className={FIELD} value={m.dimensions} onChange={(e) => set('dimensions', e.target.value)} /></div>
        <div><Label>API key variable (server)</Label><input className={FIELD} value={m.api_key_env} onChange={(e) => set('api_key_env', e.target.value)} /></div>
        <div className="md:col-span-2"><Label>Endpoint (blank = server default)</Label><input className={FIELD} value={m.endpoint} onChange={(e) => set('endpoint', e.target.value)} placeholder="https://…" /></div>
        <div><Label>API version (blank = server default)</Label><input className={FIELD} value={m.api_version} onChange={(e) => set('api_version', e.target.value)} placeholder="2024-08-01-preview" /></div>
        <div><Label>Query prefix (rare)</Label><input className={FIELD} value={m.query_prefix} onChange={(e) => set('query_prefix', e.target.value)} /></div>
      </div>
      <label className="flex items-center gap-1.5 font-johnson-text text-xs text-jj-gray-08">
        <input type="checkbox" checked={m.send_dimensions} onChange={(e) => set('send_dimensions', e.target.checked)} />
        Request this many dimensions from the model (only if the stored vectors were made the same way)
      </label>
      <Hint>
        Keys are never stored here: the server reads the named variable. Allowed endpoint hosts: {allowedHosts.join(', ') || 'none configured'} (set by server operators).
      </Hint>
      {err && <p role="alert" className="font-johnson-text text-xs text-jj-red">{err}</p>}
      <div className="flex gap-2"><DarkButton onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save model'}</DarkButton><GhostButton onClick={onCancel}>Cancel</GhostButton></div>
    </div>
  );
}

function ContractForm({ base, onSaved, onCancel, showToast }) {
  const [name, setName] = useState(base?.name || '');
  const [description, setDescription] = useState('');
  const [text, setText] = useState(base ? JSON.stringify(base.definition, null, 2) : CONTRACT_STARTER);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    let definition;
    try { definition = JSON.parse(text); } catch (e) { setErr(`Not valid JSON: ${e.message}`); return; }
    setBusy(true); setErr('');
    const r = await call('/data-api/search/contracts', { method: 'POST', body: { name, description, definition } });
    setBusy(false);
    if (r.ok) { showToast(`Saved ${r.data.name} v${r.data.version}`); onSaved(); } else setErr(errorText(r.data, r.status));
  };
  return (
    <div className="px-5 py-4 bg-jj-gray-01/60 border-b border-jj-gray-02 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div><Label>Name {base && `(saves as v${base.version + 1})`}</Label><input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} disabled={!!base} /></div>
        <div><Label>Description</Label><input className={FIELD} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      </div>
      <div>
        <Label>Definition (JSON)</Label>
        <textarea className={`${FIELD} font-mono min-h-[220px]`} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <Hint>
          fields / objects map output names to a column (<code>chunk_text</code>) or a lookup column (<code>doc.title</code>).
          Each lookup joins one table in the same database on a key that must be unique there. Templates never change once
          saved; saving under an existing name creates the next version, so APIs using an earlier version are unaffected.
        </Hint>
      </div>
      {err && <p role="alert" className="font-johnson-text text-xs text-jj-red">{err}</p>}
      <div className="flex gap-2"><DarkButton onClick={submit} disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save template'}</DarkButton><GhostButton onClick={onCancel}>Cancel</GhostButton></div>
    </div>
  );
}

function Library({ library, reload, showToast }) {
  const [modelForm, setModelForm] = useState(null);
  const [contractForm, setContractForm] = useState(null);
  const act = async (path, method, okText) => {
    const r = await call(path, { method });
    if (r.ok) { showToast(okText); reload(); } else showToast(errorText(r.data, r.status), 'error');
  };
  const test = async (m) => {
    const r = await call(`/data-api/search/models/${m.id}/test`, { method: 'POST' });
    if (r.ok && r.data.ok) showToast(`${m.name}: ${r.data.dimensions} dimensions in ${r.data.ms} ms`);
    else showToast(`${m.name}: ${r.data?.message || errorText(r.data, r.status)}`, 'error');
  };
  return (
    <div className="space-y-4">
      <Card title="Embedding models" subtitle="Shared by all APIs. Routing can change any time; what a model produces cannot while columns use it."
        action={<GhostButton onClick={() => setModelForm(modelForm ? null : {})}>{modelForm ? 'Close' : 'Add model'}</GhostButton>}>
        {modelForm && <ModelForm initial={modelForm.id ? modelForm : null} allowedHosts={library.allowed_hosts || []}
          onSaved={() => { setModelForm(null); reload(); }} onCancel={() => setModelForm(null)} showToast={showToast} />}
        {(library.models || []).map((m) => (
          <div key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-jj-gray-01 last:border-0 font-johnson-text text-xs">
            <b className="text-jj-gray-08">{m.name}</b>
            <span className="text-jj-gray-06">{m.deployment} · {m.dimensions} dims · {m.endpoint || 'server endpoint'}</span>
            <Pill tone={m.key_configured ? 'green' : 'red'}>{m.key_configured ? 'key set on server' : `${m.api_key_env} not set`}</Pill>
            <Pill>{m.registrations} column{m.registrations === 1 ? '' : 's'}</Pill>
            <span className="flex-1" />
            <GhostButton onClick={() => test(m)}>Test</GhostButton>
            <GhostButton onClick={() => setModelForm(m)}>Edit</GhostButton>
            <GhostButton onClick={() => act(`/data-api/search/models/${m.id}`, 'DELETE', `Deleted ${m.name}`)} disabled={m.registrations > 0}>Delete</GhostButton>
          </div>
        ))}
        {!library.models?.length && !modelForm && <p className="px-5 py-4 font-johnson-text text-xs text-jj-gray-05">No models yet. Add the model that built your table's vectors.</p>}
      </Card>

      <Card title="Column registrations" subtitle="Which model built which column. Created when an alias is saved; shared by every API over that table.">
        {(library.registrations || []).map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-jj-gray-01 last:border-0 font-johnson-text text-xs">
            <code className="text-jj-gray-08">{r.schema}.{r.table}.{r.column}</code>
            <span className="text-jj-gray-06">{r.source_system} · {r.env.toUpperCase()} · {r.model_name}</span>
            <span className="text-jj-gray-05">{r.used_by.length ? `used by ${r.used_by.join(', ')}` : 'not in use'}</span>
            <span className="flex-1" />
            <GhostButton onClick={() => act(`/data-api/search/registrations/${r.id}`, 'DELETE', 'Registration removed')} disabled={r.used_by.length > 0}>Remove</GhostButton>
          </div>
        ))}
        {!library.registrations?.length && <p className="px-5 py-4 font-johnson-text text-xs text-jj-gray-05">None yet.</p>}
      </Card>

      <Card title="Response templates" subtitle="Nested JSON shapes an alias can return. Immutable and versioned."
        action={<GhostButton onClick={() => setContractForm(contractForm ? null : {})}>{contractForm ? 'Close' : 'New template'}</GhostButton>}>
        {contractForm && <ContractForm base={contractForm.id ? contractForm : null}
          onSaved={() => { setContractForm(null); reload(); }} onCancel={() => setContractForm(null)} showToast={showToast} />}
        {(library.contracts || []).map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-jj-gray-01 last:border-0 font-johnson-text text-xs">
            <b className="text-jj-gray-08">{c.name} v{c.version}</b>
            <span className="text-jj-gray-06">{Object.keys(c.definition.fields).length} fields · {Object.keys(c.definition.objects).length} objects · {Object.keys(c.definition.lookups).length} lookups</span>
            <span className="text-jj-gray-05">{c.used_by.length ? `used by ${c.used_by.join(', ')}` : 'not in use'}</span>
            <span className="flex-1" />
            <GhostButton onClick={() => setContractForm(c)}>New version</GhostButton>
            <GhostButton onClick={() => act(`/data-api/search/contracts/${c.id}`, 'DELETE', `Deleted ${c.name} v${c.version}`)} disabled={c.used_by.length > 0}>Delete</GhostButton>
          </div>
        ))}
        {!library.contracts?.length && !contractForm && <p className="px-5 py-4 font-johnson-text text-xs text-jj-gray-05">None yet. Aliases without a template return rank, scores and the row.</p>}
      </Card>
    </div>
  );
}

/* ─────────────────────────────── tab ─────────────────────────────── */

export default function DataApiSemanticSearch({ apiId, tables, showToast }) {
  const [library, setLibrary] = useState(null);
  const [summary, setSummary] = useState(null);
  const [open, setOpen] = useState(null);

  const reload = useCallback(async () => {
    const [lib, sum] = await Promise.all([call('/data-api/search/library'), call(`/data-api/${apiId}/search`)]);
    if (!lib.ok) { showToast(`Could not load semantic search: ${errorText(lib.data, lib.status)}`, 'error'); return; }
    setLibrary(lib.data);
    setSummary(sum.ok ? sum.data : { aliases: {} });
  }, [apiId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { reload(); }, [reload]);

  if (!library) return <p className="font-johnson-text text-xs text-jj-gray-05">Loading…</p>;
  if (!library.installed) {
    return <Card title="Semantic search" subtitle={library.message}><p className="px-5 py-4 font-johnson-text text-xs text-jj-gray-06">Everything else keeps working.</p></Card>;
  }

  return (
    <div className="space-y-4">
      <Card title="Semantic search per alias" subtitle="Let callers of this API search with plain-language questions. Off until you enable it; each alias is independent.">
        {tables.map((t) => {
          const s = summary?.aliases?.[t.id];
          const on = s?.settings?.enabled;
          return (
            <div key={t.id} className="border-b border-jj-gray-01 last:border-0">
              <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <code className="font-mono text-xs font-medium text-jj-gray-08">/{t.alias}</code>
                <span className="font-johnson-text text-xs text-jj-gray-06">{[t.schema, t.table].filter(Boolean).join('.')}</span>
                <Pill tone={on ? 'green' : 'gray'}>{on ? `On · ${s.settings.modes.join(', ')}` : s ? 'Off' : 'Not configured'}</Pill>
                {s?.model && <Pill>{s.model}</Pill>}
                {s?.contract && <Pill>{s.contract}</Pill>}
                <span className="flex-1" />
                <GhostButton onClick={() => setOpen(open === t.id ? null : t.id)}>{open === t.id ? 'Close' : 'Configure'}</GhostButton>
              </div>
              {open === t.id && (
                <AliasEditor apiId={apiId} table={t} library={library} showToast={showToast}
                  onDone={(changed) => { setOpen(null); if (changed) reload(); }} />
              )}
            </div>
          );
        })}
      </Card>
      <Library library={library} reload={reload} showToast={showToast} />
    </div>
  );
}