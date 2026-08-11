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
  fetchOwnProfile,
  sendEmailCode,
  signInWithGoogle,
  signInWithPassword,
  signOutCurrentUser,
  signUpWithRole,
  verifyEmailCode,
} from './authService.js'
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
}

export function AuthProvider({ children }) {
  const [state, setState] = useState(() =>
    isSupabaseConfigured
      ? { loading: true, session: null, user: null, profile: null, profileError: null }
      : UNCONFIGURED_STATE,
  )

  useEffect(() => {
    // `isSupabaseConfigured` is derived once, at module load, from
    // import.meta.env — it cannot change for the lifetime of this
    // component, so the unconfigured case needs no effect at all: the
    // useState initializer above already set `UNCONFIGURED_STATE`.
    // Calling setState synchronously here just to re-assert the same value
    // would only add a redundant render (and trips
    // react-hooks/set-state-in-effect), so it's skipped entirely.
    if (!isSupabaseConfigured || !supabase) return

    let cancelled = false

    async function applySession(session) {
      // ---- evict any surviving anonymous session ----
      //
      // ⚠ THIS IS THE MIGRATION PATH FOR THE GUEST PROBLEM, NOT A TIDY-UP.
      // `persistSession: true` means every visitor who opened the demo before
      // this change still has a working anonymous token in localStorage, and it
      // stays valid until it expires. Without this, those visitors keep a
      // session that reads as signed-in to `useAuth()` while every RLS policy
      // now refuses it — the exact "UI says fine, server says no" split the
      // sign-in wall exists to prevent. Signing them out converts a stale guest
      // into a clean SIGNED_OUT visitor who is shown the wall.
      //
      // Fires at most once per stale token: signOut triggers onAuthStateChange
      // with a null session, which takes the branch below instead.
      if (session && isAnonymousSession(session)) {
        await signOutCurrentUser()
        if (!cancelled) {
          setState({ loading: false, session: null, user: null, profile: null, profileError: null })
        }
        return
      }

      const user = session?.user ?? null
      if (!user) {
        if (!cancelled) {
          setState({ loading: false, session, user: null, profile: null, profileError: null })
        }
        return
      }
      const result = await fetchOwnProfile(user.id)
      if (cancelled) return
      setState({
        loading: false,
        session,
        user,
        profile: result.ok ? result.data : null,
        // A profile fetch can fail (e.g. row not yet created by the
        // trigger, RLS misconfiguration on a fresh project) without that
        // being an authentication failure — the session is still real.
        profileError: result.ok ? null : result.reason,
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

  const value = {
    configured: isSupabaseConfigured,
    unconfiguredReason: isSupabaseConfigured ? null : SUPABASE_UNCONFIGURED_REASON,
    loading: state.loading,
    session: state.session,
    user: state.user,
    profile: state.profile,
    profileError: state.profileError,

    // ---- the demo's admission ticket ----
    //
    // ⚠ `verified` IS NOT `!!user`, AND CONFLATING THEM REOPENS THE HOLE.
    // A password-only session has a real `user` and is deliberately NOT
    // verified — the emailed code has not been entered yet, so its JWT lacks
    // the `amr` claim RLS requires. Every gate must read `verified`; a `user`
    // truthiness check would wave through exactly the sessions the second
    // factor exists to stop. See lib/auth/session.js.
    verified: isVerifiedSession(state.session),
    // Which of the four states, for the UI: "sign in", "you are a guest",
    // "enter the code we emailed" and "you're in" are four different messages.
    sessionStatus: isSupabaseConfigured ? sessionState(state.session) : SESSION_STATE.SIGNED_OUT,
    // The address a pending code should go to, so the code step never asks a
    // visitor to retype an address they have already proved they can spell.
    pendingEmail: sessionEmail(state.session),

    signUp: signUpWithRole,
    signIn: signInWithPassword,
    signOut: signOutCurrentUser,
    signInWithGoogle,
    sendEmailCode,
    verifyEmailCode,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
