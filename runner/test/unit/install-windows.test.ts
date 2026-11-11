// scripts/install-windows.mjs and windows-run.mjs. Task Scheduler is never touched: the
// installer is handed stand-ins for schtasks, and PowerShell is real only for the
// registry key, which is a throwaway one (never HKCU\Environment).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';
import { IS_WINDOWS, onlyOnWindows } from '../helpers/platform.ts';
import { killTreeWindows, pidExists, processImage, processInfo, sameStartTime } from '../../src/proc.ts';
import { readHolder } from '../../src/lock.ts';
import { dataDirFor, dataHomeFor } from '../../src/platform.ts';
import { loadConfig } from '../../src/config.ts';

const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');
const SCRIPTS = path.join(RUNNER_DIR, 'scripts');

process.env.THREADBEAR_INSTALL_NO_RUN = '1';
process.env.THREADBEAR_SUPERVISE_NO_RUN = '1';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inst: any = await import(pathToFileURL(path.join(SCRIPTS, 'install-windows.mjs')).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sup: any = await import(pathToFileURL(path.join(SCRIPTS, 'windows-run.mjs')).href);

const WINDOWS_ONLY = onlyOnWindows('Only Windows has Task Scheduler, PowerShell and cmd.exe');

const realPs = (command: string): string =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim();

// A registry key to stand in for HKCU\Environment, removed afterwards.
async function withKey<T>(fn: (key: string) => Promise<T> | T): Promise<T> {
  const key = `Software\\tb-test-${crypto.randomBytes(4).toString('hex')}`;
  try {
    return await fn(key);
  } finally {
    realPs(`Remove-Item -Path 'HKCU:\\${key}' -Recurse -ErrorAction SilentlyContinue; exit 0`);
  }
}

// Writes the PATH value by code points and kind, with nothing of the installer's in it.
function seed(key: string, value: string, kind: 'ExpandString' | 'String'): void {
  const codes = [...value].map((c) => c.codePointAt(0)).join(',');
  realPs(`$s = -join ((${codes}) | ForEach-Object { [char]$_ }); $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}'); $k.SetValue('Path', $s, '${kind}')`);
}
function stored(key: string): { value: string; kind: string } {
  const codes = realPs(`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}'); ($k.GetValue('Path', '', 'DoNotExpandEnvironmentNames').ToCharArray() | ForEach-Object { [int]$_ }) -join ','`);
  const kind = realPs(`[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}').GetValueKind('Path')`);
  return { value: String.fromCharCode(...codes.split(',').filter(Boolean).map(Number)), kind };
}

const PATH_WITH_LETTERS = 'C:\\Users\\Jos\u00e9\\bin;%USERPROFILE%\\x;C:\\Users\\M\u00fcller\\npm';

// ---------------------------------------------------------------- names

test('the task is named for the user, with the characters Task Scheduler refuses taken out', () => {
  assert.equal(inst.taskNameFor('Owner'), 'Threadbear Runner (Owner)');
  assert.equal(inst.taskNameFor('Jos\u00e9'), 'Threadbear Runner (Jos\u00e9)');
  assert.equal(inst.taskNameFor('a\\b/c:d*e?f"g<h>i|j[k]l'), 'Threadbear Runner (a_b_c_d_e_f_g_h_i_j_k_l)');
  assert.equal(inst.taskNameFor(''), inst.LEGACY_TASK);
  assert.notEqual(inst.taskNameFor('Ann'), inst.taskNameFor('Bob'));
});

// ---------------------------------------------------------------- tb.cmd

test('tb.cmd is the one line it always was when the paths are plain', () => {
  assert.equal(inst.tbCmdText({ node: 'C:\\Program Files\\nodejs\\node.exe', tbScript: 'D:\\x\\runner\\bin\\tb' }, {}), '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "D:\\x\\runner\\bin\\tb" %*\r\n');
});

test('tb.cmd names a path with letters outside ASCII by variable, so none of them are in the file', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\Zo\u00eb\\AppData\\Local', USERPROFILE: 'C:\\Users\\Zo\u00eb', ProgramFiles: 'C:\\Program Files' };
  const text = inst.tbCmdText({ node: 'C:\\Users\\Zo\u00eb\\AppData\\Local\\Programs\\Threadbear\\node\\node.exe', tbScript: 'C:\\Users\\Zo\u00eb\\tools\\runner\\bin\\tb' }, env);
  assert.equal(text, '@echo off\r\n"%LOCALAPPDATA%\\Programs\\Threadbear\\node\\node.exe" "%USERPROFILE%\\tools\\runner\\bin\\tb" %*\r\n');
  assert.doesNotMatch(text, /[^\x00-\x7f]/);
  // Variable names are case-insensitive on Windows, and a folder that only starts with the same letters isn't under it.
  assert.match(inst.tbCmdText({ node: 'c:\\users\\zo\u00eb\\n.exe', tbScript: 'x' }, { UserProfile: 'C:\\Users\\Zo\u00eb' }), /^@echo off\r\n"%USERPROFILE%\\n\.exe"/);
  assert.match(inst.tbCmdText({ node: 'C:\\Users\\Zo\u00ebx\\n.exe', tbScript: 'x' }, { USERPROFILE: 'C:\\Users\\Zo\u00eb' }), /chcp 65001/, 'not under it, so the code page is switched');
});

test('tb.cmd switches the console to UTF-8 and back when letters outside ASCII are left', () => {
  const text: string = inst.tbCmdText({ node: 'D:\\Tools\\n\u00f6de\\node.exe', tbScript: 'D:\\Repos\\\u00c9tude\\runner\\bin\\tb' }, {});
  const lines = text.split('\r\n');
  assert.equal(lines[0], '@echo off');
  assert.ok(lines.indexOf('chcp 65001 >nul') > 0 && lines.indexOf('chcp 65001 >nul') < lines.findIndex((l) => l.includes('n\u00f6de')), 'UTF-8 first, then the path');
  assert.ok(lines.some((l) => /^if defined TB_CP chcp %TB_CP% >nul$/.test(l)), 'and the old one back');
  assert.match(text, /exit \/b %TB_EXIT%/);
  assert.equal(inst.tbCmdText({ node: 'D:\\100%\\node.exe', tbScript: 'x' }, {}), '@echo off\r\n"D:\\100%%\\node.exe" "x" %*\r\n', 'a % in a batch file is doubled');
});

test('tb.cmd run from a folder with letters outside ASCII in its name finds its script, passes the arguments, and leaves the code page as it was', WINDOWS_ONLY, () => {
  const dir = path.join(tmpDir(), 'Zo\u00eb Jos\u00e9');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const script = path.join(dir, 'bin', 'tb.mjs');
  fs.writeFileSync(script, "console.log('ARGS ' + process.argv.slice(2).join(' '));\n");
  const tbCmd = path.join(dir, 'tb.cmd');
  fs.writeFileSync(tbCmd, inst.tbCmdText({ node: process.execPath, tbScript: script }, {}));
  const cmd = process.env.ComSpec || 'cmd.exe';
  const run = (line: string) => spawnSync(cmd, ['/d', '/s', '/c', `"${line}"`], { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true }).stdout;
  const page = (out: string) => /(\d{3,5})\s*$/.exec(out.trim())?.[1];
  const before = page(run('chcp'));
  const out = run(`"${tbCmd}" one two & chcp`);
  assert.match(out, /ARGS one two/);
  assert.equal(page(out), before, 'the console is back on the code page it started with');
});

// ---------------------------------------------------------------- the user PATH

test('the user PATH is read and written without losing letters outside ASCII or %VARIABLES%, and keeps its kind', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    seed(key, PATH_WITH_LETTERS, 'ExpandString');
    assert.equal(inst.readUserPath(realPs, key), PATH_WITH_LETTERS);
    inst.writeUserPath(realPs, key, `${inst.readUserPath(realPs, key)};D:\\add\\bin`);
    assert.deepEqual(stored(key), { value: `${PATH_WITH_LETTERS};D:\\add\\bin`, kind: 'ExpandString' });

    // A PATH that was a plain string stays one.
    seed(key, 'C:\\Users\\M\u00fcller\\bin', 'String');
    inst.writeUserPath(realPs, key, 'C:\\Users\\M\u00fcller\\bin;D:\\add\\bin');
    assert.deepEqual(stored(key), { value: 'C:\\Users\\M\u00fcller\\bin;D:\\add\\bin', kind: 'String' });
  });
});

test('a PATH with quotes, curly quotes, dollar signs and backticks goes through PowerShell as it is', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    const odd = "C:\\O'Brien\\bin;C:\\O\u2019Brien\\bin;C:\\a$b\\`c;C:\\q\"x";
    inst.writeUserPath(realPs, key, odd);
    assert.equal(stored(key).value, odd);
    assert.equal(inst.readUserPath(realPs, key), odd);
    assert.equal(stored(key).kind, 'ExpandString', 'a PATH that did not exist is written as an expandable string');
    assert.equal(inst.readUserPath(realPs, `${key}-missing`), '', 'no key, no PATH');
  });
});

// ------------------------------------------------------------ with stand-ins

type Fake = {
  d: { tmp: string; [k: string]: unknown };
  lines: string[];
  errors: string[];
  calls: string[][];
  tasks: Set<string>;
  xml: string[];
  set(o: { state?: string; states?: string[]; legacyOwner?: string; failRun?: boolean; noXml?: boolean }): void;
  binDir: string;
  // What happened, in order: task states asked for, End and Delete, and pids ended.
  events: string[];
};

