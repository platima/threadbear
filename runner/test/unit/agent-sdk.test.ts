// scripts/agent-sdk.mjs: the Claude Agent SDK is fetched from npm on a Windows
// install (the installers don't carry it), checked against the lock's hash,
// unpacked under the person's own folder, and imported from there.
// A local web server stands in for the registry. Nothing here touches the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { tmpDir } from '../helpers/fakes.ts';

process.env.THREADBEAR_SUPERVISE_NO_RUN = '1';
const SCRIPTS = path.resolve(import.meta.dirname, '../../scripts');
const lib: any = await import(pathToFileURL(path.join(SCRIPTS, 'agent-sdk.mjs')).href);
const sup: any = await import(pathToFileURL(path.join(SCRIPTS, 'windows-run.mjs')).href);
const SDK = '@anthropic-ai/claude-agent-sdk';

// ------------------------------------------------------------ a tar writer
// Written here, apart from the reader, and checked against the system's own tar below.
function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  const sum = [...h].reduce((a, b) => a + b, 0);
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const padded = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function entry(name: string, body: Buffer | string | null, type = '0'): Buffer {
  const data = body === null ? Buffer.alloc(0) : Buffer.from(body);
  return Buffer.concat([header(name, data.length, type), padded(data)]);
}
function pax(path_: string): Buffer {
  const rest = ` path=${path_}\n`;
  let len = rest.length + 1;
  while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
  return entry('PaxHeader/x', `${len}${rest}`, 'x');
}
const tgz = (...entries: Buffer[]) => zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

function sdkTarball(version: string, extra: Buffer[] = []): Buffer {
  return tgz(
    entry('package/', null, '5'),
    entry('package/package.json', JSON.stringify({ name: SDK, version, type: 'module', exports: { '.': './sdk.mjs', './sdk-tools': './sdk-tools.mjs' } })),
    entry('package/sdk.mjs', `export const query = () => 'fake sdk ${version}';\n`),
    entry('package/sdk-tools.mjs', `export const tools = ['one', 'two'];\n`),
    entry('package/README.md', 'the terms\n'),
    ...extra,
  );
}
const sri = (b: Buffer) => `sha512-${crypto.createHash('sha512').update(b).digest('base64')}`;

// ------------------------------------------------------- a stand-in registry
async function registry(routes: Record<string, () => { status?: number; body?: Buffer }>) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    const r = routes[req.url ?? '']?.() ?? { status: 404, body: Buffer.from('no') };
    res.writeHead(r.status ?? 200);
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { hits, url: (p: string) => `http://127.0.0.1:${port}${p}`, close: () => new Promise((r) => server.close(r)) };
}

