// Integration test for the browser-globals wiring of the vision pipeline.
//
//   node extension/test/vision_integration.test.js
//
// The unit tests load each module through CommonJS. The EXTENSION does not: the
// scripts are plain content scripts that attach to `window` and resolve their
// dependencies off it at load time. That makes manifest.json ordering
// load-bearing, and a wrong order fails at runtime, not at parse time.
//
// So this test reads the script list straight out of manifest.json and evaluates
// it in that exact order in a shared fake-window context. If someone reorders
// the manifest or adds a module without registering it, this goes red.

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const EXT_DIR = path.resolve(__dirname, '..');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}
const checkTrue = (name, cond) => check(name, !!cond, true);

// --- Load exactly what the manifest says, in the order it says --------------
const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
const scripts = manifest.content_scripts[0].js;
const visionScripts = scripts.filter((s) => s.startsWith('content/vision/'));

check('manifest registers all twelve vision modules', visionScripts.length, 12);

// --- MediaPipe WASM loader triple ------------------------------------------
//
// ⚠ THESE THREE ARE A UNIT AND THE ORDER IS THE MECHANISM, not a preference.
//
// `vision_wasm_internal.js` is a classic script whose UMD tail exports the WASM
// factory. Loading it as a content script is what puts `globalThis.ModuleFactory`
// in the ISOLATED world, where tasks-vision.js looks for it — MediaPipe's own
// loader injects it into the PAGE world instead, which is why it threw
// `ModuleFactory not set.` every time. eval() is not an alternative: MV3 blocks
// it in content scripts.
//
// open   -> installs the CommonJS shim the UMD tail needs
// loader -> exports the factory into that shim
// close  -> moves it to globalThis and REMOVES the shim
//
// If anything is listed between open and close, it sees a global `module` and
// takes its own CommonJS branch — `mediapipe_source.js` does exactly that and
// would stop assigning `root.MediaPipeExtensionSource`.
const MP_OPEN = 'content/mediapipe_wasm_open.js';
const MP_LOADER = 'lib/mediapipe/wasm/vision_wasm_internal.js';
const MP_CLOSE = 'content/mediapipe_wasm_close.js';

check('manifest registers the MediaPipe wasm open shim', scripts.indexOf(MP_OPEN) !== -1, true);
check('manifest registers the MediaPipe wasm loader', scripts.indexOf(MP_LOADER) !== -1, true);
check('manifest registers the MediaPipe wasm close shim', scripts.indexOf(MP_CLOSE) !== -1, true);
check('wasm loader is loaded AFTER the open shim',
  scripts.indexOf(MP_OPEN) < scripts.indexOf(MP_LOADER), true);
check('close shim is loaded AFTER the wasm loader',
  scripts.indexOf(MP_LOADER) < scripts.indexOf(MP_CLOSE), true);
check('the loader triple is contiguous — nothing may load inside the shim',
  scripts.indexOf(MP_CLOSE) - scripts.indexOf(MP_OPEN), 2);
check('ModuleFactory exists before mediapipe_source.js runs',
  scripts.indexOf(MP_CLOSE) < scripts.indexOf('content/mediapipe_source.js'), true);
check('ModuleFactory exists before vision_engine.js runs',
  scripts.indexOf(MP_CLOSE) < scripts.indexOf('content/vision/vision_engine.js'), true);

// Ordering contract: every module must appear after the ones it depends on.
const orderOf = (f) => visionScripts.indexOf(f);

// runtime_profile lives under content/vision/ but is consumed by
// content/onnx_inference.js too, so its position is checked against the FULL
// script list, not just the vision subset. Loading it late would leave the
// classifier calling resolveRuntimeProfile() before it exists.
checkTrue('runtime_profile precedes onnx_inference',
  scripts.indexOf('content/vision/runtime_profile.js') < scripts.indexOf('content/onnx_inference.js'));
