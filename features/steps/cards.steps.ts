import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

Then('an approval card asks to run {string}', async function (this: ThreadbearWorld, command: string) {
  await this.until(`an approval for "${command}"`, (d) => d.transcript.rows.some((r) => r.kind === 'approval' && r.text.includes(command)));
});

When('I press {string}', async function (this: ThreadbearWorld, title: string) {
  await this.app.do({ cmd: 'click', title });
});

Then('the approval card has gone', async function (this: ThreadbearWorld) {
  await this.until('no approval card', (d) => !d.transcript.rows.some((r) => r.kind === 'approval'));
});

Then('the approval for {string} says it was denied', async function (this: ThreadbearWorld, command: string) {
  await this.until(`"${command}" denied`, (d) => d.transcript.rows.some((r) => r.kind === 'approval' && r.text.includes(command) && r.text.endsWith('(deny)')));
});

Then('a question card asks {string}', async function (this: ThreadbearWorld, question: string) {
  await this.until(`a question "${question}"`, (d) => d.transcript.rows.some((r) => r.kind === 'question' && r.text === question));
});

When('I pick the answer {string} on the question card', async function (this: ThreadbearWorld, answer: string) {
  await this.until('a question card', (d) => d.transcript.rows.some((r) => r.kind === 'question'));
  await this.app.do({ cmd: 'click', title: answer });
});

When('I send my answer', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'click', title: 'Send answer' });
});

Then('the thread ends with a card of things for me to decide', async function (this: ThreadbearWorld) {
  await this.until('a card of asks', (d) => d.transcript.rows.some((r) => r.kind === 'asks'));
});
