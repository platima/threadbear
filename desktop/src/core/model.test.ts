import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptModel } from './model.ts';
import type { AnyEvent } from './types.ts';

let seq = 0;
const ev = (e: Record<string, unknown>) => ({ seq: ++seq, ts: 1000 + seq, threadId: 't', turnId: 'u1', ...e }) as unknown as AnyEvent;

const requested = (approvalId = 'a1') =>
  ev({ type: 'approval.requested', approvalId, itemId: 'e1', name: 'Edit', title: 'Edit a.txt', input: { file_path: 'a.txt' }, options: ['allow', 'allowAlways', 'deny'] });
const call = (itemId: string, title: string) => ({ itemId, name: 'Bash', title, input: { command: title } });

// The approval card of a model, as the approval it is.
function approval(m: TranscriptModel) {
  const card = m.rows.find((r) => r.kind === 'card')!.card!;
  assert.equal(card.type, 'approval');
  return card as Extract<typeof card, { type: 'approval' }>;
}

test('a waiting approval card keeps the calls queued behind it, and a later list replaces an earlier one', () => {
  const m = new TranscriptModel();
  m.apply(requested());
  m.apply(ev({ type: 'approval.queued', approvalId: 'a1', calls: [call('b1', 'git status')] }));
  assert.deepEqual(approval(m).queued?.map((q) => q.itemId), ['b1']);
  const before = m.rows.find((r) => r.kind === 'card')!.rev;
  m.apply(ev({ type: 'approval.queued', approvalId: 'a1', calls: [call('b1', 'git status'), call('b2', 'ls')] }));
  assert.deepEqual(approval(m).queued?.map((q) => q.itemId), ['b1', 'b2']);
  assert.notEqual(m.rows.find((r) => r.kind === 'card')!.rev, before, 'the drawn card is told to draw again');
});

test("the card's own call keeps its item id, so a tick on it can be told apart", () => {
  const m = new TranscriptModel();
  m.apply(requested());
  assert.equal(approval(m).itemId, 'e1');
});

test('a queue that arrives after the card was answered, or for no card, is left out', () => {
  const m = new TranscriptModel();
  m.apply(requested());
  m.apply(ev({ type: 'approval.resolved', approvalId: 'a1', decision: 'allow' }));
  m.apply(ev({ type: 'approval.queued', approvalId: 'a1', calls: [call('b1', 'git status')] }));
  m.apply(ev({ type: 'approval.queued', approvalId: 'nope', calls: [call('b1', 'git status')] }));
  assert.equal(approval(m).queued, undefined);
  assert.equal(approval(m).decision, 'allow');
});

// The runner sends a failed turn's error as its own event, and says it again on the
// turn's end, so a person saw the same red line twice (rc.2, an expired login).
const AUTH = 'Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again';

test("a turn's error is one row, whether the runner says it once or twice, and it learns what kind of error it was", () => {
  const m = new TranscriptModel();
  m.apply(ev({ type: 'error', message: AUTH }));
  m.apply(ev({ type: 'turn.completed', outcome: 'failed', durationMs: 5, error: AUTH, errorKind: 'auth' }));
  const rows = m.rows.filter((r) => r.kind === 'error' || r.kind === 'turnEnd');
  assert.equal(rows.length, 1, 'said once');
  assert.equal(rows[0].kind, 'error');
  assert.equal(rows[0].errorKind, 'auth');
  assert.equal(m.lastEnd?.outcome, 'failed', 'the end of the turn is still known');
  assert.equal(m.busy, false);

  // The same error twice in one turn (a retry that fails the same way) is still one row.
  const twice = new TranscriptModel();
  twice.apply(ev({ type: 'error', message: AUTH }));
  twice.apply(ev({ type: 'error', message: AUTH }));
  assert.equal(twice.rows.filter((r) => r.kind === 'error').length, 1);
});

test("an error with no row before it is still shown by the turn's end, and the same words in a later turn are not taken for the first", () => {
  const m = new TranscriptModel();
  m.apply(ev({ type: 'turn.completed', outcome: 'failed', durationMs: 5, error: AUTH, errorKind: 'auth' }));
  const end = m.rows.filter((r) => r.kind === 'turnEnd');
  assert.equal(end.length, 1);
  assert.equal(end[0].text, AUTH);
  assert.equal(end[0].errorKind, 'auth');

  // A second turn that fails the same way gets its own, since the first turn ended.
  m.apply(ev({ type: 'turn.started', turnId: 'u2' }));
  m.apply(ev({ type: 'error', turnId: 'u2', message: AUTH }));
  m.apply(ev({ type: 'turn.completed', turnId: 'u2', outcome: 'failed', durationMs: 5, error: AUTH, errorKind: 'auth' }));
  assert.equal(m.rows.filter((r) => r.kind === 'error').length, 1, "the second turn's error row");
  assert.equal(m.rows.filter((r) => r.kind === 'turnEnd').length, 1, 'and no second end row for it');

  // A failure with no error text keeps its plain end row.
  const stopped = new TranscriptModel();
  stopped.apply(ev({ type: 'turn.completed', outcome: 'interrupted', durationMs: 5 }));
  assert.equal(stopped.rows.find((r) => r.kind === 'turnEnd')?.text, 'Stopped');
});
