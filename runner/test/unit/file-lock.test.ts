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
