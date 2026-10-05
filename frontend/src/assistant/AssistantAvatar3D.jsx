import React, { useEffect, useMemo, useRef, Suspense, Component } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, useAnimations } from '@react-three/drei';
import * as THREE from 'three';
import { SkeletonUtils } from 'three-stdlib';
import { DEFAULT_AVATAR_ID, avatarById } from './avatarOptions';

// Delete this block
// once @react-three/fiber ships the Timer migration in a stable release.
if (typeof window !== 'undefined' && !console.warn.__r3fClockWarningFiltered) {
  const originalWarn = console.warn;
  const filtered = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('THREE.Clock: This module has been deprecated')) return;
    originalWarn.apply(console, args);
  };
  filtered.__r3fClockWarningFiltered = true;
  console.warn = filtered;
}

/*
  3D assistant — the rigged Mixamo character with real walk / idle / point /
  work clips. This is WebGL (three.js via react-three-fiber), so unlike the SVG
  version it uses the GPU.

  It plugs into the same walk system: assistantActions.js translates the wrapper
  button across the screen and toggles classes on it. This component watches that
  button and switches clips to match:
    .assistant-walking -> Walk (and turns to face data-dir)
    .assistant-acting  -> Point (one shot), then back to Idle
    otherwise          -> Idle

  Put assistant.glb (and any other selectable characters — see avatarOptions.js)
  in /public/assets/.

  Props:
    avatarId      - which registered character to show (avatarOptions.js). Swapping
                    this swaps the .glb; three/drei cache each URL separately, so
                    flipping back to one already seen doesn't re-fetch it.
    reduceMotion  - when true, drops the idle wandering/sway/cursor-follow so the
                    character mostly just holds still and faces the user. Wired
                    from the panel's "Reduce motion" setting in FloatingAssistant.
    speakingRef   - ref carrying 0..1 live speech amplitude (from useAzureVoice's
                    onLevel). NOTE: this model (assistant.glb) has no mouth morph
                    targets and no jaw bone — it's a stock Mixamo body rig, so real
                    lip-sync isn't possible on this asset. What we do instead is a
                    small head/chest pulse timed to the amplitude, so speaking still
                    reads as physical rather than the body being totally inert while
                    the mouth-less face "talks." True lip-sync needs a re-rigged
                    model with viseme blend shapes — see PROD_NOTES below.
    emotion       - current assistant emotion ('neutral' | 'happy' | 'concerned' |
                    'celebrating' | 'thinking' | 'curious'). Same caveat: no facial
                    blend shapes on this mesh, so this only nudges posture (head
                    pitch, idle energy) rather than changing an expression.
    interactive   - true for the one real, on-screen assistant widget; false for
                    any other simultaneously-mounted copy (e.g. the settings
                    panel's avatar picker, which live-renders every character at
                    once). Only the interactive instance reads the shared
                    `[data-assistant-avatar]` element and tracks the pointer —
                    see useAvatarSignals() below for why that matters.
*/

// Preloading the GLB at module-eval time means it starts fetching the instant
// FloatingAssistant is imported, before the browser has painted anything else.
// Push it to idle time instead — it still preloads well before the user could
// plausibly click the avatar, but it no longer competes with first paint.
// Only the default character is preloaded eagerly; other registered avatars are
// fetched on demand the first time the user picks them (brief Suspense fallback).
const idle = typeof window !== 'undefined' && window.requestIdleCallback
  ? window.requestIdleCallback
  : (fn) => setTimeout(fn, 200);
idle(() => useGLTF.preload(avatarById(DEFAULT_AVATAR_ID).url));

