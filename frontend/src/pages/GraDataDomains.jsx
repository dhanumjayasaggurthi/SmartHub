import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import LoadingSpinner from './components/LoadingSpinner';
import { apiFetch } from '../utils/apiClient';
import { useDirectoryPhotos } from '../hooks/useDirectoryPhotos';
import { useAdGroupMembers } from '../hooks/useAdGroupMembers';
import { useRBAC } from '../context/RBACContext';
import { usePerfTier, measureTier } from '../utils/perfTier';

/* ========================================================================
 * MODEL — normalizes whatever SELECT * returns into one shape
 * ======================================================================== */

const KNOWN_COLUMNS = ['DOMAIN', 'DOMAIN_SPONSORS', 'DATA_STEWARD', 'DATA_DOMAIN_OWNER', 'DATA_PACKAGE_LABEL', 'DATA_PACKAGE_URL'];

// 24x24 stroke-drawn glyphs, one per domain. Keys are normalized (lowercase,
// non-alphanumerics stripped) so "IND/CTA" and "IND CTA" both resolve.
const ICON_PATHS = {
  indcta: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4',
  cmc: 'M9 3v7.2L4.7 18a2 2 0 0 0 1.7 3h11.2a2 2 0 0 0 1.7-3L15 10.2V3M8 3h8M7.4 14h9.2',
  labeling: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8ZM7.5 7.5h.01',
  registrations: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M8.5 11.5l3 3L22 4',
  regulatoryresponsesafety: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10ZM12 8.5v4M12 16.2h.01',
  regulatorystrategyplanning:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 11.4a.6.6 0 1 0 0 1.2.6.6 0 0 0 0-1.2Z',
};

const FALLBACK_ICON =
  'M12 3c4.4 0 8 1.1 8 2.5S16.4 8 12 8 4 6.9 4 5.5 7.6 3 12 3ZM4 5.5v13C4 19.9 7.6 21 12 21s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5';

const iconFor = (domain) =>
  ICON_PATHS[String(domain || '').toLowerCase().replace(/[^a-z0-9]/g, '')] || FALLBACK_ICON;

const initials = (name) =>
  String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

const blank = (v) => v === null || v === undefined || String(v).trim() === '';

// A cell may hold a name, an email, or "Name <email>". Sponsors may hold
// several separated by ; , or |.
function toPerson(raw) {
  if (blank(raw)) return null;
  const s = String(raw).trim();
  const bracket = s.match(/^(.*?)[<(]\s*([^>)\s]+@[^>)\s]+)\s*[>)]$/);
  if (bracket) return { name: bracket[1].trim() || bracket[2], email: bracket[2] };
  if (s.includes('@')) return { name: s.split('@')[0].replace(/[._]/g, ' '), email: s };
  return { name: s, email: null };
}

function toPeople(raw) {
  if (blank(raw)) return [];
  return String(raw).split(/[;,|]/).map(toPerson).filter(Boolean);
}

const PACKAGE_LABEL = 'Data package';

/* Usage columns are one per month — MARCH_2026, APRIL_2026 and so on — so they
 * get picked up by shape instead of being listed, and a new month appearing in
 * the table shows up here on its own. */
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY',
  'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

function monthColumns(columns) {
  return columns
    .map((c, i) => {
      const m = String(c).match(/^([A-Z]+)_(\d{4})$/i);
      if (!m) return null;
      const mi = MONTHS.indexOf(m[1].toUpperCase());
      if (mi < 0) return null;
      const name = m[1][0] + m[1].slice(1).toLowerCase();
      return { index: i, label: `${name}-${m[2]}`, sort: Number(m[2]) * 12 + mi };
    })
    .filter(Boolean)
    .sort((a, b) => a.sort - b.sort);
}

const toCount = (v) => {
  if (blank(v)) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

function buildDomainRecord(domain, count, columns = [], rows = []) {
  const idx = (name) => columns.indexOf(name);
  const iSponsor = idx('DOMAIN_SPONSORS');
  const iSteward = idx('DATA_STEWARD');
  const iOwner = idx('DATA_DOMAIN_OWNER');
  const iPackageLabel = idx('DATA_PACKAGE_LABEL');
  const iPackageUrl = idx('DATA_PACKAGE_URL');

  const sponsors = [];
  const seen = new Set();
  let owner = null;
  let steward = null;
  let packages = [];
  const packageSeen = new Set();

  const iAdGroup = idx('AD_GROUPS');
  const iAccount = idx('USERS_AND_SERVICE_ACCOUNTS');
  const iQuestion = idx('QUESTION');
  const iAnswer = idx('ANSWER');
  const months = monthColumns(columns);
  const adGroups = [];
  const adSeen = new Set();
  const usage = [];
  const usageSeen = new Set();
  const faqs = [];
  const faqSeen = new Set();

  rows.forEach((r, i) => {
    if (iAdGroup > -1 && !blank(r[iAdGroup])) {
      String(r[iAdGroup]).split(/[\n;,|]+/).forEach((g) => {
        const name = g.trim();
        if (name && !adSeen.has(name.toLowerCase())) {
          adSeen.add(name.toLowerCase());
          adGroups.push(name);
        }
      });
    }
    /* One cell holds every account, comma separated, and each month cell
     * holds that month's counts in the same order. So position is the join —
     * the third account goes with the third number in every month. */
    if (iAccount > -1 && !blank(r[iAccount])) {
      const accounts = String(r[iAccount]).split(',').map((a) => a.trim()).filter(Boolean);
      const perMonth = months.map((m) =>
        blank(r[m.index]) ? [] : String(r[m.index]).split(',').map((c) => toCount(c))
      );

      accounts.forEach((account, slot) => {
        const key = account.toLowerCase();
        if (usageSeen.has(key)) return;
        usageSeen.add(key);
        usage.push({
          account,
          counts: perMonth.map((vals) => (slot < vals.length ? vals[slot] : null)),
        });
      });
    }
  });

  rows.forEach((r, i) => {
    if (iOwner > -1 && !owner) owner = toPerson(r[iOwner]);
    if (iSteward > -1 && !steward) steward = toPerson(r[iSteward]);
    if (iSponsor > -1) {
      toPeople(r[iSponsor]).forEach((p) => {
        const key = (p.email || p.name).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          sponsors.push(p);
        }
      });
    }
    const label = iPackageLabel > -1 && !blank(r[iPackageLabel]) ? String(r[iPackageLabel]).trim() : '';
    const url = iPackageUrl > -1 && !blank(r[iPackageUrl]) ? String(r[iPackageUrl]).trim() : '';
    if (label || url) {
      const key = `${label.toLowerCase()}|${url.toLowerCase()}`;
      if (!packageSeen.has(key)) {
        packageSeen.add(key);
        packages.push({ name: label, url, rowIndex: i });
      }
    }
    if (iQuestion > -1 && !blank(r[iQuestion])) {
      const question = String(r[iQuestion]).trim();
      const answer = iAnswer > -1 && !blank(r[iAnswer]) ? String(r[iAnswer]).trim() : '';
      const key = question.toLowerCase();
      if (question && !faqSeen.has(key)) {
        faqSeen.add(key);
        faqs.push({ question, answer });
      }
    }
  });

  return {
    domain,
    count: count ?? rows.length,
    owner,
    steward,
    sponsors,
    packages,
    packageColumns: iPackageLabel > -1 || iPackageUrl > -1
      ? { label: iPackageLabel > -1 ? columns[iPackageLabel] : null, url: iPackageUrl > -1 ? columns[iPackageUrl] : null }
      : null,
    adGroups,
    months,
    usage,
    faqs,
    columns,
    rows,
    loaded: rows.length > 0,
  };
}

function csvFor(records, columns) {
  const cols = columns && columns.length ? columns : KNOWN_COLUMNS;
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  records.forEach((rec) => rec.rows.forEach((r) => lines.push(r.map(esc).join(','))));
  return lines.join('\n');
}

function downloadCsv(filename, csv) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/* ========================================================================
 * SEARCH — everything on the page is already in memory, so the box searches
 * all of it instead of just the four contact columns it used to.
 * ======================================================================== */

/* "cmc owner" is two terms and both must hit; "data steward" in quotes is one
 * phrase. Leading - drops a record that matches. Same rules people expect from
 * a search box, no more. */
function parseQuery(raw) {
  const terms = [];
  const re = /(-?)"([^"]+)"|(-?)(\S+)/g;
  let m;
  while ((m = re.exec(raw || '')) !== null) {
    const text = (m[2] !== undefined ? m[2] : m[4] || '').trim().toLowerCase();
    if (!text) continue;
    terms.push({ text, negate: (m[2] !== undefined ? m[1] : m[3]) === '-' });
  }
  return terms;
}

const COLUMN_LABELS = {
  DOMAIN: 'Domain',
  DOMAIN_SPONSORS: 'Sponsor',
  DATA_STEWARD: 'Steward',
  DATA_DOMAIN_OWNER: 'Owner',
  DATA_PACKAGE_LABEL: 'Package',
  DATA_PACKAGE_URL: 'Package link',
  AD_GROUPS: 'AD group',
  USERS_AND_SERVICE_ACCOUNTS: 'Account',
  QUESTION: 'FAQ question',
  ANSWER: 'FAQ answer',
};

const prettyColumn = (c) =>
  COLUMN_LABELS[c] || String(c || '').replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

/* Flattens a record into labelled snippets — one per person, package, group,
 * account, FAQ, and every non-empty raw cell. Cached on the record object
 * because records are rebuilt (not mutated) whenever the data changes. */
const fieldCache = new WeakMap();

function searchFields(rec) {
  const cached = fieldCache.get(rec);
  if (cached) return cached;

  const out = [];
  const push = (label, text, extra) => {
    if (blank(text)) return;
    out.push({ label, text: String(text), lower: String(text).toLowerCase(), ...extra });
  };
  const person = (label, p) => p && push(label, p.email ? `${p.name} <${p.email}>` : p.name);

  push('Domain', rec.domain, { tab: 'people' });
  person('Owner', rec.owner);
  person('Steward', rec.steward);
  rec.sponsors.forEach((s) => person('Sponsor', s));
  rec.packages.forEach((p) => push('Package', [p.name, p.url].filter(Boolean).join(' — '), { tab: 'records' }));
  rec.adGroups.forEach((g) => push('AD group', g));
  rec.usage.forEach((u) => push('Account', u.account));
  rec.faqs.forEach((f) => {
    push('FAQ', f.question);
    push('FAQ answer', f.answer);
  });

  // The raw grid too, so a value nobody modelled is still findable.
  rec.rows.forEach((row, i) => {
    row.forEach((v, j) => {
      if (blank(v)) return;
      push(prettyColumn(rec.columns[j]), v, { tab: 'records', rowIndex: i, column: rec.columns[j] });
    });
  });

  // Same value under the same label twice is noise in the dropdown.
  const seen = new Set();
  const deduped = out.filter((f) => {
    const key = `${f.label}|${f.lower}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  fieldCache.set(rec, deduped);
  return deduped;
}

/* A hit early in a short field beats a hit buried in a wall of text, and the
 * domain name outranks everything — that's the whole ranking. */
function scoreField(field, term) {
  const at = field.lower.indexOf(term);
  if (at < 0) return 0;
  let s = 40 - Math.min(at, 30);
  if (field.lower === term) s += 60;
  else if (at === 0 || /\W/.test(field.lower[at - 1] || ' ')) s += 20;
  if (field.label === 'Domain') s += 50;
  return s;
}

function matchRecord(rec, terms) {
  if (!terms.length) return { ok: true, score: 0, hits: [] };
  const fields = searchFields(rec);

  for (const t of terms) {
    if (!t.negate) continue;
    if (fields.some((f) => f.lower.includes(t.text))) return { ok: false, score: 0, hits: [] };
  }

  const wanted = terms.filter((t) => !t.negate);
  const hits = [];
  let score = 0;

  for (const t of wanted) {
    let best = null;
    let bestScore = 0;
    for (const f of fields) {
      const s = scoreField(f, t.text);
      if (s > bestScore) {
        bestScore = s;
        best = f;
      }
    }
    if (!best) return { ok: false, score: 0, hits: [] };
    score += bestScore;
    if (!hits.some((h) => h.field === best)) hits.push({ field: best, term: t.text });
  }

  return { ok: true, score, hits };
}

function searchRecords(records, raw) {
  const terms = parseQuery(raw);
  if (!terms.length) return { terms, results: records.map((rec) => ({ rec, score: 0, hits: [] })) };
  const results = [];
  records.forEach((rec) => {
    const m = matchRecord(rec, terms);
    if (m.ok) results.push({ rec, score: m.score, hits: m.hits });
  });
  results.sort((a, b) => b.score - a.score || a.rec.domain.localeCompare(b.rec.domain));
  return { terms, results };
}

const rowMatches = (row, columns, terms) => {
  if (!terms.length) return true;
  const text = row.map((v) => (blank(v) ? '' : String(v))).join(' \u0000 ').toLowerCase();
  return terms.every((t) => (t.negate ? !text.includes(t.text) : text.includes(t.text)));
};

/* Splits text on the matched terms so the parts can be wrapped in <mark>. */
function highlight(text, terms) {
  const words = terms.filter((t) => !t.negate).map((t) => t.text).filter(Boolean);
  if (!words.length) return [{ text, hit: false }];
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
  const parts = [];
  const re = new RegExp(`(${escaped.join('|')})`, 'ig');
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), hit: false });
    parts.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
    if (m[0] === '') re.lastIndex++;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts;
}

function Highlight({ text, terms }) {
  if (!terms || !terms.length) return <>{text}</>;
  return (
    <>
      {highlight(text, terms).map((p, i) =>
        p.hit ? (
          <mark key={i} style={{ background: 'rgba(235,23,0,.14)', color: 'inherit', borderRadius: 3, padding: '0 1px' }}>
            {p.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        )
      )}
    </>
  );
}

/* Long cells get trimmed around the match so the snippet actually shows it. */
function snippet(text, terms, pad = 46) {
  const words = terms.filter((t) => !t.negate).map((t) => t.text);
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i > -1 && (at < 0 || i < at)) at = i;
  }
  if (text.length <= pad * 2) return text;
  if (at < 0) return `${text.slice(0, pad * 2)}…`;
  const start = Math.max(0, at - pad);
  const end = Math.min(text.length, at + pad);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/* ========================================================================
 * SEARCH RESULTS — the dropdown under the box
 * ======================================================================== */

/* Every field that matched, best first, so the panel can show why a domain
 * came back rather than just that it did. */
function fieldHits(rec, terms, limit = 4) {
  const scored = [];
  searchFields(rec).forEach((f) => {
    let best = 0;
    terms.forEach((t) => {
      if (t.negate) return;
      best = Math.max(best, scoreField(f, t.text));
    });
    if (best) scored.push({ field: f, score: best });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.field);
}

function SearchPanel({ results, terms, activeIndex, onHover, onPick, onClose }) {
  const shown = results.slice(0, 8);
  const total = results.length;

  return (
    <div
      className="absolute left-0 right-0 top-[calc(100%+7px)] z-50 bg-white border border-jj-gray-02 rounded-[14px] overflow-hidden"
      style={{ boxShadow: '0 18px 40px -18px rgba(49,44,42,.45)', animation: `sp-fade .16s ${EASE} both`, width: 420, maxWidth: '92vw', right: 'auto' }}
    >
      <div
        className="flex items-center gap-2 text-[10.5px] font-johnson-text uppercase tracking-[.12em] text-jj-gray-05"
        style={{ padding: '9px 14px', borderBottom: '1px solid #f2efec', background: '#fcfbfa' }}
      >
        <span>{total ? `${total} domain${total === 1 ? '' : 's'}` : 'No matches'}</span>
        <button
          onClick={onClose}
          className="ml-auto border-0 bg-transparent text-jj-gray-05 hover:text-jj-gray-08 text-[10.5px] uppercase tracking-[.12em]"
        >
          Esc
        </button>
      </div>

      <div className="overflow-y-auto" style={{ maxHeight: 380 }}>
        {shown.map(({ rec }, i) => {
          const hits = fieldHits(rec, terms);
          const active = i === activeIndex;
          return (
            <div
              key={rec.domain}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(rec, hits[0])}
              className="cursor-pointer flex gap-2.5"
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid #f6f4f2',
                background: active ? '#f9f7f5' : 'transparent',
                borderLeft: `3px solid ${active ? ACCENT : 'transparent'}`,
              }}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" className="flex-shrink-0 mt-[3px]" fill="none" stroke={active ? ACCENT : '#a39992'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d={iconFor(rec.domain)} />
              </svg>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-johnson-text font-medium text-jj-gray-08 truncate">
                  <Highlight text={rec.domain} terms={terms} />
                </div>
                {hits.map((f, k) => (
                  <div key={k} className="text-[11.5px] font-johnson-text text-jj-gray-06 mt-[3px] flex gap-1.5 min-w-0">
                    <span className="flex-shrink-0 text-jj-gray-05 uppercase tracking-[.08em] text-[9.5px] mt-[2px]">{f.label}</span>
                    <span className="truncate">
                      <Highlight text={snippet(f.text, terms)} terms={terms} />
                    </span>
                  </div>
                ))}
              </div>
              <span className="flex-shrink-0 self-start text-[10.5px] font-johnson-text text-jj-gray-07 bg-jj-gray-01 rounded-full px-2 py-0.5 tabular-nums">
                {rec.count}
              </span>
            </div>
          );
        })}

        {!shown.length && (
          <div className="px-4 py-[26px] text-center text-[12.5px] font-johnson-text text-jj-gray-06">
            Nothing on this page matches that.
          </div>
        )}
      </div>

      {total > shown.length && (
        <div className="text-[11px] font-johnson-text text-jj-gray-05" style={{ padding: '8px 14px', borderTop: '1px solid #f2efec', background: '#fcfbfa' }}>
          {total - shown.length} more below in the list
        </div>
      )}
    </div>
  );
}

/* ========================================================================
 * MOTION
 * ======================================================================== */

const EASE = 'cubic-bezier(.2,.8,.25,1)';

/* NOTE: sp-fade ends on `transform: none`, so it must never be applied to an
 * element whose transform carries layout (it would zero the offset). Use the
 * opacity-only sp-fadein for those. */
const KEYFRAMES = `
@keyframes sp-fade { from { opacity:0; transform:translateY(7px); } to { opacity:1; transform:none; } }
@keyframes sp-fadein { from { opacity:0; } to { opacity:1; } }
@keyframes sp-pop { from { opacity:0; transform:translateZ(-300px) scale(.82); } to { opacity:1; transform:translateZ(0) scale(1); } }
@keyframes sp-rail { from { opacity:0; transform:scale(.9); } to { opacity:1; transform:scale(1); } }
@keyframes sp-breathe { 0% { opacity:.45; transform:scale(1); } 50% { opacity:.8; transform:scale(1.014); } 100% { opacity:.45; transform:scale(1); } }
@keyframes sp-sweep { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }
@keyframes sp-sweep-rev { from { transform:rotate(0deg); } to { transform:rotate(-360deg); } }
@keyframes sp-riseflat { from { opacity:0; transform:translateY(26px) scale(.985); } to { opacity:1; transform:none; } }
@keyframes sp-cardin { from { opacity:0; transform:translateY(10px) scale(.98); } to { opacity:1; transform:none; } }
@keyframes sp-card { from { opacity:0; transform:translate(-50%,-42%) translateZ(10px) scale(.96); } to { opacity:1; transform:translate(-50%,-50%) translateZ(10px) scale(1); } }
@keyframes sp-draw { from { stroke-dashoffset:1; } to { stroke-dashoffset:0; } }
@keyframes sp-rise { from { opacity:0; transform:translate(-50%,64px); } to { opacity:1; transform:translate(-50%,0); } }
@keyframes sp-crown { from { opacity:0; transform:translate(-50%,-38%) scale(.6); } to { opacity:1; transform:translate(-50%,-50%) scale(1); } }
@keyframes sp-toast { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:none; } }
@keyframes sp-spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }
@keyframes sp-fill { from { transform:scaleX(0); } to { transform:scaleX(1); } }
@keyframes arch-float { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-7px); } }
@keyframes arch-ring { from { transform:scale(.55); opacity:.8; } to { transform:scale(1.45); opacity:0; } }
@keyframes tree-drop { from { transform:scaleY(0); } to { transform:scaleY(1); } }
@keyframes tree-bar { from { transform:scaleX(0); } to { transform:scaleX(1); } }
@keyframes tree-node { from { opacity:0; transform:translateY(-8px) scale(.9); } to { opacity:1; transform:none; } }
@keyframes tree-root { from { opacity:0; transform:translateY(-6px) scale(.94); } to { opacity:1; transform:none; } }
/* Animating box-shadow repaints the element every frame — murder on a
   software rasteriser. A ring scaling on its own layer is transform+opacity,
   which the compositor handles without repainting anything. */
