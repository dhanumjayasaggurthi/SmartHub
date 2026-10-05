import React, { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useRBAC } from '../context/RBACContext';
import { TOOL_CATALOG, newFirst } from '../config/tools';
import { readRecentTools } from '../utils/recentTools';
import { apiJson } from '../utils/apiClient';
import { getTier } from '../utils/perfTier';
import './Dashboard.css';

import arrowIcon  from "/icons/JJ_Icon_Chevron_Right.svg";
import searchIcon from "/icons/JJ_Icon_Search_RGB.svg";
import shieldIcon from "/icons/JJ_Icon_Shield_RGB.svg";

// Header's search button fires this; the palette lives here on the dashboard.
export const PALETTE_EVENT = 'smarthub:open-palette';

const ACCENT_HEX = {
  red: '#eb1700', blue: '#0f68b2', violet: '#8c3bbb', green: '#328714',
  gray: '#6e6259', dgray: '#312c2a', orange: '#ff6017',
};

// Labels under the orbit bubbles - the full titles are far too long to sit there.
const ORBIT_LABEL = {
  dqe: 'DQE', rag: 'RAG', 'fuzzy-match': 'Fuzzy', 'ai-chatbot': 'Assistant',
  'data-type-validation': 'Types', 'data-api': 'Data API', unstructured: 'Unstructured',
  'gra-data-domains': 'Structured', 'data-studio': 'Studio', 'user-management': 'Users',
  'communication-center': 'Comms', audit: 'Audit',
};

const HEADLINES = ['Where shall we begin?', 'Your data, already in order.', 'Every check, one hub.', 'Ask. Explore. Validate.'];
const SEARCH_HINTS = ['Search tools, sections, workspaces…', 'Try “snowflake”', 'Try “validation”', 'Try “audit”', 'Try “RIMDocs agentic”'];
const RECENT_WINDOW = 30 * 86400000; // readRecentTools drops anything older

const KIND_TAG = {
  feature:     ['New', '#0f68b2'],
  improvement: ['Update', '#8c3bbb'],
  fix:         ['Fix', '#ff6017'],
  removal:     ['Removed', '#6e6259'],
};

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

// Windows Cloud PCs have no GPU and report reduced motion (OS animations are
// off there by default). Neither is a reason to freeze the page: both only
// start it on the lighter scene, the same rule the other welcome screens use.
// getTier() covers both cases.

// One frame-budget watcher shared by both canvases. It samples the raw rAF
// cadence - not the 30fps-gated draws, which would always read as slow - and
// if frames run long it flips to lite for good so the CSS can drop its extras.
const PERF = {
  lite: getTier() !== 'full', n: 0, sum: 0, last: 0, listeners: new Set(),
  sample(t) {
    if (this.last) {
      const d = t - this.last;
      if (d < 250) {
        this.sum += d; this.n += 1;
        if (this.n >= 45) {
          if (this.sum / this.n > 26 && !this.lite) {
            this.lite = true;
            this.listeners.forEach(fn => fn());
          }
          this.n = 0; this.sum = 0;
        }
      }
    }
    this.last = t;
  },
};

const mask = (src) => ({ '--i': `url("${src}")` });
const Ico = ({ src, className = '' }) => <span aria-hidden="true" className={`shd-ico ${className}`} style={mask(src)} />;

// 1x backing store on purpose: a 2x store is 4x the pixels for a CPU to fill.
const fitCanvas = (canvas) => {
  const w = Math.max(1, Math.round(canvas.clientWidth)), h = Math.max(1, Math.round(canvas.clientHeight));
  canvas.width = w;
  canvas.height = h;
  return { ctx: canvas.getContext('2d'), w, h };
};

const timeAgo = (ts) => {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
};

// AD display names come through as "Last, First [Company]" as often as not.
const firstNameOf = (name) => {
  const clean = name.replace(/\s*\[.*?\]\s*/g, '').trim();
  const given = clean.includes(',') ? clean.split(',')[1].trim() : clean;
  return given.split(/\s+/)[0] || clean;
};

