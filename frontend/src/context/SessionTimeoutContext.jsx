import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useAuth } from './AuthContext';
import { logAuditEvent } from '../utils/auditLog';
import { usePerfTier } from '../utils/perfTier';
import {
  LAST_ACTIVITY_KEY,
  LOGOUT_BROADCAST_KEY,
  beginSessionTeardown,
  restoreReturnPath,
  saveReturnPath,
} from '../utils/sessionKeys';

const SessionTimeoutContext = createContext();

// Production Configuration
const INACTIVITY_TIMEOUT = 15 * 60 * 1000;                        // logout after 15 minutes of inactivity
const WARNING_DURATION = 120;                                     // 120-second warning countdown
const WARNING_TIME = INACTIVITY_TIMEOUT - WARNING_DURATION * 1000; // warning shows at 13 minutes
const ACTIVITY_THROTTLE_MS = 1000;                                // record activity at most once per second
const ESCALATE_SECONDS = 30;                                      // last 30s of the countdown turn red

// "1 minute", "13 minutes", "45 seconds"
function humanTime(ms) {
  const secs = Math.max(Math.round(ms / 1000), 0);
  if (secs < 60) return secs === 1 ? '1 second' : `${secs} seconds`;
  const mins = Math.round(secs / 60);
  return mins === 1 ? '1 minute' : `${mins} minutes`;
}

/**
 * SessionTimeoutProvider
 * Automatically logs out users after 15 minutes of inactivity.
 * Shows a 120-second warning before logout (red for the last 30s).
 *
 * Inactivity is tracked ACROSS TABS via localStorage (LAST_ACTIVITY_KEY):
 *  - activity in any tab keeps the session alive in every tab
 *  - a logout in any tab (manual or timeout) immediately logs out every tab
 * Only real user input (mouse / keyboard / touch / scroll) counts as activity.
 * Background API polling deliberately does NOT keep the session alive.
 */
