// =============================================================================
// landmark_adapter.test.js — PLAN.md §6 Phase 4, risk R1 + R2.
//
// THE REGRESSION THIS FILE EXISTS FOR, stated once:
//
//   MediaPipe normalises x by frame WIDTH and y by frame HEIGHT independently.
//   Every upstream quantity is a ratio of DISTANCES, so feeding normalised
//   coordinates straight in scales the vertical and horizontal legs by
//   different factors and multiplies EAR by exactly W/H.
//
// ⚠ WHY A TEST AND NOT A COMMENT. The adapter looks like ceremony — three lines
// of multiplication wrapped in an arity check — and every existing suite in this
// repo is written in pixel space, so all 297 of them pass with the adapter
// deleted. Nothing else in the codebase can observe the difference. Without the
// assertions below, "simplify the pointless conversion" is a change that goes
// green and silently reinstates closed eyes producing a confident gaze direction
// — the precise defect the whole architecture exists to prevent.
//
// BOTH DIRECTIONS ARE ASSERTED, because the failure is not "EAR gets bigger", it
// is "EAR gets multiplied by an aspect ratio", and that ratio can sit on either
// side of 1:
//
//   LANDSCAPE (640x480, W/H = 1.333) — EAR INFLATES.
//       A genuinely CLOSED eye at pixel EAR 0.18 reads 0.24, clears the
//       `ear < 0.20` gate in gaze_landmarks.js, and the analyser emits a
//       confident direction from a shut eye. This is the accusing direction and
//       it is the one PLAN.md R1 names.
//
//   PORTRAIT (480x640, W/H = 0.75) — EAR DEFLATES.
//       A genuinely OPEN eye at pixel EAR 0.26 reads 0.195 and is rejected as
//       EYE_CLOSED. Nobody is accused, so this direction is *safe* — but it is
//       not harmless: the gaze channel goes silent on a readable face and the
//       symptom presents as "the demo never detects anything", with no error
//       anywhere. A one-directional test would let a "clamp it to >= 1" fix look
//       correct. Phone cameras in portrait produce exactly this frame.
//
// Both cases are run through the SAME analyser the engine uses, not through a
// re-implementation of EAR, so the numbers below are the engine's own verdicts.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { analyzeGazeLandmarks, LANDMARK_CONTRACT } from '../gaze_landmarks.js';
// ⚠ PLAN.md §6: the adapters live in `src/vision/adapters/`, NOT at the
// `src/vision/` root. The subdirectory is what keeps the six byte-identical
// ported modules unmixed with new code, which is what makes
// check-vision-sync.mjs's job obvious to a reader.
import {
  toPixelLandmarks,
  faceToCocoPerson,
  faceToCocoPersonFromNormalized,
  COCO_PROJECTION,
} from '../adapters/landmark_adapter.js';
import {
  syntheticFace,
  toNormalizedLandmarks,
  COCO5_LAYOUT,
} from '../testing/synthetic_face.js';

/**
 * Build one face at a known PIXEL EAR, then hand it back the way MediaPipe
 * would: normalised against the given frame.
 */
function normalizedFaceAt(ear, frameW, frameH, opts = {}) {
  return toNormalizedLandmarks(syntheticFace({ ear, ...opts }), frameW, frameH);
}

// =============================================================================
// R1 — THE ANISOTROPY REGRESSION, BOTH DIRECTIONS
// =============================================================================

