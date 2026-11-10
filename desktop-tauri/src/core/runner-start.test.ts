// node --test desktop-tauri/src/core/runner-start.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUNNER_WAYS, startClick } from './runner-start.ts';

type Call = { command: string; args?: Record<string, unknown> };

// A shell that says how the runner is set up, and what starting it does.
function shell(setup: string, start: 'ok' | string = 'ok') {
  const calls: Call[] = [];
  const call = async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === 'runner_setup') return setup as never;
    if (start !== 'ok') throw start;
    return undefined as never;
  };
  return { call, calls };
}

test('with a runner set up, the button starts it and asks nothing', async () => {
  for (const setup of ['sign-in', 'on-demand']) {
    const s = shell(setup);
    assert.deepEqual(await startClick({ call: s.call }), { kind: 'done', problem: undefined });
    assert.deepEqual(s.calls, [{ command: 'runner_setup', args: undefined }, { command: 'start_runner', args: { how: 'start' } }]);
  }
});

test('with none set up, nothing is started: the person is asked how it should start, in the page', async () => {
  const s = shell('none');
  assert.deepEqual(await startClick({ call: s.call }), { kind: 'choose' });
  assert.deepEqual(s.calls.map((c) => c.command), ['runner_setup']);
});

test('a runner that will not start comes back as the shell\'s words', async () => {
  const s = shell('on-demand', 'The runner could not be started.\n\nAccess is denied.');
  assert.deepEqual(await startClick({ call: s.call }), { kind: 'done', problem: 'The runner could not be started.\n\nAccess is denied.' });
});

test('when the shell will not say how the runner is set up, starting it is tried and its answer is given', async () => {
  const s = shell('???', 'The task "Threadbear Runner (Owner)" is not installed.');
  const done = await startClick({ call: s.call });
  assert.equal(done.kind, 'done');
  assert.match((done as { problem?: string }).problem ?? '', /not installed/);
});

test('the two ways to set it up are the two the shell takes, each with a tip longer than its label', () => {
  assert.deepEqual(RUNNER_WAYS.map((w) => w.way), ['on-demand', 'sign-in']);
  for (const w of RUNNER_WAYS) assert.ok(w.tip.length > w.label.length * 2, w.label);
});
