// node --test desktop-tauri/src/core/runner-start.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { shellSilent, type StartAnswer } from './native.ts';
import { RUNNER_WAYS, RunnerStart, START_WAIT_MS, noTokenHint, notReachedText, runnerChoiceText, startButton, startClick, startOutcome, type StartClick, type StartView } from './runner-start.ts';

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
  const s = shell('???', 'The task "Threadbear Runner (Sam)" is not installed.');
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

// ---- after the shell says it started the runner (the rc.4 banner: "Started the runner." beside a
// button that still said Start the runner, because the connection was still closed) ----

const STARTED = 'Started the runner.';
const done = (note?: string): StartClick => ({ kind: 'done', ...(note ? { note } : {}) });

test("the shell's lines about a start: a start and a runner already running are waited on, a start that did nothing is not", () => {
  assert.equal(startOutcome('Started the runner.'), 'started');
  assert.equal(startOutcome('The runner is set up and starting.'), 'started');
  assert.equal(startOutcome(undefined), 'started', 'no line is still an exit 0');
  assert.equal(startOutcome('Something the script has not said before.'), 'started');
  assert.equal(startOutcome('The runner is already running.'), 'running');
  assert.equal(startOutcome('The runner task is turned off in Task Scheduler, so it was not started.'), 'nothing');
  assert.equal(startOutcome('The runner task "Threadbear Runner (Sam)" is not installed, so nothing was started.'), 'nothing');
});

test('the button is the same one all the way through, disabled and busy while it works or waits', () => {
  assert.deepEqual(startButton({ starting: false, waiting: false }).label, 'Start the runner');
  assert.equal(startButton({ starting: false, waiting: false }).busy, false);
  assert.deepEqual(startButton({ starting: true, waiting: false }), { label: 'Starting...', busy: true, tip: startButton({ starting: true, waiting: false }).tip });
  const waiting = startButton({ starting: false, waiting: true });
  assert.equal(waiting.label, 'Waiting for the runner to answer...');
  assert.equal(waiting.busy, true);
  // Waiting wins: the shell has answered by then, but the runner has not.
  assert.equal(startButton({ starting: true, waiting: true }).label, waiting.label);
  for (const b of [waiting, startButton({ starting: true, waiting: false }), startButton({ starting: false, waiting: false })]) assert.ok(b.tip.length > b.label.length, b.label);
});

test('the waiting button\'s tip does not claim the runner was started: the shell may only have found it running', () => {
  assert.doesNotMatch(startButton({ starting: false, waiting: true }).tip, /was started/i);
});

