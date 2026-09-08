// =============================================================================
// src/components/student/verdict.js
//
// The one place a verdict token name becomes Tailwind classes.
//
// ⚠ THIS EXISTS BECAUSE TAILWIND CANNOT BUILD CLASS NAMES AT RUNTIME. Writing
// `text-${token}` compiles to nothing — the scanner never sees the finished
// string, so the utility is never generated and the element renders unstyled,
// which for a verdict badge means a CRITICAL flag silently loses its red. Every
// combination is spelled out literally here so the scanner finds it.
//
// ⚠ VERDICT TOKENS ONLY (THEME.md §3). Everything in this map asserts something
// about what the camera saw. Chrome — buttons, tabs, the nav — uses brand cyan
// and must not reach in here for "a nice green".
// =============================================================================

/**
 * @type {Record<string, { text: string, bg: string, border: string, fill: string, glow: string }>}
 */
export const VERDICT_CLASSES = Object.freeze({
  verified: {
    text: 'text-verified',
    bg: 'bg-verified/10',
    border: 'border-verified/35',
    fill: 'bg-verified',
    glow: 'shadow-[0_0_28px_-6px_var(--color-verified)]',
  },
  glance: {
    text: 'text-glance',
    bg: 'bg-glance/10',
    border: 'border-glance/35',
    fill: 'bg-glance',
    glow: 'shadow-[0_0_28px_-6px_var(--color-glance)]',
  },
  violation: {
    text: 'text-violation',
    bg: 'bg-violation/10',
    border: 'border-violation/35',
    fill: 'bg-violation',
    glow: 'shadow-[0_0_28px_-6px_var(--color-violation)]',
  },
  suppressed: {
    text: 'text-suppressed',
    bg: 'bg-suppressed/10',
    border: 'border-suppressed/35',
    fill: 'bg-suppressed',
    glow: 'shadow-[0_0_28px_-6px_var(--color-suppressed)]',
  },
  unknown: {
    text: 'text-unknown',
    bg: 'bg-unknown/10',
    border: 'border-unknown/35',
    fill: 'bg-unknown',
    // ⚠ No glow. theme.css: the unknown hatch "must never sit inside a glow,
    // because a glowing hatch reads as an active measurement rather than the
    // absence of one."
    glow: '',
  },
})

/** @param {string} token */
export function verdict(token) {
  return VERDICT_CLASSES[token] ?? VERDICT_CLASSES.unknown
}

/**
 * Severity -> verdict token, for the deduction ledger and the flag counts.
 *
 * LOW maps to `unknown` rather than to a fourth colour: a LOW event is recorded
 * and deliberately not escalated, so painting it in a warning colour would
 * contradict the engine's own decision one layer down.
 */
export const SEVERITY_TOKEN = Object.freeze({
  CRITICAL: 'violation',
  HIGH: 'violation',
  MEDIUM: 'glance',
  LOW: 'unknown',
})
