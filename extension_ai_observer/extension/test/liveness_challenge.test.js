// Tests for the active liveness challenge: frozen-pose detection, corner-only
// target placement, and pose-angle verification.
//
//   node extension/test/liveness_challenge.test.js
//
// THE MOST IMPORTANT THING IN THIS FILE is the sign-convention block. This
// module converts head angles into a CRITICAL spoofing accusation, and
// pose_geometry's yaw is IMAGE-relative (positive = nose toward the right of
// the frame = the SUBJECT'S OWN LEFT). Get the flip wrong and a student who
// looks exactly where they were told is branded a spoofer. Those assertions
// are written from the student's point of view on purpose.

const lv = require('../content/liveness_challenge.js');

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}
const checkTrue = (name, cond) => check(name, !!cond, true);

/** Silence the module's own console during the noisy state-machine tests. */
const realConsole = { warn: console.warn, error: console.error, log: console.log };
function quiet(fn) {
  console.warn = () => {};
  console.error = () => {};
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.warn = realConsole.warn;
    console.error = realConsole.error;
    console.log = realConsole.log;
  }
}

/** Minimal HeadPoseAnalyzer-shaped result. */
const poseAt = (yawDeg, pitchDeg) => ({
  calibrated: true,
  deviation: { yawDeg, pitchDeg },
});
/** A frame where the face could not be read. */
const poseLost = () => ({ calibrated: true, deviation: null });

console.log('=== corner-only enforcement ===');
{
  check('exactly four targets exist', lv.CORNER_KEYS.length, 4);
  check('the four targets are the extreme corners', [...lv.CORNER_KEYS].sort(),
    ['BOTTOM-LEFT', 'BOTTOM-RIGHT', 'TOP-LEFT', 'TOP-RIGHT']);

  // The forbidden set. A centre or mid-edge target can be satisfied by moving
  // the eyes alone, which the pose model cannot see — it would turn the
  // challenge into something a photograph passes.
  for (const bad of ['CENTER', 'CENTRE', 'MIDDLE', 'TOP-CENTER', 'LEFT', 'BOTTOM-CENTER', '']) {
    let threw = false;
    try { lv.assertCornerOnly(bad); } catch { threw = true; }
    checkTrue(`"${bad || '(empty)'}" rejected as a target`, threw);
  }

  // Every corner must sit at an extreme: a 20px inset, or 60px from the far
  // edge (20px inset + the 40px dot).
  check('dot is 40px', lv.DOT_SIZE_PX, 40);
  check('inset is 20px', lv.CORNER_INSET_PX, 20);
  check('TOP-LEFT position',
    `${lv.CORNER_POSITIONS['TOP-LEFT'].left}|${lv.CORNER_POSITIONS['TOP-LEFT'].top}`,
    '20px|20px');
  check('TOP-RIGHT position',
    `${lv.CORNER_POSITIONS['TOP-RIGHT'].left}|${lv.CORNER_POSITIONS['TOP-RIGHT'].top}`,
    'calc(100vw - 60px)|20px');
  check('BOTTOM-LEFT position',
    `${lv.CORNER_POSITIONS['BOTTOM-LEFT'].left}|${lv.CORNER_POSITIONS['BOTTOM-LEFT'].top}`,
    '20px|calc(100vh - 60px)');
  check('BOTTOM-RIGHT position',
    `${lv.CORNER_POSITIONS['BOTTOM-RIGHT'].left}|${lv.CORNER_POSITIONS['BOTTOM-RIGHT'].top}`,
    'calc(100vw - 60px)|calc(100vh - 60px)');

  // No target may be expressed as a percentage of the viewport that could land
  // it inside the content area.
  const allPos = Object.keys(lv.CORNER_POSITIONS).map((k) => lv.CORNER_POSITIONS[k]);
  check('no target uses a centring percentage',
    allPos.some((p) => /%|50v/.test(p.left) || /%|50v/.test(p.top)), false);
}

