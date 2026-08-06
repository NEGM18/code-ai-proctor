// =============================================================================
// src/lib/auth/index.js — barrel export for this module's public surface.
// =============================================================================

export { AuthProvider } from './AuthContext.jsx'
export { AuthContext } from './context.js'
export { useAuth } from './useAuth.js'
export { ROLE, ROLE_VALUES, ROLE_LABELS, isValidRole } from './roles.js'
export { signUpWithRole, signInWithPassword, signOutCurrentUser, fetchOwnProfile } from './authService.js'
