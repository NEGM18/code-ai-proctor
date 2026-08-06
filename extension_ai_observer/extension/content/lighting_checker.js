// =============================================================================
// Pre-Exam Lighting Readiness Gate — AI Observer Extension
//
// Every vision detector in this codebase degrades in poor lighting, but none of
// them SAY so — they just get quieter or noisier. gaze_roi.js was withdrawn for
// exactly this reason (CLAUDE.md §7, 2026-08-02 b), and the pose stack silently
// loses keypoint confidence in a dark room. A student can currently start an
// exam backlit by a window and produce low-confidence output for the whole
// session with no signal that the SETUP, not the student, was the problem.
//
// This module samples the webcam at 5 FPS during pre-exam setup, measures
// ITU-R BT.601 luminance, and shows the student a live, actionable message
// telling them what to change.
//
// NO MODEL. Canvas pixel sampling only: one downsampled getImageData per tick.
//
// -----------------------------------------------------------------------------
// ⚠ ADVISORY ONLY. THIS MODULE HAS NO AUTHORITY OVER ANYTHING.
//
// It cannot emit a violation, it has no entry in the CLAUDE.md §6 taxonomy, and
// — as of the hardening pass — it CANNOT BLOCK THE EXAM. There is deliberately
// no predicate in this file that a caller could gate the Start button on:
// `isOptimal()` exists to colour a message, and its doc comment says so.
//
// Both halves of that matter, for different reasons:
//
//   * It must never ACCUSE. The instant a lighting reading can reach an
//     incident report, an unlucky room becomes evidence of misconduct.
//   * It must never BLOCK. `backlitFaceMax: 35` is an ABSOLUTE grey level
//     compared against a SKIN region, and face-crop luminance is a function of
//     skin tone as well as of illumination — a dark-skinned student in a
//     well-lit room can read below 35 where a light-skinned student in the SAME
//     room reads 90. That is the fairness failure that killed gaze_roi.js, and
//     as a launch gate its consequence was DENIAL OF EXAM ACCESS. Advisory
//     removes that failure mode outright rather than tuning around it.
//
// What remains is a suggestion the student is free to ignore, plus a telemetry
// record so a teacher reviewing a poor-quality session can see the room was
// flagged at setup. Two properties still keep the ADVICE itself fair:
//
//   1. HIGH_BACKLIGHT is a RELATIVE test. It requires a dark face AND a bright
//      background, so a uniformly-lit room cannot trigger it at any skin tone.
//      Never relax this to a face-only test — lighting_checker.test.js pins it.
//   2. Low face contrast ALONE never produces a warning. See evaluateLighting().
// =============================================================================

