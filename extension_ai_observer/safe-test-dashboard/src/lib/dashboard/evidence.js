// =============================================================================
// src/lib/dashboard/evidence.js
//
// Turning a stored snapshot into a card: which sitting it belongs to, and what
// the engine concluded on the frame it was taken from. Pure — no Supabase, no
// React — so the classification is testable and has exactly one definition.
//
// ⚠ "VERIFIED CLEAN" IS A CLAIM, AND IT IS ONLY MADE WHEN NOTHING WAS REPORTED.
// A snapshot with no matching violation row is evidence the pipeline captured a
// frame and raised nothing against it. Letting a failed lookup fall into that
// same bucket would render an absent record as an exoneration — the mirror
// image of the fabricated-reading problem procScore.js refuses.
// =============================================================================

import { severityOf } from './procScore.js'

export const EVIDENCE_CLASS = Object.freeze({
  CLEAN: 'CLEAN',
  GAZE: 'GAZE',
  MULTIPLE_FACES: 'MULTIPLE_FACES',
  PHONE: 'PHONE',
  FOCUS_EXIT: 'FOCUS_EXIT',
  SPOOFING: 'SPOOFING',
  OTHER: 'OTHER',
})

/**
 * Badge copy and which verdict token paints it.
 *
 * ⚠ `token` VALUES ARE VERDICT-RAMP NAMES (THEME.md §3) — every badge here does
 * assert something about what the camera saw, so the ramp is the correct source.
 * This is the one part of the dashboard where those tokens are legitimate.
 */
export const EVIDENCE_CLASS_COPY = Object.freeze({
  [EVIDENCE_CLASS.CLEAN]: { label: 'Verified clean', token: 'verified' },
  [EVIDENCE_CLASS.GAZE]: { label: 'Gaze violation', token: 'glance' },
  [EVIDENCE_CLASS.MULTIPLE_FACES]: { label: 'Multiple faces', token: 'violation' },
  [EVIDENCE_CLASS.PHONE]: { label: 'Phone detected', token: 'violation' },
  // ⚠ NOT "DevTools attempt". Nothing in this product detects developer tools.
  // What it detects is the exam losing focus — a tab switch, a blur, fullscreen
  // being exited — which is the family that label was reaching for. Calling it
  // "DevTools" would put a specific technical accusation on a student's record
  // that no sensor in this system can support.
  [EVIDENCE_CLASS.FOCUS_EXIT]: { label: 'Left the exam window', token: 'violation' },
  [EVIDENCE_CLASS.SPOOFING]: { label: 'Liveness failed', token: 'violation' },
  [EVIDENCE_CLASS.OTHER]: { label: 'Flag recorded', token: 'glance' },
})

const TYPE_CLASS = Object.freeze({
  GAZE_OFF_SCREEN: EVIDENCE_CLASS.GAZE,
  SIDE_GAZE_PEEKING: EVIDENCE_CLASS.GAZE,
  HEAD_POSE_GLANCE: EVIDENCE_CLASS.GAZE,
  AI_CHEATING_POSE: EVIDENCE_CLASS.GAZE,
  AI_CHEATING_CLASSIFIER: EVIDENCE_CLASS.GAZE,
  MULTIPLE_FACES: EVIDENCE_CLASS.MULTIPLE_FACES,
  NO_FACE_DETECTED: EVIDENCE_CLASS.MULTIPLE_FACES,
  PHONE_DETECTED: EVIDENCE_CLASS.PHONE,
  SECONDARY_DEVICE: EVIDENCE_CLASS.PHONE,
  TAB_SWITCH: EVIDENCE_CLASS.FOCUS_EXIT,
  WINDOW_BLUR: EVIDENCE_CLASS.FOCUS_EXIT,
  VISIBILITY_HIDDEN: EVIDENCE_CLASS.FOCUS_EXIT,
  FULLSCREEN_EXIT: EVIDENCE_CLASS.FOCUS_EXIT,
  SCREEN_SHARE_STOPPED: EVIDENCE_CLASS.FOCUS_EXIT,
  LIVENESS_FAILED: EVIDENCE_CLASS.SPOOFING,
  CAMERA_FEED_SYNTHETIC: EVIDENCE_CLASS.SPOOFING,
})

