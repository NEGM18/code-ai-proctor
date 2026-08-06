// =============================================================================
// Unreadable — THE FOURTH STATE, in one place.
//
// PLAN.md §4 and §7: most UI colour systems have three verdicts (good, warning,
// bad). This one has four, and the fourth is UNKNOWN. Everywhere a value cannot
// be read the UI shows a diagonal hatch or an em-dash — NEVER `0`, NEVER the
// last-known value.
//
// ⚠ WHY THIS IS A COMPONENT AND NOT A CONVENTION. `{ear ?? 0}` and
// `{ear?.toFixed(2)}` both render something plausible for an unreadable frame,
// neither looks wrong in review, and the result is a live gauge showing a number
// nobody measured. Routing every unreadable value through one component means
// the rule is enforced by the type of thing you render, not by remembering it at
// each of the ~20 call sites.
//
// The hatch is a TEXTURE rather than a colour on purpose: a dim colour can be
// mistaken for a low-but-real value, a 45-degree hatch cannot.
// =============================================================================

/**
 * @param {object} props
 * @param {'hatch'|'dash'} [props.variant='dash'] hatch for gauges and bars,
 *   dash for inline figures in a table of readings.
 * @param {string} [props.label='unreadable'] what could not be read, for AT.
 * @param {string} [props.className]
 */
export default function Unreadable({ variant = 'dash', label = 'unreadable', className = '' }) {
  if (variant === 'hatch') {
    return (
      <span
        role="img"
        aria-label={`${label}: unreadable`}
        title={`${label} — unreadable`}
        className={`hatch-unknown block h-full w-full rounded-[3px] ${className}`}
      />
    );
  }

  return (
    <span
      aria-label={`${label}: unreadable`}
      title={`${label} — unreadable`}
      className={`tnum text-unknown select-none ${className}`}
    >
      {'—'}
    </span>
  );
}
