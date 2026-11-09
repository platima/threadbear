import { Then, When } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import type { ThreadbearWorld } from '../support/world.ts';

Then('my message {string} comes before the reply {string}', async function (this: ThreadbearWorld, mine: string, reply: string) {
  const d = await this.app.dump();
  const a = d.transcript.rows.findIndex((r) => r.kind === 'user' && r.text.startsWith(mine));
  const b = d.transcript.rows.findIndex((r) => r.kind === 'assistant' && r.text.startsWith(reply));
  assert.ok(a >= 0 && b >= 0 && a < b, `rows: ${d.transcript.rows.map((r) => r.kind).join(' ')}`);
});

Then('the agent\'s work is folded into a line saying {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until(`a folded line "${text}"`, (d) => d.transcript.rows.some((r) => r.kind === 'group' && r.text === text && !r.expanded));
});

When('I open the line saying {string}', async function (this: ThreadbearWorld, text: string) {
  const row = await this.until(`a line "${text}"`, (d) => d.transcript.rows.find((r) => r.kind === 'group' && r.text === text));
  await this.app.do({ cmd: 'expand', row: row.id });
});

Then('the transcript shows a step starting {string}', async function (this: ThreadbearWorld, words: string) {
  await this.until(`a step "${words}"`, (d) => d.transcript.rows.some((r) => r.inGroup && r.text.startsWith(words)));
});

Then('a turn ends with a line saying {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until(`a footer "${text}"`, (d) => d.transcript.rows.some((r) => r.kind === 'footer' && r.text === text));
});

Then('the transcript has a card saying {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until(`a changes card "${text}"`, (d) => d.transcript.rows.some((r) => r.kind === 'changes' && r.text === text));
});

Then('the transcript shows an error', async function (this: ThreadbearWorld) {
  await this.until('an error row', (d) => d.transcript.rows.some((r) => r.kind === 'error' && r.text.length > 0));
});
