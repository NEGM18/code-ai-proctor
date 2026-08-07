// =============================================================================
// demo_engine.test.js — PLAN.md §6 Phase 4.
//
// 30 SIMULATED SECONDS, IN MILLISECONDS. No camera, no WASM, no real timers.
//
// Every external dependency of ProctorDemoEngine is injected — `landmarkSource`,
// `now`, `schedule`/`cancel`, `captureSnapshot` — and `tickOnce(nowMs)` neither
// schedules nor touches the DOM. That is what makes the safety properties below
// assertable at all: the analysers, the veto gate and the reporting choke point
// are the REAL ones, and only the clock and the pixels are doubles.
//
// ⚠ WHAT THIS FILE IS ACTUALLY GUARDING. The browser is the first environment in
// which this math has ever executed (PLAN.md §1) — upstream `pose.onnx` is
// COCO-17, so EAR was never computable and no eye detector could fire. Blink
// immunity held VACUOUSLY there. Here it has to hold for real, and the failure
// mode is silent in both directions:
//
//   - Suppress too much and the demo looks calm while nothing works.
//   - Suppress too little and closed eyes produce an accusation, which is the
//     original defect this entire codebase was built to make structurally
//     impossible.
//
// Neither shows up as an error. Only these assertions distinguish them.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { ProctorDemoEngine, VIOLATION, DEFAULT_HEAD_OPTS } from '../demo_engine.js';
// ⚠ PLAN.md §6: adapters live in `src/vision/adapters/`, not the vision root.
import { ScriptedLandmarkSource } from '../adapters/landmark_source.js';
import { VETO_REASON, NEVER_VETOABLE } from '../ear_veto.js';
import {
  syntheticFace,
  toNormalizedLandmarks,
  scriptedFrames,
  measuredHeadYawRatio,
} from '../testing/synthetic_face.js';

const W = 640;
const H = 480;
const DT = 66;        // the engine's own DEFAULT_INTERVAL_MS — ~15 fps.
const T0 = 1000;
/** 456 ticks * 66 ms = 30 030 ms. The "30 seconds" of every claim below. */
const TICKS_30S = Math.ceil(30_000 / DT) + 1;

/** A video the engine considers ready. readyState 4 = HAVE_ENOUGH_DATA. */
const READY_VIDEO = { readyState: 4, videoWidth: W, videoHeight: H };

/**
 * One synthetic frame, in the NORMALISED space MediaPipe actually emits.
 *
 * ⚠ `pose: {}` is not optional decoration. Without it the fixture carries only
 * the ten gaze indices, `faceToCocoPerson` rejects the partial projection, and
 * the head channel R2 exists to provide silently does nothing — personCount 0,
 * calibration never starts. A test built on that fixture would exercise a
 * different engine and pass.
 *
 * ⚠ And it is NORMALISED, not pixel. The engine calls `toPixelLandmarks(face,
 * w, h)` on whatever the source hands it, so a pixel-space fixture fed straight
 * in would multiply 200 px by 640 and yield finite, plausible, wrong numbers.
 */
const frame = (opts = {}) => toNormalizedLandmarks(syntheticFace({ pose: {}, ...opts }), W, H);

/**
 * Drive N ticks of simulated time through a real engine.
 * @returns {{engine, violations, suppressions, frames, last, source}}
 */
function drive({ builder, count = TICKS_30S, multiFaceAt, captureSnapshot = () => 'snap', engineOpts }) {
  const source = new ScriptedLandmarkSource(
    scriptedFrames({ builder, count, dtMs: DT, t0: T0 }),
    { w: W, h: H, multiFaceAt },
  );
  const engine = new ProctorDemoEngine({ landmarkSource: source, captureSnapshot, ...engineOpts });
  engine.attachVideo(READY_VIDEO);

  const violations = [];
  const suppressions = [];
  const frames = [];
  engine.on('violation', (r) => violations.push(r));
  engine.on('suppressed', (r) => suppressions.push(r));
  engine.on('frame', (f) => frames.push(f));

  let last = null;
  for (let i = 0; i < count; i++) last = engine.tickOnce(T0 + i * DT);

  return { engine, violations, suppressions, frames, last, source };
}

