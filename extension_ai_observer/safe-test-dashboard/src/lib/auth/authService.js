// =============================================================================
// src/lib/auth/authService.js
//
// Sign-up / sign-in / sign-out for the three roles, plus a profile fetch.
// Every export returns the same explicit result shape:
//
//   { ok: boolean, reason: string | null, data: T | null, error: unknown }
//
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
 * Sign up a new account using Email + Password under one of the three roles.
 * Minimum password length is 6 characters.
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
  if (password.length < 6) {
    return { ok: false, reason: 'WEAK_PASSWORD', data: null, error: null }
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
 * Sign in using Email + Password.
 * NO OTP or verification emails are dispatched during sign in.
 *
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

// -----------------------------------------------------------------------------
// Google OAuth
// -----------------------------------------------------------------------------

export const DEFAULT_OAUTH_REDIRECT_PATH = '/demo-quiz'
export const EMAIL_CODE_LENGTH = 6

/**
 * Start the Google OAuth redirect flow.
 *
 * @param {{ redirectTo?: string }} [params]
 * @returns {Promise<AuthResult>}
 */
export async function signInWithGoogle({ redirectTo } = {}) {
  if (!isSupabaseConfigured || !supabase) return unconfiguredResult()

  const target = redirectTo
    ?? (typeof window !== 'undefined'
      ? `${window.location.origin}${DEFAULT_OAUTH_REDIRECT_PATH}`
      : undefined)

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: target },
  })

  if (error) return { ok: false, reason: 'SUPABASE_ERROR', data: null, error }
  return { ok: true, reason: null, data, error: null }
}

// -----------------------------------------------------------------------------
// Email OTP verification (for sign-up confirmation)
// -----------------------------------------------------------------------------

/**
 * Re-send 6-digit OTP code to an email address.
 *
 * @param {{ email: string }} params
 * @returns {Promise<AuthResult>}
 */
export async function sendEmailCode({ email } = {}) {
  if (!isSupabaseConfigured || !supabase) return unconfiguredResult()
  if (!email) return { ok: false, reason: 'MISSING_CREDENTIALS', data: null, error: null }

  const { data, error } = await supabase.auth.resend({
    type: 'signup',
    email,
  })

  if (error) {
    // Fallback to signInWithOtp if resend is not enabled for signup
    const fallback = await supabase.auth.signInWithOtp({ email })
    if (fallback.error) return { ok: false, reason: 'SUPABASE_ERROR', data: null, error: fallback.error }
    return { ok: true, reason: null, data: fallback.data, error: null }
  }
  return { ok: true, reason: null, data, error: null }
}

/**
 * Exchange the 6-digit email confirmation code.
 *
 * @param {{ email: string, token: string, type?: 'signup' | 'email' }} params
 * @returns {Promise<AuthResult>}
 */
export async function verifyEmailCode({ email, token, type = 'signup' } = {}) {
  if (!isSupabaseConfigured || !supabase) return unconfiguredResult()
  if (!email || !token) {
    return { ok: false, reason: 'MISSING_CREDENTIALS', data: null, error: null }
  }

  const cleaned = String(token).replace(/\D/g, '')
  if (cleaned.length !== EMAIL_CODE_LENGTH) {
    return { ok: false, reason: 'INVALID_CODE_FORMAT', data: null, error: null }
  }

  let response = await supabase.auth.verifyOtp({
    email,
    token: cleaned,
    type,
  })

  if (response.error && type === 'signup') {
    const fallbackResponse = await supabase.auth.verifyOtp({
      email,
      token: cleaned,
      type: 'email',
    })
    if (!fallbackResponse.error) {
      response = fallbackResponse
    }
  }

  if (response.error) return { ok: false, reason: 'SUPABASE_ERROR', data: null, error: response.error }
  return { ok: true, reason: null, data: response.data, error: null }
}

/**
 * Sign out of current session.
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
 * Reads the caller's own profile row.
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
