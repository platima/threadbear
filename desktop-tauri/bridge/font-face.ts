// The font Windows Terminal is set to, worked out from the text of its settings.json.
// Nothing here touches the disk (windows-terminal-font.ts reads the file), and nothing
// here imports from Node, so the window can use sanitiseFace for a font name the person
// types, as the bridge does for one it reads: one rule for what may be a font's name.
//
// Windows Terminal's settings.json is JSON with comments and trailing commas (JSONC),
// which JSON.parse refuses, so parseJsonc cleans those out first.

export type TerminalFont = {
  /** A font family name, as sanitiseFace allows it: the first of `faces` when there are several. */
  face?: string;
  /**
   * Every acceptable name Windows Terminal lists, in its order, each once. Only there when it lists
   * more than one: a Nerd Font that comes second ("Cascadia Code, Symbols Nerd Font Mono") is
   * where a prompt's symbols come from, so the first alone would lose them.
   */
  faces?: string[];
  /** Windows Terminal's font size, in points. */
  size?: number;
};

export const MAX_FACE_LENGTH = 100;
/** The most names of a list that are kept. */
export const MAX_FACES = 6;

// Letters and digits in any script, spaces, and - . _ ( ). Nothing that can end a quoted
// CSS string, start another property or a comment, or run onto a second line.
const FACE = /^[\p{L}\p{Nd}_. ()-]+$/u;
const HAS_WORD = /[\p{L}\p{Nd}]/u;

/**
 * The font names in a comma-separated list (or in each text of an array of them) that are safe to
 * show and to put in quotes in a CSS font-family, in order, each once whatever its case, at most
 * MAX_FACES of them. Windows Terminal takes a list like this for `face`, and tries the fonts in
 * turn for each glyph. A name with anything else in it, or over 100 characters, is left out
 * (cut short it would be a different font).
 */
export function sanitiseFaces(value: unknown): string[] {
  const texts = Array.isArray(value) ? value.slice(0, MAX_FACES * 4) : [value];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (typeof text !== 'string' || text.length > MAX_FACE_LENGTH * 4) continue;
    for (const part of text.split(',')) {
      // Runs of spaces are tidied. A tab or a line break is not a space, and fails the check below.
      const name = part.replace(/ {2,}/g, ' ').replace(/^ | $/g, '');
      if (name.length === 0 || name.length > MAX_FACE_LENGTH || !FACE.test(name) || !HAS_WORD.test(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
      if (names.length === MAX_FACES) return names;
    }
  }
  return names;
}

/**
 * The first acceptable font name in a text, or undefined (a list's first name is the font
 * Windows Terminal draws in; the rest are fallbacks, which sanitiseFaces keeps).
 */
export function sanitiseFace(value: unknown): string | undefined {
  return typeof value === 'string' ? sanitiseFaces(value)[0] : undefined;
}

/** A font size in points as Windows Terminal could mean it (it allows halves: 10.5), or undefined. */
export function sanitiseSize(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 4 || value > 96) return undefined;
  return Math.round(value * 10) / 10;
}

/**
 * JSON with // and /* *\/ comments and trailing commas, as text JSON.parse takes. Quoted strings
 * are left alone (a URL in one has // in it). A comment that is never closed runs to the end.
 */
export function stripJsonc(text: string): string {
  const out: string[] = [];
  // Where the last comma went, while only blanks and comments have followed it: if the next thing
  // is a closing bracket, it was a trailing one.
  let comma = -1;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out.push(text.slice(i, j + 1));
      comma = -1;
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      const lineEnd = /[\r\n]/g;
      lineEnd.lastIndex = i;
      i = lineEnd.exec(text)?.index ?? text.length;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      // A comment between two tokens must still keep them apart: a/**/b is not ab.
      out.push(' ');
    } else if (c === ',') {
      comma = out.length;
      out.push(c);
      i++;
    } else if (c === '}' || c === ']') {
      if (comma >= 0) out[comma] = '';
      comma = -1;
      out.push(c);
      i++;
    } else {
      if (!/\s/.test(c)) comma = -1;
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

/** The value in JSONC text, or undefined when it isn't any. (JSON has no undefined, so that says nothing else.) */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripJsonc(text));
  } catch {
    return undefined;
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);

// A profile's (or the defaults') own font: `font: { face, size }`, else the older `fontFace` and `fontSize`.
function ownFont(p: Obj | undefined): { faces: string[]; size?: number } {
  const font = obj(p?.font);
  const faces = sanitiseFaces(font?.face);
  return { faces: faces.length ? faces : sanitiseFaces(p?.fontFace), size: sanitiseSize(font?.size) ?? sanitiseSize(p?.fontSize) };
}

const same = (a: unknown, b: string) => typeof a === 'string' && a.trim().toLowerCase() === b;

/**
 * The font of the profile Windows Terminal opens by default: that profile's own, then
 * profiles.defaults' for whatever it leaves out. The profile is found by its guid in
 * `defaultProfile` (a name works too). Face and size are each decided on their own, as
 * Windows Terminal decides them.
 */
export function pickFont(settings: unknown): TerminalFont {
  const root = obj(settings);
  if (!root) return {};
  const profiles = obj(root.profiles);
  // The oldest settings files have the list as `profiles` itself and no defaults.
  const list = Array.isArray(root.profiles) ? root.profiles : Array.isArray(profiles?.list) ? (profiles!.list as unknown[]) : [];
  const wanted = typeof root.defaultProfile === 'string' ? root.defaultProfile.trim().toLowerCase() : '';
  const entries = list.map(obj);
  const profile = wanted ? (entries.find((p) => p && same(p.guid, wanted)) ?? entries.find((p) => p && same(p.name, wanted))) : undefined;
  const own = ownFont(profile);
  const base = ownFont(obj(profiles?.defaults));
  const faces = own.faces.length ? own.faces : base.faces;
  const size = own.size ?? base.size;
  return { ...(faces[0] ? { face: faces[0] } : {}), ...(faces.length > 1 ? { faces } : {}), ...(size !== undefined ? { size } : {}) };
}
