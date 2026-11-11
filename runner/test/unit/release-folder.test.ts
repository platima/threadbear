// installer/release-folder.ps1: the helper the setup exe runs before it replaces
// the install folder (threadbear.iss, PrepareToInstall). It finds out whether
// node\node.exe and Threadbear.exe can be written to, lists what is running from
// the folder, and ends what is left, by process number and only after checks.
//
// Nothing here touches a real install, the registry, Task Scheduler or any
// program that is not started by the test. The programs are stand-ins: copies of
// this Node, put at <tmp>\Threadbear\node\node.exe (the "install"), at
// <tmp>\Other\node\node.exe and at <tmp>\Threadbear2\node\node.exe (controls
// that must never be reported or ended), each started here with its handle kept
// and ended through that handle in a finally. The helper is run with Windows
// PowerShell 5.1, as the setup runs it. The setup exe itself is not run: it
// shares its AppId, its registry keys and its Task Scheduler task with a real
// install, so its end-to-end run is a job in installers.yml, on a runner that is
// thrown away.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { onlyOnWindows } from '../helpers/platform.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const HELPER = path.join(REPO, 'installer', 'release-folder.ps1');
const ISS = path.join(REPO, 'installer', 'threadbear.iss');
const WINDOWS_ONLY = onlyOnWindows('The helper reads the Windows process table and the setup exe it belongs to is Windows only');

const helperText = fs.readFileSync(HELPER, 'utf8');
const issText = fs.readFileSync(ISS, 'utf8');

function section(text: string, name: string): string {
  // The header as a line of its own: the comments at the top mention [InstallDelete] and [Files] too.
  const header = new RegExp(`^\\[${name}\\]`, 'm').exec(text);
  assert.ok(header, `[${name}] is in threadbear.iss`);
  const next = text.indexOf('\n[', header.index + 1);
  return text.slice(header.index, next < 0 ? undefined : next);
}

// ---------------------------------------------------------------- the script's wiring

test('the helper is plain ASCII, as Windows PowerShell reads a script with no byte order mark in the system code page', () => {
  const bytes = fs.readFileSync(HELPER);
  const bad = [...bytes].findIndex((b) => b > 0x7f);
  assert.equal(bad, -1, `byte ${bad} of release-folder.ps1 is not ASCII`);
});

test('the setup carries the helper, extracted from the top of [Files] so solid compression does not unpack the whole tree first', () => {
  const files = section(issText, 'Files');
  const define = /^#define HelperName "([^"]+)"/m.exec(issText);
  assert.equal(define?.[1], 'release-folder.ps1', 'the iss names the helper once');
  assert.ok(fs.existsSync(path.join(REPO, 'installer', define![1]!)));
  const helper = files.indexOf('Source: "{#HelperName}"');
  const tree = files.indexOf('Source: "{#Stage}\\*"');
  assert.ok(helper >= 0, 'the helper is in [Files]');
  assert.ok(files.slice(helper).split('\n')[0]!.includes('Flags: dontcopy noencryption'), 'it is for ExtractTemporaryFile only');
  assert.ok(tree > helper, 'and it comes before the tree, because Setup decompresses everything ahead of a file it extracts');
  assert.ok(issText.includes("ExtractTemporaryFile('{#HelperName}')"), 'it is unpacked by that name');
});

test('the parts of the install the helper may end programs from are the folders [InstallDelete] clears, and the shell', () => {
  const cleared = [...section(issText, 'InstallDelete').matchAll(/^Type: filesandordirs; Name: "\{app\}\\([^"\\]+)"/gm)].map((m) => m[1]!.toLowerCase()).sort();
  const managed = /\$script:ManagedFolders = @\(([^)]*)\)/.exec(helperText);
  assert.ok(managed, 'the helper lists its folders');
  const listed = [...managed[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!.toLowerCase()).sort();
  assert.deepEqual(listed, cleared, 'a folder setup clears but the helper does not know about, or the other way round');
  assert.match(helperText, /\$script:ManagedFiles = @\('Threadbear\.exe'\)/);
});

