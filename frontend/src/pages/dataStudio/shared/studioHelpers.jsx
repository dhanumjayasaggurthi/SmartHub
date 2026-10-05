// Constants and pure helpers shared by the Data Studio panes. Kept out of the
// component file so React Fast Refresh can do its job there.

import { apiFetch } from '../../../utils/apiClient';

const PAGE_SIZE_OPTIONS = [50, 100, 250, 500, 1000];
const DEFAULT_COL_WIDTH = 170;
const MIN_COL_WIDTH = 60;
const MAX_COL_WIDTH = 720;

const EXPORT_FORMATS = [
  { id: 'csv', label: 'CSV' },
  { id: 'tsv', label: 'TSV' },
  { id: 'json', label: 'JSON' },
  { id: 'xlsx', label: 'Excel' },
  { id: 'sql', label: 'SQL inserts' },
];

const FILTER_OPS = [
  { id: 'contains', label: 'contains', needsValue: true },
  { id: 'not_contains', label: 'does not contain', needsValue: true },
  { id: 'eq', label: '=', needsValue: true },
  { id: 'neq', label: '≠', needsValue: true },
  { id: 'starts', label: 'starts with', needsValue: true },
  { id: 'ends', label: 'ends with', needsValue: true },
  { id: 'gt', label: '>', needsValue: true },
  { id: 'gte', label: '≥', needsValue: true },
  { id: 'lt', label: '<', needsValue: true },
  { id: 'lte', label: '≤', needsValue: true },
  { id: 'in', label: 'in list', needsValue: true },
  { id: 'not_in', label: 'not in list', needsValue: true },
  { id: 'is_null', label: 'is null', needsValue: false },
  { id: 'is_not_null', label: 'is not null', needsValue: false },
];

// Leading keyword that means the statement mutates something. Purely a
// client-side hint (button colour, banner) so the UI feels instant; the
// backend re-classifies and is the actual authority.
const DESTRUCTIVE_HINT_RE = /^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|CALL|COMMENT|COPY|PUT|REMOVE|UNDROP|EXECUTE|USE|SET|UNSET)\b/i;

function leadKeywordHint(sql) {
  const match = DESTRUCTIVE_HINT_RE.exec(sql || '');
  if (!match) return null;
  if (/^\s*ALTER\s+SESSION\b/i.test(sql)) return 'ALTER SESSION';
  return match[1].toUpperCase();
}

