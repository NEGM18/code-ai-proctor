// =============================================================================
// gaze_fusion.test.js — gaze x classifier escalation
//
// This module does the one thing the pipeline previously refused to do, so most
// of these checks are about what it must NOT do. The headline properties, each
// asserted by name below:
//
//   * a low classifier score is never topped up by gaze into a HIGH-looking one
//   * a confident classifier is never double-counted
//   * a stale classifier reading cannot describe a current gaze episode
//   * an unreadable gaze is never "severe"
//   * fusion never produces a verdict from gaze alone
// =============================================================================

const assert = require('assert');
const path = require('path');

const {
  GAZE_FUSION_DEFAULTS,
  FUSION_VERDICT,
  isSevereGaze,
  fuseGazeEvidence,
  GazeClassifierFusion,
} = require(path.join(__dirname, '..', 'content', 'vision', 'gaze_fusion.js'));

let checks = 0;
let failures = 0;
function check(name, actual, expected) {
  checks++;
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function checkTrue(name, cond) { check(name, !!cond, true); }
function checkFalse(name, cond) { check(name, !!cond, false); }

/** A gaze episode that satisfies every gaze-side condition. */
const SEVERE = { gazeExcursion: 2.0, gazeAbsOffset: 0.25, gazeDwellMs: 2000 };
/** Fresh classifier reading sitting inside the uncertainty band. */
const fresh = (prob, ageMs = 0) => ({ classifierProb: prob, classifierAtMs: 1000 - ageMs });
const NOW = 1000;

const fuse = (over = {}) => fuseGazeEvidence({ ...SEVERE, ...fresh(0.60), nowMs: NOW, ...over });

console.log('\n=== isSevereGaze — BOTH conditions required ===');

checkTrue('severe when excursion and offset both clear their bars',
  isSevereGaze(2.0, 0.25));
checkFalse('excursion alone is not severe', isSevereGaze(2.0, 0.05));
checkFalse('absolute offset alone is not severe', isSevereGaze(0.5, 0.25));
checkFalse('neither is not severe', isSevereGaze(0.2, 0.02));

// Sign must not matter: a peek to either side is a peek.
checkTrue('a negative offset of equal magnitude is equally severe',
  isSevereGaze(2.0, -0.25));

// ⚠ An unmeasurable gaze is UNKNOWN, never deviant. This is the pipeline-wide
// rule that keeps "we could not see" from becoming "the student did something".
checkFalse('NaN excursion is not severe', isSevereGaze(NaN, 0.25));
checkFalse('NaN offset is not severe', isSevereGaze(2.0, NaN));
checkFalse('undefined inputs are not severe', isSevereGaze(undefined, undefined));

// Boundaries are inclusive, so the documented threshold is the threshold.
checkTrue('exactly at both thresholds is severe',
  isSevereGaze(GAZE_FUSION_DEFAULTS.severeExcursion, GAZE_FUSION_DEFAULTS.severeAbsOffset));
checkFalse('a hair under the excursion threshold is not',
  isSevereGaze(GAZE_FUSION_DEFAULTS.severeExcursion - 0.001, 0.25));

console.log('\n=== the boost case, as specified ===');

{
  const r = fuse({ ...fresh(0.60) });
  check('a mid-band classifier plus severe gaze boosts', r.verdict, FUSION_VERDICT.BOOST);
  check('boost flag is set', r.boost, true);
  check('the aggregate is raised by boostWeight', r.aggregate, 0.85);
}

check('the low edge of the band boosts', fuse({ ...fresh(0.50) }).verdict, FUSION_VERDICT.BOOST);
check('the high edge of the band boosts', fuse({ ...fresh(0.70) }).verdict, FUSION_VERDICT.BOOST);

// The aggregate is a bounded expression of agreement, never a claim of
// certainty — a fused number must not read as 1.0.
{
  const r = fuse({ ...fresh(0.70) });
  checkTrue('the aggregate never reaches 1.0', r.aggregate < 1);
  check('the aggregate is capped at maxAggregate', r.aggregate, 0.95);
}

console.log('\n=== ⚠ THE TWO-SIDED BAND — the "two weak signals" guard ===');

// Below the band the classifier is not evidence of anything. Allowing gaze to
// top it up is exactly the fallacy CLAUDE.md rejects: it would assemble a
// confident-looking HIGH out of a 0.2 classifier and a glance.
{
  const r = fuse({ ...fresh(0.20) });
  check('a LOW classifier is never boosted by gaze', r.verdict, FUSION_VERDICT.CLASSIFIER_BELOW_BAND);
  check('and no boost is applied', r.boost, false);
  check('and the classifier probability is passed through untouched', r.aggregate, 0.20);
}
check('just under the band does not boost',
  fuse({ ...fresh(GAZE_FUSION_DEFAULTS.uncertainMin - 0.001) }).boost, false);

// Above the band the classifier is already confident; boosting would
// double-count one model's opinion.
{
  const r = fuse({ ...fresh(0.92) });
  check('a CONFIDENT classifier is not boosted', r.verdict, FUSION_VERDICT.CLASSIFIER_ABOVE_BAND);
  check('and its own probability stands', r.aggregate, 0.92);
}
check('just over the band does not boost',
  fuse({ ...fresh(GAZE_FUSION_DEFAULTS.uncertainMax + 0.001) }).boost, false);

console.log('\n=== ⚠ STALENESS — a 6 s old reading describes a different moment ===');

{
  const r = fuse({ ...fresh(0.60, GAZE_FUSION_DEFAULTS.maxClassifierAgeMs + 1) });
  check('a stale classifier cannot boost', r.verdict, FUSION_VERDICT.CLASSIFIER_STALE);
  check('and no boost is applied', r.boost, false);
}
checkTrue('a reading exactly at the age limit still counts',
  fuse({ ...fresh(0.60, GAZE_FUSION_DEFAULTS.maxClassifierAgeMs) }).boost);

// Tier B runs the classifier every 6000 ms, so this is the ordinary case there,
// not an edge case.
check('a Tier B interval-old reading is stale',
  fuse({ ...fresh(0.60, 6000) }).verdict, FUSION_VERDICT.CLASSIFIER_STALE);

{
  const r = fuse({ classifierProb: NaN, classifierAtMs: NaN });
  check('no classifier reading at all yields NO_CLASSIFIER', r.verdict, FUSION_VERDICT.NO_CLASSIFIER);
  check('and reports no aggregate to attribute', r.aggregate, null);
}

console.log('\n=== ⚠ FUSION CANNOT CREATE A FINDING FROM GAZE ALONE ===');

// Every one of these has a perfect gaze signal. None boosts, because the
// classifier side is missing or unusable. Fusion escalates; it never accuses.
for (const [name, over] of [
  ['no classifier', { classifierProb: NaN, classifierAtMs: NaN }],
  ['stale classifier', fresh(0.60, 99999)],
  ['classifier below band', fresh(0.10)],
  ['classifier at zero', fresh(0)],
]) {
  checkFalse(`severe gaze + ${name} does not boost`, fuse(over).boost);
}

console.log('\n=== the gaze side is evaluated first, and gates independently ===');

check('a non-severe gaze reports GAZE_NOT_SEVERE',
  fuse({ gazeExcursion: 0.4, gazeAbsOffset: 0.02 }).verdict, FUSION_VERDICT.GAZE_NOT_SEVERE);
check('an unreadable gaze reports NO_GAZE',
  fuse({ gazeExcursion: NaN, gazeAbsOffset: NaN }).verdict, FUSION_VERDICT.NO_GAZE);

// Spec item 3: sustained for > 1.5 s. A brief severe flick does not qualify.
check('a gaze episode under sustainedMs does not boost',
  fuse({ gazeDwellMs: GAZE_FUSION_DEFAULTS.sustainedMs - 1 }).verdict,
  FUSION_VERDICT.GAZE_NOT_SUSTAINED);
checkTrue('a gaze episode at exactly sustainedMs boosts',
  fuse({ gazeDwellMs: GAZE_FUSION_DEFAULTS.sustainedMs }).boost);

// Ordering: a non-severe episode with a stale classifier must report the GAZE
// reason, because that is the thing being escalated. Misattributing it would
// send an operator to tune the wrong knob.
check('gaze reasons outrank classifier reasons in the verdict',
  fuseGazeEvidence({
    gazeExcursion: 0.1, gazeAbsOffset: 0.01, gazeDwellMs: 50,
    ...fresh(0.60, 99999), nowMs: NOW,
  }).verdict, FUSION_VERDICT.GAZE_NOT_SEVERE);

console.log('\n=== detail is auditable ===');

{
  const r = fuse({ ...fresh(0.60) });
  check('the band is recorded', r.detail.band, [0.50, 0.70]);
  check('the classifier probability is recorded', r.detail.classifier_prob, 0.6);
  check('the classifier age is recorded', r.detail.classifier_age_ms, 0);
  check('the severity verdict is recorded', r.detail.gaze_severe, true);
  check('the gaze dwell is recorded', r.detail.gaze_dwell_ms, 2000);
}

console.log('\n=== GazeClassifierFusion — stateful wrapper ===');

{
  const f = new GazeClassifierFusion();
  check('with no classifier submitted, nothing boosts',
    f.evaluate({ excursion: 2.0, absOffset: 0.25, dwellMs: 2000 }, NOW).verdict,
    FUSION_VERDICT.NO_CLASSIFIER);

  f.submitClassifier(0.60, NOW);
  const r = f.evaluate({ excursion: 2.0, absOffset: 0.25, dwellMs: 2000 }, NOW);
  check('after a fresh submission it boosts', r.verdict, FUSION_VERDICT.BOOST);
  check('boosts are counted', f.telemetry().boosts, 1);
  check('verdicts are tallied by name', f.telemetry().verdicts[FUSION_VERDICT.BOOST], 1);

  // The same reading, consulted 5 s later, has aged out.
  check('the same reading later is stale',
    f.evaluate({ excursion: 2.0, absOffset: 0.25, dwellMs: 2000 }, NOW + 5000).verdict,
    FUSION_VERDICT.CLASSIFIER_STALE);

  f.reset();
  check('reset clears the classifier sample',
    f.evaluate({ excursion: 2.0, absOffset: 0.25, dwellMs: 2000 }, NOW).verdict,
    FUSION_VERDICT.NO_CLASSIFIER);
  check('reset clears counters', f.telemetry().boosts, 0);
}

// Garbage submissions must not poison the state.
{
  const f = new GazeClassifierFusion();
  f.submitClassifier(NaN, NOW);
  check('a NaN probability is not recorded',
    f.evaluate({ excursion: 2.0, absOffset: 0.25, dwellMs: 2000 }, NOW).verdict,
    FUSION_VERDICT.NO_CLASSIFIER);
  f.submitClassifier(0.6, NaN);
  check('an untimed probability is not recorded',
    f.evaluate({ excursion: 2.0, absOffset: 0.25, dwellMs: 2000 }, NOW).verdict,
    FUSION_VERDICT.NO_CLASSIFIER);
}

console.log('\n=== a blinking student: closure is not a gaze direction ===');

// gaze_landmarks.js returns NaN ratios for a closed eye, so a blink reaches
// fusion as an unreadable gaze and can never be severe. This is the module-level
// half of the closed-eyes protection; the EAR veto at reportViolation() is the
// other half, and it still applies because a boosted event keeps its
// SIDE_GAZE_PEEKING type.
{
  const f = new GazeClassifierFusion();
  let boosts = 0;
  for (let t = 0; t < 30000; t += 100) {
    f.submitClassifier(0.65, t); // classifier says "cheating", mid-band, always fresh
    const r = f.evaluate({ excursion: NaN, absOffset: NaN, dwellMs: t }, t);
    if (r.boost) boosts++;
  }
  check('30 s of unreadable gaze produces zero boosts', boosts, 0);
}

console.log(`\n${checks} checks — ${failures ? `${failures} FAILED` : 'ALL PASS'}`);
process.exit(failures ? 1 : 0);