checkTrue('runtime_profile precedes vision_engine',
  orderOf('content/vision/runtime_profile.js') < orderOf('content/vision/vision_engine.js'));

// The liveness overlay lives in content/ (it is UI, not a vision model) but
// monitor.js reads LivenessChallengeManager off window, so it has the same
// hard ordering requirement.
checkTrue('liveness_challenge is registered',
  scripts.indexOf('content/liveness_challenge.js') !== -1);
checkTrue('liveness_challenge precedes monitor',
  scripts.indexOf('content/liveness_challenge.js') < scripts.indexOf('content/monitor.js'));
// lighting_checker.js is the pre-exam readiness gate. Like liveness_challenge
// it lives in content/ rather than content/vision/ because it is setup UI, not
// part of the per-frame vision pipeline — so it does NOT move the module count
// above. It still has a hard ordering requirement in both directions: it
// resolves rgbaToGray off window (published by gaze_roi.js), and monitor.js
// constructs LightingChecker.
checkTrue('lighting_checker is registered',
  scripts.indexOf('content/lighting_checker.js') !== -1);
checkTrue('gaze_roi precedes lighting_checker',
  scripts.indexOf('content/vision/gaze_roi.js') < scripts.indexOf('content/lighting_checker.js'));
checkTrue('lighting_checker precedes monitor',
  scripts.indexOf('content/lighting_checker.js') < scripts.indexOf('content/monitor.js'));

checkTrue('pose_geometry precedes pose_pipeline',
  orderOf('content/vision/pose_geometry.js') < orderOf('content/vision/pose_pipeline.js'));
checkTrue('pose_calibration precedes pose_pipeline',
  orderOf('content/vision/pose_calibration.js') < orderOf('content/vision/pose_pipeline.js'));
checkTrue('temporal_gate precedes pose_pipeline',
  orderOf('content/vision/temporal_gate.js') < orderOf('content/vision/pose_pipeline.js'));
checkTrue('detectors precedes vision_engine',
  orderOf('content/vision/detectors.js') < orderOf('content/vision/vision_engine.js'));
checkTrue('pose_pipeline precedes vision_engine',
  orderOf('content/vision/pose_pipeline.js') < orderOf('content/vision/vision_engine.js'));

// gaze_roi resolves PoseBaseline (pose_calibration) and DwellGate/
// TemporalSmoother (temporal_gate) off window at load, and vision_engine
// constructs GazeSampler/GazeAnalyzer, so it must sit between them.
checkTrue('gaze_roi is registered',
  orderOf('content/vision/gaze_roi.js') !== -1);
checkTrue('pose_calibration precedes gaze_roi',
  orderOf('content/vision/pose_calibration.js') < orderOf('content/vision/gaze_roi.js'));
checkTrue('temporal_gate precedes gaze_roi',
  orderOf('content/vision/temporal_gate.js') < orderOf('content/vision/gaze_roi.js'));
checkTrue('gaze_roi precedes vision_engine',
  orderOf('content/vision/gaze_roi.js') < orderOf('content/vision/vision_engine.js'));

// gaze_landmarks resolves the same two frozen modules off window.
checkTrue('gaze_landmarks is registered',
  orderOf('content/vision/gaze_landmarks.js') !== -1);
checkTrue('pose_calibration precedes gaze_landmarks',
  orderOf('content/vision/pose_calibration.js') < orderOf('content/vision/gaze_landmarks.js'));
checkTrue('temporal_gate precedes gaze_landmarks',
  orderOf('content/vision/temporal_gate.js') < orderOf('content/vision/gaze_landmarks.js'));
checkTrue('gaze_landmarks precedes vision_engine',
  orderOf('content/vision/gaze_landmarks.js') < orderOf('content/vision/vision_engine.js'));

// ear_veto imports eyeAspectRatio + LANDMARK_CONTRACT off window rather than
// re-deriving EAR, so gaze_landmarks MUST already have loaded. monitor.js then
// constructs EarVetoGate at module scope.
checkTrue('ear_veto is registered',
  orderOf('content/vision/ear_veto.js') !== -1);
