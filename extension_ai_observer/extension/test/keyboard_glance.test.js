// KEYBOARD & DOWNWARD GAZE VETO — unit + episode tests.
//
//   node extension/test/keyboard_glance.test.js
//
// The trained classifier over-flags students looking down at their keyboard.
// Looking down at a keyboard is the most common benign behaviour in a typed
// exam, so flagging it accuses students of cheating for typing badly.
//
// THE TWO ASSERTIONS THE BRIEF NAMES:
//   * looking down at the keyboard for 3 s  -> ZERO alerts
//   * looking left/right for 2 s            -> an alert IS dispatched
//
// ⚠ The rest of this file exists because a veto that only does the first is an
// off switch, not a safeguard. Rule 2 classifies on EAR alone, which on its own
// would hand blanket immunity to any student whose RESTING eyelid aperture sits
// in the 0.14-0.22 band — so the side-peek override, the 5 s permit ceiling and
// the anti-bypass cap are all pinned by name below.

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

const G = veto.GLANCE_CLASS;
const K = veto.KEYBOARD_VETO_DEFAULTS;
const C = gl.LANDMARK_CONTRACT;

// --- synthetic geometry -----------------------------------------------------
// `hRatio`/`vRatio` are what gaze_landmarks.js emits: 0..1 along each eye axis.
// The centred offsets the spec uses are ratio - 0.5.
const sample = (o = {}) => ({
  valid: true, ear: 0.30, hRatio: 0.5, vRatio: 0.5, ...o,
});
/** Build from the spec's centred offsets instead. */
const off = ({ h = 0, v = 0, ear = 0.30 } = {}) =>
  sample({ hRatio: 0.5 + h, vRatio: 0.5 + v, ear });

const klassOf = (s) => veto.classifyGlance(s).klass;

// --- a real 478-point face, so the gate runs its real geometry ---------------
function eye(cx, width, open, h, v, mirrored) {
  const x0 = cx - width / 2;
  const x1 = cx + width / 2;
  const yTop = 100 - open / 2;
  return {
    upperLid: { x: cx, y: yTop },
    lowerLid: { x: cx, y: 100 + open / 2 },
    inner: { x: mirrored ? x0 : x1, y: 100 },
    outer: { x: mirrored ? x1 : x0, y: 100 },
    iris: { x: x0 + h * width, y: yTop + v * open },
  };
}
/** h/v are 0..1 ratios: h 0.5 = centred, v 0.5 = mid-lid, v 0.8 = looking down. */
function face({ ear = 0.30, h = 0.5, v = 0.5, width = 40 } = {}) {
  const open = ear * width;
  const pts = new Array(C.pointCount);
  const put = (idx, e) => {
    pts[idx.upperLid] = e.upperLid;
    pts[idx.lowerLid] = e.lowerLid;
    pts[idx.inner] = e.inner;
    pts[idx.outer] = e.outer;
    pts[idx.iris] = e.iris;
  };
  put(C.right, eye(200, width, open, h, v, false));
  put(C.left, eye(300, width, open, h, v, true));
  return pts;
}

const KEYBOARD_FACE = face({ ear: 0.30, h: 0.50, v: 0.80 });  // centred, looking down
const SIDE_FACE = face({ ear: 0.30, h: 0.15, v: 0.50 });      // hard left peek

/** Stand-in for monitor.js reportViolation(): veto first, then record. */
function makeReporter(gate) {
  const reported = [];
  const suppressed = [];
  return {
    reported,
    suppressed,
    report(type, nowMs) {
      const v = gate.evaluate(type, nowMs);
      if (v.veto) { suppressed.push({ type, reason: v.reason }); return false; }
      reported.push({ type, reason: v.reason });
      return true;
    },
  };
}

/**
 * Drive `gate` at 20 FPS for `ms`, feeding `landmarks` every frame and
 * attempting one GAZE_OFF_SCREEN report per frame past `alertAfterMs` — the
 * point at which the dwell gate would have produced an event.
 */
function runGlance(gate, r, landmarks, fromMs, ms, alertAfterMs = 1500) {
  const dt = 50;
  let t = fromMs;
  for (; t < fromMs + ms; t += dt) {
    gate.submitLandmarks(landmarks, t);
    if ((t - fromMs) >= alertAfterMs) r.report('GAZE_OFF_SCREEN', t);
  }
  return t;
}

