// node --test web/src/narrow-screen.test.ts
//
// What the Android app showed on a real phone (360 px wide, dark, 3 button navigation):
//  - the share panel ran off the left edge, its first letters cut off, and a long path
//    or one long word in a card, a recap or the transcript pushed the page sideways;
//  - the reply box sat flush on the navigation bar with the keyboard down, and a gap
//    above the keyboard with it up.
//
// These read the stylesheet as text (there is no layout engine here), so they hold the
// rules that cure it, not where a WebView puts anything. The layout was measured by
// loading the real page and stylesheet in a browser at 320, 360, 412 and 780 px wide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Comments out first, so a note about a rule is never taken for the rule.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// The text between the braces of the block whose `{` is at `start` in `text`.
function body(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(start + 1, i);
  }
  throw new Error('a block is never closed');
}

// The text between the braces of the first `@media <query> {`.
function mediaBlock(query: string): string {
  const start = css.indexOf(`@media ${query} {`);
  assert.ok(start >= 0, `an @media ${query} block`);
  return body(css, css.indexOf('{', start));
}

// The stylesheet with every @media block taken out: only what holds at any size.
function everywhere(): string {
  let out = css;
  for (let at = out.indexOf('@media'); at >= 0; at = out.indexOf('@media')) {
    const open = out.indexOf('{', at);
    out = out.slice(0, at) + out.slice(open + body(out, open).length + 2);
  }
  return out;
}

// The declarations of every rule in `scope` whose selector is exactly `selector`, as a
// property to value map (a later declaration of a property wins, as in CSS).
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
const wide = mediaBlock('(min-width: 761px)');
const short = mediaBlock('(max-height: 520px)');
const anywhere = everywhere();

// ---- the share panel, and every other menu panel

