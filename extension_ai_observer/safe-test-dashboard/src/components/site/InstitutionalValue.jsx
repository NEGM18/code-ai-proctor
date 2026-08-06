// =============================================================================
// InstitutionalValue — SECTION 3: the case for adopting this across a faculty
// rather than in one lecturer's module.
//
// ⚠ THERE IS DELIBERATELY NO SOCIAL PROOF ON THIS PAGE, AND THAT IS NOT AN
// OVERSIGHT TO FIX BY INVENTING SOME. The brief asked for a "social proof"
// section. This product has no named customers, no pilot numbers and no
// testimonials yet, and a wall of plausible university logos would be a
// fabricated record — on a landing page whose central argument is that the
// system does not fabricate readings. `Marquee.jsx` already refuses the same
// temptation for the same reason.
//
// So the section sells institutional VALUE, which is checkable, instead of
// institutional ADOPTION, which is not. When there are real reference
// customers, quotes or pilot figures, they belong here — supplied by the
// business, never generated.
//
// ⚠ FERPA / GDPR WORDING IS LOAD-BEARING. This says the architecture is built
// to SUPPORT those obligations; it does not claim certification, and it must
// not be edited into doing so. Compliance is a determination the institution's
// own counsel and DPO make about their deployment, not something a vendor
// asserts on a marketing page. What is genuinely true — and is the strongest
// version of the claim — is architectural: there is no video to disclose,
// because no video is ever transmitted.
// =============================================================================

const PILLARS = [
  {
    title: 'Built for your FERPA and GDPR obligations',
    body: 'The hardest data-protection question about proctoring is usually “where does the recording go, how long is it kept, and who can watch it?”. Here that question largely dissolves: there is no recording to account for, because the video never leaves the candidate’s device.',
    foot: 'We supply the architecture and the documentation; your DPO makes the determination.',
  },
  {
    title: 'Data minimisation by construction',
    body: 'The only thing that ever reaches your servers is a still snapshot attached to a violation that was actually reported. Not a stream, not a continuous upload, and not an archive of every candidate who sat quietly and did nothing wrong.',
    foot: 'Retention and deletion policy controls are available at the institution tier.',
  },
  {
    title: 'Defensible when a decision is challenged',
    body: 'Every flag carries the frame it was raised on, and every safeguard that suppressed a flag is recorded as well. A misconduct panel reviews evidence rather than adjudicating between a student’s account and a score nobody can explain.',
    foot: 'Audit log of every suppression at the institution tier.',
  },
  {
    title: 'Flat pricing, never per incident',
    body: 'A proctoring vendor paid by the flag has a commercial interest in finding more of them. Plans here are flat and priced per role, so nobody’s revenue improves when your students are accused more often.',
    foot: 'Pooled allocation across your organisation, with shared cohorts and role management.',
  },
];

export default function InstitutionalValue() {
  return (
    <section
      id="institutions"
      aria-labelledby="institutions-heading"
      className="relative overflow-hidden border-y border-cyan-500/10 px-4 py-20 sm:px-6"
    >
      {/* Chrome only (THEME.md §3). */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
        <div className="cyber-grid absolute inset-0 opacity-40" />
        <div className="orb animate-pulse-slow top-[-10%] right-[5%] h-[460px] w-[460px] bg-cyan-500/25" />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl">
        <header className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold tracking-widest text-cyan-400 uppercase">
            For institutions
          </p>
          <h2
            id="institutions-heading"
            className="font-heading mt-3 text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl"
          >
            Deployable across a faculty, defensible at a misconduct panel
          </h2>
          <p className="mt-4 text-slate-400">
            The questions that stop a proctoring rollout are rarely about
            detection accuracy. They are about privacy law, appeals, and who
            carries the risk.
          </p>
        </header>

        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {PILLARS.map((pillar) => (
            <article
              key={pillar.title}
              className="glass rounded-card p-6 transition-all duration-300 hover:border-cyan-500/40 hover:shadow-[0_10px_40px_-10px_rgba(0,210,255,0.25)]"
            >
              <h3 className="font-heading text-lg font-semibold text-slate-100">{pillar.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-slate-400">{pillar.body}</p>
              <p className="mt-4 border-t border-slate-800/70 pt-3 text-xs leading-relaxed text-slate-500">
                {pillar.foot}
              </p>
            </article>
          ))}
        </div>

        <div className="mt-10 text-center">
          <a
            href="#contact"
            className="inline-flex rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-7 py-3.5 text-base font-semibold text-[var(--color-base)] shadow-[0_0_25px_rgba(6,182,212,0.4)] transition-all duration-300 hover:brightness-110 hover:shadow-[0_0_35px_rgba(6,182,212,0.6)]"
          >
            Talk to Sales about an institutional rollout
          </a>
        </div>
      </div>
    </section>
  );
}
