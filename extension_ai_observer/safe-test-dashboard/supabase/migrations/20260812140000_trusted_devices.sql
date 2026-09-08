-- =============================================================================
-- 20260812140000_trusted_devices.sql
--
-- "Remember this device": lets a returning user sign in with a password alone,
-- without an emailed code every time, WITHOUT weakening the rule that a bare
-- password is not sufficient.
--
-- The problem this solves is arithmetic, not UX. Once every password sign-in
-- sends a code, email volume scales with sign-ins — and both Supabase's built-in
-- sender (~2/hour) and Resend's free tier (100/day) sit directly on the critical
-- path of people being able to log in at all. Trusting a device that has
-- *already* proved control of the mailbox removes almost all of that volume.
--
-- ⚠ WHY THIS IS NOT A WEAKENING.
-- The second factor is not discarded, it is CACHED — against a secret the
-- attacker does not have. A stolen password used from another machine has no
-- device secret, so it earns no marker, so session_is_verified_human() still
-- refuses it.
--
-- ⚠ THE RESIDUAL RISK, STATED PLAINLY.
-- The device secret is a bearer token in localStorage. An XSS on our own origin,
-- combined with the password, defeats this. That is the standard bargain of
-- every "remember this device" feature; it is bounded by the 30-day expiry and
-- by the user being able to see and revoke devices from the dashboard.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. trusted_devices — one row per browser that has completed a code.
--
-- ⚠ ONLY THE HASH IS STORED. The plaintext secret is returned exactly once, by
-- enroll_trusted_device(), and thereafter lives only in that browser. A database
-- leak therefore hands nobody a working device token — the same reasoning that
-- makes password hashing non-negotiable.
-- ---------------------------------------------------------------------------
create table if not exists public.trusted_devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  label        text,
  secret_hash  text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz not null default now() + interval '30 days',
  revoked_at   timestamptz
);

create index if not exists trusted_devices_user_idx on public.trusted_devices (user_id);
create unique index if not exists trusted_devices_secret_idx on public.trusted_devices (secret_hash);
alter table public.trusted_devices enable row level security;

-- ---------------------------------------------------------------------------
-- 2. trusted_sessions — the marker that makes ONE session verified.
--
-- ⚠ KEYED BY session_id, NOT BY user_id. A row keyed by user would mean "this
-- person trusted some device once", so a stolen password from anywhere would
-- pass — precisely the attack this feature must not open. GoTrue mints
-- session_id per sign-in, so a marker can only be created by a caller that
-- already redeemed the device secret on that same session.
-- ---------------------------------------------------------------------------
create table if not exists public.trusted_sessions (
  session_id text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  device_id  uuid references public.trusted_devices (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);

create index if not exists trusted_sessions_user_idx on public.trusted_sessions (user_id);
alter table public.trusted_sessions enable row level security;

-- ⚠ NO POLICIES ON EITHER TABLE, DELIBERATELY. Every access goes through the
-- SECURITY DEFINER functions below. A SELECT policy on trusted_devices would
-- expose secret_hash through PostgREST, and no client has any reason to read it.

-- ---------------------------------------------------------------------------
-- 3. The predicate, extended.
--
-- ⚠ THE amr BRANCH IS UNCHANGED — this only ADDS a second route to verified.
-- Anonymous sessions are still rejected before either branch is consulted.
-- SECURITY DEFINER because it now reads trusted_sessions, which has RLS and no
-- policies; `search_path = ''` keeps the elevated body from being hijacked.
-- ---------------------------------------------------------------------------
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
      exists (
        select 1
        from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) as entry
        where entry ->> 'method' in ('otp', 'magiclink', 'oauth', 'sso/saml', 'totp')
           or entry ->> 'method' like 'mfa/%'
      )
      or exists (
        select 1
        from public.trusted_sessions ts
        where ts.session_id = (auth.jwt() ->> 'session_id')
          and ts.user_id = auth.uid()
          and ts.expires_at > now()
      )
    );
$$;

comment on function public.session_is_verified_human() is
  'True for a session that proved control of a real mailbox (amr: otp/magiclink/oauth/sso/totp/mfa), OR one running on a device that previously did so and redeemed its device secret (public.trusted_sessions, keyed by session_id). Anonymous and bare password sessions are false. src/lib/auth/session.js mirrors the amr half; the device half is server-only by design.';

