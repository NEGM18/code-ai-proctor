# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is enabled on this template. See [this documentation](https://react.dev/learn/react-compiler) for more information.

Note: This will impact Vite dev & build performances.

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Supabase setup

The app runs **fully without Supabase configured** — every code path in
`src/lib/supabase.js`, `src/lib/auth/`, and `src/lib/demoSnapshots.js` is an
explicit no-op (never a silent one) until you complete the steps below, and
the UI shows a "local only — not uploaded" chip instead of pretending
anything was saved.

### 1. Run the migrations

Open your Supabase project → **SQL Editor** and run the two files in
`supabase/migrations/` **in order** (they're timestamp-prefixed for that
reason), or, if you have the Supabase CLI linked to the project:

```bash
supabase db push
```

- `20260804120000_roles_and_profiles.sql` — the `role` enum
  (`student | teacher | organization`), the `profiles` table, its
  auto-provisioning trigger on `auth.users`, and RLS policies. Read the
  comments inline — in particular the "DECISION" comment on why teachers do
  **not** get blanket read access to every student profile in this phase.
- `20260804120100_demo_snapshots_bucket.sql` — the private `demo-snapshots`
  storage bucket and its RLS policies, scoped to `demo/{auth.uid()}/*`. Read
  the "Access model" comment for why the scoping key is the caller's
  `auth.uid()` rather than a bare path prefix.
- `20260805120000_violations_and_sessions.sql`, `20260805130000_proctor_codes.sql`
- `20260810120000_verified_session_gate.sql` — **the sign-in wall.** Adds
  `public.session_is_verified_human()` and rewrites the demo/storage/violation
  policies to require it. Read its header before changing anything about auth:
  it explains why `to authenticated` was never a gate, and why a *password-only*
  session is refused.

### 2. Turn anonymous sign-ins OFF

> ⚠ **This instruction is the reverse of what this README said before
> 2026-08-10, and the reversal is the point.** The demo used to call
> `signInAnonymously()` for every visitor, which is what made it reachable
> without an account: Supabase issues an anonymous visitor a real JWT with
> `role: authenticated`, and every policy written at the time accepted it.

**Authentication → Providers → "Allow anonymous sign-ins" → OFF.**

The migration's predicate already rejects anonymous sessions, so this is
belt-and-braces — but the two failure modes look nothing alike in practice.
With the setting on, a guest still gets a token and an `auth.users` row and
only meets the wall at their first query; with it off, GoTrue refuses at
`/signup` and no row is ever created. Local dev is already covered by
`enable_anonymous_sign_ins = false` in `supabase/config.toml`.

### 2b. Enable Google, and leave email confirmations off

**Authentication → Providers → Google → enable**, then paste the Client ID
and Client Secret from a Google Cloud OAuth 2.0 Web client whose *Authorised
redirect URIs* include:

```
https://<your-project-ref>.supabase.co/auth/v1/callback
```

That redirect URI is **Supabase's** callback, not this app's — it is the only
value Google ever needs, on every environment. Do not add the site's own URLs
there.

**Authentication → URL Configuration** — two fields, and both matter:

| Field | Value |
|---|---|
| **Site URL** | `https://procminds-preview.pages.dev` |
| **Redirect URLs** | `https://procminds-preview.pages.dev/demo-quiz`, `https://procminds.com/demo-quiz`, `https://safetest.space/demo-quiz` |

> ⚠ **SITE URL DEFAULTS TO `http://localhost:3000`, AND THAT DEFAULT IS THE BUG.**
> It is where GoTrue sends anyone whose `redirectTo` is not on the Redirect URLs
> list, and what `{{ .SiteURL }}` renders as in mail. Left at the default, a
> perfectly correct Google sign-in on the preview ends on a dead localhost tab —
> with no error anywhere, because from GoTrue's side nothing failed.

> ⚠ **NO localhost ENTRY IS COMING, AND NONE IS WANTED.**
> `procminds-preview.pages.dev` is the tester — a throwaway twin of
> `procminds.com`, safe to break. Adding a localhost redirect here would still
> not make a local sign-in work, because Google's OAuth client has no localhost
> origin either; it buys nothing and implies a route that does not exist. Deploy
> with `npm run deploy` and test there.

