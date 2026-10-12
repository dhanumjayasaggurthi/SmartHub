import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiFetch, apiJson, downloadFile } from '../utils/apiClient';
import { useAuth } from '../context/AuthContext';
import {
  CLS, Icon, Modal, PromptModal, ConfirmModal, BodyEditor, RecipientPicker,
  RecipientField, splitAddresses, ADDR_RE, PLACEHOLDERS,
} from './components/CommunicationParts';
import { AIDraftModal, AIToolbar } from './components/CommunicationAI';
import { WhatsNewPanel } from './components/WhatsNew';
import LoadingSpinner from './components/LoadingSpinner';
import { lazyPage } from '../utils/lazyPage';
import { usePerfTier } from '../utils/perfTier';

import mailIcon       from "/icons/JJ_Icon_Communication_RGB.svg";
import alertIcon      from "/icons/JJ_Icon_Alert_RGB.svg";
import checkIcon      from "/icons/JJ_Icon_Check_RGB.svg";
import closeIcon      from "/icons/JJ_Icon_Close.svg";
import saveIcon       from "/icons/JJ_Icon_Save_RGB.svg";
import trashIcon      from "/icons/JJ_Icon_Delete_RGB.svg";
import searchIcon     from "/icons/JJ_Icon_Search_RGB.svg";
import refreshIcon    from "/icons/JJ_Icon_Refresh_RGB.svg";
import addIcon        from "/icons/JJ_Icon_Add.svg";
import calendarIcon   from "/icons/JJ_Icon_Calendar_RGB.svg";
import communityIcon  from "/icons/JJ_Icon_Community_RGB.svg";
import shieldIcon     from "/icons/JJ_Icon_Shield_RGB.svg";
import lockIcon       from "/icons/JJ_Icon_Lock_black.svg";
import aiIcon         from "/icons/JJ_Icon_AI_RGB.svg";
import editIcon       from "/icons/JJ_Icon_Edit_RGB.svg";
import gearIcon       from "/icons/JJ_Icon_Gear_RGB.svg";
import timeIcon       from "/icons/JJ_Icon_Time_RGB.svg";
import personIcon     from "/icons/JJ_Icon_Person_RGB.svg";
import chevronIcon    from "/icons/JJ_Icon_Chevron_Right.svg";

// Its own chunk: a deep link into a tab never downloads the welcome canvases.
const CommunicationWelcome = lazyPage(() => import('./components/CommunicationWelcome'));


const PREVIEW_TOP = 78;
const PREVIEW_HEIGHT = `calc(100vh - ${PREVIEW_TOP + 40}px)`;

const EASTERN = 'America/New_York';


const BODY_PLACEHOLDER =
  'Hi everyone,\n\n' +
  'SmartHub will be unavailable on Day 01 Month, from Time to Time PM ET\n' +
  'due to scheduled maintenance.\n\n' +
  'No action is needed on your side - any reports scheduled in that window\n' +
  'will run automatically once we\'re back.';

const classifyAddresses = (raw) => {
  const all = splitAddresses(raw);
  const valid = [];
  const invalid = [];
  const seen = new Set();
  all.forEach((addr) => {
    if (!ADDR_RE.test(addr)) {
      invalid.push(addr);
    } else if (!seen.has(addr.toLowerCase())) {
      seen.add(addr.toLowerCase());
      valid.push(addr);
    }
  });
  return { valid, invalid };
};

const hasText = (value) => Boolean(String(value ?? '').trim());

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Every timestamp this page shows is a server timestamp, and the server runs
 *  on Eastern — so render it in Eastern and say so, rather than quietly
 *  converting it to whatever the laptop is set to. */
