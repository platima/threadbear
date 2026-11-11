import { Then, When } from '@cucumber/cucumber';
import type { Dump } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

// The Projects page and a project's page, with the projectDecisions
// experiment's Decisions section (`projectDecisions` in the dump: one line a
// thread, "Title: first ask | second ask", "(sending)" while it's on its way).
type WithProjects = Dump & { projectCards?: string[] | null; projectDecisions?: string[] | null };

const decisionLines = (d: Dump): string[] => (d as WithProjects).projectDecisions ?? [];

When('I show the Projects page', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mode', mode: 'projects' });
});

When('I open the project {string}', async function (this: ThreadbearWorld, title: string) {
  await this.app.do({ cmd: 'project', title });
});

Then('the project card {string} says {string}', async function (this: ThreadbearWorld, title: string, words: string) {
  await this.until(`the "${title}" card saying "${words}"`, (d) =>
    ((d as WithProjects).projectCards ?? []).some((line) => line.startsWith(`${title}: `) && line.includes(words)));
});

Then('the project\'s decisions include {string} asking {string}', async function (this: ThreadbearWorld, title: string, ask: string) {
  await this.until(`a decision from "${title}" asking "${ask}"`, (d) =>
    decisionLines(d).some((line) => line.startsWith(`${title}: `) && line.includes(ask)));
});

Then('the project\'s decisions don\'t include {string}', async function (this: ThreadbearWorld, title: string) {
  await this.until(`no decision from "${title}"`, (d) => !decisionLines(d).some((line) => line.startsWith(`${title}: `)));
});

When('I pick answer {int} of ask {int} on the decision from {string}', async function (this: ThreadbearWorld, choice: number, ask: number, title: string) {
  await this.app.do({ cmd: 'decision', thread: title, pick: `${ask}:${choice}` });
});

// The folded Projects view: a folded project's section lists no threads and
// says how many it has.
Then('the sidebar\'s project {string} is folded with {int} threads', async function (this: ThreadbearWorld, title: string, count: number) {
  await this.until(`"${title}" folded with ${count} threads`, (d) =>
    d.sidebar.sections.some((s) => s.name === title && s.collapsed === true && s.threads.length === 0 && s.count === count));
});

When('I open the sidebar\'s project {string}', async function (this: ThreadbearWorld, title: string) {
  await this.app.do({ cmd: 'expand', projectRow: title });
});

When('I fold the sidebar\'s project {string}', async function (this: ThreadbearWorld, title: string) {
  await this.app.do({ cmd: 'collapse', projectRow: title });
});

Then('the sidebar lists {string} under {string}', async function (this: ThreadbearWorld, thread: string, title: string) {
  await this.until(`"${thread}" under "${title}"`, (d) =>
    d.sidebar.sections.some((s) => s.name === title && s.collapsed === false && s.threads.some((t) => t.title === thread)));
});
