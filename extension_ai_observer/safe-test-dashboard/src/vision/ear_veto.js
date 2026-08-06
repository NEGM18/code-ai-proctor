// =============================================================================
// EAR Veto Gate — Cascading Safeguard — AI Observer Extension
//
// The last line of defence against the defect that started all of this: the
// trained classifier reporting CLOSED EYES as cheating.
//
// That defect was contained per-detector (the classifier demoted to
// corroboration-only; gaze_landmarks.js gating on EAR before it computes
// anything). Per-detector containment has a structural weakness — every FUTURE
// eye-dependent detector has to re-earn the property, and nothing stops the
// next one from repeating the mistake. This gate sits at the reporting choke
// point instead, so a detector cannot route around it by being new.
//
//   detector -> reportViolation(type, payload)
//                     |
//                     +-- type not vetoable? ------> report unchanged
//                     +-- EAR unavailable/stale? --> report unchanged (FAIL-OPEN)
//                     +-- EAR <  0.20 ------------> SUPPRESS
//                     +-- EAR >= 0.20 ------------> report, annotated
//
// -----------------------------------------------------------------------------
// ⚠ TWO PROPERTIES CARRY THE SAFETY OF THIS MODULE. Read both before editing.
//
// 1. THE ALLOWLIST IS NOT A CATEGORY, IT IS A CONSTANT.
//    Vetoing on eye state is only valid for violations whose EVIDENCE DEPENDS
//    ON THE EYES BEING OPEN. A blanket veto would hand every student a way to
//    suppress unrelated alerts by closing their eyes. A phone on the desk is a
//    phone whether or not someone blinked.
//
//    NO_FACE_DETECTED is the sharpest case and is deliberately NOT vetoable:
//    covering the camera destroys the landmarks, so vetoing it would turn
//    camera-covering into a way to silence the detector built to catch it.
//
// 2. UNAVAILABLE EAR MUST FAIL **OPEN**.
//    Fail-closed is a suppression exploit — anything that defeats landmark
//    detection would mute every gaze alert at once, which is a far more
//    attractive attack than the false positive this gate prevents. Fail-open
//    preserves existing behaviour exactly and keeps the gate purely additive.
//
//    This is only sound BECAUSE the veto is a SECOND line of defence. The
//    primary detectors must remain safe on their own. Never delete a
//    detector's own EAR handling on the grounds that "the veto covers it".
// -----------------------------------------------------------------------------
//
// ⚠ INERT UNTIL A FACE-LANDMARK MODEL IS SERVED. pose.onnx is COCO-17 and has
// no eyelid points, so submitLandmarks() currently never receives a usable set
// and every evaluate() fails open. Correct, tested, and a no-op in production
// until a 478-point FaceMesh ONNX is in the pipeline. See CLAUDE.md §7.
// =============================================================================

// >>> ESM PORT
// Upstream is a UMD module: a `/* global … */` directive, an IIFE prologue, and the
// factory-argument destructuring that followed it (lines 51-65). All three are
// replaced by the static ESM import below — the directive existed only for
// the extension browser-globals loading model, which this import supersedes.

// Retained verbatim from upstream lines 62-64, moved above the import it explains:
// Imported, never re-derived: one definition of EAR semantics in the codebase.
// analyzeGazeLandmarks supplies the iris ratios the keyboard veto needs; the
// geometry lives in gaze_landmarks.js and is not duplicated here.
import { eyeAspectRatio, LANDMARK_CONTRACT, analyzeGazeLandmarks } from './gaze_landmarks.js';

