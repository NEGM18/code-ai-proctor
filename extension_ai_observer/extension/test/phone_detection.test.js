// Tests for the high-precision phone engine: confidence floor, aspect-ratio
// shape guard, and the latch-and-hold event buffer.
//
//   node extension/test/phone_detection.test.js
//
// The two requirements pull in opposite directions and both are asserted here:
//
//   PRECISION — a square notebook/sticky-note artifact must not raise an alert,
//   and a near-square box must clear a strictly higher bar than a rectangle.
//   RECALL    — a phone visible for as little as ONE frame must latch, even
//   when it is faint and small at the edge of frame, and the alert state must
//   survive long after the phone is hidden.
//
// ⚠ THE BALANCE MOVED ON 2026-08-08. This suite used to assert a >= 0.60
// confidence floor as the primary precision guarantee. That floor is now 0.30
// with no dwell requirement, by explicit product decision, so precision rests
// on the SHAPE and AREA guards plus the square/rectangle split. Those are what
// this suite now pins; the confidence floor is pinned to its exact briefed
// value so a drift in either direction is visible.
//
// If a future change makes one of these pass by breaking the other, this suite
// is the thing that catches it.

const det = require('../content/vision/detectors.js');

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}
const checkTrue = (name, cond) => check(name, !!cond, true);

/** Build a detection with a box of the given pixel size, centred at (100,100). */
function phone(score, w, h) {
  return {
    score,
    classId: det.COCO_CELL_PHONE,
    box: { x1: 100, y1: 100, x2: 100 + w, y2: 100 + h },
  };
}

const FRAME = { width: 640, height: 480 };

console.log('=== confidence floor — the SENSITIVE operating point ===');
{
  // ⚠ THIS BLOCK USED TO ASSERT `minConfidence >= 0.60` AND SAID SO IN ITS
  // NAME. That was deliberately overridden on 2026-08-08 after live testing
  // found the 0.60 gate missing phones held at the frame edge or resolving to
  // only a small cluster of pixels. The assertion is not weakened by accident —
  // it is re-pointed at the new operating point, and the tradeoff it used to
  // protect against is now REAL and accepted. See PHONE_SHAPE_DEFAULTS.
  check('minConfidence is the specified 0.30', det.PHONE_SHAPE_DEFAULTS.minConfidence, 0.30);
  checkTrue('and stays within the briefed 0.25-0.30 band',
    det.PHONE_SHAPE_DEFAULTS.minConfidence >= 0.25
    && det.PHONE_SHAPE_DEFAULTS.minConfidence <= 0.30);

  // ⚠ THE ORDERING IS THE SURVIVING PRECISION GUARANTEE. Both absolute numbers
  // came down, but a near-square box must still clear a strictly higher bar
  // than a clean rectangle — squares are the largest single source of
  // background false positives, and collapsing these two into one value is how
  // desk clutter starts reading as a phone.
  checkTrue('square boxes still need more than the base floor',
    det.PHONE_SHAPE_DEFAULTS.squareConfidence > det.PHONE_SHAPE_DEFAULTS.minConfidence);

  // A well-shaped 16:9 box just under the floor is still rejected...
  check('0.25 rectangular rejected', det.evaluatePhoneShape(phone(0.25, 40, 71), FRAME).accept, false);
  // ...and one just over it now latches, where 0.60 would have discarded it.
  check('0.31 rectangular accepted', det.evaluatePhoneShape(phone(0.31, 40, 71), FRAME).accept, true);
  check('0.62 rectangular still accepted', det.evaluatePhoneShape(phone(0.62, 40, 71), FRAME).accept, true);

  // ⚠ THE MISS THIS CHANGE EXISTS TO FIX: a phone at the edge of frame, faint
  // and small. Under the old 0.60 floor AND the old 0.0006 area guard this was
  // rejected twice over; it is exactly the detection the brief asks to catch.
  const edgePhone = det.evaluatePhoneShape(phone(0.33, 9, 16), FRAME);
  check('a faint, small edge-of-frame phone is accepted', edgePhone.accept, true);
  check('and is judged against the rectangular bar', edgePhone.requiredConfidence, 0.30);
}

