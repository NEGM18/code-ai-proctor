// =============================================================================
// ONNX Runtime Local Inference — AI Observer Extension
// WebGPU-first with robust WASM fallback. Integrates SecureModelLoader for
// chunk-based model delivery and weight obfuscation.
//
// The execution provider chain, the WASM thread/SIMD settings and the frame
// budget are NOT decided here — runtime_profile.js probes the machine once and
// every session in the extension shares that one answer. This file just asks
// for it. See content/vision/runtime_profile.js.
// =============================================================================

/* global ort, probeWebGPU, resolveRuntimeProfile, configureOrtEnv, createSession, getRuntimeProfile */

let ortSession = null;
let modelLoaded = false;
let classNames = ['cheating', 'normal']; // Default mapping: 0=cheating, 1=normal
let activeExecutionProvider = 'unknown';

// Input resolution the model was TRAINED and EXPORTED at. This MUST match the
// ONNX input shape produced by export_onnx.py. The YOLO11n-cls proctor weights
// were trained at 640; running inference at 224 collapses accuracy to ~chance.
//
// 640 is ~8x the compute of the standard 224 classify input ((640/224)^2) for a
// face-scale binary decision, which is the single biggest cost on low-end
// hardware. The fix is to RETRAIN at 224 (train_cheating_yolo.py --imgsz 224)
// and re-export — not to lower this constant on its own. Once the model is
// re-exported, this adapts automatically: resolveModelInputSize() reads the real
// input shape off the session and only falls back to this default.
const DEFAULT_MODEL_INPUT_SIZE = 640;
let modelInputSize = DEFAULT_MODEL_INPUT_SIZE;

// Preprocessing mode. MUST match what the weights were validated with.
// Ultralytics classify val uses Resize + CenterCrop, so 'center-crop' is the
// only mode consistent with the current best.pt. 'letterbox' preserves the full
// horizontal FOV (where a phone on the desk / second person actually appears)
// and is the better choice — but switching it here alone creates a train/serve
// mismatch. Flip this ONLY together with a retrain that letterboxes.
const PREPROCESS_MODE = 'center-crop'; // 'center-crop' | 'letterbox'

// Decision threshold on P(cheating). Exposed so the operating point can be
// tuned per deployment instead of being frozen at argmax (== 0.5).
let cheatThreshold = 0.5;

// Baseline ORT settings, applied at load time so the extension is never in an
// unconfigured state. runtime_profile.configureOrtEnv() overwrites numThreads
// (and re-asserts SIMD) once the hardware probe resolves during
// initONNXSession, which always happens before the first session is created.
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;
ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/');

// Suppress verbose ONNX logging in production
ort.env.logLevel = 'warning';

// ---------------------------------------------------------------------------
// Reusable frame buffers
//
// predictFrame used to allocate a fresh canvas AND a fresh Float32Array on every
// call. At 640 that is a 4.9 MB tensor per frame — ~5,400 of each over a 90
// minute exam, all churned through GC on the machine least able to afford it.
// These are hoisted to module scope and reused.
//
// SAFETY: reuse is only sound because inference is single-flight. monitor.js
// guarantees this via its in-flight guard + self-scheduling loop. Do NOT run two
// predictFrame() calls concurrently or they will corrupt each other's input.
// ---------------------------------------------------------------------------
let _frameCanvas = null;
let _frameCtx = null;
let _tensorData = null;

/**
 * Allocate (or re-allocate) the shared crop canvas and tensor backing store.
 * @param {number} size - Square edge length matching the model input.
 */
function ensureFrameBuffers(size) {
  if (_frameCanvas && _frameCanvas.width === size && _tensorData) return;

  _frameCanvas = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(size, size)
    : document.createElement('canvas');
  _frameCanvas.width = size;
  _frameCanvas.height = size;
  // willReadFrequently keeps the surface in CPU memory; without it every
  // getImageData() forces a GPU readback stall.
  _frameCtx = _frameCanvas.getContext('2d', { willReadFrequently: true });
  _tensorData = new Float32Array(3 * size * size);
}

