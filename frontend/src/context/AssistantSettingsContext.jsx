import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthContext";
import { useRBAC } from "./RBACContext";

const AssistantSettingsContext = createContext(null);
const STORAGE_KEY = "smarthub.assistantEnabled";
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

function readLocalDefault() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false; // storage unavailable — fall back to the opt-in default
  }
}

export const AssistantSettingsProvider = ({ children }) => {
  const { user, getAccessToken } = useAuth();
  const { hasPermission, loading: rbacLoading } = useRBAC();
  const [enabled, setEnabledState] = useState(readLocalDefault);
  const [loaded, setLoaded] = useState(false);
  const userEmail = user?.email || user?.username || "";
  const loadedFor = useRef(null);
  const canUseAssistant = hasPermission("viewAssistantAvatar");

  // Pull the durable value from the backend once we know who's logged in.
  useEffect(() => {
    if (!userEmail || rbacLoading) return;
    if (!canUseAssistant) {
      // Not an admin: force off, skip the network call entirely, done.
      setEnabledState(false);
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
      setLoaded(true);
      return;
    }
    if (loadedFor.current === userEmail) return;
    loadedFor.current = userEmail;
    (async () => {
      try {
        const token = await getAccessToken();
        const res = await fetch(`${API_BASE_URL}/api/audit/assistant-settings`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        const serverEnabled = !!data?.settings?.enabled;
        setEnabledState(serverEnabled);
        try { localStorage.setItem(STORAGE_KEY, String(serverEnabled)); } catch {}
      } catch {
        // offline or backend down — keep whatever localStorage/default gave us
      } finally {
        setLoaded(true);
      }
    })();
  }, [userEmail, rbacLoading, canUseAssistant, getAccessToken]);

  const setEnabled = async (value) => {
    if (!canUseAssistant) return; // belt-and-suspenders — the UI shouldn't call this at all
    setEnabledState(value);
    try { localStorage.setItem(STORAGE_KEY, String(value)); } catch {}
    try {
      const token = await getAccessToken();
      await fetch(`${API_BASE_URL}/api/audit/assistant-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled: value }),
      });
    } catch {
      // best-effort sync — the local toggle already took effect either way
    }
  };

  return (
    <AssistantSettingsContext.Provider value={{ enabled: enabled && canUseAssistant, setEnabled, loaded, canUseAssistant }}>
      {children}
    </AssistantSettingsContext.Provider>
  );
};

export const useAssistantSettings = () => {
  const ctx = useContext(AssistantSettingsContext);
  if (!ctx) {
    throw new Error("useAssistantSettings must be used within an AssistantSettingsProvider");
  }
  return ctx;
};