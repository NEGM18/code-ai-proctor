// =============================================================================
// evidence_buffer.test.js — peak-frame evidence selection
//
// The behaviour under test is the one the brief describes: an alert fires
// SECONDS after the behaviour it describes, and must still be illustrated with
// the frame that earned it rather than whatever the student is doing at report
// time.
//
// Everything here is deterministic. Time is a number the test controls and the
// "encoder" is a thunk returning a label, so a frame's identity is checkable by
// equality and no canvas is involved.
// =============================================================================

const assert = require('assert');
const path = require('path');

const {
  EVIDENCE_BUFFER_DEFAULTS,
  EVIDENCE_SOURCE,
  evidenceScore,
  EvidenceRingBuffer,
} = require(path.join(__dirname, '..', 'content', 'vision', 'evidence_buffer.js'));

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

/** A buffer whose throttle is off, so tests control admission explicitly. */
const unthrottled = (opts = {}) => new EvidenceRingBuffer({ minIntervalMs: 0, ...opts });
/** Encoder returning a stable, identifiable label per frame. */
const enc = (label) => () => `img:${label}`;

console.log('\n=== evidenceScore — frame ranking ===');

check('empty input scores zero', evidenceScore({}).score, 0);
check('empty input has no source', evidenceScore({}).source, EVIDENCE_SOURCE.NONE);

// fullScale defaults to 2: an excursion of 1.0 (this student's own tolerance
// boundary) is a mid-scale 0.5, and 2.0 saturates.
check('excursion at tolerance boundary is mid-scale',
  evidenceScore({ poseExcursion: 1.0 }).score, 0.5);
check('excursion at 2x boundary saturates',
  evidenceScore({ poseExcursion: 2.0 }).score, 1);
check('excursion beyond full scale clamps to 1',
  evidenceScore({ poseExcursion: 9.0 }).score, 1);

check('classifier probability passes through',
  evidenceScore({ classifierProb: 0.62 }).score, 0.62);
check('probability above 1 clamps', evidenceScore({ classifierProb: 4 }).score, 1);
check('negative probability clamps to 0', evidenceScore({ classifierProb: -3 }).score, 0);

// MAX, not sum or mean — the question is "what is the best reason to keep this
// frame", and averaging lets two quiet signals outrank one loud one.
check('takes the max across signals, not the sum',
  evidenceScore({ poseExcursion: 1.0, classifierProb: 0.9 }).score, 0.9);
check('attributes the winning source',
  evidenceScore({ poseExcursion: 1.0, classifierProb: 0.9 }).source, EVIDENCE_SOURCE.CLASSIFIER);
check('attributes pose when pose wins',
  evidenceScore({ poseExcursion: 2.0, classifierProb: 0.3 }).source, EVIDENCE_SOURCE.POSE);
check('attributes gaze when gaze wins',
  evidenceScore({ gazeExcursion: 2.0, poseExcursion: 0.1 }).source, EVIDENCE_SOURCE.GAZE);

// Unreadable observations must not manufacture magnitude — the pipeline-wide
// rule that keeps "we could not see" from becoming "the student did something".
check('NaN excursion scores zero', evidenceScore({ poseExcursion: NaN }).score, 0);
check('null excursion scores zero', evidenceScore({ poseExcursion: null }).score, 0);
check('undefined classifier scores zero', evidenceScore({ classifierProb: undefined }).score, 0);
check('negative excursion scores zero', evidenceScore({ poseExcursion: -5 }).score, 0);

console.log('\n=== admission: throttle, score floor, lazy encoding ===');

{
  const b = new EvidenceRingBuffer({ minIntervalMs: 150 });
  checkTrue('first frame is admitted', !!b.capture(1000, 0.5, enc('a')));
  check('a throttled frame is rejected', b.capture(1050, 0.9, enc('b')), null);
  checkTrue('a frame past the interval is admitted', !!b.capture(1200, 0.5, enc('c')));
  check('throttle rejections are counted', b.telemetry().throttled, 1);
  check('only admitted frames are retained', b.size, 2);
}

{
  const b = unthrottled();
  check('a frame below the score floor is rejected',
    b.capture(1000, EVIDENCE_BUFFER_DEFAULTS.minScore - 0.001, enc('x')), null);
  check('floor rejections are counted', b.telemetry().below_floor, 1);
}

// ⚠ The property that keeps this affordable per-frame: the expensive encode is
// behind a thunk and must NOT run for a frame that is rejected.
{
  const b = new EvidenceRingBuffer({ minIntervalMs: 150 });
  let encodeCalls = 0;
  const counting = () => { encodeCalls++; return 'img'; };

  b.capture(1000, 0.5, counting);
  check('admitted frame encodes once', encodeCalls, 1);
  b.capture(1050, 0.5, counting);
  check('THROTTLED frame does not encode', encodeCalls, 1);
  b.capture(1300, 0.001, counting);
  check('BELOW-FLOOR frame does not encode', encodeCalls, 1);
}

{
  const b = unthrottled();
  check('a failed encode stores nothing', b.capture(1000, 0.9, () => null), null);
  check('encode failures are counted', b.telemetry().encode_failures, 1);
  check('a throwing encoder is contained', b.capture(1100, 0.9, () => { throw new Error('boom'); }), null);
  check('a throw counts as an encode failure', b.telemetry().encode_failures, 2);
  check('nothing is retained after failures', b.size, 0);
}

console.log('\n=== bounds: window and count ===');

{
  const b = unthrottled({ windowMs: 1000, maxFrames: 50 });
  b.capture(1000, 0.5, enc('old'));
  b.capture(1500, 0.5, enc('mid'));
  b.capture(2600, 0.5, enc('new')); // prunes anything before 1600
  check('entries older than the window are dropped', b.size, 1);
  check('the surviving entry is the newest', b.peakSince(-Infinity).image, 'img:new');
}

