import dashboardIcon from '/icons/JJ_Icon_Dashboard_RGB.svg';
import analysisIcon from '/icons/JJ_Icon_Analysis_RGB.svg';
import filterIcon from '/icons/JJ_Icon_Filter.svg';
import aiIcon from '/icons/JJ_Icon_AI_RGB.svg';
import personIcon from '/icons/JJ_Icon_Person_RGB.svg';
import recordsIcon from '/icons/JJ_Icon_Records_Information_RGB.svg';
import linkIcon from '/icons/JJ_Icon_Link_RGB.svg';
import stationeryIcon from '/icons/JJ_Icon_Stationery_RGB.svg';
import databaseIcon from '/icons/JJ_Icon_Database_RGB.svg';
import networkIcon from '/icons/JJ_Icon_Network_RGB.svg';
import infographicIcon from '/icons/JJ_Icon_Infographic_RGB.svg';
import mailIcon from '/icons/JJ_Icon_Communication_RGB.svg';
import timeIcon from '/icons/JJ_Icon_Time_RGB.svg';
import shieldIcon from '/icons/JJ_Icon_Shield_RGB.svg';

const AVATAR_PAIRS = [
  ['#eb1700', '#9e0000'], ['#0f68b2', '#004685'], ['#8c3bbb', '#541980'], ['#328714', '#3b5a0d'],
  ['#ff6017', '#9e0000'], ['#6e6259', '#312c2a'], ['#69d0ff', '#0f68b2'],
];

// Same name always gets the same colours, so a person is recognisable across views.
export const avatarPair = (seed) => AVATAR_PAIRS[[...String(seed || '?')].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_PAIRS.length];

export const initialsOf = (name) => String(name || '?')
  .replace(/[^\p{L}\s]/gu, ' ')
  .trim()
  .split(/\s+/)
  .map((p) => p[0])
  .slice(0, 2)
  .join('')
  .toUpperCase() || '?';

// Open layers (modals, drawer, confirm), top-most last. Escape only closes the
// top one, and the page's own shortcuts stay quiet while anything is open.
export const layerStack = [];
export const isLayerOpen = () => layerStack.length > 0;

export const BUILTIN_ROLE_IDS = ['admin', 'dqe_righttime_superuser', 'it_viewer', 'viewer'];

// Same order the backend uses when someone is in more than one mapped group.
export const AD_ROLE_PRIORITY = ['admin', 'dqe_righttime_superuser', 'it_viewer'];

export const DEFAULT_ROLE = 'viewer';

export const ROLE_SWATCHES = ['#eb1700', '#9e0000', '#ff6017', '#328714', '#3b5a0d', '#0f68b2', '#004685', '#69d0ff', '#8c3bbb', '#541980', '#6e6259'];

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const GRAPH = 'https://graph.microsoft.com/v1.0';

const SCOPES = ['User.Read.All', 'Group.Read.All', 'GroupMember.Read.All'];

// Silent first; a popup only when consent is missing. Throws with a message the
// page can show as-is.
export async function getGraphToken(instance) {
  const account = instance.getActiveAccount() || instance.getAllAccounts()[0];
  if (!account) throw new Error('You are signed out. Sign in again to load the directory.');
  try {
    const res = await instance.acquireTokenSilent({ scopes: SCOPES, account });
    return res.accessToken;
  } catch {
    try {
      const res = await instance.acquireTokenPopup({ scopes: SCOPES, account });
      return res.accessToken;
    } catch {
      throw new Error('Could not get directory permissions. Ask your administrator to grant User.Read.All and Group.Read.All.');
    }
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const GRAPH_TIMEOUT_MS = 20000;

// fetch with a timeout, plus a couple of retries when Graph is throttling or
// briefly down. Network failures come back as readable errors (status 0).
async function graphFetch(url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(GRAPH_TIMEOUT_MS) : undefined;
      res = await fetch(url, { ...init, signal });
    } catch (e) {
      const err = new Error(e?.name === 'TimeoutError'
        ? 'The directory took too long to answer. Try again.'
        : 'Couldn’t reach Microsoft Graph. Check your connection and try again.');
      err.status = 0;
      throw err;
    }
    if ([429, 503, 504].includes(res.status) && attempt < 2) {
      const after = Number(res.headers.get('Retry-After')) || 2 ** attempt;
      await wait(Math.min(after * 1000, 8000));
      continue;
    }
    return res;
  }
}

