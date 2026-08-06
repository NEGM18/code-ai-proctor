// Tests for the Facial Landmark Geometry & EAR Gatekeeper Engine.
//
//   node extension/test/gaze_landmarks.test.js
//
// THE CONTRACT THIS SUITE DEFENDS:
//   1. EAR < 0.20 => valid:false, gaze:'UNKNOWN', reason:'EYE_CLOSED'.
//   2. The EAR gate runs BEFORE any iris math, so a closed eye never produces
//      a direction to be misread.
//   3. 30 seconds of closed eyes emits ZERO alerts.
//
// Landmarks are synthesised, so these are exact-geometry assertions, not
// tolerance-fitting. Coordinates are IMAGE space: x grows right, y grows DOWN,
// and the frame is UNMIRRORED (so the subject's LEFT eye sits at the LARGER x).

const g = require('../content/vision/gaze_landmarks.js');

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}
const checkTrue = (name, cond) => check(name, !!cond, true);

// ---------------------------------------------------------------------------
// Synthetic 478-point landmark builder.
//
// Only the ten indices the engine reads are populated; the rest stay undefined,
// which also proves the engine never reaches for a landmark it did not declare.
// ---------------------------------------------------------------------------

const C = g.LANDMARK_CONTRACT;

/**
 * Build one eye.
 * @param {number} cx     eye centre x
 * @param {number} width  corner-to-corner width (H)
 * @param {number} open   eyelid opening in px (V) -- EAR = open / width
 * @param {number} hFrac  iris position along the eye, 0=image-left, 1=image-right
 * @param {number} vFrac  iris position, 0=upper lid, 1=lower lid
 * @param {boolean} innerIsLeft  is the NASAL corner on the image-left side?
 */
function eye(cx, width, open, hFrac, vFrac, innerIsLeft) {
  const cy = 100;
  const xL = cx - width / 2;
  const xR = cx + width / 2;
  return {
    upperLid: { x: cx, y: cy - open / 2 },
    lowerLid: { x: cx, y: cy + open / 2 },
    // Which physical corner sits on the image-left differs between the eyes.
    // That asymmetry is the whole point of orientedGazeRatio().
    inner: { x: innerIsLeft ? xL : xR, y: cy },
    outer: { x: innerIsLeft ? xR : xL, y: cy },
    iris: { x: xL + hFrac * width, y: (cy - open / 2) + vFrac * open },
  };
}

/**
 * Assemble a full landmark array.
 *
 * The subject's RIGHT eye is on the image-LEFT. Its nasal (inner) corner faces
 * the nose, i.e. toward image-RIGHT => innerIsLeft = false.
 * The subject's LEFT eye is on the image-RIGHT, nasal corner toward
 * image-LEFT => innerIsLeft = true.
 */
function face({ ear = 0.30, h = 0.5, v = 0.5, hLeft = null, width = 40 } = {}) {
  const open = ear * width;
  const rightEye = eye(200, width, open, hLeft === null ? h : hLeft, v, false);
  const leftEye = eye(300, width, open, h, v, true);

  const pts = new Array(C.pointCount);
  const put = (idx, e) => {
    pts[idx.upperLid] = e.upperLid;
    pts[idx.lowerLid] = e.lowerLid;
    pts[idx.inner] = e.inner;
    pts[idx.outer] = e.outer;
    pts[idx.iris] = e.iris;
  };
  put(C.right, rightEye);
  put(C.left, leftEye);
  return pts;
}