console.log('\n=== pose-angle verification: STUDENT point of view ===');
{
  // pose_geometry: yawDeg > 0 means the nose moved toward the RIGHT OF THE
  // IMAGE, which on an unmirrored webcam is the student's OWN LEFT.
  check('screen-left maps to positive image yaw', lv.SCREEN_LEFT_YAW_SIGN, 1);

  // Student turns to THEIR OWN LEFT and up -> image yaw +20, pitch +10.
  const lookedTopLeft = { yaw: +20, pitch: +10 };
  // Student turns to THEIR OWN RIGHT and up -> image yaw -20, pitch +10.
  const lookedTopRight = { yaw: -20, pitch: +10 };

  checkTrue('student looking at the screen TOP-LEFT passes TOP-LEFT',
    lv.evaluateCornerResponse('TOP-LEFT', lookedTopLeft.yaw, lookedTopLeft.pitch).pass);
  checkTrue('student looking at the screen TOP-RIGHT passes TOP-RIGHT',
    lv.evaluateCornerResponse('TOP-RIGHT', lookedTopRight.yaw, lookedTopRight.pitch).pass);

  // ...and crucially, looking at the WRONG corner must not pass.
  check('looking top-left does not satisfy a top-right target',
    lv.evaluateCornerResponse('TOP-RIGHT', lookedTopLeft.yaw, lookedTopLeft.pitch).pass, false);
  check('looking top-left does not satisfy a bottom-left target',
    lv.evaluateCornerResponse('BOTTOM-LEFT', lookedTopLeft.yaw, lookedTopLeft.pitch).pass, false);

  // All four corners, expressed as the student's own movement.
  checkTrue('BOTTOM-LEFT: student left + down',
    lv.evaluateCornerResponse('BOTTOM-LEFT', +20, -10).pass);
  checkTrue('BOTTOM-RIGHT: student right + down',
    lv.evaluateCornerResponse('BOTTOM-RIGHT', -20, -10).pass);

  // Expected signs, pinned so an accidental inversion is loud.
  const tl = lv.evaluateCornerResponse('TOP-LEFT', 0, 0);
  const br = lv.evaluateCornerResponse('BOTTOM-RIGHT', 0, 0);
  check('TOP-LEFT expects +yaw / +pitch', [tl.expectedYawSign, tl.expectedPitchSign], [1, 1]);
  check('BOTTOM-RIGHT expects -yaw / -pitch', [br.expectedYawSign, br.expectedPitchSign], [-1, -1]);
}

console.log('\n=== verification thresholds ===');
{
  check('yaw threshold is the spec 12 deg', lv.DEFAULT_RESPONSE_OPTS.yawThresholdDeg, 12);

  // Boundary: 12 passes, 11.9 does not.
  check('yaw exactly 12 passes', lv.evaluateCornerResponse('TOP-LEFT', 12, 10).yawOk, true);
  check('yaw 11.9 fails', lv.evaluateCornerResponse('TOP-LEFT', 11.9, 10).yawOk, false);

  // BOTH axes are required — a pure horizontal turn is not "at the corner".
  const yawOnly = lv.evaluateCornerResponse('TOP-LEFT', 30, 0);
  check('yaw alone does not pass a corner', yawOnly.pass, false);
  check('...but the yaw half is acknowledged', yawOnly.yawOk, true);
  check('...and the pitch half is what failed', yawOnly.pitchOk, false);

  const pitchOnly = lv.evaluateCornerResponse('TOP-LEFT', 0, 30);
  check('pitch alone does not pass a corner', pitchOnly.pass, false);

  // Right magnitude, wrong direction: leaning the WRONG way must never pass.
  check('opposite yaw of equal size fails', lv.evaluateCornerResponse('TOP-LEFT', -30, 10).pass, false);
  check('opposite pitch of equal size fails', lv.evaluateCornerResponse('TOP-LEFT', 30, -10).pass, false);

  // Mirrored deployments flip horizontally and ONLY horizontally.
  const m = { mirrored: true };
  check('mirrored: TOP-LEFT now expects negative yaw',
    lv.evaluateCornerResponse('TOP-LEFT', -20, +10, m).pass, true);
  check('mirrored: pitch expectation is unchanged',
    lv.evaluateCornerResponse('TOP-LEFT', -20, -10, m).pass, false);
}