// ─── Ambient field ─────────────────────────────────────────────────────────────
// Drifting grid, falling streams and a particle mesh that reaches for the cursor.
const AmbientField = ({ pointer, visible }) => {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    let g = fitCanvas(canvas);
    let nodes = [], streams = [];

    const build = () => {
      const cap = PERF.lite ? 44 : 80;
      const count = Math.max(18, Math.round(Math.min(cap, (g.w * g.h) / 22000)));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * g.w, y: Math.random() * g.h,
        vx: (Math.random() - .5) * .18, vy: (Math.random() - .5) * .18,
        r: 1 + Math.random() * 1.4, hue: Math.random() < .68 ? 0 : 1,
      }));
      streams = Array.from({ length: PERF.lite ? 7 : 12 }, () => ({
        x: Math.random(), y: Math.random() * g.h, len: 60 + Math.random() * 160,
        sp: .5 + Math.random() * 1.4, hue: Math.random() < .6 ? 0 : 1,
      }));
    };
    build();

    const obs = new ResizeObserver(() => { g = fitCanvas(canvas); build(); });
    obs.observe(canvas);

    const LINE = ['rgba(15,104,178,.16)', 'rgba(140,59,187,.14)'];
    const DOT = ['rgba(15,104,178,.5)', 'rgba(140,59,187,.45)'];
    let raf, last = 0, wasLite = PERF.lite;

    const draw = (t) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden || !visible.current) { PERF.last = 0; return; }
      PERF.sample(t);
      if (t - last < (PERF.lite ? 50 : 33)) return;
      last = t;
      if (PERF.lite !== wasLite) { wasLite = PERF.lite; build(); }

      const { ctx, w, h } = g, gap = 76;
      const p = pointer.current;
      const ox = -(p.x - .5) * 34, oy = -(p.y - .5) * 22;
      ctx.clearRect(0, 0, w, h);

      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(175,165,155,.085)';
      ctx.beginPath();
      for (let x = -gap; x < w + gap; x += gap) { const fx = x + ox + (t / 70) % gap; ctx.moveTo(fx, 0); ctx.lineTo(fx, h); }
      for (let y = -gap; y < h + gap; y += gap) { ctx.moveTo(0, y + oy); ctx.lineTo(w, y + oy); }
      ctx.stroke();

      for (let hue = 0; hue < 2; hue++) {
        ctx.strokeStyle = LINE[hue];
        ctx.beginPath();
        for (const s of streams) {
          if (s.hue !== hue) continue;
          s.y += s.sp;
          if (s.y - s.len > h) { s.y = -s.len; s.x = Math.random(); }
          const sx = s.x * w + ox * 1.6;
          ctx.moveTo(sx, s.y - s.len); ctx.lineTo(sx, s.y);
        }
        ctx.stroke();
      }

      for (const n of nodes) {
        n.x += n.vx; n.y += n.vy;
        if (n.x < -20) n.x = w + 20; else if (n.x > w + 20) n.x = -20;
        if (n.y < -20) n.y = h + 20; else if (n.y > h + 20) n.y = -20;
      }
      nodes.sort((a, b) => a.x - b.x);

      // sorted sweep with an early break keeps the mesh cheap
      if (!PERF.lite) {
        ctx.strokeStyle = 'rgba(163,153,146,.11)';
        ctx.lineWidth = .7;
        ctx.beginPath();
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j], dx = b.x - a.x;
            if (dx > 118) break;
            const dy = b.y - a.y;
            if (dx * dx + dy * dy < 13924) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
          }
        }
        ctx.stroke();
      }

      for (let hue = 0; hue < 2; hue++) {
        ctx.fillStyle = DOT[hue];
        ctx.beginPath();
        for (const n of nodes) {
          if (n.hue === hue) { ctx.moveTo(n.x + n.r, n.y); ctx.arc(n.x, n.y, n.r, 0, 6.283); }
        }
        ctx.fill();
      }

      if (p.active) {
        const near = 170, near2 = near * near, hits = [];
        ctx.strokeStyle = 'rgba(235,23,0,.16)';
        ctx.lineWidth = .8;
        ctx.beginPath();
        for (const n of nodes) {
          const dx = p.cx - n.x, dy = p.cy - n.y, d2 = dx * dx + dy * dy;
          if (d2 < near2) { hits.push([n, d2]); ctx.moveTo(n.x, n.y); ctx.lineTo(p.cx, p.cy); }
        }
        if (hits.length) {
          ctx.stroke();
          ctx.fillStyle = 'rgba(235,23,0,.6)';
          ctx.beginPath();
          for (const [n, d2] of hits) {
            const r = n.r * (1 + (1 - Math.sqrt(d2) / near) * 1.2);
            ctx.moveTo(n.x + r, n.y); ctx.arc(n.x, n.y, r, 0, 6.283);
          }
          ctx.fill();
        }
      }
    };
    raf = requestAnimationFrame(draw);

    return () => { cancelAnimationFrame(raf); obs.disconnect(); };
  }, [pointer, visible]);

  return <canvas ref={ref} className="shd-ambient" data-assistant-skip="" />;
};

