// node --test desktop-tauri/src/core/terminal-font.test.ts
//
// Which font the Terminal draws in: the three choices, the stack of font names it hands the
// page, the size, and how a choice is kept. Nothing here reads a file or the page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SIZE, FALLBACK_FACES, FONT_KEY, fontChoice, fontDraft, fontLabel, fontStack, parseFontChoice, pointsToPixels, resolveFont, serialiseFontChoice, setFontChoice, typedFontName } from './terminal-font.ts';

const PLAIN = "'Cascadia Mono', 'Cascadia Code', 'Consolas', 'Liberation Mono', 'Menlo', 'Courier New'";
const NERD = "'CaskaydiaCove Nerd Font Mono', 'CaskaydiaCove NF', 'MesloLGM Nerd Font Mono', 'MesloLGS NF', 'JetBrainsMono Nerd Font Mono', 'FiraCode Nerd Font Mono', 'Hack Nerd Font Mono', 'Symbols Nerd Font Mono', 'Symbols Nerd Font'";
const FALLBACKS = `${PLAIN}, ${NERD}, monospace`;

test('the stack: the chosen face in quotes, the ordinary monospace fonts after it, then the Nerd Fonts, then monospace', () => {
  assert.equal(fontStack('Iosevka Term'), `'Iosevka Term', ${FALLBACKS}`);
  assert.equal(fontStack(), FALLBACKS);
  assert.equal(fontStack(undefined), FALLBACKS);
});

test('the ordinary monospace fonts come before every Nerd Font, so the text is not drawn in one by default', () => {
  const at = (name: string) => FALLBACK_FACES.indexOf(name);
  const plain = ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'Liberation Mono', 'Menlo', 'Courier New'];
  const nerd = ['CaskaydiaCove Nerd Font Mono', 'CaskaydiaCove NF', 'MesloLGM Nerd Font Mono', 'MesloLGS NF', 'JetBrainsMono Nerd Font Mono', 'FiraCode Nerd Font Mono', 'Hack Nerd Font Mono', 'Symbols Nerd Font Mono', 'Symbols Nerd Font'];
  for (const p of plain) for (const n of nerd) assert.ok(at(p) >= 0 && at(n) > at(p), `${p} before ${n}`);
  // The generic family is last of all, so a glyph none of them has still gets the system's own monospace font.
  assert.ok(fontStack().endsWith(', monospace'));
  assert.equal(FALLBACK_FACES.length, plain.length + nerd.length);
  assert.ok(at('Consolas') > at('Cascadia Code'));
  assert.ok(at('Courier New') > at('Consolas'));
});

test('a face that is already a fallback is not named twice, whatever its case, and keeps the place the person gave it', () => {
  assert.equal(fontStack('Cascadia Code'), `'Cascadia Code', ${FALLBACKS.replace("'Cascadia Code', ", '')}`);
  assert.equal(fontStack('caskaydiacove nf').match(/caskaydiacove nf/gi)?.length, 1);
  assert.equal(fontStack('CaskaydiaCove NF').split("'CaskaydiaCove NF'").length, 2);
  // A Nerd Font the person chose leads the stack, as it is theirs; the same one is not repeated further on.
  assert.ok(fontStack('CaskaydiaCove NF').startsWith("'CaskaydiaCove NF', 'Cascadia Mono', "));
});

test("every face in a list is in the stack, in the person's order, ahead of the fallbacks", () => {
  const stack = fontStack(['Iosevka Term', 'Symbols Nerd Font Mono']);
  assert.ok(stack.startsWith("'Iosevka Term', 'Symbols Nerd Font Mono', 'Cascadia Mono', "), stack);
  assert.equal(stack.split("'Symbols Nerd Font Mono'").length, 2, 'named once');
  // A list as text, as Windows Terminal writes it, is the same list.
  assert.equal(fontStack('Iosevka Term, Symbols Nerd Font Mono'), stack);
  // A name the person lists that is not plain is left out and the rest are kept.
  assert.equal(fontStack(['Iosevka Term', 'a"; }', 'Symbols Nerd Font Mono']), stack);
});

test('Symbols Nerd Font is among the fallbacks, for a person whose only Nerd Font is that one', () => {
  assert.ok(FALLBACK_FACES.includes('Symbols Nerd Font Mono'));
  assert.ok(FALLBACK_FACES.includes('Symbols Nerd Font'));
  assert.ok(FALLBACK_FACES.indexOf('Symbols Nerd Font Mono') > FALLBACK_FACES.indexOf('Courier New'));
});

