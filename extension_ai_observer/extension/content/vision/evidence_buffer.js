// =============================================================================
// Evidence Ring Buffer — AI Observer Extension
//
// THE PROBLEM. Every dwell-gated detector in this pipeline reports LATE, by
// construction. `poseGate.alertMs` is 2500 ms; the landmark gaze gate is 3000 ms.
// So `reportViolation` runs 2.5-3 s after the behaviour it is describing began,
// and `captureWebcamSnapshot()` at that moment photographs whatever the student
// is doing NOW — which, for a glance at notes, is usually "sitting normally
// again". The teacher then reviews an image that contradicts the alert.
//
// This keeps a short rolling history so the alert can be illustrated with the
// frame that actually earned it: the highest-scoring frame of the episode,
// including frames captured BEFORE the gate armed. That backward reach is the
// entire reason this is a buffer and not just a running maximum.
//
// -----------------------------------------------------------------------------
// WHY THIS DOES NOT LEAK, AND WHY IT COSTS ALMOST NOTHING
//
// 1. ⚠ ENTRIES ARE COMPRESSED STRINGS, NEVER CANVASES OR ImageData.
//    A ring of HTMLCanvasElement is a ring of GPU-backed surfaces the compositor
//    holds until GC gets to them — the exact churn monitor.js hoisted its single
//    `_snapCanvas` to avoid. A ring of ImageData is ~1.2 MB per 640x480 frame,
//    so a 4 s window at 6 FPS would be ~29 MB of retained heap on the machine
//    least able to afford it. Storing the JPEG data URL the shared canvas
//    already produced means each entry is an ordinary immutable string: nothing
//    to dispose, nothing pinned, and dropping the reference is the whole of the
//    cleanup. There is deliberately no dispose()/close() to forget to call.
//
// 2. ⚠ ENCODING IS LAZY. `capture()` takes a THUNK, not an image. The throttle
//    and the score floor are evaluated FIRST, and `encode()` — the expensive
//    part, a drawImage plus a toDataURL — runs only for frames that are actually
//    admitted. A rejected frame costs one subtraction and one comparison. This
//    is what keeps a per-frame call inside the tick budget; passing an
//    already-encoded image would pay the cost on every frame and discard most of
//    it.
//
// 3. Bounded on BOTH axes, because either alone is insufficient. `maxFrames`
//    alone lets a stalled loop hold frames indefinitely past their usefulness;
//    `windowMs` alone lets a fast machine hold an unbounded count inside the
//    window. The array can never exceed `maxFrames` entries.
//
// The buffer holds no opinion about what a violation is. It ranks frames by a
// score it is handed and returns the best one; every decision about whether an
// episode happened stays with the detectors and their dwell gates.
// =============================================================================

const EVIDENCE_BUFFER_DEFAULTS = {
  // Rolling history depth. The brief asks for ~3-5 s; 4 s covers the longest
  // dwell in the pipeline (the 3000 ms landmark gaze gate) with margin, so the
  // onset of every gated episode is still in the buffer when the gate fires.
  windowMs: 4000,

  // Hard ceiling on retained entries, independent of timing.
  maxFrames: 24,

  // Capture throttle. 150 ms is ~6.7 captures/s, well under either tier's frame
  // rate (20 FPS Tier A, 9 FPS Tier B), so most frames cost nothing but the
  // rejection test. Raising the rate buys finer peak resolution at a linear
  // cost in JPEG encodes.
  minIntervalMs: 150,

  // Frames below this score are not worth an encode. Most of an exam is a
  // student sitting still and looking at the screen; without this floor the
  // buffer would spend its entire budget on neutral frames and then have no
  // room for the one that matters. It is NOT a detection threshold — nothing is
  // reported or suppressed on the strength of it.
  minScore: 0.05,
};

/** Which signal produced a frame's score. Recorded so evidence is attributable. */
const EVIDENCE_SOURCE = {
  POSE: 'pose',
  GAZE: 'gaze',
  CLASSIFIER: 'classifier',
  NONE: 'none',
};

/**
 * Rank one frame for evidential value, on a common 0..1 scale.
 *
 * Pure, so it can be tested without a canvas. Takes the MAX rather than a sum
 * or a mean: this is "how strong is the best reason to keep this frame", and
 * averaging would let two quiet signals outrank one loud one, which is the
 * wrong frame to show a teacher. The winning source is returned alongside the
 * score so the attached evidence can say WHY it was chosen.
 *
 * ⚠ This ranks frames WITHIN an episode. It is not a detector and must never
 * become one — nothing may read the returned score and decide a violation
 * occurred. Excursions are already deviations from the student's own calibrated
 * neutral, so 1.0 means "at this student's own tolerance boundary"; the
 * full-scale divisor maps 2x that boundary to 1.0 and keeps ordering monotone
 * above it.
 *
 * @param {{poseExcursion?:number, gazeExcursion?:number, classifierProb?:number}} parts
 * @param {{excursionFullScale?:number}} [options]
 * @returns {{score:number, source:string}}
 */
function evidenceScore(parts = {}, options = {}) {
  const fullScale = Number.isFinite(options.excursionFullScale) && options.excursionFullScale > 0
    ? options.excursionFullScale
    : 2;

  const fromExcursion = (v) => (Number.isFinite(v) && v > 0 ? Math.min(1, v / fullScale) : 0);
  const fromProb = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

  const candidates = [
    { source: EVIDENCE_SOURCE.POSE, value: fromExcursion(parts.poseExcursion) },
    { source: EVIDENCE_SOURCE.GAZE, value: fromExcursion(parts.gazeExcursion) },
    { source: EVIDENCE_SOURCE.CLASSIFIER, value: fromProb(parts.classifierProb) },
  ];

  let best = { source: EVIDENCE_SOURCE.NONE, value: 0 };
  for (const c of candidates) {
    if (c.value > best.value) best = c;
  }
  return { score: best.value, source: best.source };
}

