import { test } from 'node:test';
import assert from 'node:assert/strict';
import { empty, firstSeq, hasMore, nextBefore, pictures, rows, takeLive, takeOlder, type History } from './share-history.ts';

type R = { seq: number };
type P = { seq: number; url: string };
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const page = (a: number, b: number, more: boolean, pics: number[] = []) => ({
  messages: range(a, b).map((seq) => ({ seq })),
  images: pics.map((seq) => ({ seq, url: `https://x/${seq}.png` })),
  hasMore: more,
});
const seqs = (h: History<R, P>) => rows(h).map((m) => m.seq);

// The live page never grows: a bigger one would be read again on every new
// row (37.6 MB of Convex I/O in a day on the phone, 8 Nov).
test('load earlier reads a chunk before the shown rows, never a bigger live page', () => {
  assert.equal(nextBefore(empty<R, P>()), undefined);
  assert.equal(nextBefore(takeLive(empty<R, P>(), page(601, 1000, true))), 601);
  assert.equal(nextBefore(takeLive(empty<R, P>(), page(1, 400, false))), undefined);
});

test('chunks go above the live page until the start', () => {
  let h = takeLive(empty<R, P>(), page(7101, 7500, true));
  h = takeOlder(h, page(6901, 7100, true, [6910]), 7101)!;
  assert.deepEqual(seqs(h), range(6901, 7500));
  assert.equal(nextBefore(h), 6901);
  h = takeOlder(h, page(1, 6900, false), 6901)!;
  assert.equal(rows(h).length, 7500);
  assert.equal(hasMore(h), false);
  assert.equal(nextBefore(h), undefined);
  assert.deepEqual(pictures(h).map((p) => p.seq), [6910]);
});

test('rows that slide off the live page stay, before and after a chunk', () => {
  let h = takeLive(empty<R, P>(), page(601, 1000, true, [601]));
  h = takeLive(h, page(603, 1002, true));
  assert.equal(firstSeq(h), 601);
  assert.deepEqual(seqs(h), range(601, 1002));
  h = takeOlder(h, page(401, 600, true), 601)!;
  h = takeLive(h, page(604, 1003, true));
  assert.deepEqual(seqs(h), range(401, 1003));
  assert.deepEqual(pictures(h).map((p) => p.seq), [601]);
});

test('no overlap with the answer before starts again from the newest', () => {
  let h = takeLive(empty<R, P>(), page(601, 1000, true));
  h = takeOlder(h, page(401, 600, true), 601)!;
  h = takeLive(h, page(1101, 1500, true));
  assert.deepEqual(seqs(h), range(1101, 1500));
  assert.equal(nextBefore(h), 1101);
});

test('a live page reaching further back takes its rows back from the chunks', () => {
  let h = takeLive(empty<R, P>(), page(601, 1000, true, [605]));
  h = takeLive(h, page(611, 1010, true));
  h = takeLive(h, page(590, 1010, true, [605]));
  assert.deepEqual(seqs(h), range(590, 1010));
  assert.deepEqual(pictures(h).map((p) => p.seq), [605]);
});

test('a chunk that comes too late is dropped', () => {
  let h = takeLive(empty<R, P>(), page(601, 1000, true));
  h = takeOlder(h, page(401, 600, true), 601)!;
  assert.equal(takeOlder(h, page(401, 600, true), 601), undefined);
});