test('the setup keeps its own fallback: it never fails because the helper could not run, and it only ends a program after asking or when silent', () => {
  const code = section(issText, 'Code');
  assert.ok(/Setup carries on without the helper/.test(code), 'the fallback is written down where it happens');
  assert.ok(/WizardSilent/.test(code), 'a silent install does not wait for an answer nobody gives');
  assert.ok(/SuppressibleMsgBox\([^;]*IDYES\)/s.test(code), 'and /SUPPRESSMSGBOXES answers yes');
  assert.ok(!/taskkill|Stop-Process|\/IM\b/i.test(code), 'the setup itself ends nothing: the helper does, by process number');
});

// ---------------------------------------------------------------- running the helper

const POWERSHELL = 'powershell.exe';
const root = WINDOWS_ONLY.skip ? '' : tmpDir('tb-folder-');
const install = path.join(root, 'Threadbear');
const other = path.join(root, 'Other');
const lookalike = path.join(root, 'Threadbear2');
const exeIn = (folder: string): string => path.join(folder, 'node', 'node.exe');

before(() => {
  if (WINDOWS_ONLY.skip) return;
  for (const folder of [install, other, lookalike]) {
    fs.mkdirSync(path.dirname(exeIn(folder)), { recursive: true });
    fs.copyFileSync(process.execPath, exeIn(folder));
  }
});

const live = new Set<ChildProcess>();
after(async () => {
  for (const child of live) child.kill();
  await Promise.all([...live].map((c) => exited(c)));
});

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function exited(child: ChildProcess, ms = 15_000): Promise<boolean> {
  if (!isAlive(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// A program that does nothing, run from the copy of Node in `folder`.
async function standIn(folder: string, script = 'setInterval(() => {}, 1000)'): Promise<ChildProcess> {
  const child = spawn(exeIn(folder), ['-e', script], { stdio: 'ignore', windowsHide: true });
  live.add(child);
  child.once('exit', () => live.delete(child));
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  return child;
}

async function endStandIn(child: ChildProcess): Promise<void> {
  if (isAlive(child)) child.kill();
  await exited(child);
}

type Run = { code: number | null; lines: string[]; stderr: string };
let reports = 0;
const argsFor = (action: string, folder: string, out: string, extra: string[]): string[] => [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  HELPER,
  '-Action',
  action,
  '-Folder',
  folder,
  '-OutFile',
  out,
  ...extra,
];
function readReport(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean) : [];
}
function helper(action: string, folder: string, extra: string[] = []): Run {
  const out = path.join(root, `report-${reports++}.txt`);
  const r = spawnSync(POWERSHELL, argsFor(action, folder, out, extra), { encoding: 'utf8', windowsHide: true, timeout: 50_000 });
  return { code: r.status, lines: readReport(out), stderr: r.stderr };
}
function helperAsync(action: string, folder: string, extra: string[] = []): Promise<Run> {
  const out = path.join(root, `report-${reports++}.txt`);
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, argsFor(action, folder, out, extra), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr += d));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, lines: readReport(out), stderr }));
  });
}

type Proc = { pid: number; parent: number; start: string; name: string; verdict: string; file: string; command: string };
function procs(lines: string[]): Proc[] {
  return lines
    .filter((l) => l.startsWith('PROC|'))
    .map((l) => {
      const f = l.split('|');
      return { pid: Number(f[1]), parent: Number(f[2]), start: f[3]!, name: f[4]!, verdict: f[5]!, file: f[6]!, command: f.slice(7).join('|') };
    });
}
const state = (lines: string[]): string | undefined => lines.find((l) => l.startsWith('STATE|'))?.split('|')[1];
const files = (lines: string[]): string[] => lines.filter((l) => l.startsWith('FILE|'));
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// Evaluates PowerShell with the helper's functions defined (the script dot-sourced with no action) and
// gives back what it wrote to the pipeline as JSON.
function powershell<T>(body: string): T {
  const script = path.join(root, `probe-${reports++}.ps1`);
  fs.writeFileSync(script, `$ErrorActionPreference = 'Stop'\n. '${HELPER}'\n${body}\n`);
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 50_000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout) as T;
}

