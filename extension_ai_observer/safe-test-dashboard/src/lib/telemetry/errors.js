// =============================================================================
// src/lib/telemetry/errors.js
//
// `captureProctorError(error, context)` — the enterprise error tracker.
//
// ⚠ AN ERROR OBJECT IS THE MOST DANGEROUS THING THIS CODEBASE HANDS TO
// TELEMETRY, because unlike an event payload nobody chose its contents. Three
// separate carriers, all of them accident- or attacker-controlled:
//
//   message  `String(error)` on a DOMException from getUserMedia, a PostgREST
//            body, or a fetch() TypeError naming a signed URL with a token in
//            its query string. A JSON.parse failure embeds its INPUT in the
//            message — and in this codebase that input is sometimes a data: URL.
//   stack    a frame can carry a base64 argument. An error thrown inside seal()
//            is thrown while a frame is on the stack.
//   custom   `supabase_rest.js`'s `_fetch` hangs `.reason` and `.cause` on the
//            errors it throws; other code hangs whatever it likes.
//
// All three go through `scrubText`, and custom properties go through
// `redactProperties`. None of that is optional.
// =============================================================================

import { capture, log } from './posthog.js';
import { EVENTS, LOG_LEVEL } from './events.js';
import { scrubText, redactProperties, hashId } from './redact.js';

/**
 * Where in the pipeline a failure happened.
 *
 * Covers the steps the brief named plus the ones this codebase actually has —
 * the two pre-exam advisories, the handshake and the raw REST path are all real
 * failure sites with distinct repairs.
 */
export const PIPELINE_STEP = Object.freeze({
  CAMERA_STREAM_INIT: 'camera_stream_init',
  LIGHTING_PREFLIGHT: 'lighting_preflight',
  FRAMING_PREFLIGHT: 'framing_preflight',
  MODEL_LOAD: 'model_load',
  LANDMARK_DETECTION: 'landmark_detection',
  POSE_PIPELINE: 'pose_pipeline',
  PHONE_DETECT: 'phone_detect',
  LIVENESS_CHALLENGE: 'liveness_challenge',
  EVIDENCE_CAPTURE: 'evidence_capture',
  SEAL_ENVELOPE: 'seal_envelope',
  UNSEAL_PAYLOAD: 'unseal_payload',
  EDGE_RPC: 'edge_rpc',
  SUPABASE_REST: 'supabase_rest',
  HANDSHAKE: 'handshake',
  SESSION_START: 'session_start',
  SESSION_STOP: 'session_stop',
  /** Only for the global handlers, where the step is genuinely unknown. */
  UNKNOWN: 'unknown',
});

const KNOWN_STEPS = new Set(Object.values(PIPELINE_STEP));

/**
 * ⚠ AN UNRECOGNISED STEP IS RECORDED AS-IS UNDER A MARKER, NEVER COERCED TO
 * `unknown`. A step this enum has not heard of is precisely the signal that the
 * enum has gone stale — silently folding it into `unknown` destroys the only
 * evidence that a new failure site exists, and `unknown` is already the busiest
 * bucket because the global handlers use it.
 */
function normaliseStep(step) {
  if (typeof step !== 'string' || !step) return { step: PIPELINE_STEP.UNKNOWN, unregistered: false };
  if (KNOWN_STEPS.has(step)) return { step, unregistered: false };
  return { step: scrubText(step, 60), unregistered: true };
}

// ---------------------------------------------------------------------------
// Stack cleaning
// ---------------------------------------------------------------------------

const MAX_FRAMES = 12;

/**
 * Turn a raw stack into something safe and stable.
 *
 * ⚠ ABSOLUTE PATHS ARE STRIPPED TO A REPO-RELATIVE FORM. A bundled stack carries
 * the build machine's filesystem layout (`D:\aiv.5\…`, `/home/runner/work/…`),
 * which is noise, a small disclosure about the build environment, and — worst —
 * fingerprint-destabilising: the same failure from two machines would otherwise
 * group as two separate issues.
 *
 * ⚠ EVERY FRAME IS SCRUBBED, not just the message. See the file header.
 */