// What --stop and --uninstall use to look at a process and end it: the runner's own
// functions (proc.ts, lock.ts), the same ones loadRunnerTools hands the script.
const realProcs = { pidExists, processImage, sameStartTime, readHolder, endTree: killTreeWindows };

function fake(key: string, tasks: string[] = []): Fake {
  const lines: string[] = [];
  const errors: string[] = [];
  const calls: string[][] = [];
  const xml: string[] = [];
  // The definition each task was made with; one that was there already counts as a sign-in task.
  const xmlOf = new Map<string, string>();
  const have = new Set(tasks);
  const opts: { state?: string; states?: string[]; legacyOwner?: string; failRun?: boolean; noXml?: boolean } = { state: 'Ready', legacyOwner: 'mine' };
  const events: string[] = [];
  const binDir = path.join(tmpDir(), 'Threadbear', 'bin');
  const d = {
    task: 'Threadbear Runner (Test)',
    me: 'PC\\Test',
    node: process.execPath,
    root: RUNNER_DIR,
    env: {},
    binDir,
    envKey: key,
    tmp: tmpDir(),
    out: (s: string) => lines.push(s),
    err: (s: string) => errors.push(s),
    // Where the runner keeps its data, and what --stop and --uninstall use to find a runner the
    // task left behind. Nothing is recorded there until a test writes runner.pid, and nothing
    // can be ended unless the test says how (see endingFor).
    home: path.join(tmpDir(), 'data'),
    procs: {
      ...realProcs,
      endTree: (pid: number): boolean => {
        throw new Error(`unexpected end of pid ${pid}`);
      },
    },
    // Where the supervisor notes its pid (windows-run.mjs). Nothing is there until a test says so.
    supervisorPidFile: path.join(tmpDir(), 'Logs', 'runner-supervisor.pid'),
    stopWaitMs: 300,
    pollMs: 10,
    schtasks: (...a: string[]) => {
      calls.push(a);
      if (a[0] === '/End' || a[0] === '/Delete') events.push(`${a[0]} ${a[2]}`);
      if (a[0] === '/Query') {
        if (!have.has(a[2])) throw new Error('ERROR: The system cannot find the file specified.');
        if (a[3] === '/XML') {
          if (opts.noXml) throw new Error('ERROR: Access is denied.');
          return xmlOf.get(a[2]) ?? '<Task><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers></Task>';
        }
        return 'Status: Ready\r\nLast Run Time: never\r\nOther: x\r\n';
      }
      if (a[0] === '/Delete') have.delete(a[2]);
      if (a[0] === '/Create') {
        const buf = fs.readFileSync(a[4]);
        xml.push(buf.subarray(2).toString('utf16le'));
        xmlOf.set(a[2], xml[xml.length - 1]);
        have.add(a[2]);
      }
      if (a[0] === '/Run' && opts.failRun) throw Object.assign(new Error('failed'), { stderr: 'ERROR: Access is denied.\r\n' });
      return '';
    },
    ps: (command: string) => {
      if (/Principal\.UserId/.test(command)) return opts.legacyOwner ?? 'none';
      if (/\)\.State/.test(command)) {
        // A list of states is read from the front until one is left, which then stays.
        const state = opts.states?.length ? (opts.states.length > 1 ? opts.states.shift()! : opts.states[0]) : (opts.state ?? '');
        events.push(`state ${state}`);
        return state;
      }
      return realPs(command);
    },
  };
  return { d, lines, errors, calls, tasks: have, xml, set: (o) => Object.assign(opts, o), binDir, events };
}

const verbs = (f: Fake) => f.calls.map((c) => `${c[0]} ${c[2] ?? ''}`.trim());

test('--start starts the task when it is there and stopped, and says so in one line', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    const f = fake(key, ['Threadbear Runner (Test)']);
    assert.equal(inst.runInstaller(['--start'], f.d), 0);
    assert.deepEqual(f.lines, ['Started the runner.']);
    assert.ok(verbs(f).includes('/Run Threadbear Runner (Test)'));
  });
});

test('--start does nothing, and exits 0, when the task is running, not installed, or turned off', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    const running = fake(key, ['Threadbear Runner (Test)']);
    running.set({ state: 'Running' });
    assert.equal(inst.runInstaller(['--start'], running.d), 0);
    assert.deepEqual(running.lines, ['The runner is already running.']);
    assert.ok(!verbs(running).some((v) => v.startsWith('/Run')));

    const none = fake(key, []);
    assert.equal(inst.runInstaller(['--start'], none.d), 0);
    assert.deepEqual(none.lines, ['The runner task is not installed, so nothing was started.']);
    assert.ok(!verbs(none).some((v) => v.startsWith('/Run')));

    const off = fake(key, ['Threadbear Runner (Test)']);
    off.set({ state: 'Disabled' });
    assert.equal(inst.runInstaller(['--start'], off.d), 0);
    assert.equal(off.lines.length, 1);
    assert.ok(!verbs(off).some((v) => v.startsWith('/Run')));

    // A task that can't be told running from stopped is started: a second start is ignored (IgnoreNew).
    const unknown = fake(key, ['Threadbear Runner (Test)']);
    unknown.set({ state: '' });
    assert.equal(inst.runInstaller(['--start'], unknown.d), 0);
    assert.ok(verbs(unknown).includes('/Run Threadbear Runner (Test)'));
  });
});

test('--start exits non-zero only when the start itself fails, and --start --dry-run touches nothing', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    const f = fake(key, ['Threadbear Runner (Test)']);
    f.set({ failRun: true });
    assert.equal(inst.runInstaller(['--start'], f.d), 1);
    assert.match(f.errors.join('\n'), /Could not start the runner task: ERROR: Access is denied\./);

    const dry = fake(key, ['Threadbear Runner (Test)']);
    assert.equal(inst.runInstaller(['--start', '--dry-run'], dry.d), 0);
    assert.deepEqual(dry.calls, []);
  });
});

test('an earlier install under the plain name is found by --installed, --start and --stop when it is this user\'s, and left alone when it is not', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    const mine = fake(key, ['Threadbear Runner']);
    assert.equal(inst.runInstaller(['--installed'], mine.d), 0);
    assert.equal(inst.runInstaller(['--start'], mine.d), 0);
    assert.ok(verbs(mine).includes('/Run Threadbear Runner'));
    assert.equal(inst.runInstaller(['--stop'], mine.d), 0);
    assert.ok(verbs(mine).includes('/End Threadbear Runner'));

    const theirs = fake(key, ['Threadbear Runner']);
    theirs.set({ legacyOwner: 'other' });
    assert.equal(inst.runInstaller(['--installed'], theirs.d), 1, "someone else's task is not this user's install");
    assert.equal(inst.runInstaller(['--stop'], theirs.d), 0);
    assert.equal(inst.runInstaller(['--uninstall'], theirs.d), 0);
    assert.ok(!verbs(theirs).some((v) => /^\/(End|Delete|Run)/.test(v)), `left alone: ${verbs(theirs)}`);

    const unsure = fake(key, ['Threadbear Runner']);
    unsure.set({ legacyOwner: 'unknown' });
    assert.equal(inst.runInstaller(['--stop'], unsure.d), 0);
    assert.ok(!verbs(unsure).some((v) => v.startsWith('/End')), 'when PowerShell would not say whose it is, it is left alone');
  });
});

test('installing registers this user\'s task, writes tb.cmd, adds its folder to the PATH keeping the rest, replaces an earlier plain-named task of this user\'s, and starts it', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    seed(key, PATH_WITH_LETTERS, 'ExpandString');
    const f = fake(key, ['Threadbear Runner']);
    assert.equal(inst.runInstaller([], f.d), 0);
    const v = verbs(f);
    assert.ok(v.indexOf('/Delete Threadbear Runner') > -1 && v.indexOf('/Delete Threadbear Runner') < v.indexOf('/Create Threadbear Runner (Test)'), 'the old one goes before the new one is made');
    assert.ok(v.indexOf('/Run Threadbear Runner (Test)') > v.indexOf('/Create Threadbear Runner (Test)'));
    assert.equal(f.xml.length, 1);
    assert.match(f.xml[0], /<UserId>PC\\Test<\/UserId>/);
    assert.match(f.xml[0], new RegExp(`<Arguments>--headless "[^"]+" "[^"]*windows-run\\.mjs"</Arguments>`));
    assert.ok(fs.existsSync(path.join(f.binDir, 'tb.cmd')));
    assert.deepEqual(stored(key), { value: `${PATH_WITH_LETTERS};${f.binDir}`, kind: 'ExpandString' });
    // The temp XML is gone.
    assert.deepEqual(fs.readdirSync(f.d.tmp).filter((n) => n.endsWith('.xml')), []);
    // Installing again leaves the PATH as it is.
    assert.equal(inst.runInstaller([], f.d), 0);
    assert.equal(stored(key).value, `${PATH_WITH_LETTERS};${f.binDir}`);
  });
});

test('the on-demand task has no trigger at all, and the usual one starts at logon', () => {
  const args = { node: 'C:\\n\\node.exe', script: 'C:\\r\\scripts\\windows-run.mjs', cwd: 'C:\\r', user: 'PC\\Test' };
  const usual = inst.taskXml(args);
  assert.match(usual, /<Triggers><LogonTrigger><Enabled>true<\/Enabled><UserId>PC\\Test<\/UserId><\/LogonTrigger><\/Triggers>/);
  assert.match(usual, /starts at logon/);
  const onDemand = inst.taskXml({ ...args, onDemand: true });
  assert.doesNotMatch(onDemand, /Triggers|LogonTrigger/);
  assert.match(onDemand, /started by the desktop app/);
  // Otherwise the same task: its principal, settings and what it runs.
  for (const part of [/<Principals>.*<\/Principals>/s, /<Settings>.*<\/Settings>/s, /<Actions Context="Author">.*<\/Actions>/s]) {
    assert.equal(onDemand.match(part)?.[0], usual.match(part)?.[0]);
  }
});

