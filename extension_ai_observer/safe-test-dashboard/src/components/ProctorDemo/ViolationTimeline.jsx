// =============================================================================
// ViolationTimeline — what the engine reported, newest first.
//
// ⚠ THE LIVE REGION ANNOUNCES TYPE AND TIME ONLY. A screen-reader user must not
// have EAR values, gate reasons and snapshot descriptions read aloud at them
// every few seconds while they are trying to use the page; the detail is in the
// cards, which are navigable at their own pace. `aria-live="polite"` also means
// an announcement waits for a pause rather than interrupting.
//
// ⚠ AN EMPTY TIMELINE IS THE EXPECTED STATE, and the copy says so. Rendering
// "no violations" as a neutral fact rather than as an error is the honest
// framing: the demo is not broken when it accuses nobody, it is working.
// =============================================================================

import ViolationCard from './ViolationCard.jsx';

const TYPE_COPY = {
  AI_CHEATING_POSE: 'Sustained look-away',
  HEAD_POSE_GLANCE: 'Brief look-away',
  NO_FACE_DETECTED: 'Face not visible',
  MULTIPLE_FACES: 'More than one person',
  SIDE_GAZE_PEEKING: 'Side gaze',
};

/**
 * @param {object} props
 * @param {Array<object>} props.violations newest first, capped at 40 by the hook.
 * @param {number} props.nowMs latest engine timestamp, 0 when not live.
 * @param {(record: object) => string|null} props.createSnapshotUrl
 */
export default function ViolationTimeline({ violations, nowMs, createSnapshotUrl }) {
  const latest = violations[0] ?? null;

  return (
    <section aria-label="Violation timeline" className="glass flex min-h-0 flex-col rounded-card p-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium tracking-wide text-slate-400 uppercase">Reported</h3>
        <span className="tnum font-mono text-[11px] text-slate-500">
          {violations.length} {violations.length === 1 ? 'event' : 'events'}
        </span>
      </header>

      {/* Type + time only — see the header note. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {latest ? `${TYPE_COPY[latest.type] ?? latest.type} reported` : ''}
      </p>

      {violations.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-700 p-4 text-center text-xs leading-relaxed text-slate-500">
          Nothing reported yet.
          <span className="mt-1 block text-slate-600">
            Blinking, closing your eyes and looking down at a keyboard are all
            supposed to appear here as <em>nothing</em>.
          </span>
        </p>
      ) : (
        <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
          {violations.map((record) => (
            <ViolationCard
              key={record.id}
              record={record}
              nowMs={nowMs}
              createSnapshotUrl={createSnapshotUrl}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
