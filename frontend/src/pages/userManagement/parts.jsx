import React, { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import closeIcon from '/icons/JJ_Icon_Close.svg';
import checkIcon from '/icons/JJ_Icon_Check_RGB.svg';
import alertIcon from '/icons/JJ_Icon_Alert_RGB.svg';
import filterIcon from '/icons/JJ_Icon_Filter.svg';
import chevronDownIcon from '/icons/JJ_Icon_Chevron_Down.svg';
import { PERMISSION_GROUPS, TOTAL_PERMISSIONS, avatarPair, groupState, initialsOf, layerStack } from './access';

// Icons are flat black SVGs, painted through a mask so they take any colour.
export const Ico = ({ src, className = '', style }) => (
  <span className={`um-ico ${className}`} style={{ '--i': `url("${src}")`, ...style }} aria-hidden="true" />
);

export const Avatar = ({ name, photo, size = 'md', title }) => {
  const [a1, a2] = avatarPair(name);
  return (
    <span className={`um-av um-av-${size}`} style={{ '--a1': a1, '--a2': a2 }} title={title}>
      {photo ? <img src={photo} alt="" loading="lazy" /> : initialsOf(name)}
    </span>
  );
};

// role: { name, color } — null renders the "no role" state
export const RoleBadge = ({ role, solid = false, note, muted = false }) => {
  if (!role) return <span className="um-badge um-none"><i />No role assigned</span>;
  return (
    <span className={`um-badge ${solid ? 'um-solid' : ''} ${muted ? 'um-muted' : ''}`} style={{ '--c': role.color || '#a39992' }}>
      <i />{role.name}{note ? <small>{note}</small> : null}
    </span>
  );
};

// Several roles side by side: the first two, then "+N" (hover lists them all)
export const RoleBadges = ({ badges = [], muted = false, max = 2 }) => {
  if (badges.length <= 1) {
    const b = badges[0];
    return <RoleBadge role={b?.role || null} note={b?.note} muted={muted || !!b?.note} />;
  }
  const shown = badges.slice(0, max);
  const rest = badges.length - shown.length;
  const all = badges.map((b) => `${b.role?.name}${b.note ? ` (${b.note})` : ''}`).join(', ');
  return (
    <span className="um-badges" title={all}>
      {shown.map((b, i) => <RoleBadge key={`${b.role?.name}-${i}`} role={b.role} note={b.note} muted={muted || !!b.note} />)}
      {rest > 0 ? <span className="um-badge um-badge-more">+{rest}</span> : null}
    </span>
  );
};

export const CustomChip = ({ counts }) => {
  if (!counts || (!counts.add && !counts.remove)) return null;
  return (
    <span className="um-cust" title="Custom access on top of the role">
      {counts.add ? <b className="um-a">+{counts.add}</b> : null}
      {counts.remove ? <b className="um-r">−{counts.remove}</b> : null}
    </span>
  );
};

// Visual switch. Inside a clickable row it's decorative (the row handles the
// click); standalone, pass onClick and it becomes a real button.
export const Switch = ({ on, disabled = false, small = false, onClick, label }) => {
  const cls = `um-switch ${on ? 'um-on' : ''} ${small ? 'um-sm' : ''} ${disabled ? 'um-disabled' : ''}`;
  if (!onClick) return <span className={cls} aria-hidden="true" />;
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label} className={cls} disabled={disabled} onClick={onClick} />
  );
};

