import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAuth } from './AuthContext';
import { apiFetch } from '../utils/apiClient';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// AD Group to Role Mapping — group names loaded from .env (VITE_AD_GROUP_*)
// Each entry is only included if the corresponding env var is set.
const AD_GROUP_ROLES = {
  ...(import.meta.env.VITE_AD_GROUP_ADMIN         && { [import.meta.env.VITE_AD_GROUP_ADMIN]:         'admin'         }),
  ...(import.meta.env.VITE_AD_GROUP_DQE_RIGHTTIME_SUPERUSER && { [import.meta.env.VITE_AD_GROUP_DQE_RIGHTTIME_SUPERUSER]: 'dqe_righttime_superuser' }),
  ...(import.meta.env.VITE_AD_GROUP_IT_VIEWER  && { [import.meta.env.VITE_AD_GROUP_IT_VIEWER]:  'it_viewer'  }),
};

// One per document-set tab on the Unstructured Explorer (auth.py UNSTRUCTURED_TABS)
export const UNSTRUCTURED_TABS = {
  vr: 'viewUnstructuredVR',
  immbot: 'viewUnstructuredIMMBOT',
  mirai: 'viewUnstructuredMirAI',
  rmwcreate: 'viewUnstructuredRMWCreate',
  haq: 'viewUnstructuredHAQ',
  nipo: 'viewUnstructuredNipo',
  rimdocs: 'viewUnstructuredRimDocs',
  epod: 'viewUnstructuredEPOD',
  fda: 'viewUnstructuredFDA',
};
// Sub-tabs inside each document set (auth.py UNSTRUCTURED_SUBTABS), by doc id then sub-tab id
export const UNSTRUCTURED_SUBTABS = {
  vr: { internal: 'viewUnstructuredVRInternal', external: 'viewUnstructuredVRExternal' },
  immbot: { explore: 'viewUnstructuredIMMBOTExplore', table: 'viewUnstructuredIMMBOTTable', breakdown: 'viewUnstructuredIMMBOTBreakdown' },
  rimdocs: { overview: 'viewUnstructuredRimDocsExplore', table: 'viewUnstructuredRimDocsTable', breakdown: 'viewUnstructuredRimDocsBreakdown' },
  epod: { explore: 'viewUnstructuredEPODExplore', table: 'viewUnstructuredEPODTable' },
  nipo: { explore: 'viewUnstructuredNipoExplore', table: 'viewUnstructuredNipoTable' },
  fda: { explore: 'viewUnstructuredFDAExplore', table: 'viewUnstructuredFDATable' },
};
// parent -> children added after roles were first saved, parents first (auth.py UNSTRUCTURED_GROUPS)
const TAB_GROUPS = [
  ['viewUnstructured', Object.values(UNSTRUCTURED_TABS)],
  ...Object.entries(UNSTRUCTURED_SUBTABS).map(([id, subs]) => [UNSTRUCTURED_TABS[id], Object.values(subs)]),
];
const tabPerms = (on) => Object.fromEntries(TAB_GROUPS.flatMap(([, kids]) => kids.map(k => [k, on])));

