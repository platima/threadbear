// Runs the runner's unit tests on Windows in two groups: the files that
// should pass (a failure fails the run) and the ones in
// test/windows-known-failing.txt (a report, so the list can shrink as the
// port goes). Usage, from runner/:
//
//   node scripts/test-windows.mjs            the files that should pass
//   node scripts/test-windows.mjs --known    the known-failing files, as a report
//   node scripts/test-windows.mjs a.test.ts  just those files
//
// Each test gets 15 seconds, not the package's five minutes, so a test
// waiting on something Windows can't give fails quickly.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unit = path.join(root, 'test', 'unit');
const listFile = path.join(root, 'test', 'windows-known-failing.txt');

const known = new Set(
  fs
    .readFileSync(listFile, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean),
);
const all = fs.globSync('**/*.test.ts', { cwd: unit }).map((f) => f.split(path.sep).join('/')).sort();

for (const k of known) {
  if (!all.includes(k)) {
    console.error(`windows-known-failing.txt lists ${k}, which is not a unit test file`);
    process.exit(2);
  }
}

const args = process.argv.slice(2);
const wantKnown = args.includes('--known');
const named = args.filter((a) => !a.startsWith('--'));
const files = named.length ? named : all.filter((f) => known.has(f) === wantKnown);

console.log(`${wantKnown ? 'known-failing' : 'expected-to-pass'}: ${files.length} files`);
const r = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=spec', '--test-timeout=15000', '--test-force-exit', ...files.map((f) => path.join(unit, f))],
  { cwd: root, stdio: 'inherit' },
);
// The known list is a report: it never fails the run.
process.exit(wantKnown ? 0 : (r.status ?? 1));
