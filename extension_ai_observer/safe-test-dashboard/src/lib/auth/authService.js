// =============================================================================
// src/lib/auth/authService.js
//
// Sign-up / sign-in / sign-out for the three roles, plus a profile fetch.
// Every export returns the same explicit result shape:
//
//   { ok: boolean, reason: string | null, data: T | null, error: unknown }
//
// =============================================================================

import { supabase, isSupabaseConfigured, SUPABASE_UNCONFIGURED_REASON, AVATARS_BUCKET } from '../supabase.js'
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

  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
  if (error) return { ok: false, reason: 'SUPABASE_ERROR', data: null, error }
  return { ok: true, reason: null, data: data ?? null, error: null }
}

/**
 * Updates the caller's own profile row, and mirrors the display name into auth
 * metadata so the nav has a name to render before the profile row is fetched.
 *
 * ⚠ `avatarPath` IS A STORAGE PATH, NOT A URL, and it is written ONLY to
 * `profiles.avatar_path` — never into `user_metadata`. Two reasons, both of
 * which were live defects here:
 *
 *   1. The picture lives in a PRIVATE bucket, so the only URL that resolves is
 *      a signed one, and a signed URL carries an expiry. Persisting it stores a
 *      credential that silently begins returning 400 once it lapses.
 *   2. `user_metadata` travels inside the JWT. The previous implementation fell
 *      back to storing a base64 `data:` URL there whenever the upload failed,
 *      which inflates every subsequent request header by megabytes.
 *
 * So `user_metadata.avatar_url` keeps its one original meaning: the photo the
 * IDENTITY PROVIDER supplied (Google), which is a real, public, non-expiring
 * URL. Pass `avatarPath: null` to clear an uploaded picture.
 *
 * ⚠ `updated_at` IS DELIBERATELY NOT SENT. A `profiles_set_updated_at` BEFORE
 * UPDATE trigger maintains it, and `authenticated` holds no UPDATE grant on
 * that column — so including it fails the whole statement with "permission
 * denied for column updated_at", which is what made every save here fail
 * regardless of what the avatar code did.
 *
 * @param {{ userId: string, fullName?: string, organizationName?: string, avatarPath?: string | null }} params
 * @returns {Promise<AuthResult>}
 */
export async function updateOwnProfile({ userId, fullName, organizationName, avatarPath } = {}) {
  if (!isSupabaseConfigured || !supabase) return unconfiguredResult()
  if (!userId) return { ok: false, reason: 'NO_USER', data: null, error: null }

  // Best-effort mirror of the display name into auth metadata. A failure costs
  // a slightly stale name in the nav until the next profile fetch, which is not
  // worth failing the user's save over.
  if (fullName !== undefined) {
    try {
      await supabase.auth.updateUser({ data: { full_name: fullName } })
    } catch {
      // Non-fatal, as above.
    }
  }

  const updates = {}
  if (fullName !== undefined) updates.full_name = fullName
  if (organizationName !== undefined) updates.organization_name = organizationName
  if (avatarPath !== undefined) updates.avatar_path = avatarPath

  // Nothing to write is a success, not a no-op that reports failure. Sending an
  // empty object would make PostgREST reject the request.
  if (Object.keys(updates).length === 0) {
    return { ok: true, reason: null, data: null, error: null }
  }

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .select()
    .maybeSingle()

  if (error) return { ok: false, reason: 'SUPABASE_ERROR', data: null, error }
  return { ok: true, reason: null, data: data ?? null, error: null }
}

// ---------------------------------------------------------------------------
// Profile pictures
//
// Path contract: `<uid>/avatar.<ext>` inside the private AVATARS_BUCKET. The
// leading folder IS the owner's uid, because that is precisely what the
// bucket's RLS policies compare against — see
// supabase/migrations/20260812130000_avatars_bucket.sql.
// ---------------------------------------------------------------------------

/**
 * The image types Storage will accept, mapped to the extension we give them.
 *
 * ⚠ THE EXTENSION COMES FROM THE MIME TYPE, NEVER FROM `file.name`. Deriving it
 * from the filename (the previous approach, `file.name.split('.').pop()`) trusts
 * an attacker-controlled string to build a storage path: a file named
 * `x.png/../../someone-else` walks the path, and a file with no dot at all
 * yields the whole filename as an "extension". Reading the browser-sniffed MIME
 * type instead means the set of possible paths is closed by this table.
 *
 * Kept in step with `allowed_mime_types` on the bucket. The bucket is the real
 * enforcement; this exists so the user gets "PNG, JPEG, WebP or GIF only"
 * instead of a 400 from the API after the whole file has been uploaded.
 */
