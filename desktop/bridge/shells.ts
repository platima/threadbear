// Which shells this PC has for the Terminal, and which one is the default.
//
// On Windows: PowerShell 7 (pwsh.exe) if it is installed, Windows PowerShell 5.1
// (which every Windows 10 and 11 has), each Linux distribution WSL has, Git Bash
// and Command Prompt. With nothing chosen the default is the first PowerShell
// there is: 7 over 5.1, as 7 is the one people install on purpose. On Linux and
// macOS: the login shell ($SHELL) and the others /etc/shells lists.
//
// Only what is found here can be started: the page asks for a shell by its id
// and never names a program, so a page (or a program that has the bridge's key)
// can't have the bridge run an arbitrary file through this.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitBash } from '../../runner/src/system-tools.ts';

export type Shell = {
  /** What a saved choice stores: pwsh, powershell, cmd, gitbash, wsl:<distro>, login, or sh:<path>. */
  id: string;
  label: string;
  file: string;
  args: string[];
  /** A WSL distribution: its folder goes in with --cd, which turns a Windows path into /mnt/c/... */
  wsl?: string;
};

export type ShellList = {
  shells: Shell[];
  /** The id used when nothing has been chosen. Undefined only when there is no shell at all. */
  auto?: string;
  /** Said under the list when something expected is missing (WSL without a distribution). */
  notes: string[];
};

/** What the detection looks at, so a test can stand in a machine. */
export type Machine = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists(file: string): boolean;
  /** The distributions `wsl.exe -l -q` lists, or undefined when it can't be run or says none. */
  wslDistros(wslExe: string): Promise<string[] | undefined>;
  gitBash(): string | undefined;
  readText(file: string): string | undefined;
};

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    // A Microsoft Store program's alias (WindowsApps\pwsh.exe) is a reparse point that stat can
    // refuse to read though the file is there to run.
    return fs.existsSync(file);
  }
};

/** The names in the output of `wsl.exe -l -q`. It is UTF-16 (little-endian) unless a build says otherwise. */
export function parseWslList(raw: Buffer): string[] {
  // UTF-16 text has a zero byte beside every ASCII character.
  const utf16 = raw.length >= 2 && (raw[1] === 0 || (raw[0] === 0xff && raw[1] === 0xfe));
  const text = (utf16 ? raw.toString('utf16le') : raw.toString('utf8')).replace(/^\uFEFF/, '');
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const name = line.replace(/\0/g, '').replace(/\s*\(default\)\s*$/i, '').trim();
    // docker-desktop and its data distribution are Docker's own, with no shell to start.
    if (!name || /^docker-desktop(-data)?$/i.test(name) || /windows subsystem|wsl\.exe|--/i.test(name) || name.length > 64) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function realWslDistros(wslExe: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(wslExe, ['-l', '-q'], { encoding: 'buffer', timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(undefined);
      const names = parseWslList(stdout);
      resolve(names.length ? names : undefined);
    });
  });
}