/** `TYPE/SEVERITY`, so a failure names what fired rather than showing a diff. */
const names = (violations) => violations.map((v) => `${v.type}/${v.severity}`);

/** An engine with no script, for exercising the choke point directly. */
function chokePointEngine() {
  const engine = new ProctorDemoEngine({
    landmarkSource: new ScriptedLandmarkSource([]),
    captureSnapshot: () => 'snap',
  });
  engine.video = READY_VIDEO;
  const violations = [];
  const suppressions = [];
  engine.on('violation', (r) => violations.push(r));
  engine.on('suppressed', (r) => suppressions.push(r));
  return { engine, violations, suppressions };
}

// =============================================================================
// 1. THE GOVERNING PROPERTY — 30 s of closed eyes, zero accusations
// =============================================================================

describe('30 s at ear 0.05 — the closed-eye veto, end to end', () => {
  const run = drive({ builder: () => frame({ ear: 0.05 }) });

  it('emits ZERO violations across 30 simulated seconds', () => {
    expect(names(run.violations)).toEqual([]);
  });

  it('⚠ and reaches that answer by the analyser REFUSING, not by the veto mopping up', () => {
    // This is the assertion that stops the test from lying to itself. At EAR
    // 0.05 the gaze analyser's own `ear < 0.20` gate fires first, so it never
    // emits an event and the veto is never consulted: zero suppressions is
    // CORRECT here, and a nonzero count would mean the first line of defence had
    // stopped working while the second silently covered for it.
    //
    // The consequence for coverage is real and worth stating: the veto's own
    // allowlist/cooldown behaviour cannot be reached through the camera path at
    // all, which is why it is exercised directly further down — exactly the
    // shape upstream ear_veto.test.js and blink_immunity.test.js use.
    expect(run.suppressions.length).toBe(0);
    expect(run.last.gaze.reason).toBe('EYE_CLOSED');
    expect(Number.isFinite(run.last.gaze.hRatio)).toBe(false);
  });

  it('⚠ publishes a REAL EAR to FrameState — the _readEar regression pin', () => {
    // PLAN.md §6: `_readEar` once read `veto.telemetry().lastEar`, a field
    // EarVetoGate does not expose. It returned null on EVERY frame and the EAR
    // gauge — the one component that shows the blink-immunity safeguard doing
    // its work — was permanently hatched.
    //
    // NOTHING FAILED. "Unknown" is a state PLAN.md §7 explicitly endorses, so a
    // dead gauge reads as honest degradation rather than a typo; lint, all 297
    // tests and the build were green across it. Asserting the field merely
    // EXISTS reproduces that hole, so this asserts the VALUE.
    expect(run.last.ear).not.toBe(null);
    expect(run.last.ear).toBeCloseTo(0.05, 10);
  });

  it('stays silent with the eyes shut AND the irises hard over (h: 0.95)', () => {
    // The adversarial pairing: geometry that would read as an extreme side gaze
    // if anything were willing to read it. Nothing is.
    const hard = drive({ builder: () => frame({ ear: 0.05, h: 0.95 }) });
    expect(names(hard.violations)).toEqual([]);
    expect(hard.violations.length + hard.suppressions.length).toBe(0);
  });
});

// =============================================================================
// 2. BLINK IMMUNITY IS NOT AN OFF SWITCH — NEVER_VETOABLE still fires
// =============================================================================

