import React, { useEffect, useRef, useState, useCallback } from 'react';

import recordsIcon from "/icons/JJ_Icon_Records_Information_RGB.svg";
import databaseIcon from "/icons/JJ_Icon_Database_RGB.svg";
import analysisIcon from "/icons/JJ_Icon_Analysis_RGB.svg";
import dataVizIcon from "/icons/JJ_Icon_Data_Visualization.svg";
import shieldIcon from "/icons/JJ_Icon_Shield_RGB.svg";
import safetyIcon from "/icons/JJ_Icon_Safety.svg";
import leaderIcon from "/icons/JJ_Icon_Leader_RGB.svg";
import aiIcon from "/icons/JJ_Icon_AI_RGB.svg";
import editIcon from "/icons/JJ_Icon_Edit_RGB.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";

// Brand tint recipe used across DQEngine: the source SVGs are flat black art,
// so exact J&J Red comes from repainting them off their alpha channel.
const TINT_RED = 'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)';

// One row per document-set tab on the main page (see docTypeIds in
// Unstructured.jsx) - ids must stay in sync, they're written straight to the
// ?doctype= URL param on click. Engine/source details are deliberately not
// surfaced on this screen.
const EXPLORERS = [
  { id: 'vr',        num: '01', name: 'Virtual Regulator', description: 'Explore Virtual Regulator documents, chunks and ingestion.', icon: leaderIcon },
  { id: 'immbot',    num: '02', name: 'IMMBOT', description: 'Explore IMMBOT documents, chunks and metadata.', icon: safetyIcon },
  { id: 'mirai',     num: '03', name: 'MirAI', description: 'Coming soon.', icon: aiIcon, soon: true },
  { id: 'rmwcreate', num: '04', name: 'RMWCreate', description: 'Coming soon.', icon: editIcon, soon: true },
  { id: 'haq',       num: '05', name: 'Q!', description: 'Explore Q! content and metadata.', icon: analysisIcon },
  { id: 'nipo',      num: '06', name: 'Nipocalimab', description: 'Explore Nipocalimab documents and unstructured data.', icon: dataVizIcon },
  { id: 'rimdocs',   num: '07', name: 'RIMDocs', description: 'Explore RIMDocs documents and unstructured content.', icon: recordsIcon },
  { id: 'epod',      num: '08', name: 'EPOD', description: 'Explore EPOD documents and records.', icon: databaseIcon },
  { id: 'fda',       num: '09', name: 'FDA and Others', description: 'Explore FDA and other unstructured data and metadata.', icon: shieldIcon },
];

const LAUNCH_STEPS = [
  'Opening exploration environment',
  'Indexing document sets',
  'Resolving metadata graph',
  'Ready',
];

// Keyframes are scoped to this screen and injected once, so the component can
// be dropped in without touching the global stylesheet.
const KEYFRAMES = `
@keyframes ue-rise { from { opacity: 0; transform: translateY(22px); } to { opacity: 1; transform: none; } }
@keyframes ue-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ue-halo { 0%,100% { opacity: .55; } 50% { opacity: .9; } }
@keyframes ue-ring { 0% { opacity: .55; transform: scale(.82); } 100% { opacity: 0; transform: scale(1.5); } }
@keyframes ue-bar  { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
`;

const DISPLAY = "'JohnsonDisplay', 'Johnson Display', Arial, Helvetica, sans-serif";
const TEXT = "'JohnsonText', 'Johnson Text', Arial, Helvetica, sans-serif";

const useKeyframes = () => {
  useEffect(() => {
    const id = 'ue-welcome-keyframes';
    if (document.getElementById(id)) return undefined;
    const tag = document.createElement('style');
    tag.id = id;
    tag.textContent = KEYFRAMES;
    document.head.appendChild(tag);
    return undefined;
  }, []);
};

// Software-rendering budget: the Cloud PCs this runs on have no GPU, so every
// frame is rasterised on the CPU. The backing store stays at 1x (a 2x store is
// 4x the pixels to fill), frames are gated to 30fps, strokes are batched into a
// handful of paths, gradients are cached, drawing pauses when the tab is hidden,
// and the scene drops to a lighter variant on its own if frames run long.
const fitCanvas = (canvas) => {
  const w = Math.max(1, Math.round(canvas.clientWidth)), h = Math.max(1, Math.round(canvas.clientHeight));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { ctx, w, h };
};

