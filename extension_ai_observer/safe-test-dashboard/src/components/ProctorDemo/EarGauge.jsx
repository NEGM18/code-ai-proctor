// =============================================================================
// EarGauge — the eye-aspect-ratio reading, and the veto threshold it is judged
// against.
//
// This is the component that shows the blink-immunity safeguard doing its work,
// so two things about it are load-bearing rather than cosmetic:
//
// ⚠ 1. THE THRESHOLD TICK IS IMPORTED, NOT TYPED. `DEFAULT_VETO_OPTS.earThreshold`
//      is the number `EarVetoGate.evaluate()` actually compares against. A
//      literal `0.20` here would be correct today and silently wrong the moment
//      the gate is retuned — the bar would show the student clearing a line the
//      safeguard is no longer using. PLAN.md §6 states this as a rule: no
//      literal 0.20 in any component.
//
// ⚠ 2. NULL IS A HATCH, NOT A ZERO. An unreadable EAR renders as texture and an
//      em-dash. `ear ?? 0` would paint an empty bar, which reads as "eyes wide
//      shut" — a confident measurement of something nobody measured. This is the
//      exact failure that hid the `_readEar` defect for a whole phase: a dead
//      gauge looks like honest degradation.
// =============================================================================

import { DEFAULT_VETO_OPTS } from '../../vision/ear_veto.js';
import Unreadable from './Unreadable.jsx';

/** Full-scale for the bar. A wide-open eye sits near 0.35; 0.45 leaves headroom
 *  without compressing the interesting band around the threshold. */
const SCALE_MAX = 0.45;

const THRESHOLD = DEFAULT_VETO_OPTS.earThreshold;

/**
 * @param {object} props
 * @param {number|null} props.ear  null means UNREADABLE. Never coerce it.
 * @param {boolean} [props.paused] tab hidden — say so, do not show the last value.
 */
export default function EarGauge({ ear, paused = false }) {
  const readable = !paused && ear !== null && Number.isFinite(ear);
  const pct = readable ? Math.min(100, Math.max(0, (ear / SCALE_MAX) * 100)) : 0;
  const closed = readable && ear < THRESHOLD;

  return (
    <section aria-label="Eye aspect ratio" className="glass rounded-card p-4">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium tracking-wide text-slate-400 uppercase">
          Eye aspect ratio
        </h3>
        <p className="tnum font-mono text-lg leading-none">
          {readable
            ? <span className={closed ? 'text-unknown' : 'text-verified'}>{ear.toFixed(3)}</span>
            : <Unreadable label="EAR" />}
        </p>
      </header>

      {/* The track. Unreadable => the WHOLE track is hatched, so there is no bar
          to misread as a small value. */}
      <div className="relative mt-3 h-6 overflow-hidden rounded-[5px] bg-surface-raised ring-1 ring-slate-700/60">
        {readable ? (
          <div
            className={`h-full origin-left transition-[width] duration-200 ease-out ${
              closed ? 'bg-unknown-dim' : 'bg-verified/70'
            }`}
            style={{ width: `${pct}%` }}
          />
        ) : (
          <Unreadable variant="hatch" label="EAR" />
        )}

        {/* The veto line. Rendered even when the value is unreadable: the
            threshold is a property of the safeguard, not of this frame. */}
        <div
          className="absolute inset-y-0 w-px bg-glance"
          style={{ left: `${(THRESHOLD / SCALE_MAX) * 100}%` }}
          aria-hidden="true"
        />
      </div>

      <footer className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
        <span className="tnum font-mono">
          veto threshold {THRESHOLD.toFixed(2)}
        </span>
        <span>
          {paused
            ? 'paused — not measuring'
            : readable
              ? (closed ? 'eyes closed — gaze alerts suppressed' : 'eyes open — gaze alerts live')
              : 'no fresh sample — safeguard fails open'}
        </span>
      </footer>
    </section>
  );
}
