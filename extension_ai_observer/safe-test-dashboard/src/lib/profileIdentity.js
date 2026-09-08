// =============================================================================
// src/lib/profileIdentity.js
//
// How an account is rendered as a person: a display name, a set of initials,
// and an avatar URL. Pure functions, no React, no Supabase — so the avatar in
// the nav and the header on the dashboard can never disagree about who is
// signed in, and so the initials rule is testable without a DOM.
//
// ⚠ NOTHING HERE IS AN AUTHORISATION INPUT. These read `profile.full_name` and
// `user.user_metadata`, both of which describe an account rather than gate it.
// `user_metadata` in particular is user-writable in Supabase; it is fine as a
// label and must never be consulted to decide what someone may see. That
// decision is `verified` / `session_is_verified_human()`, nothing here.
// =============================================================================

/** Everything that is whitespace-ish in a pasted display name. */
const WHITESPACE = /\s+/

/**
 * Initials for the avatar fallback, per the product rule:
 *
 *   "Omar Negm" -> "ON"   (first letter of the first two words)
 *   "Omar"      -> "OM"   (first two letters, because there is no second word)
 *
 * ⚠ THE ONE-WORD CASE IS NOT AN EDGE CASE, IT IS THE COMMON ONE. Google returns
 * a single-token name for plenty of accounts, and every email fallback is one
 * token by construction. Taking `name[0]` alone there would render a lonely
 * single letter in a circle sized for two — so the rule deliberately changes
 * from "one letter per word" to "two letters of the word" rather than degrading.
 *
 * Non-Latin scripts are handled by the same slice: it operates on code points
 * (via [...spread]), so a name whose first character is outside the BMP yields
 * that whole character rather than half a surrogate pair.
 *
 * @param {string | null | undefined} name  Display name, may be blank.
 * @param {string | null | undefined} email Fallback when there is no name.
 * @returns {string} One or two uppercase characters. Never empty.
 */
export function initialsFrom(name, email) {
  const source = cleanName(name) || localPart(email)
  if (!source) return 'U'

  const words = source.split(WHITESPACE).filter(Boolean)
  if (words.length === 0) return 'U'

  if (words.length >= 2) {
    return (firstCodePoint(words[0]) + firstCodePoint(words[1])).toUpperCase()
  }

  return [...words[0]].slice(0, 2).join('').toUpperCase()
}

/**
 * The name to show beside (or instead of) the avatar.
 *
 * Falls back through: the profile row the sign-up trigger populated, then the
 * identity provider's own metadata, then the email address, then a neutral
 * word. It never returns an empty string — a blank name renders as a gap the
 * user cannot explain.
 *
 * @param {Record<string, any> | null | undefined} profile
 * @param {Record<string, any> | null | undefined} user
 * @returns {string}
 */
export function displayNameFrom(profile, user) {
  return (
    cleanName(profile?.full_name) ||
    cleanName(user?.user_metadata?.full_name) ||
    cleanName(user?.user_metadata?.name) ||
    cleanName(user?.email) ||
    'Account'
  )
}

/**
 * The uploaded profile picture, or null when there isn't one.
 *
 * Google puts it on `avatar_url`; some OIDC providers use `picture`. Returning
 * null rather than a placeholder URL is what lets the caller choose initials —
 * a broken <img> and "no image" are different states and only one of them
 * should produce a grey box.
 *
 * @param {Record<string, any> | null | undefined} user
 * @returns {string | null}
 */
export function avatarUrlFrom(user, profile) {
  const raw = profile?.avatar_url ?? user?.avatar_url ?? user?.user_metadata?.avatar_url ?? user?.user_metadata?.picture
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

// ---------------------------------------------------------------------------

function cleanName(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** "omar.negm@uni.edu" -> "omar negm", so the two-word rule applies to it. */
function localPart(email) {
  const cleaned = cleanName(email)
  if (!cleaned) return ''
  const local = cleaned.split('@')[0]
  // "omar.negm" and "omar_negm" both read as two words; treating the separator
  // as whitespace gets "ON" for those addresses instead of "OM".
  return local.replace(/[._-]+/g, ' ').trim()
}

function firstCodePoint(word) {
  return [...word][0] ?? ''
}
