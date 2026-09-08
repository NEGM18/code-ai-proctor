// =============================================================================
// handshake_contract.test.js — the anti-drift guarantee two source files claim.
//
// `src/lib/proctor/handshake.js` and `extension/content/guest_bridge.js` both
// implement the SAME grading rule, and they must, because neither side can
// import the other: a content script runs in an isolated world with no access
// to the page's bundle, and the page has no access to the extension's. The rule
// is therefore written twice.
//
// ⚠ WHAT DRIFT ACTUALLY COSTS, WHICH IS WHY THIS FILE EXISTS AT ALL. The page
// computes a verdict for its own UI and telemetry; the extension INDEPENDENTLY
// re-derives one from the page's raw measurements and writes THAT to
// `proctor_sessions.timing_status`. If the two rules disagree, the row asserts
// something neither side measured — a candidate can be shown "on time" and
// recorded "late", or the reverse — and nothing in either codebase would
// report a fault. Both headers name this file as the thing that prevents it.
// Until it was written, that claim was decoration.
//
// The check is behavioural, not textual. It lifts `gradeHandshake` out of the
// extension source and runs it against the page's `evaluateHandshake` over a
// matrix of observations, including the cases where the ORDER of the branches
// is the only thing that distinguishes two answers.
// =============================================================================

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  HANDSHAKE_DEADLINE_MS,
  HANDSHAKE_REPLY,
  HANDSHAKE_REQUEST,
  LANDING_GRACE_MS,
  TIMING_STATUS,
  createHandshakeRequest,
  evaluateHandshake,
} from '../handshake.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// safe-test-dashboard/src/lib/proctor/__tests__ -> repo root -> extension/
const BRIDGE_PATH = resolve(HERE, '../../../../../extension/content/guest_bridge.js')

/**
 * ⚠ A MISSING BRIDGE IS A FAILURE, NOT A SKIP.
 *
 * The tempting alternative — `it.skipIf(!exists)` — turns a moved or deleted
 * file into a green run, which is the precise failure this suite exists to
 * prevent: the guarantee would evaporate at the moment it stopped being
 * checked, and the only signal would be one fewer passing test in a count
 * nobody reads. If this throws, either the extension tree is genuinely absent
 * (and the contract is unverifiable, which must be loud) or the path moved
 * (and this line is the fix).
 */
function readBridgeSource() {
  try {
    return readFileSync(BRIDGE_PATH, 'utf8')
  } catch (error) {
    throw new Error(
      `Cannot read the extension bridge at ${BRIDGE_PATH}. The page and the `
      + `extension each carry a copy of the handshake grading rule and this suite `
      + `is what keeps them identical; without the file the guarantee is void.`,
      { cause: error },
    )
  }
}

const BRIDGE_SOURCE = readBridgeSource()

/**
 * Slice one top-level `function name(...) { ... }` out of a source file by
 * matching braces.
 *
 * Crude on purpose. A parser would be more robust and would also happily keep
 * working through a rename, which is the opposite of what is wanted here: if
 * `gradeHandshake` is renamed or restructured, this must fail and a human must
 * look at both copies.
 */
function extractFunction(source, name) {
  const signature = `function ${name}(`
  const start = source.indexOf(signature)
  if (start === -1) {
    throw new Error(
      `guest_bridge.js no longer contains a top-level \`${signature}\`. If it was `
      + `renamed or inlined, this contract test must be updated to match — do not `
      + `delete the assertion, because the two copies of the rule still exist.`,
    )
  }

  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`Unbalanced braces while extracting ${name} from guest_bridge.js`)
}

/**
 * Compile the extension's grader in isolation.
 *
 * `_handshake` is the extension's own record of the exchange — the evidence it
 * holds that a live bridge in this document really did answer this nonce — and
 * it is injected rather than faked inside the function, because the whole
 * asymmetry between the two implementations lives in that variable. The page
 * compares `nonceEcho` against the nonce it SENT; the extension compares it
 * against the nonce it ANSWERED. For the two to be comparable at all, the
 * extension must be given a record of having answered the same nonce.
 */
