import React, { Suspense, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { useIsAuthenticated, useMsal } from "@azure/msal-react";
import { AuthProvider } from "./context/AuthContext";
import { RBACProvider, PermissionGate, useRBAC } from "./context/RBACContext";
import { SessionTimeoutProvider } from "./context/SessionTimeoutContext";
import { AssistantSettingsProvider, useAssistantSettings } from "./context/AssistantSettingsContext";
import { useAuth } from "./context/AuthContext";
import { usePageTracking } from "./hooks/usePageTracking";
import ProtectedRoute from "./components/ProtectedRoute";
import { consumeReturnPath } from "./utils/sessionKeys";
import { describeLocation } from "./config/tools";
import { recordVisit } from "./utils/recentTools";
import LoginPage from "./pages/LoginPage";
import LogoutPage from "./pages/LogoutPage";
import Sidebar from "./components/Sidebar";
import Header from "./components/Header";
import Dashboard from "./pages/Dashboard";
import { lazyPage } from "./utils/lazyPage";
import { getTier } from "./utils/perfTier";

// Dashboard is where most people land, so it ships with the app. Everything
// else is its own file, fetched the first time it's opened.
const DQEngine = lazyPage(() => import("./pages/DQEngine"));
const FuzzyMatch = lazyPage(() => import("./pages/FuzzyMatch"));
const AIchatbot = lazyPage(() => import("./pages/AIassistant"));
const FloatingAssistant = lazyPage(() => import("./assistant/FloatingAssistant"));
const UserManagement = lazyPage(() => import("./pages/UserManagement"));
const DataTypeValidation = lazyPage(() => import("./pages/DataTypeValidation"));
const RAGPage = lazyPage(() => import("./pages/RAGPage"));
const AuditPage = lazyPage(() => import("./pages/AuditPage"));
const Unstructured = lazyPage(() => import("./pages/Unstructured"));
const GraDataDomains = lazyPage(() => import("./pages/GraDataDomains"));
const DataStudio = lazyPage(() => import("./pages/dataStudio/DataStudio"));
const DataAPIExport = lazyPage(() => import("./pages/DataAPIExport"));
const DataApiTableView = lazyPage(() => import("./pages/DataApiTableView"));
const CommunicationCenter = lazyPage(() => import("./pages/CommunicationCenter"));

// What to fetch in the background once the first screen is up, only for
// pages this person can open
const PREFETCH = [
  ["viewDQE", DQEngine],
  ["viewUserManagement", UserManagement],
  ["viewDataStudio", DataStudio],
  ["viewUnstructured", Unstructured],
  ["viewGraDataDomains", GraDataDomains],
  ["viewAudit", AuditPage],
  ["sendCommunications", CommunicationCenter],
  ["manageDataAPIExports", DataAPIExport],
  ["viewFuzzyMatch", FuzzyMatch],
  ["viewDataTypeValidation", DataTypeValidation],
  ["viewRAG", RAGPage],
  ["viewAIChatbot", AIchatbot],
];

// Spinner while a page file downloads. Held back a moment, so a fast
// (or cached) load never flashes it.
const PageLoading = () => {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 200);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  return (
    <div className="flex items-center justify-center h-full min-h-[50vh]">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-jj-red" aria-label="Loading page" />
    </div>
  );
};

