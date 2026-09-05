// =============================================================================
// src/lib/telemetry/flags.js
//
// Feature flags and exam-milestone surveys.
//
// ⚠ THE GOVERNING RULE, AND IT IS THE WHOLE REASON THIS FILE HAS A GUARD IN IT:
//
//   A FEATURE FLAG MAY SWITCH UI, SAMPLING, OR TELEMETRY VERBOSITY.
//   IT MAY NEVER SWITCH A DETECTION THRESHOLD OR A SUPPRESSION RULE.
//
// CLAUDE.md §5 is a list of locally-pinned safety invariants — the phone
// confidence ORDERING (minConfidence < edgeConfidence < squareConfidence), the
// EAR veto allowlist, the three InterleaveGate triggers, the 3-of-5 confirmation
// window, POSE_MIN_DWELL_MS. Every one is pinned by a test, argued in a comment,
// and several were set by measurement against a held-out dataset.
//
// Moving any of them into a remote flag payload would mean a candidate's
// proctoring outcome depends on a value that:
//   - no test covers, because the tests pin the local constant;
//   - no code review saw, because it is edited in a vendor's web UI;
//   - has no audit trail tying "what was the threshold during this sitting" to
//     the sitting itself;
//   - can differ between two candidates sitting the same exam, since flags
//     evaluate per distinct_id — the exact fairness failure that disabled
//     `gaze_roi.js`'s direction estimate.
//
// `assertNotSafetyCritical` below refuses those keys outright, and it is tested.
// =============================================================================

import { useCallback, useSyncExternalStore } from 'react';
import { flag as readFlag, onFlagsReady, maybeShowSurvey, capture } from './posthog.js';
import { EVENTS } from './events.js';

/**
 * Surfaces a remote flag may never control.
 *
 * ⚠ MATCHED AS SUBSTRINGS, DELIBERATELY BROADER THAN THE EXACT CONSTANT NAMES.
 * The failure this prevents is somebody inventing `gaze_dwell_ms_v2` — a name no
 * exact-match list would ever contain. A false positive costs one renamed flag;
 * a false negative moves a safety invariant off-repo.
 */
const SAFETY_CRITICAL_FRAGMENTS = Object.freeze([
  'threshold', 'confidence', 'dwell', 'suppress', 'veto', 'allowlist',
  'stride', 'interleave', 'confirm_frames', 'min_hit', 'severity',
  'ear_', 'pose_', 'gaze_', 'phone_', 'detect_', 'liveness_',
  'aspect', 'tolerance', 'cooldown', 'grace_ms', 'alert_ms',
]);

/**
 * Refuse a flag key that names a detection surface.
 *
 * ⚠ THROWS RATHER THAN RETURNING FALSE. A flag read that silently returned its
 * fallback would look like it worked, and the author would ship believing they
 * had a remote control on a detector. The whole value of this guard is that it
 * fails at the moment of the mistake, loudly, in development.
 *
 * @param {string} key
 */
export function assertNotSafetyCritical(key) {
  const lower = String(key || '').toLowerCase();
  const hit = SAFETY_CRITICAL_FRAGMENTS.find((frag) => lower.includes(frag));
  if (hit) {
    throw new Error(
      'Refusing feature flag "' + key + '": the fragment "' + hit + '" names a detection '
      + 'surface. CLAUDE.md §5 pins detection thresholds and suppression rules as local, '
      + 'tested constants — a remote flag payload has no test coverage, no code review and '
      + 'no audit trail, and evaluates per-user, so two candidates could sit the same exam '
      + 'under different rules. Flags may switch UI, sampling or telemetry verbosity only.',
    );
  }
  return true;
}

/**
 * The registry. Every flag is declared here before it can be read.
 *
 * ⚠ DECLARING A FALLBACK IS MANDATORY. `getFeatureFlag()` returns `undefined`
 * while flags are loading, and forever if PostHog never loads at all — which is
 * the normal case behind a corporate proxy or an ad blocker, not an edge case.
 * The fallback is what the product does when the vendor is unreachable.
 */