test('the line for a missing runner token is said only while nothing else has said what happened', () => {
  const idle = { waiting: false };
  const why = 'no runner token (the runner has not written one yet)';
  assert.match(noTokenHint('closed', why, idle) ?? '', /the runner isn't running/);
  // Not for another reason, nor while the connection is trying again.
  assert.equal(noTokenHint('closed', 'closed (1006)', idle), undefined);
  assert.equal(noTokenHint('closed', undefined, idle), undefined);
  assert.equal(noTokenHint('connecting', why, idle), undefined);
  // Another account of the same thing is the only one: the shell's line, the wait, or a failure.
  assert.equal(noTokenHint('closed', why, { waiting: false, note: 'The runner is already running.' }), undefined);
  assert.equal(noTokenHint('closed', why, { waiting: true }), undefined);
  assert.equal(noTokenHint('closed', why, { waiting: false, problem: 'The runner could not be started.' }), undefined);
});

test('the account of a runner that could not be reached says it started, that it keeps trying, and where shell.log is', () => {
  const windows = notReachedText('started', 'windows');
  assert.match(windows, /was started, but Threadbear cannot reach it/);
  assert.match(windows, /keeps trying/);
  assert.match(windows, /shell\.log, in %LOCALAPPDATA%\\Threadbear\./);
  const linux = notReachedText('started', 'linux');
  assert.match(linux, /shell\.log, in ~\/\.local\/state\/Threadbear\./);
  assert.doesNotMatch(linux, /LOCALAPPDATA/);
  // A runner the shell found already running is not claimed to have been started by this click.
  const running = notReachedText('running', 'windows');
  assert.match(running, /already running, but Threadbear cannot reach it/);
  assert.doesNotMatch(running, /was started/);
  assert.match(running, /shell\.log/);
});

describe('the banner after a click', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  // A shell that gives these answers, and a connection that is told to hurry.
  function flow(answer: StartClick | (() => Promise<StartClick>), over: { start?: (way: string) => Promise<StartAnswer>; waitMs?: number } = {}) {
    const hurried: number[] = [];
    const clicks: string[] = [];
    const f = new RunnerStart({
      click: async () => {
        clicks.push('click');
        return typeof answer === 'function' ? answer() : answer;
      },
      start: async (way) => {
        clicks.push(way);
        return over.start ? over.start(way) : { note: 'The runner is set up and starting.' };
      },
      hurry: (ms) => hurried.push(ms),
      platform: 'windows',
      ...(over.waitMs ? { waitMs: over.waitMs } : {}),
    });
    const seen: StartView[] = [];
    f.subscribe(() => seen.push(f.getSnapshot()));
    return { f, hurried, clicks, seen };
  }

  test('a start brings the connection up now, and shows the wait where the button was, not Start the runner', async () => {
    const { f, hurried } = flow(done(STARTED));
    const first = f.click();
    assert.deepEqual(f.getSnapshot(), { starting: true, choosing: false, waiting: false });
    await first;
    const view = f.getSnapshot();
    assert.equal(view.waiting, true);
    assert.equal(view.starting, false);
    assert.equal(view.note, STARTED);
    assert.equal(startButton(view).label, 'Waiting for the runner to answer...');
    assert.deepEqual(hurried, [START_WAIT_MS], 'told once to try now and keep trying for about 20 seconds');
    assert.equal(START_WAIT_MS, 20_000);
  });

  test('the banner clears itself the moment the connection opens, and the window is forgotten', async () => {
    const { f, hurried, seen } = flow(done(STARTED));
    await f.click();
    f.connection('connecting');
    f.connection('closed');
    assert.equal(f.getSnapshot().waiting, true, 'a try that failed does not end the wait');
    mock.timers.tick(7_000);
    f.connection('open');
    assert.deepEqual(f.getSnapshot(), { starting: false, choosing: false, waiting: false });
    assert.equal(f.getSnapshot().note, undefined);
    // Nothing is left to fire when the 20 seconds would have been up.
    const shown = seen.length;
    mock.timers.tick(START_WAIT_MS * 2);
    assert.equal(seen.length, shown);
    assert.equal(f.getSnapshot().problem, undefined);
    assert.equal(hurried.length, 1);
  });

  test('without a connection by the end of the window, the button is back with the honest account, and nothing loops', async () => {
    const { f, hurried, clicks } = flow(done(STARTED));
    await f.click();
    mock.timers.tick(START_WAIT_MS - 1);
    assert.equal(f.getSnapshot().waiting, true, 'not before the time');
    mock.timers.tick(1);
    const view = f.getSnapshot();
    assert.equal(view.waiting, false);
    assert.equal(startButton(view).label, 'Start the runner');
    assert.equal(startButton(view).busy, false);
    assert.match(view.problem ?? '', /was started, but Threadbear cannot reach it/);
    assert.match(view.problem ?? '', /shell\.log, in %LOCALAPPDATA%\\Threadbear/);
    assert.equal(view.note, undefined, 'the "Started the runner." line is not left beside the failure');
    // Another minute does nothing: no second window, no second start.
    mock.timers.tick(60_000);
    assert.deepEqual(hurried, [START_WAIT_MS]);
    assert.deepEqual(clicks, ['click']);
  });

  test('the banner tells what happened once: the missing-token line is not brought back beside the account after the wait', async () => {
    const why = 'no runner token (the runner has not written one yet)';
    const { f } = flow(done(STARTED));
    assert.ok(noTokenHint('closed', why, f.getSnapshot()), 'before any click, the line explains the close');
    await f.click();
    assert.equal(noTokenHint('closed', why, f.getSnapshot()), undefined, 'while waiting');
    mock.timers.tick(START_WAIT_MS);
    assert.match(f.getSnapshot().problem ?? '', /was started, but Threadbear cannot reach it/);
    assert.equal(noTokenHint('closed', why, f.getSnapshot()), undefined, 'after the wait gave up');
    // Once the connection has been up, the next close starts again with the line.
    f.connection('open');
    assert.ok(noTokenHint('closed', why, f.getSnapshot()));
  });

  test('a runner the shell says is already running, and still does not connect, ends the same way and says so', async () => {
    const { f, hurried, clicks } = flow(done('The runner is already running.'));
    await f.click();
    assert.equal(f.getSnapshot().waiting, true);
    assert.equal(f.getSnapshot().note, 'The runner is already running.');
    mock.timers.tick(START_WAIT_MS);
    assert.match(f.getSnapshot().problem ?? '', /already running, but Threadbear cannot reach it/);
    assert.doesNotMatch(f.getSnapshot().problem ?? '', /was started/);
    mock.timers.tick(10 * START_WAIT_MS);
    assert.deepEqual(hurried, [START_WAIT_MS]);
    assert.deepEqual(clicks, ['click']);
    // It is the person who tries again: one more click, one more window, and no more.
    await f.click();
    assert.equal(f.getSnapshot().waiting, true);
    assert.equal(f.getSnapshot().problem, undefined, 'the last account goes while the next try runs');
    mock.timers.tick(START_WAIT_MS);
    assert.deepEqual(hurried, [START_WAIT_MS, START_WAIT_MS]);
    assert.deepEqual(clicks, ['click', 'click']);
  });

  test('a start that did nothing is not waited on: its line and the button stay, and the connection is not hurried', async () => {
    for (const said of ['The runner task is turned off in Task Scheduler, so it was not started.', 'The runner task "x" is not installed, so nothing was started.']) {
      const { f, hurried } = flow(done(said));
      await f.click();
      assert.deepEqual(f.getSnapshot(), { starting: false, choosing: false, waiting: false, note: said });
      assert.equal(startButton(f.getSnapshot()).label, 'Start the runner');
      mock.timers.tick(START_WAIT_MS);
      assert.deepEqual(hurried, []);
      assert.equal(f.getSnapshot().problem, undefined);
    }
  });

  test('a start that failed is the shell\'s words, with the button back and no wait', async () => {
    const { f, hurried } = flow({ kind: 'done', problem: 'The runner could not be started.\n\nAccess is denied.' });
    await f.click();
    assert.deepEqual(f.getSnapshot(), { starting: false, choosing: false, waiting: false, problem: 'The runner could not be started.\n\nAccess is denied.' });
    assert.deepEqual(hurried, []);
  });

  test('a connection that opens while the shell is still answering makes the answer stale', async () => {
    let answer!: (c: StartClick) => void;
    const { f, hurried } = flow(() => new Promise<StartClick>((r) => (answer = r)));
    const click = f.click();
    assert.equal(f.getSnapshot().starting, true);
    f.connection('open');
    assert.deepEqual(f.getSnapshot(), { starting: false, choosing: false, waiting: false });
    answer(done(STARTED));
    await click;
    // Not brought back by a late answer, and the connection is not hurried when it is already up.
    assert.deepEqual(f.getSnapshot(), { starting: false, choosing: false, waiting: false });
    assert.deepEqual(hurried, []);
    mock.timers.tick(START_WAIT_MS);
    assert.equal(f.getSnapshot().problem, undefined);
    // A late "choose" is just as stale.
    answer = () => {};
    const { f: g } = flow(() => new Promise<StartClick>((r) => (answer = r)));
    const c = g.click();
    g.connection('open');
    answer({ kind: 'choose' });
    await c;
    assert.equal(g.getSnapshot().choosing, false);
  });

  test('with none set up the person is asked, and a way chosen is started and waited on like any other start', async () => {
    const { f, hurried, clicks } = flow({ kind: 'choose' });
    await f.click();
    assert.deepEqual(f.getSnapshot(), { starting: false, choosing: true, waiting: false });
    assert.deepEqual(hurried, []);
    const chosen = f.choose('on-demand');
    assert.deepEqual(f.getSnapshot(), { starting: true, choosing: false, waiting: false });
    await chosen;
    assert.equal(f.getSnapshot().waiting, true);
    assert.equal(f.getSnapshot().note, 'The runner is set up and starting.');
    assert.deepEqual(hurried, [START_WAIT_MS]);
    assert.deepEqual(clicks, ['click', 'on-demand']);
    mock.timers.tick(START_WAIT_MS);
    assert.match(f.getSnapshot().problem ?? '', /was started, but Threadbear cannot reach it/);
  });

  test('Not now closes the choice and nothing else', async () => {
    const { f } = flow({ kind: 'choose' });
    f.dismissChoice();
    assert.equal(f.getSnapshot().choosing, false);
    await f.click();
    f.dismissChoice();
    assert.deepEqual(f.getSnapshot(), { starting: false, choosing: false, waiting: false });
  });

  test('a second click while the shell works or the runner is awaited starts nothing twice', async () => {
    let answer!: (c: StartClick) => void;
    const { f, clicks } = flow(() => new Promise<StartClick>((r) => (answer = r)));
    const first = f.click();
    await f.click();
    await f.choose('sign-in');
    answer(done(STARTED));
    await first;
    assert.equal(f.getSnapshot().waiting, true);
    await f.click();
    await f.choose('sign-in');
    assert.deepEqual(clicks, ['click']);
  });

  test('a shell that could not be reached at all ends the click with its words, not a wait', async () => {
    const f = new RunnerStart({ click: () => startClick({ call: async () => Promise.reject('the shell is gone') }), hurry: () => assert.fail('nothing was started'), platform: 'windows' });
    await f.click();
    assert.equal(f.getSnapshot().waiting, false);
    assert.equal(f.getSnapshot().problem, 'the shell is gone');
  });

  test('through the shell\'s own channel: runner_setup, start_runner, then the wait', async () => {
    const s = shell('sign-in', 'NOTE:' + STARTED);
    const hurried: number[] = [];
    const f = new RunnerStart({ click: () => startClick({ call: s.call }), hurry: (ms) => hurried.push(ms), platform: 'linux' });
    await f.click();
    assert.deepEqual(s.calls.map((c) => c.command), ['runner_setup', 'start_runner']);
    assert.equal(f.getSnapshot().waiting, true);
    assert.deepEqual(hurried, [START_WAIT_MS]);
    mock.timers.tick(START_WAIT_MS);
    assert.match(f.getSnapshot().problem ?? '', /~\/\.local\/state\/Threadbear/);
  });

  test('the window can be set shorter, and stop() leaves no timer behind', async () => {
    const { f, hurried } = flow(done(STARTED), { waitMs: 3_000 });
    await f.click();
    assert.deepEqual(hurried, [3_000]);
    f.stop();
    mock.timers.tick(10_000);
    assert.equal(f.getSnapshot().waiting, true, 'stopped: the wait is not ended by a timer of a window that is gone');
    const { f: g } = flow(done(STARTED), { waitMs: 3_000 });
    await g.click();
    mock.timers.tick(3_000);
    assert.equal(g.getSnapshot().waiting, false);
  });

  test('what is read from it only changes when it does, so a page redraws only for a change', async () => {
    const { f, seen } = flow(done(STARTED));
    const before = f.getSnapshot();
    f.connection('closed');
    f.connection('connecting');
    f.dismissChoice();
    assert.equal(f.getSnapshot(), before);
    assert.equal(seen.length, 0);
    await f.click();
    assert.equal(seen.length, 2, 'starting, then waiting');
    f.connection('open');
    f.connection('open');
    assert.equal(seen.length, 3, 'idle once');
  });
});