describe('NEVER_VETOABLE types fire at ear 0.05, asserted by name', () => {
  it('MULTIPLE_FACES fires end-to-end through the camera path with the eyes shut', () => {
    // A second person in the room is a second person whether or not the student
    // blinked. Reachable end-to-end because both faces keep feeding the veto a
    // fresh closed-eye sample right up to the frame that reports.
    const run = drive({ builder: () => frame({ ear: 0.05 }), multiFaceAt: () => true });

    expect(names(run.violations)).toEqual(['MULTIPLE_FACES/MEDIUM']);
    // It went THROUGH the gate rather than around it: the gate was consulted,
    // saw a genuinely closed eye, and declined to suppress on type alone.
    expect(run.violations[0].ear).toBeCloseTo(0.05, 10);
    expect(run.violations[0].earChecked).toBe(VETO_REASON.NOT_VETOABLE);
  });

  it('NO_FACE_DETECTED, MULTIPLE_FACES and PHONE_DETECTED all report at the choke point', () => {
    // ⚠ NO_FACE_DETECTED is the sharpest case in the whole design: covering the
    // camera destroys the landmarks, so vetoing it would turn camera-covering
    // into a way to silence the detector built to catch camera-covering.
    // Asserted BY NAME, because a typo in the allowlist fails in exactly the
    // direction that matters and produces no error.
    const { engine } = chokePointEngine();
    engine.veto.submitLandmarks(syntheticFace({ ear: 0.05, pose: {} }), T0);

    for (const type of ['NO_FACE_DETECTED', 'MULTIPLE_FACES', 'PHONE_DETECTED']) {
      expect(NEVER_VETOABLE).toContain(type);
      expect(engine._reportViolation(type, 'MEDIUM', T0, null)).not.toBe(null);
    }
  });
});

// =============================================================================
// 3. NO_FACE_DETECTED — "we could not see" reported on its own evidence
// =============================================================================

describe('NO_FACE_DETECTED', () => {
  const run = drive({ builder: (i) => (i < 150 ? frame({}) : null) });

  it('fires once the face disappears mid-session', () => {
    expect(names(run.violations)).toEqual(['NO_FACE_DETECTED/MEDIUM']);
  });

  it('the frame state degrades honestly rather than holding the last reading', () => {
    // PLAN.md §7: every failure path sets the readable value to null and the UI
    // renders a hatch — never 0, never the last-known value.
    expect(run.last.readable).toBe(false);
    expect(run.last.faceCount).toBe(0);
    expect(run.last.ear).toBe(null);
  });

  it('a not-ready video is UNREADABLE, and still ages the veto out', () => {
    // "We could not see" is not "the student did something". The null submit is
    // what ages the sample out — skipping it would let one good reading license
    // suppression forever, just because the camera stalled.
    const source = new ScriptedLandmarkSource(
      scriptedFrames({ builder: () => frame({}), count: 5, dtMs: DT, t0: T0 }),
      { w: W, h: H },
    );
    const engine = new ProctorDemoEngine({ landmarkSource: source });
    engine.attachVideo({ readyState: 1, videoWidth: W, videoHeight: H });

    const submits = [];
    const realSubmit = engine.veto.submitLandmarks.bind(engine.veto);
    engine.veto.submitLandmarks = (pts, t) => { submits.push(pts); return realSubmit(pts, t); };

    const state = engine.tickOnce(T0);

    expect(state.readable).toBe(false);
    expect(state.reason).toBe('VIDEO_NOT_READY');
    expect(submits).toEqual([null]);
    // The detector was never consulted — an unready video is not a frame.
    expect(source.detectCount).toBe(0);
  });
});

// =============================================================================
// 4. THE CHOKE POINT — veto strictly before cooldown
// =============================================================================

