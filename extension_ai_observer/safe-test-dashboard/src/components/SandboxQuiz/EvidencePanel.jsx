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
  
  // Extension records might have snapshotUrl, snapshotB64, while browser has snapshot.dataUrl.
  //
  // ⚠ INLINE BASE64 FIRST — see public/_headers. `require-corp` blocks the
  // cross-origin Supabase signed URL (no CORP header), so preferring it would
  // render a broken image while the identical bytes sit inline. data: URLs are
  // exempt from COEP; the signed URL stays as the fallback.
  const imageSrc = record.snapshotB64 || record.snapshot?.dataUrl || record.snapshotUrl;
  const hasSnapshot = !!imageSrc;
  
  const sourceLabel = record.source === 'extension' ? 'Extension' : 'Browser';

  const openFullSize = () => {
    if (imageSrc) {
      setOpened(true);
      // For object URLs, we'd need createSnapshotUrl but for b64/url we can just open
      // In a real app we'd want to handle cleanup. This is simplified.
      const w = window.open();
      if (w) w.document.write(`<img src="${imageSrc}" style="max-width: 100%;" />`);
    }
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
          <p className="text-xs text-slate-600">No frame captured</p>
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
          <span className="text-[10px] text-slate-400">Source: {sourceLabel}</span>
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

export default function EvidencePanel({ violations }) {
  const scrollRef = useRef(null);

  // Auto-scroll to top since we prepend, or bottom if we append?
  // ProctorDemo prepends (latest first). So we don't necessarily need to scroll to bottom,
  // just scroll to top.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [violations]);

  return (
    <section aria-label="Evidence stream" className="flex h-full flex-col">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium tracking-wide text-slate-400 uppercase">
          Evidence Stream
        </h3>
        <span className="tnum font-mono text-[11px] text-slate-500">
          {violations.length} {violations.length === 1 ? 'incident' : 'incidents'}
        </span>
      </header>

      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto pr-1"
      >
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {violations[0]
            ? `${TYPE_COPY[violations[0].type] ?? violations[0].type} detected`
            : ''}
        </p>

        {violations.length === 0 ? (
           <div className="grid h-full place-items-center rounded-card border border-dashed border-slate-700 p-6">
             <div className="text-center">
               <p className="text-3xl" aria-hidden="true">📷</p>
               <p className="mt-3 text-sm text-slate-300">
                 Monitoring for violations...
               </p>
               <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-500">
                 Violations from both browser and extension will appear here.
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
