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
  `auth.uid()` (via anonymous sign-in) rather than a bare path prefix.

### 2. Enable anonymous sign-ins (required for the live demo's cloud upload)

The public marketing-site demo has no login, so evidence-snapshot uploads
are bound to a **Supabase anonymous auth** identity, not a path string a
client could claim to own. In the dashboard:

**Authentication → Providers → enable "Allow anonymous sign-ins".**

If this stays off, `signInAnonymously()` fails, `uploadDemoSnapshot()`
returns `{ uploaded: false, reason: 'ANONYMOUS_AUTH_FAILED' }`, and the demo
correctly falls back to local-only — the demo itself still works, only the
optional cloud-persisted evidence copy is unavailable.

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

Restart `npm run dev` after editing `.env.local` — Vite only reads env files
at server start.
