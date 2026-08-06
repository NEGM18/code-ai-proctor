// =============================================================================
// Guest Bridge — SafeTest Extension ↔ Web Communication
// Content script injected at document_start on safetest.space and localhost.
// Translates window.postMessage ↔ chrome.runtime.sendMessage for guest mode.
// =============================================================================

(function guestBridge() {
  'use strict';

  /**
   * ⚠ THIS SCRIPT OUTLIVES THE EXTENSION THAT INJECTED IT.
   *
   * Reloading or updating the extension destroys the background context while
   * this content script keeps running in an open page. Every chrome.* call then
   * throws `Extension context invalidated`. This bridge is the first thing the
   * demo page talks to, so an orphaned copy throws on the very first postMessage
   * — which is what surfaced as an uncaught error with the page looking fine.
   *
   * The condition is terminal: nothing revives an orphaned content script. So
   * the guard does not retry, it goes quiet and tells the page once, which lets
   * the React side stop showing "Proctoring Active" for a session that no longer
   * has an extension behind it.
   */
  let _contextDead = false;

  function contextAlive() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function noteContextDead(where) {
    if (_contextDead) return;
    _contextDead = true;
    _guestSessionId = null;
    console.warn(`[SafeTest Bridge] Extension context invalidated (${where}) — reload the page to resume proctoring.`);
    try {
      window.postMessage({ type: 'SAFETEST_EXTENSION_DISCONNECTED' }, '*');
    } catch (e) { /* page is going away too */ }
  }

  function safeStorageSet(items, where) {
    if (!contextAlive()) { noteContextDead(where); return false; }
    try { chrome.storage.local.set(items); return true; } catch (e) { noteContextDead(where); return false; }
  }

  function safeSendMessage(message, where) {
    if (!contextAlive()) { noteContextDead(where); return false; }
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return true;
    } catch (e) { noteContextDead(where); return false; }
  }

  let _guestSessionId = null;   // === auth.uid() when the page signed in
  let _supabaseUrl = null;
  let _supabaseAnonKey = null;
  let _accessToken = null;      // user JWT — this is what grants the write
  let _remote = false;

  // ─── Inbound from webpage ──────────────────────────────────────────────────

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'SAFETEST_DEMO_PING':
        window.postMessage({ type: 'SAFETEST_DEMO_PONG', installed: true }, '*');
        break;

      case 'SAFETEST_START_GUEST_QUIZ': {
        const { guestSessionId, supabaseUrl, supabaseAnonKey, accessToken, remote, reason } = msg;
        if (!guestSessionId) return;

        _guestSessionId = guestSessionId;
        _supabaseUrl = supabaseUrl || null;
        _supabaseAnonKey = supabaseAnonKey || null;
        _accessToken = accessToken || null;
        _remote = remote === true && !!accessToken;

        if (!_remote) {
          // Say so once, with the page's own reason. Silence here is what made
          // the previous 403s invisible.
          console.warn(
            `[SafeTest Bridge] Local-only session (${reason || 'no access token'}) — ` +
            `snapshots will be relayed to the page but NOT uploaded.`
          );
        }

        safeStorageSet({
          guestMode: true,
          guestSessionId,
          proctoringActive: true,
          userRole: 'student',
          studentName: 'Guest Visitor',
          studentId: guestSessionId,
          sessionCode: 'GUEST-DEMO',
          // Fresh baseline for THIS visit. The key is persistent and sticky by
          // design (lms_detector.js adopts an existing stamp so a paginated quiz
          // keeps one baseline across reloads), which meant a returning demo
          // visitor was measured against whenever they first came — and got
          // "LATE PROCTORING DETECTED" for it. monitor.js re-stamps this for
          // guest sessions too; writing it here as well means no stale value
          // exists even briefly, whichever side reads first.
          quizOpenedAtIso: new Date().toISOString(),
        });

        try {
          safeSendMessage({
            type: 'GUEST_MODE_STARTED',
            data: { guestSessionId },
          });
        } catch (e) { /* extension context may be invalidated */ }

        console.log(`[SafeTest Bridge] Guest quiz started: ${guestSessionId}`);
        break;
      }

      case 'SAFETEST_STOP_GUEST_QUIZ':
        _guestSessionId = null;
        _supabaseUrl = null;
        _supabaseAnonKey = null;
        _accessToken = null;
        _remote = false;
        // ⚠ `proctoringActive` MUST BE CLEARED HERE TOO.
        //
        // monitor.js's storage listener branches on `proctoringActive ||
        // guestMode`. Clearing only guestMode left proctoringActive true, so the
        // listener took the START branch on a STOP — stopProctoring() was never
        // reached by the page's own stop signal, and the camera stayed live
        // until the 1.5 s navigation-watch poll happened to notice a URL change.
        // A visitor who left /demo-quiz kept a running webcam and a 20 FPS
        // inference loop in the meantime, and one who stopped WITHOUT navigating
        // kept them indefinitely.
        //
        // Clearing both also leaves storage clean for the next entry, so
        // re-entering /demo-quiz starts from a known state rather than
        // inheriting a half-torn-down one.
        safeStorageSet({
          guestMode: false,
          guestSessionId: null,
          proctoringActive: false,
        });
        try {
          safeSendMessage({ type: 'GUEST_MODE_STOPPED' });
        } catch (e) {}
        break;
    }
  });

  // ─── Inbound from background worker (violation relay) ──────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GUEST_VIOLATION_RELAY' && _guestSessionId) {
      const payload = msg.payload;

      // Upload snapshot to Supabase if we hold a real authenticated session.
      const snapshotUrl = null;
      if (_remote && payload.snapshot_b64) {
        // Fire-and-forget upload; post the event immediately with snapshotUrl = null,
        // then post an update when the URL is available.
        _uploadGuestSnapshot(payload).then((url) => {
          if (url) {
            window.postMessage({
              type: 'SAFETEST_GUEST_SNAPSHOT_URL',
              guestSessionId: _guestSessionId,
              violationId: payload.violation_id,
              snapshotUrl: url,
            }, '*');
          }
        }).catch((err) => {
          // ⚠ NEVER SWALLOW THIS AGAIN. The previous empty catch is why every
          // upload could 403 for the entire life of the feature while the UI
          // looked completely healthy — a violation card would appear, its
          // image would just never resolve, and nothing said why.
          window.postMessage({
            type: 'SAFETEST_GUEST_UPLOAD_FAILED',
            guestSessionId: _guestSessionId,
            violationId: payload.violation_id,
            reason: err && err.message ? err.message : 'UPLOAD_FAILED',
          }, '*');
        });
      }

      window.postMessage({
        type: 'SAFETEST_GUEST_VIOLATION',
        guestSessionId: _guestSessionId,
        violationType: payload.violation_type,
        severity: payload.severity,
        ear: payload.ear ?? null,
        snapshotUrl, // null initially; URL follows via SAFETEST_GUEST_SNAPSHOT_URL
        snapshotB64: payload.snapshot_b64 || null,
        tMs: payload.timestamp || Date.now(),
        violationId: payload.violation_id,
      }, '*');

      sendResponse({ ok: true });
    }
  });

  // ─── Supabase snapshot upload (thin, no SDK) ───────────────────────────────

  /**
   * ⚠ THE BEARER TOKEN IS THE USER JWT, NOT THE ANON KEY.
   *
   * `demo_snapshots_insert_own` is granted `to authenticated` and requires
   * `(storage.foldername(name))[2] = auth.uid()::text`. Sending the anon key as
   * the bearer makes the request `anon`, for which the migration deliberately
   * defines no policy at all — so it 403s regardless of the path. Both halves
   * have to be right: an authenticated token AND a folder equal to that token's
   * own uid, which is why `_guestSessionId` is now the page's `auth.uid()`
   * rather than a UUID the page invented.
   *
   * `apikey` still carries the anon key — Supabase requires it on every REST
   * call for routing; it is not what authorises the write.
   */
  async function _uploadGuestSnapshot(payload) {
    if (!_remote || !_supabaseUrl || !_accessToken || !payload.snapshot_b64) return null;

    const base64Data = payload.snapshot_b64.replace(/^data:image\/\w+;base64,/, '');
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/jpeg' });

    const filename = `${payload.violation_id || Date.now()}.jpg`.replace(/[^A-Za-z0-9._-]/g, '-');
    const path = `demo/${_guestSessionId}/${filename}`;

    const authHeaders = {
      'Authorization': `Bearer ${_accessToken}`,
      'apikey': _supabaseAnonKey || '',
    };

    const response = await fetch(
      `${_supabaseUrl}/storage/v1/object/demo-snapshots/${path}`,
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
        body: blob,
      }
    );

    if (!response.ok) {
      // Surfaced with the status, because 403 (policy) and 404 (bucket missing)
      // and 413 (over the 2 MiB limit) need three different fixes.
      const body = await response.text().catch(() => '');
      throw new Error(`storage upload HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }

    // ⚠ A PUBLIC URL WOULD BE A DEAD LINK. The bucket is created with
    // `public = false` on purpose — these are webcam face crops of a real
    // visitor. `/object/public/...` therefore 400s, so the previous return value
    // was a URL that could never load. Sign it instead; the signature is scoped
    // to this object and expires.
    const signed = await fetch(
      `${_supabaseUrl}/storage/v1/object/sign/demo-snapshots/${path}`,
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 3600 }),
      }
    );

    if (!signed.ok) return null;   // uploaded fine; just no viewable link
    const { signedURL } = await signed.json();
    return signedURL ? `${_supabaseUrl}/storage/v1${signedURL}` : null;
  }

  console.log('[SafeTest Bridge] Guest bridge loaded.');
})();
