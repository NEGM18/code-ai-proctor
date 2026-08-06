// Run every extension test suite.
//
//   node extension/test/run_all.js
//
// No dependencies and no build step - each suite loads the real content scripts
// and exits non-zero on failure, so this is CI-ready as-is.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const suites = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let failed = 0;

for (const suite of suites) {
  process.stdout.write(`\n${'='.repeat(60)}\n${suite}\n${'='.repeat(60)}\n`);
  try {
    const out = execFileSync(process.execPath, [path.join(dir, suite)], { encoding: 'utf8' });
    process.stdout.write(out);
  } catch (err) {
    failed++;
    process.stdout.write(err.stdout || '');
    process.stdout.write(err.stderr || '');
    process.stdout.write(`\n>>> ${suite} FAILED\n`);
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(failed === 0
  ? `All ${suites.length} suites passed.`
  : `${failed} of ${suites.length} suites FAILED.`);
process.exit(failed === 0 ? 0 : 1);
