// =============================================================================
// procScore + identity + evidence — the pure rules the dashboard rests on.
//
// The load-bearing check is the FIRST one: an account with no sittings must
// score `null`, not 100. Everything downstream branches off that null to render
// a hatch instead of a number, so if it ever goes green against a `?? 100` the
// whole "refuses to fabricate a reading" property collapses silently into a
// very reassuring lie.
// =============================================================================

import { describe, expect, it } from 'vitest'

import {
  DEDUCTION_SCALE,
  SEVERITY_WEIGHT,
  TRUST_BAND,
  bandFor,
  computeProcScore,
  explainProcScore,
  severityOf,
} from '../procScore.js'
import { avatarUrlFrom, displayNameFrom, initialsFrom } from '../../profileIdentity.js'
import { EVIDENCE_CLASS, EVIDENCE_SOURCE, classifyViolation, sourceOf } from '../evidence.js'
import { CLASS_INTEGRITY, integrityStatusFor, proctoredHours } from '../studentData.js'

const sessions = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}` }))

describe('computeProcScore — the unmeasured case', () => {
  it('scores null, NOT 100, when there are no sittings', () => {
    const result = computeProcScore({ sessions: [], violations: [] })
    expect(result.score).toBeNull()
    expect(result.band).toBe(TRUST_BAND.UNMEASURED)
    expect(result.deductions).toEqual([])
  })

  it('stays null even if violations exist without any session row', () => {
    const result = computeProcScore({
      sessions: [],
      violations: [{ violation_type: 'PHONE_DETECTED', severity: 'CRITICAL' }],
    })
    expect(result.score).toBeNull()
    // The count is still reported — "flags but no sittings" is a real state,
    // and hiding it would be its own omission.
    expect(result.violationCount).toBe(1)
  })

  it('has no sentence to write about an unmeasured account', () => {
    expect(explainProcScore(computeProcScore({ sessions: [], violations: [] }))).toBeNull()
  })
})

describe('computeProcScore — a clean record', () => {
  it('is 100 only when sittings exist and nothing was reported', () => {
    const result = computeProcScore({ sessions: sessions(12), violations: [] })
    expect(result.score).toBe(100)
    expect(result.band).toBe(TRUST_BAND.HIGH)
    expect(result.cleanSessions).toBe(12)
    expect(result.cleanRate).toBe(1)
    expect(explainProcScore(result)).toBe(
      'Based on 12 proctored sessions: 100% clean rate, no flags recorded.',
    )
  })
})

describe('computeProcScore — calibration', () => {
  // One flag per sitting, at each severity. These four numbers are the whole
  // calibration argument behind DEDUCTION_SCALE; if they move, the bands move.
  it.each([
    ['CRITICAL', 64, TRUST_BAND.RISK],
    ['HIGH', 82, TRUST_BAND.MODERATE],
    ['MEDIUM', 91, TRUST_BAND.HIGH],
    ['LOW', 97, TRUST_BAND.HIGH],
  ])('one %s per sitting scores %i', (severity, expected, band) => {
    const result = computeProcScore({
      sessions: sessions(4),
      violations: sessions(4).map((s) => ({ session_id: s.id, severity })),
    })
    expect(result.score).toBe(expected)
    expect(result.band).toBe(band)
  })

  it('normalises by session count, so volume alone cannot lower a score', () => {
    const few = computeProcScore({
      sessions: sessions(2),
      violations: [{ session_id: 's0', severity: 'HIGH' }],
    })
    const many = computeProcScore({
      sessions: sessions(20),
      violations: Array.from({ length: 10 }, (_, i) => ({ session_id: `s${i}`, severity: 'HIGH' })),
    })
    // Same rate (one HIGH every two sittings) -> same score.
    expect(few.score).toBe(many.score)
  })

  it('clamps at 0 rather than going negative', () => {
    const result = computeProcScore({
      sessions: sessions(1),
      violations: Array.from({ length: 40 }, () => ({ session_id: 's0', severity: 'CRITICAL' })),
    })
    expect(result.score).toBe(0)
  })

  it('deductions sum to exactly what was subtracted from 100', () => {
    const result = computeProcScore({
      sessions: sessions(5),
      violations: [
        { session_id: 's0', severity: 'CRITICAL' },
        { session_id: 's1', severity: 'MEDIUM' },
        { session_id: 's1', severity: 'LOW' },
      ],
    })
    const total = result.deductions.reduce((sum, d) => sum + d.points, 0)
    expect(Math.round(100 - total)).toBe(result.score)
  })
})

describe('computeProcScore — clean session attribution', () => {
  it('counts a sitting as flagged only when a violation names it', () => {
    const result = computeProcScore({
      sessions: sessions(4),
      violations: [{ session_id: 's0', severity: 'MEDIUM' }],
    })
    expect(result.cleanSessions).toBe(3)
  })

  it('does not blame any sitting for a violation with no session_id', () => {
    const result = computeProcScore({
      sessions: sessions(4),
      violations: [{ session_id: null, severity: 'MEDIUM' }],
    })
    // It still costs score, but marks no individual sitting dirty.
    expect(result.cleanSessions).toBe(4)
    expect(result.score).toBeLessThan(100)
  })
})

describe('severityOf', () => {
  it('prefers the stored severity column', () => {
    expect(severityOf({ severity: 'critical', violation_type: 'HEAD_POSE_GLANCE' })).toBe('CRITICAL')
  })

  it('falls back to the engine taxonomy when severity is null', () => {
    expect(severityOf({ severity: null, violation_type: 'PHONE_DETECTED' })).toBe('CRITICAL')
    expect(severityOf({ severity: null, violation_type: 'HEAD_POSE_GLANCE' })).toBe('LOW')
  })

  it('falls back LIGHT, not heavy, for an unrecognised type', () => {
    // A future detector must not be able to destroy scores just by existing.
    expect(severityOf({ violation_type: 'SOME_FUTURE_DETECTOR' })).toBe('LOW')
    expect(SEVERITY_WEIGHT.LOW).toBeLessThan(SEVERITY_WEIGHT.CRITICAL)
  })
})

describe('bandFor — the specified thresholds', () => {
  it.each([
    [100, TRUST_BAND.HIGH],
    [90, TRUST_BAND.HIGH],
    [89, TRUST_BAND.MODERATE],
    [70, TRUST_BAND.MODERATE],
    [69, TRUST_BAND.RISK],
    [0, TRUST_BAND.RISK],
  ])('%i is %s', (score, band) => {
    expect(bandFor(score)).toBe(band)
  })

  it('treats null and NaN as unmeasured, never as risk', () => {
    expect(bandFor(null)).toBe(TRUST_BAND.UNMEASURED)
    expect(bandFor(Number.NaN)).toBe(TRUST_BAND.UNMEASURED)
  })
})

describe('initialsFrom — the product rule', () => {
  it('takes one letter per word for a multi-word name', () => {
    expect(initialsFrom('Omar Negm')).toBe('ON')
  })

  it('takes TWO letters when there is only one word', () => {
    expect(initialsFrom('Omar')).toBe('OM')
  })

  it('uses only the first two words of a longer name', () => {
    expect(initialsFrom('Omar Adel Negm')).toBe('OA')
  })

  it('falls back to the email local part, splitting on separators', () => {
    expect(initialsFrom('', 'omar.negm@uni.edu')).toBe('ON')
    expect(initialsFrom(null, 'omar@uni.edu')).toBe('OM')
  })

  it('never returns an empty string', () => {
    expect(initialsFrom(null, null)).toBe('U')
    expect(initialsFrom('   ', '  ')).toBe('U')
  })

  it('does not split a surrogate pair in half', () => {
    // One astral code point plus an ASCII letter -> the whole glyph survives.
    expect([...initialsFrom('𝒪mar')].length).toBe(2)
  })
})

describe('displayNameFrom / avatarUrlFrom', () => {
  it('prefers the profile row, then provider metadata, then the email', () => {
    expect(displayNameFrom({ full_name: 'Omar Negm' }, { email: 'x@y.z' })).toBe('Omar Negm')
    expect(displayNameFrom(null, { user_metadata: { name: 'Omar' } })).toBe('Omar')
    expect(displayNameFrom(null, { email: 'x@y.z' })).toBe('x@y.z')
    expect(displayNameFrom(null, null)).toBe('Account')
  })

  it('returns null for a missing or blank avatar rather than an empty string', () => {
    expect(avatarUrlFrom(null)).toBeNull()
    expect(avatarUrlFrom({ user_metadata: { avatar_url: '   ' } })).toBeNull()
    expect(avatarUrlFrom({ user_metadata: { picture: 'https://x/y.png' } })).toBe('https://x/y.png')
  })
})

describe('evidence classification', () => {
  it('calls a snapshot with no violation CLEAN', () => {
    expect(classifyViolation(null)).toBe(EVIDENCE_CLASS.CLEAN)
  })

  it('maps the focus-loss family to a claim the sensors support', () => {
    // Deliberately NOT "DevTools" — nothing here detects developer tools.
    expect(classifyViolation({ violation_type: 'TAB_SWITCH' })).toBe(EVIDENCE_CLASS.FOCUS_EXIT)
    expect(classifyViolation({ violation_type: 'FULLSCREEN_EXIT' })).toBe(EVIDENCE_CLASS.FOCUS_EXIT)
  })

  it.each([
    ['GAZE_OFF_SCREEN', EVIDENCE_CLASS.GAZE],
    ['MULTIPLE_FACES', EVIDENCE_CLASS.MULTIPLE_FACES],
    ['PHONE_DETECTED', EVIDENCE_CLASS.PHONE],
    ['LIVENESS_FAILED', EVIDENCE_CLASS.SPOOFING],
  ])('%s classifies as %s', (type, expected) => {
    expect(classifyViolation({ violation_type: type })).toBe(expected)
  })

  it('decides demo-vs-exam from the session, not the storage path', () => {
    expect(sourceOf({ session_code: 'PHYS201' })).toBe(EVIDENCE_SOURCE.EXAM)
    expect(sourceOf(null)).toBe(EVIDENCE_SOURCE.DEMO)
    expect(sourceOf({ session_code: null })).toBe(EVIDENCE_SOURCE.DEMO)
  })
})

describe('proctoredHours', () => {
  it('returns null, not 0, when no sitting has both endpoints', () => {
    expect(
      proctoredHours([{ proctor_started_at: '2026-08-12T09:00:00Z', ended_at: null }]).hours,
    ).toBeNull()
  })

  it('sums only the sittings it could measure, and says how many', () => {
    const result = proctoredHours([
      { proctor_started_at: '2026-08-12T09:00:00Z', ended_at: '2026-08-12T10:30:00Z' },
      { proctor_started_at: '2026-08-12T11:00:00Z', ended_at: null },
    ])
    expect(result.hours).toBeCloseTo(1.5, 5)
    expect(result.measuredSessions).toBe(1)
    expect(result.totalSessions).toBe(2)
  })

  it('ignores a sitting whose end precedes its start', () => {
    expect(
      proctoredHours([
        { proctor_started_at: '2026-08-12T10:00:00Z', ended_at: '2026-08-12T09:00:00Z' },
      ]).hours,
    ).toBeNull()
  })
})

describe('integrityStatusFor', () => {
  it('is UNMEASURED, not SAFE, for a class with no sittings', () => {
    expect(integrityStatusFor({ sittings: 0, flagged: 0, hasCritical: false })).toBe(
      CLASS_INTEGRITY.UNMEASURED,
    )
  })

  it('escalates a critical flag above an ordinary one', () => {
    expect(integrityStatusFor({ sittings: 3, flagged: 1, hasCritical: false })).toBe(
      CLASS_INTEGRITY.FLAGGED,
    )
    expect(integrityStatusFor({ sittings: 3, flagged: 1, hasCritical: true })).toBe(
      CLASS_INTEGRITY.WARNING,
    )
  })

  it('is SAFE only with sittings and no flags', () => {
    expect(integrityStatusFor({ sittings: 3, flagged: 0, hasCritical: false })).toBe(
      CLASS_INTEGRITY.SAFE,
    )
  })
})

describe('constants stay coherent', () => {
  it('severity weights are strictly ordered', () => {
    expect(SEVERITY_WEIGHT.CRITICAL).toBeGreaterThan(SEVERITY_WEIGHT.HIGH)
    expect(SEVERITY_WEIGHT.HIGH).toBeGreaterThan(SEVERITY_WEIGHT.MEDIUM)
    expect(SEVERITY_WEIGHT.MEDIUM).toBeGreaterThan(SEVERITY_WEIGHT.LOW)
  })

  it('one critical per sitting lands below the risk threshold', () => {
    // Pins the relationship between the scale and the band boundary.
    expect(100 - SEVERITY_WEIGHT.CRITICAL * DEDUCTION_SCALE).toBeLessThan(70)
  })
})