// One shared budget watcher for both canvases.
const PERF = {
  lite: false, n: 0, sum: 0, last: 0,
  // Windows Cloud PCs commonly report reduced-motion (OS animations are off by
  // default there), so it selects the calm lite scene rather than freezing the
  // canvases on a single static frame.
  calm: typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false,
  sample(t) {
    if (this.last) {
      const d = t - this.last;
      if (d < 250) {
        this.sum += d; this.n += 1;
        if (this.n >= 45) {
          if (this.sum / this.n > 26) this.lite = true;
          this.n = 0; this.sum = 0;
        }
      }
    }
    this.last = t;
  },
};

const BLUE = (a) => `rgba(15,104,178,${a})`;
const PURPLE = (a) => `rgba(140,59,187,${a})`;

// Ambient field behind the whole screen: a drifting grid, falling data
// streams, and a particle mesh that leans toward the cursor and brightens near
// it. Purely decorative (pointer-events-none).
const AmbientField = ({ pointer }) => {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    let geom = fitCanvas(canvas);
    const ctx = geom.ctx;
    let nodes = [], streams = [];

    const build = () => {
      const cap = PERF.lite ? 46 : 78;
      const count = Math.max(18, Math.round(Math.min(cap, (geom.w * geom.h) / 24000)));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * geom.w, y: Math.random() * geom.h,
        vx: (Math.random() - .5) * .16, vy: (Math.random() - .5) * .16,
        r: 1 + Math.random() * 1.4, hue: Math.random() < .68 ? 0 : 1,
      }));
      nodes.sort((a, b) => a.x - b.x);
      streams = Array.from({ length: PERF.lite ? 8 : 13 }, () => ({
        x: Math.random(), y: Math.random() * geom.h, len: 60 + Math.random() * 160,
        sp: .5 + Math.random() * 1.5, hue: Math.random() < .6 ? 0 : 1,
      }));
    };
    build();

    const obs = new ResizeObserver(() => { geom = fitCanvas(canvas); build(); });
    obs.observe(canvas);

    const HUE_LINE = ['rgba(15,104,178,.17)', 'rgba(140,59,187,.15)'];
    const HUE_HEAD = ['rgba(15,104,178,.5)', 'rgba(140,59,187,.45)'];
    const HUE_DOT = ['rgba(15,104,178,.5)', 'rgba(140,59,187,.45)'];
    let raf, lastFrame = 0, litePrev = false;

    const draw = (t) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      if (t - lastFrame < (PERF.lite || PERF.calm ? 50 : 33)) return;
      if (geom.w < 2 || geom.h < 2) { geom = fitCanvas(canvas); build(); return; }
      lastFrame = t;
      PERF.sample(t);
      if (PERF.lite !== litePrev) { litePrev = PERF.lite; build(); }

      const { w, h } = geom;
      ctx.clearRect(0, 0, w, h);
      const offX = -(pointer.current.x - .5) * 34, offY = -(pointer.current.y - .5) * 22, gap = 76;

      // grid — one path, one stroke
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(175,165,155,.085)';
      ctx.beginPath();
      for (let x = -gap; x < w + gap; x += gap) {
        const fx = x + offX + ((t / 70) % gap);
        ctx.moveTo(fx, 0); ctx.lineTo(fx, h);
      }
      for (let y = -gap; y < h + gap; y += gap) {
        const fy = y + offY;
        ctx.moveTo(0, fy); ctx.lineTo(w, fy);
      }
      ctx.stroke();

      // data streams — flat colour per hue plus a brighter head dot
      for (let hue = 0; hue < 2; hue++) {
        ctx.strokeStyle = HUE_LINE[hue];
        ctx.beginPath();
        for (let i = 0; i < streams.length; i++) {
          const st = streams[i];
          if (st.hue !== hue) continue;
          if (hue === 0) { st.y += st.sp; if (st.y - st.len > h) { st.y = -st.len; st.x = Math.random(); } }
          const sx = st.x * w + offX * 1.6;
          ctx.moveTo(sx, st.y - st.len); ctx.lineTo(sx, st.y);
        }
        ctx.stroke();
        ctx.fillStyle = HUE_HEAD[hue];
        ctx.beginPath();
        for (let i = 0; i < streams.length; i++) {
          const st = streams[i];
          if (st.hue !== hue) continue;
          if (hue === 1) { st.y += st.sp; if (st.y - st.len > h) { st.y = -st.len; st.x = Math.random(); } }
          const sx = st.x * w + offX * 1.6;
          ctx.moveTo(sx + 1.3, st.y); ctx.arc(sx, st.y, 1.3, 0, 6.283);
        }
        ctx.fill();
      }

      // drift, then one insertion pass keeps the array sorted by x
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        n.x += n.vx; n.y += n.vy;
        if (n.x < -20) n.x = w + 20;
        if (n.x > w + 20) n.x = -20;
        if (n.y < -20) n.y = h + 20;
        if (n.y > h + 20) n.y = -20;
      }
      for (let i = 1; i < nodes.length; i++) {
        const n = nodes[i];
        let j = i - 1;
        while (j >= 0 && nodes[j].x > n.x) { nodes[j + 1] = nodes[j]; j -= 1; }
        nodes[j + 1] = n;
      }

      // mesh — sorted sweep with an early break, every link in one path
      if (!PERF.lite) {
        ctx.strokeStyle = 'rgba(163,153,146,.11)';
        ctx.lineWidth = .7;
        ctx.beginPath();
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          for (let j = i + 1; j < nodes.length; j++) {
            const m = nodes[j];
            const dx = m.x - n.x;
            if (dx > 118) break;
            const dy = m.y - n.y;
            if (dx * dx + dy * dy < 13924) { ctx.moveTo(n.x, n.y); ctx.lineTo(m.x, m.y); }
          }
        }
        ctx.stroke();
      }

      // particles — one path per hue
      for (let hue = 0; hue < 2; hue++) {
        ctx.fillStyle = HUE_DOT[hue];
        ctx.beginPath();
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (n.hue !== hue) continue;
          ctx.moveTo(n.x + n.r, n.y); ctx.arc(n.x, n.y, n.r, 0, 6.283);
        }
        ctx.fill();
      }

      // cursor response — links then brightened dots, one path each
      if (pointer.current.active) {
        const mx = pointer.current.cx, my = pointer.current.cy, near = 165, near2 = near * near;
        let hits = 0;
        ctx.strokeStyle = 'rgba(235,23,0,.16)';
        ctx.lineWidth = .8;
        ctx.beginPath();
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          const dx = mx - n.x, dy = my - n.y;
          if (dx * dx + dy * dy > near2) continue;
          hits += 1;
          ctx.moveTo(n.x, n.y); ctx.lineTo(mx, my);
        }
        if (hits) {
          ctx.stroke();
          ctx.fillStyle = 'rgba(235,23,0,.6)';
          ctx.beginPath();
          for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            const dx = mx - n.x, dy = my - n.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > near2) continue;
            const r = n.r * (1 + (1 - Math.sqrt(d2) / near) * 1.1);
            ctx.moveTo(n.x + r, n.y); ctx.arc(n.x, n.y, r, 0, 6.283);
          }
          ctx.fill();
        }
      }
    };
    if (PERF.calm) PERF.lite = true;
    raf = requestAnimationFrame(draw);

    return () => { cancelAnimationFrame(raf); obs.disconnect(); };
  }, [pointer]);

  return <canvas ref={ref} className="absolute inset-0 w-full h-full block pointer-events-none" />;
};