// ---------------------------------------------------------------- rules on plain strings

test('a path is inside the folder only past a trailing backslash, ignoring case: Threadbear2 and nodes are not', WINDOWS_ONLY, () => {
  const got = powershell<boolean[]>(`
$p = Get-FolderPrefix 'C:\\Apps\\Threadbear'
$same = (Get-FolderPrefix 'C:\\Apps\\Threadbear\\') -eq $p -and (Get-FolderPrefix 'C:/Apps/Threadbear/') -eq $p
ConvertTo-Json -InputObject @(
  (Test-UnderFolder 'C:\\Apps\\Threadbear\\node\\node.exe' $p),
  (Test-UnderFolder 'c:\\apps\\THREADBEAR\\Node\\node.exe' $p),
  (Test-UnderFolder 'C:\\Apps\\Threadbear2\\node\\node.exe' $p),
  (Test-UnderFolder 'C:\\Apps\\Threadbearnodes.exe' $p),
  (Test-UnderFolder 'C:\\Apps\\Threadbear' $p),
  (Test-UnderFolder 'C:\\Apps\\Other\\node\\node.exe' $p),
  (Test-UnderFolder '' $p),
  (Test-UnderFolder $null $p),
  $same
)`);
  assert.deepEqual(got, [true, true, false, false, false, false, false, false, true]);
});

test('only what setup replaces counts: Threadbear.exe and the node, runner, desktop and docs folders', WINDOWS_ONLY, () => {
  const got = powershell<boolean[]>(`
$p = Get-FolderPrefix 'C:\\Apps\\Threadbear'
ConvertTo-Json -InputObject @(
  (Test-ManagedPath 'C:\\Apps\\Threadbear\\node\\node.exe' $p),
  (Test-ManagedPath 'C:\\Apps\\Threadbear\\Threadbear.exe' $p),
  (Test-ManagedPath 'C:\\Apps\\Threadbear\\desktop\\node_modules\\@lydell\\node-pty\\OpenConsole.exe' $p),
  (Test-ManagedPath 'C:\\Apps\\Threadbear\\RUNNER\\bin\\x.exe' $p),
  (Test-ManagedPath 'C:\\Apps\\Threadbear\\unins000.exe' $p),
  (Test-ManagedPath 'C:\\Apps\\Threadbear\\nodes\\x.exe' $p),
  (Test-ManagedPath 'C:\\Apps\\Threadbear\\node' $p),
  (Test-ManagedPath 'C:\\Apps\\Threadbear\\Threadbear.exe.bak' $p),
  (Test-ManagedPath 'C:\\Apps\\Threadbear2\\node\\node.exe' $p)
)`);
  assert.deepEqual(got, [true, true, true, true, false, false, false, false, false]);
});

test('a drive root or share root is recognised, so nothing under it is ever "inside the folder"', WINDOWS_ONLY, () => {
  const got = powershell<boolean[]>(`ConvertTo-Json -InputObject @((Test-RootFolder 'D:\\'), (Test-RootFolder 'd:\\'), (Test-RootFolder '\\\\server\\share'), (Test-RootFolder 'D:\\Apps'), (Test-RootFolder 'C:\\Program Files'))`);
  assert.deepEqual(got, [true, true, true, false, false]);
});

