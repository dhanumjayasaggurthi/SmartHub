import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMsal } from '@azure/msal-react';
import { useRBAC } from '../context/RBACContext';
import { apiFetch } from '../utils/apiClient';
import { useDirectoryPhotos } from '../hooks/useDirectoryPhotos';
import { usePerfTier } from '../utils/perfTier';
import networkIcon from '/icons/JJ_Icon_Network_RGB.svg';
import shieldIcon from '/icons/JJ_Icon_Shield_RGB.svg';
import personIcon from '/icons/JJ_Icon_Person_RGB.svg';
import communityIcon from '/icons/JJ_Icon_Community_RGB.svg';
import addIcon from '/icons/JJ_Icon_Add.svg';
import editIcon from '/icons/JJ_Icon_Edit_RGB.svg';
import trashIcon from '/icons/JJ_Icon_Delete_RGB.svg';
import refreshIcon from '/icons/JJ_Icon_Refresh_RGB.svg';
import searchIcon from '/icons/JJ_Icon_Search_RGB.svg';
import alertIcon from '/icons/JJ_Icon_Alert_RGB.svg';
import chevronLeftIcon from '/icons/JJ_Icon_Chevron_Left.svg';
import chevronRightIcon from '/icons/JJ_Icon_Chevron_Right.svg';
import './UserManagement.css';
import {
  AD_ROLE_PRIORITY, BUILTIN_ROLE_IDS, DEFAULT_ROLE, EMPTY_OVERRIDES, PERMISSION_GROUPS, TOTAL_PERMISSIONS,
  cleanDisplayName, countOn, descendants, effectiveAccess, emailOf, featuresOn, getGraphToken, graphBatch, graphGet,
  isGuid, isLayerOpen, LABEL, odataString, overrideCount, plural, setOverride, togglePermission,
} from './userManagement/access';
import { Ico, Avatar, RoleBadge, RoleBadges, CustomChip, Gauge, FeatureBars, Switch, Segmented, SearchField, ConfirmDialog, Toasts, EmptyState, Spinner, RoleFilter } from './userManagement/parts';
import { AccessMap, RolesMatrix, UsersMatrix } from './userManagement/views';
import { AssignRoleModal, GroupMembersModal, RoleEditor, UserAccessEditor, UserDrawer } from './userManagement/modals';

const VALID_TABS = ['groups', 'roles', 'users'];
const USER_VIEWS = ['list', 'grid', 'matrix'];
const ROLE_VIEWS = ['cards', 'matrix'];

const TABS = [
  { id: 'groups', label: 'Access Map', icon: networkIcon },
  { id: 'roles', label: 'Roles & Permissions', short: 'Roles', icon: shieldIcon },
  { id: 'users', label: 'Users', icon: personIcon },
];

const PAGE_SIZE = 20;
// Users read from Graph per request; bigger than a page so names that start
// with a special character can be held back without leaving pages short.
const DIR_FETCH_SIZE = 100;
const USER_FIELDS = 'id,displayName,mail,userPrincipalName,jobTitle,department';
const PROFILE_FIELDS = [
  'id', 'displayName', 'mail', 'userPrincipalName', 'jobTitle', 'department', 'officeLocation', 'city', 'country',
  'companyName', 'mobilePhone', 'businessPhones', 'employeeId', 'employeeType', 'userType', 'accountEnabled', 'createdDateTime',
].join(',');

// Names that don't start with a letter ("#Team", "(Temp) Sam", "_svc",
// "3M Contact") go after everyone else.
const nameSpecial = (name) => (/^\p{L}/u.test(String(name || '').trim()) ? 0 : 1);
const displayNameOf = (user) => cleanDisplayName(user?.displayName) || emailOf(user);
const startsWithSpecial = (user) => nameSpecial(displayNameOf(user)) === 1;

// Anything cut off with "…" (or clamped to a few lines) gets its full text as
// a tooltip, but only while it's actually cut off. One listener for the page
// and its overlays, checked on hover, so nothing runs while you just scroll.
const TIP_SCOPE = '.um, .um-layer, .um-layer-pop';

function useTruncationTips() {
  useEffect(() => {
    const onOver = (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !el.closest(TIP_SCOPE)) return;
      // Not on the access map: it has its own hover info
      if (el.closest('.um-map')) return;
      // Only text that's styled to cut off ("…" or a line clamp), not every
      // box that happens to overflow, or the tip ends up with a whole section's text
      const css = getComputedStyle(el);
      if (css.textOverflow !== 'ellipsis' && css.webkitLineClamp === 'none') return;
      // A title someone wrote by hand wins
      if (el.hasAttribute('title') && !el.dataset.umTip) return;
      const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      const text = el.textContent.trim();
      if (cut && text) {
        el.title = text;
        el.dataset.umTip = '1';
      } else if (el.dataset.umTip) {
        el.removeAttribute('title');
        delete el.dataset.umTip;
      }
    };
    document.addEventListener('mouseover', onOver, { passive: true });
    return () => document.removeEventListener('mouseover', onOver);
  }, []);
}

// Tiny store for the hovered group card. Only the access map listens,
// so hovering a card doesn't re-render the whole page.
const makeHoverStore = () => {
  let value = null;
  const subs = new Set();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      subs.forEach((fn) => fn());
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
};

const grantBlocked = (key) => `You can’t give ${LABEL[key] || key}: you don’t have it yourself`;

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// Marks a person whose AD group check failed (as opposed to null: no group)
const AD_FAILED = 'failed';
// Shown in place of a role while we can't say for sure what it is
const CHECKING_ROLE = { name: 'Checking…', color: '#cbc4bc', permissions: {} };
const UNKNOWN_ROLE = { name: 'Role unknown', color: '#a39992', permissions: {} };

const toPerson = (user, fallbackEmail) => {
  const email = emailOf(user) || fallbackEmail;
  return {
    id: user?.id || null,
    email,
    name: cleanDisplayName(user?.displayName) || email,
    jobTitle: user?.jobTitle || '',
    department: user?.department || '',
  };
};

// A render error anywhere on the page (or its dialogs) lands here instead of
// blanking the whole app. "Try again" re-mounts the page with the same URL.
class PageErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, attempt: 0 };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('User Management crashed:', error, info?.componentStack);
  }

  render() {
    const { error, attempt } = this.state;
    if (!error) return <React.Fragment key={attempt}>{this.props.children}</React.Fragment>;
    return (
      <div className="um">
        <div className="um-glass um-crash">
          <EmptyState icon={alertIcon} title="Something went wrong on this page" text="Nothing you saved was lost. Try again, and if it keeps happening, reload the page.">
            <div className="um-cbtns">
              <button type="button" className="um-btn um-btn-ghost um-btn-sm" onClick={() => window.location.reload()}>Reload page</button>
              <button type="button" className="um-btn um-btn-primary um-btn-sm" onClick={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}>Try again</button>
            </div>
          </EmptyState>
        </div>
      </div>
    );
  }
}

export default function UserManagement() {
  return (
    <PageErrorBoundary>
      <UserManagementPage />
    </PageErrorBoundary>
  );
}

