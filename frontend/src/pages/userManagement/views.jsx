import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom';
import closeIcon from '/icons/JJ_Icon_Close.svg';
import lockIcon from '/icons/JJ_Icon_Lock_black.svg';
import refreshIcon from '/icons/JJ_Icon_Refresh_RGB.svg';
import chevronRightIcon from '/icons/JJ_Icon_Chevron_Right.svg';
import shieldIcon from '/icons/JJ_Icon_Shield_RGB.svg';
import { DEFAULT_ROLE, LABEL, NODE, layerStack, PARENT, PERMISSION_GROUPS, TOTAL_PERMISSIONS, countOn, descendants, featuresOn, groupState, permissionSource, plural } from './access';
import { Avatar, Cell, CustomChip, Ico, RoleBadges, Switch } from './parts';

const TOP = 40;
const NODE_W = 10;
const MIN_W = 1140;
const thick = (v) => Math.sqrt(Math.max(1, v)) * 6.6;
const colHeight = (nodes, gap) => nodes.reduce((a, n) => a + n.box, 0) + gap * Math.max(0, nodes.length - 1);

/*
 * Where access comes from (AD groups, manual assignments, the default role)
 * → roles → the features each role opens. Ribbon width follows head count.
 *   groups       [{ key, name, role, memberCount, missing }]  memberCount null = unknown
 *   manualCounts { roleId: people with that role assigned by hand }
 *   everyoneElse people on the default role, or null when unknown
 *   hoverStore   { get, subscribe } holding the hovered group card's key, if any
 *   onOpen       (kind, id) for clicks: 'group' | 'role' | 'manual' | 'feature'
 *
 * Drawn as stacked layers so the moving bits never repaint the rest:
 *   ribbons svg  → pulse svg (own layer) → reveal curtain → nodes + labels svg
 */
const NO_STORE = { get: () => null, subscribe: () => () => {} };

