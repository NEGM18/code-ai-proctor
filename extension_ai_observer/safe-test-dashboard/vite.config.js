import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],

  // ---------------------------------------------------------------------------
  // Cross-origin isolation for local dev.
  //
  // These MIRROR public/_headers, which is what Cloudflare Pages serves in
  // production — the reasoning and the two warnings live there, not here. The
  // duplication is unavoidable: `_headers` is a Pages deploy artifact and the
  // Vite dev server never reads it, so without this block `crossOriginIsolated`
  // is false in dev and true in production. That difference is exactly the kind
  // that hides a COEP-blocked resource until after deploy.
  //
  // `preview` gets them too, so `npm run preview` reproduces production.
  // ---------------------------------------------------------------------------
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },

  // ---------------------------------------------------------------------------
  // Vitest — PLAN.md §6 Phase 0.
  //
  // `environment: 'node'` is the DEFAULT on purpose. The ported vision suites are
  // 500+ pure-math assertions over plain objects; none of them touch the DOM, and
  // making them pay jsdom's per-file startup would turn the Phase 2 gate from a
  // fast feedback loop into something people skip. Component files opt in
  // individually with a `// @vitest-environment jsdom` docblock on line 1.
  //
  // No `globals` and no `setupFiles`: test files import { describe, it, expect }
  // from 'vitest' explicitly, so ESLint needs no extra globals and a reader can
  // see where every identifier came from. json_eq.js registers its custom matcher
  // through a plain import, which is why no global setup hook is required.
  // ---------------------------------------------------------------------------
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // testing/ holds fixtures and scripts/ is tooling; neither belongs in a
      // coverage denominator that is meant to describe the shipped engine.
      exclude: [
        'src/vision/testing/**',
        '**/*.config.js',
        'scripts/**',
      ],
    },
  },
})