/* global rgbaToGray */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./vision/gaze_roi.js'));
  } else {
    // In the extension gaze_roi.js has already attached to window.
    root.__lightingChecker = factory(root);
    Object.assign(root, root.__lightingChecker);
  }
}(typeof self !== 'undefined' ? self : this, function (gazeRoi) {

  // Luminance is defined ONCE in this codebase. gaze_roi.js:rgbaToGray is
  // already exactly the BT.601 form this gate is specified against
  // (0.299 R + 0.587 G + 0.114 B), so it is imported rather than re-derived —
  // the same rule ear_veto.js follows for eyeAspectRatio. Two definitions of
  // "brightness" that drift apart would be silent and untraceable.
  const { rgbaToGray } = gazeRoi;

  /** The four verdicts. This set is fixed by the gate's contract. */
  const LIGHTING_STATUS = {
    PASS: 'PASS',
    TOO_DARK: 'TOO_DARK',
    OVEREXPOSED: 'OVEREXPOSED',
    HIGH_BACKLIGHT: 'HIGH_BACKLIGHT',
  };

  /**
   * Student-facing copy. Each message names the ACTION that fixes the problem,
   * not the measurement that detected it — "average luminance 31" tells a
   * student nothing they can act on.
   */
  const LIGHTING_MESSAGES = {
    PASS: 'Lighting looks good. You are ready to begin.',
    TOO_DARK: 'Your room is too dark. Please turn on overhead lights.',
    OVEREXPOSED: 'Camera feed is washed out. Avoid bright lights pointing at the lens.',
    HIGH_BACKLIGHT: 'Strong backlight detected behind you. Move your camera away from bright windows.',
    CHECKING: 'Checking your lighting…',
  };

  const LIGHTING_THRESHOLDS = {
    // --- global exposure, on the whole frame -----------------------------
    minLuminance: 40,   // below this the sensor is amplifying noise, not signal
    maxLuminance: 215,  // above this highlights are clipped and detail is gone

    // --- backlight, face vs background -----------------------------------
    // BOTH must hold. See the fairness note in the file header before touching
    // either number, and never drop the background condition.
    backlitFaceMax: 35,
    backlitBgMin: 160,

    // --- silhouette (spec item 1: face std-dev catches backlight shadows) --
    // A face lit only from behind loses internal contrast and collapses toward
    // a flat dark shape. Detecting that needs BOTH a flat face and a
    // substantially brighter background — flatness alone is far more likely to
    // mean "the student has not sat down in front of the oval yet".
    //
    // Reasoned, not measured. Both are deliberately conservative (toward
    // letting a student in) and both need calibration against logged telemetry.
    minFaceStdDev: 12,
    silhouetteDelta: 70,
  };

  /**
   * The face region, as fractions of the frame.
   *
   * ⚠ This box is NOT detected. The gate runs before initVisionEngine(), so
   * pose.onnx is not loaded, and the brief forbids extra model overhead. So the
   * box is geometric, and monitor.js draws an alignment oval over the live
   * preview at EXACTLY these ratios. That turns the box into a contract with
   * the student — "put your face in the oval" — rather than a guess about where
   * their face is, which is the only honest option with zero models.
   *
   * Both the analyser and the oval read this constant. They must never be
   * allowed to drift apart: an oval that disagrees with the sampled rectangle
   * would tell students to align to a region the gate is not measuring.
   *
   * Centre sits slightly above the midline (cy 0.48) because a seated subject's
   * head is above frame centre in a normally-placed webcam.
   */
  const FACE_BOX_RATIOS = { w: 0.38, h: 0.55, cx: 0.50, cy: 0.48 };

  /** Downsample target. Sized for statistics, not for detail — see sampler. */
  const SAMPLE_WIDTH = 128;

  const DEFAULT_CHECKER_OPTS = {
    // 5 FPS, as specified.
    intervalMs: 200,
    // Three consecutive PASS samples (~600 ms) before the advice reads "good",
    // so the message cannot flicker on one noisy frame while a student adjusts
    // a lamp. It gates the WORDING, never the exam.
    requiredStableSamples: 3,
  };

  // ---------------------------------------------------------------------------
  // Pure pixel statistics. No canvas, no DOM — everything below runs under Node,
  // which is what lets the threshold logic be tested as exact arithmetic.
  // ---------------------------------------------------------------------------

  /**
   * Clamp a rectangle into the frame.
   * @returns {{x:number,y:number,w:number,h:number}}
   */
  function clampBox(box, w, h) {
    const x = Math.max(0, Math.min(w, Math.round(box.x)));
    const y = Math.max(0, Math.min(h, Math.round(box.y)));
    const x1 = Math.max(x, Math.min(w, Math.round(box.x + box.w)));
    const y1 = Math.max(y, Math.min(h, Math.round(box.y + box.h)));
    return { x, y, w: x1 - x, h: y1 - y };
  }

  /**
   * Face rectangle in pixel space for a frame of the given size.
   * @param {number} w
   * @param {number} h
   * @returns {{x:number,y:number,w:number,h:number}}
   */
  function faceBoxFor(w, h) {
    const bw = w * FACE_BOX_RATIOS.w;
    const bh = h * FACE_BOX_RATIOS.h;
    return clampBox({
      x: w * FACE_BOX_RATIOS.cx - bw / 2,
      y: h * FACE_BOX_RATIOS.cy - bh / 2,
      w: bw,
      h: bh,
    }, w, h);
  }

  /**
   * Mean and standard deviation of luma over a rectangle, in one pass.
   *
   * `sum` and `sumSq` are returned as well as the derived statistics so that
   * frameStats() can obtain the BACKGROUND by subtracting the face region from
   * the whole frame, rather than walking the image a second time with an
   * inside/outside branch on every pixel.
   *
   * @param {Uint8ClampedArray|Uint8Array|number[]} gray - w*h luma, row-major.
   * @param {number} w
   * @param {number} h
   * @param {{x:number,y:number,w:number,h:number}} [box] - defaults to the frame.
   * @returns {{mean:number, stdDev:number, count:number, sum:number, sumSq:number}}
   */
  function regionStats(gray, w, h, box) {
    const b = box ? clampBox(box, w, h) : { x: 0, y: 0, w, h };
    let sum = 0;
    let sumSq = 0;
    let count = 0;

    if (gray && b.w > 0 && b.h > 0 && gray.length >= w * h) {
      for (let y = b.y; y < b.y + b.h; y++) {
        const row = y * w;
        for (let x = b.x; x < b.x + b.w; x++) {
          const v = gray[row + x];
          sum += v;
          sumSq += v * v;
          count++;
        }
      }
    }

    if (count === 0) {
      // An empty region has no brightness. Reporting 0 would read as "very
      // dark" and could lock a student out on a degenerate frame, so callers
      // must check `count` — evaluateLighting treats absent stats as UNKNOWN.
      return { mean: NaN, stdDev: NaN, count: 0, sum: 0, sumSq: 0 };
    }

    const mean = sum / count;
    // Values are 0-255 in doubles, so the computational form is numerically
    // safe here. max(0, …) guards the last ulp on a perfectly uniform region.
    const variance = Math.max(0, sumSq / count - mean * mean);
    return { mean, stdDev: Math.sqrt(variance), count, sum, sumSq };
  }

  /**
   * Split a frame into whole / face / background statistics.
   *
   * The background is derived by subtraction, so the image is walked once in
   * full plus once over the face box, never with a per-pixel region test.
   *
   * @param {Uint8ClampedArray|Uint8Array|number[]} gray
   * @param {number} w
   * @param {number} h
   * @returns {{avgLuminance:number, faceLuminance:number, bgLuminance:number,
   *            faceStdDev:number, bgStdDev:number, faceBox:object}}
   */
  function frameStats(gray, w, h) {
    const faceBox = faceBoxFor(w, h);
    const all = regionStats(gray, w, h);
    const face = regionStats(gray, w, h, faceBox);

    const bgCount = all.count - face.count;
    let bgMean = NaN;
    let bgStdDev = NaN;
    if (bgCount > 0) {
      const bgSum = all.sum - face.sum;
      const bgSumSq = all.sumSq - face.sumSq;
      bgMean = bgSum / bgCount;
      bgStdDev = Math.sqrt(Math.max(0, bgSumSq / bgCount - bgMean * bgMean));
    }

    return {
      avgLuminance: all.mean,
      faceLuminance: face.mean,
      bgLuminance: bgMean,
      faceStdDev: face.stdDev,
      bgStdDev,
      faceBox,
    };
  }

  /**
   * Turn frame statistics into a verdict. PURE — this is the function the unit
   * tests target, and it is the whole of the gate's decision logic.
   *
   * Order is first-match-wins and it is deliberate:
   *
   *   avg < 40                              -> TOO_DARK
   *   avg > 215                             -> OVEREXPOSED
   *   face < 35 AND bg > 160                -> HIGH_BACKLIGHT
   *   (bg - face) > 70 AND faceStdDev < 12  -> HIGH_BACKLIGHT   (silhouette)
   *   otherwise                             -> PASS
   *
   * Global exposure is settled first because it is the more fundamental fault:
   * in a frame that is uniformly black, the face/background comparison is
   * measuring sensor noise and its answer means nothing.
   *
   * ⚠ UNREADABLE ≠ FAILING. A flat face crop at normal luminance returns PASS.
   * The most likely cause is that the student has not aligned to the oval yet,
   * and "we cannot see a face" is not a lighting fault — the same rule CLAUDE.md
   * §5 states for detectors, applied to a gate. Blocking on it would lock out a
   * student for sitting slightly off-centre, and the in-exam pose pipeline
   * already reports an absent face on its own evidence.
   *
   * @param {{avgLuminance:number, faceLuminance:number, bgLuminance:number,
   *          faceStdDev:number}} stats
   * @returns {{status:string, userMessage:string, detail:object}}
   */
  function evaluateLighting(stats) {
    const t = LIGHTING_THRESHOLDS;
    const s = stats || {};
    const avg = s.avgLuminance;
    const face = s.faceLuminance;
    const bg = s.bgLuminance;
    const faceStdDev = s.faceStdDev;

    const verdict = (status, reason) => ({
      status,
      userMessage: LIGHTING_MESSAGES[status],
      detail: {
        reason,
        avgLuminance: round1(avg),
        faceLuminance: round1(face),
        bgLuminance: round1(bg),
        faceStdDev: round1(faceStdDev),
      },
    });

    // No usable measurement at all. Fail toward PASS on the verdict, because a
    // broken measurement is not evidence of a badly lit room — but note that
    // LightingChecker still refuses to unlock the button until it has counted
    // real consecutive samples, so an unmeasurable feed cannot start an exam.
    if (!Number.isFinite(avg)) return verdict(LIGHTING_STATUS.PASS, 'no_measurement');

    if (avg < t.minLuminance) return verdict(LIGHTING_STATUS.TOO_DARK, 'global_dark');
    if (avg > t.maxLuminance) return verdict(LIGHTING_STATUS.OVEREXPOSED, 'global_bright');

    const haveRegions = Number.isFinite(face) && Number.isFinite(bg);
    if (haveRegions) {
      // The specified backlight test. RELATIVE by construction: it needs a dark
      // face AND a bright background, so an evenly-lit room cannot trigger it
      // at any skin tone. Never reduce this to the face condition alone.
      if (face < t.backlitFaceMax && bg > t.backlitBgMin) {
        return verdict(LIGHTING_STATUS.HIGH_BACKLIGHT, 'face_dark_bg_bright');
      }

      // Silhouette: a face lit only from behind goes both darker than its
      // surroundings AND internally flat. Requiring both keeps an unoccupied
      // oval (flat, but not darker than the room) out of this branch.
      if (Number.isFinite(faceStdDev)
        && (bg - face) > t.silhouetteDelta
        && faceStdDev < t.minFaceStdDev) {
        return verdict(LIGHTING_STATUS.HIGH_BACKLIGHT, 'silhouette');
      }
    }

    return verdict(LIGHTING_STATUS.PASS, 'ok');
  }

  function round1(v) {
    return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
  }

  // ---------------------------------------------------------------------------
  // Browser-side sampler. The only part that needs a canvas.
  // ---------------------------------------------------------------------------

  /**
   * Reads one downsampled frame and returns its statistics.
   *
   * Downsampling to ~128px wide is safe here in a way it would not be for the
   * eye ROI: every quantity this gate computes is a mean or a standard
   * deviation over a large region, and resampling does not meaningfully move
   * either. It makes the getImageData readback — the expensive operation in any
   * per-frame path, per CLAUDE.md — negligible at 5 FPS.
   *
   * Source aspect ratio is PRESERVED. The face box is expressed in ratios, so a
   * squashed sample would still produce a box, but it would cover a different
   * real-world region than the alignment oval drawn over the (object-fit)
   * video element — telling the student to align to something we do not measure.
   */
  class LightingSampler {
    constructor(options = {}) {
      this.targetWidth = options.targetWidth || SAMPLE_WIDTH;
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
     * @returns {object|null} frameStats output, or null if the frame is unreadable.
     */
    sample(source) {
      const started = (typeof performance !== 'undefined' ? performance.now() : 0);
      const srcW = (source && (source.videoWidth || source.width)) || 0;
      const srcH = (source && (source.videoHeight || source.height)) || 0;
      if (!srcW || !srcH) return null;

      const w = Math.min(this.targetWidth, srcW);
      const h = Math.max(1, Math.round(w * (srcH / srcW)));

      let rgba;
      try {
        const ctx = this._ensureCanvas(w, h);
        ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, w, h);
        rgba = ctx.getImageData(0, 0, w, h).data;
      } catch (err) {
        // A tainted or not-yet-ready frame is "no data", never a verdict.
        return null;
      }

      this._gray = rgbaToGray(rgba, this._gray);
      const stats = frameStats(this._gray, w, h);
      stats.sampleWidth = w;
      stats.sampleHeight = h;
      this.lastSampleMs = (typeof performance !== 'undefined' ? performance.now() : 0) - started;
      return stats;
    }

    reset() {
      this.lastSampleMs = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // The gate itself. One instance per pre-exam setup stage.
  // ---------------------------------------------------------------------------

  class LightingChecker {
    /**
     * @param {object} [options]
     * @param {number} [options.intervalMs=200] - 5 FPS.
     * @param {number} [options.requiredStableSamples=3]
     * @param {function} [options.onUpdate] - called with checkLightingStatus().
     * @param {object}  [options.sampler] - injectable for tests.
     */
    constructor(options = {}) {
      this.opt = { ...DEFAULT_CHECKER_OPTS, ...options };
      this.sampler = options.sampler || null;
      this.onUpdate = options.onUpdate || null;

      this.source = null;
      this._timer = null;
      this._last = null;
      this._lastStats = null;
      this.stableCount = 0;
      this.sampleCount = 0;
      this.statusCounts = {
        PASS: 0, TOO_DARK: 0, OVEREXPOSED: 0, HIGH_BACKLIGHT: 0,
      };
    }

    /**
     * Begin sampling. Idempotent — calling twice does not start two loops.
     * @param {HTMLVideoElement} source
     */
    start(source) {
      this.stop();
      this.source = source;
      if (!this.sampler) this.sampler = new LightingSampler();
      // Sample immediately so the student sees a reading rather than a blank
      // panel for the first 200 ms, then settle into the 5 FPS cadence.
      this.tick();
      this._timer = setInterval(() => this.tick(), this.opt.intervalMs);
    }

    /** Stop sampling. Safe to call when never started. */
    stop() {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
      this.source = null;
    }

    /** Clear all accumulated state, keeping the instance reusable. */
    reset() {
      this.stop();
      this._last = null;
      this._lastStats = null;
      this.stableCount = 0;
      this.sampleCount = 0;
      this.statusCounts = {
        PASS: 0, TOO_DARK: 0, OVEREXPOSED: 0, HIGH_BACKLIGHT: 0,
      };
      if (this.sampler && this.sampler.reset) this.sampler.reset();
    }

    /**
     * One sampling step. Public so tests can drive the state machine without a
     * timer, and so a caller can force a reading on demand.
     * @param {object} [injectedStats] - bypass the sampler (tests).
     */
    tick(injectedStats) {
      const stats = injectedStats !== undefined
        ? injectedStats
        : (this.source && this.sampler ? this.sampler.sample(this.source) : null);

      if (!stats) {
        // An unreadable frame does not advance the stability run and does not
        // reset it either — it is simply not evidence in either direction.
        // Without a reading we cannot say the room is bad, and we must not say
        // it is good, so the previous advice stands untouched.
        if (this.onUpdate) this.onUpdate(this.advisory());
        return this.advisory();
      }

      const result = evaluateLighting(stats);
      this._lastStats = stats;
      this._last = result;
      this.sampleCount++;
      if (this.statusCounts[result.status] !== undefined) this.statusCounts[result.status]++;

      if (result.status === LIGHTING_STATUS.PASS) this.stableCount++;
      else this.stableCount = 0;   // one bad sample restarts the run

      const out = this.advisory();
      if (this.onUpdate) this.onUpdate(out);
      return out;
    }

    /**
     * The current advice. ADVISORY — nothing here authorises blocking anything.
     *
     * @returns {{status:string, userMessage:string, sampled:boolean,
     *            optimal:boolean, detail:object}}
     */
    advisory() {
      if (!this._last) {
        return {
          status: LIGHTING_STATUS.PASS,
          userMessage: LIGHTING_MESSAGES.CHECKING,
          sampled: false,
          optimal: false,
          detail: {
            reason: 'not_sampled',
            avgLuminance: null,
            faceLuminance: null,
            bgLuminance: null,
            faceStdDev: null,
            stableCount: 0,
          },
        };
      }

      return {
        status: this._last.status,
        userMessage: this._last.userMessage,
        sampled: true,
        optimal: this.isOptimal(),
        detail: { ...this._last.detail, stableCount: this.stableCount },
      };
    }

    /** The name the spec uses. Same object; one implementation. */
    checkLightingStatus() {
      return this.advisory();
    }

    /**
     * ⚠ COSMETIC ONLY — this decides whether the message is green or amber.
     *
     * It is NOT a launch gate and there is no launch gate in this file. Do not
     * wire it (or `status === 'PASS'`) to a disabled button, a guard clause, or
     * anything else that can stop a student sitting their exam. The thresholds
     * this rests on are absolute grey levels measured on skin; see the header.
     *
     * The stability run exists so the message does not flicker while a student
     * adjusts a lamp, nothing more.
     * @returns {boolean}
     */
    isOptimal() {
      return this.sampleCount > 0
        && this.stableCount >= this.opt.requiredStableSamples;
    }

    /** Compact snapshot for telemetry and the console. */
    telemetry() {
      return {
        samples: this.sampleCount,
        stableCount: this.stableCount,
        optimal: this.isOptimal(),
        required: this.opt.requiredStableSamples,
        statusCounts: { ...this.statusCounts },
        running: this._timer !== null,
        lastStatus: this._last ? this._last.status : null,
        lastDetail: this._last ? this._last.detail : null,
        sampleMs: this.sampler ? this.sampler.lastSampleMs : 0,
        sampleSize: this._lastStats
          ? { w: this._lastStats.sampleWidth, h: this._lastStats.sampleHeight }
          : null,
      };
    }
  }

  return {
    LIGHTING_STATUS,
    LIGHTING_MESSAGES,
    LIGHTING_THRESHOLDS,
    FACE_BOX_RATIOS,
    SAMPLE_WIDTH,
    DEFAULT_CHECKER_OPTS,
    clampBox,
    faceBoxFor,
    regionStats,
    frameStats,
    evaluateLighting,
    LightingSampler,
    LightingChecker,
  };
}));