describe('_reportViolation — veto runs BEFORE the cooldown is claimed', () => {
  it('a suppressed violation does not burn its type slot; the same geometry reports 100 ms later', () => {
    // monitor.js:512. If the veto consumed the cooldown, a student who blinked
    // during a genuine side-peek would buy themselves 4 s of silence — the gate
    // built to protect them turned into an exploit.
    const { engine, violations, suppressions } = chokePointEngine();

    engine.veto.submitLandmarks(syntheticFace({ ear: 0.05, pose: {} }), T0);
    const vetoed = engine._reportViolation(VIOLATION.SIDE_GAZE_PEEKING, 'MEDIUM', T0, null);

    engine.veto.submitLandmarks(syntheticFace({ ear: 0.30, pose: {} }), T0 + 100);
    const reported = engine._reportViolation(VIOLATION.SIDE_GAZE_PEEKING, 'MEDIUM', T0 + 100, null);

    expect(vetoed).toBe(null);
    expect(reported).not.toBe(null);
    expect(reported.earChecked).toBe(VETO_REASON.EYES_OPEN);
    expect(reported.ear).toBeCloseTo(0.30, 10);

    // The suppression is SURFACED, not swallowed — it is what the demo's
    // suppression lane renders as the safeguard visibly working.
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0].reason).toBe(VETO_REASON.EYE_CLOSED);
    expect(suppressions[0].ear).toBeCloseTo(0.05, 10);
    expect(violations).toHaveLength(1);
  });

  it('the cooldown IS claimed by a report, and does silence the repeat', () => {
    const { engine } = chokePointEngine();
    engine.veto.submitLandmarks(syntheticFace({ ear: 0.30, pose: {} }), T0);

    expect(engine._reportViolation(VIOLATION.SIDE_GAZE_PEEKING, 'MEDIUM', T0, null)).not.toBe(null);
    expect(engine._reportViolation(VIOLATION.SIDE_GAZE_PEEKING, 'MEDIUM', T0 + 100, null)).toBe(null);
    // ...until it expires. DEFAULT_COOLDOWN_MS = 4000.
    engine.veto.submitLandmarks(syntheticFace({ ear: 0.30, pose: {} }), T0 + 4000);
    expect(engine._reportViolation(VIOLATION.SIDE_GAZE_PEEKING, 'MEDIUM', T0 + 4000, null)).not.toBe(null);
  });
});

// =============================================================================
// 5 + 6. ORDERING WITHIN A TICK
// =============================================================================

describe('tick ordering', () => {
  /** A session that produces exactly one real violation: an isolated side gaze. */
  const gazeBuilder = (i) => frame(i < 230 ? {} : { h: 0.25 });

  it('⚠ captureSnapshot runs inside the SAME tick that emits', () => {
    // Deferring the capture — to a microtask, an rAF, an await — photographs an
    // empty desk. The evidence has to be the frame that caused the report.
    const log = [];
    const source = new ScriptedLandmarkSource(
      scriptedFrames({ builder: gazeBuilder, count: TICKS_30S, dtMs: DT, t0: T0 }),
      { w: W, h: H },
    );
    const engine = new ProctorDemoEngine({
      landmarkSource: source,
      captureSnapshot: () => { log.push('snapshot'); return 'snap'; },
    });
    engine.attachVideo(READY_VIDEO);
    engine.on('violation', () => log.push('violation'));

    for (let i = 0; i < TICKS_30S; i++) {
      log.push('tick');
      engine.tickOnce(T0 + i * DT);
    }

    const at = log.indexOf('violation');
    expect(at).toBeGreaterThan(0);
    expect(log[at - 1]).toBe('snapshot');   // immediately before, same tick
    expect(log[at - 2]).toBe('tick');       // and no tick boundary between them
  });

  it('⚠ submitLandmarks precedes every _reportViolation within a tick', () => {
    // The veto must be fed BEFORE anything can report, or a violation is judged
    // against the PREVIOUS frame's eye state. Asserted per-tick rather than
    // globally: a single submit at startup would satisfy a global check.
    const source = new ScriptedLandmarkSource(
      scriptedFrames({ builder: gazeBuilder, count: TICKS_30S, dtMs: DT, t0: T0 }),
      { w: W, h: H },
    );
    const engine = new ProctorDemoEngine({ landmarkSource: source, captureSnapshot: () => 'snap' });
    engine.attachVideo(READY_VIDEO);

    let log = [];
    const realSubmit = engine.veto.submitLandmarks.bind(engine.veto);
    engine.veto.submitLandmarks = (pts, t) => { log.push('submit'); return realSubmit(pts, t); };
    const realReport = engine._reportViolation.bind(engine);
    engine._reportViolation = (...args) => { log.push('report'); return realReport(...args); };

    const perTick = [];
    for (let i = 0; i < TICKS_30S; i++) {
      log = [];
      engine.tickOnce(T0 + i * DT);
      perTick.push(log);
    }

    // Every tick submits, exactly once, first.
    expect(perTick.every((t) => t[0] === 'submit')).toBe(true);
    expect(perTick.every((t) => t.filter((e) => e === 'submit').length === 1)).toBe(true);
    // And at least one tick actually got as far as reporting, so the ordering
    // claim is not vacuously true over a session where nothing ever fired.
    expect(perTick.some((t) => t.includes('report'))).toBe(true);
  });
});

