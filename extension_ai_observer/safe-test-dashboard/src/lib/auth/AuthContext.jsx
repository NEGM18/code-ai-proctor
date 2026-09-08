// =============================================================================
// src/lib/auth/AuthContext.jsx
//
// Session context. React 19.2 + React Compiler is on: the value object below
// is NOT wrapped in useMemo/useCallback by hand — the compiler memoizes it
// from its actual dependencies (the pieces of `state`, plus the stable
// module-level function references from authService.js), which is exactly
// what "keep context values stable" means under the compiler. Hand-rolled
// memoization here would just be redundant work fighting the compiler.
// =============================================================================

import { useEffect, useState } from 'react'
import { supabase, isSupabaseConfigured, SUPABASE_UNCONFIGURED_REASON } from '../supabase.js'
import {
  createAvatarSignedUrl,
  fetchOwnProfile,
  sendEmailCode,
  signInWithGoogle,
  signInWithPassword,
  signOutCurrentUser,
  signUpWithRole,
  updateOwnProfile,
  verifyEmailCode,
} from './authService.js'
import { avatarUrlFrom } from '../profileIdentity.js'
import { redeemThisDevice } from './deviceTrust.js'
import {
  SESSION_STATE,
  isAnonymousSession,
  isVerifiedSession,
  sessionEmail,
  sessionState,
} from './session.js'
import { AuthContext } from './context.js'

const UNCONFIGURED_STATE = {
  loading: false,
  session: null,
  user: null,
  profile: null,
  profileError: null,
  avatarUrl: null,
  deviceTrusted: false,
}

/**
 * The picture to render for an account, resolved once here so the nav and the
 * dashboard can never disagree about it.
 *
 * ⚠ THE UPLOADED PICTURE OUTRANKS THE PROVIDER'S. `avatar_path` is a file the
 * student deliberately chose; `user_metadata.avatar_url` is whatever Google
 * happened to have. Resolving in the other order would make an upload look like
 * it silently did nothing for every account that signed in with Google.
 *
 * Signing can fail (expired session, deleted object) and that is not an error
 * worth surfacing — it returns null, and the caller falls back to initials.
 */
async function resolveAvatarUrl(user, profile) {
  const signed = await createAvatarSignedUrl(profile?.avatar_path)
  return signed ?? avatarUrlFrom(user, profile)
}

export function AuthProvider({ children }) {
  const [state, setState] = useState(() =>
    isSupabaseConfigured
      ? { ...UNCONFIGURED_STATE, loading: true }
      : UNCONFIGURED_STATE,
  )

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return

    let cancelled = false

    async function applySession(session) {
      if (session && isAnonymousSession(session)) {
        await signOutCurrentUser()
        if (!cancelled) {
          setState({ ...UNCONFIGURED_STATE, loading: false })
        }
        return
      }

      const user = session?.user ?? null
      if (!user) {
        if (!cancelled) {
          setState({ ...UNCONFIGURED_STATE, loading: false, session })
        }
        return
      }
      const result = await fetchOwnProfile(user.id)
      if (cancelled) return

      // ⚠ RE-REDEEMED ON EVERY LOAD, NOT JUST AT SIGN-IN. After a page reload
      // the JWT's `amr` is still [password] — device trust lives in a server-side
      // marker, not in the token — so without this the client would call a
      // session unverified that the database happily accepts, and the dashboard
      // would show "Sign in required" to someone who is fully signed in.
      // Idempotent server-side (upsert on session_id), and skipped entirely when
      // `amr` already proves verification, so it costs nothing for Google users.
      const deviceTrusted = isVerifiedSession(session)
        ? false
        : await redeemThisDevice(user.id)
      if (cancelled) return

      const profile = result.ok ? result.data : null
      // Awaited before the state write, so the avatar appears in the same paint
      // as the name. Resolving it afterwards would render initials first and
      // swap in the photo a beat later, which reads as a flicker on every load.
      const avatarUrl = await resolveAvatarUrl(user, profile)
      if (cancelled) return

      setState({
        loading: false,
        session,
        user,
        profile,
        profileError: result.ok ? null : result.reason,
        avatarUrl,
        deviceTrusted,
      })
    }

    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) applySession(data.session)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      applySession(session)
    })

    return () => {
      cancelled = true
      listener.subscription.unsubscribe()
    }
  }, [])

  const updateProfile = async ({ fullName, organizationName, avatarPath }) => {
    if (!state.user?.id) return { ok: false, reason: 'NO_USER' }

    const result = await updateOwnProfile({ userId: state.user.id, fullName, organizationName, avatarPath })
    if (!result.ok) return result

    // `result.data` is the row PostgREST echoed back, which is authoritative.
    // The spread is only for the no-op case where nothing was sent and there is
    // no returned row — patching each field individually keeps an untouched
    // column from being clobbered with `undefined`.
    const profile = result.data ?? {
      ...(state.profile ?? {}),
      ...(fullName !== undefined ? { full_name: fullName } : {}),
      ...(organizationName !== undefined ? { organization_name: organizationName } : {}),
      ...(avatarPath !== undefined ? { avatar_path: avatarPath } : {}),
    }

    // Re-signed rather than reused: the path may have changed format (png ->
    // jpg), and a cleared picture must fall back to the provider photo here
    // rather than leaving the previous signed URL on screen until reload.
    const avatarUrl = await resolveAvatarUrl(state.user, profile)
    setState(prev => ({ ...prev, profile, avatarUrl }))

    return result
  }

  const value = {
    configured: isSupabaseConfigured,
    unconfiguredReason: isSupabaseConfigured ? null : SUPABASE_UNCONFIGURED_REASON,
    loading: state.loading,
    session: state.session,
    user: state.user,
    profile: state.profile,
    profileError: state.profileError,
    // Ready to drop straight into an <img src>. Null means "no picture" — the
    // consumer renders initials rather than a broken image.
    avatarUrl: state.avatarUrl,

    // Two routes to the same answer, mirroring the two branches of
    // session_is_verified_human(): a mailbox-proving `amr`, or a redeemed device
    // marker for this session. Keeping both here is what stops the UI and the
    // database disagreeing about who is signed in.
    verified: isVerifiedSession(state.session) || state.deviceTrusted,
    deviceTrusted: state.deviceTrusted,
    sessionStatus: isSupabaseConfigured ? sessionState(state.session) : SESSION_STATE.SIGNED_OUT,
    pendingEmail: sessionEmail(state.session),

    signUp: signUpWithRole,
    signIn: signInWithPassword,
    signOut: signOutCurrentUser,
    signInWithGoogle,
    sendEmailCode,
    verifyEmailCode,
    updateProfile,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
