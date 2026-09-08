// =============================================================================
// src/lib/auth/deviceTrust.js
//
// "Remember this device": the browser-side half of the trusted-device flow that
// lets a returning user sign in with a password alone, without an emailed code
// every time.
//
//   first sign-in    password -> emailed code -> VERIFIED -> enrol, secret stored
//   later sign-ins   password -> redeem secret -> VERIFIED, no email sent
//   unknown device   password -> no secret -> emailed code, exactly as before
//
// ⚠ THE SECRET IS A BEARER TOKEN. Anyone holding it, together with the password,
// can reach a verified session. That is the accepted bargain of "remember this
// device" — and it is why the server expires trust after 30 days and why the
// device list exists so a user can revoke one. It also means the secret must
// never be written anywhere it could leak further: no cookies (sent on every
// request, and to subdomains), never in a URL, never logged.
//
// ⚠ NOTHING HERE IS THE SECURITY BOUNDARY. The checks live in SQL:
// enroll_trusted_device() refuses unless the caller is ALREADY verified, and
// redeem_device_trust() matches the hash scoped by auth.uid(). A visitor editing
// this file in devtools reaches exactly the same wall one layer down.
// =============================================================================

import { supabase, isSupabaseConfigured } from '../supabase.js'

/**
 * Keyed by user id, because a shared browser holds one secret PER ACCOUNT. A
 * single global key would mean the second person to sign in overwrites the
 * first person's trust, silently sending them back to email codes forever.
 */
const STORAGE_PREFIX = 'procminds.device_trust.v1'

const storageKey = (userId) => `${STORAGE_PREFIX}:${userId}`

/** localStorage throws in some private modes and is absent during SSR. */
function safeStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage
  } catch {
    return null
  }
}

export function readDeviceSecret(userId) {
  if (!userId) return null
  const store = safeStorage()
  if (!store) return null
  try {
    return store.getItem(storageKey(userId)) || null
  } catch {
    return null
  }
}

export function storeDeviceSecret(userId, secret) {
  if (!userId || !secret) return false
  const store = safeStorage()
  if (!store) return false
  try {
    store.setItem(storageKey(userId), secret)
    return true
  } catch {
    // Quota, or a private-mode refusal. Not fatal: the user simply gets an
    // emailed code next time, which is the pre-existing behaviour.
    return false
  }
}

export function clearDeviceSecret(userId) {
  const store = safeStorage()
  if (!store || !userId) return
  try {
    store.removeItem(storageKey(userId))
  } catch {
    // Nothing to do — server-side revocation is what actually ends trust.
  }
}

/**
 * A human label for the device list, e.g. "Chrome on Windows".
 *
 * ⚠ DELIBERATELY COARSE. This is shown to the user so they can recognise their
 * own machines; it is not a fingerprint and must not become one. Browser and OS
 * family only — no version, no screen metrics, no canvas.
 *
 * @param {string} [userAgent] Injectable so this is testable without a DOM.
 */
export function describeThisDevice(userAgent) {
  const ua = typeof userAgent === 'string'
    ? userAgent
    : (typeof navigator !== 'undefined' ? navigator.userAgent : '')
  if (!ua) return 'Unknown device'

  // ⚠ Order matters. Edge and Opera both contain "Chrome", and Chrome contains
  // "Safari", so the most specific token has to be tested first.
  const browser =
    /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
        : /Firefox\//.test(ua) ? 'Firefox'
          : /Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari'
              : 'Browser'

  const os =
    /Windows/.test(ua) ? 'Windows'
      : /Android/.test(ua) ? 'Android'
        : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
          : /Mac OS X/.test(ua) ? 'macOS'
            : /Linux/.test(ua) ? 'Linux'
              : 'device'

  return `${browser} on ${os}`
}

/**
 * Records this browser as trusted. Call ONLY after a session became verified
 * (emailed code accepted, or Google) — the SQL refuses otherwise.
 *
 * @returns {Promise<boolean>} true when a secret was issued and stored.
 */
export async function enrollThisDevice(userId) {
  if (!isSupabaseConfigured || !supabase || !userId) return false

  const { data, error } = await supabase.rpc('enroll_trusted_device', {
    p_label: describeThisDevice(),
  })

  // A null result is the SQL's "you were not verified" answer, not a fault.
  if (error || !data) return false
  return storeDeviceSecret(userId, data)
}

/**
 * Exchanges a stored secret for verification of the CURRENT session.
 *
 * @returns {Promise<boolean>} true when this session is now verified, so the
 *   caller can skip the emailed code entirely.
 */
export async function redeemThisDevice(userId) {
  if (!isSupabaseConfigured || !supabase || !userId) return false

  const secret = readDeviceSecret(userId)
  if (!secret) return false

  const { data, error } = await supabase.rpc('redeem_device_trust', { p_secret: secret })

  if (error) return false
  if (data !== true) {
    // Revoked, expired, or belonging to another account. Drop it so we stop
    // retrying a secret the server will never accept again.
    clearDeviceSecret(userId)
    return false
  }
  return true
}

/** @returns {Promise<Array>} the caller's active devices, most recent use first. */
export async function listTrustedDevices() {
  if (!isSupabaseConfigured || !supabase) return []
  const { data, error } = await supabase.rpc('my_trusted_devices')
  return error ? [] : (data ?? [])
}

/**
 * Signs a device out: ends its live sessions, drops its verification markers,
 * and stops its secret from ever being redeemed again.
 */
export async function revokeTrustedDevice(deviceId, { isCurrent = false, userId = null } = {}) {
  if (!isSupabaseConfigured || !supabase || !deviceId) return false

  const { data, error } = await supabase.rpc('revoke_trusted_device', { p_device_id: deviceId })
  if (error || data !== true) return false

  // Only bin the local copy when the user revoked THIS browser. Revoking a
  // different one must not strip the current browser of its own trust.
  if (isCurrent && userId) clearDeviceSecret(userId)
  return true
}
