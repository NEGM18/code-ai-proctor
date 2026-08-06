// Tests for the EAR Veto Gate (cascading safeguard).
//
//   node extension/test/ear_veto.test.js
//
// THE REQUIRED ASSERTION: a primary model emitting LOOKING_AWAY, paired with
// EAR < 0.20, emits ZERO cheating events — sustained over 30 seconds.
//
// Two properties beyond that carry the safety of the module, and both are
// asserted by name rather than by category, because a silent typo in the
// allowlist would fail in exactly the direction that matters:
//
//   1. Types NOT on the allowlist are reported even at EAR 0.15. A phone is a
//      phone whether or not the student blinked, and NO_FACE_DETECTED must
//      survive so that covering the camera is not a way to silence it.
//   2. An unavailable or stale EAR FAILS OPEN. Fail-closed would be a
//      suppression exploit far more attractive than the false positive this
//      gate prevents.

const veto = require('../content/vision/ear_veto.js');
const gl = require('../content/vision/gaze_landmarks.js');

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}
const checkTrue = (name, cond) => check(name, !!cond, true);

const C = gl.LANDMARK_CONTRACT;

/** Minimal landmark set carrying a chosen EAR per eye. EAR = open / width. */
function landmarksWithEar(leftEar, rightEar = leftEar, width = 40) {
  const pts = new Array(C.pointCount);
  const put = (idx, cx, ear) => {
    const open = ear * width;
    pts[idx.upperLid] = { x: cx, y: 100 - open / 2 };
    pts[idx.lowerLid] = { x: cx, y: 100 + open / 2 };
    pts[idx.inner] = { x: cx - width / 2, y: 100 };
    pts[idx.outer] = { x: cx + width / 2, y: 100 };
  };
  put(C.right, 200, rightEar);
  put(C.left, 300, leftEar);
  return pts;
}

/**
 * A stand-in for the reporting layer. Mirrors monitor.js reportViolation():
 * consult the gate first, drop on veto, otherwise record.
 */
function makeReporter(gate) {
  const reported = [];
  const vetoed = [];
  return {
    reported,
    vetoed,
    report(type, nowMs) {
      const v = gate.evaluate(type, nowMs);
      if (v.veto) { vetoed.push({ type, ear: v.ear }); return false; }
      reported.push({ type, ear: v.ear, reason: v.reason });
      return true;
    },
  };
}

// ===========================================================================
console.log('=== THE REQUIRED ASSERTION: LOOKING_AWAY + EAR < 0.20 => ZERO events ===');
{
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);

  // 30 s at 10 FPS. The primary model insists on LOOKING_AWAY the entire time.
  for (let i = 0; i < 300; i++) {
    const t = 1000 + i * 100;
    gate.submitLandmarks(landmarksWithEar(0.15), t);
    r.report('GAZE_OFF_SCREEN', t);
    r.report('SIDE_GAZE_PEEKING', t);
  }

  check('30 s of LOOKING_AWAY with closed eyes emits ZERO events', r.reported.length, 0);
  check('every one of them was vetoed instead', r.vetoed.length, 600);
  check('telemetry counts the vetoes', gate.telemetry().vetoed, 600);
  check('and confirms nothing', gate.telemetry().confirmed, 0);
}

console.log('\n=== eyes OPEN confirms the same violation ===');
{
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);
  for (let i = 0; i < 50; i++) {
    const t = 1000 + i * 100;
    gate.submitLandmarks(landmarksWithEar(0.30), t);
    r.report('GAZE_OFF_SCREEN', t);
  }
  check('an open-eyed off-screen gaze IS reported', r.reported.length, 50);
  check('nothing was vetoed', r.vetoed.length, 0);
  check('the confirming EAR is attached', r.reported[0].ear, 0.3);
  check('and labelled as a real check', r.reported[0].reason, veto.VETO_REASON.EYES_OPEN);
}

console.log('\n=== the 0.20 threshold, both sides ===');
{
  check('threshold is exactly 0.20 as specified', veto.DEFAULT_VETO_OPTS.earThreshold, 0.20);

  const gate = new veto.EarVetoGate();
  gate.submitLandmarks(landmarksWithEar(0.19), 1000);
  check('EAR 0.19 vetoes', gate.evaluate('GAZE_OFF_SCREEN', 1000).veto, true);

  gate.submitLandmarks(landmarksWithEar(0.21), 2000);
  check('EAR 0.21 confirms', gate.evaluate('GAZE_OFF_SCREEN', 2000).veto, false);

  gate.submitLandmarks(landmarksWithEar(0.20), 3000);
  check('EAR exactly 0.20 confirms (>= is open, per spec)',
    gate.evaluate('GAZE_OFF_SCREEN', 3000).veto, false);
}

