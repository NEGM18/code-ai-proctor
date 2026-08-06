// =============================================================================
// Hero — the sales headline and one CTA pair.
//
// ⚠ Previously included an inline "instrument panel" here rendering the demo
// engine's real empty state (every field hatched via `Unreadable`, never fake
// telemetry — see git history for the full rationale). Removed per request:
// the panel stays fully intact and reachable inside the actual live demo
// modal (`ProctorDemoModal`, opened by the CTA below); this file no longer
// duplicates a static preview of it on the landing page itself.
// =============================================================================

const BADGES = [
  'No video ever uploaded',
  'Runs on the student’s device',
  'No admin install, no lockdown browser',
  'Works in Chrome',
];

/**
 * @param {object} props
 * @param {() => void} props.onTryDemo
 */
export default function Hero({ onTryDemo }) {
  return (
    <section id="top" className="relative overflow-hidden px-4 pt-16 pb-20 sm:px-6 sm:pt-24">
      {/* ---- ambient backdrop ------------------------------------------------
          THEME.md §3: every layer here is CHROME. The grid, the orbs and the
          eye mark carry no verdict meaning and must never be read as one. The
          whole stack is aria-hidden and pointer-events-none — it is atmosphere,
          not content, and it must never intercept a click meant for the UI. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
        <div className="cyber-grid absolute inset-0 opacity-60" />
        <div className="orb animate-pulse-slow top-[-15%] left-[-10%] h-[420px] w-[420px] bg-cyan-500/40" />
        <div
          className="orb animate-pulse-slow top-[20%] right-[-12%] h-[480px] w-[480px] bg-blue-700/45"
          style={{ animationDelay: '2s' }}
        />
        <div
          className="orb animate-pulse-slow bottom-[-20%] left-[25%] h-[440px] w-[440px] bg-sky-600/30"
          style={{ animationDelay: '1s' }}
        />
        {/* The cyber-eye mark, floating well behind the text. alt="" (not a
            description) because it duplicates the wordmark already in the nav —
            announcing it again is noise. */}
        <img
          src="/brand/logo-transparent.png"
          alt=""
          className="animate-float absolute top-20 left-1/2 w-[520px] max-w-none -translate-x-1/2 opacity-[0.07] mix-blend-screen sm:w-[680px]"
        />
      </div>

      <div className="relative z-10 mx-auto max-w-4xl text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-950/40 px-3 py-1 text-xs text-cyan-200 shadow-[0_0_15px_rgba(6,182,212,0.15)] backdrop-blur-sm">
          <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan-400" />
          </span>
          Privacy-first edge AI for academic integrity
        </p>

        <h1 className="font-heading mt-6 text-4xl leading-[1.1] font-semibold tracking-tight text-slate-50 sm:text-6xl">
          AI proctoring that catches real misconduct
          <span className="mt-1 block bg-gradient-to-r from-cyan-400 via-sky-400 to-blue-600 bg-clip-text pb-1 text-transparent drop-shadow-[0_0_25px_rgba(6,182,212,0.35)]">
            without false accusations.
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-slate-400 sm:text-lg">
          Catch phone use, sustained off-screen gaze, and a second person in the
          room — in real time, on the student’s own device. Built so that a
          blink, a stretch, or a glance down at the keyboard is never mistaken
          for cheating.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onTryDemo}
            className="w-full rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-7 py-3.5 text-base font-semibold text-[var(--color-base)] shadow-[0_0_25px_rgba(6,182,212,0.4)] transition-all duration-300 hover:brightness-110 hover:shadow-[0_0_35px_rgba(6,182,212,0.6)] sm:w-auto"
          >
            Try Live Demo
          </button>
          <a
            href="#contact"
            className="w-full rounded-lg border border-cyan-500/20 bg-surface/50 px-7 py-3.5 text-base font-medium text-slate-200 backdrop-blur-sm transition-all duration-300 hover:border-cyan-400/50 hover:bg-surface hover:shadow-[0_0_20px_rgba(6,182,212,0.15)] sm:w-auto"
          >
            Talk to Sales
          </a>
        </div>

        <p className="mt-4 text-xs text-slate-500">
          Runs in your browser. No account, no card, no download — and the camera
          stops the moment you close the panel.
        </p>

        <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {BADGES.map((badge) => (
            <li key={badge} className="flex items-center gap-1.5 text-xs text-slate-500">
              {/* Decorative tick on a feature list — not a verdict, so cyan
                  chrome rather than --color-verified (THEME.md §3). */}
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M6.2 11.4 3.3 8.5l1.1-1.1 1.8 1.8 5-5 1.1 1.1z"
                />
              </svg>
              {badge}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