// Role Definitions with permissions
const ROLE_DEFINITIONS = {
  admin: {
    name: 'Admin',
    description: 'Full access to all features including user management',
    color: '#eb1700',
    permissions: {
      viewDashboard: true,
      viewDQE: true,
      viewITChecks: true,
      runITChecks: true,
      viewDataValidation: true,
      runDataValidation: true,
      viewBusinessChecks: true,
      viewFuzzyMatch: true,
      viewData: true,
      viewMetadata: true,
      viewAIChatbot: true,
      viewDataTypeValidation: true,
      viewRAG: true,
      viewEPodRAG: true,
      viewRimDocsRAG: true,
      viewRimDocsAgentic: true,
      viewUnstructured: true,
      viewGraDataDomains: true,
      editGraDataDomains: true,
      viewUnstructuredSQL: true,
      runUnstructuredQueryRunner: true,
      runPostgresQueryRunner: true,
      viewDataStudio: true,
      runSnowflakeQueryRunner: true,
      runS3Explorer: true,
      runStreamsetsExtractor: true,
      viewStreamsetsSecrets: true,
      viewPGindexer: true,
      buildPGindexer: true,
      viewAudit: true,
      viewUserManagement: true,
      manageUsers: true,
      manageRoles: true,
      runBDCOperations: true,
      viewBDCSuperuser: true,
      viewBDCExecutive: true,
      viewAssistantAvatar: true,
      manageDataAPIExports: true,
      sendCommunications: true,
      ...tabPerms(true)
    }
  },
  dqe_righttime_superuser: {
    name: 'DQE - RightTime Super User',
    description: 'Full Access to data quality engine business defined checks',
    color: '#328714',
    permissions: {
      viewDashboard: true,
      viewDQE: true,
      viewITChecks: false,
      runITChecks: false,
      viewDataValidation: false,
      runDataValidation: false,
      viewBusinessChecks: true,
      runBDCOperations: true,
      viewBDCSuperuser: true,
      viewBDCExecutive: true,
      viewFuzzyMatch: false,
      viewData: false,
      viewMetadata: false,
      viewAIChatbot: false,
      viewDataTypeValidation: false,
      viewRAG: false,
      viewEPodRAG: false,
      viewRimDocsRAG: false,
      viewRimDocsAgentic: false,
      viewUnstructured: false,
      viewGraDataDomains: false,
      editGraDataDomains: false,
      viewUnstructuredSQL: false,
      runUnstructuredQueryRunner: false,
      runPostgresQueryRunner: false,
      viewDataStudio: false,
      runSnowflakeQueryRunner: false,
      runS3Explorer: false,
      runStreamsetsExtractor: false,
      viewStreamsetsSecrets: false,
      viewPGindexer: false,
      buildPGindexer: false,
      viewAudit: false,
      viewUserManagement: false,
      manageUsers: false,
      manageRoles: false,
      viewAssistantAvatar: false,
      manageDataAPIExports: false,
      sendCommunications: false,
      ...tabPerms(false)
    }
  },
  it_viewer: {
    name: 'DQE - IT User',
    description: 'Read-only access to data quality engine business defined checks and IT checks',
    color: '#ff6017',
    permissions: {
      viewDashboard: true,
      viewDQE: true,
      viewITChecks: true,
      runITChecks: false,
      viewDataValidation: true,
      runDataValidation: false,
      viewBusinessChecks: true,
      runBDCOperations: false,
      viewBDCSuperuser: false,
      viewBDCExecutive: false,
      viewFuzzyMatch: false,
      viewData: false,
      viewMetadata: false,
      viewAIChatbot: false,
      viewDataTypeValidation: false,
      viewRAG: false,
      viewEPodRAG: false,
      viewRimDocsRAG: false,
      viewRimDocsAgentic: false,
      viewUnstructured: false,
      viewGraDataDomains: false,
      editGraDataDomains: false,
      viewUnstructuredSQL: false,
      runUnstructuredQueryRunner: false,
      runPostgresQueryRunner: false,
      viewDataStudio: false,
      runSnowflakeQueryRunner: false,
      runS3Explorer: false,
      runStreamsetsExtractor: false,
      viewStreamsetsSecrets: false,
      viewPGindexer: false,
      buildPGindexer: false,
      viewAudit: false,
      viewUserManagement: false,
      manageUsers: false,
      manageRoles: false,
      viewAssistantAvatar: false,
      manageDataAPIExports: false,
      sendCommunications: false,
      ...tabPerms(false)
    }
  },
  viewer: {
    name: 'No access',
    description: 'Read-only access to dashboard',
    color: '#a39992',
    permissions: {
      viewDashboard: true,
      viewDQE: false,
      viewITChecks: false,
      runITChecks: false,
      viewDataValidation: false,
      runDataValidation: false,
      viewBusinessChecks: false,
      viewFuzzyMatch: false,
      viewData: false,
      viewMetadata: false,
      viewAIChatbot: false,
      viewDataTypeValidation: false,
      viewRAG: false,
      viewEPodRAG: false,
      viewRimDocsRAG: false,
      viewRimDocsAgentic: false,
      viewUnstructured: false,
      viewGraDataDomains: false,
      editGraDataDomains: false,
      viewUnstructuredSQL: false,
      runUnstructuredQueryRunner: false,
      runPostgresQueryRunner: false,
      viewDataStudio: false,
      runSnowflakeQueryRunner: false,
      runS3Explorer: false,
      runStreamsetsExtractor: false,
      viewStreamsetsSecrets: false,
      viewPGindexer: false,
      buildPGindexer: false,
      viewAudit: false,
      viewUserManagement: false,
      manageUsers: false,
      manageRoles: false,
      runBDCOperations: false,
      viewBDCSuperuser: false,
      viewBDCExecutive: false,
      viewAssistantAvatar: false,
      manageDataAPIExports: false,
      sendCommunications: false,
      ...tabPerms(false)
    }
  }
};