// ===========================================================================
console.log('=== STEP 1: the EAR blink gate ===');
{
  check('threshold is exactly 0.20 as specified', g.DEFAULT_LANDMARK_OPTS.earThreshold, 0.20);

  // EAR = V/H by construction, so these are exact.
  check('EAR of a 12px opening over a 40px eye', g.eyeAspectRatio(
    { x: 0, y: -6 }, { x: 0, y: 6 }, { x: -20, y: 0 }, { x: 20, y: 0 }), 0.3);

  const open = g.analyzeGazeLandmarks(face({ ear: 0.30 }));
  check('EAR 0.30 is an OPEN eye', open.valid, true);
  checkTrue('open eye reports a real EAR', Math.abs(open.ear - 0.30) < 1e-9);

  const shut = g.analyzeGazeLandmarks(face({ ear: 0.05 }));
  check('EAR 0.05 is invalid', shut.valid, false);
  check('EAR 0.05 reports gaze UNKNOWN', shut.gaze, g.GAZE_STATE.UNKNOWN);
  check('EAR 0.05 reason is EYE_CLOSED', shut.reason, g.GAZE_INVALID.EYE_CLOSED);

  // Boundary, both sides.
  check('EAR 0.19 is rejected', g.analyzeGazeLandmarks(face({ ear: 0.19 })).valid, false);
  check('EAR 0.21 is accepted', g.analyzeGazeLandmarks(face({ ear: 0.21 })).valid, true);

  // ⚠ THE GATE ORDER. A closed eye pointed hard off-axis must still yield
  // nothing at all — no direction, no ratio. If the iris math ever ran first,
  // this is the assertion that catches it.
  const shutAndOffAxis = g.analyzeGazeLandmarks(face({ ear: 0.05, h: 0.95 }));
  check('a CLOSED eye looking hard off-axis is still UNKNOWN', shutAndOffAxis.gaze, g.GAZE_STATE.UNKNOWN);
  check('a CLOSED eye yields no horizontal ratio', Number.isFinite(shutAndOffAxis.hRatio), false);
  check('a CLOSED eye yields no vertical ratio', Number.isFinite(shutAndOffAxis.vRatio), false);

  // EAR is a RATIO, so it is invariant to how close the student sits.
  const near = g.analyzeGazeLandmarks(face({ ear: 0.30, width: 80 }));
  const far = g.analyzeGazeLandmarks(face({ ear: 0.30, width: 20 }));
  checkTrue('EAR is distance-invariant', Math.abs(near.ear - far.ear) < 1e-9);

  // Squinting one eye must not leave a half-sample in play.
  const oneShut = face({ ear: 0.30 });
  oneShut[C.right.upperLid] = { x: 200, y: 99.6 };
  oneShut[C.right.lowerLid] = { x: 200, y: 100.4 };
  const winking = g.analyzeGazeLandmarks(oneShut);
  check('ONE closed eye invalidates the whole sample', winking.valid, false);
  check('ONE closed eye reports EYE_CLOSED', winking.reason, g.GAZE_INVALID.EYE_CLOSED);
}

console.log('\n=== STEP 2: horizontal iris ratio, and the inner/outer sign trap ===');
{
  const centre = g.analyzeGazeLandmarks(face({ h: 0.5 }));
  checkTrue('a centred iris reads 0.5', Math.abs(centre.hRatio - 0.5) < 1e-9);
  check('a centred iris classifies CENTRE', centre.gaze, g.GAZE_STATE.CENTRE);

  const left = g.analyzeGazeLandmarks(face({ h: 0.15 }));
  checkTrue('iris at image-left reads low', left.hRatio < 0.25);
  check('image-left classifies LEFT', left.gaze, g.GAZE_STATE.LEFT);

  const right = g.analyzeGazeLandmarks(face({ h: 0.85 }));
  checkTrue('iris at image-right reads high', right.hRatio > 0.75);
  check('image-right classifies RIGHT', right.gaze, g.GAZE_STATE.RIGHT);

  // ⚠ THE TRAP. "Inner" is nasal, so it is on OPPOSITE image sides for the two
  // eyes. Anchoring both at `inner` — the spec's literal formula — makes the
  // two ratios run in opposite directions, and averaging them cancels a real
  // side-glance back to ~0.5. The detector would report CENTRE while the
  // student stares at their notes.
  //
  // Both eyes here are pointed the SAME way in IMAGE space. A correct engine
  // reports a decisive off-axis value; the naive one reports ~0.5.
  const bothLeft = g.analyzeGazeLandmarks(face({ h: 0.12, hLeft: 0.12 }));
  checkTrue('both eyes looking image-left do NOT cancel to centre',
    Math.abs(bothLeft.hRatio - 0.5) > 0.3);
  check('both eyes looking image-left classifies LEFT', bothLeft.gaze, g.GAZE_STATE.LEFT);

  // Directly: the two eyes must agree despite mirrored inner/outer.
  const R = eye(200, 40, 12, 0.2, 0.5, false);  // subject's right eye
  const L = eye(300, 40, 12, 0.2, 0.5, true);   // subject's left eye
  const rR = g.orientedGazeRatio(R.iris, R.inner, R.outer);
  const rL = g.orientedGazeRatio(L.iris, L.inner, L.outer);
  checkTrue('both eyes agree on image orientation', Math.abs(rR - rL) < 1e-9);
  checkTrue('and both read image-left', rR < 0.25);

  // Spec bands, pinned.
  check('neutral band is 0.35..0.65', [g.DEFAULT_LANDMARK_OPTS.neutralMin, g.DEFAULT_LANDMARK_OPTS.neutralMax], [0.35, 0.65]);
  check('off-screen left is 0.25', g.DEFAULT_LANDMARK_OPTS.offScreenLeft, 0.25);
  check('off-screen right is 0.75', g.DEFAULT_LANDMARK_OPTS.offScreenRight, 0.75);
}