@keyframes tree-pulsering { 0% { transform:scale(1); opacity:.5; } 100% { transform:scale(1.14); opacity:0; } }
@keyframes sp-shimmer { 0% { transform:translateX(-120%); } 100% { transform:translateX(220%); } }
`;

const ACCENT = '#eb1700';
const titleSize = (s) => (s.length > 34 ? 21 : s.length > 24 ? 25 : 30);


/* Scoped overrides for the reduced tiers. Scoped under a wrapper class so we
 * never affect the rest of the app. These cut paint cost — they don't remove
 * any animation. */
const LITE_CSS = `
.sp-lite [style*="backdrop-filter"],
.sp-lite [style*="backdropFilter"] {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
}
/* blur() on the CPU scales with radius squared, so clamp it rather than
   remove the effect. */
.sp-lite .sp-blur-soft { filter: blur(5px) !important; }
.sp-lite .sp-sweep-layer { animation-timing-function: linear !important; }
/* Pause perpetual ambient motion when nobody is interacting, so an idle
   Cloud PC session repaints nothing. */
.sp-lite.sp-idle .sp-ambient { animation-play-state: paused !important; }
.sp-lite .sp-scrim { background: rgba(49,44,42,.5) !important; }
.sp-lite .sp-glass { background: linear-gradient(150deg, rgba(255,255,255,.68) 0%, rgba(252,251,250,.62) 100%) !important; }

/* ── the AD-group panel ──
   A full-viewport backdrop blur is the single most expensive thing here: it
   samples and re-blurs everything behind it every frame the panel moves. The
   scrim goes opaque instead, which reads the same and costs one fill. */
.sp-lite .sp-panel-scrim {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  background: rgba(49,44,42,.44) !important;
}
/* One shadow instead of a 90px-blur drop that re-rasterises through the
   whole rise animation. */
.sp-lite .sp-panel { box-shadow: 0 18px 40px -22px rgba(49,44,42,.6) !important; }
/* The shimmer is a gradient sweeping under a mask — cheap per element, but
   there are a dozen skeletons. Slow it down rather than drop it. */
.sp-lite .sp-skeleton-sheen { animation-duration: 2.4s !important; }
.sp-min .sp-skeleton-sheen { animation: none !important; opacity: .5 !important; }

/* ── min tier ────────────────────────────────────────────────────────────
   Everything still moves. What goes is the work the CPU is worst at: a
   900px conic gradient rotating forever, live blur, and layered shadows —
   each of those repaints a huge area every single frame. */
.sp-min .sp-blur-soft { filter: none !important; opacity: .5 !important; }
.sp-min .sp-sweep-layer { animation: none !important; }
/* Five stacked shadows per medallion, times every domain, re-rasterised on
   every hover and every tilt frame. One shadow reads almost the same. */
.sp-min .sp-medallion {
  box-shadow: 0 10px 20px -10px rgba(49,44,42,.3), inset 0 1px 0 rgba(255,255,255,.9) !important;
}
.sp-min .sp-medallion.sp-medallion-on {
  box-shadow: 0 16px 26px -12px rgba(235,23,0,.3), inset 0 1px 0 rgba(255,255,255,.95) !important;
}
`;


const ORBIT_KEYFRAMES = `
@keyframes orb-ping { 0% { transform:scale(.92); opacity:.55; } 14% { transform:scale(1.34); opacity:0; } 100% { transform:scale(1.34); opacity:0; } }
@keyframes orb-packet { 0% { offset-distance:0%; opacity:0; transform:scale(.5); } 3% { opacity:1; transform:scale(1); } 11% { offset-distance:100%; opacity:1; transform:scale(1); } 14% { offset-distance:100%; opacity:0; transform:scale(.72); } 100% { offset-distance:100%; opacity:0; transform:scale(.5); } }
@keyframes orb-trace { 0% { offset-distance:0%; opacity:0; transform:scale(.55); } 14% { opacity:1; transform:scale(1); } 78% { opacity:1; transform:scale(1); } 94% { opacity:.6; transform:scale(.86); } 100% { offset-distance:100%; opacity:0; transform:scale(.7); } }
@keyframes orb-land { 0% { transform:scale(1.17); } 6% { transform:scale(.96); } 13% { transform:scale(1); } 100% { transform:scale(1); } }
@keyframes orb-gap { 0% { transform:scale(1); opacity:.5; } 70% { transform:scale(1.3); opacity:0; } 100% { transform:scale(1.3); opacity:0; } }
@keyframes orb-hub { 0% { transform:scale(.72); opacity:.5; } 100% { transform:scale(1.5); opacity:0; } }
`;

const NODE_TONES = ['#eb1700', '#0f68b2', '#8c3bbb', '#328714', '#ff6017', '#004685'];

const SWEEP_CYCLE = { full: 12, lite: 16, min: 22 };
const PACKET_TRAVEL = 1.7; // seconds a bead spends in flight (13% of the cycle)
const MEDALLION = 84;

/* Domains sit on one ellipse, first at twelve o'clock, going clockwise. The
 * ellipse is sized from the measured stage, so the ring breathes with the
 * window instead of being scaled as a block. */
function orbitGeom(w, h, n) {
  const cx = w / 2;
  const cy = h / 2 - 4;
  const rx = Math.max(190, Math.min(360, w * 0.29));
  const ry = Math.max(132, Math.min(230, h * 0.37));
  const at = (i) => {
    const t = i / Math.max(1, n);
    const ang = Math.PI * 2 * t - Math.PI / 2;
    return { x: cx + rx * Math.cos(ang), y: cy + ry * Math.sin(ang), deg: 360 * t };
  };
  return { cx, cy, rx, ry, at };
}

/* A short arc of the main ring, centred on one domain — drawn from real
 * angles rather than a dash offset, because an ellipse's arc length and its
 * angle do not run in step. */
function ringArc(g, deg, spread = 11) {
  const p = (d) => {
    const a = ((d - 90) * Math.PI) / 180;
    return [g.cx + g.rx * Math.cos(a), g.cy + g.ry * Math.sin(a)];
  };
  const [x0, y0] = p(deg - spread);
  const [x1, y1] = p(deg + spread);
  return `M${x0.toFixed(1)},${y0.toFixed(1)} A${g.rx.toFixed(1)},${g.ry.toFixed(1)} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
}

const WEDGE =
  'conic-gradient(from 0deg, rgba(235,23,0,0) 0deg, rgba(235,23,0,0) 276deg, rgba(235,23,0,.05) 320deg, rgba(235,23,0,.16) 352deg, rgba(235,23,0,.26) 360deg)';
const WEDGE_MASK = 'radial-gradient(circle, rgba(0,0,0,0) 15%, rgba(0,0,0,1) 40%, rgba(0,0,0,1) 84%, rgba(0,0,0,0) 100%)';

/* What travels the spoke is a record, so it is drawn as one: a sheet with a
 * folded corner, held upright by offsetRotate:'0deg' while the motion path
 * carries it. */
function RecordInFlight({ path, animation, size = 15, zIndex = 5 }) {
  const w = size;
  const h = Math.round(size * 1.28);
  return (
    <span
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: w,
        height: h,
        marginLeft: -w / 2,
        marginTop: -h / 2,
        pointerEvents: 'none',
        zIndex,
        offsetPath: path,
        offsetRotate: '0deg',
        animation,
        filter: 'drop-shadow(0 3px 6px rgba(49,44,42,.28))',
      }}
    >
      <svg viewBox="0 0 18 23" width={w} height={h} style={{ display: 'block' }}>
        <path d="M1 2.6A1.6 1.6 0 0 1 2.6 1h7.9L17 7.3v13.1A1.6 1.6 0 0 1 15.4 22H2.6A1.6 1.6 0 0 1 1 20.4Z" fill="#fff" stroke={ACCENT} strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M10.5 1v6.3H17" fill="none" stroke={ACCENT} strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M4.6 12h8.8M4.6 15.4h8.8M4.6 18.8h5.4" stroke="rgba(235,23,0,.55)" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function SweepWedge() {
  return (
    <>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          background: WEDGE,
          WebkitMaskImage: WEDGE_MASK,
          maskImage: WEDGE_MASK,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '8%',
          width: 1.5,
          height: '42%',
          marginLeft: -0.75,
          borderRadius: 1,
          background: 'linear-gradient(180deg, rgba(235,23,0,0), rgba(235,23,0,.6))',
        }}
      />
    </>
  );
}

/* ========================================================================
 * ORBIT — the welcome screen
 *
 * Z-STACK RULES:
 *  - every decorative layer is pointerEvents:'none'
 *  - only the medallion wrappers take the pointer
 * ======================================================================== */

