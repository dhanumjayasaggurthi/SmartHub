import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAdGroupMembers } from '../../hooks/useAdGroupMembers';
import lockIcon from '/icons/JJ_Icon_Lock_black.svg';
import closeIcon from '/icons/JJ_Icon_Close.svg';
import personIcon from '/icons/JJ_Icon_Person_RGB.svg';
import gearIcon from '/icons/JJ_Icon_Gear_RGB.svg';
import trashIcon from '/icons/JJ_Icon_Delete_RGB.svg';
import infoIcon from '/icons/JJ_Icon_Info_RGB.svg';
import chevronRightIcon from '/icons/JJ_Icon_Chevron_Right.svg';
import searchIcon from '/icons/JJ_Icon_Search_RGB.svg';
import refreshIcon from '/icons/JJ_Icon_Refresh_RGB.svg';
import checkIcon from '/icons/JJ_Icon_Check_RGB.svg';
import shieldIcon from '/icons/JJ_Icon_Shield_RGB.svg';
import saveIcon from '/icons/JJ_Icon_Save_RGB.svg';
import communityIcon from '/icons/JJ_Icon_Community_RGB.svg';
import { ALL_KEYS, BUILTIN_ROLE_IDS, DEFAULT_ROLE, EMPTY_OVERRIDES, LABEL, PARENT, PERMISSION_GROUPS, ROLE_SWATCHES, TOTAL_PERMISSIONS, countOn, descendants, effectiveAccess, featuresOn, groupState, overrideCount, permissionSource, permsFrom, plural, setOverride, togglePermission } from './access';
import { Avatar, Cell, ConfirmDialog, CustomChip, Drawer, FeatureBars, Gauge, Ico, Modal, ModalHead, RoleBadge, RoleBadges, Spinner, Switch } from './parts';

