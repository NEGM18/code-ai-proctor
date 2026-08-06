// =============================================================================
// usePaintLoop — PLAN.md §6 Phase 6.
//
// ONE requestAnimationFrame for the WHOLE modal, with a subscriber registry.
//
// Why not one rAF per component: the overlay canvas, the EAR gauge and the gaze
// readout all want to paint from the same per-frame snapshot. Three independent
// rAF callbacks would each read layout (getBoundingClientRect / clientWidth) on
// their own schedule and interleave unpredictably with each other's writes,
// which is both a layout-thrash problem and a correctness one: two subscribers
// could paint two DIFFERENT frames in the same visual frame, so the gauge would
// disagree with the boxes drawn beside it.
//
// The loop is DRIVEN BY DEMAND — it starts on the first subscriber and stops on
// the last unsubscribe, so a closed modal costs nothing. `stop()` is exposed for
// the explicit teardown order (engine.stop() -> cancelAnimationFrame -> ...).
//
// ⚠ This is the PAINT clock only. The analysis clock is a self-scheduling
// setTimeout inside ProctorDemoEngine, deliberately NOT rAF: rAF is throttled to
// ~0 Hz on a hidden tab, which would freeze analysis while the UI still looked
// live. Never merge the two.
// =============================================================================

import { useEffect, useRef, useState } from 'react';

/**
 * @returns {{subscribe:(fn:(tMs:number)=>void)=>()=>void, stop:()=>void, size:()=>number}}
 */
export function createPaintLoop() {
  const subscribers = new Set();
  let handle = null;

  const tick = (tMs) => {
    // Re-arm FIRST so a throwing subscriber cannot kill the loop.
    handle = requestAnimationFrame(tick);
    for (const fn of subscribers) {
      try {
        fn(tMs);
      } catch (err) {
        console.error('[usePaintLoop] subscriber threw', err);
      }
    }
  };

  const stop = () => {
    if (handle !== null) {
      cancelAnimationFrame(handle);
      handle = null;
    }
  };

  return {
    subscribe(fn) {
      subscribers.add(fn);
      if (handle === null) handle = requestAnimationFrame(tick);
      return () => {
        subscribers.delete(fn);
        if (subscribers.size === 0) stop();
      };
    },
    stop,
    size: () => subscribers.size,
  };
}

/**
 * Owns one paint loop for the lifetime of the calling component.
 *
 * Created through `useState`'s lazy initialiser rather than by assigning to a
 * ref during render — under the React Compiler, mutating a ref while rendering
 * is not a supported pattern, and this keeps the object identity stable without
 * one.
 */
export function usePaintLoop() {
  const [loop] = useState(createPaintLoop);

  useEffect(() => () => loop.stop(), [loop]);

  return loop;
}

/**
 * Subscribe `callback` to `loop` for as long as the component is mounted.
 *
 * The callback is held in a ref and re-read on every frame, so a subscriber
 * whose closure changes identity every render (the common case under the
 * compiler) does NOT churn the registry — subscribing/unsubscribing 60 times a
 * second would defeat the point of having one loop.
 *
 * @param {ReturnType<createPaintLoop>|null} loop
 * @param {(tMs:number)=>void} callback
 * @param {boolean} [active=true] false unsubscribes without unmounting.
 */
export function usePaintSubscriber(loop, callback, active = true) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!loop || !active) return undefined;
    return loop.subscribe((tMs) => {
      const fn = callbackRef.current;
      if (fn) fn(tMs);
    });
  }, [loop, active]);
}