function runnerRoot(version: string, resolved: string, integrity: string, { installed = false } = {}): string {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${SDK}`]: { version, resolved, integrity } } }));
  if (installed) {
    const dir = path.join(root, 'node_modules', ...SDK.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: SDK, version }));
  }
  return root;
}
const leftovers = (home: string) => (fs.existsSync(home) ? fs.readdirSync(home) : []);

// ------------------------------------------------------------ the tarball

test('a tarball from the system tar unpacks, with its first folder dropped', (t) => {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const src = tmpDir();
  fs.mkdirSync(path.join(src, 'package', 'deep', 'er'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package', 'package.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(src, 'package', 'deep', 'er', 'file.txt'), 'hello');
  // A name over 100 characters makes the system tar write an extended header.
  const long = path.join(src, 'package', 'a'.repeat(60), 'b'.repeat(60));
  fs.mkdirSync(long, { recursive: true });
  fs.writeFileSync(path.join(long, 'long.txt'), 'long');
  const out = path.join(tmpDir(), 'x.tgz');
  try {
    execFileSync(tar, ['-czf', out, '-C', src, 'package']);
  } catch {
    t.skip('no tar program here to make the sample with');
    return;
  }
  const dest = path.join(tmpDir(), 'out');
  assert.equal(lib.extractTarball(fs.readFileSync(out), dest), 3);
  assert.equal(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'), '{"name":"x"}');
  assert.equal(fs.readFileSync(path.join(dest, 'deep', 'er', 'file.txt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(dest, 'a'.repeat(60), 'b'.repeat(60), 'long.txt'), 'utf8'), 'long');
});

test('a long name in an extended header, and a folder entry, unpack', () => {
  const name = `package/${'d'.repeat(80)}/${'e'.repeat(80)}/f.txt`;
  const dest = path.join(tmpDir(), 'out');
  assert.equal(lib.extractTarball(tgz(entry('package/', null, '5'), pax(name), entry('package/placeholder', 'long body')), dest), 1);
  assert.equal(fs.readFileSync(path.join(dest, 'd'.repeat(80), 'e'.repeat(80), 'f.txt'), 'utf8'), 'long body');
});

test('names that could leave the folder, links and devices are refused', () => {
  const bad = ['package/../evil.txt', '../evil.txt', '/abs/evil.txt', 'package/a/../../evil.txt', 'package/C:/evil.txt', 'package/a\\b.txt', 'package/x.txt:stream'];
  for (const name of bad) {
    const dest = path.join(tmpDir(), 'out');
    assert.throws(() => lib.extractTarball(tgz(entry(name, 'x')), dest), /unsafe name|leaves its folder/, name);
    assert.equal(fs.existsSync(path.join(path.dirname(dest), 'evil.txt')), false, name);
  }
  assert.throws(() => lib.extractTarball(tgz(entry('package/link', null, '2')), path.join(tmpDir(), 'o')), /does not unpack/);
  assert.throws(() => lib.extractTarball(tgz(entry('package/dev', null, '3')), path.join(tmpDir(), 'o')), /does not unpack/);
});

test('a cut-off tarball is refused', () => {
  const whole = zlib.gunzipSync(sdkTarball('1.0.0'));
  const cut = zlib.gzipSync(whole.subarray(0, 700));
  assert.throws(() => lib.extractTarball(cut, path.join(tmpDir(), 'o')), /cut short/);
});

test('the hash is checked: a match passes, a different file, a bad value and none do not', () => {
  const bytes = Buffer.from('some package');
  lib.checkIntegrity(bytes, sri(bytes));
  lib.checkIntegrity(bytes, `sha1-AAAA ${sri(bytes)}`); // a hash it doesn't know is skipped, the one it does is checked
  assert.throws(() => lib.checkIntegrity(Buffer.from('other'), sri(bytes)), /does not match/);
  assert.throws(() => lib.checkIntegrity(bytes, 'md5-AAAA'), /not a SHA/);
  assert.throws(() => lib.checkIntegrity(bytes, ''), /not a SHA/);
});

// ---------------------------------------------------------------- fetching

test('with the SDK in node_modules next to the runner, nothing is fetched', async () => {
  const reg = await registry({});
  try {
    const root = runnerRoot('2.3.4', reg.url('/sdk.tgz'), sri(Buffer.from('x')), { installed: true });
    const home = path.join(tmpDir(), 'sdk');
    const got = await lib.ensureAgentSdk({ root, home });
    assert.equal(got.where, 'in place');
    assert.deepEqual(reg.hits, []);
    assert.deepEqual(leftovers(home), []);
  } finally {
    await reg.close();
  }
});

test('a missing SDK is fetched once, checked, unpacked under the home folder, and found there next time', async () => {
  const body = sdkTarball('2.3.4');
  const reg = await registry({ '/sdk.tgz': () => ({ body }) });
  try {
    const root = runnerRoot('2.3.4', reg.url('/sdk.tgz'), sri(body));
    const home = path.join(tmpDir(), 'sdk');
    const lines: string[] = [];
    const first = await lib.ensureAgentSdk({ root, home, log: (s: string) => lines.push(s) });
    assert.equal(first.where, 'fetched');
    assert.equal(first.base, path.join(home, '2.3.4'));
    const pkg = JSON.parse(fs.readFileSync(path.join(first.base, 'node_modules', ...SDK.split('/'), 'package.json'), 'utf8'));
    assert.equal(pkg.version, '2.3.4');
    assert.deepEqual(leftovers(home), ['2.3.4'], 'no temporary folder is left');
    assert.match(lines.join('\n'), /Getting the Claude Agent SDK 2\.3\.4/);

    const second = await lib.ensureAgentSdk({ root, home });
    assert.equal(second.where, 'cached');
    assert.equal(reg.hits.length, 1);
  } finally {
    await reg.close();
  }
});

test('a download that does not match the lock is thrown away and nothing is kept', async () => {
  const real = sdkTarball('2.3.4');
  const tampered = sdkTarball('2.3.4', [entry('package/evil.mjs', 'export default 1')]);
  const reg = await registry({ '/sdk.tgz': () => ({ body: tampered }) });
  try {
    const root = runnerRoot('2.3.4', reg.url('/sdk.tgz'), sri(real));
    const home = path.join(tmpDir(), 'sdk');
    await assert.rejects(lib.ensureAgentSdk({ root, home }), /does not match the hash/);
    assert.deepEqual(leftovers(home), []);
  } finally {
    await reg.close();
  }
});

test('a registry that answers an error, or a package of another version inside, is refused and leaves nothing', async () => {
  const wrong = sdkTarball('9.9.9');
  const reg = await registry({ '/down.tgz': () => ({ status: 503, body: Buffer.from('busy') }), '/wrong.tgz': () => ({ body: wrong }) });
  try {
    const home = path.join(tmpDir(), 'sdk');
    await assert.rejects(lib.ensureAgentSdk({ root: runnerRoot('2.3.4', reg.url('/down.tgz'), sri(Buffer.from('x'))), home }), /answered 503/);
    await assert.rejects(lib.ensureAgentSdk({ root: runnerRoot('2.3.4', reg.url('/wrong.tgz'), sri(wrong)), home }), /9\.9\.9/);
    assert.deepEqual(leftovers(home), []);
  } finally {
    await reg.close();
  }
});

test('a network failure is an error with the reason, not a hang', async () => {
  const root = runnerRoot('2.3.4', 'http://127.0.0.1:9/sdk.tgz', sri(Buffer.from('x')));
  await assert.rejects(lib.ensureAgentSdk({ root, home: path.join(tmpDir(), 'sdk') }), /fetch failed|ECONNREFUSED|connect/i);
});

test('an update replaces the earlier version, and leaves another start’s unfinished download alone', async () => {
  const body = sdkTarball('2.4.0');
  const reg = await registry({ '/sdk.tgz': () => ({ body }) });
  try {
    const home = path.join(tmpDir(), 'sdk');
    fs.mkdirSync(path.join(home, '2.3.4', 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(home, '.2.4.0.99999.tmp'), { recursive: true });
    await lib.ensureAgentSdk({ root: runnerRoot('2.4.0', reg.url('/sdk.tgz'), sri(body)), home });
    assert.deepEqual(leftovers(home).sort(), ['.2.4.0.99999.tmp', '2.4.0']);
  } finally {
    await reg.close();
  }
});

test('a lock without the SDK, or without a hash, says so', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
  assert.throws(() => lib.lockedSdk(root), /does not say where to get/);
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { [`node_modules/${SDK}`]: { version: '1.0.0', resolved: 'https://x/y.tgz' } } }));
  assert.throws(() => lib.lockedSdk(root), /integrity/);
  assert.throws(() => lib.lockedSdk(tmpDir()), /can't be read/);
});

test('the home folder is the person’s own: the local app data folder on Windows, an override when told', () => {
  assert.equal(lib.sdkHome({ LOCALAPPDATA: 'C:\\Users\\Pat\\AppData\\Local' }, 'win32'), path.join('C:\\Users\\Pat\\AppData\\Local', 'Threadbear', 'sdk'));
  assert.equal(lib.sdkHome({ THREADBEAR_SDK_DIR: 'relative' }, 'win32'), path.resolve('relative'));
});

// ------------------------------------------------- imported by its own name

async function runNode(args: string[], cwd: string, env: Record<string, string>) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise<number | null>((r) => child.on('close', r));
  return { code, out };
}

// A runner folder in a temp place: the two scripts, a lock, and a file that imports the SDK by its name.
function fakeRunner(version: string, resolved: string, integrity: string): string {
  const root = runnerRoot(version, resolved, integrity);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'src'));
  for (const f of ['agent-sdk.mjs', 'agent-sdk-preload.mjs']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', f));
  fs.writeFileSync(path.join(root, 'src', 'main.mjs'), `import { query } from '${SDK}';\nimport { tools } from '${SDK}/sdk-tools';\nconsole.log(query(), tools.join('+'));\n`);
  return root;
}
const preloadArgs = (root: string) => ['--import', pathToFileURL(path.join(root, 'scripts', 'agent-sdk-preload.mjs')).href, path.join(root, 'src', 'main.mjs')];

test('started through the preload, the runner imports the SDK from the downloaded copy, subpaths too', async () => {
  const body = sdkTarball('3.0.1');
  const reg = await registry({ '/sdk.tgz': () => ({ body }) });
  try {
    const root = fakeRunner('3.0.1', reg.url('/sdk.tgz'), sri(body));
    const home = path.join(tmpDir(), 'sdk');
    const first = await runNode(preloadArgs(root), root, { THREADBEAR_SDK_DIR: home });
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /fake sdk 3\.0\.1 one\+two/);
    assert.match(first.out, /Getting the Claude Agent SDK 3\.0\.1/);
    const second = await runNode(preloadArgs(root), root, { THREADBEAR_SDK_DIR: home });
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /fake sdk 3\.0\.1/);
    assert.doesNotMatch(second.out, /Getting the Claude Agent SDK/);
    assert.equal(reg.hits.length, 1);
  } finally {
    await reg.close();
  }
});

test('without the preload the same file cannot find the SDK, which is why the runner is started with it', async () => {
  const root = fakeRunner('3.0.1', 'http://127.0.0.1:9/x', sri(Buffer.from('x')));
  const r = await runNode([path.join(root, 'src', 'main.mjs')], root, {});
  assert.notEqual(r.code, 0);
  assert.match(r.out, /ERR_MODULE_NOT_FOUND|Cannot find package/);
});

test('if the SDK cannot be got, the runner does not start and the message says what to do', async () => {
  const root = fakeRunner('3.0.1', 'http://127.0.0.1:9/x', sri(Buffer.from('x')));
  const r = await runNode(preloadArgs(root), root, { THREADBEAR_SDK_DIR: path.join(tmpDir(), 'sdk') });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /could not get the Claude Agent SDK from npm/);
  assert.match(r.out, /registry\.npmjs\.org/);
  assert.match(r.out, /npm ci --omit=dev/);
});

test('the SDK in node_modules is used as it always was, with no hook in the way', async () => {
  const root = fakeRunner('3.0.1', 'http://127.0.0.1:9/x', sri(Buffer.from('x')));
  const dir = path.join(root, 'node_modules', ...SDK.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: SDK, version: '3.0.1', type: 'module', exports: { '.': './a.mjs', './sdk-tools': './b.mjs' } }));
  fs.writeFileSync(path.join(dir, 'a.mjs'), `export const query = () => 'in place';\n`);
  fs.writeFileSync(path.join(dir, 'b.mjs'), `export const tools = ['x'];\n`);
  const r = await runNode(preloadArgs(root), root, { THREADBEAR_SDK_DIR: path.join(tmpDir(), 'sdk') });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /in place x/);
});

// ---------------------------------------------------------- the supervisor

test('the supervisor starts the runner through the preload, except with a stand-in entry', () => {
  const args = sup.runnerArgs('C:\\app\\runner\\src\\main.ts');
  assert.equal(args[0], '--import');
  assert.match(args[1], /^file:\/\/\/.*agent-sdk-preload\.mjs$/);
  assert.equal(args[2], 'C:\\app\\runner\\src\\main.ts');
  assert.deepEqual(sup.runnerArgs('stand-in.mjs', { preload: false }), ['stand-in.mjs']);
});
