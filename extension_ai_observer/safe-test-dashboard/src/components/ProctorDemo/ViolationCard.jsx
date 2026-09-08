// =============================================================================
// ViolationCard — one reported violation, with its evidence.
//
// ⚠ THE THUMBNAIL IS NOT MIRRORED, AND THAT IS CORRECT. `drawImage` in
// snapshot.js ignores CSS transforms, so the capture is in the same unmirrored
// space as the landmarks that triggered it. Applying `.demo-mirror` here to
// "match what the student saw" would put the evidence and the geometry in
// different coordinate spaces — the image would disagree with the record beside
// it about which side anything was on.
//
// ⚠ `snapshot: null` IS A REAL OUTCOME, NOT AN ERROR. captureSnapshot returns
// null when the video has no frame to read. The card says "no frame available"
// rather than rendering a blank tile, because a blank image attached to a real
// accusation is a fabricated record — worse than no image at all.
// =============================================================================

import { useState } from 'react';

const SEVERITY = {
  CRITICAL: ['bg-violation-dim/60 text-violation ring-violation/50', 'Critical'],
  HIGH: ['bg-violation-dim/50 text-violation ring-violation/40', 'High'],
  MEDIUM: ['bg-glance-dim/50 text-glance ring-glance/40', 'Medium'],
  LOW: ['bg-slate-800 text-slate-300 ring-slate-600/50', 'Low'],
};

/** Engine type -> what a human would call it. */
const TYPE_COPY = {
  AI_CHEATING_POSE: 'Sustained look-away',
  HEAD_POSE_GLANCE: 'Brief look-away',
  NO_FACE_DETECTED: 'Face not visible',
  MULTIPLE_FACES: 'More than one person',
  SIDE_GAZE_PEEKING: 'Side gaze',
};

/**
 * How long ago this was reported, from the latest engine timestamp.
 *
 * ⚠ `null` WHEN THE CLOCK IS NOT LIVE. While the tab is hidden the readout is
 * blanked, so there is no current time to measure against — and an age is a
 * statement about NOW. Freezing the last one would put a stale number beside a
 * paused panel, which is the §7 lie in miniature.
 */
function age(tMs, nowMs) {
  if (!Number.isFinite(nowMs) || nowMs <= 0 || nowMs < tMs) return null;
  return `${((nowMs - tMs) / 1000).toFixed(1)}s ago`;
}

/**
 * @param {object} props
 * @param {object} props.record
 * @param {number} props.nowMs latest engine timestamp, 0 when not live.
 * @param {(record: object) => string|null} props.createSnapshotUrl
 */
export default function ViolationCard({ record, nowMs, createSnapshotUrl }) {
  const [opened, setOpened] = useState(false);
  const [tone, label] = SEVERITY[record.severity] ?? SEVERITY.LOW;

  const openFullSize = () => {
    // Object URLs are minted ONLY here, registered by the hook, and revoked on a
    // 60 s timer plus on modal close. The thumbnail below uses the data URL
    // directly and has nothing to revoke.
    const url = createSnapshotUrl(record);
    if (url) {
      setOpened(true);
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <li className="rounded-card border border-slate-800 bg-surface-raised/70 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ring-1 ${tone}`}>
              {label}
            </span>
            <h4 className="truncate text-sm font-medium text-slate-100">
              {TYPE_COPY[record.type] ?? record.type}
            </h4>
            <span className="tnum ml-auto font-mono text-[11px] text-slate-500">
              {age(record.tMs, nowMs) ?? <span className="text-unknown">—</span>}
            </span>
          </div>

          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px] text-slate-400">
            <div className="flex gap-1.5">
              <dt className="text-slate-600">EAR</dt>
              {/* The EAR the veto ACTUALLY evaluated on this frame. A non-finite
                  value means the gate had no fresh sample and failed open — it
                  renders as an em-dash, never as 0. */}
              <dd className="tnum">
                {Number.isFinite(record.ear)
                  ? record.ear.toFixed(3)
                  : <span className="text-unknown">—</span>}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-slate-600">gate</dt>
              <dd className="truncate">
                {record.earChecked ?? <span className="text-unknown">—</span>}
              </dd>
            </div>
          </dl>
        </div>

        {record.snapshot?.dataUrl ? (
          <button
            type="button"
            onClick={openFullSize}
            className="beam shrink-0 overflow-hidden rounded-md ring-1 ring-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-verified"
            title="Open evidence snapshot full size"
          >
            <img
              src={record.snapshot.dataUrl}
              alt="Evidence snapshot"
              width={96}
              height={72}
              className="ph-no-capture ph-ignore-input h-[72px] w-24 object-cover"
            />
          </button>
        ) : (
          <p className="w-24 shrink-0 self-center text-center text-[10px] leading-tight text-unknown">
            no frame available
          </p>
        )}
      </div>

      {opened ? (
        <p className="mt-2 text-[10px] text-slate-600">
          Opened in a new tab. The link expires in 60 seconds and on closing this demo.
        </p>
      ) : null}
    </li>
  );
}
