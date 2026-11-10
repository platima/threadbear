// node --test desktop-tauri/bridge/terminal.test.ts
//
// The Terminal's shells held in the bridge: starting, attaching again after a
// reload, stopping, and what a shell is and isn't given. The first half uses a
// stand-in for node-pty; the last case runs the real bridge, a real WebSocket and
// a real shell.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { Terminals, shellEnv, type Pty } from './terminal.ts';
import type { ShellList } from './shells.ts';
import type { TerminalFont } from './windows-terminal-font.ts';
import { openUi, outcome, scratch, startBridge, freePort, type Running } from './testkit.ts';
import WebSocket from 'ws';

class FakePty implements Pty {
  pid = 1;
  written: string[] = [];
  size = { cols: 0, rows: 0 };
  killed = false;
  paused = false;
  private data: ((d: string) => void)[] = [];
  private exit: ((e: { exitCode: number }) => void)[] = [];
  file: string;
  args: string[];
  opts: { cols: number; rows: number; cwd: string; env: Record<string, string> };
  constructor(file: string, args: string[], opts: { cols: number; rows: number; cwd: string; env: Record<string, string> }) {
    this.file = file;
    this.args = args;
    this.opts = opts;
    this.size = { cols: opts.cols, rows: opts.rows };
  }
  onData(l: (d: string) => void) { this.data.push(l); }
  onExit(l: (e: { exitCode: number }) => void) { this.exit.push(l); }
  write(d: string) { this.written.push(d); }
  resize(cols: number, rows: number) { this.size = { cols, rows }; }
  kill() { this.killed = true; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  say(d: string) { for (const l of this.data) l(d); }
  end(exitCode = 0) { for (const l of this.exit) l({ exitCode }); }
}

const LIST: ShellList = {
  shells: [
    { id: 'pwsh', label: 'PowerShell 7', file: 'pwsh.exe', args: ['-NoLogo'] },
    { id: 'wsl:Debian', label: 'WSL: Debian', file: 'wsl.exe', args: ['-d', 'Debian'], wsl: 'Debian' },
  ],
  auto: 'pwsh',
  notes: [],
};

function rig(more: { shells?: ShellList; spawnFails?: string; hold?: boolean; font?: () => TerminalFont } = {}) {
  const ptys: FakePty[] = [];
  // With hold, finding the shells waits until release() is called, as wsl.exe can for a second.
  let release: () => void = () => {};
  const gate = more.hold ? new Promise<void>((resolve) => (release = resolve)) : undefined;
  const terminals = new Terminals({
    spawn: () => {
      if (more.spawnFails) throw new Error(more.spawnFails);
      return (file, args, opts) => {
        const p = new FakePty(file, args, opts);
        ptys.push(p);
        return p;
      };
    },
    shells: async () => {
      await gate;
      return more.shells ?? LIST;
    },
    // Never the real one: that reads this PC's Windows Terminal settings.
    font: more.font ?? (() => ({})),
    env: { PATH: 'x', THREADBEAR_BRIDGE_KEY: 'secret', THREADBEAR_THREAD_ID: 't1', THREADBARE_THREAD_ID: 't1', THREADBEAR_HOME: 'h' },
    platform: 'win32',
    home: 'C:\\Users\\me',
    isDir: (d) => d.startsWith('C:\\Users\\me'),
  });
  const heard: Record<string, unknown>[] = [];
  const sink = (m: Record<string, unknown>) => void heard.push(m);
  return { terminals, ptys, heard, sink, release: () => release(), last: () => heard[heard.length - 1] };
}

describe('what a shell is given', () => {
  test("the bridge's key and any thread id are taken out, and it says what kind of terminal it is", () => {
    const env = shellEnv({ PATH: 'x', THREADBEAR_BRIDGE_KEY: 'k', THREADBEAR_THREAD_ID: 't', THREADBARE_THREAD_ID: 't', threadbear_bridge_key: 'k2', THREADBEAR_HOME: 'h', EMPTY: undefined }, 'win32');
    assert.deepEqual(env, { PATH: 'x', THREADBEAR_HOME: 'h', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Threadbear' });
  });

  test('a Unix shell gets a UTF-8 locale when there is none', () => {
    assert.equal(shellEnv({}, 'linux').LANG, 'en_US.UTF-8');
    assert.equal(shellEnv({ LANG: 'de_DE.UTF-8' }, 'linux').LANG, 'de_DE.UTF-8');
    assert.equal(shellEnv({}, 'win32').LANG, undefined);
  });
});

describe('starting and attaching', () => {
  test('nothing starts until the page asks for it with create', async () => {
    const r = rig();
    await r.terminals.open('t1', { cols: 80, rows: 24 }, r.sink);
    assert.deepEqual(r.heard, [{ t: 'none', key: 't1' }]);
    assert.equal(r.ptys.length, 0);
  });

  test("create starts the default shell in the thread's folder, with the size the page has, and the safe environment", async () => {
    const r = rig();
    await r.terminals.open('t1', { cwd: 'C:\\Users\\me\\proj', cols: 120, rows: 30, create: true }, r.sink);
    assert.equal(r.ptys.length, 1);
    const p = r.ptys[0]!;
    assert.deepEqual([p.file, p.args, p.opts.cwd, p.opts.cols, p.opts.rows], ['pwsh.exe', ['-NoLogo'], 'C:\\Users\\me\\proj', 120, 30]);
    assert.equal(p.opts.env.THREADBEAR_BRIDGE_KEY, undefined);
    assert.equal(p.opts.env.THREADBEAR_THREAD_ID, undefined);
    assert.equal(p.opts.env.TERM, 'xterm-256color');
    assert.deepEqual(r.last(), { t: 'opened', key: 't1', shell: 'PowerShell 7', cwd: 'C:\\Users\\me\\proj', fresh: true, fellBack: false });
  });

  test('a folder that is not there is the home folder', async () => {
    const r = rig();
    await r.terminals.open('t1', { cwd: 'D:\\gone', cols: 80, rows: 24, create: true }, r.sink);
    assert.equal(r.ptys[0]!.opts.cwd, 'C:\\Users\\me');
    await r.terminals.open('t2', { cols: 80, rows: 24, create: true }, r.sink);
    assert.equal(r.ptys[1]!.opts.cwd, 'C:\\Users\\me');
  });

  test('a chosen shell is started; a WSL one gets the folder with --cd', async () => {
    const r = rig();
    await r.terminals.open('t1', { shell: 'wsl:Debian', cwd: 'C:\\Users\\me\\proj', cols: 80, rows: 24, create: true }, r.sink);
    assert.deepEqual([r.ptys[0]!.file, r.ptys[0]!.args], ['wsl.exe', ['-d', 'Debian', '--cd', 'C:\\Users\\me\\proj']]);
    assert.equal((r.last() as { shell: string }).shell, 'WSL: Debian');
  });

  test('a shell that is not on this PC any more is replaced by the default, and the page is told', async () => {
    const r = rig();
    await r.terminals.open('t1', { shell: 'wsl:Gone', cols: 80, rows: 24, create: true }, r.sink);
    assert.equal(r.ptys[0]!.file, 'pwsh.exe');
    assert.equal((r.last() as { fellBack: boolean }).fellBack, true);
  });

  test("a program path can't be asked for: only a listed shell's id is", async () => {
    const r = rig();
    await r.terminals.open('t1', { shell: 'C:\\Windows\\System32\\calc.exe', cols: 80, rows: 24, create: true }, r.sink);
    assert.equal(r.ptys[0]!.file, 'pwsh.exe');
  });

  test('with no shell on the PC, create says so', async () => {
    const r = rig({ shells: { shells: [], notes: [] } });
    await assert.rejects(r.terminals.open('t1', { cols: 80, rows: 24, create: true }, r.sink), /No shell was found/);
  });

  test("a copy without the PTY package says why, and starts nothing", async () => {
    const r = rig({ spawnFails: 'The terminal is not available in this copy of Threadbear: Cannot find module' });
    await assert.rejects(r.terminals.open('t1', { cols: 80, rows: 24, create: true }, r.sink), /not available in this copy/);
    assert.match(r.terminals.unavailable()!, /not available in this copy/);
  });

  test('typing and resizing reach the shell, and what it prints reaches the page', async () => {
    const r = rig();
    await r.terminals.open('t1', { cols: 80, rows: 24, create: true }, r.sink);
    r.terminals.write('t1', 'dir\r');
    r.terminals.resize('t1', 100, 40);
    r.ptys[0]!.say('hello');
    assert.deepEqual(r.ptys[0]!.written, ['dir\r']);
    assert.deepEqual(r.ptys[0]!.size, { cols: 100, rows: 40 });
    assert.deepEqual(r.last(), { t: 'out', key: 't1', d: 'hello' });
  });

  test('nonsense sizes are held to what a terminal can be', async () => {
    const r = rig();
    await r.terminals.open('t1', { cols: 0, rows: 99999, create: true }, r.sink);
    assert.deepEqual(r.ptys[0]!.size, { cols: 2, rows: 500 });
    r.terminals.resize('t1', Number.NaN, -3);
    assert.deepEqual(r.ptys[0]!.size, { cols: 80, rows: 1 });
  });

  test('a page that comes back (a reload) attaches to the running shell and gets what it printed', async () => {
    const r = rig();
    await r.terminals.open('t1', { cols: 80, rows: 24, create: true }, r.sink);
    r.ptys[0]!.say('one ');
    r.ptys[0]!.say('two');
    const later: Record<string, unknown>[] = [];
    r.terminals.detach(r.sink);
    await r.terminals.open('t1', { cols: 80, rows: 24 }, (m) => void later.push(m));
    assert.equal(r.ptys.length, 1, 'no second shell');
    assert.deepEqual(later[0], { t: 'opened', key: 't1', shell: 'PowerShell 7', cwd: 'C:\\Users\\me', replay: 'one two', exited: undefined });
    r.ptys[0]!.say('three');
    assert.deepEqual(later[1], { t: 'out', key: 't1', d: 'three' }, 'and keeps getting its output');
    assert.ok(!r.heard.some((m) => m.d === 'three'), 'the old page, gone, hears nothing more');
  });

  test('the replay keeps the last 256 KB, not everything', async () => {
    const r = rig();
    await r.terminals.open('t1', { cols: 80, rows: 24, create: true }, r.sink);
    for (let i = 0; i < 40; i++) r.ptys[0]!.say('x'.repeat(10_000));
    const later: Record<string, unknown>[] = [];
    await r.terminals.open('t1', { cols: 80, rows: 24 }, (m) => void later.push(m));
    const replay = (later[0] as { replay: string }).replay;
    assert.ok(replay.length <= 256 * 1024 && replay.length >= 200_000, `replay is ${replay.length}`);
  });

  test('a shell that exits says so, stays for the page to read, and is replaced only on create', async () => {
    const r = rig();
    await r.terminals.open('t1', { cols: 80, rows: 24, create: true }, r.sink);
    r.ptys[0]!.say('bye');
    r.ptys[0]!.end(3);
    assert.deepEqual(r.last(), { t: 'exit', key: 't1', code: 3 });
    const later: Record<string, unknown>[] = [];
    await r.terminals.open('t1', { cols: 80, rows: 24 }, (m) => void later.push(m));
    assert.equal(r.ptys.length, 1);
    assert.deepEqual(later.map((m) => m.t), ['opened', 'exit']);
    assert.equal((later[0] as { replay: string }).replay, 'bye');
    await r.terminals.open('t1', { cols: 80, rows: 24, create: true }, r.sink);
    assert.equal(r.ptys.length, 2, 'a new shell');
    assert.deepEqual(r.terminals.running(), ['t1']);
  });

  test('no more than 16 shells', async () => {
    const r = rig();
    for (let i = 0; i < 16; i++) await r.terminals.open(`t${i}`, { cols: 80, rows: 24, create: true }, r.sink);
    await assert.rejects(r.terminals.open('t16', { cols: 80, rows: 24, create: true }, r.sink), /16 shells/);
  });
  test('a shell that has exited does not count toward the 16, only running ones do', async () => {
    const r = rig();
    for (let i = 0; i < 16; i++) await r.terminals.open(`t${i}`, { cols: 80, rows: 24, create: true }, r.sink);
    for (const p of r.ptys) p.end(0);
    await r.terminals.open('t16', { cols: 80, rows: 24, create: true }, r.sink);
    assert.equal(r.ptys.length, 17);
  });

  test('Git Bash is started with CHERE_INVOKING, so its login profile keeps the thread folder', async () => {
    const list: ShellList = { shells: [{ id: 'gitbash', label: 'Git Bash', file: 'bash.exe', args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } }], auto: 'gitbash', notes: [] };
    const r = rig({ shells: list });
    await r.terminals.open('t1', { cwd: 'C:\\Users\\me\\proj', cols: 80, rows: 24, create: true }, r.sink);
    assert.equal(r.ptys[0]!.opts.env.CHERE_INVOKING, '1');
    assert.equal(r.ptys[0]!.opts.cwd, 'C:\\Users\\me\\proj');
  });

  test('two requests for one thread while the shells are being looked for make one shell, and both hear it', async () => {
    const r = rig({ hold: true });
    const other: Record<string, unknown>[] = [];
    const a = r.terminals.open('t1', { cols: 80, rows: 24, create: true }, r.sink);
    const b = r.terminals.open('t1', { cols: 80, rows: 24, create: true }, (m) => void other.push(m));
    r.release();
    await Promise.all([a, b]);
    assert.equal(r.ptys.length, 1);
    assert.equal(r.last()?.t, 'opened');
    assert.equal(other[0]?.t, 'opened');
  });

  test('a start that is waiting counts toward the limit', async () => {
    const r = rig({ hold: true });
    const starts = Array.from({ length: 16 }, (_, i) => r.terminals.open(`t${i}`, { cols: 80, rows: 24, create: true }, r.sink));
    await assert.rejects(r.terminals.open('t16', { cols: 80, rows: 24, create: true }, r.sink), /16 shells/);
    r.release();
    await Promise.all(starts);
    assert.equal(r.ptys.length, 16);
  });

  test('a shell that failed to start tells everyone who asked', async () => {
    const r = rig({ hold: true, shells: { shells: [], notes: [] } });
    const other: Record<string, unknown>[] = [];
    const a = r.terminals.open('t1', { cols: 80, rows: 24, create: true }, r.sink);
    const b = r.terminals.open('t1', { cols: 80, rows: 24, create: true }, (m) => void other.push(m));
    r.release();
    await assert.rejects(a, /No shell was found/);
    await b;
    assert.equal(other[0]?.t, 'error');
    // And the key is free to try again.
    assert.equal(r.terminals.running().length, 0);
  });
});

describe('stopping', () => {
  test('stopping a thread while its shell is still being started cancels the start (an End shell or an archive in that second)', async () => {
    const r = rig({ hold: true });
    const start = r.terminals.open('t1', { cols: 80, rows: 24, create: true }, r.sink);
    r.terminals.stop('t1');
    r.release();
    await start;
    assert.equal(r.ptys.length, 0, 'no shell was spawned');
    assert.deepEqual(r.heard, [], 'and the page, which forgot it, is told nothing');
    assert.deepEqual(r.terminals.running(), []);
  });

  test('prune cancels the starts of threads it does not list, and keeps the ones it does', async () => {
    const r = rig({ hold: true });
    const a = r.terminals.open('a', { cols: 80, rows: 24, create: true }, r.sink);
    const b = r.terminals.open('b', { cols: 80, rows: 24, create: true }, r.sink);
    r.terminals.prune(['b']);
    r.release();
    await Promise.all([a, b]);
    assert.deepEqual(r.terminals.running(), ['b']);
  });

  test('stopAll cancels starts too, so a shell never appears after the bridge has begun to end', async () => {
    const r = rig({ hold: true });
    const start = r.terminals.open('a', { cols: 80, rows: 24, create: true }, r.sink);
    r.terminals.stopAll();
    r.release();
    await start;
    assert.equal(r.ptys.length, 0);
  });
  test("stop ends that thread's shell and nobody else's", async () => {
    const r = rig();
    await r.terminals.open('a', { cols: 80, rows: 24, create: true }, r.sink);
    await r.terminals.open('b', { cols: 80, rows: 24, create: true }, r.sink);
    r.terminals.stop('a');
    assert.deepEqual([r.ptys[0]!.killed, r.ptys[1]!.killed], [true, false]);
    assert.deepEqual(r.terminals.running(), ['b']);
    r.terminals.write('a', 'ignored');
    assert.deepEqual(r.ptys[0]!.written, []);
  });

  test("prune keeps the listed shells (the home shell among them) and ends the rest, for threads deleted while the app wasn't listening", async () => {
    const r = rig();
    for (const k of ['home', 'a', 'b', 'c']) await r.terminals.open(k, { cols: 80, rows: 24, create: true }, r.sink);
    r.terminals.prune(['home', 'b']);
    assert.deepEqual(r.terminals.running().sort(), ['b', 'home']);
  });

  test('stopAll ends every shell (the bridge is ending)', async () => {
    const r = rig();
    for (const k of ['a', 'b']) await r.terminals.open(k, { cols: 80, rows: 24, create: true }, r.sink);
    r.terminals.stopAll();
    assert.ok(r.ptys.every((p) => p.killed));
    assert.deepEqual(r.terminals.running(), []);
  });

  test('stopping a shell that has already exited is quiet', async () => {
    const r = rig();
    await r.terminals.open('a', { cols: 80, rows: 24, create: true }, r.sink);
    r.ptys[0]!.end(0);
    r.terminals.stop('a');
    assert.equal(r.ptys[0]!.killed, false);
  });
});

// A page connection, as the bridge sees it.
class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  flush: (() => void)[] = [];
  send(text: string, cb?: () => void) {
    this.sent.push(JSON.parse(text));
    if (cb) this.flush.push(cb);
  }
  say(m: unknown) {
    this.emit('message', Buffer.from(typeof m === 'string' ? m : JSON.stringify(m)));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 10));

describe('the page connection', () => {
  const connect = () => {
    const r = rig();
    const ws = new FakeSocket();
    r.terminals.serve(ws as unknown as WebSocket);
    return { ...r, ws };
  };

  test('shells lists what this PC has and the default, without the file paths', async () => {
    const { ws } = connect();
    ws.say({ t: 'shells' });
    await settle();
    assert.deepEqual(ws.sent[0], { t: 'shells', shells: [{ id: 'pwsh', label: 'PowerShell 7' }, { id: 'wsl:Debian', label: 'WSL: Debian' }], auto: 'pwsh', notes: [] });
  });

  test("font says the face and size Windows Terminal is set to, read each time it is asked, and nothing else", async () => {
    let now: TerminalFont = { face: 'CaskaydiaCove NF', size: 11 };
    let reads = 0;
    const r = rig({ font: () => (reads++, now) });
    const ws = new FakeSocket();
    r.terminals.serve(ws as unknown as WebSocket);
    assert.equal(reads, 0, 'not read until asked');
    ws.say({ t: 'font' });
    assert.deepEqual(ws.sent.at(-1), { t: 'font', face: 'CaskaydiaCove NF', size: 11 });
    now = { face: 'MesloLGS NF' };
    ws.say({ t: 'font' });
    assert.deepEqual(ws.sent.at(-1), { t: 'font', face: 'MesloLGS NF' });
    assert.equal(reads, 2);
  });

  test('font says every face Windows Terminal lists, in its order, when it lists more than one', async () => {
    const r = rig({ font: () => ({ face: 'Cascadia Code', faces: ['Cascadia Code', 'Symbols Nerd Font Mono'], size: 12 }) });
    const ws = new FakeSocket();
    r.terminals.serve(ws as unknown as WebSocket);
    ws.say({ t: 'font' });
    assert.deepEqual(ws.sent.at(-1), { t: 'font', face: 'Cascadia Code', faces: ['Cascadia Code', 'Symbols Nerd Font Mono'], size: 12 });
    // A list of one is just the face, as before; unusable names and repeats are dropped; the list is capped.
    const one = rig({ font: () => ({ face: 'Fira Code', faces: ['Fira Code', 'x"; }', 'fira code'] }) });
    const ws1 = new FakeSocket();
    one.terminals.serve(ws1 as unknown as WebSocket);
    ws1.say({ t: 'font' });
    assert.deepEqual(ws1.sent.at(-1), { t: 'font', face: 'Fira Code' });
    const many = rig({ font: () => ({ faces: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }) });
    const wsm = new FakeSocket();
    many.terminals.serve(wsm as unknown as WebSocket);
    wsm.say({ t: 'font' });
    assert.deepEqual(wsm.sent.at(-1), { t: 'font', face: 'a', faces: ['a', 'b', 'c', 'd', 'e', 'f'] });
  });

  test('font with no Windows Terminal font to find says so with neither field', async () => {
    const r = rig();
    const ws = new FakeSocket();
    r.terminals.serve(ws as unknown as WebSocket);
    ws.say({ t: 'font' });
    assert.deepEqual(ws.sent.at(-1), { t: 'font' });
  });

  test('font passes on a name and a size and no more, whatever the reader returns', async () => {
    const hostile = { face: 'x"; } body { display: none }', size: 12, settings: '{"secret": true}', profiles: [] } as unknown as TerminalFont;
    const r = rig({ font: () => hostile });
    const ws = new FakeSocket();
    r.terminals.serve(ws as unknown as WebSocket);
    ws.say({ t: 'font' });
    assert.deepEqual(ws.sent.at(-1), { t: 'font', size: 12 });
    const r2 = rig({ font: () => ({ face: 'Fira Code', size: 5000 }) });
    const ws2 = new FakeSocket();
    r2.terminals.serve(ws2 as unknown as WebSocket);
    ws2.say({ t: 'font' });
    assert.deepEqual(ws2.sent.at(-1), { t: 'font', face: 'Fira Code' });
  });

  test('a reader that fails is no font, not a crash and not an error message', async () => {
    const r = rig({
      font: () => {
        throw new Error('C:\\Users\\me\\AppData\\Local\\settings.json: EACCES');
      },
    });
    const ws = new FakeSocket();
    r.terminals.serve(ws as unknown as WebSocket);
    ws.say({ t: 'font' });
    assert.deepEqual(ws.sent, [{ t: 'font' }]);
  });

  test('open, in, resize and stop do what they say', async () => {
    const { ws, ptys, terminals } = connect();
    ws.say({ t: 'open', key: 'k', cols: 90, rows: 20, create: true });
    await settle();
    assert.equal(ws.sent[0]!.t, 'opened');
    ws.say({ t: 'in', key: 'k', d: 'ls\r' });
    ws.say({ t: 'resize', key: 'k', cols: 70, rows: 10 });
    assert.deepEqual(ptys[0]!.written, ['ls\r']);
    assert.deepEqual(ptys[0]!.size, { cols: 70, rows: 10 });
    ptys[0]!.say('out');
    assert.deepEqual(ws.sent.at(-1), { t: 'out', key: 'k', d: 'out' });
    ws.say({ t: 'stop', key: 'k' });
    assert.deepEqual(terminals.running(), []);
  });

  test('a failure to start is an error message for that key, not a crash', async () => {
    const r = rig({ shells: { shells: [], notes: [] } });
    const ws = new FakeSocket();
    r.terminals.serve(ws as unknown as WebSocket);
    ws.say({ t: 'open', key: 'k', create: true });
    await settle();
    assert.equal(ws.sent[0]!.t, 'error');
    assert.equal(ws.sent[0]!.key, 'k');
  });

  test('malformed messages are ignored', async () => {
    const { ws, ptys } = connect();
    for (const bad of ['not json', '{', 'null', '[]', '{"t":5}', JSON.stringify({ t: 'open' }), JSON.stringify({ t: 'open', key: 'x'.repeat(201), create: true }), JSON.stringify({ t: 'in', key: 'k', d: 5 }), JSON.stringify({ t: 'prune', keep: 'all' })]) ws.say(bad);
    await settle();
    assert.deepEqual(ws.sent, []);
    assert.equal(ptys.length, 0);
  });

  test('when the page goes away the shells keep running, and a closed page is not written to', async () => {
    const { ws, ptys, terminals } = connect();
    ws.say({ t: 'open', key: 'k', cols: 80, rows: 24, create: true });
    await settle();
    ws.readyState = 3;
    ws.emit('close');
    ptys[0]!.say('later');
    assert.deepEqual(terminals.running(), ['k']);
    assert.equal(ws.sent.length, 1);
  });

  test("a shell that outruns the page's connection is held until the page catches up", async () => {
    const { ws, ptys } = connect();
    ws.say({ t: 'open', key: 'k', cols: 80, rows: 24, create: true });
    await settle();
    ws.bufferedAmount = 2 * 1024 * 1024;
    ptys[0]!.say('a lot');
    assert.equal(ptys[0]!.paused, true);
    ws.bufferedAmount = 0;
    for (const cb of ws.flush.splice(0)) cb();
    assert.equal(ptys[0]!.paused, false);
  });
});


// ---- the real thing: the bridge, a WebSocket and a shell of this PC -------------------

// What the bridge says over one terminal socket, kept in order, with a way to wait for it.
class Pipe {
  heard: Record<string, unknown>[] = [];
  readonly ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (d) => this.heard.push(JSON.parse(d.toString()) as Record<string, unknown>));
  }
  send(m: Record<string, unknown>) {
    this.ws.send(JSON.stringify(m));
  }
  output(key: string): string {
    return this.heard.filter((m) => m.t === 'out' && m.key === key).map((m) => m.d as string).join('');
  }
  async until(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`gave up waiting for ${what}; heard ${JSON.stringify(this.heard).slice(-700)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

describe('a real shell through the real bridge', () => {
  const files = scratch();
  after(() => files.remove());
  let bridge: Running | undefined;
  after(async () => {
    await bridge?.shutdown();
  });
  const start = async () => (bridge ??= await startBridge({ THREADBEAR_HOME: files.home, THREADBEAR_DIST: files.dist, THREADBEAR_PORT: String(await freePort()), THREADBEAR_BRIDGE_PORT: '0', THREADBEAR_BRIDGE_WATCH_STDIN: '1' }));
  const terminalUrl = (b: Running) => `ws://127.0.0.1:${b.port}/terminal`;

  test('the terminal socket takes the same key and origin checks as the runner pipe', async () => {
    const b = await start();
    const refused = async (u: string, origin: string | null) => (await outcome(new WebSocket(u, origin === null ? {} : { headers: { Origin: origin } }))).refused;
    assert.equal(await refused(terminalUrl(b), b.origin), 403, 'no key');
    assert.equal(await refused(`${terminalUrl(b)}?k=wrong`, b.origin), 403, 'wrong key');
    assert.equal(await refused(`${terminalUrl(b)}?k=${b.key}`, null), 403, 'no origin');
    assert.equal(await refused(`${terminalUrl(b)}?k=${b.key}`, 'http://evil.test'), 403, 'another origin');
  });

  test('starts the default shell, runs a command in it, keeps it across a reconnect, and ends with it', async (t) => {
    const b = await start();
    const connect = async () => {
      const ws = new WebSocket(`${terminalUrl(b)}?k=${encodeURIComponent(b.key)}`, { headers: { Origin: b.origin } });
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      return new Pipe(ws);
    };
    const first = await connect();
    try {
      first.send({ t: 'shells' });
      await first.until('the list of shells', () => first.heard.some((m) => m.t === 'shells'));
      const shells = first.heard.find((m) => m.t === 'shells')!;
      if (shells.unavailable) return t.skip(`no pseudo-terminal package here: ${String(shells.unavailable)}`);
      if (!shells.auto) return t.skip('no shell on this machine');

      first.send({ t: 'open', key: 'real', cols: 100, rows: 30, create: true });
      await first.until('the shell to print something', () => first.output('real').length > 0);
      const marker = 'threadbear-pty-check';
      first.send({ t: 'in', key: 'real', d: `echo ${marker}\r` });
      await first.until('the command to run', () => first.output('real').includes(marker));

      // The page is reloaded: a new connection finds the same shell with what it printed.
      first.ws.close();
      const second = await connect();
      try {
        second.send({ t: 'open', key: 'real', cols: 100, rows: 30 });
        await second.until('the shell to be found again', () => second.heard.some((m) => m.t === 'opened'));
        const opened = second.heard.find((m) => m.t === 'opened')!;
        assert.ok(!opened.fresh, 'not a new shell');
        assert.ok(String(opened.replay).includes(marker), 'with what it had printed');

        second.send({ t: 'in', key: 'real', d: 'exit\r' });
        await second.until('the shell to end', () => second.heard.some((m) => m.t === 'exit'));
        assert.equal(second.heard.find((m) => m.t === 'exit')!.code, 0);
      } finally {
        second.ws.close();
      }
    } finally {
      first.ws.close();
    }
  });
});

