// What the banner's Start the runner button does when it is clicked: ask the shell how the
// runner is set up, then either start it or say the person has to choose how it should
// start. The choice is made in the page, in plain view, and not in a window the shell
// opens: that window is what the button once left nobody able to see (rc.3), and the
// button just sat on "Starting...".

import { runnerSetup, startRunner, type RunnerWay } from './native.ts';

export type StartClick = { kind: 'choose' } | { kind: 'done'; problem?: string };

// `using` is the shell's channel; the tests pass their own.
export async function startClick(using: Parameters<typeof startRunner>[1] = {}): Promise<StartClick> {
  // No task of ours: nothing to start, so the person is asked how it should start.
  if ((await runnerSetup(using)) === 'none') return { kind: 'choose' };
  // Set up, or the shell would not say: start it, and say what it says if it can't.
  return { kind: 'done', problem: await startRunner('start', using) };
}

// The ways to set the runner up, for the page's two buttons (the shell runs the same install
// script for each, and a task of the person's own; no admin rights).
export const RUNNER_WAYS: { way: Exclude<RunnerWay, 'start'>; label: string; tip: string }[] = [
  { way: 'on-demand', label: 'Only while Threadbear is open', tip: 'Starts the runner when you open Threadbear and stops it when you quit. Nothing starts when you sign in to the PC.' },
  { way: 'sign-in', label: 'When I sign in', tip: 'Starts the runner when you sign in to the PC and leaves it running, with or without Threadbear open.' },
];

export const RUNNER_CHOICE_TEXT =
  "The runner isn't set up on this PC, and Threadbear does nothing without it. Choose how it should start. Either way it adds a background task for your account (a Task Scheduler task on Windows, a systemd user service on Linux; no admin rights or root) and puts the tb command on your PATH. Threadbear --runner --uninstall removes both.";
