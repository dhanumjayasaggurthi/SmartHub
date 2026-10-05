import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { loginRequest } from '../config/msalConfig';
import { consumeReturnPath } from '../utils/sessionKeys';

export default function LoginPage() {
  const navigate = useNavigate();
  const { instance, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const [failed, setFailed] = useState(false);
  // Fire the handshake once per page load — a re-render while MSAL is still
  // starting up would otherwise kick off a second one.
  const startedRef = useRef(false);

  // Already signed in: go back to whatever page sent us here, or the dashboard.
  useEffect(() => {
    if (isAuthenticated && inProgress === "none") {
      navigate(consumeReturnPath() || '/dashboard', { replace: true });
    }
  }, [isAuthenticated, inProgress, navigate]);

  useEffect(() => {
    if (inProgress !== "none" || isAuthenticated || startedRef.current) return;
    startedRef.current = true;

    instance.loginRedirect(loginRequest).catch((err) => {
      console.error("Login error:", err);
      // interaction_in_progress just means another redirect is already on its
      // way out — not something the user needs to know or act on.
      if (err.errorCode !== 'interaction_in_progress') setFailed(true);
    });
  }, [inProgress, isAuthenticated, instance]);

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{
        backgroundImage: 'url(/background.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat'
      }}
    >
      <div className="text-center">
        {!failed && <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-jj-red mx-auto"></div>}
        <p className="mt-4 text-white font-johnson-text bg-black bg-opacity-50 px-4 py-2 rounded">
          {failed
            ? "Unable to sign in. Refresh the page or contact your IT administrator."
            : "Signing in..."}
        </p>
      </div>
    </div>
  );
}