// =============================================================================
// OverlayCanvas — the landmark overlay.
//
// ⚠⚠ R3. THERE IS NO TRANSFORM IN THIS FILE, AND THERE MUST NEVER BE ONE.
//
// This canvas is a child of the single `.demo-mirror` wrapper in
// CameraStage.jsx. Because the <video> and this <canvas> are flipped TOGETHER by
// that one ancestor, everything drawn here is drawn in RAW, UNMIRRORED
// VIDEO-PIXEL COORDINATES — precisely the space the ported geometry produces. So
// there is no flip arithmetic: no `vw - x`, no negative scale, no per-eye swap.
//
// Adding one would not throw and would not fail a test. Negating x before the
// math inverts the data-derived anchor in `orientedGazeRatio`, LEFT starts
// reading as RIGHT, and the geometry stays perfectly self-consistent while being
// exactly backwards. PLAN.md §8's manual check — cover your right eye, the
// dashed box must be on the same side as the hand you can see — is the only
// thing that catches it.
//
// (The `ctx.setTransform` below is NOT a flip: it is the object-fit: cover
// mapping from video pixels to backing-store pixels, and both of its scale terms
// are positive. A negative x-scale here would be a second mirror.)
//
// ⚠ AND NO TEXT. `fillText` here renders mirrored. Every label lives in the
// un-mirrored sibling layer outside the wrapper. This is why the eye boxes carry
// their meaning in COLOUR AND STROKE STYLE rather than in a caption.
// =============================================================================

import { useRef } from 'react';

import { LANDMARK_CONTRACT } from '../../vision/gaze_landmarks.js';
import { DEFAULT_VETO_OPTS } from '../../vision/ear_veto.js';
import { usePaintSubscriber } from '../../hooks/usePaintLoop.js';

/** Beyond 2x the backing store costs memory and bandwidth for no visible gain. */
const MAX_DPR = 2;

const THRESHOLD = DEFAULT_VETO_OPTS.earThreshold;

/**
 * Colours come from the CSS tokens, never from hex literals — theme.css is the
 * single place the verdict ramp is defined. A missing token falls back to the
 * element's own inherited `color` rather than to an invented value, so a broken
 * theme degrades to monochrome instead of to a wrong verdict colour.
 */
function readPalette(el) {
  const cs = getComputedStyle(el);
  const fallback = cs.color;
  const token = (name) => (cs.getPropertyValue(name) || '').trim() || fallback;
  return {
    verified: token('--color-verified'),
    violation: token('--color-violation'),
    glance: token('--color-glance'),
    unknown: token('--color-unknown'),
    unknownDim: token('--color-unknown-dim'),
  };
}

/**
 * Bounding box for one eye from its four lid/corner points.
 *
 * ⚠ The vertical padding is derived from the eye's WIDTH, not its height. A
 * closed eye has a near-zero lid gap, so a height-derived box collapses to a
 * line and the "grey dashed on EYE_CLOSED" signal — the one PLAN.md §8 asks the
 * tester to look for — becomes invisible exactly when it matters most.
 */
function eyeBounds(landmarks, idx) {
  const pts = [landmarks[idx.upperLid], landmarks[idx.lowerLid], landmarks[idx.inner], landmarks[idx.outer]];
  if (pts.some((p) => !p)) return null;

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX;
  const padX = w * 0.22;
  const padY = Math.max((maxY - minY) * 0.6, w * 0.30);
  return { x: minX - padX, y: minY - padY, w: w + padX * 2, h: (maxY - minY) + padY * 2 };
}

/**
 * One eye's verdict. `null` EAR and a sub-threshold EAR both resolve to the
 * UNKNOWN treatment: "we could not read this eye" and "this eye is shut" are
 * both non-answers, and neither may be drawn in a verdict colour.
 */
function eyeState(ear, gazeStatus) {
  if (ear === null || !Number.isFinite(ear)) return 'unknown';
  if (ear < THRESHOLD) return 'closed';
  if (gazeStatus === 'alert') return 'alert';
  if (gazeStatus === 'glance') return 'glance';
  if (gazeStatus === 'ok') return 'ok';
  return 'unknown';
}

/**
 * @param {object} props
 * @param {{current: object|null}} props.frameStateRef ⚠ paint-loop only.
 * @param {object} props.paintLoop
 * @param {boolean} [props.active]
 */
