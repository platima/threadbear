// The Windows app's version. One number, in desktop-tauri/package.json, and the
// places that repeat it have to agree with it:
//
//   desktop-tauri/src-tauri/Cargo.toml        [package] version
//   desktop-tauri/src-tauri/Cargo.lock        the threadbear-desktop entry
//   desktop-tauri/src-tauri/tauri.conf.json   "version"
//
//   node desktop-tauri/scripts/version.mjs --print        the version
//   node desktop-tauri/scripts/version.mjs --check        fail if any file disagrees
//   node desktop-tauri/scripts/version.mjs --set 0.2.0    change all of them
//   node desktop-tauri/scripts/version.mjs --valid 0.2.0  exit 0 if it is a version we accept
//
// Semantic versioning: while the major is 0, a minor bump is a round of
// features (or anything that changes how the app behaves), a patch bump is
// fixes only. Bump it once per release, measured from the latest release tag,
// and open a heading for it in desktop-tauri/CHANGELOG.md. The runner has its own
// version (runner/package.json) and is not tied to this one.
//
// What is accepted is strict semver 2.0 without build metadata: no leading
// zeros (01.2.3 is refused), no empty pre-release part (1.0.0-. is refused),
// and no "+build" (Windows Installer has no place for it). release.sh,
// release.yml and installer/build-installers.ps1 all go by this one pattern.
//
// A pre-release (0.2.0-rc.1) keeps its suffix in the file names and the
// setup exe, but the MSI's ProductVersion has to be numbers only, so it drops
// the suffix: the MSI of 0.2.0-rc.1 and of 0.2.0 both say 0.2.0. The MSI
// upgrades in place when the version is the same (AllowSameVersionUpgrades in
// threadbear.wxs), so installing an rc's MSI over the final release replaces
// it with the rc, and the final over the rc replaces the rc. Install a
// pre-release only on a machine you do not mind moving back. Windows Installer
// also limits the numbers: major and minor up to 255, patch up to 65535.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = (...p) => path.join(desktop, ...p);
const read = (f) => fs.readFileSync(f, 'utf8');
// semver.org's own grammar, minus build metadata
const NUM = '(?:0|[1-9]\\d*)';
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-${PRE_ID}(?:\\.${PRE_ID})*)?$`);
// Why a version is refused, or undefined when it is fine
const problem = (v) => {
  if (!SEMVER.test(v ?? '')) return `"${v}" is not a semantic version (1.2.3 or 1.2.3-rc.1, no leading zeros, no +build)`;
  const [major, minor, patch] = v.split('-')[0].split('.').map(Number);
  if (major > 255 || minor > 255 || patch > 65535) return `"${v}" is too big for Windows Installer (major and minor up to 255, patch up to 65535)`;
  return undefined;
};

// Each place: how to read its version, and how to write a new one.
const places = [
  {
    name: 'desktop-tauri/package.json',
    file: file('package.json'),
    get: (t) => JSON.parse(t).version,
    set: (t, v) => t.replace(/("version"\s*:\s*")[^"]*(")/, `$1${v}$2`),
  },
  {
    name: 'desktop-tauri/src-tauri/Cargo.toml',
    file: file('src-tauri', 'Cargo.toml'),
    get: (t) => /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(t)?.[1],
    set: (t, v) => t.replace(/(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${v}$2`),
  },
  {
    name: 'desktop-tauri/src-tauri/Cargo.lock',
    file: file('src-tauri', 'Cargo.lock'),
    get: (t) => /name = "threadbear-desktop"\r?\nversion = "([^"]+)"/.exec(t)?.[1],
    set: (t, v) => t.replace(/(name = "threadbear-desktop"\r?\nversion = ")[^"]+(")/, `$1${v}$2`),
  },
  {
    name: 'desktop-tauri/src-tauri/tauri.conf.json',
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
  const why = problem(want);
  if (why) {
    console.error(`${all[0].name} says ${why}`);
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
} else if (mode === '--valid') {
  // For scripts: the version without its leading v (release.sh, release.yml)
  const why = problem(arg);
  if (why) {
    console.error(why);
    process.exit(1);
  }
} else if (mode === '--set') {
  if (!arg || problem(arg)) {
    if (arg) console.error(problem(arg));
    console.error('Usage: node desktop-tauri/scripts/version.mjs --set 1.2.3');
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
  console.log(`Set ${arg} in ${places.length} files. Add a heading for it to desktop-tauri/CHANGELOG.md.`);
} else {
  console.error('Usage: node desktop-tauri/scripts/version.mjs --print | --check | --valid <version> | --set <version>');
  process.exit(2);
}
