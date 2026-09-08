// =============================================================================
// FlagReview — "was I flagged, and why?", answered after the sitting.
//
// This is the ONLY place a candidate learns what the proctor concluded. The
// exam UI deliberately tells them nothing while they are sitting (see
// MCQQuiz/EvidencePanel.jsx and the extension's status bar), because a live
// readout is a labelled feedback loop for evading the detector. Here that
// objection is gone: the sitting is over, the frames are reviewed, and the
// person accused has a right to know what was said about them.
//
// ⚠ NO IMAGES, AND NOT AS A DESIGN PREFERENCE. The frame behind a confirmed
// flag is an AES-GCM envelope sealed to a key that exists nowhere in this
// deployment. There is no signed URL to mint and no plaintext to render. What
// the student gets is the model's verdict, its confidence, and the one sentence
// it wrote about what it saw — which is more than a thumbnail would have told
// them anyway.
//
// ⚠ THREE STATES, NOT TWO, AND THE THIRD IS THE IMPORTANT ONE.
// "Nothing was flagged", "something was flagged", and "we could not load your
// record" must never render alike. An unreadable query falling through to the
// clean-record copy would report an exoneration this component has no evidence
// for — the same rule evidence.js follows for "Verified clean".
// =============================================================================

/** Verdict token -> how it is presented. Unknown tokens fall to REVIEWED. */
const VERDICT_COPY = Object.freeze({
  CHEATING: {
    label: 'Flagged',
    chip: 'border-violation/40 bg-violation/10 text-violation',
    lead: 'A reviewer model agreed with the detector on this frame.',
  },
  NOT_CHEATING: {
    label: 'Cleared',
    chip: 'border-verified/40 bg-verified/10 text-verified',
    lead: 'The detector raised this, and a reviewer model found nothing in the frame to support it.',
  },
  INCONCLUSIVE: {
    label: 'Inconclusive',
    chip: 'border-slate-600/60 bg-slate-800/40 text-slate-300',
    lead: 'The frame could not be judged either way. This is not a finding against you.',
  },
  REVIEWED: {
    label: 'Recorded',
    chip: 'border-glance/40 bg-glance-dim/20 text-glance',
    lead: 'Recorded by the on-device detector.',
  },
})

const TYPE_COPY = Object.freeze({
  AI_CHEATING_POSE: 'Sustained look away',
  HEAD_POSE_GLANCE: 'Brief glance away',
  NO_FACE_DETECTED: 'Face not visible',
  MULTIPLE_FACES: 'A second person in frame',
  SIDE_GAZE_PEEKING: 'Eyes off screen',
  GAZE_OFF_SCREEN: 'Eyes off screen',
  PHONE_DETECTED: 'Phone in frame',
  SECONDARY_DEVICE: 'Second device in frame',
  LIVENESS_FAILED: 'Liveness check failed',
  CAMERA_FEED_SYNTHETIC: 'Camera feed looked synthetic',
  TAB_SWITCH: 'Left the exam window',
  WINDOW_BLUR: 'Left the exam window',
  VISIBILITY_HIDDEN: 'Left the exam window',
  FULLSCREEN_EXIT: 'Exited fullscreen',
})

