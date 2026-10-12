// Plain helpers for the StreamSets pane - kept out of the .jsx so they can be
// reasoned about (and tested) without React.

export const KIND = {
  SOURCE: { label: 'Source', plural: 'Sources', cls: 'src', color: '#328714', bg: '#eef5ea' },
  PROCESSOR: { label: 'Transformation', plural: 'Transformations', cls: 'proc', color: '#0f68b2', bg: '#e8f1fa' },
  TARGET: { label: 'Destination', plural: 'Destinations', cls: 'dst', color: '#d9620f', bg: '#fdf1e7' },
  EXECUTOR: { label: 'Executor', plural: 'Executors', cls: 'exe', color: '#6e6259', bg: '#f1efed' },
};
export const KIND_ORDER = ['SOURCE', 'PROCESSOR', 'TARGET', 'EXECUTOR'];
export const FRAGMENT = { label: 'Fragment', plural: 'Fragments', cls: 'frag', color: '#8c3bbb', bg: '#f5edfb' };
export const kindOf = (stage) => (stage.fragment ? FRAGMENT : KIND[stage.kind] || KIND.PROCESSOR);
export const MASK = '********';

// Colour + two-letter mark per technology the backend names (TECHNOLOGIES in streamsets_extractor.py).
const TECH = {
  Snowflake: ['#29b5e8', 'SF'], Oracle: ['#c74634', 'OR'], 'SQL Server': ['#a91d22', 'MS'], MySQL: ['#00758f', 'MY'],
  PostgreSQL: ['#336791', 'PG'], Teradata: ['#f37440', 'TD'], JDBC: ['#57606a', 'DB'], Kafka: ['#3a3532', 'KF'],
  'Amazon Kinesis': ['#8c4fff', 'KN'], 'Amazon S3': ['#3f8624', 'S3'], Azure: ['#0078d4', 'AZ'], 'Google Cloud Storage': ['#4285f4', 'GC'],
  BigQuery: ['#669df6', 'BQ'], HDFS: ['#66ccff', 'HD'], Hive: ['#c9a400', 'HV'], MongoDB: ['#13aa52', 'MG'],
  Elasticsearch: ['#00a9a5', 'ES'], Salesforce: ['#00a1e0', 'SA'], SFTP: ['#81766f', 'FT'], FTP: ['#81766f', 'FT'],
  HTTP: ['#0f68b2', 'API'], Directory: ['#81766f', 'DR'], Jython: ['#d99a00', 'PY'], Groovy: ['#4298b8', 'GV'],
  JavaScript: ['#c9a400', 'JS'], Fragment: ['#8c3bbb', 'FR'], 'Pipeline Finisher': ['#6e6259', 'PF'], Trash: ['#a39992', 'TR'],
  StreamSets: ['#eb1700', 'SS'],
};
export const techMeta = (tech) => { const [color, mark] = TECH[tech] || TECH.StreamSets; return { color, mark }; };

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
  const leaves = flattenStages(stages).filter(r => !r.stage.fragment);
  return {
    sources: leaves.filter(r => r.stage.kind === 'SOURCE'),
    destinations: leaves.filter(r => r.stage.kind === 'TARGET'),
    transforms: leaves.filter(r => r.stage.kind === 'PROCESSOR').length,
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
  const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
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

/** "3 days ago" for the list; the exact date goes in a tooltip. */
export function relativeDay(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const days = (Date.now() - t) / 864e5;
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 30) return `${Math.floor(days)} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} yr ago`;
}

/* ------------------------------ canvas layout ----------------------------- */

export const NODE_W = 248;
const COL_GAP = 96;
const ROW_GAP = 28;
const STAGE_H = 72;
const FRAG_H = 100;          // header + the "show steps" row
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
      nodes.push({ id: s.instance, x: ci * (NODE_W + COL_GAP), y, w: NODE_W, h, col: ci, stage: s });
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

/** Everything that feeds a stage and everything it feeds, for the hover highlight. */
export function lineage(edges, id) {
  const seen = new Set([id]);
  [['target', 'source'], ['source', 'target']].forEach(([from, to]) => {
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      edges.forEach(e => { if (e[from] === cur && !seen.has(e[to])) { seen.add(e[to]); stack.push(e[to]); } });
    }
  });
  return seen;
}

/* ============================================================================
   Plain English - what a stage does, and setting values people can read.

   Text comes back as "segments" so the .jsx renders it without HTML strings:
     'text' | { t: 'b', c: [...] } bold | { t: 'f', v: '/PATH' } a field
     { t: 'p', name, value } a pipeline parameter (value null = only set at runtime)
     { t: 'el', raw: '${...}', c: [...] } an expression, already put into words
     { t: 'code', v } a short literal
     { t: 'res', path, restricted } a runtime:loadResource() file - the pane can look its value up
   The stage types follow the config names generate_stage_summary() reads in
   DQ_IT_Validation/Streamsets/Final_pipeline_extractor.py.
   ============================================================================ */

export const ENUM = {
  SPECIFIED_FIELDS: 'Only the listed fields', ALL_FIELDS: 'Every field', REMOVE: 'Remove the listed fields', KEEP: 'Keep only the listed fields',
  ENTIRE_RECORD: 'The whole record', SPECIFIC_FIELDS: 'Only the listed fields', NATIVE_OBJECTS: 'Native script objects', SDC_RECORDS: 'StreamSets records',
  INTERNAL: "Snowflake's internal stage", EXTERNAL: 'An external stage', DELIMITED: 'Delimited (CSV)', JSON: 'JSON', XML: 'XML', AVRO: 'Avro',
  PARQUET: 'Parquet', TEXT: 'Plain text', OAUTH2: 'OAuth 2', BASIC: 'Basic (username & password)', NONE: 'None',
  LINK_HEADER: 'Follow the next-page link in the response headers', CONTINUE: 'Skip it and carry on', TO_ERROR: 'Send the record to the error stream',
  DISCARD: 'Drop the record', STOP_PIPELINE: 'Stop the pipeline', DECIMAL: 'Decimal', DATETIME: 'Date & time', DATE: 'Date', STRING: 'Text',
  INTEGER: 'Whole number', LONG: 'Whole number', DOUBLE: 'Number', BOOLEAN: 'Yes / No', SHA256: 'SHA-256', SHA1: 'SHA-1', MD5: 'MD5',
};

