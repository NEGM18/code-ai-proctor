-- =============================================================================
-- 20260812130000_avatars_bucket.sql
--
-- Profile pictures: a dedicated `avatars` bucket, owner-scoped RLS, and the
-- `profiles.avatar_path` column that points into it.
--
-- ⚠ WHY A NEW BUCKET RATHER THAN A FOLDER IN `demo-snapshots`.
-- The first implementation wrote profile pictures to `demo-snapshots` at
-- `avatars/<uid>/profile.<ext>`. Every one of those uploads was rejected by
-- RLS and surfaced in the UI as a generic "Supabase error", because
-- `demo_snapshots_insert_own` requires `(storage.foldername(name))[1] = 'demo'`
-- and the avatar path's first folder is `avatars`. Widening that policy to
-- admit a second top-level folder is the wrong repair: `demo-snapshots` holds
-- webcam evidence frames, and its policy is deliberately a single exact-path
-- statement so that reading it tells you precisely what may be written there.
-- Two kinds of object with two different retention stories get two buckets.
--
-- ⚠ THE BUCKET IS PRIVATE, AND THE COLUMN STORES A PATH, NOT A URL.
-- A public bucket is the shorter road and it is the wrong one here: these are
-- photographs of students, and `public = true` makes every object readable
-- forever by anyone who ever sees the URL, with no revocation. Private + a
-- short-lived signed URL minted at read time keeps deletion meaningful.
-- Storing a *path* rather than a URL is what makes that possible — a signed
-- URL persisted in a row is a bearer token with an expiry date baked in, and
-- it starts returning 400 the moment it lapses.
--
-- ⚠ COLUMN-LEVEL GRANTS ARE LOAD-BEARING (see 20260804120000_roles_and_profiles).
-- `authenticated` holds UPDATE on `full_name` and `organization_name` only —
-- notably NOT on `role`, which is what stops a student promoting themselves to
-- teacher. RLS alone would not stop it; the grant does. A new column is
-- therefore invisible to the client until it is granted explicitly, so the
-- GRANT at the bottom of this file is not boilerplate: without it every
-- avatar_path write fails with "permission denied for table profiles".
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The bucket
-- ---------------------------------------------------------------------------
-- file_size_limit and allowed_mime_types are enforced by Storage itself, which
-- is what turns "a 40 MB HEIC" into a specific, reportable error instead of a
-- slow upload that fails opaquely at the end.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  false,
  5242880, -- 5 MiB
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2. Owner-scoped RLS
-- ---------------------------------------------------------------------------
-- Path contract: `<uid>/avatar.<ext>` — so `(storage.foldername(name))[1]` is
-- the owner's uid and the whole policy family is that one comparison. Every
-- policy re-states `bucket_id = 'avatars'`; without it these would apply to
-- objects in `demo-snapshots` too and quietly widen that bucket.

drop policy if exists avatars_select_own on storage.objects;
create policy avatars_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (auth.uid())::text
  );

drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (auth.uid())::text
  );

-- UPDATE needs both halves. `using` decides which existing rows are visible to
-- the statement; `with check` decides what they may become. Omitting the latter
-- would let a caller move their own object into someone else's folder.
drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (auth.uid())::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (auth.uid())::text
  );

drop policy if exists avatars_delete_own on storage.objects;
create policy avatars_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (auth.uid())::text
  );

-- ---------------------------------------------------------------------------
-- 3. The pointer column
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists avatar_path text;

comment on column public.profiles.avatar_path is
  'Object path inside the private `avatars` bucket, of the form <uid>/avatar.<ext>. NOT a URL: the client mints a short-lived signed URL from this at read time. NULL means "no uploaded picture" — the UI then falls back to the identity provider''s own photo, and past that to initials.';

-- Without these two the column is unreadable and unwritable from the browser,
-- and the failure reads as a table-level permission error that points nowhere
-- near this file. UPDATE is granted on avatar_path alone; `role` stays
-- ungranted, as above.
grant select (avatar_path) on public.profiles to authenticated;
grant update (avatar_path) on public.profiles to authenticated;
