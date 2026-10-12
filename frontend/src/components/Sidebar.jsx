import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useRBAC } from "../context/RBACContext";
import { useAuth } from "../context/AuthContext";
import { useAssistantSettings } from "../context/AssistantSettingsContext";
import { useProfilePhoto } from "../hooks/useProfilePhoto";
import { TOOL_CATALOG, dashboardRank } from "../config/tools";

import logoutIcon from "/icons/JJ_Icon_Log_Out_RGB.svg";
import chevronDown from "/icons/JJ_Icon_Chevron_Down.svg";
import chevronLeft from "/icons/JJ_Icon_Chevron_Left.svg";
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
import logoFull from "/sh_logo.png";
import logoMark from "/sh_logo_small_black.svg";

const OPEN_W = 280;
const SHUT_W = 76;
const HIDE_DELAY = 180;
const EDGE = 8;
// Distance from the popout's top edge to the centre of its header row.
const HEAD_CENTER = 25;

// Each entry keeps its own permission; a group shows only if something in it does.
// Order inside a group follows the dashboard (NEW first).
const MENU_GROUPS = [
  ["Workspace", [
    { id: "dashboard",             label: "Dashboard",             icon: dashboardIcon,      path: "/dashboard",             permission: "viewDashboard" },
    { id: "dqe",                   label: "Data quality",          icon: dqIcon,             path: "/dqe",                   permission: "viewDQE" },
    { id: "data-type-validation",  label: "Data Type Validation",  icon: validationIcon,     path: "/data-type-validation",  permission: "viewDataTypeValidation" },
    { id: "fuzzy-match",           label: "Fuzzy match",           icon: searchIcon,         path: "/fuzzy-match",           permission: "viewFuzzyMatch" },
  ]],
  ["Explorers", [
    { id: "unstructured-explorer", label: "Unstructured Explorer", icon: unstructuredIcon,   path: "/unstructured-explorer", permission: "viewUnstructured" },
    { id: "gra-data-domains",      label: "Structured Explorer",   icon: graDomainsIcon,     path: "/gra-data-domains",      permission: "viewGraDataDomains" },
    { id: "data-studio",           label: "Data Studio",           icon: dataStudioIcon,     path: "/data-studio",           permission: "viewDataStudio" },
    { id: "data-api",              label: "Data API Export",       icon: dataApiIcon,        path: "/data-api",              permission: "manageDataAPIExports" },
  ]],
  ["Intelligence", [
    { id: "rag",                   label: "RAGs",                  icon: aiIcon,             path: "/rag",                   permission: "viewRAG" },
    { id: "ai-assistant",          label: "AI assistant",          icon: aiIcon,             path: "/ai-assistant",          permission: "viewAIChatbot" },
  ]],
  ["Admin", [
    { id: "user-management",       label: "User Management",       icon: userManagementIcon, path: "/user-management",       permission: "viewUserManagement" },
    { id: "communication-center",  label: "Communication Center",  icon: commsIcon,          path: "/communication-center",  permission: "sendCommunications" },
    { id: "audit",                 label: "Audit Log",             icon: auditIcon,          path: "/audit",                 permission: "viewAudit" },
  ]],
];

const catalogFor = (path) => TOOL_CATALOG.find((t) => t.path === path);

// A section is current when its path and every query param it names match the URL.
const sectionMatches = (sectionPath, location) => {
  const [p, q = ""] = sectionPath.split("?");
  if (p !== location.pathname) return false;
  const want = new URLSearchParams(q);
  const have = new URLSearchParams(location.search);
  for (const [k, v] of want) if (have.get(k) !== v) return false;
  return [...want.keys()].length > 0;
};

const initialsOf = (name = "") => {
  const clean = name.includes(",") ? name.split(",").reverse().join(" ") : name;
  const parts = clean.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "U";
};

const isTyping = () => {
  const el = document.activeElement;
  return !!el && (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable);
};

const clamp = (v, min, max) => Math.max(min, Math.min(v, max));

