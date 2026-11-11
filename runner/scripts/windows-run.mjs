// Keeps the runner up on Windows: what launchd's KeepAlive does on a Mac. (On
// Linux the desktop app's systemd service, install-linux.mjs, runs it too.)
// The logon task (install-windows.mjs) runs this; it runs the runner from
// the checkout it sits in, and starts it again after it exits, whether it
// crashed or restarted itself (runner.restart exits 0 and expects a
// supervisor). Ending the task should end this, the runner and the CLIs, as
// Task Scheduler runs a task's processes in one job. That has not been checked
// against a real task, so the runner also stops by itself when this ends
// (runnerLink), and `install-windows.mjs --stop` ends what is still there: this
// first, so that it cannot start the runner again, found by the pid it notes in
// runner-supervisor.pid beside its log (supervisorNote), and then the runner.
//
// A runner that keeps failing is tried again after longer and longer waits (5 s,
// 10 s, 20 s, up to 5 minutes), and a runner that ran for a minute starts the
// waits again. A runner that finds another one already using the data folder
// ends this supervisor instead, with exit code 0 so Task Scheduler doesn't
// start it again: whoever is running that one (a terminal, say) is in charge.
//
// A runner run this way is a runner from source: no releases, no follow main,
// no handover (docs/windows-port-plan.md). Update it with `git pull`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// How the runner is started: through agent-sdk-preload.mjs, which makes sure the
// Claude Agent SDK can be imported first (an install does not carry it; see
// agent-sdk.mjs). A stand-in entry, which tests use, has no need of it.
export function runnerArgs(entry, { preload = true } = {}) {
  return preload ? ['--import', pathToFileURL(path.join(here, 'agent-sdk-preload.mjs')).href, entry] : [entry];
}

// How the runner is tied to this supervisor. Node puts a child that is not
// detached in a job object that ends it when its parent goes, however that
// happens (tried on Node 25 with a stand-in: the runner is gone within a
// moment of the supervisor being ended), so a runner does not outlive this
// today. It does not rest on that alone: on Windows the runner gets a pipe for
// its standard input, of which this keeps the other end, and a variable that
// says to stop when it closes (release.ts, takeSupervisorPipe), and the system
// closes the pipe whenever this ends. That stop is the runner's own, and holds
// if the runner is ever started some other way (detached, say). The Linux
// service has systemd for this, and a runner started by hand has no
// supervisor, so neither gets the pipe. The variable is not
// THREADBEAR_SUPERVISED, which switches on the handover paths.
export function runnerLink(platform = process.platform) {
  return platform === 'win32' ? { stdin: 'pipe', env: { THREADBEAR_RUNNER_WATCH_STDIN: '1' } } : { stdin: 'ignore', env: {} };
}

// What this notes about itself in runner-supervisor.pid, for install-windows.mjs
// (supervisorPidFileFor): its pid and its start time, in the form run/runner.pid
// has them (lock.ts), so the same check can tell it from a process that has its
// pid later. The start time is worked out here, the way proc.ts ownStartTime
// does, so that this long-running process never needs PowerShell: a "~" in front
// says it is an estimate, and sameStartTime allows for that.
const FILETIME_AT_UNIX_EPOCH_MS = 11_644_473_600_000n;
export function supervisorNote(pid = process.pid, startedMs = Date.now() - process.uptime() * 1000) {
  const lstart = '~' + ((BigInt(Math.round(startedMs)) + FILETIME_AT_UNIX_EPOCH_MS) * 10_000n).toString();
  return JSON.stringify({ pid, lstart }) + '\n';
}

// What main.ts writes before it exits 1 because another runner holds the lock.
export const ALREADY_RUNNING = /Another runner \(pid \d+\) is already using/;
export const FIRST_WAIT_MS = 5000;
export const MAX_WAIT_MS = 300_000;
export const HEALTHY_MS = 60_000;

// The wait before the next start: the first wait after a runner that ran long
// enough to count as healthy, twice the last one after one that didn't.
export function nextWait(lastWaitMs, ranMs, { first = FIRST_WAIT_MS, max = MAX_WAIT_MS, healthy = HEALTHY_MS } = {}) {
  if (!lastWaitMs || ranMs >= healthy) return first;
  return Math.min(lastWaitMs * 2, max);
}

