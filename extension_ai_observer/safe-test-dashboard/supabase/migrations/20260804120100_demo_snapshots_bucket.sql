-- =============================================================================
-- 20260804120100_demo_snapshots_bucket.sql
--
-- safetest.space — ephemeral storage bucket for the live browser demo's
-- violation-evidence snapshots (webcam face crops), scoped to
-- demo/{session_id}/*.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The bucket — PRIVATE.
--
-- These are webcam face snapshots taken during the marketing-site demo. That
-- is biometric imagery of a real visitor's face, even though the exam itself
-- is fake. `public = false` is not a default here, it's the whole point:
-- objects are only reachable through the anon/authenticated client with a
-- valid session, never via a bare public URL. size/type limits below exist
-- so the bucket cannot be used as free-form file storage for anything other
-- than the small JPEG/WEBP/PNG evidence crops `snapshot.js` produces.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'demo-snapshots',
  'demo-snapshots',
  false,
  2097152, -- 2 MiB — generous for a single downscaled evidence JPEG
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- -----------------------------------------------------------------------------
-- 2. Access model — ⚠ READ THIS BEFORE CHANGING THE POLICIES BELOW.
--
-- The demo has no real login: a first-time visitor is not a `student` /
-- `teacher` / `organization` account. So "scoped to demo/{session_id}/" is
-- enforced by binding session_id to a real Supabase Auth identity via
-- ANONYMOUS SIGN-IN (`supabase.auth.signInAnonymously()`), not by parsing
-- the path alone.
--
-- Why not just check that the path starts with `demo/`? Because Postgres RLS
-- has no concept of "the specific session_id this particular HTTP request
-- claims to own" — a policy that only requires `(storage.foldername(name))[1]
-- = 'demo'` would let ANY anonymous caller `list('demo')` and enumerate
-- every visitor's session folder and every face snapshot ever uploaded by
-- anyone, forever. For face imagery that is not an acceptable trade even for
-- a marketing demo, so the policy instead requires the second path segment
-- to equal the caller's own `auth.uid()`:
--
--     demo/{auth.uid()}/{filename}
--
-- `src/lib/demoSnapshots.js` (owned by this agent) is responsible for
-- resolving `session_id` to `auth.uid()` via `ensureDemoSession()` before
-- any upload, and for treating a failed/disabled anonymous sign-in as an
-- explicit local-only no-op rather than silently writing to some other path.
--
-- ⚠ OPERATOR ACTION REQUIRED: Authentication → Providers → enable "Allow
-- anonymous sign-ins" in the Supabase dashboard. Without it,
-- `signInAnonymously()` errors, uploads never happen, and the UI shows the
-- "local only — not uploaded" chip — which is the correct degraded state,
-- not a bug, but it does mean the cloud-upload half of the demo is inert
-- until that toggle is flipped.
-- -----------------------------------------------------------------------------

drop policy if exists "demo_snapshots_insert_own" on storage.objects;
create policy "demo_snapshots_insert_own"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'demo-snapshots'
    and (storage.foldername(name))[1] = 'demo'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

drop policy if exists "demo_snapshots_select_own" on storage.objects;
create policy "demo_snapshots_select_own"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'demo-snapshots'
    and (storage.foldername(name))[1] = 'demo'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- UPDATE is required because the client uploads with `{ upsert: true }`
-- (a retried/duplicate snapshot write is an UPDATE, not a fresh INSERT).
drop policy if exists "demo_snapshots_update_own" on storage.objects;
create policy "demo_snapshots_update_own"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'demo-snapshots'
    and (storage.foldername(name))[1] = 'demo'
    and (storage.foldername(name))[2] = auth.uid()::text
  )
  with check (
    bucket_id = 'demo-snapshots'
    and (storage.foldername(name))[1] = 'demo'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- DELETE — required by clearDemoSessionData(), called on demo reset, modal
-- close and (best-effort) beforeunload. A visitor may only delete their own
-- session's objects, same scoping as above.
drop policy if exists "demo_snapshots_delete_own" on storage.objects;
create policy "demo_snapshots_delete_own"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'demo-snapshots'
    and (storage.foldername(name))[1] = 'demo'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- No policy at all for the `anon` role: every operation above requires
-- `to authenticated`, which an anonymous-sign-in session satisfies (Supabase
-- issues a real JWT with `role: authenticated` and a stable `auth.uid()` for
-- anonymous users) but an unauthenticated request does not. This closes the
-- gap a path-only policy would have left open.
