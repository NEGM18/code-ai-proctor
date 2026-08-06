// =============================================================================
// CameraStage — the video, the overlay, and THE ONE MIRROR.
//
// ⚠⚠ R3 LIVES HERE, ON EXACTLY ONE ELEMENT.
//
// `.demo-mirror` (`transform: scaleX(-1)`, defined once in theme.css) is applied
// to the wrapper below that is a COMMON ANCESTOR of both the <video> and the
// overlay <canvas>. That single placement is what buys three properties at once:
//
//   1. The visitor sees themselves the way a mirror shows them, which is the
//      only orientation a webcam preview is usable in.
//   2. The overlay draws in RAW UNMIRRORED VIDEO-PIXEL COORDINATES, because it
//      is flipped by the same transform as the pixels it annotates. No JS ever
//      negates a landmark x.
//   3. `drawImage(video, …)` in snapshot.js ignores CSS transforms, so evidence
//      snapshots come out unmirrored and therefore agree with the landmarks that
//      triggered them.
//
// ⚠ THE LABEL LAYER IS A SIBLING OF THE MIRROR, NOT A CHILD. Chips and status
// text rendered inside the wrapper would come out backwards. They are positioned
// over the stage from outside it, which is also why no `scaleX(-1)` "correction"
// is needed anywhere — a second flip to un-flip a caption is exactly the change
// that double-flips a layer and silently puts every box on the wrong eye.
// =============================================================================

import OverlayCanvas from './OverlayCanvas.jsx';

function Chip({ tone = 'neutral', children }) {
  const tones = {
    neutral: 'bg-slate-800/80 text-slate-300 ring-slate-600/50',
    warn: 'bg-glance-dim/70 text-glance ring-glance/40',
    good: 'bg-verified-dim/60 text-verified ring-verified/40',
  };
  return (
    <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 backdrop-blur-sm ${tones[tone]}`}>
      {children}
    </span>
  );
}

/**
 * @param {object} props
 * @param {{current: HTMLVideoElement|null}} props.videoRef
 * @param {{current: object|null}} props.frameStateRef
 * @param {object} props.paintLoop
 * @param {boolean} props.isRunning
 * @param {boolean} props.isPaused
 * @param {boolean} props.cpuMode
 * @param {boolean} props.lowFps
 * @param {number|null} props.fps
 */
export default function CameraStage({
  videoRef,
  frameStateRef,
  paintLoop,
  isRunning,
  isPaused,
  cpuMode,
  lowFps,
  fps,
}) {
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-card bg-base ring-1 ring-slate-700/60">
      {/* ⚠⚠ THE ONE AND ONLY `.demo-mirror` IN THE APPLICATION.
          Both children below are flipped by this element together. Do not add a
          transform to either of them, and do not add a second one anywhere. */}
      <div className="demo-mirror absolute inset-0">
        {/* No `autoPlay`: the stream is attached and played explicitly by the
            hook, inside the user-gesture path, so the camera never starts on
            page load. */}
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          playsInline
          muted
        />
        <OverlayCanvas
          frameStateRef={frameStateRef}
          paintLoop={paintLoop}
          active={isRunning}
        />
      </div>

      {/* ---- UN-MIRRORED SIBLING LAYER. All text lives out here. ---- */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
        <div className="flex flex-wrap items-start gap-2">
          {isRunning ? <Chip tone="good">analysing on-device</Chip> : null}
          {cpuMode ? <Chip tone="warn">CPU mode</Chip> : null}
          {lowFps && fps !== null ? <Chip tone="warn">reduced rate — {fps} fps</Chip> : null}
        </div>

        <div className="flex flex-wrap items-end justify-between gap-2">
          <Chip>no video leaves this device</Chip>
        </div>
      </div>

      {/* Paused veil. Covers the preview so a frozen frame cannot be read as a
          live one — §7: the UI must say "paused", not show the stale value. */}
      {isPaused ? (
        <div className="absolute inset-0 grid place-items-center bg-base/70 backdrop-blur-sm">
          <p className="text-sm text-slate-300">Paused — analysis stopped with the tab</p>
        </div>
      ) : null}
    </div>
  );
}
