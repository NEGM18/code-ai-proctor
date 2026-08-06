// =============================================================================
// Eye-Gaze from an ROI Crop — AI Observer Extension
//
// Closes the one blind spot every other detector shares: they all answer "where
// is the HEAD pointing?". A student who holds their head square to the camera
// and moves only their eyes — to notes on the desk, or a second monitor — is
// invisible to all of them.
//
// NO NEW MODEL. This reads pixels from the eye region that pose.onnx already
// located, and reuses pose_calibration + temporal_gate unmodified.
//
// -----------------------------------------------------------------------------
// ⚠ THE FAILURE THIS MODULE IS SHAPED AROUND
//
// The trained binary classifier used to flag CLOSED EYES as cheating. A naive
// iris tracker does not merely fail on closed eyes — it fails in that same
// direction, which is worse. When the lid shuts, the darkest pixels in the eye
// box become the LASH LINE, and the lash line sits LOW in the box. A darkness
// centroid therefore reads a shut eye as an extreme DOWNWARD gaze — i.e. as
// "looking down at notes". Blinking would become cheating all over again.
//
// Three layers make that structurally impossible rather than merely unlikely:
//
//   1. The openness gate runs BEFORE any centroid is computed. A closed eye
//      returns valid:false with reason EYE_CLOSED. It never yields a direction.
//   2. An unusable frame is UNKNOWN, not compliant and not deviant — the rule
//      pose_pipeline.js already follows. DwellGate needs sustained TRUE to fire,
//      so an unbroken run of unknowns can never accumulate into an alert.
//   3. Gaze is only evaluated while the head is inside its calibrated neutral
//      band. Off-neutral frames belong to AI_CHEATING_POSE, not to us.
//
// A student who blinks, dozes, or wears heavy glasses generates SILENCE. Not
// evidence.
// -----------------------------------------------------------------------------
//
// DESIGN NOTE — why normalised offsets and not gaze angles:
// Same reasoning as pose_geometry.js. An absolute gaze angle from a ~20px eye
// crop is not trustworthy, and two honest students differ substantially in
// resting iris position (eye shape, camera height, interpupillary distance).
// What is emitted here is a scale-invariant offset within the student's OWN eye
// box; pose_calibration.js turns it into a deviation from their OWN neutral, and
// only that deviation ever drives an event.
// =============================================================================