/**
 * Detect whether the browser supports WebGPU.
 *
 * Thin wrapper over the shared probe so the popup and any other caller keep
 * working, while there remains exactly ONE implementation of the check.
 *
 * @returns {Promise<boolean>}
 */
async function isWebGPUAvailable() {
  if (typeof probeWebGPU !== 'function') {
    // runtime_profile.js failed to load — fall back to an inline probe rather
    // than claiming "no GPU" and silently forcing everyone onto Tier B.
    try {
      if (!navigator.gpu) return false;
      const adapter = await navigator.gpu.requestAdapter();
      return adapter !== null;
    } catch {
      return false;
    }
  }
  const probe = await probeWebGPU();
  return probe.available;
}

/**
 * Initialize the ONNX session using the secure chunked model loader.
 * Tries WebGPU first for GPU acceleration, falls back to single-threaded WASM safely.
 *
 * @param {string} serverUrl - Backend server URL for model chunk download.
 * @param {Function} [onProgress] - Optional progress callback(downloaded, total).
 * @returns {Promise<boolean>} True if model loaded successfully.
 */
async function initONNXSession(serverUrl, onProgress) {
  let secureLoader = null;

  try {
    let rawBuffer = null;
    let modelSource = null;

    const formattedServerUrl = (serverUrl || 'http://localhost:8000').replace(/\/+$/, '');

    // Attempt secure chunked loading first
    if (window.SecureModelLoader) {
      console.log('[ONNX] Using SecureModelLoader for chunked model download...');
      secureLoader = new window.SecureModelLoader(formattedServerUrl);
      try {
        rawBuffer = await secureLoader.loadModel(onProgress);
        modelSource = new Uint8Array(rawBuffer);
        console.log('[ONNX] Secure model byte array ready:', modelSource.byteLength, 'bytes.');
      } catch (secureErr) {
        secureLoader.dispose();
        secureLoader = null;

        // ⚠ THE FALLBACK TARGETS THE SAME HOST. If the loader gave up because
        // that host is unreachable, retrying it via a direct URL asks the same
        // dead server the same question — except this time through ORT's own
        // fetch, which we cannot put a timeout on. That turns a bounded 8-second
        // failure into an unbounded hang during extension init.
        //
        // So an UNREACHABLE code fails fast and loudly. An HTTP or integrity
        // error still falls back: those mean the server is alive and answering,
        // and the static route genuinely might work where the chunk route did
        // not.
        if (secureErr && secureErr.code === 'MODEL_SERVER_UNREACHABLE') {
          console.error(
            `[ONNX] Model server unreachable at ${formattedServerUrl} — not retrying the same host. ` +
            `Start the backend (uvicorn backend.main:app --port 8000) and reload.`,
            secureErr.message
          );
          modelLoaded = false;
          return false;
        }

        console.warn('[ONNX] SecureModelLoader failed, falling back to direct URL:', secureErr.message);
        modelSource = `${formattedServerUrl}/static/models/best.onnx`;
      }
    } else {
      console.log('[ONNX] SecureModelLoader not available, using direct URL...');
      modelSource = `${formattedServerUrl}/static/models/best.onnx`;
    }

    // Probe the machine ONCE and configure ort.env before the first session is
    // built. Tier A gets ['webgpu','wasm']; Tier B gets ['wasm'] with SIMD and
    // (where the platform permits it) 2 threads. createSession also retries a
    // WebGPU failure on pure WASM, so a driver that passes the adapter probe
    // but cannot compile this graph still ends up with a working session.
    const profile = await resolveRuntimeProfile();
    configureOrtEnv(ort, profile);

    const created = await createSession(ort, modelSource, profile, 'classifier');
    const session = created.session;
    activeExecutionProvider = created.provider;

    ortSession = session;
    modelLoaded = true;

    // ORT has copied the weights into its own WASM heap by now, so the 6 MB
    // JS-side buffer the loader is still holding is dead weight. Without this
    // it stayed resident for the entire exam (dispose() was never called).
    if (secureLoader) {
      secureLoader.dispose();
      secureLoader = null;
    }
    modelSource = null;
    rawBuffer = null;

    modelInputSize = resolveModelInputSize(session);
    ensureFrameBuffers(modelInputSize);

    console.log(`[AI Observer] Model active. Execution provider: ${activeExecutionProvider}, input: ${modelInputSize}x${modelInputSize}`);
    return true;

  } catch (err) {
    console.error('[ONNX] Critical error during session initialization:', err);
    if (secureLoader) {
      secureLoader.dispose();
      secureLoader = null;
    }
    modelLoaded = false;
    ortSession = null;
    return false;
  }
}

