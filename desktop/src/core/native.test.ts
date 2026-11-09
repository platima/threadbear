// node --test desktop/src/core/native.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getExitOnClose, openExternal, setExitOnClose, startRunner } from './native.ts';

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

test('starting the runner is a request to the shell, which says whether it took it', async () => {
  const calls: string[] = [];
  assert.equal(await startRunner({ call: async (c) => { calls.push(c); return undefined as never; } }), true);
  assert.deepEqual(calls, ['start_runner']);
  assert.equal(await startRunner({ call: async () => { throw 'no'; } }), false);
});

test('outside the shell the exit-on-close choice and the runner start do nothing and say what they can', async () => {
  assert.equal(await getExitOnClose({ call: null }), undefined);
  assert.match((await setExitOnClose(true, { call: null })) ?? '', /installed app/);
  assert.equal(await startRunner({ call: null }), false);
});

test('outside the shell it does nothing and says nothing', async () => {
  assert.equal(await openExternal('https://example.com/', { call: null, failed: () => assert.fail('no notice outside the shell') }), false);
});
