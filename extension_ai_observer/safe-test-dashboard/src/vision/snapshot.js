// =============================================================================
// Evidence snapshot capture — PLAN.md §6 Phase 3, ported from monitor.js:409-421.
// =============================================================================

/**
 * One persistent offscreen canvas, reused for every capture.
 *
 * ⚠ SYNCHRONOUS `toDataURL`, NOT `toBlob`.
 *
 * This is the single most important line in the file. The capture must land on
 * the HIT FRAME — the frame that actually triggered the violation. `toBlob` is
 * asynchronous, so by the time its callback runs the student has already
 * lowered the phone or looked back at the screen, and the evidence photographs
 * an empty desk. That is precisely what someone hiding a phone is counting on.
 *
 * The cost is a synchronous encode on the main thread; at 640x480 JPEG q0.7
 * that is sub-millisecond and only happens on a violation, not every frame.
 *
 * ⚠ `drawImage(video, ...)` IGNORES CSS TRANSFORMS. The preview is mirrored by
 * exactly one `scaleX(-1)` on a wrapper element (PLAN.md R3), which does not
 * touch the pixels here — so the snapshot is UNMIRRORED and therefore in the
 * same coordinate space as the landmarks that triggered it. Do not "fix" the
 * snapshot to match what the student saw; it would then disagree with the
 * evidence.
 */
export function createSnapshotCapturer(options = {}) {
  const maxWidth = options.maxWidth ?? 640;
  const quality = options.quality ?? 0.7;
  const type = options.type ?? 'image/jpeg';
  const createCanvas = options.createCanvas ?? (() => document.createElement('canvas'));

  let canvas = null;
  let ctx = null;

  /**
   * @param {HTMLVideoElement} video
   * @returns {{dataUrl:string,width:number,height:number}|null} null when unreadable.
   */
  return function captureSnapshot(video) {
    const vw = video?.videoWidth | 0;
    const vh = video?.videoHeight | 0;
    // No frame means no evidence. Returning a blank image would be a fabricated
    // record attached to a real accusation — worse than no image at all.
    if (!vw || !vh) return null;

    const scale = Math.min(1, maxWidth / vw);
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));

    if (!canvas) {
      canvas = createCanvas();
      ctx = canvas.getContext('2d');
    }
    if (!ctx) return null;
    // Assigning width/height clears the canvas, so only do it on a real change.
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    try {
      ctx.drawImage(video, 0, 0, w, h);
      return { dataUrl: canvas.toDataURL(type, quality), width: w, height: h };
    } catch {
      // A tainted canvas or a torn-down video. Report nothing rather than a
      // partial image presented as evidence.
      return null;
    }
  };
}