/* global PoseBaseline, TemporalSmoother, DwellGate, GateState */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./pose_calibration.js'),
      require('./temporal_gate.js')
    );
  } else {
    // In the extension both scripts have already attached to window.
    root.__gazeRoi = factory(root, root);
    Object.assign(root, root.__gazeRoi);
  }
}(typeof self !== 'undefined' ? self : this, function (calibration, temporal) {

  const { PoseBaseline } = calibration;
  const { TemporalSmoother, DwellGate, GateState } = temporal;

  /** COCO-17 eye indices. Matches KP in pose_geometry.js. */
  const EYE_KP = { LEFT: 1, RIGHT: 2 };

  /** Reasons a gaze sample can be rejected. Surfaced in telemetry. */
  const GAZE_INVALID = {
    NO_KEYPOINTS: 'no_keypoints',
    LOW_CONFIDENCE: 'low_confidence',
    FACE_TOO_SMALL: 'face_too_small',
    EYE_CLOSED: 'eye_closed',
    NO_IRIS: 'no_iris',
    HEAD_OFF_NEUTRAL: 'head_off_neutral',
    NOT_SAMPLED: 'not_sampled',
  };

  /**
   * ⚠ SIGN CONVENTION — read this before touching any threshold.
   *
   * getUserMedia frames are UNMIRRORED, and pose_geometry.js fixes the house
   * convention: "positive means the nose moved toward the RIGHT of the frame …
   * It is the subject's own LEFT."
   *
   * Horizontal gaze inherits that convention for free:
   *
   *   student looks toward THEIR OWN left
   *     -> iris moves toward the RIGHT of the camera image
   *     -> centroid x increases -> gazeH is POSITIVE
   *
   * So gazeH is drop-in compatible with the yawRatio slot of PoseBaseline, and
   * the direction labels it emits stay image-relative ('right' = right of the
   * image), consistent with every other teacher-facing readout in the system.
   *
   * VERTICAL IS NOT. Image y grows downward, so looking DOWN increases centroid
   * y — but pose_geometry's pitchRatio DECREASES when the head tilts down, and
   * pose_calibration reads `pitchDev < 0` as 'down'. Feeding raw gazeV into the
   * pitch slot would label every downward glance 'up' and every upward one
   * 'down'. The flip is encoded ONCE, here, and pinned by a test. Never patch it
   * by inverting an individual threshold.
   */
  const GAZE_V_TO_PITCH_SIGN = -1;

  const DEFAULT_GAZE_OPTS = {
    // --- resolution floor -----------------------------------------------
    // pose_geometry gets by on 12px interocular; an iris cannot. At 12px the
    // whole eye box is ~7px across and the centroid is quantisation noise.
    // Below this floor the module reports NOTHING — never a guess.
    minInterocularPx: 45,
    minEyeScore: 0.50,

    // --- eye box, sized off interocular so it is scale-invariant ---------
    // Same normalisation basis as the entire pose stack, for the reasons in
    // pose_geometry.js:71-76 — one always-available basis beats a more precise
    // one that changes underfoot.
    roiWidthRatio: 0.62,
    roiHeightRatio: 0.40,

    // --- openness gate (see the header) ----------------------------------
    // An OPEN eye is high-contrast: dark iris against bright sclera. A CLOSED
    // eye is uniform eyelid skin. Spread is measured as p90-p10 of luma so a
    // few specular pixels cannot fake it.
    //
    // Deliberately permissive: a partly-lidded eye (which is what looking DOWN
    // produces) should still be readable. Erring high here would reject genuine
    // downward gaze — a miss, which is the safe direction, but a needless one.
    minIntensitySpread: 26,

    // Adaptive darkness threshold, expressed as a fraction of the eye's OWN
    // measured intensity range rather than an absolute grey level. This is what
    // keeps the gate behaving the same across iris colours and skin tones; a
    // fixed threshold would not.
    darkBandFraction: 0.35,

    // The dark region must be a plausible iris: present, not most of the box.
    minDarkFraction: 0.04,
    maxDarkFraction: 0.55,

    // ⚠ This is the test that specifically kills the lash line. A closed eye's
    // dark region is a thin horizontal sliver; an iris is roughly round. Same
    // sliver-rejection logic detectors.js applies to phones via maxAspectRatio.
    maxDarkAspectRatio: 3.0,

    // --- head-neutral requirement ----------------------------------------
    // Below the pose pipeline's own excursionThreshold of 1.0, so gaze runs
    // only well INSIDE the neutral band. Two jobs at once: it confines gaze to
    // the blind spot it exists to close, and it removes the largest confounder
    // — apparent iris offset shifts under head rotation even when gaze is fixed,
    // and this module has no rotation compensation by design.
    maxHeadExcursion: 0.75,
  };

  /**
   * Calibration options for the gaze baseline.
   *
   * Units are normalised eye-box offsets in [-1,1], NOT the ratio units
   * pose_calibration defaults to, so every tolerance has to be restated.
   *
   * The vertical band is deliberately WIDER than the horizontal. The upper lid
   * always occludes part of the iris, and how much it occludes varies with
   * expression and lid position, so the vertical centroid carries a wandering
   * bias that the horizontal one does not. Treating the two axes as equally
   * trustworthy would make vertical the source of every false positive.
   */
  const DEFAULT_GAZE_CALIBRATION = {
    calibrationMs: 5000,
    minSamples: 15,
    toleranceK: 3.5,
    minYawTolerance: 0.16,   // horizontal
    maxYawTolerance: 0.50,
    minPitchTolerance: 0.24, // vertical — see above
    maxPitchTolerance: 0.70,
    minRollTolerance: 1,     // unused; gaze feeds rollDeg = 0
    maxRollTolerance: 1,
  };

  const DEFAULT_GAZE_GATE = {
    // Longer fuses than the head-pose gate. Eyes flick constantly during normal
    // reading, and this signal is coarser than head pose, so it must be slower
    // to accuse.
    glanceMs: 2000,
    alertMs: 3500,
    graceMs: 500,
    minRealertMs: 20000,
  };

  /** Conditions this module can report. */
  const GazeCondition = {
    GAZE_OFF_SCREEN: 'GAZE_OFF_SCREEN',
  };

  // ---------------------------------------------------------------------------
  // Pure pixel math. No canvas, no DOM — every function below runs under Node.
  // ---------------------------------------------------------------------------

  /**
   * Percentile of a luma array. Copies before sorting; callers reuse buffers.
   * @param {Uint8ClampedArray|Uint8Array|number[]} gray
   * @param {number} p - in [0,1]
   * @returns {number}
   */
  function percentile(gray, p) {
    const n = gray.length;
    if (!n) return NaN;
    const sorted = Array.prototype.slice.call(gray).sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(n - 1, Math.round(p * (n - 1))));
    return sorted[idx];
  }

  /**
   * Convert an RGBA buffer to single-channel luma.
   * @param {Uint8ClampedArray} rgba
   * @param {Uint8ClampedArray} [out] - Optional reusable destination.
   * @returns {Uint8ClampedArray}
   */
  function rgbaToGray(rgba, out) {
    const n = rgba.length >> 2;
    const dst = out && out.length >= n ? out : new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) {
      const o = i << 2;
      dst[i] = (0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]) | 0;
    }
    return dst;
  }

  /**
   * Decide whether an eye region shows an OPEN eye, and where the iris is.
   *
   * Order matters and is load-bearing: openness is settled FIRST, and a closed
   * eye returns before any centroid exists to be misread. See the file header.
   *
   * @param {Uint8ClampedArray|number[]} gray - w*h luma samples, row-major.
   * @param {number} w
   * @param {number} h
   * @param {object} [options]
   * @returns {{
   *   valid: boolean, reason: string|null,
   *   gazeH: number, gazeV: number,
   *   spread: number, darkFraction: number, darkAspect: number
   * }}
   */
  function analyzeEyeRegion(gray, w, h, options = {}) {
    const opt = { ...DEFAULT_GAZE_OPTS, ...options };

    const invalid = (reason, extra = {}) => ({
      valid: false,
      reason,
      gazeH: 0,
      gazeV: 0,
      spread: 0,
      darkFraction: 0,
      darkAspect: 0,
      ...extra,
    });

    if (!gray || w <= 2 || h <= 2 || gray.length < w * h) {
      return invalid(GAZE_INVALID.NO_KEYPOINTS);
    }

    // --- 1. OPENNESS: contrast ------------------------------------------
    // An open eye pairs a dark iris with bright sclera. Closed eyelid skin is
    // near-uniform. This single test carries most of the load.
    //
    // ⚠ p05/p95, NOT p10/p90. The iris can occupy under 10% of the box on a
    // small or distant eye, and a p10 cut-off simply never reaches that dark
    // population — the region then reads as flat and an OPEN eye is rejected as
    // closed. Widening the percentiles keeps small irises visible, and it also
    // moves the lash line onto the SHAPE test below, which is the test actually
    // designed to catch it. Narrowing these back to p10/p90 silently shrinks
    // coverage for exactly the students who are hardest to read.
    const p05 = percentile(gray, 0.05);
    const p95 = percentile(gray, 0.95);
    const spread = p95 - p05;
    if (spread < opt.minIntensitySpread) {
      return invalid(GAZE_INVALID.EYE_CLOSED, { spread });
    }

    // --- 2. Adaptive dark mask ------------------------------------------
    // Threshold sits a fixed fraction into the eye's OWN intensity range, so it
    // tracks iris colour and skin tone instead of assuming them.
    const threshold = p05 + opt.darkBandFraction * spread;

    let count = 0;
    let minX = w, maxX = -1, minY = h, maxY = -1;
    let sumW = 0, sumWX = 0, sumWY = 0;

    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const v = gray[row + x];
        if (v > threshold) continue;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        // Weight by how dark the pixel is: the iris centre pulls harder than
        // its rim, which stabilises the centroid against partial lid occlusion.
        const weight = (threshold - v) + 1;
        sumW += weight;
        sumWX += weight * x;
        sumWY += weight * y;
      }
    }

    const total = w * h;
    const darkFraction = count / total;
    if (darkFraction < opt.minDarkFraction) {
      return invalid(GAZE_INVALID.NO_IRIS, { spread, darkFraction });
    }
    if (darkFraction > opt.maxDarkFraction) {
      // Most of the box is dark: deep shadow, hair, or a badly placed crop.
      // Not an iris, and not something to guess about.
      return invalid(GAZE_INVALID.NO_IRIS, { spread, darkFraction });
    }

    // --- 3. OPENNESS: shape ---------------------------------------------
    // ⚠ The lash-line test. A shut eye leaves a wide, flat dark streak; an iris
    // is roughly round. Without this, a lid that still shows some contrast
    // reads as an extreme downward gaze — the exact bug this module exists to
    // avoid reintroducing.
    const boxW = (maxX - minX) + 1;
    const boxH = (maxY - minY) + 1;
    const darkAspect = boxH > 0 ? boxW / boxH : 0;
    if (darkAspect > opt.maxDarkAspectRatio) {
      return invalid(GAZE_INVALID.EYE_CLOSED, { spread, darkFraction, darkAspect });
    }

    if (sumW <= 0) return invalid(GAZE_INVALID.NO_IRIS, { spread, darkFraction, darkAspect });

    // --- 4. Iris centroid -> normalised offset --------------------------
    const cx = sumWX / sumW;
    const cy = sumWY / sumW;
    const halfW = w / 2;
    const halfH = h / 2;

    return {
      valid: true,
      reason: null,
      // Positive = toward the RIGHT of the image = the student's own LEFT.
      // See GAZE_V_TO_PITCH_SIGN above; this axis needs no flip.
      gazeH: (cx - halfW) / halfW,
      // Positive = DOWN in image coordinates. The flip into pitch convention
      // happens at the analyzer boundary, once.
      gazeV: (cy - halfH) / halfH,
      spread,
      darkFraction,
      darkAspect,
    };
  }

  /**
   * Eye ROI boxes in SOURCE pixel space.
   *
   * Keypoints arrive already un-letterboxed by decodePoseOutput (detectors.js),
   * so no coordinate mapping is needed here.
   *
   * @param {Array<{x:number,y:number,score:number}>} kps - COCO-17 keypoints.
   * @param {object} [options]
   * @returns {{
   *   left:{x:number,y:number,w:number,h:number},
   *   right:{x:number,y:number,w:number,h:number},
   *   interocular:number
   * }|{invalid:string}}
   */
  function eyeRoiBoxes(kps, options = {}) {
    const opt = { ...DEFAULT_GAZE_OPTS, ...options };
    if (!kps || kps.length < 3) return { invalid: GAZE_INVALID.NO_KEYPOINTS };

    const l = kps[EYE_KP.LEFT];
    const r = kps[EYE_KP.RIGHT];
    if (!l || !r) return { invalid: GAZE_INVALID.NO_KEYPOINTS };
    if (l.score < opt.minEyeScore || r.score < opt.minEyeScore) {
      return { invalid: GAZE_INVALID.LOW_CONFIDENCE };
    }

    const dx = l.x - r.x;
    const dy = l.y - r.y;
    const interocular = Math.sqrt(dx * dx + dy * dy);
    if (!Number.isFinite(interocular) || interocular < opt.minInterocularPx) {
      return { invalid: GAZE_INVALID.FACE_TOO_SMALL };
    }

    const w = Math.max(4, Math.round(interocular * opt.roiWidthRatio));
    const h = Math.max(4, Math.round(interocular * opt.roiHeightRatio));
    const box = (kp) => ({
      x: Math.round(kp.x - w / 2),
      y: Math.round(kp.y - h / 2),
      w,
      h,
    });

    return { left: box(l), right: box(r), interocular };
  }

  /**
   * Fuse the two per-eye results into one sample.
   *
   * Both eyes must read for the sample to count. One-eye samples are rejected
   * on purpose: a single readable eye usually means the head is partly turned
   * or one eye is occluded, and averaging one eye's bias into a "gaze" is how a
   * plausible-looking wrong number gets made.
   *
   * @param {object} leftRes - analyzeEyeRegion output for the left eye.
   * @param {object} rightRes
   * @returns {{valid:boolean, reason:string|null, gazeH:number, gazeV:number, detail:object}}
   */
  function combineEyes(leftRes, rightRes) {
    const detail = {
      left: leftRes ? { valid: leftRes.valid, reason: leftRes.reason } : null,
      right: rightRes ? { valid: rightRes.valid, reason: rightRes.reason } : null,
    };

    if (!leftRes || !leftRes.valid) {
      return { valid: false, reason: leftRes ? leftRes.reason : GAZE_INVALID.NO_KEYPOINTS, gazeH: 0, gazeV: 0, detail };
    }
    if (!rightRes || !rightRes.valid) {
      return { valid: false, reason: rightRes ? rightRes.reason : GAZE_INVALID.NO_KEYPOINTS, gazeH: 0, gazeV: 0, detail };
    }

    return {
      valid: true,
      reason: null,
      gazeH: (leftRes.gazeH + rightRes.gazeH) / 2,
      gazeV: (leftRes.gazeV + rightRes.gazeV) / 2,
      detail,
    };
  }

  // ---------------------------------------------------------------------------
  // Browser-side sampler. The only part that needs a canvas.
  // ---------------------------------------------------------------------------

  /**
   * Crops both eye regions off a video frame in ONE readback.
   *
   * CLAUDE.md is explicit that getImageData is the expensive operation in the
   * per-frame path, so this draws a single strip spanning both eyes and reads it
   * once, then indexes into that buffer per eye. Two crops would double the cost
   * of the only part that actually costs anything.
   */
  class GazeSampler {
    constructor(options = {}) {
      this.opt = { ...DEFAULT_GAZE_OPTS, ...options };
      this._canvas = null;
      this._ctx = null;
      this._gray = null;
      this.lastSampleMs = 0;
    }

    _ensureCanvas(w, h) {
      if (!this._canvas) {
        this._canvas = document.createElement('canvas');
        this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
      }
      if (this._canvas.width !== w || this._canvas.height !== h) {
        this._canvas.width = w;
        this._canvas.height = h;
      }
      return this._ctx;
    }

    /**
     * @param {HTMLVideoElement|HTMLCanvasElement} source
     * @param {Array<{x,y,score}>} keypoints - COCO-17, source pixel space.
     * @returns {{valid:boolean, reason:string|null, gazeH:number, gazeV:number, detail:object}}
     */
    sample(source, keypoints) {
      const started = (typeof performance !== 'undefined' ? performance.now() : 0);
      const boxes = eyeRoiBoxes(keypoints, this.opt);
      if (boxes.invalid) {
        return { valid: false, reason: boxes.invalid, gazeH: 0, gazeV: 0, detail: {} };
      }

      const srcW = source.videoWidth || source.width;
      const srcH = source.videoHeight || source.height;
      if (!srcW || !srcH) {
        return { valid: false, reason: GAZE_INVALID.NOT_SAMPLED, gazeH: 0, gazeV: 0, detail: {} };
      }

      // Union strip covering both eyes, clamped into the frame.
      const x0 = Math.max(0, Math.min(boxes.left.x, boxes.right.x));
      const y0 = Math.max(0, Math.min(boxes.left.y, boxes.right.y));
      const x1 = Math.min(srcW, Math.max(boxes.left.x + boxes.left.w, boxes.right.x + boxes.right.w));
      const y1 = Math.min(srcH, Math.max(boxes.left.y + boxes.left.h, boxes.right.y + boxes.right.h));
      const stripW = x1 - x0;
      const stripH = y1 - y0;
      if (stripW < 8 || stripH < 4) {
        return { valid: false, reason: GAZE_INVALID.FACE_TOO_SMALL, gazeH: 0, gazeV: 0, detail: {} };
      }

      let rgba;
      try {
        const ctx = this._ensureCanvas(stripW, stripH);
        ctx.drawImage(source, x0, y0, stripW, stripH, 0, 0, stripW, stripH);
        rgba = ctx.getImageData(0, 0, stripW, stripH).data;
      } catch (err) {
        // A tainted or not-yet-ready frame is "no data", never a verdict.
        return { valid: false, reason: GAZE_INVALID.NOT_SAMPLED, gazeH: 0, gazeV: 0, detail: {} };
      }

      this._gray = rgbaToGray(rgba, this._gray);

      const sub = (box) => {
        const bx = Math.max(0, box.x - x0);
        const by = Math.max(0, box.y - y0);
        const bw = Math.min(box.w, stripW - bx);
        const bh = Math.min(box.h, stripH - by);
        if (bw < 3 || bh < 3) return null;
        const out = new Uint8ClampedArray(bw * bh);
        for (let y = 0; y < bh; y++) {
          const src = (by + y) * stripW + bx;
          out.set(this._gray.subarray(src, src + bw), y * bw);
        }
        return { gray: out, w: bw, h: bh };
      };

      const lSub = sub(boxes.left);
      const rSub = sub(boxes.right);
      const lRes = lSub ? analyzeEyeRegion(lSub.gray, lSub.w, lSub.h, this.opt) : null;
      const rRes = rSub ? analyzeEyeRegion(rSub.gray, rSub.w, rSub.h, this.opt) : null;

      const combined = combineEyes(lRes, rRes);
      combined.interocular = boxes.interocular;
      this.lastSampleMs = (typeof performance !== 'undefined' ? performance.now() : 0) - started;
      return combined;
    }

    reset() {
      this.lastSampleMs = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Stateful analyser. One instance per proctoring session.
  // ---------------------------------------------------------------------------

  class GazeAnalyzer {
    constructor(options = {}) {
      this.opt = {
        ...DEFAULT_GAZE_OPTS,
        ...options,
        calibration: { ...DEFAULT_GAZE_CALIBRATION, ...(options.calibration || {}) },
        gate: { ...DEFAULT_GAZE_GATE, ...(options.gate || {}) },
        smoother: { windowMs: 1500, mode: 'median', ...(options.smoother || {}) },
      };

      // Identity converter: the "deg" fields of a PoseDeviation carry normalised
      // eye-box offsets here, not angles. Reported as `offset` downstream so no
      // caller can mistake one for the other.
      this.baseline = new PoseBaseline(this.opt.calibration, (r) => r);
      this.smoother = new TemporalSmoother(this.opt.smoother);
      this.gate = new DwellGate(this.opt.gate);

      this.lastSample = null;
      this.lastDeviation = null;
      this.lastReason = GAZE_INVALID.NOT_SAMPLED;
      this.suppressed = false;
    }

    reset() {
      this.baseline.reset();
      this.smoother.reset();
      this.gate.reset();
      this.lastSample = null;
      this.lastDeviation = null;
      this.lastReason = GAZE_INVALID.NOT_SAMPLED;
      this.suppressed = false;
    }

    /** @returns {boolean} */
    isCalibrated() {
      return this.baseline.isCalibrated();
    }

    /**
     * Advance the analyser by one frame.
     *
     * @param {{valid:boolean, reason:string|null, gazeH:number, gazeV:number}|null} sample
     *        GazeSampler output, or null when gaze was not sampled this frame.
     * @param {{calibrated:boolean, smoothedExcursion:number}|null} poseResult
     *        HeadPoseAnalyzer output, used ONLY to require head-neutrality.
     * @param {number} nowMs
     * @param {boolean} [suppress=false] - Withhold reporting (e.g. a liveness
     *        challenge is on screen, which ORDERS the student to look away).
     * @returns {{
     *   status:string, calibrated:boolean, calibrationProgress:number,
     *   reason:string|null, deviation:object|null, smoothedExcursion:number,
     *   events:Array<object>
     * }}
     */
    process(sample, poseResult, nowMs, suppress = false) {
      this.suppressed = !!suppress;
      const events = [];

      // --- Head must be neutral -------------------------------------------
      // Off-neutral frames belong to AI_CHEATING_POSE. Feeding them here would
      // double-report one student action AND read a rotation-induced iris shift
      // as a gaze shift.
      const headReady = !!(poseResult && poseResult.calibrated);
      const headNeutral = headReady
        && Number.isFinite(poseResult.smoothedExcursion)
        && poseResult.smoothedExcursion < this.opt.maxHeadExcursion;

      let usable = null;  // null = UNKNOWN. Never false-by-default.
      let deviation = null;
      let smoothed = NaN;

      if (!headReady || !headNeutral) {
        this.lastReason = GAZE_INVALID.HEAD_OFF_NEUTRAL;
      } else if (!sample || !sample.valid) {
        // ⚠ THE LOAD-BEARING LINE. A closed eye lands here, contributing an
        // UNKNOWN frame — not a deviant one, and not a compliant one. Because
        // DwellGate needs sustained TRUE, no run of these can ever alert.
        this.lastReason = sample ? sample.reason : GAZE_INVALID.NOT_SAMPLED;
      } else {
        this.lastReason = null;
        this.lastSample = sample;

        // Flip vertical into pitch convention exactly once. See the constant.
        const asPose = {
          yawRatio: sample.gazeH,
          pitchRatio: GAZE_V_TO_PITCH_SIGN * sample.gazeV,
          rollDeg: 0,
        };

        // Suppress drift while an episode is being reported, so a genuine
        // sustained off-screen gaze cannot be absorbed into the neutral — the
        // same guard pose_pipeline.js applies.
        const reporting = this.gate.state === GateState.GLANCE || this.gate.state === GateState.ALERT;
        this.baseline.addSample(asPose, nowMs, !reporting);

        if (this.baseline.isCalibrated()) {
          deviation = this.baseline.deviation(asPose);
          smoothed = this.smoother.push(deviation.excursion, nowMs);
          usable = smoothed >= 1.0;
        }
        this.lastDeviation = deviation;
      }

      const res = this.gate.update(usable, nowMs, Number.isFinite(smoothed) ? smoothed : 0);

      // Suppression is applied at the REPORTING layer only. The gate still runs
      // and still reaches telemetry; only the accusation is withheld. Same
      // arrangement monitor.js uses for LOOK_AWAY during a liveness challenge.
      if (!this.suppressed && (res.event === 'alert' || res.event === 'glance')) {
        events.push({
          condition: GazeCondition.GAZE_OFF_SCREEN,
          // Capped at MEDIUM by design. This signal is coarse — see the
          // limitations in CLAUDE.md — and marginal evidence favours the student.
          severity: res.event === 'alert' ? 'MEDIUM' : 'LOW',
          dwellMs: Math.round(res.dwellMs),
          peak: Number(res.peak.toFixed(3)),
          detail: {
            axis: deviation ? deviation.axis : null,
            direction: deviation ? deviation.direction : null,
            offsetH: deviation ? Number(deviation.yawDev.toFixed(3)) : null,
            offsetV: deviation ? Number(deviation.pitchDev.toFixed(3)) : null,
            excursion: Number.isFinite(smoothed) ? Number(smoothed.toFixed(3)) : null,
            neutral: this.baseline.snapshot().neutral,
            tolerance: this.baseline.snapshot().tolerance,
            head_excursion: poseResult ? Number((poseResult.smoothedExcursion || 0).toFixed(3)) : null,
          },
        });
      }

      return {
        status: this._status(res),
        calibrated: this.baseline.isCalibrated(),
        calibrationProgress: this.baseline.progress(),
        reason: this.lastReason,
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

    /** Compact snapshot for telemetry / the floating widget. */
    snapshot() {
      return {
        calibrated: this.baseline.isCalibrated(),
        progress: this.baseline.progress(),
        baseline: this.baseline.snapshot(),
        gateState: this.gate.state,
        reason: this.lastReason,
        suppressed: this.suppressed,
      };
    }
  }

  return {
    EYE_KP,
    GAZE_INVALID,
    GAZE_V_TO_PITCH_SIGN,
    DEFAULT_GAZE_OPTS,
    DEFAULT_GAZE_CALIBRATION,
    DEFAULT_GAZE_GATE,
    GazeCondition,
    percentile,
    rgbaToGray,
    analyzeEyeRegion,
    eyeRoiBoxes,
    combineEyes,
    GazeSampler,
    GazeAnalyzer,
  };
}));