A missing **Redirect URLs** entry does not error either — Google succeeds and
drops the visitor on the Site URL, which reads as a broken demo button.

Leave **"Confirm email" OFF**. Verification has moved, not disappeared: an
email+password sign-in is followed by a 6-digit code (`signInWithOtp` →
`verifyOtp`), and `session_is_verified_human()` refuses the password-only
session until that code is entered. Turning confirmations on as well sends a
second email per sign-up and, against the default 2-emails-per-hour limit,
routinely burns the quota before the visitor ever gets the code they need.
Configure real SMTP (**Project Settings → Auth → SMTP**) before any load
beyond hand testing — the built-in sender is rate-limited and not for
production.

The local CLI stack reads the same two values from the environment on
`supabase start`. **Nothing in the auth flow is tested there** — the Google
client and the hosted project only trust the preview — so these matter solely
if you are running `supabase db push`/`db reset` against a local database:

```
SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=<client id>
SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=<client secret>
```

### 2c. What "signed in" means here

One definition, in two places that must stay in step:

| where | what |
|---|---|
| Server (authoritative) | `public.session_is_verified_human()` — `20260810120000_verified_session_gate.sql` |
| Client (renders the wall) | `isVerifiedSession()` — `src/lib/auth/session.js`, pinned by `src/lib/auth/__tests__/session.test.js` |

Both accept a session whose JWT `amr` carries `otp`, `magiclink`, `oauth`,
`sso/saml`, `totp` or `mfa/*`, and both reject anonymous sessions and
password-only ones. `/demo-quiz` renders `DemoGate` until that predicate
passes; the extension bridge refuses to start proctoring without an access
token; and RLS refuses every upload regardless of what the UI did.

### 2d. The 6-digit code email

Supabase sends it. There is no mail provider integration, no Edge Function and
no server code of ours in the path — GoTrue renders
`supabase/templates/magic_link.html` and delivers it.

**1 — Know which template fires.** `signInWithOtp()` on an *existing* account
sends the **Magic Link** template. Not "Confirm signup" — that one is for
sign-up confirmations, which are off (§2b). Restyling the wrong template and
wondering why nothing changes is the standard afternoon lost here.

**2 — Paste the template into the Dashboard.** Copy
`supabase/templates/magic_link.html` verbatim into **Authentication → Email
Templates → Magic Link**, and set the subject to `Your Procminds sign-in code`.

> ⚠ **The Dashboard is a COPY, and it is the one production actually sends.**
> The hosted project reads nothing from this repo — `content_path` in
> `supabase/config.toml` only points the local CLI stack at the file. The two
> drift silently, and the symptom is production mail looking nothing like what
> you tested. Re-paste after every change. Passing `email_template.test.js`
> (`npm test`) only verifies the local repository file (`supabase/templates/magic_link.html`),
> which is *not* the same as pinning production.
> **Mandatory Deployment Step**: You must manually copy the contents of
> `supabase/templates/magic_link.html` and paste them into **Supabase Dashboard →
> Authentication → Email Templates → Magic link or OTP** for production deployments to output `{{ .Token }}`.

> ⚠ **The template must keep `{{ .Token }}`.** That is the 6 digits. A template
> built around `{{ .ConfirmationURL }}` instead still renders, still sends and
> still reports success, while the visitor has nothing to type into the code
> step. The suite fails if it goes missing.

**3 — Raise the email rate limit.** **Authentication → Rate Limits → "Rate
limit for sending emails"**. Every password sign-in now sends a code, so the
default of 2/hour locks you out on your third test — and it surfaces to the
visitor as a sign-in that has simply stopped working, with the real reason only
in the auth logs.

**4 — Check it end to end** on the preview: sign in with a password, confirm
the mail arrives carrying the code, and confirm `/demo-quiz` opens after the
code — and immediately after Google, with no code step at all.

#### Delivery: Resend as Supabase's SMTP

This project sends through **Resend configured as custom SMTP inside Supabase**
— **Project Settings → Auth → SMTP**:

| Field | Value |
|---|---|
| Host | `smtp.resend.com` |
| Port | `465` (TLS; `587` also works) |
| Username | `resend` |
| Password | your Resend API key (`re_…`) |
| Sender email | an address on a **verified** Resend domain |

⚠ **This is still Supabase-powered, and the distinction matters.** Supabase
renders the template above and sends the message; Resend is only the carrier.
There is no Edge Function, no webhook and no code of ours in the send path —
nothing to deploy, nothing to keep secrets for, and nothing that breaks if
Resend is swapped for another provider later.

⚠ **The sender address must be on a Resend-verified domain.** An unverified
sender, or Resend's shared `onboarding@resend.dev`, delivers only to the Resend
account owner — everyone else silently gets nothing while Supabase reports the
mail as sent.

⚠ **Custom SMTP is what makes step 3's rate limit real.** Supabase's built-in
sender is rate-limited and explicitly provided for testing with no delivery
guarantee; with SMTP configured, the per-hour limit is yours to set. If you
ever remove the SMTP settings, the built-in sender takes over again and the
2/hour ceiling comes back with it.

#### When no email arrives

| Symptom | Cause |
|---|---|
| Sign-in errors after ~2 attempts in an hour | The rate limit in step 3 |
| Nothing arrives at all, no error in the app | Built-in sender throttling or spam-filtering — check **Logs → Auth**, then configure SMTP |
| Code arrives but the email is unstyled | The Dashboard copy is stale, or was pasted into "Confirm signup" instead of "Magic Link" |
| Email arrives with a link and no digits | `{{ .ConfirmationURL }}` template still in the Dashboard; paste ours |
| `verifyOtp` rejects a correct-looking code | Code older than `otp_expiry` (60 min), or already used once |

> **⚠ Config lives in two directories, and this is a known wart.** The CLI
> config is at the repo root (`supabase/config.toml`) while the migrations and
> the email template are under `safe-test-dashboard/supabase/`. The
> `content_path` in that config is written relative to the repo root
> accordingly.

### 3. Paste the project URL and anon key

Edit `.env.local` at the repo root (already gitignored except for
`.env.example`) and replace the placeholder values with the real ones from
**Project Settings → API**:

```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<the "anon" / "public" key — a long JWT, NOT the service_role key>
```

Use the **anon/public** key only. The service_role key bypasses RLS
entirely and must never be shipped to a browser bundle;
`isSupabaseConfigured` (in `src/lib/supabase.js`) checks that the value is
structurally a JWT (three base64url segments, a decodable header, a
plausible length) specifically so that pasting the wrong kind of value, or
leaving the checked-in placeholder, is caught rather than silently
"working" with the wrong credentials.

**⚠ These are BUILD-time values, and the preview is built on your machine.**
`npm run deploy` runs `vite build` locally and ships the output to
`procminds-preview.pages.dev`, so the keys are read from *your* `.env.local` and
baked into the bundle at that moment. Consequences worth knowing before you
chase a phantom Supabase outage:

- Editing `.env.local` changes nothing on the preview until you **redeploy**.
- Deploying from a checkout with placeholder or missing values ships a site
  where `isSupabaseConfigured` is false — no auth, no uploads, and the UI
  honestly says "local only" rather than erroring.
- If the build ever moves to Cloudflare's CI, the same two `VITE_` vars must be
  set in the Pages project's build environment; a Pages build does not see
  `.env.local`.

(`npm run dev` also only reads env files at server start, so restart it after
an edit — but the dev server is not where auth is exercised; see §2b.)

### 3b. Deploy and test on the preview

```bash
npm run deploy
```

Builds and publishes to **`https://procminds-preview.pages.dev`** — the
throwaway twin of `procminds.com`, and the only place the sign-in flow can
actually complete. Break it freely. `deploy:prod` is deliberately blocked while
production runs the launch countdown.

The extension already injects on this host: `https://*.pages.dev/*` is in
`extension/manifest.json`'s `content_scripts.matches`, and `pages.dev` is in
`DEMO_HOSTS` (`extension/content/monitor.js`), which is what puts the session
into the guest hardware profile — CPU-only, ~5 FPS, `detectStride: 1`. See
`CLAUDE.md` §4.
