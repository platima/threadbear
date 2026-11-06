// node --test desktop/src/core/updates.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkForUpdate, isNewer, pick, setUpdateCheck, updateCheckOn } from './updates.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const release = (tag: string, extra: object = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/platima/threadbear/releases/tag/${tag}`,
  assets: [
    { name: `threadbear-${tag}-setup-win-x64.exe`, browser_download_url: 'https://example.test/x64.exe' },
    { name: `threadbear-${tag}-setup-win-arm64.exe`, browser_download_url: 'https://example.test/arm64.exe' },
    { name: `threadbear-${tag}-msi-win-x64.msi`, browser_download_url: 'https://example.test/x64.msi' },
  ],
  ...extra,
});

test('versions compare as numbers, and a pre-release is older than its release', () => {
  assert.equal(isNewer('v0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.1.1', '0.1.0'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.1.0', '0.1.1'), false);
  assert.equal(isNewer('v0.2.0', '0.2.0-rc1'), true);
  assert.equal(isNewer('0.2.0-rc1', '0.2.0'), false);
  assert.equal(isNewer('0.2.0-rc2', '0.2.0-rc1'), true);
  assert.equal(isNewer('nonsense', '0.1.0'), false);
});

test('the download is the setup exe for this architecture, else just the page', () => {
  assert.deepEqual(pick(release('v0.2.0'), '0.1.0', 'x64'), { version: '0.2.0', page: 'https://github.com/platima/threadbear/releases/tag/v0.2.0', download: 'https://example.test/x64.exe' });
  assert.equal(pick(release('v0.2.0'), '0.1.0', 'arm64')?.download, 'https://example.test/arm64.exe');
  assert.equal(pick(release('v0.2.0', { assets: [] }), '0.1.0', 'x64')?.download, undefined);
  assert.equal(pick(release('v0.2.0', { prerelease: true }), '0.1.0', 'x64'), undefined);
  assert.equal(pick(release('v0.2.0', { draft: true }), '0.1.0', 'x64'), undefined);
  assert.equal(pick(release('v0.1.0'), '0.1.0', 'x64'), undefined);
});

test('it asks GitHub once a day, not on every start', async () => {
  const store = memory();
  let asked = 0;
  const fetch = async () => {
    asked++;
    return { ok: true, json: async () => release('v0.2.0') };
  };
  const day = 24 * 60 * 60 * 1000;
  assert.equal((await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch, now: 1000 }))?.version, '0.2.0');
  assert.equal((await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch, now: 1000 + day - 1 }))?.version, '0.2.0');
  assert.equal(asked, 1);
  await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch, now: 1000 + day });
  assert.equal(asked, 2);
  // Once the app is updated past what was found, the kept answer no longer shows.
  assert.equal(await checkForUpdate({ current: '0.2.0', arch: 'x64', store, fetch, now: 1000 + day + 5 }), undefined);
});

test('turned off, it never asks; a failure is no update, not an error', async () => {
  const store = memory();
  setUpdateCheck(store, false);
  assert.equal(updateCheckOn(store), false);
  let asked = 0;
  const fetch = async () => {
    asked++;
    return { ok: true, json: async () => release('v0.2.0') };
  };
  assert.equal(await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch }), undefined);
  assert.equal(asked, 0);
  // Check now still works with it off.
  assert.equal((await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch, force: true }))?.version, '0.2.0');
  const offline = async () => {
    throw new Error('offline');
  };
  assert.equal(await checkForUpdate({ current: '0.1.0', arch: 'x64', store: memory(), fetch: offline }), undefined);
  assert.equal(await checkForUpdate({ current: '0.1.0', arch: 'x64', store: memory(), fetch: async () => ({ ok: false, json: async () => ({}) }) }), undefined);
});
