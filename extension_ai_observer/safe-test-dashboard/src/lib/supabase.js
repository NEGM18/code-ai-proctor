// =============================================================================
// src/lib/supabase.js
//
// The single Supabase client for the app, plus `isSupabaseConfigured` — the
// predicate every other module in src/lib/ (and every component that renders
// a "local only — not uploaded" chip) is built around.
//
// GOVERNING RULE (PLAN.md §7): when Supabase is unconfigured, every path
// touching it must be an explicit no-op, never a silent one that looks like
// success. That starts here: importing this module must NEVER throw just
// because the env vars are missing or are still the checked-in placeholder —
// an import-time crash would take the whole demo down, which is the opposite
// of graceful degradation.
// =============================================================================

import { createClient } from '@supabase/supabase-js'

// `import.meta.env` is a Vite build-time construct; Vite statically replaces
// `import.meta.env` itself (and each `.VITE_*` access) with an injected
// object, so `?? {}` is a no-op under Vite but keeps this module importable
// from plain Node (no bundler) without throwing — which matters because this
// file is expected to degrade gracefully to "unconfigured", never to crash,
// when nothing has set these variables up at all.
const env = import.meta.env ?? {}
/** @type {string | undefined} */
const rawUrl = env.VITE_SUPABASE_URL
/** @type {string | undefined} */
const rawAnonKey = env.VITE_SUPABASE_ANON_KEY

const envSupabaseUrl = typeof rawUrl === 'string' ? rawUrl.trim() : ''
const envSupabaseAnonKey = typeof rawAnonKey === 'string' ? rawAnonKey.trim() : ''

/**
 * The project's URL and PUBLISHABLE key, committed as a last-resort fallback.
 *
 * ⚠ THIS IS NOT A SECRET, AND IT IS THE SAME VALUE THE EXTENSION ALREADY
 * HARD-CODES. A `sb_publishable_…` key carries no authority of its own: it
 * identifies the project, and RLS is what protects the data. It ships inside
 * every built bundle already — `grep sb_publishable_ dist/assets/*.js` finds it
 * — so committing it changes nothing about who can reach what. The value that
 * must never appear here is the service-role/secret key, which bypasses RLS.
 * `extension/content/supabase_rest.js` carries this identical pair in its own
 * `DEFAULTS` for exactly the same reason.
 *
 * ⚠ WHAT THE FALLBACK DOES AND DOES NOT FIX. It guarantees a non-empty `apikey`
 * on every request, so a build that failed to inline `VITE_*` still talks to the
 * project instead of sending an empty key. It does NOT explain a PostgREST
 * "No API key found in request" seen anywhere else: measured against this
 * project, a request carrying the apikey with an anon bearer returns **401**,
 * not that message, and the extension's REST module — which does not use this
 * client at all — always sets the header. When that error appears, identify the
 * caller before changing anything here.
 */
const BUILTIN_SUPABASE_URL = 'https://xokefpfhwcxuvjmxfzke.supabase.co'
const BUILTIN_SUPABASE_ANON_KEY = 'sb_publishable_NT2huOBy2yDrIdcV39YT7A_TS-IPjhl'

// -----------------------------------------------------------------------------
// JWT-shape validation.
//
// The checked-in `.env.local` ships `VITE_SUPABASE_ANON_KEY=your_actual_anon_
// key_here` (26 chars) as a placeholder. A real Supabase anon key is a signed
// JWT — three base64url segments joined by '.', on the order of 200+ chars.
//
// Comparing against the literal placeholder string would pass ANY other junk
// value (a typo, an empty string with stray whitespace, a service-role key
// pasted into the wrong field, "test", ...). Instead this checks the actual
// *shape* of a JWT: three well-formed base64url segments, a plausible total
// length, and a header that base64url-decodes to JSON containing `alg`. That
// rejects the placeholder and anything else that isn't structurally a JWT,
// without hard-coding the one bad value we happen to know about today.
// -----------------------------------------------------------------------------

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/