// Roughly 2 MB is plenty of "the runner started" lines.
const LOG_LIMIT_BYTES = 2 * 1024 * 1024;

function run() {
  // (Linux runs this too, as the desktop app's service: the runner's log is
  // in ~/Library/Logs there, platform.ts logFileFor, and this one beside it.)
  const logDir = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Threadbear', 'Logs') : path.join(os.homedir(), 'Library', 'Logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'runner-supervisor.log');
  // Only for tests: a stand-in for the runner, and a shorter first wait.
  const entry = process.env.THREADBEAR_SUPERVISE_ENTRY || path.join(root, 'src', 'main.ts');
  const waits = { first: Number(process.env.THREADBEAR_SUPERVISE_FIRST_WAIT_MS) || FIRST_WAIT_MS };
  waits.max = waits.first * (MAX_WAIT_MS / FIRST_WAIT_MS);

  const note = (text) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
  // Which process this is and which node it runs on, so a node.exe that holds
  // an install's files can be told from the log which it is.
  note(`supervisor pid ${process.pid}, node ${process.execPath}`);
  // Where `install-windows.mjs --stop` finds this process if Task Scheduler's End
  // leaves it running. Windows only, as nothing else reads it. A folder that can't
  // be written to must not stop the runner from running, so failing is no matter.
  const pidFile = process.platform === 'win32' ? path.join(logDir, 'runner-supervisor.pid') : undefined;
  if (pidFile) {
    try {
      fs.writeFileSync(pidFile, supervisorNote());
    } catch {
      // not noted: --stop then ends the runner, as it did before
    }
  }
  // Taken away when this ends itself, if it is still this one's.
  const forget = () => {
    try {
      if (pidFile && JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid === process.pid) fs.rmSync(pidFile, { force: true });
    } catch {
      // gone, or someone else's
    }
  };

  // The log is cut to a second file when it gets big, between runs, when
  // nothing has it open.
  function rotateLog() {
    try {
      if (fs.statSync(logFile).size > LOG_LIMIT_BYTES) fs.renameSync(logFile, `${logFile}.1`);
    } catch {
      // no log yet, or one that can't be moved: carry on appending
    }
  }

  let wait = 0;
  function start() {
    rotateLog();
    const startedAt = Date.now();
    const link = runnerLink();
    const child = spawn(process.execPath, runnerArgs(entry, { preload: !process.env.THREADBEAR_SUPERVISE_ENTRY }), {
      cwd: root,
      env: { ...process.env, THREADBEAR_FOLLOW_MAIN: '0', ...link.env },
      stdio: [link.stdin, 'pipe', 'pipe'],
      windowsHide: true,
    });
    // Nothing is ever written to it: it is only held open. A runner that exits first
    // must not turn the broken pipe into an uncaught error here.
    child.stdin?.on('error', () => {});
    note(`started the runner, pid ${child.pid}`);
    // The runner's own words go to the log, and are watched for the one that
    // says another runner has the data folder.
    let said = '';
    const take = (d) => {
      fs.appendFileSync(logFile, d);
      if (said.length < 16_384) said += d;
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let ended = false;
    const after = (what) => {
      if (ended) return;
      ended = true;
      if (ALREADY_RUNNING.test(said)) {
        note('another runner is already using the data folder, so this one stops');
        forget();
        process.exit(0);
      }
      wait = nextWait(wait, Date.now() - startedAt, waits);
      note(`${what}; starting it again in ${wait / 1000} s`);
      setTimeout(start, wait);
    };
    child.on('error', (e) => after(`could not start the runner: ${e.message}`));
    // 'close' comes once the output has been read. A program the runner left
    // behind can hold the pipes open, so it isn't waited for long.
    child.on('close', (code, signal) => after(`the runner exited (${signal ?? code})`));
    child.on('exit', (code, signal) => setTimeout(() => after(`the runner exited (${signal ?? code})`), 500));
  }

  start();
}

// A test that wants only the functions above sets this.
if (!process.env.THREADBEAR_SUPERVISE_NO_RUN) run();
