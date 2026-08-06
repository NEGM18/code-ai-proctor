// =============================================================================
// Synthetic landmark/geometry builders — test & scripted-replay infrastructure.
//
// ONE superset builder replacing four near-identical helpers that were
// duplicated across the upstream extension suites:
//
//   extension/test/gaze_landmarks.test.js   -> eye()/face()   (full: h, v, hLeft)
//   extension/test/keyboard_glance.test.js  -> eye()/face()   (+ sample()/off())
//   extension/test/blink_immunity.test.js   -> eye()/face()   (h only, v fixed)
//   extension/test/ear_veto.test.js         -> landmarksWithEar() (lids+corners
//                                               only, no iris)
//
// Lives under src/vision/testing/, NOT test/, on purpose (PLAN.md §6 Phase 2):
// headless engine tests import it for synthetic frames, and a future
// scripted-replay dev mode (ScriptedLandmarkSource, PLAN.md §6 Phase 3) imports
// the exact same builders so a recorded/synthetic session and a unit test are
// built from one definition. Nothing in the shipped app graph imports this
// file, so it tree-shakes out of the production bundle.
//
// Coordinates are IMAGE space throughout: x grows right, y grows DOWN, and the
// frame is UNMIRRORED — matching every upstream helper's convention.
// =============================================================================

import { LANDMARK_CONTRACT } from '../gaze_landmarks.js';

/**
 * Build one eye's five landmarks.
 *
 * Reconciles the two upstream `eye()` shapes:
 *   - gaze_landmarks.test.js / keyboard_glance.test.js pass a full `vFrac`.
 *   - blink_immunity.test.js has no vertical parameter at all — its iris sits
 *     at the eye's vertical centre. `vFrac` defaulting to 0.5 reproduces that
 *     exact geometry (iris.y = cy - open/2 + 0.5*open = cy), so nothing is
 *     averaged away: the three-argument caller and the five-argument caller
 *     get byte-identical output for the same cx/width/open/hFrac.
 *
 * @param {number} cx - eye centre x.
 * @param {number} width - corner-to-corner width (H in EAR = V/H).
 * @param {number} open - eyelid opening in px (V in EAR = V/H).
 * @param {number} hFrac - iris position along the eye axis, 0=image-left, 1=image-right.
 * @param {number} [vFrac=0.5] - iris position, 0=upper lid, 1=lower lid.
 * @param {boolean} [innerIsLeft=false] - is the NASAL ("inner") corner on the
 *   image-left side? The two eyes must be built with opposite values — that
 *   asymmetry is the whole point of orientedGazeRatio()'s data-derived flip.
 *   (Called `mirrored` in keyboard_glance.test.js/blink_immunity.test.js;
 *   `innerIsLeft` in gaze_landmarks.test.js. Identical meaning, kept under the
 *   more explicit name.)
 */
export function syntheticEye(cx, width, open, hFrac, vFrac = 0.5, innerIsLeft = false) {
  const cy = 100;
  const xL = cx - width / 2;
  const xR = cx + width / 2;
  return {
    upperLid: { x: cx, y: cy - open / 2 },
    lowerLid: { x: cx, y: cy + open / 2 },
    inner: { x: innerIsLeft ? xL : xR, y: cy },
    outer: { x: innerIsLeft ? xR : xL, y: cy },
    iris: { x: xL + hFrac * width, y: (cy - open / 2) + vFrac * open },
  };
}

