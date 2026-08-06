// =============================================================================
// MediaPipe WASM loader shim — OPEN half
//
// ⚠ THIS FILE AND `mediapipe_wasm_close.js` ARE A MATCHED PAIR, AND THE FILE
//   BETWEEN THEM IN manifest.json IS PART OF THE MECHANISM. Read both before
//   touching either, and never reorder the three.
//
// THE PROBLEM
// -----------
// `tasks-vision.js` loads MediaPipe's WASM glue like this:
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
// `vision_wasm_internal.js` is a CLASSIC script; appended to `document.body` it
// executes in the PAGE's main world and defines `window.ModuleFactory` there.
// `self.ModuleFactory` inside tasks-vision.js is the CONTENT SCRIPT's isolated
// world, which nothing ever assigns — so the check throws every time.
// `importScripts` is worker-only, so that branch is unreachable here.
//
// WHY NOT eval()
// --------------
// A previous fix fetched the loader and ran `(0, eval)(src)`. Chrome MV3 refuses:
//
//     Evaluating a string as JavaScript violates Content Security Policy...
//     'unsafe-eval' is not an allowed source of script
//
// That applies to the isolated world too, and there is no manifest key that
// re-enables it for content scripts. String evaluation is a dead end, not a
// tuning problem.
//
// THE MECHANISM
// -------------
// A content script IS a static script executing in the isolated world — exactly
// the context the factory has to be defined in. So `vision_wasm_internal.js` is
// listed in manifest.json's content_scripts directly, and its own UMD tail hands
// us the factory without any string parsing:
//
//     if (typeof exports === 'object' && typeof module === 'object') {
//       module.exports = ModuleFactory;
//       ...
//     } else if (typeof define === 'function' && define['amd'])
//
// This file makes the FIRST branch true by installing a CommonJS-shaped shim.
// `mediapipe_wasm_close.js` then moves the captured factory onto the global and
// removes the shim.
//
// ⚠ THE COMMONJS BRANCH IS CHOSEN OVER THE AMD ONE DELIBERATELY. Shimming
// `define.amd` would be visible to any UMD bundle loaded afterwards — and
// `lib/ort.min.js` is exactly such a bundle. It would register itself through
// AMD instead of assigning `self.ort`, and the ONNX stack would vanish. The
// CommonJS shim has the same hazard (several modules here, including
// `mediapipe_source.js`, branch on `typeof module`), which is why the close half
// deletes it immediately and nothing is listed between the two.
// =============================================================================

(function installModuleFactoryShim() {
  'use strict';

  const g = (typeof globalThis !== 'undefined') ? globalThis : self;

  // Nothing to do if the factory is already present — a second document, or a
  // build where the loader happened to reach this world another way.
  if (g.ModuleFactory) return;

  // Remember whether this world genuinely had these, so the close half can
  // restore rather than blindly delete. Neither should exist in a content
  // script, but assuming that and being wrong would silently break whatever did.
  g.__mpShimPrev = {
    hadModule: Object.prototype.hasOwnProperty.call(g, 'module'),
    module: g.module,
    hadExports: Object.prototype.hasOwnProperty.call(g, 'exports'),
    exports: g.exports,
  };

  g.module = { exports: {} };
  g.exports = g.module.exports;
})();