function DomainOrbit({ domains, query, headerRef, onOpen }) {
  const tier = usePerfTier();
  const lite = tier !== 'full';
  const cycle = SWEEP_CYCLE[tier] || SWEEP_CYCLE.full;

  useEffect(() => measureTier(5), []);

  const [hover, setHover] = useState(null);
  const stageRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const terms = useMemo(() => parseQuery(query), [query]);
  const hitSet = useMemo(
    () => new Set(searchRecords(domains, query).results.map((r) => r.rec.domain)),
    [domains, query]
  );
  const matches = useCallback((d) => !terms.length || hitSet.has(d.domain), [terms, hitSet]);
  const q = terms.length ? query.trim() : '';

  const geom = useMemo(
    () => orbitGeom(size.w || 1200, size.h || 600, domains.length),
    [size.w, size.h, domains.length]
  );

  const { nodes, matchCount } = useMemo(() => {
    let hits = 0;
    const out = domains.map((d, i) => {
      const pos = geom.at(i);
      const match = matches(d);
      if (match) hits += 1;
      return {
        record: d,
        i,
        x: pos.x,
        y: pos.y,
        deg: pos.deg,
        tone: NODE_TONES[i % NODE_TONES.length],
        gap: !d.owner || !d.steward,
        dim: !!q && !match,
        // when the sweep reaches this domain, in seconds from the top
        beat: (i * cycle) / Math.max(1, domains.length),
        entry: (0.12 + i * 0.08).toFixed(2),
        floatDur: (4.4 + (i % 3) * 0.6).toFixed(1),
        floatDelay: (i * 0.55).toFixed(1),
      };
    });
    return { nodes: out, matchCount: hits };
  }, [domains, matches, q, geom, cycle]);

  const hovNode = nodes.find((n) => n.record.domain === hover) || null;
  const hov = hovNode ? hovNode.record : null;

  const totals = useMemo(() => {
    const people = new Set();
    let packages = 0;
    let gaps = 0;
    domains.forEach((d) => {
      [d.owner, d.steward, ...d.sponsors]
        .filter(Boolean)
        .forEach((p) => people.add((p.email || p.name).toLowerCase()));
      packages += (d.packages || []).length;
      if (!d.owner) gaps += 1;
      if (!d.steward) gaps += 1;
    });
    return {
      records: domains.reduce((n, d) => n + (d.count || 0), 0),
      people: people.size,
      packages,
      gaps,
    };
  }, [domains]);

  const inert = { pointerEvents: 'none' };
  const sweepSpan = Math.max(geom.rx * 2.5, 560);
  const pill = 'flex items-baseline gap-[7px] bg-white/[.88] border border-jj-gray-02 rounded-full px-3.5 py-1.5';

  return (
    <div
      ref={stageRef}
      className={`flex-1 min-h-0 relative overflow-hidden${lite ? ' sp-lite' : ''}${tier === 'min' ? ' sp-min' : ''}`}
      style={{
        background: 'radial-gradient(70% 70% at 50% 46%, #ffffff 0%, #f7f4f1 62%, #efece8 100%)',
        contain: 'layout paint style',
      }}
    >
      <style>{KEYFRAMES}{ORBIT_KEYFRAMES}</style>
      {lite && <style>{LITE_CSS}</style>}

      {/* ── rings, spokes, and the lit spoke to the parked domain ── */}
      {size.w > 0 && (
        <svg width={size.w} height={size.h} fill="none" style={{ ...inert, position: 'absolute', inset: 0 }}>
          <ellipse cx={geom.cx} cy={geom.cy} rx={geom.rx * 1.19} ry={geom.ry * 1.19} stroke="#f1ece7" />
          <ellipse cx={geom.cx} cy={geom.cy} rx={geom.rx} ry={geom.ry} stroke="#e6e0da" />
          <ellipse cx={geom.cx} cy={geom.cy} rx={geom.rx * 0.71} ry={geom.ry * 0.71} stroke="#eee9e4" />
          <ellipse cx={geom.cx} cy={geom.cy} rx={geom.rx * 0.42} ry={geom.ry * 0.42} stroke="#f0ece8" strokeDasharray="3 8" />
          <g stroke="#ded8d2" strokeDasharray="2 9">
            {nodes.map((n) => (
              <line key={n.record.domain} x1={geom.cx} y1={geom.cy} x2={n.x} y2={n.y} />
            ))}
          </g>
          {hovNode && (
            <g style={{ animation: 'sp-fadein .2s ease-out both' }}>
              <line x1={geom.cx} y1={geom.cy} x2={hovNode.x} y2={hovNode.y} stroke={ACCENT} strokeWidth="1.4" opacity=".55" />
              <path d={ringArc(geom, hovNode.deg)} stroke={ACCENT} strokeWidth="2" strokeLinecap="round" opacity=".7" />
              <path d={ringArc(geom, hovNode.deg, 22)} stroke={ACCENT} strokeWidth="1" strokeLinecap="round" opacity=".22" />
            </g>
          )}
        </svg>
      )}

      {/* ── the sweep: spinning when idle, parked while hovering ── */}
      {size.w > 0 && (
        <div
          className="sp-ambient"
          style={{
            ...inert,
            position: 'absolute',
            left: geom.cx,
            top: geom.cy,
            width: sweepSpan,
            height: sweepSpan,
            marginLeft: -sweepSpan / 2,
            marginTop: -sweepSpan / 2,
            transform: `scaleY(${(geom.ry / geom.rx).toFixed(3)})`,
          }}
        >
          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', animation: `sp-spin ${cycle}s linear infinite` }}>
            <SweepWedge />
          </div>
        </div>
      )}

      {/* ── packets: one bead per domain, landing on that domain's beat ── */}
      {size.w > 0 &&
        !lite &&
        !hovNode &&
        nodes.map((n) => (
          <RecordInFlight
            key={`packet-${n.record.domain}`}
            size={14}
            path={`path('M${geom.cx.toFixed(0)},${geom.cy.toFixed(0)} L${n.x.toFixed(0)},${n.y.toFixed(0)}')`}
            animation={`orb-packet ${cycle}s cubic-bezier(.4,0,.5,1) ${(n.beat - PACKET_TRAVEL).toFixed(2)}s infinite`}
          />
        ))}

      {/* ── hover: a bead keeps running the lit spoke ── */}
      {hovNode && (
        <RecordInFlight
          size={17}
          zIndex={7}
          path={`path('M${geom.cx.toFixed(0)},${geom.cy.toFixed(0)} L${hovNode.x.toFixed(0)},${hovNode.y.toFixed(0)}')`}
          animation="orb-trace 1.9s cubic-bezier(.35,0,.4,1) infinite"
        />
      )}

      {/* ── hub: the estate's totals, echoing on the same clock ── */}
      {size.w > 0 && (
        <div
          style={{
            ...inert,
            position: 'absolute',
            left: geom.cx,
            top: geom.cy,
            width: 164,
            height: 164,
            marginLeft: -82,
            marginTop: -82,
            zIndex: 4,
          }}
        >
          <span
            className="sp-ambient"
            style={{
              position: 'absolute',
              inset: -14,
              borderRadius: '50%',
              border: '1.5px dashed rgba(235,23,0,.3)',
              animation: `sp-sweep ${(cycle * 2.2).toFixed(0)}s linear infinite`,
            }}
          />
          <span
            className="sp-ambient"
            style={{
              position: 'absolute',
              inset: -14,
              borderRadius: '50%',
              border: '1px solid rgba(235,23,0,.45)',
              animation: `orb-hub ${(cycle / 3.5).toFixed(1)}s cubic-bezier(.3,0,.5,1) infinite`,
            }}
          />
          <span
            className="sp-ambient"
            style={{
              position: 'absolute',
              inset: -14,
              borderRadius: '50%',
              border: '1px solid rgba(235,23,0,.45)',
              animation: `orb-hub ${(cycle / 3.5).toFixed(1)}s cubic-bezier(.3,0,.5,1) ${(cycle / 7).toFixed(1)}s infinite`,
            }}
          />
          <span
            className="grid place-items-center"
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              background: 'linear-gradient(155deg,#fff,#faf8f6)',
              border: '1px solid #e8e6e3',
              boxShadow: '0 22px 44px -24px rgba(49,44,42,.5)',
              animation: `sp-pop .5s ${EASE} both`,
            }}
          >
            <span className="flex flex-col items-center">
              <span className="w-1.5 h-1.5 rounded-full mb-2" style={{ background: ACCENT }} />
              <span className="font-johnson-display font-bold text-[38px] text-jj-gray-08 tracking-[.02em] leading-none">GRA</span>
              <span className="text-[11px] font-johnson-text uppercase tracking-[.14em] text-jj-gray-05 mt-2">
                Data Domains
              </span>
            </span>
          </span>
        </div>
      )}

      {/* ── corner readouts ── */}
      <div className="absolute left-6 top-5 flex gap-2 items-start flex-wrap" style={{ ...inert, maxWidth: 520 }}>
        {[
          [q ? matchCount : domains.length, q ? `of ${domains.length} shown` : 'domains'],
          [totals.people, 'named people'],
          [totals.packages, 'packages'],
        ].map(([value, label], i) => (
          <span key={label} className={pill} style={{ animation: `sp-pop .5s ${EASE} ${0.3 + i * 0.12}s both` }}>
            <span className="font-johnson-display font-bold text-[15px] text-jj-gray-08 tabular-nums">{value}</span>
            <span className="text-[11px] font-johnson-text text-jj-gray-06">{label}</span>
          </span>
        ))}
        {totals.gaps > 0 && (
          <span
            className="flex items-baseline gap-[7px] rounded-full px-3.5 py-1.5"
            style={{ background: 'rgba(235,23,0,.06)', border: '1px solid rgba(235,23,0,.35)', animation: `sp-pop .5s ${EASE} .66s both` }}
          >
            <span className="font-johnson-display font-bold text-[15px] tabular-nums" style={{ color: ACCENT }}>
              {totals.gaps}
            </span>
            <span className="text-[11px] font-johnson-text" style={{ color: ACCENT }}>
              role{totals.gaps === 1 ? '' : 's'} unassigned
            </span>
          </span>
        )}
      </div>

      {/* ── domain medallions ── */}
      {size.w > 0 &&
        nodes.map((n) => {
          const d = n.record;
          const on = hover === d.domain;
          return (
            <div
              key={d.domain}
              onClick={() => onOpen(d.domain)}
              onMouseEnter={() => setHover(d.domain)}
              onMouseLeave={() => setHover((h) => (h === d.domain ? null : h))}
              className="absolute cursor-pointer flex flex-col items-center gap-[7px]"
              style={{
                left: Math.round(n.x - 100),
                top: Math.round(n.y - MEDALLION / 2),
                width: 200,
                zIndex: on ? 9 : 6,
                opacity: n.dim ? 0.26 : 1,
                transition: 'opacity .3s ease',
                animation: `sp-pop .45s ${EASE} ${n.entry}s both`,
              }}
            >
              <span
                className="relative grid place-items-center sp-medallion"
                style={{
                  width: MEDALLION,
                  height: MEDALLION,
                  borderRadius: '50%',
                  background: on ? ACCENT : '#fff',
                  border: `1px solid ${on ? ACCENT : '#e8e6e3'}`,
                  boxShadow: on ? '0 16px 30px -14px rgba(235,23,0,.5)' : '0 12px 26px -16px rgba(49,44,42,.55)',
                  transform: on ? 'scale(1.06)' : 'scale(1)',
                  transition: `transform .25s ${EASE}, background .2s ease, border-color .2s ease`,
                  animation: tier === 'min' ? 'none' : `arch-float ${n.floatDur}s ease-in-out ${n.floatDelay}s infinite`,
                }}
              >
                {/* the ring the sweep leaves behind as it passes this domain */}
                <span
                  className="sp-ambient"
                  style={{
                    ...inert,
                    position: 'absolute',
                    inset: -7,
                    borderRadius: '50%',
                    border: `1.5px solid ${n.gap ? 'rgba(235,23,0,.7)' : 'rgba(235,23,0,.45)'}`,
                    animation: `orb-ping ${cycle}s cubic-bezier(.25,.6,.3,1) ${n.beat.toFixed(2)}s infinite`,
                  }}
                />
                <svg
                  viewBox="0 0 24 24"
                  width="34"
                  height="34"
                  fill="none"
                  stroke={on ? '#fff' : n.tone}
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    overflow: 'visible',
                    animation:
                      tier === 'min'
                        ? 'none'
                        : `sp-breathe 3.6s ease-in-out infinite, orb-land ${cycle}s cubic-bezier(.3,1.4,.5,1) ${n.beat.toFixed(2)}s infinite`,
                  }}
                >
                  <path
                    d={iconFor(d.domain)}
                    pathLength="1"
                    style={{ strokeDasharray: 1, animation: `sp-draw 1s ease ${(0.3 + n.i * 0.08).toFixed(2)}s both` }}
                  />
                </svg>
                {n.gap && (
                  <span
                    className="sp-ambient"
                    style={{ ...inert, position: 'absolute', inset: -3, borderRadius: '50%', border: `1px solid ${ACCENT}`, animation: 'orb-gap 2.8s ease-out infinite' }}
                  />
                )}
                {n.gap && (
                  <span
                    title="A role is unassigned"
                    style={{ position: 'absolute', right: 4, top: 6, width: 10, height: 10, borderRadius: '50%', background: ACCENT, border: '2px solid #fff' }}
                  />
                )}
              </span>

              <span
                className="text-[13px] font-johnson-text text-center leading-[1.25]"
                style={{ color: on ? ACCENT : '#312c2a', fontWeight: on ? 500 : 400, transition: 'color .2s ease' }}
              >
                {d.domain}
              </span>
              <span className="text-[11px] font-johnson-text -mt-1 tabular-nums" style={{ color: n.gap ? ACCENT : '#6e6259' }}>
                {d.count} record{d.count === 1 ? '' : 's'}
                {n.gap ? (!d.owner ? ' · no owner' : ' · no steward') : d.owner ? ` · ${d.owner.name}` : ''}
              </span>
            </div>
          );
        })}

      {/* ── preview card for the parked domain ── */}
      {hov && (
        <div
          className="absolute overflow-hidden"
          /* the card sits on the same side as the domain being hovered, so it
             never covers the one you are pointing at */
          style={{
            left: hovNode.x > geom.cx + 1 ? undefined : 24,
            right: hovNode.x > geom.cx + 1 ? 24 : undefined,
            bottom: 24,
            width: 292,
            zIndex: 8,
            borderRadius: 16,
            background: '#fff',
            border: '1px solid #e8e6e3',
            boxShadow: '0 22px 44px -26px rgba(49,44,42,.5)',
            animation: `sp-cardin .24s ${EASE} both`,
          }}
        >
          <div className="px-[18px] pt-4 pb-[17px]">
            <div className="flex items-baseline gap-2">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: hovNode.tone }} />
              <span className="font-johnson-display font-bold text-[16px] text-jj-gray-08 truncate">{hov.domain}</span>
              <span className="ml-auto text-[11.5px] font-johnson-text text-jj-gray-06 whitespace-nowrap tabular-nums">
                {hov.count} record{hov.count === 1 ? '' : 's'}
              </span>
            </div>
            <div className="mt-3 flex flex-col gap-2 text-[12.5px] font-johnson-text">
              <PreviewRow dot={ACCENT} label="Owner" value={hov.owner ? hov.owner.name : 'Not assigned'} strong />
              <PreviewRow dot="#0f68b2" label="Steward" value={hov.steward ? hov.steward.name : 'Not assigned'} />
              <PreviewRow
                dot="#8c3bbb"
                label="Sponsors"
                value={hov.sponsors.length ? hov.sponsors.map((s) => s.name).join(', ') : 'Not assigned'}
              />
              <PreviewRow dot="#a39992" label="Packages" value={`${(hov.packages || []).length} listed`} />
            </div>
          </div>
        </div>
      )}

      {q && matchCount === 0 && (
        <div className="absolute left-6 bottom-3.5 text-[12px] font-johnson-text text-jj-gray-05" style={inert}>
          Nothing matches that search.
        </div>
      )}
      <div className="absolute right-6 bottom-3.5 text-[12px] font-johnson-text text-jj-gray-05" style={inert}>
        {hov ? 'Click to open the ownership record' : 'Hover a domain to trace its connection'}
      </div>
    </div>
  );
}

function PreviewRow({ dot, label, value, strong }) {
  return (
    <span className="flex justify-between items-center gap-3">
      <span className="flex items-center gap-1.5 text-jj-gray-05 flex-shrink-0">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: dot }} />
        {label}
      </span>
      <span className={`truncate text-right text-jj-gray-08${strong ? ' font-medium' : ''}`}>{value}</span>
    </span>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <div className="text-[9.5px] font-johnson-text uppercase tracking-[.1em] text-jj-gray-05">{label}</div>
      <div className="text-[13px] font-johnson-text mt-0.5 text-jj-gray-08">{value}</div>
    </div>
  );
}

/* ========================================================================
 * OPENED PANEL — arch-shaped sheet rising from the crown
 * ======================================================================== */

