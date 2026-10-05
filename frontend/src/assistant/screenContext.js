/*
  A dead-simple store for "what is the user looking at right now".

  Any page calls publishScreen({...}) with a small, plain summary of what's on
  screen — counts, the loaded run, the current filter, a short list of rows. The
  floating assistant reads the latest snapshot and sends it with each question, so
  it can answer "how many tables are here?" from the REAL number instead of guessing.

  Keep what you publish small and factual. It's injected into the prompt verbatim,
  so don't dump huge tables — a summary plus the first ~30 rows is plenty.
*/

let current = null;
let currentRoute = null;
const listeners = new Set();

export function publishScreen(snapshot) {
  current = snapshot ? { ...snapshot, at: Date.now() } : null;
  currentRoute = snapshot ? window.location.pathname : null;
  listeners.forEach((fn) => { try { fn(current); } catch {} });
}

export function clearScreen() {
  publishScreen(null);
}

export function getScreen() {
  // A page that published a snapshot and then unmounted without calling
  // clearScreen() (forgotten cleanup, or an unmount/mount ordering race during
  // a fast client-side navigation) would otherwise leave its last snapshot
  // sitting here forever, silently merged into every future page's screen
  // context. Route-check it at read time so a stale snapshot can never outlive
  // the page that published it, regardless of whether cleanup ran.
  if (current && currentRoute !== window.location.pathname) {
    current = null;
    currentRoute = null;
    return null;
  }
  return current;
}

export function subscribeScreen(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}