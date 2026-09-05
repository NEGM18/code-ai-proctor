// =============================================================================
// src/lib/telemetry/pipeline.js
//
// Observability for the Gemini review and the edge/crypto round trips.
//
// ⚠ EVERYTHING HERE MEASURES THE PIPELINE, NOT THE CANDIDATE. The events below
// answer "is the detector's hypothesis surviving review", "how long does a seal
// take", "how often does the budget close early". None of them is a finding
// about a person, and none may be fed back into a detector — a detector that
// tuned itself on aggregate review outcomes would be learning from a signal the
// candidate can influence, which is the feedback loop CLAUDE.md §5 forbids,
// arriving from the other direction.
// =============================================================================

import { capture } from './posthog.js';
import { EVENTS } from './events.js';
import { hashId } from './redact.js';
import { captureProctorError, PIPELINE_STEP } from './errors.js';

/**
 * ⚠ MIRRORED FROM `supabase/functions/analyze-snapshot/index.ts` AND NOT THE
 * AUTHORITY. The server owns this rule and enforces it on its own; this copy
 * exists only so the client can LABEL an event as an early stop without a second
 * round trip. If the two drift, the server is right and this is a mislabelled
 * chart — so keep them in step, and never let this value decide anything.
 */
const STOP_CONFIDENCE = 95;
/** Mirrored from MAX_SNAPSHOTS_PER_SITTING, same caveat. */
const MAX_REVIEWS_PER_SITTING = 3;

/**
 * A monotonic clock reading.
 *
 * ⚠ `performance.now()`, NEVER `Date.now()`, FOR DURATIONS. The wall clock can
 * step — NTP correction, a laptop waking from sleep mid-exam, a user changing
 * the timezone — and a step of a few hundred milliseconds inside a round trip
 * produces a negative or absurd latency that silently poisons every percentile
 * built on it. `performance.now()` cannot go backwards.
 */
function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/**
 * How the model's verdict related to the detector's hypothesis.
 *
 * ⚠ A MEASUREMENT OF THE PIPELINE, NOT A VERDICT ABOUT A STUDENT, and the
 * distinction is not pedantic: `REFUTED` means "the detector fired and Gemini
 * disagreed", which is a signal about DETECTOR QUALITY. Reading it as "this
 * student was cleared" would be wrong in both directions — the review is capped
 * at 3 frames per sitting, so most violations are never reviewed at all, and
 * `ai_verdict IS NULL` means never-reviewed rather than exonerated (CLAUDE.md
 * 2026-08-16 ⚠4).
 */
export const AGREEMENT = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  REFUTED: 'REFUTED',
  INCONCLUSIVE: 'INCONCLUSIVE',
  UNREVIEWED: 'UNREVIEWED',
});

function agreementFor(verdict, reviewed) {
  if (!reviewed || !verdict) return AGREEMENT.UNREVIEWED;
  if (verdict === 'CHEATING') return AGREEMENT.CONFIRMED;
  if (verdict === 'NOT_CHEATING') return AGREEMENT.REFUTED;
  return AGREEMENT.INCONCLUSIVE;
}

// ---------------------------------------------------------------------------
// The Gemini review
// ---------------------------------------------------------------------------

/**
 * Begin timing one `analyze-snapshot` round trip.
 *
 * @param {object} params
 * @param {string} params.violationType The DETECTOR's hypothesis (PHONE_DETECTED, …).
 * @param {string|null} [params.severity]
 * @param {string|null} [params.sittingId] Hashed before it is sent.
 * @param {'DEMO'|'CLASSROOM'} [params.sittingMode]
 * @param {number} [params.imageLength] Bytes of the frame — the LENGTH only.
 * @returns {{settle: (result: object) => void}}
 */
