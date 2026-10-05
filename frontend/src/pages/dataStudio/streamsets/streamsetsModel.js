// Plain helpers for the StreamSets pane - kept out of the .jsx so they can be
// reasoned about (and tested) without React.

export const KIND = {
  SOURCE: { label: 'Source', plural: 'Sources', color: '#1f8f4e', bg: '#e8f5ee' },
  PROCESSOR: { label: 'Transformation', plural: 'Transformations', color: '#11567f', bg: '#e3f2fa' },
  TARGET: { label: 'Destination', plural: 'Destinations', color: '#b8730d', bg: '#fdf3e3' },
  EXECUTOR: { label: 'Executor', plural: 'Executors', color: '#6e6259', bg: '#f1efed' },
};
export const KIND_ORDER = ['SOURCE', 'PROCESSOR', 'TARGET', 'EXECUTOR'];
export const FRAGMENT = { color: '#6b3fa0', bg: '#f1ebf8' };

/** Stage address inside the tree: fragment instances then the stage, joined by '/'. */
export const pathOf = (parents, stage) => [...parents, stage.instance].join('/');

/** Find a stage by its path; returns { stage, parents: [fragment stages] } or null. */
export function findStage(stages, path) {
  if (!path || !Array.isArray(stages)) return null;
  const parts = path.split('/');
  let level = stages;
  const parents = [];
  for (let i = 0; i < parts.length; i += 1) {
    const hit = level.find(s => s.instance === parts[i]);
    if (!hit) return null;
    if (i === parts.length - 1) return { stage: hit, parents };
    if (!hit.fragment) return null;
    parents.push(hit);
    level = hit.fragment.stages || [];
  }
  return null;
}

/** Every stage with where it lives: [{ stage, parents, path }], fragments included. */
export function flattenStages(stages, parents = []) {
  const out = [];
  (stages || []).forEach(stage => {
    out.push({ stage, parents, path: pathOf(parents.map(p => p.instance), stage) });
    if (stage.fragment) out.push(...flattenStages(stage.fragment.stages, [...parents, stage]));
  });
  return out;
}

/** Where the data starts and ends, looking inside fragments: { sources, destinations, transforms }. */
export function routeSummary(stages) {
  const leaves = flattenStages(stages).map(r => r.stage).filter(s => !s.fragment);
  return {
    sources: leaves.filter(s => s.kind === 'SOURCE'),
    destinations: leaves.filter(s => s.kind === 'TARGET'),
    transforms: leaves.filter(s => s.kind === 'PROCESSOR').length,
  };
}

/** "Snowflake · Table Jdbc", without saying the same thing twice ("Snowflake · Snowflake"). */
export function stageSubtitle(stage) {
  if (stage.fragment) return stage.fragment.name;
  const tech = stage.technology || '';
  const type = stage.type_name || '';
  if (!tech || tech === 'StreamSets') return type || tech;
  if (tech.toLowerCase() === type.toLowerCase()) return tech;
  return type ? `${tech} · ${type}` : tech;
}

/** Last dotted segment of a config name, split for reading: "hikariConfigBean.connectionString" -> "Connection String". */
export function configLabel(name) {
  const last = String(name || '').split('.').pop();
  const spaced = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function matchesPipeline(p, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  return [p.name, p.id, p.description, p.modified_by, ...(p.labels || [])]
    .some(v => String(v || '').toLowerCase().includes(q));
}

/** "Processing: X" style progress -> counts for the header. */
export function runCounts(pipelines) {
  const counts = { queued: 0, running: 0, done: 0, failed: 0 };
  (pipelines || []).forEach(p => { counts[p.state] = (counts[p.state] || 0) + 1; });
  return counts;
}

export function extractUrl(ids) {
  return `/api/streamsets/extract?${ids.map(id => `pipeline_id=${encodeURIComponent(id)}`).join('&')}`;
}

/** Message for an extraction stream that failed before it started. */
export function streamErrorMessage(status) {
  switch (status) {
    case 400: return 'The server refused that selection - check how many pipelines are picked.';
    case 403: return "You don't have permission to run the extractor.";
    case 404: return 'One of the picked pipelines no longer exists in StreamSets - refresh the list.';
    case 503: return "The extractor isn't available on the server right now.";
    default: return status ? `Couldn't start the extraction (HTTP ${status}).` : "Couldn't reach the server.";
  }
}

/* ------------------------------ canvas layout ----------------------------- */

export const NODE_W = 248;
const COL_GAP = 96;
const ROW_GAP = 28;
const STAGE_H = 72;
const FRAG_H = 100;          // header + the "show stages" row
const INNER_ROW_H = 34;

/** Height a node will draw at, so the layout can stack them without overlap. */
export function nodeHeight(stage, expanded) {
  if (!stage.fragment) return STAGE_H;
  if (!expanded || stage.fragment.error) return FRAG_H;
  return FRAG_H + Math.max(1, stage.fragment.stages.length) * INNER_ROW_H + 8;
}

/**
 * Left-to-right layout for the canvas, no layout library needed: a stage's
 * column is one past its furthest input (records or events), and inside a
 * column stages sit in the average row of what feeds them, which keeps most
 * edges straight and stops them crossing. Columns are centred on each other.
 */
export function canvasLayout(stages, expandedSet) {
  const list = stages || [];
  const known = new Set(list.map(s => s.instance));
  const inputs = (s) => [...(s.upstream || []), ...(s.triggered_by || [])].filter(i => known.has(i));
  const col = new Map();
  list.forEach(s => {   // stages arrive in flow order, so inputs are always placed first
    const ins = inputs(s).filter(i => col.has(i));
    col.set(s.instance, ins.length ? Math.max(...ins.map(i => col.get(i))) + 1 : 0);
  });

  const columns = [];
  list.forEach((s, i) => (columns[col.get(s.instance)] = columns[col.get(s.instance)] || []).push({ s, i }));
  const rank = new Map();
  columns.forEach(c => {
    c.sort((a, b) => {
      const avg = (x) => {
        const r = inputs(x.s).map(p => rank.get(p)).filter(v => v !== undefined);
        return r.length ? r.reduce((t, v) => t + v, 0) / r.length : x.i;
      };
      return avg(a) - avg(b) || a.i - b.i;
    });
    c.forEach((x, idx) => rank.set(x.s.instance, idx));
  });

  const heights = columns.map(c => c.reduce((t, x) => t + nodeHeight(x.s, expandedSet.has(x.s.instance)), 0) + ROW_GAP * (c.length - 1));
  const tallest = Math.max(0, ...heights);
  const nodes = [];
  columns.forEach((c, ci) => {
    let y = (tallest - heights[ci]) / 2;
    c.forEach(({ s }) => {
      const h = nodeHeight(s, expandedSet.has(s.instance));
      nodes.push({ id: s.instance, x: ci * (NODE_W + COL_GAP), y, w: NODE_W, h, stage: s });
      y += h + ROW_GAP;
    });
  });

  const edges = [];
  list.forEach(s => {
    (s.upstream || []).filter(u => known.has(u)).forEach(u => edges.push({ id: `d:${u}>${s.instance}`, source: u, target: s.instance, kind: 'data' }));
    (s.triggered_by || []).filter(u => known.has(u)).forEach(u => edges.push({ id: `e:${u}>${s.instance}`, source: u, target: s.instance, kind: 'event' }));
  });
  return { nodes, edges };
}