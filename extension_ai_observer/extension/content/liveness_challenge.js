// =============================================================================
// Active Liveness Challenge — AI Observer Extension
//
// Catches the spoof the rest of the pipeline cannot: a PHOTOGRAPH (or a looped
// clip, or a paused virtual camera) held in front of the webcam. Everything
// else in this codebase asks "where is the head pointing?" — a printed photo
// answers that question perfectly and consistently forever.
//
// So this module asks a question a photo cannot answer: it puts a dot in an
// extreme corner of the screen and checks whether the head actually pivots
// toward it.
//
//   FROZEN  -> head pose peak-to-peak < 1.0 deg for > 45 s  (nothing human is
//              this still; see FrozenPoseMonitor)
//   PROMPT  -> a pulsing dot at ONE of the 4 screen corners, never the centre
//   VERIFY  -> 3.5 s window; yaw AND pitch must shift toward that corner
//
// ZERO extra inference. It consumes the yaw/pitch the pose pipeline already
// produces every frame and draws one DOM element. No model is touched.
//
// -----------------------------------------------------------------------------
// SIGN CONVENTION — READ THIS BEFORE CHANGING ANY THRESHOLD
// -----------------------------------------------------------------------------
// pose_geometry.js emits yaw that is IMAGE-relative, not student-relative:
//
//     "positive means the nose moved toward the right of the frame [...]
//      It is the subject's own left."
//
// getUserMedia delivers UNMIRRORED frames (pose_geometry relies on this: it
// notes LEFT_EYE sits at the larger x). So for a student sitting in front of an
// unmirrored camera:
//
//     dot at the SCREEN's left edge
//       -> student turns toward THEIR OWN left
//       -> nose moves toward the RIGHT of the camera image
//       -> yawDeg is POSITIVE
//
// A naive reading of "TOP-LEFT means yaw < -12" therefore tests the exact
// opposite of compliance: the student does precisely what was asked and gets
// flagged for spoofing. In a system whose entire design history is about not
// falsely accusing students, that is the worst possible bug, so the mapping is
// an explicit named constant with a test pinning it — see SCREEN_LEFT_YAW_SIGN
// and `mirrored` below.
//
// If a deployment ever feeds MIRRORED frames to the pose model, set
// `mirrored: true` and every corner flips coherently. Do not patch individual
// thresholds.
//
// PITCH: pose_geometry's pitchRatio is the nose's drop below the eye line, which
// SHRINKS as the head tilts down. pose_calibration reads that out as
// `pitchDev < 0 -> 'down'`. So pitchDeg > 0 is UP and pitchDeg < 0 is DOWN, and
// unlike yaw this needs no mirroring — vertical is vertical in both frames.
// =============================================================================

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.__livenessChallenge = factory();
    Object.assign(root, root.__livenessChallenge);
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // ---------------------------------------------------------------------------
  // Corner definitions — the ONLY four positions a target may occupy.
  // ---------------------------------------------------------------------------

  /**
   * +1 because an unmirrored camera image is left-right flipped relative to the
   * student. Looking at the SCREEN's left corner produces POSITIVE image yaw.
   * See the header block; this is the single place the flip is encoded.
   */
  const SCREEN_LEFT_YAW_SIGN = +1;

  /** Screen-space direction each corner demands of the head. */
  const CORNER_DIRECTIONS = {
    'TOP-LEFT':     { horizontal: 'left',  vertical: 'up' },
    'TOP-RIGHT':    { horizontal: 'right', vertical: 'up' },
    'BOTTOM-LEFT':  { horizontal: 'left',  vertical: 'down' },
    'BOTTOM-RIGHT': { horizontal: 'right', vertical: 'down' },
  };

  /**
   * CSS placement per corner. 20 px inset with a 40 px dot, so the far corners
   * land at calc(100vw - 60px) / calc(100vh - 60px).
   *
   * These are EXTREME corners on purpose. A target anywhere near the centre sits
   * inside the reading area and can be satisfied with a flick of the eyes, which
   * the pose model cannot see — the whole point is to force a head pivot that
   * shows up in yaw AND pitch simultaneously.
   */
  const CORNER_POSITIONS = {
    'TOP-LEFT':     { left: '20px',               top: '20px',               labelSide: 'right' },
    'TOP-RIGHT':    { left: 'calc(100vw - 60px)', top: '20px',               labelSide: 'left'  },
    'BOTTOM-LEFT':  { left: '20px',               top: 'calc(100vh - 60px)', labelSide: 'right' },
    'BOTTOM-RIGHT': { left: 'calc(100vw - 60px)', top: 'calc(100vh - 60px)', labelSide: 'left'  },
  };

  /** The allow-list. Anything not in here is not a legal target. */
  const CORNER_KEYS = Object.keys(CORNER_DIRECTIONS);

  const DOT_SIZE_PX = 40;
  const CORNER_INSET_PX = 20;

  /**
   * Reject any target that is not one of the four extreme corners.
   *
   * This exists as a runtime guard rather than a comment because "just put it
   * somewhere visible" is the natural thing for a future change to do, and a
   * centred target silently degrades the challenge into something a static photo
   * plus eye movement can pass.
   *
   * @param {string} corner
   * @returns {string} The validated corner key.
   * @throws {Error} If the corner is not one of the four.
   */
  function assertCornerOnly(corner) {
    if (CORNER_KEYS.indexOf(corner) === -1) {
      throw new Error(
        `[Liveness] Illegal target "${corner}". Only extreme corners are permitted: ${CORNER_KEYS.join(', ')}. ` +
        'Centre and mid-edge targets are forbidden — they can be satisfied without a head pivot.'
      );
    }
    return corner;
  }

  // ---------------------------------------------------------------------------
  // Frozen pose monitor
  // ---------------------------------------------------------------------------

  const DEFAULT_FROZEN_OPTS = {
    /** Rolling window length. The spec's 45-60 s band; 60 s is the outer edge. */
    windowMs: 60000,
    /** Streak that must be covered before "frozen" can be declared. */
    minDurationMs: 45000,
    /** Peak-to-peak yaw movement below which the head counts as static. */
    maxYawRangeDeg: 1.0,
    /** Same for pitch. Both axes must be static — a nod is still life. */
    maxPitchRangeDeg: 1.0,
    /**
     * Guard against declaring "frozen" off a handful of samples. At Tier B's
     * ~9 FPS, 45 s is ~400 frames; 60 is a floor that only bites if the loop has
     * collapsed, in which case we have no business making this call.
     */
    minSamples: 60,
    /**
     * A gap longer than this means we stopped observing (tab throttled, face
     * lost, inference stalled). Continuity across it is unproven, so the streak
     * restarts — the same reasoning as DwellGate.maxSampleGapMs.
     */
    maxSampleGapMs: 3000,
  };

  /**
   * Rolling peak-to-peak monitor over head yaw/pitch.
   *
   * PEAK-TO-PEAK, not statistical variance. The threshold is expressed as
   * "abs(Yaw_change) < 1.0 degree", which is a range statement; variance in
   * deg^2 is not comparable to it and would need an arbitrary conversion. Range
   * is also strictly more conservative: one real movement anywhere in the window
   * clears the buffer's range immediately, where it would barely move a variance
   * computed over 400 samples. Variance is still computed and exposed for
   * telemetry, it just does not gate.
   *
   * Only frames with a READABLE, CALIBRATED pose are admitted. A frame where the
   * face could not be resolved is not evidence of stillness — treating it as
   * such would let a student build a "frozen" streak by covering the camera,
   * which is a different violation entirely (NO_FACE_DETECTED).
   */
  class FrozenPoseMonitor {
    constructor(options = {}) {
      this.opt = { ...DEFAULT_FROZEN_OPTS, ...options };
      this.reset();
    }

    reset() {
      /** @type {Array<{yaw:number, pitch:number, t:number}>} */
      this._buf = [];
      this._lastSampleMs = null;
    }

    /**
     * Admit one frame.
     *
     * @param {number|null} yawDeg - Deviation from the student's calibrated
     *   neutral, in approximate degrees. Pass null when the pose was unusable.
     * @param {number|null} pitchDeg
     * @param {number} nowMs
     * @returns {{frozen:boolean, spanMs:number, yawRange:number, pitchRange:number,
     *            samples:number, yawVariance:number, pitchVariance:number}}
     */
    update(yawDeg, pitchDeg, nowMs) {
      const usable = Number.isFinite(yawDeg) && Number.isFinite(pitchDeg);

      // An unobserved gap breaks continuity — we cannot claim 45 s of stillness
      // across a stretch we did not watch.
      if (this._lastSampleMs !== null && (nowMs - this._lastSampleMs) > this.opt.maxSampleGapMs) {
        this._buf = [];
      }

      if (!usable) {
        // Do NOT stamp _lastSampleMs here: a long run of unreadable frames must
        // register as a gap, not as continuous observation.
        return this._snapshot();
      }

      this._lastSampleMs = nowMs;
      this._buf.push({ yaw: yawDeg, pitch: pitchDeg, t: nowMs });

      const cutoff = nowMs - this.opt.windowMs;
      while (this._buf.length && this._buf[0].t < cutoff) this._buf.shift();

      return this._snapshot();
    }

    /** Current window statistics and the frozen verdict. */
    _snapshot() {
      const n = this._buf.length;
      if (n === 0) {
        return {
          frozen: false, spanMs: 0, yawRange: 0, pitchRange: 0,
          samples: 0, yawVariance: 0, pitchVariance: 0,
        };
      }

      let yMin = Infinity, yMax = -Infinity, pMin = Infinity, pMax = -Infinity;
      let ySum = 0, pSum = 0;
      for (const s of this._buf) {
        if (s.yaw < yMin) yMin = s.yaw;
        if (s.yaw > yMax) yMax = s.yaw;
        if (s.pitch < pMin) pMin = s.pitch;
        if (s.pitch > pMax) pMax = s.pitch;
        ySum += s.yaw;
        pSum += s.pitch;
      }

      const yMean = ySum / n;
      const pMean = pSum / n;
      let yVar = 0;
      let pVar = 0;
      for (const s of this._buf) {
        yVar += (s.yaw - yMean) * (s.yaw - yMean);
        pVar += (s.pitch - pMean) * (s.pitch - pMean);
      }

      const spanMs = this._buf[n - 1].t - this._buf[0].t;
      const yawRange = yMax - yMin;
      const pitchRange = pMax - pMin;

      const frozen = n >= this.opt.minSamples
        && spanMs >= this.opt.minDurationMs
        && yawRange < this.opt.maxYawRangeDeg
        && pitchRange < this.opt.maxPitchRangeDeg;

      return {
        frozen,
        spanMs,
        yawRange,
        pitchRange,
        samples: n,
        yawVariance: yVar / n,
        pitchVariance: pVar / n,
      };
    }

    /** Current statistics without admitting a sample. */
    stats() {
      return this._snapshot();
    }
  }

  // ---------------------------------------------------------------------------
  // Tier 1 — passive synthetic-frame suspicion
  // ---------------------------------------------------------------------------

  const DEFAULT_SYNTHETIC_OPTS = {
    /**
     * Mean absolute per-channel pixel delta at or below which two consecutive
     * frames count as IDENTICAL. Zero by default: exact buffer equality.
     */
    maxDelta: 0.0,
    /** Consecutive identical frames required before suspicion is raised. */
    minFrames: 30,
    /**
     * ...and the wall-clock floor on the same streak. BOTH apply, for the same
     * reason as the phone latch: 30 frames is 1.5 s on a Tier A GPU but 3.3 s on
     * a Tier B laptop, and a frame count alone is not a duration.
     */
    minDurationMs: 1000,
    /** A longer gap means we stopped observing; the streak cannot span it. */
    maxSampleGapMs: 3000,
  };

  /**
   * Watches frame-to-frame pixel delta for a feed that has stopped changing.
   *
   * SUSPICION ONLY — this must never raise a violation by itself, and the
   * manager deliberately gives it no route to one.
   *
   * A physical sensor produces photon noise, so a real camera pointed at a
   * perfectly still subject still varies pixel to pixel. But plenty of benign
   * software sits between that sensor and this canvas and destroys the
   * evidence: webcam 3D noise reduction, frame duplication in a low-spec
   * decoder, and VM/RDP display drivers all re-emit an identical buffer when
   * the scene is static. Treating zero delta as proof of a synthetic feed would
   * falsely accuse students on ordinary hardware.
   *
   * So zero delta only earns the student an active challenge. A frozen driver
   * clears it the moment its owner looks at the dot; a photograph or an injected
   * still cannot.
   */
  class SyntheticFrameMonitor {
    constructor(options = {}) {
      this.opt = { ...DEFAULT_SYNTHETIC_OPTS, ...options };
      this.reset();
    }

    reset() {
      this._frames = 0;
      this._streakStartMs = null;
      this._lastSampleMs = null;
      this.lastDelta = null;
    }

    /**
     * Admit one frame's delta.
     *
     * @param {number|null} delta - Mean absolute pixel delta against the
     *   previous frame. null when it could not be measured (no frame yet).
     * @param {number} nowMs
     * @returns {{suspected:boolean, frames:number, durationMs:number, delta:number|null}}
     */
    update(delta, nowMs) {
      if (this._lastSampleMs !== null && (nowMs - this._lastSampleMs) > this.opt.maxSampleGapMs) {
        this._frames = 0;
        this._streakStartMs = null;
      }
      this._lastSampleMs = nowMs;
      this.lastDelta = delta;

      if (delta === null || delta > this.opt.maxDelta) {
        // The feed is alive. Suspicion evaporates immediately — it is not a
        // score to be accumulated across a session.
        this._frames = 0;
        this._streakStartMs = null;
        return this._snapshot(nowMs);
      }

      if (this._streakStartMs === null) this._streakStartMs = nowMs;
      this._frames++;
      return this._snapshot(nowMs);
    }

    _snapshot(nowMs) {
      const durationMs = this._streakStartMs === null ? 0 : nowMs - this._streakStartMs;
      return {
        suspected: this._frames >= this.opt.minFrames && durationMs >= this.opt.minDurationMs,
        frames: this._frames,
        durationMs,
        delta: this.lastDelta,
      };
    }

    /** @returns {object} Current state without admitting a frame. */
    stats() {
      return this._snapshot(this._lastSampleMs === null ? 0 : this._lastSampleMs);
    }
  }

  // ---------------------------------------------------------------------------
  // Corner response validation
  // ---------------------------------------------------------------------------

  const DEFAULT_RESPONSE_OPTS = {
    /** Yaw magnitude, in degrees of deviation from neutral. The spec's 12. */
    yawThresholdDeg: 12,
    /**
     * Pitch magnitude. Deliberately LOWER than yaw.
     *
     * The spec gives a number for yaw and only a direction for pitch. They are
     * not interchangeable: the nose-below-eye-line cue compresses hard on the
     * vertical axis, so a head pivot that easily clears 12 deg of yaw typically
     * produces well under 12 deg of pitch. Demanding symmetric thresholds would
     * make the top corners physically unreachable for most students and convert
     * honest compliance into a CRITICAL spoofing flag.
     */
    pitchThresholdDeg: 6,
    /**
     * Set true only if the frames reaching the pose model are mirrored. Flips
     * the horizontal expectation for all four corners at once.
     */
    mirrored: false,
  };

  /**
   * Does this single pose sample point at the requested corner?
   *
   * Pure — no clock, no DOM, no state — so the mapping that decides whether a
   * student is accused of spoofing is verifiable in a unit test.
   *
   * @param {string} corner - One of CORNER_KEYS.
   * @param {number} yawDeg - Deviation from calibrated neutral (image-relative).
   * @param {number} pitchDeg - Deviation from calibrated neutral (+up / -down).
   * @param {object} [options] - Overrides for DEFAULT_RESPONSE_OPTS.
   * @returns {{pass:boolean, yawOk:boolean, pitchOk:boolean, expectedYawSign:number,
   *            expectedPitchSign:number, yawDeg:number, pitchDeg:number}}
   */
  function evaluateCornerResponse(corner, yawDeg, pitchDeg, options = {}) {
    const opt = { ...DEFAULT_RESPONSE_OPTS, ...options };
    assertCornerOnly(corner);

    const dir = CORNER_DIRECTIONS[corner];

    // Screen-left demands positive image yaw on an unmirrored feed; mirroring
    // the feed inverts that, and nothing else.
    const flip = opt.mirrored ? -1 : 1;
    const expectedYawSign = (dir.horizontal === 'left' ? SCREEN_LEFT_YAW_SIGN : -SCREEN_LEFT_YAW_SIGN) * flip;
    const expectedPitchSign = dir.vertical === 'up' ? +1 : -1;

    const y = Number.isFinite(yawDeg) ? yawDeg : 0;
    const p = Number.isFinite(pitchDeg) ? pitchDeg : 0;

    const yawOk = (y * expectedYawSign) >= opt.yawThresholdDeg;
    const pitchOk = (p * expectedPitchSign) >= opt.pitchThresholdDeg;

    return {
      pass: yawOk && pitchOk,
      yawOk,
      pitchOk,
      expectedYawSign,
      expectedPitchSign,
      yawDeg: y,
      pitchDeg: p,
    };
  }

  // ---------------------------------------------------------------------------
  // Overlay renderer
  // ---------------------------------------------------------------------------

  const OVERLAY_ID = 'ai-proctor-liveness-target';
  const KEYFRAMES_ID = 'ai-proctor-liveness-keyframes';

  /**
   * Draws the corner target.
   *
   * Split out from the manager so the decision logic can be tested headless, and
   * so a host that wants a different visual (or none) can swap it wholesale.
   *
   * position:fixed keeps the dot anchored to the viewport, which is what makes
   * it work inside the exam's fullscreen element WITHOUT leaving fullscreen.
   * pointer-events:none means it can never intercept a click on the exam
   * underneath, and cannot be dismissed by clicking it.
   */
  class CornerTargetRenderer {
    constructor(doc) {
      this.doc = doc || (typeof document !== 'undefined' ? document : null);
    }

    /**
     * @param {string} corner
     * @param {string} [prompt]
     * @returns {object|null} The injected element, or null when headless.
     */
    show(corner, prompt) {
      if (!this.doc || !this.doc.body) return null;
      assertCornerOnly(corner);
      this.hide();
      this._injectKeyframes();

      const pos = CORNER_POSITIONS[corner];

      const wrap = this.doc.createElement('div');
      wrap.id = OVERLAY_ID;
      wrap.setAttribute('data-corner', corner);
      Object.assign(wrap.style, {
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        width: `${DOT_SIZE_PX}px`,
        height: `${DOT_SIZE_PX}px`,
        zIndex: '2147483645', // under the consent gate + widget, over the exam
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      });

      const dot = this.doc.createElement('div');
      Object.assign(dot.style, {
        width: `${DOT_SIZE_PX}px`,
        height: `${DOT_SIZE_PX}px`,
        borderRadius: '50%',
        background: 'radial-gradient(circle at 35% 35%, #b9ffe5, #00ffc3 45%, #00b894 100%)',
        boxShadow: '0 0 12px #00ffc3, 0 0 28px #00ffc3, 0 0 54px rgba(0,255,195,0.65)',
        animation: 'ai-liveness-pulse 0.9s ease-in-out infinite',
      });

      const label = this.doc.createElement('div');
      label.textContent = prompt || 'Quick Check: Look at the dot!';
      const labelStyle = {
        position: 'absolute',
        top: '50%',
        transform: 'translateY(-50%)',
        whiteSpace: 'nowrap',
        fontFamily: "'Inter', 'Outfit', system-ui, sans-serif",
        fontSize: '13px',
        fontWeight: '800',
        letterSpacing: '0.2px',
        color: '#062b22',
        background: '#00ffc3',
        padding: '6px 12px',
        borderRadius: '8px',
        boxShadow: '0 4px 18px rgba(0,255,195,0.45)',
      };
      // Anchored on the INWARD side so the text never runs off-screen at the far
      // corners. The dot itself stays pinned to the extreme either way.
      labelStyle[pos.labelSide === 'right' ? 'left' : 'right'] = `${DOT_SIZE_PX + 12}px`;
      Object.assign(label.style, labelStyle);

      wrap.appendChild(dot);
      wrap.appendChild(label);
      this.doc.body.appendChild(wrap);
      return wrap;
    }

    hide() {
      if (!this.doc || !this.doc.getElementById) return;
      const existing = this.doc.getElementById(OVERLAY_ID);
      if (existing && existing.remove) existing.remove();
    }

    _injectKeyframes() {
      if (!this.doc || !this.doc.head || this.doc.getElementById(KEYFRAMES_ID)) return;
      const style = this.doc.createElement('style');
      style.id = KEYFRAMES_ID;
      style.textContent = `
        @keyframes ai-liveness-pulse {
          0%, 100% { transform: scale(1);    opacity: 1;    }
          50%      { transform: scale(1.35); opacity: 0.55; }
        }
      `;
      this.doc.head.appendChild(style);
    }
  }

  // ---------------------------------------------------------------------------
  // Manager
  // ---------------------------------------------------------------------------

  /** @enum {string} */
  const LivenessState = {
    MONITORING: 'monitoring',   // Watching for a frozen pose.
    CHALLENGE: 'challenge',     // Dot is up, response window open.
    COOLDOWN: 'cooldown',       // Recently resolved; not re-challenging yet.
  };

  /** @enum {string} */
  const LivenessOutcome = {
    PASSED: 'passed',
    FAILED: 'failed',
    INCONCLUSIVE: 'inconclusive',
  };

  /** What caused a challenge to be issued. Rides on every challenge event. */
  const LivenessTrigger = {
    /** Tier 0: head pose unnaturally static for 45 s+. */
    FROZEN_POSE: 'frozen_pose',
    /** Tier 1: zero pixel delta for 30 frames / 1 s. */
    SYNTHETIC_FRAME: 'synthetic_frame',
    /** Host asked for one directly (diagnostics). */
    MANUAL: 'manual',
  };

  const DEFAULT_MANAGER_OPTS = {
    /** Response window. */
    challengeMs: 3500,
    /** Quiet period after a resolved challenge — the spec's 60 s reset. */
    cooldownMs: 60000,
    /**
     * Consecutive qualifying samples required to pass.
     *
     * ONE, deliberately. The two errors are not symmetric: a false PASS lets a
     * spoofer survive one challenge and be re-tested 60 s later, while a false
     * FAIL brands an honest student a spoofer at CRITICAL severity. When the
     * evidence is marginal this should err toward the student.
     */
    requiredConsecutiveSamples: 1,
    /**
     * Minimum usable pose samples in the window for the result to mean anything.
     * Below this the outcome is INCONCLUSIVE, never a failure — "we could not
     * see" and "the student did not move" are different answers, and only one of
     * them is an accusation.
     */
    minSamplesForVerdict: 3,
    /**
     * Minimum spacing between FORCED challenges.
     *
     * A forced challenge deliberately ignores the normal cooldown — a suspected
     * synthetic feed should not have to wait 60 s. But a feed that stays frozen
     * would otherwise re-arm on the very next frame and prompt forever, so
     * forcing gets its own, shorter, floor.
     */
    forcedRechallengeMs: 30000,
    frozen: {},
    synthetic: {},
    response: {},
  };

  /**
   * Orchestrates frozen-pose detection, the corner prompt, and verification.
   *
   * Driven entirely by the existing per-frame pose result — it adds no inference
   * and no timers of its own beyond reading the clock the caller passes in, so
   * it cannot drift out of step with the proctoring loop or keep running after
   * the loop stops.
   */
  class LivenessChallengeManager {
    /**
     * @param {object} [options]
     * @param {Function} [options.onEvent] - (eventName, payload) for the host to
     *   log/report. Exceptions from it are contained.
     * @param {object} [options.renderer] - Anything with show(corner, prompt)/hide().
     * @param {object} [options.document] - Document to render into; defaults to
     *   the ambient one. Absent under Node, where rendering is a no-op.
     * @param {Function} [options.random] - Injectable RNG for deterministic tests.
     */
    constructor(options = {}) {
      this.opt = {
        ...DEFAULT_MANAGER_OPTS,
        ...options,
        frozen: { ...DEFAULT_MANAGER_OPTS.frozen, ...(options.frozen || {}) },
        synthetic: { ...DEFAULT_MANAGER_OPTS.synthetic, ...(options.synthetic || {}) },
        response: { ...DEFAULT_MANAGER_OPTS.response, ...(options.response || {}) },
      };

      this.monitor = new FrozenPoseMonitor(this.opt.frozen);
      this.syntheticMonitor = new SyntheticFrameMonitor(this.opt.synthetic);
      this.renderer = options.renderer || new CornerTargetRenderer(options.document);
      this._random = options.random || Math.random;
      this._onEvent = options.onEvent || null;

      this.reset();
    }

    reset() {
      this.monitor.reset();
      this.syntheticMonitor.reset();
      this.state = LivenessState.MONITORING;
      this.activeCorner = null;
      this.activeTrigger = null;
      /** Tier-1 state. True while the feed has stopped changing. */
      this.syntheticSuspected = false;
      this._challengeStartedMs = null;
      this._cooldownUntilMs = -Infinity;
      this._lastForcedMs = -Infinity;
      this._streak = 0;
      this._usableSamples = 0;
      this._bestSample = null;
      this.stats = { issued: 0, passed: 0, failed: 0, inconclusive: 0, syntheticConfirmed: 0 };
      try {
        this.renderer.hide();
      } catch { /* renderer may be headless */ }
    }

    /** @returns {boolean} True while a corner target is displayed. */
    isChallengeActive() {
      return this.state === LivenessState.CHALLENGE;
    }

    /**
     * Advance one frame.
     *
     * @param {object|null} poseResult - The HeadPoseAnalyzer result for this
     *   frame. Needs `.calibrated` and `.deviation.{yawDeg,pitchDeg}`.
     * @param {number} nowMs - performance.now().
     * @param {number|null} [pixelDelta] - Tier 1: mean absolute pixel delta
     *   against the previous frame. Omit or pass null when unmeasured.
     * @returns {{state:string, corner:string|null, outcome:string|null, detail:object|null}}
     */
    update(poseResult, nowMs, pixelDelta = null) {
      const dev = poseResult && poseResult.calibrated ? poseResult.deviation : null;
      const yawDeg = dev && Number.isFinite(dev.yawDeg) ? dev.yawDeg : null;
      const pitchDeg = dev && Number.isFinite(dev.pitchDeg) ? dev.pitchDeg : null;

      // Tier 1 runs on EVERY frame, including during a challenge — a feed that
      // starts moving again mid-challenge is exactly the innocent case, and the
      // suspicion flag has to reflect that.
      const synth = this.syntheticMonitor.update(pixelDelta, nowMs);
      this.syntheticSuspected = synth.suspected;

      if (this.state === LivenessState.CHALLENGE) {
        return this._advanceChallenge(yawDeg, pitchDeg, nowMs);
      }

      // Feed the monitor whether or not we are in cooldown, so the window is
      // already warm when the cooldown lapses.
      const frozenStats = this.monitor.update(yawDeg, pitchDeg, nowMs);

      // TIER 1 -> TIER 2 ESCALATION.
      //
      // Checked BEFORE the cooldown gate on purpose. A feed that has stopped
      // producing new pixels is a stronger and more urgent signal than the
      // 45 s pose watch, and making it wait out a 60 s cooldown from an
      // unrelated challenge would blind us for exactly as long as it takes to
      // sit an exam question. Repeat prompting is bounded by forcedRechallengeMs
      // instead.
      if (synth.suspected && this._canForce(nowMs)) {
        this._beginChallenge(nowMs, LivenessTrigger.SYNTHETIC_FRAME, { frozenStats, synth });
        return { state: this.state, corner: this.activeCorner, outcome: null, detail: { synth } };
      }

      if (this.state === LivenessState.COOLDOWN) {
        if (nowMs >= this._cooldownUntilMs) this.state = LivenessState.MONITORING;
        return this._idle(frozenStats, synth);
      }

      if (frozenStats.frozen) {
        this._beginChallenge(nowMs, LivenessTrigger.FROZEN_POSE, { frozenStats, synth });
        return { state: this.state, corner: this.activeCorner, outcome: null, detail: { frozenStats } };
      }

      return this._idle(frozenStats, synth);
    }

    _idle(frozenStats, synth) {
      return { state: this.state, corner: null, outcome: null, detail: { frozenStats, synth } };
    }

    /** @returns {boolean} True if a forced challenge is allowed right now. */
    _canForce(nowMs) {
      return (nowMs - this._lastForcedMs) >= this.opt.forcedRechallengeMs;
    }

    /**
     * Raise a challenge immediately, bypassing both the frozen-pose watch and
     * the cooldown.
     *
     * This is the ONLY route Tier 1 has to an outcome. It cannot report a
     * violation directly — a suspected synthetic feed has to be confirmed by a
     * challenge the student fails, because the benign causes of zero pixel
     * delta (3D noise reduction, decoder frame duplication, VM display drivers)
     * are indistinguishable from the malicious one at the pixel level.
     *
     * @param {number} nowMs
     * @param {string} [trigger] - A LivenessTrigger value.
     * @param {object} [detail] - Extra context for the issued event.
     * @returns {boolean} True if a challenge was started.
     */
    forceChallenge(nowMs, trigger = LivenessTrigger.MANUAL, detail = {}) {
      if (this.state === LivenessState.CHALLENGE) return false;
      if (!this._canForce(nowMs)) return false;
      this._beginChallenge(nowMs, trigger, detail);
      return true;
    }

    /** Pick a corner and put the dot up. */
    _beginChallenge(nowMs, trigger, context = {}) {
      const corner = this.pickCorner();
      const frozenStats = context.frozenStats || this.monitor.stats();
      const synth = context.synth || this.syntheticMonitor.stats();

      this.state = LivenessState.CHALLENGE;
      this.activeCorner = corner;
      this.activeTrigger = trigger;
      this._challengeStartedMs = nowMs;
      this._streak = 0;
      this._usableSamples = 0;
      this._bestSample = null;
      this.stats.issued++;
      if (trigger !== LivenessTrigger.FROZEN_POSE) this._lastForcedMs = nowMs;

      try {
        this.renderer.show(corner, 'Quick Check: Look at the dot!');
      } catch (err) {
        console.warn('[Liveness] could not render the corner target:', err && err.message);
      }

      this._emit('LIVENESS_CHALLENGE_ISSUED', {
        corner,
        trigger,
        expected: CORNER_DIRECTIONS[corner],
        frozen_span_ms: Math.round(frozenStats.spanMs),
        frozen_yaw_range_deg: Number(frozenStats.yawRange.toFixed(3)),
        frozen_pitch_range_deg: Number(frozenStats.pitchRange.toFixed(3)),
        frozen_samples: frozenStats.samples,
        synthetic_frames: synth.frames,
        synthetic_duration_ms: Math.round(synth.durationMs),
        window_ms: this.opt.challengeMs,
      });
      console.warn(
        `[Liveness] Challenge issued at ${corner} (trigger: ${trigger}` +
        (trigger === LivenessTrigger.SYNTHETIC_FRAME
          ? `, ${synth.frames} identical frames over ${Math.round(synth.durationMs)}ms`
          : '') + ').'
      );
    }

    /**
     * Uniformly pick one of the four extreme corners.
     *
     * Uniform and re-picked every time on purpose: a predictable rotation is
     * something a prepared spoofer can pre-record a response for.
     *
     * @returns {string}
     */
    pickCorner() {
      const idx = Math.min(CORNER_KEYS.length - 1, Math.floor(this._random() * CORNER_KEYS.length));
      return assertCornerOnly(CORNER_KEYS[idx]);
    }

    /** One frame inside the response window. */
    _advanceChallenge(yawDeg, pitchDeg, nowMs) {
      const corner = this.activeCorner;
      const elapsed = nowMs - this._challengeStartedMs;
      const usable = Number.isFinite(yawDeg) && Number.isFinite(pitchDeg);

      if (usable) {
        this._usableSamples++;
        const verdict = evaluateCornerResponse(corner, yawDeg, pitchDeg, this.opt.response);

        // Track the closest attempt so a failure report can say WHICH half of
        // the condition was missed rather than just "no movement".
        const score = Math.min(
          yawDeg * verdict.expectedYawSign,
          pitchDeg * verdict.expectedPitchSign
        );
        if (!this._bestSample || score > this._bestSample.score) {
          this._bestSample = { score, yawDeg, pitchDeg, yawOk: verdict.yawOk, pitchOk: verdict.pitchOk };
        }

        this._streak = verdict.pass ? this._streak + 1 : 0;

        if (this._streak >= this.opt.requiredConsecutiveSamples) {
          return this._resolve(LivenessOutcome.PASSED, nowMs, elapsed);
        }
      }

      if (elapsed >= this.opt.challengeMs) {
        // No usable view of the face for the whole window is NOT proof of
        // spoofing. Absence is its own violation and is reported by the pose
        // pipeline; do not double-accuse on weaker evidence here.
        const outcome = this._usableSamples >= this.opt.minSamplesForVerdict
          ? LivenessOutcome.FAILED
          : LivenessOutcome.INCONCLUSIVE;
        return this._resolve(outcome, nowMs, elapsed);
      }

      return {
        state: this.state,
        corner,
        outcome: null,
        detail: { elapsedMs: Math.round(elapsed), usableSamples: this._usableSamples },
      };
    }

    /** Close out the challenge, clear the dot, and report. */
    _resolve(outcome, nowMs, elapsedMs) {
      const corner = this.activeCorner;
      const trigger = this.activeTrigger;

      try {
        this.renderer.hide();
      } catch { /* headless */ }

      // A challenge raised by Tier 1 and then FAILED is the two-tier confirmation:
      // the pixels stopped changing AND the subject could not answer an
      // unpredictable prompt. Neither half is sufficient alone, which is the
      // whole point of the architecture.
      const syntheticConfirmed = outcome === LivenessOutcome.FAILED
        && trigger === LivenessTrigger.SYNTHETIC_FRAME;

      const synth = this.syntheticMonitor.stats();
      const detail = {
        corner,
        trigger,
        synthetic_confirmed: syntheticConfirmed,
        synthetic_frames: synth.frames,
        synthetic_duration_ms: Math.round(synth.durationMs),
        expected: CORNER_DIRECTIONS[corner],
        outcome,
        response_ms: Math.round(elapsedMs),
        usable_samples: this._usableSamples,
        best_yaw_deg: this._bestSample ? Number(this._bestSample.yawDeg.toFixed(1)) : null,
        best_pitch_deg: this._bestSample ? Number(this._bestSample.pitchDeg.toFixed(1)) : null,
        yaw_satisfied: this._bestSample ? this._bestSample.yawOk : false,
        pitch_satisfied: this._bestSample ? this._bestSample.pitchOk : false,
        yaw_threshold_deg: this.opt.response.yawThresholdDeg !== undefined
          ? this.opt.response.yawThresholdDeg : DEFAULT_RESPONSE_OPTS.yawThresholdDeg,
        pitch_threshold_deg: this.opt.response.pitchThresholdDeg !== undefined
          ? this.opt.response.pitchThresholdDeg : DEFAULT_RESPONSE_OPTS.pitchThresholdDeg,
      };

      if (outcome === LivenessOutcome.PASSED) {
        this.stats.passed++;
        // Answering the prompt required moving, which by definition produced
        // new pixels. Clear the suspicion outright — an innocent student whose
        // driver froze must not stay flagged after proving themselves.
        this.syntheticMonitor.reset();
        this.syntheticSuspected = false;
        console.log(`[Liveness] Liveness Challenge Passed (${corner}, ${Math.round(elapsedMs)}ms).`);
        this._emit('LIVENESS_CHALLENGE_PASSED', detail);
      } else if (outcome === LivenessOutcome.FAILED) {
        this.stats.failed++;
        if (syntheticConfirmed) {
          this.stats.syntheticConfirmed++;
          console.error(
            '[Liveness] CRITICAL: CAMERA_FEED_SYNTHETIC + LIVENESS_FAILED — ' +
            `${synth.frames} identical frames over ${Math.round(synth.durationMs)}ms AND no response ` +
            `to the ${corner} target within ${Math.round(elapsedMs)}ms.`
          );
        } else {
          console.error(
            '[Liveness] FLAG_CHEATING: Failed Liveness Challenge (Static Image/Spoofing Detected) — ' +
            `target ${corner}, best yaw ${detail.best_yaw_deg}deg, best pitch ${detail.best_pitch_deg}deg.`
          );
        }
        this._emit('LIVENESS_CHALLENGE_FAILED', detail);
      } else {
        this.stats.inconclusive++;
        console.warn(
          `[Liveness] Challenge inconclusive at ${corner}: only ${this._usableSamples} usable pose ` +
          'sample(s) in the window. Not reported as spoofing.'
        );
        this._emit('LIVENESS_CHALLENGE_INCONCLUSIVE', detail);
      }

      // Whatever happened, the stillness evidence is spent — start the next
      // 45-60 s observation from scratch rather than re-firing immediately.
      this.monitor.reset();
      this.activeCorner = null;
      this.activeTrigger = null;
      this._challengeStartedMs = null;
      this._streak = 0;
      this._bestSample = null;
      this.state = LivenessState.COOLDOWN;
      this._cooldownUntilMs = nowMs + this.opt.cooldownMs;

      return { state: this.state, corner, outcome, detail };
    }

    _emit(name, payload) {
      if (!this._onEvent) return;
      try {
        this._onEvent(name, payload);
      } catch (err) {
        console.error('[Liveness] onEvent handler threw:', err);
      }
    }

    /** Compact telemetry summary. */
    telemetry() {
      const s = this.monitor.stats();
      const synth = this.syntheticMonitor.stats();
      return {
        state: this.state,
        corner: this.activeCorner,
        trigger: this.activeTrigger,
        synthetic_suspected: this.syntheticSuspected,
        synthetic_frames: synth.frames,
        synthetic_duration_ms: Math.round(synth.durationMs),
        synthetic_confirmed: this.stats.syntheticConfirmed,
        issued: this.stats.issued,
        passed: this.stats.passed,
        failed: this.stats.failed,
        inconclusive: this.stats.inconclusive,
        frozen_span_ms: Math.round(s.spanMs),
        frozen_yaw_range_deg: Number(s.yawRange.toFixed(3)),
        frozen_pitch_range_deg: Number(s.pitchRange.toFixed(3)),
        frozen_samples: s.samples,
      };
    }
  }

  return {
    SCREEN_LEFT_YAW_SIGN,
    CORNER_KEYS,
    CORNER_DIRECTIONS,
    CORNER_POSITIONS,
    DOT_SIZE_PX,
    CORNER_INSET_PX,
    DEFAULT_FROZEN_OPTS,
    DEFAULT_SYNTHETIC_OPTS,
    DEFAULT_RESPONSE_OPTS,
    DEFAULT_MANAGER_OPTS,
    LivenessState,
    LivenessOutcome,
    LivenessTrigger,
    assertCornerOnly,
    evaluateCornerResponse,
    FrozenPoseMonitor,
    SyntheticFrameMonitor,
    CornerTargetRenderer,
    LivenessChallengeManager,
  };
}));
