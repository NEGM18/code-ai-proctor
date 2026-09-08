-- =============================================================================
-- 20260816120000_ai_review_and_sealed_evidence.sql
--
-- Three changes, in one migration because they are one story: the demo stops
-- asking a returning user to re-prove their mailbox, it starts sending flagged
-- frames to a model for a second opinion, and it stops storing any frame the
-- deployment itself can read.
--
--   1. session_is_verified_human() accepts a password session on a CONFIRMED
--      mailbox — the emailed code moves from "every sign-in" to "sign-up only".
--   2. public.violations gains the AI-review columns and a demo-session key,
--      which is what bounds the per-student snapshot budget.
--   3. The demo-snapshots bucket becomes WRITE-ONLY-BY-THE-SERVER and
--      READ-BY-NOBODY. Every client policy is dropped.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The emailed code becomes a SIGN-UP step, not a SIGN-IN step.
--
-- ⚠ THIS IS A DELIBERATE REDUCTION IN THE STRENGTH OF THE GATE, MADE ON
-- INSTRUCTION, AND IT SHOULD BE READ AS ONE RATHER THAN AS A REFACTOR.
--
-- The 2026-08-10 design required a mailbox-proving `amr` method on the CURRENT
-- session, so a bare `signInWithPassword()` — whose amr is exactly `[password]`
-- — was refused by the database. That is what made the 6-digit code a genuine
-- second factor: a stolen password replayed at the REST API with curl produced
-- a token every policy rejected.
--
-- The new third branch below asks a different question: not "did THIS session
-- prove the mailbox" but "has this ACCOUNT ever proved it". A confirmed
-- `auth.users.email_confirmed_at` is set once, at sign-up, and never expires.
-- So from here on a password alone reaches the demo, the evidence path and the
-- own-row tables.
--
-- What is retained, and why this is not simply "the gate is gone":
--
--   * Anonymous sessions are still refused — by the is_anonymous test, and
--     again because an anonymous user carries no confirmed email.
--   * Sign-up still requires the emailed code before the account is confirmed,
--     so an address nobody controls never becomes an account at all.
--   * The two strong branches are UNTOUCHED. A Google session and a
--     code-verified session still pass on their own evidence, so nothing that
--     depends on the strong reading has been re-pointed at the weak one.
--
-- What is genuinely lost: credential-stuffing resistance. A leaked password for
-- a confirmed account is now sufficient. `trusted_devices` was the previous
-- mitigation for the same annoyance and is strictly stronger (a per-device
-- secret, revocable from the dashboard, 30-day expiry); its branch is kept, so
-- nothing regresses for a device already enrolled.
--
-- SECURITY DEFINER is required, not incidental: `auth.users` is not readable by
-- the `authenticated` role, so a security-invoker function would evaluate the
-- new branch as `false` for everybody and this change would silently do
-- nothing. The function takes no arguments and reads exactly one row — the
-- caller's own — so the definer rights it runs with cannot be steered.
-- -----------------------------------------------------------------------------

create or replace function public.session_is_verified_human()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    auth.uid() is not null
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) is not true
    and (
      -- (a) The session itself proved a mailbox. Unchanged.
      exists (
        select 1
        from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) as entry
        where entry ->> 'method' in ('otp', 'magiclink', 'oauth', 'sso/saml', 'totp')
           or entry ->> 'method' like 'mfa/%'
      )
      -- (b) This browser holds a live trusted-device grant. Unchanged.
      or exists (
        select 1
        from public.trusted_sessions ts
        where ts.session_id = (auth.jwt() ->> 'session_id')
          and ts.user_id = auth.uid()
          and ts.expires_at > now()
      )
      -- (c) NEW: the ACCOUNT proved its mailbox at sign-up and was confirmed.
      --     This is what removes the code from every subsequent sign-in.
      or exists (
        select 1
        from auth.users u
        where u.id = auth.uid()
          and u.email_confirmed_at is not null
      )
    );
$$;

comment on function public.session_is_verified_human() is
  'True for a session belonging to a CONFIRMED account: Google/OAuth, the '
  'emailed 6-digit code, a live trusted-device grant, or a password sign-in on '
  'an account whose email_confirmed_at is set. Anonymous sessions are always '
  'false. Branch (c) was added 2026-08-16 on instruction and deliberately '
  'weakens this from a per-SESSION second factor to a per-ACCOUNT one — a '
  'leaked password now suffices. src/lib/auth/session.js mirrors this and must '
  'be changed in step with it.';