describe('R1 — normalised coordinates fed straight in (THE BUG)', () => {
  it('landscape 640x480 inflates a closed eye past the gate: 0.18 -> 0.24, valid', () => {
    const bug = analyzeGazeLandmarks(normalizedFaceAt(0.18, 640, 480));

    // 0.18 * (640/480) = 0.24. The eye is SHUT and the analyser says otherwise.
    expect(bug.ear).toBeCloseTo(0.24, 10);
    expect(bug.valid).toBe(true);
    expect(bug.reason).toBe(null);
    // And it does not stop at "valid" — it publishes a direction, which is the
    // accusation. A shut eye must never reach this state.
    expect(Number.isFinite(bug.hRatio)).toBe(true);
  });

  it('landscape 1280x720 inflates harder (ratio 1.778): 0.15 -> 0.267, valid', () => {
    const bug = analyzeGazeLandmarks(normalizedFaceAt(0.15, 1280, 720));

    expect(bug.ear).toBeCloseTo(0.15 * (1280 / 720), 10);
    expect(bug.valid).toBe(true);
  });

  it('portrait 480x640 DEFLATES an open eye below the gate: 0.26 -> 0.195, EYE_CLOSED', () => {
    // The other direction. Nobody is accused — the channel just goes quiet on a
    // perfectly readable face, with no error raised anywhere.
    const bug = analyzeGazeLandmarks(normalizedFaceAt(0.26, 480, 640));

    expect(bug.ear).toBeCloseTo(0.195, 10);
    expect(bug.valid).toBe(false);
    expect(bug.reason).toBe('EYE_CLOSED');
    // Unknown means UNKNOWN: no direction, no magnitude. CLAUDE.md §5.
    expect(Number.isFinite(bug.hRatio)).toBe(false);
  });

  it('the inflation lands exactly ON the threshold at pixel EAR 0.15 / 640x480', () => {
    // A supporting data point, kept because it is the number PLAN.md R1 quotes
    // and because it shows how narrow the margin is: 0.15 * 4/3 evaluates to
    // 0.19999999999999998, so this one case still reads EYE_CLOSED — by a float.
    // Anyone "confirming the bug" with this input alone would conclude there was
    // no bug. That is why 0.18 is the case asserted above.
    const bug = analyzeGazeLandmarks(normalizedFaceAt(0.15, 640, 480));

    expect(bug.ear).toBeCloseTo(0.2, 10);
    expect(bug.valid).toBe(false);
  });
});

describe('R1 — the same faces through toPixelLandmarks (THE FIX)', () => {
  const cases = [
    { label: 'landscape 640x480', ear: 0.18, w: 640, h: 480, valid: false },
    { label: 'landscape 1280x720', ear: 0.15, w: 1280, h: 720, valid: false },
    { label: 'portrait 480x640', ear: 0.26, w: 480, h: 640, valid: true },
  ];

  for (const c of cases) {
    it(`${c.label} recovers the true pixel EAR ${c.ear}`, () => {
      const normalized = normalizedFaceAt(c.ear, c.w, c.h);
      const fixed = analyzeGazeLandmarks(toPixelLandmarks(normalized, c.w, c.h));

      // The aspect ratio is gone: the analyser sees the EAR the eye actually has,
      // at every frame shape, which is the entire point of the adapter.
      expect(fixed.ear).toBeCloseTo(c.ear, 10);
      expect(fixed.valid).toBe(c.valid);
    });
  }

  it('the closed eye is rejected with EYE_CLOSED and carries no geometry', () => {
    const normalized = normalizedFaceAt(0.18, 640, 480);
    const fixed = analyzeGazeLandmarks(toPixelLandmarks(normalized, 640, 480));

    expect(fixed.reason).toBe('EYE_CLOSED');
    expect(Number.isFinite(fixed.hRatio)).toBe(false);
    expect(Number.isFinite(fixed.vRatio)).toBe(false);
  });
});

// =============================================================================
// THE MITIGATION IS THE SIGNATURE — required arity, no defaults
// =============================================================================

describe('toPixelLandmarks — frame dimensions are REQUIRED', () => {
  const face = normalizedFaceAt(0.30, 640, 480);

  it('throws when frameHeight is omitted', () => {
    expect(() => toPixelLandmarks(face, 640)).toThrow(TypeError);
  });

  it('throws when both dimensions are omitted', () => {
    expect(() => toPixelLandmarks(face)).toThrow(TypeError);
  });

  it('throws on a non-number dimension rather than coercing it', () => {
    // `'640' * 0.5` is 320 — a plausible-looking number. The check is on TYPE
    // for that reason: a string from a dataset attribute must not silently work.
    expect(() => toPixelLandmarks(face, '640', '480')).toThrow(TypeError);
  });

  it('the message names the defect, not just the argument', () => {
    // Whoever hits this at 2am gets the reason, not "invalid argument".
    expect(() => toPixelLandmarks(face)).toThrow(/EAR|blink immunity|R1/);
  });

  it('does NOT throw for a zero dimension — that is a frame problem, not a call bug', () => {
    // A video reporting 0x0 has simply not produced a frame yet. That is an
    // unreadable observation (-> null), not a programming error (-> throw).
    expect(() => toPixelLandmarks(face, 0, 0)).not.toThrow();
    expect(toPixelLandmarks(face, 0, 0)).toBe(null);
  });
});

