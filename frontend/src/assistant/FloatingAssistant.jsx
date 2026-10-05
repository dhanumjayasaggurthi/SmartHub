import React, { useState, useRef, useEffect, useCallback, Suspense, lazy } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { runAction, describeAction, executeAction, stopTour, resolveRoute } from './assistantActions';
import { tipForPath, emotionFor, promptsForPath } from './pageTips';
import { useSpeech } from './useSpeech';
import { useAzureVoice } from './useAzureVoice';
import { getScreen } from './screenContext';
import { captureScreen } from './captureScreen';
import './liquid-glass'; // exposes window.liquidGlass (Chromium refraction, frosted fallback elsewhere)

// three.js + @react-three/fiber/drei are the single biggest chunk in this app
// (2.5MB+ pre-split) — split into their own lazily-fetched chunk instead of
// bundling them into the main entry, so the rest of the portal doesn't pay for
// them on every load before it can even paint.
const AssistantAvatar3D = lazy(() => import('./AssistantAvatar3D'));
import { AVATAR_OPTIONS, DEFAULT_AVATAR_ID, avatarById } from './avatarOptions';

// JJ icon assets — same convention as Dashboard.jsx/Sidebar.jsx: a flat mono SVG from
// /icons, recolored with a CSS filter rather than swapping files per color. Swap these
// filenames for whatever's actually in public/icons if they don't match.
import micIcon from "/icons/JJ_Icon_Record_RGB.svg";
import speakerOnIcon from "/icons/JJ_Icon_Sound_On_RGB.svg";
import speakerOffIcon from "/icons/JJ_Icon_Sound_Off_RGB.svg";
import editIcon from "/icons/JJ_Icon_Edit_RGB.svg";
import alertIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import gearIcon from "/icons/JJ_Icon_Gear_RGB.svg";

const Icon = ({ src, alt, className = "w-4 h-4", style = {} }) => (
  <img src={src} alt={alt} className={className} style={style} />
);
// `brightness(0)` turns any opaque pixel pure black regardless of the source SVG's
// own fill color — the safest way to guarantee black, no matter what's in the file.
const BLACK_ICON_FILTER = 'brightness(0) saturate(100%)';

// Chat replies come back with light markdown (`code`, **bold**) but we render plain
// strings today, so backticks/asterisks show up literally. Rather than pull in a full
// markdown lib for a chat bubble, parse just the two inline forms we actually see.
function renderInlineMarkdown(text, keyPrefix = '') {
  if (!text) return text;
  const nodes = [];
  const codeSplit = text.split(/(`[^`]+`)/g);
  codeSplit.forEach((segment, i) => {
    if (segment.length > 1 && segment.startsWith('`') && segment.endsWith('`')) {
      nodes.push(
        <code key={`${keyPrefix}-c${i}`}
          className="px-1 py-0.5 mx-0.5 rounded bg-jj-gray-03/70 text-jj-gray-08 text-[0.92em] font-mono">
          {segment.slice(1, -1)}
        </code>
      );
      return;
    }
    const boldSplit = segment.split(/(\*\*[^*]+\*\*)/g);
    boldSplit.forEach((part, j) => {
      if (part.length > 3 && part.startsWith('**') && part.endsWith('**')) {
        nodes.push(<strong key={`${keyPrefix}-b${i}-${j}`}>{part.slice(2, -2)}</strong>);
      } else if (part) {
        nodes.push(<React.Fragment key={`${keyPrefix}-t${i}-${j}`}>{part}</React.Fragment>);
      }
    });
  });
  return nodes;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const IDLE_MS = 2000;

// Tells the backend what actually happened with a dispatched action (do_action /
// highlight_on_screen / navigate_to / guide_tour), so the model's next turn can
// say something true about it instead of the old "sent, not confirmed" default.
// Best-effort and fire-and-forget on purpose: if this fails or is slow, the
// worst case is the backend falls back to its old honest-uncertainty message —
// never worth blocking or retrying at the cost of the chat feeling laggy.
async function postActionAck(ackId, success, detail, getAccessToken) {
  if (!ackId) return;
  try {
    const token = await getAccessToken();
    await fetch(`${API_BASE_URL}/assistant/action-ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ack_id: ackId, success, detail: detail || '' }),
    });
  } catch { /* best-effort — see comment above */ }
}

// avatar box size + how far you have to move before a click counts as a drag
const AV_W_BASE = 200;
const AV_H_BASE = 230;
const AVATAR_SIZE_SCALE = { small: 0.75, medium: 1, large: 1.3 };
const CORNER_BLEED = 28;      // how far the avatar's empty padding spills off-screen (avatar only)
const PANEL_GAP = 12;         // gap the chat panel keeps from the edge so it never clips
const PANEL_W = 384;          // chat panel size (matches sm:w-96 / h-[28rem]) — used to keep it on screen
const PANEL_H = 448;
const DRAG_THRESHOLD = 3;

// quick-start chips shown only on the empty chat state — generic enough to make sense
// on every page, since we don't know what's on screen until the user picks one.
const SUGGESTED_PROMPTS = [
  "What's on this screen?",
  'Give me a tour',
  'Highlight the main action',
  "How's our data quality?",
];

// resting spot: last-used side/top persisted for the session, else hard bottom-right.
function defaultPos() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('regwiz-pos') || 'null');
    if (saved && typeof saved.top === 'number') {
      return { side: saved.side === 'left' ? 'left' : 'right', top: Math.max(0, Math.min(window.innerHeight - AV_H_BASE, saved.top)) };
    }
  } catch {}
  return { side: 'right', top: window.innerHeight - AV_H_BASE };
}