// ─── Tool orbit ────────────────────────────────────────────────────────────────
// Every tool the user can open, circling the hub. Positions are written straight
// to the DOM each frame; React only re-renders when the hovered tool changes.
const ToolOrbit = memo(function ToolOrbit({ tools, pointer, visible, onLaunch }) {
  const wrapRef = useRef(null);
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const sweepRef = useRef(null);
  const tipRef = useRef(null);
  const nodeEls = useRef([]);
  const hoverRef = useRef(null);
  const [hover, setHover] = useState(null);

  const setHovered = useCallback((i) => { hoverRef.current = i; setHover(i); }, []);

  useEffect(() => {
    const canvas = canvasRef.current, stage = stageRef.current, wrap = wrapRef.current;
    if (!canvas || !stage) return undefined;
    let g = fitCanvas(canvas);
    const obs = new ResizeObserver(() => { g = fitCanvas(canvas); });
    obs.observe(canvas);

    const nodes = tools.map((t, i) => ({
      t, hex: ACCENT_HEX[t.colorKey] || ACCENT_HEX.red,
      base: (i / tools.length) * Math.PI * 2, x: 0, y: 0, depth: 0,
      phase: Math.random(), speed: .004 + Math.random() * .004,
    }));

    const placeTip = (n) => {
      const tip = tipRef.current;
      if (!tip) return;
      const W = stage.clientWidth, H = stage.clientHeight;
      const left = n.x > W / 2 ? n.x - 290 : n.x + 40;
      tip.style.left = `${Math.max(-20, Math.min(W - 240, left))}px`;
      tip.style.top = `${Math.min(H - 170, Math.max(0, n.y - 70))}px`;
    };

    let raf, spin = 0, vel = 1, last = 0, prev = 0;
    const draw = (t) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden || !visible.current || !wrap.offsetParent) return;
      if (t - last < (PERF.lite ? 50 : 33)) return;
      const dt = Math.min(80, t - (prev || t));
      prev = t; last = t;

      const { ctx, w, h } = g, cx = w / 2, cy = h / 2;
      const p = pointer.current;
      const hi = hoverRef.current;
      const hovered = hi == null ? null : nodes[hi];
      // Fit the ring to the box. When the text column beside it is short the
      // ring flattens first (a lower camera angle) so it keeps its width, and
      // only shrinks once it can't flatten any further. 150px is headroom for
      // the bubbles, their labels and the caption; the outer ring is 1.2x.
      const room = (h - 150) / 2.4;
      let rx = w * .41;
      if (room / rx < .32) rx = room / .32;
      const lean0 = Math.min(.5, room / rx);
      const tilt = lean0 + (p.y - .5) * .12 * (lean0 / .5), ry = rx * tilt;
      // the hub and sweep follow the ring, so a flat ring never swallows them
      const k = Math.max(.7, Math.min(1, ry / 125));
      stage.style.setProperty('--k', k.toFixed(3));
      const lean = (p.x - .5) * .16;
      // brake hard on hover so the bubble stays under the cursor, ease back up after
      vel += ((hovered ? 0 : 1) - vel) * (hovered ? .3 : .06);
      if (hovered && vel < .01) vel = 0; // settle fully, not asymptotically
      spin += dt * .00011 * vel;

      if (sweepRef.current) {
        sweepRef.current.style.width = `${Math.round(rx * 2.25)}px`;
        sweepRef.current.style.transform = `translate(-50%, -50%) scaleY(${tilt.toFixed(3)})`;
      }
      ctx.clearRect(0, 0, w, h);

      ctx.lineWidth = 1;
      [[1.2, 'rgba(175,165,155,.22)', []], [1, 'rgba(175,165,155,.5)', []],
        [.66, 'rgba(140,59,187,.18)', [3, 7]], [.38, 'rgba(235,23,0,.16)', [2, 6]]].forEach(([k, c, dash]) => {
        ctx.setLineDash(dash);
        ctx.strokeStyle = c;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx * k, ry * k, lean, 0, Math.PI * 2);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      const cosL = Math.cos(lean), sinL = Math.sin(lean);
      for (const n of nodes) {
        const a = n.base + spin;
        const ex = Math.cos(a) * rx, ey = Math.sin(a) * ry;
        n.x = cx + ex * cosL - ey * sinL;
        n.y = cy + ex * sinL + ey * cosL;
        n.depth = (Math.sin(a) + 1) / 2;
      }

      ctx.strokeStyle = 'rgba(163,153,146,.22)';
      ctx.setLineDash([2, 8]);
      ctx.beginPath();
      for (const n of nodes) { ctx.moveTo(cx, cy); ctx.lineTo(n.x, n.y); }
      ctx.stroke();
      ctx.setLineDash([]);

      if (hovered) {
        const grd = ctx.createLinearGradient(cx, cy, hovered.x, hovered.y);
        grd.addColorStop(0, 'rgba(235,23,0,.1)');
        grd.addColorStop(1, hovered.hex);
        ctx.strokeStyle = grd;
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(hovered.x, hovered.y); ctx.stroke();
      }

      // a packet runs from the hub out to each tool
      if (!PERF.lite || hovered) {
        for (const n of nodes) {
          if (hovered && n !== hovered) continue;
          n.phase = (n.phase + n.speed * (hovered ? 3 : 1)) % 1;
          const e = n.phase * n.phase * (3 - 2 * n.phase);
          const back = Math.max(0, e - .12);
          const px = cx + (n.x - cx) * e, py = cy + (n.y - cy) * e;
          const alpha = Math.sin(n.phase * Math.PI);
          ctx.strokeStyle = n.hex + Math.round(alpha * 120).toString(16).padStart(2, '0');
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(cx + (n.x - cx) * back, cy + (n.y - cy) * back); ctx.lineTo(px, py); ctx.stroke();
          ctx.fillStyle = n.hex;
          ctx.globalAlpha = alpha;
          ctx.beginPath(); ctx.arc(px, py, 2.6, 0, 6.283); ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      nodes.forEach((n, i) => {
        const el = nodeEls.current[i];
        if (!el) return;
        const s = (.74 + n.depth * .36) * Math.max(.85, k);
        el.style.transform = `translate(${n.x.toFixed(1)}px, ${n.y.toFixed(1)}px) scale(${s.toFixed(3)})`;
        el.style.opacity = (.55 + n.depth * .45).toFixed(2);
        el.style.zIndex = n === hovered ? 10 : n.depth > .5 ? 6 : 3;
        el.style.setProperty('--lo', n === hovered ? 1 : Math.max(0, (n.depth - .3) / .4).toFixed(2));
      });
      if (hovered) placeTip(hovered);
    };
    raf = requestAnimationFrame(draw);

    return () => { cancelAnimationFrame(raf); obs.disconnect(); };
  }, [tools, pointer, visible]);

  // the whole cluster drifts a little against the cursor
  useEffect(() => {
    const hero = wrapRef.current?.closest('.shd-hero');
    if (!hero) return undefined;
    const onMove = () => {
      const p = pointer.current, stage = stageRef.current;
      if (stage) stage.style.transform = `translate(${(-(p.x - .5) * 18).toFixed(1)}px, ${(-(p.y - .5) * 14).toFixed(1)}px)`;
    };
    hero.addEventListener('pointermove', onMove);
    return () => hero.removeEventListener('pointermove', onMove);
  }, [pointer]);

  const tipTool = hover == null ? null : tools[hover];

  return (
    <div ref={wrapRef} className="shd-orbit-wrap">
      <div ref={stageRef} className="shd-orbit">
        <div ref={sweepRef} className="shd-sweep"><div /></div>
        <canvas ref={canvasRef} data-assistant-skip="" />
        <div
          className="shd-core"
          data-assistant-id="dashboard-orbit"
          aria-label="Tool ring"
          data-assistant-desc="A live ring of every tool this user can open, circling the GRA SmartHub hub. Hovering a tool pauses the ring and shows what it does; clicking opens it."
        >
          <span className="shd-r" /><span className="shd-r shd-b" /><span className="shd-dash" />
          <div className="shd-disc"><div><i /><b>GRA</b><small>SmartHub</small></div></div>
        </div>

        {tools.map((t, i) => (
          <button
            key={t.id}
            ref={el => { nodeEls.current[i] = el; }}
            data-assistant-skip=""
            type="button"
            className={`shd-onode${hover === i ? ' shd-on' : ''}`}
            style={{ '--c': ACCENT_HEX[t.colorKey] }}
            aria-label={`Open ${t.title}`}
            onPointerEnter={() => setHovered(i)}
            onPointerLeave={() => setHovered(null)}
            onFocus={() => setHovered(i)}
            onBlur={() => setHovered(null)}
            onClick={() => onLaunch(t)}
          >
            <span className="shd-bub"><Ico src={t.icon} /></span>
            {t.badge && <span className="shd-onew" />}
            <span className="shd-olbl">{ORBIT_LABEL[t.id] || t.title}</span>
          </button>
        ))}

        <div ref={tipRef} className={`shd-otip${tipTool ? ' shd-show' : ''}`} style={tipTool ? { '--c': ACCENT_HEX[tipTool.colorKey] } : undefined}>
          {tipTool && (
            <>
              <div className="shd-cat">{tipTool.category}</div>
              <h4>{tipTool.title}</h4>
              <p>{tipTool.description}</p>
              <div className="shd-go">Click to launch →</div>
            </>
          )}
        </div>
      </div>
      {tools.length > 0 && (
        <div className="shd-orbit-caption shd-chip"><span className="shd-dot" />Hover a tool · click to launch</div>
      )}
    </div>
  );
});

// ─── Clock chip ────────────────────────────────────────────────────────────────
// Walled off so the once-a-second tick re-renders two text nodes, not the page.
const LiveClock = memo(function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="shd-chip">
      <span>{now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
      <span className="shd-sep" />
      <b>{now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}</b>
    </div>
  );
});

