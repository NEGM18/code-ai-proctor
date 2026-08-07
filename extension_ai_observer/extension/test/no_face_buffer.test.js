// =============================================================================
// no_face_buffer.test.js — the continuous 2-second NO_FACE window
//
// Feature 1 is a CONFIGURATION of the frozen pipeline, not new code, so this
// suite drives the REAL HeadPoseAnalyzer with the real absence gate. A test
// against a hand-rolled timer would prove nothing about what actually runs.
//
// The two behaviours the brief names, asserted by name below:
//
//   * absent continuously for >= 2.0 s  -> exactly one HIGH NO_FACE event
//   * a face reappearing before 2.0 s   -> timer resets, nothing fires
//
// The gate values are read out of monitor.js by source extraction rather than
// duplicated here. monitor.js is a content script and cannot be require()d, and
// a copied constant would let the two drift apart silently — which is precisely
// the failure this suite exists to catch.
// =============================================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { HeadPoseAnalyzer, PoseCondition } =
  require(path.join(__dirname, '..', 'content', 'vision', 'pose_pipeline.js'));

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

// --- The gate monitor.js actually installs -----------------------------------
const monitorSrc = fs.readFileSync(
  path.join(__dirname, '..', 'content', 'monitor.js'), 'utf8');

const gateBlock = monitorSrc.match(/const NO_FACE_GATE = \{([\s\S]*?)\};/);
if (!gateBlock) {
  console.log('FAIL  NO_FACE_GATE not found in monitor.js');
  process.exit(1);
}
const numberFor = (key) => {
  const m = gateBlock[1].match(new RegExp(`${key}:\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
};
const NO_FACE_GATE = {
  glanceMs: numberFor('glanceMs'),
  alertMs: numberFor('alertMs'),
  graceMs: numberFor('graceMs'),
  minRealertMs: numberFor('minRealertMs'),
};

console.log('\n=== the configuration monitor.js installs ===');

check('the alert threshold is 2.0 s, as specified', NO_FACE_GATE.alertMs, 2000);
// ⚠ graceMs MUST be 0. The brief requires a reappearing face to reset the timer
// immediately; any grace holds the episode open across the reappearance and lets
// the dwell keep accumulating, which is the opposite behaviour.
check('grace is zero so a reappearing face resets immediately', NO_FACE_GATE.graceMs, 0);
// DwellGate tests alertMs BEFORE glanceMs, so an equal glanceMs makes the LOW
// tier unreachable and 2.0 s produces exactly one HIGH event — which is the only
// severity handlePoseEvents reports for NO_FACE.
checkTrue('glance does not fire before the alert', NO_FACE_GATE.glanceMs >= NO_FACE_GATE.alertMs);
checkTrue('re-alerts are rate limited', NO_FACE_GATE.minRealertMs > 0);

// ⚠ Regression guard on the frozen module's own default. If pose_pipeline.js
// ever changes its default absenceGate, this suite still measures the value
// monitor.js passes, but the two must not silently converge on a wrong number.
check('monitor overrides the pipeline default rather than relying on it',
  NO_FACE_GATE.alertMs !== 5000, true);

// --- Fixtures ---------------------------------------------------------------
//
// A person whose face resolves: NOSE / L_EYE / R_EYE / L_EAR / R_EAR, the exact
// set pose_geometry.js reads. Only the first five COCO keypoints matter here.
function facePresent() {
  const kp = (x, y) => ({ x, y, score: 0.95 });
  return [{
    score: 0.95,
    keypoints: [
      kp(320, 240),  // NOSE
      kp(300, 220),  // LEFT_EYE
      kp(340, 220),  // RIGHT_EYE
      kp(280, 230),  // LEFT_EAR
      kp(360, 230),  // RIGHT_EAR
    ],
  }];
}
/** No person in frame at all. */
const faceAbsent = () => [];

const analyzer = () => new HeadPoseAnalyzer({ absenceGate: NO_FACE_GATE });

/** Count HIGH NO_FACE events across a scripted timeline. */
function runTimeline(steps, stepMs = 100) {
  const a = analyzer();
  const events = [];
  let t = 0;
  for (const present of steps) {
    const r = a.process(present ? facePresent() : faceAbsent(), t);
    for (const ev of r.events) {
      if (ev.condition === PoseCondition.NO_FACE && ev.severity === 'HIGH') {
        events.push({ t, dwellMs: ev.dwellMs });
      }
    }
    t += stepMs;
  }
  return events;
}
/** `n` frames of a constant presence value. */
const frames = (n, present) => new Array(n).fill(present);

console.log('\n=== ⚠ ABSENT FOR >= 2.0 s -> ONE incident ===');

{
  // 100 ms cadence: absent from t=0, so the gate crosses 2000 ms at t=2000.
  const events = runTimeline(frames(40, false));
  check('a continuous 2 s absence fires exactly one HIGH event', events.length, 1);
  check('and it fires at the 2.0 s mark', events[0].t, 2000);
  checkTrue('and the reported dwell is at least 2000 ms', events[0].dwellMs >= 2000);
}

{
  // Tier B cadence (111 ms). The threshold is measured in TIME, not frames, so
  // a slower machine must still alert at ~2 s rather than after 20 frames.
  const a = analyzer();
  let fired = null;
  for (let t = 0; t <= 4000; t += 111) {
    const r = a.process(faceAbsent(), t);
    const ev = r.events.find((e) => e.condition === PoseCondition.NO_FACE && e.severity === 'HIGH');
    if (ev && fired === null) fired = t;
  }
  checkTrue('at a Tier B cadence it still fires at ~2 s', fired >= 2000 && fired < 2200);
}

{
  // Just under the threshold must produce nothing at all.
  const events = runTimeline(frames(20, false)); // 0..1900 ms
  check('1.9 s of absence fires nothing', events.length, 0);
}

console.log('\n=== ⚠ A FACE RETURNING BEFORE 2.0 s RESETS THE TIMER ===');

{
  // 1.5 s absent, one readable frame, then 1.5 s absent again. Neither run
  // reaches 2 s, and with graceMs 0 they must NOT be summed into one 3 s
  // episode.
  const events = runTimeline([
    ...frames(15, false),  // 0..1400  absent
    true,                  // 1500     face returns -> reset
    ...frames(15, false),  // 1600..3000 absent again
  ]);
  check('two sub-threshold absences do not add up to an incident', events.length, 0);
}

{
  // The sharpest form: absent right up to 1.9 s, one frame present, then absent
  // again. A grace window would have kept the episode alive and fired at 2.0 s.
  const events = runTimeline([
    ...frames(19, false),  // 0..1800
    true,                  // 1900  face returns
    ...frames(19, false),  // 2000..3800
  ]);
  check('a single readable frame at 1.9 s prevents the incident', events.length, 0);
}

{
  // A student who leans out and back repeatedly, never absent for a full 2 s.
  const steps = [];
  for (let i = 0; i < 12; i++) steps.push(...frames(15, false), true);
  const events = runTimeline(steps);
  check('repeated brief absences over 19 s never fire', events.length, 0);
}

{
  // Control: the same student who then genuinely leaves.
  const events = runTimeline([
    ...frames(15, false), true,
    ...frames(15, false), true,
    ...frames(40, false),           // a real 4 s absence
  ]);
  check('a genuine absence after brief ones still fires', events.length, 1);
}

console.log('\n=== one incident per episode, not one per interval ===');

{
  // ⚠ A continuous absence fires ONCE, however long it lasts. DwellGate latches
  // in ALERT and only re-arms after the episode RELEASES, so minRealertMs never
  // enters the picture while the student is still away. This is the desirable
  // behaviour — "the student left" is one event, not thirty — and it is worth
  // pinning, because the obvious reading of the config (a 2 s threshold with a
  // 20 s refractory) wrongly predicts a re-alert every 20 s.
  const events = runTimeline(frames(600, false));
  check('a 60 s continuous absence fires exactly once', events.length, 1);
  check('and it is the incident at the 2 s mark', events[0].t, 2000);
}

{
  // A NEW episode is a new incident: the student returns, then leaves again.
  // The refractory period is what spaces these, so it is exercised here rather
  // than against a single unbroken absence.
  const events = runTimeline([
    ...frames(40, false),   // 0..3900     absent -> fires at 2000
    ...frames(10, true),    // 4000..4900  back
    ...frames(40, false),   // 5000..8900  absent again, inside the 20 s refractory
  ]);
  check('a second absence inside the refractory window is suppressed', events.length, 1);
}

{
  const events = runTimeline([
    ...frames(40, false),    // fires at 2000
    ...frames(10, true),
    ...frames(250, false),   // long enough to clear the 20 s refractory
  ]);
  checkTrue('a later episode past the refractory fires again', events.length >= 2);
  checkTrue('and re-alerts respect the refractory period',
    events.every((e, i) => i === 0 || (e.t - events[i - 1].t) >= NO_FACE_GATE.minRealertMs));
}

console.log('\n=== a present student is never accused ===');

{
  const events = runTimeline(frames(600, true));
  check('60 s of a readable face fires nothing', events.length, 0);
}

// ⚠ "No usable view of the face", not "no person box". A student who covers the
// camera or turns fully away is still detected as a person while their facial
// keypoints stop resolving — treating that as compliant would leave an obvious
// hole, and the violation type is NO_FACE_DETECTED, not NO_PERSON_DETECTED.
{
  const a = analyzer();
  const events = [];
  for (let t = 0; t <= 3000; t += 100) {
    // A person is present and scores well, but the face keypoints are missing.
    const persons = [{ score: 0.95, keypoints: [null, null, null, null, null] }];
    const r = a.process(persons, t);
    for (const ev of r.events) {
      if (ev.condition === PoseCondition.NO_FACE && ev.severity === 'HIGH') events.push(ev);
    }
  }
  check('a visible person with an unreadable face still fires NO_FACE', events.length, 1);
}

console.log('\n=== continuity is not assumed across a stalled loop ===');

{
  // Two absent samples 6 s apart are not 6 s of proven absence. maxSampleGapMs
  // (2000 ms, the frozen default) resets the streak, so a stalled tab cannot
  // manufacture an incident out of two data points.
  const a = analyzer();
  const events = [];
  for (const t of [0, 6000]) {
    const r = a.process(faceAbsent(), t);
    for (const ev of r.events) {
      if (ev.condition === PoseCondition.NO_FACE && ev.severity === 'HIGH') events.push(ev);
    }
  }
  check('two absent samples 6 s apart do not fire', events.length, 0);
}

console.log(`\n${checks} checks — ${failures ? `${failures} FAILED` : 'ALL PASS'}`);
process.exit(failures ? 1 : 0);