export default function FloatingAssistant() {
  const { getAccessToken, user } = useAuth();
  const userEmail = user?.email || user?.username || '';
  const location = useLocation();
  const navigate = useNavigate();

  const [open, setOpen] = useState(() => {
    try { return sessionStorage.getItem('regwiz-open') === '1'; } catch { return false; }
  });
  const [state, setState] = useState('listening');
  const [emotion, setEmotion] = useState('neutral');
  const [tip, setTip] = useState(null);
  const [messages, setMessages] = useState(() => {
    // Conversation used to vanish on every refresh (plain useState([]), gone the
    // instant the tab reloaded mid-task). sessionStorage survives a refresh but
    // still clears on tab close, which is the right lifetime here — this is a
    // convenience carry-over, not a long-term transcript store (that's the
    // backend's per-user memory now, a short rolling summary, not the raw text).
    try {
      const saved = JSON.parse(sessionStorage.getItem('regwiz-messages') || 'null');
      return Array.isArray(saved) ? saved : [];
    } catch { return []; }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [toast, setToast] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('appearance');
  const [avatarId, setAvatarId] = useState(() => {
    try {
      const saved = localStorage.getItem('regwiz-avatar-id');
      if (saved && AVATAR_OPTIONS.some((a) => a.id === saved)) return saved;
    } catch {}
    return DEFAULT_AVATAR_ID;
  });
  useEffect(() => { try { localStorage.setItem('regwiz-avatar-id', avatarId); } catch {} }, [avatarId]);
  const [appearance, setAppearance] = useState(() => {
    try { return localStorage.getItem('regwiz-appearance') === 'transparent' ? 'transparent' : 'standard'; } catch { return 'standard'; }
  });
  const [reduceMotion, setReduceMotion] = useState(() => {
    try {
      const saved = localStorage.getItem('regwiz-reduce-motion');
      if (saved != null) return saved === '1';
    } catch {}
    // no explicit choice yet — honor the OS setting instead of defaulting to "off"
    try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return false; }
  });
  const [textSize, setTextSize] = useState(() => {
    try { return localStorage.getItem('regwiz-text-size') || 'medium'; } catch { return 'medium'; }
  });
  const [avatarSize, setAvatarSize] = useState(() => {
    try {
      const saved = localStorage.getItem('regwiz-avatar-size');
      if (saved && AVATAR_SIZE_SCALE[saved]) return saved;
    } catch {}
    return 'medium';
  });
  useEffect(() => { try { localStorage.setItem('regwiz-avatar-size', avatarSize); } catch {} }, [avatarSize]);
  // Effective box size the avatar renders/drags/docks at — everything downstream
  // (position math, panel/tip placement) reads AV_W/AV_H off this, not the base
  // constants, so picking a size actually resizes the whole floating widget.
  const avScale = AVATAR_SIZE_SCALE[avatarSize] || 1;
  const AV_W = Math.round(AV_W_BASE * avScale);
  const AV_H = Math.round(AV_H_BASE * avScale);
  // Growing the avatar can push it (or the panel) off-screen if it was docked
  // near an edge at a smaller size — re-clamp whenever the size changes.
  useEffect(() => {
    setPos((p) => ({ ...p, top: Math.max(0, Math.min(window.innerHeight - AV_H, p.top)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [AV_H]);
  useEffect(() => { try { localStorage.setItem('regwiz-appearance', appearance); } catch {} }, [appearance]);
  useEffect(() => { try { localStorage.setItem('regwiz-reduce-motion', reduceMotion ? '1' : '0'); } catch {} }, [reduceMotion]);
  useEffect(() => { try { localStorage.setItem('regwiz-text-size', textSize); } catch {} }, [textSize]);
  const [autoSendVoice, setAutoSendVoice] = useState(() => {
    try { return localStorage.getItem('regwiz-auto-send-voice') !== '0'; } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem('regwiz-auto-send-voice', autoSendVoice ? '1' : '0'); } catch {} }, [autoSendVoice]);

  // ── Backend sync — settings also live in the assistant_settings table,
  // keyed by user email, so they survive cleared browser storage / new devices.
  // localStorage above still writes on every change for instant load next time.
  const settingsLoadedFromServer = useRef(false);
  useEffect(() => {
    if (!userEmail) return;
    (async () => {
      try {
        const token = await getAccessToken();
        const res = await fetch(`${API_BASE_URL}/api/audit/assistant-settings`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        const s = data?.settings;
        if (s) {
          if (s.avatar_id && AVATAR_OPTIONS.some((a) => a.id === s.avatar_id)) setAvatarId(s.avatar_id);
          if (s.appearance) setAppearance(s.appearance);
          if (typeof s.reduce_motion === 'boolean') setReduceMotion(s.reduce_motion);
          if (s.text_size) setTextSize(s.text_size);
          if (s.avatar_size && AVATAR_SIZE_SCALE[s.avatar_size]) setAvatarSize(s.avatar_size);
          if (typeof s.auto_send_voice === 'boolean') setAutoSendVoice(s.auto_send_voice);
        }
      } catch {
        // offline or backend down — just keep whatever localStorage/defaults gave us
      } finally {
        settingsLoadedFromServer.current = true;
      }
    })();
  }, [userEmail, getAccessToken]);

  useEffect(() => {
    if (!userEmail || !settingsLoadedFromServer.current) return; // don't push until initial pull is done
    const t = setTimeout(() => {
      (async () => {
        const token = await getAccessToken();
        fetch(`${API_BASE_URL}/api/audit/assistant-settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            avatar_id: avatarId,
            appearance,
            reduce_motion: reduceMotion,
            text_size: textSize,
            avatar_size: avatarSize,
            auto_send_voice: autoSendVoice,
          }),
        }).catch(() => {});
      })();
    }, 500); // debounce so rapid toggle changes don't spam the API
    return () => clearTimeout(t);
  }, [userEmail, avatarId, appearance, reduceMotion, textSize, avatarSize, autoSendVoice, getAccessToken]);

  const TEXT_SIZE_PX = { small: 12, medium: 13, large: 15 };
  const clearConversation = () => {
    setMessages([]); setPendingAction(null); setCanRetry(false); setOpenSources(new Set());
    try { sessionStorage.removeItem('regwiz-messages'); } catch {}
  };
  const resetAvatarPosition = () => {
    const d = { side: 'right', top: window.innerHeight - AV_H };
    setPos(d);
    try { sessionStorage.removeItem('regwiz-pos'); } catch {}
  };
  const resetSettingsDefaults = () => {
    setAppearance('standard');
    setTextSize('medium');
    setAvatarSize('medium');
    setReduceMotion(false);
    setAutoSendVoice(true);
    if (!voiceOn) setVoiceOn(true);
    setAvatarId(DEFAULT_AVATAR_ID);
  };
  const [pendingAction, setPendingAction] = useState(null);
  // which answers have their sources list open (by message index) - all closed by default
  const [openSources, setOpenSources] = useState(() => new Set());
  const toggleSources = (i) => setOpenSources((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });
  // a pending "let the assistant click X?" belongs to the answer being stopped
  const pendingActionRef = useRef(null);
  useEffect(() => { pendingActionRef.current = pendingAction; }, [pendingAction]);
  const [canRetry, setCanRetry] = useState(false);
  const lastSentRef = useRef('');

  // where the avatar sits, and the live cursor-follow box while it's being dragged
  const [pos, setPos] = useState(defaultPos);
  const [drag, setDrag] = useState(null);   // { dx, dy } while dragging (avatar or panel handle), else null
  const dragInfo = useRef(null);

  const speakingRef = useRef(0);

  const faceWrap = useRef(null);
  const idleTimer = useRef(null);
  const seenTips = useRef(new Set());
  const scrollRef = useRef(null);
  const panelRef = useRef(null);   // liquid-glass attaches here while the panel is open
  const voiceOnRef = useRef(true);
  useEffect(() => { voiceOnRef.current = voiceOn; }, [voiceOn]);
  const emotionRef = useRef('neutral');
  useEffect(() => { emotionRef.current = emotion; }, [emotion]);
  const voiceNameRef = useRef(avatarById(DEFAULT_AVATAR_ID).voice);
  useEffect(() => { voiceNameRef.current = avatarById(avatarId).voice; }, [avatarId]);
  // always points at the latest send(); lets stable callbacks (voice transcript handler)
  // call the current send instead of a stale first-render closure.
  const sendRef = useRef(null);

  // ---- voice out: neural (Azure) with mouth driven by real audio amplitude ----
  const azure = useAzureVoice({
    apiBase: API_BASE_URL,
    getToken: getAccessToken,
    onLevel: (l) => { speakingRef.current = l; },
  });
  const { ttsUnavailable } = azure;

  // ---- voice fallback + mic (browser) ----
  const bumpMouth = useCallback(() => {
    speakingRef.current = 1;
    setTimeout(() => { speakingRef.current *= 0.5; }, 80);
  }, []);

  const handleTranscript = useCallback((text, final) => {
    setInput(text);
    if (final && text.trim() && autoSendVoiceRef.current) setTimeout(() => sendRef.current?.(text.trim()), 120);
  }, []);
  const autoSendVoiceRef = useRef(true);
  useEffect(() => { autoSendVoiceRef.current = autoSendVoice; }, [autoSendVoice]);

  const speech = useSpeech({
    onBoundary: bumpMouth,
    onTranscript: handleTranscript,
    onError: (msg) => { setToast(msg); setTimeout(() => setToast(null), 4000); },
  });

  // how many reply sentence-queues are still being worked through (a counter, so
  // an older stopped one finishing can't clear the flag for a newer one)
  const pumpActiveRef = useRef(0);
  const stillTalking = useCallback(
    () => pumpActiveRef.current > 0 || azure.isSpeaking() || speech.isSpeaking(), [azure, speech]);
  const cancelVoice = useCallback(() => { azure.cancel(); speech.cancelSpeech(); }, [azure, speech]);
  // between tour steps: end the current line only, keep the next steps' prefetched audio
  const skipVoiceLine = useCallback(() => { azure.skip(); speech.cancelSpeech(); }, [azure, speech]);

  // while a guided tour runs, the tour speaks each step itself — so suppress the
  // separate sentence-by-sentence narration of the chat text (that's what was
  // drifting out of sync with the highlights).
  const tourActiveRef = useRef(false);
  const streamCtrl = useRef(null);
  const [running, setRunning] = useState(false); // true while thinking / speaking / touring

  // drive the 3D Think animation: toggle the class imperatively (not via React className,
  // which would clobber the walking/acting classes the action layer adds).
  useEffect(() => {
    const el = document.querySelector('[data-assistant-avatar]');
    if (el) el.classList.toggle('assistant-thinking', state === 'thinking');
  }, [state]);

  // one-time CSS for the chat's animated "thinking…" dots
  useEffect(() => {
    if (document.getElementById('assistant-think-dots')) return;
    const s = document.createElement('style');
    s.id = 'assistant-think-dots';
    s.textContent =
      '@keyframes regwiz-wf{0%,100%{transform:scaleY(0.3)}50%{transform:scaleY(1)}}';
    document.head.appendChild(s);
  }, []);

  // hard stop: abort the in-flight response, halt any running tour, and silence the
  // voice queue. Used both by the Stop button and at the start of every new command,
  // so a previous answer never keeps talking over the new one.
  // polls for "voice finished" after a reply so the Stop button can go away -
  // one at a time, cleared on every stop/new send so an old one can't hide the
  // Stop button in the middle of the next answer
  const voiceWaitRef = useRef(null);
  const clearVoiceWait = useCallback(() => {
    if (voiceWaitRef.current) { clearInterval(voiceWaitRef.current); voiceWaitRef.current = null; }
  }, []);
  const stopAll = useCallback(() => {
    try { streamCtrl.current?.abort(); } catch { /* nothing in flight */ }
    clearVoiceWait();
    tourActiveRef.current = false;
    stopTour();
    cancelVoice();
    const pa = pendingActionRef.current;
    if (pa) {
      postActionAck(pa.ackId, false, 'user pressed Stop', getAccessToken);
      setPendingAction(null);
    }
    setBusy(false);
    setRunning(false);
    setState('idle');
  }, [cancelVoice, clearVoiceWait, getAccessToken]);

  const prepareLine = useCallback((text) => (voiceOnRef.current ? azure.prepare(text, emotionRef.current, voiceNameRef.current) : Promise.resolve(null)), [azure]);
  const playLine = useCallback((handle) => azure.play(handle), [azure]);

  // speak one line and resolve only when it has finished playing, so the tour can
  // hold each highlight exactly while she's talking. Returns true if it spoke.
  const speakLine = useCallback(async (text) => {
    const t = (text || '').trim();
    if (!voiceOnRef.current || !t) return false;
    let r = false;
    try { r = await azure.speak(t, emotionRef.current, voiceNameRef.current); } catch { r = false; }
    if (r) return true;
    if (r === null) return false;         // stopped - stay silent, no fallback voice
    try { speech.speak(t); } catch { /* no browser voice */ }   // browser fallback has no end signal
    return false;                        // -> caller falls back to reading-time pacing
  }, [azure, speech]);

  // always-fresh busy for callbacks that outlive a render (timeouts, listeners) —
  // the old version closed over `busy` from whichever render created it, so a tip
  // timer or idle timeout could flip the emotion mid-answer.
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const setEmotionIfIdle = useCallback((e) => setEmotion((cur) => (busyRef.current ? cur : e)), []);

  // ---- cursor tracking ----
  // bound once; reads busy through the ref so it never needs re-binding
  useEffect(() => {
    const onMove = (e) => {
      const box = faceWrap.current?.getBoundingClientRect();
      if (!box) return;
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
      if (dist < 150) setEmotionIfIdle('happy');
      if (!busyRef.current) setState('listening');
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => {
        if (!busyRef.current) { setState('idle'); setEmotionIfIdle('neutral'); }
      }, IDLE_MS);
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => { window.removeEventListener('mousemove', onMove); clearTimeout(idleTimer.current); };
  }, [setEmotionIfIdle]);

  // ---- contextual tip on route change ----
  useEffect(() => {
    const t = tipForPath(location.pathname);
    if (t && !seenTips.current.has(location.pathname)) {
      seenTips.current.add(location.pathname);
      const id = setTimeout(() => { setTip(t); setEmotionIfIdle('curious'); }, 900);
      const hide = setTimeout(() => setTip(null), 7000);
      return () => { clearTimeout(id); clearTimeout(hide); };
    }
  }, [location.pathname, setEmotionIfIdle]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, open]);

  // scroll-to-latest pill: only when the user has scrolled up during a longer reply
  const [atBottom, setAtBottom] = useState(true);
  const onScrollMessages = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };
  const scrollToLatest = () => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });

  useEffect(() => { try { sessionStorage.setItem('regwiz-open', open ? '1' : '0'); } catch {} }, [open]);
  useEffect(() => { try { sessionStorage.setItem('regwiz-pos', JSON.stringify(pos)); } catch {} }, [pos]);
  useEffect(() => {
    // bounded — this is a reload-survival convenience, not a growing log. Keep
    // only the most recent messages so a very long session doesn't bloat
    // sessionStorage (5MB-ish browser quota, shared with everything else).
    try {
      const capped = messages.length > 60 ? messages.slice(-60) : messages;
      sessionStorage.setItem('regwiz-messages', JSON.stringify(capped));
    } catch {}
  }, [messages]);

  // ---- send ----
  const send = useCallback(async (override) => {
    const text = (override ?? input).trim();
    if (!text || busy) return;
    setTip(null);
    setCanRetry(false);
    lastSentRef.current = text;
    stopAll(); // kill any previous tour/voice/stream so it doesn't bleed into this one

    const controller = new AbortController();
    streamCtrl.current = controller;
    const stopped = () => controller.signal.aborted;   // Stop pressed / a newer message took over

    const history = [...messages, { role: 'user', content: text, ts: Date.now() }];
    setMessages([...history, { role: 'assistant', content: '', ts: Date.now() }]);
    setInput('');
    setBusy(true);
    setRunning(true);
    setState('thinking');
    setEmotion('thinking');

    // Error bubbles are UI state, not conversation. They carry role "error",
    // which the chat API rejects outright — and since the whole transcript is
    // resent every turn, one failed request would otherwise poison every
    // request after it until the user cleared the chat.
    const wire = history
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content || '').trim())
      .map(({ role, content }) => ({ role, content }));
    // full screen access: read the live DOM every time, plus any structured data
    // a page chose to publish (which is cleaner, so it overrides on key clashes).
    const screen = { ...captureScreen(), route: location.pathname, search: location.search, url: window.location.href, ...(getScreen() || {}) };
    let firstToken = true;
    let thinking = true; // model is working until the first token of a round arrives
    let fullText = '';
    let spokenIdx = 0;

    // speak completed sentences without blocking the text stream
    let useBrowserTTS = false;
    const speakQueue = [];
    let pumping = false;
    // Speech pipeline: a chunk's audio starts downloading the moment the chunk is
    // queued (see enqueueSpeech), and the pump hands finished clips to the
    // player in order - so later sentences are synthesized while earlier ones
    // play, and there's no silent gap between them.
    const pump = async () => {
      if (pumping) return;
      pumping = true;
      pumpActiveRef.current += 1;
      try {
        while (speakQueue.length) {
          if (stopped()) { speakQueue.length = 0; break; }
          const { sentence, prep } = speakQueue.shift();
          if (!voiceOnRef.current) continue;
          if (!prep) { speech.speak(sentence); continue; }       // browser voice mode
          const handle = await prep;
          if (handle?.cancelled || stopped()) { speakQueue.length = 0; break; }   // Stop - silence, no fallback
          if (!handle) {
            // neural voice unavailable - say this and anything already queued with the browser voice
            useBrowserTTS = true;
            speech.speak(sentence);
            speakQueue.splice(0).forEach((x) => speech.speak(x.sentence));
            // silent before this — the queue just quietly switched voices with
            // no sign anything changed. One quiet toast, not one per sentence.
            setToast('Voice quality dropped — using your browser\u2019s built-in voice for now.');
            setTimeout(() => setToast(null), 4000);
            continue;
          }
          azure.play(handle);   // queues right behind whatever is playing - no gap
        }
      } finally {
        pumping = false;
        pumpActiveRef.current = Math.max(0, pumpActiveRef.current - 1);
      }
    };
    const enqueueSpeech = (text) => {
      if (!voiceOnRef.current || stopped()) return;
      const prep = useBrowserTTS ? null : azure.prepare(text, emotionRef.current, voiceNameRef.current);
      speakQueue.push({ sentence: text, prep });
      pump();
    };
    const speakPending = (force) => {
      if (tourActiveRef.current || stopped()) return; // the tour narrates its own steps
      const pending = fullText.slice(spokenIdx);
      if (!pending.trim()) return;
      if (force) { enqueueSpeech(pending.trim()); spokenIdx = fullText.length; return; }
      // The FIRST chunk goes out as soon as there's one sentence (or a clause of
      // ~90 chars) so the voice starts fast; after that, bigger chunks (2+
      // sentences or ~200 chars) keep it flowing - and since clips are fetched
      // ahead of playback, the bigger chunks don't add gaps.
      if (spokenIdx === 0) {
        const first = pending.match(/^[\s\S]*?[.!?](?=\s|$)/);
        const clause = pending.length >= 90 ? pending.match(/^[\s\S]{40,}?[,;:](?=\s)/) : null;
        const cut = first && first[0].trim().length >= 12 ? first[0] : clause ? clause[0] : null;
        if (cut) { enqueueSpeech(cut.trim()); spokenIdx += cut.length; }
        return;
      }
      const enders = [...pending.matchAll(/[.!?](?=\s|$)/g)];
      if (!enders.length) return;
      const end = enders[enders.length - 1].index + 1;
      if (enders.length >= 2 || end >= 200) {
        const chunk = pending.slice(0, end).trim();
        if (chunk) { enqueueSpeech(chunk); spokenIdx += end; }
      }
    };

    try {
      const token = await getAccessToken();
      const res = await fetch(`${API_BASE_URL}/assistant/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: wire, screen }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`assistant returned ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop();
        for (const evt of events) {
          const line = evt.trim();
          if (!line.startsWith('data:')) continue;
          let data; try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }

          if (data.type === 'token') {
            if (thinking) { thinking = false; setState('speaking'); }
            if (firstToken) firstToken = false;
            if (!voiceOnRef.current) bumpMouth();
            fullText += data.text;
            appendToLast(data.text);
            speakPending(false);
          } else if (data.type === 'status') {
            if (data.state === 'thinking') { thinking = true; setState('thinking'); }
          } else if (data.type === 'sources') {
            attachSources(data.sources);
          } else if (data.type === 'action') {
            const ackId = data.action.ack_id;
            if (data.action.name === 'do_action') {
              const { destructive, label } = describeAction(data.action);
              if (destructive) {
                // waiting on the user's own Allow/Cancel click — tell the model that
                // plainly now rather than pretending it's "sent" like a normal action.
                // The confirm UI only renders inside the open panel, so force it open —
                // otherwise a collapsed panel means the user never sees anything to
                // Allow/Cancel and the action just hangs.
                setOpen(true);
                postActionAck(ackId, null, 'awaiting user confirmation before acting', getAccessToken);
                setPendingAction({ action: data.action, label, ackId });
              } else {
                executeAction(data.action)
                  .then((ok) => postActionAck(ackId, ok, '', getAccessToken))
                  .catch(() => postActionAck(ackId, false, 'threw before finishing', getAccessToken));
              }
            } else if (data.action.name === 'guide_tour') {
              tourActiveRef.current = true;
              cancelVoice(); // stop any chat-text narration that already started
              setOpen(false); // get the panel out of the way of the highlighted screen
              postActionAck(ackId, true, 'tour started', getAccessToken); // long-running/narrated — ack the start, not the finish
              Promise.resolve(runAction(data.action, navigate, { speak: speakLine, prepare: prepareLine, play: playLine, cancel: cancelVoice, skip: skipVoiceLine }))
                .finally(() => { tourActiveRef.current = false; setRunning(false); });
            } else if (data.action.name === 'highlight_on_screen') {
              setOpen(false); // same here — a highlight ring shouldn't sit behind the chat
              Promise.resolve(runAction(data.action, navigate))
                .then((ok) => postActionAck(ackId, ok !== false, '', getAccessToken))
                .catch(() => postActionAck(ackId, false, 'threw before finishing', getAccessToken));
            } else if (data.action.name === 'navigate_to') {
              // Ack the real outcome, not an assumed one. This used to always
              // report success, so when the model invented a route that matched
              // nothing the user got a blank page AND was told the navigation
              // had worked.
              const target = resolveRoute(data.action.args?.route);
              if (!target) {
                postActionAck(ackId, false, `No page matches "${data.action.args?.route}" — nothing was opened.`, getAccessToken);
              } else {
                Promise.resolve(runAction(data.action, navigate))
                  .then((r) => postActionAck(ackId, r ? r.ok !== false : true, r?.detail || '', getAccessToken))
                  .catch((err) => postActionAck(ackId, false, err?.message || 'navigation failed', getAccessToken));
              }
            } else {
              runAction(data.action, navigate);
              postActionAck(ackId, true, '', getAccessToken);
            }
          } else if (data.type === 'error') {
            setMessages((prev) => [...prev, { role: 'error', content: data.message, ts: Date.now() }]);
            setEmotion('concerned');
            setCanRetry(true);
          }
        }
      }
      speakPending(true);
      setEmotion(emotionFor(fullText));
    } catch (err) {
      if (err.name === 'AbortError') { /* user stopped it on purpose */ }
      else { setMessages((prev) => [...prev, { role: 'error', content: `Something went wrong: ${err.message}`, ts: Date.now() }]); setEmotion('concerned'); setCanRetry(true); }
    } finally {
      // if stopped, stopAll already reset everything - and if a newer message
      // started, this older one must not touch busy/running state underneath it
      if (!stopped()) finishTurn();
    }

    function finishTurn() {
      setBusy(false);
      if (voiceOnRef.current) {
        clearVoiceWait();
        const startedWaiting = Date.now();
        voiceWaitRef.current = setInterval(() => {
          // done talking - or 3 minutes as a backstop so the Stop button can't stick forever
          if (!stillTalking() || Date.now() - startedWaiting > 180000) {
            clearVoiceWait();
            if (stillTalking()) cancelVoice();
            setState('listening');
            if (!tourActiveRef.current) setRunning(false);
            setTimeout(() => setEmotionIfIdle('neutral'), 1500);
          }
        }, 250);
      } else {
        setState('listening');
        if (!tourActiveRef.current) setRunning(false);
        setTimeout(() => setEmotionIfIdle('neutral'), 2000);
      }
    }
  }, [input, busy, messages, getAccessToken, navigate, azure, speech, bumpMouth, cancelVoice, stillTalking, speakLine, prepareLine, playLine, stopAll, location.pathname, location.search, setEmotionIfIdle, clearVoiceWait, skipVoiceLine]);

  // keep the ref current so the voice transcript handler always runs the latest send
  useEffect(() => { sendRef.current = send; }, [send]);

  const retryLast = useCallback(() => {
    const text = lastSentRef.current;
    if (!text) return;
    // drop everything from the last user message onward (the failed attempt and
    // whatever error/partial-assistant content came after it), then resend fresh.
    // Slicing off a fixed last-2 assumed a clean user+assistant pair, which broke
    // if an error message or action landed in between.
    setMessages((prev) => {
      const lastUserIdx = [...prev].reverse().findIndex((m) => m.role === 'user');
      if (lastUserIdx === -1) return prev;
      return prev.slice(0, prev.length - 1 - lastUserIdx);
    });
    setTimeout(() => sendRef.current?.(text), 0);
  }, []);

  const appendToLast = (chunk) =>
    setMessages((prev) => {
      const copy = [...prev];
      copy[copy.length - 1] = { ...copy[copy.length - 1], content: copy[copy.length - 1].content + chunk };
      return copy;
    });

  const attachSources = (sources) =>
    setMessages((prev) => {
      const copy = [...prev];
      copy[copy.length - 1] = { ...copy[copy.length - 1], sources };
      return copy;
    });

  const onKeyDown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

  // let a user correct a wrong answer — it gets saved as knowledge for next rebuild.
  // Renders inline (see teachIdx below) instead of window.prompt(), which was
  // blocking, unstyled, and unusable on mobile / with assistive tech.
  const [teachIdx, setTeachIdx] = useState(null);
  const [teachText, setTeachText] = useState('');
  const [teachBusy, setTeachBusy] = useState(false);
  const teach = useCallback((assistantIdx) => { setTeachIdx(assistantIdx); setTeachText(''); }, []);
  const cancelTeach = useCallback(() => { setTeachIdx(null); setTeachText(''); }, []);
  const submitTeach = useCallback(async () => {
    const correction = teachText.trim();
    if (!correction || teachIdx == null) return;
    const question = [...messages].slice(0, teachIdx).reverse().find(m => m.role === 'user')?.content || '';
    setTeachBusy(true);
    try {
      const token = await getAccessToken();
      await fetch(`${API_BASE_URL}/assistant/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ question, correction }),
      });
      setToast('Thanks — saved. It takes effect after the next knowledge rebuild.');
      setTimeout(() => setToast(null), 4000);
    } catch {
      setToast("Couldn't save that — try again.");
      setTimeout(() => setToast(null), 4000);
    } finally {
      setTeachBusy(false);
      setTeachIdx(null);
      setTeachText('');
    }
  }, [messages, getAccessToken, teachIdx, teachText]);

  const toggleVoice = () => setVoiceOn((v) => { if (v) cancelVoice(); return !v; });
  const toggleMic = () => {
    if (speech.listening) speech.stopListening();
    else { cancelVoice(); speech.startListening(); }
  };

  // ---- drag the avatar+panel group around ----
  // Grab either the avatar or the panel header — both are just "handles" onto the
  // same group. Press and move past a few px -> drag (whole group follows the
  // cursor via a shared dx/dy delta). Let go -> snap the avatar to the nearest
  // side, keep the height; the panel re-derives its position from that. A press
  // without moving is just a click on the avatar -> open/close the chat.
  const beginGroupDrag = (handle) => (e) => {
    const avatarBox = faceWrap.current.getBoundingClientRect();
    const panelBox = open && panelRef.current ? panelRef.current.getBoundingClientRect() : null;
    dragInfo.current = {
      startX: e.clientX, startY: e.clientY,
      baseAvatarLeft: avatarBox.left, baseAvatarTop: avatarBox.top,
      basePanelLeft: panelBox ? panelBox.left : null,
      basePanelTop: panelBox ? panelBox.top : null,
      moved: false, handle,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };
  const onAvatarPointerDown = beginGroupDrag('avatar');
  const onPanelHeaderPointerDown = (e) => {
    if (e.target.closest('button')) return; // let the mic/voice/close buttons work normally
    beginGroupDrag('panel')(e);
  };

  const onGroupPointerMove = (e) => {
    const d = dragInfo.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) d.moved = true;
    if (d.moved) setDrag({ dx, dy });
  };

  const onGroupPointerUp = (e) => {
    const d = dragInfo.current;
    dragInfo.current = null;
    if (!d) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}

    if (!d.moved) {
      if (d.handle === 'avatar') {
        azure.primeAudio(); // guaranteed user gesture — best place to unlock audio
        setOpen((o) => !o); // it was a tap, not a drag
      }
      setDrag(null);
      return;
    }

    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const left = d.baseAvatarLeft + dx;
    const top = Math.max(0, Math.min(window.innerHeight - AV_H, d.baseAvatarTop + dy));
    const side = left + AV_W / 2 < window.innerWidth / 2 ? 'left' : 'right';
    setPos({ side, top });
    setDrag(null);
  };

  // keep it on screen if the window is resized
  useEffect(() => {
    const onResize = () => setPos((p) => ({
      ...p,
      top: Math.max(0, Math.min(window.innerHeight - AV_H, p.top)),
    }));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Liquid-glass on the chat panel. The panel is conditionally rendered, so the
  // effect is keyed to `open`: attach when it mounts, destroy when it goes away.
  // Refraction only lands in Chromium; Safari/Firefox get the frosted fallback
  // from the module, so nothing here may carry meaning — it's just material.
  useEffect(() => {
    if (!open || !panelRef.current || !window.liquidGlass) return;
    const glass = window.liquidGlass(panelRef.current, {
      scale: 0,         // no displacement at all — background stays pixel-aligned
      chroma: 0,        // no prism fringe either
      mapBlur: 10,
      blur: 0,
      saturate: 1,
      fallbackBlur: 4,
    });
    return () => glass.destroy();
  }, [open]);


  // Each piece is positioned on its own against the viewport so nothing can get clipped,
  // no matter where the avatar is dragged.
  const onLeft = pos.side === 'left';
  const openUp = pos.top > window.innerHeight / 2;   // avatar in lower half -> open upward
  const sideKey = onLeft ? 'left' : 'right';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // how far in from the edge the avatar's visible body ends — the panel sits just past it
  const besideOffset = AV_W - CORNER_BLEED;

  // avatar: follows the cursor while dragging (via the shared delta, whichever handle
  // was grabbed); otherwise snapped to a side and nudged into the corner so its empty
  // padding spills off-screen instead of taking up room.
  const avatarStyle = drag
    ? { position: 'fixed', left: dragInfo.current.baseAvatarLeft + drag.dx, top: dragInfo.current.baseAvatarTop + drag.dy }
    : { position: 'fixed',
        top: pos.top + (openUp ? CORNER_BLEED : -CORNER_BLEED),
        [sideKey]: -CORNER_BLEED };

  // Panel size actually used, clamped to the viewport — on short/narrow mobile
  // screens PANEL_W/PANEL_H (sized for desktop) could otherwise overflow off-screen
  // or get clipped. These feed BOTH the inline size and the position math below,
  // so what's drawn and what's measured never drift apart.
  const panelWEff = Math.min(PANEL_W, window.innerWidth - PANEL_GAP * 2);
  const panelHEff = Math.min(PANEL_H, window.innerHeight - PANEL_GAP * 2);
  // how far the panel sits from the screen edge, past the avatar — pulled in on
  // narrow viewports so a full-width panel doesn't get pushed off-screen next to it.
  const besideOffsetEff = Math.max(PANEL_GAP, Math.min(besideOffset, window.innerWidth - panelWEff - PANEL_GAP));

  // chat panel: sits NEXT TO the avatar (to his open side), vertically centred on him,
  // then clamped so the whole panel always stays inside the viewport. While dragging,
  // it translates by the same delta as the avatar so the pair always moves as one.
  const panelTop = clamp(
    pos.top + AV_H / 2 - panelHEff / 2,
    PANEL_GAP,
    window.innerHeight - panelHEff - PANEL_GAP,
  );
  const panelStyle = drag && dragInfo.current.basePanelLeft != null
    ? { position: 'fixed', left: dragInfo.current.basePanelLeft + drag.dx, top: dragInfo.current.basePanelTop + drag.dy, width: panelWEff, height: panelHEff, pointerEvents: 'auto' }
    : { position: 'fixed', top: panelTop, [sideKey]: besideOffsetEff, width: panelWEff, height: panelHEff, pointerEvents: 'auto' };

  // little tip bubble: same idea, tucked beside the avatar
  const tipTop = clamp(pos.top + AV_H / 2 - 32, PANEL_GAP, window.innerHeight - 80);
  const tipStyle = { position: 'fixed', top: tipTop, [sideKey]: besideOffset, pointerEvents: 'auto' };

  return (
    <div data-assistant-root className="fixed inset-0 z-50 select-none" style={{ pointerEvents: 'none' }}>

      {open && (
        <div ref={panelRef}
             className={`flex flex-col overflow-hidden ${appearance === 'transparent' ? 'regwiz-glass regwiz-glass--transparent' : 'regwiz-glass'} ${reduceMotion ? 'regwiz-reduce-motion' : ''}`}
             style={panelStyle}>
          <div className={settingsOpen
              ? 'flex flex-col touch-none'
              : `px-4 py-3.5 border-b border-white/30 flex items-center justify-between touch-none ${drag ? 'cursor-grabbing' : 'cursor-grab'}`}
               onPointerDown={onPanelHeaderPointerDown}
               onPointerMove={onGroupPointerMove}
               onPointerUp={onGroupPointerUp}>
            {settingsOpen ? (
              <div className="px-4 pt-4 pb-3 bg-jj-red">
                <div className="flex items-center gap-2 mb-3.5">
                  <button onClick={() => setSettingsOpen(false)} className="text-white/90 hover:text-white active:opacity-70 transition-colors text-base leading-none">←</button>
                  <span className="font-johnson-display text-white">Settings</span>
                </div>
                <div className="flex gap-4">
                  {[['avatar', 'Avatar'], ['appearance', 'Appearance'], ['behavior', 'Behavior'], ['data', 'Data']].map(([key, label]) => (
                    <button key={key} onClick={() => setSettingsTab(key)}
                      className={`text-xs font-johnson-text pb-1.5 transition-colors active:opacity-70 ${settingsTab === key ? 'text-white font-bold border-b-2 border-white' : 'text-white/60 hover:text-white/90'}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-jj-green-01" />
              <span className="font-johnson-display text-jj-gray-08">Regwiz</span>
            </span>
            <div className="flex items-center gap-2">
              {ttsUnavailable ? (
                <span title="Voice isn't configured on this server — text-only for now"
                  className="text-[10px] font-johnson-text text-jj-gray-04 uppercase tracking-wide">
                  Voice off
                </span>
              ) : (
                <button onClick={toggleVoice} title={voiceOn ? 'Mute voice' : 'Unmute voice'}
                  className="text-jj-gray-05 hover:text-jj-gray-08">
                  <Icon src={voiceOn ? speakerOnIcon : speakerOffIcon}
                    alt={voiceOn ? 'Mute voice' : 'Unmute voice'} className="w-[18px] h-[18px]"
                    style={{ filter: BLACK_ICON_FILTER }} />
                </button>
              )}
              <button onClick={() => setSettingsOpen(true)} title="Settings"
                  className="text-jj-gray-05 hover:text-jj-gray-08 active:opacity-70 transition-colors">
                  <Icon src={gearIcon} alt="Settings" className="w-[18px] h-[18px]" style={{ filter: BLACK_ICON_FILTER }} />
                </button>
              <button onClick={() => { cancelVoice(); setOpen(false); }}
                className="text-jj-gray-05 hover:text-jj-gray-08">✕</button>
            </div>
              </>
            )}
          </div>

          {settingsOpen ? (
            <div className="flex-1 overflow-auto p-4 flex flex-col gap-5">
              {settingsTab === 'avatar' && (
                <div className="flex flex-col -mt-1">
                  <div className="text-[11px] font-johnson-text font-bold uppercase tracking-wide text-jj-gray-05 mb-2">Choose your assistant</div>
                  <div className="grid grid-cols-2 gap-2.5">
                    {AVATAR_OPTIONS.map((a) => (
                      <button key={a.id} onClick={() => setAvatarId(a.id)}
                        className={`rounded-2xl p-2.5 text-center border-2 transition-colors active:scale-[0.98] relative ${avatarId === a.id ? 'border-jj-red bg-red-50' : 'border-jj-gray-03 hover:border-jj-gray-05'}`}>
                        {avatarId === a.id && (
                          <span className="absolute top-2 right-2 w-[18px] h-[18px] rounded-full bg-jj-red text-white text-[10px] flex items-center justify-center z-10">✓</span>
                        )}
                        {/* Live render of each character, same as the real floating avatar —
                            just scaled into a card-sized box. Keeping the box's aspect ratio
                            close to the floating widget's (200x230) is what keeps the model
                            framed correctly; a mismatched aspect is what left the earlier
                            single big preview blank/off-frame. */}
                        <div className="w-full rounded-xl mb-1.5 overflow-hidden bg-jj-gray-01" style={{ aspectRatio: '200 / 230' }}>
                          <Suspense fallback={<div className="w-full h-full" style={{ background: a.swatch }} />}>
                            <AssistantAvatar3D avatarId={a.id} reduceMotion interactive={false} emotion="neutral" />
                          </Suspense>
                        </div>
                        <span className="text-xs font-johnson-text font-semibold text-jj-gray-08 block">{a.name}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] font-johnson-text text-jj-gray-05 mt-3">
                    Saved to this browser. Switching reloads the 3D model — a brief flicker while the new file loads is expected.
                  </p>
                </div>
              )}
              {settingsTab === 'appearance' && (
                <>
                  <div>
                    <div className="text-[11px] font-johnson-text font-bold uppercase tracking-wide text-jj-gray-05 mb-2">Appearance</div>
                    <div className="flex gap-2">
                      <button onClick={() => setAppearance('standard')}
                        className={`flex-1 rounded-xl p-2.5 text-center border-2 transition-colors active:scale-[0.98] ${appearance === 'standard' ? 'border-jj-red' : 'border-jj-gray-03 hover:border-jj-gray-05'}`}>
                        <div className="h-9 rounded-lg bg-jj-gray-01 border border-jj-gray-03 mb-1.5" />
                        <span className="text-xs font-johnson-text font-semibold text-jj-gray-08">Standard</span>
                      </button>
                      <button onClick={() => setAppearance('transparent')}
                        className={`flex-1 rounded-xl p-2.5 text-center border-2 transition-colors active:scale-[0.98] ${appearance === 'transparent' ? 'border-jj-red' : 'border-jj-gray-03 hover:border-jj-gray-05'}`}>
                        <div className="h-9 rounded-lg mb-1.5" style={{ background: 'linear-gradient(160deg, rgba(255,255,255,0.7), rgba(255,255,255,0.3))', border: '1px solid #d5cfc9', backdropFilter: 'blur(4px)' }} />
                        <span className="text-xs font-johnson-text font-semibold text-jj-gray-08">Transparent</span>
                      </button>
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-johnson-text font-bold uppercase tracking-wide text-jj-gray-05 mb-2">Text size</div>
                    <div className="flex gap-1.5">
                      {['small', 'medium', 'large'].map((sz) => (
                        <button key={sz} onClick={() => setTextSize(sz)}
                          className={`flex-1 py-1.5 rounded-lg font-johnson-text capitalize transition-colors active:scale-[0.97] ${textSize === sz ? 'bg-jj-red text-white font-semibold' : 'bg-jj-gray-01 text-jj-gray-08 hover:bg-jj-gray-02'}`}
                          style={{ fontSize: TEXT_SIZE_PX[sz] }}>
                          {sz}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-johnson-text font-bold uppercase tracking-wide text-jj-gray-05 mb-2">Avatar size</div>
                    <div className="flex gap-1.5">
                      {['small', 'medium', 'large'].map((sz) => (
                        <button key={sz} onClick={() => setAvatarSize(sz)}
                          className={`flex-1 py-1.5 rounded-lg font-johnson-text capitalize transition-colors active:scale-[0.97] ${avatarSize === sz ? 'bg-jj-red text-white font-semibold' : 'bg-jj-gray-01 text-jj-gray-08 hover:bg-jj-gray-02'}`}>
                          {sz}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
              {settingsTab === 'behavior' && (
                <div className="flex flex-col -mt-1">
                  <div className="flex items-center justify-between py-3 border-b border-jj-gray-02">
                    <div>
                      <div className="text-sm font-johnson-text text-jj-gray-08">Reduce motion</div>
                      <div className="text-[11px] font-johnson-text text-jj-gray-05">Stops waveform &amp; typing animations</div>
                    </div>
                    <button onClick={() => setReduceMotion((v) => !v)}
                      role="switch" aria-checked={reduceMotion} aria-label="Reduce motion"
                      className={`w-9 h-5 rounded-full relative transition-colors active:opacity-80 shrink-0 ${reduceMotion ? 'bg-jj-red' : 'bg-jj-gray-03 hover:bg-jj-gray-04'}`}>
                      <span className={`absolute top-[2px] w-4 h-4 rounded-full bg-white transition-all ${reduceMotion ? 'right-[2px]' : 'left-[2px]'}`} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between py-3 border-b border-jj-gray-02">
                    <div>
                      <div className="text-sm font-johnson-text text-jj-gray-08">Voice replies</div>
                      <div className="text-[11px] font-johnson-text text-jj-gray-05">Regwiz reads answers aloud</div>
                    </div>
                    <button onClick={toggleVoice}
                      role="switch" aria-checked={voiceOn} aria-label="Voice replies"
                      className={`w-9 h-5 rounded-full relative transition-colors active:opacity-80 shrink-0 ${voiceOn ? 'bg-jj-red' : 'bg-jj-gray-03 hover:bg-jj-gray-04'}`}>
                      <span className={`absolute top-[2px] w-4 h-4 rounded-full bg-white transition-all ${voiceOn ? 'right-[2px]' : 'left-[2px]'}`} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between py-3">
                    <div>
                      <div className="text-sm font-johnson-text text-jj-gray-08">Auto-send after voice</div>
                      <div className="text-[11px] font-johnson-text text-jj-gray-05">Sends as soon as you stop talking</div>
                    </div>
                    <button onClick={() => setAutoSendVoice((v) => !v)}
                      role="switch" aria-checked={autoSendVoice} aria-label="Auto-send after voice"
                      className={`w-9 h-5 rounded-full relative transition-colors active:opacity-80 shrink-0 ${autoSendVoice ? 'bg-jj-red' : 'bg-jj-gray-03 hover:bg-jj-gray-04'}`}>
                      <span className={`absolute top-[2px] w-4 h-4 rounded-full bg-white transition-all ${autoSendVoice ? 'right-[2px]' : 'left-[2px]'}`} />
                    </button>
                  </div>
                </div>
              )}
              {settingsTab === 'data' && (
                <div className="flex flex-col -mt-1">
                  <div className="text-[11px] font-johnson-text font-bold uppercase tracking-wide text-jj-gray-05 mb-1">This session</div>
                  <button onClick={resetAvatarPosition} className="text-left py-3 border-b border-jj-gray-02 text-sm font-johnson-text text-jj-gray-08 hover:text-jj-red active:opacity-70 transition-colors">
                    Reset avatar position
                  </button>
                  <button onClick={resetSettingsDefaults} className="text-left py-3 border-b border-jj-gray-02 text-sm font-johnson-text text-jj-gray-08 hover:text-jj-red active:opacity-70 transition-colors">
                    Reset to defaults
                  </button>
                  <div className="text-[11px] font-johnson-text font-bold uppercase tracking-wide text-jj-gray-05 mt-4 mb-1">Conversation</div>
                  <button onClick={clearConversation} className="text-left py-3 text-sm font-johnson-text text-jj-red hover:text-jj-maroon-05 active:opacity-70 transition-colors">
                    Clear conversation
                  </button>
                  <p className="text-[11px] font-johnson-text text-jj-gray-05 mt-auto pt-3">
                    Corrections you've submitted via "Teach me" aren't affected by clearing the conversation — they're saved separately.
                  </p>
                </div>
              )}
            </div>
          ) : (
          <>
          <div ref={scrollRef} onScroll={onScrollMessages} role="log" aria-live="polite" aria-relevant="additions text" aria-label="Conversation with Regwiz" className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 space-y-2 relative">
            {messages.length === 0 && (
              <div className="px-1">
                <p className="text-jj-gray-05 font-johnson-text text-sm">
                  Hey! What can I help you find today?
                  {speech.sttSupported && ' Tap the mic to talk.'}
                </p>
                {!speech.sttSupported && (
                  <p className="text-jj-gray-04 font-johnson-text text-[11px] mt-0.5">
                    Voice input isn't available in this browser — try Chrome or Edge, or just type.
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {(promptsForPath(location.pathname) || SUGGESTED_PROMPTS).map((p) => (
                    <button key={p} onClick={() => send(p)}
                      className="px-2.5 py-1 rounded-full bg-jj-gray-01 text-jj-gray-08 text-xs font-johnson-text hover:bg-jj-red hover:text-white transition-colors">
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => {
              if (!m.content) return null;
              if (m.role === 'error') return (
                <div key={i} className="flex items-start">
                  <div className="max-w-[80%] flex items-start gap-2 px-3.5 py-2.5 rounded-2xl rounded-bl-md bg-red-50 border border-jj-red/30">
                    <Icon src={alertIcon} alt="" className="w-4 h-4 mt-0.5 shrink-0" style={{ filter: 'invert(14%) sepia(80%) saturate(6000%) hue-rotate(-10deg)' }} />
                    <span className="font-johnson-text text-sm text-jj-maroon-05" style={{ lineHeight: '140%' }}>{renderInlineMarkdown(m.content, `err${i}`)}</span>
                  </div>
                </div>
              );
              return (
              <div key={i} className={`flex flex-col group ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`max-w-[80%] px-3.5 py-2.5 font-johnson-text whitespace-pre-wrap break-words shadow-sm ${
                  m.role === 'user'
                    ? 'bg-jj-red text-jj-white rounded-2xl rounded-br-md'
                    : 'bg-jj-gray-02 border border-jj-gray-03/60 text-jj-gray-08 rounded-2xl rounded-bl-md'
                }`} style={{ lineHeight: '145%', fontSize: TEXT_SIZE_PX[textSize], overflowWrap: 'anywhere' }}>
                  {renderInlineMarkdown(m.content, `m${i}`)}
                </div>
                {m.ts && (
                  <span className="mt-0.5 mx-1 text-[10px] text-jj-gray-05 font-johnson-text">
                    {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
                {m.role === 'assistant' && state === 'speaking' && i === messages.length - 1 && (
                  <div className="flex items-center gap-2 mt-1 ml-1">
                    <span className="flex items-end gap-[2px] h-4">
                      {[0, 0.15, 0.3, 0.45, 0.6].map((d) => (
                        <span key={d} className="w-[3px] h-4 bg-jj-red rounded-sm"
                          style={{ animation: 'regwiz-wf 0.9s ease-in-out infinite', animationDelay: `${d}s`, transformOrigin: 'bottom' }} />
                      ))}
                    </span>
                    <span className="text-[11px] text-jj-gray-05">speaking…</span>
                  </div>
                )}
                {m.role === 'assistant' && ((m.sources && m.sources.length > 0) || (m.content && !busy && teachIdx !== i)) && (
                  // sources toggle and "Teach me" share one line under the answer; the list opens below it
                  <div className="mt-1 ml-1 max-w-[80%] font-johnson-text">
                    <div className="flex items-center gap-3">
                      {m.sources && m.sources.length > 0 && (
                        <button type="button" onClick={() => toggleSources(i)} aria-expanded={openSources.has(i)}
                          aria-controls={`sources-${i}`}
                          className="inline-flex items-center gap-1 text-[11px] text-jj-gray-05 hover:text-jj-gray-07 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-jj-red/40">
                          <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"
                            className={`transition-transform ${openSources.has(i) ? 'rotate-90' : ''}`}>
                            <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          {m.sources.length} {m.sources.length === 1 ? 'source' : 'sources'}
                        </button>
                      )}
                      {m.content && !busy && teachIdx !== i && (
                        <button onClick={() => teach(i)} title="Not right? Teach me"
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center gap-1 text-[11px] text-jj-gray-04 hover:text-jj-red">
                          <Icon src={editIcon} alt="" className="w-3 h-3" style={{ filter: 'invert(60%)' }} />
                          Teach me
                        </button>
                      )}
                    </div>
                    {m.sources && m.sources.length > 0 && openSources.has(i) && (
                      <ul id={`sources-${i}`} className="mt-1 rounded-lg border border-jj-gray-03/60 bg-white/70 divide-y divide-jj-gray-02 overflow-hidden">
                        {m.sources.map((src, si) => (
                          <li key={si} className="px-2 py-1 text-[11px] leading-snug text-jj-gray-07">
                            <div className="truncate" title={src.title || src.source}>{src.title || src.source}</div>
                            {src.title && src.source && (
                              <div className="truncate text-[10px] text-jj-gray-05" title={src.source}>{src.source}</div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {m.role === 'assistant' && teachIdx === i && (
                  <div className="mt-1.5 w-full max-w-[90%] p-2 rounded-xl border border-jj-gray-03 bg-jj-gray-01">
                    <label htmlFor={`teach-${i}`} className="block text-[11px] font-johnson-text text-jj-gray-06 mb-1">
                      What should the answer have been?
                    </label>
                    <textarea id={`teach-${i}`} autoFocus value={teachText} onChange={(e) => setTeachText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Escape') cancelTeach(); }}
                      rows={2} placeholder="Type the correct answer…"
                      className="w-full resize-none rounded-lg border border-jj-gray-03 bg-white px-2 py-1.5 text-xs font-johnson-text text-jj-gray-08 focus:outline-none focus:border-jj-red" />
                    <div className="flex gap-2 mt-1.5">
                      <button onClick={submitTeach} disabled={!teachText.trim() || teachBusy}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-johnson-text ${teachText.trim() ? 'bg-jj-red text-white hover:bg-jj-maroon-05' : 'bg-jj-gray-02 text-jj-gray-05 cursor-not-allowed'}`}>
                        {teachBusy ? 'Saving…' : 'Save'}
                      </button>
                      <button onClick={cancelTeach} className="px-2.5 py-1 rounded-lg text-[11px] font-johnson-text bg-jj-gray-02 text-jj-gray-07 hover:bg-jj-gray-03">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
              );
            })}
            {state === 'thinking' && (
              <div className="flex items-start">
                <div className="bg-jj-gray-02 border border-jj-gray-03/60 shadow-sm rounded-2xl rounded-bl-md px-3 py-2.5 flex items-end gap-[3px]" aria-label="Thinking">
                  {[0, 0.12, 0.24].map((d) => (
                    <span key={d} className="w-[3px] h-4 bg-jj-gray-06 rounded-sm"
                      style={{ animation: 'regwiz-wf 1s ease-in-out infinite', animationDelay: `${d}s`, transformOrigin: 'bottom' }} />
                  ))}
                </div>
              </div>
            )}
            {toast && (
              <div className="text-[11px] text-jj-gray-06 bg-jj-gray-02 rounded px-2 py-1">{toast}</div>
            )}
          </div>
          {!atBottom && messages.length > 0 && (
            <div className="absolute left-0 right-0 bottom-[76px] h-12 flex items-end justify-center pb-2 pointer-events-none bg-gradient-to-t from-white via-white/80 to-transparent">
              <button onClick={scrollToLatest}
                className="pointer-events-auto px-3 py-1 rounded-full bg-jj-gray-08 text-white text-[11px] font-johnson-text shadow-md hover:bg-jj-gray-07">
                ↓ New message
              </button>
            </div>
          )}

          {pendingAction && (
            <div className="mx-2 mb-2 p-2 rounded-lg border border-jj-red bg-red-50">
              <p className="font-johnson-text text-xs text-jj-gray-08 mb-2">
                Let the assistant click <b>“{pendingAction.label}”</b>?
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    executeAction(pendingAction.action)
                      .then((ok) => postActionAck(pendingAction.ackId, ok, 'user allowed it', getAccessToken))
                      .catch((err) => { console.error('[assistant] confirmed action failed:', err); postActionAck(pendingAction.ackId, false, 'threw after user allowed it', getAccessToken); });
                    setPendingAction(null);
                  }}
                  className="px-3 py-1 rounded-xl bg-jj-red text-white text-xs font-johnson-text hover:bg-jj-maroon-05">
                  Allow
                </button>
                <button
                  onClick={() => { postActionAck(pendingAction.ackId, false, 'user declined', getAccessToken); setPendingAction(null); }}
                  className="px-3 py-1 rounded-xl bg-jj-gray-02 text-jj-gray-07 text-xs font-johnson-text hover:bg-jj-gray-03">
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className={`p-2 border-t border-white/30 flex items-end gap-2 ${speech.listening ? 'bg-jj-red/5' : ''}`}>
            {speech.sttSupported && (
              <button onClick={toggleMic} title="Talk to Regwiz"
                className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center transition-colors ${
                  speech.listening ? 'bg-jj-red text-white shadow-[0_0_0_4px_rgba(235,23,0,0.15)]' : 'bg-jj-gray-02 text-jj-gray-07 hover:bg-jj-gray-03'
                }`}>
                {speech.listening ? (
                  <span className="flex items-end gap-[1.5px] h-3">
                    {[0, 0.1, 0.2].map((d) => (
                      <span key={d} className="w-[2px] h-3 bg-white rounded-sm"
                        style={{ animation: 'regwiz-wf 0.7s ease-in-out infinite', animationDelay: `${d}s`, transformOrigin: 'bottom' }} />
                    ))}
                  </span>
                ) : (
                  <Icon src={micIcon} alt="Talk to the assistant" className="w-[17px] h-[17px]"
                    style={{ filter: BLACK_ICON_FILTER }} />
                )}
              </button>
            )}
            {speech.listening ? (
              <div className="flex-1 flex items-center gap-2 h-9 px-3 rounded-xl bg-white/70 border border-jj-red/20 min-w-0">
                <span className="flex items-end gap-[2px] h-3.5 shrink-0">
                  {[6, 12, 8].map((h, idx) => (
                    <span key={idx} className="w-[2px] bg-jj-red rounded-sm"
                      style={{ height: h, animation: 'regwiz-wf 0.6s ease-in-out infinite', animationDelay: `${idx * 0.1}s`, transformOrigin: 'bottom' }} />
                  ))}
                </span>
                <span className="flex-1 min-w-0 truncate text-sm font-johnson-text">
                  {input.trim()
                    ? <span className="text-jj-gray-08">{input}</span>
                    : <span className="text-jj-gray-05">Listening…</span>}
                </span>
              </div>
            ) : (
            <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKeyDown}
              rows={1} placeholder="Ask Regwiz…" aria-label="Ask Regwiz"
              className="flex-1 resize-none rounded-xl border border-white/50 bg-white/80 backdrop-blur-sm px-3 py-1.5 text-sm font-johnson-text text-jj-gray-08 placeholder:text-jj-gray-05 focus:outline-none focus:border-jj-red"
              style={{ maxHeight: 100 }} />
            )}
            {running ? (
              <button onClick={stopAll}
                className="px-3 py-1.5 rounded-xl bg-jj-gray-06 text-white text-sm font-johnson-text hover:bg-jj-gray-07 flex items-center gap-1">
                <span style={{ width: 9, height: 9, background: '#fff', borderRadius: 1, display: 'inline-block' }} /> Stop
              </button>
            ) : canRetry && !input.trim() ? (
              <button onClick={retryLast}
                className="px-3 py-1.5 rounded-xl bg-jj-gray-06 text-white text-sm font-johnson-text hover:bg-jj-gray-07">
                Retry
              </button>
            ) : (
              <button onClick={() => send()} disabled={!input.trim()}
                className={`px-3 py-1.5 rounded-xl text-sm font-johnson-text ${
                  input.trim() ? 'bg-jj-red text-white hover:bg-jj-maroon-05' : 'bg-jj-gray-02 text-jj-gray-05 cursor-not-allowed'
                }`}>
                Send
              </button>
            )}
          </div>
          </>
          )}
        </div>
      )}

      {tip && !open && (
        <div className="max-w-[15rem] bg-white rounded-xl shadow-lg border border-jj-gray-03 px-3 py-2"
             style={tipStyle}>
          <p className="font-johnson-text text-sm text-jj-gray-08" style={{ lineHeight: '130%' }}>{tip}</p>
        </div>
      )}

      <button ref={faceWrap}
        onPointerDown={onAvatarPointerDown}
        onPointerMove={onGroupPointerMove}
        onPointerUp={onGroupPointerUp}
        data-assistant-avatar
        aria-label="Open Regwiz — drag to move"
        className={`transition-transform ${drag ? 'cursor-grabbing scale-105' : 'cursor-grab hover:scale-105'}`}
        style={{ ...avatarStyle, width: AV_W, height: AV_H, pointerEvents: 'auto', background: 'transparent',
                 border: 'none', padding: 0, touchAction: 'none',
                 filter: 'drop-shadow(0 8px 14px rgba(0,0,0,0.3))' }}>
        <Suspense fallback={<div style={{ width: '100%', height: '100%' }} />}>
          <AssistantAvatar3D avatarId={avatarId} reduceMotion={reduceMotion} speakingRef={speakingRef} emotion={emotion} />
        </Suspense>
      </button>
    </div>
  );
}