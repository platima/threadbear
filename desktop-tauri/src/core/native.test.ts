// node --test desktop-tauri/src/core/native.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getExitOnClose, openClaudeLogin, openExternal, setExitOnClose, startRunner } from './native.ts';

test('a link is opened through the shell, as the address given', async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const opened = await openExternal('https://example.com/docs', {
    call: async (command, args) => {
      calls.push({ command, args });
      return undefined as never;
    },
    failed: () => assert.fail('nothing failed'),
  });
  assert.equal(opened, true);
  assert.deepEqual(calls, [{ command: 'plugin:opener|open_url', args: { url: 'https://example.com/docs' } }]);
});

test('when the shell turns the link down, the address is handed to the notice instead of vanishing', async () => {
  // The shell's errors come back as plain strings.
  const seen: { href: string; why: string }[] = [];
  const opened = await openExternal('https://example.com/docs', {
    call: async () => {
      throw 'url not allowed on the opener allow list';
    },
    failed: (href, why) => seen.push({ href, why }),
  });
  assert.equal(opened, false);
  assert.deepEqual(seen, [{ href: 'https://example.com/docs', why: 'url not allowed on the opener allow list' }]);
  await openExternal('https://example.com/other', {
    call: async () => {
      throw new Error('no browser');
    },
    failed: (href, why) => seen.push({ href, why }),
  });
  assert.deepEqual(seen.at(-1), { href: 'https://example.com/other', why: 'no browser' });
});

test('the exit-on-close choice is asked for and set through the shell, and a refusal comes back as words', async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const on = async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return (command === 'get_exit_on_close' ? true : undefined) as never;
  };
  assert.equal(await getExitOnClose({ call: on }), true);
  assert.equal(await setExitOnClose(false, { call: on }), undefined);
  assert.deepEqual(calls, [{ command: 'get_exit_on_close', args: undefined }, { command: 'set_exit_on_close', args: { on: false } }]);

  // The shell's errors come back as plain strings; a failed read is "don't know", not "off".
  assert.equal(await setExitOnClose(true, { call: async () => { throw "Couldn't find the folder to keep the choice in."; } }), "Couldn't find the folder to keep the choice in.");
  assert.equal(await setExitOnClose(true, { call: async () => { throw new Error('denied'); } }), 'denied');
  assert.equal(await getExitOnClose({ call: async () => { throw 'no'; } }), undefined);
});

test('starting the runner is a request the shell answers when it is done, and a failure comes back as its words', async () => {
  const calls: string[] = [];
  assert.equal(await startRunner({ call: async (c) => { calls.push(c); return undefined as never; } }), undefined);
  assert.deepEqual(calls, ['start_runner']);
  assert.equal(await startRunner({ call: async () => { throw 'The runner could not be started.\n\nAccess is denied.'; } }), 'The runner could not be started.\n\nAccess is denied.');
  assert.equal(await startRunner({ call: async () => { throw new Error('gone'); } }), 'gone');
});

test('on Linux the shell has no exit-on-close choice to give, and that is not "off"', async () => {
  assert.equal(await getExitOnClose({ call: async () => null as never }), undefined);
  assert.equal(await getExitOnClose({ call: async () => false as never }), false);
});

test('a sign-in terminal is asked for by name, with the login\'s folder only when it has one, and a refusal comes back as words', async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const on = async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return undefined as never;
  };
  assert.equal(await openClaudeLogin('login', undefined, { call: on }), undefined);
  assert.equal(await openClaudeLogin('setup-token', 'C:\\Users\\me\\.claude-work', { call: on }), undefined);
  assert.deepEqual(calls, [
    { command: 'open_claude_login', args: { kind: 'login' } },
    { command: 'open_claude_login', args: { kind: 'setup-token', configDir: 'C:\\Users\\me\\.claude-work' } },
  ]);
  assert.equal(await openClaudeLogin('login', undefined, { call: async () => { throw "That login's folder isn't there."; } }), "That login's folder isn't there.");
  assert.match((await openClaudeLogin('login', undefined, { call: null })) ?? '', /installed app/);
});

test('outside the shell the exit-on-close choice and the runner start do nothing and say what they can', async () => {
  assert.equal(await getExitOnClose({ call: null }), undefined);
  assert.match((await setExitOnClose(true, { call: null })) ?? '', /installed app/);
  assert.match((await startRunner({ call: null })) ?? '', /installed app/);
});

test('outside the shell it does nothing and says nothing', async () => {
  assert.equal(await openExternal('https://example.com/', { call: null, failed: () => assert.fail('no notice outside the shell') }), false);
});
