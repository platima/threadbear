// runner/src/file-lock.ts: the lock file that keeps two backend deploys apart on Windows,
// where lockf and flock don't exist (runner/scripts/deploy-backend.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { LockTimeout, pidAlive, takeFileLock } from '../../src/file-lock.ts';

// A clock that only moves when the lock sleeps, so a wait takes no real time.
function clock(start = Date.now()) {
  let t = start;
  return { now: () => t, sleep: (ms: number) => void (t += ms) };
}

test('taking a free lock writes our pid, and letting go removes it', () => {
  const file = path.join(tmpDir(), 'home', 'backend.winlock');
  const release = takeFileLock(file, { pid: 111, ...clock() });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 111);
  release();
  assert.equal(fs.existsSync(file), false);
});

test('a lock held by a live process is waited for, and a wait that runs out says so', () => {
  const file = path.join(tmpDir(), 'backend.winlock');
  takeFileLock(file, { pid: 111, ...clock() });
  const said: string[] = [];
  assert.throws(() => takeFileLock(file, { pid: 222, alive: () => true, waitMs: 5000, ...clock(), say: (m) => said.push(m) }), (e: Error) => e instanceof LockTimeout && /still running after/.test(e.message));
  assert.deepEqual(said, ['Waiting for another backend deploy to finish...'], 'said once, not every second');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 111, "the holder's lock is left alone");
});

test('the lock is ours as soon as the holder lets go', () => {
  const file = path.join(tmpDir(), 'backend.winlock');
  const first = takeFileLock(file, { pid: 111, ...clock() });
  const c = clock();
  let sleeps = 0;
  const release = takeFileLock(file, {
    pid: 222,
    alive: () => true,
    now: c.now,
    sleep: (ms) => {
      c.sleep(ms);
      if (++sleeps === 3) first();
    },
  });
  assert.equal(sleeps, 3);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 222);
  release();
});

test('a lock whose process has gone is taken over', () => {
  const file = path.join(tmpDir(), 'backend.winlock');
  fs.writeFileSync(file, JSON.stringify({ pid: 99999999, at: Date.now() }));
  const release = takeFileLock(file, { pid: 222, alive: (pid) => pid !== 99999999, ...clock() });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 222);
  release();
});

test("a waiter that saw a dead lock does not remove the live one another waiter made in between", () => {
  const file = path.join(tmpDir(), 'backend.winlock');
  fs.writeFileSync(file, JSON.stringify({ pid: 99999999, at: Date.now() }));
  let releaseFirst: (() => void) | undefined;
  // The second waiter (222) asks whether the old owner is alive. In the moment before it acts, the
  // first waiter (111) clears the dead lock and takes it, start to finish.
  const alive = (pid: number) => {
    if (pid !== 99999999) return true;
    releaseFirst ??= takeFileLock(file, { pid: 111, alive: (p) => p !== 99999999, ...clock() });
    return false;
  };
  assert.throws(() => takeFileLock(file, { pid: 222, alive, waitMs: 5000, ...clock() }), LockTimeout, 'the second waits for the first, as it should');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 111, "the first waiter's lock was not removed from under it");
  assert.equal(fs.existsSync(`${file}.reclaim`), false, 'the gate was let go');
  releaseFirst!();
  assert.equal(fs.existsSync(file), false);
});

test('a dead lock is not cleared while another waiter holds the gate for clearing it', () => {
  const file = path.join(tmpDir(), 'backend.winlock');
  fs.writeFileSync(file, JSON.stringify({ pid: 99999999, at: Date.now() }));
  fs.writeFileSync(`${file}.reclaim`, JSON.stringify({ pid: 333, at: Date.now() }));
  assert.throws(() => takeFileLock(file, { pid: 222, alive: (p) => p === 333, waitMs: 3000, ...clock() }), LockTimeout);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 99999999, 'left as it was');
  assert.equal(JSON.parse(fs.readFileSync(`${file}.reclaim`, 'utf8')).pid, 333, "the other waiter's gate is not touched");
});

test('a gate left by a crash is cleared, and the lock is then taken over', () => {
  const file = path.join(tmpDir(), 'backend.winlock');
  fs.writeFileSync(file, JSON.stringify({ pid: 99999999, at: Date.now() }));
  fs.writeFileSync(`${file}.reclaim`, JSON.stringify({ pid: 444, at: Date.now() }));
  const release = takeFileLock(file, { pid: 222, alive: (p) => p !== 99999999 && p !== 444, ...clock() });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 222);
  assert.equal(fs.existsSync(`${file}.reclaim`), false);
  release();
  // An old gate whose pid is in use is cleared as well: the number may belong to something else now.
  fs.writeFileSync(file, JSON.stringify({ pid: 99999999, at: Date.now() }));
  fs.writeFileSync(`${file}.reclaim`, JSON.stringify({ pid: 555, at: 1 }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${file}.reclaim`, old, old);
  const again = takeFileLock(file, { pid: 222, alive: (p) => p !== 99999999, ...clock() });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 222);
  again();
});

test('a very old lock is taken over even if its pid is in use, as the number may belong to something else now', () => {
  const file = path.join(tmpDir(), 'backend.winlock');
  fs.writeFileSync(file, JSON.stringify({ pid: 111, at: 1 }));
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
  const release = takeFileLock(file, { pid: 222, alive: () => true, ...clock() });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 222);
  release();
});

test('a lock file with nothing in it is given a moment, then cleared', () => {
  const file = path.join(tmpDir(), 'backend.winlock');
  fs.writeFileSync(file, '');
  // Just made: another deploy may be about to write its pid. Waited for.
  assert.throws(() => takeFileLock(file, { pid: 222, alive: () => true, waitMs: 3000, ...clock() }), LockTimeout);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  const release = takeFileLock(file, { pid: 222, alive: () => true, ...clock() });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 222);
  release();
});

test("letting go never removes a lock that has become someone else's", () => {
  const file = path.join(tmpDir(), 'backend.winlock');
  const release = takeFileLock(file, { pid: 111, ...clock() });
  fs.writeFileSync(file, JSON.stringify({ pid: 222, at: Date.now() }));
  release();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 222);
});

test('pidAlive: this process is, one that has finished is not', () => {
  assert.equal(pidAlive(process.pid), true);
  const done = spawnSync(process.execPath, ['-e', '']);
  assert.ok(done.pid);
  assert.equal(pidAlive(done.pid), false);
});
