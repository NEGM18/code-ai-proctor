// =============================================================================
// SuppressionLane — THE CENTREPIECE (PLAN.md §6 Phase 6).
//
// Every proctoring vendor claims their system "handles blinking". This lane is
// the difference between claiming it and showing it: each row is an accusation
// the engine was about to make and the EAR veto stopped, with the measured EAR
// that stopped it. A visitor WATCHES the safeguard work instead of reading a
// sentence about it.
//
// ⚠ THE PALETTE IS MUTED ON PURPOSE. These rows are evidence the system worked,
// not evidence against the student, so they use `--color-suppressed` rather than
// the violation ramp. Styling a suppression like a violation would tell the
// visitor the opposite of what happened.
//
// ⚠ AN EMPTY LANE IS NOT A FAILURE, AND THE COPY MUST NOT IMPLY IT IS. In the
// common case nothing reaches the veto at all: `gaze_landmarks.js` gates on EAR
// BEFORE computing any direction, so a closed eye usually produces no event to
// suppress. The veto is the second line of defence, and a quiet lane means the
// first one held.
// =============================================================================

const REASON_COPY = {
  EYE_CLOSED: 'eyes measured closed',
  CLOSURE_HINT: 'eyes closed (coarse channel)',
  KEYBOARD_GLANCE: 'forgiven glance at the keyboard',
  STALE: 'sample too old to trust',
  NO_SAMPLE: 'no eye measurement available',
};

const TYPE_COPY = {
  SIDE_GAZE_PEEKING: 'Side gaze',
  GAZE_OFF_SCREEN: 'Gaze off screen',
  AI_CHEATING_CLASSIFIER: 'Classifier corroboration',
};

/**
 * @param {object} props
 * @param {Array<object>} props.suppressions newest first.
 * @param {number} props.nowMs latest engine timestamp, 0 when not live.
 */
export default function SuppressionLane({ suppressions, nowMs }) {
  // Same rule as ViolationCard: an age is a claim about NOW, so with no live
  // clock there is no age to state.
  const age = (tMs) => (Number.isFinite(nowMs) && nowMs > 0 && nowMs >= tMs
    ? `${((nowMs - tMs) / 1000).toFixed(1)}s ago`
    : '—');
  return (
    <section
      aria-label="Suppressed accusations"
      className="rounded-card border border-suppressed/30 bg-suppressed/5 p-4"
    >
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium tracking-wide text-suppressed uppercase">
          Withheld by the safeguard
        </h3>
        <span className="tnum font-mono text-[11px] text-suppressed/70">
          {suppressions.length}
        </span>
      </header>

      {suppressions.length === 0 ? (
        <p className="text-xs leading-relaxed text-slate-500">
          Nothing withheld yet. The gaze analyser refuses to compute a direction
          from a closed eye in the first place, so most blinks never reach this
          gate at all — it is the second line of defence, not the first.
        </p>
      ) : (
        <ul className="flex max-h-44 flex-col gap-1.5 overflow-y-auto pr-1">
          {suppressions.map((record) => (
            <li
              key={record.id}
              className="flex items-baseline gap-2 rounded-md bg-suppressed/10 px-2.5 py-1.5 text-xs"
            >
              <span className="font-medium text-slate-300">
                {TYPE_COPY[record.type] ?? record.type}
              </span>
              <span className="truncate text-slate-500">
                {REASON_COPY[record.reason] ?? record.reason}
              </span>
              <span className="tnum ml-auto shrink-0 font-mono text-[11px] text-suppressed">
                {/* The number the gate actually judged on. Never a fallback: an
                    invented EAR beside a suppression claim would be the same
                    fabricated reading in the opposite direction. */}
                {Number.isFinite(record.ear) ? `EAR ${record.ear.toFixed(3)}` : 'EAR —'}
              </span>
              <span className="tnum shrink-0 font-mono text-[11px] text-slate-600">
                {age(record.tMs)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