async function fetchJson(url, opts) {
  const res = await apiFetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const detail = body && body.detail;
    const message = (typeof detail === 'string' ? detail : detail?.message) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// VARIANT / OBJECT / ARRAY columns come back as real objects, and String(v) on
// those gives "[object Object]". Render them as compact JSON, the way the
// Snowflake worksheet and DBeaver both do.
function cellText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

function formatBytes(n) {
  if (n == null) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let val = n, i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i += 1; }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatCount(n) {
  if (n == null) return '';
  if (n >= 1e9) return `~${(n / 1e9).toFixed(1)}B rows`;
  if (n >= 1e6) return `~${(n / 1e6).toFixed(1)}M rows`;
  if (n >= 1e3) return `~${(n / 1e3).toFixed(1)}K rows`;
  return `~${n} row${n === 1 ? '' : 's'}`;
}

function formatWhen(iso) {
  if (!iso) return '';
  const then = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
  if (Number.isNaN(then.getTime())) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return then.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// SQL autocomplete: keywords, Snowflake functions, and dot-aware live object
// names (database -> schema -> table -> column) pulled from the explorer API.
// ---------------------------------------------------------------------------

const SF_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'QUALIFY',
  'WITH', 'AS', 'ON', 'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'ILIKE',
  'RLIKE', 'BETWEEN', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC',
  'NULLS FIRST', 'NULLS LAST', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
  'FULL OUTER JOIN', 'CROSS JOIN', 'LATERAL', 'UNION ALL', 'UNION', 'INTERSECT', 'EXCEPT',
  'OVER', 'PARTITION BY', 'EXISTS', 'ANY', 'ALL', 'PIVOT', 'UNPIVOT', 'SAMPLE',
  'INSERT INTO', 'UPDATE', 'DELETE FROM', 'MERGE INTO', 'USING', 'MATCHED', 'VALUES', 'SET',
  'CREATE TABLE', 'CREATE OR REPLACE TABLE', 'CREATE VIEW', 'ALTER TABLE', 'DROP TABLE',
  'TRUNCATE TABLE', 'EXPLAIN', 'DESCRIBE TABLE', 'SHOW TABLES', 'COPY INTO', 'AT', 'BEFORE',
  'CHANGES', 'FLATTEN', 'CLUSTER BY',
];

const SF_FUNCTIONS = [
  'COUNT(', 'SUM(', 'AVG(', 'MIN(', 'MAX(', 'MEDIAN(', 'MODE(', 'STDDEV(', 'VARIANCE(',
  'COALESCE(', 'NVL(', 'NULLIF(', 'IFF(', 'DECODE(', 'CAST(', 'TRY_CAST(',
  'TO_DATE(', 'TRY_TO_DATE(', 'TO_CHAR(', 'TO_NUMBER(', 'TRY_TO_NUMBER(', 'TO_TIMESTAMP(',
  'TO_TIMESTAMP_NTZ(', 'DATE_TRUNC(', 'DATEADD(', 'DATEDIFF(', 'CURRENT_DATE()',
  'CURRENT_TIMESTAMP()', 'CURRENT_USER()', 'CURRENT_ROLE()', 'CURRENT_WAREHOUSE()',
  'ROW_NUMBER() OVER (', 'RANK() OVER (', 'DENSE_RANK() OVER (', 'LAG(', 'LEAD(',
  'FIRST_VALUE(', 'LAST_VALUE(', 'NTILE(', 'LISTAGG(', 'ARRAY_AGG(', 'OBJECT_CONSTRUCT(',
  'PARSE_JSON(', 'TO_VARIANT(', 'TO_JSON(', 'FLATTEN(', 'GET_PATH(', 'ARRAY_SIZE(',
  'TRIM(', 'LTRIM(', 'RTRIM(', 'UPPER(', 'LOWER(', 'INITCAP(', 'LENGTH(', 'SUBSTRING(',
  'SPLIT_PART(', 'REPLACE(', 'CONCAT(', 'CONCAT_WS(', 'REGEXP_REPLACE(', 'REGEXP_SUBSTR(',
  'REGEXP_LIKE(', 'HASH(', 'MD5(', 'SHA2(', 'UUID_STRING()', 'ZEROIFNULL(', 'EQUAL_NULL(',
  'RESULT_SCAN(', 'GET_DDL(',
];

const STATIC_SUGGESTIONS = [
  ...SF_KEYWORDS.map(text => ({ text, kind: 'keyword' })),
  ...SF_FUNCTIONS.map(text => ({ text, kind: 'function' })),
];

// ---------------------------------------------------------------------------
// Syntax highlighting
// ---------------------------------------------------------------------------

// Single words only - the multi-word entries in SF_KEYWORDS are for the
// completion list, and a tokenizer works one word at a time.
const KEYWORD_SET = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'BY', 'HAVING', 'LIMIT', 'OFFSET', 'QUALIFY',
  'WITH', 'AS', 'ON', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'RLIKE',
  'BETWEEN', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC', 'NULLS',
  'FIRST', 'LAST', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'LATERAL',
  'UNION', 'ALL', 'INTERSECT', 'EXCEPT', 'MINUS', 'OVER', 'PARTITION', 'EXISTS', 'ANY',
  'PIVOT', 'UNPIVOT', 'SAMPLE', 'TABLESAMPLE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET',
  'DELETE', 'MERGE', 'USING', 'MATCHED', 'TRUNCATE', 'CREATE', 'REPLACE', 'ALTER', 'DROP',
  'TABLE', 'VIEW', 'SCHEMA', 'DATABASE', 'WAREHOUSE', 'STAGE', 'STREAM', 'TASK', 'SEQUENCE',
  'FUNCTION', 'PROCEDURE', 'TRANSIENT', 'TEMPORARY', 'TEMP', 'IF', 'EXPLAIN', 'DESCRIBE',
  'DESC_TABLE', 'SHOW', 'GRANT', 'REVOKE', 'TO', 'PRIMARY', 'FOREIGN', 'KEY', 'UNIQUE',
  'REFERENCES', 'CONSTRAINT', 'DEFAULT', 'CLUSTER', 'COPY', 'PUT', 'GET', 'LIST', 'REMOVE',
  'UNDROP', 'CALL', 'BEGIN', 'COMMIT', 'ROLLBACK', 'USE', 'ROLE', 'AT', 'BEFORE', 'CHANGES',
  'CONNECT', 'RECURSIVE', 'FLATTEN', 'RETURNS', 'LANGUAGE', 'COMMENT', 'EXECUTE', 'IMMEDIATE',
  'TRUE', 'FALSE', 'ILIKE_ANY', 'ELSEIF', 'FOR', 'WHILE', 'LOOP', 'CASCADE', 'RESTRICT',
]);

