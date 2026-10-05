import { useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { logAuditEvent } from '../../utils/auditLog';

// Every Data Studio pane logs in-page activity under the same audit event,
// so the audit log keeps one filter for the whole page.
export function useInPageLog() {
  const { user } = useAuth();
  const userEmail = user?.email || user?.username || null;
  return useCallback((target, details) => {
    logAuditEvent('sfqr_inpage', userEmail, target, details);
  }, [userEmail]);
}