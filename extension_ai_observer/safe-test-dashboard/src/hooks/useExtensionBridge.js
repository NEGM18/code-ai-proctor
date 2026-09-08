// =============================================================================
// useExtensionBridge — detect the Procminds extension and manage guest quiz comms.
//
// Uses window.postMessage to communicate with the extension's guest_bridge.js
// content script. The extension responds to SAFETEST_DEMO_PING with
// SAFETEST_DEMO_PONG, and accepts SAFETEST_START_GUEST_QUIZ to enter guest
// proctoring mode.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';

import { ensureDemoSession } from '../lib/demoSnapshots.js';
import {
  HANDSHAKE_DEADLINE_MS,
  HANDSHAKE_REASON,
  HANDSHAKE_REPLY,
  TIMING_STATUS,
  createHandshakeRequest,
  evaluateHandshake,
} from '../lib/proctor/handshake.js';
import { supabase } from '../lib/supabase.js';
import { capture, EVENTS } from '../lib/telemetry/index.js';

const PING_TIMEOUT_MS = 1500;

/**
 * How long to wait past the deadline before concluding nothing will answer.
 *
 * ⚠ NOT THE DEADLINE ITSELF. A reply arriving at 505 ms is a SLOW_REPLY — a
 * measured fact about a proctor that WAS present — and giving up at exactly
 * 500 ms would record it as NO_REPLY, which reads as "no extension installed".
 * Those are different situations needing different responses (see
 * HANDSHAKE_REASON), so the listener stays open long enough to tell them apart
 * and lets `evaluateHandshake()` apply the real deadline.
 */
const HANDSHAKE_GIVE_UP_MS = HANDSHAKE_DEADLINE_MS + 1500;

/**
 * Input events that count as "the candidate had already started working".
 *
 * Captured, and on `window`, so a handler that calls `stopPropagation()` cannot
 * hide the interaction from us — the whole quantity is a claim about page
 * honesty, and the capture phase runs before anything in the tree can intercept.
 */
const INTERACTION_EVENTS = ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'wheel'];

/**
 * Was this document LOADED at the exam URL, rather than navigated to in-app?
 *
 * ⚠ READ FROM THE NAVIGATION TIMING ENTRY, NOT FROM A MODULE-LEVEL SNAPSHOT OF
 * `location.pathname`. The obvious implementation — capture the pathname when
 * this module first evaluates — is correct only for as long as nothing in the
 * bundle is lazily loaded, because a `React.lazy` on the exam route would move
 * module evaluation from document load to navigation time and silently invert
 * the answer. `PerformanceNavigationTiming.name` is the URL the DOCUMENT itself
 * was fetched with, which is the quantity actually being asked about and is
 * immune to how the bundle happens to be split.
 *
 * ⚠ AN UNAVAILABLE ENTRY RETURNS FALSE, WHICH SKIPS THE LATE_MOUNT CHECK
 * ENTIRELY. That is the lenient direction on purpose: the nav-start window
 * exists only for the deep-link/reload case, and applying it to a document
 * whose origin we cannot establish would grade ten minutes of ordinary browsing
 * on this single-page app as a late attach. See LANDING_GRACE_MS in handshake.js.
 */
function landedOnThisRoute() {
  try {
    const entry = performance.getEntriesByType?.('navigation')?.[0];
    if (!entry || typeof entry.name !== 'string') return false;
    return new URL(entry.name).pathname === window.location.pathname;
  } catch {
    return false;
  }
}

/**
 * A fresh id for ONE sitting.
 *
 * ⚠ THIS IS NOT `auth.uid()`, AND THE DIFFERENCE IS THE WHOLE POINT. The review
 * budget is specified as "3 reviewed frames per sitting", and it was keyed on
 * the account id — which is constant for the life of the account — so it was
 * really 3 per student, ever. A candidate's second sitting found the budget
 * already spent by their first, with nothing in any log saying why the AI
 * review had stopped working. `auth.uid()` remains the storage and RLS key
 * (every path and policy is built on it); this is only the SITTING key, and it
 * is what `proctor_sessions.demo_session_id` and `violations.demo_session_id`
 * join on.
 */
