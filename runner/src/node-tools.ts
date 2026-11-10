// Starting npm, npx and the programs in node_modules from a Node script, the
// same way on Windows as anywhere else. Node only: scripts/setup-sync.mjs and
// runner/scripts/deploy-backend.mjs import it before any package is installed.
//
// On Windows npm and npx are .cmd files, and since the 2024 security fix Node
// refuses to start a .cmd or .bat without a shell (spawn EINVAL). `shell: true`
// is the usual way round that, but it joins the arguments into one string
// without quoting them (DEP0190), which goes wrong in a folder with a space or a
// bracket in its name, like C:\Program Files (x86)\ or D:\Repos\My Projects\.
// So this does the two things that work:
//
//   1. Where it can, it doesn't start a .cmd at all: npm is run as
//      `node npm-cli.js` and a package's program as `node <its bin file>`,
//      which are plain arguments to node.exe and need no quoting.
//   2. Where it can't (npm.cmd with no npm-cli.js beside Node), it hands the
//      .cmd to cmd.exe with a command line it quotes itself, and refuses an
//      argument that cmd.exe would read for itself (a quote or a percent sign).
//
// Everything takes the platform and the file checks as parameters, so a test
// on any machine can say what Windows would do.

import fs from 'node:fs';
import path from 'node:path';

export type Command = { file: string; args: string[]; windowsVerbatimArguments?: boolean };
type Probe = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (file: string) => boolean };

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

// An environment variable by name, whatever its case: Windows has `Path`, and a
// plain object copy of the environment keeps that spelling.
function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

// The environment with `dir` first on the PATH, written back under the name
// the PATH already has (a second `PATH` beside `Path` would leave it to Node
// to pick one).
export function pathWith(env: NodeJS.ProcessEnv, dir: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const delimiter = platform === 'win32' ? ';' : ':';
  const rest = (env[key] ?? '').split(delimiter).filter((d) => d && d !== dir);
  return { ...env, [key]: [dir, ...rest].join(delimiter) };
}