// Setting / key names -> words, looked up by the last dotted segment in lower case.
const WORDS = {
  connectionstring: 'Connection string', username: 'Username', password: 'Password', usecredentials: 'Signs in with a username & password',
  tableconfigs: 'Tables to read', maxbatchsize: 'Rows per batch', queryinterval: 'Wait between queries', query: 'SQL query', sqlquery: 'SQL query',
  brokeruri: 'Kafka brokers', topiclist: 'Kafka topics', topic: 'Kafka topic', consumergroup: 'Consumer group', dataformat: 'Data format',
  keystorepassword: 'Key store password', authendpoint: 'Sign-in address', soqlquery: 'SOQL query', bucket: 'S3 bucket',
  prefixpattern: 'Files to pick up', awssecretaccesskey: 'AWS secret key', awsaccesskeyid: 'AWS access key', remoteaddress: 'Server address',
  filepattern: 'Files to pick up', resourceurl: 'URL', httpmethod: 'HTTP method', authtype: 'Sign-in method', clientid: 'Client ID',
  clientsecret: 'Client secret', mode: 'Paging', fieldtypeconverterconfigs: 'Type changes', expressionprocessorconfigs: 'Fields it sets',
  fields: 'Fields', filteroperation: 'What to do', script: 'Script', initscript: 'Start-up script', destroyscript: 'Shut-down script',
  recordtype: 'Record type', comparefields: 'Compare on', fieldstocompare: 'Fields compared', timewindowsecs: 'Remember records for (seconds)',
  renamemapping: 'Renames', nonexistingfromfieldhandling: 'If a field is missing', flattentype: 'What to flatten', nameseparator: 'Name separator',
  lanepredicates: 'Routes', inplacefieldhasherconfigs: 'Fields to hash', account: 'Account', warehouse: 'Warehouse', database: 'Database',
  schema: 'Schema', table: 'Table', user: 'User', role: 'Role', mergecdc: 'Apply changes (merge)', location: 'Staging area',
  partitiontemplate: 'Folder names', preconditions: 'Only when', stagerecordpreconditions: 'Only process records when',
  stageonrecorderror: 'When a record fails', stagerequiredfields: 'Required fields', resetoffset: 'Start over next run', email: 'Emails',
  prefix: 'Parameter prefix', fieldtoset: 'Field', expression: 'Set to', fromfieldexpression: 'From', tofieldexpression: 'To',
  targettype: 'Becomes', scale: 'Decimal places', dateformat: 'Date pattern', sourcefieldstohash: 'Fields', hashtype: 'Hash',
  outputlane: 'Route', predicate: 'Condition', tablepattern: 'Table', offsetcolumns: 'Tracks new rows by',
  offsetcolumntoinitialoffsetvalue: 'First run starts from', subject: 'Subject', body: 'Message',
};
export const word = (name) => WORDS[String(name).split('.').pop().toLowerCase()] || configLabel(name);