console.log('\n=== aspect ratio shape guard ===');
{
  check('16:9 portrait ratio', det.boxAspectRatio({ x1: 0, y1: 0, x2: 40, y2: 71 }), 1.775);
  check('16:9 landscape reads the same', det.boxAspectRatio({ x1: 0, y1: 0, x2: 71, y2: 40 }), 1.775);
  check('perfect square is 1', det.boxAspectRatio({ x1: 0, y1: 0, x2: 50, y2: 50 }), 1);
  check('degenerate box is 0', det.boxAspectRatio({ x1: 10, y1: 10, x2: 10, y2: 50 }), 0);

  // The headline case: a 1:1 sticky note / wall-art artifact must NOT alert
  // just because it cleared the (now much lower) rectangular floor. Scored at
  // 0.42 it is comfortably above minConfidence 0.30 and still rejected — which
  // is the entire reason the two bars remain separate values.
  const square = det.evaluatePhoneShape(phone(0.42, 50, 50), FRAME);
  check('1:1 square at 0.42 rejected despite clearing the rectangular floor',
    square.accept, false);
  check('square rejection reason', square.reason, 'square_below_high_confidence');
  check('square is held to the higher bar', square.requiredConfidence, det.PHONE_SHAPE_DEFAULTS.squareConfidence);

  // Not discarded outright: a phone angled steeply foreshortens toward square,
  // so a confident square still gets through.
  check('1:1 square at 0.55 accepted', det.evaluatePhoneShape(phone(0.55, 50, 50), FRAME).accept, true);
  check('1:1 square at 0.80 accepted', det.evaluatePhoneShape(phone(0.80, 50, 50), FRAME).accept, true);

  // Real phone aspect ratios all clear the shape test at the base floor.
  check('4:3 phone accepted', det.evaluatePhoneShape(phone(0.62, 45, 60), FRAME).accept, true);
  check('19.5:9 phone accepted', det.evaluatePhoneShape(phone(0.62, 37, 80), FRAME).accept, true);

  // A pen, a cable or a strip artifact is not a phone at any confidence.
  const sliver = det.evaluatePhoneShape(phone(0.95, 10, 90), FRAME);
  check('extreme sliver rejected even at 0.95', sliver.accept, false);
  check('sliver rejection reason', sliver.reason, 'too_elongated');
}

console.log('\n=== area guards ===');
{
  const speck = det.evaluatePhoneShape(phone(0.90, 5, 9), FRAME);
  check('sub-pixel speck rejected', speck.accept, false);
  check('speck reason', speck.reason, 'too_small');

  const wall = det.evaluatePhoneShape(phone(0.90, 500, 400), FRAME);
  check('frame-filling box rejected', wall.accept, false);
  check('oversize reason', wall.reason, 'too_large');

  // Without a frame the area guards are simply skipped, not silently failed.
  check('no frame -> area guards skipped', det.evaluatePhoneShape(phone(0.90, 5, 9)).accept, true);
}

console.log('\n=== filterPhoneDetections ===');
{
  // Scores re-pointed at the 0.30 / 0.50 operating point: the square sits above
  // the rectangular floor but below the square one, and the "low confidence"
  // case sits below BOTH. Under the old 0.60/0.75 bars these were 0.65 and
  // 0.40; the roles they play in this test are unchanged.
  const mixed = [
    phone(0.82, 40, 71),                                             // real phone
    phone(0.42, 50, 50),                                             // square artifact
    phone(0.22, 40, 71),                                             // low confidence
    { score: 0.91, classId: det.COCO_LAPTOP, box: { x1: 0, y1: 0, x2: 200, y2: 140 } },
  ];
  const { phones, rejected } = det.filterPhoneDetections(mixed, FRAME);

  check('only the real phone survives', phones.length, 1);
  check('survivor keeps its score', phones[0].score, 0.82);
  checkTrue('survivor carries its shape verdict', !!phones[0].shape);
  check('two phone candidates rejected', rejected.length, 2);
  // Non-phone classes are not this gate's business — it neither accepts nor
  // rejects them, it ignores them, and the caller reattaches them.
  check('laptop is not treated as a phone candidate',
    rejected.concat(phones).some((d) => d.classId === det.COCO_LAPTOP), false);
}

console.log('\n=== DetectionLatch: 1-frame glimpse ===');
{
  const latch = new det.DetectionLatch({ holdFrames: 45, holdMs: 1500 });

  // Frame 0: a single hit. This is the whole requirement — no dwell, no vote.
  const first = latch.update(true, 0, 0.83);
  check('single frame latches immediately', first.event, 'latch');
  check('latch is active', first.active, true);
  check('peak score recorded', first.peakScore, 0.83);

  // The phone is gone from frame 1 onward. At ~20 FPS (50 ms/frame) it must
  // still read as detected for the whole hold window.
  let state = null;
  for (let f = 1; f <= 20; f++) state = latch.update(false, f * 50, 0);
  check('still latched 20 frames after the phone vanished', state.active, true);
  check('no spurious second latch', state.event, 'hold');

  for (let f = 21; f <= 44; f++) state = latch.update(false, f * 50, 0);
  check('still latched at frame 44', state.active, true);

  // Frame 45 satisfies BOTH holdFrames (45) and holdMs (45*50 = 2250 >= 1500).
  state = latch.update(false, 45 * 50, 0);
  check('releases once both frame and time floors are met', state.event, 'release');
  check('no longer active after release', state.active, false);
  check('hit count reported for the episode', state.hitCount, 1);
}

