// node --test desktop-tauri/src/ui/thread/menuPlace.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listPlace } from './menuPlace.ts';

const win = { width: 1000, height: 700 };

test('a list opens upwards from its button, fixed to the window so a scrolling dock cannot cut it off', () => {
  // The done card's Archive button: at the right, in a short dock near the bottom.
  const p = listPlace({ left: 880, right: 960, top: 590, bottom: 616 }, win, false);
  assert.equal(p.position, 'fixed');
  assert.equal(p.bottom, 700 - 590 + 6, 'its bottom edge sits a little above the button');
  assert.equal(p.top, 'auto');
  assert.equal(p.maxHeight, 340);
});

test('a button in the right half grows its list leftwards from its own right edge, so it stays inside the window', () => {
  const p = listPlace({ left: 880, right: 960, top: 590, bottom: 616 }, win, false);
  assert.equal(p.right, 1000 - 960);
  assert.equal(p.left, 'auto');
  const near = listPlace({ left: 20, right: 120, top: 590, bottom: 616 }, win, false);
  assert.equal(near.left, 20);
  assert.equal(near.right, 'auto');
  // Never closer than a few pixels to the edge.
  assert.equal(listPlace({ left: 2, right: 40, top: 590, bottom: 616 }, win, false).left, 8);
  assert.equal(listPlace({ left: 900, right: 999, top: 590, bottom: 616 }, win, false).right, 8);
});

test('a list that opens downwards hangs from the button, and one with little room shrinks to it but not below a usable height', () => {
  const down = listPlace({ left: 100, right: 180, top: 100, bottom: 126 }, win, true);
  assert.equal(down.top, 132);
  assert.equal(down.bottom, 'auto');
  assert.equal(down.maxHeight, 340);
  assert.equal(listPlace({ left: 100, right: 180, top: 250, bottom: 276 }, win, false).maxHeight, 236, 'the room above, less a margin');
  assert.equal(listPlace({ left: 100, right: 180, top: 40, bottom: 66 }, win, false).maxHeight, 120, 'but never a sliver');
});
