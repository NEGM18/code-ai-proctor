-- =============================================================================
-- 20260822140000_lifecycle_column_authority.sql
--
-- Makes the previous migration's comments TRUE.
--
-- 20260822130000 added columns whose doc comments assert they are written
-- "by the analyze-snapshot Edge Function with the service identity, never by a
-- client" and "derived server-side ... never from the request body". Those were
-- statements about where the code writes them, not about who is ALLOWED to. The
-- permission was never there:
--
--     violations_own_rw        FOR ALL to authenticated
--     proctor_sessions_own_rw  FOR ALL to authenticated
--       using / with check ( auth.uid() = student_id AND session_is_verified_human() )
--
-- `FOR ALL` is SELECT + INSERT + UPDATE + DELETE, and `authenticated` held table
-- -wide UPDATE and DELETE grants. So the subject of a proctoring record was also
-- its editor. With one PostgREST call against their own rows, a signed-in
-- candidate could:
--
--   * PATCH violations SET review_route='STUDENT'  -> remove their own confirmed,
--     sealed evidence from `teacher_review_queue`, whose only filter is that
--     column. The seal survives; the pointer to it leaves the queue.
--   * PATCH violations SET ai_verdict / cheat_probability / cheat_reason -> rewrite
--     what the reviewer model is recorded as having concluded, in either
--     direction.
--   * DELETE FROM violations -> erase the finding outright.
--   * PATCH proctor_sessions SET ai_flagged_at=null, review_closed_at=null ->
--     reopen a sitting the >=95% early stop had closed.
--   * PATCH violations SET ai_reviewed_at=null -> uncount reviewed frames, which
--     is what the per-sitting budget counts, resetting it at will.
--   * PATCH proctor_sessions SET integrity_verdict=null -> erase SUSPECT_ABSENT.
--
-- ⚠ THIS IS NOT A THEORETICAL PRIVILEGE. `session_is_verified_human()` is
-- satisfied by every candidate — they had to sign in to start a sitting at all —
-- so the only precondition is being the student the row is about, which is
-- exactly the population with a motive.
--
-- The read policies added by the same migration also turn out to be wider than
-- they read; see section 3.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. `violations` becomes APPEND-ONLY for candidates.
--
-- ⚠ REVOKING THE GRANT, NOT REWRITING THE POLICY, AND THE DISTINCTION MATTERS.
-- RLS policies and table/column privileges are checked independently: a policy
-- can only ever narrow what a grant already allows. Leaving `FOR ALL` in place
-- while removing the UPDATE and DELETE privileges is therefore sufficient, and
-- it is the smaller change — `violations_own_rw` still governs SELECT and
-- INSERT, which are the two operations that are legitimate here.
--
-- ⚠ NOTHING LEGITIMATE LOSES ANYTHING. The extension only ever INSERTs
-- (`supabase_rest.insertViolation`); the dashboard only ever SELECTs
-- (`studentData.js`); every UPDATE on this table comes from the Edge Function,
-- which uses the service identity and is unaffected by grants to `authenticated`.
-- A violation is an observation about a moment that has passed — there is no
-- correct reason for the observed party to edit or delete one.
-- -----------------------------------------------------------------------------

revoke update, delete on public.violations from authenticated;

comment on table public.violations is
  'Append-only for candidates: authenticated holds SELECT and INSERT only. '
  'UPDATE and DELETE are deliberately revoked - the subject of a record must '
  'not be its editor. The analyze-snapshot Edge Function writes ai_verdict, '
  'review_route and the snapshot columns with the service identity.';


-- -----------------------------------------------------------------------------
-- 2. `proctor_sessions` keeps a candidate-writable subset, and only that subset.
--
-- Unlike `violations`, this table genuinely IS written by the client during a
-- sitting: the extension opens the row, heartbeats it, records an integrity
-- break and closes it, all with the candidate's own token. So the fix here is a
-- column-level grant rather than a blanket revoke.
--
-- ⚠ COLUMN-LEVEL UPDATE GRANTS ARE THE ESTABLISHED PATTERN IN THIS PROJECT —
-- `profiles` already uses them — and they compose with RLS exactly as the
-- table-level grant did: `proctor_sessions_own_rw` still restricts WHICH rows,
-- this restricts WHICH columns.
--
-- What stays writable, and why each one has to be:
--   last_heartbeat_at    - the heartbeat, every 30 s
--   timing_status        - re-asserted by the heartbeat
--   ended_at             - session close, sent during unload
--   integrity_verdict / integrity_verdict_at / monitoring_paused_at
--                        - recordIntegrityBreak(), see the warning below
--
-- What is now unwritable by the candidate, and what each one protects:
--   ai_flagged_at / ai_flag_confidence / review_closed_at
--                        - the >=95% early stop. Writable, it is not a stop.
--   mode / classroom_id / demo_session_id
--                        - the routing and budget keys. A candidate who could
--                          rewrite `mode` after the fact would move their own
--                          evidence out of a teacher's queue; one who could
--                          rewrite `demo_session_id` would re-point the budget
--                          at an unspent sitting.
--   student_id / session_code / full_name / student_university_id / lighting /
--   handshake_*          - the identity and setup record of the sitting. None of
--                          it is re-derivable after the fact, and all of it is
--                          written once at open.
--
-- ⚠ `integrity_verdict` REMAINS CANDIDATE-WRITABLE, AND THAT IS A KNOWN, BOUNDED
-- WEAKNESS RATHER THAN AN OVERSIGHT. SUSPECT_ABSENT is detected in the browser
-- and written with the candidate's own token, so a candidate running a modified
-- extension can decline to write it — no grant can fix that, because the
-- decision is made on their machine. Revoking the column would make the honest
-- client unable to record it while leaving the dishonest one exactly as capable,
-- which is strictly worse. What the grant DOES still buy is that they cannot
-- rewrite it to some other value (the CHECK constraint allows only
-- SUSPECT_ABSENT), and the Edge Function's own writes are unaffected. Closing it
-- properly needs the verdict derived server-side from evidence the client cannot
-- suppress — recorded here as the honest limitation, not fixed here.
-- -----------------------------------------------------------------------------