test('--mode says how the task starts: none, sign-in, on-demand, and sign-in when Task Scheduler will not show it', () => {
  const none = fake('unused', []);
  assert.equal(inst.runInstaller(['--mode'], none.d), 0);
  assert.deepEqual(none.lines, ['none']);

  const usual = fake('unused', ['Threadbear Runner (Test)']);
  assert.equal(inst.runInstaller(['--mode'], usual.d), 0);
  assert.deepEqual(usual.lines, ['sign-in']);
  assert.ok(!verbs(usual).some((v) => /^\/(Run|End|Delete|Create)/.test(v)), 'it only asks');

  const unsure = fake('unused', ['Threadbear Runner (Test)']);
  unsure.set({ noXml: true });
  assert.equal(inst.runInstaller(['--mode'], unsure.d), 0);
  assert.deepEqual(unsure.lines, ['sign-in'], 'a runner it cannot vouch for is never taken for an on-demand one');
});

test('--on-demand installs the task with no logon trigger, and installing again the usual way puts the trigger back', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    const f = fake(key, []);
    assert.equal(inst.runInstaller(['--on-demand'], f.d), 0);
    assert.equal(f.xml.length, 1);
    assert.doesNotMatch(f.xml[0], /LogonTrigger/);
    assert.match(f.lines.join('\n'), /no logon trigger/);
    assert.ok(verbs(f).includes('/Run Threadbear Runner (Test)'), 'and it is started now');
    assert.ok(fs.existsSync(path.join(f.binDir, 'tb.cmd')));
    f.lines.length = 0;
    assert.equal(inst.runInstaller(['--mode'], f.d), 0);
    assert.deepEqual(f.lines, ['on-demand']);

    assert.equal(inst.runInstaller([], f.d), 0);
    assert.match(f.xml[1], /<LogonTrigger>/);
    f.lines.length = 0;
    assert.equal(inst.runInstaller(['--mode'], f.d), 0);
    assert.deepEqual(f.lines, ['sign-in']);
  });
});

test('uninstalling takes out the task, tb.cmd and the PATH entry and keeps every other entry as it was', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    const f = fake(key, ['Threadbear Runner (Test)']);
    fs.mkdirSync(f.binDir, { recursive: true });
    fs.writeFileSync(path.join(f.binDir, 'tb.cmd'), 'x');
    seed(key, `${PATH_WITH_LETTERS};${f.binDir}`, 'ExpandString');
    assert.equal(inst.runInstaller(['--uninstall'], f.d), 0);
    assert.deepEqual(verbs(f).filter((c) => /^\/(End|Delete)/.test(c)), ['/End Threadbear Runner (Test)', '/Delete Threadbear Runner (Test)']);
    assert.ok(!fs.existsSync(path.join(f.binDir, 'tb.cmd')));
    assert.deepEqual(stored(key), { value: PATH_WITH_LETTERS, kind: 'ExpandString' });
  });
});

test('--dry-run says what each does and changes nothing', WINDOWS_ONLY, async () => {
  await withKey((key) => {
    seed(key, PATH_WITH_LETTERS, 'ExpandString');
    for (const flag of [[], ['--stop'], ['--uninstall'], ['--start']]) {
      const f = fake(key, ['Threadbear Runner (Test)']);
      assert.equal(inst.runInstaller([...flag, '--dry-run'], f.d), 0);
      assert.ok(f.lines.length > 0);
      assert.ok(!verbs(f).some((c) => /^\/(End|Delete|Run|Create)/.test(c)), `${flag}: ${verbs(f)}`);
      assert.ok(!fs.existsSync(path.join(f.binDir, 'tb.cmd')));
    }
    assert.equal(stored(key).value, PATH_WITH_LETTERS);
  });
});

test('run as a program, --stop --dry-run prints its plan and exits 0, and a non-Windows host is told where to look', () => {
  const run = (...a: string[]) => {
    const r = spawn(process.execPath, [path.join(SCRIPTS, 'install-windows.mjs'), ...a], { env: { ...process.env, THREADBEAR_INSTALL_NO_RUN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    r.stdout.on('data', (c) => (out += c));
    r.stderr.on('data', (c) => (out += c));
    return new Promise<{ code: number | null; out: string }>((resolve) => r.once('close', (code) => resolve({ code, out })));
  };
  return run('--stop', '--dry-run').then((r) => {
    if (IS_WINDOWS) {
      assert.equal(r.code, 0);
      assert.match(r.out, /^End the task "Threadbear Runner \(.+\)"/);
    } else {
      assert.equal(r.code, 2);
      assert.match(r.out, /install-runner\.sh/);
    }
  });
});

// ------------------------------------------------------------ the supervisor

test('the supervisor waits longer after each quick failure, and starts again at the first wait after a runner that ran a minute', () => {
  const { nextWait, FIRST_WAIT_MS, MAX_WAIT_MS, HEALTHY_MS } = sup;
  assert.equal(nextWait(0, 1000), FIRST_WAIT_MS);
  let wait = 0;
  const seen: number[] = [];
  for (let i = 0; i < 12; i++) {
    wait = nextWait(wait, 500);
    seen.push(wait);
  }
  assert.deepEqual(seen.slice(0, 4), [5000, 10_000, 20_000, 40_000]);
  assert.equal(seen[seen.length - 1], MAX_WAIT_MS, 'and stops at the cap');
  assert.ok(seen.every((w, i) => i === 0 || w >= seen[i - 1]));
  assert.equal(nextWait(MAX_WAIT_MS, HEALTHY_MS), FIRST_WAIT_MS);
  assert.equal(nextWait(MAX_WAIT_MS, HEALTHY_MS - 1), MAX_WAIT_MS);
  assert.match('Another runner (pid 4242) is already using C:\\x; not starting.', sup.ALREADY_RUNNING);
  assert.doesNotMatch('could not listen', sup.ALREADY_RUNNING);
});

// Runs the supervisor against a stand-in for the runner. Resolves when it ends, or
// `ms` later with what it logged so far, ending it itself in that case.
// `appData` is the %LOCALAPPDATA% to give it (its log and note are kept there): the folder of its
// own unless a test starts a second supervisor for the same user.
function startSupervisor(entryBody: string, appData?: string): { sv: ChildProcess; dir: string; logFile: string } {
  const dir = tmpDir();
  const home = appData ?? dir;
  const entry = path.join(dir, 'fake-main.mjs');
  fs.writeFileSync(entry, entryBody);
  const sv = spawn(process.execPath, [path.join(SCRIPTS, 'windows-run.mjs')], {
    env: { ...process.env, THREADBEAR_SUPERVISE_NO_RUN: '', LOCALAPPDATA: home, HOME: home, THREADBEAR_SUPERVISE_ENTRY: entry, THREADBEAR_SUPERVISE_FIRST_WAIT_MS: '100' },
    stdio: 'ignore',
  });
  // Where the supervisor keeps its log: %LOCALAPPDATA%\Threadbear\Logs on Windows,
  // ~/Library/Logs elsewhere (it runs the Linux service too).
  const logFile = IS_WINDOWS ? path.join(home, 'Threadbear', 'Logs', 'runner-supervisor.log') : path.join(home, 'Library', 'Logs', 'runner-supervisor.log');
  return { sv, dir, logFile };
}

function supervise(entryBody: string, ms: number): Promise<{ code: number | null; log: string; ended: boolean }> {
  const { sv, logFile } = startSupervisor(entryBody);
  return new Promise((resolve) => {
    let ended = true;
    const timer = setTimeout(() => {
      ended = false;
      sv.kill(); // the supervisor started here, by this test
    }, ms);
    sv.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '', ended });
    });
  });
}

test('a runner that finds the data folder in use ends the supervisor with exit code 0, once, without starting it again', async () => {
  const r = await supervise(`process.stderr.write('Another runner (pid 4242) is already using C:\\\\data; not starting.\\n'); process.exit(1);\n`, 20_000);
  assert.equal(r.ended, true, 'the supervisor stopped itself');
  assert.equal(r.code, 0);
  assert.equal((r.log.match(/started the runner/g) ?? []).length, 1);
  assert.match(r.log, /another runner is already using the data folder/);
  assert.match(r.log, /Another runner \(pid 4242\)/, 'what the runner said is in the log');
});

test('a runner that keeps failing is started again after longer and longer waits', async () => {
  const r = await supervise(`process.exit(3);\n`, 2500);
  assert.equal(r.ended, false, 'a failing runner does not end the supervisor');
  const waits = [...r.log.matchAll(/starting it again in ([\d.]+) s/g)].map((m) => Number(m[1]));
  assert.deepEqual(waits.slice(0, 3), [0.1, 0.2, 0.4]);
  assert.match(r.log, /the runner exited \(3\)/);
});

