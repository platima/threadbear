// Keeps the runner up on Windows: what launchd's KeepAlive does on a Mac.
// The logon task (install-windows.mjs) runs this; it runs the runner from
// the checkout it sits in, and starts it again a few seconds after it exits,
// whether it crashed or restarted itself (runner.restart exits 0 and expects
// a supervisor). Ending the task ends this, the runner and the CLIs, as Task
// Scheduler runs a task's processes in one job.
//
// A runner run this way is a runner from source: no releases, no follow main,
// no handover (docs/windows-port-plan.md). Update it with `git pull`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Threadbear', 'Logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'runner-supervisor.log');
const RESTART_AFTER_MS = 5000;

function note(text) {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
}

function start() {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(root, 'src', 'main.ts')], {
    cwd: root,
    env: { ...process.env, THREADBEAR_FOLLOW_MAIN: '0' },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  fs.closeSync(out);
  note(`started the runner, pid ${child.pid}`);
  child.on('error', (e) => note(`could not start the runner: ${e.message}`));
  child.on('exit', (code, signal) => {
    note(`the runner exited (${signal ?? code}); starting it again in ${RESTART_AFTER_MS / 1000} s`);
    setTimeout(start, RESTART_AFTER_MS);
  });
}

start();