function makeBridgeGrader() {
  const body = extractFunction(BRIDGE_SOURCE, 'gradeHandshake')
  // `new Function` is the point, not an oversight: the extension's copy of the
  // rule lives inside an IIFE in a file this bundle cannot import, so the only
  // way to exercise the REAL code — rather than a re-typed imitation of it,
  // which would drift in exactly the way this suite exists to catch — is to
  // compile the source text.
  const factory = new Function(
    '_handshake',
    'HANDSHAKE_DEADLINE_MS',
    `${body}; return gradeHandshake;`,
  )
  return (record, pageObs) => factory(record, HANDSHAKE_DEADLINE_MS)(pageObs)
}

const gradeOnBridge = makeBridgeGrader()

/**
 * Run one observation set through BOTH implementations.
 *
 * The extension is handed a record for the nonce it is supposed to have
 * answered; `replied: false` is modelled as the extension holding no record at
 * all, which is exactly what happens in the field — a bridge that never
 * answered has nothing published.
 */
function gradeBoth(obs) {
  const page = evaluateHandshake(obs)
  const record = obs.replied ? { nonce: obs.answeredNonce ?? obs.nonce } : null
  const bridge = gradeOnBridge(record, obs)
  return { page, bridge }
}

// ---------------------------------------------------------------------------
// 1. The constants must be literally the same numbers and strings.
// ---------------------------------------------------------------------------

describe('handshake constants agree across the page/extension boundary', () => {
  it('uses the same request and reply message types', () => {
    expect(BRIDGE_SOURCE).toContain(`const HANDSHAKE_REQUEST = '${HANDSHAKE_REQUEST}'`)
    expect(BRIDGE_SOURCE).toContain(`const HANDSHAKE_REPLY = '${HANDSHAKE_REPLY}'`)
  })

  it('uses the same 500 ms reply deadline', () => {
    expect(HANDSHAKE_DEADLINE_MS).toBe(500)
    expect(BRIDGE_SOURCE).toContain(`const HANDSHAKE_DEADLINE_MS = ${HANDSHAKE_DEADLINE_MS}`)
  })

  it('uses the same landing grace window', () => {
    // The bridge inlines this number inside gradeHandshake rather than naming
    // it. Asserted against the page's constant so raising one and not the other
    // is caught, since that mismatch would grade the SAME deep-link sitting
    // differently on each side.
    expect(LANDING_GRACE_MS).toBe(10000)
    expect(extractFunction(BRIDGE_SOURCE, 'gradeHandshake')).toContain(String(LANDING_GRACE_MS))
  })

  it('emits the same two timing verdicts', () => {
    expect(BRIDGE_SOURCE).toContain(`'${TIMING_STATUS.LATE_PROCTOR_ATTACH}'`)
    expect(BRIDGE_SOURCE).toContain(`'${TIMING_STATUS.ON_TIME_AT_QUIZ}'`)
  })
})

// ---------------------------------------------------------------------------
// 2. Behavioural equivalence over the whole decision surface.
// ---------------------------------------------------------------------------

const BASE = Object.freeze({
  replied: true,
  nonce: 'nonce-under-test',
  nonceEcho: 'nonce-under-test',
  latencyMs: 40,
  interactedBeforeReply: false,
  landedOnQuiz: false,
  sinceNavigationStartMs: 800,
})

