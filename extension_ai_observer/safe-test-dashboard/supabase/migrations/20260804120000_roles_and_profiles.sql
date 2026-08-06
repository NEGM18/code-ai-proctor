-- =============================================================================
-- 20260804120000_roles_and_profiles.sql
--
-- safetest.space — role enum + profiles table + auto-provisioning trigger.
--
-- This is executed manually against the Supabase project's SQL editor (or via
-- `supabase db push` once the CLI is linked). See README.md "Supabase setup"
-- for the exact steps and where to paste the anon key afterwards.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Role enum
--
-- Three sign-up roles per PLAN.md §5/§6: a visitor lands as one of exactly
-- these three. There is no "admin" role here on purpose — platform admin is
-- an operational concern handled outside self-serve sign-up, not a value a
-- sign-up form should ever be able to produce.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'role') then
    create type public.role as enum ('student', 'teacher', 'organization');
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 2. profiles table
--
-- One row per auth.users row, created ONLY by the trigger below (never
-- directly by a client — see the grants at the bottom). `id` is both primary
-- key and foreign key to auth.users so the row cannot outlive the account.
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  role               public.role not null default 'student',
  full_name          text,
  organization_name  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.profiles is
  'One row per auth.users account. Populated exclusively by the '
  'handle_new_user() trigger below at sign-up time — clients never insert '
  'directly (see grants at the bottom of this file).';

comment on column public.profiles.role is
  'Set once at sign-up from auth.users.raw_user_meta_data.role and NOT '
  'client-updatable afterwards (see the column-level grants below). '
  'Letting a signed-in user rewrite their own role would let a "student" '
  'self-promote to "teacher" or "organization" and reach every RLS policy '
  'gated on that role — this is a privilege-escalation control, not '
  'incidental schema hygiene.';

-- -----------------------------------------------------------------------------
-- 3. updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. auto-provisioning trigger on auth.users
--
-- security definer + explicit search_path: this function must run with the
-- privilege to insert into public.profiles regardless of the RLS policies
-- below (a brand-new auth.users row has no session yet to satisfy any
-- "auth.uid() = id" policy), and the explicit search_path prevents a
-- search-path hijack from redirecting `public.profiles` to an
-- attacker-controlled object of the same unqualified name.
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name, organization_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'role', '')::public.role,
      'student'
    ),
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'organization_name'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 5. Row Level Security
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;

-- DECISION (read your own profile only — no teacher/organization override).
--
-- A blanket "role = teacher can select every profile" policy is the obvious
-- next line to write, and it is deliberately NOT here. There is no
-- classroom/roster relationship table in this phase (Phase 5 is auth +
-- storage plumbing only, per PLAN.md §6), so a teacher-wide SELECT policy
-- would let ANY authenticated teacher account enumerate every user on the
-- platform — every student's, every other teacher's, and every
-- organization's name and role — regardless of whether that teacher has
-- ever taught them. That is a privacy regression dressed up as a feature.
-- The same reasoning applies to `organization`: without a membership table
-- there is no way to scope "profiles belonging to my organization" from
-- "profiles belonging to everyone".
--
-- When a roster/membership table ships, add a policy that JOINS through it
-- (e.g. `exists (select 1 from roster where roster.teacher_id = auth.uid()
-- and roster.student_id = profiles.id)`), not a shortcut on `role` alone.
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No INSERT or DELETE policy for `authenticated`/`anon` is defined on
-- purpose: profile rows are created only by handle_new_user() (which runs as
-- the function owner via SECURITY DEFINER and so is not subject to RLS) and
-- deleted only via the `on delete cascade` from auth.users. A client that
-- tries INSERT/DELETE directly is rejected by RLS with no matching policy.

-- -----------------------------------------------------------------------------
-- 6. Grants
--
-- RLS decides which ROWS are visible; grants decide which COLUMNS/operations
-- are reachable at all. Both are needed: without the narrowed UPDATE grant
-- below, "profiles_update_own" would let a student rewrite their own `role`
-- column (RLS only checks `auth.uid() = id`, not which columns changed) and
-- self-promote to teacher/organization.
-- -----------------------------------------------------------------------------
grant usage on schema public to authenticated;

revoke all on public.profiles from authenticated, anon;
grant select on public.profiles to authenticated;
grant update (full_name, organization_name) on public.profiles to authenticated;
-- Deliberately no `insert`, no `delete`, and `role`/`id`/`created_at` are not
-- in the update column list — all four are the trigger's responsibility only.
