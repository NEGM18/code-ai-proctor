// Regression tests for the head-pose false-positive fix.
//
//   node extension/test/pose_pipeline.test.js
//
// No dependencies, no build step. These cover the three pure modules that
// decide whether a head movement is a violation:
//   content/vision/pose_geometry.js    keypoints -> scale-invariant ratios
//   content/vision/pose_calibration.js ratios    -> deviation from own neutral
//   content/vision/temporal_gate.js    deviation -> smoothed, dwell-gated events
//
// The headline cases are OFF_AXIS_STUDENT (the "looking straight gets flagged"
// bug) and READING_GLANCE (the "tilting down to read gets flagged" bug).

const geom = require('../content/vision/pose_geometry.js');
const calib = require('../content/vision/pose_calibration.js');
const temporal = require('../content/vision/temporal_gate.js');

const { computeHeadPose, POSE_INVALID } = geom;
const { PoseBaseline } = calib;
const { TemporalSmoother, DwellGate, GateState } = temporal;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

function checkClose(name, actual, expected, tol = 1e-6) {
  checks++;
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${actual}, want ${expected} +/-${tol})`}`);
}

function checkTrue(name, cond) {
  check(name, !!cond, true);
}

/**
 * Synthesise a COCO-17 keypoint set for a face with known geometry.
 * Eyes are placed io apart, the nose is offset by the requested ratios, then
 * the whole rig is rotated by rollDeg so roll can be tested in isolation.
 */
function makeFace({
  cx = 320, cy = 240, io = 60,
  yawRatio = 0, pitchRatio = 0.7, rollDeg = 0,
  score = 0.9, earScore = 0.9, includeEars = true,
} = {}) {
  // COCO "left"/"right" are the SUBJECT'S. In an unmirrored webcam frame the
  // subject's left eye appears on the viewer's right, i.e. at the LARGER x.
  // This mirrors the real keypoint layout verified against the exported model;
  // laying it out the intuitive-but-wrong way round hides roll sign bugs.
  const pts = {
    [geom.KP.LEFT_EYE]: { x: io / 2, y: 0 },
    [geom.KP.RIGHT_EYE]: { x: -io / 2, y: 0 },
    [geom.KP.NOSE]: { x: yawRatio * io, y: pitchRatio * io },
    [geom.KP.LEFT_EAR]: { x: io * 0.9, y: 0 },
    [geom.KP.RIGHT_EAR]: { x: -io * 0.9, y: 0 },
  };

  const th = (rollDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);

  const kps = [];
  for (let i = 0; i < 17; i++) kps.push({ x: 0, y: 0, score: 0 });

  for (const [idx, p] of Object.entries(pts)) {
    const i = Number(idx);
    const isEar = i === geom.KP.LEFT_EAR || i === geom.KP.RIGHT_EAR;
    if (isEar && !includeEars) continue;
    kps[i] = {
      x: cx + (p.x * cos - p.y * sin),
      y: cy + (p.x * sin + p.y * cos),
      score: isEar ? earScore : score,
    };
  }
  return kps;
}

/** Run a calibration sequence and return the calibrated baseline. */
function calibrate(baseline, poses, startMs = 0, stepMs = 400) {
  let t = startMs;
  for (const p of poses) {
    baseline.addSample(p, t);
    t += stepMs;
  }
  return t;
}

const posesOf = (faces) => faces.map((f) => computeHeadPose(f));

console.log('=== pose_geometry ===');

// 1. A squarely frontal face reads as centred.
{
  const p = computeHeadPose(makeFace({ yawRatio: 0, pitchRatio: 0.7 }));
  checkTrue('frontal face is valid', p.valid);
  checkClose('frontal yawRatio ~ 0', p.yawRatio, 0, 1e-9);
  checkClose('frontal pitchRatio ~ 0.7', p.pitchRatio, 0.7, 1e-9);
  checkClose('frontal rollDeg ~ 0', p.rollDeg, 0, 1e-9);
}