/**
 * Read the square input edge length off the session metadata so the extension
 * tracks the exported model automatically. Retraining/re-exporting at 224 then
 * needs no extension change. Falls back to DEFAULT_MODEL_INPUT_SIZE when the
 * runtime does not expose shapes (varies by ORT build) or the shape is dynamic.
 * @param {ort.InferenceSession} session
 * @returns {number}
 */
function resolveModelInputSize(session) {
  try {
    const meta = session.inputMetadata;
    if (!meta) return DEFAULT_MODEL_INPUT_SIZE;

    // ORT exposes this either as an array aligned with inputNames or as a map.
    const entry = Array.isArray(meta) ? meta[0] : meta[session.inputNames[0]];
    const dims = entry && (entry.shape || entry.dimensions);
    if (!Array.isArray(dims) || dims.length !== 4) return DEFAULT_MODEL_INPUT_SIZE;

    // NCHW — height is index 2. Dynamic axes come through as strings or <= 0.
    const h = dims[2];
    if (typeof h === 'number' && h > 0) return h;
    return DEFAULT_MODEL_INPUT_SIZE;
  } catch {
    return DEFAULT_MODEL_INPUT_SIZE;
  }
}

/**
 * Set the P(cheating) threshold above which a frame is labelled 'cheating'.
 * @param {number} t - Threshold in (0, 1).
 */
function setCheatThreshold(t) {
  if (typeof t === 'number' && t > 0 && t < 1) {
    cheatThreshold = t;
    console.log('[ONNX] Cheat threshold set to', t);
  }
}

/** @returns {number} The active P(cheating) decision threshold. */
function getCheatThreshold() {
  return cheatThreshold;
}

/** @returns {number} The square input edge length the session actually expects. */
function getModelInputSize() {
  return modelInputSize;
}

/**
 * Get the currently active execution provider.
 * @returns {string} 'webgpu', 'wasm', or 'unknown'
 */
function getExecutionProvider() {
  return activeExecutionProvider;
}

/**
 * Compact summary of the resolved hardware tier, for telemetry and the popup.
 * @returns {object|null} Null before initONNXSession() has run.
 */
function getRuntimeProfileInfo() {
  const p = typeof getRuntimeProfile === 'function' ? getRuntimeProfile() : null;
  if (!p) return null;
  return {
    tier: p.tier,
    label: p.label,
    providers: p.executionProviders,
    active_provider: activeExecutionProvider,
    target_fps: p.targetFps,
    wasm_threads: p.appliedThreads,
    wasm_simd: p.appliedSimd,
    webgpu_reason: p.webgpu ? p.webgpu.reason : null,
    degraded_to_wasm: !!p.degradedToWasm,
  };
}

/**
 * Draw the source frame into the shared square buffer canvas.
 *
 * 'center-crop' matches Ultralytics classify validation preprocessing (the
 * current weights' distribution). Note it discards the left/right thirds of a
 * 4:3 webcam — see PREPROCESS_MODE.
 * 'letterbox' preserves the full frame with grey padding; use only with weights
 * trained the same way.
 *
 * @param {HTMLVideoElement|HTMLCanvasElement} source - The source element.
 * @param {number} [size=modelInputSize] - The output square size.
 * @returns {OffscreenCanvas|HTMLCanvasElement|null} The shared buffer canvas, or null if the source has no dimensions.
 */
