// Tests for eye-gaze ROI analysis.
//
//   node extension/test/gaze_roi.test.js
//
// THE POINT OF THIS SUITE is the closed-eye path. The trained classifier used to
// flag shut eyes as cheating, and a naive iris tracker reproduces that bug: with
// the lid down the darkest thing in the box is the LASH LINE, which sits low, so
// a darkness centroid reads "looking down at notes".
//
// Every assertion under "CLOSED EYES" exists to make that impossible. If a future
// change makes a closed eye produce a direction — of any magnitude, in any
// direction — these fail. That is the whole job.
//
// Sign assertions are written from the STUDENT's point of view, not the image's,
// because that is the reading that goes wrong (see CLAUDE.md §5).

const gaze = require('../content/vision/gaze_roi.js');

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
// Synthetic eye regions. Deliberately crude — the gate must work on gross
// structure, not on photoreal detail.
// ---------------------------------------------------------------------------

const W = 28;
const H = 18;

/** Uniform field of `level`, with a little noise so nothing is pathologically flat. */
function field(level, w = W, h = H) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0; i < g.length; i++) g[i] = level + ((i * 7) % 5) - 2;
  return g;
}

/** An OPEN eye: bright sclera with a dark round iris centred at (cx, cy). */
function openEye(cx = W / 2, cy = H / 2, radius = 4.5) {
  const g = field(200);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) g[y * W + x] = 35;
    }
  }
  return g;
}

/** A CLOSED eye: uniform eyelid skin. No sclera, so almost no contrast. */
function closedEyeFlat() {
  return field(150);
}

/**
 * A CLOSED eye that still has contrast: the LASH LINE.
 * This is the dangerous one — it clears a contrast test, and its centroid sits
 * LOW in the box, which is exactly what a naive tracker calls "looking down".
 */
function closedEyeLashLine() {
  const g = field(200);
  const lashY = Math.round(H * 0.62); // below centre, as a real lash line is
  for (let y = lashY; y < lashY + 2; y++) {
    for (let x = 3; x < W - 3; x++) g[y * W + x] = 30;
  }
  return g;
}

// ===========================================================================
console.log('=== CLOSED EYES PRODUCE NO DIRECTION (the regression this exists for) ===');
{
  const flat = gaze.analyzeEyeRegion(closedEyeFlat(), W, H);
  check('flat closed eye is invalid', flat.valid, false);
  check('flat closed eye reason is EYE_CLOSED', flat.reason, gaze.GAZE_INVALID.EYE_CLOSED);
  check('flat closed eye reports no horizontal gaze', flat.gazeH, 0);
  check('flat closed eye reports no vertical gaze', flat.gazeV, 0);

  const lash = gaze.analyzeEyeRegion(closedEyeLashLine(), W, H);
  check('lash line is invalid', lash.valid, false);
  check('lash line reason is EYE_CLOSED', lash.reason, gaze.GAZE_INVALID.EYE_CLOSED);
  // The load-bearing one. The lash line's centroid IS low in the box; if the
  // shape gate ever stops rejecting it, this is the assertion that notices.
  check('lash line reports no vertical gaze', lash.gazeV, 0);
  checkTrue('lash line was caught by SHAPE, not contrast (it has real contrast)',
    lash.spread >= gaze.DEFAULT_GAZE_OPTS.minIntensitySpread);
  checkTrue('lash line dark region is a wide flat sliver',
    lash.darkAspect > gaze.DEFAULT_GAZE_OPTS.maxDarkAspectRatio);
}

console.log('\n=== the shape gate stays strict ===');
{
  // Lowering this is the easiest way to let the lash line back in, so it should
  // require deliberately editing an assertion.
  checkTrue('maxDarkAspectRatio is at most 3.5', gaze.DEFAULT_GAZE_OPTS.maxDarkAspectRatio <= 3.5);
  checkTrue('minIntensitySpread is a real threshold', gaze.DEFAULT_GAZE_OPTS.minIntensitySpread >= 15);
  // ...but not so strict it rejects a partly-lidded eye, which is what looking
  // DOWN actually looks like. Over-tightening turns honest downward gaze into a
  // permanent blind spot.
  checkTrue('minIntensitySpread leaves room for a partly-lidded eye',
    gaze.DEFAULT_GAZE_OPTS.minIntensitySpread <= 40);
}

