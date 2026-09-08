// =============================================================================
// src/lib/dashboard/studentData.js
//
// Every read the student dashboard makes. One file so there is exactly one
// place that knows which tables exist, and one place that decides what a
// failure means.
//
// GOVERNING RULE, inherited from lib/demoSnapshots.js and PLAN.md §7: when
// something is unavailable, say which thing and why. Never return an empty
// array a component will render as "you have a clean record" — an empty result
// and a refused query look identical on screen and mean opposite things. Every
// function here returns `{ ok, reason, ... }` and components branch on `reason`
// rather than on emptiness.
//
// ⚠ CLASSROOMS MAY NOT BE PROVISIONED. `classrooms` / `enrollments` ship in
// supabase/migrations/20260812120000_classrooms_and_enrollments.sql, which a
// given deployment may not have applied. PostgREST answers a missing table with
// 42P01 / PGRST205, and `isMissingRelation()` turns that into NOT_PROVISIONED
// so the UI can say "this deployment has no classrooms yet" instead of "you are
// enrolled in nothing". Those are different sentences and only one is true.
// =============================================================================

import { supabase, isSupabaseConfigured, DEMO_SNAPSHOTS_BUCKET } from '../supabase.js'
import { buildEvidenceCard, buildEvidenceCardFromViolation } from './evidence.js'


export const DATA_REASON = Object.freeze({
  SUPABASE_UNCONFIGURED: 'SUPABASE_UNCONFIGURED',
  NOT_SIGNED_IN: 'NOT_SIGNED_IN',
  /** The classrooms migration has not been applied to this project. */
  NOT_PROVISIONED: 'NOT_PROVISIONED',
  QUERY_FAILED: 'QUERY_FAILED',
  /** Join-by-code specifically: no classroom carries that code. */
  UNKNOWN_CODE: 'UNKNOWN_CODE',
  ALREADY_ENROLLED: 'ALREADY_ENROLLED',
})

/** How long a snapshot's signed URL stays valid. Long enough to browse a
 *  gallery, short enough that a copied link is not a permanent leak. */
const SIGNED_URL_TTL_SECONDS = 60 * 30

const STORAGE_PAGE_SIZE = 100

/**
 * PostgREST's two ways of saying "that relation does not exist". 42P01 is
 * Postgres's own undefined_table; PGRST205 is the schema-cache miss PostgREST
 * returns before it has ever seen the table.
 */
function isMissingRelation(error) {
  return (
    error?.code === '42P01' ||
    error?.code === 'PGRST205' ||
    error?.code === '404' ||
    error?.status === 404 ||
    (typeof error?.message === 'string' && error.message.toLowerCase().includes('not found'))
  )
}

function guard(userId) {
  if (!isSupabaseConfigured || !supabase) return DATA_REASON.SUPABASE_UNCONFIGURED
  if (!userId) return DATA_REASON.NOT_SIGNED_IN
  return null
}

// ---------------------------------------------------------------------------
// 1. The record: sittings and flags.
// ---------------------------------------------------------------------------

/**
 * Both own-row tables, in parallel.
 *
 * ⚠ THE `.eq('student_id', …)` IS AN INDEX HINT, NOT THE CONTROL. RLS
 * (`violations_own_rw`, `proctor_sessions_own_rw`) is what actually scopes
 * these, and it also requires `session_is_verified_human()`. Removing the
 * filter would change nothing about what comes back; removing the policy would
 * change everything. See 20260810120000_verified_session_gate.sql.
 *
 * @param {string | null | undefined} userId
 */
export async function fetchStudentRecord(userId) {
  const blocked = guard(userId)
  if (blocked) return { ok: false, reason: blocked, sessions: [], violations: [] }

  const [sessionsResult, violationsResult] = await Promise.all([
    supabase
      .from('proctor_sessions')
      .select(
        'id, session_code, timing_status, quiz_opened_at, proctor_started_at, ended_at, created_at',
      )
      .eq('student_id', userId)
      .order('created_at', { ascending: false }),
    supabase
      .from('violations')
      // The `ai_*` / `snapshot_sealed` columns arrive with
      // 20260816120000_ai_review_and_sealed_evidence.sql. Selected explicitly
      // rather than with `*` for the usual reason — a select list is a contract
      // — but note the coupling: a deployment that has not applied that
      // migration gets a 42703 here, which surfaces as QUERY_FAILED and so as
      // "your record could not be loaded", rather than as a fabricated clean
      // record. That is the correct direction to fail, and it is why FlagReview
      // distinguishes load-failure from empty.
      .select(
        'id, session_id, violation_type, severity, ear, ear_checked, snapshot_path, ' +
        'created_at, demo_session_id, ai_verdict, ai_reviewed_at, cheat_probability, ' +
        'cheat_reason, snapshot_sealed',
      )
      .eq('student_id', userId)
      .order('created_at', { ascending: false }),
  ])

  if (sessionsResult.error || violationsResult.error) {
    return {
      ok: false,
      reason: DATA_REASON.QUERY_FAILED,
      error: sessionsResult.error ?? violationsResult.error,
      sessions: [],
      violations: [],
    }
  }

  return {
    ok: true,
    reason: null,
    sessions: sessionsResult.data ?? [],
    violations: violationsResult.data ?? [],
  }
}

