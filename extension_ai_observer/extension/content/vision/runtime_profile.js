// =============================================================================
// Runtime Execution Profile — AI Observer Extension
//
// ONE place decides how this machine runs inference. Every ONNX session in the
// extension (classifier, pose, detect) asks this module for its execution
// provider chain and its input resolution, so a laptop without a GPU cannot end
// up with one session on WebGPU and another on WASM fighting over the same
// budget.
//
// The probe is a real capability check, not a feature-flag sniff:
//
//   navigator.gpu present  ->  requestAdapter()  ->  adapter !== null  ->  TIER A
//   anything above throws / returns null / is missing  ->  TIER B
//
// TIER A (GPU present)
//   executionProviders ['webgpu', 'wasm'] — 'wasm' stays in the chain so a
//   single unsupported operator degrades that ONE node to CPU instead of
//   failing the whole session.
//   Pose/gaze runs at native camera cadence (15-30 FPS) and the phone detector
//   runs on every processed frame.
//
// TIER B (no GPU / WebGPU init failed)
//   executionProviders ['wasm'] only. SIMD on, 2 threads WHERE THE PLATFORM
//   ALLOWS IT (see resolveThreadCount — a content script on an ordinary page is
//   not cross-origin isolated, so SharedArrayBuffer, and therefore ORT's
//   threaded WASM build, is usually unavailable; asking for 2 threads anyway is
//   how you get the Web Worker .mjs import failure this extension used to hit).
//   Pose/gaze is sub-sampled to ~8-10 FPS and input tensors are capped at
//   320x320 so a budget laptop stays responsive.
//
// RESOLUTION IS A REQUEST, NOT A COMMAND. export_vision_models.py exports with
// dynamic=False, so pose.onnx and detect.onnx have STATIC input shapes. Feeding
// 320 into a 448 graph throws. clampInputSize() therefore takes the tier's
// preferred size and the model's actual shape and returns what the session can
// really accept — re-export with --detect-imgsz 320 (or --dynamic) to collect
// the Tier B saving.
// =============================================================================

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.__runtimeProfile = factory();
    Object.assign(root, root.__runtimeProfile);
  }
}(typeof self !== 'undefined' ? self : this, function () {

  /** @enum {string} */
  const RuntimeTier = {
    GPU: 'A',
    CPU: 'B',
  };

  /**
   * Per-tier inference budget.
   *
   * frameIntervalMs is the target spacing between inference STARTS. It is a
   * target, never a guarantee — the loop in monitor.js measures from completion,
   * so a machine that cannot hold the cadence degrades to a lower frame rate
   * rather than queueing work it can never drain.
   */
  const TIER_PROFILES = {
    [RuntimeTier.GPU]: {
      tier: RuntimeTier.GPU,
      label: 'gpu',
      executionProviders: ['webgpu', 'wasm'],

      // WebGPU carries the arithmetic; threads only matter if a node falls back
      // to CPU, and 1 is the value that always works inside a content script.
      wasmThreads: 1,
      wasmSimd: true,

      // Native camera cadence. 20 FPS sits inside the 15-30 band and leaves the
      // page's own compositor some room.
      targetFps: 20,
      frameIntervalMs: 50,
      minFrameGapMs: 25,

      // Full-resolution inputs — the GPU is not the bottleneck.
      poseInputSize: 256,
      detectInputSize: 448,
      maxInputSize: 640,

      // Phone YOLO on EVERY processed frame.
      detectMode: 'continuous',
      detectIntervalMs: 0,
      detectMinGapMs: 0,

      // Corroborating classifier stays time-sliced; it is not a trigger.
      classifierIntervalMs: 3000,
    },

    [RuntimeTier.CPU]: {
      tier: RuntimeTier.CPU,
      label: 'cpu',
      executionProviders: ['wasm'],

      wasmThreads: 2,
      wasmSimd: true,

      // ~9 FPS: inside the 8-10 FPS budget for a CPU-only machine.
      targetFps: 9,
      frameIntervalMs: 111,
      minFrameGapMs: 100,

      // Cap every tensor at 320x320. Pose is already exported at 256 and stays
      // there — raising it to hit the cap would make the CPU path slower, which
      // is the opposite of the point.
      poseInputSize: 256,
      detectInputSize: 320,
      maxInputSize: 320,

      // Still every frame — a phone glimpse lasting 1-5 frames must not be
      // sampled away. The frame rate is what dropped, not the coverage.
      detectMode: 'continuous',
      detectIntervalMs: 0,
      detectMinGapMs: 0,

      classifierIntervalMs: 6000,
    },
  };

  /** Resolved once per page; every session shares the same answer. */
  let _resolved = null;
  let _resolvePromise = null;
  let _ortConfigured = false;

  // -------------------------------------------------------------------------
  // Hardware probe
  // -------------------------------------------------------------------------

  /**
   * Ask the platform whether WebGPU is actually usable here.
   *
   * `navigator.gpu` existing is not enough: Chrome exposes it on machines where
   * adapter creation then fails (blocklisted driver, no discrete or integrated
   * adapter reachable, GPU process disabled by policy). Only a non-null adapter
   * proves the pipeline can be built, so the probe goes all the way.
   *
   * @param {object} [nav] - Navigator-like object; injectable for tests.
   * @returns {Promise<{available:boolean, reason:string, adapterInfo:object|null}>}
   */
  async function probeWebGPU(nav) {
    const n = nav || (typeof navigator !== 'undefined' ? navigator : null);

    if (!n || !n.gpu) {
      return { available: false, reason: 'navigator.gpu unavailable', adapterInfo: null };
    }

    try {
      const adapter = await n.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        return { available: false, reason: 'no WebGPU adapter returned', adapterInfo: null };
      }

      // adapter.info is the current surface; requestAdapterInfo() was the older
      // one and is gone in newer Chrome. Neither is required — this is telemetry.
      let adapterInfo = null;
      try {
        adapterInfo = adapter.info
          || (typeof adapter.requestAdapterInfo === 'function' ? await adapter.requestAdapterInfo() : null);
      } catch { /* informational only */ }

      return { available: true, reason: 'adapter acquired', adapterInfo: adapterInfo || null };
    } catch (err) {
      return {
        available: false,
        reason: `requestAdapter threw: ${err && err.message ? err.message : err}`,
        adapterInfo: null,
      };
    }
  }

  /**
   * How many WASM threads ORT may actually be given.
   *
   * ORT's multi-threaded WASM build needs SharedArrayBuffer, which needs the
   * document to be cross-origin isolated. A content script runs in the page's
   * document, and an arbitrary LMS page is not isolated — so on nearly every
   * real deployment this returns 1 even on Tier B. Requesting 2 regardless is
   * exactly how the extension previously broke: ORT spawns a proxy worker,
   * the .mjs dynamic import fails inside the content-script world, and the
   * session never loads.
   *
   * Returning 1 here is a correctness guard, not a downgrade: SIMD (the larger
   * win of the two) is unaffected and stays on.
   *
   * @param {number} requested
   * @param {object} [env] - {crossOriginIsolated, hardwareConcurrency, hasSharedArrayBuffer} for tests.
   * @returns {{threads:number, reason:string}}
   */
  function resolveThreadCount(requested, env) {
    const want = Math.max(1, Math.floor(requested || 1));
    if (want <= 1) return { threads: 1, reason: 'single thread requested' };

    const e = env || {};
    const isolated = 'crossOriginIsolated' in e
      ? !!e.crossOriginIsolated
      : (typeof self !== 'undefined' ? !!self.crossOriginIsolated : false);
    const hasSAB = 'hasSharedArrayBuffer' in e
      ? !!e.hasSharedArrayBuffer
      : (typeof SharedArrayBuffer !== 'undefined');
    const cores = e.hardwareConcurrency
      || (typeof navigator !== 'undefined' && navigator.hardwareConcurrency)
      || 1;

    if (!hasSAB) return { threads: 1, reason: 'SharedArrayBuffer unavailable' };
    if (!isolated) return { threads: 1, reason: 'document is not cross-origin isolated' };
    if (cores < 2) return { threads: 1, reason: `only ${cores} logical core(s)` };

    return { threads: Math.min(want, cores), reason: 'threaded WASM supported' };
  }

  // -------------------------------------------------------------------------
  // Profile resolution
  // -------------------------------------------------------------------------

  /**
   * Probe the hardware once and build the runtime profile every session uses.
   *
   * Idempotent and concurrency-safe: the classifier and the vision engine both
   * call this during startup and must not race two adapter probes.
   *
   * @param {object} [options]
   * @param {'A'|'B'} [options.forceTier] - Override the probe (diagnostics/tests).
   * @param {object} [options.overrides] - Shallow-merged over the tier profile.
   * @returns {Promise<object>} The resolved profile object.
   */
  async function resolveRuntimeProfile(options = {}) {
    if (_resolved && !options.forceTier && !options.overrides) return _resolved;
    if (_resolvePromise && !options.forceTier && !options.overrides) return _resolvePromise;

    _resolvePromise = (async () => {
      let probe = { available: false, reason: 'probe skipped', adapterInfo: null };
      let tier;

      if (options.forceTier === RuntimeTier.GPU || options.forceTier === RuntimeTier.CPU) {
        tier = options.forceTier;
        probe.reason = `forced tier ${tier}`;
      } else {
        probe = await probeWebGPU(options.navigator);
        tier = probe.available ? RuntimeTier.GPU : RuntimeTier.CPU;
      }

      const profile = {
        ...TIER_PROFILES[tier],
        ...(options.overrides || {}),
        webgpu: probe,
        // Filled in by configureOrtEnv once ORT actually accepts the settings.
        appliedThreads: null,
        appliedSimd: null,
        // Set true by createSession() if a WebGPU session creation throws and
        // the WASM retry succeeds.
        degradedToWasm: false,
      };

      _resolved = profile;
      console.log(
        `[Runtime] Tier ${profile.tier} (${profile.label}) — providers [${profile.executionProviders.join(', ')}], ` +
        `~${profile.targetFps} FPS, detect ${profile.detectMode}. WebGPU: ${probe.reason}.`
      );
      return profile;
    })();

    return _resolvePromise;
  }

  /** @returns {object|null} The resolved profile, or null before resolution. */
  function getRuntimeProfile() {
    return _resolved;
  }

  /** Drop the cached probe. Tests and diagnostics only. */
  function resetRuntimeProfile() {
    _resolved = null;
    _resolvePromise = null;
    _ortConfigured = false;
  }

  // -------------------------------------------------------------------------
  // ORT environment
  // -------------------------------------------------------------------------

  /**
   * Apply the profile's WASM settings to ORT's global env.
   *
   * MUST run before the first InferenceSession.create — ort.env.wasm is read
   * when the backend initialises and is ignored afterwards.
   *
   * @param {object} ortRef - The ort namespace.
   * @param {object} profile - From resolveRuntimeProfile().
   * @param {object} [env] - Capability overrides for tests.
   * @returns {object} The profile, with appliedThreads/appliedSimd filled in.
   */
  function configureOrtEnv(ortRef, profile, env) {
    if (!ortRef || !ortRef.env) return profile;

    const { threads, reason } = resolveThreadCount(profile.wasmThreads, env);

    try {
      ortRef.env.wasm.numThreads = threads;
      ortRef.env.wasm.simd = profile.wasmSimd !== false;

      // The WASM binaries ship with the extension; without this ORT tries to
      // fetch them from a CDN, which the page's CSP will usually block.
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        ortRef.env.wasm.wasmPaths = chrome.runtime.getURL('lib/');
      }
      ortRef.env.logLevel = 'warning';
    } catch (err) {
      console.warn('[Runtime] Could not apply ort.env settings:', err && err.message);
    }

    profile.appliedThreads = threads;
    profile.appliedSimd = profile.wasmSimd !== false;

    if (!_ortConfigured) {
      _ortConfigured = true;
      console.log(
        `[Runtime] ORT WASM: numThreads=${threads} (${reason}), simd=${profile.appliedSimd}.`
      );
      if (profile.tier === RuntimeTier.CPU && threads < profile.wasmThreads) {
        console.warn(
          `[Runtime] Tier B asked for ${profile.wasmThreads} WASM threads but got ${threads}. ` +
          'Threaded WASM needs a cross-origin-isolated document (COOP/COEP); SIMD is still active.'
        );
      }
    }

    return profile;
  }

  // -------------------------------------------------------------------------
  // Session creation
  // -------------------------------------------------------------------------

  /**
   * Create an InferenceSession on the profile's provider chain, falling back to
   * pure WASM if the GPU path throws.
   *
   * The fallback is per-session and deliberate: WebGPU can pass the adapter
   * probe and still fail to build a specific graph (unsupported op, shader
   * compile failure, device lost during init). Losing that one session to CPU
   * is always better than losing proctoring.
   *
   * @param {object} ortRef - The ort namespace.
   * @param {string|Uint8Array} source - Model URL or bytes.
   * @param {object} profile
   * @param {string} [label] - Name used in logs.
   * @returns {Promise<{session:object, provider:string}>}
   */
  /**
   * Does the LOADED ORT BUILD actually have a WebGPU backend?
   *
   * ⚠ This is a different question from probeWebGPU(), and conflating the two
   * was a real production bug. probeWebGPU() asks whether the BROWSER supports
   * WebGPU (navigator.gpu + an adapter). Chrome says yes on almost any modern
   * machine — but `ort.min.js` is the WASM-ONLY bundle, so ORT has no webgpu
   * backend to bind to. Requesting one produced:
   *
   *   "removing requested execution provider "webgpu" ... backend not found"
   *
   * and, because InferenceSession.create() then SUCCEEDS on wasm, the fallback
   * catch below never ran, degradedToWasm was never set, and the session was
   * reported as running on 'webgpu' while executing on CPU — at Tier A's 50 ms
   * cadence, which no CPU can hold. Both halves must be true to claim a GPU.
   *
   * To actually get WebGPU, replace extension/lib/ort.min.js with the
   * WebGPU-enabled bundle (ort.webgpu.min.js / ort.all.min.js). The matching
   * ort-wasm-simd-threaded.jsep.* files are already in lib/.
   *
   * @param {object} ortRef
   * @returns {boolean}
   */
  function ortSupportsWebGpu(ortRef) {
    try {
      // `env.webgpu` is present only in builds that register the JSEP/WebGPU
      // backend. The wasm-only bundle does not define it.
      return !!(ortRef && ortRef.env && typeof ortRef.env.webgpu === 'object' && ortRef.env.webgpu);
    } catch {
      return false;
    }
  }

  async function createSession(ortRef, source, profile, label = 'model') {
    let chain = (profile && profile.executionProviders) || ['wasm'];

    // Strip providers this BUILD cannot bind, rather than letting ORT drop them
    // silently and leaving us to report a GPU we are not using.
    if (chain.indexOf('webgpu') !== -1 && !ortSupportsWebGpu(ortRef)) {
      chain = chain.filter((p) => p !== 'webgpu');
      if (!chain.length) chain = ['wasm'];
      if (profile && !profile.ortLacksWebGpu) {
        profile.ortLacksWebGpu = true;
        profile.degradedToWasm = true;
        console.warn(
          '[Runtime] The browser supports WebGPU but this onnxruntime-web build has no ' +
          'webgpu backend, so every session runs on WASM. Replace extension/lib/ort.min.js ' +
          'with the WebGPU bundle (ort.webgpu.min.js) to use the GPU; the .jsep wasm files ' +
          'are already present.'
        );
      }
    }

    try {
      const session = await ortRef.InferenceSession.create(source, { executionProviders: chain });
      console.log(`[Runtime] '${label}' session ready on [${chain.join(', ')}].`);
      return { session, provider: chain[0] };
    } catch (err) {
      if (chain.length === 1 && chain[0] === 'wasm') throw err; // nothing left to try

      console.warn(
        `[Runtime] '${label}' failed on [${chain.join(', ')}] (${err && err.message}); ` +
        'retrying on pure WASM.'
      );
      const session = await ortRef.InferenceSession.create(source, { executionProviders: ['wasm'] });
      if (profile) profile.degradedToWasm = true;
      console.log(`[Runtime] '${label}' session ready on [wasm] after GPU fallback.`);
      return { session, provider: 'wasm' };
    }
  }

  // -------------------------------------------------------------------------
  // Input resolution
  // -------------------------------------------------------------------------

  /**
   * Read the square input edge length off session metadata.
   *
   * Returns null when the graph has a dynamic spatial axis (or the runtime does
   * not expose shapes), which is the signal that the caller is free to choose.
   *
   * @param {object} session
   * @returns {number|null}
   */
  function resolveSessionInputSize(session) {
    try {
      const meta = session && session.inputMetadata;
      if (!meta) return null;

      const entry = Array.isArray(meta) ? meta[0] : meta[session.inputNames[0]];
      const dims = entry && (entry.shape || entry.dimensions);
      if (!Array.isArray(dims) || dims.length !== 4) return null;

      const h = dims[2]; // NCHW
      return (typeof h === 'number' && h > 0) ? h : null;
    } catch {
      return null;
    }
  }

  /**
   * Reconcile what the tier WANTS with what the graph ACCEPTS.
   *
   * A static graph wins unconditionally — feeding it anything else is a hard
   * runtime error, not a slow path. Only a dynamic graph gets the tier's
   * preferred (and capped) size.
   *
   * @param {number} preferred - The tier's preferred edge length.
   * @param {number|null} modelStatic - From resolveSessionInputSize(), or null if dynamic.
   * @param {number} [maxSize] - Tier cap.
   * @returns {{size:number, honored:boolean, isStatic:boolean}}
   */
  function clampInputSize(preferred, modelStatic, maxSize) {
    const cap = maxSize || preferred;
    const want = Math.min(preferred, cap);

    if (typeof modelStatic === 'number' && modelStatic > 0) {
      return { size: modelStatic, honored: modelStatic <= cap, isStatic: true };
    }
    return { size: want, honored: true, isStatic: false };
  }

  return {
    RuntimeTier,
    TIER_PROFILES,
    probeWebGPU,
    ortSupportsWebGpu,
    resolveThreadCount,
    resolveRuntimeProfile,
    getRuntimeProfile,
    resetRuntimeProfile,
    configureOrtEnv,
    createSession,
    resolveSessionInputSize,
    clampInputSize,
  };
}));
