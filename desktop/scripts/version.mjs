// The Windows app's version. One number, in desktop/package.json, and the
// places that repeat it have to agree with it:
//
//   desktop/src-tauri/Cargo.toml        [package] version
//   desktop/src-tauri/Cargo.lock        the threadbear-desktop entry
//   desktop/src-tauri/tauri.conf.json   "version"
//
//   node desktop/scripts/version.mjs --print        the version
//   node desktop/scripts/version.mjs --check        fail if any file disagrees
//   node desktop/scripts/version.mjs --set 0.2.0    change all of them
//
// Semantic versioning: while the major is 0, a minor bump is a round of
// features (or anything that changes how the app behaves), a patch bump is
// fixes only. Bump it once per release, measured from the latest release tag,
// and open a heading for it in desktop/CHANGELOG.md. The runner has its own
// version (runner/package.json) and is not tied to this one.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = (...p) => path.join(desktop, ...p);
const read = (f) => fs.readFileSync(f, 'utf8');
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// Each place: how to read its version, and how to write a new one.
const places = [
  {
    name: 'desktop/package.json',
    file: file('package.json'),
    get: (t) => JSON.parse(t).version,
    set: (t, v) => t.replace(/("version"\s*:\s*")[^"]*(")/, `$1${v}$2`),
  },
  {
    name: 'desktop/src-tauri/Cargo.toml',
    file: file('src-tauri', 'Cargo.toml'),
    get: (t) => /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(t)?.[1],
    set: (t, v) => t.replace(/(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${v}$2`),
  },
  {
    name: 'desktop/src-tauri/Cargo.lock',
    file: file('src-tauri', 'Cargo.lock'),
    get: (t) => /name = "threadbear-desktop"\r?\nversion = "([^"]+)"/.exec(t)?.[1],
    set: (t, v) => t.replace(/(name = "threadbear-desktop"\r?\nversion = ")[^"]+(")/, `$1${v}$2`),
  },
  {
    name: 'desktop/src-tauri/tauri.conf.json',
    file: file('src-tauri', 'tauri.conf.json'),
    get: (t) => JSON.parse(t).version,
    set: (t, v) => t.replace(/("version"\s*:\s*")[^"]*(")/, `$1${v}$2`),
  },
];

const current = () => places.map((p) => ({ ...p, version: p.get(read(p.file)) }));
const [mode, arg] = process.argv.slice(2);

if (mode === '--print') {
  console.log(current()[0].version);
} else if (mode === '--check') {
  const all = current();
  const want = all[0].version;
  let bad = false;
  if (!SEMVER.test(want ?? '')) {
    console.error(`${all[0].name} says "${want}", which is not a semantic version`);
    bad = true;
  }
  for (const p of all) {
    if (p.version !== want) {
      console.error(`${p.name} says ${p.version ?? '(nothing)'}, but ${all[0].name} says ${want}`);
      bad = true;
    }
  }
  if (bad) process.exit(1);
  console.log(`Version ${want}: every file agrees`);
} else if (mode === '--set') {
  if (!arg || !SEMVER.test(arg)) {
    console.error('Usage: node desktop/scripts/version.mjs --set 1.2.3');
    process.exit(2);
  }
  for (const p of places) {
    const before = read(p.file);
    const after = p.set(before, arg);
    if (p.get(after) !== arg) {
      console.error(`Could not set the version in ${p.name}`);
      process.exit(1);
    }
    if (after !== before) fs.writeFileSync(p.file, after);
  }
  console.log(`Set ${arg} in ${places.length} files. Add a heading for it to desktop/CHANGELOG.md.`);
} else {
  console.error('Usage: node desktop/scripts/version.mjs --print | --check | --set <version>');
  process.exit(2);
}