// ─── Rotating second headline line ─────────────────────────────────────────────
const RotatingLine = memo(function RotatingLine() {
  const [i, setI] = useState(0);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    let swap;
    const timer = setInterval(() => {
      setLeaving(true);
      swap = setTimeout(() => { setI(n => (n + 1) % HEADLINES.length); setLeaving(false); }, 420);
    }, 4600);
    return () => { clearInterval(timer); clearTimeout(swap); };
  }, []);

  return (
    <span className={`shd-line2${leaving ? ' shd-out' : ''}`} aria-live="off">
      {HEADLINES[i].split(' ').map((word, k) => (
        <React.Fragment key={`${i}-${k}`}>
          {k > 0 && ' '}
          <span className="shd-w" style={{ animationDelay: `${k * 70}ms` }}>{word}</span>
        </React.Fragment>
      ))}
    </span>
  );
});

// ─── Typed placeholder for the search bar ──────────────────────────────────────
const TypedHint = memo(function TypedHint() {
  const [text, setText] = useState('');

  useEffect(() => {
    let i = 0, n = 0, dir = 1, timer;
    const tick = () => {
      const s = SEARCH_HINTS[i];
      setText(s.slice(0, n));
      if (dir > 0 && n === s.length) { dir = -1; timer = setTimeout(tick, 1900); return; }
      if (dir < 0 && n === 0) { dir = 1; i = (i + 1) % SEARCH_HINTS.length; timer = setTimeout(tick, 350); return; }
      n += dir;
      timer = setTimeout(tick, dir > 0 ? 55 : 22);
    };
    tick();
    return () => clearTimeout(timer);
  }, []);

  return <>{text}<span className="shd-caret" /></>;
});

// ─── Search ────────────────────────────────────────────────────────────────────
// Shared by the hero bar and the palette: tools, plus every section a tool
// deep-links to, so "snowflake" lands straight on the Snowflake pane.
const buildEntries = (tools) => tools.flatMap(t => [
  { key: t.id, tool: t, label: t.title, sub: t.category, path: t.path, section: false,
    hay: `${t.title} ${t.category} ${t.description}`.toLowerCase() },
  ...(t.sections || []).map(sec => ({
    key: `${t.id}:${sec.path}`, tool: t, label: sec.label, sub: t.title, path: sec.path, section: true,
    hay: `${sec.label} ${t.title}`.toLowerCase(),
  })),
]);

