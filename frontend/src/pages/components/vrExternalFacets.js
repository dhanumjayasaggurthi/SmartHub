// Grouping for the VR External tables. Values come from EXTERNAL_FDA_MAPPING
// (backend puts it on each source as `meta`). The welcome screen groups tables
// by health authority, the header dropdown only shows the picked one's tables.

export const NOT_MAPPED = 'Not mapped';

const clean = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

// press releases come from FDA even when the mapping row is missing
export function haOf(source) {
  return clean(source?.meta?.site) || (source?.kind === 'press' ? 'FDA' : NOT_MAPPED);
}

export function regionOf(source) {
  return clean(source?.meta?.region) || NOT_MAPPED;
}

export function isYes(v) {
  return v === true || /^(y|yes|true|1)$/i.test(String(v ?? '').trim());
}

// short badge text, "Health Canada" -> "HC", "FDA" stays "FDA"
export function initialsOf(name) {
  const s = String(name || '').trim();
  if (!s || s === NOT_MAPPED) return '?';
  if (/^[A-Z0-9]{2,5}$/.test(s)) return s;
  const caps = s.match(/\b[A-Z]/g) || [];
  return (caps.length >= 2 ? caps.join('') : s.slice(0, 2)).slice(0, 4).toUpperCase();
}

// one entry per health authority, mapped ones first, then by name
export function groupByHa(sources) {
  const map = new Map();
  for (const s of sources) {
    const name = haOf(s);
    if (!map.has(name)) {
      map.set(name, { name, regions: new Set(), feeds: new Set(), website: null, rows: 0, hasRows: false, tables: [] });
    }
    const g = map.get(name);
    g.tables.push(s);
    g.regions.add(regionOf(s));
    if (clean(s.meta?.feed)) g.feeds.add(clean(s.meta.feed));
    if (!g.website && clean(s.meta?.website)) g.website = clean(s.meta.website);
    const n = Number(s.meta?.row_count);
    if (Number.isFinite(n)) { g.rows += n; g.hasRows = true; }
  }
  return [...map.values()]
    .map(g => ({ ...g, regions: [...g.regions], feeds: [...g.feeds] }))
    .sort((a, b) => (a.name === NOT_MAPPED) - (b.name === NOT_MAPPED) || a.name.localeCompare(b.name));
}

/* ---------- facet rail on the table view ---------- */

export const VR_FACETS = [
  { id: 'region', label: 'Region', get: s => regionOf(s) },
  { id: 'site', label: 'Health authority', get: s => haOf(s) },
  { id: 'feed', label: 'Feed type', get: s => clean(s?.meta?.feed) || NOT_MAPPED },
];

// skip = leave one facet out, so its own counts show the siblings
export function passesFacets(source, picked, skip = null) {
  for (const f of VR_FACETS) {
    if (f.id === skip) continue;
    const want = picked[f.id];
    if (want?.length && !want.includes(f.get(source))) return false;
  }
  return true;
}

export function facetOptions(tables, picked) {
  return VR_FACETS.map(f => {
    const counts = new Map();
    tables.filter(t => passesFacets(t, picked, f.id)).forEach(t => {
      const v = f.get(t);
      counts.set(v, (counts.get(v) || 0) + 1);
    });
    // keep picked values visible even at 0 so they can be unticked
    (picked[f.id] || []).forEach(v => { if (!counts.has(v)) counts.set(v, 0); });
    const options = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => (a.value === NOT_MAPPED) - (b.value === NOT_MAPPED) || b.count - a.count || a.value.localeCompare(b.value));
    return { ...f, options };
  });
}

// one colour per health authority, handed out in name order so the same
// authority gets the same colour on every page
const HA_PALETTE = ['#0f68b2', '#328714', '#ff6017', '#8c3bbb', '#b8860b', '#9e0000', '#00857c', '#e0457b', '#004685', '#3b5a0d', '#541980', '#c05a00'];

export function haColors(sources) {
  const names = [...new Set((sources || []).map(haOf))]
    .filter(n => n !== NOT_MAPPED)
    .sort((a, b) => a.localeCompare(b));
  const map = new Map(names.map((n, i) => [n, HA_PALETTE[i % HA_PALETTE.length]]));
  map.set(NOT_MAPPED, '#a39992');
  return map;
}

export function pickedCount(picked) {
  return Object.values(picked).reduce((n, list) => n + (list?.length || 0), 0);
}