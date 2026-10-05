import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { apiEventSource, apiFetch, apiJson, downloadFile } from '../utils/apiClient';
import './ITChecks.css';

// Icon sprite. Paths are the J&J icon set (same art as /public/icons) inlined so they
// can take currentColor. Rendered once at the top of the page.
const SPRITE = `
<symbol id="itc-shield" viewBox="0 0 32 32"><path d="M13.89 16.92c-1.02-.57-2.35-1.09-4.05-1.37-.12.28-.1.24-.22.52 1.73 1.36 2.98 2.99 3.83 5.21h1.9c1.78-4.91 4.87-7.93 7.05-10.08l-.3-.49c-4.5 1.67-6.72 4.37-8.21 6.21M16.62 2h-1.24C14 4.74 9.12 7 4.59 7v9.07C4.59 19.3 6 22 8.74 24.24L15.38 30h1.24l6.64-5.76C26 22 27.41 19.3 27.41 16.07V7C22.88 7 18 4.74 16.62 2m8.82 14.07c0 2.59-1.12 4.76-3.42 6.64L16 27.93l-6.02-5.22c-2.3-1.88-3.42-4.05-3.42-6.64v-5.16c0-1.15.79-2.16 1.97-2.42 4.02-.87 6.6-2.95 7.47-3.98.86 1.03 3.45 3.11 7.47 3.98 1.18.25 1.97 1.26 1.97 2.42z" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-refresh" viewBox="0 0 16 16"><path d="M11.751 9.32a3.988 3.988 0 1 1-.824-3.99l-2.122-.102-.156.883 3.927.692.69-3.918-.881-.164-.633 2.038a4.97 4.97 0 0 0-3.768-1.726C5.236 3.033 3 5.268 3 8.017S5.236 13 7.984 13a4.99 4.99 0 0 0 4.703-3.339z" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-play" viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none"/></symbol>
<symbol id="itc-clock" viewBox="0 0 32 32"><path d="M17,7h-2V5h2V7z M17,25h-2v2h2V25z M27,17v-2h-2v2H27z M7,17v-2H5v2H7z M17.98,15.96l3.59-4.44l-1.06-1.06l-5.54,4.48v2.11 l0.01-0.01l-0.01,0.01l7.6,6.54l1.06-1.06L17.98,15.96z M30,16c0,7.72-6.28,14-14,14C8.28,30,2,23.72,2,16C2,8.28,8.28,2,16,2 C23.72,2,30,8.28,30,16z M28,16C28,9.38,22.62,4,16,4C9.38,4,4,9.38,4,16C4,22.62,9.38,28,16,28C22.62,28,28,22.62,28,16z" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-down" viewBox="0 0 32 32"><path d="M16.3689 24.3333L30.3335 9.66668L28.5613 7.66669L16.3335 18.625L4.1766 7.74083L2.3335 9.66668L16.3689 24.3333Z" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-right" viewBox="0 0 32 32"><path d="M24.6666 15.9646L9.99999 2L8 3.77215L18.9583 16L8.07415 28.1569L9.99999 30L24.6666 15.9646Z" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-left" viewBox="0 0 32 32"><path d="M8 15.965L22.666 2l2 1.772L13.708 16l10.884 12.157L22.667 30 8 15.965z" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-x" viewBox="0 0 32 32"><path d="M18.372 15.987l8.654-8.643-2.372-2.37L16 13.619 7.347 4.975 4.975 7.344l8.654 8.643-8.654 8.644L7.347 27 16 18.356 24.654 27l2.372-2.369-8.654-8.644z" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-search" viewBox="0 0 32 32"><path d="M20.08 3.17c-1.61 0-3.18.44-4.55 1.28a8.784 8.784 0 0 0-3.22 3.46 8.746 8.746 0 0 0-.94 4.63c.12 1.6.68 3.14 1.61 4.44.28.41.28.76-.09 1.03-1.89 1.35-3.28.12-5.31 2.15l-4.4 4.42 4.24 4.24 4.44-4.45c2.04-2.04.76-3.39 2.1-5.29.28-.36.62-.38 1.03-.09 1.12.8 2.41 1.32 3.77 1.53 1.36.21 2.75.09 4.05-.34a8.766 8.766 0 0 0 3.46-2.14c.97-.98 1.69-2.17 2.11-3.48.42-1.31.53-2.7.31-4.06a8.792 8.792 0 0 0-1.56-3.76 8.684 8.684 0 0 0-3.1-2.64 8.786 8.786 0 0 0-3.96-.95l.01.02zm0 15.49a6.764 6.764 0 0 1-6.25-4.17 6.675 6.675 0 0 1-.38-3.9c.26-1.31.9-2.51 1.85-3.46.95-.94 2.15-1.59 3.46-1.85a6.72 6.72 0 0 1 3.91.39 6.764 6.764 0 0 1 4.17 6.24c0 1.79-.71 3.51-1.98 4.77a6.802 6.802 0 0 1-4.78 1.98z" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-filter" viewBox="0 0 32 32"><path d="M22.4 8.6a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0m1.499.8a3.201 3.201 0 0 1-6.198 0H4.8V7.8h12.9a3.201 3.201 0 0 1 6.199 0h3.3v1.6zM5.599 15h-.8v1.6h3.302a3.201 3.201 0 0 0 6.198 0h12.9V15H14.3a3.201 3.201 0 0 0-6.198 0zm0 7.2h-.8v1.6h12.903a3.201 3.201 0 0 0 6.198 0h3.3v-1.6h-3.3a3.201 3.201 0 0 0-6.198 0zm15.2 2.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2m-8-8.8a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-check" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></symbol>
<symbol id="itc-checkc" viewBox="0 0 16 16"><path d="M5.997,10.29l-2.695-2.43-.71.704,3.404,3.583,7.412-7.589-.705-.705-6.706,6.436Z" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-xc" viewBox="0 0 16 16"><path d="M13.833,2.167v11.667H2.167V2.167h11.667M15,1H1v14h14V1h0Z" fill="currentColor" stroke="none" fill-rule="evenodd"/><polygon points="11.301 10.476 8.825 8 11.301 5.524 10.476 4.699 8 7.175 5.524 4.699 4.699 5.524 7.175 8 4.699 10.476 5.524 11.301 8 8.825 10.476 11.301 11.301 10.476" fill="currentColor" stroke="none"/></symbol>
<symbol id="itc-alert" viewBox="0 0 32 32"><path d="M16.01,21.32c-1.01,0-1.82,0.82-1.82,1.82s0.82,1.82,1.82,1.82s1.82-0.82,1.82-1.82S17.02,21.32,16.01,21.32z M15,20h2 c0-4.06,0.99-8,0.99-8h-3.98C14.01,12,15,15.94,15,20z M17.01,3H16h-1.01L2,27.54L2.88,29H16h13.13L30,27.54L17.01,3z M16,27H4.55 L16,5.39L27.45,27H16z" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-grid" viewBox="0 0 16 16"><path d="M1,2v12h14V2H1ZM2,13V3h3v10h-3ZM6,13v-5h4v5h-4ZM11,13v-5h3v5h-3ZM14,7H6V3h8v4Z" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-bug" viewBox="0 0 24 24"><path d="M2 12C2 6.479 6.479 2 12 2s10 4.479 10 10-4.479 10-10 10S2 17.521 2 12m1.429 0c0 4.729 3.842 8.571 8.571 8.571s8.571-3.85 8.571-8.571S16.73 3.429 12 3.429 3.429 7.27 3.429 12m7.819 1h1.5c0-3.045.742-6 .742-6h-2.985s.742 2.955.742 6m.757.99a1.365 1.365 0 1 0 0 2.73 1.365 1.365 0 0 0 0-2.73" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-ghost" viewBox="0 0 32 32"><path d="M28.98,17c-0.01,6.91-5.86,12.74-12.87,12.74c-7.26,0-13.25-5.94-13.08-13.22l0-0.01c0-6.06,4.41-11.57,11.19-12.68V2.26 l3.76,3.76l-3.76,3.76V8.12c-3.6,0.21-8.8,5.23-7.6,11.23c0.77,3.87,5.9,9.38,12.79,7.58c4.32-1.35,7.25-5.54,7.33-9.94H28.98z M28.55,15.25c-0.11-0.68-0.28-1.36-0.5-2.02l-2.03,0.68c0.18,0.55,0.32,1.11,0.41,1.68L28.55,15.25z M27.28,11.41 c-0.32-0.62-0.69-1.21-1.11-1.76l-1.71,1.28c0.34,0.46,0.65,0.95,0.92,1.47L27.28,11.41z M24.86,8.16c-0.5-0.48-1.04-0.93-1.61-1.32 l-1.22,1.76c0.47,0.33,0.92,0.7,1.34,1.1L24.86,8.16z M21.54,5.84c-0.62-0.3-1.28-0.55-1.94-0.75L19,7.14 c0.55,0.16,1.1,0.37,1.62,0.62L21.54,5.84z M17.12,16.31l-0.6-4.84h-1.75l-0.87,7.08h0.01l1.06,1.06l10-0.87v-1.74L17.12,16.31z" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
<symbol id="itc-swap" viewBox="0 0 24 24"><path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/></symbol>
<symbol id="itc-rows" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></symbol>
<symbol id="itc-rows2" viewBox="0 0 24 24"><path d="M4 5h16M4 9h16M4 13h16M4 17h16M4 21h16"/></symbol>
<symbol id="itc-download" viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></symbol>
<symbol id="itc-min" viewBox="0 0 24 24"><path d="M5 12h14"/></symbol>
<symbol id="itc-stop" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/></symbol>
<symbol id="itc-expand" viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></symbol>
<symbol id="itc-shrink" viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></symbol>
<symbol id="itc-db" viewBox="0 0 32 32"><path d="M2,2v6.51c0,1.09,0.89,1.98,1.98,1.98h24.03c1.1,0,1.98-0.89,1.98-1.98V2H2z M5,6.99c-0.55,0-1-0.45-1-1 c0-0.55,0.45-1,1-1s1,0.45,1,1C6,6.54,5.55,6.99,5,6.99z M8,6.99c-0.55,0-1-0.45-1-1c0-0.55,0.45-1,1-1s1,0.45,1,1 C9,6.54,8.55,6.99,8,6.99z M11,6.99c-0.55,0-1-0.45-1-1c0-0.55,0.45-1,1-1s1,0.45,1,1C12,6.54,11.55,6.99,11,6.99z M28,6.99H16v-2 h12V6.99z M2,18.26c0,1.1,0.89,1.98,1.98,1.98h24.03c1.1,0,1.98-0.89,1.98-1.98v-6.51H2V18.26z M16,14.74h12v2H16V14.74z M11,14.74 c0.55,0,1,0.45,1,1s-0.45,1-1,1s-1-0.45-1-1S10.45,14.74,11,14.74z M8,14.74c0.55,0,1,0.45,1,1s-0.45,1-1,1s-1-0.45-1-1 S7.45,14.74,8,14.74z M5,14.74c0.55,0,1,0.45,1,1s-0.45,1-1,1s-1-0.45-1-1S4.45,14.74,5,14.74z M2,28.02C2,29.11,2.89,30,3.98,30 h24.03c1.1,0,1.98-0.89,1.98-1.98v-6.51H2V28.02z M16,24.5h12v2H16V24.5z M11,24.5c0.55,0,1,0.45,1,1c0,0.55-0.45,1-1,1s-1-0.45-1-1 C10,24.95,10.45,24.5,11,24.5z M8,24.5c0.55,0,1,0.45,1,1c0,0.55-0.45,1-1,1s-1-0.45-1-1C7,24.95,7.45,24.5,8,24.5z M5,24.5 c0.55,0,1,0.45,1,1c0,0.55-0.45,1-1,1s-1-0.45-1-1C4,24.95,4.45,24.5,5,24.5z" fill="currentColor" stroke="none" fill-rule="evenodd"/></symbol>
<symbol id="itc-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></symbol>
<symbol id="itc-sf" viewBox="0 0 64 64"><path fill="#29b5e8" stroke="none" d="M 61.063 28.296 L 53.74 32.44 L 61.064 36.583 C 62.927 37.63 63.547005 39.946 62.479 41.749 C 61.412 43.553005 59.053 44.161995 57.191006 43.139 L 44.055996 35.729 C 43.216393 35.26535 42.585705 34.498367 42.293 33.585 C 42.169 33.171 42.094 32.756 42.119 32.366 C 42.119 32.074 42.169 31.781 42.243 31.465 C 42.516 30.538 43.113003 29.709997 44.031 29.198 L 57.165997 21.789 C 59.003 20.741 61.387 21.375 62.455006 23.179 C 63.523 24.983 62.902 27.297 61.039 28.345 Z M 54.111 48.378 L 40.976 40.97 C 40.297543 40.584988 39.518135 40.415157 38.741 40.483 C 36.731 40.629 35.166 42.262 35.166 44.236 L 35.166 59.054005 C 35.166 61.15 36.879 62.831 39.039 62.831 C 41.199 62.831 42.913 61.15 42.913 59.054005 L 42.913 50.768 L 50.263 54.911003 C 52.1 55.959 54.483 55.349 55.550995 53.545998 C 56.619 51.741997 55.998005 49.427002 54.136 48.379 Z M 38.965 33.902 L 33.502 39.239 C 33.353 39.385 33.055 39.531 32.807 39.531 L 31.193 39.531 C 30.97 39.531 30.672 39.41 30.498 39.239 L 25.035 33.902 C 24.873531 33.71902 24.777493 33.487545 24.762 33.244 L 24.762 31.684002 C 24.762 31.464 24.886002 31.172 25.035 31.002003 L 30.498 25.664 C 30.647 25.518002 30.97 25.395998 31.193 25.395998 L 32.807 25.395998 C 33.03 25.395998 33.328 25.518002 33.502 25.664 L 38.965 31.002003 C 39.114 31.148 39.238 31.465 39.238 31.684002 L 39.238 33.244 C 39.238 33.464 39.114 33.755 38.965 33.902 M 34.595 32.415 C 34.595 32.195 34.471 31.903 34.297 31.733 L 32.707 30.197 C 32.559 30.051 32.236 29.929 32.012 29.929 L 31.938 29.929 C 31.715 29.929 31.417002 30.051 31.268 30.197 L 29.678001 31.733 C 29.529 31.903 29.404999 32.196 29.404999 32.415 L 29.404999 32.464 C 29.404999 32.684 29.529 32.976 29.678001 33.122 L 31.268 34.657 C 31.416 34.804 31.739 34.925 31.938 34.925 L 32.012 34.925 C 32.236 34.925 32.534 34.804 32.708 34.657 L 34.297 33.122 C 34.446 32.976 34.595 32.659 34.595 32.464 Z M 9.889 16.476 L 23.024 23.886002 C 23.719 24.276 24.514 24.445997 25.259 24.373 C 27.269 24.226 28.834 22.593 28.834 20.595 L 28.834 5.778 C 28.834 3.706 27.096 2 24.961 2 C 22.826 2 21.087 3.682 21.087 5.778 L 21.087 14.064 L 13.737001 9.921 C 11.9 8.873 9.542 9.506 8.45 11.31 C 7.382 13.113 8.003 15.428 9.865 16.476 Z M 38.741 24.397 C 39.51732 24.4528 40.293274 24.28372 40.976 23.91 L 54.111 16.5 C 55.972996 15.453 56.594 13.138 55.526 11.334 C 54.458 9.531 52.1 8.921 50.238 9.945 L 42.888 14.088 L 42.888 5.802 C 42.888 3.73 41.15 2.024 39.014 2.024 C 36.879 2.024 35.141 3.706 35.141 5.802 L 35.141 20.619 C 35.141 22.618 36.705 24.251 38.717 24.397 Z M 25.284 40.482 C 24.506866 40.414158 23.727457 40.58399 23.049002 40.969 L 9.914 48.38 C 8.077 49.427002 7.431 51.741997 8.499 53.545998 C 9.566 55.349 11.924999 55.959 13.787001 54.911003 L 21.137 50.768 L 21.137 59.054005 C 21.137 61.15 22.875 62.831 25.01 62.831 C 27.145 62.831 28.884 61.15 28.884 59.054005 L 28.884 44.235004 C 28.884 42.237 27.294 40.604 25.308 40.482 Z M 21.708002 33.56 C 21.832 33.146 21.882 32.732 21.882 32.342 C 21.882 32.05 21.832 31.757 21.732 31.44 C 21.467594 30.473928 20.82282 29.656324 19.945 29.174 L 6.81 21.763998 C 4.948 20.717 2.59 21.351 1.521 23.154 C 0.454 24.958 1.075 27.273 2.937 28.321 L 10.262 32.464 L 2.937 36.607 C 1.075 37.655 0.454 39.97 1.52 41.774 C 2.586 43.578 4.947 44.186 6.81 43.163 L 19.944 35.753 C 20.789692 35.296703 21.422684 34.526917 21.707 33.609 Z"/></symbol>`;

