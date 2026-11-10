// What the banner's Start the runner button does when it is clicked: ask the shell how the
// runner is set up, then either start it or say the person has to choose how it should
// start. The choice is made in the page, in plain view, and not in a window the shell
// opens: that window is what the button once left nobody able to see (rc.3), and the
// button just sat on "Starting...".

import { appCommand, pagePlatform, runnerSetup, shellSilent, startRunner, type PagePlatform, type RunnerWay, type StartAnswer } from './native.ts';

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
