import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useRBAC } from "../context/RBACContext";
import { useAuth } from "../context/AuthContext";
import { useAssistantSettings } from "../context/AssistantSettingsContext";
import { useProfilePhoto } from "../hooks/useProfilePhoto";
import { dashboardRank } from "../config/tools";
import logoutIcon  from "/icons/JJ_Icon_Log_Out_RGB.svg";        // Sign out
import chevronDown from "/icons/JJ_Icon_Chevron_Down.svg"; // User menu toggle

// Icons
import collapseicon from "/icons/JJ_Icon_Chevron_Left.svg";
import expandicon from "/icons/JJ_Icon_Chevron_Right.svg";
import dashboardIcon from "/icons/JJ_Icon_Dashboard_RGB.svg";
import dqIcon from "/icons/JJ_Icon_Analysis_RGB.svg";
import searchIcon from "/icons/JJ_Icon_Search_RGB.svg";
import aiIcon from "/icons/JJ_Icon_AI_RGB.svg";
import userManagementIcon from "/icons/JJ_Icon_Gear_RGB.svg";
import validationIcon from "/icons/JJ_Icon_Records_Information_RGB.svg";
import auditIcon from "/icons/JJ_Icon_Stationery_RGB.svg";
import commsIcon from "/icons/JJ_Icon_Communication_RGB.svg";
import unstructuredIcon from "/icons/JJ_Icon_Data_Visualization.svg";
import dataApiIcon from "/icons/JJ_Icon_Network_RGB.svg";
import graDomainsIcon from "/icons/JJ_Icon_Presentation_RGB.svg";
import dataStudioIcon from "/icons/JJ_Icon_Database_RGB.svg";
import userIcon from "/icons/JJ_Icon_Profile_red.svg";
import jjLogo from "/jj-logo.png";
import jjLogoSmall from "/sh_logo_small_black.svg";

const FILTER_WHITE = 'brightness(0) invert(1)';
const FILTER_GRAY  = 'brightness(0) saturate(100%) invert(42%) sepia(6%) saturate(656%) hue-rotate(346deg) brightness(92%) contrast(88%)';
const FILTER_RED   = 'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)';

const Icon = ({ src, alt, className = "w-4 h-4", style = {} }) => (
  <img src={src} alt={alt} className={className} style={style} />
);

// Nav is grouped so the list stays scannable as tools get added. Each entry
// keeps its own permission — a group renders only if something inside it does.
// Inside a group, items follow the dashboard's order (NEW first), so the order
// written here only matters for pages that aren't on the dashboard.
const MENU_GROUPS = [
  ["Workspace", [
    { id: "dashboard",              label: "Dashboard",             icon: dashboardIcon,      path: "/dashboard",              permission: "viewDashboard" },
    { id: "dqe",                    label: "Data quality",          icon: dqIcon,             path: "/dqe",                    permission: "viewDQE" },
    { id: "data-type-validation",   label: "Data Type Validation",  icon: validationIcon,     path: "/data-type-validation",   permission: "viewDataTypeValidation" },
    { id: "fuzzy-match",            label: "Fuzzy match",           icon: searchIcon,         path: "/fuzzy-match",            permission: "viewFuzzyMatch" },
  ]],
  ["Explorers", [
    { id: "unstructured-explorer",  label: "Unstructured Explorer", icon: unstructuredIcon,   path: "/unstructured-explorer",  permission: "viewUnstructured" },
    { id: "gra-data-domains",       label: "Structured Explorer",   icon: graDomainsIcon,     path: "/gra-data-domains",       permission: "viewGraDataDomains" },
    { id: "data-studio",            label: "Data Studio",           icon: dataStudioIcon,     path: "/data-studio",            permission: "viewDataStudio" },
    { id: "data-api",               label: "Data API Export",       icon: dataApiIcon,        path: "/data-api",               permission: "manageDataAPIExports" },
  ]],
  ["Intelligence", [
    { id: "rag",                    label: "RAGs",                  icon: aiIcon,             path: "/rag",                    permission: "viewRAG" },
    { id: "ai-assistant",           label: "AI assistant",          icon: aiIcon,             path: "/ai-assistant",           permission: "viewAIChatbot" },
  ]],
  ["Admin", [
    { id: "user-management",        label: "User Management",       icon: userManagementIcon, path: "/user-management",        permission: "viewUserManagement" },
    { id: "communication-center",   label: "Communication Center",  icon: commsIcon,          path: "/communication-center",   permission: "sendCommunications" },
    { id: "audit",                  label: "Audit Log",             icon: auditIcon,          path: "/audit",                  permission: "viewAudit" },
  ]],
];

