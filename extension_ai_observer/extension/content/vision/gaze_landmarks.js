// =============================================================================
// Facial Landmark Geometry & EAR Gatekeeper Engine — AI Observer Extension
//
// Replaces the pixel-intensity approach in gaze_roi.js, which failed in testing
// on lighting, skin tone and eyelash-shadow variance. Every quantity here is a
// RATIO OF DISTANCES between landmark coordinates, and a ratio of distances is
// invariant to illumination and pigmentation by construction — the failure mode
// it replaces cannot occur in this formulation. No getImageData, no contrast,
// no brightness percentiles, no canvas.
//
// -----------------------------------------------------------------------------
// ⚠ REQUIRES A FACE-LANDMARK MODEL THAT IS NOT YET IN THE PIPELINE
//
// pose.onnx is yolo11n-pose and emits COCO-17 BODY keypoints. Its only face
// points are NOSE, LEFT_EYE, RIGHT_EYE, LEFT_EAR, RIGHT_EAR — ONE point per eye.
// There is no eyelid contour, no eye corner and no iris, so EAR = V/H is not
// computable from it. This module therefore consumes a 478-point MediaPipe
// FaceMesh-with-iris landmark set, and is INERT until that model is wired in
// (see LANDMARK_CONTRACT below and CLAUDE.md §7).
//
// Do NOT "adapt" this to COCO-17 by synthesising eyelids from the eye centre.
// A fabricated landmark produces a confident, principled-looking number with no
// information in it, which is strictly worse than the pixel method it replaces.
// -----------------------------------------------------------------------------
//
// ⚠ ABSOLUTE BLINK IMMUNITY is the governing property. The EAR gate runs FIRST,
// before any gaze math exists to be misread, and a closed eye returns
// { valid: false, gaze: 'UNKNOWN', reason: 'EYE_CLOSED' }. Downstream, an
// invalid frame is UNKNOWN — never deviant, never compliant — and DwellGate
// requires sustained TRUE to fire, so no run of closed-eye frames can ever
// accumulate into an alert. This is the structural fix for the trained
// classifier's original defect of flagging closed eyes as cheating.
// =============================================================================

