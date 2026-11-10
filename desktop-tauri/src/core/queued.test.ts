import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWN_CALL, stackedAnswer, stackedCalls, tickedCount } from './queued.ts';

const own = { itemId: 'e1', title: 'Edit a.txt', input: { file_path: 'a.txt' } };
const queued = [
  { itemId: 'b1', name: 'Bash', title: 'git status', input: { command: 'git status' } },
  { itemId: 'w1', name: 'Write', title: 'Write helper.txt', input: { file_path: 'helper.txt' } },
];

test("the card's own call comes first, then the queued ones in order", () => {
  assert.deepEqual(stackedCalls(own, queued).map((c) => c.key), ['e1', 'b1', 'w1']);
});

test('a card whose own call has no item id still has a key for it', () => {
  assert.equal(stackedCalls({ title: 'x', input: {} }, queued)[0]!.key, OWN_CALL);
});

test('everything is ticked to begin with, and Allow allows it all', () => {
  const calls = stackedCalls(own, queued);
  assert.equal(tickedCount(calls, new Set()), 3);
  assert.deepEqual(stackedAnswer(calls, new Set(), true), { decision: 'allow', queued: { b1: 'allow', w1: 'allow' } });
});

test('an unticked queued call is denied while the rest are allowed', () => {
  const calls = stackedCalls(own, queued);
  const off = new Set(['b1']);
  assert.equal(tickedCount(calls, off), 2);
  assert.deepEqual(stackedAnswer(calls, off, true), { decision: 'allow', queued: { b1: 'deny', w1: 'allow' } });
});

test("an unticked own call is denied, and the queued ones still go by their ticks", () => {
  const calls = stackedCalls(own, queued);
  assert.deepEqual(stackedAnswer(calls, new Set(['e1']), true), { decision: 'deny', queued: { b1: 'allow', w1: 'allow' } });
});

test('Deny denies the lot, whatever is ticked', () => {
  const calls = stackedCalls(own, queued);
  assert.deepEqual(stackedAnswer(calls, new Set(), false), { decision: 'deny', queued: { b1: 'deny', w1: 'deny' } });
});

test('with nothing ticked the count is zero', () => {
  const calls = stackedCalls(own, queued);
  assert.equal(tickedCount(calls, new Set(['e1', 'b1', 'w1'])), 0);
});