// =============================================================================
// 7. THE ANALYSIS CLOCK — self-scheduling from completion
// =============================================================================

describe('_loop — schedule is called exactly once per completed tick', () => {
  function loopHarness({ tickCostMs = 0 } = {}) {
    let now = T0;
    const queue = [];
    let scheduleCalls = 0;

    const source = new ScriptedLandmarkSource(
      scriptedFrames({ builder: () => frame({}), count: 10, dtMs: DT, t0: T0 }),
      { w: W, h: H },
    );
    // Simulate a slow machine by advancing the injected clock inside detect().
    const realDetect = source.detect.bind(source);
    source.detect = (v, t) => { now += tickCostMs; return realDetect(v, t); };

    const engine = new ProctorDemoEngine({
      landmarkSource: source,
      now: () => now,
      schedule: (fn, ms) => { scheduleCalls++; queue.push({ fn, ms }); return queue.length; },
      cancel: () => {},
    });
    engine.attachVideo(READY_VIDEO);

    return { engine, queue, calls: () => scheduleCalls, advance: (ms) => { now += ms; } };
  }

  it('start() schedules once and does not run re-entrantly', () => {
    const h = loopHarness();
    h.engine.start();

    expect(h.calls()).toBe(1);
    expect(h.queue).toHaveLength(1);
    // Nothing has been drained, so the loop is idle — the callback is queued, not
    // invoked. A synchronous re-entrant schedule would blow the stack here.
    h.engine.start();               // StrictMode double-invokes effects.
    expect(h.calls()).toBe(1);      // idempotent
  });

  it('each drained tick schedules exactly one successor', () => {
    const h = loopHarness();
    h.engine.start();

    for (let i = 1; i <= 5; i++) {
      const job = h.queue.shift();
      h.advance(DT);
      job.fn();
      expect(h.calls()).toBe(i + 1);
      expect(h.queue).toHaveLength(1);
    }
  });

  it('measures the delay FROM COMPLETION, and floors it at minGapMs', () => {
    // A slow machine must degrade to a lower frame rate, never queue ticks it
    // can never drain. 200 ms of work against a 66 ms target leaves a negative
    // budget, which clamps to DEFAULT_MIN_GAP_MS rather than going to zero and
    // saturating a core — a proctor that degrades the exam has failed its job.
    const fast = loopHarness({ tickCostMs: 0 });
    fast.engine.start();
    expect(fast.queue[0].ms).toBe(DT);

    const slow = loopHarness({ tickCostMs: 200 });
    slow.engine.start();
    expect(slow.queue[0].ms).toBe(33);
  });

  it('stop() closes the source and drops the video reference', () => {
    const h = loopHarness();
    h.engine.start();
    h.engine.stop();

    // Teardown order: close the source (releasing the WASM heap) BEFORE dropping
    // references. Skipping it leaks tens of MB per modal open.
    expect(h.engine.source.closed).toBe(true);
    expect(h.engine.running).toBe(false);
    expect(h.engine.video).toBe(null);
  });
});

// =============================================================================
// 8. _readEar — staleness resolves to UNKNOWN, using the gate's OWN maxAgeMs
// =============================================================================

describe('_readEar', () => {
  it('returns null before any sample exists', () => {
    const { engine } = chokePointEngine();
    expect(engine._readEar(T0)).toBe(null);
  });

  it("publishes a fresh sample, and expires it exactly at the gate's maxAgeMs", () => {
    // telemetry().ear is the last sample submitted REGARDLESS of age. Publishing
    // it unconditionally would put an expired number on a live gauge, which is
    // precisely the lie PLAN.md §7 forbids. The threshold is the gate's own, so
    // the gauge and the safeguard can never disagree about whether we can
    // currently see the eyes.
    const { engine } = chokePointEngine();
    const maxAgeMs = engine.veto.telemetry().maxAgeMs;
    expect(maxAgeMs).toBe(500);

    engine.veto.submitLandmarks(syntheticFace({ ear: 0.30, pose: {} }), T0);

    expect(engine._readEar(T0)).toBeCloseTo(0.30, 10);
    expect(engine._readEar(T0 + maxAgeMs)).toBeCloseTo(0.30, 10);   // inclusive bound
    expect(engine._readEar(T0 + maxAgeMs + 1)).toBe(null);          // UNKNOWN, not 0
  });
});

