const KEY = 'smarthub.recent.tools';
const MAX_AGE_DAYS = 30;

export const readRecentTools = () => {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY));
    if (!raw || typeof raw !== 'object') return {};
    // Drop anything stale so a tool opened once months ago does not sit at the
    // bottom of the strip forever.
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
    return Object.fromEntries(
      Object.entries(raw).filter(([, entry]) => entry?.last > cutoff)
    );
  } catch {
    return {};
  }
};

export const recordVisit = (visit) => {
  if (!visit) return;
  try {
    const all = readRecentTools();
    const previous = all[visit.toolId];
    all[visit.toolId] = {
      path: visit.path,
      trail: visit.trail,
      last: Date.now(),
      count: (previous?.count || 0) + 1,
    };
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // private browsing / quota — the strip just won't remember this visit
  }
};