// ===========================================================================
console.log('=== ⭐ THE REQUIRED ASSERTION 1: 3 s at the keyboard => ZERO alerts ===');
// ===========================================================================
{
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);
  runGlance(gate, r, KEYBOARD_FACE, 1000, 3000);

  check('3 s of keyboard glance emits ZERO alerts', r.reported.length, 0);
  checkTrue('…and every attempt was suppressed', r.suppressed.length > 0);
  check('…attributed to the keyboard safeguard',
    r.suppressed[0].reason, veto.VETO_REASON.KEYBOARD_GLANCE);
  check('classified as KEYBOARD_GLANCE',
    gate.telemetry().lastGlanceClass, G.KEYBOARD_GLANCE);
  check('the eyes were never treated as closed', gate.telemetry().vetoed, r.suppressed.length);
}

// ===========================================================================
console.log('\n=== ⭐ THE REQUIRED ASSERTION 2: 2 s looking sideways => ALERT ===');
// ===========================================================================
{
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);
  runGlance(gate, r, SIDE_FACE, 1000, 2000);

  checkTrue('2 s of side gaze IS dispatched', r.reported.length > 0);
  check('nothing was suppressed', r.suppressed.length, 0);
  check('reported as eyes-open', r.reported[0].reason, veto.VETO_REASON.EYES_OPEN);
  check('classified as SIDE_PEEK', gate.telemetry().lastGlanceClass, G.SIDE_PEEK);
  check('no permit was ever opened', gate.telemetry().keyboardPermit.active, false);
}

// ===========================================================================
console.log('\n=== thresholds are exactly as specified ===');
// ===========================================================================
check('maxHorizontalOffset', K.maxHorizontalOffset, 0.12);
check('minVerticalOffset', K.minVerticalOffset, 0.15);
check('lidDroopMinEar', K.lidDroopMinEar, 0.14);
check('lidDroopMaxEar', K.lidDroopMaxEar, 0.22);
check('sidePeekOffset', K.sidePeekOffset, 0.15);
check('permitMs', K.permitMs, 5000);

// ===========================================================================
console.log('\n=== RULE 1: pure vertical downward ===');
// ===========================================================================
check('centred + down 0.16 -> KEYBOARD_GLANCE', klassOf(off({ h: 0, v: 0.16 })), G.KEYBOARD_GLANCE);
check('h 0.119 + down -> KEYBOARD_GLANCE', klassOf(off({ h: 0.119, v: 0.20 })), G.KEYBOARD_GLANCE);
check('h -0.119 + down -> KEYBOARD_GLANCE', klassOf(off({ h: -0.119, v: 0.20 })), G.KEYBOARD_GLANCE);
// NOTE: the bound is `vOffset > 0.15`, but neither 0.15 nor 0.65 is exactly
// representable in binary floating point, so `(0.5 + 0.15) - 0.5` lands a
// fraction ABOVE 0.15. Testing "exactly 0.15" would be testing float
// representation, not the rule — so the bound is pinned either side instead.
check('v 0.1499 -> below the bound, not forgiven',
  klassOf(off({ h: 0, v: 0.1499 })), G.UNKNOWN);
check('v 0.1501 -> above the bound, forgiven',
  klassOf(off({ h: 0, v: 0.1501 })), G.KEYBOARD_GLANCE);
check('h 0.1201 -> rule 1 does not apply',
  klassOf(off({ h: 0.1201, v: 0.30 })), G.UNKNOWN);
check('h 0.1199 -> rule 1 applies',
  klassOf(off({ h: 0.1199, v: 0.30 })), G.KEYBOARD_GLANCE);

// ⚠ SIGN. verticalIrisRatio runs upper lid -> lower lid, so a POSITIVE offset
// is looking DOWN. If this ever inverts, the safeguard forgives upward glances
// and flags keyboard use — the exact opposite of its purpose.
check('looking UP is never a keyboard glance', klassOf(off({ h: 0, v: -0.30 })), G.UNKNOWN);
check('looking up hard is still not forgiven', klassOf(off({ h: 0, v: -0.45 })), G.UNKNOWN);

