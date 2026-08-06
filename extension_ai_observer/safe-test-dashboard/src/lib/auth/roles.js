// =============================================================================
// src/lib/auth/roles.js
//
// The three sign-up roles per PLAN.md §5/§6. One source of truth so the
// sign-up form, authService.js, and the `role` SQL enum
// (supabase/migrations/20260804120000_roles_and_profiles.sql) never drift —
// if a fourth role is ever added, it must be added in exactly these two
// places (here, and the migration) or sign-up will reject it.
// =============================================================================

export const ROLE = Object.freeze({
  STUDENT: 'student',
  TEACHER: 'teacher',
  ORGANIZATION: 'organization',
})

export const ROLE_VALUES = Object.freeze([ROLE.STUDENT, ROLE.TEACHER, ROLE.ORGANIZATION])

/**
 * @param {unknown} role
 * @returns {role is 'student' | 'teacher' | 'organization'}
 */
export function isValidRole(role) {
  return typeof role === 'string' && ROLE_VALUES.includes(role)
}

export const ROLE_LABELS = Object.freeze({
  [ROLE.STUDENT]: 'Student',
  [ROLE.TEACHER]: 'Teacher',
  [ROLE.ORGANIZATION]: 'Organization',
})
