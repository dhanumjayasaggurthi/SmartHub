import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, Navigate } from 'react-router-dom';
import { useRBAC } from '../context/RBACContext';
import { useAuth } from '../context/AuthContext';
import { logAuditEvent } from '../utils/auditLog';
import EPodRAG from './EPodRAG';
import RimDocsRAG from './RimDocsRAG';
import RimDocsAgentic from './RimDocsAgentic';

const ALL_TABS = [
  { id: 'rimdocs-agentic', label: 'RIMDocs Agentic', permission: 'viewRimDocsAgentic', component: RimDocsAgentic },
  { id: 'rimdocs',  label: 'RIMDOCS RAG',    permission: 'viewRimDocsRAG',     component: RimDocsRAG },
  { id: 'epod',     label: 'EPOD RAG',       permission: 'viewEPodRAG',        component: EPodRAG },
];

export default function RAGPage() {
  const { hasPermission } = useRBAC();
  const { user } = useAuth();
  const userEmail = user?.email || user?.username || 'unknown';
  const [searchParams, setSearchParams] = useSearchParams();

  const tabs = ALL_TABS.filter(t => hasPermission(t.permission));

  // Initialise from the URL, falling back to the first permitted tab.
  const [activeTab, setActiveTab] = useState(() => {
    const tab = searchParams.get('tab');
    if (tabs.some(t => t.id === tab)) return tab;
    return tabs[0]?.id ?? '';
  });

  const hasLoggedInitialTab = useRef(false);
  useEffect(() => {
    if (hasLoggedInitialTab.current || !activeTab) return;
    hasLoggedInitialTab.current = true;
    const label = ALL_TABS.find(t => t.id === activeTab)?.label || activeTab;
    logAuditEvent('rag_tab_viewed', userEmail, activeTab, `Landed on "${label}" tab on RAG page`);
  }, [activeTab, userEmail]);

  const handleTabChange = (id) => {
    if (id === activeTab) return;
    setActiveTab(id);
    setSearchParams({ tab: id });
    const label = ALL_TABS.find(t => t.id === id)?.label || id;
    logAuditEvent('rag_tab_viewed', userEmail, id, `Switched to "${label}" tab on RAG page`);
  };

  // Sync state when the browser navigates back/forward.
  useEffect(() => {
    const tab = searchParams.get('tab');
    const resolved = tabs.some(t => t.id === tab) ? tab : tabs[0]?.id ?? '';
    if (resolved !== activeTab) {
      setActiveTab(resolved);
      const label = ALL_TABS.find(t => t.id === resolved)?.label || resolved;
      logAuditEvent('rag_tab_viewed', userEmail, resolved,
        `Switched to "${label}" tab on RAG page via browser navigation`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // No permitted tabs — redirect to dashboard.
  if (tabs.length === 0) return <Navigate to="/dashboard" replace />;

  // Active tab is no longer permitted (e.g. role changed) — snap to first.
  const safeTab = tabs.some(t => t.id === activeTab) ? activeTab : tabs[0].id;
  const ActiveComponent = ALL_TABS.find(t => t.id === safeTab)?.component;

  return (
    <div className="flex flex-col h-full">
      {/* Tab Bar */}
      <div className="flex border-b border-jj-gray-03 bg-white px-6 sticky top-0 z-10">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`px-6 py-4 font-johnson-text text-sm font-medium transition-colors duration-200 border-b-2 -mb-px ${
              safeTab === tab.id
                ? 'border-jj-red text-jj-red'
                : 'border-transparent text-jj-gray-06 hover:text-jj-gray-08 hover:border-jj-gray-04'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto">
        {ActiveComponent && <ActiveComponent />}
      </div>
    </div>
  );
}