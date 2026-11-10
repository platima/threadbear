// node --test desktop-tauri/src/core/terminals.test.ts
//
// The window's side of the Terminal: where a thread's shell runs, what state each one is in,
// what it asks the bridge for and what it does with the answers (bridge/terminal.ts is the
// other end), and which shells end when threads do.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fake } from './fake-transport.ts';
import { HOME_KEY, TerminalSessions, choiceLabel, setShellChoice, shellChoice, targetFor, type Sink } from './terminals.ts';
import type { ThreadSummary } from './types.ts';

const thread = (more: Partial<ThreadSummary>): ThreadSummary => ({ id: 't1', cwd: 'C:\\work\\proj', ...more }) as ThreadSummary;

test('a thread gets a shell of its own in its folder; with none open, or an archived one, it is the home folder', () => {
  assert.deepEqual(targetFor(thread({})), { key: 't1', cwd: 'C:\\work\\proj' });
  assert.deepEqual(targetFor(undefined), { key: HOME_KEY });
  assert.deepEqual(targetFor(thread({ archivedAt: '2026-11-01T00:00:00Z' })), { key: HOME_KEY, note: 'This thread is archived, so this terminal is in your home folder.' });
  assert.equal(targetFor(thread({ cwd: '' })).key, HOME_KEY);
});

test('the default shell is kept as an id, "auto" until one is chosen, and a window that cannot keep it says so', () => {
  const kept: Record<string, string> = {};
  const store = { getItem: (k: string) => kept[k] ?? null, setItem: (k: string, v: string) => void (kept[k] = v) };
  assert.equal(shellChoice(store), 'auto');
  assert.equal(setShellChoice('wsl:Debian', store), true);
  assert.equal(shellChoice(store), 'wsl:Debian');
  assert.equal(setShellChoice('x', { getItem: () => null, setItem: () => {} }), false, 'a store that forgets');
  assert.equal(setShellChoice('x', { getItem: () => null, setItem: () => { throw new Error('blocked'); } }), false);
  assert.equal(shellChoice({ getItem: () => { throw new Error('blocked'); }, setItem: () => {} }), 'auto');
});

test("the default shell's name for a button: automatic says which one it picks", () => {
  const info = { shells: [{ id: 'pwsh', label: 'PowerShell 7' }, { id: 'wsl:Debian', label: 'WSL: Debian' }], auto: 'pwsh', notes: [] };
  assert.equal(choiceLabel(info, 'auto'), 'Automatic (PowerShell 7)');
  assert.equal(choiceLabel(info, 'wsl:Debian'), 'WSL: Debian');
  assert.equal(choiceLabel(info, 'wsl:Gone'), 'PowerShell 7 (the one you chose is gone)');
  assert.equal(choiceLabel(undefined, 'auto'), 'Automatic');
});

function rig() {
  const { t, sent } = fake();
  const kept: Record<string, string> = {};
  const sessions = new TerminalSessions(() => t, { getItem: (k) => kept[k] ?? null, setItem: (k, v) => void (kept[k] = v) });
  const written: Record<string, string[]> = {};
  const resets: string[] = [];
  const disposed: string[] = [];
  const sinkFor = (key: string): Sink => ({
    write: (d) => void (written[key] = [...(written[key] ?? []), d]),
    reset: () => void resets.push(key),
    dispose: () => void disposed.push(key),
  });
  // What the bridge was sent, without the JSON-RPC shape the fake carries.
  const ask = () => sent as unknown as Record<string, unknown>[];
  const say = (m: Record<string, unknown>) => t.say(m);
  return { t, sessions, ask, say, written, resets, disposed, sinkFor, kept };
}

test('looking finds a running shell without starting one', () => {
  const r = rig();
  r.sessions.look('t1');
  assert.equal(r.sessions.session('t1')?.status, 'looking');
  r.t.open();
  assert.deepEqual(r.ask(), [{ t: 'open', key: 't1', cols: 80, rows: 24, create: false }]);
  r.say({ t: 'none', key: 't1' });
  assert.equal(r.sessions.session('t1')?.status, 'none');
  assert.equal(r.sessions.session('t1')?.error, undefined);
});