console.log('\n=== ⚠ THE ALLOWLIST: what a blink may and may not silence ===');
{
  const gate = new veto.EarVetoGate();
  gate.submitLandmarks(landmarksWithEar(0.05), 1000);   // eyes firmly shut

  for (const type of veto.VETOABLE_VIOLATIONS) {
    check(`${type} is vetoed while eyes are shut`, gate.evaluate(type, 1000).veto, true);
  }

  // The important half. Every one of these must survive a blink.
  for (const type of veto.NEVER_VETOABLE) {
    check(`${type} is REPORTED despite closed eyes`, gate.evaluate(type, 1000).veto, false);
  }

  // Called out individually because they are the two that matter most.
  check('PHONE_DETECTED is never vetoable', gate.isVetoable('PHONE_DETECTED'), false);
  check('NO_FACE_DETECTED is never vetoable', gate.isVetoable('NO_FACE_DETECTED'), false);
  checkTrue('covering the camera cannot silence NO_FACE_DETECTED',
    !gate.evaluate('NO_FACE_DETECTED', 1000).veto);

  // The two lists must not overlap, or the allowlist is self-contradictory.
  const overlap = veto.VETOABLE_VIOLATIONS.filter((t) => veto.NEVER_VETOABLE.includes(t));
  check('the two lists are disjoint', overlap, []);

  // An unknown/future type is NOT vetoable by default. New detectors must opt
  // in deliberately; inheriting suppression by accident is the wrong default.
  check('an unrecognised type is not vetoable', gate.isVetoable('SOME_FUTURE_VIOLATION'), false);
}

console.log('\n=== ⚠ FAIL-OPEN when EAR is unavailable ===');
{
  // No landmarks ever submitted — today's production state, since pose.onnx
  // has no eyelid points.
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);
  for (let i = 0; i < 100; i++) r.report('GAZE_OFF_SCREEN', 1000 + i * 100);

  check('with no landmarks, every violation is reported', r.reported.length, 100);
  check('nothing is vetoed', r.vetoed.length, 0);
  check('the reason says why', r.reported[0].reason, veto.VETO_REASON.NO_SAMPLE);
  check('and it is counted as a fail-open for field monitoring',
    gate.telemetry().failedOpen, 100);

  // Landmark decode that yields nothing usable behaves identically.
  const g2 = new veto.EarVetoGate();
  check('submitting null returns NaN', Number.isNaN(g2.submitLandmarks(null, 1000)), true);
  check('an empty landmark array is not a sample',
    Number.isNaN(g2.submitLandmarks([], 1000)), true);
  check('and the violation still reports', g2.evaluate('GAZE_OFF_SCREEN', 1000).veto, false);
}

console.log('\n=== ⚠ a STALE reading cannot license suppression ===');
{
  const gate = new veto.EarVetoGate();
  gate.submitLandmarks(landmarksWithEar(0.05), 1000);   // eyes shut at t=1000

  check('fresh: vetoes', gate.evaluate('GAZE_OFF_SCREEN', 1200).veto, true);
  check('at the 500 ms boundary: still vetoes', gate.evaluate('GAZE_OFF_SCREEN', 1500).veto, true);

  // 3 s later that reading says nothing about now.
  const stale = gate.evaluate('GAZE_OFF_SCREEN', 4000);
  check('3 s old: does NOT veto', stale.veto, false);
  check('and is flagged stale', stale.stale, true);
  check('with the reason recorded', stale.reason, veto.VETO_REASON.STALE);
  check('max age is 500 ms', veto.DEFAULT_VETO_OPTS.maxAgeMs, 500);
}

console.log('\n=== one closed eye is enough to veto ===');
{
  const gate = new veto.EarVetoGate();
  // Left eye wide open, right eye shut. The MEAN would be ~0.19; the MIN is
  // 0.04. Blink immunity is not a per-eye property.
  gate.submitLandmarks(landmarksWithEar(0.34, 0.04), 1000);
  check('one shut eye vetoes', gate.evaluate('GAZE_OFF_SCREEN', 1000).veto, true);
  check('the asymmetry is visible in telemetry', gate.telemetry().oneEyeClosedSamples, 1);

  const both = veto.computeFaceEar(landmarksWithEar(0.34, 0.04));
  checkTrue('computeFaceEar returns the MIN, not the mean', Math.abs(both.ear - 0.04) < 1e-9);
}