test('a face that is not a plain name never reaches the stack', () => {
  for (const hostile of ['x\'; } body { display: none } a { font-family: \'y', 'a"b', 'a\\b', 'a\nb', 'a;b', '</style>', '']) {
    assert.equal(fontStack(hostile), FALLBACKS, JSON.stringify(hostile));
  }
});

test('a name with a + or & in it, such as M+ 1m, is in the stack, in its quotes', () => {
  assert.equal(fontStack('M+ 1m'), `'M+ 1m', ${FALLBACKS}`);
  assert.equal(fontStack('Cascadia Code & Friends, M+ 1m').split(', ').slice(0, 4).join(', '), "'Cascadia Code & Friends', 'M+ 1m', 'Cascadia Mono', 'Cascadia Code'");
  assert.equal(resolveFont({ kind: 'custom', name: 'M+ 1m' }, undefined).face, 'M+ 1m');
  assert.equal(resolveFont({ kind: 'wt' }, { face: 'M+ 1m', size: 12 }).family, `'M+ 1m', ${FALLBACKS}`);
  // But a + or & does not let a name out of its quotes.
  assert.equal(fontStack("M+ 1m'; } a { color: red"), FALLBACKS);
  assert.equal(fontStack('a&b;'), FALLBACKS);
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
  assert.equal(r.family.split("'CaskaydiaCove Nerd Font Mono'").length, 2, 'a face that is a fallback anyway is named once');
  assert.ok(r.family.startsWith("'CaskaydiaCove Nerd Font Mono', 'Cascadia Mono', "), 'at the place the person has it');
  const other = resolveFont({ kind: 'wt' }, { face: 'Iosevka Term NF', size: 12 });
  assert.ok(other.family.startsWith("'Iosevka Term NF', 'Cascadia Mono', "));
});

test("same as Windows Terminal with several faces draws in all of them, and the label names the first", () => {
  const found = { face: 'Cascadia Code', faces: ['Cascadia Code', 'Symbols Nerd Font Mono'], size: 12 };
  const r = resolveFont({ kind: 'wt' }, found);
  assert.equal(r.face, 'Cascadia Code');
  assert.ok(r.family.startsWith("'Cascadia Code', 'Symbols Nerd Font Mono', 'Cascadia Mono', "), r.family);
  assert.equal(r.size, 16);
  assert.equal(fontLabel(r), 'Font: Cascadia Code');
  // The list is checked here as well as in the bridge, and a face alone still works (an older bridge).
  assert.ok(resolveFont({ kind: 'wt' }, { ...found, faces: ['Cascadia Code', 'x"; }', 'Symbols Nerd Font Mono'] }).family.startsWith("'Cascadia Code', 'Symbols Nerd Font Mono', 'Cascadia Mono', "));
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
  assert.ok(r.family.startsWith("'Cascadia Code', 'Symbols Nerd Font Mono', 'Cascadia Mono', "), r.family);
});

test('what is typed in the name box: the usable names, and whether that is bad or a change', () => {
  assert.deepEqual(typedFontName('  Fira   Code ', ''), { name: 'Fira Code', bad: false, changed: true });
  assert.deepEqual(typedFontName('Fira Code', 'Fira Code'), { name: 'Fira Code', bad: false, changed: false });
  assert.deepEqual(typedFontName('Cascadia Code,Symbols Nerd Font Mono', 'Cascadia Code'), { name: 'Cascadia Code, Symbols Nerd Font Mono', bad: false, changed: true });
  assert.deepEqual(typedFontName('Cascadia Code, a"; }, Cascadia Code', ''), { name: 'Cascadia Code', bad: false, changed: true }, 'the unusable one and the repeat go');
  assert.deepEqual(typedFontName('', 'Fira Code'), { name: '', bad: false, changed: true }, 'emptied: not bad, and a change');
  assert.deepEqual(typedFontName('   ', ''), { name: '', bad: false, changed: false });
  assert.deepEqual(typedFontName('a"; }', 'Fira Code'), { name: '', bad: true, changed: true });
});

