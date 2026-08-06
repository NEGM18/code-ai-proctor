// =============================================================================
// Head Pose Baseline Calibration — AI Observer Extension
//
// Turns absolute pose ratios into deviations from THIS student's own neutral.
//
// This is the layer that fixes "I look straight at the camera and get flagged".
// A fixed absolute threshold cannot work: a student sitting slightly below their
// webcam, or with a laptop on a stand, has a permanently different apparent
// pitch than one sitting level with it. Judged against a global constant, one of
// them is always "looking away" while doing nothing wrong. Judged against their
// own measured neutral, both read as centred.
//
// Two further properties matter as much as the re-centring itself:
//
//   1. ROBUST STATISTICS. The neutral is the MEDIAN of the calibration window,
//      not the mean. A student who glances at the door during calibration would
//      drag a mean into a bogus neutral and mis-centre the whole session; the
//      median absorbs it.
//
//   2. PER-STUDENT TOLERANCE. The width of the "normal" band is derived from the
//      student's own measured jitter (median absolute deviation) during
//      calibration, floored at a minimum. A student who naturally fidgets gets a
//      proportionally wider band instead of a stream of false positives, while a
//      very still student does not get an artificially generous one.
// =============================================================================

const DEFAULT_CALIBRATION_OPTS = {
  // Calibration completes only when BOTH are satisfied, so it behaves the same
  // at 1 FPS and at 15 FPS. Frame counts alone would make calibration 30x
  // longer on a slow device.
  calibrationMs: 4000,
  minSamples: 12,
  // Hard ceiling: if we somehow cannot collect minSamples (face repeatedly
  // undetected), stop waiting and calibrate on what we have rather than never
  // arming the detector at all.
  maxCalibrationMs: 20000,
  absoluteMinSamples: 5,

  // Tolerance = clamp(toleranceK * MAD, minTolerance, maxTolerance).
  toleranceK: 3.5,
  minYawTolerance: 0.18,   // ratio units; ~11 deg at RATIO_TO_DEG=60
  minPitchTolerance: 0.18,
  minRollTolerance: 8.0,   // degrees — roll is a true angle already
  maxYawTolerance: 0.60,
  maxPitchTolerance: 0.60,
  maxRollTolerance: 25.0,

  // Slow neutral drift, for students who settle into a new resting posture over
  // a long exam. Deliberately tiny: at alpha=0.01 the baseline needs ~100
  // consecutive near-neutral samples to move meaningfully, so it tracks posture
  // but cannot be walked to a cheating pose.
  driftAlpha: 0.01,
  // Drift only applies well inside the tolerance band. Adapting on samples near
  // the edge would let a student slowly drag their own neutral toward a phone
  // on the desk.
  driftGate: 0.5,
};

