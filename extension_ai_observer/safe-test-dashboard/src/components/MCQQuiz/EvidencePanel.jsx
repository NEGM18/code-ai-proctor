// =============================================================================
// EvidencePanel — what the CANDIDATE sees about proctoring while sitting.
//
// ⚠ THIS PANEL DELIBERATELY SHOWS NOTHING ABOUT WHAT WAS DETECTED (2026-08-16).
//
// It used to be a live evidence stream: one card per incident, the webcam frame
// that produced it, a severity chip, the violation type in plain English, and a
// click to open the still full size. All of that is gone, and none of it is
// coming back into the exam UI.
//
// Two independent reasons, either of which alone is sufficient:
//
//   1. IT WAS AN EVASION TRAINER. A candidate who can see a card appear the
//      instant they glance sideways — and not appear when they glance slightly
//      less far — has a labelled feedback loop against the detector, running at
//      the detector's own frame rate. Nothing else in this codebase leaks that,
//      and it is why the extension's status bar was reduced to "Observing" in
//      the same commit.
//   2. THERE IS NO LONGER AN IMAGE TO SHOW. The frame never lands anywhere the
//      browser can read it: the extension's upload path is removed, the bucket's
//      client policies are dropped, and the only stored copy is an AES-GCM
//      envelope sealed to an offline key. Rendering a card with a permanently
//      broken image would be worse than rendering none.
//
// What the candidate is owed is honesty about whether they are being watched —
// not a running commentary on how they are doing. That is what this renders, and
// it is the same in every state: a session that has flagged nothing and a
// session that has flagged three times look identical here, on purpose.
//
// The verdicts surface AFTER the sitting, on the student dashboard, where they
// come with the model's reasoning and cannot be used to steer behaviour in the
// exam that produced them.
// =============================================================================

/**
 * @param {{ monitoring?: boolean, reviewUnavailable?: string | null }} props
 *   `violations` is intentionally NOT a prop any more. It was, and a future
 *   caller passing it should get an ignored-value smell rather than a component
 *   that quietly starts rendering incidents again.
 */
export default function EvidencePanel({ monitoring = true, reviewUnavailable = null }) {
  return (
    <section aria-label="Proctoring status" className="flex h-full min-h-0 flex-col">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium tracking-wide text-slate-400 uppercase">
          Proctoring
        </h3>
        <span className="font-mono text-[11px] text-slate-500">
          {monitoring ? 'active' : 'idle'}
        </span>
      </header>

      <div className="grid min-h-0 flex-1 place-items-center rounded-card border border-dashed border-slate-700 p-6">
        <div className="text-center">
          <span
            aria-hidden="true"
            className="mx-auto block h-2.5 w-2.5 rounded-full bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.7)]"
          />
          <p className="mt-4 text-sm font-medium text-slate-200">
            {monitoring ? 'Observing this session' : 'Not monitoring'}
          </p>
          <p className="mt-2 max-w-xs text-xs leading-relaxed text-slate-500">
            Analysis runs on your device and is reviewed after the exam. Nothing
            about what was or was not detected is shown to you while you are
            sitting — check your student dashboard once you have submitted.
          </p>
          <p className="mt-3 max-w-xs text-[11px] leading-relaxed text-slate-600">
            Any frame kept as evidence is encrypted before it is stored, with a
            key this website does not hold.
          </p>

          {/* ⚠ THE ONE THING STILL WORTH SAYING OUT LOUD.
              "The review pipeline is not configured" and "you were not flagged"
              are opposite facts that would otherwise render identically as a
              calm panel — the same silent-failure trap the vision OFFLINE
              banner exists to close. This names a broken deployment, never a
              detection. */}
          {reviewUnavailable ? (
            <p
              role="status"
              className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200"
            >
              Post-flag AI review is unavailable in this deployment
              ({reviewUnavailable}). Detection is unaffected.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
