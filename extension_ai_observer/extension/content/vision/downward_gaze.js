// =============================================================================
// Downward Gaze Detector — AI Observer Extension
//
// THE GAP THIS CLOSES. A phone lying flat below the camera is the one cheating
// posture every existing detector misses at once:
//
//   detect.onnx      the phone is edge-on, foreshortened toward square, and
//                    usually half-occluded by a hand — it fails the phone shape
//                    gate's squareConfidence 0.75, by design.
//   head pose        a student reading something low barely moves their head if
//                    the phone is near the keyboard; excursion stays inside
//                    their calibrated band.
//   best.onnx        has no notion of where anyone is looking.
//   SIDE_GAZE_PEEKING  folds vertical into one off-axis test at a 3000 ms gate,
//                    so it cannot name the direction OR fire at 1.2 s.
//
// What DOES move is the iris: it sits low in the eye opening for as long as the
// screen is being read. That is what this measures.
//
// -----------------------------------------------------------------------------
// ⚠ 1. THE SIGN. THERE ARE TWO CONVENTIONS IN THIS CODEBASE AND THEY DISAGREE.
//
//   ear_veto.classifyGlance   vOffset = vRatio - 0.5      POSITIVE is down
//   gaze_landmarks deviation  pitchRatio = -(vRatio-0.5)  NEGATIVE is down
//
// The second is at gaze_landmarks.js:510, which negates into pose convention
// because pose_calibration reads pitchDev < 0 as 'down'. Getting this backwards
// forgives phone reading and flags students who glance UP at the ceiling to
// think — the precise inversion this module exists to catch.
//
// So this file takes BOTH quantities as separately named inputs and never
// derives one from the other:
//
//   vRatio    absolute, 0 = upper lid .. 1 = lower lid. LARGER = further DOWN.
//   pitchDev  deviation from the student's own calibrated neutral.
//             MORE NEGATIVE = further DOWN.
//
// ⚠ 2. BOTH ARE REQUIRED, never either alone. This is the same belt-and-braces
// gaze_landmarks.js already applies to its own bands, and it is load-bearing in
// both directions. Absolute alone repeats the defect pose_geometry.js §7 exists
// to prevent: resting iris height genuinely differs between students (lid shape,
// epicanthic folds, camera height), so a fixed vRatio bar would accuse whoever
// naturally sits below it. Relative alone lets a student who calibrated while
// already looking at their phone normalise that posture into their own neutral.
//
// ⚠ 3. CLOSED EYES CANNOT REACH THIS DETECTOR, STRUCTURALLY. analyzeEye() in
// gaze_landmarks.js gates on ear < 0.20 BEFORE reading the iris and returns
// vRatio: NaN, so a blink produces no vertical reading at all — and a NaN is
// UNKNOWN here, never deviant. The explicit `ear` check below is a second layer,
// and DOWNWARD_GAZE_LOOKAWAY is on ear_veto.js's VETOABLE_VIOLATIONS as a third.
// The lash line reading low is exactly how a naive tracker turns a blink into
// "looking down at notes"; three independent layers is the correct amount of
// paranoia for that specific failure.
//
// ⚠ 4. THE KEYBOARD PERMIT IS NOT OPTIONAL — READ BEFORE TUNING sustainedMs.
// Looking down is what TYPING looks like. ear_veto.js's KeyboardGlancePermit
// exists precisely to forgive it, and a bare 1.2 s downward trigger would defeat
// that safeguard and accuse every hunt-and-peck typist in the cohort. So a
// forgiven frame is fed to the gate as NOT deviant: while the permit is granted
// no dwell accumulates at all.
//
// The permit already discriminates on the axis that separates the behaviours —
// a typist glances down briefly and often (each episode re-granted), a reader
// glances down at length and repeatedly (permitMs 5000 expires mid-episode, and
// maxLongGlances 3 in 60 s withdraws forgiveness entirely). Consequence, stated
// plainly: a FIRST sustained downward look is reported at ~permitMs + 1.2 s,
// not at 1.2 s. Once the long-glance budget is spent it is 1.2 s flat. That is a
// deliberate deviation from the brief's literal reading — see §7 of CLAUDE.md.
// =============================================================================

/* global DwellGate, GateState */