const formatTimestamp = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString('en-US', {
    timeZone: EASTERN,
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })} ET`;
};

/** "YYYY-MM-DDTHH:MM" for a datetime-local input, in Eastern rather than in
 *  the browser's zone — the field is an ET wall clock, because that is how the
 *  backend reads it back. */
const easternInputValue = (date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EASTERN,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ─── Toast ───────────────────────────────────────────────────────────────── */

const Toast = ({ message, type = 'success', onClose }) => {
  // onClose is a new closure on every parent render, so depending on it meant
  // the six-second timer restarted on each keystroke and the toast sat there.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const timer = setTimeout(() => close.current(), 6000);
    return () => clearTimeout(timer);
  }, []);

  const tone = type === 'error'
    ? 'bg-white border-jj-red/30'
    : 'bg-white border-jj-green-01/60';

  return (
    <div className="fixed bottom-5 right-5 z-[70] animate-slide-in" role={type === 'error' ? 'alert' : 'status'}>
      <div className={`${tone} border rounded-xl shadow-[0_12px_32px_rgba(49,44,42,0.16)] px-4 py-3.5
                       flex items-start gap-3 min-w-[300px] max-w-md`}>
        <Icon
          src={type === 'error' ? alertIcon : checkIcon}
          className="w-4 h-4 flex-shrink-0 mt-0.5"
          tone={type === 'error' ? 'red' : 'green'}
        />
        <span className="font-johnson-text text-[13px] text-jj-gray-08 flex-1">{message}</span>
        <button onClick={onClose} aria-label="Dismiss" className="opacity-50 hover:opacity-100">
          <Icon src={closeIcon} className="w-3.5 h-3.5" tone="gray" />
        </button>
      </div>
    </div>
  );
};

/* ─── Sensitivity label ───────────────────────────────────────────────────── */
/* The labels come down as a tree so sub-labels can sit in their own flyout,
   the way Outlook nests them behind the shield. Everything else wants them
   flat, so both shapes are kept. */

const flattenLabels = (tree, out = []) => {
  (tree || []).forEach((node) => {
    out.push(node);
    flattenLabels(node.children, out);
  });
  return out;
};

const findLabel = (tree, id) =>
  id ? flattenLabels(tree).find((l) => l.id === id) || null : null;

const SensitivityPicker = ({ tree, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const [openChild, setOpenChild] = useState('');
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  useEffect(() => { if (!open) setOpenChild(''); }, [open]);

  const current = findLabel(tree, value);

  const pick = (id) => {
    onChange(id);
    setOpen(false);
  };

  // depth only sets the indent; isTop says whether this row sits in the main
  // menu. A row inside a flyout must not touch openChild - that was closing
  // the flyout the moment the pointer landed on one of its options.
  const row = (node, depth, isTop) => {
    const kids = node.children || [];
    // A parent is a way into its sub-labels, not a choice of its own - same
    // as Outlook, where Restricted only ever resolves to one of the two
    // underneath it. Ticked when the pick is somewhere below it.
    const chosen = kids.length
      ? flattenLabels(kids).some((k) => k.id === value)
      : value === node.id;

    return (
      <div
        key={node.id}
        className="relative"
        onMouseEnter={isTop && kids.length ? () => setOpenChild(node.id) : undefined}
      >
        <button
          onClick={() => (kids.length
            ? setOpenChild(openChild === node.id ? '' : node.id)
            : pick(node.id))}
          className={`flex items-center gap-2 w-full text-left py-2 pr-3 font-johnson-text
                      text-[13px] hover:bg-jj-gray-01 ${
            chosen ? 'text-jj-gray-08 font-medium' : 'text-jj-gray-07'
          }`}
          style={{ paddingLeft: 12 + depth * 10 }}
        >
          <span className="w-3 flex-none text-[11px] text-jj-gray-08">{chosen ? '✓' : ''}</span>
          <Icon
            src={node.protection ? lockIcon : shieldIcon}
            className="w-3.5 h-3.5 flex-none opacity-80"
          />
          <span className="flex-1">{node.label}</span>
          {kids.length > 0 && <span className="text-[11px] text-jj-gray-05">›</span>}
        </button>

        {/* Sub-labels fly out to the side where there is room for them, and
            fold in underneath where there is not. */}
        {kids.length > 0 && openChild === node.id && (
          <div className="hidden md:block absolute right-full top-0 w-56 py-1.5 bg-white
                          border border-jj-gray-02 rounded-[10px] shadow-lg">
            {kids.map((kid) => row(kid, 0, false))}
          </div>
        )}
        {kids.length > 0 && openChild === node.id && (
          <div className="md:hidden">{kids.map((kid) => row(kid, depth + 1, false))}</div>
        )}
      </div>
    );
  };

  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={current ? `Sensitivity: ${current.path}` : 'No sensitivity label'}
        className={`flex items-center gap-1.5 ${CLS.ghostBtn} ${open ? 'bg-jj-gray-01' : ''}`}
      >
        <Icon
          src={current?.protection ? lockIcon : shieldIcon}
          className="w-3.5 h-3.5"
          tone={current ? 'dark' : 'gray'}
        />
        <span className="max-w-[170px] truncate">{current ? current.path : 'No label'}</span>
        <span className="text-[10px] text-jj-gray-05">▾</span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-1.5 w-60 py-1.5 bg-white border
                        border-jj-gray-02 rounded-[10px] shadow-lg z-30">
          {tree.map((node) => row(node, 0, true))}
          {value && (
            <div className="border-t border-jj-gray-02 mt-1.5 pt-1.5">
              <button
                onClick={() => pick('')}
                className="w-full text-left px-3 py-2 font-johnson-text text-[13px]
                           text-jj-gray-06 hover:bg-jj-gray-01"
              >
                No label
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/* ─── Confirm send ────────────────────────────────────────────────────────── */

const ConfirmSend = ({ summary, sending, onCancel, onConfirm }) => (
  <Modal
    title={summary.sendAt ? 'Schedule this message?' : 'Send this message?'}
    onClose={onCancel}
    busy={sending}
    footer={
      <>
        <button onClick={onCancel} disabled={sending} className={CLS.ghostBtn}>Cancel</button>
        <button onClick={onConfirm} disabled={sending} className={CLS.primaryBtn}>
          {sending
            ? (summary.sendAt ? 'Scheduling…' : 'Sending…')
            : (summary.sendAt ? 'Schedule it' : `Send to ${summary.total}`)}
        </button>
      </>
    }
  >
    <div className="bg-jj-gray-01 rounded-xl p-3.5 flex flex-col gap-2 mb-3.5">
      <div className="flex gap-2.5 font-johnson-text text-[13px]">
        <span className="w-[72px] flex-none text-jj-gray-06">Subject</span>
        <span className="flex-1 text-jj-gray-08">{summary.subject || '(none)'}</span>
      </div>
      <div className="flex gap-2.5 font-johnson-text text-[13px]">
        <span className="w-[72px] flex-none text-jj-gray-06">Going to</span>
        <span className="flex-1 text-jj-gray-08">
          {summary.to} to · {summary.cc} cc · {summary.bcc} bcc
        </span>
      </div>
      {summary.sendAt && (
        <div className="flex gap-2.5 font-johnson-text text-[13px]">
          <span className="w-[72px] flex-none text-jj-gray-06">Goes out</span>
          <span className="flex-1 text-jj-gray-08">{summary.sendAtLabel}</span>
        </div>
      )}
      {summary.attachments > 0 && (
        <div className="flex gap-2.5 font-johnson-text text-[13px]">
          <span className="w-[72px] flex-none text-jj-gray-06">Files</span>
          <span className="flex-1 text-jj-gray-08">{summary.attachments}</span>
        </div>
      )}
      {summary.sensitivityLabel && (
        <div className="flex gap-2.5 font-johnson-text text-[13px]">
          <span className="w-[72px] flex-none text-jj-gray-06">Sensitivity</span>
          <span className="flex-1 text-jj-gray-08">{summary.sensitivityLabel}</span>
        </div>
      )}
    </div>
    <p className="font-johnson-text text-[11.5px] text-jj-gray-05">
      {summary.sendAt
        ? 'It can be cancelled from the Queue tab up until it goes out.'
        : 'This cannot be recalled once sent.'}
    </p>
  </Modal>
);

/* ─── Studio styles ───────────────────────────────────────────────────────────
 * Only what Tailwind cannot say: keyframes, the sliding tab pill, the device
 * frame. Injected once and cc- prefixed so nothing collides with a utility. */

const STUDIO_CSS = `
@keyframes cc-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes cc-pop{0%{transform:scale(.6);opacity:0}70%{transform:scale(1.06)}100%{transform:scale(1);opacity:1}}
@keyframes cc-shimmer{0%{transform:translateX(-130%) skewX(-18deg)}60%,100%{transform:translateX(260%) skewX(-18deg)}}
@keyframes cc-glow{0%{opacity:.55;transform:scale(1)}70%,100%{opacity:0;transform:scale(1.14,1.4)}}
@keyframes cc-bump{0%,100%{transform:scale(1)}40%{transform:scale(1.35)}}
@keyframes cc-sheen{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@keyframes cc-ring{0%{opacity:.6;transform:scale(.82)}100%{opacity:0;transform:scale(1.7)}}
@keyframes cc-bar{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.cc-rise{animation:cc-rise .55s cubic-bezier(.16,1,.3,1) both}
.cc-pop{animation:cc-pop .35s cubic-bezier(.16,1,.3,1) both}
.cc-bump{animation:cc-bump .5s cubic-bezier(.16,1,.3,1)}
.cc-ico{display:inline-block;flex:none;background:currentColor;-webkit-mask:var(--i) center/contain no-repeat;mask:var(--i) center/contain no-repeat}
.cc-tab-pill{position:absolute;top:4px;bottom:4px;left:0;width:0;border-radius:9px;background:#fff;box-shadow:0 2px 8px rgba(49,44,42,.12);transition:transform .5s cubic-bezier(.22,1,.36,1),width .5s cubic-bezier(.22,1,.36,1);will-change:transform}
.cc-card{transition:border-color .3s,box-shadow .3s}
.cc-card:focus-within{border-color:rgba(235,23,0,.28);box-shadow:0 22px 48px -30px rgba(235,23,0,.35)}
.cc-send{position:relative;box-shadow:0 14px 30px -14px rgba(235,23,0,.55)}
.cc-send:disabled{box-shadow:none}
/* Glow ring and shine move with transform/opacity only, so the CPU paints them
   once and the compositor just moves them - no per-frame shadow repaints. */
.cc-send.go::before{content:"";position:absolute;inset:-1px;border-radius:inherit;border:2px solid rgba(235,23,0,.6);pointer-events:none;animation:cc-glow 2.2s cubic-bezier(.22,1,.36,1) infinite;will-change:transform,opacity}
.cc-shine{position:absolute;inset:0;border-radius:inherit;overflow:hidden;pointer-events:none}
.cc-send.go .cc-shine::after,.cc-ai::after{content:"";position:absolute;top:0;bottom:0;left:0;width:40%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);animation:cc-shimmer 3.4s ease-in-out infinite;will-change:transform}
.cc-ai{position:relative;overflow:hidden;background:linear-gradient(120deg,#8c3bbb,#0f68b2)}
.cc-ai::after{animation-duration:5s}
.cc-ring-val{transition:stroke-dashoffset .6s cubic-bezier(.16,1,.3,1),stroke .4s}
.cc-checks{opacity:0;transform:translateY(8px);pointer-events:none;transition:all .3s cubic-bezier(.16,1,.3,1)}
.cc-ready:hover .cc-checks,.cc-ready:focus-within .cc-checks{opacity:1;transform:none;pointer-events:auto}
.cc-stage{background-color:#ebe7e2;background-image:radial-gradient(rgba(110,98,89,.14) 1px,transparent 1px);background-size:18px 18px}
/* Switching device size swaps the frame with a soft fade-and-settle instead
   of animating its width, which would re-layout the email on every frame. */
.cc-device{animation:cc-settle .5s cubic-bezier(.22,1,.36,1) both}
@keyframes cc-settle{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
.cc-device.mobile{border-radius:38px;padding:12px;background-color:#1d1a19}
.cc-device.mobile .cc-screen{border-radius:28px}
.cc-busy-bar{position:absolute;left:0;right:0;top:0;height:2px;overflow:hidden}
.cc-busy-bar::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,#eb1700,#8c3bbb,transparent);animation:cc-bar .9s ease-in-out infinite}
.cc-empty-orb{position:relative;width:84px;height:84px;display:grid;place-items:center}
.cc-empty-orb::before,.cc-empty-orb::after{content:"";position:absolute;inset:0;border-radius:50%;border:1px solid rgba(235,23,0,.3);animation:cc-ring 2.6s ease-out infinite}
.cc-empty-orb::after{animation-delay:1.3s;border-color:rgba(140,59,187,.3)}
.cc-skel{position:relative;overflow:hidden;background:#f1ede8}
.cc-skel::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.6),transparent);animation:cc-sheen 1.4s linear infinite;will-change:transform}
/* Backdrop blur is recomputed on every scroll frame; without a GPU that is
   the single most expensive thing on the page. The panels stay translucent. */
.cc-lite .backdrop-blur-md{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
.cc-lite .bg-white\\/90{background-color:rgba(255,255,255,.97)!important}
.cc-tl{position:relative}
.cc-tl::before{content:"";position:absolute;left:9px;top:10px;bottom:10px;width:2px;border-radius:1px;background:linear-gradient(180deg,#0f68b2,rgba(140,59,187,.3),transparent)}
`;

const useStudioStyles = () => {
  useEffect(() => {
    if (document.getElementById('cc-studio-styles')) return;
    const tag = document.createElement('style');
    tag.id = 'cc-studio-styles';
    tag.textContent = STUDIO_CSS;
    document.head.appendChild(tag);
  }, []);
};

/** An icon painted with currentColor, so it can take any category colour.
 *  The SVGs are flat black art, which a mask keeps crisp at every size. */
const Glyph = ({ src, size = 14, className = '', style }) => (
  <i
    aria-hidden="true"
    className={`cc-ico ${className}`}
    style={{ '--i': `url("${src}")`, width: size, height: size, ...style }}
  />
);

const CATEGORY_ICON = { update: aiIcon, warning: alertIcon, maintenance: gearIcon, custom: editIcon };

/** Wall-clock "now", ticking only while something on screen needs it. */
const useNow = (active, every = 1000) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [active, every]);
  return now;
};

const Countdown = ({ at }) => {
  // Each countdown ticks itself, so only these few digits re-render each second.
  const now = useNow(true);
  const ms = Math.max(0, new Date(at).getTime() - now);
  if (Number.isNaN(ms)) return null;
  const parts = [
    [Math.floor(ms / 86400000), 'days'],
    [Math.floor((ms % 86400000) / 3600000), 'hrs'],
    [Math.floor((ms % 3600000) / 60000), 'min'],
    [Math.floor((ms % 60000) / 1000), 'sec'],
  ];
  return (
    <div className="flex gap-1.5" aria-label={`Goes out in ${parts.map(([v, l]) => `${v} ${l}`).join(' ')}`}>
      {parts.map(([v, l]) => (
        <div key={l} className="min-w-[44px] px-1.5 pt-1.5 pb-1 rounded-[9px] bg-[#faf9f7] text-center">
          <b className="block font-johnson-display font-medium text-[16px] tabular-nums leading-none">
            {String(v).padStart(2, '0')}
          </b>
          <small className="font-johnson-text text-[8.5px] tracking-[0.16em] uppercase text-jj-gray-05">{l}</small>
        </div>
      ))}
    </div>
  );
};

/** Eastern wall-clock values for the schedule shortcuts. Worked out from the
 *  Eastern calendar date, not the laptop's, so "tomorrow 9 AM" is tomorrow in
 *  New York even for someone signed in from Bangalore. */
const quickTimes = () => {
  const today = easternInputValue(new Date()).slice(0, 10);
  const shift = (days) => {
    const [y, m, d] = today.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    return dt.toISOString().slice(0, 10);
  };
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: EASTERN, weekday: 'short' }).format(new Date());
  const toMonday = { Mon: 7, Tue: 6, Wed: 5, Thu: 4, Fri: 3, Sat: 2, Sun: 1 }[weekday] || 7;
  return [
    { id: 'hour', label: 'In 1 hour', value: easternInputValue(new Date(Date.now() + 3600 * 1000)) },
    { id: 'tomorrow', label: 'Tomorrow morning', value: `${shift(1)}T09:00` },
    { id: 'monday', label: 'Monday morning', value: `${shift(toMonday)}T09:00` },
  ];
};

const wallClockLabel = (value) => {
  if (!value) return '';
  const [date, time] = value.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mm));
  return `${dt.toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`;
};

const SchedulePicker = ({ value, min, max, onChange }) => {
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const pick = (next) => { onChange(next); setOpen(false); };
  const options = open ? quickTimes() : [];

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={value ? 'Change or clear the send time' : 'Send now, or pick a time'}
        className={`flex items-center gap-1.5 px-3 py-2 rounded-[11px] border font-johnson-text text-[12px]
                    whitespace-nowrap transition-colors ${value
          ? 'border-jj-blue-03/35 bg-jj-blue-03/[0.05] text-jj-blue-03'
          : 'border-jj-gray-02 bg-white text-jj-gray-07 hover:border-jj-gray-04 hover:text-jj-gray-08'}`}
      >
        <Glyph src={calendarIcon} size={13} />
        {value ? wallClockLabel(value) : 'Send now'}
      </button>

      {open && (
        <div role="menu" className="cc-pop absolute bottom-full right-0 mb-2.5 w-[260px] p-2 bg-white rounded-2xl
                                    border border-jj-gray-02 shadow-[0_24px_50px_-20px_rgba(49,44,42,0.4)] z-40">
          <div className="px-2.5 pt-1.5 pb-1 font-johnson-text text-[9.5px] tracking-[0.2em] uppercase text-jj-gray-05">Send</div>
          <button role="menuitem" type="button" onClick={() => pick('')}
                  className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[9px] font-johnson-text text-[12.5px]
                             text-jj-gray-07 hover:bg-jj-gray-01 hover:text-jj-gray-08">
            <Glyph src={mailIcon} size={13} />Right away
            {!value && <span className="ml-auto text-jj-green-03">✓</span>}
          </button>
          <div className="border-t border-jj-gray-02 my-1.5 mx-0.5" />
          <div className="px-2.5 pt-1 pb-1 font-johnson-text text-[9.5px] tracking-[0.2em] uppercase text-jj-gray-05">
            Schedule · Eastern time
          </div>
          {options.map((o) => (
            <button key={o.id} role="menuitem" type="button" onClick={() => pick(o.value)}
                    disabled={o.value < min || o.value > max}
                    className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[9px] font-johnson-text text-[12.5px]
                               text-jj-gray-07 hover:bg-jj-gray-01 hover:text-jj-gray-08 disabled:opacity-40">
              <Glyph src={timeIcon} size={13} />{o.label}
              <small className="ml-auto text-[11px] text-jj-gray-05">{wallClockLabel(o.value).replace(/^\w+ \d+, /, '')}</small>
            </button>
          ))}
          <div className="border-t border-jj-gray-02 my-1.5 mx-0.5" />
          <label className="block px-2.5 pb-1.5">
            <span className="block mb-1 font-johnson-text text-[11px] text-jj-gray-06">Pick a date and time (ET)</span>
            <input
              type="datetime-local"
              value={value}
              min={min}
              max={max}
              onChange={(e) => onChange(e.target.value)}
              className={CLS.inputSm}
            />
          </label>
        </div>
      )}
    </div>
  );
};

/** An envelope that flies from the Send button to the tab the message went
 *  to. Purely a cue — nothing waits on it, and reduced motion skips it. */
const flyEnvelope = (from, to) => {
  if (!from || !to) return;
  const a = from.getBoundingClientRect(); const b = to.getBoundingClientRect();
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;left:0;top:0;z-index:95;width:40px;height:28px;border-radius:6px;background:#fff;'
    + 'border:2px solid #eb1700;box-shadow:0 12px 30px -8px rgba(235,23,0,.5);pointer-events:none';
  el.innerHTML = '<svg viewBox="0 0 40 28" width="36" height="24" style="display:block;margin:0 auto">'
    + '<path d="M3 4 L18 15 L33 4" fill="none" stroke="#eb1700" stroke-width="2.2" stroke-linejoin="round"/></svg>';
  document.body.appendChild(el);
  const x0 = a.left + a.width / 2 - 20; const y0 = a.top - 14;
  const x1 = b.left + b.width / 2 - 20; const y1 = b.top + b.height / 2 - 14;
  el.animate([
    { transform: `translate(${x0}px,${y0}px) scale(.6)`, opacity: 0 },
    { transform: `translate(${x0}px,${y0 - 60}px) scale(1.1) rotate(-8deg)`, opacity: 1, offset: 0.2 },
    { transform: `translate(${(x0 + x1) / 2 - 120}px,${Math.min(y0, y1) - 40}px) rotate(-20deg)`, offset: 0.6 },
    { transform: `translate(${x1}px,${y1}px) scale(.3) rotate(10deg)`, opacity: 0.2 },
  ], { duration: 1050, easing: 'cubic-bezier(.5,0,.3,1)' }).onfinish = () => el.remove();
};

/** rgba() from a #rrggbb category colour, for tints the palette lacks. */
const tint = (hex, alpha) => {
  const n = parseInt(String(hex || '#a39992').replace('#', '').slice(0, 6), 16) || 0;
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
};

const FILE_TINT = { PDF: '#eb1700', XLSX: '#328714', XLS: '#328714', CSV: '#328714', DOCX: '#0f68b2', DOC: '#0f68b2', PPTX: '#ff6017', PPT: '#ff6017' };

const StepBadge = ({ n, done }) => (
  <span
    className={`w-[26px] h-[26px] rounded-full flex items-center justify-center flex-none font-johnson-display
                font-medium text-[11.5px] transition-colors duration-300 ${done
      ? 'bg-jj-green-03 text-white' : 'bg-jj-gray-01 text-jj-gray-07'}`}
    aria-label={done ? `Step ${n}, done` : `Step ${n}`}
  >
    {done ? <span className="cc-pop">✓</span> : n}
  </span>
);

/* ─── Page ────────────────────────────────────────────────────────────────── */

// In the URL, like every other tabbed page in the portal - so the Queue can
// be linked to, Back steps between tabs, and a refresh does not drop you
// into Compose from wherever you were. No ?tab= at all is the welcome screen.
const TABS = ['compose', 'whats-new', 'queue', 'history'];
const HOME = 'home';
const tabFromUrl = (params) => {
  const wanted = params.get('tab');
  return TABS.includes(wanted) ? wanted : HOME;
};

const QUEUE_FILTERS = [
  ['all', 'All'], ['pending', 'Queued'], ['sent', 'Sent'],
  ['failed', 'Failed'], ['cancelled', 'Cancelled'],
];

const CommunicationCenter = () => {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // The URL is the only record of which tab is open, so Back/Forward, a
  // refresh and a pasted link can never disagree with what is on screen.
  const tab = tabFromUrl(searchParams);
  const [config, setConfig] = useState(null);
  const [configState, setConfigState] = useState({ loading: true, error: '' });
  // Figures for the welcome screen. undefined = still loading, null = could
  // not be fetched, so the screen can tell a zero from a failure.
  const [overview, setOverview] = useState({ sent: undefined, whatsNew: undefined });
  const [queueError, setQueueError] = useState(false);
  const [toast, setToast] = useState(null);
  const [device, setDevice] = useState('desktop');

  const [category, setCategory] = useState('update');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [attachments, setAttachments] = useState([]);
  // What is typed into a recipient box but not yet a chip. Blocks the send
  // rather than being dropped on the floor.
  const [drafts, setDrafts] = useState({ to: '', cc: '', bcc: '' });

  // J&J house-template fields. All optional.
  const [bannerTitle, setBannerTitle] = useState('');
  const [bannerSubtitle, setBannerSubtitle] = useState('');
  const [headline, setHeadline] = useState('');
  const [resources, setResources] = useState([]);

  // Schedule send. Empty means "now"; the value is an Eastern wall clock.
  const [sendAt, setSendAt] = useState('');

  // Purview label id. Empty = send unlabelled; the config picks the default.
  const [sensitivity, setSensitivity] = useState('');

  const [preview, setPreview] = useState({ subject: '', html: '' });
  const [previewError, setPreviewError] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [templatesState, setTemplatesState] = useState({ loading: true, error: '' });
  const [templateId, setTemplateId] = useState('');
  const [templateSearch, setTemplateSearch] = useState('');
  // The search box only earns its place once the list is long enough to scroll.
  const templateList = useRef(null);
  const [templatesOverflow, setTemplatesOverflow] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [drafting, setDrafting] = useState(false);

  // Which AI mode the draft dialogue is open on, or null for closed.
  const [aiMode, setAiMode] = useState(null);
  // What's-new items this message is announcing. They ride along with the send
  // and are only ticked off once the mail has actually left.
  const [noteIds, setNoteIds] = useState([]);

  // One slot each for the two kinds of dialogue the page raises, so a stray
  // second click cannot stack two of them.
  const [ask, setAsk] = useState(null);      // { title, label, defaultValue, confirmLabel, onConfirm }
  const [check, setCheck] = useState(null);  // { title, subtitle, confirmLabel, tone, onConfirm }
  const [working, setWorking] = useState(false);

  // history
  const [entries, setEntries] = useState([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historySearch, setHistorySearch] = useState('');
  const [historyStatus, setHistoryStatus] = useState('all');
  const [historyCategory, setHistoryCategory] = useState('');
  const [historyByType, setHistoryByType] = useState({});
  const [historyCounts, setHistoryCounts] = useState({ all: 0, sent: 0, failed: 0, test: 0 });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const LIMIT = 25;

  // queue
  const [queue, setQueue] = useState([]);
  const [queueStatus, setQueueStatus] = useState('pending');
  const [queueCounts, setQueueCounts] = useState({});
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueDetail, setQueueDetail] = useState(null);

  const fileInput = useRef(null);
  const sendButton = useRef(null);
  const tabButtons = useRef({});
  const tabStrip = useRef(null);
  const [pill, setPill] = useState({ left: 0, width: 0 });
  const [dragging, setDragging] = useState(false);
  const [brandingOpen, setBrandingOpen] = useState(false);
  // Cc and Bcc stay folded away until asked for, or until either has something in it.
  const [copiesOpen, setCopiesOpen] = useState(false);
  const [bump, setBump] = useState(0);

  useStudioStyles();
  const perfTier = usePerfTier();

  const noteDraft = useCallback((field, text) => setDrafts((current) => (
    current[field] === text ? current : { ...current, [field]: text })), []);

  const changeTab = useCallback((next) => {
    if (next === tab) return;
    setDetail(null);
    setQueueDetail(null);
    // Leaving or returning to the welcome screen is a real step, so Back
    // undoes it. Moving between tabs replaces, like every other tabbed page.
    setSearchParams(next === HOME ? {} : { tab: next },
      { replace: tab !== HOME && next !== HOME });
  }, [tab, setSearchParams]);

  // Back/Forward changes the tab without going through changeTab; drop
  // whatever message was open in the old one.
  const lastTab = useRef(tab);
  useEffect(() => {
    if (lastTab.current === tab) return;
    lastTab.current = tab;
    setDetail(null);
    setQueueDetail(null);
  }, [tab]);

  // The id keys the component, so a second toast starts a fresh timer rather
  // than inheriting whatever was left of the first one's.
  const showToast = useCallback(
    (message, type = 'success') => setToast({ id: Date.now(), message, type }), []);
  const showError = useCallback(
    (message) => setToast({ id: Date.now(), message, type: 'error' }), []);

  const layout = useMemo(() => ({
    banner_title: bannerTitle,
    banner_subtitle: bannerSubtitle,
    headline,
    // Tolerant of a template saved before one of these fields existed: a
    // missing key used to throw on .trim() and take the page down with it.
    resources: resources.filter(
      (r) => hasText(r.title) || hasText(r.description) || hasText(r.link_url)),
  }), [bannerTitle, bannerSubtitle, headline, resources]);

  /* ── initial load ───────────────────────────────────────────────────────── */
  const loadTemplates = useCallback(async () => {
    setTemplatesState({ loading: true, error: '' });
    try {
      const data = await apiJson('/api/communications/templates');
      setTemplates(data.templates || []);
      setTemplatesState({ loading: false, error: '' });
    } catch (err) {
      // Still not a blocker - you can write and send without a template.
      // But the rail used to say "No saved templates yet" whether they were
      // loading, missing, or unreachable, and those are three different
      // things to be told while you are looking for one.
      setTemplatesState({ loading: false, error: err.message || 'Could not load templates' });
    }
  }, []);

  const configLoaded = useRef(false);
  const loadConfig = useCallback(async () => {
    setConfigState({ loading: true, error: '' });
    try {
      const cfg = await apiJson('/api/communications/config');
      setConfig(cfg);
      // Only the first time - a retry must not reset a label already picked.
      if (!configLoaded.current) setSensitivity(cfg.default_sensitivity || '');
      configLoaded.current = true;
      setConfigState({ loading: false, error: '' });
    } catch (err) {
      setConfigState({ loading: false, error: err.message || 'Could not load settings' });
    }
  }, []);

  useEffect(() => {
    loadConfig();
    loadTemplates();
  }, [loadConfig, loadTemplates]);

  // A failed /config used to surface only as a toast that went away. Outside
  // the welcome screen (which has its own Retry) it stays up until fixed.
  useEffect(() => {
    if (configState.error && tab !== HOME) showError(`${configState.error}. Limits and labels may be missing.`);
  }, [configState.error, tab, showError]);

  /* ── welcome-screen figures, refreshed on every visit to it ─────────────── */
  useEffect(() => {
    if (tab !== HOME) return undefined;
    let cancelled = false;
    const take = (key) => (value) => { if (!cancelled) setOverview((o) => ({ ...o, [key]: value })); };
    apiJson('/api/communications/history?limit=1')
      .then((d) => d?.counts?.sent ?? 0).catch(() => null).then(take('sent'));
    apiJson('/api/release-notes?status=open&limit=1')
      .then((d) => (d?.counts?.draft || 0) + (d?.counts?.ready || 0)).catch(() => null).then(take('whatsNew'));
    return () => { cancelled = true; };
  }, [tab]);

  /* ── history ────────────────────────────────────────────────────────────── */
  const historyParams = useCallback((extra = {}) => new URLSearchParams({
    search: historySearch || '',
    status: historyStatus && historyStatus !== 'all' ? historyStatus : '',
    category: historyCategory || '',
    ...extra,
  }), [historySearch, historyStatus, historyCategory]);

  // Typing in the search box fires several of these; only the newest may land.
  const historyTicket = useRef(0);
  const loadHistory = useCallback(async (nextOffset, term, status, cat) => {
    const mine = historyTicket.current + 1;
    historyTicket.current = mine;
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(LIMIT),
        offset: String(nextOffset),
        search: term || '',
        status: status && status !== 'all' ? status : '',
        category: cat || '',
      });
      const data = await apiJson(`/api/communications/history?${params}`);
      if (mine !== historyTicket.current) return;
      setEntries(data.entries || []);
      setHistoryByType(data.by_category || {});
      setHistoryTotal(data.total || 0);
      setHistoryCounts(data.counts || { all: 0, sent: 0, failed: 0, test: 0 });
      setHistoryOffset(nextOffset);
    } catch (err) {
      if (mine === historyTicket.current) showError(err.message || 'Could not load history');
    } finally {
      if (mine === historyTicket.current) setHistoryLoading(false);
    }
  }, [showError]);

  // Search and status both send you back to page one. The server does the
  // filtering now, so the rail counts, the pager and the rows on screen all
  // describe the same set instead of the rail describing only this page.
  useEffect(() => {
    if (tab !== 'history') return undefined;
    const timer = setTimeout(() => loadHistory(0, historySearch, historyStatus, historyCategory), 350);
    return () => clearTimeout(timer);
  }, [tab, historySearch, historyStatus, historyCategory, loadHistory]);

  const openDetail = async (id) => {
    setDetailLoading(true);
    try {
      setDetail(await apiJson(`/api/communications/history/${id}`));
    } catch (err) {
      // Clear the pane rather than leave the previous message sitting under
      // the row you just clicked, looking like the answer.
      setDetail(null);
      showError(err.message || 'Could not open that message');
    } finally {
      setDetailLoading(false);
    }
  };

  const exportHistory = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await downloadFile(
        `/api/communications/history/export?${historyParams()}`,
        `communications_${new Date().toISOString().split('T')[0]}.csv`,
      );
    } catch (err) {
      showError(err.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const downloadAttachment = async (entryId, index, filename) => {
    try {
      await downloadFile(
        `/api/communications/history/${entryId}/files/${index}`, filename);
    } catch (err) {
      showError(err.message || 'That file could not be downloaded');
    }
  };

  /* ── queue ──────────────────────────────────────────────────────────────── */
  const loadQueue = useCallback(async (status) => {
    setQueueLoading(true);
    try {
      const params = new URLSearchParams({ status: status === 'all' ? 'all' : status });
      const data = await apiJson(`/api/communications/scheduled?${params}`);
      setQueue(data.entries || []);
      setQueueCounts(data.counts || {});
      setQueueError(false);
    } catch (err) {
      setQueueError(true);
      showError(err.message || 'Could not load the queue');
    } finally {
      setQueueLoading(false);
    }
  }, [showError]);

  // Loaded when the tab opens, and once on mount besides, so the count on the
  // Queue tab is right before anyone has been there - a message waiting to go
  // out is worth noticing from the Compose tab.
  const queuePreloaded = useRef(false);
  useEffect(() => {
    if (tab === 'queue') {
      queuePreloaded.current = true;      // a deep link counts as the preload
      loadQueue(queueStatus);
    } else if (tab === HOME || !queuePreloaded.current) {
      // The welcome screen shows the queued count, so it is fresh on every visit.
      queuePreloaded.current = true;
      loadQueue('pending');
    }
  }, [tab, queueStatus, loadQueue]);

  const openQueueDetail = async (id) => {
    setDetailLoading(true);
    try {
      setQueueDetail(await apiJson(`/api/communications/scheduled/${id}`));
    } catch (err) {
      setQueueDetail(null);
      showError(err.message || 'Could not open that message');
    } finally {
      setDetailLoading(false);
    }
  };

  const cancelScheduled = (entry) => setCheck({
    title: 'Cancel this scheduled send?',
    subtitle: `"${entry.subject}" is queued for ${formatTimestamp(entry.send_at)}. `
      + 'It will not go out, and its attachments are deleted.',
    confirmLabel: 'Cancel the send',
    tone: 'danger',
    onConfirm: async () => {
      await apiJson(`/api/communications/scheduled/${entry.id}`, { method: 'DELETE' });
      showToast('That send was cancelled');
      if (queueDetail?.id === entry.id) setQueueDetail(null);
      loadQueue(queueStatus);
    },
  });

  /* ── use a sent or queued message as a new draft ────────────────────────── */

  /** Pull the stored files back down and turn them into the File objects the
   *  send form wants. History used to keep only their names, so a re-used
   *  draft quietly went out without its attachment. */
  const refetchFiles = async (entry) => {
    const files = [];
    for (let index = 0; index < (entry.attachments || []).length; index += 1) {
      const meta = entry.attachments[index];
      /* eslint-disable no-await-in-loop */
      const response = await apiFetch(
        `/api/communications/history/${entry.id}/files/${index}`);
      if (!response.ok) continue;
      const blob = await response.blob();
      /* eslint-enable no-await-in-loop */
      files.push(new File([blob], meta.filename,
        { type: blob.type || 'application/octet-stream' }));
    }
    return files;
  };

  /** Load a stored message back into the compose tab. The stored subject
   *  already carries its category prefix, so strip it rather than let the
   *  server add a second one. */
  const loadIntoCompose = async (source, { withFiles }) => {
    if (!source || drafting) return;
    setDrafting(true);
    const prefix = (config?.categories || []).find((c) => c.id === source.category)?.prefix || '';
    const stored = source.subject || '';
    setCategory(source.category);
    setSubject(prefix && stored.startsWith(prefix) ? stored.slice(prefix.length).trim() : stored);
    setBody(source.body || '');
    setTo(source.to_addrs || '');
    setCc(source.cc_addrs || '');
    setBcc(source.bcc_addrs || '');
    const saved = source.layout || {};
    setBannerTitle(saved.banner_title || '');
    setBannerSubtitle(saved.banner_subtitle || '');
    setHeadline(saved.headline || '');
    setResources(saved.resources || []);
    setAttachments([]);
    setTemplateId('');
    setSendAt('');
    // Keep the classification it was sent under, unless that label is gone.
    setSensitivity(
      findLabel(config?.sensitivity_labels || [], source.sensitivity)
        ? source.sensitivity
        : (config?.default_sensitivity || ''),
    );
    // Through changeTab, so the url follows the screen - setting the tab
    // directly left ?tab=history on a draft that is plainly in Compose, and a
    // refresh then threw you back into the history list.
    changeTab('compose');

    const named = (source.attachments || []).length;
    if (!named) {
      showToast('Copied into Compose');
      setDrafting(false);
      return;
    }
    if (!withFiles || !source.files_stored) {
      showToast(`Copied into Compose. Re-attach the ${plural(named, 'file')} before sending`);
      setDrafting(false);
      return;
    }
    showToast('Copied into Compose. Fetching the files…');
    try {
      const files = await refetchFiles(source);
      setAttachments(files);
      showToast(files.length === named
        ? `Copied into Compose with ${plural(files.length, 'file')}`
        : `Copied into Compose, but only ${files.length} of ${named} files could be fetched`);
    } catch {
      showError('Copied into Compose, but the files could not be fetched. Re-attach them');
    } finally {
      setDrafting(false);
    }
  };

  /* ── from the What's New tab straight into a draft ──────────────────────── */
  const startWhatsNewDraft = useCallback((ids) => {
    if (!ids.length) return;
    if (!config?.ai_drafting) {
      showError('AI drafting is not configured on this server');
      return;
    }
    // An announcement is an update, whatever was selected in the rail before.
    setCategory('update');
    changeTab('compose');
    setAiMode('whats_new');
  }, [config, changeTab, showError]);

  /* ── from the welcome screen into the studio ────────────────────────────── */
  const openFromWelcome = useCallback((next, opts = {}) => {
    if (opts.category) setCategory(opts.category);
    changeTab(TABS.includes(next) ? next : 'compose');
    if (opts.ai) {
      if (config?.ai_drafting) setAiMode('write');
      else showError('AI drafting is not configured on this server');
    }
  }, [config, changeTab, showError]);

  /* ── AI draft lands in the editor ───────────────────────────────────────── */
  const applyDraft = useCallback((draft) => {
    if (draft.subject) setSubject(draft.subject);
    if (draft.body) setBody(draft.body);
    if (!draft.keepBlocks) {
      // Only what the model actually filled in — an empty banner_title means
      // it had no opinion, not that the one on screen should be cleared.
      if (draft.headline) setHeadline(draft.headline);
      if (draft.banner_title) setBannerTitle(draft.banner_title);
      if (draft.banner_subtitle) setBannerSubtitle(draft.banner_subtitle);
    }
    // Only the items it actually wrote about ride along to the send. If it
    // quietly dropped one, that one stays on the waiting list.
    if (draft.used_note_ids?.length) setNoteIds(draft.used_note_ids);
    setAiMode(null);
    showToast('Draft inserted. Read it before you send');
  }, [showToast]);

  // A template or an AI draft that fills the branding blocks opens them, so
  // nothing lands in the email that the form is hiding.
  const hasBranding = [bannerTitle, bannerSubtitle, headline].some(hasText) || resources.length > 0;
  useEffect(() => { if (hasBranding) setBrandingOpen(true); }, [hasBranding]);

  // The sliding pill under the active tab, kept in place through resizes and
  // the badge counts changing a tab's width.
  useEffect(() => {
    const place = () => {
      const el = tabButtons.current[tab];
      if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth });
    };
    place();
    const ro = new ResizeObserver(place);
    if (tabStrip.current) ro.observe(tabStrip.current);
    return () => ro.disconnect();
  }, [tab, queueCounts.pending]);

  /* ── live preview, rendered server-side so it matches what goes out ─────── */
  // Every render takes a ticket, so a slow reply for an older draft can never
  // land on top of a newer one.
  const previewTicket = useRef(0);
  useEffect(() => {
    // Anything at all in the draft is worth previewing - a headline or a
    // resource row on its own used to leave the pane empty.
    const anyContent =
      [subject, body, bannerTitle, bannerSubtitle, headline].some(hasText) ||
      (layout.resources || []).length > 0;
    const mine = previewTicket.current + 1;
    previewTicket.current = mine;
    if (!anyContent) {
      setPreview({ subject: '', html: '' });
      setPreviewError('');
      setPreviewBusy(false);
      return undefined;
    }
    setPreviewBusy(true);
    const timer = setTimeout(() => {
      apiJson('/api/communications/preview', {
        method: 'POST',
        body: { category, subject, body, layout },
      })
        .then((rendered) => {
          if (mine !== previewTicket.current) return;
          setPreview(rendered);
          setPreviewError('');
        })
        // Still no toast - it would fire on every other keystroke. But the
        // pane keeps showing the last good render, and saying nothing left
        // that looking like a preview of what you just typed.
        .catch((err) => {
          if (mine === previewTicket.current) setPreviewError(err.message || 'Preview is out of date');
        })
        .finally(() => {
          if (mine === previewTicket.current) setPreviewBusy(false);
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [category, subject, body, bannerTitle, bannerSubtitle, headline, layout]);

  /* ── tallies and blockers ───────────────────────────────────────────────── */
  const tally = useMemo(() => {
    const t = classifyAddresses(to);
    const c = classifyAddresses(cc);
    const b = classifyAddresses(bcc);
    return {
      to: t.valid.length,
      cc: c.valid.length,
      bcc: b.valid.length,
      total: t.valid.length + c.valid.length + b.valid.length,
      invalid: t.invalid.length + c.invalid.length + b.invalid.length,
    };
  }, [to, cc, bcc]);

  const attachmentBytes = attachments.reduce((sum, f) => sum + f.size, 0);
  const maxBytes = (config?.max_attachment_mb ?? 10) * 1024 * 1024;
  const maxSubjectChars = config?.max_subject_chars ?? 300;
  const maxBodyChars = config?.max_body_chars ?? 50000;
  const maxScheduleDays = config?.max_schedule_days ?? 90;

  // Recomputed on every render rather than held in state: a "min" that was
  // right when the page loaded is wrong by the time a long message is written.
  const earliestSend = easternInputValue(new Date(Date.now() + 5 * 60 * 1000));
  const latestSend = easternInputValue(
    new Date(Date.now() + maxScheduleDays * 86400 * 1000));

  const blockers = useMemo(() => {
    const list = [];
    if (!subject.trim()) list.push('Subject is empty');
    if (!body.trim()) list.push('Message is empty');
    if (subject.length > maxSubjectChars) list.push(`Subject is over ${maxSubjectChars} characters`);
    if (body.length > maxBodyChars) {
      list.push(`Message is over ${maxBodyChars.toLocaleString()} characters`);
    }
    if (tally.to === 0) list.push('No valid To recipients');
    // Say which key fixes it. The address is sitting right there in the box;
    // the admin just has not told us it is finished yet.
    const unfinished = Object.keys(drafts).filter((field) => drafts[field].trim());
    if (unfinished.length) {
      list.push(`Press Enter to add the address typed in ${unfinished
        .map((field) => field.toUpperCase()).join(' and ')}`);
    }
    if (tally.invalid > 0) list.push(`${tally.invalid} address${tally.invalid === 1 ? '' : 'es'} need fixing`);
    if (attachmentBytes > maxBytes) list.push('Attachments are over the size limit');
    if (config && tally.total > config.max_recipients) {
      list.push(`Over the ${config.max_recipients} recipient limit`);
    }
    if (sendAt && sendAt < earliestSend) list.push('The send time has already passed');
    if (sendAt && sendAt > latestSend) {
      list.push(`Cannot schedule more than ${maxScheduleDays} days ahead`);
    }
    return list;
  }, [subject, body, tally, attachmentBytes, maxBytes, maxSubjectChars, maxBodyChars,
      config, sendAt, earliestSend, latestSend, maxScheduleDays, drafts]);

  const ready = blockers.length === 0;

  /* ── attachments ────────────────────────────────────────────────────────── */
  const addFiles = (fileList) => {
    const incoming = Array.from(fileList || []);
    const max = config?.max_attachments ?? 5;
    const merged = [...attachments];
    let overflow = 0;
    let duplicate = 0;
    incoming.forEach((file) => {
      if (merged.length >= max) { overflow += 1; return; }
      if (merged.some((f) => f.name === file.name && f.size === file.size)) {
        duplicate += 1;
        return;
      }
      merged.push(file);
    });
    // Say what was dropped and why. Adding four files to a full list used to
    // look exactly like adding four files to an empty one.
    if (overflow) {
      showError(`At most ${max} attachments: ${overflow} file${overflow === 1 ? '' : 's'} not added`);
    } else if (duplicate) {
      showError(`${duplicate} file${duplicate === 1 ? ' is' : 's are'} already attached`);
    }
    setAttachments(merged);
    if (fileInput.current) fileInput.current.value = '';
  };

  const removeFile = (index) => setAttachments(attachments.filter((_, i) => i !== index));

  /* ── recipients from the directory ──────────────────────────────────────── */
  const addRecipients = (field, emails) => {
    const setter = { to: setTo, cc: setCc, bcc: setBcc }[field];
    const current = { to, cc, bcc }[field];
    const existing = splitAddresses(current);
    const seen = new Set(existing.map((a) => a.toLowerCase()));
    const added = emails.filter((email) => {
      const key = email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    setter([...existing, ...added].join(', '));
    const skipped = emails.length - added.length;
    showToast(
      `${plural(added.length, 'address')} added to ${field.toUpperCase()}`
      + (skipped ? ` · ${skipped} already there` : ''));
  };

  /* ── send ───────────────────────────────────────────────────────────────── */
  const post = async (testOnly) => {
    const form = new FormData();
    form.append('category', category);
    form.append('subject', subject);
    form.append('body', body);
    form.append('layout', JSON.stringify(layout));
    form.append('to', to);
    form.append('cc', cc);
    form.append('bcc', bcc);
    form.append('test_only', testOnly ? 'true' : 'false');
    form.append('send_at', testOnly ? '' : sendAt);
    form.append('sensitivity', sensitivity);
    form.append('release_notes', noteIds.join(','));
    attachments.forEach((file) => form.append('files', file, file.name));

    const response = await apiFetch('/api/communications/send', { method: 'POST', body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || 'Send failed');
    return payload;
  };

  const clearDraft = () => {
    setSubject(''); setBody(''); setTo(''); setCc(''); setBcc('');
    setAttachments([]); setTemplateId(''); setSendAt('');
    setCopiesOpen(false);
    setDrafts({ to: '', cc: '', bcc: '' });
    setBannerTitle(''); setBannerSubtitle(''); setHeadline('');
    setResources([]);
    setNoteIds([]);
    setSensitivity(config?.default_sensitivity || '');
  };

  const sendTest = async () => {
    if (!subject.trim() || !body.trim()) {
      showError('Add a subject and a message first');
      return;
    }
    setSending(true);
    try {
      await post(true);
      // A test never waits for the schedule — it is a rehearsal, and one you
      // find out about on Saturday is no rehearsal at all.
      showToast(`Test sent to ${user?.email || 'you'}${sendAt ? ' (the schedule is unaffected)' : ''}`);
    } catch (err) {
      showError(err.message);
    } finally {
      setSending(false);
    }
  };

  const sendForReal = async () => {
    setSending(true);
    try {
      const result = await post(false);
      setConfirming(false);
      flyEnvelope(sendButton.current, tabButtons.current[result.scheduled ? 'queue' : 'history']);
      if (result.scheduled) {
        showToast(`Queued for ${formatTimestamp(result.send_at)} · ${plural(result.recipient_count, 'recipient')}`);
        loadQueue(queueStatus);
        setBump((n) => n + 1);
      } else {
        showToast(`Sent to ${plural(result.recipient_count, 'recipient')}`);
      }
      clearDraft();
    } catch (err) {
      setConfirming(false);
      showError(err.message);
    } finally {
      setSending(false);
    }
  };

  const resend = (entry) => setCheck({
    title: entry.status === 'failed' ? 'Try sending this again?' : 'Send this message again?',
    subtitle: `"${entry.subject}" goes back out to the same ${plural(entry.recipient_count, 'recipient')}`
      + `${(entry.attachments || []).length && !entry.files_stored
            ? ', without its attachments, which are no longer stored' : ''}.`
      + ' It is recorded as a new entry, so the original stays as it is.',
    confirmLabel: 'Send it again',
    onConfirm: async () => {
      const result = await apiJson(`/api/communications/history/${entry.id}/resend`,
        { method: 'POST' });
      showToast(`Sent again to ${plural(result.recipient_count, 'recipient')}`
        + (result.missing_attachments
            ? ` · ${plural(result.missing_attachments, 'file')} no longer stored` : ''));
      setDetail(null);
      loadHistory(historyOffset, historySearch, historyStatus, historyCategory);
    },
  });

  /* ── templates ──────────────────────────────────────────────────────────── */
  const applyTemplate = (id) => {
    setTemplateId(id);
    const template = templates.find((t) => t.id === id);
    if (!template) return;
    setCategory(template.category);
    setSubject(template.subject);
    setBody(template.body);
    const saved = template.layout || {};
    setBannerTitle(saved.banner_title || '');
    setBannerSubtitle(saved.banner_subtitle || '');
    setHeadline(saved.headline || '');
    setResources(saved.resources || []);
  };

  const selectedTemplate = templates.find((t) => t.id === templateId) || null;

  // Measured against the full list, not a filtered one, so clearing a search
  // never makes the box vanish from under the cursor.
  useEffect(() => {
    const el = templateList.current;
    if (!el) { setTemplatesOverflow(false); return undefined; }
    const measure = () => {
      if (!templateSearch) setTemplatesOverflow(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [templates, templateSearch, tab, templatesState.loading]);

  // Matches the name, the subject, or the message type's label.
  const filteredTemplates = useMemo(() => {
    const q = templateSearch.trim().toLowerCase();
    if (!q) return templates;
    const labels = Object.fromEntries((config?.categories || []).map((c) => [c.id, c.label]));
    return templates.filter((t) => [t.name, t.subject, labels[t.category] || t.category]
      .some((field) => String(field || '').toLowerCase().includes(q)));
  }, [templates, templateSearch, config]);

  const saveTemplate = () => setAsk({
    title: 'Save as a template',
    subtitle: 'Everything in the editor is saved: category, subject, message and template blocks.',
    label: 'Template name',
    placeholder: 'Monthly release notes',
    confirmLabel: 'Save template',
    onConfirm: async (name) => {
      const result = await apiJson('/api/communications/templates', {
        method: 'POST',
        body: { name, category, subject, body, layout },
      });
      showToast(`Template "${name}" saved`);
      // Select what was just saved, so Update and Delete act on it without the
      // admin having to hunt for it in the list first.
      if (result?.id) setTemplateId(result.id);
      loadTemplates();
    },
  });

  /** Overwrite the selected template in place. The endpoint has always existed;
   *  until recently the only way to change a template was to delete and retype it. */
  const updateTemplate = () => {
    if (!selectedTemplate) return;
    setCheck({
      title: `Overwrite "${selectedTemplate.name}"?`,
      subtitle: 'The saved version is replaced by what is in the editor now.',
      confirmLabel: 'Overwrite it',
      onConfirm: async () => {
        await apiJson(`/api/communications/templates/${selectedTemplate.id}`, {
          method: 'PUT',
          body: { name: selectedTemplate.name, category, subject, body, layout },
        });
        showToast(`Template "${selectedTemplate.name}" updated`);
        loadTemplates();
      },
    });
  };

  const deleteTemplate = () => {
    if (!selectedTemplate) return;
    setCheck({
      title: `Delete "${selectedTemplate.name}"?`,
      subtitle: 'The template is removed for everyone. Messages already sent from it are not affected.',
      confirmLabel: 'Delete it',
      tone: 'danger',
      onConfirm: async () => {
        await apiJson(`/api/communications/templates/${selectedTemplate.id}`, { method: 'DELETE' });
        showToast(`Template "${selectedTemplate.name}" deleted`);
        setTemplateId('');
        loadTemplates();
      },
    });
  };

  /** Both dialogues run their action here so the busy state, the error toast
   *  and the closing are handled once instead of in nine call sites. */
  const runChecked = async (action) => {
    setWorking(true);
    try {
      await action();
      setCheck(null);
      setAsk(null);
    } catch (err) {
      showError(err.message || 'That did not work');
    } finally {
      setWorking(false);
    }
  };

  /* ── resources ──────────────────────────────────────────────────────────── */
  const addResource = () =>
    setResources([...resources, { title: '', description: '', link_text: 'Link', link_url: '' }]);

  const updateResource = (index, field, value) =>
    setResources(resources.map((r, i) => (i === index ? { ...r, [field]: value } : r)));

  const removeResource = (index) =>
    setResources(resources.filter((_, i) => i !== index));

  /* ── render ─────────────────────────────────────────────────────────────── */
  const categories = config?.categories || [];
  const sensitivityTree = config?.sensitivity_labels || [];
  const sensitivityLabel = findLabel(sensitivityTree, sensitivity)?.path || '';
  const activeCategory = categories.find((c) => c.id === category);
  const accent = activeCategory?.color || '#eb1700';
  const hints = PLACEHOLDERS[category] || PLACEHOLDERS.custom;
  const isHome = tab === HOME;
  const isCompose = tab === 'compose';
  const isWhatsNew = tab === 'whats-new';
  const isQueue = tab === 'queue';
  const isHistory = tab === 'history';

  const scheduledLabel = sendAt ? wallClockLabel(sendAt) : '';

  const showCopies = copiesOpen || hasText(cc) || hasText(bcc) || hasText(drafts.cc) || hasText(drafts.bcc);
  const unfinishedDrafts = Object.values(drafts).some((text) => text.trim());
  const audienceDone = tally.to > 0 && tally.invalid === 0 && !unfinishedDrafts
    && !(config && tally.total > config.max_recipients);
  const messageDone = hasText(subject) && hasText(body)
    && subject.length <= maxSubjectChars && body.length <= maxBodyChars;
  // Four checks a person can read at a glance. `blockers` stays the authority
  // on whether Send is enabled; these only explain the ring.
  const checks = [
    { ok: hasText(subject) && subject.length <= maxSubjectChars, label: 'Subject line written' },
    { ok: hasText(body) && body.length <= maxBodyChars, label: 'Message written' },
    { ok: audienceDone, label: 'Recipients ready' },
    { ok: attachmentBytes <= maxBytes && (!sendAt || (sendAt >= earliestSend && sendAt <= latestSend)),
      label: 'Files and send time OK' },
  ];
  const passed = checks.filter((c) => c.ok).length;
  const words = hasText(body) ? body.trim().split(/\s+/).length : 0;

  const readyHint = ready
    ? `${activeCategory?.label || 'Message'} · ${plural(tally.total, 'recipient')}`
      + (attachments.length ? ` · ${plural(attachments.length, 'attachment')}` : '')
      + (sendAt ? ` · goes out ${scheduledLabel}` : '')
    : blockers[0];

  // Which message the right-hand pane is showing, if any.
  const viewing = isCompose ? null : (isQueue ? queueDetail : detail);
  const viewingCategory = viewing ? categories.find((c) => c.id === viewing.category) : null;

  if (isHome) {
    return (
      <>
        {toast && <Toast key={toast.id} {...toast} onClose={() => setToast(null)} />}
        <Suspense
          fallback={(
            <div className="min-h-full flex items-center justify-center bg-[#f4f1ed]" role="status" aria-label="Loading">
              <LoadingSpinner />
            </div>
          )}
        >
          <CommunicationWelcome
            config={config}
            configState={configState}
            onRetryConfig={loadConfig}
            categories={categories}
            aiAvailable={Boolean(config?.ai_drafting)}
            onOpen={openFromWelcome}
            stats={{
              sent: overview.sent,
              whatsNew: overview.whatsNew,
              queued: queueError ? null : queueCounts.pending,
              templates: templatesState.loading ? undefined : (templatesState.error ? null : templates.length),
            }}
          />
        </Suspense>
      </>
    );
  }

  const railButton = (active) => `flex items-center w-full px-2.5 py-2 rounded-[10px] font-johnson-text text-[13px]
    transition-colors ${active
      ? 'bg-jj-red/[0.05] text-jj-gray-08 font-medium shadow-[inset_3px_0_0_#eb1700]'
      : 'text-jj-gray-07 hover:bg-jj-gray-01'}`;

  return (
    <div className={`min-h-full flex flex-col bg-[#f6f4f1] font-johnson-text text-jj-gray-08 ${perfTier === 'full' ? '' : 'cc-lite'}`}>
      {toast && <Toast key={toast.id} {...toast} onClose={() => setToast(null)} />}

      {/* Header */}
      <header className="sticky top-0 z-30 flex items-center gap-3 flex-wrap px-5 py-3 bg-white/90 backdrop-blur-md
                         border-b border-jj-gray-02">
        <button
          type="button"
          onClick={() => changeTab(HOME)}
          title="Back to the Communication Center home"
          className="flex items-center gap-3 min-w-0 -ml-1 pl-1 pr-2.5 py-1 rounded-xl text-left hover:bg-jj-gray-01
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-jj-blue-03"
        >
          <span className="w-[38px] h-[38px] rounded-[11px] flex items-center justify-center flex-none text-jj-red
                           bg-gradient-to-br from-jj-red/10 to-jj-violet-03/10">
            <Glyph src={mailIcon} size={20} />
          </span>
          <span className="min-w-0">
            <span className="block font-johnson-display font-medium text-[19px] leading-[1.1] tracking-[-0.01em]">
              Communication Center
            </span>
            <span className="flex items-center gap-1.5 font-johnson-text text-[11.5px] text-jj-gray-06 mt-0.5 truncate">
              <span className={`w-1.5 h-1.5 rounded-full flex-none ${configState.error
                ? 'bg-jj-red' : configState.loading ? 'bg-jj-orange-03' : 'bg-jj-green-03'}`} />
              {configState.loading
                ? 'Connecting to Mail Engine…'
                : configState.error ? 'Mail Engine unreachable' : (config?.sender ? `Sending as ${config.sender}` : 'Mail Engine online')}
            </span>
          </span>
        </button>
        {configState.error && (
          <button type="button" onClick={loadConfig} className={CLS.chipBtn}>Retry</button>
        )}

        <nav
          ref={tabStrip}
          role="tablist"
          aria-label="Communication Center sections"
          className="relative flex gap-0.5 p-1 bg-jj-gray-01 rounded-xl ml-auto"
        >
          <span className="cc-tab-pill" style={{ transform: `translateX(${pill.left}px)`, width: pill.width }} aria-hidden="true" />
          {[['compose', 'Compose', editIcon], ['whats-new', 'What’s new', aiIcon],
            ['queue', 'Queue', calendarIcon], ['history', 'Sent history', checkIcon]].map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              ref={(el) => { tabButtons.current[id] = el; }}
              onClick={() => changeTab(id)}
              className={`relative z-[1] flex items-center gap-1.5 px-3.5 py-1.5 rounded-[9px] font-johnson-text
                          text-[12.5px] transition-colors ${tab === id
                ? 'text-jj-gray-08 font-medium'
                : 'text-jj-gray-06 hover:text-jj-gray-08'}`}
            >
              <Glyph src={icon} size={13} className={tab === id ? 'text-jj-red' : 'opacity-70'} />
              <span className="hidden sm:inline">{label}</span>
              {id === 'queue' && queueCounts.pending > 0 && (
                <span
                  key={bump}
                  className={`px-1.5 py-0.5 rounded-full bg-jj-red/[0.09] text-jj-red text-[10.5px] ${bump ? 'cc-bump' : ''}`}
                >
                  {queueCounts.pending}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <div className="flex-1 flex items-stretch flex-wrap min-h-0">
        {/* ── Rail ── */}
        <aside className="w-[256px] flex-none bg-white border-r border-jj-gray-02">
          {/* Sticky so the type and template lists stay in reach on a long form. */}
          <div className="sticky top-[72px] px-4 py-5 max-h-[calc(100vh-72px)] overflow-auto">
          {isCompose && (
            <>
              <div className={CLS.railH}>Message type</div>
              <div className="flex flex-col gap-1 mt-2.5 mb-6">
                {categories.length === 0 && configState.loading && [0, 1, 2, 3].map((i) => (
                  <div key={i} className="cc-skel h-[46px] rounded-xl" />
                ))}
                {categories.length === 0 && configState.error && (
                  <p className={CLS.hint}>Message types could not be loaded. Use Retry at the top.</p>
                )}
                {categories.map((c, i) => {
                  const active = category === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setCategory(c.id)}
                      aria-pressed={active}
                      className={`cc-rise flex items-center gap-2.5 w-full text-left px-2.5 py-2 rounded-xl border
                                  transition-[transform,background-color,border-color] duration-300 ${active ? '' : 'border-transparent hover:bg-jj-gray-01 hover:translate-x-0.5'}`}
                      style={{
                        animationDelay: `${i * 0.04}s`,
                        ...(active ? {
                          borderColor: tint(c.color, 0.28),
                          background: tint(c.color, 0.05),
                          boxShadow: `0 10px 24px -18px ${tint(c.color, 0.6)}`,
                        } : {}),
                      }}
                    >
                      <span
                        className="w-7 h-7 rounded-[9px] flex items-center justify-center flex-none transition-colors"
                        style={{ background: active ? c.color : tint(c.color, 0.11), color: active ? '#fff' : c.color }}
                      >
                        <Glyph src={CATEGORY_ICON[c.id] || mailIcon} size={14} />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block font-johnson-text text-[13px] font-medium text-jj-gray-08">{c.label}</span>
                        <span className="block font-mono text-[10.5px] text-jj-gray-05 truncate">{c.prefix || 'no prefix'}</span>
                      </span>
                      {active && <span className="cc-pop text-[12px]" style={{ color: c.color }}>✓</span>}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center justify-between mb-2.5">
                <span className={CLS.railH}>Templates</span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={saveTemplate}
                    disabled={!subject.trim() && !body.trim()}
                    title="Save as template"
                    className={`flex items-center gap-1 ${CLS.chipBtn}`}
                  >
                    <Icon src={saveIcon} className="w-3 h-3" tone="dark" />Save
                  </button>
                  <button
                    type="button"
                    onClick={updateTemplate}
                    disabled={!selectedTemplate}
                    title={selectedTemplate ? `Overwrite "${selectedTemplate.name}"` : 'Pick a template to overwrite'}
                    className={CLS.chipBtn}
                  >
                    Update
                  </button>
                  <button
                    type="button"
                    onClick={deleteTemplate}
                    disabled={!templateId}
                    title="Delete template"
                    aria-label="Delete template"
                    className={CLS.chipBtn}
                  >
                    <Icon src={trashIcon} className="w-3 h-3" tone="red" />
                  </button>
                </div>
              </div>

              {templatesState.loading ? (
                <div className="flex flex-col gap-1.5" role="status" aria-label="Loading templates">
                  {[0, 1, 2].map((i) => <div key={i} className="cc-skel h-[42px] rounded-[10px]" />)}
                </div>
              ) : templatesState.error ? (
                <div>
                  <p className="font-johnson-text text-[11.5px] text-jj-maroon-05 leading-relaxed">{templatesState.error}</p>
                  <button type="button" onClick={loadTemplates} className={`${CLS.chipBtn} mt-1.5`}>Try again</button>
                </div>
              ) : templates.length === 0 ? (
                <p className={CLS.hint}>No saved templates yet. Write a message and press Save.</p>
              ) : (
                <>
                {(templatesOverflow || templateSearch) && (
                <div className="cc-rise relative mb-2">
                  <Glyph src={searchIcon} size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-jj-gray-05" />
                  <input
                    type="search"
                    value={templateSearch}
                    onChange={(e) => setTemplateSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') setTemplateSearch(''); }}
                    placeholder="Find a template"
                    aria-label="Find a template"
                    className="w-full pl-7 pr-2.5 py-[7px] rounded-[10px] border border-jj-gray-03 bg-white font-johnson-text
                               text-[12.5px] outline-none focus:border-jj-red focus:ring-[3px] focus:ring-jj-red/10"
                  />
                </div>
                )}
                {filteredTemplates.length === 0 && (
                  <p className={`${CLS.hint} px-1 py-1.5`}>
                    No template matches &ldquo;{templateSearch.trim()}&rdquo;.
                  </p>
                )}
                <div ref={templateList} className="flex flex-col gap-0.5 max-h-[280px] overflow-y-auto -mr-1 pr-1">
                  {filteredTemplates.map((t) => {
                    const meta = categories.find((c) => c.id === t.category);
                    const active = templateId === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => applyTemplate(t.id)}
                        aria-pressed={active}
                        className={`flex items-center gap-2.5 w-full text-left px-2.5 py-2 rounded-[10px] transition-colors ${
                          active ? 'bg-[#f7f5f2]' : 'hover:bg-jj-gray-01'}`}
                        style={active ? { boxShadow: `inset 3px 0 0 ${meta?.color || '#eb1700'}` } : undefined}
                      >
                        <span className="w-1.5 h-1.5 rounded-full flex-none" style={{ background: meta?.color || '#a39992' }} />
                        <span className="min-w-0">
                          <span className="block font-johnson-text text-[12.5px] text-jj-gray-08 truncate">{t.name}</span>
                          <span className="block font-johnson-text text-[10.5px] text-jj-gray-05">{meta?.label || t.category}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                </>
              )}

              <div className="mt-6 px-3 py-2.5 rounded-xl border border-jj-blue-03/15 font-johnson-text text-[11.5px]
                              leading-relaxed text-jj-gray-07 bg-gradient-to-br from-jj-blue-03/[0.05] to-jj-violet-03/[0.05]">
                <b className="font-medium text-jj-gray-08">Tip ·</b> open any message in <b className="font-medium text-jj-gray-08">Sent history</b> and
                press Use as draft to start from it, files and all.
              </div>
            </>
          )}

          {isHistory && (
            <>
              <div className="relative mb-5">
                <Glyph src={searchIcon} size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-jj-gray-05" />
                <input
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Search sent mail"
                  aria-label="Search sent mail"
                  className="w-full pl-8 pr-2.5 py-2 rounded-[10px] border border-jj-gray-03 bg-white
                             font-johnson-text text-[13px] outline-none focus:border-jj-red focus:ring-[3px] focus:ring-jj-red/10"
                />
              </div>
              <div className={CLS.railH}>Status</div>
              <div className="flex flex-col gap-0.5 mt-2.5">
                {[['all', 'All'], ['sent', 'Sent'], ['failed', 'Failed'], ['test', 'Tests']].map(([id, label]) => (
                  <button key={id} type="button" onClick={() => setHistoryStatus(id)}
                          aria-pressed={historyStatus === id} className={railButton(historyStatus === id)}>
                    <span className="flex-1 text-left">{label}</span>
                    <span className="font-johnson-text text-[11.5px] text-jj-gray-05 tabular-nums">{historyCounts[id] ?? 0}</span>
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-between mt-6">
                <span className={CLS.railH}>By type</span>
                {historyCategory && (
                  <button type="button" onClick={() => setHistoryCategory('')} className={CLS.chipBtn}>Clear</button>
                )}
              </div>
              <div className="flex flex-col gap-0.5 mt-2.5">
                {categories.length === 0 && configState.loading && [0, 1, 2, 3].map((i) => (
                  <div key={i} className="cc-skel h-[34px] rounded-[10px]" />
                ))}
                {categories.map((c) => {
                  const active = historyCategory === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setHistoryCategory(active ? '' : c.id)}
                      aria-pressed={active}
                      title={active ? 'Show every type' : `Only ${c.label.toLowerCase()} messages`}
                      className={`flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[10px] font-johnson-text text-[13px]
                                  transition-colors ${active ? 'text-jj-gray-08 font-medium' : 'text-jj-gray-07 hover:bg-jj-gray-01'}`}
                      style={active ? { background: tint(c.color, 0.06), boxShadow: `inset 3px 0 0 ${c.color}` } : undefined}
                    >
                      <span className="w-2 h-2 rounded-full flex-none" style={{ background: c.color }} />
                      <span className="flex-1 text-left">{c.label}</span>
                      <span className="font-johnson-text text-[11.5px] text-jj-gray-05 tabular-nums">
                        {(historyByType[c.id] ?? 0).toLocaleString()}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {isQueue && (
            <>
              <div className={CLS.railH}>Queue</div>
              <div className="flex flex-col gap-0.5 mt-2.5 mb-5">
                {QUEUE_FILTERS.map(([id, label]) => (
                  <button key={id} type="button" onClick={() => setQueueStatus(id)}
                          aria-pressed={queueStatus === id} className={railButton(queueStatus === id)}>
                    <span className="flex-1 text-left">{label}</span>
                    <span className="font-johnson-text text-[11.5px] text-jj-gray-05 tabular-nums">{queueCounts[id] ?? 0}</span>
                  </button>
                ))}
              </div>
              <div className="px-3 py-2.5 rounded-xl border border-jj-blue-03/15 font-johnson-text text-[11.5px] leading-relaxed
                              text-jj-gray-07 bg-gradient-to-br from-jj-blue-03/[0.05] to-jj-violet-03/[0.05]">
                Queued messages are sent by the server, so they go out whether or not anyone is signed in.
                Times are <b className="font-medium text-jj-gray-08">Eastern</b>.
              </div>
            </>
          )}

          {isWhatsNew && (
            <>
              <div className={CLS.railH}>How this works</div>
              <ol className="mt-3 mb-5 flex flex-col gap-3 list-none p-0">
                {['Ship something. A new page or endpoint is picked up on the next backend start, or when you press Scan now.',
                  'Write it a one-line summary, or add anything the code cannot show: a redesign, a fix, a policy change.',
                  'Tick what users should hear about and draft the announcement.',
                  'Send it. Only then do the items move to Announced.'].map((text, i) => (
                  <li key={i} className="cc-rise flex gap-2.5 font-johnson-text text-[12px] text-jj-gray-07 leading-relaxed"
                      style={{ animationDelay: `${i * 0.06}s` }}>
                    <span className="w-[22px] h-[22px] rounded-full bg-jj-gray-01 flex items-center justify-center flex-none
                                     font-johnson-display text-[10.5px] text-jj-gray-07">{i + 1}</span>
                    <span>{text}</span>
                  </li>
                ))}
              </ol>
              <div className="px-3 py-2.5 rounded-xl border border-jj-blue-03/15 font-johnson-text text-[11.5px] leading-relaxed
                              text-jj-gray-07 bg-gradient-to-br from-jj-blue-03/[0.05] to-jj-violet-03/[0.05]">
                Items are never announced automatically. Nothing leaves this portal until someone presses Send.
              </div>
            </>
          )}
          </div>
        </aside>

        {/* ── Centre ── */}
        <main className="flex-[1.15] min-w-[340px] flex flex-col min-h-0">
          {isWhatsNew && (
            <WhatsNewPanel
              selected={noteIds}
              onSelectedChange={setNoteIds}
              onDraft={startWhatsNewDraft}
              showToast={showToast}
              showError={showError}
            />
          )}

          {isCompose && (
            <>
              <div className="flex-1 overflow-auto p-5 flex flex-col gap-3.5">
                {/* Audience */}
                <section className={`cc-card cc-rise ${CLS.card} p-[18px] shadow-[0_14px_34px_-30px_rgba(49,44,42,0.6)]`}>
                  <div className="flex items-center gap-3 mb-2 flex-wrap">
                    <StepBadge n={1} done={audienceDone} />
                    <h2 className={CLS.sectionH}>Audience</h2>
                    <span className={CLS.hint}>Who receives it</span>
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setPicking(true)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[9px] border border-jj-gray-02 bg-white
                                   font-johnson-text text-[11.5px] text-jj-gray-07 hover:border-jj-gray-04 hover:text-jj-gray-08"
                      >
                        <Glyph src={communityIcon} size={13} />Directory
                      </button>
                      {!showCopies && (
                        <button
                          type="button"
                          onClick={() => setCopiesOpen(true)}
                          aria-expanded={false}
                          className="px-2.5 py-1.5 rounded-[9px] border border-jj-gray-02 bg-white font-johnson-text
                                     text-[11.5px] text-jj-gray-07 hover:border-jj-gray-04 hover:text-jj-gray-08"
                        >
                          Cc / Bcc
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col">
                    <RecipientField label="To" value={to} onChange={setTo}
                                    placeholder="name@its.jnj.com, then press Enter"
                                    onDraftChange={(text) => noteDraft('to', text)} />
                    {showCopies && (
                      <>
                        <RecipientField label="Cc" value={cc} onChange={setCc} placeholder="Optional"
                                        onDraftChange={(text) => noteDraft('cc', text)} />
                        <RecipientField label="Bcc" value={bcc} onChange={setBcc} placeholder="Optional"
                                        onDraftChange={(text) => noteDraft('bcc', text)} />
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-2.5 pt-2.5 border-t border-dashed border-jj-gray-02 flex-wrap">
                    <span className="font-johnson-text text-[11.5px] text-jj-gray-05" aria-live="polite">
                      <b className="font-medium text-jj-gray-08 tabular-nums">{plural(tally.total, 'person')}</b>
                      {' '}will receive this
                      {tally.invalid > 0 && <span className="text-jj-red"> · {tally.invalid} not valid</span>}
                    </span>
                    <span className="flex-1 min-w-[80px] h-1 rounded-full bg-jj-gray-01 overflow-hidden" aria-hidden="true">
                      <span
                        className="block h-full rounded-full transition-[width] duration-500"
                        style={{
                          width: `${Math.min(100, (tally.total / (config?.max_recipients || 500)) * 100)}%`,
                          background: config && tally.total > config.max_recipients
                            ? '#eb1700' : 'linear-gradient(90deg,#0f68b2,#8c3bbb)',
                        }}
                      />
                    </span>
                    <span className={CLS.hint}>
                      Limit {(config?.max_recipients ?? 500).toLocaleString()} addresses
                      {config?.allowed_domains?.length ? ` · ${config.allowed_domains.join(', ')} only` : ''}
                    </span>
                  </div>
                </section>

                {/* Message */}
                <section className={`cc-card cc-rise ${CLS.card} p-[18px] shadow-[0_14px_34px_-30px_rgba(49,44,42,0.6)]`}
                         style={{ animationDelay: '.05s' }}>
                  <div className="flex items-start gap-3 mb-3.5 flex-wrap">
                    <StepBadge n={2} done={messageDone} />
                    <h2 className={`${CLS.sectionH} pt-1`}>Message</h2>
                    {config?.ai_drafting && (
                      <div className="ml-auto">
                        <AIToolbar hasBody={hasText(body)} busy={Boolean(aiMode)} onPick={setAiMode} />
                      </div>
                    )}
                  </div>

                  {noteIds.length > 0 && (
                    <div className="cc-rise flex items-center gap-2 flex-wrap mb-3.5 px-3 py-2 rounded-[10px]
                                    bg-gradient-to-r from-jj-violet-03/[0.07] to-jj-blue-03/[0.05]">
                      <Glyph src={aiIcon} size={13} className="text-jj-violet-03" />
                      <span className="font-johnson-text text-[11.5px] text-jj-gray-07">
                        Sending this marks {plural(noteIds.length, 'what’s-new item')} announced.
                      </span>
                      <button type="button" onClick={() => setNoteIds([])} className={`${CLS.chipBtn} ml-auto`}>Don&rsquo;t</button>
                    </div>
                  )}

                  <div className="flex items-baseline justify-between mb-1.5">
                    <label htmlFor="cc-subject" className={CLS.label.replace(' mb-1.5', '')}>Subject</label>
                    {subject.length > maxSubjectChars * 0.8 && (
                      <span className={`font-johnson-text text-[11.5px] tabular-nums ${
                        subject.length > maxSubjectChars ? 'text-jj-red' : 'text-jj-gray-05'}`}>
                        {subject.length} / {maxSubjectChars}
                      </span>
                    )}
                  </div>
                  <div className="flex items-stretch border border-jj-gray-03 rounded-xl overflow-hidden bg-white mb-3.5
                                  transition-shadow focus-within:border-jj-red focus-within:ring-[3px] focus-within:ring-jj-red/[0.08]">
                    {activeCategory?.prefix && (
                      <span className="flex items-center px-3 flex-none bg-[#f7f5f2] border-r border-jj-gray-02 font-mono
                                       text-[12px] whitespace-nowrap transition-colors" style={{ color: accent }}>
                        {activeCategory.prefix}
                      </span>
                    )}
                    <input
                      id="cc-subject"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder={hints.subject}
                      className="flex-1 min-w-0 border-0 outline-none px-3 py-2.5 font-johnson-text text-[13.5px] text-jj-gray-08"
                    />
                  </div>

                  <label className={CLS.label}>Body</label>
                  <BodyEditor
                    value={body}
                    onChange={setBody}
                    placeholder={BODY_PLACEHOLDER}
                    invalid={body.length > maxBodyChars}
                    hint={body.length > maxBodyChars * 0.8
                      ? `${body.length.toLocaleString()} / ${maxBodyChars.toLocaleString()} characters`
                      : 'Markdown-lite · **bold** · - list'}
                  />
                </section>

                {/* Branding */}
                <section className={`cc-card cc-rise ${CLS.card} p-[18px] shadow-[0_14px_34px_-30px_rgba(49,44,42,0.6)]`}
                         style={{ animationDelay: '.1s' }}>
                  <div className="flex items-center gap-3 flex-wrap">
                    <StepBadge n={3} done={hasBranding} />
                    <h2 className={CLS.sectionH}>Branding</h2>
                    <span className={CLS.hint}>Optional banner, headline and resources</span>
                    <button
                      type="button"
                      onClick={() => setBrandingOpen((v) => !v)}
                      aria-expanded={brandingOpen}
                      aria-controls="cc-branding"
                      className="ml-auto flex items-center gap-1.5 font-johnson-text text-[11.5px] text-jj-gray-06 hover:text-jj-gray-08"
                    >
                      <Glyph src={chevronIcon} size={10}
                             style={{ transform: brandingOpen ? 'rotate(90deg)' : 'none', transition: 'transform .3s' }} />
                      {brandingOpen ? 'Hide' : 'Show'}
                    </button>
                  </div>

                  {brandingOpen && (
                    <div id="cc-branding" className="cc-rise mt-3.5">
                      <p className={`${CLS.hint} mb-3`}>Leave these blank for a plain branded note.</p>
                      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5 mb-3">
                        <div>
                          <label htmlFor="cc-bt" className={CLS.label}>Banner title</label>
                          <input id="cc-bt" value={bannerTitle} onChange={(e) => setBannerTitle(e.target.value)}
                                 placeholder={hints.bannerTitle} className={CLS.input} />
                        </div>
                        <div>
                          <label htmlFor="cc-bs" className={CLS.label}>Banner subtitle</label>
                          <input id="cc-bs" value={bannerSubtitle} onChange={(e) => setBannerSubtitle(e.target.value)}
                                 placeholder={hints.bannerSubtitle} className={CLS.input} />
                        </div>
                      </div>
                      <div className="mb-4">
                        <label htmlFor="cc-hl" className={CLS.label}>Headline</label>
                        <input id="cc-hl" value={headline} onChange={(e) => setHeadline(e.target.value)}
                               placeholder={hints.headline} className={CLS.input} />
                      </div>

                      <div className="flex items-center justify-between mb-2">
                        <span className={CLS.label.replace(' mb-1.5', '')}>Resources</span>
                        <button
                          type="button"
                          onClick={addResource}
                          disabled={resources.length >= 8}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[9px] border border-jj-gray-02 bg-white
                                     font-johnson-text text-[11.5px] text-jj-gray-07 hover:border-jj-gray-04 disabled:opacity-40"
                        >
                          <Glyph src={addIcon} size={11} />Add resource
                        </button>
                      </div>

                      {resources.length === 0 ? (
                        <p className={CLS.hint}>No resource links. Add one to render the Resources block.</p>
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {resources.map((resource, index) => (
                            <li key={index} className="cc-pop relative p-3 pl-4 bg-[#faf9f7] rounded-xl flex flex-col gap-1.5">
                              <span className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-full" style={{ background: accent }} />
                              <div className="flex items-center gap-2">
                                <input value={resource.title} aria-label="Resource title"
                                       onChange={(e) => updateResource(index, 'title', e.target.value)}
                                       placeholder="Release notes" className={CLS.inputSm} />
                                <button type="button" onClick={() => removeResource(index)} aria-label="Remove resource"
                                        className="opacity-50 hover:opacity-100 flex-none">
                                  <Icon src={closeIcon} className="w-3 h-3" tone="gray" />
                                </button>
                              </div>
                              <input value={resource.description} aria-label="Resource description"
                                     onChange={(e) => updateResource(index, 'description', e.target.value)}
                                     placeholder="Full list of what changed in this release." className={CLS.inputSm} />
                              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
                                <input value={resource.link_text} aria-label="Link text"
                                       onChange={(e) => updateResource(index, 'link_text', e.target.value)}
                                       placeholder="Open" className={CLS.inputSm} />
                                <input value={resource.link_url} aria-label="Link address"
                                       onChange={(e) => updateResource(index, 'link_url', e.target.value)}
                                       placeholder="https://gra-smarthub.jnj.com/…" className={CLS.inputSm} />
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </section>

                {/* Attachments */}
                <section className={`cc-card cc-rise ${CLS.card} p-[18px] shadow-[0_14px_34px_-30px_rgba(49,44,42,0.6)]`}
                         style={{ animationDelay: '.15s' }}>
                  <div className="flex items-center gap-3 mb-3 flex-wrap">
                    <StepBadge n={4} done={attachments.length > 0 && attachmentBytes <= maxBytes} />
                    <h2 className={CLS.sectionH}>Attachments</h2>
                    <span className={CLS.hint}>
                      Up to {config?.max_attachments ?? 5} files · {config?.max_attachment_mb ?? 10} MB
                    </span>
                  </div>

                  {attachments.length > 0 && (
                    <ul className="flex flex-col gap-1.5 mb-2.5">
                      {attachments.map((file, index) => {
                        const ext = (file.name.split('.').pop() || '').slice(0, 4).toUpperCase();
                        return (
                          <li key={`${file.name}-${index}`}
                              className="cc-pop flex items-center gap-2.5 px-3 py-2 bg-[#faf9f7] rounded-[11px]">
                            <span className="w-[30px] h-[34px] rounded-md flex items-center justify-center flex-none text-white
                                             font-johnson-text text-[8.5px] font-bold tracking-wide"
                                  style={{ background: FILE_TINT[ext] || '#6e6259' }}>
                              {ext || 'FILE'}
                            </span>
                            <span className="flex-1 min-w-0 font-johnson-text text-[13px] truncate">{file.name}</span>
                            <span className={CLS.hint}>{formatBytes(file.size)}</span>
                            <button type="button" onClick={() => removeFile(index)} aria-label={`Remove ${file.name}`}
                                    className="opacity-50 hover:opacity-100">
                              <Icon src={closeIcon} className="w-3 h-3" tone="gray" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  <input ref={fileInput} type="file" multiple onChange={(e) => addFiles(e.target.files)} className="hidden" />
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
                    className={`w-full flex flex-col items-center gap-1.5 py-5 rounded-[14px] border-[1.5px] border-dashed
                                transition-[transform,background-color,border-color] duration-300 font-johnson-text text-[12.5px] text-jj-gray-06 ${dragging
                      ? 'border-jj-red bg-jj-red/[0.03] scale-[1.005]'
                      : 'border-jj-gray-04 bg-[#fcfbfa] hover:border-jj-red'}`}
                  >
                    <span className="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-jj-red
                                     shadow-[0_8px_18px_-12px_rgba(49,44,42,0.5)]">
                      <Glyph src={addIcon} size={16} />
                    </span>
                    <b className="font-medium text-jj-gray-08">{dragging ? 'Drop to attach' : 'Drop files here or browse'}</b>
                  </button>
                  <div className="flex items-center gap-2.5 mt-2.5">
                    <span className={`font-johnson-text text-[11px] tabular-nums ${attachmentBytes > maxBytes ? 'text-jj-red' : 'text-jj-gray-05'}`}>
                      {formatBytes(attachmentBytes)} of {config?.max_attachment_mb ?? 10} MB
                    </span>
                    <span className="flex-1 h-1 rounded-full bg-jj-gray-01 overflow-hidden" aria-hidden="true">
                      <span className="block h-full rounded-full transition-[width] duration-500"
                            style={{
                              width: `${Math.min(100, (attachmentBytes / maxBytes) * 100)}%`,
                              background: attachmentBytes > maxBytes * 0.9 ? '#eb1700'
                                : attachmentBytes > maxBytes * 0.7 ? '#ff6017' : '#328714',
                            }} />
                    </span>
                  </div>
                  {config && !config.store_attachments && attachments.length > 0 && (
                    <p className={`${CLS.hint} mt-2`}>
                      Attachment storage is switched off on this server, so these files cannot be re-sent later and a
                      queued send would go out without them.
                    </p>
                  )}
                </section>
              </div>

              {/* Send dock */}
              <footer className="flex-none sticky bottom-4 z-20 mx-5 mb-4 px-3 py-2.5 rounded-[18px] bg-white/90 backdrop-blur-md border border-jj-gray-02
                                 shadow-[0_24px_50px_-24px_rgba(49,44,42,0.45)] flex items-center gap-2.5 flex-wrap">
                <div className="cc-ready relative flex items-center gap-3 flex-1 min-w-[190px]" tabIndex={0}
                     aria-label={ready ? 'Ready to send' : `Not ready: ${blockers[0]}`}>
                  <span className="relative w-[38px] h-[38px] flex-none">
                    <svg width="38" height="38" className="-rotate-90" aria-hidden="true">
                      <circle cx="19" cy="19" r="16" fill="none" stroke="#e8e6e3" strokeWidth="3" />
                      <circle cx="19" cy="19" r="16" fill="none" strokeWidth="3" strokeLinecap="round"
                              className="cc-ring-val" stroke={ready ? '#328714' : '#a39992'}
                              strokeDasharray="100.5" strokeDashoffset={100.5 * (1 - (ready ? 1 : passed / checks.length))} />
                    </svg>
                    <span className="absolute inset-0 flex items-center justify-center font-johnson-display text-[11px]">
                      {ready ? <span className="cc-pop text-jj-green-03">✓</span> : `${passed}/${checks.length}`}
                    </span>
                  </span>
                  <span className="min-w-0">
                    <span className={`block font-johnson-text text-[13px] font-medium transition-colors ${ready ? 'text-jj-green-03' : 'text-jj-gray-06'}`}>
                      {ready ? (sendAt ? 'Ready to schedule' : 'Ready to send') : 'Not ready yet'}
                    </span>
                    <span className={`block ${CLS.hint} truncate`}>{readyHint}</span>
                  </span>
                  <div className="cc-checks absolute bottom-full left-0 mb-4 w-[300px] p-3 bg-white rounded-2xl border border-jj-gray-02
                                  shadow-[0_24px_50px_-20px_rgba(49,44,42,0.4)] z-40">
                    <div className="mb-2 font-johnson-text text-[9.5px] tracking-[0.2em] uppercase text-jj-gray-05">Pre-flight</div>
                    <ul className="flex flex-col gap-1">
                      {checks.map((c) => (
                        <li key={c.label} className={`flex items-center gap-2 font-johnson-text text-[12px] ${c.ok ? 'text-jj-gray-08' : 'text-jj-gray-06'}`}>
                          <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] flex-none ${
                            c.ok ? 'bg-jj-green-03 text-white' : 'bg-jj-gray-01 text-jj-gray-05'}`}>{c.ok ? '✓' : ''}</span>
                          {c.label}
                        </li>
                      ))}
                    </ul>
                    {blockers.length > 0 && (
                      <div className="mt-2.5 pt-2.5 border-t border-jj-gray-01">
                        {blockers.map((b) => (
                          <p key={b} className="font-johnson-text text-[11.5px] text-jj-maroon-05 leading-relaxed">· {b}</p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <SchedulePicker value={sendAt} min={earliestSend} max={latestSend} onChange={setSendAt} />

                {sensitivityTree.length > 0 && (
                  <SensitivityPicker tree={sensitivityTree} value={sensitivity} onChange={setSensitivity} />
                )}

                <button type="button" onClick={sendTest} disabled={sending} title={`Send a test to ${user?.email || 'yourself'}`}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-[11px] border border-jj-gray-02 bg-white font-johnson-text
                                   text-[12px] text-jj-gray-07 hover:border-jj-gray-04 hover:text-jj-gray-08 disabled:opacity-50">
                  <Glyph src={personIcon} size={13} />Test
                </button>
                <button
                  ref={sendButton}
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={!ready || sending}
                  className={`cc-send ${ready && !sending ? 'go' : ''} flex items-center gap-2 px-5 py-2.5 rounded-xl bg-jj-red
                              text-white font-johnson-display font-bold text-[13.5px] tracking-[0.02em] transition-[transform,background-color] duration-300
                              hover:-translate-y-0.5 disabled:bg-jj-red/30 disabled:translate-y-0`}
                >
                  <span className="cc-shine" aria-hidden="true" />
                  {sending ? 'Sending…' : sendAt ? 'Schedule' : (tally.total > 0 ? `Send to ${tally.total.toLocaleString()}` : 'Send')}
                  <Glyph src={chevronIcon} size={12} />
                </button>
              </footer>
            </>
          )}

          {isHistory && (
            <div className="flex-1 overflow-auto p-5">
              <div className="flex items-center gap-3 mb-3.5">
                <h2 className="font-johnson-display font-medium text-[22px] tracking-[-0.02em]">Sent history</h2>
                <div className="ml-auto flex items-center gap-2">
                  <button type="button" onClick={exportHistory} disabled={!historyTotal || exporting}
                          title="Download everything matching these filters"
                          className="px-2.5 py-1.5 rounded-[9px] border border-jj-gray-02 bg-white font-johnson-text text-[11.5px]
                                     text-jj-gray-07 hover:border-jj-gray-04 disabled:opacity-40">
                    {exporting ? 'Exporting…' : 'Export CSV'}
                  </button>
                  <button type="button" onClick={() => loadHistory(historyOffset, historySearch, historyStatus, historyCategory)}
                          title="Refresh" aria-label="Refresh"
                          className="w-[31px] h-[31px] border border-jj-gray-02 bg-white rounded-[9px] flex items-center justify-center
                                     hover:border-jj-gray-04">
                    <Icon src={refreshIcon} className={`w-3.5 h-3.5 ${historyLoading ? 'animate-spin' : ''}`} tone="gray" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-3.5">
                {[['all', 'Messages', '#312c2a'], ['sent', 'Delivered', '#328714'],
                  ['failed', 'Failed', '#9e0000'], ['test', 'Tests', '#6e6259']].map(([id, label, color], i) => (
                  <button key={id} type="button" onClick={() => setHistoryStatus(id)} aria-pressed={historyStatus === id}
                          className={`cc-rise text-left px-4 py-3 rounded-2xl bg-white border transition-colors ${
                            historyStatus === id ? 'border-jj-gray-04' : 'border-jj-gray-02 hover:border-jj-gray-03'}`}
                          style={{ animationDelay: `${i * 0.04}s` }}>
                    <span className="font-johnson-text text-[9.5px] tracking-[0.2em] uppercase text-jj-gray-06">{label}</span>
                    <b className="block mt-1.5 font-johnson-display font-medium text-[24px] tabular-nums" style={{ color }}>
                      {(historyCounts[id] ?? 0).toLocaleString()}
                    </b>
                  </button>
                ))}
              </div>

              <div className={`${CLS.card} overflow-hidden`}>
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-jj-gray-02">
                  <span className="font-johnson-text text-[12px] text-jj-gray-05">{plural(historyTotal, 'message')}</span>
                </div>
                {historyLoading && entries.length === 0 ? (
                  <div role="status" aria-label="Loading sent history">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-3.5 border-t border-jj-gray-01">
                        <span className="cc-skel w-[34px] h-[34px] rounded-[10px]" />
                        <span className="flex-1"><span className="cc-skel block h-3 w-3/5 rounded" /><span className="cc-skel block h-2.5 w-2/5 rounded mt-2" /></span>
                      </div>
                    ))}
                  </div>
                ) : entries.length === 0 ? (
                  <div className="p-12 flex flex-col items-center text-center">
                    <span className="cc-empty-orb mb-3 text-jj-red"><Glyph src={mailIcon} size={28} /></span>
                    <p className="font-johnson-text text-[13px] text-jj-gray-06">
                      {historySearch || historyStatus !== 'all' || historyCategory ? 'Nothing matches those filters.' : 'No emails have been sent yet.'}
                    </p>
                  </div>
                ) : (
                  <div className={historyLoading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
                    {entries.map((entry, i) => {
                      const meta = categories.find((c) => c.id === entry.category);
                      const color = meta?.color || '#a39992';
                      const active = detail?.id === entry.id;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() => openDetail(entry.id)}
                          aria-current={active ? 'true' : undefined}
                          className="cc-rise flex items-center gap-3 w-full px-4 py-3 border-t border-jj-gray-01 text-left transition-colors hover:bg-[#fbfaf8]"
                          style={{
                            animationDelay: `${Math.min(i, 12) * 0.025}s`,
                            ...(active ? { background: tint(color, 0.04), boxShadow: `inset 3px 0 0 ${color}` } : {}),
                          }}
                        >
                          <span className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center flex-none"
                                style={{ background: tint(color, 0.1), color }}>
                            <Glyph src={CATEGORY_ICON[entry.category] || mailIcon} size={15} />
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block font-johnson-text text-[13.5px] text-jj-gray-08 truncate">
                              {entry.subject}
                              {entry.is_test === 1 && <span className="ml-2 px-1.5 py-0.5 rounded bg-jj-gray-02 text-jj-gray-07 text-[10.5px]">test</span>}
                              {entry.scheduled_id ? <span className="ml-2 px-1.5 py-0.5 rounded bg-jj-gray-02 text-jj-gray-07 text-[10.5px]">scheduled</span> : null}
                              {entry.resent_from ? <span className="ml-2 px-1.5 py-0.5 rounded bg-jj-gray-02 text-jj-gray-07 text-[10.5px]">resend</span> : null}
                            </span>
                            <span className="block font-johnson-text text-[11.5px] text-jj-gray-05 mt-0.5 truncate">
                              {formatTimestamp(entry.sent_at)} · {entry.sent_by}
                            </span>
                          </span>
                          <span className="flex items-center gap-1 font-johnson-text text-[12px] text-jj-gray-07 tabular-nums whitespace-nowrap">
                            <Glyph src={communityIcon} size={12} className="text-jj-gray-05" />{entry.recipient_count}
                          </span>
                          <span className={`px-2 py-0.5 rounded-full font-johnson-text text-[10.5px] font-medium whitespace-nowrap ${
                            entry.status === 'sent' ? 'bg-jj-green-01/25 text-jj-green-03' : 'bg-jj-red/[0.07] text-jj-maroon-05'}`}>
                            {entry.status}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {historyTotal > LIMIT && (
                  <div className="flex items-center justify-between px-4 py-3 border-t border-jj-gray-02">
                    <button type="button" onClick={() => loadHistory(Math.max(0, historyOffset - LIMIT), historySearch, historyStatus, historyCategory)}
                            disabled={historyOffset === 0 || historyLoading}
                            className="px-3 py-1.5 rounded-lg border border-jj-gray-03 font-johnson-text text-[12.5px] disabled:opacity-40">
                      Previous
                    </button>
                    <span className="font-johnson-text text-[12px] text-jj-gray-06 tabular-nums">
                      {historyOffset + 1}–{Math.min(historyOffset + LIMIT, historyTotal)} of {historyTotal}
                    </span>
                    <button type="button" onClick={() => loadHistory(historyOffset + LIMIT, historySearch, historyStatus, historyCategory)}
                            disabled={historyOffset + LIMIT >= historyTotal || historyLoading}
                            className="px-3 py-1.5 rounded-lg border border-jj-gray-03 font-johnson-text text-[12.5px] disabled:opacity-40">
                      Next
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {isQueue && (
            <div className="flex-1 overflow-auto p-5">
              <div className="flex items-center gap-3 mb-4">
                <h2 className="font-johnson-display font-medium text-[22px] tracking-[-0.02em]">Scheduled sends</h2>
                <span className="ml-auto font-johnson-text text-[12px] text-jj-gray-05">{plural(queue.length, 'message')}</span>
                <button type="button" onClick={() => loadQueue(queueStatus)} title="Refresh" aria-label="Refresh"
                        className="w-[31px] h-[31px] border border-jj-gray-02 bg-white rounded-[9px] flex items-center justify-center
                                   hover:border-jj-gray-04">
                  <Icon src={refreshIcon} className={`w-3.5 h-3.5 ${queueLoading ? 'animate-spin' : ''}`} tone="gray" />
                </button>
              </div>

              {queueLoading && queue.length === 0 ? (
                <div className="flex flex-col gap-3" role="status" aria-label="Loading the queue">
                  {[0, 1, 2].map((i) => <div key={i} className="cc-skel h-[112px] rounded-2xl" />)}
                </div>
              ) : queueError && queue.length === 0 ? (
                <div className="p-12 flex flex-col items-center text-center gap-3">
                  <p className="font-johnson-text text-[13px] text-jj-maroon-05">The queue could not be loaded.</p>
                  <button type="button" onClick={() => loadQueue(queueStatus)} className={CLS.ghostBtn}>Try again</button>
                </div>
              ) : queue.length === 0 ? (
                <div className="p-12 flex flex-col items-center text-center">
                  <span className="cc-empty-orb mb-3 text-jj-blue-03"><Glyph src={calendarIcon} size={26} /></span>
                  <p className="font-johnson-text text-[13px] text-jj-gray-06">
                    {queueStatus === 'pending' ? 'Nothing is waiting to go out.' : 'Nothing here.'}
                  </p>
                  <button type="button" onClick={() => changeTab('compose')} className={`${CLS.chipBtn} mt-2.5`}>
                    Write a message and pick a send time
                  </button>
                </div>
              ) : (
                <div className={`cc-tl pl-7 ${queueLoading ? 'opacity-60' : ''}`}>
                  {queue.map((entry, i) => {
                    const meta = categories.find((c) => c.id === entry.category);
                    const color = meta?.color || '#a39992';
                    const active = queueDetail?.id === entry.id;
                    const tone = {
                      pending: 'bg-jj-blue-03/[0.09] text-jj-blue-03',
                      sending: 'bg-jj-blue-03/[0.09] text-jj-blue-03',
                      sent: 'bg-jj-green-01/25 text-jj-green-03',
                      failed: 'bg-jj-red/[0.07] text-jj-maroon-05',
                      cancelled: 'bg-jj-gray-01 text-jj-gray-05',
                    }[entry.status] || 'bg-jj-gray-02 text-jj-gray-07';
                    return (
                      <div
                        key={entry.id}
                        className="cc-rise relative mb-3 rounded-2xl bg-white border transition-transform duration-300 hover:translate-x-0.5
                                   hover:shadow-[0_20px_40px_-28px_rgba(49,44,42,0.6)]"
                        style={{ animationDelay: `${Math.min(i, 10) * 0.05}s`, borderColor: active ? tint(color, 0.45) : '#e8e6e3' }}
                      >
                        <span className="absolute -left-[23px] top-5 w-3 h-3 rounded-full bg-white"
                              style={{ border: `3px solid ${color}`, boxShadow: '0 0 0 4px #f6f4f1' }} aria-hidden="true" />
                        <div className="flex items-start gap-3 p-4">
                          <button type="button" onClick={() => openQueueDetail(entry.id)} className="flex-1 min-w-0 text-left">
                            <span className="flex items-center gap-2.5">
                              <span className={`px-2 py-0.5 rounded-full font-johnson-text text-[10.5px] font-medium ${tone}`}>
                                {entry.status === 'pending' ? 'queued' : entry.status}
                              </span>
                              <b className="font-johnson-display font-medium text-[15px] truncate">{entry.subject}</b>
                            </span>
                            <span className="flex items-center gap-4 mt-3 flex-wrap">
                              {entry.status === 'pending' && <Countdown at={entry.send_at} />}
                              <span className="font-johnson-text text-[11.5px] text-jj-gray-06 leading-relaxed">
                                {formatTimestamp(entry.send_at)}
                                <br />
                                {plural(entry.recipient_count, 'recipient')}
                                {(entry.attachments || []).length ? ` · ${plural(entry.attachments.length, 'file')}` : ''}
                                {entry.error ? <span className="text-jj-maroon-05"> · {entry.error}</span> : null}
                              </span>
                            </span>
                          </button>
                          {entry.status === 'pending' && (
                            <button type="button" onClick={() => cancelScheduled(entry)} title="Cancel this send" className={CLS.chipBtn}>
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </main>

        {/* ── Preview ──
            The aside is only the backdrop; the sheet sits in a sticky column of
            its own height, so it stays in view however far the form scrolls. */}
        <aside className="cc-stage flex-1 min-w-[320px] p-5 border-l border-jj-gray-02">
          <div className="sticky flex flex-col gap-3.5" style={{ top: PREVIEW_TOP, height: PREVIEW_HEIGHT }}>
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className={`${CLS.railH} flex items-center gap-2`}>
                <span className="w-1.5 h-1.5 rounded-full bg-jj-red shadow-[0_0_8px_rgba(235,23,0,0.6)]" />
                {isCompose ? 'Live preview' : isWhatsNew ? 'Last draft' : (isQueue ? 'Queued message' : 'Sent message')}
              </span>
              {viewing && (
                <div className="ml-auto flex items-center gap-1.5">
                  {isHistory && (
                    <button type="button" onClick={() => resend(detail)} title="Send this same message again"
                            className="px-2.5 py-1 rounded-lg border border-jj-gray-03 bg-white font-johnson-text text-[11.5px]
                                       text-jj-gray-07 hover:border-jj-red">
                      {detail.status === 'failed' ? 'Try again' : 'Send again'}
                    </button>
                  )}
                  <button type="button" onClick={() => loadIntoCompose(viewing, { withFiles: isHistory })} disabled={drafting}
                          title="Copy this message into Compose"
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-jj-gray-03 bg-white
                                     font-johnson-text text-[11.5px] text-jj-gray-07 hover:border-jj-red disabled:opacity-50">
                    <Glyph src={editIcon} size={11} />{drafting ? 'Copying…' : 'Use as draft'}
                  </button>
                </div>
              )}
              <div className={`relative flex p-[3px] rounded-[10px] bg-white/60 border border-jj-gray-02 ${viewing ? '' : 'ml-auto'}`}
                   role="group" aria-label="Preview size">
                {[['desktop', 'Desktop'], ['mobile', 'Mobile']].map(([id, label]) => (
                  <button key={id} type="button" onClick={() => setDevice(id)} aria-pressed={device === id}
                          className={`px-3 py-1 rounded-[7px] font-johnson-text text-[11.5px] transition-all ${
                            device === id ? 'bg-white text-jj-gray-08 shadow-[0_1px_4px_rgba(49,44,42,0.12)]' : 'text-jj-gray-06'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {isCompose && previewError && (
              <div className="flex-none px-3 py-2 rounded-lg bg-jj-red/[0.06] border border-jj-red/20 font-johnson-text
                              text-[11.5px] text-jj-maroon-05" role="alert">
                {previewError}. Showing the last version that rendered.
              </div>
            )}

            <div className="flex-1 min-h-0 flex justify-center">
              <div key={device} className={`cc-device ${device === 'mobile' ? 'mobile' : ''} relative w-full h-full flex flex-col bg-white rounded-2xl
                              overflow-hidden shadow-[0_30px_60px_-30px_rgba(49,44,42,0.5),0_0_0_1px_rgba(49,44,42,0.06)]`}
                   style={{ maxWidth: device === 'mobile' ? 380 : 660 }}>
                <div className="cc-screen flex-1 min-h-0 flex flex-col bg-white overflow-hidden">
                  <div className={`flex items-center gap-1.5 px-3.5 border-b border-jj-gray-02 bg-[#fbfaf8] ${device === 'mobile' ? 'pt-3 pb-2.5 justify-center' : 'py-2.5'}`}>
                    {device === 'mobile'
                      ? <span className="w-[86px] h-[20px] rounded-xl bg-[#1d1a19]" aria-hidden="true" />
                      : ['#ff5f57', '#febc2e', '#28c840'].map((c) => <i key={c} className="w-2 h-2 rounded-full" style={{ background: c }} />)}
                  </div>
                  {(isCompose || viewing) && (
                    <div className="px-4 py-3 border-b border-jj-gray-02">
                      <div className="font-johnson-display font-medium text-[15px] leading-snug break-words">
                        {isCompose
                          ? (preview.subject || `${activeCategory?.prefix ? `${activeCategory.prefix} ` : ''}${subject || '(no subject)'}`)
                          : viewing.subject}
                      </div>
                      <div className="flex items-center gap-2.5 mt-2.5 font-johnson-text text-[11.5px] text-jj-gray-06 min-w-0">
                        <span className="w-[28px] h-[28px] rounded-full flex items-center justify-center flex-none text-white
                                         font-johnson-display font-bold text-[10.5px] bg-gradient-to-br from-jj-red to-jj-violet-03">SH</span>
                        <span className="min-w-0">
                          <b className="block font-medium text-jj-gray-08 text-[12px]">GRA SmartHub</b>
                          <span className="block truncate">{config?.sender || ''}</span>
                        </span>
                        {(isCompose ? sensitivityLabel : viewing.sensitivity_label) && (
                          <span className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-md bg-jj-gray-01 text-[10.5px] whitespace-nowrap">
                            <Glyph src={shieldIcon} size={10} />{isCompose ? sensitivityLabel : viewing.sensitivity_label}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="relative flex-1 min-h-0">
                    {((isCompose && previewBusy) || (!isCompose && detailLoading)) && <span className="cc-busy-bar" aria-hidden="true" />}
                    {!isCompose && detailLoading && !viewing ? (
                      <div className="h-full flex items-center justify-center" role="status">
                        <p className="font-johnson-text text-[13px] text-jj-gray-06">Opening…</p>
                      </div>
                    ) : (isCompose ? preview.html : viewing?.html) ? (
                      <iframe
                        title={isCompose ? 'Email preview' : 'Stored message'}
                        srcDoc={isCompose ? preview.html : viewing.html}
                        className={`w-full h-full bg-white transition-opacity ${isCompose && previewBusy ? 'opacity-70' : ''}`}
                        style={{ border: 0 }}
                        sandbox=""
                      />
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
                        <span className="cc-empty-orb text-jj-red"><Glyph src={mailIcon} size={28} /></span>
                        <p className="font-johnson-text text-[13px] text-jj-gray-06 leading-relaxed">
                          {isCompose
                            ? <>Start typing and the preview renders here,<br />exactly as it will be sent.</>
                            : isWhatsNew
                              ? <>Tick what shipped and press Draft announcement.<br />The email opens in Compose for review.</>
                              : <>Pick a message from the list<br />to see what {isQueue ? 'will go out' : 'was sent'}.</>}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex-none px-4 py-3 bg-white/85 border border-jj-gray-02 rounded-2xl">
              {isCompose ? (
                <div className="flex gap-5 font-johnson-text text-[11.5px] text-jj-gray-06">
                  <div>Recipients<b className="block font-johnson-display font-medium text-[14px] text-jj-gray-08 tabular-nums mt-0.5">{tally.total.toLocaleString()}</b></div>
                  <div>Words<b className="block font-johnson-display font-medium text-[14px] text-jj-gray-08 tabular-nums mt-0.5">{words.toLocaleString()}</b></div>
                  <div>Read time<b className="block font-johnson-display font-medium text-[14px] text-jj-gray-08 mt-0.5">{words ? `${Math.max(1, Math.round(words / 220))} min` : '0 min'}</b></div>
                  <div className="ml-auto text-right">Goes out<b className="block font-johnson-display font-medium text-[14px] text-jj-gray-08 mt-0.5">{sendAt ? scheduledLabel : 'Immediately'}</b></div>
                </div>
              ) : (
                <>
                  <div className="font-johnson-text text-[11px] text-jj-gray-05 mb-0.5">{isQueue ? 'Goes out' : 'Delivery'}</div>
                  <div className="font-johnson-text text-[13px] text-jj-gray-08 leading-snug break-words">
                    {isQueue && (queueDetail
                      ? `${formatTimestamp(queueDetail.send_at)} · ${plural(queueDetail.recipient_count, 'recipient')}`
                        + ` · ${queueDetail.status === 'pending' ? 'queued' : queueDetail.status}`
                        + (queueDetail.error ? ` (${queueDetail.error})` : '')
                      : 'Nothing selected')}
                    {isHistory && (detail
                      ? `${plural(detail.recipient_count, 'recipient')} · ${detail.status}${
                          detail.status === 'failed' && detail.error ? ` (${detail.error})` : ''}`
                      : 'Nothing selected')}
                    {isWhatsNew && 'Nothing selected'}
                  </div>
                  {viewing && (
                    <dl className="mt-2.5 pt-2.5 border-t border-jj-gray-01 flex flex-col gap-1.5 max-h-[140px] overflow-auto">
                      {viewingCategory && (
                        <div className="flex gap-2 font-johnson-text text-[12px]">
                          <dt className="w-9 flex-none text-jj-gray-05">Type</dt>
                          <dd className="flex-1 min-w-0 text-jj-gray-07 flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: viewingCategory.color }} />
                            {viewingCategory.label}
                          </dd>
                        </div>
                      )}
                      {[['To', viewing.to_addrs], ['Cc', viewing.cc_addrs], ['Bcc', viewing.bcc_addrs]]
                        .filter(([, value]) => hasText(value))
                        .map(([field, value]) => (
                          <div key={field} className="flex gap-2 font-johnson-text text-[12px]">
                            <dt className="w-9 flex-none text-jj-gray-05">{field}</dt>
                            <dd className="flex-1 min-w-0 text-jj-gray-07 break-words">{value}</dd>
                          </div>
                        ))}
                      {(viewing.attachments || []).length > 0 && (
                        <div className="flex gap-2 font-johnson-text text-[12px]">
                          <dt className="w-9 flex-none text-jj-gray-05">Files</dt>
                          <dd className="flex-1 min-w-0 text-jj-gray-07 flex flex-wrap gap-x-2 gap-y-1">
                            {viewing.attachments.map((file, index) => (
                              // Downloadable only where the bytes were kept; older
                              // rows recorded the name alone and still show it.
                              viewing.files_stored && isHistory ? (
                                <button key={`${file.filename}-${index}`} type="button"
                                        onClick={() => downloadAttachment(detail.id, index, file.filename)}
                                        className="underline decoration-jj-gray-04 underline-offset-2 hover:text-jj-red break-all">
                                  {file.filename}
                                </button>
                              ) : (
                                <span key={`${file.filename}-${index}`} className="break-all">{file.filename}</span>
                              )
                            ))}
                          </dd>
                        </div>
                      )}
                    </dl>
                  )}
                </>
              )}
            </div>
          </div>
        </aside>
      </div>

      {confirming && (
        <ConfirmSend
          summary={{
            ...tally,
            subject: preview.subject || subject,
            attachments: attachments.length,
            sendAt,
            sendAtLabel: scheduledLabel,
            sensitivityLabel,
          }}
          sending={sending}
          onCancel={() => setConfirming(false)}
          onConfirm={sendForReal}
        />
      )}

      {aiMode && (
        <AIDraftModal
          key={aiMode}
          mode={aiMode}
          category={category}
          subject={subject}
          body={body}
          noteIds={noteIds}
          onClose={() => setAiMode(null)}
          onApply={applyDraft}
        />
      )}

      {picking && (
        <RecipientPicker
          allowedDomains={config?.allowed_domains || []}
          onClose={() => setPicking(false)}
          onAdd={addRecipients}
        />
      )}

      {ask && (
        <PromptModal
          title={ask.title}
          subtitle={ask.subtitle}
          label={ask.label}
          placeholder={ask.placeholder}
          defaultValue={ask.defaultValue || ''}
          confirmLabel={ask.confirmLabel}
          busy={working}
          onCancel={() => setAsk(null)}
          onConfirm={(value) => runChecked(() => ask.onConfirm(value))}
        />
      )}

      {check && (
        <ConfirmModal
          title={check.title}
          subtitle={check.subtitle}
          confirmLabel={check.confirmLabel}
          tone={check.tone}
          busy={working}
          onCancel={() => setCheck(null)}
          onConfirm={() => runChecked(check.onConfirm)}
        />
      )}
    </div>
  );
};

export default CommunicationCenter;