// ===========================================================================
console.log('\n=== RULE 2: EAR lid-droop confirmation ===');
// ===========================================================================
check('EAR 0.21, centred -> DESK_LOOKING', klassOf(off({ h: 0.02, v: 0.02, ear: 0.21 })), G.DESK_LOOKING);
check('EAR 0.14 boundary -> DESK_LOOKING', klassOf(off({ h: 0, v: 0, ear: 0.14 })), G.DESK_LOOKING);
check('EAR 0.22 boundary -> DESK_LOOKING', klassOf(off({ h: 0, v: 0, ear: 0.22 })), G.DESK_LOOKING);
check('EAR 0.13 is below the band', klassOf(off({ h: 0, v: 0, ear: 0.13 })), G.UNKNOWN);
check('EAR 0.23 is above the band', klassOf(off({ h: 0, v: 0, ear: 0.23 })), G.UNKNOWN);

// The 0.12-0.15 horizontal gap: not a clean vertical glance, not a side peek.
check('gap h 0.13 with a normal EAR -> UNKNOWN (reports)',
  klassOf(off({ h: 0.13, v: 0.30, ear: 0.30 })), G.UNKNOWN);
check('gap h 0.13 with a drooping EAR -> DESK_LOOKING',
  klassOf(off({ h: 0.13, v: 0.30, ear: 0.21 })), G.DESK_LOOKING);

// ===========================================================================
console.log('\n=== ⚠ PRECEDENCE: a side peek outranks BOTH rules ===');
// ===========================================================================
// The load-bearing property. Rule 2 as literally specified classifies on EAR
// alone; without this override, a student whose RESTING eyelid aperture happens
// to sit in the 0.14-0.22 band would have every eye violation suppressed,
// including a hard side-peek at their notes. Resting EAR varies with lid shape,
// age, epicanthic folds and ptosis, so that would be both a security hole and
// an arbitrary fairness advantage.
{
  check('side peek + drooping lids -> SIDE_PEEK, not DESK_LOOKING',
    klassOf(off({ h: 0.20, v: 0, ear: 0.21 })), G.SIDE_PEEK);
  check('side peek + looking down -> SIDE_PEEK, not KEYBOARD_GLANCE',
    klassOf(off({ h: 0.20, v: 0.30, ear: 0.30 })), G.SIDE_PEEK);
  check('side peek to the other side is symmetric',
    klassOf(off({ h: -0.20, v: 0.30, ear: 0.21 })), G.SIDE_PEEK);
  check('h exactly 0.15 is already a side peek (bound is inclusive)',
    klassOf(off({ h: 0.15, v: 0.30, ear: 0.21 })), G.SIDE_PEEK);

  check('SIDE_PEEK is not forgivable', veto.isForgivableGlance(G.SIDE_PEEK), false);
  check('UNKNOWN is not forgivable', veto.isForgivableGlance(G.UNKNOWN), false);
  checkTrue('KEYBOARD_GLANCE is', veto.isForgivableGlance(G.KEYBOARD_GLANCE));
  checkTrue('DESK_LOOKING is', veto.isForgivableGlance(G.DESK_LOOKING));
}

// ===========================================================================
console.log('\n=== ⚠ FAIRNESS REGRESSION: droopy lids are not blanket immunity ===');
// ===========================================================================
// A student whose neutral EAR is 0.21 spends the whole exam inside Rule 2's
// band. They must still be caught peeking sideways.
{
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);
  const droopySide = face({ ear: 0.21, h: 0.15, v: 0.50 });
  runGlance(gate, r, droopySide, 1000, 4000);

  checkTrue('a droopy-lidded student side-peeking IS reported', r.reported.length > 0);
  check('…and nothing was suppressed', r.suppressed.length, 0);
  check('…classified as SIDE_PEEK', gate.telemetry().lastGlanceClass, G.SIDE_PEEK);
}

// ===========================================================================
console.log('\n=== the 5 s permit ceiling ===');
// ===========================================================================
{
  const p = new veto.KeyboardGlancePermit();
  p.update(G.KEYBOARD_GLANCE, 0);
  checkTrue('granted at t=0', p.isGranted(0));

  p.update(G.KEYBOARD_GLANCE, 4999);
  checkTrue('still granted at 4999 ms', p.isGranted(4999));

  p.update(G.KEYBOARD_GLANCE, 5000);
  check('NOT granted at 5000 ms (bound is inclusive)', p.isGranted(5000), false);
  check('elapsed is measured from episode start', p.elapsedMs(5000), 5000);
}
{
  // End-to-end: 6 s of keyboard glance alerts once the permit runs out.
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);
  runGlance(gate, r, KEYBOARD_FACE, 1000, 6000);

  checkTrue('6 s of downward gaze eventually alerts', r.reported.length > 0);
  checkTrue('…but most of it was forgiven', r.suppressed.length > r.reported.length);
  check('the alert is the normal eyes-open path', r.reported[0].reason, veto.VETO_REASON.EYES_OPEN);
}