/**
 * Assemble a full 478-point landmark array with two eyes built from
 * `syntheticEye`. Only the ten indices the engine reads are populated; every
 * other slot stays `undefined`, which also proves the engine never reaches
 * for a landmark it did not declare.
 *
 * The subject's RIGHT eye sits at the image-LEFT (cx=200); its nasal corner
 * faces the nose, i.e. toward image-RIGHT, so `innerIsLeft = false`. The
 * subject's LEFT eye sits at the image-RIGHT (cx=300); nasal corner toward
 * image-LEFT, so `innerIsLeft = true`. This fixed 200/300 layout, and the
 * fixed innerIsLeft assignment per side, is identical across all three
 * upstream `face()` builders that produce full landmark sets.
 *
 * @param {object} [opts]
 * @param {number} [opts.ear=0.30] - EAR applied to both eyes: open = ear*width.
 * @param {number} [opts.h=0.5] - horizontal iris fraction for BOTH eyes,
 *   unless overridden per-eye by `hLeft`.
 * @param {number} [opts.v=0.5] - vertical iris fraction for BOTH eyes.
 * @param {number|null} [opts.hLeft=null] - independent horizontal fraction
 *   for the subject's RIGHT eye only (gaze_landmarks.test.js's asymmetric
 *   cancellation-trap case). `null` means "use `h` for both eyes", which is
 *   exactly what keyboard_glance.test.js's and blink_immunity.test.js's
 *   simpler `face()` builders always did implicitly.
 * @param {number} [opts.width=40] - corner-to-corner eye width for both eyes.
 * @param {{yaw?:number, pitch?:number}|null} [opts.pose=null] - when non-null,
 *   ALSO populate the three COCO-5 points the head-pose channel needs. See
 *   `COCO5_LAYOUT` below. Default `null` keeps the array exactly as the four
 *   ported upstream suites have always seen it.
 * @returns {Array<{x:number,y:number}|undefined>} a LANDMARK_CONTRACT.pointCount array.
 */
export function syntheticFace({ ear = 0.30, h = 0.5, v = 0.5, hLeft = null, width = 40, pose = null } = {}) {
  const open = ear * width;
  const rightEye = syntheticEye(200, width, open, hLeft === null ? h : hLeft, v, false);
  const leftEye = syntheticEye(300, width, open, h, v, true);

  const pts = new Array(LANDMARK_CONTRACT.pointCount);
  const put = (idx, e) => {
    pts[idx.upperLid] = e.upperLid;
    pts[idx.lowerLid] = e.lowerLid;
    pts[idx.inner] = e.inner;
    pts[idx.outer] = e.outer;
    pts[idx.iris] = e.iris;
  };
  put(LANDMARK_CONTRACT.right, rightEye);
  put(LANDMARK_CONTRACT.left, leftEye);
  if (pose) putCoco5(pts, pose);
  return pts;
}

/* ===========================================================================
 * THE COCO-5 DOWN-PROJECTION POINTS — PLAN.md R2.
 *
 * `faceToCocoPerson` reads five indices out of the 478-set: nose 1, the two
 * irises 473/468 (already populated above), and the two tragions 454/234.
 * Only the irises were ever in this builder, because the four ported suites
 * exercise gaze and EAR, which never look at the head. The engine does — and
 * an incomplete projection is not a degraded one, it is `null`:
 * `faceToCocoPerson` rejects any partial set outright, so `personCount` reads
 * 0, calibration never starts, and the whole head-pose channel that R2 exists
 * to provide silently does nothing. A face fixture missing its nose therefore
 * does not test the engine "a bit less"; it tests a different engine.
 *
 * Geometry is anchored to the eye SOCKETS (fixed at x=200/300, y=100), not to
 * the irises. That is deliberate and physical: moving your eyes does not move
 * your nose. See the coupling note on `measuredHeadYawRatio` below.
 * =========================================================================== */

/** Fixed skull landmarks, in the same image-pixel space as `syntheticEye`. */
export const COCO5_LAYOUT = Object.freeze({
  /** Midpoint of the two eye sockets. The nose sits here at yaw 0. */
  socketMidX: 250,
  /** The eye line. `syntheticEye` puts every eye point at cy = 100. */
  eyeLineY: 100,
  /** Socket separation, and the unit both pose ratios are expressed in. */
  nominalInterocular: 100,
  /** Subject's LEFT tragion — image-RIGHT, outboard of the left eye. */
  leftTragionX: 360,
  /** Subject's RIGHT tragion — image-LEFT, outboard of the right eye. */
  rightTragionX: 140,
  /** COCO indices, mirroring adapters/landmark_adapter.js COCO_PROJECTION. */
  nose: 1,
  leftTragion: 454,
  rightTragion: 234,
});