// 2. Scale invariance: distance from the camera must not change the signals.
{
  const near = computeHeadPose(makeFace({ io: 120, yawRatio: 0.3, pitchRatio: 0.7 }));
  const far = computeHeadPose(makeFace({ io: 40, yawRatio: 0.3, pitchRatio: 0.7 }));
  checkClose('yawRatio invariant to face scale', near.yawRatio, far.yawRatio, 1e-9);
  checkClose('pitchRatio invariant to face scale', near.pitchRatio, far.pitchRatio, 1e-9);
}

// 3. Roll is a true angle and is recovered exactly.
{
  const p = computeHeadPose(makeFace({ rollDeg: 15, yawRatio: 0, pitchRatio: 0 }));
  checkClose('rollDeg recovered', p.rollDeg, 15, 1e-6);
}

// 4. Yaw is monotonic in head turn.
{
  const seq = [-0.4, -0.2, 0, 0.2, 0.4].map((y) => computeHeadPose(makeFace({ yawRatio: y })).yawRatio);
  const increasing = seq.every((v, i) => i === 0 || v > seq[i - 1]);
  checkTrue('yawRatio monotonic across turn range', increasing);
}

// 5. Quality gates reject unusable frames instead of guessing.
{
  const low = computeHeadPose(makeFace({ score: 0.1 }));
  check('low keypoint confidence rejected', low.reason, POSE_INVALID.LOW_CONFIDENCE);

  const tiny = computeHeadPose(makeFace({ io: 6 }));
  check('face too small rejected', tiny.reason, POSE_INVALID.FACE_TOO_SMALL);

  check('missing keypoints rejected', computeHeadPose(null).reason, POSE_INVALID.NO_KEYPOINTS);
  check('rejected frames report zero excursion', low.valid, false);
}

// 6. Ear asymmetry is present when ears are confident, null when they are not.
{
  const withEars = computeHeadPose(makeFace({ earScore: 0.9 }));
  const noEars = computeHeadPose(makeFace({ earScore: 0.05 }));
  checkTrue('yawAsym present with confident ears', withEars.yawAsym !== null);
  check('yawAsym null with unconfident ears', noEars.yawAsym, null);
}

console.log('\n=== pose_calibration ===');

// 7. HEADLINE: the off-axis student. Someone seated below their webcam has a
//    permanently different apparent pitch. Against a fixed absolute threshold
//    they are flagged while sitting perfectly still and looking at the screen.
//    After calibration their own neutral must read as centred.
{
  const OFF_AXIS_PITCH = 1.35; // far from any plausible hardcoded "normal"
  const baseline = new PoseBaseline({}, geom.ratioToApproxDegrees);
  const still = Array.from({ length: 15 }, () =>
    computeHeadPose(makeFace({ pitchRatio: OFF_AXIS_PITCH, yawRatio: 0.22 })));
  calibrate(baseline, still);

  checkTrue('off-axis student calibrates', baseline.isCalibrated());

  const dev = baseline.deviation(computeHeadPose(makeFace({ pitchRatio: OFF_AXIS_PITCH, yawRatio: 0.22 })));
  checkClose('OFF_AXIS_STUDENT: own neutral has ~zero deviation', dev.excursion, 0, 1e-6);
  checkTrue('OFF_AXIS_STUDENT: own neutral is inside the band', dev.excursion < 1);
  check('OFF_AXIS_STUDENT: no dominant axis at neutral', dev.axis, 'none');
}

// 8. A genuine look-away from that same off-axis neutral still trips.
{
  const OFF_AXIS_PITCH = 1.35;
  const baseline = new PoseBaseline({}, geom.ratioToApproxDegrees);
  calibrate(baseline, Array.from({ length: 15 }, () =>
    computeHeadPose(makeFace({ pitchRatio: OFF_AXIS_PITCH, yawRatio: 0.22 }))));

  const away = baseline.deviation(computeHeadPose(makeFace({ pitchRatio: OFF_AXIS_PITCH, yawRatio: 0.95 })));
  checkTrue('real look-away from off-axis neutral exceeds band', away.excursion > 1);
  check('look-away axis is yaw', away.axis, 'yaw');
  check('look-away direction is right', away.direction, 'right');
}