const TYPE_SET = new Set([
  'NUMBER', 'DECIMAL', 'NUMERIC', 'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT',
  'BYTEINT', 'FLOAT', 'FLOAT4', 'FLOAT8', 'DOUBLE', 'REAL', 'VARCHAR', 'CHAR', 'CHARACTER',
  'STRING', 'TEXT', 'BINARY', 'VARBINARY', 'BOOLEAN', 'DATE', 'DATETIME', 'TIME',
  'TIMESTAMP', 'TIMESTAMP_LTZ', 'TIMESTAMP_NTZ', 'TIMESTAMP_TZ', 'VARIANT', 'OBJECT',
  'ARRAY', 'GEOGRAPHY', 'GEOMETRY', 'VECTOR',
]);

const FUNCTION_NAMES = new Set(SF_FUNCTIONS.map(f => f.replace(/\($/, '').replace(/\(.*$/, '')));

const WORD_CHAR = /[A-Za-z0-9_$]/;

/**
 * Splits SQL into coloured tokens. Deliberately a lexer and not a parser -
 * it only needs to know what each run of characters *is*, and it has to keep
 * working while the person is mid-keystroke and the SQL is invalid.
 *
 * Returns [{ text, kind }] where kind is one of: comment, string, dollar,
 * quoted, number, keyword, type, function, operator, punct, plain.
 */
function tokenizeSql(text) {
  const tokens = [];
  const push = (kind, value) => {
    if (!value) return;
    const previous = tokens[tokens.length - 1];
    if (previous && previous.kind === kind) previous.text += value;
    else tokens.push({ kind, text: value });
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '-' && next === '-') {
      let j = i;
      while (j < n && text[j] !== '\n') j += 1;
      push('comment', text.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      let j = i + 2;
      let depth = 1;
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') { depth += 1; j += 2; continue; }
        if (text[j] === '*' && text[j + 1] === '/') { depth -= 1; j += 2; continue; }
        j += 1;
      }
      push('comment', text.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '$' && next === '$') {
      const close = text.indexOf('$$', i + 2);
      const j = close === -1 ? n : close + 2;
      push('dollar', text.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === "'") { if (text[j + 1] === "'") { j += 2; continue; } j += 1; break; }
        j += 1;
      }
      push('string', text.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '"') { if (text[j + 1] === '"') { j += 2; continue; } j += 1; break; }
        j += 1;
      }
      push('quoted', text.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next || ''))) {
      let j = i;
      while (j < n && /[0-9.eE]/.test(text[j])) {
        if ((text[j] === 'e' || text[j] === 'E') && /[+-]/.test(text[j + 1] || '')) j += 1;
        j += 1;
      }
      push('number', text.slice(i, j));
      i = j;
      continue;
    }
    if (WORD_CHAR.test(ch) && !/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && WORD_CHAR.test(text[j])) j += 1;
      const word = text.slice(i, j);
      const upper = word.toUpperCase();
      // A word immediately followed by "(" reads as a call, whatever it is.
      let k = j;
      while (k < n && /\s/.test(text[k])) k += 1;
      if (FUNCTION_NAMES.has(upper) || (text[k] === '(' && !KEYWORD_SET.has(upper))) push('function', word);
      else if (KEYWORD_SET.has(upper)) push('keyword', word);
      else if (TYPE_SET.has(upper)) push('type', word);
      else push('plain', word);
      i = j;
      continue;
    }
    if ('+-*/%=<>!|&~^'.includes(ch)) { push('operator', ch); i += 1; continue; }
    if ('(),;.[]{}'.includes(ch)) { push('punct', ch); i += 1; continue; }
    push('plain', ch);
    i += 1;
  }
  return tokens;
}

