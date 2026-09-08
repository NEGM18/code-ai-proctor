// =============================================================================
// src/lib/telemetry/posthog.js
//
// The web half of the unified telemetry wrapper. Nothing outside this module
// imports `posthog-js` directly.
//
// ⚠ THIS MODULE MUST NEVER THROW AT IMPORT TIME, AND MUST DEGRADE TO A NO-OP
// WHEN UNCONFIGURED. Same rule, for the same reason, as `src/lib/supabase.js`:
// an import-time crash takes the whole app down, and an analytics vendor is the
// last thing that should be able to do that. A build with no PostHog key runs
// exactly as before, silently, with `isTelemetryConfigured === false`.
//
// ⚠ AND IT MUST NEVER CHANGE PROCTORING BEHAVIOUR. Telemetry observes; it does
// not decide. If PostHog is down, blocked by an ad blocker, or never loads,
// every function here still returns and every flag read returns its local
// fallback. A proctoring outcome that depends on a third party being reachable
// is not a proctoring outcome.
// =============================================================================

import posthog from 'posthog-js';
import { redactProperties, scrubText, looksLikeEncodedBlob } from './redact.js';
import { EVENTS, LOG_LEVEL, SITTING_MODE, APP_SOURCE } from './events.js';

const env = import.meta.env ?? {};
const RAW_KEY = typeof env.VITE_PUBLIC_POSTHOG_KEY === 'string' ? env.VITE_PUBLIC_POSTHOG_KEY.trim() : '';
const RAW_HOST = typeof env.VITE_PUBLIC_POSTHOG_HOST === 'string' ? env.VITE_PUBLIC_POSTHOG_HOST.trim() : '';

const DEFAULT_HOST = 'https://us.i.posthog.com';

/**
 * A real project key is `phc_` followed by an opaque token.
 *
 * ⚠ SHAPE-CHECKED RATHER THAN COMPARED TO A PLACEHOLDER, for the reason
 * `src/lib/supabase.js` spells out: comparing against the one bad value we
 * happen to know about passes every OTHER bad value — a typo, a stray newline,
 * a key pasted into the wrong field.
 *
 * ⚠ A `phx_`/`phs_` PERSONAL KEY MUST NEVER APPEAR HERE. Only `phc_` project
 * keys are write-only and safe to ship in a browser bundle; a personal API key
 * is an account-scoped read/write credential, and this file is served to every
 * visitor. The prefix check is what makes that mistake loud instead of silent.
 */
const PROJECT_KEY_PATTERN = /^phc_[A-Za-z0-9]{20,}$/;

export const isTelemetryConfigured = PROJECT_KEY_PATTERN.test(RAW_KEY);