// ===========================================================================
console.log('\n=== grace: a blip does not restart the budget ===');
// ===========================================================================
{
  const p = new veto.KeyboardGlancePermit();
  // A continuous glance, then 200 ms of unreadable frames — inside graceMs 400.
  for (let t = 0; t <= 1000; t += 50) p.update(G.KEYBOARD_GLANCE, t);
  for (let t = 1050; t <= 1200; t += 50) p.update(G.UNKNOWN, t);
  p.update(G.KEYBOARD_GLANCE, 1250);
  check('the episode survived the blip', p.elapsedMs(1250), 1250);
  checkTrue('still granted', p.isGranted(1250));

  // A real look-up of 1 s exceeds grace and ends the episode.
  const q = new veto.KeyboardGlancePermit();
  q.update(G.KEYBOARD_GLANCE, 0);
  for (let t = 100; t <= 1100; t += 50) q.update(G.UNKNOWN, t);
  check('a 1 s look-up ended the episode', q.elapsedMs(1100), 0);
  q.update(G.KEYBOARD_GLANCE, 1150);
  check('a fresh episode starts from zero', q.elapsedMs(1150), 0);

  // ⚠ A side peek ends it IMMEDIATELY, not after grace. Otherwise a student
  // could alternate down/side inside the grace window and hold a live permit
  // for the whole time they were peeking.
  const s = new veto.KeyboardGlancePermit();
  s.update(G.KEYBOARD_GLANCE, 0);
  s.update(G.SIDE_PEEK, 100);
  check('a side peek ends the episode at once', s.elapsedMs(100), 0);
  check('and revokes the permit', s.isGranted(100), false);
}

// ===========================================================================
console.log('\n=== ⚠ ANTI-BYPASS: the long-glance cap ===');
// ===========================================================================
// A bare 5 s permit that resets on look-up is a COMPLETE bypass: 4.9 s down,
// 0.5 s up, repeat, forever. The cap discriminates on the axis that actually
// separates the behaviours — a typist glances down briefly and often, a reader
// glances down at length and repeatedly.
{
  const p = new veto.KeyboardGlancePermit();
  let t = 0;
  // Three 4 s downward episodes, each separated by a 1 s look-up.
  for (let ep = 0; ep < 3; ep++) {
    const start = t;
    for (; t <= start + 4000; t += 100) p.update(G.KEYBOARD_GLANCE, t);
    for (let u = 0; u <= 1000; u += 100) { p.update(G.UNKNOWN, t); t += 100; }
  }
  check('three long episodes were recorded', p.longGlancesInWindow(t), 3);

  // The fourth is NOT forgiven, even though it is only 1 s old.
  p.update(G.KEYBOARD_GLANCE, t);
  check('the 4th long-glance episode is not forgiven', p.isGranted(t), false);
  p.update(G.KEYBOARD_GLANCE, t + 1000);
  check('…still not forgiven a second later', p.isGranted(t + 1000), false);

  // End the 4th episode before jumping the clock — otherwise it stays open and
  // the jump turns it into one enormous 60 s glance, which is a different test.
  for (let u = t + 1100; u <= t + 2600; u += 100) p.update(G.UNKNOWN, u);

  // Once the window drains, forgiveness returns.
  const later = t + K.windowMs + 5000;
  check('the window drains', p.longGlancesInWindow(later), 0);
  p.update(G.KEYBOARD_GLANCE, later);
  checkTrue('and forgiveness returns', p.isGranted(later));
}
{
  // SHORT glances — genuine typing — never consume the budget, however many.
  const p = new veto.KeyboardGlancePermit();
  let t = 0;
  for (let ep = 0; ep < 30; ep++) {
    for (let d = 0; d <= 800; d += 100) { p.update(G.KEYBOARD_GLANCE, t); t += 100; }
    for (let u = 0; u <= 600; u += 100) { p.update(G.UNKNOWN, t); t += 100; }
  }
  check('30 short typing glances record ZERO long episodes', p.longGlancesInWindow(t), 0);
  p.update(G.KEYBOARD_GLANCE, t);
  checkTrue('a typist is still forgiven after 30 glances', p.isGranted(t));
}