console.log('\n=== FrozenPoseMonitor ===');
{
  const opts = { windowMs: 60000, minDurationMs: 45000, minSamples: 60, maxSampleGapMs: 3000 };

  // A photograph: pose numerically identical for 50 s at 10 FPS.
  const still = new lv.FrozenPoseMonitor(opts);
  let s = null;
  for (let i = 0; i <= 500; i++) s = still.update(3.0, -2.0, i * 100);
  checkTrue('perfectly static pose over 50 s is frozen', s.frozen);
  check('yaw range is zero', s.yawRange, 0);

  // A live human: even sitting "still", pose wanders by degrees.
  const alive = new lv.FrozenPoseMonitor(opts);
  let a = null;
  for (let i = 0; i <= 500; i++) a = alive.update(3.0 + Math.sin(i / 7) * 2.5, -2.0, i * 100);
  check('a real, gently moving head is NOT frozen', a.frozen, false);
  checkTrue('...because its yaw range exceeds 1 deg', a.yawRange > 1.0);

  // Sub-threshold jitter still counts as frozen — that is the point, a photo
  // plus sensor noise produces exactly this.
  const jitter = new lv.FrozenPoseMonitor(opts);
  let j = null;
  for (let i = 0; i <= 500; i++) j = jitter.update(3.0 + (i % 2) * 0.3, -2.0, i * 100);
  checkTrue('0.3 deg jitter is still frozen', j.frozen);

  // Not long enough yet: 40 s of stillness must not fire (the floor is 45 s).
  const short = new lv.FrozenPoseMonitor(opts);
  let sh = null;
  for (let i = 0; i <= 400; i++) sh = short.update(3.0, -2.0, i * 100);
  check('40 s of stillness is not yet frozen', sh.frozen, false);

  // Too few samples, even across a long span: a collapsed loop must not be
  // allowed to declare a spoof off a handful of data points.
  const sparse = new lv.FrozenPoseMonitor(opts);
  let sp = null;
  for (let i = 0; i <= 30; i++) sp = sparse.update(3.0, -2.0, i * 2000);
  check('sparse sampling never reports frozen', sp.frozen, false);

  // A nod: yaw is static but pitch moves. Still alive.
  const nod = new lv.FrozenPoseMonitor(opts);
  let n = null;
  for (let i = 0; i <= 500; i++) n = nod.update(3.0, -2.0 + Math.sin(i / 9) * 3, i * 100);
  check('a nod is not frozen even with static yaw', n.frozen, false);

  // Unreadable frames are NOT evidence of stillness. Covering the camera for a
  // minute must not manufacture a frozen streak.
  const lost = new lv.FrozenPoseMonitor(opts);
  let l = null;
  for (let i = 0; i <= 500; i++) l = lost.update(null, null, i * 100);
  check('unreadable frames never report frozen', l.frozen, false);
  check('unreadable frames bank no samples', l.samples, 0);

  // An observation gap resets the streak — 45 s of stillness cannot be claimed
  // across a stretch nobody watched.
  const gapped = new lv.FrozenPoseMonitor(opts);
  for (let i = 0; i <= 400; i++) gapped.update(3.0, -2.0, i * 100);
  const afterGap = gapped.update(3.0, -2.0, 40000 + 10000); // 10 s unobserved
  check('a 10 s gap clears the accumulated streak', afterGap.samples, 1);
  check('and therefore is not frozen', afterGap.frozen, false);

  // A real movement mid-window kills the verdict immediately.
  const moved = new lv.FrozenPoseMonitor(opts);
  for (let i = 0; i <= 500; i++) moved.update(3.0, -2.0, i * 100);
  const afterMove = moved.update(25.0, -2.0, 50100);
  check('one genuine head turn clears the frozen verdict', afterMove.frozen, false);
}

