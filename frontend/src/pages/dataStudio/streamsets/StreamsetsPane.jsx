import React, { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchJson, formatWhen } from '../shared/studioHelpers';
import { SkeletonLine } from '../shared/studioParts';
import { apiEventSource } from '../../../utils/apiClient';
import {
  KIND, KIND_ORDER, FRAGMENT, findStage, flattenStages, routeSummary, pathOf,
  configLabel, matchesPipeline, runCounts, extractUrl, streamErrorMessage, stageSubtitle,
} from './streamsetsModel';

// The graph library is only fetched when someone opens the Flow tab.
const PipelineCanvas = lazy(() => import('./PipelineCanvas'));

const C = {
  ink: '#1b1f24', slate: '#57606a', mute: '#8b949e', line: '#e4e8ec', wash: '#f6f8fa',
  blue: '#11567f', blueWash: '#eaf3f9', red: '#c02b2b', green: '#1f8f4e',
};
const VIEWS = [
  { id: 'flow', label: 'Flow' },
  { id: 'stages', label: 'All stages' },
  { id: 'params', label: 'Parameters' },
];
const SELECTION_KEY = 'streamsets.selection';
const MAX_ROWS = 500;          // pipeline rows painted at once; search narrows the rest
const MAX_LOG_LINES = 5000;    // the run log keeps the newest lines
const ROW_CV = { contentVisibility: 'auto', containIntrinsicSize: 'auto 52px' };

const readSelection = () => {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(SELECTION_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [];
  } catch { return []; }
};
const saveSelection = (ids) => {
  try { window.sessionStorage.setItem(SELECTION_KEY, JSON.stringify(ids)); } catch { /* private mode */ }
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const shortDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

/* ------------------------------ small parts ------------------------------ */

// Inline glyphs: crisp at any zoom, nothing to load, and they take currentColor.
const Glyph = {
  search: <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm3.6-1.4L14 14" />,
  refresh: <path d="M13.5 8A5.5 5.5 0 1 1 11.9 4M13.5 2v3h-3" />,
  close: <path d="M3.5 3.5l9 9m0-9-9 9" />,
  chevron: <path d="M6 3.5 10.5 8 6 12.5" />,
  download: <path d="M8 2.5v8m-3.5-3.5L8 10.5 11.5 7M3 13.5h10" />,
  alert: <path d="M8 1.8 15 14H1L8 1.8Zm0 4.4v3.6m0 1.9v.1" />,
  copy: <path d="M5.5 5.5h8v8h-8zM3.5 10.5h-1v-8h8v1" />,
  bolt: <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8l1-5.5Z" />,
};
function Svg({ name, size = 14, className = '', strokeWidth = 1.5 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {Glyph[name]}
    </svg>
  );
}

function KindLabel({ stage }) {
  if (stage.fragment) {
    return <span className="text-[11px] font-medium whitespace-nowrap" style={{ color: FRAGMENT.color }}>Fragment</span>;
  }
  const k = KIND[stage.kind] || KIND.PROCESSOR;
  return <span className="text-[11px] font-medium whitespace-nowrap" style={{ color: k.color }}>{k.label}</span>;
}

const dotColor = (stage) => (stage.fragment ? FRAGMENT.color : (KIND[stage.kind] || KIND.PROCESSOR).color);

function ErrorBox({ message, onRetry, compact = false }) {
  return (
    <div role="alert" className={`flex items-start gap-2 rounded-md border border-[#f0cccc] bg-[#fdf5f5] text-[#8f1f1f] ${compact ? 'px-2.5 py-2 text-[12px]' : 'px-3 py-2.5 text-[12.5px]'}`}>
      <Svg name="alert" size={14} className="mt-[1px] flex-shrink-0 text-[#c02b2b]" />
      <div className="flex-1 min-w-0 break-words">{message}</div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="flex-shrink-0 font-medium text-[#11567f] hover:underline">Try again</button>
      )}
    </div>
  );
}

function IconButton({ label, onClick, disabled, spinning, name, size = 28 }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label}
      className="inline-flex items-center justify-center rounded-md text-[#57606a] hover:bg-[#eef1f4] hover:text-[#1b1f24] disabled:opacity-40 disabled:hover:bg-transparent"
      style={{ width: size, height: size }}>
      <Svg name={name} size={14} className={spinning ? 'motion-safe:animate-spin' : ''} />
    </button>
  );
}