const Ico = ({ n, className = '', style }) => (
  <svg className={`i ${className}`} style={style} aria-hidden="true"><use href={`#itc-${n}`} /></svg>
);
const Tick = ({ on, onClick, label }) => (
  <span className={`check${on ? ' on' : ''}`} onClick={onClick} role="checkbox" aria-checked={!!on} aria-label={label}
    tabIndex={onClick ? 0 : undefined}
    onKeyDown={onClick ? (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onClick(e); } } : undefined}>
    <svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10" /></svg>
  </span>
);

// ─── status bits ─────────────────────────────────────────────────────────────
const LABEL = {
  PASSED: 'Passed', CRITICAL: 'Critical', FAULTY: 'Faulty', ERROR: 'Error', TIMEOUT: 'Timeout',
  TABLE_NOT_FOUND: 'Not found', RUNNING: 'Validating', MATCH: 'Match', MISMATCH: 'Mismatch',
  DEFINITION_MISMATCH: 'Definition mismatch', NONE: 'None',
  PASS: 'Pass', FAIL: 'Fail', VALIDATION_FAILED: 'Nulls found', UNKNOWN: 'Not checked',
};
const SEVERITY = { CRITICAL: 0, ERROR: 1, FAULTY: 2, TABLE_NOT_FOUND: 3, TIMEOUT: 4, PASSED: 5 };
const tileOf = (s) => (s === 'TIMEOUT' || s === 'TABLE_NOT_FOUND' ? 'MISSING' : s);
const TILES = [
  { k: 'ALL', name: 'All tables', ic: 'grid' },
  { k: 'PASSED', name: 'Passed', ic: 'checkc' },
  { k: 'CRITICAL', name: 'Critical', ic: 'xc' },
  { k: 'FAULTY', name: 'Faulty', ic: 'alert' },
  { k: 'ERROR', name: 'Errors', ic: 'bug' },
  { k: 'MISSING', name: 'Not found / timeout', ic: 'ghost' },
];
const TILE_NAME = Object.fromEntries(TILES.map((t) => [t.k, t.name]));
const COLOR = { PASSED: 'var(--green)', CRITICAL: 'var(--red)', FAULTY: 'var(--orange)', ERROR: 'var(--violet)', MISSING: 'var(--yellow)' };
const CELL = { PASSED: 'var(--green-light)', CRITICAL: 'var(--red)', FAULTY: 'var(--orange)', ERROR: 'var(--violet)', TIMEOUT: 'var(--yellow)', TABLE_NOT_FOUND: 'var(--yellow)' };
const SPECTRUM = ['PASSED', 'FAULTY', 'MISSING', 'ERROR', 'CRITICAL'];
const Status = ({ s }) => <span className={`status ${s}`}><i />{LABEL[s] || s || 'Unknown'}</span>;

// the two sources the run endpoint knows about
const RUN_DBS = [
  { id: 'insight7', label: 'Insight7' },
  { id: 'rimdocs', label: 'RIMDocs' },
];