console.log('\n=== LivenessChallengeManager: end to end ===');
{
  /** Records what the renderer was asked to draw. */
  function makeRenderer() {
    const calls = [];
    return {
      calls,
      shown: null,
      show(corner, prompt) { calls.push(['show', corner, prompt]); this.shown = corner; },
      hide() { calls.push(['hide']); this.shown = null; },
    };
  }

  /**
   * Hold a perfectly static pose until the manager issues a challenge, then
   * STOP. Driving past that point would keep feeding static frames into the
   * open response window and resolve it as a failure inside the helper.
   *
   * @returns {number} The clock value at which the challenge was issued (or the
   *   end of the run if none was).
   */
  function freeze(mgr, startT = 0, maxFrames = 700) {
    let t = startT;
    for (let i = 0; i <= maxFrames; i++) {
      mgr.update(poseAt(3.0, -2.0), t);
      if (mgr.isChallengeActive()) return t;
      t += 100;
    }
    return t;
  }

  // --- PASS: the student looks at the dot ---
  {
    const renderer = makeRenderer();
    const events = [];
    const mgr = new lv.LivenessChallengeManager({
      renderer,
      random: () => 0,                    // always TOP-LEFT
      onEvent: (n, p) => events.push([n, p]),
    });

    let t = quiet(() => freeze(mgr));

    check('a frozen pose issues a challenge', mgr.isChallengeActive(), true);
    check('the dot was rendered', renderer.shown, 'TOP-LEFT');
    check('the prompt text is the specified one',
      renderer.calls.filter((c) => c[0] === 'show')[0][2], 'Quick Check: Look at the dot!');
    check('an issue event fired', events[0][0], 'LIVENESS_CHALLENGE_ISSUED');

    // Student pivots toward the screen's top-left: their own left, so image
    // yaw goes POSITIVE, and up, so pitch goes positive.
    t += 300;
    const res = quiet(() => mgr.update(poseAt(+22, +9), t));
    check('looking at the corner passes', res.outcome, lv.LivenessOutcome.PASSED);
    check('the dot is cleared immediately', renderer.shown, null);
    check('a pass event fired', events[1][0], 'LIVENESS_CHALLENGE_PASSED');
    check('pass is recorded', mgr.stats.passed, 1);
    check('no failure recorded', mgr.stats.failed, 0);

    // Cooldown: the spec's 60 s reset. 30 s of renewed stillness must not
    // produce a second prompt.
    check('enters cooldown after resolving', mgr.state, lv.LivenessState.COOLDOWN);
    quiet(() => {
      for (let i = 1; i <= 300; i++) mgr.update(poseAt(3.0, -2.0), t + i * 100);
    });
    check('no second challenge inside the 60 s cooldown', mgr.stats.issued, 1);
    check('still in cooldown', mgr.state, lv.LivenessState.COOLDOWN);

    // ...but the protocol must keep working afterwards. Once the cooldown
    // lapses AND a fresh 45 s of stillness accumulates, it challenges again.
    // (The monitor is reset on resolve, so the clock genuinely restarts.)
    quiet(() => {
      for (let i = 301; i <= 1400; i++) mgr.update(poseAt(3.0, -2.0), t + i * 100);
    });
    checkTrue('a later frozen window re-challenges', mgr.stats.issued >= 2);
  }

  // --- FAIL: a photograph does not move ---
  {
    const renderer = makeRenderer();
    const events = [];
    const mgr = new lv.LivenessChallengeManager({
      renderer,
      random: () => 0.99,                 // always BOTTOM-RIGHT
      onEvent: (n, p) => events.push([n, p]),
    });

    const t = quiet(() => freeze(mgr));
    check('challenge issued at the far corner', renderer.shown, 'BOTTOM-RIGHT');

    // The "student" (a photo) holds exactly the same pose for the whole window.
    quiet(() => {
      for (let i = 1; i <= 40; i++) mgr.update(poseAt(3.0, -2.0), t + i * 100);
    });

    check('an unmoving subject fails', mgr.stats.failed, 1);
    check('the dot is cleared on failure', renderer.shown, null);
    const failEvent = events.filter((e) => e[0] === 'LIVENESS_CHALLENGE_FAILED')[0];
    checkTrue('a failure event fired', !!failEvent);
    check('failure names the corner', failEvent[1].corner, 'BOTTOM-RIGHT');
    check('failure reports the yaw condition unmet', failEvent[1].yaw_satisfied, false);
    check('failure reports the pitch condition unmet', failEvent[1].pitch_satisfied, false);
    checkTrue('failure records how long it waited', failEvent[1].response_ms >= 3500);
  }

  // --- FAIL: moved, but toward the WRONG corner ---
  {
    const renderer = makeRenderer();
    const mgr = new lv.LivenessChallengeManager({ renderer, random: () => 0 }); // TOP-LEFT
    const t = quiet(() => freeze(mgr));

    quiet(() => {
      // Big movement, but toward the student's own RIGHT and downward — that is
      // the BOTTOM-RIGHT corner, not the one that was asked for.
      for (let i = 1; i <= 40; i++) mgr.update(poseAt(-25, -12), t + i * 100);
    });
    check('a large movement toward the wrong corner still fails', mgr.stats.failed, 1);
    check('and is not counted as a pass', mgr.stats.passed, 0);
  }

  // --- INCONCLUSIVE: the face was not readable during the window ---
  {
    const renderer = makeRenderer();
    const events = [];
    const mgr = new lv.LivenessChallengeManager({
      renderer,
      random: () => 0,
      onEvent: (n, p) => events.push([n, p]),
    });
    const t = quiet(() => freeze(mgr));

    quiet(() => {
      for (let i = 1; i <= 40; i++) mgr.update(poseLost(), t + i * 100);
    });

    // "We could not see" must never become "you are a spoofer" — the pose
    // pipeline raises NO_FACE_DETECTED on its own evidence for this case.
    check('an unreadable window is inconclusive, not a failure', mgr.stats.inconclusive, 1);
    check('no spoofing accusation is made', mgr.stats.failed, 0);
    checkTrue('an inconclusive event fired',
      events.some((e) => e[0] === 'LIVENESS_CHALLENGE_INCONCLUSIVE'));
  }

  // --- Uncalibrated pose is never admitted ---
  {
    const mgr = new lv.LivenessChallengeManager({ renderer: makeRenderer(), random: () => 0 });
    quiet(() => {
      for (let i = 0; i <= 500; i++) {
        mgr.update({ calibrated: false, deviation: { yawDeg: 3, pitchDeg: -2 } }, i * 100);
      }
    });
    // Before calibration completes there is no neutral to deviate from, so
    // "unchanging" carries no information at all.
    check('no challenge before calibration', mgr.stats.issued, 0);
  }

  // --- Corner selection covers all four and only those four ---
  {
    const seen = new Set();
    for (let i = 0; i < 4; i++) {
      const mgr = new lv.LivenessChallengeManager({
        renderer: makeRenderer(),
        random: () => i / 4 + 0.01,
      });
      seen.add(mgr.pickCorner());
    }
    check('all four corners are reachable', seen.size, 4);
    check('and nothing outside the allow-list is ever picked',
      [...seen].every((c) => lv.CORNER_KEYS.indexOf(c) !== -1), true);
  }
}