const searchEntries = (entries, query, limit) => {
  const q = query.trim().toLowerCase();
  let ranked;
  if (!q) {
    ranked = entries.filter(e => !e.section);
  } else {
    ranked = entries
      .map(e => {
        const at = e.label.toLowerCase().indexOf(q);
        return { e, score: at === 0 ? 0 : at > 0 ? 1 : e.hay.includes(q) ? 2 : 9 };
      })
      .filter(r => r.score < 9)
      .sort((a, b) => a.score - b.score || a.e.section - b.e.section)
      .map(r => r.e);
  }
  ranked = ranked.slice(0, limit);
  // Grouped for display; whichever group holds the best hit goes first, and
  // the flat order matches what is on screen so arrow keys walk it top-down.
  const tools = ranked.filter(e => !e.section), secs = ranked.filter(e => e.section);
  const secsFirst = tools.length && secs.length && ranked[0].section;
  const groups = secsFirst ? [['Jump to a section', secs], ['Tools', tools]] : [['Tools', tools], ['Jump to a section', secs]];
  return { groups: groups.filter(([, g]) => g.length), flat: secsFirst ? [...secs, ...tools] : [...tools, ...secs] };
};

const Highlight = ({ text, query }) => {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>;
};

const ResultList = ({ groups, flat, query, active, setActive, onPick }) => {
  if (!flat.length) {
    return <div className="shd-noresult">Nothing matches that. Try “snowflake”, “validation” or “RAG”.</div>;
  }
  let k = -1;
  return groups.map(([name, list]) => (
    <React.Fragment key={name}>
      <div className="shd-pal-group">{name}</div>
      {list.map(e => {
        k += 1;
        const i = k;
        return (
          <button
            key={e.key}
            type="button"
            data-i={i}
            className={`shd-res${i === active ? ' shd-act' : ''}`}
            style={{ '--c': ACCENT_HEX[e.tool.colorKey] }}
            onMouseMove={() => { if (i !== active) setActive(i); }}
            onMouseDown={(ev) => { ev.preventDefault(); onPick(e); }}
          >
            <span className="shd-tile"><Ico src={e.tool.icon} /></span>
            <span className="shd-tt"><b><Highlight text={e.label} query={query} /></b><small>{e.sub}</small></span>
            <span className="shd-ent">↵</span>
          </button>
        );
      })}
    </React.Fragment>
  ));
};

// Query + active row + keyboard handling, used by both search surfaces.
const useSearch = (entries, limit, onPick, onEscape) => {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef(null);
  const { groups, flat } = useMemo(() => searchEntries(entries, query, limit), [entries, query, limit]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector('.shd-res.shd-act')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e) => {
    const count = Math.max(1, flat.length);
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % count); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + count) % count); }
    else if (e.key === 'Enter') {
      // Read the live input, not this render's results: Enter can land before
      // React has re-rendered for the last keystroke (fast typing, paste).
      const live = e.currentTarget.value;
      const hit = live === query ? flat[active] : searchEntries(entries, live, limit).flat[0];
      if (hit) onPick(hit);
    }
    else if (e.key === 'Escape') onEscape();
  };

  return { query, setQuery, active, setActive, groups, flat, onKeyDown, listRef };
};

const CommandBar = ({ entries, onLaunch, inputRef }) => {
  const [open, setOpen] = useState(false);
  const pick = (e) => { setOpen(false); inputRef.current?.blur(); onLaunch(e.tool, e.path); };
  const s = useSearch(entries, 6, pick, () => { setOpen(false); inputRef.current?.blur(); });

  return (
    <div
      className="shd-cmd"
      data-assistant-id="dashboard-search"
      aria-label="Search"
      data-assistant-desc="Search bar for every tool and the sections inside them - typing 'snowflake' jumps straight to Data Studio's Snowflake tab. Ctrl K opens the same search from anywhere on the page."
    >
      <label className="shd-cmd-box">
        <Ico src={searchIcon} />
        <input
          ref={inputRef}
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search tools"
          value={s.query}
          onChange={e => s.setQuery(e.target.value)}
          onKeyDown={s.onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        />
        {!s.query && <span className="shd-ph"><TypedHint /></span>}
        <span className="shd-kbd">{isMac ? '⌘ K' : 'Ctrl K'}</span>
      </label>
      {open && (
        <div ref={s.listRef} className="shd-suggest">
          <ResultList {...s} onPick={pick} />
        </div>
      )}
    </div>
  );
};

const CommandPalette = ({ entries, onClose, onLaunch }) => {
  const inputRef = useRef(null);
  const pick = (e) => { onClose(); onLaunch(e.tool, e.path); };
  const s = useSearch(entries, 12, pick, onClose);

  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div className="shd-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="shd-pal">
        <div className="shd-pal-in">
          <Ico src={searchIcon} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search tools and sections…"
            autoComplete="off"
            spellCheck={false}
            value={s.query}
            onChange={e => s.setQuery(e.target.value)}
            onKeyDown={s.onKeyDown}
          />
          <span className="shd-kbd">esc</span>
        </div>
        <div ref={s.listRef} className="shd-pal-list">
          <ResultList {...s} onPick={pick} />
        </div>
        <div className="shd-pal-foot">
          <span><span className="shd-kbd">↑↓</span>navigate</span>
          <span><span className="shd-kbd">↵</span>open</span>
          <span><span className="shd-kbd">esc</span>close</span>
        </div>
      </div>
    </div>
  );
};

