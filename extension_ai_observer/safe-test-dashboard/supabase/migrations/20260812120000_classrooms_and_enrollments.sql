-- =============================================================================
-- 20260812120000_classrooms_and_enrollments.sql
--
-- The roster the student dashboard's "Classrooms" section needs. This is the
-- table 20260804120000_roles_and_profiles.sql explicitly deferred:
--
--   "There is no classroom/roster relationship table in this phase ... When a
--    roster/membership table ships, add a policy that JOINS through it ... not
--    a shortcut on `role` alone."
--
-- This is that table, and it keeps that instruction.
--
-- Depends on 20260804120000_roles_and_profiles.sql (profiles) and
-- 20260810120000_verified_session_gate.sql (session_is_verified_human).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. classrooms
--
-- ⚠ `teacher_name` IS DENORMALISED ON PURPOSE, AND IT IS THE ONLY WAY A STUDENT
-- CAN SEE WHO TEACHES THEM.
--
-- `profiles_select_own` restricts profile SELECT to `auth.uid() = id`, so a
-- student cannot read their teacher's profile row — deliberately, to stop any
-- account enumerating every user on the platform. A join to profiles for the
-- teacher's name would therefore return null, and the obvious "fix" (a policy
-- letting students read any profile they share a class with) widens that
-- boundary for one string.
--
-- Copying the name onto the classroom at creation time is the minimal
-- disclosure instead: the teacher publishes their own display name to their own
-- class, one column, chosen by them, and no other profile field becomes
-- reachable. The cost is that a teacher who renames themselves later must
-- update their classrooms; that is the right trade against widening a privacy
-- boundary permanently.
-- -----------------------------------------------------------------------------
create table if not exists public.classrooms (
  id               uuid primary key default gen_random_uuid(),
  join_code        text not null unique,
  name             text not null,
  subject          text,
  teacher_id       uuid not null references auth.users (id) on delete cascade,
  teacher_name     text,
  -- The proctor_codes.code for a sitting that is open right now, or NULL.
  active_exam_code text,
  created_at       timestamptz not null default now()
);

comment on column public.classrooms.teacher_name is
  'The teacher''s display name, copied at creation. Denormalised because profiles RLS is own-row only — read the block comment above this table before replacing it with a join.';

comment on column public.classrooms.active_exam_code is
  'proctor_codes.code for a currently-open sitting, or NULL. Drives the dashboard quick-launch button; NULL must render as "no exam scheduled", never as a button that looks disabled but works.';

create index if not exists classrooms_teacher_idx on public.classrooms (teacher_id);

alter table public.classrooms enable row level security;

-- -----------------------------------------------------------------------------
-- 2. enrollments
-- -----------------------------------------------------------------------------
create table if not exists public.enrollments (
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  student_id   uuid not null references auth.users (id) on delete cascade,
  joined_at    timestamptz not null default now(),
  primary key (classroom_id, student_id)
);

create index if not exists enrollments_student_idx on public.enrollments (student_id);

alter table public.enrollments enable row level security;

-- -----------------------------------------------------------------------------
-- 3. RLS
--
-- ⚠ THERE IS NO BLANKET SELECT ON classrooms, AND ADDING ONE WOULD MAKE THE
-- JOIN-BY-CODE RPC BELOW POINTLESS. `using (true)` — the shape proctor_codes
-- uses — would let any signed-in account list every class, every teacher name
-- and every join code on the platform. proctor_codes can afford that because a
-- code row exposes a seat count and a boolean; a classroom row exposes a named
-- person and a working join key.
-- -----------------------------------------------------------------------------

drop policy if exists "classrooms_visible_to_members" on public.classrooms;
create policy "classrooms_visible_to_members"
  on public.classrooms
  for select
  to authenticated
  using (
    auth.uid() = teacher_id
    or exists (
      select 1 from public.enrollments e
      where e.classroom_id = classrooms.id
        and e.student_id = auth.uid()
    )
  );

