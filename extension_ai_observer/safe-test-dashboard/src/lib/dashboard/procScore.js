// =============================================================================
// src/lib/dashboard/procScore.js
//
// ProcScore — a 0..100 integrity figure derived from the student's OWN
// proctor_sessions and violations rows. Pure: no Supabase, no React, no clock.
//
// ⚠ THE SCORE IS NULL WHEN THERE IS NOTHING TO SCORE, AND THAT IS THE WHOLE
// POINT OF THIS FILE.
//
// A student with zero proctored sittings has not earned 100 — they are
// UNMEASURED. Rendering 100 there is the single most tempting lie this product
// could tell: it looks generous, it looks like a nice empty state, and it is a
// fabricated reading presented beside real ones. This codebase's fourth verdict
// state exists precisely to refuse that (theme.css: "NEVER `0`, NEVER the
// last-known value"), so `score === null` propagates all the way to a hatched
// bar and an em-dash in the UI. Do not add a `?? 100` anywhere downstream.
//
// ⚠ EVERY DEDUCTION IS SHOWN, NOT JUST THE TOTAL. `deductions` returns the
// labelled segments that sum to `100 - score`, so the bar the student sees IS
// the arithmetic rather than a picture of it. An integrity score a student
// cannot audit is an accusation without evidence.
// =============================================================================

/**
 * What one violation costs, by severity.
 *
 * Calibrated against the severity taxonomy the engine actually emits (see the
 * extension's CLAUDE.md §6). The ratios matter more than the absolutes:
 * LOW is 1/12th of CRITICAL because a LOW event is defined as "recorded, not
 * escalated" — a 1.5–2.5 s look away. If a run of LOW events could sink a
 * score, the engine's deliberate decision not to escalate them would be undone
 * here, one layer up.
 */
export const SEVERITY_WEIGHT = Object.freeze({
  CRITICAL: 6,
  HIGH: 3,
  MEDIUM: 1.5,
  LOW: 0.5,
})

/**
 * Deductions are computed per session, then scaled by this, so the score
 * answers "how does a typical sitting go?" rather than "how many exams have you
 * taken?". Without the per-session normalisation a diligent student who sits 40
 * proctored exams would score worse than one who sat two, purely for showing up.
 *
 * At 6: one CRITICAL per sitting lands at 64 (high risk), one HIGH at 82
 * (moderate), one MEDIUM at 91 and one LOW at 97 (both still high trust).
 */
export const DEDUCTION_SCALE = 6

/** Below this many sittings the figure is real but noisy — say so, don't hide it. */
export const PROVISIONAL_BELOW_SESSIONS = 3

export const TRUST_BAND = Object.freeze({
  HIGH: 'HIGH',
  MODERATE: 'MODERATE',
  RISK: 'RISK',
  UNMEASURED: 'UNMEASURED',
})

export const TRUST_BAND_COPY = Object.freeze({
  [TRUST_BAND.HIGH]: {
    label: 'Verified safe',
    detail: 'High trust',
    token: 'verified',
  },
  [TRUST_BAND.MODERATE]: {
    label: 'Moderate risk',
    detail: 'Flagged warnings on record',
    token: 'glance',
  },
  [TRUST_BAND.RISK]: {
    label: 'High risk',
    detail: 'Multiple integrity flags',
    token: 'violation',
  },
  // ⚠ Uses the UNKNOWN token, not a fourth colour. "We have not measured you"
  // is the same claim the eye pipeline makes when it cannot read a frame, and
  // it should look identical wherever it appears.
  [TRUST_BAND.UNMEASURED]: {
    label: 'Not yet measured',
    detail: 'No proctored sittings on record',
    token: 'unknown',
  },
})

/**
 * The engine's own taxonomy, used when the stored `severity` column is null.
 *
 * ⚠ AN UNRECOGNISED TYPE FALLS BACK TO THE LIGHTEST WEIGHT, NOT THE HEAVIEST.
 * A violation type this table has never heard of is one this scorer cannot
 * reason about, and guessing CRITICAL would let a future detector silently
 * start destroying scores the day it ships. Erring light means a new detector
 * under-counts until someone adds it here — visible in the breakdown as a LOW
 * pile, and harmless to the student in the meantime.
 */
const TYPE_SEVERITY = Object.freeze({
  FULLSCREEN_EXIT: 'CRITICAL',
  SCREEN_SHARE_STOPPED: 'CRITICAL',
  PHONE_DETECTED: 'CRITICAL',
  LIVENESS_FAILED: 'CRITICAL',
  CAMERA_FEED_SYNTHETIC: 'CRITICAL',
  TAB_SWITCH: 'HIGH',
  VISIBILITY_HIDDEN: 'HIGH',
  AI_CHEATING_POSE: 'HIGH',
  AI_CHEATING_CLASSIFIER: 'HIGH',
  SECONDARY_DEVICE: 'HIGH',
  WINDOW_BLUR: 'MEDIUM',
  MULTIPLE_FACES: 'MEDIUM',
  NO_FACE_DETECTED: 'MEDIUM',
  GAZE_OFF_SCREEN: 'MEDIUM',
  SIDE_GAZE_PEEKING: 'MEDIUM',
  HEAD_POSE_GLANCE: 'LOW',
})

