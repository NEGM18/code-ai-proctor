// ABSOLUTE BLINK & CLOSURE IMMUNITY — end-to-end proof.
//
//   node extension/test/blink_immunity.test.js
//
// Architectural rule 3: "Closed, blinking, or resting eyes are benign ('no
// reading activity') and MUST NEVER produce a cheating alert."
//
// The existing suites each prove one HALF of that in isolation —
// gaze_landmarks.test.js shows the analyser emits nothing on a shut eye, and
// ear_veto.test.js shows the gate suppresses what a detector hands it. Neither
// runs the detectors THROUGH the gate, so neither would catch a regression
// where a detector is wired to a reporting path that skips the veto.
//
// This one drives the real analysers, the real veto gate and a stand-in for
// monitor.js's reportViolation() together, for 30 simulated seconds, at both
// tier cadences.
//
// ⚠ IT ALSO PROVES THE INVERSE. Immunity that swallows everything is not a
// safeguard, it is an off switch: covering the camera must not become a way to
// silence the detector built to catch it. So the never-vetoable set is asserted
// BY NAME to still fire with the eyes shut, and open eyes must still report.

const veto = require('../content/vision/ear_veto.js');
const gl = require('../content/vision/gaze_landmarks.js');
const roi = require('../content/vision/gaze_roi.js');

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

// --- synthetic face ---------------------------------------------------------
// Same construction gaze_landmarks.test.js uses, so EAR = V/H is exact rather
// than fitted. `h` is the horizontal iris position along the eye axis: 0.5 is
// centre, 0.02 is a hard side-glance.
function eye(cx, width, open, h, mirrored) {
  const x0 = cx - width / 2;
  const x1 = cx + width / 2;
  return {
    upperLid: { x: cx, y: 100 - open / 2 },
    lowerLid: { x: cx, y: 100 + open / 2 },
    inner: { x: mirrored ? x0 : x1, y: 100 },
    outer: { x: mirrored ? x1 : x0, y: 100 },
    iris: { x: x0 + h * width, y: 100 },
  };
}
function face({ ear = 0.30, h = 0.5, width = 40 } = {}) {
  const open = ear * width;
  const pts = new Array(C.pointCount);
  const put = (idx, e) => {
    pts[idx.upperLid] = e.upperLid;
    pts[idx.lowerLid] = e.lowerLid;
    pts[idx.inner] = e.inner;
    pts[idx.outer] = e.outer;
    pts[idx.iris] = e.iris;
  };
  put(C.right, eye(200, width, open, h, false));
  put(C.left, eye(300, width, open, h, true));
  return pts;
}

const NEUTRAL_HEAD = {
  calibrated: true,
  smoothedExcursion: 0.1,
  deviation: { yawDeg: 2, pitchDeg: 1 },
};

/** Stand-in for monitor.js reportViolation(): veto first, then record. */
function makeReporter(gate) {
  const reported = [];
  const suppressed = [];
  return {
    reported,
    suppressed,
    report(type, nowMs) {
      const v = gate.evaluate(type, nowMs);
      if (v.veto) {
        // monitor.js logs "vetoed by EAR safeguard" here and returns.
        suppressed.push({ type, reason: v.reason });
        return false;
      }
      reported.push({ type, reason: v.reason });
      return true;
    },
  };
}

/** Tier A ~20 FPS and Tier B ~9 FPS. 30 s at each. */
const CADENCES = [
  { name: 'Tier A (20 FPS)', dt: 50, frames: 600 },
  { name: 'Tier B (9 FPS)', dt: 111, frames: 271 },
];