// 9. Neutral is the MEDIAN, so an outlier during calibration cannot poison it.
{
  const baseline = new PoseBaseline({}, geom.ratioToApproxDegrees);
  const samples = Array.from({ length: 14 }, () => computeHeadPose(makeFace({ yawRatio: 0.1 })));
  samples[3] = computeHeadPose(makeFace({ yawRatio: 2.5 }));  // glanced at the door
  samples[9] = computeHeadPose(makeFace({ yawRatio: -2.5 }));
  calibrate(baseline, samples);

  checkClose('median neutral ignores calibration outliers', baseline.neutral.yaw, 0.1, 1e-6);
}

// 10. Tolerance adapts to the individual: a fidgety student gets a wider band
//     than a still one, instead of a stream of false positives.
{
  const stillBase = new PoseBaseline({}, geom.ratioToApproxDegrees);
  calibrate(stillBase, Array.from({ length: 14 }, (_, i) =>
    computeHeadPose(makeFace({ yawRatio: i % 2 ? 0.01 : -0.01 }))));

  const fidgetBase = new PoseBaseline({}, geom.ratioToApproxDegrees);
  calibrate(fidgetBase, Array.from({ length: 14 }, (_, i) =>
    computeHeadPose(makeFace({ yawRatio: i % 2 ? 0.15 : -0.15 }))));

  checkTrue('fidgety student gets a wider tolerance', fidgetBase.tolerance.yaw > stillBase.tolerance.yaw);
  checkClose('still student floored at minimum tolerance', stillBase.tolerance.yaw, 0.18, 1e-9);
  checkTrue('tolerance is capped', fidgetBase.tolerance.yaw <= 0.60 + 1e-9);
}

// 11. Drift tracks posture but cannot be walked to a cheating pose.
{
  const baseline = new PoseBaseline({}, geom.ratioToApproxDegrees);
  calibrate(baseline, Array.from({ length: 14 }, () => computeHeadPose(makeFace({ yawRatio: 0 }))));
  const startNeutral = baseline.neutral.yaw;

  // Well outside the drift gate: sustained look-away must not move the neutral.
  let t = 10000;
  for (let i = 0; i < 200; i++) {
    baseline.addSample(computeHeadPose(makeFace({ yawRatio: 0.9 })), t);
    t += 100;
  }
  checkClose('sustained deviation does not drag the neutral', baseline.neutral.yaw, startNeutral, 1e-9);

  // Comfortably inside the band: a small posture change is absorbed.
  for (let i = 0; i < 200; i++) {
    baseline.addSample(computeHeadPose(makeFace({ yawRatio: 0.05 })), t);
    t += 100;
  }
  checkTrue('small posture change is absorbed by drift', baseline.neutral.yaw > startNeutral);
  checkTrue('drift stays small', Math.abs(baseline.neutral.yaw) < 0.1);
}

// 12. Before calibration completes, nothing is ever reported as deviant.
{
  const baseline = new PoseBaseline({}, geom.ratioToApproxDegrees);
  baseline.addSample(computeHeadPose(makeFace({ yawRatio: 3.0 })), 0);
  const dev = baseline.deviation(computeHeadPose(makeFace({ yawRatio: 3.0 })));
  check('uncalibrated reports calibrated:false', dev.calibrated, false);
  check('uncalibrated excursion is zero', dev.excursion, 0);
}

console.log('\n=== temporal_gate: smoother ===');

// 13. Median smoothing rejects a single wild frame.
{
  const s = new TemporalSmoother({ windowMs: 1200, mode: 'median' });
  let t = 0;
  for (let i = 0; i < 6; i++) { s.push(0.2, t); t += 100; }
  s.push(9.9, t); // one catastrophic keypoint frame
  checkTrue('median smoother rejects a single outlier', s.value() < 0.5);
}

