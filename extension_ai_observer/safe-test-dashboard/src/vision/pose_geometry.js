// =============================================================================
// Head Pose Geometry — AI Observer Extension
//
// Converts COCO-format body keypoints (from yolo11n-pose) into scale-invariant
// head orientation signals.
//
// DESIGN NOTE — why ratios and not degrees:
// This module deliberately emits raw, UNCALIBRATED ratios. Absolute head-pose
// degrees from 5 coarse facial keypoints are not trustworthy: they vary with
// camera lens, camera height, seating position and individual facial geometry.
// Two students both facing their screen honestly can differ by 15+ degrees of
// apparent absolute pitch, which is exactly how "looking straight at the camera"
// ends up flagged.
//
// The fix is not better absolute math — it is to never use absolute angles for
// decisions. pose_calibration.js converts these ratios into deviations from the
// individual student's own measured neutral, and only those deviations drive
// alerts. What this module must therefore guarantee is that the signals are:
//   1. MONOTONIC in the underlying rotation,
//   2. SCALE-INVARIANT (independent of distance from the camera), and
//   3. STABLE frame to frame.
// Absolute accuracy is explicitly a non-goal.
// =============================================================================

/** COCO-17 keypoint indices as emitted by Ultralytics pose models. */
const KP = {
  NOSE: 0,
  LEFT_EYE: 1,
  RIGHT_EYE: 2,
  LEFT_EAR: 3,
  RIGHT_EAR: 4,
  LEFT_SHOULDER: 5,
  RIGHT_SHOULDER: 6,
};

/** Reasons a frame can be rejected. Surfaced in telemetry to explain gaps. */
const POSE_INVALID = {
  NO_KEYPOINTS: 'no_keypoints',
  LOW_CONFIDENCE: 'low_confidence',
  FACE_TOO_SMALL: 'face_too_small',
  DEGENERATE: 'degenerate_geometry',
};

const DEFAULT_POSE_OPTS = {
  // Minimum per-keypoint score for nose and both eyes. Below this the geometry
  // is guesswork and the sample is dropped rather than fed to the buffer —
  // feeding low-confidence keypoints is a direct false-positive source.
  minKeypointScore: 0.40,
  // Minimum eye-to-eye pixel distance. A face this small carries too few pixels
  // for the nose offset to mean anything.
  minInterocularPx: 12,
  // Score at or above which the ear-asymmetry cue is considered usable.
  minEarScore: 0.40,
};

/** Euclidean distance between two {x,y} points. */
function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Midpoint of two {x,y} points. */
function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Compute scale-invariant head orientation signals from COCO keypoints.
 *
 * Normalisation is by INTEROCULAR distance (eye-to-eye), chosen because it is
 * the only reference always present whenever a face is detected at all. Using
 * shoulder width would be more invariant to head yaw, but shoulders leave frame
 * in a tight headshot, and silently switching the scale basis mid-session
 * introduces step discontinuities that read exactly like a real head movement.
 * One always-available basis beats a more precise one that changes underfoot.
 *
 * Known and intentional consequence: interocular distance shrinks as |yaw|
 * grows, so yawRatio is super-linear in yaw. That is desirable here — large
 * turns become MORE separable from the neutral band, not less.
 *
 * @param {Array<{x:number,y:number,score:number}>|null} kps - 17 COCO keypoints in pixels.
 * @param {object} [options] - Overrides for DEFAULT_POSE_OPTS.
 * @returns {{
 *   valid: boolean, reason: string|null,
 *   yawRatio: number, pitchRatio: number, rollDeg: number,
 *   yawAsym: number|null, interocular: number, quality: number
 * }}
 */