test('the supervisor logs its own pid and the node it runs on', async () => {
  const r = await supervise(`process.exit(3);\n`, 800);
  assert.match(r.log, new RegExp(`^\\S+ supervisor pid \\d+, node ${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.ok(r.log.indexOf('supervisor pid') < r.log.indexOf('started the runner'), 'before it starts the runner');
});

// ---------------------------------------------- ending a runner the task left behind

// Programs standing in for a runner: a copy of node at <dir>\node\node.exe doing nothing, started
// here and ended here (by its own handle, never by name). The real node.exe is never touched.
const standIns: ChildProcess[] = [];
after(() => {
  for (const c of standIns) if (c.exitCode === null && c.signalCode === null) c.kill();
});

type StandIn = { exe: string; pid: number; child: ChildProcess };

function startStandIn(dir: string): StandIn {
  const exe = path.join(dir, 'node', 'node.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.copyFileSync(process.execPath, exe);
  const child = spawn(exe, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  standIns.push(child);
  return { exe, pid: child.pid!, child };
}

// True once the process has exited, false if it is still there after `ms`.
const exits = (c: ChildProcess, ms = PATIENCE_MS): Promise<boolean> =>
  c.exitCode !== null || c.signalCode !== null
    ? Promise.resolve(true)
    : new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        c.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

async function until(what: string, fn: () => boolean, ms = PATIENCE_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Ends stand-ins by their own handles and waits until they are gone, so their folders can be removed.
async function ended(...these: StandIn[]): Promise<void> {
  for (const s of these) s.child.kill();
  for (const s of these) await exits(s.child);
}

// run/runner.pid as the runner writes it: its pid and start time.
function recordRunner(f: Fake, who: { pid: number }, lstart = processInfo(who.pid)!.lstart): void {
  const run = path.join(f.d.home as string, 'run');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'runner.pid'), JSON.stringify({ pid: who.pid, lstart }) + '\n');
}

// Lets the installer really end a pid (with taskkill, as the runner does), and notes it.
function mayEnd(f: Fake): void {
  f.d.procs = {
    ...realProcs,
    endTree: (pid: number) => {
      f.events.push(`end ${pid}`);
      return killTreeWindows(pid);
    },
  };
}

const TASK = 'Threadbear Runner (Test)';

test('--stop ends the runner the task did not take with it, by its pid, and leaves a node.exe from anywhere else alone', WINDOWS_ONLY, async () => {
  const runner = startStandIn(path.join(tmpDir(), 'Programs', 'Threadbear'));
  const other = startStandIn(path.join(tmpDir(), 'Other'));
  try {
    const f = fake('unused', [TASK]);
    f.d.node = runner.exe.toUpperCase(); // the install's node; Windows paths do not care about case
    mayEnd(f);
    recordRunner(f, runner);
    // The fake schtasks /End does nothing, as when the task's processes are not all taken.
    assert.equal(inst.runInstaller(['--stop'], f.d), 0);
    assert.equal(f.lines.length, 2, f.lines.join('\n'));
    assert.match(f.lines[0], /^End the task "Threadbear Runner \(Test\)"/);
    assert.equal(f.lines[1], `Ended the runner (pid ${runner.pid}), which the task had not stopped.`);
    assert.deepEqual(f.events, [`/End ${TASK}`, 'state Ready', `end ${runner.pid}`], 'the task is ended, looked at, and only then the process');
    assert.equal(await exits(runner.child), true, 'the stand-in runner is gone');
    assert.equal(pidExists(runner.pid), false);
    assert.equal(pidExists(other.pid), true, 'the control is untouched');
  } finally {
    await ended(runner, other);
  }
});

test('--stop does not end a process that has the runner\'s pid but another start time, and says the runner is not running', WINDOWS_ONLY, async () => {
  const runner = startStandIn(path.join(tmpDir(), 'Programs', 'Threadbear'));
  try {
    const f = fake('unused', [TASK]);
    f.d.node = runner.exe;
    mayEnd(f);
    // A runner that exited long ago, whose pid something else (here, the stand-in) now has.
    recordRunner(f, runner, String(BigInt(processInfo(runner.pid)!.lstart) - 36_000_000_000n));
    assert.equal(inst.runInstaller(['--stop'], f.d), 0);
    assert.equal(f.lines[1], `The runner is not running (pid ${runner.pid} belongs to another program now, so it was left alone).`);
    assert.ok(!f.events.some((e) => e.startsWith('end ')), f.events.join(', '));
    assert.equal(pidExists(runner.pid), true);
    assert.equal(await exits(runner.child, 300), false);
  } finally {
    await ended(runner);
  }
});

test('--stop reports, and does not end, a runner that runs from another node, and exits 1 because it still lives', WINDOWS_ONLY, async () => {
  const install = startStandIn(path.join(tmpDir(), 'Programs', 'Threadbear'));
  const other = startStandIn(path.join(tmpDir(), 'Other'));
  try {
    const f = fake('unused', [TASK]);
    f.d.node = install.exe;
    mayEnd(f);
    recordRunner(f, other); // the right pid and start time, but a different program path
    assert.equal(inst.runInstaller(['--stop'], f.d), 1);
    assert.equal(f.lines.length, 2);
    assert.match(f.lines[1], new RegExp(`^The runner \\(pid ${other.pid}\\) is running from .*Other.node.node\\.exe, not from this install's Node \\(.*Programs.Threadbear.node.node\\.exe\\), so it was left running\\.$`));
    assert.ok(!f.events.some((e) => e.startsWith('end ')));
    assert.equal(pidExists(other.pid), true);
    assert.equal(pidExists(install.pid), true);
  } finally {
    await ended(install, other);
  }
});

test('--stop does not end a process whose start time or program it cannot read', WINDOWS_ONLY, async () => {
  const runner = startStandIn(path.join(tmpDir(), 'Programs', 'Threadbear'));
  try {
    for (const answer of [null, { lstart: processInfo(runner.pid)!.lstart, path: '' }]) {
      const f = fake('unused', [TASK]);
      f.d.node = runner.exe;
      mayEnd(f);
      (f.d.procs as Record<string, unknown>).processImage = () => answer;
      recordRunner(f, runner);
      assert.equal(inst.runInstaller(['--stop'], f.d), 1, JSON.stringify(answer));
      assert.equal(f.lines[1], `Could not tell what program pid ${runner.pid} is, so it was left running.`);
      assert.ok(!f.events.some((e) => e.startsWith('end ')));
      assert.equal(pidExists(runner.pid), true);
    }
  } finally {
    await ended(runner);
  }
});

// A runner that was hard-killed never deletes run/runner.pid, so a stale one is the usual state
// while the runner is stopped, and its pid can be a service or an elevated program by now, one
// Get-Process will not give a start time or program for. setup-sync.mjs reads the exit code of
// --stop and will not restart the runner when it is 1, so nothing of ours running is the only
// thing that may make it 1. System (pid 4) is such a process, and always there; it is only ever
// looked at, and the stand-in for endTree throws if anything tries to end it.
test('--stop says the runner is not running, and exits 0, when runner.pid is stale and its pid is now a program whose path cannot be read', WINDOWS_ONLY, () => {
  // Whatever it is, its start time is not the one recorded.
  const stub = fake('unused', [TASK]);
  mayEnd(stub);
  (stub.d.procs as Record<string, unknown>).processImage = () => ({ lstart: '2', path: '' });
  recordRunner(stub, { pid: 4 }, '1');
  assert.equal(inst.runInstaller(['--stop'], stub.d), 0, stub.lines.join('\n'));
  assert.equal(stub.lines[1], 'The runner is not running (pid 4 belongs to another program now, so it was left alone).');

  // And with the runner's own tools reading the real thing.
  const real = fake('unused', [TASK]);
  real.d.procs = { ...realProcs, endTree: (pid: number): boolean => assert.fail(`pid ${pid} must not be ended`) };
  const system = processImage(4);
  assert.ok(system, 'the system process shows a start time');
  recordRunner(real, { pid: 4 }, String(BigInt(system.lstart) - 36_000_000_000n));
  assert.equal(inst.runInstaller(['--stop'], real.d), 0, real.lines.join('\n'));
  assert.equal(real.lines[1], 'The runner is not running (pid 4 belongs to another program now, so it was left alone).');
});

test('--stop still exits 1 when the process is the one recorded and its program cannot be read, as nothing then says it is not our runner', WINDOWS_ONLY, () => {
  const f = fake('unused', [TASK]);
  f.d.procs = { ...realProcs, endTree: (pid: number): boolean => assert.fail(`pid ${pid} must not be ended`) };
  const system = processImage(4);
  assert.ok(system);
  recordRunner(f, { pid: 4 }, system.lstart); // what a runner's own record of itself would say
  assert.equal(inst.runInstaller(['--stop'], f.d), 1);
  assert.equal(f.lines[1], 'Could not tell what program pid 4 is, so it was left running.');
});

test('--stop with no runner recorded, or a record of one that has gone, ends nothing and says it is not running', WINDOWS_ONLY, async () => {
  const none = fake('unused', [TASK]);
  mayEnd(none);
  assert.equal(inst.runInstaller(['--stop'], none.d), 0);
  assert.equal(none.lines[1], 'The runner is not running.');

  // A pid file left by a runner that has exited.
  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const lstart = processInfo(gone.pid!)?.lstart ?? '1';
  await exits(gone);
  const stale = fake('unused', [TASK]);
  mayEnd(stale);
  recordRunner(stale, gone as { pid: number }, lstart);
  assert.equal(inst.runInstaller(['--stop'], stale.d), 0);
  assert.equal(stale.lines[1], 'The runner is not running.');
  assert.ok(!stale.events.some((e) => e.startsWith('end ')));

  // Nor does an unreadable file make it end anything.
  const junk = fake('unused', [TASK]);
  mayEnd(junk);
  fs.mkdirSync(path.join(junk.d.home as string, 'run'), { recursive: true });
  fs.writeFileSync(path.join(junk.d.home as string, 'run', 'runner.pid'), 'not json');
  assert.equal(inst.runInstaller(['--stop'], junk.d), 0);
  assert.equal(junk.lines[1], 'The runner is not running.');
});

test('--stop waits for the task to stop running before it looks at the process, and says so when it does not', WINDOWS_ONLY, () => {
  const f = fake('unused', [TASK]);
  f.set({ states: ['Running', 'Running', 'Ready'] });
  assert.equal(inst.runInstaller(['--stop'], f.d), 0);
  assert.deepEqual(f.events, [`/End ${TASK}`, 'state Running', 'state Running', 'state Ready']);
  assert.equal(f.lines[1], 'The runner is not running.');

  const stuck = fake('unused', [TASK]);
  stuck.set({ state: 'Running' });
  assert.equal(inst.runInstaller(['--stop'], stuck.d), 1);
  assert.ok(stuck.events.filter((e) => e === 'state Running').length >= 3, 'it kept asking');
  assert.equal(stuck.lines[1], `The task "${TASK}" is still running after 0.3 s.`);

  // A task Task Scheduler will not describe is not waited for.
  const unknown = fake('unused', [TASK]);
  unknown.set({ state: '' });
  assert.equal(inst.runInstaller(['--stop'], unknown.d), 0);
  assert.deepEqual(unknown.events, [`/End ${TASK}`, 'state ']);
});

test('--uninstall ends the task and the runner it left, and only then deletes the task', WINDOWS_ONLY, async () => {
  const runner = startStandIn(path.join(tmpDir(), 'Programs', 'Threadbear'));
  try {
    await withKey(async (key) => {
      const f = fake(key, [TASK]);
      f.d.node = runner.exe;
      mayEnd(f);
      recordRunner(f, runner);
      assert.equal(inst.runInstaller(['--uninstall'], f.d), 0);
      assert.deepEqual(f.events, [`/End ${TASK}`, 'state Ready', `end ${runner.pid}`, `/Delete ${TASK}`]);
      assert.ok(f.lines.includes(`Ended the runner (pid ${runner.pid}), which the task had not stopped.`), f.lines.join('\n'));
      assert.match(f.lines[f.lines.length - 1], /^Removed\./);
      assert.equal(await exits(runner.child), true);
    });
  } finally {
    await ended(runner);
  }
});

// A stand-in for the runner that notes each start, so a runner started again shows.
const startsBody = (): string => `
import fs from 'node:fs';
import path from 'node:path';
fs.appendFileSync(path.join(import.meta.dirname, 'starts.txt'), process.pid + '\\n');
setInterval(() => {}, 1000);
`;

// The premise the stop rests on is that Task Scheduler's End may leave the task's processes
// behind (the fake schtasks /End does nothing, as above). The supervisor is one of them: it sees
// its runner end, waits, and starts another on the same node.exe, so ending only the runner
// would leave a new one on its way while --stop says it is done.
test('--stop ends the supervisor the task left behind, so it does not start the runner again, and the runner with it', WINDOWS_ONLY, async () => {
  const { sv, dir } = startSupervisor(startsBody());
  const starts = path.join(dir, 'starts.txt');
  const startedPids = (): number[] => (fs.existsSync(starts) ? fs.readFileSync(starts, 'utf8').split('\n').filter(Boolean).map(Number) : []);
  // The runners this test's supervisor started, with their start times, so that what is cleaned
  // up below is only ever one of them and never a pid something else has taken since.
  const mine = new Map<number, string>();
  const note = () => {
    for (const pid of startedPids()) if (!mine.has(pid)) mine.set(pid, processInfo(pid)?.lstart ?? '');
  };
  try {
    const f = fake('unused', [TASK]);
    const pidFile = inst.supervisorPidFileFor({ LOCALAPPDATA: dir });
    f.d.supervisorPidFile = pidFile;
    mayEnd(f);
    await until('the supervisor to note its pid and start the runner', () => readHolder(pidFile) !== null && startedPids().length === 1);
    note();
    const runnerPid = startedPids()[0];
    recordRunner(f, { pid: runnerPid });
    assert.equal(readHolder(pidFile)?.pid, sv.pid, 'the file names the supervisor');

    assert.equal(inst.runInstaller(['--stop'], f.d), 0, f.lines.join('\n'));
    assert.equal(f.lines[1], `Ended the supervisor (pid ${sv.pid}), which the task had not stopped.`);
    assert.ok(f.events.includes(`end ${sv.pid}`), f.events.join(', '));
    assert.equal(await exits(sv), true, 'the supervisor is gone');
    await until('the runner to be gone', () => !pidExists(runnerPid));

    // Longer than the supervisor waits before it starts a runner again (100 ms here).
    await new Promise((r) => setTimeout(r, 1500));
    note();
    assert.deepEqual(startedPids(), [runnerPid], 'no runner was started again');
    assert.equal(pidExists(runnerPid), false);
  } finally {
    sv.kill(); // the supervisor this test started
    note();
    for (const [pid, lstart] of mine) if (pidExists(pid) && processInfo(pid)?.lstart === lstart) process.kill(pid);
  }
});

test('--stop ends the supervisor even when its runner has just ended and is being waited for, and says nothing of a supervisor that is not there', WINDOWS_ONLY, async () => {
  // The supervisor's wait between one runner and the next is when nothing is recorded as running.
  const { sv, dir } = startSupervisor(`process.exit(3);\n`);
  try {
    const pidFile = inst.supervisorPidFileFor({ LOCALAPPDATA: dir });
    const f = fake('unused', [TASK]);
    f.d.supervisorPidFile = pidFile;
    mayEnd(f);
    await until('the supervisor to note its pid', () => readHolder(pidFile) !== null);
    assert.equal(inst.runInstaller(['--stop'], f.d), 0, f.lines.join('\n'));
    assert.equal(f.lines[1], `Ended the supervisor (pid ${sv.pid}), which the task had not stopped.`);
    assert.equal(f.lines[2], 'The runner is not running.');
    assert.equal(await exits(sv), true);

    // Its note is still there, for a pid that is gone: nothing to end, nothing to say.
    const again = fake('unused', [TASK]);
    again.d.supervisorPidFile = pidFile;
    mayEnd(again);
    assert.equal(inst.runInstaller(['--stop'], again.d), 0);
    assert.equal(again.lines.length, 2, again.lines.join('\n'));
    assert.ok(!again.events.some((e) => e.startsWith('end ')));
  } finally {
    sv.kill();
  }
});

test('--stop leaves a supervisor on another node alone and reports it, and does not mistake a pid something else has now for one', WINDOWS_ONLY, async () => {
  const install = startStandIn(path.join(tmpDir(), 'Programs', 'Threadbear'));
  const other = startStandIn(path.join(tmpDir(), 'Other'));
  try {
    const noteSupervisor = (f: Fake, who: { pid: number }, lstart = processInfo(who.pid)!.lstart) => {
      const file = f.d.supervisorPidFile as string;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ pid: who.pid, lstart }) + '\n');
    };

    // Right pid and start time, but it runs from some other node.exe than the one this script runs on.
    const foreign = fake('unused', [TASK]);
    foreign.d.node = install.exe;
    mayEnd(foreign);
    noteSupervisor(foreign, other);
    assert.equal(inst.runInstaller(['--stop'], foreign.d), 1, foreign.lines.join('\n'));
    assert.match(foreign.lines[1], new RegExp(`^The supervisor \\(pid ${other.pid}\\) is running from .*Other.node.node\\.exe, not from this install's Node \\(.*Programs.Threadbear.node.node\\.exe\\), so it was left running\\.$`));

    // A note left by a supervisor that ended long ago, whose pid this stand-in has now.
    const reused = fake('unused', [TASK]);
    reused.d.node = other.exe;
    mayEnd(reused);
    noteSupervisor(reused, other, String(BigInt(processInfo(other.pid)!.lstart) - 36_000_000_000n));
    assert.equal(inst.runInstaller(['--stop'], reused.d), 0, reused.lines.join('\n'));
    assert.equal(reused.lines.length, 2, 'nothing is said of it');
    assert.ok(!reused.events.some((e) => e.startsWith('end ')));

    // A pid whose start time or program cannot be read at all.
    const unreadable = fake('unused', [TASK]);
    unreadable.d.node = other.exe;
    mayEnd(unreadable);
    (unreadable.d.procs as Record<string, unknown>).processImage = () => null;
    noteSupervisor(unreadable, other);
    assert.equal(inst.runInstaller(['--stop'], unreadable.d), 1);
    assert.equal(unreadable.lines[1], `Could not tell what program pid ${other.pid} is, so it was left running.`);
    assert.ok(!unreadable.events.some((e) => e.startsWith('end ')));

    assert.equal(pidExists(other.pid), true);
    assert.equal(pidExists(install.pid), true);
  } finally {
    await ended(install, other);
  }
});

