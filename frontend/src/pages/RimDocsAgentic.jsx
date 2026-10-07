import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  BarChart3, BookOpen, Check, CheckCircle2, ChevronRight, Copy, Database,
  Download, FlaskConical, Info, MessageSquarePlus, Search, Send, Settings2,
  Square, ThumbsDown, ThumbsUp, X,
} from 'lucide-react';
import {
  BarChart, Bar, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

import { apiEventSource, apiJson } from '../utils/apiClient';
import { useRBAC } from '../context/RBACContext';

const STAGES = {
  analyzing: 'Understanding your question',
  routing: 'Selecting relevant sources',
  retrieving: 'Searching approved sources',
  reranking: 'Prioritizing the best evidence',
  generating: 'Writing a grounded answer',
  verifying: 'Verifying claims against evidence',
  repairing: 'Removing unsupported claims',
};

const MODES = [
  ['executive', 'Executive'],
  ['detailed', 'Detailed'],
  ['technical', 'Technical'],
];

function verificationLabel(v) {
  if (v?.state === 'verified') return 'Verified';
  if (v?.state === 'uncertain' && v?.reason === 'Verification disabled.') return 'Verification off';
  if (v?.state === 'failed') return 'Verification failed';
  if (v?.state === 'unavailable') return 'Verification unavailable';
  return 'Not verified';
}

function verificationTone(v) {
  if (v?.state === 'verified') return 'border-jj-green-03/30 bg-jj-green-03/10 text-jj-green-05';
  if (v?.state === 'failed' || v?.state === 'unavailable') {
    return 'border-jj-maroon-05/20 bg-jj-maroon-05/10 text-jj-maroon-05';
  }
  return 'border-jj-gray-03 bg-jj-gray-01 text-jj-gray-06';
}

function prepareMarkdown(answer, citations) {
  const byEvidence = Object.fromEntries((citations || []).map((c) => [c.evidence_id, c]));
  return String(answer || '').replace(/\[cite:([A-Za-z0-9_.:-]+)\]/g, (_, id) => {
    const c = byEvidence[id];
    return c ? `[${c.citation_id}](#citation-${id})` : '';
  });
}

function MarkdownAnswer({ answer, citations, onCitation, compact = false }) {
  const markdown = useMemo(() => prepareMarkdown(answer, citations), [answer, citations]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h1 className="mb-3 mt-6 font-johnson-display text-2xl font-bold text-jj-gray-08 first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-3 mt-6 font-johnson-display text-xl font-bold text-jj-gray-08 first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-5 font-johnson-display text-lg font-bold text-jj-gray-08 first:mt-0">{children}</h3>,
        p: ({ children }) => <p className={`mb-4 font-johnson-text text-[15px] text-jj-gray-08 last:mb-0 ${compact ? 'leading-6' : 'leading-7'}`}>{children}</p>,
        ul: ({ children }) => <ul className="mb-4 ml-6 list-disc space-y-1.5 font-johnson-text text-[15px] leading-7 text-jj-gray-08">{children}</ul>,
        ol: ({ children }) => <ol className="mb-4 ml-6 list-decimal space-y-1.5 font-johnson-text text-[15px] leading-7 text-jj-gray-08">{children}</ol>,
        li: ({ children }) => <li className="pl-1">{children}</li>,
        strong: ({ children }) => <strong className="font-bold text-jj-gray-08">{children}</strong>,
        blockquote: ({ children }) => <blockquote className="my-4 rounded-r-xl border-l-4 border-jj-red/30 bg-jj-gray-01 px-4 py-3">{children}</blockquote>,
        table: ({ children }) => <div className="my-5 overflow-x-auto rounded-xl border border-jj-gray-03"><table className="min-w-full text-left text-sm">{children}</table></div>,
        th: ({ children }) => <th className="border-b border-jj-gray-03 bg-jj-gray-01 px-4 py-3 font-bold text-jj-gray-08">{children}</th>,
        td: ({ children }) => <td className="border-b border-jj-gray-02 px-4 py-3 align-top text-jj-gray-07">{children}</td>,
        pre: ({ children }) => <pre className="my-4 overflow-auto rounded-xl bg-jj-gray-08 p-4 text-xs text-white">{children}</pre>,
        code: ({ children }) => <code className="rounded bg-jj-gray-01 px-1.5 py-0.5 font-mono text-[13px]">{children}</code>,
        a: ({ href, children }) => {
          if (href?.startsWith('#citation-')) {
            const id = href.slice('#citation-'.length);
            const citation = (citations || []).find((c) => c.evidence_id === id);
            return (
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); if (citation) onCitation(citation); }}
                className="mx-0.5 inline-flex min-h-5 items-center rounded-full border border-jj-red/20 bg-jj-red/5 px-1.5 align-text-top text-[10px] font-bold text-jj-red hover:bg-jj-red/10"
                title={citation?.title || citation?.source_name}
              >
                {children}
              </button>
            );
          }
          return <a href={href} target="_blank" rel="noreferrer" className="text-jj-red underline underline-offset-2">{children}</a>;
        },
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}