function when(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * @param {object} props
 * @param {Array<Record<string, any>>} props.reviews Violation rows carrying
 *   `ai_verdict` — i.e. only the ones a model actually looked at.
 * @param {boolean} props.loadFailed True when the record could not be read.
 *   NEVER pass `false` for "the query returned nothing"; see the header.
 * @param {(violationId: string, source: string) => void} [props.onViewEvidence] Callback to view evidence.
 */
export default function FlagReview({ reviews = [], loadFailed = false, onViewEvidence }) {
  if (loadFailed) {
    return (
      <section className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-6">
        <h3 className="font-heading text-sm font-semibold text-rose-200">
          Your review record could not be loaded
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-rose-300/90">
          This is a fault on our side, not a finding about you, and it is not the
          same as “nothing was flagged”. Use Refresh Data above to try again.
        </p>
      </section>
    )
  }

  const flagged = reviews.filter((row) => row.ai_verdict === 'CHEATING')

  return (
    <section className="space-y-4">
      {/* ---- headline ---- */}
      <div
        className={`rounded-2xl border p-6 ${
          flagged.length > 0
            ? 'border-violation/40 bg-violation/10'
            : 'border-verified/30 bg-verified/5'
        }`}
      >
        <h3 className="font-heading text-lg font-semibold text-slate-50">
          {flagged.length > 0
            ? `${flagged.length} flagged ${flagged.length === 1 ? 'incident' : 'incidents'} detected`
            : 'Nothing was flagged'}
        </h3>
        <p className="mt-2 max-w-2xl text-xs leading-relaxed text-slate-400">
          {reviews.length === 0
            ? 'No frame from your sittings has been sent for review. Either nothing tripped the on-device detector, or your sittings predate this feature.'
            : `${reviews.length} ${reviews.length === 1 ? 'frame was' : 'frames were'} reviewed by Gemini AI Proctor. Cleared frames are never stored; flagged frames are securely encrypted as evidence.`}
        </p>
        <p className="mt-3 max-w-2xl text-[11px] leading-relaxed text-slate-500">
          🔒 Zero-Plaintext Protection: Frames kept as evidence are encrypted at rest with PMSEAL1 AES-256-GCM.
          They can only be decrypted and inspected on-demand by authorized students and classroom teachers.
        </p>
      </div>

      {/* ---- the reviewed frames ---- */}
      {reviews.length > 0 ? (
        <ul className="space-y-4">
          {reviews.map((row) => {
            const isFlagged = row.ai_verdict === 'CHEATING'
            const isCleared = row.ai_verdict === 'NOT_CHEATING'
            const copy = VERDICT_COPY[row.ai_verdict] ?? VERDICT_COPY.REVIEWED
            const confidence = Number(row.cheat_probability)
            const source = row.session_id ? 'EXAM' : 'DEMO'

            return (
              <li
                key={row.id}
                className={`rounded-xl border p-5 transition-all ${
                  isFlagged
                    ? 'border-violation/40 bg-surface/90 shadow-[0_4px_20px_rgba(239,68,68,0.06)]'
                    : 'border-slate-800 bg-surface/60'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${copy.chip}`}>
                    {copy.label}
                  </span>
                  <span className="text-sm font-semibold text-slate-100">
                    {TYPE_COPY[row.violation_type] ?? row.violation_type}
                  </span>
                  <span className="rounded bg-slate-800/80 px-2 py-0.5 font-mono text-[10px] text-slate-400">
                    {source === 'EXAM' ? 'Classroom Exam' : 'Live Demo'}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-slate-500">
                    {when(row.ai_reviewed_at ?? row.created_at)}
                  </span>
                </div>

                <p className="mt-2 text-xs leading-relaxed text-slate-400">
                  {isCleared
                    ? 'The automated detector raised a candidate frame, and the AI Proctor confirmed you are clear. No evidence was stored.'
                    : copy.lead}
                </p>

                {/* The model's own sentence, verbatim */}
                {row.cheat_reason ? (
                  <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400">
                      Gemini AI Observation
                    </p>
                    <p className="mt-1 text-xs italic leading-relaxed text-slate-200">
                      “{row.cheat_reason}”
                    </p>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-slate-800/80 pt-3 text-[11px] text-slate-500">
                  <div className="flex flex-wrap items-center gap-4">
                    <span>
                      Model confidence:{' '}
                      <span className={`font-mono font-semibold ${isFlagged ? 'text-violation' : 'text-slate-300'}`}>
                        {Number.isFinite(confidence) ? `${Math.round(confidence)}%` : '—'}
                      </span>
                    </span>
                    <span>
                      Evidence storage:{' '}
                      <span className="font-mono text-slate-300">
                        {row.snapshot_sealed ? '🔒 Encrypted (PMSEAL1)' : 'None (Dropped)'}
                      </span>
                    </span>
                  </div>

                  {isFlagged ? (
                    <button
                      type="button"
                      onClick={() => onViewEvidence?.(row.id, source)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-500/25 hover:border-cyan-400 focus-visible:outline-2 focus-visible:outline-cyan-400"
                    >
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      <span>See Snapshot Evidence</span>
                      <span>→</span>
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400">
                      ✓ Cleared (You are clear)
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}