// 14. The window actually expires.
{
  const s = new TemporalSmoother({ windowMs: 1000 });
  s.push(5, 0);
  s.push(1, 2000); // 2 s later — the first sample must be gone
  check('stale samples leave the window', s.size(), 1);
  checkClose('smoothed value is the fresh sample', s.value(), 1, 1e-9);
}

console.log('\n=== temporal_gate: dwell ===');

/** Drive the gate at a fixed cadence and collect emitted events. */
function driveGate(gate, steps, stepMs = 200, startMs = 0) {
  const events = [];
  let t = startMs;
  for (const deviant of steps) {
    const r = gate.update(deviant, t, deviant ? 2.0 : 0);
    if (r.event) events.push({ event: r.event, dwellMs: r.dwellMs, t });
    t += stepMs;
  }
  return { events, endMs: t };
}

const N = (n) => Array(n).fill(false);
const D = (n) => Array(n).fill(true);

// 15. HEADLINE: a brief downward glance to read the question is NOT an event.
{
  const gate = new DwellGate();
  // 1.0 s of deviation at 200 ms cadence, then back to neutral.
  const { events } = driveGate(gate, [...N(3), ...D(5), ...N(10)]);
  check('READING_GLANCE: sub-1.5s movement emits nothing', events.map((e) => e.event), []);
  check('READING_GLANCE: gate returns to idle', gate.state, GateState.IDLE);
}

// 16. A medium excursion is recorded but never accuses.
{
  const gate = new DwellGate();
  const { events } = driveGate(gate, [...N(2), ...D(11), ...N(10)]);
  const kinds = events.map((e) => e.event);
  checkTrue('1.5-2.5s excursion emits a glance', kinds.includes('glance'));
  checkTrue('1.5-2.5s excursion does NOT alert', !kinds.includes('alert'));
}

// 17. A sustained look-away does alert.
{
  const gate = new DwellGate();
  const { events } = driveGate(gate, [...N(2), ...D(20), ...N(10)]);
  const kinds = events.map((e) => e.event);
  checkTrue('sustained deviation alerts', kinds.includes('alert'));
  checkTrue('alert is preceded by a glance', kinds.indexOf('glance') < kinds.indexOf('alert'));
  checkTrue('episode releases afterwards', kinds.includes('release'));

  const alert = events.find((e) => e.event === 'alert');
  checkTrue('alert dwell is at least the 2.5s threshold', alert.dwellMs >= 2500);
}

// 18. One noisy non-deviant frame mid-episode must not reset the dwell timer.
//     Without grace, "persist continuously" is unachievable in practice.
{
  const gate = new DwellGate();
  const steps = [...D(6), false, ...D(8), ...N(6)]; // single dropout at 1.2 s
  const { events } = driveGate(gate, steps);
  checkTrue('single dropout does not prevent the alert', events.some((e) => e.event === 'alert'));
}

// 19. A dropout longer than grace does end the episode.
{
  const gate = new DwellGate();
  const steps = [...D(6), ...N(4), ...D(6), ...N(4)]; // 800 ms gap > graceMs 400
  const { events } = driveGate(gate, steps);
  checkTrue('dropout beyond grace prevents the alert', !events.some((e) => e.event === 'alert'));
}

// 20. Continuity cannot be claimed across an unobserved gap.
{
  const gate = new DwellGate({ maxSampleGapMs: 2000 });
  gate.update(true, 0, 2);
  const r = gate.update(true, 6000, 2); // 6 s later: two points, no evidence between
  check('unobserved gap resets the streak', r.event, null);
  checkTrue('unobserved gap does not alert', r.state !== GateState.ALERT);
}