/** Median of a numeric array. Returns NaN for an empty array. */
function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation about a given centre. */
function medianAbsoluteDeviation(values, centre) {
  if (!values.length) return NaN;
  return median(values.map((v) => Math.abs(v - centre)));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @typedef {object} PoseDeviation
 * @property {boolean} calibrated
 * @property {number} yawDev      Signed deviation from neutral, ratio units.
 * @property {number} pitchDev
 * @property {number} rollDev     Signed deviation, degrees.
 * @property {number} yawDeg      Approximate degrees, for display only.
 * @property {number} pitchDeg
 * @property {number} excursion   max(|dev| / tolerance) per axis. >1 is outside the band.
 * @property {string} axis        Dominant axis: 'yaw' | 'pitch' | 'roll' | 'none'.
 * @property {string} direction   Human-readable, e.g. 'left', 'down'.
 */

class PoseBaseline {
  /**
   * @param {object} [options] - Overrides for DEFAULT_CALIBRATION_OPTS.
   * @param {Function} [toDegrees] - Ratio->degrees converter for display.
   */
  constructor(options = {}, toDegrees = null) {
    this.opt = { ...DEFAULT_CALIBRATION_OPTS, ...options };
    this._toDegrees = toDegrees || ((r) => r * 60);
    this.reset();
  }

  /** Discard the baseline and restart calibration from scratch. */
  reset() {
    this._samples = { yaw: [], pitch: [], roll: [] };
    this._startedAt = null;
    this._calibrated = false;
    this.neutral = { yaw: 0, pitch: 0, roll: 0 };
    this.tolerance = {
      yaw: this.opt.minYawTolerance,
      pitch: this.opt.minPitchTolerance,
      roll: this.opt.minRollTolerance,
    };
    this.sampleCount = 0;
  }

  /** @returns {boolean} True once a usable neutral has been established. */
  isCalibrated() {
    return this._calibrated;
  }

  /** @returns {number} Calibration progress in [0,1] for UI. */
  progress() {
    if (this._calibrated) return 1;
    if (this._startedAt === null) return 0;
    const byCount = this._samples.yaw.length / this.opt.minSamples;
    return clamp(Math.min(byCount, 1), 0, 1);
  }

  /**
   * Feed one VALID pose sample.
   *
   * During calibration the sample is banked. Once calibrated it is used only for
   * slow neutral drift, and only when the caller permits it.
   *
   * @param {{yawRatio:number, pitchRatio:number, rollDeg:number}} pose
   * @param {number} nowMs - Timestamp; pass performance.now() or Date.now() consistently.
   * @param {boolean} [allowDrift=true] - False while an alert is active, so a
   *   genuine sustained look-away can never be absorbed into the neutral.
   * @returns {boolean} True if calibration completed on this call.
   */
  addSample(pose, nowMs, allowDrift = true) {
    if (this._startedAt === null) this._startedAt = nowMs;

    if (!this._calibrated) {
      this._samples.yaw.push(pose.yawRatio);
      this._samples.pitch.push(pose.pitchRatio);
      this._samples.roll.push(pose.rollDeg);
      this.sampleCount = this._samples.yaw.length;

      const elapsed = nowMs - this._startedAt;
      const enough = this._samples.yaw.length >= this.opt.minSamples && elapsed >= this.opt.calibrationMs;
      const timedOut = elapsed >= this.opt.maxCalibrationMs
        && this._samples.yaw.length >= this.opt.absoluteMinSamples;

      if (enough || timedOut) {
        this._finalise();
        return true;
      }
      return false;
    }

    if (allowDrift) this._maybeDrift(pose);
    return false;
  }

  /** Compute neutral and per-axis tolerance from the banked samples. */
  _finalise() {
    const yawC = median(this._samples.yaw);
    const pitchC = median(this._samples.pitch);
    const rollC = median(this._samples.roll);

    this.neutral = { yaw: yawC, pitch: pitchC, roll: rollC };

    const k = this.opt.toleranceK;
    this.tolerance = {
      yaw: clamp(k * medianAbsoluteDeviation(this._samples.yaw, yawC),
        this.opt.minYawTolerance, this.opt.maxYawTolerance),
      pitch: clamp(k * medianAbsoluteDeviation(this._samples.pitch, pitchC),
        this.opt.minPitchTolerance, this.opt.maxPitchTolerance),
      roll: clamp(k * medianAbsoluteDeviation(this._samples.roll, rollC),
        this.opt.minRollTolerance, this.opt.maxRollTolerance),
    };

    this._calibrated = true;
    this._samples = { yaw: [], pitch: [], roll: [] }; // release memory
  }

  /** Nudge the neutral toward a sample that is comfortably inside the band. */
  _maybeDrift(pose) {
    const dev = this.deviation(pose);
    if (dev.excursion >= this.opt.driftGate) return;

    const a = this.opt.driftAlpha;
    this.neutral.yaw += a * (pose.yawRatio - this.neutral.yaw);
    this.neutral.pitch += a * (pose.pitchRatio - this.neutral.pitch);
    this.neutral.roll += a * (pose.rollDeg - this.neutral.roll);
  }

  /**
   * Deviation of a pose from the calibrated neutral.
   *
   * `excursion` is the key output: each axis is divided by ITS OWN tolerance, so
   * the axes are directly comparable despite different units and different
   * natural jitter, and the temporal gate downstream needs only one scalar.
   * excursion > 1 means "outside this student's normal band".
   *
   * @param {{yawRatio:number, pitchRatio:number, rollDeg:number}} pose
   * @returns {PoseDeviation}
   */
  deviation(pose) {
    if (!this._calibrated) {
      return {
        calibrated: false,
        yawDev: 0, pitchDev: 0, rollDev: 0,
        yawDeg: 0, pitchDeg: 0,
        excursion: 0, axis: 'none', direction: 'centre',
      };
    }

    const yawDev = pose.yawRatio - this.neutral.yaw;
    const pitchDev = pose.pitchRatio - this.neutral.pitch;
    const rollDev = pose.rollDeg - this.neutral.roll;

    const yawEx = Math.abs(yawDev) / this.tolerance.yaw;
    const pitchEx = Math.abs(pitchDev) / this.tolerance.pitch;
    const rollEx = Math.abs(rollDev) / this.tolerance.roll;

    let axis = 'yaw';
    let excursion = yawEx;
    if (pitchEx > excursion) { axis = 'pitch'; excursion = pitchEx; }
    if (rollEx > excursion) { axis = 'roll'; excursion = rollEx; }
    if (excursion < 1) axis = excursion === 0 ? 'none' : axis;

    let direction = 'centre';
    if (axis === 'yaw') direction = yawDev > 0 ? 'right' : 'left';
    else if (axis === 'pitch') direction = pitchDev < 0 ? 'down' : 'up';
    else if (axis === 'roll') direction = rollDev > 0 ? 'tilt-right' : 'tilt-left';

    return {
      calibrated: true,
      yawDev,
      pitchDev,
      rollDev,
      yawDeg: this._toDegrees(yawDev),
      pitchDeg: this._toDegrees(pitchDev),
      excursion,
      axis,
      direction,
    };
  }

  /** Serialisable snapshot for telemetry and debugging. */
  snapshot() {
    return {
      calibrated: this._calibrated,
      neutral: { ...this.neutral },
      tolerance: { ...this.tolerance },
      samples: this.sampleCount,
    };
  }
}

// ---------------------------------------------------------------------------
const __poseCalibrationExports = {
  DEFAULT_CALIBRATION_OPTS,
  PoseBaseline,
  median,
  medianAbsoluteDeviation,
};

if (typeof module !== 'undefined' && module.exports) module.exports = __poseCalibrationExports;
if (typeof window !== 'undefined') Object.assign(window, __poseCalibrationExports);
