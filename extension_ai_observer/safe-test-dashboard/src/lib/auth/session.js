// =============================================================================
// src/lib/auth/session.js
//
// ONE definition of "this visitor is signed in enough to run the live demo",
// mirroring public.session_is_verified_human() from
// supabase/migrations/20260810120000_verified_session_gate.sql claim for claim.
//
// ⚠ THIS IS A MIRROR, NOT THE ENFORCEMENT. The database decides; this decides
// what to RENDER. Both directions of that matter:
//
//   - Never loosen this to show a demo the server will then refuse — the
//     visitor gets a camera, a proctoring session and an evidence panel whose
//     every upload 403s, which is precisely the invisible-failure mode
//     guest_bridge.js's upload path was rewritten to stop producing.
//   - Never treat a pass here as authority. Nothing in this file is trusted by
//     anything; a determined visitor can edit it in devtools and reach exactly
//     the same wall one layer down.
//
// If the SQL predicate changes, change this in the same commit. The test suite
// (session.test.js) pins the method list against the list in the migration.
// =============================================================================

import { base64UrlDecode } from '../supabase.js'

/**
 * AMR (Authentication Methods Reference) methods that prove control of a real
 * mailbox — the same set, in the same order, as the `in (...)` list in
 * session_is_verified_human().
 *
 * ⚠ `password` IS ABSENT ON PURPOSE. A password proves knowledge of a secret,
 * not access to the inbox it was registered against, and it is the one method a
 * credential dump hands an attacker wholesale. It is the reason the emailed
 * code exists at all: a password sign-in produces a session that is real,
 * usable for changing your own account, and NOT sufficient for the demo.
 *
 * ⚠ `anonymous` IS ABSENT ON PURPOSE. That is the guest problem itself.
 */
export const VERIFIED_AMR_METHODS = Object.freeze([
  'otp',
  'magiclink',
  'oauth',
  'sso/saml',
  'totp',
])

/** Any `mfa/<factor>` method also counts — matches the SQL `like 'mfa/%'`. */
const MFA_METHOD_PREFIX = 'mfa/'

export const SESSION_STATE = Object.freeze({
  /** No session at all. */
  SIGNED_OUT: 'SIGNED_OUT',
  /** A Supabase anonymous session — a guest holding a token. */
  ANONYMOUS: 'ANONYMOUS',
  /** Password accepted, emailed code still outstanding. */
  AWAITING_EMAIL_CODE: 'AWAITING_EMAIL_CODE',
  /** Google, or password + emailed code. The only state the demo opens for. */
  VERIFIED: 'VERIFIED',
})

/**
 * Decode a JWT payload without verifying it.
 *
 * ⚠ UNVERIFIED, AND THAT IS FINE HERE FOR EXACTLY ONE REASON: the token was
 * handed to us by our own Supabase client, out of our own storage, and every
 * conclusion drawn from it is re-checked server-side by RLS before anything
 * happens. Do not lift this helper into a code path that grants something.
 *
 * @param {string | null | undefined} jwt
 * @returns {Record<string, unknown> | null} null on anything malformed.
 */
export function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') return null
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]))
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

/**
 * The AMR methods on a session's access token, lowercased.
 * @param {{ access_token?: string } | null | undefined} session
 * @returns {string[]} empty when absent or unreadable — never null, so callers
 *   can `.some()` without a guard.
 */
export function sessionAmrMethods(session) {
  const payload = decodeJwtPayload(session?.access_token)
  const amr = payload?.amr
  if (!Array.isArray(amr)) return []
  return amr
    .map((entry) => {
      if (typeof entry === 'string') return entry
      const method = entry?.method
      return typeof method === 'string' ? method : null
    })
    .filter((method) => typeof method === 'string' && method.length > 0)
    .map((method) => method.toLowerCase())
}

/**
 * @param {{ access_token?: string, user?: { is_anonymous?: boolean } } | null | undefined} session
 * @returns {boolean}
 */
export function isAnonymousSession(session) {
  if (!session) return false
  // Two sources, because they can disagree in a way that matters.
  // `user.is_anonymous` is what supabase-js exposes on the JS object; the
  // `is_anonymous` JWT claim is what RLS actually reads. A session where EITHER
  // says anonymous is treated as anonymous — the strictest reading, matching
  // the direction the SQL fails in.
  if (session.user?.is_anonymous === true) return true
  const payload = decodeJwtPayload(session.access_token)
  return payload?.is_anonymous === true
}

/**
 * The single predicate. True only for Google/OAuth or password+emailed-code.
 *
 * ⚠ FAILS CLOSED, unlike almost every other gate in this codebase. The vision
 * safeguards fail OPEN because over-suppressing there produces an unproctored
 * exam — silence is the dangerous answer there. Here the dangerous answer is
 * access: an unreadable token, a missing claim or a malformed JWT all mean "we
 * cannot establish who this is", and the only safe response to that at a
 * sign-in wall is to refuse. The server's copy fails closed for the same
 * reason, so the two cannot disagree.
 *
 * @param {object | null | undefined} session A supabase-js Session.
 * @returns {boolean}
 */
export function isVerifiedSession(session) {
  if (!session?.access_token) return false
  if (isAnonymousSession(session)) return false
  const methods = sessionAmrMethods(session)
  return methods.some(
    (method) => VERIFIED_AMR_METHODS.includes(method) || method.startsWith(MFA_METHOD_PREFIX),
  )
}

/**
 * Which of the four states a session is in. Distinct from `isVerifiedSession`
 * because the UI has to say three different things about "not verified":
 * "sign in", "you are a guest — sign in properly", and "check your email for
 * the code" are not interchangeable messages.
 *
 * @param {object | null | undefined} session
 * @returns {typeof SESSION_STATE[keyof typeof SESSION_STATE]}
 */
export function sessionState(session) {
  if (!session?.access_token) return SESSION_STATE.SIGNED_OUT
  if (isAnonymousSession(session)) return SESSION_STATE.ANONYMOUS
  if (isVerifiedSession(session)) return SESSION_STATE.VERIFIED
  return SESSION_STATE.AWAITING_EMAIL_CODE
}

/**
 * The address the emailed code should go to, read off the half-finished
 * session so the visitor never has to retype it.
 * @param {object | null | undefined} session
 * @returns {string | null}
 */
export function sessionEmail(session) {
  const fromUser = session?.user?.email
  if (typeof fromUser === 'string' && fromUser) return fromUser
  const payload = decodeJwtPayload(session?.access_token)
  const fromClaim = payload?.email
  return typeof fromClaim === 'string' && fromClaim ? fromClaim : null
}