grant execute on function public.session_is_verified_human() to authenticated, anon;


-- -----------------------------------------------------------------------------
-- 2. AI review columns on public.violations.
--
-- Reusing this table rather than adding a `snapshot_reviews` one is deliberate:
-- the student dashboard, the ProcScore and the evidence gallery all already
-- read `violations`, and a parallel table would mean a flag that exists for the
-- reviewer but not for the score — two answers to "was I flagged".
--
-- `demo_session_id` is what makes the budget countable. A live-demo sitting
-- opens no `proctor_sessions` row (the extension skips every server call in
-- guest mode), so `session_id` is null for these and cannot group them. It is a
-- page-supplied opaque string and is NEVER an authorisation input — every
-- policy still keys on `student_id = auth.uid()`. Its only job is to scope
-- "three snapshots per sitting" so a second demo run gets a fresh budget.
-- -----------------------------------------------------------------------------

alter table public.violations
  add column if not exists demo_session_id text,
  add column if not exists ai_verdict text,
  add column if not exists ai_reviewed_at timestamptz,
  add column if not exists snapshot_sealed boolean not null default false;

comment on column public.violations.demo_session_id is
  'Opaque per-sitting key for live-demo flags, which have no proctor_sessions '
  'row to group by. Scopes the 3-snapshot AI review budget. Never an '
  'authorisation input — student_id is the identity.';

comment on column public.violations.ai_verdict is
  'The reviewing model''s verdict token: CHEATING | NOT_CHEATING | INCONCLUSIVE. '
  'NULL means the frame was never reviewed, which is NOT the same as '
  'NOT_CHEATING and must never render as an exoneration.';

comment on column public.violations.ai_reviewed_at is
  'When the model answered. Counted by the Edge Function to enforce the '
  '3-snapshot-per-sitting budget, so it is set on EVERY reviewed frame '
  'including the ones the model cleared — a budget that counted only the '
  'incriminating answers would be unbounded for an honest candidate.';

comment on column public.violations.snapshot_sealed is
  'True when snapshot_path points at a PMSEAL1 envelope rather than a JPEG. '
  'The envelope is decryptable only with an offline private key that exists '
  'nowhere in this deployment — see supabase/functions/analyze-snapshot.';

comment on column public.violations.cheat_probability is
  'The reviewing model''s own confidence, 0-100. At >= 95 on a CHEATING verdict '
  'the sitting''s snapshot budget is closed early — see the Edge Function.';

-- The budget query is `where student_id = ? and demo_session_id = ?`, run once
-- per flagged frame on the hot path.
create index if not exists violations_student_demo_session_idx
  on public.violations (student_id, demo_session_id)
  where demo_session_id is not null;


-- -----------------------------------------------------------------------------
-- 3. demo-snapshots becomes unreadable to every client.
--
-- ⚠ ALL FOUR CLIENT POLICIES ARE DROPPED AND NOT REPLACED. THAT IS THE FEATURE,
-- NOT AN OVERSIGHT.
--
-- Postgres RLS denies by default, so a bucket with no policy is reachable only
-- by the service role, which bypasses RLS entirely. After this migration:
--
--   * the browser extension can no longer PUT a plaintext JPEG here (its upload
--     path is removed in the same commit — this policy drop is the backstop,
--     not the mechanism);
--   * the student cannot list, read, sign or delete their own frames, which is
--     what "the demo no longer lets you watch yourself being caught" means at
--     the storage layer rather than only in React;
--   * the ONLY writer is the analyze-snapshot Edge Function, and the only thing
--     it writes is a sealed envelope.
--
-- The previous design's argument for keeping DELETE open — the demo deleting
-- its own snapshots on exit — no longer applies and is now actively unwanted: a
-- frame the model confirmed at >= 95% has to outlive the sitting, or the
-- "check whether you were flagged" screen has nothing to report.
-- -----------------------------------------------------------------------------

drop policy if exists "demo_snapshots_insert_own" on storage.objects;
drop policy if exists "demo_snapshots_select_own" on storage.objects;
drop policy if exists "demo_snapshots_update_own" on storage.objects;
drop policy if exists "demo_snapshots_delete_own" on storage.objects;

-- Belt and braces: the bucket must stay private. A public bucket serves objects
-- without consulting RLS at all, which would make every policy above irrelevant
-- and hand out sealed envelopes to anyone who can guess a path. (They would
-- still be undecryptable, but an attacker should not be collecting ciphertext
-- for free either.)
update storage.buckets set public = false where id = 'demo-snapshots';
