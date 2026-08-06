#!/usr/bin/env node
// =============================================================================
// check-vision-sync.mjs — proves src/vision/*.js is still a faithful ESM port
// of the READ-ONLY extension modules in ../extension/content/vision/.
//
// The six files under src/vision/ were copied from the extension with ONE kind
// of change: the module wrapper. Every such edit is fenced by
//
//     // >>> ESM PORT   … // <<< ESM PORT
//
// Everything OUTSIDE those fences must be byte-identical to the upstream body
// region recorded in src/vision/UPSTREAM.json. This script recomputes both
// sides and compares them, so "we did not touch the math" is a mechanical
// claim rather than a promise.
//
// Exit codes:
//   0  all six in sync, OR upstream is absent (dashboard-only checkout)
//   1  a drift, a missing file, or a malformed sentinel block
//
// See UPSTREAM.json -> hash.normalization for the exact algorithm; this file
// implements it and nothing else.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VISION_DIR = path.join(ROOT, 'src', 'vision');
const MANIFEST_PATH = path.join(VISION_DIR, 'UPSTREAM.json');

const OK = '\u2713';
const NO = '\u2717';

// --- normalization (UPSTREAM.json hash.normalization steps 1-4) -------------
function toLines(raw) {
  let s = raw;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);          // step 2
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');       // step 3
  const lines = s.split('\n');                             // step 4
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
function readLines(file) {
  return toLines(readFileSync(file, 'utf8'));              // step 1
}
// --- steps 7-8 --------------------------------------------------------------
function digest(lines) {
  return createHash('sha256').update(lines.join('\n') + '\n', 'utf8').digest('hex');
}

/**
 * Step 6 — every line of a ported file that is NOT inside a sentinel block.
 * Throws on an unopened close, a nested open, or an unclosed block: a
 * malformed fence would silently shrink what we verify.
 */
function stripSentinels(lines, open, close, label) {
  const kept = [];
  let depth = 0;
  let openedAt = 0;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t === open) {
      if (depth) throw new Error(`${label}:${i + 1} nested "${open}" (block opened at line ${openedAt})`);
      depth = 1;
      openedAt = i + 1;
      return;
    }
    if (t === close) {
      if (!depth) throw new Error(`${label}:${i + 1} "${close}" with no matching "${open}"`);
      depth = 0;
      return;
    }
    if (!depth) kept.push(line);
  });
  if (depth) throw new Error(`${label}: unterminated "${open}" block opened at line ${openedAt}`);
  return kept;
}

/** Step 5 — concatenate the upstream body ranges (1-based, inclusive). */
function collectRanges(lines, ranges, label) {
  const out = [];
  for (const [start, end] of ranges) {
    if (start < 1 || end > lines.length || end < start) {
      throw new Error(`${label}: body range ${start}-${end} is outside the file (${lines.length} lines)`);
    }
    out.push(...lines.slice(start - 1, end));
  }
  return out;
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function main() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`${NO} src/vision/UPSTREAM.json is missing — cannot verify the vision port.`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const { open, close } = manifest.sentinels;
  const upstreamDir = path.resolve(ROOT, manifest.upstreamRoot);

  console.log('vision port sync check');
  console.log(`  ported   ${path.relative(ROOT, VISION_DIR)}`);
  console.log(`  upstream ${upstreamDir}`);
  console.log('');

  // A dashboard-only checkout has no extension tree. That is not a failure:
  // the port is self-contained and must still build. Skip, exit 0, say so.
  if (!existsSync(upstreamDir)) {
    console.log(`  skipped — upstream not present at ${upstreamDir}`);
    console.log('  (dashboard-only checkout: src/vision/*.js is self-contained and still builds;');
    console.log('   re-run this check from a full checkout to verify it against the extension.)');
    return 0;
  }

  let failures = 0;
  for (const entry of manifest.files) {
    const portedPath = path.join(VISION_DIR, entry.file);
    const upstreamPath = path.join(upstreamDir, entry.file);
    const ranges = entry.bodyRanges.map(([a, b]) => `${a}-${b}`).join(',');
    try {
      if (!existsSync(portedPath)) throw new Error(`ported file missing: ${path.relative(ROOT, portedPath)}`);
      if (!existsSync(upstreamPath)) throw new Error(`upstream file missing: ${upstreamPath}`);

      const upstreamLines = readLines(upstreamPath);
      if (upstreamLines.length !== entry.upstreamTotalLines) {
        throw new Error(
          `upstream is now ${upstreamLines.length} lines, was ${entry.upstreamTotalLines} at port time — ` +
          're-review the port and regenerate UPSTREAM.json'
        );
      }
      const upstreamBody = collectRanges(upstreamLines, entry.bodyRanges, entry.upstream);
      const upstreamSha = digest(upstreamBody);
      const portedBody = stripSentinels(readLines(portedPath), open, close, entry.file);
      const portedSha = digest(portedBody);

      // Recorded vs upstream, and recorded vs ported, are DIFFERENT failures.
      // One says the extension moved; the other says the port was edited.
      if (upstreamSha !== entry.sha256) {
        throw new Error(
          `UPSTREAM CHANGED since the port.\n` +
          `      recorded ${entry.sha256}\n` +
          `      upstream ${upstreamSha}\n` +
          `      The extension is read-only for this project; if it legitimately changed,\n` +
          `      re-port the affected region and regenerate UPSTREAM.json deliberately.`
        );
      }
      if (portedSha !== upstreamSha) {
        const i = firstDifference(portedBody, upstreamBody);
        const detail = i === -1
          ? ''
          : `\n      first difference at ported body line ${i + 1} of ${portedBody.length} ` +
            `(upstream body has ${upstreamBody.length} lines)\n` +
            `      upstream: ${JSON.stringify(upstreamBody[i] ?? '<end of body>')}\n` +
            `      ported  : ${JSON.stringify(portedBody[i] ?? '<end of body>')}`;
        throw new Error(
          `PORT DRIFTED from upstream.\n` +
          `      upstream ${upstreamSha}\n` +
          `      ported   ${portedSha}` + detail + `\n` +
          `      Everything outside the "${open}" fences must stay byte-identical.`
        );
      }

      console.log(`  ${OK} ${entry.file.padEnd(22)} lines ${ranges.padEnd(9)} sha256 ${portedSha.slice(0, 12)}…`);
    } catch (err) {
      failures++;
      console.log(`  ${NO} ${entry.file.padEnd(22)} lines ${ranges.padEnd(9)} ${err.message}`);
    }
  }

  console.log('');
  if (failures) {
    console.log(`${NO} ${failures} of ${manifest.files.length} vision module(s) OUT OF SYNC with the extension.`);
    return 1;
  }
  console.log(`${OK} all ${manifest.files.length} vision modules byte-identical to the extension.`);
  return 0;
}

let code;
try {
  code = main();
} catch (err) {
  console.error(`${NO} check-vision-sync failed: ${err.stack || err.message}`);
  code = 1;
}
process.exit(code);
