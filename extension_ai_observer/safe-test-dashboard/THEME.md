# THEME.md — Procminds design system for `safe-test-dashboard`

> Read this before touching `src/styles/theme.css`, adding a color, or wiring
> up a new brand asset. It documents two things that must never get merged
> into one: the **verdict ramp** (what the proctoring UI is allowed to say
> about a student) and **brand chrome** (what this looks like as a product).

---

## 1. Two systems, one file

`src/styles/theme.css` holds both. They are visually adjacent and must stay
functionally separate.

| System | Purpose | Tokens | May a new component invent a new one? |
|---|---|---|---|
| **Verdict ramp** | Reports proctoring state. Every value is asserted by name across the codebase and in `PLAN.md` §4/§7. | `--color-verified`, `--color-violation`, `--color-glance`, `--color-unknown`, `--color-unknown-dim`, `--color-suppressed` | **No.** This ramp is closed. See §3. |
| **Brand chrome** | What Procminds looks like — logo, nav, CTAs, focus rings, marketing surfaces. Carries no claim about a student. | `--color-base`, `--color-surface`, `--color-surface-raised`, `--color-brand-cyan`, `--color-brand-blue` | Yes, freely — this is ordinary product branding. |

If you are ever unsure which bucket a new color belongs in, ask: *"does this
pixel assert something about what the camera saw?"* If yes, it's a verdict
color and belongs in the ramp, using the existing tokens. If no — it's
chrome, and belongs here.

---

## 2. Source of truth

Everything in this section was ported from **`D:\procmindscountdown`**
(`procminds.com`, the live launch-countdown site) on **2026-08-06**, not
invented fresh:

- **Logo** — `public/brand/logo.png`, `logo-original.png`,
  `logo-transparent.png`, copied byte-for-byte from the countdown site's
  `dist/`. Use `logo-transparent.png` on dark chrome (nav, footer); the other
  two are full-bleed/social-card variants.
- **Surface neutrals** — `--color-base` / `--color-surface` are the
  countdown page's `brand.darker` (`#03060D`) and `brand.dark` (`#050B18`).
  `--color-surface-raised` (`#0D1526`) is not a literal port — the countdown
  page doesn't have a third surface step — it's a new value chosen to keep
  the same *relative brightness gap* the previous three-step ramp had.
- **Brand chrome accent** — `--color-brand-cyan` (`#00D2FF`) and
  `--color-brand-blue` (`#0F64B4`) are the countdown page's `brand.cyan` /
  `brand.blue`.
- **Heading font** — Space Grotesk, used for headings on the countdown page.
  Self-hosted via `@fontsource-variable/space-grotesk` (npm), **not** the
  Google Fonts CDN the countdown page actually uses — see §4.

**Deliberately not ported:** `brand.teal`, `brand.deep`, FontAwesome, the
glassmorphism `.glass-panel` CSS (this app already has an equivalent `.glass`
utility with its own oklab `color-mix`), and the grid/orb background
decoration. None of those were asked for, and porting decoration nobody
requested is how a scoped brand-harmonization task turns into a rewrite.

---

## 3. ⚠ Why the verdict ramp is protected, and why a "brand refresh" is
   exactly the kind of change that breaks it

This app's actual product differentiator, per `PLAN.md` §1/§4, is that it
**refuses to fabricate a reading**. The verdict ramp's fifth color —
`--color-unknown` — is not a neutral, it's the whole point: it's what
renders when the system genuinely cannot tell, instead of guessing. Every
other color in the ramp (`verified`/`violation`/`glance`/`suppressed`) is
likewise a specific, asserted claim, not a decorative choice.

A brand-consistency pass is a natural place for this to quietly break,
because the request is usually phrased as "make it match the brand palette"
— and `--color-verified` *was already* being misused as decorative chrome
before this pass (the old `Nav.jsx` used it for the logo dot and the primary
CTA, neither of which reports any proctoring verdict). That reuse is exactly
the ambiguity this ramp exists to prevent: once a verdict token is also "the
brand green," nothing stops the next contributor from picking
`--color-violation` because "red looks urgent" for an unrelated warning
banner, and now a real accusation color is diluted by decorative use
elsewhere in the app.

This pass fixes that instance (`Nav.jsx` now uses `--color-brand-cyan` /
`--color-brand-blue` for the mark and CTA) and adds the rule going forward:
**verdict tokens are never used outside a component that is reporting an
actual proctoring read.** If a future rebrand wants "the primary CTA to pop
more," change `--color-brand-cyan`, not `--color-verified`.

---

## 4. No CDN, ever

The countdown page pulls Google Fonts and FontAwesome from a CDN. This app
does not, and that's not an oversight to fix — it's the same rule the vision
runtime already follows (`@mediapipe/tasks-vision`'s WASM + model are
self-hosted under `public/`, specifically so a proctoring demo never phones
out for its own runtime). A font request is a smaller version of the same
leak: it tells a third party when and how often this page loads. Space
Grotesk was added via `@fontsource-variable/space-grotesk` for the same
reason Inter and JetBrains Mono already are. Icons stay on `lucide-react`
(already a dependency) rather than adding FontAwesome.

---

## 5. Full token reference

```css
/* brand chrome — decorative, no verdict meaning */
--color-base: #03060d;
--color-surface: #050b18;
--color-surface-raised: #0d1526;
--color-brand-cyan: #00d2ff;
--color-brand-blue: #0f64b4;

/* verdict ramp — CLOSED. Do not add, rename, or repurpose. */
--color-verified: #10b981;       /* eyes open, centered — safe */
--color-verified-dim: #065f46;
--color-violation: #ef4444;      /* a reported, evidenced accusation */
--color-violation-dim: #7f1d1d;
--color-glance: #f59e0b;         /* marginal, deliberately not escalated */
--color-glance-dim: #78350f;
--color-unknown: #64748b;        /* unreadable — never a number */
--color-unknown-dim: #334155;
--color-suppressed: #7c3aed;     /* evidence a safeguard blocked a false hit */

/* type */
--font-sans: 'Inter Variable', ui-sans-serif, system-ui, sans-serif;
--font-mono: 'JetBrains Mono Variable', ui-monospace, monospace;
--font-heading: 'Space Grotesk Variable', 'Inter Variable', ui-sans-serif, sans-serif;
```

`--font-heading` is for headings only (`Nav`'s wordmark, section `<h1>`/`<h2>`s
going forward). Body copy stays on `--font-sans`; every live telemetry
readout stays on `--font-mono` with the existing `.tnum` utility.
