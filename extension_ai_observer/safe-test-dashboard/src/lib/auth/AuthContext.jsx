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
import { fetchOwnProfile, signInWithPassword, signOutCurrentUser, signUpWithRole } from './authService.js'
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
    signUp: signUpWithRole,
    signIn: signInWithPassword,
    signOut: signOutCurrentUser,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