console.log('\n=== CornerTargetRenderer (fake DOM) ===');
{
  // A tiny DOM stand-in — enough to prove the element lands at the corner with
  // the right stacking and that it cannot swallow exam clicks.
  function fakeDoc() {
    const nodes = [];
    const mk = (tag) => ({
      tag, style: {}, children: [], attrs: {}, id: '', textContent: '',
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { this.children.push(c); },
      remove() { const i = nodes.indexOf(this); if (i >= 0) nodes.splice(i, 1); },
    });
    return {
      nodes,
      head: { appendChild() {} },
      body: { appendChild(el) { nodes.push(el); } },
      createElement: mk,
      getElementById: (id) => nodes.filter((n) => n.id === id)[0] || null,
    };
  }

  const doc = fakeDoc();
  const r = new lv.CornerTargetRenderer(doc);
  const el = r.show('BOTTOM-RIGHT', 'Quick Check: Look at the dot!');

  check('rendered at the bottom-right extreme',
    [el.style.left, el.style.top], ['calc(100vw - 60px)', 'calc(100vh - 60px)']);
  check('fixed positioning survives fullscreen', el.style.position, 'fixed');
  check('cannot intercept exam clicks', el.style.pointerEvents, 'none');
  check('sits above the exam but below the consent gate', el.style.zIndex, '2147483645');
  check('corner is recorded on the element', el.attrs['data-corner'], 'BOTTOM-RIGHT');
  check('prompt text present', el.children[1].textContent, 'Quick Check: Look at the dot!');
  // Far-right corner: the label must extend inward (to the left) or it would
  // render off-screen.
  check('label anchored inward at a right-hand corner', el.children[1].style.right, '52px');

  r.hide();
  check('hide removes the overlay', doc.getElementById('ai-proctor-liveness-target'), null);

  // Re-showing must not stack duplicates.
  r.show('TOP-LEFT');
  r.show('TOP-RIGHT');
  check('only one target exists at a time',
    doc.nodes.filter((n) => n.id === 'ai-proctor-liveness-target').length, 1);
  check('the surviving target is the most recent one',
    doc.getElementById('ai-proctor-liveness-target').attrs['data-corner'], 'TOP-RIGHT');

  let threw = false;
  try { r.show('CENTER'); } catch { threw = true; }
  checkTrue('the renderer also refuses a centre target', threw);
}

