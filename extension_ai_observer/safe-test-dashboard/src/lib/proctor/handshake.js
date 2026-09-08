// =============================================================================
// src/lib/proctor/handshake.js
//
// The page's half of the "on-time proctoring proof": a nonce exchange with the
// extension, run at the moment the exam mounts, whose outcome is a timing
// verdict recorded in session telemetry.
//
// THE THREAT. A candidate loads the exam page, sets up whatever help they want
// while nothing is watching, and only then activates the proctor. Every gate in
// this codebase measures behaviour *during* a sitting; none of them can see the
// minutes before the camera opened. This module makes that interval visible.
//
// ⚠ WHAT THIS PROVES, AND WHAT IT DOES NOT. Stated first, because the word
// "cryptographic" invites a much larger reading than the mechanism supports.
//
//   PROVES  that a live extension, in this document, answered a value it could
//           not have precomputed, within a deadline, before the candidate had
//           touched anything. That is a LIVENESS AND TIMING proof, and it is
//           what the threat above is actually about.
//   DOES NOT PROVE  authenticity against a hostile PAGE. A content script and a
//           page share one `window`; anything the page can receive, the page can
//           also fabricate by posting to itself. A candidate running devtools on
//           their own browser can forge a PASS.
//
// That asymmetry is why the verdict is not treated as evidence of misconduct.
// `LATE_PROCTOR_ATTACH` is *telemetry about the sitting*, not a violation: it is
// not in the §6 taxonomy, it never reaches `reportViolation`, and it carries no
// severity. It tells a reviewer "this sitting was not observed from the start",
// which is a fact about the RECORD rather than an accusation about the person —
// the same distinction the lighting advisory draws.
//
// ⚠ THE EXTENSION'S CLOCK IS THE AUTHORITY, NOT THIS FILE'S. Everything the page
// measures is an input the extension may overrule; `guest_bridge.js` stamps its
// own receive time and grades from that. This module is kept as the single
// readable statement of the RULES so they can be tested, and
// `handshake_contract.test.js` pins it against the extension's copy — the same
// arrangement `session.js` has with the SQL predicate. Change one and the test
// fails; change neither and they cannot drift.
// =============================================================================

/**
 * Timing verdicts. These strings reach `proctor_sessions.timing_status`, so they
 * are a database vocabulary, not display copy.
 *
 * ⚠ `ON_TIME_BEFORE_QUIZ` and `LATE_PROCTORING_STARTED` are the pre-existing LMS
 * values and are deliberately still listed. `calculateTimingCompliance()` emits
 * them for a real LMS page where the quiz was detected before proctoring began,
 * and a CHECK constraint that stopped accepting them would reject writes from
 * every already-deployed copy of the extension.
 */
export const TIMING_STATUS = Object.freeze({
  /** The handshake completed on the exam's first paint, before any input. */
  ON_TIME_AT_QUIZ: 'ON_TIME_AT_QUIZ',
  /** It did not — late, slow, absent, or after the candidate had interacted. */
  LATE_PROCTOR_ATTACH: 'LATE_PROCTOR_ATTACH',
  /** Legacy LMS flow: proctoring was already running when the quiz opened. */
  ON_TIME_BEFORE_QUIZ: 'ON_TIME_BEFORE_QUIZ',
  /** Legacy LMS flow: proctoring started > 60 s after the quiz page opened. */
  LATE_PROCTORING_STARTED: 'LATE_PROCTORING_STARTED',
})

/**
 * Why a handshake was graded late.
 *
 * Carried beside the verdict because "no extension installed" and "the
 * candidate stalled the attach" produce the SAME verdict and are completely
 * different situations. A reviewer looking at a flagged sitting has to be able
 * to tell them apart, and a bare `LATE_PROCTOR_ATTACH` cannot.
 */
export const HANDSHAKE_REASON = Object.freeze({
  OK: 'OK',
  /** Nothing answered within the deadline. Usually: no extension installed. */
  NO_REPLY: 'NO_REPLY',
  /** Answered, but past the deadline. */
  SLOW_REPLY: 'SLOW_REPLY',
  /** Answered with the wrong nonce — a stale or replayed reply. */
  NONCE_MISMATCH: 'NONCE_MISMATCH',
  /** Answered in time, but the candidate had already interacted. */
  INTERACTION_FIRST: 'INTERACTION_FIRST',
  /** Landed directly on the exam, and the exchange finished far too late. */
  LATE_MOUNT: 'LATE_MOUNT',
})

/**
 * The reply deadline: "signs/echoes this nonce back within < 500ms".
 *
 * ⚠ THIS IS A ROUND TRIP, AND THE MV3 SERVICE WORKER IS THE RISK IN IT. An
 * evicted worker is cold-started by the first message sent to it, and a cold
 * start on a loaded machine can cost well over 500 ms — which would grade an
 * honest candidate on a slow laptop exactly like one who stalled the attach.
 * `guest_bridge.js` therefore answers the page from the CONTENT SCRIPT, which is
 * already resident in this document, and asks the worker for its attestation in
 * PARALLEL rather than in series. Do not "simplify" that back into a chain: it
 * would put a cold start on the critical path of a timing verdict.
 */
export const HANDSHAKE_DEADLINE_MS = 500