function UserManagementPage() {
  const { instance } = useMsal();
  const {
    getAllRoles, getAllUserRoles, getAllUserPermissionOverrides, customRoles, AD_GROUP_ROLES, hasPermission, userRole,
    assignRoleToUser, removeUserRoleOverride, createCustomRole, updateCustomRole, deleteCustomRole, saveUserPermissionOverrides,
  } = useRBAC();

  const baseRoles = getAllRoles();
  // email -> { roles: [...], keep_ad }: roles given by hand
  const roleOverrides = getAllUserRoles();
  const permOverrides = getAllUserPermissionOverrides();
  const canManageUsers = hasPermission('manageUsers');
  const canManageRoles = hasPermission('manageRoles');
  // Admins can give anything; everyone else only what they hold
  const isAdmin = userRole === 'admin';
  const canGrant = useCallback((key) => isAdmin || hasPermission(key), [isAdmin, hasPermission]);

  // ─── Tabs (the URL is the source of truth, so back/forward just work) ─────
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab = VALID_TABS.includes(tabParam) ? tabParam : 'groups';
  // The view lives in the URL too, so a refresh lands back on the same matrix
  const viewParam = searchParams.get('view');
  const usersView = activeTab === 'users' && USER_VIEWS.includes(viewParam) ? viewParam : 'list';
  const rolesView = activeTab === 'roles' && ROLE_VIEWS.includes(viewParam) ? viewParam : 'cards';
  const rootRef = useRef(null);
  const barRef = useRef(null);
  const tabsRef = useRef(null);
  const searchInputRef = useRef(null);

  // Everything else a link should bring back also lives in the URL:
  //   role   users tab role filter        q     users tab search
  //   scope  'all' = whole directory      page  page of the assigned list
  //   user   the person open in the drawer
  //   feature  row to focus in the roles matrix
  const navigate = useNavigate();

  // One URL write per action: two setSearchParams calls in the same tick would
  // each start from the same old params and the second would win. Empty values
  // drop the key. Filters replace the history entry; tabs and the drawer push
  // one, so Back steps through them.
  const updateParams = useCallback((changes, { push = false } = {}) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      Object.entries(changes).forEach(([key, value]) => {
        if (value == null || value === '' || value === false) next.delete(key);
        else next.set(key, String(value));
      });
      return next;
    }, { replace: !push });
  }, [setSearchParams]);

  const setTab = useCallback((tab, view = null, extra = {}) => {
    updateParams({ tab, view, ...extra }, { push: true });
    const root = rootRef.current;
    const bar = barRef.current;
    if (root && bar && root.scrollTop < bar.offsetTop - 8) root.scrollTo({ top: bar.offsetTop, behavior: 'smooth' });
  }, [updateParams]);

  const setView = useCallback((view) => updateParams({ view }), [updateParams]);

  // Sliding pill under the active tab
  const [pill, setPill] = useState({ left: 0, width: 0 });
  useEffect(() => {
    const measure = () => {
      const btn = tabsRef.current?.querySelector(`[data-tab="${activeTab}"]`);
      if (btn) setPill({ left: btn.offsetLeft, width: btn.offsetWidth });
    };
    measure();
    window.addEventListener('resize', measure);
    document.fonts?.ready?.then(measure);
    return () => window.removeEventListener('resize', measure);
  }, [activeTab]);

  // Cloud PCs without a GPU: blur behind the tab bar and the overlays gets
  // redrawn on the CPU every frame, so those machines get a solid fill instead.
  // Class sits on <html> because the overlays are portalled to <body>.
  const tier = usePerfTier();
  useEffect(() => {
    const html = document.documentElement;
    html.classList.toggle('um-lite', tier !== 'full');
    return () => html.classList.remove('um-lite');
  }, [tier]);

  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let frame = 0;
    let last = false;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = root.scrollTop >= (barRef.current?.offsetTop || 0) - 1;
        if (next !== last) { last = next; setStuck(next); }
      });
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => { root.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, []);

  // ─── Toasts + confirm ─────────────────────────────────────────────────────
  const [toasts, setToasts] = useState([]);
  const toastTimers = useRef(new Set());
  const toast = useCallback((message, type = 'success') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((t) => [...t.slice(-3), { id, message, type }]);
    const leave = setTimeout(() => {
      toastTimers.current.delete(leave);
      setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    }, 3200);
    const drop = setTimeout(() => {
      toastTimers.current.delete(drop);
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 3500);
    toastTimers.current.add(leave);
    toastTimers.current.add(drop);
  }, []);
  useEffect(() => {
    const timers = toastTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  // Saves can't go through offline, so say so rather than letting them fail one by one
  useEffect(() => {
    const onOffline = () => toast('You’re offline. Changes won’t save until you’re back.', 'error');
    const onOnline = () => toast('Back online');
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [toast]);

  const [confirm, setConfirm] = useState(null); // { title, message, confirmLabel, run }
  const [confirmBusy, setConfirmBusy] = useState(false);
  const runConfirm = async () => {
    setConfirmBusy(true);
    try {
      await confirm.run();
      setConfirm(null);
    } catch (e) {
      toast(e.message || 'Something went wrong', 'error');
    } finally {
      setConfirmBusy(false);
    }
  };

  // ─── Directory (Microsoft Graph) ──────────────────────────────────────────
  const graphToken = useCallback(() => getGraphToken(instance), [instance]);

  // Mapped AD groups with their member count and a few faces for the cards
  const [groups, setGroups] = useState([]);
  const [groupsState, setGroupsState] = useState('loading');
  const [groupsError, setGroupsError] = useState('');
  const loadGroups = useCallback(async () => {
    const entries = Object.entries(AD_GROUP_ROLES);
    if (!entries.length) { setGroups([]); setGroupsState('ready'); return; }
    setGroupsState('loading');
    setGroupsError('');
    try {
      const token = await graphToken();
      const found = await graphBatch(token, entries.map(([ref], i) => ({
        id: `g${i}`,
        method: 'GET',
        url: isGuid(ref)
          ? `/groups/${ref}?$select=id,displayName,description,mail`
          : `/groups?$filter=${encodeURIComponent(`displayName eq '${odataString(ref)}'`)}&$select=id,displayName,description,mail&$top=1`,
      })));
      const resolved = entries.map(([ref, role], i) => {
        const r = found[`g${i}`];
        const g = r?.status === 200 ? (r.body?.value ? r.body.value[0] : r.body) : null;
        return { key: ref, role, id: g?.id || null, name: g?.displayName || ref, description: g?.description || '', mail: g?.mail || '', memberCount: null, sample: [], missing: !g };
      });
      const withId = resolved.filter((g) => g.id);
      const members = await graphBatch(token, withId.map((g) => ({
        id: g.id,
        method: 'GET',
        url: `/groups/${g.id}/members?$count=true&$top=10&$select=id,displayName,mail,userPrincipalName`,
        headers: { ConsistencyLevel: 'eventual' },
      })));
      withId.forEach((g) => {
        const r = members[g.id];
        if (r?.status !== 200) return;
        g.memberCount = typeof r.body?.['@odata.count'] === 'number' ? r.body['@odata.count'] : null;
        g.sample = (r.body?.value || []).map((m) => ({ name: cleanDisplayName(m.displayName) || emailOf(m), email: emailOf(m) }));
      });
      setGroups(resolved);
      setGroupsState('ready');
    } catch (e) {
      setGroupsError(e.message || 'Could not load groups');
      setGroupsState('error');
    }
  }, [AD_GROUP_ROLES, graphToken]);
  useEffect(() => { loadGroups(); }, [loadGroups]);

  // How many different people have used SmartHub (sizes the "All other users" ribbon)
  const [knownUsers, setKnownUsers] = useState(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/rbac/directory-stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && typeof d?.known_users === 'number') setKnownUsers(d.known_users); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Graph profiles for people we only know by email (role or custom access)
  const [peopleByEmail, setPeopleByEmail] = useState({});
  // Emails whose lookup failed outright (network, throttling), so their role can't be worked out
  const [lookupFailed, setLookupFailed] = useState(() => new Set());
  const peopleRequested = useRef(new Set());
  const loadPeople = useCallback(async (emails) => {
    const todo = emails.filter((e) => e && !peopleRequested.current.has(e));
    if (!todo.length) return;
    todo.forEach((e) => peopleRequested.current.add(e));
    setLookupFailed((prev) => {
      if (!todo.some((e) => prev.has(e))) return prev;
      const next = new Set(prev);
      todo.forEach((e) => next.delete(e));
      return next;
    });
    try {
      const token = await graphToken();
      const res = await graphBatch(token, todo.map((email, i) => ({
        id: String(i), method: 'GET', url: `/users/${encodeURIComponent(email)}?$select=${USER_FIELDS}`,
      })));
      const found = {};
      todo.forEach((email, i) => { found[email] = res[String(i)]?.status === 200 ? res[String(i)].body : null; });
      setPeopleByEmail((prev) => ({ ...prev, ...found }));
    } catch {
      // Let them be retried, and meanwhile show their role as unknown
      todo.forEach((e) => peopleRequested.current.delete(e));
      setLookupFailed((prev) => new Set([...prev, ...todo]));
    }
  }, [graphToken]);

  // Which mapped AD group (if any) gives each person their role
  const [adRoles, setAdRoles] = useState({}); // userId -> roleId | null
  const adRequested = useRef(new Set());
  const mappedGroups = useMemo(() => groups.filter((g) => g.id), [groups]);
  // Full member lists of the mapped AD groups, read only when the Users tab
  // is filtered to a role an AD group grants. They give the exact list (and
  // count) of who holds that role through AD, including who is in more than
  // one group (the higher role wins).
  const [adMembers, setAdMembers] = useState({ state: 'idle', users: {}, roleOf: null, groupsOf: {}, complete: false, error: '' });
  const adMembersSeq = useRef(0);
  const loadAdMembers = useCallback(async () => {
    const seq = ++adMembersSeq.current;
    setAdMembers((m) => ({ ...m, state: 'loading', error: '' }));
    try {
      const token = await graphToken();
      const users = {};
      const groupsOf = {};
      // All groups at once; each one pages on its own. 20 pages (~20k people)
      // per group is plenty and stops a runaway loop.
      const lists = await Promise.all(mappedGroups.map(async (g) => {
        const found = [];
        let next = `/groups/${g.id}/members?$select=${USER_FIELDS}&$top=999`;
        for (let page = 0; next && page < 20; page++) {
          const data = await (await graphGet(token, next)).json();
          (data.value || []).forEach((m) => {
            if (m['@odata.type'] && m['@odata.type'] !== '#microsoft.graph.user') return;
            if (m.id && emailOf(m)) found.push(m);
          });
          next = data['@odata.nextLink'] || null;
        }
        return { g, found, cut: !!next };
      }));
      lists.forEach(({ g, found }) => found.forEach((m) => {
        users[m.id] = m;
        (groupsOf[m.id] || (groupsOf[m.id] = [])).push(g.role);
      }));
      // Only with every list read in full can "not in any" be trusted
      const complete = lists.every((l) => !l.cut);
      if (seq !== adMembersSeq.current) return;
      const roleOf = {};
      Object.entries(groupsOf).forEach(([id, list]) => {
        roleOf[id] = AD_ROLE_PRIORITY.find((r) => list.includes(r)) || list[0] || null;
      });
      setPeopleByEmail((prev) => {
        const next = { ...prev };
        Object.values(users).forEach((u) => { const e = emailOf(u); if (!next[e]) next[e] = u; peopleRequested.current.add(e); });
        return next;
      });
      setAdMembers({ state: 'ready', users, roleOf, groupsOf, complete, error: '' });
    } catch (e) {
      if (seq !== adMembersSeq.current) return;
      setAdMembers((m) => ({ ...m, state: 'error', error: e.message || 'Could not read the AD group members' }));
    }
  }, [mappedGroups, graphToken]);

  // Re-synced groups can change who gets what, so ask again
  useEffect(() => {
    adRequested.current = new Set();
    setAdRoles({});
    adMembersSeq.current += 1;
    setAdMembers({ state: 'idle', users: {}, roleOf: null, groupsOf: {}, complete: false, error: '' });
  }, [mappedGroups]);
  const loadAdRoles = useCallback(async (ids) => {
    if (!mappedGroups.length) return;
    const todo = ids.filter((id) => id && !adRequested.current.has(id));
    if (!todo.length) return;
    todo.forEach((id) => adRequested.current.add(id));
    try {
      const token = await graphToken();
      // Direct membership, same as the API checks (/me/memberOf). checkMemberGroups
      // also counted nested groups, so the page could show a role the API refuses.
      const res = await graphBatch(token, todo.map((id) => ({
        id, method: 'GET', url: `/users/${id}/memberOf?$select=id&$top=999`,
      })));
      const roleFrom = (ids) => {
        const roleIds = mappedGroups.filter((g) => ids.has(g.id)).map((g) => g.role);
        return AD_ROLE_PRIORITY.find((role) => roleIds.includes(role)) || roleIds[0] || null;
      };
      const found = {};
      await Promise.all(todo.map(async (id) => {
        const r = res[id];
        // 404: gone from the directory, so no group. Anything else: we just don't know.
        if (r?.status === 404) { found[id] = null; return; }
        if (r?.status !== 200) { found[id] = AD_FAILED; adRequested.current.delete(id); return; }
        const ids = new Set((r.body?.value || []).map((x) => x.id));
        // Someone in more than 999 groups: read the rest before saying "none"
        try {
          for (let next = r.body?.['@odata.nextLink'], page = 0; next && page < 10; page++) {
            const data = await (await graphGet(token, next)).json();
            (data.value || []).forEach((x) => ids.add(x.id));
            next = data['@odata.nextLink'];
          }
        } catch {
          found[id] = AD_FAILED;
          adRequested.current.delete(id);
          return;
        }
        found[id] = roleFrom(ids);
      }));
      setAdRoles((prev) => ({ ...prev, ...found }));
    } catch {
      todo.forEach((id) => adRequested.current.delete(id));
      setAdRoles((prev) => ({ ...prev, ...Object.fromEntries(todo.map((id) => [id, AD_FAILED])) }));
    }
  }, [mappedGroups, graphToken]);

  const adMembersComplete = useRef(false);
  adMembersComplete.current = adMembers.complete;

  const profileCache = useRef({});
  const loadProfile = useCallback(async (id) => {
    if (profileCache.current[id]) return profileCache.current[id];
    const token = await graphToken();
    const res = await graphGet(token, `/users/${id}?$select=${PROFILE_FIELDS}`);
    const data = await res.json();
    profileCache.current[id] = data;
    return data;
  }, [graphToken]);

  const searchPeople = useCallback(async (q) => {
    const token = await graphToken();
    const v = odataString(q);
    const filter = `startswith(displayName,'${v}') or startswith(mail,'${v}') or startswith(userPrincipalName,'${v}')`;
    const res = await graphGet(token, `/users?$filter=${encodeURIComponent(filter)}&$top=10&$select=${USER_FIELDS}`);
    const data = await res.json();
    const users = (data.value || []).filter((u) => emailOf(u));
    setPeopleByEmail((prev) => {
      const next = { ...prev };
      users.forEach((u) => { next[emailOf(u)] = u; peopleRequested.current.add(emailOf(u)); });
      return next;
    });
    if (!adMembersComplete.current) loadAdRoles(users.map((u) => u.id));
    return users.map((u) => toPerson(u));
  }, [graphToken, loadAdRoles]);

  // ─── Optimistic layers over saved state ───────────────────────────────────
  // Matrix clicks show at once; the save runs behind and rolls back on error.
  const [pendingRoles, setPendingRoles] = useState({});
  const [pendingAccess, setPendingAccess] = useState({});
  const roles = useMemo(() => ({ ...baseRoles, ...pendingRoles }), [baseRoles, pendingRoles]);
  const accessOf = useCallback((email) => pendingAccess[email] ?? permOverrides[email] ?? EMPTY_OVERRIDES, [pendingAccess, permOverrides]);

  const roleIds = useMemo(() => {
    const ids = Object.keys(roles);
    const builtins = BUILTIN_ROLE_IDS.filter((id) => ids.includes(id));
    return [...builtins, ...ids.filter((id) => !BUILTIN_ROLE_IDS.includes(id))];
  }, [roles]);

  // Roles given by hand to an email (ignoring any that were deleted), and
  // whether their AD group's role still counts on top. Nobody given a role by
  // hand just follows AD.
  const manualOf = useCallback((email) => {
    const entry = roleOverrides[email];
    const list = [...new Set((entry?.roles || []).filter((r) => roles[r]))];
    return { list, keepAd: list.length ? !!entry.keep_ad : true };
  }, [roleOverrides, roles]);

  // Full role for a set of ids: the role itself for one, a merged one (every
  // permission any of them gives, named "A + B") for several. Cached so the
  // same set is the same object and memoised rows stay put.
  const roleOfIds = useMemo(() => {
    const cache = new Map();
    return (ids) => {
      if (!ids?.length) return roles[DEFAULT_ROLE];
      if (ids.length === 1) return roles[ids[0]] || roles[DEFAULT_ROLE];
      const key = ids.join('|');
      if (!cache.has(key)) {
        const main = ids.includes('admin') ? 'admin' : ids[0];
        const permissions = {};
        ids.forEach((id) => Object.entries(roles[id]?.permissions || {}).forEach(([k, v]) => { if (v === true) permissions[k] = true; }));
        cache.set(key, { name: ids.map((id) => roles[id]?.name || id).join(' + '), color: roles[main]?.color || '#a39992', permissions });
      }
      return cache.get(key);
    };
  }, [roles]);

  // People given each role by hand (someone with two roles counts for both)
  const manualCounts = useMemo(() => {
    const out = {};
    Object.keys(roleOverrides).forEach((e) => manualOf(e).list.forEach((r) => { out[r] = (out[r] || 0) + 1; }));
    return out;
  }, [roleOverrides, manualOf]);
  const manualPeople = useMemo(() => Object.keys(roleOverrides).filter((e) => manualOf(e).list.length).length, [roleOverrides, manualOf]);

  // People holding a role through AD. With the member lists read, that's
  // exact: someone whose roles given by hand replace AD doesn't count, nor
  // does someone who already has that role by hand, and someone in two
  // groups counts once, for the higher role. Before that it's the group sizes.
  const adHolderCounts = useMemo(() => {
    if (!adMembers.roleOf) return null;
    const out = {};
    Object.entries(adMembers.roleOf).forEach(([id, role]) => {
      if (!role) return;
      const m = manualOf(emailOf(adMembers.users[id]));
      if ((m.list.length && !m.keepAd) || m.list.includes(role)) return;
      out[role] = (out[role] || 0) + 1;
    });
    return out;
  }, [adMembers, manualOf]);
  const holders = useCallback((roleId) => (manualCounts[roleId] || 0) + (adHolderCounts
    ? adHolderCounts[roleId] || 0
    : groups.filter((g) => g.role === roleId).reduce((a, g) => a + (g.memberCount || 0), 0)), [manualCounts, adHolderCounts, groups]);

  // AD role for a directory id: the full member lists when they were read to
  // the end (one snapshot, no per-person calls), else the per-person lookup.
  // undefined = not known yet.
  const adLookup = useCallback((id) => {
    if (adMembers.complete && adMembers.roleOf) return adMembers.roleOf[id] ?? null;
    return adRoles[id];
  }, [adMembers.complete, adMembers.roleOf, adRoles]);

  // Everything the page knows about one person.
  // adState: 'ok' once their roles are certain, 'pending' while the directory
  // or their AD groups are still being read, 'unknown' when that read failed.
  // Roles given by hand that replace AD are always certain.
  const describe = useCallback((email, graphUser) => {
    const e = (email || '').toLowerCase();
    const user = graphUser || peopleByEmail[e] || null;
    const { list: manualRoles, keepAd } = manualOf(e);
    const manualRole = manualRoles[0] || null;
    const usesAd = !manualRoles.length || keepAd;
    let adState = 'ok';
    if (usesAd) {
      if (!user) {
        if (lookupFailed.has(e)) adState = 'unknown';
        else if (peopleByEmail[e] === undefined && !graphUser) adState = 'pending';
      } else if (groupsState === 'error') adState = 'unknown';
      else if (groupsState === 'loading' && !groups.length) adState = 'pending';
      else if (mappedGroups.length) {
        const found = adLookup(user.id);
        if (found === undefined) adState = 'pending';
        else if (found === AD_FAILED) adState = 'unknown';
      }
    }
    const adRole = usesAd && adState === 'ok' && user?.id && mappedGroups.length ? adLookup(user.id) ?? null : null;
    // Every role they hold: by hand, plus AD when it counts; neither, the default
    const heldIds = [...manualRoles, ...(adRole && !manualRoles.includes(adRole) ? [adRole] : [])];
    const roleIds = heldIds.length ? heldIds : [DEFAULT_ROLE];
    const baseRoleId = roleIds.includes('admin') ? 'admin' : roleIds[0];
    const source = manualRole ? 'manual' : adRole ? 'ad' : 'default';
    const overrides = accessOf(e);
    // Their AD group's role even when it doesn't count right now (roles given
    // by hand replace it), so the assign window can say what ticking it brings
    const adAny = user?.id && mappedGroups.length ? adLookup(user.id) : null;
    const adKnown = !mappedGroups.length || (!!user && adAny !== undefined && adAny !== AD_FAILED);
    const adRoleAny = adKnown && typeof adAny === 'string' ? adAny : null;
    return {
      email: e, user, person: toPerson(user, e), manualRole, manualRoles, keepAd, heldIds, roleIds,
      adRole, adRoleAny, adKnown, adState, baseRoleId, source, overrides,
    };
  }, [peopleByEmail, lookupFailed, manualOf, adLookup, accessOf, groupsState, groups.length, mappedGroups.length]);

  // Try again for everyone whose role couldn't be worked out
  const retryUnknown = useCallback((people) => {
    if (adMembers.state === 'error') loadAdMembers();
    const emails = people.filter((p) => !p.user).map((p) => p.email);
    const ids = people.map((p) => p.user?.id).filter((id) => id && adRoles[id] === AD_FAILED);
    if (emails.length) loadPeople(emails);
    if (ids.length) {
      setAdRoles((prev) => {
        const next = { ...prev };
        ids.forEach((id) => delete next[id]);
        return next;
      });
      loadAdRoles(ids);
    }
  }, [adRoles, adMembers.state, loadPeople, loadAdRoles, loadAdMembers]);

  // One save at a time per person, in click order
  const saveChains = useRef({});
  const commitAccess = useCallback((email, next, message) => {
    setPendingAccess((p) => ({ ...p, [email]: next }));
    const run = () => saveUserPermissionOverrides(email, next)
      .then(() => {
        setPendingAccess((p) => {
          if (p[email] !== next) return p;
          const { [email]: _done, ...rest } = p;
          return rest;
        });
        if (message) toast(message);
      })
      .catch((e) => {
        // A newer click already queued behind this one carries its own state,
        // so only roll back when this save is still the latest one shown.
        setPendingAccess((p) => {
          if (p[email] !== next) return p;
          const { [email]: _failed, ...rest } = p;
          return rest;
        });
        toast(e.message || 'Could not save custom access', 'error');
      });
    saveChains.current[email] = (saveChains.current[email] || Promise.resolve()).then(run, run);
  }, [saveUserPermissionOverrides, toast]);

  const commitRole = useCallback((roleId, next) => {
    setPendingRoles((p) => ({ ...p, [roleId]: next }));
    const run = () => updateCustomRole(roleId, next)
      .then(() => setPendingRoles((p) => {
        if (p[roleId] !== next) return p;
        const { [roleId]: _done, ...rest } = p;
        return rest;
      }))
      .catch((e) => {
        setPendingRoles((p) => {
          if (p[roleId] !== next) return p;
          const { [roleId]: _failed, ...rest } = p;
          return rest;
        });
        toast(e.message || 'Could not update the role', 'error');
      });
    saveChains.current[`role:${roleId}`] = (saveChains.current[`role:${roleId}`] || Promise.resolve()).then(run, run);
  }, [updateCustomRole, toast]);

  // ─── Overlays ─────────────────────────────────────────────────────────────
  // The drawer is in the URL (?user=), so a link opens straight onto a person
  // and Back closes it. When we opened it, closing steps back in history
  // rather than stacking another entry.
  const userParam = (searchParams.get('user') || '').trim().toLowerCase();
  const drawerEmail = isEmail(userParam) ? userParam : null;
  const drawerPushed = useRef(false);
  useEffect(() => { if (!drawerEmail) drawerPushed.current = false; }, [drawerEmail]);
  const setDrawerEmail = useCallback((email) => {
    if (email) {
      if (email === drawerEmail) return;
      drawerPushed.current = true;
      updateParams({ user: email }, { push: true });
    } else if (drawerEmail) {
      if (drawerPushed.current) {
        drawerPushed.current = false;
        navigate(-1);
      } else {
        updateParams({ user: null });
      }
    }
  }, [drawerEmail, updateParams, navigate]);

  const [assignFor, setAssignFor] = useState(undefined); // undefined closed, null pick someone, email
  const [accessFor, setAccessFor] = useState(null); // { email, back }
  const [roleEditor, setRoleEditor] = useState(null); // { roleId } or { roleId: null }
  const [membersOf, setMembersOf] = useState(null); // group

  // ─── Users tab state (from the URL) ───────────────────────────────────────
  const debounced = (searchParams.get('q') || '').trim();
  const assignedOnly = searchParams.get('scope') !== 'all';
  // Several roles can be picked: ?role=admin,it_viewer. Unknown ids are ignored.
  const roleParam = searchParams.get('role') || '';
  const roleFilter = useMemo(() => [...new Set(roleParam.split(',').map((r) => r.trim()).filter((r) => roles[r]))], [roleParam, roles]);
  const roleKey = roleFilter.join(',');
  const pageParam = searchParams.get('page');
  const localPage = Math.max(1, Number.parseInt(pageParam, 10) || 1);
  const [usersEdit, setUsersEdit] = useState(false);

  // A role filter that includes a role an AD group grants needs the group member lists
  const filterNeedsAd = roleFilter.some((r) => mappedGroups.some((g) => g.role === r));
  // The Roles tab needs them too, so its people counts are exact (someone in
  // two groups, or with a manual role, is only counted once)
  // Read up front, in the background: with them in, every row's role is known
  // without a lookup per page, and the counts are exact on every tab.
  useEffect(() => {
    if (adMembers.state === 'idle' && mappedGroups.length) loadAdMembers();
  }, [adMembers.state, mappedGroups.length, loadAdMembers]);

  // Roles matrix row to open and scroll to (from an access map click)
  const featureParam = searchParams.get('feature');
  const roleFocus = PERMISSION_GROUPS.some((g) => g.key === featureParam) ? featureParam : null;

  // Any change to what's listed starts again from page 1
  const setDebounced = useCallback((q) => updateParams({ q, page: null }), [updateParams]);
  const setRoleFilter = useCallback((list) => updateParams({ role: list.join(','), page: null }), [updateParams]);
  const toggleAssignedOnly = () => updateParams({ scope: assignedOnly ? 'all' : null, role: null, page: null });
  const setLocalPage = (n) => updateParams({ page: n > 1 ? n : null });

  const localMode = assignedOnly || roleFilter.length > 0;

  // Directory pages. Graph sorts names like "#Team" or "(Temp) Sam" before
  // A, and a big tenant has thousands of them, so reading through them first
  // made the list slow. Instead the directory is read in two parts:
  //   main: names from "A" up (letters), straight from Graph
  //   tail: names below "A" (digits and !, #, (, . ...), only once main runs out
  // The few special names that sort inside main (@, _, [ ...) are held back
  // and shown at the very end. Pages already built are kept, so Previous
  // shows exactly what was shown before.
  const [dir, setDir] = useState({ users: [], state: 'idle', error: '', page: 0, hasNext: false });
  const dirSeq = useRef(0);
  const dirCursor = useRef(null);

  const directoryPlan = useMemo(() => {
    const select = `$top=${DIR_FETCH_SIZE}&$select=${USER_FIELDS}`;
    if (debounced) {
      const v = odataString(debounced);
      const filter = `startswith(displayName,'${v}') or startswith(mail,'${v}') or startswith(userPrincipalName,'${v}')`;
      return { main: `/users?$filter=${encodeURIComponent(filter)}&${select}`, tail: null, headers: {}, fallback: null };
    }
    // ge / not() with $orderby need Graph's advanced query mode
    const adv = `$orderby=displayName&$count=true&${select}`;
    return {
      main: `/users?$filter=${encodeURIComponent("displayName ge 'A'")}&${adv}`,
      tail: `/users?$filter=${encodeURIComponent("not(displayName ge 'A')")}&${adv}`,
      headers: { ConsistencyLevel: 'eventual' },
      fallback: `/users?$orderby=displayName&${select}`,
    };
  }, [debounced]);

  const showDirPage = useCallback(async (index, plan) => {
    const seq = ++dirSeq.current;
    if (plan) {
      dirCursor.current = {
        pages: [], normal: [], tail: [], held: [],
        next: plan.main, tailUrl: plan.tail, headers: plan.headers, fallback: plan.fallback,
        inTail: false, fetches: 0,
      };
    }
    const c = dirCursor.current;
    if (!c) return;
    const more = () => !!c.next || (!c.inTail && !!c.tailUrl);
    // What the next page can be built from right now
    const ready = () => (c.inTail || !more() ? c.normal.length + c.tail.length + (more() ? 0 : c.held.length) : c.normal.length);

    setDir((d) => ({ ...d, state: 'loading', error: '' }));
    try {
      if (!c.pages[index]) {
        let token = null;
        // Fallback mode has no tail: one read per page at most, so it stays fast
        let budget = c.fallbackUsed ? 1 : Infinity;
        while (ready() < PAGE_SIZE && more() && budget-- > 0) {
          if (!c.next) { c.inTail = true; c.next = c.tailUrl; continue; }
          token = token || await graphToken();
          let data;
          try {
            data = await (await graphGet(token, c.next, c.headers)).json();
          } catch (e) {
            // Tenant without advanced queries: plain alphabetical list instead
            if (e.status === 400 && c.fallback && !c.fetches) {
              Object.assign(c, { next: c.fallback, tailUrl: null, headers: {}, fallback: null, fallbackUsed: true });
              budget = 1;
              continue;
            }
            throw e;
          }
          c.fetches += 1;
          const users = (data.value || []).filter((u) => emailOf(u));
          // Update the cursor before the stale check, so it stays consistent
          // even when this answer is no longer the one on screen.
          users.forEach((u) => {
            if (c.inTail) c.tail.push(u);
            else (startsWithSpecial(u) ? c.held : c.normal).push(u);
          });
          c.next = data['@odata.nextLink'] || null;
          // Keep them by email too, so the drawer, the matrix and AD-role
          // lookups all see the same person object as the row does.
          setPeopleByEmail((prev) => {
            const next = { ...prev };
            users.forEach((u) => { const e = emailOf(u); next[e] = u; peopleRequested.current.add(e); });
            return next;
          });
          if (seq !== dirSeq.current) return;
        }
        const page = c.normal.splice(0, PAGE_SIZE);
        if (c.inTail || !more()) page.push(...c.tail.splice(0, PAGE_SIZE - page.length));
        if (!more()) page.push(...c.held.splice(0, PAGE_SIZE - page.length));
        // Fallback only: never show an empty page just to keep the order
        if (!page.length && c.fallbackUsed) page.push(...c.held.splice(0, PAGE_SIZE));
        c.pages[index] = page;
      }
      if (seq !== dirSeq.current) return;
      const hasNext = !!c.pages[index + 1] || more() || c.normal.length + c.tail.length + c.held.length > 0;
      setDir({ users: c.pages[index], state: 'ready', error: '', page: index, hasNext });
    } catch (e) {
      if (seq !== dirSeq.current) return;
      setDir((d) => ({ ...d, state: 'error', error: e.message || 'Failed to load users' }));
    }
  }, [graphToken]);

  const reloadDirectory = useCallback(() => showDirPage(0, directoryPlan), [showDirPage, directoryPlan]);
  useEffect(() => {
    if (activeTab !== 'users' || localMode) return;
    reloadDirectory();
  }, [activeTab, localMode, reloadDirectory]);

  const dirNext = () => { if (dir.hasNext) showDirPage(dir.page + 1); };
  const dirPrev = () => { if (dir.page > 0) showDirPage(dir.page - 1); };

  // People with a manual role or custom access
  const managedEmails = useMemo(
    () => [...new Set([...Object.keys(roleOverrides), ...Object.keys(permOverrides)])],
    [roleOverrides, permOverrides]
  );
  useEffect(() => {
    if (activeTab === 'users' || activeTab === 'roles' || drawerEmail) loadPeople(drawerEmail ? [...managedEmails, drawerEmail] : managedEmails);
  }, [activeTab, managedEmails, drawerEmail, loadPeople]);

  // Who we can put a face to for each role: manual picks plus the AD group sample
  const roleFaces = useMemo(() => {
    const out = {};
    const add = (roleId, p) => {
      const key = (p.email || p.name || '').toLowerCase();
      if (!key) return;
      const list = out[roleId] || (out[roleId] = []);
      if (!list.some((x) => (x.email || x.name || '').toLowerCase() === key)) list.push(p);
    };
    Object.keys(roleOverrides).forEach((e) => {
      const { list } = manualOf(e);
      if (list.length) { const who = describe(e).person; list.forEach((id) => add(id, who)); }
    });
    // Group samples, but once the member lists are in, only people whose role
    // really comes from that group (not overridden by hand or by a higher group)
    const byEmail = new Map(Object.values(adMembers.users).map((u) => [emailOf(u), u]));
    groups.forEach((g) => g.sample.forEach((m) => {
      if (adMembers.roleOf) {
        const u = byEmail.get((m.email || '').toLowerCase());
        const mine = manualOf((m.email || '').toLowerCase());
        const holds = mine.list.includes(g.role) || ((!mine.list.length || mine.keepAd) && u && adMembers.roleOf[u.id] === g.role);
        if (!holds) return;
      }
      add(g.role, m);
    }));
    return out;
  }, [roleOverrides, manualOf, describe, groups, adMembers]);

  // People in a role's AD group who end up with a different role: given one by
  // hand (that always wins), or also in a mapped group with a higher role.
  // Shown on the role cards and the Users tab so the numbers explain themselves.
  const adElsewhere = useMemo(() => {
    if (!adMembers.roleOf) return {};
    const out = {};
    Object.entries(adMembers.groupsOf).forEach(([id, groupRoles]) => {
      const u = adMembers.users[id];
      const email = emailOf(u);
      const { list, keepAd } = manualOf(email);
      const adRole = adMembers.roleOf[id];
      // What they really hold (same rule as describe)
      const held = list.length ? [...list, ...(keepAd && adRole && !list.includes(adRole) ? [adRole] : [])] : [adRole];
      // Roles given by hand that replace AD are why, unless AD still counts
      const how = list.length && !keepAd ? 'manual' : 'ad';
      [...new Set(groupRoles)].forEach((r) => {
        if (held.includes(r)) return;
        (out[r] || (out[r] = [])).push({ user: u, email, name: cleanDisplayName(u.displayName) || email, role: held[0], roles: held, how });
      });
    });
    return out;
  }, [adMembers, manualOf]);
  const elsewhereNote = (list) => list.map((x) => `${x.name} → ${x.roles.map((id) => roles[id]?.name || id).join(' + ')} (${x.how === 'manual' ? 'given by hand' : 'higher AD group'})`).join('\n');

  // In the Users tab: those people for the picked roles, and whether to list them too
  const [showElsewhere, setShowElsewhere] = useState(false);
  useEffect(() => { setShowElsewhere(false); }, [roleKey]);
  const elsewhereForFilter = useMemo(() => {
    const seen = new Map();
    roleFilter.forEach((r) => (adElsewhere[r] || []).forEach((x) => { if (!x.roles.some((id) => roleFilter.includes(id))) seen.set(x.email, x); }));
    return [...seen.values()];
  }, [roleFilter, adElsewhere]);

  // Filtered by role, the list is everyone who holds one of those roles, by
  // hand or through an AD group, the same people the Roles tab counts.
  const localRows = useMemo(() => {
    if (!localMode) return [];
    const q = debounced.toLowerCase();
    const adByEmail = new Map();
    if (roleFilter.length && adMembers.roleOf) {
      Object.values(adMembers.users).forEach((u) => {
        if (roleFilter.includes(adMembers.roleOf[u.id])) adByEmail.set(emailOf(u), u);
      });
    }
    const extra = new Set();
    if (showElsewhere) elsewhereForFilter.forEach((x) => { adByEmail.set(x.email, x.user); extra.add(x.email); });
    const pool = adByEmail.size ? [...new Set([...managedEmails, ...adByEmail.keys()])] : managedEmails;
    return pool
      .map((e) => describe(e, adByEmail.get(e)))
      .filter((r) => !roleFilter.length || extra.has(r.email) || r.heldIds.some((id) => roleFilter.includes(id)))
      .filter((r) => !q || r.email.includes(q) || r.person.name.toLowerCase().includes(q))
      .sort((a, b) => nameSpecial(a.person.name) - nameSpecial(b.person.name) || a.person.name.localeCompare(b.person.name));
  }, [localMode, managedEmails, roleFilter, adMembers, describe, debounced, showElsewhere, elsewhereForFilter]);

  const roleCounts = useMemo(() => Object.fromEntries(roleIds.map((id) => [id, holders(id)])), [roleIds, holders]);

  const localPages = Math.max(1, Math.ceil(localRows.length / PAGE_SIZE));
  const pageNo = Math.min(localPage, localPages);

  // Tidy the URL when it asks for something that doesn't exist (an old link,
  // a deleted role, a hand-edited address), so what's shown and what's in the
  // address bar always agree.
  useEffect(() => {
    const fix = {};
    if (tabParam && !VALID_TABS.includes(tabParam)) fix.tab = null;
    const views = activeTab === 'users' ? USER_VIEWS : activeTab === 'roles' ? ROLE_VIEWS : [];
    if (viewParam && !views.includes(viewParam)) fix.view = null;
    if (roleParam !== roleKey) fix.role = roleKey || null;
    if (userParam && !drawerEmail) fix.user = null;
    if (featureParam && !roleFocus) fix.feature = null;
    const scope = searchParams.get('scope');
    if (scope && scope !== 'all') fix.scope = null;
    if (pageParam != null && String(localMode ? pageNo : 1) !== pageParam) fix.page = localMode && pageNo > 1 ? pageNo : null;
    if (Object.keys(fix).length) updateParams(fix);
  }, [tabParam, activeTab, viewParam, roleParam, roleKey, userParam, drawerEmail, featureParam, roleFocus, searchParams, pageParam, localMode, pageNo, updateParams]);
  const rowsData = useMemo(() => (localMode
    ? localRows.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE)
    : dir.users.map((u) => describe(emailOf(u), u)).filter((r) => r.email)), [localMode, localRows, pageNo, dir.users, describe]);

  // Look up AD roles for whoever is on screen
  const visibleIds = rowsData.map((r) => r.user?.id).filter(Boolean).join(',');
  useEffect(() => {
    if (activeTab === 'users' && visibleIds && !adMembers.complete) loadAdRoles(visibleIds.split(','));
  }, [activeTab, visibleIds, adMembers.complete, loadAdRoles]);

  // Faces: visible rows, the open drawer, and the group card previews
  const drawerInfo = drawerEmail ? describe(drawerEmail) : null;
  useEffect(() => {
    if (drawerInfo?.user?.id && !adMembers.complete) loadAdRoles([drawerInfo.user.id]);
  }, [drawerInfo?.user?.id, adMembers.complete, loadAdRoles]);
  // The hook keys its lookups on the emails, so a fresh array each render is fine
  const photoPeople = activeTab === 'users' ? rowsData.map((r) => r.person) : [];
  if (activeTab === 'groups') groups.forEach((g) => g.sample.forEach((m) => photoPeople.push(m)));
  if (activeTab === 'roles') Object.values(roleFaces).forEach((list) => list.forEach((p) => photoPeople.push(p)));
  if (drawerInfo) photoPeople.push(drawerInfo.person);
  const photoFor = useDirectoryPhotos(photoPeople);

  // People with a photo go first, then A-Z
  const facesFor = (roleId) => (roleFaces[roleId] || [])
    .map((p) => ({ p, photo: photoFor(p) }))
    .sort((a, b) => (b.photo ? 1 : 0) - (a.photo ? 1 : 0)
      || nameSpecial(a.p.name) - nameSpecial(b.p.name)
      || a.p.name.localeCompare(b.p.name));

  // One badge per role they hold; the one from AD says so
  const badgesFor = useCallback((r) => r.roleIds.map((id) => ({
    role: roles[id] || { name: id },
    note: r.source === 'default' ? 'default' : id === r.adRole && !r.manualRoles.includes(id) ? 'via AD' : null,
  })), [roles]);

  // Until someone's role is certain, show that rather than a guess (and keep
  // the matrix from editing on top of the wrong role)
  const rows = useMemo(() => rowsData.map((r) => {
    const sure = r.adState === 'ok';
    const role = sure ? roleOfIds(r.roleIds) : r.adState === 'pending' ? CHECKING_ROLE : UNKNOWN_ROLE;
    return {
      ...r,
      name: r.person.name,
      photo: photoFor(r.person),
      role,
      badges: sure ? badgesFor(r) : [{ role, note: null }],
      roleNote: !sure ? null : r.source === 'ad' ? 'via AD' : r.source === 'default' ? 'default' : null,
      access: sure ? effectiveAccess(role?.permissions, r.overrides) : {},
      counts: overrideCount(r.overrides),
    };
  }), [rowsData, roleOfIds, badgesFor, photoFor]);
  const unknownRows = rows.filter((r) => r.adState === 'unknown');

  // ─── Actions ──────────────────────────────────────────────────────────────
  const openAssign = (email) => { setDrawerEmail(null); setAssignFor(email); };
  const openAccess = useCallback((email, back = false) => { setDrawerEmail(null); setAccessFor({ email, back }); }, [setDrawerEmail]);

  const confirmAssign = async (person, roleIdsPicked, keepAd) => {
    await assignRoleToUser(person.email, roleIdsPicked, keepAd);
    setPeopleByEmail((prev) => (prev[person.email] || !person.id ? prev : { ...prev, [person.email]: { id: person.id, displayName: person.name, mail: person.email, jobTitle: person.jobTitle, department: person.department } }));
    setAssignFor(undefined);
    toast(`${person.name} now has ${roleIdsPicked.map((id) => roles[id]?.name || id).join(' + ')}${keepAd ? ' (plus their AD role)' : ''}`);
  };

  const askRemoveRole = (email) => {
    const info = describe(email);
    setConfirm({
      title: info.manualRoles.length > 1 ? 'Remove these roles?' : 'Remove this role?',
      message: `${info.person.name} will lose ${info.manualRoles.map((id) => roles[id]?.name || id).join(', ') || 'their role'} and fall back to their AD group or the default role (${roles[DEFAULT_ROLE]?.name || 'No access'}).`,
      confirmLabel: info.manualRoles.length > 1 ? 'Remove roles' : 'Remove role',
      run: async () => {
        await removeUserRoleOverride(email);
        setDrawerEmail(null);
        toast(info.manualRoles.length > 1 ? 'Roles removed' : 'Role removed');
      },
    });
  };

  const saveRole = async (id, def, isNew) => {
    if (isNew) {
      if (roles[id]) throw new Error('A role with this ID already exists');
      await createCustomRole(id, def);
      toast(`${def.name} created`);
    } else {
      await updateCustomRole(id, def);
      toast(`${def.name} updated`);
    }
    setRoleEditor(null);
  };

  const askDeleteRole = (id) => {
    const n = manualCounts[id] || 0;
    setConfirm({
      title: `Delete ${roles[id].name}?`,
      message: n
        ? `It’s taken off ${plural(n, 'person', 'people')}. Anyone left with no role given by hand falls back to their AD group or the default role (${roles[DEFAULT_ROLE]?.name || 'No access'}).`
        : 'Nobody is assigned this role, so no one loses access.',
      confirmLabel: 'Delete role',
      run: async () => {
        await deleteCustomRole(id);
        if (roleFilter.includes(id)) setRoleFilter(roleFilter.filter((r) => r !== id));
        toast(`${roles[id].name} deleted`);
      },
    });
  };

  const askResetRole = (id) => setConfirm({
    title: 'Reset to default?',
    message: `${roles[id].name} goes back to its original permissions. Custom changes to this role are lost.`,
    confirmLabel: 'Reset role',
    run: async () => {
      await deleteCustomRole(id);
      toast(`${roles[id].name} reset to default`);
    },
  });

  const saveAccess = async (email, overrides) => {
    await saveUserPermissionOverrides(email, overrides);
    const n = overrideCount(overrides);
    toast(n.add || n.remove ? `Custom access saved · +${n.add} −${n.remove}` : 'Access matches the role again');
    const back = accessFor?.back;
    setAccessFor(null);
    if (back) setDrawerEmail(email);
  };

  // Matrix: one permission for one person
  const setPersonPermission = useCallback((email, key, on) => {
    const info = describe(email);
    const role = roleOfIds(info.roleIds);
    if (on && !canGrant(key)) { toast(grantBlocked(key), 'error'); return false; }
    const res = setOverride(role?.permissions, info.overrides, key, on);
    if (!res.ok) { toast(`Needs ${res.needs} first`, 'error'); return false; }
    commitAccess(email, res.overrides);
    return true;
  }, [describe, roleOfIds, commitAccess, toast, canGrant]);

  const resetPersonFeature = useCallback((email, featureKey) => {
    const info = describe(email);
    const keys = new Set([featureKey, ...descendants(featureKey)]);
    commitAccess(email, {
      add: info.overrides.add.filter((k) => !keys.has(k)),
      remove: info.overrides.remove.filter((k) => !keys.has(k)),
    }, 'Back to what the role gives');
  }, [describe, commitAccess]);

  const needUsersEdit = useCallback(() => toast(canManageUsers
    ? 'Turn on “Edit in place” to change access from the matrix'
    : 'You can view access but not change it'), [toast, canManageUsers]);
  const needRolesEdit = useCallback(() => toast(canManageRoles
    ? 'Turn on “Edit in place” to change roles from the matrix'
    : 'You can view roles but not change them'), [toast, canManageRoles]);

  // Roles matrix: one permission for one role
  const [rolesEdit, setRolesEdit] = useState(false);
  const toggleRolePermission = useCallback((roleId, key) => {
    const role = roles[roleId];
    if (role.permissions?.[key] !== true && !canGrant(key)) { toast(grantBlocked(key), 'error'); return false; }
    const res = togglePermission({ ...role.permissions }, key);
    if (!res.ok) { toast(`Needs ${res.needs} first`, 'error'); return false; }
    commitRole(roleId, { ...role, permissions: res.perms });
    return true;
  }, [roles, commitRole, toast, canGrant]);

  // Access map clicks
  const openFromMap = useCallback((kind, id) => {
    if (kind === 'group') {
      const g = groups.find((x) => x.key === id);
      if (g && !g.missing) setMembersOf(g);
    } else if (kind === 'role') {
      setTab('users', null, { role: id, scope: 'all', page: null });
    } else if (kind === 'manual') {
      setTab('users', null, { role: null, scope: null, page: null });
    } else if (kind === 'feature') {
      setTab('roles', 'matrix', { feature: id });
    }
  }, [groups, setTab]);

  // "/" jumps to the user search from anywhere on the page. The tab change is
  // a router transition, so the focus waits for the Users tab to be on screen.
  const [searchWanted, setSearchWanted] = useState(0);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || isLayerOpen()) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      e.preventDefault();
      if (activeTabRef.current !== 'users') setTab('users');
      setSearchWanted((n) => n + 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setTab]);
  useEffect(() => {
    if (searchWanted && activeTab === 'users') searchInputRef.current?.focus({ preventScroll: true });
  }, [searchWanted, activeTab]);

  // Full text on hover wherever a label gets cut off
  useTruncationTips();

  const groupHover = useMemo(makeHoverStore, []);
  useEffect(() => { groupHover.set(null); }, [activeTab, groupHover]);

  // ─── Render ───────────────────────────────────────────────────────────────
  const everyoneElse = knownUsers == null ? null
    : Math.max(0, knownUsers - manualPeople - groups.reduce((a, g) => a + (g.memberCount || 0), 0)) || null;

  const drawerSure = drawerInfo?.adState === 'ok';
  const drawerRole = !drawerInfo ? null
    : drawerSure ? roleOfIds(drawerInfo.roleIds)
      : drawerInfo.adState === 'pending' ? CHECKING_ROLE : UNKNOWN_ROLE;
  const accessInfo = accessFor ? describe(accessFor.email) : null;

  return (
    <div className="um" ref={rootRef}>
      {/* ═══ Header ═══ */}
      <section className="um-hero">
        <div className="um-hero-inner">
          <div className="um-top">
            <img src="/sh_logo.png" alt="GRA SmartHub" draggable={false} />
            <span className="um-vr" />
            <div>
              <div className="um-t1">User Management</div>
              <div className="um-t2">Access control · Global Regulatory Affairs</div>
            </div>
            <div className="um-cta">
              {canManageUsers ? (
                <button type="button" className="um-btn um-btn-primary" onClick={() => openAssign(null)}>
                  <Ico src={personIcon} /> Assign roles <span className="um-arr">→</span>
                </button>
              ) : null}
              {canManageRoles ? (
                <button type="button" className="um-btn um-btn-ghost" onClick={() => setRoleEditor({ roleId: null })}>
                  <Ico src={addIcon} /> Create role
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* ═══ Tab bar ═══ */}
      <div className={`um-bar ${stuck ? 'um-stuck' : ''}`} ref={barRef}>
        <div className="um-seg" ref={tabsRef} role="tablist" aria-label="User management sections">
          <span className="um-pill" style={{ width: pill.width, transform: `translateX(${pill.left}px)` }} />
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              data-tab={t.id}
              className={activeTab === t.id ? 'um-on' : ''}
              onClick={() => { if (activeTab !== t.id) setTab(t.id); }}
            >
              <Ico src={t.icon} />
              <span className="um-lbl-long">{t.label}</span>
              <span className="um-lbl-short">{t.short || t.label}</span>
              <span className="um-n">{t.id === 'groups' ? Object.keys(AD_GROUP_ROLES).length : t.id === 'roles' ? roleIds.length : managedEmails.length}</span>
            </button>
          ))}
        </div>
        <div className="um-bar-right"><span>Press</span><span className="um-kbd">/</span><span>to find anyone</span></div>
      </div>

      <main className="um-main">
        {/* ═══ Access Map ═══ */}
        {activeTab === 'groups' ? (
          <section className="um-panel" key="groups">
            <div className="um-subhead um-subhead-first"><h3>Security groups</h3><small>{plural(Object.keys(AD_GROUP_ROLES).length, 'group')} mapped to roles</small><hr /></div>
            {groupsState === 'loading' && !groups.length ? (
              <div className="um-ggrid">{[0, 1].map((i) => <div key={i} className="um-card um-skel-card"><span /><span /><span /></div>)}</div>
            ) : groupsState === 'error' ? (
              <div className="um-glass"><EmptyState icon={alertIcon} title="Couldn’t load groups" text={groupsError}>
                <button type="button" className="um-btn um-btn-primary um-btn-sm" onClick={loadGroups}>Try again</button>
              </EmptyState></div>
            ) : !groups.length ? (
              <div className="um-glass"><EmptyState icon={communityIcon} title="No AD groups mapped" text="Set the AD group names in the environment config to map them to roles." /></div>
            ) : (
              <div className="um-ggrid">
                {groups.map((g, k) => {
                  const role = roles[g.role];
                  return (
                    <article
                      key={g.key}
                      className="um-card um-gcard"
                      style={{ '--k': k, '--c': role?.color || '#a39992' }}
                      onMouseEnter={() => groupHover.set(g.key)}
                      onMouseLeave={() => groupHover.set(null)}
                    >
                      <div className="um-flow">
                        <span className="um-gtile"><Ico src={communityIcon} /></span>
                        <span className="um-track"><span>grants</span><i /><i /></span>
                        <span className="um-rtile"><Ico src={shieldIcon} /></span>
                      </div>
                      <div className="um-gnames">
                        <div className="um-gn"><b title={g.name}>{g.name}</b><small>{g.missing ? 'Not found in the directory' : g.description || g.mail || 'Security group'}</small></div>
                        <div className="um-gn"><b>{role?.name || g.role}</b><small>{countOn(role?.permissions)} of {TOTAL_PERMISSIONS} permissions</small></div>
                      </div>
                      <div className="um-gfoot">
                        <div className="um-stack">
                          {g.sample.slice(0, 5).map((m) => <Avatar key={m.email || m.name} name={m.name} photo={photoFor(m)} size="sm" />)}
                          <span className="um-more">{g.memberCount == null ? (g.missing ? '—' : 'Members') : <><b>{g.memberCount}</b> {g.memberCount === 1 ? 'member' : 'members'}</>}</span>
                        </div>
                        <button type="button" className="um-btn um-btn-ghost um-btn-sm" onClick={() => setMembersOf(g)} disabled={g.missing}>
                          <Ico src={communityIcon} /> View members
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            <div className="um-sec-head um-tight um-map-head">
              <div>
                <div className="um-k">Access map</div>
                <h2>Where access comes from, <em>and where it goes.</em></h2>
                <p>AD groups and manual assignments feed roles, and roles open features. Ribbon width shows how many people. Hover anything to trace its path, click to open it.</p>
              </div>
              <div className="um-sec-tools">
                <button type="button" className="um-btn um-btn-ghost um-btn-sm" onClick={loadGroups} disabled={groupsState === 'loading'}>
                  <Ico src={refreshIcon} className={groupsState === 'loading' ? 'um-spinning' : ''} /> Re-sync groups
                </button>
              </div>
            </div>

            <AccessMap
              groups={groups}
              roles={roles}
              manualCounts={manualCounts}
              manualPeople={manualPeople}
              everyoneElse={everyoneElse}
              hoverStore={groupHover}
              onOpen={openFromMap}
            />
          </section>
        ) : null}

        {/* ═══ Roles & Permissions ═══ */}
        {activeTab === 'roles' ? (
          <section className="um-panel" key="roles">
            <div className="um-sec-head">
              <div>
                <div className="um-k">Roles &amp; permissions</div>
                <h2>Roles, <em>shaped to fit.</em></h2>
                <p>{plural(roleIds.length, 'role')} across {PERMISSION_GROUPS.length} features. Switch to the matrix to compare them side by side.</p>
              </div>
              <div className="um-sec-tools">
                {rolesView === 'matrix' && canManageRoles ? (
                  <label className="um-edit-toggle">
                    <Switch on={rolesEdit} onClick={() => setRolesEdit((v) => !v)} label="Edit roles in place" small />Edit in place
                  </label>
                ) : null}
                <Segmented value={rolesView} onChange={setView} label="Roles view" options={[{ id: 'cards', label: 'Cards' }, { id: 'matrix', label: 'Matrix' }]} />
                {canManageRoles ? (
                  <button type="button" className="um-btn um-btn-primary um-btn-sm" onClick={() => setRoleEditor({ roleId: null })}>
                    <Ico src={addIcon} /> Create role
                  </button>
                ) : null}
              </div>
            </div>

            {rolesView === 'cards' ? (
              <div className="um-rgrid">
                {roleIds.map((id, k) => {
                  const r = roles[id];
                  const builtin = BUILTIN_ROLE_IDS.includes(id);
                  const modified = builtin && !!customRoles[id];
                  const adMapped = groups.some((g) => g.role === id) || Object.values(AD_GROUP_ROLES).includes(id);
                  const faces = facesFor(id);
                  const n = Math.max(holders(id), faces.length);
                  const shown = faces.slice(0, 4);
                  const rest = n - shown.length;
                  return (
                    <article key={id} className="um-card um-rcard" style={{ '--k': Math.min(k, 12), '--c': r.color || '#a39992' }}>
                      <div className="um-rtop">
                        <span className="um-rtile"><Ico src={shieldIcon} /></span>
                        {canManageRoles ? (
                          <div className="um-ractions">
                            <button type="button" className="um-iconbtn" title="Edit role" aria-label={`Edit ${r.name}`} onClick={() => setRoleEditor({ roleId: id })}><Ico src={editIcon} /></button>
                            {modified ? <button type="button" className="um-iconbtn" title="Reset to default" aria-label={`Reset ${r.name}`} onClick={() => askResetRole(id)}><Ico src={refreshIcon} /></button> : null}
                            {!builtin ? <button type="button" className="um-iconbtn um-danger" title="Delete role" aria-label={`Delete ${r.name}`} onClick={() => askDeleteRole(id)}><Ico src={trashIcon} /></button> : null}
                          </div>
                        ) : null}
                      </div>
                      <h3>{r.name || id}</h3>
                      <div className="um-rtags">
                        {id === DEFAULT_ROLE ? <span className="um-tag">Default role</span> : null}
                        {builtin && !modified && id !== DEFAULT_ROLE ? <span className="um-tag">{adMapped ? 'AD mapped' : 'Built-in'}</span> : null}
                        {modified ? <span className="um-tag um-red">Modified</span> : null}
                        {!builtin ? <span className="um-tag um-blue">Custom</span> : null}
                      </div>
                      <p>{r.description || 'No description yet.'}</p>
                      <div className="um-rmeter">
                        <Gauge on={countOn(r.permissions)} color={r.color || '#a39992'} />
                        <div className="um-rinfo">
                          <div className="um-l1"><b>{countOn(r.permissions)}</b> of {TOTAL_PERMISSIONS} permissions · <b>{featuresOn(r.permissions)}</b> {featuresOn(r.permissions) === 1 ? 'feature' : 'features'}</div>
                          <FeatureBars perms={r.permissions} />
                        </div>
                      </div>
                      {adElsewhere[id]?.length ? (
                        <div className="um-relse" title={elsewhereNote(adElsewhere[id])}>
                          {plural(adElsewhere[id].length, 'person', 'people')} in its AD group {adElsewhere[id].length === 1 ? 'has' : 'have'} another role
                        </div>
                      ) : null}
                      <div className="um-rpeople">
                        <div className="um-stack" title={`${plural(n, 'person', 'people')}${adMapped ? ' incl. AD group' : ''}`}>
                          {n === 0 ? <span className="um-more">No one yet</span> : null}
                          {shown.map(({ p, photo }) => <Avatar key={p.email || p.name} name={p.name} photo={photo} size="sm" title={p.name} />)}
                          {rest > 0 ? <span className="um-av um-av-sm um-av-more">+{rest}</span> : null}
                        </div>
                        <button type="button" className="um-link" onClick={() => setTab('users', null, { role: id, scope: 'all', page: null })}>
                          See who <Ico src={chevronRightIcon} />
                        </button>
                      </div>
                    </article>
                  );
                })}
                {canManageRoles ? (
                  <button type="button" className="um-newcard" style={{ '--k': Math.min(roleIds.length, 12) }} onClick={() => setRoleEditor({ roleId: null })}>
                    <span className="um-plus"><Ico src={addIcon} /></span>
                    <b>Create a new role</b>
                    <small>Pick exactly what it can reach</small>
                  </button>
                ) : null}
              </div>
            ) : (
              <RolesMatrix
                roles={roles}
                roleIds={roleIds}
                editing={rolesEdit && canManageRoles}
                onToggle={toggleRolePermission}
                onNeedEdit={needRolesEdit}
                focusKey={roleFocus}
              />
            )}

            <div className="um-glass um-adpanel">
              <div className="um-adhead">
                <span className="um-gtile um-gtile-sm"><Ico src={communityIcon} /></span>
                <div><b>Active Directory group mappings</b><small>Automatic role assignments from security groups</small></div>
              </div>
              {Object.entries(AD_GROUP_ROLES).length ? Object.entries(AD_GROUP_ROLES).map(([ref, roleId]) => {
                const g = groups.find((x) => x.key === ref);
                return (
                  <div key={ref} className="um-adrow" style={{ '--c': roles[roleId]?.color || '#a39992' }}>
                    <code title={ref}>{g?.name || ref}</code>
                    <span className="um-track"><i /></span>
                    <RoleBadge role={roles[roleId] || { name: roleId }} />
                  </div>
                );
              }) : <div className="um-adrow"><span className="um-muted-text">No AD groups are mapped in this environment.</span></div>}
            </div>
          </section>
        ) : null}

        {/* ═══ Users ═══ */}
        {activeTab === 'users' ? (
          <section className="um-panel" key="users">
            <div className="um-sec-head">
              <div>
                <div className="um-k">People</div>
                <h2>The right people, <em>the right access.</em></h2>
                <p>{usersView === 'matrix'
                  ? 'Give someone a little more, or a little less, than their role. Custom access sits on top of the role and stays when the role changes.'
                  : 'Search the whole directory or narrow to people with a manual role or custom access. Click anyone to see exactly what they can reach.'}</p>
              </div>
              <div className="um-sec-tools">
                {usersView === 'matrix' && canManageUsers ? (
                  <label className="um-edit-toggle">
                    <Switch on={usersEdit} onClick={() => setUsersEdit((v) => !v)} label="Edit access in place" small />Edit in place
                  </label>
                ) : null}
                <Segmented value={usersView} onChange={setView} label="Users view" options={[{ id: 'list', label: 'List' }, { id: 'grid', label: 'Cards' }, { id: 'matrix', label: 'Access matrix' }]} />
              </div>
            </div>

            <div className="um-glass um-toolbar">
              <div className="um-trow">
                <SearchField ref={searchInputRef} value={debounced} onSettled={setDebounced} icon={searchIcon} placeholder="Search by name or email…" hint="/" />
                <button type="button" className={`um-toggle ${assignedOnly ? 'um-on' : ''}`} onClick={toggleAssignedOnly} aria-pressed={assignedOnly}>
                  <Switch on={assignedOnly} small />Assigned only <span className="um-count">{managedEmails.length}</span>
                </button>
                <RoleFilter roleIds={roleIds} roles={roles} counts={roleCounts} value={roleFilter} onChange={setRoleFilter} />
                <span className="um-count-note">
                  {localMode ? <><b>{localRows.length}</b> {localRows.length === 1 ? 'person' : 'people'}</> : dir.state === 'ready' ? <>Directory · page <b>{dir.page + 1}</b></> : null}
                </span>
              </div>
            </div>

            {activeTab === 'users' && groupsState === 'error' ? (
              <div className="um-notice" role="alert">
                <Ico src={alertIcon} />
                <span>AD groups didn’t load, so roles that come from an AD group can’t be shown right now.</span>
                <button type="button" className="um-link" onClick={loadGroups}><Ico src={refreshIcon} /> Try again</button>
              </div>
            ) : filterNeedsAd && adMembers.state === 'error' ? (
              <div className="um-notice" role="alert">
                <Ico src={alertIcon} />
                <span>Couldn’t read the AD group members, so only people given this role by hand are listed. {adMembers.error}</span>
                <button type="button" className="um-link" onClick={loadAdMembers}><Ico src={refreshIcon} /> Try again</button>
              </div>
            ) : filterNeedsAd && adMembers.state === 'loading' && localRows.length ? (
              <div className="um-notice um-notice-info" role="status">
                <Spinner />
                <span>Adding people who get this role from their AD group…</span>
              </div>
            ) : unknownRows.length ? (
              <div className="um-notice" role="alert">
                <Ico src={alertIcon} />
                <span>Couldn’t check the AD groups for {plural(unknownRows.length, 'person', 'people')}, so their role shows as unknown.</span>
                <button type="button" className="um-link" onClick={() => retryUnknown(unknownRows)}><Ico src={refreshIcon} /> Try again</button>
              </div>
            ) : null}

            {activeTab === 'users' && elsewhereForFilter.length ? (
              <div className="um-notice um-notice-info" role="status">
                <Ico src={communityIcon} />
                <span title={elsewhereNote(elsewhereForFilter)}>
                  {plural(elsewhereForFilter.length, 'person', 'people')} in {roleFilter.length === 1 ? 'this role’s' : 'these roles’'} AD group {elsewhereForFilter.length === 1 ? 'has' : 'have'} another role
                  {' '}({[
                    elsewhereForFilter.filter((x) => x.how === 'manual').length && `${elsewhereForFilter.filter((x) => x.how === 'manual').length} given by hand`,
                    elsewhereForFilter.filter((x) => x.how === 'ad').length && `${elsewhereForFilter.filter((x) => x.how === 'ad').length} from a higher AD group`,
                  ].filter(Boolean).join(', ')}){showElsewhere ? ', shown below with their actual role.' : ', so they aren’t listed.'}
                </span>
                <button type="button" className="um-link" onClick={() => setShowElsewhere((v) => !v)}>{showElsewhere ? 'Hide them' : 'Show them'}</button>
              </div>
            ) : null}

            {!localMode && dir.state === 'error' ? (
              <div className="um-glass">
                <EmptyState icon={alertIcon} title="Couldn’t load the directory" text={dir.error}>
                  <button type="button" className="um-btn um-btn-primary um-btn-sm" onClick={reloadDirectory}>Try again</button>
                  <ul className="um-hints"><li>Sign out and back in to refresh permissions</li><li>Ask IT to grant User.Read.All</li><li>Check admin consent for this application</li></ul>
                </EmptyState>
              </div>
            ) : (!localMode && (dir.state === 'loading' || dir.state === 'idle') && !dir.users.length)
              || (localMode && filterNeedsAd && (adMembers.state === 'loading' || adMembers.state === 'idle') && !localRows.length) ? (
              <div className="um-glass um-table-wrap">
                <table className="um-table"><tbody className="um-skel">
                  {Array.from({ length: 6 }, (_, i) => (
                    <tr key={i}><td><div className="um-who"><span className="um-sav" /><div><span style={{ width: 150 }} /><span style={{ width: 90, height: 9, marginTop: 6 }} /></div></div></td><td className="um-hide-sm"><span style={{ width: 190 }} /></td><td className="um-hide-md"><span style={{ width: 120 }} /></td><td><span style={{ width: 110, height: 22, borderRadius: 999 }} /></td><td /></tr>
                  ))}
                </tbody></table>
              </div>
            ) : !rows.length ? (
              <div className="um-glass">
                <EmptyState
                  icon={searchIcon}
                  title={debounced ? 'No one matches that search'
                    : roleFilter.length === 1 ? `Nobody holds ${roles[roleFilter[0]]?.name || 'this role'} by hand yet`
                      : roleFilter.length ? 'Nobody holds these roles by hand yet' : 'No manual assignments yet'}
                  text={roleFilter.length && !debounced ? 'Assign one to someone, or look at the AD groups on the Access Map.' : 'Try another name, or switch off “Assigned only” to search the whole directory.'}
                />
              </div>
            ) : usersView === 'matrix' ? (
              <UsersMatrix
                rows={rows}
                editing={usersEdit && canManageUsers}
                canEdit={canManageUsers}
                onSet={setPersonPermission}
                onResetFeature={resetPersonFeature}
                onOpenPerson={setDrawerEmail}
                onOpenFull={openAccess}
                onNeedEdit={needUsersEdit}
              />
            ) : usersView === 'grid' ? (
              <div className={`um-pgrid ${dir.state === 'loading' && !localMode ? 'um-refreshing' : ''}`}>
                {rows.map((r, k) => (
                  <button key={r.email} type="button" className="um-pcard" style={{ '--k': Math.min(k, 12), '--c': r.role?.color || '#cbc4bc' }} onClick={() => setDrawerEmail(r.email)}>
                    <Avatar name={r.name} photo={r.photo} size="xl" />
                    <b>{r.name}</b>
                    <small>{r.person.jobTitle || r.email}</small>
                    <small>{r.person.department || '—'}</small>
                    <span className="um-pcard-badges"><RoleBadges badges={r.badges} muted={r.adState !== 'ok'} /><CustomChip counts={r.counts} /></span>
                  </button>
                ))}
              </div>
            ) : (
              <div className={`um-glass um-table-wrap ${dir.state === 'loading' && !localMode ? 'um-refreshing' : ''}`}>
                <table className="um-table">
                  <thead>
                    <tr><th>User</th><th className="um-hide-sm">Email</th><th className="um-hide-md">Department</th><th>Role</th><th><span className="um-sr">Actions</span></th></tr>
                  </thead>
                  <tbody>
                    {rows.map((r, k) => (
                      <tr key={r.email} style={{ '--k': Math.min(k, 12), '--c': r.role?.color || '#cbc4bc' }} onClick={() => setDrawerEmail(r.email)}>
                        <td>
                          <div className="um-who">
                            <Avatar name={r.name} photo={r.photo} />
                            <div className="um-who-t"><b>{r.name}</b>{r.person.jobTitle ? <small>{r.person.jobTitle}</small> : null}</div>
                          </div>
                        </td>
                        <td className="um-hide-sm">{r.email}</td>
                        <td className="um-hide-md">{r.person.department || '—'}</td>
                        <td><span className="um-rolecell"><RoleBadges badges={r.badges} muted={r.adState !== 'ok'} /><CustomChip counts={r.counts} /></span></td>
                        <td>
                          <div className="um-rowacts">
                            <button type="button" className="um-iconbtn" aria-label={`Open ${r.name}`} title="Open profile" onClick={(e) => { e.stopPropagation(); setDrawerEmail(r.email); }}><Ico src={chevronRightIcon} /></button>
                            {canManageUsers ? (
                              <>
                                <button type="button" className="um-iconbtn" aria-label={`${r.manualRole ? 'Change roles' : 'Assign roles'} for ${r.name}`} title={r.manualRole ? 'Change roles' : 'Assign roles'} onClick={(e) => { e.stopPropagation(); openAssign(r.email); }}><Ico src={editIcon} /></button>
                                {r.manualRole ? <button type="button" className="um-iconbtn um-danger" aria-label={`Remove roles given by hand from ${r.name}`} title="Remove roles given by hand" onClick={(e) => { e.stopPropagation(); askRemoveRole(r.email); }}><Ico src={trashIcon} /></button> : null}
                              </>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {rows.length && (localMode ? localPages > 1 : dir.state !== 'error' && (dir.page > 0 || dir.hasNext)) ? (
              <div className="um-glass um-pager">
                <button type="button" className="um-btn um-btn-ghost um-btn-sm" onClick={localMode ? () => setLocalPage(pageNo - 1) : dirPrev} disabled={localMode ? pageNo === 1 : dir.page === 0 || dir.state === 'loading'}>
                  <Ico src={chevronLeftIcon} /> Previous
                </button>
                <span className="um-pg">{dir.state === 'loading' && !localMode ? <Spinner /> : null} Page <b>{localMode ? pageNo : dir.page + 1}</b>{localMode ? ` of ${localPages}` : ''}</span>
                <button type="button" className="um-btn um-btn-ghost um-btn-sm" onClick={localMode ? () => setLocalPage(pageNo + 1) : dirNext} disabled={localMode ? pageNo === localPages : !dir.hasNext || dir.state === 'loading'}>
                  Next <Ico src={chevronRightIcon} />
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
      </main>

      <div className="um-foot">Manual role assignments take precedence over AD group mappings · Changes are recorded in the audit log</div>

      {/* ═══ Overlays ═══ */}
      {drawerInfo ? (
        <UserDrawer
          key={`drawer:${drawerInfo.email}`}
          person={{ ...drawerInfo.person, photo: photoFor(drawerInfo.person) }}
          role={drawerRole}
          badges={drawerSure ? badgesFor(drawerInfo) : [{ role: drawerRole, note: null }]}
          manualRoles={drawerInfo.manualRoles.map((id) => roles[id]?.name || id)}
          keepAd={drawerInfo.keepAd}
          adRoleName={drawerInfo.adRole ? roles[drawerInfo.adRole]?.name || drawerInfo.adRole : null}
          source={drawerInfo.source}
          adState={drawerInfo.adState}
          overrides={drawerInfo.overrides}
          access={drawerSure ? effectiveAccess(drawerRole?.permissions, drawerInfo.overrides) : {}}
          canManageUsers={canManageUsers}
          loadProfile={loadProfile}
          onAssign={() => openAssign(drawerInfo.email)}
          onCustom={() => openAccess(drawerInfo.email, true)}
          onRemove={() => askRemoveRole(drawerInfo.email)}
          onClose={() => setDrawerEmail(null)}
        />
      ) : null}

      {assignFor !== undefined ? (
        <AssignRoleModal
          person={assignFor ? { ...describe(assignFor).person } : null}
          roles={roles}
          roleIds={roleIds}
          holders={holders}
          describe={(email) => {
            const d = describe(email);
            return {
              manualRole: d.manualRole, manualRoles: d.manualRoles, keepAd: d.keepAd, hasEntry: d.manualRoles.length > 0,
              roleIds: d.roleIds, adRole: d.adRole, adRoleAny: d.adRoleAny, adKnown: d.adKnown, adState: d.adState, overrides: d.overrides,
            };
          }}
          searchPeople={searchPeople}
          photoFor={photoFor}
          canGrant={canGrant}
          roleOfIds={roleOfIds}
          onConfirm={confirmAssign}
          onClose={() => setAssignFor(undefined)}
        />
      ) : null}

      {accessInfo ? (
        <UserAccessEditor
          key={`access:${accessInfo.email}`}
          person={{ ...accessInfo.person, photo: photoFor(accessInfo.person) }}
          role={roleOfIds(accessInfo.roleIds)}
          roleNote={accessInfo.source === 'ad' ? 'via AD group' : accessInfo.source === 'default' ? 'default' : null}
          initialOverrides={accessInfo.overrides}
          canGrant={canGrant}
          onSave={(overrides) => saveAccess(accessInfo.email, overrides)}
          onClose={() => { const back = accessFor.back; setAccessFor(null); if (back) setDrawerEmail(accessInfo.email); }}
        />
      ) : null}

      {roleEditor ? (
        <RoleEditor key={`role:${roleEditor.roleId || 'new'}`} roleId={roleEditor.roleId} roles={roles} canGrant={canGrant} onSave={saveRole} onClose={() => setRoleEditor(null)} />
      ) : null}

      {membersOf ? <GroupMembersModal group={membersOf} role={roles[membersOf.role]} onClose={() => setMembersOf(null)} /> : null}

      {confirm ? (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          busy={confirmBusy}
          onConfirm={runConfirm}
          onCancel={() => setConfirm(null)}
        />
      ) : null}

      <Toasts toasts={toasts} />
    </div>
  );
}