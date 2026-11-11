// node --test web/src/popover.test.ts
//
// A panel hung off a button ran off the screen: the share panel is anchored to the
// share button's right edge, which is 48 px in from the screen's, and was as wide as
// the screen less 24 px, so on a 360 px phone it began 24 px left of the screen and
// its first letters were cut off. popoverShift says how far to slide a panel back in.
// It is pure; menu.tsx measures the panel and the screen and applies what it says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { popoverShift } from './popover.ts';

const phone = { left: 0, right: 360 };

test('a panel that is inside the screen is left where it is', () => {
  assert.equal(popoverShift({ left: 20, right: 300 }, phone), 0);
  assert.equal(popoverShift({ left: 150, right: 350 }, phone), 0);
});

test('a panel on the margin is inside it', () => {
  assert.equal(popoverShift({ left: 8, right: 352 }, phone), 0);
});

test('the share panel on a 360 px phone: from 24 px off the left, back to the margin', () => {
  // 336 wide, ending at the share button's right edge (360 - 10 - 30 - 8 = 312).
  assert.equal(popoverShift({ left: -24, right: 312 }, phone), 32);
});

test('a panel past the left edge comes in by exactly what is past the margin', () => {
  assert.equal(popoverShift({ left: -100, right: 100 }, phone), 108);
  assert.equal(popoverShift({ left: 3, right: 200 }, phone), 5);
});

test('a panel past the right edge goes back by what is past the margin', () => {
  assert.equal(popoverShift({ left: 100, right: 400 }, phone), -48);
  assert.equal(popoverShift({ left: 60, right: 357 }, phone), -5);
});

test('a panel wider than the room starts at the left margin, so the first words can be read', () => {
  // 400 wide on a 360 px screen cannot fit; its start matters more than its end.
  assert.equal(popoverShift({ left: -20, right: 380 }, phone), 28);
  assert.equal(popoverShift({ left: 50, right: 450 }, phone), -42);
});

test('the room is the screen less the margin each side, and it is the same width as the panel when it just fits', () => {
  // 344 is exactly 360 less 2 * 8.
  assert.equal(popoverShift({ left: -4, right: 340 }, phone), 12);
  assert.equal(popoverShift({ left: 20, right: 364 }, phone), -12);
});

test('the room is what the page leaves clear: a cutout or a navigation bar at the side is not the screen', () => {
  // Landscape with the navigation bar on the right 48 px: the page's room is 0 to 732.
  const landscape = { left: 0, right: 732 };
  assert.equal(popoverShift({ left: 400, right: 770 }, landscape), -46);
  // A cutout on the left of 40 px: it begins at 40.
  assert.equal(popoverShift({ left: 10, right: 200 }, { left: 40, right: 800 }), 38);
});

test('the margin can be set', () => {
  assert.equal(popoverShift({ left: 2, right: 200 }, phone, 16), 14);
  assert.equal(popoverShift({ left: 2, right: 200 }, phone, 0), 0);
});

test('no shift is ever negative zero', () => {
  assert.ok(Object.is(popoverShift({ left: 8, right: 100 }, phone), 0));
  assert.ok(Object.is(popoverShift({ left: 100, right: 352 }, phone), 0));
});

// There is one hook for this, and the share panel (which is not a Pop) uses it too:
// a clamp in Pop alone would not have helped the panel the report was about.
const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

test('Pop and the share panel keep themselves on the screen through the same hook', () => {
  const menu = read('./menu.tsx');
  const share = read('./share.tsx');
  assert.match(menu, /export function usePopover\(/);
  assert.match(menu, /popoverShift\(/, 'the hook asks the helper');
  assert.match(menu, /<details className="pop" ref=\{ref\}/, 'Pop is a details the hook holds');
  assert.match(share, /usePopover\(/);
  assert.match(share, /<details className="pop" ref=\{ref\}/, 'ShareControl is a details the hook holds');
});

test('the hook fits the panel when it opens and when the screen changes', () => {
  const menu = read('./menu.tsx');
  assert.match(menu, /useLayoutEffect\(/, 'before the first paint');
  assert.match(menu, /new MutationObserver\(/, 'on opening, which changes the open attribute');
  assert.match(menu, /new ResizeObserver\(/, 'and when the panel changes size');
  assert.match(menu, /addEventListener\(type, fit\)/, 'on resize and turning the phone');
  assert.match(menu, /'orientationchange'/);
  assert.match(menu, /'resize'/);
});