const TOKEN_COLORS = {
  dark: {
    comment: '#8a827d', string: '#9ee493', dollar: '#9ee493', quoted: '#d7b7ff',
    number: '#ffd479', keyword: '#7fd6ff', type: '#6ee7c7', function: '#ffb26b',
    operator: '#cfc9c5', punct: '#a9a29d', plain: 'rgba(255,255,255,0.92)',
  },
  light: {
    comment: '#8c827c', string: '#1a7f37', dollar: '#1a7f37', quoted: '#6b3fa0',
    number: '#8a5a00', keyword: '#0f68b2', type: '#0a7c66', function: '#b45309',
    operator: '#57534e', punct: '#78716c', plain: '#312c2a',
  },
};

// ---------------------------------------------------------------------------
// Query-aware completion
// ---------------------------------------------------------------------------

const ALIAS_STOP_WORDS = new Set([
  'ON', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'JOIN', 'LEFT', 'RIGHT', 'INNER',
  'FULL', 'CROSS', 'OUTER', 'UNION', 'INTERSECT', 'EXCEPT', 'QUALIFY', 'SET', 'VALUES',
  'USING', 'WHEN', 'AND', 'OR', 'SELECT', 'FROM', 'AS', 'LATERAL', 'SAMPLE', 'PIVOT',
  'UNPIVOT', 'AT', 'BEFORE', 'CHANGES', 'WITH',
]);

// The alias group refuses to match a keyword. Without that guard,
// "FROM A JOIN B" swallows JOIN as A's alias and B is never seen at all.
const REF_RE = new RegExp(
  '\\b(?:FROM|JOIN|INTO|UPDATE|MERGE\\s+INTO|TABLE)\\s+' +
  '((?:"[^"]*"|[A-Za-z_][A-Za-z0-9_$]*)(?:\\s*\\.\\s*(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_$]*)){0,2})' +
  '(?:\\s+(?:AS\\s+)?(?!(?:' + [...ALIAS_STOP_WORDS].join('|') + ')\\b)("[^"]*"|[A-Za-z_][A-Za-z0-9_$]*))?',
  'gi',
);

const unquote = (part) => part.trim().replace(/^"|"$/g, '').replace(/""/g, '"');

/**
 * Every table the statement already mentions, with its alias if it has one.
 * This is what lets "c." offer that table's columns, and what lets a bare word
 * in the SELECT list be completed against the columns actually in scope -
 * without the person typing the full database.schema.table path first.
 */
