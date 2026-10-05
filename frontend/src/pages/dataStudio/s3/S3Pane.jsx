import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchJson, formatBytes, formatWhen, cellText } from '../shared/studioHelpers';
import { Icon, SkeletonLine } from '../shared/studioParts';
import { apiFetch, apiEventSource, downloadFile } from '../../../utils/apiClient';

import refreshIcon from "/icons/JJ_Icon_Refresh_RGB.svg";
import downloadIcon from "/icons/JJ_Icon_Download_PDF_RGB.svg";
import searchIcon from "/icons/JJ_Icon_Search_RGB.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import closeIcon from "/icons/JJ_Icon_Close.svg";
import deleteIcon from "/icons/JJ_Icon_Delete_RGB.svg";
import addIcon from "/icons/JJ_Icon_Add.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import linkIcon from "/icons/JJ_Icon_Link_RGB.svg";
import s3Icon from "/icons/s3_badge.svg";
import expandIcon from "/icons/JJ_Icon_Unfold_All_More.svg";

/* ==========================================================================
   S3 Explorer — a Data Studio pane.

   Where you are lives in the URL, not in component state: ?bucket, ?prefix,
   ?key (the object open in the detail pane), ?view=search and ?q (the last
   query run there). Browser back walks back out through folders, and any view
   can be pasted to someone else - everything below just renders whatever
   those params say.
   ========================================================================== */

// Only the colours used from JS live here; the rest of the chrome is Tailwind
// classes, matching the Snowflake console next door.
const C = {
  muted: '#5c6670',
  faint: '#8a949e',
  primary: '#11567f',
  accent: '#29b5e8',
  green: '#1f8f4e',
  red: '#c02b2b',
  amber: '#b8730d',
};

const q = (params) => Object.entries(params)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
  .join('&');

const parentOf = (prefix) => {
  const trimmed = (prefix || '').replace(/\/$/, '');
  if (!trimmed.includes('/')) return '';
  return `${trimmed.slice(0, trimmed.lastIndexOf('/'))}/`;
};

const crumbsOf = (prefix) => {
  const parts = (prefix || '').split('/').filter(Boolean);
  let running = '';
  return parts.map(part => {
    running += `${part}/`;
    return { label: part, prefix: running };
  });
};

const readStored = (key) => {
  try { return window.localStorage.getItem(key); } catch { return null; }
};
const writeStored = (key, value) => {
  try { window.localStorage.setItem(key, String(value)); } catch { /* private mode */ }
};

const extOf = (key) => {
  const name = String(key || '').split('/').pop();
  return name.includes('.') ? name.split('.').pop().toLowerCase() : '';
};

const baseOf = (key) => String(key || '').replace(/\/$/, '').split('/').pop();

/**
 * Turn whatever got pasted into { bucket, path }.
 *
 * Handles the shapes people actually paste: an s3:// URI, a virtual-hosted or
 * path-style https URL, an AWS console link, "bucket/some/prefix", a leading
 * slash for "this bucket, from the root", or a bare folder name meaning
 * "into that folder from here" - the same way an Explorer address bar does.
 * Returns null when there is nothing usable in the string.
 */
