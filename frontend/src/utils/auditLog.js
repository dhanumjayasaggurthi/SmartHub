import { apiFetch } from '../utils/apiClient';
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
export const logAuditEvent = async (action, userEmail, target = '', details = '') => {
  try {
    await apiFetch(`/api/audit/log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, target: target || '', details: details || '' }),
    });
  } catch {
    // Audit logging is non-critical — never block the main flow
  }
};