revoke update on public.proctor_sessions from authenticated;

grant update (
  last_heartbeat_at,
  timing_status,
  ended_at,
  integrity_verdict,
  integrity_verdict_at,
  monitoring_paused_at
) on public.proctor_sessions to authenticated;

-- ⚠ DELETE IS REVOKED TOO. A candidate deleting their own sitting row takes the
-- handshake evidence, the integrity verdict and the review budget with it, and
-- orphans every violation that referenced it.
revoke delete on public.proctor_sessions from authenticated;

comment on column public.proctor_sessions.integrity_verdict is
  'SUSPECT_ABSENT when continuous monitoring was broken during a CLASSROOM '
  'sitting. A claim about the RECORD (an interval nobody observed), never about '
  'the candidate. Demo sittings never set this. NOTE: written by the extension '
  'with the candidate own token, so a modified client can decline to write it; '
  'the grant prevents rewriting it, not withholding it.';


-- -----------------------------------------------------------------------------
-- 3. The teacher read policies are scoped to the SITTING's classroom.
--
-- ⚠ THE PREVIOUS PREDICATE HAD NO TERM TYING THE ROW TO THE READER'S CLASSROOM.
-- It asked only "does a classroom exist that this teacher owns AND this student
-- is enrolled in" — which is a fact about the two people, not about the exam.
-- Enrollment is student-initiated (`join_classroom()`), and a student may be in
-- several classrooms, so:
--
--   Student S is enrolled in classroom A (teacher TA) and classroom B (teacher
--   TB). S sits an exam for A. TB reads S's evidence from TA's exam — verdict,
--   confidence, the model's sentence about them, and A's session_code, timing
--   and integrity verdict — because TB shares *a* classroom with S.
--
-- That is materially narrower than the deployment-wide read the same migration
-- removed, and still wrong. The replacement joins through the SITTING: the row
-- is readable only by the teacher of the classroom the sitting was actually for.
--
-- ⚠ IT FAILS CLOSED WHEN `classroom_id` IS NULL, WHICH IS TODAY'S NORMAL CASE.
-- No teacher UI sets a classroom yet, so in practice this makes the teacher
-- queue empty rather than wrong. That is the correct direction: an empty queue
-- is a missing feature, a mis-scoped queue is a privacy breach.
-- -----------------------------------------------------------------------------

drop policy if exists "violations_classroom_teacher_read"       on public.violations;
drop policy if exists "proctor_sessions_classroom_teacher_read" on public.proctor_sessions;

create policy "violations_classroom_teacher_read"
  on public.violations
  for select
  to authenticated
  using (
    session_is_verified_human()
    and review_route = 'TEACHER'
    and exists (
      select 1
      from public.proctor_sessions s
      join public.classrooms  c on c.id = s.classroom_id
      join public.enrollments e on e.classroom_id = c.id
      where s.id = violations.session_id
        and s.mode = 'CLASSROOM'
        and e.student_id = violations.student_id
        and c.teacher_id = auth.uid()
    )
  );

create policy "proctor_sessions_classroom_teacher_read"
  on public.proctor_sessions
  for select
  to authenticated
  using (
    session_is_verified_human()
    and mode = 'CLASSROOM'
    and exists (
      select 1
      from public.classrooms  c
      join public.enrollments e on e.classroom_id = c.id
      where c.id = proctor_sessions.classroom_id
        and e.student_id = proctor_sessions.student_id
        and c.teacher_id = auth.uid()
    )
  );


-- -----------------------------------------------------------------------------
-- 4. Assert the outcome rather than assuming it.
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'violations' and privilege_type in ('UPDATE', 'DELETE')
  ) then
    raise exception 'authenticated still holds UPDATE/DELETE on violations - a candidate can still rewrite or erase findings about themselves';
  end if;

  if exists (
    select 1 from information_schema.column_privileges
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'proctor_sessions' and privilege_type = 'UPDATE'
      and column_name in ('ai_flagged_at', 'ai_flag_confidence', 'review_closed_at',
                          'mode', 'classroom_id', 'demo_session_id')
  ) then
    raise exception 'authenticated can still UPDATE a server-authoritative proctor_sessions column - the early stop and the evidence route are not enforceable';
  end if;

  -- The columns the extension needs must have SURVIVED the revoke, or a sitting
  -- silently stops heartbeating and never closes.
  if not exists (
    select 1 from information_schema.column_privileges
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'proctor_sessions' and privilege_type = 'UPDATE'
      and column_name = 'last_heartbeat_at'
  ) then
    raise exception 'authenticated lost UPDATE on last_heartbeat_at - the extension can no longer heartbeat its own sitting';
  end if;
end $$;
