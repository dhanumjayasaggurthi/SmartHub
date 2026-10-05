import React, { useState, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import LoadingSpinner from './LoadingSpinner';
import ChunkExplorer, {
  Icon, Card, ErrorBanner, NoData, CardUnavailable, Pill, ContentChips,
  Donut, RankedBars, TrendLine, Pager, ChunkText,
  fetchJson, formatCompact, blank, bLabel, colorFrom,
  parseContentTypes, renderCell, LEVEL_COLORS, CONTENT_COLORS, INGESTION_COLORS,
} from './ChunkExplorer';

import searchIcon from "/icons/JJ_Icon_Search_RGB.svg";
import closeIcon from "/icons/JJ_Icon_Close.svg";
import chevronDownIcon from "/icons/JJ_Icon_Chevron_Down.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";

// Virtual Regulator (Internal) - DEV_RAW.UNSTRUCTURED_EXPLORER.SUBX_FINAL.
// Built for people who read these documents, not the pipeline: Overview (products,
// what changed, common sections), Documents (library, latest version per doc)
// and the raw Data table.
// Filters in the left rail apply to every tab.

const FILTERS = [
  { col: 'PRODUCT_NAME', label: 'Product' },
  { col: 'MODIFIED_BY', label: 'Modified by' },
  { col: 'VERSION_LABEL', label: 'Version' },
  { col: 'CONTENT_TYPE', label: 'Content type' },
  { col: 'CHUNK_LEVEL', label: 'Chunk level' },
  { col: 'STATUS', label: 'Ingestion status' },
];

const SEARCHES = [
  { col: 'TITLE', ph: 'Title contains…' },
  { col: 'EDMS_NUMBER', ph: 'EDMS number contains…' },
  { col: 'SECTION_TITLE', ph: 'Section title contains…' },
  { col: 'CHUNK_TEXT', ph: 'Text contains…' },
  { col: 'FILE_NAME', ph: 'File name contains…' },
];

const DOC_TABLE_ORDER = [
  'PRODUCT_NAME', 'EDMS_NUMBER', 'TITLE', 'NAME', 'VERSION_LABEL', 'MODIFIED', 'MODIFIED_BY',
  'PAGES_TOTAL', 'CHUNK_TOTAL', 'MATCHING_CHUNKS', 'STATUS', 'FILE_NAME', 'FILE_SIZE', 'RANKING',
  'INGESTED_AT', 'LAST_MODIFIED', 'CREATED_AT', 'UPDATED_AT', 'OBJ_ID', 'DOC_ID', 'S3_PATH', 'FILE_PATH',
];

const CHUNK_TABLE_ORDER = [
  'PRODUCT_NAME', 'EDMS_NUMBER', 'TITLE', 'SECTION_TITLE', 'PAGE_START', 'PAGE_END', 'CONTENT_TYPES',
  'CHUNK_TEXT', 'CHUNK_INDEX', 'CHUNK_LEVEL', 'VERSION_LABEL', 'MODIFIED', 'MODIFIED_BY', 'FILE_NAME',
  'CHUNK_TOTAL', 'PAGES_TOTAL', 'STATUS', 'CHUNK_ID', 'DOC_ID',
];

const DETAIL_LABELS = {
  PRODUCT_NAME: 'Product', EDMS_NUMBER: 'EDMS number', TITLE: 'Title', NAME: 'Document name',
  VERSION_LABEL: 'Version', MODIFIED: 'Modified', MODIFIED_BY: 'Modified by', RANKING: 'Ranking',
  PAGES_TOTAL: 'Pages', CHUNK_TOTAL: 'Chunks', FILE_SIZE: 'File size', FILE_NAME: 'File name',
  STATUS: 'Ingestion status', INGESTED_AT: 'Ingested', LAST_MODIFIED: 'File last modified',
  CREATED_AT: 'Created', UPDATED_AT: 'Updated', OBJ_ID: 'Object ID', DOC_ID: 'Doc ID',
  S3_PATH: 'S3 path', FILE_PATH: 'Source path',
};
const DOC_META_FIELDS = Object.keys(DETAIL_LABELS);

const PRODUCT_PALETTE = ['#0f68b2', '#8c3bbb', '#328714', '#ff6017', '#004685', '#9e0000', '#3b5a0d', '#541980', '#53ce76'];

/* ------------------------------ helpers ------------------------------ */

function fmtDate(v) {
  if (blank(v)) return '—';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function timeAgo(v) {
  const d = new Date(v);
  if (blank(v) || isNaN(d)) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  const yrs = days / 365;
  return `${yrs < 2 ? yrs.toFixed(1).replace(/\.0$/, '') : Math.floor(yrs)} yr ago`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function Highlight({ text, term }) {
  if (!term || !text) return <>{text}</>;
  const parts = String(text).split(new RegExp(`(${escapeRe(term)})`, 'ig'));
  return (
    <>
      {parts.map((p, i) => (p.toLowerCase() === term.toLowerCase()
        ? <mark key={i} className="bg-[#fbe058]/70 text-jj-gray-08 rounded-[2px] px-[1px]">{p}</mark>
        : <React.Fragment key={i}>{p}</React.Fragment>))}
    </>
  );
}

// same product -> same colour on every tab and in the document panel
function productColor(name) {
  if (blank(name)) return '#6e6259';
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PRODUCT_PALETTE[h % PRODUCT_PALETTE.length];
}

const plural = (n, word) => `${(n ?? 0).toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

// Loads `path` for the current filters; refetches when filters / reload / extra change.
function useScoped(ctx, slot, path, extra = {}, enabled = true) {
  const [state, setState] = useState({ loading: enabled });
  const [retry, setRetry] = useState(0);
  const extraKey = JSON.stringify(extra);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const bypass = ctx.takeBypass(slot);
    ctx.setBusy(slot, true);
    setState(s => ({ ...s, loading: true, error: null }));
    fetchJson(`${ctx.api}${path}?${ctx.scopeParams({ ...extra, bypass_cache: bypass ? 'true' : '' })}`)
      .then(d => {
        if (!alive) return;
        setState({ data: d, loading: false });
        ctx.synced();
      })
      .catch(e => { if (alive) setState(s => ({ ...s, error: e.message, loading: false })); })
      // only the latest request clears busy, an older one finishing late would
      // flip the header to "Synced" while this one is still running
      .finally(() => { if (alive) ctx.setBusy(slot, false); });
    return () => { alive = false; ctx.setBusy(slot, false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.scopeKey, ctx.reloadKey, extraKey, enabled, retry]);
  return { ...state, retry: () => setRetry(r => r + 1) };
}

// grey placeholder lines, sized to the card so nothing jumps when data lands
function Skeleton({ height = 200, lines }) {
  const n = lines ?? Math.max(2, Math.min(8, Math.floor(height / 28)));
  return (
    <div style={{ height }} className="flex flex-col justify-center gap-2.5 animate-pulse" role="status" aria-label="Loading">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="h-3 rounded bg-jj-gray-02" style={{ width: `${92 - ((i * 17) % 45)}%` }} />
      ))}
    </div>
  );
}

// first load -> skeleton, error -> retry, refetch -> keep old content dimmed
function CardBody({ st, height, isEmpty, render }) {
  if (st.loading && !st.data) return <Skeleton height={height} />;
  if (st.error) return <CardUnavailable message={st.error} onRetry={st.retry} />;
  if (isEmpty(st.data)) return <NoData />;
  return (
    <div className={`relative transition-opacity ${st.loading ? 'opacity-50 pointer-events-none' : ''}`} aria-busy={st.loading}>
      {render(st.data)}
    </div>
  );
}
const noRows = (d) => !d?.rows?.length;

function SectionHead({ title, sub, right }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-2.5">
      <div className="min-w-0">
        <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">{title}</div>
        {sub && <div className="text-[10.5px] font-johnson-text text-jj-gray-05 mt-0.5">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

function SqlLink({ ctx, title, sql }) {
  if (!ctx.canViewSql || !sql) return null;
  return <button onClick={() => ctx.openSql(title, sql)} className="text-[10.5px] font-johnson-text text-jj-blue-03 underline flex-shrink-0">SQL</button>;
}

function ProductTag({ name, color }) {
  if (blank(name)) return <span className="text-[11px] font-johnson-text italic text-jj-gray-05">No product</span>;
  return (
    <span className="inline-flex items-center text-[10.5px] font-johnson-text font-bold tracking-wide px-2 py-[2px] rounded-md whitespace-nowrap"
      style={{ background: `${color}14`, color }}>
      {name}
    </span>
  );
}

const btnCls = "flex items-center gap-[7px] px-[13px] py-1.5 rounded-full border border-jj-gray-03 text-[11.5px] font-johnson-text text-jj-gray-08 disabled:opacity-40 hover:bg-jj-gray-01";
const selectCls = "border border-jj-gray-03 rounded-lg px-2 py-1 text-[11.5px] font-johnson-text text-jj-gray-08 bg-white focus:outline-none focus:border-jj-blue-03";

/* ============================== OVERVIEW ============================== */

function OverviewView({ ctx }) {
  const products = useScoped(ctx, 'vr-products', '/products');
  const recent = useScoped(ctx, 'vr-recent', '/chart/recent-docs');
  const sections = useScoped(ctx, 'vr-sections', '/chart/common-sections');
  const owners = useScoped(ctx, 'vr-owners', '/chart/owners');
  const trend = useScoped(ctx, 'vr-trend', '/chart/modified-trend');
  const [showHealth, setShowHealth] = useState(false);

  const list = products.data?.products || [];
  const totalDocs = list.reduce((a, p) => a + (p.DOCS || 0), 0);
  const picked = ctx.filters.PRODUCT_NAME || [];

  // section click -> Documents tab narrowed to docs that have that section
  const showSection = (term) => {
    ctx.logInPage('vr_section_pick', `${ctx.label}: opened documents with section "${term}"`);
    ctx.setSearchText('SECTION_TITLE', term);
    ctx.goTab('library');
  };

  const browseProduct = (name) => {
    if (!picked.includes(String(name))) ctx.toggleFilter('PRODUCT_NAME', name);
    ctx.goTab('library');
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="p-5 flex flex-col gap-3.5">
        {products.error && <ErrorBanner message={`Couldn't load products: ${products.error}`} onRetry={products.retry} />}

        {/* product portfolio */}
        <div className="flex-shrink-0">
          <SectionHead
            title="Products"
            sub="Click a card to focus the page on that product · Browse opens its documents"
            right={<SqlLink ctx={ctx} title="Products" sql={products.data?.sql} />}
          />
          {products.loading && !products.data ? (
            <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))' }}>
              {[0, 1, 2].map(i => <Card key={i} className="px-4 py-3"><Skeleton height={150} lines={5} /></Card>)}
            </div>
          ) : !list.length ? (products.error ? null : <Card><NoData /></Card>) : (
            <div className={`grid gap-3.5 transition-opacity ${products.loading ? 'opacity-50 pointer-events-none' : ''}`} style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))' }}>
              {list.map(p => {
                const color = productColor(p.PRODUCT_NAME);
                const on = picked.includes(String(p.PRODUCT_NAME));
                const share = totalDocs ? (p.DOCS / totalDocs) * 100 : 0;
                return (
                  <div key={p.PRODUCT_NAME ?? '(none)'}
                    onClick={() => ctx.toggleFilter('PRODUCT_NAME', p.PRODUCT_NAME)}
                    className={`bg-white rounded-[14px] border cursor-pointer transition-shadow hover:shadow-[0_4px_14px_rgba(49,44,42,.10)] overflow-hidden ${on ? 'border-jj-blue-03 ring-1 ring-jj-blue-03/40' : 'border-jj-gray-02'}`}>
                    <div className="h-[4px]" style={{ background: color }} />
                    <div className="px-4 pt-3 pb-3.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-johnson-display font-bold text-[17px] text-jj-gray-08 truncate">{bLabel(p.PRODUCT_NAME)}</div>
                        <span className="text-[10.5px] font-johnson-text text-jj-gray-05 tabular-nums">{share.toFixed(0)}% of docs</span>
                      </div>
                      <div className="grid grid-cols-4 gap-2 mt-3">
                        {[['Docs', p.EDMS || p.DOCS], ['Versions', p.VERSIONS], ['Pages', p.PAGES], ['Tables', p.TABLES]].map(([l, v]) => (
                          <div key={l}>
                            <div className="font-johnson-display font-bold text-[16px] text-jj-gray-08 tabular-nums leading-none">{formatCompact(v ?? 0)}</div>
                            <div className="text-[10px] font-johnson-text text-jj-gray-06 mt-1">{l}</div>
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 pt-2.5 border-t border-jj-gray-01 text-[11px] font-johnson-text text-jj-gray-07 min-h-[34px]">
                        <div className="truncate" title={p.LAST_TITLE || ''}>
                          <span className="text-jj-gray-05">Latest: </span>{blank(p.LAST_TITLE) ? '—' : p.LAST_TITLE}
                        </div>
                        <div className="text-jj-gray-05 mt-0.5">
                          {fmtDate(p.LAST_MOD)}{!blank(p.LAST_BY) && ` · ${p.LAST_BY}`}{p.LAST_MOD && ` · ${timeAgo(p.LAST_MOD)}`}
                        </div>
                      </div>
                      <div className="flex items-center justify-between mt-2.5">
                        <span className="text-[10.5px] font-johnson-text text-jj-gray-05">{plural(p.SECTIONS, 'section')} · {plural(p.OWNERS, 'owner')}</span>
                        <button onClick={(e) => { e.stopPropagation(); browseProduct(p.PRODUCT_NAME); }}
                          className="text-[11px] font-johnson-text font-medium text-jj-blue-03 hover:underline">
                          Browse →
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* what changed + what's in them */}
        <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))' }}>
          <Card className="px-5 py-4 min-w-0">
            <SectionHead title="Recently changed documents" sub="Latest version of each document · click to open"
              right={<SqlLink ctx={ctx} title="Recently changed" sql={recent.data?.sql} />} />
            <CardBody st={recent} height={200} isEmpty={noRows} render={(d) => (
                <div className="flex flex-col">
                  {d.rows.map(([docId, prod, edms, title, ver, by, ts]) => (
                    <button key={docId} onClick={() => ctx.openDoc(docId)}
                      className="flex items-center gap-3 py-2 px-2 -mx-2 rounded-lg text-left hover:bg-jj-gray-01/70 border-b border-jj-gray-01 last:border-0">
                      <span className="w-[72px] flex-shrink-0"><ProductTag name={prod} color={productColor(prod)} /></span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-johnson-text font-medium text-jj-gray-08 truncate">{blank(title) ? edms : title}</div>
                        <div className="text-[10.5px] font-johnson-text text-jj-gray-05 truncate">
                          {edms}{!blank(ver) && ` · v${ver}`}{!blank(by) && ` · ${by}`}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-[11px] font-johnson-text text-jj-gray-08 tabular-nums">{fmtDate(ts)}</div>
                        <div className="text-[10px] font-johnson-text text-jj-gray-05">{timeAgo(ts)}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )} />
          </Card>

          <Card className="px-5 py-4 min-w-0">
            <SectionHead title="Common sections across documents"
              sub="Numbering ignored, so '10.3 Pharmacokinetics' = '11.5 Pharmacokinetics' · click to see those documents"
              right={<SqlLink ctx={ctx} title="Common sections" sql={sections.data?.sql} />} />
            <CardBody st={sections} height={200} isEmpty={noRows} render={(d) => (
                <RankedBars
                  data={d.rows.map(([s, d, pr]) => ({ label: bLabel(s), raw: s, count: d, extra: pr, color: '#0f68b2' }))}
                  unit="Documents"
                  extraLabel="Products"
                  compact
                  labelWidth={260}
                  onPick={(raw) => !blank(raw) && showSection(String(raw))}
                />
              )} />
          </Card>
        </div>

        <div className="grid gap-3.5 flex-shrink-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
          <Card className="px-5 py-4 min-w-0" >
            <SectionHead title="Update activity" sub="Document versions modified per month (EDMS MODIFIED date)"
              right={<SqlLink ctx={ctx} title="Update activity" sql={trend.data?.sql} />} />
            <CardBody st={trend} height={220} isEmpty={noRows} render={(d) => (
                <TrendLine data={d.rows.map(([p, n]) => ({ period: p, count: n }))} granularity="month" unit="Versions" height={220} />
              )} />
          </Card>
          <Card className="px-5 py-4 min-w-0">
            <SectionHead title="Who is updating documents" sub="Versions per MODIFIED_BY · click to filter"
              right={<SqlLink ctx={ctx} title="Owners" sql={owners.data?.sql} />} />
            <CardBody st={owners} height={200} isEmpty={noRows} render={(d) => (
                <RankedBars
                  data={d.rows.map(([who, v, d]) => ({ label: bLabel(who), raw: who, count: v, extra: d, color: '#8c3bbb' }))}
                  unit="Versions"
                  extraLabel="Documents"
                  compact
                  onPick={(raw) => ctx.toggleFilter('MODIFIED_BY', raw)}
                />
              )} />
          </Card>
        </div>

        <Card className="flex-shrink-0 overflow-hidden">
          <button onClick={() => setShowHealth(s => !s)}
            className="w-full flex items-center gap-2 px-5 py-3 text-left hover:bg-jj-gray-01/50">
            <Icon src={showHealth ? chevronDownIcon : chevronRightIcon} tint="gray" className="w-2.5 h-2.5" />
            <span className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Indexing health</span>
            <span className="text-[10.5px] font-johnson-text text-jj-gray-05">ingestion status, content mix, chunking - for the data team</span>
          </button>
          {showHealth && <HealthPanel ctx={ctx} />}
        </Card>
      </div>
    </div>
  );
}

function HealthPanel({ ctx }) {
  const status = useScoped(ctx, 'vr-h-status', '/chart/ingestion-status');
  const content = useScoped(ctx, 'vr-h-content', '/chart/content-types');
  const levels = useScoped(ctx, 'vr-h-levels', '/chart/chunk-level');
  const seg = (status.data?.rows || []).map(([s, n], i) => ({ label: bLabel(s), count: n, color: colorFrom(INGESTION_COLORS, s, i) }));
  const ok = seg.find(s => s.label.toUpperCase() === 'SUCCESS')?.count || 0;
  const total = seg.reduce((a, s) => a + s.count, 0);
  const bars = (st, map) => (st.data?.rows || []).map(([v, n], i) => ({ label: bLabel(v), raw: v, count: n, color: colorFrom(map, v, i) }));
  return (
    <div className="grid gap-3.5 px-5 pb-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
      <div className="border border-jj-gray-02 rounded-xl px-4 py-3.5 flex items-center gap-4">
        {status.loading && !status.data ? <div className="flex-1"><Skeleton height={64} lines={3} /></div>
          : status.error ? <div className="flex-1"><CardUnavailable message={status.error} onRetry={status.retry} /></div> : (
          <>
            {seg.length ? <Donut segments={seg} title="Ingestion status (files)" /> : <div className="w-16 h-16 rounded-full border-[9px] border-jj-gray-01" />}
            <div>
              <div className="text-[11px] font-johnson-text text-jj-gray-06 uppercase tracking-wide">Ingested OK</div>
              <div className="font-johnson-display font-bold text-[22px] text-jj-gray-08 tabular-nums">{total ? `${Math.round((ok / total) * 1000) / 10}%` : '—'}</div>
              <div className="text-[10.5px] font-johnson-text text-jj-gray-05">{ok.toLocaleString()} of {total.toLocaleString()} files</div>
            </div>
          </>
        )}
      </div>
      <div className="border border-jj-gray-02 rounded-xl px-4 py-3.5">
        <div className="text-[12px] font-johnson-text font-bold text-jj-gray-08 mb-2">Content types</div>
        <CardBody st={content} height={90} isEmpty={noRows} render={() => <RankedBars data={bars(content, CONTENT_COLORS)} unit="Chunks" onPick={(raw) => ctx.toggleFilter('CONTENT_TYPE', raw)} />} />
      </div>
      <div className="border border-jj-gray-02 rounded-xl px-4 py-3.5">
        <div className="text-[12px] font-johnson-text font-bold text-jj-gray-08 mb-2">Chunk levels</div>
        <CardBody st={levels} height={90} isEmpty={noRows} render={() => <RankedBars data={bars(levels, LEVEL_COLORS)} unit="Chunks" onPick={(raw) => ctx.toggleFilter('CHUNK_LEVEL', raw)} />} />
      </div>
    </div>
  );
}

/* ============================== DOCUMENTS ============================== */

const SORTS = [
  { id: 'modified', label: 'Last modified', dir: 'desc' },
  { id: 'title', label: 'Title', dir: 'asc' },
  { id: 'edms', label: 'EDMS number', dir: 'asc' },
  { id: 'product', label: 'Product', dir: 'asc' },
  { id: 'pages', label: 'Pages', dir: 'desc' },
  { id: 'versions', label: 'Versions', dir: 'desc' },
  { id: 'tables', label: 'Tables', dir: 'desc' },
  { id: 'matches', label: 'Matches', dir: 'desc' },
];

function LibraryView({ ctx }) {
  const [sort, setSort] = useState('modified');
  const [dir, setDir] = useState('desc');
  const [pageSize, setPageSize] = useState(25);
  const baseKey = `${ctx.scopeKey}|${sort}|${dir}|${pageSize}`;
  const [pageState, setPageState] = useState({ key: baseKey, page: 1 });
  const page = pageState.key === baseKey ? pageState.page : 1;
  const lib = useScoped(ctx, 'vr-library', '/library', { page, page_size: pageSize, sort, sort_dir: dir });
  const rows = lib.data?.rows || [];
  const narrowed = Object.keys(ctx.scope.search).some(c => c === 'CHUNK_TEXT' || c === 'SECTION_TITLE')
    || (ctx.scope.filters.CONTENT_TYPE || []).length > 0 || (ctx.scope.filters.CHUNK_LEVEL || []).length > 0;


  const pickSort = (id) => {
    const s = SORTS.find(x => x.id === id);
    ctx.logInPage('sort_change', `${ctx.label}: documents sorted by ${s.label}`);
    setSort(id);
    setDir(s.dir);
  };

  const grid = { gridTemplateColumns: `minmax(260px,2.4fr) 110px 110px 150px 70px 80px 70px${narrowed ? ' 80px' : ''} 100px` };
  const head = ['Document', 'Product', 'Version', 'Last modified', 'Pages', 'Sections', 'Tables', ...(narrowed ? ['Matches'] : []), 'Status'];

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3.5 p-5 overflow-hidden">
      {lib.error && <ErrorBanner message={lib.error} onRetry={lib.retry} />}
      <Card className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="flex-shrink-0 flex items-center justify-between gap-3 px-[18px] py-3 border-b border-jj-gray-01 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-[13px] font-johnson-text font-bold text-jj-gray-08">
              Documents <span className="font-normal text-jj-gray-05 text-[11.5px] tabular-nums">{lib.data ? (lib.data.total_count ?? 0).toLocaleString() : '…'}</span>
            </div>
            <div className="relative w-[260px]">
              <Icon src={searchIcon} tint="gray" className="w-3 h-3 absolute left-2.5 top-[9px]" />
              <input value={ctx.searchText.TITLE || ''} onChange={e => ctx.setSearchText('TITLE', e.target.value)}
                placeholder="Find a document by title…"
                className="w-full pl-8 pr-2 py-[7px] text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03" />
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <SqlLink ctx={ctx} title="Documents" sql={lib.data?.sql} />
            <span className="text-[11px] font-johnson-text text-jj-gray-06">Sort</span>
            <select value={sort} onChange={e => pickSort(e.target.value)} className={selectCls}>
              {SORTS.filter(s => s.id !== 'matches' || narrowed).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            <button onClick={() => setDir(d => (d === 'asc' ? 'desc' : 'asc'))} className={btnCls} title="Flip sort direction">
              {dir === 'asc' ? '↑ Asc' : '↓ Desc'}
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 relative">
          {lib.loading && <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-10"><LoadingSpinner /></div>}
          <div className="h-full overflow-auto">
            <div className="min-w-[980px] font-johnson-text">
              <div className="grid px-[18px] bg-[#faf9f8] border-b border-jj-gray-02 sticky top-0 z-[5]" style={grid}>
                {head.map((h, i) => (
                  <div key={h} className={`text-[10.5px] font-bold uppercase tracking-wider text-jj-gray-06 py-2.5 ${i >= 4 && h !== 'Status' ? 'text-right pr-3' : 'pr-2'}`}>{h}</div>
                ))}
              </div>
              {rows.map(r => (
                <div key={r.DOC_ID} onClick={() => ctx.openDoc(r.DOC_ID)}
                  className="grid px-[18px] border-b border-jj-gray-01 hover:bg-jj-blue-03/[.04] cursor-pointer items-center" style={grid}>
                  <div className="py-2.5 pr-3 min-w-0">
                    <div className="text-[12.5px] font-medium text-jj-gray-08 truncate" title={r.TITLE || ''}>{blank(r.TITLE) ? (r.NAME || r.FILE_NAME) : r.TITLE}</div>
                    <div className="text-[10.5px] text-jj-gray-05 truncate" title={r.NAME || ''}>
                      {r.EDMS_NUMBER || '—'}{!blank(r.NAME) && r.NAME !== r.TITLE && ` · ${r.NAME}`}
                    </div>
                  </div>
                  <div className="pr-2"><ProductTag name={r.PRODUCT_NAME} color={productColor(r.PRODUCT_NAME)} /></div>
                  <div className="pr-2 text-[12px] text-jj-gray-08">
                    {blank(r.VERSION_LABEL) ? '—' : `v${r.VERSION_LABEL}`}
                    {r.VERSIONS > 1 && <span className="text-[10.5px] text-jj-gray-05"> · {r.VERSIONS} versions</span>}
                  </div>
                  <div className="pr-2 min-w-0">
                    <div className="text-[12px] text-jj-gray-08 tabular-nums">{fmtDate(r.MODIFIED_TS)}</div>
                    <div className="text-[10.5px] text-jj-gray-05 truncate">{blank(r.MODIFIED_BY) ? timeAgo(r.MODIFIED_TS) : `${r.MODIFIED_BY} · ${timeAgo(r.MODIFIED_TS)}`}</div>
                  </div>
                  <div className="pr-3 text-right text-[12px] tabular-nums text-jj-gray-08">{r.PAGES_TOTAL != null ? Number(r.PAGES_TOTAL).toLocaleString() : '—'}</div>
                  <div className="pr-3 text-right text-[12px] tabular-nums text-jj-gray-07">{(r.SECTIONS ?? 0).toLocaleString()}</div>
                  <div className="pr-3 text-right text-[12px] tabular-nums text-jj-gray-07">{(r.TABLES ?? 0).toLocaleString()}</div>
                  {narrowed && <div className="pr-3 text-right text-[12px] tabular-nums font-medium text-jj-blue-03">{(r.MATCHING ?? 0).toLocaleString()}</div>}
                  <div>{blank(r.STATUS) ? '—' : <Pill value={r.STATUS} color={INGESTION_COLORS[String(r.STATUS).toUpperCase()] || '#6e6259'} />}</div>
                </div>
              ))}
              {!lib.loading && !lib.error && rows.length === 0 && (
                <div className="px-3 py-10 text-center text-xs text-jj-gray-06">No documents match the current filters.</div>
              )}
            </div>
          </div>
        </div>

        <div className="flex-shrink-0 flex items-center justify-between px-[18px] py-2.5 border-t border-jj-gray-01">
          <div className="flex items-center gap-2 text-[11.5px] font-johnson-text text-jj-gray-06">
            Latest version shown per document · click a row to open it
            <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))} className={`ml-2 ${selectCls}`}>
              {[25, 50, 100].map(n => <option key={n} value={n}>{n}/page</option>)}
            </select>
          </div>
          <Pager page={page} totalPages={lib.data?.total_pages || 1} loading={lib.loading}
            onGo={(n) => setPageState({ key: baseKey, page: Math.max(1, Math.min(lib.data?.total_pages || 1, n)) })} />
        </div>
      </Card>
    </div>
  );
}

/* ============================== DOCUMENT PANEL ============================== */

// consecutive chunks with the same SECTION_TITLE make one section
function groupSections(chunks) {
  const out = [];
  chunks.forEach(c => {
    const title = blank(c.SECTION_TITLE) ? 'Untitled section' : String(c.SECTION_TITLE).trim();
    let s = out[out.length - 1];
    if (!s || s.title !== title) {
      s = { key: `${out.length}-${title}`, title, from: c.PAGE_START, to: c.PAGE_END, chunks: [], types: new Set() };
      out.push(s);
    }
    s.chunks.push(c);
    if (c.PAGE_START != null && (s.from == null || c.PAGE_START < s.from)) s.from = c.PAGE_START;
    if (c.PAGE_END != null && (s.to == null || c.PAGE_END > s.to)) s.to = c.PAGE_END;
    parseContentTypes(c.CONTENT_TYPES).forEach(t => s.types.add(t));
  });
  return out;
}

function VrDocumentDrawer({ api, docId, focusChunkId, onClose, logInPage, logKey }) {
  const [tab, setTab] = useState('contents');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [versions, setVersions] = useState(null);
  const [q, setQ] = useState('');
  const [openSec, setOpenSec] = useState(new Set());
  const [openChunk, setOpenChunk] = useState(new Set(focusChunkId ? [focusChunkId] : []));
  const [copied, setCopied] = useState(false);
  const focusRef = useRef(null);

  const [attempt, setAttempt] = useState(0);
  const load = () => setAttempt(a => a + 1);
  useEffect(() => {
    let alive = true;
    setError(null);
    setData(null);
    fetchJson(`${api}/document?doc_id=${encodeURIComponent(docId)}&distinct_chunks=true`)
      .then(d => alive && setData(d))
      .catch(e => alive && setError(e.message));
    return () => { alive = false; };
  }, [api, docId, attempt]);

  useEffect(() => {
    if (tab !== 'versions' || versions) return undefined;
    let alive = true;
    fetchJson(`${api}/versions?doc_id=${encodeURIComponent(docId)}`)
      .then(d => alive && setVersions({ rows: d.versions || [] }))
      .catch(e => alive && setVersions({ error: e.message }));
    return () => { alive = false; };
  }, [tab, versions, api, docId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const doc = data?.document || {};
  const sections = useMemo(() => groupSections(data?.chunks || []), [data]);

  // open the section holding the chunk we came from, then scroll to it
  useEffect(() => {
    if (!focusChunkId || !sections.length) return;
    const s = sections.find(x => x.chunks.some(c => c.CHUNK_ID === focusChunkId));
    if (s) setOpenSec(prev => new Set(prev).add(s.key));
    setTimeout(() => focusRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120);
  }, [sections, focusChunkId]);

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? sections.filter(s => s.title.toLowerCase().includes(needle) || s.chunks.some(c => String(c.PREVIEW || '').toLowerCase().includes(needle)))
    : sections;
  const tableSections = sections.filter(s => s.types.has('table')).length;

  const toggle = (setter, id) => setter(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(doc.S3_PATH || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* still visible in Details */ }
  };

  const tabs = [
    { id: 'contents', label: `Contents${sections.length ? ` (${sections.length})` : ''}` },
    { id: 'versions', label: 'Versions' },
    { id: 'details', label: 'Details' },
  ];

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="w-full max-w-[700px] h-full bg-white shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex-shrink-0 px-5 pt-4 pb-3 border-b border-jj-gray-02">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                {!blank(doc.PRODUCT_NAME) && <ProductTag name={doc.PRODUCT_NAME} color={productColor(doc.PRODUCT_NAME)} />}
                <span className="text-[11px] font-johnson-text text-jj-gray-06">{doc.EDMS_NUMBER}</span>
                {!blank(doc.VERSION_LABEL) && <span className="text-[11px] font-johnson-text text-jj-gray-06">· v{doc.VERSION_LABEL} (latest)</span>}
              </div>
              <h3 className="font-johnson-display font-bold text-[17px] text-jj-gray-08 break-words">{!data && !error ? <span className="text-jj-gray-05">Loading document…</span> : (doc.TITLE || doc.NAME || doc.FILE_NAME || docId)}</h3>
              {!blank(doc.NAME) && doc.NAME !== doc.TITLE && <div className="text-xs font-johnson-text text-jj-gray-07 mt-0.5 break-words">{doc.NAME}</div>}
              <div className="flex items-center gap-3 mt-2 flex-wrap text-[11px] font-johnson-text text-jj-gray-06">
                {!blank(doc.MODIFIED) && <span>Modified {fmtDate(doc.MODIFIED)}{!blank(doc.MODIFIED_BY) && ` by ${doc.MODIFIED_BY}`}</span>}
                {doc.PAGES_TOTAL != null && <span>{Number(doc.PAGES_TOTAL).toLocaleString()} pages</span>}
                {sections.length > 0 && <span>{sections.length} sections · {tableSections} with tables</span>}
                {!blank(doc.S3_PATH) && (
                  <button onClick={copyPath} className="text-jj-blue-03 underline">{copied ? 'Copied' : 'Copy S3 path'}</button>
                )}
              </div>
            </div>
            <button onClick={onClose} className="flex-shrink-0 p-1"><Icon src={closeIcon} alt="Close" tint="ink" className="w-4 h-4" /></button>
          </div>
          <div className="flex gap-1 mt-3">
            {tabs.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-3.5 py-[5px] rounded-full text-[11.5px] font-johnson-text ${tab === t.id ? 'bg-jj-gray-08 text-white font-medium' : 'text-jj-gray-07 hover:bg-jj-gray-01'}`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && <div className="p-4"><ErrorBanner message={error} onRetry={load} /></div>}
          {!data && !error && <div className="py-16"><LoadingSpinner /></div>}

          {data && tab === 'contents' && (
            <>
              <div className="px-5 pt-4 pb-2 sticky top-0 bg-white z-[2]">
                <div className="relative">
                  <Icon src={searchIcon} tint="gray" className="w-3 h-3 absolute left-2.5 top-[10px]" />
                  <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find in this document…"
                    className="w-full pl-8 pr-2 py-2 text-xs font-johnson-text rounded-lg border border-jj-gray-03 focus:outline-none focus:border-jj-blue-03" />
                </div>
                {needle && <div className="text-[10.5px] font-johnson-text text-jj-gray-05 mt-1.5">{shown.length} of {sections.length} sections</div>}
              </div>
              <div className="px-5 pb-6 flex flex-col">
                {shown.map(s => {
                  const isOpen = openSec.has(s.key) || (!!needle && shown.length <= 5);
                  const pages = s.from == null ? '' : s.to != null && s.to !== s.from ? `pp. ${s.from}–${s.to}` : `p. ${s.from}`;
                  return (
                    <div key={s.key} className="border-b border-jj-gray-01 last:border-0">
                      <button onClick={() => toggle(setOpenSec, s.key)} className="w-full flex items-center gap-2 py-2.5 text-left hover:bg-jj-gray-01/50 rounded">
                        <Icon src={isOpen ? chevronDownIcon : chevronRightIcon} tint="gray" className="w-2.5 h-2.5 flex-shrink-0" />
                        <span className="flex-1 min-w-0 truncate text-[12.5px] font-johnson-text font-medium text-jj-gray-08"><Highlight text={s.title} term={needle} /></span>
                        {s.types.has('table') && <span className="text-[10px] font-johnson-text px-1.5 py-[1px] rounded" style={{ background: '#32871414', color: '#328714' }}>table</span>}
                        <span className="text-[10.5px] font-johnson-text text-jj-gray-06 tabular-nums w-[70px] text-right flex-shrink-0">{pages}</span>
                      </button>
                      {isOpen && (
                        <div className="pl-5 pb-3 flex flex-col gap-2">
                          {s.chunks.map(c => {
                            const chunkOpen = openChunk.has(c.CHUNK_ID);
                            const focused = c.CHUNK_ID === focusChunkId;
                            return (
                              <div key={c.CHUNK_ID} ref={focused ? focusRef : undefined}
                                className={`border rounded-xl px-3 py-2 ${focused ? 'border-jj-blue-03/60 bg-jj-blue-03/[.04]' : 'border-jj-gray-02'}`}>
                                <button className="w-full text-left" onClick={() => {
                                  if (!chunkOpen) logInPage(`${logKey}_chunk_view`, `Opened chunk ${c.CHUNK_ID} in ${doc.TITLE || docId}`);
                                  toggle(setOpenChunk, c.CHUNK_ID);
                                }}>
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10.5px] font-johnson-text text-jj-gray-05 tabular-nums">p.{c.PAGE_START}{c.PAGE_END != null && c.PAGE_END !== c.PAGE_START ? `–${c.PAGE_END}` : ''}</span>
                                    <ContentChips value={c.CONTENT_TYPES} />
                                    <span className="ml-auto text-[10.5px] font-johnson-text text-jj-blue-03">{chunkOpen ? 'Hide text' : 'Read'}</span>
                                  </div>
                                  {!chunkOpen && c.PREVIEW && (
                                    <div className="text-[11.5px] font-johnson-text text-jj-gray-06 mt-1 line-clamp-2"><Highlight text={c.PREVIEW} term={needle} /></div>
                                  )}
                                </button>
                                {chunkOpen && <ChunkText api={api} chunkId={c.CHUNK_ID} />}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {shown.length === 0 && <div className="text-xs font-johnson-text text-jj-gray-06 py-8 text-center">Nothing in this document matches.</div>}
              </div>
            </>
          )}

          {data && tab === 'versions' && (
            <div className="p-5">
              {!versions && <LoadingSpinner />}
              {versions?.error && <ErrorBanner message={versions.error} onRetry={() => setVersions(null)} />}
              {versions?.rows && (
                <div className="relative pl-5">
                  <div className="absolute left-[5px] top-2 bottom-2 w-px bg-jj-gray-03" />
                  {versions.rows.map((v, i) => (
                    <div key={`${v.VERSION_LABEL}-${v.MODIFIED}-${i}`} className="relative pb-4 last:pb-0">
                      <span className={`absolute -left-5 top-[5px] w-[11px] h-[11px] rounded-full border-2 border-white ${i === 0 ? 'bg-jj-red' : 'bg-jj-gray-04'}`} />
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-johnson-text font-bold text-jj-gray-08">Version {v.VERSION_LABEL ?? '—'}</span>
                        {i === 0 && <Pill value="Latest" color="#328714" />}
                        {v.RANKING != null && <span className="ml-auto text-[10.5px] font-johnson-text text-jj-gray-05 tabular-nums">Ranking {Number(v.RANKING).toFixed(3)}</span>}
                      </div>
                      <div className="text-[11.5px] font-johnson-text text-jj-gray-07 mt-0.5">
                        {fmtDate(v.MODIFIED_TS || v.MODIFIED)}{!blank(v.MODIFIED_BY) && ` · ${v.MODIFIED_BY}`}{v.MODIFIED_TS && ` · ${timeAgo(v.MODIFIED_TS)}`}
                      </div>
                      {!blank(v.TITLE) && v.TITLE !== doc.TITLE && <div className="text-[11px] font-johnson-text text-jj-gray-05 mt-0.5">Title then: {v.TITLE}</div>}
                    </div>
                  ))}
                  {versions.rows.length === 0 && <NoData />}
                </div>
              )}
            </div>
          )}

          {data && tab === 'details' && (
            <div className="px-5 py-3">
              {[...DOC_META_FIELDS.filter(f => f in doc), ...Object.keys(doc).filter(f => !DOC_META_FIELDS.includes(f))].map(f => (
                <div key={f} className="flex text-xs font-johnson-text border-b border-jj-gray-01 last:border-0 py-2">
                  <div className="w-[34%] text-jj-gray-06 flex-shrink-0">{DETAIL_LABELS[f] || f}</div>
                  <div className="w-[66%] text-jj-gray-08 break-words">{renderCell(f, doc[f])}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ============================== config ============================== */

const VIRTUAL_REGULATOR_CONFIG = {
  apiPath: '/api/virtual-regulator',
  label: 'Virtual Regulator',
  logKey: 'virtual_regulator',
  filters: FILTERS,
  searches: SEARCHES,
  docTableOrder: DOC_TABLE_ORDER,
  chunkTableOrder: CHUNK_TABLE_ORDER,
  metaFields: DOC_META_FIELDS,
  defaultDimension: null,
  defaultLevels: null,
  // every chunk is repeated once per EDMS version
  distinctChunks: true,
  views: { explore: OverviewView, library: LibraryView },
  Drawer: VrDocumentDrawer,
};

export default function VirtualRegulatorExplorer(props) {
  return <ChunkExplorer config={VIRTUAL_REGULATOR_CONFIG} {...props} />;
}