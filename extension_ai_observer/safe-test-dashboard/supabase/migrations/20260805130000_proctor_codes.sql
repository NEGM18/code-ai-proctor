-- =============================================================================
-- 20260805130000_proctor_codes.sql
--
-- A ProctorCode is the join key a teacher hands out for a sitting. It carries
-- the policy for that sitting, so the extension can ask "does this exam require
-- a university ID?" BEFORE the student starts, rather than discovering it after.
--
-- Depends on 20260805120000_violations_and_sessions.sql (proctor_sessions).
-- =============================================================================

create table if not exists public.proctor_codes (
  code               text primary key,
  teacher_id         uuid not null references auth.users (id) on delete cascade,
  max_students       int  not null default 100,
  require_student_id boolean not null default false,
  created_at         timestamptz not null default now()
);

comment on table public.proctor_codes is
  'One row per proctored sitting a teacher opens. `code` is the string students type into the extension popup.';

comment on column public.proctor_codes.require_student_id is
  'When true the extension must collect the institution''s own student number before starting. It is a per-sitting policy rather than a global setting because institutions differ, and asking for an ID that will never be used is an unnecessary collection of identifying data.';

create index if not exists proctor_codes_teacher_idx on public.proctor_codes (teacher_id);

alter table public.proctor_codes enable row level security;

-- ⚠ ANY SIGNED-IN USER MAY READ A CODE'S POLICY, BUT ONLY ITS OWNER MAY WRITE IT.
--
-- The read has to be open to students: the extension looks the code up before a
-- proctor_sessions row exists, so there is nothing yet to scope the read
-- against. What that read exposes is deliberately minimal — how many seats the
-- sitting has and whether it wants a student number. No student list, no teacher
-- identity beyond an opaque uuid, and nothing about anyone else's session.
drop policy if exists "proctor_codes_read" on public.proctor_codes;
create policy "proctor_codes_read"
  on public.proctor_codes
  for select
  to authenticated
  using (true);

drop policy if exists "proctor_codes_owner_write" on public.proctor_codes;
create policy "proctor_codes_owner_write"
  on public.proctor_codes
  for all
  to authenticated
  using (auth.uid() = teacher_id)
  with check (auth.uid() = teacher_id);

-- ---------------------------------------------------------------------------
-- The institution's own student number, when the sitting asks for one.
--
-- ⚠ SEPARATE FROM student_id, AND NOT A SUBSTITUTE FOR IT. `student_id` is the
-- auth.users uuid and is what every RLS policy compares against. This column is
-- an opaque institutional string that we never validate. Conflating the two
-- would let a typo in a text box change which rows a student can reach.
-- ---------------------------------------------------------------------------
alter table public.proctor_sessions
  add column if not exists student_university_id text;

comment on column public.proctor_sessions.student_university_id is
  'The institution''s own student number, collected only when the sitting''s proctor_code has require_student_id = true. Never used for authorisation — student_id (uuid) is the identity; this is a label for the registrar.';

grant select on public.proctor_codes to authenticated;
grant insert, update, delete on public.proctor_codes to authenticated;
