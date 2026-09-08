// =============================================================================
// src/lib/ai/snapshotReview.js
//
// The page's half of the flagged-frame review: hand one JPEG to the
// `analyze-snapshot` Edge Function and remember how much of the budget is left.
//
// ⚠ THE BUDGET HERE IS A COURTESY, NOT A CONTROL. The Edge Function counts
// reviewed rows in the database and refuses on its own authority; this counter
// exists only so an in-budget page stops sending once it knows there is no
// point, saving a round trip and a webcam frame's worth of upload. Anyone
// editing this file in devtools gets nothing — they hit the same server wall.
//
// ⚠ NOTHING THIS MODULE RETURNS MAY BE SHOWN TO THE CANDIDATE DURING THE SITTING.
// The verdict is deliberately not rendered in the exam UI (see DemoQuizPage and
// the demo EvidencePanel): a student who can watch the model's confidence climb
// is a student being taught, live, which behaviours evade it. The verdict
// surfaces afterwards, on the dashboard.
// =============================================================================

import { supabase, isSupabaseConfigured } from '../supabase.js'

export const REVIEW_REASON = Object.freeze({
  SUPABASE_UNCONFIGURED: 'SUPABASE_UNCONFIGURED',
  NOT_SIGNED_IN: 'NOT_SIGNED_IN',
  NO_IMAGE: 'NO_IMAGE',
  /** The local budget says there is nothing left to spend this sitting. */
  BUDGET_CLOSED: 'BUDGET_CLOSED',
  /** The function is deployed but has no GEMINI_API_KEY. */
  NOT_CONFIGURED: 'GEMINI_NOT_CONFIGURED',
  CALL_FAILED: 'CALL_FAILED',
})

/** Mirrors MAX_SNAPSHOTS_PER_SITTING in the Edge Function. */
export const MAX_REVIEWS_PER_SITTING = 3

/**
 * Per-sitting budget, held by the caller so it dies with the sitting.
 *
 * A module-level counter would survive a re-entry into /demo-quiz and hand the
 * second sitting a budget already spent by the first, which reads as "the AI
 * review stopped working" with nothing in any log to explain it.
 */
export function createReviewBudget() {
  return { used: 0, closed: false, lastReason: null }
}

/**
 * Send one flagged frame for review.
 *
 * @param {object} params
 * @param {ReturnType<typeof createReviewBudget>} params.budget
 * @param {string} params.demoSessionId
 * @param {string} params.violationType
 * @param {string | null} params.severity
 * @param {string} params.imageBase64 data: URL or bare base64.
 * @returns {Promise<{ ok: boolean, reviewed: boolean, reason: string | null,
 *   verdict: string | null, confidence: number | null, observation: string | null }>}
 */
export async function reviewFlaggedSnapshot({
  budget,
  demoSessionId,
  violationType,
  severity,
  imageBase64,
} = {}) {
  const empty = { reviewed: false, verdict: null, confidence: null, observation: null }

  if (!isSupabaseConfigured || !supabase) {
    return { ok: false, reason: REVIEW_REASON.SUPABASE_UNCONFIGURED, ...empty }
  }
  if (!imageBase64) return { ok: false, reason: REVIEW_REASON.NO_IMAGE, ...empty }
  if (!demoSessionId) return { ok: false, reason: REVIEW_REASON.NOT_SIGNED_IN, ...empty }
  if (budget?.closed || (budget?.used ?? 0) >= MAX_REVIEWS_PER_SITTING) {
    return { ok: true, reason: REVIEW_REASON.BUDGET_CLOSED, ...empty }
  }

  let response
  try {
    // `functions.invoke` attaches the caller's own access token, which is what
    // the function resolves the student id from. Never pass an id in the body.
    response = await supabase.functions.invoke('analyze-snapshot', {
      body: { demoSessionId, violationType, severity, imageBase64 },
    })
  } catch (error) {
    if (budget) budget.lastReason = REVIEW_REASON.CALL_FAILED
    return { ok: false, reason: REVIEW_REASON.CALL_FAILED, error, ...empty }
  }

  if (response.error || !response.data) {
    if (budget) budget.lastReason = REVIEW_REASON.CALL_FAILED
    return { ok: false, reason: REVIEW_REASON.CALL_FAILED, error: response.error, ...empty }
  }

  const data = response.data

  // ⚠ THE SERVER'S COUNT WINS. Adopting `data.used` rather than incrementing
  // locally keeps the two in step when a request is retried, races another tab,
  // or is refused for a reason this page did not anticipate — the failure mode
  // of a local `used += 1` is a page that believes it has budget the server has
  // already spent, and then uploads frames that are always refused.
  if (budget) {
    if (typeof data.used === 'number') budget.used = data.used
    if (data.budgetClosed === true) budget.closed = true
    budget.lastReason = data.reason ?? null
  }

  if (data.ok === false) {
    return { ok: false, reason: data.reason ?? REVIEW_REASON.CALL_FAILED, ...empty }
  }

  return {
    ok: true,
    reviewed: data.reviewed === true,
    reason: data.reason ?? null,
    verdict: data.verdict ?? null,
    confidence: typeof data.confidence === 'number' ? data.confidence : null,
    observation: data.observation ?? null,
  }
}