// The name box cannot be driven here (no DOM), so what it does with the text is in fontDraft, and the
// box's handlers only call it. These play its sequences in the order the box's events come.
test('Escape in the name box: the edit is cancelled, and the blur that follows it commits nothing', () => {
  const drawn: string[] = [];
  const draft = fontDraft('Fira Code', (text) => drawn.push(text));
  draft.set('Iosevka Term'); // typing
  assert.equal(draft.text, 'Iosevka Term', 'held at once, whether or not the page has drawn it');
  const commits: ReturnType<typeof draft.commit>[] = [];
  // Escape: the old name goes back, and then the focus moves, which blurs the box at once.
  draft.cancel('Fira Code', () => commits.push(draft.commit('Fira Code')));
  assert.equal(commits.length, 1, 'the blur happened inside the focus move');
  assert.deepEqual(commits[0], { name: 'Fira Code', bad: false, changed: false }, 'so the blur finds no change to keep');
  assert.equal(draft.text, 'Fira Code');
  assert.equal(drawn.at(-1), 'Fira Code', 'and the page is told to draw the old name');
});

test('Escape sets the old name before it leaves the box: leaving first would let the blur commit the edit', () => {
  const draft = fontDraft('Fira Code');
  draft.set('Iosevka Term');
  let held = '';
  draft.cancel('Fira Code', () => (held = draft.text));
  assert.equal(held, 'Fira Code', 'what the blur sees is the old name');
  // What goes wrong if the old name is only drawn later: the blur commits the text that was being edited.
  const late = fontDraft('Fira Code');
  late.set('Iosevka Term');
  assert.deepEqual(late.commit('Fira Code'), { name: 'Iosevka Term', bad: false, changed: true }, 'this is the change Escape must not leave behind');
});

test('Escape on an edit that was never committed, or after one that was, puts back the name in use', () => {
  const draft = fontDraft('');
  draft.set('Hack NF');
  assert.equal(draft.commit('').changed, true);
  draft.set('Hack NF, Symbols Nerd Font Mono'); // another edit
  draft.cancel('Hack NF');
  assert.equal(draft.text, 'Hack NF');
  assert.equal(draft.commit('Hack NF').changed, false);
  // Escape with the box emptied puts a name back, and does not commit an empty one.
  draft.set('');
  draft.cancel('Hack NF', () => assert.equal(draft.commit('Hack NF').changed, false));
});

test('Enter or leaving the box: a usable name is tidied in place, a bad one is left for the person to fix', () => {
  const drawn: string[] = [];
  const draft = fontDraft('', (text) => drawn.push(text));
  draft.set('  Fira   Code ,  Symbols Nerd Font Mono');
  assert.deepEqual(draft.commit(''), { name: 'Fira Code, Symbols Nerd Font Mono', bad: false, changed: true });
  assert.equal(draft.text, 'Fira Code, Symbols Nerd Font Mono');
  assert.equal(drawn.at(-1), 'Fira Code, Symbols Nerd Font Mono');
  draft.set('a"; }');
  assert.deepEqual(draft.commit('Fira Code'), { name: '', bad: true, changed: true });
  assert.equal(draft.text, 'a"; }', 'what was typed stays in the box');
  draft.set('   ');
  assert.deepEqual(draft.commit('Fira Code'), { name: '', bad: false, changed: true }, 'emptied is a change, not a bad name');
  assert.equal(draft.text, '');
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

test('same as Windows Terminal chosen before the bridge has answered: the default, and nothing said yet', () => {
  const r = resolveFont({ kind: 'wt' }, undefined, false);
  assert.deepEqual(r, { family: fontStack(), size: DEFAULT_SIZE, kind: 'default' });
  assert.equal('problem' in r, false);
  // Once it has answered with nothing, that is said; with a font, that is followed.
  assert.match(resolveFont({ kind: 'wt' }, undefined, true).problem!, /No font is set in Windows Terminal/);
  assert.equal(resolveFont({ kind: 'wt' }, { face: 'Fira Code', size: 12 }, true).kind, 'wt');
  // The other choices don't wait for it.
  assert.deepEqual(resolveFont({ kind: 'default' }, undefined, false), { family: fontStack(), size: DEFAULT_SIZE, kind: 'default' });
  assert.equal(resolveFont({ kind: 'custom', name: 'Fira Code' }, undefined, false).face, 'Fira Code');
  assert.deepEqual(resolveFont(undefined, undefined, false), { family: fontStack(), size: DEFAULT_SIZE, kind: 'default' });
  // A font that is known is followed, whatever the flag says.
  assert.equal(resolveFont({ kind: 'wt' }, { face: 'Fira Code' }, false).kind, 'wt');
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