describe('toPixelLandmarks — unreadable inputs return null, never a guess', () => {
  it('null / undefined / non-array', () => {
    expect(toPixelLandmarks(null, 640, 480)).toBe(null);
    expect(toPixelLandmarks(undefined, 640, 480)).toBe(null);
    expect(toPixelLandmarks({ 0: { x: 1, y: 1 } }, 640, 480)).toBe(null);
  });

  it('a short set is a DIFFERENT MODEL, not a bad frame', () => {
    // 468 points means refine_landmarks is off, so there are no irises at
    // 468/473. Guessing which points are missing is the "synthesise the
    // landmarks" failure CLAUDE.md forbids by name.
    const short = new Array(LANDMARK_CONTRACT.pointCount - 1).fill({ x: 0.5, y: 0.5 });
    expect(toPixelLandmarks(short, 640, 480)).toBe(null);
  });

  it('a zero-sized frame collapses every point onto the origin, so it is refused', () => {
    // Scaling by zero reads as a perfectly closed eye staring dead ahead — a
    // fabricated reading, which is worse than a missing one.
    const face = normalizedFaceAt(0.30, 640, 480);
    expect(toPixelLandmarks(face, 640, 0)).toBe(null);
    expect(toPixelLandmarks(face, 0, 480)).toBe(null);
  });
});

describe('toPixelLandmarks — per-point holes are PRESERVED, not fatal', () => {
  const sparse = normalizedFaceAt(0.30, 640, 480);
  const out = toPixelLandmarks(sparse, 640, 480);

  it('returns a full-length array', () => {
    expect(out.length).toBe(LANDMARK_CONTRACT.pointCount);
  });

  it('an unpopulated index becomes null, and the frame survives', () => {
    // Every synthetic fixture in this repo is deliberately sparse — only the ten
    // LANDMARK_CONTRACT indices are populated. An earlier draft voided the whole
    // frame on any hole, which never fires in production (MediaPipe always fills
    // all 478) and silently made the headless seam untestable.
    expect(out[0]).toBe(null);
    expect(out[477]).toBe(null);
    expect(out[LANDMARK_CONTRACT.left.iris]).not.toBe(null);
  });

  it('scales the populated points by the right axis each', () => {
    // The fixture puts both irises on the eye line at y = 100 px, so the
    // normalise/denormalise round trip must return them exactly.
    expect(out[LANDMARK_CONTRACT.right.iris]).toEqual({ x: 200, y: 100 });
    expect(out[LANDMARK_CONTRACT.left.iris]).toEqual({ x: 300, y: 100 });
  });

  it('⚠ omits `score` — wiring it through would reject all 478 points', () => {
    // FaceLandmarker reports visibility as a constant 0, and gaze_landmarks.js's
    // pick() rejects a point only when `typeof p.score === 'number'` and it is
    // below threshold. Adding the field would make the engine report "no face"
    // against a perfectly good one. Absent means "not measured" — the honest
    // answer. Do not "improve" this.
    expect(Object.keys(out[LANDMARK_CONTRACT.left.iris])).toEqual(['x', 'y']);
  });
});

// =============================================================================
// R2 — THE COCO-5 DOWN-PROJECTION
// =============================================================================