// A page file that couldn't be fetched (network blip) shows a retry instead
// of blanking the app. Resets when you move to another page.
class PageLoadBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("Page failed to load:", error);
  }

  // Moving to another page clears the error. Not a remount: that would throw
  // away the page on screen and flash the spinner on every navigation.
  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.quiet) return null;
    return (
      <div className="flex items-center justify-center h-full min-h-[50vh]">
        <div className="text-center max-w-sm px-6">
          <p className="text-jj-gray-08 font-johnson-display font-bold text-lg">This page didn't load</p>
          <p className="mt-2 text-sm text-jj-gray-07 font-johnson-text">Check your connection and try again.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 px-5 py-2 rounded-lg bg-jj-red text-white font-johnson-display font-bold text-sm hover:opacity-90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

// Once the first screen is idle, quietly fetch the pages this person can
// open, one at a time, so opening them later is instant. Skipped on
// data-saver connections and weak machines.
const PrefetchPages = () => {
  const { loading, hasPermission } = useRBAC();
  useEffect(() => {
    if (loading) return undefined;
    if (navigator.connection?.saveData || getTier() !== "full") return undefined;
    let cancelled = false;
    const idle = (fn) => (window.requestIdleCallback
      ? window.requestIdleCallback(fn, { timeout: 4000 })
      : setTimeout(fn, 1500));
    const queue = PREFETCH.filter(([perm]) => hasPermission(perm)).map(([, page]) => page);
    const next = () => {
      if (cancelled || !queue.length) return;
      queue.shift().preload().then(() => idle(next));
    };
    const start = setTimeout(() => idle(next), 3000);
    return () => { cancelled = true; clearTimeout(start); };
  }, [loading, hasPermission]);
  return null;
};

// Wraps a route element with a permission check.
// Waits for both auth AND RBAC to finish loading before deciding — prevents a refresh
// from incorrectly redirecting to /dashboard while the role is still resolving.
const PermissionRoute = ({ permission, children }) => {
  const { loading: rbacLoading, hasPermission, configError, retryRBACConfig } = useRBAC();
  const { loading: authLoading } = useAuth();

  if (authLoading || rbacLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-jj-gray-01">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-jj-red mx-auto"></div>
          <p className="mt-4 text-jj-gray-07 font-johnson-text">Checking permissions...</p>
        </div>
      </div>
    );
  }
  // The check itself failed (network, API down). Don't treat that as "no access"
  // and throw the user off the page they refreshed; let them try again.
  if (configError) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-jj-gray-01">
        <div className="text-center max-w-sm px-6">
          <p className="text-jj-gray-08 font-johnson-display font-bold text-lg">Couldn't check your access</p>
          <p className="mt-2 text-sm text-jj-gray-07 font-johnson-text">The permission check didn't go through. Your page is still here, try again in a moment.</p>
          <p className="mt-1 text-xs text-jj-gray-05 font-johnson-text">{configError}</p>
          <button
            type="button"
            onClick={retryRBACConfig}
            className="mt-5 px-5 py-2 rounded-lg bg-jj-red text-white font-johnson-display font-bold text-sm hover:opacity-90"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!hasPermission(permission)) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
};

// Standalone entry point for the browsable API table — needs its own RBAC
// wrapper since it renders outside AppLayout (no sidebar/dashboard chrome).
// Gated on the same permission as the rest of the Data API feature.
const DataApiTableViewGate = () => (
  <SessionTimeoutProvider>
    <RBACProvider>
      <PermissionRoute permission="manageDataAPIExports">
        <PageLoadBoundary>
          <Suspense fallback={<PageLoading />}>
            <DataApiTableView />
          </Suspense>
        </PageLoadBoundary>
      </PermissionRoute>
    </RBACProvider>
  </SessionTimeoutProvider>
);

// After the MSAL sign-in round-trip the user lands at "/" (the redirectUri).
// Restore the page they were on before logout/session expiration if one was
// saved; otherwise go to the dashboard.
const RootRedirect = () => <Navigate to={consumeReturnPath() || "/dashboard"} replace />;

// Component to handle authentication redirects
const AuthRedirectHandler = () => {
  const isAuthenticated = useIsAuthenticated();
  const { inProgress } = useMsal();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Wait for MSAL to fully settle before deciding — consuming the return
    // path mid-handshake can waste it on a navigation that never happens.
    if (isAuthenticated && inProgress === 'none' && location.pathname === '/login') {
      // Return the user to the page they were on before logout/session
      // expiration; fall back to the dashboard for a fresh sign-in.
      navigate(consumeReturnPath() || '/dashboard', { replace: true });
    }
  }, [isAuthenticated, inProgress, location.pathname, navigate]);

  return null;
};