test('the owner check compares SIDs, ignoring case, and does not take an unknown owner for a match', WINDOWS_ONLY, () => {
  const got = powershell<boolean[]>(`
ConvertTo-Json -InputObject @(
  (Test-SameOwner 'S-1-5-21-1-2-3-1000' 'S-1-5-21-1-2-3-1000'),
  (Test-SameOwner 's-1-5-21-1-2-3-1000' 'S-1-5-21-1-2-3-1000'),
  (Test-SameOwner 'S-1-5-21-1-2-3-1001' 'S-1-5-21-1-2-3-1000'),
  (Test-SameOwner 'S-1-5-21-1-2-3-10' 'S-1-5-21-1-2-3-1000'),
  (Test-SameOwner '' 'S-1-5-21-1-2-3-1000'),
  (Test-SameOwner $null 'S-1-5-21-1-2-3-1000'),
  (Test-SameOwner 'S-1-5-21-1-2-3-1000' ''),
  (Test-SameOwner '' '')
)`);
  assert.deepEqual(got, [true, true, false, false, false, false, false, false]);
});

test('setup\'s own tree is the helper and every program it was started from, and a loop in the table ends', WINDOWS_ONLY, () => {
  const got = powershell<{ own: number[]; loop: number[] }>(`
function Row($id, $parent) { [pscustomobject]@{ ProcessId = $id; ParentProcessId = $parent } }
$table = @((Row 4 0), (Row 50 4), (Row 60 50), (Row 70 60), (Row 80 4), (Row 10 11), (Row 11 10))
$own = Get-AncestorIds -Table $table -StartPid 70
$loop = Get-AncestorIds -Table $table -StartPid 10
ConvertTo-Json -InputObject @{ own = @($own.Keys | Sort-Object); loop = @($loop.Keys | Sort-Object) }`);
  assert.deepEqual(got.own, [4, 50, 60, 70], 'setup (both of its processes) and what started it, not the other child of that');
  assert.deepEqual(got.loop, [10, 11]);
});

test('a program is ended only when it passes every check, and an unreadable start time or owner means leave it', WINDOWS_ONLY, () => {
  const got = powershell<Record<string, string>>(`
$me = 'S-1-5-21-1-2-3-1000'
$ctx = @{ Prefix = 'C:\\Apps\\Threadbear\\'; RootFolder = $false; Me = $me; Own = @{ 100 = $true } }
function P($id, $path, $start, $owner) { [pscustomobject]@{ Pid = $id; Path = $path; Start = $start; Owner = $owner } }
$ok = 'C:\\Apps\\Threadbear\\node\\node.exe'
$rootCtx = @{ Prefix = 'D:\\'; RootFolder = $true; Me = $me; Own = @{} }
ConvertTo-Json -InputObject ([ordered]@{
  ok = (Get-Verdict (P 200 $ok '134000000000000000' $me) $ctx)
  mixedCase = (Get-Verdict (P 200 'c:\\APPS\\threadbear\\NODE\\node.exe' '1' $me) $ctx)
  setup = (Get-Verdict (P 100 $ok '1' $me) $ctx)
  outside = (Get-Verdict (P 200 'C:\\Apps\\Threadbear2\\node\\node.exe' '1' $me) $ctx)
  noPath = (Get-Verdict (P 200 '' '1' $me) $ctx)
  notPart = (Get-Verdict (P 200 'C:\\Apps\\Threadbear\\unins000.exe' '1' $me) $ctx)
  noStart = (Get-Verdict (P 200 $ok $null $me) $ctx)
  emptyStart = (Get-Verdict (P 200 $ok '' $me) $ctx)
  otherUser = (Get-Verdict (P 200 $ok '1' 'S-1-5-21-1-2-3-1001') $ctx)
  noOwner = (Get-Verdict (P 200 $ok '1' $null) $ctx)
  root = (Get-Verdict (P 200 'D:\\node\\node.exe' '1' $me) $rootCtx)
})`);
  assert.deepEqual(got, {
    ok: 'end',
    mixedCase: 'end',
    setup: 'keep:setup-itself',
    outside: 'keep:outside-folder',
    noPath: 'keep:outside-folder',
    notPart: 'keep:not-part-of-install',
    noStart: 'keep:start-time-unreadable',
    emptyStart: 'keep:start-time-unreadable',
    otherUser: 'keep:other-owner',
    noOwner: 'keep:other-owner',
    root: 'keep:root-folder',
  });
});