function OpenedDomain({ record, onClose, onOpenDirectory, onCopyContacts, copyLabel }) {
  const tier = usePerfTier();
  const lite = tier !== 'full';
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const people = [
    { role: 'Data domain owner', p: record.owner, tone: ACCENT, tint: 'rgba(235,23,0,.1)' },
    { role: 'Data steward', p: record.steward, tone: '#0f68b2', tint: 'rgba(15,104,178,.1)' },
    ...record.sponsors.map((s) => ({ role: 'Domain sponsor', p: s, tone: '#8c3bbb', tint: 'rgba(140,59,187,.1)' })),
  ];
  const named = people.filter((x) => x.p).length;
  const photoFor = useDirectoryPhotos(people.map((x) => x.p));

  return (
    <div className={`fixed inset-0 z-[60] flex justify-center items-end${lite ? ` sp-lite${tier === 'min' ? ' sp-min' : ''}` : ''}`}>
      {lite && <style>{LITE_CSS}</style>}
      <div
        onClick={onClose}
        className="sp-scrim"
        style={{ position: 'absolute', inset: 0, background: 'rgba(49,44,42,.28)', backdropFilter: 'blur(7px)', WebkitBackdropFilter: 'blur(7px)', animation: 'sp-fadein .3s ease-out both' }}
      />

      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 0,
          width: 920,
          maxWidth: '96vw',
          height: '88%',
          maxHeight: 660,
          transform: 'translateX(-50%)',
          animation: `sp-rise .52s ${EASE} both`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '460px 460px 0 0',
            background: 'linear-gradient(172deg, #fff 0%, #fdfcfb 46%, #f7f5f3 100%)',
            border: '1px solid #e8e6e3',
            borderBottom: 0,
            boxShadow: '0 -40px 90px -30px rgba(49,44,42,.42), inset 0 2px 0 rgba(255,255,255,.95)',
            overflow: 'hidden',
          }}
        >
          <div style={{ position: 'absolute', left: '50%', top: 96, width: 520, height: 520, marginLeft: -260, borderRadius: '50%', background: 'radial-gradient(circle, rgba(235,23,0,.05) 0%, rgba(235,23,0,0) 70%)' }} />
        </div>

        {/* crown medallion — overflow:hidden keeps the specular cap inside */}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: 0,
            width: 108,
            height: 108,
            zIndex: 2,
            borderRadius: '50%',
            overflow: 'hidden',
            transform: 'translate(-50%,-50%)',
            animation: `sp-crown .6s ${EASE} .1s both`,
          }}
        >
          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'linear-gradient(155deg,#fff 0%,#fdfcfb 50%,#efeae6 100%)', border: '1px solid #e8e6e3', boxShadow: '0 26px 44px -18px rgba(49,44,42,.4), inset 0 2px 0 rgba(255,255,255,.95), inset 0 -12px 20px -12px rgba(49,44,42,.2)' }} />
          <div style={{ position: 'absolute', inset: 7, borderRadius: '50%', border: '1px solid rgba(49,44,42,.07)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.9)' }} />
          <div style={{ position: 'absolute', left: '-12%', top: '-44%', width: '124%', height: '76%', borderRadius: '50%', background: 'linear-gradient(180deg, rgba(255,255,255,.9), rgba(255,255,255,0))' }} />
          <svg viewBox="0 0 24 24" width="34" height="34" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }} fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d={iconFor(record.domain)} stroke="rgba(255,255,255,.9)" transform="translate(0,1)" />
            <path d={iconFor(record.domain)} stroke={ACCENT} pathLength="1" style={{ strokeDasharray: 1, animation: 'sp-draw .8s cubic-bezier(.35,0,.25,1) .2s both' }} />
          </svg>
        </div>

        <button
          onClick={onClose}
          className="absolute right-[34px] top-[26px] w-[34px] h-[34px] rounded-full border border-jj-gray-02 bg-white text-jj-gray-06 flex items-center justify-center hover:bg-jj-gray-01"
          style={{ zIndex: 3, transition: `background .2s ease, transform .2s ${EASE}` }}
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>

        {/* flowing flex column — arch curvature is a per-item rise, so it can
            never overshoot the header or push the CTA out of the pane */}
        <div className="absolute inset-0 flex flex-col items-center gap-[22px] overflow-y-auto text-center" style={{ padding: '74px 72px 26px' }}>
          <div className="flex-shrink-0" style={{ animation: `sp-fade .5s ${EASE} .12s both` }}>
            <h2
              className="m-0 font-johnson-display font-bold tracking-[-.015em] text-jj-gray-08 leading-[1.15]"
              style={{ fontSize: titleSize(record.domain), maxWidth: 520, marginInline: 'auto' }}
            >
              {record.domain}
            </h2>
            <div className="mt-[7px] text-xs font-johnson-text text-jj-gray-05">
              {record.count} records · {named} named people · Snowflake
            </div>
          </div>

          <div className="relative flex-shrink-0 w-full flex items-start justify-center gap-2 pt-[34px]">
            <div style={{ position: 'absolute', left: '50%', top: 0, width: 540, height: 240, marginLeft: -270, pointerEvents: 'none', borderRadius: '50%', border: '1px solid #ece7e2', clipPath: 'inset(0 0 50% 0)', animation: `sp-rail .7s ${EASE} .2s both` }} />
            {people.map((item, i) => {
              const tt = people.length === 1 ? 0.5 : i / (people.length - 1);
              const rise = -Math.round(30 * Math.sin(Math.PI * tt));
              const photo = photoFor(item.p);
              return (
                <div
                  key={`${item.role}-${i}`}
                  className="relative flex-shrink-0 text-center"
                  style={{ width: 148, transform: `translateY(${rise}px)`, animation: 'sp-fadein .5s ease-out both', animationDelay: `${(0.24 + i * 0.07).toFixed(2)}s` }}
                >
                  <div
                    className="font-johnson-text"
                    style={{
                      width: 52,
                      height: 52,
                      borderRadius: '50%',
                      margin: '0 auto',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 16,
                      fontWeight: 700,
                      color: item.p ? item.tone : '#a39992',
                      background: item.p ? `linear-gradient(155deg,#fff,${item.tint})` : '#f2efec',
                      border: `1px ${item.p ? 'solid #e8e6e3' : 'dashed #ded8d2'}`,
                      boxShadow: photo
                        ? '0 12px 22px -12px rgba(49,44,42,.4)'
                        : 'inset 0 1.5px 0 rgba(255,255,255,.95), 0 12px 22px -12px rgba(49,44,42,.4)',
                      overflow: 'hidden',
                    }}
                  >
                    {photo ? (
                      <img
                        src={photo}
                        alt={item.p.name}
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                      />
                    ) : item.p ? (
                      initials(item.p.name)
                    ) : (
                      '—'
                    )}
                  </div>
                  <div className="mt-[9px] text-[9.5px] font-johnson-text uppercase tracking-[.1em] text-jj-gray-05">{item.role}</div>
                  <div className="text-sm font-johnson-text font-medium mt-[3px]" style={{ color: item.p ? '#312c2a' : '#9e0000' }}>
                    {item.p ? item.p.name : 'Not assigned'}
                  </div>
                  {item.p && item.p.email && <div className="text-[11px] font-johnson-text text-[#0f68b2] mt-px">{item.p.email}</div>}
                </div>
              );
            })}
          </div>

          <div className="flex-shrink-0 flex justify-center gap-2.5" style={{ animation: `sp-fade .5s ${EASE} .3s both` }}>
            <button
              onClick={onOpenDirectory}
              className="flex items-center gap-2 px-5 py-2.5 rounded-full border border-jj-gray-08 bg-jj-gray-08 text-white text-xs font-johnson-text hover:bg-jj-red hover:border-jj-red hover:gap-4"
              style={{ transition: `background .22s ease, gap .22s ${EASE}` }}
            >
              Open the full record
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
            </button>
            <button onClick={onCopyContacts} className="px-5 py-2.5 rounded-full border border-jj-gray-03 bg-white text-xs font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01">
              {copyLabel}
            </button>
          </div>

          {record.faqs.length > 0 && (
            <div className="flex-shrink-0 w-full text-left" style={{ maxWidth: 620, animation: `sp-fade .5s ${EASE} .36s both` }}>
              <div className="border border-jj-gray-02 rounded-xl px-[17px] pt-[15px] pb-1 bg-white/70" style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,.9)' }}>
                <div className="flex items-center justify-center gap-1.5 pb-2">
                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: ACCENT }} />
                  <span className="text-[10.5px] font-johnson-text font-medium uppercase tracking-[.09em]" style={{ color: ACCENT }}>
                    What this domain answers
                  </span>
                </div>
                <div className="flex flex-col">
                  {record.faqs.map((f, i) => (
                    <div key={i} className="py-3.5" style={{ borderTop: i ? '1px solid #f1efed' : 0 }}>
                      <div className="text-[9.5px] font-johnson-text uppercase tracking-[.1em] text-jj-gray-05">
                        Question
                      </div>
                      <div className="font-johnson-display italic text-[16px] text-jj-gray-08 leading-snug mt-0.5">
                        {f.question}
                      </div>
                      {f.answer && (
                        <>
                          <div className="text-[9.5px] font-johnson-text uppercase tracking-[.1em] text-jj-gray-05 mt-3">
                            Answer
                          </div>
                          <div className="text-[13px] font-johnson-text text-jj-gray-06 leading-relaxed mt-0.5">
                            {f.answer}
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ========================================================================
 * RECORDS TABLE
 *
 * The raw SELECT * grid, read the way the rest of the page reads people:
 *  - person columns (owner / steward / sponsor / contact) render as initial
 *    medallions with a copyable address, instead of a raw "Name <mail>" cell
 *  - the header is sticky, so scrolling a long domain keeps the column names
 *  - nulls read as a quiet dash, not the word "null"
 *  - the hovered row lifts on a red rail and reveals a copy-row action
 *  - the footer states what the grid is, and stays visible while scrolling
 * ======================================================================== */

const PERSON_COL = /SPONSOR|STEWARD|OWNER|CONTACT|MANAGER|APPROVER/i;

function PersonCell({ value }) {
  const people = toPeople(value);
  if (!people.length) return <NullCell />;
  return (
    <div className="flex flex-col gap-1.5">
      {people.map((p, i) => (
        <div key={`${p.email || p.name}-${i}`} className="flex items-center gap-2 min-w-0">
          <span
            className="flex-shrink-0 flex items-center justify-center font-johnson-text text-[9.5px] font-bold"
            style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              color: '#6e6259',
              background: 'linear-gradient(155deg,#fff,#f1efed)',
              border: '1px solid #e8e6e3',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,.95), 0 2px 5px -4px rgba(49,44,42,.5)',
            }}
          >
            {initials(p.name)}
          </span>
          <span className="min-w-0">
            <span className="block text-[12.5px] font-johnson-text text-jj-gray-08 truncate">{p.name}</span>
            {p.email && <span className="block text-[10.5px] font-johnson-text text-jj-gray-05 truncate">{p.email}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function NullCell() {
  return (
    <span title="null" className="text-jj-gray-04 select-none">
      —
    </span>
  );
}

const LOCKED_COLUMNS = new Set(['DOMAIN']);

function RecordsTable({ record, cols, onCopy, canEdit, onSaveRow, terms = [] }) {
  const [hoverRow, setHoverRow] = useState(null);
  const [editRow, setEditRow] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  /* Rows keep their original index while filtered — edits and saves address
   * the real row, not the visible position. */
  const visible = useMemo(
    () =>
      record.rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => rowMatches(r, record.columns, terms)),
    [record.rows, record.columns, terms]
  );
  const hidden = record.rows.length - visible.length;

  const copyRow = (r) => {
    const text = cols.map((c, j) => `${c}: ${blank(r[j]) ? '' : String(r[j])}`).join('\n');
    onCopy(text, `Row copied · ${record.domain}`);
  };

  // Everything edits as text — the grid can't know a column's real type, and
  // the backend turns an emptied field back into a proper NULL.
  const asText = (v) => (blank(v) ? '' : String(v));

  const startEdit = (i, r) => {
    setEditRow(i);
    setDraft(Object.fromEntries(cols.map((c, j) => [c, asText(r[j])])));
  };

  const cancel = () => {
    setEditRow(null);
    setDraft({});
  };

  const save = async (i, r) => {
    const changes = {};
    cols.forEach((c, j) => {
      if (LOCKED_COLUMNS.has(c)) return;
      if (draft[c] !== asText(r[j])) changes[c] = draft[c];
    });
    if (!Object.keys(changes).length) return cancel();

    const original = Object.fromEntries(cols.map((c, j) => [c, blank(r[j]) ? null : r[j]]));
    setSaving(true);
    const ok = await onSaveRow(i, changes, original);
    setSaving(false);
    if (ok) cancel();
  };

  return (
    <div
      className="border border-jj-gray-02 rounded-[14px] bg-white overflow-hidden"
      style={{ boxShadow: '0 1px 3px rgba(49,44,42,.05)' }}
    >
      <div className="overflow-auto" style={{ maxHeight: 420 }}>
        <table className="w-full border-collapse font-johnson-text" style={{ minWidth: 620 }}>
          <thead>
            <tr>
              <th
                className="sticky top-0 z-10 text-right align-bottom text-[9.5px] font-medium uppercase tracking-[.12em] text-jj-gray-05 bg-white"
                style={{ width: 44, padding: '11px 10px 9px 14px', borderBottom: '1px solid #e8e6e3' }}
              >
                #
              </th>
              {cols.map((c) => (
                <th
                  key={c}
                  className="sticky top-0 z-10 text-left align-bottom text-[9.5px] font-medium uppercase tracking-[.12em] text-jj-gray-06 bg-white whitespace-nowrap"
                  style={{ padding: '11px 16px 9px', borderBottom: '1px solid #e8e6e3' }}
                >
                  {c.replace(/_/g, ' ')}
                </th>
              ))}
              <th className="sticky top-0 z-10 bg-white" style={{ width: canEdit ? 76 : 46, borderBottom: '1px solid #e8e6e3' }} />
            </tr>
          </thead>
          <tbody>
            {visible.map(({ r, i }) => {
              const editing = editRow === i;
              const on = hoverRow === i || editing;
              return (
                <tr
                  key={i}
                  onMouseEnter={() => setHoverRow(i)}
                  onMouseLeave={() => setHoverRow((h) => (h === i ? null : h))}
                  style={{
                    background: editing ? '#fdf6f5' : on ? '#faf8f7' : 'transparent',
                    transition: 'background .16s ease',
                  }}
                >
                  <td
                    className="text-right align-top text-[11px] tabular-nums text-jj-gray-05"
                    style={{
                      padding: '12px 10px 12px 14px',
                      borderTop: i ? '1px solid #f1efed' : 0,
                      boxShadow: on ? `inset 3px 0 0 ${ACCENT}` : 'none',
                      transition: 'box-shadow .16s ease',
                    }}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </td>
                  {cols.map((c, j) => (
                    <td
                      key={c}
                      className="align-top text-[12.5px] text-jj-gray-08"
                      style={{ padding: '12px 16px', borderTop: i ? '1px solid #f1efed' : 0, maxWidth: 260 }}
                    >
                      {editing && !LOCKED_COLUMNS.has(c) ? (
                        <input
                          value={draft[c] ?? ''}
                          disabled={saving}
                          onChange={(e) => setDraft((d) => ({ ...d, [c]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') save(i, r);
                            if (e.key === 'Escape') cancel();
                          }}
                          placeholder="empty"
                          className="w-full bg-white border rounded-[7px] text-[12.5px] font-johnson-text text-jj-gray-08 outline-none focus:border-jj-red"
                          style={{ padding: '5px 8px', borderColor: '#e0dcd8', minWidth: 140 }}
                        />
                      ) : blank(r[j]) ? (
                        <NullCell />
                      ) : PERSON_COL.test(c) ? (
                        <PersonCell value={r[j]} />
                      ) : (
                        <span className="block truncate" title={String(r[j])}>
                          <Highlight text={String(r[j])} terms={terms} />
                        </span>
                      )}
                    </td>
                  ))}
                  <td style={{ padding: '10px 12px 10px 0', borderTop: i ? '1px solid #f1efed' : 0 }}>
                    <div className="flex items-center gap-1.5 justify-end">
                      {editing ? (
                        <>
                          <button
                            onClick={() => save(i, r)}
                            disabled={saving}
                            title="Save row"
                            className="flex items-center justify-center rounded-full border text-white disabled:opacity-60"
                            style={{ width: 26, height: 26, background: ACCENT, borderColor: ACCENT }}
                          >
                            {saving ? (
                              <span
                                style={{
                                  width: 11, height: 11, borderRadius: '50%',
                                  border: '2px solid rgba(255,255,255,.45)', borderTopColor: '#fff',
                                  animation: 'sp-spin .7s linear infinite',
                                }}
                              />
                            ) : (
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M4 12.5 9.5 18 20 6.5" />
                              </svg>
                            )}
                          </button>
                          <button
                            onClick={cancel}
                            disabled={saving}
                            title="Discard changes"
                            className="flex items-center justify-center rounded-full border border-jj-gray-02 bg-white text-jj-gray-06 hover:text-jj-gray-08 disabled:opacity-60"
                            style={{ width: 26, height: 26 }}
                          >
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                              <path d="M6 6l12 12M18 6 6 18" />
                            </svg>
                          </button>
                        </>
                      ) : (
                        <>
                          {canEdit && (
                            <button
                              onClick={() => startEdit(i, r)}
                              title="Edit this row"
                              className="flex items-center justify-center rounded-full border border-jj-gray-02 bg-white text-jj-gray-06 hover:text-jj-red hover:border-jj-red"
                              style={{ width: 26, height: 26, opacity: on ? 1 : 0, transition: 'opacity .16s ease, color .16s ease, border-color .16s ease' }}
                            >
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 20h9" />
                                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                              </svg>
                            </button>
                          )}
                          <button
                            onClick={() => copyRow(r)}
                            title="Copy this row"
                            className="flex items-center justify-center rounded-full border border-jj-gray-02 bg-white text-jj-gray-06 hover:text-jj-red hover:border-jj-red"
                            style={{ width: 26, height: 26, opacity: on ? 1 : 0, transition: 'opacity .16s ease, color .16s ease, border-color .16s ease' }}
                          >
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="9" y="9" width="11" height="11" rx="2" />
                              <path d="M15 5H6a2 2 0 0 0-2 2v9" />
                            </svg>
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={cols.length + 2} className="text-center text-[12.5px] text-jj-gray-06" style={{ padding: '34px 16px' }}>
                  {record.rows.length ? 'No row here matches your search.' : 'This domain returned no rows.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div
        className="flex items-center gap-2 flex-wrap text-[10.5px] font-johnson-text text-jj-gray-05"
        style={{ padding: '9px 14px', borderTop: '1px solid #f1efed', background: '#fcfbfa' }}
      >
        <span className="tabular-nums text-jj-gray-07">
          {visible.length} row{visible.length === 1 ? '' : 's'}
          {hidden > 0 ? ` · ${hidden} hidden by search` : ''}
        </span>
        <span style={{ width: 1, height: 10, background: '#e8e6e3' }} />
        <span className="tabular-nums">
          {cols.length} column{cols.length === 1 ? '' : 's'}
        </span>
        <span className="ml-auto">
          {editRow !== null
            ? 'Enter saves · Esc discards'
            : canEdit
            ? 'Hover a row to edit or copy it'
            : 'Hover a row to copy it'}
        </span>
      </div>
    </div>
  );
}

/* ========================================================================
 * DIRECTORY — searchable rail + ownership detail
 * ======================================================================== */

function DomainDirectory({ domains, columns, kpis, query, selected, tab, onTab, onSelect, onLoadDomain, loadingDomain, onToast, canEdit, onSaveRow }) {
  const [sort, setSort] = useState('az');
  const [busy, setBusy] = useState(null);
  const [done, setDone] = useState(null);

  const run = (key, fn) => {
    if (busy) return;
    setBusy(key);
    setDone(null);
    setTimeout(() => {
      fn();
      setBusy(null);
      setDone(key);
      setTimeout(() => setDone((d) => (d === key ? null : d)), 1100);
    }, 620);
  };

  /* Searching ranks by relevance and the sort toggle steps aside — flipping
   * back to A–Z when you've typed something would bury the best hit. */
  const { list, hints, terms } = useMemo(() => {
    const { terms: parsed, results } = searchRecords(domains, query);
    const hintMap = {};
    results.forEach(({ rec, hits }) => {
      if (hits.length) {
        hintMap[rec.domain] = hits
          .map(({ field }) => `${snippet(field.text, parsed, 22)} · ${field.label.toLowerCase()}`)
          .join(', ');
      }
    });
    const rows = results.map((r) => r.rec);
    if (!parsed.length) {
      rows.sort((a, b) => (sort === 'az' ? a.domain.localeCompare(b.domain) : b.count - a.count || a.domain.localeCompare(b.domain)));
    }
    return { list: rows, hints: hintMap, terms: parsed };
  }, [domains, query, sort]);

  const sel = domains.find((d) => d.domain === selected) || list[0] || null;
  const cols = (sel && sel.columns && sel.columns.length ? sel.columns : columns) || KNOWN_COLUMNS;
  const photoFor = useDirectoryPhotos(sel ? [sel.owner, sel.steward, ...sel.sponsors] : []);

  const copy = (text, label) => {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    onToast(label);
  };

  const tabCls = (active) =>
    `pb-2.5 border-0 border-b-2 bg-transparent text-[13px] font-johnson-text flex items-center gap-1.5 ${
      active ? 'border-jj-red font-bold text-jj-gray-08' : 'border-transparent text-jj-gray-06'
    }`;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-jj-gray-01" style={{ animation: `sp-fade .28s ${EASE} both` }}>
      <style>{KEYFRAMES}</style>

      <div className="flex-shrink-0 px-7 pt-4">
        <div className="grid grid-cols-3 gap-px bg-jj-gray-02 border border-jj-gray-02 rounded-2xl overflow-hidden shadow-[0_1px_3px_rgba(49,44,42,.05)]">
          {kpis.map((k) => (
            <div key={k.label} className="bg-white px-[18px] py-[13px] relative overflow-hidden">
              <div className="text-[10.5px] font-johnson-text uppercase tracking-[.08em] text-jj-gray-06 mb-0.5">{k.label}</div>
              <div className="font-johnson-display font-bold text-[22px] tabular-nums text-jj-gray-08">{k.value}</div>
              <div style={{ position: 'absolute', right: -30, bottom: -46, width: 92, height: 92, borderRadius: '50%', border: '1px solid #f2efec', clipPath: 'inset(0 0 50% 0)' }} />
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex gap-4 px-7 pt-4 pb-[22px]">
        {/* ── rail ── */}
        <div className="w-[312px] flex-shrink-0 bg-white border border-jj-gray-02 rounded-[18px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex flex-col overflow-hidden">
          <div className="flex-shrink-0 px-3.5 pt-3 pb-2.5 border-b border-jj-gray-01 flex items-center gap-1.5">
            <span className="flex items-center gap-1.5 px-2.5 py-[5px] rounded-full text-[11px] font-johnson-text border border-jj-gray-02 bg-white text-jj-gray-07">
              All domains <span className="opacity-60 tabular-nums">{domains.length}</span>
            </span>
            <button
              onClick={() => setSort(sort === 'az' ? 'records' : 'az')}
              title="Toggle sort"
              className="ml-auto flex items-center gap-1.5 px-2.5 py-[5px] rounded-full border border-jj-gray-02 bg-white text-[11px] font-johnson-text text-jj-gray-07 hover:border-jj-gray-05"
            >
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4v16M7 20l-3-3M7 4l3 3M17 20V4M17 4l3 3M17 20l-3-3" /></svg>
              {sort === 'az' ? 'A–Z' : 'Records'}
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {list.map((d) => {
              const active = sel && d.domain === sel.domain;
              return (
                <div
                  key={d.domain}
                  onClick={() => {
                    onSelect(d.domain);
                    onLoadDomain(d.domain);
                  }}
                  className="flex items-center gap-2.5 cursor-pointer"
                  style={{
                    padding: '11px 14px 11px 11px',
                    borderBottom: '1px solid #f2efec',
                    borderLeft: `3px solid ${active ? ACCENT : 'transparent'}`,
                    background: active ? '#f9f7f5' : 'transparent',
                    transition: 'background .18s ease, border-color .2s ease',
                  }}
                >
                  <div
                    className="flex-shrink-0 flex items-center justify-center"
                    style={{ width: 30, height: 30, borderRadius: '50%', background: 'linear-gradient(155deg,#fff,#f2efec)', border: '1px solid #e8e6e3', boxShadow: 'inset 0 1.5px 0 rgba(255,255,255,.9), 0 3px 7px -5px rgba(49,44,42,.4)' }}
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke={active ? ACCENT : '#a39992'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={iconFor(d.domain)} /></svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13.5px] font-johnson-text font-medium text-jj-gray-08 truncate">
                      <Highlight text={d.domain} terms={terms} />
                    </div>
                    <div className="text-[11.5px] font-johnson-text text-jj-gray-06 mt-0.5 truncate">
                      {hints[d.domain] ? (
                        <Highlight text={hints[d.domain]} terms={terms} />
                      ) : (
                        d.owner ? d.owner.name : 'No owner assigned'
                      )}
                    </div>
                  </div>
                  <span className="flex-shrink-0 text-[11px] font-johnson-text text-jj-gray-07 bg-jj-gray-01 rounded-full px-2 py-0.5 tabular-nums">{d.count}</span>
                </div>
              );
            })}
            {list.length === 0 && (
              <div className="px-5 py-[34px] text-center text-[12.5px] font-johnson-text text-jj-gray-06">
                Nothing on this page matches that.
              </div>
            )}
          </div>
        </div>

        {/* ── detail ── */}
        <div className="flex-1 min-w-0 bg-white border border-jj-gray-02 rounded-[18px] shadow-[0_1px_3px_rgba(49,44,42,.05)] flex flex-col overflow-hidden relative">
          <div style={{ position: 'absolute', left: '50%', top: -118, width: 640, height: 236, marginLeft: -320, pointerEvents: 'none', borderRadius: '50%', border: '1px solid #f2efec', clipPath: 'inset(0 0 50% 0)' }} />
          {!sel ? (
            <div className="flex-1 flex items-center justify-center text-[12.5px] font-johnson-text text-jj-gray-06">Select a domain.</div>
          ) : (
            <>
              <div className="flex-shrink-0 px-5 pt-[18px] flex items-start gap-4 relative">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="flex-shrink-0 flex items-center justify-center"
                      style={{ width: 34, height: 34, borderRadius: '50%', background: 'linear-gradient(158deg,#fff,#f2efec)', border: '1px solid #e8e6e3', boxShadow: 'inset 0 1.5px 0 rgba(255,255,255,.9), 0 4px 10px -6px rgba(49,44,42,.3)' }}
                    >
                      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke={ACCENT} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                        <path d={iconFor(sel.domain)} pathLength="1" style={{ strokeDasharray: 1, animation: 'sp-draw .8s cubic-bezier(.35,0,.25,1) both' }} />
                      </svg>
                    </div>
                    <h2 className="m-0 font-johnson-display font-bold text-[20px] text-jj-gray-08">{sel.domain}</h2>
                    <span className="text-[11px] font-johnson-text text-jj-gray-07 bg-jj-gray-01 rounded-full px-2.5 py-[3px]">
                      {sel.count} record{sel.count === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="text-[11.5px] font-johnson-text text-jj-gray-05 mt-[7px]">
                    DOMAIN = ‘{sel.domain}’ · {cols.length} column{cols.length === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() =>
                      run('copy', () => {
                        const lines = [];
                        if (sel.owner) lines.push(`Owner: ${sel.owner.name}${sel.owner.email ? ` <${sel.owner.email}>` : ''}`);
                        if (sel.steward) lines.push(`Steward: ${sel.steward.name}${sel.steward.email ? ` <${sel.steward.email}>` : ''}`);
                        sel.sponsors.forEach((s) => lines.push(`Sponsor: ${s.name}${s.email ? ` <${s.email}>` : ''}`));
                        copy(lines.join('\n'), `Contacts for ${sel.domain} copied`);
                      })
                    }
                    className="relative overflow-hidden min-w-[118px] justify-center flex items-center gap-2 px-3.5 py-[7px] rounded-full border border-jj-gray-03 bg-white text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
                  >
                    {busy === 'copy' ? 'Copying…' : done === 'copy' ? 'Copied' : 'Copy contacts'}
                    {busy === 'copy' && <Sweep />}
                  </button>
                  <button
                    onClick={() => run('exportDomain', () => downloadCsv(`${slug(sel.domain)}.csv`, csvFor([sel], cols)))}
                    className="relative overflow-hidden min-w-[82px] justify-center flex items-center gap-2 px-3.5 py-[7px] rounded-full border border-jj-gray-03 bg-white text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01"
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 11l5 5 5-5M4 20h16" /></svg>
                    {busy === 'exportDomain' ? '…' : done === 'exportDomain' ? 'Saved' : 'CSV'}
                    {busy === 'exportDomain' && <Sweep />}
                  </button>
                </div>
              </div>

              <div className="flex-shrink-0 flex gap-[22px] px-5 pt-3.5 mt-3 border-b border-jj-gray-01">
                <button className={tabCls(tab === 'people')} onClick={() => onTab('people')}>Ownership</button>
                <button
                  className={tabCls(tab === 'records')}
                  onClick={() => {
                    onTab('records');
                    onLoadDomain(sel.domain);
                  }}
                >
                  Records <span className="opacity-55 tabular-nums">{sel.count}</span>
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto px-5 pt-[18px] pb-5">
                {tab === 'people' && loadingDomain === sel.domain && !sel.loaded && (
                  <OwnershipSkeleton />
                )}

                {tab === 'people' && !(loadingDomain === sel.domain && !sel.loaded) && (
                  <div className="grid grid-cols-2 gap-3.5" style={{ animation: 'sp-fade .2s ease-out both' }}>
                    <RoleCard label="Data domain owner" dot={ACCENT} tint="rgba(235,23,0,.1)" person={sel.owner} photo={photoFor(sel.owner)} onCopy={copy} />
                    <RoleCard label="Data steward" dot="#0f68b2" tint="rgba(15,104,178,.1)" person={sel.steward} photo={photoFor(sel.steward)} onCopy={copy} />
                    <div className="col-span-2 border border-jj-gray-02 rounded-xl px-[17px] pt-[15px] pb-4">
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#8c3bbb' }} />
                        <span className="text-[10.5px] font-johnson-text font-medium uppercase tracking-[.09em] text-jj-gray-07">Domain sponsors</span>
                        <span className="text-[10.5px] font-johnson-text text-jj-gray-05 tabular-nums">{sel.sponsors.length}</span>
                      </div>
                      {sel.sponsors.length ? (
                        <div className="flex flex-wrap gap-2.5 mt-3">
                          {sel.sponsors.map((s) => (
                            <div
                              key={s.email || s.name}
                              className="flex items-center gap-2.5 border border-jj-gray-01 bg-jj-gray-01/60 rounded-full pl-2 pr-4 py-[7px] hover:-translate-y-0.5 hover:shadow-[0_8px_18px_-12px_rgba(49,44,42,.4)]"
                              style={{ transition: `transform .2s ${EASE}, box-shadow .2s ease` }}
                            >
                              <div
                                className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center overflow-hidden font-johnson-text text-xs font-bold"
                                style={{ background: photoFor(s) ? '#fff' : 'rgba(140,59,187,.1)', color: '#8c3bbb' }}
                              >
                                {photoFor(s) ? (
                                  <img src={photoFor(s)} alt={s.name} className="w-full h-full object-cover" />
                                ) : (
                                  initials(s.name)
                                )}
                              </div>
                              <div className="min-w-0">
                                <div className="text-[13.5px] font-johnson-text font-medium text-jj-gray-08">{s.name}</div>
                                {s.email && (
                                  <button onClick={() => copy(s.email, `Copied ${s.email}`)} title="Copy email" className="p-0 border-0 bg-transparent text-[11.5px] font-johnson-text text-left text-[#0f68b2] hover:text-jj-red hover:underline">
                                    {s.email}
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <NotAssigned />
                      )}
                    </div>

                    <PackageCard
                      record={sel}
                      canEdit={canEdit && !!sel.packageColumns}
                      onSaveRow={onSaveRow}
                      onCopy={copy}
                    />

                    <QualityCard record={sel} onCopy={copy} />
                  </div>
                )}

                {tab === 'records' && (
                  <div style={{ animation: 'sp-fade .2s ease-out both' }}>
                    {loadingDomain === sel.domain && !sel.loaded ? (
                      <TableSkeleton cols={Math.min(cols.length || 5, 6)} />
                    ) : (
                      <RecordsTable
                        record={sel}
                        cols={cols}
                        onCopy={copy}
                        canEdit={canEdit}
                        onSaveRow={(rowIndex, changes, original) => onSaveRow(sel.domain, rowIndex, changes, original)}
                        terms={terms}
                      />
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Sweep({ light }) {
  return (
    <span
      style={{
        position: 'absolute',
        left: 0,
        bottom: 0,
        height: 2,
        width: '100%',
        transformOrigin: '0 50%',
        background: light ? 'rgba(255,255,255,.65)' : ACCENT,
        animation: 'sp-fill .62s linear both',
      }}
    />
  );
}

/* Each package is its own row in the table now — DATA_PACKAGE_LABEL and
 * DATA_PACKAGE_URL side by side — so editing writes straight back to that
 * row's two cells instead of serialising a list into one cell. */
function PackageCard({ record, canEdit, onSaveRow, onCopy }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const [saving, setSaving] = useState(false);

  const packages = record.packages || [];
  const cols = record.packageColumns;

  const start = () => {
    setDraft(packages.map((p) => ({ ...p })));
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setDraft([]);
  };

  const setUrl = (i, value) =>
    setDraft((d) => d.map((row, j) => (j === i ? { ...row, url: value } : row)));

  const setName = (i, value) =>
    setDraft((d) => d.map((row, j) => (j === i ? { ...row, name: value } : row)));

  const save = async () => {
    setSaving(true);
    for (let i = 0; i < draft.length; i++) {
      const p = draft[i];
      const was = packages[i];
      if (p.name === was.name && p.url === was.url) continue;

      const row = record.rows[p.rowIndex];
      const original = Object.fromEntries(
        record.columns.map((c, j) => [c, blank(row[j]) ? null : row[j]])
      );
      const changes = {};
      if (cols.label) changes[cols.label] = p.name;
      if (cols.url) changes[cols.url] = p.url;

      const ok = await onSaveRow(record.domain, p.rowIndex, changes, original);
      if (!ok) {
        setSaving(false);
        return;
      }
    }
    setSaving(false);
    cancel();
  };

  // Nothing stored and no way to add any — don't show an empty shell.
  if (!cols && !packages.length) return null;

  return (
    <div className="col-span-2 border border-jj-gray-02 rounded-xl px-[17px] pt-[15px]">
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: ACCENT }} />
        <span className="text-[10.5px] font-johnson-text font-medium uppercase tracking-[.09em]" style={{ color: ACCENT }}>
          Data package list
        </span>
        {!editing && packages.length > 0 && (
          <span className="text-[10.5px] font-johnson-text text-jj-gray-05 tabular-nums">{packages.length}</span>
        )}
        {canEdit && !editing && (
          <button
            onClick={start}
            className="ml-auto text-[12px] font-johnson-text text-jj-gray-06 hover:text-jj-red"
          >
            Edit
          </button>
        )}
        {editing && (
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={cancel}
              disabled={saving}
              className="text-[12px] font-johnson-text text-jj-gray-06 hover:text-jj-gray-08 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="text-[12px] font-johnson-text font-medium text-white rounded-full px-3 py-1 disabled:opacity-60"
              style={{ background: ACCENT }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="mt-3 flex flex-col gap-2">
          {draft.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={row.name}
                disabled={saving}
                onChange={(e) => setName(i, e.target.value)}
                placeholder={PACKAGE_LABEL}
                className="w-[150px] flex-shrink-0 bg-white border rounded-[8px] text-[13.5px] font-johnson-text font-medium text-jj-gray-08 outline-none focus:border-jj-red"
                style={{ padding: '7px 10px', borderColor: '#e0dcd8' }}
              />
              <input
                value={row.url}
                disabled={saving}
                onChange={(e) => setUrl(i, e.target.value)}
                placeholder="https://…"
                className="flex-1 min-w-0 bg-white border rounded-[8px] text-[13px] font-johnson-text text-jj-gray-08 outline-none focus:border-jj-red"
                style={{ padding: '7px 10px', borderColor: '#e0dcd8' }}
              />
            </div>
          ))}
          {!draft.length && (
            <div className="text-[12.5px] font-johnson-text text-jj-gray-05 py-2">
              No package rows on this domain yet.
            </div>
          )}
        </div>
      ) : packages.length ? (
        <div className="flex flex-col">
          {packages.map((p, i) => (
            <div
              key={`${p.name}-${i}`}
              className="flex items-center gap-2 py-2 px-3.5"
              style={{ borderTop: i ? '1px solid #f1efed' : 0 }}
            >
              {p.url ? (
                <>
                  {/* The url itself is noise on screen — the label carries it,
                      and the tooltip still shows where it goes. */}
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    title={p.url}
                    className="inline-flex items-center gap-1.5 text-[13.5px] font-johnson-text font-medium text-[#0f68b2] hover:text-jj-red hover:underline"
                  >
                    {p.name || PACKAGE_LABEL}
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                      <path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                    </svg>
                  </a>
                  <button
                    onClick={() => onCopy(p.url, 'Link copied')}
                    title="Copy link"
                    className="ml-auto flex-shrink-0 flex items-center justify-center rounded-full border border-jj-gray-02 bg-white text-jj-gray-06 hover:text-jj-red hover:border-jj-red"
                    style={{ width: 26, height: 26 }}
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="11" height="11" rx="2" />
                      <path d="M15 5H6a2 2 0 0 0-2 2v9" />
                    </svg>
                  </button>
                </>
              ) : (
                <>
                  <span className="text-[13.5px] font-johnson-text font-medium text-jj-gray-08">
                    {p.name || PACKAGE_LABEL}
                  </span>
                  <span className="text-[12.5px] font-johnson-text text-jj-gray-05">No link</span>
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <NotAssigned />
      )}
    </div>
  );
}

/* AD groups on the left, per-account query counts on the right. Counts come
 * straight off the monthly columns, so the totals row is added here rather
 * than expecting the table to carry one. */
function QualityCard({ record, onCopy }) {
  const months = record.months || [];
  const usage = record.usage || [];
  const adGroups = record.adGroups || [];
  const { groups, load } = useAdGroupMembers();
  // `open` is which group's tree is expanded on the card; `blownUp` is
  // whether the full-screen panel is also showing. Closing the panel leaves
  // the tree in place — only the chip collapses it.
  const [open, setOpen] = useState(null);
  const [blownUp, setBlownUp] = useState(false);

  if (!adGroups.length && !usage.length) return null;

  const toggle = (g) => {
    if (open === g) {
      setOpen(null);
      setBlownUp(false);
      return;
    }
    setOpen(g);
    setBlownUp(true);
    load(g);
  };

  const totals = months.map((_, i) =>
    usage.reduce((sum, u) => sum + (u.counts[i] || 0), 0)
  );
  const anyCount = totals.some((t) => t > 0);
  const num = (n) => (n === null || n === undefined ? '—' : n.toLocaleString());

  return (
    <div className="col-span-2 border border-jj-gray-02 rounded-xl px-[17px] pt-[15px] pb-4">
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#0f68b2' }} />
        <span className="text-[10.5px] font-johnson-text font-medium uppercase tracking-[.09em]" style={{ color: '#0f68b2' }}>
          Data quality indicators
        </span>
      </div>

      <div className="mt-3">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[11px] font-johnson-text font-medium uppercase tracking-[.08em] text-jj-gray-06">
            AD group
          </span>
          {adGroups.length > 0 && (
            <span className="text-[11.5px] font-johnson-text text-jj-gray-05">
              Click a group to open its membership tree
            </span>
          )}
        </div>
        {adGroups.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
              {adGroups.map((g) => (
                <button
                  key={g}
                  title={`${g} — show members`}
                  onClick={() => toggle(g)}
                  className="flex items-center gap-1.5 text-left text-[13px] font-johnson-text text-jj-gray-08 border rounded-[8px] px-2.5 py-1.5 hover:border-[#0f68b2] hover:text-[#0f68b2] active:scale-[.97]"
                  style={{
                    borderColor: open === g ? '#0f68b2' : '#eceae7',
                    background: open === g ? 'rgba(15,104,178,.06)' : 'rgba(246,244,242,.6)',
                    transform: open === g ? 'translateY(-1px)' : 'none',
                    boxShadow: open === g ? '0 6px 14px -10px rgba(15,104,178,.9)' : 'none',
                    transition: `border-color .15s ease, background .15s ease, transform .18s ${EASE}, box-shadow .18s ease`,
                  }}
                >
                  <svg
                    viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor"
                    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                    className="flex-shrink-0"
                    style={{ transform: `rotate(${open === g ? 90 : 0}deg)`, transition: 'transform .15s ease' }}
                  >
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="truncate">{g}</span>
                  {groups[g]?.loading && (
                    <span
                      className="flex-shrink-0 rounded-full"
                      style={{
                        width: 10, height: 10,
                        border: '1.5px solid rgba(15,104,178,.25)',
                        borderTopColor: '#0f68b2',
                        animation: 'sp-spin .7s linear infinite',
                      }}
                    />
                  )}
                </button>
              ))}
            </div>
        ) : (
          <div className="mt-2 text-[12.5px] font-johnson-text text-jj-gray-05">Not assigned</div>
        )}
      </div>

      {open && (
        <div className="mt-3.5 pt-3.5" style={{ borderTop: '1px solid #f1efed' }}>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[11px] font-johnson-text font-medium uppercase tracking-[.08em] text-jj-gray-06 truncate">
              Members of {open}
            </span>
            <button
              onClick={() => setBlownUp(true)}
              className="ml-auto flex-shrink-0 flex items-center gap-1.5 text-[11.5px] font-johnson-text text-jj-gray-06 hover:text-[#0f68b2]"
            >
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-8 8M3 21l8-8" />
              </svg>
              Expand
            </button>
          </div>
          <GroupMembers group={open} state={groups[open]} onCopy={onCopy} />
        </div>
      )}

      {open && blownUp && (
        <GroupMembersModal
          group={open}
          state={groups[open]}
          onCopy={onCopy}
          onClose={() => setBlownUp(false)}
        />
      )}

      <div className="mt-3.5 pt-3.5" style={{ borderTop: '1px solid #f1efed' }}>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[11px] font-johnson-text font-medium uppercase tracking-[.08em] text-jj-gray-06">
            Usage
          </span>
          {usage.length > 0 && months.length > 0 && (
            <span className="text-[11.5px] font-johnson-text text-jj-gray-05">
              Query counts per account, by month
            </span>
          )}
        </div>
        {usage.length && months.length ? (
          <div className="mt-2 overflow-x-auto">
            <table
              className="border-collapse text-[12.5px] font-johnson-text"
              style={{ border: `1px solid ${CELL}` }}
            >
              <thead>
                <tr>
                  {/* The account column has no month above it, so it spans
                      both header rows instead of sitting under a blank cell. */}
                  <th
                    rowSpan={2}
                    className="text-center align-middle font-medium text-jj-gray-07 px-3 py-1.5 whitespace-nowrap"
                    style={{ border: `1px solid ${CELL}`, background: '#faf8f7' }}
                  >
                    Users / Service Accounts
                  </th>
                  <th
                    colSpan={months.length}
                    className="text-center font-medium px-3 py-1.5"
                    style={{ color: ACCENT, border: `1px solid ${CELL}`, background: '#faf8f7' }}
                  >
                    Query count
                  </th>
                </tr>
                <tr>
                  {months.map((m) => (
                    <th
                      key={m.label}
                      className="text-right font-medium text-jj-gray-07 px-3 py-1.5 whitespace-nowrap"
                      style={{ border: `1px solid ${CELL}`, background: '#faf8f7' }}
                    >
                      {m.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {usage.map((u) => (
                  <tr key={u.account}>
                    <td
                      className="px-3 py-1.5 text-jj-gray-08 whitespace-nowrap"
                      style={{ border: `1px solid ${CELL}` }}
                      title={u.account}
                    >
                      {u.account}
                    </td>
                    {u.counts.map((c, i) => (
                      <td
                        key={i}
                        className="px-3 py-1.5 text-right tabular-nums text-jj-gray-08"
                        style={{ border: `1px solid ${CELL}` }}
                      >
                        {num(c)}
                      </td>
                    ))}
                  </tr>
                ))}
                {anyCount && (
                  <tr>
                    <td
                      className="px-3 py-1.5 font-medium text-jj-gray-08"
                      style={{ border: `1px solid ${CELL}` }}
                    >
                      Total
                    </td>
                    {totals.map((t, i) => (
                      <td
                        key={i}
                        className="px-3 py-1.5 text-right tabular-nums font-medium text-jj-gray-08"
                        style={{ border: `1px solid ${CELL}` }}
                      >
                        {t.toLocaleString()}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-2 text-[12.5px] font-johnson-text text-jj-gray-05">No usage recorded</div>
        )}
      </div>
    </div>
  );
}

/* Org-chart layout: the group on top, its two kinds of member below it, the
 * accounts themselves on the bottom row. Connectors are borders — the half
 * rules on each column are what make the horizontal bar between siblings, so
 * a lone child gets a straight drop instead of a stub sticking out. */
const isServiceAccount = (m) => !m.isUser || /^(sa|svc)[-_]/i.test(m.name || '');

const LINE = '#ded9d5';

// Leaf-row limits. Past WRAP_AT people a branch stops being one long row and
// becomes a WRAP_ROW-wide block instead.
const WRAP_AT = 7;
const WRAP_ROW = 6;
const CARD = 128;
const GAP = 10;

// Grid rule for the usage table.
const CELL = '#d9d5d1';

// Vertical run between a node and the bar below it. It grows downward on a
// delay so the tree draws itself tier by tier instead of appearing at once.
const Drop = ({ h = 16, delay = 0 }) => (
  <span
    style={{
      width: 1, height: h, background: LINE, flexShrink: 0,
      transformOrigin: 'top center',
      animation: `tree-drop .26s ease ${delay}s both`,
    }}
  />
);

/* One column in a sibling row. The top half-rules join up into the bar that
 * spans the siblings; the ends are left open so the bar stops at the outer
 * children rather than running off into space. */
function Branch({ first, last, delay = 0, children }) {
  const only = first && last;
  // Each half-rule unrolls from the middle outward, so the bar reads as one
  // line spreading from the parent rather than two stubs appearing.
  const bar = (side) => ({
    position: 'absolute',
    top: 0,
    [side]: 0,
    width: '50%',
    height: 1,
    background: LINE,
    transformOrigin: side === 'left' ? 'right center' : 'left center',
    animation: `tree-bar .3s ease ${delay}s both`,
  });
  return (
    <div className="relative flex flex-col items-center px-1.5">
      {!only && !first && <span style={bar('left')} />}
      {!only && !last && <span style={bar('right')} />}
      <Drop delay={delay + 0.12} />
      {children}
    </div>
  );
}

function PersonNode({ m, onCopy, delay = 0 }) {
  const [lift, setLift] = useState(false);
  // Promote to its own layer for the entrance, then let it go: holding a
  // layer per person is what fills VRAM-less machines with compositor work.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), (delay + 0.5) * 1000);
    return () => clearTimeout(t);
  }, [delay]);

  return (
    <div
      onMouseEnter={() => setLift(true)}
      onMouseLeave={() => setLift(false)}
      className="flex flex-col items-center gap-1.5 border rounded-[10px] px-2.5 py-2.5 bg-white"
      style={{
        borderColor: lift ? '#0f68b2' : '#e8e6e3',
        width: CARD,
        transform: lift ? 'translateY(-3px)' : 'none',
        boxShadow: lift ? '0 12px 22px -14px rgba(49,44,42,.5)' : '0 1px 0 rgba(49,44,42,.03)',
        transition: `transform .2s ${EASE}, box-shadow .2s ease, border-color .2s ease`,
        animation: `tree-node .42s ${EASE} ${delay}s both`,
        willChange: settled ? 'auto' : 'transform, opacity',
      }}
    >
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center overflow-hidden font-johnson-text text-[11px] font-bold"
        style={{
          background: m.photo ? '#fff' : 'rgba(15,104,178,.1)',
          color: '#0f68b2',
          transform: lift ? 'scale(1.08)' : 'none',
          transition: `transform .2s ${EASE}`,
        }}
      >
        {m.photo ? (
          <img src={m.photo} alt={m.name} className="w-full h-full object-cover" />
        ) : (
          initials(m.name)
        )}
      </div>
      <div className="w-full text-center leading-tight">
        <div
          className="text-[12px] font-johnson-text font-medium text-jj-gray-08 truncate"
          title={m.title || m.name}
        >
          {m.name}
        </div>
        {m.email && (
          <button
            onClick={() => onCopy && onCopy(m.email, `Copied ${m.email}`)}
            title="Copy email"
            className="block w-full p-0 border-0 bg-transparent text-[9.5px] font-johnson-text text-jj-gray-05 hover:text-jj-red hover:underline truncate"
          >
            {m.email}
          </button>
        )}
      </div>
    </div>
  );
}

/* The chart is laid out at its natural size and then scaled to whatever room
 * the card has. Shrinking the whole thing keeps the connectors lined up,
 * which reflowing the nodes into rows would not — but there's a floor, and
 * past it the wrapper scrolls instead of rendering something unreadable. */
const MIN_SCALE = 0.42;

function useFitToWidth(deps) {
  const outer = useRef(null);
  const inner = useRef(null);
  const [fit, setFit] = useState({ scale: 1, w: 0, h: 0, cramped: false });

  useEffect(() => {
    const box = outer.current;
    const chart = inner.current;
    if (!box || !chart) return;

    const measure = () => {
      // A transform is paint-only: the chart keeps its natural layout size
      // however far it's scaled. So the natural size is measured here and the
      // sizer below is given the *scaled* size, which is what stops the
      // parent from scrolling past content that's no longer there.
      const natW = chart.offsetWidth;
      const natH = chart.offsetHeight;
      const availW = box.clientWidth;
      if (!natW || !availW) return;

      const want = availW / natW;
      const scale = Math.max(MIN_SCALE, Math.min(1, want));
      setFit({
        scale,
        w: Math.ceil(natW * scale),
        h: Math.ceil(natH * scale),
        // Below the floor the tree can't shrink further, so the wrapper
        // scrolls rather than silently cutting people off.
        cramped: want < MIN_SCALE,
      });
    };

    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(box);
    obs.observe(chart);
    return () => obs.disconnect();
  }, deps);

  return { outer, inner, ...fit };
}

/* The tree is the point, so it gets the screen rather than a strip inside a
 * card: a scrim, a panel that rises, and the same cascade playing at full
 * size. Escape and the scrim both close it, as does the X. */
function GroupMembersModal({ group, state, onCopy, onClose }) {
  // Portalled to the body, so it sits outside the tier-scoped wrapper the
  // rest of the page lives in — it has to carry the class itself.
  const tier = usePerfTier();
  const lite = tier !== 'full';
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // The card behind keeps its scroll position while the panel is up.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const count = state?.members?.length;

  /* Portalled to the body: the domain sheet this is launched from carries a
   * transform, and a transformed ancestor becomes the containing block for
   * `fixed` children — which pinned the panel inside that sheet and clipped
   * it instead of covering the screen. */
  return createPortal(
    <div
      onClick={onClose}
      className={`sp-panel-scrim fixed inset-0 flex items-center justify-center px-6${
        lite ? ` sp-lite${tier === 'min' ? ' sp-min' : ''}` : ''
      }`}
      style={{
        zIndex: 70,
        background: 'rgba(49,44,42,.34)',
        backdropFilter: 'blur(3px)',
        WebkitBackdropFilter: 'blur(3px)',
        animation: 'sp-fadein .18s ease-out both',
      }}
    >
      <style>{KEYFRAMES}</style>
      {lite && <style>{LITE_CSS}</style>}
      <div
        onClick={(e) => e.stopPropagation()}
        className="sp-panel relative bg-white rounded-2xl overflow-hidden flex flex-col"
        style={{
          width: 'min(1180px, 94vw)',
          /* Content-sized: the chart fits itself to the panel's width and the
             panel takes whatever height that leaves, so a small group gets a
             small panel instead of a screenful of white. */
          maxHeight: '88vh',
          border: '1px solid #e2ddd8',
          boxShadow: '0 40px 90px -40px rgba(49,44,42,.55)',
          // Keeps the browser from re-laying-out or repainting the page
          // behind while the tree animates inside.
          contain: 'layout paint style',
          /* sp-rise ends on translate(-50%,0) — that centres an element
             pinned with left:50%. This panel is centred by flexbox, so it
             needs a keyframe that only moves on Y. */
          animation: `sp-riseflat .34s ${EASE} both`,
        }}
      >
        <div className="flex items-center gap-3 px-6 py-4" style={{ borderBottom: '1px solid #f1efed' }}>
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#0f68b2' }} />
          <div className="min-w-0">
            <div className="text-[10.5px] font-johnson-text font-medium uppercase tracking-[.09em]" style={{ color: '#0f68b2' }}>
              AD group membership
            </div>
            <div className="text-[16px] font-johnson-display font-bold text-jj-gray-08 truncate mt-0.5" title={group}>
              {group}
            </div>
          </div>
          {count > 0 && (
            <span className="text-[11.5px] font-johnson-text text-jj-gray-05 tabular-nums flex-shrink-0">
              {count} member{count === 1 ? '' : 's'}
            </span>
          )}
          <button
            onClick={onClose}
            title="Close"
            className="ml-auto flex-shrink-0 flex items-center justify-center rounded-full border border-jj-gray-02 bg-white text-jj-gray-06 hover:text-jj-red hover:border-jj-red active:scale-95"
            style={{ width: 30, height: 30, transition: `transform .15s ${EASE}, color .15s ease, border-color .15s ease` }}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 overflow-auto px-6 py-6">
          <GroupMembers group={group} state={state} onCopy={onCopy} />
        </div>
      </div>
    </div>,
    document.body
  );
}

function GroupMembers({ group, state, onCopy }) {
  const { loading, error, members } = state || {};

  const branches = members
    ? [
        { key: 'users', label: 'Users', people: members.filter((m) => !isServiceAccount(m)) },
        { key: 'svc', label: 'Service accounts', people: members.filter(isServiceAccount) },
      ].filter((b) => b.people.length)
    : [];

  const { outer, inner, scale, w, h, cramped } = useFitToWidth([members ? members.length : 0]);

  return (
    <div>
      {/* Same three tiers as the real chart, so the layout holds still when
          the directory answers. */}
      {loading && (
        <div className="flex flex-col items-center w-full overflow-hidden" style={{ animation: 'sp-fadein .2s ease-out both' }}>
          <Skeleton w={220} h={30} r={10} />
          <Drop />
          <div className="flex items-start justify-center">
            {[0, 1].map((b) => (
              <div key={b} className="relative flex flex-col items-center px-1.5">
                <span className="absolute" style={{ top: 0, [b ? 'right' : 'left']: 0, width: '50%', height: 1, background: LINE }} />
                <Drop />
                <Skeleton w={116} h={22} r={999} />
                <Drop />
                <div className="flex items-start justify-center">
                  {[0, 1, 2].map((n) => (
                    <div key={n} className="px-1.5">
                      <PersonNodeSkeleton />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 text-[11.5px] font-johnson-text text-jj-gray-05">
            Looking up {group} in the directory…
          </div>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-1.5 text-[12.5px] font-johnson-text text-jj-gray-05">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.01" />
          </svg>
          {error}
        </div>
      )}
      {members && !members.length && (
        <div className="text-[12.5px] font-johnson-text text-jj-gray-05">No members in this group</div>
      )}

      {branches.length > 0 && (
        <div
          key={group}
          ref={outer}
          className={`w-full flex items-center justify-center ${
            cramped ? 'overflow-auto' : 'overflow-hidden'
          }`}
          style={{ height: h || undefined }}
        >
          {/* Sizer carries the scaled footprint so the scrollable area is the
              size of what you can see, not the pre-scale layout box. */}
          <div className="relative flex-shrink-0" style={{ width: w || undefined, height: h || undefined }}>
            <div
              ref={inner}
              className="absolute top-0 left-0 inline-flex flex-col items-center"
              style={{ width: 'max-content', transform: `scale(${scale})`, transformOrigin: 'top left' }}
            >
            <div
              className="relative inline-flex items-center gap-2 border rounded-[10px] px-3.5 py-2"
              style={{
                borderColor: '#0f68b2',
                background: 'rgba(15,104,178,.06)',
                animation: `tree-root .34s ${EASE} both`,
              }}
            >
              {/* Its own layer, so the pulse never repaints the chip. */}
              <span
                style={{
                  position: 'absolute', inset: -1, borderRadius: 11,
                  border: '2px solid rgba(15,104,178,.5)', pointerEvents: 'none',
                  animation: 'tree-pulsering 1.6s ease-out .3s 2 both',
                }}
              />
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#0f68b2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="8" r="3" />
                <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a3 3 0 1 0-2-5.2M21 20c0-2.5-1.6-4.6-3.8-5.4" />
              </svg>
              <span className="text-[12.5px] font-johnson-text font-medium text-jj-gray-08">{group}</span>
              <span className="text-[11px] font-johnson-text text-jj-gray-05 tabular-nums">{members.length}</span>
            </div>

            <Drop delay={0.24} />

            <div className="flex items-start justify-center">
              {branches.map((b, i) => (
                <Branch key={b.key} first={i === 0} last={i === branches.length - 1} delay={0.36}>
                  <div
                    className="inline-flex items-center gap-1.5 border rounded-full px-3 py-1"
                    style={{
                      borderColor: '#e0dcd8', background: '#faf8f7',
                      animation: `tree-node .34s ${EASE} ${0.54 + i * 0.08}s both`,
                    }}
                  >
                    <span className="text-[10.5px] font-johnson-text font-medium uppercase tracking-[.07em] text-jj-gray-07 whitespace-nowrap">
                      {b.label}
                    </span>
                    <span className="text-[10.5px] font-johnson-text text-jj-gray-05 tabular-nums">{b.people.length}</span>
                  </div>

                  <Drop delay={0.68 + i * 0.08} />

                  {b.people.length > WRAP_AT ? (
                    /* Past a handful, one row would be wider than any screen
                       and the whole tree gets scaled into a sliver. Wrapping
                       into a block keeps the cards readable — the elbow per
                       person goes, the bar over the block stands in for it. */
                    <div className="relative pt-3" style={{ width: WRAP_ROW * (CARD + GAP) - GAP }}>
                      <span
                        className="absolute"
                        style={{
                          top: 0, left: 0, right: 0, height: 1, background: LINE,
                          transformOrigin: 'center',
                          animation: `tree-bar .3s ease ${0.68 + i * 0.08}s both`,
                        }}
                      />
                      <div className="flex flex-wrap justify-center" style={{ gap: GAP }}>
                        {b.people.map((m, j) => (
                          <PersonNode
                            key={m.id || m.email || m.name}
                            m={m}
                            onCopy={onCopy}
                            delay={0.9 + i * 0.08 + j * 0.03}
                          />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-center">
                      {b.people.map((m, j) => (
                        <Branch
                          key={m.id || m.email || m.name}
                          first={j === 0}
                          last={j === b.people.length - 1}
                          delay={0.8 + i * 0.08}
                        >
                          {/* leaves land left to right, so the row fills in
                              rather than popping as a block */}
                          <PersonNode m={m} onCopy={onCopy} delay={1 + i * 0.08 + j * 0.055} />
                        </Branch>
                      ))}
                    </div>
                  )}
                </Branch>
              ))}
            </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* Grey block that shimmers while real content is on its way. Sized by the
 * caller so a skeleton can mirror the shape of whatever it stands in for. */
function Skeleton({ w = '100%', h = 12, r = 6, className = '', style = {} }) {
  return (
    <span
      className={`relative block overflow-hidden ${className}`}
      style={{ width: w, height: h, borderRadius: r, background: '#eeebe8', ...style }}
    >
      <span
        className="sp-skeleton-sheen"
        style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(100deg, rgba(255,255,255,0), rgba(255,255,255,.9), rgba(255,255,255,0))',
          animation: 'sp-shimmer 1.4s ease-in-out infinite',
        }}
      />
    </span>
  );
}

/* Stand-in for one person node in the org chart, same box as PersonNode so
 * the tree doesn't jump when the real members arrive. */
function PersonNodeSkeleton() {
  return (
    <div
      className="flex flex-col items-center gap-1.5 border rounded-[10px] px-2.5 py-2.5 bg-white"
      style={{ borderColor: '#e8e6e3', width: CARD }}
    >
      <Skeleton w={36} h={36} r={999} />
      <Skeleton w="80%" h={9} />
      <Skeleton w="62%" h={7} />
    </div>
  );
}

/* The ownership tab renders from row data that arrives after the modal opens.
 * Without this the cards flash through empty and then fill, which reads as
 * "nothing assigned" for a beat. */
function OwnershipSkeleton() {
  const card = "border border-jj-gray-02 rounded-xl px-[17px] pt-[15px] pb-4";
  return (
    <div className="grid grid-cols-2 gap-3.5" style={{ animation: 'sp-fadein .2s ease-out both' }}>
      {[0, 1].map((i) => (
        <div key={i} className={`${card} flex flex-col gap-3`}>
          <Skeleton w={110} h={9} />
          <div className="flex items-center gap-3">
            <Skeleton w={40} h={40} r={999} />
            <div className="flex-1 flex flex-col gap-1.5">
              <Skeleton w="55%" h={11} />
              <Skeleton w="72%" h={9} />
            </div>
          </div>
        </div>
      ))}

      <div className={`col-span-2 ${card}`}>
        <Skeleton w={120} h={9} />
        <div className="flex flex-wrap gap-2.5 mt-3">
          {[180, 210, 165].map((w, i) => (
            <Skeleton key={i} w={w} h={44} r={999} />
          ))}
        </div>
      </div>

      <div className={`col-span-2 ${card}`}>
        <Skeleton w={130} h={9} />
        <div className="mt-3 flex flex-col gap-2.5">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton w={120} h={11} />
              <Skeleton w="45%" h={10} />
            </div>
          ))}
        </div>
      </div>

      <div className={`col-span-2 ${card}`}>
        <Skeleton w={150} h={9} />
        <div className="mt-3 flex flex-wrap gap-1.5">
          {[220, 190].map((w, i) => (
            <Skeleton key={i} w={w} h={32} r={8} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* Mirrors the records table's header-plus-rows shape while the query runs. */
function TableSkeleton({ cols = 5, rows = 6 }) {
  return (
    <div style={{ animation: 'sp-fadein .2s ease-out both' }}>
      <div
        className="flex gap-4 px-3 py-2.5"
        style={{ borderBottom: '1px solid #e8e6e3', background: '#faf8f7' }}
      >
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} w={i === 0 ? '22%' : '16%'} h={9} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 px-3 py-3" style={{ borderBottom: '1px solid #f1efed' }}>
          {Array.from({ length: cols }, (_, i) => (
            <Skeleton key={i} w={i === 0 ? '22%' : '16%'} h={11} style={{ opacity: 1 - r * 0.11 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

function RoleCard({ label, dot, tint, person, photo, onCopy }) {
  return (
    <div
      className="rounded-xl px-[17px] pt-[15px] pb-4 flex flex-col gap-3"
      style={{ border: `1px ${person ? 'solid #e8e6e3' : 'dashed #ded8d2'}`, background: person ? '#fff' : '#faf8f7' }}
    >
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: dot }} />
        <span className="text-[10.5px] font-johnson-text font-medium uppercase tracking-[.09em] text-jj-gray-07">{label}</span>
      </div>
      {person ? (
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center overflow-hidden font-johnson-text text-[13.5px] font-bold"
            style={{
              background: photo ? '#fff' : tint,
              color: dot,
              boxShadow: photo ? 'none' : 'inset 0 1px 0 rgba(255,255,255,.7)',
            }}
          >
            {photo ? (
              <img src={photo} alt={person.name} className="w-full h-full object-cover" />
            ) : (
              initials(person.name)
            )}
          </div>
          <div className="min-w-0">
            <div className="text-[15px] font-johnson-text font-medium text-jj-gray-08">{person.name}</div>
            {person.email && (
              <button onClick={() => onCopy(person.email, `Copied ${person.email}`)} title="Copy email" className="mt-0.5 p-0 border-0 bg-transparent text-xs font-johnson-text text-left text-[#0f68b2] hover:text-jj-red hover:underline">
                {person.email}
              </button>
            )}
          </div>
        </div>
      ) : (
        <NotAssigned />
      )}
    </div>
  );
}

function NotAssigned() {
  return (
    <div className="flex items-center gap-3 border border-dashed border-jj-gray-03 rounded-xl px-3.5 py-3 bg-jj-gray-01/50 mt-3">
      <div>
        <div className="text-[13px] font-johnson-text font-medium text-jj-gray-07">Not assigned</div>
        <div className="text-[11.5px] font-johnson-text text-jj-gray-06 mt-px">Column is null for every record in this domain.</div>
      </div>
    </div>
  );
}

/* ========================================================================
 * PAGE — data loading, header, screen switch
 * ======================================================================== */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

async function fetchJson(url) {
  const res = await apiFetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${res.status})`);
  }
  return res.json();
}

export default function GraDataDomains() {
  const [records, setRecords] = useState([]);
  const [columns, setColumns] = useState(KNOWN_COLUMNS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  /* ── URL is the source of truth for the screen, the selected domain, the
   * open sheet, the detail tab, and the search text, so every state is
   * linkable and the browser's back button steps through it:
   *   ?view=directory&domain=ind_cta&tab=records   directory, records tab
   *   ?domain=cmc&open=1                           orbit with the sheet open
   *   ?q=feld                                      search carried in the link
   * Domains travel as their slug, so the link survives spaces and slashes. */
  const [params, setParams] = useSearchParams();
  const patch = useCallback(
    (changes, opts) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        Object.keys(changes).forEach((k) => {
          const v = changes[k];
          if (v === null || v === undefined || v === '') next.delete(k);
          else next.set(k, v);
        });
        return next;
      }, opts);
    },
    [setParams]
  );

  const screen = params.get('view') === 'directory' ? 'directory' : 'orbit';
  const tab = params.get('tab') === 'records' ? 'records' : 'people';
  const domainParam = params.get('domain');
  const openParam = params.get('open') === '1';
  const urlQuery = params.get('q') || '';

  // Typing stays local and is mirrored into ?q= on the trailing edge, so the
  // history never grows one entry per keystroke.
  const [query, setQuery] = useState(urlQuery);
  const queryTimer = useRef(null);
  const queryRef = useRef(urlQuery);
  const setQueryParam = useCallback(
    (v) => {
      setQuery(v);
      queryRef.current = v;
      clearTimeout(queryTimer.current);
      queryTimer.current = setTimeout(() => patch({ q: v || null }, { replace: true }), 320);
    },
    [patch]
  );
  useEffect(() => () => clearTimeout(queryTimer.current), []);
  useEffect(() => {
    // back/forward onto a different ?q= re-syncs the field
    if (urlQuery !== queryRef.current) {
      queryRef.current = urlQuery;
      setQuery(urlQuery);
    }
  }, [urlQuery]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeHit, setActiveHit] = useState(-1);
  const searchBoxRef = useRef(null);
  const searchInputRef = useRef(null);

  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(null);
  const [doneKey, setDoneKey] = useState(null);
  const [loadingDomain, setLoadingDomain] = useState(null);
  const headerRef = useRef(null);
  const toastTimer = useRef(null);

  const showToast = useCallback((msg) => {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 1900);
  }, []);

  const run = (key, fn) => {
    if (busy) return;
    setBusy(key);
    setDoneKey(null);
    setTimeout(() => {
      fn();
      setBusy(null);
      setDoneKey(key);
      setTimeout(() => setDoneKey((d) => (d === key ? null : d)), 1100);
    }, 620);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const listRes = await fetchJson(`${API_BASE_URL}/api/gra-data-domains/domains`);
      const domains = listRes.domains || [];
      const details = await Promise.all(
        domains.map((d) =>
          fetchJson(`${API_BASE_URL}/api/gra-data-domains/data?domain=${encodeURIComponent(d.domain)}`).catch(() => null)
        )
      );
      const built = domains.map((d, i) => {
        const detail = details[i];
        return buildDomainRecord(d.domain, d.count, detail?.columns || [], detail?.rows || []);
      });
      const firstCols = details.find((x) => x && x.columns && x.columns.length);
      if (firstCols) setColumns(firstCols.columns);
      setRecords(built);
    } catch (e) {
      setError(e.message || 'Failed to load domains');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => clearTimeout(toastTimer.current);
  }, [load]);

  const loadDomain = useCallback(
    async (domain) => {
      const existing = records.find((r) => r.domain === domain);
      if (!existing || existing.loaded) return;
      setLoadingDomain(domain);
      try {
        const data = await fetchJson(`${API_BASE_URL}/api/gra-data-domains/data?domain=${encodeURIComponent(domain)}`);
        setRecords((prev) =>
          prev.map((r) => (r.domain === domain ? buildDomainRecord(domain, r.count, data.columns || [], data.rows || []) : r))
        );
      } catch (e) {
        showToast(e.message || 'Failed to load domain');
      } finally {
        setLoadingDomain(null);
      }
    },
    [records, showToast]
  );

  const { hasPermission } = useRBAC();
  const canEdit = hasPermission('editGraDataDomains');

  /* One row, one PUT. The backend matches on the values we last read, so a
   * 409 here means someone else touched the row — we say so and leave the
   * grid alone rather than papering over their edit. The record is rebuilt
   * from the new rows so the arch's owner/steward reflect the change too. */
  const saveRow = useCallback(
    async (domain, rowIndex, changes, original) => {
      try {
        const res = await apiFetch(`${API_BASE_URL}/api/gra-data-domains/row`, {
          method: 'PUT',
          body: { domain, original, changes },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail || `Save failed (${res.status})`);
        }
      } catch (e) {
        showToast(e.message || 'Save failed');
        return false;
      }

      setRecords((prev) =>
        prev.map((rec) => {
          if (rec.domain !== domain) return rec;
          const rows = rec.rows.map((row, i) =>
            i === rowIndex
              ? row.map((v, j) => {
                  const col = rec.columns[j];
                  if (!(col in changes)) return v;
                  return changes[col] === '' ? null : changes[col];
                })
              : row
          );
          return buildDomainRecord(domain, rec.count, rec.columns, rows);
        })
      );
      showToast(`Saved · ${domain}`);
      return true;
    },
    [showToast]
  );

  // ?domain= resolves once the rows land; falls back to the first domain.
  const selected = useMemo(() => {
    if (!records.length) return null;
    if (domainParam) {
      const hit = records.find((r) => slug(r.domain) === domainParam || r.domain === domainParam);
      if (hit) return hit.domain;
    }
    return records[0].domain;
  }, [records, domainParam]);

  const opened = openParam && selected ? selected : null;

  // A deep link that lands on the sheet or the records tab fetches that
  // domain's rows without the user having to click anything.
  useEffect(() => {
    if (selected && (opened || tab === 'records')) loadDomain(selected);
  }, [selected, opened, tab, loadDomain]);

  const kpis = useMemo(() => {
    const people = new Set();
    records.forEach((d) => {
      [d.owner, d.steward, ...d.sponsors].filter(Boolean).forEach((p) => people.add((p.email || p.name).toLowerCase()));
    });
    return [
      { label: 'Domains', value: records.length },
      { label: 'Records', value: records.reduce((n, d) => n + (d.count || 0), 0) },
      { label: 'Named people', value: people.size },
    ];
  }, [records]);

  /* ── header search ──
   * One pass over every record, reused by the dropdown; the orbit and the
   * directory run their own so they stay usable on their own. */
  const { terms: searchTerms, results: searchResults } = useMemo(
    () => searchRecords(records, query),
    [records, query]
  );

  // Clicking a result jumps to that domain in the directory, on the tab where
  // the match actually lives — a hit in the grid opens the grid.
  const pickResult = useCallback(
    (rec, field) => {
      patch({
        view: 'directory',
        domain: slug(rec.domain),
        tab: field && field.tab === 'records' ? 'records' : null,
      });
      loadDomain(rec.domain);
      setPanelOpen(false);
      setActiveHit(-1);
    },
    [patch, loadDomain]
  );

  const onSearchKey = useCallback(
    (e) => {
      const shown = Math.min(searchResults.length, 8);
      if (e.key === 'Escape') {
        setPanelOpen(false);
        setActiveHit(-1);
        e.currentTarget.blur();
        return;
      }
      if (!searchTerms.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPanelOpen(true);
        if (!shown) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActiveHit((i) => (i < 0 ? (step === 1 ? 0 : shown - 1) : (i + step + shown) % shown));
        return;
      }
      if (e.key === 'Enter') {
        const pickIndex = activeHit >= 0 ? activeHit : 0;
        const hit = searchResults[pickIndex];
        if (hit) {
          e.preventDefault();
          pickResult(hit.rec, hit.hits[0] && hit.hits[0].field);
        }
      }
    },
    [searchResults, searchTerms, activeHit, pickResult]
  );

  // Clicking anywhere else puts the panel away.
  useEffect(() => {
    if (!panelOpen) return undefined;
    const away = (e) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) setPanelOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [panelOpen]);

  // Ctrl/Cmd-K and "/" land in the box, the way every other search box works.
  useEffect(() => {
    const hotkey = (e) => {
      const typing = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    document.addEventListener('keydown', hotkey);
    return () => document.removeEventListener('keydown', hotkey);
  }, []);

  const openedRecord = records.find((r) => r.domain === opened) || null;

  const copyContactsFor = (rec) => {
    if (!rec) return;
    const lines = [];
    if (rec.owner) lines.push(`Owner: ${rec.owner.name}${rec.owner.email ? ` <${rec.owner.email}>` : ''}`);
    if (rec.steward) lines.push(`Steward: ${rec.steward.name}${rec.steward.email ? ` <${rec.steward.email}>` : ''}`);
    rec.sponsors.forEach((s) => lines.push(`Sponsor: ${s.name}${s.email ? ` <${s.email}>` : ''}`));
    if (navigator.clipboard) navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
    showToast(`Contacts for ${rec.domain} copied`);
  };

  const onOrbit = screen === 'orbit';
  const segBtn = 'relative z-10 w-[80px] py-[6px] rounded-full border-0 bg-transparent text-[11.5px] font-johnson-text transition-colors';

  return (
    <div className="h-full flex flex-col overflow-hidden bg-jj-gray-01">
      <style>{KEYFRAMES}</style>

      {/* ── page header ── */}
      <div
        ref={headerRef}
        className="flex-shrink-0 relative z-40 bg-white border-b border-jj-gray-02 px-7 pt-4 pb-3.5 flex items-end gap-3 xl:gap-5 flex-wrap xl:flex-nowrap"
      >
        <div className="flex-shrink-0 whitespace-nowrap">
          <h1 className="m-0 font-johnson-display font-bold text-[24px] tracking-[-.01em] text-jj-gray-08">Structured Explorer</h1>
          <p className="mt-1 mb-0 text-[13px] font-johnson-text text-jj-gray-06">
            Who sponsors, stewards, and owns every structured data domain.
          </p>
        </div>

        {/* screen switch, centred on the header rather than riding the actions */}
        <div className="hidden xl:flex absolute left-1/2 -translate-x-1/2 bottom-3.5 items-center">
          <div className="relative flex flex-shrink-0 p-[3px] bg-jj-gray-01 rounded-full">
            <div
              className="absolute top-[3px] left-[3px] w-[80px] rounded-full bg-white shadow-[0_1px_3px_rgba(49,44,42,.18)]"
              style={{ height: 'calc(100% - 6px)', transform: onOrbit ? 'translateX(0)' : 'translateX(80px)', transition: `transform .36s ${EASE}` }}
            />
            <button className={`${segBtn} ${onOrbit ? 'text-jj-gray-08 font-medium' : 'text-jj-gray-06'}`} onClick={() => patch({ view: null })}>Orbit</button>
            <button className={`${segBtn} ${!onOrbit ? 'text-jj-gray-08 font-medium' : 'text-jj-gray-06'}`} onClick={() => patch({ view: 'directory' })}>Directory</button>
          </div>
        </div>

        <div className="flex items-center gap-2 min-w-0 w-full xl:w-auto xl:ml-auto justify-start xl:justify-end">
          <div className="xl:hidden flex">
          <div className="relative flex flex-shrink-0 p-[3px] bg-jj-gray-01 rounded-full">
            <div
              className="absolute top-[3px] left-[3px] w-[80px] rounded-full bg-white shadow-[0_1px_3px_rgba(49,44,42,.18)]"
              style={{ height: 'calc(100% - 6px)', transform: onOrbit ? 'translateX(0)' : 'translateX(80px)', transition: `transform .36s ${EASE}` }}
            />
            <button className={`${segBtn} ${onOrbit ? 'text-jj-gray-08 font-medium' : 'text-jj-gray-06'}`} onClick={() => patch({ view: null })}>Orbit</button>
            <button className={`${segBtn} ${!onOrbit ? 'text-jj-gray-08 font-medium' : 'text-jj-gray-06'}`} onClick={() => patch({ view: 'directory' })}>Directory</button>
          </div>
          </div>

          <div ref={searchBoxRef} className="relative flex items-center flex-1 xl:flex-none" style={{ flexBasis: 280, minWidth: 150, maxWidth: 280 }}>
            <svg viewBox="0 0 24 24" width="13" height="13" className="absolute left-3 pointer-events-none" fill="none" stroke="#a39992" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4.3-4.3" /></svg>
            <input
              ref={searchInputRef}
              value={query}
              onChange={(e) => {
                setQueryParam(e.target.value);
                setPanelOpen(true);
                setActiveHit(-1);
              }}
              onFocus={() => setPanelOpen(true)}
              onKeyDown={onSearchKey}
              placeholder="Search anything on this page…"
              title="Words are ANDed, “quotes” match a phrase, -word excludes"
              className="w-full pl-8 pr-8 py-2 text-[12.5px] font-johnson-text text-jj-gray-08 border border-jj-gray-03 rounded-full outline-none bg-white focus:border-[#0f68b2] focus:shadow-[0_0_0_3px_rgba(15,104,178,.1)]"
            />
            {query && (
              <button
                onClick={() => {
                  setQueryParam('');
                  setPanelOpen(false);
                  searchInputRef.current?.focus();
                }}
                title="Clear search"
                className="absolute right-2.5 flex items-center justify-center rounded-full border-0 bg-jj-gray-01 text-jj-gray-06 hover:text-jj-gray-08"
                style={{ width: 17, height: 17 }}
              >
                <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            )}

            {panelOpen && searchTerms.length > 0 && (
              <SearchPanel
                results={searchResults}
                terms={searchTerms}
                activeIndex={activeHit}
                onHover={setActiveHit}
                onPick={pickResult}
                onClose={() => setPanelOpen(false)}
              />
            )}
          </div>

          <button
            onClick={() => run('refresh', () => { load(); showToast('Re-queried UNSTRUCTURED_PACKAGES'); })}
            title="Re-query Snowflake"
            className="relative overflow-hidden min-w-[106px] justify-center whitespace-nowrap flex items-center gap-2 px-3.5 py-[7px] rounded-full border border-jj-gray-03 bg-white text-[11.5px] font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01 active:scale-[.97]"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ animation: busy === 'refresh' ? 'sp-spin .7s cubic-bezier(.45,.05,.35,1) both' : 'none' }}>
              <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" />
            </svg>
            {busy === 'refresh' ? 'Querying…' : doneKey === 'refresh' ? 'Up to date' : 'Refresh'}
          </button>

          <button
            onClick={() => run('exportAll', () => downloadCsv('gra_data_domains.csv', csvFor(records, columns)))}
            className="relative overflow-hidden min-w-[120px] justify-center whitespace-nowrap flex items-center gap-2 px-3.5 py-[7px] rounded-full border border-jj-gray-08 bg-jj-gray-08 text-white text-[11.5px] font-johnson-text hover:bg-jj-red hover:border-jj-red active:scale-[.97]"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 11l5 5 5-5M4 20h16" /></svg>
            {busy === 'exportAll' ? 'Preparing…' : doneKey === 'exportAll' ? 'Downloaded' : 'Export all'}
            {busy === 'exportAll' && <Sweep light />}
          </button>
        </div>
      </div>

      {loading && <div className="flex-1 flex justify-center items-center"><LoadingSpinner /></div>}

      {!loading && error && (
        <div className="flex-1 flex justify-center items-start pt-16 px-7">
          <div className="max-w-lg w-full px-4 py-3 rounded-xl bg-red-50 border border-jj-maroon-05 text-jj-maroon-05 text-sm font-johnson-text">{error}</div>
        </div>
      )}

      {!loading && !error && records.length === 0 && (
        <div className="flex-1 flex justify-center items-center text-jj-gray-06 font-johnson-text">No domains found.</div>
      )}

      {!loading && !error && records.length > 0 && onOrbit && (

        <DomainOrbit
          domains={records}
          query={query}
          headerRef={headerRef}
          onOpen={(domain) => {
            patch({ domain: slug(domain), open: '1' });
            loadDomain(domain);
          }}
        />
      )}

      {!loading && !error && records.length > 0 && !onOrbit && (

        <DomainDirectory
          domains={records}
          columns={columns}
          kpis={kpis}
          query={query}
          selected={selected}
          tab={tab}
          onTab={(id) => patch({ tab: id === 'records' ? 'records' : null })}
          onSelect={(d) => patch({ domain: slug(d) })}
          onLoadDomain={loadDomain}
          loadingDomain={loadingDomain}
          onToast={showToast}
          canEdit={canEdit}
          onSaveRow={saveRow}
        />
      )}

      {openedRecord && (
        <OpenedDomain
          record={openedRecord}
          copyLabel="Copy contacts"
          onClose={() => patch({ open: null })}
          onCopyContacts={() => copyContactsFor(openedRecord)}
          onOpenDirectory={() => patch({ open: null, view: 'directory' })}
        />
      )}

      {toast && (
        <div
          className="fixed right-[26px] bottom-[22px] z-[80] flex items-center gap-2.5 bg-jj-gray-08 text-white px-4 py-[11px] rounded-full text-[12.5px] font-johnson-text shadow-[0_14px_34px_-12px_rgba(49,44,42,.6)]"
          style={{ animation: `sp-toast .22s ${EASE} both` }}
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7" /></svg>
          {toast}
        </div>
      )}
    </div>
  );
}