export function trackAiReview(params = {}) {
  const startedAt = nowMs();
  let settled = false;

  return {
    /** @param {object} result The object `reviewFlaggedSnapshot` returned. */
    settle(result = {}) {
      // ⚠ ONE LOGICAL REVIEW MUST PRODUCE ONE EVENT. A retry wrapper or a
      // double-await would otherwise emit twice and double every count built on
      // this — invisible in the data, because the numbers simply read high.
      if (settled) return;
      settled = true;

      try {
        const latency = Math.round(nowMs() - startedAt);
        const verdict = result.verdict ?? null;
        const confidence = typeof result.confidence === 'number' ? result.confidence : null;
        const reviewed = result.reviewed === true;

        const earlyStop = verdict === 'CHEATING'
          && typeof confidence === 'number'
          && confidence >= STOP_CONFIDENCE;

        const hashedSitting = params.sittingId ? hashId(params.sittingId) : null;

        capture(EVENTS.AI_REVIEW_SETTLED, {
          // The detector's hypothesis, which is what makes the verdict meaningful.
          violation_type: params.violationType ?? null,
          severity: params.severity ?? null,

          reviewed,
          verdict,
          confidence,
          agreement: agreementFor(verdict, reviewed),

          latency_ms: latency,
          reason: result.reason ?? null,
          ok: result.ok === true,
          request_id: result.requestId ?? null,

          budget_used: typeof result.used === 'number' ? result.used : null,
          budget_max: MAX_REVIEWS_PER_SITTING,
          budget_closed: result.budgetClosed === true,
          early_stop_triggered: earlyStop,

          // ⚠ THE LENGTH OF THE FRAME, NEVER THE FRAME. Useful for spotting a
          // camera producing empty or enormous captures; carries no image data.
          image_length: typeof params.imageLength === 'number' ? params.imageLength : null,

          // ⚠ THE OBSERVATION SENTENCE IS NOT SENT — ONLY ITS LENGTH.
          // `observation` is Gemini's free-text description of a webcam frame
          // ("the candidate is holding a phone near their face"). That is a
          // natural-language rendering of biometric content, and it is the single
          // most likely thing for a careless implementation to ship, precisely
          // because it reads as a harmless string rather than as an image. Its
          // LENGTH still separates "the model said something" from "the model
          // returned an empty string", which is the only diagnostic value it had.
          observation_length: typeof result.observation === 'string' ? result.observation.length : 0,

          sitting_id: hashedSitting,
          sitting_mode: params.sittingMode ?? null,
        });

        if (earlyStop) {
          capture(EVENTS.EARLY_STOP_TRIGGERED, {
            violation_type: params.violationType ?? null,
            confidence,
            stop_confidence: STOP_CONFIDENCE,
            sitting_id: hashedSitting,
            sitting_mode: params.sittingMode ?? null,
          });
        }

        if (result.reason === 'BUDGET_EXHAUSTED'
          || result.reason === 'DAILY_LIMIT'
          || result.reason === 'BUDGET_CLOSED_CONFIRMED') {
          capture(EVENTS.BUDGET_CAP_EXCEEDED, {
            reason: result.reason,
            budget_used: typeof result.used === 'number' ? result.used : null,
            budget_max: MAX_REVIEWS_PER_SITTING,
            sitting_id: hashedSitting,
            sitting_mode: params.sittingMode ?? null,
          });
        }
      } catch (err) {
        captureProctorError(err, { step: PIPELINE_STEP.EDGE_RPC, interaction: 'trackAiReview.settle' });
      }
    },
  };
}

/**
 * Instrument `reviewFlaggedSnapshot` WITHOUT modifying it.
 *
 * ⚠ THE FRAME IS PASSED STRAIGHT THROUGH, UNTOUCHED AND UNREAD. This wrapper
 * measures `imageBase64.length` and nothing else — it does not hash it, log it,
 * sample it, or inspect its prefix. A decorator that "just" hashed the frame to
 * deduplicate reviews would be holding biometric material inside a telemetry
 * module, which is exactly the boundary this file exists to keep.
 *
 * ⚠ A WRAPPER RATHER THAN AN EDIT TO snapshotReview.js, so the review path keeps
 * exactly one reason to change. That file is on the evidence path and its header
 * carries rules about what may never be shown to a candidate; putting an
 * analytics import inside it would make an observability change a change to the
 * evidence path.
 *
 * @param {Function} fn `reviewFlaggedSnapshot`
 * @returns {Function} same signature, same return value.
 */
