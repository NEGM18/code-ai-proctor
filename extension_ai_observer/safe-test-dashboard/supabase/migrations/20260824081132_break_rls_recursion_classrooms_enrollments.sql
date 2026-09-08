-- =============================================================================
-- 20260824081132_break_rls_recursion_classrooms_enrollments.sql
--
-- Fixes a total outage: every authenticated read AND write of `violations`,
-- `proctor_sessions`, `classrooms` and `enrollments` returned
--
--     {"code":"42P17","message":"infinite recursion detected in policy for
--      relation \"classrooms\""}
--
-- which PostgREST renders as HTTP 500.
--
-- ⚠ THE CYCLE IS BETWEEN TWO POLICIES THAT EACH LOOK PERFECTLY REASONABLE ALONE.
-- A policy subquery against a table re-evaluates THAT table's policies, so:
--
--     classrooms_visible_to_members   (SELECT on classrooms)
--       -> subquery FROM enrollments
--          -> enrollments_own_read    (SELECT on enrollments)
--             -> subquery FROM classrooms
--                -> classrooms_visible_to_members  -> ...
--
-- Both were written in 20260812120000 and each is the obvious expression of its
-- rule — "a classroom is visible to its members" and "an enrolment is visible to
-- the classroom's teacher". Neither is wrong; together they are a loop.
--
-- ⚠ IT WAS LATENT UNTIL 20260822130000/140000 GAVE IT TRAFFIC, WHICH IS WHY IT
-- PRESENTED AS A REGRESSION IN THE SITTING LIFECYCLE RATHER THAN AS A CLASSROOM
-- BUG. Those migrations added teacher-read policies on `violations` and
-- `proctor_sessions` whose subqueries join `classrooms` and `enrollments` — so
-- from then on, EVERY read of the two tables the proctor writes to entered the
-- cycle. Writes too: `startSession()` sends `Prefer: return=representation`, and
-- returning the inserted row evaluates the SELECT policies. That is the
-- `session row not created (SUPABASE_HTTP_ERROR)` reported from the field, and
-- it is why the service-role Edge Function kept working throughout while every
-- user-token write failed — BYPASSRLS never evaluates a policy, so it never
-- entered the loop.
--
-- ⚠ THE FIX IS TO STOP POLICIES QUERYING RLS-PROTECTED TABLES, NOT TO WEAKEN THE
-- RULES. Each membership question moves into a `SECURITY DEFINER` function,
-- which runs with the definer's rights and therefore does NOT re-enter RLS. The
-- predicates below express exactly what they expressed before; only the
-- mechanism changed. `set search_path = ''` and fully-qualified names are
-- mandatory on a definer function — without them a caller-controlled
-- search_path can resolve `classrooms` to a table they created.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The membership predicates.
--
-- ⚠ EACH ONE ANSWERS ONLY A QUESTION THE CALLER IS ALREADY ENTITLED TO ASK, AND
-- THAT IS WHAT MAKES `SECURITY DEFINER` SAFE HERE. Bypassing RLS is only sound
-- if the function cannot become an oracle for rows the caller may not see:
--
--   classroom_teacher_of  - "am *I* the teacher of X" ......... about auth.uid()
--   student_enrolled_in   - "am *I* enrolled in X" ............ about auth.uid()
--   teacher_may_read_*    - takes another student's id, but returns true ONLY
--                           when auth.uid() is the teacher of the classroom that
--                           links them. A non-teacher always gets false, so it
--                           discloses nothing they could not already read.
--
-- All four return boolean and never leak a row. Do not add a variant that
-- returns data, and do not drop the `c.teacher_id = auth.uid()` term from the
-- last two — it is the whole authorisation.
-- -----------------------------------------------------------------------------

create or replace function public.classroom_teacher_of(p_classroom uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.classrooms c
     where c.id = p_classroom and c.teacher_id = auth.uid()
  );
$$;