/** The backend sends every value as text (JSON for lists/objects). Long ones are cut, so they stay text. */
export function parseVal(s) {
  if (typeof s !== 'string') return s;
  const t = s.trim();
  if (/^[[{]/.test(t) || t === 'true' || t === 'false') {
    try { return JSON.parse(t); } catch { /* truncated or not JSON - show as text */ }
  }
  return s;
}

/** Which group a setting is listed under in the stage panel. */
export const SECTIONS = ['Main settings', 'Connection & sign-in', 'Script', 'Performance', 'Error handling'];
export function sectionOf(name) {
  const last = String(name).split('.').pop();
  if (/script/i.test(last)) return 'Script';
  if (/^(errorHandler|stageOnRecordError|stageRequiredFields|stageRecordPreconditions)/i.test(name)) return 'Error handling';
  if (/connectionString|password|secret|^user(name)?$|useCredentials|auth|account|warehouse|brokerURI|endpoint|remoteAddress|keystore|truststore|clientId|^role$|region|accessKey/i.test(last)) return 'Connection & sign-in';
  if (/batch|interval|timeout|wait|thread/i.test(last)) return 'Performance';
  return 'Main settings';
}

/** What the plain-English view needs to resolve ${...} for one stage. */
export function stageCtx(detail, path) {
  const found = findStage(detail.stages, path);
  const last = found && found.parents[found.parents.length - 1];
  return {
    params: new Map((detail.parameters || []).map(p => [p.name, p.value])),
    prefix: last?.fragment?.prefix || '',
    siblings: last ? last.fragment.stages : detail.stages,
  };
}

// A fragment's settings say ${X}; the pipeline stores it as <prefix>X (same rule as _config_items).
// A parameter whose value is itself an expression (often ${runtime:loadResource(...)}) carries it as c.
function paramOf(ref, ctx) {
  const key = ctx.prefix && ctx.params.has(ctx.prefix + ref) ? ctx.prefix + ref : ref;
  const value = ctx.params.has(key) ? ctx.params.get(key) : null;
  const seg = { t: 'p', name: key, value };
  if (!ctx.nested && typeof value === 'string' && value.includes('${')) seg.c = tmpl(value, { ...ctx, nested: true });
  return seg;
}

// runtime:loadResource("parameters/RID/User.txt", false) - Data Collector reads that file when the pipeline
// runs. Inside list/map settings the value is JSON text, so the quotes can arrive escaped (\").
const LOAD_RESOURCE_RE = /runtime:loadResource(?:Raw)?\(\s*\\?["']([^"'\\]+)\\?["']\s*,\s*(true|false)\s*\)/gi;

/** Resource files referenced in some text, including through the parameters it uses: [{ path, restricted }]. */
export function resourceRefs(texts) {
  const out = new Map();
  [].concat(texts).forEach(t => {
    for (const m of String(t ?? '').matchAll(LOAD_RESOURCE_RE)) {
      out.set(m[1], (out.get(m[1]) || false) || m[2].toLowerCase() === 'true');
    }
  });
  return [...out].map(([path, restricted]) => ({ path, restricted }));
}

/* ---- StreamSets expression language: parse it properly, then say it in words ---- */

const EL_OPS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '+', '-', '*', '/', '%', '?', ':', '(', ')', ',', '[', ']'];
const EL_WORD_OPS = { and: '&&', or: '||', not: '!', eq: '==', ne: '!=', lt: '<', gt: '>', le: '<=', ge: '>=', div: '/', mod: '%', empty: 'empty' };

function elTokens(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j += 1;
        v += src[j];
        j += 1;
      }
      if (j >= src.length) return null;
      out.push({ t: 'str', v });
      i = j + 1;
      continue;
    }
    const rest = src.slice(i);
    const num = /^\d+(\.\d+)?/.exec(rest);
    if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][\w.]*(?::[A-Za-z_]\w*)?/.exec(rest);
    if (id) {
      out.push(EL_WORD_OPS[id[0]] ? { t: 'op', v: EL_WORD_OPS[id[0]] } : { t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = EL_OPS.find(o => src.startsWith(o, i));
    if (!op) return null;
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  return out;
}

/** Tokens -> tree, or null when it isn't an expression this understands (then it's shown as written). */
function elParse(tokens) {
  let p = 0;
  const isOp = (v) => tokens[p]?.t === 'op' && tokens[p].v === v;
  const take = (v) => { if (!isOp(v)) throw new Error(`expected ${v}`); p += 1; };
  function primary() {
    const t = tokens[p];
    p += 1;
    if (!t) throw new Error('end');
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'id') {
      if (/^(true|false)$/i.test(t.v)) return { k: 'bool', v: t.v.toLowerCase() };
      if (/^null$/i.test(t.v)) return { k: 'null' };
      return { k: 'id', v: t.v };
    }
    if (t.v === '(') { const x = ternary(); take(')'); return x; }
    throw new Error(`unexpected ${t.v}`);
  }
  function postfix() {
    let x = primary();
    for (;;) {
      if (isOp('(') && x.k === 'id') {
        p += 1;
        const args = [];
        if (!isOp(')')) {
          args.push(ternary());
          while (isOp(',')) { p += 1; args.push(ternary()); }
        }
        take(')');
        x = { k: 'call', name: x.v, args };
      } else if (isOp('[')) {
        p += 1;
        const i = ternary();
        take(']');
        x = { k: 'idx', x, i };
      } else {
        return x;
      }
    }
  }
  function unary() {
    if (isOp('!') || isOp('-') || isOp('empty')) { const op = tokens[p].v; p += 1; return { k: 'un', op, x: unary() }; }
    return postfix();
  }
  const level = (next, ops) => () => {
    let l = next();
    while (tokens[p]?.t === 'op' && ops.includes(tokens[p].v)) {
      const op = tokens[p].v;
      p += 1;
      l = { k: 'bin', op, l, r: next() };
    }
    return l;
  };
  const or = level(level(level(level(level(level(unary, ['*', '/', '%']), ['+', '-']), ['<', '>', '<=', '>=']), ['==', '!=']), ['&&']), ['||']);
  function ternary() {
    const c = or();
    if (!isOp('?')) return c;
    p += 1;
    const a = ternary();
    take(':');
    return { k: 'tern', c, a, b: ternary() };
  }
  try {
    const tree = ternary();
    return p === tokens.length ? tree : null;
  } catch {
    return null;
  }
}

const TYPE_WORDS = {
  DATETIME: 'a date-time', DATE: 'a date', TIME: 'a time', ZONED_DATETIME: 'a date-time with a zone', STRING: 'text', INTEGER: 'a whole number',
  LONG: 'a whole number', SHORT: 'a whole number', DECIMAL: 'a decimal', DOUBLE: 'a number', FLOAT: 'a number', BOOLEAN: 'yes/no',
  MAP: 'a map', LIST: 'a list', LIST_MAP: 'a list-map', BYTE_ARRAY: 'bytes', CHAR: 'a character',
};
const OP_WORDS = {
  '&&': ' and ', '||': ' or ', '==': ' is ', '!=': ' is not ', '<': ' is less than ', '>': ' is more than ', '<=': ' is at most ',
  '>=': ' is at least ', '+': ' plus ', '-': ' minus ', '*': ' times ', '/': ' divided by ', '%': ' modulo ',
};
const UNITS = { MILLISECONDS: 'ms', SECONDS: 'seconds', MINUTES: 'minutes', HOURS: 'hours', DAYS: 'days' };
const isCall = (n, ...names) => n?.k === 'call' && names.includes(n.name.toLowerCase());
const lit = (n) => (n?.k === 'str' ? n.v : null);
const fieldOf = (a, s) => (lit(a) != null ? [F(lit(a))] : ['the field at ', ...s(a)]);

// Common functions -> words. Anything not here is shown as name(arguments), with the arguments still in words.
const EL_FN = {
  'record:value': (a, s) => fieldOf(a[0], s),
  'record:valueordefault': (a, s) => [...fieldOf(a[0], s), ' (or ', ...s(a[1]), ' when it is missing)'],
  'record:exists': (a, s) => [...fieldOf(a[0], s), ' exists'],
  'record:type': (a, s) => ['the type of ', ...fieldOf(a[0], s)],
  'record:attribute': (a, s) => ['the record attribute ', ...s(a[0])],
  'record:errorcode': 'the error code', 'record:errormessage': 'the error message', 'record:eventtype': 'the event type',
  'record:id': 'the record ID', 'record:errorstage': 'the stage that raised the error',
  'f:value': "the field's value", 'f:type': "the field's type", 'f:path': "the field's path",
  'f:attribute': (a, s) => ['the field attribute ', ...s(a[0])],
  'str:trim': (a, s) => [...s(a[0]), ' with surrounding spaces removed'],
  'str:toupper': (a, s) => [...s(a[0]), ' in upper case'],
  'str:tolower': (a, s) => [...s(a[0]), ' in lower case'],
  'str:substring': (a, s) => ['characters ', ...s(a[1]), ' to ', ...s(a[2]), ' of ', ...s(a[0])],
  'str:replace': (a, s) => [...s(a[0]), ' with ', ...s(a[1]), ' replaced by ', ...s(a[2])],
  'str:replaceall': (a, s) => [...s(a[0]), ' with every match of ', ...s(a[1]), ' replaced by ', ...s(a[2])],
  'str:concat': (a, s) => [...s(a[0]), ' followed by ', ...s(a[1])],
  'str:contains': (a, s) => [...s(a[0]), ' contains ', ...s(a[1])],
  'str:startswith': (a, s) => [...s(a[0]), ' starts with ', ...s(a[1])],
  'str:endswith': (a, s) => [...s(a[0]), ' ends with ', ...s(a[1])],
  'str:length': (a, s) => ['the length of ', ...s(a[0])],
  'str:isnullorempty': (a, s) => [...s(a[0]), ' is empty'],
  'str:matches': (a, s) => [...s(a[0]), ' matches the pattern ', ...s(a[1])],
  'str:truncate': (a, s) => [...s(a[0]), ' cut to ', ...s(a[1]), ' characters'],
  'str:regexcapture': (a, s) => ['group ', ...s(a[2]), ' of ', ...s(a[0]), ' matched against ', ...s(a[1])],
  'time:now': 'the current time',
  'time:createdatefromstringtz': (a, s) => [...s(a[0]), ' read as a date in ', ...s(a[1]), ' time (format ', ...s(a[2]), ')'],
  'time:extractstringfromdatetz': (a, s) => [...s(a[0]), ' written as ', ...s(a[2]), ' in ', ...s(a[1]), ' time'],
  'time:extractstringfromdate': (a, s) => [...s(a[0]), ' written as ', ...s(a[1])],
  'time:extractdatefromstring': (a, s) => [...s(a[0]), ' read as a date (format ', ...s(a[1]), ')'],
  'time:datetimetomilliseconds': (a, s) => [...s(a[0]), ' as milliseconds since 1970'],
  'time:millisecondstodatetime': (a, s) => [...s(a[0]), ' (milliseconds) as a date'],
  'time:trimdate': (a, s) => [...s(a[0]), ' with the date part removed'],
  'time:trimtime': (a, s) => [...s(a[0]), ' with the time part removed'],
  'runtime:loadresource': (a) => [{ t: 'res', path: lit(a[0]) ?? '?', restricted: a[1]?.k === 'bool' && a[1].v === 'true' }],
  'runtime:conf': (a, s) => ['the Data Collector setting ', ...s(a[0])],
  'pipeline:name': 'the pipeline name', 'pipeline:title': 'the pipeline title', 'pipeline:id': 'the pipeline ID',
  'pipeline:user': 'the user who started the pipeline', 'pipeline:starttime': 'the time the pipeline started', 'pipeline:version': 'the pipeline version',
  'job:name': 'the job name', 'job:id': 'the job ID', 'sdc:hostname': 'the Data Collector host name', 'sdc:id': 'the Data Collector ID',
  user: 'the user running the pipeline', emptymap: 'an empty map', emptylist: 'an empty list', 'uuid:uuid': 'a new random ID',
  YYYY: 'year', YY: 'year', MM: 'month', DD: 'day', hh: 'hour', mm: 'minute', ss: 'second',
  'math:round': (a, s) => [...s(a[0]), ' rounded'], 'math:ceil': (a, s) => [...s(a[0]), ' rounded up'],
  'math:floor': (a, s) => [...s(a[0]), ' rounded down'], 'math:abs': (a, s) => ['the absolute value of ', ...s(a[0])],
  'math:max': (a, s) => ['the larger of ', ...s(a[0]), ' and ', ...s(a[1])], 'math:min': (a, s) => ['the smaller of ', ...s(a[0]), ' and ', ...s(a[1])],
  'base64:encodestring': (a, s) => [...s(a[0]), ' Base64-encoded'], 'base64:decodestring': (a, s) => [...s(a[0]), ' Base64-decoded'],
  sha1: (a, s) => [...s(a[0]), ' hashed with SHA-1'], sha256: (a, s) => [...s(a[0]), ' hashed with SHA-256'],
  sha512: (a, s) => [...s(a[0]), ' hashed with SHA-512'], md5: (a, s) => [...s(a[0]), ' hashed with MD5'],
};
EL_FN['runtime:loadresourceraw'] = EL_FN['runtime:loadresource'];

function sayCall(n, s) {
  const [a0, a1] = n.args;
  // the usual time-zone idiom: write the date out in one zone, read the text back as another
  if (isCall(n, 'time:createdatefromstringtz') && isCall(a0, 'time:extractstringfromdatetz')) {
    const [x, from] = a0.args;
    return [...s(x), ' with its ', ...s(from), ' clock time kept but treated as ', ...s(a1), ' time'];
  }
  const fn = EL_FN[n.name] ?? EL_FN[n.name.toLowerCase()];
  if (typeof fn === 'string') return [fn];
  if (fn) return fn(n.args, s);
  return [{ t: 'code', v: `${n.name}(` }, ...n.args.flatMap((x, i) => [i ? ', ' : '', ...s(x)]), { t: 'code', v: ')' }];
}

function sayEL(n, ctx) {
  const s = (x) => (x ? sayEL(x, ctx) : ['?']);
  switch (n.k) {
    case 'str': return [`“${n.v}”`];
    case 'num': return [n.v];
    case 'bool': return [n.v];
    case 'null': return ['nothing'];
    case 'id': {
      if (UNITS[n.v]) return [UNITS[n.v]];
      const param = paramOf(n.v, ctx);
      return [param.value !== null ? param : { t: 'code', v: n.v }];
    }
    case 'un':
      if (n.op === 'empty') return [...s(n.x), ' is empty'];
      return n.op === '!' ? ['not (', ...s(n.x), ')'] : ['-', ...s(n.x)];
    case 'tern': return ['if ', ...s(n.c), ' then ', ...s(n.a), ', otherwise ', ...s(n.b)];
    case 'idx': return [...s(n.x), '[', ...s(n.i), ']'];
    case 'call': return sayCall(n, s);
    case 'bin': {
      const { op, l, r } = n;
      if ((op === '==' || op === '!=') && (l.k === 'null' || r.k === 'null')) {
        const x = r.k === 'null' ? l : r;
        return [...(isCall(x, 'f:value') ? ['the field'] : s(x)), op === '==' ? ' is empty' : ' has a value'];
      }
      if ((op === '==' || op === '!=') && isCall(l, 'f:type', 'record:type') && lit(r) != null) {
        const what = isCall(l, 'f:type') ? ['the field'] : fieldOf(l.args[0], s);
        return [...what, op === '==' ? ' is ' : ' is not ', TYPE_WORDS[lit(r).toUpperCase()] || `“${lit(r)}”`];
      }
      if (op === '*' && l.k === 'num' && r.k === 'id' && UNITS[r.v]) return [`${l.v} ${UNITS[r.v]}`];
      return [...s(l), OP_WORDS[op] || ` ${op} `, ...s(r)];
    }
    default: return ['?'];
  }
}

/** StreamSets expression language -> words. If it can't be parsed it is shown exactly as written. */
export function explainEL(expr, ctx) {
  const tokens = elTokens(String(expr));
  const tree = tokens && elParse(tokens);
  return tree ? sayEL(tree, ctx) : [{ t: 'code', v: String(expr) }];
}

/** Field path expressions (Field Replacer, Field Remover...): /NAME, /*, /**, *[${f:type() == 'DATE'}]. */
export function fieldSelector(path, ctx) {
  const p = String(path ?? '').trim();
  const m = p.match(/^\/?(\*\*?)\[\s*\$\{([\s\S]+)\}\s*\]$/);
  if (m) return [m[1] === '**' ? 'every field at any depth where ' : 'every field where ', ...explainEL(m[2], ctx)];
  if (p === '/*' || p === '*') return ['every top-level field'];
  if (p === '/**' || p === '**') return ['every field, at any depth'];
  if (p.includes('*') || p.includes('${')) return ['the fields matching ', { t: 'code', v: p }];
  return [F(p)];
}

/** Text with ${...} in it: parameters become value chips, expressions become words. Quotes and nested
 *  braces inside an expression are respected, so "${str:concat('}', x)}" is still one expression. */
export function tmpl(value, ctx) {
  const s = String(value ?? '');
  const out = [];
  let last = 0;
  let at = s.indexOf('${');
  while (at !== -1) {
    let depth = 0;
    let quote = null;
    let j = at + 2;
    for (; j < s.length; j += 1) {
      const c = s[j];
      if (quote) {
        if (c === '\\') j += 1;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '{') depth += 1;
      else if (c === '}') { if (!depth) break; depth -= 1; }
    }
    if (j >= s.length) break;   // never closed - the rest stays plain text
    if (at > last) out.push(s.slice(last, at));
    const raw = s.slice(at, j + 1);
    const inner = s.slice(at + 2, j).trim();
    out.push(/^[A-Za-z_][\w.]*$/.test(inner) ? paramOf(inner, ctx) : { t: 'el', raw, c: explainEL(inner, ctx) });
    last = j + 1;
    at = s.indexOf('${', last);
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** Segments -> plain text, for tooltips and search. */
export function textOf(segs) {
  return [].concat(segs || []).map(x => {
    if (x == null || x === false) return '';
    if (typeof x === 'string' || typeof x === 'number') return String(x);
    if (Array.isArray(x)) return textOf(x);
    if (x.t === 'f') return x.v.replace(/^\//, '').replace(/\//g, ' › ');
    if (x.t === 'p') return x.c ? textOf(x.c) : x.value === null ? `${x.name} (set at runtime)` : x.value === MASK ? 'hidden' : x.value === '' ? `${x.name} (empty)` : x.value;
    if (x.t === 'code') return x.v;
    if (x.t === 'res') return `the file ${x.path}`;
    return textOf(x.c);
  }).join('');
}

const resolvePlain = (value, ctx) => String(value ?? '').replace(/\$\{([A-Za-z_][\w.]*)\}/g, (m, ref) => paramOf(ref, ctx).value ?? m);

/** jdbc:oracle:thin:@//host:1521/SVC, jdbc:sqlserver://host:1433;databaseName=DB ... -> { host, port, db } */
export function jdbcParts(url) {
  const m = String(url).match(/\/\/([^:/;?]+)(?::(\d+))?(?:[/;](?:databaseName=|DATABASE=)?([\w.-]+))?/i);
  return m ? { host: m[1], port: m[2], db: m[3] } : {};
}

const B = (...c) => ({ t: 'b', c: c.flat() });
const F = (v) => ({ t: 'f', v: String(v) });
const andList = (items) => {
  const list = items.filter(x => x != null && x !== '' && !(Array.isArray(x) && !x.length));
  return list.flatMap((x, i) => [i === 0 ? '' : i === list.length - 1 ? ' and ' : ', ', x]).filter(x => x !== '');
};
const fieldsOf = (arr) => andList([].concat(arr ?? []).map(F));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * What a stage does, in words: { lead: segs, points: [segs], steps?, summary? }.
 * Unknown stage types get a generic line - their settings are still all listed.
 */
export function describe(stage, ctx) {
  if (stage.fragment) return describeFragment(stage, ctx);
  const s = stage;
  const get = (k) => {
    const c = s.config.find(x => x.name === k || x.name.endsWith(`.${k}`));
    if (!c) return undefined;
    return c.secret ? MASK : parseVal(c.value);
  };
  const T = (v) => tmpl(v, ctx);
  const name = (inst) => B(ctx.siblings.find(y => y.instance === inst)?.label || inst);
  const kind = `${s.type_name}${s.stage_name}`.toLowerCase().replace(/[\s_]/g, '');
  const has = (k) => kind.includes(k);
  const secretNote = s.config.some(c => c.secret) ? ['Its password / keys are stored as secrets in StreamSets and not shown here.'] : null;
  const signIn = (where) => {
    const u = get('username') ?? get('user');
    return u === undefined ? null : ['Signs in', ...(where ? [' to ', ...where] : []), ' as ', B(T(u)), '.'];
  };
  const fmt = () => { const f = get('dataFormat'); return f ? `${ENUM[f] || f} ` : ''; };
  const out = (lead, points = []) => ({ lead, points: points.filter(p => p && (!Array.isArray(p) || p.length)) });
  const preconditions = [].concat(get('stageRecordPreconditions') ?? get('preconditions') ?? []);

  if (s.kind === 'SOURCE') {
    if (get('connectionString') !== undefined) {
      const db = jdbcParts(resolvePlain(get('connectionString'), ctx));
      const where = [' in the ', s.technology, ' database', ...(db.db ? [' ', B(db.db)] : []), ...(db.host ? [' on ', B(db.host + (db.port ? `:${db.port}` : ''))] : []), '.'];
      const tables = [].concat(get('tableConfigs') || []);
      const points = [];
      tables.forEach(t => {
        if (!t || !(t.offsetColumns || []).length) return;
        const init = (t.offsetColumnToInitialOffsetValue || [])[0];
        const ref = init && String(init.value).match(/\$\{([A-Za-z_][\w.]*)\}/);
        const first = !init ? [] : resolvePlain(init.value, ctx)
          ? [' The very first run starts from ', ...T(init.value), '.']
          : [' On the very first run it reads everything, because ', ...(ref ? ['the parameter ', B(paramOf(ref[1], ctx).name)] : ['the starting value']), ' is empty.'];
        points.push([B('Incremental load:'), ' each run only picks up rows whose ', ...fieldsOf(t.offsetColumns), ' is newer than the last row it read.', ...first]);
      });
      const b = get('maxBatchSize'); if (b !== undefined) points.push(['Reads up to ', B(T(b)), ' rows at a time.']);
      const q = get('queryInterval'); if (q !== undefined) points.push(['Waits ', B(T(q)), ' between queries.']);
      const lead = get('query') !== undefined
        ? ['Runs a SQL query', ...where, ' The query is in the settings below.']
        : [has('cdc') ? 'Captures every insert, update and delete made to ' : 'Reads rows from ',
          ...(tables.length ? andList(tables.map(t => B(T(t.schema ? `${t.schema}.${t.tablePattern}` : t.tablePattern)))) : ['its tables']), ...where];
      return out(lead, [...points, signIn(), secretNote]);
    }
    if (get('brokerURI') !== undefined) {
      const topics = [].concat(get('topicList') ?? get('topic') ?? []);
      const g = get('consumerGroup');
      return out([`Listens to the Kafka topic${topics.length > 1 ? 's' : ''} `, ...andList(topics.map(t => B(T(t)))), ` and turns every ${fmt()}message into a record. It keeps running - it never finishes on its own.`],
        [['Connects to the brokers ', B(T(get('brokerURI'))), '.'], g !== undefined && ['Reads as consumer group ', B(T(g)), ' - pipelines in the same group share the messages between them.'], secretNote]);
    }
    if (get('soqlQuery') !== undefined) {
      const soql = String(get('soqlQuery'));
      const m = soql.match(/SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)/i);
      const w = soql.match(/WHERE\s+(\w+)\s*>\s*\$\{OFFSET\}/i);
      const ep = get('authEndpoint');
      return out(['Queries the ', ...(m ? [B(m[2]), ' '] : []), 'object in Salesforce.'],
        [m && ['Brings back ', ...fieldsOf(m[1].split(',').map(x => x.trim())), '.'], w && [B('Incremental load:'), ' only records whose ', F(w[1]), ' changed since the last run.'],
          signIn(ep !== undefined ? [B(T(ep))] : null), secretNote]);
    }
    if (get('bucket') !== undefined) {
      const pat = get('prefixPattern');
      return out([`Picks up ${fmt()}files`, ...(pat ? [' matching ', B(T(pat))] : []), ' from the S3 bucket ', B(T(get('bucket'))), '.'], [secretNote]);
    }
    if (get('remoteAddress') !== undefined) {
      const pat = get('filePattern');
      return out([`Downloads ${fmt()}files`, ...(pat ? [' matching ', B(T(pat))] : []), ' from ', B(T(get('remoteAddress'))), '.'], [secretNote]);
    }
    if (get('resourceUrl') !== undefined) {
      const a = get('authType'), p = get('mode');
      return out(['Calls ', B(get('httpMethod') || 'GET'), ' ', B(T(get('resourceUrl'))), ' and turns each response into records.'],
        [a && ['Signs in with ', B(ENUM[a] || a), '.'], p && [`Paging: ${(ENUM[p] || p).toLowerCase()}.`], secretNote]);
    }
    return out(['Reads data from ', s.technology, ' using the ', B(s.type_name), ' origin.'], [secretNote]);
  }

  if (has('fieldtypeconverter')) {
    const conv = [].concat(get('fieldTypeConverterConfigs') || []);
    const count = conv.reduce((n, c) => n + [].concat(c.fields || []).length, 0);
    return out([`Changes the data type of ${plural(count, 'field', 'fields')}.`],
      conv.map(c => [...fieldsOf(c.fields), [].concat(c.fields || []).length > 1 ? ' become ' : ' becomes ', B(ENUM[c.targetType] || c.targetType || '?'),
        ...(c.scale !== undefined && c.scale !== null ? [` with ${c.scale} decimal places`] : []),
        ...(c.dateFormat && !/^OTHER$/i.test(c.dateFormat) ? [', read using the pattern ', { t: 'code', v: String(c.dateFormat) }] : []), '.']));
  }
  if (has('expression')) {
    const ex = [].concat(get('expressionProcessorConfigs') || []);
    return out([`Fills in ${plural(ex.length, 'field', 'fields')} on every record.`], ex.map(e => [F(e.fieldToSet), ' ← ', ...T(e.expression)]));
  }
  if (has('fieldremover')) {
    return get('filterOperation') === 'KEEP'
      ? out(['Keeps only ', ...fieldsOf(get('fields')), ' and drops every other field.'])
      : out(['Removes ', ...fieldsOf(get('fields')), ' from every record.']);
  }
  if (has('jython') || has('groovy') || has('javascript')) {
    const code = String(get('script') ?? '');
    const lines = code ? code.split('\n').length : 0;
    const wrote = [...new Set([...code.matchAll(/\[["']([A-Za-z_]\w*)["']\]\s*=(?!=)/g)].map(m => m[1]))];
    const read = [...new Set([...code.matchAll(/\[["']([A-Za-z_]\w*)["']\]|\.get\(["']([A-Za-z_]\w*)["']/g)].map(m => m[1] || m[2]))].filter(f => !wrote.includes(f));
    return out([`Runs a custom ${s.technology} script (${plural(lines, 'line', 'lines')}) on every batch of records.`],
      [wrote.length && ['Sets or changes ', ...fieldsOf(wrote), '.'], read.length && ['Reads ', ...fieldsOf(read), '.'],
        /error\.write/.test(code) && ['Records that fail inside the script go to the error stream instead of stopping the pipeline.'],
        ['The full script is in the settings below.']]);
  }
  if (has('deduplicator')) {
    const secs = Number(resolvePlain(get('timeWindowSecs'), ctx)) || 0;
    const cmp = [].concat(get('fieldsToCompare') || []);
    return out(['Drops duplicate records, so each one is only loaded once.'],
      [get('compareFields') === 'ALL_FIELDS' ? ['Two records count as duplicates when every field matches.'] : ['Two records count as duplicates when ', ...fieldsOf(cmp), cmp.length === 1 ? ' matches.' : cmp.length === 2 ? ' both match.' : ' all match.'],
        [secs ? `Remembers records for ${secs} seconds.` : 'Remembers every record for the whole run.']]);
  }
  if (has('fieldrenamer')) {
    const maps = [].concat(get('renameMapping') || []);
    const miss = get('nonExistingFromFieldHandling');
    return out([`Renames ${plural(maps.length, 'field', 'fields')}.`],
      [...maps.map(m => [F(m.fromFieldExpression), ' → ', F(m.toFieldExpression)]), miss && [`If a field isn't there: ${(ENUM[miss] || miss).toLowerCase()}.`]]);
  }
  if (has('fieldflattener')) {
    const sep = get('nameSeparator') || '.';
    return out([`Flattens nested fields into one level, joining the names with “${sep}” - for example `, F('/address/city'), ' becomes ', F(`address${sep}city`), '.']);
  }
  if (has('selector')) {
    const preds = [].concat(get('lanePredicates') || []);
    // routes (lane -> stages) come from the backend; without them the lane name is shown rather than a guess
    const to = (lane) => (s.routes || []).find(r => r.lane === lane)?.to || null;
    return out([`Splits records into ${plural(preds.length, 'route', 'routes')}. Each record goes down the first route whose condition it meets.`],
      preds.map(p => [...(p.predicate === 'default' ? ['Everything else'] : ['Records where ', ...T(p.predicate)]), ' → ',
        ...(to(p.outputLane) ? andList(to(p.outputLane).map(name)) : [{ t: 'code', v: String(p.outputLane) }])]));
  }
  if (has('fieldhasher')) {
    const h = [].concat(get('inPlaceFieldHasherConfigs') || []);
    return out(["Replaces personal data with a one-way hash, so it can't be read but can still be matched."],
      h.map(c => [...fieldsOf(c.sourceFieldsToHash), ' → ', B(ENUM[c.hashType] || c.hashType || '?'), ' hash']));
  }
  if (has('fieldreplacer')) {
    const rules = [].concat(get('rules') || []);
    return out([`Changes field values using ${plural(rules.length, 'rule', 'rules')}.`],
      rules.map(r => {
        const which = andList([].concat(r.fields ?? []).map(f => (/[*$]/.test(String(f)) ? { t: 'el', raw: String(f), c: fieldSelector(f, ctx) } : F(f))));
        return r.setToNull ? ['Empties ', ...which, ' (sets it to null).'] : ['For ', ...which, ': sets it to ', ...T(r.replacement), '.'];
      }));
  }
  if (has('filter') && get('predicate') !== undefined) {
    return out(['Only lets through records where ', ...T(get('predicate')), '. The rest are dropped.']);
  }

  if (s.kind === 'TARGET') {
    if (s.technology === 'Snowflake') {
      const parts = [get('database'), get('schema'), get('table')].filter(v => v !== undefined);
      const m = get('mergeCdc'), loc = get('location'), wh = get('warehouse'), acct = get('account');
      return out(parts.length ? ['Loads records into the Snowflake table ', B(T(parts.join('.'))), '.'] : ['Loads records into Snowflake.'],
        [(wh !== undefined || acct !== undefined) && ['Runs', ...(wh !== undefined ? [' on warehouse ', B(T(wh))] : []), ...(acct !== undefined ? [' in account ', B(T(acct))] : []), '.'],
          signIn(), m !== undefined && [m ? 'Applies inserts, updates and deletes to rows already in the table (merge).' : 'Adds new rows - rows already in the table are never changed.'],
          loc && [`Stages the data in ${ENUM[loc] || loc} before loading.`], secretNote]);
    }
    if (get('bucket') !== undefined) {
      const pt = get('partitionTemplate');
      return out([`Writes ${fmt()}files to the S3 bucket `, B(T(get('bucket'))), ...(pt ? [', in folders named ', B(T(pt))] : []), '.'], [secretNote]);
    }
    if (has('trash') || has('devnull') || s.technology === 'Trash') return out(['Throws the records away.']);
    return out(['Writes records to ', s.technology, ' using the ', B(s.type_name), ' destination.'], [secretNote]);
  }

  if (has('finisher')) {
    return out(['Stops the pipeline once ', ...(andList(s.triggered_by.map(name)).length ? andList(s.triggered_by.map(name)) : ['a stage']), ' reports it has read everything.'],
      [...preconditions.map(p => ['Only reacts when ', ...T(p), '.']),
        [get('resetOffset') ? 'Starts from scratch on the next run.' : 'Remembers where it stopped, so the next run carries on from there.'],
        ['This is what lets the job run on a schedule instead of running forever.']]);
  }
  if (has('email')) {
    const mails = [].concat(get('email') || []).filter(e => e && typeof e === 'object');
    return out(['Sends an email each time ', ...(andList(s.triggered_by.map(name)).length ? andList(s.triggered_by.map(name)) : ['a stage']), ' reports an event.'],
      mails.map(e => ['To ', ...T(e.email), ', subject “', ...T(e.subject), '”', ...(e.body ? [', message “', ...T(e.body), '”'] : []), '.']));
  }
  return out([`${(KIND[s.kind] || KIND.PROCESSOR).label} step using `, B(s.type_name || s.stage_name), s.technology && s.technology !== 'StreamSets' ? ` (${s.technology})` : '', '.'],
    [[`There's no plain-English summary for this stage type yet - all ${plural(s.config.length, 'setting', 'settings')} are listed below.`]]);
}

function describeFragment(stage, ctx) {
  const f = stage.fragment;
  const name = (inst) => B(ctx.siblings.find(y => y.instance === inst)?.label || inst);
  const from = andList(stage.upstream.map(name));
  const to = andList(stage.downstream.map(name));
  const inner = { ...ctx, prefix: f.prefix || '', siblings: f.stages || [] };
  const used = new Map();
  flattenStages(f.stages).forEach(({ stage: x }) => x.config.forEach(c => c.params.forEach(p => used.set(p.name, p))));
  return {
    lead: ['A shared building block that pipelines reuse - ', B(f.name), f.version ? `, version ${f.version}. ` : '. ',
      ...(f.error ? ["StreamSets didn't send what's inside it, so its steps can't be shown."]
        : ['Records ', ...(from.length ? ['coming from ', ...from, ' '] : []), `go through its ${plural(f.stages.length, 'step', 'steps')} in order`,
          ...(to.length ? [', then carry on to ', ...to] : []), '.'])],
    points: [used.size ? ['Uses ', ...andList([...used.values()].map(p => ({ t: 'p', name: p.name, value: p.value })))] : null,
      f.prefix ? ['Its parameters start with ', B(f.prefix), " in this pipeline, so they don't clash with the pipeline's own."] : null].filter(Boolean),
    steps: f.error ? null : f.stages.map(x => ({ stage: x, ...describe(x, inner) })),
    summary: f.error ? "Couldn't load its steps" : `${plural(f.stages.length, 'step', 'steps')}: ${f.stages.map(x => x.label).join(' → ')}`,
  };
}

/** One line per stage (path -> text) for tooltips, cards and search - built once per pipeline. */
export function stageSummaries(detail) {
  const map = new Map();
  flattenStages(detail.stages).forEach(({ stage, path }) => {
    const d = describe(stage, stageCtx(detail, path));
    map.set(path, stage.fragment ? `${textOf(d.lead)} ${d.summary}.` : textOf(d.lead));
  });
  return map;
}