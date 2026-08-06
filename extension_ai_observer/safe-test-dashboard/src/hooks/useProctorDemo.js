// =============================================================================
// useProctorDemo — the React bridge to ProctorDemoEngine (PLAN.md §6 Phase 6).
//
// ⚠ GOVERNING RULE: THE ENGINE MUST NEVER CAUSE A RENDER.
//
// The engine emits a `frame` event ~15 times a second. Routing that into
// useState would re-render the whole modal 15 times a second and make the
// overlay canvas fight React for the frame budget. So:
//
//   REFS  hold everything per-frame  — frameStateRef, engine, source, stream,
//         the FPS ring, the object-URL registry.
//   STATE holds only what genuinely changes the tree — lifecycle status, the
//         violation and suppression lists, the upload chip, and a readout that
//         is throttled to 2 Hz and pre-rounded.
//
// Two React Compiler constraints follow from that and are NOT negotiable:
//   - never read `frameStateRef.current` during render (it is torn per-frame
//     data; a render that depends on it is a render that lies half the time);
//   - never put the engine in a memo dependency array or a context value.
//
// StrictMode double-invokes effects. `engine.start()` is idempotent, but
// `getUserMedia` is not: without the `cancelled` guard below, the second
// invocation orphans the first stream and the camera indicator stays lit after
// the modal closes.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';

import { ProctorDemoEngine } from '../vision/demo_engine.js';
import { MediaPipeLandmarkSource, SOURCE_ERROR } from '../vision/adapters/landmark_source.js';
import { createSnapshotCapturer } from '../vision/snapshot.js';
import {
  ensureDemoSession,
  uploadDemoSnapshot,
  clearDemoSessionData,
  registerDemoCleanupOnUnload,
} from '../lib/demoSnapshots.js';

/** Lifecycle. Distinct from DEMO_ERROR: a demo can be RUNNING and degraded. */
export const DEMO_STATUS = Object.freeze({
  IDLE: 'IDLE',
  REQUESTING_CAMERA: 'REQUESTING_CAMERA',
  LOADING_MODEL: 'LOADING_MODEL',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  ERROR: 'ERROR',
});

/** PLAN.md §7 degradation contract — one code per row. */
export const DEMO_ERROR = Object.freeze({
  INSECURE_CONTEXT: 'INSECURE_CONTEXT',
  UNSUPPORTED: 'UNSUPPORTED',
  CAMERA_DENIED: 'CAMERA_DENIED',
  CAMERA_ABSENT: 'CAMERA_ABSENT',
  CAMERA_BUSY: 'CAMERA_BUSY',
  CAMERA_FAILED: 'CAMERA_FAILED',
  MODEL_LOAD_FAILED: 'MODEL_LOAD_FAILED',
});

/** Below this the "Reduced rate — N fps" chip appears. Engine targets ~15. */
const LOW_FPS_THRESHOLD = 10;

/** 2 Hz. Fast enough to read as live, slow enough that React is idle between. */
const READOUT_INTERVAL_MS = 500;

/** Object URLs are revoked on this timer AND on teardown, whichever is first. */
const OBJECT_URL_TTL_MS = 60_000;

const MAX_TIMELINE = 40;

/** Empty readout. Every readable field is null — never 0, never stale. */
const BLANK_READOUT = Object.freeze({
  tMs: 0,
  readable: false,
  paused: false,
  ear: null,
  gaze: null,
  gazeStatus: null,
  gazeReason: null,
  hRatio: null,
  vRatio: null,
  headStatus: null,
  headExcursion: null,
  faceCount: 0,
  calibrated: false,
  calibrationProgress: 0,
  fps: null,
  veto: null,
});

/**
 * DOMException name -> §7 row. `OverconstrainedError` lands on CAMERA_ABSENT
 * because it means "no device satisfies these constraints", which from the
 * visitor's side is indistinguishable from having no camera.
 */
function classifyCameraError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return DEMO_ERROR.CAMERA_DENIED;
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return DEMO_ERROR.CAMERA_ABSENT;
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return DEMO_ERROR.CAMERA_BUSY;
  }
  return DEMO_ERROR.CAMERA_FAILED;
}

