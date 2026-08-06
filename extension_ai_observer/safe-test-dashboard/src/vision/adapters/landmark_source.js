// =============================================================================
// Landmark sources — PLAN.md §6 Phase 3.
//
// Two implementations of one interface:
//
//     detect(video, nowMs) -> { faces: Array<NormalizedLandmark[]>, w, h }
//     close()
//
// MediaPipeLandmarkSource is the real thing. ScriptedLandmarkSource is the
// HEADLESS SEAM: it lets demo_engine.test.js drive 30 simulated seconds with no
// camera, no WASM and no real timers. That seam is why the engine's safety
// properties are testable at all.
// =============================================================================

/** Self-hosted paths. PLAN.md §2: no CDN — a proctoring demo whose claim is
 *  "nothing leaves your machine" must not fetch its own vision runtime. */
export const WASM_BASE = '/mediapipe/wasm';
export const MODEL_PATH = '/models/face_landmarker.task';

export const SOURCE_ERROR = Object.freeze({
  MODEL_LOAD_FAILED: 'MODEL_LOAD_FAILED',
});

/**
 * Real MediaPipe FaceLandmarker.
 *
 * `numFaces: 2` on purpose — MULTIPLE_FACES is a violation the taxonomy
 * declares, and with numFaces:1 it could never be demonstrated.
 */
export class MediaPipeLandmarkSource {
  constructor(options = {}) {
    this.numFaces = options.numFaces ?? 2;
    this.wasmBase = options.wasmBase ?? WASM_BASE;
    this.modelPath = options.modelPath ?? MODEL_PATH;
    this._landmarker = null;
    this._lastTs = -1;
    this.delegate = null;   // 'GPU' | 'CPU' — surfaced as the "CPU mode" chip
    this._closed = false;
  }

  /** @returns {Promise<{delegate:string}>} throws on MODEL_LOAD_FAILED. */
  async load() {
    const { FilesetResolver, FaceLandmarker } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks(this.wasmBase);

    const build = async (delegate) => FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: this.modelPath, delegate },
      runningMode: 'VIDEO',
      numFaces: this.numFaces,
      // ⚠ THE WHOLE POINT. refine_landmarks is what promotes 468 -> 478 and
      // puts the irises at 468/473 — exactly LANDMARK_CONTRACT. Without it the
      // mesh parses fine and silently carries no iris, and every gaze ratio
      // becomes NaN. Never turn this off to save a millisecond.
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });

    try {
      this._landmarker = await build('GPU');
      this.delegate = 'GPU';
    } catch {
      // One CPU retry. A driver can advertise WebGL and still fail to compile
      // this specific graph; degrading to CPU is far better than no demo, and
      // the UI says so rather than pretending it is running at full rate.
      try {
        this._landmarker = await build('CPU');
        this.delegate = 'CPU';
      } catch (err) {
        const e = new Error(SOURCE_ERROR.MODEL_LOAD_FAILED);
        e.cause = err;
        throw e;
      }
    }
    return { delegate: this.delegate };
  }

  detect(video, nowMs) {
    if (!this._landmarker || this._closed) return { faces: [], w: 0, h: 0 };
    const w = video?.videoWidth | 0;
    const h = video?.videoHeight | 0;
    if (!w || !h) return { faces: [], w: 0, h: 0 };

    // detectForVideo THROWS on a non-increasing timestamp. Two ticks inside the
    // same millisecond are entirely possible on a fast machine, so the guard is
    // required rather than defensive.
    let ts = Math.round(nowMs);
    if (ts <= this._lastTs) ts = this._lastTs + 1;
    this._lastTs = ts;

    const res = this._landmarker.detectForVideo(video, ts);
    return { faces: res?.faceLandmarks ?? [], w, h };
  }

  close() {
    this._closed = true;
    // ⚠ Skipping this leaks tens of MB of WASM heap per modal open. It is the
    // first step of the teardown order for that reason.
    try { this._landmarker?.close(); } catch { /* already gone */ }
    this._landmarker = null;
  }
}

/**
 * Headless seam. Replays a frame list built by
 * `src/vision/testing/synthetic_face.js: scriptedFrames({builder,count,dtMs,t0})`,
 * whose entries are `{ t, i, value }`.
 *
 * `value` is whatever the builder produced — normally a 478-point normalised
 * face, or null for an unreadable frame. Frames are selected by TIMESTAMP, not
 * by call count, so a test that skips ahead in simulated time gets the frame
 * that genuinely belongs to that instant.
 */
export class ScriptedLandmarkSource {
  /**
   * @param {Array<{t:number,i:number,value:*}>} frames from scriptedFrames()
   * @param {{w?:number,h?:number,multiFaceAt?:(f)=>boolean}} [opts]
   */
  constructor(frames, opts = {}) {
    if (!Array.isArray(frames)) {
      throw new TypeError('ScriptedLandmarkSource(frames): frames must be an array from scriptedFrames()');
    }
    this.frames = frames;
    this.w = opts.w ?? 640;
    this.h = opts.h ?? 480;
    // Lets a test script a second person for MULTIPLE_FACES without inventing
    // a whole second frame format.
    this.multiFaceAt = opts.multiFaceAt ?? (() => false);
    this.delegate = 'SCRIPTED';
    this.closed = false;
    this.detectCount = 0;
  }

  detect(_video, nowMs) {
    this.detectCount++;
    if (this.closed || this.frames.length === 0) return { faces: [], w: this.w, h: this.h };

    // Last frame whose t <= nowMs. Before the script starts, nothing is
    // visible — which is an unreadable frame, not a face at the origin.
    let chosen = null;
    for (let i = 0; i < this.frames.length; i++) {
      if (this.frames[i].t <= nowMs) chosen = this.frames[i]; else break;
    }
    if (!chosen || chosen.value == null) return { faces: [], w: this.w, h: this.h };

    const faces = [chosen.value];
    if (this.multiFaceAt(chosen)) faces.push(chosen.value);
    return { faces, w: this.w, h: this.h };
  }

  close() { this.closed = true; }
}
