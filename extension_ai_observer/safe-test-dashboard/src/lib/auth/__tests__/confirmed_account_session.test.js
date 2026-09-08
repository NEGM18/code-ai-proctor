// =============================================================================
// The 2026-08-16 change to isVerifiedSession: a password session on a CONFIRMED
// account is verified, so the emailed code is a sign-up step rather than a
// sign-in step.
//
// ⚠ THESE TESTS PIN A DELIBERATE WEAKENING, AND THEY SAY SO. A future reader
// finding "password alone passes" should be able to see that it is intended and
// where the reasoning lives, rather than assuming a regression and 'fixing' it.
// The mirrored SQL is branch (c) of session_is_verified_human() in
// supabase/migrations/20260816120000_ai_review_and_sealed_evidence.sql.
//
// The existing session.test.js still pins VERIFIED_AMR_METHODS against the SQL
// list; this file covers only the new branch and what it must NOT admit.
// =============================================================================

import { describe, it, expect } from 'vitest'

import {
  accountEmailConfirmed,
  isVerifiedSession,
  sessionState,
  SESSION_STATE,
} from '../session.js'

/** Build an unsigned JWT with the given payload. The signature is never checked. */
function jwt(payload) {
  // `btoa`, not Buffer — the same helper session.test.js uses. Buffer is a Node
  // global that ESLint's browser config does not declare, and these payloads
  // are ASCII JSON so the two are equivalent here.
  const b64 = (obj) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`
}

const passwordToken = jwt({ amr: [{ method: 'password' }], is_anonymous: false })
const passwordTokenVerifiedClaim = jwt({
  amr: [{ method: 'password' }],
  is_anonymous: false,
  user_metadata: { email_verified: true },
})
const anonToken = jwt({ amr: [{ method: 'anonymous' }], is_anonymous: true })

describe('accountEmailConfirmed', () => {
  it('reads email_confirmed_at off the hydrated user object', () => {
    expect(
      accountEmailConfirmed({
        access_token: passwordToken,
        user: { email_confirmed_at: '2026-08-01T10:00:00Z' },
      }),
    ).toBe(true)
  })

  it('accepts the older confirmed_at field', () => {
    expect(
      accountEmailConfirmed({
        access_token: passwordToken,
        user: { confirmed_at: '2026-08-01T10:00:00Z' },
      }),
    ).toBe(true)
  })

  it('falls back to the user_metadata.email_verified JWT claim', () => {
    // The token-only path: callers holding an access_token but no hydrated user
    // object still have to reach the right answer, or a page refresh would
    // silently demote a signed-in user back to "awaiting code".
    expect(accountEmailConfirmed({ access_token: passwordTokenVerifiedClaim })).toBe(true)
  })

  it('is false for an unconfirmed account', () => {
    expect(accountEmailConfirmed({ access_token: passwordToken, user: {} })).toBe(false)
  })

  it('is false for null, undefined and a bare object', () => {
    expect(accountEmailConfirmed(null)).toBe(false)
    expect(accountEmailConfirmed(undefined)).toBe(false)
    expect(accountEmailConfirmed({})).toBe(false)
  })

  it('does not treat a FALSE email_verified claim as confirmation', () => {
    const token = jwt({ amr: [{ method: 'password' }], user_metadata: { email_verified: false } })
    expect(accountEmailConfirmed({ access_token: token })).toBe(false)
  })
})

describe('isVerifiedSession — the confirmed-account branch', () => {
  it('accepts a password session once the account is confirmed', () => {
    // THE POINT OF THE WHOLE CHANGE. Before 2026-08-16 this was false and the
    // visitor was sent to the 6-digit code on every sign-in.
    expect(
      isVerifiedSession({
        access_token: passwordToken,
        user: { email_confirmed_at: '2026-08-01T10:00:00Z' },
      }),
    ).toBe(true)
  })

  it('still refuses a password session on an UNCONFIRMED account', () => {
    // Sign-up verification is retained: an address nobody controls must not
    // become a usable account by way of this branch.
    expect(isVerifiedSession({ access_token: passwordToken, user: {} })).toBe(false)
  })

  it('still refuses an anonymous session even when it claims a confirmed email', () => {
    // ⚠ THE ANONYMOUS CHECK MUST RUN FIRST. If the new branch were evaluated
    // before it, a forged `email_verified` claim on an anonymous token would
    // reopen the guest hole this predicate was written to close.
    expect(
      isVerifiedSession({
        access_token: anonToken,
        user: { email_confirmed_at: '2026-08-01T10:00:00Z', is_anonymous: true },
      }),
    ).toBe(false)
  })

  it('refuses a session with no access token at all', () => {
    expect(isVerifiedSession({ user: { email_confirmed_at: '2026-08-01T10:00:00Z' } })).toBe(false)
    expect(isVerifiedSession(null)).toBe(false)
  })
})

describe('sessionState after the change', () => {
  it('reports VERIFIED for a confirmed password session', () => {
    expect(
      sessionState({
        access_token: passwordToken,
        user: { email_confirmed_at: '2026-08-01T10:00:00Z' },
      }),
    ).toBe(SESSION_STATE.VERIFIED)
  })

  it('still reports AWAITING_EMAIL_CODE mid sign-up', () => {
    // The state has NOT become unreachable — it is now exactly the sign-up
    // window, which is what AuthModal's code step is for.
    expect(sessionState({ access_token: passwordToken, user: {} })).toBe(
      SESSION_STATE.AWAITING_EMAIL_CODE,
    )
  })

  it('still reports ANONYMOUS for a guest token', () => {
    expect(sessionState({ access_token: anonToken })).toBe(SESSION_STATE.ANONYMOUS)
  })
})
