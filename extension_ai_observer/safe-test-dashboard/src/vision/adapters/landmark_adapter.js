// =============================================================================
// MediaPipe -> upstream-geometry adapters — PLAN.md §6 Phase 3, risks R1 + R2.
//
// This file is the ONLY place MediaPipe's coordinate conventions are allowed to
// exist. Everything downstream consumes the pixel-space, COCO-shaped structures
// the ported extension modules were written against, unmodified.
// =============================================================================

import { LANDMARK_CONTRACT } from '../gaze_landmarks.js';

/* ===========================================================================
 * R1 — ANISOTROPIC COORDINATES SILENTLY KILL BLINK IMMUNITY
 *
 * MediaPipe normalises x by frame WIDTH and y by frame HEIGHT independently.
 * Every upstream ratio is a ratio of DISTANCES, so feeding normalised values
 * straight in scales the vertical and horizontal legs differently:
 *
 *     EAR = dist(upperLid, lowerLid) / dist(inner, outer)
 *
 * is inflated by exactly W/H. At 640x480 that is 1.333x, so a genuinely CLOSED
 * eye at pixel-EAR 0.15 reads 0.20 and clears the `ear < 0.20` gate in
 * gaze_landmarks.js — resurrecting the precise defect this whole architecture
 * exists to prevent: closed eyes producing a confident gaze direction.
 *
 * ⚠ AND EVERY UNIT TEST STILL PASSES, because they are all written in pixel
 * space. Nothing catches this except the regression test named in Phase 4.
 *
 * The mitigation is the signature itself: frameWidth and frameHeight are
 * REQUIRED POSITIONAL ARGUMENTS WITH NO DEFAULTS. Omitting one is an immediate,
 * loud TypeError rather than a plausible-looking wrong number forever. Do not
 * add defaults. Do not make them optional. Do not "helpfully" fall back to 1.
 * =========================================================================== */

/**
 * Convert MediaPipe's normalised landmarks into image-pixel space.
 *
 * @param {Array<{x:number,y:number,z:number}>|null|undefined} normalized
 * @param {number} frameWidth   REQUIRED. video.videoWidth. No default — see R1.
 * @param {number} frameHeight  REQUIRED. video.videoHeight. No default — see R1.
 * @returns {Array<{x:number,y:number}>|null} null when unreadable.
 */
export function toPixelLandmarks(normalized, frameWidth, frameHeight) {
  // Explicit arity check FIRST. `undefined * 0.5` is NaN, which would poison
  // every ratio downstream into UNKNOWN rather than announcing the mistake —
  // quiet degradation of exactly the kind this codebase refuses.
  if (typeof frameWidth !== 'number' || typeof frameHeight !== 'number') {
    throw new TypeError(
      'toPixelLandmarks(normalized, frameWidth, frameHeight): frameWidth and ' +
      'frameHeight are required numbers. Passing normalised coordinates through ' +
      'unscaled inflates EAR by W/H and defeats blink immunity (PLAN.md R1).'
    );
  }

  if (!Array.isArray(normalized)) return null;
  // A short set is a different model (468-point, no iris refinement), not a bad
  // frame. Guessing which points are missing is exactly the "synthesise the
  // landmarks" failure CLAUDE.md forbids by name.
  if (normalized.length < LANDMARK_CONTRACT.pointCount) return null;
  // A video that reports 0x0 has not produced a frame yet. Scaling by zero
  // collapses every point onto the origin, which reads as a perfectly closed
  // eye staring dead ahead — a fabricated reading, not a missing one.
  if (!(frameWidth > 0) || !(frameHeight > 0)) return null;

  const out = new Array(normalized.length);
  for (let i = 0; i < normalized.length; i++) {
    const p = normalized[i];
    // ⚠ A MISSING POINT IS PRESERVED AS null — it does NOT void the whole set.
    // An earlier draft returned null for the entire frame on any hole, which is
    // wrong twice over: MediaPipe always fills all 478 so it never fires in
    // production, while every synthetic fixture is deliberately sparse (only
    // the LANDMARK_CONTRACT indices are populated), so it silently made the
    // headless seam untestable. Per-point absence is already handled downstream
    // — gaze_landmarks' pick() and faceToCocoPerson's at() each guard their own
    // indices — and that is the right altitude for the decision: a point nobody
    // reads should not invalidate a frame.
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) { out[i] = null; continue; }
    out[i] = { x: p.x * frameWidth, y: p.y * frameHeight };
    // ⚠ `score` IS DELIBERATELY OMITTED. gaze_landmarks.js's pick() rejects a
    // point only when `typeof p.score === 'number'` and it is below threshold.
    // FaceLandmarker reports visibility as a constant 0, so wiring it through
    // would reject all 478 points on every frame and the engine would report
    // "no face" against a perfectly good one. Absent means "not measured",
    // which is the honest answer here. Do not "improve" this.
  }
  return out;
}

