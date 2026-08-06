// =============================================================================
// toJsonEqual — registers a Vitest matcher preserving the upstream bespoke
// harness's equality EXACTLY: `JSON.stringify(actual) === JSON.stringify(expected)`.
//
// Every ported suite (extension/test/*.test.js) used this literal comparison
// via a hand-rolled `check(name, actual, expected)`. Vitest's built-in
// `toEqual` is NOT a substitute: `JSON.stringify` maps `NaN` (and `Infinity`,
// and `undefined` inside an array) to `null`, and NaN-vs-null is precisely how
// "unreadable"/"unknown" is represented throughout this codebase (see
// gaze_landmarks.js's `hRatio: NaN` on a closed eye, and CLAUDE.md's repeated
// "closed eyes must never produce ... never a direction, a magnitude, or a
// deviant sample" rule). `toEqual` treats `NaN` as equal only to `NaN` and
// `null` as equal only to `null` — a strictly NARROWER relation — so porting
// `check(name, Number.isFinite(x.hRatio), false)`-style assertions across with
// `toEqual` would silently pass today and silently stop catching the bug the
// upstream authors were pinning. Where the upstream test compared
// `JSON.stringify` output, this file reproduces that, not `toEqual`.
//
// Registered by importing this module for its side effect — no global setup
// hook, per vite.config.js's Vitest block (PLAN.md §6 Phase 0): every test
// file that uses `.toJsonEqual()` does `import '../testing/json_eq.js'` (or
// the relative equivalent) once, near its other imports.
// =============================================================================

import { expect } from 'vitest';

/**
 * @param {*} received
 * @param {*} expected
 */
function toJsonEqual(received, expected) {
  const gotStr = JSON.stringify(received);
  const wantStr = JSON.stringify(expected);
  const pass = gotStr === wantStr;
  return {
    pass,
    message: () =>
      `expected JSON.stringify(received) ${pass ? 'not ' : ''}to equal JSON.stringify(expected)\n\n`
      + `received: ${gotStr}\n`
      + `expected: ${wantStr}\n\n`
      + '(compared via JSON.stringify, matching the upstream extension test '
      + 'harness exactly — NaN/undefined/Infinity all serialize to null, which '
      + 'is load-bearing: it is how "unreadable" is represented throughout '
      + 'this codebase.)',
  };
}

expect.extend({ toJsonEqual });
