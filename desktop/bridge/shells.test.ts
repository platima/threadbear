// node --test desktop/bridge/shells.test.ts
//
// Which shells the Terminal offers, and which it starts when nothing is chosen.
// Each case stands in a machine, so this runs the same on any PC.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { command, detectShells, pick, parseWslList, type Machine } from './shells.ts';

const win = (files: string[], more: Partial<Machine> = {}): Machine => ({
  platform: 'win32',
  env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: 'C:\\Windows\\System32;C:\\Tools', ...(more.env ?? {}) },
  exists: (f) => files.map((x) => x.toLowerCase()).includes(f.toLowerCase()),
  wslDistros: async () => undefined,
  gitBash: () => undefined,
  readText: () => undefined,
  ...more,
});
const SYSTEM = ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'];
const ids = (l: { shells: { id: string }[] }) => l.shells.map((s) => s.id);

describe('reading wsl.exe -l -q', () => {
  const utf16 = (text: string, bom = false) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);

  test('the names, from the UTF-16 it prints', () => {
    assert.deepEqual(parseWslList(utf16('Debian\r\nFedoraLinux-42\r\nnpad-arch-test\r\n')), ['Debian', 'FedoraLinux-42', 'npad-arch-test']);
    assert.deepEqual(parseWslList(utf16('Ubuntu\r\n', true)), ['Ubuntu']);
  });

  test('plain UTF-8, the default marker and blank lines are tolerated', () => {
    assert.deepEqual(parseWslList(Buffer.from('Ubuntu-22.04 (Default)\n\nAlpine\n')), ['Ubuntu-22.04', 'Alpine']);
  });

  test("Docker's own distributions have no shell to start, and a name is listed once", () => {
    assert.deepEqual(parseWslList(utf16('docker-desktop\r\nDebian\r\ndocker-desktop-data\r\nDebian\r\n')), ['Debian']);
  });

  test("the message wsl.exe prints with nothing installed is not a distribution", () => {
    assert.deepEqual(parseWslList(utf16('Windows Subsystem for Linux has no installed distributions.\r\nUse wsl.exe --list --online to list available distributions\r\n')), []);
  });
});

