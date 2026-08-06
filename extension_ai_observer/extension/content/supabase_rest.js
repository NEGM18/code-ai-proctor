// =============================================================================
// supabase_rest.js — the extension's entire Supabase surface, as thin fetch.
//
// WHY NO SDK. MV3's CSP forbids remote scripts, and bundling
// @supabase/supabase-js into a content script drags a large dependency into a
// world that already hosts onnxruntime. `guest_bridge.js` already proved raw
// REST works here. Every call below is one fetch against a documented endpoint.
//
// ⚠ THIS FILE RUNS IN TWO SEPARATE JAVASCRIPT WORLDS.
//   1. The content-script world, loaded from manifest.json before monitor.js.
//   2. The POPUP page, loaded by a <script> tag in popup.html before popup.js.
// They share no globals with each other, which is exactly why the credentials
// and the token plumbing live in one file instead of being duplicated. Anything
// added here must be inert at load time — `vision_integration.test.js` executes
// manifest scripts in a bare fake-window context, so touching `chrome.*` or
// `fetch` at module scope would break the suite.
// =============================================================================

(function safeTestSupabaseRest() {
  'use strict';

  // ---------------------------------------------------------------------------
  // Credentials.
  //
  // ⚠ THE PUBLISHABLE KEY IS MEANT TO BE PUBLIC — it ships in every web client
  // on earth and carries no authority of its own; RLS is what protects the
  // data. What must NEVER appear here is the service-role key, which bypasses
  // RLS entirely.
  //
  // ⚠ AND THE URL IS A BUILD CONSTANT, NOT USER INPUT. popup.html used to carry
  // a free-text "Server URL" box. On a form that also collects a password, that
  // is a credential-harvesting surface: anyone who can talk a student into
  // pasting a different host collects their login. It is gone.
  // ---------------------------------------------------------------------------
  const DEFAULTS = {
    url: 'https://xokefpfhwcxuvjmxfzke.supabase.co',
    anonKey: 'sb_publishable_NT2huOBy2yDrIdcV39YT7A_TS-IPjhl',
  };

  let _url = DEFAULTS.url;
  let _anonKey = DEFAULTS.anonKey;
  let _accessToken = null;
  let _refreshToken = null;
  let _userId = null;

  /** Network ceiling. Same reasoning as secure_loader.js: fetch has no default
   *  timeout, and a hung host must not stall a proctoring tick forever. */
  const TIMEOUT_MS = 10000;

  const REASON = {
    UNREACHABLE: 'SUPABASE_UNREACHABLE',
    NO_SESSION: 'NO_SESSION',
    BAD_CREDENTIALS: 'BAD_CREDENTIALS',
    HTTP: 'SUPABASE_HTTP_ERROR',
  };

  function _headers(extra) {
    const h = { apikey: _anonKey, ...(extra || {}) };
    // The bearer is the USER's token when we have one. Falling back to the anon
    // key is not a convenience — it changes the Postgres role from
    // `authenticated` to `anon`, and every RLS policy on violations and
    // proctor_sessions is written `to authenticated`. A request that quietly
    // degrades to anon does not fail loudly, it just writes nothing.
    h.Authorization = `Bearer ${_accessToken || _anonKey}`;
    return h;
  }

  async function _fetch(path, options, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs || TIMEOUT_MS);
    try {
      return await fetch(`${_url}${path}`, { ...options, signal: controller.signal });
    } catch (err) {
      const e = new Error(timedOut ? 'request timed out' : 'connection failed');
      e.reason = REASON.UNREACHABLE;
      e.cause = err;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * ⚠ REFRESH-ON-401 IS NOT OPTIONAL HERE.
   *
   * A Supabase access token lives about an hour. Exams do not. Without this, a
   * two-hour sitting records violations perfectly for the first hour and then
   * silently records NOTHING — the writes 401, the catch queues them offline,
   * the queue drains into more 401s, and the session ends with a clean-looking
   * UI and a half-empty evidence table. That is precisely the class of quiet
   * failure this codebase exists to refuse.
   *
   * One retry only. If the refresh itself fails the session is genuinely gone,
   * and looping would turn a dead token into a request storm.
   */
  async function _authed(path, options) {
    let response = await _fetch(path, { ...options, headers: _headers(options.headers) });
    if (response.status !== 401 || !_refreshToken) return response;

    const refreshed = await _refresh();
    if (!refreshed.ok) return response;   // hand back the original 401

    response = await _fetch(path, { ...options, headers: _headers(options.headers) });
    return response;
  }

  async function _refresh() {
    try {
      const res = await _fetch('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: _anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: _refreshToken }),
      });
      if (!res.ok) return { ok: false };
      const data = await res.json();
      if (!data.access_token) return { ok: false };
      _accessToken = data.access_token;
      _refreshToken = data.refresh_token || _refreshToken;
      _persist();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /** Best-effort token persistence. Guarded: the popup, the content script and
   *  the test harness do not all have chrome.storage. */
  function _persist() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          sbAccessToken: _accessToken,
          sbRefreshToken: _refreshToken,
          sbUserId: _userId,
        });
      }
    } catch { /* context invalidated */ }
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------
  const api = {
    REASON,

    /** Point at a different project (self-hosted / staging). */
    configure(opts) {
      if (opts && opts.url) _url = String(opts.url).replace(/\/+$/, '');
      if (opts && opts.anonKey) _anonKey = opts.anonKey;
    },

    /** Rehydrate from chrome.storage without a network round trip. */
    restoreSession(stored) {
      if (!stored) return false;
      _accessToken = stored.sbAccessToken || null;
      _refreshToken = stored.sbRefreshToken || null;
      _userId = stored.sbUserId || null;
      return !!_accessToken;
    },

    clearSession() {
      _accessToken = null;
      _refreshToken = null;
      _userId = null;
      _persist();
    },

    get userId() { return _userId; },
    get signedIn() { return !!_accessToken; },

    /**
     * Password sign-in against Supabase Auth.
     *
     * ⚠ THIS IS THE WHOLE POINT OF THE MIGRATION. The old
     * `POST /api/student/login` minted its own notion of a student, so an
     * account created on the teacher website and a login in the extension were
     * two unrelated records that merely looked alike. Both sides now resolve to
     * the same `auth.users.id` — the id `public.profiles` hangs off, and the id
     * every RLS policy compares against.
     *
     * @returns {Promise<{ok:boolean, reason:string|null, userId:string|null, error:unknown}>}
     */
    async signIn(email, password) {
      if (!email || !password) {
        return { ok: false, reason: REASON.BAD_CREDENTIALS, userId: null, error: null };
      }
      try {
        const res = await _fetch('/auth/v1/token?grant_type=password', {
          method: 'POST',
          headers: { apikey: _anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) {
          // Supabase's own message ("Invalid login credentials") beats anything
          // we could invent, and distinguishing it from "server down" matters:
          // the two fixes are completely different.
          return {
            ok: false,
            reason: REASON.BAD_CREDENTIALS,
            userId: null,
            error: data.error_description || data.msg || data.error || null,
          };
        }
        _accessToken = data.access_token;
        _refreshToken = data.refresh_token || null;
        _userId = data.user && data.user.id ? data.user.id : null;
        _persist();
        return { ok: true, reason: null, userId: _userId, error: null };
      } catch (err) {
        return { ok: false, reason: err.reason || REASON.UNREACHABLE, userId: null, error: err };
      }
    },

    /** The signed-in user's profile row (full_name / role), or null. */
    async fetchProfile() {
      if (!_accessToken || !_userId) return null;
      try {
        const res = await _authed(
          `/rest/v1/profiles?id=eq.${encodeURIComponent(_userId)}&select=full_name,role`,
          { method: 'GET' }
        );
        if (!res.ok) return null;
        const rows = await res.json();
        return Array.isArray(rows) && rows.length ? rows[0] : null;
      } catch {
        return null;
      }
    },

    /**
     * Look up a ProctorCode's policy before the sitting starts.
     *
     * ⚠ THE ANSWER IS `null` FOR BOTH "no such code" AND "could not ask".
     * The caller must not treat a null as "no student ID required" — that would
     * let a network blip silently drop a field the institution requires. The two
     * are distinguished by `ok`: a definite miss is `{ok:true, code:null}`, an
     * unreachable server is `{ok:false}`.
     *
     * @returns {Promise<{ok:boolean, code:object|null, reason:string|null}>}
     */
    async fetchProctorCode(code) {
      if (!code) return { ok: true, code: null, reason: null };
      if (!_accessToken) return { ok: false, code: null, reason: REASON.NO_SESSION };
      try {
        const res = await _authed(
          `/rest/v1/proctor_codes?code=eq.${encodeURIComponent(code)}`
          + '&select=code,max_students,require_student_id',
          { method: 'GET' }
        );
        if (!res.ok) return { ok: false, code: null, reason: REASON.HTTP };
        const rows = await res.json();
        return {
          ok: true,
          code: Array.isArray(rows) && rows.length ? rows[0] : null,
          reason: null,
        };
      } catch (err) {
        return { ok: false, code: null, reason: err.reason || REASON.UNREACHABLE };
      }
    },

    /**
     * Open a proctoring session. Replaces POST /api/proctor/sessions/join.
     * @returns {Promise<{ok:boolean, id:string|null, reason:string|null}>}
     */
    async startSession(fields) {
      if (!_accessToken || !_userId) return { ok: false, id: null, reason: REASON.NO_SESSION };
      try {
        const res = await _authed('/rest/v1/proctor_sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({
            session_code: fields.sessionCode,
            student_id: _userId,
            full_name: fields.fullName || null,
            timing_status: fields.timingStatus || null,
            quiz_opened_at: fields.quizOpenedAt || null,
            proctor_started_at: fields.proctorStartedAt || null,
            lighting: fields.lighting || null,
            // ⚠ A LABEL, NOT AN IDENTITY. student_id (the uuid above) is what
            // RLS compares against; this is the institution's own number and is
            // never used for authorisation.
            student_university_id: fields.studentUniversityId || null,
          }),
        });
        if (!res.ok) return { ok: false, id: null, reason: REASON.HTTP };
        const rows = await res.json();
        const id = Array.isArray(rows) && rows.length ? rows[0].id : null;
        return { ok: !!id, id, reason: null };
      } catch (err) {
        return { ok: false, id: null, reason: err.reason || REASON.UNREACHABLE };
      }
    },

    /** Replaces POST /api/proctor/heartbeat. */
    async heartbeat(sessionId, timingStatus) {
      if (!_accessToken || !sessionId) return { ok: false, reason: REASON.NO_SESSION };
      try {
        const res = await _authed(`/rest/v1/proctor_sessions?id=eq.${encodeURIComponent(sessionId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({
            last_heartbeat_at: new Date().toISOString(),
            timing_status: timingStatus || null,
          }),
        });
        return { ok: res.ok, reason: res.ok ? null : REASON.HTTP };
      } catch (err) {
        return { ok: false, reason: err.reason || REASON.UNREACHABLE };
      }
    },

    /**
     * Close a session. Replaces POST /api/proctor/sessions/end.
     *
     * ⚠ `keepalive: true`, NOT `navigator.sendBeacon`.
     *
     * The old code used sendBeacon, which is the right tool for a fire-and-
     * forget POST during unload — except that it CANNOT SET HEADERS. PostgREST
     * requires `apikey` and `Authorization` on every request, so a beacon-based
     * port would have 401'd on every single session end, during unload, where
     * nobody would ever see the failure. `fetch(..., {keepalive:true})` survives
     * unload the same way and carries headers. Its 64 KB body cap is irrelevant
     * for this payload.
     */
    async endSession(sessionId, fields) {
      if (!_accessToken || !sessionId) return { ok: false, reason: REASON.NO_SESSION };
      try {
        const res = await fetch(
          `${_url}/rest/v1/proctor_sessions?id=eq.${encodeURIComponent(sessionId)}`,
          {
            method: 'PATCH',
            headers: { ..._headers({ 'Content-Type': 'application/json' }), Prefer: 'return=minimal' },
            body: JSON.stringify({
              ended_at: fields && fields.endedAt ? fields.endedAt : new Date().toISOString(),
            }),
            keepalive: true,
          }
        );
        return { ok: res.ok, reason: res.ok ? null : REASON.HTTP };
      } catch (err) {
        return { ok: false, reason: REASON.UNREACHABLE, error: err };
      }
    },

    /**
     * Record one violation. Replaces POST /api/proctor/incident.
     *
     * ⚠ `snapshot_path` IS DELIBERATELY LEFT NULL FOR NOW, AND THAT IS A GAP,
     * NOT A DESIGN. There is exactly one storage bucket in this project —
     * `demo-snapshots` — and it is scoped to `demo/{auth.uid()}/`, capped at
     * 2 MiB, documented as ephemeral marketing-demo evidence, and WIPED by
     * `clearDemoSessionData()` when the demo modal closes. Writing real exam
     * evidence there would mean the marketing demo deletes proctoring records.
     * Real sessions need their own bucket and policies; until that exists the
     * row is written without an image rather than with one that will vanish.
     *
     * @returns {Promise<{ok:boolean, reason:string|null}>}
     */
    async insertViolation(fields) {
      if (!_accessToken || !_userId) return { ok: false, reason: REASON.NO_SESSION };
      try {
        const res = await _authed('/rest/v1/violations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({
            session_id: fields.sessionId || null,
            student_id: _userId,
            violation_type: fields.violationType,
            severity: fields.severity || null,
            // ⚠ NULL, never 0. A non-finite EAR means the veto had no fresh
            // sample and failed open; writing 0 would record "eyes shut" as a
            // measured fact about a frame nobody could read.
            ear: Number.isFinite(fields.ear) ? fields.ear : null,
            ear_checked: fields.earChecked || null,
            cheat_probability: Number.isFinite(fields.cheatProbability)
              ? fields.cheatProbability : null,
            cheat_reason: fields.cheatReason || null,
            snapshot_path: null,
          }),
        });
        return { ok: res.ok, reason: res.ok ? null : REASON.HTTP };
      } catch (err) {
        return { ok: false, reason: err.reason || REASON.UNREACHABLE };
      }
    },
  };

  if (typeof window !== 'undefined') window.SafeTestSupabase = api;
})();