console.log('\n=== OPEN eye: iris position -> normalised offset ===');
{
  const centred = gaze.analyzeEyeRegion(openEye(), W, H);
  check('centred iris is valid', centred.valid, true);
  checkTrue('centred iris reads near zero horizontally', Math.abs(centred.gazeH) < 0.10);
  checkTrue('centred iris reads near zero vertically', Math.abs(centred.gazeV) < 0.10);
  checkTrue('a round iris is not sliver-shaped', centred.darkAspect <= 1.6);

  // ⚠ SIGN — stated the way it goes wrong. Frames are UNMIRRORED, so an iris
  // sitting toward the LEFT of the IMAGE means the student is looking toward
  // THEIR OWN RIGHT. Negative gazeH.
  const imageLeft = gaze.analyzeEyeRegion(openEye(W * 0.28, H / 2), W, H);
  check('iris toward image-left is valid', imageLeft.valid, true);
  checkTrue('student looking to their own RIGHT gives NEGATIVE gazeH', imageLeft.gazeH < -0.15);

  const imageRight = gaze.analyzeEyeRegion(openEye(W * 0.72, H / 2), W, H);
  checkTrue('student looking to their own LEFT gives POSITIVE gazeH', imageRight.gazeH > 0.15);

  // Vertical is raw image convention here: down = +. The flip into pose's pitch
  // convention happens once, at the analyzer boundary.
  const low = gaze.analyzeEyeRegion(openEye(W / 2, H * 0.72), W, H);
  checkTrue('iris low in the box gives POSITIVE gazeV (image convention)', low.gazeV > 0.15);
  check('the vertical flip is encoded exactly once', gaze.GAZE_V_TO_PITCH_SIGN, -1);

  // ⚠ A SMALL iris must still read as OPEN. This is why the contrast test uses
  // p05/p95: at r=3 the iris is ~6% of the box, and a p10 cut-off never reaches
  // it, so the region reads flat and an open eye gets rejected as closed. That
  // failure is silent and costs coverage for distant or narrow-eyed students.
  const smallIris = gaze.analyzeEyeRegion(openEye(W / 2, H / 2, 3), W, H);
  check('a small iris still reads as an OPEN eye', smallIris.valid, true);
  checkTrue('a small iris occupies well under 10% of the box', smallIris.darkFraction < 0.10);
}

console.log('\n=== both eyes must read ===');
{
  const good = gaze.analyzeEyeRegion(openEye(), W, H);
  const shut = gaze.analyzeEyeRegion(closedEyeFlat(), W, H);

  check('two open eyes fuse', gaze.combineEyes(good, good).valid, true);
  // One eye open and one shut is a wink, an occlusion, or a partly turned head.
  // Averaging one eye's bias into "gaze" manufactures a plausible wrong number.
  check('one shut eye invalidates the sample', gaze.combineEyes(good, shut).valid, false);
  check('one shut eye propagates EYE_CLOSED', gaze.combineEyes(good, shut).reason, gaze.GAZE_INVALID.EYE_CLOSED);
  check('a missing eye invalidates the sample', gaze.combineEyes(good, null).valid, false);
}

console.log('\n=== resolution floor: too far from the camera means NO SIGNAL ===');
{
  const kp = (x, y, score = 0.9) => ({ x, y, score });
  // interocular 20px — fine for head pose, useless for an iris.
  const tooSmall = gaze.eyeRoiBoxes([kp(0, 0), kp(210, 100), kp(190, 100)]);
  check('20px interocular is rejected', tooSmall.invalid, gaze.GAZE_INVALID.FACE_TOO_SMALL);

  const ok = gaze.eyeRoiBoxes([kp(0, 0), kp(230, 100), kp(170, 100)]);
  check('60px interocular is accepted', ok.invalid, undefined);
  check('interocular is measured correctly', ok.interocular, 60);
  checkTrue('eye box is sized off interocular (scale-invariant)', ok.left.w === Math.round(60 * 0.62));

  const lowScore = gaze.eyeRoiBoxes([kp(0, 0), kp(230, 100, 0.2), kp(170, 100)]);
  check('a low-confidence eye keypoint is rejected', lowScore.invalid, gaze.GAZE_INVALID.LOW_CONFIDENCE);

  checkTrue('the floor is meaningfully above the pose floor of 12px',
    gaze.DEFAULT_GAZE_OPTS.minInterocularPx >= 40);
}

// ===========================================================================
// Analyzer-level behaviour. This is where "unknown is not deviant" is proven.
// ===========================================================================

const NEUTRAL_HEAD = { calibrated: true, smoothedExcursion: 0.1 };
const TURNED_HEAD = { calibrated: true, smoothedExcursion: 1.4 };

/** Feed n frames spaced dtMs apart, collecting every event emitted. */
function run(analyzer, makeSample, head, frames, dtMs = 100, t0 = 1000) {
  const events = [];
  let last = null;
  for (let i = 0; i < frames; i++) {
    const t = t0 + i * dtMs;
    last = analyzer.process(makeSample(i), head, t);
    events.push(...last.events);
  }
  return { events, last };
}

const sampleAt = (h, v) => () => ({ valid: true, reason: null, gazeH: h, gazeV: v });
const closedSample = () => ({ valid: false, reason: gaze.GAZE_INVALID.EYE_CLOSED, gazeH: 0, gazeV: 0 });