const Icon = ({ src, className = "" }) => (
  <span className={`sb-ic ${className}`} style={{ "--icon": `url("${src}")` }} aria-hidden="true" />
);

const Avatar = ({ photo, initials, live }) => (
  <span className="sb-av">
    {photo ? <img src={photo} alt="" /> : <span>{initials}</span>}
    {live && <span className="sb-live" />}
  </span>
);

const CSS = `
.sb { --ease:cubic-bezier(.22,1,.36,1); --spring:cubic-bezier(.34,1.56,.64,1);
  position:relative; flex-shrink:0; width:${SHUT_W}px; height:100%; z-index:30; transition:width .38s var(--ease);
  font-family:'JohnsonText', Helvetica, Arial, sans-serif; color:#1f1b18; }
.sb.open { width:${OPEN_W}px; }
.sb *, .sb *::before, .sb *::after { box-sizing:border-box; }
.sb a { text-decoration:none; }
.sb a:focus-visible, .sb button:focus-visible { outline:2px solid #eb1700; outline-offset:2px; }

.sb-ic { display:block; flex-shrink:0; background-color:currentColor;
  -webkit-mask:var(--icon) center/contain no-repeat; mask:var(--icon) center/contain no-repeat; }

.sb-panel { position:absolute; inset:0; display:flex; flex-direction:column; overflow:hidden; background:#fdfcfb;
  border-right:1px solid #d9d1ca; box-shadow:inset -1px 0 0 #fff, 1px 0 0 rgba(255,255,255,.9), 18px 0 36px -26px rgba(60,30,20,.3); }

.sb-brand { display:flex; align-items:center; height:72px; flex-shrink:0; padding:0 16px 0 18px; }
.sb-brand img { display:block; user-select:none; }
.sb-logo-full { height:38px; width:auto; }
.sb-logo-mark { width:40px; height:40px; }

.sb-search { padding:4px 14px 10px; }
.sb-search label { display:flex; align-items:center; gap:10px; height:40px; padding:0 13px; border-radius:12px; overflow:hidden;
  background:#f5f2ef; border:1px solid #ece7e2; cursor:text; transition:border-color .2s, background-color .2s; }
.sb:not(.open) .sb-search label { justify-content:center; padding:0; cursor:pointer; }
.sb-search label:hover, .sb-search label:focus-within { border-color:#dcd3cc; background:#fff; }
.sb-search .sb-ic { width:16px; height:16px; color:#7a726c; }
.sb-search input { flex:1; min-width:0; border:0; outline:0; background:transparent; font:inherit; font-size:13.5px; color:#1f1b18; }
.sb-search input::placeholder { color:#9a928c; }
.sb-search kbd { font-family:inherit; font-size:10.5px; padding:2px 6px; border-radius:6px; background:#fff; border:1px solid #e6e0da; color:#6f6863; white-space:nowrap; }

.sb-nav { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; padding:0 13px 16px; overscroll-behavior:contain; }
.sb-nav::-webkit-scrollbar { width:3px; }
.sb-nav::-webkit-scrollbar-track { background:transparent; }
.sb-nav::-webkit-scrollbar-thumb { background:#d5cfc9; border-radius:3px; }
@supports not selector(::-webkit-scrollbar) { .sb-nav { scrollbar-width:thin; scrollbar-color:#d5cfc9 transparent; } }

.sb-group { display:flex; flex-direction:column; gap:2px; }
.sb-group + .sb-group { padding-top:14px; }
.sb-gh { display:flex; align-items:center; height:26px; padding:0 12px; }
.sb:not(.open) .sb-gh { justify-content:center; padding:0; }
.sb-gh span { font-size:10.5px; font-weight:500; letter-spacing:.16em; text-transform:uppercase; color:#8a827c; white-space:nowrap; }
.sb-gh i { display:block; width:22px; height:1px; background:#e2dbd5; }

.sb-link { position:relative; display:flex; align-items:center; gap:12px; height:40px; padding:0 12px; border-radius:12px;
  font-size:14px; color:#4a433e; white-space:nowrap; transition:background-color .2s, color .2s, box-shadow .2s; }
.sb:not(.open) .sb-link { justify-content:center; padding:0; }
.sb-link > .sb-ic { width:18px; height:18px; color:#7a726c; }
.sb-link:hover, .sb-link.flying { background:#f1ebe6; color:#1f1b18; box-shadow:inset 0 0 0 1px #e6dfd9, 0 4px 10px -6px rgba(40,20,10,.18); }
.sb-link.on { background:#eb1700; color:#fff; font-weight:500; box-shadow:0 10px 22px -10px rgba(235,23,0,.6); }
.sb-link.on:hover, .sb-link.on.flying { background:#d41500; color:#fff; box-shadow:0 12px 24px -10px rgba(235,23,0,.7); }
.sb-link.on > .sb-ic { color:#fff; }
.sb-lbl { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
.sb-new { font-size:9.5px; font-weight:500; letter-spacing:.1em; padding:3px 6px; border-radius:6px; background:#fde8e4; color:#c81400; }
.sb-link.on .sb-new { background:rgba(255,255,255,.22); color:#fff; }
.sb-link > .sb-chev { width:10px; height:10px; margin-right:2px; transform:rotate(-90deg); }

.sb-empty { padding:22px 12px; font-size:13px; color:#8a827c; white-space:normal; }
.sb-skel { display:flex; align-items:center; gap:12px; height:40px; padding:0 12px; }
.sb:not(.open) .sb-skel { justify-content:center; padding:0; }
.sb-skel i { display:block; border-radius:6px; background:#ece7e2; animation:sbBreath 1.4s ease-in-out infinite; }

.sb-user { padding:12px 14px 14px; border-top:1px solid #efeae6; }
.sb-ubtn { width:100%; display:flex; align-items:center; gap:10px; padding:6px; border-radius:14px; border:1px solid #ece7e2; background:#faf8f6;
  cursor:pointer; text-align:left; font:inherit; color:inherit; overflow:hidden; transition:border-color .25s, background-color .2s; }
.sb:not(.open) .sb-ubtn { justify-content:center; }
.sb-ubtn:hover { background:#fff; }
.sb-ubtn.on { border-color:rgba(235,23,0,.45); }
.sb-av { position:relative; width:34px; height:34px; flex-shrink:0; border-radius:50%; padding:2px; background:#eb1700; }
.sb-av > img, .sb-av > span:not(.sb-live) { display:flex; width:100%; height:100%; border-radius:50%; background:#fff; align-items:center; justify-content:center;
  object-fit:cover; font-family:'JohnsonDisplay', sans-serif; font-weight:700; font-size:12px; color:#eb1700; }
.sb-live { position:absolute; right:-1px; bottom:-1px; width:9px; height:9px; border-radius:50%; background:#16a34a; border:2px solid #fff; }
.sb-uinfo { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; white-space:nowrap; }
.sb-uinfo span { overflow:hidden; text-overflow:ellipsis; }
.sb-uinfo span:first-child { font-size:13.5px; font-weight:500; }
.sb-uinfo span:last-child { font-size:11.5px; color:#7a726c; }
.sb-ubtn > .sb-chev { width:12px; height:12px; margin-right:6px; color:#7a726c; transition:transform .3s var(--ease); }
.sb-ubtn.on > .sb-chev { transform:rotate(180deg); }

.sb-menu { position:absolute; left:14px; bottom:72px; width:248px; z-index:20; overflow:hidden; background:#fff; border:1px solid #ebe5df; border-radius:16px;
  box-shadow:0 28px 56px -20px rgba(40,20,10,.3); animation:sbUp .25s var(--ease) both; }
.sb-menu-head { display:flex; flex-direction:column; gap:2px; padding:14px 16px; background:#faf8f6; border-bottom:1px solid #efeae6; }
.sb-menu-head span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sb-menu-head span:first-child { font-size:14px; font-weight:500; }
.sb-menu-head span:last-child { font-size:12px; color:#7a726c; }
.sb-menu-row { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid #efeae6; }
.sb-menu-row div { display:flex; flex-direction:column; gap:2px; }
.sb-menu-row div span:first-child { font-size:13.5px; }
.sb-menu-row div span:last-child { font-size:12px; color:#7a726c; }
.sb-switch { position:relative; width:44px; height:24px; padding:0; border:0; border-radius:12px; cursor:pointer; background:#d5cec8; transition:background-color .25s; }
.sb-switch.on { background:#eb1700; }
.sb-switch span { position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.25); transition:transform .3s var(--spring); }
.sb-switch.on span { transform:translateX(20px); }
.sb-out { width:100%; display:flex; align-items:center; gap:10px; padding:13px 16px; border:0; background:#fff; cursor:pointer; text-align:left;
  font:inherit; font-size:13.5px; color:#eb1700; transition:background-color .2s; }
.sb-out:hover { background:#fdf2f0; }
.sb-out .sb-ic { width:16px; height:16px; }

.sb-toggle { position:absolute; top:58px; left:100%; z-index:6; width:26px; height:26px; margin-left:-13px; padding:0; border-radius:50%;
  display:flex; align-items:center; justify-content:center; cursor:pointer; background:#fff; border:1px solid #e6e0da;
  box-shadow:0 6px 14px -6px rgba(40,20,10,.35); color:#eb1700; transition:border-color .2s; }
.sb-toggle:hover { border-color:#eb1700; }
.sb-toggle .sb-ic { width:12px; height:12px; transform:rotate(180deg); transition:transform .38s var(--ease); }
.sb.open .sb-toggle .sb-ic { transform:none; }

.sb-fly { position:absolute; top:0; left:100%; z-index:40; padding-left:10px; animation:sbPop .22s var(--ease) both; }
.sb-fly-card { position:relative; min-width:200px; padding:6px; background:rgba(31,27,24,.74); border:1px solid rgba(255,255,255,.08); border-radius:14px;
  -webkit-backdrop-filter:blur(18px) saturate(1.5); backdrop-filter:blur(18px) saturate(1.5);
  box-shadow:0 22px 44px -16px rgba(20,10,5,.55); }
.sb-fly-arrow { position:absolute; left:-6px; top:var(--arrow, 20px); width:10px; height:10px; background:rgba(31,27,24,.74);
  border-left:1px solid rgba(255,255,255,.08); border-bottom:1px solid rgba(255,255,255,.08); clip-path:polygon(0 0, 0 100%, 100% 100%); transform:rotate(45deg); }
.sb-fly-head, .sb-fly-sub { position:relative; display:flex; align-items:center; border-radius:9px; white-space:nowrap;
  transition:background-color .18s, box-shadow .18s, color .18s, translate .2s var(--ease); }
.sb-fly-head { gap:8px; height:36px; padding:0 10px; font-size:13.5px; font-weight:500; color:#fff; }
.sb-fly-sub { gap:10px; height:32px; padding:0 10px; font-size:13px; color:#c9c0b8; transform-origin:left center; animation:sbOut .45s var(--spring) both; }
.sb-fly-head:hover, .sb-fly-sub:hover, .sb-fly-head:focus-visible, .sb-fly-sub:focus-visible {
  background:rgba(255,255,255,.13); color:#fff; box-shadow:inset 0 0 0 1px rgba(255,255,255,.16); outline:none; }
.sb-fly-sub:hover, .sb-fly-sub:focus-visible { translate:3px 0; }
.sb-fly-sub.on { color:#fff; font-weight:500; }
.sb-fly-sub i { display:block; flex-shrink:0; width:6px; height:6px; border-radius:50%; }
.sb-fly-sub.on i { background:#eb1700; }
.sb-fly-new { font-size:9px; font-weight:500; letter-spacing:.1em; padding:2px 5px; border-radius:5px; background:#eb1700; color:#fff; }
.sb-fly-hr { height:1px; margin:4px 6px; background:rgba(255,255,255,.1); }

@keyframes sbPop { from { opacity:0; transform:translateX(-6px) scale(.98); } to { opacity:1; transform:none; } }
@keyframes sbUp { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
@keyframes sbOut { 0% { opacity:0; transform:translateX(-18px) scale(.7); } 60% { opacity:1; transform:translateX(3px) scale(1.04); } 100% { opacity:1; transform:none; } }
@keyframes sbBreath { 50% { opacity:.45; } }

@media (prefers-reduced-motion: reduce) {
  .sb, .sb *, .sb *::before, .sb *::after { animation-duration:.01ms !important; animation-delay:0ms !important; transition-duration:.01ms !important; }
}
`;

