import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptModel } from './model.ts';
import type { AnyEvent } from './types.ts';

let seq = 0;
const ev = (e: Record<string, unknown>) => ({ seq: ++seq, ts: 1000 + seq, threadId: 't', turnId: 'u1', ...e }) as unknown as AnyEvent;

const requested = (approvalId = 'a1') =>
  ev({ type: 'approval.requested', approvalId, itemId: 'e1', name: 'Edit', title: 'Edit a.txt', input: { file_path: 'a.txt' }, options: ['allow', 'allowAlways', 'deny'] });
const call = (itemId: string, title: string) => ({ itemId, name: 'Bash', title, input: { command: title } });

test('a waiting approval card keeps the calls queued behind it, and a later list replaces an earlier one', () => {
  const m = new TranscriptModel();
  m.apply(requested());
  m.apply(ev({ type: 'approval.queued', approvalId: 'a1', calls: [call('b1', 'git status')] }));
  const card = () => m.rows.find((r) => r.kind === 'card')!.card!;
  assert.deepEqual(card().type === 'approval' && card().queued?.map((q) => q.itemId), ['b1']);
  const before = m.rows.find((r) => r.kind === 'card')!.rev;
  m.apply(ev({ type: 'approval.queued', approvalId: 'a1', calls: [call('b1', 'git status'), call('b2', 'ls')] }));
  assert.deepEqual(card().type === 'approval' && card().queued?.map((q) => q.itemId), ['b1', 'b2']);
  assert.notEqual(m.rows.find((r) => r.kind === 'card')!.rev, before, 'the drawn card is told to draw again');
});

test("the card's own call keeps its item id, so a tick on it can be told apart", () => {
  const m = new TranscriptModel();
  m.apply(requested());
  const card = m.rows.find((r) => r.kind === 'card')!.card!;
  assert.equal(card.type === 'approval' && card.itemId, 'e1');
});

test('a queue that arrives after the card was answered, or for no card, is left out', () => {
  const m = new TranscriptModel();
  m.apply(requested());
  m.apply(ev({ type: 'approval.resolved', approvalId: 'a1', decision: 'allow' }));
  m.apply(ev({ type: 'approval.queued', approvalId: 'a1', calls: [call('b1', 'git status')] }));
  m.apply(ev({ type: 'approval.queued', approvalId: 'nope', calls: [call('b1', 'git status')] }));
  const card = m.rows.find((r) => r.kind === 'card')!.card!;
  assert.equal(card.type === 'approval' && card.queued, undefined);
  assert.equal(card.decision, 'allow');
});
