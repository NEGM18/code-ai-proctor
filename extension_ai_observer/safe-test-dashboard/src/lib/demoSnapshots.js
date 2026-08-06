// =============================================================================
// src/lib/demoSnapshots.js
//
// Uploading (optional) and clearing the live demo's evidence snapshots in
// Supabase Storage, scoped to `demo/{session_id}/` per
// supabase/migrations/20260804120100_demo_snapshots_bucket.sql.
//
// GOVERNING RULE (PLAN.md §7): when Supabase is unconfigured, every function
// here is an explicit no-op — it returns a result object saying exactly
// that, never a bare `true`/success that a component would have to assume
// meant "uploaded". Components render the "local only — not uploaded" chip
// straight off `result.uploaded === false && result.reason` — see the shape
// notes on `uploadDemoSnapshot` below.
// =============================================================================

import { supabase, isSupabaseConfigured, SUPABASE_UNCONFIGURED_REASON, DEMO_SNAPSHOTS_BUCKET } from './supabase.js'

export const SNAPSHOT_UPLOAD_REASON = Object.freeze({
  SUPABASE_UNCONFIGURED: SUPABASE_UNCONFIGURED_REASON,
  ANONYMOUS_AUTH_FAILED: 'ANONYMOUS_AUTH_FAILED',
  NO_IMAGE_DATA: 'NO_IMAGE_DATA',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
})

function randomUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for an environment without crypto.randomUUID (older Safari,
  // some SSR contexts). Not cryptographically strong, but this ID only ever
  // labels a purely-local, never-uploaded demo session, so that's fine here
  // and nowhere else in this file.
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Resolves a usable session identifier for the demo.
 *
 * - Supabase unconfigured -> a local-only random id. `remote: false`.
 * - Supabase configured -> reuses an existing Supabase Auth session if one
 *   exists (real sign-up/sign-in OR a prior anonymous sign-in), otherwise
 *   calls `signInAnonymously()`. The bucket's RLS policies key off
 *   `auth.uid()`, not an arbitrary client-supplied string (see the
 *   migration's "Access model" comment for why), so `sessionId` for a
 *   *remote* session IS the caller's `auth.uid()` — the upload path is
 *   `demo/{auth.uid()}/...`.
 * - Supabase configured but anonymous sign-in fails or is disabled on the
 *   project -> falls back to a local-only id, `remote: false`, with
 *   `reason: 'ANONYMOUS_AUTH_FAILED'`. This is the explicit-no-op path for
 *   "we tried, it didn't work" rather than silently pretending success.
 *
 * @param {string | null | undefined} existingSessionId Reuse this local id
 *   if falling back to local-only and no better id is available.
 * @returns {Promise<{ ok: boolean, remote: boolean, sessionId: string, reason: string | null, error: unknown }>}
 */
export async function ensureDemoSession(existingSessionId) {
  if (!isSupabaseConfigured || !supabase) {
    return {
      ok: true,
      remote: false,
      sessionId: existingSessionId || randomUuid(),
      reason: SNAPSHOT_UPLOAD_REASON.SUPABASE_UNCONFIGURED,
      error: null,
    }
  }

  try {
    const { data: sessionData } = await supabase.auth.getSession()
    const existingUserId = sessionData?.session?.user?.id
    if (existingUserId) {
      return { ok: true, remote: true, sessionId: existingUserId, reason: null, error: null }
    }

    const { data, error } = await supabase.auth.signInAnonymously()
    const userId = data?.user?.id
    if (error || !userId) {
      return {
        ok: false,
        remote: false,
        sessionId: existingSessionId || randomUuid(),
        reason: SNAPSHOT_UPLOAD_REASON.ANONYMOUS_AUTH_FAILED,
        error: error ?? null,
      }
    }
    return { ok: true, remote: true, sessionId: userId, reason: null, error: null }
  } catch (error) {
    return {
      ok: false,
      remote: false,
      sessionId: existingSessionId || randomUuid(),
      reason: SNAPSHOT_UPLOAD_REASON.ANONYMOUS_AUTH_FAILED,
      error,
    }
  }
}

/**
 * @param {string} dataUrl
 * @returns {Blob}
 */
function dataUrlToBlob(dataUrl) {
  const commaIndex = dataUrl.indexOf(',')
  const header = dataUrl.slice(0, commaIndex)
  const base64 = dataUrl.slice(commaIndex + 1)
  const mimeMatch = /data:(.*?);base64/.exec(header)
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg'
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mime })
}