function SessionTimeoutProvider({ children }) {
  const { logout, authenticated, user } = useAuth();
  const [modalVisible, setModalVisible] = useState(false);
  const [countdown, setCountdown] = useState(WARNING_DURATION);

  // Keep the latest user/logout in refs so timer callbacks never go stale.
  const userRef = useRef(user);
  useEffect(() => { userRef.current = user; }, [user]);
  const logoutRef = useRef(logout);
  useEffect(() => { logoutRef.current = logout; }, [logout]);

  // "Stay Logged In" handler is created inside the effect (where the timers
  // live) and exposed to the modal through this ref.
  const stayLoggedInRef = useRef(null);
  const signOutNowRef = useRef(null);
  const resetTimersRef = useRef(null);

  useEffect(() => {
    if (!authenticated) {
      setModalVisible(false);
      return;
    }

    let warningTimer = null;
    let logoutTimer = null;
    let countdownInterval = null;
    let warningShowing = false;
    let loggingOut = false;
    let lastRecorded = 0;

    const readSharedActivity = () => {
      try {
        const v = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
        if (Number.isFinite(v) && v > 0) return v;
      } catch { /* storage unavailable */ }
      return Date.now();
    };

    const writeSharedActivity = (ts) => {
      try { localStorage.setItem(LAST_ACTIVITY_KEY, String(ts)); } catch { /* non-critical */ }
    };

    const clearTimers = () => {
      if (warningTimer) { clearTimeout(warningTimer); warningTimer = null; }
      if (logoutTimer) { clearTimeout(logoutTimer); logoutTimer = null; }
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    };

    const doLogout = async () => {
      if (loggingOut) return;
      loggingOut = true;
      saveReturnPath();
      beginSessionTeardown();
      clearTimers();
      warningShowing = false;
      setCountdown(0);
      setModalVisible(true);

      const who = userRef.current?.email || userRef.current?.username || '';
      try {
        await logAuditEvent('session_timeout', who, who, 'Session timed out due to inactivity');
      } catch (error) {
        console.error('Session timeout audit error:', error);
      }
      try {
        await logoutRef.current();
      } catch (error) {
        console.error('Session timeout logout error:', error);
        // Fail-safe: never leave the user on a page with an expired session.
        restoreReturnPath();
        window.location.replace(window.location.origin + '/logout');
      }
    };

    const dismissWarning = () => {
      warningShowing = false;
      setModalVisible(false);
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    };

    const showWarning = () => {
      warningShowing = true;
      setCountdown(WARNING_DURATION);
      setModalVisible(true);

      let remaining = WARNING_DURATION;
      countdownInterval = setInterval(() => {
        remaining -= 1;
        setCountdown(Math.max(remaining, 0));
        if (remaining <= 0) {
          clearInterval(countdownInterval);
          countdownInterval = null;
          doLogout(); // safety net — the absolute logout timer below also fires
        }
      }, 1000);
    };

    // (Re)schedule the warning + logout timers relative to the last activity
    // recorded by ANY tab. Both callbacks re-verify the shared timestamp when
    // they fire, so activity in another tab never causes a false logout here.
    const scheduleTimers = () => {
      if (loggingOut) return;
      clearTimers();
      if (warningShowing) dismissWarning();

      const elapsed = Date.now() - readSharedActivity();

      warningTimer = setTimeout(() => {
        const idleFor = Date.now() - readSharedActivity();
        if (idleFor < WARNING_TIME) {
          // Another tab saw activity — reschedule instead of warning.
          scheduleTimers();
          return;
        }
        showWarning();
      }, Math.max(WARNING_TIME - elapsed, 0));

      logoutTimer = setTimeout(() => {
        const idleFor = Date.now() - readSharedActivity();
        if (idleFor < INACTIVITY_TIMEOUT) {
          scheduleTimers();
          return;
        }
        doLogout();
      }, Math.max(INACTIVITY_TIMEOUT - elapsed, 0));
    };

    const handleActivity = () => {
      if (loggingOut) return;
      // While the warning modal is up, only the "Stay Logged In" button
      // extends the session — stray mouse movement must not dismiss it.
      if (warningShowing) return;
      const now = Date.now();
      if (now - lastRecorded < ACTIVITY_THROTTLE_MS) return;
      lastRecorded = now;
      writeSharedActivity(now);
      scheduleTimers();
    };

    const handleStayLoggedIn = () => {
      if (loggingOut) return;
      const now = Date.now();
      lastRecorded = now;
      writeSharedActivity(now);
      dismissWarning();
      scheduleTimers();
    };

    // "Sign out now" is a normal sign-out, so AuthContext logs it as user_logout.
    const handleSignOutNow = async () => {
      if (loggingOut) return;
      loggingOut = true;
      clearTimers();
      warningShowing = false;
      setModalVisible(false);
      try {
        await logoutRef.current();
      } catch (error) {
        console.error('Sign out error:', error);
        window.location.replace(window.location.origin + '/logout');
      }
    };

    // React to other tabs: activity there keeps this tab alive; logout there
    // logs this tab out immediately.
    const handleStorage = (e) => {
      if (loggingOut) return;
      if (e.key === LOGOUT_BROADCAST_KEY && e.newValue) {
        loggingOut = true;
        beginSessionTeardown();
        clearTimers();
        setModalVisible(false);
        // Remember this tab's page so signing back in from here restores it.
        saveReturnPath();
        window.location.replace(window.location.origin + '/logout');
        return;
      }
      if (e.key === LAST_ACTIVITY_KEY && e.newValue) {
        if (warningShowing) dismissWarning();
        scheduleTimers();
      }
    };

    stayLoggedInRef.current = handleStayLoggedIn;
    signOutNowRef.current = handleSignOutNow;
    resetTimersRef.current = scheduleTimers;

    // Opening / focusing an authenticated tab counts as activity.
    writeSharedActivity(Date.now());
    scheduleTimers();

    const events = ['mousedown', 'mousemove', 'keydown', 'click', 'scroll', 'touchstart', 'wheel'];
    events.forEach(event => window.addEventListener(event, handleActivity, { passive: true }));
    window.addEventListener('storage', handleStorage);

    return () => {
      events.forEach(event => window.removeEventListener(event, handleActivity));
      window.removeEventListener('storage', handleStorage);
      clearTimers();
      stayLoggedInRef.current = null;
      signOutNowRef.current = null;
      resetTimersRef.current = null;
    };
  }, [authenticated]);

  const value = {
    resetTimers: () => resetTimersRef.current?.(),
  };

  return (
    <SessionTimeoutContext.Provider value={value}>
      {children}
      {modalVisible && authenticated && (
        <SessionTimeoutModalPortal
          countdown={countdown}
          onStayLoggedIn={() => stayLoggedInRef.current?.()}
          onSignOutNow={() => signOutNowRef.current?.()}
        />
      )}
    </SessionTimeoutContext.Provider>
  );
}

function SessionTimeoutModalPortal(props) {
  return ReactDOM.createPortal(<SessionTimeoutModal {...props} />, document.body);
}

function formatClock(left) {
  if (left <= 0) return '0s';
  if (left < 60) return left + 's';
  return Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
}

