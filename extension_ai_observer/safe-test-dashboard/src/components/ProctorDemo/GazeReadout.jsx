// =============================================================================
// GazeReadout — the 2 Hz telemetry table.
//
// Every figure here comes from `useProctorDemo`'s `readout`, which is already
// throttled and pre-rounded. Nothing in this file re-derives a value, and
// nothing computes a fallback: a null arrives as null and leaves as an em-dash.
//
// ⚠ `head_off_neutral` IS NOT A GAZE VERDICT. When the head leaves its
// calibrated band the gaze channel deliberately stops answering, because an eye
// direction measured off a turned head is not a claim about where the student is
// looking. The row says so rather than showing the last direction it managed to
// compute — that stale arrow is the fabricated reading this codebase exists to
// prevent.
// =============================================================================

import Unreadable from './Unreadable.jsx';

/** Analyser status -> plain English + the verdict colour. */
const GAZE_STATUS_COPY = {
  calibrating: ['learning your neutral', 'text-slate-400'],
  ok: ['centre — nothing to report', 'text-verified'],
  glance: ['brief glance', 'text-glance'],
  alert: ['sustained side gaze', 'text-violation'],
  eyes_closed: ['eyes closed — no direction computed', 'text-unknown'],
  head_off_neutral: ['head turned — gaze not measured', 'text-unknown'],
  unreadable: ['unreadable frame', 'text-unknown'],
};

const HEAD_STATUS_COPY = {
  calibrating: ['learning your neutral', 'text-slate-400'],
  ok: ['inside neutral band', 'text-verified'],
  glance: ['brief look-away', 'text-glance'],
  alert: ['sustained look-away', 'text-violation'],
  face_lost: ['face not readable', 'text-unknown'],
  no_face: ['no face', 'text-violation'],
  multi_face: ['more than one person', 'text-violation'],
};

function Row({ label, children, hint }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-800/70 py-1.5 last:border-0">
      <dt className="text-xs text-slate-400">
        {label}
        {hint ? <span className="block text-[10px] text-slate-600">{hint}</span> : null}
      </dt>
      <dd className="tnum text-right font-mono text-sm">{children}</dd>
    </div>
  );
}

/** A number that may be null. NEVER falls back to 0. */
function Num({ value, digits, label }) {
  return value === null || !Number.isFinite(value)
    ? <Unreadable label={label} />
    : <span className="text-slate-200">{value.toFixed(digits)}</span>;
}

/**
 * @param {{readout: object, paused?: boolean}} props
 */
export default function GazeReadout({ readout, paused = false }) {
  const [gazeCopy, gazeTone] = GAZE_STATUS_COPY[readout.gazeStatus] ?? [null, 'text-unknown'];
  const [headCopy, headTone] = HEAD_STATUS_COPY[readout.headStatus] ?? [null, 'text-unknown'];

  // Paused blanks everything in one place, so no row below has to remember.
  const blanked = paused || readout.paused;

  return (
    <section aria-label="Live telemetry" className="glass rounded-card p-4">
      <header className="mb-2 flex items-baseline justify-between">
        <h3 className="text-xs font-medium tracking-wide text-slate-400 uppercase">Telemetry</h3>
        <span className="tnum font-mono text-[11px] text-slate-500">
          {blanked ? 'paused' : '2 Hz'}
        </span>
      </header>

      <dl>
        <Row label="Gaze">
          {blanked || !gazeCopy
            ? <Unreadable label="gaze" />
            : <span className={gazeTone}>{gazeCopy}</span>}
        </Row>

        <Row label="Iris H" hint="0 = image-left, 1 = image-right">
          {blanked ? <Unreadable label="horizontal iris ratio" />
            : <Num value={readout.hRatio} digits={3} label="horizontal iris ratio" />}
        </Row>

        <Row label="Iris V" hint="larger = looking down">
          {blanked ? <Unreadable label="vertical iris ratio" />
            : <Num value={readout.vRatio} digits={3} label="vertical iris ratio" />}
        </Row>

        <Row label="Head">
          {blanked || !headCopy
            ? <Unreadable label="head pose" />
            : <span className={headTone}>{headCopy}</span>}
        </Row>

        <Row label="Excursion" hint="deviation from your own neutral">
          {blanked ? <Unreadable label="head excursion" />
            : <Num value={readout.headExcursion} digits={2} label="head excursion" />}
        </Row>

        <Row label="Faces">
          {blanked
            ? <Unreadable label="face count" />
            : <span className="text-slate-200">{readout.faceCount}</span>}
        </Row>

        <Row label="Calibration">
          {readout.calibrated
            ? <span className="text-verified">complete</span>
            : blanked
              ? <Unreadable label="calibration" />
              : <span className="text-slate-400">
                  {Math.round((readout.calibrationProgress ?? 0) * 100)}%
                </span>}
        </Row>

        <Row label="Frame rate">
          {readout.fps === null
            ? <Unreadable label="frame rate" />
            : <span className="text-slate-200">{readout.fps} fps</span>}
        </Row>
      </dl>
    </section>
  );
}