function KpiBlock({ block }) {
  return (
    <section className="grid gap-3 sm:grid-cols-3">
      {(block.items || []).map((item) => (
        <div key={item.label} className="rounded-xl border border-jj-gray-03 bg-jj-gray-01/60 p-4">
          <p className="font-johnson-text text-[11px] font-bold uppercase tracking-wide text-jj-gray-05">{item.label}</p>
          <p className="mt-2 font-johnson-display text-2xl font-bold text-jj-gray-08">{item.value}</p>
        </div>
      ))}
    </section>
  );
}

function TableBlock({ block }) {
  return (
    <section className="rounded-xl border border-jj-gray-03 bg-white">
      <div className="border-b border-jj-gray-03 px-4 py-3">
        <h3 className="font-johnson-display text-base font-bold text-jj-gray-08">{block.title}</h3>
        {block.description && <p className="mt-1 text-xs text-jj-gray-05">{block.description}</p>}
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left font-johnson-text text-xs">
          <thead className="bg-jj-gray-01">
            <tr>
              {(block.columns || []).map((c) => <th key={c.key} className="whitespace-nowrap border-b border-jj-gray-03 px-4 py-3 font-bold text-jj-gray-07">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {(block.rows || []).map((row, i) => (
              <tr key={i} className="odd:bg-white even:bg-jj-gray-01/30">
                {(block.columns || []).map((c) => (
                  <td key={c.key} className="max-w-[280px] border-b border-jj-gray-02 px-4 py-3 align-top text-jj-gray-07">
                    {row[c.key] == null ? '—' : String(row[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ChartBlock({ block }) {
  if (block.chart_type !== 'bar' || !(block.data || []).length) return null;
  return (
    <section className="rounded-xl border border-jj-gray-03 bg-white p-4">
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-jj-red" />
          <h3 className="font-johnson-display text-base font-bold text-jj-gray-08">{block.title}</h3>
        </div>
        {block.description && <p className="mt-1 text-xs leading-5 text-jj-gray-05">{block.description}</p>}
      </div>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={block.data} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 16 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis
              type="category"
              dataKey={block.x_key}
              width={140}
              tick={{ fontSize: 11 }}
              tickFormatter={(v) => String(v).slice(0, 24)}
            />
            <Tooltip formatter={(value) => [value, block.value_label || 'Value']} />
            <Bar dataKey={block.y_key} radius={[0, 5, 5, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function PresentationBlocks({ blocks, mode }) {
  const visible = (blocks || []).filter((block) => {
    if (mode === 'technical') return block.audience === 'technical' || block.audience === 'both';
    return block.audience !== 'technical';
  });
  if (!visible.length) return null;

  return (
    <div className="mt-6 space-y-4">
      {visible.map((block, i) => {
        if (block.type === 'kpi') return <KpiBlock key={i} block={block} />;
        if (block.type === 'table') return <TableBlock key={i} block={block} />;
        if (block.type === 'chart') return <ChartBlock key={i} block={block} />;
        return null;
      })}
    </div>
  );
}

function CitationDrawer({ citation, onClose }) {
  const [tab, setTab] = useState('overview');
  useEffect(() => setTab('overview'), [citation?.evidence_id]);
  if (!citation) return null;

  const business = citation.business || {};
  const technical = citation.technical || {};

  return (
    <div className="fixed inset-0 z-[95] flex justify-end bg-black/25" onMouseDown={onClose}>
      <aside className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <header className="border-b border-jj-gray-03 px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-jj-red">Citation {citation.citation_id}</p>
              <h2 className="mt-2 font-johnson-display text-2xl font-bold text-jj-gray-08">{business.title || citation.title || citation.source_name}</h2>
              <p className="mt-1 text-sm text-jj-gray-05">{business.source || citation.source_name}</p>
            </div>
            <button type="button" onClick={onClose} className="rounded-lg border border-jj-gray-03 p-2 text-jj-gray-06 hover:bg-jj-gray-01"><X className="h-4 w-4" /></button>
          </div>
          <div className="mt-5 flex gap-1 rounded-xl border border-jj-gray-03 bg-jj-gray-01 p-1">
            {[['overview', 'Overview'], ['evidence', 'Evidence'], ['technical', 'Technical']].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`flex-1 rounded-lg px-3 py-2 text-xs font-bold ${tab === id ? 'bg-white text-jj-gray-08 shadow-sm' : 'text-jj-gray-05'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'overview' && (
            <div className="space-y-5">
              <section>
                <h3 className="text-xs font-bold uppercase tracking-wide text-jj-gray-05">Business context</h3>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-jj-gray-08">{business.summary || citation.snippet}</p>
              </section>
              {!!business.supports?.length && (
                <section>
                  <h3 className="text-xs font-bold uppercase tracking-wide text-jj-gray-05">Supports these answer claims</h3>
                  <ul className="mt-2 space-y-2">
                    {business.supports.map((claim, i) => <li key={i} className="rounded-lg bg-jj-gray-01 px-3 py-2 text-sm leading-6 text-jj-gray-07">{claim}</li>)}
                  </ul>
                </section>
              )}
              {!!Object.keys(business.record || {}).length && (
                <section>
                  <h3 className="text-xs font-bold uppercase tracking-wide text-jj-gray-05">Record details</h3>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {Object.entries(business.record).map(([k, v]) => (
                      <div key={k} className="rounded-lg border border-jj-gray-03 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-jj-gray-05">{k.replaceAll('_', ' ')}</p>
                        <p className="mt-1 break-words text-sm text-jj-gray-08">{String(v)}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {tab === 'evidence' && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-jj-gray-05">Supporting evidence</h3>
              <div className="mt-3 rounded-xl border border-jj-gray-03 bg-jj-gray-01/60 p-5">
                <p className="whitespace-pre-wrap text-sm leading-7 text-jj-gray-08">{citation.snippet || business.summary || 'No evidence text returned.'}</p>
              </div>
            </div>
          )}

          {tab === 'technical' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-jj-gray-03 bg-jj-gray-08 p-4">
                <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-white">
                  {JSON.stringify(technical, null, 2)}
                </pre>
              </div>
              <p className="text-xs leading-5 text-jj-gray-05">
                Ranking scores are retrieval/rerank signals. They are not confidence percentages.
              </p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function SourcesDrawer({ items, onClose, onOpenCitation }) {
  if (!items) return null;
  return (
    <div className="fixed inset-0 z-[85] flex justify-end bg-black/20" onMouseDown={onClose}>
      <aside className="flex h-full w-full max-w-md flex-col border-l border-jj-gray-03 bg-jj-gray-01 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b border-jj-gray-03 bg-white p-5">
          <div className="flex justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-jj-red">Sources</p>
              <h2 className="mt-1 font-johnson-display text-xl font-bold text-jj-gray-08">Evidence used in this answer</h2>
            </div>
            <button type="button" onClick={onClose} className="rounded-lg border border-jj-gray-03 p-2"><X className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {items.map((c) => (
            <button key={c.evidence_id} type="button" onClick={() => onOpenCitation(c)} className="group w-full rounded-xl border border-jj-gray-03 bg-white p-4 text-left hover:border-jj-red/25 hover:shadow-sm">
              <div className="flex items-start gap-3">
                <span className="rounded-full bg-jj-red/10 px-2 py-1 text-[10px] font-bold text-jj-red">{c.citation_id}</span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-bold text-jj-gray-08">{c.business?.title || c.title || c.source_name}</p>
                  <p className="mt-1 truncate text-[11px] text-jj-gray-05">{c.source_name}</p>
                  <p className="mt-2 line-clamp-3 text-xs leading-5 text-jj-gray-06">{c.business?.summary || c.snippet}</p>
                </div>
                <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-jj-gray-04 group-hover:text-jj-red" />
              </div>
            </button>
          ))}
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
    setKind(nextKind);
    setEditing(null);
    setName('');
    setDescription('');
    setSourceType('data_api');
    setConfig(nextKind === 'profile'
      ? JSON.stringify({
          default: false, source_ids: [], source_only: true, decompose: false,
          route_sources: false, rerank: true, verify: true, require_verification: true,
          candidate_k: 20, final_k: 8, repair_attempts: 1,
        }, null, 2)
      : '{}');
    setIsActive(true);
    setError('');
  };

  const edit = (row, nextKind) => {
    setKind(nextKind);
    setEditing(row);
    setName(row.name);
    setDescription(row.description || '');
    setIsActive(row.is_active !== false);
    if (nextKind === 'source') setSourceType(row.source_type);
    setConfig(JSON.stringify(row.config || {}, null, 2));
  };

  const selectedSourceIds = useMemo(() => {
    if (kind !== 'profile') return new Set();
    try { return new Set(JSON.parse(config || '{}').source_ids || []); } catch { return new Set(); }
  }, [kind, config]);

  const toggleSource = (id) => {
    try {
      const parsed = JSON.parse(config || '{}');
      const ids = new Set(parsed.source_ids || []);
      ids.has(id) ? ids.delete(id) : ids.add(id);
      setConfig(JSON.stringify({ ...parsed, source_ids: [...ids] }, null, 2));
      setError('');
    } catch {
      setError('Fix the JSON before changing source selection.');
    }
  };

  const save = async () => {
    setError('');
    let parsed;
    try { parsed = JSON.parse(config || '{}'); } catch { setError('Configuration must be valid JSON.'); return; }
    const base = kind === 'source' ? '/rag/admin/sources' : '/rag/admin/profiles';
    const body = kind === 'source'
      ? { name, description, source_type: sourceType, config: parsed, is_active: isActive }
      : { name, description, config: parsed, is_active: isActive };
    try {
      await apiJson(editing ? `${base}/${editing.id}` : base, { method: editing ? 'PUT' : 'POST', body });
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

  const selectDataApiAlias = (api, table) => {
    setKind('source');
    setEditing(null);
    setSourceType('data_api');
    setName(`${api.name} / ${table.alias}`);
    setDescription(`Agentic RAG source backed by SmartHub Data API alias ${table.alias}.`);
    setConfig(JSON.stringify({ api_id: api.id, alias: table.alias, mode: 'auto' }, null, 2));
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/25 p-3 md:p-6" onMouseDown={onClose}>
      <div className="mx-auto flex h-full max-w-7xl overflow-hidden rounded-2xl border border-jj-gray-03 bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-jj-gray-03 bg-jj-gray-01/60 p-4">
          <div className="flex rounded-xl border border-jj-gray-03 bg-white p-1">
            {[['source', 'Sources'], ['profile', 'Profiles']].map(([id, label]) => (
              <button key={id} type="button" onClick={() => reset(id)} className={`flex-1 rounded-lg px-3 py-2 text-xs font-bold ${kind === id ? 'bg-jj-gray-08 text-white' : 'text-jj-gray-06'}`}>{label}</button>
            ))}
          </div>
          <button type="button" onClick={() => reset(kind)} className="mt-3 w-full rounded-xl bg-jj-red px-3 py-2.5 text-sm font-bold text-white">New {kind}</button>
          <div className="mt-4 space-y-2">
            {(kind === 'source' ? sources : profiles).map((row) => (
              <div key={row.id} className="rounded-xl border border-jj-gray-03 bg-white p-3">
                <button type="button" onClick={() => edit(row, kind)} className="w-full text-left">
                  <p className="text-sm font-bold text-jj-gray-08">{row.name}</p>
                  <p className="mt-1 text-[11px] text-jj-gray-05">{kind === 'source' ? row.source_type : `${(row.config?.source_ids || []).length} sources`}</p>
                </button>
                <button type="button" onClick={() => remove(row, kind)} className="mt-2 text-[11px] font-bold text-jj-maroon-05">Delete</button>
              </div>
            ))}
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto p-6 md:p-8">
          <div className="mx-auto max-w-4xl">
            <div className="flex items-start justify-between gap-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-jj-red">Agentic RAG configuration</p>
                <h2 className="mt-1 font-johnson-display text-2xl font-bold text-jj-gray-08">{editing ? `Edit ${kind}` : `Create ${kind}`}</h2>
              </div>
              <button type="button" onClick={onClose} className="rounded-lg border border-jj-gray-03 p-2"><X className="h-4 w-4" /></button>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <label className="text-xs font-bold text-jj-gray-07">Name
                <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1.5 w-full rounded-xl border border-jj-gray-03 px-3 py-2.5 font-normal" />
              </label>
              {kind === 'source' && (
                <label className="text-xs font-bold text-jj-gray-07">Source type
                  <select value={sourceType} onChange={(e) => setSourceType(e.target.value)} className="mt-1.5 w-full rounded-xl border border-jj-gray-03 px-3 py-2.5 font-normal">
                    <option value="data_api">SmartHub Data API</option>
                    <option value="connector">Existing JDBC / DB connector</option>
                    <option value="rest">External REST API</option>
                  </select>
                </label>
              )}
              <label className="md:col-span-2 text-xs font-bold text-jj-gray-07">Description
                <input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1.5 w-full rounded-xl border border-jj-gray-03 px-3 py-2.5 font-normal" />
              </label>
            </div>

            {kind === 'profile' && !!sources.length && (
              <section className="mt-6">
                <h3 className="text-sm font-bold text-jj-gray-08">Sources</h3>
                <p className="mt-1 text-xs text-jj-gray-05">Select sources without copying IDs manually.</p>
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {sources.filter((s) => s.is_active !== false).map((s) => {
                    const selected = selectedSourceIds.has(s.id);
                    return (
                      <button key={s.id} type="button" onClick={() => toggleSource(s.id)} className={`flex items-start gap-3 rounded-xl border p-3 text-left ${selected ? 'border-jj-red/30 bg-jj-red/5' : 'border-jj-gray-03'}`}>
                        <span className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded border ${selected ? 'border-jj-red bg-jj-red text-white' : 'border-jj-gray-04'}`}>{selected && <Check className="h-3.5 w-3.5" />}</span>
                        <span><span className="block text-sm font-bold text-jj-gray-08">{s.name}</span><span className="text-[11px] text-jj-gray-05">{s.source_type}</span></span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            <section className="mt-6">
              <h3 className="text-sm font-bold text-jj-gray-08">Advanced configuration</h3>
              <textarea value={config} onChange={(e) => setConfig(e.target.value)} rows={14} spellCheck={false} className="mt-2 w-full rounded-xl bg-jj-gray-08 p-4 font-mono text-xs leading-5 text-white" />
            </section>

            <label className="mt-4 flex items-center gap-2 text-sm text-jj-gray-07">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active
            </label>

            {error && <p className="mt-4 rounded-xl bg-jj-maroon-05/10 p-3 text-sm text-jj-maroon-05">{error}</p>}
            <button type="button" onClick={save} disabled={!name.trim()} className="mt-4 rounded-xl bg-jj-red px-5 py-2.5 text-sm font-bold text-white disabled:opacity-40">Save</button>

            {kind === 'source' && sourceType === 'data_api' && (
              <section className="mt-9 border-t border-jj-gray-03 pt-6">
                <h3 className="font-johnson-display text-lg font-bold text-jj-gray-08">Reuse a Data API Export</h3>
                <p className="mt-1 text-xs text-jj-gray-05">Choose an existing alias. Semantic/hybrid retrieval is reused when configured.</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {catalog.flatMap((api) => (api.tables || []).map((table) => (
                    <button key={`${api.id}:${table.id}`} type="button" onClick={() => selectDataApiAlias(api, table)} className="rounded-xl border border-jj-gray-03 p-4 text-left hover:border-jj-red/25">
                      <p className="text-sm font-bold text-jj-gray-08">{api.name}</p>
                      <p className="mt-0.5 text-xs text-jj-red">{table.alias}</p>
                      <p className="mt-2 truncate text-[11px] text-jj-gray-05">{table.source_system} · {table.database_name || 'default'} · {table.schema_name || ''}.{table.table_name}</p>
                    </button>
                  )))}
                </div>
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function LegacyFallback() {
  const url = import.meta.env.VITE_API_RIMDOCS_AGENTIC_URL;
  return <div className="h-full bg-jj-gray-01 p-6"><iframe src={url} title="Legacy RIMDocs Agentic" className="h-full w-full rounded-xl border-0 bg-white" /></div>;
}

function EmptyState() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center px-6 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-jj-red/10"><Search className="h-6 w-6 text-jj-red" /></div>
      <h2 className="mt-5 font-johnson-display text-3xl font-bold text-jj-gray-08">Ask your enterprise knowledge</h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-jj-gray-06">Grounded answers can now include narrative, business metrics, tables, validated charts, and source lineage.</p>
    </div>
  );
}

function AssistantMessage({ message, onCitation, onSources, onFeedback, onExport, onCopy, copied }) {
  const [mode, setMode] = useState('detailed');
  const [diagOpen, setDiagOpen] = useState(false);
  const blocks = message.blocks || [];

  const executive = (
    <div>
      <MarkdownAnswer answer={message.content} citations={message.citations} onCitation={onCitation} compact />
      <PresentationBlocks blocks={blocks.filter((b) => b.type === 'kpi' || b.type === 'chart')} mode="executive" />
    </div>
  );

  const detailed = (
    <div>
      <MarkdownAnswer answer={message.content} citations={message.citations} onCitation={onCitation} />
      <PresentationBlocks blocks={blocks} mode="detailed" />
    </div>
  );

  const technical = (
    <div className="space-y-4">
      <PresentationBlocks blocks={blocks} mode="technical" />
      <div className="rounded-xl border border-jj-gray-03 bg-jj-gray-08 p-4">
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-white">
          {JSON.stringify({ request_id: message.requestId, verification: message.verification, diagnostics: message.diagnostics }, null, 2)}
        </pre>
      </div>
    </div>
  );

  return (
    <article className="w-full">
      <div className="mb-2 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-jj-red text-[11px] font-bold text-white">AI</div>
        <span className="text-xs font-bold text-jj-gray-07">SmartHub</span>
        <span className={`ml-1 inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-bold ${verificationTone(message.verification)}`}>
          {message.verification?.state === 'verified' && <CheckCircle2 className="h-3.5 w-3.5" />}
          {verificationLabel(message.verification)}
        </span>
      </div>

      <div className="rounded-2xl border border-jj-gray-03 bg-white p-5 shadow-sm md:p-7">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex rounded-xl border border-jj-gray-03 bg-jj-gray-01 p-1">
            {MODES.map(([id, label]) => (
              <button key={id} type="button" onClick={() => setMode(id)} className={`rounded-lg px-3 py-1.5 text-xs font-bold ${mode === id ? 'bg-white text-jj-gray-08 shadow-sm' : 'text-jj-gray-05'}`}>{label}</button>
            ))}
          </div>
          <button type="button" onClick={() => onSources(message)} className="inline-flex items-center gap-2 rounded-lg border border-jj-gray-03 px-3 py-2 text-xs font-bold text-jj-gray-06 hover:bg-jj-gray-01">
            <BookOpen className="h-3.5 w-3.5" /> Sources <span className="rounded-full bg-jj-gray-01 px-1.5 py-0.5">{message.citations?.length || 0}</span>
          </button>
        </div>

        {mode === 'executive' ? executive : mode === 'technical' ? technical : detailed}

        <div className="mt-6 flex flex-wrap items-center gap-1 border-t border-jj-gray-02 pt-4">
          <button type="button" onClick={() => onCopy(message)} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-jj-gray-06 hover:bg-jj-gray-01">{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" onClick={() => onExport(message)} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-jj-gray-06 hover:bg-jj-gray-01"><Download className="h-3.5 w-3.5" />Export</button>
          <button type="button" onClick={() => onFeedback(message, 1)} className="rounded-lg p-1.5 text-jj-gray-05 hover:bg-jj-gray-01" title="Helpful"><ThumbsUp className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={() => onFeedback(message, -1)} className="rounded-lg p-1.5 text-jj-gray-05 hover:bg-jj-gray-01" title="Not helpful"><ThumbsDown className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={() => setDiagOpen((v) => !v)} className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-jj-gray-05 hover:bg-jj-gray-01"><Info className="h-3.5 w-3.5" />Diagnostics</button>
        </div>
        {diagOpen && (
          <pre className="mt-4 max-h-80 overflow-auto rounded-xl bg-jj-gray-08 p-4 font-mono text-[11px] text-white">{JSON.stringify(message.diagnostics || {}, null, 2)}</pre>
        )}
      </div>
    </article>
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
  const [selectedCitation, setSelectedCitation] = useState(null);
  const [sourceItems, setSourceItems] = useState(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState(null);

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

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, running, stage]);

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
      if (data.sources) setSourceEvents(data.sources.map((x) => ({ source_id: x.id, source_name: x.name, count: null })));
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
          id: crypto.randomUUID(),
          role: 'assistant',
          content: result.answer || '',
          requestId: result.request_id,
          citations: result.citations || [],
          evidence: result.evidence || [],
          blocks: result.blocks || [],
          verification: result.verification || {},
          diagnostics: result.diagnostics || {},
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

  const feedback = async (m, rating) => {
    try {
      await apiJson('/rag/feedback', { method: 'POST', body: { request_id: m.requestId, rating, reason: rating > 0 ? 'helpful' : 'not_helpful' } });
    } catch (e) { setError(e.message); }
  };

  const copyAnswer = async (m) => {
    try {
      await navigator.clipboard.writeText(m.content || '');
      setCopiedId(m.id);
      setTimeout(() => setCopiedId((x) => x === m.id ? null : x), 1500);
    } catch { setError('Unable to copy the answer.'); }
  };

  const exportAnswer = (m) => {
    const lines = ['SmartHub Enterprise Agentic RAG', '', m.content, '', 'Citations',
      ...(m.citations || []).map((c) => `${c.citation_id} | ${c.source_name} | ${c.title || ''} | ${JSON.stringify(c.technical || c.locator || {})}`)];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `rag-answer-${m.requestId || 'export'}.txt` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const newConversation = () => {
    stop();
    setMessages([]);
    setEvidence([]);
    setSourceEvents([]);
    setSourceItems(null);
    setSelectedCitation(null);
    setError('');
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="shrink-0 border-b border-jj-gray-03 bg-white">
        <div className="mx-auto flex min-h-[72px] max-w-[1400px] flex-wrap items-center gap-3 px-5 py-3 md:px-7">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.17em] text-jj-red">Enterprise Agentic RAG</p>
            <h1 className="mt-0.5 font-johnson-display text-xl font-bold text-jj-gray-08">RIMDocs grounded intelligence</h1>
          </div>

          <select value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={running} className="max-w-[220px] rounded-xl border border-jj-gray-03 bg-white px-3 py-2.5 text-xs font-medium">
            {!profiles.length && <option>No active profile</option>}
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <button type="button" onClick={() => navigate('/rag/evaluation')} className="inline-flex items-center gap-2 rounded-xl border border-jj-gray-03 px-3.5 py-2.5 text-xs font-bold text-jj-gray-07 hover:bg-jj-gray-01"><FlaskConical className="h-3.5 w-3.5" />Evaluation</button>
          {canManage && <button type="button" onClick={() => setAdminOpen(true)} className="inline-flex items-center gap-2 rounded-xl border border-jj-gray-03 px-3.5 py-2.5 text-xs font-bold text-jj-gray-07 hover:bg-jj-gray-01"><Settings2 className="h-3.5 w-3.5" />Configure</button>}
          <button type="button" onClick={newConversation} className="inline-flex items-center gap-2 rounded-xl bg-jj-gray-08 px-3.5 py-2.5 text-xs font-bold text-white"><MessageSquarePlus className="h-3.5 w-3.5" />New conversation</button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto bg-jj-gray-01/50">
        <div className="mx-auto w-full max-w-5xl px-4 py-7 md:px-6">
          {!messages.length && !running && <EmptyState />}
          <div className="space-y-7">
            {messages.map((m) => m.role === 'user' ? (
              <div key={m.id} className="ml-auto max-w-3xl">
                <p className="mb-1.5 text-right text-[11px] font-bold text-jj-gray-05">You</p>
                <div className="rounded-2xl rounded-br-md border border-jj-gray-03 bg-jj-gray-01 px-4 py-3.5 text-sm leading-6 text-jj-gray-08">{m.content}</div>
              </div>
            ) : (
              <AssistantMessage
                key={m.id}
                message={m}
                onCitation={setSelectedCitation}
                onSources={(message) => setSourceItems(message.citations || [])}
                onFeedback={feedback}
                onExport={exportAnswer}
                onCopy={copyAnswer}
                copied={copiedId === m.id}
              />
            ))}

            {running && (
              <div className="max-w-xl rounded-2xl border border-jj-gray-03 bg-white p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <span className="h-3 w-3 animate-pulse rounded-full bg-jj-red" />
                  <p className="text-sm font-bold text-jj-gray-08">{STAGES[stage] || 'Working'}</p>
                </div>
                {!!sourceEvents.length && <p className="mt-2 text-xs text-jj-gray-05">{sourceEvents.map((s) => `${s.source_name}${s.count == null ? '' : ` (${s.count})`}`).join(' · ')}</p>}
                {!!evidence.length && <p className="mt-1 text-[11px] text-jj-gray-05">{evidence.length} evidence items selected</p>}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>
      </main>

      {error && (
        <div className="shrink-0 border-t border-jj-maroon-05/10 bg-jj-maroon-05/5">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-2.5">
            <p className="text-xs text-jj-maroon-05">{error}</p>
            <button type="button" onClick={() => setError('')}><X className="h-3.5 w-3.5 text-jj-maroon-05" /></button>
          </div>
        </div>
      )}

      <footer className="shrink-0 border-t border-jj-gray-03 bg-white px-4 py-4 md:px-6">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-end gap-2 rounded-2xl border border-jj-gray-03 p-2 shadow-sm focus-within:border-jj-red/25 focus-within:ring-2 focus-within:ring-jj-red/10">
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }}
              placeholder="Ask about configured RIMDocs sources..."
              rows={1}
              disabled={running || !profileId}
              className="max-h-40 min-h-[46px] flex-1 resize-none border-0 bg-transparent px-3 py-3 text-sm outline-none"
            />
            {running
              ? <button type="button" onClick={stop} className="inline-flex h-11 items-center gap-2 rounded-xl border border-jj-maroon-05/30 px-4 text-sm font-bold text-jj-maroon-05"><Square className="h-3.5 w-3.5 fill-current" />Stop</button>
              : <button type="button" onClick={ask} disabled={!query.trim() || !profileId} className="inline-flex h-11 items-center gap-2 rounded-xl bg-jj-red px-4 text-sm font-bold text-white disabled:opacity-40"><Send className="h-4 w-4" />Ask</button>}
          </div>
          <p className="mt-2 text-center text-[10px] text-jj-gray-05">Grounded narrative + validated business visuals + technical lineage.</p>
        </div>
      </footer>

      <SourcesDrawer items={sourceItems} onClose={() => setSourceItems(null)} onOpenCitation={(c) => setSelectedCitation(c)} />
      <CitationDrawer citation={selectedCitation} onClose={() => setSelectedCitation(null)} />

      {adminOpen && (
        <AdminPanel onClose={() => {
          setAdminOpen(false);
          apiJson('/rag/profiles').then((d) => {
            const list = d.profiles || [];
            setProfiles(list);
            if (list.length && !list.some((p) => p.id === profileId)) {
              setProfileId(list.find((p) => p.config?.default)?.id || list[0].id);
            }
          }).catch(() => {});
        }} />
      )}
    </div>
  );
}
