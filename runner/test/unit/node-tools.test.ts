// runner/src/node-tools.ts: starting npm, npx and a package's programs from Node, on
// Windows (where they are .cmd files Node won't start) and everywhere else. Most of
// it is checked with the platform handed in, so every machine says what Windows does;
// the last tests run the real thing on whatever machine this is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { onlyOnWindows } from '../helpers/platform.ts';
import { cmdArg, commandFor, nodeBin, npmCommand, npxCommand, pathWith, tarProgram } from '../../src/node-tools.ts';

const WIN = { platform: 'win32' as const };
const NODE_DIR = 'C:\\Program Files\\nodejs';
const NODE = `${NODE_DIR}\\node.exe`;
const has = (...files: string[]) => (f: string) => files.includes(f);
// The command line cmd.exe is given: the line to run, in one more pair of quotes.
const wrap = (line: string) => `"${line}"`;

test('cmd.exe arguments: plain words as they are, anything else quoted, quotes and percents refused', () => {
  assert.equal(cmdArg('ci'), 'ci');
  assert.equal(cmdArg('--no-audit'), '--no-audit');
  assert.equal(cmdArg('web/dist'), 'web/dist');
  assert.equal(cmdArg('C:\\Tools\\npm.cmd'), 'C:\\Tools\\npm.cmd');
  assert.equal(cmdArg(''), '""');
  assert.equal(cmdArg('npm run web:build'), '"npm run web:build"');
  assert.equal(cmdArg('C:\\Program Files (x86)\\nodejs\\npm.cmd'), '"C:\\Program Files (x86)\\nodejs\\npm.cmd"');
  assert.equal(cmdArg('a&b|c<d>e^f'), '"a&b|c<d>e^f"');
  // A backslash before the closing quote would escape it for the program that reads the line next.
  assert.equal(cmdArg('C:\\My Dir\\'), '"C:\\My Dir\\\\"');
  assert.throws(() => cmdArg('say "hi"'), /quote or percent/);
  assert.throws(() => cmdArg('%PATH%'), /quote or percent/);
  assert.throws(() => cmdArg('two\nlines'), /quote or percent/);
});

test('commandFor: off Windows, and for a program that is not a .cmd, it is the file and its arguments', () => {
  assert.deepEqual(commandFor('npm', ['ci'], { platform: 'linux' }), { file: 'npm', args: ['ci'] });
  assert.deepEqual(commandFor('C:\\Git\\cmd\\git.exe', ['status'], WIN), { file: 'C:\\Git\\cmd\\git.exe', args: ['status'] });
  // A bare name is looked up on the PATH as .exe, .cmd, .bat in turn.
  const env = { Path: 'C:\\Windows;C:\\Git\\cmd' };
  assert.deepEqual(commandFor('git', ['status'], { ...WIN, env, exists: has('C:\\Git\\cmd\\git.exe') }), { file: 'C:\\Git\\cmd\\git.exe', args: ['status'] });
});

