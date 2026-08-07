// =============================================================================
// Gaze x Classifier Fusion — AI Observer Extension
//
// Spec: "if YOLO reports moderate uncertainty (0.50-0.70) but the gaze vector
// indicates a severe off-screen angle, boost the aggregate cheating score."
//
// -----------------------------------------------------------------------------
// ⚠ READ THIS FIRST. THIS FILE DOES THE ONE THING THE PIPELINE PREVIOUSLY
// REFUSED TO DO, AND THE CONSTRAINTS BELOW ARE WHAT MAKE IT SAFE.
//
// gaze_landmarks.js caps SIDE_GAZE_PEEKING at MEDIUM and says in-line that it is
// "never escalated by the classifier (which has no notion of eye direction
// either)". CLAUDE.md gives the reason: pairing two weak signals manufactures a
// strong-looking claim. That reasoning is sound and is NOT overturned here. What
// changes is narrower than it looks, and the difference is the whole safeguard:
//
//   ESCALATION, NEVER CREATION. This module cannot raise a violation. It is
//   consulted only on an event the gaze analyser ALREADY emitted on its own
//   evidence, having passed its own calibration, its own absolute band, its own
//   head-neutrality test and its own dwell gate. Fusion can move that event from
//   MEDIUM to HIGH. It can never move silence to an accusation.
//
// Four further bounds, each closing a specific failure:
//
//   1. THE BAND IS TWO-SIDED. Below 0.50 the classifier is not evidence of
//      anything and must not be topped up by gaze — that is the "two weak
//      signals" fallacy the codebase rejects, and allowing it would let a
//      confident-looking HIGH be assembled from a 0.2 classifier plus a glance.
//      Above 0.70 the classifier is already confident and needs no help; boosting
//      there would double-count one model's opinion. Only the genuinely
//      ambiguous middle is boostable, exactly as specified.
//
//   2. STALE CLASSIFIER READINGS CANNOT BOOST. The classifier is time-sliced at
//      3000 ms (Tier A) / 6000 ms (Tier B), so its last output can easily
//      pre-date the gaze episode entirely. Fusing a 6 s old probability with a
//      current gaze reading would assert the two describe the same moment when
//      they demonstrably do not. Past `maxClassifierAgeMs` there is no boost.
//
//   3. THE CEILING IS HIGH, NEVER CRITICAL. §6 of CLAUDE.md says
//      SIDE_GAZE_PEEKING is never CRITICAL. That survives: the caller maps a
//      boost to HIGH. `maxAggregate` also keeps the reported confidence below
//      1.0 so a fused number never reads as certainty.
//
//   4. THE TYPE DOES NOT CHANGE, SO THE EAR VETO STILL APPLIES. A boosted event
//      is still SIDE_GAZE_PEEKING, which is on ear_veto.js's VETOABLE_VIOLATIONS.
//      Minting a new violation type would have created an UNVETOABLE
//      eye-dependent accusation — unknown types are not vetoable by design — and
//      that would have reopened the closed-eyes defect through a new door. This
//      is also why the fusion lives here and not in a new violation type.
//
// SEVERITY IS MEASURED AGAINST THE STUDENT'S OWN NEUTRAL, plus an absolute
// bound, and BOTH are required — the same belt-and-braces gaze_landmarks.js
// already applies. A purely absolute test would repeat the defect
// pose_geometry.js §7 exists to prevent (resting iris position genuinely differs
// between honest students); a purely relative one lets a student who calibrated
// mid-glance normalise their own cheating.
//
// COST: a handful of comparisons on numbers the gaze analyser already computed.
// No pixels, no landmarks re-read, no allocation. Spec item 5's <5 ms budget is
// met with several orders of magnitude to spare.
// =============================================================================

const GAZE_FUSION_DEFAULTS = {
  // The ambiguity band, per spec. Two-sided on purpose — see bound 1.
  uncertainMin: 0.50,
  uncertainMax: 0.70,

  // "Severe off-screen angle", BOTH required:
  //   severeExcursion  - smoothed deviation from this student's own calibrated
  //                      neutral gaze. 1.0 is their tolerance boundary, so 1.6
  //                      is 60% beyond the point at which they already count as
  //                      off-axis.
  //   severeAbsOffset  - |hRatio - 0.5|, an absolute iris displacement across
  //                      the eye. 0.15 is the same magnitude ear_veto.js treats
  //                      as an unforgivable side peek.
  severeExcursion: 1.6,
  severeAbsOffset: 0.15,

  // The gaze episode must itself have been sustained this long. Spec item 3.
  // The analyser's own glance tier fires at exactly this dwell, so a boost can
  // never precede the detector's own first finding.
  sustainedMs: 1500,

  // Older classifier samples describe a different moment — see bound 2.
  maxClassifierAgeMs: 4000,

  // Reported confidence ceiling and the size of the boost. The boost is additive
  // and small: it expresses "two independent instruments agree", not "we are now
  // certain".
  maxAggregate: 0.95,
  boostWeight: 0.25,
};

