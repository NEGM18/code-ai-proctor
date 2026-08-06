// =============================================================================
// WhyInstructors — SECTION 2: the three objections a Department Head actually
// has, answered in their terms.
//
// The order is deliberate and is the order the objections arrive in:
//   1. "Will this accuse my students unfairly?"   ← the deal-breaker
//   2. "What happens when a student appeals?"     ← the operational cost
//   3. "What will this cost me in IT support?"    ← the rollout blocker
//
// ⚠ NO INVENTED METRICS. The brief for this section asked for "resolve appeals
// in 30 seconds". Nobody has measured that, so it is not stated here — a number
// on a sales page reads as a benchmark, and an unmeasured benchmark is the same
// class of thing as a fabricated telemetry readout. The claims below are
// structural ("the evidence is attached to the incident"), which is true by
// construction and cannot quietly become wrong.
// =============================================================================

const REASONS = [
  {
    eyebrow: 'Fairness',
    title: 'It does not accuse a student for blinking',
    body: [
      'Most systems return a verdict on every frame, which means they also return a verdict on frames they could not actually read — a blink, a turned head, a dark room, a candidate who wears glasses.',
      'This one reports “not measurable” instead, and a reading it could not take can never become an allegation. Looking down at the keyboard while typing is treated as typing, not as consulting notes.',
    ],
  },
  {
    eyebrow: 'Appeals',
    title: 'Every flag arrives with its own evidence',
    body: [
      'An incident is not a line in a log saying “suspicious activity”. It carries the timestamped snapshot captured at the moment of the flag, and the reading that was taken when the decision was made.',
      'So an appeal becomes a review of one specific frame rather than an argument about whose account to believe — and where the system suppressed a flag on the student’s behalf, that is recorded too.',
    ],
  },
  {
    eyebrow: 'Rollout',
    title: 'Nothing for your IT department to deploy',
    body: [
      'No lockdown browser, no desktop agent, no administrator rights on a student’s personal laptop, and no exam-day queue at the help desk because someone could not install something.',
      'It runs in Chrome as an extension — and the demo on this page runs with no installation at all.',
    ],
  },
];

export default function WhyInstructors() {
  return (
    <section id="why" className="relative overflow-hidden px-4 py-20 sm:px-6">
      {/* Chrome only (THEME.md §3) — one soft orb so the section does not read
          flat between two darker bands. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
        <div className="orb animate-pulse-slow top-[10%] left-1/2 h-[520px] w-[520px] -translate-x-1/2 bg-blue-700/25" />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl">
        <header className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold tracking-widest text-cyan-400 uppercase">
            Why instructors choose Procminds
          </p>
          <h2 className="font-heading mt-3 text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">
            The three questions you were going to ask anyway
          </h2>
        </header>

        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          {REASONS.map((reason) => (
            <article
              key={reason.title}
              className="glass rounded-card flex flex-col p-6 transition-all duration-300 hover:border-cyan-500/40 hover:shadow-[0_10px_40px_-10px_rgba(0,210,255,0.25)]"
            >
              <p className="text-[11px] font-medium tracking-widest text-cyan-400 uppercase">
                {reason.eyebrow}
              </p>
              <h3 className="font-heading mt-2 text-lg font-semibold text-slate-100">
                {reason.title}
              </h3>
              <div className="mt-3 space-y-3 text-sm leading-relaxed text-slate-400">
                {reason.body.map((paragraph) => (
                  <p key={paragraph.slice(0, 32)}>{paragraph}</p>
                ))}
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
