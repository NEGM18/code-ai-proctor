-- =============================================================================
-- 20260822130000_sitting_lifecycle.sql
--
-- Gives a SITTING somewhere to live, end to end:
--
--   1. Handshake telemetry on `proctor_sessions` — the evidence behind
--      `timing_status`, so a LATE verdict is reviewable instead of just harsh.
--   2. A sitting KEY (`demo_session_id`) and a MODE (`DEMO` / `CLASSROOM`), so
--      the review budget can be scoped to one sitting and the evidence routed to
--      the right reader.
--   3. An integrity verdict column, for the classroom rule that a broken
--      monitoring window is recorded as `SUSPECT_ABSENT`.
--   4. A teacher review queue — and, in the course of building it, a fix for two
--      policies that were far broader than they read.
--
-- Depends on 20260822120000_service_role_grants.sql: the Edge Function writes
-- every one of these columns with the service identity, and without those grants
-- each write is a 403.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Handshake telemetry.
--
-- ⚠ THE REASON COLUMN IS NOT DECORATION. `LATE_PROCTOR_ATTACH` is one verdict
-- covering two situations that deserve opposite responses — "this candidate has
-- no proctoring extension installed" and "this candidate delayed the attach" —
-- and a reviewer holding only the verdict will read the second. `handshake_reason`
-- is what separates them; `handshake_latency_ms` is what distinguishes a genuinely
-- slow reply from a cold MV3 service worker.
--
-- ⚠ THE ATTESTATION DIGEST ITSELF IS DELIBERATELY NOT STORED. It binds a reply to
-- a service-worker boot id that no longer exists by the time anyone reads the
-- row, so the hex would be an unverifiable string that LOOKS like a signature and
-- invites being treated as one. What survives usefully is whether one was
-- obtained at all, which is a boolean.
-- -----------------------------------------------------------------------------

alter table public.proctor_sessions
  add column if not exists handshake_nonce      text,
  add column if not exists handshake_latency_ms integer,
  add column if not exists handshake_reason     text,
  add column if not exists handshake_attested   boolean not null default false;

comment on column public.proctor_sessions.handshake_reason is
  'Why timing_status was graded as it was: OK | NO_REPLY | SLOW_REPLY | '
  'NONCE_MISMATCH | INTERACTION_FIRST | LATE_MOUNT. Mirrors HANDSHAKE_REASON in '
  'src/lib/proctor/handshake.js and the copy in extension/content/guest_bridge.js.';

comment on column public.proctor_sessions.handshake_attested is
  'True when the background worker returned a SHA-256 attestation in budget. It '
  'is a digest, not a signature - see attestHandshake() in background/worker.js '
  'for what it does and does not prove. Never read false as evidence of '
  'misconduct: an evicted MV3 worker misses the 300 ms budget routinely.';


-- -----------------------------------------------------------------------------
-- 2. What kind of sitting this is, and which sitting it is.
--
-- ⚠ `demo_session_id` HERE IS THE SAME KEY AS ON `violations`, AND THAT JOIN IS
-- THE WHOLE POINT — it is what lets the review budget be counted per sitting
-- instead of per account. Until now `demoSessionId` was `auth.uid()`, which is
-- constant for the life of an account, so "3 reviewed frames per sitting" was
-- really "3 per student, ever" and a second sitting silently got none. The page
-- now mints a fresh id per mount; this column records which one it was.
--
-- ⚠ `mode` DEFAULTS TO 'DEMO', NOT 'CLASSROOM', AND THE DEFAULT IS LOAD-BEARING.
-- It decides who reads a confirmed frame. Defaulting to CLASSROOM would route the
-- evidence of anyone whose row predates this column — or whose client is older
-- than it — into a teacher's queue they never consented to appear in. Sending a
-- classroom frame to the student's own dashboard is a smaller error than exposing
-- a demo frame to a stranger, so the default fails toward the narrower audience.
-- Existing rows are backfilled explicitly below.
-- -----------------------------------------------------------------------------

alter table public.proctor_sessions
  add column if not exists demo_session_id text,
  add column if not exists mode            text not null default 'DEMO',
  add column if not exists classroom_id    uuid references public.classrooms (id) on delete set null;

-- ⚠ BACKFILL BEFORE THE CONSTRAINT, OR THE CONSTRAINT REJECTS THE TABLE'S OWN
-- HISTORY. The `GUEST-DEMO` rows are demo sittings; the rest came in under a
-- teacher's proctor code and are classroom sittings. `mode` did not exist when
-- they were written, so it is inferred from the one field that did.
update public.proctor_sessions
   set mode = case when session_code = 'GUEST-DEMO' then 'DEMO' else 'CLASSROOM' end
 where mode is null or mode = 'DEMO';

alter table public.proctor_sessions
  drop constraint if exists proctor_sessions_mode_check;
alter table public.proctor_sessions
  add constraint proctor_sessions_mode_check check (mode in ('DEMO', 'CLASSROOM'));