function AccessMapChart({ groups, roles, manualCounts, manualPeople, everyoneElse, hoverStore = NO_STORE, onOpen }) {
  const hoveredGroup = useSyncExternalStore(hoverStore.subscribe, hoverStore.get, hoverStore.get);
  const highlight = hoveredGroup ? `group:${hoveredGroup}` : null;
  const svgRef = useRef(null);
  const infoRef = useRef(null);
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(MIN_W);
  const [hover, setHover] = useState(null);
  const [full, setFull] = useState(false);

  // Full screen: the browser's own full screen when it allows it, otherwise
  // the card just covers the window. Escape leaves either way.
  const leaveFull = useCallback(() => {
    if (document.fullscreenElement === wrapRef.current) document.exitFullscreen?.().catch(() => {});
    setFull(false);
  }, []);
  const toggleFull = () => {
    if (full) { leaveFull(); return; }
    setFull(true);
    wrapRef.current?.requestFullscreen?.().catch(() => {});
  };
  useEffect(() => {
    if (!full) return undefined;
    // Counts as an open layer, so the page's "/" shortcut stays quiet
    const id = Symbol('map-full');
    layerStack.push(id);
    const onFs = () => { if (!document.fullscreenElement) setFull(false); };
    const onKey = (e) => { if (e.key === 'Escape' && layerStack[layerStack.length - 1] === id) leaveFull(); };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('keydown', onKey);
      const at = layerStack.indexOf(id);
      if (at > -1) layerStack.splice(at, 1);
    };
  }, [full, leaveFull]);
  // Leaving the tab (or the page) mid full screen shouldn't strand the browser in it
  useEffect(() => () => {
    if (document.fullscreenElement && document.fullscreenElement === wrapRef.current) document.exitFullscreen?.().catch(() => {});
  }, []);

  const layout = useMemo(() => {
    const roleIds = Object.keys(roles);
    const rank = (id) => (id === DEFAULT_ROLE ? 99 : (groups.findIndex((g) => g.role === id) + 1 || 50));
    roleIds.sort((a, b) => rank(a) - rank(b));
    // People, not role assignments: someone with two roles is one person
    const manualTotal = manualPeople ?? Object.values(manualCounts).reduce((a, n) => a + n, 0);

    const sources = [
      ...groups.filter((g) => roles[g.role]).map((g) => ({
        id: `group:${g.key}`, kind: 'group', ref: g.key, label: g.name,
        sub: g.missing ? 'Not found in the directory' : g.memberCount == null ? 'AD group' : `${plural(g.memberCount, 'member')} · AD group`,
        color: '#312c2a', out: [{ to: g.role, v: g.memberCount ?? 1 }],
      })),
      {
        id: 'manual', kind: 'manual', label: 'Manual assignments', sub: plural(manualTotal, 'person', 'people'),
        color: '#6e6259', out: roleIds.filter((id) => manualCounts[id]).map((id) => ({ to: id, v: manualCounts[id] })),
      },
      {
        id: 'default', kind: 'default', label: 'All other users',
        sub: 'Default role',
        color: '#a39992', out: roles[DEFAULT_ROLE] ? [{ to: DEFAULT_ROLE, v: everyoneElse ?? 1 }] : [],
      },
    ].filter((n) => n.out.length);

    const links = [];
    sources.forEach((n) => n.out.forEach((o) => links.push({ from: n.id, to: o.to, t: thick(o.v), color: roles[o.to].color || '#a39992', stage: 1 })));
    sources.forEach((n) => { n.h = links.filter((l) => l.from === n.id).reduce((a, l) => a + l.t, 0); n.box = Math.max(30, n.h); });

    // A role nobody holds yet still gets a sliver, so its features stay visible
    const roleNodes = roleIds.map((id) => {
      const h = Math.max(4, links.filter((l) => l.to === id).reduce((a, l) => a + l.t, 0));
      return { id, kind: 'role', label: roles[id].name || id, color: roles[id].color || '#a39992', h, box: Math.max(18, h) };
    });
    roleNodes.forEach((node) => {
      const opens = PERMISSION_GROUPS.filter((g) => roles[node.id].permissions?.[g.key] === true);
      opens.forEach((g) => links.push({ from: node.id, to: g.key, t: node.h / opens.length, color: node.color, stage: 2 }));
    });
    const featNodes = PERMISSION_GROUPS.map((g) => {
      const h = Math.max(2, links.filter((l) => l.to === g.key).reduce((a, l) => a + l.t, 0));
      return { id: g.key, kind: 'feature', label: g.label, color: '#6e6259', h, box: Math.max(16, h) };
    });

    const H = TOP + 16 + Math.max(colHeight(sources, 24), colHeight(roleNodes, 22), colHeight(featNodes, 10));
    const place = (nodes, gap) => {
      let y = TOP + (H - TOP - colHeight(nodes, gap)) / 2;
      nodes.forEach((n) => { n.y = y + (n.box - n.h) / 2; y += n.box + gap; });
    };
    place(sources, 24);
    place(roleNodes, 22);
    place(featNodes, 10);

    // Stack each node's ribbons in the order of the nodes they connect to
    const all = [...sources, ...roleNodes, ...featNodes];
    const byId = Object.fromEntries(all.map((n) => [n.id, n]));
    const order = Object.fromEntries(all.map((n, i) => [n.id, i]));
    const outY = {};
    const inY = {};
    [...links].sort((a, b) => order[a.to] - order[b.to]).forEach((l) => {
      l.y0 = byId[l.from].y + (outY[l.from] || 0);
      outY[l.from] = (outY[l.from] || 0) + l.t;
    });
    [...links].sort((a, b) => order[a.from] - order[b.from]).forEach((l) => {
      l.y1 = byId[l.to].y + (inY[l.to] || 0);
      inY[l.to] = (inY[l.to] || 0) + l.t;
    });

    return { sources, roleNodes, featNodes, links, byId, H, manualTotal };
  }, [groups, roles, manualCounts, manualPeople, everyoneElse]);

  // Fit the chart to the screen: if it would be taller than the room left under
  // the sticky tab bar, widen the viewBox instead, which scales the whole
  // drawing down evenly (text and ribbons alike) rather than clipping it.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const root = svg.closest('.um');
    const panel = svg.closest('.um-panel');
    const bar = root?.querySelector('.um-bar');
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!root || !panel) return;
        let room;
        if (full) {
          // Window height less the card's padding, the info strip and the gap
          const info = infoRef.current?.offsetHeight || 0;
          room = (wrapRef.current?.clientHeight || window.innerHeight) - info - 80;
        } else {
          // The info strip sits under the card, so the map gets the whole
          // screen below the sticky tab bar (less the card's own padding)
          room = root.clientHeight - (bar?.offsetHeight || 0) - 44;
        }
        const boxW = (wrapRef.current?.clientWidth || svg.clientWidth + 44) - 44;
        let next = room > 220 && (layout.H * boxW) / MIN_W > room ? (layout.H * boxW) / room : MIN_W;
        // Full screen with height to spare: zoom in (up to 1.25x) to fill it
        if (full && room > 220) next = Math.max(MIN_W * 0.8, (layout.H * boxW) / room);
        setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (root) ro.observe(root);
    if (wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener('resize', measure);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [layout.H, full]);

  // Long AD group names ran off the left edge. Measure the widest source
  // label and push the first column right far enough to fit it.
  const labelW = useMemo(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return 0;
    let widest = 0;
    layout.sources.forEach((n) => {
      ctx.font = '12px JohnsonText, Arial, sans-serif';
      widest = Math.max(widest, ctx.measureText(n.label || '').width);
      ctx.font = '10.5px JohnsonText, Arial, sans-serif';
      widest = Math.max(widest, ctx.measureText(n.sub || '').width);
    });
    return Math.ceil(widest);
  }, [layout.sources]);

  const X = useMemo(() => {
    const x0 = Math.max(width * 0.2, labelW + 20);
    const x1 = Math.max(width * 0.49, x0 + 200);
    return [x0, x1, Math.max(width * 0.77, x1 + 200)];
  }, [width, labelW]);

  // What lights up for the node being traced
  const active = hover || highlight;
  const revealKey = layout.sources.map((n) => n.id).join('|');

  const trace = useMemo(() => {
    if (!active || !layout.byId[active]) return null;
    const node = layout.byId[active];
    const hot = new Set();
    const lit = new Set([active]);
    const isSource = node.kind === 'group' || node.kind === 'manual' || node.kind === 'default';
    layout.links.forEach((l, i) => {
      if (isSource && l.from === active) { hot.add(i); lit.add(l.to); }
      if (node.kind === 'role' && (l.from === active || l.to === active)) { hot.add(i); lit.add(l.from); lit.add(l.to); }
      if (node.kind === 'feature' && l.to === active) { hot.add(i); lit.add(l.from); }
    });
    // One more hop, so a group lights its features and a feature its sources
    const via = [...lit].filter((id) => roles[id] && id !== active);
    layout.links.forEach((l, i) => {
      if (isSource && via.includes(l.from)) { hot.add(i); lit.add(l.to); }
      if (node.kind === 'feature' && via.includes(l.to)) { hot.add(i); lit.add(l.from); }
    });
    return { hot, lit, node };
  }, [active, layout, roles]);

  const info = useMemo(() => {
    if (!trace) return null;
    const { node } = trace;
    if (node.kind === 'role') {
      const r = roles[node.id];
      const group = groups.find((g) => g.role === node.id);
      const parts = [
        group && `${group.memberCount == null ? 'members' : group.memberCount} via ${group.name}`,
        manualCounts[node.id] && `${manualCounts[node.id]} assigned by hand`,
        node.id === DEFAULT_ROLE && 'all other users by default',
      ].filter(Boolean).join(', ') || 'Nobody holds it yet';
      return { color: node.color, title: r.name || node.id, text: `${parts}. Opens ${plural(featuresOn(r.permissions), 'feature')}, ${plural(countOn(r.permissions), 'permission')}. Click to see who.` };
    }
    if (node.kind === 'feature') {
      const through = Object.keys(roles).filter((id) => roles[id].permissions?.[node.id] === true).map((id) => roles[id].name || id);
      return { color: '#6e6259', title: node.label, text: through.length ? `Opened by ${through.join(', ')}. Click to compare in the matrix.` : 'No role opens this yet.' };
    }
    const n = layout.sources.find((s) => s.id === node.id);
    const leads = n.out.map((o) => roles[o.to].name || o.to).join(', ');
    const group = node.kind === 'group' ? groups.find((g) => g.key === node.ref) : null;
    const hint = group ? (group.missing ? '' : ' Click to see members.') : node.kind === 'manual' ? ' Click to see them.' : '';
    return { color: n.color, title: n.label, text: `${n.sub}. Leads to ${leads}.${hint}` };
  }, [trace, roles, groups, manualCounts, layout.sources]);

  // Path strings only change with the layout or width, not on every hover
  const paths = useMemo(() => {
    return layout.links.map((l) => {
      const x0 = X[l.stage - 1] + NODE_W;
      const x1 = X[l.stage];
      const xm = (x0 + x1) / 2;
      const a = l.y0 + l.t / 2;
      const b = l.y1 + l.t / 2;
      return {
        band: `M${x0},${l.y0}C${xm},${l.y0} ${xm},${l.y1} ${x1},${l.y1}L${x1},${l.y1 + l.t}C${xm},${l.y1 + l.t} ${xm},${l.y0 + l.t} ${x0},${l.y0 + l.t}Z`,
        mid: `M${x0},${a}C${xm},${a} ${xm},${b} ${x1},${b}`,
      };
    });
  }, [layout, X]);

  const click = (node) => {
    // Whatever a click opens lives outside the map, so come out of full screen first
    if (full) leaveFull();
    if (node.kind === 'group') onOpen('group', node.ref);
    else if (node.kind === 'role') onOpen('role', node.id);
    else if (node.kind === 'manual') onOpen('manual');
    else if (node.kind === 'feature') onOpen('feature', node.id);
  };

  const nodeEl = (n, col) => {
    const x = X[col];
    const cy = n.y + n.h / 2;
    const clickable = n.kind !== 'default';
    return (
      <g
        key={n.id}
        className={`nd ${trace?.lit.has(n.id) ? 'hot' : ''} ${clickable ? '' : 'nd-static'}`}
        onMouseEnter={() => setHover(n.id)}
        onClick={clickable ? () => click(n) : undefined}
        onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); click(n); } } : undefined}
        onFocus={() => setHover(n.id)}
        onBlur={() => setHover(null)}
        tabIndex={clickable ? 0 : -1}
        role={clickable ? 'button' : undefined}
        aria-label={`${n.label}${n.sub ? `, ${n.sub}` : ''}`}
      >
        {/* wide invisible hit area so thin nodes are easy to point at */}
        <rect className="hit" x={col === 0 ? x - labelW - 16 : x - 4} y={n.y - 6} width={col === 0 ? labelW + 30 : 190} height={n.h + 12} />
        <rect x={x} y={n.y} width={NODE_W} height={n.h} rx="3" fill={n.color} />
        {col === 0 ? (
          <>
            <text x={x - 12} y={cy - 2} textAnchor="end">{n.label}</text>
            <text className="sub" x={x - 12} y={cy + 12} textAnchor="end">{n.sub}</text>
          </>
        ) : (
          <text className={col === 1 ? 'big' : ''} x={x + 18} y={cy + 4}>{n.label}</text>
        )}
      </g>
    );
  };

  const infoStrip = (
    <div ref={infoRef} className={`um-map-info ${full ? '' : 'um-map-info-below'}`} style={{ '--c': info?.color || '' }}>
      <i />
      <div>
        <b>{info ? info.title : 'Hover anything to trace access'}</b>
        <span>{info ? info.text : 'Everyone who signs in lands somewhere on this map.'}</span>
      </div>
      {!info ? <div className="um-prec"><span>Manual role</span>→<span>AD group</span>→<span>{roles[DEFAULT_ROLE]?.name || 'No access'}</span></div> : null}
    </div>
  );

  return (
    <>
      <div ref={wrapRef} className={`um-glass um-map ${full ? 'um-map-full' : ''}`}>
        <button
          type="button"
          className="um-iconbtn um-map-fs"
          onClick={toggleFull}
          aria-label={full ? 'Exit full screen' : 'Show the access map full screen'}
          title={full ? 'Exit full screen (Esc)' : 'Full screen'}
          aria-pressed={full}
        >
          {full ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 1.5V6H1.5M10 1.5V6h4.5M6 14.5V10H1.5M10 14.5V10h4.5" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M1.5 6V1.5H6M14.5 6V1.5H10M1.5 10v4.5H6M14.5 10v4.5H10" />
            </svg>
          )}
        </button>
        <div className={`um-map-stage ${trace ? 'dim' : ''}`}>
          {/* ribbons: repaint only when the trace changes */}
          <svg viewBox={`0 0 ${width} ${layout.H}`} aria-hidden="true">
            {layout.links.map((l, i) => (
              <g key={`${l.from}-${l.to}`} className={`lk ${trace?.hot.has(i) ? 'hot' : ''}`}>
                <path className="band" d={paths[i].band} fill={l.color} />
              </g>
            ))}
          </svg>
          {/* moving dashes on their own layer, so they don't drag the whole map into every frame */}
          <svg className="um-map-layer um-map-pulses" viewBox={`0 0 ${width} ${layout.H}`} aria-hidden="true">
            {trace ? layout.links.map((l, i) => (trace.hot.has(i)
              ? <path key={`${l.from}-${l.to}`} className="pulse" d={paths[i].mid} stroke={l.color} />
              : null)) : null}
          </svg>
          {/* keyed on the sources so the ribbons sweep in again once the directory answers,
              not just on the first paint while groups are still loading */}
          <span key={revealKey} className="um-map-curtain" aria-hidden="true" />
          <svg ref={svgRef} className="um-map-layer um-map-nodes" viewBox={`0 0 ${width} ${layout.H}`} onMouseLeave={() => setHover(null)} role="img" aria-label="Access map">
            <text className="colh" x={X[0] + NODE_W} y="14" textAnchor="end">Where access comes from</text>
            <text className="colh" x={X[1]} y="14">Roles</text>
            <text className="colh" x={X[2]} y="14">Features they open</text>
            {layout.sources.map((n) => nodeEl(n, 0))}
            {layout.roleNodes.map((n) => nodeEl(n, 1))}
            {layout.featNodes.map((n) => nodeEl(n, 2))}
          </svg>
        </div>
        {/* in full screen the strip has to live inside the card to stay visible */}
        {full ? infoStrip : null}
      </div>
      {full ? null : infoStrip}
    </>
  );
}

