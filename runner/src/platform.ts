// What differs on Windows, in one place (docs/windows-port-plan.md). The
// rest of src/ asks this file rather than testing process.platform itself,
// so the Windows branches are easy to find and to test.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Probe = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string };

export const IS_WINDOWS = process.platform === 'win32';

// The data dir. macOS and Linux keep ~/Library/Application Support/Threadbear
// (docs/protocol.md); Windows uses %APPDATA%\Threadbear.
export function dataDirFor(p: Probe = {}): string {
  const platform = p.platform ?? process.platform;
  const home = p.home ?? os.homedir();
  if (platform === 'win32') {
    const env = p.env ?? process.env;
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'Threadbear');
  }
  return path.join(home, 'Library', 'Application Support', 'Threadbear');
}

// Where the runner writes its log.
export function logFileFor(p: Probe = {}): string {
  const platform = p.platform ?? process.platform;
  const home = p.home ?? os.homedir();
  if (platform === 'win32') {
    const env = p.env ?? process.env;
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Threadbear', 'Logs', 'threadbear-runner.log');
  }
  return path.join(home, 'Library', 'Logs', 'threadbear-runner.log');
}

// Where Claude Code's native install puts its program.
export function claudeBinaryFor(p: Probe = {}): string {
  const platform = p.platform ?? process.platform;
  const home = p.home ?? os.homedir();
  return platform === 'win32' ? path.win32.join(home, '.local', 'bin', 'claude.exe') : path.join(home, '.local', 'bin', 'claude');
}

// Token Stats is a Mac app; its folders only exist there, and these are what
// the config says when nothing else does. Windows gets a place that never
// exists, so nothing is discovered there.
export function tokenStatsDirFor(p: Probe = {}): string {
  const platform = p.platform ?? process.platform;
  const home = p.home ?? os.homedir();
  if (platform === 'win32') {
    const env = p.env ?? process.env;
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'Token Stats');
  }
  return path.join(home, 'Library', 'Application Support', 'Token Stats');
}

// File modes mean nothing on NTFS: a file in the user's profile already
// belongs to that user (and Administrators and SYSTEM) by inheritance, which
// is what 0600 and 0700 are for. So these do nothing there.
export function chmodSafe(file: string, mode: number): void {
  if (IS_WINDOWS) return;
  fs.chmodSync(file, mode);
}

// A directory link: a symlink on macOS and Linux, a junction on Windows,
// which needs no privilege (a file symlink does) but must point at an
// absolute path.
export function linkDir(target: string, link: string): void {
  if (IS_WINDOWS) fs.symlinkSync(path.resolve(path.dirname(link), target), link, 'junction');
  else fs.symlinkSync(target, link);
}

// Where a directory link points, as given (relative links stay relative on
// macOS; a junction always reads back as an absolute path).
export function readLinkDir(link: string): string {
  return fs.readlinkSync(link);
}

// A path under the home folder as ~/rest, with forward slashes on every
// platform: the form the librarian's prompts and replies use, which the
// reading side expands from ~/ (a Windows path would come back as ~\rest,
// which nothing expands).
export function tildePath(p: string, home: string): string {
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? '~' + p.slice(home.length).split(path.sep).join('/') : p;
}
