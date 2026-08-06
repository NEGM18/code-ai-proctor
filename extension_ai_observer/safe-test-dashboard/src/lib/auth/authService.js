// =============================================================================
// src/lib/auth/authService.js
//
// Sign-up / sign-in / sign-out for the three roles, plus a profile fetch.
// Every export returns the same explicit result shape:
//
//   { ok: boolean, reason: string | null, data: T | null, error: unknown }
//
// `ok: false` with a specific `reason` is a first-class outcome, not an
// exception. When Supabase isn't configured, every function returns
// `{ ok: false, reason: SUPABASE_UNCONFIGURED_REASON, ... }` immediately,
// with NO network call attempted — the same "explicit no-op" contract
// src/lib/demoSnapshots.js follows for uploads. A caller (a sign-up form)
// can render "auth is unavailable in local-only mode" straight off `reason`
// without inspecting an error object that doesn't exist.
// =============================================================================

import { supabase, isSupabaseConfigured, SUPABASE_UNCONFIGURED_REASON } from '../supabase.js'
import { ROLE, isValidRole } from './roles.js'

/**
 * @typedef {{ ok: boolean, reason: string | null, data: unknown, error: unknown }} AuthResult
 */

/**
 * @returns {AuthResult}
 */
function unconfiguredResult() {
  return { ok: false, reason: SUPABASE_UNCONFIGURED_REASON, data: null, error: null }
}

/**
 * Sign up a new account under one of the three roles. `role`/`full_name`/
 * `organization_name` ride in `auth.signUp`'s `options.data`
 * (raw_user_meta_data), which `handle_new_user()` (see the profiles
 * migration) reads to populate the `profiles` row — this function never
 * writes to `profiles` directly, that table has no client INSERT grant.
 *
 * @param {{ email: string, password: string, role: string, fullName?: string, organizationName?: string }} params
 * @returns {Promise<AuthResult>}
 */
export async function signUpWithRole({ email, password, role, fullName, organizationName } = {}) {
  if (!isSupabaseConfigured || !supabase) return unconfiguredResult()

  if (!isValidRole(role)) {
    return { ok: false, reason: 'INVALID_ROLE', data: null, error: null }
  }
  if (!email || !password) {
    return { ok: false, reason: 'MISSING_CREDENTIALS', data: null, error: null }
  }
  if (role === ROLE.ORGANIZATION && !organizationName) {
    return { ok: false, reason: 'ORGANIZATION_NAME_REQUIRED', data: null, error: null }
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        role,
        full_name: fullName ?? null,
        organization_name: role === ROLE.ORGANIZATION ? organizationName : null,
      },
    },
  })

  if (error) return { ok: false, reason: 'SUPABASE_ERROR', data: null, error }
  return { ok: true, reason: null, data, error: null }
}

/**
 * @param {{ email: string, password: string }} params
 * @returns {Promise<AuthResult>}
 */
export async function signInWithPassword({ email, password } = {}) {
  if (!isSupabaseConfigured || !supabase) return unconfiguredResult()
  if (!email || !password) {
    return { ok: false, reason: 'MISSING_CREDENTIALS', data: null, error: null }
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return { ok: false, reason: 'SUPABASE_ERROR', data: null, error }
  return { ok: true, reason: null, data, error: null }
}

/**
 * Signing out of a session that was never real (no Supabase configured, no
 * session to begin with) is trivially successful — there is nothing to undo
 * — so this is the one function that returns `ok: true` in the unconfigured
 * case, while STILL reporting the reason so a caller can tell "we signed
 * out" from "there was never anything to sign out of".
 * @returns {Promise<{ ok: boolean, reason: string | null, error: unknown }>}
 */
export async function signOutCurrentUser() {
  if (!isSupabaseConfigured || !supabase) {
    return { ok: true, reason: SUPABASE_UNCONFIGURED_REASON, error: null }
  }
  const { error } = await supabase.auth.signOut()
  if (error) return { ok: false, reason: 'SUPABASE_ERROR', error }
  return { ok: true, reason: null, error: null }
}

/**
 * Reads the caller's own profile row. RLS (`profiles_select_own`) already
 * enforces `auth.uid() = id` server-side; passing `userId` explicitly here
 * just avoids an extra `getUser()` round trip when the caller already has it
 * (e.g. from `onAuthStateChange`).
 * @param {string} userId
 * @returns {Promise<AuthResult>}
 */
export async function fetchOwnProfile(userId) {
  if (!isSupabaseConfigured || !supabase) return unconfiguredResult()
  if (!userId) return { ok: false, reason: 'NO_USER', data: null, error: null }

  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single()
  if (error) return { ok: false, reason: 'SUPABASE_ERROR', data: null, error }
  return { ok: true, reason: null, data, error: null }
}