/**
 * @param {{ severity?: string | null, violation_type?: string | null }} violation
 * @returns {'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'}
 */
export function severityOf(violation) {
  const stored = typeof violation?.severity === 'string' ? violation.severity.toUpperCase() : ''
  if (stored in SEVERITY_WEIGHT) return /** @type {any} */ (stored)

  return TYPE_SEVERITY[violation?.violation_type] ?? 'LOW'
}

const BAND_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']

/**
 * @typedef {object} ProcScoreResult
 * @property {number | null} score          0..100, or null when unmeasured.
 * @property {string} band
 * @property {number} sessionCount
 * @property {number} violationCount
 * @property {number} cleanSessions         Sittings with zero violations.
 * @property {number | null} cleanRate      0..1, or null when unmeasured.
 * @property {boolean} provisional          Real, but from too few sittings.
 * @property {Array<{ severity: string, count: number, points: number }>} deductions
 *           Segments that sum to (100 - score). Empty when unmeasured.
 */

/**
 * @param {{ sessions?: Array<Record<string, any>>, violations?: Array<Record<string, any>> }} input
 * @returns {ProcScoreResult}
 */
export function computeProcScore({ sessions = [], violations = [] } = {}) {
  const sessionCount = sessions.length

  if (sessionCount === 0) {
    // See the file header: this is UNMEASURED, not perfect.
    return {
      score: null,
      band: TRUST_BAND.UNMEASURED,
      sessionCount: 0,
      violationCount: violations.length,
      cleanSessions: 0,
      cleanRate: null,
      provisional: false,
      deductions: [],
    }
  }

  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
  const flaggedSessionIds = new Set()

  for (const violation of violations) {
    counts[severityOf(violation)] += 1
    if (violation?.session_id) flaggedSessionIds.add(violation.session_id)
  }

  const deductions = BAND_ORDER.filter((severity) => counts[severity] > 0).map((severity) => ({
    severity,
    count: counts[severity],
    points: (counts[severity] * SEVERITY_WEIGHT[severity] * DEDUCTION_SCALE) / sessionCount,
  }))

  const rawPenalty = deductions.reduce((total, segment) => total + segment.points, 0)
  const score = clamp(Math.round(100 - rawPenalty), 0, 100)

  // A session is clean when nothing was reported against it. Violations whose
  // session_id is null (the extension can report before the sitting row lands)
  // cannot be attributed, so they lower the score without marking any single
  // sitting dirty — pinning them on an arbitrary session would be worse.
  const cleanSessions = sessions.filter((session) => !flaggedSessionIds.has(session?.id)).length

  return {
    score,
    band: bandFor(score),
    sessionCount,
    violationCount: violations.length,
    cleanSessions,
    cleanRate: cleanSessions / sessionCount,
    provisional: sessionCount < PROVISIONAL_BELOW_SESSIONS,
    deductions,
  }
}

/**
 * Band thresholds, exactly as specified: 90+ high trust, 70–89 moderate,
 * below 70 high risk.
 * @param {number | null} score
 */
export function bandFor(score) {
  if (score === null || !Number.isFinite(score)) return TRUST_BAND.UNMEASURED
  if (score >= 90) return TRUST_BAND.HIGH
  if (score >= 70) return TRUST_BAND.MODERATE
  return TRUST_BAND.RISK
}

/**
 * One sentence explaining the figure, built only from quantities that were
 * actually counted. Returns null when unmeasured — there is no honest sentence
 * to write about a student nobody has proctored, and inventing an encouraging
 * one ("You're off to a great start!") would assert exactly the thing the null
 * score refuses to.
 *
 * @param {ProcScoreResult} result
 * @returns {string | null}
 */
export function explainProcScore(result) {
  if (result.score === null) return null

  const sittings = `${result.sessionCount} proctored ${plural(result.sessionCount, 'session')}`

  if (result.violationCount === 0) {
    return `Based on ${sittings}: 100% clean rate, no flags recorded.`
  }

  const cleanPct = Math.round((result.cleanRate ?? 0) * 100)
  const parts = result.deductions.map(
    (segment) =>
      `${segment.count} ${segment.severity.toLowerCase()} ${plural(segment.count, 'flag')}`,
  )
  return `Based on ${sittings}: ${cleanPct}% clean rate, ${listJoin(parts)}.`
}

// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`
}

function listJoin(parts) {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}