function useAvatarSignals(interactive) {
  const sig = useRef({ walking: false, acting: false, dir: 1 });
  useEffect(() => {
    if (!interactive) return;
    const el = document.querySelector('[data-assistant-avatar]');
    if (!el) return;
    const read = () => {
      sig.current.walking = el.classList.contains('assistant-walking');
      sig.current.acting = el.classList.contains('assistant-acting');
      sig.current.thinking = el.classList.contains('assistant-thinking');
      sig.current.dir = el.dataset.dir === '-1' ? -1 : 1;
      sig.current.point = el.dataset.point === 'kneel' ? 'kneel' : 'stand';
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(el, { attributes: true, attributeFilter: ['class', 'data-dir', 'data-point'] });
    return () => obs.disconnect();
  }, [interactive]);
  return sig;
}

// Where she faces the user. If front/back ever look swapped, change this one value
// (Math.PI <-> 0). It was Math.PI, which showed her back; 0 faces the user.
const FACE_USER = 0;

// Idle gaze: she mostly faces the user and only now and then glances to a side or (rarely)
// turns away, then comes back. `w` = how often it's chosen, `hold` = [min,max] seconds to keep it.
const IDLE_LOOKS = [
  { a: FACE_USER,        w: 8,   hold: [4, 8] },   // face the user (dominant)
  { a: FACE_USER - 0.5,  w: 1.5, hold: [1.5, 3] }, // small glance right
  { a: FACE_USER + 0.5,  w: 1.5, hold: [1.5, 3] }, // small glance left
  { a: FACE_USER - 1.1,  w: 0.7, hold: [1.5, 2.5] }, // turned right
  { a: FACE_USER + 1.1,  w: 0.7, hold: [1.5, 2.5] }, // turned left
  { a: Math.PI,          w: 0.4, hold: [1.5, 2.5] }, // rarely, turns her back to the user
];
function pickIdleLook() {
  const total = IDLE_LOOKS.reduce((s, o) => s + o.w, 0);
  let r = Math.random() * total;
  for (const o of IDLE_LOOKS) { r -= o.w; if (r <= 0) return o; }
  return IDLE_LOOKS[0];
}

// reusable math objects (avoid allocating every frame)
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

// Cursor gaze — when idle she turns to watch the pointer without leaving her spot:
// the body yaws toward it and the head adds a little turn/tilt on top.
// If a direction ever comes out reversed, flip the matching SIGN constant.
const MAX_BODY_YAW = 0.6;    // how far the body turns toward the cursor (~34°)
const MAX_HEAD_YAW = 0.30;   // extra head turn layered on top
const MAX_HEAD_PITCH = 0.26; // head tilt up/down toward the cursor
const HEAD_YAW_SIGN = -1;
const HEAD_PITCH_SIGN = -1;
// idle-only weight shift: a slow, tiny sway so standing-still moments don't read
// as frozen. Amplitude is intentionally small — this rides on top of the Idle clip.
const IDLE_SWAY_AMP = 0.028;
const IDLE_SWAY_HZ = 0.18;
// emotion -> small head-pitch bias applied while idle/settled, so posture reads
// as "off" even though the mesh has no facial blend shapes to actually express it.
const EMOTION_PITCH_BIAS = { happy: 0.035, celebrating: 0.06, concerned: -0.05, curious: 0.02 };
// speaking pulse: subtle head-forward/up nod timed to live speech amplitude, since
// there's no jaw/mouth rig to drive real lip-sync on this model (see file header).
const SPEAK_PULSE_AMP = 0.05;

function Character({ modelUrl, reduceMotion, speakingRef, emotion, interactive }) {
  const sig = useAvatarSignals(interactive);
  const group = useRef();
  const { scene: cachedScene, animations } = useGLTF(modelUrl);
  // Never mount `cachedScene` directly — see comment above. Each Character gets
  // its own clone, so simultaneous instances of the same character (main widget
  // + a matching preview card) don't share one Object3D fighting over a parent.
  const scene = useMemo(() => SkeletonUtils.clone(cachedScene), [cachedScene]);
  const { actions } = useAnimations(animations, group);
  const cur = useRef('Idle');
  const acted = useRef(false);
  const look = useRef({ target: FACE_USER, timer: 2 }); // idle gaze: where she's turned + seconds left
  const wrap = useRef(null);                            // on-screen avatar box (for cursor math)
  const mouse = useRef({ x: 0, y: 0, active: false });
  const headBone = useRef(null);
  const headLook = useRef({ yaw: 0, pitch: 0 });
  const avatarCenter = () => {
    const b = wrap.current?.getBoundingClientRect();
    return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
  };

  useEffect(() => {
    // Mixamo skinned meshes carry a bind-pose bounding box, so three culls them
    // the moment the animated pose leaves it -> they blink out. Disable culling.
    scene.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    // face the user immediately (don't wait for the idle lerp to rotate her there)
    if (group.current) group.current.rotation.y = FACE_USER;
    look.current.target = FACE_USER;
    // start idling — no fadeIn here on purpose: a fade only makes sense crossfading
    // FROM an already-playing clip. On first mount nothing is playing yet, so a
    // fadeIn briefly blends Idle at partial weight against the raw bind pose
    // (a T-pose) showing through underneath — visible as a flash of T-pose right
    // as the avatar loads. Snap straight to full weight instead.
    actions?.Idle?.reset().play();
    return () => Object.values(actions || {}).forEach((a) => a?.stop());
  }, [actions, scene]);

  // grab the head bone for gaze (needed regardless — emotion/speaking posture
  // applies even to non-interactive instances), but only the interactive
  // instance tracks the pointer / looks up the shared wrapper element.
  useEffect(() => {
    // Mixamo exports name this bone "mixamorig:Head" or "mixamorigHead" depending
    // on the exporter — match both, but not HeadTop_End etc.
    headBone.current = null;
    scene.traverse((o) => {
      if (!o.isBone || headBone.current) return;
      if (o.name.replace(/^mixamorig:?/i, '') === 'Head') headBone.current = o;
    });
    if (!interactive) return;
    wrap.current = document.querySelector('[data-assistant-avatar]');
    const onMove = (e) => { mouse.current.x = e.clientX; mouse.current.y = e.clientY; mouse.current.active = true; };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMove);
  }, [scene, interactive]);

  const play = (name, { once = false } = {}) => {
    if (!actions?.[name] || cur.current === name) return;
    const next = actions[name];
    const prev = actions[cur.current];
    // walking -> idle gets a longer, easier crossfade so she settles instead of
    // snapping into the idle pose; every other transition keeps the snappier fade.
    const settling = cur.current === 'Walk' && name === 'Idle';
    const fade = settling ? 0.6 : 0.25;
    next.reset();
    if (once) { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true; }
    else next.setLoop(THREE.LoopRepeat, Infinity);
    next.fadeIn(fade).play();
    prev?.fadeOut(fade);
    cur.current = name;
  };

  useFrame((_, delta) => {
    // tab backgrounded: browsers already throttle rAF heavily, but skip the work
    // outright rather than doing pointless trig on a frame nobody sees.
    if (document.hidden) return;

    const s = sig.current;

    // clip selection
    if (s.thinking && !s.walking && !s.acting) {
      acted.current = false;
      play('Think');
    } else if (s.acting) {
      if (!acted.current) { play(s.point === 'kneel' ? 'KneelPoint' : 'Point', { once: true }); acted.current = true; }
    } else {
      acted.current = false;
      play(s.walking ? 'Walk' : 'Idle');
    }

    // facing.
    //  - walking/pointing: face the way she's going / the thing she's addressing (±90°)
    //  - thinking: snap to face the user so the think pose is visible
    //  - truly idle: drift between natural orientations every few seconds (look around,
    //    half-turn, occasionally turn her back) so she feels alive instead of frozen
    //  - reduceMotion: skip the wandering entirely and just hold facing the user
    if (group.current) {
      const Q = Math.PI / 2;
      const facingDir = s.walking || s.acting;
      let target, k;
      if (facingDir) {
        target = s.dir === -1 ? -Q : Q;
        k = s.walking ? 0.35 : 0.2;
        look.current.timer = 0;            // re-roll a fresh idle look when she settles
      } else if (s.thinking) {
        target = FACE_USER;                // face the user
        k = 0.15;
        look.current.timer = 0;
      } else if (reduceMotion) {
        target = FACE_USER;
        k = 0.08;
      } else if (mouse.current.active) {
        // watch the cursor: turn toward its horizontal position, hold there otherwise
        const c = avatarCenter();
        const dxN = c ? THREE.MathUtils.clamp((c.x - mouse.current.x) / (window.innerWidth * 0.5), -1, 1) : 0;
        look.current.target = FACE_USER - dxN * MAX_BODY_YAW;
        target = look.current.target;
        k = 0.15;                          // responsive, still smooth
      } else {
        look.current.timer -= delta;
        if (look.current.timer <= 0) {
          const pick = pickIdleLook();
          look.current.target = pick.a;
          look.current.timer = pick.hold[0] + Math.random() * (pick.hold[1] - pick.hold[0]);
        }
        target = look.current.target;
        k = 0.035;                         // slow, lazy turn
      }
      let d = target - group.current.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d)); // shortest way round
      group.current.rotation.y += d * k;
    }

    // subtle head tracking on top of the body turn (idle + cursor only). Applied after
    // the mixer has posed the bones, so the idle animation still shows through.
    // Skipped under reduceMotion — that's exactly the kind of small reactive motion
    // the setting exists to remove.
    const hb = headBone.current;
    if (hb) {
      let ty = 0, tp = 0;
      if (!reduceMotion && !s.walking && !s.acting && !s.thinking && mouse.current.active) {
        const c = avatarCenter();
        if (c) {
          const dxN = THREE.MathUtils.clamp((c.x - mouse.current.x) / (window.innerWidth * 0.5), -1, 1);
          const dyN = THREE.MathUtils.clamp((c.y - mouse.current.y) / (window.innerHeight * 0.5), -1, 1);
          ty = HEAD_YAW_SIGN * dxN * MAX_HEAD_YAW;
          tp = HEAD_PITCH_SIGN * dyN * MAX_HEAD_PITCH;
        }
      }
      // emotion posture bias + speaking pulse ride on top of cursor tracking, and
      // stay active even under reduceMotion at a much smaller scale (they carry
      // actual state information — mid-speech / mood — not decorative wandering).
      const bias = EMOTION_PITCH_BIAS[emotion] || 0;
      const level = speakingRef?.current || 0;
      const pulse = level > 0.02 ? Math.sin(performance.now() / 1000 * 9) * level * SPEAK_PULSE_AMP : 0;
      const scale = reduceMotion ? 0.35 : 1;
      tp += (bias + pulse) * scale;

      headLook.current.yaw += (ty - headLook.current.yaw) * 0.18;
      headLook.current.pitch += (tp - headLook.current.pitch) * 0.18;
      _e.set(headLook.current.pitch, headLook.current.yaw, 0, 'XYZ');
      _q.setFromEuler(_e);
      hb.quaternion.premultiply(_q);       // rotate the head in the body's frame
    }

    // idle weight shift: only while truly standing still (not walking/acting/thinking
    // and not actively watching the cursor), a slow sine sway on the hips so idle
    // moments feel like she's settled on her feet rather than paused. Off entirely
    // under reduceMotion.
    if (group.current) {
      const s2 = sig.current;
      const trulyIdle = !reduceMotion && !s2.walking && !s2.acting && !s2.thinking && !mouse.current.active;
      const swayTarget = trulyIdle ? Math.sin(performance.now() / 1000 * IDLE_SWAY_HZ * Math.PI * 2) * IDLE_SWAY_AMP : 0;
      group.current.rotation.z += (swayTarget - group.current.rotation.z) * 0.05;
    }
  });

  return <primitive ref={group} object={scene} position={[0, -0.23, 0]} />;
}

