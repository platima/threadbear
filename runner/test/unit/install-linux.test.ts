// runner/scripts/install-linux.mjs: the runner as a systemd user service for
// the desktop app on Linux, and `tb` on the PATH. It is run here with a fake
// systemctl and throwaway folders, so it never touches the machine it runs on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error a plain .mjs script
import { run, systemdQuote, unitText, UNIT } from '../../scripts/install-linux.mjs';
import { tmpDir } from '../helpers/fakes.ts';

type Call = string[];

// A systemd that remembers what it was told. `active` and `enabled` are what
// it answers to is-active and is-enabled.
function world(opts: { systemd?: boolean } = {}) {
  const home = fs.realpathSync(tmpDir('tb-install-linux-'));
  const state = { active: false, enabled: false, calls: [] as Call[], available: opts.systemd !== false };
  const unitsDir = path.join(home, '.config', 'systemd', 'user');
  const binDir = path.join(home, '.local', 'bin');
  // Where the app is installed: a name with a space and a % in it. The script only
  // writes it into text, so it is a string, not a folder (and the same on any host).
  const root = '/opt/threadbear/Threadbear Apps/100%/runner';
  const d = {
    node: '/opt/threadbear/node/bin/node',
    root,
    unitsDir,
    binDir,
    env: { PATH: '/usr/local/bin:/usr/bin:/home/me/.nvm/bin', HOME: home },
    systemctl(...args: string[]) {
      state.calls.push(args);
      if (!state.available) return { status: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' };
      const [verb] = args.filter((a) => a !== '--user');
      if (verb === 'is-active') return { status: state.active ? 0 : 3, stdout: state.active ? 'active\n' : 'inactive\n', stderr: '' };
      if (verb === 'is-enabled') return { status: state.enabled ? 0 : 1, stdout: state.enabled ? 'enabled\n' : 'disabled\n', stderr: '' };
      if (verb === 'enable') {
        state.enabled = true;
        if (args.includes('--now')) state.active = true;
      }
      if (verb === 'disable') {
        state.enabled = false;
        if (args.includes('--now')) state.active = false;
      }
      if (verb === 'start') state.active = true;
      if (verb === 'stop') state.active = false;
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  return { d, state, home, unitsDir, binDir, unit: path.join(unitsDir, UNIT), tb: path.join(binDir, 'tb') };
}

test('the unit runs the supervisor with the pinned Node, quotes what systemd would read, and names a PATH with the claude folder first', () => {
  const w = world();
  // (A posix bin folder, whatever this host is: the PATH is split on colons.)
  const d = { ...w.d, binDir: '/home/me/.local/bin' };
  const text = unitText(d);
  assert.match(text, /^\[Unit\]\nDescription=Threadbear runner/m);
  // A space is quoted; % is doubled for systemd's specifiers.
  assert.match(text, /^ExecStart="\/opt\/threadbear\/node\/bin\/node" ".*Threadbear Apps\/100%%\/runner\/scripts\/windows-run\.mjs"$/m);
  assert.match(text, /^WorkingDirectory=.*Threadbear\\x20Apps\/100%%\/runner$/m);
  const pathLine = /^Environment="PATH=([^"]*)"$/m.exec(text)?.[1] ?? '';
  const entries = pathLine.split(':');
  assert.equal(entries[0], d.binDir, "~/.local/bin, where claude is, is first");
  assert.ok(entries.includes('/opt/threadbear/node/bin') && entries.includes('/home/me/.nvm/bin') && entries.includes('/usr/bin'));
  assert.equal(new Set(entries).size, entries.length, 'no entry twice');
  assert.match(text, /^WantedBy=default\.target$/m);
});

test('systemdQuote: quotes, backslashes, % and $ are escaped the way systemd reads them', () => {
  assert.equal(systemdQuote('/a b/c'), '"/a b/c"');
  assert.equal(systemdQuote('50%'), '"50%%"');
  assert.equal(systemdQuote('$HOME'), '"$$HOME"');
  assert.equal(systemdQuote('a"b\\c'), '"a\\"b\\\\c"');
});

test('--dry-run says what it would do and does none of it', () => {
  const w = world();
  const r = run(['--dry-run'], w.d);
  assert.equal(r.code, 0);
  assert.match(r.out.join('\n'), /Would write .*threadbear-runner\.service/);
  assert.match(r.out.join('\n'), /Would write .*[\\/]tb/);
  assert.match(r.out.join('\n'), /systemctl --user enable --now threadbear-runner\.service/);
  assert.equal(fs.existsSync(w.unit), false);
  assert.equal(fs.existsSync(w.tb), false);
  assert.deepEqual(w.state.calls, []);
});

test('installing writes the unit and tb, reloads systemd, and enables and starts it; again changes nothing more', () => {
  const w = world();
  const r = run([], w.d);
  assert.equal(r.code, 0, r.out.join('\n'));
  assert.equal(fs.readFileSync(w.unit, 'utf8'), unitText(w.d));
  const tb = fs.readFileSync(w.tb, 'utf8');
  assert.match(tb, /^#!\/bin\/sh\nexec "\/opt\/threadbear\/node\/bin\/node" ".*runner\/bin\/tb" "\$@"\n$/);
  if (process.platform !== 'win32') assert.ok((fs.statSync(w.tb).mode & 0o111) !== 0, 'tb is executable');
  assert.deepEqual(w.state.calls.map((c) => c.join(' ')), ['--user show-environment', '--user daemon-reload', '--user enable --now threadbear-runner.service']);
  assert.equal(run(['--installed'], w.d).code, 0);
  const again = run([], w.d);
  assert.equal(again.code, 0);
  assert.equal(fs.readFileSync(w.unit, 'utf8'), unitText(w.d));
});

test('--on-demand installs the unit but does not enable it, and starts it; --mode says how it starts', () => {
  const w = world();
  assert.deepEqual(run(['--mode'], w.d).out, ['none']);

  const dry = run(['--on-demand', '--dry-run'], w.d);
  assert.match(dry.out.join('\n'), /systemctl --user disable threadbear-runner\.service/);
  assert.match(dry.out.join('\n'), /systemctl --user start threadbear-runner\.service/);
  assert.doesNotMatch(dry.out.join('\n'), /enable --now/);
  assert.deepEqual(w.state.calls, [], 'a dry run touches nothing');

  const r = run(['--on-demand'], w.d);
  assert.equal(r.code, 0, r.out.join('\n'));
  assert.equal(fs.readFileSync(w.unit, 'utf8'), unitText(w.d));
  assert.equal(w.state.enabled, false, 'so it does not start at login');
  assert.equal(w.state.active, true, 'but it is running now');
  assert.match(r.out.join('\n'), /does not start at login/);
  const calls = (): string[][] => w.state.calls; // (a function, so the deepEqual above doesn't narrow it to never[])
  assert.ok(!calls().some((c) => c.includes('enable')));
  assert.deepEqual(run(['--mode'], w.d).out, ['on-demand']);

  // Installing the usual way afterwards puts it back to starting at login.
  assert.equal(run([], w.d).code, 0);
  assert.equal(w.state.enabled, true);
  assert.deepEqual(run(['--mode'], w.d).out, ['sign-in']);
  // And on demand again switches it off at login.
  assert.equal(run(['--on-demand'], w.d).code, 0);
  assert.equal(w.state.enabled, false);
});

test('--mode takes a service whose state systemd will not give as a sign-in one, so it is never stopped by mistake', () => {
  const w = world();
  run([], w.d);
  w.d.systemctl = (...args: string[]) => (args.includes('is-enabled') ? { status: 1, stdout: '', stderr: 'Failed to get unit file state' } : { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(run(['--mode'], w.d).out, ['sign-in']);
});

test('--installed, --start and --stop go by the unit and what systemd says', () => {
  const w = world();
  assert.equal(run(['--installed'], w.d).code, 1, 'nothing yet');
  assert.match(run(['--start'], w.d).out.join(''), /not installed/);
  run([], w.d);
  w.state.active = false;
  w.state.calls.length = 0;
  assert.match(run(['--start'], w.d).out.join(''), /Started/);
  assert.ok(w.state.calls.some((c) => c.join(' ') === '--user start threadbear-runner.service'));
  w.state.calls.length = 0;
  assert.match(run(['--start'], w.d).out.join(''), /already running/);
  assert.ok(!w.state.calls.some((c) => c.includes('start')));
  assert.match(run(['--stop'], w.d).out.join(''), /Stopped/);
  assert.equal(w.state.active, false);
  assert.equal(run(['--installed'], w.d).code, 0, 'stopped, but still installed');
  assert.match(run(['--status'], w.d).out.join(''), /installed.*not running/i);
});

test('--uninstall stops and removes the service and tb, and leaves a tb that is not ours', () => {
  const w = world();
  run([], w.d);
  assert.equal(run(['--uninstall'], w.d).code, 0);
  assert.equal(fs.existsSync(w.unit), false);
  assert.equal(fs.existsSync(w.tb), false);
  assert.equal(w.state.enabled, false);
  assert.equal(run(['--installed'], w.d).code, 1);
  // Somebody else's tb is not touched, by an install or an uninstall.
  fs.mkdirSync(w.binDir, { recursive: true });
  fs.writeFileSync(w.tb, '#!/bin/sh\necho theirs\n');
  const r = run([], w.d);
  assert.equal(r.code, 0);
  assert.match(r.out.join('\n'), /left .*tb.*as it was/i);
  assert.equal(fs.readFileSync(w.tb, 'utf8'), '#!/bin/sh\necho theirs\n');
  run(['--uninstall'], w.d);
  assert.equal(fs.readFileSync(w.tb, 'utf8'), '#!/bin/sh\necho theirs\n');
});

test('with no user systemd, it says so and changes nothing', () => {
  const w = world({ systemd: false });
  const r = run([], w.d);
  assert.equal(r.code, 1);
  assert.match(r.out.join('\n'), /systemd/i);
  assert.equal(fs.existsSync(w.unit), false);
  assert.equal(run(['--installed'], w.d).code, 1);
});

test('an option it does not know is refused rather than ignored', () => {
  const w = world();
  const r = run(['--instal'], w.d);
  assert.equal(r.code, 2);
  assert.match(r.out.join('\n'), /--instal is not an option/);
  assert.equal(fs.existsSync(w.unit), false);
});