const DOWNWARD_GAZE_DEFAULTS = {
  // Spec: sustained downward gaze > 1.2 s.
  // glanceMs == alertMs because DwellGate tests alertMs FIRST, which makes the
  // LOW tier unreachable and yields exactly one HIGH event per episode.
  sustainedMs: 1200,

  // A blink mid-read must not restart the episode. Short, because a genuine
  // look-up-and-back is a different episode and should be treated as one.
  graceMs: 300,

  // Continuity, and re-alert spacing. Both inherited in spirit from the other
  // gates: two samples far apart are not proof of the interval between them.
  maxSampleGapMs: 2000,
  minRealertMs: 15000,

  // ABSOLUTE floor. gaze_landmarks.js's own downThreshold, reused rather than
  // re-picked so there is one definition of "the iris is low".
  downRatio: 0.62,

  // RELATIVE floor, in the same centred-ratio units the gaze baseline emits.
  // NEGATIVE IS DOWN — see the header.
  downPitchDev: -0.12,

  // "Severely downward", used only to escalate an already-raised event via
  // gaze_fusion. Never a trigger on its own.
  severeDownRatio: 0.72,
  severeDownPitchDev: -0.28,

  // Eyes must be measurably open. gaze_landmarks already refuses to emit a
  // vRatio below its own 0.20, so this is redundant by construction and kept
  // anyway: a future landmark source that forgets that gate must not silently
  // turn blinks into accusations here.
  earThreshold: 0.20,

  // ⚠ FRESHNESS OF THE ABSOLUTE READING. THIS GUARDS A CROSS-FRAME MIX.
  //
  // `vRatio` and `pitchDev` reach this module from DIFFERENT places. pitchDev
  // is the CURRENT frame's calibrated deviation. vRatio is read off the
  // analyser's `lastSample`, which gaze_landmarks.js assigns ONLY on a valid
  // sample and never clears on an unreadable one — so `lastSample` can outlive
  // the frame that produced it.
  //
  // Today the pairing is contemporaneous by coincidence: a finite pitchDev
  // implies a valid sample was taken on the same frame. That is an UNDOCUMENTED
  // INVARIANT holding a fairness guarantee together. If anyone later lets
  // `deviation` persist across frames, a stale iris height silently starts
  // satisfying the ABSOLUTE floor for a student who has already looked back up,
  // while a fresh pitchDev satisfies the relative one — an accusation assembled
  // from two different moments. That is a false accusation, so it gets an
  // explicit check rather than a comment.
  //
  // 300 ms is ~6 frames on Tier A and ~3 on Tier B: long enough that one
  // dropped landmark frame does not punch a hole in a genuine episode, short
  // enough that the reading still describes the current posture.
  maxSampleAgeMs: 300,
};

/** Why a frame was not counted as downward. Named so telemetry is auditable. */
const DOWNWARD_REASON = {
  DOWN: 'DOWN',
  UNREADABLE: 'UNREADABLE',
  STALE_SAMPLE: 'STALE_SAMPLE',
  EYES_CLOSED: 'EYES_CLOSED',
  HEAD_OFF_NEUTRAL: 'HEAD_OFF_NEUTRAL',
  NOT_DOWN: 'NOT_DOWN',
  KEYBOARD_FORGIVEN: 'KEYBOARD_FORGIVEN',
};

/**
 * Is this frame a downward gaze, and if not, why not?
 *
 * Pure. Returns `deviant: null` (UNKNOWN) rather than `false` whenever the frame
 * could not be read — the pipeline-wide rule that keeps an unreadable
 * observation from ageing a dwell gate as though it were compliance.
 *
 * @param {object} s
 * @param {number} s.vRatio      Absolute iris height, LARGER = further down.
 * @param {number} s.pitchDev    Deviation from own neutral, NEGATIVE = down.
 * @param {number} s.ear         Eye aspect ratio for this frame.
 * @param {boolean} s.headNeutral  Head inside its calibrated neutral band.
 * @param {boolean} s.permitGranted  KeyboardGlancePermit.isGranted(now).
 * @param {number} [s.sampleAgeMs]  Age of the vRatio reading. Omit when the
 *        caller does not track it — see the guard below.
 * @param {object} [options]
 * @returns {{deviant: boolean|null, reason: string, magnitude: number, severe: boolean}}
 */
