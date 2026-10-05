import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, Navigate } from 'react-router-dom';
import LoadingSpinner from './components/LoadingSpinner';
import BusinessDefinedChecks from './BusinessDefinedChecks';
import DataValidation from './DataValidation';
import { useRBAC } from '../context/RBACContext';

// J&J Custom Icons
import alertTriangleIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import databaseIcon from "/icons/JJ_Icon_Database_RGB.svg";
import barChartIcon from "/icons/JJ_Icon_Graph_Chart_RGB.svg";
import shieldCheckIcon from "/icons/JJ_Icon_Safety.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import { apiFetch } from '../utils/apiClient';
import ITChecksView from './ITChecksView';

// ─── Icon Wrapper ─────────────────────────────────────────────────────────────
const Icon = ({ src, alt, className = "w-6 h-6", color }) => {
  const getColorFilter = (colorClass) => {
    if (!colorClass) return {};
    const c = color || colorClass;
    if (c.includes('jj-green-03') || c.includes('text-green'))
      return { filter: 'brightness(0) saturate(100%) invert(37%) sepia(87%) saturate(1158%) hue-rotate(71deg) brightness(91%) contrast(93%)' };
    if (c.includes('jj-maroon-05') || c.includes('text-red'))
      return { filter: 'brightness(0) saturate(100%) invert(13%) sepia(97%) saturate(6477%) hue-rotate(359deg) brightness(91%) contrast(99%)' };
    if (c.includes('jj-orange-03'))
      return { filter: 'brightness(0) saturate(100%) invert(48%) sepia(97%) saturate(2446%) hue-rotate(347deg) brightness(102%) contrast(105%)' };
    if (c.includes('jj-blue-03'))
      return { filter: 'brightness(0) saturate(100%) invert(37%) sepia(93%) saturate(1535%) hue-rotate(189deg) brightness(91%) contrast(101%)' };
    if (c.includes('jj-blue-05'))
      return { filter: 'brightness(0) saturate(100%) invert(20%) sepia(93%) saturate(1535%) hue-rotate(200deg) brightness(91%) contrast(101%)' };
    if (c.includes('jj-red'))
      return { filter: 'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)' };
    if (c.includes('jj-gray-08'))
      return { filter: 'brightness(0) saturate(100%) invert(15%) sepia(7%) saturate(806%) hue-rotate(346deg) brightness(95%) contrast(89%)' };
    if (c.includes('jj-gray-06'))
      return { filter: 'brightness(0) saturate(100%) invert(50%) sepia(6%) saturate(656%) hue-rotate(346deg) brightness(92%) contrast(88%)' };
    if (c.includes('jj-gray-05'))
      return { filter: 'brightness(0) saturate(100%) invert(65%) sepia(6%) saturate(556%) hue-rotate(346deg) brightness(92%) contrast(88%)' };
    if (c.includes('jj-gray-04'))
      return { filter: 'brightness(0) saturate(100%) invert(82%) sepia(6%) saturate(356%) hue-rotate(346deg) brightness(92%) contrast(88%)' };
    if (c.includes('white') || c.includes('invert'))
      return { filter: 'brightness(0) invert(1)' };
    return {};
  };
  return (
    <img src={src} alt={alt} className={className} style={getColorFilter(className)} />
  );
};

// ─── Error Boundary ───────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error, info) { console.error('DQEngine Error:', error, info); }
  render() {
    if (this.state.hasError) return (
      <div className="min-h-screen flex items-center justify-center bg-jj-gray-01 p-6">
        <div className="bg-white rounded-xl shadow-xl p-8 max-w-lg w-full border-t-4 border-jj-red">
          <div className="flex items-start gap-4 mb-6">
            <div className="w-12 h-12 bg-red-50 rounded-lg flex items-center justify-center flex-shrink-0">
              <Icon src={alertTriangleIcon} alt="Error" className="w-7 h-7 text-jj-maroon-05" />
            </div>
            <div>
              <h2 className="font-johnson-display text-xl text-jj-gray-08 mb-1" style={{ lineHeight: '110%' }}>Something went wrong</h2>
              <p className="font-johnson-text text-sm text-jj-gray-06">An unexpected error occurred while loading the Data Quality Engine.</p>
            </div>
          </div>
          <button onClick={() => window.location.reload()}
            className="w-full py-3 rounded-lg font-johnson-text font-bold text-sm bg-jj-red text-white hover:bg-jj-maroon-05 transition-colors duration-200">
            Reload Page
          </button>
        </div>
      </div>
    );
    return this.props.children;
  }
}

// ─── URL param allowlists ─────────────────────────────────────────────────────
const VALID_CHECKS = ['IT_Checks', 'Data_Validation', 'Business_defined_checks'];