function ListSkeleton() {
  return (
    <div className="py-3 space-y-4 px-4" aria-hidden="true">
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3">
          <SkeletonLine w="14px" h={14} />
          <div className="flex-1 space-y-2">
            <SkeletonLine w={`${55 + (i % 4) * 10}%`} h={10} />
            <SkeletonLine w="30%" h={8} />
          </div>
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="px-8 py-6 space-y-5 max-w-[880px]" aria-hidden="true">
      <SkeletonLine w="45%" h={18} />
      <SkeletonLine w="30%" h={10} />
      <SkeletonLine w="100%" h={64} />
      {[0, 1, 2, 3].map(i => (
        <div key={i} className="flex items-center gap-4">
          <SkeletonLine w="26px" h={26} />
          <SkeletonLine w={`${50 + (i % 3) * 12}%`} h={34} />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ stage list ------------------------------ */

function FilterInput({ value, onChange, label }) {
  return (
    <div className="relative w-[280px] max-w-full">
      <Svg name="search" size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8b949e]" />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={label} aria-label={label}
        className="w-full h-[30px] pl-8 pr-2 rounded-md border border-[#d5dbe1] bg-white text-[12.5px] outline-none focus:border-[#11567f] focus:ring-2 focus:ring-[#11567f]/15" />
    </div>
  );
}

function StagesView({ detail, selectedPath, onSelect }) {
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => flattenStages(detail.stages), [detail.stages]);
  const q = filter.trim().toLowerCase();
  const visible = q
    ? rows.filter(({ stage, parents }) => [stage.label, stage.instance, stage.technology, stage.type_name,
      stage.fragment?.name, ...parents.map(p => p.fragment.name)].some(v => String(v || '').toLowerCase().includes(q)))
    : rows;
  const groups = [
    ...KIND_ORDER.map(kind => ({ key: kind, title: KIND[kind].plural, color: KIND[kind].color, rows: visible.filter(r => !r.stage.fragment && r.stage.kind === kind) })),
    { key: 'FRAGMENT', title: 'Fragments', color: FRAGMENT.color, rows: visible.filter(r => r.stage.fragment) },
  ].filter(g => g.rows.length);

  return (
    <div>
      <div className="px-8 pt-5 pb-10 max-w-[880px]">
        <FilterInput value={filter} onChange={setFilter} label="Filter stages" />
        {groups.length === 0 && <div className="mt-6 text-[13px] text-[#8b949e]">No stage matches “{filter}”.</div>}
        {groups.map(g => (
          <section key={g.key} className="mt-6">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold text-[#1b1f24] mb-2">
              <span className="w-2 h-2 rounded-full" style={{ background: g.color }} aria-hidden="true" />
              {g.title} <span className="font-normal text-[#8b949e]">{g.rows.length}</span>
            </h3>
            <div className="rounded-md border border-[#e4e8ec] divide-y divide-[#eef1f4] overflow-hidden">
              {g.rows.map(({ stage, parents, path }) => (
                <button key={path} type="button" onClick={() => onSelect(path)}
                  className={`w-full text-left grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.9fr)] gap-4 px-3 py-2 text-[12.5px] ${selectedPath === path ? 'bg-[#eaf3f9]' : 'bg-white hover:bg-[#f6f8fa]'}`}>
                  <span className="font-medium text-[#1b1f24] truncate" title={stage.label}>{stage.label}</span>
                  <span className="text-[#57606a] truncate">{stageSubtitle(stage)}</span>
                  <span className="text-[#8b949e] truncate" title={parents.map(p => p.fragment.name).join(' › ')}>
                    {parents.length ? `in ${parents.map(p => p.fragment.name).join(' › ')}` : ''}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------- parameters ------------------------------- */

function ParamsView({ detail, onSelect }) {
  const [filter, setFilter] = useState('');
  const paths = useMemo(() => {
    const map = new Map();
    flattenStages(detail.stages).forEach(({ stage, path }) => { if (!map.has(stage.instance)) map.set(stage.instance, { path, label: stage.label }); });
    return map;
  }, [detail.stages]);
  const q = filter.trim().toLowerCase();
  const rows = detail.parameters.filter(p => !q || p.name.toLowerCase().includes(q) || String(p.value).toLowerCase().includes(q));

  if (!detail.parameters.length) {
    return <div className="px-8 py-8 text-[13px] text-[#8b949e]">This pipeline defines no parameters.</div>;
  }
  return (
    <div>
      <div className="px-8 pt-5 pb-10 max-w-[980px]">
        <FilterInput value={filter} onChange={setFilter} label="Filter parameters" />
        <div className="mt-4 rounded-md border border-[#e4e8ec] overflow-hidden">
          <table className="w-full text-[12.5px] border-collapse">
            <thead className="bg-[#f6f8fa] text-left text-[12px] text-[#57606a]">
              <tr>
                <th className="px-3 py-2 font-medium w-[30%]">Name</th>
                <th className="px-3 py-2 font-medium">Value</th>
                <th className="px-3 py-2 font-medium w-[28%]">Used by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => (
                <tr key={p.name} className="border-t border-[#eef1f4] align-top">
                  <td className="px-3 py-2 font-mono text-[12px] break-all text-[#1b1f24]">{p.name}</td>
                  <td className="px-3 py-2 font-mono text-[12px] break-all whitespace-pre-wrap text-[#1b1f24]">
                    {p.value === '' ? <span className="font-sans text-[#8b949e]">Empty</span> : p.value}
                  </td>
                  <td className="px-3 py-2">
                    {p.used_by.length === 0 && <span className="text-[#8b949e]">Not used by any stage</span>}
                    <div className="flex flex-wrap gap-1">
                      {p.used_by.map(inst => {
                        const target = paths.get(inst);
                        return (
                          <button key={inst} type="button" disabled={!target} onClick={() => target && onSelect(target.path)}
                            className="px-1.5 py-0.5 rounded border border-[#e4e8ec] text-[12px] text-[#11567f] hover:bg-[#eaf3f9] disabled:text-[#8b949e]">
                            {target ? target.label : inst}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="px-3 py-4 text-[13px] text-[#8b949e] border-t border-[#eef1f4]">No parameter matches “{filter}”.</div>}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- stage drawer ----------------------------- */

function LinkList({ title, items, labelOf, onPick }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium text-[#57606a] mb-1">{title}</div>
      {items.length === 0 ? <div className="text-[12px] text-[#8b949e]">Nothing</div> : (
        <div className="flex flex-wrap gap-1">
          {items.map(inst => (
            <button key={inst} type="button" onClick={() => onPick(inst)}
              className="px-1.5 py-0.5 rounded border border-[#e4e8ec] text-[12px] text-[#11567f] hover:bg-[#eaf3f9] max-w-full truncate">
              {labelOf(inst)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StageDrawer({ found, path, detail, onSelect, onClose }) {
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(null);
  const { stage, parents } = found;
  const frag = stage.fragment;
  const siblings = parents.length ? parents[parents.length - 1].fragment.stages : detail.stages;
  const parentPrefix = path.split('/').slice(0, -1);
  const labelOf = (inst) => siblings.find(s => s.instance === inst)?.label || inst;
  const pick = (inst) => onSelect(pathOf(parentPrefix, { instance: inst }));
  const q = filter.trim().toLowerCase();
  const config = stage.config.filter(c => !q || c.name.toLowerCase().includes(q) || c.value.toLowerCase().includes(q));

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(c => (c === key ? null : c)), 1200);
    } catch { /* clipboard blocked - nothing to do */ }
  };

  return (
    <aside className="w-[420px] flex-shrink-0 border-l border-[#e4e8ec] bg-white flex flex-col min-h-0" aria-label="Stage settings">
      <div className="flex-shrink-0 px-5 pt-4 pb-3 border-b border-[#e4e8ec]">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            {parents.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 text-[12px] text-[#8b949e] mb-1">
                {parents.map((p, i) => (
                  <React.Fragment key={p.instance}>
                    {i > 0 && <Svg name="chevron" size={10} />}
                    <button type="button" className="hover:underline text-[#6b3fa0]"
                      onClick={() => onSelect(parentPrefix.slice(0, i + 1).join('/'))}>{p.fragment.name}</button>
                  </React.Fragment>
                ))}
              </div>
            )}
            <h3 className="text-[15px] font-semibold text-[#1b1f24] break-words">{stage.label}</h3>
            <div className="mt-0.5 flex items-baseline gap-2 text-[12.5px] text-[#57606a]">
              <KindLabel stage={stage} />
              <span className="truncate">{stageSubtitle(stage)}</span>
            </div>
          </div>
          <IconButton name="close" label="Close stage settings" onClick={onClose} />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
        {stage.description && <p className="text-[12.5px] text-[#57606a] whitespace-pre-wrap">{stage.description}</p>}

        <div className="grid grid-cols-2 gap-4">
          <LinkList title="Gets records from" items={stage.upstream || []} labelOf={labelOf} onPick={pick} />
          <LinkList title="Sends records to" items={stage.downstream || []} labelOf={labelOf} onPick={pick} />
          {((stage.triggered_by || []).length > 0 || (stage.triggers || []).length > 0) && (<>
            <LinkList title="Runs on events from" items={stage.triggered_by || []} labelOf={labelOf} onPick={pick} />
            <LinkList title="Sends events to" items={stage.triggers || []} labelOf={labelOf} onPick={pick} />
          </>)}
        </div>

        {frag && (
          <div>
            <div className="text-[12px] font-medium text-[#57606a] mb-1.5">Inside {frag.name}</div>
            {frag.error ? <ErrorBox compact message={frag.error} /> : (
              <div className="rounded-md border border-[#e4e8ec] divide-y divide-[#eef1f4] overflow-hidden">
                {frag.stages.length === 0 && <div className="px-3 py-2 text-[12px] text-[#8b949e]">No stages.</div>}
                {frag.stages.map(inner => (
                  <button key={inner.instance} type="button" onClick={() => onSelect(`${path}/${inner.instance}`)}
                    className="w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-[#f6f8fa]">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dotColor(inner) }} aria-hidden="true" />
                    <span className="text-[12.5px] truncate">{inner.label}</span>
                    <span className="ml-auto text-[12px] text-[#8b949e] flex-shrink-0">{stageSubtitle(inner)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="text-[12px] font-medium text-[#57606a]">Settings <span className="font-normal text-[#8b949e]">{stage.config.length}</span></div>
            {stage.config.length > 6 && (
              <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter settings" aria-label="Filter settings"
                className="ml-auto w-[160px] h-[26px] px-2 rounded-md border border-[#d5dbe1] text-[12px] outline-none focus:border-[#11567f]" />
            )}
          </div>
          {stage.config.length === 0 && <div className="text-[12px] text-[#8b949e]">No settings have a value.</div>}
          {stage.config.length > 0 && config.length === 0 && <div className="text-[12px] text-[#8b949e]">No setting matches “{filter}”.</div>}
          <div className="space-y-2">
            {config.map(c => (
              <div key={c.name} className="rounded-md border border-[#e4e8ec]">
                <div className="flex items-center gap-2 px-3 pt-2">
                  <span className="text-[12.5px] font-medium text-[#1b1f24] truncate" title={c.name}>{configLabel(c.name)}</span>
                  {!c.secret && (
                    <button type="button" onClick={() => copy(c.value, c.name)}
                      className="ml-auto flex-shrink-0 inline-flex items-center gap-1 text-[12px] text-[#57606a] hover:text-[#11567f]">
                      <Svg name="copy" size={12} />{copied === c.name ? 'Copied' : 'Copy'}
                    </button>
                  )}
                </div>
                <div className="px-3 text-[11px] text-[#8b949e] truncate" title={c.name}>{c.name}</div>
                <pre className={`mx-3 my-2 max-h-[240px] overflow-auto whitespace-pre-wrap break-all text-[12px] leading-[1.5] font-mono ${c.secret ? 'text-[#8b949e]' : 'text-[#1b1f24]'}`}>
                  {c.secret ? 'Hidden' : c.value}
                </pre>
                {c.params.length > 0 && (
                  <div className="px-3 pb-2 flex flex-wrap gap-1">
                    {c.params.map(p => (
                      <span key={p.name} className={`px-1.5 py-0.5 rounded text-[11.5px] font-mono break-all ${p.value === null ? 'bg-[#fdf3e3] text-[#8a5a0a]' : 'bg-[#edf6ef] text-[#1f6b3c]'}`}
                        title={p.value === null ? 'Not set in the pipeline parameters - comes from the job or runtime' : 'From the pipeline parameters'}>
                        {p.name} = {p.value === null ? 'set at runtime' : (p.value === '' ? '""' : p.value)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <details className="text-[12px] text-[#57606a]">
          <summary className="cursor-pointer select-none hover:text-[#1b1f24]">Technical details</summary>
          <dl className="mt-2 grid grid-cols-[96px_1fr] gap-x-2 gap-y-1">
            <dt className="text-[#8b949e]">Instance</dt><dd className="font-mono break-all">{stage.instance}</dd>
            <dt className="text-[#8b949e]">Stage</dt><dd className="font-mono break-all">{stage.stage_name}</dd>
            <dt className="text-[#8b949e]">Library</dt><dd className="font-mono break-all">{stage.library || '-'}</dd>
            {frag && (<>
              <dt className="text-[#8b949e]">Fragment ID</dt><dd className="font-mono break-all">{frag.fragment_id || '-'}</dd>
              <dt className="text-[#8b949e]">Param prefix</dt><dd className="font-mono break-all">{frag.prefix || '-'}</dd>
            </>)}
          </dl>
        </details>
      </div>
    </aside>
  );
}

/* ----------------------------- route summary ----------------------------- */

function Endpoint({ title, stages, align }) {
  const shown = stages.slice(0, 3);
  return (
    <div className={`min-w-0 ${align === 'right' ? 'text-right' : ''}`}>
      <div className="text-[12px] text-[#8b949e]">{title}</div>
      {stages.length === 0 && <div className="text-[13px] text-[#8b949e]">None</div>}
      {shown.map(s => (
        <div key={s.instance} className="truncate" title={`${s.label} - ${stageSubtitle(s)}`}>
          <span className="text-[14px] font-semibold text-[#1b1f24]">{s.label}</span>
          {s.technology !== 'StreamSets' && <span className="text-[12.5px] text-[#57606a]">{`  ${s.technology}`}</span>}
        </div>
      ))}
      {stages.length > 3 && <div className="text-[12px] text-[#57606a]">and {stages.length - 3} more</div>}
    </div>
  );
}

function RouteSummary({ detail }) {
  const { sources, destinations, transforms } = useMemo(() => routeSummary(detail.stages), [detail.stages]);
  const c = detail.counts;
  const middle = [
    plural(transforms, 'transformation', 'transformations'),
    c.fragments ? plural(c.fragments, 'fragment', 'fragments') : null,
    c.executor ? plural(c.executor, 'executor', 'executors') : null,
  ].filter(Boolean).join(', ');
  return (
    <div className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(120px,1.1fr)_minmax(0,1fr)] items-center gap-4 rounded-md bg-[#f6f8fa] border border-[#e4e8ec] px-4 py-3">
      <Endpoint title={sources.length === 1 ? 'Reads from' : `Reads from ${sources.length} sources`} stages={sources} />
      <div className="flex flex-col items-center text-center" aria-hidden="true">
        <div className="text-[12px] text-[#57606a] mb-1">{middle}</div>
        <svg width="100%" height="10" viewBox="0 0 200 10" preserveAspectRatio="none" className="text-[#b6c0ca]">
          <path d="M0 5h196" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <path d="M190 1l6 4-6 4" stroke="currentColor" strokeWidth="1.5" fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <Endpoint title={destinations.length === 1 ? 'Writes to' : `Writes to ${destinations.length} destinations`} stages={destinations} align="right" />
    </div>
  );
}

/* ---------------------------- extraction run ---------------------------- */

const STATE_STYLE = {
  queued: { label: 'Waiting', color: C.mute },
  running: { label: 'Extracting', color: C.blue },
  done: { label: 'Extracted', color: C.green },
  failed: { label: 'Failed', color: C.red },
  cancelled: { label: 'Cancelled', color: C.mute },
};

function RunPanel({ run, onCancel, onClose, onDownload, onOpenPipeline }) {
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef(null);
  const stick = useRef(true);
  const counts = runCounts(run.pipelines);
  const running = run.status === 'running';
  const total = run.pipelines.length;
  const finished = counts.done + counts.failed + (counts.cancelled || 0);

  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [run.log.length, showLog]);

  const headline = running
    ? `Extracting ${plural(total, 'pipeline', 'pipelines')}`
    : run.status === 'cancelled' ? 'Extraction cancelled'
      : run.status === 'done' ? (counts.failed ? `Extracted ${counts.done} of ${total}` : `Extracted ${plural(counts.done, 'pipeline', 'pipelines')}`)
        : 'Extraction failed';

  return (
    <section className="flex-shrink-0 border-t border-[#d5dbe1] bg-white max-h-[46vh] flex flex-col" aria-label="Extraction" aria-live="polite">
      <div className="flex-shrink-0 flex items-center gap-3 px-5 h-[48px]">
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold text-[#1b1f24]">{headline}</div>
          <div className="text-[12px] text-[#57606a]">
            {running ? `${finished} of ${total} finished` : `${counts.done} extracted, ${counts.failed} failed`}
            {run.seconds != null ? ` in ${run.seconds}s` : ''}
          </div>
        </div>
        {running && (
          <div className="w-[160px] h-[4px] rounded-full bg-[#e4e8ec] overflow-hidden" aria-hidden="true">
            <div className="h-full bg-[#11567f]" style={{ width: `${Math.max(4, (finished / Math.max(total, 1)) * 100)}%` }} />
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setShowLog(v => !v)}
            className="h-[30px] px-2.5 rounded-md text-[12.5px] text-[#57606a] hover:bg-[#eef1f4]">
            {showLog ? 'Hide log' : `Show log (${run.log.length})`}
          </button>
          {run.report && (
            <button type="button" onClick={onDownload}
              className="inline-flex items-center gap-1.5 h-[30px] px-3 rounded-md bg-[#11567f] text-white text-[12.5px] font-medium hover:bg-[#0b3d5b]">
              <Svg name="download" size={14} />
              Download report
            </button>
          )}
          {running ? (
            <button type="button" onClick={onCancel} className="h-[30px] px-3 rounded-md border border-[#d5dbe1] text-[12.5px] hover:bg-[#f6f8fa]">
              Cancel
            </button>
          ) : (
            <IconButton name="close" label="Close extraction panel" onClick={onClose} />
          )}
        </div>
      </div>

      {run.error && <div className="px-5 pb-2"><ErrorBox compact message={run.error} /></div>}

      <div className="flex-1 min-h-0 flex border-t border-[#eef1f4]">
        <ul className={`${showLog ? 'w-[360px] border-r border-[#eef1f4]' : 'flex-1'} overflow-y-auto py-1`}>
          {run.pipelines.map(p => {
            const st = STATE_STYLE[p.state] || STATE_STYLE.queued;
            return (
              <li key={p.id} className="px-5 py-1.5 text-[12.5px]">
                <div className="flex items-center gap-2.5">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: st.color }} aria-hidden="true" />
                  <button type="button" onClick={() => onOpenPipeline(p.id)} className="text-left truncate hover:underline min-w-0" title={p.name}>{p.name}</button>
                  <span className="ml-auto flex-shrink-0 text-[12px]" style={{ color: st.color }}>{st.label}</span>
                </div>
                {p.error && <div className="ml-[18px] text-[12px] text-[#c02b2b] break-words">{p.error}</div>}
              </li>
            );
          })}
        </ul>
        {showLog && (
          <pre ref={logRef} onScroll={e => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }} className="flex-1 min-w-0 overflow-auto px-4 py-2 text-[11.5px] leading-[1.5] font-mono text-[#1b1f24] bg-[#f6f8fa] whitespace-pre-wrap break-all">
            {run.log.length ? run.log.join('\n') : 'Waiting for output…'}
          </pre>
        )}
      </div>
    </section>
  );
}

/* ================================= pane ================================= */

export default function StreamsetsPane({ logInPage }) {
  const [params, setParams] = useSearchParams();
  const pipelineId = params.get('pipeline') || '';
  // ssview/ssq, not view/q: the panes share one URL and S3 already uses those two.
  const view = VIEWS.some(v => v.id === params.get('ssview')) ? params.get('ssview') : 'flow';
  const stagePath = params.get('stage') || '';
  const urlQuery = params.get('ssq') || '';

  const [phase, setPhase] = useState('booting');     // booting | ready | unconfigured | error
  const [fatal, setFatal] = useState(null);
  const [health, setHealth] = useState(null);
  const [bootNonce, setBootNonce] = useState(0);

  const [pipelines, setPipelines] = useState([]);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState(null);

  const [query, setQuery] = useState(urlQuery);
  const [sort, setSort] = useState('name');
  const [selected, setSelected] = useState(() => new Set(readSelection()));

  const [details, setDetails] = useState(() => new Map());   // id -> detail, kept while the page is open
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);      // { message, status }
  const [detailNonce, setDetailNonce] = useState(0);
  const forceRefresh = useRef(null);   // pipeline id whose next load should skip the server cache

  const [run, setRun] = useState(null);
  const streamRef = useRef(null);
  const listReq = useRef(0);
  const detailReq = useRef(0);

  const track = useCallback((target, info) => {
    if (typeof logInPage === 'function') logInPage(target, info);
  }, [logInPage]);

  /* ------------------------------ navigation ------------------------------ */

  const navigate = useCallback((patch, { replace = false } = {}) => {
    setParams(() => {
      // Start from the live address, not the render-time copy: the delayed search-box write
      // would otherwise put back an old URL and drop a pipeline opened in the meantime.
      const next = new URLSearchParams(window.location.search);
      Object.entries(patch).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') next.delete(key);
        else next.set(key, String(value));
      });
      return next;
    }, { replace });
  }, [setParams]);

  const openPipeline = useCallback((id) => {
    if (id === pipelineId) return;
    navigate({ pipeline: id, stage: null });
    track('ss_open', `Opened StreamSets pipeline ${id}`);
  }, [navigate, pipelineId, track]);

  const selectStage = useCallback((path) => {
    navigate({ stage: path === stagePath ? null : path });
  }, [navigate, stagePath]);

  const closeStage = useCallback(() => navigate({ stage: null }), [navigate]);

  // Typing filters at once; the URL catches up a moment later (replace, so it isn't a history step per key).
  useEffect(() => {
    const t = setTimeout(() => { if (query !== urlQuery) navigate({ ssq: query }, { replace: true }); }, 300);
    return () => clearTimeout(t);
  }, [query, urlQuery, navigate]);
  // ...and back/forward to an address with a different ?ssq puts it in the box.
  const lastUrlQuery = useRef(urlQuery);
  useEffect(() => {
    if (urlQuery !== lastUrlQuery.current) {
      lastUrlQuery.current = urlQuery;
      setQuery(urlQuery);
    }
  }, [urlQuery]);

  /* ------------------------------- bootstrap ------------------------------ */

  const loadList = useCallback(async (refresh = false) => {
    const id = ++listReq.current;
    setListLoading(true);
    setListError(null);
    try {
      const data = await fetchJson(`/api/streamsets/pipelines${refresh ? '?refresh=true' : ''}`);
      if (id !== listReq.current) return;
      setPipelines(Array.isArray(data?.pipelines) ? data.pipelines : []);
      setFetchedAt(data?.fetched_at || null);
    } catch (err) {
      if (id !== listReq.current) return;
      setListError(err.message || 'Could not load the pipelines');
    } finally {
      if (id === listReq.current) setListLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPhase('booting');
    setFatal(null);
    (async () => {
      try {
        const h = await fetchJson('/api/streamsets/health');
        if (cancelled) return;
        setHealth(h);
        setPhase('ready');
        loadList(false);
      } catch (err) {
        if (cancelled) return;
        setFatal(err.message);
        setPhase(err.status === 503 ? 'unconfigured' : 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [bootNonce, loadList]);

  // Picked pipelines outlive a reload of the tab; drop any that have since gone from StreamSets.
  useEffect(() => { saveSelection([...selected]); }, [selected]);
  useEffect(() => {
    if (!pipelines.length) return;
    const known = new Set(pipelines.map(p => p.id));
    setSelected(prev => {
      const kept = [...prev].filter(id => known.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [pipelines]);

  /* -------------------------------- detail -------------------------------- */

  const detail = pipelineId ? details.get(pipelineId) || null : null;

  useEffect(() => {
    if (phase !== 'ready' || !pipelineId) return undefined;
    const refresh = forceRefresh.current === pipelineId;
    forceRefresh.current = null;
    if (details.has(pipelineId) && !refresh) {
      setDetailError(null);
      setDetailLoading(false);
      return undefined;
    }
    const id = ++detailReq.current;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    (async () => {
      try {
        const data = await fetchJson(`/api/streamsets/pipelines/${encodeURIComponent(pipelineId)}${refresh ? '?refresh=true' : ''}`);
        if (cancelled || id !== detailReq.current) return;
        setDetails(prev => new Map(prev).set(pipelineId, data));
      } catch (err) {
        if (cancelled || id !== detailReq.current) return;
        setDetailError({ message: err.message || 'Could not load that pipeline', status: err.status });
      } finally {
        if (!cancelled && id === detailReq.current) setDetailLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // details is read, not watched: storing a result must not trigger another fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, pipelineId, detailNonce]);

  const refreshDetail = () => {
    forceRefresh.current = pipelineId;
    setDetailNonce(n => n + 1);
  };

  // A ?stage that doesn't exist in this pipeline (renamed, stale link) is dropped rather than shown as nothing.
  const found = useMemo(() => (detail ? findStage(detail.stages, stagePath) : null), [detail, stagePath]);
  useEffect(() => {
    if (detail && stagePath && !found) navigate({ stage: null }, { replace: true });
  }, [detail, stagePath, found, navigate]);

  /* ------------------------------ selection ------------------------------- */

  const maxPerRun = health?.max_per_run || 25;
  const visible = useMemo(() => {
    const list = pipelines.filter(p => matchesPipeline(p, query));
    if (sort === 'modified') {
      list.sort((a, b) => String(b.last_modified || '').localeCompare(String(a.last_modified || '')));
    }
    return list;
  }, [pipelines, query, sort]);
  const shown = visible.slice(0, MAX_ROWS);

  const toggle = (id) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else if (next.size < maxPerRun) next.add(id);
    return next;
  });
  const visibleSelected = shown.filter(p => selected.has(p.id)).length;
  const allShownSelected = shown.length > 0 && visibleSelected === shown.length;
  const selectShown = () => setSelected(prev => {
    const next = new Set(prev);
    if (allShownSelected) { shown.forEach(p => next.delete(p.id)); return next; }
    for (const p of shown) {
      if (next.size >= maxPerRun) break;
      next.add(p.id);
    }
    return next;
  });
  const nameOf = useCallback((id) => pipelines.find(p => p.id === id)?.name || details.get(id)?.name || id, [pipelines, details]);

  /* ------------------------------ extraction ------------------------------ */

  const running = run?.status === 'running';

  const startExtraction = (ids) => {
    if (!ids.length || running) return;
    if (!health?.extractor?.ready) return;
    streamRef.current?.close();
    const startedAt = Date.now();
    setRun({
      status: 'running', error: null, report: null, filename: null, seconds: null, log: [],
      pipelines: ids.map(id => ({ id, name: nameOf(id), state: 'queued', error: null })),
    });
    track('ss_extract', `Extracting ${ids.length} StreamSets pipeline(s): ${ids.map(nameOf).join(', ')}`);

    let finished = false;
    const es = apiEventSource(extractUrl(ids));
    streamRef.current = es;
    const patch = (fn) => setRun(prev => (prev && streamRef.current === es ? fn(prev) : prev));

    es.onmessage = (event) => {
      let evt;
      try { evt = JSON.parse(event.data); } catch { return; }
      if (evt.type === 'log') {
        patch(r => {
          const log = r.log.length >= MAX_LOG_LINES ? r.log.slice(-MAX_LOG_LINES + 1) : r.log.slice();
          log.push(evt.message);
          return { ...r, log };
        });
      } else if (evt.type === 'status' && Array.isArray(evt.pipelines)) {
        patch(r => ({
          ...r,
          pipelines: r.pipelines.map(p => ({ ...p, name: evt.pipelines.find(x => x.id === p.id)?.name || p.name })),
        }));
      } else if (evt.type === 'progress') {
        patch(r => ({ ...r, pipelines: r.pipelines.map(p => (p.id === evt.pipeline_id ? { ...p, state: evt.state, error: evt.error || null } : p)) }));
      } else if (evt.type === 'report') {
        patch(r => ({ ...r, report: evt.report, filename: evt.filename || 'streamsets_report.json' }));
      } else if (evt.type === 'error') {
        patch(r => ({ ...r, error: r.error ? `${r.error} · ${evt.message}` : evt.message }));
      } else if (evt.type === 'done') {
        finished = true;
        patch(r => ({
          ...r,
          status: r.report ? 'done' : 'failed',
          seconds: evt.seconds ?? Math.round((Date.now() - startedAt) / 1000),
          pipelines: r.pipelines.map(p => {
            const failure = (evt.failed || []).find(f => f.pipeline_id === p.id);
            if (failure) return { ...p, state: 'failed', error: failure.error || p.error };
            return p.state === 'done' ? p : { ...p, state: r.report ? p.state : 'failed' };
          }),
        }));
        es.close();
      }
    };
    es.onerror = (err) => {
      if (finished) return;
      finished = true;
      patch(r => ({
        ...r,
        status: 'failed',
        error: err?.status ? streamErrorMessage(err.status) : `Lost the connection to the server: ${err?.message || 'network error'}`,
        pipelines: r.pipelines.map(p => (p.state === 'done' ? p : { ...p, state: 'failed' })),
      }));
    };
    es.onend = () => {
      if (finished) return;
      finished = true;
      patch(r => ({
        ...r,
        status: 'failed',
        error: r.error || 'The connection closed before the extraction finished.',
        pipelines: r.pipelines.map(p => (p.state === 'done' ? p : { ...p, state: 'failed' })),
      }));
    };
  };

  const cancelRun = () => {
    const es = streamRef.current;
    if (!es) return;
    streamRef.current = null;   // late events from the closed stream are ignored
    es.close();                 // the server stops the extractor when the stream drops
    setRun(r => (r ? {
      ...r, status: 'cancelled',
      pipelines: r.pipelines.map(p => (p.state === 'done' || p.state === 'failed' ? p : { ...p, state: 'cancelled' })),
    } : r));
    track('ss_extract_cancel', 'Cancelled a StreamSets extraction');
  };

  const downloadReport = () => {
    if (!run?.report) return;
    const blob = new Blob([JSON.stringify(run.report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: run.filename || 'streamsets_report.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    track('ss_download', `Downloaded StreamSets report ${run.filename}`);
  };

  // Leaving the page mid-run would silently drop it - ask first, and close the stream when the pane goes away.
  useEffect(() => {
    if (!running) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);
  useEffect(() => () => streamRef.current?.close(), []);


  /* -------------------------------- render -------------------------------- */

  if (phase === 'unconfigured' || phase === 'error') {
    return (
      <div className="h-full flex items-center justify-center p-10 bg-white">
        <div className="max-w-md text-center">
          <div className="text-[15px] font-semibold text-[#1b1f24]">
            {phase === 'unconfigured' ? 'StreamSets Extractor is not set up' : "Can't reach the StreamSets Extractor"}
          </div>
          <div className="mt-1.5 text-[13px] text-[#57606a]">
            {phase === 'unconfigured' ? (
              <>Add a <code className="text-[12px] bg-[#f6f8fa] px-1 py-0.5 rounded">streamsets_extractor</code> section to the backend config to switch it on.</>
            ) : fatal}
          </div>
          {phase === 'error' && (
            <button type="button" onClick={() => setBootNonce(n => n + 1)}
              className="mt-4 h-[30px] px-3 rounded-md border border-[#d5dbe1] text-[12.5px] hover:bg-[#f6f8fa]">Try again</button>
          )}
        </div>
      </div>
    );
  }

  const extractorReady = !!health?.extractor?.ready;
  const liveHere = !!detail && running && run.pipelines.some(p => p.id === detail.id && (p.state === 'running' || p.state === 'queued'));
  const busy = listLoading || detailLoading;
  const notFound = detailError?.status === 404;
  const extractLabel = running ? 'Extracting…'
    : selected.size ? `Extract ${plural(selected.size, 'pipeline', 'pipelines')}` : 'Extract pipelines';

  return (
    <div className="relative h-full flex flex-col min-h-0 bg-white text-[#1b1f24]">
      {busy && <div className="absolute top-0 left-0 right-0 h-[2px] bg-[#29b5e8] z-30 motion-safe:animate-pulse" aria-hidden="true" />}

      <div className="flex-1 min-h-0 flex">
        {/* ------------------------------ pipelines ------------------------------ */}
        <div className="w-[320px] flex-shrink-0 border-r border-[#e4e8ec] bg-[#fafbfc] flex flex-col min-h-0">
          <div className="flex-shrink-0 px-4 pt-3.5 pb-3 space-y-2.5 border-b border-[#e4e8ec]">
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-semibold">Pipelines</h2>
              <span className="text-[12px] text-[#8b949e]">
                {phase === 'booting' || (listLoading && !pipelines.length) ? '' : query ? `${visible.length} of ${pipelines.length}` : pipelines.length}
              </span>
              <span className="ml-auto">
                <IconButton name="refresh" onClick={() => loadList(true)} disabled={listLoading} spinning={listLoading}
                  label={fetchedAt ? `Reload the list (fetched ${formatWhen(fetchedAt)})` : 'Reload the list'} />
              </span>
            </div>
            <div className="relative">
              <Svg name="search" size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8b949e]" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by name, ID or label"
                aria-label="Search pipelines"
                className="w-full h-[32px] pl-8 pr-8 rounded-md border border-[#d5dbe1] bg-white text-[13px] outline-none focus:border-[#11567f] focus:ring-2 focus:ring-[#11567f]/15" />
              {query && (
                <span className="absolute right-1 top-1/2 -translate-y-1/2">
                  <IconButton name="close" label="Clear search" onClick={() => setQuery('')} size={24} />
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[12px] text-[#57606a]">
              <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                <input type="checkbox" className="accent-[#11567f]" checked={allShownSelected} onChange={selectShown} disabled={!shown.length} />
                {allShownSelected ? 'Unpick these' : 'Pick all shown'}
              </label>
              <label className="ml-auto inline-flex items-center gap-1.5">
                Sort
                <select value={sort} onChange={e => setSort(e.target.value)}
                  className="h-[26px] px-1 text-[12px] border border-[#d5dbe1] rounded-md bg-white outline-none focus:border-[#11567f]">
                  <option value="name">Name</option>
                  <option value="modified">Recently changed</option>
                </select>
              </label>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto" aria-busy={listLoading}>
            {(phase === 'booting' || (listLoading && !pipelines.length)) && <ListSkeleton />}
            {listError && <div className="p-3"><ErrorBox compact message={listError} onRetry={() => loadList(true)} /></div>}
            {phase === 'ready' && !listLoading && !listError && pipelines.length === 0 && (
              <div className="px-4 py-4 text-[12.5px] text-[#8b949e]">The StreamSets service account can&apos;t see any pipelines.</div>
            )}
            {pipelines.length > 0 && visible.length === 0 && (
              <div className="px-4 py-4 text-[12.5px] text-[#8b949e]">No pipeline matches “{query}”.</div>
            )}
            <ul>
              {shown.map(p => {
                const isOpen = p.id === pipelineId;
                const picked = selected.has(p.id);
                const full = !picked && selected.size >= maxPerRun;
                return (
                  <li key={p.id} style={ROW_CV}
                    className={`flex items-start gap-2.5 pl-4 pr-3 py-2.5 border-l-[3px] ${isOpen ? 'bg-[#eaf3f9] border-[#11567f]' : 'border-transparent hover:bg-[#f1f4f7]'}`}>
                    <input type="checkbox" className="mt-[3px] accent-[#11567f] flex-shrink-0" checked={picked} disabled={full} onChange={() => toggle(p.id)}
                      aria-label={`Pick ${p.name} for extraction`} title={full ? `You can extract up to ${maxPerRun} pipelines at a time` : undefined} />
                    <button type="button" onClick={() => openPipeline(p.id)} className="flex-1 min-w-0 text-left focus:outline-none focus-visible:underline"
                      aria-current={isOpen ? 'true' : undefined} title={p.modified_by ? `Last changed by ${p.modified_by}` : undefined}>
                      <div className={`text-[13px] leading-[1.35] break-words ${isOpen ? 'text-[#11567f] font-semibold' : 'text-[#1b1f24]'}`}>{p.name}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[12px] text-[#8b949e] min-w-0">
                        {p.version && <span>v{p.version}</span>}
                        {p.last_modified && <span>{shortDate(p.last_modified)}</span>}
                        {p.labels?.slice(0, 2).map(l => (
                          <span key={l} className="px-1.5 rounded bg-[#eef1f4] text-[11.5px] text-[#57606a] truncate max-w-[110px]">{l}</span>
                        ))}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
            {visible.length > MAX_ROWS && (
              <div className="px-4 py-3 text-[12px] text-[#8b949e]">Showing the first {MAX_ROWS} of {visible.length}. Search to narrow it down.</div>
            )}
          </div>

          <div className="flex-shrink-0 border-t border-[#e4e8ec] px-4 py-3 space-y-2 bg-white">
            <div className="flex items-center gap-2 text-[12.5px]">
              <span className="font-medium">{selected.size ? `${selected.size} picked` : 'Nothing picked yet'}</span>
              <span className="text-[#8b949e]">up to {maxPerRun}</span>
              {selected.size > 0 && (
                <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-[#11567f] hover:underline">Clear</button>
              )}
            </div>
            <button type="button" onClick={() => startExtraction([...selected])}
              disabled={!selected.size || running || !extractorReady}
              title={!extractorReady ? health?.extractor?.reason || 'The extractor is not available' : running ? 'An extraction is already running' : undefined}
              className="w-full h-[34px] rounded-md bg-[#eb1700] text-white text-[13px] font-semibold hover:bg-[#c41300] disabled:bg-[#e4e1dd] disabled:text-[#8b8580] disabled:cursor-not-allowed">
              {extractLabel}
            </button>
            {!extractorReady && health && (
              <div className="text-[12px] leading-[1.4] text-[#9a5b06]">{health.extractor?.reason || 'The extractor is not available on the server.'}</div>
            )}
          </div>
        </div>

        {/* ------------------------------- detail -------------------------------- */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {!pipelineId && (
            <div className="flex-1 flex items-center justify-center p-10">
              <div className="max-w-[380px]">
                <div className="text-[15px] font-semibold text-[#1b1f24]">Open a pipeline to see how it moves data</div>
                <p className="mt-1.5 text-[13px] leading-[1.55] text-[#57606a]">
                  You&apos;ll see where it reads from, each transformation in order, what&apos;s inside its fragments and where it writes to.
                  Tick the box next to a pipeline to add it to an extraction.
                </p>
              </div>
            </div>
          )}

          {pipelineId && !detail && !detailError && <DetailSkeleton />}

          {pipelineId && !detail && detailError && (
            <div className="px-8 py-6 max-w-[640px] space-y-3">
              <ErrorBox message={detailError.message} onRetry={notFound ? null : refreshDetail} />
              {notFound && (
                <button type="button" onClick={() => navigate({ pipeline: null, stage: null })} className="text-[12.5px] text-[#11567f] hover:underline">
                  Back to the pipeline list
                </button>
              )}
            </div>
          )}

          {detail && (
            <div className="flex-1 min-h-0 flex flex-col">
              <header className="flex-shrink-0 px-6 pt-4">
                <div className="max-w-[1100px]">
                  <div className="flex items-start gap-4">
                    <div className="flex-1 min-w-0">
                      <h2 className="text-[19px] leading-[1.3] font-semibold text-[#1b1f24] break-words">{detail.name}</h2>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-[#57606a]">
                        {detail.version && <span>Version {detail.version}</span>}
                        {detail.committed_at && <span>Changed {shortDate(detail.committed_at)}{detail.committed_by ? ` by ${detail.committed_by}` : ''}</span>}
                        <button type="button" onClick={() => navigator.clipboard?.writeText(detail.id).catch(() => {})}
                          className="inline-flex items-center gap-1 text-[#57606a] hover:text-[#11567f]" title={detail.id}>
                          <Svg name="copy" size={12} />Copy pipeline ID
                        </button>
                      </div>
                      {detail.commit_message && (
                        <div className="mt-1 text-[12.5px] text-[#57606a] truncate" title={detail.commit_message}>Commit note: {detail.commit_message}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <IconButton name="refresh" label="Reload this pipeline from StreamSets" onClick={refreshDetail}
                        disabled={detailLoading} spinning={detailLoading} size={32} />
                      <button type="button" onClick={() => toggle(detail.id)}
                        disabled={!selected.has(detail.id) && selected.size >= maxPerRun}
                        className="h-[32px] px-3 rounded-md border border-[#d5dbe1] text-[12.5px] font-medium hover:bg-[#f6f8fa] disabled:opacity-50">
                        {selected.has(detail.id) ? 'Remove from extraction' : 'Add to extraction'}
                      </button>
                      <button type="button" onClick={() => startExtraction([detail.id])} disabled={running || !extractorReady}
                        title={!extractorReady ? health?.extractor?.reason : undefined}
                        className="h-[32px] px-3 rounded-md bg-[#11567f] text-white text-[12.5px] font-medium hover:bg-[#0b3d5b] disabled:bg-[#c9d1d9]">
                        Extract now
                      </button>
                    </div>
                  </div>
                  {detailError && <div className="mt-3"><ErrorBox compact message={`Couldn't reload: ${detailError.message}`} onRetry={refreshDetail} /></div>}
                  {detail.counts.fragment_errors > 0 && (
                    <div className="mt-3"><ErrorBox compact message={`${plural(detail.counts.fragment_errors, "fragment couldn't", "fragments couldn't")} be loaded from StreamSets - their stages aren't shown.`} /></div>
                  )}
                  {view !== 'flow' && <RouteSummary detail={detail} />}
                  <nav className="mt-2 flex gap-5" aria-label="Pipeline views">
                    {VIEWS.map(v => (
                      <button key={v.id} type="button" onClick={() => navigate({ ssview: v.id === 'flow' ? null : v.id })}
                        aria-current={view === v.id ? 'page' : undefined}
                        className={`h-[36px] text-[13px] border-b-2 ${view === v.id ? 'border-[#eb1700] text-[#1b1f24] font-semibold' : 'border-transparent text-[#57606a] hover:text-[#1b1f24]'}`}>
                        {v.label}
                        <span className="ml-1.5 font-normal text-[#8b949e]">
                          {v.id === 'params' ? detail.counts.parameters : v.id === 'stages' ? flattenStages(detail.stages).length : ''}
                        </span>
                      </button>
                    ))}
                  </nav>
                </div>
              </header>

              <div className="flex-1 min-h-0 flex border-t border-[#e4e8ec]">
                <div className={`flex-1 min-w-0 ${view === 'flow' ? 'bg-[#fafbfc]' : 'overflow-y-auto'}`}>
                  {view === 'flow' && (
                    <Suspense fallback={<div className="h-full flex items-center justify-center text-[12.5px] text-[#8b949e]">Drawing the pipeline…</div>}>
                      <PipelineCanvas key={detail.id} detail={detail} selectedPath={stagePath} onSelect={selectStage} live={liveHere} />
                    </Suspense>
                  )}
                  {view === 'stages' && <StagesView key={detail.id} detail={detail} selectedPath={stagePath} onSelect={selectStage} />}
                  {view === 'params' && <ParamsView key={detail.id} detail={detail} onSelect={(p) => navigate({ stage: p })} />}
                </div>
                {found && <StageDrawer key={`${detail.id}:${stagePath}`} found={found} path={stagePath} detail={detail} onSelect={(p) => navigate({ stage: p })} onClose={closeStage} />}
              </div>
            </div>
          )}
        </div>
      </div>

      {run && (
        <RunPanel run={run} onCancel={cancelRun} onClose={() => setRun(null)} onDownload={downloadReport}
          onOpenPipeline={openPipeline} />
      )}
    </div>
  );
}