/** Nose at rest sits below the eye line; `computeHeadPose` reads that as a
 *  positive pitchRatio. 0.45 is a plausible resting value and is otherwise
 *  arbitrary — nothing asserts on it, only on its stability. */
const DEFAULT_POSE = Object.freeze({ yaw: 0, pitch: 0.45 });

function putCoco5(pts, pose) {
  const L = COCO5_LAYOUT;
  const { yaw, pitch } = { ...DEFAULT_POSE, ...pose };
  pts[L.nose] = {
    x: L.socketMidX + yaw * L.nominalInterocular,
    y: L.eyeLineY + pitch * L.nominalInterocular,
  };
  // Tragions ride the eye line and do NOT move with yaw. computeHeadPose uses
  // them only for `yawAsym`, which it computes for telemetry and explicitly
  // does not gate on, so a simplified ear model cannot affect any verdict.
  pts[L.leftTragion] = { x: L.leftTragionX, y: L.eyeLineY };
  pts[L.rightTragion] = { x: L.rightTragionX, y: L.eyeLineY };
}

/**
 * The yaw ratio `computeHeadPose` will actually read back from a face built
 * with these options — which is NOT `pose.yaw`.
 *
 * ⚠ THE IRIS COUPLING, AND WHY IT IS REPRODUCED RATHER THAN CANCELLED.
 *
 * R2's down-projection uses the IRIS CENTRES (473/468) as COCO's LEFT_EYE and
 * RIGHT_EYE, because those are the only eye points the 478-set offers at that
 * position. So `eyeMid` — the origin `computeHeadPose` measures the nose
 * against — tracks the irises. A student who holds their head perfectly still
 * and moves only their eyes therefore registers a small, genuine head-yaw
 * change:
 *
 *     measured yaw = pose.yaw  -  (h - 0.5) * width / interocular
 *
 * This builder could hide that by placing the nose relative to the iris
 * midpoint instead, so the requested yaw always read back exactly. It
 * deliberately does not: the coupling is a real property of the mitigation and
 * a fixture that cancels it would let a regression through.
 *
 * ⚠ THE SYNTHETIC FACE EXAGGERATES IT. Here `hFrac` sweeps the FULL eye width
 * (0..1) against a 100 px interocular, so an extreme h=0.95 moves the measured
 * yaw by 0.18 — exactly `minYawTolerance`, i.e. one full excursion unit, enough
 * to push the head out of the neutral band and make the engine report
 * AI_CHEATING_POSE where a real side-glance would report SIDE_GAZE_PEEKING. A
 * real eye cannot do that: the iris travels roughly ±4 mm inside a ~30 mm
 * fissure against a ~63 mm interocular, so a hard 20-30° eye movement moves the
 * measured yaw by ~0.065-0.095 — around a third to a half of one excursion
 * unit, comfortably inside both the 0.75 gaze gate and the 1.0 pose threshold.
 * Tests that want an isolated gaze verdict should stay near h≈0.25/0.75.
 */
export function measuredHeadYawRatio({ h = 0.5, hLeft = null, width = 40, pose = null } = {}) {
  const yaw = { ...DEFAULT_POSE, ...(pose || {}) }.yaw;
  const hRight = hLeft === null ? h : hLeft;
  // Iris midpoint minus socket midpoint, in pixels.
  const irisShift = ((h + hRight) / 2 - 0.5) * width;
  const interocular = Math.abs((300 + (h - 0.5) * width) - (200 + (hRight - 0.5) * width));
  return (yaw * COCO5_LAYOUT.nominalInterocular - irisShift) / interocular;
}