/**
 * Why a fusion attempt did or did not boost. Every outcome is named so the
 * decision is auditable in telemetry rather than inferred from a boolean.
 */
const FUSION_VERDICT = {
  BOOST: 'BOOST',
  NO_GAZE: 'NO_GAZE',
  GAZE_NOT_SEVERE: 'GAZE_NOT_SEVERE',
  GAZE_NOT_SUSTAINED: 'GAZE_NOT_SUSTAINED',
  NO_CLASSIFIER: 'NO_CLASSIFIER',
  CLASSIFIER_STALE: 'CLASSIFIER_STALE',
  CLASSIFIER_BELOW_BAND: 'CLASSIFIER_BELOW_BAND',
  CLASSIFIER_ABOVE_BAND: 'CLASSIFIER_ABOVE_BAND',
};

/**
 * Is this gaze reading a "severe off-screen angle"?
 *
 * Requires the per-student excursion AND the absolute iris offset. Either alone
 * is insufficient — see the header. A non-finite reading is NOT severe: an
 * unmeasurable gaze is UNKNOWN, never deviant, which is the pipeline-wide rule
 * that keeps unreadable observations from becoming accusations.
 *
 * @param {number} excursion - Smoothed deviation from calibrated neutral gaze.
 * @param {number} absOffset - |hRatio - 0.5|, absolute iris displacement.
 * @param {object} [options]
 * @returns {boolean}
 */
function isSevereGaze(excursion, absOffset, options = {}) {
  const opt = { ...GAZE_FUSION_DEFAULTS, ...options };
  if (!Number.isFinite(excursion) || !Number.isFinite(absOffset)) return false;
  return excursion >= opt.severeExcursion && Math.abs(absOffset) >= opt.severeAbsOffset;
}

/**
 * Decide whether an already-raised gaze event should be escalated.
 *
 * @param {object} input
 * @param {number} [input.classifierProb]   - P(cheating) from best.onnx.
 * @param {number} [input.classifierAtMs]   - When that probability was produced.
 * @param {number} [input.gazeExcursion]    - Deviation from calibrated neutral.
 * @param {number} [input.gazeAbsOffset]    - |hRatio - 0.5|.
 * @param {number} [input.gazeDwellMs]      - Dwell of the gaze episode.
 * @param {number} input.nowMs              - Monotonic now.
 * @param {object} [options]
 * @returns {{verdict:string, boost:boolean, aggregate:number|null, detail:object}}
 *   `aggregate` is the boosted confidence when boosting, the unmodified
 *   classifier probability when one was available, and null when there was no
 *   usable classifier reading at all.
 */