export function realMachine(): Machine {
  return {
    platform: process.platform,
    env: process.env,
    exists: isFile,
    wslDistros: realWslDistros,
    gitBash: () => gitBash(),
    readText: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

const win = path.win32;

function onPath(m: Machine, name: string): string | undefined {
  for (const entry of (m.env.PATH ?? m.env.Path ?? '').split(';')) {
    const dir = entry.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    const file = win.join(dir, name);
    if (m.exists(file)) return file;
  }
  return undefined;
}

async function windowsShells(m: Machine): Promise<ShellList> {
  const shells: Shell[] = [];
  const notes: string[] = [];
  const root = m.env.SystemRoot || m.env.windir || 'C:\\Windows';
  const system32 = win.join(root, 'System32');

  const programFiles = [m.env.ProgramW6432, m.env.ProgramFiles, m.env['ProgramFiles(x86)']].filter((p): p is string => Boolean(p));
  const pwsh = onPath(m, 'pwsh.exe') ?? programFiles.map((p) => win.join(p, 'PowerShell', '7', 'pwsh.exe')).find((f) => m.exists(f)) ?? (m.env.LOCALAPPDATA ? [win.join(m.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe')].find((f) => m.exists(f)) : undefined);
  if (pwsh) shells.push({ id: 'pwsh', label: 'PowerShell 7', file: pwsh, args: ['-NoLogo'] });

  const powershell = win.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (m.exists(powershell)) shells.push({ id: 'powershell', label: 'Windows PowerShell 5.1', file: powershell, args: ['-NoLogo'] });

  const wsl = win.join(system32, 'wsl.exe');
  if (m.exists(wsl)) {
    const distros = await m.wslDistros(wsl);
    if (distros) for (const name of distros) shells.push({ id: `wsl:${name}`, label: `WSL: ${name}`, file: wsl, args: ['-d', name], wsl: name });
    else notes.push('WSL is on this PC but has no Linux distribution to start. Install one with: wsl --install');
  }

  const bash = m.gitBash();
  if (bash) shells.push({ id: 'gitbash', label: 'Git Bash', file: bash, args: ['--login', '-i'] });

  const cmd = m.env.ComSpec && m.exists(m.env.ComSpec) ? m.env.ComSpec : win.join(system32, 'cmd.exe');
  if (m.exists(cmd)) shells.push({ id: 'cmd', label: 'Command Prompt', file: cmd, args: [] });

  const auto = ['pwsh', 'powershell', 'cmd'].find((id) => shells.some((s) => s.id === id)) ?? shells[0]?.id;
  return { shells, auto, notes };
}

// The shells a Unix-like system lists as login shells, by the names people use.
const KNOWN = new Set(['bash', 'zsh', 'fish', 'pwsh', 'nu', 'xonsh', 'elvish']);

function unixShells(m: Machine): ShellList {
  const shells: Shell[] = [];
  const login = [m.env.SHELL, '/bin/bash', '/usr/bin/bash', '/bin/sh'].find((f): f is string => Boolean(f) && m.exists(f!));
  if (login) shells.push({ id: 'login', label: `Login shell (${path.posix.basename(login)})`, file: login, args: ['-l'] });
  const listed = m.readText('/etc/shells') ?? '';
  for (const line of listed.split(/\r?\n/)) {
    const file = line.trim();
    if (!file.startsWith('/') || file === login || !KNOWN.has(path.posix.basename(file)) || !m.exists(file)) continue;
    if (shells.some((s) => s.file === file)) continue;
    // Two paths to the same shell (/bin/bash and /usr/bin/bash) are listed once, by name.
    const name = path.posix.basename(file);
    if (shells.some((s) => path.posix.basename(s.file) === name)) continue;
    shells.push({ id: `sh:${file}`, label: name, file, args: name === 'pwsh' ? ['-NoLogo'] : ['-l'] });
  }
  return { shells, auto: shells[0]?.id, notes: [] };
}

export function detectShells(m: Machine = realMachine()): Promise<ShellList> {
  return m.platform === 'win32' ? windowsShells(m) : Promise.resolve(unixShells(m));
}

// Looking is a few file checks and, on Windows, wsl.exe (a second or so when its
// service has to start), so the last answer is kept for half a minute.
let last: { at: number; list: Promise<ShellList> } | undefined;
const KEEP_MS = 30_000;
export function shellsNow(refresh = false): Promise<ShellList> {
  if (!refresh && last && Date.now() - last.at < KEEP_MS) return last.list;
  const list = detectShells();
  last = { at: Date.now(), list };
  return list;
}

/** The shell for a saved choice: that one if it is still here, otherwise the default. */
export function pick(list: ShellList, wanted: string | undefined): { shell?: Shell; fellBack: boolean } {
  const asked = wanted && wanted !== 'auto' ? list.shells.find((s) => s.id === wanted) : undefined;
  if (asked) return { shell: asked, fellBack: false };
  return { shell: list.shells.find((s) => s.id === list.auto), fellBack: !!wanted && wanted !== 'auto' };
}

/** What to run for a shell in a folder. */
export function command(shell: Shell, cwd: string): { file: string; args: string[] } {
  return { file: shell.file, args: shell.wsl ? [...shell.args, '--cd', cwd] : shell.args };
}