console.log('\n=== STEP 3: vertical iris ratio (downward peeking) ===');
{
  const mid = g.analyzeGazeLandmarks(face({ v: 0.5 }));
  checkTrue('a centred iris reads 0.5 vertically', Math.abs(mid.vRatio - 0.5) < 1e-9);

  const down = g.analyzeGazeLandmarks(face({ v: 0.85 }));
  checkTrue('an iris near the lower lid reads high', down.vRatio > 0.62);
  check('downward peeking classifies DOWN', down.gaze, g.GAZE_STATE.DOWN);

  const up = g.analyzeGazeLandmarks(face({ v: 0.2 }));
  check('an iris near the upper lid is not DOWN', up.gaze === g.GAZE_STATE.DOWN, false);
}

console.log('\n=== geometry is illumination- and pigmentation-free by construction ===');
{
  // The regression that motivated this rewrite: the pixel engine varied with
  // lighting, skin tone and lash shadow. Nothing here reads a pixel, so the
  // only inputs are coordinates. Identical geometry MUST give identical output
  // regardless of anything else about the frame.
  const a = g.analyzeGazeLandmarks(face({ ear: 0.28, h: 0.42, v: 0.55 }));
  const b = g.analyzeGazeLandmarks(face({ ear: 0.28, h: 0.42, v: 0.55 }));
  check('identical geometry gives identical results', [a.ear, a.hRatio, a.vRatio], [b.ear, b.hRatio, b.vRatio]);
  checkTrue('the module exposes no pixel API', typeof g.rgbaToGray === 'undefined' && typeof g.percentile === 'undefined');
}

// ===========================================================================
// Analyser: "unknown is not deviant".
// ===========================================================================

// Gaze now requires BOTH a calibrated excursion inside maxHeadExcursion AND
// abs(deviation.yawDeg) < maxHeadYawDeg, so these fakes must carry the yaw the
// pose pipeline supplies in production (poseResult.deviation.yawDeg).
const NEUTRAL_HEAD = { calibrated: true, smoothedExcursion: 0.1, deviation: { yawDeg: 3, pitchDeg: 1 } };
const TURNED_HEAD = { calibrated: true, smoothedExcursion: 1.4, deviation: { yawDeg: 28, pitchDeg: 2 } };
/** Inside the calibrated band, but past the absolute 15-degree bound. */
const SKEWED_HEAD = { calibrated: true, smoothedExcursion: 0.2, deviation: { yawDeg: 22, pitchDeg: 1 } };
/** Calibrated, neutral excursion, but the pose pipeline could not measure yaw. */
const UNMEASURED_YAW_HEAD = { calibrated: true, smoothedExcursion: 0.1, deviation: null };

function run(analyzer, makeLandmarks, head, frames, dtMs = 100, t0 = 1000) {
  const events = [];
  let last = null;
  for (let i = 0; i < frames; i++) {
    last = analyzer.process(makeLandmarks(i), head, t0 + i * dtMs);
    events.push(...last.events);
  }
  return { events, last };
}