// Closing the tab or refreshing with unsaved edits asks first.
const useLeaveWarning = (on) => {
  useEffect(() => {
    if (!on) return undefined;
    const onLeave = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [on]);
};

// "Discard changes?" before an editor with edits closes.
const DiscardDialog = ({ onDiscard, onKeep }) => (
  <ConfirmDialog
    title="Discard changes?"
    message="You have changes that aren’t saved yet. Closing now throws them away."
    confirmLabel="Discard"
    onConfirm={onDiscard}
    onCancel={onKeep}
  />
);

const SourceTag = ({ source }) => {
  if (source === 'add') return <span className="um-src um-a">Added</span>;
  if (source === 'remove') return <span className="um-src um-r">Removed</span>;
  return null;
};

// A blocked click (sub-permission whose parent is off) gets a short shake.
const shake = (el) => {
  if (!el) return;
  el.classList.remove('um-shaking');
  void el.offsetWidth; // restart the animation
  el.classList.add('um-shaking');
};

/*
 * Feature list on the left, the picked feature on the right.
 *   perms    - what to show as on/off (role permissions, or a person's effective access)
 *   sourceOf - optional key => 'add' | 'remove' | 'role', tags differences from the role
 *   onToggle - key => boolean (false when the click was blocked)
 *   onSetAll - (featureKey, on) => void, the "Turn all on/off" link
 */
export function PermissionEditor({ perms, sourceOf, onToggle, onSetAll, selected, onSelect, query, color, readOnly = false, canGrant }) {
  const detailRef = useRef(null);
  const q = query.trim().toLowerCase();

  const list = useMemo(() => PERMISSION_GROUPS.filter((g) => !q
    || g.label.toLowerCase().includes(q)
    || g.description.toLowerCase().includes(q)
    || descendants(g.key).some((k) => LABEL[k].toLowerCase().includes(q))), [q]);

  const current = list.find((g) => g.key === selected) || list[0] || null;
  const touched = (g) => !!sourceOf && [g.key, ...descendants(g.key)].some((k) => sourceOf(k) !== 'role');
  const hit = (key) => (q && LABEL[key].toLowerCase().includes(q) ? 'um-hit' : '');

  // Off, and the viewer doesn't hold it themselves, so they can't switch it on
  const noGrant = (key) => !!canGrant && perms[key] !== true && !canGrant(key);

  const toggle = (key, e) => {
    if (readOnly) return;
    if (noGrant(key) || onToggle(key) === false) shake(e.currentTarget);
  };

  const row = (node, level) => {
    const locked = !perms[PARENT[node.key]] || noGrant(node.key);
    const lockTip = !perms[PARENT[node.key]] ? `Needs ${LABEL[PARENT[node.key]]}` : 'You don’t have this yourself, so you can’t give it';
    return (
      <div
        key={node.key}
        role="button"
        tabIndex={locked || readOnly ? -1 : 0}
        aria-disabled={locked || readOnly}
        className={`um-pe-row ${level === 3 ? 'um-l3' : ''} ${locked ? 'um-locked' : ''} ${hit(node.key)}`}
        onClick={(e) => toggle(node.key, e)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(node.key, e); } }}
      >
        <div className="um-ptx" title={node.description}><b>{node.label}</b><small>{node.description}</small></div>
        {locked
          ? <span className="um-pe-need" title={lockTip}><Ico src={lockIcon} /></span>
          : <SourceTag source={sourceOf?.(node.key)} />}
        <Switch on={perms[node.key] === true} disabled={locked || readOnly} small />
      </div>
    );
  };

  const kids = current ? descendants(current.key) : [];
  const onKids = kids.filter((k) => perms[k] === true).length;
  const allOn = kids.length > 0 && onKids === kids.length;
  const featureOn = current ? perms[current.key] === true : false;

  return (
    <div className="um-pe" style={{ '--c': color }}>
      <nav className="um-pe-nav" aria-label="Features">
        {list.length ? list.map((g) => {
          const on = perms[g.key] === true;
          const sub = descendants(g.key);
          const note = !on ? 'No access' : sub.length ? `${sub.filter((k) => perms[k] === true).length} of ${sub.length} sub-features` : 'On';
          return (
            <button
              key={g.key}
              type="button"
              className={`um-pe-item ${current?.key === g.key ? 'um-on' : ''} ${on ? 'um-has' : ''} ${touched(g) ? 'um-touched' : ''}`}
              onClick={() => { onSelect(g.key); if (detailRef.current) detailRef.current.scrollTop = 0; }}
            >
              <span className="um-pt"><Ico src={g.icon} /></span>
              <span className="um-pe-l"><b>{g.label}</b><small>{note}</small></span>
              <Cell state={groupState(perms, g.key)} color={color} />
            </button>
          );
        }) : <div className="um-pe-empty">Nothing matches “{query}”</div>}
      </nav>

      <section ref={detailRef} className="um-pe-detail">
        {current ? (
          <div key={current.key} className="um-pe-anim">
            <div className={`um-pe-head ${featureOn ? 'um-on' : ''} ${hit(current.key)}`}>
              <span className="um-tile"><Ico src={current.icon} /></span>
              <div className="um-pe-ht"><h3>{current.label}</h3><p>{current.description}</p></div>
              <SourceTag source={sourceOf?.(current.key)} />
              <span className="um-pe-state">{featureOn ? 'On' : 'Off'}</span>
              <Switch on={featureOn} disabled={readOnly || noGrant(current.key)} label={`Access to ${current.label}`} onClick={(e) => toggle(current.key, e)} />
            </div>

            {kids.length ? (
              <>
                <div className="um-pe-subh">
                  Sub-features <b>{onKids}/{kids.length}</b><hr />
                  {featureOn && !readOnly ? (
                    <button type="button" className="um-link" onClick={() => onSetAll(current.key, !allOn)}>
                      {allOn ? 'Turn all off' : 'Turn all on'}
                    </button>
                  ) : null}
                </div>
                {!featureOn ? (
                  <div className="um-pe-hint"><Ico src={lockIcon} /> Switch on {current.label} to choose its sub-features</div>
                ) : null}
                <div className="um-pe-list">
                  {current.children.map((child) => (
                    <div key={child.key} className="um-pe-grp">
                      {row(child, 2)}
                      {(child.children || []).map((gc) => row(gc, 3))}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="um-pe-empty">No sub-features here, it’s all or nothing.</div>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}

const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : null);

const Tick = ({ on, color }) => (on ? (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <circle cx="7" cy="7" r="7" fill={color} />
    <path d="M4 7.2l2 1.9 4-4.2" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
) : (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <circle cx="7" cy="7" r="6.2" fill="none" stroke="#d5cfc9" strokeWidth="1.4" />
  </svg>
));

/*
 * One person: who they are, where their access comes from, and exactly what
 * they can reach (role plus any custom access).
 */
export function UserDrawer({ person, role, badges, manualRoles = [], keepAd = true, adRoleName, source, adState = 'ok', overrides, access, canManageUsers, loadProfile, onAssign, onCustom, onRemove, onClose }) {
  const [profile, setProfile] = useState(null);
  const [profileState, setProfileState] = useState(person.id ? 'loading' : 'none');
  const [profileError, setProfileError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(() => new Set());

  useEffect(() => {
    if (!person.id) { setProfileState('none'); return undefined; }
    let cancelled = false;
    setProfileState('loading');
    loadProfile(person.id)
      .then((p) => { if (!cancelled) { setProfile(p); setProfileState('ready'); } })
      .catch((e) => { if (!cancelled) { setProfileError(e?.message || ''); setProfileState('error'); } });
    return () => { cancelled = true; };
  }, [person.id, loadProfile, attempt]);

  const color = role?.color || '#a39992';
  const on = countOn(access);
  const counts = overrideCount(overrides);
  const allOpen = open.size === PERMISSION_GROUPS.length;

  const toggle = (key) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const facts = [
    ['Department', profile?.department || person.department],
    ['City', profile?.city],
    ['Country', profile?.country],
  ];

  const fields = profile ? [
    ['Email', person.email],
    ['Job title', profile.jobTitle],
    ['Office', profile.officeLocation],
    ['Company', profile.companyName],
    ['Mobile', profile.mobilePhone],
    ['Business phone', profile.businessPhones?.[0]],
    ['Employee ID', profile.employeeId],
    ['Employee type', profile.employeeType],
    ['User type', profile.userType],
    ['Account', profile.accountEnabled == null ? null : profile.accountEnabled ? 'Enabled' : 'Disabled'],
    ['Created', formatDate(profile.createdDateTime)],
  ].filter(([, v]) => v) : [];

  const byHand = manualRoles.join(', ');
  const sourceNote = source === 'manual' && !keepAd
    ? `Given by hand: ${byHand}. Their AD group’s role is ignored.`
    : source === 'manual' && adState === 'ok'
      ? `Given by hand: ${byHand}${adRoleName ? `, plus ${adRoleName} from their AD group` : ', plus whatever their AD group gives (none right now)'}. They get everything each role gives.`
      : adState === 'pending'
      ? 'Checking their AD groups to work out their role…'
      : adState === 'unknown'
        ? 'Couldn’t check their AD groups, so their role isn’t known right now. Access below is hidden until it is.'
        : source === 'ad'
      ? `No manual role, so access comes from their AD group (${role?.name}).`
      : `No manual role and no mapped AD group, so they get the default role (${role?.name || 'No access'}).`;

  return (
    <Drawer onClose={onClose} color={color} label={`${person.name} details`}>
      <div className="um-dhero">
        <button type="button" className="um-iconbtn um-dclose" onClick={onClose} aria-label="Close"><Ico src={closeIcon} /></button>
        <div className="um-dphoto"><Avatar name={person.name} photo={person.photo} size="lg" /></div>
        <h3>{person.name}</h3>
        {person.jobTitle || profile?.jobTitle ? <div className="um-sub">{profile?.jobTitle || person.jobTitle}</div> : null}
        <div className="um-dbadges">
          {badges && badges.length > 1
            ? <RoleBadges badges={badges} muted={adState !== 'ok'} max={3} />
            : <RoleBadge role={role} solid={source === 'manual'} muted={adState !== 'ok'} note={adState !== 'ok' ? null : source === 'ad' ? 'via AD group' : source === 'default' ? 'default' : null} />}
          <CustomChip counts={counts} />
        </div>
        <div className="um-facts">
          {facts.map(([k, v]) => (
            <div key={k} className="um-fact">
              <small>{k}</small>
              {profileState === 'loading' && !v ? <span className="um-sk" /> : <b title={v || ''}>{v || '—'}</b>}
            </div>
          ))}
        </div>
      </div>

      <div className="um-dbody">
        <section className="um-dsec">
          <div className="um-dsec-h"><h4>Access coverage</h4><span><b>{on}</b> of {TOTAL_PERMISSIONS} permissions</span></div>
          <div className="um-cov" style={{ '--c': color }}>
            {PERMISSION_GROUPS.map((g) => {
              const keys = [g.key, ...descendants(g.key)];
              const n = keys.filter((k) => access[k]).length;
              return n ? <i key={g.key} style={{ flexGrow: n, opacity: 0.45 + (0.55 * n) / keys.length }} title={g.label} /> : null;
            })}
            {TOTAL_PERMISSIONS - on ? <span style={{ flexGrow: TOTAL_PERMISSIONS - on }} /> : null}
          </div>
        </section>

        <section className="um-dsec">
          <div className="um-dsec-h">
            <h4>What they can reach</h4>
            <button type="button" className="um-link" onClick={() => setOpen(allOpen ? new Set() : new Set(PERMISSION_GROUPS.map((g) => g.key)))}>
              {allOpen ? 'Collapse all' : 'Expand all'} <Ico src={chevronRightIcon} />
            </button>
          </div>
          {sourceNote ? <div className="um-note-box"><Ico src={infoIcon} /><span>{sourceNote}</span></div> : null}
          {counts.add || counts.remove ? (
            <div className="um-note-box"><Ico src={infoIcon} /><span>Custom access on top of {role?.name}: {counts.add} added, {counts.remove} removed.</span></div>
          ) : null}
          {PERMISSION_GROUPS.map((g) => {
            const keys = [g.key, ...descendants(g.key)];
            const n = keys.filter((k) => access[k]).length;
            const isOpen = open.has(g.key);
            const rows = [[g.key, 0], ...g.children.flatMap((c) => [[c.key, 1], ...(c.children || []).map((gc) => [gc.key, 2])])];
            return (
              <div key={g.key} className={`um-acc ${n ? 'um-has' : ''} ${isOpen ? 'um-open' : ''}`} style={{ '--c': color }}>
                <button type="button" className="um-acc-h" onClick={() => toggle(g.key)} aria-expanded={isOpen}>
                  <span className="um-pt"><Ico src={g.icon} /></span>
                  <b>{g.label}</b>
                  <small>{n}/{keys.length}</small>
                  <Ico src={chevronRightIcon} className="um-chev" />
                </button>
                <div className="um-acc-b">
                  <div>
                    <ul>
                      {rows.map(([k, depth]) => {
                        const src = permissionSource(overrides, k);
                        return (
                          <li key={k} className={access[k] ? '' : 'um-no'} style={{ paddingLeft: depth * 14 }}>
                            <Tick on={access[k]} color={color} />
                            {LABEL[k]}
                            {src === 'add' ? <span className="um-src um-a">Added</span> : src === 'remove' ? <span className="um-src um-r">Removed</span> : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              </div>
            );
          })}
        </section>

        <section className="um-dsec">
          <div className="um-dsec-h"><h4>Profile</h4><span>From Entra ID</span></div>
          {profileState === 'loading' ? (
            <div className="um-pinfo">{Array.from({ length: 6 }, (_, i) => <div key={i}><small>&nbsp;</small><div className="um-sk" /></div>)}</div>
          ) : profileState === 'error' ? (
            <div className="um-retry">
              <span>Couldn’t load the directory profile.{profileError ? ` ${profileError}` : ''}</span>
              <button type="button" className="um-link" onClick={() => setAttempt((n) => n + 1)}><Ico src={refreshIcon} /> Try again</button>
            </div>
          ) : profileState === 'none' ? (
            <div className="um-pinfo"><div><small>Email</small><b>{person.email}</b></div></div>
          ) : (
            <div className="um-pinfo">{fields.map(([k, v]) => <div key={k}><small>{k}</small><b>{v}</b></div>)}</div>
          )}
        </section>
      </div>

      <div className="um-dfoot">
        <button type="button" className="um-btn um-btn-primary" onClick={onAssign} disabled={!canManageUsers} title={canManageUsers ? undefined : 'Needs the Manage Users permission'}>
          <Ico src={personIcon} /> {source === 'manual' ? 'Change roles' : 'Assign roles'}
        </button>
        <button type="button" className="um-btn um-btn-ghost" onClick={onCustom} disabled={!canManageUsers || adState !== 'ok'} title={!canManageUsers ? 'Needs the Manage Users permission' : adState !== 'ok' ? 'Available once their role is known' : 'Give or take individual permissions'}>
          <Ico src={gearIcon} /> Custom access
        </button>
        {source === 'manual' ? (
          <button type="button" className="um-btn um-btn-danger um-btn-icon" onClick={onRemove} disabled={!canManageUsers} aria-label="Remove roles given by hand" title="Remove roles given by hand">
            <Ico src={trashIcon} />
          </button>
        ) : null}
      </div>
    </Drawer>
  );
}

// Order-free: the server and the page don't list keys in the same order
const sameList = (x = [], y = []) => x.length === y.length && x.every((k) => y.includes(k));
const sameOverrides = (a, b) => sameList(a?.add, b?.add) && sameList(a?.remove, b?.remove);

/*
 * One person's custom access on top of their role. Works on a draft; nothing
 * is saved until "Save access".
 */
export function UserAccessEditor({ person, role, roleNote, initialOverrides, canGrant, onSave, onClose }) {
  const rolePerms = useMemo(() => role?.permissions || {}, [role]);
  const start = initialOverrides || EMPTY_OVERRIDES;
  const [draft, setDraft] = useState(start);
  const [selected, setSelected] = useState(() => {
    const eff = effectiveAccess(rolePerms, start);
    return (PERMISSION_GROUPS.find((g) => g.children.length && eff[g.key]) || PERMISSION_GROUPS[1]).key;
  });
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const eff = useMemo(() => effectiveAccess(rolePerms, draft), [rolePerms, draft]);
  const counts = overrideCount(draft);
  const dirty = !sameOverrides(draft, start);

  const toggle = (key) => {
    const res = setOverride(rolePerms, draft, key, !eff[key]);
    if (!res.ok) return false;
    setDraft(res.overrides);
    return true;
  };

  const setAll = (featureKey, on) => {
    // descendants() is parent-first, so each child's parent is settled before it
    let next = draft;
    descendants(featureKey).forEach((k) => {
      if (on && canGrant && !canGrant(k) && !effectiveAccess(rolePerms, next)[k]) return;
      const res = setOverride(rolePerms, next, k, on);
      if (res.ok) next = res.overrides;
    });
    setDraft(next);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await onSave(draft);
    } catch (e) {
      setError(e.message || 'Could not save custom access');
      setSaving(false);
    }
  };

  const [asking, setAsking] = useState(false);
  useLeaveWarning(dirty && !saving);

  // Nothing closes the editor while a save is in flight, and edits ask first
  const close = () => {
    if (saving) return;
    if (dirty) setAsking(true); else onClose();
  };

  return (
    <Modal onClose={close} wide className="um-editor-modal" label={`Custom access for ${person.name}`}>
      {asking ? <DiscardDialog onDiscard={onClose} onKeep={() => setAsking(false)} /> : null}
      <ModalHead
        lead={<Avatar name={person.name} photo={person.photo} />}
        title="Custom access"
        sub={<>{person.name} · built on <RoleBadge role={role} note={roleNote} /></>}
        onClose={close}
      />
      <div className="um-emain um-emain-full">
        <div className="um-ptools">
          <label className="um-search">
            <Ico src={searchIcon} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a permission…" autoComplete="off" data-autofocus />
          </label>
          <button type="button" className="um-btn um-btn-ghost um-btn-sm" onClick={() => setDraft(EMPTY_OVERRIDES)} disabled={!counts.add && !counts.remove}>
            <Ico src={refreshIcon} /> Match role exactly
          </button>
          <div className="um-uasum">
            <span><b>{countOn(eff)}</b> of {TOTAL_PERMISSIONS}</span>
            {counts.add ? <span className="um-src um-a">+{counts.add} added</span> : null}
            {counts.remove ? <span className="um-src um-r">−{counts.remove} removed</span> : null}
            {!counts.add && !counts.remove ? <span className="um-src">Same as role</span> : null}
          </div>
        </div>
        <PermissionEditor
          perms={eff}
          canGrant={canGrant}
          sourceOf={(k) => permissionSource(draft, k)}
          onToggle={toggle}
          onSetAll={setAll}
          selected={selected}
          onSelect={setSelected}
          query={query}
          color={role?.color || '#a39992'}
        />
      </div>
      <div className="um-mfoot">
        <span className={`um-note ${error ? 'um-note-err' : ''}`}>
          {error || 'Only differences from the role are tagged. They stay even if the role changes.'}
        </span>
        <button type="button" className="um-btn um-btn-ghost um-btn-sm" onClick={close} disabled={saving}>Cancel</button>
        <button type="button" className="um-btn um-btn-primary um-btn-sm" onClick={save} disabled={saving || !dirty}>
          {saving ? <Spinner /> : <Ico src={checkIcon} />} Save access
        </button>
      </div>
    </Modal>
  );
}

const slugify = (name) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const uniqueId = (name, taken) => {
  if (!name.trim()) return '';
  // Names with no a-z or 0-9 (e.g. all accents or another script) still get an ID
  const base = (slugify(name) || 'role').slice(0, 56).replace(/_+$/, '');
  let id = base;
  for (let n = 1; taken[id]; n++) id = `${base}_${n}`;
  return id;
};

const firstPick = (perms) => (PERMISSION_GROUPS.find((g) => g.children.length && perms[g.key]) || PERMISSION_GROUPS[1]).key;

// Every known permission present, so missing keys on older roles read as off.
const normalise = (perms) => Object.fromEntries(ALL_KEYS.map((k) => [k, perms?.[k] === true]));

export function RoleEditor({ roleId, roles, canGrant: callerHas, onSave, onClose }) {
  const source = roleId ? roles[roleId] : null;
  // What the role already had can always go back on; anything new has to be
  // something the person editing holds
  const canGrant = callerHas ? (k) => callerHas(k) || source?.permissions?.[k] === true : null;
  const isBuiltin = !!roleId && BUILTIN_ROLE_IDS.includes(roleId);

  const [name, setName] = useState(source?.name || '');
  const [description, setDescription] = useState(source?.description || '');
  const [color, setColor] = useState(source?.color || '#0f68b2');
  const [perms, setPerms] = useState(() => (source ? normalise(source.permissions) : permsFrom(!callerHas || callerHas('viewDashboard') ? ['viewDashboard'] : [])));
  const [selected, setSelected] = useState(() => firstPick(source ? normalise(source.permissions) : {}));
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);

  // What the editor opened with, to tell whether anything changed
  const [initial] = useState(() => JSON.stringify([name, description, color, perms]));
  const dirty = JSON.stringify([name, description, color, perms]) !== initial;
  useLeaveWarning(dirty && !saving);

  const newId = useMemo(() => (roleId ? roleId : uniqueId(name, roles)), [roleId, name, roles]);
  const on = countOn(perms);
  const features = featuresOn(perms);
  // Everything this person is able to switch on is on
  const allChosen = ALL_KEYS.every((k) => perms[k] === true || !(!canGrant || canGrant(k)));
  const shownName = name.trim() || 'Untitled role';
  const custom = ROLE_SWATCHES.includes(color.toLowerCase()) ? null : color;

  const toggle = (key) => {
    const res = togglePermission(perms, key);
    if (!res.ok) return false;
    setPerms(res.perms);
    return true;
  };

  const grantable = (k) => !canGrant || canGrant(k);

  const setAll = (featureKey, value) => {
    setPerms((prev) => {
      const next = { ...prev };
      // Parents come first, so a child is only switched on under a parent that is
      descendants(featureKey).forEach((k) => {
        if (!value) next[k] = false;
        else if (next[PARENT[k]] === true && (prev[k] === true || grantable(k))) next[k] = true;
      });
      return next;
    });
  };

  const selectAll = () => setPerms((prev) => {
    const next = {};
    ALL_KEYS.forEach((k) => { next[k] = prev[k] === true || (grantable(k) && (!PARENT[k] || next[PARENT[k]] === true)); });
    return next;
  });

  const save = async () => {
    if (!name.trim()) { setError('Give the role a name first'); return; }
    if (!newId) { setError('Use at least one letter or number in the name'); return; }
    setSaving(true);
    setError('');
    try {
      await onSave(newId, { name: name.trim(), description: description.trim(), color, permissions: perms }, !roleId);
    } catch (e) {
      setError(e.message || 'Could not save the role');
      setSaving(false);
    }
  };

  const close = () => {
    if (saving) return;
    if (dirty) setAsking(true); else onClose();
  };

  return (
    <Modal onClose={close} wide className="um-editor-modal" label={roleId ? 'Edit role' : 'Create role'}>
      {asking ? <DiscardDialog onDiscard={onClose} onKeep={() => setAsking(false)} /> : null}
      <ModalHead
        lead={<span className="um-rtile um-rtile-sm" style={{ '--c': color }}><Ico src={shieldIcon} /></span>}
        title={roleId ? 'Edit role' : 'Create a new role'}
        sub={roleId
          ? (isBuiltin ? 'Built-in role · changes override the defaults, you can reset any time' : 'Custom role')
          : 'Name it, pick a colour, then choose what it can reach'}
        onClose={close}
      />
      <div className="um-editor">
        <aside className="um-eside">
          <label className="um-field">
            <span>Role name</span>
            <input className="um-input" value={name} onChange={(e) => { setName(e.target.value); setError(''); }} placeholder="e.g. Regulatory Analyst" maxLength={60} autoComplete="off" data-autofocus />
          </label>
          <label className="um-field">
            <span>Role ID{roleId ? '' : ' · generated'}</span>
            <input className="um-input um-ro" value={newId} readOnly placeholder="role_id" tabIndex={-1} />
          </label>
          <label className="um-field">
            <span>Description</span>
            <textarea className="um-input" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this role for?" maxLength={240} />
          </label>
          <div className="um-field">
            <span>Colour</span>
            <div className="um-swatches">
              {ROLE_SWATCHES.map((c) => (
                <button key={c} type="button" className={`um-sw ${c === color.toLowerCase() ? 'um-on' : ''}`} style={{ '--c': c }} onClick={() => setColor(c)} aria-label={`Colour ${c}`} />
              ))}
              <label className={`um-sw-custom ${custom ? 'um-on' : ''}`} title="Custom colour" style={custom ? { '--c': custom } : undefined}>
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Custom colour" />
              </label>
            </div>
          </div>
          <div className="um-preview">
            <div className="um-lbl">Preview</div>
            <div className="um-mini-prev" style={{ '--c': color }}>
              <Gauge on={on} color={color} size={42} />
              <div className="um-mp"><b>{shownName}</b><small>{plural(on, 'permission')} · {plural(features, 'feature')}</small></div>
            </div>
            <div style={{ '--c': color }}><FeatureBars perms={perms} /></div>
            <div className="um-mp-badge"><RoleBadge role={{ name: shownName, color }} /><small>as it shows in lists</small></div>
          </div>
        </aside>
        <div className="um-emain">
          <div className="um-ptools">
            <label className="um-search">
              <Ico src={searchIcon} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a permission…" autoComplete="off" />
            </label>
            {allChosen ? (
              <button type="button" className="um-btn um-btn-ghost um-btn-sm" onClick={() => setPerms(permsFrom([]))}>Clear all</button>
            ) : (
              <button type="button" className="um-btn um-btn-ghost um-btn-sm" onClick={selectAll}>Select all</button>
            )}
            <div className="um-pcount">
              <span><b>{on}</b> of {TOTAL_PERMISSIONS}</span>
              <span className="um-pbar"><i style={{ width: `${(on / TOTAL_PERMISSIONS) * 100}%` }} /></span>
            </div>
          </div>
          <PermissionEditor perms={perms} canGrant={canGrant} onToggle={toggle} onSetAll={setAll} selected={selected} onSelect={setSelected} query={query} color={color} />
        </div>
      </div>
      <div className="um-mfoot">
        <span className={`um-note ${error ? 'um-note-err' : ''}`}>{error || (name.trim() ? `${plural(features, 'feature')} switched on` : 'Give the role a name to continue')}</span>
        <button type="button" className="um-btn um-btn-ghost um-btn-sm" onClick={close} disabled={saving}>Cancel</button>
        <button type="button" className="um-btn um-btn-primary um-btn-sm" onClick={save} disabled={saving || (!!roleId && !dirty)}>
          {saving ? <Spinner /> : <Ico src={saveIcon} />} {roleId ? 'Save changes' : 'Create role'}
        </button>
      </div>
    </Modal>
  );
}

const CHECK = (
  <svg width="9" height="7" viewBox="0 0 9 7" fill="none" aria-hidden="true">
    <path d="M1 3.5L3.2 5.5L8 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const sameSet = (a = [], b = []) => a.length === b.length && a.every((x) => b.includes(x));

/*
 * Pick one or more roles for someone, choose whether their AD group's role
 * still counts, and see exactly what changes before saving.
 *   person     { email, name, photo } or null to pick someone first
 *   describe   email => { manualRoles, keepAd, hasEntry, roleIds, adRole, adRoleAny, adKnown, adState, overrides }
 *   roleOfIds  ids => role object with every permission any of them gives
 *   onConfirm  (person, roleIds, keepAd)
 */
export function AssignRoleModal({ person: initialPerson, roles, roleIds, holders, describe, searchPeople, photoFor, canGrant, roleOfIds, onConfirm, onClose }) {
  const [person, setPerson] = useState(initialPerson);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  const info = person ? describe(person.email) : null;
  const startRoles = (d) => d?.manualRoles || [];
  // New people keep their AD role by default; existing ones keep what they have
  const startKeep = (d) => (d?.hasEntry ? !!d.keepAd : true);
  const [selected, setSelected] = useState(() => startRoles(info));
  const [keepAd, setKeepAd] = useState(() => startKeep(info));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Only roles they don't already have need the person assigning to hold
  // everything in them (admins are let through by canGrant)
  const blockedBy = (id) => (canGrant && !info?.manualRoles?.includes(id)
    ? ALL_KEYS.filter((k) => roles[id]?.permissions?.[k] === true && !canGrant(k))
    : []);

  // Directory search for the "Assign roles" button, which starts with nobody
  useEffect(() => {
    if (person) return undefined;
    const q = query.trim();
    if (q.length < 2) { setResults([]); setSearchError(''); return undefined; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      searchPeople(q)
        .then((found) => { if (!cancelled) { setResults(found); setSearchError(''); } })
        .catch((e) => { if (!cancelled) { setResults([]); setSearchError(e.message || 'Search failed'); } })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, person, searchPeople]);

  const pick = (p) => {
    const d = describe(p.email);
    setPerson(p);
    setSelected(startRoles(d));
    setKeepAd(startKeep(d));
  };

  const toggleRole = (id) => setSelected((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : roleIds.filter((r) => r === id || prev.includes(r))));

  // What they'd hold after saving
  const nextIds = useMemo(() => {
    if (!info || !selected.length) return [];
    const ad = keepAd ? info.adRoleAny : null;
    return ad && !selected.includes(ad) ? [...selected, ad] : selected;
  }, [info, selected, keepAd]);

  const diff = useMemo(() => {
    if (!info || !nextIds.length) return null;
    const from = effectiveAccess(roleOfIds(info.roleIds)?.permissions, info.overrides);
    const to = effectiveAccess(roleOfIds(nextIds)?.permissions, info.overrides);
    const add = ALL_KEYS.filter((k) => to[k] && !from[k]);
    const remove = ALL_KEYS.filter((k) => from[k] && !to[k]);
    return { from: countOn(from), to: countOn(to), add, remove };
  }, [info, nextIds, roleOfIds]);

  const blockedPicked = selected.filter((id) => blockedBy(id).length);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await onConfirm(person, selected, keepAd);
    } catch (e) {
      setError(e.message || 'Could not save the roles');
      setSaving(false);
    }
  };

  const close = () => { if (!saving) onClose(); };

  const chips = diff ? [...diff.add.map((k) => ['um-add', `+ ${LABEL[k]}`]), ...diff.remove.map((k) => ['um-rem', LABEL[k]])] : [];
  const shown = chips.slice(0, 14);
  const counts = info ? overrideCount(info.overrides) : null;
  const unchanged = !!info?.hasEntry && sameSet(selected, info.manualRoles) && keepAd === !!info.keepAd;
  const adName = info?.adRoleAny ? roles[info.adRoleAny]?.name || info.adRoleAny : null;
  // Before/after can't be shown while their current access is still being worked out
  const waiting = info && info.adState && info.adState !== 'ok';

  return (
    <Modal onClose={close} className="um-assign" label="Assign roles">
      <ModalHead
        lead={person
          ? <Avatar name={person.name} photo={photoFor?.(person)} />
          : <span className="um-rtile um-rtile-sm" style={{ '--c': '#eb1700' }}><Ico src={personIcon} /></span>}
        title={info?.hasEntry ? 'Change roles' : 'Assign roles'}
        sub={person ? `${person.name} · ${person.email}` : 'Find the person, then pick the roles they should have'}
        onClose={close}
      />
      <div className="um-mbody">
        {!person ? (
          <>
            <label className="um-search um-search-wide">
              <Ico src={searchIcon} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or email…" autoComplete="off" data-autofocus />
              {searching ? <Spinner /> : null}
            </label>
            <div className="um-mlist um-pick">
              {results.map((p, k) => (
                <button key={p.email} type="button" className="um-mitem" style={{ '--k': Math.min(k, 12) }} onClick={() => pick(p)}>
                  <Avatar name={p.name} photo={photoFor?.(p)} />
                  <span className="um-mt"><b>{p.name}</b><small>{p.email}</small></span>
                  {p.jobTitle ? <span className="um-job">{p.jobTitle}</span> : null}
                </button>
              ))}
              {!results.length && query.trim().length >= 2 && !searching ? (
                <p className="um-muted-text">{searchError || 'No one matches that search.'}</p>
              ) : null}
              {query.trim().length < 2 ? <p className="um-muted-text">Type at least two letters.</p> : null}
            </div>
          </>
        ) : (
          <>
            <div className="um-field-label">
              Roles<span className="um-pickcount">{selected.length ? `${selected.length} picked · they get everything each one gives` : 'pick one or more'}</span>
            </div>
            <div className="um-ropts">
              {roleIds.map((id) => {
                const missing = blockedBy(id);
                const on = selected.includes(id);
                const off = missing.length > 0 && !on;
                return (
                  <button
                    key={id}
                    type="button"
                    className={`um-ropt ${on ? 'um-on' : ''}`}
                    style={{ '--c': roles[id].color || '#a39992' }}
                    onClick={() => toggleRole(id)}
                    aria-pressed={on}
                    disabled={off}
                    title={off ? `You can’t give this role: you don’t have ${missing.slice(0, 3).map((k) => LABEL[k]).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}` : undefined}
                  >
                    <span className="um-rtile"><Ico src={off ? lockIcon : shieldIcon} /></span>
                    <span className="um-ropt-t">
                      <b>{roles[id].name || id}</b>
                      <small>{plural(countOn(roles[id].permissions), 'permission')} · {plural(holders(id), 'person', 'people')}</small>
                    </span>
                    {info.manualRoles?.includes(id) ? <span className="um-cur">Current</span>
                      : id === info.adRoleAny ? <span className="um-cur">AD group</span> : null}
                    <span className="um-check">{CHECK}</span>
                  </button>
                );
              })}
            </div>

            <label className="um-keepad">
              <input type="checkbox" checked={keepAd} onChange={(e) => setKeepAd(e.target.checked)} />
              <span>
                <b>Keep the role from their AD group</b>
                <small>
                  {!info.adKnown
                    ? 'Their AD group couldn’t be checked yet. '
                    : adName ? `Their AD group gives ${adName}. ` : 'They’re not in a mapped AD group right now. '}
                  {keepAd
                    ? 'Ticked: the AD role counts on top of the roles above, and follows them if their group changes.'
                    : 'Unticked: the AD role is ignored, so they get only the roles above (use this to give someone less than their group does).'}
                </small>
              </span>
            </label>

            {waiting ? (
              <div className="um-diff">
                <span className="um-same">{info.adState === 'pending'
                  ? <><Spinner /> Checking their current access…</>
                  : 'Couldn’t check their AD groups, so the before/after isn’t shown. Saving still works.'}</span>
              </div>
            ) : !diff ? (
              <div className="um-diff"><span className="um-same">Pick at least one role.</span></div>
            ) : (
              <div className="um-diff">
                <h5>What changes <b>{diff.from} → {plural(diff.to, 'permission')}</b></h5>
                {chips.length ? (
                  <>
                    <div className="um-dchips">
                      {shown.map(([cls, text], i) => <span key={text} className={`um-dchip ${cls}`} style={{ '--k': i }}>{text}</span>)}
                      {chips.length > shown.length ? <span className="um-dchip um-more">+{chips.length - shown.length} more</span> : null}
                    </div>
                    <div className="um-same">{diff.add.length} gained · {diff.remove.length} lost</div>
                  </>
                ) : <span className="um-same">Same access as today.</span>}
                {counts.add || counts.remove ? (
                  <div className="um-same um-same-note">Their custom access <CustomChip counts={counts} /> stays on top.</div>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
      <div className="um-mfoot">
        {error ? <span className="um-note um-note-err">{error}</span> : null}
        {person && !initialPerson ? <button type="button" className="um-btn um-btn-ghost um-btn-sm um-mr-auto" onClick={() => setPerson(null)} disabled={saving}>Back</button> : null}
        <button type="button" className="um-btn um-btn-ghost um-btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="um-btn um-btn-primary um-btn-sm" onClick={save} disabled={!person || saving || !selected.length || unchanged || blockedPicked.length > 0}>
          {saving ? <Spinner /> : <Ico src={checkIcon} />} {info?.hasEntry ? 'Save roles' : 'Assign roles'}
        </button>
      </div>
    </Modal>
  );
}

// Members of one mapped AD group. Uses the shared member lookup, which caches
// per session and pages at most 500 members.
export function GroupMembersModal({ group, role, onClose }) {
  const { groups, load } = useAdGroupMembers();
  const [query, setQuery] = useState('');
  const entry = groups[group.name];

  useEffect(() => { load(group.name, group.id); }, [group.name, group.id, load]);

  const members = useMemo(() => {
    const list = (entry?.members || []).filter((m) => m.isUser !== false);
    const q = query.trim().toLowerCase();
    return q ? list.filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(q)) : list;
  }, [entry, query]);

  const total = group.memberCount ?? entry?.members?.length;

  return (
    <Modal onClose={onClose} className="um-members" label={`${group.name} members`}>
      <ModalHead
        lead={<span className="um-gtile um-gtile-sm"><Ico src={communityIcon} /></span>}
        title={group.name}
        sub={<>{total == null ? 'Members' : plural(total, 'member')} · grants <RoleBadge role={role} /></>}
        onClose={onClose}
      />
      <div className="um-mbody">
        <label className="um-search um-search-wide">
          <Ico src={searchIcon} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter members…" autoComplete="off" data-autofocus />
        </label>
        {!entry || entry.loading ? (
          <div className="um-loading"><Spinner /> Loading members…</div>
        ) : entry.error ? (
          <div className="um-retry">
            <span>{entry.error}</span>
            <button type="button" className="um-link" onClick={() => load(group.name, group.id)}><Ico src={refreshIcon} /> Try again</button>
          </div>
        ) : members.length ? (
          <div className="um-mlist">
            {members.map((m, k) => (
              <div key={m.id || m.email} className="um-mitem" style={{ '--k': Math.min(k, 12) }}>
                <Avatar name={m.name} photo={m.photo} />
                <span className="um-mt"><b>{m.name}</b><small>{m.email}</small></span>
                {m.title ? <span className="um-job">{m.title}</span> : null}
              </div>
            ))}
            {total != null && entry.members.length < total && !query ? (
              <p className="um-muted-text">Showing the first {entry.members.length} of {total}.</p>
            ) : null}
          </div>
        ) : (
          <p className="um-muted-text">{query ? 'No one matches that filter.' : 'This group has no members.'}</p>
        )}
      </div>
    </Modal>
  );
}