// 21. Refractory spaces out repeat alerts without latching the machine.
{
  const gate = new DwellGate({ minRealertMs: 15000 });
  const first = driveGate(gate, [...D(20), ...N(6)]);
  checkTrue('first episode alerts', first.events.some((e) => e.event === 'alert'));

  const second = driveGate(gate, [...D(20), ...N(6)], 200, first.endMs);
  checkTrue('immediate second episode is suppressed', !second.events.some((e) => e.event === 'alert'));

  const third = driveGate(gate, [...D(20), ...N(6)], 200, first.endMs + 30000);
  checkTrue('alert resumes after refractory lapses', third.events.some((e) => e.event === 'alert'));
}

// 22. Null (unusable pose) is tolerated transiently, not treated as deviation.
{
  const gate = new DwellGate();
  const { events } = driveGate(gate, [...D(6), null, ...D(8), ...N(6)]);
  checkTrue('transient null does not break a real episode', events.some((e) => e.event === 'alert'));

  const gate2 = new DwellGate();
  const r = driveGate(gate2, [null, null, null, null, null, null]);
  check('a run of nulls alone never alerts', r.events, []);
}

console.log('\n=== pose_pipeline (composition) ===');

const pipeline = require('../content/vision/pose_pipeline.js');
const { HeadPoseAnalyzer, PoseCondition, PipelineStatus } = pipeline;

/** Wrap a synthetic face as a person detection. */
const person = (faceOpts = {}, score = 0.9) => ({ score, keypoints: makeFace(faceOpts) });

/**
 * Drive the analyzer at a fixed cadence.
 * @returns {{events:Array, last:object, endMs:number}}
 */
function drive(an, personsPerFrame, stepMs = 200, startMs = 0) {
  const events = [];
  let t = startMs;
  let last = null;
  for (const persons of personsPerFrame) {
    last = an.process(persons, t);
    events.push(...last.events);
    t += stepMs;
  }
  return { events, last, endMs: t };
}

/** Frames of a student sitting still at a given (off-axis) neutral. */
const stillFrames = (n, opts) => Array.from({ length: n }, () => [person(opts)]);

const OFF_AXIS = { pitchRatio: 1.35, yawRatio: 0.22 };

// 23. Nothing is reported while calibration is still running.
{
  const an = new HeadPoseAnalyzer();
  const { events, last } = drive(an, stillFrames(4, OFF_AXIS));
  check('pipeline starts in calibrating status', last.status, PipelineStatus.CALIBRATING);
  check('no events during calibration', events, []);
}

// 24. HEADLINE: the off-axis student sitting still, looking at their screen,
//     produces ZERO events over a long run. This is the reported bug.
{
  const an = new HeadPoseAnalyzer();
  const { events, last } = drive(an, stillFrames(120, OFF_AXIS)); // 24 s
  check('OFF_AXIS_STUDENT: calibrates', last.calibrated, true);
  check('OFF_AXIS_STUDENT: steady state is ok', last.status, PipelineStatus.OK);
  check('OFF_AXIS_STUDENT: zero events over 24s of sitting still', events, []);
}

// 25. HEADLINE: repeatedly glancing down to read must stay silent.
{
  const an = new HeadPoseAnalyzer();
  drive(an, stillFrames(30, OFF_AXIS)); // calibrate at their own neutral

  // Six reading glances, each 1.0 s down then 2.0 s back at the screen.
  const frames = [];
  for (let i = 0; i < 6; i++) {
    for (let k = 0; k < 5; k++) frames.push([person({ ...OFF_AXIS, pitchRatio: 0.55 })]);
    for (let k = 0; k < 10; k++) frames.push([person(OFF_AXIS)]);
  }
  const { events } = drive(an, frames, 200, 10000);
  check('READING_GLANCE: repeated 1s downward glances emit nothing', events, []);
}