console.log('\n=== THE CLASSIFIER AS A PRIMARY DETECTOR ===');
{
  // The requested rule: trust best.onnx's cheating verdict, EXCEPT when
  // MediaPipe says the eyes are closed.
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);

  checkTrue('AI_CHEATING_CLASSIFIER is vetoable',
    veto.VETOABLE_VIOLATIONS.includes('AI_CHEATING_CLASSIFIER'));

  // Eyes open: the classifier's verdict stands.
  gate.submitLandmarks(landmarksWithEar(0.30), 1000);
  check('classifier alert with eyes OPEN is reported',
    r.report('AI_CHEATING_CLASSIFIER', 1000), true);

  // Eyes closed: the one exception.
  gate.submitLandmarks(landmarksWithEar(0.12), 2000);
  check('classifier alert with eyes CLOSED is vetoed',
    r.report('AI_CHEATING_CLASSIFIER', 2000), false);

  // Sustained: 30 s of the classifier insisting on cheating, eyes shut throughout.
  const g2 = new veto.EarVetoGate();
  const r2 = makeReporter(g2);
  for (let i = 0; i < 300; i++) {
    const t = 1000 + i * 100;
    g2.submitLandmarks(landmarksWithEar(0.10), t);
    r2.report('AI_CHEATING_CLASSIFIER', t);
  }
  check('30 s of classifier-says-cheating with closed eyes emits ZERO events',
    r2.reported.length, 0);
}

console.log('\n=== ⚠ hasFreshSample(): promotion must not outrun the safeguard ===');
{
  // "Trust the classifier EXCEPT when the eyes are closed" is unimplementable
  // when nothing can see the eyes. Because the veto fails open, promoting the
  // classifier without live landmarks would reinstate the exact false positive
  // the exception exists to prevent. monitor.js gates promotion on this.
  const gate = new veto.EarVetoGate();
  check('no landmarks: the safeguard is NOT live', gate.hasFreshSample(1000), false);

  gate.submitLandmarks(landmarksWithEar(0.30), 1000);
  check('fresh landmarks: the safeguard IS live', gate.hasFreshSample(1200), true);
  check('a stale sample is NOT live', gate.hasFreshSample(9000), false);

  // The distinction that matters: "eyes are open" and "we cannot see the eyes"
  // both make eyesVerifiablyClosed() false, but only one means we are protected.
  const blind = new veto.EarVetoGate();
  check('blind gate: eyesVerifiablyClosed is false', blind.eyesVerifiablyClosed(1000), false);
  check('blind gate: but it is NOT live either', blind.hasFreshSample(1000), false);
  checkTrue('so the two must be checked separately, not inferred from each other',
    blind.eyesVerifiablyClosed(1000) === false && blind.hasFreshSample(1000) === false);
}

console.log('\n=== eyesVerifiablyClosed() (used to withhold classifier escalation) ===');
{
  const gate = new veto.EarVetoGate();
  check('unknown is NOT "closed"', gate.eyesVerifiablyClosed(1000), false);

  gate.submitLandmarks(landmarksWithEar(0.05), 1000);
  check('a fresh shut reading is "closed"', gate.eyesVerifiablyClosed(1100), true);
  check('a stale shut reading is NOT "closed"', gate.eyesVerifiablyClosed(9000), false);

  gate.submitLandmarks(landmarksWithEar(0.30), 9000);
  check('an open reading is NOT "closed"', gate.eyesVerifiablyClosed(9100), false);

  // It is deliberately not the negation of "open": it must be false when we
  // cannot tell, so callers inherit fail-open for free.
  const fresh = new veto.EarVetoGate();
  check('no data means not-closed, so nothing is suppressed',
    fresh.eyesVerifiablyClosed(1), false);
}

console.log('\n=== a blink mid-violation vetoes only the blinking frames ===');
{
  // Realistic sequence: the student genuinely looks away, blinking naturally.
  // Blinks must not suppress the whole episode, only the frames they cover.
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);
  for (let i = 0; i < 100; i++) {
    const t = 1000 + i * 100;
    gate.submitLandmarks(landmarksWithEar(i % 20 < 2 ? 0.08 : 0.30), t);
    r.report('GAZE_OFF_SCREEN', t);
  }
  check('blinking frames are vetoed', r.vetoed.length, 10);
  check('open frames still report', r.reported.length, 90);
}

console.log('\n=== reset clears the gate ===');
{
  const gate = new veto.EarVetoGate();
  gate.submitLandmarks(landmarksWithEar(0.05), 1000);
  gate.evaluate('GAZE_OFF_SCREEN', 1000);
  checkTrue('has state before reset', gate.telemetry().vetoed === 1);
  gate.reset();
  check('EAR cleared', gate.telemetry().ear, null);
  check('counters cleared', gate.telemetry().vetoed, 0);
  check('and it fails open again', gate.evaluate('GAZE_OFF_SCREEN', 1000).veto, false);
}

// ---------------------------------------------------------------------------
console.log(`\n${'-'.repeat(60)}`);
console.log(failures === 0
  ? `All ${checks} checks passed.`
  : `${failures} of ${checks} checks FAILED.`);
process.exit(failures === 0 ? 0 : 1);
