// Installs the runner on Windows as a Task Scheduler task that starts at
// logon (docs/windows-port-plan.md). Everything it does is listed by
// --dry-run first, and docs/on-your-mac.md says what it leaves behind.
//
//   node scripts/install-windows.mjs --dry-run     say what it would do
//   node scripts/install-windows.mjs               install and start it
//   node scripts/install-windows.mjs --status      is the task there and running
//   node scripts/install-windows.mjs --installed   exit 0 if the task is there, 1 if not
//   node scripts/install-windows.mjs --stop        end the task if it is running (it stays registered)
//   node scripts/install-windows.mjs --uninstall   end and remove the task and `tb`
//
// It leaves: the task "Threadbear Runner" (this user, no admin rights), and
// `tb.cmd` in %LOCALAPPDATA%\Threadbear\bin, which goes on this user's PATH.
// The data folder (%APPDATA%\Threadbear) is the runner's own and stays.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TASK = 'Threadbear Runner';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Threadbear', 'bin');
const args = new Set(process.argv.slice(2));
const dry = args.has('--dry-run');

if (process.platform !== 'win32') {
  console.error('This installs the Windows task. On a Mac use scripts/install-runner.sh; on Linux see INSTALL.md.');
  process.exit(2);
}

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const me = `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}`;

// conhost --headless gives node a console with no window, which its children
// share, so nothing flashes up. The runner also hides its own children.
export function taskXml({ node, script, cwd, user }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Threadbear runner: starts at logon and is kept running.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEscape(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>conhost.exe</Command>
    <Arguments>--headless "${xmlEscape(node)}" "${xmlEscape(script)}"</Arguments>
    <WorkingDirectory>${xmlEscape(cwd)}</WorkingDirectory>
  </Exec></Actions>
</Task>
`;
}

const schtasks = (...a) => execFileSync('schtasks', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
const ps = (command) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim();

function taskExists() {
  try {
    schtasks('/Query', '/TN', TASK);
    return true;
  } catch {
    return false;
  }
}

// This user's PATH as the registry holds it, %VARIABLES% unexpanded.
// [Environment]::GetEnvironmentVariable would expand them, and writing that
// back with SetEnvironmentVariable would store the expanded text as a plain
// string: it would quietly rewrite everything else on the person's PATH. The
// key is 'Environment' except in the test that points it at a throwaway one.
const ENV_KEY = process.env.THREADBEAR_TEST_ENV_KEY || 'Environment';
function userPath() {
  return ps(`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${ENV_KEY}'); if ($k) { $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') }`);
}
function setUserPath(value) {
  const escaped = value.replace(/'/g, "''");
  // Written as an expandable string, as Windows' own PATH is. Changing a
  // variable through .NET is what tells running programs to re-read it, so a
  // throwaway one is set and removed afterwards.
  ps(
    `$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${ENV_KEY}'); $k.SetValue('Path', '${escaped}', 'ExpandString'); ` +
      `if ('${ENV_KEY}' -eq 'Environment') { [Environment]::SetEnvironmentVariable('THREADBEAR_PATH_CHANGED','1','User'); [Environment]::SetEnvironmentVariable('THREADBEAR_PATH_CHANGED',$null,'User') }`,
  );
}

function onPath(dir) {
  return userPath().split(';').some((p) => p.replace(/\\$/, '').toLowerCase() === dir.toLowerCase());
}

if (args.has('--status')) {
  if (!taskExists()) {
    console.log(`The task "${TASK}" is not installed.`);
  } else {
    const q = schtasks('/Query', '/TN', TASK, '/FO', 'LIST', '/V');
    console.log(q.split(/\r?\n/).filter((l) => /^(Status|Last Run Time|Last Result|Next Run Time)/i.test(l)).join('\n'));
  }
  process.exit(0);
}

// Exit 0 if the task is there, 1 if not: for the desktop app's first run.
if (args.has('--installed')) process.exit(taskExists() ? 0 : 1);

// End the task if it is running, so an installer can replace the files it
// holds open. Leaves the task registered, so the next logon starts it again.
if (args.has('--stop')) {
  console.log(`End the task "${TASK}" if it is running`);
  if (dry) process.exit(0);
  if (taskExists()) {
    try {
      schtasks('/End', '/TN', TASK);
    } catch {
      // not running
    }
  }
  process.exit(0);
}

if (args.has('--uninstall')) {
  const todo =[`End and delete the task "${TASK}"`, `Delete ${path.join(binDir, 'tb.cmd')} and take ${binDir} off this user's PATH`];
  console.log(todo.join('\n'));
  if (dry) process.exit(0);
  if (taskExists()) {
    try {
      schtasks('/End', '/TN', TASK);
    } catch {
      // not running
    }
    schtasks('/Delete', '/TN', TASK, '/F');
  }
  fs.rmSync(path.join(binDir, 'tb.cmd'), { force: true });
  const before = userPath();
  const kept = before.split(';').filter((p) => p && p.replace(/\\$/, '').toLowerCase() !== binDir.toLowerCase());
  // Touch the PATH only if our folder is on it.
  if (kept.join(';') !== before.split(';').filter(Boolean).join(';')) setUserPath(kept.join(';'));
  console.log('Removed. The data folder is untouched.');
  process.exit(0);
}

const node = process.execPath;
const script = path.join(root, 'scripts', 'windows-run.mjs');
const tbCmd = `@echo off\r\n"${node}" "${path.join(root, 'bin', 'tb')}" %*\r\n`;
console.log(
  [
    `Register the task "${TASK}" for ${me}: at logon, hidden, no admin rights, restarted if it fails.`,
    `  runs: conhost.exe --headless "${node}" "${script}"`,
    `Write ${path.join(binDir, 'tb.cmd')} and add ${binDir} to this user's PATH${onPath(binDir) ? ' (already there)' : ''}.`,
    `Start the task now.`,
  ].join('\n'),
);
if (dry) process.exit(0);

const xmlFile = path.join(os.tmpdir(), `threadbear-task-${process.pid}.xml`);
fs.writeFileSync(xmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml({ node, script, cwd: root, user: me }), 'utf16le')]));
try {
  schtasks('/Create', '/TN', TASK, '/XML', xmlFile, '/F');
} finally {
  fs.rmSync(xmlFile, { force: true });
}
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, 'tb.cmd'), tbCmd);
if (!onPath(binDir)) setUserPath([userPath(), binDir].filter(Boolean).join(';'));
schtasks('/Run', '/TN', TASK);
console.log('Installed and started. Open a new terminal to use `tb`. Check with: node scripts/install-windows.mjs --status');