// =============================================================================
// 9. THE HAPPY PATH — the demo has to actually work
// =============================================================================

describe('30 s of a neutral, open-eyed face', () => {
  const run = drive({ builder: () => frame({}) });

  it('accuses nobody', () => {
    expect(names(run.violations)).toEqual([]);
  });

  it('the REAL head-pose channel calibrates (R2 is not a stub)', () => {
    // If `faceToCocoPerson` were returning null — the partial-projection failure
    // — personCount would read 0, calibration would never start, and every gaze
    // verdict would be HEAD_OFF_NEUTRAL forever while everything still "passed".
    expect(run.last.head.personCount).toBe(1);
    expect(run.last.head.status).toBe('ok');
    expect(run.last.calibrated).toBe(true);
  });

  it('the gaze channel runs and reads the eyes', () => {
    expect(run.last.gaze.status).toBe('ok');
    expect(run.last.gaze.calibrated).toBe(true);
    expect(run.last.readable).toBe(true);
    expect(run.last.ear).toBeCloseTo(0.30, 10);
  });

  it('emits one frame per tick', () => {
    expect(run.frames).toHaveLength(TICKS_30S);
    expect(run.engine.telemetry().ticks).toBe(TICKS_30S);
  });
});

describe('an isolated side gaze on a still head', () => {
  // 230 neutral ticks to calibrate, then the irises move to h = 0.25 while the
  // skull stays put.
  const run = drive({ builder: (i) => frame(i < 230 ? {} : { h: 0.25 }) });

  it('reports SIDE_GAZE_PEEKING and nothing else', () => {
    expect(names(run.violations)).toEqual(['SIDE_GAZE_PEEKING/LOW']);
    expect(run.last.gaze.status).toBe('alert');
  });

  it('⚠ THE IRIS COUPLING stays inside the head gates, which is what isolates it', () => {
    // R2's down-projection uses the IRIS CENTRES as COCO's eye points, so moving
    // the eyes alone does move the measured head yaw a little:
    //     measured yaw = pose.yaw - (h - 0.5) * width / interocular
    // The fixture reproduces that rather than cancelling it — it is a real
    // property of the mitigation, and a fixture that hid it would let a
    // regression through.
    //
    // At h = 0.25 the coupling is 0.10, giving a head excursion of 0.556: inside
    // the gaze channel's 0.75 head gate and well inside the pose pipeline's 1.0,
    // so this is a clean gaze verdict rather than a head-pose one. Push to
    // h = 0.95 and the coupling reaches 0.18 — one full excursion unit — and
    // AI_CHEATING_POSE fires instead. Tests wanting an isolated gaze verdict
    // must stay near h = 0.25 / 0.75.
    expect(measuredHeadYawRatio({ h: 0.25 })).toBeCloseTo(0.10, 10);
    expect(run.last.head.smoothedExcursion).toBeCloseTo(0.5556, 3);
    expect(run.last.head.smoothedExcursion).toBeLessThan(0.75);
  });

  it('the report carries its evidence and its EAR check', () => {
    expect(run.violations[0].snapshot).toBe('snap');
    expect(run.violations[0].earChecked).toBe(VETO_REASON.EYES_OPEN);
    expect(run.violations[0].ear).toBeCloseTo(0.30, 10);
  });

  // ⚠ WORTH KNOWING, and deliberately NOT changed here: 15 s of sustained side
  // gaze yields exactly ONE event, at LOW. DwellGate emits `glance` at 1500 ms
  // and `alert` at 3000 ms, but the engine's 4000 ms per-type cooldown swallows
  // the MEDIUM alert, and the gaze analyser's own `minRealertMs: 20000` prevents
  // another. That is faithful to upstream monitor.js, so it stays — but it means
  // sustained peeking DISPLAYS as LOW, which matters for a page whose job is to
  // show the MEDIUM case.
  it('sustained peeking produces one LOW event, not an escalating stream', () => {
    expect(run.violations).toHaveLength(1);
  });
});

