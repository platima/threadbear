import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

When('I type {string} in the composer', async function (this: ThreadbearWorld, text: string) {
  await this.app.do({ cmd: 'type', text });
});

When('I press Return', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'return' });
});

When('I press Shift-Return', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'return', shift: true });
});

When('I send {string}', async function (this: ThreadbearWorld, text: string) {
  await this.app.do({ cmd: 'send', text });
});

// `menu-key` is the Mac app's Stop item and the GPUI app's Stop binding.
When('I stop the turn', async function (this: ThreadbearWorld) {
  await this.until('the thread running', (d) => d.selection?.status === 'running');
  await this.app.do({ cmd: 'menu-key', key: '.', modifiers: ['cmd'] });
});

Then('the composer is empty', async function (this: ThreadbearWorld) {
  await this.until('an empty composer', (d) => d.composer.text === '');
});

Then('the composer says {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until(`the composer saying "${text}"`, (d) => d.composer.text === text);
});

Then('the composer holds a new line after {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until(`"${text}" and a new line`, (d) => d.composer.text === `${text}\n`);
});

Then('the reply streams in and the thread goes back to idle', async function (this: ThreadbearWorld) {
  await this.until('the mock\'s reply', (d) => d.transcript.rows.some((r) => r.kind === 'assistant' && r.text.startsWith('You said:')), 30_000);
  await this.until('the thread idle again', (d) => d.selection?.status === 'idle', 30_000);
});

Then('the thread isn\'t running any more', async function (this: ThreadbearWorld) {
  await this.until('the thread stopped', (d) => d.selection?.status !== 'running', 30_000);
});
