// What the banner's Start the runner button does when it is clicked: ask the shell how the
// runner is set up, then either start it or say the person has to choose how it should
// start. The choice is made in the page, in plain view, and not in a window the shell
// opens: that window is what the button once left nobody able to see (rc.3), and the
// button just sat on "Starting...".

import { appCommand, pagePlatform, runnerSetup, shellLogFolder, shellSilent, startRunner, type PagePlatform, type RunnerWay, type StartAnswer } from './native.ts';
import type { ConnState } from './rpc.ts';

export type StartClick = { kind: 'choose' } | ({ kind: 'done' } & StartAnswer);

// `using` is the shell's channel; the tests pass their own.
export async function startClick(using: Parameters<typeof startRunner>[1] = {}): Promise<StartClick> {
  const setup = await runnerSetup(using);
  // A shell that did not answer is the answer: asking it again would wait as long again.
  if (setup === 'silent') return { kind: 'done', problem: shellSilent() };
  // No task of ours: nothing to start, so the person is asked how it should start.
  if (setup === 'none') return { kind: 'choose' };
  // Set up, or the shell would not say: start it, and say what it says either way.
  return { kind: 'done', ...(await startRunner('start', using)) };
}

// The ways to set the runner up, for the page's two buttons (the shell runs the same install
// script for each, and a task of the person's own; no admin rights).
export const RUNNER_WAYS: { way: Exclude<RunnerWay, 'start'>; label: string; tip: string }[] = [
  { way: 'on-demand', label: 'Only while Threadbear is open', tip: 'Starts the runner when you open Threadbear and stops it when you quit. Nothing starts when you sign in.' },
  { way: 'sign-in', label: 'When I sign in', tip: 'Starts the runner when you sign in and leaves it running, with or without Threadbear open.' },
];

// What the choice says it does, which differs by system: the task, where `tb` goes and how
// both are taken out again (the program is named as it is typed in a terminal opened in
// the folder it is installed in, so it works when it is not on the PATH).
export function runnerChoiceText(platform: PagePlatform = pagePlatform()): string {
  const uninstall = `${appCommand(platform)} --runner --uninstall`;
  const how =
    platform === 'windows'
      ? `It adds a Task Scheduler task for your account (no admin rights) and puts the tb command on your PATH. ${uninstall} removes both.`
      : `It adds a systemd user service for your account (no root) and puts the tb command in ~/.local/bin (add that folder to your PATH if it is not there). ${uninstall} removes both.`;
  return `The runner isn't set up on this PC, and Threadbear does nothing without it. Choose how it should start. ${how}`;
}

// ---- after the shell has said it started the runner -------------------------------------------
//
// The shell answers when it has run the start, not when the runner is listening: that takes a few
// seconds more, and the page's connection is still closed, waiting out its retry delay (which
// grows to five seconds). Showing "Started the runner." beside a button that still says Start the
// runner (rc.4) tells the person to click again. So after a start that did something, the page asks
// the connection to try now and go on trying quickly for START_WAIT_MS, shows that it is waiting
// where the button was, and drops all of it the moment the connection opens. If the window ends
// without one, the button comes back with an honest account. A click is a single window: nothing
// here starts the runner again by itself.

// How long a start is waited on, quickly. The first start after an install or an update can take
// longer (the runner fetches the Agent SDK), so the connection does not stop trying after this: it
// goes back to its slower retries, and a connection that comes later still clears the message.
export const START_WAIT_MS = 20_000;

// What the shell's line about a start comes to: it 'started' the runner (or set it up and started
// it), it found it 'running' already, or it did 'nothing' (the task is turned off or not
// installed), in which case there is nothing to wait for. A line that is not one of its known
// ones is a start, since the script exits 0 only for a start or for one of these.
export type StartOutcome = 'started' | 'running' | 'nothing';

export function startOutcome(note: string | undefined): StartOutcome {
  if (note && /\bnot started\b|nothing was started|not installed|turned off/i.test(note)) return 'nothing';
  if (note && /already running/i.test(note)) return 'running';
  return 'started';
}

// What is said when the window ends and the runner has not answered: that it was told to start (or
// said to be running), that the page cannot reach it, that it goes on trying, and where the shell
// wrote what it did.
export function notReachedText(outcome: Exclude<StartOutcome, 'nothing'>, platform: PagePlatform = pagePlatform()): string {
  const lead = outcome === 'running' ? 'The app was told the runner is already running, but Threadbear cannot reach it.' : 'The runner was started, but Threadbear cannot reach it yet. The first start after an install or an update can take a while.';
  return `${lead} It keeps trying, and this goes away when the runner answers. What the app did is in shell.log, in ${shellLogFolder(platform)}.`;
}

