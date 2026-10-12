import React, {
  useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useDeferredValue, memo, lazy, Suspense,
  createContext, useContext,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchJson, formatWhen } from '../shared/studioHelpers';
import { SkeletonLine } from '../shared/studioParts';
import { apiEventSource } from '../../../utils/apiClient';
import { useRBAC } from '../../../context/RBACContext';
import {
  KIND, KIND_ORDER, FRAGMENT, MASK, kindOf, findStage, flattenStages, routeSummary, pathOf, matchesPipeline, runCounts,
  extractUrl, streamErrorMessage, stageSubtitle, relativeDay, describe, stageCtx, stageSummaries, parseVal, word,
  SECTIONS, sectionOf, techMeta, ENUM, tmpl, resourceRefs, fieldSelector,
} from './streamsetsModel';

// The graph library is only fetched when someone opens the Flow tab.
const PipelineCanvas = lazy(() => import('./PipelineCanvas'));

const VIEWS = [
  { id: 'flow', label: 'Flow', icon: 'flow' },
  { id: 'stages', label: 'All stages', icon: 'list' },
  { id: 'params', label: 'Parameters', icon: 'sliders' },
];
const ENGINES = { DATACOLLECTOR: 'Data Collector', TRANSFORMER: 'Transformer', TRANSFORMER_SNOWPARK: 'Transformer for Snowflake' };
const SELECTION_KEY = 'streamsets.selection';
const MAX_ROWS = 500;          // pipeline rows painted at once; search narrows the rest
const MAX_LOG_LINES = 5000;    // the run log keeps the newest lines
const LOG_SHOWN = 400;         // ...and paints the last few hundred, so a chatty run stays smooth
const LOG_FLUSH_MS = 200;      // log lines are batched rather than re-rendering per line
const SECRET_SHOWN_MS = 30_000;   // a revealed secret hides itself again after this long
const ROW_CV = { contentVisibility: 'auto', containIntrinsicSize: 'auto 78px' };

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
const initials = (name) => String(name || '?').split(/[\s._@-]+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A callback that never changes identity but always runs the latest code - keeps memo'd parts from re-rendering. */
function useStable(fn) {
  const ref = useRef(fn);
  useLayoutEffect(() => { ref.current = fn; });
  return useCallback((...args) => ref.current(...args), []);
}

/* ------------------------------- styles -------------------------------- */

// Rendered as one <style> that React 19 hoists into <head> once (href + precedence), so the pane
// keeps everything in this file without a separate stylesheet.
const PANE_CSS = `
/* StreamSets Extractor pane. Everything is under .ss-root / ss-* so nothing leaks into the other panes.
   Built for cloud desktops without a GPU: no backdrop-filter or blur filters, entrance effects play
   once (opacity/transform only), and the only looping animations are the ones that show real work -
   loading, an extraction in progress, or the pipeline being extracted. */

.ss-root {
  --red: #eb1700; --red-d: #9e0000; --red-wash: #fff3f1; --red-line: #ffd5ce;
  --ink: #312c2a; --ink-2: #6e6259; --ink-3: #81766f; --mute: #a39992;
  --line: #e8e6e3; --line-2: #d5cfc9; --wash: #faf9f7; --wash-2: #f1efed;
  --src: #328714; --src-bg: #eef5ea; --proc: #0f68b2; --proc-bg: #e8f1fa; --dst: #d9620f; --dst-bg: #fdf1e7;
  --exe: #6e6259; --exe-bg: #f1efed; --frag: #8c3bbb; --frag-bg: #f5edfb;
  --ok: #328714; --bad: #9e0000; --warn: #a35f00;
  --sh-1: 0 1px 2px rgba(49, 44, 42, .06), 0 1px 3px rgba(49, 44, 42, .08);
  --sh-2: 0 2px 6px rgba(49, 44, 42, .10);
  --sh-3: 0 6px 16px rgba(49, 44, 42, .18);
  --ease: cubic-bezier(.2, .8, .2, 1);
  --mono: ui-monospace, 'Cascadia Mono', Consolas, 'Courier New', monospace;
  position: relative; height: 100%; min-height: 0; display: flex; flex-direction: column;
  container: ss-pane / inline-size;   /* layout reacts to the pane's width, not the window's (the app sidebar takes some) */
  background: #fff; color: var(--ink); font-family: 'JohnsonText', Arial, sans-serif; font-size: 13px; line-height: 1.45;
}
.ss-root *, .ss-root *::before, .ss-root *::after { box-sizing: border-box; }
.ss-root button { cursor: pointer; }
.ss-root button:disabled { cursor: not-allowed; }
.ss-root :focus-visible { outline: 2px solid var(--red); outline-offset: 2px; border-radius: 6px; }
.ss-root kbd { font: 10.5px var(--mono); padding: 1px 5px; border-radius: 4px; border: 1px solid var(--line-2); border-bottom-width: 2px; background: #fff; color: var(--ink-2); }
.ss-root code { font-family: var(--mono); font-size: .92em; }
.ss-i { display: inline-block; flex-shrink: 0; vertical-align: middle; }
.ss-grow { flex: 1; min-width: 0; }
.ss-muted { color: var(--mute); }
.ss-sub { color: var(--ink-3); font-size: 11.5px; }
.ss-warn-text { color: var(--warn); }
.ss-stack-6 { display: grid; gap: 6px; }
.ss-stack-10 { display: grid; gap: 10px; }
.ss-center { display: flex; align-items: center; justify-content: center; height: 100%; }
.ss-mt { margin-top: 10px; }
.ss-pad { padding: 20px 26px 120px; max-width: 1180px; }
.ss-pad-s { padding: 10px; }
.ss-mark { background: #fbe058; color: inherit; border-radius: 3px; padding: 0 1px; }
.ss-link { color: var(--ink-2); font-weight: 700; padding: 2px 5px; border-radius: 5px; font-size: 12px; }
.ss-link:hover:not(:disabled) { color: var(--red); background: var(--red-wash); }
.ss-link:disabled { opacity: .4; }
.ss-push { margin-left: auto; }

@keyframes ss-rise { from { opacity: 0; transform: translateY(6px); } }
@keyframes ss-fade { from { opacity: 0; } }
@keyframes ss-spin { to { transform: rotate(360deg); } }
@keyframes ss-pop { from { transform: scale(.6); opacity: 0; } }
@keyframes ss-shake { 20%, 60% { transform: translateX(-5px); } 40%, 80% { transform: translateX(5px); } }
@keyframes ss-slide { from { transform: translateX(32px); opacity: 0; } }
@keyframes ss-busy { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
@keyframes ss-pulse { 50% { opacity: .3; } }
@keyframes ss-out { to { opacity: 0; visibility: hidden; } }

.ss-busy { position: absolute; top: 0; left: 0; right: 0; height: 2px; overflow: hidden; z-index: 40; }
.ss-busy::after { content: ''; position: absolute; inset: 0; width: 33%; background: var(--red); animation: ss-busy 1.1s linear infinite; }

/* ------------------------------ buttons ------------------------------ */
.ss-btn { height: 34px; padding: 0 13px; border-radius: 9px; display: inline-flex; align-items: center; gap: 7px; font-weight: 700; font-size: 12.5px; border: 1px solid var(--line-2); background: #fff; color: var(--ink); white-space: nowrap; transition: background-color .15s, border-color .15s; }
.ss-btn:hover:not(:disabled) { border-color: var(--ink-3); background: var(--wash); }
.ss-btn:disabled { opacity: .45; }
.ss-btn.is-on { background: var(--red-wash); border-color: var(--red-line); color: var(--red-d); }
.ss-btn-dark { background: var(--ink); border-color: var(--ink); color: #fff; }
.ss-btn-dark:hover:not(:disabled) { background: #1c1918; border-color: #1c1918; }
.ss-btn-dark kbd { background: #4a4442; color: #fff; border-color: #5d5552; }
.ss-btn-primary { background: var(--red); border-color: var(--red); color: #fff; }
.ss-btn-primary:hover:not(:disabled) { background: var(--red-d); border-color: var(--red-d); }
.ss-btn-sm { height: 30px; }
.ss-ibtn { width: 30px; height: 30px; border-radius: 8px; display: inline-grid; place-items: center; color: var(--ink-2); flex-shrink: 0; transition: background-color .15s; }
.ss-ibtn:hover:not(:disabled) { background: var(--wash-2); color: var(--ink); }
.ss-ibtn:disabled { opacity: .4; }
.ss-ibtn.is-on { background: var(--ink); color: #fff; }
.ss-ibtn.is-spin .ss-i { animation: ss-spin .8s linear infinite; }
.ss-seg { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--wash-2); flex-shrink: 0; }
.ss-seg button { height: 22px; padding: 0 8px; border-radius: 6px; font-size: 11.5px; color: var(--ink-3); }
.ss-seg button.is-on { background: #fff; color: var(--ink); font-weight: 700; box-shadow: var(--sh-1); }

/* ------------------------------ top bar ------------------------------ */
.ss-bar { flex-shrink: 0; height: 52px; display: flex; align-items: center; gap: 14px; padding: 0 18px; border-bottom: 1px solid var(--line); background: #fff; }
.ss-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ss-brand-mark { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; color: #fff; flex-shrink: 0; background: var(--red); }
.ss-brand b { font-size: 14px; font-weight: 700; }
.ss-brand small { display: block; color: var(--ink-3); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ss-pills { display: flex; gap: 8px; min-width: 0; }
.ss-pill { display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 10px; border-radius: 99px; border: 1px solid var(--line); background: var(--wash); font-size: 12px; color: var(--ink-2); white-space: nowrap; }
.ss-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex-shrink: 0; box-shadow: 0 0 0 3px rgba(31, 143, 78, .15); }
.ss-dot.is-warn { background: var(--warn); box-shadow: 0 0 0 3px rgba(163, 95, 0, .15); }
.ss-jump { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 8px 0 11px; border-radius: 9px; border: 1px solid var(--line); background: var(--wash); color: var(--ink-3); min-width: 250px; flex-shrink: 0; }
.ss-jump:hover { border-color: var(--line-2); background: #fff; color: var(--ink-2); }
.ss-jump span { flex: 1; text-align: left; }
@container ss-pane (max-width: 1250px) { .ss-pills .ss-pill + .ss-pill { display: none; } .ss-brand small { display: none; } }
@container ss-pane (max-width: 1000px) { .ss-pills { display: none; } .ss-jump { min-width: 0; } .ss-jump span { display: none; } }

.ss-body { flex: 1; min-height: 0; display: flex; }

/* -------------------------------- rail -------------------------------- */
.ss-rail { width: 340px; flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); background: var(--wash); }
.ss-rail-head { flex-shrink: 0; padding: 14px 16px 8px; display: flex; flex-direction: column; gap: 10px; }
.ss-rail-title { display: flex; align-items: center; gap: 8px; }
.ss-rail-title h2 { margin: 0; font-size: 15px; font-weight: 700; }
.ss-count { font-size: 11.5px; font-weight: 700; color: var(--ink-2); background: var(--wash-2); border-radius: 99px; padding: 1px 8px; font-variant-numeric: tabular-nums; }
.ss-fetched { margin-left: auto; font-size: 11.5px; color: var(--mute); white-space: nowrap; }
.ss-search { position: relative; }
.ss-search > .ss-i { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--mute); }
.ss-search input { width: 100%; height: 38px; padding: 0 40px 0 34px; border-radius: 10px; border: 1px solid var(--line-2); background: #fff; outline: none; font-size: 13px; color: var(--ink); }
.ss-search input::placeholder { color: var(--mute); }
.ss-search input:focus { border-color: var(--red); box-shadow: 0 0 0 3px rgba(235, 23, 0, .12); }
.ss-search-kbd, .ss-search-clear { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); }
.ss-search-clear { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; color: var(--ink-3); }
.ss-search-clear:hover { background: var(--wash-2); }
.ss-chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin: 0 -16px; padding: 0 16px; }
.ss-chips::-webkit-scrollbar { display: none; }
.ss-chip { flex-shrink: 0; height: 26px; padding: 0 10px; border-radius: 99px; border: 1px solid var(--line-2); background: #fff; font-size: 12px; color: var(--ink-2); display: inline-flex; align-items: center; gap: 5px; }
.ss-chip:hover { border-color: var(--ink-3); color: var(--ink); }
.ss-chip.is-on { background: var(--ink); border-color: var(--ink); color: #fff; }
.ss-chip em { font-style: normal; opacity: .6; font-variant-numeric: tabular-nums; }
.ss-listbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ss-list { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 10px 12px; }
.ss-list-ul { list-style: none; margin: 0; padding: 0; animation: ss-fade .3s var(--ease); }
.ss-card { position: relative; display: flex; gap: 10px; padding: 11px 12px 11px 10px; border-radius: 12px; border: 1px solid transparent; margin-bottom: 3px; transition: background-color .15s, border-color .15s; }
.ss-card:hover { background: #fff; border-color: var(--line); }
.ss-card.is-open { background: #fff; border-color: var(--line-2); box-shadow: var(--sh-2); }
.ss-card.is-open::before { content: ''; position: absolute; left: -1px; top: 12px; bottom: 12px; width: 3px; border-radius: 0 3px 3px 0; background: var(--red); }
.ss-card.is-picked { background: var(--red-wash); border-color: var(--red-line); }
.ss-check { width: 20px; height: 20px; margin-top: 1px; flex-shrink: 0; border-radius: 6px; border: 1.6px solid var(--line-2); background: #fff; display: grid; place-items: center; transition: background-color .15s, border-color .15s; }
.ss-check:hover:not(:disabled) { border-color: var(--red); }
.ss-check svg { width: 12px; height: 12px; fill: none; stroke: #fff; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 20; stroke-dashoffset: 20; transition: stroke-dashoffset .25s var(--ease); }
.ss-check[aria-checked="true"] { background: var(--red); border-color: var(--red); }
.ss-check[aria-checked="true"] svg { stroke-dashoffset: 0; }
.ss-check:disabled { opacity: .35; }
.ss-card-open { flex: 1; min-width: 0; text-align: left; }
.ss-card-nm { font-size: 13px; font-weight: 700; line-height: 1.35; word-break: break-word; }
.ss-card.is-open .ss-card-nm { color: var(--red-d); }
.ss-card-ds { font-size: 12px; color: var(--ink-3); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ss-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; margin-top: 6px; font-size: 11.5px; color: var(--mute); }
.ss-tag { padding: 0 7px; height: 18px; display: inline-flex; align-items: center; border-radius: 99px; font-size: 11px; background: var(--wash-2); color: var(--ink-2); }
.ss-tag-warn { background: #fff4e0; color: var(--warn); }
.ss-tag-proc { background: var(--proc-bg); color: var(--proc); }
.ss-tag-frag { background: var(--frag-bg); color: var(--frag); }
.ss-tag-red { background: var(--red-wash); color: var(--red-d); }
.ss-tag-ok { background: var(--src-bg); color: var(--ok); }
.ss-tag-bad { background: #fdecec; color: var(--bad); }
.ss-list-sk-row { display: flex; gap: 10px; padding: 12px 10px; }
.ss-empty { text-align: center; padding: 28px 18px; color: var(--ink-3); font-size: 12.5px; display: grid; gap: 6px; justify-items: center; }
.ss-empty b { color: var(--ink); }

.ss-tray { flex-shrink: 0; margin: 0 10px 10px; padding: 12px; border-radius: 14px; background: #fff; border: 1px solid var(--line); box-shadow: var(--sh-2); }
.ss-tray.is-shake { animation: ss-shake .45s; }
.ss-tray-top { display: flex; align-items: center; gap: 10px; }
.ss-tray-h { display: block; font-size: 13px; }
.ss-ring { width: 38px; height: 38px; flex-shrink: 0; position: relative; }
.ss-ring svg, .ss-pring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.ss-ring circle, .ss-pring circle { fill: none; stroke-width: 4; }
.ss-ring-bg { stroke: var(--wash-2); }
.ss-ring-fg { stroke: var(--red); stroke-linecap: round; transition: stroke-dashoffset .4s var(--ease); }
.ss-ring b { position: absolute; inset: 0; display: grid; place-items: center; font-size: 12px; font-variant-numeric: tabular-nums; }
.ss-picks { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
.ss-pick { display: inline-flex; align-items: center; gap: 4px; max-width: 150px; height: 24px; padding: 0 4px 0 9px; border-radius: 99px; background: var(--wash-2); font-size: 11.5px; animation: ss-pop .25s var(--ease); }
.ss-pick span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-pick button { width: 16px; height: 16px; border-radius: 50%; display: grid; place-items: center; color: var(--ink-3); flex-shrink: 0; }
.ss-pick button:hover { background: var(--line-2); color: var(--ink); }
.ss-pick-more { padding-right: 9px; color: var(--ink-3); }
.ss-cta { width: 100%; height: 42px; margin-top: 10px; border-radius: 11px; display: flex; align-items: center; justify-content: center; gap: 8px; color: #fff; font-weight: 700; font-size: 13.5px; background: var(--red); transition: background-color .15s; }
.ss-cta:hover:not(:disabled) { background: var(--red-d); }
.ss-cta:disabled { background: var(--wash-2); color: var(--mute); box-shadow: none; }
.ss-tray-note { margin-top: 8px; font-size: 11.5px; line-height: 1.4; color: var(--ink-3); text-align: center; }
.ss-tray-note.is-warn { color: var(--warn); text-align: left; display: flex; gap: 6px; }

/* -------------------------------- main -------------------------------- */
.ss-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; overflow: hidden; }
.ss-errbox, .ss-warnbox { margin-top: 12px; display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 10px; font-size: 12.5px; }
.ss-errbox { background: #fdf3f3; border: 1px solid #f2cccc; color: #8f1f1f; }
.ss-warnbox { background: #fff7ea; border: 1px solid #f6dcae; color: #7a4a00; }
.ss-errbox .ss-i, .ss-warnbox .ss-i { margin-top: 1px; }
.ss-pad-s .ss-errbox, .ss-dock-err .ss-errbox, .ss-dr-body .ss-errbox { margin-top: 0; }

/* hero (nothing open) */
.ss-hero { flex: 1; overflow-y: auto; position: relative; }
.ss-hero-in { position: relative; max-width: 980px; margin: 0 auto; padding: 42px 40px 60px; }
.ss-eyebrow { display: inline-flex; align-items: center; gap: 8px; height: 28px; padding: 0 12px 0 6px; border-radius: 99px; background: #fff; border: 1px solid var(--line); font-size: 12px; color: var(--ink-2); box-shadow: var(--sh-1); animation: ss-rise .5s var(--ease) both; }
.ss-eyebrow b { background: var(--red); color: #fff; font-size: 10.5px; padding: 2px 7px; border-radius: 99px; }
.ss-hero-h { margin: 18px 0 10px; font-family: 'JohnsonDisplay', Arial, sans-serif; font-size: 34px; line-height: 1.15; letter-spacing: -.01em; font-weight: 700; max-width: 680px; animation: ss-rise .5s var(--ease) .05s both; }
.ss-hero-h span { color: var(--red); }
.ss-hero-lede { margin: 0; font-size: 15px; line-height: 1.6; color: var(--ink-2); max-width: 600px; animation: ss-rise .5s var(--ease) .1s both; }
.ss-hero-actions { display: flex; gap: 10px; margin-top: 22px; animation: ss-rise .5s var(--ease) .15s both; }
.ss-hero-art { margin: 32px 0 6px; padding: 22px; border-radius: 12px; background: #fff; border: 1px solid var(--line); box-shadow: var(--sh-2); animation: ss-rise .5s var(--ease) .2s both; }
.ss-hero-svg { width: 100%; height: auto; display: block; overflow: visible; font-family: Arial, sans-serif; }
.ss-hero-wire { fill: none; stroke: var(--line-2); stroke-width: 2; }
.ss-hero-node { animation: ss-fade .5s var(--ease) both; }
.ss-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 26px; }
.ss-step { position: relative; padding: 18px; border-radius: 16px; border: 1px solid var(--line); background: #fff; animation: ss-rise .5s var(--ease) both; transition: border-color .15s, box-shadow .15s; }
.ss-step:hover { border-color: var(--line-2); }
.ss-step-num { position: absolute; top: 14px; right: 16px; font-size: 30px; font-weight: 700; color: var(--wash-2); }
.ss-step-ic { width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; margin-bottom: 12px; }
.ss-tone-proc { background: var(--proc-bg); color: var(--proc); }
.ss-tone-frag { background: var(--frag-bg); color: var(--frag); }
.ss-tone-red { background: var(--red-wash); color: var(--red); }
.ss-step b { display: block; font-size: 14px; margin-bottom: 4px; }
.ss-step p { margin: 0; font-size: 12.5px; color: var(--ink-2); line-height: 1.55; }
.ss-recent-h { display: flex; align-items: baseline; gap: 10px; margin: 32px 0 12px; }
.ss-recent-h h3 { margin: 0; font-size: 14px; font-weight: 700; }
.ss-recent-h span { color: var(--ink-3); font-size: 12px; }
.ss-recent { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.ss-rc { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 13px; border: 1px solid var(--line); background: #fff; text-align: left; transition: border-color .15s, box-shadow .15s; }
.ss-rc:hover { border-color: var(--line-2); box-shadow: var(--sh-2); }
.ss-rc b { display: block; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-rc small { color: var(--ink-3); font-size: 11.5px; }
.ss-rc-arrow { color: var(--mute); }
.ss-rc:hover .ss-rc-arrow { color: var(--red); }
@container ss-pane (max-width: 1150px) { .ss-steps, .ss-recent { grid-template-columns: 1fr; } }

/* tiles + kind colours */
.ss-tile { --t: #eb1700; width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0; display: inline-grid; place-items: center; color: #fff; font: 700 10.5px Arial, sans-serif; letter-spacing: .02em; background: var(--t); }
.ss-tile-sm { width: 20px; height: 20px; border-radius: 6px; font-size: 8px; }
.ss-tile-lg { width: 44px; height: 44px; border-radius: 12px; font-size: 14px; }
.ss-k-src { --k: var(--src); --kb: var(--src-bg); }
.ss-k-proc { --k: var(--proc); --kb: var(--proc-bg); }
.ss-k-dst { --k: var(--dst); --kb: var(--dst-bg); }
.ss-k-exe { --k: var(--exe); --kb: var(--exe-bg); }
.ss-k-frag { --k: var(--frag); --kb: var(--frag-bg); }
.ss-klabel { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--k); }

/* -------------------------------- detail ------------------------------- */
.ss-detail { flex: 1; min-height: 0; display: flex; flex-direction: column; animation: ss-fade .25s var(--ease); }
.ss-dhead { flex-shrink: 0; padding: 16px 26px 0; }
.ss-crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12px; color: var(--ink-3); margin-bottom: 6px; }
.ss-crumbs > button:hover { color: var(--red); }
.ss-dtop { display: flex; align-items: flex-start; gap: 18px; }
.ss-dtitle { margin: 0; font-size: 21px; line-height: 1.25; font-weight: 700; word-break: break-word; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ss-ddesc { margin: 4px 0 0; color: var(--ink-2); font-size: 13px; max-width: 760px; }
.ss-live-badge { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 99px; background: var(--red-wash); color: var(--red-d); font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.ss-live-badge .ss-dot { background: var(--red); box-shadow: none; animation: ss-pulse 1.2s ease-in-out infinite; }
.ss-dmeta { margin-top: 7px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font-size: 12.5px; color: var(--ink-2); }
.ss-dmeta > span, .ss-dmeta > button { display: inline-flex; align-items: center; gap: 6px; }
.ss-dmeta .ss-i { color: var(--mute); }
.ss-dmeta > button:hover, .ss-dmeta > button:hover .ss-i { color: var(--red); }
.ss-vpill { font-weight: 700; font-size: 11px; padding: 1px 7px; border-radius: 6px; background: var(--ink); color: #fff; }
.ss-avatar { width: 20px; height: 20px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 9px; font-weight: 700; color: #fff; background: var(--ink-2); }
.ss-dmeta > .ss-commit { min-width: 0; max-width: 420px; }
.ss-commit .ss-i { color: var(--mute); }
.ss-commit q { quotes: none; font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ss-dactions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }

.ss-route { margin-top: 14px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(150px, 1.1fr) minmax(0, 1fr); align-items: center; gap: 18px; padding: 13px 16px; border-radius: 16px; background: var(--wash); border: 1px solid var(--line); }
.ss-ep { min-width: 0; }
.ss-ep.is-r { text-align: right; }
.ss-ep-h { font-size: 10.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--mute); margin-bottom: 4px; }
.ss-ep-row { display: flex; align-items: center; gap: 9px; min-width: 0; margin-top: 5px; }
.ss-ep.is-r .ss-ep-row { flex-direction: row-reverse; }
.ss-ep-row button { min-width: 0; text-align: inherit; }
.ss-ep-row b { display: block; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-ep-row button:hover b { color: var(--red); }
.ss-ep-row small { display: block; font-size: 11.5px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-track { text-align: center; min-width: 0; }
.ss-track-sum { font-size: 12px; color: var(--ink-2); margin-bottom: 7px; }
.ss-track-line { position: relative; height: 10px; overflow: hidden; }
.ss-track-line::before { content: ''; position: absolute; left: 0; right: 8px; top: 4px; height: 2px; border-radius: 2px; background: var(--line-2); }
.ss-track-line::after { content: ''; position: absolute; right: 0; top: 0; border: 5px solid transparent; border-left: 8px solid var(--dst); border-right: 0; opacity: .75; }
/* three dots travel the line a few times when the pipeline opens, then rest (transform only) */
.ss-track-line span { position: absolute; inset: 0; animation: ss-travel 2.4s linear 3 both; }
.ss-track-line span:nth-child(2) { animation-delay: .8s; }
.ss-track-line span:nth-child(3) { animation-delay: 1.6s; }
.ss-track-line span::after { content: ''; position: absolute; left: 0; top: 2px; width: 6px; height: 6px; border-radius: 50%; background: var(--proc); }
@keyframes ss-travel { 0% { transform: translateX(0); opacity: 0; } 10%, 85% { opacity: 1; } 100% { transform: translateX(calc(100% - 14px)); opacity: 0; } }

.ss-tabs { display: flex; align-items: center; gap: 4px; margin-top: 12px; }
.ss-tab { position: relative; height: 40px; padding: 0 12px; font-size: 13px; color: var(--ink-3); display: inline-flex; align-items: center; gap: 7px; }
.ss-tab:hover { color: var(--ink); }
.ss-tab::after { content: ''; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2.5px; border-radius: 3px; background: var(--red); transform: scaleX(0); transition: transform .25s var(--ease); }
.ss-tab.is-on { color: var(--ink); font-weight: 700; }
.ss-tab.is-on::after { transform: scaleX(1); }
.ss-tab.is-on .ss-count { background: var(--ink); color: #fff; }
.ss-tabs-tip { margin-left: auto; font-size: 12px; color: var(--ink-3); text-align: right; }
.ss-area { flex: 1; min-height: 0; position: relative; border-top: 1px solid var(--line); display: flex; }
.ss-view { flex: 1; min-width: 0; overflow-y: auto; }
.ss-view.is-flow { overflow: hidden; }
.ss-sk-flow { gap: 28px; background: var(--wash); }

/* ------------------------------- canvas ------------------------------- */
.ss-canvas { position: relative; width: 100%; height: 100%; background: var(--wash); }
.ss-canvas .react-flow__node { cursor: pointer; }
.ss-canvas .react-flow__handle { min-width: 0; min-height: 0; }
.ss-node { width: 100%; height: 100%; position: relative; border-radius: 14px; background: #fff; border: 1px solid var(--line); box-shadow: var(--sh-1);
  transition: border-color .15s, opacity .15s; animation: ss-rise .45s var(--ease) both; animation-delay: var(--ss-d, 0ms); }
.ss-node:hover { border-color: var(--line-2); }
.ss-node.is-sel { border-color: var(--k); box-shadow: 0 0 0 3px color-mix(in srgb, var(--k) 20%, transparent); }
.ss-node.is-dim { opacity: .3; }
.ss-node.is-lit { border-color: var(--k); }
.ss-node-bar { position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 0 3px 3px 0; background: var(--k); }
.ss-node-in { display: flex; gap: 11px; align-items: center; padding: 11px 14px 11px 15px; height: 100%; }
.ss-node-in-frag { height: auto; padding-bottom: 6px; }
.ss-node-txt { min-width: 0; flex: 1; }
.ss-node-lb { font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
.ss-node-sub { font-size: 11.5px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-live-dot { position: absolute; top: 10px; right: 10px; width: 7px; height: 7px; border-radius: 50%; background: var(--red); animation: ss-pulse 1.2s ease-in-out infinite; }
.ss-node-frag { background: #fff; border-color: #d9c4ef; border-top: 3px solid var(--frag); }
.ss-frag-err { margin: 0 14px; font-size: 11.5px; color: var(--bad); }
.ss-frag-toggle { display: flex; align-items: center; gap: 6px; width: calc(100% - 20px); margin: 0 10px; height: 28px; padding: 0 8px; border-radius: 8px; font-size: 12px; font-weight: 700; color: var(--frag); }
.ss-frag-toggle:hover { background: var(--frag-bg); }
.ss-frag-toggle svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.8; transition: transform .2s var(--ease); }
.ss-frag-toggle[aria-expanded="true"] svg { transform: rotate(90deg); }
.ss-frag-inner { padding: 4px 10px 10px; display: grid; gap: 4px; }
.ss-frag-inner button { width: 100%; height: 30px; display: flex; align-items: center; gap: 7px; padding: 0 7px; border-radius: 8px; font-size: 12px; text-align: left; }
.ss-frag-inner button:hover { background: var(--wash); }
.ss-frag-inner button.is-sel { background: var(--frag-bg); color: var(--frag); font-weight: 700; }
.ss-frag-inner small { color: var(--mute); font-size: 11px; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-frag-inner-lb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-step-n { width: 16px; height: 16px; border-radius: 50%; flex-shrink: 0; display: grid; place-items: center; font-size: 9.5px; font-weight: 700; color: #fff; background: var(--frag); }
.ss-canvas.is-live .react-flow__edge.animated path { stroke: var(--red) !important; }
.ss-cv-tools { position: absolute; top: 12px; left: 12px; display: flex; gap: 8px; z-index: 5; }
.ss-cv-group { display: flex; align-items: center; padding: 3px; border-radius: 10px; background: #fff; border: 1px solid var(--line); box-shadow: var(--sh-1); }
.ss-cv-group button { height: 28px; min-width: 28px; padding: 0 9px; border-radius: 7px; font-size: 12px; color: var(--ink-2); }
.ss-cv-group button:hover { background: var(--wash-2); color: var(--ink); }
.ss-cv-zoom { min-width: 42px; text-align: center; font-size: 11.5px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.ss-legend { position: absolute; top: 12px; right: 12px; z-index: 5; display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; padding: 7px 12px; border-radius: 10px; background: #fff; border: 1px solid var(--line); box-shadow: var(--sh-1); font-size: 11.5px; color: var(--ink-2); max-width: 50%; }
.ss-legend span { display: inline-flex; align-items: center; gap: 6px; }
.ss-legend i { width: 9px; height: 9px; border-radius: 3px; background: var(--k); }
.ss-cv-hint { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); z-index: 5; font-size: 11.5px; color: var(--ink-3); padding: 6px 12px; border-radius: 99px; background: #fff; border: 1px solid var(--line); white-space: nowrap; pointer-events: none; animation: ss-out .4s ease 7s forwards; }

/* --------------------------- stages + params --------------------------- */
.ss-toolrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ss-finput { position: relative; width: 300px; max-width: 100%; display: inline-block; }
.ss-finput .ss-i { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--mute); }
.ss-finput input { width: 100%; height: 34px; padding: 0 10px 0 31px; border-radius: 9px; border: 1px solid var(--line-2); background: #fff; outline: none; font-size: 12.5px; color: var(--ink); }
.ss-finput input:focus { border-color: var(--red); box-shadow: 0 0 0 3px rgba(235, 23, 0, .1); }
.ss-finput-sm { width: 150px; }
.ss-finput-sm input { height: 28px; }
.ss-kchip { height: 30px; padding: 0 11px; border-radius: 99px; border: 1px solid var(--line-2); background: #fff; font-size: 12px; color: var(--ink-2); display: inline-flex; align-items: center; gap: 7px; }
.ss-kchip i { width: 8px; height: 8px; border-radius: 50%; background: var(--k); }
.ss-kchip em { font-style: normal; color: var(--mute); }
.ss-kchip:hover { border-color: var(--k); }
.ss-kchip.is-on { border-color: var(--k); background: var(--kb); color: var(--k); font-weight: 700; }
.ss-nomatch { margin-top: 30px; text-align: center; color: var(--ink-3); }
.ss-group-h { display: flex; align-items: center; gap: 9px; margin: 24px 0 10px; font-size: 13px; font-weight: 700; }
.ss-group-h i { width: 10px; height: 10px; border-radius: 3px; background: var(--k); }
.ss-group-h em { font-style: normal; font-weight: 400; color: var(--mute); }
.ss-sgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.ss-scard { position: relative; text-align: left; display: flex; gap: 11px; align-items: flex-start; padding: 12px 14px; border-radius: 13px; border: 1px solid var(--line); background: #fff; overflow: hidden; transition: border-color .15s, box-shadow .15s; }
.ss-scard::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--k); opacity: 0; }
.ss-scard:hover { border-color: var(--line-2); box-shadow: var(--sh-2); }
.ss-scard:hover::before, .ss-scard.is-sel::before { opacity: 1; }
.ss-scard.is-sel { border-color: var(--k); background: var(--kb); }
.ss-scard b { display: block; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-scard small { display: block; color: var(--ink-3); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-in-frag { color: var(--frag) !important; }
.ss-scard-sum { margin: 6px 0 0; font-size: 12px; line-height: 1.45; color: var(--ink-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

.ss-ptable { margin-top: 16px; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
.ss-prow { display: grid; grid-template-columns: minmax(130px, .8fr) minmax(0, 1fr) minmax(0, 1.3fr); gap: 16px; padding: 11px 16px; border-top: 1px solid var(--line); align-items: start; }
.ss-prow:hover { background: var(--wash); }
.ss-prow-head { border-top: 0; background: var(--wash); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--mute); padding: 10px 16px; }
.ss-pname { font: 12px var(--mono); word-break: break-all; }
.ss-pval { font: 12px var(--mono); word-break: break-all; white-space: pre-wrap; }
.ss-pval .ss-muted, .ss-pval .ss-secret { font-family: 'JohnsonText', Arial, sans-serif; }
.ss-secret { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; color: var(--ink-3); font-size: 12px; }
.ss-secret-val { font: 700 11.5px/1.6 var(--mono); padding: 0 7px; border-radius: 5px; background: var(--red-wash); border: 1px solid var(--red-line); color: var(--ink); white-space: pre-wrap; word-break: break-all; }
.ss-secret .ss-res-btn.is-hide { color: var(--ink-2); background: var(--wash-2); border-color: var(--line-2); }
.ss-users { display: flex; flex-wrap: wrap; gap: 5px; }
.ss-ulink { display: inline-flex; align-items: flex-start; flex-wrap: wrap; gap: 2px 6px; min-height: 24px; padding: 3px 8px 3px 4px; border-radius: 7px; border: 1px solid var(--line); font-size: 12px; background: #fff; max-width: 100%; text-align: left; }
.ss-ulink:hover { border-color: var(--k); background: var(--kb); }
.ss-ulink i { width: 14px; height: 14px; margin-top: 1px; border-radius: 4px; background: var(--k); flex-shrink: 0; }
.ss-ulink span { overflow-wrap: anywhere; }
.ss-ulink em { font-style: normal; color: var(--mute); font-size: 11px; }
.ss-ulink em::before { content: '· '; }

/* ----------------------------- stage drawer ---------------------------- */
.ss-drawer { position: absolute; top: 0; right: 0; bottom: 0; width: 500px; max-width: 92%; z-index: 8; display: flex; flex-direction: column; background: #fff; border-left: 1px solid var(--line); box-shadow: -14px 0 30px -18px rgba(49, 44, 42, .45); animation: ss-slide .3s var(--ease); }
.ss-dr-head { flex-shrink: 0; padding: 15px 18px 13px; background: #fff; border-bottom: 1px solid var(--line); border-top: 3px solid var(--k); }
.ss-dr-crumbs { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: 11.5px; color: var(--frag); margin-bottom: 8px; }
.ss-dr-crumbs button { color: var(--frag); }
.ss-dr-crumbs button:hover { text-decoration: underline; }
.ss-dr-top { display: flex; gap: 12px; align-items: flex-start; }
.ss-dr-top h3 { margin: 2px 0; font-size: 16px; font-weight: 700; word-break: break-word; }
.ss-dr-top small { font-size: 12px; color: var(--ink-2); }
.ss-dr-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 18px 40px; display: flex; flex-direction: column; gap: 20px; }
.ss-sec-h { font-size: 10.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--mute); margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
.ss-sec-h em { font-style: normal; color: var(--ink-3); background: var(--wash-2); border-radius: 99px; padding: 0 7px; letter-spacing: 0; }
.ss-sec-tools { margin-left: auto; display: flex; gap: 8px; align-items: center; text-transform: none; letter-spacing: 0; font-weight: 400; }
.ss-what { padding: 14px 16px; border-radius: 14px; background: var(--kb); border: 1px solid var(--line); border-left: 3px solid var(--k); }
.ss-what-lead { margin: 0; font-size: 13.5px; line-height: 1.6; }
.ss-what ul, .ss-fs-body ul { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 7px; }
.ss-what li, .ss-fs-body li { position: relative; padding-left: 16px; font-size: 12.5px; line-height: 1.6; color: var(--ink-2); }
.ss-what li::before, .ss-fs-body li::before { content: ''; position: absolute; left: 3px; top: 8px; width: 5px; height: 5px; border-radius: 50%; background: var(--k); }
.ss-what b, .ss-fs-body b, .ss-rv b { color: var(--ink); font-weight: 700; }
.ss-rt { color: var(--warn) !important; }
.ss-fsteps ol { list-style: none; margin: 0; padding: 0; position: relative; }
.ss-fsteps ol::before { content: ''; position: absolute; left: 13px; top: 18px; bottom: 18px; border-left: 2px dashed #d9c4ef; }
.ss-fs { position: relative; display: flex; gap: 12px; padding: 6px 0; animation: ss-rise .35s var(--ease) both; }
.ss-fs-n { width: 28px; height: 28px; margin-top: 8px; border-radius: 50%; flex-shrink: 0; display: grid; place-items: center; background: var(--k); color: #fff; font-weight: 700; font-size: 12px; box-shadow: 0 0 0 4px #fff; position: relative; }
.ss-fs-body { flex: 1; min-width: 0; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line); background: #fff; }
.ss-fs-body:hover { border-color: var(--line-2); }
.ss-fs-body > button { display: flex; align-items: center; gap: 8px; text-align: left; width: 100%; }
.ss-fs-body > button b { font-size: 13px; }
.ss-fs-body > button small { margin-left: auto; color: var(--mute); font-size: 11px; white-space: nowrap; }
.ss-fs-body > button:hover b { color: var(--frag); }
.ss-fs-body p { margin: 7px 0 0; font-size: 12.5px; line-height: 1.6; color: var(--ink-2); }
.ss-dr-desc { margin: 0; font-size: 12.5px; color: var(--ink-2); line-height: 1.55; white-space: pre-wrap; }
.ss-wires { display: grid; grid-template-columns: 1fr 22px auto 22px 1fr; align-items: center; gap: 6px; padding: 12px; border-radius: 12px; background: var(--wash); border: 1px solid var(--line); }
.ss-wires-col { display: flex; flex-direction: column; gap: 5px; min-width: 0; align-items: flex-start; }
.ss-wires-col.is-r { align-items: flex-end; }
.ss-wires-me { padding: 6px 10px; border-radius: 9px; background: var(--k); color: #fff; font-size: 11.5px; font-weight: 700; white-space: nowrap; }
.ss-wires-arr { height: 2px; background: var(--line-2); position: relative; }
.ss-wires-arr::after { content: ''; position: absolute; right: -1px; top: -4px; border: 5px solid transparent; border-left: 6px solid var(--line-2); border-right: 0; }
.ss-wires-ev { grid-column: 1 / -1; font-size: 11.5px; color: var(--ink-3); display: flex; flex-wrap: wrap; gap: 5px; align-items: center; padding-top: 8px; margin-top: 4px; border-top: 1px dashed var(--line-2); }
.ss-cfg-sec { margin: 14px 0 8px; font-size: 12px; font-weight: 700; color: var(--ink-2); display: flex; align-items: center; gap: 10px; }
.ss-cfg-sec::after { content: ''; flex: 1; height: 1px; background: var(--line); }
.ss-cfg { border: 1px solid var(--line); border-radius: 12px; margin-bottom: 8px; }
.ss-cfg:hover { border-color: var(--line-2); }
.ss-cfg-h { display: flex; align-items: center; gap: 6px; padding: 9px 12px 2px; }
.ss-cfg-h b { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-rawbtn { margin-left: auto; flex-shrink: 0; height: 22px; padding: 0 7px; border-radius: 6px; font: 10.5px var(--mono); color: var(--mute); border: 1px solid transparent; }
.ss-rawbtn:hover { border-color: var(--line-2); color: var(--ink); }
.ss-rawbtn.is-on { background: var(--ink); color: #fff; }
.ss-copy { flex-shrink: 0; height: 22px; padding: 0 7px; border-radius: 6px; display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--ink-3); opacity: 0; }
.ss-cfg:hover .ss-copy, .ss-copy:focus-visible, .ss-copy.is-done { opacity: 1; }
.ss-copy:hover { background: var(--wash-2); color: var(--ink); }
.ss-copy.is-done { color: var(--ok); }
.ss-cfg-raw { padding: 0 12px; font: 10.5px var(--mono); color: var(--mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-cfg-pre { margin: 8px 12px 10px; padding: 9px 11px; max-height: 260px; overflow: auto; border-radius: 8px; background: #fbfaf9; border: 1px solid #f0edea; font: 11.5px/1.6 var(--mono); white-space: pre-wrap; word-break: break-all; }
.ss-prms { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 12px 10px; }
.ss-prm { padding: 2px 8px; border-radius: 6px; font: 11px var(--mono); word-break: break-all; background: var(--src-bg); color: #17663a; }
.ss-prm.is-rt { background: #fff4e0; color: #8a5300; }
.ss-rv { padding: 6px 12px 12px; font-size: 12.5px; line-height: 1.6; overflow-wrap: anywhere; }
.ss-tech summary { cursor: pointer; font-size: 12px; color: var(--ink-3); list-style: none; display: flex; align-items: center; gap: 6px; }
.ss-tech summary::-webkit-details-marker { display: none; }
.ss-tech summary .ss-i { transition: transform .2s; }
.ss-tech[open] summary .ss-i { transform: rotate(90deg); }
.ss-tech dl { margin: 10px 0 0; display: grid; grid-template-columns: 96px 1fr; gap: 6px 10px; font-size: 12px; }
.ss-tech dt { color: var(--mute); }
.ss-tech dd { margin: 0; font: 11.5px var(--mono); word-break: break-all; }

/* readable values (StageText.jsx) */
.ss-fld { display: inline-block; font: 11px/1.55 var(--mono); padding: 0 6px; border-radius: 5px; background: var(--proc-bg); color: var(--proc); white-space: nowrap; vertical-align: 1px; }
.ss-pchip { display: inline-flex; vertical-align: middle; max-width: 100%; border-radius: 6px; overflow: hidden; border: 1px solid #cfe8d8; font-size: 11.5px; line-height: 1.7; margin: 1px 0; }
.ss-pchip i { font: normal 10px/2 var(--mono); padding: 0 6px; background: var(--src-bg); color: #17663a; white-space: nowrap; }
.ss-pchip b { padding: 0 7px; background: #fff; color: var(--ink); font-weight: 700; overflow-wrap: anywhere; }
.ss-pchip-rt { border-color: #f3d9a8; }
.ss-pchip-rt i { background: #fff4e0; color: #8a5300; }
.ss-pchip-rt b { color: #8a5300; font-weight: 400; font-style: italic; }
.ss-el { padding: 1px 7px; border-radius: 6px; background: var(--frag-bg); color: #5d2585; line-height: 1.8; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.ss-el .ss-fld { background: #fff; }
.ss-code-inline { background: var(--wash-2); padding: 1px 5px; border-radius: 4px; font-size: 11px; }
.ss-yes { color: var(--ok); font-weight: 700; }
.ss-no { color: var(--ink-3); font-weight: 700; }
.ss-enum { font-weight: 700; border-bottom: 1px dotted var(--line-2); }
.ss-rv-list { display: flex; flex-wrap: wrap; gap: 5px; }
.ss-rv-chip { padding: 1px 8px; border-radius: 6px; background: var(--wash-2); }
.ss-rv-kv { display: grid; gap: 4px; }
.ss-rv-scroll { overflow-x: auto; }
.ss-rv-t { width: 100%; border-collapse: collapse; font-size: 12px; }
.ss-rv-t th { text-align: left; font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--mute); padding: 4px 10px 6px 0; border-bottom: 1px solid var(--line); }
.ss-rv-t td { padding: 7px 10px 7px 0; border-bottom: 1px solid #f3f1ef; vertical-align: top; }
.ss-rv-t tr:last-child td { border-bottom: 0; }
.ss-rv-dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 7px 14px; margin: 0; }
.ss-rv-dl dt { color: var(--ink-3); font-size: 12px; }
.ss-rv-dl dd { margin: 0; min-width: 0; }
.ss-code { border-radius: 10px; overflow: hidden; background: #1f1b1a; }
.ss-code-h { padding: 6px 12px; font-size: 11px; color: #a39992; background: #2a2523; }
.ss-code ol { margin: 0; padding: 8px 0; max-height: 320px; overflow: auto; counter-reset: ln; list-style: none; font: 11.5px/1.7 var(--mono); color: #e8e2dc; }
.ss-code li { counter-increment: ln; padding: 0 12px 0 44px; position: relative; white-space: pre-wrap; word-break: break-all; }
.ss-code li::before { content: counter(ln); position: absolute; left: 0; width: 30px; text-align: right; color: #6e6259; }
.ss-code .ss-pchip { border-color: #4a6b56; }
.ss-kw { color: #ff9e7a; }
.ss-cm { color: #8d8279; font-style: italic; }
.ss-code-more { width: 100%; padding: 7px; font-size: 12px; color: #e8e2dc; background: #2a2523; }
.ss-code-more:hover { background: #352e2b; }

/* runtime:loadResource() files and their looked-up values */
.ss-res { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 3px 6px; vertical-align: middle; max-width: 100%; font-weight: 400; }
.ss-res-file { display: inline-flex; align-items: center; gap: 4px; font: 11px/1.6 var(--mono); padding: 0 6px; border-radius: 5px; background: var(--wash-2); color: var(--ink-2); word-break: break-all; }
.ss-res-btn { height: 20px; padding: 0 9px; border-radius: 99px; font-size: 11px; font-weight: 700; color: var(--proc); background: var(--proc-bg); border: 1px solid #cfe0f2; white-space: nowrap; }
.ss-res-btn:hover:not(:disabled) { background: #d9e8f7; }
.ss-res-btn:disabled { opacity: .55; }
.ss-res-val { font: 700 11.5px/1.6 var(--mono); padding: 0 7px; border-radius: 5px; background: var(--src-bg); color: #17663a; white-space: pre-wrap; word-break: break-all; }
.ss-res-val::before { content: '= '; font-weight: 400; color: var(--mute); }
.ss-res-lock { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--ink-3); }
.ss-res-err { font-size: 11px; color: var(--bad); }
.ss-what-files { margin-top: 10px; }

/* expressions: words first, the exact text one click away */
.ss-elraw-btn { margin-left: 4px; height: 18px; padding: 0 5px; border-radius: 5px; font: 400 10px var(--mono); color: var(--mute); border: 1px solid var(--line-2); background: #fff; vertical-align: 1px; }
.ss-elraw-btn:hover, .ss-elraw-btn.is-on { color: var(--ink); border-color: var(--ink-3); }
.ss-elraw { display: block; margin: 5px 0 2px; padding: 5px 8px; border-radius: 6px; background: #fbfaf9; border: 1px solid #f0edea; font: 400 11px/1.55 var(--mono); color: var(--ink); white-space: pre-wrap; word-break: break-all; }
.ss-what-lead, .ss-what li, .ss-fs-body p, .ss-fs-body li { overflow-wrap: anywhere; }

/* ------------------------------ run panel ------------------------------ */
/* Bottom-left of the work area: bottom-right belongs to the floating assistant. */
.ss-dock { position: absolute; left: 356px; bottom: 16px; width: 490px; max-width: calc(100% - 372px); z-index: 30; border-radius: 18px; background: #fff; border: 1px solid var(--line); box-shadow: var(--sh-3); overflow: hidden; animation: ss-rise .35s var(--ease); }
.ss-dock.is-min { width: auto; display: flex; align-items: center; gap: 10px; padding: 7px 16px 7px 7px; border-radius: 99px; text-align: left; }
.ss-dock-head { display: flex; align-items: center; gap: 12px; padding: 13px 14px 13px 16px; }
.ss-pring { width: 44px; height: 44px; flex-shrink: 0; position: relative; }
.ss-dock.is-min .ss-pring { width: 34px; height: 34px; }
.ss-pring b { position: absolute; inset: 0; display: grid; place-items: center; font-size: 11px; font-variant-numeric: tabular-nums; }
.ss-pring.is-ok .ss-ring-fg { stroke: var(--ok); } .ss-pring.is-ok b { color: var(--ok); }
.ss-pring.is-bad .ss-ring-fg { stroke: var(--bad); } .ss-pring.is-bad b { color: var(--bad); }
.ss-pring.is-running::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid transparent; border-top-color: rgba(235, 23, 0, .35); animation: ss-spin 1.2s linear infinite; }
.ss-dock-t { flex: 1; min-width: 0; }
.ss-dock-t b { display: block; font-size: 14px; }
.ss-dock-t small { color: var(--ink-3); font-size: 12px; font-variant-numeric: tabular-nums; }
.ss-dock-acts { display: flex; gap: 6px; align-items: center; }
.ss-dock-bar { height: 3px; background: var(--wash-2); }
.ss-dock-bar i { display: block; height: 100%; background: var(--red); transition: width .4s var(--ease); }
.ss-dock-err { padding: 0 14px 10px; }
.ss-dock-body { display: flex; max-height: 42vh; border-top: 1px solid var(--line); }
.ss-runs { flex: 1; min-width: 0; overflow-y: auto; padding: 6px; list-style: none; margin: 0; }
.ss-runs li { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border-radius: 10px; }
.ss-runs li:hover { background: var(--wash); }
.ss-st { width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0; display: grid; place-items: center; }
.ss-st.is-queued { border: 1.6px dashed var(--line-2); }
.ss-st.is-running { border: 2px solid var(--red-line); border-top-color: var(--red); animation: ss-spin .8s linear infinite; }
.ss-st.is-done { background: var(--ok); color: #fff; animation: ss-pop .3s var(--ease); }
.ss-st.is-failed { background: var(--bad); color: #fff; animation: ss-pop .3s var(--ease); }
.ss-st.is-cancelled { background: var(--wash-2); }
.ss-run-nm { font-size: 12.5px; font-weight: 700; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; text-align: left; }
.ss-run-nm:hover { color: var(--red); }
.ss-run-err { display: block; font-size: 11.5px; color: var(--bad); }
.ss-run-st { font-size: 11.5px; color: var(--ink-3); flex-shrink: 0; padding-top: 2px; }
.ss-run-st.is-running { color: var(--red); font-weight: 700; }
.ss-run-st.is-done { color: var(--ok); }
.ss-run-st.is-failed { color: var(--bad); }
.ss-console { flex: 1.25; min-width: 0; overflow: auto; margin: 0; padding: 12px 14px; background: #1f1b1a; color: #d9d3cd; font: 11px/1.65 var(--mono); white-space: pre-wrap; word-break: break-all; }
.ss-console .is-ok { color: #7ee2a0; } .ss-console .is-bad { color: #ff8a80; } .ss-console .is-run { color: #8cc8ff; } .ss-console .is-dim { color: #9a8f87; }
.ss-dock-foot { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-top: 1px solid var(--line); background: var(--wash); }
.ss-dock-foot small { color: var(--ink-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* --------------------------- palette, toasts --------------------------- */
.ss-scrim { position: absolute; inset: 0; z-index: 45; background: rgba(49, 44, 42, .32); display: flex; justify-content: center; align-items: flex-start; padding-top: 10vh; animation: ss-fade .15s; }
.ss-palette { width: 620px; max-width: calc(100% - 32px); border-radius: 16px; background: #fff; box-shadow: var(--sh-3); overflow: hidden; animation: ss-rise .2s var(--ease); }
.ss-pal-in { display: flex; align-items: center; gap: 10px; padding: 0 16px; border-bottom: 1px solid var(--line); color: var(--mute); }
.ss-pal-in input { flex: 1; height: 52px; border: 0; outline: none; font-size: 15px; background: transparent; color: var(--ink); }
.ss-pal-list { max-height: 52vh; overflow-y: auto; padding: 6px; }
.ss-pal-g { padding: 10px 10px 4px; font-size: 10.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--mute); }
.ss-pal-item { width: 100%; display: flex; align-items: center; gap: 11px; padding: 8px 10px; border-radius: 10px; text-align: left; }
.ss-pal-item.is-on { background: var(--wash-2); }
.ss-pal-item b { display: block; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-pal-item small { color: var(--ink-3); font-size: 11.5px; }
.ss-pal-ic { width: 22px; height: 22px; border-radius: 6px; background: var(--wash-2); display: grid; place-items: center; color: var(--ink-2); flex-shrink: 0; }
.ss-pal-foot { display: flex; gap: 16px; padding: 9px 16px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--ink-3); background: var(--wash); }
.ss-toasts { position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 50; display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
.ss-toast { display: inline-flex; align-items: center; gap: 9px; padding: 9px 14px; border-radius: 12px; background: var(--ink); color: #fff; font-size: 12.5px; box-shadow: var(--sh-3); animation: ss-rise .25s var(--ease); white-space: nowrap; }
.ss-toast.is-ok .ss-i { color: #7ee2a0; } .ss-toast.is-warn .ss-i { color: #ffc46b; }

/* ---------------------------- whole-page states ------------------------- */
.ss-state { flex: 1; display: grid; place-items: center; padding: 40px; background: var(--wash); }
.ss-state-card { max-width: 480px; text-align: center; animation: ss-rise .4s var(--ease); }
.ss-state-ic { width: 72px; height: 72px; margin: 0 auto 18px; border-radius: 22px; display: grid; place-items: center; background: #fff; border: 1px solid var(--line); box-shadow: var(--sh-2); }
.ss-state-ic.is-frag { color: var(--frag); } .ss-state-ic.is-bad { color: var(--bad); }
.ss-state h2 { margin: 0 0 8px; font-size: 20px; font-weight: 700; }
.ss-state p { margin: 0 auto 18px; color: var(--ink-2); font-size: 13.5px; line-height: 1.6; }
.ss-state code { background: var(--wash-2); padding: 1px 5px; border-radius: 4px; }

/* Short screens (1366x768 cloud desktops): give the flow the height, not the header. */
@media (max-height: 820px) {
  .ss-dhead { padding-top: 10px; }
  .ss-crumbs { margin-bottom: 2px; }
  .ss-dtitle { font-size: 18px; }
  .ss-ddesc { display: none; }
  .ss-dmeta { margin-top: 4px; }
  .ss-route { margin-top: 8px; padding: 7px 14px; }
  .ss-ep-row + .ss-ep-row, .ss-ep > small { display: none; }
  .ss-tabs { margin-top: 4px; }
  .ss-tab { height: 34px; }
  .ss-hero-in { padding-top: 26px; }
}

@media (prefers-reduced-motion: reduce) {
  .ss-root *, .ss-root *::before, .ss-root *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
`;

/* ---------------------- plain-English text + values ---------------------- */

/** Coloured two-letter mark for a technology (Oracle, Snowflake, Kafka...). */
function Tile({ tech, small = false, large = false }) {
  const { color, mark } = techMeta(tech);
  return <span className={`ss-tile${small ? ' ss-tile-sm' : ''}${large ? ' ss-tile-lg' : ''}`} style={{ '--t': color }} aria-hidden="true">{mark}</span>;
}

// Renders the "segments" streamsetsModel builds (see the note above ENUM there).
// compact: parameters show as their value in bold (sentences); otherwise as name|value chips (settings).

const fieldName = (v) => String(v).replace(/^\//, '').replace(/\//g, ' › ') || 'whole record';
const bigNumber = (v) => (/^\d{4,}$/.test(v) ? Number(v).toLocaleString() : v);

function Field({ v }) {
  return <span className="ss-fld" title={`Field ${v}`}>{fieldName(v)}</span>;
}

function Param({ name, value, compact, c }) {
  // a parameter whose value is itself an expression, e.g. ${runtime:loadResource(...)}: show it in words
  if (c) {
    return compact
      ? <span title={`From the pipeline parameter ${name}`}><Rich segs={c} compact /></span>
      : <span className="ss-pchip" title={`From the pipeline parameter ${name}`}><i>{name}</i><b><Rich segs={c} compact /></b></span>;
  }
  if (compact) {
    if (value === null) return <b className="ss-rt" title={`${name} isn't a pipeline parameter - the job or runtime supplies it`}>{name} (set at runtime)</b>;
    if (value === '') return <b className="ss-rt" title={`The pipeline parameter ${name} is empty - the job fills it in`}>{name} (empty)</b>;
    return <b title={`From the pipeline parameter ${name}`}>{value === MASK ? <Secret kind="param" name={name} compact /> : bigNumber(value)}</b>;
  }
  const shown = value === null ? 'set at runtime' : value === MASK ? <Secret kind="param" name={name} compact /> : value === '' ? 'empty' : bigNumber(value);
  return (
    <span className={`ss-pchip ${value === null ? 'ss-pchip-rt' : ''}`}
      title={value === null ? "Not one of the pipeline's parameters - the job or runtime supplies it" : `From the pipeline parameter ${name}`}>
      <i>{name}</i><b>{shown}</b>
    </span>
  );
}

function Rich({ segs, compact = false }) {
  return [].concat(segs ?? []).map((x, i) => {
    if (x == null || x === false || x === '') return null;
    if (typeof x === 'string' || typeof x === 'number') return <React.Fragment key={i}>{x}</React.Fragment>;
    if (Array.isArray(x)) return <Rich key={i} segs={x} compact={compact} />;
    switch (x.t) {
      case 'b': return <b key={i}><Rich segs={x.c} compact /></b>;
      case 'f': return <Field key={i} v={x.v} />;
      case 'p': return <Param key={i} name={x.name} value={x.value} compact={compact} c={x.c} />;
      case 'code': return <code key={i} className="ss-code-inline">{x.v}</code>;
      case 'res': return <ResourceRef key={i} path={x.path} restricted={x.restricted} />;
      case 'el': return <Expr key={i} raw={x.raw} c={x.c} compact={compact} />;
      default: return null;
    }
  });
}

/** An expression in words by default; the { } button shows exactly what's written in the pipeline. */
function Expr({ raw, c, compact }) {
  const [open, setOpen] = useState(false);
  const words = compact ? <Rich segs={c} compact /> : <span className="ss-el"><Rich segs={c} compact /></span>;
  if (!raw || raw.length < 16) return words;
  return (
    <>
      {words}
      <button type="button" className={`ss-elraw-btn${open ? ' is-on' : ''}`} aria-pressed={open}
        title={open ? 'Hide the expression' : 'Show the expression exactly as written'}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}>{'{ }'}</button>
      {open && <code className="ss-elraw">{raw}</code>}
    </>
  );
}

/* ------------------- runtime:loadResource() file values ------------------- */

// The open pipeline's looked-up files, shared so a file shown in several places is fetched once.
const FilesContext = createContext(null);

const secretKey = (kind, name, stage) => `${kind}\n${stage || ''}\n${name}`;

/** A hidden password / key / secret file. People with viewStreamsetsSecrets get a Show button; the
 *  server checks the permission and audits every reveal, and the value hides itself again shortly after. */
function Secret({ kind, name, stage, compact = false }) {
  const files = useContext(FilesContext);
  const key = secretKey(kind, name, stage);
  const r = files?.secret(key);
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  if (r?.state === 'done') {
    return (
      <span className="ss-secret">
        <span className="ss-secret-val" title="Revealed - hides again in 30 seconds">{r.value === '' ? 'empty' : r.value}</span>
        <button type="button" className="ss-res-btn is-hide" onClick={stop(() => files.hide(key))}>Hide</button>
      </span>
    );
  }
  return (
    <span className="ss-secret">
      <Svg name="lock" size={compact ? 12 : 13} />{compact ? 'hidden' : 'Hidden - stored as a secret in StreamSets'}
      {files?.canReveal && (
        <button type="button" className="ss-res-btn" disabled={r?.state === 'loading'}
          title="Show the real value (this is recorded in the audit log)"
          onClick={stop(() => files.reveal(kind, name, stage))}>
          {r?.state === 'loading' ? 'Revealing…' : r?.state === 'error' ? 'Try again' : 'Show'}
        </button>
      )}
      {r?.state === 'error' && <span className="ss-res-err" title={r.error}>{r.error}</span>}
    </span>
  );
}

function ResourceRef({ path, restricted }) {
  const files = useContext(FilesContext);
  const r = files?.get(path);
  let tail;
  if (restricted || r?.state === 'secret') {
    tail = files?.canReveal
      ? <Secret kind="resource" name={path} compact />
      : <span className="ss-res-lock" title="A restricted (secret) file - its value isn't shown"><Svg name="lock" size={12} />secret</span>;
  } else if (r?.state === 'done') {
    tail = <span className="ss-res-val" title={`Read from ${r.host}`}>{r.value === '' ? 'empty file' : r.value}</span>;
  } else if (r?.state === 'error') {
    tail = (<>
      <span className="ss-res-err" title={r.error}>{r.error}</span>
      <button type="button" className="ss-res-btn" onClick={(e) => { e.stopPropagation(); files.resolve(path); }}>Try again</button>
    </>);
  } else {
    tail = (
      <button type="button" className="ss-res-btn" disabled={!files?.available || r?.state === 'loading'}
        title={files?.available ? 'Read this file from the Data Collector' : "The SmartHub server can't read Data Collector files (paramiko isn't installed)"}
        onClick={(e) => { e.stopPropagation(); files.resolve(path); }}>
        {r?.state === 'loading' ? 'Looking up…' : 'Show value'}
      </button>
    );
  }
  return (
    <span className="ss-res">
      <span className="ss-res-file" title={`Data Collector loads this resource file when the pipeline runs: ${path}`}><Svg name="file" size={12} />{path}</span>
      {tail}
    </span>
  );
}

/** "Show all file values" for a list of { path, restricted } - hidden once there's nothing left to look up. */
function ResolveAll({ refs }) {
  const files = useContext(FilesContext);
  const todo = refs.filter(f => !f.restricted && !['done', 'secret', 'loading'].includes(files?.get(f.path)?.state));
  if (!files?.available || !todo.length) return null;
  return (
    <button type="button" className="ss-btn ss-btn-sm" onClick={() => files.resolveAll(todo.map(f => f.path))}
      title="Read every resource file used here from the Data Collector">
      <Svg name="file" />Show all file values ({todo.length})
    </button>
  );
}

/* ------------------------------ code blocks ------------------------------ */

const SQL_KW = /\b(SELECT|FROM|WHERE|ORDER BY|GROUP BY|AND|OR|NOT|IN|AS|JOIN|LEFT|RIGHT|INNER|ON|LIMIT|NULL|IS|UNION|CASE|WHEN|THEN|ELSE|END)\b/;
const SCRIPT_KW = /\b(for|in|try|except|finally|if|else|elif|return|def|import|from|each|var|let|const|function|while|null|None|True|False)\b/;
const SHOW_LINES = 60;   // long scripts open folded so a big stage doesn't stall a slow machine

function keywords(text, re, key) {
  return text.split(new RegExp(`(${re.source})`)).map((part, i) => (i % 2 ? <span key={`${key}-${i}`} className="ss-kw">{part}</span> : part));
}
function codeLine(line, sql, ctx) {
  if (sql) {
    return tmpl(line, ctx).map((seg, i) => (typeof seg === 'string' ? keywords(seg, SQL_KW, i) : <Rich key={i} segs={seg} />));
  }
  const at = line.search(/(^|\s)(#|\/\/)/);
  const code = at < 0 ? line : line.slice(0, at);
  const note = at < 0 ? '' : line.slice(at);
  return <>{keywords(code, SCRIPT_KW, 'k')}{note && <span className="ss-cm">{note}</span>}</>;
}

function CodeBlock({ text, title, sql = false, ctx }) {
  const lines = String(text).split('\n');
  const [all, setAll] = useState(lines.length <= SHOW_LINES);
  const shown = all ? lines : lines.slice(0, SHOW_LINES);
  return (
    <div className="ss-code">
      <div className="ss-code-h">{title} · {lines.length} line{lines.length === 1 ? '' : 's'}</div>
      <ol>{shown.map((l, i) => <li key={i}>{l ? codeLine(l, sql, ctx) : ' '}</li>)}</ol>
      {!all && <button type="button" className="ss-code-more" onClick={() => setAll(true)}>Show all {lines.length} lines</button>}
    </div>
  );
}

/* ---------------------------- readable values ---------------------------- */

const isPath = (s) => /^\/[\w/]*$/.test(s);

function Str({ s, k, ctx, stage }) {
  if (/script/i.test(k)) return <CodeBlock text={s} title={`${stage?.technology && stage.technology !== 'StreamSets' ? `${stage.technology} ` : ''}script`} ctx={ctx} />;
  if (/query|sql|statement/i.test(k)) return <CodeBlock text={s} title={/soql/i.test(k) ? 'SOQL query' : 'SQL'} sql ctx={ctx} />;
  if (/predicate|condition/i.test(k) && s === 'default') return <>Everything else (the default route)</>;
  if (ENUM[s]) return <span className="ss-enum" title={`StreamSets value: ${s}`}>{ENUM[s]}</span>;
  if (isPath(s)) return <Field v={s} />;
  if (/^\/?\*\*?\[\s*\$\{/.test(s)) return <Expr raw={s} c={fieldSelector(s, ctx)} />;   // *[${f:type() == 'DATE'}]
  if (/^\d{4,}$/.test(s)) return <b>{Number(s).toLocaleString()}</b>;
  return <Rich segs={tmpl(s, ctx)} />;
}

/** Any setting value laid out for reading: tables, lists, yes/no, chips. Nothing is dropped. */
function Readable({ v, k = '', ctx, stage }) {
  if (v === null || v === undefined || v === '') return <span className="ss-muted">Not set</span>;
  if (typeof v === 'boolean') return v ? <span className="ss-yes">✓ Yes</span> : <span className="ss-no">✕ No</span>;
  if (typeof v === 'number') return <b>{v.toLocaleString()}</b>;
  if (Array.isArray(v)) {
    if (!v.length) return <span className="ss-muted">None</span>;
    if (v.every(x => x === null || typeof x !== 'object')) {
      return (
        <span className="ss-rv-list">
          {v.map((x, i) => (isPath(String(x)) ? <Field key={i} v={String(x)} /> : <span key={i} className="ss-rv-chip"><Str s={String(x)} k={k} ctx={ctx} stage={stage} /></span>))}
        </span>
      );
    }
    const keys = [...new Set(v.flatMap(o => (o && typeof o === 'object' ? Object.keys(o) : [])))];
    if (keys.length === 2 && keys.includes('key') && keys.includes('value')) {
      return <div className="ss-rv-kv">{v.map((o, i) => <div key={i}><b>{String(o.key)}</b> <span className="ss-muted">→</span> <Readable v={o.value} k="value" ctx={ctx} stage={stage} /></div>)}</div>;
    }
    if (v.length === 1) return <Readable v={v[0]} k={k} ctx={ctx} stage={stage} />;
    return (
      <div className="ss-rv-scroll">
        <table className="ss-rv-t">
          <thead><tr>{keys.map(key => <th key={key}>{word(key)}</th>)}</tr></thead>
          <tbody>
            {v.map((o, i) => (
              <tr key={i}>{keys.map(key => <td key={key}>{o?.[key] === undefined ? <span className="ss-muted">-</span> : <Readable v={o[key]} k={key} ctx={ctx} stage={stage} />}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (typeof v === 'object') {
    return (
      <dl className="ss-rv-dl">
        {Object.entries(v).map(([key, x]) => (
          <React.Fragment key={key}><dt>{word(key)}</dt><dd><Readable v={x} k={key} ctx={ctx} stage={stage} /></dd></React.Fragment>
        ))}
      </dl>
    );
  }
  return <Str s={String(v)} k={k} ctx={ctx} stage={stage} />;
}

/* ------------------------------ small parts ------------------------------ */

// Inline glyphs: crisp at any zoom, nothing to load, and they take currentColor.
const Glyph = {
  search: <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm3.6-1.4L14 14" />,
  refresh: <path d="M13.5 8A5.5 5.5 0 1 1 11.9 4M13.5 2v3h-3" />,
  close: <path d="M4 4l8 8m0-8-8 8" />,
  chevron: <path d="M6 3.5 10.5 8 6 12.5" />,
  download: <path d="M8 2.5v8m-3.5-3.5L8 10.5 11.5 7M3 13.5h10" />,
  alert: <path d="M8 1.8 15 14H1L8 1.8Zm0 4.4v3.6m0 1.9v.1" />,
  copy: <path d="M5.5 5.5h8v8h-8zM3.5 10.5h-1v-8h8v1" />,
  bolt: <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8l1-5.5Z" />,
  check: <path d="M3 8.5 6.5 12 13 4.5" />,
  x: <path d="M4.5 4.5l7 7m0-7-7 7" />,
  plus: <path d="M8 3v10M3 8h10" />,
  flow: <path d="M1.5 4.5h3v3h-3zM11.5 2h3v3h-3zM11.5 11h3v3h-3zM4.5 6h2.5c2 0 2-2.5 4.5-2.5M7 6c2 0 2 6.5 4.5 6.5" />,
  list: <path d="M5.5 4h8m-8 4h8m-8 4h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />,
  sliders: <path d="M2 4h7m3 0h2M2 12h2m3 0h7M9 2.5v3m-5 5v3" />,
  lock: <path d="M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5" />,
  git: <path d="M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm-6.5-2.5h4m5 0h4" />,
  cpu: <path d="M4 4h8v8H4zM6.5 1.5V4m3-2.5V4m-3 8v2.5m3-2.5v2.5M1.5 6.5H4m-2.5 3H4m8-3h2.5m-2.5 3h2.5" />,
  layers: <path d="M8 1.8 14.5 5 8 8.2 1.5 5 8 1.8ZM1.5 8 8 11.2 14.5 8M1.5 11 8 14.2 14.5 11" />,
  terminal: <path d="M2 3h12v10H2zM4.5 6.5 6.5 8l-2 1.5M8 10h3" />,
  minimize: <path d="M3.5 10.5 8 6l4.5 4.5" />,
  plug: <path d="M5.5 1.5v3m5-3v3M3.5 4.5h9v3a4.5 4.5 0 0 1-9 0v-3ZM8 12v2.5" />,
  cloudoff: <path d="M2 2l12 12M5 5.2A4 4 0 0 0 4.5 13h7.2M13.6 11.4A3 3 0 0 0 11.5 6.1 4 4 0 0 0 7 3.1" />,
  file: <path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3" />,
};
function Svg({ name, size = 15, className = '', strokeWidth = 1.6 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" className={`ss-i ${className}`} aria-hidden="true">
      {Glyph[name]}
    </svg>
  );
}

function ErrorBox({ message, onRetry, children }) {
  return (
    <div role="alert" className="ss-errbox">
      <Svg name="alert" size={16} />
      <div className="ss-grow">{message}{children}</div>
      {onRetry && <button type="button" className="ss-link" onClick={onRetry}>Try again</button>}
    </div>
  );
}

function IconButton({ label, onClick, disabled, spinning, name }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} className={`ss-ibtn${spinning ? ' is-spin' : ''}`}>
      <Svg name={name} />
    </button>
  );
}

/** First match of q in text, marked. */
function Hl({ text, q }) {
  const t = String(text ?? '');
  const needle = (q || '').trim();
  const at = needle ? t.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at < 0) return t;
  return <>{t.slice(0, at)}<mark className="ss-mark">{t.slice(at, at + needle.length)}</mark>{t.slice(at + needle.length)}</>;
}

const TAG_TONE = { legacy: 'warn', gxp: 'proc', pii: 'frag' };
const Tag = ({ label, q }) => <span className={`ss-tag ss-tag-${TAG_TONE[label] || 'plain'}`}><Hl text={label} q={q} /></span>;

/* ----------------------------- pipeline list ----------------------------- */

// One memo'd row each, so ticking a box re-renders that row - not all 500.
const PipelineRow = memo(function PipelineRow({ p, query, isOpen, isPicked, locked, runState, maxPerRun, onPick, onOpen }) {
  return (
    <li style={ROW_CV} className={`ss-card${isOpen ? ' is-open' : ''}${isPicked ? ' is-picked' : ''}`}>
      <button type="button" role="checkbox" aria-checked={isPicked} className="ss-check" disabled={locked}
        onClick={() => onPick(p.id)} aria-label={`Pick ${p.name} for extraction`}
        title={locked ? `You can extract up to ${maxPerRun} pipelines at a time` : undefined}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" /></svg>
      </button>
      <button type="button" className="ss-card-open" onClick={() => onOpen(p.id)} aria-current={isOpen ? 'true' : undefined}
        title={p.modified_by ? `Last changed by ${p.modified_by}` : undefined}>
        <div className="ss-card-nm"><Hl text={p.name} q={query} /></div>
        {p.description && <div className="ss-card-ds"><Hl text={p.description} q={query} /></div>}
        <div className="ss-meta">
          {p.version && <span>v{p.version}</span>}
          {p.last_modified && <span title={shortDate(p.last_modified)}>{relativeDay(p.last_modified)}</span>}
          {(p.labels || []).slice(0, 3).map(l => <Tag key={l} label={l} q={query} />)}
          {runState === 'running' && <span className="ss-tag ss-tag-red">● extracting</span>}
          {runState === 'done' && <span className="ss-tag ss-tag-ok">✓ extracted</span>}
          {runState === 'failed' && <span className="ss-tag ss-tag-bad">✕ failed</span>}
        </div>
      </button>
    </li>
  );
});

const PipelineList = memo(function PipelineList({ rows, query, openId, picked, full, maxPerRun, runStates, onPick, onOpen }) {
  return (
    <ul className="ss-list-ul">
      {rows.map(p => (
        <PipelineRow key={p.id} p={p} query={query} isOpen={p.id === openId} isPicked={picked.has(p.id)} locked={full && !picked.has(p.id)}
          runState={runStates.get(p.id)} maxPerRun={maxPerRun} onPick={onPick} onOpen={onOpen} />
      ))}
    </ul>
  );
});

function ListSkeleton() {
  return (
    <div className="ss-list-sk" aria-hidden="true">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="ss-list-sk-row">
          <SkeletonLine w="20px" h={20} />
          <div className="ss-grow ss-stack-6">
            <SkeletonLine w={`${55 + (i % 4) * 10}%`} h={11} />
            <SkeletonLine w="80%" h={9} />
            <SkeletonLine w="35%" h={8} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Tray({ picked, maxPerRun, nameOf, running, extractorReady, reason, shake, onUnpick, onClear, onExtract }) {
  const ids = [...picked];
  const n = ids.length;
  const C = 2 * Math.PI * 15;
  return (
    <div className={`ss-tray${shake ? ' is-shake' : ''}`}>
      <div className="ss-tray-top">
        <div className="ss-ring" title={`${n} of ${maxPerRun} picked`}>
          <svg viewBox="0 0 38 38"><circle className="ss-ring-bg" cx="19" cy="19" r="15" /><circle className="ss-ring-fg" cx="19" cy="19" r="15" strokeDasharray={C} strokeDashoffset={C * (1 - n / maxPerRun)} /></svg>
          <b>{n}</b>
        </div>
        <div className="ss-grow">
          <b className="ss-tray-h">{n ? `${plural(n, 'pipeline', 'pipelines')} picked` : 'Build an extraction'}</b>
          <small className="ss-sub">{n ? `${maxPerRun - n} more can join this run` : `Tick up to ${maxPerRun} pipelines on the left`}</small>
        </div>
        {n > 0 && <button type="button" className="ss-link" onClick={onClear}>Clear</button>}
      </div>
      {n > 0 && (
        <div className="ss-picks">
          {ids.slice(0, 4).map(id => (
            <span key={id} className="ss-pick" title={nameOf(id)}>
              <span>{nameOf(id)}</span>
              <button type="button" onClick={() => onUnpick(id)} aria-label={`Remove ${nameOf(id)}`}><Svg name="x" size={11} /></button>
            </span>
          ))}
          {n > 4 && <span className="ss-pick ss-pick-more">+{n - 4} more</span>}
        </div>
      )}
      <button type="button" className="ss-cta" onClick={onExtract} disabled={!n || running || !extractorReady}
        title={!extractorReady ? reason || 'The extractor is not available' : running ? 'An extraction is already running' : undefined}>
        <Svg name="bolt" size={16} />
        {running ? 'Extraction running…' : n ? `Extract ${plural(n, 'pipeline', 'pipelines')}` : 'Extract pipelines'}
      </button>
      {!extractorReady
        ? <div className="ss-tray-note is-warn"><Svg name="alert" size={14} /><span>{reason || 'The extractor is not available on the server.'}</span></div>
        : <div className="ss-tray-note">You&apos;ll get one JSON report with every stage, setting and parameter.</div>}
    </div>
  );
}

/* --------------------------------- hero ---------------------------------- */

function HeroArt() {
  const nodes = [
    { x: 0, tech: 'Oracle', kind: 'SOURCE', label: 'SAP materials' },
    { x: 190, tech: 'Jython', kind: 'PROCESSOR', label: 'Clean & enrich' },
    { x: 380, tech: 'Fragment', kind: null, label: 'Audit columns' },
    { x: 570, tech: 'Snowflake', kind: 'TARGET', label: 'DQ_RAW.MARA' },
  ];
  const W = 150, H = 62, Y = 20, MID = Y + H / 2;
  // Dots run along the wires a few times and then stop - no endless repaint on a CPU-only machine.
  return (
    <svg viewBox="-6 0 732 112" className="ss-hero-svg" role="img" aria-label="A pipeline reads from Oracle, transforms the data and writes it to Snowflake">
      {nodes.slice(1).map((n, i) => (
        <path key={i} id={`ss-hw${i}`} className="ss-hero-wire" d={`M${nodes[i].x + W} ${MID} C${nodes[i].x + W + 20} ${MID}, ${n.x - 20} ${MID}, ${n.x} ${MID}`} />
      ))}
      {!reducedMotion() && [0, 1, 2].map(i => (
        <circle key={i} r="4" fill="#eb1700" opacity="0">
          <animateMotion dur="1.4s" begin={`${0.9 + i * 0.45}s`} repeatCount="4" fill="remove"><mpath href={`#ss-hw${i}`} /></animateMotion>
          <animate attributeName="opacity" values="0;1;1;0" dur="1.4s" begin={`${0.9 + i * 0.45}s`} repeatCount="4" />
        </circle>
      ))}
      {nodes.map((n, i) => {
        const k = n.kind ? KIND[n.kind] : FRAGMENT;
        const { color, mark } = techMeta(n.tech);
        return (
          <g key={n.tech} className="ss-hero-node" style={{ animationDelay: `${0.2 + i * 0.12}s` }}>
            <rect x={n.x} y={Y} width={W} height={H} rx="13" fill="#fff" stroke="#d5cfc9" />
            <rect x={n.x} y={Y + 12} width="3" height={H - 24} rx="1.5" fill={k.color} />
            <rect x={n.x + 13} y={Y + 16} width="30" height="30" rx="8" fill={color} />
            <text x={n.x + 28} y={Y + 35} textAnchor="middle" fill="#fff" fontSize="10" fontWeight="700">{mark}</text>
            <text x={n.x + 52} y={Y + 27} fontSize="9" fontWeight="700" letterSpacing=".6" fill={k.color}>{k.label.toUpperCase()}</text>
            <text x={n.x + 52} y={Y + 43} fontSize="12" fontWeight="700" fill="#312c2a">{n.label}</text>
            <circle cx={n.x} cy={MID} r="4" fill="#fff" stroke="#d5cfc9" strokeWidth="2" />
            <circle cx={n.x + W} cy={MID} r="4" fill="#fff" stroke="#d5cfc9" strokeWidth="2" />
          </g>
        );
      })}
      <text x="365" y="106" textAnchor="middle" fontSize="11" fill="#a39992">Every pipeline, drawn left to right - the way its records actually travel</text>
    </svg>
  );
}
const Hero = memo(function Hero({ pipelines, loading, server, maxPerRun, onOpen, onFocusSearch }) {
  const recent = useMemo(() => [...pipelines].filter(p => p.last_modified)
    .sort((a, b) => String(b.last_modified).localeCompare(String(a.last_modified))).slice(0, 4), [pipelines]);
  const example = recent[0] || pipelines[0];
  return (
    <div className="ss-hero">
      <div className="ss-hero-in">
        <span className="ss-eyebrow"><b>{loading ? '…' : pipelines.length}</b>pipelines{server ? ` on ${server}` : ''}</span>
        <h1 className="ss-hero-h">Open any pipeline and <span>see exactly how its data moves.</span></h1>
        <p className="ss-hero-lede">
          Trace where records come from, every transformation and fragment they pass through, and where they land.
          Then pick the pipelines you need and export their full definitions in one report.
        </p>
        <div className="ss-hero-actions">
          <button type="button" className="ss-btn ss-btn-dark" onClick={onFocusSearch}><Svg name="search" />Find a pipeline <kbd>/</kbd></button>
          {example && <button type="button" className="ss-btn" onClick={() => onOpen(example.id)}><Svg name="flow" />Show me an example</button>}
        </div>
        <div className="ss-hero-art"><HeroArt /></div>
        <div className="ss-steps">
          {[
            ['search', 'proc', 'Find', 'Search by name, pipeline ID, label or who changed it last. Filter by label with one click.'],
            ['flow', 'frag', 'Inspect', 'Follow the flow, open fragments in place, and click any stage to read what it does in plain English.'],
            ['bolt', 'red', 'Extract', `Tick up to ${maxPerRun} pipelines and run the extractor. Watch it live, then download the JSON report.`],
          ].map(([icon, tone, title, text], i) => (
            <div key={title} className="ss-step" style={{ animationDelay: `${0.25 + i * 0.08}s` }}>
              <span className="ss-step-num">0{i + 1}</span>
              <div className={`ss-step-ic ss-tone-${tone}`}><Svg name={icon} size={19} /></div>
              <b>{title}</b>
              <p>{text}</p>
            </div>
          ))}
        </div>
        {recent.length > 0 && (<>
          <div className="ss-recent-h"><h3>Recently changed</h3><span>pick up where your team left off</span></div>
          <div className="ss-recent">
            {recent.map(p => (
              <button key={p.id} type="button" className="ss-rc" onClick={() => onOpen(p.id)}>
                <div className="ss-grow">
                  <b>{p.name}</b>
                  <small>{p.version ? `v${p.version} · ` : ''}{relativeDay(p.last_modified)}{p.modified_by ? ` by ${p.modified_by}` : ''}</small>
                </div>
                <Svg name="chevron" className="ss-rc-arrow" />
              </button>
            ))}
          </div>
        </>)}
      </div>
    </div>
  );
});

/* ------------------------------ stage list ------------------------------ */

function FilterInput({ value, onChange, label }) {
  return (
    <div className="ss-finput">
      <Svg name="search" size={14} />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={label} aria-label={label} />
    </div>
  );
}

function StagesView({ detail, selectedPath, onSelect, summaries }) {
  const [filter, setFilter] = useState('');
  const [only, setOnly] = useState(null);
  const rows = useMemo(() => flattenStages(detail.stages), [detail.stages]);
  const q = filter.trim().toLowerCase();
  const hit = q
    ? rows.filter(({ stage, parents, path }) => [stage.label, stage.instance, stage.technology, stage.type_name, stage.fragment?.name,
      summaries.get(path), ...parents.map(p => p.fragment.name)].some(v => String(v || '').toLowerCase().includes(q)))
    : rows;
  const groups = [
    ...KIND_ORDER.map(kind => ({ key: kind, k: KIND[kind], rows: hit.filter(r => !r.stage.fragment && r.stage.kind === kind) })),
    { key: 'FRAGMENT', k: FRAGMENT, rows: hit.filter(r => r.stage.fragment) },
  ].filter(g => g.rows.length);
  const shown = groups.filter(g => !only || g.key === only);

  return (
    <div className="ss-pad">
      <div className="ss-toolrow">
        <FilterInput value={filter} onChange={setFilter} label="Filter by name, type or what it does" />
        {groups.map(g => (
          <button key={g.key} type="button" className={`ss-kchip ss-k-${g.k.cls}${only === g.key ? ' is-on' : ''}`} onClick={() => setOnly(only === g.key ? null : g.key)}>
            <i />{g.k.plural} <em>{g.rows.length}</em>
          </button>
        ))}
      </div>
      {shown.length === 0 && <div className="ss-nomatch">No stage matches “{filter}”.</div>}
      {shown.map(g => (
        <section key={g.key} className={`ss-k-${g.k.cls}`}>
          <h3 className="ss-group-h"><i />{g.k.plural} <em>{g.rows.length}</em></h3>
          <div className="ss-sgrid">
            {g.rows.map(({ stage, parents, path }) => (
              <button key={path} type="button" onClick={() => onSelect(path)}
                className={`ss-scard ss-k-${kindOf(stage).cls}${selectedPath === path ? ' is-sel' : ''}`}>
                <Tile tech={stage.technology} />
                <div className="ss-grow">
                  <b><Hl text={stage.label} q={filter} /></b>
                  <small>{stageSubtitle(stage)}</small>
                  {parents.length > 0 && <small className="ss-in-frag">in {parents.map(p => p.fragment.name).join(' › ')}</small>}
                  <p className="ss-scard-sum">{summaries.get(path)}</p>
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ----------------------------- parameters ------------------------------- */

function ParamsView({ detail, onSelect }) {
  const [filter, setFilter] = useState('');
  // Which setting of which stage reads each parameter - where it's used says what it's for.
  const { uses, runtime } = useMemo(() => {
    const map = new Map();
    const rt = new Set();
    flattenStages(detail.stages).forEach(({ stage, path }) => stage.config.forEach(c => c.params.forEach(p => {
      if (p.value === null) rt.add(p.name);
      const list = map.get(p.name) || map.set(p.name, []).get(p.name);
      if (!list.some(u => u.path === path && u.setting === word(c.name))) list.push({ path, stage, setting: word(c.name) });
    })));
    return { uses: map, runtime: [...rt] };
  }, [detail.stages]);
  const ctx = useMemo(() => stageCtx(detail, ''), [detail]);
  const files = useMemo(() => resourceRefs(detail.parameters.map(p => p.value)), [detail.parameters]);
  const q = filter.trim().toLowerCase();
  const rows = detail.parameters.filter(p => !q || p.name.toLowerCase().includes(q) || String(p.value).toLowerCase().includes(q));

  if (!detail.parameters.length && !runtime.length) {
    return <div className="ss-pad ss-muted">This pipeline defines no parameters.</div>;
  }
  return (
    <div className="ss-pad">
      <div className="ss-toolrow">
        <FilterInput value={filter} onChange={setFilter} label="Filter by name or value" />
        <span className="ss-sub">
          {plural(detail.parameters.length, 'parameter', 'parameters')} defined
          {runtime.length > 0 && <span className="ss-warn-text"> · {runtime.length} more used but only set at runtime: {runtime.join(', ')}</span>}
        </span>
        <span className="ss-push"><ResolveAll refs={files} /></span>
      </div>
      <div className="ss-ptable">
        <div className="ss-prow ss-prow-head"><span>Name</span><span>Value</span><span>Where it&apos;s used</span></div>
        {rows.map(p => (
          <div key={p.name} className="ss-prow">
            <span className="ss-pname"><Hl text={p.name} q={filter} /></span>
            <span className="ss-pval">
              {p.value === MASK ? <Secret kind="param" name={p.name} />
                : p.value === '' ? <span className="ss-muted">Empty here - the job fills it in when it runs</span>
                  : String(p.value).includes('${') ? <Rich segs={tmpl(p.value, ctx)} />
                    : <Hl text={p.value} q={filter} />}
            </span>
            <span className="ss-users">
              {(uses.get(p.name) || []).map(u => (
                <button key={`${u.path}:${u.setting}`} type="button" className={`ss-ulink ss-k-${kindOf(u.stage).cls}`} onClick={() => onSelect(u.path)} title={`Open ${u.stage.label}`}>
                  <i /><span>{u.stage.label}</span><em>{u.setting}</em>
                </button>
              ))}
              {!(uses.get(p.name) || []).length && <span className="ss-muted">Not used by any stage</span>}
            </span>
          </div>
        ))}
        {rows.length === 0 && <div className="ss-prow"><span className="ss-muted">No parameter matches “{filter}”.</span></div>}
      </div>
    </div>
  );
}

/* ----------------------------- stage drawer ----------------------------- */

function SettingCard({ c, ctx, stage, raw, onFlip, onCopy, copied }) {
  return (
    <div className="ss-cfg">
      <div className="ss-cfg-h">
        <b title={c.name}>{word(c.name)}</b>
        <button type="button" className={`ss-rawbtn${raw ? ' is-on' : ''}`} onClick={() => onFlip(c.name)} aria-pressed={raw}
          title={raw ? 'Back to the readable view' : 'Show the exact value stored in StreamSets'}>{'{ }'} Raw</button>
        {!c.secret && (
          <button type="button" className={`ss-copy${copied ? ' is-done' : ''}`} onClick={() => onCopy(c)} title="Copy the exact value">
            <Svg name={copied ? 'check' : 'copy'} size={13} />{copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {raw ? (<>
        <div className="ss-cfg-raw" title={c.name}>{c.name}</div>
        {c.secret ? <div className="ss-cfg-pre"><Secret kind="config" name={c.name} stage={stage.instance} /></div>
          : <pre className="ss-cfg-pre">{c.value}</pre>}
        {c.params.length > 0 && (
          <div className="ss-prms">
            {c.params.map(p => (
              <span key={p.name} className={`ss-prm${p.value === null ? ' is-rt' : ''}`}>
                {p.name} = {p.value === null ? 'set at runtime' : p.value === MASK ? <Secret kind="param" name={p.name} compact /> : (p.value === '' ? '""' : p.value)}
              </span>
            ))}
          </div>
        )}
      </>) : (
        <div className="ss-rv">
          {c.secret ? <Secret kind="config" name={c.name} stage={stage.instance} />
            : <Readable v={parseVal(c.value)} k={c.name} ctx={ctx} stage={stage} />}
        </div>
      )}
    </div>
  );
}

function StageDrawer({ found, path, detail, rawAll, onRawAll, onSelect, onClose }) {
  const [filter, setFilter] = useState('');
  const [flip, setFlip] = useState(() => new Set());
  const [copied, setCopied] = useState(null);
  const { stage, parents } = found;
  const frag = stage.fragment;
  const ctx = useMemo(() => stageCtx(detail, path), [detail, path]);
  const what = useMemo(() => describe(stage, ctx), [stage, ctx]);
  // resource files this stage reads - in its own settings or the parameters they use (fragments: their steps too)
  const fileRefs = useMemo(() => resourceRefs(flattenStages([stage]).flatMap(({ stage: s }) =>
    s.config.flatMap(c => [c.value, ...c.params.map(p => p.value)]))), [stage]);
  const parentPrefix = path.split('/').slice(0, -1);
  const sibling = (inst) => ctx.siblings.find(s => s.instance === inst);
  const q = filter.trim().toLowerCase();
  const config = stage.config.filter(c => !q || c.name.toLowerCase().includes(q) || word(c.name).toLowerCase().includes(q) || c.value.toLowerCase().includes(q));

  const onFlip = (name) => setFlip(prev => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  const copy = async (c) => {
    try {
      await navigator.clipboard.writeText(c.value);
      setCopied(c.name);
      setTimeout(() => setCopied(x => (x === c.name ? null : x)), 1200);
    } catch { /* clipboard blocked - nothing to do */ }
  };
  const chip = (inst) => {
    const x = sibling(inst);
    return (
      <button key={inst} type="button" className={`ss-ulink ss-k-${x ? kindOf(x).cls : 'exe'}`} onClick={() => onSelect(pathOf(parentPrefix, { instance: inst }))}>
        <i /><span>{x ? x.label : inst}</span>
      </button>
    );
  };

  return (
    <aside className={`ss-drawer ss-k-${kindOf(stage).cls}`} aria-label="Stage details">
      <div className="ss-dr-head">
        {parents.length > 0 && (
          <div className="ss-dr-crumbs">
            <Svg name="layers" size={12} />
            {parents.map((p, i) => (
              <React.Fragment key={p.instance}>
                {i > 0 && <Svg name="chevron" size={11} />}
                <button type="button" onClick={() => onSelect(parentPrefix.slice(0, i + 1).join('/'))}>{p.fragment.name}</button>
              </React.Fragment>
            ))}
          </div>
        )}
        <div className="ss-dr-top">
          <Tile tech={stage.technology} large />
          <div className="ss-grow">
            <div className="ss-klabel">{kindOf(stage).label}</div>
            <h3>{stage.label}</h3>
            <small>{stageSubtitle(stage)}</small>
          </div>
          <IconButton name="close" label="Close stage details (Esc)" onClick={onClose} />
        </div>
      </div>

      <div className="ss-dr-body">
        <div className="ss-what">
          <div className="ss-sec-h">What it does</div>
          <p className="ss-what-lead"><Rich segs={what.lead} compact /></p>
          {what.points.length > 0 && <ul>{what.points.map((p, i) => <li key={i}><Rich segs={p} compact={!frag} /></li>)}</ul>}
          {fileRefs.length > 0 && <div className="ss-what-files"><ResolveAll refs={fileRefs} /></div>}
        </div>

        {frag && (frag.error ? (
          <ErrorBox message={<><b>Its steps couldn&apos;t be loaded.</b> They won&apos;t be in an extraction either. The exact error from StreamSets is under Technical details.</>} />
        ) : (
          <div className="ss-fsteps">
            <div className="ss-sec-h">Step by step <em>{frag.stages.length}</em></div>
            <ol>
              {what.steps.map((x, i) => (
                <li key={x.stage.instance} className={`ss-fs ss-k-${kindOf(x.stage).cls}`} style={{ animationDelay: `${i * 60}ms` }}>
                  <span className="ss-fs-n">{i + 1}</span>
                  <div className="ss-fs-body">
                    <button type="button" onClick={() => onSelect(`${path}/${x.stage.instance}`)} title="Open this step's settings">
                      <Tile tech={x.stage.technology} small /><b>{x.stage.label}</b><small>{stageSubtitle(x.stage)} ›</small>
                    </button>
                    <p><Rich segs={x.lead} compact /></p>
                    {x.points.length > 0 && <ul>{x.points.map((p, j) => <li key={j}><Rich segs={p} compact /></li>)}</ul>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ))}

        {stage.description && (
          <div>
            <div className="ss-sec-h">Note from the pipeline author</div>
            <p className="ss-dr-desc">{stage.description}</p>
          </div>
        )}

        <div>
          <div className="ss-sec-h">Where it sits</div>
          <div className="ss-wires">
            <div className="ss-wires-col">{stage.upstream?.length ? stage.upstream.map(chip) : <span className="ss-muted">Start of the flow</span>}</div>
            <span className="ss-wires-arr" />
            <span className="ss-wires-me">This {frag ? 'fragment' : 'stage'}</span>
            <span className="ss-wires-arr" />
            <div className="ss-wires-col is-r">{stage.downstream?.length ? stage.downstream.map(chip) : <span className="ss-muted">End of the flow</span>}</div>
            {((stage.triggered_by || []).length > 0 || (stage.triggers || []).length > 0) && (
              <div className="ss-wires-ev">
                {(stage.triggered_by || []).length > 0 && <>Runs on events from {stage.triggered_by.map(chip)}</>}
                {(stage.triggers || []).length > 0 && <>Sends events to {stage.triggers.map(chip)}</>}
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="ss-sec-h">
            All settings <em>{stage.config.length}</em>
            <span className="ss-sec-tools">
              {stage.config.length > 5 && (
                <span className="ss-finput ss-finput-sm"><Svg name="search" size={13} />
                  <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter settings" aria-label="Filter settings" />
                </span>
              )}
              <span className="ss-seg" role="group" aria-label="How to show values">
                <button type="button" className={rawAll ? '' : 'is-on'} onClick={() => { onRawAll(false); setFlip(new Set()); }}>Readable</button>
                <button type="button" className={rawAll ? 'is-on' : ''} onClick={() => { onRawAll(true); setFlip(new Set()); }}>Raw</button>
              </span>
            </span>
          </div>
          {stage.config.length === 0 && <div className="ss-muted">No settings have a value.</div>}
          {stage.config.length > 0 && config.length === 0 && <div className="ss-muted">No setting matches “{filter}”.</div>}
          {SECTIONS.map(sec => {
            const items = config.filter(c => sectionOf(c.name) === sec);
            if (!items.length) return null;
            return (
              <React.Fragment key={sec}>
                <div className="ss-cfg-sec">{sec}</div>
                {items.map(c => (
                  <SettingCard key={c.name} c={c} ctx={ctx} stage={stage} raw={rawAll !== flip.has(c.name)} onFlip={onFlip} onCopy={copy} copied={copied === c.name} />
                ))}
              </React.Fragment>
            );
          })}
        </div>

        <details className="ss-tech">
          <summary><Svg name="chevron" size={12} />Technical details</summary>
          <dl>
            <dt>Instance</dt><dd>{stage.instance}</dd>
            <dt>Stage</dt><dd>{stage.stage_name}</dd>
            <dt>Library</dt><dd>{stage.library || '-'}</dd>
            {frag && (<>
              <dt>Fragment ID</dt><dd>{frag.fragment_id || '-'}</dd>
              <dt>Param prefix</dt><dd>{frag.prefix || '-'}</dd>
              {frag.error && (<><dt>Load error</dt><dd>{frag.error}</dd></>)}
            </>)}
          </dl>
        </details>
      </div>
    </aside>
  );
}

/* ----------------------------- detail view ------------------------------ */

function Endpoint({ title, rows, right, onSelect }) {
  return (
    <div className={`ss-ep${right ? ' is-r' : ''}`}>
      <div className="ss-ep-h">{title}</div>
      {rows.length === 0 && <div className="ss-muted">None</div>}
      {rows.slice(0, 2).map(({ stage, path }) => (
        <div key={path} className="ss-ep-row">
          <Tile tech={stage.technology} />
          <button type="button" onClick={() => onSelect(path)} title={`${stage.label} - ${stageSubtitle(stage)}`}>
            <b>{stage.label}</b><small>{stageSubtitle(stage)}</small>
          </button>
        </div>
      ))}
      {rows.length > 2 && <small className="ss-muted">and {rows.length - 2} more</small>}
    </div>
  );
}

const DetailView = memo(function DetailView({
  detail, view, stagePath, found, live, picked, canPick, running, extractorReady, reason, detailLoading, detailError,
  rawAll, onRawAll, onNavigate, onSelectStage, onToggle, onExtract, onRefresh, onCopyId, filesAvailable,
}) {
  // runtime:loadResource() values looked up on request; keyed by pipeline so switching back keeps them
  const [looked, setLooked] = useState(() => new Map());
  const lookUp = useCallback(async (path) => {
    const key = `${detail.id}\n${path}`;
    setLooked(m => new Map(m).set(key, { state: 'loading' }));
    try {
      const r = await fetchJson(`/api/streamsets/resource?pipeline_id=${encodeURIComponent(detail.id)}&path=${encodeURIComponent(path)}`);
      setLooked(m => new Map(m).set(key, r.secret ? { state: 'secret' } : { state: 'done', value: r.value, host: r.host }));
    } catch (err) {
      setLooked(m => new Map(m).set(key, { state: 'error', error: err.message || "Couldn't read that file" }));
    }
  }, [detail.id]);
  // revealed secrets: only for viewStreamsetsSecrets (the server enforces it), held in memory, auto-hidden
  const { hasPermission } = useRBAC();
  const canReveal = hasPermission('viewStreamsetsSecrets');
  const [secrets, setSecrets] = useState(() => new Map());
  const timers = useRef(new Map());
  const hide = useCallback((key) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setSecrets(m => { const n = new Map(m); n.delete(key); return n; });
  }, []);
  const reveal = useCallback(async (kind, name, stage) => {
    const key = `${detail.id}\n${secretKey(kind, name, stage)}`;
    setSecrets(m => new Map(m).set(key, { state: 'loading' }));
    try {
      const qs = new URLSearchParams({ pipeline_id: detail.id, kind, name, ...(stage ? { stage } : {}) });
      const r = await fetchJson(`/api/streamsets/secret?${qs}`);
      setSecrets(m => new Map(m).set(key, { state: 'done', value: r.value ?? '' }));
      clearTimeout(timers.current.get(key));
      timers.current.set(key, setTimeout(() => hide(key), SECRET_SHOWN_MS));
    } catch (err) {
      setSecrets(m => new Map(m).set(key, { state: 'error', error: err.message || "Couldn't show that value" }));
    }
  }, [detail.id, hide]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);   // nothing lingers after the pane closes

  const files = useMemo(() => ({
    canReveal,
    secret: (key) => secrets.get(`${detail.id}\n${key}`),
    reveal,
    hide: (key) => hide(`${detail.id}\n${key}`),
    available: filesAvailable,
    get: (path) => looked.get(`${detail.id}\n${path}`),
    resolve: lookUp,
    // one at a time - each is an SSH round trip to the Data Collectors
    resolveAll: async (paths) => { for (const p of paths) await lookUp(p); },
  }), [canReveal, secrets, reveal, hide, filesAvailable, looked, detail.id, lookUp]);

  const route = useMemo(() => routeSummary(detail.stages), [detail.stages]);
  const summaries = useMemo(() => stageSummaries(detail), [detail]);
  const stageCount = useMemo(() => flattenStages(detail.stages).length, [detail.stages]);
  const c = detail.counts;
  const middle = [
    plural(route.transforms, 'transformation', 'transformations'),
    c.fragments ? plural(c.fragments, 'fragment', 'fragments') : null,
    c.executor ? plural(c.executor, 'executor', 'executors') : null,
  ].filter(Boolean).join(' · ');
  const select = (p) => onNavigate({ stage: p });

  return (
    <FilesContext.Provider value={files}>
    <div className="ss-detail">
      <header className="ss-dhead">
        <div className="ss-crumbs">
          <button type="button" onClick={() => onNavigate({ pipeline: null, stage: null })}>← Overview</button>
          {(detail.labels || []).map(l => <Tag key={l} label={l} />)}
        </div>
        <div className="ss-dtop">
          <div className="ss-grow">
            <h2 className="ss-dtitle">
              {detail.name}
              {live && <span className="ss-live-badge"><span className="ss-dot" />Extracting</span>}
            </h2>
            {detail.description && <p className="ss-ddesc">{detail.description}</p>}
            <div className="ss-dmeta">
              {detail.version && <span className="ss-vpill">v{detail.version}</span>}
              {detail.committed_at && (
                <span title={shortDate(detail.committed_at)}>
                  {detail.committed_by && <span className="ss-avatar">{initials(detail.committed_by)}</span>}
                  Changed {relativeDay(detail.committed_at)}{detail.committed_by ? ` by ${detail.committed_by}` : ''}
                </span>
              )}
              {detail.engine && <span><Svg name="cpu" size={14} />{ENGINES[detail.engine] || detail.engine}</span>}
              <button type="button" onClick={onCopyId} title={detail.id}><Svg name="copy" size={14} />Copy pipeline ID</button>
              {detail.commit_message && (
                <span className="ss-commit" title={`Commit note: ${detail.commit_message}`}><Svg name="git" size={14} /><q>{detail.commit_message}</q></span>
              )}
            </div>
          </div>
          <div className="ss-dactions">
            <IconButton name="refresh" label="Reload this pipeline from StreamSets" onClick={onRefresh} disabled={detailLoading} spinning={detailLoading} />
            <button type="button" className={`ss-btn${picked ? ' is-on' : ''}`} onClick={() => onToggle(detail.id)} disabled={!picked && !canPick}>
              <Svg name={picked ? 'check' : 'plus'} />{picked ? 'In this run' : 'Add to run'}
            </button>
            <button type="button" className="ss-btn ss-btn-primary" onClick={() => onExtract([detail.id])} disabled={running || !extractorReady}
              title={!extractorReady ? reason : running ? 'An extraction is already running' : 'Extract just this pipeline'}>
              <Svg name="bolt" />Extract now
            </button>
          </div>
        </div>
        {detailError && <ErrorBox message={`Couldn't reload: ${detailError.message}`} onRetry={onRefresh} />}
        {c.fragment_errors > 0 && (
          <div className="ss-warnbox"><Svg name="alert" size={16} />
            <div><b>{plural(c.fragment_errors, "fragment couldn't", "fragments couldn't")} be loaded from StreamSets.</b> Their steps aren&apos;t shown, and they&apos;ll be missing from an extraction too.</div>
          </div>
        )}
        <section className="ss-route" aria-label="Route summary">
          <Endpoint title={route.sources.length === 1 ? 'Reads from' : `Reads from ${route.sources.length} sources`} rows={route.sources} onSelect={select} />
          <div className="ss-track">
            <div className="ss-track-sum">{middle}</div>
            <div className="ss-track-line" aria-hidden="true"><span /><span /><span /></div>
          </div>
          <Endpoint title={route.destinations.length === 1 ? 'Writes to' : `Writes to ${route.destinations.length} destinations`} rows={route.destinations} right onSelect={select} />
        </section>
        <nav className="ss-tabs" aria-label="Pipeline views">
          {VIEWS.map(v => (
            <button key={v.id} type="button" className={`ss-tab${view === v.id ? ' is-on' : ''}`} aria-current={view === v.id ? 'page' : undefined}
              onClick={() => onNavigate({ ssview: v.id === 'flow' ? null : v.id })}>
              <Svg name={v.icon} size={15} />{v.label}
              {v.id === 'stages' && <span className="ss-count">{stageCount}</span>}
              {v.id === 'params' && <span className="ss-count">{c.parameters}</span>}
            </button>
          ))}
          {view === 'flow' && <span className="ss-tabs-tip">Tip: hover a stage to trace where its data comes from and goes</span>}
        </nav>
      </header>

      <div className="ss-area">
        <div className={`ss-view${view === 'flow' ? ' is-flow' : ''}`}>
          {view === 'flow' && (
            <Suspense fallback={<div className="ss-center ss-muted">Drawing the pipeline…</div>}>
              <PipelineCanvas key={detail.id} detail={detail} selectedPath={stagePath} onSelect={onSelectStage} live={live} summaries={summaries} />
            </Suspense>
          )}
          {view === 'stages' && <StagesView key={detail.id} detail={detail} selectedPath={stagePath} onSelect={onSelectStage} summaries={summaries} />}
          {view === 'params' && <ParamsView key={detail.id} detail={detail} onSelect={select} />}
        </div>
        {found && (
          <StageDrawer key={`${detail.id}:${stagePath}`} found={found} path={stagePath} detail={detail} rawAll={rawAll} onRawAll={onRawAll}
            onSelect={select} onClose={() => onNavigate({ stage: null })} />
        )}
      </div>
    </div>
    </FilesContext.Provider>
  );
});

function DetailSkeleton() {
  return (
    <div className="ss-detail" aria-hidden="true">
      <div className="ss-dhead ss-stack-10">
        <SkeletonLine w="120px" h={10} />
        <SkeletonLine w="45%" h={22} />
        <SkeletonLine w="32%" h={10} />
        <SkeletonLine w="100%" h={76} />
        <SkeletonLine w="260px" h={14} />
      </div>
      <div className="ss-area ss-center ss-sk-flow">
        {[0, 1, 2, 3].map(i => <SkeletonLine key={i} w="190px" h={70} />)}
      </div>
    </div>
  );
}

/* ---------------------------- extraction run ---------------------------- */

const STATE_LABEL = { queued: 'Waiting', running: 'Extracting…', done: 'Extracted', failed: 'Failed', cancelled: 'Cancelled' };

/** Ticks once a second on its own, so the rest of the panel doesn't re-render with it. */
function Elapsed({ since, until }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (until != null) return undefined;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [until]);
  return <>{until ?? Math.max(0, Math.round((Date.now() - since) / 1000))}s</>;
}


function RunDock({ run, log, onCancel, onClose, onDownload, onOpenPipeline, onRetry }) {
  const [min, setMin] = useState(false);
  const [showLog, setShowLog] = useState(true);
  const logRef = useRef(null);
  const stick = useRef(true);
  const counts = runCounts(run.pipelines);
  const running = run.status === 'running';
  const total = run.pipelines.length;
  const finished = counts.done + counts.failed + counts.cancelled;
  const pct = finished / Math.max(total, 1);
  const C = 2 * Math.PI * 18;
  const tone = running ? 'is-running' : run.status === 'done' && !counts.failed ? 'is-ok' : run.status === 'done' ? '' : 'is-bad';

  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log.length, showLog, min]);

  const headline = running
    ? `Extracting ${plural(total, 'pipeline', 'pipelines')}`
    : run.status === 'cancelled' ? 'Extraction cancelled'
      : run.status === 'done' ? (counts.failed ? `Extracted ${counts.done} of ${total}` : `Extracted ${plural(counts.done, 'pipeline', 'pipelines')}`)
        : 'Extraction failed';
  const sub = <>{running ? `${finished} of ${total} finished · ` : `${counts.done} extracted · ${counts.failed} failed · `}<Elapsed since={run.startedAt} until={run.seconds} /></>;
  const ring = (
    <div className={`ss-pring ${tone}`}>
      <svg viewBox="0 0 44 44"><circle className="ss-ring-bg" cx="22" cy="22" r="18" /><circle className="ss-ring-fg" cx="22" cy="22" r="18" strokeDasharray={C} strokeDashoffset={C * (1 - (running ? Math.max(0.04, pct) : 1))} /></svg>
      <b>{running ? `${Math.round(pct * 100)}%` : tone === 'is-ok' ? <Svg name="check" size={18} strokeWidth={2.4} /> : tone === 'is-bad' ? <Svg name="x" size={18} strokeWidth={2.4} /> : `${Math.round((counts.done / Math.max(total, 1)) * 100)}%`}</b>
    </div>
  );
  const shown = log.length > LOG_SHOWN ? log.slice(-LOG_SHOWN) : log;
  const lineTone = (l) => (l.includes('✅') ? 'is-ok' : l.includes('❌') ? 'is-bad' : l.includes('🔄') ? 'is-run' : '');

  if (min) {
    return (
      <button type="button" className="ss-dock is-min" onClick={() => setMin(false)} aria-label="Show the extraction">
        {ring}<span className="ss-dock-t"><b>{headline}</b><small>{sub}</small></span>
      </button>
    );
  }
  return (
    <>
    <section className="ss-dock" aria-label="Extraction" aria-live="polite">
      <div className="ss-dock-head">
        {ring}
        <div className="ss-dock-t"><b>{headline}</b><small>{sub}</small></div>
        <div className="ss-dock-acts">
          <button type="button" className={`ss-ibtn${showLog ? ' is-on' : ''}`} onClick={() => setShowLog(v => !v)} aria-pressed={showLog}
            title={showLog ? 'Hide the extractor log' : `Show the extractor log (${log.length} lines)`}><Svg name="terminal" /></button>
          {log.length > 0 && (
            <button type="button" className="ss-ibtn" title={`Copy the whole log (${log.length} lines)`} aria-label="Copy the whole log"
              onClick={() => navigator.clipboard?.writeText(log.join('\n')).catch(() => {})}><Svg name="copy" /></button>
          )}
          <button type="button" className="ss-ibtn" onClick={() => setMin(true)} title="Minimise" aria-label="Minimise"><Svg name="minimize" /></button>
          {running
            ? <button type="button" className="ss-btn ss-btn-sm" onClick={onCancel}>Cancel</button>
            : <IconButton name="close" label="Close extraction panel" onClick={onClose} />}
        </div>
      </div>
      {running && <div className="ss-dock-bar"><i style={{ width: `${Math.max(4, pct * 100)}%` }} /></div>}
      {run.error && <div className="ss-dock-err"><ErrorBox message={run.error} /></div>}
      <div className="ss-dock-body">
        <ul className="ss-runs">
          {run.pipelines.map(p => (
            <li key={p.id}>
              <span className={`ss-st is-${p.state}`}>{p.state === 'done' ? <Svg name="check" size={12} strokeWidth={2.6} /> : p.state === 'failed' ? <Svg name="x" size={12} strokeWidth={2.6} /> : null}</span>
              <div className="ss-grow">
                <button type="button" className="ss-run-nm" onClick={() => onOpenPipeline(p.id)} title={`Open ${p.name}`}>{p.name}</button>
                {p.error && <small className="ss-run-err">{p.error}</small>}
              </div>
              <span className={`ss-run-st is-${p.state}`}>{STATE_LABEL[p.state] || p.state}</span>
            </li>
          ))}
        </ul>
        {showLog && (
          <pre ref={logRef} className="ss-console" onScroll={e => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}>
            {log.length > LOG_SHOWN && <span className="is-dim">… {log.length - LOG_SHOWN} earlier lines hidden - Copy log has all of them{'\n'}</span>}
            {shown.length ? shown.map((l, i) => <span key={log.length - shown.length + i} className={lineTone(l)}>{l}{'\n'}</span>) : 'Waiting for output…'}
          </pre>
        )}
      </div>
      {!running && (
        <div className="ss-dock-foot">
          {run.report
            ? <><button type="button" className="ss-btn ss-btn-primary" onClick={onDownload}><Svg name="download" />Download report</button><small>{run.filename}</small></>
            : <small>Nothing was extracted - check the log for details.</small>}
          {counts.failed > 0 && (
            <button type="button" className="ss-btn ss-push" onClick={() => onRetry(run.pipelines.filter(p => p.state === 'failed').map(p => p.id))}>
              <Svg name="refresh" />Retry {counts.failed} failed
            </button>
          )}
        </div>
      )}
    </section>
    </>
  );
}

/* --------------------------- jump-to palette ---------------------------- */

function Palette({ pipelines, detail, onClose, onOpenPipeline, onSelectStage, actions }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const listRef = useRef(null);
  const deferred = useDeferredValue(q);
  const items = useMemo(() => {
    const needle = deferred.trim().toLowerCase();
    const out = actions.filter(a => !needle || a.title.toLowerCase().includes(needle));
    if (detail) {
      flattenStages(detail.stages)
        .filter(({ stage }) => !needle || stage.label.toLowerCase().includes(needle) || stageSubtitle(stage).toLowerCase().includes(needle))
        .slice(0, 6)
        .forEach(({ stage, path, parents }) => out.push({
          group: `Stages in ${detail.name}`, tech: stage.technology, title: stage.label,
          sub: `${kindOf(stage).label} · ${stageSubtitle(stage)}${parents.length ? ` · in ${parents.map(p => p.fragment.name).join(' › ')}` : ''}`,
          run: () => onSelectStage(path),
        }));
    }
    pipelines.filter(p => matchesPipeline(p, needle)).slice(0, 8).forEach(p => out.push({
      group: 'Pipelines', icon: 'flow', title: p.name,
      sub: [p.version && `v${p.version}`, relativeDay(p.last_modified), (p.labels || []).join(', ')].filter(Boolean).join(' · '),
      run: () => onOpenPipeline(p.id),
    }));
    return out;
  }, [deferred, actions, detail, pipelines, onOpenPipeline, onSelectStage]);
  const pick = Math.min(at, Math.max(0, items.length - 1));

  useEffect(() => { listRef.current?.querySelector('.is-on')?.scrollIntoView({ block: 'nearest' }); }, [pick]);

  const choose = (item) => { onClose(); item?.run(); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt(Math.min(items.length - 1, pick + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setAt(Math.max(0, pick - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); choose(items[pick]); }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  let group = null;
  return (
    <div className="ss-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ss-palette" role="dialog" aria-label="Jump to">
        <div className="ss-pal-in">
          <Svg name="search" size={18} />
          <input autoFocus value={q} onChange={e => { setQ(e.target.value); setAt(0); }} onKeyDown={onKey}
            placeholder="Jump to a pipeline, a stage, or an action…" aria-label="Jump to" />
          <kbd>Esc</kbd>
        </div>
        <div className="ss-pal-list" ref={listRef}>
          {items.length === 0 && <div className="ss-pal-g">Nothing matches</div>}
          {items.map((it, i) => {
            const head = it.group !== group ? (group = it.group) : null;
            return (
              <React.Fragment key={`${it.group}:${it.title}:${i}`}>
                {head && <div className="ss-pal-g">{head}</div>}
                <button type="button" className={`ss-pal-item${i === pick ? ' is-on' : ''}`} onMouseMove={() => i !== pick && setAt(i)} onClick={() => choose(it)}>
                  {it.tech ? <Tile tech={it.tech} small /> : <span className="ss-pal-ic"><Svg name={it.icon || 'bolt'} /></span>}
                  <span className="ss-grow"><b><Hl text={it.title} q={deferred} /></b><small>{it.sub}</small></span>
                </button>
              </React.Fragment>
            );
          })}
        </div>
        <div className="ss-pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
      </div>
    </div>
  );
}

/* ================================= pane ================================= */

export default function StreamsetsPane({ logInPage, active = true }) {
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
  const [label, setLabel] = useState(null);
  const [pickedOnly, setPickedOnly] = useState(false);
  const [selected, setSelected] = useState(() => new Set(readSelection()));
  const [shake, setShake] = useState(0);

  const [details, setDetails] = useState(() => new Map());   // id -> detail, kept while the page is open
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);      // { message, status }
  const [detailNonce, setDetailNonce] = useState(0);
  const forceRefresh = useRef(null);   // pipeline id whose next load should skip the server cache
  const [rawAll, setRawAll] = useState(false);

  const [run, setRun] = useState(null);
  const [runLog, setRunLog] = useState([]);
  const streamRef = useRef(null);
  const logBuffer = useRef([]);
  const logTimer = useRef(0);
  const listReq = useRef(0);
  const detailReq = useRef(0);

  const [palette, setPalette] = useState(false);
  const [toasts, setToasts] = useState([]);
  const searchRef = useRef(null);

  const track = useCallback((target, info) => {
    if (typeof logInPage === 'function') logInPage(target, info);
  }, [logInPage]);

  const toast = useCallback((message, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t.slice(-2), { id, message, tone }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2600);
  }, []);

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

  const openPipeline = useStable((id) => {
    if (id === pipelineId) return;
    navigate({ pipeline: id, stage: null });
    track('ss_open', `Opened StreamSets pipeline ${id}`);
  });

  const selectStage = useStable((path) => {
    navigate({ stage: path === stagePath ? null : path });
  });

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

  const refreshDetail = useStable(() => {
    forceRefresh.current = pipelineId;
    setDetailNonce(n => n + 1);
  });

  // A ?stage that doesn't exist in this pipeline (renamed, stale link) is dropped rather than shown as nothing.
  const found = useMemo(() => (detail ? findStage(detail.stages, stagePath) : null), [detail, stagePath]);
  useEffect(() => {
    if (detail && stagePath && !found) navigate({ stage: null }, { replace: true });
  }, [detail, stagePath, found, navigate]);

  /* ------------------------------ selection ------------------------------- */

  const maxPerRun = health?.max_per_run || 25;
  const listQuery = useDeferredValue(query);   // the box stays snappy; the list catches up when the CPU is free
  const labelCounts = useMemo(() => {
    const counts = new Map();
    pipelines.forEach(p => (p.labels || []).forEach(l => counts.set(l, (counts.get(l) || 0) + 1)));
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
  }, [pipelines]);
  const visible = useMemo(() => {
    const list = pipelines.filter(p => matchesPipeline(p, listQuery) && (!label || (p.labels || []).includes(label)) && (!pickedOnly || selected.has(p.id)));
    if (sort === 'modified') {
      list.sort((a, b) => String(b.last_modified || '').localeCompare(String(a.last_modified || '')));
    }
    return list;
  }, [pipelines, listQuery, label, pickedOnly, selected, sort]);
  const shown = useMemo(() => visible.slice(0, MAX_ROWS), [visible]);

  const bump = useCallback(() => {
    setShake(n => n + 1);
    toast(`${maxPerRun} is the most one run can take`, 'warn');
  }, [maxPerRun, toast]);
  useEffect(() => {
    if (!shake) return undefined;
    const t = setTimeout(() => setShake(0), 500);
    return () => clearTimeout(t);
  }, [shake]);

  const toggle = useStable((id) => {
    if (!selected.has(id) && selected.size >= maxPerRun) { bump(); return; }
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  });
  const allShownSelected = shown.length > 0 && shown.every(p => selected.has(p.id));
  const selectShown = () => {
    if (allShownSelected) {
      setSelected(prev => { const next = new Set(prev); shown.forEach(p => next.delete(p.id)); return next; });
      return;
    }
    const next = new Set(selected);
    let hitLimit = false;
    for (const p of shown) {
      if (next.has(p.id)) continue;
      if (next.size >= maxPerRun) { hitLimit = true; break; }
      next.add(p.id);
    }
    setSelected(next);
    if (hitLimit) bump();
  };
  useEffect(() => { if (!selected.size) setPickedOnly(false); }, [selected.size]);
  const nameOf = useCallback((id) => pipelines.find(p => p.id === id)?.name || details.get(id)?.name || id, [pipelines, details]);

  /* ------------------------------ extraction ------------------------------ */

  const running = run?.status === 'running';
  const runStates = useMemo(() => new Map((run?.pipelines || []).map(p => [p.id, p.state])), [run?.pipelines]);

  const flushLog = useCallback(() => {
    clearTimeout(logTimer.current);
    logTimer.current = 0;
    const lines = logBuffer.current;
    if (!lines.length) return;
    logBuffer.current = [];
    setRunLog(prev => {
      const next = prev.concat(lines);
      return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
    });
  }, []);

  const startExtraction = useStable((ids) => {
    if (!ids.length || running) return;
    if (!health?.extractor?.ready) return;
    streamRef.current?.close();
    clearTimeout(logTimer.current);
    logTimer.current = 0;
    logBuffer.current = [];
    setRunLog([]);
    const startedAt = Date.now();
    setRun({
      status: 'running', error: null, report: null, filename: null, seconds: null, startedAt,
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
        if (streamRef.current !== es) return;
        logBuffer.current.push(evt.message);
        if (!logTimer.current) logTimer.current = setTimeout(flushLog, LOG_FLUSH_MS);
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
        flushLog();
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
      flushLog();
      patch(r => ({
        ...r,
        status: 'failed',
        seconds: Math.round((Date.now() - startedAt) / 1000),
        error: err?.status ? streamErrorMessage(err.status) : `Lost the connection to the server: ${err?.message || 'network error'}`,
        pipelines: r.pipelines.map(p => (p.state === 'done' ? p : { ...p, state: 'failed' })),
      }));
    };
    es.onend = () => {
      if (finished) return;
      finished = true;
      flushLog();
      patch(r => ({
        ...r,
        status: 'failed',
        seconds: Math.round((Date.now() - startedAt) / 1000),
        error: r.error || 'The connection closed before the extraction finished.',
        pipelines: r.pipelines.map(p => (p.state === 'done' ? p : { ...p, state: 'failed' })),
      }));
    };
  });

  const cancelRun = useStable(() => {
    const es = streamRef.current;
    if (!es) return;
    streamRef.current = null;   // late events from the closed stream are ignored
    es.close();                 // the server stops the extractor when the stream drops
    logBuffer.current.push('Cancelled - the server stops the extractor when the stream closes');
    flushLog();
    setRun(r => (r ? {
      ...r, status: 'cancelled', seconds: Math.round((Date.now() - r.startedAt) / 1000),
      pipelines: r.pipelines.map(p => (p.state === 'done' || p.state === 'failed' ? p : { ...p, state: 'cancelled' })),
    } : r));
    track('ss_extract_cancel', 'Cancelled a StreamSets extraction');
    toast('Extraction cancelled', 'warn');
  });

  const downloadReport = useStable(() => {
    if (!run?.report) return;
    const blob = new Blob([JSON.stringify(run.report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: run.filename || 'streamsets_report.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    track('ss_download', `Downloaded StreamSets report ${run.filename}`);
    toast(`Downloaded ${run.filename}`);
  });

  const closeRun = useStable(() => { setRun(null); setRunLog([]); });
  const copyId = useStable(() => {
    navigator.clipboard?.writeText(pipelineId).then(() => toast('Pipeline ID copied'), () => toast("Couldn't reach the clipboard", 'warn'));
  });

  // Leaving the page mid-run would silently drop it - ask first, and close the stream when the pane goes away.
  useEffect(() => {
    if (!running) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);
  useEffect(() => () => { streamRef.current?.close(); clearTimeout(logTimer.current); }, []);

  /* ------------------------------- keyboard ------------------------------- */

  // This pane stays mounted behind the other Data Studio tabs - its shortcuts only work while it's on screen.
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(p => !p); return; }
      if (palette) { if (e.key === 'Escape') setPalette(false); return; }   // the palette handles the rest itself
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'Escape' && stagePath && !typing) navigate({ stage: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, palette, stagePath, navigate]);

  const paletteActions = useMemo(() => (selected.size && health?.extractor?.ready && !running
    ? [{ group: 'Actions', icon: 'bolt', title: `Extract ${plural(selected.size, 'picked pipeline', 'picked pipelines')}`, sub: 'Starts the extractor', run: () => startExtraction([...selected]) }]
    : []), [selected, health, running, startExtraction]);
  const focusSearch = useStable(() => searchRef.current?.focus());
  const paletteStage = useStable((path) => {
    if (view === 'params') navigate({ ssview: null, stage: path });
    else navigate({ stage: path });
  });

  /* -------------------------------- render -------------------------------- */

  if (phase === 'unconfigured' || phase === 'error') {
    const unconf = phase === 'unconfigured';
    return (
      <div className="ss-root">
        <style href="ss-pane" precedence="default">{PANE_CSS}</style>
        <div className="ss-state">
          <div className="ss-state-card">
            <div className={`ss-state-ic${unconf ? ' is-frag' : ' is-bad'}`}><Svg name={unconf ? 'plug' : 'cloudoff'} size={32} /></div>
            <h2>{unconf ? 'StreamSets Extractor isn’t switched on yet' : 'Can’t reach the StreamSets Extractor'}</h2>
            <p>
              {unconf
                ? <>Add a <code>streamsets_extractor</code> section to the backend config (dq_config.json) and restart - the page lights up on its own.</>
                : fatal}
            </p>
            {!unconf && <button type="button" className="ss-btn ss-btn-dark" onClick={() => setBootNonce(n => n + 1)}><Svg name="refresh" />Try again</button>}
          </div>
        </div>
      </div>
    );
  }

  const extractorReady = !!health?.extractor?.ready;
  const reason = health?.extractor?.reason || 'The extractor is not available on the server.';
  const liveHere = !!detail && running && run.pipelines.some(p => p.id === detail.id && (p.state === 'running' || p.state === 'queued'));
  const busy = listLoading || detailLoading;
  const notFound = detailError?.status === 404;
  const booting = phase === 'booting' || (listLoading && !pipelines.length);
  const full = selected.size >= maxPerRun;

  return (
    <div className="ss-root">
      <style href="ss-pane" precedence="default">{PANE_CSS}</style>
      {busy && <div className="ss-busy" aria-hidden="true" />}

      <div className="ss-bar">
        <div className="ss-brand">
          <div className="ss-brand-mark"><Svg name="flow" size={18} strokeWidth={2} /></div>
          <div><b>StreamSets Extractor</b><small>See how a pipeline moves data, then export its definition</small></div>
        </div>
        <div className="ss-pills">
          {health?.server && <span className="ss-pill" title="StreamSets Control Hub this page reads from"><span className="ss-dot" />Connected · {health.server}</span>}
          {health && (
            <span className="ss-pill" title={extractorReady ? 'The extractor script is installed on the server' : reason}>
              <span className={`ss-dot${extractorReady ? '' : ' is-warn'}`} />{extractorReady ? `Extractor ready · up to ${maxPerRun} per run` : 'Extractor unavailable'}
            </span>
          )}
        </div>
        <button type="button" className="ss-jump" onClick={() => setPalette(true)}>
          <Svg name="search" /><span>Jump to a pipeline or stage…</span><kbd>Ctrl</kbd><kbd>K</kbd>
        </button>
      </div>

      <div className="ss-body">
        {/* ------------------------------ pipelines ------------------------------ */}
        <aside className="ss-rail" aria-label="Pipelines">
          <div className="ss-rail-head">
            <div className="ss-rail-title">
              <h2>Pipelines</h2>
              <span className="ss-count">{booting ? '…' : visible.length === pipelines.length ? pipelines.length : `${visible.length} / ${pipelines.length}`}</span>
              <span className="ss-fetched">{fetchedAt ? `synced ${formatWhen(fetchedAt)}` : ''}</span>
              <IconButton name="refresh" onClick={() => loadList(true)} disabled={listLoading} spinning={listLoading} label="Reload the list from StreamSets" />
            </div>
            <div className="ss-search">
              <Svg name="search" />
              <input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, ID, label or author" aria-label="Search pipelines"
                onKeyDown={e => {
                  if (e.key === 'Enter' && visible[0]) openPipeline(visible[0].id);
                  if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); }
                }} />
              {query
                ? <button type="button" className="ss-search-clear" onClick={() => { setQuery(''); searchRef.current?.focus(); }} aria-label="Clear search"><Svg name="x" size={13} /></button>
                : <kbd className="ss-search-kbd">/</kbd>}
            </div>
            {labelCounts.length > 0 && (
              <div className="ss-chips">
                <button type="button" className={`ss-chip${!label && !pickedOnly ? ' is-on' : ''}`} onClick={() => { setLabel(null); setPickedOnly(false); }}>All <em>{pipelines.length}</em></button>
                {selected.size > 0 && <button type="button" className={`ss-chip${pickedOnly ? ' is-on' : ''}`} onClick={() => { setPickedOnly(v => !v); setLabel(null); }}>✓ Picked <em>{selected.size}</em></button>}
                {labelCounts.map(([l, n]) => (
                  <button key={l} type="button" className={`ss-chip${label === l ? ' is-on' : ''}`} onClick={() => { setLabel(label === l ? null : l); setPickedOnly(false); }}>{l} <em>{n}</em></button>
                ))}
              </div>
            )}
            <div className="ss-listbar">
              <button type="button" className="ss-link" onClick={selectShown} disabled={!shown.length}>
                {allShownSelected ? 'Unpick these' : visible.length === pipelines.length ? 'Pick all' : 'Pick all shown'}
              </button>
              <span className="ss-seg" role="group" aria-label="Sort">
                <button type="button" className={sort === 'name' ? 'is-on' : ''} onClick={() => setSort('name')}>A–Z</button>
                <button type="button" className={sort === 'modified' ? 'is-on' : ''} onClick={() => setSort('modified')}>Recently changed</button>
              </span>
            </div>
          </div>

          <div className="ss-list" aria-busy={listLoading}>
            {booting && <ListSkeleton />}
            {listError && <div className="ss-pad-s"><ErrorBox message={listError} onRetry={() => loadList(true)} /></div>}
            {phase === 'ready' && !listLoading && !listError && pipelines.length === 0 && (
              <div className="ss-empty">The StreamSets service account can&apos;t see any pipelines.</div>
            )}
            {pipelines.length > 0 && visible.length === 0 && (
              <div className="ss-empty">
                <b>No pipeline matches “{query || label || 'your filter'}”</b>
                <div>Try a table name, a label, or someone who changed it.</div>
                <button type="button" className="ss-btn" onClick={() => { setQuery(''); setLabel(null); setPickedOnly(false); }}>Clear filters</button>
              </div>
            )}
            {!booting && (
              <PipelineList rows={shown} query={listQuery} openId={pipelineId} picked={selected} full={full} maxPerRun={maxPerRun}
                runStates={runStates} onPick={toggle} onOpen={openPipeline} />
            )}
            {visible.length > MAX_ROWS && <div className="ss-empty">Showing the first {MAX_ROWS} of {visible.length}. Search to narrow it down.</div>}
          </div>

          <Tray picked={selected} maxPerRun={maxPerRun} nameOf={nameOf} running={running} extractorReady={extractorReady} reason={reason} shake={shake > 0}
            onUnpick={toggle} onClear={() => { setSelected(new Set()); toast('Cleared your picks'); }} onExtract={() => startExtraction([...selected])} />
        </aside>

        {/* ------------------------------- detail -------------------------------- */}
        <main className="ss-main">
          {!pipelineId && (
            <Hero pipelines={pipelines} loading={booting} server={health?.server} maxPerRun={maxPerRun}
              onOpen={openPipeline} onFocusSearch={focusSearch} />
          )}
          {pipelineId && !detail && !detailError && <DetailSkeleton />}
          {pipelineId && !detail && detailError && (
            <div className="ss-pad">
              <ErrorBox message={detailError.message} onRetry={notFound ? null : refreshDetail} />
              {notFound && <button type="button" className="ss-link ss-mt" onClick={() => navigate({ pipeline: null, stage: null })}>Back to the overview</button>}
            </div>
          )}
          {detail && (
            <DetailView detail={detail} view={view} stagePath={stagePath} found={found} live={liveHere}
              picked={selected.has(detail.id)} canPick={!full} running={running} extractorReady={extractorReady} reason={reason}
              detailLoading={detailLoading} detailError={detailError} rawAll={rawAll} onRawAll={setRawAll} filesAvailable={health?.resources !== false}
              onNavigate={navigate} onSelectStage={selectStage} onToggle={toggle} onExtract={startExtraction} onRefresh={refreshDetail} onCopyId={copyId} />
          )}
        </main>
      </div>

      {run && (
        <RunDock run={run} log={runLog} onCancel={cancelRun} onClose={closeRun} onDownload={downloadReport}
          onOpenPipeline={openPipeline} onRetry={startExtraction} />
      )}

      {palette && (
        <Palette pipelines={pipelines} detail={detail} actions={paletteActions} onClose={() => setPalette(false)}
          onOpenPipeline={openPipeline} onSelectStage={paletteStage} />
      )}

      <div className="ss-toasts" role="status">
        {toasts.map(t => <div key={t.id} className={`ss-toast is-${t.tone}`}><Svg name={t.tone === 'ok' ? 'check' : 'alert'} />{t.message}</div>)}
      </div>
    </div>
  );
}