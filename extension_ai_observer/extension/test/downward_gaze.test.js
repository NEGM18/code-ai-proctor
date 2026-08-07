// =============================================================================
// downward_gaze.test.js — sustained downward gaze (phone below the camera)
//
// The two failure modes this detector sits between, and both are asserted here:
//
//   MISS   a student reading a phone flat on the desk goes unflagged, which is
//          the live-test defect that prompted it.
//   ABUSE  a hunt-and-peck typist is accused of cheating for looking at their
//          keyboard, which is what a bare 1.2 s downward trigger would do to
//          every such student in the cohort.
//
// Plus the sign, which has TWO disagreeing conventions in this codebase and is
// the single most dangerous thing here to get backwards.
// =============================================================================

const assert = require('assert');
const path = require('path');

// DwellGate must be on the global before downward_gaze.js loads — the module is
// a content script and resolves it off `window`, exactly as it does in Chrome.
const temporal = require(path.join(__dirname, '..', 'content', 'vision', 'temporal_gate.js'));
global.window = global;
Object.assign(global, temporal);

const {
  DOWNWARD_GAZE_DEFAULTS,
  DOWNWARD_REASON,
  classifyDownward,
  DownwardGazeDetector,
} = require(path.join(__dirname, '..', 'content', 'vision', 'downward_gaze.js'));

const { KeyboardGlancePermit, GLANCE_CLASS } =
  require(path.join(__dirname, '..', 'content', 'vision', 'ear_veto.js'));

