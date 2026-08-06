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

const supabaseUrl = typeof rawUrl === 'string' ? rawUrl.trim() : ''
const supabaseAnonKey = typeof rawAnonKey === 'string' ? rawAnonKey.trim() : ''

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
 * @param {string} segment
 * @returns {string}
 */
function base64UrlDecode(segment) {
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
export const isSupabaseConfigured = Boolean(supabaseUrl) && looksLikeSupabaseKey(supabaseAnonKey)

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
