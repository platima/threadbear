// Installs the runner on Linux for the desktop app: a systemd user service that
// starts when you log in and is kept running, and `tb` on your PATH. Everything
// it does is listed by --dry-run first, and docs/on-your-mac.md says what it
// leaves behind.
//
//   node scripts/install-linux.mjs --dry-run     say what it would do
//   node scripts/install-linux.mjs               install and start it
//   node scripts/install-linux.mjs --status      is the service there and running
//   node scripts/install-linux.mjs --installed   exit 0 if the service is there, 1 if not
//   node scripts/install-linux.mjs --start       start the service if it is there and not running
//   node scripts/install-linux.mjs --stop        stop it if it is running (it stays installed)
//   node scripts/install-linux.mjs --uninstall   stop and remove the service and `tb`
//
// It leaves ~/.config/systemd/user/threadbear-runner.service (this user's, no
// root) and ~/.local/bin/tb, a two-line script that runs tb with the Node the
// app brought. The data folder (~/Library/Application Support/Threadbear, the
// name macOS gives it, which the runner keeps on Linux) is the runner's own
// and stays.
//
// The service runs windows-run.mjs, the supervisor that restarts the runner
// with a wait that grows while it keeps failing and stops by itself when
// another runner has the data folder; systemd's own Restart= would only
// repeat that. This is not the Mac and Linux install of docs/setup-and-updates
// (install-runner.sh), which builds releases from a git checkout and follows
// main: this one runs the files the app was installed with, as the Windows
// one does. Use one or the other.
//
// --start is for the desktop app when it opens, so the runner comes back after
// an upgrade or a logout. It says in one line what it did and exits 0 unless
// something really went wrong.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UNIT = 'threadbear-runner.service';
export const OPTIONS = ['--dry-run', '--status', '--installed', '--start', '--stop', '--uninstall'];

// Text inside quotes in a unit: \ and " escaped, and % and $ doubled, since
// systemd expands specifiers (%h) and variables ($X) in a command line.
export function systemdQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

// A path as a unit's WorkingDirectory= reads it: not quoted, so a space is
// written \x20, and % is doubled.
const unitPath = (p) => p.replace(/\\/g, '\\x5c').replace(/ /g, '\\x20').replace(/%/g, '%%');

// What the service's PATH is: systemd gives a user service a bare one, and
// claude lives in ~/.local/bin, Node in the app's folder, and other tools
// wherever this person's shell finds them, so the PATH of the program
// installing it comes along, once each.
function servicePath(d) {
  const seen = new Set();
  const out = [];
  for (const dir of [d.binDir, path.dirname(d.node), ...(d.env.PATH || '').split(':'), '/usr/local/bin', '/usr/bin', '/bin']) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(':');
}

export function unitText(d) {
  return `[Unit]
Description=Threadbear runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(d.node)} ${systemdQuote(path.posix.join(d.root, 'scripts', 'windows-run.mjs'))}
WorkingDirectory=${unitPath(d.root)}
Environment=${systemdQuote(`PATH=${servicePath(d)}`)}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

function tbText(d) {
  return `#!/bin/sh\nexec ${JSON.stringify(d.node)} ${JSON.stringify(path.posix.join(d.root, 'bin', 'tb'))} "$@"\n`;
}

// Whether a file at ~/.local/bin/tb is one this wrote, so a tb someone else put
// there is never replaced or removed.
const isOurTb = (text) => /^#!\/bin\/sh\nexec ".*" ".*[\\/]bin[\\/]tb" "\$@"\n$/.test(text);