describe('Windows', () => {
  test('PowerShell 7 on the PATH is the default over Windows PowerShell 5.1', async () => {
    const l = await detectShells(win([...SYSTEM, 'C:\\Tools\\pwsh.exe']));
    assert.deepEqual(ids(l), ['pwsh', 'powershell', 'cmd']);
    assert.equal(l.auto, 'pwsh');
    assert.equal(l.shells[0]!.file, 'C:\\Tools\\pwsh.exe');
    assert.equal(l.shells[0]!.label, 'PowerShell 7');
  });

  test("PowerShell 7 is found in Program Files when the PATH doesn't have it", async () => {
    const l = await detectShells(win([...SYSTEM, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']));
    assert.equal(l.auto, 'pwsh');
    assert.equal(l.shells[0]!.file, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  });

  test('without 7, the PowerShell every Windows has is the default', async () => {
    const l = await detectShells(win(SYSTEM));
    assert.deepEqual(ids(l), ['powershell', 'cmd']);
    assert.equal(l.auto, 'powershell');
    assert.equal(l.shells[0]!.label, 'Windows PowerShell 5.1');
  });

  test('each WSL distribution is a shell of its own, and the default stays PowerShell', async () => {
    const l = await detectShells(win([...SYSTEM, 'C:\\Windows\\System32\\wsl.exe'], { wslDistros: async () => ['Debian', 'FedoraLinux-42'] }));
    assert.deepEqual(ids(l), ['powershell', 'wsl:Debian', 'wsl:FedoraLinux-42', 'cmd']);
    assert.equal(l.auto, 'powershell');
    assert.deepEqual(l.shells[1], { id: 'wsl:Debian', label: 'WSL: Debian', file: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Debian'], wsl: 'Debian' });
    assert.deepEqual(l.notes, []);
  });

  test('WSL on the PC with no distribution says so and offers none', async () => {
    const l = await detectShells(win([...SYSTEM, 'C:\\Windows\\System32\\wsl.exe']));
    assert.deepEqual(ids(l), ['powershell', 'cmd']);
    assert.match(l.notes[0]!, /no Linux distribution.*wsl --install/);
  });

  test('no wsl.exe means no WSL, and no note about it', async () => {
    const l = await detectShells(win(SYSTEM));
    assert.deepEqual(l.notes, []);
  });

  test("Git Bash is offered when Git for Windows is there", async () => {
    const l = await detectShells(win(SYSTEM, { gitBash: () => 'C:\\Program Files\\Git\\bin\\bash.exe' }));
    assert.deepEqual(ids(l), ['powershell', 'gitbash', 'cmd']);
    assert.deepEqual(l.shells[1]!.args, ['--login', '-i']);
    assert.deepEqual(l.shells[1]!.env, { CHERE_INVOKING: '1' }, 'its login profile would else change to the home folder');
  });

  test('a PC with only Command Prompt still gets a terminal', async () => {
    const l = await detectShells(win(['C:\\Windows\\System32\\cmd.exe']));
    assert.deepEqual(ids(l), ['cmd']);
    assert.equal(l.auto, 'cmd');
  });

  test('a PC with no shell at all has no default', async () => {
    const l = await detectShells(win([]));
    assert.deepEqual(l.shells, []);
    assert.equal(l.auto, undefined);
  });
});

describe('Linux', () => {
  const unix = (files: string[], env: NodeJS.ProcessEnv, etcShells = ''): Machine => ({
    platform: 'linux',
    env,
    exists: (f) => files.includes(f),
    wslDistros: async () => undefined,
    gitBash: () => undefined,
    readText: (f) => (f === '/etc/shells' ? etcShells : undefined),
  });

  test("the login shell is the default, then the other shells /etc/shells lists", async () => {
    const l = await detectShells(unix(['/bin/zsh', '/bin/bash', '/usr/bin/fish', '/usr/bin/pwsh'], { SHELL: '/bin/zsh' }, '# shells\n/bin/sh\n/bin/bash\n/bin/zsh\n/usr/bin/fish\n/usr/bin/pwsh\n/usr/sbin/nologin\n'));
    assert.deepEqual(ids(l), ['login', 'sh:/bin/bash', 'sh:/usr/bin/fish', 'sh:/usr/bin/pwsh']);
    assert.equal(l.auto, 'login');
    assert.equal(l.shells[0]!.label, 'Login shell (zsh)');
    assert.deepEqual(l.shells[0]!.args, ['-l']);
    assert.deepEqual(l.shells[3]!.args, ['-NoLogo']);
  });

  test('a shell reachable by two paths is listed once', async () => {
    const l = await detectShells(unix(['/bin/bash', '/usr/bin/bash', '/usr/bin/zsh'], { SHELL: '/bin/bash' }, '/bin/bash\n/usr/bin/bash\n/usr/bin/zsh\n'));
    assert.deepEqual(ids(l), ['login', 'sh:/usr/bin/zsh']);
  });

  test('with no SHELL, bash is the login shell, and sh the last resort', async () => {
    assert.equal((await detectShells(unix(['/bin/bash'], {}))).shells[0]!.file, '/bin/bash');
    assert.equal((await detectShells(unix(['/bin/sh'], {}))).shells[0]!.file, '/bin/sh');
  });
});

describe('choosing', () => {
  const list = { shells: [{ id: 'pwsh', label: 'PowerShell 7', file: 'p', args: [] }, { id: 'wsl:Debian', label: 'WSL: Debian', file: 'w', args: ['-d', 'Debian'], wsl: 'Debian' }], auto: 'pwsh', notes: [] };

  test('a saved choice is used while it is still there', () => {
    assert.equal(pick(list, 'wsl:Debian').shell?.id, 'wsl:Debian');
    assert.equal(pick(list, 'wsl:Debian').fellBack, false);
  });

  test('automatic, or nothing saved, is the default', () => {
    assert.deepEqual([pick(list, 'auto').shell?.id, pick(list, 'auto').fellBack], ['pwsh', false]);
    assert.deepEqual([pick(list, undefined).shell?.id, pick(list, undefined).fellBack], ['pwsh', false]);
  });

  test('a shell that has gone since it was chosen (a removed distribution) falls back to the default, and says so', () => {
    assert.deepEqual([pick(list, 'wsl:Gone').shell?.id, pick(list, 'wsl:Gone').fellBack], ['pwsh', true]);
  });

  test("a WSL shell starts in the thread's folder with --cd; the others use the folder as their working directory", () => {
    assert.deepEqual(command(list.shells[1]!, 'C:\\Users\\me\\proj'), { file: 'w', args: ['-d', 'Debian', '--cd', 'C:\\Users\\me\\proj'] });
    assert.deepEqual(command(list.shells[0]!, 'C:\\Users\\me\\proj'), { file: 'p', args: [] });
    assert.deepEqual(command({ id: 'gitbash', label: 'Git Bash', file: 'b', args: ['--login'], env: { CHERE_INVOKING: '1' } }, 'C:\\p'), { file: 'b', args: ['--login'], env: { CHERE_INVOKING: '1' } });
  });
});
