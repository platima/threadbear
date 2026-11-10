// Keeps a thread that isn't on Full access from reading the runner's secrets
// with Claude's own tools (docs/protocol.md, "Who's really calling"). Defence in
// depth behind the RPC's own check of the caller's process: a shell that's
// allowed to run anything can spell a path in ways no pattern will see, and
// SECURITY.md says so. A Full access thread can already run anything as you,
// so it isn't checked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REASON = "The runner's secrets aren't readable from a thread without Full access. tb in this thread already works with its own key.";

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;

function expand(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

// The deepest part of a path that exists, with links followed, and the rest
// on the end: a Read of secrets/runner-token through a link in the path is
// that file.
function resolved(p: string, cwd?: string): string {
  let head = path.resolve(cwd ?? process.cwd(), expand(p));
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail);
    } catch {
      const up = path.dirname(head);
      if (up === head) return path.join(head, ...tail);
      tail.unshift(path.basename(head));
      head = up;
    }
  }
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

// The reason a call is denied, or undefined if it's fine. `home` is the
// runner's data dir.
export function denySecrets(tool: string, input: Record<string, unknown>, home: string, cwd?: string): string | undefined {
  const secrets = path.join(home, 'secrets');
  if (tool === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    // Quotes and backslashes that don't change which path it is. On Windows a
    // backslash is the separator (C:\Users\me\secrets\runner-token), so the
    // command is also looked at with its backslashes kept and as forward slashes,
    // and every comparison ignores case, as the file system does (NTFS, and APFS as
    // it is usually made). A UNC spelling of a local drive (\\localhost\c$\...) and a
    // \\?\ prefix name the drive's own path.
    const unquoted = command.replace(/["']/g, '');
    const unc = (s: string) => s.replace(/\\\\(?:localhost|127\.0\.0\.1|\[::1\])\\([a-z])\$\\/gi, '$1:\\').replace(/\\\\\?\\/g, '');
    const variants = [command.replace(/\\(.)/g, '$1').replace(/["']/g, ''), unquoted, unquoted.replace(/\\/g, '/'), unc(unquoted), unc(unquoted).replace(/\\/g, '/')].map((v) => v.toLowerCase());
    const home2 = os.homedir();
    // The data folder as a thread's shell can spell it: its own path, the variables every
    // thread is given (THREADBEAR_HOME, THREADBEAR_RUNNER_HOME and the old THREADBARE_ names)
    // in each shell's way (bash $X and ${X}, PowerShell $env:X, cmd %X%), and the folder
    // under the user's data folder by its usual name.
    const VARS = ['THREADBEAR_HOME', 'THREADBEAR_RUNNER_HOME', 'THREADBARE_HOME', 'THREADBARE_RUNNER_HOME'];
    const named = VARS.flatMap((v) => [`$${v}`, `\${${v}}`, `$env:${v}`, `%${v}%`]);
    const forms = [
      secrets,
      secrets.replace(home2, '~'),
      secrets.replace(home2, '$HOME'),
      secrets.replace(home2, '${HOME}'),
      ...named.map((n) => `${n}/secrets`),
      '%appdata%/threadbear/secrets',
      '$env:appdata/threadbear/secrets',
      'Threadbear/secrets',
    ].map((f) => f.toLowerCase());
    const forward = (list: string[]) => list.flatMap((f) => (f.includes('\\') ? [f, f.replace(/\\/g, '/')] : [f]));
    if (variants.some((v) => /\brunner-token\b/.test(v) || forward(forms).some((f) => v.includes(f)))) return REASON;
    // A name Windows made for a long one (8.3): Threadbear is THREAD~1 and runner-token is
    // RUNNER~1, so a command can name `THREAD~1\SECRET~1\RUNNER~1` and never say either word.
    if (variants.some((v) => /runner~\d/.test(v) || (/thread~\d/.test(v) && (/secret/.test(v) || /[*?[]/.test(v))))) return REASON;
    // The data dir named with a wildcard after it reaches the same files
    // without those words (secr*/*).
    const dataDir = forward([home, home.replace(home2, '~'), home.replace(home2, '$HOME'), ...named, 'Application Support/Threadbear', '%appdata%/threadbear', '$env:appdata/threadbear'].map((d) => d.toLowerCase()));
    if (variants.some((v) => dataDir.some((d) => v.includes(d)) && /[*?[]/.test(v))) return REASON;
    return undefined;
  }
  const target = resolved(secrets);
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v && (inside(resolved(v, cwd), target) || inside(path.resolve(cwd ?? process.cwd(), expand(v)), secrets))) return REASON;
  }
  // A Glob or Grep from the data dir itself reaches the folder whatever its
  // pattern says; from further up, only one that names it.
  if (tool === 'Glob' || tool === 'Grep') {
    const base = typeof input.path === 'string' && input.path ? input.path : (cwd ?? '.');
    const dir = resolved(base, cwd);
    const pattern = typeof input.pattern === 'string' ? input.pattern : '';
    if (dir === resolved(home) || (inside(target, dir) && /\bsecrets\b|runner-token/.test(pattern))) return REASON;
  }
  return undefined;
}
