// =============================================================================
// EvidencePanel — the live evidence stream, fed from BOTH detection layers.
//
// Relocated from components/SandboxQuiz/ when the sandbox was replaced by the
// MCQ exam. Unchanged in contract: it takes one already-merged, newest-first
// list and renders it.
//
// ⚠ IT MUST STAY SOURCE-AGNOSTIC. A record arrives either from the in-page
// MediaPipe engine (`snapshot.dataUrl`) or from the extension's ONNX layer
// (`snapshotUrl` once the signed URL resolves, `snapshotB64` immediately). The
// card prefers the signed URL, falls back to the inline base64, and says which
// layer saw it — because "the browser noticed" and "the extension noticed" are
// different claims and a reviewer needs to tell them apart.
// =============================================================================

import { useEffect, useRef, useState } from 'react';

const SEVERITY_STYLE = {
  CRITICAL: 'bg-violation/20 text-violation ring-1 ring-violation/40',
  HIGH: 'bg-violation/15 text-violation ring-1 ring-violation/30',
  MEDIUM: 'bg-glance/15 text-glance ring-1 ring-glance/30',
  LOW: 'bg-slate-800/60 text-slate-300 ring-1 ring-slate-600/40',
};

const TYPE_COPY = {
  AI_CHEATING_POSE: 'Looked away',
  HEAD_POSE_GLANCE: 'Brief glance away',
  NO_FACE_DETECTED: 'Left the camera',
  MULTIPLE_FACES: 'Second person visible',
  SIDE_GAZE_PEEKING: 'Side gaze detected',
  PHONE_DETECTED: 'Phone detected',
  SECONDARY_DEVICE: 'Secondary device',
};

function EvidenceCard({ record }) {
  const [opened, setOpened] = useState(false);
  const style = SEVERITY_STYLE[record.severity] ?? SEVERITY_STYLE.LOW;

  // Signed URL first, inline base64 second, in-page capture third.
  // ⚠ INLINE BASE64 FIRST, SIGNED URL SECOND — COEP DEPENDS ON THIS ORDER.
  //
  // public/_headers sends `Cross-Origin-Embedder-Policy: require-corp`, which
  // blocks any cross-origin subresource lacking a CORP header. A Supabase
  // Storage signed URL is exactly that, so preferring it renders a broken image
  // on a page already holding the identical bytes inline. A data: URL is exempt
  // from COEP, needs no network round trip, and cannot expire mid-session.
  // The signed URL remains the fallback for records carrying no inline copy.
  const imageSrc = record.snapshotB64 || record.snapshot?.dataUrl || record.snapshotUrl;
  const hasSnapshot = !!imageSrc;
  const sourceLabel = record.source === 'extension' ? 'Extension (ONNX)' : 'Browser (MediaPipe)';

  const openFullSize = () => {
    if (!imageSrc) return;
    setOpened(true);
    const w = window.open('', '_blank', 'noopener,noreferrer');
    if (!w) return;
    // ⚠ Built as a DOM node, NOT interpolated into document.write. A snapshot
    // URL is data we received rather than data we authored — a signed URL from
    // storage, or a base64 string relayed across a postMessage bridge — and
    // splicing either into an HTML string is an injection sink. Assigning .src
    // cannot break out of the attribute.
    const img = w.document.createElement('img');
    img.src = imageSrc;
    img.alt = TYPE_COPY[record.type] ?? record.type;
    img.style.maxWidth = '100%';
    w.document.body.appendChild(img);
  };

  const timestamp = new Date(record.wallTime ?? record.tMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <li className="group flex flex-col overflow-hidden rounded-card border border-slate-800 bg-surface-raised/70 transition hover:border-slate-600">
      {hasSnapshot ? (
        <button
          type="button"
          onClick={openFullSize}
          className="relative aspect-video w-full overflow-hidden bg-base focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-verified"
          title="Open evidence full size"
        >
          <img
            src={imageSrc}
            alt={`Evidence: ${TYPE_COPY[record.type] ?? record.type}`}
            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
          />
          <span className="absolute right-2 top-2 rounded-md bg-base/70 px-1.5 py-0.5 text-[10px] text-slate-300 opacity-0 backdrop-blur-sm transition group-hover:opacity-100">
            ↗ Full size
          </span>
        </button>
      ) : (
        <div className="grid aspect-video w-full place-items-center bg-base/50">
          {/* Distinguishes "the upload failed" from "no frame existed". A blank
              tile for both would hide a broken storage path. */}
          <p className="px-3 text-center text-xs leading-relaxed text-slate-600">
            {record.uploadError ? 'Upload failed — evidence held locally' : 'No frame captured'}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${style}`}>
            {record.severity?.toLowerCase() ?? 'event'}
          </span>
          <p className="min-w-0 truncate text-sm font-medium text-slate-100">
            {TYPE_COPY[record.type] ?? record.type}
          </p>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-400">{sourceLabel}</span>
          <span className="tnum font-mono text-[11px] text-slate-500">{timestamp}</span>
        </div>
      </div>

      {opened ? (
        <p className="border-t border-slate-800/60 px-3 py-1 text-[10px] text-slate-500">
          Opened evidence in a new tab.
        </p>
      ) : null}
    </li>
  );
}

/**
 * @param {{violations: Array<object>}} props newest-first, already merged.
 */
export default function EvidencePanel({ violations }) {
  const scrollRef = useRef(null);

  // Newest is prepended, so "follow the stream" means scrolling to the TOP.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [violations]);

  return (
    <section aria-label="Evidence stream" className="flex h-full min-h-0 flex-col">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium tracking-wide text-slate-400 uppercase">
          Evidence Stream
        </h3>
        <span className="tnum font-mono text-[11px] text-slate-500">
          {violations.length} {violations.length === 1 ? 'incident' : 'incidents'}
        </span>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
        {/* Type only — no EAR values or gate reasons read aloud every few
            seconds at someone trying to sit an exam. */}
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {violations[0] ? `${TYPE_COPY[violations[0].type] ?? violations[0].type} detected` : ''}
        </p>

        {violations.length === 0 ? (
          <div className="grid h-full place-items-center rounded-card border border-dashed border-slate-700 p-6">
            <div className="text-center">
              <p className="text-3xl" aria-hidden="true">📷</p>
              <p className="mt-3 text-sm text-slate-300">Monitoring — nothing flagged</p>
              <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-500">
                An empty stream is the expected state. Blinking and looking down
                at a keyboard are supposed to appear here as nothing at all.
              </p>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {violations.map((record) => (
              <EvidenceCard key={record.id} record={record} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
