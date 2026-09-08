// =============================================================================
// ProcScorePanel — Student Reputation & Trust Score Overview
//
// Modern, student-centric integrity dashboard component featuring an SVG circular
// progress gauge, trust band indicator, score pillars, and clear explanations.
// =============================================================================

import { TRUST_BAND_COPY, explainProcScore } from '../../lib/dashboard/procScore.js';
import { SEVERITY_TOKEN, verdict } from './verdict.js';

const SEVERITY_LABEL = {
  CRITICAL: 'Critical Flag',
  HIGH: 'High Alert',
  MEDIUM: 'Medium Notice',
  LOW: 'Minor Note',
};

export default function ProcScorePanel({ score, hours }) {
  const band = TRUST_BAND_COPY[score.band];
  const tone = verdict(band.token);
  const measured = score.score !== null;
  const explanation = explainProcScore(score);
  const displayScore = measured ? Math.round(score.score) : 0;

  // SVG Gauge constants
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = measured ? circumference - (displayScore / 100) * circumference : circumference;

  return (
    <div className="space-y-6">
      {/* Primary Reputation Card */}
      <section aria-labelledby="reputation-heading" className="glass overflow-hidden rounded-2xl border border-cyan-500/20 bg-surface/80 p-6 sm:p-8 backdrop-blur-xl">
        <div className="grid gap-8 lg:grid-cols-12 lg:items-center">
          
          {/* Gauge & Score Ring */}
          <div className="flex flex-col items-center justify-center text-center lg:col-span-5 border-b border-slate-800/80 pb-6 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-8">
            <h2 id="reputation-heading" className="text-xs font-semibold uppercase tracking-widest text-cyan-400">
              Student Integrity Reputation
            </h2>

            <div className="relative mt-6 grid place-items-center">
              <svg className="h-44 w-44 -rotate-90 transform" viewBox="0 0 160 160">
                {/* Background Ring */}
                <circle
                  cx="80"
                  cy="80"
                  r={radius}
                  className="stroke-slate-800"
                  strokeWidth="12"
                  fill="transparent"
                />
                {/* Score Fill Ring */}
                {measured ? (
                  <circle
                    cx="80"
                    cy="80"
                    r={radius}
                    className="stroke-cyan-400 transition-all duration-1000 ease-out"
                    strokeWidth="12"
                    strokeDasharray={circumference}
                    strokeDashoffset={strokeDashoffset}
                    strokeLinecap="round"
                    fill="transparent"
                    style={{
                      filter: 'drop-shadow(0 0 10px rgba(6, 182, 212, 0.5))',
                    }}
                  />
                ) : (
                  <circle
                    cx="80"
                    cy="80"
                    r={radius}
                    className="stroke-slate-700 stroke-dash-array-2"
                    strokeWidth="12"
                    fill="transparent"
                  />
                )}
              </svg>

              <div className="absolute flex flex-col items-center justify-center">
                <span className="font-heading text-5xl font-extrabold text-slate-50">
                  {measured ? displayScore : '—'}
                </span>
                <span className="text-xs font-medium text-slate-400">out of 100</span>
              </div>
            </div>

            <div className={`mt-5 inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-xs font-semibold shadow-sm ${tone.border} ${tone.bg} ${tone.text}`}>
              <span className={`h-2 w-2 rounded-full ${tone.fill} animate-pulse`} />
              {band.label}
              <span className="text-slate-500">•</span>
              <span className="font-normal text-slate-300">{band.detail}</span>
            </div>
          </div>

          {/* Explanation & Pillar Summary */}
          <div className="space-y-6 lg:col-span-7">
            <div>
              <h3 className="font-heading text-lg font-semibold text-slate-100">
                Reputation Overview
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">
                {explanation ?? (
                  <>
                    Welcome to your integrity hub! Your reputation score measures consistent focus, clean exam sittings, and active classroom participation. Complete proctored exams to establish your verified record.
                  </>
                )}
              </p>
              {score.provisional ? (
                <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-200">
                  ⚡ <strong>Provisional Record:</strong> Your score will become fully established as you complete more proctored sittings.
                </div>
              ) : null}
            </div>

            {/* Quick Metrics Grid */}
            <div className="grid gap-4 sm:grid-cols-3 pt-2 border-t border-slate-800/80">
              <div className="rounded-xl border border-slate-800 bg-surface/50 p-3.5">
                <p className="text-xs text-slate-400">Clean Sittings</p>
                <p className="mt-1 font-heading text-xl font-bold text-slate-100">
                  {measured ? `${score.cleanSessions} / ${score.sessionCount}` : '—'}
                </p>
                <p className="mt-0.5 text-[11px] text-emerald-400">Zero flags recorded</p>
              </div>

              <div className="rounded-xl border border-slate-800 bg-surface/50 p-3.5">
                <p className="text-xs text-slate-400">Proctored Hours</p>
                <p className="mt-1 font-heading text-xl font-bold text-slate-100">
                  {hours.hours !== null ? `${hours.hours.toFixed(1)} hrs` : '—'}
                </p>
                <p className="mt-0.5 text-[11px] text-cyan-400">Verified session time</p>
              </div>

              <div className="rounded-xl border border-slate-800 bg-surface/50 p-3.5">
                <p className="text-xs text-slate-400">Active Flags</p>
                <p className="mt-1 font-heading text-xl font-bold text-slate-100">
                  {measured ? score.violationCount : '—'}
                </p>
                <p className={`mt-0.5 text-[11px] ${score.violationCount === 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {score.violationCount === 0 ? 'Clean record' : 'Review details'}
                </p>
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* Deduction Ledger (If Any Deductions Exist) */}
      {measured && score.deductions.length > 0 ? (
        <section className="glass rounded-2xl border border-slate-800 bg-surface/60 p-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Score Adjustments & Breakdown
          </h3>
          <div className="mt-4 space-y-3">
            {score.deductions.map((segment) => (
              <div key={segment.severity} className="flex items-center justify-between rounded-lg border border-slate-800/80 bg-surface-raised/40 px-4 py-2.5 text-xs">
                <div className="flex items-center gap-3">
                  <span className={`h-2.5 w-2.5 rounded-full ${verdict(SEVERITY_TOKEN[segment.severity]).fill}`} />
                  <span className="font-medium text-slate-200">{SEVERITY_LABEL[segment.severity]}</span>
                  <span className="text-slate-500">• {segment.count} event(s)</span>
                </div>
                <span className="font-mono font-semibold text-rose-400">−{segment.points.toFixed(1)} pts</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