export function wrapReviewFlaggedSnapshot(fn) {
  return async function instrumentedReview(args = {}) {
    const tracker = trackAiReview({
      violationType: args.violationType,
      severity: args.severity,
      sittingId: args.demoSessionId,
      sittingMode: args.sittingMode,
      imageLength: typeof args.imageBase64 === 'string' ? args.imageBase64.length : 0,
    });

    try {
      const result = await fn(args);
      tracker.settle(result || {});
      // ⚠ Returned unchanged. A telemetry wrapper that reshapes a return value
      // is a behaviour change wearing an observability costume.
      return result;
    } catch (err) {
      tracker.settle({ ok: false, reason: 'CALL_FAILED' });
      captureProctorError(err, {
        step: PIPELINE_STEP.EDGE_RPC,
        interaction: 'reviewFlaggedSnapshot',
        sittingId: args.demoSessionId,
        sittingMode: args.sittingMode,
      });
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Edge RPC + envelope observability
// ---------------------------------------------------------------------------

/**
 * Begin timing any `supabase.functions.invoke` round trip.
 *
 * @param {object} params
 * @param {string} params.fn Function name — 'unseal-snapshot', 'analyze-snapshot'.
 * @param {string} [params.sittingId]
 * @returns {{settle: (result: object) => void}}
 */
export function trackEdgeRpc(params = {}) {
  const startedAt = nowMs();
  let settled = false;

  return {
    settle(result = {}) {
      if (settled) return;
      settled = true;
      try {
        capture(EVENTS.EDGE_RPC_SETTLED, {
          edge_function: params.fn ?? null,
          duration_ms: Math.round(nowMs() - startedAt),
          ok: result.ok === true,
          reason: result.reason ?? null,
          http_status: typeof result.status === 'number' ? result.status : null,
          sitting_id: params.sittingId ? hashId(params.sittingId) : null,
        });
      } catch (err) {
        captureProctorError(err, { step: PIPELINE_STEP.EDGE_RPC, interaction: 'trackEdgeRpc.settle' });
      }
    },
  };
}

/**
 * Record one `unseal-snapshot` outcome — the decryption half of the pipeline.
 *
 * ⚠ WHAT IS SAFE TO SEND HERE AND WHAT IS NOT, STATED EXPLICITLY, BECAUSE THE
 * ENVELOPE HEADER MIXES THEM IN ONE OBJECT AND A SPREAD WOULD TAKE ALL OF IT:
 *
 *   kid       SAFE. A key IDENTIFIER, not key material — it names WHICH public
 *             key sealed the envelope. It is already written into every envelope
 *             header in the clear, and it is the one field that makes a
 *             decryption failure diagnosable: "wrong kid" and "right kid, bad
 *             ciphertext" are different incidents with different repairs.
 *   sig_alg   SAFE. 'RSA-PSS-SHA256' or 'none'. Whether envelopes are being
 *             signed is an integrity property that must be auditable in
 *             aggregate — CLAUDE.md 2026-08-22 (c) records a deploy where every
 *             envelope silently degraded to unsigned and nothing noticed.
 *   ek        NEVER. The AES content key, wrapped to the RSA public key.
 *   iv        NEVER. The GCM nonce.
 *   sha256    NEVER. The digest of the PLAINTEXT frame — i.e. a confirmation
 *             oracle: anyone holding a candidate image could test it against
 *             this and learn whether it is the sealed one.
 *   ciphertext / plaintext   NEVER, obviously.
 *
 * `redact.js` denies ek/iv/sha256 by key name as a backstop, but this function
 * never constructs them in the first place. Both, because the backstop is not
 * the design.
 *
 * @param {object} params
 * @param {boolean} params.ok
 * @param {string|null} [params.reason] One of unseal-snapshot's reason codes.
 * @param {number} [params.status]
 * @param {string|null} [params.kid]
 * @param {string|null} [params.sigAlg]
 * @param {boolean} [params.headerParsed]
 * @param {number} [params.envelopeBytes]
 * @param {number} [params.durationMs]
 */
export function trackUnseal(params = {}) {
  try {
    capture(EVENTS.UNSEAL_SETTLED, {
      ok: params.ok === true,
      reason: params.reason ?? null,
      http_status: typeof params.status === 'number' ? params.status : null,
      kid: params.kid ?? null,
      sig_alg: params.sigAlg ?? null,
      signed: params.sigAlg ? params.sigAlg !== 'none' : null,
      header_parsed: params.headerParsed !== false,
      envelope_bytes: typeof params.envelopeBytes === 'number' ? params.envelopeBytes : null,
      duration_ms: typeof params.durationMs === 'number' ? Math.round(params.durationMs) : null,
    });
  } catch (err) {
    captureProctorError(err, { step: PIPELINE_STEP.UNSEAL_PAYLOAD, interaction: 'trackUnseal' });
  }
}

/** The mirrored constants, exported so a test can pin them against the server's. */
export const __CONSTANTS = Object.freeze({ STOP_CONFIDENCE, MAX_REVIEWS_PER_SITTING });