checkTrue('gaze_landmarks precedes ear_veto',
  orderOf('content/vision/gaze_landmarks.js') < orderOf('content/vision/ear_veto.js'));
checkTrue('ear_veto precedes monitor',
  scripts.indexOf('content/vision/ear_veto.js') < scripts.indexOf('content/monitor.js'));

// --- gaze_fusion / evidence_buffer -----------------------------------------
//
// Both are consumed ONLY by monitor.js, so the single hard requirement is that
// they precede it. gaze_fusion is additionally placed after gaze_landmarks
// because it escalates that module's events and its thresholds are stated in
// that module's units (excursion from calibrated neutral, hRatio offset) — a
// reader who meets the fusion first has no way to interpret them.
checkTrue('gaze_fusion is registered',
  orderOf('content/vision/gaze_fusion.js') !== -1);
checkTrue('gaze_landmarks precedes gaze_fusion',
  orderOf('content/vision/gaze_landmarks.js') < orderOf('content/vision/gaze_fusion.js'));
checkTrue('gaze_fusion precedes monitor',
  scripts.indexOf('content/vision/gaze_fusion.js') < scripts.indexOf('content/monitor.js'));

checkTrue('evidence_buffer is registered',
  orderOf('content/vision/evidence_buffer.js') !== -1);
checkTrue('evidence_buffer precedes monitor',
  scripts.indexOf('content/vision/evidence_buffer.js') < scripts.indexOf('content/monitor.js'));