function parseTableRefs(sql) {
  const refs = [];
  const seen = new Set();
  let match;
  REF_RE.lastIndex = 0;
  while ((match = REF_RE.exec(sql)) !== null) {
    const parts = match[1].split('.').map(unquote).filter(Boolean);
    if (!parts.length) continue;
    let alias = match[2] ? unquote(match[2]) : null;
    if (alias && ALIAS_STOP_WORDS.has(alias.toUpperCase())) alias = null;
    const key = parts.join('.').toLowerCase() + '|' + (alias || '');
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ parts, alias, table: parts[parts.length - 1] });
  }
  return refs;
}

/** The ref an alias or bare table name points at, if the query has one. */
function resolveRef(refs, name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  return refs.find(r => (r.alias || '').toLowerCase() === lower)
    || refs.find(r => r.table.toLowerCase() === lower)
    || null;
}

// What the person is most likely reaching for, judged by the last keyword
// before the caret.
function clauseAtCaret(sql, caret) {
  const before = sql.slice(0, caret).toUpperCase();
  const match = before.match(/\b(SELECT|FROM|JOIN|WHERE|ON|GROUP\s+BY|ORDER\s+BY|HAVING|QUALIFY|SET|INTO|VALUES|USING|UPDATE|DELETE|WITH)\b(?![\s\S]*\b(?:SELECT|FROM|JOIN|WHERE|ON|GROUP\s+BY|ORDER\s+BY|HAVING|QUALIFY|SET|INTO|VALUES|USING|UPDATE|DELETE|WITH)\b)/);
  if (!match) return null;
  return match[1].replace(/\s+/g, ' ');
}

const KIND_WEIGHT = {
  column: 0, table: 1, view: 1, schema: 2, database: 3, function: 4, keyword: 5,
};

/**
 * Orders candidates by how well they match what's been typed, then by how
 * useful the kind is in this clause. A prefix match always beats a match in
 * the middle of a name, and a word-boundary match (ORDER_ID for "id") beats an
 * arbitrary substring.
 */
function rankSuggestions(items, word, clause) {
  const lower = (word || '').toLowerCase();
  const boosted = new Set();
  if (clause === 'FROM' || clause === 'JOIN' || clause === 'INTO' || clause === 'UPDATE') {
    boosted.add('table'); boosted.add('view'); boosted.add('schema'); boosted.add('database');
  } else if (clause) {
    boosted.add('column'); boosted.add('function');
  }

  const scored = [];
  for (const item of items) {
    const text = item.text.toLowerCase();
    let rank;
    if (!lower) rank = 1;
    else if (text.startsWith(lower)) rank = 0;
    else if (text.split(/[_$.\s]/).some(part => part.startsWith(lower))) rank = 1;
    else if (text.includes(lower)) rank = 2;
    else continue;
    const kindWeight = (KIND_WEIGHT[item.kind] ?? 6) - (boosted.has(item.kind) ? 4 : 0);
    scored.push({ item, rank, kindWeight });
  }

  scored.sort((a, b) =>
    a.rank - b.rank
    || a.kindWeight - b.kindWeight
    || a.item.text.length - b.item.text.length
    || a.item.text.localeCompare(b.item.text));
  return scored.map(s => s.item);
}