const NetworkCanvas = () => {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;
    const ctx = canvas.getContext('2d');

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.offsetWidth * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    };
    resize();
    const resizeObs = new ResizeObserver(resize);
    resizeObs.observe(wrap);

    const NODES = [
      { fx: .82, fy: .12, r: 7, hue: 'blue', pulse: 0,   ps: .007 },
      { fx: .94, fy: .38, r: 9, hue: 'red',  pulse: 1.6, ps: .005 },
      { fx: .70, fy: .62, r: 6, hue: 'blue', pulse: 3.1, ps: .008 },
      { fx: .58, fy: .22, r: 5, hue: 'red',  pulse: .9,  ps: .009 },
      { fx: .88, fy: .78, r: 7, hue: 'blue', pulse: 2.4, ps: .006 },
      { fx: .50, fy: .48, r: 5, hue: 'blue', pulse: 4.2, ps: .010 },
      { fx: .96, fy: .60, r: 6, hue: 'red',  pulse: 1.1, ps: .007 },
      { fx: .65, fy: .88, r: 5, hue: 'red',  pulse: 5.0, ps: .008 },
      { fx: .78, fy: .46, r: 6, hue: 'blue', pulse: 0.5, ps: .006 },
    ];
    const EDGES = [
      [0, 1], [1, 2], [0, 3], [3, 1], [2, 4], [1, 4],
      [3, 5], [5, 2], [1, 6], [4, 6], [1, 8], [8, 2],
      [8, 4], [0, 8], [5, 7], [2, 7], [6, 4],
    ];
    const PACKETS = EDGES.map(([a, b], i) => ({
      a, b, t: Math.random(), speed: .0025 + Math.random() * .003,
      hue: i % 3 === 0 ? 'red' : 'blue',
    }));

    const BLUE = (a) => `rgba(15,104,178,${a})`;
    const RED = (a) => `rgba(235,23,0,${a})`;
    const col = (hue, a) => (hue === 'blue' ? BLUE(a) : RED(a));

    let raf;
    const draw = () => {
      const W = canvas.offsetWidth, H = canvas.offsetHeight;
      ctx.clearRect(0, 0, W, H);

      // Edges
      EDGES.forEach(([ai, bi]) => {
        const na = NODES[ai], nb = NODES[bi];
        const ax = na.fx * W, ay = na.fy * H, bx = nb.fx * W, by = nb.fy * H;
        const grad = ctx.createLinearGradient(ax, ay, bx, by);
        grad.addColorStop(0, BLUE(.18));
        grad.addColorStop(.5, BLUE(.28));
        grad.addColorStop(1, BLUE(.18));
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      });

      // Packets travelling along edges
      PACKETS.forEach(p => {
        p.t = (p.t + p.speed) % 1;
        const na = NODES[p.a], nb = NODES[p.b];
        const x = na.fx * W + (nb.fx * W - na.fx * W) * p.t;
        const y = na.fy * H + (nb.fy * H - na.fy * H) * p.t;
        const tx = na.fx * W + (nb.fx * W - na.fx * W) * Math.max(0, p.t - .06);
        const ty = na.fy * H + (nb.fy * H - na.fy * H) * Math.max(0, p.t - .06);
        const grad = ctx.createLinearGradient(tx, ty, x, y);
        grad.addColorStop(0, col(p.hue, 0));
        grad.addColorStop(1, col(p.hue, .65));
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(x, y);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 2.8, 0, Math.PI * 2);
        ctx.fillStyle = col(p.hue, .85);
        ctx.fill();
      });

      // Nodes with pulsing glow
      NODES.forEach(n => {
        n.pulse = (n.pulse + n.ps) % (Math.PI * 2);
        const x = n.fx * W, y = n.fy * H;
        const sin = (Math.sin(n.pulse) + 1) / 2;

        const pR = n.r + 8 + sin * 22;
        ctx.beginPath();
        ctx.arc(x, y, pR, 0, Math.PI * 2);
        ctx.strokeStyle = col(n.hue, .08 + sin * .18);
        ctx.lineWidth = 1.2;
        ctx.stroke();

        const mR = n.r + 3 + sin * 10;
        ctx.beginPath();
        ctx.arc(x, y, mR, 0, Math.PI * 2);
        ctx.strokeStyle = col(n.hue, .18 + sin * .22);
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.shadowColor = n.hue === 'blue' ? 'rgba(15,104,178,.5)' : 'rgba(235,23,0,.5)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(x, y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = col(n.hue, .22 + sin * .18);
        ctx.fill();
        ctx.strokeStyle = col(n.hue, .55 + sin * .3);
        ctx.lineWidth = 1.8;
        ctx.stroke();
        ctx.shadowBlur = 0;

        ctx.beginPath();
        ctx.arc(x, y, n.r * .4, 0, Math.PI * 2);
        ctx.fillStyle = col(n.hue, .7 + sin * .3);
        ctx.fill();
      });

      raf = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      resizeObs.disconnect();
    };
  }, []);

  return (
    <div ref={wrapRef} className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 1 }}>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════════