function computeHeadPose(kps, options = {}) {
  const opt = { ...DEFAULT_POSE_OPTS, ...options };

  const invalid = (reason) => ({
    valid: false,
    reason,
    yawRatio: 0,
    pitchRatio: 0,
    rollDeg: 0,
    yawAsym: null,
    interocular: 0,
    quality: 0,
  });

  if (!kps || kps.length < 5) return invalid(POSE_INVALID.NO_KEYPOINTS);

  const nose = kps[KP.NOSE];
  const leftEye = kps[KP.LEFT_EYE];
  const rightEye = kps[KP.RIGHT_EYE];
  if (!nose || !leftEye || !rightEye) return invalid(POSE_INVALID.NO_KEYPOINTS);

  const quality = Math.min(nose.score, leftEye.score, rightEye.score);
  if (quality < opt.minKeypointScore) return invalid(POSE_INVALID.LOW_CONFIDENCE);

  const interocular = dist(leftEye, rightEye);
  if (!Number.isFinite(interocular) || interocular <= 0) {
    return invalid(POSE_INVALID.DEGENERATE);
  }
  if (interocular < opt.minInterocularPx) return invalid(POSE_INVALID.FACE_TOO_SMALL);

  const eyeMid = midpoint(leftEye, rightEye);

  // YAW: horizontal displacement of the nose from the eye midpoint. Zero when
  // facing the camera squarely; signed by turn direction.
  //
  // The sign is IMAGE-relative, not subject-relative: positive means the nose
  // moved toward the right of the frame. That is the deliberate choice, because
  // the consumer is a teacher looking at a snapshot — "turned toward the right
  // of the image" matches what they see. It is the subject's own left.
  const yawRatio = (nose.x - eyeMid.x) / interocular;

  // PITCH: vertical displacement of the nose below the eye line. In image
  // coordinates y grows downward, so this is positive at rest (nose below eyes)
  // and DECREASES as the head tilts down, because the nose foreshortens toward
  // the eye line. Monotonic, which is all the calibration layer requires.
  const pitchRatio = (nose.y - eyeMid.y) / interocular;

  // ROLL: tilt of the inter-eye line. A genuine angle, needing no calibration to
  // be meaningful, though it is still reported as a deviation for consistency.
  //
  // ORIENTATION: COCO "left"/"right" are the SUBJECT'S left and right, so in an
  // unmirrored webcam image LEFT_EYE sits at the LARGER x. The vector therefore
  // runs right_eye -> left_eye to come out near 0 for a level head; taking it
  // the other way round yields ~180 deg for a level head and makes the roll
  // deviation wrap across the +/-180 discontinuity.
  const rollDeg = Math.atan2(leftEye.y - rightEye.y, leftEye.x - rightEye.x) * (180 / Math.PI);

  // Auxiliary yaw cue: ear asymmetry. Inherently normalised (a ratio of
  // distances) and robust at large turn angles where one ear occludes.
  //
  // Reported for telemetry and offline threshold tuning ONLY — it is not used
  // for gating. Ears drop below the confidence floor intermittently, and mixing
  // two cues whose availability differs frame to frame reintroduces exactly the
  // discontinuity problem the single-basis choice above avoids.
  let yawAsym = null;
  const leftEar = kps[KP.LEFT_EAR];
  const rightEar = kps[KP.RIGHT_EAR];
  if (leftEar && rightEar && leftEar.score >= opt.minEarScore && rightEar.score >= opt.minEarScore) {
    const dL = dist(nose, leftEar);
    const dR = dist(nose, rightEar);
    const denom = dL + dR;
    if (denom > 1e-6) yawAsym = (dL - dR) / denom;
  }

  return {
    valid: true,
    reason: null,
    yawRatio,
    pitchRatio,
    rollDeg,
    yawAsym,
    interocular,
    quality,
  };
}

/**
 * Approximate a ratio deviation as degrees, for human-readable reporting.
 *
 * These constants are empirical and deliberately coarse. They exist so teacher-
 * facing output can say "~25 deg right" instead of "0.42". NOTHING in the
 * detection path consumes them — all gating runs on the raw ratio deviation, so
 * an inaccurate constant here can never cause a false positive.
 *
 * @param {number} ratioDeviation - Deviation from the calibrated neutral.
 * @returns {number} Approximate degrees, clamped to +/-90.
 */
const RATIO_TO_DEG = 60;
function ratioToApproxDegrees(ratioDeviation) {
  const deg = ratioDeviation * RATIO_TO_DEG;
  return Math.max(-90, Math.min(90, deg));
}

// ---------------------------------------------------------------------------
// Exports — browser globals in the extension, CommonJS under the Node tests.
// ---------------------------------------------------------------------------
// >>> ESM PORT
/* eslint-disable no-unused-vars -- `__poseGeometryExports` below is retained byte-identical
   from upstream so scripts/check-vision-sync.mjs can prove the port. The real ESM
   export follows it, naming the same identifiers in the same order. */
// <<< ESM PORT
const __poseGeometryExports = {
  KP,
  POSE_INVALID,
  DEFAULT_POSE_OPTS,
  RATIO_TO_DEG,
  dist,
  midpoint,
  computeHeadPose,
  ratioToApproxDegrees,
};

// >>> ESM PORT
/* eslint-enable no-unused-vars */

// Upstream lines 207-208 were two `if (typeof module|window …)` lines that
// published the object above as a CommonJS export / a set of browser globals. Both are
// dropped; these named ESM exports replace them. Same identifiers, same order.
export {
  KP,
  POSE_INVALID,
  DEFAULT_POSE_OPTS,
  RATIO_TO_DEG,
  dist,
  midpoint,
  computeHeadPose,
  ratioToApproxDegrees,
};
// <<< ESM PORT