const CASES = [
  {
    name: 'a clean exchange on first paint',
    obs: { ...BASE },
    status: TIMING_STATUS.ON_TIME_AT_QUIZ,
    reason: 'OK',
  },
  {
    name: 'nothing answered — usually no extension installed',
    obs: { ...BASE, replied: false, nonceEcho: null, latencyMs: Number.NaN },
    status: TIMING_STATUS.LATE_PROCTOR_ATTACH,
    reason: 'NO_REPLY',
  },
  {
    name: 'answered past the deadline',
    obs: { ...BASE, latencyMs: HANDSHAKE_DEADLINE_MS + 1 },
    status: TIMING_STATUS.LATE_PROCTOR_ATTACH,
    reason: 'SLOW_REPLY',
  },
  {
    name: 'exactly on the deadline still passes',
    obs: { ...BASE, latencyMs: HANDSHAKE_DEADLINE_MS },
    status: TIMING_STATUS.ON_TIME_AT_QUIZ,
    reason: 'OK',
  },
  {
    name: 'a stale or replayed reply carrying the wrong nonce',
    obs: { ...BASE, nonceEcho: 'some-other-nonce' },
    status: TIMING_STATUS.LATE_PROCTOR_ATTACH,
    reason: 'NONCE_MISMATCH',
  },
  {
    name: 'the candidate clicked or typed before the proctor answered',
    obs: { ...BASE, interactedBeforeReply: true },
    status: TIMING_STATUS.LATE_PROCTOR_ATTACH,
    reason: 'INTERACTION_FIRST',
  },
  {
    name: 'a deep link whose exchange finished long after the document loaded',
    obs: { ...BASE, landedOnQuiz: true, sinceNavigationStartMs: LANDING_GRACE_MS + 1 },
    status: TIMING_STATUS.LATE_PROCTOR_ATTACH,
    reason: 'LATE_MOUNT',
  },
  {
    name: 'a deep link inside the grace window',
    obs: { ...BASE, landedOnQuiz: true, sinceNavigationStartMs: LANDING_GRACE_MS - 1 },
    status: TIMING_STATUS.ON_TIME_AT_QUIZ,
    reason: 'OK',
  },
  {
    // ⚠ THE SINGLE-PAGE-APP EXEMPTION. Reading the marketing site for ten
    // minutes and then opening the exam is ONE document with a very old
    // timeOrigin. Neither side may grade that as a late attach.
    name: 'in-app navigation after a long browse is NOT late',
    obs: { ...BASE, landedOnQuiz: false, sinceNavigationStartMs: 10 * 60 * 1000 },
    status: TIMING_STATUS.ON_TIME_AT_QUIZ,
    reason: 'OK',
  },
  {
    name: 'an unmeasurable latency is treated as too slow, not as absent',
    obs: { ...BASE, latencyMs: Number.NaN },
    status: TIMING_STATUS.LATE_PROCTOR_ATTACH,
    reason: 'SLOW_REPLY',
  },
  {
    name: 'a deep link with an unmeasurable navigation age',
    obs: { ...BASE, landedOnQuiz: true, sinceNavigationStartMs: Number.NaN },
    status: TIMING_STATUS.LATE_PROCTOR_ATTACH,
    reason: 'LATE_MOUNT',
  },
]

describe('the page and the extension grade every case identically', () => {
  for (const testCase of CASES) {
    it(`${testCase.name} -> ${testCase.reason}`, () => {
      const { page, bridge } = gradeBoth(testCase.obs)

      expect(page.status).toBe(testCase.status)
      expect(page.reason).toBe(testCase.reason)

      // The contract itself: same verdict, same reason, same measured latency.
      expect(bridge.status).toBe(page.status)
      expect(bridge.reason).toBe(page.reason)
      expect(bridge.latencyMs).toBe(page.latencyMs)
    })
  }
})

// ---------------------------------------------------------------------------
// 3. Branch ORDER, which no single-fault case can pin.
//
// ⚠ EACH OF THESE HOLDS TWO FAULTS AT ONCE. Both implementations return on the
// first match, so which reason comes out is decided purely by the order the
// branches are written in — and a reordering would still pass every test above.
// ---------------------------------------------------------------------------

describe('branch order is part of the contract', () => {
  it('no reply outranks everything, even when every other field also fails', () => {
    const { page, bridge } = gradeBoth({
      ...BASE,
      replied: false,
      nonceEcho: 'wrong',
      latencyMs: 99999,
      interactedBeforeReply: true,
      landedOnQuiz: true,
      sinceNavigationStartMs: 99999,
    })
    // Reporting SLOW_REPLY here would send a reader hunting a performance
    // problem on a machine that has no extension at all.
    expect(page.reason).toBe('NO_REPLY')
    expect(bridge.reason).toBe('NO_REPLY')
  })

  it('a wrong nonce is reported ahead of a missed deadline', () => {
    const { page, bridge } = gradeBoth({
      ...BASE,
      nonceEcho: 'some-other-nonce',
      latencyMs: HANDSHAKE_DEADLINE_MS + 5000,
    })
    // The latency was measured against a request this reply is not an answer
    // to, so reporting it as SLOW_REPLY would report a meaningless quantity as
    // a finding.
    expect(page.reason).toBe('NONCE_MISMATCH')
    expect(bridge.reason).toBe('NONCE_MISMATCH')
  })

  it('a missed deadline is reported ahead of a prior interaction', () => {
    const { page, bridge } = gradeBoth({
      ...BASE,
      latencyMs: HANDSHAKE_DEADLINE_MS + 1,
      interactedBeforeReply: true,
    })
    expect(page.reason).toBe('SLOW_REPLY')
    expect(bridge.reason).toBe('SLOW_REPLY')
  })

  it('a prior interaction is reported ahead of a late mount', () => {
    const { page, bridge } = gradeBoth({
      ...BASE,
      interactedBeforeReply: true,
      landedOnQuiz: true,
      sinceNavigationStartMs: LANDING_GRACE_MS + 1,
    })
    expect(page.reason).toBe('INTERACTION_FIRST')
    expect(bridge.reason).toBe('INTERACTION_FIRST')
  })
})

