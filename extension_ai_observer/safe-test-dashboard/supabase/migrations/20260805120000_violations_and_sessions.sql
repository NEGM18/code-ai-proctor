-- =============================================================================
-- 20260805120000_violations_and_sessions.sql
--
-- The tables the extension writes to once it stops POSTing at FastAPI:
--
--   /api/proctor/sessions/join,end  -> public.proctor_sessions
--   /api/proctor/heartbeat          -> public.proctor_sessions.last_heartbeat_at
--   /api/proctor/incident           -> public.violations
--
-- Columns are a TRANSCRIPTION of the payloads the extension already sends
-- (extension/content/monitor.js:593-600 and :1358-1370), not a redesign. Where
-- a name differs from the old JSON field it is because the old name encoded the
-- transport rather than the fact — `student_id_str` was a string because FastAPI
-- had no identity model; here it is a real foreign key.
--
-- Depends on 20260804120000_roles_and_profiles.sql (auth.users, profiles.role).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. proctor_sessions
-- -----------------------------------------------------------------------------
create table if not exists public.proctor_sessions (
  id                  uuid primary key default gen_random_uuid(),
  session_code        text not null,
  student_id          uuid not null references auth.users (id) on delete cascade,
  full_name           text,
  timing_status       text,
  quiz_opened_at      timestamptz,
  proctor_started_at  timestamptz,
  ended_at            timestamptz,
  last_heartbeat_at   timestamptz,
  lighting            jsonb,
  created_at          timestamptz not null default now()
);

comment on table public.proctor_sessions is
  'One row per proctored sitting. Written by the extension over PostgREST using the student''s own access token. student_id is the same auth.users id that public.profiles hangs off, which is precisely what makes an account created on the teacher website and a login in the extension the SAME identity — the property the FastAPI /api/student/login route could not provide.';

comment on column public.proctor_sessions.lighting is
  'Pre-exam lighting advisory snapshot. ADVISORY ONLY — it is not a violation, must never be reported as one, and is stored so a teacher reviewing a low-confidence session can see the room was flagged at setup.';

create index if not exists proctor_sessions_student_idx on public.proctor_sessions (student_id);
create index if not exists proctor_sessions_code_idx    on public.proctor_sessions (session_code);

alter table public.proctor_sessions enable row level security;

-- -----------------------------------------------------------------------------
-- 2. violations
-- -----------------------------------------------------------------------------
create table if not exists public.violations (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid references public.proctor_sessions (id) on delete cascade,
  student_id         uuid not null references auth.users (id) on delete cascade,
  violation_type     text not null,
  severity           text,
  ear                numeric,
  ear_checked        text,
  cheat_probability  numeric,
  cheat_reason       text,
  snapshot_path      text,
  created_at         timestamptz not null default now()
);

comment on column public.violations.ear is
  '⚠ NULLABLE ON PURPOSE. The eye-aspect-ratio the veto actually evaluated on the hit frame, or NULL when no fresh sample existed and the gate failed open. NULL means UNREADABLE and must render as a hatch or em-dash — never as 0, and never as the last known value.';

comment on column public.violations.ear_checked is
  'The gate''s own verdict string (EYES_OPEN / EYE_CLOSED / NOT_VETOABLE / STALE / NO_SAMPLE / ...). Kept alongside `ear` because "0.31, eyes open" and "0.31, this type is not vetoable" are different facts about how the report survived.';

comment on column public.violations.snapshot_path is
  'Object path inside the private demo-snapshots bucket. The image itself is never stored in this table.';

create index if not exists violations_student_idx on public.violations (student_id);
create index if not exists violations_session_idx on public.violations (session_id);
create index if not exists violations_created_idx on public.violations (created_at desc);

alter table public.violations enable row level security;

-- -----------------------------------------------------------------------------
-- 3. RLS — a student reaches only their own rows; staff read.
--
-- ⚠ THE STAFF PREDICATE READS public.profiles.role, WHICH IS NOT CLIENT-WRITABLE.
-- The roles migration sets `role` once at sign-up from raw_user_meta_data and
-- withholds the column-level UPDATE grant. That is the whole reason this policy
-- can trust it: if a student could rewrite their own role, this `in ('teacher',
-- 'organization')` check would be a self-service door into every other
-- student's violation history.
-- -----------------------------------------------------------------------------
drop policy if exists "proctor_sessions_own_rw" on public.proctor_sessions;
create policy "proctor_sessions_own_rw"
  on public.proctor_sessions
  for all
  to authenticated
  using (auth.uid() = student_id)
  with check (auth.uid() = student_id);

drop policy if exists "proctor_sessions_staff_read" on public.proctor_sessions;
create policy "proctor_sessions_staff_read"
  on public.proctor_sessions
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role::text in ('teacher', 'organization')
    )
  );

drop policy if exists "violations_own_rw" on public.violations;
create policy "violations_own_rw"
  on public.violations
  for all
  to authenticated
  using (auth.uid() = student_id)
  with check (auth.uid() = student_id);

drop policy if exists "violations_staff_read" on public.violations;
create policy "violations_staff_read"
  on public.violations
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role::text in ('teacher', 'organization')
    )
  );

-- -----------------------------------------------------------------------------
-- 4. connection_log — the live-connectivity probe.
--
-- SELECT is granted to `anon` so an unauthenticated page can prove it reached
-- the database through the PUBLIC API, which is the only thing that actually
-- demonstrates the website and extension can talk to Supabase. A management-
-- plane query proves the database is alive and nothing more.
--
-- There is deliberately NO insert/update/delete policy: writes require the
-- service role. This table can be read as a health signal but never used as
-- anonymous free-form storage.
-- -----------------------------------------------------------------------------
create table if not exists public.connection_log (
  test_id    text primary key,
  full_name  text,
  created_at timestamptz not null default now()
);

comment on table public.connection_log is
  'Connectivity probe. Rows are written by an operator via the service role and read by anyone, to distinguish "the database is unreachable" from "the client key is wrong" — two failures that otherwise present identically as an empty page.';

alter table public.connection_log enable row level security;

drop policy if exists "connection_log_read_all" on public.connection_log;
create policy "connection_log_read_all"
  on public.connection_log
  for select
  to anon, authenticated
  using (true);

-- -----------------------------------------------------------------------------
-- 5. Grants
-- -----------------------------------------------------------------------------
grant select on public.connection_log to anon, authenticated;
grant select, insert, update, delete on public.proctor_sessions to authenticated;
grant select, insert, update, delete on public.violations to authenticated;