describe('faceToCocoPerson — projection, not fabrication', () => {
  // All five indices genuinely exist in the 478-set; they are re-labelled into
  // the layout pose_geometry.js expects, never invented.
  it('pins the five source indices by name', () => {
    expect(COCO_PROJECTION.NOSE).toBe(1);
    expect(COCO_PROJECTION.LEFT_EYE).toBe(LANDMARK_CONTRACT.left.iris);   // 473
    expect(COCO_PROJECTION.RIGHT_EYE).toBe(LANDMARK_CONTRACT.right.iris); // 468
    expect(COCO_PROJECTION.LEFT_EAR).toBe(454);
    expect(COCO_PROJECTION.RIGHT_EAR).toBe(234);
  });

  it('emits COCO order: nose, left eye, right eye, left ear, right ear', () => {
    const person = faceToCocoPerson(syntheticFace({ pose: {} }));

    expect(person.keypoints.length).toBe(5);
    expect(person.keypoints.map((k) => ({ x: k.x, y: k.y }))).toEqual([
      // nose: socket midpoint, pushed down the eye line by the default pitch.
      { x: COCO5_LAYOUT.socketMidX, y: COCO5_LAYOUT.eyeLineY + 0.45 * COCO5_LAYOUT.nominalInterocular },
      { x: 300, y: COCO5_LAYOUT.eyeLineY },                    // subject's LEFT eye, image-right
      { x: 200, y: COCO5_LAYOUT.eyeLineY },                    // subject's RIGHT eye, image-left
      { x: COCO5_LAYOUT.leftTragionX, y: COCO5_LAYOUT.eyeLineY },
      { x: COCO5_LAYOUT.rightTragionX, y: COCO5_LAYOUT.eyeLineY },
    ]);
  });

  it('⚠ sets score on EVERY keypoint — computeHeadPose reads it unconditionally', () => {
    // `undefined < 0.40` is false, but every arithmetic use of it yields NaN, so
    // the pose resolves to LOW_CONFIDENCE on every frame and nobody ever
    // calibrates. The symptom is "R2 does not work", not "a field is missing".
    const person = faceToCocoPerson(syntheticFace({ pose: {} }));
    expect(person.keypoints.every((k) => k.score === 1)).toBe(true);
  });

  it('⚠ sets the PERSON-level score — the pipeline filters on it first', () => {
    // pose_pipeline.js:153 filters `persons.filter(p => p && p.score >= minPersonScore)`
    // BEFORE computeHeadPose inspects a single keypoint. A person object carrying
    // only per-keypoint scores is dropped silently: personCount reads 0 and
    // calibration never starts.
    expect(faceToCocoPerson(syntheticFace({ pose: {} })).score).toBe(1);
  });

  it('a PARTIAL projection is null — an unreadable observation, not a weak one', () => {
    // The default fixture has irises but no nose and no tragions. Emitting a
    // person with holes would let computeHeadPose derive a confident angle from
    // points that are not there.
    expect(faceToCocoPerson(syntheticFace({}))).toBe(null);
  });

  it('rejects a short set and a non-array outright', () => {
    expect(faceToCocoPerson(null)).toBe(null);
    expect(faceToCocoPerson([])).toBe(null);
    expect(faceToCocoPerson(new Array(LANDMARK_CONTRACT.pointCount - 1))).toBe(null);
  });

  it('a single missing point voids the whole projection', () => {
    const face = syntheticFace({ pose: {} });
    face[COCO_PROJECTION.NOSE] = undefined;
    expect(faceToCocoPerson(face)).toBe(null);
  });
});

describe('faceToCocoPersonFromNormalized — same arity contract, one step', () => {
  it('matches the two-step path exactly', () => {
    const normalized = normalizedFaceAt(0.30, 640, 480, { pose: {} });

    expect(faceToCocoPersonFromNormalized(normalized, 640, 480))
      .toEqual(faceToCocoPerson(toPixelLandmarks(normalized, 640, 480)));
  });

  it('inherits the required-dimension TypeError', () => {
    const normalized = normalizedFaceAt(0.30, 640, 480, { pose: {} });
    expect(() => faceToCocoPersonFromNormalized(normalized)).toThrow(TypeError);
  });
});

// =============================================================================
// THE FIXTURE'S OWN CONTRACT
// =============================================================================

describe('toNormalizedLandmarks — the inverse carries the same requirement', () => {
  it('throws without both dimensions', () => {
    // A test that feeds a PIXEL-space fixture to the engine gets finite,
    // plausible numbers rather than an error (200 * 640 = 128000), so the
    // fixture builder enforces the same contract the adapter does.
    expect(() => toNormalizedLandmarks(syntheticFace({}), 640)).toThrow(TypeError);
  });

  it('round-trips through toPixelLandmarks', () => {
    const pixels = syntheticFace({ pose: {} });
    const back = toPixelLandmarks(toNormalizedLandmarks(pixels, 640, 480), 640, 480);

    expect(back[COCO_PROJECTION.NOSE]).toEqual({ x: 250, y: 145 });
    expect(back[LANDMARK_CONTRACT.right.iris]).toEqual({ x: 200, y: 100 });
  });
});