const RBACContext = createContext();

// Error text from an API reply. FastAPI sends `detail` as a string for our own
// errors and as a list of objects for body validation errors.
const readError = async (response, fallback) => {
  const data = await response.json().catch(() => ({}));
  const { detail } = data || {};
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && detail.length) return detail.map((d) => d?.msg || String(d)).join('; ');
  return `${fallback} (HTTP ${response.status})`;
};

const BUILTIN_IDS = ['admin', 'dqe_righttime_superuser', 'it_viewer', 'viewer'];

// Same upgrade rule as the backend (auth.py with_data_studio_access): roles
// saved before Data Studio had its own section get page access if they had
// either tool turned on.
const DATA_STUDIO_TOOLS = ['runSnowflakeQueryRunner', 'runS3Explorer', 'viewPGindexer', 'runStreamsetsExtractor'];

const withDataStudioAccess = (roles) => Object.fromEntries(
  Object.entries(roles || {}).map(([id, role]) => {
    let perms = role?.permissions;
    if (!perms) return [id, role];
    if (!('viewDataStudio' in perms)) perms = { ...perms, viewDataStudio: DATA_STUDIO_TOOLS.some(k => perms[k] === true) };
    // Same as auth.py with_unstructured_tabs: children missing from older roles follow their parent
    TAB_GROUPS.forEach(([parent, kids]) => {
      if (!kids.some(k => k in perms)) perms = { ...perms, ...Object.fromEntries(kids.map(k => [k, perms[parent] === true])) };
    });
    return perms === role.permissions ? [id, role] : [id, { ...role, permissions: perms }];
  })
);

// Same as auth.py apply_user_overrides: an older grant of a parent meant all its children
const withTabOverrides = (all) => Object.fromEntries(
  Object.entries(all || {}).map(([email, o]) => {
    let add = o?.add || [];
    const remove = o?.remove || [];
    TAB_GROUPS.forEach(([parent, kids]) => {
      if (add.includes(parent) && !kids.some(k => add.includes(k) || remove.includes(k))) add = [...add, ...kids];
    });
    return [email, add === (o?.add || []) ? o : { ...o, add }];
  })
);

const requirePermission = (ref, permission, message) => {
  if (!ref.current(permission)) throw new Error(message);
};

const send = async (path, init, fallback) => {
  const response = await apiFetch(path, init);
  if (!response.ok) throw new Error(await readError(response, fallback));
  return response.json().catch(() => ({}));
};