const parseS3Path = (raw, currentBucket, knownBuckets = []) => {
  let text = String(raw || '').trim().replace(/\\/g, '/');
  if (!text) return null;
  text = text.replace(/^["']|["']$/g, '');

  // Console links carry the prefix in the query string.
  const consoleMatch = /^https?:\/\/[^/]*\/s3\/(?:buckets|object)\/([^/?#]+)/i.exec(text);
  if (consoleMatch) {
    const query = text.split('?')[1] || '';
    const prefixParam = /(?:^|&)prefix=([^&]*)/.exec(query);
    return {
      bucket: decodeURIComponent(consoleMatch[1]),
      path: prefixParam ? decodeURIComponent(prefixParam[1]) : '',
    };
  }

  // https://<bucket>.s3.<region>.amazonaws.com/<key>
  const virtualHosted = /^https?:\/\/([^./]+)\.s3[.-][^/]*\/(.*)$/i.exec(text);
  if (virtualHosted) {
    return { bucket: virtualHosted[1], path: decodeURIComponent(virtualHosted[2].split('?')[0]) };
  }

  // https://s3.<region>.amazonaws.com/<bucket>/<key>
  const pathStyle = /^https?:\/\/[^/]*s3[^/]*\/([^/]+)\/?(.*)$/i.exec(text);
  if (pathStyle) {
    return { bucket: pathStyle[1], path: decodeURIComponent((pathStyle[2] || '').split('?')[0]) };
  }

  // An explicit s3:// URI always names its bucket, whether or not we can see it.
  if (/^s3a?:\/\//i.test(text)) {
    const [named, ...tail] = text.replace(/^s3a?:\/\//i, '').split('/');
    return { bucket: named, path: tail.join('/') };
  }

  text = text.replace(/^\/{2,}/, '/');

  // A leading slash means "this bucket, from the root".
  if (text.startsWith('/')) return { bucket: currentBucket, path: text.slice(1) };

  const [head, ...rest] = text.split('/');
  if (knownBuckets.includes(head)) return { bucket: head, path: rest.join('/') };

  // Not a bucket name - treat the whole thing as a path inside the current one.
  return { bucket: currentBucket, path: text };
};

const EXT_COLOR = {
  csv: C.green, tsv: C.green, parquet: '#7b3fe4', json: C.amber, jsonl: C.amber,
  ndjson: C.amber, txt: C.muted, log: C.muted, gz: '#8a949e', zip: '#8a949e',
};

const FileMark = ({ ext }) => (
  <span
    className="flex-shrink-0 w-[30px] text-center font-mono text-[9px] font-bold uppercase"
    style={{ color: EXT_COLOR[ext] || C.faint }}
  >
    {ext ? ext.slice(0, 4) : '•'}
  </span>
);

const FolderMark = () => (
  <svg viewBox="0 0 16 16" className="flex-shrink-0 w-[14px] h-[14px] mx-2" aria-hidden="true">
    <path
      d="M1.5 3.5h4l1.4 1.6h7.6v7.4a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1z"
      fill="#e3f2fa" stroke="#11567f" strokeWidth="1.1" strokeLinejoin="round"
    />
  </svg>
);

const Spinner = ({ className = 'w-3 h-3' }) => (
  <svg viewBox="0 0 16 16" className={`${className} animate-spin`} aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" fill="none" stroke="#dfe3e8" strokeWidth="2" />
    <path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" fill="none" stroke="#11567f" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const SortHeader = ({ id, sort, onSort, className = '', align = '', children }) => {
  const active = sort.column === id;
  return (
    <th className={`py-1.5 border-b border-[#dfe3e8] font-medium ${className}`}>
      <button
        onClick={() => onSort(id)}
        className={`flex items-center gap-1 w-full ${align} ${active ? 'text-[#11567f]' : 'hover:text-[#1a1d21]'}`}
      >
        {children}
        <span className="text-[8px] leading-none">
          {active ? (sort.direction === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </th>
  );
};

/* ------------------------------- skeletons -------------------------------- */

const RowSkeleton = ({ rows = 9 }) => (
  <tbody>
    {Array.from({ length: rows }).map((_, r) => (
      <tr key={r}>
        <td className="px-2 py-[9px] border-b border-[#eceff2]"><SkeletonLine w="13px" h={11} /></td>
        <td className="px-2 py-[9px] border-b border-[#eceff2]">
          <div className="flex items-center gap-2">
            <SkeletonLine w="22px" h={9} />
            <SkeletonLine w={`${120 + ((r * 37) % 160)}px`} h={9} />
          </div>
        </td>
        <td className="px-3 py-[9px] border-b border-[#eceff2]"><SkeletonLine w="46px" h={9} /></td>
        <td className="px-3 py-[9px] border-b border-[#eceff2]"><SkeletonLine w="62px" h={9} /></td>
        <td className="px-3 py-[9px] border-b border-[#eceff2]"><SkeletonLine w="70px" h={9} /></td>
        <td className="px-3 py-[9px] border-b border-[#eceff2]" />
      </tr>
    ))}
  </tbody>
);

const BucketSkeleton = ({ rows = 6 }) => (
  <div className="py-1 space-y-2">
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="px-3 py-1">
        <SkeletonLine w={`${70 + ((i * 29) % 70)}px`} h={9} />
      </div>
    ))}
  </div>
);

const DetailSkeleton = () => (
  <div className="p-3 space-y-3">
    <SkeletonLine w="100%" h={9} />
    <SkeletonLine w="86%" h={9} />
    <SkeletonLine w="93%" h={9} />
    <SkeletonLine w="72%" h={9} />
    <SkeletonLine w="88%" h={9} />
  </div>
);

/* ------------------------------ preview pane ------------------------------ */

// Modes that render as themselves rather than as a slab of text - they get a
// wider pane and a full-screen view.
const RICH_MODES = ['pdf', 'image', 'document', 'sheets'];

// These two bring their own scroll container, so the pane must not add one.
const SELF_SCROLLING_MODES = ['pdf', 'sheets'];

const PreviewTable = ({ columns, rows }) => (
  <div className="overflow-auto">
    <table className="min-w-full border-collapse">
      <thead className="sticky top-0 bg-[#f5f7f9]">
        <tr>
          {columns.map((col, i) => (
            <th
              key={`${col}-${i}`}
              className="text-left px-2.5 py-1.5 border-b border-[#dfe3e8] text-[11px] font-medium whitespace-nowrap"
            >
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r} className="hover:bg-[#fbfcfd]">
            {row.map((cell, c) => (
              <td
                key={c}
                className="px-2.5 py-1 border-b border-[#eceff2] text-[11.5px] font-mono whitespace-nowrap max-w-[260px] truncate"
                title={cellText(cell) ?? ''}
              >
                {cell === null || cell === undefined
                  ? <span className="text-[#c8d0d8] italic">null</span>
                  : cellText(cell)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/* Workbooks come back a sheet at a time, so the pane gets the tab strip every
   spreadsheet has. One sheet and the strip is pointless, so it is dropped. */
function SheetsBody({ sheets }) {
  const [active, setActive] = useState(0);
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  if (!sheet) return null;

  return (
    <div className="flex flex-col min-h-0 h-full">
      {sheets.length > 1 && (
        <div className="flex-shrink-0 flex items-center gap-1 px-2 py-1 border-b border-[#eceff2] bg-[#fbfcfd] overflow-x-auto">
          {sheets.map((s, i) => (
            <button
              key={`${s.name}-${i}`}
              onClick={() => setActive(i)}
              title={s.name}
              className={`px-2 py-0.5 rounded text-[11px] whitespace-nowrap ${
                i === active
                  ? 'bg-white border border-[#dfe3e8] text-[#11567f] font-medium'
                  : 'text-[#5c6670] hover:bg-[#f1f4f7]'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        {sheet.rows.length === 0 && sheet.columns.length === 0
          ? <div className="p-3.5 text-[12px] text-[#8a949e]">This sheet is empty.</div>
          : <PreviewTable columns={sheet.columns} rows={sheet.rows} />}
      </div>
      <div className="flex-shrink-0 px-3 py-1 border-t border-[#eceff2] text-[11px] text-[#8a949e]">
        {sheet.row_count?.toLocaleString?.() ?? sheet.rows.length} row{sheet.row_count === 1 ? '' : 's'}
        {sheet.truncated && <span className="text-[#b8730d]"> · first rows only</span>}
      </div>
    </div>
  );
}

/* Word, RTF and PowerPoint text comes back as typed blocks rather than HTML -
   a file out of a landing bucket is never trusted enough to render as markup. */
const HEADING_CLASS = {
  1: 'text-[14px] font-johnson-display font-bold mt-2',
  2: 'text-[13px] font-johnson-display font-bold mt-2',
  3: 'text-[12.5px] font-medium mt-1.5',
};

function DocumentBody({ blocks }) {
  return (
    <div className="px-3.5 py-3 text-[12px] leading-[1.65] text-[#1a1d21] space-y-1.5">
      {blocks.map((block, i) => {
        if (block.type === 'heading') {
          return (
            <div key={i} className={HEADING_CLASS[block.level] || HEADING_CLASS[3]}>
              {block.text}
            </div>
          );
        }
        if (block.type === 'bullet') {
          return (
            <div key={i} className="flex gap-1.5 pl-1">
              <span className="text-[#8a949e]">•</span>
              <span className="flex-1">{block.text}</span>
            </div>
          );
        }
        if (block.type === 'table') {
          return (
            <div key={i} className="my-2 border border-[#dfe3e8] rounded overflow-auto">
              <PreviewTable columns={block.columns} rows={block.rows} />
            </div>
          );
        }
        if (block.type === 'note') {
          return (
            <div key={i} className="text-[11px] text-[#b8730d] bg-[#fdf6ec] border border-[#f2e2c4] rounded px-2 py-1">
              {block.text}
            </div>
          );
        }
        if (block.type === 'spacer') return <div key={i} className="h-1.5" />;
        return <p key={i} className="whitespace-pre-wrap break-words">{block.text}</p>;
      })}
    </div>
  );
}

/**
 * The raw endpoint needs the bearer token, so the browser cannot be pointed
 * straight at it - fetch the bytes here and hand the viewer a blob URL. The
 * URL is revoked on unmount, otherwise browsing a folder of PDFs leaks the
 * whole folder into memory.
 */
function useObjectUrl(rawUrl) {
  const [state, setState] = useState({ url: null, error: null, loading: Boolean(rawUrl) });

  useEffect(() => {
    if (!rawUrl) {
      setState({ url: null, error: null, loading: false });
      return undefined;
    }

    let cancelled = false;
    let objectUrl = null;
    setState({ url: null, error: null, loading: true });

    (async () => {
      try {
        const response = await apiFetch(rawUrl);
        if (!response.ok) {
          let detail = `Could not load the file (${response.status})`;
          try {
            const body = await response.clone().json();
            detail = body.detail || detail;
          } catch { /* not JSON */ }
          throw new Error(detail);
        }
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, error: null, loading: false });
      } catch (err) {
        if (!cancelled) setState({ url: null, error: err.message || 'Could not load the file', loading: false });
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [rawUrl]);

  return state;
}

function InlineBody({ preview, name }) {
  const { url, error, loading } = useObjectUrl(preview.raw_url);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center gap-2 text-[12px] text-[#8a949e]">
        <Spinner className="w-3 h-3" /> Loading {preview.mode === 'pdf' ? 'the document' : 'the image'}…
      </div>
    );
  }
  if (error) return <div className="p-3.5 text-[12px] text-[#c02b2b]">{error}</div>;
  if (!url) return null;

  if (preview.mode === 'image') {
    return (
      <div className="p-3 flex items-start justify-center">
        <img src={url} alt={name || 'preview'} className="max-w-full object-contain" />
      </div>
    );
  }

  return (
    <iframe
      src={url}
      title={name || 'PDF preview'}
      className="w-full h-full border-0 bg-[#f5f7f9]"
    />
  );
}

function PreviewBody({ preview, loading, name }) {
  if (loading) return <DetailSkeleton />;
  if (!preview) return null;

  if (preview.mode === 'table') {
    return <PreviewTable columns={preview.columns} rows={preview.rows} />;
  }

  if (preview.mode === 'sheets') {
    return <SheetsBody sheets={preview.sheets || []} />;
  }

  if (preview.mode === 'document') {
    return <DocumentBody blocks={preview.blocks || []} />;
  }

  if (preview.mode === 'pdf' || preview.mode === 'image') {
    return <InlineBody preview={preview} name={name} />;
  }

  if (preview.mode === 'text') {
    return (
      <pre className="p-3 text-[11.5px] font-mono leading-[1.65] whitespace-pre-wrap break-words">
        {preview.text}
      </pre>
    );
  }

  if (preview.mode === 'empty') {
    return <div className="p-3.5 text-[12px] text-[#8a949e]">This object is empty (0 bytes).</div>;
  }

  return (
    <div className="p-3.5 text-[12px] text-[#5c6670]">
      {preview.message || 'No preview available for this file type.'}
    </div>
  );
}

/* =============================== search view ==============================

   S3 has no server-side search, so a search is a recursive scan of every key
   under the prefix. That can run for a while, so the API streams what it is
   doing and this screen shows the running log rather than a spinner.
   ========================================================================== */

// Sliders snap to a scale rather than sweeping every integer - nobody wants to
// land on "stop after 3,417 matches".
const MATCH_STEPS = [25, 50, 100, 250, 500, 1000, 2500, 5000];
const SCAN_STEPS = [1000, 2500, 5000, 10000, 20000, 50000, 100000, 250000];

const stepsUpTo = (steps, ceiling) => {
  const usable = steps.filter(n => n < ceiling);
  return [...usable, ceiling];
};

const nearestIndex = (steps, value) => {
  let best = 0;
  steps.forEach((n, i) => { if (Math.abs(n - value) < Math.abs(steps[best] - value)) best = i; });
  return best;
};

const LimitSlider = ({ label, steps, value, onChange, disabled, suffix }) => {
  const index = nearestIndex(steps, value);
  return (
    <label className="flex items-center gap-2 min-w-0">
      <span className="flex-shrink-0 text-[#5c6670]">{label}</span>
      <input
        type="range"
        min={0}
        max={steps.length - 1}
        step={1}
        value={index}
        onChange={e => onChange(steps[Number(e.target.value)])}
        disabled={disabled}
        className="w-[120px] accent-[#11567f] disabled:opacity-50"
      />
      <span className="flex-shrink-0 w-[86px] tabular-nums font-medium text-[#1a1d21]">
        {steps[index].toLocaleString()} {suffix}
      </span>
    </label>
  );
};

const LOG_COLOR = {
  info: C.muted,
  match: C.primary,
  ok: C.green,
  warn: C.amber,
  error: C.red,
};

const clock = (d) => d.toLocaleTimeString([], { hour12: false });

const STATUS_LABEL = {
  idle: 'Ready',
  connecting: 'Opening the scan…',
  scanning: 'Scanning',
  done: 'Finished',
  stopped: 'Stopped',
  failed: 'Failed',
};

const STATUS_COLOR = {
  idle: C.faint,
  connecting: C.accent,
  scanning: C.accent,
  done: C.green,
  stopped: C.amber,
  failed: C.red,
};

function SearchView({ bucket, account, prefix, initialQuery, caps, onOpenFile, onClose, onQueryRun }) {
  const serverScanCap = caps?.scanCap || 20000;
  const serverMaxMatches = caps?.maxMatches || 5000;

  const matchSteps = useMemo(() => stepsUpTo(MATCH_STEPS, serverMaxMatches), [serverMaxMatches]);
  const scanSteps = useMemo(() => stepsUpTo(SCAN_STEPS, serverScanCap), [serverScanCap]);

  const [draft, setDraft] = useState(initialQuery || '');
  const [scope, setScope] = useState(prefix ? 'prefix' : 'bucket');
  // Remembered per browser - whoever tunes these once means it.
  const [limit, setLimit] = useState(() => {
    const stored = Number(readStored('s3.search.limit'));
    return stored && stored <= serverMaxMatches ? stored : Math.min(500, serverMaxMatches);
  });
  const [scanCap, setScanCap] = useState(() => {
    const stored = Number(readStored('s3.search.scanCap'));
    return stored && stored <= serverScanCap ? stored : serverScanCap;
  });
  const [status, setStatus] = useState('idle');
  const [log, setLog] = useState([]);
  const [results, setResults] = useState([]);
  const [stats, setStats] = useState({ scanned: 0, matched: 0, pages: 0, elapsed_ms: 0 });
  const [elapsed, setElapsed] = useState(0);

  const streamRef = useRef(null);
  const startedAt = useRef(0);
  const logRef = useRef(null);
  const inputRef = useRef(null);

  const scopePrefix = scope === 'prefix' ? prefix : '';
  const running = status === 'connecting' || status === 'scanning';

  const say = useCallback((kind, text) => {
    setLog(prev => [...prev.slice(-499), { kind, text, at: new Date() }]);
  }, []);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Keep the log pinned to the newest line.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // A ticking clock while the scan runs - a frozen number reads like a hang.
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setElapsed(Date.now() - startedAt.current), 100);
    return () => clearInterval(timer);
  }, [running]);

  const stop = useCallback((why) => {
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
      if (why) {
        setStatus('stopped');
        say('warn', why);
      }
    }
  }, [say]);

  useEffect(() => () => { if (streamRef.current) streamRef.current.close(); }, []);

  const run = () => {
    const query = draft.trim();
    if (!query) return;
    stop();

    setStatus('connecting');
    setResults([]);
    setStats({ scanned: 0, matched: 0, pages: 0, elapsed_ms: 0 });
    setElapsed(0);
    startedAt.current = Date.now();
    setLog([{
      kind: 'info',
      at: new Date(),
      text: `Scanning s3://${bucket}/${scopePrefix} for keys containing "${query}" `
        + `(stop at ${limit.toLocaleString()} matches or ${scanCap.toLocaleString()} keys)`,
    }]);
    if (typeof onQueryRun === 'function') onQueryRun(query);

    writeStored('s3.search.limit', limit);
    writeStored('s3.search.scanCap', scanCap);

    const stream = apiEventSource(`/api/s3/search/stream?${q({
      bucket, account, prefix: scopePrefix, q: query, limit, scan_cap: scanCap,
    })}`);
    streamRef.current = stream;

    stream.addEventListener('start', () => {
      setStatus('scanning');
      say('info', 'Connected — walking the key list one page at a time.');
    });

    stream.addEventListener('matches', (e) => {
      const data = JSON.parse(e.data);
      setResults(prev => [...prev, ...data.files]);
      data.files.forEach(f => say('match', f.key));
    });

    stream.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      setStats({
        scanned: data.scanned, matched: data.matched,
        pages: data.page, elapsed_ms: data.elapsed_ms,
      });
      // One line per page would drown the log on a big bucket - every tenth
      // page, plus the first, is enough to show it is moving.
      if (data.page === 1 || data.page % 10 === 0) {
        say('info', `Page ${data.page} · ${data.scanned.toLocaleString()} keys scanned · ${data.matched} match${data.matched === 1 ? '' : 'es'}`);
      }
    });

    stream.addEventListener('done', (e) => {
      const data = JSON.parse(e.data);
      setStats({
        scanned: data.scanned, matched: data.matched,
        pages: data.pages, elapsed_ms: data.elapsed_ms,
      });
      setElapsed(data.elapsed_ms);
      setStatus('done');
      if (data.stopped_because === 'limit') {
        say('warn', `Stopped at the ${data.matched.toLocaleString()}-match limit — raise it, or narrow the search, to see the rest.`);
      } else if (data.stopped_because === 'cap') {
        say('warn', `Stopped after ${data.scanned.toLocaleString()} keys — raise the limit, or search inside a sub-folder.`);
      }
      say('ok', `Done in ${(data.elapsed_ms / 1000).toFixed(1)}s — ${data.matched.toLocaleString()} match${data.matched === 1 ? '' : 'es'} out of ${data.scanned.toLocaleString()} keys.`);
      streamRef.current = null;
    });

    stream.addEventListener('failed', (e) => {
      const data = JSON.parse(e.data);
      setStatus('failed');
      say('error', data.message || 'The scan failed.');
      streamRef.current = null;
    });

    // Transport-level trouble, as opposed to the server's own "failed" event.
    stream.onerror = (e) => {
      if (streamRef.current !== stream) return;   // already finished or stopped
      setStatus('failed');
      say('error', e?.status
        ? `The search stream was refused (${e.status}${e.message ? ` ${e.message}` : ''}).`
        : 'The connection to the search stream dropped.');
      streamRef.current = null;
    };
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">

      {/* query row */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-[#dfe3e8] bg-[#fbfcfd]">
        <div className="flex items-center gap-2">
          <Icon src={searchIcon} className="w-3.5 h-3.5 flex-shrink-0" tint="gray" />
          <input
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') run();
              if (e.key === 'Escape') onClose();
            }}
            placeholder="Part of a key — file name, folder, extension…"
            className="flex-1 min-w-0 h-[32px] px-3 rounded border border-[#dfe3e8] text-[12.5px] focus:border-[#11567f] outline-none"
          />
          <button
            onClick={run}
            disabled={!draft.trim() || running}
            className="h-[32px] px-4 rounded bg-[#11567f] text-white text-[12.5px] font-medium hover:bg-[#0d4363] disabled:opacity-50"
          >
            Search
          </button>
          {running && (
            <button
              onClick={() => stop('Stopped by you.')}
              className="h-[32px] px-4 rounded border border-[#dfe3e8] text-[12.5px] hover:bg-[#f5f7f9]"
            >
              Stop
            </button>
          )}
          <button onClick={onClose} title="Back to browsing" className="p-1.5 rounded hover:bg-[#eceff2]">
            <Icon src={closeIcon} className="w-3 h-3" tint="gray" />
          </button>
        </div>

        <div className="flex items-center gap-4 mt-2 text-[11.5px] text-[#5c6670]">
          <span>Look in</span>
          {prefix && (
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" checked={scope === 'prefix'} onChange={() => setScope('prefix')} disabled={running} />
              <span className="font-mono">/{prefix}</span>
            </label>
          )}
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="radio" checked={scope === 'bucket'} onChange={() => setScope('bucket')} disabled={running} />
            the whole bucket
          </label>
          <span className="text-[#8a949e]">
            · every key under it is read, so a narrow scope finishes sooner
          </span>
        </div>

        <div className="flex items-center gap-6 mt-2 text-[11.5px] flex-wrap">
          <LimitSlider
            label="Stop after"
            steps={matchSteps}
            value={limit}
            onChange={setLimit}
            disabled={running}
            suffix="matches"
          />
          <LimitSlider
            label="or after"
            steps={scanSteps}
            value={scanCap}
            onChange={setScanCap}
            disabled={running}
            suffix="keys read"
          />
          {scanCap >= serverScanCap && (
            <span className="text-[#8a949e]">
              {serverScanCap.toLocaleString()} keys is the ceiling this environment allows
            </span>
          )}
        </div>
      </div>

      {/* status + counters */}
      <div className="flex-shrink-0 flex items-center gap-4 px-4 py-2 border-b border-[#dfe3e8] text-[11.5px]">
        <span className="flex items-center gap-2 font-medium" style={{ color: STATUS_COLOR[status] }}>
          {running
            ? <Spinner className="w-3 h-3" />
            : <span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_COLOR[status] }} />}
          {STATUS_LABEL[status]}
        </span>
        <span className="tabular-nums text-[#5c6670]">
          {stats.matched.toLocaleString()} match{stats.matched === 1 ? '' : 'es'}
        </span>
        <span className="tabular-nums text-[#5c6670]">{stats.scanned.toLocaleString()} keys scanned</span>
        <span className="tabular-nums text-[#5c6670]">{stats.pages.toLocaleString()} page{stats.pages === 1 ? '' : 's'}</span>
        <span className="tabular-nums text-[#8a949e] ml-auto">
          {((running ? elapsed : stats.elapsed_ms || elapsed) / 1000).toFixed(1)}s
        </span>
      </div>

      {/* results | log */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-auto">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-[#8a949e]">
              {status === 'idle' ? 'Type something and hit Search.'
                : running ? 'Nothing matched yet — the scan is still running.'
                  : status === 'failed' ? 'The scan did not finish.'
                    : 'Nothing matched that search.'}
            </div>
          ) : (
            <table className="min-w-full border-collapse">
              <thead className="sticky top-0 bg-[#f5f7f9]">
                <tr className="text-[11px] text-[#5c6670]">
                  <th className="text-left px-3 py-1.5 border-b border-[#dfe3e8] font-medium">Key</th>
                  <th className="text-right px-3 py-1.5 border-b border-[#dfe3e8] font-medium w-[100px]">Size</th>
                  <th className="text-left px-3 py-1.5 border-b border-[#dfe3e8] font-medium w-[120px]">Modified</th>
                </tr>
              </thead>
              <tbody>
                {results.map(file => (
                  <tr
                    key={file.key}
                    onClick={() => onOpenFile(file)}
                    className="cursor-pointer hover:bg-[#fbfcfd]"
                  >
                    <td className="px-3 py-1.5 border-b border-[#eceff2]">
                      <div className="flex items-center min-w-0">
                        <FileMark ext={file.extension} />
                        <span className="text-[12.5px] truncate" title={file.key}>{file.key}</span>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 border-b border-[#eceff2] text-right text-[11.5px] tabular-nums">
                      {formatBytes(file.size) || '—'}
                    </td>
                    <td className="px-3 py-1.5 border-b border-[#eceff2] text-[11.5px] text-[#5c6670]">
                      {formatWhen(file.last_modified) || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="w-[330px] flex-shrink-0 border-l border-[#dfe3e8] bg-[#fbfcfd] flex flex-col min-h-0">
          <div className="flex-shrink-0 flex items-center h-[30px] px-3 border-b border-[#dfe3e8] text-[11px] text-[#5c6670]">
            Activity
            {log.length > 0 && <span className="ml-auto text-[#8a949e]">{log.length} line{log.length === 1 ? '' : 's'}</span>}
          </div>
          <div ref={logRef} className="flex-1 min-h-0 overflow-auto px-3 py-2 space-y-1">
            {log.length === 0 && <div className="text-[11px] text-[#8a949e]">Nothing to report yet.</div>}
            {log.map((line, i) => (
              <div key={i} className="flex gap-2 text-[11px] font-mono leading-[1.5]">
                <span className="flex-shrink-0 text-[#c8d0d8] tabular-nums">{clock(line.at)}</span>
                <span className="min-w-0 break-all" style={{ color: LOG_COLOR[line.kind] || C.muted }}>
                  {line.kind === 'match' ? `match  ${line.text}` : line.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================================ component =============================== */

export default function S3Pane({ logInPage, active = true }) {
  const [params, setParams] = useSearchParams();

  // Everything about "where am I" comes out of the URL.
  const bucket = params.get('bucket') || '';
  // Two accounts can each hold a bucket of the same name, so which credentials
  // the address belongs to is part of the address.
  const account = params.get('account') || '';
  const prefix = params.get('prefix') || '';
  const search = params.get('q') || '';
  const openKey = params.get('key') || '';
  const searching = params.get('view') === 'search';

  const [info, setInfo] = useState(null);
  const [phase, setPhase] = useState('booting');   // booting | ready | unconfigured | error
  const [fatal, setFatal] = useState(null);
  const [buckets, setBuckets] = useState([]);
  const [bucketErrors, setBucketErrors] = useState([]);

  const [folders, setFolders] = useState([]);
  const [files, setFiles] = useState([]);
  const [nextToken, setNextToken] = useState(null);
  const [listing, setListing] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [selected, setSelected] = useState(() => new Set());
  const [sort, setSort] = useState({ column: 'name', direction: 'asc' });

  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [trailClipped, setTrailClipped] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(null);      // { done, total, name }
  const [pendingUpload, setPendingUpload] = useState(null);   // { files, clashes }
  const [resolvingPath, setResolvingPath] = useState(false);

  const [bucketFilter, setBucketFilter] = useState('');
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState('');

  const uploadRef = useRef(null);
  const pathRef = useRef(null);
  const crumbsRef = useRef(null);
  const rootRef = useRef(null);
  const listId = useRef(0);
  const detailId = useRef(0);
  const shownAddress = useRef('');

  const track = useCallback((target, details) => {
    if (typeof logInPage === 'function') logInPage(target, details);
  }, [logInPage]);

  /* ------------------------------ navigation ------------------------------ */

  /** Write a patch into the query string. Anything null/'' is dropped. */
  const navigate = useCallback((patch, { replace = false } = {}) => {
    setParams(prev => {
      const next = new URLSearchParams(prev);
      Object.entries(patch).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') next.delete(key);
        else next.set(key, String(value));
      });
      return next;
    }, { replace });
  }, [setParams]);

  const goToPrefix = (nextPrefix) => {
    navigate({ prefix: nextPrefix, key: null, view: null });
    track('s3_browse', `Opened s3://${bucket}/${nextPrefix || ''}`);
  };

  const goToBucket = (name, forAccount = '') => {
    if (name === bucket && (forAccount || '') === account) return;
    navigate({ bucket: name, account: forAccount || null, prefix: null, q: null, key: null, view: null });
    track('s3_bucket', `Switched to bucket ${name}${forAccount ? ` (${forAccount})` : ''}`);
  };

  /* ------------------------------- bootstrap ------------------------------ */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const health = await fetchJson('/api/s3/health');
        if (cancelled) return;
        setInfo(health);
        const list = await fetchJson('/api/s3/buckets');
        if (cancelled) return;
        setBuckets(list.buckets || []);
        // One account failing to enumerate is not fatal - the others still list.
        setBucketErrors(list.errors || []);
        setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        setFatal(err.message);
        setPhase(err.status === 503 ? 'unconfigured' : 'error');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pin a valid bucket into the URL so the address is always shareable, and
  // so an empty or unknown ?bucket falls back instead of showing nothing.
  useEffect(() => {
    if (phase !== 'ready' || buckets.length === 0) return;
    const known = buckets.filter(b => b.name === bucket);
    // A bucket named in the URL without an account, or with one that no longer
    // exists, settles onto the first account that actually holds it.
    if (known.length && (!account || known.some(b => b.account === account))) return;
    const target = known[0] || buckets[0];
    navigate(
      { bucket: target.name, account: target.account || null, prefix: known.length ? prefix : null, key: null, view: null },
      { replace: true },
    );
  }, [phase, buckets, bucket, account, prefix, navigate]);

  // Which credential set the current bucket is being read with, and what it
  // lets you do - the write flags are per account, not per deployment.
  const activeBucket = useMemo(
    () => buckets.find(b => b.name === bucket && (!account || b.account === account))
      || buckets.find(b => b.name === bucket)
      || null,
    [buckets, bucket, account],
  );
  const accounts = useMemo(
    () => Array.from(new Set(buckets.map(b => b.account).filter(Boolean))),
    [buckets],
  );
  const multiAccount = accounts.length > 1;

  /* -------------------------------- listing ------------------------------- */

  // Any change of address reloads the middle pane. The request id guard means
  // a slow response for a folder you already left can never paint over the
  // folder you are actually looking at.
  useEffect(() => {
    if (phase !== 'ready' || !bucket) return undefined;
    const id = ++listId.current;
    let cancelled = false;

    // Rows from a different folder would be misleading, so those go at once.
    // A same-folder reload keeps what is on screen until the new page lands.
    const address = `${account}\u0000${bucket}\u0000${prefix}`;
    if (shownAddress.current !== address) {
      setFolders([]);
      setFiles([]);
      setSelected(new Set());
      shownAddress.current = address;
    }
    setListing(true);
    setError(null);
    setNextToken(null);

    (async () => {
      try {
        const data = await fetchJson(`/api/s3/objects?${q({ bucket, account, prefix, page_size: 200 })}`);
        if (cancelled || id !== listId.current) return;
        setFolders(data.folders || []);
        setFiles(data.files || []);
        setNextToken(data.next_token || null);
      } catch (err) {
        if (cancelled || id !== listId.current) return;
        setError(err.message || 'Could not list that prefix');
      } finally {
        if (!cancelled && id === listId.current) setListing(false);
      }
    })();

    return () => { cancelled = true; };
  }, [phase, bucket, account, prefix, reloadNonce]);

  const loadMore = async () => {
    if (!nextToken || loadingMore) return;
    const id = listId.current;
    setLoadingMore(true);
    try {
      const data = await fetchJson(`/api/s3/objects?${q({ bucket, account, prefix, token: nextToken, page_size: 200 })}`);
      if (id !== listId.current) return;
      setFolders(prev => [...prev, ...(data.folders || [])]);
      setFiles(prev => [...prev, ...(data.files || [])]);
      setNextToken(data.next_token || null);
    } catch (err) {
      if (id === listId.current) setError(err.message || 'Could not load the next page');
    } finally {
      if (id === listId.current) setLoadingMore(false);
    }
  };

  // Re-run the listing effect without changing the address.
  const reload = useCallback(() => setReloadNonce(n => n + 1), []);

  /* ------------------------------ object detail --------------------------- */

  // ?key drives the right-hand pane, so closing it is just a navigation and
  // browser-back steps out of the preview.
  useEffect(() => {
    if (phase !== 'ready' || !bucket || !openKey) {
      setDetail(null);
      setDetailLoading(false);
      return undefined;
    }
    const id = ++detailId.current;
    let cancelled = false;

    setDetail({ meta: { bucket, key: openKey, name: baseOf(openKey), extension: extOf(openKey) }, preview: null });
    setDetailLoading(true);

    (async () => {
      try {
        const [meta, preview] = await Promise.all([
          fetchJson(`/api/s3/object/meta?${q({ bucket, account, key: openKey })}`),
          fetchJson(`/api/s3/object/preview?${q({ bucket, account, key: openKey })}`),
        ]);
        if (cancelled || id !== detailId.current) return;
        setDetail({ meta, preview });
        track('s3_preview', `Previewed s3://${bucket}/${openKey}`);
      } catch (err) {
        if (cancelled || id !== detailId.current) return;
        setDetail(d => ({ ...(d || {}), preview: { mode: 'unsupported', message: err.message } }));
      } finally {
        if (!cancelled && id === detailId.current) setDetailLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [phase, bucket, account, openKey, track]);

  // PDFs, images, documents and workbooks render as themselves rather than as
  // a slab of text, so the pane widens for them and offers a full-screen view.
  const richPreview = RICH_MODES.includes(detail?.preview?.mode);

  // Opening a different object drops out of the full-screen viewer - staying in
  // it while the file underneath changes is disorienting.
  useEffect(() => { setExpanded(false); }, [openKey]);

  // Success notices clear themselves; errors stay until dismissed or replaced.
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  /* ------------------------------ address bar ----------------------------- */

  const startPathEdit = () => {
    setPathDraft(`s3://${bucket || ''}/${prefix || ''}`);
    setEditingPath(true);
  };

  // Escape backs out of whatever is open, like any file browser.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (!active) return;                                        // hidden behind the other pane
      if (editingPath || confirmDelete || pendingUpload) return;   // those handle their own
      if (expanded) { setExpanded(false); return; }                // one step at a time
      if (openKey) navigate({ key: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, editingPath, confirmDelete, pendingUpload, expanded, openKey, navigate]);

  // Ctrl/Cmd+L puts the cursor in the address bar, same as a file browser.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'l' && e.key !== 'L') return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      // This pane stays mounted while hidden behind the Snowflake tab - the
      // shortcut belongs to whichever pane is actually on screen.
      if (!active) return;
      e.preventDefault();
      startPathEdit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, bucket, prefix]);

  useEffect(() => {
    if (editingPath && pathRef.current) {
      pathRef.current.focus();
      pathRef.current.select();
    }
  }, [editingPath]);

  const commitPath = async () => {
    const parsed = parseS3Path(pathDraft, bucket, buckets.map(b => b.name));
    setEditingPath(false);
    if (!parsed || !parsed.bucket) {
      setError("That doesn't look like an S3 path.");
      return;
    }
    // Prefer the account already in the address when the pasted bucket is
    // reachable through it; otherwise take the first account that holds it.
    const match = buckets.find(b => b.name === parsed.bucket && b.account === account)
      || buckets.find(b => b.name === parsed.bucket);
    if (!match) {
      setError(`Bucket "${parsed.bucket}" isn't one you can see here.`);
      return;
    }
    const forAccount = match.account || '';

    let target = (parsed.path || '').replace(/^\/+/, '');
    let objectKey = null;

    // No trailing slash is ambiguous - it could be a folder or a file. Ask S3
    // which it is rather than guessing from the extension.
    if (target && !target.endsWith('/')) {
      setResolvingPath(true);
      try {
        await fetchJson(`/api/s3/object/meta?${q({ bucket: parsed.bucket, account: forAccount, key: target })}`);
        objectKey = target;
        target = parentOf(target);
      } catch {
        target = `${target}/`;
      } finally {
        setResolvingPath(false);
      }
    }

    track('s3_goto', `Jumped to s3://${parsed.bucket}/${objectKey || target}`);
    navigate({ bucket: parsed.bucket, account: forAccount || null, prefix: target, key: objectKey, view: null });
  };

  /* -------------------------------- actions ------------------------------- */

  const download = async (key) => {
    try {
      await downloadFile(`/api/s3/object/download?${q({ bucket, account, key })}`, baseOf(key));
      track('s3_download', `Downloaded s3://${bucket}/${key}`);
    } catch (err) {
      setError(err.message || 'Download failed');
    }
  };

  const copyLink = async (key) => {
    try {
      const data = await fetchJson('/api/s3/object/presign', { method: 'POST', body: { bucket, account, key } });
      await navigator.clipboard.writeText(data.url);
      setNotice(`Link copied — good for ${Math.round(data.expires_in / 60)} minutes.`);
      track('s3_presign', `Created a pre-signed link for s3://${bucket}/${key}`);
    } catch (err) {
      setError(err.message || 'Could not create a link');
    }
  };

  const copyUri = async (key) => {
    try {
      await navigator.clipboard.writeText(`s3://${bucket}/${key}`);
      setNotice('S3 URI copied.');
    } catch {
      setError('The browser blocked clipboard access.');
    }
  };

  const pickUpload = (fileList) => {
    const list = Array.from(fileList || []);
    if (!list.length) return;
    // S3 has no "file exists" check on PUT - it just overwrites. Names are
    // matched against what is loaded for this prefix so a same-name upload
    // asks first instead of quietly replacing someone's file.
    const here = new Set(files.map(f => f.name));
    const clashes = list.filter(f => here.has(f.name)).map(f => f.name);
    if (clashes.length) setPendingUpload({ files: list, clashes });
    else upload(list);
  };

  const upload = async (list) => {
    setPendingUpload(null);
    if (!list.length) return;
    setError(null);
    let done = 0;
    try {
      for (let i = 0; i < list.length; i += 1) {
        const file = list[i];
        setUploading({ done: i, total: list.length, name: file.name });
        // The file goes up as the raw body — the API takes one file per call,
        // so there is nothing for multipart framing to do.
        const res = await apiFetch(`/api/s3/object/upload?${q({
          bucket, account, prefix, filename: file.name, content_type: file.type,
        })}`, {
          method: 'POST',
          body: file,
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(`${file.name}: ${body?.detail || `upload failed (${res.status})`}`);
        }
        done += 1;
      }
      setNotice(`Uploaded ${done} file${done === 1 ? '' : 's'}.`);
      track('s3_upload', `Uploaded ${done} file(s) to s3://${bucket}/${prefix || ''}`);
    } catch (err) {
      setError(done
        ? `${err.message} — ${done} of ${list.length} file(s) did upload.`
        : (err.message || 'Upload failed'));
    } finally {
      setUploading(null);
      if (uploadRef.current) uploadRef.current.value = '';
      // Whatever landed before the failure is really there, so always refresh.
      if (done) reload();
    }
  };

  const runDelete = async () => {
    const keys = confirmDelete.keys;
    setDeleting(true);
    setError(null);
    try {
      const data = await fetchJson('/api/s3/object/delete', { method: 'POST', body: { bucket, account, keys } });
      const failed = data.errors || [];
      if (failed.length) setError(`${failed.length} object(s) could not be deleted: ${failed[0].message}`);
      else setNotice(`Deleted ${data.deleted.length} object${data.deleted.length === 1 ? '' : 's'}.`);
      track('s3_delete', `Deleted ${keys.length} object(s) from s3://${bucket}/${prefix || ''}`);
      if (openKey && keys.includes(openKey)) navigate({ key: null }, { replace: true });
      setSelected(prev => {
        const next = new Set(prev);
        keys.forEach(k => next.delete(k));
        return next;
      });
      reload();
    } catch (err) {
      setError(err.message || 'Delete failed');
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  };

  /* ------------------------------- selection ------------------------------ */

  const toggleOne = (key) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const toggleAll = () => setSelected(prev => (
    prev.size === files.length ? new Set() : new Set(files.map(f => f.key))
  ));

  /* -------------------------------- render -------------------------------- */

  // Per account: one set of keys can be read-only while the other can write.
  const canWrite = activeBucket
    ? activeBucket.allow_writes === true
    : info?.allow_writes === true;
  const canPresign = activeBucket
    ? activeBucket.allow_presign !== false
    : info?.allow_presign === true;
  const crumbs = useMemo(() => crumbsOf(prefix), [prefix]);

  // A deep prefix overflows the strip, and the folder you are in is the end of
  // it - pin the scroll there so that is the part you see. It has to re-pin on
  // resize as well as on navigation: zooming the browser or opening the detail
  // pane narrows the strip without changing the path, and without this the
  // tail end of the trail just disappears.
  useEffect(() => {
    const strip = crumbsRef.current;
    if (!strip) return undefined;

    const pin = () => {
      strip.scrollLeft = strip.scrollWidth;
      setTrailClipped(strip.scrollLeft > 0);
    };
    pin();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', pin);
      return () => window.removeEventListener('resize', pin);
    }
    const observer = new ResizeObserver(pin);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [crumbs, editingPath]);

  // Sorting is over the rows already fetched - S3 hands them back in key
  // order and has no sort of its own, so "Load more" then re-sorts.
  const sortedFolders = useMemo(() => {
    if (sort.column !== 'name') return folders;
    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...folders].sort((a, b) => a.name.localeCompare(b.name) * dir);
  }, [folders, sort]);

  const sortedFiles = useMemo(() => {
    const dir = sort.direction === 'asc' ? 1 : -1;
    const pick = {
      name: f => f.name || '',
      size: f => f.size ?? -1,
      modified: f => (f.last_modified ? Date.parse(f.last_modified) : 0),
      storage: f => f.storage_class || 'STANDARD',
    }[sort.column] || (f => f.name || '');
    return [...files].sort((a, b) => {
      const left = pick(a);
      const right = pick(b);
      if (typeof left === 'string') return left.localeCompare(right) * dir;
      return (left - right) * dir;
    });
  }, [files, sort]);

  const visibleBuckets = useMemo(() => {
    const needle = bucketFilter.trim().toLowerCase();
    if (!needle) return buckets;
    // The account name is worth matching too - "prod" should find the prod
    // account's buckets whatever they happen to be called.
    return buckets.filter(b =>
      b.name.toLowerCase().includes(needle) || (b.account || '').toLowerCase().includes(needle));
  }, [buckets, bucketFilter]);

  // With more than one credential set the sidebar is grouped by account, the
  // way a file browser groups drives - otherwise two same-named buckets sit
  // next to each other with nothing to tell them apart.
  const bucketGroups = useMemo(() => {
    const groups = new Map();
    visibleBuckets.forEach(b => {
      const key = b.account || '';
      if (!groups.has(key)) groups.set(key, { account: key, buckets: [], readOnly: true });
      const group = groups.get(key);
      group.buckets.push(b);
      if (b.allow_writes) group.readOnly = false;
    });
    return Array.from(groups.values());
  }, [visibleBuckets]);

  // What is on screen, for the strip under the table. S3 pages, so this is
  // "what has been loaded", not "what is in the folder".
  const loadedSize = useMemo(() => files.reduce((sum, f) => sum + (f.size || 0), 0), [files]);

  const sortBy = (column) => setSort(prev => ({
    column,
    direction: prev.column === column && prev.direction === 'asc' ? 'desc' : 'asc',
  }));
  const allSelected = files.length > 0 && selected.size === files.length;
  const busy = listing || loadingMore || detailLoading || deleting || resolvingPath || !!uploading;
  const firstLoad = listing && folders.length === 0 && files.length === 0;

  if (phase === 'unconfigured' || phase === 'error') {
    return (
      <div className="h-full flex items-center justify-center p-10">
        <div className="max-w-md text-center">
          <Icon src={s3Icon} className="w-6 h-6 mx-auto mb-2" tint={null} />
          <div className="text-[13px] text-[#5c6670]">
            {phase === 'unconfigured' ? (
              <>
                The S3 Explorer isn&apos;t configured yet. Add an{' '}
                <code className="text-[11.5px] bg-[#f5f7f9] px-1 py-0.5 rounded">s3_explorer</code>{' '}
                section to the backend config to switch it on.
              </>
            ) : 'Could not reach the S3 Explorer API.'}
          </div>
          {fatal && <div className="mt-2 text-[11.5px] text-[#8a949e]">{fatal}</div>}
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative h-full flex min-h-0 bg-white text-[#1a1d21]">
      {/* one place to look for "something is in flight" */}
      {busy && <div className="absolute top-0 left-0 right-0 h-[2px] bg-[#29b5e8] animate-pulse z-30" />}

      {/* ------------------------------ buckets ------------------------------ */}
      <div className="w-[210px] flex-shrink-0 border-r border-[#dfe3e8] bg-[#fbfcfd] flex flex-col min-h-0">
        <div className="flex-shrink-0 flex items-center gap-2 h-[36px] px-3 border-b border-[#dfe3e8]">
          <Icon src={s3Icon} className="w-3.5 h-3.5" tint={null} />
          <span className="text-[12px] font-medium">Buckets</span>
          <span className="ml-auto text-[10.5px] text-[#8a949e]">
            {phase === 'booting' ? '…' : buckets.length}
          </span>
        </div>
        {buckets.length > 8 && (
          <div className="flex-shrink-0 px-2 py-1.5 border-b border-[#eceff2]">
            <input
              value={bucketFilter}
              onChange={e => setBucketFilter(e.target.value)}
              placeholder="Filter buckets"
              className="w-full h-[24px] px-2 rounded border border-[#dfe3e8] text-[11.5px]"
            />
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {phase === 'booting' && <BucketSkeleton />}
          {phase === 'ready' && buckets.length === 0 && (
            <div className="px-3 py-2 text-[11.5px] text-[#8a949e]">No buckets visible to this account.</div>
          )}
          {phase === 'ready' && buckets.length > 0 && visibleBuckets.length === 0 && (
            <div className="px-3 py-2 text-[11.5px] text-[#8a949e]">No bucket matches that.</div>
          )}
          {bucketGroups.map(group => (
            <div key={group.account || 'default'}>
              {multiAccount && (
                <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-[#8a949e]">
                  <span className="truncate" title={`Account ${group.account}`}>{group.account}</span>
                  {group.readOnly && <span className="text-[#b8730d] normal-case tracking-normal">read-only</span>}
                </div>
              )}
              {group.buckets.map(b => {
                const current = b.name === bucket && (b.account || '') === (activeBucket?.account || '');
                return (
                  <button
                    key={`${b.account || ''}/${b.name}`}
                    onClick={() => goToBucket(b.name, b.account)}
                    className={`w-full text-left px-3 py-1.5 text-[12px] truncate ${
                      current ? 'bg-[#e3f2fa] text-[#11567f] font-medium' : 'hover:bg-[#f5f7f9]'
                    }`}
                    title={b.account ? `${b.name} (${b.account})` : b.name}
                  >
                    {b.name}
                  </button>
                );
              })}
            </div>
          ))}
          {bucketErrors.map(e => (
            <div key={e.account} className="px-3 py-1.5 text-[11px] text-[#c02b2b]" title={e.message}>
              {e.account}: {e.message}
            </div>
          ))}
        </div>
        {(activeBucket || info?.region) && (
          <div className="flex-shrink-0 px-3 py-2 border-t border-[#dfe3e8] text-[10.5px] text-[#8a949e] truncate">
            {activeBucket?.region || info?.region}
            {multiAccount && activeBucket?.account ? ` · ${activeBucket.account}` : ''}
            {canWrite ? '' : ' · read-only'}
          </div>
        )}
      </div>

      {/* ------------------------------ listing ------------------------------ */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">

        {/* address bar + actions */}
        <div className="flex-shrink-0 flex items-center gap-2 h-[40px] px-3 border-b border-[#dfe3e8]">
          {editingPath ? (
            <input
              ref={pathRef}
              value={pathDraft}
              onChange={e => setPathDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitPath();
                if (e.key === 'Escape') setEditingPath(false);
              }}
              onBlur={() => setEditingPath(false)}
              spellCheck={false}
              placeholder="s3://bucket/prefix/ — or paste a key, a console link, or /from-the-root"
              className="flex-1 min-w-0 h-[28px] px-2.5 rounded border border-[#11567f] font-mono text-[12px] outline-none"
            />
          ) : (
            /* The fade on the left edge is the tell that the trail is scrolled
               and there are folders above the ones on screen. */
            <div
              ref={crumbsRef}
              className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto overflow-y-hidden cursor-text"
              style={{
                scrollbarWidth: 'none',
                msOverflowStyle: 'none',
                ...(trailClipped ? {
                  maskImage: 'linear-gradient(to right, transparent 0, #000 24px)',
                  WebkitMaskImage: 'linear-gradient(to right, transparent 0, #000 24px)',
                } : {}),
              }}
              onScroll={e => setTrailClipped(e.currentTarget.scrollLeft > 0)}
              onDoubleClick={startPathEdit}
              title="Double-click (or Ctrl+L) to type or paste a path"
            >
              {/* Which keys this path is being read with, when there is more
                  than one set to choose from. */}
              {multiAccount && activeBucket?.account && (
                <span
                  className="flex-shrink-0 whitespace-nowrap text-[10.5px] px-1.5 py-0.5 rounded bg-[#eef2f5] text-[#5c6670]"
                  title={`Read with the ${activeBucket.account} credentials`}
                >
                  {activeBucket.account}
                </span>
              )}
              <button
                onClick={() => goToPrefix('')}
                onDoubleClick={e => { e.stopPropagation(); startPathEdit(); }}
                title={activeBucket?.account ? `${bucket} (${activeBucket.account})` : (bucket || '')}
                className={`flex-shrink-0 whitespace-nowrap text-[12px] px-1.5 py-0.5 rounded hover:bg-[#f5f7f9] ${prefix ? 'text-[#11567f]' : 'font-medium'}`}
              >
                {bucket || (phase === 'booting' ? 'Loading…' : '—')}
              </button>
              {crumbs.map((crumb, i) => (
                <React.Fragment key={crumb.prefix}>
                  <Icon src={chevronRightIcon} className="w-2 h-2 flex-shrink-0" tint="gray" />
                  <button
                    onClick={() => goToPrefix(crumb.prefix)}
                    onDoubleClick={e => { e.stopPropagation(); startPathEdit(); }}
                    title={crumb.label}
                    className={`flex-shrink-0 text-[12px] px-1.5 py-0.5 rounded hover:bg-[#f5f7f9] whitespace-nowrap ${
                      i === crumbs.length - 1 ? 'font-medium' : 'text-[#11567f]'
                    }`}
                  >
                    {crumb.label}
                  </button>
                </React.Fragment>
              ))}
              {resolvingPath && <Spinner className="w-3 h-3 ml-1 flex-shrink-0" />}
              {/* the blank stretch after the crumbs opens the editor, like Explorer does */}
              <span className="flex-1 flex-shrink-0 min-w-[40px] self-stretch" onClick={startPathEdit} />
            </div>
          )}

          <div className="flex-shrink-0 flex items-center gap-2">
            <button
              onClick={() => navigate({ view: 'search' })}
              disabled={phase !== 'ready' || !bucket}
              title="Search every key under this prefix"
              className={`flex items-center gap-1.5 h-[28px] px-3 rounded border text-[12px] disabled:opacity-50 ${
                searching ? 'border-[#11567f] text-[#11567f] bg-[#e3f2fa]' : 'border-[#dfe3e8] hover:bg-[#f5f7f9]'
              }`}
            >
              <Icon src={searchIcon} className="w-3 h-3" tint="gray" />
              Search
            </button>
            <button
              onClick={reload}
              disabled={phase !== 'ready' || listing}
              title="Reload this prefix"
              className="p-1.5 rounded hover:bg-[#f5f7f9] disabled:opacity-40"
            >
              <Icon src={refreshIcon} className={`w-3.5 h-3.5 ${listing ? 'animate-spin' : ''}`} tint="gray" />
            </button>
            {canWrite && (
              <>
                <input ref={uploadRef} type="file" multiple className="hidden" onChange={e => pickUpload(e.target.files)} />
                <button
                  onClick={() => uploadRef.current?.click()}
                  disabled={!!uploading || !bucket}
                  className="flex items-center gap-1.5 h-[28px] px-3 rounded border border-[#dfe3e8] text-[12px] hover:bg-[#f5f7f9] disabled:opacity-50"
                >
                  {uploading
                    ? <Spinner className="w-2.5 h-2.5" />
                    : <Icon src={addIcon} className="w-2.5 h-2.5" tint="gray" />}
                  {uploading ? `Uploading ${uploading.done + 1} of ${uploading.total}…` : 'Upload'}
                </button>
              </>
            )}
          </div>
        </div>

        {/* banners */}
        {error && (
          <div className="flex-shrink-0 flex items-start gap-2 px-3 py-2 bg-[#fcf1f1] border-b border-[#f0d2d2] text-[12px] text-[#c02b2b]">
            <Icon src={alertIcon} className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span className="flex-1 min-w-0">{error}</span>
            <button onClick={() => setError(null)} className="p-0.5 rounded hover:bg-[#f7e3e3]">
              <Icon src={closeIcon} className="w-2.5 h-2.5" tint="gray" />
            </button>
          </div>
        )}
        {notice && (
          <div className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 bg-[#e9f6ee] border-b border-[#cde9d8] text-[12px] text-[#1f8f4e]">
            <span className="flex-1 min-w-0">{notice}</span>
            <button onClick={() => setNotice(null)} className="p-0.5 rounded hover:bg-[#d9efe2]">
              <Icon src={closeIcon} className="w-2.5 h-2.5" tint="gray" />
            </button>
          </div>
        )}
        {uploading && (
          <div className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 bg-[#e3f2fa] border-b border-[#cfe4f0] text-[12px] text-[#11567f]">
            <Spinner className="w-3 h-3" />
            Uploading {uploading.name} ({uploading.done + 1} of {uploading.total})…
          </div>
        )}

        {/* selection bar */}
        {selected.size > 0 && (
          <div className="flex-shrink-0 flex items-center gap-3 px-3 py-1.5 bg-[#e3f2fa] border-b border-[#cfe4f0] text-[12px]">
            <span>{selected.size} selected</span>
            <button onClick={() => setSelected(new Set())} className="text-[#11567f] hover:underline">Clear</button>
            {canWrite && (
              <button
                onClick={() => setConfirmDelete({ keys: [...selected] })}
                className="ml-auto flex items-center gap-1.5 text-[#c02b2b] hover:underline"
              >
                <Icon src={deleteIcon} className="w-3 h-3" tint="gray" />
                Delete selected
              </button>
            )}
          </div>
        )}

        {searching ? (
          <SearchView
            bucket={bucket}
            account={account}
            prefix={prefix}
            initialQuery={search}
            caps={{ scanCap: info?.search_scan_cap, maxMatches: info?.search_max_limit }}
            onQueryRun={(query) => navigate({ q: query }, { replace: true })}
            onOpenFile={(file) => navigate({ prefix: parentOf(file.key), key: file.key, view: null })}
            onClose={() => navigate({ view: null })}
          />
        ) : (
        <>
        {/* table */}
        <div className="flex-1 min-h-0 overflow-auto">
          <table className="min-w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-[#f5f7f9]">
              <tr className="text-[11px] text-[#5c6670]">
                <th className="w-[32px] px-2 py-1.5 border-b border-[#dfe3e8]">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={files.length === 0}
                    aria-label="Select every file on this page"
                  />
                </th>
                <SortHeader id="name" sort={sort} onSort={sortBy} className="text-left px-2">Name</SortHeader>
                <SortHeader id="size" sort={sort} onSort={sortBy} className="text-right px-3 w-[110px]" align="justify-end">Size</SortHeader>
                <SortHeader id="modified" sort={sort} onSort={sortBy} className="text-left px-3 w-[130px]">Modified</SortHeader>
                <SortHeader id="storage" sort={sort} onSort={sortBy} className="text-left px-3 w-[120px]">Storage</SortHeader>
                <th className="w-[90px] px-3 py-1.5 border-b border-[#dfe3e8]" />
              </tr>
            </thead>

            {phase === 'booting' || firstLoad ? <RowSkeleton /> : (
              <tbody>
                {prefix && (
                  <tr className="cursor-pointer hover:bg-[#fbfcfd]" onClick={() => goToPrefix(parentOf(prefix))}>
                    <td className="px-2 py-1.5 border-b border-[#eceff2]" />
                    <td className="px-2 py-1.5 border-b border-[#eceff2] text-[12.5px] text-[#5c6670]" colSpan={5}>..</td>
                  </tr>
                )}

                {sortedFolders.map(folder => (
                  <tr
                    key={folder.prefix}
                    tabIndex={0}
                    onClick={() => goToPrefix(folder.prefix)}
                    onKeyDown={e => { if (e.key === 'Enter') goToPrefix(folder.prefix); }}
                    className="cursor-pointer hover:bg-[#fbfcfd] focus:bg-[#e3f2fa] focus:outline-none"
                  >
                    <td className="px-2 py-1.5 border-b border-[#eceff2]" />
                    <td className="px-2 py-1.5 border-b border-[#eceff2]">
                      <div className="flex items-center">
                        <FolderMark />
                        <span className="text-[12.5px] truncate">{folder.name}/</span>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 border-b border-[#eceff2] text-right text-[11.5px] text-[#8a949e]">—</td>
                    <td className="px-3 py-1.5 border-b border-[#eceff2] text-[11.5px] text-[#8a949e]">—</td>
                    <td className="px-3 py-1.5 border-b border-[#eceff2] text-[11.5px] text-[#8a949e]">folder</td>
                    <td className="px-3 py-1.5 border-b border-[#eceff2]" />
                  </tr>
                ))}

                {sortedFiles.map(file => {
                  const isOpen = openKey === file.key;
                  return (
                    <tr
                      key={file.key}
                      tabIndex={0}
                      onClick={() => navigate({ key: file.key })}
                      onKeyDown={e => { if (e.key === 'Enter') navigate({ key: file.key }); }}
                      className={`group cursor-pointer focus:outline-none focus:bg-[#e3f2fa] ${isOpen ? 'bg-[#e3f2fa]' : 'hover:bg-[#fbfcfd]'}`}
                    >
                      <td className="px-2 py-1.5 border-b border-[#eceff2]" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(file.key)}
                          onChange={() => toggleOne(file.key)}
                          aria-label={`Select ${file.name}`}
                        />
                      </td>
                      <td className="px-2 py-1.5 border-b border-[#eceff2]">
                        <div className="flex items-center min-w-0">
                          <FileMark ext={file.extension} />
                          <span className="text-[12.5px] truncate" title={file.key}>{file.name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-1.5 border-b border-[#eceff2] text-right text-[11.5px] tabular-nums">
                        {formatBytes(file.size) || '—'}
                      </td>
                      <td className="px-3 py-1.5 border-b border-[#eceff2] text-[11.5px] text-[#5c6670]">
                        {formatWhen(file.last_modified) || '—'}
                      </td>
                      <td className="px-3 py-1.5 border-b border-[#eceff2] text-[11.5px] text-[#8a949e]">
                        {file.storage_class || 'STANDARD'}
                      </td>
                      <td className="px-3 py-1.5 border-b border-[#eceff2]" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100">
                          <button onClick={() => download(file.key)} title="Download" className="p-1 rounded hover:bg-[#eceff2]">
                            <Icon src={downloadIcon} className="w-3 h-3" tint="gray" />
                          </button>
                          {canWrite && (
                            <button
                              onClick={() => setConfirmDelete({ keys: [file.key] })}
                              title="Delete"
                              className="p-1 rounded hover:bg-[#fcf1f1]"
                            >
                              <Icon src={deleteIcon} className="w-3 h-3" tint="gray" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {!listing && !error && folders.length === 0 && files.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-[12px] text-[#8a949e]">
                      Nothing here.
                    </td>
                  </tr>
                )}
              </tbody>
            )}
          </table>

          {nextToken && (
            <div className="px-3 py-2.5">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="flex items-center gap-2 h-[28px] px-3 rounded border border-[#dfe3e8] text-[12px] hover:bg-[#f5f7f9] disabled:opacity-60"
              >
                {loadingMore && <Spinner className="w-2.5 h-2.5" />}
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>

        {/* what is actually loaded, so the numbers are never a guess */}
        {!listing && (folders.length > 0 || files.length > 0) && (
          <div className="flex-shrink-0 flex items-center gap-3 px-3 py-1.5 border-t border-[#dfe3e8] bg-[#fbfcfd] text-[11px] text-[#5c6670] tabular-nums">
            <span>{folders.length.toLocaleString()} folder{folders.length === 1 ? '' : 's'}</span>
            <span>{files.length.toLocaleString()} file{files.length === 1 ? '' : 's'}</span>
            <span>{formatBytes(loadedSize) || '0 B'}</span>
            {nextToken && <span className="text-[#b8730d]">· more to load</span>}
            {selected.size > 0 && <span className="ml-auto text-[#11567f]">{selected.size} selected</span>}
          </div>
        )}
        </>
        )}
      </div>

      {/* ------------------------------- detail ------------------------------ */}
      {detail && (
        <div className={`${richPreview ? 'w-[560px]' : 'w-[380px]'} flex-shrink-0 border-l border-[#dfe3e8] bg-white flex flex-col min-h-0`}>
          <div className="flex-shrink-0 flex items-center gap-2 h-[36px] px-3 border-b border-[#dfe3e8]">
            <span className="flex-1 min-w-0 truncate text-[12.5px] font-medium" title={detail.meta?.key}>
              {detail.meta?.name || detail.meta?.key}
            </span>
            {detailLoading && <Spinner className="w-3 h-3 flex-shrink-0" />}
            <button onClick={() => navigate({ key: null })} className="p-1 rounded hover:bg-[#f5f7f9]">
              <Icon src={closeIcon} className="w-2.5 h-2.5" tint="gray" />
            </button>
          </div>

          <div className="flex-shrink-0 px-3 py-2.5 border-b border-[#dfe3e8] space-y-1 text-[11.5px]">
            {[
              ['Size', formatBytes(detail.meta?.size)],
              ['Type', detail.meta?.content_type],
              ['Modified', detail.meta?.last_modified ? new Date(detail.meta.last_modified).toLocaleString() : null],
              ['Storage', detail.meta?.storage_class],
              ['ETag', detail.meta?.etag],
            ].map(([label, value]) => (
              <div key={label} className="flex gap-2 items-center">
                <span className="w-[70px] flex-shrink-0 text-[#8a949e]">{label}</span>
                {value == null && detailLoading
                  ? <SkeletonLine w="120px" h={9} />
                  : <span className="flex-1 min-w-0 truncate" title={String(value ?? '—')}>{value ?? '—'}</span>}
              </div>
            ))}
            <div className="flex gap-2 pt-1">
              <span className="w-[70px] flex-shrink-0 text-[#8a949e]">URI</span>
              <button
                onClick={() => copyUri(detail.meta.key)}
                className="flex-1 min-w-0 truncate text-left font-mono text-[11px] text-[#11567f] hover:underline"
                title="Copy the s3:// URI"
              >
                s3://{bucket}/{detail.meta?.key}
              </button>
            </div>
          </div>

          <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[#dfe3e8]">
            <button
              onClick={() => download(detail.meta.key)}
              className="flex items-center gap-1.5 h-[28px] px-3 rounded bg-[#11567f] text-white text-[12px] hover:bg-[#0d4363]"
            >
              <Icon src={downloadIcon} className="w-3 h-3" tint="white" />
              Download
            </button>
            {canPresign && (
              <button
                onClick={() => copyLink(detail.meta.key)}
                className="flex items-center gap-1.5 h-[28px] px-3 rounded border border-[#dfe3e8] text-[12px] hover:bg-[#f5f7f9]"
                title="Copy a short-lived direct link"
              >
                <Icon src={linkIcon} className="w-3 h-3" tint="gray" />
                Link
              </button>
            )}
            {canWrite && (
              <button
                onClick={() => setConfirmDelete({ keys: [detail.meta.key] })}
                className="ml-auto flex items-center gap-1.5 h-[28px] px-3 rounded border border-[#dfe3e8] text-[12px] text-[#c02b2b] hover:bg-[#fcf1f1]"
              >
                <Icon src={deleteIcon} className="w-3 h-3" tint="gray" />
                Delete
              </button>
            )}
          </div>

          <div className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 bg-[#fbfcfd] border-b border-[#eceff2] text-[11px] text-[#8a949e]">
            Preview
            {detailLoading && <span>· reading the first slice…</span>}
            {!detailLoading && detail.preview?.truncated && <span className="text-[#b8730d]">· first slice only</span>}
            {richPreview && (
              <button
                onClick={() => setExpanded(true)}
                className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[#eef2f5] text-[#11567f]"
                title="Open the preview full screen"
              >
                <Icon src={expandIcon} className="w-2.5 h-2.5" tint="gray" />
                Expand
              </button>
            )}
          </div>

          <div className={`flex-1 min-h-0 ${SELF_SCROLLING_MODES.includes(detail.preview?.mode) ? 'overflow-hidden' : 'overflow-auto'}`}>
            <PreviewBody
              key={`${detail.meta?.key}-pane`}
              preview={detail.preview}
              loading={detailLoading}
              name={detail.meta?.name}
            />
          </div>
        </div>
      )}

      {/* --------------------------- full screen ----------------------------- */}
      {expanded && detail && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/50 p-6"
          onClick={() => setExpanded(false)}
        >
          <div
            className="flex-1 min-h-0 flex flex-col bg-white rounded-lg shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex-shrink-0 flex items-center gap-2 h-[38px] px-4 border-b border-[#dfe3e8]">
              <span className="flex-1 min-w-0 truncate text-[13px] font-medium" title={detail.meta?.key}>
                {detail.meta?.name || detail.meta?.key}
              </span>
              <button
                onClick={() => download(detail.meta.key)}
                className="flex items-center gap-1.5 h-[26px] px-2.5 rounded border border-[#dfe3e8] text-[12px] hover:bg-[#f5f7f9]"
              >
                <Icon src={downloadIcon} className="w-3 h-3" tint="gray" />
                Download
              </button>
              <button onClick={() => setExpanded(false)} className="p-1 rounded hover:bg-[#f5f7f9]" title="Close (Esc)">
                <Icon src={closeIcon} className="w-2.5 h-2.5" tint="gray" />
              </button>
            </div>
            <div className={`flex-1 min-h-0 ${SELF_SCROLLING_MODES.includes(detail.preview?.mode) ? 'overflow-hidden' : 'overflow-auto'}`}>
              <PreviewBody
                key={`${detail.meta?.key}-full`}
                preview={detail.preview}
                loading={detailLoading}
                name={detail.meta?.name}
              />
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------- overwrite? ----------------------------- */}
      {pendingUpload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
            <div className="px-5 py-4 border-b border-[#dfe3e8]">
              <h3 className="font-johnson-display font-bold text-[15px]">
                Replace {pendingUpload.clashes.length} existing file{pendingUpload.clashes.length === 1 ? '' : 's'}?
              </h3>
              <p className="mt-1 text-[12px] text-[#5c6670]">
                These names already exist in <span className="font-mono">s3://{bucket}/{prefix}</span>. Uploading
                overwrites them, and unless the bucket has versioning on, the old contents are gone.
              </p>
            </div>
            <div className="max-h-[180px] overflow-auto px-5 py-3 space-y-1">
              {pendingUpload.clashes.map(name => (
                <div key={name} className="text-[11.5px] font-mono text-[#1a1d21] truncate" title={name}>{name}</div>
              ))}
            </div>
            <div className="px-5 py-4 border-t border-[#dfe3e8] flex items-center justify-end gap-2.5">
              <button
                onClick={() => { setPendingUpload(null); if (uploadRef.current) uploadRef.current.value = ''; }}
                className="px-4 py-2 rounded border border-[#dfe3e8] text-[12.5px] hover:bg-[#f5f7f9]"
              >
                Cancel
              </button>
              <button
                onClick={() => upload(pendingUpload.files)}
                className="px-4 py-2 rounded bg-[#11567f] text-white text-[12.5px] font-medium hover:bg-[#0d4363]"
              >
                Replace and upload
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------- confirm ----------------------------- */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
            <div className="px-5 py-4 border-b border-[#dfe3e8]">
              <h3 className="font-johnson-display font-bold text-[15px]">
                Delete {confirmDelete.keys.length} object{confirmDelete.keys.length === 1 ? '' : 's'}?
              </h3>
              <p className="mt-1 text-[12px] text-[#5c6670]">
                This removes them from <span className="font-mono">s3://{bucket}/</span>. Unless the bucket has
                versioning turned on, they are not recoverable.
              </p>
            </div>
            <div className="max-h-[200px] overflow-auto px-5 py-3 space-y-1">
              {confirmDelete.keys.slice(0, 50).map(key => (
                <div key={key} className="text-[11.5px] font-mono text-[#1a1d21] truncate" title={key}>{key}</div>
              ))}
              {confirmDelete.keys.length > 50 && (
                <div className="text-[11.5px] text-[#8a949e]">…and {confirmDelete.keys.length - 50} more</div>
              )}
            </div>
            <div className="px-5 py-4 border-t border-[#dfe3e8] flex items-center justify-end gap-2.5">
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
                className="px-4 py-2 rounded border border-[#dfe3e8] text-[12.5px] hover:bg-[#f5f7f9] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={runDelete}
                disabled={deleting}
                className="flex items-center gap-2 px-4 py-2 rounded bg-[#9e0000] text-white text-[12.5px] font-medium hover:opacity-90 disabled:opacity-50"
              >
                {deleting && <Spinner className="w-3 h-3" />}
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}