// Small pill switcher (Cards / Matrix ...). The pill is measured off the
// active button, so labels of any length line up.
export const Segmented = ({ options, value, onChange, label }) => {
  const ref = useRef(null);
  const [pill, setPill] = useState(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const btn = el.querySelector(`[data-id="${value}"]`);
      if (btn) setPill({ left: btn.offsetLeft, width: btn.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value]);
  return (
    <div ref={ref} className="um-seg um-mini" role="radiogroup" aria-label={label}>
      <span className="um-pill" style={pill ? { width: pill.width, transform: `translateX(${pill.left}px)` } : { opacity: 0 }} />
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} data-id={o.id} className={value === o.id ? 'um-on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
};

// Ring showing how many of all permissions a role or person has. Fills in on
// mount (a CSS transition from empty) rather than appearing full.
export const Gauge = ({ on, color, size = 54 }) => {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(on));
    return () => cancelAnimationFrame(id);
  }, [on]);
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <div className="um-gauge" style={{ '--c': color, width: size, height: size }}>
      <svg viewBox="0 0 54 54" aria-hidden="true">
        <circle className="um-bg" cx="27" cy="27" r={r} />
        <circle className="um-fg" cx="27" cy="27" r={r} strokeDasharray={c.toFixed(1)} strokeDashoffset={(c * (1 - shown / TOTAL_PERMISSIONS)).toFixed(1)} />
      </svg>
      <b>{on}</b>
    </div>
  );
};

// One segment per feature: full, partial or none
export const FeatureBars = ({ perms }) => (
  <div className="um-bars" aria-hidden="true">
    {PERMISSION_GROUPS.map((g) => {
      const s = groupState(perms, g.key);
      return <i key={g.key} className={s === 'full' ? 'um-f' : s === 'partial' ? 'um-p' : ''} title={g.label} />;
    })}
  </div>
);

export const Cell = ({ state, color, extra = '', ...rest }) => (
  <span className={`um-cell ${state === 'full' ? 'um-f' : state === 'partial' ? 'um-p' : ''} ${extra}`} style={{ '--c': color }} {...rest} />
);

// ─── Layers (modals, drawer, confirm) ────────────────────────────────────────
// Escape closes only the top-most layer, so a confirm on top of a modal
// doesn't take the modal down with it.
const useLayer = (onClose) => {
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    const id = Symbol('layer');
    layerStack.push(id);
    const onKey = (e) => {
      if (e.key === 'Escape' && layerStack[layerStack.length - 1] === id) {
        e.stopPropagation();
        closeRef.current?.();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const at = layerStack.indexOf(id);
      if (at > -1) layerStack.splice(at, 1);
    };
  }, []);
};

