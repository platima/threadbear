// node --test desktop-tauri/src/core/runner-start.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shellSilent } from './native.ts';
import { RUNNER_WAYS, runnerChoiceText, startClick } from './runner-start.ts';

type Call = { command: string; args?: Record<string, unknown> };

// A shell that says how the runner is set up, and what starting it does.
function shell(setup: string, start: 'ok' | string = 'ok') {
  const calls: Call[] = [];
  const call = async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === 'runner_setup') return setup as never;
    if (start !== 'ok' && !start.startsWith('NOTE:')) throw start;
    return (start.startsWith('NOTE:') ? start.slice(5) : undefined) as never;
  };
  return { call, calls };
}

test('with a runner set up, the button starts it and asks nothing', async () => {
  for (const setup of ['sign-in', 'on-demand']) {
    const s = shell(setup);
    assert.deepEqual(await startClick({ call: s.call }), { kind: 'done' });
    assert.deepEqual(s.calls, [{ command: 'runner_setup', args: undefined }, { command: 'start_runner', args: { how: 'start' } }]);
  }
});

test('what the shell says about starting is given back, even when it started nothing', async () => {
  for (const said of ['Started the runner.', 'The runner is already running.', 'The runner task is turned off in Task Scheduler, so it was not started.']) {
    const s = shell('sign-in', 'NOTE:' + said);
    assert.deepEqual(await startClick({ call: s.call }), { kind: 'done', note: said });
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

test('a shell that never answers is waited on once, not twice', async () => {
  const calls: string[] = [];
  const never = (command: string) => {
    calls.push(command);
    return new Promise<never>(() => {});
  };
  const t0 = Date.now();
  const done = await startClick({ call: never, waitMs: 30 });
  assert.equal(done.kind, 'done');
  assert.equal((done as { problem?: string }).problem, shellSilent());
  // Only the question went to the shell: no start_runner after it, so no second wait.
  assert.deepEqual(calls, ['runner_setup']);
  assert.ok(Date.now() - t0 < 500);
});

test('the two ways to set it up are the two the shell takes, each with a tip longer than its label', () => {
  assert.deepEqual(RUNNER_WAYS.map((w) => w.way), ['on-demand', 'sign-in']);
  for (const w of RUNNER_WAYS) assert.ok(w.tip.length > w.label.length * 2, w.label);
});

test('the choice says what each system really does and how to undo it', () => {
  const windows = runnerChoiceText('windows');
  assert.match(windows, /Task Scheduler/);
  assert.match(windows, /\.\\Threadbear\.exe --runner --uninstall/);
  assert.match(windows, /on your PATH/);
  assert.doesNotMatch(windows, /systemd|threadbear-desktop|\.local\/bin/);
  const linux = runnerChoiceText('linux');
  assert.match(linux, /systemd user service/);
  assert.match(linux, /\.\/threadbear-desktop --runner --uninstall/);
  // The installer puts tb in ~/.local/bin and does not change the PATH.
  assert.match(linux, /~\/\.local\/bin \(add that folder to your PATH/);
  assert.doesNotMatch(linux, /Task Scheduler|Threadbear\.exe/);
});