/* global PoseBaseline, TemporalSmoother, DwellGate, GateState */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./pose_calibration.js'),
      require('./temporal_gate.js')
    );
  } else {
    root.__gazeLandmarks = factory(root, root);
    Object.assign(root, root.__gazeLandmarks);
  }
}(typeof self !== 'undefined' ? self : this, function (calibration, temporal) {

  const { PoseBaseline } = calibration;
  const { TemporalSmoother, DwellGate, GateState } = temporal;

  /**
   * Landmark indices, MediaPipe FaceMesh with `refine_landmarks` (478 points).
   *
   * "left"/"right" are the SUBJECT'S own sides, matching the COCO convention
   * pose_geometry.js already uses. In an UNMIRRORED getUserMedia frame the
   * subject's LEFT eye sits at the LARGER x.
   *
   * INNER = nasal (toward the nose). OUTER = temporal (toward the ear). Note
   * these are on OPPOSITE image sides for the two eyes — the single most
   * dangerous fact in this file. See orientedGazeRatio().
   */
  const LANDMARK_CONTRACT = {
    pointCount: 478,
    left: { upperLid: 386, lowerLid: 374, inner: 362, outer: 263, iris: 473 },
    right: { upperLid: 159, lowerLid: 145, inner: 133, outer: 33, iris: 468 },
  };

  const GAZE_STATE = {
    UNKNOWN: 'UNKNOWN',
    CENTRE: 'CENTRE',
    LEFT: 'LEFT',
    RIGHT: 'RIGHT',
    DOWN: 'DOWN',
  };

  const GAZE_INVALID = {
    NO_LANDMARKS: 'NO_LANDMARKS',
    EYE_CLOSED: 'EYE_CLOSED',
    DEGENERATE: 'DEGENERATE_GEOMETRY',
    HEAD_OFF_NEUTRAL: 'HEAD_OFF_NEUTRAL',
    NOT_SAMPLED: 'NOT_SAMPLED',
  };

  const DEFAULT_LANDMARK_OPTS = {
    // ⚠ THE BLINK GATE. Below this the eye is closed, blinking or squinting and
    // the frame yields NOTHING. Raising it costs coverage; lowering it lets a
    // half-shut eye produce an iris position that is mostly eyelid geometry.
    // Pinned by test.
    earThreshold: 0.20,

    // Horizontal neutral band, image-relative (0 = image-left corner of the
    // eye, 1 = image-right corner). Per spec.
    neutralMin: 0.35,
    neutralMax: 0.65,
    offScreenLeft: 0.25,
    offScreenRight: 0.75,

    // Vertical: 0 = upper lid, 1 = lower lid. The iris sits slightly above
    // centre at rest because the upper lid overlaps the top of the iris, so the
    // downward threshold is NOT symmetric about 0.5.
    downThreshold: 0.62,

    // Landmark confidence floor, when the model supplies per-point scores.
    minLandmarkScore: 0.30,

    // Gaze runs only well INSIDE the head's calibrated neutral band. Below the
    // pose pipeline's own excursionThreshold of 1.0. Off-neutral frames belong
    // to AI_CHEATING_POSE, and head rotation also shifts apparent iris position
    // — this module has no rotation compensation by design.
    maxHeadExcursion: 0.75,

    /**
     * Absolute head-yaw bound, in degrees, as specified.
     *
     * ⚠ These are degrees of DEVIATION FROM THE STUDENT'S OWN CALIBRATED
     * NEUTRAL (`poseResult.deviation.yawDeg`), not an absolute pose angle —
     * the same quantity liveness_challenge.js verifies corners against.
     * Absolute angles derived from 5 keypoints are untrustworthy by design; see
     * the header of pose_geometry.js. Requiring "within 15 degrees of where
     * this student normally sits" is meaningful; "within 15 degrees of the
     * optical axis" would penalise anyone whose camera is off to one side.
     */
    maxHeadYawDeg: 15,
  };

  /**
   * Calibration for the gaze baseline. Units are centred ratios in [-0.5, 0.5].
   *
   * Vertical tolerance is deliberately WIDER: the upper lid occludes the top of
   * the iris by an amount that varies with expression, so the vertical ratio
   * carries a wandering bias the horizontal one does not.
   */
  const DEFAULT_LANDMARK_CALIBRATION = {
    calibrationMs: 5000,
    minSamples: 15,
    toleranceK: 3.5,
    minYawTolerance: 0.10,
    maxYawTolerance: 0.30,
    minPitchTolerance: 0.14,
    maxPitchTolerance: 0.40,
    minRollTolerance: 1,   // unused; rollDeg is always 0 here
    maxRollTolerance: 1,
  };

  /** Spec: continuous 1.5–3.0 s off-axis gaze before anything is reported. */
  const DEFAULT_LANDMARK_GATE = {
    glanceMs: 1500,
    alertMs: 3000,
    graceMs: 500,
    minRealertMs: 20000,
  };

  const GazeCondition = { SIDE_GAZE_PEEKING: 'SIDE_GAZE_PEEKING' };

  // ---------------------------------------------------------------------------
  // Pure geometry. Distances and projections only.
  // ---------------------------------------------------------------------------

  /** Euclidean distance between two {x,y} points. */
  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Position of P along the segment A->B, as a fraction in [0,1].
   *
   * ⚠ A PROJECTION, not the spec's literal Distance(P,A)/Distance(B,A).
   *
   * A raw distance ratio is UNSIGNED: an iris sitting 3px above the corner axis
   * inflates the numerator identically whether it drifted nasally or
   * temporally, and an iris beyond A reads as positive travel toward B. The
   * projection answers the question the ratio was meant to ask — "how far along
   * the eye's own axis does the iris sit" — and it stays correct under head
   * roll, because it measures along the actual corner-to-corner vector rather
   * than assuming that vector is horizontal.
   *
   * Same cost: one dot product. Still pure distance math, still zero-allocation.
   */
  function projectionRatio(p, a, b) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    if (len2 <= 1e-9) return NaN;
    return ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  }

  /**
   * Eye Aspect Ratio for one eye.
   *
   * EAR = V / H, where V is the eyelid opening and H the corner-to-corner
   * width. Both scale with face size, so the ratio is distance-invariant —
   * a student leaning back does not read as blinking.
   *
   * NOTE: this is the 2-point form the spec calls for, not the 6-point
   * Soukupová–Čech form (which averages two vertical pairs and halves). The
   * two produce similar magnitudes, so the 0.20 threshold is meaningful here,
   * but do not import a threshold from 6-point literature without rescaling.
   *
   * @param {{x,y}} upperLid @param {{x,y}} lowerLid
   * @param {{x,y}} inner @param {{x,y}} outer
   * @returns {number} EAR, or NaN if the eye is degenerate.
   */
  function eyeAspectRatio(upperLid, lowerLid, inner, outer) {
    const h = dist(inner, outer);
    if (!(h > 1e-6)) return NaN;
    return dist(upperLid, lowerLid) / h;
  }

  /**
   * Horizontal iris position for one eye, normalised to IMAGE orientation.
   *
   * ⚠ THE SIGN TRAP THIS FUNCTION EXISTS TO CLOSE.
   *
   * "Inner" is nasal and "outer" temporal, so for the two eyes they sit on
   * OPPOSITE sides of the image. Measuring both from `inner` — as the spec's
   * formula literally reads — makes the ratio increase toward the image-LEFT
   * for one eye and toward the image-RIGHT for the other. Averaging the two
   * then cancels a real side-glance to almost exactly the neutral value, and
   * the detector silently reports CENTRE while the student stares at their
   * notes.
   *
   * Both eyes are therefore anchored at whichever corner has the SMALLER x, so
   * 0 = image-left edge of the eye and 1 = image-right edge for both. The flip
   * is resolved here, once, from the data itself — never by hard-coding which
   * eye needs inverting, which breaks the moment a deployment mirrors the feed.
   *
   * @returns {number} 0..1 along the eye's own axis, image-left to image-right.
   */
  function orientedGazeRatio(iris, inner, outer) {
    const leftmost = inner.x <= outer.x ? inner : outer;
    const rightmost = inner.x <= outer.x ? outer : inner;
    return projectionRatio(iris, leftmost, rightmost);
  }

  /**
   * Vertical iris position for one eye: 0 = upper lid, 1 = lower lid.
   * Needs no orientation fix — both eyes share the same vertical convention.
   */
  function verticalIrisRatio(iris, upperLid, lowerLid) {
    return projectionRatio(iris, upperLid, lowerLid);
  }

  /** Pull a landmark, rejecting low-confidence points when scores are present. */
  function pick(landmarks, index, minScore) {
    const p = landmarks[index];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    if (typeof p.score === 'number' && p.score < minScore) return null;
    return p;
  }

  /**
   * Analyse ONE eye: EAR gate first, then position.
   *
   * @param {Array<{x,y,score?}>} landmarks - 478-point FaceMesh set.
   * @param {{upperLid,lowerLid,inner,outer,iris}} idx - Index map for this eye.
   * @param {object} [options]
   * @returns {{valid:boolean, reason:string|null, ear:number,
   *            hRatio:number, vRatio:number}}
   */
  function analyzeEye(landmarks, idx, options = {}) {
    const opt = { ...DEFAULT_LANDMARK_OPTS, ...options };
    const bad = (reason, ear = 0) => ({
      valid: false, reason, ear, hRatio: NaN, vRatio: NaN,
    });

    if (!landmarks || !landmarks.length) return bad(GAZE_INVALID.NO_LANDMARKS);

    const upper = pick(landmarks, idx.upperLid, opt.minLandmarkScore);
    const lower = pick(landmarks, idx.lowerLid, opt.minLandmarkScore);
    const inner = pick(landmarks, idx.inner, opt.minLandmarkScore);
    const outer = pick(landmarks, idx.outer, opt.minLandmarkScore);
    if (!upper || !lower || !inner || !outer) return bad(GAZE_INVALID.NO_LANDMARKS);

    // --- STEP 1: EAR BLINK GATE -----------------------------------------
    // Runs BEFORE the iris is even read. Nothing downstream can misinterpret
    // a closed eye because nothing downstream is computed for one.
    const ear = eyeAspectRatio(upper, lower, inner, outer);
    if (!Number.isFinite(ear)) return bad(GAZE_INVALID.DEGENERATE);
    if (ear < opt.earThreshold) return bad(GAZE_INVALID.EYE_CLOSED, ear);

    // --- STEP 2/3: iris position (only reached on an OPEN eye) ----------
    const iris = pick(landmarks, idx.iris, opt.minLandmarkScore);
    if (!iris) return bad(GAZE_INVALID.NO_LANDMARKS, ear);

    const hRatio = orientedGazeRatio(iris, inner, outer);
    const vRatio = verticalIrisRatio(iris, upper, lower);
    if (!Number.isFinite(hRatio) || !Number.isFinite(vRatio)) {
      return bad(GAZE_INVALID.DEGENERATE, ear);
    }

    return { valid: true, reason: null, ear, hRatio, vRatio };
  }

  /**
   * Analyse both eyes and fuse.
   *
   * BOTH eyes must be open and readable. A one-eye sample is rejected rather
   * than used: a single readable eye means a wink, an occlusion, or a partly
   * turned head, and averaging one eye's bias into "gaze" manufactures a
   * plausible wrong number. It also means a student cannot defeat the detector
   * by covering one eye.
   *
   * @param {Array<{x,y,score?}>} landmarks
   * @param {object} [options]
   * @returns {{valid:boolean, gaze:string, reason:string|null,
   *            ear:number, hRatio:number, vRatio:number, detail:object}}
   */
  function analyzeGazeLandmarks(landmarks, options = {}) {
    const opt = { ...DEFAULT_LANDMARK_OPTS, ...options };
    const C = opt.contract || LANDMARK_CONTRACT;

    const left = analyzeEye(landmarks, C.left, opt);
    const right = analyzeEye(landmarks, C.right, opt);
    const detail = {
      leftEar: Number.isFinite(left.ear) ? Number(left.ear.toFixed(3)) : null,
      rightEar: Number.isFinite(right.ear) ? Number(right.ear.toFixed(3)) : null,
      left: { valid: left.valid, reason: left.reason },
      right: { valid: right.valid, reason: right.reason },
    };

    if (!left.valid || !right.valid) {
      // EYE_CLOSED on EITHER eye closes the whole sample. Blink immunity is not
      // a per-eye property.
      const reason = (left.reason === GAZE_INVALID.EYE_CLOSED || right.reason === GAZE_INVALID.EYE_CLOSED)
        ? GAZE_INVALID.EYE_CLOSED
        : (left.reason || right.reason);
      return {
        valid: false,
        gaze: GAZE_STATE.UNKNOWN,
        reason,
        ear: Math.min(
          Number.isFinite(left.ear) ? left.ear : Infinity,
          Number.isFinite(right.ear) ? right.ear : Infinity
        ),
        hRatio: NaN,
        vRatio: NaN,
        detail,
      };
    }

    const hRatio = (left.hRatio + right.hRatio) / 2;
    const vRatio = (left.vRatio + right.vRatio) / 2;
    const ear = (left.ear + right.ear) / 2;

    return {
      valid: true,
      gaze: classifyAbsolute(hRatio, vRatio, opt),
      reason: null,
      ear,
      hRatio,
      vRatio,
      detail,
    };
  }

  /**
   * Label a sample against the spec's absolute bands.
   *
   * Reported for the teacher and used as a CORROBORATING requirement, never on
   * its own — absolute bands cannot be the whole decision, for the same reason
   * pose_geometry.js refuses absolute angles: resting iris position genuinely
   * differs between honest students (eye shape, IPD, camera height). The
   * calibrated deviation in GazeLandmarkAnalyzer is the primary signal.
   *
   * Directions are IMAGE-relative, matching every other teacher-facing readout.
   */
  function classifyAbsolute(hRatio, vRatio, options = {}) {
    const opt = { ...DEFAULT_LANDMARK_OPTS, ...options };
    if (!Number.isFinite(hRatio)) return GAZE_STATE.UNKNOWN;
    if (hRatio < opt.offScreenLeft) return GAZE_STATE.LEFT;
    if (hRatio > opt.offScreenRight) return GAZE_STATE.RIGHT;
    if (Number.isFinite(vRatio) && vRatio > opt.downThreshold) return GAZE_STATE.DOWN;
    return GAZE_STATE.CENTRE;
  }

  /** True when a sample sits outside the spec's neutral forward band. */
  function isOffAxisAbsolute(hRatio, vRatio, options = {}) {
    const opt = { ...DEFAULT_LANDMARK_OPTS, ...options };
    if (!Number.isFinite(hRatio)) return false;
    if (hRatio < opt.neutralMin || hRatio > opt.neutralMax) return true;
    return Number.isFinite(vRatio) && vRatio > opt.downThreshold;
  }

  // ---------------------------------------------------------------------------
  // Stateful analyser. One instance per proctoring session.
  // ---------------------------------------------------------------------------

  class GazeLandmarkAnalyzer {
    constructor(options = {}) {
      this.opt = {
        ...DEFAULT_LANDMARK_OPTS,
        ...options,
        calibration: { ...DEFAULT_LANDMARK_CALIBRATION, ...(options.calibration || {}) },
        gate: { ...DEFAULT_LANDMARK_GATE, ...(options.gate || {}) },
        smoother: { windowMs: 1200, mode: 'median', ...(options.smoother || {}) },
      };

      // Identity converter: the PoseDeviation "deg" fields carry centred
      // ratios here, not angles. Surfaced as `offset*` so nothing downstream
      // can mistake one for the other.
      this.baseline = new PoseBaseline(this.opt.calibration, (r) => r);
      this.smoother = new TemporalSmoother(this.opt.smoother);
      this.gate = new DwellGate(this.opt.gate);

      this.lastSample = null;
      this.lastDeviation = null;
      this.lastReason = GAZE_INVALID.NOT_SAMPLED;
      this.lastGaze = GAZE_STATE.UNKNOWN;
      this.suppressed = false;
    }

    reset() {
      this.baseline.reset();
      this.smoother.reset();
      this.gate.reset();
      this.lastSample = null;
      this.lastDeviation = null;
      this.lastReason = GAZE_INVALID.NOT_SAMPLED;
      this.lastGaze = GAZE_STATE.UNKNOWN;
      this.suppressed = false;
    }

    isCalibrated() {
      return this.baseline.isCalibrated();
    }

    /**
     * Advance by one frame.
     *
     * @param {Array<{x,y,score?}>|null} landmarks - 478-point set, or null.
     * @param {{calibrated:boolean, smoothedExcursion:number}|null} poseResult
     * @param {number} nowMs
     * @param {boolean} [suppress=false] - Withhold REPORTING only.
     * @returns {object}
     */
    /**
     * Head yaw for this frame, in degrees of deviation from the student's own
     * calibrated neutral. NaN when the pose pipeline could not measure it —
     * which the caller must treat as UNKNOWN, never as "straight ahead".
     * @private
     */
    _headYawDeg(poseResult) {
      const dev = poseResult && poseResult.deviation;
      return dev && Number.isFinite(dev.yawDeg) ? dev.yawDeg : NaN;
    }

    process(landmarks, poseResult, nowMs, suppress = false) {
      this.suppressed = !!suppress;
      const events = [];

      // --- STEP 4: head must be inside its calibrated neutral -------------
      //
      // TWO conditions, and both are required:
      //
      //   (a) calibrated excursion < maxHeadExcursion — the student's own
      //       neutral band, which is the only fair basis (resting head position
      //       genuinely differs between honest students).
      //   (b) abs(yaw) < maxHeadYawDeg — an ABSOLUTE bound, as specified.
      //
      // Requiring both is strictly more conservative than either, and it is the
      // same belt-and-braces this module already applies to its ratio bands
      // (absolute 0.35/0.65 AND per-student deviation). (b) alone would repeat
      // the defect pose_geometry.js §7 exists to prevent; (a) alone lets a
      // student who calibrated at an angle carry that angle into the gaze
      // stage, where this module has no rotation compensation by design.
      //
      // Degrees come from ratioToApproxDegrees, owned by the frozen pose
      // modules. RATIO_TO_DEG is NOT touched here.
      const headReady = !!(poseResult && poseResult.calibrated);
      const yawDeg = this._headYawDeg(poseResult);
      const headNeutral = headReady
        && Number.isFinite(poseResult.smoothedExcursion)
        && poseResult.smoothedExcursion < this.opt.maxHeadExcursion
        // Unknown yaw is UNKNOWN, not compliant: if we cannot measure the head
        // we do not get to assume it was straight.
        && Number.isFinite(yawDeg)
        && Math.abs(yawDeg) < this.opt.maxHeadYawDeg;

      let usable = null;   // null = UNKNOWN. Never false-by-default.
      let deviation = null;
      let smoothed = NaN;
      let sample = null;

      if (!headReady || !headNeutral) {
        this.lastReason = GAZE_INVALID.HEAD_OFF_NEUTRAL;
        this.lastGaze = GAZE_STATE.UNKNOWN;
      } else {
        sample = landmarks ? analyzeGazeLandmarks(landmarks, this.opt) : null;

        if (!sample || !sample.valid) {
          // ⚠ THE LOAD-BEARING BRANCH. A blink lands here and contributes an
          // UNKNOWN frame — not deviant, not compliant. DwellGate needs
          // sustained TRUE, so no run of blinks can ever reach an alert.
          this.lastReason = sample ? sample.reason : GAZE_INVALID.NOT_SAMPLED;
          this.lastGaze = GAZE_STATE.UNKNOWN;
        } else {
          this.lastReason = null;
          this.lastGaze = sample.gaze;
          this.lastSample = sample;

          // Centre both ratios on 0 so the baseline's symmetric tolerance means
          // the same thing on each side. Vertical is negated into pitch
          // convention (pose_calibration reads pitchDev < 0 as 'down', but a
          // LARGER vRatio means the iris moved DOWN) — encoded once, here.
          const asPose = {
            yawRatio: sample.hRatio - 0.5,
            pitchRatio: -(sample.vRatio - 0.5),
            rollDeg: 0,
          };

          const reporting = this.gate.state === GateState.GLANCE
            || this.gate.state === GateState.ALERT;
          this.baseline.addSample(asPose, nowMs, !reporting);

          if (this.baseline.isCalibrated()) {
            deviation = this.baseline.deviation(asPose);
            smoothed = this.smoother.push(deviation.excursion, nowMs);
            // BOTH must agree: outside this student's own calibrated band AND
            // outside the spec's absolute neutral range. Requiring both is
            // strictly more conservative than either alone, and marginal
            // evidence must favour the student.
            usable = smoothed >= 1.0 && isOffAxisAbsolute(sample.hRatio, sample.vRatio, this.opt);
          }
          this.lastDeviation = deviation;
        }
      }

      const res = this.gate.update(usable, nowMs, Number.isFinite(smoothed) ? smoothed : 0);

      if (!this.suppressed && (res.event === 'alert' || res.event === 'glance')) {
        events.push({
          condition: GazeCondition.SIDE_GAZE_PEEKING,
          // Capped at MEDIUM. Coarse signal; never CRITICAL, never escalated by
          // the classifier (which has no notion of eye direction either).
          severity: res.event === 'alert' ? 'MEDIUM' : 'LOW',
          dwellMs: Math.round(res.dwellMs),
          peak: Number(res.peak.toFixed(3)),
          detail: {
            gaze: this.lastGaze,
            ear: sample && Number.isFinite(sample.ear) ? Number(sample.ear.toFixed(3)) : null,
            hRatio: sample && Number.isFinite(sample.hRatio) ? Number(sample.hRatio.toFixed(3)) : null,
            vRatio: sample && Number.isFinite(sample.vRatio) ? Number(sample.vRatio.toFixed(3)) : null,
            offsetH: deviation ? Number(deviation.yawDev.toFixed(3)) : null,
            offsetV: deviation ? Number(deviation.pitchDev.toFixed(3)) : null,
            excursion: Number.isFinite(smoothed) ? Number(smoothed.toFixed(3)) : null,
            neutral: this.baseline.snapshot().neutral,
            tolerance: this.baseline.snapshot().tolerance,
            head_excursion: poseResult ? Number((poseResult.smoothedExcursion || 0).toFixed(3)) : null,
            detector: 'gaze_landmarks_ear',
          },
        });
      }

      return {
        status: this._status(res),
        calibrated: this.baseline.isCalibrated(),
        calibrationProgress: this.baseline.progress(),
        gaze: this.lastGaze,
        reason: this.lastReason,
        ear: sample && Number.isFinite(sample.ear) ? sample.ear : NaN,
        deviation,
        smoothedExcursion: Number.isFinite(smoothed) ? smoothed : 0,
        events,
      };
    }

    _status(gateResult) {
      if (this.lastReason === GAZE_INVALID.HEAD_OFF_NEUTRAL) return 'head_off_neutral';
      if (this.lastReason === GAZE_INVALID.EYE_CLOSED) return 'eyes_closed';
      if (this.lastReason) return 'unreadable';
      if (!this.baseline.isCalibrated()) return 'calibrating';
      if (gateResult.state === GateState.ALERT) return 'alert';
      if (gateResult.state === GateState.GLANCE) return 'glance';
      return 'ok';
    }

    snapshot() {
      return {
        calibrated: this.baseline.isCalibrated(),
        progress: this.baseline.progress(),
        baseline: this.baseline.snapshot(),
        gateState: this.gate.state,
        gaze: this.lastGaze,
        reason: this.lastReason,
        suppressed: this.suppressed,
        detector: 'gaze_landmarks_ear',
      };
    }
  }

  return {
    LANDMARK_CONTRACT,
    GAZE_STATE,
    GAZE_INVALID,
    DEFAULT_LANDMARK_OPTS,
    DEFAULT_LANDMARK_CALIBRATION,
    DEFAULT_LANDMARK_GATE,
    GazeCondition,
    dist,
    projectionRatio,
    eyeAspectRatio,
    orientedGazeRatio,
    verticalIrisRatio,
    analyzeEye,
    analyzeGazeLandmarks,
    classifyAbsolute,
    isOffAxisAbsolute,
    GazeLandmarkAnalyzer,
  };
}));
