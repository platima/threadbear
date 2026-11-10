// node --test desktop-tauri/src/ui/pages-lib/updates-words.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followingWords, oldRunnerWords, upstreamWords } from './updates-words.ts';
import type { RunnerUpdates } from '../../core/types.ts';

const base = (o: Partial<RunnerUpdates> = {}): RunnerUpdates => ({ state: 'idle', oldRunners: [], ...o });

test('following main says what state it is in, and what it is waiting on or why it failed', () => {
  assert.match(followingWords(undefined).text, /doesn't report/);
  assert.equal(followingWords(base({ state: 'off', reason: 'running from an installed copy' })).text, 'Not following main: running from an installed copy.');
  assert.equal(followingWords(base({ state: 'off' })).text, 'Not following main.');
  const idle = followingWords(base({ commit: 'abc1234', subject: 'Fix it' }));
  assert.equal(idle.tone, 'ok');
  assert.match(idle.text, /up to date \(main at abc1234: Fix it\)/);
  assert.match(followingWords(base({ state: 'building', commit: 'abc1234' })).text, /Building the runner from main at abc1234\./);
  const waiting = followingWords(base({ state: 'waiting' }));
  assert.equal(waiting.tone, 'warn');
  assert.match(waiting.text, /Waiting for the threads that are running/);
  const failed = followingWords(base({ state: 'failed', reason: 'the tests failed' }));
  assert.equal(failed.tone, 'bad');
  assert.match(failed.text, /build failed: the tests failed\./);
  // A state a newer runner adds is said, not thrown.
  assert.match(followingWords({ ...base(), state: 'newthing' as never }).text, /does not know/);
});

test('threads finishing on the previous version are counted, in the singular too', () => {
  assert.equal(oldRunnerWords(base()), undefined);
  assert.match(oldRunnerWords(base({ oldRunners: [{ version: '1.2', threads: ['a'] }] }))!.text, /^1 thread is finishing its turn on the previous version \(1\.2\)/);
  const two = oldRunnerWords(base({ oldRunners: [{ version: '1.2', threads: ['a', 'b'] }, { version: '1.1', threads: ['c'] }] }))!.text;
  assert.match(two, /^3 threads are finishing their turns on the previous version \(1\.2, 1\.1\)/);
});

test('the upstream release line says nothing when the runner follows none, and counts what a newer release brings', () => {
  assert.equal(upstreamWords(undefined), undefined);
  assert.equal(upstreamWords({ state: 'off' }), undefined);
  const out = upstreamWords({ state: 'available', release: { tag: 'release/2026-11-09', commit: 'x', date: '2026-11-09T01:00:00Z', changes: 1, subjects: [] } })!;
  assert.equal(out.tone, 'warn');
  assert.match(out.text, /release\/2026-11-09 \(2026-11-09\), with 1 change this copy does not have yet/);
  assert.equal(upstreamWords({ state: 'idle', release: { tag: 'release/x', commit: 'x', changes: 0, subjects: [] } })!.tone, 'ok');
  assert.match(upstreamWords({ state: 'failed', reason: 'no network' })!.text, /failed: no network/);
});