function DataQualityEngine() {
  const { hasPermission } = useRBAC();
  const [searchParams, setSearchParams] = useSearchParams();
  const [reportData, setReportData] = useState(null);
  const [showWelcome, setShowWelcome] = useState(true);
  const [selectedCheckType, setSelectedCheckType] = useState(() => {
    const v = searchParams.get('check') ?? '';
    return VALID_CHECKS.includes(v) ? v : '';
  });
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [availableRuns, setAvailableRuns] = useState([]);
  const [runsMerged,    setRunsMerged]    = useState(null);
  const [newestDate, setNewestDate]   = useState(null);
  const [oldestDate, setOldestDate]   = useState(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [oracleConnections, setOracleConnections] = useState({ configured: [], has_default: true });

  // ── Unmount guard — prevents async callbacks (especially setSearchParams)
  //    from firing after the user has already navigated away from /dqe.
  //    Without this, a slow fetch completing after navigation calls setSearchParams
  //    which acts like navigate() and yanks the user back to the DQE page.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ── Derive which check types this user can access ──
  const availableCheckTypes = useMemo(() => [
    hasPermission('viewITChecks')       && 'IT_Checks',
    hasPermission('viewDataValidation') && 'Data_Validation',
    hasPermission('viewBusinessChecks') && 'Business_defined_checks',
  ].filter(Boolean), [hasPermission]);

  // ── Fetch which Oracle connections are configured ──
  useEffect(() => {
    apiFetch(`/dq/oracle_connections`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setOracleConnections(data); })
      .catch(() => {});
  }, []);
  // Skips the welcome screen entirely and jumps straight to the content.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (autoLoadedRef.current) return;           // already fired
    if (availableCheckTypes.length !== 1) return; // not a single-access user
    if (searchParams.get('check')) return;        // URL already has a check (back/forward nav)
    autoLoadedRef.current = true;
    const only = availableCheckTypes[0];
    setSelectedCheckType(only);
    handleLoadData(null, only, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableCheckTypes]);

  // ── Track what params are currently "loaded" so the URL effect can compare
  //    against the actual loaded state instead of stale closure values.
  const loadedParamsRef = useRef({ check: '' });
  // Only the newest load may write state; a slow earlier response must not overwrite it.
  const loadSeq = useRef(0);

  // A table can be refreshed only if its source Oracle connection is configured.
  const canRefreshTable = useCallback((table) => {
    if (!hasPermission('runITChecks')) return 'hidden';
    if (oracleConnections.configured.length === 0 && !oracleConnections.has_default) return 'no-connection';
    if (oracleConnections.has_default) return 'active';
    const key = (table.source_db || table.target_database || '').toUpperCase();
    const connected = !!key && oracleConnections.configured.some(k => key.includes(k.toUpperCase()));
    return connected ? 'active' : 'no-connection';
  }, [hasPermission, oracleConnections]);

  const handleCheckTypeChange = useCallback((t) => {
    setSelectedCheckType(t);
    setLoadError('');
  }, []);

  const resetState = useCallback(() => {
    // Do NOT clear loadedParamsRef here. The URL effect reads it to decide whether
    // a reset is needed — if we clear it before setSearchParams fires, the guard
    // (loadedParamsRef.current.env !== '') evaluates false and setShowWelcome(true)
    // is never called, leaving the page stuck on the current view.
    // The URL effect clears loadedParamsRef itself once it runs the reset.
    setSearchParams({});
  }, [setSearchParams]);

  const handleLoadData = useCallback(async (loadDates = null, checkArg = null, fromNavigation = false) => {
    // loadDates: null = all runs, string = single run, string[] = subset of runs
    const check = checkArg ?? selectedCheckType;

    if (!check) { setLoadError('Please select a check type.'); return; }

    if (check === 'IT_Checks' && !hasPermission('viewITChecks')) {
      setLoadError('You do not have permission to access IT Checks.');
      return;
    }

    if (check === 'Business_defined_checks') {
      if (!hasPermission('viewBusinessChecks')) {
        setLoadError('You do not have permission to access Business Defined Checks.');
        return;
      }
      if (!fromNavigation) { setSearchParams({ check }); }
      loadedParamsRef.current = { check };
      setShowWelcome(false);
      setLoadError('');
      return;
    }

    const seq = ++loadSeq.current;
    const stale = () => seq !== loadSeq.current || !isMountedRef.current;
    setIsLoading(true); setLoadError('');
    // IT Checks opens straight away and shows its own placeholders while data loads.
    // Mark it loaded first so the URL effect below doesn't fire a second load.
    if (check === 'IT_Checks') {
      loadedParamsRef.current = { check };
      if (!fromNavigation) setSearchParams(prev => { const p = new URLSearchParams(prev); p.set('check', check); return p; });
      setShowWelcome(false);
    }
    try {
      if (!loadDates || !availableRuns.length) {
        setRunsLoading(true);
        try {
          const datesRes = await apiFetch(`/dq/validation_report_dates`);
          if (datesRes.ok) {
            const datesData = await datesRes.json();
            if (!stale()) setAvailableRuns(datesData.runs || []);
          }
        } finally {
          setRunsLoading(false);
        }
      }

      // Build URL based on what was selected
      let url = `/dq/validation_report`;
      if (Array.isArray(loadDates) && loadDates.length > 0) {
        url += loadDates.length === 1
          ? `?load_date=${encodeURIComponent(loadDates[0])}`
          : `?load_dates=${encodeURIComponent(loadDates.join(','))}`;
      } else if (typeof loadDates === 'string' && loadDates) {
        url += `?load_date=${encodeURIComponent(loadDates)}`;
      }
      // null → no params → all runs combined

      const res = await apiFetch(url);
      // 404 = no runs saved yet (fresh install / all runs trimmed): show the empty page, not an error
      const data = res.status === 404 && !loadDates ? { report_data: { pipeline_results: [] }, runs_merged: 0 } : null;
      if (!data && !res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || res.statusText || `HTTP ${res.status}`);
      }
      const payload = data || await res.json();
      if (stale()) return;
      if (!payload.report_data) throw new Error('Invalid data format from server');

      setReportData(payload.report_data);
      setRunsMerged(payload.runs_merged ?? 1);
      setNewestDate(payload.newest_date || null);
      setOldestDate(payload.oldest_date || null);
      // keep any view params (status, filters, open table…) already in the URL
      if (!fromNavigation && check !== 'IT_Checks') setSearchParams(prev => { const p = new URLSearchParams(prev); p.set('check', check); return p; });
      loadedParamsRef.current = { check };
      setShowWelcome(false);
    } catch (err) {
      if (stale()) return;
      console.error(err);
      setLoadError(`Failed to load data: ${err.message}`);
    } finally { if (!stale()) setIsLoading(false); }
  }, [selectedCheckType, setSearchParams, hasPermission, availableRuns.length]);

  // ── React to URL changes from back / forward navigation ──────────────────────
  // Uses loadedParamsRef (not state closures) so the comparison is always fresh.
  //
  // History flow:
  //   /dqe                        → welcome screen (params absent)
  //   /dqe?check=IT_Checks → data view     (params present)
  //
  //  Back  from data view → URL loses params → restore welcome screen
  //  Forward to data view → URL gains params  → auto-load data
  useEffect(() => {
    const check =  searchParams.get('check') ?? '';
    const isValidNav = VALID_CHECKS.includes(check);

    if (isValidNav) {
      if (check !== loadedParamsRef.current.check) {
        setSelectedCheckType(check);
        const runs = searchParams.getAll('run');
        handleLoadData(runs.length ? runs : null, check, true);
      }
    } else {
      if (loadedParamsRef.current.check !== '') {
        loadedParamsRef.current = { check: '' };
        setShowWelcome(true);
        setReportData(null);
        setAvailableRuns([]);
        setRunsMerged(null);
        setNewestDate(null);
        setOldestDate(null);
        setSelectedCheckType('');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]); // only re-run when the URL changes

  // Re-validate one table and patch it into reportData. Returns the new
  // validation_result; throws on failure so the caller can report it.
  const handleRevalidateTable = useCallback(async (table) => {
    const res = await apiFetch(`/dq/validate_single_table`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipeline_name:   table.pipeline_name,
        table_name:      table.table_name,
        source_schema:   table.source_schema,
        target_database: table.target_database,
        target_schema:   table.target_schema,
        snowflake_table: table.snowflake_table,
        source_db:       table.source_db || '',
      })
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || 'Validation failed'); }
    const data = await res.json();
    if (!data.success || !data.validation_result) throw new Error(data.message || data.detail || 'Validation failed');
    if (isMountedRef.current) {
      setReportData(prev => {
        if (!prev?.pipeline_results) return prev;
        return {
          ...prev,
          pipeline_results: prev.pipeline_results.map(pipeline => {
            if (pipeline.pipeline_name !== table.pipeline_name || !pipeline.validation_results?.table_validations) return pipeline;
            return {
              ...pipeline,
              validation_results: {
                ...pipeline.validation_results,
                // Replace, don't merge: an old row_counts / error must not survive a fresh result.
                // Keep only the merge annotations (_source_db, _oracle_schema, …).
                table_validations: pipeline.validation_results.table_validations.map(t =>
                  t.table_name === table.table_name
                    && (t._source_db || '') === (table.source_db || '')
                    && (t._oracle_schema || pipeline.oracle_schema || 'Unknown') === table.source_schema
                    ? { ...Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith('_'))), ...data.validation_result }
                    : t
                )
              }
            };
          })
        };
      });
    }
    return data.validation_result;
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // WELCOME SCREEN
  // ──────────────────────────────────────────────────────────────────────────
  if (showWelcome) {
    if (isLoading) return (
      <div className="flex items-center justify-center min-h-full bg-jj-gray-01">
        <div className="text-center">
          <LoadingSpinner />
          <p className="font-johnson-text mt-4 text-sm font-bold text-jj-gray-07">Loading validation data…</p>
        </div>
      </div>
    );

    const checkTypeOptions = [
      {
        value: 'IT_Checks', num: '01', label: 'IT Checks',
        desc: 'Row counts, schema validation, constraint reconciliation etc.',
      },
      {
        value: 'Data_Validation', num: '02', label: 'Data Validation',
        desc: 'Guided source-to-target validation with a redesigned setup flow.',
        beta: true,
      },
      {
        value: 'Business_defined_checks', num: '03', label: 'Business Defined Checks',
        desc: 'Custom logic and data-quality rules tailored to your domain.',
      },
    ].filter(item => availableCheckTypes.includes(item.value));

    return (
      <div className="min-h-full flex bg-jj-gray-01" style={{ fontFamily: "'JohnsonText', Arial, sans-serif" }}>

        {/* ═══ LEFT PANEL ═══ */}
        <div className="hidden lg:flex relative overflow-hidden flex-col" style={{ flex: '0 0 58%' }}>
          {/* BG: warm base + dot grid */}
          <div className="absolute inset-0" style={{ background: '#f7f5f2' }} />
          <div className="absolute inset-0" style={{ backgroundImage: 'radial-gradient(circle, rgba(175,165,155,.45) 1px, transparent 1px)', backgroundSize: '26px 26px' }} />

          {/* BG: concentric data rings */}
          <div className="absolute" style={{
            right: -180, top: '50%', transform: 'translateY(-50%)', width: 760, height: 760, borderRadius: '50%',
            border: '1px solid rgba(15,104,178,.13)',
            boxShadow: '0 0 0 70px rgba(15,104,178,.05), 0 0 0 140px rgba(15,104,178,.04), 0 0 0 210px rgba(15,104,178,.03), 0 0 0 290px rgba(235,23,0,.025), 0 0 0 380px rgba(235,23,0,.015)',
            animation: 'dqe-ring 6s ease-in-out infinite',
          }} />
          <div className="absolute" style={{
            right: -180, top: '50%', transform: 'translateY(-50%)', width: 340, height: 340, borderRadius: '50%',
            border: '1.5px solid rgba(235,23,0,.12)', animation: 'dqe-ring 5s ease-in-out 1s infinite',
          }} />

          {/* BG: horizontal data streams */}
          <div className="absolute left-0 right-0" style={{ top: '28%', height: 1, overflow: 'hidden', opacity: .35 }}>
            <div style={{ height: 1, background: 'linear-gradient(90deg,transparent 0%,rgba(15,104,178,.6) 30%,rgba(15,104,178,.6) 70%,transparent 100%)', animation: 'dqe-stream 7s linear 0s infinite' }} />
          </div>
          <div className="absolute left-0 right-0" style={{ top: '44%', height: 1, overflow: 'hidden', opacity: .22 }}>
            <div style={{ height: 1, background: 'linear-gradient(90deg,transparent 0%,rgba(235,23,0,.5) 35%,rgba(235,23,0,.5) 65%,transparent 100%)', animation: 'dqe-stream 9s linear 2.5s infinite' }} />
          </div>
          <div className="absolute left-0 right-0" style={{ top: '66%', height: 1, overflow: 'hidden', opacity: .28 }}>
            <div style={{ height: 1, background: 'linear-gradient(90deg,transparent 0%,rgba(15,104,178,.5) 30%,rgba(15,104,178,.5) 70%,transparent 100%)', animation: 'dqe-stream 8s linear 1.2s infinite' }} />
          </div>

          {/* BG: radar sweep + dashed orbits */}
          <div className="absolute" style={{
            right: -180, top: '50%', width: 760, height: 760, borderRadius: '50%',
            background: 'conic-gradient(from 0deg,rgba(15,104,178,.07) 0deg,rgba(15,104,178,.03) 40deg,transparent 80deg,transparent 360deg)',
            animation: 'dqe-radar 12s linear infinite', transformOrigin: 'center center', transform: 'translateY(-50%)',
          }} />
          <div className="absolute" style={{ right: -180, top: '50%', width: 920, height: 920, borderRadius: '50%', border: '1.5px dashed rgba(15,104,178,.1)', animation: 'dqe-orbit 28s linear infinite' }} />
          <div className="absolute" style={{ right: -180, top: '50%', width: 480, height: 480, borderRadius: '50%', border: '1px dashed rgba(235,23,0,.1)', animation: 'dqe-radar 18s linear infinite' }} />

          {/* BG: scanline sweeps */}
          <div className="absolute left-0 right-0" style={{ height: '1.5px', background: 'linear-gradient(90deg,transparent 0%,rgba(15,104,178,.18) 25%,rgba(15,104,178,.3) 50%,rgba(15,104,178,.18) 75%,transparent 100%)', animation: 'dqe-scan 9s linear 0s infinite' }} />
          <div className="absolute left-0 right-0" style={{ height: 1, background: 'linear-gradient(90deg,transparent 0%,rgba(235,23,0,.15) 30%,rgba(235,23,0,.25) 50%,rgba(235,23,0,.15) 70%,transparent 100%)', animation: 'dqe-scan 9s linear 4.5s infinite' }} />

          {/* BG: vertical data streams */}
          <div className="absolute top-0 bottom-0" style={{ left: '62%', width: 1, overflow: 'hidden', opacity: .3 }}>
            <div style={{ width: 1, height: '100%', background: 'linear-gradient(180deg,transparent 0%,rgba(15,104,178,.55) 30%,rgba(15,104,178,.55) 70%,transparent 100%)', animation: 'dqe-vstream 6s linear 1s infinite' }} />
          </div>
          <div className="absolute top-0 bottom-0" style={{ left: '40%', width: 1, overflow: 'hidden', opacity: .18 }}>
            <div style={{ width: 1, height: '100%', background: 'linear-gradient(180deg,transparent 0%,rgba(235,23,0,.5) 35%,rgba(235,23,0,.5) 65%,transparent 100%)', animation: 'dqe-vstream 8s linear 3s infinite' }} />
          </div>

          {/* BG: floating data particles */}
          {[
            { right: '22%', top: '20%', size: 5, color: 'rgba(15,104,178,.4)',  dur: '5s',   delay: '0s' },
            { right: '38%', top: '35%', size: 4, color: 'rgba(235,23,0,.35)',  dur: '6.5s', delay: '.8s' },
            { right: '15%', top: '58%', size: 6, color: 'rgba(15,104,178,.3)', dur: '7s',   delay: '.4s' },
            { right: '45%', top: '72%', size: 3, color: 'rgba(235,23,0,.32)',  dur: '5.5s', delay: '1.6s' },
            { right: '28%', top: '12%', size: 4, color: 'rgba(15,104,178,.28)', dur: '8s',  delay: '2.2s' },
            { right: '52%', top: '52%', size: 5, color: 'rgba(235,23,0,.22)',  dur: '6s',   delay: '3s' },
            { right: '10%', top: '82%', size: 4, color: 'rgba(15,104,178,.25)', dur: '7.5s', delay: '1s' },
            { right: '33%', top: '88%', size: 3, color: 'rgba(235,23,0,.2)',   dur: '5.8s', delay: '4s' },
          ].map((p, i) => (
            <div key={i} className="absolute rounded-full" style={{ right: p.right, top: p.top, width: p.size, height: p.size, background: p.color, animation: `dqe-float ${p.dur} ease-in-out ${p.delay} infinite` }} />
          ))}

          {/* Animated canvas network graph, layered above the decorative backdrop */}
          <NetworkCanvas />

          {/* BG: fades for text legibility */}
          <div className="absolute inset-0" style={{ background: 'linear-gradient(100deg,rgba(247,245,242,.96) 0%,rgba(247,245,242,.88) 36%,rgba(247,245,242,.5) 58%,rgba(247,245,242,0) 100%)' }} />
          <div className="absolute bottom-0 left-0 right-0" style={{ height: 160, background: 'linear-gradient(to top,rgba(247,245,242,.92) 0%,transparent 100%)' }} />

          {/* ── Content layer ── */}
          <div className="relative flex flex-col h-full" style={{ zIndex: 2, padding: '36px 52px' }}>

            {/* Engine status */}
            <div className="flex items-center justify-between flex-wrap" style={{ gap: 16 }}>
              <div className="inline-flex items-center" style={{ gap: 8, padding: '7px 14px', borderRadius: 999, background: 'rgba(255,255,255,.68)', border: '1px solid #e8e6e3', backdropFilter: 'blur(10px)' }}>
                <span className="relative block flex-none rounded-full" style={{ width: 7, height: 7, background: '#328714' }}>
                  <span className="absolute inset-0 block rounded-full" style={{ background: '#328714', animation: 'dqe-pulse 2.6s ease-out infinite' }} />
                </span>
                <span className="font-johnson-text font-bold uppercase" style={{ fontSize: '10.5px', letterSpacing: '.08em', color: '#6e6259' }}>
                  Engine Online
                </span>
              </div>
            </div>

            {/* SmartHub logo — fixed 14px under the status badge */}
            <img
              src="/sh_logo.png"
              alt="GRA SmartHub"
              className="select-none"
              draggable={false}
              style={{ width: 'clamp(160px, 15vw, 220px)', height: 'auto', marginTop: 14, alignSelf: 'flex-start' }}
            />

            {/* Hero typography — stacked from the top so gaps stay fixed; the
                leftover vertical space falls below the text instead of being
                distributed between the badge, logo and headline */}
            <div className="flex-1 flex flex-col justify-start" style={{ padding: '28px 0 20px' }}>
              <p className="font-johnson-text font-bold uppercase" style={{ fontSize: 11, letterSpacing: '.26em', color: '#0f68b2', margin: '0 0 28px' }}>
                Source-to-Target Validation
              </p>
              <h1 className="font-johnson-display" style={{ fontWeight: 700, fontSize: 'clamp(40px,4.6vw,72px)', lineHeight: .97, color: '#312c2a', margin: 0, letterSpacing: '-.025em' }}>
                Data Quality
              </h1>
              <h1 className="font-johnson-display italic" style={{ fontWeight: 300, fontSize: 'clamp(40px,4.6vw,72px)', lineHeight: .97, color: '#eb1700', margin: 0, letterSpacing: '-.025em' }}>
                Engine.
              </h1>
              <div style={{ margin: '28px 0' }}>
                <div style={{ width: 52, height: 3, background: '#eb1700' }} />
              </div>
              <p className="font-johnson-text" style={{ fontWeight: 300, fontSize: 'clamp(14px,1.1vw,17px)', lineHeight: 1.55, color: '#6e6259', maxWidth: 380, margin: '0 0 36px' }}>
                One platform, two lenses: automated IT checks confirm structural
                integrity, while business-defined checks apply your own data-quality
                rules — together catching anomalies before they reach production.
              </p>

              {/* Connected environments */}
              <div className="flex items-center flex-wrap" style={{ gap: 10 }}>
                <span className="font-johnson-text font-bold uppercase" style={{ fontSize: 10, letterSpacing: '.14em', color: '#a39992', marginRight: 4 }}>
                  Connected
                </span>
                {[
                  { label: 'DEV', dot: '#69d0ff' },
                  { label: 'QA',  dot: '#0f68b2' },
                  { label: 'PRD', dot: '#328714' },
                ].map(env => (
                  <span
                    key={env.label}
                    className="inline-flex items-center font-johnson-text font-bold"
                    style={{ gap: 6, padding: '5px 12px', borderRadius: 999, background: 'rgba(255,255,255,.72)', border: '1px solid #e8e6e3', fontSize: 11, letterSpacing: '.08em', color: '#312c2a' }}
                  >
                    <span className="block flex-none rounded-full" style={{ width: 6, height: 6, background: env.dot }} />
                    {env.label}
                  </span>
                ))}
              </div>
            </div>

            {/* Footer */}
            <p className="font-johnson-text" style={{ fontWeight: 300, fontSize: 11, color: '#a39992', margin: 0, letterSpacing: '.02em' }}>
              Confidential · Internal Use Only · © {new Date().getFullYear()} Regulatory Integrated Data · Johnson &amp; Johnson
            </p>
          </div>
        </div>

        {/* ═══ RIGHT PANEL ═══ */}
        <div
          className="relative flex-1 flex flex-col bg-white overflow-hidden"
          style={{ backgroundImage: 'radial-gradient(circle, rgba(203,196,188,.22) 1px, transparent 1px)', backgroundSize: '24px 24px', borderLeft: '1px solid #e8e6e3' }}
        >
          <div className="flex-1 flex flex-col justify-center mx-auto w-full" style={{ padding: '56px 52px', maxWidth: 480 }}>

            {/* Compact hero — shown only when the left panel is hidden (small screens) */}
            <div className="lg:hidden text-center mb-8">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-jj-red shadow-lg mb-4">
                <Icon src={shieldCheckIcon} alt="Shield" className="w-8 h-8 text-white" />
              </div>
              <h1 className="font-johnson-display text-2xl text-jj-gray-08" style={{ lineHeight: '110%' }}>
                Data Quality Engine
              </h1>
            </div>

            <p className="font-johnson-text font-bold uppercase" style={{ fontSize: '10.5px', letterSpacing: '.22em', color: '#a39992', margin: '0 0 14px' }}>
              Validation Suite
            </p>
            <h2 className="font-johnson-display" style={{ fontWeight: 700, fontSize: 26, lineHeight: 1.08, color: '#312c2a', margin: '0 0 8px', letterSpacing: '-.01em' }}>
              Choose your check type
            </h2>
            <p className="font-johnson-text" style={{ fontWeight: 400, fontSize: 14, color: '#81766f', margin: '0 0 36px', lineHeight: 1.5 }}>
              Select a suite to load its latest validation analysis.
            </p>

            {/* Check type options */}
            <div className="flex flex-col" style={{ gap: 14, marginBottom: 32 }}>
              {checkTypeOptions.map(item => {
                const selected = selectedCheckType === item.value;
                return (
                  <button
                    key={item.value}
                    onClick={() => handleCheckTypeChange(item.value)}
                    aria-pressed={selected}
                    className="flex items-center w-full text-left"
                    style={{
                      gap: 18, padding: '18px 20px', borderRadius: 14, cursor: 'pointer',
                      transition: 'box-shadow .18s ease, transform .18s ease, border-color .18s ease, background .18s ease',
                      background: selected ? '#fff5f4' : '#faf9f8',
                      border: selected ? '1.5px solid #eb1700' : '1.5px solid #e8e6e3',
                      boxShadow: selected ? '0 10px 28px -12px rgba(235,23,0,.28)' : '0 1px 3px rgba(49,44,42,.04)',
                      transform: selected ? 'translateX(3px)' : 'none',
                    }}
                  >
                    <span
                      className="flex-none text-right font-johnson-display italic"
                      style={{ fontWeight: 300, fontSize: 30, lineHeight: 1, width: 32, color: selected ? '#eb1700' : '#cbc4bc', transition: 'color .18s ease' }}
                    >
                      {item.num}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center" style={{ gap: 10, marginBottom: 6 }}>
                        <span className="flex items-center justify-center flex-none rounded-lg" style={{ width: 30, height: 30, background: 'rgba(235,23,0,.07)' }}>
                          <Icon src={barChartIcon} alt="" className="w-4 h-4 text-jj-red" />
                        </span>
                        <span className="font-johnson-display" style={{ fontWeight: 700, fontSize: 16, color: '#312c2a', letterSpacing: '-.01em' }}>
                          {item.label}
                        </span>
                        {item.beta && (
                          <span
                            className="flex-none font-johnson-text"
                            style={{
                              fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
                              padding: '2px 7px', borderRadius: 999,
                              color: '#eb1700', background: 'rgba(235,23,0,.08)', border: '1px solid rgba(235,23,0,.25)',
                            }}
                          >
                            Beta
                          </span>
                        )}
                      </span>
                      <span className="block font-johnson-text" style={{ fontSize: '12.5px', color: '#81766f', lineHeight: 1.45 }}>
                        {item.desc}
                      </span>
                    </span>
                    <span
                      className="flex-none flex items-center justify-center rounded-full"
                      style={{
                        width: 20, height: 20,
                        border: selected ? '2px solid #eb1700' : '2px solid #cbc4bc',
                        background: selected ? '#fff0ef' : 'transparent',
                        transition: 'border-color .18s ease, background .18s ease',
                      }}
                    >
                      {selected && <span className="block rounded-full" style={{ width: 8, height: 8, background: '#eb1700' }} />}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Error */}
            {loadError && (
              <div className="flex items-start gap-3 px-4 py-3 bg-red-50 rounded-lg border border-jj-maroon-05 border-opacity-30 mb-6">
                <Icon src={alertTriangleIcon} alt="Error" className="w-4 h-4 mt-0.5 flex-shrink-0 text-jj-maroon-05" />
                <p className="font-johnson-text text-sm text-jj-gray-08">{loadError}</p>
              </div>
            )}

            {/* Submit */}
            <button
              onClick={() => handleLoadData()}
              disabled={isLoading || !selectedCheckType}
              className="flex items-center justify-center w-full font-johnson-display"
              style={{
                gap: 10, padding: '15px 24px', borderRadius: 13, border: 'none', fontWeight: 700, fontSize: 16,
                letterSpacing: '-.01em', color: '#fff', cursor: (!selectedCheckType || isLoading) ? 'not-allowed' : 'pointer',
                transition: 'opacity .2s ease, box-shadow .2s ease',
                background: (!selectedCheckType || isLoading) ? '#cbc4bc' : '#eb1700',
                boxShadow: (!selectedCheckType || isLoading) ? 'none' : '0 12px 28px -10px rgba(235,23,0,.5)',
                opacity: (!selectedCheckType || isLoading) ? .7 : 1,
              }}
            >
              {isLoading ? (
                <>
                  <span className="block flex-none rounded-full" style={{ width: 17, height: 17, border: '2.5px solid rgba(255,255,255,.4)', borderTopColor: '#fff', animation: 'dqe-spin .75s linear infinite' }} />
                  Loading validation data…
                </>
              ) : (
                <>
                  Load Validation Analysis
                  {selectedCheckType && <Icon src={chevronRightIcon} alt="" className="w-4 h-4 text-white" />}
                </>
              )}
            </button>
          </div>

          {/* Right panel footer */}
          <div className="flex items-center justify-between flex-wrap" style={{ padding: '0 52px 32px', gap: 16 }}>
            <div className="flex items-center" style={{ gap: 8 }}>
              <Icon src={databaseIcon} alt="" className="w-3.5 h-3.5 text-jj-gray-05" style={{ opacity: .55 }} />
              <span className="font-johnson-text" style={{ fontSize: '11.5px', color: '#a39992' }}>
                DEV · QA · PRD environments
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Loading ── (IT Checks never gets this — it renders its own placeholders)
  if (isLoading && selectedCheckType !== 'IT_Checks') return (
    <div className="flex items-center justify-center min-h-full bg-jj-gray-01">
      <div className="text-center">
        <LoadingSpinner />
        <p className="font-johnson-text mt-4 text-sm font-bold text-jj-gray-07">Loading validation data…</p>
      </div>
    </div>
  );

  // ── Business Checks ──
  if (selectedCheckType === 'Business_defined_checks') {
    if (!hasPermission('viewBusinessChecks')) return <Navigate to="/dashboard" replace />;
    return <BusinessDefinedChecks onBack={resetState} />;
  }

  // ── Data Validation ──
  if (selectedCheckType === 'Data_Validation') {
    if (!hasPermission('viewDataValidation')) return <Navigate to="/dashboard" replace />;
    return <DataValidation onBack={resetState} />;
  }

  if (!reportData && selectedCheckType !== 'IT_Checks') return null;

  // Guard: user could land here via direct URL with no IT Checks permission
  if (selectedCheckType === 'IT_Checks' && !hasPermission('viewITChecks')) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <ErrorBoundary>
      <ITChecksView
        reportData={reportData}
        availableRuns={availableRuns}
        runsMerged={runsMerged}
        newestDate={newestDate}
        oldestDate={oldestDate}
        runsLoading={runsLoading}
        isLoading={isLoading}
        loadError={loadError}
        onLoadRuns={(dates) => handleLoadData(dates)}
        onRevalidateTable={handleRevalidateTable}
        canRefreshTable={canRefreshTable}
        canRun={hasPermission('runITChecks')}
        canSwitch={availableCheckTypes.length > 1}
        onSwitch={resetState}
      />
    </ErrorBoundary>
  );
}

export default DataQualityEngine;