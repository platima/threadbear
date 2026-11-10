// node --test desktop-tauri/src/core/terminal-font.test.ts
//
// Which font the Terminal draws in: the three choices, the stack of font names it hands the
// page, the size, and how a choice is kept. Nothing here reads a file or the page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SIZE, FALLBACK_FACES, FONT_KEY, fontChoice, fontLabel, fontStack, parseFontChoice, pointsToPixels, resolveFont, serialiseFontChoice, setFontChoice, typedFontName } from './terminal-font.ts';

const FALLBACKS = "'CaskaydiaCove Nerd Font Mono', 'CaskaydiaCove NF', 'MesloLGM Nerd Font Mono', 'MesloLGS NF', 'JetBrainsMono Nerd Font Mono', 'FiraCode Nerd Font Mono', 'Hack Nerd Font Mono', 'Symbols Nerd Font Mono', 'Symbols Nerd Font', 'Cascadia Mono', 'Cascadia Code', 'Consolas', 'Liberation Mono', 'Menlo', 'Courier New', monospace";

test('the stack: the chosen face in quotes, the Nerd Fonts and ordinary monospace fonts after it, then monospace', () => {
  assert.equal(fontStack('Iosevka Term'), `'Iosevka Term', ${FALLBACKS}`);
  assert.equal(fontStack(), FALLBACKS);
  assert.equal(fontStack(undefined), FALLBACKS);
});

test('the Nerd Fonts are named before the plain ones, which a private use glyph needs', () => {
  const at = (name: string) => FALLBACK_FACES.indexOf(name);
  for (const nerd of ['CaskaydiaCove Nerd Font Mono', 'CaskaydiaCove NF', 'MesloLGM Nerd Font Mono', 'MesloLGS NF', 'JetBrainsMono Nerd Font Mono', 'FiraCode Nerd Font Mono', 'Hack Nerd Font Mono']) {
    assert.ok(at(nerd) >= 0 && at(nerd) < at('Cascadia Mono'), nerd);
  }
  assert.ok(at('Consolas') > at('Cascadia Code'));
  assert.ok(at('Courier New') > at('Consolas'));
});

test('a face that is already a fallback is not named twice, whatever its case', () => {
  assert.equal(fontStack('Cascadia Code'), `'Cascadia Code', ${FALLBACKS.replace("'Cascadia Code', ", '')}`);
  assert.equal(fontStack('caskaydiacove nf').match(/caskaydiacove nf/gi)?.length, 1);
  assert.equal(fontStack('CaskaydiaCove NF').split("'CaskaydiaCove NF'").length, 2);
});

test("every face in a list is in the stack, in the person's order, ahead of the fallbacks", () => {
  const stack = fontStack(['Iosevka Term', 'Symbols Nerd Font Mono']);
  assert.ok(stack.startsWith("'Iosevka Term', 'Symbols Nerd Font Mono', 'CaskaydiaCove Nerd Font Mono', "), stack);
  assert.equal(stack.split("'Symbols Nerd Font Mono'").length, 2, 'named once');
  // A list as text, as Windows Terminal writes it, is the same list.
  assert.equal(fontStack('Iosevka Term, Symbols Nerd Font Mono'), stack);
  // A name the person lists that is not plain is left out and the rest are kept.
  assert.equal(fontStack(['Iosevka Term', 'a"; }', 'Symbols Nerd Font Mono']), stack);
});

test('Symbols Nerd Font is among the fallbacks, for a person whose only Nerd Font is that one', () => {
  assert.ok(FALLBACK_FACES.includes('Symbols Nerd Font Mono'));
  assert.ok(FALLBACK_FACES.indexOf('Symbols Nerd Font Mono') < FALLBACK_FACES.indexOf('Cascadia Mono'));
});

test('a face that is not a plain name never reaches the stack', () => {
  for (const hostile of ['x\'; } body { display: none } a { font-family: \'y', 'a"b', 'a\\b', 'a\nb', 'a;b', '</style>', '']) {
    assert.equal(fontStack(hostile), FALLBACKS, JSON.stringify(hostile));
  }
});

test("Windows Terminal's points are 4/3 pixels, in halves, held between 8 and 32", () => {
  assert.equal(pointsToPixels(12), 16);
  assert.equal(pointsToPixels(9), 12);
  assert.equal(pointsToPixels(10.5), 14);
  assert.equal(pointsToPixels(11), 14.5);
  assert.equal(pointsToPixels(4), 8);
  assert.equal(pointsToPixels(5), 8);
  assert.equal(pointsToPixels(30), 32);
  assert.equal(pointsToPixels(96), 32);
});