grant execute on function public.session_is_verified_human() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 4. enroll_trusted_device — call ONLY from an already-verified session.
--
-- ⚠ THE session_is_verified_human() CHECK IS THE WHOLE SECURITY BOUNDARY.
-- Without it a bare password session could mint its own device secret and then
-- redeem it to declare itself verified — a complete bypass of the emailed code.
-- Enrolment must be reachable only AFTER a code (or Google) has succeeded.
-- ---------------------------------------------------------------------------
create or replace function public.enroll_trusted_device(p_label text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  if not public.session_is_verified_human() then
    return null;
  end if;

  v_secret := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.trusted_devices (user_id, label, secret_hash)
  values (
    auth.uid(),
    nullif(left(coalesce(p_label, ''), 120), ''),
    encode(extensions.digest(v_secret, 'sha256'), 'hex')
  );

  return v_secret;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. redeem_device_trust — called FROM a password-only session, so it
-- deliberately does not require session_is_verified_human(). The secret is the
-- factor being presented.
--
-- ⚠ SCOPED BY auth.uid() AS WELL AS BY HASH. Matching on hash alone would let a
-- secret enrolled by one account verify a session belonging to another.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_device_trust(p_secret text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device  public.trusted_devices%rowtype;
  v_session text := auth.jwt() ->> 'session_id';
begin
  if auth.uid() is null or p_secret is null or v_session is null then
    return false;
  end if;

  select * into v_device
  from public.trusted_devices d
  where d.user_id = auth.uid()
    and d.secret_hash = encode(extensions.digest(p_secret, 'sha256'), 'hex')
    and d.revoked_at is null
    and d.expires_at > now();

  if not found then
    return false;
  end if;

  insert into public.trusted_sessions (session_id, user_id, device_id)
  values (v_session, auth.uid(), v_device.id)
  on conflict (session_id) do update
    set user_id    = excluded.user_id,
        device_id  = excluded.device_id,
        expires_at = excluded.expires_at;

  update public.trusted_devices set last_used_at = now() where id = v_device.id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. my_trusted_devices — the dashboard list. Never returns secret_hash;
-- `is_current` is resolved from this session's own marker.
-- ---------------------------------------------------------------------------
create or replace function public.my_trusted_devices()
returns table (
  id           uuid,
  label        text,
  created_at   timestamptz,
  last_used_at timestamptz,
  expires_at   timestamptz,
  is_current   boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.label, d.created_at, d.last_used_at, d.expires_at,
         exists (
           select 1 from public.trusted_sessions ts
           where ts.device_id = d.id
             and ts.session_id = (auth.jwt() ->> 'session_id')
         ) as is_current
  from public.trusted_devices d
  where d.user_id = auth.uid()
    and d.revoked_at is null
    and d.expires_at > now()
  order by d.last_used_at desc nulls last, d.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- 7. revoke_trusted_device — "sign out this device", and it means it.
--
-- Three steps, because revoking trust alone is NOT a logout: the other browser
-- would keep a live refresh token and stay signed in (merely unverified) until
-- it expired. Deleting its auth.sessions rows is what actually ends the session,
-- and it is the difference between the button telling the truth and not.
--
-- ⚠ REQUIRES A VERIFIED SESSION. Otherwise a password-only attacker could revoke
-- the real owner's devices — a denial of service against the account.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_trusted_device(p_device_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owned boolean;
begin
  if not public.session_is_verified_human() then
    return false;
  end if;

  select exists (
    select 1 from public.trusted_devices
    where id = p_device_id and user_id = auth.uid()
  ) into v_owned;

  if not v_owned then
    return false;
  end if;

  delete from auth.sessions
  where id::text in (
    select ts.session_id from public.trusted_sessions ts where ts.device_id = p_device_id
  );

  delete from public.trusted_sessions where device_id = p_device_id;

  update public.trusted_devices
  set revoked_at = now()
  where id = p_device_id and user_id = auth.uid();

  return true;
end;
$$;

revoke all on function public.enroll_trusted_device(text) from public, anon;
revoke all on function public.redeem_device_trust(text)   from public, anon;
revoke all on function public.my_trusted_devices()        from public, anon;
revoke all on function public.revoke_trusted_device(uuid) from public, anon;

grant execute on function public.enroll_trusted_device(text) to authenticated;
grant execute on function public.redeem_device_trust(text)   to authenticated;
grant execute on function public.my_trusted_devices()        to authenticated;
grant execute on function public.revoke_trusted_device(uuid) to authenticated;
