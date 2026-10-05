import { lazy } from 'react';

// Pages are split into their own files and fetched the first time they're
// opened. Two things can go wrong with that:
//   - a release went out while the tab was open, so the file it asks for
//     no longer exists. One quiet reload picks up the new build.
//   - the network blipped. The error boundary in App offers a retry.

const RELOAD_KEY = 'smarthub:chunk-reload';

const isChunkError = (err) => err?.name === 'ChunkLoadError'
  || /dynamically imported module|Importing a module script failed|Loading (CSS )?chunk|Unable to preload/i.test(String(err?.message || err));

// Reload at most once a minute, so a file that's really missing can't loop
function reloadOnce() {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 60000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

// Vite fires this when a page's CSS or helper files fail to preload
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (e) => {
    if (reloadOnce()) e.preventDefault();
  });
}

export function lazyPage(loader) {
  let pending = null;
  const load = () => {
    if (!pending) {
      pending = loader().catch((err) => {
        pending = null; // let the next try fetch again
        if (isChunkError(err) && reloadOnce()) return new Promise(() => {}); // page is reloading
        throw err;
      });
    }
    return pending;
  };
  const Page = lazy(load);
  // Fetch ahead of time without rendering (used for background prefetch)
  Page.preload = () => load().catch(() => {});
  return Page;
}