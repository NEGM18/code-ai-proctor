// =============================================================================
// ProctorDemoModal — the demo, assembled.
//
// ⚠ THE CAMERA STARTS ON A CLICK, NEVER ON MOUNT. `useProctorDemo.start()` is
// documented as gesture-invoked, and opening the modal into a live camera would
// make the consent step invisible — indefensible on a page whose argument is
// that this product is honest about what it is doing. The modal opens IDLE with
// an explicit button.
//
// ⚠ TEARDOWN IS DRIVEN BY UNMOUNT. The parent renders this component
// conditionally, so closing it unmounts and the hook's cleanup effect runs the
// full ordered teardown: engine.stop() (closing the FaceLandmarker and its WASM
// heap) -> cancel the paint loop -> stop tracks then null srcObject -> revoke
// object URLs -> clear remote evidence -> drop frame state. Calling stop() here
// as well would race that sequence for no benefit.
//
// ⚠ ONE PAINT LOOP FOR THE WHOLE MODAL. Created here and threaded into both the
// overlay (as a subscriber) and the hook (so teardown can cancel the rAF at
// exactly the right position in the order above).
//
// ⚠ BUYER-FACING SIMPLIFICATION: This modal is for buyers, not engineers. It
// shows only the camera feed and the evidence snapshots captured at the moment
// of each violation — the proof. Raw telemetry (EAR, iris, head excursion,
// calibration, FPS) is hidden; the detection engine runs identically behind
// the scenes. If a developer needs the full readout, the components (EarGauge,
// GazeReadout, DemoDiagnostics, SuppressionLane) still exist and can be added
// back via a "detailed view" toggle in a later phase.
// =============================================================================

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { usePaintLoop } from '../../hooks/usePaintLoop.js';
import { useProctorDemo, DEMO_STATUS } from '../../hooks/useProctorDemo.js';
import CameraStage from './CameraStage.jsx';
import DemoFallback from './DemoFallback.jsx';

// ⚠ The final group is `:not([tabindex="-1"])`. It read `…"-1"]]` — an
// unbalanced bracket, which is not a warning but a SyntaxError thrown by
// querySelector. That throw happened inside the focus-trap effect BEFORE the
// keydown listener was attached, so the whole effect aborted and the modal
// silently lost both its focus trap and its Escape handler. Nothing logged a
// failure; the modal just quietly stopped being keyboard-accessible.
const FOCUSABLE = 'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';

const STATUS_COPY = {
  [DEMO_STATUS.IDLE]: 'Ready',
  [DEMO_STATUS.REQUESTING_CAMERA]: 'Waiting for camera…',
  [DEMO_STATUS.LOADING_MODEL]: 'Loading model…',
  [DEMO_STATUS.RUNNING]: 'Monitoring',
  [DEMO_STATUS.PAUSED]: 'Paused',
  [DEMO_STATUS.ERROR]: 'Stopped',
};

/** Engine type -> what a buyer would call it. */
const TYPE_COPY = {
  AI_CHEATING_POSE: 'Looked away',
  HEAD_POSE_GLANCE: 'Brief glance away',
  NO_FACE_DETECTED: 'Left the camera',
  MULTIPLE_FACES: 'Second person visible',
  SIDE_GAZE_PEEKING: 'Side gaze detected',
};

const SEVERITY_STYLE = {
  CRITICAL: 'bg-violation/20 text-violation ring-1 ring-violation/40',
  HIGH: 'bg-violation/15 text-violation ring-1 ring-violation/30',
  MEDIUM: 'bg-glance/15 text-glance ring-1 ring-glance/30',
  LOW: 'bg-slate-800/60 text-slate-300 ring-1 ring-slate-600/40',
};

/**
 * A single evidence card — snapshot image + violation label. Buyer-facing.
 */
