// A lock for two copies of a script that must not run at once, where the
// platform has no lockf or flock to hold one for them: Windows, for the backend
// deploy (runner/scripts/deploy-backend.mjs). A file made with the "exclusive"
// flag is the lock; it holds its owner's process number, so a lock whose owner
// is gone is taken over. Node only.
//
// It is the simple kind. A lock file left by a crash is told from a live one by
// asking the system whether that process number is in use, and by its age, so
// a number a later program was given could keep one alive for as long as
// STALE_AFTER_MS. The kernel locks the other platforms use don't have that
// problem, and are used where they exist.
//
// Taking over a dead lock is done one waiter at a time. Two waiters can both
// find the same dead lock; if each simply removed the file, the second would
// remove the live lock the first had just made, and both would run. So removing
// a lock takes a second, short-lived lock file (the gate, `<lock>.reclaim`)
// first, and looks at the lock again once it has it: only the waiter that holds
// the gate removes anything, and what it removes is checked to still be dead.
// A gate is held for a few milliseconds; one left by a crash in that time is
// cleared after GATE_STALE_AFTER_MS, and two waiters clearing that at the same
// moment could still race, which takes a crash in those milliseconds as well.

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
export const GATE_STALE_AFTER_MS = 30 * 1000;

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

// Makes `file` with our pid in it, if nobody has it. False if somebody does.
function makeLock(file: string, pid: number, at: number): boolean {
  try {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify({ pid, at }));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return false;
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
  const gate = `${file}.reclaim`;
  const until = now() + waitMs;
  let told = false;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Whether the lock at `file` is one to take over right now, read afresh: dead (its owner is gone),
  // too old, or made and never filled in. 'gone' if there is no file.
  const stale = (): boolean | 'gone' => {
    const holder = holderOf(file);
    let age = 0;
    try {
      age = now() - fs.statSync(file).mtimeMs;
    } catch {
      return 'gone';
    }
    // No pid in it: made a moment ago and not written yet, or damaged. Only an old one is cleared.
    const dead = holder?.pid === undefined ? age > 10_000 : holder.pid !== pid && !alive(holder.pid);
    return dead || age > staleAfterMs;
  };

  // Takes the gate for removing a dead lock. A gate whose owner has gone, or that is old, is cleared
  // for the next try, not taken over in the same step.
  const takeGate = (): boolean => {
    if (makeLock(gate, pid, now())) return true;
    const holder = holderOf(gate);
    let age = 0;
    try {
      age = now() - fs.statSync(gate).mtimeMs;
    } catch {
      return false; // gone since we looked: the next try finds it free
    }
    const dead = holder?.pid === undefined ? age > 10_000 : holder.pid !== pid && !alive(holder.pid);
    if (dead || age > GATE_STALE_AFTER_MS) fs.rmSync(gate, { force: true });
    return false;
  };
  const leaveGate = () => {
    if (holderOf(gate)?.pid === pid) fs.rmSync(gate, { force: true });
  };

  for (;;) {
    if (makeLock(file, pid, now())) {
      return () => {
        // Only our own: one that was taken over as stale is someone else's now.
        if (holderOf(file)?.pid === pid) fs.rmSync(file, { force: true });
      };
    }
    const first = stale();
    if (first === 'gone') continue; // gone since we looked: try again at once
    let busy = false;
    if (first) {
      if (takeGate()) {
        try {
          // Looked at again, holding the gate: another waiter may have cleared it and made a live
          // one in the meantime, which is not ours to remove. While the gate is ours nobody else
          // removes the lock, and a lock that exists cannot be made, so what this finds is what is removed.
          if (stale() === true) fs.rmSync(file, { force: true });
        } finally {
          leaveGate();
        }
        continue;
      }
      busy = true; // another waiter is clearing it: look again in a moment
    }
    if (!told) {
      told = true;
      ops.say?.('Waiting for another backend deploy to finish...');
    }
    if (now() >= until) throw new LockTimeout(`Another backend deploy was still running after ${Math.round(waitMs / 60000)} minutes.`);
    sleep(busy ? 100 : 1000);
  }
}