test('the supervisor notes its pid and start time beside its log, and takes the note away when it ends itself because another runner has the folder', WINDOWS_ONLY, async () => {
  // The stand-in runner looks for the note when it starts, then says another runner is in charge.
  const body = `
import fs from 'node:fs';
import path from 'node:path';
const note = path.join(process.env.LOCALAPPDATA, 'Threadbear', 'Logs', 'runner-supervisor.pid');
fs.writeFileSync(path.join(import.meta.dirname, 'seen.txt'), fs.existsSync(note) ? fs.readFileSync(note, 'utf8') : 'none');
process.stderr.write('Another runner (pid 4242) is already using C:\\\\data; not starting.\\n');
process.exit(1);
`;
  const { sv, dir } = startSupervisor(body);
  try {
    const file = inst.supervisorPidFileFor({ LOCALAPPDATA: dir });
    assert.equal(await exits(sv), true, 'the supervisor ended itself');
    const seen = fs.readFileSync(path.join(dir, 'seen.txt'), 'utf8');
    const note = JSON.parse(seen) as { pid: number; lstart: string };
    assert.equal(note.pid, sv.pid, 'it was there before the runner started, naming the supervisor');
    assert.match(note.lstart, /^~\d+$/, 'with a start time worked out in-process, as the supervisor does not run PowerShell');
    assert.equal(fs.existsSync(file), false, 'and it is gone now');
  } finally {
    sv.kill();
  }
});