-- ⚠ THE LEGACY LMS VALUES STAY IN THE VOCABULARY. `ON_TIME_BEFORE_QUIZ` and
-- `LATE_PROCTORING_STARTED` are emitted by `calculateTimingCompliance()` on a
-- real LMS page, and every already-installed copy of the extension still writes
-- them. A constraint accepting only the two new values would reject those rows —
-- and a rejected session insert is not a loud failure: `monitor.js` warns and
-- proctors on, so the sitting would run with no row behind it at all. NULL is
-- allowed for the same reason: an older client sends no value.
alter table public.proctor_sessions
  drop constraint if exists proctor_sessions_timing_status_check;
alter table public.proctor_sessions
  add constraint proctor_sessions_timing_status_check check (
    timing_status is null or timing_status in (
      'ON_TIME_AT_QUIZ',
      'LATE_PROCTOR_ATTACH',
      'ON_TIME_BEFORE_QUIZ',
      'LATE_PROCTORING_STARTED'
    )
  );

create index if not exists proctor_sessions_demo_session_idx
  on public.proctor_sessions (demo_session_id)
  where demo_session_id is not null;

create index if not exists proctor_sessions_classroom_idx
  on public.proctor_sessions (classroom_id)
  where classroom_id is not null;


-- -----------------------------------------------------------------------------
-- 3. The integrity verdict for a broken monitoring window.
--
-- ⚠ `SUSPECT_ABSENT` IS A STATEMENT ABOUT COVERAGE, NOT ABOUT THE PERSON, AND
-- ANY UI OVER IT MUST KEEP THAT DISTINCTION. It means the continuous-observation
-- guarantee was broken — the candidate left fullscreen during a classroom exam
-- and snapshot capture stopped — so the record for that interval is missing. It
-- does not mean cheating was observed; by construction nothing was observed at
-- all. It lives here rather than in `violations` for exactly that reason:
-- `violations` is the accusation table, and this is not an accusation.
-- -----------------------------------------------------------------------------

alter table public.proctor_sessions
  add column if not exists integrity_verdict     text,
  add column if not exists integrity_verdict_at  timestamptz,
  add column if not exists monitoring_paused_at  timestamptz;

alter table public.proctor_sessions
  drop constraint if exists proctor_sessions_integrity_verdict_check;
alter table public.proctor_sessions
  add constraint proctor_sessions_integrity_verdict_check check (
    integrity_verdict is null or integrity_verdict in ('SUSPECT_ABSENT')
  );

-- -----------------------------------------------------------------------------
-- 3b. The early-stop flag: "if it is more than 95% then stop taking snapshots".
--
-- ⚠ THIS IS A SECOND, INDEPENDENT RECORD OF A DECISION THE VIOLATION ROWS ALREADY
-- IMPLY, AND THE DUPLICATION IS DELIBERATE. The Edge Function can already infer
-- "this sitting is closed" by re-reading `violations` for a CHEATING row at
-- >= 95, and it still does — that inference is the enforcement, because it
-- cannot be skipped by a client that never asks. What it cannot do is tell the
-- PAGE to stop capturing: the page never reads `violations`, and a rule that
-- only refuses uploads still pays for every frame the candidate's laptop
-- encodes and sends. Writing the decision onto the sitting row is what lets the
-- capture side stop, and what lets a reviewer see WHEN the sitting was closed
-- without reconstructing it from three timestamps.
--
-- ⚠ `review_closed_at` IS NOT AN ACCUSATION AND MUST NOT BE RENDERED AS ONE. It
-- means "no further frames from this sitting will be reviewed", which is also
-- true when the sitting merely spent its budget of three. `ai_flagged_at` is the
-- narrower claim — a model confirmed a frame at or above the stop threshold —
-- and only that one carries a finding.
-- -----------------------------------------------------------------------------

alter table public.proctor_sessions
  add column if not exists ai_flagged_at       timestamptz,
  add column if not exists ai_flag_confidence  numeric,
  add column if not exists review_closed_at    timestamptz;

comment on column public.proctor_sessions.ai_flagged_at is
  'When a reviewer model confirmed CHEATING at or above the stop threshold '
  '(95). Set by the analyze-snapshot Edge Function with the service identity, '
  'never by a client. Null means no such confirmation - NOT that the sitting '
  'was cleared.';

comment on column public.proctor_sessions.review_closed_at is
  'When this sitting stopped accepting frames for review, whether because the '
  'budget of 3 was spent or because a high-confidence CHEATING verdict closed '
  'it early. A closed sitting is not a flagged one - read ai_flagged_at for '
  'that.';

comment on column public.proctor_sessions.integrity_verdict is
  'SUSPECT_ABSENT when continuous monitoring was broken during a CLASSROOM '
  'sitting. A claim about the RECORD (an interval nobody observed), never about '
  'the candidate. Demo sittings never set this - leaving fullscreen there is a '
  'soft warning by design.';


-- -----------------------------------------------------------------------------
-- 4. Where a confirmed frame goes.
--
-- Set by the Edge Function from the SITTING ROW, never from the request body: a
-- client that could name its own route would keep a classroom frame out of its
-- teacher's queue by claiming DEMO.
-- -----------------------------------------------------------------------------