console.log('\n=== Tier 1: SyntheticFrameMonitor (passive) ===');
{
  const opts = { minFrames: 30, minDurationMs: 1000, maxSampleGapMs: 3000 };

  // A live feed: any non-zero delta, however small, keeps suspicion at zero.
  const live = new lv.SyntheticFrameMonitor(opts);
  let l = null;
  for (let i = 0; i < 200; i++) l = live.update(0.4, i * 50);
  check('a feed with real pixel noise is never suspected', l.suspected, false);
  check('and banks no streak', l.frames, 0);

  // An injected still: exactly zero delta.
  const still = new lv.SyntheticFrameMonitor(opts);
  let s = null;
  for (let i = 0; i < 200; i++) s = still.update(0.0, i * 50);
  checkTrue('zero delta raises suspicion', s.suspected);

  // BOTH floors apply. 20 frames is short of the 30-frame floor...
  const fast = new lv.SyntheticFrameMonitor(opts);
  let f = null;
  for (let i = 0; i < 20; i++) f = fast.update(0.0, i * 50);
  check('20 frames is not yet 30', f.suspected, false);

  // ...and a very fast loop must still wait out the 1 s floor.
  const veryFast = new lv.SyntheticFrameMonitor(opts);
  let vf = null;
  for (let i = 0; i < 35; i++) vf = veryFast.update(0.0, i * 5); // 170 ms total
  check('35 frames inside 170 ms is not yet 1 s', vf.suspected, false);

  // Suspicion is not a score that accumulates: one live frame clears it.
  const recovered = new lv.SyntheticFrameMonitor(opts);
  for (let i = 0; i < 200; i++) recovered.update(0.0, i * 50);
  checkTrue('suspected before recovery', recovered.stats().suspected);
  const after = recovered.update(1.2, 200 * 50);
  check('a single changed frame clears suspicion', after.suspected, false);
  check('and resets the streak', after.frames, 0);

  // An unmeasured delta (first frame) is not evidence of anything.
  const nulls = new lv.SyntheticFrameMonitor(opts);
  let nl = null;
  for (let i = 0; i < 200; i++) nl = nulls.update(null, i * 50);
  check('null deltas never raise suspicion', nl.suspected, false);

  // An observation gap breaks the streak.
  const gapped = new lv.SyntheticFrameMonitor(opts);
  for (let i = 0; i < 100; i++) gapped.update(0.0, i * 50);
  const g = gapped.update(0.0, 100 * 50 + 8000);
  check('a gap restarts the streak', g.frames, 1);
  check('and drops suspicion', g.suspected, false);
}