create or replace function public.student_enrolled_in(p_classroom uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.enrollments e
     where e.classroom_id = p_classroom and e.student_id = auth.uid()
  );
$$;

create or replace function public.teacher_may_read_student(p_classroom uuid, p_student uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.classrooms c
      join public.enrollments e on e.classroom_id = c.id
     where c.id = p_classroom
       and c.teacher_id = auth.uid()
       and e.student_id = p_student
  );
$$;

-- Resolves the sitting itself, so the `violations` policy never has to touch
-- `proctor_sessions` (which carries its own policies, and would re-enter RLS).
create or replace function public.teacher_may_read_sitting(p_session uuid, p_student uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.proctor_sessions s
      join public.classrooms  c on c.id = s.classroom_id
      join public.enrollments e on e.classroom_id = c.id
     where s.id = p_session
       and s.mode = 'CLASSROOM'
       and c.teacher_id = auth.uid()
       and e.student_id = p_student
  );
$$;

-- ⚠ A SECURITY DEFINER FUNCTION IS EXECUTABLE BY `public` UNLESS REVOKED, WHICH
-- WOULD HAND `anon` A MEMBERSHIP ORACLE THAT SKIPS RLS. Revoke first, then grant
-- narrowly.
revoke execute on function public.classroom_teacher_of(uuid)          from public, anon;
revoke execute on function public.student_enrolled_in(uuid)           from public, anon;
revoke execute on function public.teacher_may_read_student(uuid,uuid) from public, anon;
revoke execute on function public.teacher_may_read_sitting(uuid,uuid) from public, anon;

grant execute on function public.classroom_teacher_of(uuid)          to authenticated;
grant execute on function public.student_enrolled_in(uuid)           to authenticated;
grant execute on function public.teacher_may_read_student(uuid,uuid) to authenticated;
grant execute on function public.teacher_may_read_sitting(uuid,uuid) to authenticated;


-- -----------------------------------------------------------------------------
-- 2. The same rules, expressed without re-entering RLS.
-- -----------------------------------------------------------------------------

drop policy if exists "classrooms_visible_to_members"           on public.classrooms;
drop policy if exists "enrollments_own_read"                    on public.enrollments;
drop policy if exists "proctor_sessions_classroom_teacher_read" on public.proctor_sessions;
drop policy if exists "violations_classroom_teacher_read"       on public.violations;

create policy "classrooms_visible_to_members" on public.classrooms
  for select to authenticated
  using (auth.uid() = teacher_id or public.student_enrolled_in(id));

create policy "enrollments_own_read" on public.enrollments
  for select to authenticated
  using (auth.uid() = student_id or public.classroom_teacher_of(classroom_id));

create policy "proctor_sessions_classroom_teacher_read" on public.proctor_sessions
  for select to authenticated
  using (
    session_is_verified_human()
    and mode = 'CLASSROOM'
    and public.teacher_may_read_student(classroom_id, student_id)
  );

create policy "violations_classroom_teacher_read" on public.violations
  for select to authenticated
  using (
    session_is_verified_human()
    and review_route = 'TEACHER'
    and public.teacher_may_read_sitting(session_id, student_id)
  );


-- -----------------------------------------------------------------------------
-- 3. Assert the cycle cannot come back.
--
-- ⚠ THIS IS THE ONLY CHEAP GUARD AGAINST A RECURRENCE. The failure is invisible
-- in review — each policy reads correctly on its own — and only appears at
-- runtime, as a 500, on tables that may not be exercised for weeks. Any policy
-- on these four tables that names `classrooms` or `enrollments` inline is a
-- candidate cycle, so refuse it here rather than in production.
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('classrooms','enrollments','proctor_sessions','violations')
       and (qual like '%FROM enrollments%' or qual like '%FROM classrooms%'
            or qual like '%JOIN enrollments%' or qual like '%JOIN classrooms%')
  ) then
    raise exception 'a policy still queries classrooms/enrollments inline - the 42P17 cycle can recur';
  end if;
end $$;
