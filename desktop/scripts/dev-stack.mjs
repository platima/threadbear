// Starts everything the desktop UI needs to be looked at, on ports and in
// folders of its own so several can run side by side: the mock runner
// (app/Tools/mock-runner, fixture threads), a build of the UI into
// dist-<id>, and the bridge to the mock runner. Prints the page's address
// when it's ready and runs until stopped (it stops its own children).
//
//   node scripts/dev-stack.mjs --id a            ports 18811 and 5191
//   node scripts/dev-stack.mjs --id b --real HOME PORT   bridge to a real or dev runner instead
//
// --id is a letter or number; each id gets its own ports (18810+n, 5190+n).

import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const id = opt('id', 'a');
const n = parseInt(id, 36) % 36;
const runnerPort = 18810 + n;
const bridgePort = 5190 + n;
const work = fs.mkdtempSync(path.join(os.tmpdir(), `tb-desktop-${id}-`));
const kids = [];
const key = crypto.randomBytes(18).toString('base64url');

const run = (cmd, args, options = {}) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, ...options });
  kids.push(child);
  return child;
};

const real = argv.includes('--real');
let home = path.join(work, 'mock');
let port = runnerPort;
if (real) {
  home = argv[argv.indexOf('--real') + 1];
  port = Number(argv[argv.indexOf('--real') + 2]);
} else {
  fs.mkdirSync(home, { recursive: true });
  run(process.execPath, [path.join(desktop, '..', 'app', 'Tools', 'mock-runner', 'server.mjs'), '--data-dir', home, '--port', String(port), '--filler', '16', '--quiet']);
}

const dist = path.join(desktop, `dist-${id}`);
execFileSync(process.execPath, [path.join(desktop, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', dist], { cwd: desktop, stdio: 'ignore', windowsHide: true });
run(process.execPath, [path.join(desktop, 'bridge', 'bridge.ts')], {
  env: { ...process.env, THREADBEAR_BRIDGE_KEY: key, THREADBEAR_HOME: home, THREADBEAR_PORT: String(port), THREADBEAR_BRIDGE_PORT: String(bridgePort), THREADBEAR_DIST: dist },
});
setTimeout(() => console.log(`READY http://127.0.0.1:${bridgePort}/#key=${key}  (runner ${port}, data ${home})`), 1500);

const stop = () => {
  for (const k of kids) k.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
