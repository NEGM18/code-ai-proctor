// =============================================================================
// supabase_fallback.test.js — the two ways the built-in credential fallback can
// fail silently.
//
// `src/lib/supabase.js` now falls back to a committed project URL and
// publishable key when the build did not inline `VITE_SUPABASE_*`, so that an
// empty `apikey` is never sent. That fallback has two failure modes which are
// both invisible at runtime until something much later breaks:
//
//   1. The module throws at IMPORT time. The fallback is resolved by calling
//      `looksLikeSupabaseKey`, which is a hoisted function declaration but
//      closes over a `const` regex that is NOT hoisted. Placing the resolution
//      above that const is a temporal-dead-zone ReferenceError — and this module
//      is explicitly forbidden from throwing on import, because every consumer
//      imports it eagerly and a crash here takes the whole app down.
//
//   2. The committed key is structurally wrong. A typo in the constant, or a
//      future edit that truncates it, leaves `isSupabaseConfigured` false and
//      every call site on its local-only path — i.e. exactly the outage the
//      fallback was added to prevent, with no error pointing at the cause.
//
// ⚠ THIS SUITE DELIBERATELY DOES NOT ASSERT THAT THE FALLBACK IS *ENGAGED*.
// Vitest resolves `import.meta.env` through Vite, which loads `.env.local`, so
// whether the env key is present depends on the machine the suite runs on. A
// test asserting "the fallback engaged" would pass in CI and fail on a
// developer's checkout, which is worse than not testing it: it teaches people
// that a red suite is normal. What is asserted here is true either way.
// =============================================================================

import { describe, expect, it } from 'vitest'

import {
  base64UrlDecode,
  isSupabaseConfigured,
  looksLikeSupabaseKey,
  supabase,
} from '../supabase.js'

/**
 * The exact constant committed in `supabase.js` as `BUILTIN_SUPABASE_ANON_KEY`.
 *
 * Duplicated here rather than exported and imported, on purpose: a test that
 * imports the value can only ever check the value against itself. Writing it
 * out means an edit to the constant has to be made in two places by someone who
 * has looked at both, which is the whole point of pinning it.
 */
const BUILTIN_ANON_KEY = 'sb_publishable_NT2huOBy2yDrIdcV39YT7A_TS-IPjhl'

describe('the built-in Supabase fallback', () => {
  it('imports without throwing — no temporal dead zone', () => {
    // Reaching this line at all is the assertion: a TDZ ReferenceError in
    // supabase.js would have thrown during the import above, before any test
    // ran, and vitest would report the whole FILE as failed rather than this
    // case. The explicit check keeps the intent visible to a reader.
    expect(true).toBe(true)
  })

  it('leaves the client usable rather than null', () => {
    // The governing rule in supabase.js is that an unconfigured build must be an
    // explicit no-op, never a silent one. With the fallback in place the client
    // should always exist — if this is null, the built-ins are broken and every
    // consumer has quietly switched to its local-only path.
    expect(isSupabaseConfigured).toBe(true)
    expect(supabase).not.toBeNull()
  })

  it('accepts the committed publishable key as structurally valid', () => {
    // The fallback is only worth having if the value it falls back TO passes the
    // same validator the env value must pass. A truncated or mistyped constant
    // fails here loudly instead of at the first PostgREST call.
    expect(looksLikeSupabaseKey(BUILTIN_ANON_KEY)).toBe(true)
  })

  it('still rejects an empty or placeholder key', () => {
    // The fallback must not have been implemented by widening the validator.
    expect(looksLikeSupabaseKey('')).toBe(false)
    expect(looksLikeSupabaseKey('your_actual_anon_key_here')).toBe(false)
    expect(looksLikeSupabaseKey(undefined)).toBe(false)
    expect(looksLikeSupabaseKey('sb_publishable_short')).toBe(false)
  })

  it('keeps the JWT path working alongside the publishable path', () => {
    // Legacy projects still issue a 3-segment JWT anon key, and the fallback
    // work must not have broken that branch. Built rather than pasted so no
    // real token appears in the repo.
    //
    // `btoa` rather than `Buffer`: this file lints under the same browser
    // globals as the app code it tests, where `Buffer` does not exist — and
    // `base64UrlDecode` in supabase.js is itself built on `atob` for exactly
    // that reason, so encoding the same way keeps the two halves symmetrical.
    const b64url = (value) => btoa(JSON.stringify(value))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    const header = b64url({ alg: 'HS256', typ: 'JWT' })
    const payload = b64url({ role: 'anon', ref: 'x'.repeat(120) })
    const jwt = `${header}.${payload}.${'s'.repeat(43)}`

    expect(jwt.length).toBeGreaterThan(100)
    expect(looksLikeSupabaseKey(jwt)).toBe(true)
    expect(JSON.parse(base64UrlDecode(header)).alg).toBe('HS256')
  })
})
