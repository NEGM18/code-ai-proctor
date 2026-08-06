// =============================================================================
// Pricing — monthly/yearly toggle across the three roles the auth layer knows.
//
// ⚠ THE TIERS ARE THE THREE VALUES IN `roles.js`, NOT A SEPARATE LIST. Sign-up
// writes `role` into `raw_user_meta_data`, `handle_new_user()` copies it into
// `profiles`, and the column is a SQL enum — so a pricing tier that does not
// correspond to a role is a card whose button cannot complete. Keying the cards
// on ROLE keeps that impossible. Copy and colours are safe to edit; the `role`
// keys are not.
//
// ⚠ THE PRICES THEMSELVES ARE PLACEHOLDERS. They are the one thing on this page
// not derived from something checkable, and the footnote says so rather than
// presenting them as settled.
//
// Colours follow THEME.md §3: the accent here is brand cyan, never
// --color-verified. "Most chosen" is a marketing badge, not a verdict about a
// student, so it must not borrow the token that means "eyes open, centred".
// =============================================================================

import { useState } from 'react';

import { ROLE, ROLE_LABELS } from '../../lib/auth/roles.js';

const TIERS = [
  {
    role: ROLE.STUDENT,
    tagline: 'For candidates sitting invigilated exams.',
    monthly: 0,
    yearly: 0,
    was: null,
    allocation: 'Unlimited sittings',
    features: [
      'Full on-device analysis',
      'See every reading taken about you',
      'Local-only evidence by default',
      'Works without an account',
    ],
    cta: 'Start free',
    featured: false,
  },
  {
    role: ROLE.TEACHER,
    tagline: 'For instructors running their own assessments.',
    monthly: 19,
    yearly: 15,
    was: 29,
    allocation: 'Up to 200 sittings / month',
    features: [
      'Everything in Student',
      'Incident review with evidence frames',
      'Per-candidate calibration history',
      'Export incidents as CSV',
    ],
    cta: 'Start 14-day trial',
    featured: true,
  },
  {
    role: ROLE.ORGANIZATION,
    tagline: 'For institutions with multiple invigilators.',
    monthly: 79,
    yearly: 63,
    was: 99,
    allocation: 'Pooled sittings across your org',
    features: [
      'Everything in Teacher',
      'Shared cohorts and role management',
      'Retention and deletion policy controls',
      'Audit log of every suppression',
    ],
    cta: 'Talk to Sales',
    featured: false,
  },
];

function Check() {
  return (
    <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0 text-cyan-400" aria-hidden="true">
      <path fill="currentColor" d="M6.2 11.4 3.3 8.5l1.1-1.1 1.8 1.8 5-5 1.1 1.1z" />
    </svg>
  );
}

/**
 * @param {{onChoose: (role: string) => void}} props
 */
export default function Pricing({ onChoose }) {
  const [yearly, setYearly] = useState(true);

  return (
    <section id="pricing" className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
      <header className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold tracking-widest text-cyan-400 uppercase">Pricing</p>
        <h2 className="font-heading mt-3 text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">
          Priced per role, not per accusation
        </h2>
        <p className="mt-4 text-slate-400">
          A proctoring vendor paid by the incident has a commercial interest in
          finding them. These plans are flat, so a quiet exam costs exactly what
          a difficult one does.
        </p>

        <div
          role="group"
          aria-label="Billing period"
          className="mt-8 inline-flex rounded-lg border border-cyan-500/15 bg-surface/60 p-1"
        >
          {[
            { key: false, label: 'Monthly' },
            { key: true, label: 'Yearly' },
          ].map((option) => (
            <button
              key={String(option.key)}
              type="button"
              aria-pressed={yearly === option.key}
              onClick={() => setYearly(option.key)}
              className={`rounded-md px-4 py-1.5 text-sm transition-all duration-300 ${
                yearly === option.key
                  ? 'bg-slate-100 font-semibold text-[var(--color-base)]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {option.label}
              {option.key ? <span className="ml-1.5 text-xs text-cyan-400">−20%</span> : null}
            </button>
          ))}
        </div>
      </header>

      <div className="mt-12 grid gap-4 lg:grid-cols-3">
        {TIERS.map((tier) => {
          const price = yearly ? tier.yearly : tier.monthly;
          return (
            <article
              key={tier.role}
              className={`rounded-card flex flex-col p-6 transition-all duration-300 ${
                tier.featured
                  ? 'border border-cyan-500/40 bg-surface-raised/80 shadow-[0_0_30px_-10px_rgba(6,182,212,0.4)] ring-1 ring-cyan-500/20'
                  : 'glass hover:border-cyan-500/40 hover:shadow-[0_10px_40px_-10px_rgba(0,210,255,0.25)]'
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-heading text-base font-semibold text-slate-100">
                  {ROLE_LABELS[tier.role]}
                </h3>
                {tier.featured ? (
                  <span className="rounded-full bg-cyan-500/15 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-cyan-300 uppercase">
                    Most chosen
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">{tier.tagline}</p>

              <p className="mt-5 flex items-baseline gap-2">
                {tier.was ? (
                  <span className="tnum font-mono text-sm text-slate-600 line-through">
                    ${tier.was}
                  </span>
                ) : null}
                <span className="tnum font-mono text-4xl text-slate-50">
                  {price === 0 ? 'Free' : `$${price}`}
                </span>
                {price === 0 ? null : <span className="text-xs text-slate-500">/ month</span>}
              </p>
              <p className="mt-1 text-xs text-slate-500">{tier.allocation}</p>

              <ul className="mt-5 flex-1 space-y-2">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex gap-2 text-sm text-slate-400">
                    <Check />
                    {feature}
                  </li>
                ))}
              </ul>

              <button
                type="button"
                onClick={() => onChoose(tier.role)}
                className={`mt-6 w-full rounded-md px-4 py-2.5 text-sm font-semibold transition-all duration-300 ${
                  tier.featured
                    ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-[var(--color-base)] shadow-[0_0_20px_rgba(6,182,212,0.35)] hover:brightness-110 hover:shadow-[0_0_30px_rgba(6,182,212,0.55)]'
                    : 'border border-cyan-500/20 text-slate-200 hover:border-cyan-400/50 hover:shadow-[0_0_20px_rgba(6,182,212,0.15)]'
                }`}
              >
                {tier.cta}
              </button>
            </article>
          );
        })}
      </div>

      <p className="mt-8 text-center text-[11px] text-slate-600">
        Indicative pricing while the billing integration is being finalised.
      </p>
    </section>
  );
}
