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

  // ---------------------------------------------------------------------------
  // ⚠ THE ACTUAL CAUSE OF `ModuleFactory not set` — A WORLD BOUNDARY, NOT A RACE.
  //
  // The serialisation above was written on the theory that two overlapping
  // sessions reset MediaPipe's globals under each other. That theory was wrong:
  // the failure is deterministic and happens on the FIRST load in a fresh tab.
  // The real mechanism is visible in tasks-vision.js:
  //
  //     async function Uh(t){
  //       if ("function" != typeof importScripts) {      // true in a content script
  //         let e = document.createElement("script");
  //         e.src = t.toString();
  //         document.body.appendChild(e);                // <- runs in the PAGE world
  //       } ...
  //     }
  //     if (e && await Uh(e), !self.ModuleFactory) throw Error("ModuleFactory not set.");
  //
  // `vision_wasm_internal.js` is a CLASSIC script whose top-level
  // `var ModuleFactory = ...` becomes a property of whatever global it runs in.
  // Appended to `document.body` it runs in the PAGE's main world and defines
  // `window.ModuleFactory` THERE. `self.ModuleFactory` inside tasks-vision.js is
  // the content script's ISOLATED-world global, which nothing ever assigns — so
  // the check throws every time. `importScripts` is worker-only and genuinely
  // absent here, so that branch is unreachable.
  //
  // The fix is to define ModuleFactory in the isolated world STATICALLY, which
  // is what `content/mediapipe_wasm_{open,close}.js` plus the loader itself do
  // as content scripts — see the header of mediapipe_wasm_open.js.
  //
  // ⚠ DO NOT REINTRODUCE eval() HERE. An earlier attempt fetched the loader and
  // ran `(0, eval)(src)`. Chrome MV3 rejects it in the isolated world too:
  //
  //     Evaluating a string as JavaScript violates Content Security Policy...
  //     'unsafe-eval' is not an allowed source of script
  //
  // FaceLandmarker then failed on BOTH delegates, which presented as the whole
  // vision stack silently not running. There is no manifest key that re-enables
  // eval for content scripts; loading the file statically is the only route.
  // ---------------------------------------------------------------------------

  function globalScope() {
    if (typeof globalThis !== 'undefined') return globalThis;
    if (typeof self !== 'undefined') return self;
    return null;
  }

  /**
   * Confirm `globalThis.ModuleFactory` exists in this world before task creation.
   *
   * Purely a check — the factory is installed at content-script load time, so by
   * the time any session starts this is one property read. It stays a distinct,
   * named step because its absence has a specific cause and a specific fix, and
   * the error MediaPipe raises otherwise (`ModuleFactory not set.`) points at
   * neither.
   *
   * @returns {{ok: true}|{ok: false, reason: string}}
   */
  function checkModuleFactory() {
    const g = globalScope();
    if (!g) return { ok: false, reason: 'no global scope available' };
    if (typeof g.ModuleFactory !== 'function') {
      return {
        ok: false,
        reason: 'globalThis.ModuleFactory is not defined — check that '
          + 'lib/mediapipe/wasm/vision_wasm_internal.js is listed in manifest.json '
          + 'between content/mediapipe_wasm_open.js and content/mediapipe_wasm_close.js',
      };
    }
    return { ok: true };
  }

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

          // ModuleFactory must already exist in THIS world. Awaiting the fileset
          // does NOT put it there — see the world-boundary note above.
          let effectiveFileset = fileset;
          const mf = checkModuleFactory();
          if (mf.ok) {
            // With ModuleFactory already present, drop `wasmLoaderPath` so
            // tasks-vision skips its `document.body.appendChild(<script>)`
            // entirely. Two reasons, both real:
            //   * That injection is what runs in the wrong world, so skipping it
            //     removes the failure mode rather than racing it.
            //   * The demo page is served with COEP `require-corp` (see
            //     safe-test-dashboard/public/_headers). A cross-origin
            //     chrome-extension:// <script> can be blocked outright there, and
            //     the loader REJECTS on that error event — which would throw
            //     before the ModuleFactory check we just satisfied.
            // It also stops the extension injecting a script into a page it does
            // not own, which is the better default regardless.
            effectiveFileset = Object.assign(
              Object.create(Object.getPrototypeOf(fileset) || Object.prototype),
              fileset,
              { wasmLoaderPath: undefined }
            );
          } else {
            // Fall through with the untouched fileset: the library's own loader
            // path is still the documented one, so this degrades to the previous
            // behaviour rather than failing closed.
            console.warn(
              '[MediaPipeExtensionSource] ModuleFactory not pre-installed, '
              + 'deferring to the library loader:',
              mf.reason
            );
          }

          const build = async (fs, delegate) => FaceLandmarker.createFromOptions(fs, {
            baseOptions: { modelAssetPath: this.modelPath, delegate },
            runningMode: 'VIDEO',
            numFaces: this.numFaces,
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: false,
          });

          /**
           * GPU first, then CPU, against one fileset.
           *
           * ⚠ 'GPU' IS THE WEBGL PATH — there is no separate 'WEBGL' delegate in
           * tasks-vision, whose delegate enum is GPU | CPU only. A failed WebGPU
           * context provider surfaces here as a GPU-delegate failure, and CPU is
           * the SIMD WASM runtime. So this two-step IS the
           * WebGPU -> WebGL -> SIMD-CPU ladder, expressed in the only vocabulary
           * the library accepts. Never treat a GPU failure as fatal: it is a
           * capability report, and monitor.js reads `delegate` to lower the frame
           * budget so a CPU session does not chase a GPU cadence.
           */
          const tryDelegates = async (fs) => {
            try {
              this._landmarker = await build(fs, 'GPU');
              this.delegate = 'GPU';
              return true;
            } catch (gpuErr) {
              console.warn(
                '[MediaPipeExtensionSource] GPU delegate unavailable, falling back to CPU:',
                (gpuErr && gpuErr.message) || gpuErr
              );
            }
            try {
              this._landmarker = await build(fs, 'CPU');
              this.delegate = 'CPU';
              return true;
            } catch (cpuErr) {
              console.warn(
                '[MediaPipeExtensionSource] CPU delegate failed:',
                (cpuErr && cpuErr.message) || cpuErr
              );
              return false;
            }
          };

          let ok = await tryDelegates(effectiveFileset);

          // Last resort: if stripping wasmLoaderPath upset something inside the
          // library, give its own loader path a turn before giving up. Only
          // meaningful when we actually modified the fileset.
          if (!ok && effectiveFileset !== fileset) {
            console.warn(
              '[MediaPipeExtensionSource] Retrying with the library-managed wasm loader.'
            );
            ok = await tryDelegates(fileset);
          }

          if (!ok) {
            console.error('[MediaPipeExtensionSource] Failed to create FaceLandmarker on every path.');
            this.delegate = null;
            return { delegate: null };
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