function SessionTimeoutModal({ countdown, onStayLoggedIn, onSignOutNow }) {
  // Cloud PCs with no GPU paint blur, big shadows and animations on the CPU.
  // Only the 'full' tier gets them; everyone else gets the flat version.
  const fancy = usePerfTier() === 'full';
  const left = Math.max(Math.min(countdown, WARNING_DURATION), 0);
  const done = left === 0;
  const urgent = left <= ESCALATE_SECONDS;
  const idleText = humanTime(WARNING_TIME);
  const limitText = humanTime(INACTIVITY_TIMEOUT);

  let headline = 'Your session is about to expire';
  if (done) headline = 'Signing you out';
  else if (urgent) headline = 'Your session ends in a moment';

  const body = done
    ? 'Hold on while we close your session. You can sign straight back in from the next screen.'
    : WARNING_TIME > 0
      ? `You have been idle for ${idleText}. SmartHub signs you out after ${limitText} to protect the data on screen.`
      : `SmartHub signs you out after ${limitText} of inactivity to protect the data on screen.`;

  const footnote = done
    ? 'Unsaved filters and draft queries are not kept.'
    : `Staying signed in gives you another ${limitText}. Nothing on screen is lost.`;

  const overlayCls = fancy
    ? 'bg-jj-gray-08/[0.46] backdrop-blur-[2.5px] animate-[sw-fade_180ms_ease-out]'
    : 'bg-jj-gray-08/[0.62]';

  const cardCls = fancy
    ? 'shadow-[0_34px_80px_-28px_rgba(0,0,0,0.5)] animate-[sw-rise_220ms_ease-out]'
    : 'shadow-[0_8px_24px_rgba(0,0,0,0.25)]';

  const stayCls = fancy
    ? 'shadow-[0_6px_14px_-6px_theme(colors.jj-red/60%)] hover:shadow-[0_10px_20px_-8px_theme(colors.jj-maroon-05/70%)] transition-[background-color,box-shadow] duration-150'
    : '';

  return (
    <div
      data-session-timeout-modal
      className={`fixed inset-0 z-[999999] flex items-center justify-center box-border px-6 py-12 font-johnson-text ${overlayCls}`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sw-title"
        aria-describedby="sw-body"
        className={`w-full max-w-[480px] bg-jj-white rounded-[14px] overflow-hidden [contain:layout_paint] ${cardCls}`}
      >
        <div className="h-[3px] bg-jj-red" />

        <div className="px-[34px] pt-[30px] pb-[26px]">
          <div className="flex items-center gap-2">
            <span className="w-[7px] h-[7px] rounded-full bg-jj-red flex-none" />
            <span className="text-[11px] font-normal tracking-[0.11em] uppercase text-jj-gray-06">
              Still there?
            </span>
          </div>

          <h2
            id="sw-title"
            className="mt-3 font-johnson-display font-bold text-[26px] leading-[1.12] tracking-[-0.01em] text-jj-gray-08"
          >
            {headline}
          </h2>

          <p id="sw-body" className="mt-3 text-[15px] leading-[1.6] text-jj-gray-07 max-w-[42ch]">
            {body}
          </p>

          {!done && (
            <p className="mt-2 text-[12.5px] leading-normal text-jj-gray-06">
              Click on "Stay signed in" button to extend your session.
            </p>
          )}

          <div className="mt-6">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] font-normal tracking-[0.08em] uppercase text-jj-gray-07">
                Time remaining
              </span>
              <span
                aria-live={urgent ? 'assertive' : 'off'}
                className={`font-johnson-display font-bold text-[22px] leading-none tabular-nums ${urgent ? 'text-jj-red' : 'text-jj-gray-08'}`}
              >
                {formatClock(left)}
              </span>
            </div>
            <div className="mt-[9px] h-[3px] rounded-sm bg-jj-gray-01 overflow-hidden">
              {/* scaleX, not width, so the tick doesn't trigger layout */}
              <div
                className={`h-full origin-left ${urgent ? 'bg-jj-red' : 'bg-jj-gray-08'} ${fancy ? 'transition-transform duration-1000 ease-linear' : ''}`}
                style={{ transform: `scaleX(${left / WARNING_DURATION})` }}
              />
            </div>
          </div>

          {!done && (
            <div className="flex flex-wrap gap-2.5 mt-[26px]">
              <button
                type="button"
                onClick={onStayLoggedIn}
                className={`flex-[1_1_200px] border-0 px-6 py-3.5 rounded-lg bg-jj-red text-jj-white font-johnson-text font-bold text-[15px] cursor-pointer hover:bg-jj-maroon-05 ${stayCls}`}
              >
                Stay signed in
              </button>
              <button
                type="button"
                onClick={onSignOutNow}
                className={`px-5 py-3.5 rounded-lg border border-jj-gray-04 bg-jj-white text-jj-gray-08 font-johnson-text font-normal text-[15px] cursor-pointer hover:bg-jj-gray-01 hover:border-jj-gray-05 ${fancy ? 'transition-colors duration-150' : ''}`}
              >
                Sign out now
              </button>
            </div>
          )}

          <p className="mt-4 text-[12.5px] leading-normal text-jj-gray-06">
            {footnote}
          </p>
        </div>
      </div>

      {fancy && (
        <style>{`
          @keyframes sw-fade { from { opacity: 0; } to { opacity: 1; } }
          @keyframes sw-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        `}</style>
      )}
    </div>
  );
}

/**
 * Hook to access session timeout context
 */
export function useSessionTimeout() {
  const context = useContext(SessionTimeoutContext);
  if (!context) {
    throw new Error('useSessionTimeout must be used within a SessionTimeoutProvider');
  }
  return context;
}

// Export provider
export { SessionTimeoutProvider };