// ===========================================================================
console.log('=== 30 s OF FULLY CLOSED EYES, LANDMARK CHANNEL ===');
// ===========================================================================
for (const cad of CADENCES) {
  const gate = new veto.EarVetoGate();
  const analyzer = new gl.GazeLandmarkAnalyzer();
  const r = makeReporter(gate);
  let emitted = 0;

  for (let i = 0; i < cad.frames; i++) {
    const t = 1000 + i * cad.dt;
    const pts = face({ ear: 0.05, h: 0.02 });   // shut, and iris hard off-axis

    gate.submitLandmarks(pts, t);
    const res = analyzer.process(pts, NEUTRAL_HEAD, t);
    emitted += res.events.length;
    for (const ev of res.events) r.report('SIDE_GAZE_PEEKING', t);

    // Every other eye detector in the system also insists on cheating.
    r.report('GAZE_OFF_SCREEN', t);
    r.report('AI_CHEATING_CLASSIFIER', t);
  }

  check(`${cad.name}: analyser emits nothing on a shut eye`, emitted, 0);
  check(`${cad.name}: ZERO alerts reach the teacher`, r.reported.length, 0);
  checkTrue(`${cad.name}: everything attempted was suppressed`, r.suppressed.length > 0);
  check(`${cad.name}: gaze never calibrated a bogus neutral`, analyzer.isCalibrated(), false);
  check(`${cad.name}: the dwell gate never left idle`, analyzer.gate.state, 'idle');
  check(`${cad.name}: veto never fell back to fail-open`, gate.telemetry().failedOpen, 0);
}

// ===========================================================================
console.log('\n=== 30 s OF CLOSED EYES ON THE COARSE PIXEL CHANNEL ONLY ===');
// ===========================================================================
// The state the product is ACTUALLY in today: pose.onnx is COCO-17, so there
// are no eyelid landmarks and the landmark EAR is unavailable. Without the
// closure hint every evaluate() fails open and rule 3 holds only vacuously.
{
  const gate = new veto.EarVetoGate();
  const gazeRoi = new roi.GazeAnalyzer();
  const r = makeReporter(gate);
  let emitted = 0;

  for (let i = 0; i < 300; i++) {
    const t = 1000 + i * 100;
    // No landmarks at all — exactly today's pipeline.
    gate.submitLandmarks(null, t);
    gate.submitClosureHint(true, t);

    const sample = { valid: false, reason: 'eye_closed', gazeH: 0, gazeV: 0 };
    const res = gazeRoi.process(sample, NEUTRAL_HEAD, t);
    emitted += res.events.length;

    r.report('GAZE_OFF_SCREEN', t);
    r.report('SIDE_GAZE_PEEKING', t);
    r.report('AI_CHEATING_CLASSIFIER', t);
  }

  check('gaze_roi emits nothing on a shut eye', emitted, 0);
  check('ZERO alerts reach the teacher', r.reported.length, 0);
  check('all 900 attempts were suppressed', r.suppressed.length, 900);
  check('suppression is attributed to the coarse channel',
    r.suppressed[0].reason, veto.VETO_REASON.CLOSURE_HINT);
  check('telemetry separates the coarse vetoes', gate.telemetry().closureHintVetoes, 900);
  check('nothing failed open', gate.telemetry().failedOpen, 0);

  // ⚠ THE LOAD-BEARING LIMIT. The coarse channel buys SUPPRESSION, never
  // permission to accuse. hasFreshSample() gates classifierMayAlertAlone(), so
  // if this ever returns true the classifier gets promoted to a primary accuser
  // on the strength of a signal explicitly too coarse to license accusations.
  check('coarse channel does NOT satisfy hasFreshSample()',
    gate.hasFreshSample(1000 + 299 * 100), false);
  checkTrue('…but it does answer eyesVerifiablyClosed()',
    gate.eyesVerifiablyClosed(1000 + 299 * 100));
}

// ===========================================================================
console.log('\n=== A REALISTIC BLINK TRAIN IS NOT AN OFF SWITCH ===');
// ===========================================================================
// ~150 ms closures every 4 s over 30 s. The eyes are open for the vast majority
// of the time, so a genuine sustained off-screen gaze must still be reported —
// suppression that outlives the blink would be a silencing exploit.
{
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);
  let closedFrames = 0;

  for (let i = 0; i < 300; i++) {
    const t = 1000 + i * 100;
    const blinking = ((i * 100) % 4000) < 150;
    if (blinking) closedFrames++;
    gate.submitLandmarks(face({ ear: blinking ? 0.08 : 0.31 }), t);
    r.report('GAZE_OFF_SCREEN', t);
  }

  checkTrue('the student really did blink', closedFrames > 0);
  check('blinks were suppressed', r.suppressed.length, closedFrames);
  check('open-eye frames were reported', r.reported.length, 300 - closedFrames);
  checkTrue('the overwhelming majority still reported', r.reported.length > 280);
  check('open-eye reports are attributed to eyes-open',
    r.reported[r.reported.length - 1].reason, veto.VETO_REASON.EYES_OPEN);
}