const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/

/**
 * Uploads one evidence snapshot. Returns an explicit, inspectable result —
 * this is the shape a component checks to render the
 * "local only — not uploaded" chip:
 *
 *   const result = await uploadDemoSnapshot({ sessionId, dataUrl, filename })
 *   if (!result.uploaded) {
 *     // result.reason is one of SNAPSHOT_UPLOAD_REASON.* — always render
 *     // the chip here, do not treat "no error thrown" as success.
 *   }
 *
 * No network call is made at all when Supabase is unconfigured — this is
 * checked first and returns synchronously-resolved, before touching
 * `ensureDemoSession()` or any image encoding.
 *
 * @param {{ sessionId?: string | null, filename?: string, dataUrl?: string, blob?: Blob, contentType?: string }} params
 * @returns {Promise<{ ok: boolean, uploaded: boolean, reason: string | null, sessionId: string | null, path: string | null, error: unknown }>}
 */
export async function uploadDemoSnapshot({ sessionId, filename, dataUrl, blob, contentType } = {}) {
  if (!isSupabaseConfigured || !supabase) {
    return {
      ok: false,
      uploaded: false,
      reason: SNAPSHOT_UPLOAD_REASON.SUPABASE_UNCONFIGURED,
      sessionId: sessionId ?? null,
      path: null,
      error: null,
    }
  }
  if (!dataUrl && !blob) {
    return {
      ok: false,
      uploaded: false,
      reason: SNAPSHOT_UPLOAD_REASON.NO_IMAGE_DATA,
      sessionId: sessionId ?? null,
      path: null,
      error: null,
    }
  }

  const resolvedSession = await ensureDemoSession(sessionId)
  if (!resolvedSession.remote) {
    return {
      ok: false,
      uploaded: false,
      reason: resolvedSession.reason ?? SNAPSHOT_UPLOAD_REASON.ANONYMOUS_AUTH_FAILED,
      sessionId: resolvedSession.sessionId,
      path: null,
      error: resolvedSession.error,
    }
  }

  const resolvedSessionId = resolvedSession.sessionId
  const body = blob ?? dataUrlToBlob(dataUrl)
  const safeFilename = filename && SAFE_FILENAME.test(filename) ? filename : `snapshot-${Date.now()}.jpg`
  const path = `demo/${resolvedSessionId}/${safeFilename}`

  const { error } = await supabase.storage.from(DEMO_SNAPSHOTS_BUCKET).upload(path, body, {
    contentType: contentType ?? body.type ?? 'image/jpeg',
    upsert: true,
  })

  if (error) {
    return {
      ok: false,
      uploaded: false,
      reason: SNAPSHOT_UPLOAD_REASON.UPLOAD_FAILED,
      sessionId: resolvedSessionId,
      path,
      error,
    }
  }

  return { ok: true, uploaded: true, reason: null, sessionId: resolvedSessionId, path, error: null }
}

const LIST_PAGE_SIZE = 100
const REMOVE_BATCH_SIZE = 100