function mintSittingId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * How long after the LAST violation the live status stays raised.
 *
 * ⚠ THE LIVE STATUS AND THE EVIDENCE LOG ANSWER DIFFERENT QUESTIONS.
 *
 * The log is a history: "what happened during this session", and nothing should
 * ever be removed from it. The status banner is an instantaneous reading: "is
 * something wrong RIGHT NOW". Deriving the banner from `violations.length > 0`
 * conflated the two, so one glance away at minute one left the page declaring an
 * active incident for the remaining nine — which is both wrong and, in a product
 * that accuses people of cheating, exactly the wrong direction to be wrong in.
 *
 * The window is measured from the most recent violation, not from the first, so
 * a sustained episode keeps the banner up for as long as it keeps producing
 * events and clears 3 s after the candidate returns to compliance.
 */
export const LIVE_STATUS_RECOVERY_MS = 3000;

export const LIVE_STATUS = Object.freeze({
  NORMAL: 'NORMAL',
  ACTIVE: 'ACTIVE',
});

/**
 * Health of the extension's vision pipeline.
 *
 * ⚠ THREE STATES, NOT TWO. `null` (unknown / still loading) is deliberately
 * distinct from OFFLINE. A dead pipeline previously presented as a calm session
 * — the extension stayed connected and simply never reported anything — so
 * "nothing is happening" has to be distinguishable from "nothing is watching".
 */
export const VISION_STATUS = Object.freeze({
  ONLINE: 'ONLINE',
  OFFLINE: 'OFFLINE',
});

/**
 * @param {object} [options]
 * @param {'DEMO'|'CLASSROOM'} [options.mode] What kind of sitting this is.
 *   ⚠ DEFAULTS TO 'DEMO', AND THE DEFAULT IS LOAD-BEARING. It decides who reads
 *   a confirmed evidence frame. Defaulting to CLASSROOM would route the
 *   evidence of any caller that forgot to pass a mode — including every
 *   existing call site — into a teacher's queue they never consented to appear
 *   in. Sending a classroom frame to the student's own dashboard is the smaller
 *   error, so the default fails toward the narrower audience. Same rule as the
 *   column default in 20260822130000_sitting_lifecycle.sql.
 * @param {string|null} [options.classroomId] Which classroom, when CLASSROOM.
 */