console.log('\n=== Tier 1 -> Tier 2 escalation ===');
{
  function makeRenderer() {
    return {
      shown: null,
      calls: [],
      show(c, p) { this.calls.push(['show', c, p]); this.shown = c; },
      hide() { this.calls.push(['hide']); this.shown = null; },
    };
  }
  /** Frames with a readable, unchanging pose and ZERO pixel delta. */
  function feedStatic(mgr, startT, count, yaw = 3, pitch = -2) {
    let t = startT;
    for (let i = 0; i < count; i++) {
      mgr.update(poseAt(yaw, pitch), t, 0.0);
      if (mgr.isChallengeActive()) return t;
      t += 50;
    }
    return t;
  }

  // --- Tier 1 alone must NEVER produce a violation ---
  {
    const events = [];
    const mgr = new lv.LivenessChallengeManager({
      renderer: makeRenderer(),
      random: () => 0,
      onEvent: (n, p) => events.push([n, p]),
    });
    const t = quiet(() => feedStatic(mgr, 0, 200));

    check('zero pixel delta escalates to a challenge, fast', mgr.isChallengeActive(), true);
    checkTrue('escalation is well under the 45 s frozen-pose route', t < 5000);
    check('the ONLY event so far is the challenge prompt', events.length, 1);
    check('...and it is not a violation', events[0][0], 'LIVENESS_CHALLENGE_ISSUED');
    check('the trigger is recorded as synthetic', events[0][1].trigger, lv.LivenessTrigger.SYNTHETIC_FRAME);
    check('no failure has been declared', mgr.stats.failed, 0);
  }

  // --- INNOCENT: frozen driver. The student looks at the dot and is cleared ---
  {
    const renderer = makeRenderer();
    const mgr = new lv.LivenessChallengeManager({ renderer, random: () => 0 }); // TOP-LEFT
    let t = quiet(() => feedStatic(mgr, 0, 200));
    check('challenge is up', renderer.shown, 'TOP-LEFT');

    // Looking at the corner also un-freezes the driver: the head moved, so the
    // pixels changed too.
    t += 200;
    const res = quiet(() => mgr.update(poseAt(+22, +9), t, 4.5));

    check('the innocent student passes', res.outcome, lv.LivenessOutcome.PASSED);
    check('no violation was ever raised', mgr.stats.failed, 0);
    check('and the suspicion flag is cleared', mgr.syntheticSuspected, false);
    check('nothing was reported as synthetic', mgr.stats.syntheticConfirmed, 0);
  }

  // --- GUILTY: OBS static image. Cannot answer the prompt ---
  {
    const renderer = makeRenderer();
    const events = [];
    const mgr = new lv.LivenessChallengeManager({
      renderer,
      random: () => 0.99,                 // BOTTOM-RIGHT
      onEvent: (n, p) => events.push([n, p]),
    });
    const t = quiet(() => feedStatic(mgr, 0, 200));
    check('challenge issued against the static feed', renderer.shown, 'BOTTOM-RIGHT');

    // The image keeps yielding a perfectly readable — and perfectly
    // unchanging — pose. Those samples are the evidence against it: they make
    // the verdict FAILED rather than INCONCLUSIVE.
    quiet(() => {
      for (let i = 1; i <= 80; i++) mgr.update(poseAt(3, -2), t + i * 50, 0.0);
    });

    const fail = events.filter((e) => e[0] === 'LIVENESS_CHALLENGE_FAILED')[0];
    checkTrue('the static feed fails the challenge', !!fail);
    check('it is confirmed as synthetic, not merely a failed challenge',
      fail[1].synthetic_confirmed, true);
    check('the trigger is preserved on the outcome', fail[1].trigger, lv.LivenessTrigger.SYNTHETIC_FRAME);
    check('confirmed count incremented', mgr.stats.syntheticConfirmed, 1);
    checkTrue('the pixel evidence is attached', fail[1].synthetic_frames >= 30);
    checkTrue('the challenge really did observe usable pose samples',
      fail[1].usable_samples >= 3);
  }

  // --- A frozen-pose-triggered failure is NOT labelled synthetic ---
  {
    const events = [];
    const mgr = new lv.LivenessChallengeManager({
      renderer: makeRenderer(),
      random: () => 0,
      onEvent: (n, p) => events.push([n, p]),
    });
    // Live pixels (delta > 0) but a motionless head: the Tier 0 route.
    let t = 0;
    quiet(() => {
      for (let i = 0; i <= 700 && !mgr.isChallengeActive(); i++) {
        mgr.update(poseAt(3, -2), t, 2.0);
        t += 100;
      }
      for (let i = 1; i <= 40; i++) mgr.update(poseAt(3, -2), t + i * 100, 2.0);
    });
    const fail = events.filter((e) => e[0] === 'LIVENESS_CHALLENGE_FAILED')[0];
    checkTrue('frozen pose with live pixels still fails', !!fail);
    check('but is NOT reported as a synthetic feed', fail[1].synthetic_confirmed, false);
    check('its trigger is the pose watch', fail[1].trigger, lv.LivenessTrigger.FROZEN_POSE);
  }

  // --- Repeat prompting is bounded ---
  {
    const mgr = new lv.LivenessChallengeManager({
      renderer: makeRenderer(),
      random: () => 0,
      forcedRechallengeMs: 30000,
    });
    const t = quiet(() => feedStatic(mgr, 0, 200));
    quiet(() => {
      // Keep the feed frozen for 20 s after the first challenge resolves.
      for (let i = 1; i <= 400; i++) mgr.update(poseAt(3, -2), t + i * 50, 0.0);
    });
    // Without the floor this would re-prompt on every frame forever.
    check('a persistently frozen feed is not prompted repeatedly', mgr.stats.issued, 1);
  }

  // --- forceChallenge respects an in-flight challenge ---
  {
    const mgr = new lv.LivenessChallengeManager({ renderer: makeRenderer(), random: () => 0 });
    check('force works from idle', quiet(() => mgr.forceChallenge(1000)), true);
    check('but not while one is already open', mgr.forceChallenge(1200), false);
    check('exactly one challenge was issued', mgr.stats.issued, 1);
  }
}

console.log(`\n${checks} checks — ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