function classifyDownward(s = {}, options = {}) {
  const opt = { ...DOWNWARD_GAZE_DEFAULTS, ...options };
  const { vRatio, pitchDev, ear, headNeutral, permitGranted, sampleAgeMs } = s;

  const out = (deviant, reason, magnitude = 0, severe = false) =>
    ({ deviant, reason, magnitude, severe });

  // Unreadable in either axis is UNKNOWN. Never a direction, never a magnitude.
  if (!Number.isFinite(vRatio) || !Number.isFinite(pitchDev)) {
    return out(null, DOWNWARD_REASON.UNREADABLE);
  }

  // ⚠ A STALE vRatio IS AN UNREADABLE ONE. See maxSampleAgeMs.
  //
  // Grouped with the UNREADABLE family deliberately: both return null, so the
  // ordering between them is a TELEMETRY LABELLING choice, not a safety one.
  // It sits above the EAR and neutrality tests because those describe the
  // CURRENT frame, whereas a stale vRatio means the absolute floor cannot be
  // evaluated against this moment at all — so no test downstream of it would
  // be meaningful.
  //
  // A NON-FINITE age means "the caller does not timestamp this source" and is
  // treated as fresh, NOT as stale. Failing the other way would let a caller
  // that simply omits the field silently disable the whole detector — a quiet
  // total loss of coverage, which is a worse failure than the narrow
  // cross-frame race this guards. monitor.js, the production caller, always
  // supplies it.
  if (Number.isFinite(sampleAgeMs) && sampleAgeMs > opt.maxSampleAgeMs) {
    return out(null, DOWNWARD_REASON.STALE_SAMPLE);
  }
  // Layer 2 of the closed-eye protection (layer 1 is upstream, layer 3 is the
  // EAR veto at the reporting choke point).
  if (Number.isFinite(ear) && ear < opt.earThreshold) {
    return out(null, DOWNWARD_REASON.EYES_CLOSED);
  }
  // Off-neutral frames belong to AI_CHEATING_POSE, which owns them on its own
  // evidence. Head rotation also shifts apparent iris position and this module
  // has no rotation compensation, so a reading taken there is not trustworthy.
  if (headNeutral === false) {
    return out(null, DOWNWARD_REASON.HEAD_OFF_NEUTRAL);
  }

  const down = vRatio >= opt.downRatio && pitchDev <= opt.downPitchDev;
  if (!down) return out(false, DOWNWARD_REASON.NOT_DOWN);

  // Magnitude in "how far past the relative floor", for peak reporting and for
  // ranking evidence frames. Absolute-only would be unfair across students.
  const magnitude = Math.abs(pitchDev - opt.downPitchDev);
  const severe = vRatio >= opt.severeDownRatio && pitchDev <= opt.severeDownPitchDev;

  // ⚠ Forgiveness is applied HERE, as "not deviant", not at report time. If it
  // were applied at report time the gate would already be latched in ALERT when
  // the permit lapsed, DwellGate emits 'alert' only once per episode, and the
  // violation would be swallowed forever. Feeding `false` keeps the gate idle
  // while typing is forgiven and starts a clean dwell the moment it is not.
  if (permitGranted === true) {
    return out(false, DOWNWARD_REASON.KEYBOARD_FORGIVEN, magnitude, severe);
  }

  return out(true, DOWNWARD_REASON.DOWN, magnitude, severe);
}

/**
 * Stateful detector. One instance per proctoring session.
 *
 * Owns a DwellGate (the frozen temporal_gate.js class, CONSUMED not modified)
 * so downward gaze inherits the same continuity guarantees every other
 * condition in this pipeline has.
 */
class DownwardGazeDetector {
  constructor(options = {}) {
    this.opt = { ...DOWNWARD_GAZE_DEFAULTS, ...options };
    this.gate = new DwellGate({
      glanceMs: this.opt.sustainedMs,
      alertMs: this.opt.sustainedMs,
      graceMs: this.opt.graceMs,
      maxSampleGapMs: this.opt.maxSampleGapMs,
      minRealertMs: this.opt.minRealertMs,
    });

    this.lastReason = DOWNWARD_REASON.UNREADABLE;
    this.lastSevere = false;
    this.suppressed = false;

    this.downSamples = 0;
    this.forgivenSamples = 0;
    this.unreadableSamples = 0;
    this.closedSamples = 0;
    this.staleSamples = 0;
    this.events = 0;
  }

