// Writes THIRD-PARTY-NOTICES.txt for a staged Threadbear tree (installer/stage.ps1
// runs it last). It lists every package that ships and carries each one's
// licence text, because MIT, BSD and Apache all ask for the notice to travel with
// copies:
//
//   - Node.js, whose own LICENSE is already in node\ in the tree
//   - the JavaScript packages in the staged runner\node_modules and
//     desktop\node_modules
//   - the packages the UI is built from (the production tree of
//     desktop\package-lock.json, read from desktop\node_modules), since the built
//     UI has no licence comments
//   - the Rust crates linked into Threadbear.exe, from `cargo metadata --locked
//     --offline` for the target, with the licence files that sit in each crate's
//     source in the Cargo registry (so the shell must have been built, or its
//     crates fetched, on this machine)
//
// Where several packages share one licence text it is printed once with the list
// of packages that use it. Nothing in the output is an absolute path, so the
// staged tree can be moved to another machine.
//
//   node installer/make-notices.mjs --stage build/stage-x64 --desktop desktop \
//     --cargo-manifest desktop/src-tauri/Cargo.toml --triple x86_64-pc-windows-msvc \
//     --node-version 24.22.2 --out build/stage-x64/THIRD-PARTY-NOTICES.txt

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function arg(name, required = true) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (required && !v) throw new Error(`--${name} is required`);
  return v;
}

const stage = path.resolve(arg('stage'));
const desktop = path.resolve(arg('desktop'));
const manifest = path.resolve(arg('cargo-manifest'));
const triple = arg('triple');
const nodeVersion = arg('node-version');
const out = path.resolve(arg('out'));

// LICENSE, LICENCE, COPYING, NOTICE, PATENTS (and the odd COPYRIGHT or UNLICENSE),
// in any case and with any extension or suffix: LICENSE-MIT, license.txt, ...
const LICENCE_FILE = /^(licen[sc]e|copying|notice|patents|copyright|unlicen[sc]e)([-_. ].*)?$/i;
const MAX_FILE_BYTES = 400 * 1024;

const read = (f) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trimEnd();