// Animating width reflows the whole page on every frame, so it is kept short
// and scoped to width alone rather than `transition: all`.
const SHELL_STYLE = { transition: 'width .18s linear' };

// `expanded` is optional: when the parent passes it (the dashboard, whose
// header owns the collapse toggle) the sidebar follows it; otherwise it keeps
// its own state and its own toggle, as it always has.
const Sidebar = ({ showUserMenu = false, showLogo = true, expanded }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasPermission, loading: rbacLoading } = useRBAC();
  const { logout, user } = useAuth();
  const { enabled: assistantEnabled, setEnabled: setAssistantEnabled } = useAssistantSettings();
  const canUseAssistant = hasPermission("viewAssistantAvatar");
  const { profilePhoto, photoLoading } = useProfilePhoto(user, logout);

  const [showUserDropdown, setShowUserDropdown] = useState(false);

  const currentPath = location.pathname.split('/')[1] || 'dashboard';
  const previousPath = useRef(null);

  // Sidebar is always expanded on dashboard, collapsed elsewhere.
  // previousPath starts as null so this fires on first render too,
  // overriding anything stale that may have been in localStorage before.
  const [internalExpanded, setSidebarExpanded] = useState(
    currentPath === 'dashboard'
  );
  const sidebarExpanded = expanded ?? internalExpanded;

  const toggleSidebar = () => setSidebarExpanded(p => !p);

  // Auto-expand on dashboard, collapse elsewhere on route change
  useEffect(() => {
    if (previousPath.current !== currentPath) {
      setSidebarExpanded(currentPath === 'dashboard');
      previousPath.current = currentPath;
    }
  }, [currentPath]);

  // Close dropdown when sidebar collapses
  useEffect(() => {
    if (!sidebarExpanded) setShowUserDropdown(false);
  }, [sidebarExpanded]);

  // Until RBAC resolves, hasPermission() falls back to the default 'viewer'
  // role, so filtering now would render a short menu and then visibly pop the
  // remaining items in. Show skeleton rows for that window instead.
  const groups = rbacLoading
    ? []
    : MENU_GROUPS
        .map(([title, items]) => [title, items
          .filter(item => hasPermission(item.permission))
          .sort((a, b) => dashboardRank(a.path) - dashboardRank(b.path))])
        .filter(([, items]) => items.length > 0);

  const handleNavigation = (path) => navigate(path);

  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      console.error('Logout failed:', error);
      window.location.replace('/logout');
    }
  };

  const displayUser = {
    name: (user?.name || user?.username || "User").replace(/\s*\[.*?\]\s*/g, '').trim(),
    email: user?.email || user?.username || "email@its.jnj.com",
    avatar: profilePhoto
  };

  return (
    <div
      className={`${sidebarExpanded ? 'w-60' : 'w-16'} flex-shrink-0 flex flex-col max-h-screen min-h-0 bg-white border-r border-jj-gray-02`}
      style={SHELL_STYLE}
    >
      {/* ── Logo + Toggle ──
          Skipped entirely on the dashboard, where the full-width header
          carries both the logo and the collapse toggle. */}
      {!showLogo ? null : sidebarExpanded ? (
        <div className="flex items-center justify-between py-1 pr-2 border-b border-jj-gray-02" style={{ boxShadow: '0 -1px 0 #eb1700 inset' }}>
          <img src={jjLogo} alt="J&J Logo" className="h-10 object-contain" />
          <button
            onClick={toggleSidebar}
            className="p-1 rounded hover:bg-jj-gray-01 transition-colors duration-200 flex-shrink-0"
            aria-label="Collapse sidebar"
          >
            <Icon src={collapseicon} alt="Collapse" className="w-5 h-5" style={{ filter: FILTER_RED }} />
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center py-2 border-b border-jj-gray-02" style={{ boxShadow: '0 -1px 0 #eb1700 inset' }}>
          <img src={jjLogoSmall} alt="J&J" className="w-10 h-10 object-contain" />
          <button
            onClick={toggleSidebar}
            className="p-1 mt-2 rounded hover:bg-jj-gray-01 transition-colors duration-200"
            aria-label="Expand sidebar"
          >
            <Icon src={expandicon} alt="Expand" className="w-5 h-5" style={{ filter: FILTER_RED }} />
          </button>
        </div>
      )}

      {/* ── Menu ── (scrolls internally when the viewport is shorter than the
          icon stack - e.g. high browser zoom - so the sidebar never overflows
          the h-screen shell and forces the whole document to scroll) */}
      <nav
        className={`flex-1 min-h-0 flex flex-col gap-0.5 overflow-y-auto py-3.5 ${sidebarExpanded ? 'px-3' : 'px-2'}`}
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#d5cfc9 transparent' }}
      >
        {rbacLoading && Array.from({ length: 6 }).map((_, i) => (
          <div key={`menu-skeleton-${i}`} aria-hidden="true" className="flex items-center gap-3 p-2">
            <div className="w-5 h-5 flex-shrink-0 rounded bg-jj-gray-02 animate-pulse" />
            {sidebarExpanded && <div className="h-3 flex-1 rounded bg-jj-gray-02 animate-pulse" />}
          </div>
        ))}

        {groups.map(([title, items], groupIndex) => (
          <React.Fragment key={title}>
            {/* Collapsed rail has no room for a label — a rule separates groups instead */}
            {sidebarExpanded ? (
              <p className={`font-johnson-text text-xs tracking-widest uppercase text-jj-gray-07 px-2.5 pb-1 ${groupIndex ? 'pt-4' : 'pt-1'}`}>
                {title}
              </p>
            ) : groupIndex > 0 ? (
              <div aria-hidden="true" className="mx-2 my-1.5 h-px bg-jj-gray-02" />
            ) : null}

            {items.map(item => {
              const active = currentPath === item.id;
              return (
                <a
                  key={item.id}
                  href={item.path}
                  onClick={(e) => {
                    // let ctrl/cmd/middle-click open in a new tab as normal
                    if (e.ctrlKey || e.metaKey || e.button === 1) return;
                    e.preventDefault();
                    handleNavigation(item.path);
                  }}
                  // Collapsed rail shows icons only — the native tooltip names
                  // them without a hover handler or a re-render per row.
                  title={!sidebarExpanded ? item.label : undefined}
                  className={`flex items-center min-w-0 rounded-xl font-johnson-text text-sm cursor-pointer transition-colors duration-150 motion-reduce:transition-none ${
                    sidebarExpanded ? 'justify-start gap-3 px-3 py-2.5' : 'justify-center py-2.5'
                  } ${active ? 'bg-jj-red text-white' : 'text-jj-gray-08 hover:bg-jj-gray-01'}`}
                >
                  <Icon
                    src={item.icon}
                    alt=""
                    className="flex-shrink-0"
                    style={{ width: 17, height: 17, filter: active ? FILTER_WHITE : FILTER_GRAY }}
                  />
                  {sidebarExpanded && (
                    <span className="truncate flex-1 min-w-0 leading-tight">{item.label}</span>
                  )}
                </a>
              );
            })}
          </React.Fragment>
        ))}
      </nav>

      {/* ── User Menu (non-dashboard pages) ── */}
      {showUserMenu && (
        <div className="px-3 pb-3 pt-3 relative border-t border-jj-gray-02">

          {/* Dropdown panel — opens upward */}
          {showUserDropdown && sidebarExpanded && (
            <div className="absolute bottom-full left-0 right-0 mb-2 mx-3 bg-white rounded-xl border border-jj-gray-02 shadow-xl overflow-hidden z-50">
              {/* User info */}
              <div className="px-4 py-3 border-b border-jj-gray-02 bg-jj-gray-01">
                <div className="flex items-center space-x-3">
                  <div className="flex-shrink-0">
                    {photoLoading ? (
                      <div className="w-9 h-9 rounded-full bg-jj-gray-02 animate-pulse" />
                    ) : displayUser.avatar ? (
                      <img
                        src={displayUser.avatar}
                        alt={displayUser.name}
                        className="w-9 h-9 rounded-full object-cover border-2 border-jj-gray-02"
                      />
                    ) : (
                      <img src={userIcon} alt="User" className="w-9 h-9" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-johnson-display text-jj-gray-08 truncate">
                      {displayUser.name}
                    </p>
                    <p className="text-xs text-jj-gray-05 font-johnson-text truncate">
                      {displayUser.email}
                    </p>
                  </div>
                </div>
              </div>
              {/* AI avatar assistant toggle — admin-only */}
              {canUseAssistant && (
                <div className="w-full flex items-center justify-between px-4 py-3 border-b border-jj-gray-02">
                  <div className="flex flex-col">
                    <span className="text-sm font-johnson-text text-jj-gray-08">AI assistant</span>
                    <span className="text-xs text-jj-gray-05 font-johnson-text">
                      {assistantEnabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <button
                    role="switch"
                    aria-checked={assistantEnabled}
                    aria-label="Toggle AI assistant"
                    onClick={() => setAssistantEnabled(!assistantEnabled)}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-jj-red focus:ring-opacity-40 ${
                      assistantEnabled ? "bg-jj-red" : "bg-jj-gray-03"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
                        assistantEnabled ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>
              )}
              {/* Sign out */}
              <button
                onClick={handleLogout}
                className="w-full flex items-center space-x-3 px-4 py-3 text-sm font-johnson-text text-jj-red hover:bg-red-50 transition-colors duration-200 text-left"
              >
                <img src={logoutIcon} alt="" className="w-4 h-4 flex-shrink-0" style={{ filter: FILTER_RED }} />
                <span>Sign out</span>
              </button>
            </div>
          )}

          {/* Expanded: user trigger button */}
          {sidebarExpanded && (
            <button
              onClick={() => setShowUserDropdown(prev => !prev)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-2xl bg-jj-gray-01 border border-jj-gray-02 text-left transition-colors duration-150 motion-reduce:transition-none hover:border-jj-red/40"
            >
              <div className="flex-shrink-0">
                {photoLoading ? (
                  <div className="w-7 h-7 rounded-full bg-jj-gray-02 animate-pulse" />
                ) : displayUser.avatar ? (
                  <img
                    src={displayUser.avatar}
                    alt={displayUser.name}
                    className="w-7 h-7 rounded-full object-cover border border-jj-gray-02"
                  />
                ) : (
                  <img src={userIcon} alt="User" className="w-7 h-7" />
                )}
              </div>
              <div className="flex items-center justify-between flex-1 min-w-0">
                <div className="min-w-0 flex-1">
                  <p className="font-johnson-text text-sm text-jj-gray-08 truncate leading-tight">
                    {displayUser.name}
                  </p>
                  <p className="font-johnson-text text-xs text-jj-gray-07 truncate leading-tight">
                    {displayUser.email}
                  </p>
                </div>
                <img
                  src={chevronDown}
                  alt=""
                  className={`w-3.5 h-3.5 flex-shrink-0 ml-1 transition-transform duration-200 ${showUserDropdown ? 'rotate-180' : ''}`}
                  style={{ filter: FILTER_GRAY }}
                />
              </div>
            </button>
          )}

          {/* Collapsed: avatar + assistant toggle + sign-out icon stacked */}
          {!sidebarExpanded && (
            <div className="flex flex-col items-center space-y-2">
              <div title={displayUser.name}>
                {photoLoading ? (
                  <div className="w-7 h-7 rounded-full bg-jj-gray-02 animate-pulse" />
                ) : displayUser.avatar ? (
                  <img
                    src={displayUser.avatar}
                    alt={displayUser.name}
                    className="w-7 h-7 rounded-full object-cover border border-jj-gray-02"
                  />
                ) : (
                  <img src={userIcon} alt="User" className="w-7 h-7" />
                )}
              </div>
              {canUseAssistant && (
                <button
                  role="switch"
                  aria-checked={assistantEnabled}
                  onClick={() => setAssistantEnabled(!assistantEnabled)}
                  title={`AI assistant: ${assistantEnabled ? "Enabled" : "Disabled"} (click to toggle)`}
                  className={`p-1.5 rounded transition-colors duration-200 ${assistantEnabled ? 'bg-jj-red' : ''}`}
                >
                  <img
                    src={aiIcon}
                    alt="Toggle AI assistant"
                    className="w-4 h-4"
                    style={{ filter: assistantEnabled ? FILTER_WHITE : FILTER_GRAY, opacity: assistantEnabled ? 1 : 0.6 }}
                  />
                </button>
              )}
              <button
                onClick={handleLogout}
                title="Sign out"
                className="p-1.5 rounded hover:bg-jj-gray-01 transition-colors duration-200"
              >
                <img src={logoutIcon} alt="Sign out" className="w-4 h-4" style={{ filter: FILTER_RED }} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Sidebar;