export const AccessMap = memo(AccessMapChart);

/*
 * People down the side, features across the top. With editing on, a click on
 * a single-switch feature flips it straight away; a feature with sub-features
 * opens a popover with one switch each.
 *   rows: [{ email, name, photo, role, roleNote, access, overrides, counts }]
 */
function UsersMatrixTable({ rows, editing, canEdit, onSet, onResetFeature, onOpenPerson, onOpenFull, onNeedEdit }) {
  const [pop, setPop] = useState(null); // { email, key, anchor: the dot's button }
  const closePop = useCallback(() => setPop(null), []);

  const clickCell = (row, key, e) => {
    if (!editing) { onNeedEdit(); return; }
    if (NODE[key].children.length) {
      const anchor = e.currentTarget;
      setPop((p) => (p && p.email === row.email && p.key === key ? null : { email: row.email, key, anchor }));
      return;
    }
    onSet(row.email, key, !row.access[key]);
  };

  // Editing switched off or the person scrolled out of the list: drop the popover
  const popRow = pop ? rows.find((r) => r.email === pop.email) : null;
  useEffect(() => { if (pop && (!editing || !popRow)) setPop(null); }, [pop, editing, popRow]);

  return (
    <div className={`um-glass um-matrix-wrap ${editing ? 'um-editing' : ''}`}>
      <div className="um-matrix-scroll">
        <table className="um-matrix um-umx">
          <thead>
            <tr>
              <th scope="col">Person</th>
              {PERMISSION_GROUPS.map((g) => (
                <th key={g.key} scope="col">
                  <div className="um-uh" title={g.description}><i><Ico src={g.icon} /></i><span>{g.label}</span></div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.email}>
                <th scope="row">
                  <button type="button" className="um-who um-clickable" onClick={() => onOpenPerson(row.email)}>
                    <Avatar name={row.name} photo={row.photo} size="sm" />
                    <span className="um-who-t">
                      <b>{row.name}</b>
                      <small><RoleBadges badges={row.badges} muted={row.adState && row.adState !== 'ok'} /><CustomChip counts={row.counts} /></small>
                    </span>
                  </button>
                </th>
                {PERMISSION_GROUPS.map((g) => {
                  const keys = [g.key, ...descendants(g.key)];
                  const plus = keys.some((k) => row.overrides.add?.includes(k));
                  const minus = keys.some((k) => row.overrides.remove?.includes(k));
                  const sel = pop && pop.email === row.email && pop.key === g.key;
                  const on = keys.filter((k) => row.access[k]).length;
                  return (
                    <td key={g.key}>
                      <button
                        type="button"
                        className={`um-cellbtn ${sel ? 'um-sel' : ''}`}
                        onClick={(e) => clickCell(row, g.key, e)}
                        aria-label={`${row.name}, ${g.label}: ${on} of ${keys.length}`}
                        title={`${row.name} · ${g.label}: ${on}/${keys.length}`}
                        disabled={(editing && !canEdit) || (row.adState && row.adState !== 'ok')}
                      >
                        <Cell state={groupState(row.access, g.key)} color={row.role?.color || '#a39992'} extra={`${plus ? 'um-plus' : ''} ${minus ? 'um-minus' : ''}`} />
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="um-mlegend">
        <span><Cell state="full" color="#6e6259" />Full</span>
        <span><Cell state="partial" color="#6e6259" />Some sub-features</span>
        <span><Cell state="none" color="#6e6259" />None</span>
        <span><Cell state="full" color="#a39992" extra="um-plus" />Added beyond role</span>
        <span><Cell state="full" color="#a39992" extra="um-minus" />Removed from role</span>
        <span className="um-mlegend-hint">{editing ? 'Click a dot to fine-tune that feature for the person' : 'Turn on “Edit in place” to give or take access per person'}</span>
      </div>

      {pop && popRow ? (
        <CellPopover
          row={popRow}
          featureKey={pop.key}
          anchor={pop.anchor}
          onClose={closePop}
          onSet={onSet}
          onReset={() => onResetFeature(popRow.email, pop.key)}
          onOpenFull={() => { setPop(null); onOpenFull(popRow.email); }}
        />
      ) : null}
    </div>
  );
}

export const UsersMatrix = memo(UsersMatrixTable);

function CellPopover({ row, featureKey, anchor, onClose, onSet, onReset, onOpenFull }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  const feature = NODE[featureKey];

  // Sit under the dot (or above it when there's no room below) and follow it
  // while the page or the matrix scrolls. Once the dot leaves the visible part
  // of the matrix, the popover goes.
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const box = anchor.closest('.um-matrix-scroll')?.getBoundingClientRect();
      const hidden = !anchor.isConnected || (box && (r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom));
      if (hidden) { onClose(); return; }
      const h = ref.current?.offsetHeight || 0;
      const left = Math.max(12, Math.min(window.innerWidth - 362, r.left + r.width / 2 - 175));
      const top = r.bottom + 10 + h > window.innerHeight ? Math.max(12, r.top - h - 10) : r.bottom + 10;
      setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
    };
    const onMove = (e) => {
      if (e?.target && ref.current?.contains(e.target)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    document.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [anchor, onClose]);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current?.contains(e.target) || e.target.closest?.('.um-cellbtn')) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const flip = (key, e) => {
    const locked = PARENT[key] && !row.access[PARENT[key]];
    if (locked) {
      const el = e.currentTarget;
      el.classList.remove('um-shaking');
      void el.offsetWidth;
      el.classList.add('um-shaking');
      return;
    }
    onSet(row.email, key, !row.access[key]);
  };

  const line = (node, depth) => {
    const locked = PARENT[node.key] && !row.access[PARENT[node.key]];
    const source = permissionSource(row.overrides, node.key);
    return (
      <React.Fragment key={node.key}>
        <div
          role="button"
          tabIndex={locked ? -1 : 0}
          aria-disabled={!!locked}
          className={`um-poprow ${depth ? '' : 'um-top'} ${locked ? 'um-locked' : ''}`}
          style={{ paddingLeft: 14 + depth * 18 }}
          onClick={(e) => flip(node.key, e)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(node.key, e); } }}
        >
          <span className="um-poptx">{node.label}</span>
          {locked
            ? <span className="um-src" title={`Needs ${LABEL[PARENT[node.key]]}`}><Ico src={lockIcon} /></span>
            : source === 'add' ? <span className="um-src um-a">Added</span>
              : source === 'remove' ? <span className="um-src um-r">Removed</span> : null}
          <Switch on={row.access[node.key]} disabled={!!locked} small />
        </div>
        {(node.children || []).map((c) => line(c, depth + 1))}
      </React.Fragment>
    );
  };

  const touched = [featureKey, ...descendants(featureKey)].some((k) => permissionSource(row.overrides, k) !== 'role');

  return ReactDOM.createPortal(
    <div ref={ref} className="um-layer-pop um-pop" style={pos} role="dialog" aria-label={`${feature.label} for ${row.name}`}>
      <div className="um-pophead">
        <Ico src={feature.icon} />
        <div><b>{feature.label}</b><small>{row.name} · {row.role?.name || 'No access'}</small></div>
        <button type="button" className="um-iconbtn" onClick={onClose} aria-label="Close"><Ico src={closeIcon} /></button>
      </div>
      <div className="um-popbody">{line(feature, 0)}</div>
      <div className="um-popfoot">
        <button type="button" className="um-link" onClick={onReset} disabled={!touched}><Ico src={refreshIcon} /> Match role</button>
        <button type="button" className="um-link" onClick={onOpenFull}>All access <Ico src={chevronRightIcon} /></button>
      </div>
    </div>,
    document.body
  );
}

/*
 * Roles side by side. Top-level rows expand into their sub-permissions. With
 * editing on, a click flips that permission for that role (same parent rule
 * as the role editor).
 *   onToggle(roleId, key) => false when blocked (parent off)
 */
function RolesMatrixTable({ roles, roleIds, editing, onToggle, onNeedEdit, focusKey }) {
  const [open, setOpen] = useState(() => new Set(['viewDQE', ...(focusKey ? [focusKey] : [])]));
  const wrapRef = useRef(null);

  // Arriving from the Access Map on a feature: open its row and bring it into view
  useEffect(() => {
    if (!focusKey) return;
    setOpen((prev) => (prev.has(focusKey) ? prev : new Set([...prev, focusKey])));
    const id = requestAnimationFrame(() => {
      wrapRef.current?.querySelector(`[data-row="${focusKey}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(id);
  }, [focusKey]);

  const flip = (roleId, key, e) => {
    if (!editing) { onNeedEdit(); return; }
    if (onToggle(roleId, key) === false) {
      const el = e.currentTarget;
      el.classList.remove('um-shaking');
      void el.offsetWidth;
      el.classList.add('um-shaking');
    }
  };

  const cell = (roleId, key, topLevel) => {
    const perms = roles[roleId].permissions || {};
    const state = topLevel ? groupState(perms, key) : (perms[key] === true ? 'full' : 'none');
    const locked = PARENT[key] && perms[PARENT[key]] !== true;
    return (
      <td key={roleId}>
        <button
          type="button"
          className="um-cellbtn"
          onClick={(e) => flip(roleId, key, e)}
          title={`${roles[roleId].name} · ${LABEL[key]}`}
          aria-label={`${roles[roleId].name}, ${LABEL[key]}: ${perms[key] === true ? 'on' : 'off'}`}
        >
          <Cell state={state} color={roles[roleId].color || '#a39992'} extra={locked ? 'um-lock' : ''} />
        </button>
      </td>
    );
  };

  const toggleOpen = (key) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <div ref={wrapRef} className={`um-glass um-matrix-wrap ${editing ? 'um-editing' : ''}`}>
      <div className="um-matrix-scroll">
        <table className="um-matrix">
          <thead>
            <tr>
              <th scope="col">Feature</th>
              {roleIds.map((id) => (
                <th key={id} scope="col">
                  <div className="um-mh" style={{ '--c': roles[id].color || '#a39992' }}>
                    <i><Ico src={shieldIcon} /></i>
                    <b>{roles[id].name || id}</b>
                    <small>{countOn(roles[id].permissions)} / {TOTAL_PERMISSIONS}</small>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_GROUPS.map((g) => {
              const kids = g.children;
              const isOpen = open.has(g.key);
              return (
                <React.Fragment key={g.key}>
                  <tr data-row={g.key} className={focusKey === g.key ? 'um-focus' : ''}>
                    <th scope="row">
                      <div className="um-mrow">
                        {kids.length ? (
                          <button type="button" className={`um-exp ${isOpen ? 'um-open' : ''}`} onClick={() => toggleOpen(g.key)} aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${g.label}`}>
                            <Ico src={chevronRightIcon} />
                          </button>
                        ) : <span className="um-exp-space" />}
                        <Ico src={g.icon} />
                        <b>{g.label}</b>
                        {kids.length ? <small>{descendants(g.key).length} sub</small> : null}
                      </div>
                    </th>
                    {roleIds.map((id) => cell(id, g.key, true))}
                  </tr>
                  {isOpen ? kids.map((c) => (
                    <React.Fragment key={c.key}>
                      <tr className="um-child">
                        <th scope="row"><div className="um-mrow"><b>{c.label}</b></div></th>
                        {roleIds.map((id) => cell(id, c.key, false))}
                      </tr>
                      {(c.children || []).map((gc) => (
                        <tr key={gc.key} className="um-child um-l3">
                          <th scope="row"><div className="um-mrow"><b>{gc.label}</b></div></th>
                          {roleIds.map((id) => cell(id, gc.key, false))}
                        </tr>
                      ))}
                    </React.Fragment>
                  )) : null}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="um-mlegend">
        <span><Cell state="full" color="#6e6259" />Full access</span>
        <span><Cell state="partial" color="#6e6259" />Some sub-features</span>
        <span><Cell state="none" color="#6e6259" />No access</span>
        <span><Cell state="none" color="#6e6259" extra="um-lock" />Needs the parent first</span>
        <span className="um-mlegend-hint">{editing ? 'Click any dot to switch it on or off' : 'Turn on “Edit in place” to change access straight from here'}</span>
      </div>
    </div>
  );
}

export const RolesMatrix = memo(RolesMatrixTable);