console.log('\n=== DetectionLatch: 5-frame glimpse then hide ===');
{
  const latch = new det.DetectionLatch({ holdFrames: 45, holdMs: 1500 });

  const ev = [];
  for (let f = 0; f < 5; f++) ev.push(latch.update(true, f * 50, 0.7 + f * 0.01).event);
  check('one latch event for a 5-frame glimpse', ev.filter((e) => e === 'latch').length, 1);
  check('subsequent hit frames are holds', ev.slice(1), ['hold', 'hold', 'hold', 'hold']);
  check('peak tracks the best frame', Number(latch.peakScore.toFixed(2)), 0.74);

  // Hidden immediately afterwards — the recorded alert must not be erased.
  const after = latch.update(false, 5 * 50, 0);
  check('hiding the phone does not clear the latch', after.active, true);
}

console.log('\n=== DetectionLatch: hold floors ===');
{
  // A fast machine burning through frames must still honour the 1.5 s floor:
  // 45 frames at 5 ms is only 225 ms of real time.
  const fast = new det.DetectionLatch({ holdFrames: 45, holdMs: 1500 });
  fast.update(true, 0, 0.9);
  let s = null;
  for (let f = 1; f <= 60; f++) s = fast.update(false, f * 5, 0);
  check('frame floor alone does not release early', s.active, true);

  // Conversely a stalled machine must honour the 45-frame floor: 3 frames
  // spanning 3 s is not 45 frames.
  const slow = new det.DetectionLatch({ holdFrames: 45, holdMs: 1500 });
  slow.update(true, 0, 0.9);
  let s2 = null;
  for (let f = 1; f <= 3; f++) s2 = slow.update(false, f * 1000, 0);
  check('time floor alone does not release early', s2.active, true);
}

console.log('\n=== DetectionLatch: sustained use ===');
{
  // A phone held in frame for a long time is ONE episode, not one per frame.
  const latch = new det.DetectionLatch({ holdFrames: 45, holdMs: 1500 });
  let latches = 0;
  for (let f = 0; f < 200; f++) {
    if (latch.update(true, f * 50, 0.8).event === 'latch') latches++;
  }
  check('continuous presence produces one episode', latches, 1);
  check('episode counter agrees', latch.episodes, 1);

  // And the hold clock restarts from the LAST hit, not the first.
  let s = null;
  for (let f = 200; f < 240; f++) s = latch.update(false, f * 50, 0);
  check('40 frames after the last hit: still held', s.active, true);
}

console.log('\n=== DetectionLatch: reset ===');
{
  const latch = new det.DetectionLatch();
  latch.update(true, 0, 0.9);
  latch.reset();
  check('reset clears the latch', latch.active, false);
  check('reset clears the peak', latch.peakScore, 0);
  check('reset clears the episode counter', latch.episodes, 0);
}

console.log('\n=== TimeSlicedScheduler: continuous mode ===');
{
  // The phone detector must not be throttled at all — the single-flight lock is
  // the only brake. A 250 ms floor would drop ~5 frames per second, which at a
  // 5-frame glimpse is the difference between catching it and not.
  const s = new det.TimeSlicedScheduler({ intervalMs: 0, jitterMs: 0, minGapMs: 0 });
  checkTrue('continuous scheduler reports itself as such', s.isContinuous);

  s.begin(0);
  check('single-flight still blocks a concurrent run', s.shouldRun(1), false);
  s.end(30);
  checkTrue('due again on the very next frame', s.shouldRun(30));

  // The legacy sliced mode keeps its floor.
  const sliced = new det.TimeSlicedScheduler({ intervalMs: 1750, jitterMs: 0 });
  sliced.begin(0);
  sliced.end(1000);
  check('sliced mode still throttles', sliced.shouldRun(1100), false);
  check('sliced mode is not continuous', sliced.isContinuous, false);
}

console.log(`\n${checks} checks — ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