// ===========================================================================
console.log('\n=== ⚠ IMMUNITY IS NOT AN OFF SWITCH: never-vetoable still fires ===');
// ===========================================================================
// Asserted BY NAME. NO_FACE_DETECTED is the sharpest case: covering the camera
// destroys the landmarks, so vetoing it would turn camera-covering into a way
// to silence the detector built to catch it.
{
  const NEVER = [
    'PHONE_DETECTED', 'NO_FACE_DETECTED', 'MULTIPLE_FACES', 'SECONDARY_DEVICE',
    'AI_CHEATING_POSE', 'HEAD_POSE_GLANCE', 'FULLSCREEN_EXIT',
    'SCREEN_SHARE_STOPPED', 'TAB_SWITCH', 'WINDOW_BLUR', 'VISIBILITY_HIDDEN',
    'LIVENESS_FAILED', 'CAMERA_FEED_SYNTHETIC',
  ];

  // Both channels screaming "eyes shut" at once — the most suppression-friendly
  // state the gate can ever be in.
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);
  for (let i = 0; i < 300; i++) {
    const t = 1000 + i * 100;
    gate.submitLandmarks(face({ ear: 0.02 }), t);
    gate.submitClosureHint(true, t);
    if (i === 299) for (const type of NEVER) r.report(type, t);
  }

  check('every never-vetoable type still fired', r.reported.length, NEVER.length);
  for (const type of NEVER) {
    checkTrue(`${type} survives 30 s of closed eyes`,
      r.reported.some((x) => x.type === type));
  }
  check('none of them were suppressed', r.suppressed.length, 0);

  // And the two lists cannot silently overlap.
  for (const type of NEVER) {
    check(`${type} is not on the vetoable allowlist`,
      veto.VETOABLE_VIOLATIONS.indexOf(type), -1);
  }
  checkTrue('the allowlist is eye-related only',
    veto.VETOABLE_VIOLATIONS.every((t) => /GAZE|CLASSIFIER/.test(t)));
}

// ===========================================================================
console.log('\n=== fail-open survives: no signal at all suppresses nothing ===');
// ===========================================================================
// A suppression exploit is a worse failure than the false positive the gate
// prevents. With neither channel reading, every report must go through.
{
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);
  for (let i = 0; i < 100; i++) {
    const t = 1000 + i * 100;
    gate.submitLandmarks(null, t);
    gate.submitClosureHint(null, t);     // unreadable, records nothing
    r.report('GAZE_OFF_SCREEN', t);
  }
  check('all 100 reported', r.reported.length, 100);
  check('nothing suppressed', r.suppressed.length, 0);
  check('all 100 counted as fail-open', gate.telemetry().failedOpen, 100);

  // A stale "closed" must not license suppression forever.
  const g2 = new veto.EarVetoGate();
  const r2 = makeReporter(g2);
  g2.submitClosureHint(true, 1000);
  r2.report('GAZE_OFF_SCREEN', 1200);          // within maxAgeMs 500
  r2.report('GAZE_OFF_SCREEN', 5000);          // long stale
  check('fresh closure suppresses', r2.suppressed.length, 1);
  check('stale closure fails open', r2.reported.length, 1);
}

// ===========================================================================
console.log('\n=== a fresh landmark EAR outranks the coarse channel ===');
// ===========================================================================
// The pixel hint can only ADD suppression where the better instrument is
// silent. It must never override a landmark reading that says "open", or a
// flaky pixel gate would start eating legitimate alerts.
{
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);
  gate.submitLandmarks(face({ ear: 0.35 }), 1000);   // eyes clearly OPEN
  gate.submitClosureHint(true, 1000);                // pixel gate disagrees
  r.report('GAZE_OFF_SCREEN', 1050);
  check('landmark EAR wins: the alert is reported', r.reported.length, 1);
  check('and attributed to eyes-open', r.reported[0].reason, veto.VETO_REASON.EYES_OPEN);
  check('eyesVerifiablyClosed() follows the landmarks', gate.eyesVerifiablyClosed(1050), false);
}

console.log(`\n${checks} checks — ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