// Hero visualization: raw documents drift in from the rim, cross a luminous
// parse shell, and settle into an orbiting structured lattice around a live
// core. The cursor tilts the whole cluster.
const DocumentLattice = ({ pointer }) => {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    let geom = fitCanvas(canvas);
    const ctx = geom.ctx;
    let shellGrad = null, coreGrad = null, cachedR = 0;

    const buildGrads = () => {
      const cx = geom.w / 2, cy = geom.h / 2;
      const R = Math.min(geom.w, geom.h) / 2;
      cachedR = R;
      shellGrad = ctx.createRadialGradient(cx, cy, R * .32, cx, cy, R * .96);
      shellGrad.addColorStop(0, 'rgba(15,104,178,0)');
      shellGrad.addColorStop(.72, 'rgba(15,104,178,.085)');
      shellGrad.addColorStop(.92, 'rgba(235,23,0,.12)');
      shellGrad.addColorStop(1, 'rgba(235,23,0,0)');
      const coreR = R * .085 * 3.4;
      coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      coreGrad.addColorStop(0, 'rgba(255,255,255,.98)');
      coreGrad.addColorStop(.3, 'rgba(235,23,0,.34)');
      coreGrad.addColorStop(.68, 'rgba(140,59,187,.1)');
      coreGrad.addColorStop(1, 'rgba(140,59,187,0)');
    };
    buildGrads();

    const obs = new ResizeObserver(() => { geom = fitCanvas(canvas); buildGrads(); });
    obs.observe(canvas);

    const N = 30;
    const lattice = Array.from({ length: N }, (_, i) => ({
      lat: Math.acos(1 - 2 * (i + .5) / N),
      lon: Math.PI * (1 + Math.sqrt(5)) * i,
      rad: .74 + Math.random() * .16,
      prog: Math.random(),
      speed: .0026 + Math.random() * .0028,
      hue: Math.random() < .66 ? 0 : 1,
      size: 5 + Math.random() * 4,
    }));
    const STROKE = ['rgba(15,104,178,.62)', 'rgba(140,59,187,.58)'];
    const LINES = ['rgba(15,104,178,.4)', 'rgba(140,59,187,.36)'];
    let raf, lastFrame = 0;

    const draw = (t) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      if (t - lastFrame < (PERF.lite || PERF.calm ? 50 : 33)) return;
      if (geom.w < 2 || geom.h < 2) { geom = fitCanvas(canvas); buildGrads(); return; }
      lastFrame = t;

      const { w, h } = geom;
      const cx = w / 2, cy = h / 2, R = cachedR || Math.min(w, h) / 2;
      ctx.clearRect(0, 0, w, h);

      const tiltX = (pointer.current.y - .5) * .55;
      const tiltY = (pointer.current.x - .5) * .8;
      const spin = t * .00016;
      const pulse = (Math.sin(t / 1100) + 1) / 2;

      // cached shell, breathing via globalAlpha instead of a new gradient
      ctx.globalAlpha = .72 + pulse * .28;
      ctx.fillStyle = shellGrad;
      ctx.beginPath(); ctx.arc(cx, cy, R * .96, 0, 6.283); ctx.fill();
      ctx.globalAlpha = 1;

      const cosX = Math.cos(tiltX), sinX = Math.sin(tiltX);
      const cosY = Math.cos(tiltY), sinY = Math.sin(tiltY);
      const pts = [];
      for (let i = 0; i < lattice.length; i++) {
        const n = lattice[i];
        n.prog += n.speed;
        if (n.prog > 1) n.prog = 0;
        const e = n.prog < .42 ? n.prog / .42 : 1;
        const ease = 1 - (1 - e) * (1 - e) * (1 - e);
        const rr = (1.34 - (1.34 - n.rad) * ease) * R;
        const lon = n.lon + spin;
        const sl = Math.sin(n.lat);
        const x = rr * sl * Math.cos(lon);
        const y = rr * Math.cos(n.lat);
        const z = rr * sl * Math.sin(lon);
        const y2 = y * cosX - z * sinX;
        let z2 = y * sinX + z * cosX;
        const x2 = x * cosY + z2 * sinY;
        z2 = -x * sinY + z2 * cosY;
        const persp = 1 / (1 + z2 / (R * 3.4));
        pts.push({ sx: cx + x2 * persp, sy: cy + y2 * persp, z: z2, s: persp, n, settle: ease });
      }
      pts.sort((a, b) => a.z - b.z);

      // connections between settled nodes — single path
      const maxD2 = (R * .52) * (R * .52);
      ctx.strokeStyle = 'rgba(163,153,146,.2)';
      ctx.lineWidth = .7;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        if (a.settle < .96) continue;
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j];
          if (b.settle < .96) continue;
          const dx = a.sx - b.sx, dy = a.sy - b.sy;
          if (dx * dx + dy * dy < maxD2) { ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); }
        }
      }
      ctx.stroke();

      // settled glyphs batched; the few still tumbling drawn individually so
      // the rotation reads
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i];
        if (q.settle < .96) continue;
        const wd = q.n.size * q.s, ht = wd * 1.28;
        ctx.rect(q.sx - wd / 2, q.sy - ht / 2, wd, ht);
      }
      ctx.fill();
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i];
        if (q.settle >= .96) continue;
        const wd = q.n.size * q.s, ht = wd * 1.28;
        ctx.save();
        ctx.translate(q.sx, q.sy);
        ctx.rotate((1 - q.settle) * (q.n.hue === 0 ? .7 : -.6));
        ctx.fillStyle = 'rgba(255,255,255,.92)';
        ctx.strokeStyle = STROKE[q.n.hue];
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(-wd / 2, -ht / 2, wd, ht);
        ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      for (let hue = 0; hue < 2; hue++) {
        ctx.strokeStyle = STROKE[hue];
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const q = pts[i];
          if (q.n.hue !== hue || q.settle < .96) continue;
          const wd = q.n.size * q.s, ht = wd * 1.28;
          ctx.rect(q.sx - wd / 2, q.sy - ht / 2, wd, ht);
        }
        ctx.stroke();
        ctx.strokeStyle = LINES[hue];
        ctx.lineWidth = .8;
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const q = pts[i];
          if (q.n.hue !== hue || q.settle < .55) continue;
          const wd = q.n.size * q.s, ht = wd * 1.28;
          ctx.moveTo(q.sx - wd / 2 + 1.6, q.sy - ht * .18); ctx.lineTo(q.sx + wd / 2 - 1.6, q.sy - ht * .18);
          ctx.moveTo(q.sx - wd / 2 + 1.6, q.sy); ctx.lineTo(q.sx + wd / 2 - 1.6, q.sy);
          ctx.moveTo(q.sx - wd / 2 + 1.6, q.sy + ht * .18); ctx.lineTo(q.sx + wd / 2 - 1.6 - wd * .3, q.sy + ht * .18);
        }
        ctx.stroke();
      }

      // core — cached gradient
      ctx.fillStyle = coreGrad;
      ctx.beginPath(); ctx.arc(cx, cy, R * .085 * 3.4, 0, 6.283); ctx.fill();
      ctx.fillStyle = 'rgba(235,23,0,.92)';
      ctx.beginPath(); ctx.arc(cx, cy, R * .085 * (1 + pulse * .06), 0, 6.283); ctx.fill();
    };
    raf = requestAnimationFrame(draw);

    return () => { cancelAnimationFrame(raf); obs.disconnect(); };
  }, [pointer]);

  return <canvas ref={ref} className="absolute inset-0 w-full h-full block" />;
};