/**
 * Total proctored time, in hours.
 *
 * ⚠ RETURNS null WHEN NO SITTING HAS BOTH ENDPOINTS, RATHER THAN 0. A session
 * still running, or one whose `ended_at` never landed because the tab was
 * closed, has no duration — and "0 hours proctored" is a factual claim that
 * would be wrong. `measuredSessions` reports how many sittings actually
 * contributed, so the UI can qualify the figure instead of implying it covers
 * every one of them.
 *
 * @param {Array<Record<string, any>>} sessions
 * @returns {{ hours: number | null, measuredSessions: number, totalSessions: number }}
 */
export function proctoredHours(sessions = []) {
  let totalMs = 0
  let measured = 0

  for (const session of sessions) {
    const start = Date.parse(session?.proctor_started_at ?? session?.quiz_opened_at ?? '')
    const end = Date.parse(session?.ended_at ?? '')
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    totalMs += end - start
    measured += 1
  }

  return {
    hours: measured === 0 ? null : totalMs / 3_600_000,
    measuredSessions: measured,
    totalSessions: sessions.length,
  }
}

// ---------------------------------------------------------------------------
// 2. Evidence snapshots.
// ---------------------------------------------------------------------------

/**
 * In-flight unseal for a specific violation's sealed snapshot.
 * Calls the unseal-snapshot Edge Function which verifies ownership and decrypts
 * the PMSEAL1 envelope on demand.
 *
 * @param {string} violationId
 * @param {string} [snapshotPath]
 * @returns {Promise<{ ok: boolean, dataUrl?: string, error?: unknown, reason?: string }>}
 */
export async function unsealEvidenceSnapshot(violationId, snapshotPath) {
  if (!isSupabaseConfigured || !supabase) return { ok: false, reason: DATA_REASON.SUPABASE_UNCONFIGURED }
  if (!violationId && !snapshotPath) return { ok: false, reason: 'MISSING_ID' }

  try {
    const res = await supabase.functions.invoke('unseal-snapshot', {
      body: { violationId, snapshotPath },
    })
    if (res.data) {
      return res.data
    }
    if (res.error) {
      const detail = res.error.message || 'Decryption unavailable'
      return { ok: false, reason: detail, error: res.error }
    }
    return { ok: false, reason: 'EMPTY_RESPONSE' }
  } catch (error) {
    return { ok: false, reason: error?.message || 'REQUEST_FAILED', error }
  }
}


/**
 * Lists the student's evidence snapshots directly from verified violation records.
 *
 * @param {string | null | undefined} userId
 * @param {{ violations?: Array<Record<string, any>>, sessions?: Array<Record<string, any>> }} record
 */
export async function fetchEvidence(userId, { violations = [], sessions = [] } = {}) {
  const blocked = guard(userId)
  if (blocked) return { ok: false, reason: blocked, cards: [] }

  const sessionsById = new Map(sessions.map((session) => [session.id, session]))

  // Filter violations that have sealed snapshots or snapshot paths
  const evidenceViolations = violations.filter(
    (v) => v?.snapshot_path || v?.snapshot_sealed || (v?.ai_verdict === 'CHEATING' && v?.cheat_probability)
  )

  const cards = evidenceViolations.map((violation) =>
    buildEvidenceCardFromViolation({
      violation,
      sessionsById,
    }),
  )

  return { ok: true, reason: null, cards }
}


// ---------------------------------------------------------------------------
// 3. Classrooms.
// ---------------------------------------------------------------------------

export const CLASS_INTEGRITY = Object.freeze({
  UNMEASURED: 'UNMEASURED',
  SAFE: 'SAFE',
  FLAGGED: 'FLAGGED',
  WARNING: 'WARNING',
})

export const CLASS_INTEGRITY_COPY = Object.freeze({
  // ⚠ Not "safe". A class you have never sat an exam in has produced no
  // evidence either way, and the UNKNOWN token is how this codebase says so —
  // the same rule as a null ProcScore.
  [CLASS_INTEGRITY.UNMEASURED]: { label: 'No sittings yet', token: 'unknown' },
  [CLASS_INTEGRITY.SAFE]: { label: 'Safe in all exams', token: 'verified' },
  [CLASS_INTEGRITY.FLAGGED]: { label: 'Flags recorded', token: 'glance' },
  [CLASS_INTEGRITY.WARNING]: { label: 'Warning issued', token: 'violation' },
})

