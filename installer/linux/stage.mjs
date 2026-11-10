// Assembles the folder the Linux package is made from, and the .tar.gz of it:
//
//   threadbear-desktop         the desktop shell (desktop-tauri/src-tauri)
//   node/bin/node              the pinned Node (installer/node.json), so nothing
//                              has to be on the PATH
//   runner/                    the runner's source and its production packages
//   desktop/bridge, dist, ...  the bridge the shell starts, and the built UI
//   docs/                      the guide and protocol every thread's agent is
//                              pointed at, and what they point to
//   install.sh                 puts a launcher in the applications menu
//   LICENSE, README.md, INSTALL.md, README-LINUX.txt, THIRD-PARTY-NOTICES.txt
//
// The same layout the repo has, so the shell finds the bridge and the runner
// finds its guide without being told. The tree is relocatable: nothing in it
// names this machine's folders. This is installer/stage.ps1 for Linux, in
// Node so that it runs where the shell was built.
//
//   node installer/linux/stage.mjs --arch x64 --shell desktop-tauri/src-tauri/target/release/threadbear-desktop
//
// Options: --arch x64|arm64 (default: this machine's), --version (default:
// desktop-tauri/package.json's), --out (default: build/linux-<arch>, and the
// .tar.gz goes beside it), --no-tar.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const ARCHES = { x64: { elf: 0x3e, triple: 'x86_64-unknown-linux-gnu', node: 'x64' }, arm64: { elf: 0xb7, triple: 'aarch64-unknown-linux-gnu', node: 'arm64' } };
const arch = arg('arch', os.arch() === 'arm64' ? 'arm64' : 'x64');
if (!ARCHES[arch]) throw new Error(`--arch is x64 or arm64, not ${arch}`);
const shell = arg('shell');
if (!shell || !fs.existsSync(shell)) throw new Error(`The shell was not found at ${shell}. Build it first (npx tauri build --no-bundle in desktop-tauri/)`);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
const out = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();

const version = arg('version') || out(process.execPath, [path.join(repo, 'desktop-tauri', 'scripts', 'version.mjs'), '--print']);
const base = path.resolve(arg('out', path.join(repo, 'build', `linux-${arch}`)));
const name = `threadbear-v${version}-linux-${arch}`;
const stage = path.join(base, name);

// An ELF file for this architecture, so an x64 program can never be packaged as
// arm64 (the stage.ps1 check of the PE machine field, for ELF).
export function elfMachine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(20);
    fs.readSync(fd, b, 0, 20, 0);
    if (b.readUInt32BE(0) !== 0x7f454c46) return undefined; // not ELF
    return b.readUInt16LE(18);
  } finally {
    fs.closeSync(fd);
  }
}
function assertElf(file, label) {
  const m = elfMachine(file);
  if (m !== ARCHES[arch].elf) throw new Error(`${label} is not an ${arch} Linux program (ELF machine 0x${(m ?? 0).toString(16)})`);
}
assertElf(shell, 'The shell');

// The folder is emptied first, so refuse one that looks like it is not a stage.
if (fs.existsSync(stage)) {
  if (fs.readdirSync(stage).length && !fs.existsSync(path.join(stage, 'threadbear-desktop'))) throw new Error(`${stage} is not empty and does not look like an earlier stage. Pick an empty folder.`);
  fs.rmSync(stage, { recursive: true, force: true });
}
fs.mkdirSync(stage, { recursive: true });

const copy = (from, to) => fs.cpSync(from, to, { recursive: true, force: true, dereference: false });

// --- Shell
fs.copyFileSync(shell, path.join(stage, 'threadbear-desktop'));
fs.chmodSync(path.join(stage, 'threadbear-desktop'), 0o755);