export const FLAGS = Object.freeze({
  /**
   * ⚠ UI ONLY. Switches which readout the REVIEWER sees on the dashboard — a
   * coarse heuristic summary versus the full vector trace. It does NOT switch
   * which analyser runs during a sitting; that decision lives in
   * `vision_engine.js` behind `enableGaze` / `enableLandmarkGaze` and stays
   * local. The name is deliberately about presentation, not detection.
   */
  GAZE_TRACE_READOUT: Object.freeze({
    key: 'gaze-trace-readout',
    fallback: false,
    surface: 'dashboard-ui',
    description: 'Show the full vector trace in the reviewer gaze readout instead of the heuristic summary.',
  }),

  /** Beta flag-review interface on the student dashboard. */
  FLAG_REVIEW_BETA: Object.freeze({
    key: 'flag-review-beta',
    fallback: false,
    surface: 'dashboard-ui',
    description: 'Render the redesigned Flag Review panel.',
  }),

  /** Telemetry verbosity — sampling only, never behaviour. */
  VERBOSE_PIPELINE_TELEMETRY: Object.freeze({
    key: 'verbose-pipeline-telemetry',
    fallback: false,
    surface: 'telemetry',
    description: 'Emit per-tick pipeline diagnostics instead of per-episode summaries.',
  }),
});

/**
 * Read a declared flag.
 * @param {{key: string, fallback: boolean|string}} declaration A FLAGS entry.
 */
export function getFlag(declaration) {
  if (!declaration || !declaration.key) return false;
  assertNotSafetyCritical(declaration.key);
  return readFlag(declaration.key, declaration.fallback);
}

/**
 * React binding for a declared flag.
 *
 * Re-reads when flags arrive, so a cold load settles to the real value instead
 * of being stuck on the fallback for the life of the component.
 *
 * ⚠ `useSyncExternalStore`, NOT `useState` + `useEffect`, AND THE SAME CHOICE
 * `src/lib/route.js` MAKES FOR `usePathname`. PostHog's flag cache is exactly an
 * external store: it changes outside React, and the naive version — setState in
 * an effect body — causes a cascading second render on every mount, which
 * `react-hooks/set-state-in-effect` rejects. It also tears under concurrent
 * rendering, so two components reading the same flag in one pass could disagree.
 *
 * ⚠ THE SNAPSHOT MUST BE A PRIMITIVE. A flag value is a boolean or a string, so
 * returning it directly is safe; returning a fresh object here would re-render
 * forever, because React compares snapshots by identity.
 */
export function useFlag(declaration) {
  const subscribe = useCallback((onChange) => onFlagsReady(onChange), []);
  const getSnapshot = useCallback(() => getFlag(declaration), [declaration]);
  // No SSR pass in this app; the server snapshot must still be supplied, and the
  // fallback is the honest answer for "no client, no flags".
  const getServerSnapshot = useCallback(
    () => (declaration ? declaration.fallback : false),
    [declaration],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ---------------------------------------------------------------------------
// Exam-milestone surveys
// ---------------------------------------------------------------------------

/**
 * Ask for feedback after a sitting has FINISHED.
 *
 * ⚠ THE "FINISHED" PART IS ENFORCED IN posthog.js's maybeShowSurvey, NOT HERE,
 * so a caller cannot reach a survey by skipping this helper. See that function
 * for why an overlay during a sitting is both a harm to the candidate and a
 * detector-state leak.
 *
 * @param {object} [context]
 */
export function requestPostSittingSurvey(context = {}) {
  capture(EVENTS.SESSION_STOPPED, { survey_requested: true, ...context });
  return maybeShowSurvey();
}

/**
 * Ask for feedback when a candidate DISPUTES a flag.
 *
 * This is the highest-value feedback in the product: a disputed flag is a
 * candidate telling you the detector may have been wrong, attached to a specific
 * violation whose evidence still exists. It is also, unavoidably, a moment of
 * some distress — so the survey is offered after the dispute is recorded, never
 * as a gate in front of submitting one.
 *
 * @param {object} params
 * @param {string} params.violationType
 * @param {string|null} [params.verdict]
 */
export function requestDisputeSurvey(params = {}) {
  capture(EVENTS.FLAG_DISPUTED, {
    violation_type: params.violationType ?? null,
    verdict: params.verdict ?? null,
  });
  return maybeShowSurvey();
}
