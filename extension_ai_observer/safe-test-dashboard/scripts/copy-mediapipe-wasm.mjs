#!/usr/bin/env node
// =============================================================================
// Copy the MediaPipe tasks-vision WASM runtime into public/ — PLAN.md §6 Phase 0.
//
// WHY THIS EXISTS AT ALL: FilesetResolver.forVisionTasks() takes a base path and
// fetches the .wasm/.js loader from it at runtime. The documented convenience is
// to point it at a CDN. We do not: PLAN.md §2 decides the vision runtime is
// self-hosted, because a proctoring demo whose central claim is "nothing leaves
// your machine" must not phone out for the engine that makes the claim. So the
// runtime has to be a real file under public/, and something has to put it there.
//
// It runs from `postinstall`, so a fresh `npm install` is sufficient to get a
// working tree — no separate setup step to forget. public/mediapipe/ is
// gitignored for the same reason node_modules is: it is a derived artifact.
//
// Idempotent, and deliberately quiet on the happy path.
// =============================================================================

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dest = join(root, 'public', 'mediapipe', 'wasm');

// `npm install` runs postinstall in contexts where the package may legitimately
// be absent — a --omit=optional install, or a partial CI restore. Failing the
// whole install over it would be worse than a warning: the app degrades to
// MODEL_LOAD_FAILED, which PLAN.md §7 already defines a visible UI state for.
if (!existsSync(src)) {
  console.warn(
    '[copy-mediapipe-wasm] SKIPPED — @mediapipe/tasks-vision is not installed.\n' +
    '  The camera demo will report MODEL_LOAD_FAILED until you run:\n' +
    '    npm install @mediapipe/tasks-vision && npm run postinstall'
  );
  process.exit(0);
}

// Replace rather than merge. A stale .wasm left behind by a previous version
// would be served alongside the new loader, and a version-skewed WASM/JS pair
// fails at instantiation with an error that points nowhere near the real cause.
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });

const files = await readdir(dest);
let bytes = 0;
for (const f of files) bytes += (await stat(join(dest, f))).size;

console.log(
  `[copy-mediapipe-wasm] ${files.length} files ` +
  `(${(bytes / 1024 / 1024).toFixed(1)} MB) -> public/mediapipe/wasm/`
);
