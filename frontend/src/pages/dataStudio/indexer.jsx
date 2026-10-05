import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { apiJson } from '../../utils/apiClient';
import { useRBAC } from '../../context/RBACContext';
import './indexer.css';

/* Index Health — pick any Postgres table, say how its columns are queried, see
   which indexes are missing and build them with a live log. Builds run on the
   server, so several can be in flight (one per table) while you keep working.
   Backend lives in backend/indexer.py. */

const ENVS = ['dev', 'qa', 'prod'];
const JOBS_KEY = 'indexHealth.jobs';
const SEP = '\u0001'; // tree path separator; Postgres names can contain '/'

// FastAPI 422s send detail as a list of {msg}; everything else is a string
const msg = (e) => {
  const d = e?.detail;
  if (Array.isArray(d)) return d.map((x) => x?.msg || JSON.stringify(x)).join('; ');
  if (typeof d === 'string') return d;
  return e?.message || String(e);
};
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => (n ?? 0).toLocaleString();
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const keyOf = (t) => [t.env, t.database || '', t.schema, t.table].join(SEP);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ago = (iso) => {
  if (!iso) return 'Never analyzed';
  const h = Math.round((Date.now() - new Date(iso)) / 36e5);
  if (h < 1) return 'Analyzed just now';
  return h < 48 ? `Analyzed ${h}h ago` : `Analyzed ${Math.round(h / 24)} days ago`;
};

// jobs survive a reload (the build keeps running server-side); the log is refetched
const readJobs = () => {
  try { return (JSON.parse(sessionStorage.getItem(JOBS_KEY) || '[]') || []).map((j) => ({ ...j, log: [], next: 0, loaded: false })); } catch { return []; }
};
const writeJobs = (jobs) => {
  const slim = jobs.map((j) => ({ ...j, log: undefined, next: undefined, loaded: undefined })); // JSON drops undefined
  try { sessionStorage.setItem(JOBS_KEY, JSON.stringify(slim)); } catch { /* private mode */ }
};

/* ─────────────────────────────── icons ─────────────────────────────── */

const ICON = {
  search: 'Search_RGB', db: 'Database_RGB', filter: 'Filter', chev: 'Chevron_Right', check: 'Check_RGB', close: 'Close',
  alert: 'Alert_RGB', info: 'Info_RGB', trash: 'Delete_RGB', refresh: 'Refresh_RGB', shield: 'Shield_RGB', time: 'Time_RGB',
  chart: 'Graph_Chart_RGB', ai: 'AI_RGB', lock: 'Lock_black', add: 'Add', play: 'Video_Play_RGB', copy: 'Stationery_RGB',
  table: 'Dashboard_RGB', schema: 'Network_RGB', records: 'Records_Information_RGB', edit: 'Edit_RGB', analysis: 'Analysis_RGB',
};
const Ico = ({ n, c = '' }) => (
  <span aria-hidden="true" className={`ih-i ${c}`} style={{ '--i': `url("/icons/JJ_Icon_${ICON[n]}.svg")` }} />
);

/* ─────────────────────────────── scoring ─────────────────────────────── */

// ponytail: client-side score, same weights as the design mock; move to indexer.py if anything else needs it
const scoreOf = (s) => Math.max(6, Math.min(100, 100 - s.critical * 20 - s.high * 9 - s.redundant * 4 - s.unused * 3));
const scoreLabel = (n) => (n >= 90 ? 'Excellent' : n >= 75 ? 'Good' : n >= 55 ? 'Needs work' : 'Critical');
const gain = (m) => (m.priority === 'critical' ? 20 : m.priority === 'high' ? 9 : 0);

const FEAT = {
  key: ['lock', 'Add a primary key'], stats: ['chart', 'Refresh planner statistics'], vector: ['ai', 'Index vector search'],
  substring: ['search', 'Index substring search'], words: ['search', 'Index full-text search'], filter: ['filter', 'Index lookups & sorting'],
  drop: ['trash', 'Drop invalid index'], extension: ['add', 'Install extension'],
};
const featLabel = (f) => FEAT[f]?.[1] || f;

const USES = [
  { key: 'filter', label: 'Lookup & sort', hint: '= IN < > ORDER BY', icon: 'filter', chip: 'Lookup', show: (c) => c.lookup },
  { key: 'search', label: 'Text search', hint: 'ILIKE, full-text', icon: 'search', chip: 'Search', show: (c) => c.text },
  { key: 'vector', label: 'Vector search', hint: '<=> similarity', icon: 'ai', chip: 'Similarity', show: (c) => c.vector },
];
const USE_ICON = { filter: 'filter', search: 'search', vector: 'ai' };
const CAPS = [['exact', 'Exact'], ['sort', 'Sort'], ['starts_with', 'Prefix'], ['substring', 'Substring'], ['words', 'Words'], ['vector', 'Vector']];
const NEEDS = { filter: ['exact', 'sort'], search: ['substring', 'words'], vector: ['vector'] };
const DIAG = ['Reading the catalog and index stats', 'Mapping coverage for every column', 'Matching your query patterns', 'Ranking fixes by impact'];

const usageLists = (usage) => {
  const pick = (k) => Object.keys(usage).filter((c) => (usage[c] || []).includes(k));
  return { search: pick('search'), filter: pick('filter'), vector: pick('vector') };
};

const fetchCheck = (t, lists) => apiJson(`/index-health?${new URLSearchParams({
  env: t.env, database: t.database || '', schema: t.schema, table: t.table,
  // always send all three; empty means "nothing uses it that way"
  search: lists.search.join(','), filter: lists.filter.join(','), vector: lists.vector.join(','),
})}`);

/* ─────────────────────────────── sql ─────────────────────────────── */

const KW = /\b(CREATE|UNIQUE|INDEX|CONCURRENTLY|ON|USING|DROP|IF|EXISTS|ALTER|TABLE|ADD|CONSTRAINT|PRIMARY|KEY|ANALYZE|EXTENSION|NOT|NULL|CHECK|VALID|VALIDATE|COLUMN|SET)\b/g;
const highlight = (sql) => esc(sql)
  .replace(/(--.*)$/gm, '<span class="cm">$1</span>')
  .replace(KW, '<span class="kw">$1</span>')
  .replace(/(&lt;id_column&gt;)/g, '<span class="hole">$1</span>');

function SqlBlock({ sql }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(sql); } catch { /* blocked in some iframes */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1300);
  };
  return (
    <div className="ih-sql">
      {/* escaped first, then only our own spans are added */}
      <pre dangerouslySetInnerHTML={{ __html: highlight(sql) }} />
      <button className="ih-cp" onClick={copy} data-tip="Copy SQL" aria-label="Copy SQL"><Ico n={copied ? 'check' : 'copy'} /></button>
    </div>
  );
}

/* ─────────────────────────────── job helpers ─────────────────────────────── */

// The server logs "[n/N] feature column" before each item; that's enough to draw the step list.
function jobSteps(job) {
  let cur = -1;
  const bad = new Set();
  job.log.forEach((l) => {
    const m = /^\[(\d+)\/\d+\]/.exec(l.msg);
    if (m) cur = +m[1] - 1;
    else if (l.level === 'error' && cur >= 0 && !l.msg.startsWith('finished')) bad.add(cur);
  });
  const fin = !!job.finished;
  return job.items.map((it, i) => {
    let st = '';
    if (i < cur) st = bad.has(i) ? 'cut' : 'ok';
    else if (i === cur) st = !fin ? 'now' : bad.has(i) || job.status === 'cancelled' ? 'cut' : 'ok';
    else if (fin && job.status !== 'done') st = 'cut';
    else if (fin) st = 'ok';
    const note = st === 'now' ? 'running…' : st === 'cut' ? (bad.has(i) ? 'failed' : 'skipped') : st === 'ok' ? 'done' : '';
    return { ...it, st, note };
  });
}
const jobDone = (job) => jobSteps(job).filter((s) => s.st === 'ok').length;
const secs = (job) => Math.max(0, Math.round(((job.endedAt || Date.now()) - job.t0) / 1000));