// ─── small helpers ───────────────────────────────────────────────────────────
const fmt = (n) => (Number(n) || 0).toLocaleString('en-US');
// 52,170,083 → "52.17M"; <Num> cross-fades to the exact figure on hover
const SHORT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const compact = (n) => SHORT.format(Number(n) || 0);
const Num = ({ v }) => {
  const s = compact(v), e = fmt(v);
  if (s === e) return <span>{e}</span>; // small numbers: nothing to swap
  return <span className="num-x"><span className="s" aria-hidden="true">{s}</span><span className="e">{e}</span></span>;
};
function toTime(s) {
  if (!s) return 0;
  const str = /^\d{4}-\d\d-\d\d \d/.test(s) ? s.replace(' ', 'T') : s;
  const t = Date.parse(str);
  return Number.isNaN(t) ? 0 : t;
}
function ago(ts) {
  if (!ts) return '—';
  const m = Math.round((Date.now() - ts) / 60e3);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
const stamp = (ts) => (ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const shortDate = (s) => (s ? new Date(toTime(s)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const uniq = (a) => [...new Set(a.filter(Boolean))].sort();

function sourceOf(raw) {
  const s = (raw || '').toLowerCase();
  if (s.includes('rim')) return 'RIMDocs';
  if (s.includes('insight')) return 'Insight7';
  return raw || 'Oracle';
}
const abbr = (src) => (src === 'Insight7' ? 'I7' : src === 'RIMDocs' ? 'RD' : src.slice(0, 2).toUpperCase());

function colStats(c) {
  return {
    od: c.oracle_stats?.distinct_count ?? c.oracle_distinct_count ?? 0,
    sd: c.snowflake_stats?.distinct_count ?? c.snowflake_distinct_count ?? 0,
    on: c.oracle_stats?.null_count ?? c.oracle_null_count ?? 0,
    sn: c.snowflake_stats?.null_count ?? c.snowflake_null_count ?? 0,
  };
}

// Strip Snowflake error codes / uuids so toast text stays readable
function cleanIssue(s = '') {
  const c = s
    .replace(/\d{6}\s*\(\w+\):\s*/g, '')
    .replace(/[a-f0-9]{8}-[a-f0-9-]{27}:\s*/gi, '')
    .replace(/^validation error:\s*/i, '')
    .trim();
  return c.length > 90 ? c.slice(0, 90).trimEnd() + '…' : c;
}

// ERROR / TIMEOUT / FAULTY / NOT FOUND rows carry their reason in `error`, not validation_issues
const issuesOf = (t) => (t.validation_issues?.length ? t.validation_issues : t.error ? [t.error] : []);

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`; // stop Excel running it as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ─── filters ─────────────────────────────────────────────────────────────────
const EMPTY_F = { srcSchema: [], srcTable: [], srcCol: [], tgtDb: [], tgtSchema: [], tgtTable: [], tgtCol: [] };
const F_ORDER = Object.keys(EMPTY_F);
const F_DEFS = {
  srcSchema: { label: 'Schema' },
  srcTable: { label: 'Table', needs: 'srcSchema' },
  srcCol: { label: 'Columns', needs: 'srcTable' },
  tgtDb: { label: 'Database' },
  tgtSchema: { label: 'Schema', needs: 'tgtDb' },
  tgtTable: { label: 'Table', needs: 'tgtSchema' },
  tgtCol: { label: 'Columns', needs: 'tgtTable' },
};
const colNames = (list) => uniq(list.flatMap((t) => (t.column_statistics || []).map((c) => c.column_name)));

// Options for one dropdown, given the rest of the filter state. Each level only
// offers values that exist under the parent selection (same cascade as before).
function optionsFor(key, f, tables, db) {
  const inDb = db === 'all' ? tables : tables.filter((t) => t._src === db);
  const bySrc = inDb.filter((t) =>
    (!f.srcSchema.length || f.srcSchema.includes(t.source_schema)) &&
    (!f.srcTable.length || f.srcTable.includes(t.table_name)));
  switch (key) {
    case 'srcSchema': return uniq(inDb.map((t) => t.source_schema));
    case 'srcTable': return f.srcSchema.length ? uniq(inDb.filter((t) => f.srcSchema.includes(t.source_schema)).map((t) => t.table_name)) : [];
    case 'srcCol': return f.srcTable.length ? colNames(inDb.filter((t) => f.srcTable.includes(t.table_name))) : [];
    case 'tgtDb': return uniq(bySrc.map((t) => t.target_database));
    case 'tgtSchema': return f.tgtDb.length ? uniq(bySrc.filter((t) => f.tgtDb.includes(t.target_database)).map((t) => t.target_schema)) : [];
    case 'tgtTable': return f.tgtSchema.length ? uniq(bySrc.filter((t) => f.tgtDb.includes(t.target_database) && f.tgtSchema.includes(t.target_schema)).map((t) => t.snowflake_table)) : [];
    case 'tgtCol': return f.tgtTable.length ? colNames(bySrc.filter((t) => f.tgtTable.includes(t.snowflake_table))) : [];
    default: return [];
  }
}
// drop any selection that's no longer reachable from its parents
function prune(f, tables, db) {
  const next = { ...f };
  F_ORDER.forEach((k) => {
    if (!next[k].length) return;
    const ok = new Set(optionsFor(k, next, tables, db));
    next[k] = next[k].filter((v) => ok.has(v));
  });
  return next;
}

// ─── URL helpers ───
const put = (p, key, v, dflt) => { if (v == null || v === '' || v === dflt) p.delete(key); else p.set(key, String(v)); };
const val = (v, cur) => (typeof v === 'function' ? v(cur) : v);
const readF = (p) => Object.fromEntries(F_ORDER.map((k) => [k, p.getAll(k)]));
const writeF = (p, nf) => F_ORDER.forEach((k) => { p.delete(k); nf[k].forEach((v) => p.append(k, v)); });

// ─── hooks ───────────────────────────────────────────────────────────────────
function useCountUp(value, decimals = 0) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / 700);
      const v = a + (value - a) * (1 - Math.pow(1 - p, 3));
      from.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return decimals ? shown.toFixed(decimals) : Math.round(shown).toLocaleString('en-US');
}

// true one frame after mount, so bars/rings animate in from zero
function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setM(true));
    return () => cancelAnimationFrame(r);
  }, []);
  return m;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Hero: orb + source → Snowflake flow
// ═══════════════════════════════════════════════════════════════════════════════
function Orb({ counts, total, pct, loading }) {
  const mounted = useMounted();
  const shown = useCountUp(pct, 1);
  const C = 2 * Math.PI * 103;
  let off = 0;
  const segs = SPECTRUM.map((k) => {
    const len = mounted && total ? (counts[k] / total) * C : 0;
    const seg = { k, len, at: off };
    off += len;
    return seg;
  });
  const glow = pct >= 90 ? 'rgba(50,135,20,.22)' : pct >= 80 ? 'rgba(240,90,18,.2)' : 'rgba(235,23,0,.22)';
  return (
    <div className="orb" style={{ '--orb-glow': glow }}>
      <div className="halo" />
      <div className="glass" />
      <svg className="orb-ring" viewBox="0 0 230 230">
        <circle className="track" cx="115" cy="115" r="103" />
        {segs.map((s) => (
          <circle key={s.k} className="seg" cx="115" cy="115" r="103"
            style={{ stroke: COLOR[s.k], strokeDasharray: `${Math.max(0, s.len - (s.len > 6 ? 4 : 0))} ${C}`, strokeDashoffset: -s.at }} />
        ))}
      </svg>
      <div className="center">
        {loading ? <div className="pct sk-pulse">–<small>%</small></div> : <div className="pct">{shown}<small>%</small></div>}
        <div className="sub">{loading ? 'loading' : 'in sync'}</div>
        {total > 0 && (
          <div className={`delta ${counts.PASSED === total ? 'up' : 'down'}`}>
            {counts.PASSED === total ? 'All passing' : `${fmt(total - counts.PASSED)} need attention`}
          </div>
        )}
      </div>
    </div>
  );
}

function FlowZone({ sources, health, srcCounts, activeDb, onPickDb, sfSub, children }) {
  const zoneRef = useRef(null);
  const canvasRef = useRef(null);
  const sfRef = useRef(null);
  const nodeRefs = useRef({});
  const healthRef = useRef(health);
  healthRef.current = health;

  useEffect(() => {
    const zone = zoneRef.current;
    const cv = canvasRef.current;
    if (!zone || !cv) return undefined;
    const ctx = cv.getContext('2d');
    let W = 0, H = 0, lanes = [], raf = 0, onScreen = true, last = 0;
    const parts = [], bursts = [];

    // Glow dots are drawn once into tiny sprites and stamped with drawImage.
    // Building a radial gradient per particle per frame is what kills CPU-only machines.
    const sprite = (col) => {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const g = c.getContext('2d');
      const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      gr.addColorStop(0, `rgba(${col},.55)`); gr.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
      g.fillStyle = `rgb(${col})`; g.beginPath(); g.arc(16, 16, 4, 0, 7); g.fill();
      return c;
    };
    const SPR = { bad: sprite('235,23,0'), src: sprite('47,138,20'), sf: sprite('15,104,178') };

    const measure = () => {
      const box = zone.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      W = box.width; H = box.height;
      cv.width = W * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const rel = (el) => { const r = el.getBoundingClientRect(); return { l: r.left - box.left, r: r.right - box.left, cy: r.top - box.top + r.height / 2 }; };
      const orb = zone.querySelector('.orb');
      if (!orb || !sfRef.current) return;
      const ob = orb.getBoundingClientRect();
      const oc = { x: ob.left - box.left + ob.width / 2, y: ob.top - box.top + ob.height / 2, r: ob.width / 2 - 14 };
      const sf = rel(sfRef.current);
      const n = sources.length;
      lanes = sources.map((src, i) => {
        const el = nodeRefs.current[src];
        if (!el) return null;
        const a = rel(el);
        const spread = n > 1 ? (i / (n - 1) - 0.5) * 1.1 : 0; // fan into the orb
        return { db: src, a: [a.r, a.cy], b: [oc.x - oc.r * 0.75, oc.y + oc.r * spread] };
      }).filter(Boolean);
      lanes.push({ db: null, a: [oc.x + oc.r, oc.y], b: [sf.l, sf.cy] });
    };

    // cubic with both control points at the horizontal midpoint
    const at = (l, t) => {
      const [ax, ay] = l.a, [bx, by] = l.b, mx = (ax + bx) / 2, u = 1 - t;
      return [
        u * u * u * ax + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * bx,
        u * u * u * ay + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * by,
      ];
    };

    const tick = (time = 0) => {
      // frame-rate independent: 1 = one 60fps frame
      const dt = last ? Math.min(3, (time - last) / 16.67) : 1;
      last = time;
      ctx.clearRect(0, 0, W, H);
      lanes.forEach((l) => {
        const [ax, ay] = l.a, [bx, by] = l.b, mx = (ax + bx) / 2;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.bezierCurveTo(mx, ay, mx, by, bx, by);
        ctx.strokeStyle = 'rgba(42,38,36,.08)'; ctx.lineWidth = 6; ctx.setLineDash([]); ctx.stroke();
        ctx.strokeStyle = l.db ? 'rgba(42,38,36,.18)' : 'rgba(15,104,178,.35)'; ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 7]); ctx.lineDashOffset = -time / 40; ctx.stroke();
      });
      ctx.setLineDash([]);
      lanes.forEach((l) => {
        if (parts.length < 70 && Math.random() < (l.db ? 0.09 : 0.12) * dt) {
          // a particle turns red in proportion to how unhealthy its source is
          const bad = l.db && Math.random() > (healthRef.current[l.db] ?? 1);
          parts.push({ l, t: 0, v: 0.006 + Math.random() * 0.006, bad, size: 1.6 + Math.random() * 1.8 });
        }
      });
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.t += p.v * dt;
        if (p.t >= 1) {
          if (p.bad) bursts.push({ x: p.l.b[0], y: p.l.b[1], r: 2, a: 0.8 });
          parts.splice(i, 1);
          continue;
        }
        const [x, y] = at(p.l, p.t);
        const r = p.size * 4;
        ctx.drawImage(p.bad ? SPR.bad : p.l.db ? SPR.src : SPR.sf, x - r, y - r, r * 2, r * 2);
      }
      ctx.lineWidth = 1.5;
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i];
        b.r += 0.9 * dt; b.a -= 0.025 * dt;
        if (b.a <= 0) { bursts.splice(i, 1); continue; }
        ctx.strokeStyle = `rgba(235,23,0,${b.a})`;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.stroke();
      }
      raf = onScreen && !document.hidden ? requestAnimationFrame(tick) : 0;
    };

    const ro = new ResizeObserver(measure);
    ro.observe(zone);
    measure();
    // only animate while the hero is on screen and the tab is visible
    const wake = () => { if (!raf && onScreen && !document.hidden) { last = 0; raf = requestAnimationFrame(tick); } };
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; wake(); });
    io.observe(zone);
    document.addEventListener('visibilitychange', wake);
    wake();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', wake); };
  }, [sources.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = sources.length;
  return (
    <div className="flowzone" ref={zoneRef}>
      <canvas ref={canvasRef} />
      {sources.map((src, i) => {
        const p = health[src] ?? 1;
        const tone = p >= 0.9 ? ['var(--green)', 'var(--green-soft)'] : p >= 0.8 ? ['var(--orange)', 'var(--orange-soft)'] : ['var(--red)', 'var(--red-soft)'];
        const top = n === 1 ? 50 : 18 + (64 * i) / (n - 1);
        return (
          <button key={src} type="button" ref={(el) => { nodeRefs.current[src] = el; }}
            className={`node${activeDb === src ? ' active' : ''}`}
            style={{ left: 0, top: `${top}%`, transform: 'translateY(-50%)' }}
            onClick={() => onPickDb(activeDb === src ? 'all' : src)}
            title={activeDb === src ? 'Show all sources' : `Show only ${src}`}>
            <span className={`db c${i % 3}`}>{abbr(src)}</span>
            <div><b>{src}</b><small>Oracle · {fmt(srcCounts[src] || 0)} tables</small></div>
            <span className="npct" style={{ color: tone[0], background: tone[1] }}>{srcCounts[src] ? `${Math.round(p * 100)}%` : '–'}</span>
          </button>
        );
      })}
      {children}
      <div className="node" ref={sfRef} style={{ right: 0, top: '50%', transform: 'translateY(-50%)' }}>
        <span className="db sf"><Ico n="sf" /></span>
        <div><b>Snowflake</b><small>{sfSub}</small></div>
      </div>
    </div>
  );
}

function Tile({ def, n, total, active, onClick, loading }) {
  const shown = useCountUp(n);
  const mounted = useMounted();
  const share = total ? (n / total) * 100 : 0;
  return (
    <button type="button" className={`tile reveal${active ? ' active' : ''}${n === 0 && def.k !== 'ALL' ? ' zero' : ''}`}
      data-k={def.k} onClick={onClick} aria-pressed={active}>
      <div className="top"><span className="ico"><Ico n={def.ic} /></span><span className="name">{def.name}</span></div>
      <div className="row">
        {loading ? <span className="sk sk-num" /> : <div className="num">{shown}</div>}
        {def.k !== 'ALL' && <div className="bar"><i style={{ width: mounted ? `${share}%` : 0 }} /></div>}
      </div>
      <div className="share">{loading ? <span className="sk" style={{ width: 70, height: 8 }} /> : def.k === 'ALL' ? 'click any tile to filter' : `${share.toFixed(1)}% of tables`}</div>
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Filter dropdown
// ═══════════════════════════════════════════════════════════════════════════════
function MultiSelect({ id, label, options, selected, onChange, disabled, blockedText, open, setOpen }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => {
    if (open) { setQ(''); setTimeout(() => inputRef.current?.focus(), 20); }
  }, [open]);
  const shown = q ? options.filter((o) => o.toLowerCase().includes(q.toLowerCase())) : options;
  const all = options.length > 0 && selected.length === options.length;
  return (
    <div className={`ms${open ? ' open' : ''}`}>
      <label>{label}</label>
      <button type="button" className="ms-btn" disabled={disabled} onClick={() => setOpen(open ? null : id)} aria-expanded={open}>
        <span>
          {disabled ? <span className="ph">{blockedText}</span>
            : !selected.length ? <span className="ph">Any {label.toLowerCase()}</span>
              : selected.length === 1 ? selected[0] : <span className="cnt">{selected.length} selected</span>}
        </span>
        <Ico n="down" />
      </button>
      {open && !disabled && (
        <div className="ms-pop">
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${label.toLowerCase()}…`} />
          {options.length > 1 && (
            <div className="ms-all" onClick={() => onChange(all ? [] : options)}>{all ? '− Deselect all' : '+ Select all'}</div>
          )}
          <div className="ms-list">
            {shown.length ? shown.map((o) => {
              const on = selected.includes(o);
              return (
                <div key={o} className={`ms-opt${on ? ' on' : ''}`}
                  onClick={() => onChange(on ? selected.filter((x) => x !== o) : [...selected, o])}>
                  <Tick on={on} />{o}
                </div>
              );
            }) : <div className="ms-empty">Nothing matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Column details (shown when a column filter is active)
// ═══════════════════════════════════════════════════════════════════════════════
function ColumnDetails({ tables, columns }) {
  const [sort, setSort] = useState({ key: 'column_name', dir: 'asc' });
  const stats = useMemo(() => {
    const out = {};
    tables.forEach((t) => (t.column_statistics || []).forEach((c) => {
      if (!columns.includes(c.column_name)) return;
      const s = out[c.column_name] ||= { column_name: c.column_name, occurrences: 0, src: new Set(), tgt: new Set(), od: 0, sd: 0, on: 0, sn: 0 };
      const v = colStats(c);
      s.occurrences++;
      if (c.oracle_type) s.src.add(c.oracle_type);
      if (c.snowflake_type) s.tgt.add(c.snowflake_type);
      s.od += v.od; s.sd += v.sd; s.on += v.on; s.sn += v.sn;
    }));
    const m = sort.dir === 'asc' ? 1 : -1;
    return Object.values(out).sort((a, b) => (a[sort.key] < b[sort.key] ? -m : a[sort.key] > b[sort.key] ? m : 0));
  }, [tables, columns, sort]);

  const head = (label, key, right) => (
    <th className={`sort${sort.key === key ? ' sorted' : ''}${right ? ' r' : ''}`}
      onClick={() => setSort((p) => ({ key, dir: p.key === key && p.dir === 'asc' ? 'desc' : 'asc' }))}>
      {label}{sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );

  return (
    <section className="card reveal" style={{ '--d': '100ms', marginBottom: 16 }}>
      <div className="coldetail-head">
        <Ico n="grid" /><h3>Column details · {stats.length} column{stats.length === 1 ? '' : 's'}</h3>
      </div>
      {stats.length === 0 ? (
        <div className="empty" style={{ padding: 32 }}><p>The selected columns aren&apos;t in any table in the current view.</p></div>
      ) : (
        <div className="table-wrap" style={{ padding: '4px 8px 8px' }}>
          <table className="mini">
            <thead><tr>
              {head('Column', 'column_name')}<th>Source type</th><th>Target type</th>
              {head('Src distinct', 'od', 1)}{head('Tgt distinct', 'sd', 1)}{head('Src nulls', 'on', 1)}{head('Tgt nulls', 'sn', 1)}{head('In tables', 'occurrences', 1)}
            </tr></thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.column_name}>
                  <td><b>{s.column_name}</b></td>
                  <td className="t">{[...s.src].join(', ') || '—'}</td>
                  <td className="t">{[...s.tgt].join(', ') || '—'}</td>
                  <td className={`r mono${s.od !== s.sd ? ' bad-t' : ''}`}><Num v={s.od} /></td>
                  <td className={`r mono${s.od !== s.sd ? ' bad-t' : ''}`}><Num v={s.sd} /></td>
                  <td className={`r mono${s.on !== s.sn ? ' bad-t' : ''}`}><Num v={s.on} /></td>
                  <td className={`r mono${s.on !== s.sn ? ' bad-t' : ''}`}><Num v={s.sn} /></td>
                  <td className="r"><span className="status NONE" style={{ height: 20 }}>{s.occurrences}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Detail drawer
// ═══════════════════════════════════════════════════════════════════════════════
function CompareBars({ a, b, aLabel = 'Oracle', bLabel = 'Snowflake', ok }) {
  const mounted = useMounted();
  const max = Math.max(a || 0, b || 0, 1);
  return (
    <>
      <div className="cbar"><span className="lbl">{aLabel}</span><span className="track"><i style={{ width: mounted ? `${((a || 0) / max) * 100}%` : 0, background: 'var(--blue)' }} /></span><span className="val"><Num v={a} /></span></div>
      <div className="cbar"><span className="lbl">{bLabel}</span><span className="track"><i style={{ width: mounted ? `${((b || 0) / max) * 100}%` : 0, background: ok ? 'var(--green)' : 'var(--red)' }} /></span><span className="val"><Num v={b} /></span></div>
    </>
  );
}

function constraintVerdict(ca) {
  const vals = Object.values(ca?.summary || {});
  if (!vals.length) return null;
  if (vals.includes('MISMATCH') || vals.includes('VALIDATION_FAILED')) return 'bad';
  if (vals.includes('DEFINITION_MISMATCH')) return 'warn';
  return 'ok';
}

function Drawer({ t, tab, setTab, busy, canRefresh, onClose, onRevalidate, onCopy }) {
  const [warnOpen, setWarnOpen] = useState(false);
  const tabsRef = useRef(null);
  const [ink, setInk] = useState({ left: 0, width: 0 });

  useEffect(() => { setWarnOpen(false); }, [t?._key]);
  useEffect(() => {
    const on = tabsRef.current?.querySelector('button.on');
    if (on) setInk({ left: on.offsetLeft, width: on.offsetWidth });
  }, [tab, t?._key]);

  if (!t) return null;
  const stats = t.column_statistics || [];
  const colBad = stats.filter((c) => { const v = colStats(c); return v.od !== v.sd || v.on !== v.sn; }).length;
  const issues = issuesOf(t);
  const ca = t.constraint_analysis;
  const dq = t.data_quality;
  const an = t.column_analysis || {};
  const tabs = [
    ['overview', 'Overview'],
    ['columns', 'Columns', stats.length, colBad],
    ['quality', 'Quality'],
    ['constraints', 'Constraints'],
    ['issues', 'Issues', issues.length, issues.length],
  ];

  let pane;
  if (tab === 'overview') {
    const verdict = constraintVerdict(ca);
    const nn = ca?.validation_results?.not_null_constraints;
    const checks = [
      t._hasRows && ['Row count', t._match ? 'ok' : 'bad', <><Num v={t._rs} /> → <Num v={t._rt} /></>, t._match ? 'Identical row counts' : <><Num v={Math.abs(t._rs - t._rt)} /> row difference</>],
      dq && ['Null counts', dq.null_match ? 'ok' : 'bad', <><Num v={dq.oracle_nulls} /> → <Num v={dq.snowflake_nulls} /></>, dq.null_match ? 'Nulls match' : 'Null counts differ'],
      dq && ['Duplicates', dq.duplicate_match ? 'ok' : 'bad', <><Num v={dq.oracle_duplicates} /> → <Num v={dq.snowflake_duplicates} /></>, dq.duplicate_match ? 'No duplicate drift' : 'Duplicate counts differ'],
      t.column_analysis && ['Schema', an.oracle_only_columns?.length ? 'warn' : 'ok', `${an.oracle_columns ?? 0} → ${an.snowflake_columns ?? 0} cols`,
        an.oracle_only_columns?.length ? `${an.oracle_only_columns.length} source column(s) missing in Snowflake` : 'All source columns present'],
      verdict && ['Constraints', verdict, '', verdict === 'ok' ? 'Keys and constraints line up' : verdict === 'warn' ? 'Definitions differ' : 'Constraint mismatch'],
      nn?.status && nn.status !== 'UNKNOWN' && (nn.status === 'VALIDATION_FAILED' ? ['NOT NULL', 'bad', '', 'Nulls found in NOT NULL columns']
        : nn.status === 'DEFINITION_MISMATCH' ? ['NOT NULL', 'warn', '', 'NOT NULL definitions differ']
          : ['NOT NULL', 'ok', '', 'No nulls in NOT NULL columns']),
    ].filter(Boolean);
    pane = (
      <>
        <div className="kpis">
          <div className="card kpi"><div className="k">Source rows</div><div className="v">{t._hasRows ? <Num v={t._rs} /> : '—'}</div><div className="d muted">Oracle · {t._src}</div></div>
          <div className="card kpi"><div className="k">Snowflake rows</div><div className="v">{t._hasRows ? <Num v={t._rt} /> : '—'}</div>
            {t._hasRows
              ? <div className={`d ${t._match ? 'ok-t' : 'bad-t'}`}>{t._match ? '✓ exact match' : <>{t._rs > t._rt ? '−' : '+'}<Num v={Math.abs(t._rs - t._rt)} /> rows</>}</div>
              : <div className="d muted">not measured</div>}</div>
          <div className="card kpi"><div className="k">Columns in common</div><div className="v">{an.common_columns ?? '—'}</div>
            <div className={`d ${colBad ? 'bad-t' : 'muted'}`}>{colBad ? `${colBad} column${colBad > 1 ? 's' : ''} drifting` : `${stats.length} profiled`}</div></div>
        </div>
        <div className="gap" />
        {t._hasRows && (
          <><div className="card compare">
            <h4>Row count comparison<span className="sp" /><Status s={t._match ? 'MATCH' : 'MISMATCH'} /></h4>
            <CompareBars a={t._rs} b={t._rt} ok={t._match} />
          </div>
          <div className="gap" /></>
        )}
        <div className="checks-list">
          {checks.map(([name, tone, nums, sub]) => (
            <div className="check-row" key={name}>
              <span className={`ic ${tone}`}><Ico n={tone === 'ok' ? 'check' : tone === 'warn' ? 'alert' : 'x'} /></span>
              <div className="tx"><b>{name}</b><span>{sub}</span></div>
              {nums && <div className="nums mono">{nums}</div>}
            </div>
          ))}
        </div>
      </>
    );
  } else if (tab === 'columns') {
    const sorted = [...stats].sort((a, b) => {
      const x = colStats(a), y = colStats(b);
      return (y.od !== y.sd || y.on !== y.sn) - (x.od !== x.sd || x.on !== x.sn); // drifting first
    });
    pane = (
      <>
        <div className="kpis">
          <div className="card kpi"><div className="k">Source columns</div><div className="v">{an.oracle_columns ?? 0}</div></div>
          <div className="card kpi"><div className="k">Snowflake columns</div><div className="v">{an.snowflake_columns ?? 0}</div></div>
          <div className="card kpi"><div className="k">In common</div><div className="v ok-t">{an.common_columns ?? 0}</div></div>
        </div>
        <div className="gap" />
        {sorted.length > 0 && (
          <div className="card blk" style={{ padding: '6px 6px 2px', overflowX: 'auto' }}>
            <table className="mini">
              <thead><tr><th>Column</th><th>Oracle → Snowflake</th><th className="r">Distinct</th><th className="r">Nulls</th><th /></tr></thead>
              <tbody>
                {sorted.map((c, i) => {
                  const v = colStats(c);
                  const dOk = v.od === v.sd, nOk = v.on === v.sn;
                  return (
                    <tr key={`${c.column_name}-${i}`}>
                      <td><b>{c.column_name}</b></td>
                      <td className="t">{c.oracle_type || '—'} → {c.snowflake_type || '—'}</td>
                      <td className={`r mono${dOk ? '' : ' bad-t'}`}><Num v={v.od} />{!dOk && <> → <Num v={v.sd} /></>}</td>
                      <td className={`r mono${nOk ? '' : ' bad-t'}`}><Num v={v.on} />{!nOk && <> → <Num v={v.sn} /></>}</td>
                      <td className="r">{dOk && nOk ? <span className="ok-t"><Ico n="check" style={{ width: 14, height: 14 }} /></span> : <span className="bad-t"><Ico n="alert" style={{ width: 14, height: 14 }} /></span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {an.oracle_only_columns?.length > 0 && (
          <><div className="gap" /><div className="card blk"><h4><span className="warn-t"><Ico n="alert" /></span>Only in Oracle ({an.oracle_only_columns.length})</h4>
            <div className="tagcloud">{an.oracle_only_columns.map((c) => <span key={c} className="tag o">{c}</span>)}</div></div></>
        )}
        {an.snowflake_only_columns?.length > 0 && (
          <><div className="gap" /><div className="card blk"><h4><span style={{ color: 'var(--blue)' }}><Ico n="db" /></span>Only in Snowflake ({an.snowflake_only_columns.length})</h4>
            <div className="tagcloud">{an.snowflake_only_columns.map((c) => <span key={c} className="tag b">{c}</span>)}</div></div></>
        )}
      </>
    );
  } else if (tab === 'quality') {
    pane = dq ? (
      <>
        <div className="card compare">
          <h4>Null count analysis<span className="sp" /><Status s={dq.null_match ? 'MATCH' : 'MISMATCH'} /></h4>
          <CompareBars a={dq.oracle_nulls} b={dq.snowflake_nulls} ok={dq.null_match} />
        </div>
        <div className="gap" />
        <div className="card compare">
          <h4>Duplicate count analysis<span className="sp" /><Status s={dq.duplicate_match ? 'MATCH' : 'MISMATCH'} /></h4>
          <CompareBars a={dq.oracle_duplicates} b={dq.snowflake_duplicates} ok={dq.duplicate_match} />
        </div>
      </>
    ) : (
      <div className="card allgood grey"><div className="art"><Ico n="grid" /></div><h3>No quality data</h3><p>This table has no null or duplicate analysis.</p></div>
    );
  } else if (tab === 'constraints') {
    const det = ca?.constraint_details;
    const nn = ca?.validation_results?.not_null_constraints;
    // scripts write this as { "Primary Keys mismatch": "Source=1, Snowflake=0" }
    const rawWarns = ca?.constraint_warnings;
    const warns = Array.isArray(rawWarns) ? rawWarns : Object.entries(rawWarns || {}).map(([k, v]) => `${k}: ${v}`);
    pane = !ca ? (
      <div className="card allgood grey"><div className="art"><Ico n="shield" /></div><h3>No constraint analysis</h3><p>Nothing was captured for this table.</p></div>
    ) : (
      <>
        {ca.summary && (
          <div className="kpis four">
            {Object.entries(ca.summary).map(([k, v]) => (
              <div className="card kpi" key={k}><div className="k">{k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</div><div style={{ marginTop: 8 }}><Status s={v} /></div></div>
            ))}
          </div>
        )}
        {det && (
          <><div className="gap" /><div className="kpis two">
            {[['Oracle', 'var(--blue)', det.oracle], ['Snowflake', 'var(--red)', det.snowflake]].map(([name, c, d = {}]) => (
              <div className="card blk" key={name}>
                <h4><span style={{ color: c }}><Ico n="db" /></span>{name}</h4>
                <div className="lbl2">Primary key</div>
                <div className="tagcloud" style={{ marginBottom: 12 }}>
                  {d.primary_keys?.length ? d.primary_keys.map((k) => <span key={k} className="tag b">{k}</span>) : <span className="muted" style={{ fontSize: 12 }}>None</span>}
                </div>
                <div className="lbl2">NOT NULL</div>
                <div className="tagcloud" style={{ marginBottom: 12 }}>
                  {d.not_null_columns?.length ? d.not_null_columns.map((k) => <span key={k} className="tag g">{k}</span>) : <span className="muted" style={{ fontSize: 12 }}>None</span>}
                </div>
                <div className="lbl2">Unique · Foreign keys</div>
                <div style={{ fontSize: 12.5 }}>{d.unique_constraints?.length || 0} unique · {d.foreign_keys?.length || 0} foreign</div>
              </div>
            ))}
          </div></>
        )}
        {nn?.details && (
          <><div className="gap" /><div className="card blk" style={{ padding: '12px 6px 2px' }}>
            <h4 style={{ padding: '0 10px' }}>NOT NULL validation<span className="sp" />{nn.status && <Status s={nn.status} />}</h4>
            <table className="mini"><thead><tr><th>Column</th><th className="r">Snowflake nulls</th><th className="r">Result</th></tr></thead>
              <tbody>{nn.details.map((d, i) => (
                <tr key={i}><td><b>{d.column}</b></td><td className={`r mono${d.snowflake_null_count > 0 ? ' bad-t' : ''}`}><Num v={d.snowflake_null_count} /></td>
                  <td className="r">{d.validation_status && <Status s={d.validation_status} />}</td></tr>
              ))}</tbody></table>
          </div></>
        )}
        {warns.length > 0 && (
          <><div className="gap" /><div className="card blk">
            <button type="button" className={`fold${warnOpen ? ' open' : ''}`} onClick={() => setWarnOpen((o) => !o)}>
              <Ico n="alert" />Constraint warnings ({warns.length})<span className="sp" /><Ico n="right" className="chev" />
            </button>
            {warnOpen && <div style={{ marginTop: 12 }}>{warns.map((w, i) => <div className="issue warn" key={i}><Ico n="alert" /><p>{w}</p></div>)}</div>}
          </div></>
        )}
      </>
    );
  } else {
    pane = issues.length ? issues.map((iss, i) => (
      <div className="issue" key={i}><Ico n="xc" /><div><p>{iss}</p>{t._t > 0 && <small>Detected {ago(t._t)} · {stamp(t._t)}</small>}</div></div>
    )) : (
      <div className="card allgood"><div className="art"><Ico n="check" /></div><h3>No issues</h3><p>Every check passed on the last run.</p></div>
    );
  }

  return (
    <>
      <div className="dr-head">
        <div className="dr-top">
          <div className="dr-path">
            <div className="dr-end"><div className="k"><i style={{ background: 'var(--blue)' }} />Oracle · {t._src}</div>
              <div className="v" title={t.table_name}>{t.table_name}</div><div className="s">{t.source_schema}</div></div>
            <div className="dr-flow"><Ico n="arrow" /></div>
            <div className="dr-end"><div className="k"><i style={{ background: 'var(--red)' }} />Snowflake</div>
              <div className="v" title={t.snowflake_table}>{t.snowflake_table}</div><div className="s">{t.target_database}.{t.target_schema}</div></div>
          </div>
          <button type="button" className="btn sm icon ghost" onClick={onClose} data-tip="Close (Esc)" aria-label="Close"><Ico n="x" /></button>
        </div>
        <div className="dr-sub">
          <Status s={busy ? 'RUNNING' : t.status} />
          {t._t > 0 && <span><Ico n="clock" />{ago(t._t)} · {stamp(t._t)}</span>}
          <span className="sp" />
          <button type="button" className="btn sm" onClick={() => onCopy(t.snowflake_table)}><Ico n="copy" />Copy name</button>
          {canRefresh !== 'hidden' && (
            <button type="button" className="btn sm primary" disabled={busy || canRefresh !== 'active'} onClick={() => onRevalidate([t])}
              title={canRefresh === 'no-connection' ? 'No Oracle connection configured for this database' : undefined}>
              <Ico n="refresh" className={busy ? 'spin' : ''} />{busy ? 'Validating…' : 'Re-validate'}
            </button>
          )}
        </div>
        <div className="tabs" ref={tabsRef}>
          {tabs.map(([k, l, n, bad]) => (
            <button type="button" key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {l}{n != null && <span className={`n${bad ? ' bad' : ''}`}>{bad ? `${bad}/${n}` : n}</span>}
            </button>
          ))}
          <span className="ink" style={ink} />
        </div>
      </div>
      <div className="dr-body"><div className="pane" key={`${t._key}-${tab}`}>{pane}</div></div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Run dock — one streaming job per database
// ═══════════════════════════════════════════════════════════════════════════════
// What the validation script prints:
//   "✅ [12/40] MY_TABLE - PASSED"            first result for a table (idx is submit order, not progress)
//   "✅ Completed pipeline 2/5: NAME"         pipelines finish in parallel, so this is the real progress
//   "Total Validated: 310" / "✅ Passed: 290"  final, retry-corrected totals
//   "CORE not updated"                        run saved to STG only; the page won't show it
const runStamp = (s) => { const d = new Date(s); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
// AD display names carry a suffix like "[JRDUS NON-J&J]"; older rows were saved with it
const cleanName = (n) => (n || '').replace(/\s*\[[^\]]*\]/g, '').trim();
const dur = (sec) => (sec == null ? '' : sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`);
const ROW_RE = /\[\d+\/\d+\]\s+.+?\s+-\s+(.+)$/;
const PIPE_DONE_RE = /Completed pipeline (\d+)\/(\d+)/;
const TOTAL_RE = /^Total Validated:\s*(\d+)/;
const PASSED_RE = /^✅ Passed:\s*(\d+)/;

function RunJob({ db, runId, watch, onDone, openLog = false }) {
  const [logs, setLogs] = useState([]);
  const [code, setCode] = useState(null);
  const [stopped, setStopped] = useState(false);
  const [prog, setProg] = useState(null); // { done, total } pipelines
  const [tally, setTally] = useState({ pass: 0, fail: 0 });
  const [logOpen, setLogOpen] = useState(openLog);
  const logRef = useRef(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    // watch = a run already going or finished (anyone's, any server): replay its log from Postgres, never start one.
    // If the connection drops mid-run (VPN blip, proxy timeout, server restart) we reconnect and resume
    // from the last line we got, so the panel doesn't flip to "Failed" while the run is still going.
    let es = null, finished = false, published = true, total = null;
    let id = runId, lastSeq = 0, tries = 0, retryTimer = null;
    // lines arrive in bursts (a replay can be thousands); render once per frame, not once per line
    let pend = [], pass = 0, fail = 0, raf = 0;
    const paint = () => {
      raf = 0;
      if (pend.length) {
        const add = pend; pend = [];
        setLogs((prev) => { const next = prev.concat(add); return next.length > 1500 ? next.slice(-1200) : next; });
      }
      if (pass || fail) {
        const p = pass, f = fail; pass = 0; fail = 0;
        setTally((tl) => ({ pass: tl.pass + p, fail: tl.fail + f }));
      }
    };
    const queue = (line) => { pend.push(line); if (!raf) raf = requestAnimationFrame(paint); };
    const finish = (rc, wasStopped = false) => {
      if (finished) return;
      finished = true;
      if (raf) { cancelAnimationFrame(raf); paint(); }
      setCode(rc);
      setStopped(wasStopped);
      es?.close();
      doneRef.current(db, rc, published, wasStopped);
    };
    const onMessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      tries = 0;
      if (data.type === 'run') { id = data.run_id; return; }
      if (data.seq) { if (data.seq <= lastSeq) return; lastSeq = data.seq; }
      if (data.type !== 'done') queue(data);
      const msg = (data.message || '').trim();
      let m;
      if ((m = msg.match(ROW_RE))) {
        if (/^PASSED\b/.test(m[1])) pass++; else fail++;
      } else if ((m = msg.match(PIPE_DONE_RE))) {
        setProg({ done: +m[1], total: +m[2] });
      } else if ((m = msg.match(TOTAL_RE))) {
        total = +m[1];
      } else if ((m = msg.match(PASSED_RE)) && total != null) {
        if (raf) { cancelAnimationFrame(raf); paint(); }
        pass = 0; fail = 0;
        setTally({ pass: +m[1], fail: Math.max(0, total - m[1]) });
      } else if (msg.includes('CORE not updated')) {
        published = false;
      }
      if (data.type === 'done') finish(data.returncode, !!data.stopped);
    };
    const lost = (why) => {
      if (finished) return;
      es?.close();
      // 4xx won't fix itself, and without a run id there is nothing to resume
      if (!id || (why.status >= 400 && why.status < 500) || tries >= 20) {
        queue({ type: 'error', message: why.text, timestamp: new Date().toISOString() });
        finish(-1);
        return;
      }
      tries++;
      if (tries === 1) queue({ type: 'info', message: 'Connection dropped — reconnecting…', timestamp: new Date().toISOString() });
      retryTimer = setTimeout(connect, Math.min(1000 * 2 ** (tries - 1), 10000));
    };
    const connect = () => {
      es = apiEventSource(id
        ? `/api/it-validation-stream?run_id=${encodeURIComponent(id)}&after=${lastSeq}`
        : `/api/run-it-validation?db=${encodeURIComponent(db)}`);
      es.onmessage = onMessage;
      es.onerror = (e) => lost({ status: e?.status, text: e?.status ? `Server returned ${e.status}${e.message ? ` ${e.message}` : ''}` : 'Connection lost to server' });
      es.onend = () => lost({ text: 'The server closed the connection' }); // closed without a 'done' event
    };
    if (watch) id = runId;
    connect();
    return () => { finished = true; clearTimeout(retryTimer); if (raf) cancelAnimationFrame(raf); es?.close(); };
  }, [db, runId, watch]);

  useEffect(() => {
    if (logOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, logOpen]);

  const running = code === null;
  const pct = prog ? Math.round((prog.done / prog.total) * 100) : 0;
  const label = RUN_DBS.find((d) => d.id === db)?.label || db;
  const ts = (s) => { const d = new Date(s); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour12: false }); };

  return (
    <div className={`job${running ? '' : code === 0 ? ' done' : ' fail'}`}>
      <div className="job-top">
        <span className={`db c${db === 'insight7' ? 0 : 1}`}>{abbr(label)}</span>{label}
        <span className="sp" />
        <span className="pc">{!running ? (stopped ? 'Stopped' : code === 0 ? 'Complete' : 'Failed') : prog ? `${pct}%` : 'Starting…'}</span>
      </div>
      <div className={`prog${running && !prog ? ' indet' : ''}`}><i style={{ width: `${pct}%` }} /></div>
      <div className="job-stats">
        {prog && <span><b>{prog.done}</b>/{prog.total} pipelines</span>}
        <span className="ok-t"><b>{tally.pass}</b> passed</span>
        <span className="bad-t"><b>{tally.fail}</b> failing</span>
      </div>
      <button type="button" className={`log-toggle${logOpen ? ' open' : ''}`} onClick={() => setLogOpen((o) => !o)}>
        <Ico n="right" />{logOpen ? 'Hide' : 'Show'} log
      </button>
      <div className={`log${logOpen ? ' open' : ''}`} ref={logRef}>
        {logs.length === 0 && <div className="ts">Connecting…</div>}
        {logs.map((l, i) => (l.type === 'separator' ? <hr key={l.seq || `x${i}`} /> : (
          <div key={l.seq || `x${i}`}><span className="ts">{ts(l.timestamp)}</span><span className={l.type}>{l.message}</span></div>
        )))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main view
// ═══════════════════════════════════════════════════════════════════════════════
export default function ITChecksView({
  reportData, availableRuns = [], runsMerged, newestDate, oldestDate, runsLoading, isLoading, loadError,
  onLoadRuns, onRevalidateTable, canRefreshTable, canRun, canSwitch, onSwitch,
}) {
  // ── table data ──
  const allTables = useMemo(() => {
    if (!reportData?.pipeline_results) return [];
    return reportData.pipeline_results.flatMap((pipeline) =>
      (pipeline?.validation_results?.table_validations || []).map((table) => {
        const rc = table.row_counts || { oracle: 0, snowflake: 0, match: false };
        const t = {
          ...table,
          pipeline_name: pipeline.pipeline_name || 'Unknown',
          source_db: table._source_db || '',
          // per-table annotation from multi-run merge wins over the pipeline value
          source_schema: table._oracle_schema || pipeline.oracle_schema || 'Unknown',
          target_database: table._snowflake_database || pipeline.snowflake_database || 'Unknown',
          target_schema: table._snowflake_schema || pipeline.snowflake_schema || 'Unknown',
          table_name: table.table_name || 'Unknown',
          snowflake_table: table.snowflake_table || 'Unknown',
          status: table.status || 'Unknown',
          row_counts: rc,
          Last_Checked: table.Last_Checked || '',
        };
        // db + schema are part of the key: the same table name can exist in several of each
        t._key = `${t.source_db}|${t.source_schema}|${t.pipeline_name}|${t.table_name}`;
        t._src = sourceOf(t.source_db);
        t._t = toTime(t.Last_Checked);
        t._hasRows = !!table.row_counts; // absent on ERROR / TIMEOUT / NOT FOUND rows
        t._rs = Number(rc.oracle) || 0;
        t._rt = Number(rc.snowflake) || 0;
        t._match = !!rc.match;
        return t;
      }));
  }, [reportData]);
  const byKey = useMemo(() => new Map(allTables.map((t) => [t._key, t])), [allTables]);
  const booting = !reportData; // first load: show the page with placeholders instead of a spinner
  const bootFailed = booting && !isLoading && !!loadError;
  const sources = useMemo(() => uniq(allTables.map((t) => t._src)), [allTables]);

  // ── URL state ──
  // Everything you'd want in a shared link or on Back/Forward lives in the query string:
  //   /dqe?check=IT_Checks&status=CRITICAL&db=Insight7&q=MGR&srcSchema=MGR&sort=drift&dir=desc  (default sort: table_name asc)
  //        &page=2&size=100&table=<source_db>|<schema>|<pipeline>|<table>&tab=columns&run=<load_date>&run=<load_date>
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const search = sp.toString();
  const urlState = useMemo(() => {
    const p = new URLSearchParams(search);
    return {
      q: p.get('q') || '',
      statusKey: p.get('status') || 'ALL',
      db: p.get('db') || 'all',
      f: Object.fromEntries(F_ORDER.map((k) => [k, p.getAll(k)])),
      sort: { key: p.get('sort') || 'table_name', dir: p.get('dir') === 'desc' ? 'desc' : 'asc' },
      page: Math.max(1, parseInt(p.get('page'), 10) || 1),
      size: [25, 50, 100, 200].includes(+p.get('size')) ? +p.get('size') : 50,
      openKey: p.get('table'),
      tab: p.get('tab') || 'overview',
      appliedRuns: p.getAll('run'),
    };
  }, [search]);
  const { q, statusKey, db, f, sort, page, size, openKey, tab, appliedRuns } = urlState;

  // Several setters often fire in one click (status + page + …). Collect them and
  // write the URL once, starting from the live location so nothing gets clobbered.
  const pending = useRef(null);
  const write = useCallback((mutate, { push = false, state } = {}) => {
    if (!pending.current) {
      pending.current = { p: new URLSearchParams(window.location.search), push: false, state: undefined };
      queueMicrotask(() => {
        const { p, push: doPush, state: st } = pending.current;
        pending.current = null;
        if (p.toString() === new URLSearchParams(window.location.search).toString()) return;
        setSp(p, { replace: !doPush, state: st ?? window.history.state?.usr });
      });
    }
    mutate(pending.current.p);
    if (push) pending.current.push = true;
    if (state) pending.current.state = state;
  }, [setSp]);
  const { setQ, setStatusKey, setDbState, setF, setSort, setPage, setSize, setAppliedRuns, setTab } = useMemo(() => ({
    setQ: (v) => write((p) => put(p, 'q', val(v, p.get('q') || ''), '')),
    setStatusKey: (v) => write((p) => put(p, 'status', val(v, p.get('status') || 'ALL'), 'ALL'), { push: true }),
    setDbState: (v) => write((p) => put(p, 'db', val(v, p.get('db') || 'all'), 'all'), { push: true }),
    setF: (v) => write((p) => writeF(p, val(v, readF(p))), { push: true }),
    setSort: (v) => write((p) => {
      const nx = val(v, { key: p.get('sort') || 'table_name', dir: p.get('dir') || 'asc' });
      put(p, 'sort', nx.key, 'table_name'); put(p, 'dir', nx.dir, 'asc');
    }),
    setPage: (v) => write((p) => put(p, 'page', val(v, +p.get('page') || 1), 1)),
    setSize: (v) => write((p) => put(p, 'size', val(v, +p.get('size') || 50), 50)),
    setAppliedRuns: (runs) => write((p) => { p.delete('run'); runs.forEach((r) => p.append('run', r)); }, { push: true }),
    setTab: (v) => write((p) => put(p, 'tab', v, 'overview')),
  }), [write]);
  // Opening the drawer pushes a history entry (so Back closes it); closing pops that entry.
  const setOpenKey = useCallback((v) => {
    const cur = new URLSearchParams(window.location.search).get('table');
    if (!v) {
      if (!cur) return;
      if (window.history.state?.usr?.itcDrawer) { navigate(-1); return; }
      write((p) => { p.delete('table'); p.delete('tab'); });
      return;
    }
    write((p) => { p.set('table', v); p.delete('tab'); }, cur ? {} : { push: true, state: { itcDrawer: true } });
  }, [navigate, write]);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(() => new Set());
  const [flash, setFlash] = useState({});
  const [focus, setFocus] = useState(-1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [openMs, setOpenMs] = useState(null);
  const [compactRows, setCompactRows] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingRuns, setPendingRuns] = useState([]);
  const [runModal, setRunModal] = useState(false);
  const [runSel, setRunSel] = useState({ insight7: false, rimdocs: false });
  const [hist, setHist] = useState(null); // null = closed; { runs, sel, loading, error }
  const [run, setRun] = useState(null); // { id, dbs, codes: {db: code|null}, unpublished: [db], min, full, watch: {db: true}, by: {db: status}, stopping, stopped }
  const runSeq = useRef(0);
  const searchRef = useRef(null);
  const resultsRef = useRef(null);
  const toastId = useRef(0);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // ── toasts ──
  const dismissToast = useCallback((id) => setToasts((ts) => ts.filter((x) => x.id !== id)), []);
  const toast = useCallback((kind, title, sub, onClick) => {
    const id = ++toastId.current;
    setToasts((ts) => [{ id, kind, title, sub, onClick }, ...ts].slice(0, 4));
    setTimeout(() => dismissToast(id), 5000);
  }, [dismissToast]);

  // a failed reload leaves the old data on screen, so say what happened
  useEffect(() => { if (loadError) toast('bad', "Couldn't load results", loadError); }, [loadError, toast]);

  const onSearch = useCallback((v) => { setQ(v); setPage(1); setFocus(-1); }, [setQ, setPage]);

  // re-prune filters when data loads (a shared link may name tables that are gone)
  useEffect(() => {
    if (!allTables.length) return;
    write((p) => {
      const cur = readF(p);
      const nx = prune(cur, allTables, p.get('db') || 'all');
      if (F_ORDER.some((k) => nx[k].length !== cur[k].length)) writeF(p, nx);
    });
  }, [allTables]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back/Forward (or a pasted link) can change the selected runs: load them.
  const runsKey = appliedRuns.join('|');
  const loadedRuns = useRef(runsKey);
  useEffect(() => {
    if (runsKey === loadedRuns.current) return;
    loadedRuns.current = runsKey;
    onLoadRuns(appliedRuns.length ? appliedRuns : null);
  }, [runsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFilter = (key, v) => { setF((cur) => prune({ ...cur, [key]: v }, allTables, db)); setPage(1); };
  const setDb = (next) => { setDbState(next); setF((cur) => prune(cur, allTables, next)); setPage(1); setFocus(-1); };
  const pickStatus = (k) => {
    setStatusKey((cur) => (cur === k && k !== 'ALL' ? 'ALL' : k));
    setPage(1); setFocus(-1);
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const clearAll = () => {
    write((p) => { writeF(p, EMPTY_F); ['q', 'status', 'db', 'page'].forEach((k) => p.delete(k)); }, { push: true });
  };

  // ── filtering ──
  const base = useMemo(() => {
    const s = q.toLowerCase();
    return allTables.filter((t) => {
      if (db !== 'all' && t._src !== db) return false;
      if (f.srcSchema.length && !f.srcSchema.includes(t.source_schema)) return false;
      if (f.srcTable.length && !f.srcTable.includes(t.table_name)) return false;
      if (f.tgtDb.length && !f.tgtDb.includes(t.target_database)) return false;
      if (f.tgtSchema.length && !f.tgtSchema.includes(t.target_schema)) return false;
      if (f.tgtTable.length && !f.tgtTable.includes(t.snowflake_table)) return false;
      if (f.srcCol.length || f.tgtCol.length) {
        const cols = (t.column_statistics || []).map((c) => c.column_name);
        if (f.srcCol.length && !f.srcCol.some((c) => cols.includes(c))) return false;
        if (f.tgtCol.length && !f.tgtCol.some((c) => cols.includes(c))) return false;
      }
      if (s && !t.table_name.toLowerCase().includes(s) && !t.snowflake_table.toLowerCase().includes(s) && !t.source_schema.toLowerCase().includes(s)) return false;
      return true;
    });
  }, [allTables, db, f, q]);

  const visible = useMemo(() => {
    const list = statusKey === 'ALL' ? base : base.filter((t) => tileOf(t.status) === statusKey);
    const m = sort.dir === 'asc' ? 1 : -1;
    const val = (t) => {
      switch (sort.key) {
        case 'table_name': return t.table_name.toLowerCase();
        case 'snowflake_table': return t.snowflake_table.toLowerCase();
        case 'status': return SEVERITY[t.status] ?? 9;
        case 'rows': return t._rs;
        case 'drift': return !t._hasRows ? -1 : Math.abs(t._rs - t._rt); // rows off, same number the column shows
        case 'checked': return t._t;
        default: return 0;
      }
    };
    return [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x < y) return -m;
      if (x > y) return m;
      return a.table_name.localeCompare(b.table_name);
    });
  }, [base, statusKey, sort]);

  const pages = Math.max(1, Math.ceil(visible.length / size));
  const curPage = Math.min(page, pages);
  const start = (curPage - 1) * size;
  const rows = visible.slice(start, start + size);
  const visibleKeys = useMemo(() => new Set(visible.map((t) => t._key)), [visible]);

  // ── summary ──
  const counts = useMemo(() => {
    const c = { ALL: base.length, PASSED: 0, CRITICAL: 0, FAULTY: 0, ERROR: 0, MISSING: 0 };
    base.forEach((t) => { const k = tileOf(t.status); if (k in c) c[k]++; });
    return c;
  }, [base]);
  const total = base.length;
  const pct = total ? (counts.PASSED / total) * 100 : 0;
  const failing = total - counts.PASSED;
  const health = useMemo(() => {
    const h = {};
    sources.forEach((s) => {
      const own = base.filter((t) => t._src === s);
      h[s] = own.length ? own.filter((t) => t.status === 'PASSED').length / own.length : 1;
    });
    return h;
  }, [base, sources]);
  const srcCounts = useMemo(() => {
    const c = {};
    base.forEach((t) => { c[t._src] = (c[t._src] || 0) + 1; });
    return c;
  }, [base]);
  const allSrcCounts = useMemo(() => {
    const c = {};
    allTables.forEach((t) => { c[t._src] = (c[t._src] || 0) + 1; });
    return c;
  }, [allTables]);
  const lastChecked = useMemo(() => allTables.reduce((m, t) => Math.max(m, t._t), 0), [allTables]);
  const rowsCompared = useMemo(() => base.reduce((a, t) => a + t._rs, 0), [base]);
  const worst = useMemo(() => base
    .filter((t) => t.status === 'CRITICAL' || t.status === 'ERROR')
    .sort((a, b) => Math.abs(b._rs - b._rt) - Math.abs(a._rs - a._rt)), [base]);
  const filterOptions = useMemo(() => Object.fromEntries(F_ORDER.map((k) => [k, optionsFor(k, f, allTables, db)])), [f, allTables, db]);
  const activeFilterCount = F_ORDER.reduce((a, k) => a + f[k].length, 0);
  const runActive = !!run && run.dbs.some((d) => run.codes[d] === null);

  // ── re-validation ──
  const revalidate = useCallback(async (list) => {
    const todo = list.filter((t) => canRefreshTable(t) === 'active' && !busyRef.current.has(t._key));
    if (!todo.length) {
      if (list.length) toast('info', 'Nothing to re-validate', 'Those tables are already running or have no Oracle connection.');
      return;
    }
    setBusy((b) => new Set([...b, ...todo.map((t) => t._key)]));
    if (todo.length > 1) toast('info', `Re-validating ${todo.length} tables`, 'Results stream in as each one finishes.');

    let passed = 0, failed = 0;
    const queue = [...todo];
    const one = async (t) => {
      let result = null, err = null;
      try { result = await onRevalidateTable(t); } catch (e) { err = e; }
      const ok = result?.status === 'PASSED';
      if (ok) passed++; else failed++;
      setBusy((b) => { const n = new Set(b); n.delete(t._key); return n; });
      setFlash((fl) => ({ ...fl, [t._key]: ok ? 'ok' : 'bad' }));
      setTimeout(() => setFlash((fl) => { const n = { ...fl }; delete n[t._key]; return n; }), 1700);
      if (todo.length === 1) {
        if (err) {
          toast('bad', `Couldn't validate ${t.table_name}`, cleanIssue(err.message || 'Unknown error'));
        } else if (ok) {
          toast('ok', `${t.table_name} passed`, 'Row counts, nulls and constraints all match.');
        } else {
          const issues = result?.validation_issues || [];
          toast('bad', `${t.table_name} ${(LABEL[result?.status] || result?.status || 'failed').toLowerCase()}`,
            `${cleanIssue(issues[0] || 'See details for issues.')}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}`,
            () => setOpenKey(t._key));
        }
      }
    };
    // three at a time so we don't hammer Oracle
    const worker = async () => { while (queue.length) await one(queue.shift()); };
    await Promise.all([worker(), worker(), worker()]);
    if (todo.length > 1) toast(failed ? 'bad' : 'ok', 'Re-validation finished', `${passed} passed · ${failed} still failing`);
  }, [canRefreshTable, onRevalidateTable, toast, setOpenKey]);

  const revalidateMany = (list, what) => {
    const ok = list.filter((t) => canRefreshTable(t) === 'active');
    if (!ok.length) { toast('info', 'Nothing to re-validate', 'None of these tables have an Oracle connection.'); return; }
    if (ok.length > 20 && !window.confirm(`Re-validate ${ok.length} ${what}? Each one runs live Oracle and Snowflake queries.`)) return;
    revalidate(ok);
  };

  // ── export ──
  const exportCsv = (list) => {
    if (!list.length) { toast('info', 'Nothing to export', 'No tables in the current view.'); return; }
    const head = ['source_db', 'source_schema', 'table_name', 'target_database', 'target_schema', 'snowflake_table', 'status', 'source_rows', 'snowflake_rows', 'rows_match', 'last_checked', 'issues'];
    const lines = [head.join(',')].concat(list.map((t) => [
      t._src, t.source_schema, t.table_name, t.target_database, t.target_schema, t.snowflake_table, t.status,
      t._hasRows ? t._rs : '', t._hasRows ? t._rt : '', t._hasRows ? t._match : '', t.Last_Checked, issuesOf(t).join(' | '),
    ].map(csvCell).join(',')));
    const a = document.createElement('a');
    // BOM so Excel reads UTF-8; CRLF per RFC 4180
    a.href = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `it_checks_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('ok', 'Export ready', `${fmt(list.length)} rows saved to ${a.download}`);
  };

  // ── selection ──
  const toggleSel = useCallback((key) => setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; }), []);
  const openRow = useCallback((i, key) => { setFocus(i); setOpenKey(key); }, [setOpenKey]);
  const pageAllOn = rows.length > 0 && rows.every((t) => selected.has(t._key));
  const togglePage = () => setSelected((s) => {
    const n = new Set(s);
    rows.forEach((t) => { if (pageAllOn) n.delete(t._key); else n.add(t._key); });
    return n;
  });

  // ── reload / runs ──
  const reload = () => { loadedRuns.current = ''; setAppliedRuns([]); setPendingRuns([]); onLoadRuns(null); };
  const applyRuns = () => { setPickerOpen(false); setAppliedRuns(pendingRuns); }; // the runs effect does the load
  const runLabel = (r) => (r?.load_date ? new Date(toTime(r.load_date)).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Run');
  const pickerLabel = !appliedRuns.length ? `All runs combined (${availableRuns.length})`
    : appliedRuns.length === 1 ? (() => { const r = availableRuns.find((x) => x.load_date === appliedRuns[0]); return r ? `${runLabel(r)}${r.database ? ` · ${r.database}` : ''}` : '1 run'; })()
      : `${appliedRuns.length} runs combined`;

  const startRun = () => {
    const dbs = RUN_DBS.filter((d) => runSel[d.id]).map((d) => d.id);
    if (!dbs.length) return;
    setRunModal(false);
    setRun({ id: ++runSeq.current, dbs, codes: Object.fromEntries(dbs.map((d) => [d, null])), unpublished: [], min: false });
  };
  const onJobDone = useCallback((d, code, published, stopped) => {
    setRun((r) => (r ? { ...r, stopped: r.stopped || stopped, codes: { ...r.codes, [d]: code }, unpublished: published ? r.unpublished : [...r.unpublished, d] } : r));
  }, []);
  const stopRun = async () => {
    if (!window.confirm('Stop the validation? Tables already checked stay as they are; the rest are skipped.')) return;
    setRun((r) => (r ? { ...r, stopping: true } : r));
    const live = run.dbs.filter((d) => run.codes[d] === null);
    const res = await Promise.all(live.map((d) => apiFetch(`/api/stop-it-validation?db=${encodeURIComponent(d)}`, { method: 'POST' }).catch(() => null)));
    if (res.some((x) => !x?.ok)) {
      // 404 = still connecting or already finished; let them try again
      toast('bad', "Couldn't stop validation", 'It may still be starting up. Try again in a moment.');
      setRun((r) => (r ? { ...r, stopping: false } : r));
    }
  };

  const openHistory = () => {
    setHist((h) => ({ runs: h?.runs || [], sel: null, loading: true }));
    apiJson('/api/it-runs?limit=100')
      .then((runs) => setHist((h) => (h ? { ...h, runs, loading: false } : h)))
      .catch((e) => setHist((h) => (h ? { ...h, loading: false, error: e.message || 'Could not load run history' } : h)));
  };

  // show runs started by anyone (or by us before a refresh)
  useEffect(() => {
    let alive = true;
    const poll = () => apiJson('/api/it-validation-status').then((st) => {
      if (!alive || !st) return;
      const live = Object.entries(st).filter(([, x]) => x.running).map(([d]) => d);
      if (!live.length) return;
      setRun((r) => {
        const active = r && r.dbs.some((d) => r.codes[d] === null);
        const base = active ? r : { id: ++runSeq.current, dbs: [], codes: {}, unpublished: [], min: true, watch: {}, by: {}, runIds: {} };
        const add = live.filter((d) => !(base.dbs.includes(d) && base.codes[d] === null));
        if (!add.length) return r;
        return {
          ...base,
          dbs: [...base.dbs.filter((d) => !add.includes(d)), ...add],
          codes: { ...base.codes, ...Object.fromEntries(add.map((d) => [d, null])) },
          watch: { ...base.watch, ...Object.fromEntries(add.map((d) => [d, true])) },
          by: { ...base.by, ...Object.fromEntries(add.map((d) => [d, st[d]])) },
          runIds: { ...base.runIds, ...Object.fromEntries(add.map((d) => [d, st[d].run_id])) },
        };
      });
    }).catch(() => {}); // ponytail: status is a nice-to-have; a failed poll just tries again
    poll();
    // ponytail: 5s poll is one indexed read per open tab; push it over SSE if tab count ever makes that matter
    const h = setInterval(() => { if (!document.hidden) poll(); }, 5e3);
    const onVis = () => { if (!document.hidden) poll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(h); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  // pop the dock open and tell the user once every job has finished
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !runActive && run) {
      const bad = run.dbs.filter((d) => run.codes[d] !== 0).length;
      const held = run.unpublished.filter((d) => run.codes[d] === 0).length;
      if (run.stopped) toast('info', 'Validation stopped', 'The run was cancelled before it finished.');
      else if (bad) toast('bad', 'Validation complete', `${bad} of ${run.dbs.length} run${run.dbs.length > 1 ? 's' : ''} failed — check the log.`);
      else if (held) toast('bad', 'Validation complete', 'Some pipelines failed, so the results were not published to this page — check the log.');
      else toast('ok', 'Validation complete', 'Results saved to Snowflake. Load them to update the view.');
      setRun((r) => (r ? { ...r, min: false, stopping: false } : r));
    }
    wasRunning.current = runActive;
  }, [runActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── outside clicks close popovers ──
  useEffect(() => {
    const h = (e) => {
      if (!e.target.closest('.ms')) setOpenMs(null);
      if (!e.target.closest('.picker')) setPickerOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  // ── keyboard ──
  const keyRef = useRef(null);
  keyRef.current = (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '') || !!document.activeElement?.isContentEditable;
    // Enter/space on a focused button or checkbox already activates it; don't also open a row
    const onControl = !!document.activeElement?.closest?.('button, [role="checkbox"], a');
    if (e.key === 'Escape') {
      if (typing) { document.activeElement.blur(); return; }
      if (runModal) { setRunModal(false); return; }
      if (openKey) { setOpenKey(null); return; }
      if (openMs || pickerOpen) { setOpenMs(null); setPickerOpen(false); return; }
      if (selected.size) setSelected(new Set());
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || runModal) return;
    const move = (d) => {
      e.preventDefault();
      const nf = Math.max(0, Math.min(rows.length - 1, focus + d));
      setFocus(nf);
      if (openKey && rows[nf]) setOpenKey(rows[nf]._key);
    };
    if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
    else if (e.key === 'j' || e.key === 'ArrowDown') move(1);
    else if (e.key === 'k' || e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Enter' && !onControl && rows[focus]) setOpenKey(rows[focus]._key);
    else if (e.key === 'x' && rows[focus]) toggleSel(rows[focus]._key);
    else if (e.key === 'v') {
      const t = openKey ? byKey.get(openKey) : rows[focus];
      if (t && canRun) revalidate([t]);
    } else if (e.key === 'r' && !isLoading) reload();
    else if (e.key === 'ArrowRight' && !openKey) { setPage(Math.min(pages, curPage + 1)); setFocus(-1); }
    else if (e.key === 'ArrowLeft' && !openKey) { setPage(Math.max(1, curPage - 1)); setFocus(-1); }
  };
  useEffect(() => {
    const h = (e) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // keep the focused row in view
  useEffect(() => {
    if (focus < 0) return;
    document.querySelector(`.itc tr[data-row="${focus}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focus]);

  // tick so "5m ago" stays honest
  const [, setNow] = useState(0);
  useEffect(() => { const h = setInterval(() => setNow((n) => n + 1), 60e3); return () => clearInterval(h); }, []);

  // ── table map ──
  const groups = useMemo(() => {
    const g = {};
    allTables.forEach((t) => { (g[`${t._src} · ${t.source_schema}`] ||= []).push(t); });
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [allTables]);

  const openTable = openKey ? byKey.get(openKey) : null;
  const lastOpen = useRef(null);
  if (openTable) lastOpen.current = openTable;
  const drawerTable = openTable || lastOpen.current;
  const sortTh = (key, label, cls = '') => (
    <th className={`sort ${cls}${sort.key === key ? ' sorted' : ''}${sort.key === key && sort.dir === 'desc' ? ' desc' : ''}`}
      onClick={() => { setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' })); setPage(1); }}>
      {label}<span className="arr">↑</span>
    </th>
  );

  // filter chips
  const chips = [];
  if (statusKey !== 'ALL') chips.push(['status', 'Status', TILE_NAME[statusKey]]);
  if (db !== 'all') chips.push(['db', 'Source', db]);
  F_ORDER.forEach((k) => f[k].forEach((v) => chips.push([k, F_DEFS[k].label, v])));
  if (q) chips.push(['q', 'Search', `“${q}”`]);
  const dropChip = (k, v) => {
    if (k === 'status') setStatusKey('ALL');
    else if (k === 'db') setDb('all');
    else if (k === 'q') { setQ(''); }
    else setFilter(k, f[k].filter((x) => x !== v));
    setPage(1);
  };

  const failingRefreshable = useMemo(() => base.filter((t) => t.status !== 'PASSED' && canRefreshTable(t) === 'active'), [base, canRefreshTable]);
  const selectedTables = useMemo(() => [...selected].map((k) => byKey.get(k)).filter(Boolean), [selected, byKey]);
  const sfDbs = useMemo(() => new Set(base.map((t) => t.target_database)).size, [base]);
  const sfRows = useMemo(() => base.reduce((a, t) => a + t._rt, 0), [base]);
  const pagerNums = (() => {
    if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
    const out = [1];
    const a = Math.max(2, curPage - 1), b = Math.min(pages - 1, curPage + 1);
    if (a > 2) out.push('…a');
    for (let i = a; i <= b; i++) out.push(i);
    if (b < pages - 1) out.push('…b');
    out.push(pages);
    return out;
  })();
  const colFilter = [...new Set([...f.srcCol, ...f.tgtCol])];
  // src / tgt slots fit the widest *rounded* count on the page (what's on screen), so the pair stays tight.
  // The column still reserves room for the exact pair, so hovering a row doesn't shift the table.
  const rowSlot = `${Math.max(2, ...rows.map((t) => compact(Math.max(t._rs, t._rt)).length))}ch`;
  const rowExact = `${2 * Math.max(2, ...rows.map((t) => fmt(Math.max(t._rs, t._rt)).length)) + 3}ch`;

  const runFooterDone = run && !runActive;
  const runBad = run ? run.dbs.filter((d) => run.codes[d] !== null && run.codes[d] !== 0).length : 0;

  return (
    <div className={`itc${compactRows ? ' compact' : ''}`}>
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: SPRITE }} />
      <div className="itc-bg" />

      <div className="scroll">
        {/* ── header ── */}
        <header className="topbar">
          <div className="topbar-inner">
            <div className="brand">
              <div className="brand-mark"><Ico n="shield" /></div>
              <div>
                <div className="crumbs">Data Quality Engine <Ico n="right" style={{ width: 10, height: 10 }} /> <b>Source → Snowflake</b></div>
                <h1>IT Checks</h1>
              </div>
              <span className={`live${busy.size || runActive || isLoading ? ' running' : ''}`}>
                <i /><span>{runActive ? 'Validation running' : isLoading ? 'Loading results' : busy.size ? `Validating ${busy.size} table${busy.size > 1 ? 's' : ''}` : 'Up to date'}</span>
              </span>
            </div>
            <div className="spacer" />
            <div className="actions">
              {availableRuns.length > 0 && (
                <div className="picker">
                  <button type="button" className="btn" onClick={() => { if (!pickerOpen) setPendingRuns(appliedRuns); setPickerOpen((o) => !o); }}>
                    <Ico n="clock" /><span className="lbl">{pickerLabel}</span><Ico n="down" style={{ width: 14, height: 14 }} />
                  </button>
                  {pickerOpen && (
                    <div className="pop">
                      <div className="pop-head">Validation runs</div>
                      <div className="run-list">
                        <div className={`run-item${!pendingRuns.length ? ' on' : ''}`} onClick={() => setPendingRuns([])}>
                          <Tick on={!pendingRuns.length} />
                          <div className="meta"><div className="t">All runs combined</div><div className="s">{availableRuns.length} runs merged · newest result wins</div></div>
                        </div>
                        {availableRuns.map((r, i) => {
                          const on = pendingRuns.includes(r.load_date);
                          return (
                            <div key={r.load_date || i} className={`run-item${on ? ' on' : ''}`}
                              onClick={() => setPendingRuns((p) => (p.includes(r.load_date) ? p.filter((d) => d !== r.load_date) : [...p, r.load_date]))}>
                              <Tick on={on} />
                              <div className="meta">
                                <div className="t">{runLabel(r)}{i === 0 && <em> · latest</em>}</div>
                                <div className="s">{r.database || 'Run'} · {ago(toTime(r.load_date))}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="pop-foot">
                        <span>{!pendingRuns.length ? 'All runs' : `${pendingRuns.length} run${pendingRuns.length > 1 ? 's' : ''} selected`}</span>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button type="button" className="btn sm ghost" onClick={() => setPendingRuns([])}>Reset</button>
                          <button type="button" className="btn sm primary" onClick={applyRuns}>Apply</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <button type="button" className="btn icon" onClick={reload} disabled={isLoading} data-tip="Reload results (R)" aria-label="Reload results">
                <Ico n="refresh" className={isLoading || runsLoading ? 'spin' : ''} />
              </button>
              <button type="button" className="btn icon" onClick={() => exportCsv(visible)} data-tip="Export current view (CSV)" aria-label="Export CSV">
                <Ico n="download" />
              </button>
              {canSwitch && (
                <button type="button" className="btn" onClick={onSwitch} disabled={runActive}
                  data-tip={runActive ? 'Wait for the run to finish' : undefined}>
                  <Ico n="swap" /><span className="lbl-hide">Switch check</span>
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="page">
          {/* ── hero ── */}
          <section className="stage reveal">
            {booting ? (
              <div>
                <div className="eyebrow"><span className="sk" style={{ width: 260 }} /></div>
                <h2 className="headline" aria-busy="true">
                  <span className="sk sk-h" style={{ width: '82%' }} /><br />
                  <span className="sk sk-h red" style={{ width: '64%' }} />
                </h2>
                <p className="lede">
                  {bootFailed ? <><b>Couldn&apos;t load results.</b> {loadError}</> : <><span className="sk" style={{ width: '90%' }} /><br /><span className="sk" style={{ width: '60%' }} /></>}
                </p>
                <div className="spectrum"><div className="spectrum-bar sk-bar" /></div>
                <div className="cta">
                  {bootFailed && <button type="button" className="btn primary xl" onClick={() => onLoadRuns(appliedRuns.length ? appliedRuns : null)}><Ico n="refresh" />Try again</button>}
                  {!bootFailed && canRun && <button type="button" className="btn primary xl" onClick={() => setRunModal(true)}><Ico n="play" />Run validation</button>}
                </div>
              </div>
            ) : (
            <div>
              <div className="eyebrow">
                <span>{runsMerged > 1 ? `${runsMerged} runs merged` : 'Single run'}</span>
                {oldestDate && newestDate && runsMerged > 1 && (<><span className="dotsep" /><span>{shortDate(oldestDate)} → {shortDate(newestDate)}</span></>)}
                {!(runsMerged > 1) && reportData?.report_metadata?.generated_timestamp && (<><span className="dotsep" /><span>{stamp(toTime(reportData.report_metadata.generated_timestamp))}</span></>)}
                <span className="dotsep" /><span>last validated {ago(lastChecked)}</span>
                <span className="dotsep" /><span>{compact(rowsCompared)} rows compared</span>
              </div>
              <h2 className="headline">
                <CountText n={total} /> tables watched.<br />
                <span className={`grad${pct < 80 ? ' warn' : ''}`}>
                  {!total ? 'Nothing in view.' : failing === 0 ? 'All in perfect sync.' : `${fmt(counts.PASSED)} in perfect sync.`}
                </span>
              </h2>
              <p className="lede">
                {!total ? 'Loosen a filter to bring tables back into view.'
                  : failing === 0 ? 'Every Oracle table matches Snowflake on rows, nulls, duplicates and constraints.'
                    : <><b>{fmt(failing)} table{failing > 1 ? 's' : ''}</b> need attention — {counts.CRITICAL} critical, {counts.ERROR} erroring, {counts.FAULTY} faulty and {counts.MISSING} missing or timed out.</>}
              </p>
              <Spectrum counts={counts} total={total} onPick={pickStatus} />
              <div className="cta">
                {canRun && (
                  <>
                    <button type="button" className="btn primary xl" onClick={() => (runActive ? setRun((r) => ({ ...r, min: false })) : setRunModal(true))}>
                      {runActive ? <><Ico n="refresh" className="spin" />Running…</> : <><Ico n="play" />Run validation</>}
                    </button>
                    <button type="button" className="btn xl" disabled={!failingRefreshable.length}
                      onClick={() => revalidateMany(failingRefreshable, 'failing tables')}>
                      <Ico n="refresh" /><span>{failingRefreshable.length ? `Re-validate ${fmt(failingRefreshable.length)} failing` : 'Nothing failing'}</span>
                    </button>
                  </>
                )}
                <button type="button" className="btn xl" onClick={openHistory}><Ico n="clock" />Run history</button>
              </div>
            </div>
            )}
            <FlowZone sources={sources} health={health} srcCounts={srcCounts} activeDb={db} onPickDb={setDb}
              sfSub={booting ? 'Connecting…' : `${sfDbs} database${sfDbs === 1 ? '' : 's'} · ${compact(sfRows)} rows`}>
              <Orb counts={counts} total={total} pct={pct} loading={booting} />
            </FlowZone>
          </section>

          {/* ── tiles ── */}
          <div className="tiles">
            {TILES.map((d, i) => (
              <div key={d.k} style={{ display: 'contents', '--d': `${120 + i * 60}ms` }}>
                <Tile def={d} n={counts[d.k]} total={total} active={statusKey === d.k} onClick={() => pickStatus(d.k)} loading={booting} />
              </div>
            ))}
          </div>

          {/* ── attention ── */}
          {worst.length > 0 && (
            <div className="attention reveal" style={{ '--d': '250ms' }}>
              <div className="dot"><Ico n="alert" /></div>
              <div className="txt"><b>{fmt(worst.length)} table{worst.length > 1 ? 's are' : ' is'}</b> critical or erroring. Largest drift first:</div>
              <div className="chips">
                {worst.slice(0, 4).map((t) => <button type="button" key={t._key} className="mini-chip" onClick={() => setOpenKey(t._key)}>{t.table_name}</button>)}
              </div>
              {canRun && (
                <button type="button" className="btn sm" onClick={() => revalidateMany(worst, 'critical / erroring tables')}>
                  <Ico n="refresh" />Re-validate all {fmt(worst.length)}
                </button>
              )}
            </div>
          )}

          <div className="gap" />

          {/* ── table map ── */}
          {booting && (
            <section className="card reveal" style={{ '--d': '350ms' }} aria-busy="true">
              <div className="map-head"><div><h3>Table map</h3><p>{bootFailed ? 'Nothing to show yet.' : 'Loading tables…'}</p></div></div>
              <div className="map">
                {[120, 40].map((n, gi) => (
                  <div className={`mg${gi === 0 ? ' wide' : ''}`} key={gi}>
                    <div className="mg-head"><span className="sk" style={{ width: 70 }} /><span className="sk" style={{ width: 120 }} /></div>
                    <div className="cells">{Array.from({ length: n }, (_, i) => <span key={i} className="cell sk-cell" style={{ animationDelay: `${(i % 24) * 40}ms` }} />)}</div>
                  </div>
                ))}
              </div>
            </section>
          )}
          {allTables.length > 0 && (
            <section className="card reveal" style={{ '--d': '350ms' }}>
              <div className="map-head">
                <div><h3>Table map</h3><p>Every table at a glance. Hover to peek, click to open.</p></div>
                <span className="sp" />
                <div className="legend">
                  <span><i style={{ background: 'var(--green-light)' }} />Passed</span>
                  <span><i style={{ background: 'var(--red)' }} />Critical</span>
                  <span><i style={{ background: 'var(--orange)' }} />Faulty</span>
                  <span><i style={{ background: 'var(--violet)' }} />Error</span>
                  <span><i style={{ background: 'var(--yellow)' }} />Not found</span>
                </div>
              </div>
              <TableMap groups={groups} visibleKeys={visibleKeys} busy={busy} openKey={openKey} onOpen={setOpenKey} />
            </section>
          )}

          <div className="gap" />

          {colFilter.length > 0 && <ColumnDetails tables={base} columns={colFilter} />}

          {/* ── results ── */}
          <section className="card reveal" style={{ '--d': '450ms', scrollMarginTop: 80 }} ref={resultsRef}>
            <div className="toolbar">
              <div className="search">
                <Ico n="search" />
                <SearchInput inputRef={searchRef} value={q} onSearch={onSearch} />
              </div>
              {sources.length > 1 && (
                <div className="seg-ctl">
                  <button type="button" className={db === 'all' ? 'on' : ''} onClick={() => setDb('all')}>All sources</button>
                  {sources.map((s) => <button type="button" key={s} className={db === s ? 'on' : ''} onClick={() => setDb(s)}>{s}</button>)}
                </div>
              )}
              <button type="button" className="btn" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen}>
                <Ico n="filter" />Filters{activeFilterCount > 0 && <span className="badge-count">{activeFilterCount}</span>}
              </button>
              <div className="seg-ctl">
                <button type="button" className={!compactRows ? 'on' : ''} onClick={() => setCompactRows(false)} data-tip="Comfortable" aria-label="Comfortable rows"><Ico n="rows" /></button>
                <button type="button" className={compactRows ? 'on' : ''} onClick={() => setCompactRows(true)} data-tip="Compact" aria-label="Compact rows"><Ico n="rows2" /></button>
              </div>
            </div>

            <div className={`filters${filtersOpen ? ' open' : ''}`}>
              <div>
                <div className="filters-inner">
                  {[['src', 'SOURCE', 'Oracle', 'var(--blue-soft)', 'var(--blue)', ['srcSchema', 'srcTable', 'srcCol']],
                    ['tgt', 'TARGET', 'Snowflake', 'var(--red-soft)', 'var(--red)', ['tgtDb', 'tgtSchema', 'tgtTable', 'tgtCol']]].map(([side, pill, name, bg, fg, keys], gi) => (
                    <React.Fragment key={side}>
                      {gi === 1 && <div className="flow-arrow"><Ico n="arrow" style={{ width: 22, height: 22 }} /></div>}
                      <div className="fgroup">
                        <h4>
                          <span className="pill" style={{ background: bg, color: fg }}>{pill}</span>{name}
                          {side === 'tgt' && (f.srcSchema.length > 0 || f.srcTable.length > 0) && <span className="hint-pill">Filtered by source</span>}
                        </h4>
                        <div className="fgrid">
                          {keys.map((k) => {
                            const def = F_DEFS[k];
                            const blocked = def.needs && !f[def.needs].length;
                            return (
                              <MultiSelect key={k} id={k} label={def.label} selected={f[k]}
                                options={blocked ? [] : filterOptions[k]}
                                onChange={(v) => setFilter(k, v)} disabled={blocked}
                                blockedText={blocked ? `Pick ${F_DEFS[def.needs].label.toLowerCase()} first` : ''}
                                open={openMs === k} setOpen={setOpenMs} />
                            );
                          })}
                        </div>
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </div>

            {chips.length > 0 && (
              <div className="active-chips">
                {chips.map(([k, l, v]) => (
                  <span className="chip" key={`${k}:${v}`}><em>{l}</em>{v}
                    <button type="button" onClick={() => dropChip(k, v)} aria-label={`Remove ${l} ${v}`}><Ico n="x" /></button>
                  </span>
                ))}
                <button type="button" className="chip-clear" onClick={clearAll}>Clear all</button>
              </div>
            )}

            <div className="table-wrap">
              <table className="itc-grid" style={{ '--row-slot': rowSlot, '--row-exact': rowExact }}>
                <thead>
                  <tr>
                    <th className="chk"><Tick on={pageAllOn} onClick={togglePage} label="Select page" /></th>
                    {sortTh('table_name', 'Source table')}
                    <th className="arrow-col" />
                    {sortTh('snowflake_table', 'Snowflake table')}
                    {sortTh('status', 'Status')}
                    {sortTh('rows', 'Rows (src / tgt)', 'r')}
                    {sortTh('drift', 'Row drift', 'c')}
                    {sortTh('checked', 'Last validated')}
                    <th className="r" />
                  </tr>
                </thead>
                <tbody>
                  {isLoading || booting ? Array.from({ length: 8 }, (_, i) => (
                    <tr className="skel" key={i}>{Array.from({ length: 9 }, (__, j) => <td key={j}><div /></td>)}</tr>
                  )) : rows.map((t, i) => (
                    <Row key={t._key} t={t} i={i} sel={selected.has(t._key)} focused={focus === i} flash={flash[t._key]}
                      isBusy={busy.has(t._key)} refresh={canRefreshTable(t)} srcIdx={sources.indexOf(t._src)}
                      onOpen={openRow} onToggle={toggleSel} onRevalidate={revalidate} />
                  ))}
                </tbody>
              </table>
            </div>

            {!isLoading && !booting && !visible.length && (
              <div className="empty">
                <div className="art"><Ico n="search" /></div>
                <h3>{q ? `Nothing matches “${q}”` : 'No tables in this view'}</h3>
                <p>{chips.length ? 'Try loosening a filter or clearing the search.' : 'Run a validation to populate results.'}</p>
                {chips.length > 0 && <button type="button" className="btn" onClick={clearAll}>Clear all filters</button>}
              </div>
            )}

            <div className="table-foot">
              <div>{visible.length > 0 && <>Showing <b>{fmt(start + 1)}–{fmt(Math.min(start + size, visible.length))}</b> of <b>{fmt(visible.length)}</b> tables</>}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <select className="pgsize" value={size} onChange={(e) => { setSize(+e.target.value); setPage(1); }} aria-label="Rows per page">
                  {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} / page</option>)}
                </select>
                <div className="pager">
                  <button type="button" disabled={curPage === 1} onClick={() => { setPage(curPage - 1); setFocus(-1); }} aria-label="Previous page"><Ico n="left" /></button>
                  {pagerNums.map((p) => (typeof p === 'string'
                    ? <button type="button" key={p} disabled>…</button>
                    : <button type="button" key={p} className={p === curPage ? 'on' : ''} onClick={() => { setPage(p); setFocus(-1); }}>{p}</button>))}
                  <button type="button" disabled={curPage === pages} onClick={() => { setPage(curPage + 1); setFocus(-1); }} aria-label="Next page"><Ico n="right" /></button>
                </div>
              </div>
            </div>
          </section>

          <div className="hint">
            <span><span className="kbd">/</span> search</span>
            <span><span className="kbd">J</span><span className="kbd">K</span> move</span>
            <span><span className="kbd">↵</span> open</span>
            <span><span className="kbd">X</span> select</span>
            {canRun && <span><span className="kbd">V</span> re-validate</span>}
            <span><span className="kbd">←</span><span className="kbd">→</span> page</span>
            <span><span className="kbd">Esc</span> close</span>
          </div>
        </main>
      </div>


      {/* ── bulk bar ── */}
      <div className={`bulk${selected.size ? ' show' : ''}`}>
        <span><b>{selected.size}</b> selected</span>
        {canRun && (
          <button type="button" className="btn sm primary" onClick={() => { const list = selectedTables; setSelected(new Set()); revalidateMany(list, 'selected tables'); }}>
            <Ico n="refresh" /><span className="lbl-hide">Re-validate</span>
          </button>
        )}
        <button type="button" className="btn sm" onClick={() => exportCsv(selectedTables)}><Ico n="download" /><span className="lbl-hide">Export</span></button>
        <button type="button" className="btn sm icon" onClick={() => setSelected(new Set())} aria-label="Clear selection"><Ico n="x" /></button>
      </div>

      {/* ── drawer ── */}
      <div className={`scrim${openTable || runModal || hist ? ' show' : ''}`} onClick={() => { setOpenKey(null); setRunModal(false); setHist(null); }} />
      <aside className={`drawer${openTable ? ' show' : ''}`} aria-hidden={!openTable} inert={!openTable}>
        {drawerTable && (
          <Drawer t={drawerTable} tab={tab} setTab={setTab} busy={busy.has(drawerTable._key)} canRefresh={canRefreshTable(drawerTable)}
            onClose={() => setOpenKey(null)} onRevalidate={revalidate}
            onCopy={(name) => {
              // clipboard API is missing on plain http and can be denied; don't claim success then
              Promise.resolve(navigator.clipboard ? navigator.clipboard.writeText(name) : Promise.reject())
                .then(() => toast('info', 'Copied', name), () => toast('bad', "Couldn't copy", name));
            }} />
        )}
      </aside>

      {/* ── run modal ── */}
      <div className="modal-wrap">
        <div className={`modal${runModal ? ' show' : ''}`} role="dialog" aria-modal="true" aria-hidden={!runModal} inert={!runModal}>
          <div className="modal-head">
            <div className="brand-mark" style={{ width: 40, height: 40 }}><Ico n="play" /></div>
            <div style={{ flex: 1 }}><h3>Run IT validation</h3><p>Compare Oracle sources against Snowflake. Runs in the background — keep working.</p></div>
            <button type="button" className="btn sm icon ghost" onClick={() => setRunModal(false)} aria-label="Close"><Ico n="x" /></button>
          </div>
          <div className="modal-body">
            {RUN_DBS.map((d, i) => (
              <button type="button" key={d.id} className={`dbopt${runSel[d.id] ? ' on' : ''}`} onClick={() => setRunSel((s) => ({ ...s, [d.id]: !s[d.id] }))}>
                <div className={`db c${i}`}>{abbr(d.label)}</div>
                <div className="tx"><b>{d.label}</b><span>Oracle → Snowflake{allSrcCounts[d.label] ? ` · ${fmt(allSrcCounts[d.label])} tables last run` : ''}</span></div>
                <Tick on={runSel[d.id]} />
              </button>
            ))}
            <div className="modal-note">
              <Ico n="swap" />Selecting both runs them in parallel.
              <span style={{ flex: 1 }} />
              <button type="button" className="btn sm ghost" onClick={() => setRunSel((s) => { const all = s.insight7 && s.rimdocs; return { insight7: !all, rimdocs: !all }; })}>
                {runSel.insight7 && runSel.rimdocs ? 'Clear' : 'Select both'}
              </button>
            </div>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn" onClick={() => setRunModal(false)}>Cancel</button>
            <button type="button" className="btn primary" disabled={!runSel.insight7 && !runSel.rimdocs} onClick={startRun}>
              <Ico n="play" />{runSel.insight7 && runSel.rimdocs ? 'Start both in parallel' : 'Start validation'}
            </button>
          </div>
        </div>
      </div>

      {/* ── run history ── */}
      <div className="modal-wrap">
        <div className={`modal wide${hist ? ' show' : ''}`} role="dialog" aria-modal="true" aria-hidden={!hist} inert={!hist}>
          <div className="modal-head">
            {hist?.sel && <button type="button" className="btn sm icon ghost" onClick={() => setHist((h) => ({ ...h, sel: null }))} aria-label="Back to all runs"><Ico n="left" /></button>}
            <div style={{ flex: 1 }}>
              <h3>{hist?.sel ? `${RUN_DBS.find((x) => x.id === hist.sel.db)?.label || hist.sel.db} run log` : 'Run history'}</h3>
              <p>{hist?.sel ? `Started by ${cleanName(hist.sel.started_by)}${hist.sel.started_by_email ? ` (${hist.sel.started_by_email})` : ''} · ${runStamp(hist.sel.started_at)}${hist.sel.finished_at ? ` → ${runStamp(hist.sel.finished_at)}` : ''} · ${hist.sel.host}` : 'Every IT validation run, from any server. Click one to see its log.'}</p>
            </div>
            {hist?.sel ? (
              <button type="button" className="btn sm" onClick={() => downloadFile(`/api/it-runs/${hist.sel.id}/log.txt`, 'it_validation_log.txt').catch(() => toast('bad', "Couldn't download log"))}>
                <Ico n="download" />Download
              </button>
            ) : (
              <button type="button" className="btn sm icon ghost" onClick={openHistory} aria-label="Refresh"><Ico n="refresh" className={hist?.loading ? 'spin' : ''} /></button>
            )}
            <button type="button" className="btn sm icon ghost" onClick={() => setHist(null)} aria-label="Close"><Ico n="x" /></button>
          </div>
          <div className="modal-body hist">
            {hist?.sel ? (
              <RunJob key={hist.sel.id} db={hist.sel.db} runId={hist.sel.id} watch openLog onDone={() => {}} />
            ) : hist?.error ? (
              <p className="bad-t">{hist.error}</p>
            ) : !hist?.runs.length ? (
              <p style={{ color: 'var(--ink-3)' }}>{hist?.loading ? 'Loading…' : 'No runs yet.'}</p>
            ) : (
              <table className="hist-t">
                <colgroup><col style={{ width: '12%' }} /><col style={{ width: '17%' }} /><col /><col style={{ width: '15%' }} /><col style={{ width: '15%' }} /><col style={{ width: '10%' }} /></colgroup>
                <thead><tr><th>Database</th><th>Status</th><th>Started by</th><th>Started</th><th>Finished</th><th className="r">Duration</th></tr></thead>
                <tbody>
                  {hist.runs.map((h) => (
                    <tr key={h.id} tabIndex={0} onClick={() => setHist((x) => ({ ...x, sel: h }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') setHist((x) => ({ ...x, sel: h })); }}>
                      <td>{RUN_DBS.find((x) => x.id === h.db)?.label || h.db}</td>
                      <td>
                        <span className={`hs ${h.status}`}>{h.status}</span>
                        {h.status === 'stopped' && h.stop_requested_by && cleanName(h.stop_requested_by) !== cleanName(h.started_by) && <small>by {cleanName(h.stop_requested_by)}</small>}
                      </td>
                      <td>
                        <div className="who">{cleanName(h.started_by)}</div>
                        {h.started_by_email && <small>{h.started_by_email}</small>}
                      </td>
                      <td className="nw">{runStamp(h.started_at)}</td>
                      <td className="nw">{h.finished_at ? runStamp(h.finished_at) : <span className="muted-t">Running…</span>}</td>
                      <td className="r nw">{dur(h.seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* ── run dock ── */}
      {run && (
        <div className={`dock${run.min ? ' min' : ''}${run.full && !run.min ? ' full' : ''}`}>
          <div className="dock-head" onClick={() => setRun((r) => ({ ...r, min: !r.min }))}>
            <div className={`brand-mark ${runActive ? 'run' : runBad ? 'bad' : 'ok'}`}>
              <Ico n={runActive ? 'refresh' : runBad ? 'alert' : 'check'} className={runActive ? 'spin' : ''} />
            </div>
            <div className="tx">
              <b>{runActive ? (run.stopping ? 'Stopping validation…' : 'Validation running') : run.stopped ? 'Validation stopped' : runBad ? 'Validation finished with errors' : 'Validation complete'}</b>
              <span>{run.dbs.map((d) => RUN_DBS.find((x) => x.id === d)?.label).join(' & ')}{run.dbs.length > 1 ? ' · parallel' : ''}
                {(() => { const b = run.dbs.map((d) => run.by?.[d]).find(Boolean); return b ? ` · started by ${cleanName(b.started_by)} at ${new Date(b.started_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''; })()}
              </span>
            </div>
            {!run.min && (
              <button type="button" className="btn sm icon ghost" aria-label={run.full ? 'Exit full screen' : 'Full screen'}
                onClick={(e) => { e.stopPropagation(); setRun((r) => ({ ...r, full: !r.full })); }}>
                <Ico n={run.full ? 'shrink' : 'expand'} />
              </button>
            )}
            <button type="button" className="btn sm icon ghost" aria-label={run.min ? 'Expand' : 'Minimise'}
              onClick={(e) => { e.stopPropagation(); setRun((r) => ({ ...r, min: !r.min })); }}>
              <Ico n={run.min ? 'down' : 'min'} style={run.min ? { transform: 'rotate(180deg)' } : undefined} />
            </button>
          </div>
          <div className="dock-body"><div>
            <div className="jobs">{run.dbs.map((d) => <RunJob key={`${run.id}-${d}`} db={d} runId={run.runIds?.[d]} watch={!!run.watch?.[d]} onDone={onJobDone} />)}</div>
            <div className="dock-foot">
              {runFooterDone ? (
                <>
                  <button type="button" className="btn sm" onClick={() => setRun(null)}>Dismiss</button>
                  <button type="button" className="btn sm primary" onClick={() => { setRun(null); reload(); }}><Ico n="refresh" />Load new results</button>
                </>
              ) : (
                <>
                  {canRun && (
                    <button type="button" className="btn sm stop" disabled={run.stopping} onClick={stopRun}>
                      <Ico n="stop" />{run.stopping ? 'Stopping…' : 'Stop validation'}
                    </button>
                  )}
                  <button type="button" className="btn sm" onClick={() => setRun((r) => ({ ...r, min: true, full: false }))}>Run in background</button>
                </>
              )}
            </div>
          </div></div>
        </div>
      )}

      {/* ── toasts ── */}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}${t.onClick ? ' click' : ''}`} onClick={() => { if (t.onClick) { t.onClick(); dismissToast(t.id); } }}>
            <span className="ic"><Ico n={t.kind === 'ok' ? 'checkc' : t.kind === 'bad' ? 'xc' : 'clock'} /></span>
            <div className="tx"><b>{t.title}</b>{t.sub && <span>{t.sub}</span>}</div>
            <button type="button" className="btn sm icon ghost" onClick={(e) => { e.stopPropagation(); dismissToast(t.id); }} aria-label="Dismiss"><Ico n="x" /></button>
            <span className="life" />
          </div>
        ))}
      </div>
    </div>
  );
}

function CountText({ n }) {
  return <>{useCountUp(n)}</>;
}

function Spectrum({ counts, total, onPick }) {
  const mounted = useMounted();
  return (
    <div className="spectrum">
      <div className="spectrum-bar">
        {SPECTRUM.map((k) => (
          <button type="button" key={k} title={`${TILE_NAME[k]}: ${counts[k]}`} onClick={() => onPick(k)}
            style={{ width: mounted && total ? `${(counts[k] / total) * 100}%` : 0, background: k === 'PASSED' ? 'linear-gradient(90deg,var(--green),var(--green-light))' : COLOR[k] }} />
        ))}
      </div>
      <div className="spectrum-legend">
        {SPECTRUM.filter((k) => counts[k]).map((k) => (
          <button type="button" key={k} onClick={() => onPick(k)}><i style={{ background: COLOR[k] }} />{TILE_NAME[k]} <b>{fmt(counts[k])}</b></button>
        ))}
      </div>
    </div>
  );
}

const Row = React.memo(function Row({ t, i, sel, focused, flash, isBusy, refresh, srcIdx, onOpen, onToggle, onRevalidate }) {
  const diff = t._rs - t._rt;
  const ok = t._match;
  const meter = Math.min(100, Math.max(4, (t._rs ? Math.abs(diff) / t._rs : 1) * 400));
  return (
    <tr data-row={i}
      className={`enter${sel ? ' sel' : ''}${focused ? ' focus' : ''}${flash ? ` flash-${flash}` : ''}`}
      style={{ animationDelay: `${Math.min(i, 14) * 18}ms` }}
      onClick={(e) => { if (e.target.closest('.check, .iconbtn')) return; onOpen(i, t._key); }}>
      <td className="chk"><Tick on={sel} onClick={() => onToggle(t._key)} label={`Select ${t.table_name}`} /></td>
      <td><div className="tname"><span className={`db c${srcIdx % 3}`}>{abbr(t._src)}</span>
        <div><b title={t.table_name}>{t.table_name}</b><small>{t.source_schema}</small></div></div></td>
      <td className="arrow-col"><Ico n="arrow" /></td>
      <td><div className="tname"><div><b title={t.snowflake_table}>{t.snowflake_table}</b><small>{t.target_database}.{t.target_schema}</small></div></div></td>
      <td><Status s={isBusy ? 'RUNNING' : t.status} /></td>
      <td className="r rows"><div className="pair"><span className="src">{t._hasRows ? <Num v={t._rs} /> : '—'}</span><span className="sep">/</span><span className="tgt">{t._hasRows ? <Num v={t._rt} /> : '—'}</span></div></td>
      <td className="r">{t._hasRows ? (
        <div className={`drift ${ok ? 'ok' : 'bad'}`}><span className="meter"><i style={{ width: `${ok ? 100 : meter}%` }} /></span>
          <b>{ok ? 'exact' : diff === 0 ? 'mismatch' : <>{diff > 0 ? '−' : '+'}<Num v={Math.abs(diff)} /></>}</b></div>
      ) : <span className="muted">—</span>}</td>
      <td><div className="when">{ago(t._t)}<small>{stamp(t._t)}</small></div></td>
      <td className="r">
        <div className={`row-acts${isBusy ? ' busy' : ''}`}>
          {refresh !== 'hidden' && (
            <button type="button" className="iconbtn go" disabled={isBusy || refresh !== 'active'} onClick={() => onRevalidate([t])}
              data-tip={refresh === 'no-connection' ? 'No Oracle connection' : isBusy ? 'Validating…' : 'Re-validate (V)'} aria-label="Re-validate">
              <Ico n="refresh" className={isBusy ? 'spin' : ''} />
            </button>
          )}
          <button type="button" className="iconbtn" onClick={() => onOpen(i, t._key)} data-tip="Details (↵)" aria-label="Details">
            <Ico n="grid" />
          </button>
        </div>
      </td>
    </tr>
  );
});

// Map + its hover tooltip live in their own component so hovering cells
// doesn't re-render the whole page.
const TableMap = React.memo(function TableMap({ groups, visibleKeys, busy, openKey, onOpen }) {
  const [tip, setTip] = useState(null);
  const showTip = (e, t) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.max(120, Math.min(window.innerWidth - 120, r.left + r.width / 2));
    const below = r.top < 140;
    setTip({ t, x, y: below ? r.bottom + 10 : r.top - 10, below });
  };
  let n = 0;
  return (
    <>
      <div className="map">
        {groups.map(([name, list]) => {
          // status counts for the header bar
          const bands = {};
          list.forEach((t) => { (bands[t.status] ||= []).push(t); });
          const order = Object.keys(bands).sort((a, b) => (SEVERITY[a] ?? 9) - (SEVERITY[b] ?? 9));
          const ok = bands.PASSED?.length || 0;
          const pct = Math.round((ok / list.length) * 100);
          const tone = pct === 100 ? 'ok' : pct >= 85 ? 'mid' : 'bad';
          const [src, schema] = name.split(' · ');
          return (
            <div className={`mg${list.length > 48 ? ' wide' : ''}`} key={name}>
              <div className="mg-head">
                <span className="mg-src">{src}</span>
                <b className="mg-name" title={schema}>{schema}</b>
                <span className="mg-bar">
                  {order.map((st) => <i key={st} style={{ width: `${(bands[st].length / list.length) * 100}%`, background: CELL[st] || 'var(--line-2)' }} />)}
                </span>
                <span className="sp" />
                <span className="mg-count">{fmt(ok)} / {fmt(list.length)} passed</span>
                <span className={`mg-pct ${tone}`}>{pct}%</span>
              </div>
              <div className="cells">
                {list.map((t) => ( // report order, unsorted, so it reads like a heat map
                  <button type="button" key={t._key} aria-label={`${t.table_name}: ${LABEL[t.status] || t.status}`}
                    className={`cell${visibleKeys.has(t._key) ? '' : ' dim'}${busy.has(t._key) ? ' busy' : ''}${openKey === t._key ? ' hot' : ''}`}
                    style={{ '--cc': CELL[t.status] || 'var(--line-2)', animationDelay: `${Math.min(1400, 400 + (n++) * 4)}ms` }}
                    onClick={() => onOpen(t._key)}
                    onMouseEnter={(e) => showTip(e, t)} onMouseLeave={() => setTip(null)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {tip && (
        <div className="tip" style={{ left: tip.x, top: tip.y, transform: `translate(-50%, ${tip.below ? '0' : '-100%'})` }}>
          <b>{tip.t.table_name}</b>
          <Status s={busy.has(tip.t._key) ? 'RUNNING' : tip.t.status} />
          <div className="r"><span>Source rows</span><span>{tip.t._hasRows ? fmt(tip.t._rs) : '—'}</span></div>
          <div className="r"><span>Snowflake rows</span><span>{tip.t._hasRows ? fmt(tip.t._rt) : '—'}</span></div>
          <div className="r"><span>Checked</span><span>{ago(tip.t._t)}</span></div>
        </div>
      )}
    </>
  );
});

// Typing stays local; the page only re-filters once you pause.
function SearchInput({ inputRef, value, onSearch }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]); // cleared from a chip / "Clear all"
  useEffect(() => {
    if (v.trim() === value) return undefined;
    const h = setTimeout(() => onSearch(v.trim()), 200);
    return () => clearTimeout(h);
  }, [v]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <input ref={inputRef} value={v} onChange={(e) => setV(e.target.value)} placeholder="Search source or Snowflake tables…" autoComplete="off" />
      {v
        ? <button type="button" className="btn sm icon ghost clear" onClick={() => { setV(''); onSearch(''); inputRef.current?.focus(); }} aria-label="Clear search"><Ico n="x" /></button>
        : <span className="kbd">/</span>}
    </>
  );
}