import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiEventSource, apiJson } from '../utils/apiClient';
import { useRBAC } from '../context/RBACContext';

const STAGES = {
  analyzing: 'Analyzing question',
  routing: 'Selecting sources',
  retrieving: 'Retrieving evidence',
  reranking: 'Reranking evidence',
  generating: 'Generating grounded answer',
  verifying: 'Verifying claims',
  repairing: 'Repairing unsupported claims',
};

const statusTone = (state) => (
  state === 'verified' ? 'bg-jj-green-03/10 text-jj-green-05 border-jj-green-03/20'
    : state === 'failed' || state === 'unavailable'
      ? 'bg-jj-maroon-05/10 text-jj-maroon-05 border-jj-maroon-05/20'
      : 'bg-jj-gray-01 text-jj-gray-07 border-jj-gray-03'
);

function citeParts(answer, citations, onOpen) {
  const byId = Object.fromEntries((citations || []).map((c) => [c.evidence_id, c]));
  const parts = String(answer || '').split(/(\[cite:[A-Za-z0-9_.:\-]+\])/g);
  return parts.map((part, i) => {
    const match = /^\[cite:([A-Za-z0-9_.:\-]+)\]$/.exec(part);
    if (!match) return <React.Fragment key={i}>{part}</React.Fragment>;
    const citation = byId[match[1]];
    if (!citation) return <span key={i} className="text-jj-maroon-05">{part}</span>;
    return (
      <button
        key={i}
        type="button"
        onClick={() => onOpen(citation)}
        className="mx-1 inline-flex items-center rounded-full border border-jj-red/20 bg-jj-red/5 px-2 py-0.5 text-[11px] font-bold text-jj-red hover:bg-jj-red/10"
        title={citation.title || citation.source_name}
      >
        {citation.citation_id}
      </button>
    );
  });
}

function SourceCard({ item, onOpen }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="w-full rounded-xl border border-jj-gray-03 bg-white p-3 text-left hover:border-jj-red/30 hover:shadow-sm transition"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-johnson-display text-sm font-bold text-jj-gray-08">{item.title || item.source_name}</p>
          <p className="mt-0.5 truncate font-johnson-text text-[11px] text-jj-gray-06">{item.source_name} · {item.source_type}</p>
        </div>
        {(item.rerank_score ?? item.retrieval_score) != null && (
          <span className="shrink-0 rounded-full bg-jj-gray-01 px-2 py-1 text-[10px] font-bold text-jj-gray-07">
            {Number(item.rerank_score ?? item.retrieval_score).toFixed(2)}
          </span>
        )}
      </div>
      <p className="mt-2 line-clamp-3 whitespace-pre-wrap font-johnson-text text-xs leading-5 text-jj-gray-07">
        {(item.text || item.snippet || '').slice(0, 480)}
      </p>
    </button>
  );
}

function EvidenceDrawer({ item, onClose }) {
  if (!item) return null;
  return (
    <div className="fixed inset-0 z-[90] flex justify-end bg-black/20" onMouseDown={onClose}>
      <aside
        className="h-full w-full max-w-xl overflow-auto border-l border-jj-gray-03 bg-white p-6 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-johnson-text text-xs uppercase tracking-wide text-jj-red">Evidence</p>
            <h2 className="mt-1 font-johnson-display text-2xl font-bold text-jj-gray-08">{item.title || item.source_name}</h2>
            <p className="mt-1 font-johnson-text text-sm text-jj-gray-06">{item.source_name} · {item.source_type}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-jj-gray-03 px-3 py-2 text-sm text-jj-gray-07 hover:bg-jj-gray-01">Close</button>
        </div>
        <div className="mt-6 rounded-xl border border-jj-gray-03 bg-jj-gray-01/70 p-4">
          <p className="font-johnson-text text-[11px] font-bold uppercase tracking-wide text-jj-gray-06">Source locator</p>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-jj-gray-08">{JSON.stringify(item.locator || {}, null, 2)}</pre>
        </div>
        <div className="mt-4 rounded-xl border border-jj-gray-03 p-4">
          <p className="font-johnson-text text-[11px] font-bold uppercase tracking-wide text-jj-gray-06">Supporting content</p>
          <p className="mt-3 whitespace-pre-wrap font-johnson-text text-sm leading-6 text-jj-gray-08">{item.text || item.snippet}</p>
        </div>
      </aside>
    </div>
  );
}