console.log('\n=== a student with their eyes SHUT is never reported ===');
{
  const a = new gaze.GazeAnalyzer();
  // 30 seconds of shut eyes — far past every dwell threshold in the module.
  const { events, last } = run(a, closedSample, NEUTRAL_HEAD, 300);
  check('sustained closed eyes emit ZERO events', events.length, 0);
  check('status says eyes_closed, not alert', last.status, 'eyes_closed');
  check('closed eyes never calibrate a bogus neutral', last.calibrated, false);
}

console.log('\n=== calibration, then a neutral student ===');
{
  const a = new gaze.GazeAnalyzer();
  const { events, last } = run(a, sampleAt(0.02, -0.01), NEUTRAL_HEAD, 200);
  check('a still, forward-looking student is calibrated', last.calibrated, true);
  check('a still, forward-looking student emits ZERO events', events.length, 0);
  check('status is ok', last.status, 'ok');
}

console.log('\n=== sustained off-axis gaze IS reported ===');
{
  const a = new gaze.GazeAnalyzer();
  run(a, sampleAt(0.0, 0.0), NEUTRAL_HEAD, 80);          // calibrate at neutral
  checkTrue('calibrated before the excursion', a.isCalibrated());

  const { events } = run(a, sampleAt(0.45, 0.0), NEUTRAL_HEAD, 60, 100, 9000);
  checkTrue('a sustained hard-left gaze is reported', events.length > 0);

  const alert = events.filter((e) => e.severity === 'MEDIUM');
  checkTrue('it reaches the sustained tier', alert.length > 0);
  check('the condition is GAZE_OFF_SCREEN', events[0].condition, gaze.GazeCondition.GAZE_OFF_SCREEN);
  // Capped by design: this signal is coarse, so it never reaches CRITICAL.
  check('no event is ever CRITICAL', events.filter((e) => e.severity === 'CRITICAL').length, 0);
  check('no event is ever HIGH', events.filter((e) => e.severity === 'HIGH').length, 0);
}

console.log('\n=== a brief glance is NOT reported ===');
{
  const a = new gaze.GazeAnalyzer();
  run(a, sampleAt(0.0, 0.0), NEUTRAL_HEAD, 80);
  // 800 ms off-axis — under the 2000 ms glance threshold.
  const { events } = run(a, sampleAt(0.45, 0.0), NEUTRAL_HEAD, 8, 100, 9000);
  check('a sub-second glance emits nothing', events.length, 0);
}

console.log('\n=== gaze stands down when the head has turned ===');
{
  const a = new gaze.GazeAnalyzer();
  run(a, sampleAt(0.0, 0.0), NEUTRAL_HEAD, 80);
  const { events, last } = run(a, sampleAt(0.6, 0.0), TURNED_HEAD, 100, 100, 9000);
  check('a turned head yields ZERO gaze events', events.length, 0);
  check('status explains why', last.status, 'head_off_neutral');
  check('reason is recorded for telemetry', last.reason, gaze.GAZE_INVALID.HEAD_OFF_NEUTRAL);
}

console.log('\n=== blinking mid-episode cannot manufacture an alert ===');
{
  // Alternating open-neutral / closed frames. Neither is deviant, and the
  // closed ones are UNKNOWN. Nothing here may ever accumulate into an event.
  const a = new gaze.GazeAnalyzer();
  const { events } = run(a, (i) => (i % 4 === 0 ? closedSample() : { valid: true, reason: null, gazeH: 0.01, gazeV: 0 }),
    NEUTRAL_HEAD, 300);
  check('a blinking student emits ZERO events', events.length, 0);
}

console.log('\n=== reporting is suppressed while a liveness challenge is up ===');
{
  const a = new gaze.GazeAnalyzer();
  run(a, sampleAt(0.0, 0.0), NEUTRAL_HEAD, 80);

  const events = [];
  for (let i = 0; i < 60; i++) {
    // The corner dot ORDERS an off-axis look; reporting it would punish
    // compliance. Suppression is at the reporting layer only.
    const r = a.process({ valid: true, reason: null, gazeH: 0.5, gazeV: 0 }, NEUTRAL_HEAD, 9000 + i * 100, true);
    events.push(...r.events);
  }
  check('no events while suppressed', events.length, 0);
  checkTrue('but the gate still ran underneath', a.gate.state !== 'idle');
}

console.log('\n=== reset clears everything ===');
{
  const a = new gaze.GazeAnalyzer();
  run(a, sampleAt(0.0, 0.0), NEUTRAL_HEAD, 80);
  checkTrue('calibrated before reset', a.isCalibrated());
  a.reset();
  check('not calibrated after reset', a.isCalibrated(), false);
  check('snapshot reflects the reset', a.snapshot().calibrated, false);
}

// ---------------------------------------------------------------------------
console.log(`\n${'-'.repeat(60)}`);
console.log(failures === 0
  ? `All ${checks} checks passed.`
  : `${failures} of ${checks} checks FAILED.`);
process.exit(failures === 0 ? 0 : 1);
