// =============================================================================
// ONNX Detector Layer — AI Observer Extension
//
// Two stock Ultralytics models behind one scheduler:
//
//   POSE   (yolo11n-pose, 256px)  every frame  -> person boxes + COCO-17 keypoints
//   DETECT (yolo11n,      448px)  time-sliced  -> COCO objects, filtered to phones
//
// LETTERBOX, NOT CENTRE-CROP. The existing classifier centre-crops because that
// is what its weights were validated with, which throws away the left and right
// thirds of a 4:3 webcam. For these two models that would be self-defeating: the
// discarded region is exactly where a phone on the desk and a second person sit.
// Both are stock COCO models trained with letterboxing, so letterboxing is also
// the correct preprocessing for them. No conflict.
//
// The decode functions are pure and layout-agnostic (see decodeYoloOutput), so
// they are unit-testable in Node without ORT and survive an opset or exporter
// change that transposes the output.
// =============================================================================

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.__visionDetectors = factory();
    Object.assign(root, root.__visionDetectors);
  }
}(typeof self !== 'undefined' ? self : this, function () {

  /** COCO class index for a mobile phone in the standard 80-class ordering. */
  const COCO_CELL_PHONE = 67;
  /** Other objects worth flagging. Laptop/TV double as "second screen". */
  const COCO_LAPTOP = 63;
  const COCO_TV = 62;
  const COCO_BOOK = 73;
  const COCO_PERSON = 0;

  const DEFAULT_DETECT_OPTS = {
    // Which COCO classes to keep. Phones are the headline requirement; the
    // others are cheap to add since the model scores all 80 regardless.
    classFilter: [COCO_CELL_PHONE],
    scoreThreshold: 0.35,
    iouThreshold: 0.45,
    maxDetections: 20,
  };

  // -------------------------------------------------------------------------
  // Phone precision gate
  //
  // Two independent filters, applied AFTER decoding and NMS. Both exist to kill
  // the same failure: yolo11n scores rectangular dark objects in a cluttered
  // room as 'cell phone'.
  //
  // 1. CONFIDENCE stays HIGH and is never lowered. A notebook, a sticky-note
  //    block or a framed picture behind the student clears 0.35 routinely; it
  //    rarely clears 0.60. Lowering this to catch more glimpses trades one real
  //    detection for a stream of standing false alarms against honest students,
  //    which is the exact bug this pipeline exists to prevent. Recall for short
  //    glimpses is bought with FRAME COVERAGE (run every frame + latch), not
  //    with a lower threshold.
  //
  // 2. SHAPE. Phone screens are rectangles: 4:3 (1.33), 16:9 (1.78), 19.5:9
  //    (2.17). A 1:1 box is a sticky note, a coaster, a speaker grille or a
  //    box-regression artifact. Near-square boxes are not discarded outright —
  //    a phone held at a steep angle foreshortens toward square — they are held
  //    to a much higher confidence bar instead.
  // -------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // ⚠ 2026-08-08 — THE OPERATING POINT WAS DELIBERATELY MOVED TOWARD RECALL.
  //
  // These floors used to be minConfidence 0.60 / squareConfidence 0.75, and both
  // this file and CLAUDE.md said in terms: "Do not lower this. Lowering the
  // confidence floor WITHOUT restoring a dwell requirement WILL produce false
  // accusations." That warning has NOT been retracted and is NOT obsolete — it
  // was OVERRIDDEN by an explicit product decision after live testing found the
  // previous gate missing phones held at the frame edge or visible as only a
  // small cluster of pixels.
  //
  // WHAT THAT MEANS IN PRACTICE, STATED PLAINLY: a notebook, a sticky-note
  // block, a paperback or a framed picture clears 0.30 far more often than it
  // cleared 0.60. PHONE_DETECTED is CRITICAL severity and latches on a SINGLE
  // frame with no dwell, so a false hit is a CRITICAL accusation against a
  // student built from one frame of desk clutter. That is the accepted cost of
  // catching the 1-5 frame glance; it is not a side effect anyone overlooked.
  //
  // WHAT STILL DOES THE PRECISION WORK. The confidence floor is no longer the
  // main filter — the SHAPE and AREA guards are, and they were left intact
  // precisely because they cost nothing in recall for a real phone:
  //   * maxAspectRatio 4.0 kills pens, cables and edge artifacts at ANY score.
  //   * squareConfidence still holds near-square boxes to a much higher bar than
  //     rectangular ones. Squares are the single largest source of background
  //     false positives, so the RELATIVE discipline is preserved even though
  //     both absolute numbers came down.
  //   * the area guards still reject specks and frame-filling furniture.
  //
  // IF FALSE PHONE ALERTS APPEAR IN THE FIELD, THIS BLOCK IS THE FIRST THING TO
  // LOOK AT, and raising minConfidence back toward 0.60 is the one-line revert.
  // Watch the rejected-candidate telemetry from filterPhoneDetections: a room
  // full of rectangles now produces accepts where it used to produce rejects.
  // ---------------------------------------------------------------------------
  const PHONE_SHAPE_DEFAULTS = {
    /**
     * Minimum score for a well-proportioned (clearly rectangular) box.
     * Lowered 0.60 -> 0.30 for edge-of-frame and small-cluster phones.
     */
    minConfidence: 0.30,
    /**
     * Minimum score for a near-square box. Still deliberately punitive: it must
     * stay strictly ABOVE minConfidence, and phone_detection.test.js asserts
     * that ordering rather than the literal number. A phone held at a steep
     * angle foreshortens toward square, so squares are not discarded outright —
     * they just have to be much more convincing than a clean rectangle.
     */
    squareConfidence: 0.50,
    /** Below this longer/shorter-edge ratio a box counts as "square-ish". */
    minAspectRatio: 1.25,
    /** Above this it is a sliver (pen, cable, edge artifact), never a phone. */
    maxAspectRatio: 4.0,
    /**
     * Reject specks: fraction of frame area below which a box is noise.
     * Lowered 0.0006 -> 0.0002 so a phone showing as a small cluster of pixels
     * at the frame edge can still latch. At 640x480 that is ~61 px^2 (about
     * 8x8), which is near the limit of what the 448 detect input can resolve at
     * all — below it a box carries no shape information left to judge.
     */
    minAreaFraction: 0.0002,
    /** Reject a box covering most of the frame — that is furniture, not a phone. */
    maxAreaFraction: 0.35,
  };

  /**
   * Longer edge over shorter edge, so orientation does not matter: a phone held
   * portrait and the same phone held landscape both read ~1.78, and only a true
   * square reads ~1.0.
   *
   * @param {{x1:number,y1:number,x2:number,y2:number}} box
   * @returns {number} Ratio >= 1, or 0 for a degenerate box.
   */
  function boxAspectRatio(box) {
    const w = Math.abs(box.x2 - box.x1);
    const h = Math.abs(box.y2 - box.y1);
    if (w <= 0 || h <= 0) return 0;
    return Math.max(w, h) / Math.min(w, h);
  }

  /**
   * Decide whether one candidate is really a phone.
   *
   * Pure and side-effect free so the operating point is unit-testable without
   * ORT, a camera or a browser.
   *
   * @param {{score:number, box:object}} detection
   * @param {{width:number, height:number}} [frame] - Source frame size, for the
   *   area guards. Omit to skip them.
   * @param {object} [options] - Overrides for PHONE_SHAPE_DEFAULTS.
   * @returns {{accept:boolean, reason:string, aspectRatio:number, requiredConfidence:number, areaFraction:number|null}}
   */
  function evaluatePhoneShape(detection, frame, options = {}) {
    const opt = { ...PHONE_SHAPE_DEFAULTS, ...options };
    const ar = boxAspectRatio(detection.box);

    const result = {
      accept: false,
      reason: '',
      aspectRatio: Number(ar.toFixed(3)),
      requiredConfidence: opt.minConfidence,
      areaFraction: null,
    };

    if (ar <= 0) {
      result.reason = 'degenerate_box';
      return result;
    }

    if (ar > opt.maxAspectRatio) {
      result.reason = 'too_elongated';
      return result;
    }

    if (frame && frame.width > 0 && frame.height > 0) {
      const w = Math.abs(detection.box.x2 - detection.box.x1);
      const h = Math.abs(detection.box.y2 - detection.box.y1);
      const frac = (w * h) / (frame.width * frame.height);
      result.areaFraction = Number(frac.toFixed(5));

      if (frac < opt.minAreaFraction) {
        result.reason = 'too_small';
        return result;
      }
      if (frac > opt.maxAreaFraction) {
        result.reason = 'too_large';
        return result;
      }
    }

    // The shape guard: a square box has to be much more convincing.
    const isSquarish = ar < opt.minAspectRatio;
    result.requiredConfidence = isSquarish ? opt.squareConfidence : opt.minConfidence;

    if (detection.score < result.requiredConfidence) {
      result.reason = isSquarish ? 'square_below_high_confidence' : 'below_confidence';
      return result;
    }

    result.accept = true;
    result.reason = isSquarish ? 'square_but_high_confidence' : 'rectangular_high_confidence';
    return result;
  }

  /**
   * Apply the precision gate to a decoded detection list.
   *
   * Returns BOTH the survivors and the rejects. The rejects are not noise to be
   * thrown away — they are what tells an operator "the threshold is eating real
   * phones" versus "the room is full of rectangles", and they go into telemetry.
   *
   * @param {Array<{score:number, classId:number, box:object}>} detections
   * @param {{width:number, height:number}} [frame]
   * @param {object} [options]
   * @returns {{phones:Array, rejected:Array}}
   */
  function filterPhoneDetections(detections, frame, options = {}) {
    const phones = [];
    const rejected = [];

    for (const d of detections || []) {
      if (d.classId !== COCO_CELL_PHONE) continue;
      const verdict = evaluatePhoneShape(d, frame, options);
      if (verdict.accept) {
        phones.push({ ...d, shape: verdict });
      } else {
        rejected.push({ ...d, shape: verdict });
      }
    }

    return { phones, rejected };
  }

  // -------------------------------------------------------------------------
  // Latch & hold
  // -------------------------------------------------------------------------

  const DEFAULT_LATCH_OPTS = {
    /**
     * Frames the latch stays closed after the last hit. The spec's 30-60 frame
     * window; 45 is the middle of it.
     */
    holdFrames: 45,
    /**
     * Wall-clock floor on the same hold. BOTH must be satisfied before release.
     *
     * Frame counts alone are not a duration: this loop runs at ~20 FPS on a GPU
     * and ~9 FPS on a budget laptop, so "45 frames" is 2.2 s on one machine and
     * 5 s on another. And ms alone is not enough either — a machine that stalls
     * could satisfy 1500 ms in three frames. Requiring both makes the hold at
     * least 45 frames AND at least 1.5 s everywhere.
     */
    holdMs: 1500,
  };

  /**
   * Latch-and-hold buffer for split-second detections.
   *
   * The problem it solves: a student lifts a phone into frame for 4 frames and
   * drops it. Any dwell/persistence gate — which is the right tool for a
   * standing object like a second monitor — requires the object to survive
   * seconds and will therefore never see it. Here the FIRST qualifying hit
   * latches immediately, and the state is then held open for a minimum window
   * so the alert, the evidence snapshot and any downstream consumer all observe
   * it even though the phone is long gone.
   *
   * Once latched, further hits refresh the hold rather than re-latching, so one
   * continuous phone use produces one episode, not one per frame.
   */
  class DetectionLatch {
    constructor(options = {}) {
      this.opt = { ...DEFAULT_LATCH_OPTS, ...options };
      this.reset();
    }

    reset() {
      /** @type {boolean} True while the alert state is being held. */
      this.active = false;
      this._latchedAtMs = null;
      this._lastHitMs = null;
      /** Frames observed since the most recent hit. */
      this._framesSinceHit = 0;
      /** Total frames this episode has been held for. */
      this._heldFrames = 0;
      /** Hits observed during the current episode. */
      this.hitCount = 0;
      /** Highest score seen during the current episode. */
      this.peakScore = 0;
      /** Episodes latched since the last reset(). */
      this.episodes = 0;
    }

    /**
     * Advance by exactly one processed frame.
     *
     * @param {boolean} hit - True if a qualifying detection was present THIS frame.
     * @param {number} nowMs - Monotonic clock (performance.now()).
     * @param {number} [score=0] - Detection score, tracked as episode peak.
     * @returns {{active:boolean, event:'latch'|'hold'|'release'|null, heldFrames:number,
     *            heldMs:number, framesRemaining:number, hitCount:number, peakScore:number}}
     */
    update(hit, nowMs, score = 0) {
      let event = null;

      if (hit) {
        if (!this.active) {
          // FIRST qualifying frame latches. No dwell, no vote, no second
          // opinion — a 1-frame glimpse is the case this class exists for.
          this.active = true;
          this._latchedAtMs = nowMs;
          this._heldFrames = 0;
          this.hitCount = 0;
          this.peakScore = 0;
          this.episodes++;
          event = 'latch';
        }
        this._lastHitMs = nowMs;
        this._framesSinceHit = 0;
        this.hitCount++;
        this.peakScore = Math.max(this.peakScore, score);
      } else if (this.active) {
        this._framesSinceHit++;
      }

      if (!this.active) {
        return this._snapshot(event, nowMs);
      }

      this._heldFrames++;

      // Hold is measured from the LAST hit, so a phone that stays in frame keeps
      // the latch closed indefinitely and only starts expiring once it is gone.
      const sinceHitMs = nowMs - this._lastHitMs;
      const framesExpired = this._framesSinceHit >= this.opt.holdFrames;
      const timeExpired = sinceHitMs >= this.opt.holdMs;

      if (framesExpired && timeExpired) {
        const snap = this._snapshot('release', nowMs);
        this.active = false;
        this._latchedAtMs = null;
        this._lastHitMs = null;
        this._framesSinceHit = 0;
        this._heldFrames = 0;
        snap.active = false;
        snap.framesRemaining = 0;
        return snap;
      }

      return this._snapshot(event || 'hold', nowMs);
    }

    /** @returns {number} Frames remaining before the hold can release. */
    framesRemaining() {
      if (!this.active) return 0;
      return Math.max(0, this.opt.holdFrames - this._framesSinceHit);
    }

    /** @returns {number} Milliseconds this episode has been latched. */
    heldMs(nowMs) {
      if (!this.active || this._latchedAtMs === null) return 0;
      return Math.max(0, nowMs - this._latchedAtMs);
    }

    _snapshot(event, nowMs) {
      return {
        active: this.active,
        event,
        heldFrames: this._heldFrames,
        heldMs: this.heldMs(nowMs),
        framesRemaining: this.framesRemaining(),
        hitCount: this.hitCount,
        peakScore: this.peakScore,
      };
    }
  }

  const DEFAULT_POSE_DECODE_OPTS = {
    scoreThreshold: 0.45,
    iouThreshold: 0.50,
    maxPersons: 6,
    keypointCount: 17,
  };

  // -------------------------------------------------------------------------
  // Preprocessing
  // -------------------------------------------------------------------------

  /**
   * Draw a source frame into a square canvas with aspect-preserving padding.
   *
   * @param {CanvasRenderingContext2D} ctx - Context of a size x size canvas.
   * @param {HTMLVideoElement|HTMLCanvasElement} source
   * @param {number} size
   * @returns {{scale:number, padX:number, padY:number, srcW:number, srcH:number}|null}
   *          Mapping needed to project detections back to source pixels.
   */
  function letterbox(ctx, source, size) {
    const srcW = source.videoWidth || source.width;
    const srcH = source.videoHeight || source.height;
    if (!srcW || !srcH) return null;

    const scale = Math.min(size / srcW, size / srcH);
    const dw = Math.round(srcW * scale);
    const dh = Math.round(srcH * scale);
    const padX = Math.floor((size - dw) / 2);
    const padY = Math.floor((size - dh) / 2);

    ctx.fillStyle = 'rgb(114,114,114)'; // Ultralytics pad colour
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(source, 0, 0, srcW, srcH, padX, padY, dw, dh);

    return { scale, padX, padY, srcW, srcH };
  }

  /**
   * RGBA ImageData -> planar float32 NCHW in [0,1], written into a reused buffer.
   * Single pass over the pixel array; see onnx_inference.js for why.
   *
   * @param {Uint8ClampedArray} rgba
   * @param {number} size
   * @param {Float32Array} out - Length 3*size*size.
   */
  function rgbaToNCHW(rgba, size, out) {
    const plane = size * size;
    const gOff = plane;
    const bOff = plane * 2;
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      out[i] = rgba[p] / 255;
      out[gOff + i] = rgba[p + 1] / 255;
      out[bOff + i] = rgba[p + 2] / 255;
    }
  }

  // -------------------------------------------------------------------------
  // Output decoding
  // -------------------------------------------------------------------------

  /**
   * Resolve the memory layout of a YOLO head output.
   *
   * Ultralytics emits [1, C, A] (channels-first) but exporter and opset changes
   * have transposed this before. Rather than hardcode, infer C from the expected
   * channel count and read accordingly. Costs one comparison and removes a whole
   * class of silent-garbage failure.
   *
   * @param {number[]} dims - Tensor dims, e.g. [1,56,1344].
   * @param {number} expectedChannels
   * @returns {{channels:number, anchors:number, channelsFirst:boolean}|null}
   */
  function resolveYoloLayout(dims, expectedChannels) {
    if (!dims || dims.length !== 3 || dims[0] !== 1) return null;
    const [, d1, d2] = dims;
    if (d1 === expectedChannels) return { channels: d1, anchors: d2, channelsFirst: true };
    if (d2 === expectedChannels) return { channels: d2, anchors: d1, channelsFirst: false };
    return null;
  }

  /** Index helper for either layout. */
  function makeAt(data, layout) {
    const { anchors, channelsFirst } = layout;
    return channelsFirst
      ? (c, a) => data[c * anchors + a]
      : (c, a) => data[a * layout.channels + c];
  }

  /** Convert a YOLO xywh box (input space) back to source-pixel xyxy. */
  function unletterboxBox(cx, cy, w, h, lb) {
    const x1 = (cx - w / 2 - lb.padX) / lb.scale;
    const y1 = (cy - h / 2 - lb.padY) / lb.scale;
    const x2 = (cx + w / 2 - lb.padX) / lb.scale;
    const y2 = (cy + h / 2 - lb.padY) / lb.scale;
    return { x1, y1, x2, y2 };
  }

  /** Intersection-over-union of two xyxy boxes. */
  function iou(a, b) {
    const ix1 = Math.max(a.x1, b.x1);
    const iy1 = Math.max(a.y1, b.y1);
    const ix2 = Math.min(a.x2, b.x2);
    const iy2 = Math.min(a.y2, b.y2);
    const iw = Math.max(0, ix2 - ix1);
    const ih = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    if (inter <= 0) return 0;
    const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
    const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
    return inter / (areaA + areaB - inter);
  }

  /**
   * Greedy non-maximum suppression.
   * @param {Array<{score:number, box:object}>} items
   * @param {number} iouThreshold
   * @param {number} maxOut
   */
  function nms(items, iouThreshold, maxOut) {
    const sorted = [...items].sort((a, b) => b.score - a.score);
    const kept = [];
    for (const cand of sorted) {
      if (kept.length >= maxOut) break;
      let overlaps = false;
      for (const k of kept) {
        if (iou(cand.box, k.box) > iouThreshold) { overlaps = true; break; }
      }
      if (!overlaps) kept.push(cand);
    }
    return kept;
  }

  /**
   * Decode a yolo-pose head into person detections with keypoints in source
   * pixel coordinates.
   *
   * Channel layout per anchor: [cx, cy, w, h, personScore, (kx,ky,kconf) x 17]
   * => 4 + 1 + 51 = 56 channels.
   *
   * @param {Float32Array|number[]} data
   * @param {number[]} dims
   * @param {{scale:number,padX:number,padY:number}} lb
   * @param {object} [options]
   * @returns {Array<{score:number, box:object, keypoints:Array<{x,y,score}>}>}
   */
  function decodePoseOutput(data, dims, lb, options = {}) {
    const opt = { ...DEFAULT_POSE_DECODE_OPTS, ...options };
    const expected = 5 + opt.keypointCount * 3;
    const layout = resolveYoloLayout(dims, expected);
    if (!layout) return [];

    const at = makeAt(data, layout);
    const candidates = [];

    for (let a = 0; a < layout.anchors; a++) {
      const score = at(4, a);
      if (score < opt.scoreThreshold) continue; // reject before reading 51 more values

      const box = unletterboxBox(at(0, a), at(1, a), at(2, a), at(3, a), lb);

      const keypoints = [];
      for (let k = 0; k < opt.keypointCount; k++) {
        const base = 5 + k * 3;
        keypoints.push({
          x: (at(base, a) - lb.padX) / lb.scale,
          y: (at(base + 1, a) - lb.padY) / lb.scale,
          score: at(base + 2, a),
        });
      }
      candidates.push({ score, box, keypoints });
    }

    return nms(candidates, opt.iouThreshold, opt.maxPersons);
  }

  /**
   * Decode a yolo-detect head, keeping only the requested COCO classes.
   *
   * Channel layout per anchor: [cx, cy, w, h, class0..class79] => 84 channels.
   *
   * @param {Float32Array|number[]} data
   * @param {number[]} dims
   * @param {{scale:number,padX:number,padY:number}} lb
   * @param {object} [options]
   * @returns {Array<{score:number, classId:number, box:object}>}
   */
  function decodeDetectOutput(data, dims, lb, options = {}) {
    const opt = { ...DEFAULT_DETECT_OPTS, ...options };
    const numClasses = 80;
    const layout = resolveYoloLayout(dims, 4 + numClasses);
    if (!layout) return [];

    const at = makeAt(data, layout);
    const wanted = new Set(opt.classFilter);
    const candidates = [];

    for (let a = 0; a < layout.anchors; a++) {
      // Only the classes we care about are scanned, not all 80.
      let bestScore = 0;
      let bestClass = -1;
      for (const c of wanted) {
        const s = at(4 + c, a);
        if (s > bestScore) { bestScore = s; bestClass = c; }
      }
      if (bestClass < 0 || bestScore < opt.scoreThreshold) continue;

      candidates.push({
        score: bestScore,
        classId: bestClass,
        box: unletterboxBox(at(0, a), at(1, a), at(2, a), at(3, a), lb),
      });
    }

    return nms(candidates, opt.iouThreshold, opt.maxDetections);
  }

  // -------------------------------------------------------------------------
  // Time-sliced scheduling
  // -------------------------------------------------------------------------

  /**
   * Decides when the expensive detector is allowed to run.
   *
   * Two independent brakes:
   *   1. A minimum interval (the 1.5-2.0 s / ~0.5 FPS budget from the spec).
   *   2. A single-flight lock, so a detector slower than its own interval can
   *      never queue behind itself. Without this the schedule silently becomes
   *      "as often as possible" on exactly the low-spec machines it exists to
   *      protect.
   */
  class TimeSlicedScheduler {
    /**
     * @param {object} [options]
     * @param {number} [options.intervalMs=1750] - Target gap between completions.
     * @param {number} [options.jitterMs=250] - Random +/- spread on that gap.
     * @param {number} [options.minGapMs=250] - Hard floor on the gap. Set to 0 for
     *   CONTINUOUS mode (run on every frame): the single-flight lock is then the
     *   only brake, which is what the phone detector needs so a 1-5 frame glimpse
     *   cannot fall between two sampling slots.
     */
    constructor({ intervalMs = 1750, jitterMs = 250, minGapMs = 250 } = {}) {
      this.intervalMs = intervalMs;
      this.jitterMs = jitterMs;
      this.minGapMs = minGapMs;
      this._lastRunMs = -Infinity;
      this._inFlight = false;
      this._nextDue = 0;
    }

    /** @returns {boolean} True if the detector should run now. */
    shouldRun(nowMs) {
      if (this._inFlight) return false;
      return nowMs >= this._nextDue;
    }

    begin(nowMs) {
      this._inFlight = true;
      this._lastRunMs = nowMs;
    }

    /**
     * Mark the run complete and schedule the next.
     * The interval is measured from COMPLETION, so a slow run pushes the next
     * one out rather than stacking. Jitter is deliberate: a perfectly periodic
     * detector is trivial to time a phone glance around.
     */
    end(nowMs) {
      this._inFlight = false;
      const jitter = this.jitterMs > 0 ? (Math.random() * 2 - 1) * this.jitterMs : 0;
      this._nextDue = nowMs + Math.max(this.minGapMs, this.intervalMs + jitter);
    }

    /** @returns {boolean} True when this scheduler never throttles (minGap and interval both 0). */
    get isContinuous() {
      return this.minGapMs <= 0 && this.intervalMs <= 0;
    }

    get inFlight() {
      return this._inFlight;
    }
  }

  return {
    COCO_CELL_PHONE,
    COCO_LAPTOP,
    COCO_TV,
    COCO_BOOK,
    COCO_PERSON,
    DEFAULT_DETECT_OPTS,
    DEFAULT_POSE_DECODE_OPTS,
    PHONE_SHAPE_DEFAULTS,
    DEFAULT_LATCH_OPTS,
    boxAspectRatio,
    evaluatePhoneShape,
    filterPhoneDetections,
    DetectionLatch,
    letterbox,
    rgbaToNCHW,
    resolveYoloLayout,
    unletterboxBox,
    iou,
    nms,
    decodePoseOutput,
    decodeDetectOutput,
    TimeSlicedScheduler,
  };
}));