function getCenterCropSquare(source, size = modelInputSize) {
  const w = source.videoWidth || source.width;
  const h = source.videoHeight || source.height;
  if (!w || !h) return null;

  ensureFrameBuffers(size);
  const ctx = _frameCtx;

  if (PREPROCESS_MODE === 'letterbox') {
    const scale = Math.min(size / w, size / h);
    const dw = Math.round(w * scale);
    const dh = Math.round(h * scale);
    ctx.fillStyle = '#727272'; // Ultralytics pad colour (114,114,114)
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(source, 0, 0, w, h, (size - dw) >> 1, (size - dh) >> 1, dw, dh);
    return _frameCanvas;
  }

  let sWidth, sHeight, sx, sy;
  if (w > h) {
    sWidth = h;
    sHeight = h;
    sx = (w - h) / 2;
    sy = 0;
  } else {
    sWidth = w;
    sHeight = w;
    sx = 0;
    sy = (h - w) / 2;
  }

  ctx.drawImage(source, sx, sy, sWidth, sHeight, 0, 0, size, size);
  return _frameCanvas;
}

/**
 * Preprocess the shared buffer canvas into a Float32 BCHW tensor.
 * Normalizes to [0,1] with no ImageNet mean/std, matching Ultralytics YOLO
 * classify preprocessing.
 *
 * The RGBA -> planar RGB scatter runs as a SINGLE pass over the pixel buffer.
 * The previous channel-major nesting walked the whole (size*size*4) byte array
 * three times with stride-4 reads, which is cache-hostile at 640.
 *
 * @param {OffscreenCanvas|HTMLCanvasElement} canvas - Square canvas with the frame.
 * @returns {ort.Tensor} Float32 tensor of shape [1, 3, size, size].
 */
function preprocessCanvasToTensor(canvas) {
  const size = canvas.width;
  ensureFrameBuffers(size);

  const data = _frameCtx.getImageData(0, 0, size, size).data;
  const plane = size * size;
  const out = _tensorData;

  const gOff = plane;
  const bOff = plane * 2;
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = data[p] / 255;
    out[gOff + i] = data[p + 1] / 255;
    out[bOff + i] = data[p + 2] / 255;
  }

  return new ort.Tensor('float32', out, [1, 3, size, size]);
}

/**
 * Apply softmax to output logits.
 * @param {number[]} arr - Array of raw logits.
 * @returns {number[]} Softmax probabilities.
 */
function softmax(arr) {
  const max = Math.max(...arr);
  const exps = arr.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((x) => x / sum);
}

/**
 * Convert raw model output to a probability distribution.
 * The Ultralytics YOLO classify ONNX export already ends in a Softmax layer,
 * so its output is already normalized. Applying softmax a second time would
 * distort the confidence (compress it toward uniform) without changing the
 * predicted label. Detect that case and pass the values through unchanged;
 * only apply softmax when the output looks like raw logits.
 * @param {number[]} arr - Raw model output values.
 * @returns {number[]} Probabilities summing to 1.
 */
function toProbabilities(arr) {
  const sum = arr.reduce((a, b) => a + b, 0);
  const allInUnitRange = arr.every((x) => x >= -1e-6 && x <= 1 + 1e-6);
  if (allInUnitRange && Math.abs(sum - 1) < 1e-3) {
    return arr; // already a softmax/probability distribution
  }
  return softmax(arr);
}

/**
 * Run inference on a video frame or canvas element.
 * @param {HTMLVideoElement|HTMLCanvasElement} sourceElement - The source to classify.
 * @returns {Promise<{label: string, confidence: number, probs: {cheating: number, normal: number}, inferenceMs: number, croppedCanvas: OffscreenCanvas|HTMLCanvasElement}|null>}
 */
