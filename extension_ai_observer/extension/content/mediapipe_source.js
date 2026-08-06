// =============================================================================
// MediaPipe Extension Source — AI Observer Chrome Extension
//
// Loads the 478-point MediaPipe FaceLandmarker inside Chrome MV3 Extension
// content scripts using local extension assets (web_accessible_resources).
// Provides 478 3D landmarks to visionEngine's `faceLandmarkSource` seam,
// enabling high-precision gaze tracking & absolute EAR blink immunity.
// =============================================================================

/* global chrome */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.MediaPipeExtensionSource = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  const LANDMARK_CONTRACT_POINT_COUNT = 478;

  function toPixelLandmarks(normalized, frameWidth, frameHeight) {
    if (typeof frameWidth !== 'number' || typeof frameHeight !== 'number') return null;
    if (!Array.isArray(normalized) || normalized.length < LANDMARK_CONTRACT_POINT_COUNT) return null;
    if (!(frameWidth > 0) || !(frameHeight > 0)) return null;

    const out = new Array(normalized.length);
    for (let i = 0; i < normalized.length; i++) {
      const p = normalized[i];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) { out[i] = null; continue; }
      out[i] = { x: p.x * frameWidth, y: p.y * frameHeight };
    }
    return out;
  }

  const COCO_PROJECTION = {
    NOSE: 1,
    LEFT_EYE: 473,
    RIGHT_EYE: 468,
    LEFT_EAR: 454,
    RIGHT_EAR: 234,
  };

  function faceToCocoPerson(pixels) {
    if (!Array.isArray(pixels) || pixels.length < LANDMARK_CONTRACT_POINT_COUNT) return null;
    const at = (idx) => {
      const p = pixels[idx];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
      return { x: p.x, y: p.y, score: 1 };
    };

    const keypoints = [
      at(COCO_PROJECTION.NOSE),
      at(COCO_PROJECTION.LEFT_EYE),
      at(COCO_PROJECTION.RIGHT_EYE),
      at(COCO_PROJECTION.LEFT_EAR),
      at(COCO_PROJECTION.RIGHT_EAR),
    ];

    if (keypoints.some((k) => k === null)) return null;
    return { score: 1, keypoints };
  }

  // ---------------------------------------------------------------------------
  // Fileset singleton + init lock
  //
  // ⚠ THIS IS THE FIX FOR `ModuleFactory not set`.
  //
  // FilesetResolver.forVisionTasks() loads the MediaPipe WASM glue by assigning
  // module-factory globals on `self`, and FaceLandmarker.createFromOptions()
  // reads them back. Neither step is re-entrant. A VisionEngine is constructed
  // per proctoring session, so entering /demo-quiz, leaving and re-entering (or
  // any overlapping start) ran a second forVisionTasks() while the first was
  // still resolving — the second load reset the globals under the first, and
  // whichever createFromOptions() lost the race found no factory and threw.
  //
  // Two mechanisms, because they solve different halves:
  //   * `_filesetPromise` makes the WASM load happen ONCE per page and be shared
  //     — repeat sessions reuse the resolved fileset instead of reloading it.
  //   * `_initChain` serialises createFromOptions() calls, so even distinct
  //     landmarkers cannot be inside MediaPipe's non-re-entrant init together.
  // ---------------------------------------------------------------------------
  let _filesetPromise = null;
  let _filesetBase = null;
  let _initChain = Promise.resolve();

  function resolveFilesetOnce(FilesetResolver, wasmBase) {
    // A different wasmBase is a genuinely different fileset; only reuse a match.
    if (_filesetPromise && _filesetBase === wasmBase) return _filesetPromise;
    _filesetBase = wasmBase;
    _filesetPromise = Promise.resolve(FilesetResolver.forVisionTasks(wasmBase))
      .catch((err) => {
        // Do not cache a rejection: a transient failure would otherwise make
        // every later session in this page fail identically and permanently.
        _filesetPromise = null;
        _filesetBase = null;
        throw err;
      });
    return _filesetPromise;
  }

  /** Run `fn` with exclusive access to MediaPipe's non-re-entrant init path. */
  function withInitLock(fn) {
    const run = _initChain.then(fn, fn);
    // Keep the chain alive regardless of outcome, or one rejection wedges every
    // subsequent load behind a promise that never settles usefully.
    _initChain = run.then(() => undefined, () => undefined);
    return run;
  }

  class MediaPipeExtensionSource {
    constructor(options = {}) {
      this.numFaces = options.numFaces ?? 2;
      this.wasmBase = options.wasmBase || (typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL('lib/mediapipe/wasm')
        : '/lib/mediapipe/wasm');
      this.modelPath = options.modelPath || (typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL('lib/mediapipe/face_landmarker.task')
        : '/lib/mediapipe/face_landmarker.task');

      this._landmarker = null;
      this._lastTs = -1;
      this.delegate = null;
      this._closed = false;
      this.lastPixelLandmarks = null;
      this.lastCocoPersons = [];
    }

    async load() {
      const Vision = (typeof window !== 'undefined' ? window.Vision : null) ||
                     (typeof self !== 'undefined' ? self.Vision : null);

      const FilesetResolver = Vision?.FilesetResolver || (typeof window !== 'undefined' ? window.FilesetResolver : null);
      const FaceLandmarker = Vision?.FaceLandmarker || (typeof window !== 'undefined' ? window.FaceLandmarker : null);

      if (!FilesetResolver || !FaceLandmarker) {
        console.warn('[MediaPipeExtensionSource] tasks-vision library not loaded on Vision/window.');
        return { delegate: null };
      }

      try {
        // Serialised as one unit: the fileset resolution AND the landmarker
        // build must not interleave with another instance's, because the second
        // load resets the module-factory globals the first is about to read.
        return await withInitLock(async () => {
          const fileset = await resolveFilesetOnce(FilesetResolver, this.wasmBase);

          // Awaiting the fileset is what guarantees the WASM module factory is
          // fully installed before createFromOptions() looks for it. Do not
          // hoist this call out of the lock or start it in parallel.
          const build = async (delegate) => FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: this.modelPath, delegate },
            runningMode: 'VIDEO',
            numFaces: this.numFaces,
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: false,
          });

          try {
            this._landmarker = await build('GPU');
            this.delegate = 'GPU';
          } catch (gpuErr) {
            // "Failed to create WebGPU Context Provider" lands here. It is a
            // capability report, not a fault: a machine without a usable GPU
            // context runs the identical graph on CPU. Logged at warn with the
            // reason, because a silent switch looks like a mystery slowdown —
            // monitor.js reads `delegate` and lowers the frame budget to match.
            console.warn(
              '[MediaPipeExtensionSource] GPU delegate unavailable, falling back to CPU:',
              (gpuErr && gpuErr.message) || gpuErr
            );
            try {
              this._landmarker = await build('CPU');
              this.delegate = 'CPU';
            } catch (err) {
              console.error('[MediaPipeExtensionSource] Failed to create FaceLandmarker:', err);
              this.delegate = null;
              return { delegate: null };
            }
          }
          console.log(`[MediaPipeExtensionSource] Loaded FaceLandmarker successfully (delegate=${this.delegate}).`);
          return { delegate: this.delegate };
        });
      } catch (err) {
        console.error('[MediaPipeExtensionSource] Load error:', err);
        return { delegate: null };
      }
    }

    detect(video, nowMs) {
      if (!this._landmarker || this._closed) return { faces: [], pixels: [], persons: [], w: 0, h: 0 };
      const w = video?.videoWidth | 0;
      const h = video?.videoHeight | 0;
      if (!w || !h) return { faces: [], pixels: [], persons: [], w: 0, h: 0 };

      let ts = Math.round(nowMs);
      if (ts <= this._lastTs) ts = this._lastTs + 1;
      this._lastTs = ts;

      let res = null;
      try {
        res = this._landmarker.detectForVideo(video, ts);
      } catch (err) {
        console.debug('[MediaPipeExtensionSource] detectForVideo failed:', err);
        return { faces: [], pixels: [], persons: [], w, h };
      }

      const faces = res?.faceLandmarks ?? [];
      const primaryNorm = faces.length > 0 ? faces[0] : null;
      const primaryPixels = primaryNorm ? toPixelLandmarks(primaryNorm, w, h) : null;

      const persons = faces
        .map((f) => faceToCocoPerson(toPixelLandmarks(f, w, h)))
        .filter(Boolean);

      this.lastPixelLandmarks = primaryPixels;
      this.lastCocoPersons = persons;

      return { faces, pixels: primaryPixels, persons, w, h };
    }

    close() {
      this._closed = true;
      try { this._landmarker?.close(); } catch {}
      this._landmarker = null;
    }
  }

  MediaPipeExtensionSource.toPixelLandmarks = toPixelLandmarks;
  MediaPipeExtensionSource.faceToCocoPerson = faceToCocoPerson;

  return MediaPipeExtensionSource;
}));
