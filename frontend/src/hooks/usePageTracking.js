import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { logAuditEvent } from '../utils/auditLog';

const ROUTE_LABELS = {
  '/dashboard':       'Dashboard',
  '/dqe':             'Data Quality Engine',
  '/fuzzy-match':     'Fuzzy Match',
  '/ai-assistant':    'AI Assistant',
  '/user-management': 'User Management',
  '/data-validation': 'Data Validation',
  '/rag':             'RAG',
  '/audit':           'Audit Log',
  '/unstructured-explorer': 'Unstructured Explorer',
  '/gra-data-domains':      'Structured Explorer',
  '/data-studio':           'Data Studio',
  '/communication-center':  'Communication Center',
};
export function usePageTracking(userEmail) {
  const location = useLocation();
  const lastPathRef = useRef(null);

  useEffect(() => {
    if (!userEmail) return;

    const path = location.pathname;

    // Skip if same path (e.g. query param change only)
    if (path === lastPathRef.current) return;
    lastPathRef.current = path;

    const pageName = ROUTE_LABELS[path] || path;

    logAuditEvent('page_access', userEmail, path, `Visited ${pageName}`);
  }, [location.pathname, userEmail]);
}