test('a menu panel is never wider than the screen, and takes the shift menu.tsx works out', () => {
  const panel = rule(anywhere, '.pop-panel');
  // The sides are what a cutout or a navigation bar at the side of a landscape phone takes.
  const room = panel.get('max-width') ?? '';
  assert.match(room, /^calc\(100vw - 16px/, 'the screen less 8px each side');
  assert.match(room, /safe-area-inset-left/);
  assert.match(room, /safe-area-inset-right/);
  assert.match(panel.get('transform') ?? '', /^translateX\(var\(--pop-shift, 0px\)\)$/);
});

test('the share panel is not given a width of its own guess at the room on a phone', () => {
  // min(370px, 100vw - 24px) assumed the panel ended 12px from the screen's edge. It ends
  // at the share button's edge, 48px in. The panel's own max-width and the shift do it now.
  assert.equal(rule(phone, '.share-panel').get('width'), undefined);
  assert.equal(rule(anywhere, '.share-panel').get('width'), '370px');
});

test('the share panel scrolls inside itself when the screen is short', () => {
  const panel = rule(anywhere, '.share-panel');
  // The dynamic height follows the keyboard, and the inset is the bar under the page.
  assert.match(panel.get('max-height') ?? '', /^calc\(100dvh - \d+px - env\(safe-area-inset-bottom, 0px\)\)$/);
  assert.equal(panel.get('overflow-y'), 'auto');
  assert.equal(panel.get('overscroll-behavior'), 'contain');
});

test('the Filter and Sort menus keep to a short screen, and clear a bar under the page', () => {
  assert.match(rule(short, '.menu-scroll').get('max-height') ?? '', /^min\(280px, calc\(30vh - env\(safe-area-inset-bottom, 0px\)\)\)$/);
});

test('the gear menu beside the rail scrolls within the room above the gear, as the More menu does on a phone', () => {
  // It grows up from the gear at the foot of the rail, and a taller menu (the problem line
  // under Notifications) ran over the top of a short screen.
  const panel = rule(anywhere, '.rail .pop-panel');
  assert.match(panel.get('max-height') ?? '', /^calc\(100vh - \d+px - env\(safe-area-inset-bottom, 0px\)\)$/);
  assert.equal(panel.get('overflow-y'), 'auto');
  assert.equal(panel.get('overscroll-behavior'), 'contain');
});

test('the link icon in the share button has a size, as the share icon has', () => {
  // A direct-child rule (.share-btn > svg) missed the icon inside .narrow-only, which then
  // drew 0 by 0 and left an empty box once a thread was shared.
  const icon = rule(anywhere, '.share-btn svg');
  assert.equal(icon.get('width'), '15px');
  assert.equal(icon.get('height'), '15px');
  assert.equal(rule(anywhere, '.share-btn > svg').size, 0);
});

// ---- the reply box

test('on a phone the reply box has a gap above the bar: the gap plus the inset, not the larger of the two', () => {
  const padding = rule(phone, '.dock').get('padding') ?? '';
  // max(10px, inset) is the inset as soon as it is 10px or more: the box ends on the bar.
  assert.doesNotMatch(padding, /max\(/);
  assert.equal(padding, '6px 10px calc(10px + env(safe-area-inset-bottom, 0px))');
});

test('the wide layout clears a bar under the page as well, by the same gap it had', () => {
  assert.equal(rule(anywhere, '.dock').get('padding'), '6px 24px calc(18px + env(safe-area-inset-bottom, 0px))');
});

test('the rest of the wide layout clears a bar under the page, and the phone does not pad twice', () => {
  // On a phone the tab bar under the list pads the inset, so the list must not.
  assert.equal(rule(anywhere, '.rail').get('padding'), '10px 0 calc(10px + env(safe-area-inset-bottom, 0px))');
  assert.equal(rule(anywhere, '.lists').get('padding'), '0 8px 12px');
  assert.equal(rule(wide, '.lists').get('padding'), '0 8px calc(12px + env(safe-area-inset-bottom, 0px))');
  assert.equal(rule(anywhere, '.page-body').get('padding'), '22px 24px calc(32px + env(safe-area-inset-bottom, 0px))');
});

test('the pages that fill a phone end clear of the bar, and so does the pairing screen', () => {
  assert.equal(rule(phone, '.page-body').get('padding'), '16px 14px calc(24px + env(safe-area-inset-bottom, 0px))');
  assert.match(rule(anywhere, '.signin').get('padding') ?? '', /calc\(24px \+ env\(safe-area-inset-bottom, 0px\)\)$/);
});

test('the tab bar and the composer still take the bottom inset, and #root still does not', () => {
  const root = /(?:^|\n)#root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.ok(!root.includes('safe-area-inset-bottom'));
  assert.match(rule(phone, '.rail').get('padding') ?? '', /env\(safe-area-inset-bottom/);
});

// ---- one long word is not wider than the screen

test('text that cannot break is broken, not left to run off the screen or widen the page', () => {
  // A Windows path, a URL or a long tool name has nowhere to wrap, and the box holding it
  // grew past the screen (the page scrolled sideways) or clipped it with no way to read it.
  for (const selector of ['.messages', '.card', '.recap', '.command', '.signin', '.doc', '.turns-list', '.share-panel']) {
    assert.equal(rule(anywhere, selector).get('overflow-wrap'), 'anywhere', `${selector} breaks long words`);
  }
});

test('the link buttons of a card of asks wrap their words', () => {
  const button = rule(anywhere, '.ask-links .btn');
  assert.equal(button.get('white-space'), 'normal');
  assert.equal(button.get('text-align'), 'left');
});

test('a long folder name in the header leaves the thread title room', () => {
  // The label took what it wanted (flex: none) and the title was squeezed to nothing.
  const folder = rule(anywhere, '.crumbs .folder');
  assert.equal(folder.get('max-width'), '40%');
  assert.equal(folder.get('overflow'), 'hidden');
  assert.equal(folder.get('text-overflow'), 'ellipsis');
});

// ---- a short screen: a phone on its side, or with the keyboard up

test('the cards, the reply and the recap leave room for the transcript on a short screen', () => {
  assert.match(rule(short, '.card').get('max-height') ?? '', /vh$/);
  assert.match(rule(short, '.composer textarea').get('max-height') ?? '', /vh$/);
  assert.match(rule(short, '.recap').get('max-height') ?? '', /vh$/);
  assert.equal(rule(short, '.recap').get('overflow-y'), 'auto');
});