// Inner layout that has access to location
const AppLayoutInner = () => {
  const location = useLocation();
  const isDashboard = location.pathname === '/dashboard' || location.pathname === '/';
  const { user } = useAuth();

  // Track page navigation in audit log
  usePageTracking(user?.email || user?.username || null);

  const [dashNavOpen, setDashNavOpen] = useState(true);
  useEffect(() => {
    if (isDashboard) setDashNavOpen(true);
  }, [isDashboard]);
  useEffect(() => {
    recordVisit(describeLocation(location.pathname, location.search));
  }, [location.pathname, location.search]);
  return (
    <div className={`flex h-screen bg-jj-gray-01 ${isDashboard ? 'flex-col' : ''}`}>
      {isDashboard && (
        <Header navOpen={dashNavOpen} onToggleNav={() => setDashNavOpen(o => !o)} />
      )}

      <div className="flex flex-grow min-h-0 overflow-hidden">
        <Sidebar
          showUserMenu={!isDashboard}
          showLogo={!isDashboard}
          expanded={isDashboard ? dashNavOpen : undefined}
        />
        <main className="flex-grow min-w-0 overflow-auto">
          <PageLoadBoundary resetKey={location.pathname}>
          <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route
              path="/dqe"
              element={
                <PermissionRoute permission="viewDQE">
                  <DQEngine />
                </PermissionRoute>
              }
            />
            <Route
              path="/fuzzy-match"
              element={
                <PermissionRoute permission="viewFuzzyMatch">
                  <FuzzyMatch />
                </PermissionRoute>
              }
            />
            <Route
              path="/ai-assistant"
              element={
                <PermissionRoute permission="viewAIChatbot">
                  <AIchatbot />
                </PermissionRoute>
              }
            />
            <Route
              path="/user-management"
              element={
                <PermissionRoute permission="viewUserManagement">
                  <UserManagement />
                </PermissionRoute>
              }
            />
            <Route
              path="/communication-center"
              element={
                <PermissionRoute permission="sendCommunications">
                  <CommunicationCenter />
                </PermissionRoute>
              }
            />
            <Route
              path="/data-type-validation"
              element={
                <PermissionRoute permission="viewDataTypeValidation">
                  <DataTypeValidation />
                </PermissionRoute>
              }
            />
            <Route
              path="/data-api"
              element={
                <PermissionRoute permission="manageDataAPIExports">
                  <DataAPIExport />
                </PermissionRoute>
              }
            />
            <Route
              path="/rag"
              element={
                <PermissionRoute permission="viewRAG">
                  <RAGPage />
                </PermissionRoute>
              }
            />
            <Route
              path="/unstructured-explorer"
              element={
                <PermissionRoute permission="viewUnstructured">
                  <Unstructured />
                </PermissionRoute>
              }
            />
            <Route
              path="/gra-data-domains"
              element={
                <PermissionRoute permission="viewGraDataDomains">
                  <GraDataDomains />
                </PermissionRoute>
              }
            />
            <Route
              path="/data-studio"
              element={
                <PermissionRoute permission="viewDataStudio">
                  <DataStudio />
                </PermissionRoute>
              }
            />
            <Route
              path="/audit"
              element={
                <PermissionRoute permission="viewAudit">
                  <AuditPage />
                </PermissionRoute>
              }
            />
            <Route
              path="/audit-edit"
              element={
                <PermissionRoute permission="viewAudit">
                  <AuditPage editable />
                </PermissionRoute>
              }
            />
            <Route
              path="/audit-edit-force"
              element={
                <PermissionRoute permission="viewAudit">
                  <AuditPage editable forceSilent />
                </PermissionRoute>
              }
            />
            <Route path="/" element={<RootRedirect />} />
          </Routes>
          </Suspense>
          </PageLoadBoundary>
        </main>
      </div>

      {/* persistent companion — lives on every page, only once the user has opted in
          from the account menu (off by default) */}
      <AssistantGate />
      <PrefetchPages />
    </div>
  );
};

// Kept as its own tiny component (rather than inlining the hook above) so the
// enabled-check re-render is scoped to just this line, not the whole layout.
const AssistantGate = () => {
  const { enabled } = useAssistantSettings();
  const { hasPermission } = useRBAC();
  if (!enabled || !hasPermission("viewAssistantAvatar")) return null;
  // Its own boundary: if the assistant's file fails, the page carries on without it
  return (
    <PageLoadBoundary quiet>
      <Suspense fallback={null}>
        <FloatingAssistant />
      </Suspense>
    </PageLoadBoundary>
  );
};

// Main app content component (protected routes)
const AppLayout = () => {
  return (
    <SessionTimeoutProvider>
      <RBACProvider>
        <AssistantSettingsProvider>
          <AppLayoutInner />
        </AssistantSettingsProvider>
      </RBACProvider>
    </SessionTimeoutProvider>
  );
};

// Root app component with authentication and routing
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AuthRedirectHandler />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          {/* Public on purpose — the only page that does not auto sign-in. */}
          <Route path="/logout" element={<LogoutPage />} />
          <Route
            path="/data-api-view/:apiId/:alias"
            element={
              <ProtectedRoute>
                <DataApiTableViewGate />
              </ProtectedRoute>
            }
          />
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}