test('the note the supervisor writes is one --stop reads: its start time matches the system\'s for that process', WINDOWS_ONLY, async () => {
  const { sv, dir } = startSupervisor(startsBody());
  try {
    const file = inst.supervisorPidFileFor({ LOCALAPPDATA: dir });
    await until('the supervisor to note its pid', () => readHolder(file) !== null);
    const note = readHolder(file)!;
    assert.equal(note.pid, sv.pid);
    assert.ok(note.lstart);
    assert.equal(sameStartTime(note.lstart!, processInfo(sv.pid!)!.lstart), true, 'so a live supervisor is recognised, and a reused pid is not');
    assert.equal(sameStartTime(note.lstart!, String(BigInt(processInfo(sv.pid!)!.lstart) + 36_000_000_000n)), false);
  } finally {
    sv.kill();
  }
});

// ------------------------------------- more than one supervisor for the same user
//
// Task Scheduler's End may leave a supervisor running, and the task can then be started again (or
// two are started together). Whatever happens, every supervisor that is still running must be the
// one runner-supervisor.pid names, or --stop ends the one it finds and the other starts the runner
// again. So a supervisor never replaces or removes the note of one that is running, and one that
// finds another running stops at once, leaving its note as it was.

// The runners startsBody stand-ins noted in <dir>\starts.txt.
const startedIn = (dir: string): number[] => {
  const file = path.join(dir, 'starts.txt');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : [];
};

// What a test that starts supervisors ends when it is done: the supervisors, by their own handles,
// and the stand-in runners they started, each only if it has the start time it had when the test
// saw it, so never a pid something else has taken since.
function tidy() {
  const supervisors: ChildProcess[] = [];
  const runners = new Map<number, string>();
  return {
    add(sv: ChildProcess): void {
      supervisors.push(sv);
    },
    note(dir: string): void {
      for (const pid of startedIn(dir)) if (!runners.has(pid)) runners.set(pid, processInfo(pid)?.lstart ?? '');
    },
    end(): void {
      for (const sv of supervisors) sv.kill();
      for (const [pid, lstart] of runners) if (lstart && pidExists(pid) && processInfo(pid)?.lstart === lstart) process.kill(pid);
    },
  };
}

test('a second supervisor started while one is running leaves its note alone, starts no runner, and stops with exit code 0, so --stop still ends the first', WINDOWS_ONLY, async () => {
  const mine = tidy();
  const first = startSupervisor(startsBody());
  mine.add(first.sv);
  try {
    const pidFile = inst.supervisorPidFileFor({ LOCALAPPDATA: first.dir });
    await until('the first supervisor to note itself and start its runner', () => readHolder(pidFile)?.pid === first.sv.pid && startedIn(first.dir).length === 1);
    mine.note(first.dir);
    const before = fs.readFileSync(pidFile, 'utf8');

    // The task started again, for the same user: the same folder for the note and the log.
    const second = startSupervisor(startsBody(), first.dir);
    mine.add(second.sv);
    assert.equal(await exits(second.sv), true, 'the second supervisor stopped by itself');
    assert.equal(second.sv.exitCode, 0, 'with the exit code that Task Scheduler does not start it again for');
    assert.equal(fs.readFileSync(pidFile, 'utf8'), before, 'the first is still the one noted');
    assert.deepEqual(startedIn(second.dir), [], 'it started no runner');
    assert.match(fs.readFileSync(first.logFile, 'utf8'), new RegExp(`another supervisor \\(pid ${first.sv.pid}\\) is already running`));
    assert.equal(first.sv.exitCode, null, 'and the first is still running');

    const f = fake('unused', [TASK]);
    f.d.supervisorPidFile = pidFile;
    mayEnd(f);
    assert.equal(inst.runInstaller(['--stop'], f.d), 0, f.lines.join('\n'));
    assert.equal(f.lines[1], `Ended the supervisor (pid ${first.sv.pid}), which the task had not stopped.`);
    assert.equal(await exits(first.sv), true);
  } finally {
    mine.note(first.dir);
    mine.end();
  }
});

test('two supervisors started together: one is noted and stays, the other stops without starting a runner', WINDOWS_ONLY, async () => {
  for (let round = 1; round <= 3; round++) {
    const mine = tidy();
    const appData = tmpDir();
    const a = startSupervisor(startsBody(), appData);
    const b = startSupervisor(startsBody(), appData);
    mine.add(a.sv);
    mine.add(b.sv);
    try {
      const pidFile = inst.supervisorPidFileFor({ LOCALAPPDATA: appData });
      await until(`one of the two to stop (round ${round})`, () => a.sv.exitCode !== null || b.sv.exitCode !== null);
      const [stayed, stopped] = a.sv.exitCode === null ? [a, b] : [b, a];
      assert.equal(stopped.sv.exitCode, 0, `round ${round}`);
      assert.equal(readHolder(pidFile)?.pid, stayed.sv.pid, `the note names the one that stayed (round ${round})`);
      await until('the one that stayed to start its runner', () => startedIn(stayed.dir).length === 1);
      mine.note(stayed.dir);
      assert.deepEqual(startedIn(stopped.dir), [], `the other started none (round ${round})`);
      // Neither is cut short later: the note is still the survivor's, and it is still running.
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(stayed.sv.exitCode, null, `round ${round}`);
      assert.equal(readHolder(pidFile)?.pid, stayed.sv.pid, `round ${round}`);
    } finally {
      mine.end();
    }
  }
});

test('a supervisor takes over a note that names nothing running: a pid that has gone, one something else has now, or a note that does not read', WINDOWS_ONLY, async () => {
  const other = startStandIn(path.join(tmpDir(), 'Other'));
  const gone = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }).pid;
  try {
    const otherStart = BigInt(processInfo(other.pid)!.lstart);
    const notes: Record<string, string> = {
      'a pid that has gone': JSON.stringify({ pid: gone, lstart: String(otherStart) }),
      'a pid something else has now, with the start time of an earlier process': JSON.stringify({ pid: other.pid, lstart: String(otherStart - 36_000_000_000n) }),
      'a note with no start time': JSON.stringify({ pid: other.pid }),
      'a note that is not JSON': 'half a line',
      'an empty note': '',
    };
    for (const [what, text] of Object.entries(notes)) {
      const mine = tidy();
      const appData = tmpDir();
      const pidFile = inst.supervisorPidFileFor({ LOCALAPPDATA: appData });
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      fs.writeFileSync(pidFile, text);
      const s = startSupervisor(startsBody(), appData);
      mine.add(s.sv);
      try {
        await until(`the supervisor to note itself over ${what}`, () => readHolder(pidFile)?.pid === s.sv.pid);
        await until('its runner to start', () => startedIn(s.dir).length === 1);
        mine.note(s.dir);
        assert.equal(s.sv.exitCode, null, `it stayed over ${what}`);
        assert.equal(pidExists(other.pid), true, 'the control is untouched');
      } finally {
        mine.end();
      }
    }
  } finally {
    await ended(other);
  }
});

test('a supervisor that stops because the runner finds the folder in use removes its own note and not one another supervisor has put there', WINDOWS_ONLY, async () => {
  // The stand-in runner puts another supervisor's note over this one's, as one that started in
  // the meantime would have, then says another runner is in charge.
  const body = `
import fs from 'node:fs';
import path from 'node:path';
const note = path.join(process.env.LOCALAPPDATA, 'Threadbear', 'Logs', 'runner-supervisor.pid');
fs.writeFileSync(note, JSON.stringify({ pid: 4242, lstart: '1' }) + '\\n');
process.stderr.write('Another runner (pid 4242) is already using C:\\\\data; not starting.\\n');
process.exit(1);
`;
  const { sv, dir } = startSupervisor(body);
  try {
    const file = inst.supervisorPidFileFor({ LOCALAPPDATA: dir });
    assert.equal(await exits(sv), true, 'the supervisor ended itself');
    assert.equal(sv.exitCode, 0);
    assert.equal(readHolder(file)?.pid, 4242, 'the other note is still there');
  } finally {
    sv.kill();
  }
});

// The same, without a supervisor to run it, so it holds on any machine.
const noteText = (pid: number, lstart = '~134000000000000000'): string => JSON.stringify({ pid, lstart }) + '\n';

