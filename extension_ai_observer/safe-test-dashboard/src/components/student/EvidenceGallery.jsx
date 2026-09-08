// =============================================================================
// EvidenceGallery — the snapshots stored against this account, filterable by
// where they came from.
//
// ⚠ ZERO PLAINTEXT AT REST: Snapshots are stored as encrypted PMSEAL1 envelopes
// in Supabase Storage. This component unseals them in-flight on-demand for the
// verified student or teacher, rendering the full visual photograph with Gemini's
// AI observation and cheating probability.
// =============================================================================

import { useEffect, useMemo, useState } from 'react';

import { EVIDENCE_CLASS_COPY, EVIDENCE_SOURCE } from '../../lib/dashboard/evidence.js';
import { DATA_REASON, unsealEvidenceSnapshot } from '../../lib/dashboard/studentData.js';
import { verdict } from './verdict.js';

const TABS = [
  { key: 'ALL', label: 'All captures' },
  { key: EVIDENCE_SOURCE.DEMO, label: 'Live demo' },
  { key: EVIDENCE_SOURCE.EXAM, label: 'Classroom exams' },
];

/**
 * @param {object} props
 * @param {{ ok: boolean, reason: string | null, cards: Array<Record<string, any>> }} props.result
 * @param {string} [props.selectedTab] Optional tab to default to (e.g. from FlagReview navigation)
 * @param {string} [props.highlightId] Optional violationId to highlight
 */
