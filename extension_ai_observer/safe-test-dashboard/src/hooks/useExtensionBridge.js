// =============================================================================
// useExtensionBridge — detect the Procminds extension and manage guest quiz comms.
//
// Uses window.postMessage to communicate with the extension's guest_bridge.js
// content script. The extension responds to SAFETEST_DEMO_PING with
// SAFETEST_DEMO_PONG, and accepts SAFETEST_START_GUEST_QUIZ to enter guest
// proctoring mode.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';

import { ensureDemoSession, clearDemoSessionData } from '../lib/demoSnapshots.js';
import { supabase } from '../lib/supabase.js';

const PING_TIMEOUT_MS = 1500;

/**
 * How long after the LAST violation the live status stays raised.
 *
 * ⚠ THE LIVE STATUS AND THE EVIDENCE LOG ANSWER DIFFERENT QUESTIONS.
 *
 * The log is a history: "what happened during this session", and nothing should
 * ever be removed from it. The status banner is an instantaneous reading: "is
 * something wrong RIGHT NOW". Deriving the banner from `violations.length > 0`
 * conflated the two, so one glance away at minute one left the page declaring an
 * active incident for the remaining nine — which is both wrong and, in a product
 * that accuses people of cheating, exactly the wrong direction to be wrong in.
 *
 * The window is measured from the most recent violation, not from the first, so
 * a sustained episode keeps the banner up for as long as it keeps producing
 * events and clears 3 s after the candidate returns to compliance.
 */
export const LIVE_STATUS_RECOVERY_MS = 3000;

export const LIVE_STATUS = Object.freeze({
  NORMAL: 'NORMAL',
  ACTIVE: 'ACTIVE',
});