test('same as Windows Terminal: its face and its size', () => {
  const r = resolveFont({ kind: 'wt' }, { face: 'CaskaydiaCove Nerd Font Mono', size: 11 });
  assert.deepEqual(r, { family: fontStack('CaskaydiaCove Nerd Font Mono'), size: 14.5, kind: 'wt', face: 'CaskaydiaCove Nerd Font Mono' });
  assert.equal(r.family, FALLBACKS, 'a face that is the first fallback anyway is named once');
  const other = resolveFont({ kind: 'wt' }, { face: 'Iosevka Term NF', size: 12 });
  assert.ok(other.family.startsWith("'Iosevka Term NF', 'CaskaydiaCove Nerd Font Mono', "));
});

test("same as Windows Terminal with several faces draws in all of them, and the label names the first", () => {
  const found = { face: 'Cascadia Code', faces: ['Cascadia Code', 'Symbols Nerd Font Mono'], size: 12 };
  const r = resolveFont({ kind: 'wt' }, found);
  assert.equal(r.face, 'Cascadia Code');
  assert.ok(r.family.startsWith("'Cascadia Code', 'Symbols Nerd Font Mono', "), r.family);
  assert.equal(r.size, 16);
  assert.equal(fontLabel(r), 'Font: Cascadia Code');
  // The list is checked here as well as in the bridge, and a face alone still works (an older bridge).
  assert.ok(resolveFont({ kind: 'wt' }, { ...found, faces: ['Cascadia Code', 'x"; }', 'Symbols Nerd Font Mono'] }).family.startsWith("'Cascadia Code', 'Symbols Nerd Font Mono', "));
  assert.equal(resolveFont({ kind: 'wt' }, { face: 'Cascadia Code' }).family, fontStack('Cascadia Code'));
  assert.equal(resolveFont({ kind: 'wt' }, { face: 'Cascadia Code', faces: [] }).family, fontStack('Cascadia Code'));
});

test('same as Windows Terminal with no size set there keeps the usual size', () => {
  assert.equal(resolveFont({ kind: 'wt' }, { face: 'MesloLGS NF' }).size, DEFAULT_SIZE);
  for (const size of [0, -3, NaN, Infinity]) assert.equal(resolveFont({ kind: 'wt' }, { face: 'MesloLGS NF', size }).size, DEFAULT_SIZE, String(size));
});

test("nothing chosen follows Windows Terminal when the bridge found a font, and is the default otherwise", () => {
  assert.equal(resolveFont(undefined, { face: 'Fira Code', size: 10 }).kind, 'wt');
  assert.equal(resolveFont(undefined, { face: 'Fira Code', size: 10 }).face, 'Fira Code');
  assert.deepEqual(resolveFont(undefined, undefined), { family: fontStack(), size: DEFAULT_SIZE, kind: 'default' });
  assert.deepEqual(resolveFont(undefined, {}), { family: fontStack(), size: DEFAULT_SIZE, kind: 'default' });
  assert.deepEqual(resolveFont(undefined, { size: 12 }), { family: fontStack(), size: DEFAULT_SIZE, kind: 'default' }, 'a size alone is not a font');
});

test('default is the default stack and size, whatever Windows Terminal has', () => {
  assert.deepEqual(resolveFont({ kind: 'default' }, { face: 'Fira Code', size: 14 }), { family: fontStack(), size: DEFAULT_SIZE, kind: 'default' });
});

test("a name typed by the person is used with the usual size, not Windows Terminal's", () => {
  const r = resolveFont({ kind: 'custom', name: 'Iosevka Term' }, { face: 'Fira Code', size: 14 });
  assert.deepEqual(r, { family: fontStack('Iosevka Term'), size: DEFAULT_SIZE, kind: 'custom', face: 'Iosevka Term' });
  assert.equal(resolveFont({ kind: 'custom', name: 'Iosevka Term' }, undefined).face, 'Iosevka Term', 'on a system with no Windows Terminal');
});

test('a list typed by the person is used whole, as Windows Terminal takes one', () => {
  const r = resolveFont({ kind: 'custom', name: 'Cascadia Code, Symbols Nerd Font Mono' }, undefined);
  assert.equal(r.face, 'Cascadia Code');
  assert.equal(r.size, DEFAULT_SIZE);
  assert.ok(r.family.startsWith("'Cascadia Code', 'Symbols Nerd Font Mono', "), r.family);
});

