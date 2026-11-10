// A lock for two copies of a script that must not run at once, where the
// platform has no lockf or flock to hold one for them: Windows, for the backend
// deploy (runner/scripts/deploy-backend.mjs). A file made with the "exclusive"
// flag is the lock; it holds its owner's process number, so a lock whose owner
// is gone is taken over. Node only.
//
// It is the simple kind. A lock file left by a crash is told from a live one by
// asking the system whether that process number is in use, and by its age, so
// a number a later program was given could keep one alive for as long as
// STALE_AFTER_MS. Two waiters that both find a dead lock can race to clear it.
// The kernel locks the other platforms use have neither problem, and are used
// where they exist.

import fs from 'node:fs';
import path from 'node:path';

export type LockOps = {
  pid?: number;
  alive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => void;
  say?: (message: string) => void;
  // How long to wait for the lock, and how old a lock must be before it is
  // taken over whoever it names.
  waitMs?: number;
  staleAfterMs?: number;
};

export class LockTimeout extends Error {}

export const LOCK_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

// Whether a process number is in use. "Not permitted" means it is, and ours to
// leave alone.
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function holderOf(file: string): { pid?: number; at?: number } | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown; at?: unknown };
    return { ...(typeof j.pid === 'number' ? { pid: j.pid } : {}), ...(typeof j.at === 'number' ? { at: j.at } : {}) };
  } catch {
    return undefined;
  }
}

// Takes the lock at `file`, waiting for whoever holds it, and gives back the
// function that lets go. Throws LockTimeout if it waited ops.waitMs in vain.
export function takeFileLock(file: string, ops: LockOps = {}): () => void {
  const pid = ops.pid ?? process.pid;
  const alive = ops.alive ?? pidAlive;
  const now = ops.now ?? Date.now;
  const sleep = ops.sleep ?? sleepSync;
  const waitMs = ops.waitMs ?? 30 * 60 * 1000;
  const staleAfterMs = ops.staleAfterMs ?? LOCK_STALE_AFTER_MS;
  const until = now() + waitMs;
  let told = false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid, at: now() }));
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        // Only our own: one that was taken over as stale is someone else's now.
        if (holderOf(file)?.pid === pid) fs.rmSync(file, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const holder = holderOf(file);
    let age = 0;
    try {
      age = now() - fs.statSync(file).mtimeMs;
    } catch {
      continue; // gone since we looked: try again at once
    }
    // No pid in it: made a moment ago and not written yet, or damaged. Only an old one is cleared.
    const dead = holder?.pid === undefined ? age > 10_000 : holder.pid !== pid && !alive(holder.pid);
    if (dead || age > staleAfterMs) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (!told) {
      told = true;
      ops.say?.('Waiting for another backend deploy to finish...');
    }
    if (now() >= until) throw new LockTimeout(`Another backend deploy was still running after ${Math.round(waitMs / 60000)} minutes.`);
    sleep(1000);
  }
}