test('claimNote makes the note when there is none, keeps the note of a running supervisor as it was, and takes one that names nothing running', async () => {
  const file = path.join(tmpDir(), 'runner-supervisor.pid');
  const mine = noteText(100);
  assert.deepEqual(await sup.claimNote(file, mine, { alive: () => assert.fail('nobody to ask about') }), { state: 'noted' });
  assert.equal(fs.readFileSync(file, 'utf8'), mine);

  // The same one again is not another supervisor.
  assert.deepEqual(await sup.claimNote(file, mine, { alive: () => assert.fail('it is this one') }), { state: 'noted' });

  // Another that is running: its note stays, byte for byte.
  const theirs = noteText(200, '~134000000000000001');
  fs.writeFileSync(file, theirs);
  const asked: number[] = [];
  const running = async (n: { pid: number }) => (asked.push(n.pid), true);
  assert.deepEqual(await sup.claimNote(file, mine, { alive: running }), { state: 'other', pid: 200 });
  assert.equal(fs.readFileSync(file, 'utf8'), theirs);
  assert.deepEqual(asked, [200]);

  // One that names nothing running is the leftover of a supervisor that was ended hard.
  assert.deepEqual(await sup.claimNote(file, mine, { alive: async () => false }), { state: 'noted' });
  assert.equal(fs.readFileSync(file, 'utf8'), mine);
});

test('claimNote takes a note that does not read as its own, and a note with no folder to be made in is not an error', async () => {
  for (const text of ['', 'half a line', '{"pid":', '{"pid":"7","lstart":"~1"}', '{"pid":7}', '[]', 'null']) {
    const file = path.join(tmpDir(), 'runner-supervisor.pid');
    fs.writeFileSync(file, text);
    const mine = noteText(100);
    assert.deepEqual(await sup.claimNote(file, mine, { alive: () => assert.fail('it names nobody'), settleMs: 0 }), { state: 'noted' }, JSON.stringify(text));
    assert.equal(fs.readFileSync(file, 'utf8'), mine);
  }
  assert.deepEqual(await sup.claimNote(path.join(tmpDir(), 'no', 'such', 'folder', 'x.pid'), noteText(100)), { state: 'unwritable' });
});

test('claimNote waits for a note that another supervisor is still writing, rather than taking it for a broken one', async () => {
  const file = path.join(tmpDir(), 'runner-supervisor.pid');
  fs.writeFileSync(file, ''); // made, and not written yet
  const theirs = noteText(200, '~134000000000000001');
  // Written by a program of its own, shortly after: this one waits in place, so it cannot do it.
  const writer = spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(theirs)}), 150)`], { stdio: 'ignore', windowsHide: true });
  try {
    assert.deepEqual(await sup.claimNote(file, noteText(100), { alive: async () => true }), { state: 'other', pid: 200 });
    assert.equal(fs.readFileSync(file, 'utf8'), theirs);
  } finally {
    await exits(writer);
  }
});

test('claimNote does not remove a note another supervisor has made while it was finding out whether the old one was running', async () => {
  const file = path.join(tmpDir(), 'runner-supervisor.pid');
  fs.writeFileSync(file, noteText(300, '~134000000000000003')); // left by a supervisor that is gone
  const newer = noteText(200, '~134000000000000001');
  const asked: number[] = [];
  const alive = async (n: { pid: number }) => {
    asked.push(n.pid);
    if (n.pid === 300) {
      // The slow part is over and the answer is "not running", but another supervisor has
      // taken the old note away and made its own in the meantime.
      fs.writeFileSync(file, newer);
      return false;
    }
    return true;
  };
  assert.deepEqual(await sup.claimNote(file, noteText(100), { alive }), { state: 'other', pid: 200 });
  assert.equal(fs.readFileSync(file, 'utf8'), newer, 'the newer note is still there');
  assert.deepEqual(asked, [300, 200]);
});

test('livingSupervisor says a note is of a running supervisor only when its pid is there and started when the note says', async () => {
  const note = { pid: 4000, lstart: '~134000000000000000' };
  const tools = (o: { exists?: boolean; image?: { lstart: string; path: string; slack: bigint } | null } = {}) => async () => ({
    pidExists: () => o.exists ?? true,
    processImage: () => (o.image === undefined ? { lstart: '134000000000000000', path: 'node.exe', slack: 0n } : o.image),
    sameStartTime: (recorded: string, read: string, slack = 0n) => sameStartTime(recorded, read, slack),
  });
  assert.equal(await sup.livingSupervisor(note, tools()), true);
  assert.equal(await sup.livingSupervisor(note, tools({ exists: false })), false, 'no such process');
  assert.equal(await sup.livingSupervisor(note, tools({ image: { lstart: '133999000000000000', path: 'node.exe', slack: 0n } })), false, 'a process that has the pid now');
  assert.equal(await sup.livingSupervisor(note, tools({ image: null })), false, 'cannot be told: the runner comes first');
  assert.equal(await sup.livingSupervisor({ pid: process.pid, lstart: note.lstart }, tools()), false, 'this process is not another supervisor');
  assert.equal(
    await sup.livingSupervisor(note, async () => {
      throw new Error('Cannot find module');
    }),
    false,
    'the runner\'s files do not load',
  );
});

test('livingSupervisor, with the runner\'s own functions, tells a running process from the same pid at another start time', WINDOWS_ONLY, async () => {
  const other = startStandIn(path.join(tmpDir(), 'Other'));
  try {
    const started = processInfo(other.pid)!.lstart;
    assert.equal(await sup.livingSupervisor({ pid: other.pid, lstart: started }), true);
    assert.equal(await sup.livingSupervisor({ pid: other.pid, lstart: `~${started}` }), true, 'an estimate close to it, as a supervisor works its own out');
    assert.equal(await sup.livingSupervisor({ pid: other.pid, lstart: String(BigInt(started) - 36_000_000_000n) }), false);
    assert.equal(await sup.livingSupervisor({ pid: spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }).pid!, lstart: started }), false, 'a pid that has gone');
  } finally {
    await ended(other);
  }
});

test('--stop --dry-run and the other flags do not look at the runner, let alone end it', WINDOWS_ONLY, async () => {
  const runner = startStandIn(path.join(tmpDir(), 'Programs', 'Threadbear'));
  try {
    for (const argv of [['--stop', '--dry-run'], ['--uninstall', '--dry-run'], ['--status'], ['--mode'], ['--start']]) {
      const f = fake('unused', [TASK]);
      f.d.node = runner.exe;
      mayEnd(f); // would end it if asked to
      recordRunner(f, runner);
      f.set({ state: 'Running' });
      assert.equal(inst.runInstaller(argv, f.d), 0, argv.join(' '));
      assert.ok(!f.events.some((e) => e.startsWith('end ')), argv.join(' '));
    }
    assert.equal(pidExists(runner.pid), true);
  } finally {
    await ended(runner);
  }
});

test('loadRunnerTools hands the script the runner\'s own process functions and finds the data folder the runner uses', async () => {
  const tools = await inst.loadRunnerTools();
  assert.equal(tools.pidExists, pidExists);
  assert.equal(tools.processImage, processImage);
  assert.equal(tools.sameStartTime, sameStartTime);
  assert.equal(tools.readHolder, readHolder);
  assert.equal(tools.endTree, killTreeWindows);
  assert.equal(tools.dataHomeFor, dataHomeFor);
});

// How the script is really used: a node that has loaded none of the runner's files, as the one the
// installers run is. The test above runs inside a process that has proc.ts and the rest already.
test('loadRunnerTools, in a fresh node that has loaded nothing of the runner, finds all the tools and puts out no notice on stderr', () => {
  const url = pathToFileURL(path.join(SCRIPTS, 'install-windows.mjs')).href;
  const code = `const m = await import(${JSON.stringify(url)});\nconst tools = await m.loadRunnerTools();\nconsole.log(Object.keys(tools).sort().join(','));\n`;
  // Only the functions are loaded: nothing here reads Task Scheduler or the real install.
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, THREADBEAR_INSTALL_NO_RUN: '1' }, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'dataHomeFor,endTree,pidExists,processImage,readHolder,sameStartTime');
  // The desktop app takes stderr for part of the answer, and Node 24 says it is stripping types.
  assert.equal(r.stderr, '');
});

test('quietly holds back a warning raised while it works, however late, and puts the listeners back, also when the work fails', async () => {
  const before = process.listeners('warning');
  const seen: string[] = [];
  const spy = (w: Error) => seen.push(w.message);
  process.on('warning', spy);
  try {
    // Files that take a while to load: the notice comes long after the first turn of the event loop,
    // which is when the listeners used to be put back.
    await inst.quietly(async () => {
      await new Promise((r) => setTimeout(r, 40));
      process.emitWarning('a late notice', 'ExperimentalWarning');
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, [], 'it went to nobody');
    assert.deepEqual(process.listeners('warning'), [...before, spy], 'and the listeners are back, in order');
    await assert.rejects(
      inst.quietly(async () => {
        throw new Error('no such file');
      }),
      /no such file/,
    );
    assert.deepEqual(process.listeners('warning'), [...before, spy], 'the same after a failure');
    assert.equal(await inst.quietly(async () => 42), 42, 'and it gives what the work gave');
  } finally {
    process.off('warning', spy);
  }
});

test('the program loads the runner tools for --stop and --uninstall only, hands the dependencies what went wrong, and gives the exit code of what ran', async () => {
  const calls: string[] = [];
  const io = {
    load: async () => {
      calls.push('load');
      return { marker: 'tools' };
    },
    deps: (tools?: unknown, error?: string) => ({ tools, error }),
    run: (argv: string[], d: { tools?: unknown; error?: string }) => {
      calls.push(`run ${argv.join(' ')} tools=${JSON.stringify(d.tools)} error=${d.error}`);
      return d.error ? 1 : 3;
    },
    err: (s: string) => calls.push(`err ${s}`),
  };
  assert.equal(await inst.cli(['--stop'], io), 3, 'what the run gave');
  assert.deepEqual(calls, ['load', 'run --stop tools={"marker":"tools"} error=undefined']);

  calls.length = 0;
  const failing = {
    ...io,
    load: async () => {
      calls.push('load');
      throw new Error('Cannot find module\nat somewhere');
    },
  };
  assert.equal(await inst.cli(['--uninstall'], failing), 1);
  assert.deepEqual(calls, ['load', 'run --uninstall tools=undefined error=Cannot find module at somewhere']);

  // Everything else, and any dry run, never loads TypeScript: the desktop app reads their output.
  for (const argv of [['--stop', '--dry-run'], ['--uninstall', '--dry-run'], ['--status'], ['--mode'], ['--start'], ['--installed'], ['--on-demand'], []]) {
    calls.length = 0;
    await inst.cli(argv, io);
    assert.ok(!calls.includes('load'), argv.join(' '));
  }

  calls.length = 0;
  const throwing = {
    ...io,
    run: () => {
      throw new Error('line one\nline two');
    },
  };
  assert.equal(await inst.cli(['--start'], throwing), 1);
  assert.deepEqual(calls, ['err line one line two']);
});

test('the script\'s own dependencies carry the tools, this Node, and the data folder THREADBEAR_HOME or the default names; and without the tools --stop still ends the task, says it could not check, and exits 1', WINDOWS_ONLY, async () => {
  const tools = await inst.loadRunnerTools();
  const was = process.env.THREADBEAR_HOME;
  try {
    delete process.env.THREADBEAR_HOME;
    const plain = inst.realDeps(tools);
    assert.equal(plain.home, path.resolve(dataDirFor()));
    assert.equal(plain.node, process.execPath);
    assert.equal(plain.procs, tools);
    const elsewhere = tmpDir();
    process.env.THREADBEAR_HOME = elsewhere;
    assert.equal(inst.realDeps(tools).home, elsewhere);
    // The switches that never look at a process get none of this.
    assert.equal(inst.realDeps().home, undefined);
    assert.equal(inst.realDeps().procs, undefined);
  } finally {
    if (was === undefined) delete process.env.THREADBEAR_HOME;
    else process.env.THREADBEAR_HOME = was;
  }

  const f = fake('unused', [TASK]);
  f.d.procs = undefined;
  f.d.procsError = 'Cannot find module';
  assert.equal(inst.runInstaller(['--stop'], f.d), 1);
  assert.deepEqual(f.events.slice(0, 1), [`/End ${TASK}`], 'the task is still ended');
  assert.equal(f.lines[1], 'Could not check whether the runner is still running (Cannot find module).');
});

// --stop looks for a runner the task left in the data folder the runner itself works out, with the
// same variables in the same order (config.ts loadConfig). Looking anywhere else finds no runner.pid,
// and --stop says the runner is not running while it is.
test('--stop looks in the data folder the runner uses: the same variables in the same order, the names from before the rename, and ~ expanded', async () => {
  const tools = await inst.loadRunnerTools();
  const root = tmpDir();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  const keys = ['THREADBEAR_HOME', 'THREADBEAR_DATA_DIR', 'THREADBARE_HOME', 'THREADBARE_DATA_DIR', 'HOME', 'USERPROFILE', 'APPDATA'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  type Case = { what: string; env: Record<string, string>; want?: string };
  const cases: Case[] = [
    { what: 'nothing set: the default folder', env: {}, want: IS_WINDOWS ? path.join(root, 'AppData', 'Roaming', 'Threadbear') : path.join(root, 'Library', 'Application Support', 'Threadbear') },
    { what: 'THREADBEAR_HOME', env: { THREADBEAR_HOME: A }, want: A },
    { what: 'THREADBEAR_DATA_DIR', env: { THREADBEAR_DATA_DIR: B }, want: B },
    { what: 'both of those: THREADBEAR_HOME wins', env: { THREADBEAR_HOME: A, THREADBEAR_DATA_DIR: B }, want: A },
    { what: 'THREADBARE_HOME, the name before the rename', env: { THREADBARE_HOME: A }, want: A },
    { what: 'THREADBARE_DATA_DIR', env: { THREADBARE_DATA_DIR: B }, want: B },
    { what: 'THREADBARE_HOME stands in for THREADBEAR_HOME, so it comes before THREADBEAR_DATA_DIR', env: { THREADBARE_HOME: A, THREADBEAR_DATA_DIR: B }, want: A },
    { what: 'THREADBEAR_HOME over THREADBARE_HOME', env: { THREADBARE_HOME: A, THREADBEAR_HOME: B }, want: B },
    { what: 'an empty THREADBEAR_HOME falls through to THREADBEAR_DATA_DIR', env: { THREADBEAR_HOME: '', THREADBEAR_DATA_DIR: B }, want: B },
    { what: '~/ in the name', env: { THREADBEAR_HOME: '~/tb-home' }, want: path.join(root, 'tb-home') },
    { what: '~ alone', env: { THREADBEAR_DATA_DIR: '~' }, want: root },
    { what: '~ in a name from before the rename', env: { THREADBARE_HOME: '~/old-home' }, want: path.join(root, 'old-home') },
    ...(IS_WINDOWS ? [{ what: '~\\ in the name', env: { THREADBEAR_HOME: '~\\tb-home' }, want: path.join(root, 'tb-home') }] : []),
    { what: 'a relative name', env: { THREADBEAR_HOME: path.join('rel', 'home') }, want: path.resolve('rel', 'home') },
  ];
  try {
    for (const c of cases) {
      // The profile is a throwaway one, so neither ~ nor the default folder is the real one.
      for (const k of keys) delete process.env[k];
      Object.assign(process.env, { HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'AppData', 'Roaming') }, c.env);
      const runner = loadConfig({ ...process.env, THREADBEAR_PORT: '0' }).home;
      if (c.want !== undefined) assert.equal(runner, c.want, `the runner's folder for ${c.what}`);
      assert.equal(inst.realDeps(tools).home, runner, c.what);
    }
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ----------------------------------------------- the runner stays with its supervisor