function AdminPanel({ onClose }) {
  const [sources, setSources] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [kind, setKind] = useState('source');
  const [editing, setEditing] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sourceType, setSourceType] = useState('data_api');
  const [config, setConfig] = useState('{}');
  const [isActive, setIsActive] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    const [s, p, c] = await Promise.all([
      apiJson('/rag/admin/sources'),
      apiJson('/rag/admin/profiles'),
      apiJson('/rag/admin/data-api-catalog'),
    ]);
    setSources(s.sources || []);
    setProfiles(p.profiles || []);
    setCatalog(c.apis || []);
  };

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const reset = (nextKind = kind) => {
    setKind(nextKind); setEditing(null); setName(''); setDescription(''); setSourceType('data_api');
    setConfig(nextKind === 'profile'
      ? JSON.stringify({ source_ids: [], source_only: true, decompose: true, route_sources: true, rerank: true, verify: true, require_verification: true, candidate_k: 20, final_k: 10 }, null, 2)
      : '{}');
    setIsActive(true); setError('');
  };

  const edit = (row, nextKind) => {
    setKind(nextKind); setEditing(row); setName(row.name); setDescription(row.description || '');
    setIsActive(row.is_active !== false);
    if (nextKind === 'source') setSourceType(row.source_type);
    setConfig(JSON.stringify(row.config || {}, null, 2));
  };

  const save = async () => {
    setError('');
    let parsed;
    try { parsed = JSON.parse(config || '{}'); } catch { setError('Configuration must be valid JSON.'); return; }
    const path = kind === 'source' ? '/rag/admin/sources' : '/rag/admin/profiles';
    const body = kind === 'source'
      ? { name, description, source_type: sourceType, config: parsed, is_active: isActive }
      : { name, description, config: parsed, is_active: isActive };
    try {
      await apiJson(editing ? `${path}/${editing.id}` : path, { method: editing ? 'PUT' : 'POST', body });
      await load();
      reset(kind);
    } catch (e) { setError(e.message); }
  };

  const remove = async (row, nextKind) => {
    if (!window.confirm(`Delete ${row.name}?`)) return;
    try {
      await apiJson(`/rag/admin/${nextKind === 'source' ? 'sources' : 'profiles'}/${row.id}`, { method: 'DELETE' });
      await load();
      if (editing?.id === row.id) reset(nextKind);
    } catch (e) { setError(e.message); }
  };

  const useAlias = (api, table) => {
    setKind('source'); setEditing(null); setSourceType('data_api');
    setName(`${api.name} / ${table.alias}`);
    setDescription(`Agentic RAG source backed by SmartHub Data API alias ${table.alias}.`);
    setConfig(JSON.stringify({ api_id: api.id, alias: table.alias, mode: 'auto' }, null, 2));
  };

  return (
    <div className="fixed inset-0 z-[85] bg-black/20 p-4 md:p-8" onMouseDown={onClose}>
      <div className="mx-auto flex h-full max-w-7xl overflow-hidden rounded-2xl border border-jj-gray-03 bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="w-80 shrink-0 overflow-auto border-r border-jj-gray-03 bg-jj-gray-01/60 p-4">
          <div className="flex rounded-lg border border-jj-gray-03 bg-white p-1">
            {['source', 'profile'].map((x) => (
              <button key={x} type="button" onClick={() => reset(x)}
                className={`flex-1 rounded-md px-3 py-2 text-xs font-bold ${kind === x ? 'bg-jj-gray-08 text-white' : 'text-jj-gray-07'}`}>
                {x === 'source' ? 'Sources' : 'Profiles'}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => reset(kind)} className="mt-3 w-full rounded-lg bg-jj-red px-3 py-2 text-sm font-bold text-white">
            New {kind}
          </button>
          <div className="mt-4 space-y-2">
            {(kind === 'source' ? sources : profiles).map((row) => (
              <div key={row.id} className="rounded-lg border border-jj-gray-03 bg-white p-3">
                <button type="button" onClick={() => edit(row, kind)} className="w-full text-left">
                  <p className="font-johnson-display text-sm font-bold text-jj-gray-08">{row.name}</p>
                  <p className="mt-1 text-[11px] text-jj-gray-06">{kind === 'source' ? row.source_type : `${(row.config?.source_ids || []).length} sources`}</p>
                </button>
                <button type="button" onClick={() => remove(row, kind)} className="mt-2 text-[11px] font-bold text-jj-maroon-05">Delete</button>
              </div>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-auto p-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-jj-red">Agentic RAG configuration</p>
              <h2 className="mt-1 font-johnson-display text-2xl font-bold text-jj-gray-08">{editing ? `Edit ${kind}` : `Create ${kind}`}</h2>
            </div>
            <button type="button" onClick={onClose} className="rounded-lg border border-jj-gray-03 px-3 py-2 text-sm text-jj-gray-07">Close</button>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <label className="text-xs font-bold text-jj-gray-07">Name
              <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-lg border border-jj-gray-03 px-3 py-2 font-normal text-jj-gray-08 focus:outline-none focus:ring-2 focus:ring-jj-red/20" />
            </label>
            {kind === 'source' && <label className="text-xs font-bold text-jj-gray-07">Source type
              <select value={sourceType} onChange={(e) => setSourceType(e.target.value)} className="mt-1 w-full rounded-lg border border-jj-gray-03 px-3 py-2 font-normal">
                <option value="data_api">SmartHub Data API</option>
                <option value="connector">Existing JDBC / DB connector</option>
                <option value="rest">External REST API</option>
              </select>
            </label>}
            <label className="md:col-span-2 text-xs font-bold text-jj-gray-07">Description
              <input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 w-full rounded-lg border border-jj-gray-03 px-3 py-2 font-normal" />
            </label>
            <label className="md:col-span-2 text-xs font-bold text-jj-gray-07">Configuration JSON
              <textarea value={config} onChange={(e) => setConfig(e.target.value)} rows={16} spellCheck={false}
                className="mt-1 w-full rounded-lg border border-jj-gray-03 bg-jj-gray-08 p-3 font-mono text-xs text-white focus:outline-none focus:ring-2 focus:ring-jj-red/30" />
            </label>
            <label className="flex items-center gap-2 text-sm text-jj-gray-07">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active
            </label>
          </div>
          {error && <p className="mt-4 rounded-lg bg-jj-maroon-05/10 p-3 text-sm text-jj-maroon-05">{error}</p>}
          <button type="button" onClick={save} disabled={!name.trim()} className="mt-4 rounded-lg bg-jj-red px-5 py-2.5 text-sm font-bold text-white disabled:opacity-40">Save</button>

          {kind === 'source' && sourceType === 'data_api' && (
            <div className="mt-8">
              <h3 className="font-johnson-display text-lg font-bold text-jj-gray-08">Reuse a Data API Export</h3>
              <p className="mt-1 text-xs text-jj-gray-06">Choose an existing export alias. Native semantic retrieval is used when configured; otherwise the source falls back to safe live text search.</p>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {catalog.flatMap((api) => (api.tables || []).map((table) => (
                  <button key={`${api.id}:${table.id}`} type="button" onClick={() => useAlias(api, table)}
                    className="rounded-xl border border-jj-gray-03 p-3 text-left hover:border-jj-red/30">
                    <p className="text-sm font-bold text-jj-gray-08">{api.name} · {table.alias}</p>
                    <p className="mt-1 text-[11px] text-jj-gray-06">{table.source_system} · {table.database_name || 'default'} · {table.schema_name || ''}.{table.table_name}</p>
                  </button>
                )))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LegacyFallback() {
  const url = import.meta.env.VITE_API_RIMDOCS_AGENTIC_URL;
  return (
    <div className="h-full bg-jj-gray-01 p-6">
      <div className="h-full overflow-hidden rounded-xl border border-jj-gray-03 bg-white">
        <iframe src={url} title="Legacy RIMDocs Agentic" className="h-full w-full border-0" />
      </div>
    </div>
  );
}

export default function RimDocsAgentic() {
  const navigate = useNavigate();
  const { hasPermission } = useRBAC();
  const canManage = hasPermission('manageDataAPIExports');
  const nativeEnabled = import.meta.env.VITE_RAG_NATIVE_ENABLED !== 'false';
  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState('');
  const [messages, setMessages] = useState([]);
  const [query, setQuery] = useState('');
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState('');
  const [sourceEvents, setSourceEvents] = useState([]);
  const [evidence, setEvidence] = useState([]);
  const [selectedEvidence, setSelectedEvidence] = useState(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [error, setError] = useState('');
  const streamRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    if (!nativeEnabled) return;
    apiJson('/rag/profiles').then((data) => {
      const list = data.profiles || [];
      setProfiles(list);
      if (list.length) setProfileId(list.find((p) => p.config?.default)?.id || list[0].id);
    }).catch((e) => setError(e.message));
  }, [nativeEnabled]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, stage]);

  const history = useMemo(() => messages.slice(-12).map((m) => ({ role: m.role, content: m.content })), [messages]);

  if (!nativeEnabled) return <LegacyFallback />;

  const stop = () => {
    streamRef.current?.close();
    streamRef.current = null;
    setRunning(false);
    setStage('');
  };

  const ask = () => {
    const text = query.trim();
    if (!text || running || !profileId) return;
    setError('');
    setRunning(true);
    setStage('analyzing');
    setSourceEvents([]);
    setEvidence([]);
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: text }]);
    setQuery('');

    const es = apiEventSource('/rag/query/stream', {
      method: 'POST',
      body: { query: text, profile_id: profileId, history },
    });
    streamRef.current = es;

    const parse = (event) => {
      try { return JSON.parse(event.data || '{}'); } catch { return {}; }
    };

    es.addEventListener('status', (event) => {
      const data = parse(event);
      setStage(data.state || '');
      if (data.sources) setSourceEvents(data.sources.map((x) => ({ source_name: x.name, count: null })));
    });
    es.addEventListener('source', (event) => {
      const data = parse(event);
      setSourceEvents((prev) => [...prev.filter((x) => x.source_id !== data.source_id), data]);
    });
    es.addEventListener('retrieval', (event) => {
      const data = parse(event);
      setEvidence(data.evidence || []);
    });
    es.addEventListener('done', (event) => {
      const data = parse(event);
      const result = data.result;
      if (result) {
        setEvidence(result.evidence || []);
        setMessages((prev) => [...prev, {
          id: crypto.randomUUID(), role: 'assistant', content: result.answer || '',
          requestId: result.request_id, citations: result.citations || [],
          verification: result.verification || {}, diagnostics: result.diagnostics || {},
          insufficient: result.insufficient_evidence,
        }]);
      }
      streamRef.current = null;
      setRunning(false);
      setStage('');
    });
    es.addEventListener('error', (event) => {
      const data = parse(event);
      setError(data.message || 'Agentic RAG request failed.');
      streamRef.current?.close();
      streamRef.current = null;
      setRunning(false);
      setStage('');
    });
  };

  const exportAnswer = (m) => {
    const lines = ['SmartHub Enterprise Agentic RAG', '', m.content, '', 'Citations',
      ...(m.citations || []).map((c) => `${c.citation_id} | ${c.source_name} | ${c.title || ''} | ${JSON.stringify(c.locator || {})}`)];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `rag-answer-${m.requestId || 'export'}.txt` });
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const feedback = async (m, rating) => {
    try { await apiJson('/rag/feedback', { method: 'POST', body: { request_id: m.requestId, rating, reason: rating > 0 ? 'helpful' : 'not_helpful' } }); }
    catch (e) { setError(e.message); }
  };

  const newConversation = () => { stop(); setMessages([]); setEvidence([]); setSourceEvents([]); setError(''); };

  return (
    <div className="flex h-full min-h-0 flex-col bg-jj-gray-01">
      <header className="border-b border-jj-gray-03 bg-white px-5 py-4">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-johnson-text text-[11px] font-bold uppercase tracking-[0.16em] text-jj-red">Enterprise Agentic RAG</p>
            <h1 className="font-johnson-display text-xl font-bold text-jj-gray-08">RIMDocs grounded intelligence</h1>
          </div>
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={running}
            className="max-w-xs rounded-lg border border-jj-gray-03 bg-white px-3 py-2 text-xs text-jj-gray-08 focus:outline-none focus:ring-2 focus:ring-jj-red/20">
            {!profiles.length && <option>No active profile</option>}
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button type="button" onClick={() => navigate('/rag/evaluation')} className="rounded-lg border border-jj-gray-03 bg-white px-3 py-2 text-xs font-bold text-jj-gray-08 hover:bg-jj-gray-01">Evaluation</button>
          {canManage && <button type="button" onClick={() => setAdminOpen(true)} className="rounded-lg border border-jj-gray-03 bg-white px-3 py-2 text-xs font-bold text-jj-gray-08 hover:bg-jj-gray-01">Configure</button>}
          <button type="button" onClick={newConversation} className="rounded-lg bg-jj-gray-08 px-3 py-2 text-xs font-bold text-white">New conversation</button>
        </div>
      </header>

      <div className="mx-auto grid min-h-0 w-full max-w-[1500px] flex-1 grid-cols-1 gap-4 overflow-hidden p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-jj-gray-03 bg-white shadow-sm">
          <div className="flex-1 overflow-auto p-5">
            {!messages.length && (
              <div className="mx-auto mt-16 max-w-2xl text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-jj-red text-xl font-bold text-white">AI</div>
                <h2 className="mt-5 font-johnson-display text-3xl font-bold text-jj-gray-08">Ask from approved enterprise sources</h2>
                <p className="mt-3 font-johnson-text text-sm leading-6 text-jj-gray-06">Answers are source-grounded, citation-validated, and fail closed when evidence cannot be verified. Retrieved data is treated as untrusted content.</p>
              </div>
            )}
            <div className="space-y-5">
              {messages.map((m) => (
                <div key={m.id} className={m.role === 'user' ? 'ml-auto max-w-3xl' : 'mr-auto max-w-4xl'}>
                  {m.role === 'user' ? (
                    <div className="rounded-2xl rounded-br-md bg-jj-gray-08 px-4 py-3 font-johnson-text text-sm leading-6 text-white">{m.content}</div>
                  ) : (
                    <article className="rounded-2xl border border-jj-gray-03 bg-white p-5 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${statusTone(m.verification?.state)}`}>
                          {m.verification?.state === 'verified' ? 'Verified against evidence' : (m.verification?.state || 'Unverified')}
                        </span>
                        <span className="text-[10px] text-jj-gray-05">{m.requestId}</span>
                      </div>
                      <div className="mt-4 whitespace-pre-wrap font-johnson-text text-sm leading-7 text-jj-gray-08">
                        {citeParts(m.content, m.citations, setSelectedEvidence)}
                      </div>
                      {!!m.citations?.length && (
                        <div className="mt-5 border-t border-jj-gray-02 pt-4">
                          <p className="text-[11px] font-bold uppercase tracking-wide text-jj-gray-06">Citations</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {m.citations.map((c) => (
                              <button key={c.citation_id} type="button" onClick={() => setSelectedEvidence(c)}
                                className="rounded-lg border border-jj-gray-03 px-2.5 py-1.5 text-xs text-jj-gray-07 hover:border-jj-red/30">
                                {c.citation_id} · {c.source_name}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button type="button" onClick={() => feedback(m, 1)} className="rounded-lg border border-jj-gray-03 px-2.5 py-1.5 text-xs text-jj-gray-07">Helpful</button>
                        <button type="button" onClick={() => feedback(m, -1)} className="rounded-lg border border-jj-gray-03 px-2.5 py-1.5 text-xs text-jj-gray-07">Not helpful</button>
                        <button type="button" onClick={() => exportAnswer(m)} className="rounded-lg border border-jj-gray-03 px-2.5 py-1.5 text-xs text-jj-gray-07">Export answer</button>
                        <button type="button" onClick={() => setDiagnosticsOpen((x) => !x)} className="rounded-lg border border-jj-gray-03 px-2.5 py-1.5 text-xs text-jj-gray-07">Diagnostics</button>
                      </div>
                      {diagnosticsOpen && (
                        <pre className="mt-3 max-h-80 overflow-auto rounded-xl bg-jj-gray-08 p-3 font-mono text-[11px] text-white">
                          {JSON.stringify(m.diagnostics || {}, null, 2)}
                        </pre>
                      )}
                    </article>
                  )}
                </div>
              ))}
              {running && (
                <div className="mr-auto max-w-xl rounded-2xl border border-jj-gray-03 bg-jj-gray-01/70 p-4">
                  <div className="flex items-center gap-3">
                    <span className="h-3 w-3 animate-pulse rounded-full bg-jj-red" />
                    <p className="text-sm font-bold text-jj-gray-08">{STAGES[stage] || 'Working'}</p>
                  </div>
                  {!!sourceEvents.length && <p className="mt-2 text-xs text-jj-gray-06">{sourceEvents.map((s) => `${s.source_name}${s.count == null ? '' : ` (${s.count})`}`).join(' · ')}</p>}
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </div>

          {error && <div className="mx-5 mb-2 rounded-lg bg-jj-maroon-05/10 px-3 py-2 text-xs text-jj-maroon-05">{error}</div>}
          <div className="border-t border-jj-gray-03 bg-white p-4">
            <div className="flex items-end gap-3">
              <textarea value={query} onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }}
                placeholder="Ask a question grounded in configured sources…" rows={2} disabled={running || !profileId}
                className="min-h-[54px] flex-1 resize-none rounded-xl border border-jj-gray-03 px-4 py-3 font-johnson-text text-sm text-jj-gray-08 focus:outline-none focus:ring-2 focus:ring-jj-red/20 disabled:bg-jj-gray-01" />
              {running
                ? <button type="button" onClick={stop} className="rounded-xl border border-jj-maroon-05 px-4 py-3 text-sm font-bold text-jj-maroon-05">Stop</button>
                : <button type="button" onClick={ask} disabled={!query.trim() || !profileId} className="rounded-xl bg-jj-red px-5 py-3 text-sm font-bold text-white disabled:opacity-40">Ask</button>}
            </div>
            <p className="mt-2 text-[10px] text-jj-gray-05">Enter to send · Shift+Enter for a new line · Unsupported claims are removed or the system abstains.</p>
          </div>
        </section>

        <aside className="hidden min-h-0 overflow-auto rounded-2xl border border-jj-gray-03 bg-white p-4 shadow-sm xl:block">
          <div className="flex items-center justify-between">
            <h2 className="font-johnson-display text-lg font-bold text-jj-gray-08">Evidence</h2>
            <span className="rounded-full bg-jj-gray-01 px-2 py-1 text-[10px] font-bold text-jj-gray-06">{evidence.length}</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-jj-gray-06">Normalized evidence selected for the current answer. Open an item to inspect the source locator and supporting text.</p>
          <div className="mt-4 space-y-2">{evidence.map((e) => <SourceCard key={e.evidence_id} item={e} onOpen={setSelectedEvidence} />)}</div>
          {!evidence.length && <div className="mt-8 rounded-xl border border-dashed border-jj-gray-03 p-6 text-center text-xs text-jj-gray-05">Evidence appears here after retrieval.</div>}
        </aside>
      </div>

      <EvidenceDrawer item={selectedEvidence} onClose={() => setSelectedEvidence(null)} />
      {adminOpen && <AdminPanel onClose={() => { setAdminOpen(false); apiJson('/rag/profiles').then((d) => setProfiles(d.profiles || [])).catch(() => {}); }} />}
    </div>
  );
}
