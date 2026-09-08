# ProcMinds telemetry

PostHog instrumentation for the dashboard and the `ProcMinds Observer` extension,
under one rule: **no plaintext biometric content, ever, by any path.**

---

## 1. Configuration

### Dashboard

`safe-test-dashboard/.env.local`:

```
VITE_PUBLIC_POSTHOG_KEY=phc_your_project_key
VITE_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

> **⚠ `VITE_*` VALUES ARE INLINED AT BUILD TIME, ON WHOEVER'S MACHINE RAN THE
> BUILD.** Editing `.env.local` changes nothing until the next `npm run build`.
> A deploy from a checkout with no key produces a permanently telemetry-free site
> that looks completely healthy — `isTelemetryConfigured` is false and every
> function is a silent no-op. This is the same trap CLAUDE.md's 2026-08-11 entry
> records for `VITE_SUPABASE_*`, and it has already cost this project one
> debugging session. To check what actually shipped:
> `curl -s https://<host>/assets/index-*.js | grep -o 'phc_[A-Za-z0-9]*'`

Only a **`phc_` project key** is accepted. A `phx_`/`phs_` personal API key is
refused with a console error, because it is an account-scoped read/write
credential and this bundle is served to every visitor.

### Extension

`extension/background/worker.js` → `POSTHOG_PROJECT_KEY`. Empty means telemetry
is **off**, which is the correct default for a checkout. The same `phc_`
validation applies.

The manifest's `content_security_policy.extension_pages` must keep its
`connect-src`:

```
script-src 'self'; object-src 'self'; connect-src 'self' https://*.posthog.com https://xokefpfhwcxuvjmxfzke.supabase.co
```

> **⚠ `connect-src` FALLS BACK TO `default-src`.** A CSP of `default-src 'self'`
> with no `connect-src` blocks every event **silently** — `capture()` returns
> normally, the integration looks healthy, and zero events arrive. The wildcard
> is deliberate: PostHog documents that its subdomains change over time and only
> guarantees `*.posthog.com`. Supabase is in the list because the **popup** loads
> `supabase_rest.js`; removing it breaks popup sign-in, not telemetry.
>
> **⚠ This CSP governs extension pages and the service worker ONLY. It does NOT
> govern content scripts**, which run under the *host page's* CSP. That
> distinction is what destroyed ORT's threading (CLAUDE.md §4), and it is why no
> content script here ever calls `fetch`.

---

## 2. Architecture

```
  DASHBOARD (React/Vite)              EXTENSION (MV3)
  ────────────────────────            ─────────────────────────────────
  components                          content scripts / popup
      │ import from index.js              │ window.SafeTestTelemetry
      ▼                                   ▼
  posthog.js ──► redact.js            telemetry_bridge.js  (scrubs, no I/O)
      │                                   │ chrome.runtime.sendMessage
      ▼                                   ▼
  posthog-js ──────────────►  PostHog  ◄── telemetry_transport.js
                                           (service worker: durable queue,
                                            batched raw fetch, own scrubber)
```

**Content scripts never open a socket.** All extension egress belongs to the
service worker. See `telemetry_transport.js`'s header for the three reasons — in
short: posthog-js cannot run in an MV3 worker, a content script's network is
governed by the exam host, and a tab dies with its queue.

---

## 3. What is deliberately NOT captured

| Not sent | Why |
|---|---|
| Webcam frames, `imageB64`, `snapshotB64`, `dataUrl` | The product's core promise. Only `image_length` is sent. |
| **Gemini's `observation` / `explanation` sentence** | A natural-language rendering of a webcam frame — *"the candidate is holding a phone near their face"*. The likeliest thing to leak, because it reads as a harmless string. Only `observation_length`. |
| `ek`, `iv`, `sha256`, ciphertext, plaintext | Envelope internals. `sha256` is a **confirmation oracle** against the plaintext frame. |
| Student email, name, organisation | Dropped, **not hashed** — a hash over a roster-sized input space is not anonymisation. |
| Supabase access/refresh tokens | Scrubbed by key name and by JWT shape. |
| Landmark / keypoint arrays | Biometric. Shape only. |

