// Tests for the ONNX output decoders.
//
//   node extension/test/detectors.test.js
//
// Tensor shapes here are the REAL exported signatures, verified against the
// models in backend/static/models/:
//   pose.onnx    input [1,3,256,256]  output0 [1, 56, 1344]  channels-first
//   detect.onnx  input [1,3,448,448]  output0 [1, 84, 4116]  channels-first
// Coordinates arrive in input-pixel space, scores are already sigmoid'd, and no
// NMS is baked in - the decoder must do its own.

const det = require('../content/vision/detectors.js');

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}
function checkClose(name, actual, expected, tol = 1e-6) {
  checks++;
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${actual}, want ${expected} +/-${tol})`}`);
}
const checkTrue = (name, cond) => check(name, !!cond, true);

const POSE_CH = 56;
const POSE_ANCHORS = 1344;
const DET_CH = 84;
const DET_ANCHORS = 4116;

/** A 640x480 source letterboxed into 256: scale 0.4, vertical padding 32. */
const LB = { scale: 0.4, padX: 0, padY: 32, srcW: 640, srcH: 480 };

/** Write a value into a channels-first [1,C,A] buffer. */
const setCF = (buf, anchors, c, a, v) => { buf[c * anchors + a] = v; };

console.log('=== layout resolution ===');
{
  check('channels-first pose layout',
    det.resolveYoloLayout([1, 56, 1344], 56),
    { channels: 56, anchors: 1344, channelsFirst: true });

  // Defensive: an exporter change that transposes the head must not silently
  // produce garbage.
  check('transposed pose layout still resolves',
    det.resolveYoloLayout([1, 1344, 56], 56),
    { channels: 56, anchors: 1344, channelsFirst: false });

  check('channels-first detect layout',
    det.resolveYoloLayout([1, 84, 4116], 84),
    { channels: 84, anchors: 4116, channelsFirst: true });

  check('unknown layout rejected', det.resolveYoloLayout([1, 99, 100], 84), null);
  check('wrong rank rejected', det.resolveYoloLayout([1, 84], 84), null);
}

console.log('\n=== decodePoseOutput ===');
{
  const buf = new Float32Array(POSE_CH * POSE_ANCHORS);
  const A = 100;

  setCF(buf, POSE_ANCHORS, 0, A, 128);  // cx (input space)
  setCF(buf, POSE_ANCHORS, 1, A, 128);  // cy
  setCF(buf, POSE_ANCHORS, 2, A, 80);   // w
  setCF(buf, POSE_ANCHORS, 3, A, 160);  // h
  setCF(buf, POSE_ANCHORS, 4, A, 0.90); // person score

  // Nose (kp 0) at input-space (128, 100) -> source (320, 170)
  setCF(buf, POSE_ANCHORS, 5, A, 128);
  setCF(buf, POSE_ANCHORS, 6, A, 100);
  setCF(buf, POSE_ANCHORS, 7, A, 0.95);
  // Left eye (kp 1) - subject's left, so larger image x
  setCF(buf, POSE_ANCHORS, 8, A, 136);
  setCF(buf, POSE_ANCHORS, 9, A, 92);
  setCF(buf, POSE_ANCHORS, 10, A, 0.93);
  // Right eye (kp 2)
  setCF(buf, POSE_ANCHORS, 11, A, 120);
  setCF(buf, POSE_ANCHORS, 12, A, 92);
  setCF(buf, POSE_ANCHORS, 13, A, 0.91);

  const persons = det.decodePoseOutput(buf, [1, POSE_CH, POSE_ANCHORS], LB);

  check('one person decoded', persons.length, 1);
  checkClose('person score', persons[0].score, 0.90, 1e-6);
  check('17 keypoints returned', persons[0].keypoints.length, 17);

  // Keypoints must come back in SOURCE pixel coordinates, not input space.
  checkClose('nose x unletterboxed to source', persons[0].keypoints[0].x, 320, 1e-4);
  checkClose('nose y unletterboxed to source', persons[0].keypoints[0].y, 170, 1e-4);
  checkClose('nose score preserved', persons[0].keypoints[0].score, 0.95, 1e-6);

  // Box: cx=128,w=80 -> x1=88 input -> 220 source; cy=128,h=160 -> y1=48 -> 40 source
  checkClose('box x1 unletterboxed', persons[0].box.x1, 220, 1e-4);
  checkClose('box y1 unletterboxed', persons[0].box.y1, 40, 1e-4);

  // The decoded eyes must feed the geometry module correctly end to end.
  const geom = require('../content/vision/pose_geometry.js');
  const pose = geom.computeHeadPose(persons[0].keypoints);
  checkTrue('decoded keypoints produce a valid pose', pose.valid);
  checkClose('level head reads ~0 roll (not 180)', pose.rollDeg, 0, 1e-6);
}

// Sub-threshold anchors are dropped.
{
  const buf = new Float32Array(POSE_CH * POSE_ANCHORS);
  setCF(buf, POSE_ANCHORS, 4, 7, 0.20); // below default 0.45
  check('low-score person dropped', det.decodePoseOutput(buf, [1, POSE_CH, POSE_ANCHORS], LB).length, 0);
}

// Duplicate anchors on the same person collapse to one detection.
{
  const buf = new Float32Array(POSE_CH * POSE_ANCHORS);
  for (const a of [10, 11, 12]) {
    setCF(buf, POSE_ANCHORS, 0, a, 128);
    setCF(buf, POSE_ANCHORS, 1, a, 128);
    setCF(buf, POSE_ANCHORS, 2, a, 80);
    setCF(buf, POSE_ANCHORS, 3, a, 160);
    setCF(buf, POSE_ANCHORS, 4, a, 0.8 + a * 0.001);
  }
  check('NMS collapses duplicate person anchors',
    det.decodePoseOutput(buf, [1, POSE_CH, POSE_ANCHORS], LB).length, 1);
}