function EvidenceCard({ record, createSnapshotUrl }) {
  const [opened, setOpened] = useState(false);
  const style = SEVERITY_STYLE[record.severity] ?? SEVERITY_STYLE.LOW;
  const hasSnapshot = !!record.snapshot?.dataUrl;

  const openFullSize = () => {
    const url = createSnapshotUrl(record);
    if (url) {
      setOpened(true);
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const timestamp = new Date(record.wallTime ?? record.tMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <li className="group flex flex-col overflow-hidden rounded-card border border-slate-800 bg-surface-raised/70 transition hover:border-slate-600">
      {/* Snapshot — the proof */}
      {hasSnapshot ? (
        <button
          type="button"
          onClick={openFullSize}
          className="relative aspect-video w-full overflow-hidden bg-base focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-verified"
          title="Open evidence full size"
        >
          <img
            src={record.snapshot.dataUrl}
            alt={`Evidence: ${TYPE_COPY[record.type] ?? record.type}`}
            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
          />
          {/* Expand icon overlay */}
          <span className="absolute right-2 top-2 rounded-md bg-base/70 px-1.5 py-0.5 text-[10px] text-slate-300 opacity-0 backdrop-blur-sm transition group-hover:opacity-100">
            ↗ Full size
          </span>
        </button>
      ) : (
        <div className="grid aspect-video w-full place-items-center bg-base/50">
          <p className="text-xs text-slate-600">No frame captured</p>
        </div>
      )}

      {/* Label strip */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${style}`}>
          {record.severity?.toLowerCase() ?? 'event'}
        </span>
        <p className="min-w-0 truncate text-sm font-medium text-slate-100">
          {TYPE_COPY[record.type] ?? record.type}
        </p>
        <span className="tnum ml-auto shrink-0 font-mono text-[11px] text-slate-500">
          {timestamp}
        </span>
      </div>

      {opened ? (
        <p className="border-t border-slate-800/60 px-3 py-1.5 text-[10px] text-slate-600">
          Opened in a new tab — link expires in 60 s.
        </p>
      ) : null}
    </li>
  );
}

/**
 * @param {{onClose: () => void}} props
 */
export default function ProctorDemoModal({ onClose }) {
  const paintLoop = usePaintLoop();
  const demo = useProctorDemo({ paintLoop });

  const dialogRef = useRef(null);
  const titleId = useId();

  const idle = demo.status === DEMO_STATUS.IDLE;

  const handleClose = useCallback(() => { onClose(); }, [onClose]);

  // Esc + focus trap.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return undefined;

    const previouslyFocused = document.activeElement;
    node.querySelector(FOCUSABLE)?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        handleClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(node.querySelectorAll(FOCUSABLE))
        .filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      node.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [handleClose]);

  const busy = demo.status === DEMO_STATUS.REQUESTING_CAMERA
    || demo.status === DEMO_STATUS.LOADING_MODEL;

  const isRunning = demo.status === DEMO_STATUS.RUNNING;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-base/85 p-4 backdrop-blur-sm sm:p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="glass my-auto w-full max-w-5xl rounded-card p-4 shadow-2xl sm:p-6"
      >
        {/* ---- header ---- */}
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-slate-100">
              Live proctoring demo
            </h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-400">
              Try it yourself — look away, cover the camera, or have someone join
              the frame. Every violation is captured with a timestamped snapshot
              as proof.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {isRunning ? (
              <span className="flex items-center gap-1.5 rounded-full bg-verified/15 px-3 py-1 text-[11px] font-medium text-verified">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-verified" aria-hidden="true" />
                Monitoring
              </span>
            ) : (
              <span className="rounded-full bg-slate-800/80 px-3 py-1 text-[11px] text-slate-400">
                {STATUS_COPY[demo.status]}
              </span>
            )}
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-verified"
            >
              Close
            </button>
          </div>
        </header>

        {/* ---- camera + evidence ---- */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          {/* Left: camera */}
          <div className="flex flex-col gap-4">
            <CameraStage
              videoRef={demo.videoRef}
              frameStateRef={demo.frameStateRef}
              paintLoop={paintLoop}
              isRunning={demo.isRunning}
              isPaused={demo.isPaused}
              cpuMode={demo.cpuMode}
              lowFps={demo.lowFps}
              fps={demo.readout.fps}
            />

            {demo.status === DEMO_STATUS.ERROR ? (
              <DemoFallback errorCode={demo.errorCode} onRetry={demo.restart} />
            ) : null}

            {idle ? (
              <div className="rounded-card border border-slate-800 bg-surface-raised/60 p-5 text-center">
                <p className="text-sm leading-relaxed text-slate-300">
                  Allow your camera to start. The video stays in this tab —
                  nothing is uploaded.
                </p>
                <button
                  type="button"
                  onClick={demo.start}
                  className="beam mt-4 rounded-lg bg-verified px-6 py-2.5 text-sm font-semibold text-[var(--color-base)] transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-verified"
                >
                  Enable camera &amp; start
                </button>
              </div>
            ) : null}

            {busy ? (
              <p className="text-center text-xs text-slate-400" aria-live="polite">
                {STATUS_COPY[demo.status]}
              </p>
            ) : null}
          </div>

          {/* Right: evidence gallery */}
          <section aria-label="Evidence snapshots" className="flex flex-col">
            <header className="mb-3 flex items-baseline justify-between gap-3">
              <h3 className="text-xs font-medium tracking-wide text-slate-400 uppercase">
                Evidence
              </h3>
              <span className="tnum font-mono text-[11px] text-slate-500">
                {demo.violations.length}{' '}
                {demo.violations.length === 1 ? 'incident' : 'incidents'}
              </span>
            </header>

            {demo.violations.length === 0 ? (
              <div className="grid flex-1 place-items-center rounded-card border border-dashed border-slate-700 p-6">
                <div className="text-center">
                  <p className="text-3xl" aria-hidden="true">📷</p>
                  <p className="mt-3 text-sm text-slate-300">
                    {isRunning ? 'No incidents yet' : 'Start the demo to begin monitoring'}
                  </p>
                  <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-500">
                    {isRunning
                      ? 'Try looking away or covering the camera — each violation is captured with a photo as evidence.'
                      : 'Every violation is automatically captured with a timestamped snapshot you can use as proof.'}
                  </p>
                </div>
              </div>
            ) : (
              <ul className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto pr-1">
                {/* Screen-reader live-region — type only. */}
                <p className="sr-only" aria-live="polite" aria-atomic="true">
                  {demo.violations[0]
                    ? `${TYPE_COPY[demo.violations[0].type] ?? demo.violations[0].type} detected`
                    : ''}
                </p>
                {demo.violations.map((record) => (
                  <EvidenceCard
                    key={record.id}
                    record={record}
                    createSnapshotUrl={demo.createSnapshotUrl}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* ---- footer ---- */}
        <footer className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-800 pt-3">
          <button
            type="button"
            onClick={demo.restart}
            disabled={idle || busy}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-verified"
          >
            Restart
          </button>
          <p className="text-[10px] leading-relaxed text-slate-600">
            Blinking and looking at your keyboard are{' '}
            <span className="text-slate-400">not</span> reported — that is the
            point. Cover the camera or look away for two seconds to see a capture.
          </p>
        </footer>
      </div>
    </div>
  );
}
