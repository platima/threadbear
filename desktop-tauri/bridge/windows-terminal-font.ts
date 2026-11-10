// The font face (and size) Windows Terminal is set to, for the Terminal panel to draw in the
// same one. A prompt such as oh-my-posh or a Powerline theme draws with glyphs only a Nerd
// Font has, and the person has set one in Windows Terminal; the panel can't know its name
// unless it is told.
//
// What this reads, and only on Windows: Windows Terminal's settings.json, from the three
// places it keeps it (the Store's stable and Preview packages, and an unpackaged copy). The
// first of those that is there and is valid settings is the one used, even if it names no
// font (that is the file Windows Terminal reads, so its font is the default); one that is
// missing, too big, unreadable or not JSON is passed over. It looks at the default profile's
// font and nothing else in the file, hands back font names that sanitiseFaces accepts and a
// size, and never the file's text: not to the page, not to a log. Anything wrong is "none".
// It reads when asked and keeps nothing.

import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc, pickFont, type TerminalFont } from './font-face.ts';

export type { TerminalFont };

/** A settings file bigger than this is not Windows Terminal's (theirs is a few KB); it is not read. */
export const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;

/** Where Windows Terminal keeps its settings under %LOCALAPPDATA%, in the order they are tried. */
export function settingsFiles(localAppData: string): string[] {
  return [
    path.join(localAppData, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    path.join(localAppData, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    path.join(localAppData, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ];
}

/** A file's text, or undefined when it isn't a regular file, is over the limit, or can't be read. */
export function readLimited(file: string, limit: number = MAX_SETTINGS_BYTES): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return undefined;
    // One byte more than the limit is room to notice a file that grew since it was measured.
    const buf = Buffer.alloc(Math.min(stat.size, limit) + 1);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return got > limit ? undefined : buf.toString('utf8', 0, got);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing to do about it
      }
    }
  }
}

/** What this looks at, so a test can stand in a PC: it must never have to read the real settings. */
export type FontSource = {
  platform?: NodeJS.Platform;
  /** The folder %LOCALAPPDATA% names. Given as undefined, there is none. */
  localAppData?: string;
};

/**
 * Windows Terminal's font, from the first settings file that is there and is settings (JSON, with
 * comments, whose top level is an object): that is the file Windows Terminal reads, so a valid one
 * that names no font means the font is its default, and the search ends with `{}`. A file that is
 * missing, can't be read, is too big or isn't valid is passed over for the next place.
 * `{}` anywhere but Windows, and when there is no such file.
 */
export function windowsTerminalFont(source: FontSource = {}): TerminalFont {
  if ((source.platform ?? process.platform) !== 'win32') return {};
  const base = 'localAppData' in source ? source.localAppData : process.env.LOCALAPPDATA;
  if (!base || !path.isAbsolute(base)) return {};
  for (const file of settingsFiles(base)) {
    try {
      const text = readLimited(file);
      if (text === undefined) continue;
      const settings = parseJsonc(text);
      if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) continue;
      return pickFont(settings);
    } catch {
      // this one is no use; the next might be
    }
  }
  return {};
}