/**
 * @param {Record<string, any> | null | undefined} violation
 * @returns {string} one of EVIDENCE_CLASS
 */
export function classifyViolation(violation) {
  if (!violation) return EVIDENCE_CLASS.CLEAN
  return TYPE_CLASS[violation.violation_type] ?? EVIDENCE_CLASS.OTHER
}

/** Where a snapshot came from. The gallery's two tabs. */
export const EVIDENCE_SOURCE = Object.freeze({
  DEMO: 'DEMO',
  EXAM: 'EXAM',
})

/**
 * Which kind of sitting a snapshot belongs to.
 *
 * ⚠ DECIDED BY THE SESSION, NOT THE PATH. Every object lives under
 * `demo/{auth.uid()}/…` whatever produced it — that prefix is fixed by the
 * storage RLS policy, not by the feature. A classroom sitting is distinguished
 * by its `proctor_sessions` row carrying a `session_code`; the live demo has no
 * code. Reading the prefix instead would file every exam capture under "demo".
 *
 * @param {Record<string, any> | null | undefined} session
 * @returns {string} one of EVIDENCE_SOURCE
 */
export function sourceOf(session) {
  return session?.session_code ? EVIDENCE_SOURCE.EXAM : EVIDENCE_SOURCE.DEMO
}

/**
 * Assemble one gallery card directly from a violation record.
 *
 * @param {object} input
 * @param {Record<string, any>} input.violation
 * @param {Map<string, Record<string, any>>} [input.sessionsById]
 * @param {string | null} [input.url]
 */
export function buildEvidenceCardFromViolation({ violation, sessionsById = new Map(), url = null }) {
  const session = violation?.session_id ? (sessionsById.get(violation.session_id) ?? null) : null
  const isExam = !!(session?.session_code || violation?.session_id)
  
  let label = 'Live demo'
  if (session?.session_code) {
    label = `Exam · ${session.session_code}`
  } else if (isExam) {
    label = 'Classroom exam'
  }

  return {
    id: violation.id,
    violationId: violation.id,
    path: violation.snapshot_path ?? null,
    url,
    capturedAt: violation.created_at ?? null,
    evidenceClass: classifyViolation(violation),
    source: isExam ? EVIDENCE_SOURCE.EXAM : EVIDENCE_SOURCE.DEMO,
    label,
    severity: severityOf(violation),
    violationType: violation.violation_type ?? null,
    aiVerdict: violation.ai_verdict ?? null,
    cheatReason: violation.cheat_reason ?? null,
    cheatProbability: violation.cheat_probability != null ? Number(violation.cheat_probability) : null,
    snapshotSealed: violation.snapshot_sealed === true,
  }
}

/**
 * Assemble one gallery card.
 *
 * @param {object} input
 * @param {{ path: string, url: string | null, createdAt: string | null }} input.object
 * @param {Map<string, Record<string, any>>} input.violationsByPath
 * @param {Map<string, Record<string, any>>} input.sessionsById
 */
export function buildEvidenceCard({ object, violationsByPath, sessionsById }) {
  const violation = violationsByPath.get(object.path) ?? null
  const session = violation?.session_id ? (sessionsById.get(violation.session_id) ?? null) : null

  // ⚠ The timestamp comes from the violation when there is one. Storage's
  // `created_at` is when the upload landed, which can trail the captured frame
  // by seconds on a slow link — and what matters here is when the engine SAW
  // it, not when the network finished carrying it.
  const capturedAt = violation?.created_at ?? object.createdAt ?? null

  return {
    id: violation?.id ?? object.path,
    violationId: violation?.id ?? null,
    path: object.path,
    url: object.url,
    capturedAt,
    evidenceClass: classifyViolation(violation),
    source: sourceOf(session),
    label: session?.session_code ? `Exam · ${session.session_code}` : 'Live demo',
    severity: violation ? severityOf(violation) : null,
    violationType: violation?.violation_type ?? null,
    aiVerdict: violation?.ai_verdict ?? null,
    cheatReason: violation?.cheat_reason ?? null,
    cheatProbability: violation?.cheat_probability != null ? Number(violation.cheat_probability) : null,
    snapshotSealed: violation?.snapshot_sealed === true,
  }
}