**Sent on purpose:** `kid` (a public key *identifier*, not key material — it is
what makes a decryption failure diagnosable) and `sig_alg` (whether an envelope
was signed is an integrity property that must be auditable in aggregate; see
CLAUDE.md 2026-08-22 (c), where every envelope silently degraded to unsigned).

### Session replay

Every `<img>`, `<canvas>` and `<video>` is **blocked** — an allowlist, not a
denylist, so a future evidence component is safe by default rather than safe
until someone forgets.

> **⚠ `ph-no-capture` BLOCKS AN ELEMENT. `ph-mask` ONLY MASKS TEXT.** Reaching for
> the class whose name contains "mask" to hide a webcam preview is the single
> mistake that ships a frame. (`ph-capture` does not exist at all; an element
> marked with it is recorded normally, with no warning.)
>
> **⚠ Blocking, not masking, is what stops the data-URL leak.** rrweb serialises
> every attribute of every non-blocked element verbatim, so
> `<img src="data:image/jpeg;base64,…">` puts the whole frame into the snapshot
> as an attribute value. `EvidenceGallery.jsx` renders exactly that shape.

Autocapture is **off**: it records element text and attributes, and the evidence
thumbnails carry `alt="Evidence snapshot for PHONE_DETECTED"`.

> **⚠ AUDITING `posthog.init()` DOES NOT TELL YOU THE EFFECTIVE MASKING.**
> PostHog's project-level *Privacy and masking* settings are applied from the
> server **after** this config and can widen or narrow it. Check both.

---

## 4. Adding an event

1. Add the name to `EVENTS` in `events.js`. Never type a bare string at a call
   site — PostHog creates an event definition on first sight and never deletes
   it, so a typo is a permanent half-empty series.
2. Emit via `capture(EVENTS.YOUR_EVENT, {...})` from `index.js`.
3. Pass the **length** of anything large, never the thing.

## 5. Adding a feature flag

Declare it in `FLAGS` (`flags.js`) with an explicit `fallback`.

> **⚠ A FLAG MAY SWITCH UI, SAMPLING OR TELEMETRY VERBOSITY. IT MAY NEVER SWITCH
> A DETECTION THRESHOLD OR A SUPPRESSION RULE.** `assertNotSafetyCritical()`
> throws on any key naming a detection surface. CLAUDE.md §5 pins those as local,
> tested constants; a remote payload has no test coverage, no code review, no
> audit trail, and evaluates *per distinct_id* — so two candidates could sit the
> same exam under different rules.

`getFeatureFlag()` returns `undefined` while flags load, and forever if PostHog
never loads (ad blocker, corporate proxy — the normal case, not an edge case).
The fallback is what the product does when the vendor is unreachable.

## 6. Surveys

`maybeShowSurvey()` **refuses to display during an active sitting**, and fails
closed if the predicate throws. Two reasons, either sufficient: it is a modal
overlay on a timed exam, and a survey triggered by a detector event tells the
candidate that a detector fired — the labelled feedback loop CLAUDE.md §5
forbids, arriving through a door nobody was watching.
`disable_surveys_automatic_display` is the other half; without it PostHog pops
surveys on its own schedule and the guard never runs.

---

## 7. The duplicated redactor

`extension/background/telemetry_transport.js` carries a **hand-mirrored copy** of
`redact.js`'s rules. It cannot import the real one: that file is ESM behind Vite,
and `extension/` has no build step. `REDACT_CONTRACT_VERSION` is pinned across
both by `extension/test/telemetry_transport.test.js` — **bump one without the
other and that suite goes red**, which is the point.

## 8. Tests

```bash
npx vitest run src/lib/telemetry                      # dashboard
node ../extension/test/telemetry_transport.test.js    # extension
```