/** @returns {string} one of CLASS_INTEGRITY */
export function integrityStatusFor({ sittings, flagged, hasCritical }) {
  if (sittings === 0) return CLASS_INTEGRITY.UNMEASURED
  if (hasCritical) return CLASS_INTEGRITY.WARNING
  if (flagged > 0) return CLASS_INTEGRITY.FLAGGED
  return CLASS_INTEGRITY.SAFE
}

/**
 * The classes this student has joined, each with the student's own flag count
 * inside it.
 *
 * ⚠ THE INTEGRITY STATUS IS COMPUTED FROM THE STUDENT'S OWN ROWS ONLY, AND
 * CANNOT BE ANYTHING ELSE. A "peer flags recorded" status would require reading
 * other students' violations, which RLS refuses by design — `violations_own_rw`
 * scopes to `auth.uid()`, and the roles migration explains at length why no
 * blanket cross-student read exists. Each card therefore reports the holder's
 * own record in that class and asserts nothing about anybody else's.
 *
 * The link from a sitting to a class is `proctor_sessions.session_code =
 * classrooms.join_code` — already how the extension labels a sitting, so this
 * needs no new column on proctor_sessions.
 *
 * @param {string | null | undefined} userId
 * @param {{ sessions?: Array<Record<string, any>>, violations?: Array<Record<string, any>> }} record
 */
export async function fetchClassrooms(userId, { sessions = [], violations = [] } = {}) {
  const blocked = guard(userId)
  if (blocked) return { ok: false, reason: blocked, classrooms: [] }

  const { data, error } = await supabase
    .from('enrollments')
    .select(
      'joined_at, classroom:classrooms(id, name, join_code, teacher_name, subject, active_exam_code)',
    )
    .eq('student_id', userId)
    .order('joined_at', { ascending: false })

  if (error) {
    return {
      ok: false,
      reason: isMissingRelation(error) ? DATA_REASON.NOT_PROVISIONED : DATA_REASON.QUERY_FAILED,
      error,
      classrooms: [],
    }
  }

  const violationsBySession = new Map()
  for (const violation of violations) {
    if (!violation?.session_id) continue
    const bucket = violationsBySession.get(violation.session_id) ?? []
    bucket.push(violation)
    violationsBySession.set(violation.session_id, bucket)
  }

  const classrooms = (data ?? [])
    // A row whose classroom was deleted comes back with a null embed; rendering
    // it would be a card with no name on it.
    .filter((row) => row?.classroom)
    .map((row) => {
      const classroom = row.classroom
      const mine = sessions.filter((session) => session.session_code === classroom.join_code)
      const mineFlagged = mine.filter((session) => violationsBySession.has(session.id))
      const hasCritical = mineFlagged.some((session) =>
        (violationsBySession.get(session.id) ?? []).some(
          (v) => String(v.severity ?? '').toUpperCase() === 'CRITICAL',
        ),
      )

      return {
        ...classroom,
        joinedAt: row.joined_at,
        sittings: mine.length,
        flaggedSittings: mineFlagged.length,
        integrity: integrityStatusFor({
          sittings: mine.length,
          flagged: mineFlagged.length,
          hasCritical,
        }),
      }
    })

  return { ok: true, reason: null, classrooms }
}

/**
 * Join a class by the code an instructor handed out.
 *
 * ⚠ GOES THROUGH AN RPC, NOT A SELECT-THEN-INSERT. A client-side lookup would
 * need SELECT on every classroom row to find one by code, which hands any
 * signed-in account the ability to enumerate every class on the platform — the
 * same enumeration hazard the roles migration refuses for profiles.
 * `join_classroom()` is SECURITY DEFINER: it resolves exactly one code, inserts
 * exactly the caller's own enrollment, and returns nothing else.
 *
 * @param {string} code
 */
export async function joinClassroom(code) {
  if (!isSupabaseConfigured || !supabase) {
    return { ok: false, reason: DATA_REASON.SUPABASE_UNCONFIGURED, classroom: null }
  }

  const trimmed = String(code ?? '')
    .trim()
    .toUpperCase()
  if (!trimmed) return { ok: false, reason: DATA_REASON.UNKNOWN_CODE, classroom: null }

  const { data, error } = await supabase.rpc('join_classroom', { p_code: trimmed })

  if (error) {
    return {
      ok: false,
      reason: isMissingRelation(error) ? DATA_REASON.NOT_PROVISIONED : DATA_REASON.QUERY_FAILED,
      error,
      classroom: null,
    }
  }

  // The function returns zero rows for an unrecognised code rather than
  // raising: a thrown exception would be indistinguishable from a network
  // failure at this call site, and "no such code" is a normal answer a student
  // should see as a form message, not an error banner.
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return { ok: false, reason: DATA_REASON.UNKNOWN_CODE, classroom: null }

  return {
    ok: true,
    reason: row.already_enrolled ? DATA_REASON.ALREADY_ENROLLED : null,
    classroom: row,
  }
}
