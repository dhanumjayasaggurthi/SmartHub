import React, { useState } from 'react';
import { useMsal } from '@azure/msal-react';
import logo from "/sh_logo.png";
import { loginRequest } from '../config/msalConfig';

// Where logout and session expiry land. This route sits OUTSIDE ProtectedRoute
// on purpose: everything behind the guard bounces to /login, which signs the
// user straight back in. This page is the one spot in the app that doesn't.
export default function LogoutPage() {
  const { instance } = useMsal();
  const [busy, setBusy] = useState(false);

  // Go straight to Microsoft instead of reloading "/" first. The old href
  // reloaded the whole app, bounced / -> /login, and only then redirected,
  // which is where the blank screen came from.
  const signIn = (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    instance.loginRedirect(loginRequest).catch((err) => {
      console.error('Sign in error:', err);
      window.location.assign('/');
    });
  };

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
        <img src={logo} alt="SmartHub" className="h-16 mx-auto" />
        <p className="text-xs text-jj-gray-06 font-johnson-text text-right mb-3">
          powered by RDI-AI
        </p>

        <p className="text-lg font-bold text-jj-gray-08 font-johnson-display">
          You have been signed out
        </p>
        <p className="text-sm text-jj-gray-06 font-johnson-text mt-1 mb-5">
          Your session on this device has ended.
        </p>
        <a
          href="/"
          onClick={signIn}
          aria-disabled={busy}
          className="inline-block py-1.5 px-8 bg-jj-red text-white rounded-md hover:bg-jj-maroon-05 transition-all duration-200 font-johnson-text shadow-md hover:shadow-lg"
        >
          {busy ? 'Redirecting...' : 'Sign back in'}
        </a>

        <p className="text-xs text-jj-gray-05 font-johnson-text mt-5 pt-2 border-t border-jj-gray-02">
          Having trouble? Contact your IT administrator
        </p>
      </div>
    </div>
  );
}