  /**
   * Advance one frame.
   *
   * @param {object} sample - See classifyDownward.
   * @param {number} nowMs
   * @param {boolean} [suppress=false] - Withhold REPORTING only; the gate still
   *        runs, so an episode ages out honestly. Set while a liveness corner
   *        challenge is on screen, which orders the student to look off-axis.
   * @returns {{reason:string, severe:boolean, state:string, events:Array}}
   */
  process(sample, nowMs, suppress = false) {
    this.suppressed = !!suppress;
    const c = classifyDownward(sample, this.opt);

    this.lastReason = c.reason;
    this.lastSevere = c.severe;
    if (c.reason === DOWNWARD_REASON.DOWN) this.downSamples++;
    else if (c.reason === DOWNWARD_REASON.KEYBOARD_FORGIVEN) this.forgivenSamples++;
    else if (c.reason === DOWNWARD_REASON.EYES_CLOSED) this.closedSamples++;
    else if (c.reason === DOWNWARD_REASON.UNREADABLE) this.unreadableSamples++;
    else if (c.reason === DOWNWARD_REASON.STALE_SAMPLE) this.staleSamples++;

    const res = this.gate.update(c.deviant, nowMs, c.magnitude);
    const events = [];

    if (!this.suppressed && res.event === 'alert') {
      this.events++;
      events.push({
        condition: 'DOWNWARD_GAZE',
        // MEDIUM, matching the rest of the gaze family. gaze_fusion may raise
        // this to HIGH when the classifier independently agrees; nothing here
        // may ever reach CRITICAL.
        severity: 'MEDIUM',
        dwellMs: Math.round(res.dwellMs),
        peak: Number(res.peak.toFixed(3)),
        detail: {
          vRatio: Number.isFinite(sample.vRatio) ? Number(sample.vRatio.toFixed(3)) : null,
          pitchDev: Number.isFinite(sample.pitchDev) ? Number(sample.pitchDev.toFixed(3)) : null,
          ear: Number.isFinite(sample.ear) ? Number(sample.ear.toFixed(3)) : null,
          severe: c.severe,
          down_ratio_floor: this.opt.downRatio,
          down_pitch_floor: this.opt.downPitchDev,
          detector: 'downward_gaze_iris',
        },
      });
    }

    return { reason: c.reason, severe: c.severe, state: this.gate.state, events };
  }

  reset() {
    this.gate.reset();
    this.lastReason = DOWNWARD_REASON.UNREADABLE;
    this.lastSevere = false;
    this.suppressed = false;
    this.downSamples = 0;
    this.forgivenSamples = 0;
    this.unreadableSamples = 0;
    this.closedSamples = 0;
    this.staleSamples = 0;
    this.events = 0;
  }

  /**
   * Telemetry. Watch `forgiven` against `down`: a high forgiven count with zero
   * events is the keyboard safeguard working. A high `unreadable` count means
   * no landmark source is feeding this and the detector is inert.
   *
   * `stale` climbing means the landmark analyser is producing valid samples far
   * more slowly than the proctor loop runs — the detector is then mostly idle,
   * and the fix is upstream (frame rate or landmark coverage), not a bigger
   * maxSampleAgeMs. Raising the threshold to silence this counter re-opens the
   * cross-frame mix it exists to prevent.
   */
  telemetry() {
    return {
      state: this.gate.state,
      reason: this.lastReason,
      severe: this.lastSevere,
      suppressed: this.suppressed,
      down: this.downSamples,
      forgiven: this.forgivenSamples,
      unreadable: this.unreadableSamples,
      eyes_closed: this.closedSamples,
      stale: this.staleSamples,
      events: this.events,
      sustained_ms: this.opt.sustainedMs,
      max_sample_age_ms: this.opt.maxSampleAgeMs,
    };
  }
}

// ---------------------------------------------------------------------------
const __downwardGazeExports = {
  DOWNWARD_GAZE_DEFAULTS,
  DOWNWARD_REASON,
  classifyDownward,
  DownwardGazeDetector,
};

if (typeof module !== 'undefined' && module.exports) module.exports = __downwardGazeExports;
if (typeof window !== 'undefined') Object.assign(window, __downwardGazeExports);