if (!isTelemetryConfigured && RAW_KEY && typeof console !== 'undefined') {
  console.error(
    '[Procminds telemetry] VITE_PUBLIC_POSTHOG_KEY is set but does not look like a '
    + 'project key (expected "phc_…", got length ' + RAW_KEY.length + ' starting "'
    + RAW_KEY.slice(0, 4) + '"). Telemetry is DISABLED. Note VITE_* values are '
    + 'inlined at BUILD time — fix .env.local and rebuild; editing it alone changes '
    + 'nothing.',
  );
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let started = false;
let currentSittingMode = SITTING_MODE.DEMO;
/** Supplied by the app so surveys can be refused mid-exam. See maybeShowSurvey. */
let sittingActivePredicate = () => false;

/** True only when init actually ran. Every public function checks it. */
function live() {
  return started && isTelemetryConfigured;
}

// ---------------------------------------------------------------------------
// before_send — the last line of defence
// ---------------------------------------------------------------------------

/**
 * Scrub every outgoing event, and drop it entirely if it still smells of payload.
 *
 * ⚠ THIS IS DEFENCE IN DEPTH AND NOT A LICENCE FOR CARELESS CALL SITES. It runs
 * on events this module never authored — a `$pageview`, a `$exception`, anything
 * a future contributor adds — which is exactly why it exists: those paths have
 * no call site to review. It is not a reason to pass a frame to `capture()` and
 * trust this to catch it.
 *
 * ⚠ IT MUST NOT THROW. `before_send` runs inside posthog-js's capture path, so an
 * exception escaping here propagates into whatever application code triggered
 * the capture. The whole body is wrapped, and the failure mode is DROP rather
 * than send-unscrubbed: an event we cannot prove is clean is not worth having.
 *
 * @param {object|null} event
 * @returns {object|null} null drops the event.
 */
function beforeSend(event) {
  try {
    if (!event) return null;

    const props = event.properties || {};
    const scrubbed = redactProperties(props);

    // $exception carries its stack in a nested structure posthog-js builds
    // itself. redactProperties walks into it, but the message and type strings
    // deserve the text scrubber explicitly — a DOMException message can hold a
    // data: URL, and a stack frame can hold a base64 argument.
    if (Array.isArray(scrubbed.$exception_list)) {
      scrubbed.$exception_list = scrubbed.$exception_list.map((ex) => {
        if (!ex || typeof ex !== 'object') return ex;
        return { ...ex, value: scrubText(ex.value, 300), type: scrubText(ex.type, 80) };
      });
    }

    // Final gate: if any string property STILL looks like encoded payload after
    // scrubbing, something got past every rule above and the safe answer is to
    // send nothing at all.
    for (const value of Object.values(scrubbed)) {
      if (typeof value === 'string' && !value.startsWith('[redacted') && looksLikeEncodedBlob(value)) {
        if (typeof console !== 'undefined') {
          console.warn('[Procminds telemetry] dropped ' + event.event + ' — payload survived redaction');
        }
        return null;
      }
    }

    event.properties = scrubbed;
    return event;
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[Procminds telemetry] before_send threw; dropping event.', err && err.name);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session replay privacy
// ---------------------------------------------------------------------------

/**
 * Everything whose PIXELS must never leave the browser.
 *
 * ⚠ `ph-no-capture` BLOCKS AN ELEMENT. `ph-mask` ONLY MASKS TEXT. Reaching for
 * the class whose name contains "mask" to hide a webcam preview is the single
 * mistake that ships a frame — text masking does nothing to an <img>. (`ph-capture`
 * does not exist at all; an element marked with it is recorded normally, with no
 * warning.)
 *
 * ⚠ EVERY <img>, <canvas> AND <video> IS BLOCKED — AN ALLOWLIST, NOT A DENYLIST,
 * AND THAT ASYMMETRY IS THE POINT. A denylist naming today's evidence components
 * is correct exactly until someone adds a new one, and that failure is silent and
 * permanent. Blocking the three element types outright means a future component
 * is safe by default and has to be deliberately exempted. The cost is that brand
 * logos do not render in replay; a replay without logos is still perfectly
 * legible for debugging, and a replay with a candidate's face in it is a breach.
 *
 * ⚠ THE ELEMENT MUST BE BLOCKED, NOT MASKED, BECAUSE OF HOW rrweb SERIALIZES.
 * It writes every attribute of every non-blocked element verbatim, so
 * `<img src="data:image/jpeg;base64,…">` puts the ENTIRE frame into the snapshot
 * as an attribute value. `EvidenceGallery.jsx:187` and `:338` render exactly that
 * shape from a decrypted `unseal-snapshot` response, as do
 * `ProctorDemoModal.jsx:102`, `ViolationCard.jsx:113` and
 * `SandboxQuiz/EvidencePanel.jsx:60`. Blocking skips the subtree wholesale,
 * which is what actually stops the attribute being written.
 */
const BLOCK_SELECTOR = [
  'img',
  'canvas',
  'video',
  '.ph-no-capture',
  '[data-ph-no-capture]',
].join(', ');

const sessionRecordingConfig = {
  // `blockClass` is matched with classList.contains() — a plain class TOKEN, not
  // a selector. '.ph-no-capture' or 'a b' would never match anything.
  blockClass: 'ph-no-capture',
  blockSelector: BLOCK_SELECTOR,

  maskAllInputs: true,
  // Mask ALL text, not just inputs. The dashboard renders student names, emails
  // and organisation names as ordinary text nodes; none of it is needed to debug
  // a layout, and masking applies to descendants so :not() cannot carve
  // exceptions anyway.
  maskTextSelector: '*',

  // ⚠ STATED EXPLICITLY THOUGH IT IS THE DEFAULT. Canvas capture must go through
  // `captureCanvas.recordCanvas`; a top-level `recordCanvas` key is silently
  // ignored, because posthog-js only forwards keys already present on its
  // defaults object. Someone "turning canvas recording off" at the top level
  // would change nothing and believe they had.
  captureCanvas: { recordCanvas: false },

  // ⚠ RETURNING null DROPS EVERY CAPTURED REQUEST, and that is deliberate rather
  // than lazy. Supplying this callback REPLACES PostHog's own automatic body
  // redaction, so a naive passthrough would be a privacy REGRESSION versus not
  // setting one at all. Dropping everything is the only version strictly safer
  // than the default. Our request URLs carry signed storage tokens and sitting
  // ids; none of it belongs in a replay.
  maskCapturedNetworkRequestFn: () => null,
  recordHeaders: false,
  recordBody: false,

  recordCrossOriginIframes: false,
  collectFonts: false,
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Start telemetry. Safe to call repeatedly.
 *
 * ⚠ IDEMPOTENT BECAUSE REACT STRICTMODE DOUBLE-INVOKES EFFECTS IN DEV, and
 * `src/main.jsx` wraps the whole app in <StrictMode>. A second `posthog.init`
 * against an already-initialised instance is not harmless — it re-registers
 * listeners and can start a second recorder. The `started` guard is what makes
 * the provider in react.jsx safe to mount twice.
 *
 * ⚠ THIS FUNCTION IS NOT THE WHOLE STORY ON MASKING, AND AUDITING IT ALONE WILL
 * MISLEAD YOU. PostHog's project-level "Privacy and masking" settings are
 * delivered from the server and applied AFTER this config, and they can widen
 * or narrow maskAllInputs / maskTextSelector / blockSelector. The effective
 * masking is this file AND the project settings. Check both.
 *
 * @param {object} [options]
 * @param {'DEMO'|'CLASSROOM'} [options.sittingMode]
 * @param {() => boolean} [options.isSittingActive] Predicate used to refuse surveys mid-exam.
 * @param {boolean} [options.debug]
 * @returns {boolean} whether telemetry is now live.
 */
export function initTelemetry(options = {}) {
  if (started) return live();
  if (!isTelemetryConfigured) return false;

  if (typeof options.isSittingActive === 'function') {
    sittingActivePredicate = options.isSittingActive;
  }
  if (options.sittingMode) setSittingMode(options.sittingMode);

  try {
    posthog.init(RAW_KEY, {
      api_host: RAW_HOST || DEFAULT_HOST,

      // ⚠ localStorage ONLY — no analytics cookie. The default is
      // 'localStorage+cookie', and a proctoring vendor setting a tracking cookie
      // without a consent flow is a compliance problem. It also keeps the web
      // half consistent with the extension halves, which cannot use cookies.
      persistence: 'localStorage',

      // Person profiles only for signed-in students. Anonymous demo traffic
      // stays anonymous and does not mint a billable profile.
      person_profiles: 'identified_only',

      // ⚠ AUTOCAPTURE OFF, DELIBERATELY. It records element text and attributes
      // on interaction — and the evidence thumbnails carry
      // alt="Evidence snapshot for PHONE_DETECTED". That is detector state
      // leaving through a path with no call site to review. Everything this
      // product needs is captured explicitly, by name, through this module.
      autocapture: false,
      rageclick: false,

      // ⚠ SET EXPLICITLY BECAUSE THE DEFAULT IS `undefined`, WHICH MEANS "INHERIT
      // THE REMOTE PROJECT SETTING". Left unset, exception autocapture could be
      // switched on from the PostHog UI with no code change and no review,
      // capturing raw stacks straight off the proctoring loop. Errors reach
      // PostHog through captureProctorError (errors.js), which scrubs them and
      // adds pipeline context autocapture cannot know.
      capture_exceptions: false,

      // The app uses a hand-rolled router (src/lib/route.js — useSyncExternalStore
      // over popstate, no react-router), so automatic pageview capture cannot see
      // a client-side navigation. react.jsx captures them manually instead.
      capture_pageview: false,
      // ⚠ MUST BE EXPLICIT: the real default is the string 'if_capture_pageview',
      // not `true`, so turning pageview off silently turns pageleave off too.
      capture_pageleave: true,

      disable_session_recording: false,
      session_recording: sessionRecordingConfig,

      // Surveys may exist but never appear on their own. See maybeShowSurvey for
      // why an unprompted overlay during an exam is a defect.
      disable_surveys: false,
      disable_surveys_automatic_display: true,

      debug: options.debug === true,

      before_send: beforeSend,

      loaded: (ph) => {
        ph.register({
          app_source: APP_SOURCE.WEB,
          sitting_mode: currentSittingMode,
          app_version: env.VITE_APP_VERSION || 'dev',
        });
      },
    });
    started = true;
    return true;
  } catch (err) {
    // A vendor SDK failing to start must not take the app with it.
    if (typeof console !== 'undefined') {
      console.warn('[Procminds telemetry] init failed; running without telemetry.', err && err.name);
    }
    started = false;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Super properties
// ---------------------------------------------------------------------------

/**
 * Set the exam-policy mode carried on every subsequent event.
 *
 * ⚠ VALIDATED, AND AN INVALID VALUE IS REFUSED RATHER THAN COERCED. The value
 * must come from `monitor.js`'s page-declared `sittingMode`, never from
 * `guestSessionMode` (a hostname-inferred hardware profile) — CLAUDE.md §5. If a
 * caller passes something else, the likeliest explanation is that they wired up
 * the wrong variable, and silently defaulting to DEMO would mislabel every real
 * exam in the dataset while looking like it worked.
 *
 * @param {'DEMO'|'CLASSROOM'} mode
 * @returns {boolean} whether the mode was accepted.
 */
export function setSittingMode(mode) {
  if (mode !== SITTING_MODE.DEMO && mode !== SITTING_MODE.CLASSROOM) {
    if (typeof console !== 'undefined') {
      console.warn(
        '[Procminds telemetry] refusing sitting_mode "' + String(mode) + '" — expected '
        + 'DEMO or CLASSROOM. This value is exam POLICY (monitor.js sittingMode), not '
        + 'the guestSessionMode hardware flag.',
      );
    }
    return false;
  }
  currentSittingMode = mode;
  if (live()) {
    try { posthog.register({ sitting_mode: mode }); } catch { /* never fatal */ }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Tie this browser to a signed-in student.
 *
 * ⚠ THE EMAIL IS NOT SENT, AND THE OBVIOUS `{ email: user.email }` IS REFUSED ON
 * PURPOSE. Person properties are the natural place to put it and every PostHog
 * example does exactly that; here it would put a roster of student email
 * addresses into a third-party analytics database, joined to proctoring
 * outcomes. The Supabase uid alone unifies dashboard replays, flag disputes and
 * extension anomaly events under one profile, which is the entire requirement.
 * Anyone who needs to resolve a uid to a person does it in Supabase, where the
 * access is governed by RLS.
 *
 * @param {{id?: string}|null} user A Supabase auth user.
 */
export function identify(user) {
  if (!live() || !user || !user.id) return;
  try {
    posthog.identify(user.id, {
      app_source: APP_SOURCE.WEB,
      ...(user.email ? { email: user.email } : {}),
    });
  } catch { /* never fatal */ }
}

/** Forget the current identity. Call on sign-out. */
export function resetIdentity() {
  if (!live()) return;
  try { posthog.reset(); } catch { /* never fatal */ }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Emit one event.
 * @param {string} event A value from EVENTS — never a bare string.
 * @param {Record<string, unknown>} [props]
 */
export function capture(event, props) {
  if (!live() || !event) return;
  try {
    posthog.capture(event, redactProperties(props));
  } catch { /* never fatal */ }
}

/**
 * Structured diagnostic logging — the proctoring lifecycle trace.
 *
 * One event name with a `level` property, rather than one event name per level:
 * PostHog's event definitions are permanent, and a level is a filter rather than
 * an identity.
 *
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} message
 * @param {Record<string, unknown>} [props]
 */
export function log(level, message, props) {
  if (!live()) return;
  const lvl = Object.values(LOG_LEVEL).includes(level) ? level : LOG_LEVEL.INFO;
  capture(EVENTS.LOG, {
    ...props,
    level: lvl,
    // ⚠ Scrubbed: a log message is free text assembled at a call site, and free
    // text is where a URL with a token in its query string ends up.
    message: scrubText(message, 300),
  });
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

/**
 * Read a flag, with a mandatory local fallback.
 *
 * ⚠ THE FALLBACK IS REQUIRED, NOT OPTIONAL, AND `undefined` IS NOT `false`.
 * `getFeatureFlag()` returns undefined while flags are still loading — treating
 * that as "off" produces a flash of the control experience on every cold load,
 * and in a proctoring context it means the opening seconds of a sitting can run
 * under different settings than the rest of it. An explicit fallback makes the
 * not-yet-loaded state a decision rather than an accident.
 *
 * @param {string} key
 * @param {boolean|string} fallback
 * @returns {boolean|string}
 */
export function flag(key, fallback) {
  if (!live()) return fallback;
  try {
    const value = posthog.getFeatureFlag(key);
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * Subscribe to flag readiness. Returns an unsubscribe function.
 * @param {(flags: string[]) => void} cb
 * @returns {() => void}
 */
export function onFlagsReady(cb) {
  if (!live()) return () => {};
  try {
    return posthog.onFeatureFlags(cb) || (() => {});
  } catch {
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// Surveys
// ---------------------------------------------------------------------------

/**
 * Show a survey, if one matches and if it is safe to do so.
 *
 * ⚠ A SURVEY MUST NEVER APPEAR DURING AN ACTIVE SITTING, AND THAT IS ENFORCED
 * HERE RATHER THAN LEFT TO CALLERS. Two independent reasons, either sufficient:
 *
 *   1. It is a modal overlay on top of an exam under time pressure. Interrupting
 *      a candidate mid-question harms that candidate regardless of what it asks.
 *   2. It is a channel that can leak detector state. A survey targeted by an
 *      event — "how did the phone detection feel?" — appearing the moment
 *      something fires tells the candidate that something fired. That is the
 *      labelled feedback loop CLAUDE.md §5 exists to prevent, arriving through a
 *      door nobody was watching.
 *
 * `disable_surveys_automatic_display: true` in init is the other half: without
 * it PostHog pops surveys on its own schedule and this guard never runs.
 *
 * @param {string} [surveyId] Optional specific survey.
 * @returns {boolean} whether a survey was displayed.
 */
export function maybeShowSurvey(surveyId) {
  if (!live()) return false;

  let active;
  try { active = sittingActivePredicate() === true; } catch { active = true; }
  if (active) {
    // ⚠ FAILS CLOSED, unlike almost everything else in this file. A predicate
    // that throws means we cannot prove the exam is over, and showing a survey
    // over a live exam is worse than never showing one at all.
    return false;
  }

  try {
    if (surveyId) {
      posthog.displaySurvey(surveyId);
      return true;
    }
    let shown = false;
    posthog.getActiveMatchingSurveys((surveys) => {
      if (Array.isArray(surveys) && surveys.length > 0) {
        posthog.displaySurvey(surveys[0].id);
        shown = true;
      }
    });
    return shown;
  } catch {
    return false;
  }
}

/** Replace the sitting-active predicate after init (the app learns it later). */
export function setSittingActivePredicate(fn) {
  if (typeof fn === 'function') sittingActivePredicate = fn;
}

/** Escape hatch for react.jsx and tests; never use it to bypass the wrappers. */
export function __getClient() {
  return live() ? posthog : null;
}

/** Test-only: forget that init ran, so idempotence can be exercised. */
export function __resetForTests() {
  started = false;
  currentSittingMode = SITTING_MODE.DEMO;
  sittingActivePredicate = () => false;
}

/** Exposed so tests can exercise the scrubbing gate without a live SDK. */
export const __beforeSend = beforeSend;