/**
 * base64url-decode a single JWT segment to a UTF-8 string.
 *
 * Exported so `lib/auth/session.js` can read the `amr` / `is_anonymous` claims
 * off an access token without a second, subtly-different implementation of
 * base64url padding sitting next to this one. One definition per repo — the
 * same rule `ear_veto.js` follows for `eyeAspectRatio`.
 *
 * @param {string} segment
 * @returns {string}
 */
export function base64UrlDecode(segment) {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padLength = (4 - (base64.length % 4)) % 4
  const padded = base64 + '='.repeat(padLength)
  // atob is a standard global in every browser and in Node.js 18+, which is
  // this project's minimum runtime (see package.json engines-equivalent:
  // vite 8 / vitest 4 both require Node 18+). No Buffer fallback needed.
  const binary = atob(padded)
  // Decode Latin1 bytes -> UTF-8 text without pulling in TextDecoder for one
  // call site; JWT headers/payloads are ASCII JSON in practice.
  return decodeURIComponent(
    Array.from(binary)
      .map((char) => '%' + char.charCodeAt(0).toString(16).padStart(2, '0'))
      .join(''),
  )
}

/**
 * Does `key` have the structural shape of a real Supabase JWT anon key?
 * Exported for testing; do not use this to validate arbitrary JWTs — it only
 * checks enough to distinguish "a real signed key" from "a placeholder or
 * obviously-wrong value".
 * @param {unknown} key
 * @returns {boolean}
 */
export function looksLikeSupabaseJwt(key) {
  if (typeof key !== 'string') return false
  const trimmed = key.trim()

  // Real anon keys are long. The placeholder is 26 chars; give real margin
  // below the ~200+ chars a legacy Supabase JWT anon key actually is.
  if (trimmed.length < 100) return false

  const parts = trimmed.split('.')
  if (parts.length !== 3) return false
  if (parts.some((part) => part.length === 0 || !BASE64URL_SEGMENT.test(part))) {
    return false
  }

  try {
    const header = JSON.parse(base64UrlDecode(parts[0]))
    if (!header || typeof header !== 'object') return false
    if (typeof header.alg !== 'string' || header.alg.length === 0) return false
    if (header.typ !== undefined && header.typ !== 'JWT') return false
  } catch {
    // Malformed base64 or non-JSON header -> fail closed, not a real JWT.
    return false
  }

  return true
}

/**
 * The modern publishable key format: `sb_publishable_` + an opaque token.
 *
 * ⚠ IT IS NOT A JWT, AND THAT IS WHY THIS EXISTS. Supabase now issues
 * `sb_publishable_…` keys for new projects and recommends them over the legacy
 * anon JWT (they rotate independently). They are ~44 characters with no dots,
 * so `looksLikeSupabaseJwt` — which requires 100+ characters and three
 * base64url segments — rejects them.
 *
 * That rejection is silent, and it fails in the worst possible direction: a
 * correct, current key is classified as "unconfigured", `supabase` stays null,
 * and every call site takes its deliberate local-only path. The UI then reports
 * "Supabase not configured" — which is exactly what it says for a placeholder,
 * so the operator is told to go and do the thing they have already done.
 */
const PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9_-]{16,}$/

/**
 * Does `key` have the shape of a usable Supabase client key, in EITHER
 * supported form? This is the predicate to use.
 *
 * `looksLikeSupabaseJwt` is deliberately left untouched beside it: its name
 * makes a narrower promise than this one, and widening a function to accept
 * things its name excludes is how a validator stops meaning anything.
 *
 * @param {unknown} key
 * @returns {boolean}
 */
export function looksLikeSupabaseKey(key) {
  if (typeof key !== 'string') return false
  const trimmed = key.trim()
  return PUBLISHABLE_KEY_PATTERN.test(trimmed) || looksLikeSupabaseJwt(trimmed)
}

/**
 * True only when BOTH env vars are present AND the key is structurally real.
 * This is the single predicate the rest of the app should ask — never
 * re-derive "is Supabase usable" from the env vars directly.
 */