// Every vision module on disk must actually be registered.
const onDisk = fs.readdirSync(path.join(EXT_DIR, 'content', 'vision'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => `content/vision/${f}`)
  .sort();
check('every module on disk is registered in the manifest',
  onDisk.filter((f) => !visionScripts.includes(f)), []);

// --- Evaluate them in a shared fake-window context --------------------------
const ctx = {
  console: { log: () => {}, warn: () => {}, error: console.error },
  performance: { now: () => Date.now() },
  Math, JSON, Object, Array, Number, String, Boolean, Error, Promise, Set, Map,
  Float32Array, Uint8ClampedArray, isNaN, parseInt, parseFloat,
};
ctx.window = ctx;
ctx.self = ctx;
ctx.globalThis = ctx;
// Deliberately absent: OffscreenCanvas, document, ort. Nothing at module scope
// may touch them — only the runtime paths may, and those are not exercised here.
vm.createContext(ctx);

for (const rel of visionScripts) {
  const src = fs.readFileSync(path.join(EXT_DIR, rel), 'utf8');
  try {
    vm.runInContext(src, ctx, { filename: rel });
  } catch (err) {
    failures++;
    console.log(`FAIL  ${rel} threw at load: ${err.message}`);
  }
}

console.log('\n--- globals published to window ---');
for (const name of [
  'computeHeadPose', 'ratioToApproxDegrees', 'KP', 'POSE_INVALID',
  'PoseBaseline', 'median',
  'TemporalSmoother', 'DwellGate', 'GateState',
  'HeadPoseAnalyzer', 'PoseCondition', 'PipelineStatus',
  'EvidenceRingBuffer', 'evidenceScore', 'EVIDENCE_SOURCE',
  'GazeClassifierFusion', 'fuseGazeEvidence', 'FUSION_VERDICT', 'isSevereGaze',
  'letterbox', 'rgbaToNCHW', 'decodePoseOutput', 'decodeDetectOutput',
  'TimeSlicedScheduler', 'COCO_CELL_PHONE', 'COCO_LAPTOP', 'COCO_TV',
  'VisionEngine',
  // Phone precision gate + latch, and the shared hardware profile.
  'PHONE_SHAPE_DEFAULTS', 'evaluatePhoneShape', 'filterPhoneDetections', 'DetectionLatch',
  'RuntimeTier', 'TIER_PROFILES', 'probeWebGPU', 'resolveRuntimeProfile',
  'configureOrtEnv', 'createSession', 'clampInputSize',
  // The eye stack. vision_engine.js constructs GazeLandmarkAnalyzer and
  // GazeSampler off these globals at load(), and monitor.js constructs
  // EarVetoGate at module scope — a missing one is a runtime failure, not a
  // parse error, which is exactly what this suite exists to catch.
  'GazeLandmarkAnalyzer', 'LANDMARK_CONTRACT', 'GAZE_STATE',
  'GazeSampler', 'GazeAnalyzer',
  'EarVetoGate', 'VETOABLE_VIOLATIONS', 'NEVER_VETOABLE', 'VETO_REASON',
]) {
  checkTrue(`window.${name} is defined`, typeof ctx[name] !== 'undefined');
}

// --- End-to-end through the browser-global objects --------------------------
console.log('\n--- end-to-end via window globals ---');
{
  const KP = ctx.KP;
  // Subject's left eye sits at the LARGER image x (unmirrored webcam).
  const face = (yaw, pitch) => {
    const io = 60, cx = 320, cy = 240;
    const k = Array.from({ length: 17 }, () => ({ x: 0, y: 0, score: 0 }));
    k[KP.LEFT_EYE] = { x: cx + io / 2, y: cy, score: 0.9 };
    k[KP.RIGHT_EYE] = { x: cx - io / 2, y: cy, score: 0.9 };
    k[KP.NOSE] = { x: cx + yaw * io, y: cy + pitch * io, score: 0.9 };
    k[KP.LEFT_EAR] = { x: cx + io * 0.9, y: cy, score: 0.9 };
    k[KP.RIGHT_EAR] = { x: cx - io * 0.9, y: cy, score: 0.9 };
    return [{ score: 0.9, keypoints: k }];
  };

  const an = new ctx.HeadPoseAnalyzer();
  let t = 0;
  let last = null;
  const events = [];

  // An off-axis student sits still for 20 s.
  for (let i = 0; i < 100; i++) {
    last = an.process(face(0.25, 1.3), t);
    events.push(...last.events);
    t += 200;
  }
  check('e2e: calibrates through window globals', last.calibrated, true);
  check('e2e: off-axis student steady state is ok', last.status, 'ok');
  check('e2e: off-axis student generates no events', events, []);

  // Then genuinely turns away for 5 s.
  const awayEvents = [];
  for (let i = 0; i < 25; i++) {
    const r = an.process(face(1.2, 1.3), t);
    awayEvents.push(...r.events);
    t += 200;
  }
  checkTrue('e2e: sustained look-away alerts',
    awayEvents.some((e) => e.condition === 'LOOK_AWAY' && e.severity === 'HIGH'));
}

// --- Decoders reachable as globals, against real tensor shapes --------------
{
  const buf = new Float32Array(56 * 1344);
  const A = 42;
  const set = (c, v) => { buf[c * 1344 + A] = v; };
  set(0, 128); set(1, 128); set(2, 80); set(3, 160); set(4, 0.9);
  const persons = ctx.decodePoseOutput(buf, [1, 56, 1344], { scale: 0.4, padX: 0, padY: 32 });
  check('e2e: pose decoder reachable as a global', persons.length, 1);

  const dbuf = new Float32Array(84 * 4116);
  const setD = (c, v) => { dbuf[c * 4116 + 900] = v; };
  setD(0, 224); setD(1, 224); setD(2, 40); setD(3, 70);
  setD(4 + ctx.COCO_CELL_PHONE, 0.8);
  const found = ctx.decodeDetectOutput(dbuf, [1, 84, 4116], { scale: 0.7, padX: 0, padY: 56 });
  check('e2e: detect decoder finds the phone', found.length, 1);
  check('e2e: phone class id', found[0].classId, 67);
}

console.log(`\n${checks} checks — ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