// Plain CSS/SVG stand-in shown while the GLB is still loading, or permanently if it
// fails to load at all (bad network, asset missing, etc). Keeps the avatar slot from
// ever going visually blank — see AvatarErrorBoundary below.
function AvatarPlaceholder() {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: '14%' }}>
      <div style={{
        width: '38%', aspectRatio: '1', borderRadius: '50%',
        background: 'linear-gradient(160deg, #eb1700, #7a0f00)',
        opacity: 0.9,
      }} />
    </div>
  );
}

class AvatarErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { console.error('[AssistantAvatar3D] failed to render 3D avatar, falling back to placeholder:', err); }
  render() { return this.state.failed ? <AvatarPlaceholder /> : this.props.children; }
}

export default function AssistantAvatar3D({
  avatarId = DEFAULT_AVATAR_ID, reduceMotion = false, speakingRef, emotion = 'neutral', interactive = true,
} = {}) {
  const modelUrl = avatarById(avatarId).url;
  return (
    // key remounts the whole boundary+scene when the character changes, so a
    // previous character's error state (or stale scene graph) never bleeds
    // into the newly picked one.
    <AvatarErrorBoundary key={avatarId}>
      <Canvas
        camera={{ position: [0, 0, 6.2], fov: 32 }}
        style={{ width: '100%', height: '100%', pointerEvents: 'none', background: 'transparent' }}
        gl={{ alpha: true, antialias: true }}
        dpr={interactive ? [1, 2] : 1}
        onCreated={({ gl }) => {
          const canvas = gl.domElement;
          // Required or the browser won't even attempt to restore the context —
          // without this listener a context loss (GPU memory pressure from an
          // unrelated heavy re-render elsewhere on the page, tab backgrounding,
          // a driver hiccup) leaves the avatar permanently blank.
          canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            console.warn('[assistant] avatar WebGL context lost — attempting recovery');
          });
          canvas.addEventListener('webglcontextrestored', () => {
            console.info('[assistant] avatar WebGL context restored');
          });
        }}
      >
        <ambientLight intensity={0.9} />
        <directionalLight position={[2, 4, 3]} intensity={1.1} />
        <directionalLight position={[-3, 2, -2]} intensity={0.4} />
        <Suspense fallback={null}>
          <Character modelUrl={modelUrl} reduceMotion={reduceMotion} speakingRef={speakingRef} emotion={emotion} interactive={interactive} />
        </Suspense>
      </Canvas>
    </AvatarErrorBoundary>
  );
}