export function useExtensionBridge({ mode = 'DEMO', classroomId = null } = {}) {
  const [extensionDetected, setExtensionDetected] = useState(null); // null = probing
  const [guestSessionId, setGuestSessionId] = useState(null);
  const [extensionViolations, setExtensionViolations] = useState([]);

  // ⚠ THE SESSION ID IS HELD IN A REF, NOT READ FROM STATE, BY `stopGuestQuiz`.
  //
  // A `useCallback` closing over `guestSessionId` gets a new identity whenever
  // that state changes, which changes the identity of the object this hook
  // returns, which re-runs any caller effect keyed on it. `DemoQuizPage` mounts
  // exactly such an effect, and its 1 Hz countdown re-renders — so the pair
  // became a stop+start of the ENTIRE proctoring stack once per second:
  // chrome.storage thrash, ONNX sessions torn down and rebuilt, the camera
  // reopened, and `clearDemoSessionData` deleting the visitor's own uploaded
  // evidence on every tick. Both callbacks below are therefore stable for the
  // life of the hook, and everything they need at call time comes from a ref.
  const sessionIdRef = useRef(null);

  // Generation counter. `startGuestQuiz` awaits an anonymous sign-in before it
  // can post anything; if the page unmounts during that await, the resolution
  // would otherwise start proctoring on a page that no longer exists and leave
  // the camera running with nothing left mounted to stop it. Any stop — and any
  // newer start — invalidates an in-flight start by bumping this.
  const startTokenRef = useRef(0);

  // Live compliance reading — see LIVE_STATUS_RECOVERY_MS. Held separately from
  // `extensionViolations` on purpose: the list only ever grows, and this only
  // ever reflects the last few seconds.
  const [liveStatus, setLiveStatus] = useState(LIVE_STATUS.NORMAL);
  const recoveryTimerRef = useRef(null);

  // null until the extension reports — see VISION_STATUS.
  const [visionStatus, setVisionStatus] = useState(null);
  const [visionReason, setVisionReason] = useState(null);

  // Non-null when a start was REFUSED for want of a verified session. Held as
  // state rather than logged, because "the proctoring stack never started" has
  // to be visible on the page: a silent no-op here would present as a demo that
  // is running and simply never detects anything — the exact failure the vision
  // OFFLINE banner exists to make impossible.
  const [blockedReason, setBlockedReason] = useState(null);

  // ── On-time proctoring proof ─────────────────────────────────────────────
  //
  // ⚠ THE OBSERVATIONS LIVE IN A REF AND THE VERDICT LIVES IN STATE, AND THEY
  // ARE NOT THE SAME OBJECT. `startGuestQuiz` is a `useCallback([])` that must
  // stay stable for the life of the hook — see the note on `sessionIdRef` above
  // for what a new identity here costs — so it cannot close over state. The
  // verdict is separately in state because it is the thing a caller may want to
  // render or log.
  //
  // ⚠ WHAT IS SENT TO THE EXTENSION IS THE MEASUREMENTS, NOT THE CONCLUSION.
  // `guest_bridge.js` re-derives the verdict from these raw numbers and
  // deliberately ignores any status the page sends: the value being recorded is
  // a statement about this page's own honesty, and a party under measurement
  // does not get to report its own result. `evaluateHandshake()` is run here
  // anyway so the page has an answer for its own UI, and because running the
  // same rule on both sides is what `handshake_contract.test.js` pins.
  const handshakeObsRef = useRef(null);
  const [handshake, setHandshake] = useState(null);

  /**
   * Resolves once the exchange has settled, however it settled.
   *
   * ⚠ `startGuestQuiz` MUST NOT POST START BEFORE THIS RESOLVES, AND THE RACE IT
   * PREVENTS PRODUCES A FALSE ACCUSATION-SHAPED RECORD.
   *
   * The handshake and the start are two independent async paths kicked off in
   * the same commit — `DemoQuizPage` calls `startGuestQuiz()` from its own mount
   * effect, not from a click. If START wins, `handshakeObsRef.current` is still
   * null, the payload carries `handshake: undefined`, and `gradeHandshake({})`
   * in guest_bridge.js compares `undefined !== _handshake.nonce` and returns
   * NONCE_MISMATCH — so a candidate whose extension answered correctly and on
   * time is written to `proctor_sessions.timing_status` as
   * LATE_PROCTOR_ATTACH, with a reason saying their reply was stale or replayed.
   * That is the exact conclusion the feature exists to draw only when it is true.
   *
   * Bounded by the same give-up timer as the exchange, so the wait is at most
   * HANDSHAKE_GIVE_UP_MS and only reaches that when nothing is going to answer.
   */
  const handshakeSettledRef = useRef(null);

  // Set when the extension REFUSED to start (no access token). Held as state
  // because a refusal that only reaches the console presents as a demo that is
  // running and simply never detects anything — the exact failure the vision
  // OFFLINE banner exists to make impossible.
  const [startRefusedReason, setStartRefusedReason] = useState(null);

  // The current sitting's id — see mintSittingId(). Null until a sitting starts.
  const [sittingId, setSittingId] = useState(null);
  const sittingIdRef = useRef(null);

  // ⚠ THE SITTING KIND IS MIRRORED INTO A REF BECAUSE `startGuestQuiz` MUST
  // STAY `useCallback([])`. Reading `mode` directly from the closure would
  // require listing it as a dependency, which changes the callback's identity
  // whenever a caller re-renders with a new options object literal — and the
  // header above records what that cost last time: a stop+start of the entire
  // proctoring stack once per second.
  //
  // ⚠ SYNCED IN AN EFFECT, NOT ASSIGNED DURING RENDER. The obvious spelling
  // (`modeRef.current = mode` at the top of the hook) is a render-phase side
  // effect, which React 19 rejects outright — `react-hooks/refs` fails the
  // build on it — because a render may be thrown away or replayed and the
  // write would survive a render that never committed. An unconditional effect
  // runs after every COMMIT, which is strictly early enough: the only reader is
  // `startGuestQuiz`, and that cannot fire before the candidate has clicked
  // something on a painted page.
  const modeRef = useRef(mode);
  const classroomIdRef = useRef(classroomId);
  useEffect(() => {
    modeRef.current = mode;
    classroomIdRef.current = classroomId;
  });

  const raiseLiveStatus = useCallback(() => {
    setLiveStatus(LIVE_STATUS.ACTIVE);
    // Restart the window rather than stacking timers, so a burst of violations
    // clears 3 s after the LAST one instead of 3 s after the first.
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = null;
      setLiveStatus(LIVE_STATUS.NORMAL);
    }, LIVE_STATUS_RECOVERY_MS);
  }, []);

  // A pending recovery timer must not outlive the component, or it fires
  // setState on an unmounted hook after the visitor has left the page.
  useEffect(() => () => {
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }, []);

  // ── Probe for extension on mount ─────────────────────────────────────────
  useEffect(() => {
    let resolved = false;

    const onMessage = (event) => {
      if (event.source !== window) return;
      if (event.data?.type === 'SAFETEST_DEMO_PONG' && event.data?.installed) {
        resolved = true;
        setExtensionDetected(true);
      }
    };

    window.addEventListener('message', onMessage);
    window.postMessage({ type: 'SAFETEST_DEMO_PING' }, '*');

    const timer = setTimeout(() => {
      if (!resolved) setExtensionDetected(false);
    }, PING_TIMEOUT_MS);

    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
    };
  }, []);

  // ── The handshake, run once on mount ─────────────────────────────────────
  //
  // ⚠ THIS RUNS BEFORE THE CAMERA OPENS, NOT AFTER, AND THAT ORDERING IS THE
  // FEATURE. The question it answers is "was the proctor attached at T=0", so
  // an exchange that waited for `startGuestQuiz` could only ever run after the
  // interval it exists to measure. `guest_bridge.js` handles the request ahead
  // of START for the same reason.
  //
  // ⚠ IT MUST NOT RE-RUN. A second exchange in the same document would overwrite
  // the first with a nonce minted long after the mount, turning a genuine early
  // attach into a late-looking one. The effect has an empty dependency list and
  // the guard below makes a StrictMode double-invoke idempotent.
  useEffect(() => {
    // The exchange belongs to this document, once. React 18 StrictMode mounts
    // effects twice in development; without this the second pass would post a
    // fresh nonce and the extension would answer THAT one, while the first
    // listener — already torn down — recorded nothing.
    if (handshakeObsRef.current) return undefined;

    const request = createHandshakeRequest();
    const startedAt = performance.now();
    let interacted = false;
    let settled = false;

    // Published before the first postMessage, so a `startGuestQuiz` racing this
    // effect finds a promise to wait on rather than no barrier at all.
    let releaseSettled;
    handshakeSettledRef.current = new Promise((resolve) => { releaseSettled = resolve });

    const noteInteraction = () => { interacted = true; };
    for (const name of INTERACTION_EVENTS) {
      window.addEventListener(name, noteInteraction, { capture: true, passive: true });
    }

    /**
     * Record the outcome exactly once.
     *
     * ⚠ EVERY PATH THROUGH HERE PRODUCES A RECORD, INCLUDING THE SILENT ONE.
     * A missing handshake and a failed one must be distinguishable downstream,
     * and both are distinct from "the exchange never ran" — which is what a
     * null would mean. `evaluateHandshake` grades all three; this only has to
     * make sure it is always called.
     */
    const settle = (reply) => {
      if (settled) return;
      settled = true;
      // Released on EVERY path, including the give-up timer and a malformed
      // reply. A settle() that could forget this would hang `startGuestQuiz`
      // for the life of the page — the camera would simply never open, which is
      // a far worse failure than the mis-grade this barrier prevents.
      if (releaseSettled) releaseSettled();

      const observations = {
        replied: !!reply,
        nonce: request.nonce,
        nonceEcho: reply?.nonce ?? null,
        // Measured with `performance.now()` rather than `Date.now()`: this is a
        // duration, and the wall clock can step (NTP, sleep/resume) inside a
        // window this short and produce a negative or absurd latency.
        latencyMs: reply ? Math.round(performance.now() - startedAt) : Number.NaN,
        interactedBeforeReply: interacted,
        landedOnQuiz: landedOnThisRoute(),
        sinceNavigationStartMs: Math.round(performance.now()),
        // Carried for telemetry only — the extension re-derives the verdict and
        // never reads these two.
        attested: typeof reply?.attestation === 'string' && reply.attestation.length > 0,
        strongNonce: request.strongNonce,
      };

      handshakeObsRef.current = observations;
      const verdict = evaluateHandshake(observations);
      setHandshake(verdict);
      capture(EVENTS.HANDSHAKE_GRADED, {
        status: verdict.status,
        reason: verdict.reason,
        on_time: verdict.onTime,
        latency_ms: Number.isFinite(verdict.latencyMs) ? verdict.latencyMs : null,
      });

      if (verdict.status !== TIMING_STATUS.ON_TIME_AT_QUIZ) {
        // Said once, plainly. A LATE grade with no explanation anywhere is how a
        // missing extension gets mistaken for a stalling candidate.
        console.warn(
          `[Procminds] Proctor handshake graded ${verdict.status} (${verdict.reason}`
          + `${verdict.latencyMs === null ? '' : `, ${verdict.latencyMs} ms`}).`
          + (verdict.reason === HANDSHAKE_REASON.NO_REPLY
            ? ' Usually this means the extension is not installed.'
            : ''),
        );
      }
    };

    const onMessage = (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.type !== HANDSHAKE_REPLY) return;

      // ⚠ ONLY A REPLY TO *OUR* CHALLENGE COUNTS. The ACK is broadcast to the
      // whole window, so this listener can see answers to nonces it never sent:
      //
      //   - StrictMode mounts this effect twice in development. Pass 1 posts
      //     nonce A and is torn down; pass 2 posts nonce B. The bridge answers
      //     BOTH, and A's answer can land after pass 2's listener is installed.
      //     Without this filter pass 2 settles on A, reports nonceEcho A against
      //     request B, and grades NONCE_MISMATCH — deterministically, on every
      //     `npm run dev` sitting, with a console warning about a "stale or
      //     replayed reply" that never happened.
      //   - The same shape occurs in production if two components mount this
      //     hook on one page.
      //
      // A reply carrying a different nonce is not an answer to this exchange, so
      // it is ignored rather than settled on. If nothing matching ever arrives
      // the give-up timer settles as NO_REPLY, which is the honest grade for
      // "we asked and were not answered". The NONCE_MISMATCH verdict is not lost
      // from the RECORD either way: `gradeHandshake` in guest_bridge.js re-derives
      // it against the extension's own `_handshake`, and that copy is the
      // authoritative one.
      // ⚠ STRICT EQUALITY, NOT A TYPE-GUARDED COMPARISON. This previously read
      // `if (typeof msg.nonce === 'string' && msg.nonce !== request.nonce)
      // return;` — which only rejected a WRONG STRING. A reply carrying no
      // nonce at all, or a nonce that is an object, array, number or null,
      // failed the `typeof` test, so the whole condition evaluated false and
      // the message fell through and SETTLED the exchange.
      //
      // That inverted the guard's purpose: `window.postMessage({type:
      // 'SAFETEST_PROCTOR_HANDSHAKE_ACK'}, '*')` from any script in the
      // document — the page itself, or any other installed extension — settles
      // with `nonceEcho: null`, permanently discards the genuine ACK arriving
      // milliseconds later, and stamps an honest candidate's sitting
      // LATE_PROCTOR_ATTACH / NONCE_MISMATCH. handshake.js's header documents
      // the opposite threat (a candidate forging a PASS); this is the one that
      // forces a FAIL against someone who did nothing wrong.
      //
      // `!==` on the raw value rejects every one of those: undefined, {}, [],
      // 123 and null are all unequal to our minted string. The only legitimate
      // first-party reply without a nonce is guest_bridge's
      // `{ok:false, reason:'NO_NONCE'}`, which it sends only when WE posted no
      // nonce — and `createHandshakeRequest()` always mints one, so that reply
      // is unreachable here and losing it costs nothing.
      if (msg.nonce !== request.nonce) return;

      settle(msg);
    };

    window.addEventListener('message', onMessage);
    window.postMessage(request, '*');

    const timer = setTimeout(() => settle(null), HANDSHAKE_GIVE_UP_MS);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      for (const name of INTERACTION_EVENTS) {
        window.removeEventListener(name, noteInteraction, { capture: true });
      }
      // ⚠ RELEASED ON TEARDOWN TOO. A StrictMode double-mount tears this effect
      // down before it can settle, and an unreleased barrier would leave any
      // `startGuestQuiz` already waiting on it blocked forever — a camera that
      // never opens. The second pass installs its own barrier immediately after.
      if (releaseSettled) releaseSettled();
    };
  }, []);

  // ── Listen for extension violation events ─────────────────────────────────
  useEffect(() => {
    const onMessage = (event) => {
      if (event.source !== window) return;
      const msg = event.data;

      // The content script was orphaned by an extension reload/update. It can
      // never recover in this page, so the banner must stop claiming proctoring
      // is active — otherwise the visitor is told they are being monitored by
      // something that is no longer running.
      if (msg?.type === 'SAFETEST_EXTENSION_DISCONNECTED') {
        setExtensionDetected(false);
        setLiveStatus(LIVE_STATUS.NORMAL);
        return;
      }

      // The vision pipeline reporting its own health. `null` means "no verdict
      // yet" and must stay distinct from OFFLINE: before the engine finishes
      // loading there is nothing wrong to announce, and showing a fault during
      // startup would train people to ignore it.
      // ⚠ THE EXTENSION CAN REFUSE A START, AND THE REFUSAL USED TO BE SILENT.
      // `guest_bridge.js` rejects a START carrying no access token and posts
      // this; with nothing listening, the page went on showing a started
      // sitting whose proctoring stack had never armed — a demo that looks
      // live and watches nothing, which is strictly worse than one that
      // visibly failed.
      if (msg?.type === 'SAFETEST_GUEST_START_REFUSED') {
        setStartRefusedReason(msg.reason || 'REFUSED');
        setLiveStatus(LIVE_STATUS.NORMAL);
        return;
      }

      if (msg?.type === 'SAFETEST_VISION_STATUS') {
        const state = msg.state === 'OFFLINE' ? VISION_STATUS.OFFLINE : VISION_STATUS.ONLINE;
        setVisionStatus(state);
        setVisionReason(msg.reason || null);
        capture(EVENTS.ENGINE_READY, {
          vision_status: state,
          reason: msg.reason || null,
          sitting_id: sittingIdRef.current || undefined,
        });
        return;
      }

      if (msg?.type === 'SAFETEST_GUEST_VIOLATION') {
        raiseLiveStatus();
        setExtensionViolations((prev) => [{
          id: msg.violationId || `ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: msg.violationType,
          severity: msg.severity,
          ear: msg.ear,
          snapshotUrl: msg.snapshotUrl,
          snapshotB64: msg.snapshotB64,
          tMs: msg.tMs,
          wallTime: Date.now(),
          source: 'extension',
        }, ...prev].slice(0, 50));
      }

      // ⚠ THE `SAFETEST_GUEST_SNAPSHOT_URL` AND `SAFETEST_GUEST_UPLOAD_FAILED`
      // HANDLERS WERE REMOVED HERE (2026-08-16), BECAUSE NOTHING SENDS THEM.
      //
      // Both existed to service the extension's own storage upload: one patched
      // a signed URL onto a card once it resolved, the other marked a card as
      // never having reached the bucket. That upload path is gone — frames now
      // travel to the `analyze-snapshot` Edge Function, which seals them and
      // returns a verdict rather than a viewable link — so a handler for either
      // message would be dead code implying a feature that no longer exists.
    };

    // The removal closes over this exact `onMessage`, and the effect has no
    // dependencies, so the handler added on mount is the handler removed on
    // unmount — no ghost listener survives a re-entry into /demo-quiz.
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // `raiseLiveStatus` is a stable useCallback([]), so listing it does not
    // re-bind the listener — it just keeps the dependency honest.
  }, [raiseLiveStatus]);

  // ── Start guest quiz ─────────────────────────────────────────────────────
  /**
   * ⚠ THE SESSION ID MUST BE `auth.uid()`, NOT A FRESH `crypto.randomUUID()`.
   *
   * This used to mint its own UUID and hand the extension a bare anon key. Both
   * halves were wrong against the bucket's policies:
   *
   *   - `demo_snapshots_insert_own` is granted `to authenticated` ONLY, and the
   *     migration states outright that there is no policy for the `anon` role —
   *     a path-only rule would let any caller list `demo/` and enumerate every
   *     visitor's face snapshots.
   *   - The policy requires `(storage.foldername(name))[2] = auth.uid()::text`,
   *     so an arbitrary client-generated UUID never matches even with a valid
   *     token.
   *
   * Every upload therefore 403'd, and `guest_bridge.js` swallowed it — the
   * evidence simply never appeared, with no error anywhere. `storage.objects`
   * holding zero rows is the fingerprint of exactly that.
   *
   * `ensureDemoSession()` already solves this correctly for the in-page demo:
   * it returns a `sessionId` that IS the caller's `auth.uid()`. Reusing it here
   * keeps one definition of "which folder may this visitor write to" instead of
   * a second, weaker one.
   *
   * ⚠ IT NO LONGER SIGNS ANYONE IN. That function used to call
   * `signInAnonymously()` when there was no session, which is what made the
   * demo reachable by anybody — see its header. It now only reports the session
   * the visitor already has, and this hook refuses to start when that session
   * is not a verified one.
   *
   * @returns {Promise<string|null>} the session id (auth.uid()), or null when
   *   the start was refused for want of a verified session.
   */
  const startGuestQuiz = useCallback(async () => {
    const token = ++startTokenRef.current;

    // ⚠ THE TWO AWAITS RUN CONCURRENTLY, NOT IN SERIES. The handshake barrier
    // and the session lookup are independent, and chaining them would add the
    // slower one's latency to the camera-open path for no reason. Both must
    // complete before START is posted: the session decides whether we may start
    // at all, the handshake decides what the sitting's timing_status will say.
    const handshakeSettled = handshakeSettledRef.current || Promise.resolve();

    const session = await ensureDemoSession(null);

    // ⚠ AN UNVERIFIED VISITOR STARTS NOTHING. THIS IS THE SECOND LOCK.
    //
    // `DemoGate` already refuses to mount `DemoQuizPage` without a verified
    // session, so in the normal flow this branch is unreachable — which is
    // exactly why it is here. This hook is what physically opens the camera and
    // arms the extension, and it must not do that on the strength of some other
    // component having checked. Anything that reaches this call unverified (a
    // future route added without the gate, a session that expired between mount
    // and start) gets nothing started, rather than a running proctoring session
    // whose every upload the server then refuses.
    if (!session.remote) {
      setBlockedReason(session.reason ?? 'NOT_SIGNED_IN');
      return null;
    }
    setBlockedReason(null);

    // The access token is what makes the request `authenticated` rather than
    // `anon`. ensureDemoSession deliberately does not return it — it is not
    // needed in-page, where the SDK attaches it — so read it here.
    let accessToken = null;
    let refreshToken = null;
    let identity = { email: null, name: null };
    if (supabase) {
      const { data } = await supabase.auth.getSession();
      accessToken = data?.session?.access_token ?? null;
      // ⚠ SENT SO THE EXTENSION'S REFRESH-ON-401 IS NOT DEAD ON THIS PATH.
      // A Supabase access token lives about an hour and exams do not; without a
      // refresh token `supabase_rest._refresh()` cannot run, so a long sitting
      // records violations perfectly for the first hour and then silently
      // records nothing — the exact quiet failure that function's header was
      // written to refuse. It is no new exposure: this value already sits in
      // this origin's localStorage, readable by anything running in the page,
      // and the access token beside it is already being handed over.
      refreshToken = data?.session?.refresh_token ?? null;
      identity = {
        email: data?.session?.user?.email ?? null,
        name: data?.session?.user?.user_metadata?.full_name
          ?? data?.session?.user?.user_metadata?.name
          ?? null,
      };
    }

    // The barrier. Awaited here rather than at the top so it overlaps the
    // session lookup above; by this point it has usually long since resolved.
    await handshakeSettled;

    // Superseded while we were signing in — the page was left, or a newer start
    // overtook this one. Posting START now would hand the extension a camera it
    // has no owner to release: the unmount already ran, so nothing downstream
    // will ever call stop for THIS session.
    //
    // ⚠ RE-TESTED AFTER THE HANDSHAKE AWAIT, NOT ONLY AFTER THE SESSION ONE.
    // The barrier adds a second suspension point, and a start superseded during
    // *it* is just as stale as one superseded during the sign-in.
    if (token !== startTokenRef.current) return session.sessionId;

    sessionIdRef.current = session.sessionId;
    setGuestSessionId(session.sessionId);
    setExtensionViolations([]);
    setStartRefusedReason(null);

    // ⚠ MINTED HERE, PER START, NOT PER MOUNT AND NOT PER ACCOUNT. One sitting
    // is one start->stop cycle, so this is the only moment that defines one.
    // See mintSittingId() for what keying the review budget on `auth.uid()`
    // silently did instead.
    const sitting = mintSittingId();
    sittingIdRef.current = sitting;
    setSittingId(sitting);

    window.postMessage({
      type: 'SAFETEST_START_GUEST_QUIZ',
      guestSessionId: session.sessionId,
      // The sitting this START opens. The extension writes it to
      // `proctor_sessions.demo_session_id`, which is what lets the Edge
      // Function find the sitting row and read its MODE — the routing decision
      // is then made from a server-side row rather than from a request body.
      sittingId: sitting,
      // ⚠ DECLARED BY THE PAGE, ENFORCED BY THE SERVER. The page is the only
      // party that knows whether this is the public demo or an invigilated
      // classroom exam, so it has to say. It is not TRUSTED with that: the
      // Edge Function re-reads the mode from the sitting row it wrote, and a
      // page that lied about it has only mislabelled its own record. What the
      // page must never be able to do is name the ROUTE directly, which would
      // let a classroom frame be kept out of a teacher's queue.
      mode: modeRef.current,
      classroomId: classroomIdRef.current || undefined,
      // ⚠ MEASUREMENTS, NOT A VERDICT — see handshakeObsRef. The extension
      // re-grades from these and ignores any status we might send.
      handshake: handshakeObsRef.current || undefined,
      supabaseUrl: import.meta.env?.VITE_SUPABASE_URL || undefined,
      // Still sent: Supabase requires the `apikey` header on every REST call in
      // addition to the bearer token. It is the token that grants the write.
      supabaseAnonKey: import.meta.env?.VITE_SUPABASE_ANON_KEY || undefined,
      accessToken: accessToken || undefined,
      // The extension writes this to chrome.storage as `sbRefreshToken`, which
      // is what `supabase_rest._refresh()` needs to survive a >1 h sitting.
      refreshToken: refreshToken || undefined,
      // Told explicitly rather than inferred from a missing token, so the
      // extension can log "local only, and here is why" instead of guessing.
      remote: session.remote,
      reason: session.reason,
      // ⚠ IDENTITY, NOT DECORATION. The extension used to label every demo
      // participant "Guest Visitor" because there was no one to name. There is
      // now, and a proctoring record that cannot say who was proctored is not a
      // proctoring record. The extension still treats these as untrusted page
      // input — they are display values, and the access decision was already
      // made by the token above.
      userEmail: identity.email || undefined,
      userName: identity.name || undefined,
    }, '*');

    capture(EVENTS.SESSION_STARTED, {
      sitting_id: sitting,
      sitting_mode: modeRef.current,
    });

    return session.sessionId;
  }, []);

  // ── Stop guest quiz ──────────────────────────────────────────────────────
  /**
   * ⚠ THE CLEANUP DELETE IS GONE, AND ITS ABSENCE IS THE POINT (2026-08-16).
   *
   * This used to call `clearDemoSessionData(uid)` on every stop, because the
   * extension uploaded raw webcam crops to `demo/{uid}/` and leaving them there
   * after the visitor closed the demo would have made the privacy claim on the
   * landing page untrue. Both halves of that reasoning have been replaced:
   *
   *   - Nothing writes a plaintext frame any more. The extension's upload path
   *     is removed and the bucket's four client policies are dropped, so this
   *     call could not delete anything even if it ran — it would issue a list
   *     and a remove that RLS refuses, then report a partial failure nobody
   *     acts on.
   *   - The only object that now exists is a sealed envelope the model
   *     confirmed, written by the Edge Function under `sealed/{uid}/`. That one
   *     has to SURVIVE the sitting: it is the evidence behind the flag the
   *     student is about to go and read on their dashboard. Deleting it on exit
   *     would mean the "see if you were flagged" screen reports a finding whose
   *     evidence we destroyed on the way there. It is unreadable to the browser
   *     in any case — the privacy claim is now carried by the encryption rather
   *     than by the delete.
   *
   * The extension is still told to stop FIRST, which is unchanged and still
   * matters: it is what releases the camera.
   */
  const stopGuestQuiz = useCallback(async () => {
    // Invalidate any start still awaiting its anonymous sign-in, BEFORE posting
    // stop. Otherwise that start resolves afterwards and re-arms the extension
    // against a page that is already gone.
    startTokenRef.current++;

    if (sittingIdRef.current) {
      capture(EVENTS.SESSION_STOPPED, {
        sitting_id: sittingIdRef.current,
        sitting_mode: modeRef.current,
      });
    }

    window.postMessage({ type: 'SAFETEST_STOP_GUEST_QUIZ' }, '*');

    sessionIdRef.current = null;
    setGuestSessionId(null);
    setExtensionViolations([]);

    // ⚠ THE SITTING ID DIES WITH THE SITTING. Carrying it into the next start
    // would hand sitting two the review budget sitting one already spent —
    // which is the exact defect that keying it on `auth.uid()` produced, just
    // scoped to one document instead of to an account. The handshake record is
    // deliberately NOT cleared here: it is a claim about how this DOCUMENT
    // opened, it is still true after a stop, and `guest_bridge.js` clears its
    // own copy on STOP so a second sitting cannot inherit the extension-side
    // half of the pass.
    sittingIdRef.current = null;
    setSittingId(null);
  }, []);

  return {
    extensionDetected,
    guestSessionId,
    extensionViolations,
    liveStatus,
    visionStatus,
    visionReason,
    blockedReason,
    startGuestQuiz,
    stopGuestQuiz,
    /**
     * The timing verdict for this document: `{status, reason, onTime, latencyMs}`,
     * or null while the exchange is still in flight.
     *
     * ⚠ NOT A VIOLATION, AND NOTHING MAY RENDER IT TO THE CANDIDATE DURING A
     * SITTING. `LATE_PROCTOR_ATTACH` is telemetry about the RECORD — how much
     * of the sitting was observed — not an accusation about the person. It is
     * not in the §6 taxonomy and never reaches `reportViolation`.
     */
    handshake,
    /** This sitting's id, or null between sittings. See mintSittingId(). */
    sittingId,
    /** Non-null when the extension refused to arm. */
    startRefusedReason,
  };
}