const jsonInit = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const RBACProvider = ({ children }) => {
  const { user, loading: authLoading } = useAuth();
  const [customRoles, setCustomRoles] = useState({});
  const [builtinDefaults, setBuiltinDefaults] = useState(null);
  const [userRoleOverrides, setUserRoleOverrides] = useState({});
  // email -> { roles: [...], keep_ad } : roles given by hand, several allowed
  const [userRoles, setUserRoles] = useState({});
  const [userPermissionOverrides, setUserPermissionOverrides] = useState({});
  const [overridesLoaded, setOverridesLoaded] = useState(false);
  const [serverRole, setServerRole] = useState(null);
  const [serverRoles, setServerRoles] = useState(null);
  const [serverPermissions, setServerPermissions] = useState(null);
  // Group -> role map the API enforces with. The VITE_ one is only a fallback
  // for an older backend that doesn't send it.
  const [serverAdGroups, setServerAdGroups] = useState(null);

  // Set when the very first read fails for good. Routes show a retry screen on
  // it instead of treating the user as a Viewer and bouncing them to the
  // dashboard, which is what a refresh did whenever this call hiccuped.
  const [configError, setConfigError] = useState(null);
  const everLoaded = useRef(false);

  // Writes each trigger a re-read; only the newest read may land, so a slow
  // older response can't overwrite a newer one.
  const loadSeq = useRef(0);
  const loadRBACConfig = useCallback(async () => {
    const seq = ++loadSeq.current;
    let failure = null;
    // Right after a refresh the token or the API can be a beat behind, so a
    // failed read is tried a few more times before giving up.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      if (seq !== loadSeq.current) return;
      try {
        const response = await apiFetch(`/api/rbac/config`);
        if (seq !== loadSeq.current) return;
        // apiFetch has already retried a 401 and sent the browser to sign in
        if (response.status === 401) return;
        if (!response.ok) {
          failure = new Error(`Permission check failed (HTTP ${response.status})`);
          // A real refusal won't change on retry; timeouts, throttling and 5xx might
          if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
          continue;
        }
        const data = await response.json();
        if (seq !== loadSeq.current) return;
        if (!data.success || !data.config) {
          failure = new Error('Permission check returned an unexpected answer');
          break;
        }
        setCustomRoles(withDataStudioAccess(data.config.custom_roles));
        setUserRoleOverrides(data.config.user_role_overrides || {});
        setUserRoles(data.config.user_roles || Object.fromEntries(
          Object.entries(data.config.user_role_overrides || {}).map(([e, r]) => [e, { roles: [r], keep_ad: false }])
        ));
        setUserPermissionOverrides(withTabOverrides(data.config.user_permission_overrides));
        // The untouched built-ins as the backend defines them. The copy in
        // ROLE_DEFINITIONS above is only a stand-in until this arrives.
        if (data.config.builtin_defaults) setBuiltinDefaults(data.config.builtin_defaults);
        if (data.config.ad_groups && typeof data.config.ad_groups === 'object') {
          const next = data.config.ad_groups;
          // Same content keeps the same object, so pages keyed on it don't reload
          setServerAdGroups((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        }
        // The backend is the authority on the caller's role and permissions —
        // it enforces with them, including any custom access on top of the
        // role. Trusting its answer keeps the UI from disagreeing with the API
        // (see serverRole note below).
        if (data.caller_role) setServerRole(data.caller_role);
        if (Array.isArray(data.caller_roles)) setServerRoles(data.caller_roles);
        if (data.caller_permissions) setServerPermissions(data.caller_permissions);
        everLoaded.current = true;
        setConfigError(null);
        setOverridesLoaded(true);
        return;
      } catch (error) {
        // apiFetch has already sent the browser to sign in; stay on the spinner
        if (error?.redirecting) return;
        failure = error;
      }
    }
    console.error('Error fetching RBAC config:', failure);
    // A failed re-read after a write keeps what we already have
    if (!everLoaded.current) setConfigError(failure?.message || 'Could not check your permissions');
    setOverridesLoaded(true);
  }, []);

  const retryRBACConfig = useCallback(() => {
    setConfigError(null);
    setOverridesLoaded(false);
    loadRBACConfig();
  }, [loadRBACConfig]);

  // Fetch RBAC config from backend on mount
  useEffect(() => {
    loadRBACConfig();
  }, [loadRBACConfig]);

  // After a write, re-read the config so the caller's own permissions follow
  // any change to their role or custom access. Fire-and-forget: the local
  // state is already updated, this only reconciles with the server.
  // Debounced, so a burst of matrix clicks is one re-read, not one per click.
  const refreshTimer = useRef(0);
  const refreshAfterWrite = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { loadRBACConfig(); }, 400);
  }, [loadRBACConfig]);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  // Compute role inline as a derived value — never stale, always in sync with the
  // current render. This eliminates the gap where overrides are loaded but userRole
  // hasn't updated yet (which caused the premature redirect to /dashboard).
  const userRole = useMemo(() => {
    if (!user) return 'viewer';

    // The backend resolves the role from the identity on the access token
    // (Graph `mail`, falling back to `userPrincipalName`). MSAL's
    // account.username is always the UPN, so when a directory has mail !=
    // userPrincipalName the two sides can disagree — the API would grant
    // access while this context still showed 'viewer', hiding the menu items
    // for a user who is in fact allowed to use them. Deferring to the server's
    // answer keeps the UI and the enforcement in lockstep.
    if (serverRole) return serverRole;

    const userEmail = user.email || user.username;

    // 1. Manual override takes highest priority
    if (userRoleOverrides[userEmail?.toLowerCase()]) {
      return userRoleOverrides[userEmail.toLowerCase()];
    }

    // 2. AD group membership
    if (user.groups && user.groups.length > 0) {
      const rolesPriority = ['admin', 'dqe_righttime_superuser', 'it_viewer'];
      for (const priority of rolesPriority) {
        const adGroup = Object.keys(AD_GROUP_ROLES).find(
          group => AD_GROUP_ROLES[group] === priority
        );
        if (adGroup && user.groups.some(g =>
          g.displayName === adGroup || g.id === adGroup
        )) {
          return priority;
        }
      }
    }

    // 3. Default
    return 'viewer';
  }, [user, userRoleOverrides, serverRole]);

  // loading is true until:
  //   - auth has resolved (user object available)
  //   - RBAC config has been fetched (overrides populated)
  // Once both are true, userRole above is guaranteed to be correct.
  const loading = authLoading || !overridesLoaded;

  const adGroupRoles = serverAdGroups || AD_GROUP_ROLES;

  // Built-in defaults with any saved customisations laid over them.
  const allRoles = useMemo(() => ({
    ...(builtinDefaults || ROLE_DEFINITIONS),
    ...customRoles
  }), [builtinDefaults, customRoles]);

  // Get all available roles (built-in + custom)
  const getAllRoles = useCallback(() => allRoles, [allRoles]);

  // Built-in role definitions as shipped, before any customisation
  const getBuiltinDefaults = useCallback(() => builtinDefaults || ROLE_DEFINITIONS, [builtinDefaults]);

  // Get current user's role definition
  const getRoleDefinition = useCallback((roleName = null) => {
    const role = roleName || userRole;
    return allRoles[role] || allRoles.viewer || ROLE_DEFINITIONS.viewer;
  }, [allRoles, userRole]);

  // Check if user has specific permission. Uses the server's answer when we
  // have it (role plus custom access, exactly what the API enforces), and the
  // role definition until then.
  const hasPermission = useCallback((permission) => {
    if (serverPermissions) return serverPermissions[permission] === true;
    return getRoleDefinition().permissions?.[permission] === true;
  }, [serverPermissions, getRoleDefinition]);

  const hasAnyPermission = useCallback((permissions = []) => permissions.some(hasPermission), [hasPermission]);
  const hasAllPermissions = useCallback((permissions = []) => permissions.every(hasPermission), [hasPermission]);

  // True when any of the caller's roles matches
  const hasRole = useCallback((role) => {
    const mine = serverRoles || [userRole];
    return Array.isArray(role) ? role.some((r) => mine.includes(r)) : mine.includes(role);
  }, [serverRoles, userRole]);

  // Writes check the latest permissions without being rebuilt every time they
  // change, so pages can hold on to them (memoised tables stay memoised)
  const hasPermissionRef = useRef(hasPermission);
  hasPermissionRef.current = hasPermission;

  const createCustomRole = useCallback(async (roleId, roleDefinition) => {
    requirePermission(hasPermissionRef, 'manageRoles', 'Insufficient permissions to create roles');
    const data = await send('/api/rbac/roles', jsonInit('POST', { role_id: roleId, role_definition: roleDefinition }), 'Failed to create role');
    // The server cleans the role up (trims, drops sub-permissions whose parent is off), so keep its copy
    setCustomRoles((prev) => ({ ...prev, [roleId]: data.role || roleDefinition }));
    refreshAfterWrite();
    return data;
  }, [refreshAfterWrite]);

  const updateCustomRole = useCallback(async (roleId, updates) => {
    requirePermission(hasPermissionRef, 'manageRoles', 'Insufficient permissions to update roles');
    const data = await send(`/api/rbac/roles/${encodeURIComponent(roleId)}`, jsonInit('PUT', updates), 'Failed to update role');
    setCustomRoles((prev) => ({ ...prev, [roleId]: data.role || updates }));
    refreshAfterWrite();
    return data;
  }, [refreshAfterWrite]);

  const deleteCustomRole = useCallback(async (roleId) => {
    requirePermission(hasPermissionRef, 'manageRoles', 'Insufficient permissions to delete roles');
    const data = await send(`/api/rbac/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' }, 'Failed to delete role');
    setCustomRoles((prev) => {
      const { [roleId]: _gone, ...rest } = prev;
      return rest;
    });
    // Deleting a custom role drops the people assigned to it. Resetting a
    // built-in keeps them, same as the backend.
    // Deleting a custom role takes it off everyone; someone left with none
    // goes back to their AD group. Resetting a built-in keeps them.
    if (!BUILTIN_IDS.includes(roleId)) {
      setUserRoles((prev) => {
        const next = {};
        Object.entries(prev).forEach(([e, entry]) => {
          const roles = entry.roles.filter((r) => r !== roleId);
          if (roles.length) next[e] = { ...entry, roles };
        });
        return next;
      });
      setUserRoleOverrides((prev) => Object.fromEntries(Object.entries(prev).filter(([, r]) => r !== roleId)));
    }
    refreshAfterWrite();
    return data;
  }, [refreshAfterWrite]);

  // roleIds: one role or a list (replaces what they had). keepAd: whether
  // their AD group's role still counts; left out, the server keeps it as it was.
  const assignRoleToUser = useCallback(async (userEmail, roleIds, keepAd) => {
    requirePermission(hasPermissionRef, 'manageUsers', 'Insufficient permissions to assign roles');
    const email = userEmail.trim().toLowerCase();
    const list = Array.isArray(roleIds) ? roleIds : [roleIds];
    const body = { user_email: email, role_names: list, ...(typeof keepAd === 'boolean' ? { keep_ad: keepAd } : {}) };
    const data = await send('/api/rbac/user-assignments', jsonInit('POST', body), 'Failed to assign role');
    const entry = data.entry || { roles: list, keep_ad: keepAd !== false };
    setUserRoles((prev) => ({ ...prev, [email]: entry }));
    setUserRoleOverrides((prev) => ({ ...prev, [email]: entry.roles.includes('admin') ? 'admin' : entry.roles[0] }));
    refreshAfterWrite();
    return data;
  }, [refreshAfterWrite]);

  const removeUserRoleOverride = useCallback(async (userEmail) => {
    requirePermission(hasPermissionRef, 'manageUsers', 'Insufficient permissions to remove role assignments');
    const email = userEmail.trim().toLowerCase();
    const data = await send(`/api/rbac/user-assignments/${encodeURIComponent(email)}`, { method: 'DELETE' }, 'Failed to remove role assignment');
    setUserRoleOverrides((prev) => {
      const { [email]: _gone, ...rest } = prev;
      return rest;
    });
    setUserRoles((prev) => {
      const { [email]: _gone, ...rest } = prev;
      return rest;
    });
    refreshAfterWrite();
    return data;
  }, [refreshAfterWrite]);

  // Set one person's custom access on top of their role. Both lists empty
  // clears it. Lists hold permission keys; the backend validates them.
  const saveUserPermissionOverrides = useCallback(async (userEmail, { add = [], remove = [] } = {}) => {
    requirePermission(hasPermissionRef, 'manageUsers', 'Insufficient permissions to change access');
    const email = userEmail.trim().toLowerCase();
    const data = await send(`/api/rbac/user-permissions/${encodeURIComponent(email)}`, jsonInit('PUT', { add, remove }), 'Failed to save custom access');
    setUserPermissionOverrides((prev) => {
      const { [email]: _old, ...rest } = prev;
      return data.overrides ? { ...rest, [email]: data.overrides } : rest;
    });
    refreshAfterWrite();
    return data;
  }, [refreshAfterWrite]);

  const clearUserPermissionOverrides = useCallback(
    (userEmail) => saveUserPermissionOverrides(userEmail, { add: [], remove: [] }),
    [saveUserPermissionOverrides]
  );

  const getAllUserPermissionOverrides = useCallback(() => userPermissionOverrides, [userPermissionOverrides]);
  const getUserAssignedRole = useCallback((userEmail) => userRoleOverrides[userEmail.toLowerCase()] || null, [userRoleOverrides]);
  const getAllUserOverrides = useCallback(() => userRoleOverrides, [userRoleOverrides]);
  const getAllUserRoles = useCallback(() => userRoles, [userRoles]);

  // One object per real change, so every page using this doesn't re-render
  // each time the provider does
  const roleDefinition = getRoleDefinition();
  const value = useMemo(() => ({
    userRole,
    roleDefinition,
    loading,
    configError,
    retryRBACConfig,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    hasRole,
    getAllRoles,
    getRoleDefinition,
    createCustomRole,
    updateCustomRole,
    deleteCustomRole,
    assignRoleToUser,
    removeUserRoleOverride,
    getUserAssignedRole,
    getAllUserOverrides,
    getAllUserRoles,
    getAllUserPermissionOverrides,
    saveUserPermissionOverrides,
    clearUserPermissionOverrides,
    getBuiltinDefaults,
    AD_GROUP_ROLES: adGroupRoles,
    customRoles,
  }), [
    userRole, roleDefinition, loading, configError, retryRBACConfig, hasPermission, hasAnyPermission,
    hasAllPermissions, hasRole, getAllRoles, getRoleDefinition, createCustomRole, updateCustomRole,
    deleteCustomRole, assignRoleToUser, removeUserRoleOverride, getUserAssignedRole, getAllUserOverrides, getAllUserRoles,
    getAllUserPermissionOverrides, saveUserPermissionOverrides, clearUserPermissionOverrides,
    getBuiltinDefaults, adGroupRoles, customRoles,
  ]);

  return (
    <RBACContext.Provider value={value}>
      {children}
    </RBACContext.Provider>
  );
};

export const useRBAC = () => {
  const context = useContext(RBACContext);
  if (!context) {
    throw new Error('useRBAC must be used within an RBACProvider');
  }
  return context;
};

// Permission Gate Component
export const PermissionGate = ({ permission, permissions, requireAll = false, fallback = null, children }) => {
  const { hasPermission, hasAnyPermission, hasAllPermissions } = useRBAC();

  let hasAccess = false;

  if (permission) {
    hasAccess = hasPermission(permission);
  } else if (permissions) {
    hasAccess = requireAll
      ? hasAllPermissions(permissions)
      : hasAnyPermission(permissions);
  }

  if (!hasAccess) {
    return fallback;
  }

  return <>{children}</>;
};

// Role Gate Component
export const RoleGate = ({ role, roles, fallback = null, children }) => {
  const { hasRole } = useRBAC();

  const allowedRoles = roles || (role ? [role] : []);
  const hasAccess = hasRole(allowedRoles);

  if (!hasAccess) {
    return fallback;
  }

  return <>{children}</>;
};