/**
 * Fixed-capacity, time-bounded history of scored evidence frames.
 *
 * Backed by a plain array rather than a head-index circular buffer. At
 * `maxFrames: 24` a shift() moves at most 23 element slots — utterly negligible
 * next to the JPEG encode that produced the entry — and the array version has
 * no wrap-around arithmetic to get wrong. Correctness is the better trade here.
 */
class EvidenceRingBuffer {
  constructor(options = {}) {
    this.opt = { ...EVIDENCE_BUFFER_DEFAULTS, ...options };
    /** @type {Array<{t:number, score:number, source:string, image:string}>} */
    this._items = [];
    this._lastCaptureMs = -Infinity;

    this.captures = 0;
    this.throttled = 0;
    this.belowFloor = 0;
    this.evicted = 0;
    this.encodeFailures = 0;
  }

  /** @returns {number} Entries currently retained. */
  get size() {
    return this._items.length;
  }

  /**
   * Offer one frame to the buffer.
   *
   * @param {number} nowMs - Monotonic timestamp (performance.now()).
   * @param {{score:number, source?:string}|number} scored - Score, or the object
   *        evidenceScore() returned.
   * @param {Function} encode - Thunk returning a data URL, or null/'' on
   *        failure. ⚠ Called ONLY if the frame is admitted — see the header.
   * @returns {object|null} The stored entry, or null when not admitted.
   */
  capture(nowMs, scored, encode) {
    if (!Number.isFinite(nowMs)) return null;

    const score = typeof scored === 'object' && scored !== null ? scored.score : scored;
    const source = (typeof scored === 'object' && scored !== null && scored.source)
      ? scored.source
      : EVIDENCE_SOURCE.NONE;

    this.prune(nowMs);

    if (!Number.isFinite(score) || score < this.opt.minScore) {
      this.belowFloor++;
      return null;
    }
    if ((nowMs - this._lastCaptureMs) < this.opt.minIntervalMs) {
      this.throttled++;
      return null;
    }
    if (typeof encode !== 'function') return null;

    // The one expensive line in this file, reached only by admitted frames.
    let image = null;
    try {
      image = encode();
    } catch (err) {
      image = null;
    }
    if (!image) {
      this.encodeFailures++;
      return null;
    }

    this._lastCaptureMs = nowMs;
    const entry = { t: nowMs, score, source, image };
    this._items.push(entry);

    while (this._items.length > this.opt.maxFrames) {
      this._items.shift();
      this.evicted++;
    }
    this.captures++;
    return entry;
  }

  /**
   * Highest-scoring retained frame at or after `sinceMs`.
   *
   * ⚠ Does NOT prune. Pruning on read could discard the very frame being asked
   * for when a caller reaches back across the window boundary, which would
   * silently degrade this to the live-snapshot behaviour it replaces.
   *
   * Ties resolve to the EARLIER frame: the first moment the peak was reached is
   * closer to the onset of the behaviour, and later frames of equal score are
   * more likely to catch the student already returning to neutral.
   *
   * @param {number} sinceMs - Episode start. Pass -Infinity for "anything held".
   * @returns {{t:number, score:number, source:string, image:string}|null}
   */
  peakSince(sinceMs) {
    const floor = Number.isFinite(sinceMs) ? sinceMs : -Infinity;
    let best = null;
    for (const e of this._items) {
      if (e.t < floor) continue;
      if (!best || e.score > best.score) best = e;
    }
    return best;
  }

  /**
   * Drop entries older than the window. Idempotent.
   * @param {number} nowMs
   */
  prune(nowMs) {
    if (!Number.isFinite(nowMs)) return;
    const cutoff = nowMs - this.opt.windowMs;
    while (this._items.length && this._items[0].t < cutoff) {
      this._items.shift();
      this.evicted++;
    }
  }

  /**
   * Release every retained frame.
   *
   * Truncating the array drops the last reference to each data URL string, which
   * is the entirety of the cleanup — see point 1 in the header. Call on session
   * teardown and whenever AI decision state is reset, so evidence from a
   * previous session can never be attached to a new one's alert.
   */
  clear() {
    this._items.length = 0;
    this._lastCaptureMs = -Infinity;
  }

  /** Compact counters for telemetry. Never used for decisions. */
  telemetry() {
    const oldest = this._items.length ? this._items[0] : null;
    const newest = this._items.length ? this._items[this._items.length - 1] : null;
    return {
      size: this._items.length,
      max_frames: this.opt.maxFrames,
      window_ms: this.opt.windowMs,
      captures: this.captures,
      throttled: this.throttled,
      below_floor: this.belowFloor,
      evicted: this.evicted,
      encode_failures: this.encodeFailures,
      span_ms: oldest && newest ? Math.round(newest.t - oldest.t) : 0,
      peak_score: this._items.reduce((m, e) => (e.score > m ? e.score : m), 0),
    };
  }
}

// ---------------------------------------------------------------------------
const __evidenceBufferExports = {
  EVIDENCE_BUFFER_DEFAULTS,
  EVIDENCE_SOURCE,
  evidenceScore,
  EvidenceRingBuffer,
};

if (typeof module !== 'undefined' && module.exports) module.exports = __evidenceBufferExports;
if (typeof window !== 'undefined') Object.assign(window, __evidenceBufferExports);