// -----------------------------------------------------------------------------
// Effective credentials = the build's values, or the built-ins.
//
// ⚠ RESOLVED HERE, NOT BESIDE `env` AT THE TOP OF THE FILE. `looksLikeSupabaseKey`
// is a hoisted function declaration, but the `PUBLISHABLE_KEY_PATTERN` const it
// closes over is not — calling it before that line is a temporal-dead-zone
// ReferenceError at import time, which this module is explicitly forbidden from
// throwing. Keep this block below the validators.
//
// ⚠ AN ENV KEY THAT IS PRESENT BUT MALFORMED IS REPLACED, NOT PREFERRED. A typo
// or a half-pasted value would otherwise be sent as the apikey and rejected on
// every request, which is the same outage the fallback exists to prevent —
// just with a longer string in it.
// -----------------------------------------------------------------------------
const usedFallbackUrl = !envSupabaseUrl
const usedFallbackKey = !looksLikeSupabaseKey(envSupabaseAnonKey)

const supabaseUrl = envSupabaseUrl || BUILTIN_SUPABASE_URL
const supabaseAnonKey = usedFallbackKey ? BUILTIN_SUPABASE_ANON_KEY : envSupabaseAnonKey

/**
 * True only when BOTH a URL and a structurally-real key are available.
 *
 * ⚠ WITH THE FALLBACK IN PLACE THIS IS NOW EFFECTIVELY ALWAYS TRUE, AND THAT IS
 * A DELIBERATE TRADE WITH A REAL COST. It used to be the app's honest answer to
 * "can we reach Supabase at all", and every call site's local-only path hung off
 * it. A build that shipped without credentials degraded to explicit no-ops.
 *
 * Now such a build silently works against the real project instead. That is what
 * was asked for — an empty apikey is never sent — but it removes the signal that
 * the build was misconfigured, and it means a fork or a differently-configured
 * deployment reaches THIS project unless it sets its own `VITE_*`. The
 * compensating control is the console error below, which fires loudly whenever a
 * fallback is engaged. **Do not delete that warning to quiet the console**: it is
 * the only remaining evidence that a deployment is not running on its own
 * credentials.
 */
export const isSupabaseConfigured = Boolean(supabaseUrl) && looksLikeSupabaseKey(supabaseAnonKey)

// -----------------------------------------------------------------------------
// ⚠ SAY SO, LOUDLY, WHEN THE BUILD SHIPPED WITHOUT CREDENTIALS.
//
// `VITE_*` variables are inlined at BUILD time, on whoever's machine ran the
// build — so a deploy from a checkout whose `.env.local` still holds the
// placeholder produces a site that is permanently unconfigured, and editing
// `.env.local` afterwards changes nothing until the next build. Every call site
// then takes its deliberate local-only path, which is graceful degradation
// working exactly as designed and is therefore indistinguishable, from the
// outside, from a working deployment that simply never uploads anything.
//
// This module still must not THROW (see the header — an import-time crash takes
// the whole demo down, which is strictly worse). So it degrades as before and
// complains in the console, naming which half is wrong: "missing" and
// "malformed" are different mistakes with different fixes, and one generic
// message would send an operator to re-paste a key that is already correct.
// -----------------------------------------------------------------------------
if ((usedFallbackUrl || usedFallbackKey) && typeof console !== 'undefined') {
  const problems = []
  if (usedFallbackUrl) problems.push('VITE_SUPABASE_URL was missing or empty')
  if (usedFallbackKey) {
    // Never log the value itself — the length and prefix identify the mistake,
    // and a full key does not belong in a shared console transcript.
    problems.push(
      envSupabaseAnonKey
        ? `VITE_SUPABASE_ANON_KEY did not look like a Supabase key `
          + `(length ${envSupabaseAnonKey.length}, starts "${envSupabaseAnonKey.slice(0, 8)}…"); `
          + `expected an "sb_publishable_…" key or a 3-segment JWT`
        : 'VITE_SUPABASE_ANON_KEY was missing or empty',
    )
  }
  console.error(
    '[Procminds] Running on the BUILT-IN Supabase credentials, not this build\'s own:\n  - '
    + problems.join('\n  - ')
    + '\n  Requests will work, but against the built-in project — which is wrong for any '
    + 'deployment that is not it.\n  These values are inlined at BUILD time: fix '
    + 'safe-test-dashboard/.env.local and rebuild (npm run build), then redeploy. '
    + 'Editing the file alone changes nothing.',
  )
}