// Landing screen shown at /unstructured-explorer before a document set has
// been picked (i.e. no ?doctype= param yet).
// onSelect(id) - required, opens a document set
// allowed - ids the user has permission for; others are hidden
export default function UnstructuredWelcome({ onSelect, allowed }) {
  const explorers = allowed ? EXPLORERS.filter(e => allowed.includes(e.id)) : EXPLORERS;
  const firstOpen = explorers.find(e => !e.soon);
  useKeyframes();
  const rootRef = useRef(null);
  const vizWrapRef = useRef(null);
  const pointer = useRef({ x: .5, y: .5, cx: 0, cy: 0, active: false });
  const timerRef = useRef(null);
  const parallaxRef = useRef({ queued: false, tx: 0, ty: 0 });

  const [launch, setLaunch] = useState(null); // { step, target }
  const [vh, setVh] = useState(() => (typeof window === 'undefined' ? 900 : window.innerHeight));
  const showStats = vh >= 660;

  useEffect(() => {
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const onMove = useCallback((e) => {
    const r = rootRef.current;
    if (!r) return;
    const b = r.getBoundingClientRect();
    pointer.current = {
      x: (e.clientX - b.left) / b.width,
      y: (e.clientY - b.top) / b.height,
      cx: e.clientX - b.left,
      cy: e.clientY - b.top,
      active: true,
    };
    if (!parallaxRef.current.queued) {
      parallaxRef.current.queued = true;
      requestAnimationFrame(() => {
        parallaxRef.current.queued = false;
        const wrap = vizWrapRef.current;
        if (!wrap) return;
        const tx = Math.round(-(pointer.current.x - .5) * 26);
        const ty = Math.round(-(pointer.current.y - .5) * 20);
        if (tx === parallaxRef.current.tx && ty === parallaxRef.current.ty) return;
        parallaxRef.current.tx = tx; parallaxRef.current.ty = ty;
        wrap.style.transform = `translate(${tx}px,${ty}px)`;
      });
    }
  }, []);

  const onLeave = useCallback(() => { pointer.current.active = false; }, []);

  // Staged "intelligent system processing" transition, then hand off.
  const runLaunch = useCallback((target, done) => {
    clearTimeout(timerRef.current);
    setLaunch({ step: LAUNCH_STEPS[0], target });
    let i = 0;
    const tick = () => {
      i += 1;
      if (i < LAUNCH_STEPS.length) {
        setLaunch({ step: LAUNCH_STEPS[i], target });
        timerRef.current = setTimeout(tick, i === LAUNCH_STEPS.length - 1 ? 480 : 620);
      } else {
        setLaunch(null);
        if (done) done();
      }
    };
    timerRef.current = setTimeout(tick, 620);
  }, []);

  const openExplorer = (item) => runLaunch(`${item.name} workspace`, () => onSelect(item.id));

  return (
    <div
      ref={rootRef}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      style={{
        position: 'relative', height: '100%', overflow: 'hidden', color: '#312c2a', fontFamily: TEXT,
        background: 'radial-gradient(120% 96% at 80% 4%, #ffffff 0%, #faf9f7 42%, #f4f1ed 76%, #efebe5 100%)',
      }}
    >
      <AmbientField pointer={pointer} />
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,.7) 0%, rgba(255,255,255,0) 26%, rgba(241,238,233,.78) 100%)' }} />
      <div className="absolute pointer-events-none" style={{ top: '-16%', left: '48%', width: '44vw', height: '44vw', background: 'radial-gradient(circle, rgba(235,23,0,.13) 0%, rgba(140,59,187,.11) 40%, rgba(255,255,255,0) 70%)', animation: 'ue-halo 9s ease-in-out infinite' }} />

      <div
        className="relative"
        style={{
          display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', height: '100%', boxSizing: 'border-box',
          padding: 'clamp(14px, 2.2vh, 30px) clamp(28px, 4vw, 56px) clamp(16px, 2.6vh, 34px)',
          gap: 'clamp(12px, 2.2vh, 28px)',
        }}
      >
        {/* ═══ header ═══ */}
        <header className="flex items-center justify-between" style={{ gap: 24, animation: 'ue-fade .8s ease both' }}>
          <div className="flex items-center" style={{ gap: 16 }}>
            <img src="/sh_logo.png" alt="GRA SmartHub" draggable={false} className="select-none block" style={{ width: 104, height: 'auto' }} />
            <span className="block flex-none" style={{ width: 1, height: 30, background: 'rgba(175,165,155,.6)' }} />
            <div className="flex flex-col" style={{ gap: 3 }}>
              <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 14, letterSpacing: '.16em', textTransform: 'uppercase' }}>
                Unstructured Explorer
              </span>
              <span style={{ fontFamily: TEXT, fontSize: 10, letterSpacing: '.22em', textTransform: 'uppercase', color: '#6e6259' }}>
                Global Regulatory Affairs
              </span>
            </div>
          </div>
          <div className="flex items-center" style={{ gap: 10, padding: '7px 14px', borderRadius: 999, background: 'rgba(255,255,255,.72)', border: '1px solid rgba(110,98,89,.16)', boxShadow: '0 10px 26px -20px rgba(49,44,42,.6)' }}>
            <span className="relative block flex-none rounded-full" style={{ width: 7, height: 7, background: '#328714', boxShadow: '0 0 10px rgba(50,135,20,.55)' }}>
              <span className="absolute inset-0 block rounded-full" style={{ border: '1px solid rgba(50,135,20,.7)', animation: 'ue-ring 2.4s ease-out infinite' }} />
            </span>
            <span style={{ fontFamily: TEXT, fontSize: 10, letterSpacing: '.18em', textTransform: 'uppercase', color: '#6e6259' }}>
              Index synced · 4m ago
            </span>
          </div>
        </header>

        {/* ═══ hero ═══ */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(340px, 1.06fr) minmax(260px, .94fr)', alignItems: 'center', gap: 'clamp(24px, 4vw, 56px)', minHeight: 0, overflow: 'hidden' }}>
          <section className="flex flex-col items-start justify-center" style={{ maxWidth: 620, minHeight: 0, maxHeight: '100%', overflow: 'hidden' }}>
            <div className="inline-flex items-center" style={{ gap: 10, padding: '7px 14px 7px 10px', borderRadius: 999, background: 'rgba(255,255,255,.78)', border: '1px solid rgba(110,98,89,.24)', boxShadow: '0 12px 30px -22px rgba(49,44,42,.7)', animation: 'ue-rise .8s cubic-bezier(.16,1,.3,1) .05s both' }}>
              <span className="block flex-none rounded-full" style={{ width: 5, height: 5, background: '#eb1700', boxShadow: '0 0 8px rgba(235,23,0,.7)' }} />
              <span style={{ fontFamily: TEXT, fontSize: 10, letterSpacing: '.24em', textTransform: 'uppercase', color: '#0f68b2' }}>
                One governed workspace
              </span>
            </div>

            <h1 style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 'clamp(26px, 2.6vw + 2.2vh, 66px)', lineHeight: .98, letterSpacing: '-.035em', margin: 'clamp(9px, 2vh, 26px) 0 0', animation: 'ue-rise .9s cubic-bezier(.16,1,.3,1) .14s both' }}>
              Every document,<br />
              <span style={{ fontWeight: 300, fontStyle: 'italic', color: '#eb1700' }}>already understood.</span>
            </h1>

            <p style={{ fontFamily: TEXT, fontWeight: 300, fontSize: 'clamp(12px, .4vw + .9vh, 16.5px)', lineHeight: 1.52, color: '#6e6259', margin: 'clamp(8px, 1.6vh, 22px) 0 0', maxWidth: 486, textWrap: 'pretty', animation: 'ue-rise .9s cubic-bezier(.16,1,.3,1) .24s both' }}>
              Search, filter, and audit unstructured regulatory content across every connected
              document set. Records resolve as you type — nothing to prepare, nothing to load.
            </p>

            <div className="flex items-center" style={{ gap: 12, marginTop: 'clamp(12px, 3vh, 36px)', flexWrap: 'nowrap', animation: 'ue-rise .9s cubic-bezier(.16,1,.3,1) .34s both' }}>
              {firstOpen && <button
                type="button"
                onClick={() => openExplorer(firstOpen)}
                className="inline-flex items-center"
                style={{
                  gap: 12, padding: 'clamp(11px, 1.9vh, 17px) clamp(18px, 1.6vw, 26px)', border: '1px solid rgba(235,23,0,.34)',
                  borderRadius: 13, cursor: 'pointer', fontFamily: DISPLAY, fontWeight: 700, fontSize: 'clamp(13px, .3vw + .6vh, 14.5px)',
                  letterSpacing: '.04em', color: '#fff', background: '#eb1700',
                  boxShadow: '0 20px 40px -18px rgba(235,23,0,.6)',
                  transition: 'transform .28s cubic-bezier(.16,1,.3,1), box-shadow .28s ease, filter .28s ease',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.transform = 'translateY(-3px)';
                  e.currentTarget.style.boxShadow = '0 26px 54px -18px rgba(235,23,0,.5)';
                  e.currentTarget.style.filter = 'saturate(1.06)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.transform = 'none';
                  e.currentTarget.style.boxShadow = '0 20px 40px -18px rgba(235,23,0,.6)';
                  e.currentTarget.style.filter = 'none';
                }}
              >
                Begin exploring
                <span className="inline-flex items-center justify-center rounded-full" style={{ width: 24, height: 24, background: 'rgba(255,255,255,.2)' }}>→</span>
              </button>}

            </div>

            {showStats && (
              <div className="flex" style={{ gap: 'clamp(22px, 3vw, 40px)', marginTop: 'clamp(18px, 3.4vh, 44px)', animation: 'ue-rise .9s cubic-bezier(.16,1,.3,1) .44s both' }}>
                {[{ value: 'Governed', label: 'Every query logged' }].map(stat => (
                  <div key={stat.label} className="flex flex-col" style={{ gap: 5 }}>
                    <span style={{ fontFamily: DISPLAY, fontWeight: 500, fontSize: 'clamp(19px, .8vw + 1vh, 26px)', letterSpacing: '-.02em' }}>{stat.value}</span>
                    <span style={{ fontFamily: TEXT, fontSize: 9.5, letterSpacing: '.2em', textTransform: 'uppercase', color: '#6e6259' }}>{stat.label}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* animated visualization, parallaxed against the cursor */}
          <div className="flex flex-col items-center" style={{ gap: 14, width: '100%', maxWidth: 'min(520px, 46vh)', justifySelf: 'center', alignSelf: 'center' }}>
            <section ref={vizWrapRef} className="relative flex-none w-full" style={{ aspectRatio: '1 / 1', animation: 'ue-fade 1.4s ease .2s both' }}>
              <div className="absolute rounded-full" style={{ inset: '6%', border: '1px solid rgba(175,165,155,.35)' }} />
              <div className="absolute rounded-full" style={{ inset: '20%', border: '1px solid rgba(140,59,187,.16)' }} />
              <DocumentLattice pointer={pointer} />
            </section>
            <div className="flex items-center flex-none" style={{ gap: 10, padding: '8px 15px', borderRadius: 999, background: 'rgba(255,255,255,.86)', border: '1px solid rgba(110,98,89,.18)', boxShadow: '0 14px 34px -26px rgba(49,44,42,.8)', whiteSpace: 'nowrap' }}>
              <span className="block flex-none rounded-full" style={{ width: 5, height: 5, background: '#8c3bbb', boxShadow: '0 0 8px rgba(140,59,187,.6)' }} />
              <span style={{ fontFamily: TEXT, fontSize: 10, letterSpacing: '.16em', textTransform: 'uppercase', color: '#6e6259' }}>
                Live index · continuously updating
              </span>
            </div>
          </div>
        </div>

        {/* ═══ workspace picker ═══ */}
        <section className="flex flex-col" style={{ gap: 'clamp(10px, 1.6vh, 18px)', flex: '0 0 auto', animation: 'ue-rise 1s cubic-bezier(.16,1,.3,1) .54s both' }}>
          <div className="flex items-baseline justify-between" style={{ gap: 20 }}>
            <span style={{ fontFamily: TEXT, fontSize: 10, letterSpacing: '.24em', textTransform: 'uppercase', color: '#6e6259' }}>
              Or jump straight into a workspace
            </span>
            <span className="block" style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(175,165,155,.5), rgba(175,165,155,0))' }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(explorers.length, 1)}, minmax(0, 1fr))`, gap: 'clamp(6px, .7vw, 12px)' }}>
            {explorers.map((item, i) => (
              <button
                key={item.id}
                type="button"
                onClick={() => openExplorer(item)}
                aria-label={`Open ${item.name} explorer`}
                className="relative flex flex-col items-start text-left overflow-hidden"
                style={{
                  gap: 'clamp(6px, 1vh, 11px)', padding: 'clamp(12px, 1.7vh, 18px) 14px clamp(13px, 1.9vh, 19px)',
                  borderRadius: 18, cursor: 'pointer', border: '1px solid rgba(110,98,89,.16)',
                  background: 'linear-gradient(160deg, rgba(255,255,255,.94) 0%, rgba(250,249,247,.86) 100%)',
                  boxShadow: '0 18px 38px -30px rgba(49,44,42,.75)',
                  transition: 'transform .32s cubic-bezier(.16,1,.3,1), border-color .32s ease, box-shadow .32s ease, background .32s ease',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.transform = 'translateY(-6px)';
                  e.currentTarget.style.borderColor = 'rgba(235,23,0,.5)';
                  e.currentTarget.style.boxShadow = '0 28px 52px -26px rgba(235,23,0,.3)';
                  e.currentTarget.style.background = 'linear-gradient(160deg, #ffffff 0%, rgba(255,245,244,.94) 100%)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.transform = 'none';
                  e.currentTarget.style.borderColor = 'rgba(110,98,89,.16)';
                  e.currentTarget.style.boxShadow = '0 18px 38px -30px rgba(49,44,42,.75)';
                  e.currentTarget.style.background = 'linear-gradient(160deg, rgba(255,255,255,.94) 0%, rgba(250,249,247,.86) 100%)';
                }}
              >
                <span className="flex items-center justify-between w-full">
                  <span className="inline-flex items-center" style={{ gap: 9 }}>
                    <span className="inline-flex items-center justify-center flex-none" style={{ width: 28, height: 28, borderRadius: 9, background: 'rgba(235,23,0,.07)' }}>
                      <img src={item.icon} alt="" className="block" style={{ width: 15, height: 15, filter: TINT_RED }} />
                    </span>
                    <span style={{ fontFamily: TEXT, fontSize: 10, letterSpacing: '.18em', color: '#0f68b2' }}>{String(i + 1).padStart(2, '0')}</span>
                  </span>
                </span>
                <span style={{ fontFamily: DISPLAY, fontWeight: 500, fontSize: 'clamp(16px, 1.1vw + .3vh, 19px)', letterSpacing: '-.015em' }}>{item.name}</span>
                <span style={{ fontFamily: TEXT, fontWeight: item.soon ? 500 : 300, fontSize: 12, lineHeight: 1.45, paddingRight: 18, color: item.soon ? '#eb1700' : '#6e6259' }}>{item.description}</span>
                <img src={chevronRightIcon} alt="" className="absolute block" style={{ right: 16, bottom: 16, width: 13, height: 13, filter: TINT_RED }} />
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* ═══ processing transition ═══ */}
      {launch && (
        <div
          className="fixed inset-0 grid place-items-center"
          style={{ zIndex: 40, background: 'radial-gradient(80% 70% at 50% 50%, rgba(255,255,255,.94) 0%, rgba(243,240,235,.96) 70%)', animation: 'ue-fade .34s ease both' }}
        >
          <div className="flex flex-col items-center" style={{ gap: 26, width: 'min(420px, 78vw)' }}>
            <div className="relative grid place-items-center" style={{ width: 96, height: 96 }}>
              <div className="absolute inset-0 rounded-full" style={{ border: '1px solid rgba(235,23,0,.45)', animation: 'ue-ring 2s ease-out infinite' }} />
              <div className="absolute inset-0 rounded-full" style={{ border: '1px solid rgba(15,104,178,.4)', animation: 'ue-ring 2s ease-out .66s infinite' }} />
              <div style={{ width: 26, height: 26, borderRadius: 8, background: 'linear-gradient(140deg, #eb1700, #8c3bbb)', boxShadow: '0 0 30px rgba(235,23,0,.45)', animation: 'ue-halo 1.6s ease-in-out infinite' }} />
            </div>
            <span style={{ fontFamily: DISPLAY, fontWeight: 500, fontSize: 16, letterSpacing: '.02em' }}>{launch.step}</span>
            <div className="relative overflow-hidden" style={{ width: '100%', height: 2, borderRadius: 999, background: 'rgba(175,165,155,.35)' }}>
              <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(235,23,0,0), #eb1700 45%, #8c3bbb 72%, rgba(140,59,187,0))', animation: 'ue-bar 1.15s ease-in-out infinite' }} />
            </div>
            <span style={{ fontFamily: TEXT, fontSize: 10, letterSpacing: '.2em', textTransform: 'uppercase', color: '#6e6259' }}>{launch.target}</span>
          </div>
        </div>
      )}
    </div>
  );
}