import React, { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useRBAC } from "../context/RBACContext";
import { useAssistantSettings } from "../context/AssistantSettingsContext";
import { useProfilePhoto } from "../hooks/useProfilePhoto";
import { PALETTE_EVENT } from "../pages/Dashboard";
import userIcon    from "/icons/JJ_Icon_Profile_red.svg";
import logoutIcon  from "/icons/JJ_Icon_Log_Out_RGB.svg";         // Sign out
import chevronIcon from "/icons/JJ_Icon_Chevron_Down.svg";  // Dropdown chevron
import searchIcon  from "/icons/JJ_Icon_Search_RGB.svg";
import jjLogo      from "/jj-logo.png";
import collapseIcon from "/icons/JJ_Icon_Chevron_Left.svg";
import expandIcon   from "/icons/JJ_Icon_Chevron_Right.svg";

const FILTER_RED  = 'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)';
const FILTER_GRAY = 'brightness(0) saturate(100%) invert(42%) sepia(6%) saturate(656%) hue-rotate(346deg) brightness(92%) contrast(88%)';


// macOS shows ⌘K, everything else Ctrl+K.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

export default function Header({ navOpen = true, onToggleNav }) {
  const [showDropdown, setShowDropdown] = useState(false);
  const { logout, user } = useAuth();
  const { hasPermission, roleDefinition } = useRBAC();
  const { enabled: assistantEnabled, setEnabled: setAssistantEnabled } = useAssistantSettings();
  const canUseAssistant = hasPermission("viewAssistantAvatar");

  const { profilePhoto, photoLoading } = useProfilePhoto(user, logout);

  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      console.error('Logout failed:', error);
      window.location.replace('/logout');
    }
  };

  // The palette itself lives on the dashboard, which is the only page this
  // header renders on — an event keeps the two from having to share state.
  const openPalette = () => window.dispatchEvent(new Event(PALETTE_EVENT));

  const displayUser = {
    name: (user?.name || user?.username || "User").replace(/\s*\[.*?\]\s*/g, '').trim(),
    email: user?.email || user?.username || "email@its.jnj.com",
    avatar: profilePhoto
  };

  // Falls back to the email while RBAC resolves or if no role maps — and the
  // prefix only goes on an actual role, never on the email.
  const roleLabel = roleDefinition?.name ? `Role: ${roleDefinition.name}` : displayUser.email;

  return (
    <header
      className="relative w-full h-16 flex items-center flex-shrink-0 gap-4 pr-5 bg-white border-b border-jj-gray-02 select-none"
    >
      {/* Logo sits in the left third; equal flex-basis on both side columns
          keeps the wordmark optically centred regardless of their contents. */}
      <div className="flex items-center gap-2 flex-grow basis-0 min-w-0">
        <img src={jjLogo} alt="Johnson & Johnson" className="h-10 object-contain" />
        {onToggleNav && (
          <button
            type="button"
            onClick={onToggleNav}
            className="p-1 rounded hover:bg-jj-gray-01 transition-colors duration-150 flex-shrink-0"
            aria-label={navOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            <img src={navOpen ? collapseIcon : expandIcon} alt="" className="w-5 h-5" style={{ filter: FILTER_RED }} />
          </button>
        )}
      </div>

      {/* Wordmark */}
      <div className="flex items-center flex-shrink-0 gap-2 whitespace-nowrap">
        <span className="font-johnson-display font-bold text-3xl text-jj-red">GRA</span>
        <span className="font-johnson-display text-2xl text-jj-gray-07">-</span>
        <span className="font-johnson-display text-2xl uppercase tracking-widest text-jj-gray-07">SmartHub</span>
      </div>

      <div className="flex items-center justify-end flex-shrink-0 flex-grow basis-0 gap-3">

        {/* Search trigger */}
        <button
          type="button"
          onClick={openPalette}
          className="flex items-center flex-shrink-0 gap-2 h-9 pl-3 pr-3 rounded-xl bg-white border border-jj-gray-02 font-johnson-text text-sm text-jj-gray-07 transition-colors duration-150 motion-reduce:transition-none hover:border-jj-red/40"
          aria-label="Search tools"
        >
          <img src={searchIcon} alt="" className="w-4 h-4" style={{ filter: FILTER_GRAY }} />
          <span className="hidden md:inline">Search</span>
          <kbd className="hidden lg:inline font-johnson-text text-xs text-jj-gray-07 bg-jj-gray-01 border border-jj-gray-02 rounded px-1.5 py-0.5">
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>

        {/* User chip + dropdown */}
        <div className="relative flex-shrink-0">
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className="flex items-center gap-2 py-1 pl-1.5 pr-3 rounded-2xl bg-white border border-jj-gray-02 transition-colors duration-150 motion-reduce:transition-none hover:border-jj-red/40"
            aria-label="User menu"
          >
            {photoLoading ? (
              <div className="w-7 h-7 rounded-full bg-jj-gray-02 animate-pulse" />
            ) : displayUser.avatar ? (
              <img
                src={displayUser.avatar}
                alt={displayUser.name}
                className="w-7 h-7 rounded-full object-cover border border-jj-gray-02"
                onError={() => {}}
              />
            ) : (
              <img src={userIcon} alt="User" className="w-7 h-7" />
            )}

            <div className="hidden xl:block text-left leading-tight overflow-hidden w-36">
              <p className="font-johnson-text text-sm text-jj-gray-08 truncate">{displayUser.name}</p>
              <p className="font-johnson-text text-xs text-jj-gray-07 truncate">{roleLabel}</p>
            </div>

            <img
              src={chevronIcon}
              alt=""
              className={`w-3.5 h-3.5 flex-shrink-0 transition-transform duration-200 ${showDropdown ? 'rotate-180' : ''}`}
              style={{ filter: FILTER_GRAY }}
            />
          </button>

          {/* Dropdown Menu */}
          {showDropdown && (
            <div className="absolute right-0 mt-2 w-64 bg-white rounded-xl border border-jj-gray-02 shadow-lg py-2 z-30">
              <div className="px-4 py-3 border-b border-jj-gray-02">
                <div className="flex items-center space-x-3">
                  {photoLoading ? (
                    <div className="w-10 h-10 rounded-full bg-jj-gray-02 animate-pulse"></div>
                  ) : displayUser.avatar ? (
                    <img
                      src={displayUser.avatar}
                      alt={displayUser.name}
                      className="w-10 h-10 rounded-full object-cover border-2 border-jj-gray-02"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full flex items-center justify-center">
                      <img src={userIcon} alt="User" className="w-10 h-10" />
                    </div>
                  )}
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

              {canUseAssistant && (
                <div className="py-1 border-b border-jj-gray-02">
                  <div className="w-full flex items-center justify-between px-4 py-2">
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
                </div>
              )}

              <div className="py-1">
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center space-x-3 px-4 py-2 text-sm font-johnson-text text-jj-red hover:bg-red-50 transition-colors duration-200 text-left"
                >
                  <img src={logoutIcon} alt="" className="w-4 h-4 flex-shrink-0" style={{ filter: FILTER_RED }} />
                  <span>Sign out</span>
                </button>
              </div>
            </div>
          )}

          {/* Backdrop to close dropdown */}
          {showDropdown && (
            <div
              className="fixed inset-0 z-20"
              onClick={() => setShowDropdown(false)}
              aria-hidden="true"
            />
          )}
        </div>
      </div>
    </header>
  );
}