function fuseGazeEvidence(input = {}, options = {}) {
  const opt = { ...GAZE_FUSION_DEFAULTS, ...options };

  const {
    classifierProb,
    classifierAtMs,
    gazeExcursion,
    gazeAbsOffset,
    gazeDwellMs,
    nowMs,
  } = input;

  const severe = isSevereGaze(gazeExcursion, gazeAbsOffset, opt);
  const classifierAgeMs = (Number.isFinite(nowMs) && Number.isFinite(classifierAtMs))
    ? nowMs - classifierAtMs
    : Infinity;

  const detail = {
    classifier_prob: Number.isFinite(classifierProb) ? Number(classifierProb.toFixed(3)) : null,
    classifier_age_ms: Number.isFinite(classifierAgeMs) ? Math.round(classifierAgeMs) : null,
    gaze_excursion: Number.isFinite(gazeExcursion) ? Number(gazeExcursion.toFixed(3)) : null,
    gaze_abs_offset: Number.isFinite(gazeAbsOffset) ? Number(gazeAbsOffset.toFixed(3)) : null,
    gaze_dwell_ms: Number.isFinite(gazeDwellMs) ? Math.round(gazeDwellMs) : null,
    gaze_severe: severe,
    band: [opt.uncertainMin, opt.uncertainMax],
  };

  const no = (verdict, aggregate = null) => ({ verdict, boost: false, aggregate, detail });

  // --- Gaze side first ------------------------------------------------------
  // Ordered so the gaze conditions are evaluated before the classifier ones: the
  // gaze event is the thing being escalated, and reporting "the classifier was
  // stale" for an episode that was never severe would misdescribe the reason.
  if (!Number.isFinite(gazeExcursion) || !Number.isFinite(gazeAbsOffset)) {
    return no(FUSION_VERDICT.NO_GAZE);
  }
  if (!severe) return no(FUSION_VERDICT.GAZE_NOT_SEVERE);
  if (!Number.isFinite(gazeDwellMs) || gazeDwellMs < opt.sustainedMs) {
    return no(FUSION_VERDICT.GAZE_NOT_SUSTAINED);
  }

  // --- Classifier side ------------------------------------------------------
  if (!Number.isFinite(classifierProb)) return no(FUSION_VERDICT.NO_CLASSIFIER);
  if (classifierAgeMs > opt.maxClassifierAgeMs) {
    return no(FUSION_VERDICT.CLASSIFIER_STALE, classifierProb);
  }
  if (classifierProb < opt.uncertainMin) {
    return no(FUSION_VERDICT.CLASSIFIER_BELOW_BAND, classifierProb);
  }
  if (classifierProb > opt.uncertainMax) {
    return no(FUSION_VERDICT.CLASSIFIER_ABOVE_BAND, classifierProb);
  }

  // Both instruments agree on an ambiguous moment. Boost, bounded.
  const aggregate = Math.min(opt.maxAggregate, classifierProb + opt.boostWeight);
  return {
    verdict: FUSION_VERDICT.BOOST,
    boost: true,
    aggregate: Number(aggregate.toFixed(3)),
    detail,
  };
}

/**
 * Thin stateful wrapper: remembers the most recent classifier reading so the
 * gaze path does not have to thread it through every call site, and counts
 * outcomes for telemetry.
 *
 * Deliberately holds NO gaze state. The gaze episode is owned by
 * GazeLandmarkAnalyzer's dwell gate, and duplicating any part of it here would
 * create a second, unsynchronised notion of "the current episode".
 */
class GazeClassifierFusion {
  constructor(options = {}) {
    this.opt = { ...GAZE_FUSION_DEFAULTS, ...options };
    this._prob = NaN;
    this._atMs = NaN;
    this.counts = {};
    this.boosts = 0;
  }

  /**
   * Record a classifier output.
   * @param {number} prob - P(cheating).
   * @param {number} nowMs
   */
  submitClassifier(prob, nowMs) {
    if (!Number.isFinite(prob) || !Number.isFinite(nowMs)) return;
    this._prob = prob;
    this._atMs = nowMs;
  }

  /** Most recent classifier sample, for telemetry and call sites that need it. */
  lastClassifier() {
    return { prob: this._prob, atMs: this._atMs };
  }

  /**
   * Evaluate a gaze event against the remembered classifier reading.
   *
   * @param {{excursion?:number, absOffset?:number, dwellMs?:number}} gaze
   * @param {number} nowMs
   * @returns {{verdict:string, boost:boolean, aggregate:number|null, detail:object}}
   */
  evaluate(gaze = {}, nowMs) {
    const result = fuseGazeEvidence({
      classifierProb: this._prob,
      classifierAtMs: this._atMs,
      gazeExcursion: gaze.excursion,
      gazeAbsOffset: gaze.absOffset,
      gazeDwellMs: gaze.dwellMs,
      nowMs,
    }, this.opt);

    this.counts[result.verdict] = (this.counts[result.verdict] || 0) + 1;
    if (result.boost) this.boosts++;
    return result;
  }

  reset() {
    this._prob = NaN;
    this._atMs = NaN;
    this.counts = {};
    this.boosts = 0;
  }

  telemetry() {
    return {
      boosts: this.boosts,
      verdicts: { ...this.counts },
      last_classifier_prob: Number.isFinite(this._prob) ? Number(this._prob.toFixed(3)) : null,
      band: [this.opt.uncertainMin, this.opt.uncertainMax],
    };
  }
}

// ---------------------------------------------------------------------------
const __gazeFusionExports = {
  GAZE_FUSION_DEFAULTS,
  FUSION_VERDICT,
  isSevereGaze,
  fuseGazeEvidence,
  GazeClassifierFusion,
};

if (typeof module !== 'undefined' && module.exports) module.exports = __gazeFusionExports;
if (typeof window !== 'undefined') Object.assign(window, __gazeFusionExports);