// ─── Pick up where you left off ────────────────────────────────────────────────
const ResumeRow = memo(function ResumeRow({ entries, onLaunch }) {
  if (!entries.length) return null;
  return (
    <div
      className="shd-resume"
      data-assistant-id="dashboard-resume"
      aria-label="Pick up where you left off"
      data-assistant-desc="Pick up where you left off: the last few places this user visited, most recent first. Each card reopens the exact tab they were on."
    >
      <div className="shd-resume-h"><span>Pick up where you left off</span><hr /></div>
      <div className="shd-resume-row">
        {entries.map(({ tool, visit }) => {
          // Reverse breadcrumb: where the user actually was first ("Failed
          // rows"), then outward through its parents to the tool itself.
          const steps = [tool.title, ...(visit.trail || [])];
          const here = steps[steps.length - 1];
          const context = steps.slice(0, -1).reverse().join(' ‹ ');
          // The bar shows recency: full when just visited, empty at the 30-day cut-off.
          const fresh = Math.max(8, Math.round(100 * (1 - (Date.now() - visit.last) / RECENT_WINDOW)));
          return (
            <button
              key={tool.id}
              type="button"
              className="shd-rcard"
              style={{ '--c': ACCENT_HEX[tool.colorKey], '--p': `${fresh}%` }}
              onClick={() => onLaunch(tool, visit.path)}
            >
              <span className="shd-tile"><Ico src={tool.icon} /></span>
              <span className="shd-t">
                <b>{here}</b>
                <small><span className="shd-ago">{timeAgo(visit.last)}</span>{context && ` · ${context}`}</small>
              </span>
              <Ico src={arrowIcon} className="shd-arr" />
              <span className="shd-prog" />
            </button>
          );
        })}
      </div>
    </div>
  );
});

// ─── Category filter ───────────────────────────────────────────────────────────
const CategoryFilter = ({ filters, counts, value, onChange }) => {
  const segRef = useRef(null);
  const [pill, setPill] = useState(null);

  useEffect(() => {
    const seg = segRef.current;
    if (!seg) return undefined;
    const measure = () => {
      const on = seg.querySelector('button.shd-on');
      if (on) setPill({ w: on.offsetWidth, x: on.offsetLeft, y: on.offsetTop });
    };
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(seg);
    return () => obs.disconnect();
  }, [value, filters]);

  return (
    <div ref={segRef} className="shd-seg" role="tablist">
      {pill && <span className="shd-pill" style={{ width: pill.w, transform: `translate(${pill.x}px, ${pill.y - 5}px)` }} />}
      {filters.map(f => (
        <button key={f} type="button" role="tab" aria-selected={value === f}
          className={value === f ? 'shd-on' : ''} onClick={() => onChange(f)}>
          {f}<span className="shd-n">{counts[f]}</span>
        </button>
      ))}
    </div>
  );
};

// ─── Tool cards ────────────────────────────────────────────────────────────────
const ToolCardSkeleton = () => (
  <div aria-hidden="true" className="shd-skel">
    <span style={{ width: 50, height: 50, borderRadius: 15 }} />
    <span style={{ width: '60%', height: 16, marginTop: 20 }} />
    <span style={{ width: '30%', height: 9, marginTop: 10 }} />
    <span style={{ width: '100%', height: 10, marginTop: 16 }} />
    <span style={{ width: '80%', height: 10, marginTop: 8 }} />
  </div>
);

// Native tooltip only when the chip's label is actually cut off.
const showTitleIfCut = (e) => {
  const el = e.currentTarget;
  if (el.scrollWidth > el.clientWidth) el.title = el.textContent;
  else el.removeAttribute('title');
};

