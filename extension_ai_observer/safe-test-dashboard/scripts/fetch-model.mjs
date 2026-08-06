#!/usr/bin/env node
// =============================================================================
// Fetch the MediaPipe face_landmarker model — PLAN.md §6 Phase 0, §9.
//
// This is THE ONE EXTERNAL DOWNLOAD in the build. It is deliberately NOT wired
// into `postinstall`: hitting the network on every `npm install` is a bad
// trade for a 3.7 MB file that changes approximately never, and PLAN.md §9
// notes Phases 1-4 are fully headless and complete without it.
//
// The .task file is gitignored (see .gitignore) because it is fetched, not
// authored. Run this once after cloning.
//
// WHY float16 AND WHY THIS EXACT MODEL: `refine_landmarks` gives 478 points
// with the irises at 468/473 — precisely the LANDMARK_CONTRACT that
// gaze_landmarks.js has been waiting on since it was written. A different
// face model (468-point, no iris refinement) parses fine and then silently
// yields no iris, which is the failure this whole architecture is built to
// refuse to paper over.
// =============================================================================

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destDir = join(root, 'public', 'models');
const dest = join(destDir, 'face_landmarker.task');

const force = process.argv.includes('--force');

if (existsSync(dest) && !force) {
  const { size } = await stat(dest);
  console.log(
    `[fetch-model] present — ${(size / 1048576).toFixed(1)} MB at public/models/face_landmarker.task` +
    '\n  (pass --force to re-download)'
  );
  process.exit(0);
}

console.log(`[fetch-model] downloading ${MODEL_URL}`);

const res = await fetch(MODEL_URL);
if (!res.ok) {
  console.error(`[fetch-model] FAILED — HTTP ${res.status} ${res.statusText}`);
  console.error('  Phases 1-4 are headless and do not need this file; the camera');
  console.error('  demo will report MODEL_LOAD_FAILED until it is present.');
  process.exit(1);
}

const bytes = Buffer.from(await res.arrayBuffer());

// A truncated or HTML-error-page download is worse than none: it fails deep
// inside the WASM loader with a message that points nowhere near the cause.
if (bytes.byteLength < 1_000_000) {
  console.error(
    `[fetch-model] FAILED — got only ${bytes.byteLength} bytes; expected ~3.7 MB.` +
    '\n  This is usually a captive portal or proxy returning an HTML page.'
  );
  process.exit(1);
}

await mkdir(destDir, { recursive: true });
await writeFile(dest, bytes);

console.log(
  `[fetch-model] ok — ${(bytes.byteLength / 1048576).toFixed(1)} MB -> public/models/face_landmarker.task`
);