// `expanded` is optional: the dashboard passes it (its header owns the toggle);
// every other page lets the sidebar keep its own state.
const Sidebar = ({ showUserMenu = false, showLogo = true, expanded }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasPermission, loading: rbacLoading } = useRBAC();
  const { logout, user } = useAuth();
  const { enabled: assistantEnabled, setEnabled: setAssistantEnabled } = useAssistantSettings();
  const { profilePhoto } = useProfilePhoto(user, logout);
  const canUseAssistant = hasPermission("viewAssistantAvatar");

  const currentPath = location.pathname.split("/")[1] || "dashboard";
  const controlled = expanded !== undefined;
  const [ownOpen, setOwnOpen] = useState(currentPath === "dashboard");
  const open = controlled ? expanded : ownOpen;

  const [query, setQuery] = useState("");
  const [userOpen, setUserOpen] = useState(false);
  const [fly, setFly] = useState(null);

  const asideRef = useRef(null);
  const inputRef = useRef(null);
  const userRef = useRef(null);
  const menuRef = useRef(null);
  const flyRef = useRef(null);
  const hideTimer = useRef(0);
  const focusSearch = useRef(false);

  const cancelHide = useCallback(() => clearTimeout(hideTimer.current), []);
  const closeFly = useCallback(() => { clearTimeout(hideTimer.current); setFly(null); }, []);
  const scheduleHide = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setFly(null), HIDE_DELAY);
  }, []);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  // Expanded on the dashboard, collapsed elsewhere; reset on every route change.
  useEffect(() => {
    setOwnOpen(currentPath === "dashboard");
    closeFly();
  }, [currentPath, closeFly]);

  useEffect(() => {
    closeFly();
    if (!open) setUserOpen(false);
    else if (focusSearch.current) {
      focusSearch.current = false;
      inputRef.current?.focus();
    }
  }, [open, closeFly]);

  const toggle = useCallback(() => setOwnOpen((o) => !o), []);

  // Alt+K jumps to search (Ctrl+K belongs to page palettes), [ toggles, Escape dismisses.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        closeFly();
        setUserOpen(false);
        return;
      }
      if (e.ctrlKey || e.metaKey) return;
      if (e.altKey && e.code === "KeyK") {
        if (!open && controlled) return;
        e.preventDefault();
        if (open) inputRef.current?.focus();
        else { focusSearch.current = true; setOwnOpen(true); }
      } else if (e.key === "[" && !e.altKey && !controlled && !isTyping()) {
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, controlled, toggle, closeFly]);

  useEffect(() => {
    if (!userOpen) return undefined;
    const onDown = (e) => {
      if (!userRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) setUserOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [userOpen]);

  const allowed = useMemo(() => {
    if (rbacLoading) return [];
    return MENU_GROUPS
      .map(([title, items]) => [title, items
        .filter((item) => hasPermission(item.permission))
        .sort((a, b) => dashboardRank(a.path) - dashboardRank(b.path))
        .map((item) => {
          const cat = catalogFor(item.path);
          const subs = (cat?.sections || []).filter((s) => !s.permission || hasPermission(s.permission));
          return { ...item, badge: cat?.badge === "NEW", subs };
        })])
      .filter(([, items]) => items.length > 0);
  }, [rbacLoading, hasPermission]);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    if (!q) return allowed;
    return allowed
      .map(([title, items]) => [title, items
        .map((item) => {
          if (item.label.toLowerCase().includes(q)) return item;
          const subs = item.subs.filter((s) => s.label.toLowerCase().includes(q));
          return subs.length ? { ...item, subs } : null;
        })
        .filter(Boolean)])
      .filter(([, items]) => items.length > 0);
  }, [allowed, q]);

  const flat = useMemo(() => groups.flatMap(([, items]) => items), [groups]);
  const flyItem = fly ? flat.find((i) => i.id === fly.id) : undefined;

  // Keep the popout inside the visible part of the sidebar, arrow on the hovered row.
  useLayoutEffect(() => {
    const el = flyRef.current;
    const aside = asideRef.current;
    if (!fly || !flyItem || !el || !aside) return;
    const a = aside.getBoundingClientRect();
    const limit = Math.min(a.height, window.innerHeight - a.top);
    const h = el.offsetHeight;
    const top = clamp(fly.center - HEAD_CENTER, EDGE, Math.max(EDGE, limit - h - EDGE));
    el.style.top = `${top}px`;
    el.style.setProperty("--arrow", `${clamp(fly.center - top - 5, 12, h - 22)}px`);
  }, [fly, flyItem]);

  const go = (path) => {
    closeFly();
    navigate(path);
  };

  const onLinkClick = (e, path) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(path);
  };

  // Collapsed: every row gets a popout. Expanded: only rows with sub pages do.
  const showFly = (target, item) => {
    cancelHide();
    if (open && item.subs.length === 0) { setFly(null); return; }
    const a = asideRef.current.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const center = r.top - a.top + r.height / 2;
    setFly((f) => (f && f.id === item.id && f.center === center ? f : { id: item.id, center }));
  };

  const onSearchKey = (e) => {
    if (e.key === "Escape") {
      setQuery("");
      e.currentTarget.blur();
    } else if (e.key === "Enter" && flat.length) {
      const first = flat[0];
      const sub = q && !first.label.toLowerCase().includes(q) ? first.subs[0] : null;
      setQuery("");
      e.currentTarget.blur();
      go(sub ? sub.path : first.path);
    }
  };

  const onSearchClick = () => {
    if (open || controlled) return;
    focusSearch.current = true;
    setOwnOpen(true);
  };

  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      console.error("Logout failed:", error);
      window.location.replace("/logout");
    }
  };

  const name = (user?.name || user?.username || "User").replace(/\s*\[.*?\]\s*/g, "").trim();
  const email = user?.email || user?.username || "";
  const initials = initialsOf(name);

  return (
    <aside ref={asideRef} className={`sb${open ? " open" : ""}`} aria-label="Main navigation">
      <style>{CSS}</style>

      <div className="sb-panel">
        {showLogo && (
          <div className="sb-brand">
            {open
              ? <img src={logoFull} alt="GRA SmartHub" className="sb-logo-full" draggable={false} />
              : <img src={logoMark} alt="GRA SmartHub" className="sb-logo-mark" draggable={false} />}
          </div>
        )}

        <div className="sb-search">
          <label onClick={onSearchClick} title={open ? undefined : "Search tools (Alt K)"}>
            <Icon src={searchIcon} />
            {open && (
              <>
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onSearchKey}
                  placeholder="Jump to a tool…"
                  aria-label="Search tools"
                />
                <kbd>Alt K</kbd>
              </>
            )}
          </label>
        </div>

        <nav className="sb-nav" onScroll={fly ? closeFly : undefined}>
          {rbacLoading && (
            <div className="sb-group" aria-hidden="true">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="sb-skel">
                  <i style={{ width: 18, height: 18 }} />
                  {open && <i style={{ flex: 1, height: 12 }} />}
                </div>
              ))}
            </div>
          )}

          {groups.map(([title, items]) => (
            <div key={title} className="sb-group" role="group" aria-label={title}>
              <div className="sb-gh">{open ? <span>{title}</span> : <i aria-hidden="true" />}</div>
              {items.map((item) => {
                const on = currentPath === item.id;
                const flying = fly?.id === item.id;
                const hasSubs = item.subs.length > 0;
                return (
                  <a
                    key={item.id}
                    href={item.path}
                    className={`sb-link${on ? " on" : ""}${flying ? " flying" : ""}`}
                    aria-current={on ? "page" : undefined}
                    aria-label={open ? undefined : item.label}
                    aria-haspopup={hasSubs ? "true" : undefined}
                    aria-expanded={hasSubs ? flying : undefined}
                    onClick={(e) => onLinkClick(e, item.path)}
                    onMouseEnter={(e) => showFly(e.currentTarget, item)}
                    onMouseLeave={scheduleHide}
                    onFocus={(e) => showFly(e.currentTarget, item)}
                    onBlur={scheduleHide}
                  >
                    <Icon src={item.icon} />
                    {open && (
                      <>
                        <span className="sb-lbl">{item.label}</span>
                        {item.badge && <span className="sb-new">NEW</span>}
                        {hasSubs && <Icon src={chevronDown} className="sb-chev" />}
                      </>
                    )}
                  </a>
                );
              })}
            </div>
          ))}

          {!rbacLoading && q && groups.length === 0 && open && (
            <div className="sb-empty">No tools match “{query}”</div>
          )}
        </nav>

        {showUserMenu && (
          <div className="sb-user" ref={userRef}>
            <button
              type="button"
              className={`sb-ubtn${userOpen ? " on" : ""}`}
              onClick={() => { closeFly(); setUserOpen((o) => !o); }}
              aria-haspopup="menu"
              aria-expanded={userOpen}
              aria-label={open ? undefined : name}
            >
              <Avatar photo={profilePhoto} initials={initials} live />
              {open && (
                <>
                  <span className="sb-uinfo">
                    <span>{name}</span>
                    <span>{email}</span>
                  </span>
                  <Icon src={chevronDown} className="sb-chev" />
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {!controlled && (
        <button
          type="button"
          className="sb-toggle"
          onClick={toggle}
          title="Toggle sidebar  ["
          aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
          aria-expanded={open}
        >
          <Icon src={chevronLeft} />
        </button>
      )}

      {showUserMenu && userOpen && (
        <div className="sb-menu" role="menu" ref={menuRef}>
          <div className="sb-menu-head">
            <span>{name}</span>
            <span>{email}</span>
          </div>
          {canUseAssistant && (
            <div className="sb-menu-row">
              <div>
                <span>AI assistant</span>
                <span>{assistantEnabled ? "Enabled" : "Disabled"}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={assistantEnabled}
                aria-label="Toggle AI assistant"
                className={`sb-switch${assistantEnabled ? " on" : ""}`}
                onClick={() => setAssistantEnabled(!assistantEnabled)}
              >
                <span />
              </button>
            </div>
          )}
          <button type="button" role="menuitem" className="sb-out" onClick={handleLogout}>
            <Icon src={logoutIcon} />
            Sign out
          </button>
        </div>
      )}

      {flyItem && (
        <div
          ref={flyRef}
          className="sb-fly"
          role="group"
          aria-label={flyItem.label}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
          onFocus={cancelHide}
          onBlur={scheduleHide}
        >
          <div className="sb-fly-card">
            <span className="sb-fly-arrow" aria-hidden="true" />
            <a href={flyItem.path} className="sb-fly-head" onClick={(e) => onLinkClick(e, flyItem.path)}>
              {flyItem.label}
              {flyItem.badge && <span className="sb-fly-new">NEW</span>}
            </a>
            {flyItem.subs.length > 0 && (
              <>
                <div className="sb-fly-hr" aria-hidden="true" />
                {flyItem.subs.map((s, i) => {
                  const on = sectionMatches(s.path, location);
                  return (
                    <a
                      key={s.path}
                      href={s.path}
                      className={`sb-fly-sub${on ? " on" : ""}`}
                      aria-current={on ? "page" : undefined}
                      style={{ animationDelay: `${40 + i * 55}ms` }}
                      onClick={(e) => onLinkClick(e, s.path)}
                    >
                      <i aria-hidden="true" />
                      {s.label}
                    </a>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}
    </aside>
  );
};

export default Sidebar;