export function useExtensionBridge() {
  const [extensionDetected, setExtensionDetected] = useState(null); // null = probing
  const [guestSessionId, setGuestSessionId] = useState(null);
  const [extensionViolations, setExtensionViolations] = useState([]);

  // ⚠ THE SESSION ID IS HELD IN A REF, NOT READ FROM STATE, BY `stopGuestQuiz`.
  //
  // A `useCallback` closing over `guestSessionId` gets a new identity whenever
  // that state changes, which changes the identity of the object this hook
  // returns, which re-runs any caller effect keyed on it. `DemoQuizPage` mounts
  // exactly such an effect, and its 1 Hz countdown re-renders — so the pair
  // became a stop+start of the ENTIRE proctoring stack once per second:
  // chrome.storage thrash, ONNX sessions torn down and rebuilt, the camera
  // reopened, and `clearDemoSessionData` deleting the visitor's own uploaded
  // evidence on every tick. Both callbacks below are therefore stable for the
  // life of the hook, and everything they need at call time comes from a ref.
  const sessionIdRef = useRef(null);

  // Generation counter. `startGuestQuiz` awaits an anonymous sign-in before it
  // can post anything; if the page unmounts during that await, the resolution
  // would otherwise start proctoring on a page that no longer exists and leave
  // the camera running with nothing left mounted to stop it. Any stop — and any
  // newer start — invalidates an in-flight start by bumping this.
  const startTokenRef = useRef(0);

  // Live compliance reading — see LIVE_STATUS_RECOVERY_MS. Held separately from
  // `extensionViolations` on purpose: the list only ever grows, and this only
  // ever reflects the last few seconds.
  const [liveStatus, setLiveStatus] = useState(LIVE_STATUS.NORMAL);
  const recoveryTimerRef = useRef(null);

  const raiseLiveStatus = useCallback(() => {
    setLiveStatus(LIVE_STATUS.ACTIVE);
    // Restart the window rather than stacking timers, so a burst of violations
    // clears 3 s after the LAST one instead of 3 s after the first.
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = null;
      setLiveStatus(LIVE_STATUS.NORMAL);
    }, LIVE_STATUS_RECOVERY_MS);
  }, []);

  // A pending recovery timer must not outlive the component, or it fires
  // setState on an unmounted hook after the visitor has left the page.
  useEffect(() => () => {
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }, []);

  // ── Probe for extension on mount ─────────────────────────────────────────
  useEffect(() => {
    let resolved = false;

    const onMessage = (event) => {
      if (event.source !== window) return;
      if (event.data?.type === 'SAFETEST_DEMO_PONG' && event.data?.installed) {
        resolved = true;
        setExtensionDetected(true);
      }
    };

    window.addEventListener('message', onMessage);
    window.postMessage({ type: 'SAFETEST_DEMO_PING' }, '*');

    const timer = setTimeout(() => {
      if (!resolved) setExtensionDetected(false);
    }, PING_TIMEOUT_MS);

    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
    };
  }, []);

  // ── Listen for extension violation events ─────────────────────────────────
  useEffect(() => {
    const onMessage = (event) => {
      if (event.source !== window) return;
      const msg = event.data;

      // The content script was orphaned by an extension reload/update. It can
      // never recover in this page, so the banner must stop claiming proctoring
      // is active — otherwise the visitor is told they are being monitored by
      // something that is no longer running.
      if (msg?.type === 'SAFETEST_EXTENSION_DISCONNECTED') {
        setExtensionDetected(false);
        setLiveStatus(LIVE_STATUS.NORMAL);
        return;
      }

      if (msg?.type === 'SAFETEST_GUEST_VIOLATION') {
        raiseLiveStatus();
        setExtensionViolations((prev) => [{
          id: msg.violationId || `ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: msg.violationType,
          severity: msg.severity,
          ear: msg.ear,
          snapshotUrl: msg.snapshotUrl,
          snapshotB64: msg.snapshotB64,
          tMs: msg.tMs,
          wallTime: Date.now(),
          source: 'extension',
        }, ...prev].slice(0, 50));
      }

      // Update snapshot URL when it arrives asynchronously
      if (msg?.type === 'SAFETEST_GUEST_SNAPSHOT_URL') {
        setExtensionViolations((prev) =>
          prev.map((v) =>
            v.id === msg.violationId ? { ...v, snapshotUrl: msg.snapshotUrl } : v
          )
        );
      }

      // An upload that failed is RECORDED, not ignored. The card keeps its
      // inline base64 image so the evidence is still visible locally, and
      // `uploadError` marks it as never having reached storage — the difference
      // between "not uploaded" and "uploading" must not be a blank space.
      if (msg?.type === 'SAFETEST_GUEST_UPLOAD_FAILED') {
        console.warn('[Procminds] guest snapshot upload failed:', msg.reason);
        setExtensionViolations((prev) =>
          prev.map((v) =>
            v.id === msg.violationId ? { ...v, uploadError: msg.reason || 'UPLOAD_FAILED' } : v
          )
        );
      }
    };

    // The removal closes over this exact `onMessage`, and the effect has no
    // dependencies, so the handler added on mount is the handler removed on
    // unmount — no ghost listener survives a re-entry into /demo-quiz.
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // `raiseLiveStatus` is a stable useCallback([]), so listing it does not
    // re-bind the listener — it just keeps the dependency honest.
  }, [raiseLiveStatus]);

  // ── Start guest quiz ─────────────────────────────────────────────────────
  /**
   * ⚠ THE SESSION ID MUST BE `auth.uid()`, NOT A FRESH `crypto.randomUUID()`.
   *
   * This used to mint its own UUID and hand the extension a bare anon key. Both
   * halves were wrong against the bucket's policies:
   *
   *   - `demo_snapshots_insert_own` is granted `to authenticated` ONLY, and the
   *     migration states outright that there is no policy for the `anon` role —
   *     a path-only rule would let any caller list `demo/` and enumerate every
   *     visitor's face snapshots.
   *   - The policy requires `(storage.foldername(name))[2] = auth.uid()::text`,
   *     so an arbitrary client-generated UUID never matches even with a valid
   *     token.
   *
   * Every upload therefore 403'd, and `guest_bridge.js` swallowed it — the
   * evidence simply never appeared, with no error anywhere. `storage.objects`
   * holding zero rows is the fingerprint of exactly that.
   *
   * `ensureDemoSession()` already solves this correctly for the in-page demo:
   * it performs `signInAnonymously()` and returns a `sessionId` that IS the
   * caller's `auth.uid()`. Reusing it here keeps one definition of "which
   * folder may this visitor write to" instead of a second, weaker one.
   *
   * @returns {Promise<string>} the session id (auth.uid() when remote).
   */
  const startGuestQuiz = useCallback(async () => {
    const token = ++startTokenRef.current;

    const session = await ensureDemoSession(null);

    // The access token is what makes the request `authenticated` rather than
    // `anon`. ensureDemoSession deliberately does not return it — it is not
    // needed in-page, where the SDK attaches it — so read it here.
    let accessToken = null;
    if (session.remote && supabase) {
      const { data } = await supabase.auth.getSession();
      accessToken = data?.session?.access_token ?? null;
    }

    // Superseded while we were signing in — the page was left, or a newer start
    // overtook this one. Posting START now would hand the extension a camera it
    // has no owner to release: the unmount already ran, so nothing downstream
    // will ever call stop for THIS session.
    if (token !== startTokenRef.current) return session.sessionId;

    sessionIdRef.current = session.sessionId;
    setGuestSessionId(session.sessionId);
    setExtensionViolations([]);

    window.postMessage({
      type: 'SAFETEST_START_GUEST_QUIZ',
      guestSessionId: session.sessionId,
      supabaseUrl: import.meta.env?.VITE_SUPABASE_URL || undefined,
      // Still sent: Supabase requires the `apikey` header on every REST call in
      // addition to the bearer token. It is the token that grants the write.
      supabaseAnonKey: import.meta.env?.VITE_SUPABASE_ANON_KEY || undefined,
      accessToken: accessToken || undefined,
      // Told explicitly rather than inferred from a missing token, so the
      // extension can log "local only, and here is why" instead of guessing.
      remote: session.remote,
      reason: session.reason,
    }, '*');

    return session.sessionId;
  }, []);

  // ── Stop guest quiz ──────────────────────────────────────────────────────
  /**
   * ⚠ THE EVIDENCE IS DELETED, NOT JUST FORGOTTEN.
   *
   * Clearing React state only removes the cards from the screen. The snapshots
   * the extension uploaded are still sitting in `demo/{uid}/` in the bucket —
   * webcam face crops of a real visitor, kept after they closed the thing that
   * captured them. "Closed the demo" has to mean "deleted", or the privacy claim
   * on the landing page is not true.
   *
   * The extension is told to stop FIRST. Deleting while it is still uploading
   * would race, and the straggler would survive the cleanup.
   */
  const stopGuestQuiz = useCallback(async () => {
    // Invalidate any start still awaiting its anonymous sign-in, BEFORE posting
    // stop. Otherwise that start resolves afterwards and re-arms the extension
    // against a page that is already gone.
    startTokenRef.current++;

    window.postMessage({ type: 'SAFETEST_STOP_GUEST_QUIZ' }, '*');

    const uid = sessionIdRef.current;
    sessionIdRef.current = null;
    setGuestSessionId(null);
    setExtensionViolations([]);

    if (uid) {
      try {
        await clearDemoSessionData(uid);
      } catch {
        // Best effort. The in-page demo's own teardown clears the same prefix,
        // so a failure here is covered rather than silent — and it must not
        // stop the modal from closing.
      }
    }
  }, []);

  return {
    extensionDetected,
    guestSessionId,
    extensionViolations,
    liveStatus,
    startGuestQuiz,
    stopGuestQuiz,
  };
}