// ===========================================================================
// NO_FACE dwell — the demo must agree with the extension
//
// The demo and the extension are two front-ends over the SAME frozen pipeline.
// A student who tries the demo and then sits a real exam must not meet two
// different definitions of "you left the frame". The demo previously inherited
// pose_pipeline.js's own default (alertMs 5000, graceMs 800) while the
// extension configured 2000/0, so the two silently disagreed by three seconds.
// ===========================================================================
describe('NO_FACE dwell alignment with the extension', () => {
  it('uses the 2.0 s threshold', () => {
    expect(DEFAULT_HEAD_OPTS.absenceGate.alertMs).toBe(2000);
  });

  // ⚠ graceMs MUST be 0. Any grace holds the episode open across a brief
  // reappearance and keeps accumulating dwell — the opposite of "a face
  // reappearing before 2 s resets the timer immediately".
  it('resets immediately when a face reappears', () => {
    expect(DEFAULT_HEAD_OPTS.absenceGate.graceMs).toBe(0);
  });

  // DwellGate tests alertMs BEFORE glanceMs, so an equal glanceMs makes the LOW
  // tier unreachable and 2 s yields exactly one HIGH event — the only severity
  // this engine reports for NO_FACE.
  it('does not emit a glance tier before the alert', () => {
    expect(DEFAULT_HEAD_OPTS.absenceGate.glanceMs)
      .toBeGreaterThanOrEqual(DEFAULT_HEAD_OPTS.absenceGate.alertMs);
  });

  // ⚠ THE ACTUAL ANTI-DRIFT CHECK. The constants above only prove the demo is
  // internally consistent; this proves it still matches the extension. Skipped
  // rather than failed when the extension tree is absent, exactly as
  // scripts/check-vision-sync.mjs does — a dashboard-only checkout is a
  // supported configuration, not a broken one.
  it('matches NO_FACE_GATE in extension/content/monitor.js', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');

    const here = path.dirname(fileURLToPath(import.meta.url));
    const monitorPath = path.resolve(
      here, '..', '..', '..', '..', 'extension', 'content', 'monitor.js');

    if (!existsSync(monitorPath)) {
      expect(true).toBe(true); // dashboard-only checkout — nothing to compare
      return;
    }

    const src = readFileSync(monitorPath, 'utf8');
    const block = src.match(/const NO_FACE_GATE = \{([\s\S]*?)\};/);
    expect(block, 'NO_FACE_GATE not found in monitor.js').toBeTruthy();

    const numberFor = (key) => {
      const m = block[1].match(new RegExp(`${key}:\\s*(\\d+)`));
      return m ? Number(m[1]) : null;
    };

    for (const key of ['glanceMs', 'alertMs', 'graceMs', 'minRealertMs']) {
      expect(numberFor(key), `NO_FACE_GATE.${key} drifted from the demo`)
        .toBe(DEFAULT_HEAD_OPTS.absenceGate[key]);
    }
  });

  // Behaviour, not just configuration: drive the real analyser through the real
  // engine and confirm when the incident actually lands.
  it('raises NO_FACE_DETECTED after 2 s with no face, and not before', () => {
    const violations = [];
    const engine = new ProctorDemoEngine({
      // An empty face list is "MediaPipe found no face this frame" — the exact
      // condition the extension measures, since persons are projected from
      // FaceMesh output on both sides.
      landmarkSource: {
        detect: () => ({ faces: [], w: 640, h: 480 }),
        close: () => {},
      },
      now: () => 0,
      captureSnapshot: () => 'snap',
      cooldownMs: 0,
    });
    engine.on('violation', (v) => violations.push(v));

    for (let t = 0; t < 1900; t += 100) engine.tickOnce(t);
    expect(violations.filter((v) => v.type === VIOLATION.NO_FACE_DETECTED)).toHaveLength(0);

    for (let t = 1900; t <= 2100; t += 100) engine.tickOnce(t);
    expect(violations.filter((v) => v.type === VIOLATION.NO_FACE_DETECTED)).toHaveLength(1);
  });
});