// ⚠ The factory body below (upstream lines 66-729) keeps its original 2-space
// indentation ON PURPOSE: it is byte-identical to upstream, which is exactly what
// scripts/check-vision-sync.mjs verifies. De-indenting would touch every line and
// destroy that guarantee. ESLint here has no `indent` rule, so nothing forces it.
// <<< ESM PORT

  /**
   * ⚠ THE ALLOWLIST. Only violations whose evidence requires open eyes.
   *
   * Adding a type here means "a student with closed eyes cannot commit this".
   * That is a strong claim. Anything not listed is reported unconditionally.
   */
  const VETOABLE_VIOLATIONS = Object.freeze([
    // Pixel gaze (currently disabled) — its verdict is meaningless on a closed eye.
    'GAZE_OFF_SCREEN',
    // Landmark gaze — already EAR-gated internally; this is the backstop.
    'SIDE_GAZE_PEEKING',
    // ⚠ The whole-frame cheating/normal classifier (best.onnx) raising an alert
    // on its own. This entry is the ONLY reason that promotion is safe: the
    // model learned "eyes shut" as a correlate of cheating, and the veto is
    // what removes that specific failure mode from its output.
    'AI_CHEATING_CLASSIFIER',
  ]);

  /**
   * Types that must NEVER be vetoed, listed explicitly so the test suite can
   * assert them by name rather than inferring them from the absence of an
   * entry above. A silent typo in VETOABLE_VIOLATIONS would otherwise go
   * unnoticed in exactly the direction that matters.
   */
  const NEVER_VETOABLE = Object.freeze([
    'PHONE_DETECTED',        // a phone is a phone whether or not they blinked
    'NO_FACE_DETECTED',      // see the header — camera-covering must not be a defeat
    'MULTIPLE_FACES',        // a second person does not blink out of existence
    'SECONDARY_DEVICE',
    'AI_CHEATING_POSE',      // head geometry, stands on its own evidence
    'HEAD_POSE_GLANCE',
    'FULLSCREEN_EXIT',
    'SCREEN_SHARE_STOPPED',
    'TAB_SWITCH',
    'WINDOW_BLUR',
    'VISIBILITY_HIDDEN',
    'LIVENESS_FAILED',
    'CAMERA_FEED_SYNTHETIC',
  ]);

  const DEFAULT_VETO_OPTS = {
    // Per spec. Below this the eye is closed, blinking or squinting.
    earThreshold: 0.20,

    // ⚠ An EAR reading from 3 s ago says nothing about THIS frame. A sample
    // older than this counts as unavailable and therefore fails open. Without
    // it, one good reading would license suppression indefinitely.
    maxAgeMs: 500,
  };

  const VETO_REASON = {
    EYE_CLOSED: 'EYE_CLOSED',
    NOT_VETOABLE: 'NOT_VETOABLE',
    NO_SAMPLE: 'NO_SAMPLE',
    STALE: 'STALE',
    EYES_OPEN: 'EYES_OPEN',
    /** Suppressed on the coarse pixel channel, not on a landmark EAR. */
    CLOSURE_HINT: 'CLOSURE_HINT',
    /** Suppressed as a forgiven downward glance at the keyboard/desk. */
    KEYBOARD_GLANCE: 'KEYBOARD_GLANCE',
  };

  // ===========================================================================
  // KEYBOARD & DOWNWARD GAZE VETO
  //
  // The trained classifier over-flags students looking down at their keyboard.
  // That is the same family of defect as the closed-eyes bug (CLAUDE.md §7,
  // 2026-08-02 e, item (b)): a property of the weights, not of the reporting
  // path, so it is contained the same way — at the choke point, where no
  // detector can route around it.
  //
  // Looking down at a keyboard is the most common benign behaviour in a typed
  // exam. Flagging it accuses students of cheating for typing badly, which is a
  // skill difference, not misconduct.
  //
  // ⚠ SUPPRESSION ONLY. Like the rest of this gate it can withhold an alert and
  // nothing else. It has no route to raising one, and must never acquire one.
  // ===========================================================================

  /** What a frame's eye geometry looks like. */
  const GLANCE_CLASS = {
    /** Iris well off the horizontal axis. NEVER forgiven — outranks all below. */
    SIDE_PEEK: 'SIDE_PEEK',
    /** Rule 1: horizontally centred and clearly downward. */
    KEYBOARD_GLANCE: 'KEYBOARD_GLANCE',
    /** Rule 2: natural lid droop of a head angled down at the desk. */
    DESK_LOOKING: 'DESK_LOOKING',
    /** Not classifiable. Never forgiven — suppression needs positive evidence. */
    UNKNOWN: 'UNKNOWN',
  };

  const KEYBOARD_VETO_DEFAULTS = {
    // --- Rule 1: pure vertical downward -----------------------------------
    maxHorizontalOffset: 0.12,
    minVerticalOffset: 0.15,

    // --- Rule 2: EAR lid-droop confirmation --------------------------------
    //
    // ⚠ Most of this band is already covered. gaze_landmarks.js:analyzeEye
    // gates on ear < 0.20 BEFORE reading the iris, so [0.14, 0.20) is already
    // suppressed by the EYE_CLOSED path and carries no iris geometry at all.
    // The genuine delta of Rule 2 is the narrow [0.20, 0.22] band, where the
    // eye counts as open but the lids are visibly lowered.
    lidDroopMinEar: 0.14,
    lidDroopMaxEar: 0.22,

    // --- Rule 3 / the override --------------------------------------------
    //
    // ⚠ THE LOAD-BEARING THRESHOLD. Rule 2 as specified classifies on EAR
    // ALONE. Resting EAR varies substantially between individuals (lid shape,
    // age, epicanthic folds, ptosis), so on its own it would hand a student
    // whose neutral EAR sits at 0.21 blanket immunity from every eye
    // violation — including a hard side-peek at their notes. A security hole
    // and an arbitrary fairness advantage at once.
    //
    // The spec's own reporting rule closes it ("IF horizontal peeking is
    // present ... Dispatch"), so a side peek is an UNCONDITIONAL override that
    // is tested first and outranks both classification rules. Never reorder it
    // below them; keyboard_glance.test.js pins the precedence by name.
    sidePeekOffset: 0.15,

    /** How long a downward episode is forgiven. */
    permitMs: 5000,
    /** A 1-2 frame blip must not restart the budget. */
    graceMs: 400,

    // --- the anti-bypass cap ----------------------------------------------
    //
    // ⚠ A bare 5 s permit that resets on look-up is a COMPLETE BYPASS: 4.9 s
    // down, 0.5 s up, repeat, forever, and downward gaze is never detectable.
    //
    // The cap discriminates on the axis that actually separates the two
    // behaviours: a typist glances down BRIEFLY and OFTEN, a reader glances
    // down AT LENGTH and REPEATEDLY. A cumulative-time cap was rejected because
    // it would punish hunt-and-peck typists — precisely the students this
    // safeguard exists to protect.
    longGlanceMs: 3000,
    maxLongGlances: 3,
    windowMs: 60000,
  };

  /**
   * Classify one frame's eye geometry. PURE.
   *
   * The spec's offsets are centred; gaze_landmarks.js emits ratios in [0,1]:
   *
   *   hOffset = hRatio - 0.5   (orientedGazeRatio: 0 = image-left, 1 = image-right)
   *   vOffset = vRatio - 0.5   (verticalIrisRatio: 0 = upper lid, 1 = lower lid)
   *
   * ⚠ SIGN — verified, and NO FLIP IS NEEDED. verticalIrisRatio projects the
   * iris from the upper lid toward the lower lid, so a LARGER ratio means the
   * iris sits LOWER in the eye, i.e. looking DOWN. `vOffset > 0.15` therefore
   * genuinely means "eyes directed down", and it agrees with the module's
   * existing downThreshold of 0.62. Unlike gaze_roi.js's vertical axis this one
   * needs no sign constant — adding one here would invert the safeguard and
   * forgive upward glances while flagging keyboard use.
   *
   * FIRST MATCH WINS, and the order IS the safeguard.
   *
   * @param {{valid:boolean, ear:number, hRatio:number, vRatio:number}} sample
   * @param {object} [options]
   * @returns {{klass:string, hOffset:number|null, vOffset:number|null, ear:number|null}}
   */
  function classifyGlance(sample, options = {}) {
    const opt = { ...KEYBOARD_VETO_DEFAULTS, ...options };
    const unknown = (ear = null) => ({
      klass: GLANCE_CLASS.UNKNOWN, hOffset: null, vOffset: null, ear,
    });

    if (!sample) return unknown();

    const ear = Number.isFinite(sample.ear) ? sample.ear : null;

    // No usable geometry. A closed or unreadable eye yields NOTHING here — the
    // EYE_CLOSED path owns that case on its own evidence, and inventing a
    // direction for an eye we cannot see is the exact defect this whole
    // pipeline is built around.
    if (!sample.valid || !Number.isFinite(sample.hRatio) || !Number.isFinite(sample.vRatio)) {
      return unknown(ear);
    }

    const hOffset = sample.hRatio - 0.5;
    const vOffset = sample.vRatio - 0.5;
    const out = (klass) => ({ klass, hOffset, vOffset, ear });

    // 1. ⚠ THE OVERRIDE. Tested FIRST so neither rule below can forgive a
    //    student who is looking sideways, whatever their eyelids are doing.
    if (Math.abs(hOffset) >= opt.sidePeekOffset) return out(GLANCE_CLASS.SIDE_PEEK);

    // 2. RULE 1 — horizontally centred and clearly downward.
    if (Math.abs(hOffset) < opt.maxHorizontalOffset && vOffset > opt.minVerticalOffset) {
      return out(GLANCE_CLASS.KEYBOARD_GLANCE);
    }

    // 3. RULE 2 — lid droop. Only REACHABLE with abs(hOffset) < sidePeekOffset,
    //    because step 1 already claimed everything beyond it. That reachability
    //    constraint is what stops a droopy-lidded student acquiring immunity.
    if (ear !== null && ear >= opt.lidDroopMinEar && ear <= opt.lidDroopMaxEar) {
      return out(GLANCE_CLASS.DESK_LOOKING);
    }

    // The gap 0.12 <= abs(hOffset) < 0.15 lands here when the EAR is normal:
    // neither a clean vertical glance nor a side peek. UNKNOWN, so it reports.
    return out(GLANCE_CLASS.UNKNOWN);
  }

  /** @param {string} klass @returns {boolean} */
  function isForgivableGlance(klass) {
    return klass === GLANCE_CLASS.KEYBOARD_GLANCE || klass === GLANCE_CLASS.DESK_LOOKING;
  }

  /**
   * Tracks the current downward-glance episode and decides whether it is still
   * forgiven.
   *
   * NOT DwellGate. That class answers "fire an event after sustained truth";
   * this needs "how long has this episode run, and may it still be forgiven" —
   * a different question, and bending DwellGate to it would mean fighting its
   * alert/refractory semantics. temporal_gate.js stays untouched.
   */
  class KeyboardGlancePermit {
    constructor(options = {}) {
      this.opt = { ...KEYBOARD_VETO_DEFAULTS, ...options };
      this.reset();
    }

    reset() {
      this._startedAt = null;
      this._lastGlanceAt = null;
      this._longRecorded = false;
      this._longAt = [];
      this.lastKlass = GLANCE_CLASS.UNKNOWN;
      this.grantedCount = 0;
      this.episodeCount = 0;
    }

    /** Drop long-glance records that have aged out of the rolling window. */
    _prune(nowMs) {
      const cutoff = nowMs - this.opt.windowMs;
      while (this._longAt.length && this._longAt[0] < cutoff) this._longAt.shift();
    }

    _endEpisode() {
      this._startedAt = null;
      this._lastGlanceAt = null;
      this._longRecorded = false;
    }

    /**
     * Advance by one frame.
     * @param {string} klass - GLANCE_CLASS value for this frame.
     * @param {number} nowMs
     */
    update(klass, nowMs) {
      this.lastKlass = klass;
      this._prune(nowMs);

      // ⚠ A side peek ENDS the episode immediately rather than merely failing
      // to extend it. Without this a student could alternate down/side inside
      // the grace window and hold a live permit the whole time they peeked.
      if (klass === GLANCE_CLASS.SIDE_PEEK) {
        this._endEpisode();
        return;
      }

      if (isForgivableGlance(klass)) {
        if (this._startedAt === null) {
          this._startedAt = nowMs;
          this.episodeCount++;
        }
        this._lastGlanceAt = nowMs;

        // Record the episode as "long" ONCE, not once per frame, or a single
        // sustained glance would exhaust the whole window budget by itself.
        if (!this._longRecorded && (nowMs - this._startedAt) >= this.opt.longGlanceMs) {
          this._longRecorded = true;
          this._longAt.push(nowMs);
        }
        return;
      }

      // Anything else (UNKNOWN, an unreadable frame): the episode survives a
      // brief interruption, then ends. The clock is NOT paused meanwhile — a
      // blink must not buy extra forgiven time.
      if (this._startedAt !== null
        && (nowMs - this._lastGlanceAt) > this.opt.graceMs) {
        this._endEpisode();
      }
    }

    /** Elapsed time in the current episode, or 0 when none is running. */
    elapsedMs(nowMs) {
      return this._startedAt === null ? 0 : Math.max(0, nowMs - this._startedAt);
    }

    /** Long episodes inside the rolling window. */
    longGlancesInWindow(nowMs) {
      this._prune(nowMs);
      return this._longAt.length;
    }

    /**
     * May the current frame's violation be forgiven?
     *
     * Requires ALL THREE: an episode is running, it is still inside permitMs,
     * and the student has not already spent the window's long-glance budget.
     *
     * @param {number} nowMs
     * @returns {boolean}
     */
    isGranted(nowMs) {
      if (this._startedAt === null) return false;
      if (!isForgivableGlance(this.lastKlass)) return false;
      if (this.elapsedMs(nowMs) >= this.opt.permitMs) return false;
      if (this.longGlancesInWindow(nowMs) >= this.opt.maxLongGlances) return false;
      return true;
    }

    snapshot(nowMs) {
      return {
        klass: this.lastKlass,
        active: this._startedAt !== null,
        elapsedMs: Math.round(this.elapsedMs(nowMs)),
        longInWindow: this.longGlancesInWindow(nowMs),
        episodes: this.episodeCount,
        granted: this.grantedCount,
      };
    }
  }

  /**
   * Compute a single EAR for the face from a 478-point landmark set.
   *
   * Returns the MINIMUM of the two eyes, not the mean. Blink immunity is not a
   * per-eye property: if either eye is shut the frame is not trustworthy
   * evidence of where the student was looking, and the mean would let one wide
   * eye drag a genuine blink above the threshold.
   *
   * The cost of `min` is that holding ONE eye shut suppresses vetoable
   * violations. That is bounded and acceptable — the vetoable set is gaze-only,
   * every other detector stays live, and gaze_landmarks.js already refuses
   * one-eye samples so it would not be producing a verdict anyway. The
   * asymmetry is surfaced via telemetry().oneEyeClosedSamples so the behaviour
   * is observable rather than silent.
   *
   * @param {Array<{x:number,y:number,score?:number}>} pts
   * @param {object} [contract] - Defaults to LANDMARK_CONTRACT.
   * @returns {{ear:number, leftEar:number, rightEar:number, oneEyeOnly:boolean}|null}
   */
  function computeFaceEar(pts, contract) {
    const C = contract || LANDMARK_CONTRACT;
    if (!pts || !pts.length) return null;

    const earFor = (idx) => {
      const u = pts[idx.upperLid];
      const l = pts[idx.lowerLid];
      const i = pts[idx.inner];
      const o = pts[idx.outer];
      if (!u || !l || !i || !o) return NaN;
      return eyeAspectRatio(u, l, i, o);
    };

    const leftEar = earFor(C.left);
    const rightEar = earFor(C.right);
    const lOk = Number.isFinite(leftEar);
    const rOk = Number.isFinite(rightEar);
    if (!lOk && !rOk) return null;

    // A single readable eye still yields a usable veto signal — it can only
    // ever make the gate MORE likely to suppress, never less.
    const ear = (lOk && rOk) ? Math.min(leftEar, rightEar) : (lOk ? leftEar : rightEar);
    return { ear, leftEar, rightEar, oneEyeOnly: !(lOk && rOk) };
  }

  /**
   * Stateful veto gate. One instance per proctoring session.
   *
   * Landmarks go in once per frame; violations are tested against the most
   * recent sample.
   */
  class EarVetoGate {
    constructor(options = {}) {
      this.opt = { ...DEFAULT_VETO_OPTS, ...options };
      this.vetoable = new Set(options.vetoable || VETOABLE_VIOLATIONS);
      // Constructed BEFORE reset(), which clears it.
      this.permit = new KeyboardGlancePermit(options.keyboard || {});
      this.reset();
    }

    reset() {
      this._ear = NaN;
      this._leftEar = NaN;
      this._rightEar = NaN;
      this._sampledAt = null;
      // Coarse pixel channel — see submitClosureHint(). Kept entirely separate
      // from the landmark EAR above so neither can be mistaken for the other.
      this._closureClosed = false;
      this._closureAt = null;
      this.vetoCount = 0;
      this.confirmCount = 0;
      this.failOpenCount = 0;
      this.sampleCount = 0;
      this.oneEyeClosedSamples = 0;
      this.closureHintSamples = 0;
      this.closureHintVetoes = 0;
      this.keyboardVetoes = 0;
      this._lastGlance = null;
      if (this.permit) this.permit.reset();
    }

    /** @param {string} violationType @returns {boolean} */
    isVetoable(violationType) {
      return this.vetoable.has(violationType);
    }

    /**
     * Feed the frame's landmarks. Call once per processed frame, including on
     * frames where landmarks are absent — passing null explicitly ages the
     * sample out rather than leaving a stale reading alive.
     *
     * @param {Array|null} pts - 478-point set, or null when unavailable.
     * @param {number} nowMs
     * @returns {number} The EAR recorded, or NaN.
     */
    submitLandmarks(pts, nowMs) {
      // Keyboard/downward veto rides on the SAME landmark set and the same
      // call — one place the permit can be advanced from, so no detector can
      // reach it by another route. analyzeGazeLandmarks is imported from
      // gaze_landmarks.js; none of its geometry is re-derived here.
      //
      // Advanced even on landmark-less frames: passing UNKNOWN is what lets an
      // episode age out through the grace window instead of hanging forever.
      const geom = (pts && typeof analyzeGazeLandmarks === 'function')
        ? analyzeGazeLandmarks(pts, this.opt.contract ? { contract: this.opt.contract } : {})
        : null;
      this._lastGlance = classifyGlance(geom, this.permit.opt);
      this.permit.update(this._lastGlance.klass, nowMs);

      const res = pts ? computeFaceEar(pts, this.opt.contract) : null;
      if (!res || !Number.isFinite(res.ear)) {
        // Do NOT clear the previous sample: staleness already handles it, and
        // clearing on one dropped frame would flap the gate open and shut.
        return NaN;
      }
      this._ear = res.ear;
      this._leftEar = res.leftEar;
      this._rightEar = res.rightEar;
      this._sampledAt = nowMs;
      this.sampleCount++;

      // Observable, never an accusation on its own.
      const lShut = Number.isFinite(res.leftEar) && res.leftEar < this.opt.earThreshold;
      const rShut = Number.isFinite(res.rightEar) && res.rightEar < this.opt.earThreshold;
      if (lShut !== rShut) this.oneEyeClosedSamples++;

      return res.ear;
    }

    /** Inject an EAR directly. For tests and for alternate landmark sources. */
    submitEar(ear, nowMs) {
      if (!Number.isFinite(ear)) return NaN;
      this._ear = ear;
      this._leftEar = ear;
      this._rightEar = ear;
      this._sampledAt = nowMs;
      this.sampleCount++;
      return ear;
    }

    /**
     * COARSE FALLBACK CHANNEL — pixel-derived eye closure, no landmarks.
     *
     * `pose.onnx` is COCO-17 and gives one point per eye, so a landmark EAR is
     * not computable today and every evaluate() would otherwise fail open. This
     * accepts the boolean openness verdict that gaze_roi.js's ROI gate already
     * produces (intensity spread + dark-blob aspect) so blink immunity is real
     * rather than vacuous while no FaceMesh model is served.
     *
     * ⚠ WHY A SIGNAL THIS COARSE IS ACCEPTABLE HERE, AND NOWHERE ELSE.
     *
     * The veto is MONOTONE: it can only ever SUPPRESS. So its two error modes
     * are asymmetric in the student's favour —
     *
     *   false "closed" -> an alert is suppressed        -> favours the student
     *   false "open"   -> no suppression, i.e. today's behaviour (fail open)
     *
     * That inverts gaze_roi.js's known weakness. Its openness gate degrades on
     * dark irises, heavy lids and glasses glare; as a DIRECTION estimator that
     * produced unequal false accusations, which is why the direction path is
     * disabled. As a SUPPRESSION input the same degradation produces extra
     * suppression, which harms no one.
     *
     * ⚠ AND WHY IT MUST NOT TOUCH hasFreshSample().
     *
     * That predicate gates classifierMayAlertAlone(). Letting this channel
     * satisfy it would promote `best.onnx` to a primary accuser on the strength
     * of a signal explicitly too coarse to be trusted in that direction —
     * "permission to suppress" is not "permission to accuse". The two channels
     * are separate fields for exactly this reason. Do not merge them.
     *
     * @param {boolean|null} closed - true = eyes read shut; false = read open;
     *        null/undefined = unreadable, which records nothing and ages out.
     * @param {number} nowMs
     * @returns {boolean} whether a hint was recorded
     */
    submitClosureHint(closed, nowMs) {
      if (closed === null || closed === undefined) return false;
      this._closureClosed = !!closed;
      this._closureAt = nowMs;
      this.closureHintSamples++;
      return true;
    }

    /** @private Is the coarse channel fresh AND reading shut? */
    _closureSaysShut(nowMs) {
      if (this._closureAt === null || !this._closureClosed) return false;
      return (nowMs - this._closureAt) <= this.opt.maxAgeMs;
    }

    /**
     * Is the safeguard actually WORKING right now?
     *
     * ⚠ Callers that want to PROMOTE a detector on the strength of this gate
     * must check this first. The veto fails open by design, so "no landmarks"
     * silently means "no protection" — and a detector promoted on the promise
     * of a safeguard that is not running is strictly worse than one that was
     * never promoted. A rule of the form "trust X except when the eyes are
     * closed" cannot be honoured at all if we cannot see the eyes.
     *
     * @param {number} nowMs
     * @returns {boolean}
     */
    hasFreshSample(nowMs) {
      if (this._sampledAt === null || !Number.isFinite(this._ear)) return false;
      return (nowMs - this._sampledAt) <= this.opt.maxAgeMs;
    }

    /**
     * Are the eyes VERIFIABLY closed right now?
     *
     * Deliberately not the negation of "open": it is false both when the eyes
     * are open AND when we cannot tell. Callers that suppress on this therefore
     * inherit the fail-open property automatically.
     *
     * Pure query — mutates no counters, so it is safe to call per frame.
     *
     * @param {number} nowMs
     * @returns {boolean}
     */
    eyesVerifiablyClosed(nowMs) {
      const earFresh = this._sampledAt !== null
        && Number.isFinite(this._ear)
        && (nowMs - this._sampledAt) <= this.opt.maxAgeMs;

      // A fresh landmark EAR is the better instrument and wins outright, in
      // both directions — including when it says the eyes are OPEN.
      if (earFresh) return this._ear < this.opt.earThreshold;

      // Otherwise fall back to the coarse channel. It can only add suppression.
      return this._closureSaysShut(nowMs);
    }

    /**
     * Should this violation be suppressed?
     *
     * @param {string} violationType
     * @param {number} nowMs
     * @returns {{veto:boolean, reason:string, ear:number|null,
     *            ageMs:number|null, stale:boolean, vetoable:boolean}}
     */
    evaluate(violationType, nowMs) {
      const base = {
        veto: false,
        ear: Number.isFinite(this._ear) ? this._ear : null,
        ageMs: this._sampledAt === null ? null : Math.max(0, nowMs - this._sampledAt),
        stale: false,
        vetoable: this.isVetoable(violationType),
      };

      if (!base.vetoable) return { ...base, reason: VETO_REASON.NOT_VETOABLE };

      const noSample = this._sampledAt === null || !Number.isFinite(this._ear);
      const stale = !noSample && base.ageMs > this.opt.maxAgeMs;

      // --- Landmark EAR, when we have a fresh one. The better instrument, so
      //     it decides on its own in BOTH directions. -----------------------
      if (!noSample && !stale) {
        if (this._ear < this.opt.earThreshold) {
          this.vetoCount++;
          return { ...base, veto: true, reason: VETO_REASON.EYE_CLOSED };
        }

        // --- KEYBOARD / DOWNWARD GLANCE ------------------------------------
        // Ordered AFTER the closed-eye check, which is the stronger claim and
        // needs no geometry. isGranted() already refuses when the frame is a
        // SIDE_PEEK, when the 5 s permit has run out, and when the window's
        // long-glance budget is spent — so a side peek is dispatched here even
        // though the eyes are open and the lids may be low.
        if (this.permit.isGranted(nowMs)) {
          this.vetoCount++;
          this.keyboardVetoes++;
          this.permit.grantedCount++;
          return {
            ...base,
            veto: true,
            reason: VETO_REASON.KEYBOARD_GLANCE,
            glance: this._lastGlance ? this._lastGlance.klass : null,
            permitMs: Math.round(this.permit.elapsedMs(nowMs)),
          };
        }

        this.confirmCount++;
        return { ...base, reason: VETO_REASON.EYES_OPEN };
      }

      // --- No usable EAR. Before failing open, consult the coarse pixel
      //     channel. It can only ever ADD suppression, never remove it, so
      //     this strictly enlarges blink immunity — see submitClosureHint().
      if (this._closureSaysShut(nowMs)) {
        this.vetoCount++;
        this.closureHintVetoes++;
        return { ...base, veto: true, reason: VETO_REASON.CLOSURE_HINT, coarse: true };
      }

      // --- FAIL-OPEN. See the header; both paths are deliberate. -----------
      this.failOpenCount++;
      return stale
        ? { ...base, stale: true, reason: VETO_REASON.STALE }
        : { ...base, reason: VETO_REASON.NO_SAMPLE };
    }

    /** Compact snapshot for telemetry and the console. */
    telemetry() {
      return {
        ear: Number.isFinite(this._ear) ? Number(this._ear.toFixed(3)) : null,
        leftEar: Number.isFinite(this._leftEar) ? Number(this._leftEar.toFixed(3)) : null,
        rightEar: Number.isFinite(this._rightEar) ? Number(this._rightEar.toFixed(3)) : null,
        sampledAt: this._sampledAt,
        threshold: this.opt.earThreshold,
        maxAgeMs: this.opt.maxAgeMs,
        vetoable: Array.from(this.vetoable),
        samples: this.sampleCount,
        vetoed: this.vetoCount,
        confirmed: this.confirmCount,
        // High and rising means the landmark model is absent or failing, and
        // the safeguard is therefore doing nothing. Worth an eye in the field.
        failedOpen: this.failOpenCount,
        oneEyeClosedSamples: this.oneEyeClosedSamples,
        // The coarse pixel channel, kept separately so the field can tell
        // "the landmark model is live" from "we are running on the fallback".
        closureHintSamples: this.closureHintSamples,
        closureHintVetoes: this.closureHintVetoes,
        closureFresh: this._closureAt !== null,
        // Keyboard / downward glance veto. `longInWindow` at the cap means the
        // anti-bypass limit has engaged and downward gaze is alerting normally
        // — the signal to watch if students report sudden flagging while typing.
        keyboardVetoes: this.keyboardVetoes,
        lastGlanceClass: this._lastGlance ? this._lastGlance.klass : null,
        keyboardPermit: this.permit.snapshot(this._sampledAt || 0),
      };
    }
  }

// >>> ESM PORT
// Upstream closed the factory with `return { … };` + `}));` (lines 730-743).
// Same identifiers, same order, as named ESM exports.
export {
  VETOABLE_VIOLATIONS,
  NEVER_VETOABLE,
  DEFAULT_VETO_OPTS,
  VETO_REASON,
  computeFaceEar,
  GLANCE_CLASS,
  KEYBOARD_VETO_DEFAULTS,
  classifyGlance,
  isForgivableGlance,
  KeyboardGlancePermit,
  EarVetoGate,
};
// <<< ESM PORT