export default function EvidenceGallery({ result, selectedTab = 'ALL', highlightId = null }) {
  const [tab, setTab] = useState(selectedTab);
  const [previewModalCard, setPreviewModalCard] = useState(null);

  useEffect(() => {
    if (selectedTab && selectedTab !== tab) {
      setTab(selectedTab);
    }
  }, [selectedTab]);

  const counts = useMemo(() => {
    const byTab = { ALL: result.cards.length, [EVIDENCE_SOURCE.DEMO]: 0, [EVIDENCE_SOURCE.EXAM]: 0 };
    for (const card of result.cards) {
      if (byTab[card.source] !== undefined) byTab[card.source] += 1;
    }
    return byTab;
  }, [result.cards]);

  const visible = useMemo(
    () => (tab === 'ALL' ? result.cards : result.cards.filter((card) => card.source === tab)),
    [result.cards, tab],
  );

  return (
    <section aria-labelledby="evidence-heading" className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2
            id="evidence-heading"
            className="font-heading text-xl font-semibold tracking-tight text-slate-100"
          >
            Evidence & Sitting Logs
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Encrypted snapshots captured during your sittings, decrypted in real-time with Gemini AI analysis.
          </p>
        </div>

        {result.cards.length > 0 ? (
          <div
            role="tablist"
            aria-label="Filter captures"
            className="flex gap-1 rounded-xl border border-slate-800 bg-surface/80 p-1"
          >
            {TABS.map((entry) => (
              <button
                key={entry.key}
                role="tab"
                type="button"
                aria-selected={tab === entry.key}
                onClick={() => setTab(entry.key)}
                className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all focus-visible:outline-2 focus-visible:outline-cyan-400 ${
                  tab === entry.key
                    ? 'bg-cyan-500/20 text-cyan-300 shadow-[0_0_10px_rgba(6,182,212,0.15)]'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {entry.label}
                <span className="tnum ml-1.5 font-mono text-[10px] text-slate-500">
                  {counts[entry.key]}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </header>

      <div className="mt-6">
        {!result.ok ? (
          <Empty>
            {result.reason === DATA_REASON.SUPABASE_UNCONFIGURED
              ? 'Storage is not connected in this deployment, so no captures can be listed.'
              : 'We could not list your captures. Reload the page to try again.'}
          </Empty>
        ) : result.cards.length === 0 ? (
          <Empty>
            No captures stored. A snapshot is taken and retained only when cheating is verified by the AI Proctor,
            so an empty gallery is the expected result of a clean session record.
          </Empty>
        ) : visible.length === 0 ? (
          <Empty>No captures found under this filter tab.</Empty>
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((card) => (
              <EvidenceCard
                key={card.id || card.path || card.violationId}
                card={card}
                isHighlighted={highlightId === (card.id || card.violationId)}
                onOpenModal={() => setPreviewModalCard(card)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Snapshot Preview Modal */}
      {previewModalCard ? (
        <EvidenceDetailModal card={previewModalCard} onClose={() => setPreviewModalCard(null)} />
      ) : null}
    </section>
  );
}

function Empty({ children }) {
  return (
    <div className="glass rounded-2xl border border-slate-800 bg-surface/40 px-6 py-8 text-center text-xs leading-relaxed text-slate-400">
      {children}
    </div>
  );
}

function EvidenceCard({ card, isHighlighted, onOpenModal }) {
  const badge = EVIDENCE_CLASS_COPY[card.evidenceClass] ?? { label: card.violationType || 'Flagged frame', token: 'violation' };
  const tone = verdict(badge.token);

  const [imageUrl, setImageUrl] = useState(card.url || card.dataUrl || null);
  const [loading, setLoading] = useState(!card.url && !card.dataUrl && (!!card.violationId || !!card.path));
  const [error, setError] = useState(null);

  useEffect(() => {
    if (imageUrl) return;

    let active = true;
    (async () => {
      if (!card.violationId && !card.path) return;
      setLoading(true);
      setError(null);

      const res = await unsealEvidenceSnapshot(card.violationId, card.path);
      if (!active) return;

      if (res.ok && res.dataUrl) {
        setImageUrl(res.dataUrl);
      } else {
        setError(res.reason || res.error || 'Decryption unavailable');
      }
      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [card.violationId, card.path, imageUrl]);

  return (
    <li
      className={`glass group overflow-hidden rounded-2xl border transition-all duration-300 ${
        isHighlighted
          ? 'border-cyan-400 ring-2 ring-cyan-400/30 shadow-[0_0_25px_rgba(6,182,212,0.2)]'
          : 'border-slate-800 hover:border-slate-700'
      }`}
    >
      {/* Frame Preview Area */}
      <div
        className="relative aspect-[4/3] cursor-pointer overflow-hidden bg-slate-950"
        onClick={() => imageUrl && onOpenModal?.()}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt="Evidence snapshot"
            loading="lazy"
            decoding="async"
            className="ph-no-capture ph-ignore-input h-full w-full object-cover transition duration-300 group-hover:scale-105"
          />
        ) : loading ? (
          <div className="grid h-full w-full place-items-center p-4 text-center">
            <div className="flex flex-col items-center gap-2">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
              <span className="font-mono text-[10px] text-cyan-400">Decrypting sealed frame…</span>
            </div>
          </div>
        ) : (
          <div className="grid h-full w-full place-items-center p-4 text-center">
            <div className="flex flex-col items-center gap-1.5 max-w-[200px]">
              <span className="text-xl">🔒</span>
              <p className="rounded bg-slate-900/90 px-2.5 py-1 text-[10px] text-slate-300 border border-slate-800">
                {error === 'KEY_MISMATCH_HISTORICAL' || error === 'QUERY_FAILED'
                  ? 'Historical encrypted frame'
                  : (error || 'Encrypted frame')}
              </p>
              <p className="text-[9px] text-slate-500">
                Protected by zero-knowledge storage
              </p>
            </div>
          </div>
        )}

        {/* Violation Badge */}
        <span
          className={`absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold backdrop-blur-md ${tone.border} ${tone.bg} ${tone.text}`}
        >
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tone.fill}`} />
          {badge.label}
        </span>

        {/* Sitting context pill */}
        <span className="absolute top-3 right-3 rounded-full border border-slate-700/80 bg-slate-900/80 px-2 py-0.5 font-mono text-[10px] text-slate-300 backdrop-blur-md">
          {card.label}
        </span>
      </div>

      {/* Frame Details & Gemini Reply */}
      <div className="p-4 space-y-3 bg-surface/70">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-200">
            {card.violationType || 'Evidence snapshot'}
          </span>
          <span className="tnum font-mono text-[10px] text-slate-500">
            {formatCapturedAt(card.capturedAt)}
          </span>
        </div>

        {/* Gemini AI Observation Text */}
        {card.cheatReason ? (
          <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-2.5">
            <p className="text-[9px] font-bold uppercase tracking-wider text-cyan-400">
              Gemini AI Finding
            </p>
            <p className="mt-0.5 text-[11px] italic leading-relaxed text-slate-300">
              “{card.cheatReason}”
            </p>
          </div>
        ) : null}

        {/* Footer Metrics */}
        <div className="flex items-center justify-between border-t border-slate-800/80 pt-2 text-[11px] text-slate-400">
          <span>
            AI Confidence:{' '}
            <strong className="font-mono text-slate-200">
              {Number.isFinite(card.cheatProbability) ? `${Math.round(card.cheatProbability)}%` : '—'}
            </strong>
          </span>
          {imageUrl ? (
            <button
              type="button"
              onClick={() => onOpenModal?.({ ...card, dataUrl: imageUrl })}
              className="text-[10px] font-semibold text-cyan-400 hover:text-cyan-300"
            >
              Zoom Frame ↗
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function EvidenceDetailModal({ card, onClose }) {
  const badge = EVIDENCE_CLASS_COPY[card.evidenceClass] ?? { label: card.violationType || 'Flagged frame', token: 'violation' };
  const [modalImg, setModalImg] = useState(card.dataUrl || card.url || null);
  const [loading, setLoading] = useState(!card.dataUrl && !card.url && (!!card.violationId || !!card.path));
  const [error, setError] = useState(null);

  useEffect(() => {
    if (modalImg) return;

    let active = true;
    (async () => {
      if (!card.violationId && !card.path) return;
      setLoading(true);
      setError(null);

      const res = await unsealEvidenceSnapshot(card.violationId, card.path);
      if (!active) return;

      if (res.ok && res.dataUrl) {
        setModalImg(res.dataUrl);
      } else {
        setError(res.reason || res.error || 'Decryption unavailable');
      }
      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [card.violationId, card.path, modalImg]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md animate-in fade-in"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-700 bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-cyan-500/40 bg-cyan-500/15 px-2.5 py-0.5 text-xs font-semibold text-cyan-300">
              {card.label}
            </span>
            <h3 className="font-heading text-sm font-bold text-slate-100">
              {badge.label}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            ✕
          </button>
        </header>

        <div className="p-6 overflow-y-auto max-h-[calc(90vh-140px)] space-y-4">
          <div className="overflow-hidden rounded-xl border border-slate-800 bg-black min-h-[220px] grid place-items-center">
            {modalImg ? (
              <img
                src={modalImg}
                alt="Evidence snapshot"
                className="ph-no-capture ph-ignore-input w-full h-auto max-h-[60vh] object-contain mx-auto"
              />
            ) : loading ? (
              <div className="flex flex-col items-center gap-2 p-8">
                <div className="h-7 w-7 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
                <span className="font-mono text-xs text-cyan-400">Decrypting high-resolution frame…</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 p-8 text-center">
                <span className="text-2xl">🔒</span>
                <p className="text-xs text-slate-400">{error || 'Full snapshot preview unavailable'}</p>
              </div>
            )}
          </div>

          {card.cheatReason ? (
            <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                Gemini AI Analysis & Conclusion
              </p>
              <p className="mt-1 text-xs italic leading-relaxed text-slate-200">
                “{card.cheatReason}”
              </p>
            </div>
          ) : null}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
            <div className="rounded-lg border border-slate-800 bg-surface-raised/40 p-3">
              <p className="text-[10px] text-slate-500">Violation Type</p>
              <p className="mt-0.5 font-semibold text-slate-200">{card.violationType || '—'}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-surface-raised/40 p-3">
              <p className="text-[10px] text-slate-500">AI Confidence</p>
              <p className="mt-0.5 font-semibold text-cyan-300 font-mono">
                {Number.isFinite(card.cheatProbability) ? `${Math.round(card.cheatProbability)}%` : '—'}
              </p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-surface-raised/40 p-3">
              <p className="text-[10px] text-slate-500">Captured At</p>
              <p className="mt-0.5 font-semibold text-slate-200 font-mono">
                {formatCapturedAt(card.capturedAt)}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatCapturedAt(value) {
  const ms = Date.parse(value ?? '');
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