const friendlyGraphError = (status, fallback) => {
  if (status === 401) return 'Your directory sign-in expired. Refresh the page to sign in again.';
  if (status === 403) return 'You don’t have permission to read the directory. Ask IT for User.Read.All and Group.Read.All.';
  if (status === 429) return 'The directory is busy right now. Try again in a minute.';
  if (status >= 500) return 'The directory is having problems right now. Try again shortly.';
  return fallback;
};

export async function graphGet(token, url, extraHeaders = {}) {
  const res = await graphFetch(url.startsWith('http') ? url : `${GRAPH}${url}`, {
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(friendlyGraphError(res.status, body.error?.message || `Directory request failed (${res.status})`));
    err.status = res.status;
    throw err;
  }
  return res;
}

// Graph $batch in chunks of 20 (its limit), up to 4 chunks at a time.
// Returns { [id]: { status, body } }. Throttled sub-requests (429) are retried
// once after the delay Graph asks for.
async function runBatchChunk(token, chunk, out) {
  let pending = chunk;
  for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
    const res = await graphFetch(`${GRAPH}/$batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: pending }),
    });
    if (!res.ok) {
      const err = new Error(friendlyGraphError(res.status, `Directory batch failed (${res.status})`));
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const retry = [];
    let delay = 0;
    (data.responses || []).forEach((r) => {
      if (r.status === 429 && attempt === 0) {
        retry.push(pending.find((p) => p.id === r.id));
        delay = Math.max(delay, Number(r.headers?.['Retry-After'] || 1) * 1000);
      } else {
        out[r.id] = { status: r.status, body: r.body };
      }
    });
    pending = retry.filter(Boolean);
    if (pending.length) await wait(Math.min(delay, 5000));
  }
}

export async function graphBatch(token, requests, parallel = 4) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < requests.length; i += 20) chunks.push(requests.slice(i, i + 20));
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      await runBatchChunk(token, chunk, out);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, chunks.length) }, worker));
  return out;
}

// Single quotes are doubled inside OData string literals.
export const odataString = (value) => String(value).replace(/'/g, "''");

export const isGuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));

// AD display names often end in an affiliation tag like "[JRDUS NON-J&J]".
export const cleanDisplayName = (raw) => String(raw || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();

export const emailOf = (user) => (user?.mail || user?.userPrincipalName || '').toLowerCase();

// ─── Permission tree ─────────────────────────────────────────────────────────
// One entry per feature, with its sub-permissions nested under it. Must stay in
// step with ALL_PERMISSIONS and PERMISSION_PARENTS in backend/auth.py — the
// backend enforces the same parent rule for custom access.
export const PERMISSION_GROUPS = [
  { key: 'viewDashboard', label: 'Dashboard', icon: dashboardIcon, description: 'Access to the main dashboard', children: [] },
  {
    key: 'viewDQE', label: 'Data Quality Engine', icon: analysisIcon, description: 'Access to DQE and its sub-features',
    children: [
      { key: 'viewITChecks', label: 'View IT Checks', description: 'View IT-defined quality checks',
        children: [
          { key: 'runITChecks', label: 'Run IT Validations', description: 'Trigger re-validation on individual tables and refresh its full report' },
        ] },
      { key: 'viewDataValidation', label: 'View Data Validation', description: 'View the Data Validation tool',
        children: [
          { key: 'runDataValidation', label: 'Run Data Validation', description: 'Trigger source-to-target validation runs in Data Validation' },
        ] },
      { key: 'viewBusinessChecks', label: 'View Business Checks', description: 'View business-defined quality checks',
        children: [
          { key: 'runBDCOperations', label: 'Run Validation Operations', description: 'Run Compilation and Validation' },
          { key: 'viewBDCSuperuser', label: 'View Superuser Tab', description: 'Access the Superuser configuration tab' },
          { key: 'viewBDCExecutive', label: 'View Executive View', description: 'Switch Business Checks into the executive summary view' },
        ] },
    ],
  },
  {
    key: 'viewFuzzyMatch', label: 'Fuzzy Match', icon: filterIcon, description: 'Access to fuzzy matching tool',
    children: [
      { key: 'viewData', label: 'View Data', description: 'Access to data views' },
      { key: 'viewMetadata', label: 'View Metadata', description: 'Access to metadata views' },
    ],
  },
  { key: 'viewAIChatbot', label: 'AI Assistant', icon: aiIcon, description: 'Access to the AI chatbot', children: [] },
  { key: 'viewAssistantAvatar', label: 'AI Avatar Assistant', icon: personIcon, description: 'The floating 3D avatar assistant that follows the user across every page', children: [] },
  { key: 'viewDataTypeValidation', label: 'Data Type Validation', icon: recordsIcon, description: 'Access to data type validation tools', children: [] },
  { key: 'manageDataAPIExports', label: 'Data API Export', icon: linkIcon, description: 'Create and manage shareable API endpoints for source tables', children: [] },
  {
    key: 'viewUnstructured', label: 'Unstructured Explorer', icon: stationeryIcon, description: 'Access to the Unstructured Explorer page. Each document set and tab below is granted separately',
    children: [
      { key: 'viewUnstructuredSQL', label: 'View SQL', description: 'See the underlying SQL query behind each card, chart and table' },
      { key: 'viewUnstructuredVR', label: 'Virtual Regulator', description: 'Virtual Regulator tab (Internal and External)',
        children: [
          { key: 'viewUnstructuredVRInternal', label: 'Internal', description: 'Internal Virtual Regulator explorer' },
          { key: 'viewUnstructuredVRExternal', label: 'External', description: 'External health authority sources' },
        ] },
      { key: 'viewUnstructuredIMMBOT', label: 'IMMBOT', description: 'IMMBOT tab',
        children: [
          { key: 'viewUnstructuredIMMBOTExplore', label: 'Explore', description: 'Explore tab' },
          { key: 'viewUnstructuredIMMBOTTable', label: 'Data table', description: 'Data table tab' },
          { key: 'viewUnstructuredIMMBOTBreakdown', label: 'Breakdown', description: 'Breakdown tab' },
        ] },
      { key: 'viewUnstructuredMirAI', label: 'MirAI', description: 'MirAI tab' },
      { key: 'viewUnstructuredRMWCreate', label: 'RMWCreate', description: 'RMWCreate tab' },
      { key: 'viewUnstructuredHAQ', label: 'Q!', description: 'Q! tab' },
      { key: 'viewUnstructuredNipo', label: 'Nipocalimab', description: 'Nipocalimab tab',
        children: [
          { key: 'viewUnstructuredNipoExplore', label: 'Explore', description: 'Explore tab' },
          { key: 'viewUnstructuredNipoTable', label: 'Data table', description: 'Data table tab' },
        ] },
      { key: 'viewUnstructuredRimDocs', label: 'RIMDocs', description: 'RIMDocs tab',
        children: [
          { key: 'viewUnstructuredRimDocsExplore', label: 'Explore', description: 'Explore tab' },
          { key: 'viewUnstructuredRimDocsTable', label: 'Data table', description: 'Data table tab' },
          { key: 'viewUnstructuredRimDocsBreakdown', label: 'Domain breakdown', description: 'Domain breakdown tab' },
          { key: 'runUnstructuredQueryRunner', label: 'Query Runner', description: 'Write and run custom read-only SELECT queries against the RIMDocs data' },
          { key: 'runPostgresQueryRunner', label: 'Postgres Query Runner', description: 'Explore and run full SQL (including writes/DDL) against configured PostgreSQL databases' },
        ] },
      { key: 'viewUnstructuredEPOD', label: 'EPOD', description: 'EPOD tab',
        children: [
          { key: 'viewUnstructuredEPODExplore', label: 'Explore', description: 'Explore tab' },
          { key: 'viewUnstructuredEPODTable', label: 'Data table', description: 'Data table tab' },
        ] },
      { key: 'viewUnstructuredFDA', label: 'FDA and Others', description: 'FDA and Others tab',
        children: [
          { key: 'viewUnstructuredFDAExplore', label: 'Explore', description: 'Explore tab' },
          { key: 'viewUnstructuredFDATable', label: 'Data table', description: 'Data table tab' },
        ] },
    ],
  },
  {
    key: 'viewDataStudio', label: 'Data Studio', icon: databaseIcon, description: 'Access to the Data Studio page. Each tab below is granted separately',
    children: [
      { key: 'runSnowflakeQueryRunner', label: 'Snowflake', description: 'Explore and run full SQL against Snowflake, and edit table rows in the data grid' },
      {
        key: 'viewPGindexer', label: 'Index Health', description: 'Check PostgreSQL tables for missing, broken or duplicate indexes (read-only)',
        children: [
          { key: 'buildPGindexer', label: 'Build Indexes', description: 'Run the suggested fixes: create or drop indexes, add primary keys, ANALYZE' },
        ],
      },
      { key: 'runS3Explorer', label: 'S3 Explorer', description: 'Browse configured S3 buckets: list, preview, download and, where enabled, upload or delete objects' },
      { key: 'runStreamsetsExtractor', label: 'StreamSets Extractor', description: 'Browse StreamSets pipelines (sources, transformations, destinations, fragments) and extract their reports' },
    ],
  },
  {
    key: 'viewGraDataDomains', label: 'Structured Explorer', icon: networkIcon, description: 'Access to the GRA data domains explorer',
    children: [
      { key: 'editGraDataDomains', label: 'Edit Records', description: 'Edit the domain records inline from the records table' },
    ],
  },
  {
    key: 'viewRAG', label: 'RAG', icon: infographicIcon, description: 'Access to RAG documents',
    children: [
      { key: 'viewEPodRAG', label: 'View EPOD RAG', description: 'Access to the EPOD RAG chatbot' },
      { key: 'viewRimDocsRAG', label: 'View RIMDOCS RAG', description: 'Access to the RIMDOCS RAG chatbot' },
      { key: 'viewRimDocsAgentic', label: 'View RIMDocs Agentic', description: 'Access to the RIMDocs Agentic chatbot' },
    ],
  },
  { key: 'sendCommunications', label: 'Communication Center', icon: mailIcon, description: 'Send updates, warnings and notices to users by email', children: [] },
  { key: 'viewAudit', label: 'Audit Log', icon: timeIcon, description: 'Access to audit log', children: [] },
  {
    key: 'viewUserManagement', label: 'User Management', icon: shieldIcon, description: 'Access to user management',
    children: [
      { key: 'manageUsers', label: 'Manage Users', description: 'Assign and remove user roles, and give custom access' },
      { key: 'manageRoles', label: 'Manage Roles', description: 'Create, edit and delete roles' },
    ],
  },
];

// Flattened views of the tree, built once. ALL_KEYS lists every parent before
// its children, which the effective-access pass below relies on.
export const ALL_KEYS = [];
export const LABEL = {};
export const PARENT = {};
export const NODE = {};
const walk = (list, parent) => list.forEach((node) => {
  ALL_KEYS.push(node.key);
  LABEL[node.key] = node.label;
  PARENT[node.key] = parent;
  NODE[node.key] = node;
  walk(node.children || [], node.key);
});
walk(PERMISSION_GROUPS, null);

export const TOTAL_PERMISSIONS = ALL_KEYS.length;

// Top-level feature a permission belongs to
export const featureOf = (key) => {
  let k = key;
  while (PARENT[k]) k = PARENT[k];
  return k;
};

const DESCENDANTS = {};
ALL_KEYS.forEach((key) => {
  const out = [];
  const collect = (node) => (node.children || []).forEach((c) => { out.push(c.key); collect(c); });
  collect(NODE[key]);
  DESCENDANTS[key] = out;
});
export const descendants = (key) => DESCENDANTS[key] || [];

// Full map with every known key, true only for the ones named (or all).
export const permsFrom = (keys) => {
  const on = keys === 'all' ? null : new Set(keys);
  return Object.fromEntries(ALL_KEYS.map((k) => [k, on ? on.has(k) : true]));
};

export const countOn = (perms) => ALL_KEYS.reduce((n, k) => n + (perms?.[k] === true ? 1 : 0), 0);

export const featuresOn = (perms) => PERMISSION_GROUPS.reduce((n, g) => n + (perms?.[g.key] === true ? 1 : 0), 0);

// 'full' | 'partial' | 'none' for one top-level feature
export const groupState = (perms, key) => {
  if (perms?.[key] !== true) return 'none';
  const kids = DESCENDANTS[key];
  return kids.every((k) => perms[k] === true) ? 'full' : 'partial';
};

// The role editor's switch rule: switching something off clears everything
// under it, and a sub-permission can only go on while its parent is on.
export const togglePermission = (perms, key) => {
  const parent = PARENT[key];
  if (parent && perms[parent] !== true) return { ok: false, needs: LABEL[parent] };
  const next = { ...perms, [key]: perms[key] !== true };
  if (!next[key]) DESCENDANTS[key].forEach((k) => { next[k] = false; });
  return { ok: true, perms: next };
};

// ─── Custom access on top of a role ─────────────────────────────────────────
// Mirrors apply_user_overrides() in backend/auth.py exactly, so what the page
// shows is what the API enforces:
//   · untouched permissions keep the role's value
//   · `add` grants, but only while the parent ends up on
//   · `remove` takes away, along with everything under it
export const effectiveAccess = (rolePerms, overrides) => {
  const base = rolePerms || {};
  const add = new Set(overrides?.add || []);
  const remove = new Set(overrides?.remove || []);
  const out = {};
  ALL_KEYS.forEach((k) => { out[k] = base[k] === true; });
  if (!add.size && !remove.size) return out;
  const cut = new Set();
  ALL_KEYS.forEach((k) => {
    const parent = PARENT[k];
    if (remove.has(k) || (parent && cut.has(parent) && out[k])) {
      out[k] = false;
      cut.add(k);
    } else if (add.has(k)) {
      out[k] = !parent || out[parent] === true;
    }
  });
  return out;
};

export const EMPTY_OVERRIDES = Object.freeze({ add: [], remove: [] });

// Change one permission for a person and return the new overrides. The result
// only ever records differences from the role, so switching something back to
// what the role gives removes it from the overrides instead of stacking.
export const setOverride = (rolePerms, overrides, key, on) => {
  const current = effectiveAccess(rolePerms, overrides);
  const parent = PARENT[key];
  if (on && parent && !current[parent]) return { ok: false, needs: LABEL[parent] };

  const add = new Set(overrides?.add || []);
  const remove = new Set(overrides?.remove || []);
  add.delete(key);
  remove.delete(key);
  const fromRole = rolePerms?.[key] === true;
  if (on && !fromRole) add.add(key);
  if (!on && fromRole) remove.add(key);
  // Extra grants under something that's now off can never apply, so drop them.
  // Removals stay: they still matter if the parent is switched back on.
  if (!on) DESCENDANTS[key].forEach((k) => add.delete(k));
  const ordered = (set) => ALL_KEYS.filter((k) => set.has(k));
  return { ok: true, overrides: { add: ordered(add), remove: ordered(remove) } };
};

export const overrideCount = (overrides) => ({
  add: overrides?.add?.length || 0,
  remove: overrides?.remove?.length || 0,
});

export const hasOverrides = (overrides) => !!(overrides?.add?.length || overrides?.remove?.length);

// Where a permission's current state comes from for this person
export const permissionSource = (overrides, key) => {
  if (overrides?.add?.includes(key)) return 'add';
  if (overrides?.remove?.includes(key)) return 'remove';
  return 'role';
};