// =============================================================================
// DemoDiagnostics — the gate's own telemetry, shown rather than summarised.
//
// ⚠ `failedOpen` IS THE NUMBER THAT MATTERS, and PLAN.md §7 gives it a row of
// its own for a reason. The EAR veto fails OPEN by design: with no fresh eye
// measurement the report proceeds unchanged, because a suppression exploit is a
// worse failure than the false positive the gate prevents. The cost of that
// choice is that a completely dead safeguard and a perfectly healthy one look
// identical from the outside — both produce zero suppressions.
//
// A rising `failedOpen` against zero `samples` is what distinguishes them, so it
// is surfaced with an explicit "not active" warning rather than left in a
// console nobody opens.
// =============================================================================

import { SNAPSHOT_UPLOAD_REASON } from '../../lib/demoSnapshots.js';
import Unreadable from './Unreadable.jsx';

const UPLOAD_COPY = {
  [SNAPSHOT_UPLOAD_REASON.SUPABASE_UNCONFIGURED]:
    'Supabase not configured — evidence stays in this tab and is never uploaded.',
  [SNAPSHOT_UPLOAD_REASON.NOT_SIGNED_IN]:
    'Not signed in — evidence stays in this tab and is never uploaded.',
  [SNAPSHOT_UPLOAD_REASON.UNVERIFIED_SESSION]:
    'Sign-in not finished (email code outstanding) — evidence stays local.',
  // Kept in step with the retained constant in demoSnapshots.js: nothing emits
  // this any more, but a reason with no copy renders as a blank explanation.
  [SNAPSHOT_UPLOAD_REASON.ANONYMOUS_AUTH_FAILED]:
    'Anonymous session unavailable — evidence stays local.',
  [SNAPSHOT_UPLOAD_REASON.NO_IMAGE_DATA]:
    'No image data on that violation — nothing to upload.',
  [SNAPSHOT_UPLOAD_REASON.UPLOAD_FAILED]:
    'Upload failed — evidence stays in this tab.',
};

function Stat({ label, value, tone = 'text-slate-200' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className={`tnum font-mono text-xs ${tone}`}>{value}</dd>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object|null} props.veto  `telemetry()` from the live EarVetoGate.
 * @param {string|null} props.delegate 'GPU' | 'CPU' | null
 * @param {number|null} props.fps
 * @param {string|null} props.sessionId
 * @param {{uploaded: boolean, reason: string|null}|null} props.uploadNotice
 */
export default function DemoDiagnostics({ veto, delegate, fps, sessionId, uploadNotice }) {
  // "The safeguard is not doing anything" — asserted from the gate's own
  // counters, never inferred from an empty suppression list.
  const inert = !!veto && veto.samples === 0 && veto.failedOpen > 0;

  return (
    <section aria-label="Diagnostics" className="glass rounded-card p-4">
      <h3 className="mb-2 text-xs font-medium tracking-wide text-slate-400 uppercase">
        Safeguard diagnostics
      </h3>

      <dl className="divide-y divide-slate-800/70">
        <Stat
          label="Inference delegate"
          value={delegate ?? <Unreadable label="delegate" />}
          tone={delegate === 'CPU' ? 'text-glance' : 'text-slate-200'}
        />
        <Stat
          label="Frame rate"
          value={fps === null ? <Unreadable label="frame rate" /> : `${fps} fps`}
        />
        <Stat label="EAR samples" value={veto ? veto.samples : <Unreadable label="samples" />} />
        <Stat
          label="Suppressed"
          value={veto ? veto.vetoed : <Unreadable label="suppressed count" />}
          tone="text-suppressed"
        />
        <Stat
          label="Confirmed eyes-open"
          value={veto ? veto.confirmed : <Unreadable label="confirmed count" />}
          tone="text-verified"
        />
        <Stat
          label="Failed open"
          value={veto ? veto.failedOpen : <Unreadable label="failed-open count" />}
          tone={inert ? 'text-violation' : 'text-slate-400'}
        />
        <Stat
          label="One eye closed"
          value={veto ? veto.oneEyeClosedSamples : <Unreadable label="one-eye samples" />}
        />
      </dl>

      {inert ? (
        <p className="mt-3 rounded-md border border-violation/40 bg-violation-dim/30 p-2 text-[11px] leading-relaxed text-violation">
          <strong className="font-semibold">Safeguard not active.</strong> Every
          report is passing through unchecked because no eye measurement is
          reaching the gate. This is the fail-open path — it is the safe
          direction, but blink immunity is not being enforced right now.
        </p>
      ) : null}

      <footer className="mt-3 space-y-1 text-[10px] leading-relaxed text-slate-600">
        <p>
          Session <span className="tnum font-mono text-slate-500">{sessionId ?? '—'}</span>
        </p>
        {uploadNotice && !uploadNotice.uploaded ? (
          <p className="text-glance">
            {UPLOAD_COPY[uploadNotice.reason] ?? 'Evidence stays in this tab.'}
          </p>
        ) : null}
        <p>Everything above is measured in this tab. No frame is transmitted.</p>
      </footer>
    </section>
  );
}
