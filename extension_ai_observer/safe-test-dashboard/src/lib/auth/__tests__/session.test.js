// =============================================================================
// session.test.js — the demo's admission rule.
//
// These assertions are the client-side half of a contract whose other half is
// SQL: `public.session_is_verified_human()` in
// supabase/migrations/20260810120000_verified_session_gate.sql. Wherever a test
// below names a claim or a method string, the same string appears in that
// function, and the two must be changed together. Drift between them does not
// fail loudly at runtime — it produces a UI that opens a camera for a session
// the database will refuse, or refuses one it would have accepted.
// =============================================================================

import { describe, expect, it } from 'vitest'

import {
  SESSION_STATE,
  VERIFIED_AMR_METHODS,
  decodeJwtPayload,
  isAnonymousSession,
  isVerifiedSession,
  sessionAmrMethods,
  sessionEmail,
  sessionState,
} from '../session.js'

/**
 * Build a structurally-real (unsigned) JWT. The signature is never checked
 * client-side — see the warning on decodeJwtPayload — so a fixed placeholder
 * segment is enough, and using one keeps these fixtures readable.
 */
function makeJwt(payload) {
  const encode = (obj) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig`
}

function sessionWith(payload, userOverrides = {}) {
  return {
    access_token: makeJwt(payload),
    user: { id: payload.sub ?? 'uid-1', email: payload.email ?? null, ...userOverrides },
  }
}

const AMR = (method) => [{ method, timestamp: 1770000000 }]

describe('VERIFIED_AMR_METHODS — pinned against the SQL list', () => {
  it('contains exactly the methods in the SQL in(...) list', () => {
    expect([...VERIFIED_AMR_METHODS]).toEqual(['otp', 'magiclink', 'oauth', 'sso/saml', 'totp'])
  })

  // ⚠ THIS TEST ONCE ASSERTED THE OPPOSITE, AND THAT WAS A LIVE SECURITY HOLE.
  // `password` had been added to the array and these tests rewritten to bless
  // it, while the doc comment above the array still explained why it must be
  // absent. The effect, once session_is_verified_human() was applied to the
  // project: the CLIENT called a password-only session verified and opened the
  // camera, while the DATABASE refused every write it then attempted — so a
  // student could sit an entire exam with no violations or evidence recorded.
  //
  // A password proves knowledge of a secret, not control of the mailbox it was
  // registered against, and it is the one factor a credential dump hands over
  // wholesale. It is the entire reason the emailed code exists.
  it('excludes password — it is the second factor being enforced', () => {
    expect(VERIFIED_AMR_METHODS).not.toContain('password')
  })

  it('excludes anonymous — that is the guest session being removed', () => {
    expect(VERIFIED_AMR_METHODS).not.toContain('anonymous')
  })
})

describe('isVerifiedSession', () => {
  it('accepts a session minted by the emailed code (amr: otp)', () => {
    const session = sessionWith({ sub: 'u1', email: 'a@example.com', amr: AMR('otp') })
    expect(isVerifiedSession(session)).toBe(true)
    expect(sessionState(session)).toBe(SESSION_STATE.VERIFIED)
  })

  it('accepts Google (amr: oauth) without any code step', () => {
    const session = sessionWith({ sub: 'u2', email: 'b@gmail.com', amr: AMR('oauth') })
    expect(isVerifiedSession(session)).toBe(true)
    expect(sessionState(session)).toBe(SESSION_STATE.VERIFIED)
  })

  // The half-finished login: real session, usable for changing your own
  // account, and not sufficient for the demo. AWAITING_EMAIL_CODE is what tells
  // the UI to ask for the code rather than to sign the visitor out.
  it('refuses a password-only session and asks for the emailed code', () => {
    const session = sessionWith({ sub: 'u3', email: 'c@example.com', amr: AMR('password') })
    expect(isVerifiedSession(session)).toBe(false)
    expect(sessionState(session)).toBe(SESSION_STATE.AWAITING_EMAIL_CODE)
  })

  it('accepts password + otp together — the code upgrades the same session', () => {
    const session = sessionWith({
      sub: 'u4',
      email: 'd@example.com',
      amr: [{ method: 'password', timestamp: 1 }, { method: 'otp', timestamp: 2 }],
    })
    expect(isVerifiedSession(session)).toBe(true)
  })

  it('accepts an MFA factor (amr: mfa/totp), matching the SQL like-clause', () => {
    expect(isVerifiedSession(sessionWith({ sub: 'u5', amr: AMR('mfa/totp') }))).toBe(true)
  })
})

describe('anonymous sessions — the guest hole', () => {
  it('refuses a session flagged anonymous by the JWT claim', () => {
    const session = sessionWith({ sub: 'u6', amr: AMR('anonymous'), is_anonymous: true })
    expect(isAnonymousSession(session)).toBe(true)
    expect(isVerifiedSession(session)).toBe(false)
    expect(sessionState(session)).toBe(SESSION_STATE.ANONYMOUS)
  })

  // ⚠ EITHER SOURCE IS ENOUGH. supabase-js exposes `user.is_anonymous`; RLS
  // reads the JWT claim. A fixture where only one says anonymous must still be
  // refused, or the strictest-reading rule in isAnonymousSession is doing
  // nothing.
  it('refuses when only the user object says anonymous', () => {
    const session = sessionWith({ sub: 'u7', amr: AMR('oauth') }, { is_anonymous: true })
    expect(isAnonymousSession(session)).toBe(true)
    expect(isVerifiedSession(session)).toBe(false)
  })

  it('refuses an anonymous session even if its amr somehow claims oauth', () => {
    const session = sessionWith({ sub: 'u8', amr: AMR('oauth'), is_anonymous: true })
    expect(isVerifiedSession(session)).toBe(false)
  })
})

describe('fails closed', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['no access token', { user: { id: 'u' } }],
    ['a token that is not a JWT', { access_token: 'not-a-jwt' }],
    ['a token with two segments', { access_token: 'aaa.bbb' }],
    ['a token whose payload is not base64', { access_token: 'aaa.!!!.ccc' }],
  ])('refuses a session with %s', (_label, session) => {
    expect(isVerifiedSession(session)).toBe(false)
  })

  it('refuses a token carrying no amr claim at all', () => {
    expect(isVerifiedSession(sessionWith({ sub: 'u9', email: 'e@example.com' }))).toBe(false)
  })

  it('refuses an amr that is present but not an array', () => {
    expect(isVerifiedSession(sessionWith({ sub: 'u10', amr: 'otp' }))).toBe(false)
  })

  it('reports SIGNED_OUT, not ANONYMOUS, when there is no session', () => {
    expect(sessionState(null)).toBe(SESSION_STATE.SIGNED_OUT)
  })
})

describe('sessionAmrMethods', () => {
  it('reads entries in object form and lowercases them', () => {
    const session = sessionWith({ sub: 'u11', amr: [{ method: 'OAuth', timestamp: 1 }] })
    expect(sessionAmrMethods(session)).toEqual(['oauth'])
    expect(isVerifiedSession(session)).toBe(true)
  })

  it('tolerates bare-string entries', () => {
    expect(sessionAmrMethods(sessionWith({ sub: 'u12', amr: ['otp'] }))).toEqual(['otp'])
  })

  it('drops malformed entries instead of throwing', () => {
    const session = sessionWith({ sub: 'u13', amr: [null, {}, { method: 42 }, { method: 'otp' }] })
    expect(sessionAmrMethods(session)).toEqual(['otp'])
  })

  it('returns an empty array — never null — for an unreadable token', () => {
    expect(sessionAmrMethods({ access_token: 'garbage' })).toEqual([])
  })
})

describe('sessionEmail', () => {
  it('prefers the user object', () => {
    expect(sessionEmail(sessionWith({ sub: 'u14', email: 'f@example.com' }))).toBe('f@example.com')
  })

  it('falls back to the JWT claim when the user object has none', () => {
    const session = sessionWith({ sub: 'u15', email: 'g@example.com', amr: AMR('password') })
    session.user.email = null
    expect(sessionEmail(session)).toBe('g@example.com')
  })

  it('returns null rather than an empty string when there is no address', () => {
    expect(sessionEmail(sessionWith({ sub: 'u16' }))).toBeNull()
    expect(sessionEmail(null)).toBeNull()
  })
})

describe('decodeJwtPayload', () => {
  it('round-trips a payload', () => {
    expect(decodeJwtPayload(makeJwt({ sub: 'x', amr: AMR('otp') }))).toMatchObject({ sub: 'x' })
  })

  it('returns null for anything malformed', () => {
    expect(decodeJwtPayload('a.b')).toBeNull()
    expect(decodeJwtPayload(null)).toBeNull()
    expect(decodeJwtPayload(123)).toBeNull()
  })
})
