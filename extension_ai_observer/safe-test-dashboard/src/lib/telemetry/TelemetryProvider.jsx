// =============================================================================
// src/lib/telemetry/TelemetryProvider.jsx
//
// Starts telemetry, keeps its identity in step with Supabase auth, and records
// client-side navigations.
//
// ⚠ COMPONENT-ONLY FILE, BY CONVENTION AND FOR A REASON. `useTelemetry` lives in
// its own module beside this one, the same way `useAuth.js` is split from
// `AuthContext.jsx`: a file mixing component and non-component exports breaks
// React Fast Refresh, which ESLint's react-refresh/only-export-components rule
// exists to catch. `src/lib/route.js` carries the same note.
// =============================================================================

import { useEffect, useRef } from 'react';
import { useAuth } from '../auth/useAuth.js';
import { usePathname } from '../route.js';
import {
  initTelemetry,
  identify,
  resetIdentity,
  capture,
  setSittingActivePredicate,
} from './posthog.js';
import { installGlobalErrorHandlers } from './errors.js';

/**
 * @param {object} props
 * @param {React.ReactNode} props.children
 * @param {() => boolean} [props.isSittingActive] Predicate reporting whether an
 *   exam is in progress. Used to refuse surveys mid-sitting.
 */
export function TelemetryProvider({ children, isSittingActive }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();

  /**
   * ⚠ THE LAST IDENTITY WE SYNCED, NOT THE LAST USER OBJECT WE SAW.
   *
   * Without this, every re-render that produced a new `user` object reference —
   * and `AuthContext` builds a fresh state object on each `applySession` —
   * would call `identify()` again. PostHog documents repeated identify() calls
   * as a real billing incident, because each one can trigger a fresh flag
   * request and a person-profile write. Comparing the ID rather than the object
   * is what makes this effect idempotent under React's actual render behaviour.
   */
  const syncedIdRef = useRef(null);

  // --- Init ----------------------------------------------------------------
  useEffect(() => {
    // `initTelemetry` is itself idempotent (see its ⚠ note), so StrictMode
    // double-invoking this effect is harmless rather than merely unlikely.
    initTelemetry({ isSittingActive });
    if (typeof isSittingActive === 'function') setSittingActivePredicate(isSittingActive);

    const teardown = installGlobalErrorHandlers({ isSittingActive });
    return teardown;
  }, [isSittingActive]);

  // --- Identity sync -------------------------------------------------------
  useEffect(() => {
    // ⚠ WAIT FOR AUTH TO SETTLE. `useAuth` reports `loading: true` before
    // `getSession()` resolves, and `user` is null throughout. Acting on that
    // null would call reset() on every page load — discarding the anonymous
    // distinct_id that ties a visitor's pre-sign-in activity to their account,
    // which is the one thing identify() exists to preserve.
    if (loading) return;

    const id = user?.id ?? null;
    if (id === syncedIdRef.current) return;

    if (id) {
      // ⚠ THE WHOLE USER OBJECT IS PASSED AND ONLY `.id` IS READ — see
      // posthog.js's identify(), which refuses to send the email. Passing the
      // object rather than the id keeps that refusal in ONE place instead of
      // relying on every call site to remember it.
      identify(user);
    } else {
      resetIdentity();
    }
    syncedIdRef.current = id;
  }, [user, loading]);

  // --- Pageviews -----------------------------------------------------------
  useEffect(() => {
    // ⚠ MANUAL, BECAUSE THIS APP HAS NO ROUTER LIBRARY. `src/lib/route.js` is a
    // `useSyncExternalStore` over `popstate`, and `navigate()` dispatches a
    // synthetic PopStateEvent. `capture_pageview` is set to false in posthog.js
    // precisely so this is the single place a navigation is recorded, rather
    // than a mix of automatic and manual events that double-count.
    capture('$pageview', { pathname });
  }, [pathname]);

  return children;
}