/* ===========================================================================
 * R2 — THE HEAD-POSE CHANNEL MUST BE REAL
 *
 * GazeLandmarkAnalyzer.process() returns HEAD_OFF_NEUTRAL forever unless it is
 * handed a poseResult that is calibrated, inside its excursion band, and
 * carries a finite yaw. The three tempting shortcuts are all defective:
 *
 *   - Hard-coding {calibrated:true, yawDeg:0} disables the head gate outright,
 *     letting the demo report side-gaze on a turned head — which the real
 *     system explicitly refuses to do.
 *   - MediaPipe's facialTransformationMatrixes yaw is ABSOLUTE, while the
 *     15-degree bound is documented as deviation from the student's OWN
 *     calibrated neutral. Substituting it silently redefines the threshold and
 *     penalises anyone whose camera sits off to one side.
 *   - Synthesising the signal is forbidden by name in CLAUDE.md.
 *
 * So we run the REAL HeadPoseAnalyzer, fed a COCO-5 down-projection of the
 * mesh. This is PROJECTION, NOT FABRICATION: all five points genuinely exist
 * in the 478-set and are simply being re-labelled into the layout
 * pose_geometry.js expects.
 * =========================================================================== */

/**
 * COCO-17 indices consumed by computeHeadPose, and the FaceMesh point each is
 * projected from. "left"/"right" are the SUBJECT'S own sides, matching the
 * convention pose_geometry.js and gaze_landmarks.js already share.
 */
export const COCO_PROJECTION = Object.freeze({
  NOSE: 1,          // nose tip
  LEFT_EYE: 473,    // left iris centre  (LANDMARK_CONTRACT.left.iris)
  RIGHT_EYE: 468,   // right iris centre (LANDMARK_CONTRACT.right.iris)
  LEFT_EAR: 454,    // left tragion
  RIGHT_EAR: 234,   // right tragion
});

/** Minimum person score. HeadPoseAnalyzer drops anything below its own
 *  `minPersonScore`; a detected mesh is a detected face, so 1 is honest. */
const PROJECTED_PERSON_SCORE = 1;

/**
 * Project a 478-point pixel-space mesh into the COCO-5 person shape
 * HeadPoseAnalyzer.process() consumes.
 *
 * @param {Array<{x:number,y:number}>|null} pixels output of toPixelLandmarks
 * @returns {{score:number, keypoints:Array}|null}
 */
export function faceToCocoPerson(pixels) {
  if (!Array.isArray(pixels) || pixels.length < LANDMARK_CONTRACT.pointCount) {
    return null;
  }

  const at = (idx) => {
    const p = pixels[idx];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    // ⚠ `score: 1` IS REQUIRED on each keypoint, and for the opposite reason
    // to toPixelLandmarks' omission. computeHeadPose reads `.score`
    // UNCONDITIONALLY; `undefined < 0.40` is false but every arithmetic use
    // yields NaN, so the pose resolves to LOW_CONFIDENCE on every single frame
    // and the student never calibrates.
    return { x: p.x, y: p.y, score: 1 };
  };

  const keypoints = [
    at(COCO_PROJECTION.NOSE),
    at(COCO_PROJECTION.LEFT_EYE),
    at(COCO_PROJECTION.RIGHT_EYE),
    at(COCO_PROJECTION.LEFT_EAR),
    at(COCO_PROJECTION.RIGHT_EAR),
  ];

  // Partial projection is an unreadable observation, not a low-quality one.
  // Emitting a person with holes would let computeHeadPose derive a confident
  // angle from points that are not there.
  if (keypoints.some((k) => k === null)) return null;

  // ⚠ THE PERSON-LEVEL SCORE. Found by running the ported engine, not by
  // reading it: HeadPoseAnalyzer.process() filters
  //     persons.filter((p) => p && p.score >= this.opt.minPersonScore)
  // (pose_pipeline.js:153) BEFORE computeHeadPose ever inspects a keypoint.
  // A person object carrying only per-keypoint scores is silently dropped —
  // personCount reads 0, calibration never starts, and the symptom presents as
  // "R2's mitigation does not work" rather than as a missing field.
  return { score: PROJECTED_PERSON_SCORE, keypoints };
}

/**
 * Convenience: normalised MediaPipe face -> COCO person, in one step.
 * Same required-arity contract as toPixelLandmarks.
 */
export function faceToCocoPersonFromNormalized(normalized, frameWidth, frameHeight) {
  return faceToCocoPerson(toPixelLandmarks(normalized, frameWidth, frameHeight));
}
