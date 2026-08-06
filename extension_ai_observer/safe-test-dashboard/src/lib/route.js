// =============================================================================
// route — the non-component half of the minimal router (see lib/Link.jsx for
// the other half). Split into its own file because a file mixing component
// and non-component exports breaks React Fast Refresh — ESLint's
// react-refresh/only-export-components rule catches exactly this.
//
// ⚠ THIS FILE BEING CORRECT IS NOT SUFFICIENT ON ITS OWN. Cloudflare Pages
// serves static files: a direct request or a refresh on /privacy 404s unless
// `public/_redirects` tells it to fall back to index.html so React can read
// the path and render the right thing client-side. Both halves exist:
// `usePathname` reads `window.location.pathname`, and `_redirects` is what
// gets a real HTTP request there in the first place. Removing either one
// breaks direct navigation while in-app <Link> clicks keep working, which is
// exactly the failure mode that is easy to miss testing only by clicking
// around the deployed app.
// =============================================================================

import { useSyncExternalStore } from 'react';

function subscribe(callback) {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
}

function getSnapshot() {
  return window.location.pathname;
}

// Server snapshot is unused (this app has no SSR pass), but useSyncExternalStore
// requires the argument.
function getServerSnapshot() {
  return '/';
}

/** Current pathname, reactive to browser back/forward and in-app navigate(). */
export function usePathname() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Push a new path without a full page load, and notify subscribers. */
export function navigate(path) {
  if (path === window.location.pathname) return;
  window.history.pushState({}, '', path);
  // pushState does not fire popstate on its own — dispatch one so every
  // usePathname() subscriber (there may be several) re-renders.
  window.dispatchEvent(new PopStateEvent('popstate'));
}