/**
 * Pixel-space landmarks -> MediaPipe's normalised space. The exact inverse of
 * `adapters/landmark_adapter.js: toPixelLandmarks`, so a fixture built in
 * pixels round-trips back to the same pixels through the engine.
 *
 * ⚠ THIS IS REQUIRED, NOT CONVENIENT. `ProctorDemoEngine` calls
 * `toPixelLandmarks(face, w, h)` on whatever the landmark source hands it.
 * Feeding a pixel-space fixture straight into `ScriptedLandmarkSource` would
 * multiply 200 px by a 640 px frame width, and every ratio downstream would be
 * computed on a face 640 times too wide — which still produces finite, plausible
 * numbers rather than an error.
 *
 * The division is ANISOTROPIC, matching R1: x by width, y by height. Holes stay
 * holes, so the sparse fixtures survive the trip.
 */
export function toNormalizedLandmarks(pixels, frameWidth, frameHeight) {
  if (typeof frameWidth !== 'number' || typeof frameHeight !== 'number') {
    throw new TypeError('toNormalizedLandmarks(pixels, frameWidth, frameHeight): '
      + 'both dimensions are required — see PLAN.md R1.');
  }
  const out = new Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    out[i] = { x: p.x / frameWidth, y: p.y / frameHeight };
  }
  return out;
}

/**
 * The one-call fixture the engine tests use: a full COCO-5-bearing face,
 * already normalised for a given frame size.
 */
export function syntheticNormalizedFace(opts = {}, frameWidth = 640, frameHeight = 480) {
  return toNormalizedLandmarks(
    syntheticFace({ pose: {}, ...opts }),
    frameWidth,
    frameHeight,
  );
}

/**
 * `ear_veto.test.js`'s `landmarksWithEar()`. Deliberately NOT unified with
 * `syntheticFace()`: this builder sets ONLY the lid/corner points that
 * `computeFaceEar`/`eyeAspectRatio` read — no `iris` entry at all — so it
 * exercises the EAR-only gate path without ever constructing iris geometry
 * that the ear_veto suite has no use for. Averaging the two builders into one
 * "does everything" function would either add an iris to every call site that
 * doesn't want one, or silently make this one iris-capable and lose the "EAR
 * gate reads nothing else" property the upstream suite relies on.
 *
 * @param {number} leftEar
 * @param {number} [rightEar=leftEar]
 * @param {number} [width=40]
 * @returns {Array<{x:number,y:number}|undefined>}
 */
export function syntheticFaceWithEar(leftEar, rightEar = leftEar, width = 40) {
  const pts = new Array(LANDMARK_CONTRACT.pointCount);
  const put = (idx, cx, ear) => {
    const open = ear * width;
    pts[idx.upperLid] = { x: cx, y: 100 - open / 2 };
    pts[idx.lowerLid] = { x: cx, y: 100 + open / 2 };
    pts[idx.inner] = { x: cx - width / 2, y: 100 };
    pts[idx.outer] = { x: cx + width / 2, y: 100 };
  };
  put(LANDMARK_CONTRACT.right, 200, rightEar);
  put(LANDMARK_CONTRACT.left, 300, leftEar);
  return pts;
}

/**
 * `keyboard_glance.test.js`'s `sample()`. A pre-fused `analyzeGazeLandmarks()`
 * -shaped result, for tests that exercise `classifyGlance()` directly rather
 * than routing through real landmark geometry.
 *
 * @param {object} [o]
 * @returns {{valid:boolean, ear:number, hRatio:number, vRatio:number}}
 */
export function syntheticSample(o = {}) {
  return { valid: true, ear: 0.30, hRatio: 0.5, vRatio: 0.5, ...o };
}