// The licence files in a folder (not below it), plus any the package names itself.
function licenceFiles(dir, alsoNamed = []) {
  const found = [];
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of names) {
    if (!e.isFile()) continue;
    const wanted = LICENCE_FILE.test(e.name) || alsoNamed.some((n) => n.toLowerCase() === e.name.toLowerCase());
    if (!wanted) continue;
    const f = path.join(dir, e.name);
    if (fs.statSync(f).size > MAX_FILE_BYTES) {
      console.warn(`Skipped ${e.name} in ${path.basename(dir)}: over ${MAX_FILE_BYTES / 1024} KB`);
      continue;
    }
    found.push({ name: e.name, text: read(f) });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function cleanRepo(u) {
  if (!u) return '';
  return String(u).replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
}

// ---- JavaScript packages ----

const npm = new Map(); // name@version -> record

function licenceOfPackage(j) {
  if (typeof j.license === 'string') return j.license;
  if (j.license && j.license.type) return j.license.type;
  if (Array.isArray(j.licenses)) return j.licenses.map((l) => l.type || l).join(' OR ');
  return '';
}

function addPackage(dir, recurse) {
  let j;
  try {
    j = JSON.parse(read(path.join(dir, 'package.json')));
  } catch {
    return;
  }
  if (!j.name || !j.version) return;
  const key = `${j.name}@${j.version}`;
  if (!npm.has(key)) {
    const license = licenceOfPackage(j);
    // "SEE LICENSE IN README.md" names the file that holds the terms.
    const named = /SEE LICEN[CS]E IN (\S+)/i.exec(license)?.[1];
    npm.set(key, {
      kind: 'npm',
      name: j.name,
      version: j.version,
      license,
      repo: cleanRepo(typeof j.repository === 'string' ? j.repository : j.repository?.url) || j.homepage || '',
      by: typeof j.author === 'string' ? j.author : j.author?.name || '',
      files: licenceFiles(dir, named ? [named] : []),
    });
  }
  if (recurse) scanNodeModules(path.join(dir, 'node_modules'), true);
}

function scanNodeModules(nm, recurse) {
  let entries;
  try {
    entries = fs.readdirSync(nm, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || !(e.isDirectory() || e.isSymbolicLink())) continue;
    const dir = path.join(nm, e.name);
    if (e.name.startsWith('@')) {
      for (const s of fs.readdirSync(dir, { withFileTypes: true })) {
        if (s.isDirectory() || s.isSymbolicLink()) addPackage(path.join(dir, s.name), recurse);
      }
    } else {
      addPackage(dir, recurse);
    }
  }
}

// What ships in the tree
scanNodeModules(path.join(stage, 'runner', 'node_modules'), true);
scanNodeModules(path.join(stage, 'desktop', 'node_modules'), true);
const shipped = npm.size;

// What the UI is built from: the production entries of the lockfile
let uiCount = 0;
const lockFile = path.join(desktop, 'package-lock.json');
for (const [key, v] of Object.entries(JSON.parse(read(lockFile)).packages ?? {})) {
  if (!key.startsWith('node_modules/') || v.dev || v.link) continue;
  const before = npm.size;
  addPackage(path.join(desktop, key), false);
  if (npm.size > before) uiCount++;
}

// ---- Rust crates ----

const cargo = JSON.parse(
  execFileSync('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', triple, '--manifest-path', manifest], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  }),
);
const byId = new Map(cargo.packages.map((p) => [p.id, p]));
const nodes = new Map(cargo.resolve.nodes.map((n) => [n.id, n]));
const closure = new Set();
const todo = [cargo.resolve.root];
while (todo.length) {
  const id = todo.pop();
  if (closure.has(id)) continue;
  closure.add(id);
  for (const d of nodes.get(id)?.deps ?? []) {
    // Normal dependencies only: build scripts and dev dependencies are not in the exe.
    if (d.dep_kinds.some((k) => k.kind === null)) todo.push(d.pkg);
  }
}
const crates = [];
for (const id of closure) {
  if (id === cargo.resolve.root) continue;
  const p = byId.get(id);
  const dir = path.dirname(p.manifest_path);
  const named = p.license_file ? [path.basename(p.license_file)] : [];
  crates.push({
    kind: 'crate',
    name: p.name,
    version: p.version,
    license: p.license || (p.license_file ? `see ${path.basename(p.license_file)}` : ''),
    repo: cleanRepo(p.repository || p.homepage) || '',
    by: (p.authors ?? []).join(', '),
    files: licenceFiles(dir, named),
  });
}

// ---- The node\LICENSE the tree already carries ----

if (!fs.existsSync(path.join(stage, 'node', 'LICENSE'))) throw new Error('node\\LICENSE is missing from the staged tree');

// ---- Output ----

const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true });
const packages = [...npm.values()].sort(byName);
crates.sort(byName);

const mpl = [...packages, ...crates].filter((e) => /MPL/i.test(e.license));
const lines = [];
const out_ = (...l) => lines.push(...l);
const rule = '='.repeat(78);
const thin = '-'.repeat(78);