function cleanStack(stack) {
  if (typeof stack !== 'string' || !stack) return [];
  return stack
    .split('\n')
    .slice(1, MAX_FRAMES + 1)
    .map((line) => scrubText(line, 200))
    .map((line) => line
      .replace(/[A-Za-z]:[\\/][^\s)]*[\\/]/g, '')
      .replace(/\/(?:home|Users|var|opt)\/[^\s)]*\//g, '')
      .replace(/https?:\/\/[^\s/)]+\//g, ''))
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * A stable grouping key.
 *
 * ⚠ DERIVED FROM (step, error name, first frame) AND DELIBERATELY NOT FROM THE
 * MESSAGE. Messages in this codebase carry varying ids — a requestId, a sitting
 * id, an HTTP status, a byte count — so fingerprinting on the message mints a
 * fresh "issue" per occurrence and the grouping becomes worthless. The first
 * frame is where the failure actually is, and it is stable across occurrences.
 */
function fingerprintFor(step, name, frames) {
  return hashId([step, name || 'Error', frames[0] || 'no-frame'].join('|'));
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * ⚠ THE PROCTORING LOOP RUNS AT 5–20 HZ AND AN ERROR INSIDE IT FIRES EVERY TICK.
 * Without this, one broken frame handler emits ~1200 events a minute — a billing
 * incident, a rate-limit, and an unreadable dashboard, all from a single bug.
 * The events are also near-identical, so the 1200th carries no information the
 * first did not.
 *
 * ⚠ THE SUPPRESSED COUNT IS REPORTED WHEN THE WINDOW REOPENS, so the volume is
 * never silently lost. "This happened once" and "this happened 4000 times" are
 * different findings, and that difference is the whole diagnostic value.
 */
const WINDOW_MS = 10000;
const MAX_PER_WINDOW = 3;
/** @type {Map<string, {windowStart: number, sent: number, suppressed: number}>} */
const buckets = new Map();

function admit(fingerprint, now) {
  let b = buckets.get(fingerprint);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    const carried = b ? b.suppressed : 0;
    b = { windowStart: now, sent: 1, suppressed: 0 };
    buckets.set(fingerprint, b);
    return { allowed: true, suppressedSinceLast: carried };
  }
  if (b.sent < MAX_PER_WINDOW) {
    b.sent += 1;
    return { allowed: true, suppressedSinceLast: 0 };
  }
  b.suppressed += 1;
  return { allowed: false, suppressedSinceLast: 0 };
}

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------

/**
 * Report one failure.
 *
 * ⚠ THE ENTIRE BODY IS WRAPPED AND SWALLOWS EVERYTHING. An exception escaping an
 * error handler is how a monitoring tool takes down the thing it monitors — and
 * this is called from `catch` blocks inside the proctoring loop, so a throw here
 * converts a recoverable frame error into a dead sitting. There is no failure of
 * this function worse than the failure it was called about.
 *
 * @param {unknown} error
 * @param {object} [context]
 * @param {string} [context.step] A PIPELINE_STEP value.
 * @param {string} [context.interaction] The UI interaction in flight, if any.
 * @param {string} [context.sittingId] Hashed before it is sent.
 * @param {'DEMO'|'CLASSROOM'} [context.sittingMode]
 * @param {boolean} [context.sittingActive]
 * @param {string} [context.tier] Tier A / Tier B.
 * @param {string} [context.provider] webgpu / wasm.
 * @param {Record<string, unknown>} [context.extra] Scrubbed like any other payload.
 * @returns {string|null} the fingerprint, or null if nothing could be built.
 */
export function captureProctorError(error, context = {}) {
  try {
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    const err = error instanceof Error ? error : null;
    const name = err ? err.name : (error && typeof error === 'object' ? 'NonError' : typeof error);
    // ⚠ String(error) on a non-Error can be anything at all, including a frame.
    const message = scrubText(err ? err.message : String(error), 300);
    const frames = cleanStack(err ? err.stack : '');

    const { step, unregistered } = normaliseStep(context.step);
    const fingerprint = fingerprintFor(step, name, frames);

    const { allowed, suppressedSinceLast } = admit(fingerprint, now);
    if (!allowed) return fingerprint;

    // `cause` is a real carrier here: supabase_rest.js's `_fetch` attaches the
    // original error as `.cause` and a reason code as `.reason`.
    const causeName = err && err.cause instanceof Error ? err.cause.name : undefined;
    const causeMessage = err && err.cause instanceof Error
      ? scrubText(err.cause.message, 200)
      : undefined;

    capture(EVENTS.PIPELINE_ERROR, {
      ...redactProperties(context.extra),
      pipeline_step: step,
      // Surfaced rather than hidden, so a stale enum is visible in the data.
      pipeline_step_unregistered: unregistered || undefined,
      error_name: scrubText(name, 80),
      error_message: message,
      error_reason: err && typeof err.reason === 'string' ? scrubText(err.reason, 80) : undefined,
      cause_name: causeName,
      cause_message: causeMessage,
      stack_frames: frames,
      stack_truncated: frames.length >= MAX_FRAMES || undefined,
      fingerprint,
      interaction: context.interaction ? scrubText(context.interaction, 80) : undefined,
      // ⚠ HASHED, NOT SENT RAW — a sitting id joins a person to an exam.
      sitting_id: context.sittingId ? hashId(context.sittingId) : undefined,
      sitting_mode: context.sittingMode,
      sitting_active: context.sittingActive,
      tier: context.tier,
      provider: context.provider,
      suppressed_since_last: suppressedSinceLast || undefined,
    });

    return fingerprint;
  } catch {
    // Deliberately empty. See the ⚠ above.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Global handlers
// ---------------------------------------------------------------------------

let installed = false;

/**
 * Route unhandled errors and rejections into the tracker.
 *
 * ⚠ THIS EXISTS BECAUSE `capture_exceptions` IS OFF. posthog.js disables
 * PostHog's own exception autocapture deliberately — its default is `undefined`,
 * meaning "inherit the remote project setting", which would let it be switched
 * on from a web UI with no code review, capturing raw stacks off the proctoring
 * loop. These handlers are the replacement, and unlike autocapture they attach
 * pipeline context and scrub before anything is sent.
 *
 * ⚠ GUARDED AGAINST DOUBLE-INSTALL. React StrictMode double-invokes effects, and
 * two installs would double every report and leak a listener on unmount.
 *
 * @param {object} [options]
 * @param {() => boolean} [options.isSittingActive]
 * @returns {() => void} teardown
 */
export function installGlobalErrorHandlers(options = {}) {
  if (installed || typeof window === 'undefined') return () => {};
  installed = true;

  const isSittingActive = typeof options.isSittingActive === 'function'
    ? options.isSittingActive
    : () => false;

  const activeNow = () => {
    try { return isSittingActive() === true; } catch { return false; }
  };

  const onError = (event) => {
    captureProctorError(event && event.error ? event.error : new Error(event && event.message), {
      step: PIPELINE_STEP.UNKNOWN,
      sittingActive: activeNow(),
      interaction: 'window.onerror',
    });
  };

  const onRejection = (event) => {
    captureProctorError(event && event.reason, {
      step: PIPELINE_STEP.UNKNOWN,
      sittingActive: activeNow(),
      interaction: 'unhandledrejection',
    });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return function teardown() {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    installed = false;
  };
}

/**
 * A handled failure that is not an exception — a reason code from a REST call, a
 * refused edge invocation. Distinct from captureProctorError because these carry
 * no stack and are not defects.
 *
 * @param {string} step
 * @param {string} reason
 * @param {Record<string, unknown>} [props]
 */
export function reportPipelineFailure(step, reason, props) {
  const { step: s } = normaliseStep(step);
  log(LOG_LEVEL.WARN, 'pipeline step failed: ' + s, {
    ...props,
    pipeline_step: s,
    reason: scrubText(reason, 80),
  });
}

/** Test-only. */
export function __resetErrorState() {
  buckets.clear();
  installed = false;
}
