// =============================================================================
// Head Pose Analysis Pipeline — AI Observer Extension
//
// Composes the pure vision modules into the single object monitor.js talks to:
//
//   pose_geometry     keypoints -> scale-invariant ratios
//   pose_calibration  ratios    -> deviation from THIS student's own neutral
//   temporal_gate     deviation -> smoothed, dwell-gated events
//
// Three independent conditions are tracked, each through its OWN dwell gate so
// that none of them can ever fire on a single frame:
//
//   pose deviation  - sustained look-away from the calibrated neutral
//   absence         - no person in frame
//   multiple people - more than one person in frame
//
// The last two come free: the pose model is a person detector that happens to
// emit keypoints, so person count is already in hand. They fill the
// NO_FACE_DETECTED and MULTIPLE_FACES violation types that the taxonomy has
// always declared but never emitted.
// =============================================================================

/* global computeHeadPose, ratioToApproxDegrees, PoseBaseline, TemporalSmoother, DwellGate, GateState */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./pose_geometry.js'),
      require('./pose_calibration.js'),
      require('./temporal_gate.js')
    );
  } else {
    // In the extension all three scripts have already attached to window.
    root.__posePipeline = factory(root, root, root);
    Object.assign(root, root.__posePipeline);
  }
}(typeof self !== 'undefined' ? self : this, function (geometry, calibration, temporal) {

  const { computeHeadPose, ratioToApproxDegrees } = geometry;
  const { PoseBaseline } = calibration;
  const { TemporalSmoother, DwellGate, GateState } = temporal;

  /** Conditions this pipeline can report. */
  const PoseCondition = {
    LOOK_AWAY: 'LOOK_AWAY',
    NO_FACE: 'NO_FACE',
    MULTIPLE_FACES: 'MULTIPLE_FACES',
  };

  const PipelineStatus = {
    CALIBRATING: 'calibrating',
    OK: 'ok',
    GLANCE: 'glance',
    ALERT: 'alert',
    FACE_LOST: 'face_lost',  // Transient: no usable view of the face right now.
    NO_FACE: 'no_face',      // Sustained, and reported.
    MULTI_FACE: 'multi_face',
  };

  const DEFAULT_PIPELINE_OPTS = {
    geometry: {},
    calibration: {},
    smoother: { windowMs: 1200, mode: 'median' },

    // Sustained look-away. The spec's numbers: ignore under 1.5 s (normal
    // screen-reading), high severity past 2.5 s.
    poseGate: { glanceMs: 1500, alertMs: 2500, graceMs: 400, minRealertMs: 15000 },

    // Absence is given a longer fuse: leaning out of frame to stretch is
    // common, and the pose model also drops detections transiently.
    absenceGate: { glanceMs: 2500, alertMs: 5000, graceMs: 800, minRealertMs: 20000 },

    // A second person walking past a doorway should not accuse anyone.
    multiGate: { glanceMs: 1500, alertMs: 3000, graceMs: 600, minRealertMs: 20000 },

    // Minimum detection score for a person box to count at all.
    minPersonScore: 0.45,
    // Excursion above which a frame counts as deviant. 1.0 means "outside this
    // student's calibrated tolerance band" by construction.
    excursionThreshold: 1.0,
  };

  /**
   * Stateful analyser. One instance per proctoring session.
   */
  class HeadPoseAnalyzer {
    constructor(options = {}) {
      this.opt = {
        ...DEFAULT_PIPELINE_OPTS,
        ...options,
        geometry: { ...DEFAULT_PIPELINE_OPTS.geometry, ...(options.geometry || {}) },
        calibration: { ...DEFAULT_PIPELINE_OPTS.calibration, ...(options.calibration || {}) },
        smoother: { ...DEFAULT_PIPELINE_OPTS.smoother, ...(options.smoother || {}) },
        poseGate: { ...DEFAULT_PIPELINE_OPTS.poseGate, ...(options.poseGate || {}) },
        absenceGate: { ...DEFAULT_PIPELINE_OPTS.absenceGate, ...(options.absenceGate || {}) },
        multiGate: { ...DEFAULT_PIPELINE_OPTS.multiGate, ...(options.multiGate || {}) },
      };

      this.baseline = new PoseBaseline(this.opt.calibration, ratioToApproxDegrees);
      this.smoother = new TemporalSmoother(this.opt.smoother);
      this.poseGate = new DwellGate(this.opt.poseGate);
      this.absenceGate = new DwellGate(this.opt.absenceGate);
      this.multiGate = new DwellGate(this.opt.multiGate);

      this.lastPose = null;
      this.lastDeviation = null;
    }

    /** Full reset, including the calibrated neutral. */
    reset() {
      this.baseline.reset();
      this.smoother.reset();
      this.poseGate.reset();
      this.absenceGate.reset();
      this.multiGate.reset();
      this.lastPose = null;
      this.lastDeviation = null;
    }

    /**
     * Discard the neutral and recalibrate, keeping the temporal state.
     * Worth calling when the student has been away long enough that their
     * seating position is likely to have changed.
     */
    recalibrate() {
      this.baseline.reset();
      this.smoother.reset();
    }

    /** @returns {boolean} */
    isCalibrated() {
      return this.baseline.isCalibrated();
    }

    /**
     * Advance the pipeline by one frame.
     *
     * @param {Array<{score:number, keypoints:Array<{x,y,score}>}>} persons
     *        Person detections from the pose model, already NMS'd. May be empty.
     * @param {number} nowMs - Monotonic timestamp (performance.now()).
     * @returns {{
     *   status: string,
     *   calibrated: boolean,
     *   calibrationProgress: number,
     *   personCount: number,
     *   pose: object|null,
     *   deviation: object|null,
     *   smoothedExcursion: number,
     *   events: Array<{condition:string, severity:string, dwellMs:number, detail:object}>
     * }}
     */
    process(persons, nowMs) {
      const valid = (persons || []).filter((p) => p && p.score >= this.opt.minPersonScore);
      const personCount = valid.length;
      const events = [];

      // --- Head pose on the primary (highest-scoring) person ---
      let pose = null;
      let deviation = null;
      let smoothed = NaN;

      if (personCount > 0) {
        const primary = valid.reduce((a, b) => (b.score > a.score ? b : a));
        pose = computeHeadPose(primary.keypoints, this.opt.geometry);
      }
      const faceReadable = !!(pose && pose.valid);

      // --- Absence and crowding, each on its own dwell gate ---
      //
      // Absence means "no usable view of the student's face", NOT merely "no
      // person box". A student who covers the camera or turns fully away is
      // still detected as a person while their facial keypoints stop resolving;
      // treating that as compliant would leave an obvious hole, and the
      // violation type is NO_FACE_DETECTED, not NO_PERSON_DETECTED.
      const absence = this.absenceGate.update(!faceReadable, nowMs, 1);
      if (absence.event === 'alert' || absence.event === 'glance') {
        events.push(this._event(PoseCondition.NO_FACE, absence, {
          personCount,
          reason: personCount === 0 ? 'no_person_detected' : (pose ? pose.reason : 'no_keypoints'),
        }));
      }

      const multi = this.multiGate.update(personCount > 1, nowMs, personCount);
      if (multi.event === 'alert' || multi.event === 'glance') {
        events.push(this._event(PoseCondition.MULTIPLE_FACES, multi, { personCount }));
      }

      if (faceReadable) {
        // Drift is suppressed while an episode is being reported, so a genuine
        // sustained look-away can never be absorbed into the neutral.
        const reporting = this.poseGate.state === GateState.GLANCE
          || this.poseGate.state === GateState.ALERT;
        this.baseline.addSample(pose, nowMs, !reporting);

        if (this.baseline.isCalibrated()) {
          deviation = this.baseline.deviation(pose);
          smoothed = this.smoother.push(deviation.excursion, nowMs);
        }
        this.lastPose = pose;
        this.lastDeviation = deviation;
      }

      // A frame with no usable pose contributes `null` (unknown), not `false`.
      // Reporting it as "not deviant" would let a student defeat the gate by
      // turning far enough that their keypoints stop resolving.
      let deviant = null;
      if (this.baseline.isCalibrated() && Number.isFinite(smoothed)) {
        deviant = smoothed >= this.opt.excursionThreshold;
      }

      const poseResult = this.poseGate.update(deviant, nowMs, Number.isFinite(smoothed) ? smoothed : 0);
      if (poseResult.event === 'alert' || poseResult.event === 'glance') {
        events.push(this._event(PoseCondition.LOOK_AWAY, poseResult, {
          axis: deviation ? deviation.axis : null,
          direction: deviation ? deviation.direction : null,
          yawDeg: deviation ? Number(deviation.yawDeg.toFixed(1)) : null,
          pitchDeg: deviation ? Number(deviation.pitchDeg.toFixed(1)) : null,
          rollDeg: deviation ? Number(deviation.rollDev.toFixed(1)) : null,
          excursion: Number.isFinite(smoothed) ? Number(smoothed.toFixed(3)) : null,
          neutral: this.baseline.snapshot().neutral,
          tolerance: this.baseline.snapshot().tolerance,
        }));
      }

      return {
        status: this._status(faceReadable, poseResult, absence, multi),
        calibrated: this.baseline.isCalibrated(),
        calibrationProgress: this.baseline.progress(),
        personCount,
        pose,
        deviation,
        smoothedExcursion: Number.isFinite(smoothed) ? smoothed : 0,
        events,
      };
    }

    _event(condition, gateResult, detail) {
      return {
        condition,
        severity: gateResult.event === 'alert' ? 'HIGH' : 'LOW',
        dwellMs: Math.round(gateResult.dwellMs),
        peak: Number(gateResult.peak.toFixed(3)),
        detail,
      };
    }

    _status(faceReadable, poseResult, absence, multi) {
      if (absence.state === GateState.ALERT) return PipelineStatus.NO_FACE;
      if (multi.state === GateState.ALERT) return PipelineStatus.MULTI_FACE;
      if (!this.baseline.isCalibrated()) return PipelineStatus.CALIBRATING;
      if (poseResult.state === GateState.ALERT) return PipelineStatus.ALERT;
      if (poseResult.state === GateState.GLANCE) return PipelineStatus.GLANCE;
      // Never report OK on a frame where the face could not actually be read —
      // "unknown" and "compliant" are different answers.
      if (!faceReadable) return PipelineStatus.FACE_LOST;
      return PipelineStatus.OK;
    }

    /** Compact snapshot for telemetry / the floating widget. */
    snapshot() {
      return {
        calibrated: this.baseline.isCalibrated(),
        progress: this.baseline.progress(),
        baseline: this.baseline.snapshot(),
        poseState: this.poseGate.state,
        absenceState: this.absenceGate.state,
        multiState: this.multiGate.state,
      };
    }
  }

  return { PoseCondition, PipelineStatus, DEFAULT_PIPELINE_OPTS, HeadPoseAnalyzer };
}));