// ---------------------------------------------------------------- with stand-ins

test('a held node.exe is reported with its process number and start time; the controls beside it are not', WINDOWS_ONLY, async () => {
  const held = await standIn(install);
  const controlA = await standIn(other);
  const controlB = await standIn(lookalike);
  try {
    const r = helper('List', install);
    assert.equal(r.code, 11, r.stderr);
    assert.equal(state(r.lines), 'held');
    const fileLines = files(r.lines);
    assert.ok(fileLines.some((l) => l.startsWith('FILE|held|') && same(l.slice('FILE|held|'.length), exeIn(install))), `node.exe is held: ${fileLines.join(' ; ')}`);
    assert.ok(fileLines.some((l) => l.startsWith('FILE|absent|') && l.endsWith('Threadbear.exe')), 'a file that is not there is not a lock');

    const listed = procs(r.lines);
    assert.deepEqual(listed.map((p) => p.pid), [held.pid], 'the one under the folder, and neither control');
    const p = listed[0]!;
    assert.ok(same(p.file, exeIn(install)));
    assert.equal(p.verdict, 'end');
    assert.match(p.name, /^node\.exe$/i);
    assert.match(p.command, /setInterval/, 'the command line is what it was started with');
    assert.equal(p.parent, process.pid, 'and its parent is this test');

    // The start time is the one Windows keeps for the process, to the millisecond.
    const got = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${held.pid}).StartTime.ToFileTimeUtc()`], { encoding: 'utf8', windowsHide: true });
    const delta = BigInt(p.start) - BigInt(got.stdout.trim());
    assert.ok((delta < 0n ? -delta : delta) < 10_000n, `start ${p.start} against ${got.stdout.trim()}`);

    // Each control is held in its own folder, and reported there only.
    const a = helper('List', other);
    assert.deepEqual(procs(a.lines).map((x) => x.pid), [controlA.pid]);
    const b = helper('List', lookalike);
    assert.deepEqual(procs(b.lines).map((x) => x.pid), [controlB.pid]);
  } finally {
    await Promise.all([endStandIn(held), endStandIn(controlA), endStandIn(controlB)]);
  }
});

test('a bar in a command line cannot split the fields of its line, which setup reads by position', WINDOWS_ONLY, async () => {
  const held = await standIn(install, 'setInterval(() => {}, 1000); // one|two|three');
  try {
    const r = helper('List', install);
    const line = r.lines.find((l) => l.startsWith('PROC|'));
    assert.ok(line, r.lines.join(' ; '));
    assert.equal(line.split('|').length, 8, 'PROC, then seven fields, whatever is in the command line');
    assert.match(line, /one two three/);
    assert.deepEqual(procs(r.lines).map((p) => p.pid), [held.pid]);
  } finally {
    await endStandIn(held);
  }
});

test('a running exe can be renamed, so a rename says free while the lock is real; opening it for writing says held', WINDOWS_ONLY, async () => {
  const held = await standIn(install);
  const renamed = path.join(path.dirname(exeIn(install)), 'node-renamed.exe');
  try {
    fs.renameSync(exeIn(install), renamed); // does not throw: this is the pitfall
    assert.ok(fs.existsSync(renamed) && !fs.existsSync(exeIn(install)));
    fs.renameSync(renamed, exeIn(install));
    assert.ok(isAlive(held), 'it kept running through both renames');
    const r = helper('Probe', install);
    assert.equal(r.code, 11, r.stderr);
    assert.equal(state(r.lines), 'held');
  } finally {
    await endStandIn(held);
    if (fs.existsSync(renamed)) fs.renameSync(renamed, exeIn(install));
  }
});

test('the probe says free once the holder is ended through its own handle', WINDOWS_ONLY, async () => {
  const held = await standIn(install);
  try {
    assert.equal(helper('Probe', install).code, 11);
  } finally {
    await endStandIn(held);
  }
  assert.ok(!isAlive(held));
  // Waits a few seconds for a scanner to let go of a file the program has just left.
  const r = helper('Wait', install, ['-Seconds', '10']);
  assert.equal(r.code, 10, `${r.lines.join(' ; ')} ${r.stderr}`);
  assert.equal(state(r.lines), 'free');
  assert.deepEqual(procs(r.lines), []);
});

test('Wait gives up when the time is up and says who holds the folder, and stops waiting the moment it is free', WINDOWS_ONLY, async () => {
  const held = await standIn(install);
  try {
    const started = Date.now();
    const r = helper('Wait', install, ['-Seconds', '2']);
    const took = Date.now() - started;
    assert.equal(r.code, 11, r.stderr);
    assert.ok(took >= 2_000, `waited the 2 seconds (took ${took} ms)`);
    assert.deepEqual(procs(r.lines).map((p) => p.pid), [held.pid]);

    // Ended a little way into a long wait: the report comes soon after, not 40 seconds on.
    const waiting = helperAsync('Wait', install, ['-Seconds', '40']);
    const asked = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await endStandIn(held);
    const freed = await waiting;
    assert.equal(freed.code, 10, `${freed.lines.join(' ; ')} ${freed.stderr}`);
    assert.ok(Date.now() - asked < 30_000, 'it did not run out the 40 seconds');
  } finally {
    await endStandIn(held);
  }
});

test('End ends the stand-in under the folder by its number, and the controls are left running', WINDOWS_ONLY, async () => {
  const held = await standIn(install);
  const controlA = await standIn(other);
  const controlB = await standIn(lookalike);
  try {
    const listed = procs(helper('List', install).lines);
    assert.equal(listed.length, 1);
    const target = listed[0]!;
    const r = helper('End', install, ['-Expect', `${target.pid}:${target.start}`]);
    assert.equal(r.code, 0, `${r.lines.join(' ; ')} ${r.stderr}`);
    assert.deepEqual(r.lines.filter((l) => /^(ENDED|SKIPPED|GONE|FAILED)\|/.test(l)), [`ENDED|${held.pid}`]);
    assert.ok(await exited(held), 'the holder is gone');
    assert.ok(isAlive(controlA) && isAlive(controlB), 'the controls are not');
    // Asked again for the same one, there is nothing to end.
    const again = helper('End', install, ['-Expect', `${target.pid}:${target.start}`]);
    assert.deepEqual(again.lines.filter((l) => /^(ENDED|SKIPPED|GONE|FAILED)\|/.test(l)), [`GONE|${held.pid}`]);
    // And what held node.exe no longer does.
    assert.equal(helper('Wait', install, ['-Seconds', '10']).code, 10);
  } finally {
    await Promise.all([endStandIn(held), endStandIn(controlA), endStandIn(controlB)]);
  }
});

test('End leaves a program whose start time is not the one that was listed: the number may have been reused', WINDOWS_ONLY, async () => {
  const held = await standIn(install);
  try {
    const target = procs(helper('List', install).lines)[0]!;
    const later = (BigInt(target.start) + 1n).toString();
    const r = helper('End', install, ['-Expect', `${target.pid}:${later},${target.pid}:`]);
    assert.deepEqual(r.lines.filter((l) => /^(ENDED|SKIPPED|GONE|FAILED)\|/.test(l)), [`SKIPPED|${held.pid}|keep:start-time-changed`]);
    assert.ok(isAlive(held));
  } finally {
    await endStandIn(held);
  }
});

test('End re-reads the file as well: a program outside the folder is left even when its number and start time are right', WINDOWS_ONLY, async () => {
  const controlA = await standIn(other);
  const controlB = await standIn(lookalike);
  try {
    const a = procs(helper('List', other).lines)[0]!;
    const b = procs(helper('List', lookalike).lines)[0]!;
    // Asked of the install folder, with the controls' real numbers and start times.
    const r = helper('End', install, ['-Expect', `${a.pid}:${a.start},${b.pid}:${b.start}`]);
    assert.deepEqual(
      r.lines.filter((l) => /^(ENDED|SKIPPED|GONE|FAILED)\|/.test(l)).sort(),
      [`SKIPPED|${controlA.pid}|keep:outside-folder`, `SKIPPED|${controlB.pid}|keep:outside-folder`].sort(),
    );
    assert.ok(isAlive(controlA) && isAlive(controlB));
  } finally {
    await Promise.all([endStandIn(controlA), endStandIn(controlB)]);
  }
});

test('a program that setup was started from is never ended, even one in the folder that was asked for by number', WINDOWS_ONLY, async () => {
  // The helper is run by a stand-in under the folder, as setup would be if it had been
  // downloaded into the install folder. That stand-in is its parent.
  const listOut = path.join(root, 'nested-list.txt');
  const endOut = path.join(root, 'nested-end.txt');
  const script = path.join(root, 'nested.cjs');
  fs.writeFileSync(
    script,
    `const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { helper, folder, listOut, endOut } = JSON.parse(process.argv[2]);
const ps = (action, out, extra) =>
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Action', action, '-Folder', folder, '-OutFile', out, ...extra], { windowsHide: true });
ps('List', listOut, []);
const mine = fs.readFileSync(listOut, 'utf8').split(/\\r?\\n/).find((l) => l.startsWith('PROC|' + process.pid + '|')) || '';
const f = mine.split('|');
ps('End', endOut, ['-Expect', f[1] + ':' + f[3]]);
console.log('finished');
`,
  );
  const child = spawn(exeIn(install), [script, JSON.stringify({ helper: HELPER, folder: install, listOut, endOut })], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  live.add(child);
  let out = '';
  let err = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (err += d));
  try {
    assert.ok(await exited(child, 50_000), 'the parent finished by itself');
    assert.equal(child.exitCode, 0, err);
    assert.match(out, /finished/);
    const mine = procs(readReport(listOut)).filter((p) => p.pid === child.pid);
    assert.equal(mine.length, 1, 'it is listed');
    assert.equal(mine[0]!.verdict, 'keep:setup-itself', 'but as not ours to end');
    assert.deepEqual(
      readReport(endOut).filter((l) => /^(ENDED|SKIPPED|GONE|FAILED)\|/.test(l)),
      [`SKIPPED|${child.pid}|keep:setup-itself`],
      'and asked for by number with the right start time, it is still left',
    );
  } finally {
    await endStandIn(child);
  }
});

test('the report says "could not tell" and exits 12 when the helper cannot do what it was asked, so setup falls back', WINDOWS_ONLY, () => {
  const nonsense = helper('Frobnicate', install);
  assert.equal(nonsense.code, 12);
  assert.equal(state(nonsense.lines), 'unknown');
  assert.ok(nonsense.lines.some((l) => l.startsWith('ERROR|')));

  const noFolder = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Action', 'Probe', '-OutFile', path.join(root, 'no-folder.txt')], { encoding: 'utf8', windowsHide: true });
  assert.equal(noFolder.status, 12);
  assert.equal(state(readReport(path.join(root, 'no-folder.txt'))), 'unknown');
});

test('a folder that is not there is free, with no files to hold', WINDOWS_ONLY, () => {
  const r = helper('Wait', path.join(root, 'never-installed'), ['-Seconds', '5']);
  assert.equal(r.code, 10, r.stderr);
  assert.deepEqual(files(r.lines).map((l) => l.split('|')[1]), ['absent', 'absent']);
});

test('with no -OutFile the report is printed, for running it by hand', WINDOWS_ONLY, () => {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Action', 'Probe', '-Folder', path.join(root, 'never-installed')], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 10);
  assert.match(r.stdout, /^REPORT\|1\r?\nSTATE\|free/);
});