{
  const b = unthrottled({ windowMs: 1e9, maxFrames: 3 });
  for (let i = 0; i < 10; i++) b.capture(1000 + i, 0.5, enc(i));
  check('count bound is enforced independently of the window', b.size, 3);
  check('the oldest entries are the ones evicted',
    b.peakSince(-Infinity).image, 'img:7');
  check('evictions are counted', b.telemetry().evicted, 7);
}

console.log('\n=== peak selection — THE POINT OF THIS MODULE ===');

// The scenario from the brief: the student looks away (excursion climbs, peaks,
// falls), the dwell gate fires 2.5 s after onset, and by then they are back to
// neutral. A live snapshot shows a compliant student; the peak frame does not.
{
  const b = unthrottled();
  b.capture(0,    0.30, enc('onset'));
  b.capture(500,  0.55, enc('rising'));
  b.capture(1000, 0.95, enc('PEAK'));
  b.capture(1500, 0.60, enc('falling'));
  b.capture(2000, 0.20, enc('returning'));
  b.capture(2500, 0.06, enc('live-at-report'));

  const peak = b.peakSince(-Infinity);
  check('the peak frame is selected, not the live one', peak.image, 'img:PEAK');
  check('the peak score is reported', peak.score, 0.95);
  check('the peak predates the report', peak.t, 1000);
}

// The backward reach is the whole reason this is a buffer rather than a running
// maximum: the episode's peak can precede the moment the gate armed.
{
  const b = unthrottled();
  b.capture(0,    0.99, enc('BEFORE-ARMING'));
  b.capture(3000, 0.40, enc('after'));
  check('a peak before the window start is excluded',
    b.peakSince(2000).image, 'img:after');
  check('a peak inside the window is found',
    b.peakSince(-Infinity).image, 'img:BEFORE-ARMING');
}

{
  const b = unthrottled();
  check('peakSince on an empty buffer is null', b.peakSince(-Infinity), null);
}

// Ties resolve EARLIER: the first moment the peak was reached sits closer to
// the onset, and a later frame of equal score is likelier to catch the student
// already returning to neutral.
{
  const b = unthrottled();
  b.capture(100, 0.7, enc('first'));
  b.capture(200, 0.7, enc('second'));
  check('ties resolve to the earlier frame', b.peakSince(-Infinity).image, 'img:first');
}

// ⚠ Reading must not prune. A caller reaching back across the window boundary
// would otherwise silently lose the frame it asked for, degrading this to the
// live-snapshot behaviour it replaces.
{
  const b = unthrottled({ windowMs: 500 });
  b.capture(1000, 0.9, enc('kept'));
  const found = b.peakSince(0);
  checkTrue('peakSince does not prune out the frame it returns', !!found);
  check('and the buffer still holds it afterwards', b.size, 1);
}

console.log('\n=== cleanup — no retained frames after clear ===');

{
  const b = unthrottled();
  for (let i = 0; i < 5; i++) b.capture(1000 + i * 10, 0.5, enc(i));
  check('frames accumulate', b.size, 5);

  b.clear();
  check('clear releases every entry', b.size, 0);
  check('clear leaves nothing findable', b.peakSince(-Infinity), null);
  check('telemetry reports an empty buffer', b.telemetry().size, 0);

  // The throttle clock is cleared too, so the first frame of the next session
  // is admitted immediately instead of waiting out the previous one's interval.
  checkTrue('the next capture after clear is admitted', !!b.capture(1000, 0.5, enc('next')));
}

// A buffer holding only strings has nothing to dispose: the entries are
// immutable primitives, not canvases or ImageData, so dropping the reference IS
// the cleanup. This asserts the representation, since that is what makes the
// leak impossible rather than merely unlikely.
{
  const b = unthrottled();
  b.capture(1000, 0.5, enc('a'));
  const entry = b.peakSince(-Infinity);
  check('entries hold a string image, never an object', typeof entry.image, 'string');
  check('entry shape is flat and primitive',
    Object.keys(entry).sort(), ['image', 'score', 'source', 't']);
}

console.log('\n=== steady state: a still student costs nothing ===');

// The common case for most of an exam. Every frame is below the score floor, so
// nothing is encoded and nothing is retained — the buffer must not fill with
// neutral frames and crowd out the one that matters.
{
  const b = unthrottled();
  let encodeCalls = 0;
  for (let t = 0; t < 60000; t += 100) {
    b.capture(t, evidenceScore({ poseExcursion: 0.02 }), () => { encodeCalls++; return 'img'; });
  }
  check('600 neutral frames encode nothing', encodeCalls, 0);
  check('and retain nothing', b.size, 0);
}

// Bounded memory under a sustained high-score episode at a realistic Tier A
// cadence (20 FPS for 60 s = 1200 offered frames).
{
  const b = new EvidenceRingBuffer();
  for (let i = 0; i < 1200; i++) b.capture(i * 50, 0.9, enc(i));
  checkTrue('retention stays within maxFrames', b.size <= EVIDENCE_BUFFER_DEFAULTS.maxFrames);
  checkTrue('retention stays within the time window',
    b.telemetry().span_ms <= EVIDENCE_BUFFER_DEFAULTS.windowMs);
  checkTrue('the throttle rejected most offered frames',
    b.telemetry().throttled > b.telemetry().captures);
}

console.log(`\n${checks} checks — ${failures ? `${failures} FAILED` : 'ALL PASS'}`);
process.exit(failures ? 1 : 0);