const AVATAR_MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** Mirrors `file_size_limit` on the bucket (5 MiB). */
const AVATAR_MAX_BYTES = 5 * 1024 * 1024

/** How long a minted avatar URL stays valid. */
const AVATAR_URL_TTL_SECONDS = 60 * 60 // 1 hour

/**
 * Mints a temporary URL for a stored avatar.
 *
 * The bucket is private, so `getPublicUrl()` — which the previous version used —
 * cheerfully returns a well-formed URL that always 403s. It never returns null
 * either, which is why that code's signed-URL fallback branch was unreachable.
 *
 * @param {string | null | undefined} path Value of `profiles.avatar_path`.
 * @returns {Promise<string | null>} null when there is nothing to sign, or when
 *   signing fails — callers fall back to initials, which is a fine outcome.
 */
export async function createAvatarSignedUrl(path) {
  if (!isSupabaseConfigured || !supabase || !path) return null

  const { data, error } = await supabase.storage
    .from(AVATARS_BUCKET)
    .createSignedUrl(path, AVATAR_URL_TTL_SECONDS)

  if (error || !data?.signedUrl) return null
  return data.signedUrl
}

/**
 * Uploads a profile picture to `<uid>/avatar.<ext>` in the avatars bucket.
 *
 * Returns the stored PATH rather than a URL: the path is what belongs in
 * `profiles.avatar_path`, and URLs are minted from it on demand by
 * `createAvatarSignedUrl`. See `updateOwnProfile` for why persisting a URL here
 * would be a bug.
 *
 * @param {string} userId
 * @param {File | Blob} file
 * @returns {Promise<{ ok: boolean, path: string | null, reason: string | null, error: unknown }>}
 */
export async function uploadProfilePicture(userId, file) {
  if (!isSupabaseConfigured || !supabase) {
    return { ok: false, path: null, reason: SUPABASE_UNCONFIGURED_REASON, error: null }
  }
  if (!userId || !file) {
    return { ok: false, path: null, reason: 'MISSING_INPUT', error: null }
  }

  const ext = AVATAR_MIME_EXT[file.type]
  if (!ext) {
    return { ok: false, path: null, reason: 'UNSUPPORTED_TYPE', error: null }
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return { ok: false, path: null, reason: 'TOO_LARGE', error: null }
  }

  const path = `${userId}/avatar.${ext}`

  const { error: uploadError } = await supabase.storage.from(AVATARS_BUCKET).upload(path, file, {
    // `upsert` covers re-uploading the SAME format. It does not cover a format
    // change (png -> jpg is a different object name), which is what the sweep
    // below is for.
    upsert: true,
    // Storage validates this against the bucket's allowed_mime_types. Letting it
    // default risks `application/octet-stream` and a rejection that reads as a
    // server fault rather than an unsupported file.
    contentType: file.type,
    // Short, because the signed URL rotates hourly and a long-lived cache entry
    // would keep showing the previous picture after a change.
    cacheControl: '300',
  })

  if (uploadError) {
    return { ok: false, path: null, reason: 'UPLOAD_FAILED', error: uploadError }
  }

  // Sweep any earlier picture stored under a different extension. Best-effort:
  // a leftover orphan costs a few KB and is invisible to the user, so it must
  // never turn a successful upload into a reported failure.
  await removeProfilePicture(userId, { except: path })

  return { ok: true, path, reason: null, error: null }
}

/**
 * Deletes the caller's stored avatar objects.
 *
 * @param {string} userId
 * @param {{ except?: string }} [options] Path to keep — used by the upload path
 *   to clear stale format variants without deleting what it just wrote.
 * @returns {Promise<{ ok: boolean }>} Always ok: see the note in `uploadProfilePicture`.
 */
export async function removeProfilePicture(userId, { except } = {}) {
  if (!isSupabaseConfigured || !supabase || !userId) return { ok: true }

  try {
    const { data: files } = await supabase.storage.from(AVATARS_BUCKET).list(userId)
    const paths = (files ?? [])
      .map((entry) => `${userId}/${entry.name}`)
      .filter((candidate) => candidate !== except)

    if (paths.length > 0) {
      await supabase.storage.from(AVATARS_BUCKET).remove(paths)
    }
  } catch {
    // Best-effort, as documented above.
  }

  return { ok: true }
}