// Keep keyboard focus inside the open layer and hand it back on close.
const useFocusTrap = (ref) => {
  useEffect(() => {
    const previous = document.activeElement;
    const node = ref.current;
    if (!node) return undefined;
    const focusable = () => [...node.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')];
    const first = node.querySelector('[data-autofocus]') || focusable()[0];
    first?.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const [head, tail] = [items[0], items[items.length - 1]];
      if (e.shiftKey && document.activeElement === head) { e.preventDefault(); tail.focus(); }
      else if (!e.shiftKey && document.activeElement === tail) { e.preventDefault(); head.focus(); }
    };
    node.addEventListener('keydown', onKey);
    return () => {
      node.removeEventListener('keydown', onKey);
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [ref]);
};

export const Modal = ({ onClose, wide = false, className = '', label, style, children }) => {
  const ref = useRef(null);
  useLayer(onClose);
  useFocusTrap(ref);
  return ReactDOM.createPortal(
    <div className="um-layer">
      <div className="um-scrim" onClick={onClose} />
      <div className="um-modal-host">
        <div ref={ref} className={`um-modal ${wide ? 'um-wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={label} style={style}>
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
};

export const ModalHead = ({ lead, title, sub, onClose }) => (
  <div className="um-mhead">
    {lead}
    <div className="um-mhead-t"><h3>{title}</h3>{sub ? <p>{sub}</p> : null}</div>
    <button type="button" className="um-iconbtn" onClick={onClose} aria-label="Close"><Ico src={closeIcon} /></button>
  </div>
);

export const Drawer = ({ onClose, color, label, children }) => {
  const ref = useRef(null);
  useLayer(onClose);
  useFocusTrap(ref);
  return ReactDOM.createPortal(
    <div className="um-layer">
      <div className="um-scrim" onClick={onClose} />
      <aside ref={ref} className="um-drawer" style={{ '--c': color }} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </aside>
    </div>,
    document.body
  );
};

export const ConfirmDialog = ({ title, message, confirmLabel, busy, onConfirm, onCancel }) => {
  const ref = useRef(null);
  useLayer(busy ? null : onCancel);
  useFocusTrap(ref);
  return ReactDOM.createPortal(
    <div className="um-layer um-layer-top">
      <div className="um-scrim" onClick={busy ? undefined : onCancel} />
      <div className="um-modal-host">
        <div ref={ref} className="um-modal um-confirm" role="alertdialog" aria-modal="true" aria-label={title}>
          <div className="um-cico"><Ico src={alertIcon} /></div>
          <h3>{title}</h3>
          <p>{message}</p>
          <div className="um-cbtns">
            <button type="button" className="um-btn um-btn-ghost um-btn-sm" onClick={onCancel} disabled={busy}>Keep it</button>
            <button type="button" className="um-btn um-btn-primary um-btn-sm" onClick={onConfirm} disabled={busy} data-autofocus>
              {busy ? <span className="um-spin" /> : null}{confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export const Toasts = ({ toasts }) => ReactDOM.createPortal(
  <div className="um-toasts" role="status" aria-live="polite">
    {toasts.map((t) => (
      <div key={t.id} className={`um-toast ${t.type === 'error' ? 'um-err' : ''} ${t.leaving ? 'um-bye' : ''}`}>
        <span className="um-ti"><Ico src={t.type === 'error' ? alertIcon : checkIcon} /></span>
        <span>{t.message}</span>
      </div>
    ))}
  </div>,
  document.body
);

export const EmptyState = ({ icon, title, text, children }) => (
  <div className="um-empty">
    <div className="um-eart"><span><Ico src={icon} /></span></div>
    <b>{title}</b>
    {text ? <small>{text}</small> : null}
    {children}
  </div>
);

// Search box that keeps its own keystrokes and reports the settled value, so
// typing never re-renders the page around it. `value` is the settled search
// from outside (the URL); when that changes by itself (back button, a shared
// link) the box follows it.
export const SearchField = forwardRef(function SearchField({ value: outside = '', onSettled, delay = 350, icon, placeholder, hint }, ref) {
  const [value, setValue] = useState(outside);
  const sent = useRef(outside);
  const settled = useRef(onSettled);
  useLayoutEffect(() => { settled.current = onSettled; });
  useEffect(() => {
    if (outside === sent.current) return;
    sent.current = outside;
    setValue(outside);
  }, [outside]);
  useEffect(() => {
    const t = setTimeout(() => {
      const next = value.trim();
      if (next === sent.current) return;
      sent.current = next;
      settled.current(next);
    }, delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return (
    <label className="um-search">
      <Ico src={icon} />
      <input ref={ref} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} autoComplete="off" />
      {hint ? <span className="um-kbd">{hint}</span> : null}
    </label>
  );
});

export const Spinner = () => <span className="um-spin" aria-label="Loading" />;

// Role filter: one button next to "Assigned only". It opens a menu where any
// number of roles can be ticked (Select all / Deselect all at the top); the
// menu stays open while ticking. With roles picked the button shows them,
// with an × to clear. Arrow keys move, Enter or Space ticks, Escape closes.
// A search box appears when there are lots of roles.
export function RoleFilter({ roleIds, roles, counts, value = [], onChange }) {
  const wrapRef = useRef(null);
  const listRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const picked = value.filter((id) => roles[id]);

  // Roles people actually hold first, then the rest, each A-Z
  const ordered = useMemo(() => [...roleIds].sort((a, b) => ((counts[b] || 0) > 0) - ((counts[a] || 0) > 0)
    || String(roles[a]?.name || a).localeCompare(String(roles[b]?.name || b))), [roleIds, roles, counts]);
  const q = query.trim().toLowerCase();
  const items = ordered.filter((id) => !q || String(roles[id]?.name || id).toLowerCase().includes(q));
  const allPicked = ordered.length > 0 && picked.length === ordered.length;

  const close = () => { setOpen(false); setQuery(''); };
  const toggleRole = (id) => onChange(picked.includes(id) ? picked.filter((r) => r !== id) : ordered.filter((r) => r === id || picked.includes(r)));
  // With a search typed, select/deselect all applies to what's listed
  const selectAll = () => onChange(q ? ordered.filter((r) => picked.includes(r) || items.includes(r)) : ordered);
  const deselectAll = () => onChange(q ? picked.filter((r) => !items.includes(r)) : []);

  // Click anywhere else closes it
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) close(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the highlighted row in view
  useEffect(() => {
    if (open) listRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [open, cursor]);

  const onKey = (e) => {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(items.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if ((e.key === 'Enter' || (e.key === ' ' && e.target.tagName !== 'INPUT')) && items[cursor]) { e.preventDefault(); toggleRole(items[cursor]); }
  };

  const one = picked.length === 1 ? roles[picked[0]] : null;
  const label = !picked.length ? 'Filter by role'
    : one ? one.name || picked[0]
      : allPicked ? 'All roles' : `${picked.length} roles`;
  const total = picked.reduce((n, id) => n + (counts[id] || 0), 0);

  return (
    <div ref={wrapRef} className="um-rfilter" onKeyDown={onKey}>
      <button
        type="button"
        className={`um-toggle um-rfbtn ${picked.length ? 'um-on' : ''} ${open ? 'um-open' : ''}`}
        style={picked.length ? { '--c': one ? one.color || '#a39992' : '#312c2a' } : undefined}
        onClick={() => (open ? close() : (setCursor(0), setOpen(true)))}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={picked.length > 1 ? picked.map((id) => roles[id].name || id).join(', ') : undefined}
      >
        {picked.length ? (
          <span className="um-rfdots">
            {picked.slice(0, 3).map((id) => <i key={id} style={{ '--c': roles[id].color || '#a39992' }} />)}
          </span>
        ) : <Ico src={filterIcon} />}
        <span className="um-rfname">{label}</span>
        {picked.length ? <small>{total}</small> : null}
        <Ico src={chevronDownIcon} className="um-rfcaret" />
      </button>
      {picked.length ? (
        <button type="button" className="um-rfclear" onClick={() => onChange([])} aria-label="Clear role filter" title="Clear role filter">
          <Ico src={closeIcon} />
        </button>
      ) : null}
      {open ? (
        <div className="um-rfmenu">
          {ordered.length > 8 ? (
            <label className="um-search um-rfsearch">
              <input value={query} onChange={(e) => { setQuery(e.target.value); setCursor(0); }} placeholder="Find a role…" autoComplete="off" autoFocus />
            </label>
          ) : null}
          <div className="um-rfbar">
            <span>{picked.length ? `${picked.length} of ${ordered.length} picked` : 'Pick one or more'}</span>
            <button type="button" className="um-link" onClick={selectAll} disabled={!items.length || items.every((r) => picked.includes(r))}>Select all</button>
            <button type="button" className="um-link" onClick={deselectAll} disabled={!items.some((r) => picked.includes(r))}>Deselect all</button>
          </div>
          <div ref={listRef} className="um-rflist" role="listbox" aria-label="Roles" aria-multiselectable="true">
            {items.map((id, k) => {
              const on = picked.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`um-rfitem ${k === cursor ? 'um-rf-hi' : ''} ${on ? 'um-rf-on' : ''}`}
                  style={{ '--c': roles[id].color || '#a39992' }}
                  onMouseEnter={() => setCursor(k)}
                  onClick={() => toggleRole(id)}
                >
                  <span className="um-rfbox" aria-hidden="true" />
                  <i />
                  <span className="um-rftext">{roles[id].name || id}</span>
                  <small>{counts[id] || 0}</small>
                </button>
              );
            })}
            {!items.length ? <p className="um-rfempty">No role matches “{query}”</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}