test('a reload finds the shell and gets what it had printed, on a clean screen', () => {
  const r = rig();
  const sink = r.sinkFor('t1');
  r.sessions.register('t1', sink);
  r.sessions.look('t1');
  r.t.open();
  r.say({ t: 'opened', key: 't1', shell: 'PowerShell 7', cwd: 'C:\\work\\proj', replay: 'PS C:\\work\\proj> ' });
  assert.deepEqual(r.sessions.session('t1'), { status: 'running', shell: 'PowerShell 7', cwd: 'C:\\work\\proj', note: undefined, error: undefined });
  assert.deepEqual(r.resets, ['t1']);
  assert.deepEqual(r.written.t1, ['PS C:\\work\\proj> ']);
});

test('start asks for the default shell, or the chosen one, in the thread\'s folder, and sends the size the window has', () => {
  const r = rig();
  r.sessions.resize('t1', 120, 30);
  r.sessions.start('t1', 'C:\\work\\proj');
  r.t.open();
  assert.deepEqual(r.ask().at(-1), { t: 'open', key: 't1', cols: 120, rows: 30, create: true, cwd: 'C:\\work\\proj' });
  assert.equal(r.sessions.session('t1')?.status, 'starting');
  r.say({ t: 'opened', key: 't1', shell: 'PowerShell 7', cwd: 'C:\\work\\proj', fresh: true });
  assert.equal(r.sessions.session('t1')?.status, 'running');

  const r2 = rig();
  r2.sessions.start(HOME_KEY, undefined, 'wsl:Debian');
  r2.t.open();
  assert.deepEqual(r2.ask().at(-1), { t: 'open', key: 'home', cols: 80, rows: 24, create: true, shell: 'wsl:Debian' });
});

test("a second start for a shell that is running does nothing", () => {
  const r = rig();
  r.sessions.start('t1', 'C:\\work\\proj');
  r.t.open();
  const before = r.ask().length;
  r.sessions.start('t1', 'C:\\work\\proj');
  assert.equal(r.ask().length, before);
});