// The word being typed at the caret: [start, caret) plus its dotted context.
// For "MY_DB.MY_SCHEMA.CUST|" this returns word "CUST" with context
// ["MY_DB", "MY_SCHEMA"], which is what tells the dropdown to offer tables.
function sqlTokenAtCaret(text, caret) {
  let start = caret;
  while (start > 0 && /[A-Za-z0-9_$"]/.test(text[start - 1])) start -= 1;
  const word = text.slice(start, caret).replace(/"/g, '');
  const context = [];
  let i = start;
  while (i > 0 && text[i - 1] === '.') {
    let j = i - 1;
    if (text[j - 1] === '"') {
      // A quoted identifier can contain dots and spaces, so walk back to its
      // opening quote rather than to the first non-word character.
      let k = j - 1;
      while (k > 0 && text[k - 1] !== '"') k -= 1;
      if (k === 0) break;
      j = k - 1;
    } else {
      while (j > 0 && /[A-Za-z0-9_$]/.test(text[j - 1])) j -= 1;
    }
    const part = text.slice(j, i - 1).replace(/"/g, '');
    if (!part) break;
    context.unshift(part);
    i = j;
  }
  return { start, word, context };
}

// Caret pixel position inside a textarea, measured with an offscreen mirror
// div that clones the textarea's text metrics up to the caret.
let caretMirror = null;
let caretMarker = null;

// Every style that can shift where a glyph lands. Miss one and the mirror
// wraps differently from the textarea, which is how the dropdown ends up
// nowhere near the caret.
const MIRROR_STYLES = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'lineHeight',
  'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'tabSize',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'boxSizing', 'whiteSpace', 'wordBreak', 'overflowWrap', 'direction',
];

/**
 * Where the caret sits inside a textarea, in pixels relative to that
 * textarea's own top-left corner.
 *
 * An offscreen div mirrors the textarea's text metrics and holds the value up
 * to the caret, with a zero-width marker at the end. Measuring the marker
 * against the mirror with getBoundingClientRect gives the offset directly -
 * offsetTop/offsetLeft depend on which ancestor happens to be positioned,
 * which is exactly the kind of thing that silently breaks.
 *
 * The node is built once and reused; creating and destroying it per keystroke
 * forced a layout on every character typed.
 */
function caretPixelPos(ta, caret) {
  if (!caretMirror) {
    caretMirror = document.createElement('div');
    caretMirror.setAttribute('aria-hidden', 'true');
    caretMirror.style.position = 'absolute';
    caretMirror.style.top = '0';
    caretMirror.style.left = '-9999px';
    caretMirror.style.visibility = 'hidden';
    caretMirror.style.pointerEvents = 'none';
    caretMirror.style.margin = '0';
    caretMirror.style.overflow = 'hidden';
    caretMarker = document.createElement('span');
    document.body.appendChild(caretMirror);
  }

  const style = window.getComputedStyle(ta);
  MIRROR_STYLES.forEach(prop => { caretMirror.style[prop] = style[prop]; });
  // Match the textarea's border box exactly so wrapping lines up. A textarea
  // always wraps, so pre-wrap is right even if the source says otherwise.
  caretMirror.style.width = `${ta.getBoundingClientRect().width}px`;
  caretMirror.style.height = 'auto';
  caretMirror.style.whiteSpace = 'pre-wrap';
  caretMirror.style.overflowWrap = 'break-word';

  caretMirror.textContent = ta.value.slice(0, caret);
  caretMarker.textContent = '\u200b';
  caretMirror.appendChild(caretMarker);

  const mirrorBox = caretMirror.getBoundingClientRect();
  const markerBox = caretMarker.getBoundingClientRect();
  const left = markerBox.left - mirrorBox.left - ta.scrollLeft;
  const top = markerBox.bottom - mirrorBox.top - ta.scrollTop;

  // A caret scrolled out of view would otherwise throw the dropdown far up or
  // far down the page.
  return {
    left: Math.max(0, Math.min(left, ta.clientWidth)),
    top: Math.max(0, Math.min(top, ta.clientHeight)),
    lineHeight: markerBox.height || parseFloat(style.lineHeight) || 16,
  };
}


export {
  PAGE_SIZE_OPTIONS, DEFAULT_COL_WIDTH, MIN_COL_WIDTH, MAX_COL_WIDTH,
  EXPORT_FORMATS, FILTER_OPS, STATIC_SUGGESTIONS,
  fetchJson, cellText, formatBytes, formatCount, formatWhen,
  leadKeywordHint, sqlTokenAtCaret, caretPixelPos,
  tokenizeSql, TOKEN_COLORS, parseTableRefs, resolveRef, clauseAtCaret, rankSuggestions,
};