export default function OverlayCanvas({ frameStateRef, paintLoop, active = true }) {
  const canvasRef = useRef(null);
  const paletteRef = useRef(null);

  usePaintSubscriber(paintLoop, () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const host = canvas.parentElement;
    if (!host) return;

    // ---- backing store, resized ONLY on a real change -----------------------
    // Assigning canvas.width unconditionally clears AND reallocates the buffer
    // every frame — a GC churn that shows up as jitter at 60 Hz.
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const needW = Math.max(1, Math.round(host.clientWidth * dpr));
    const needH = Math.max(1, Math.round(host.clientHeight * dpr));
    if (canvas.width !== needW || canvas.height !== needH) {
      canvas.width = needW;
      canvas.height = needH;
      paletteRef.current = null;   // re-read tokens after a theme/DPR change
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, needW, needH);

    // ⚠ Read the ref HERE, inside the paint callback — never during render.
    const fs = frameStateRef.current;
    if (!fs || !fs.readable || !fs.landmarks) return;

    const vw = fs.frameW;
    const vh = fs.frameH;
    if (!vw || !vh) return;

    // ---- reproduce `object-fit: cover` --------------------------------------
    // A naive `needW / vw` is wrong on ANY aspect mismatch: the video is letter-
    // or pillar-boxed by CSS while the overlay is not, so every box lands off
    // the feature it is meant to mark. Math.max = cover; Math.min = contain.
    const scale = Math.max(needW / vw, needH / vh);
    ctx.setTransform(scale, 0, 0, scale, (needW - vw * scale) / 2, (needH - vh * scale) / 2);

    const px = 1 / scale;   // one screen pixel, in video-pixel units
    if (!paletteRef.current) paletteRef.current = readPalette(canvas);
    const palette = paletteRef.current;

    // ---- the 478-point cloud ------------------------------------------------
    // fillRect, not arc(). 478 arcs per frame is measurably more expensive and
    // visually identical at this size.
    const r = px;
    ctx.fillStyle = palette.unknownDim;
    ctx.globalAlpha = 0.85;
    for (let i = 0; i < fs.landmarks.length; i += 1) {
      const p = fs.landmarks[i];
      if (!p) continue;
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;

    // ---- per-eye boxes ------------------------------------------------------
    const gazeStatus = fs.gaze?.status ?? null;
    const eyes = [
      { idx: LANDMARK_CONTRACT.left, ear: fs.leftEar },
      { idx: LANDMARK_CONTRACT.right, ear: fs.rightEar },
    ];

    for (const eye of eyes) {
      const box = eyeBounds(fs.landmarks, eye.idx);
      if (!box) continue;

      const state = eyeState(eye.ear, gazeStatus);
      const unreadable = state === 'closed' || state === 'unknown';
      const stroke = state === 'alert' ? palette.violation
        : state === 'glance' ? palette.glance
          : state === 'ok' ? palette.verified
            : palette.unknown;

      ctx.lineWidth = px * 2;
      ctx.setLineDash(unreadable ? [px * 5, px * 4] : []);
      ctx.strokeStyle = stroke;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.setLineDash([]);

      // ---- the gaze vector --------------------------------------------------
      // ⚠ DRAWN ONLY ON A FINITE RATIO. A zero-length vector reads as "looking
      // straight ahead", which is a confident claim; the honest rendering of an
      // unmeasured direction is NO VECTOR AT ALL. The eye box above already says
      // "unreadable" on its own.
      const sample = fs.gazeSample;
      const iris = fs.landmarks[eye.idx.iris];
      if (!unreadable && iris && sample
          && Number.isFinite(sample.hRatio) && Number.isFinite(sample.vRatio)) {
        // No flip: +h is toward image-right because `orientedGazeRatio` anchors
        // at the smaller-x corner. The wrapper handles what the visitor sees.
        const dx = (sample.hRatio - 0.5) * 2 * (box.w * 0.9);
        const dy = (sample.vRatio - 0.5) * 2 * (box.h * 0.9);

        ctx.beginPath();
        ctx.moveTo(iris.x, iris.y);
        ctx.lineTo(iris.x + dx, iris.y + dy);
        ctx.lineWidth = px * 2;
        ctx.strokeStyle = stroke;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(iris.x + dx, iris.y + dy, px * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = stroke;
        ctx.fill();
      }
    }

    // ---- calibration ring ---------------------------------------------------
    // During warm-up the analysers are learning THIS student's neutral. Showing
    // progress is what stops the first ten seconds of nothing-happening from
    // reading as a broken demo.
    if (!fs.calibrated) {
      const li = fs.landmarks[LANDMARK_CONTRACT.left.iris];
      const ri = fs.landmarks[LANDMARK_CONTRACT.right.iris];
      if (li && ri) {
        const cx = (li.x + ri.x) / 2;
        const cy = (li.y + ri.y) / 2;
        const radius = Math.max(Math.abs(li.x - ri.x) * 1.15, px * 30);
        const progress = Math.min(1, Math.max(0, fs.calibrationProgress ?? 0));

        ctx.lineWidth = px * 3;
        ctx.strokeStyle = palette.unknownDim;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = palette.glance;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
        ctx.stroke();
      }
    }
  }, active);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="ph-no-capture ph-ignore-input pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
