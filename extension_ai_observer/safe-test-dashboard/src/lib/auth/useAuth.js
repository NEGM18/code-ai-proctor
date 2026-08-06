// =============================================================================
// src/lib/auth/useAuth.js
// =============================================================================

import { useContext } from 'react'
import { AuthContext } from './context.js'

/**
 * @returns {{
 *   configured: boolean,
 *   unconfiguredReason: string | null,
 *   loading: boolean,
 *   session: import('@supabase/supabase-js').Session | null,
 *   user: import('@supabase/supabase-js').User | null,
 *   profile: Record<string, unknown> | null,
 *   profileError: string | null,
 *   signUp: typeof import('./authService.js').signUpWithRole,
 *   signIn: typeof import('./authService.js').signInWithPassword,
 *   signOut: typeof import('./authService.js').signOutCurrentUser,
 * }}
 */
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (ctx === undefined) {
    throw new Error('useAuth() must be called within an <AuthProvider>.')
  }
  return ctx
}