/* ─────────────────────────────── tree ─────────────────────────────── */

function Tree({ env, nodes, open, toggle, filter, selected, flags, onSelect, error, retry }) {
  const f = filter.trim().toLowerCase();
  const dbs = nodes[''];
  const skel = (n) => Array.from({ length: n }, (_, i) => <div key={i} className="ih-skel" />);

  return (
    <nav className="ih-tree" aria-label={`Databases in ${env}`}>
      {error && <div className="ih-tree-err">{error}{!Array.isArray(dbs) && <button onClick={retry}>Retry</button>}</div>}
      {dbs === 'loading' && skel(3)}
      {Array.isArray(dbs) && dbs.map((db) => (
        <React.Fragment key={db}>
          <button className={`ih-node ${open[db] ? 'open' : ''}`} onClick={() => toggle(db)} aria-expanded={!!open[db]} title={db}>
            <Ico n="chev" c="ih-chev" /><Ico n="db" c="ih-ico" /><span className="ih-lbl">{db}</span>
            {Array.isArray(nodes[db]) && <span className="ih-n">{nodes[db].length}</span>}
          </button>
          {open[db] && (
            <div className="ih-kids">
              {nodes[db] === 'loading' && skel(2)}
              {Array.isArray(nodes[db]) && nodes[db].map((sc) => {
                const sp = `${db}${SEP}${sc}`;
                const tables = Array.isArray(nodes[sp]) ? nodes[sp].filter((t) => !f || t.toLowerCase().includes(f)) : [];
                return (
                  <React.Fragment key={sp}>
                    <button className={`ih-node ${open[sp] ? 'open' : ''}`} onClick={() => toggle(sp)} aria-expanded={!!open[sp]} title={sc}>
                      <Ico n="chev" c="ih-chev" /><Ico n="schema" c="ih-ico" /><span className="ih-lbl">{sc}</span>
                      {Array.isArray(nodes[sp]) && <span className="ih-n">{nodes[sp].length}</span>}
                    </button>
                    {open[sp] && (
                      <div className="ih-kids">
                        {nodes[sp] === 'loading' && skel(3)}
                        {Array.isArray(nodes[sp]) && !tables.length && <div className="ih-none">{f ? 'No match' : 'No tables'}</div>}
                        {tables.map((t) => {
                          const k = keyOf({ env, database: db, schema: sc, table: t });
                          return (
                            <button key={t} className={`ih-node ${selected === k ? 'active' : ''}`} title={t}
                              onClick={() => onSelect({ env, database: db, schema: sc, table: t })}>
                              <span style={{ width: 10 }} /><Ico n="table" c="ih-ico" /><span className="ih-lbl">{t}</span>
                              {flags[k] === 'busy' ? <span className="ih-spin" title="Build running" />
                                : flags[k] === 'hot' ? <span className="ih-flag" data-tip="Needs attention" /> : null}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}

/* ─────────────────────────────── score ring ─────────────────────────────── */

const C = 326.7; // 2πr, r = 52

function Ring({ score }) {
  const from = useRef(0);
  const [shown, setShown] = useState(score == null ? null : from.current);
  const [arc, setArc] = useState(from.current);

  useEffect(() => {
    if (score == null) { setShown(null); return undefined; }
    const start = from.current, t0 = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const p = Math.min(1, (now - t0) / 1300);
      setShown(Math.round(start + (score - start) * (1 - (1 - p) ** 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    });
    const r2 = requestAnimationFrame(() => setArc(score)); // next frame so the stroke transitions
    from.current = score;
    return () => { cancelAnimationFrame(raf); cancelAnimationFrame(r2); };
  }, [score]);

  const stroke = score == null ? undefined : score >= 55 ? 'var(--g8)' : 'var(--red)';
  return (
    <div className={`ih-ring ${score == null ? 'idle' : ''}`}>
      <svg viewBox="0 0 120 120">
        <circle className="ih-track" cx="60" cy="60" r="52" fill="none" strokeWidth="8" />
        <circle className="ih-arc" cx="60" cy="60" r="52" fill="none" strokeWidth="8" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - arc / 100)} style={stroke ? { stroke } : undefined} />
      </svg>
      <div className="ih-mid"><div className="ih-big">{shown ?? '—'}</div><div className="ih-of">{score != null ? 'of 100' : ''}</div></div>
    </div>
  );
}

// remounting on value change replays the bump
const Num = ({ v, hot }) => <b key={v} className={`ih-bump ${hot && v ? 'hot' : ''}`}>{v}</b>;

/* ─────────────────────────────── page ─────────────────────────────── */

function IndexHealth({ active = true }) {
  const { hasPermission } = useRBAC();
  const canBuild = hasPermission('buildPGindexer'); // the server checks too; this just hides buttons that would 403
  const [env, setEnvState] = useState('dev');
  const [nodes, setNodes] = useState({});
  const [open, setOpen] = useState({});
  const [treeFilter, setTreeFilter] = useState('');
  const [treeError, setTreeError] = useState('');

  const [target, setTarget] = useState(null);
  const [info, setInfo] = useState(null);
  const [columns, setColumns] = useState(null);
  const [usage, setUsage] = useState({});
  const [step, setStep] = useState('usage'); // usage | diagnosing | results | build
  const [result, setResult] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [keyCol, setKeyCol] = useState('');
  const [lowerTab, setLowerTab] = useState('fixes');
  const [openIx, setOpenIx] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [jobs, setJobs] = useState(readJobs);
  const [trayOpen, setTrayOpen] = useState(false);
  const [checked, setChecked] = useState({}); // key -> { target, score, why } for tables checked this session
  const [toasts, setToasts] = useState([]);
  const [layer, setLayer] = useState(null); // 'palette' | 'confirm'
  const [diagAt, setDiagAt] = useState(0);
  const [starting, setStarting] = useState(false);

  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const envRef = useRef(env); envRef.current = env;
  const targetRef = useRef(target); targetRef.current = target;
  const jobsRef = useRef(jobs); jobsRef.current = jobs;
  const req = useRef(0); // only the latest table request may write state

  const job = target ? [...jobs].reverse().find((j) => keyOf(j.target) === keyOf(target)) : null;
  const busy = (k) => jobs.some((j) => !j.finished && keyOf(j.target) === k);

  useEffect(() => writeJobs(jobs), [jobs]);

  const toast = useCallback((text, kind = 'ok', action) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, kind, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 6000 : 3600);
  }, []);

  /* ── tree loading ── */

  const load = useCallback(async (path) => {
    const forEnv = envRef.current;
    setNodes((n) => ({ ...n, [path]: 'loading' }));
    setTreeError('');
    const [database, schema] = path ? path.split(SEP) : [];
    try {
      let list;
      if (!path) list = (await apiJson(`/index-health/databases?${qs({ env: forEnv })}`)).databases;
      else if (!schema) list = (await apiJson(`/index-health/schemas?${qs({ env: forEnv, database })}`)).schemas;
      else list = (await apiJson(`/index-health/tables?${qs({ env: forEnv, database, schema })}`)).tables;
      if (envRef.current !== forEnv) return null; // switched env while this was loading
      setNodes((n) => ({ ...n, [path]: list || [] }));
      return list || [];
    } catch (e) {
      if (envRef.current !== forEnv) return null;
      setNodes((n) => ({ ...n, [path]: undefined })); // so re-opening retries
      setTreeError(msg(e));
      return null;
    }
  }, []);

  useEffect(() => {
    setNodes({}); setOpen({}); setTreeError('');
    load('');
  }, [env, load]);

  const toggle = (path) => {
    const next = !open[path];
    setOpen((o) => ({ ...o, [path]: next }));
    if (next && nodesRef.current[path] === undefined) load(path);
  };

  const setEnv = (e) => { if (e !== envRef.current) { envRef.current = e; setEnvState(e); } };

  /* ── table + check ── */

  const remember = useCallback((t, r) => {
    const s = r.summary;
    const why = r.missing.slice(0, 2).map((m) => featLabel(m.feature)).join(' · ')
      || (s.redundant + s.unused ? `${plural(s.redundant + s.unused, 'index', 'indexes')} to tidy` : 'All good');
    setChecked((c) => ({ ...c, [keyOf(t)]: { target: t, score: scoreOf(s), why } }));
  }, []);

  const applyResult = useCallback((t, r) => {
    setResult(r);
    setInfo(r.table);
    // the key is never pre-ticked: adding a primary key is a choice, not a default
    setPicked(new Set(r.missing.filter((m) => m.buildable && m.priority !== 'info' && m.feature !== 'key').map((m) => m.id)));
    setKeyCol(r.missing.find((m) => m.feature === 'key')?.candidates?.[0] || '');
    remember(t, r);
  }, [remember]);

  const loadColumns = useCallback(async (t, keepUsage) => {
    const my = ++req.current;
    setLoading(true); setError('');
    try {
      const r = await apiJson(`/index-health/columns?${qs({ env: t.env, database: t.database, schema: t.schema, table: t.table })}`);
      if (my !== req.current) return false;
      setColumns(r.columns);
      setInfo(r.table);
      if (!keepUsage) setUsage(Object.fromEntries(r.columns.map((c) => [c.name, c.suggested])));
      return true;
    } catch (e) {
      if (my === req.current) { setColumns(null); setError(msg(e)); }
      return false;
    } finally {
      if (my === req.current) setLoading(false);
    }
  }, []);

  const selectTable = useCallback(async (t) => {
    setLayer(null);
    if (t.env !== envRef.current) setEnv(t.env);
    else {
      // open the path in the tree so the row is visible
      const sp = `${t.database}${SEP}${t.schema}`;
      setOpen((o) => ({ ...o, [t.database]: true, [sp]: true }));
      if (nodesRef.current[t.database] === undefined) load(t.database);
      if (nodesRef.current[sp] === undefined) load(sp);
    }
    setTarget(t);
    setResult(null); setColumns(null); setInfo(null); setError('');
    setStep('usage'); setLowerTab('fixes'); setOpenIx(new Set());

    // a table with a build reopens on that build, diagnosed with the usage it was built for
    const j = [...jobsRef.current].reverse().find((x) => keyOf(x.target) === keyOf(t));
    if (!j) { loadColumns(t, false); return; }
    setUsage(j.usage);
    setStep('build');
    if (!(await loadColumns(t, true))) return;
    const my = req.current;
    try {
      const r = await fetchCheck(t, j.checked);
      if (my === req.current) applyResult(t, r);
    } catch (e) { if (my === req.current) setError(msg(e)); }
  }, [load, loadColumns, applyResult]);

  const runDiagnosis = async () => {
    const t = target;
    const my = ++req.current;
    setError(''); setStep('diagnosing'); setDiagAt(0);
    try {
      // the floor keeps the checklist readable on fast tables
      const [r] = await Promise.all([fetchCheck(t, usageLists(usage)), sleep(1500)]);
      if (my !== req.current) return;
      setDiagAt(DIAG.length);
      await sleep(250);
      if (my !== req.current) return;
      applyResult(t, r);
      setLowerTab('fixes');
      setStep('results');
    } catch (e) {
      if (my !== req.current) return;
      setError(msg(e));
      setStep('usage');
    }
  };

  useEffect(() => {
    if (step !== 'diagnosing') return undefined;
    const id = setInterval(() => setDiagAt((n) => Math.min(n + 1, DIAG.length - 1)), 380);
    return () => clearInterval(id);
  }, [step]);

  /* ── build ── */

  const sqlFor = (m) => (m.feature === 'key' && keyCol ? m.sql.replaceAll('<id_column>', `"${keyCol.replaceAll('"', '""')}"`) : m.sql);
  const pickedItems = result ? result.missing.filter((m) => picked.has(m.id)) : [];

  const startBuild = async () => {
    const t = target, r = result;
    setStarting(true); setError('');
    try {
      const res = await apiJson('/index-health/build', {
        method: 'POST',
        body: {
          env: t.env, database: t.database, schema_name: t.schema, table: t.table,
          items: pickedItems.map((m) => m.id), search: r.checked.search, filter: r.checked.filter, vector: r.checked.vector,
          key_column: picked.has('key') ? keyCol : undefined,
        },
      });
      const byId = Object.fromEntries(r.missing.map((m) => [m.id, m]));
      const items = res.items.map((id) => ({ id, feature: byId[id]?.feature, column: id === 'key' ? keyCol : byId[id]?.column }));
      setJobs((js) => [...js, {
        id: res.id, target: t, usage, checked: r.checked, items, status: res.status, log: res.log || [], next: res.next || 0,
        loaded: true, finished: null, t0: Date.now(), before: scoreOf(r.summary),
      }]);
      setLayer(null);
      setStep('build');
      toast('Build started in the background. Keep working, we’ll tell you when it’s done.');
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    } catch (e) {
      setLayer(null);
      setError(msg(e));
    } finally {
      setStarting(false);
    }
  };

  const cancelJob = async (j) => {
    if (!j || j.finished) return;
    if (!window.confirm(`Cancel the build on ${j.target.table}? The index in progress is thrown away and left invalid; the next check offers to drop it.`)) return;
    try {
      await apiJson(`/index-health/jobs/${j.id}/cancel`, { method: 'POST' });
      toast(`Cancelling ${j.target.table} after the current statement`, 'bad');
    } catch (e) { toast(msg(e), 'bad'); }
  };

  // Re-score with the usage the build was started with; refresh in place if the user is looking at it.
  const onJobFinished = useCallback(async (j) => {
    const label = `${j.target.schema}.${j.target.table}`;
    let after = null, r = null;
    try { r = await fetchCheck(j.target, j.checked); after = scoreOf(r.summary); } catch { /* the toast still goes out */ }
    setJobs((js) => js.map((x) => (x.id === j.id ? { ...x, after } : x)));
    if (r) remember(j.target, r);
    const text = j.status === 'done'
      ? `${label}: health ${j.before ?? '—'} → ${after ?? '—'}`
      : `${label}: build ${j.status}`;
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('Index Health', { body: text });
    const here = targetRef.current && keyOf(targetRef.current) === keyOf(j.target);
    if (here && r) applyResult(j.target, r);
    toast(text, j.status === 'done' ? 'ok' : 'bad', here ? null : { label: 'View', run: () => selectTable(j.target) });
  }, [applyResult, remember, selectTable, toast]);

  // one poller for every job; a job that just finished triggers the re-score once
  useEffect(() => {
    let stop = false, timer;
    const tick = async () => {
      const due = jobsRef.current.filter((j) => !j.finished || !j.loaded);
      await Promise.all(due.map(async (j) => {
        try {
          const v = await apiJson(`/index-health/jobs/${j.id}?since=${j.next}`);
          if (stop) return;
          const ended = v.finished && !j.finished;
          const upd = {
            status: v.status, finished: v.finished, loaded: true, next: v.next,
            log: [...j.log, ...v.log], endedAt: j.endedAt || (v.finished ? Date.now() : undefined),
          };
          setJobs((js) => js.map((x) => (x.id === j.id ? { ...x, ...upd } : x)));
          if (ended) onJobFinished({ ...j, ...upd });
        } catch (e) {
          if (stop) return;
          // 404: server restarted or the job aged out; anything else 4xx won't get better by retrying
          if (e?.status === 404 || (e?.status >= 400 && e?.status < 500)) {
            setJobs((js) => js.map((x) => (x.id === j.id ? {
              ...x, loaded: true, finished: x.finished || 'lost', status: x.finished ? x.status : 'lost',
              log: [...x.log, { ts: '', level: 'warn', msg: msg(e) }],
            } : x)));
          }
        }
      }));
      if (!stop) timer = setTimeout(tick, 1500);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [onJobFinished]);

  // reopen whatever was building before a reload
  useEffect(() => {
    const live = [...jobsRef.current].reverse().find((j) => !j.finished);
    if (live) selectTable(live.target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── keyboard ── */

  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setLayer('palette'); }
      if (e.key === 'Escape') setLayer(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active]);

  /* ── tree flags ── */

  const flags = {};
  Object.entries(checked).forEach(([k, v]) => { if (v.score < 55) flags[k] = 'hot'; });
  jobs.forEach((j) => { if (!j.finished) flags[keyOf(j.target)] = 'busy'; });

  return (
    <div className="ih">
      <div className="ih-host">
        <div className="ih-app">
          <aside className="ih-side">
            <div className="ih-side-top">
              <div className="ih-eyebrow">Data Studio</div>
              <h1>Index Health</h1>
              <p>Find the PostgreSQL indexes your queries are missing, and build them safely.</p>
            </div>
            <div className={`ih-envs ${env === 'prod' ? 'prod' : ''}`}>
              {ENVS.map((e) => <button key={e} className={env === e ? 'on' : ''} onClick={() => setEnv(e)} aria-pressed={env === e}>{e}</button>)}
              <span className="ih-bar" style={{ left: `${(ENVS.indexOf(env) * 100) / 3}%` }} />
            </div>
            <button className="ih-find" onClick={() => setLayer('palette')}><Ico n="search" /><span>Find a table</span><kbd>⌘K</kbd></button>
            <div className="ih-tree-head">
              <span className="ih-eyebrow">Databases</span>
              <input value={treeFilter} onChange={(e) => setTreeFilter(e.target.value)} placeholder="Filter…" aria-label="Filter tables in open schemas" />
            </div>
            <Tree env={env} nodes={nodes} open={open} toggle={toggle} filter={treeFilter} flags={flags}
              selected={target ? keyOf(target) : null} onSelect={selectTable} error={treeError} retry={() => load('')} />
            <div className="ih-side-foot"><img alt="" src="/icons/postgres_badge.svg" /><span>PostgreSQL · {env} cluster</span></div>
          </aside>

          <main className="ih-main">
            <div className="ih-wrap">
              {!target ? (
                <Landing env={env} checked={checked} onSelect={selectTable} onFind={() => setLayer('palette')} />
              ) : (
                <>
                  <Header target={target} info={info} result={result} columns={columns} />
                  {error && <div className="ih-err"><Ico n="alert" /><span>{error}</span></div>}
                  <StepTabs step={step} setStep={setStep} result={result} job={job} />
                  <div className="ih-cols">
                    <div>
                      {step === 'usage' && <UsagePane columns={columns} usage={usage} setUsage={setUsage} loading={loading} />}
                      {step === 'diagnosing' && <DiagPane table={target.table} at={diagAt} />}
                      {step === 'results' && result && (
                        <ResultsPane result={result} picked={picked} setPicked={setPicked} keyCol={keyCol} setKeyCol={setKeyCol}
                          sqlFor={sqlFor} lowerTab={lowerTab} setLowerTab={setLowerTab} openIx={openIx} setOpenIx={setOpenIx}
                          onEdit={() => setStep('usage')} />
                      )}
                      {step === 'build' && job && <BuildPane job={job} />}
                    </div>
                    <aside className="ih-rail ih-rise" style={{ '--n': 2 }}>
                      <div className="ih-score">
                        <Ring score={result && step !== 'usage' && step !== 'diagnosing' ? scoreOf(result.summary) : null} />
                        <div>
                          <div className="ih-eyebrow">Health score</div>
                          <h4>{result && step !== 'usage' && step !== 'diagnosing' ? scoreLabel(scoreOf(result.summary)) : 'Not checked'}</h4>
                          <p>{result && step !== 'usage' && step !== 'diagnosing'
                            ? `${plural(result.summary.indexes, 'index', 'indexes')} checked against ${plural(Object.values(usage).filter((u) => u.length).length, 'column')}`
                            : 'Run a diagnosis to score this table.'}</p>
                        </div>
                      </div>
                      <RailBody step={step} result={result} job={job} usage={usage} columns={columns} picked={picked} pickedItems={pickedItems}
                        keyCol={keyCol} building={busy(keyOf(target))} loading={loading} canBuild={canBuild}
                        onRun={runDiagnosis} onBuild={() => setLayer('confirm')} onCancel={() => cancelJob(job)} setStep={setStep} />
                    </aside>
                  </div>
                </>
              )}
            </div>
          </main>
        </div>
      </div>

      {layer === 'palette' && <Palette env={env} nodes={nodes} nodesRef={nodesRef} load={load} flags={flags} onSelect={selectTable} onClose={() => setLayer(null)} />}
      {layer === 'confirm' && result && (
        <ConfirmBuild target={target} items={pickedItems} sqlFor={sqlFor} starting={starting} onStart={startBuild} onClose={() => setLayer(null)} />
      )}
      <Tray jobs={jobs} open={trayOpen} setOpen={setTrayOpen} onView={selectTable} onCancel={canBuild ? cancelJob : null} />
      <div className="ih-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`ih-toast ${t.kind === 'ok' ? '' : 'bad'}`}>
            <Ico n={t.kind === 'ok' ? 'check' : 'alert'} /><span>{t.text}</span>
            {t.action && <button onClick={t.action.run}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────── landing ─────────────────────────────── */

function Landing({ env, checked, onSelect, onFind }) {
  const recent = Object.values(checked).filter((c) => c.target.env === env).sort((a, b) => a.score - b.score).slice(0, 6);
  return (
    <section className="ih-hello">
      <div className="ih-eyebrow ih-rise">Index Health · {env.toUpperCase()}</div>
      <h2 className="ih-rise" style={{ '--n': 1 }}>Fast queries start with the <em>right</em> index.</h2>
      <p className="ih-rise" style={{ '--n': 2 }}>
        Pick a table, tell us how its columns are queried, and see exactly which indexes are missing. Then build them without locking the table.
      </p>
      <div className="ih-how ih-rise" style={{ '--n': 3 }}>
        <div><b>01</b><strong>Describe usage</strong><span>Mark each column as lookup, text search or vector search.</span></div>
        <div><b>02</b><strong>Get a diagnosis</strong><span>See the gaps, ranked by impact, with the exact SQL.</span></div>
        <div><b>03</b><strong>Build live</strong><span>Run fixes concurrently and watch the log as it happens.</span></div>
      </div>
      {recent.length ? (
        <>
          <div className="ih-eyebrow ih-rise" style={{ '--n': 4, marginBottom: 12 }}>Checked this session</div>
          <div className="ih-attn">
            {recent.map((c, i) => (
              <button key={keyOf(c.target)} className="ih-rise" style={{ '--n': i + 5 }} onClick={() => onSelect(c.target)}>
                <span className={`ih-ic ${c.score < 55 ? 'hot' : ''}`}><Ico n={c.score < 55 ? 'alert' : 'shield'} /></span>
                <span><code>{c.target.table}</code><small>{c.target.database} · {c.target.schema} · health {c.score}</small></span>
                <span className="ih-why">{c.why}</span><Ico n="chev" c="ih-go" />
              </button>
            ))}
          </div>
        </>
      ) : (
        <button className="ih-btn ih-rise" style={{ '--n': 4 }} onClick={onFind}><Ico n="search" />Find a table</button>
      )}
    </section>
  );
}

/* ─────────────────────────────── header + tabs ─────────────────────────────── */

function Header({ target, info, result, columns }) {
  return (
    <header className="ih-ph ih-rise">
      <div className="ih-crumbs">
        <span className={`ih-env ${target.env === 'prod' ? 'prod' : ''}`}>{target.env}</span>
        <span className="ih-eyebrow">{target.database}</span><Ico n="chev" /><span className="ih-eyebrow">{target.schema}</span>
      </div>
      <h2><span>{target.schema}.</span>{target.table}</h2>
      {info && (
        <div className="ih-meta">
          <span><Ico n="records" />{info.rows_estimate != null ? `~${fmt(info.rows_estimate)} rows` : 'Row count unknown'}</span>
          <span><Ico n="db" />{info.size}</span>
          <span className={info.last_analyze ? '' : 'bad'}><Ico n="time" />{ago(info.last_analyze)}</span>
          {columns && (
            <span><Ico n="table" />{plural(columns.length, 'column')}{result ? ` · ${plural(result.indexes.length, 'index', 'indexes')}` : ''}</span>
          )}
        </div>
      )}
    </header>
  );
}

function StepTabs({ step, setStep, result, job }) {
  const refs = useRef({});
  const [bar, setBar] = useState(null);
  const building = job && !job.finished;
  const cur = step === 'diagnosing' ? 'results' : step;
  const tabs = [
    ['usage', '01', 'Usage', 'How it’s queried'],
    ['results', '02', 'Diagnosis', result ? plural(result.missing.length, 'finding') : 'Not run yet'],
    ['build', '03', 'Build', building ? `${jobDone(job)}/${job.items.length} running` : job ? (job.status === 'done' ? 'Complete' : job.status[0].toUpperCase() + job.status.slice(1)) : 'Nothing queued'],
  ];

  useLayoutEffect(() => {
    const el = refs.current[cur];
    if (el) setBar({ left: el.offsetLeft, width: el.offsetWidth });
  }, [cur, result, job?.status]);

  return (
    <nav className="ih-tabs ih-rise" style={{ '--n': 1 }}>
      {tabs.map(([k, n, a, b]) => (
        <button key={k} ref={(el) => { refs.current[k] = el; }} className={`ih-tab ${k === cur ? 'on' : ''}`}
          disabled={(k === 'results' && !result) || (k === 'build' && !job) || step === 'diagnosing'} onClick={() => setStep(k)}>
          <b>{n}</b><strong>{a}</strong>{k === 'build' && building && <span className="ih-live" />}<small>{b}</small>
        </button>
      ))}
      {bar && <span className="ih-bar" style={bar} />}
    </nav>
  );
}

/* ─────────────────────────────── usage ─────────────────────────────── */

function UsagePane({ columns, usage, setUsage, loading }) {
  if (!columns) {
    return <section className="ih-card ih-rise" style={{ '--n': 2 }}><div className="ih-loading">{loading && <span className="ih-spin" />}{loading ? 'Reading columns…' : 'Could not read the columns.'}</div></section>;
  }
  const toggle = (col, k) => setUsage((u) => {
    const cur = u[col] || [];
    return { ...u, [col]: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] };
  });
  const bulk = (use) => setUsage((u) => {
    const cols = columns.filter(use.show);
    const allOn = cols.every((c) => (u[c.name] || []).includes(use.key));
    const next = { ...u };
    cols.forEach((c) => { const rest = (u[c.name] || []).filter((x) => x !== use.key); next[c.name] = allOn ? rest : [...rest, use.key]; });
    return next;
  });

  return (
    <section className="ih-card ih-rise" style={{ '--n': 2 }}>
      <div className="ih-ch">
        <div className="ih-fill">
          <h3>How is each column queried?</h3>
          <p>Select every way your queries use a column. Chips marked with a ring already have an index behind them. Leave a column blank if nothing queries it.</p>
        </div>
        <button className="ih-btn link" onClick={() => setUsage(Object.fromEntries(columns.map((c) => [c.name, []])))}>Clear all</button>
        <button className="ih-btn" onClick={() => setUsage(Object.fromEntries(columns.map((c) => [c.name, c.suggested])))}><Ico n="refresh" />Reset to current</button>
      </div>
      <div className="ih-uh">
        <div>Column</div>
        {USES.map((u) => (
          <div key={u.key}><Ico n={u.icon} /><span>{u.label}<small>{u.hint}</small></span><button className="ih-all" onClick={() => bulk(u)}>all</button></div>
        ))}
      </div>
      {columns.map((c) => {
        const u = usage[c.name] || [];
        return (
          <div key={c.name} className={`ih-ur ${u.length ? 'used' : ''}`}>
            <div className="ih-cn"><code>{c.name}</code><span className="ih-ty">{c.type}</span></div>
            {USES.map((x) => (x.show(c) ? (
              <button key={x.key} className={`ih-chip ${u.includes(x.key) ? 'on' : ''}`} onClick={() => toggle(c.name, x.key)}
                aria-pressed={u.includes(x.key)} aria-label={`${c.name}: ${x.label}`}>
                <span className="ih-bx"><Ico n="check" /></span>{x.chip}
                {c.suggested.includes(x.key) && <span className="ih-has" title="Already indexed" />}
              </button>
            ) : <span key={x.key} className="ih-dash">—</span>))}
          </div>
        );
      })}
    </section>
  );
}

/* ─────────────────────────────── diagnosing ─────────────────────────────── */

function DiagPane({ table, at }) {
  return (
    <section className="ih-card ih-diag ih-rise" style={{ '--n': 2 }}>
      <div className="ih-bars">{Array.from({ length: 13 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 70}ms` }} />)}</div>
      <h3>Diagnosing {table}</h3>
      <ul className="ih-checks">
        {DIAG.map((d, i) => (
          <li key={d} className={i < at ? 'ok' : i === at ? 'now' : ''}><span className="ih-s"><Ico n="check" /></span>{d}</li>
        ))}
      </ul>
    </section>
  );
}

/* ─────────────────────────────── results ─────────────────────────────── */

function ResultsPane({ result, picked, setPicked, keyCol, setKeyCol, sqlFor, lowerTab, setLowerTab, openIx, setOpenIx, onEdit }) {
  const s = result.summary;
  const gaps = s.critical + s.high;
  const used = Object.entries(result.checked).flatMap(([use, cols]) => cols.map((c) => [c, use]));
  const buildable = result.missing.filter((m) => m.buildable);

  return (
    <>
      <section className={`ih-card ih-verdict ${s.fast ? 'good' : 'bad'} ih-rise`} style={{ '--n': 2 }}>
        <span className="ih-vi"><Ico n={s.fast ? 'shield' : 'alert'} /></span>
        <div className="ih-fill">
          <h3>{s.fast ? 'Every query pattern you described has an index.' : `${plural(gaps, 'gap')} slowing this table down.`}</h3>
          <p>{s.fast
            ? 'Nothing urgent to build. Tidy up redundant or unused indexes below if you want the space back.'
            : `${s.critical} critical and ${s.high} high priority. Fixes are pre-selected; review and build.`}</p>
          <div className="ih-picked">
            {used.length ? used.map(([c, u]) => <span key={`${u}:${c}`}><Ico n={USE_ICON[u]} />{c}</span>) : <span>No columns selected</span>}
          </div>
        </div>
        <button className="ih-btn" onClick={onEdit}><Ico n="edit" />Edit usage</button>
      </section>

      <section className="ih-card ih-rise" style={{ '--n': 3 }}>
        <div className="ih-ch">
          <div className="ih-fill">
            <div className="ih-seg" role="tablist">
              {[['fixes', `Fixes (${result.missing.length})`], ['indexes', `Indexes (${result.indexes.length})`], ['coverage', 'Coverage']].map(([k, l]) => (
                <button key={k} className={lowerTab === k ? 'on' : ''} onClick={() => setLowerTab(k)} role="tab" aria-selected={lowerTab === k}>{l}</button>
              ))}
            </div>
          </div>
          {lowerTab === 'fixes' && buildable.length > 0 && (
            <div className="ih-sel">Select
              <button className="ih-btn link" onClick={() => setPicked(new Set(buildable.map((m) => m.id)))}>All</button>
              <button className="ih-btn link" onClick={() => setPicked(new Set())}>None</button>
            </div>
          )}
        </div>
        {lowerTab === 'fixes' && <Fixes result={result} picked={picked} setPicked={setPicked} keyCol={keyCol} setKeyCol={setKeyCol} sqlFor={sqlFor} />}
        {lowerTab === 'indexes' && <Indexes indexes={result.indexes} openIx={openIx} setOpenIx={setOpenIx} />}
        {lowerTab === 'coverage' && <Coverage result={result} />}
      </section>
    </>
  );
}

function Fixes({ result, picked, setPicked, keyCol, setKeyCol, sqlFor }) {
  if (!result.missing.length) {
    return (
      <div className="ih-clean">
        <span className="ih-vi"><Ico n="check" /></span>
        <div><h4>Nothing missing</h4><p>Every query pattern you selected is backed by an index.</p></div>
      </div>
    );
  }
  const flip = (id) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <div className="ih-fixes">
      {result.missing.map((m, i) => (
        <article key={m.id} className={`ih-fix ${picked.has(m.id) ? 'on' : ''}`} style={{ '--n': i }}>
          <button className="ih-tick" disabled={!m.buildable} onClick={() => flip(m.id)} aria-pressed={picked.has(m.id)} aria-label={`Include ${featLabel(m.feature)}`}>
            <Ico n="check" />
          </button>
          <div>
            <div className="ih-ft">
              <span className={`ih-pri ${m.priority}`}>{m.priority}</span>
              <strong>{featLabel(m.feature)}</strong>
              {m.column && <code>{m.column}</code>}
              {!m.buildable && <span className="ih-manual">Run by hand</span>}
            </div>
            <p className="ih-why">{m.why}</p>
            {m.feature === 'key' && m.candidates?.length > 0 && (
              <div className="ih-keys">Key column
                {m.candidates.map((c, j) => (
                  <button key={c} className={c === keyCol ? 'on' : ''} onClick={() => setKeyCol(c)}>{c}{j === 0 && <small>suggested</small>}</button>
                ))}
              </div>
            )}
            <SqlBlock sql={sqlFor(m)} />
          </div>
        </article>
      ))}
    </div>
  );
}

const opOf = (ix) => (ix.opclasses?.[0]?.endsWith('_trgm_ops') ? 'trgm' : /to_tsvector/.test(ix.definition || '') ? 'fts' : ix.partial ? 'partial' : '');

function Indexes({ indexes, openIx, setOpenIx }) {
  if (!indexes.length) return <p className="ih-empty">This table has no indexes yet.</p>;
  const max = Math.max(1, ...indexes.map((i) => i.scans));
  const flip = (name) => setOpenIx((s) => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; });
  return (
    <table className="ih-ixt">
      <thead><tr><th>Index</th><th>Type</th><th className="ih-num">Size</th><th className="ih-num">Scans</th><th>Status</th></tr></thead>
      <tbody>
        {indexes.map((ix, n) => (
          <React.Fragment key={ix.name}>
            <tr className="ih-row ih-rise" style={{ '--n': n }} onClick={() => flip(ix.name)} aria-expanded={openIx.has(ix.name)}>
              <td><code>{ix.primary && <Ico n="lock" />}{ix.name}</code><small>{ix.columns.map((c) => c || '(expr)').join(', ')}</small></td>
              <td>{ix.method}{opOf(ix) && <small style={{ display: 'inline' }}> · {opOf(ix)}</small>}</td>
              <td className="ih-num">{ix.size}</td>
              <td className="ih-num">
                {fmt(ix.scans)}
                <div className="ih-meter"><i style={{ width: `${ix.scans ? Math.max(4, (Math.log10(ix.scans + 1) / Math.log10(max + 1)) * 100) : 0}%` }} /></div>
              </td>
              <td><span className={`ih-st ${ix.status}`}>{ix.status[0].toUpperCase() + ix.status.slice(1)}</span></td>
            </tr>
            {openIx.has(ix.name) && (
              <tr className="ih-det">
                <td colSpan={5}>
                  {ix.note && <p>{ix.note}</p>}
                  <SqlBlock sql={ix.definition} />
                  {ix.drop_sql && <><p>To reclaim the space:</p><SqlBlock sql={ix.drop_sql} /></>}
                </td>
              </tr>
            )}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
}

function Coverage({ result }) {
  const want = {};
  Object.entries(result.checked).forEach(([use, cols]) => cols.forEach((c) => { want[c] = [...(want[c] || []), ...NEEDS[use]]; }));
  return (
    <>
      <div className="ih-legend">
        <span><i style={{ background: 'var(--g8)' }} />Indexed</span>
        <span><i style={{ boxShadow: 'inset 0 0 0 2px var(--red)' }} />Needed, missing</span>
        <span><i style={{ background: 'var(--g1)' }} />Not needed</span>
      </div>
      <div className="ih-cov">
        <table>
          <thead><tr><th>Column</th>{CAPS.map(([, l]) => <th key={l}>{l}</th>)}</tr></thead>
          <tbody>
            {result.coverage.map((c, ri) => (
              <tr key={c.column}>
                <td>{c.column}<small>{c.type}</small></td>
                {CAPS.map(([k, l], ci) => {
                  const has = c[k]?.length > 0, gap = !has && (want[c.column] || []).includes(k);
                  const via = k === 'vector' && c.vector_metrics?.length ? ` (${c.vector_metrics.join('/')})` : '';
                  const tip = has ? `${l} via ${c[k].join(', ')}${via}` : gap ? `${l}: missing` : `${l}: not needed`;
                  return (
                    <td key={k}>
                      <div className={`ih-cell ${has ? 'y' : gap ? 'gap' : ''}`} style={{ '--d': ri * 6 + ci }} data-tip={tip}>{has && <Ico n="check" />}</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ─────────────────────────────── rail ─────────────────────────────── */

function RailBody({ step, result, job, usage, columns, picked, pickedItems, keyCol, building, loading, canBuild, onRun, onBuild, onCancel, setStep }) {
  if (step === 'build' && job) {
    const done = jobDone(job);
    return (
      <>
        <div className="ih-rl">
          <div className="ih-rr"><span>Status</span><span className={`ih-v ${['cancelled', 'failed', 'lost'].includes(job.status) ? 'no' : ''}`}>{job.status[0].toUpperCase() + job.status.slice(1)}</span></div>
          <div className="ih-rr"><span>Completed</span><b>{done}<span style={{ color: 'var(--g5)', fontSize: 14 }}> / {job.items.length}</span></b></div>
          <div className="ih-rr"><span>Environment</span><span className={`ih-v ${job.target.env === 'prod' ? 'no' : ''}`}>{job.target.env.toUpperCase()}</span></div>
          <div className="ih-rr"><span>Job</span><span className="ih-v" style={{ fontWeight: 400 }}>{job.id}</span></div>
        </div>
        <div className="ih-rcta">
          <div className="ih-prog"><i style={{ width: `${job.status === 'done' ? 100 : (done / job.items.length) * 100}%` }} /></div>
          {job.finished
            ? <button className="ih-btn wide" disabled={!result} onClick={() => setStep('results')}><Ico n="chart" />See new diagnosis</button>
            : canBuild && <button className="ih-btn wide" onClick={onCancel}><Ico n="close" />Cancel build</button>}
          <small>Running on the server. Switch tables or leave the page, it keeps going.</small>
        </div>
      </>
    );
  }

  if (result && step === 'results') {
    const s = result.summary, n = picked.size, score = scoreOf(s);
    const proj = Math.min(100, score + pickedItems.reduce((a, m) => a + gain(m), 0));
    const keyMissing = picked.has('key') && !keyCol;
    return (
      <>
        <div className="ih-rl">
          <div className="ih-rr"><span>Critical</span><Num v={s.critical} hot /></div>
          <div className="ih-rr"><span>High priority</span><Num v={s.high} hot /></div>
          <div className="ih-rr"><span>Invalid indexes</span><Num v={s.invalid} hot /></div>
          <div className="ih-rr"><span>Redundant</span><Num v={s.redundant} /></div>
          <div className="ih-rr"><span>Unused</span><Num v={s.unused} /></div>
          <div className="ih-rr"><span>Primary key</span><span className={`ih-v ${result.key.index ? '' : 'no'}`}>{result.key.index ? result.key.columns.join(', ') : 'Missing'}</span></div>
          <div className="ih-rr">
            <span>Extensions</span>
            <span className="ih-v">
              <span className={result.extensions.pg_trgm ? '' : 'off'}>{result.extensions.pg_trgm ? '✓' : '✗'} pg_trgm</span><br />
              <span className={result.extensions.vector ? '' : 'off'}>{result.extensions.vector ? '✓' : '✗'} pgvector</span>
            </span>
          </div>
        </div>
        {result.missing.some((m) => m.buildable) && !canBuild && (
          <div className="ih-rcta"><small>You can see the fixes but not run them. Ask an admin for <b>Build Indexes</b> under Data Studio → Index Health.</small></div>
        )}
        {result.missing.some((m) => m.buildable) && canBuild && (
          <div className="ih-rcta">
            <div className="ih-proj">After these fixes<span><s>{score}</s><b key={proj} className="ih-bump">{proj}</b></span></div>
            <button className="ih-btn primary wide" onClick={onBuild} disabled={!n || building || keyMissing}>
              <Ico n="play" />{building ? 'Build already running' : `Build ${plural(n, 'fix', 'fixes')}`}
            </button>
            <small>
              {building
                ? <><button onClick={() => setStep('build')}>View progress</button> · one build per table at a time</>
                : keyMissing ? 'Pick a key column first.' : 'Runs in the background. Keep working while it builds.'}
            </small>
          </div>
        )}
      </>
    );
  }

  const count = (k) => Object.values(usage).filter((v) => v.includes(k)).length;
  const cols = Object.values(usage).filter((v) => v.length).length;
  return (
    <>
      <div className="ih-rl">
        <div className="ih-rr"><span>Columns in play</span><Num v={cols} /></div>
        {USES.map((u) => <div key={u.key} className="ih-rr"><span><Ico n={u.icon} />{u.label}</span><Num v={count(u.key)} /></div>)}
      </div>
      <div className="ih-rcta">
        <button className="ih-btn primary wide" onClick={onRun} disabled={!columns || loading || step === 'diagnosing'}>
          <Ico n="analysis" />{step === 'diagnosing' ? 'Diagnosing…' : 'Run diagnosis'}
        </button>
        <small>{cols ? 'Read-only. Nothing changes on the table.' : 'No columns picked: only checks the key, stats and broken indexes.'}</small>
      </div>
    </>
  );
}

/* ─────────────────────────────── build ─────────────────────────────── */

function BuildPane({ job }) {
  const box = useRef(null);
  const steps = jobSteps(job);
  const running = !job.finished;

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [job.log.length]);

  const title = running ? 'Building' : job.status === 'done' ? 'Build complete' : `Build ${job.status}`;
  return (
    <section className="ih-card ih-rise" style={{ '--n': 2 }}>
      <div className="ih-ch">
        <div className="ih-fill">
          <h3>{title} · {job.target.schema}.{job.target.table}</h3>
          <p>{running
            ? 'Statements run one at a time. Each index is built concurrently, so the table stays online.'
            : 'The table has been re-checked with the new indexes in place.'}</p>
        </div>
      </div>
      <div className="ih-steps">
        {steps.map((s) => (
          <div key={s.id} className={`ih-si ${s.st}`}>
            <span className="ih-s"><Ico n="check" /></span>
            <span>{featLabel(s.feature)}{s.column && <> · <code>{s.column}</code></>}</span>
            <small>{s.note}</small>
          </div>
        ))}
      </div>
      <div className="ih-term">
        <div className="ih-tb"><span>Server log</span><span>{secs(job)}s</span></div>
        <div className="ih-log" ref={box}>
          {!job.log.length && <span className="ih-ts">waiting for the server…</span>}
          {job.log.map((l, i) => (
            <div key={i} className={`l-${l.level}`}><span className="ih-ts">{l.ts}  </span>{l.level === 'sql' ? '› ' : ''}{l.msg}</div>
          ))}
          {running && <span className="ih-caret" />}
        </div>
      </div>
      <div className="ih-note"><Ico n="info" />Cancelling mid-build discards the index in progress and leaves it invalid. The next diagnosis offers to clean it up.</div>
    </section>
  );
}

function ConfirmBuild({ target, items, sqlFor, starting, onStart, onClose }) {
  const prod = target.env === 'prod';
  const [typed, setTyped] = useState('');
  const [shake, setShake] = useState(false);
  const ok = !prod || typed.trim() === target.table;
  const go = () => {
    if (!ok) { setShake(true); setTimeout(() => setShake(false), 350); return; }
    onStart();
  };
  return (
    <div className="ih-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`ih-modal ${shake ? 'ih-shake' : ''}`} role="dialog" aria-modal="true" aria-labelledby="ih-mt">
        <div className="ih-mh">
          <span className={`ih-env ${prod ? 'prod' : ''}`}>{target.env}</span>
          <h3 id="ih-mt">Build {plural(items.length, 'fix', 'fixes')} on {target.schema}.{target.table}</h3>
          <p>{target.database} · These statements run in order, exactly as shown.</p>
        </div>
        <div className="ih-mb">
          {items.map((m) => (
            <div key={m.id} className="ih-item">
              <div className="ih-ft"><span className={`ih-pri ${m.priority}`}>{m.priority}</span><strong>{featLabel(m.feature)}</strong>{m.column && <code>{m.column}</code>}</div>
              <SqlBlock sql={sqlFor(m)} />
            </div>
          ))}
          {prod && (
            <div className="ih-guard">
              <strong><Ico n="alert" />You’re about to change production</strong>
              <p>Type <b>{target.table}</b> to confirm.</p>
              <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()}
                autoComplete="off" spellCheck="false" placeholder="Table name" aria-label="Type the table name to confirm" />
            </div>
          )}
        </div>
        <div className="ih-mf">
          <span><Ico n="shield" />Concurrent builds. Reads and writes keep flowing.</span>
          <button className="ih-btn link" onClick={onClose}>Cancel</button>
          <button className="ih-btn primary" onClick={go} disabled={!ok || starting} autoFocus={!prod}>
            <Ico n="play" />{starting ? 'Starting…' : 'Start build'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────── palette ─────────────────────────────── */

function Palette({ env, nodes, nodesRef, load, flags, onSelect, onClose }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [scanning, setScanning] = useState(true);
  const listRef = useRef(null);

  // walk the whole catalog once, one request at a time; results land in the tree's cache
  useEffect(() => {
    let stop = false;
    (async () => {
      const get = async (p) => (Array.isArray(nodesRef.current[p]) ? nodesRef.current[p] : await load(p)) || [];
      for (const db of await get('')) {
        if (stop) return;
        for (const sc of await get(db)) {
          if (stop) return;
          await get(`${db}${SEP}${sc}`);
        }
      }
      if (!stop) setScanning(false);
    })();
    return () => { stop = true; };
  }, [env, load, nodesRef]);

  const all = [];
  (Array.isArray(nodes['']) ? nodes[''] : []).forEach((db) => (Array.isArray(nodes[db]) ? nodes[db] : []).forEach((sc) => {
    const ts = nodes[`${db}${SEP}${sc}`];
    if (Array.isArray(ts)) ts.forEach((t) => all.push({ env, database: db, schema: sc, table: t }));
  }));
  const needle = q.trim().toLowerCase();
  const list = all.filter((x) => !needle || `${x.database}.${x.schema}.${x.table}`.toLowerCase().includes(needle)).slice(0, 200);
  const at = Math.min(sel, Math.max(0, list.length - 1));

  useEffect(() => { listRef.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }); }, [at]);

  const mark = (s) => {
    if (!needle) return s;
    const i = s.toLowerCase().indexOf(needle);
    return i < 0 ? s : <>{s.slice(0, i)}<mark>{s.slice(i, i + needle.length)}</mark>{s.slice(i + needle.length)}</>;
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { setSel(Math.min(at + 1, list.length - 1)); e.preventDefault(); }
    if (e.key === 'ArrowUp') { setSel(Math.max(at - 1, 0)); e.preventDefault(); }
    if (e.key === 'Enter' && list[at]) onSelect(list[at]);
  };

  return (
    <div className="ih-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ih-pal" role="dialog" aria-modal="true" aria-label="Find a table">
        <div className="ih-pal-in">
          <Ico n="search" />
          <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}
            placeholder={`Find a table in ${env}`} autoComplete="off" aria-label="Find a table" />
          <kbd>esc</kbd>
        </div>
        <ul ref={listRef} role="listbox">
          {list.map((x, i) => {
            const k = keyOf(x);
            return (
              <li key={k} className={i === at ? 'sel' : ''} role="option" aria-selected={i === at} onClick={() => onSelect(x)} onMouseMove={() => setSel(i)}>
                <Ico n="table" /><code>{mark(x.table)}</code><small>{x.database} · {x.schema}</small>
                {flags[k] === 'busy' ? <span className="ih-spin" /> : flags[k] === 'hot' ? <span className="ih-flag" /> : null}
              </li>
            );
          })}
          {!list.length && <li className="ih-nil">{scanning ? 'Looking through the catalog…' : 'No tables match'}</li>}
        </ul>
        <div className="ih-pal-ff">
          <span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            {scanning && <span className="ih-spin" />}{plural(all.length, 'table')}{scanning ? ' so far' : ''}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────── tray ─────────────────────────────── */

function Tray({ jobs, open, setOpen, onView, onCancel }) {
  if (!jobs.length) return null;
  const all = [...jobs].reverse();
  const live = jobs.filter((j) => !j.finished);
  const pct = live.length ? live.reduce((a, j) => a + jobDone(j) / j.items.length, 0) / live.length : 1;
  return (
    <aside className={`ih-tray ${open ? 'open' : ''} ${live.length ? 'busy' : ''}`} aria-live="polite">
      <button className="ih-th" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Background builds">
        <span className="ih-mini">
          <svg viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3" className="ih-tk" />
            <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3" className="ih-ar" strokeDasharray="94.2" strokeDashoffset={94.2 * (1 - pct)} />
          </svg>
          {live.length ? <b>{live.length}</b> : <Ico n="check" />}
        </span>
        <span className="ih-tt">
          <strong>{live.length ? `${plural(live.length, 'build')} running` : 'All builds finished'}</strong>
          <small>{live.length ? 'In the background on the server' : `${all.length} this session`}</small>
        </span>
        <Ico n="chev" c="ih-caretup" />
      </button>
      {open && (
        <div className="ih-tl">
          {all.map((j) => {
            const done = jobDone(j);
            const next = jobSteps(j).find((s) => s.st === 'now');
            const line = !j.finished
              ? `${done}/${j.items.length} · ${next ? featLabel(next.feature) : 'starting'}`
              : j.status === 'done' ? `Done · health ${j.before ?? '—'} → ${j.after ?? '…'}`
                : `${j.status[0].toUpperCase() + j.status.slice(1)} after ${done}/${j.items.length}`;
            return (
              <div key={j.id} className={`ih-job ${j.finished ? j.status : 'running'}`}>
                <div className="ih-jt"><span className={`ih-env ${j.target.env === 'prod' ? 'prod' : ''}`}>{j.target.env}</span><code>{j.target.schema}.{j.target.table}</code></div>
                <div className="ih-jbar"><i style={{ width: `${j.status === 'done' ? 100 : Math.round((done / j.items.length) * 100)}%` }} /></div>
                <div className="ih-jm"><span>{line}</span><span>{secs(j)}s</span></div>
                <div className="ih-ja">
                  <button className="ih-btn link" onClick={() => onView(j.target)}>View</button>
                  {!j.finished && onCancel && <button className="ih-btn link" onClick={() => onCancel(j)}>Cancel</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

export default IndexHealth;