console.log('\n=== 30 SECONDS OF CLOSED EYES EMITS ZERO ALERTS ===');
{
  const a = new g.GazeLandmarkAnalyzer();
  // 300 frames @ 100 ms = 30 s, ten times the 3 s alert dwell.
  const { events, last } = run(a, () => face({ ear: 0.05 }), NEUTRAL_HEAD, 300);
  check('30 s of closed eyes emits ZERO events', events.length, 0);
  check('status is eyes_closed, not alert', last.status, 'eyes_closed');
  check('gaze stays UNKNOWN throughout', last.gaze, g.GAZE_STATE.UNKNOWN);
  check('closed eyes never calibrate a bogus neutral', last.calibrated, false);
  check('the dwell gate never left idle', a.gate.state, 'idle');
}

console.log('\n=== 30 s of closed eyes while looking hard off-axis ===');
{
  // The adversarial version: the geometry says "hard left" but the eye is shut,
  // so the engine must still refuse to say anything.
  const a = new g.GazeLandmarkAnalyzer();
  const { events } = run(a, () => face({ ear: 0.05, h: 0.95, v: 0.95 }), NEUTRAL_HEAD, 300);
  check('closed + off-axis for 30 s still emits ZERO events', events.length, 0);
}

console.log('\n=== blinking during honest work never accumulates ===');
{
  const a = new g.GazeLandmarkAnalyzer();
  // Realistic: a blink every ~2 s, forward gaze otherwise.
  const { events } = run(a, (i) => face(i % 20 < 2 ? { ear: 0.08 } : { ear: 0.30, h: 0.5 }),
    NEUTRAL_HEAD, 600);
  check('a blinking student emits ZERO events', events.length, 0);
}

console.log('\n=== calibration, then a forward-looking student ===');
{
  const a = new g.GazeLandmarkAnalyzer();
  const { events, last } = run(a, () => face({ h: 0.5, v: 0.5 }), NEUTRAL_HEAD, 200);
  check('a forward-looking student calibrates', last.calibrated, true);
  check('a forward-looking student emits ZERO events', events.length, 0);
  check('status is ok', last.status, 'ok');
}

console.log('\n=== STEP 4: sustained side gaze IS reported ===');
{
  const a = new g.GazeLandmarkAnalyzer();
  run(a, () => face({ h: 0.5 }), NEUTRAL_HEAD, 80);
  checkTrue('calibrated first', a.isCalibrated());

  const { events } = run(a, () => face({ h: 0.12 }), NEUTRAL_HEAD, 60, 100, 9000);
  checkTrue('sustained side gaze is reported', events.length > 0);
  check('condition is SIDE_GAZE_PEEKING', events[0].condition, g.GazeCondition.SIDE_GAZE_PEEKING);
  checkTrue('it reaches the sustained tier', events.some((e) => e.severity === 'MEDIUM'));
  check('never CRITICAL', events.filter((e) => e.severity === 'CRITICAL').length, 0);
  check('never HIGH', events.filter((e) => e.severity === 'HIGH').length, 0);

  // Spec: continuous 1.5-3.0 s before anything fires.
  check('glance dwell is 1500 ms', g.DEFAULT_LANDMARK_GATE.glanceMs, 1500);
  check('alert dwell is 3000 ms', g.DEFAULT_LANDMARK_GATE.alertMs, 3000);
}

console.log('\n=== a brief glance is NOT reported ===');
{
  const a = new g.GazeLandmarkAnalyzer();
  run(a, () => face({ h: 0.5 }), NEUTRAL_HEAD, 80);
  // 1.0 s off-axis, under the 1.5 s glance floor.
  const { events } = run(a, () => face({ h: 0.12 }), NEUTRAL_HEAD, 10, 100, 9000);
  check('a 1 s glance emits nothing', events.length, 0);
}

console.log('\n=== gaze stands down when the head has turned ===');
{
  const a = new g.GazeLandmarkAnalyzer();
  run(a, () => face({ h: 0.5 }), NEUTRAL_HEAD, 80);
  const { events, last } = run(a, () => face({ h: 0.05 }), TURNED_HEAD, 100, 100, 9000);
  check('a turned head yields ZERO gaze events', events.length, 0);
  check('status explains why', last.status, 'head_off_neutral');
}

