import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  Copy,
  Database,
  Download,
  FlaskConical,
  Info,
  MessageSquarePlus,
  PanelRightOpen,
  Search,
  Send,
  Settings2,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react';

import { apiEventSource, apiJson } from '../utils/apiClient';
import { useRBAC } from '../context/RBACContext';


/* ============================================================================
 * Runtime helpers
 * ========================================================================== */

const STAGES = {
  analyzing: 'Understanding your question',
  routing: 'Selecting relevant sources',
  retrieving: 'Searching approved sources',
  reranking: 'Prioritizing the best evidence',
  generating: 'Writing a grounded answer',
  verifying: 'Verifying claims against evidence',
  repairing: 'Removing unsupported claims',
};


function verificationLabel(verification) {
  const state = verification?.state;
  const reason = verification?.reason;

  if (state === 'verified') {
    return 'Verified';
  }

  if (
    state === 'uncertain'
    && reason === 'Verification disabled.'
  ) {
    return 'Verification off';
  }

  if (state === 'failed') {
    return 'Verification failed';
  }

  if (state === 'unavailable') {
    return 'Verification unavailable';
  }

  if (state === 'uncertain') {
    return 'Not verified';
  }

  return 'Not verified';
}


function verificationTone(verification) {
  const state = verification?.state;

  if (state === 'verified') {
    return 'border-jj-green-03/30 bg-jj-green-03/10 text-jj-green-05';
  }

  if (state === 'failed' || state === 'unavailable') {
    return 'border-jj-maroon-05/20 bg-jj-maroon-05/10 text-jj-maroon-05';
  }

  return 'border-jj-gray-03 bg-jj-gray-01 text-jj-gray-06';
}


function verificationIcon(verification) {
  if (verification?.state === 'verified') {
    return <CheckCircle2 className="h-3.5 w-3.5" />;
  }

  return <Info className="h-3.5 w-3.5" />;
}


function sourceText(item) {
  return item?.text || item?.snippet || '';
}


function sourceTitle(item) {
  return (
    item?.title
    || item?.document_title
    || item?.document_name
    || item?.file_name
    || item?.source_name
    || 'Source'
  );
}


/* ============================================================================
 * Markdown / citation rendering
 * ========================================================================== */

function prepareMarkdown(answer, citations) {
  const byEvidenceId = Object.fromEntries(
    (citations || []).map((citation) => [
      citation.evidence_id,
      citation,
    ]),
  );

  return String(answer || '').replace(
    /\[cite:([A-Za-z0-9_.:-]+)\]/g,
    (_, evidenceId) => {
      const citation = byEvidenceId[evidenceId];

      if (!citation) {
        return '';
      }

      /*
       * Use a hash URL because ReactMarkdown safely preserves it.
       * We intercept it in the custom anchor renderer below.
       */
      return `[${citation.citation_id}](#citation-${evidenceId})`;
    },
  );
}


function AnswerMarkdown({
  answer,
  citations,
  onCitation,
}) {
  const markdown = useMemo(
    () => prepareMarkdown(answer, citations),
    [answer, citations],
  );

  return (
    <div className="rag-answer">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-4 mt-7 font-johnson-display text-2xl font-bold leading-tight text-jj-gray-08 first:mt-0">
              {children}
            </h1>
          ),

          h2: ({ children }) => (
            <h2 className="mb-3 mt-7 font-johnson-display text-xl font-bold leading-tight text-jj-gray-08 first:mt-0">
              {children}
            </h2>
          ),

          h3: ({ children }) => (
            <h3 className="mb-2 mt-6 font-johnson-display text-lg font-bold leading-snug text-jj-gray-08 first:mt-0">
              {children}
            </h3>
          ),

          h4: ({ children }) => (
            <h4 className="mb-2 mt-5 font-johnson-text text-[15px] font-bold text-jj-gray-08">
              {children}
            </h4>
          ),

          p: ({ children }) => (
            <p className="mb-4 font-johnson-text text-[15px] leading-7 text-jj-gray-08 last:mb-0">
              {children}
            </p>
          ),

          strong: ({ children }) => (
            <strong className="font-bold text-jj-gray-08">
              {children}
            </strong>
          ),

          em: ({ children }) => (
            <em className="italic text-jj-gray-07">
              {children}
            </em>
          ),

          ul: ({ children }) => (
            <ul className="mb-5 ml-6 list-disc space-y-2 font-johnson-text text-[15px] leading-7 text-jj-gray-08">
              {children}
            </ul>
          ),

          ol: ({ children }) => (
            <ol className="mb-5 ml-6 list-decimal space-y-2 font-johnson-text text-[15px] leading-7 text-jj-gray-08">
              {children}
            </ol>
          ),

          li: ({ children }) => (
            <li className="pl-1">
              {children}
            </li>
          ),

          blockquote: ({ children }) => (
            <blockquote className="my-5 rounded-r-xl border-l-4 border-jj-red/30 bg-jj-gray-01 px-5 py-4 text-jj-gray-07">
              {children}
            </blockquote>
          ),

          hr: () => (
            <hr className="my-6 border-jj-gray-03" />
          ),

          table: ({ children }) => (
            <div className="my-5 overflow-x-auto rounded-xl border border-jj-gray-03">
              <table className="min-w-full border-collapse text-left font-johnson-text text-sm">
                {children}
              </table>
            </div>
          ),

          thead: ({ children }) => (
            <thead className="bg-jj-gray-01 text-jj-gray-08">
              {children}
            </thead>
          ),

          th: ({ children }) => (
            <th className="border-b border-jj-gray-03 px-4 py-3 font-bold">
              {children}
            </th>
          ),

          td: ({ children }) => (
            <td className="border-b border-jj-gray-02 px-4 py-3 align-top text-jj-gray-07">
              {children}
            </td>
          ),

          pre: ({ children }) => (
            <pre className="my-5 overflow-x-auto rounded-xl bg-jj-gray-08 p-4 font-mono text-[13px] leading-6 text-white">
              {children}
            </pre>
          ),

          code: ({ children }) => (
            <code className="rounded bg-jj-gray-01 px-1.5 py-0.5 font-mono text-[13px] text-jj-gray-08">
              {children}
            </code>
          ),

          a: ({
            href,
            children,
          }) => {
            if (href?.startsWith('#citation-')) {
              const evidenceId = href.slice('#citation-'.length);

              const citation = (citations || []).find(
                (item) => item.evidence_id === evidenceId,
              );

              return (
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();

                    if (citation) {
                      onCitation(citation);
                    }
                  }}
                  className="mx-0.5 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full border border-jj-red/15 bg-jj-red/5 px-1.5 align-text-top font-johnson-text text-[10px] font-bold leading-none text-jj-red transition hover:border-jj-red/30 hover:bg-jj-red/10"
                  title={
                    citation?.title
                    || citation?.source_name
                    || 'Open citation'
                  }
                >
                  {children}
                </button>
              );
            }

            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-jj-red underline decoration-jj-red/30 underline-offset-2 hover:decoration-jj-red"
              >
                {children}
              </a>
            );
          },

          img: () => null,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}


