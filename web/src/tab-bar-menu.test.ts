// node --test web/src/tab-bar-menu.test.ts
//
// On a phone the rail lies down as the tab bar, and the More menu opens upwards
// from it. The menu used to be pinned to the screen (position: fixed; bottom:
// 62px), a guess at the bar's height. The bar is taller than that wherever the
// phone has a bottom inset (the home bar on an iPhone, the navigation bar on
// Android, which the page is drawn behind), so the menu sat over the bar's icons.
// The menu now hangs off the bar's own top edge, so it follows the bar's height.
//
// These read the stylesheet as text (there is no layout engine here), so they
// hold how the menu is placed, not where a browser puts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Comments out first, so a note about a rule is never taken for the rule.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// The text between the braces of the first `@media <query> {`.
function mediaBlock(query: string): string {
  const start = css.indexOf(`@media ${query} {`);
  assert.ok(start >= 0, `an @media ${query} block`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, i);
  }
  throw new Error(`@media ${query} is never closed`);
}

// The declarations of every rule in `scope` whose selector is exactly `selector`,
// as a property to value map (a later declaration of a property wins, as in CSS).
function rule(scope: string, selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of scope.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.trim() !== selector) continue;
    for (const decl of m[2]!.split(';')) {
      const colon = decl.indexOf(':');
      if (colon > 0) out.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
    }
  }
  return out;
}

const phone = mediaBlock('(max-width: 760px)');

test('the More menu is not pinned to the screen', () => {
  const panel = rule(phone, '.rail .pop-panel');
  assert.ok(panel.size > 0, 'the phone layout places the menu');
  // Fixed puts it relative to the screen, which knows nothing of the bar's height.
  assert.notEqual(panel.get('position'), 'fixed');
});

test('the More menu does not sit a set number of pixels off the screen edge', () => {
  const bottom = rule(phone, '.rail .pop-panel').get('bottom');
  assert.ok(bottom, 'the menu is placed from the bottom');
  // A bare length is a guess at the bar's height, wrong as soon as the inset changes.
  assert.doesNotMatch(bottom, /^-?[\d.]+(px|rem|em)?$/, `bottom: ${bottom} is a fixed gap`);
});

test('the More menu opens from the top edge of the tab bar', () => {
  // bottom: calc(100% + gap) is the gap above the bar, if the bar is what the
  // percentage is of: the menu's containing block.
  assert.match(rule(phone, '.rail .pop-panel').get('bottom') ?? '', /^calc\(100% \+ \d+px\)$/);
  assert.equal(rule(phone, '.rail').get('position'), 'relative', 'the bar is the containing block');
  // The button wrapping the menu is positioned for the header's menus; left so, the
  // percentage would be of the small More button and the menu would sit on it.
  assert.equal(rule(phone, '.rail .pop').get('position'), 'static', 'the More button is not');
});

test('the More menu stays on a short screen', () => {
  // Grown from the bar's top edge, a tall menu on a short screen (a phone turned
  // on its side) would run off the top, so it scrolls within what is above the bar.
  const panel = rule(phone, '.rail .pop-panel');
  assert.match(panel.get('max-height') ?? '', /100%/, 'its height is capped by the space above the bar');
  assert.equal(panel.get('overflow-y'), 'auto');
});

test('the side rail on a wide screen keeps its menu beside the gear', () => {
  // The stylesheet without the phone block, whose rules would win in rule()'s map.
  const wide = rule(css.replace(phone, ''), '.rail .pop-panel');
  assert.equal(wide.get('left'), 'calc(100% + 8px)');
  assert.equal(wide.get('bottom'), '0');
  assert.equal(wide.get('position'), undefined, 'the wide menu is absolute from .pop-panel, to the button');
});
