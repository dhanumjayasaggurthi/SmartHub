import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRBAC } from '../../context/RBACContext';
import { IconDefs, Icon } from './shared/studioParts';
import { useInPageLog } from './useInPageLog';
import { PANES } from './panes';

// Kept the old key so people land on the pane they used last time.
const PANE_KEY = 'queryrunner.pane';

const readPane = () => {
  try { return window.localStorage.getItem(PANE_KEY); } catch { return null; }
};
const savePane = (id) => {
  try { window.localStorage.setItem(PANE_KEY, id); } catch { /* private mode */ }
};

// Tab bar on top, panes underneath. A pane is only mounted the first time it's
// opened, and stays mounted after that, so switching back finds the worksheet,
// the grid and any running query where they were left.
export default function DataStudio() {
  const { hasPermission } = useRBAC();
  const logInPage = useInPageLog();
  const [params, setParams] = useSearchParams();

  const panes = PANES.filter(p => !p.permission || hasPermission(p.permission));
  const has = (id) => panes.some(p => p.id === id);

  // ?pane wins so shared links open the right tab; the saved one is just the
  // default for a visit without it.
  const urlPane = params.get('pane');
  const active = has(urlPane) ? urlPane : has(readPane()) ? readPane() : panes[0]?.id;

  const [mounted, setMounted] = useState(() => new Set([active]));
  useEffect(() => {
    setMounted(prev => (prev.has(active) ? prev : new Set(prev).add(active)));
  }, [active]);

  const switchTo = (pane) => {
    if (pane.id === active) return;
    savePane(pane.id);
    setParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('pane', pane.id);
      return next;
    });
    logInPage('qr_pane', `Switched Data Studio to the ${pane.label} pane`);
  };

  if (!panes.length) {
    return (
      <div className="h-full flex items-center justify-center text-[13px] font-johnson-text text-jj-gray-06">
        You don&apos;t have access to any Data Studio tools yet.
      </div>
    );
  }

  // Nothing to switch between with a single pane, so skip the bar.
  if (panes.length === 1) {
    const Only = panes[0].component;
    return <Only logInPage={logInPage} active />;
  }

  return (
    <div className="h-full max-h-screen flex flex-col overflow-hidden bg-white">
      <IconDefs />

      <div className="flex-shrink-0 bg-jj-gray-01 border-b border-jj-gray-02 px-7 py-2">
        <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {panes.map(p => {
            const isActive = p.id === active;
            return (
              <button
                key={p.id}
                onClick={() => switchTo(p)}
                className={`group relative flex items-center gap-2 pl-[9px] pr-[13px] py-[6px] rounded-lg text-[12.5px] font-johnson-text whitespace-nowrap transition-all ${
                  isActive
                    ? 'bg-white text-jj-gray-08 font-medium shadow-[0_1px_4px_rgba(49,44,42,.14)] border border-jj-gray-02'
                    : 'border border-transparent text-jj-gray-06 hover:text-jj-gray-08 hover:bg-white/70'
                }`}
              >
                <span className={`flex items-center justify-center w-[19px] h-[19px] rounded-md transition-colors ${
                  isActive ? 'bg-jj-red/10' : 'bg-jj-gray-02/70 group-hover:bg-jj-gray-02'
                }`}>
                  <Icon src={p.icon} tint={null} className="w-[12px] h-[12px]" />
                </span>
                {p.label}
                {isActive && <span className="absolute left-3 right-3 -bottom-px h-[2px] rounded-full bg-jj-red" />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {panes.filter(p => mounted.has(p.id)).map(p => {
          const Pane = p.component;
          return (
            <div key={p.id} className={p.id === active ? 'h-full' : 'hidden'}>
              <Pane logInPage={logInPage} active={p.id === active} />
            </div>
          );
        })}
      </div>
    </div>
  );
}