// What the banner shows of a start. `problem` and `note` are the shell's words (or the account of
// a start that never got an answer); `choosing` offers the two ways to set the runner up.
export type StartView = {
  starting: boolean; // the shell is working on a click
  choosing: boolean;
  waiting: boolean; // the shell started the runner, and the connection is being brought up
  problem?: string;
  note?: string;
};

// What the banner's button says for a view: the same button for all three, but disabled and busy
// while the shell is working or the runner is being waited for.
export function startButton(view: Pick<StartView, 'starting' | 'waiting'>): { label: string; busy: boolean; tip: string } {
  if (view.waiting) return { label: 'Waiting for the runner to answer...', busy: true, tip: 'The runner was started. Threadbear is trying to reach it, which takes a few seconds, and this goes away when it does' };
  if (view.starting) return { label: 'Starting...', busy: true, tip: 'Working on it: waiting for the runner to start' };
  return { label: 'Start the runner', busy: false, tip: 'Start the runner, or choose how it should start if none is set up' };
}

const IDLE: StartView = { starting: false, choosing: false, waiting: false };

export type RunnerStartDeps = {
  /** The shell's answer to a click on the button, and to a way chosen on the page (startClick, startRunner). */
  click?: () => Promise<StartClick>;
  start?: (way: RunnerWay) => Promise<StartAnswer>;
  /** Asks the connection to try now, and to keep trying quickly for this long (RpcClient.retryNow). */
  hurry: (ms: number) => void;
  waitMs?: number;
  platform?: PagePlatform;
};

// The state behind the banner's button, outside React so each rule can be tested: the click, the
// wait, the end of the wait and the connection opening. Read it with useSyncExternalStore
// (subscribe, getSnapshot) and tell it each connection state with connection().
export class RunnerStart {
  private view: StartView = IDLE;
  // Which click's answer may still be shown. A connection that opens while the shell is still
  // answering makes that answer stale (it would bring back the note, the error or the choice the
  // open just cleared, and the next disconnect would show them), so opening moves this on and each
  // click only shows its answer if it is still the current one.
  private attempt = 0;
  private outcome: Exclude<StartOutcome, 'nothing'> = 'started';
  private timer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<() => void>();
  private readonly deps: RunnerStartDeps;

  constructor(deps: RunnerStartDeps) {
    this.deps = deps;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): StartView => this.view;

  private show(view: StartView): void {
    this.view = view;
    for (const l of this.listeners) l();
  }

  private begin(): number {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.show({ ...IDLE, starting: true });
    return ++this.attempt;
  }

  // The button: start the runner, or find out that the person has to choose how.
  async click(): Promise<void> {
    if (this.view.starting || this.view.waiting) return;
    const mine = this.begin();
    const clicked = await (this.deps.click ?? startClick)();
    if (mine !== this.attempt) return;
    if (clicked.kind === 'choose') this.show({ ...IDLE, choosing: true });
    else this.answered(clicked);
  }

  // One of the two ways offered when none is set up.
  async choose(way: RunnerWay): Promise<void> {
    if (this.view.starting || this.view.waiting) return;
    const mine = this.begin();
    const answer = await (this.deps.start ?? startRunner)(way);
    if (mine !== this.attempt) return;
    this.answered(answer);
  }

  // "Not now" on the choice.
  dismissChoice(): void {
    if (this.view.choosing) this.show(IDLE);
  }

  private answered(answer: StartAnswer): void {
    if (answer.problem) return this.show({ ...IDLE, problem: answer.problem });
    const outcome = startOutcome(answer.note);
    // The shell did nothing (turned off, not installed): its line stays, and the button with it.
    if (outcome === 'nothing') return this.show({ ...IDLE, note: answer.note });
    this.outcome = outcome;
    this.show({ ...IDLE, waiting: true, note: answer.note ?? 'The runner is starting.' });
    const mine = this.attempt;
    const ms = this.deps.waitMs ?? START_WAIT_MS;
    this.timer = setTimeout(() => this.gaveUp(mine), ms);
    this.deps.hurry(ms);
  }

  // The window ended and the connection has not opened.
  private gaveUp(mine: number): void {
    if (mine !== this.attempt) return;
    this.timer = undefined;
    this.show({ ...IDLE, problem: notReachedText(this.outcome, this.deps.platform) });
  }

  // Every state of the page's connection, as it changes. Opening, however it came about, makes
  // nothing from the last click true any more.
  connection(state: ConnState): void {
    if (state !== 'open') return;
    this.attempt++;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.view !== IDLE) this.show(IDLE);
  }

  // The window is going away: no timer outlives it.
  stop(): void {
    this.attempt++;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
