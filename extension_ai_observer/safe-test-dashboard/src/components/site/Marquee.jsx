// =============================================================================
// Marquee — two counter-drifting rows, per the confirmit-eg.com benchmark.
//
// ⚠ WHAT IT SCROLLS IS NOT CUSTOMER LOGOS. The benchmark uses two rows of client
// wordmarks. Inventing those would put fabricated social proof on a page whose
// argument is that this product does not fabricate things — the same failure as
// a fake telemetry readout, just aimed at a different audience.
//
// So the rows carry claims about the product instead. They used to be engine
// internals (478-point mesh, EAR = V/H, veto threshold 0.20) — checkable, but
// meaningless to the Department Head this page is now written for. They are now
// the same commitments in the buyer's language. Every one is still a statement
// the codebase backs; none cites a figure, so none can quietly go stale.
//
// The animation is a `translateX` on a duplicated track. That is NOT a mirror —
// it has nothing to do with R3 — and the global prefers-reduced-motion block in
// theme.css collapses it to a static strip.
// =============================================================================

const ROW_ONE = [
  'No video leaves the device',
  'Evidence snapshot only on a real flag',
  'Runs in the student’s own browser',
  'No lockdown browser',
  'No administrator rights',
  'Model served from your origin, not a CDN',
];

const ROW_TWO = [
  'A blink is not misconduct',
  'A glance at the keyboard is not misconduct',
  'Unreadable is reported as unreadable',
  'Every flag carries the frame it was raised on',
  'Suppressed flags are logged too',
  'Flat pricing, never per incident',
];

function Track({ items, reverse = false }) {
  // The list is rendered twice so the -50% translate wraps seamlessly. The
  // duplicate is aria-hidden: a screen reader should hear each claim once.
  return (
    <div className="relative flex overflow-hidden">
      <ul
        className="marquee-track flex shrink-0 items-center gap-3 pr-3"
        style={reverse ? { animationDirection: 'reverse' } : undefined}
      >
        {[...items, ...items].map((item, i) => (
          <li
            key={`${item}-${i}`}
            aria-hidden={i >= items.length ? 'true' : undefined}
            className="shrink-0 rounded-full border border-cyan-500/15 bg-surface/70 px-4 py-2 text-xs whitespace-nowrap text-slate-400"
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Marquee() {
  return (
    <section aria-label="What Procminds commits to" className="border-y border-cyan-500/10 py-8">
      <div className="mx-auto max-w-7xl space-y-3 px-4 sm:px-6">
        <Track items={ROW_ONE} />
        <Track items={ROW_TWO} reverse />
      </div>
    </section>
  );
}