test('what is typed in the name box: the usable names, and whether that is bad or a change', () => {
  assert.deepEqual(typedFontName('  Fira   Code ', ''), { name: 'Fira Code', bad: false, changed: true });
  assert.deepEqual(typedFontName('Fira Code', 'Fira Code'), { name: 'Fira Code', bad: false, changed: false });
  assert.deepEqual(typedFontName('Cascadia Code,Symbols Nerd Font Mono', 'Cascadia Code'), { name: 'Cascadia Code, Symbols Nerd Font Mono', bad: false, changed: true });
  assert.deepEqual(typedFontName('Cascadia Code, a"; }, Cascadia Code', ''), { name: 'Cascadia Code', bad: false, changed: true }, 'the unusable one and the repeat go');
  assert.deepEqual(typedFontName('', 'Fira Code'), { name: '', bad: false, changed: true }, 'emptied: not bad, and a change');
  assert.deepEqual(typedFontName('   ', ''), { name: '', bad: false, changed: false });
  assert.deepEqual(typedFontName('a"; }', 'Fira Code'), { name: '', bad: true, changed: true });
  // Escape puts the old name back before the box blurs, so what the blur commits is no change.
  assert.deepEqual(typedFontName('Fira Code', 'Fira Code'), { name: 'Fira Code', bad: false, changed: false });
});

test('a typed name with nothing in it, or nothing usable, is the default stack, said so', () => {
  assert.deepEqual(resolveFont({ kind: 'custom', name: '' }, undefined), { family: fontStack(), size: DEFAULT_SIZE, kind: 'custom', problem: undefined });
  const bad = resolveFont({ kind: 'custom', name: 'a"; }' }, undefined);
  assert.equal(bad.family, fontStack());
  assert.match(bad.problem!, /isn't a font name/);
});

test('same as Windows Terminal chosen, and then no font there: the default, said so', () => {
  const r = resolveFont({ kind: 'wt' }, undefined);
  assert.equal(r.family, fontStack());
  assert.equal(r.kind, 'default');
  assert.match(r.problem!, /No font is set in Windows Terminal/);
  assert.equal(resolveFont({ kind: 'wt' }, { size: 12 }).kind, 'default');
});

test("a face from the bridge that is not a plain name is not used, though it is sent", () => {
  const r = resolveFont({ kind: 'wt' }, { face: "x'; } a { color: red", size: 12 });
  assert.equal(r.kind, 'default');
  assert.equal(r.family, fontStack());
});

test('the button says which font is in use', () => {
  assert.equal(fontLabel(resolveFont(undefined, { face: 'CaskaydiaCove NF' })), 'Font: CaskaydiaCove NF');
  assert.equal(fontLabel(resolveFont({ kind: 'default' }, { face: 'CaskaydiaCove NF' })), 'Font: Default');
  assert.equal(fontLabel(resolveFont({ kind: 'custom', name: 'Iosevka' }, undefined)), 'Font: Iosevka');
  assert.equal(fontLabel(resolveFont({ kind: 'custom', name: '' }, undefined)), 'Font: Default');
});

test('a choice is kept as text and read back', () => {
  for (const c of [{ kind: 'wt' }, { kind: 'default' }, { kind: 'custom', name: 'Fira Code' }, { kind: 'custom', name: '' }] as const) {
    assert.deepEqual(parseFontChoice(serialiseFontChoice(c)), c);
  }
  assert.equal(serialiseFontChoice({ kind: 'custom', name: 'Fira Code' }), 'custom:Fira Code');
});

test('nothing stored, or something that is not a choice, is no choice made', () => {
  for (const v of [undefined, null, '', 'auto', 'WT', 'custom', 'Fira Code', '{"kind":"wt"}', ' wt']) assert.equal(parseFontChoice(v), undefined, String(v));
});

test('a stored name that fails the check comes back as a name not yet typed', () => {
  assert.deepEqual(parseFontChoice('custom:a"; } b'), { kind: 'custom', name: '' });
  assert.deepEqual(parseFontChoice(`custom:${'x'.repeat(500)}`), { kind: 'custom', name: '' });
});

test("the choice is kept under threadbear.terminalFont, and a window that can't keep it says so", () => {
  const kept: Record<string, string> = {};
  const store = { getItem: (k: string) => kept[k] ?? null, setItem: (k: string, v: string) => void (kept[k] = v) };
  assert.equal(fontChoice(store), undefined);
  assert.equal(setFontChoice({ kind: 'custom', name: 'Iosevka Term' }, store), true);
  assert.equal(kept[FONT_KEY], 'custom:Iosevka Term');
  assert.equal(FONT_KEY, 'threadbear.terminalFont');
  assert.deepEqual(fontChoice(store), { kind: 'custom', name: 'Iosevka Term' });
  assert.equal(setFontChoice({ kind: 'wt' }, { getItem: () => null, setItem: () => {} }), false, 'a store that forgets');
  assert.equal(setFontChoice({ kind: 'wt' }, { getItem: () => null, setItem: () => { throw new Error('blocked'); } }), false);
  assert.equal(setFontChoice({ kind: 'wt' }, undefined), false);
  assert.equal(fontChoice({ getItem: () => { throw new Error('blocked'); }, setItem: () => {} }), undefined);
});