out_(
  'THREADBEAR FOR WINDOWS: THIRD-PARTY NOTICES',
  '',
  'Threadbear is released under the MIT licence (see LICENSE in this folder). This',
  'package includes the software below, each under its own licence. The licence',
  'texts follow the lists, copied from each package or crate, because the licences',
  'ask for them to be passed on with copies.',
  '',
  'Where several entries use the same text, it is printed once with the list of',
  'who uses it. An entry whose package carried no licence file is listed at the',
  'end with the licence it declares.',
  '',
  `1. Node.js ${nodeVersion} (node\\node.exe)`,
  `2. JavaScript packages (${packages.length})`,
  `3. Rust crates linked into Threadbear.exe (${crates.length})`,
  '4. Licence texts',
  '5. Entries with no licence file',
  '',
  'The Rust crates are the ones linked for Windows (' + triple + '), found by',
  '`cargo metadata`. Their licence texts are the files shipped inside each crate.',
  ...(mpl.length
    ? [
        'These are under the MPL-2.0 and are used unmodified: ' + mpl.map((e) => e.name).join(', ') + '.',
        'Their source is on crates.io and at the repository shown against each.',
      ]
    : []),
  '',
  rule,
  `1. NODE.JS ${nodeVersion}`,
  rule,
  '',
  'Node.js is under the MIT licence. Its LICENSE file, which also gives the',
  'licences of the components Node.js bundles (V8, OpenSSL, ICU and others), is',
  'node\\LICENSE in this folder. Source and releases: https://nodejs.org/',
  '',
  rule,
  `2. JAVASCRIPT PACKAGES (${packages.length})`,
  rule,
  `Of these, ${shipped} are in the runner's and the bridge's node_modules and`,
  `${uiCount} more are what the built UI is made of (React, the Markdown renderer and so on).`,
  '',
);
for (const p of packages) {
  out_(`${p.name}@${p.version}`, `    Licence: ${p.license || '(not stated)'}`, ...(p.repo ? [`    ${p.repo}`] : []));
}
out_(
  '',
  rule,
  `3. RUST CRATES LINKED INTO THREADBEAR.EXE (${crates.length})`,
  rule,
  '',
);
for (const c of crates) {
  out_(`${c.name} ${c.version}`, `    Licence: ${c.license || '(not stated)'}`, `    ${c.repo ? c.repo + '  ' : ''}https://crates.io/crates/${c.name}/${c.version}`);
}

// Group identical licence texts across everything
const groups = new Map();
const noFile = [];
for (const e of [...packages, ...crates]) {
  if (e.files.length === 0) {
    noFile.push(e);
    continue;
  }
  for (const f of e.files) {
    const key = f.text.replace(/\s+/g, ' ').trim();
    if (!groups.has(key)) groups.set(key, { text: f.text, users: [] });
    groups.get(key).users.push(`${e.name} ${e.version}${e.kind === 'crate' ? ' (crate)' : ''}: ${f.name}`);
  }
}
const ordered = [...groups.values()].sort((a, b) => a.users[0].localeCompare(b.users[0]));

out_('', rule, `4. LICENCE TEXTS (${ordered.length})`, rule);
for (const g of ordered) {
  out_('', thin, 'Used by:', ...[...new Set(g.users)].sort().map((u) => `    ${u}`), thin, '', g.text);
}

out_('', rule, `5. ENTRIES WITH NO LICENCE FILE (${noFile.length})`, rule, '');
if (noFile.length === 0) {
  out_('None.');
} else {
  out_('These carried no licence file in the package. The licence is the one they declare.', '');
  for (const e of noFile) {
    out_(`${e.name} ${e.version}`, `    Licence: ${e.license || '(not stated)'}`, ...(e.by ? [`    By: ${e.by}`] : []), `    ${e.repo || (e.kind === 'crate' ? `https://crates.io/crates/${e.name}/${e.version}` : '')}`);
  }
}
out_('');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, '﻿' + lines.join('\r\n'), 'utf8');

// What a person should look at before a release
const odd = [...packages, ...crates].filter((e) => !e.license || /GPL|SEE LICEN|UNLICENSED|FSL|BUSL|SSPL|-NC\b|proprietary|commercial/i.test(e.license));
console.log(`Wrote ${path.basename(out)}: ${packages.length} packages, ${crates.length} crates, ${ordered.length} licence texts, ${noFile.length} without a licence file (${Math.round(fs.statSync(out).size / 1024)} KB)`);
for (const e of odd) console.log(`  Check: ${e.name} ${e.version}: ${e.license || '(no licence stated)'}`);
for (const e of noFile) console.log(`  No licence file: ${e.name} ${e.version} (${e.license || 'none stated'})`);