alter table public.violations
  add column if not exists review_route text not null default 'STUDENT';

alter table public.violations
  drop constraint if exists violations_review_route_check;
alter table public.violations
  add constraint violations_review_route_check check (review_route in ('STUDENT', 'TEACHER'));

comment on column public.violations.review_route is
  'STUDENT: visible only on the candidate own dashboard (demo sittings). '
  'TEACHER: also in the classroom teacher review queue. Derived server-side from '
  'proctor_sessions.mode plus a verified enrollment - never from the request body.';


-- -----------------------------------------------------------------------------
-- 5. The teacher review queue — and the two policies that were not what they read.
--
-- ⚠ THIS NARROWS ACCESS THAT WAS ALREADY FAR TOO WIDE. `violations_staff_read`
-- and `proctor_sessions_staff_read` (2026-08-05) both said, in full:
--
--     using (exists (select 1 from public.profiles p
--                    where p.id = auth.uid() and p.role in ('teacher','organization')))
--
-- There is no classroom term in that. ANY account whose profile row says
-- `teacher` could read EVERY student's violations across the whole deployment —
-- students they have never taught, and demo sittings by members of the public —
-- and `profiles_update_own` lets an account set its own `role`. So the effective
-- gate was: declare yourself a teacher, read everyone.
--
-- Nothing consumed those policies (this app has no teacher UI), which is why it
-- was never noticed. Building the queue means giving them a consumer, so they are
-- replaced first. The new predicate requires a real enrollment linking the
-- reader's classroom to the row's student.
--
-- ⚠ `organization` LOSES BLANKET ACCESS HERE, AND THAT IS INTENDED. It held no
-- narrower right than `teacher` and had no consumer either. An org-wide scope is
-- a legitimate requirement, but expressing it needs an org-membership table;
-- granting it through a self-settable profile column is not that.
-- -----------------------------------------------------------------------------

drop policy if exists "violations_staff_read"       on public.violations;
drop policy if exists "proctor_sessions_staff_read" on public.proctor_sessions;

create policy "violations_classroom_teacher_read"
  on public.violations
  for select
  to authenticated
  using (
    session_is_verified_human()
    and review_route = 'TEACHER'
    and exists (
      select 1
      from public.enrollments e
      join public.classrooms c on c.id = e.classroom_id
      where e.student_id = violations.student_id
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
      from public.enrollments e
      join public.classrooms c on c.id = e.classroom_id
      where e.student_id = proctor_sessions.student_id
        and c.teacher_id = auth.uid()
    )
  );

-- The queue itself.
--
-- ⚠ `security_invoker = on` IS THE ENTIRE SECURITY OF THIS VIEW. Postgres views
-- default to the DEFINER's rights, which here is `postgres` — that would hand
-- every authenticated caller a complete, unfiltered read of `violations` through
-- a view whose name promises the opposite. With invoker rights the two policies
-- above are evaluated for the caller, and the view is a convenience over them
-- rather than a way around them.
--
-- ⚠ IT EXPOSES NO IMAGE AND CANNOT. `snapshot_path` names a `PMSEAL1` envelope in
-- a bucket with no client policies at all, sealed to an RSA key whose private half
-- is offline. A teacher gets the verdict, the model's sentence, and the fact that
-- a sealed frame exists — which is what a review needs and is the most this
-- architecture can honestly offer.
create or replace view public.teacher_review_queue
with (security_invoker = on) as
  select
    v.id,
    v.student_id,
    v.session_id,
    v.demo_session_id,
    v.violation_type,
    v.severity,
    v.ai_verdict,
    v.ai_reviewed_at,
    v.cheat_probability,
    v.cheat_reason,
    v.snapshot_sealed,
    v.snapshot_path,
    v.created_at,
    s.session_code,
    s.classroom_id,
    s.timing_status,
    s.handshake_reason,
    s.integrity_verdict,
    s.ai_flagged_at,
    s.review_closed_at
  from public.violations v
  left join public.proctor_sessions s on s.id = v.session_id
  where v.review_route = 'TEACHER';

comment on view public.teacher_review_queue is
  'Confirmed classroom-sitting evidence, readable only by the teacher of a '
  'classroom the student is enrolled in. security_invoker=on, so RLS on the '
  'underlying tables is what scopes it. Carries no image: snapshot_path names a '
  'sealed envelope nobody in this deployment can open.';

grant select on public.teacher_review_queue to authenticated;
grant select on public.teacher_review_queue to service_role;


-- -----------------------------------------------------------------------------
-- 6. Assert the outcome rather than assuming it.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'proctor_sessions'
      and column_name = 'demo_session_id'
  ) then
    raise exception 'proctor_sessions.demo_session_id missing - the per-sitting review budget cannot be scoped';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and policyname in ('violations_staff_read', 'proctor_sessions_staff_read')
  ) then
    raise exception 'the unscoped staff-read policies still exist - any self-declared teacher can still read every student';
  end if;
end $$;