/**
 * `keyboard_glance.test.js`'s `off()`. Builds a sample from the spec's
 * CENTRED offsets (`hOffset`/`vOffset` = ratio - 0.5) rather than raw ratios,
 * matching how `classifyGlance()`'s doc comment states the thresholds.
 *
 * @param {{h?:number, v?:number, ear?:number}} [o]
 */
export function offsetSample({ h = 0, v = 0, ear = 0.30 } = {}) {
  return syntheticSample({ hRatio: 0.5 + h, vRatio: 0.5 + v, ear });
}

/**
 * Canned `poseResult`-shaped head states, consumed by `GazeLandmarkAnalyzer
 * .process()`'s second argument. Superset of the head doubles declared
 * independently in gaze_landmarks.test.js and blink_immunity.test.js (whose
 * NEUTRAL_HEAD differed only in an immaterial yawDeg — 3 vs 2, both well
 * inside the 15 degree bound and never asserted on directly — so one shared
 * NEUTRAL head serves both without changing what either suite proves).
 */
export const HEADS = Object.freeze({
  /** Calibrated, inside both the excursion band and the absolute yaw bound. */
  NEUTRAL: Object.freeze({ calibrated: true, smoothedExcursion: 0.1, deviation: { yawDeg: 3, pitchDeg: 1 } }),
  /** Calibrated, but well outside the excursion band. */
  TURNED: Object.freeze({ calibrated: true, smoothedExcursion: 1.4, deviation: { yawDeg: 28, pitchDeg: 2 } }),
  /** Inside the calibrated excursion band, but past the absolute 15deg bound. */
  SKEWED: Object.freeze({ calibrated: true, smoothedExcursion: 0.2, deviation: { yawDeg: 22, pitchDeg: 1 } }),
  /** Calibrated, neutral excursion, but the pose pipeline could not measure yaw. */
  UNMEASURED_YAW: Object.freeze({ calibrated: true, smoothedExcursion: 0.1, deviation: null }),
  /** Just inside the exclusive 15deg yaw bound. */
  INSIDE_YAW_BOUND: Object.freeze({ calibrated: true, smoothedExcursion: 0.1, deviation: { yawDeg: 14.9, pitchDeg: 0 } }),
  /** Exactly on the 15deg yaw bound (exclusive, so this must NOT calibrate). */
  OUTSIDE_YAW_BOUND: Object.freeze({ calibrated: true, smoothedExcursion: 0.1, deviation: { yawDeg: 15.0, pitchDeg: 0 } }),
});

/**
 * Generalises the per-frame timestamp-generation loop every upstream suite
 * hand-rolled (gaze_landmarks.test.js's `run()`, keyboard_glance.test.js's
 * `runGlance()`, blink_immunity.test.js's inline `for` loops): given a
 * per-frame builder and a cadence, returns the full list of `{t, i, ...}`
 * frame descriptors up front rather than interleaving generation with
 * whatever the caller does per frame.
 *
 * This is also the shape a future `ScriptedLandmarkSource` (PLAN.md §6
 * Phase 3) replays: a fixed array of `{t, landmarks}` pairs fed through the
 * engine with no camera and no wall-clock timers, exactly like the headless
 * engine tests. Kept intentionally generic — it does not know about
 * `GazeLandmarkAnalyzer` or `EarVetoGate`, only about timestamps — so both
 * uses stay in sync automatically.
 *
 * @param {object} spec
 * @param {(i:number, t:number) => *} spec.builder - per-frame landmark/value builder.
 * @param {number} spec.count - number of frames.
 * @param {number} [spec.dtMs=100] - inter-frame interval.
 * @param {number} [spec.t0=1000] - first frame's timestamp.
 * @returns {Array<{t:number, i:number, value:*}>}
 */
export function scriptedFrames({ builder, count, dtMs = 100, t0 = 1000 }) {
  const frames = new Array(count);
  for (let i = 0; i < count; i++) {
    const t = t0 + i * dtMs;
    frames[i] = { t, i, value: builder(i, t) };
  }
  return frames;
}