drop policy if exists "classrooms_owner_write" on public.classrooms;
create policy "classrooms_owner_write"
  on public.classrooms
  for all
  to authenticated
  using (auth.uid() = teacher_id and public.session_is_verified_human())
  with check (auth.uid() = teacher_id and public.session_is_verified_human());

-- A student reads and leaves their own enrollments; the class's teacher reads
-- the roster. Neither can read anyone else's.
drop policy if exists "enrollments_own_read" on public.enrollments;
create policy "enrollments_own_read"
  on public.enrollments
  for select
  to authenticated
  using (
    auth.uid() = student_id
    or exists (
      select 1 from public.classrooms c
      where c.id = enrollments.classroom_id
        and c.teacher_id = auth.uid()
    )
  );

drop policy if exists "enrollments_own_delete" on public.enrollments;
create policy "enrollments_own_delete"
  on public.enrollments
  for delete
  to authenticated
  using (auth.uid() = student_id and public.session_is_verified_human());

-- ⚠ NO INSERT POLICY, DELIBERATELY. Enrolment happens only through
-- join_classroom() below. A direct INSERT policy would need the student to know
-- a classroom_id, which they can only obtain by SELECTing a classroom they are
-- not yet in — reintroducing exactly the enumeration the SELECT policy above
-- prevents. Routing every join through one SECURITY DEFINER function keeps the
-- code the only key.

-- -----------------------------------------------------------------------------
-- 4. join_classroom(p_code)
--
-- Resolves one code, enrols the caller, returns that one classroom.
--
-- SECURITY DEFINER so it can look up a classroom the caller cannot yet SELECT,
-- with `search_path = ''` and fully-qualified names so the elevated body cannot
-- be redirected by a search-path hijack — the same pattern handle_new_user()
-- uses.
--
-- ⚠ IT RETURNS ZERO ROWS FOR A BAD CODE RATHER THAN RAISING. A raised exception
-- reaches supabase-js as an `error`, indistinguishable at the call site from a
-- network failure — and "that code doesn't exist" is a normal answer that
-- belongs under the input as a form message, not in an error banner.
--
-- ⚠ IT IS GATED ON session_is_verified_human(). Joining a class is a real
-- membership change, so it gets the same bar as every other write in this
-- schema. A password-only session cannot enrol.
-- -----------------------------------------------------------------------------
create or replace function public.join_classroom(p_code text)
returns table (
  id               uuid,
  join_code        text,
  name             text,
  subject          text,
  teacher_name     text,
  active_exam_code text,
  already_enrolled boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class   public.classrooms%rowtype;
  v_existed boolean;
begin
  if not public.session_is_verified_human() then
    -- Same shape as an unknown code: zero rows. The client already withholds
    -- this form from an unverified session, so reaching here means the API was
    -- called directly — and that caller learns nothing about which codes are
    -- real.
    return;
  end if;

  select * into v_class
  from public.classrooms c
  where upper(c.join_code) = upper(btrim(p_code));

  if not found then
    return;
  end if;

  select exists (
    select 1 from public.enrollments e
    where e.classroom_id = v_class.id and e.student_id = auth.uid()
  ) into v_existed;

  insert into public.enrollments (classroom_id, student_id)
  values (v_class.id, auth.uid())
  on conflict (classroom_id, student_id) do nothing;

  return query
  select v_class.id, v_class.join_code, v_class.name, v_class.subject,
         v_class.teacher_name, v_class.active_exam_code, v_existed;
end;
$$;

comment on function public.join_classroom(text) is
  'Enrol the calling student in the classroom carrying p_code. Returns zero rows for an unknown code or an unverified session — never raises, so a bad code is a form message rather than an error. already_enrolled distinguishes "joined" from "you were already in this class".';

revoke all on function public.join_classroom(text) from public, anon;
grant execute on function public.join_classroom(text) to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Grants
-- -----------------------------------------------------------------------------
grant select, insert, update, delete on public.classrooms to authenticated;
-- No INSERT to authenticated on enrollments: join_classroom() owns that path,
-- and it runs as the function owner rather than as the caller.
grant select, delete on public.enrollments to authenticated;
