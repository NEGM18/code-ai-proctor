// =============================================================================
// The client half of the flagged-frame review budget.
//
// ⚠ WHAT THESE TESTS ARE AND ARE NOT. The 3-per-sitting cap and the >= 95%
// early stop are enforced by the Edge Function against the database; nothing
// here can prove those, because they live server-side by design. What this file
// pins is the CLIENT contract around them:
//
//   - the page adopts the server's count instead of keeping its own;
//   - a closed budget stops the page uploading further webcam frames;
//   - a budget belongs to one sitting, and a new sitting starts fresh;
//   - a failure never silently reads as "reviewed and cleared".
//
// The first of those is the one worth having. A local `used += 1` would drift
// from the server on any retry or refusal, and the symptom would be a page
// cheerfully uploading frames that are always refused.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()

vi.mock('../../supabase.js', () => ({
  isSupabaseConfigured: true,
  supabase: { functions: { invoke: (...args) => invoke(...args) } },
  SUPABASE_UNCONFIGURED_REASON: 'SUPABASE_UNCONFIGURED',
  DEMO_SNAPSHOTS_BUCKET: 'demo-snapshots',
  AVATARS_BUCKET: 'avatars',
  base64UrlDecode: (s) => s,
}))

const { createReviewBudget, reviewFlaggedSnapshot, MAX_REVIEWS_PER_SITTING, REVIEW_REASON } =
  await import('../snapshotReview.js')

const CALL = {
  demoSessionId: 'sitting-1',
  violationType: 'PHONE_DETECTED',
  severity: 'CRITICAL',
  imageBase64: 'data:image/jpeg;base64,AAAA',
}

beforeEach(() => {
  invoke.mockReset()
})

describe('createReviewBudget', () => {
  it('starts empty and open', () => {
    const budget = createReviewBudget()
    expect(budget.used).toBe(0)
    expect(budget.closed).toBe(false)
  })

  it('hands a NEW sitting a fresh budget', () => {
    // ⚠ THE REASON THE BUDGET IS NOT A MODULE-LEVEL COUNTER. A shared counter
    // would survive re-entry into /demo-quiz and give the second sitting a
    // budget the first had already spent, which presents as "the AI review
    // stopped working" with nothing in any log to explain it.
    const first = createReviewBudget()
    first.used = MAX_REVIEWS_PER_SITTING
    first.closed = true
    const second = createReviewBudget()
    expect(second.used).toBe(0)
    expect(second.closed).toBe(false)
  })
})

describe('reviewFlaggedSnapshot', () => {
  it('adopts the SERVER count rather than incrementing locally', async () => {
    // The server says 3 even though this is the page's first call — another tab
    // spent the budget. The page must believe the server.
    invoke.mockResolvedValue({
      data: { ok: true, reviewed: true, verdict: 'NOT_CHEATING', confidence: 20, used: 3, budgetClosed: true },
      error: null,
    })
    const budget = createReviewBudget()
    const result = await reviewFlaggedSnapshot({ budget, ...CALL })
    expect(result.ok).toBe(true)
    expect(budget.used).toBe(3)
    expect(budget.closed).toBe(true)
  })

  it('stops calling once the budget is closed', async () => {
    const budget = createReviewBudget()
    budget.closed = true
    const result = await reviewFlaggedSnapshot({ budget, ...CALL })
    expect(invoke).not.toHaveBeenCalled()
    expect(result.reason).toBe(REVIEW_REASON.BUDGET_CLOSED)
    expect(result.reviewed).toBe(false)
  })

  it('stops calling once used reaches the cap, even if closed was never set', async () => {
    const budget = createReviewBudget()
    budget.used = MAX_REVIEWS_PER_SITTING
    await reviewFlaggedSnapshot({ budget, ...CALL })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('closes the budget on a >= 95% confirmation reported by the server', async () => {
    // The "stop taking snapshots" rule, as observed by the client. The decision
    // is the server's; this asserts the page honours it.
    invoke.mockResolvedValue({
      data: { ok: true, reviewed: true, verdict: 'CHEATING', confidence: 97, used: 1, budgetClosed: true },
      error: null,
    })
    const budget = createReviewBudget()
    const result = await reviewFlaggedSnapshot({ budget, ...CALL })
    expect(result.verdict).toBe('CHEATING')
    expect(budget.closed).toBe(true)
    expect(budget.used).toBe(1)
  })

  it('never sends a user id in the body — identity comes from the token', async () => {
    // ⚠ A `studentId` field here would let any signed-in account file evidence
    // against any other. The function resolves the caller from the bearer token
    // and ignores the body; this keeps the client honest about that contract.
    invoke.mockResolvedValue({ data: { ok: true, reviewed: true, used: 1 }, error: null })
    await reviewFlaggedSnapshot({ budget: createReviewBudget(), ...CALL })
    const [, options] = invoke.mock.calls[0]
    expect(Object.keys(options.body).sort()).toEqual(
      ['demoSessionId', 'imageBase64', 'severity', 'violationType'],
    )
  })

  it('reports a transport failure as CALL_FAILED, never as a clean review', async () => {
    invoke.mockResolvedValue({ data: null, error: new Error('network') })
    const result = await reviewFlaggedSnapshot({ budget: createReviewBudget(), ...CALL })
    expect(result.ok).toBe(false)
    expect(result.reviewed).toBe(false)
    expect(result.verdict).toBeNull()
    expect(result.reason).toBe(REVIEW_REASON.CALL_FAILED)
  })

  it('surfaces GEMINI_NOT_CONFIGURED distinctly from a clean frame', async () => {
    // "The review pipeline is off" and "nothing was found" must never be the
    // same value, or a broken deployment renders as a compliant session.
    invoke.mockResolvedValue({ data: { ok: false, reason: 'GEMINI_NOT_CONFIGURED' }, error: null })
    const result = await reviewFlaggedSnapshot({ budget: createReviewBudget(), ...CALL })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('GEMINI_NOT_CONFIGURED')
  })

  it('refuses to call with no image or no sitting id', async () => {
    const budget = createReviewBudget()
    expect((await reviewFlaggedSnapshot({ budget, ...CALL, imageBase64: '' })).reason)
      .toBe(REVIEW_REASON.NO_IMAGE)
    expect((await reviewFlaggedSnapshot({ budget, ...CALL, demoSessionId: '' })).reason)
      .toBe(REVIEW_REASON.NOT_SIGNED_IN)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not throw when invoke itself rejects', async () => {
    invoke.mockRejectedValue(new Error('boom'))
    const result = await reviewFlaggedSnapshot({ budget: createReviewBudget(), ...CALL })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(REVIEW_REASON.CALL_FAILED)
  })
})