// ===========================================================================
console.log('\n=== unreadable geometry is never forgiven (fail-open) ===');
// ===========================================================================
// Suppression always requires positive evidence. This is what keeps the veto
// from becoming a suppression exploit.
{
  check('null sample -> UNKNOWN', klassOf(null), G.UNKNOWN);
  check('invalid sample -> UNKNOWN', klassOf(sample({ valid: false })), G.UNKNOWN);
  check('NaN hRatio -> UNKNOWN', klassOf(sample({ hRatio: NaN, vRatio: 0.8 })), G.UNKNOWN);
  check('NaN vRatio -> UNKNOWN', klassOf(sample({ vRatio: NaN })), G.UNKNOWN);

  // A closed eye yields no geometry at all, so it can never be read as a
  // downward glance — the lash-line failure gaze_roi.js documents.
  const closed = gl.analyzeGazeLandmarks(face({ ear: 0.05, h: 0.5, v: 0.9 }));
  check('a closed eye produces no iris ratios', Number.isFinite(closed.vRatio), false);
  check('…and is therefore UNKNOWN here', klassOf(closed), G.UNKNOWN);

  // With no landmarks at all, nothing is suppressed.
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);
  for (let i = 0; i < 100; i++) {
    const t = 1000 + i * 50;
    gate.submitLandmarks(null, t);
    r.report('GAZE_OFF_SCREEN', t);
  }
  check('no landmarks -> all 100 reported', r.reported.length, 100);
  check('no landmarks -> nothing suppressed', r.suppressed.length, 0);
  check('no landmarks -> counted as fail-open', gate.telemetry().failedOpen, 100);
}

// ===========================================================================
console.log('\n=== the keyboard veto is not an off switch ===');
// ===========================================================================
{
  const NEVER = [
    'PHONE_DETECTED', 'NO_FACE_DETECTED', 'MULTIPLE_FACES', 'SECONDARY_DEVICE',
    'AI_CHEATING_POSE', 'HEAD_POSE_GLANCE', 'FULLSCREEN_EXIT',
    'SCREEN_SHARE_STOPPED', 'TAB_SWITCH', 'WINDOW_BLUR', 'VISIBILITY_HIDDEN',
    'LIVENESS_FAILED', 'CAMERA_FEED_SYNTHETIC',
  ];
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);
  // Mid-permit: the most suppression-friendly state the gate can be in.
  for (let t = 1000; t < 3000; t += 50) gate.submitLandmarks(KEYBOARD_FACE, t);
  checkTrue('the permit really is open', gate.permit.isGranted(2950));
  for (const type of NEVER) r.report(type, 2950);

  check('every never-vetoable type still fired', r.reported.length, NEVER.length);
  for (const type of NEVER) {
    checkTrue(`${type} survives an open keyboard permit`,
      r.reported.some((x) => x.type === type));
  }
  check('none were suppressed', r.suppressed.length, 0);
}

// ===========================================================================
console.log('\n=== a closed eye still wins over the keyboard branch ===');
// ===========================================================================
// EYE_CLOSED is the stronger claim and needs no geometry, so it is evaluated
// first. A blink during a keyboard glance must be attributed to the blink.
{
  const gate = new veto.EarVetoGate();
  const r = makeReporter(gate);
  for (let t = 1000; t < 2000; t += 50) gate.submitLandmarks(KEYBOARD_FACE, t);
  gate.submitLandmarks(face({ ear: 0.05, h: 0.5, v: 0.8 }), 2000);
  r.report('GAZE_OFF_SCREEN', 2010);
  check('suppressed', r.suppressed.length, 1);
  check('attributed to the closed eye, not the keyboard',
    r.suppressed[0].reason, veto.VETO_REASON.EYE_CLOSED);
}

// ===========================================================================
console.log('\n=== reset clears the permit ===');
// ===========================================================================
{
  const gate = new veto.EarVetoGate();
  for (let t = 1000; t < 4500; t += 50) gate.submitLandmarks(KEYBOARD_FACE, t);
  checkTrue('an episode is running', gate.telemetry().keyboardPermit.active);
  gate.reset();
  check('reset clears the episode', gate.telemetry().keyboardPermit.active, false);
  check('reset clears the long-glance window', gate.telemetry().keyboardPermit.longInWindow, 0);
  check('reset clears the counter', gate.telemetry().keyboardVetoes, 0);
  check('reset clears the last class', gate.telemetry().lastGlanceClass, null);
}

console.log(`\n${checks} checks — ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
