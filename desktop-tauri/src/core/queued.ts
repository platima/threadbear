// An approval card with calls queued behind it (docs/protocol.md, "Queued calls"):
// the agent's other calls from the same reply, answered with the card's own.
// Each call has a tick (allow) or a cross (deny), all ticked to begin with, as
// on the Mac. Allow sends the card's own call's answer and each queued call's,
// from the ticks; Deny denies the lot. Always allow is not offered: a rule made
// from one click on many calls is not what was asked.

import type { QueuedAnswers, QueuedCall } from './types.ts';

export type StackedCall = { key: string; title: string; input: Record<string, unknown> };

// The key the card's own call goes by when the runner gave it no item id.
export const OWN_CALL = 'own';

// The card's own call first, then the queued ones in order.
export function stackedCalls(own: { itemId?: string; title: string; input: Record<string, unknown> }, queued: QueuedCall[]): StackedCall[] {
  return [{ key: own.itemId || OWN_CALL, title: own.title, input: own.input }, ...queued.map((q) => ({ key: q.itemId, title: q.title, input: q.input }))];
}

// How many calls are ticked: what "Allow 3" says.
export function tickedCount(calls: StackedCall[], unticked: ReadonlySet<string>): number {
  return calls.filter((c) => !unticked.has(c.key)).length;
}

// What a click sends: the card's own decision, and an answer for each queued call.
export function stackedAnswer(calls: StackedCall[], unticked: ReadonlySet<string>, allow: boolean): { decision: 'allow' | 'deny'; queued: QueuedAnswers } {
  const queued: QueuedAnswers = {};
  for (const c of calls.slice(1)) queued[c.key] = allow && !unticked.has(c.key) ? 'allow' : 'deny';
  return { decision: allow && !unticked.has(calls[0]!.key) ? 'allow' : 'deny', queued };
}
