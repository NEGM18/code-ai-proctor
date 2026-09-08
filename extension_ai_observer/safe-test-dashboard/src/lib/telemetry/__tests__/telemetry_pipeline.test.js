// =============================================================================
// telemetry_pipeline.test.js — what the AI/edge observability layer emits, what
// it refuses to emit, and the safety guard on feature flags.
//
// `./posthog.js` is mocked wholesale so these run under the default `node`
// environment and never load posthog-js. What is under test here is the SHAPE of
// what we hand the SDK, which is where the privacy decisions actually live.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const emitted = [];

vi.mock('../posthog.js', () => ({
  capture: (event, props) => { emitted.push({ event, props }); },
  log: (level, message, props) => { emitted.push({ event: 'log', props: { level, message, ...props } }); },
  flag: (key, fallback) => fallback,
  onFlagsReady: () => () => {},
  maybeShowSurvey: () => false,
}));

const {
  trackAiReview, trackEdgeRpc, trackUnseal, wrapReviewFlaggedSnapshot, AGREEMENT, __CONSTANTS,
} = await import('../pipeline.js');
const { captureProctorError, PIPELINE_STEP, __resetErrorState } = await import('../errors.js');
const { assertNotSafetyCritical, FLAGS, getFlag } = await import('../flags.js');

const OBSERVATION = 'The candidate is holding a phone near their face and looking down.';
const FRAME = 'data:image/jpeg;base64,/9j/4AAQ' + 'Z'.repeat(3000);

const find = (name) => emitted.filter((e) => e.event === name);
const wire = () => JSON.stringify(emitted);

beforeEach(() => {
  emitted.length = 0;
  __resetErrorState();
});