// 26. A sustained look-away from that same neutral still alerts, with a useful
//     description attached.
{
  const an = new HeadPoseAnalyzer();
  drive(an, stillFrames(30, OFF_AXIS));

  const frames = Array.from({ length: 30 }, () => [person({ ...OFF_AXIS, yawRatio: 1.1 })]);
  const { events } = drive(an, frames, 200, 10000);

  const alert = events.find((e) => e.condition === PoseCondition.LOOK_AWAY && e.severity === 'HIGH');
  checkTrue('sustained look-away alerts', !!alert);
  check('alert names the axis', alert.detail.axis, 'yaw');
  check('alert names the direction', alert.detail.direction, 'right');
  checkTrue('alert dwell >= 2.5s', alert.dwellMs >= 2500);
  checkTrue('alert reports approximate degrees', Number.isFinite(alert.detail.yawDeg));
}

// 27. An empty frame run raises NO_FACE, and only after its longer fuse.
{
  const an = new HeadPoseAnalyzer();
  drive(an, stillFrames(30, OFF_AXIS));

  const brief = drive(an, Array.from({ length: 5 }, () => []), 200, 10000); // 1 s gone
  checkTrue('brief absence does not alert', !brief.events.some((e) => e.severity === 'HIGH'));

  const long = drive(an, Array.from({ length: 40 }, () => []), 200, 20000); // 8 s gone
  const noFace = long.events.find((e) => e.condition === PoseCondition.NO_FACE && e.severity === 'HIGH');
  checkTrue('sustained absence raises NO_FACE', !!noFace);
}

// 28. A second person in frame raises MULTIPLE_FACES.
{
  const an = new HeadPoseAnalyzer();
  drive(an, stillFrames(30, OFF_AXIS));

  const two = Array.from({ length: 30 }, () => [person(OFF_AXIS), person({ cx: 500 })]);
  const { events, last } = drive(an, two, 200, 10000);
  const multi = events.find((e) => e.condition === PoseCondition.MULTIPLE_FACES && e.severity === 'HIGH');
  checkTrue('two people raises MULTIPLE_FACES', !!multi);
  check('person count is reported', last.personCount, 2);
}

// 29. Low-scoring detections are filtered before they can trigger anything.
{
  const an = new HeadPoseAnalyzer();
  drive(an, stillFrames(30, OFF_AXIS));
  const ghost = Array.from({ length: 30 }, () => [person(OFF_AXIS), person({ cx: 500 }, 0.10)]);
  const { events, last } = drive(an, ghost, 200, 10000);
  check('sub-threshold detection ignored', last.personCount, 1);
  checkTrue('ghost detection raises no MULTIPLE_FACES',
    !events.some((e) => e.condition === PoseCondition.MULTIPLE_FACES));
}

// 30. Turning far enough that keypoints stop resolving must NOT read as
//     compliant. Unusable pose contributes "unknown", never "not deviant".
{
  const an = new HeadPoseAnalyzer();
  drive(an, stillFrames(30, OFF_AXIS));

  // Present but unreadable: person detected, facial keypoints unconfident.
  const blind = Array.from({ length: 30 }, () => [person({ ...OFF_AXIS, score: 0.05 })]);
  const { events, last } = drive(an, blind, 200, 10000);
  check('unreadable pose does not report OK', last.status !== PipelineStatus.OK, true);
  checkTrue('unreadable pose alone does not fabricate a look-away alert',
    !events.some((e) => e.condition === PoseCondition.LOOK_AWAY && e.severity === 'HIGH'));
}

// 31. Recalibration re-centres on a new resting posture without a full reset.
{
  const an = new HeadPoseAnalyzer();
  drive(an, stillFrames(30, OFF_AXIS));
  checkTrue('calibrated before recalibrate', an.isCalibrated());

  an.recalibrate();
  check('recalibrate clears the neutral', an.isCalibrated(), false);

  const NEW_POSTURE = { pitchRatio: 0.5, yawRatio: -0.4 };
  const { events, last } = drive(an, stillFrames(40, NEW_POSTURE), 200, 20000);
  check('re-centres on the new posture', last.status, PipelineStatus.OK);
  check('no events while settling into the new posture', events, []);
}

console.log(`\n${checks} checks — ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
