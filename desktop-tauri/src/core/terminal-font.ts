// The font the Terminal draws in. A prompt such as oh-my-posh or a Powerline theme uses glyphs
// that only a Nerd Font has, and the person has set one in Windows Terminal, so the choices are:
//
//   Same as Windows Terminal   the face (and size) the bridge read from Windows Terminal's settings
//   Default                    no face of the person's: Cascadia Mono, then what the PC has
//   a name typed by the person works on every system
//
// Whatever is chosen, the text is drawn in the person's own faces first, then in the ordinary
// monospace fonts (Cascadia Mono and the rest), and a Nerd Font the PC has comes after those.
// A browser looks for each glyph along the list, so the Nerd Fonts are only used for the symbols
// the ordinary fonts lack, and the letters are never drawn in one unless the person chose it.
//
// Nothing here touches the DOM, so it is tested in Node (the drawing is ui/TerminalDock.tsx, and
// the asking is core/terminals.ts). The choice is kept in localStorage, like the shell's.

import { sanitiseFaces } from '../../bridge/font-face.ts';

/** A custom choice's `name` is one font name, or a comma-separated list of them as Windows Terminal takes. */
export type FontChoice = { kind: 'wt' } | { kind: 'default' } | { kind: 'custom'; name: string };

/**
 * What the bridge found in Windows Terminal's settings: a face (the first it lists), all of them
 * in its order when there is more than one, and a size in points.
 */
export type FoundFont = { face?: string; faces?: string[]; size?: number };

export const DEFAULT_SIZE = 13;
export const MIN_SIZE = 8;
export const MAX_SIZE = 32;

// What follows the person's own faces. A webview finds a glyph in the private use area (the ones
// a prompt theme draws) only in a font it has been told to look in, so the Nerd Fonts people
// commonly install are named. They come after the ordinary monospace fonts, because a browser
// goes along the list glyph by glyph: the letters are drawn in an ordinary font, and the symbols
// those lack fall through to a Nerd Font. Liberation Mono and Menlo are what Linux and macOS
// had before this.
export const PLAIN_FACES = ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'Liberation Mono', 'Menlo', 'Courier New'];
export const NERD_FACES = [
  'CaskaydiaCove Nerd Font Mono',
  'CaskaydiaCove NF',
  'MesloLGM Nerd Font Mono',
  'MesloLGS NF',
  'JetBrainsMono Nerd Font Mono',
  'FiraCode Nerd Font Mono',
  'Hack Nerd Font Mono',
  // Only symbols: the font people set second in Windows Terminal ("Cascadia Code, Symbols Nerd Font
  // Mono") so a prompt's glyphs come from it. It has no letters, so where it sits changes nothing else.
  'Symbols Nerd Font Mono',
  'Symbols Nerd Font',
];
export const FALLBACK_FACES = [...PLAIN_FACES, ...NERD_FACES];

/**
 * The CSS font-family: the person's faces (quoted), in their order, if there are any, then the
 * ordinary monospace fonts, then the Nerd Fonts, then whatever monospace the system has. Each of
 * their faces counts, not just the first: a Nerd Font listed second is where a prompt's symbols
 * come from. A face of theirs that is also a fallback is named once, at their place.
 */
export function fontStack(face?: string | readonly string[]): string {
  // The names are checked again here: this string goes into the page's style.
  const names = [...sanitiseFaces(face), ...FALLBACK_FACES];
  const seen = new Set<string>();
  const quoted: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    quoted.push(`'${name}'`);
  }
  return [...quoted, 'monospace'].join(', ');
}

const clamp = (n: number) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, n));

/**
 * Windows Terminal's size is in points and the page's is in pixels: a point is 4/3 of one at the
 * usual 96 dpi, so its 12 points is a 16 pixel font. Halves are kept; the result is held to 8..32.
 */