// The real bridge reads Windows Terminal's settings from %LOCALAPPDATA%. Here that is a folder of the
// test's own, given to the bridge it starts, so the PC's real settings are not read.
describe('the font through the real bridge', () => {
  const files = scratch();
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-bridge-font-'));
  after(() => {
    files.remove();
    fs.rmSync(appData, { recursive: true, force: true });
  });
  let bridge: Running | undefined;
  after(async () => {
    await bridge?.shutdown();
  });

  test('says what the settings file in the stand-in folder names, on Windows, and nothing elsewhere', async () => {
    const dir = path.join(appData, 'Microsoft', 'Windows Terminal');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ // comment\n "defaultProfile": "{a}", "profiles": { "defaults": { "font": { "face": "CaskaydiaCove NF", "size": 11, }, }, "list": [ { "guid": "{a}" }, ], }, }');
    bridge = await startBridge({ THREADBEAR_HOME: files.home, THREADBEAR_DIST: files.dist, THREADBEAR_PORT: String(await freePort()), THREADBEAR_BRIDGE_PORT: '0', THREADBEAR_BRIDGE_WATCH_STDIN: '1', LOCALAPPDATA: appData });
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/terminal?k=${encodeURIComponent(bridge.key)}`, { headers: { Origin: bridge.origin } });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const pipe = new Pipe(ws);
    try {
      pipe.send({ t: 'font' });
      await pipe.until('the font', () => pipe.heard.some((m) => m.t === 'font'));
      const said = pipe.heard.find((m) => m.t === 'font')!;
      if (process.platform === 'win32') assert.deepEqual(said, { t: 'font', face: 'CaskaydiaCove NF', size: 11 });
      else assert.deepEqual(said, { t: 'font' });
    } finally {
      ws.close();
    }
  });
});