test("a folder that isn't on this PC is said, as is a chosen shell that has gone", () => {
  const r = rig();
  r.sessions.start('t1', 'D:\\gone');
  r.t.open();
  r.say({ t: 'opened', key: 't1', shell: 'PowerShell 7', cwd: 'C:\\Users\\me', fresh: true, fellBack: true });
  const note = r.sessions.session('t1')?.note ?? '';
  assert.match(note, /shell you chose is not on this PC any more/);
  assert.match(note, /folder isn't on this PC any more.*home folder/);
});

test('typing and resizing go to a running shell only', () => {
  const r = rig();
  r.sessions.start('t1', 'C:\\work\\proj');
  r.t.open();
  r.sessions.input('t1', 'early');
  r.sessions.resize('t1', 90, 20);
  r.say({ t: 'opened', key: 't1', shell: 'PowerShell 7', cwd: 'C:\\work\\proj', fresh: true });
  r.sessions.input('t1', 'dir\r');
  r.sessions.resize('t1', 100, 25);
  const sent = r.ask().map((m) => `${m.t}${m.d ? ':' + String(m.d) : ''}`);
  assert.ok(!sent.includes('in:early'), 'typed before the shell was up is dropped');
  assert.ok(sent.includes('in:dir\r'));
  assert.deepEqual(r.ask().at(-1), { t: 'resize', key: 't1', cols: 100, rows: 25 });
});

test('output reaches the sink, and waits for one that is not there yet', () => {
  const r = rig();
  r.sessions.start('t1', 'C:\\work\\proj');
  r.t.open();
  r.say({ t: 'out', key: 't1', d: 'banner' });
  const sink = r.sinkFor('t1');
  r.sessions.register('t1', sink);
  assert.deepEqual(r.written.t1, ['banner']);
  r.say({ t: 'out', key: 't1', d: 'more' });
  assert.deepEqual(r.written.t1, ['banner', 'more']);
  r.say({ t: 'out', key: 'nobody', d: 'lost' });
  assert.equal(r.written.nobody, undefined, 'a shell the window never asked about is ignored');
});

test('a shell that exits is shown as exited with its code, and a new one can be started', () => {
  const r = rig();
  r.sessions.start('t1', 'C:\\work\\proj');
  r.t.open();
  r.say({ t: 'opened', key: 't1', shell: 'PowerShell 7', cwd: 'C:\\work\\proj', fresh: true });
  r.say({ t: 'exit', key: 't1', code: 130 });
  assert.deepEqual([r.sessions.session('t1')?.status, r.sessions.session('t1')?.code], ['exited', 130]);
  r.sessions.input('t1', 'x');
  assert.ok(!r.ask().some((m) => m.t === 'in'));
  r.sessions.start('t1', 'C:\\work\\proj');
  assert.equal(r.sessions.session('t1')?.status, 'starting');
  assert.equal(r.sessions.session('t1')?.code, undefined);
});

test('an error while starting leaves the shell not started, with the reason', () => {
  const r = rig();
  r.sessions.start('t1', 'C:\\work\\proj');
  r.t.open();
  r.say({ t: 'error', key: 't1', message: 'There are 16 shells running already. Close one first.' });
  assert.deepEqual([r.sessions.session('t1')?.status, r.sessions.session('t1')?.error], ['none', 'There are 16 shells running already. Close one first.']);
});

test('stop ends the shell, forgets it, and lets the sink go', () => {
  const r = rig();
  r.sessions.register('t1', r.sinkFor('t1'));
  r.sessions.start('t1', 'C:\\work\\proj');
  r.t.open();
  r.sessions.stop('t1');
  assert.deepEqual(r.ask().at(-1), { t: 'stop', key: 't1' });
  assert.equal(r.sessions.session('t1'), undefined);
  assert.deepEqual(r.disposed, ['t1']);
  r.say({ t: 'out', key: 't1', d: 'late' });
  assert.equal(r.written.t1, undefined, 'late output from a stopped shell is dropped');
});

test("archiving or deleting a thread ends its shell, but not before the thread list has come, and never the home shell", () => {
  const r = rig();
  for (const k of ['a', 'b', 'c', HOME_KEY]) {
    r.sessions.start(k, undefined);
  }
  r.t.open();
  const threads = new Map<string, ThreadSummary>([
    ['a', thread({ id: 'a' })],
    ['b', thread({ id: 'b', archivedAt: '2026-11-01T00:00:00Z' })],
  ]);
  r.sessions.reconcile(threads, false);
  assert.deepEqual([...r.sessions.getSnapshot().sessions.keys()].sort(), ['a', 'b', 'c', HOME_KEY].sort().filter((k) => k !== 'b'), 'archived b ends; c is kept until the list is known');
  r.sessions.reconcile(threads, true);
  assert.deepEqual([...r.sessions.getSnapshot().sessions.keys()].sort(), ['a', HOME_KEY].sort(), 'c is gone from the list, so it ends');
});

test('after the connection drops, running shells are found again with what they printed, and a start that never answered is given up', () => {
  const r = rig();
  const sink = r.sinkFor('t1');
  r.sessions.register('t1', sink);
  r.sessions.start('t1', 'C:\\work\\proj');
  r.t.open();
  r.say({ t: 'opened', key: 't1', shell: 'PowerShell 7', cwd: 'C:\\work\\proj', fresh: true });
  r.sessions.start('t2', 'C:\\work\\two');
  r.t.drop();
  assert.equal(r.sessions.session('t1')?.status, 'running', 'a running shell stays');
  assert.equal(r.sessions.session('t2')?.status, 'none', 'a start with no answer does not');
  assert.match(r.sessions.session('t2')?.error ?? '', /lost its connection/);
  r.sessions.close();
});

test('when the bridge has restarted the shells are gone, and the window says so', () => {
  const r = rig();
  r.sessions.start('t1', 'C:\\work\\proj');
  r.t.open();
  r.say({ t: 'opened', key: 't1', shell: 'PowerShell 7', cwd: 'C:\\work\\proj', fresh: true });
  r.say({ t: 'none', key: 't1' });
  assert.deepEqual([r.sessions.session('t1')?.status, r.sessions.session('t1')?.error], ['none', 'The shell ended when Threadbear restarted.']);
});

test('the list of shells is asked for, kept, and given to whoever asked; an unreachable bridge answers it too', async () => {
  const r = rig();
  const got = r.sessions.loadShells();
  r.t.open();
  r.say({ t: 'shells', shells: [{ id: 'pwsh', label: 'PowerShell 7' }], auto: 'pwsh', notes: [] });
  assert.deepEqual((await got).shells, [{ id: 'pwsh', label: 'PowerShell 7' }]);
  assert.equal(r.sessions.getSnapshot().shells?.auto, 'pwsh');
  const pending = r.sessions.loadShells(true);
  assert.deepEqual(r.ask().at(-1), { t: 'shells', refresh: true });
  r.t.drop();
  assert.match((await pending).unavailable ?? '', /couldn't reach/);
  r.sessions.close();
});

test('a change in any shell is announced to the window', () => {
  const r = rig();
  let calls = 0;
  const off = r.sessions.subscribe(() => calls++);
  const v = r.sessions.getSnapshot().version;
  r.sessions.look('t1');
  assert.ok(calls >= 1 && r.sessions.getSnapshot().version > v);
  off();
  const after = calls;
  r.sessions.look('t2');
  assert.equal(calls, after);
});

test("once the thread list is known the bridge is told which shells to keep: the live threads and home, whatever shells it holds from before a reload", () => {
  const r = rig();
  const threads = new Map<string, ThreadSummary>([
    ['a', thread({ id: 'a' })],
    ['b', thread({ id: 'b', archivedAt: '2026-11-01T00:00:00Z' })],
  ]);
  r.sessions.reconcile(threads, false);
  assert.deepEqual(r.ask(), [], 'nothing before the list has come, or a window just opened would end every shell');
  r.sessions.reconcile(threads, true);
  r.t.open();
  assert.deepEqual(r.ask().at(-1), { t: 'prune', keep: ['a', 'home'] });
  const before = r.ask().length;
  r.sessions.reconcile(new Map(threads), true);
  assert.equal(r.ask().length, before, 'not said again while nothing changed');
  r.sessions.reconcile(new Map([...threads, ['c', thread({ id: 'c' })]]), true);
  assert.deepEqual(r.ask().at(-1), { t: 'prune', keep: ['a', 'c', 'home'] });
});

test('the keep list is said again when the socket comes back, as the bridge may have restarted', () => {
  const r = rig();
  r.sessions.reconcile(new Map([['a', thread({ id: 'a' })]]), true);
  r.t.open();
  r.t.drop();
  r.sessions.start('a', undefined);
  r.t.open();
  const kinds = r.ask().map((m) => m.t);
  assert.equal(kinds.filter((k) => k === 'prune').length, 2);
  r.sessions.close();
});

test('a shell list that never came is an error in the snapshot, with the retry available, and does not wipe a good list', async () => {
  const r = rig();
  const first = r.sessions.loadShells();
  r.t.open();
  r.t.drop();
  assert.match((await first).unavailable ?? '', /couldn't reach/);
  assert.match(r.sessions.getSnapshot().shells?.unavailable ?? '', /couldn't reach/, 'the page reads the snapshot, not the answer');

  const again = r.sessions.loadShells(true);
  r.t.open();
  r.say({ t: 'shells', shells: [{ id: 'pwsh', label: 'PowerShell 7' }], auto: 'pwsh', notes: [] });
  assert.equal((await again).unavailable, undefined);
  assert.equal(r.sessions.getSnapshot().shells?.unavailable, undefined);
  r.t.drop();
  assert.equal(r.sessions.getSnapshot().shells?.auto, 'pwsh', 'a drop with nothing asked for leaves the list');
  r.sessions.close();
});

test("Windows Terminal's font is asked for, and kept as the bridge said it", () => {
  const r = rig();
  assert.equal(r.sessions.getSnapshot().wtFont, undefined, 'not asked at construction');
  r.sessions.loadFont();
  r.t.open();
  assert.deepEqual(r.ask(), [{ t: 'font' }]);
  r.say({ t: 'font', face: 'CaskaydiaCove Nerd Font Mono', size: 11 });
  assert.deepEqual(r.sessions.getSnapshot().wtFont, { face: 'CaskaydiaCove Nerd Font Mono', size: 11 });
  r.say({ t: 'font' });
  assert.equal(r.sessions.getSnapshot().wtFont, undefined, 'Windows Terminal no longer names a font');
  r.sessions.close();
});

test('a font answer is checked again: only a plain name and a sensible size are kept', () => {
  const r = rig();
  r.sessions.loadFont();
  r.t.open();
  r.say({ t: 'font', face: 'x"; } body { display: none }', size: 'big', settings: { secret: 1 } });
  assert.equal(r.sessions.getSnapshot().wtFont, undefined);
  r.say({ t: 'font', face: 'Fira Code', size: 5000, settings: { secret: 1 } });
  assert.deepEqual(r.sessions.getSnapshot().wtFont, { face: 'Fira Code' });
  r.say({ t: 'font', face: 7 });
  assert.equal(r.sessions.getSnapshot().wtFont, undefined);
});

test('the same font said again changes nothing the window would redraw for', () => {
  const r = rig();
  r.sessions.loadFont();
  r.t.open();
  r.say({ t: 'font', face: 'Fira Code' });
  const v = r.sessions.getSnapshot().version;
  r.say({ t: 'font', face: 'Fira Code' });
  assert.equal(r.sessions.getSnapshot().version, v);
  r.say({ t: 'font' });
  r.say({ t: 'font' });
  assert.equal(r.sessions.getSnapshot().version, v + 1);
});

test('the font choice is kept under its own key, read at the start, and shown at once', () => {
  const r = rig();
  assert.equal(r.sessions.getSnapshot().fontChoice, undefined, 'none made');
  assert.equal(r.sessions.setFont({ kind: 'custom', name: 'Iosevka Term' }), true);
  assert.equal(r.kept['threadbear.terminalFont'], 'custom:Iosevka Term');
  assert.deepEqual(r.sessions.getSnapshot().fontChoice, { kind: 'custom', name: 'Iosevka Term' });
  assert.equal(r.kept['threadbear.terminalShell'], undefined, "the shell's choice is not touched");

  const { t } = fake();
  const again = new TerminalSessions(() => t, { getItem: (k) => r.kept[k] ?? null, setItem: () => {} });
  assert.deepEqual(again.getSnapshot().fontChoice, { kind: 'custom', name: 'Iosevka Term' }, 'after a reload');
});

test("picking Windows Terminal's font asks the bridge again; other choices ask nothing", () => {
  const r = rig();
  r.sessions.setFont({ kind: 'default' });
  r.sessions.setFont({ kind: 'custom', name: 'Fira Code' });
  r.sessions.look('t1'); // something to connect for; the socket opens on it
  r.t.open();
  assert.deepEqual(r.ask(), [{ t: 'open', key: 't1', cols: 80, rows: 24, create: false }]);
  r.sessions.setFont({ kind: 'wt' });
  assert.deepEqual(r.ask().at(-1), { t: 'font' });
  assert.equal(r.ask().filter((m) => m.t === 'font').length, 1);
});

test("a window that can't keep the font choice says so, and still applies it", () => {
  const { t } = fake();
  const sessions = new TerminalSessions(() => t, { getItem: () => null, setItem: () => {} });
  assert.equal(sessions.setFont({ kind: 'default' }), false);
  assert.deepEqual(sessions.getSnapshot().fontChoice, { kind: 'default' });
});