export function pointsToPixels(points: number): number {
  return clamp(Math.round(((points * 96) / 72) * 2) / 2);
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;
export const FONT_KEY = 'threadbear.terminalFont';

/** The usable names in a typed font name or list, as one comma-separated text: '' when none is. */
export function fontNames(text: string): string {
  return sanitiseFaces(text).join(', ');
}

/**
 * What to do with the text in the font name box when the person has finished with it (Enter, or
 * leaving the box): the names to keep, whether there was text but none of it could be used, and
 * whether that is a change from the name already in use. Empty text is a name not yet typed, not a bad one.
 */
export function typedFontName(typed: string, current: string): { name: string; bad: boolean; changed: boolean } {
  const text = typed.trim();
  const name = text === '' ? '' : fontNames(text);
  return { name, bad: text !== '' && name === '', changed: name !== current };
}

export type FontDraft = {
  /** The text in the box right now, as it was last set (not as React last drew it). */
  readonly text: string;
  /** The person typed. */
  set(text: string): void;
  /**
   * Escape: the old name goes back first, then `leave` runs. Leaving moves the focus, which blurs the
   * box straight away, and that blur commits what the draft holds, so it must already be the old name.
   */
  cancel(oldName: string, leave?: () => void): void;
  /** Enter, or leaving the box: what typedFontName says of the text held. A usable name is tidied in place. */
  commit(current: string): ReturnType<typeof typedFontName>;
};

/**
 * The text of the font name box, held outside the page's render. The box's handlers (Escape, then the
 * blur that follows it at once) run before React has drawn what the first of them set, so they read
 * and write the text here, which changes the moment it is set, and `show` tells the page to draw it.
 */
export function fontDraft(initial: string, show: (text: string) => void = () => {}): FontDraft {
  let held = initial;
  const put = (text: string) => {
    held = text;
    show(text);
  };
  return {
    get text() {
      return held;
    },
    set: put,
    cancel(oldName, leave) {
      put(oldName);
      leave?.();
    },
    commit(current) {
      const result = typedFontName(held, current);
      if (!result.bad) put(result.name);
      return result;
    },
  };
}

export function serialiseFontChoice(choice: FontChoice): string {
  return choice.kind === 'custom' ? `custom:${choice.name}` : choice.kind;
}

/** A stored choice, or undefined when nothing (or nothing sensible) is stored: the person hasn't chosen. */
export function parseFontChoice(stored: string | null | undefined): FontChoice | undefined {
  if (stored === 'wt') return { kind: 'wt' };
  if (stored === 'default') return { kind: 'default' };
  // A name that has since failed the check (or was never one) counts as a name not yet typed.
  if (typeof stored === 'string' && stored.startsWith('custom:')) return { kind: 'custom', name: fontNames(stored.slice('custom:'.length)) };
  return undefined;
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The font the person chose, or undefined if they haven't. */
export function fontChoice(store: KeyValue | undefined = safeStorage()): FontChoice | undefined {
  try {
    return parseFontChoice(store?.getItem(FONT_KEY));
  } catch {
    return undefined;
  }
}

/** Keeps the choice. False when this window can't keep it. */
export function setFontChoice(choice: FontChoice, store: KeyValue | undefined = safeStorage()): boolean {
  try {
    if (!store) return false;
    const text = serialiseFontChoice(choice);
    store.setItem(FONT_KEY, text);
    return store.getItem(FONT_KEY) === text;
  } catch {
    return false;
  }
}

export type ResolvedFont = {
  /** The CSS font-family to draw in. */
  family: string;
  /** In pixels. */
  size: number;
  /** The choice that is in effect, which is not the one made when that can't be followed. */
  kind: FontChoice['kind'];
  /** The face asked for. Undefined for the default stack. */
  face?: string;
  /** Said to the person when what they chose can't be followed. */
  problem?: string;
};

/**
 * What to draw in. Nothing chosen means Windows Terminal's font if the bridge found one, otherwise the
 * default. The size is Windows Terminal's only for "Same as Windows Terminal": a name typed by the
 * person has no size of its own.
 *
 * `answered` is whether the bridge has said what Windows Terminal is set to yet. Until it has, there
 * is no font to follow and nothing to complain about: the default is drawn, without a note, for the
 * moment before the answer comes. (Undefined `found` after an answer means there is none.)
 */
export function resolveFont(choice: FontChoice | undefined, found: FoundFont | undefined, answered = true): ResolvedFont {
  // Every face Windows Terminal lists is used, in its order; the first is the one the label names.
  const listed = sanitiseFaces(found?.faces);
  const faces = listed.length ? listed : sanitiseFaces(found?.face);
  const face = faces[0];
  const wanted: FontChoice = choice ?? (face ? { kind: 'wt' } : { kind: 'default' });
  const plain = (extra: Partial<ResolvedFont> = {}): ResolvedFont => ({ family: fontStack(), size: DEFAULT_SIZE, kind: 'default', ...extra });
  if (wanted.kind === 'wt') {
    if (!face) return answered ? plain({ problem: 'No font is set in Windows Terminal on this PC, so the default is used.' }) : plain();
    const points = found?.size;
    return { family: fontStack(faces), size: typeof points === 'number' && Number.isFinite(points) && points > 0 ? pointsToPixels(points) : DEFAULT_SIZE, kind: 'wt', face };
  }
  if (wanted.kind === 'custom') {
    const names = sanitiseFaces(wanted.name);
    if (!names.length) return plain({ kind: 'custom', problem: wanted.name ? "That isn't a font name the Terminal can use." : undefined });
    return { family: fontStack(names), size: DEFAULT_SIZE, kind: 'custom', face: names[0] };
  }
  return plain();
}

/** What the font menu's button says: which font is in use. */
export function fontLabel(font: ResolvedFont): string {
  return `Font: ${font.face ?? 'Default'}`;
}
