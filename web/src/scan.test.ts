// node --test web/src/scan.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePairing } from './pairing.ts';
import { canScan, readScan, scanCode } from './scan.ts';

const LINK = 'threadbear://pair?url=https%3A%2F%2Fexample-123.convex.cloud&token=abc123&key=r1%3Akey';

test('what the scanner gives is read as text, as a backing out, or as nothing', () => {
  assert.deepEqual(readScan({ text: LINK }), { text: LINK });
  assert.deepEqual(readScan({ cancelled: true }), { cancelled: true });
  assert.equal(readScan({ text: '' }), undefined);
  assert.equal(readScan({ cancelled: false }), undefined);
  assert.equal(readScan({ text: 5 }), undefined);
  assert.equal(readScan({}), undefined);
  assert.equal(readScan(null), undefined);
  assert.equal(readScan('threadbear://pair'), undefined);
  // The desktop build of the plugin answers with neither: no scanner there.
  assert.equal(readScan({ available: false, permission: 'unsupported' }), undefined);
});

test('a code the scanner reads goes through the same check as a pasted link', async () => {
  const calls: unknown[][] = [];
  const scanned = await scanCode(async (command, args) => {
    calls.push([command, args]);
    return { text: LINK };
  });
  assert.deepEqual(calls, [['plugin:threadbear-push|scan', undefined]]);
  assert.ok('text' in scanned);
  assert.deepEqual(parsePairing((scanned as { text: string }).text), { url: 'https://example-123.convex.cloud', token: 'abc123', key: 'r1:key' });
  // Some other code in the world is no pairing, and nothing is offered for it.
  assert.equal(parsePairing('https://example.com/menu'), undefined);
  assert.equal(parsePairing('WIFI:T:WPA;S:cafe;P:secret;;'), undefined);
});

test('backing out of the scanner is an answer and not an error', async () => {
  assert.deepEqual(await scanCode(async () => ({ cancelled: true })), { cancelled: true });
});

test('a scanner that cannot open comes back as the words that say why', async () => {
  await assert.rejects(scanCode(async () => { throw 'The scanner could not open: no Google Play services. You can paste the link instead.'; }), /no Google Play services/);
  await assert.rejects(scanCode(async () => { throw new Error('denied'); }), /denied/);
  await assert.rejects(scanCode(async () => { throw ''; }), /would not open/);
  await assert.rejects(scanCode(async () => ({ text: '' })), /nothing to read/);
  await assert.rejects(scanCode(async () => ({ available: false })), /nothing to read/);
});

test('outside the app there is no scanner to offer', async () => {
  // Here (node, no window and so no Tauri) is outside the app: the defaults find no shell.
  assert.equal(canScan(), false);
  await assert.rejects(scanCode(), /Android app/);
  // With a shell to ask, there is one.
  assert.equal(canScan(async () => undefined), true);
});
