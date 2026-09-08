-- =============================================================================
-- 20260822120000_service_role_grants.sql
--
-- THE FIX FOR `BUDGET_UNAVAILABLE sitting=403 daily=403`.
--
-- ⚠ IT WAS NEVER AN RLS PROBLEM, AND READING IT AS ONE COSTS AN AFTERNOON.
--
-- `analyze-snapshot` already called PostgREST with the service-role key, and
-- `service_role` already holds BYPASSRLS, so no policy on `public.violations`
-- was ever evaluated for it. A policy denial would not look like this either:
-- PostgREST answers a filtered-out row set with `200 []`, never 403.
--
-- Measured on the live project (2026-08-22) before this migration:
--
--   has_table_privilege('service_role','public.violations','SELECT')       -> false
--   has_table_privilege('service_role','public.violations','INSERT')       -> false
--   has_table_privilege('service_role','public.proctor_sessions','SELECT') -> false
--
-- BYPASSRLS skips row-level *policies*. It does not skip table-level *grants*,
-- which Postgres checks first. With no SELECT privilege the query raises 42501
-- ("permission denied for table violations") and PostgREST renders that as 403
-- — the exact status pair the function logged.
--
-- Root cause: every migration in this project grants only `to authenticated`
-- (see 20260805120000_violations_and_sessions.sql line 165). The default
-- privileges that normally hand `service_role` full access to new objects in
-- `public` did not apply to these tables, so the server identity has been
-- unprivileged since the day they were created. Nothing noticed because until
-- 2026-08-16 no server-side code read them.
--
-- ⚠ THIS IS NOT A WIDENING OF ACCESS. `service_role` is the key that already
-- bypasses RLS and is never shipped to a browser; it is a server secret held by
-- Edge Functions. Granting it DML on tables it is already trusted to bypass
-- policies on restores the standard Supabase posture rather than relaxing this
-- project's. The browser-facing roles (`anon`, `authenticated`) are untouched,
-- and every RLS policy stays exactly as it was.
--
-- Storage was already correct and is deliberately not touched here:
-- `service_role` has SELECT/INSERT on `storage.objects`, which is why the seal
-- upload was never the failing step.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The tables the Edge Function actually touches.
--
-- Listed by name rather than swept with `all tables in schema public`, so this
-- migration states what the server is trusted with instead of inheriting it.
-- -----------------------------------------------------------------------------

grant select, insert, update, delete on public.violations       to service_role;
grant select, insert, update, delete on public.proctor_sessions to service_role;

-- Read-only. The review path resolves a display name and a role; it has no
-- business writing to either.
grant select on public.profiles    to service_role;
grant select on public.classrooms  to service_role;
grant select on public.enrollments to service_role;

-- -----------------------------------------------------------------------------
-- 2. Stop the next table from repeating this.
--
-- ⚠ DEFAULT PRIVILEGES ARE PER-CREATING-ROLE AND APPLY ONLY TO OBJECTS CREATED
-- AFTER THEY ARE SET. They fix nothing above — that is what section 1 is for —
-- and they will not fix a table created by any role other than `postgres`.
-- Both statements are needed: migrations run as `postgres`, and the Supabase
-- SQL editor / MCP path also runs as `postgres`.
-- -----------------------------------------------------------------------------

alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to service_role;

alter default privileges for role postgres in schema public
  grant usage, select on sequences to service_role;

-- -----------------------------------------------------------------------------
-- 3. A self-check that fails LOUDLY rather than leaving a green migration.
--
-- A `grant` on a table that does not exist raises; a `grant` that silently did
-- not take does not. This asserts the outcome, so a future re-run against a
-- drifted database reports the drift instead of appearing to succeed.
-- -----------------------------------------------------------------------------

do $$
begin
  if not has_table_privilege('service_role', 'public.violations', 'SELECT')
     or not has_table_privilege('service_role', 'public.violations', 'INSERT')
     or not has_table_privilege('service_role', 'public.proctor_sessions', 'SELECT')
  then
    raise exception
      'service_role still lacks DML on the review tables — analyze-snapshot will keep returning 403';
  end if;
end $$;
