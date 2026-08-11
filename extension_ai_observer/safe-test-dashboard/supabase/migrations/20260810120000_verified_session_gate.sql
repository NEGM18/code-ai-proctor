-- =============================================================================
-- 20260810120000_verified_session_gate.sql
--
-- Closes the guest hole: the live demo, its evidence bucket and its violation
-- tables stop accepting ANY session that has not proved control of a real
-- mailbox — either through Google (OAuth) or through the 6-digit code we email
-- to the address behind an email+password sign-in.
--
-- ⚠ WHY `to authenticated` WAS NEVER THE GATE IT LOOKS LIKE.
--
-- Every policy shipped before this one is granted `to authenticated`, and the
-- demo-snapshots migration says so explicitly: an anonymous sign-in "satisfies"
-- it, because Supabase mints anonymous visitors a real JWT with
-- `role: authenticated` and a stable `auth.uid()`. `signInAnonymously()` in
-- src/lib/demoSnapshots.js was calling exactly that. So the entire evidence
-- path was open to anyone who loaded the page — which is the guest problem,
-- stated in SQL. `authenticated` means "holds a token", not "is a known
-- person"; only the two claims checked below can tell those apart.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The predicate
--
-- Three conditions, all required. Each rejects a different way of holding a
-- token without having proved anything:
--
--   a. `auth.uid()` present            -> not a bare anon-key request.
--   b. `is_anonymous` is not true      -> not signInAnonymously(). This claim
--                                         exists precisely to make anonymous
--                                         sessions distinguishable inside RLS;
--                                         without it (a) and (c) both pass for
--                                         a guest.
--   c. `amr` carries a mailbox-proving method.
--
-- ⚠ (c) IS THE ONE THAT ENFORCES THE SECOND FACTOR, AND IT IS WHY A BARE
-- PASSWORD SESSION IS REJECTED HERE. `amr` (Authentication Methods Reference)
-- lists how the CURRENT session was obtained. A session minted by
-- signInWithPassword() carries `password` and nothing else; the session minted
-- by verifyOtp() after the emailed code carries `otp`. So requiring one of
-- {otp, magiclink, oauth, sso/saml, totp, mfa/*} means the database itself
-- refuses the half-finished login — a client that skipped the code step, or a
-- stolen password replayed against the REST API directly, gets nothing.
-- Enforcing this only in React would leave the API open to anyone with curl.
--
-- `amr` survives token refresh (GoTrue copies it onto the refreshed token), so
-- a verified session stays verified for its natural life and is not silently
-- downgraded an hour in.
--
-- STABLE, not IMMUTABLE: it reads request-local settings via auth.jwt(), which
-- is constant within a statement but not across them.
-- -----------------------------------------------------------------------------

create or replace function public.session_is_verified_human()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select
    auth.uid() is not null
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) is not true
    and exists (
      select 1
      from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) as entry
      where entry ->> 'method' in ('otp', 'magiclink', 'oauth', 'sso/saml', 'totp')
         or entry ->> 'method' like 'mfa/%'
    );
$$;

comment on function public.session_is_verified_human() is
  'True only for a session that proved control of a real mailbox: Google/OAuth, '
  'or the emailed 6-digit code (amr method "otp"). Anonymous sessions and '
  'password-only sessions are both false. This is the single definition of '
  '"signed in" for the live demo — src/lib/auth/session.js mirrors it '
  'client-side and must be changed in step with it.';

grant execute on function public.session_is_verified_human() to authenticated, anon;

-- -----------------------------------------------------------------------------
-- 2. Belt and braces: turn anonymous sign-in off at the source.
--
-- The predicate above already rejects anonymous sessions, so this is redundant
-- by design — and worth having anyway, because the two failures look nothing
-- alike operationally. With the project setting on, a guest still gets a token,
-- still occupies an auth.users row, and only discovers the wall at the first
-- query. With it off, GoTrue refuses at /signup and no row is ever created.
--
-- ⚠ THIS CANNOT BE SET FROM SQL. It is a GoTrue setting, not a database one:
-- `enable_anonymous_sign_ins = false` in supabase/config.toml (already false
-- there) for local, and Dashboard -> Authentication -> Providers -> "Allow
-- anonymous sign-ins" OFF for the hosted project. Recorded here rather than in
-- a README because this migration is the thing that stops working correctly if
-- someone turns it back on and then wonders why guests can still reach a token.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 3. demo-snapshots storage policies
--
-- Same folder rule as before (`demo/{auth.uid()}/...`) with the verification
-- gate added. Dropped and recreated rather than altered: Postgres has no
-- `alter policy ... add using`, and a half-updated policy set would be worse
-- than a moment with none.
-- -----------------------------------------------------------------------------

drop policy if exists "demo_snapshots_insert_own" on storage.objects;
drop policy if exists "demo_snapshots_select_own" on storage.objects;
drop policy if exists "demo_snapshots_update_own" on storage.objects;
drop policy if exists "demo_snapshots_delete_own" on storage.objects;

create policy "demo_snapshots_insert_own"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'demo-snapshots'
    and public.session_is_verified_human()
    and (storage.foldername(name))[1] = 'demo'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

create policy "demo_snapshots_select_own"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'demo-snapshots'
    and public.session_is_verified_human()
    and (storage.foldername(name))[1] = 'demo'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

create policy "demo_snapshots_update_own"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'demo-snapshots'
    and public.session_is_verified_human()
    and (storage.foldername(name))[1] = 'demo'
    and (storage.foldername(name))[2] = auth.uid()::text
  )
  with check (
    bucket_id = 'demo-snapshots'
    and public.session_is_verified_human()
    and (storage.foldername(name))[1] = 'demo'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- ⚠ DELETE KEEPS THE GATE TOO, AND THAT IS A DELIBERATE TRADE.
--
-- The obvious argument for leaving DELETE open is cleanup: stopGuestQuiz()
-- deletes the visitor's own snapshots when they leave, and a session that
-- somehow uploaded but cannot delete would strand webcam crops in the bucket.
-- But nothing can now upload without passing the same gate, so the only caller
-- that ever has rows to delete is one that already passes it. Loosening DELETE
-- alone would buy no cleanup and would hand an unverified caller a way to
-- probe, and destroy, another session's evidence path.
create policy "demo_snapshots_delete_own"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'demo-snapshots'
    and public.session_is_verified_human()
    and (storage.foldername(name))[1] = 'demo'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- -----------------------------------------------------------------------------
-- 4. proctor_sessions / violations
--
-- The own-row write policies get the gate. The `..._staff_read` policies are
-- deliberately left exactly as they were: they already join through
-- public.profiles on a teacher/organization role, and re-deriving them here
-- would mean restating a privacy boundary this migration has no business
-- changing. Their read is scoped by role, not by the demo's front door.
-- -----------------------------------------------------------------------------

drop policy if exists "proctor_sessions_own_rw" on public.proctor_sessions;
create policy "proctor_sessions_own_rw"
  on public.proctor_sessions
  for all
  to authenticated
  using (auth.uid() = student_id and public.session_is_verified_human())
  with check (auth.uid() = student_id and public.session_is_verified_human());

drop policy if exists "violations_own_rw" on public.violations;
create policy "violations_own_rw"
  on public.violations
  for all
  to authenticated
  using (auth.uid() = student_id and public.session_is_verified_human())
  with check (auth.uid() = student_id and public.session_is_verified_human());

-- -----------------------------------------------------------------------------
-- 5. profiles: record how the account authenticates, for the UI only.
--
-- `auth_provider` lets the sign-in form tell a Google account from a password
-- account BEFORE asking for a password — so a visitor who signed up with
-- Google is sent back to Google instead of being told their password is wrong
-- for a password they never set.
--
-- ⚠ IT IS NOT A SECURITY FIELD AND MUST NEVER BE USED AS ONE. It is written by
-- the trigger from the identity provider, never by the client (there is no
-- update grant on it below), but the authorisation decision is
-- session_is_verified_human() reading the live JWT — never this column. A row
-- saying 'google' proves what happened at sign-up, not what is happening now.
-- -----------------------------------------------------------------------------

alter table public.profiles
  add column if not exists auth_provider text not null default 'email';

comment on column public.profiles.auth_provider is
  'Which identity provider created the account (''email'' or ''google''). '
  'UI hint only — never an authorisation input; see session_is_verified_human().';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name, organization_name, auth_provider)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'role', '')::public.role,
      'student'
    ),
    -- Google returns the display name as `full_name` on some flows and `name`
    -- on others; taking the first non-null keeps an OAuth profile from landing
    -- with a blank name that the user then cannot explain.
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    new.raw_user_meta_data ->> 'organization_name',
    coalesce(nullif(new.raw_app_meta_data ->> 'provider', ''), 'email')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Readable, not writable: same reasoning as `role` in the original migration.
revoke all on public.profiles from authenticated, anon;
grant select on public.profiles to authenticated;
grant update (full_name, organization_name) on public.profiles to authenticated;