function readOr(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

// The whole thing, with its surroundings handed in so a test can stand in for
// the machine. Returns the exit code and what to print.
export function run(args, d) {
  const out = [];
  const say = (t) => out.push(t);
  const bad = args.find((a) => !OPTIONS.includes(a));
  if (bad) return { code: 2, out: [`install-linux.mjs: ${bad} is not an option.`, `Options: ${OPTIONS.join(' ')}. With none, the runner is installed and started at login.`] };
  const unit = path.join(d.unitsDir, UNIT);
  const tb = path.join(d.binDir, 'tb');
  const sc = (...a) => d.systemctl('--user', ...a);
  const installed = () => fs.existsSync(unit);
  const active = () => sc('is-active', UNIT).status === 0;
  const flag = (f) => args.includes(f);

  if (flag('--installed')) return { code: installed() ? 0 : 1, out };

  if (flag('--status')) {
    if (!installed()) say('The runner is not installed.');
    else say(`The runner is installed and ${active() ? 'running' : 'not running'}.`);
    return { code: 0, out };
  }

  if (flag('--start')) {
    if (!installed()) say('The runner is not installed, so nothing was started.');
    else if (active()) say('The runner is already running.');
    else {
      const r = sc('start', UNIT);
      if (r.status !== 0) return { code: 1, out: [`Could not start the runner: ${(r.stderr || r.stdout || '').trim()}`] };
      say('Started the runner.');
    }
    return { code: 0, out };
  }

  if (flag('--stop')) {
    if (installed() && active()) {
      sc('stop', UNIT);
      say('Stopped the runner (it stays installed).');
    } else say('The runner was not running.');
    return { code: 0, out };
  }

  if (flag('--uninstall')) {
    if (installed()) {
      sc('disable', '--now', UNIT);
      fs.rmSync(unit, { force: true });
      sc('daemon-reload');
      say(`Removed ${unit}.`);
    } else say('The runner service was not installed.');
    const mine = readOr(tb);
    if (mine !== undefined && isOurTb(mine)) {
      fs.rmSync(tb, { force: true });
      say(`Removed ${tb}.`);
    }
    return { code: 0, out };
  }

  // Install (or reinstall) and start, or say what that would be.
  const dry = flag('--dry-run');
  const existing = readOr(tb);
  const ownTb = existing === undefined || isOurTb(existing);
  if (dry) {
    say(`Would write ${unit} (runs the supervisor with ${d.node}).`);
    if (ownTb) say(`Would write ${tb} (runs tb with ${d.node}).`);
    else say(`Would leave ${tb} as it is: it isn't one this wrote.`);
    say(`Would run: systemctl --user daemon-reload`);
    say(`Would run: systemctl --user enable --now ${UNIT}`);
    return { code: 0, out };
  }
  const probe = sc('show-environment');
  if (probe.status !== 0) {
    return {
      code: 1,
      out: [
        `The runner needs systemd for your user (systemctl --user), and it isn't available here: ${(probe.stderr || probe.stdout || 'no answer').trim()}`,
        `Without it, start the runner by hand: node ${path.posix.join(d.root, 'scripts', 'windows-run.mjs')}`,
      ],
    };
  }
  fs.mkdirSync(d.unitsDir, { recursive: true });
  fs.writeFileSync(unit, unitText(d));
  say(`Wrote ${unit}.`);
  if (ownTb) {
    fs.mkdirSync(d.binDir, { recursive: true });
    fs.writeFileSync(tb, tbText(d), { mode: 0o755 });
    say(`Wrote ${tb}.`);
  } else say(`Left ${tb} as it was: it isn't one this wrote.`);
  sc('daemon-reload');
  const r = sc('enable', '--now', UNIT);
  if (r.status !== 0) return { code: 1, out: [...out, `Could not start the runner: ${(r.stderr || r.stdout || '').trim()}`] };
  say('The runner starts when you log in, and is running now.');
  if (!(d.env.PATH || '').split(':').includes(d.binDir)) say(`Add ${d.binDir} to your PATH to use tb.`);
  return { code: 0, out };
}

// ---------------------------------------------------------------- the real thing

function realDeps() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const home = os.homedir();
  const systemctlBin = process.env.THREADBEAR_SYSTEMCTL || 'systemctl';
  return {
    node: process.execPath,
    root,
    unitsDir: process.env.THREADBEAR_SYSTEMD_UNITS_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user'),
    binDir: process.env.THREADBEAR_BIN_DIR || path.join(home, '.local', 'bin'),
    env: process.env,
    systemctl(...a) {
      const r = spawnSync(systemctlBin, a, { encoding: 'utf8', timeout: 30_000 });
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, out } = run(process.argv.slice(2), realDeps());
  if (out.length) console.log(out.join('\n'));
  process.exit(code);
}