/**
 * How long after a genuine page load the exchange may still count as "at quiz".
 * Applied ONLY when the exam was this document's landing route.
 *
 * ⚠ THE IN-APP-NAVIGATION EXEMPTION IS REQUIRED, NOT GENEROUS. This is a
 * single-page app: reading the marketing site for ten minutes and then opening
 * the exam is ONE document whose `timeOrigin` is ten minutes old. A nav-start
 * window applied there would grade ordinary browsing as a late attach. What the
 * window is actually for is the deep-link / reload case, where `timeOrigin`
 * really is the exam's own load.
 */
export const LANDING_GRACE_MS = 10000

/** Message the page posts to ask for a handshake. */
export const HANDSHAKE_REQUEST = 'SAFETEST_PROCTOR_HANDSHAKE'
/** Message the extension posts back. */
export const HANDSHAKE_REPLY = 'SAFETEST_PROCTOR_HANDSHAKE_ACK'

/**
 * Grade one handshake attempt.
 *
 * Pure: no clocks, no DOM, no randomness. Everything it needs is an argument,
 * which is what makes the rule testable rather than merely reviewed.
 *
 * ⚠ EVERY BRANCH FAILS TOWARD `LATE_PROCTOR_ATTACH`, WHICH IS THE OPPOSITE
 * DIRECTION FROM THE REST OF THIS CODEBASE — deliberately. The detectors fail
 * OPEN (an unreadable observation is never an accusation) because their output
 * accuses a person. This does not accuse anyone; it describes how much of the
 * sitting was covered. "We could not confirm the proctor was attached from the
 * start" is the honest reading of a missing handshake, and defaulting it to
 * ON_TIME would assert an observation nobody made.
 *
 * @param {object} obs Observations. Absent / NaN numbers are treated as failures.
 * @param {boolean} obs.replied       Did anything answer at all?
 * @param {string}  obs.nonce         The nonce we sent.
 * @param {string|null} obs.nonceEcho The nonce the reply carried.
 * @param {number}  obs.latencyMs     Request -> reply, measured by the caller.
 * @param {boolean} obs.interactedBeforeReply Any pointer/key input in between?
 * @param {boolean} obs.landedOnQuiz  Was the exam this document's landing route?
 * @param {number}  obs.sinceNavigationStartMs `timeOrigin` -> reply.
 * @param {number}  [obs.deadlineMs]     Override, for tests.
 * @param {number}  [obs.landingGraceMs] Override, for tests.
 * @returns {{status: string, reason: string, onTime: boolean, latencyMs: number|null}}
 */
export function evaluateHandshake(obs = {}) {
  const {
    replied = false,
    nonce = '',
    nonceEcho = null,
    latencyMs = Number.NaN,
    interactedBeforeReply = false,
    landedOnQuiz = false,
    sinceNavigationStartMs = Number.NaN,
    deadlineMs = HANDSHAKE_DEADLINE_MS,
    landingGraceMs = LANDING_GRACE_MS,
  } = obs

  const measuredLatency = Number.isFinite(latencyMs) ? latencyMs : null

  const late = (reason) => ({
    status: TIMING_STATUS.LATE_PROCTOR_ATTACH,
    reason,
    onTime: false,
    latencyMs: measuredLatency,
  })

  // Ordered most-specific first. NO_REPLY is tested before anything else
  // because with no reply every other field is meaningless — grading a missing
  // extension as SLOW_REPLY would send a reader hunting a performance problem
  // that does not exist.
  if (!replied) return late(HANDSHAKE_REASON.NO_REPLY)

  // ⚠ THE NONCE CHECK PRECEDES THE DEADLINE CHECK. A reply carrying the wrong
  // nonce is stale or replayed, and its latency was measured against a request
  // it is not an answer to — so reporting that number as SLOW_REPLY would be
  // reporting a meaningless quantity as a finding.
  if (!nonce || nonceEcho !== nonce) return late(HANDSHAKE_REASON.NONCE_MISMATCH)

  if (measuredLatency === null || measuredLatency > deadlineMs) {
    return late(HANDSHAKE_REASON.SLOW_REPLY)
  }

  // "triggered after page interaction", from the directive. A candidate who
  // clicked or typed before the proctor answered was, for that interval,
  // working unobserved.
  if (interactedBeforeReply) return late(HANDSHAKE_REASON.INTERACTION_FIRST)

  if (landedOnQuiz) {
    if (!Number.isFinite(sinceNavigationStartMs) || sinceNavigationStartMs > landingGraceMs) {
      return late(HANDSHAKE_REASON.LATE_MOUNT)
    }
  }

  return {
    status: TIMING_STATUS.ON_TIME_AT_QUIZ,
    reason: HANDSHAKE_REASON.OK,
    onTime: true,
    latencyMs: measuredLatency,
  }
}

/**
 * Mint a request payload.
 *
 * ⚠ THE FALLBACK IS NOT CRYPTOGRAPHICALLY STRONG AND SAYS SO. This value's job
 * is to be unpredictable to a *precomputed* reply; an environment with no
 * WebCrypto is one where the exchange was already only a liveness check, and
 * throwing there would disable the handshake entirely rather than weaken it.
 * `strongNonce` travels with the request so telemetry can tell the two apart.
 *
 * @param {number} [now] Injected clock, for tests.
 */
export function createHandshakeRequest(now = Date.now()) {
  const strong = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  const nonce = strong
    ? crypto.randomUUID()
    : `nc-${now.toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  return { type: HANDSHAKE_REQUEST, nonce, timestamp: now, strongNonce: strong }
}