console.log('\n=== reporting is suppressed during a liveness challenge ===');
{
  const a = new g.GazeLandmarkAnalyzer();
  run(a, () => face({ h: 0.5 }), NEUTRAL_HEAD, 80);
  const events = [];
  for (let i = 0; i < 60; i++) {
    const r = a.process(face({ h: 0.1 }), NEUTRAL_HEAD, 9000 + i * 100, true);
    events.push(...r.events);
  }
  check('no events while suppressed', events.length, 0);
  checkTrue('but the gate still ran underneath', a.gate.state !== 'idle');
}

console.log('\n=== missing landmarks are UNKNOWN, never a finding ===');
{
  const a = new g.GazeLandmarkAnalyzer();
  const { events, last } = run(a, () => null, NEUTRAL_HEAD, 200);
  check('null landmarks emit ZERO events', events.length, 0);
  check('null landmarks report NOT_SAMPLED', last.reason, g.GAZE_INVALID.NOT_SAMPLED);

  const sparse = new Array(C.pointCount);
  check('an incomplete landmark set is invalid',
    g.analyzeGazeLandmarks(sparse).reason, g.GAZE_INVALID.NO_LANDMARKS);
}

console.log('\n=== reset clears everything ===');
{
  const a = new g.GazeLandmarkAnalyzer();
  run(a, () => face({ h: 0.5 }), NEUTRAL_HEAD, 80);
  checkTrue('calibrated before reset', a.isCalibrated());
  a.reset();
  check('not calibrated after reset', a.isCalibrated(), false);
  check('gaze back to UNKNOWN', a.snapshot().gaze, g.GAZE_STATE.UNKNOWN);
}

console.log('\n=== absolute head-yaw bound (spec: abs(Head_Yaw) < 15) ===');
{
  check('maxHeadYawDeg is 15 as specified', g.DEFAULT_LANDMARK_OPTS.maxHeadYawDeg, 15);

  // BOTH conditions are required. A head inside its calibrated neutral band but
  // past the absolute bound must not be evaluated for gaze: apparent iris
  // offset shifts under head rotation and this module has no compensation.
  const skew = new g.GazeLandmarkAnalyzer();
  const skewRun = run(skew, () => face({ h: 0.05 }), SKEWED_HEAD, 200);
  check('excursion-neutral but yaw-skewed head is not evaluated',
    skew.snapshot().reason, g.GAZE_INVALID.HEAD_OFF_NEUTRAL);
  check('…and emits nothing', skewRun.events.length, 0);
  check('…and never calibrates a gaze baseline', skew.isCalibrated(), false);

  // ⚠ Unknown yaw is UNKNOWN, not "straight ahead". If the pose pipeline could
  // not measure the head, we do not get to assume it was neutral and start
  // judging eye direction — CLAUDE.md §5.
  const blind = new g.GazeLandmarkAnalyzer();
  const blindRun = run(blind, () => face({ h: 0.05 }), UNMEASURED_YAW_HEAD, 200);
  check('unmeasurable yaw is treated as off-neutral',
    blind.snapshot().reason, g.GAZE_INVALID.HEAD_OFF_NEUTRAL);
  check('…and emits nothing', blindRun.events.length, 0);

  // Just inside the bound still works, so the gate is not simply off.
  const inside = new g.GazeLandmarkAnalyzer();
  const insideHead = { calibrated: true, smoothedExcursion: 0.1, deviation: { yawDeg: 14.9, pitchDeg: 0 } };
  run(inside, () => face({ h: 0.5 }), insideHead, 80);
  checkTrue('14.9 degrees is inside the bound and calibrates', inside.isCalibrated());

  const outside = new g.GazeLandmarkAnalyzer();
  const outsideHead = { calibrated: true, smoothedExcursion: 0.1, deviation: { yawDeg: 15.0, pitchDeg: 0 } };
  run(outside, () => face({ h: 0.5 }), outsideHead, 80);
  check('15.0 degrees is outside (bound is exclusive)', outside.isCalibrated(), false);
}

// ---------------------------------------------------------------------------
console.log(`\n${'-'.repeat(60)}`);
console.log(failures === 0
  ? `All ${checks} checks passed.`
  : `${failures} of ${checks} checks FAILED.`);
process.exit(failures === 0 ? 0 : 1);
