// node --test web/src/safe-area.test.ts
//
// The Android app draws the page edge to edge, behind the status bar, and the
// WebView reports how much of the top the bar covers as env(safe-area-inset-top).
// Nothing laid the page out below it, so the clock sat on the search box. These
// read the stylesheet as text (there is no layout engine here), so they hold that
// the page asks for the insets, once, and not that a WebView hands them over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
// Comments out first, so a note about a rule is never taken for the rule.
const css = read('./styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
const html = read('../index.html');

// A rule that starts a line is at the top level of the file (the ones inside
// @media are indented), and `#root {` on its own is not `html, body, #root {`.
const root = /(?:^|\n)#root\s*\{([^}]*)\}/.exec(css)?.[1];

test('the page opts in to the insets the app is drawn under', () => {
  assert.match(html, /<meta name="viewport"[^>]*viewport-fit=cover/);
});

test('#root keeps clear of the status bar and the sides, for every screen', () => {
  assert.ok(root, 'a top-level #root rule');
  for (const side of ['top', 'right', 'left']) {
    assert.ok(root.includes(`env(safe-area-inset-${side}`), `#root pads by env(safe-area-inset-${side})`);
  }
});

test('the bottom inset is left to the tab bar and the composer', () => {
  // They pad it themselves (the tab bar, and the composer: narrow-screen.test.ts holds
  // how), so #root taking it as well would leave the bottom of the page with double.
  assert.ok(root, 'a top-level #root rule');
  assert.ok(!root.includes('safe-area-inset-bottom'), '#root does not pad the bottom');
  assert.ok(css.includes('safe-area-inset-bottom'), 'the tab bar and the composer still pad the bottom');
});

test('the top inset is taken once', () => {
  // Used anywhere else as well, a screen would be pushed down twice.
  assert.equal(css.match(/safe-area-inset-top/g)?.length, 1);
});