// The fallback is a floor, not a guarantee: if someone edits the built-ins to
// something malformed, this is the only thing that would say so.
if (!isSupabaseConfigured && typeof console !== 'undefined') {
  console.error(
    '[Procminds] Supabase is unusable even with the built-in fallback — the '
    + 'BUILTIN_SUPABASE_* constants in src/lib/supabase.js are themselves invalid. '
    + 'Auth, uploads and the AI review are all disabled.',
  )
}

/**
 * The shared Supabase client, or `null` when unconfigured.
 *
 * Deliberately `null`, not a lazily-throwing proxy: every caller in this
 * codebase is required to check `isSupabaseConfigured` (or the `supabase`
 * value itself) before use, and a `null` check fails loudly and immediately
 * at the call site rather than deep inside a promise chain.
 * @type {import('@supabase/supabase-js').SupabaseClient | null}
 */
export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      // ⚠ BELT AND BRACES, NOT THE MECHANISM — AND WORTH KNOWING WHICH.
      //
      // supabase-js already attaches `apikey` (and an `Authorization` bearer)
      // to every PostgREST, Storage, Auth and Functions request from the key
      // passed as the second argument above; this repeats the same value rather
      // than supplying one that was missing. It is here because "does this
      // client send an apikey?" is a question that has now been asked of this
      // file twice during an outage, and a grep-able answer is cheaper than
      // re-deriving it from the SDK each time.
      //
      // ⚠ IT CANNOT FIX A "No API key found in request" COMING FROM ANYWHERE
      // ELSE, AND ADDING IT MUST NOT BE MISTAKEN FOR HAVING DONE SO. The
      // extension does not use this client at all — `extension/content/
      // supabase_rest.js` is a separate raw-fetch module with its own
      // credentials — so a PostgREST failure observed in the extension's log is
      // never explained by this line. When that error does appear, find the
      // caller first: the header is either absent (this message) or present
      // with an anon bearer (a 401, which is a different fault entirely).
      global: { headers: { apikey: supabaseAnonKey } },
      auth: {
        // Anonymous demo visitors and real sign-ups both persist a session
        // in localStorage so a page refresh mid-demo doesn't orphan
        // already-uploaded snapshots under a session_id the client has lost.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null

/**
 * Shared reason code used across src/lib/auth/ and src/lib/demoSnapshots.js
 * for the "we didn't even try, because Supabase isn't configured" case.
 * Components can switch on this exact string to render the
 * "local only — not uploaded" chip without guessing at error shapes.
 */
export const SUPABASE_UNCONFIGURED_REASON = 'SUPABASE_UNCONFIGURED'

export const DEMO_SNAPSHOTS_BUCKET = 'demo-snapshots'

/**
 * Profile pictures. A SEPARATE bucket from `demo-snapshots`, deliberately.
 *
 * ⚠ Do not "simplify" this back into a folder of `demo-snapshots`. That is what
 * the first implementation did, and every upload failed: that bucket's RLS
 * policies require `(storage.foldername(name))[1] = 'demo'`, so an object at
 * `avatars/<uid>/…` is rejected before it is ever written. The two buckets also
 * hold categorically different things — webcam evidence frames versus a picture
 * the student chose — with different retention stories, and one policy family
 * per bucket is what keeps "what may be written here" readable at a glance.
 *
 * Private, like `demo-snapshots`. Reads go through a short-lived signed URL.
 * See supabase/migrations/20260812130000_avatars_bucket.sql.
 */
export const AVATARS_BUCKET = 'avatars'