// --- Node: the pinned release, checked against the SHA-256 in node.json
{
  const pin = JSON.parse(fs.readFileSync(path.join(repo, 'installer', 'node.json'), 'utf8'));
  const want = pin.sha256[`linux-${arch}`];
  if (!want) throw new Error(`installer/node.json has no sha256 for linux-${arch}`);
  const file = `node-v${pin.version}-linux-${ARCHES[arch].node}`;
  const downloads = path.join(repo, 'build', 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const tarball = path.join(downloads, `${file}.tar.xz`);
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  if (!fs.existsSync(tarball) || sha(tarball) !== want) {
    const url = `https://nodejs.org/dist/v${pin.version}/${file}.tar.xz`;
    console.log(`Downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
    const got = sha(tarball);
    if (got !== want) {
      fs.rmSync(tarball, { force: true });
      throw new Error(`${file}.tar.xz does not match the pinned SHA-256 (wanted ${want}, got ${got})`);
    }
  }
  console.log(`${file}.tar.xz matches its pinned SHA-256`);
  // Only the program and the licence: the runner does not need npm.
  const tmp = fs.mkdtempSync(path.join(downloads, 'extract-'));
  run('tar', ['-xJf', tarball, '-C', tmp, `${file}/bin/node`, `${file}/LICENSE`]);
  fs.mkdirSync(path.join(stage, 'node', 'bin'), { recursive: true });
  fs.copyFileSync(path.join(tmp, file, 'bin', 'node'), path.join(stage, 'node', 'bin', 'node'));
  fs.chmodSync(path.join(stage, 'node', 'bin', 'node'), 0o755);
  fs.copyFileSync(path.join(tmp, file, 'LICENSE'), path.join(stage, 'node', 'LICENSE'));
  fs.rmSync(tmp, { recursive: true, force: true });
  assertElf(path.join(stage, 'node', 'bin', 'node'), 'node');
}

// --- Runner: source plus production packages only
const runner = path.join(stage, 'runner');
fs.mkdirSync(path.join(runner, 'scripts'), { recursive: true });
copy(path.join(repo, 'runner', 'src'), path.join(runner, 'src'));
copy(path.join(repo, 'runner', 'bin'), path.join(runner, 'bin'));
for (const f of ['windows-run.mjs', 'install-linux.mjs', 'agent-sdk.mjs', 'agent-sdk-preload.mjs']) fs.copyFileSync(path.join(repo, 'runner', 'scripts', f), path.join(runner, 'scripts', f));
for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(repo, 'runner', f), path.join(runner, f));
// --os/--cpu so a build on x64 gets arm64's native packages (oxc-parser ships one
// per platform). --ignore-scripts: nothing here needs an install script, and
// none should run on a build machine.
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--os=linux', `--cpu=${ARCHES[arch].node}`], { cwd: runner });
const nodeModules = path.join(runner, 'node_modules');

// The Agent SDK is not shipped (Anthropic's, all rights reserved); the first
// start fetches it from npm, checked against the hash in package-lock.json
// (scripts/agent-sdk.mjs). That also drops the platform packages with their own
// copy of Claude Code, which the runner never runs.
{
  const anthropic = path.join(nodeModules, '@anthropic-ai');
  if (fs.existsSync(anthropic)) {
    for (const d of fs.readdirSync(anthropic)) {
      if (d.startsWith('claude-agent-sdk')) {
        console.log(`Leaving out ${d}: fetched from npm on the first start`);
        fs.rmSync(path.join(anthropic, d), { recursive: true, force: true });
      }
    }
    if (!fs.readdirSync(anthropic).length) fs.rmSync(anthropic, { recursive: true, force: true });
  }
  if (fs.existsSync(path.join(nodeModules, '@anthropic-ai', 'claude-agent-sdk'))) throw new Error('The Agent SDK is still in the staged runner. It must not ship.');
  const lock = JSON.parse(fs.readFileSync(path.join(runner, 'package-lock.json'), 'utf8')).packages['node_modules/@anthropic-ai/claude-agent-sdk'] || {};
  if (!(lock.version && lock.resolved && lock.integrity)) throw new Error('package-lock.json has no version, address and hash for the Agent SDK, so the first start could not fetch it.');
  console.log(`The Agent SDK ${lock.version} is fetched on the first start from ${lock.resolved}`);
}

// Sentry's command line tool is pulled in by a build plugin the runner never loads.
{
  const cli = path.join(nodeModules, 'sentry');
  try {
    if (JSON.parse(fs.readFileSync(path.join(cli, 'package.json'), 'utf8')).name === 'sentry') {
      console.log("Leaving out sentry, Sentry's command line tool");
      fs.rmSync(cli, { recursive: true, force: true });
    }
  } catch {
    // not there
  }
}

// Files nothing reads at run time: type declarations, source maps, markdown.
// Licence files are never pruned, whatever their extension.
{
  const keep = /^(licen[sc]e|copying|notice|patents|copyright|unlicen[sc]e)([-_. ].*)?$/i;
  const drop = /(\.d\.[cm]?ts|\.map|\.md|\.markdown)$/i;
  let n = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && drop.test(e.name) && !keep.test(e.name)) {
        fs.rmSync(p);
        n++;
      }
    }
  };
  walk(nodeModules);
  console.log(`Pruned ${n} declaration, map and markdown files from the runner's packages (licence files stay)`);
}

// --- Desktop: the bridge, the built UI, and the one package the bridge needs
{
  const desk = path.join(stage, 'desktop');
  const bridgeSrc = path.join(repo, 'desktop-tauri', 'bridge');
  const bridgeDst = path.join(desk, 'bridge');
  fs.mkdirSync(bridgeDst, { recursive: true });
  // bridge.ts and the files next to it that it imports (never the tests)
  const queue = ['bridge.ts'];
  const copied = new Set();
  while (queue.length) {
    const f = queue.shift();
    if (copied.has(f)) continue;
    copied.add(f);
    fs.copyFileSync(path.join(bridgeSrc, f), path.join(bridgeDst, f));
    const text = fs.readFileSync(path.join(bridgeSrc, f), 'utf8');
    for (const m of text.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+['"]\.\/([\w.-]+\.ts)['"]/gm)) queue.push(m[1]);
  }
  fs.copyFileSync(path.join(repo, 'desktop-tauri', 'package.json'), path.join(desk, 'package.json'));
  const dist = path.join(repo, 'desktop-tauri', 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('desktop-tauri/dist is not built. Run npm run build in desktop-tauri/');
  copy(dist, path.join(desk, 'dist'));
  const ws = path.join(repo, 'desktop-tauri', 'node_modules', 'ws');
  if (!fs.existsSync(ws)) throw new Error('desktop-tauri/node_modules/ws is missing. Run npm ci in desktop-tauri/');
  copy(ws, path.join(desk, 'node_modules', 'ws'));
  // The Terminal's pseudo-terminal (bridge/terminal.ts): @lydell/node-pty and the package
  // for this platform with its prebuilt addon. desktop-tauri/node_modules has the build machine's
  // platform only, so npm installs the target's (--os/--cpu) from the lockfile, checked
  // against its hashes, in a folder of its own. Nothing is compiled and no script runs.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'threadbear-pty-'));
  try {
    for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(repo, 'desktop-tauri', f), path.join(work, f));
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--os=linux', `--cpu=${ARCHES[arch].node}`], { cwd: work });
    const prebuilt = path.join(work, 'node_modules', '@lydell', `node-pty-linux-${ARCHES[arch].node}`, 'prebuilds', `linux-${ARCHES[arch].node}`, 'pty.node');
    if (!fs.existsSync(prebuilt)) throw new Error(`The terminal's @lydell/node-pty-linux-${ARCHES[arch].node} package did not install, so the Terminal would not work. Is it in desktop-tauri/package-lock.json?`);
    copy(path.join(work, 'node_modules', '@lydell'), path.join(desk, 'node_modules', '@lydell'));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// --- The docs the runner points agents at, licence, readmes
fs.mkdirSync(path.join(stage, 'docs'), { recursive: true });
for (const f of ['guide.md', 'protocol.md', 'on-your-mac.md']) fs.copyFileSync(path.join(repo, 'docs', f), path.join(stage, 'docs', f));
for (const f of ['LICENSE', 'README.md', 'INSTALL.md']) fs.copyFileSync(path.join(repo, f), path.join(stage, f));
fs.copyFileSync(path.join(here, 'readme-linux.txt'), path.join(stage, 'README-LINUX.txt'));
fs.copyFileSync(path.join(here, 'install.sh'), path.join(stage, 'install.sh'));
fs.chmodSync(path.join(stage, 'install.sh'), 0o755);
fs.copyFileSync(path.join(repo, 'desktop-tauri', 'src-tauri', 'icons', '128x128@2x.png'), path.join(stage, 'threadbear.png'));

// --- Third-party notices: the licence of everything that ships
{
  const pin = JSON.parse(fs.readFileSync(path.join(repo, 'installer', 'node.json'), 'utf8'));
  run(process.execPath, [
    path.join(repo, 'installer', 'make-notices.mjs'),
    '--stage', stage,
    '--desktop', path.join(repo, 'desktop-tauri'),
    '--cargo-manifest', path.join(repo, 'desktop-tauri', 'src-tauri', 'Cargo.toml'),
    '--triple', ARCHES[arch].triple,
    '--node-version', pin.version,
    '--out', path.join(stage, 'THIRD-PARTY-NOTICES.txt'),
  ]);
}

// --- The tarball, with the folder as its one top-level entry, and its hash
if (!flag('no-tar')) {
  const tarball = path.join(base, `${name}.tar.gz`);
  fs.rmSync(tarball, { force: true });
  // Owner and group are root's name for everything, whoever built it; the
  // order is by name, so the same tree packs to the same bytes.
  run('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', tarball, '-C', base, name]);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  fs.writeFileSync(`${tarball}.sha256`, `${sum}  ${name}.tar.gz\n`);
  console.log(`${tarball}\n${sum}`);
}
console.log(`Staged ${stage}`);