/**
 * Lists and removes every object under `demo/{sessionId}/`, called on demo
 * reset, on modal close, and (best-effort — see note below) on
 * `beforeunload`.
 *
 * Pagination: `storage.list()` returns at most `LIST_PAGE_SIZE` entries per
 * call. A long demo session that has uploaded more snapshots than that
 * would silently leave the tail behind if this only listed once, so this
 * pages with `offset` until a short page (or an empty page) signals the
 * end.
 *
 * Partial failure: a `remove()` call can fail for one batch and succeed for
 * another (e.g. a transient network blip mid-cleanup). This does not abort
 * on the first failure — it keeps going through every batch so a temporary
 * failure on batch 2 of 5 doesn't strand batches 3–5. The result reports
 * `cleared` (how many were actually deleted), `total` (how many were
 * found), and `errors` (every failure, with enough context to retry), so a
 * caller can tell "fully cleared" from "partially cleared" from "found
 * nothing" — never a bare boolean that hides which case occurred.
 *
 * @param {string | null | undefined} sessionId
 * @returns {Promise<{ ok: boolean, cleared: number, total: number, reason: string | null, errors: Array<Record<string, unknown>> }>}
 */
export async function clearDemoSessionData(sessionId) {
  if (!sessionId) {
    return { ok: false, cleared: 0, total: 0, reason: 'NO_SESSION_ID', errors: [] }
  }
  if (!isSupabaseConfigured || !supabase) {
    // Nothing was ever uploaded (uploadDemoSnapshot no-ops in this mode too),
    // so there is nothing to delete remotely. ok: true because the desired
    // end state — "no remote copies of this session's snapshots exist" — is
    // trivially already true, same reasoning as signOutCurrentUser().
    return { ok: true, cleared: 0, total: 0, reason: SUPABASE_UNCONFIGURED_REASON, errors: [] }
  }

  const prefix = `demo/${sessionId}`
  const paths = []
  const errors = []
  let offset = 0

  // Paginate until a short/empty page ends it; see the pagination note above.
  for (;;) {
    const { data, error } = await supabase.storage.from(DEMO_SNAPSHOTS_BUCKET).list(prefix, {
      limit: LIST_PAGE_SIZE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    })
    if (error) {
      errors.push({ stage: 'list', offset, error })
      break
    }
    if (!data || data.length === 0) break
    for (const entry of data) {
      if (entry?.name) paths.push(`${prefix}/${entry.name}`)
    }
    if (data.length < LIST_PAGE_SIZE) break
    offset += LIST_PAGE_SIZE
  }

  if (paths.length === 0) {
    return { ok: errors.length === 0, cleared: 0, total: 0, reason: errors.length ? 'LIST_FAILED' : null, errors }
  }

  let cleared = 0
  for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
    const batch = paths.slice(i, i + REMOVE_BATCH_SIZE)
    const { data, error } = await supabase.storage.from(DEMO_SNAPSHOTS_BUCKET).remove(batch)
    if (error) {
      errors.push({ stage: 'remove', batch, error })
      continue // keep going — one bad batch must not strand the rest.
    }
    cleared += data ? data.length : batch.length
  }

  return {
    ok: errors.length === 0,
    cleared,
    total: paths.length,
    reason: errors.length ? 'PARTIAL_FAILURE' : null,
    errors,
  }
}

/**
 * Best-effort cleanup on tab close. `beforeunload` handlers CANNOT `await` —
 * the page may already be torn down by the time any awaited promise
 * resumes, and browsers do not guarantee in-flight `fetch` calls (which is
 * what supabase-js's storage client uses under the hood, without
 * `keepalive`) complete after the handler returns. This is intentionally
 * fire-and-forget: it starts `clearDemoSessionData` and does not, cannot,
 * and must not pretend to wait for it. Treat this path as "usually helps,
 * never guaranteed" — the authoritative cleanup call sites are demo reset
 * and modal close, both of which CAN and DO await the real result.
 *
 * @param {string | null | undefined} sessionId
 * @returns {() => void} unsubscribe function
 */
export function registerDemoCleanupOnUnload(sessionId) {
  if (typeof window === 'undefined' || !sessionId) {
    return () => {}
  }
  const handler = () => {
    // Deliberately not awaited — see the doc comment above.
    void clearDemoSessionData(sessionId)
  }
  window.addEventListener('beforeunload', handler)
  return () => window.removeEventListener('beforeunload', handler)
}
