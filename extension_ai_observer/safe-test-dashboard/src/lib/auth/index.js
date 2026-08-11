// =============================================================================
// src/lib/auth/index.js — barrel export for this module's public surface.
// =============================================================================

export { AuthProvider } from './AuthContext.jsx'
export { AuthContext } from './context.js'
export { useAuth } from './useAuth.js'
export { ROLE, ROLE_VALUES, ROLE_LABELS, isValidRole } from './roles.js'
export {
  signUpWithRole,
  signInWithPassword,
  signInWithGoogle,
  sendEmailCode,
  verifyEmailCode,
  signOutCurrentUser,
  fetchOwnProfile,
  EMAIL_CODE_LENGTH,
  DEFAULT_OAUTH_REDIRECT_PATH,
} from './authService.js'
export {
  SESSION_STATE,
  VERIFIED_AMR_METHODS,
  isVerifiedSession,
  isAnonymousSession,
  sessionState,
  sessionEmail,
} from './session.js'