test('the supervisor gives the runner a pipe to watch on Windows, and the Linux service and a Mac get none', () => {
  assert.deepEqual(sup.runnerLink('win32'), { stdin: 'pipe', env: { THREADBEAR_RUNNER_WATCH_STDIN: '1' } });
  for (const platform of ['linux', 'darwin']) assert.deepEqual(sup.runnerLink(platform), { stdin: 'ignore', env: {} }, platform);
});

// A stand-in for main.ts: it writes its pid and what it was given, then does what main.ts does
// about its supervisor, with the runner's own function (release.ts takeSupervisorPipe).
function runnerBody(): string {
  const release = pathToFileURL(path.join(RUNNER_DIR, 'src', 'release.ts')).href;
  return `
import fs from 'node:fs';
import path from 'node:path';
import { takeSupervisorPipe } from ${JSON.stringify(release)};
const here = import.meta.dirname;
const watch = takeSupervisorPipe();
fs.writeFileSync(path.join(here, 'runner.txt'), JSON.stringify({ pid: process.pid, hadPipe: Boolean(watch), varLeft: process.env.THREADBEAR_RUNNER_WATCH_STDIN ?? null }));
watch?.(() => { fs.writeFileSync(path.join(here, 'stopped.txt'), 'stdin ended'); process.exit(0); });
setInterval(() => {}, 1000);
`;
}

// The runner stand-in below is started by the supervisor like the runner is, and the supervisor
// is ended with this test's own handle. Node puts a child that is not detached in a job object
// that ends it with its parent, so on Windows the stand-in goes with the supervisor whether it
// watches the pipe or not (tried: with the watch left out it goes just the same), and the
// pipe cannot be seen to do it here: the test checks what the supervisor gives and that
// nothing outlives it. That the runner stops when the pipe ends is release.test.ts's, with
// a parent that ends the pipe and nothing else.
test('the supervisor gives the runner a pipe and the variable, the runner takes the variable out of its environment, and nothing outlives the supervisor', WINDOWS_ONLY, async () => {
  const { sv, dir } = startSupervisor(runnerBody());
  const said = path.join(dir, 'runner.txt');
  let runnerPid: number | undefined;
  try {
    await until('the stand-in runner to start', () => fs.existsSync(said) && fs.readFileSync(said, 'utf8').endsWith('}'));
    const info = JSON.parse(fs.readFileSync(said, 'utf8')) as { pid: number; hadPipe: boolean; varLeft: string | null };
    runnerPid = info.pid;
    assert.equal(info.hadPipe, true, 'the supervisor gave it a pipe and the variable');
    assert.equal(info.varLeft, null, 'the variable is taken out of its environment, so nothing it starts inherits it');
    assert.equal(pidExists(runnerPid), true);
    // The supervisor holds its end of the pipe open for as long as it lives: a runner that was told
    // to stop at once, or by a pipe that came closed, would have left its note by now.
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(fs.existsSync(path.join(dir, 'stopped.txt')), false, 'the pipe was not closed early');
    assert.equal(pidExists(runnerPid), true, 'and the runner is still there');
    sv.kill(); // the supervisor this test started: a hard end, as an installer's is
    assert.equal(await exits(sv), true);
    await until('the runner to be gone', () => !pidExists(runnerPid!), 10_000);
  } finally {
    sv.kill();
    // Only the stand-in this supervisor started, by the pid it wrote itself.
    if (runnerPid !== undefined && pidExists(runnerPid)) process.kill(runnerPid);
  }
});