// ---------------------------------------------------------------------------
// 4. The extension's own evidence outranks anything the page says.
// ---------------------------------------------------------------------------

describe('the extension never takes the page at its word', () => {
  it('grades LATE when it holds no record, however good the page numbers look', () => {
    // A page claiming a completed exchange the bridge has no memory of is
    // describing something that did not happen in this document. The page's own
    // evaluator says ON_TIME — correctly, from what it can see — and the
    // extension overrules it. This divergence is the one the contract ALLOWS.
    const perfect = { ...BASE }
    expect(evaluateHandshake(perfect).status).toBe(TIMING_STATUS.ON_TIME_AT_QUIZ)

    const bridge = gradeOnBridge(null, perfect)
    expect(bridge.status).toBe(TIMING_STATUS.LATE_PROCTOR_ATTACH)
    expect(bridge.reason).toBe('NO_REPLY')
  })

  it('rejects a reply echoing a nonce the bridge never answered', () => {
    const bridge = gradeOnBridge({ nonce: 'what-the-bridge-answered' }, {
      ...BASE,
      nonce: 'what-the-page-claims',
      nonceEcho: 'what-the-page-claims',
    })
    expect(bridge.reason).toBe('NONCE_MISMATCH')
  })

  it('ignores a status the page tries to report for itself', () => {
    // The value being recorded is a statement about the page's own honesty, so
    // a party under measurement must not be able to report its own result.
    const bridge = gradeOnBridge({ nonce: BASE.nonce }, {
      ...BASE,
      replied: false,
      status: TIMING_STATUS.ON_TIME_AT_QUIZ,
      reason: 'OK',
      nonceEcho: 'not-the-answered-nonce',
    })
    expect(bridge.status).toBe(TIMING_STATUS.LATE_PROCTOR_ATTACH)
  })
})

// ---------------------------------------------------------------------------
// 5. The nonce the page mints.
// ---------------------------------------------------------------------------

describe('createHandshakeRequest', () => {
  it('carries the request type, a nonce and a timestamp', () => {
    const request = createHandshakeRequest(1_700_000_000_000)
    expect(request.type).toBe(HANDSHAKE_REQUEST)
    expect(request.timestamp).toBe(1_700_000_000_000)
    expect(typeof request.nonce).toBe('string')
    expect(request.nonce.length).toBeGreaterThan(8)
  })

  it('mints a different nonce every time', () => {
    const seen = new Set()
    for (let i = 0; i < 50; i += 1) seen.add(createHandshakeRequest(1).nonce)
    // A repeated nonce would let one recorded reply satisfy a later challenge,
    // which is the whole property the exchange rests on.
    expect(seen.size).toBe(50)
  })

  it('reports whether the nonce came from a real CSPRNG', () => {
    // `strongNonce` travels with the request so telemetry can distinguish a
    // liveness check backed by crypto.randomUUID from the Math.random fallback,
    // rather than presenting both as the same guarantee.
    expect(typeof createHandshakeRequest(1).strongNonce).toBe('boolean')
  })

  it('is truncated to 128 chars by the bridge, so a long nonce still matches', () => {
    // guest_bridge.js slices the incoming nonce. A page minting something longer
    // than that would echo a truncated value and fail its own equality check.
    expect(createHandshakeRequest(1).nonce.length).toBeLessThanOrEqual(128)
  })
})