let checks = 0;
let failures = 0;
function check(name, actual, expected) {
  checks++;
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function checkTrue(name, cond) { check(name, !!cond, true); }

/** A frame that is unambiguously downward: iris low AND below own neutral. */
const DOWN = { vRatio: 0.75, pitchDev: -0.30, ear: 0.28, headNeutral: true, permitGranted: false };
/** A frame looking straight at the screen. */
const LEVEL = { vRatio: 0.50, pitchDev: 0.00, ear: 0.28, headNeutral: true, permitGranted: false };

const at = (over = {}) => ({ ...DOWN, ...over });

console.log('\n=== ⚠ SIGN — negative pitchDev is DOWN ===');

check('iris low AND pitch below neutral is downward',
  classifyDownward(DOWN).deviant, true);

// ⚠ THE INVERSION THIS MODULE EXISTS TO CATCH. A student glancing UP at the
// ceiling to think has POSITIVE pitchDev. If the comparison were flipped, this
// would be flagged and the phone reader forgiven — the exact opposite of intent.
check('looking UP is never downward',
  classifyDownward(at({ vRatio: 0.30, pitchDev: +0.30 })).deviant, false);
check('looking up reports NOT_DOWN',
  classifyDownward(at({ vRatio: 0.30, pitchDev: +0.30 })).reason, DOWNWARD_REASON.NOT_DOWN);

// ⚠ BOTH AXES REQUIRED. Either alone is unfair or exploitable — absolute alone
// accuses whoever's resting iris sits low; relative alone lets a student who
// calibrated while already on their phone normalise that posture.
check('low iris but neutral pitch is NOT downward (relative floor unmet)',
  classifyDownward(at({ vRatio: 0.75, pitchDev: -0.02 })).deviant, false);
check('pitch below neutral but high iris is NOT downward (absolute floor unmet)',
  classifyDownward(at({ vRatio: 0.45, pitchDev: -0.30 })).deviant, false);

check('exactly at both floors is downward',
  classifyDownward(at({
    vRatio: DOWNWARD_GAZE_DEFAULTS.downRatio,
    pitchDev: DOWNWARD_GAZE_DEFAULTS.downPitchDev,
  })).deviant, true);

console.log('\n=== unreadable is UNKNOWN, never deviant ===');

// null, not false: an unreadable frame must not age a dwell gate as if it were
// compliance. This is the pipeline-wide rule.
check('NaN vRatio yields UNKNOWN', classifyDownward(at({ vRatio: NaN })).deviant, null);
check('NaN pitchDev yields UNKNOWN', classifyDownward(at({ pitchDev: NaN })).deviant, null);
check('missing everything yields UNKNOWN', classifyDownward({}).deviant, null);
check('unreadable is reported as such',
  classifyDownward(at({ vRatio: NaN })).reason, DOWNWARD_REASON.UNREADABLE);

console.log('\n=== ⚠ CLOSED EYES CAN NEVER BE "LOOKING DOWN" ===');

// The lash line sits low, which is exactly how a naive iris tracker turns a
// blink into "looking down at notes" — the original defect of this codebase.
check('a closed eye is UNKNOWN, not downward',
  classifyDownward(at({ ear: 0.10 })).deviant, null);
check('and is reported as EYES_CLOSED',
  classifyDownward(at({ ear: 0.10 })).reason, DOWNWARD_REASON.EYES_CLOSED);
check('at exactly the EAR threshold the eye counts as open',
  classifyDownward(at({ ear: DOWNWARD_GAZE_DEFAULTS.earThreshold })).deviant, true);

{
  // 30 s of eyes shut while every other input screams "downward".
  const d = new DownwardGazeDetector();
  let events = 0;
  for (let t = 0; t < 30000; t += 100) {
    events += d.process(at({ ear: 0.08 }), t).events.length;
  }
  check('30 s of closed eyes produces ZERO downward violations', events, 0);
}

console.log('\n=== head off neutral belongs to AI_CHEATING_POSE ===');

check('an off-neutral head yields UNKNOWN',
  classifyDownward(at({ headNeutral: false })).deviant, null);
check('and is reported as HEAD_OFF_NEUTRAL',
  classifyDownward(at({ headNeutral: false })).reason, DOWNWARD_REASON.HEAD_OFF_NEUTRAL);

console.log('\n=== ⚠ THE MISS THIS FIXES: phone below the camera ===');

{
  // A student reads a phone flat on the desk. Head barely moves, no phone
  // label, classifier silent — only the iris drops.
  const d = new DownwardGazeDetector();
  const events = [];
  for (let t = 0; t <= 3000; t += 100) {
    for (const ev of d.process(DOWN, t).events) events.push({ t, ev });
  }
  check('sustained downward gaze fires exactly one violation', events.length, 1);
  check('and it fires at the 1.2 s threshold', events[0].t, 1200);
  check('at MEDIUM severity', events[0].ev.severity, 'MEDIUM');
  check('naming the detector', events[0].ev.detail.detector, 'downward_gaze_iris');
  checkTrue('and marked severe for the fusion path', events[0].ev.detail.severe);
}

{
  // Just under threshold fires nothing.
  const d = new DownwardGazeDetector();
  let events = 0;
  for (let t = 0; t < 1200; t += 100) events += d.process(DOWN, t).events.length;
  check('1.1 s of downward gaze fires nothing', events, 0);
}

{
  // Looking at the screen is never a violation, however long.
  const d = new DownwardGazeDetector();
  let events = 0;
  for (let t = 0; t < 60000; t += 100) events += d.process(LEVEL, t).events.length;
  check('60 s of looking at the screen fires nothing', events, 0);
}

console.log('\n=== ⚠ FRESHNESS — vRatio and pitchDev must describe ONE moment ===');

// vRatio is read off GazeLandmarkAnalyzer.lastSample, which is assigned only on
// a VALID sample and never cleared on an unreadable frame — so it can outlive
// the frame that produced it. pitchDev is always current. Pairing a stale
// absolute reading with a fresh relative one satisfies the two floors from two
// DIFFERENT moments, which is an accusation nobody earned.

check('a stale sample is UNKNOWN, never downward',
  classifyDownward(at({ sampleAgeMs: 400 })).deviant, null);
check('and is reported as STALE_SAMPLE',
  classifyDownward(at({ sampleAgeMs: 400 })).reason, DOWNWARD_REASON.STALE_SAMPLE);

// The boundary, both sides. `>` not `>=`, so the threshold itself still counts.
check('exactly at maxSampleAgeMs the reading is still fresh',
  classifyDownward(at({ sampleAgeMs: DOWNWARD_GAZE_DEFAULTS.maxSampleAgeMs })).deviant, true);
check('one millisecond past it is stale',
  classifyDownward(at({ sampleAgeMs: DOWNWARD_GAZE_DEFAULTS.maxSampleAgeMs + 1 })).deviant, null);
check('the guard is set at the specified 300 ms',
  DOWNWARD_GAZE_DEFAULTS.maxSampleAgeMs, 300);

// ⚠ A DELIBERATE ASYMMETRY. An ABSENT age means "this caller does not timestamp
// the source", not "the reading is old". Failing the other way would let a
// caller that merely omits the field silently disable the entire detector — a
// total, silent loss of coverage, which is a worse failure than the narrow
// cross-frame race this guards.
check('an untracked age is treated as fresh, not as stale',
  classifyDownward(at({ sampleAgeMs: NaN })).deviant, true);
check('and so is an omitted one', classifyDownward(DOWN).deviant, true);

{
  // ⚠ THE REQUIRED ASSERTION: a sample older than 300 ms raises NO alert, no
  // matter how long it persists or how blatantly downward it reads.
  const d = new DownwardGazeDetector();
  let events = 0;
  for (let t = 0; t <= 10000; t += 100) {
    events += d.process(at({ sampleAgeMs: 400 }), t).events.length;
  }
  check('10 s of perfectly downward but STALE frames fires nothing', events, 0);
  check('and every one is counted as stale', d.telemetry().stale, 101);
  check('with no sample ever counted as downward', d.telemetry().down, 0);
}

{
  // The same 10 s with a FRESH reading DOES fire — without this the test above
  // would pass just as well against a detector that is broken outright.
  const d = new DownwardGazeDetector();
  let events = 0;
  for (let t = 0; t <= 10000; t += 100) {
    events += d.process(at({ sampleAgeMs: 0 }), t).events.length;
  }
  checkTrue('the identical episode with a fresh reading DOES fire', events > 0);
}

{
  // ⚠ THE CROSS-FRAME MIX ITSELF — the scenario the guard exists for.
  //
  // A student looks down for 0.6 s (well under the 1.2 s gate, so nothing has
  // fired), then the landmark stream stalls: `lastSample` keeps reporting the
  // old low iris while pitchDev stays finite and current. Without the guard the
  // dwell would keep accumulating on a reading from a moment that has passed,
  // and flag a student who may already have looked back up.
  //
  // ⚠ THE STALL MUST BEGIN WITH MORE THAN maxSampleAgeMs OF DWELL REMAINING,
  // and that is a property of the guard, not a quirk of the fixture. The first
  // 300 ms after a stall are still legitimately FRESH — that tolerance is the
  // whole reason a single dropped landmark frame does not punch a hole in a
  // real episode. Start the stall 300 ms shy of the gate and those grace frames
  // carry the dwell over the line, and the alert that follows is honest.
  const d = new DownwardGazeDetector();
  let events = 0;
  let t = 0;
  for (; t < 600; t += 100) events += d.process(at({ sampleAgeMs: 0 }), t).events.length;
  check('nothing has fired yet at 0.6 s', events, 0);

  // Landmarks stall. Age climbs; every other input still screams "downward".
  for (let age = 100; t <= 20000; t += 100, age += 100) {
    events += d.process(at({ sampleAgeMs: age }), t).events.length;
  }
  check('a stalled landmark stream can never complete the episode', events, 0);
  checkTrue('and the stalled frames are attributed to staleness',
    d.telemetry().stale > 0);
}

{
  // Freshness restored after a stall starts a clean dwell rather than
  // inheriting the stalled one, and the student is then flagged on evidence
  // that is actually current. A guard that permanently killed the detector
  // after one stall would be its own coverage failure.
  const d = new DownwardGazeDetector();
  let events = 0;
  let t = 0;
  for (; t < 2000; t += 100) events += d.process(at({ sampleAgeMs: 900 }), t).events.length;
  check('no alert while the stream is stalled', events, 0);
  for (; t < 4000; t += 100) events += d.process(at({ sampleAgeMs: 0 }), t).events.length;
  checkTrue('but a recovered stream still catches the phone reader', events > 0);
}

console.log('\n=== ⚠ THE TYPIST MUST NOT BE ACCUSED ===');

// ear_veto.js's KeyboardGlancePermit is the real safeguard; this asserts the
// detector actually consults it rather than talking past it.
check('a forgiven frame is not deviant',
  classifyDownward(at({ permitGranted: true })).deviant, false);
check('and is reported as KEYBOARD_FORGIVEN',
  classifyDownward(at({ permitGranted: true })).reason, DOWNWARD_REASON.KEYBOARD_FORGIVEN);

{
  // 30 s of continuous downward gaze WITH forgiveness granted throughout: a
  // permanently-permitted student can never be flagged by this detector.
  const d = new DownwardGazeDetector();
  let events = 0;
  for (let t = 0; t < 30000; t += 100) {
    events += d.process(at({ permitGranted: true }), t).events.length;
  }
  check('30 s of forgiven downward gaze produces ZERO violations', events, 0);
  check('and every sample is counted as forgiven', d.telemetry().forgiven, 300);
}

{
  // ⚠ THE REAL TYPIST, through the REAL permit. Short downward glances with
  // brief look-ups — the hunt-and-peck pattern the keyboard safeguard exists to
  // protect. The permit is driven exactly as ear_veto.js drives it.
  const permit = new KeyboardGlancePermit();
  const d = new DownwardGazeDetector();
  let events = 0;
  let t = 0;
  for (let cycle = 0; cycle < 20; cycle++) {
    for (let i = 0; i < 8; i++, t += 100) {          // 0.8 s down at the keys
      permit.update(GLANCE_CLASS.KEYBOARD_GLANCE, t);
      events += d.process(at({ permitGranted: permit.isGranted(t) }), t).events.length;
    }
    for (let i = 0; i < 4; i++, t += 100) {          // 0.4 s back at the screen
      permit.update(GLANCE_CLASS.UNKNOWN, t);
      events += d.process(LEVEL, t).events.length;
    }
  }
  check('24 s of realistic typing produces ZERO violations', events, 0);
}

{
  // ⚠ AND THE READER IS STILL CAUGHT. Same permit, but the gaze stays down
  // continuously: permitMs (5000) expires mid-episode, forgiveness lapses, and
  // the 1.2 s dwell then runs to completion.
  const permit = new KeyboardGlancePermit();
  const d = new DownwardGazeDetector();
  const fired = [];
  for (let t = 0; t <= 12000; t += 100) {
    permit.update(GLANCE_CLASS.KEYBOARD_GLANCE, t);
    const granted = permit.isGranted(t);
    for (const ev of d.process(at({ permitGranted: granted }), t).events) fired.push({ t, ev });
  }
  checkTrue('a continuous downward read IS eventually flagged', fired.length >= 1);
  // Stated plainly in the module header: forgiveness costs the first ~permitMs.
  checkTrue('but not before the permit expires', fired[0].t >= 5000);
  checkTrue('and within a dwell of it lapsing', fired[0].t <= 5000 + 1200 + 400);
}

console.log('\n=== suppression during a liveness challenge ===');

{
  // The corner challenge ORDERS the student to look at a dot, including the two
  // bottom corners. Reporting that would punish compliance.
  const d = new DownwardGazeDetector();
  let events = 0;
  for (let t = 0; t <= 5000; t += 100) events += d.process(DOWN, t, true).events.length;
  check('nothing is reported while a challenge is up', events, 0);
  checkTrue('but the gate still ran, so the episode ages honestly',
    d.telemetry().down > 0);
}

console.log('\n=== continuity and reset ===');

{
  // Two samples 6 s apart are not 6 s of downward gaze (maxSampleGapMs 2000).
  const d = new DownwardGazeDetector();
  let events = 0;
  for (const t of [0, 6000]) events += d.process(DOWN, t).events.length;
  check('two far-apart samples do not fire', events, 0);
}

{
  const d = new DownwardGazeDetector();
  for (let t = 0; t <= 3000; t += 100) d.process(DOWN, t);
  checkTrue('telemetry accumulated', d.telemetry().down > 0);
  d.reset();
  check('reset clears counters', d.telemetry().down, 0);
  check('reset clears events', d.telemetry().events, 0);
  check('reset returns the gate to idle', d.telemetry().state, 'idle');
}

console.log('\n=== a blink mid-read does not restart the episode ===');

{
  // graceMs 300: a single blink frame inside a sustained read must not reset
  // the dwell and let the student start over for free.
  const d = new DownwardGazeDetector();
  const fired = [];
  for (let t = 0; t <= 3000; t += 100) {
    const s = (t === 700) ? at({ ear: 0.08 }) : DOWN;   // one blink at 0.7 s
    for (const ev of d.process(s, t).events) fired.push({ t, ev });
  }
  check('a blink mid-read does not prevent the violation', fired.length, 1);
  checkTrue('and it still lands close to the 1.2 s mark', fired[0].t <= 1500);
}

console.log(`\n${checks} checks — ${failures ? `${failures} FAILED` : 'ALL PASS'}`);
process.exit(failures ? 1 : 0);
