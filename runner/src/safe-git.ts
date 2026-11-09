import { execFileSync } from 'node:child_process';

// git in a folder Threadbear hasn't trusted, or whose .git it didn't make.
// A folder from a zip, a tarball or a shared drive can carry its own
// .git/config, and `core.fsmonitor` there names a program git starts on
// anything that reads the working tree: `git ls-files`, `git status`,
// `git worktree add`. Settings given with -c beat the repo's own, so these
// turn it off (and the untracked cache, which feeds from it) whatever the
// folder says. Every git the runner runs in a thread's folder goes through
// these (docs/protocol.md, "Trusting a folder's patches").
export const UNTRUSTED_GIT_CONFIG: readonly string[] = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];

// The arguments for `git -C <dir> ...args` with those settings first.
export function untrustedGitArgs(dir: string, args: readonly string[]): string[] {
  return [...UNTRUSTED_GIT_CONFIG, '-C', dir, ...args];
}

// The runner's environment without any GIT_ variable: one set when the
// runner was started from inside a git hook (or by hand) could point git
// at another repo, or add config (GIT_CONFIG_COUNT, GIT_CONFIG_PARAMETERS)
// that comes after the -c settings above.
export function untrustedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
}

// A listing never fetches or runs a hook. A folder's .git can also say
// it's a partial clone with objects missing (a sparse index whose tree
// isn't there), and git fetches a missing object by itself as it reads the
// index, through the repo's own core.sshCommand, a remote's uploadpack or
// an ext:: address: `git ls-files -s` ran a planted core.sshCommand with
// fsmonitor off (Codex's review of this fix, 9 Nov 2026). GIT_NO_LAZY_FETCH
// stops that in git 2.44 and later. For older git, every transport is
// refused too, each by name, as a protocol's own setting in the repo's
// config would beat protocol.allow. A listing missing an object leaves
// those files out, which is what Claude would see too.
const NO_FETCH: readonly string[] = ['allow', 'ext.allow', 'fd.allow', 'file.allow', 'git.allow', 'ssh.allow', 'http.allow', 'https.allow'].flatMap((k) => ['-c', `protocol.${k}=never`]);
export const LISTING_GIT_CONFIG: readonly string[] = [...UNTRUSTED_GIT_CONFIG, ...NO_FETCH, '-c', 'core.hooksPath=/dev/null'];

// A git listing in `dir`, read whole: what claude-trust and tracked-packages
// use to see what a folder holds before it's trusted. Throws as
// execFileSync does when git fails.
export function untrustedGitSync(dir: string, args: readonly string[]): string {
  return execFileSync('git', [...LISTING_GIT_CONFIG, '-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...untrustedGitEnv(), GIT_NO_LAZY_FETCH: '1' },
  });
}
