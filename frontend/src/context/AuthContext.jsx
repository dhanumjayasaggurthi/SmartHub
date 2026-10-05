import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { useHeartbeat } from '../hooks/useHeartbeat';
import { logAuditEvent } from '../utils/auditLog';
import {
  LAST_ACTIVITY_KEY,
  LOGOUT_BROADCAST_KEY,
  beginSessionTeardown,
  restoreReturnPath,
  saveReturnPath,
} from '../utils/sessionKeys';

const AuthContext = createContext();

const LOGIN_AUDITED_KEY = 'dqe_login_audited';

export const AuthProvider = ({ children }) => {
  const { instance, accounts, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // Tracks which account has already been loaded so we don't re-fetch groups
  // and re-log "user_login" on every re-render / route change / refresh.
  const loadedAccountRef = useRef(null);
  const userRef = useRef(null);
  useEffect(() => { userRef.current = user; }, [user]);

  // Send periodic heartbeat to backend while authenticated
  useHeartbeat(user?.email || user?.username || null);

  // Fetch user's AD groups from Microsoft Graph
  const fetchUserGroups = async (accessToken) => {
    try {
      const response = await fetch('https://graph.microsoft.com/v1.0/me/memberOf', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.warn('Failed to fetch user groups:', response.status);
        return [];
      }

      const data = await response.json();
      return data.value || [];
    } catch (error) {
      console.warn('Error fetching user groups:', error);
      return [];
    }
  };

  // Check authentication status
  useEffect(() => {
    const checkAuth = async () => {
      try {
        // Wait for any auth operations to complete
        if (inProgress !== "none") {
          return;
        }

        // Check if user is authenticated
        if (isAuthenticated && accounts.length > 0) {
          const account = accounts[0];

          // Already loaded this exact account — nothing to do. Prevents
          // repeated Graph group fetches and duplicate login audit events.
          if (loadedAccountRef.current === account.homeAccountId && userRef.current) {
            setLoading(false);
            return;
          }

          // No Graph group fetch here anymore. The backend resolves the role
          // from its own memberOf call and RBACContext takes caller_role from
          // /api/rbac/config, so fetching groups in the browser just added a
          // slow Graph round trip that got thrown away. Left fetchUserGroups
          // above in case something needs it later.
          const groups = [];

          // Extract user information from the account
          const userData = {
            username: account.username,
            name: account.name || account.username,
            email: account.username,
            id: account.localAccountId,
            tenantId: account.tenantId,
            idTokenClaims: account.idTokenClaims,
            groups: groups
          };

          loadedAccountRef.current = account.homeAccountId;
          setUser(userData);
          setLoading(false);

          // Log the sign-in exactly once per browser session for this account
          // (sessionStorage is cleared on logout, so a re-login is logged again).
          try {
            if (sessionStorage.getItem(LOGIN_AUDITED_KEY) !== account.homeAccountId) {
              sessionStorage.setItem(LOGIN_AUDITED_KEY, account.homeAccountId);
              logAuditEvent('user_login', userData.email, userData.email, 'User signed in via SSO');
            }
          } catch {
            logAuditEvent('user_login', userData.email, userData.email, 'User signed in via SSO');
          }
        } else {
          loadedAccountRef.current = null;
          setUser(null);
          setLoading(false);
        }
      } catch (error) {
        console.error('Error checking authentication:', error);
        setUser(null);
        setLoading(false);
      }
    };

    checkAuth();
  }, [accounts, inProgress, isAuthenticated, instance]);

  // Login function
  const login = async () => {
    try {
      setLoading(true);
      // This will be called from LoginPage component
      // The actual login is handled by MSAL
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  // Logout function
  const logout = async () => {
    try {
      saveReturnPath();
      beginSessionTeardown();
      setLoading(true);

      // Clear all app-specific data from localStorage
      const keysToRemove = [
        'jj_fuzzy_search_data',
      ];

      keysToRemove.forEach(key => {
        try {
          localStorage.removeItem(key);
        } catch (e) {
          console.warn(`Error removing ${key}:`, e);
        }
      });

      const who = user?.email || user?.username || 'unknown';
      await logAuditEvent('user_logout', who, who, 'User signed out');
      await instance.clearCache();
      try {
        sessionStorage.clear();
      } catch (e) {
        console.warn('Error clearing session storage:', e);
      }

      setUser(null);
      loadedAccountRef.current = null;

      // Tell every other open tab to log out too, and drop the shared
      // inactivity timestamp so a future login starts with a clean slate.
      try {
        localStorage.setItem(LOGOUT_BROADCAST_KEY, String(Date.now()));
        localStorage.removeItem(LAST_ACTIVITY_KEY);
      } catch { /* non-critical */ }

      restoreReturnPath();
      window.location.replace(window.location.origin + "/logout");
    } catch (error) {
      console.error('Logout error:', error);
      setUser(null);
      loadedAccountRef.current = null;
      try {
        localStorage.setItem(LOGOUT_BROADCAST_KEY, String(Date.now()));
        localStorage.removeItem(LAST_ACTIVITY_KEY);
      } catch { /* non-critical */ }
      restoreReturnPath();
      window.location.replace(window.location.origin + "/logout");
    } finally {
      setLoading(false);
    }
  };

  // Get access token for API calls
  const getAccessToken = async () => {
    try {
      if (accounts.length === 0) {
        throw new Error('No authenticated account found');
      }

      const account = accounts[0];
      const response = await instance.acquireTokenSilent({
        scopes: ["User.Read", "Group.Read.All"],
        account: account,
      });

      return response.accessToken;
    } catch (error) {
      console.error('Error acquiring token:', error);

      if (error.name === 'InteractionRequiredAuthError') {
        try {
          const response = await instance.acquireTokenPopup({
            scopes: ["User.Read", "Group.Read.All"],
          });
          return response.accessToken;
        } catch (popupError) {
          console.error('Error acquiring token via popup:', popupError);
          throw popupError;
        }
      }

      throw error;
    }
  };

  const value = {
    user,
    authenticated: isAuthenticated && !!user && accounts.length > 0,
    loading: loading || inProgress !== "none",
    login,
    logout,
    getAccessToken,
    // Keep these for backward compatibility if needed
    credentials: user ? { username: user.username, password: '' } : { username: '', password: '' },
    updateCredentials: () => {}, // No-op for SSO
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};