// =============================================================================
// MediaPipe WASM loader shim — CLOSE half
//
// Runs immediately after `lib/mediapipe/wasm/vision_wasm_internal.js` in
// manifest.json. See `mediapipe_wasm_open.js` for the full rationale; this half
// harvests the factory and takes the shim back out.
//
// ⚠ THE SHIM MUST NOT SURVIVE THIS FILE. A lingering global `module`/`exports`
// makes every UMD module loaded afterwards take its CommonJS branch —
// `mediapipe_source.js` opens with exactly that test and would export itself
// into a discarded object instead of assigning `root.MediaPipeExtensionSource`,
// leaving `vision_engine.js` with no landmark source at all. That failure looks
// nothing like its cause, so the cleanup is unconditional.
// =============================================================================

(function harvestModuleFactory() {
  'use strict';

  const g = (typeof globalThis !== 'undefined') ? globalThis : self;

  try {
    if (!g.ModuleFactory) {
      // Preferred: the loader's CommonJS branch, made reachable by the open half.
      const captured = g.module && g.module.exports;

      // `module.exports.default` is the same function (the loader assigns both);
      // prefer the direct value and fall back for safety.
      const factory = (typeof captured === 'function')
        ? captured
        : (captured && typeof captured.default === 'function' ? captured.default : null);

      if (factory) {
        g.ModuleFactory = factory;
      }
    }

    if (!g.ModuleFactory) {
      // Nothing captured. Say so ONCE and loudly: silence here reappears much
      // later as `ModuleFactory not set` from deep inside tasks-vision.js, with
      // nothing pointing back to this file.
      console.error(
        '[MediaPipe WASM] Loader ran but exported no factory. '
        + 'Check that lib/mediapipe/wasm/vision_wasm_internal.js sits between '
        + 'mediapipe_wasm_open.js and mediapipe_wasm_close.js in manifest.json.'
      );
    }
  } finally {
    // Restore whatever was there before, unconditionally — including on the
    // failure path, where leaving the shim installed would break the next module.
    const prev = g.__mpShimPrev;
    if (prev) {
      if (prev.hadModule) g.module = prev.module; else delete g.module;
      if (prev.hadExports) g.exports = prev.exports; else delete g.exports;
      delete g.__mpShimPrev;
    } else {
      delete g.module;
      delete g.exports;
    }
  }
})();