// Two genuinely separate people survive NMS.
{
  const buf = new Float32Array(POSE_CH * POSE_ANCHORS);
  const mk = (a, cx) => {
    setCF(buf, POSE_ANCHORS, 0, a, cx);
    setCF(buf, POSE_ANCHORS, 1, a, 128);
    setCF(buf, POSE_ANCHORS, 2, a, 40);
    setCF(buf, POSE_ANCHORS, 3, a, 120);
    setCF(buf, POSE_ANCHORS, 4, a, 0.85);
  };
  mk(20, 60);
  mk(21, 200);
  check('two separated people both kept',
    det.decodePoseOutput(buf, [1, POSE_CH, POSE_ANCHORS], LB).length, 2);
}

console.log('\n=== decodeDetectOutput (phone) ===');
{
  const buf = new Float32Array(DET_CH * DET_ANCHORS);
  const A = 500;
  const DLB = { scale: 0.7, padX: 0, padY: 56, srcW: 640, srcH: 480 };

  setCF(buf, DET_ANCHORS, 0, A, 224);
  setCF(buf, DET_ANCHORS, 1, A, 224);
  setCF(buf, DET_ANCHORS, 2, A, 40);
  setCF(buf, DET_ANCHORS, 3, A, 70);
  // There is NO objectness channel: class c lives at channel 4+c, so cell phone
  // (COCO 67) is channel 71.
  setCF(buf, DET_ANCHORS, 4 + det.COCO_CELL_PHONE, A, 0.82);

  const found = det.decodeDetectOutput(buf, [1, DET_CH, DET_ANCHORS], DLB);
  check('phone detected', found.length, 1);
  check('classId is COCO 67', found[0].classId, det.COCO_CELL_PHONE);
  checkClose('phone score', found[0].score, 0.82, 1e-6);
  checkClose('phone box unletterboxed', found[0].box.x1, (224 - 20) / 0.7, 1e-4);
}

// Classes outside the filter are ignored, however confident.
{
  const buf = new Float32Array(DET_CH * DET_ANCHORS);
  setCF(buf, DET_ANCHORS, 0, 300, 224);
  setCF(buf, DET_ANCHORS, 1, 300, 224);
  setCF(buf, DET_ANCHORS, 2, 300, 60);
  setCF(buf, DET_ANCHORS, 3, 300, 60);
  setCF(buf, DET_ANCHORS, 4 + det.COCO_PERSON, 300, 0.99);

  check('person ignored when filtering for phones',
    det.decodeDetectOutput(buf, [1, DET_CH, DET_ANCHORS], LB).length, 0);

  check('same anchor found when person is in the filter',
    det.decodeDetectOutput(buf, [1, DET_CH, DET_ANCHORS], LB,
      { classFilter: [det.COCO_PERSON] }).length, 1);
}

// Secondary-screen classes are opt-in and work through the same path.
{
  const buf = new Float32Array(DET_CH * DET_ANCHORS);
  setCF(buf, DET_ANCHORS, 0, 900, 200);
  setCF(buf, DET_ANCHORS, 1, 900, 200);
  setCF(buf, DET_ANCHORS, 2, 900, 100);
  setCF(buf, DET_ANCHORS, 3, 900, 80);
  setCF(buf, DET_ANCHORS, 4 + det.COCO_LAPTOP, 900, 0.77);

  const r = det.decodeDetectOutput(buf, [1, DET_CH, DET_ANCHORS], LB,
    { classFilter: [det.COCO_CELL_PHONE, det.COCO_LAPTOP] });
  check('laptop detected when opted in', r.length, 1);
  check('laptop classId', r[0].classId, det.COCO_LAPTOP);
}

console.log('\n=== geometry helpers ===');
{
  const a = { x1: 0, y1: 0, x2: 10, y2: 10 };
  checkClose('iou of identical boxes', det.iou(a, a), 1, 1e-9);
  checkClose('iou of disjoint boxes', det.iou(a, { x1: 20, y1: 20, x2: 30, y2: 30 }), 0, 1e-9);
  checkClose('iou of half-overlap', det.iou(a, { x1: 5, y1: 0, x2: 15, y2: 10 }), 50 / 150, 1e-9);
}

console.log('\n=== TimeSlicedScheduler ===');
{
  const s = new det.TimeSlicedScheduler({ intervalMs: 1750, jitterMs: 0 });
  checkTrue('runs immediately on first call', s.shouldRun(0));

  s.begin(0);
  check('blocked while a run is in flight', s.shouldRun(10), false);

  s.end(1000); // the run itself took 1 s
  check('blocked before the interval elapses', s.shouldRun(2000), false);
  checkTrue('runs once the interval elapses', s.shouldRun(2800));

  // Interval is measured from COMPLETION, so a slow detector spaces out rather
  // than stacking up on exactly the machines the budget exists to protect.
  const s2 = new det.TimeSlicedScheduler({ intervalMs: 1750, jitterMs: 0 });
  s2.begin(0);
  s2.end(5000); // pathologically slow run
  check('slow run does not become immediately due again', s2.shouldRun(5100), false);
  checkTrue('slow run is due one interval after finishing', s2.shouldRun(6800));
}

console.log(`\n${checks} checks — ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