describe('AI review telemetry', () => {
  it("NEVER emits Gemini's observation sentence — only its length", () => {
    trackAiReview({ violationType: 'PHONE_DETECTED' }).settle({
      ok: true, reviewed: true, verdict: 'CHEATING', confidence: 96, observation: OBSERVATION,
    });

    expect(wire()).not.toContain('phone near their face');
    const ev = find('review_snapshot_settled')[0];
    expect(ev.props.observation).toBeUndefined();
    expect(ev.props.observation_length).toBe(OBSERVATION.length);
  });

  it('keeps the detector hypothesis and the verdict together — that pairing is the point', () => {
    trackAiReview({ violationType: 'SUSTAINED_LOOK_AWAY', severity: 'HIGH' }).settle({
      ok: true, reviewed: true, verdict: 'NOT_CHEATING', confidence: 40,
    });
    const p = find('review_snapshot_settled')[0].props;
    expect(p.violation_type).toBe('SUSTAINED_LOOK_AWAY');
    expect(p.verdict).toBe('NOT_CHEATING');
    expect(p.confidence).toBe(40);
    expect(p.agreement).toBe(AGREEMENT.REFUTED);
  });

  it('an unreviewed frame is UNREVIEWED, never an exoneration', () => {
    trackAiReview({ violationType: 'PHONE_DETECTED' }).settle({
      ok: true, reviewed: false, reason: 'BUDGET_EXHAUSTED',
    });
    expect(find('review_snapshot_settled')[0].props.agreement).toBe(AGREEMENT.UNREVIEWED);
  });

  it('early stop fires at exactly 95 and NOT at 94', () => {
    expect(__CONSTANTS.STOP_CONFIDENCE).toBe(95);

    trackAiReview({ violationType: 'PHONE_DETECTED' }).settle({
      ok: true, reviewed: true, verdict: 'CHEATING', confidence: 94,
    });
    expect(find('review_early_stop_triggered')).toHaveLength(0);
    expect(find('review_snapshot_settled')[0].props.early_stop_triggered).toBe(false);

    emitted.length = 0;
    trackAiReview({ violationType: 'PHONE_DETECTED' }).settle({
      ok: true, reviewed: true, verdict: 'CHEATING', confidence: 95,
    });
    expect(find('review_early_stop_triggered')).toHaveLength(1);
  });

  it('a high-confidence NOT_CHEATING does not early-stop', () => {
    trackAiReview({ violationType: 'PHONE_DETECTED' }).settle({
      ok: true, reviewed: true, verdict: 'NOT_CHEATING', confidence: 99,
    });
    expect(find('review_early_stop_triggered')).toHaveLength(0);
  });

  it('emits a budget-cap event for each server refusal reason', () => {
    for (const reason of ['BUDGET_EXHAUSTED', 'DAILY_LIMIT', 'BUDGET_CLOSED_CONFIRMED']) {
      emitted.length = 0;
      trackAiReview({}).settle({ ok: true, reviewed: false, reason });
      expect(find('review_budget_cap_exceeded'), reason).toHaveLength(1);
    }
  });

  it('settle() twice does NOT double-emit', () => {
    const t = trackAiReview({ violationType: 'PHONE_DETECTED' });
    t.settle({ ok: true, reviewed: true, verdict: 'CHEATING', confidence: 96 });
    t.settle({ ok: true, reviewed: true, verdict: 'CHEATING', confidence: 96 });
    expect(find('review_snapshot_settled')).toHaveLength(1);
    expect(find('review_early_stop_triggered')).toHaveLength(1);
  });

  it('hashes the sitting id rather than sending it raw', () => {
    trackAiReview({ sittingId: 'sitting-abc-123' }).settle({ ok: true, reviewed: false });
    const p = find('review_snapshot_settled')[0].props;
    expect(p.sitting_id).toMatch(/^h:[0-9a-f]{8}$/);
    expect(wire()).not.toContain('sitting-abc-123');
  });

  it('reports a finite, non-negative latency', () => {
    const t = trackAiReview({});
    t.settle({ ok: true, reviewed: true, verdict: 'CHEATING', confidence: 10 });
    const p = find('review_snapshot_settled')[0].props;
    // A wall-clock delta can go negative across an NTP step; a monotonic one
    // cannot. This pins the observable half of that choice.
    expect(Number.isFinite(p.latency_ms)).toBe(true);
    expect(p.latency_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('the review wrapper', () => {
  it('passes the frame through UNTOUCHED and never emits it', async () => {
    let seen = null;
    const wrapped = wrapReviewFlaggedSnapshot(async (args) => {
      seen = args.imageBase64;
      return {
        ok: true, reviewed: true, verdict: 'CHEATING', confidence: 96, observation: OBSERVATION,
      };
    });

    const result = await wrapped({
      imageBase64: FRAME, violationType: 'PHONE_DETECTED', demoSessionId: 's-1',
    });

    // The wrapped function receives the frame byte-for-byte.
    expect(seen).toBe(FRAME);
    // …and its return value comes back unchanged.
    expect(result.verdict).toBe('CHEATING');
    expect(result.observation).toBe(OBSERVATION);
    // …while nothing about the frame reaches telemetry beyond its length.
    expect(wire()).not.toContain('ZZZZZZZZZZ');
    expect(find('review_snapshot_settled')[0].props.image_length).toBe(FRAME.length);
  });

  it('still reports when the wrapped call throws, and re-throws', async () => {
    const wrapped = wrapReviewFlaggedSnapshot(async () => { throw new Error('edge down'); });
    await expect(wrapped({ imageBase64: FRAME })).rejects.toThrow('edge down');
    expect(find('review_snapshot_settled')[0].props.reason).toBe('CALL_FAILED');
  });
});

describe('edge + envelope telemetry', () => {
  it('emits kid and sig_alg but NEVER ek / iv / sha256', () => {
    trackUnseal({
      ok: false,
      reason: 'FORBIDDEN',
      status: 403,
      kid: '811fae083bc8dd0a',
      sigAlg: 'RSA-PSS-SHA256',
      envelopeBytes: 48210,
    });
    const p = find('edge_unseal_settled')[0].props;
    expect(p.kid).toBe('811fae083bc8dd0a');
    expect(p.sig_alg).toBe('RSA-PSS-SHA256');
    expect(p.signed).toBe(true);
    expect(p.reason).toBe('FORBIDDEN');
    expect(p.envelope_bytes).toBe(48210);
    // The three that must never appear are never constructed in the first place.
    expect(p.ek).toBeUndefined();
    expect(p.iv).toBeUndefined();
    expect(p.sha256).toBeUndefined();
  });

  it('records an unsigned envelope as unsigned — an auditable integrity fact', () => {
    trackUnseal({ ok: true, kid: 'deadbeefdeadbeef', sigAlg: 'none' });
    expect(find('edge_unseal_settled')[0].props.signed).toBe(false);
  });

  it('times an edge rpc and does not double-settle', () => {
    const t = trackEdgeRpc({ fn: 'unseal-snapshot' });
    t.settle({ ok: true, status: 200 });
    t.settle({ ok: true, status: 200 });
    expect(find('edge_rpc_settled')).toHaveLength(1);
    expect(find('edge_rpc_settled')[0].props.edge_function).toBe('unseal-snapshot');
  });
});

describe('error tracker', () => {
  it('scrubs a data: URL out of the message AND the stack', () => {
    const err = new Error('failed to seal ' + FRAME);
    err.stack = 'Error: boom\n    at seal (/home/runner/work/app/seal.js:12:3) ' + FRAME;
    captureProctorError(err, { step: PIPELINE_STEP.SEAL_ENVELOPE });

    expect(wire()).not.toContain('ZZZZZZZZZZ');
    const p = find('proctor_pipeline_error')[0].props;
    expect(p.pipeline_step).toBe('seal_envelope');
    expect(p.error_message).not.toContain('data:image');
  });

  it('strips absolute build paths so a fingerprint is machine-independent', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at f (/home/runner/work/procminds/src/x.js:1:1)';
    captureProctorError(err, { step: PIPELINE_STEP.MODEL_LOAD });
    const frames = find('proctor_pipeline_error')[0].props.stack_frames;
    expect(frames.join(' ')).not.toContain('/home/runner');
  });

  it('scrubs a bearer token out of an error message', () => {
    captureProctorError(new Error('401 with Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh.ijklmnop'), {
      step: PIPELINE_STEP.SUPABASE_REST,
    });
    expect(wire()).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('fingerprints stably across differing MESSAGES but differs across STEPS', () => {
    const mk = (msg) => {
      const e = new Error(msg);
      e.stack = 'Error\n    at tick (x.js:1:1)';
      return e;
    };
    const a = captureProctorError(mk('failed rid=aaaa'), { step: PIPELINE_STEP.EDGE_RPC });
    __resetErrorState();
    const b = captureProctorError(mk('failed rid=zzzz'), { step: PIPELINE_STEP.EDGE_RPC });
    __resetErrorState();
    const c = captureProctorError(mk('failed rid=aaaa'), { step: PIPELINE_STEP.MODEL_LOAD });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('records an UNREGISTERED step as-is rather than coercing it to unknown', () => {
    captureProctorError(new Error('x'), { step: 'a_step_nobody_declared' });
    const p = find('proctor_pipeline_error')[0].props;
    expect(p.pipeline_step).toBe('a_step_nobody_declared');
    expect(p.pipeline_step_unregistered).toBe(true);
  });

  it('rate-limits a repeating loop error instead of emitting 50 events', () => {
    const mk = () => {
      const e = new Error('tick failed');
      e.stack = 'Error\n    at tick (x.js:1:1)';
      return e;
    };
    for (let i = 0; i < 50; i += 1) captureProctorError(mk(), { step: PIPELINE_STEP.POSE_PIPELINE });
    expect(find('proctor_pipeline_error').length).toBeLessThan(10);
  });

  it('never throws, even when handed something that is not an Error', () => {
    expect(() => captureProctorError(null, {})).not.toThrow();
    expect(() => captureProctorError({ weird: true }, {})).not.toThrow();
    expect(() => captureProctorError('a bare string', {})).not.toThrow();
  });

  it('captures supabase_rest-style .reason and .cause', () => {
    const cause = new Error('connection failed');
    const err = new Error('request timed out');
    err.reason = 'SUPABASE_UNREACHABLE';
    err.cause = cause;
    captureProctorError(err, { step: PIPELINE_STEP.SUPABASE_REST });
    const p = find('proctor_pipeline_error')[0].props;
    expect(p.error_reason).toBe('SUPABASE_UNREACHABLE');
    expect(p.cause_message).toBe('connection failed');
  });
});

describe('feature flag safety guard', () => {
  it('REFUSES any flag naming a detection surface', () => {
    for (const key of [
      'phone-min-confidence', 'gaze_dwell_ms_v2', 'pose-threshold', 'ear_veto_allowlist',
      'detect_stride', 'suppression-rules', 'liveness_grace_ms', 'interleave-stride',
    ]) {
      expect(() => assertNotSafetyCritical(key), key + ' must be refused')
        .toThrow(/detection surface/);
    }
  });

  it('allows UI and telemetry flags', () => {
    for (const key of ['flag-review-beta', 'gaze-trace-readout', 'verbose-pipeline-telemetry']) {
      expect(() => assertNotSafetyCritical(key), key).not.toThrow();
    }
  });

  it('returns the local fallback when PostHog is absent', () => {
    expect(getFlag(FLAGS.FLAG_REVIEW_BETA)).toBe(false);
  });

  it('the registry is frozen, so a flag cannot be redefined at runtime', () => {
    expect(Object.isFrozen(FLAGS)).toBe(true);
    expect(Object.isFrozen(FLAGS.FLAG_REVIEW_BETA)).toBe(true);
  });

  it('every declared flag has an explicit fallback and a real description', () => {
    for (const decl of Object.values(FLAGS)) {
      expect(decl.fallback, decl.key).toBeDefined();
      expect(decl.description.length).toBeGreaterThan(10);
    }
  });
});
