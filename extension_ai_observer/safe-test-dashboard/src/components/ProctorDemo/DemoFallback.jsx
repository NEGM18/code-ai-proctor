// =============================================================================
// DemoFallback — PLAN.md §7's degradation table, rendered.
//
// One row per failure code, each saying what happened and what the visitor can
// do about it. Two of these are load-bearing rather than cosmetic:
//
// ⚠ INSECURE_CONTEXT NEVER PROMPTS. The hook checks `isSecureContext` before it
// calls getUserMedia at all, because asking for a camera we are structurally
// unable to receive trains people to click through permission dialogs.
//
// ⚠ MODEL_LOAD_FAILED HAS ALREADY STOPPED THE STREAM by the time this renders.
// A live preview beside a dead engine implies analysis is happening — that would
// be the demo's very first lie, on a page whose entire argument is that it does
// not tell them.
// =============================================================================

import { DEMO_ERROR } from '../../hooks/useProctorDemo.js';

const ROWS = {
  [DEMO_ERROR.INSECURE_CONTEXT]: {
    title: 'Camera requires HTTPS',
    body: 'Browsers only expose a camera to secure pages. Open this site over HTTPS, or on localhost, and the demo will run.',
    retry: false,
  },
  [DEMO_ERROR.UNSUPPORTED]: {
    title: 'This browser cannot run the demo',
    body: 'No camera API is available here. A current version of Chrome, Edge, Firefox or Safari will work.',
    retry: false,
  },
  [DEMO_ERROR.CAMERA_DENIED]: {
    title: 'Camera permission was declined',
    body: 'Open the permissions control in your address bar, allow camera access for this site, then try again. Nothing is recorded or uploaded either way.',
    retry: true,
  },
  [DEMO_ERROR.CAMERA_ABSENT]: {
    title: 'No camera found',
    body: 'No device matching the demo’s constraints is connected. Plug one in and try again.',
    retry: true,
  },
  [DEMO_ERROR.CAMERA_BUSY]: {
    title: 'Another app is using the camera',
    body: 'Close any video call or recording software holding the device, then try again.',
    retry: true,
  },
  [DEMO_ERROR.CAMERA_FAILED]: {
    title: 'The camera could not be opened',
    body: 'The browser refused the device for a reason it did not name. Reconnecting the camera, or reloading the page, usually clears it.',
    retry: true,
  },
  [DEMO_ERROR.MODEL_LOAD_FAILED]: {
    title: 'The vision model could not load',
    body: 'The face-landmark model is served from this site rather than a CDN, so a blocked or offline network stops it. The camera has been switched off — a live preview with a dead engine would imply analysis that is not happening.',
    retry: true,
  },
};

/**
 * @param {object} props
 * @param {string|null} props.errorCode
 * @param {() => void} props.onRetry
 */
export default function DemoFallback({ errorCode, onRetry }) {
  const row = ROWS[errorCode];
  if (!row) return null;

  return (
    <div role="alert" className="rounded-card border border-glance/40 bg-glance-dim/20 p-5">
      <h3 className="text-sm font-semibold text-glance">{row.title}</h3>
      <p className="mt-2 text-xs leading-relaxed text-slate-300">{row.body}</p>

      <p className="tnum mt-3 font-mono text-[10px] text-slate-600">{errorCode}</p>

      {row.retry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-md bg-slate-100 px-4 py-2 text-xs font-semibold text-[var(--color-base)] transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-verified"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
