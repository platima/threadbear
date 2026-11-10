// node --test desktop-tauri/bridge/windows-terminal-font.test.ts
//
// Finding Windows Terminal's font in its settings files. Every case builds the files it
// needs in a folder of its own under the system's temp folder and points the reader at that
// folder, so no real Windows Terminal settings (or anything else on the PC) are read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { MAX_SETTINGS_BYTES, readLimited, settingsFiles, windowsTerminalFont } from './windows-terminal-font.ts';

const roots: string[] = [];
function pc(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-wt-font-test-'));
  roots.push(root);
  return root;
}
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const [STABLE, PREVIEW, UNPACKAGED] = [0, 1, 2];
function put(base: string, which: number, text: string | Buffer): string {
  const file = settingsFiles(base)[which]!;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
const GUID = '{61c54bbd-c2c6-5271-96e7-009a87ff44bf}';
const withFont = (face: string, size?: number) =>
  `{ // comment\n  "defaultProfile": "${GUID}",\n  "profiles": { "defaults": { "font": { "face": "${face}"${size ? `, "size": ${size}` : ''} }, }, "list": [ { "guid": "${GUID}", "name": "PowerShell" }, ], },\n}\n`;
const win = (localAppData: string) => ({ platform: 'win32' as const, localAppData });

describe('where it looks', () => {
  test('the three places Windows Terminal keeps settings.json, under %LOCALAPPDATA%', () => {
    const base = path.join(os.tmpdir(), 'x');
    assert.deepEqual(settingsFiles(base), [
      path.join(base, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
      path.join(base, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
      path.join(base, 'Microsoft', 'Windows Terminal', 'settings.json'),
    ]);
  });

  test("the stable package's file", () => {
    const base = pc();
    put(base, STABLE, withFont('CaskaydiaCove Nerd Font Mono', 11));
    assert.deepEqual(windowsTerminalFont(win(base)), { face: 'CaskaydiaCove Nerd Font Mono', size: 11 });
  });

  test("Preview's file when there is no stable one", () => {
    const base = pc();
    put(base, PREVIEW, withFont('MesloLGS NF'));
    assert.deepEqual(windowsTerminalFont(win(base)), { face: 'MesloLGS NF' });
  });

  test("an unpackaged copy's file when there is neither", () => {
    const base = pc();
    put(base, UNPACKAGED, withFont('JetBrainsMono NF'));
    assert.deepEqual(windowsTerminalFont(win(base)), { face: 'JetBrainsMono NF' });
  });

  test('the stable file is preferred when more than one names a font', () => {
    const base = pc();
    put(base, STABLE, withFont('Stable Font'));
    put(base, PREVIEW, withFont('Preview Font'));
    put(base, UNPACKAGED, withFont('Unpackaged Font'));
    assert.equal(windowsTerminalFont(win(base)).face, 'Stable Font');
  });

  test('a file that names no font, or cannot be used, does not hide the next one', () => {
    const base = pc();
    put(base, STABLE, '{ "defaultProfile": "x", "profiles": { "list": [] } }');
    put(base, PREVIEW, '{ not json');
    put(base, UNPACKAGED, withFont('Third Font'));
    assert.equal(windowsTerminalFont(win(base)).face, 'Third Font');
  });

  test('a settings file with a byte order mark and Windows line endings is read', () => {
    const base = pc();
    put(base, STABLE, `﻿${withFont('Windows Font', 12).replace(/\n/g, '\r\n')}`);
    assert.deepEqual(windowsTerminalFont(win(base)), { face: 'Windows Font', size: 12 });
  });
});

describe('when there is nothing to find', () => {
  test('no Windows Terminal at all', () => {
    assert.deepEqual(windowsTerminalFont(win(pc())), {});
  });

  test('a folder that is not there', () => {
    assert.deepEqual(windowsTerminalFont(win(path.join(pc(), 'nope'))), {});
  });

  test('a file that is not JSON, or is empty', () => {
    for (const text of ['', '   ', 'plain text', '{"profiles": ', '[[[[', 'null', '"Fira Code"', '5']) {
      const base = pc();
      put(base, STABLE, text);
      assert.deepEqual(windowsTerminalFont(win(base)), {}, JSON.stringify(text));
    }
  });

  test('a file that is not text', () => {
    const base = pc();
    put(base, STABLE, Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81, 0x00, 0x7b]));
    assert.deepEqual(windowsTerminalFont(win(base)), {});
  });

  test('a settings.json that is a folder', () => {
    const base = pc();
    fs.mkdirSync(settingsFiles(base)[STABLE]!, { recursive: true });
    assert.deepEqual(windowsTerminalFont(win(base)), {});
  });

  test('a font name that is not just a name is not passed on', () => {
    const base = pc();
    put(base, STABLE, withFont('x\\"; } body { display: none } a { font-family: \\"y'));
    assert.deepEqual(windowsTerminalFont(win(base)), {});
  });

  test('on any system but Windows, whatever files are there', () => {
    const base = pc();
    put(base, STABLE, withFont('CaskaydiaCove Nerd Font Mono'));
    for (const platform of ['linux', 'darwin', 'freebsd'] as const) assert.deepEqual(windowsTerminalFont({ platform, localAppData: base }), {}, platform);
  });

  test('no %LOCALAPPDATA%, or one that is not an absolute path (it would be read from the working folder)', () => {
    const base = pc();
    put(base, STABLE, withFont('Some Font'));
    assert.deepEqual(windowsTerminalFont({ platform: 'win32', localAppData: undefined }), {});
    assert.deepEqual(windowsTerminalFont({ platform: 'win32', localAppData: '' }), {});
    // A relative path is looked up from the working folder, so stand in one that has the files.
    const here = process.cwd();
    try {
      process.chdir(base);
      assert.ok(fs.existsSync(settingsFiles('.')[STABLE]!), 'the file is there relative to the working folder');
      assert.deepEqual(windowsTerminalFont({ platform: 'win32', localAppData: '.' }), {});
    } finally {
      process.chdir(here);
    }
  });
});

describe('how much is read', () => {
  // Valid JSON of exactly this many bytes: the settings, then spaces.
  const sized = (bytes: number) => {
    const body = withFont('Sized Font');
    return body + ' '.repeat(bytes - Buffer.byteLength(body));
  };

  test('a file of exactly 2 MB is read', () => {
    const base = pc();
    put(base, STABLE, sized(MAX_SETTINGS_BYTES));
    assert.equal(windowsTerminalFont(win(base)).face, 'Sized Font');
  });

  test('one byte more is not', () => {
    const base = pc();
    put(base, STABLE, sized(MAX_SETTINGS_BYTES + 1));
    assert.deepEqual(windowsTerminalFont(win(base)), {});
  });

  test('a large file does not hide a good one after it', () => {
    const base = pc();
    put(base, STABLE, sized(MAX_SETTINGS_BYTES + 10));
    put(base, PREVIEW, withFont('Small Font'));
    assert.equal(windowsTerminalFont(win(base)).face, 'Small Font');
  });

  test('readLimited gives the text, or nothing', () => {
    const base = pc();
    const file = put(base, STABLE, 'hello');
    assert.equal(readLimited(file), 'hello');
    assert.equal(readLimited(file, 5), 'hello');
    assert.equal(readLimited(file, 4), undefined);
    assert.equal(readLimited(path.join(base, 'missing.json')), undefined);
    assert.equal(readLimited(base), undefined, 'a folder');
  });
});

describe('the environment', () => {
  const saved = process.env.LOCALAPPDATA;
  afterEach(() => {
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
  });

  test("with no folder given it uses %LOCALAPPDATA%, which here is a folder of the test's own", () => {
    const base = pc();
    put(base, UNPACKAGED, withFont('From The Environment'));
    process.env.LOCALAPPDATA = base;
    assert.equal(windowsTerminalFont({ platform: 'win32' }).face, 'From The Environment');
    delete process.env.LOCALAPPDATA;
    assert.deepEqual(windowsTerminalFont({ platform: 'win32' }), {});
  });
});