/* ============================================================================
 * Source UI
 * ========================================================================== */

function SourceCard({
  item,
  onOpen,
  index,
}) {
  const text = sourceText(item);

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="group w-full rounded-xl border border-jj-gray-03 bg-white p-4 text-left transition hover:border-jj-red/25 hover:shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-jj-gray-01 font-johnson-text text-[11px] font-bold text-jj-gray-06">
          {item?.citation_id || index || <Database className="h-4 w-4" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="line-clamp-2 font-johnson-display text-sm font-bold leading-5 text-jj-gray-08">
                {sourceTitle(item)}
              </p>

              <p className="mt-1 truncate font-johnson-text text-[11px] text-jj-gray-05">
                {item?.source_name || 'Source'}
                {item?.source_type
                  ? ` · ${item.source_type.replaceAll('_', ' ')}`
                  : ''}
              </p>
            </div>

            <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-jj-gray-04 transition group-hover:translate-x-0.5 group-hover:text-jj-red" />
          </div>

          {!!text && (
            <p className="mt-3 line-clamp-3 font-johnson-text text-xs leading-5 text-jj-gray-06">
              {text}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}


function SourcesDrawer({
  drawer,
  onClose,
  onOpenEvidence,
}) {
  if (!drawer) {
    return null;
  }

  const items = drawer.items || [];

  return (
    <div
      className="fixed inset-0 z-[85] flex justify-end bg-black/20"
      onMouseDown={onClose}
    >
      <aside
        className="flex h-full w-full max-w-md flex-col border-l border-jj-gray-03 bg-jj-gray-01 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-jj-gray-03 bg-white px-5 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-jj-red" />

                <p className="font-johnson-text text-xs font-bold uppercase tracking-[0.12em] text-jj-red">
                  Sources
                </p>
              </div>

              <h2 className="mt-2 font-johnson-display text-xl font-bold text-jj-gray-08">
                {drawer.title || 'Sources used'}
              </h2>

              <p className="mt-1 font-johnson-text text-xs leading-5 text-jj-gray-06">
                These are the sources cited by the generated answer.
              </p>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-jj-gray-03 bg-white p-2 text-jj-gray-06 transition hover:bg-jj-gray-01 hover:text-jj-gray-08"
              aria-label="Close sources"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <span className="rounded-full bg-jj-gray-01 px-2.5 py-1 font-johnson-text text-[11px] font-bold text-jj-gray-06">
              {items.length} cited {items.length === 1 ? 'source' : 'sources'}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {items.length > 0 ? (
            <div className="space-y-3">
              {items.map((item, index) => (
                <SourceCard
                  key={
                    item.evidence_id
                    || item.citation_id
                    || `${item.source_name}-${index}`
                  }
                  item={item}
                  index={index + 1}
                  onOpen={onOpenEvidence}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-jj-gray-03 bg-white p-8 text-center">
              <BookOpen className="mx-auto h-6 w-6 text-jj-gray-04" />

              <p className="mt-3 font-johnson-text text-sm text-jj-gray-06">
                No cited sources are available for this answer.
              </p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}


function EvidenceDrawer({
  item,
  onClose,
}) {
  if (!item) {
    return null;
  }

  const content = sourceText(item);

  return (
    <div
      className="fixed inset-0 z-[95] flex justify-end bg-black/25"
      onMouseDown={onClose}
    >
      <aside
        className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="border-b border-jj-gray-03 px-6 py-5">
          <div className="flex items-start justify-between gap-5">
            <div className="min-w-0">
              <p className="font-johnson-text text-[11px] font-bold uppercase tracking-[0.14em] text-jj-red">
                Supporting evidence
              </p>

              <h2 className="mt-2 font-johnson-display text-2xl font-bold leading-tight text-jj-gray-08">
                {sourceTitle(item)}
              </h2>

              <div className="mt-2 flex flex-wrap items-center gap-2 font-johnson-text text-xs text-jj-gray-05">
                <span>{item.source_name || 'Source'}</span>

                {!!item.source_type && (
                  <>
                    <span>·</span>
                    <span>
                      {item.source_type.replaceAll('_', ' ')}
                    </span>
                  </>
                )}

                {!!item.citation_id && (
                  <>
                    <span>·</span>
                    <span>{item.citation_id}</span>
                  </>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-jj-gray-03 p-2 text-jj-gray-06 hover:bg-jj-gray-01 hover:text-jj-gray-08"
              aria-label="Close evidence"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          <section>
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-jj-red" />

              <h3 className="font-johnson-text text-sm font-bold text-jj-gray-08">
                Supporting content
              </h3>
            </div>

            <div className="mt-3 rounded-xl border border-jj-gray-03 bg-jj-gray-01/60 p-5">
              <p className="whitespace-pre-wrap font-johnson-text text-sm leading-7 text-jj-gray-08">
                {content || 'No supporting text was returned.'}
              </p>
            </div>
          </section>

          {!!item.locator && (
            <details className="mt-6 rounded-xl border border-jj-gray-03 bg-white">
              <summary className="cursor-pointer px-4 py-3 font-johnson-text text-xs font-bold text-jj-gray-06">
                Technical source details
              </summary>

              <div className="border-t border-jj-gray-03 p-4">
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-jj-gray-08 p-4 font-mono text-[11px] leading-5 text-white">
                  {JSON.stringify(item.locator, null, 2)}
                </pre>
              </div>
            </details>
          )}
        </div>
      </aside>
    </div>
  );
}


/* ============================================================================
 * Configuration panel
 * ========================================================================== */

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
    const [sourceData, profileData, catalogData] = await Promise.all([
      apiJson('/rag/admin/sources'),
      apiJson('/rag/admin/profiles'),
      apiJson('/rag/admin/data-api-catalog'),
    ]);

    setSources(sourceData.sources || []);
    setProfiles(profileData.profiles || []);
    setCatalog(catalogData.apis || []);
  };


  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);


  const reset = (nextKind = kind) => {
    setKind(nextKind);
    setEditing(null);
    setName('');
    setDescription('');
    setSourceType('data_api');

    setConfig(
      nextKind === 'profile'
        ? JSON.stringify(
          {
            default: false,
            source_ids: [],
            source_only: true,
            decompose: false,
            route_sources: false,
            rerank: true,
            verify: true,
            require_verification: true,
            candidate_k: 20,
            final_k: 8,
            repair_attempts: 1,
          },
          null,
          2,
        )
        : '{}',
    );

    setIsActive(true);
    setError('');
  };


  const edit = (row, nextKind) => {
    setKind(nextKind);
    setEditing(row);
    setName(row.name);
    setDescription(row.description || '');
    setIsActive(row.is_active !== false);

    if (nextKind === 'source') {
      setSourceType(row.source_type);
    }

    setConfig(JSON.stringify(row.config || {}, null, 2));
  };


  const parsedProfileConfig = useMemo(() => {
    if (kind !== 'profile') {
      return null;
    }

    try {
      return JSON.parse(config || '{}');
    } catch {
      return null;
    }
  }, [config, kind]);


  const toggleProfileSource = (sourceId) => {
    let parsed;

    try {
      parsed = JSON.parse(config || '{}');
    } catch {
      setError(
        'Fix the configuration JSON before changing the source selection.',
      );
      return;
    }

    const current = new Set(parsed.source_ids || []);

    if (current.has(sourceId)) {
      current.delete(sourceId);
    } else {
      current.add(sourceId);
    }

    setConfig(
      JSON.stringify(
        {
          ...parsed,
          source_ids: Array.from(current),
        },
        null,
        2,
      ),
    );

    setError('');
  };


  const save = async () => {
    setError('');

    let parsed;

    try {
      parsed = JSON.parse(config || '{}');
    } catch {
      setError('Configuration must be valid JSON.');
      return;
    }

    const path = (
      kind === 'source'
        ? '/rag/admin/sources'
        : '/rag/admin/profiles'
    );

    const body = (
      kind === 'source'
        ? {
          name,
          description,
          source_type: sourceType,
          config: parsed,
          is_active: isActive,
        }
        : {
          name,
          description,
          config: parsed,
          is_active: isActive,
        }
    );

    try {
      await apiJson(
        editing
          ? `${path}/${editing.id}`
          : path,
        {
          method: editing ? 'PUT' : 'POST',
          body,
        },
      );

      await load();
      reset(kind);
    } catch (err) {
      setError(err.message);
    }
  };


  const remove = async (row, nextKind) => {
    if (!window.confirm(`Delete ${row.name}?`)) {
      return;
    }

    try {
      await apiJson(
        `/rag/admin/${
          nextKind === 'source'
            ? 'sources'
            : 'profiles'
        }/${row.id}`,
        {
          method: 'DELETE',
        },
      );

      await load();

      if (editing?.id === row.id) {
        reset(nextKind);
      }
    } catch (err) {
      setError(err.message);
    }
  };


  const selectDataApiAlias = (api, table) => {
    setKind('source');
    setEditing(null);
    setSourceType('data_api');

    setName(`${api.name} / ${table.alias}`);

    setDescription(
      `Agentic RAG source backed by SmartHub Data API alias ${table.alias}.`,
    );

    setConfig(
      JSON.stringify(
        {
          api_id: api.id,
          alias: table.alias,
          mode: 'auto',
        },
        null,
        2,
      ),
    );
  };


  const selectedProfileSources = new Set(
    parsedProfileConfig?.source_ids || [],
  );


  return (
    <div
      className="fixed inset-0 z-[80] bg-black/25 p-3 md:p-6"
      onMouseDown={onClose}
    >
      <div
        className="mx-auto flex h-full max-w-7xl overflow-hidden rounded-2xl border border-jj-gray-03 bg-white shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {/* Left navigation */}
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-jj-gray-03 bg-jj-gray-01/60 p-4">
          <div className="flex rounded-xl border border-jj-gray-03 bg-white p-1">
            {[
              ['source', 'Sources'],
              ['profile', 'Profiles'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => reset(value)}
                className={`flex-1 rounded-lg px-3 py-2 font-johnson-text text-xs font-bold transition ${
                  kind === value
                    ? 'bg-jj-gray-08 text-white'
                    : 'text-jj-gray-06 hover:bg-jj-gray-01'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => reset(kind)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-jj-red px-3 py-2.5 font-johnson-text text-sm font-bold text-white hover:opacity-95"
          >
            <MessageSquarePlus className="h-4 w-4" />
            New {kind}
          </button>

          <div className="mt-4 space-y-2">
            {(kind === 'source' ? sources : profiles).map((row) => (
              <div
                key={row.id}
                className={`rounded-xl border bg-white p-3 transition ${
                  editing?.id === row.id
                    ? 'border-jj-red/30 shadow-sm'
                    : 'border-jj-gray-03'
                }`}
              >
                <button
                  type="button"
                  onClick={() => edit(row, kind)}
                  className="w-full text-left"
                >
                  <p className="line-clamp-2 font-johnson-display text-sm font-bold text-jj-gray-08">
                    {row.name}
                  </p>

                  <p className="mt-1 font-johnson-text text-[11px] text-jj-gray-05">
                    {kind === 'source'
                      ? row.source_type.replaceAll('_', ' ')
                      : `${(row.config?.source_ids || []).length} source${
                        (row.config?.source_ids || []).length === 1
                          ? ''
                          : 's'
                      }`}
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => remove(row, kind)}
                  className="mt-2 font-johnson-text text-[11px] font-bold text-jj-maroon-05 hover:underline"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </aside>

        {/* Editor */}
        <main className="flex-1 overflow-y-auto p-6 md:p-8">
          <div className="mx-auto max-w-4xl">
            <div className="flex items-start justify-between gap-6">
              <div>
                <div className="flex items-center gap-2">
                  <Settings2 className="h-4 w-4 text-jj-red" />

                  <p className="font-johnson-text text-xs font-bold uppercase tracking-[0.13em] text-jj-red">
                    Agentic RAG configuration
                  </p>
                </div>

                <h2 className="mt-2 font-johnson-display text-2xl font-bold text-jj-gray-08">
                  {editing
                    ? `Edit ${kind}`
                    : `Create ${kind}`}
                </h2>

                <p className="mt-1 font-johnson-text text-sm text-jj-gray-06">
                  {kind === 'source'
                    ? 'Connect an approved enterprise data source.'
                    : 'Choose which sources and RAG behavior this profile should use.'}
                </p>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-jj-gray-03 p-2 text-jj-gray-06 hover:bg-jj-gray-01"
                aria-label="Close configuration"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-7 grid gap-5 md:grid-cols-2">
              <label className="font-johnson-text text-xs font-bold text-jj-gray-07">
                Name

                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-jj-gray-03 px-3.5 py-2.5 font-johnson-text text-sm font-normal text-jj-gray-08 outline-none focus:border-jj-red/30 focus:ring-2 focus:ring-jj-red/10"
                />
              </label>

              {kind === 'source' && (
                <label className="font-johnson-text text-xs font-bold text-jj-gray-07">
                  Source type

                  <select
                    value={sourceType}
                    onChange={(event) => setSourceType(event.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-jj-gray-03 bg-white px-3.5 py-2.5 font-johnson-text text-sm font-normal text-jj-gray-08 outline-none focus:border-jj-red/30"
                  >
                    <option value="data_api">
                      SmartHub Data API
                    </option>

                    <option value="connector">
                      Existing JDBC / DB connector
                    </option>

                    <option value="rest">
                      External REST API
                    </option>
                  </select>
                </label>
              )}

              <label className="font-johnson-text text-xs font-bold text-jj-gray-07 md:col-span-2">
                Description

                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-jj-gray-03 px-3.5 py-2.5 font-johnson-text text-sm font-normal text-jj-gray-08 outline-none focus:border-jj-red/30 focus:ring-2 focus:ring-jj-red/10"
                />
              </label>
            </div>

            {/* Friendly source selector for profiles */}
            {kind === 'profile' && sources.length > 0 && (
              <section className="mt-7">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-jj-gray-06" />

                  <h3 className="font-johnson-text text-sm font-bold text-jj-gray-08">
                    Sources
                  </h3>
                </div>

                <p className="mt-1 font-johnson-text text-xs text-jj-gray-05">
                  Select the enterprise sources this profile is allowed to use.
                </p>

                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {sources
                    .filter((source) => source.is_active !== false)
                    .map((source) => {
                      const selected = selectedProfileSources.has(
                        source.id,
                      );

                      return (
                        <button
                          key={source.id}
                          type="button"
                          onClick={() => toggleProfileSource(source.id)}
                          className={`flex items-start gap-3 rounded-xl border p-3 text-left transition ${
                            selected
                              ? 'border-jj-red/30 bg-jj-red/5'
                              : 'border-jj-gray-03 bg-white hover:bg-jj-gray-01'
                          }`}
                        >
                          <span
                            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                              selected
                                ? 'border-jj-red bg-jj-red text-white'
                                : 'border-jj-gray-04 bg-white'
                            }`}
                          >
                            {selected && <Check className="h-3.5 w-3.5" />}
                          </span>

                          <span className="min-w-0">
                            <span className="block font-johnson-text text-sm font-bold text-jj-gray-08">
                              {source.name}
                            </span>

                            <span className="mt-0.5 block font-johnson-text text-[11px] text-jj-gray-05">
                              {source.source_type.replaceAll('_', ' ')}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                </div>
              </section>
            )}

            {/* Advanced JSON */}
            <section className="mt-7">
              <div>
                <h3 className="font-johnson-text text-sm font-bold text-jj-gray-08">
                  Advanced configuration
                </h3>

                <p className="mt-1 font-johnson-text text-xs text-jj-gray-05">
                  Runtime settings are stored as JSON. Most users only need to select sources above.
                </p>
              </div>

              <textarea
                value={config}
                onChange={(event) => setConfig(event.target.value)}
                rows={14}
                spellCheck={false}
                className="mt-3 w-full rounded-xl border border-jj-gray-03 bg-jj-gray-08 p-4 font-mono text-xs leading-5 text-white outline-none focus:ring-2 focus:ring-jj-red/20"
              />
            </section>

            <div className="mt-5 flex items-center gap-2">
              <input
                id="rag-active"
                type="checkbox"
                checked={isActive}
                onChange={(event) => setIsActive(event.target.checked)}
                className="h-4 w-4"
              />

              <label
                htmlFor="rag-active"
                className="font-johnson-text text-sm text-jj-gray-07"
              >
                Active
              </label>
            </div>

            {!!error && (
              <div className="mt-5 rounded-xl border border-jj-maroon-05/15 bg-jj-maroon-05/10 px-4 py-3 font-johnson-text text-sm text-jj-maroon-05">
                {error}
              </div>
            )}

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={save}
                disabled={!name.trim()}
                className="rounded-xl bg-jj-red px-5 py-2.5 font-johnson-text text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                Save
              </button>
            </div>

            {/* Data API catalog */}
            {kind === 'source' && sourceType === 'data_api' && (
              <section className="mt-10 border-t border-jj-gray-03 pt-7">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-jj-red" />

                  <h3 className="font-johnson-display text-lg font-bold text-jj-gray-08">
                    Reuse a Data API Export
                  </h3>
                </div>

                <p className="mt-1 font-johnson-text text-xs leading-5 text-jj-gray-06">
                  Select an existing Data API alias. Semantic or hybrid retrieval is used when configured; otherwise SmartHub safely falls back to live text search.
                </p>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {catalog.flatMap((api) => (
                    (api.tables || []).map((table) => (
                      <button
                        key={`${api.id}:${table.id}`}
                        type="button"
                        onClick={() => selectDataApiAlias(api, table)}
                        className="group rounded-xl border border-jj-gray-03 bg-white p-4 text-left transition hover:border-jj-red/25 hover:shadow-sm"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-johnson-text text-sm font-bold text-jj-gray-08">
                              {api.name}
                            </p>

                            <p className="mt-0.5 font-johnson-text text-xs text-jj-red">
                              {table.alias}
                            </p>

                            <p className="mt-2 truncate font-johnson-text text-[11px] text-jj-gray-05">
                              {table.source_system}
                              {' · '}
                              {table.database_name || 'default'}
                              {' · '}
                              {table.schema_name || ''}
                              .
                              {table.table_name}
                            </p>
                          </div>

                          <ChevronRight className="h-4 w-4 shrink-0 text-jj-gray-04 transition group-hover:translate-x-0.5 group-hover:text-jj-red" />
                        </div>
                      </button>
                    ))
                  ))}

                  {!catalog.some((api) => (api.tables || []).length) && (
                    <div className="rounded-xl border border-dashed border-jj-gray-03 p-6 font-johnson-text text-sm text-jj-gray-05 md:col-span-2">
                      No Data API exports are available.
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}


/* ============================================================================
 * Legacy fallback
 * ========================================================================== */

function LegacyFallback() {
  const url = import.meta.env.VITE_API_RIMDOCS_AGENTIC_URL;

  return (
    <div className="h-full bg-jj-gray-01 p-6">
      <div className="h-full overflow-hidden rounded-xl border border-jj-gray-03 bg-white">
        <iframe
          src={url}
          title="Legacy RIMDocs Agentic"
          className="h-full w-full border-0"
        />
      </div>
    </div>
  );
}


/* ============================================================================
 * Conversation UI
 * ========================================================================== */

function EmptyState() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center px-6 py-16 text-center md:py-24">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-jj-red/10">
        <Search className="h-6 w-6 text-jj-red" />
      </div>

      <h2 className="mt-5 font-johnson-display text-3xl font-bold tracking-tight text-jj-gray-08">
        Ask your enterprise knowledge
      </h2>

      <p className="mt-3 max-w-2xl font-johnson-text text-sm leading-6 text-jj-gray-06">
        Ask questions across approved RIMDocs sources. SmartHub retrieves supporting evidence and keeps citations attached to the answer.
      </p>

      <div className="mt-7 grid w-full gap-3 text-left sm:grid-cols-3">
        <div className="rounded-xl border border-jj-gray-03 bg-white p-4">
          <Search className="h-4 w-4 text-jj-red" />

          <p className="mt-3 font-johnson-text text-xs font-bold text-jj-gray-08">
            Find information
          </p>

          <p className="mt-1 font-johnson-text text-[11px] leading-5 text-jj-gray-05">
            Search approved enterprise content using natural language.
          </p>
        </div>

        <div className="rounded-xl border border-jj-gray-03 bg-white p-4">
          <BookOpen className="h-4 w-4 text-jj-red" />

          <p className="mt-3 font-johnson-text text-xs font-bold text-jj-gray-08">
            Inspect sources
          </p>

          <p className="mt-1 font-johnson-text text-[11px] leading-5 text-jj-gray-05">
            Open citations to review the exact supporting evidence.
          </p>
        </div>

        <div className="rounded-xl border border-jj-gray-03 bg-white p-4">
          <CheckCircle2 className="h-4 w-4 text-jj-red" />

          <p className="mt-3 font-johnson-text text-xs font-bold text-jj-gray-08">
            Ground answers
          </p>

          <p className="mt-1 font-johnson-text text-[11px] leading-5 text-jj-gray-05">
            Keep generated answers tied back to enterprise evidence.
          </p>
        </div>
      </div>
    </div>
  );
}


function UserMessage({ message }) {
  return (
    <div className="ml-auto w-full max-w-3xl">
      <div className="mb-1.5 text-right font-johnson-text text-[11px] font-bold text-jj-gray-05">
        You
      </div>

      <div className="rounded-2xl rounded-br-md border border-jj-gray-03 bg-jj-gray-01 px-4 py-3.5 font-johnson-text text-[14px] leading-6 text-jj-gray-08">
        {message.content}
      </div>
    </div>
  );
}


function AssistantMessage({
  message,
  onCitation,
  onSources,
  onFeedback,
  onExport,
  onCopy,
  copied,
  diagnosticsOpen,
  onToggleDiagnostics,
}) {
  const sourceCount = (
    message.citations?.length
    || message.evidence?.length
    || 0
  );

  return (
    <article className="w-full">
      <div className="mb-2 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-jj-red text-[11px] font-bold text-white">
          AI
        </div>

        <span className="font-johnson-text text-xs font-bold text-jj-gray-07">
          SmartHub
        </span>

        <span
          className={`ml-1 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-johnson-text text-[10px] font-bold ${verificationTone(message.verification)}`}
        >
          {verificationIcon(message.verification)}
          {verificationLabel(message.verification)}
        </span>
      </div>

      <div className="rounded-2xl border border-jj-gray-03 bg-white px-5 py-5 shadow-sm md:px-7 md:py-6">
        {message.insufficient ? (
          <div className="rounded-xl border border-jj-gray-03 bg-jj-gray-01 p-4">
            <p className="font-johnson-text text-sm leading-6 text-jj-gray-07">
              {message.content}
            </p>
          </div>
        ) : (
          <AnswerMarkdown
            answer={message.content}
            citations={message.citations || []}
            onCitation={onCitation}
          />
        )}

        <div className="mt-6 flex flex-wrap items-center gap-x-1 gap-y-2 border-t border-jj-gray-02 pt-4">
          {sourceCount > 0 && (
            <button
              type="button"
              onClick={() => onSources(message)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-johnson-text text-xs font-bold text-jj-gray-06 transition hover:bg-jj-gray-01 hover:text-jj-gray-08"
            >
              <BookOpen className="h-3.5 w-3.5" />
              Sources
              <span className="rounded-full bg-jj-gray-01 px-1.5 py-0.5 text-[10px]">
                {sourceCount}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={() => onCopy(message)}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-johnson-text text-xs text-jj-gray-06 transition hover:bg-jj-gray-01 hover:text-jj-gray-08"
          >
            {copied
              ? <Check className="h-3.5 w-3.5" />
              : <Copy className="h-3.5 w-3.5" />}

            {copied ? 'Copied' : 'Copy'}
          </button>

          <button
            type="button"
            onClick={() => onExport(message)}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-johnson-text text-xs text-jj-gray-06 transition hover:bg-jj-gray-01 hover:text-jj-gray-08"
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </button>

          <div className="mx-1 h-4 w-px bg-jj-gray-03" />

          <button
            type="button"
            onClick={() => onFeedback(message, 1)}
            className="rounded-lg p-1.5 text-jj-gray-05 transition hover:bg-jj-gray-01 hover:text-jj-gray-08"
            aria-label="Helpful"
            title="Helpful"
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={() => onFeedback(message, -1)}
            className="rounded-lg p-1.5 text-jj-gray-05 transition hover:bg-jj-gray-01 hover:text-jj-gray-08"
            aria-label="Not helpful"
            title="Not helpful"
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={() => onToggleDiagnostics(message.id)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-johnson-text text-xs text-jj-gray-05 transition hover:bg-jj-gray-01 hover:text-jj-gray-08"
          >
            <Info className="h-3.5 w-3.5" />
            Diagnostics
          </button>
        </div>

        {diagnosticsOpen && (
          <div className="mt-4 overflow-hidden rounded-xl border border-jj-gray-03">
            <div className="flex items-center justify-between border-b border-jj-gray-03 bg-jj-gray-01 px-4 py-2.5">
              <span className="font-johnson-text text-[11px] font-bold uppercase tracking-wide text-jj-gray-06">
                Diagnostics
              </span>

              {!!message.requestId && (
                <span className="font-mono text-[10px] text-jj-gray-05">
                  {message.requestId}
                </span>
              )}
            </div>

            <pre className="max-h-80 overflow-auto bg-jj-gray-08 p-4 font-mono text-[11px] leading-5 text-white">
              {JSON.stringify(message.diagnostics || {}, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </article>
  );
}


function RunningMessage({
  stage,
  sourceEvents,
  evidenceCount,
}) {
  return (
    <div className="w-full max-w-xl">
      <div className="mb-2 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-jj-red text-[11px] font-bold text-white">
          AI
        </div>

        <span className="font-johnson-text text-xs font-bold text-jj-gray-07">
          SmartHub
        </span>
      </div>

      <div className="rounded-2xl border border-jj-gray-03 bg-white px-5 py-4 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-jj-red opacity-25" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-jj-red" />
          </span>

          <p className="font-johnson-text text-sm font-bold text-jj-gray-08">
            {STAGES[stage] || 'Working'}
          </p>
        </div>

        {!!sourceEvents.length && (
          <p className="mt-2 font-johnson-text text-xs leading-5 text-jj-gray-05">
            {sourceEvents
              .map((source) => (
                `${source.source_name}${
                  source.count == null
                    ? ''
                    : ` (${source.count})`
                }`
              ))
              .join(' · ')}
          </p>
        )}

        {evidenceCount > 0 && (
          <p className="mt-1 font-johnson-text text-[11px] text-jj-gray-05">
            {evidenceCount} evidence item
            {evidenceCount === 1 ? '' : 's'} selected
          </p>
        )}
      </div>
    </div>
  );
}


/* ============================================================================
 * Main page
 * ========================================================================== */

export default function RimDocsAgentic() {
  const navigate = useNavigate();

  const { hasPermission } = useRBAC();

  const canManage = hasPermission('manageDataAPIExports');

  const nativeEnabled = (
    import.meta.env.VITE_RAG_NATIVE_ENABLED !== 'false'
  );


  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState('');

  const [messages, setMessages] = useState([]);
  const [query, setQuery] = useState('');

  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState('');

  const [sourceEvents, setSourceEvents] = useState([]);
  const [evidence, setEvidence] = useState([]);

  const [selectedEvidence, setSelectedEvidence] = useState(null);
  const [sourcesDrawer, setSourcesDrawer] = useState(null);

  const [diagnosticsId, setDiagnosticsId] = useState(null);
  const [copiedId, setCopiedId] = useState(null);

  const [adminOpen, setAdminOpen] = useState(false);
  const [error, setError] = useState('');

  const streamRef = useRef(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);


  useEffect(() => {
    if (!nativeEnabled) {
      return;
    }

    apiJson('/rag/profiles')
      .then((data) => {
        const list = data.profiles || [];

        setProfiles(list);

        if (list.length) {
          setProfileId(
            list.find((profile) => profile.config?.default)?.id
            || list[0].id,
          );
        }
      })
      .catch((err) => setError(err.message));
  }, [nativeEnabled]);


  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'end',
    });
  }, [messages, stage, running]);


  const history = useMemo(
    () => (
      messages
        .slice(-12)
        .map((message) => ({
          role: message.role,
          content: message.content,
        }))
    ),
    [messages],
  );


  if (!nativeEnabled) {
    return <LegacyFallback />;
  }


  const stop = () => {
    streamRef.current?.close();
    streamRef.current = null;

    setRunning(false);
    setStage('');
  };


  const ask = () => {
    const text = query.trim();

    if (!text || running || !profileId) {
      return;
    }

    setError('');
    setRunning(true);
    setStage('analyzing');

    setSourceEvents([]);
    setEvidence([]);

    setMessages((previous) => [
      ...previous,
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
      },
    ]);

    setQuery('');

    const eventSource = apiEventSource(
      '/rag/query/stream',
      {
        method: 'POST',
        body: {
          query: text,
          profile_id: profileId,
          history,
        },
      },
    );

    streamRef.current = eventSource;


    const parse = (event) => {
      try {
        return JSON.parse(event.data || '{}');
      } catch {
        return {};
      }
    };


    eventSource.addEventListener(
      'status',
      (event) => {
        const data = parse(event);

        setStage(data.state || '');

        if (data.sources) {
          setSourceEvents(
            data.sources.map((source) => ({
              source_id: source.id,
              source_name: source.name,
              count: null,
            })),
          );
        }
      },
    );


    eventSource.addEventListener(
      'source',
      (event) => {
        const data = parse(event);

        setSourceEvents((previous) => [
          ...previous.filter(
            (source) => source.source_id !== data.source_id,
          ),
          data,
        ]);
      },
    );


    eventSource.addEventListener(
      'retrieval',
      (event) => {
        const data = parse(event);

        setEvidence(data.evidence || []);
      },
    );


    eventSource.addEventListener(
      'done',
      (event) => {
        const data = parse(event);
        const result = data.result;

        if (result) {
          setEvidence(result.evidence || []);

          setMessages((previous) => [
            ...previous,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: result.answer || '',
              requestId: result.request_id,
              citations: result.citations || [],
              evidence: result.evidence || [],
              verification: result.verification || {},
              diagnostics: result.diagnostics || {},
              insufficient: result.insufficient_evidence,
            },
          ]);
        }

        streamRef.current = null;

        setRunning(false);
        setStage('');
      },
    );


    eventSource.addEventListener(
      'error',
      (event) => {
        const data = parse(event);

        setError(
          data.message
          || 'Agentic RAG request failed.',
        );

        streamRef.current?.close();
        streamRef.current = null;

        setRunning(false);
        setStage('');
      },
    );
  };


  const exportAnswer = (message) => {
    const lines = [
      'SmartHub Enterprise Agentic RAG',
      '',
      message.content,
      '',
      'Sources',
      ...(message.citations || []).map(
        (citation) => (
          `${citation.citation_id} | `
          + `${citation.source_name} | `
          + `${citation.title || ''} | `
          + `${JSON.stringify(citation.locator || {})}`
        ),
      ),
    ];

    const blob = new Blob(
      [lines.join('\n')],
      {
        type: 'text/plain',
      },
    );

    const url = URL.createObjectURL(blob);

    const anchor = Object.assign(
      document.createElement('a'),
      {
        href: url,
        download: `rag-answer-${
          message.requestId || 'export'
        }.txt`,
      },
    );

    anchor.click();

    setTimeout(
      () => URL.revokeObjectURL(url),
      0,
    );
  };


  const copyAnswer = async (message) => {
    try {
      await navigator.clipboard.writeText(
        message.content || '',
      );

      setCopiedId(message.id);

      setTimeout(() => {
        setCopiedId((current) => (
          current === message.id
            ? null
            : current
        ));
      }, 1600);
    } catch {
      setError('Unable to copy the answer.');
    }
  };


  const feedback = async (message, rating) => {
    try {
      await apiJson(
        '/rag/feedback',
        {
          method: 'POST',
          body: {
            request_id: message.requestId,
            rating,
            reason: (
              rating > 0
                ? 'helpful'
                : 'not_helpful'
            ),
          },
        },
      );
    } catch (err) {
      setError(err.message);
    }
  };


  const openSources = (message) => {
    const items = (
      message.citations?.length
        ? message.citations
        : message.evidence || []
    );

    setSourcesDrawer({
      title: 'Sources used in this answer',
      items,
    });
  };


  const newConversation = () => {
    stop();

    setMessages([]);
    setEvidence([]);
    setSourceEvents([]);

    setSelectedEvidence(null);
    setSourcesDrawer(null);

    setDiagnosticsId(null);
    setError('');

    setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  };


  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* ================================================================
       * Header
       * ============================================================== */}
      <header className="shrink-0 border-b border-jj-gray-03 bg-white">
        <div className="mx-auto flex min-h-[72px] max-w-[1400px] flex-wrap items-center gap-3 px-5 py-3 md:px-7">
          <div className="min-w-0 flex-1">
            <p className="font-johnson-text text-[10px] font-bold uppercase tracking-[0.17em] text-jj-red">
              Enterprise Agentic RAG
            </p>

            <h1 className="mt-0.5 truncate font-johnson-display text-xl font-bold text-jj-gray-08">
              RIMDocs grounded intelligence
            </h1>
          </div>

          <select
            value={profileId}
            onChange={(event) => setProfileId(event.target.value)}
            disabled={running}
            className="max-w-[220px] rounded-xl border border-jj-gray-03 bg-white px-3 py-2.5 font-johnson-text text-xs font-medium text-jj-gray-08 outline-none transition focus:border-jj-red/30 focus:ring-2 focus:ring-jj-red/10 disabled:bg-jj-gray-01"
          >
            {!profiles.length && (
              <option>No active profile</option>
            )}

            {profiles.map((profile) => (
              <option
                key={profile.id}
                value={profile.id}
              >
                {profile.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => navigate('/rag/evaluation')}
            className="inline-flex items-center gap-2 rounded-xl border border-jj-gray-03 bg-white px-3.5 py-2.5 font-johnson-text text-xs font-bold text-jj-gray-07 transition hover:bg-jj-gray-01 hover:text-jj-gray-08"
          >
            <FlaskConical className="h-3.5 w-3.5" />
            Evaluation
          </button>

          {canManage && (
            <button
              type="button"
              onClick={() => setAdminOpen(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-jj-gray-03 bg-white px-3.5 py-2.5 font-johnson-text text-xs font-bold text-jj-gray-07 transition hover:bg-jj-gray-01 hover:text-jj-gray-08"
            >
              <Settings2 className="h-3.5 w-3.5" />
              Configure
            </button>
          )}

          <button
            type="button"
            onClick={newConversation}
            className="inline-flex items-center gap-2 rounded-xl bg-jj-gray-08 px-3.5 py-2.5 font-johnson-text text-xs font-bold text-white transition hover:opacity-90"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            New conversation
          </button>
        </div>
      </header>

      {/* ================================================================
       * Conversation
       * ============================================================== */}
      <main className="min-h-0 flex-1 overflow-y-auto bg-jj-gray-01/50">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6 md:py-8">
          {!messages.length && !running && (
            <EmptyState />
          )}

          <div className="space-y-7">
            {messages.map((message) => (
              <React.Fragment key={message.id}>
                {message.role === 'user' ? (
                  <UserMessage message={message} />
                ) : (
                  <AssistantMessage
                    message={message}
                    onCitation={setSelectedEvidence}
                    onSources={openSources}
                    onFeedback={feedback}
                    onExport={exportAnswer}
                    onCopy={copyAnswer}
                    copied={copiedId === message.id}
                    diagnosticsOpen={
                      diagnosticsId === message.id
                    }
                    onToggleDiagnostics={(id) => {
                      setDiagnosticsId((current) => (
                        current === id
                          ? null
                          : id
                      ));
                    }}
                  />
                )}
              </React.Fragment>
            ))}

            {running && (
              <RunningMessage
                stage={stage}
                sourceEvents={sourceEvents}
                evidenceCount={evidence.length}
              />
            )}

            <div ref={bottomRef} />
          </div>
        </div>
      </main>

      {/* ================================================================
       * Error
       * ============================================================== */}
      {!!error && (
        <div className="shrink-0 border-t border-jj-maroon-05/10 bg-jj-maroon-05/5">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-2.5">
            <p className="font-johnson-text text-xs text-jj-maroon-05">
              {error}
            </p>

            <button
              type="button"
              onClick={() => setError('')}
              className="text-jj-maroon-05"
              aria-label="Dismiss error"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* ================================================================
       * Composer
       * ============================================================== */}
      <footer className="shrink-0 border-t border-jj-gray-03 bg-white px-4 py-4 md:px-6">
        <div className="mx-auto w-full max-w-5xl">
          <div className="flex items-end gap-2 rounded-2xl border border-jj-gray-03 bg-white p-2 shadow-sm transition focus-within:border-jj-red/25 focus-within:ring-2 focus-within:ring-jj-red/10">
            <textarea
              ref={textareaRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter'
                  && !event.shiftKey
                ) {
                  event.preventDefault();
                  ask();
                }
              }}
              placeholder="Ask about the configured RIMDocs sources..."
              rows={1}
              disabled={running || !profileId}
              className="max-h-40 min-h-[46px] flex-1 resize-none border-0 bg-transparent px-3 py-3 font-johnson-text text-sm leading-5 text-jj-gray-08 outline-none placeholder:text-jj-gray-05 disabled:cursor-not-allowed disabled:text-jj-gray-05"
            />

            {running ? (
              <button
                type="button"
                onClick={stop}
                className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl border border-jj-maroon-05/30 bg-white px-4 font-johnson-text text-sm font-bold text-jj-maroon-05 transition hover:bg-jj-maroon-05/5"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={ask}
                disabled={!query.trim() || !profileId}
                className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl bg-jj-red px-4 font-johnson-text text-sm font-bold text-white transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
                Ask
              </button>
            )}
          </div>

          <p className="mt-2 text-center font-johnson-text text-[10px] text-jj-gray-05">
            Answers are grounded in configured enterprise sources.
            {' '}
            Enter to send · Shift+Enter for a new line.
          </p>
        </div>
      </footer>

      {/* ================================================================
       * Drawers / modals
       * ============================================================== */}
      <SourcesDrawer
        drawer={sourcesDrawer}
        onClose={() => setSourcesDrawer(null)}
        onOpenEvidence={(item) => {
          setSelectedEvidence(item);
        }}
      />

      <EvidenceDrawer
        item={selectedEvidence}
        onClose={() => setSelectedEvidence(null)}
      />

      {adminOpen && (
        <AdminPanel
          onClose={() => {
            setAdminOpen(false);

            apiJson('/rag/profiles')
              .then((data) => {
                const list = data.profiles || [];

                setProfiles(list);

                if (
                  list.length
                  && !list.some(
                    (profile) => profile.id === profileId,
                  )
                ) {
                  setProfileId(
                    list.find(
                      (profile) => profile.config?.default,
                    )?.id
                    || list[0].id,
                  );
                }
              })
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
}