async function predictFrame(sourceElement) {
  if (!modelLoaded || !ortSession) {
    throw new Error('ONNX model is not loaded yet.');
  }

  // 1. Crop/scale into the shared buffer at the model's input resolution
  const croppedCanvas = getCenterCropSquare(sourceElement, modelInputSize);
  if (!croppedCanvas) {
    return null;
  }

  // 2. Preprocess to Float32 Tensor (reuses the shared backing store)
  const tensor = preprocessCanvasToTensor(croppedCanvas);

  // 3. Feed input tensor and run session
  const inputName = ortSession.inputNames[0];
  const feeds = { [inputName]: tensor };
  const startedAt = performance.now();
  const results = await ortSession.run(feeds);
  const inferenceMs = performance.now() - startedAt;

  const outputName = ortSession.outputNames[0];
  const outputTensor = results[outputName];
  const outputData = Array.from(outputTensor.data);

  // 4. Postprocess outputs. The classify export already applies Softmax, so this
  //    passes the probabilities through unchanged (and only softmaxes raw logits).
  const probs = toProbabilities(outputData);

  // Map index 0 to cheating, index 1 to normal
  const cheatProb = probs[0] || 0.0;
  const normalProb = probs[1] || 0.0;

  // Threshold on P(cheating) rather than argmax, so the operating point is
  // tunable (see setCheatThreshold). At the 0.5 default this is identical to
  // the previous argmax behaviour for a 2-class head.
  const label = cheatProb >= cheatThreshold ? 'cheating' : 'normal';
  const confidence = Math.max(cheatProb, normalProb);

  return {
    label: label,
    confidence: confidence,
    probs: {
      cheating: cheatProb,
      normal: normalProb,
    },
    inferenceMs: inferenceMs,
    croppedCanvas: croppedCanvas, // Shared buffer — valid only until the next predictFrame()
  };
}

/**
 * Check if the ONNX model is ready for inference.
 * @returns {boolean}
 */
function isModelReady() {
  return modelLoaded && ortSession !== null;
}

/**
 * Release the classifier session and its WASM arena.
 *
 * ⚠ WITHOUT THIS, THE HEAVIEST GRAPH IN THE STACK LEAKED EVERY SESSION.
 *
 * stopProctoring() disposes the VisionEngine (pose + detect), but nothing ever
 * released `best.onnx` — a 640x640 input, the single most expensive graph here
 * by a wide margin. initONNXSession() then builds a NEW session on the next
 * start while the previous one is still resident in the ORT heap, which no GC
 * can reclaim because the WASM arena is not JS-visible memory. Two or three
 * demo entries in one tab and the low-spec machine this is tuned for is out of
 * memory.
 *
 * The frame buffers are dropped too. They are correctly reused ACROSS FRAMES
 * (that is what ensureFrameBuffers exists for), but they are sized to a specific
 * model input, and holding a 4.9 MB Float32Array plus a 640x640 canvas BETWEEN
 * sessions serves nothing. ensureFrameBuffers() rebuilds them on the next load.
 */
async function disposeONNXSession() {
  const session = ortSession;
  ortSession = null;
  modelLoaded = false;

  if (session && typeof session.release === 'function') {
    try {
      await session.release();
    } catch (err) {
      console.warn('[ONNX] failed to release classifier session:', err);
    }
  }

  _frameCanvas = null;
  _frameCtx = null;
  _tensorData = null;
  activeExecutionProvider = 'unknown';
}

// ---------------------------------------------------------------------------
// Export functions to window context for cross-script communication
// ---------------------------------------------------------------------------
window.initONNXSession = initONNXSession;
window.disposeONNXSession = disposeONNXSession;
window.predictFrame = predictFrame;
window.getCenterCropSquare = getCenterCropSquare;
window.isModelReady = isModelReady;
window.getExecutionProvider = getExecutionProvider;
window.getRuntimeProfileInfo = getRuntimeProfileInfo;
window.isWebGPUAvailable = isWebGPUAvailable;
window.setCheatThreshold = setCheatThreshold;
window.getCheatThreshold = getCheatThreshold;
window.getModelInputSize = getModelInputSize;