test('commandFor: a .cmd goes to cmd.exe as one line it has quoted itself, which Node must not touch', () => {
  const cmd = 'C:\\Program Files (x86)\\nodejs\\npm.cmd';
  const c = commandFor(cmd, ['ci', '--no-audit'], { ...WIN, env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
  assert.equal(c.file, 'C:\\Windows\\System32\\cmd.exe');
  // /s drops the outer pair of quotes, so the line inside keeps its own.
  assert.deepEqual(c.args, ['/d', '/s', '/c', wrap('"C:\\Program Files (x86)\\nodejs\\npm.cmd" ci --no-audit')]);
  assert.equal(c.windowsVerbatimArguments, true);
  // A folder with a space or brackets is quoted whole, and an argument with a space too.
  const build = commandFor(cmd, ['run', 'a b'], { ...WIN, env: {} });
  assert.equal(build.file, 'cmd.exe');
  assert.equal(build.args[3], wrap('"C:\\Program Files (x86)\\nodejs\\npm.cmd" run "a b"'));
  // A name with no extension that is found as npm.cmd on the PATH takes the same road.
  const found = commandFor('npm', ['--version'], { ...WIN, env: { PATH: 'C:\\Tools' }, exists: has('C:\\Tools\\npm.cmd') });
  assert.equal(found.args[3], wrap('C:\\Tools\\npm.cmd --version'));
  // What cmd.exe would read for itself is refused, not passed on.
  assert.throws(() => commandFor(cmd, ['%COMSPEC%'], WIN), /quote or percent/);
});

test('npm: node runs npm-cli.js where it is, else npm.cmd goes through cmd.exe, and off Windows it is npm', () => {
  const cli = `${NODE_DIR}\\node_modules\\npm\\bin\\npm-cli.js`;
  assert.deepEqual(npmCommand(NODE, ['ci'], { ...WIN, exists: has(cli) }), { file: NODE, args: [cli, 'ci'] });
  const viaCmd = npmCommand(NODE, ['ci'], { ...WIN, env: {}, exists: has(`${NODE_DIR}\\npm.cmd`) });
  assert.equal(viaCmd.file, 'cmd.exe');
  assert.equal(viaCmd.args[3], wrap('"C:\\Program Files\\nodejs\\npm.cmd" ci'));
  assert.equal(viaCmd.windowsVerbatimArguments, true);
  // Beside Node on Linux, else the PATH's.
  assert.deepEqual(npmCommand('/opt/node/bin/node', ['ci'], { platform: 'linux', exists: has('/opt/node/bin/npm') }), { file: '/opt/node/bin/npm', args: ['ci'] });
  assert.deepEqual(npmCommand('/opt/node/bin/node', ['ci'], { platform: 'linux', exists: () => false }), { file: 'npm', args: ['ci'] });
});

test('a package program is found by its bin name, in a plain or a scoped package', () => {
  const modules = path.join(tmpDir(), 'node_modules');
  const pkg = (dir: string, json: object, file: string) => {
    fs.mkdirSync(path.join(modules, dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(modules, dir, 'package.json'), JSON.stringify(json));
    fs.writeFileSync(path.join(modules, dir, file), '');
  };
  pkg('convex', { name: 'convex', bin: { convex: 'bin/main.js' } }, 'bin/main.js');
  pkg('@convex-dev/static-hosting', { name: '@convex-dev/static-hosting', bin: { 'static-hosting': 'dist/cli/index.js' } }, 'dist/cli/index.js');
  pkg('tsc-like', { name: 'tsc-like', bin: 'cli.js' }, 'cli.js');
  pkg('broken', { name: 'broken', bin: { gone: 'missing.js' } }, 'other.js');
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  assert.equal(nodeBin(modules, 'convex'), path.join(modules, 'convex', 'bin', 'main.js'));
  assert.equal(nodeBin(modules, 'static-hosting'), path.join(modules, '@convex-dev', 'static-hosting', 'dist', 'cli', 'index.js'));
  assert.equal(nodeBin(modules, 'tsc-like'), path.join(modules, 'tsc-like', 'cli.js'));
  assert.equal(nodeBin(modules, 'gone'), undefined, 'a bin whose file is not there is not found');
  assert.equal(nodeBin(modules, 'nothing'), undefined);
  assert.equal(nodeBin(path.join(modules, 'nowhere'), 'convex'), undefined);
});

test('npx: on Windows the package program is run with node, so npx.cmd is not needed; elsewhere it is npx', () => {
  const dir = tmpDir();
  const bin = path.join(dir, 'node_modules', 'convex', 'bin', 'main.js');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'convex', 'package.json'), JSON.stringify({ name: 'convex', bin: { convex: 'bin/main.js' } }));
  fs.writeFileSync(bin, '');
  assert.deepEqual(npxCommand(NODE, dir, 'convex', ['deploy'], WIN), { file: NODE, args: [bin, 'deploy'] });
  // Not installed there: npx.cmd, through cmd.exe.
  const other = npxCommand(NODE, tmpDir(), 'convex', ['deploy'], { ...WIN, env: {}, exists: has(`${NODE_DIR}\\npx.cmd`) });
  assert.equal(other.file, 'cmd.exe');
  assert.match(other.args[3], /npx\.cmd" convex deploy"$/);
  assert.deepEqual(npxCommand('/opt/node/bin/node', dir, 'convex', ['deploy'], { platform: 'linux', exists: has('/opt/node/bin/npx') }), { file: '/opt/node/bin/npx', args: ['convex', 'deploy'] });
});

test('the PATH gets Node first under the name it already has, without a second PATH beside Path', () => {
  const win = pathWith({ Path: 'C:\\Windows;C:\\Tools', Other: '1' }, 'C:\\Node', 'win32');
  assert.deepEqual(win, { Path: 'C:\\Node;C:\\Windows;C:\\Tools', Other: '1' });
  assert.deepEqual(pathWith({ PATH: '/usr/bin:/opt/node/bin::/bin' }, '/opt/node/bin', 'linux'), { PATH: '/opt/node/bin:/usr/bin:/bin' });
  assert.deepEqual(pathWith({}, '/n', 'linux'), { PATH: '/n' });
});

test('tar: the one in System32 on Windows, because a tar from Git for Windows reads C: as another computer', () => {
  const system = 'C:\\Windows\\System32\\tar.exe';
  assert.equal(tarProgram({ ...WIN, env: { SystemRoot: 'C:\\Windows' }, exists: has(system) }), system);
  assert.equal(tarProgram({ ...WIN, env: { SystemRoot: 'C:\\Windows' }, exists: () => false }), 'tar');
  assert.equal(tarProgram({ platform: 'linux' }), 'tar');
});

// ---- the real thing, on this machine

test('the npm that came with this Node runs, from a folder with spaces and brackets in its name', () => {
  const cwd = path.join(tmpDir(), 'My Projects (new)');
  fs.mkdirSync(cwd);
  const c = npmCommand(process.execPath, ['--version']);
  const r = spawnSync(c.file, c.args, { cwd, encoding: 'utf8', ...(c.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
  assert.equal(r.status, 0, `${r.stderr}${r.error}`);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('a .cmd in a folder with spaces and brackets runs with its arguments whole (Windows)', onlyOnWindows('.cmd files are a Windows thing'), () => {
  const dir = path.join(tmpDir(), 'Program Files (x86)', 'a b');
  fs.mkdirSync(dir, { recursive: true });
  const cmd = path.join(dir, 'echo args.cmd');
  // Prints each argument on a line of its own, as the program behind the batch file would see it.
  const script = path.join(dir, 'show.mjs');
  fs.writeFileSync(script, 'for (const a of process.argv.slice(2)) console.log(`[${a}]`);\n');
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  // Node itself refuses it: that is what the wrapper is for.
  assert.equal((spawnSync(cmd, ['x'], { encoding: 'utf8' }).error as NodeJS.ErrnoException | undefined)?.code, 'EINVAL');
  const c = commandFor(cmd, ['plain', 'two words', 'a&b', 'x(y)', ''], {});
  const r = spawnSync(c.file, c.args, { encoding: 'utf8', windowsVerbatimArguments: c.windowsVerbatimArguments });
  assert.equal(r.status, 0, `${r.stderr}${r.error}`);
  assert.deepEqual(r.stdout.trim().split(/\r?\n/), ['[plain]', '[two words]', '[a&b]', '[x(y)]', '[]']);
});

test('a package program runs with node, with no .cmd in the way', () => {
  // The Convex command line is a dependency of the runner: this prints its version, offline.
  const root = path.resolve(import.meta.dirname, '..', '..');
  const bin = nodeBin(path.join(root, 'node_modules'), 'convex');
  if (!bin) return; // the runner's packages aren't installed here
  const profile = tmpDir();
  const r = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', env: { ...process.env, HOME: profile, USERPROFILE: profile } });
  assert.equal(r.status, 0, `${r.stderr}${r.error}`);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});