const ToolCard = memo(function ToolCard({ tool, index, onLaunch }) {
  const onKeyDown = (e) => {
    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onLaunch(tool);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className="shd-card"
      style={{ '--c': ACCENT_HEX[tool.colorKey] || ACCENT_HEX.red, '--k': index }}
      onClick={() => onLaunch(tool)}
      onKeyDown={onKeyDown}
    >
      <div className="shd-card-top">
        <span className="shd-tile"><Ico src={tool.icon} /></span>
        {tool.badge && <span className="shd-badge">{tool.badge}</span>}
      </div>
      <h3>{tool.title}</h3>
      <div className="shd-cat">{tool.category}</div>
      <p>{tool.description}</p>
      {/* Tools with tabs get one line of tab chips (squeezed with an ellipsis,
          full name on hover); the rest keep the plain Launch arrow. */}
      {tool.sections?.length ? (
        <div className="shd-foot shd-foot-tabs">
          {tool.sections.map(sec => (
            <button key={sec.path} type="button" className="shd-sec-chip"
              aria-label={`Open ${tool.title}: ${sec.label}`}
              onMouseEnter={showTitleIfCut}
              onClick={(e) => { e.stopPropagation(); onLaunch(tool, sec.path); }}>
              {sec.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="shd-foot">
          <span className="shd-sp" />
          <span className="shd-launch">Launch<span className="shd-ar"><Ico src={arrowIcon} /></span></span>
        </div>
      )}
    </div>
  );
});

// Spotlight + a small tilt on whichever card is under the cursor. Done on the
// grid so there's one listener, and straight on the DOM so nothing re-renders.
const useCardTilt = () => {
  const tilted = useRef(null);
  const reset = () => { if (tilted.current) { tilted.current.style.transform = ''; tilted.current = null; } };
  const onPointerMove = (e) => {
    const card = e.target.closest('.shd-card');
    if (tilted.current && tilted.current !== card) reset();
    if (!card) return;
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    card.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
    card.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
    card.style.transform = `translateY(-6px) rotateX(${((.5 - y) * 5).toFixed(2)}deg) rotateY(${((x - .5) * 6).toFixed(2)}deg)`;
    tilted.current = card;
  };
  return { onPointerMove, onPointerLeave: reset };
};

// ─── What's new ────────────────────────────────────────────────────────────────
const ReleaseTimeline = memo(function ReleaseTimeline({ canManage, onOpenAll }) {
  const [notes, setNotes] = useState(null);

  useEffect(() => {
    let alive = true;
    apiJson('/api/release-notes?status=announced&limit=4')
      .then(data => { if (alive) setNotes(data.notes || []); })
      .catch(() => { if (alive) setNotes([]); });
    return () => { alive = false; };
  }, []);

  return (
    <div
      className="shd-glass shd-panel"
      data-assistant-id="dashboard-whats-new"
      aria-label="What's new"
      data-assistant-desc="What's new: the latest announced changes to the portal, newest first."
    >
      <div className="shd-panel-h">
        <h3>What's new</h3>
        {canManage && <button type="button" onClick={onOpenAll}>All release notes →</button>}
      </div>
      {notes === null && <p className="shd-quiet">Loading the latest changes…</p>}
      {notes?.length === 0 && <p className="shd-quiet">Nothing announced yet. New features will show up here.</p>}
      {notes?.length > 0 && (
        <ul className="shd-tl">
          {notes.map(n => {
            const [tag, color] = KIND_TAG[n.kind] || KIND_TAG.feature;
            const when = new Date(n.announced_at || n.created_at);
            return (
              <li key={n.id} style={{ '--c': color }}>
                <span className="shd-d">
                  {Number.isNaN(when.getTime()) ? '' : when.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                </span>
                <b>{n.title}<span className="shd-tag">{tag}</span></b>
                {n.summary && <p>{n.summary}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

const ShortcutsPanel = () => (
  <div
    className="shd-glass shd-panel"
    data-assistant-id="dashboard-shortcuts"
    aria-label="Move faster"
    data-assistant-desc="Keyboard shortcuts for the search, and a note that every sign-in, page view and role change is recorded in the Audit Log."
  >
    <div className="shd-panel-h"><h3>Move faster</h3></div>
    <div className="shd-keys">
      <div className="shd-keyrow">Search every tool and section<span className="shd-kbd">{isMac ? '⌘ K' : 'Ctrl K'}</span></div>
      <div className="shd-keyrow">Move through results<span className="shd-kbd">↑ ↓</span></div>
      <div className="shd-keyrow">Open the highlighted result<span className="shd-kbd">↵ Enter</span></div>
      <div className="shd-keyrow">Close any dialog<span className="shd-kbd">Esc</span></div>
    </div>
    <div className="shd-gov">
      <Ico src={shieldIcon} />
      <div><b>Governed by design</b><small>Every sign-in, page view and role change is recorded in the Audit Log.</small></div>
    </div>
  </div>
);

// Fades each section in the first time it scrolls into view.
const Reveal = ({ rootRef, className = '', children }) => {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setShown(true); io.disconnect(); }
    }, { root: rootRef.current, threshold: .08 });
    io.observe(el);
    return () => io.disconnect();
  }, [rootRef]);
  return <div ref={ref} className={`shd-section shd-reveal${shown ? ' shd-in' : ''} ${className}`}>{children}</div>;
};

// ─── Main Dashboard ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { hasPermission, loading: rbacLoading } = useRBAC();
  const [filter, setFilter] = useState('All');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [lite, setLite] = useState(PERF.lite);
  const [recent] = useState(readRecentTools);

  const pageRef = useRef(null);
  const heroRef = useRef(null);
  const searchRef = useRef(null);
  const pointer = useRef({ x: .5, y: .5, cx: 0, cy: 0, active: false });
  const heroVisible = useRef(true);
  const tilt = useCardTilt();

  useEffect(() => {
    const flip = () => setLite(true);
    PERF.listeners.add(flip);
    return () => PERF.listeners.delete(flip);
  }, []);

  // Canvases stop drawing once the hero scrolls out of view.
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return undefined;
    const io = new IntersectionObserver(([e]) => { heroVisible.current = e.isIntersecting; }, { root: pageRef.current });
    io.observe(hero);
    return () => io.disconnect();
  }, []);

  // Cmd/Ctrl+K anywhere, the header's search button, and "/" to jump to the bar.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(p => !p);
      } else if (e.key === '/' && document.activeElement === document.body) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    const onOpen = () => setPaletteOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(PALETTE_EVENT, onOpen);
    };
  }, []);

  const onHeroMove = useCallback((e) => {
    const b = e.currentTarget.getBoundingClientRect();
    pointer.current = {
      x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height,
      cx: e.clientX - b.left, cy: e.clientY - b.top, active: true,
    };
  }, []);
  const onHeroLeave = useCallback(() => { pointer.current.active = false; }, []);

  const rawName = user?.name || user?.username?.split('@')[0] || 'User';
  const firstName = firstNameOf(rawName);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  // While RBAC is still resolving, hasPermission() reports the default
  // 'viewer' permissions - filtering now would render a near-empty grid and
  // then pop the real cards in. Show skeletons instead.
  const tools = useMemo(() => {
    if (rbacLoading) return [];
    return newFirst(TOOL_CATALOG
      .filter(t => hasPermission(t.permission))
      .map(t => (t.sections
        ? { ...t, sections: t.sections.filter(sec => !sec.permission || hasPermission(sec.permission)) }
        : t)));
  }, [rbacLoading, hasPermission]);

  const entries = useMemo(() => buildEntries(tools), [tools]);

  const launch = useCallback((tool, path) => {
    if (!tool) return;
    setPaletteOpen(false);
    navigate(path || tool.path);
  }, [navigate]);

  const resumeEntries = useMemo(() => (
    Object.keys(recent)
      .map(id => ({ tool: tools.find(t => t.id === id), visit: recent[id] }))
      .filter(entry => entry.tool)
      .sort((a, b) => b.visit.last - a.visit.last)
      .slice(0, 3)
  ), [recent, tools]);

  const { filters, counts } = useMemo(() => {
    // catalogue order, not NEW-first order, so the pills don't reshuffle per release
    const seen = TOOL_CATALOG.map(t => t.category).filter((c, i, arr) => arr.indexOf(c) === i && tools.some(t => t.category === c));
    const tally = { All: tools.length };
    tools.forEach(t => { tally[t.category] = (tally[t.category] || 0) + 1; });
    return { filters: ['All', ...seen], counts: tally };
  }, [tools]);

  // A filter can survive a permission change that removes its last tool.
  useEffect(() => {
    if (!rbacLoading && !filters.includes(filter)) setFilter('All');
  }, [filters, filter, rbacLoading]);

  const visibleTools = useMemo(
    () => (filter === 'All' ? tools : tools.filter(t => t.category === filter)),
    [filter, tools]
  );

  return (
    <div ref={pageRef} className={`shd${lite ? ' shd-lite' : ''}`}>

      <div ref={heroRef} className="shd-hero" onPointerMove={onHeroMove} onPointerLeave={onHeroLeave}>
        {/* decoration is clipped on its own layer so the search dropdown can
            hang past the bottom of the hero */}
        <div className="shd-hero-bg">
          <AmbientField pointer={pointer} visible={heroVisible} />
          <div className="shd-veil" />
          <div className="shd-glow" />
        </div>

        <div className="shd-topbar"><LiveClock /></div>

        <div className="shd-hero-inner">
          <div className="shd-copy">
            <h1 className="shd-greet">
              {greeting}, <span className="shd-name">{firstName}</span>.
              <RotatingLine />
            </h1>
            <p className="shd-lede">
              Every tool you can access to, in one governed workspace. Validate data, explore
              documents, ask questions and run SQL etc. without leaving the hub.
            </p>
            <CommandBar entries={entries} onLaunch={launch} inputRef={searchRef} />
            <ResumeRow entries={resumeEntries} onLaunch={launch} />
          </div>

          <ToolOrbit tools={tools} pointer={pointer} visible={heroVisible} onLaunch={launch} />
        </div>
      </div>

      <Reveal rootRef={pageRef} className="shd-first">
        <div
          className="shd-sec-head"
          data-assistant-id="dashboard-toolkit-filters"
          aria-label="Your toolkit filters"
          data-assistant-desc="Your toolkit: the filter pills narrow the cards below to Data, AI, Explorers or Admin tools."
        >
          <div>
            <div className="shd-k">Applications</div>
            <h2>Your <em>toolkit.</em></h2>
            <p>
              {!rbacLoading && tools.length === 0
                ? 'No applications are available for your current access level.'
                : 'Filtered by your role. New tools surface first.'}
            </p>
          </div>
          {/* filters line up with the heading; the how-to hint sits under them */}
          {tools.length > 0 && (
            <div className="shd-filters">
              <CategoryFilter filters={filters} counts={counts} value={filter} onChange={setFilter} />
              <p className="shd-hint">
                <Ico src={arrowIcon} />
                Click a card to open the tool, or a
                <span className="shd-hint-chip" aria-hidden="true">tab</span>
                on it to jump straight there.
              </p>
            </div>
          )}
        </div>

        {/* keyed on the filter so the staggered entrance replays on every switch */}
        <div
          key={filter}
          className="shd-grid"
          data-assistant-id="dashboard-toolkit"
          aria-label="Tool cards"
          data-assistant-desc="One card per tool this user's role can open, newest first. Clicking a card opens the tool; the small chips on some cards jump straight to one of its tabs."
          {...tilt}
        >
          {rbacLoading && Array.from({ length: 8 }).map((_, i) => <ToolCardSkeleton key={`skeleton-${i}`} />)}
          {visibleTools.map((tool, i) => <ToolCard key={tool.id} tool={tool} index={i} onLaunch={launch} />)}
        </div>

        {/* A viewer with no application permissions would otherwise see an
            unexplained empty grid. */}
        {!rbacLoading && tools.length === 0 && (
          <div className="shd-glass shd-empty-card">
            <h3 style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 19, margin: '0 0 8px' }}>No applications available</h3>
            <p className="shd-quiet">
              Your account doesn't currently have access to any tools. Contact your
              administrator if you believe this is a mistake.
            </p>
          </div>
        )}
      </Reveal>

      <Reveal rootRef={pageRef}>
        <div className="shd-band">
          <ReleaseTimeline
            canManage={hasPermission('sendCommunications')}
            onOpenAll={() => navigate('/communication-center?tab=whats-new')}
          />
          <ShortcutsPanel />
        </div>
      </Reveal>

      <footer className="shd-footer">
        Confidential · Internal Use Only · © {new Date().getFullYear()} Regulatory Integrated Data · Johnson &amp; Johnson
      </footer>

      {paletteOpen && (
        <CommandPalette entries={entries} onClose={() => setPaletteOpen(false)} onLaunch={launch} />
      )}
    </div>
  );
}