/** data: URL -> Blob, for the "open full size" / "download" object URLs only.
 *  Thumbnails use the data URL directly and never come through here. */
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const binary = atob(dataUrl.slice(comma + 1));
  const mime = /data:(.*?);base64/.exec(header)?.[1] ?? 'image/jpeg';
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * @param {{paintLoop?: {stop: () => void} | null}} [options]
 *   `paintLoop` is threaded in so teardown can cancel the rAF at exactly the
 *   right position in the ordered sequence (see `teardown` below).
 */
export function useProctorDemo(options = {}) {
  const paintLoop = options.paintLoop ?? null;

  // --- refs: everything per-frame, everything the engine touches ------------
  const videoRef = useRef(null);
  const frameStateRef = useRef(null);
  const engineRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);
  const captureRef = useRef(null);
  const sessionIdRef = useRef(null);
  const unloadCleanupRef = useRef(null);
  const fpsRingRef = useRef([]);
  const lastReadoutAtRef = useRef(0);
  const objectUrlsRef = useRef(new Map());
  const startTokenRef = useRef(0);
  const uploadedOnceRef = useRef(false);

  // --- state: lifecycle + lists + a 2 Hz readout. Nothing per-frame. -------
  const [status, setStatus] = useState(DEMO_STATUS.IDLE);
  const [errorCode, setErrorCode] = useState(null);
  const [delegate, setDelegate] = useState(null);
  const [violations, setViolations] = useState([]);
  const [suppressions, setSuppressions] = useState([]);
  const [readout, setReadout] = useState(BLANK_READOUT);
  const [uploadNotice, setUploadNotice] = useState(null);
  // Mirrors sessionIdRef for the RETURN VALUE only. The ref is what teardown and
  // the upload path read — they need the current value synchronously, mid-flight,
  // without waiting for a render. But returning `sessionIdRef.current` would be
  // reading a ref during render: React does not re-render when a ref changes, so
  // a consumer rendering a "session: …" chip would show `null` forever. It is the
  // same rule this hook already applies to frameStateRef, and it earns its own
  // state because sessionId changes twice per demo (start, stop) — not per frame.
  const [sessionId, setSessionId] = useState(null);

  // -------------------------------------------------------------------------
  // Teardown. ORDER IS LOAD-BEARING (PLAN.md §6 Phase 6).
  // -------------------------------------------------------------------------
  const teardown = useCallback(async () => {
    // 1. Engine first — stop() closes the FaceLandmarker. Skipping that leaks
    //    tens of MB of WASM heap per modal open, and it must happen before the
    //    video element it reads from is detached.
    try {
      engineRef.current?.stop();
    } catch (err) {
      console.error('[useProctorDemo] engine.stop failed', err);
    }
    engineRef.current = null;
    sourceRef.current = null;

    // 2. Cancel the paint loop. After this nothing reads frameStateRef.
    try {
      paintLoop?.stop();
    } catch { /* already stopped */ }

    // 3. Stop the tracks, THEN null srcObject. The other order can leave a
    //    detached-but-live track running, i.e. the camera light stays on.
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* already ended */ }
      }
    }
    const video = videoRef.current;
    if (video) {
      try { video.pause(); } catch { /* not playing */ }
      video.srcObject = null;
    }

    // 4. Revoke every object URL we minted for "open full size" / "download".
    for (const [url, timer] of objectUrlsRef.current) {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
    }
    objectUrlsRef.current.clear();

    // 5. Remote evidence. Awaited here (unlike the beforeunload path, which
    //    cannot await) so "closed the modal" really does mean "deleted".
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    unloadCleanupRef.current?.();
    unloadCleanupRef.current = null;
    if (sessionId) {
      try { await clearDemoSessionData(sessionId); } catch { /* best effort */ }
    }

    // 6. Drop the per-frame data last.
    frameStateRef.current = null;
    fpsRingRef.current = [];
    lastReadoutAtRef.current = 0;
    uploadedOnceRef.current = false;
  }, [paintLoop]);

  // -------------------------------------------------------------------------
  // Engine event wiring. Called once per engine instance, inside start().
  // -------------------------------------------------------------------------
  const attachEngineListeners = useCallback((engine) => {
    const offFrame = engine.on('frame', (fs) => {
      // ---- FPS, measured over a 1 s sliding window --------------------------
      const ring = fpsRingRef.current;
      ring.push(fs.tMs);
      while (ring.length > 0 && fs.tMs - ring[0] > 1000) ring.shift();
      const fps = ring.length >= 2
        ? Math.round((ring.length - 1) * 1000 / Math.max(1, ring[ring.length - 1] - ring[0]))
        : null;

      // ---- EAR for the gauge -----------------------------------------------
      // `fs.ear` is authoritative. demo_engine's `_readEar()` applies the gate's
      // OWN maxAgeMs staleness rule, so a stale sample already arrives here as
      // null and renders as a hatch (§7), never as a number. Nothing about EAR
      // is re-derived in this file. (This carried a fallback while `_readEar()`
      // read a `lastEar` field the gate does not expose; fixed at source.)
      const veto = engineRef.current?.veto?.telemetry?.() ?? null;
      const earFresh = !!veto && veto.sampledAt !== null
        && (fs.tMs - veto.sampledAt) <= veto.maxAgeMs;
      const ear = Number.isFinite(fs.ear) ? fs.ear : null;

      // Per-eye EAR, from the gate's own `computeFaceEar` output. The overlay
      // needs the two eyes SEPARATELY: `analyzeGazeLandmarks` invalidates the
      // whole sample when either eye is shut (blink immunity is not a per-eye
      // property), so a combined signal would dash both boxes when only one eye
      // is covered — and PLAN.md §8's mirror check depends on exactly one box
      // going dashed.
      const leftEar = earFresh && veto.leftEar !== null ? veto.leftEar : null;
      const rightEar = earFresh && veto.rightEar !== null ? veto.rightEar : null;

      // ---- The frame's gaze sample -----------------------------------------
      // GazeLandmarkAnalyzer sets `lastReason = null` ONLY on the branch that
      // also assigns `lastSample`, so a null reason is precisely "this frame
      // produced a valid sample". Any other reason means lastSample belongs to
      // an older frame and must not be drawn — an old vector re-rendered as
      // current is the fabricated reading this architecture forbids.
      const gazeSample = (fs.gaze && fs.gaze.reason === null)
        ? (engineRef.current?.gaze?.lastSample ?? null)
        : null;

      // ---- per-frame ref write. NEVER read during render. -------------------
      frameStateRef.current = {
        tMs: fs.tMs,
        readable: !!fs.readable,
        landmarks: fs.landmarks ?? null,
        frameW: fs.frameW ?? 0,
        frameH: fs.frameH ?? 0,
        faceCount: fs.faceCount ?? 0,
        head: fs.head ?? null,
        gaze: fs.gaze ?? null,
        gazeSample,
        ear,
        leftEar,
        rightEar,
        calibrated: !!fs.calibrated,
        calibrationProgress: fs.calibrationProgress ?? 0,
        fps,
      };

      // ---- 2 Hz, pre-rounded readout. THE ONLY per-frame path to setState. --
      if (fs.tMs - lastReadoutAtRef.current >= READOUT_INTERVAL_MS) {
        lastReadoutAtRef.current = fs.tMs;
        setReadout({
          tMs: Math.round(fs.tMs),
          readable: !!fs.readable,
          paused: false,
          ear: ear === null ? null : Math.round(ear * 1000) / 1000,
          gaze: fs.gaze?.gaze ?? null,
          gazeStatus: fs.gaze?.status ?? null,
          gazeReason: fs.gaze?.reason ?? null,
          hRatio: gazeSample && Number.isFinite(gazeSample.hRatio)
            ? Math.round(gazeSample.hRatio * 1000) / 1000 : null,
          vRatio: gazeSample && Number.isFinite(gazeSample.vRatio)
            ? Math.round(gazeSample.vRatio * 1000) / 1000 : null,
          headStatus: fs.head?.status ?? null,
          headExcursion: Number.isFinite(fs.head?.smoothedExcursion)
            ? Math.round(fs.head.smoothedExcursion * 100) / 100 : null,
          faceCount: fs.faceCount ?? 0,
          calibrated: !!fs.calibrated,
          calibrationProgress: Math.round((fs.calibrationProgress ?? 0) * 100) / 100,
          fps,
          veto,
        });
      }
    });

    const offViolation = engine.on('violation', (record) => {
      // ⚠ `tMs` AND `wallTime` ARE DIFFERENT CLOCKS AND MUST NOT BE COMPARED.
      // `tMs` comes from the engine's monotonic clock (ms since page load, so a
      // small number); the extension stamps its own violations with Date.now()
      // (~1.7e12). A consumer merging both streams and sorting on one field
      // would push every browser-detected violation permanently to the bottom of
      // the list. Stamping the wall clock HERE — in an event handler, at the
      // moment the violation actually happened — gives both sources a common
      // basis. It cannot be done at render time: Date.now() during render is
      // impure and the timestamp would drift on every re-render.
      setViolations((prev) => [{ ...record, wallTime: Date.now() }, ...prev].slice(0, MAX_TIMELINE));

      // The upload chip. `uploaded === false` is read off the returned shape,
      // never inferred from a thrown error or a truthy check (PLAN.md §5).
      if (record.snapshot?.dataUrl) {
        uploadDemoSnapshot({
          sessionId: sessionIdRef.current,
          dataUrl: record.snapshot.dataUrl,
          filename: `${record.id.replace(/[^A-Za-z0-9._-]/g, '-')}.jpg`,
        }).then((result) => {
          uploadedOnceRef.current = true;
          setUploadNotice({ uploaded: result.uploaded, reason: result.reason });
        }).catch(() => {
          // A rejected promise carries no `reason`, so it cannot drive the
          // chip's wording. Say only what is known: it did not upload.
          setUploadNotice({ uploaded: false, reason: 'UPLOAD_FAILED' });
        });
      }
    });

    const offSuppressed = engine.on('suppressed', (record) => {
      setSuppressions((prev) => [
        { ...record, id: `${record.type}-${Math.round(record.tMs)}-${prev.length}` },
        ...prev,
      ].slice(0, MAX_TIMELINE));
    });

    const offPaused = engine.on('paused', () => {
      // §7: the gauge must read "paused", NOT the last value. Every readable
      // field is blanked in the same update that flips the flag.
      setReadout({ ...BLANK_READOUT, paused: true });
    });

    const offError = engine.on('error', (payload) => {
      console.error('[useProctorDemo] engine error', payload?.error);
    });

    return () => {
      offFrame(); offViolation(); offSuppressed(); offPaused(); offError();
    };
  }, []);

  // -------------------------------------------------------------------------
  // start() — invoked from a user gesture, never from an effect.
  // -------------------------------------------------------------------------
  const start = useCallback(async () => {
    // A monotonic token replaces the usual `cancelled` boolean: it survives
    // StrictMode's double-invoke AND a Restart during an in-flight start.
    const token = startTokenRef.current + 1;
    startTokenRef.current = token;
    const stale = () => startTokenRef.current !== token;

    setErrorCode(null);
    setUploadNotice(null);

    // §7 row 1 — insecure context. Checked BEFORE anything can prompt: asking
    // for a camera we are structurally unable to receive trains people to click
    // through permission dialogs.
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setStatus(DEMO_STATUS.ERROR);
      setErrorCode(DEMO_ERROR.INSECURE_CONTEXT);
      return;
    }
    // §7 row 2 — no mediaDevices at all.
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setStatus(DEMO_STATUS.ERROR);
      setErrorCode(DEMO_ERROR.UNSUPPORTED);
      return;
    }

    setStatus(DEMO_STATUS.REQUESTING_CAMERA);

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
    } catch (err) {
      if (stale()) return;
      setStatus(DEMO_STATUS.ERROR);
      setErrorCode(classifyCameraError(err));
      return;
    }

    // ⚠ THE STRICTMODE GUARD. If this start was superseded while awaiting, the
    // stream we are holding belongs to nobody — stop it here or the camera
    // indicator stays lit for the life of the page.
    if (stale()) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    streamRef.current = stream;

    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      try { await video.play(); } catch { /* autoplay policy; readyState still advances */ }
    }
    if (stale()) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }

    setStatus(DEMO_STATUS.LOADING_MODEL);

    const source = new MediaPipeLandmarkSource();
    try {
      const info = await source.load();
      if (stale()) { source.close(); for (const t of stream.getTracks()) t.stop(); return; }
      setDelegate(info.delegate);
    } catch (err) {
      if (stale()) return;
      // §7 — MODEL_LOAD_FAILED STOPS THE STREAM TOO. A live preview beside a
      // dead engine implies analysis is happening. It is not, and leaving the
      // camera on would be the demo telling its first lie.
      for (const t of stream.getTracks()) t.stop();
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setStatus(DEMO_STATUS.ERROR);
      setErrorCode(err?.message === SOURCE_ERROR.MODEL_LOAD_FAILED
        ? DEMO_ERROR.MODEL_LOAD_FAILED
        : DEMO_ERROR.MODEL_LOAD_FAILED);
      return;
    }
    sourceRef.current = source;

    // Evidence session. Local-only when Supabase is unconfigured — the returned
    // shape says which, and the chip is rendered from that, not guessed.
    const session = await ensureDemoSession(sessionIdRef.current);
    if (stale()) { source.close(); for (const t of stream.getTracks()) t.stop(); return; }
    sessionIdRef.current = session.sessionId;
    setSessionId(session.sessionId);
    unloadCleanupRef.current = registerDemoCleanupOnUnload(session.sessionId);
    if (!session.remote) setUploadNotice({ uploaded: false, reason: session.reason });

    captureRef.current = captureRef.current ?? createSnapshotCapturer();

    const engine = new ProctorDemoEngine({
      landmarkSource: source,
      captureSnapshot: captureRef.current,
    });
    engineRef.current = engine;
    attachEngineListeners(engine);
    engine.attachVideo(videoRef.current);
    engine.start();   // idempotent

    setStatus(DEMO_STATUS.RUNNING);
  }, [attachEngineListeners]);

  // -------------------------------------------------------------------------
  const stop = useCallback(async () => {
    startTokenRef.current += 1;   // invalidate any in-flight start()
    await teardown();
    setStatus(DEMO_STATUS.IDLE);
    setDelegate(null);
    setViolations([]);
    setSuppressions([]);
    setReadout(BLANK_READOUT);
    setUploadNotice(null);
    setSessionId(null);
  }, [teardown]);

  /** "Restart Demo" runs the full teardown, then a clean start. */
  const restart = useCallback(async () => {
    await stop();
    await start();
  }, [start, stop]);

  // -------------------------------------------------------------------------
  // Tab visibility -> PAUSED. Handled explicitly rather than left to rAF
  // throttling, so the UI can SAY it is paused instead of showing stale numbers.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const onVisibility = () => {
      const engine = engineRef.current;
      if (!engine || !engine.running) return;
      if (document.visibilityState === 'hidden') {
        engine.pause();
        setStatus(DEMO_STATUS.PAUSED);
      } else {
        engine.resume();
        setStatus(DEMO_STATUS.RUNNING);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Unmount: the same ordered teardown the close button runs.
  useEffect(() => () => {
    startTokenRef.current += 1;
    void teardown();
  }, [teardown]);

  // -------------------------------------------------------------------------
  // Snapshot object URLs — minted ONLY here, for full-size view and download.
  // Thumbnails render `record.snapshot.dataUrl` directly and revoke nothing.
  // -------------------------------------------------------------------------
  const createSnapshotUrl = useCallback((record) => {
    const dataUrl = record?.snapshot?.dataUrl;
    if (!dataUrl) return null;
    const url = URL.createObjectURL(dataUrlToBlob(dataUrl));
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      objectUrlsRef.current.delete(url);
    }, OBJECT_URL_TTL_MS);
    objectUrlsRef.current.set(url, timer);
    return url;
  }, []);

  const lowFps = readout.fps !== null && readout.fps < LOW_FPS_THRESHOLD;

  return {
    // lifecycle
    status,
    errorCode,
    isRunning: status === DEMO_STATUS.RUNNING,
    isPaused: status === DEMO_STATUS.PAUSED,
    // wiring
    videoRef,
    frameStateRef,   // ⚠ paint-loop only. Never read this during render.
    // display state (2 Hz)
    readout,
    violations,
    suppressions,
    // chips
    delegate,
    cpuMode: delegate === 'CPU',
    lowFps,
    uploadNotice,
    sessionId,
    // actions
    start,
    stop,
    restart,
    createSnapshotUrl,
  };
}