// One argument as it goes into a cmd.exe command line. Plain words go as they
// are; anything else in double quotes, which cmd.exe reads as literal text
// (& | < > ^ ( ) and spaces included). A double quote can't be written inside
// those, and a percent sign would still start a variable, so those two are
// refused rather than guessed at.
export function cmdArg(arg: string): string {
  if (/["%\r\n\0]/.test(arg)) {
    throw new Error(`Can't pass ${JSON.stringify(arg)} to a .cmd program on Windows: cmd.exe would read its quote or percent sign itself.`);
  }
  if (arg !== '' && /^[A-Za-z0-9_@+=:,./\\-]+$/.test(arg)) return arg;
  // A backslash before the closing quote would escape it, for the program that reads the line next.
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`;
}

const BATCH = /\.(cmd|bat)$/i;

// A bare program name as Windows would find it: the first PATH folder that has
// it as .exe, .cmd or .bat. A name with a folder or an extension is left alone.
function resolveOnWindows(file: string, p: Probe): string {
  if (/[\\/]/.test(file) || path.win32.extname(file)) return file;
  const exists = p.exists ?? ((f: string) => fs.existsSync(f));
  const dirs = (envGet(p.env ?? process.env, 'PATH') ?? '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const candidate = path.win32.join(dir, file + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return file;
}

// What to hand to spawn for `file args`. Anywhere but Windows, and on Windows
// for anything that is not a .cmd or .bat, that is just the file and its
// arguments. For a .cmd or .bat it is cmd.exe running the line below, whose
// arguments Node must pass as they are (windowsVerbatimArguments).
export function commandFor(file: string, args: string[], p: Probe = {}): Command {
  const platform = p.platform ?? process.platform;
  if (platform !== 'win32') return { file, args };
  const resolved = resolveOnWindows(file, p);
  if (!BATCH.test(resolved)) return { file: resolved, args };
  const line = [resolved, ...args].map(cmdArg).join(' ');
  // /s drops the outer pair of quotes and keeps the ones inside; /d skips AutoRun.
  return { file: envGet(p.env ?? process.env, 'ComSpec') || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

// `npm <args>` using the npm that came with this Node.
export function npmCommand(nodeExec: string, args: string[], p: Probe = {}): Command {
  const platform = p.platform ?? process.platform;
  const exists = p.exists ?? ((f: string) => fs.existsSync(f));
  const P = pathFor(platform);
  const dir = P.dirname(nodeExec);
  if (platform === 'win32') {
    // The Windows installer, nvm-windows and fnm all keep npm's script here, beside node.exe.
    const cli = P.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (exists(cli)) return { file: nodeExec, args: [cli, ...args] };
    const cmd = P.join(dir, 'npm.cmd');
    return commandFor(exists(cmd) ? cmd : 'npm', args, p);
  }
  const beside = P.join(dir, 'npm');
  return { file: exists(beside) ? beside : 'npm', args };
}

// The file that a package's `bin` names `name`, found among the packages in a
// node_modules folder: convex's `convex`, @convex-dev/static-hosting's
// `static-hosting`. This is what node_modules/.bin/<name> leads to, without
// reading the shims npm writes there (a .cmd and a .ps1 on Windows).
export function nodeBin(modules: string, name: string): string | undefined {
  const fromPackage = (dir: string): string | undefined => {
    let pkg: { name?: unknown; bin?: unknown };
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      return undefined;
    }
    const bin = pkg.bin;
    let rel: unknown;
    if (typeof bin === 'string') rel = typeof pkg.name === 'string' && pkg.name.split('/').pop() === name ? bin : undefined;
    else if (bin && typeof bin === 'object') rel = (bin as Record<string, unknown>)[name];
    if (typeof rel !== 'string') return undefined;
    const file = path.resolve(dir, rel);
    return fs.existsSync(file) ? file : undefined;
  };
  // The package with the program's own name first, the usual case.
  const same = fromPackage(path.join(modules, name));
  if (same) return same;
  let names: string[];
  try {
    names = fs.readdirSync(modules);
  } catch {
    return undefined;
  }
  for (const entry of names) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      let scoped: string[] = [];
      try {
        scoped = fs.readdirSync(path.join(modules, entry));
      } catch {
        // not a folder
      }
      for (const inner of scoped) {
        const found = fromPackage(path.join(modules, entry, inner));
        if (found) return found;
      }
      continue;
    }
    const found = fromPackage(path.join(modules, entry));
    if (found) return found;
  }
  return undefined;
}

// `npx <name> <args>` in a folder that has the package installed. On Windows
// that runs the package's program with node and skips npx.cmd; elsewhere it is
// npx as before.
export function npxCommand(nodeExec: string, cwd: string, name: string, args: string[], p: Probe = {}): Command {
  const platform = p.platform ?? process.platform;
  const exists = p.exists ?? ((f: string) => fs.existsSync(f));
  const P = pathFor(platform);
  const dir = P.dirname(nodeExec);
  if (platform === 'win32') {
    const bin = nodeBin(path.join(cwd, 'node_modules'), name);
    if (bin) return { file: nodeExec, args: [bin, ...args] };
    const cmd = P.join(dir, 'npx.cmd');
    return commandFor(exists(cmd) ? cmd : 'npx', [name, ...args], p);
  }
  const beside = P.join(dir, 'npx');
  return { file: exists(beside) ? beside : 'npx', args: [name, ...args] };
}

// tar as git archive's output needs it. On Windows that is bsdtar in System32
// (Windows 10 and later): a tar from Git for Windows is GNU tar, which reads a
// path with a drive letter ("C:...") as a file on another computer.
export function tarProgram(p: Probe = {}): string {
  const platform = p.platform ?? process.platform;
  if (platform !== 'win32') return 'tar';
  const exists = p.exists ?? ((f: string) => fs.existsSync(f));
  const root = envGet(p.env ?? process.env, 'SystemRoot') || 'C:\\Windows';
  const system = path.win32.join(root, 'System32', 'tar.exe');
  return exists(system) ? system : 'tar';
}
