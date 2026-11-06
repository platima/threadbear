// node --test desktop/src/core/updates.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkForUpdate, isNewer, pick, releaseUrl, setUpdateCheck, updateCheckOn } from './updates.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
};
// Storage that is blocked, the way a web view with storage turned off is.
const blocked = {
  getItem(): string | null {
    throw new Error('storage is blocked');
  },
  setItem(): void {
    throw new Error('storage is blocked');
  },
};
const base = 'https://github.com/platima/threadbear/releases';
const release = (tag: string, extra: object = {}) => ({
  tag_name: tag,
  html_url: `${base}/tag/${tag}`,
  assets: [
    { name: `threadbear-${tag}-setup-win-x64.exe`, browser_download_url: `${base}/download/${tag}/threadbear-${tag}-setup-win-x64.exe` },
    { name: `threadbear-${tag}-setup-win-arm64.exe`, browser_download_url: `${base}/download/${tag}/threadbear-${tag}-setup-win-arm64.exe` },
    { name: `threadbear-${tag}-msi-win-x64.msi`, browser_download_url: `${base}/download/${tag}/threadbear-${tag}-msi-win-x64.msi` },
  ],
  ...extra,
});
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const answering = (counter: { asked: number }, body: unknown = release('v0.2.0')) => async () => {
  counter.asked++;
  return { ok: true, json: async () => body };
};

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

test('pre-releases compare part by part: rc.10 is after rc.2, numbers are below words, a shorter run is older', () => {
  assert.equal(isNewer('1.0.0-rc.10', '1.0.0-rc.2'), true);
  assert.equal(isNewer('1.0.0-rc.2', '1.0.0-rc.10'), false);
  assert.equal(isNewer('1.0.0-rc10', '1.0.0-rc2'), false); // one word: rc10 is before rc2 by its letters, as semver has it
  assert.equal(isNewer('1.0.0-beta', '1.0.0-alpha'), true);
  assert.equal(isNewer('1.0.0-alpha.1', '1.0.0-alpha'), true);
  assert.equal(isNewer('1.0.0-alpha', '1.0.0-alpha.1'), false);
  assert.equal(isNewer('1.0.0-alpha.beta', '1.0.0-alpha.1'), true);
  assert.equal(isNewer('1.0.0-1', '1.0.0-alpha'), false);
  assert.equal(isNewer('1.0.0-rc.1', '1.0.0-rc.1'), false);
  assert.equal(isNewer('1.0.0+build5', '1.0.0+build4'), false); // build parts do not count
});

test('only whole versions are versions', () => {
  for (const bad of ['1.2.3garbage', '1.2', '1.2.3.4', 'v', '1.2.3-', '1.2.3-a..b', '', ' ', '1.2.3 and more', '1.2.x', '-1.2.3', '1.2.3-rc 1']) {
    assert.equal(isNewer(bad, '0.0.1'), false, `${bad} is not a version`);
    assert.equal(isNewer('9.9.9', bad), false, `nothing is newer than ${bad}`);
  }
  assert.equal(isNewer(' v1.2.3 ', '1.2.2'), true);
});

test('the download is the setup exe for this architecture, else just the page', () => {
  assert.deepEqual(pick(release('v0.2.0'), '0.1.0', 'x64'), { version: '0.2.0', page: `${base}/tag/v0.2.0`, download: `${base}/download/v0.2.0/threadbear-v0.2.0-setup-win-x64.exe` });
  assert.equal(pick(release('v0.2.0'), '0.1.0', 'arm64')?.download, `${base}/download/v0.2.0/threadbear-v0.2.0-setup-win-arm64.exe`);
  assert.equal(pick(release('v0.2.0', { assets: [] }), '0.1.0', 'x64')?.download, undefined);
  assert.equal(pick(release('v0.2.0', { prerelease: true }), '0.1.0', 'x64'), undefined);
  assert.equal(pick(release('v0.2.0', { draft: true }), '0.1.0', 'x64'), undefined);
  assert.equal(pick(release('v0.1.0'), '0.1.0', 'x64'), undefined);
});

test('addresses from GitHub are shown only if they are https, on github.com, under this repository', () => {
  assert.equal(releaseUrl(`${base}/tag/v1`), `${base}/tag/v1`);
  assert.equal(releaseUrl('https://GitHub.com/Platima/Threadbear/releases/tag/v1'), 'https://github.com/Platima/Threadbear/releases/tag/v1');
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://github.com/platima/threadbear/releases/tag/v1',
    'https://evil.example/platima/threadbear/releases/tag/v1',
    'https://github.com.evil.example/platima/threadbear/releases/tag/v1',
    'https://user:pass@github.com/platima/threadbear/releases/tag/v1',
    'https://github.com:8443/platima/threadbear/releases/tag/v1',
    'https://github.com/someone-else/threadbear/releases/tag/v1',
    'https://github.com/platima/threadbear-evil/releases/tag/v1',
    'https://github.com/platima/threadbear/issues/1',
    'https://github.com/platima/threadbear/releases/../../../evil/x/releases/tag/v1',
    '//github.com/platima/threadbear/releases/tag/v1',
    'not a url',
    '',
    undefined,
    42,
    null,
  ]) {
    assert.equal(releaseUrl(bad), undefined, String(bad));
  }
});

test('a release with a page or download outside GitHub is not offered as it came', () => {
  assert.equal(pick(release('v0.2.0', { html_url: 'javascript:alert(1)' }), '0.1.0', 'x64'), undefined);
  assert.equal(pick(release('v0.2.0', { html_url: 'https://evil.example/x' }), '0.1.0', 'x64'), undefined);
  assert.equal(pick(release('v0.2.0', { html_url: undefined }), '0.1.0', 'x64'), undefined);
  const odd = release('v0.2.0', { assets: [{ name: 'threadbear-setup-win-x64.exe', browser_download_url: 'https://evil.example/setup-win-x64.exe' }] });
  const got = pick(odd, '0.1.0', 'x64');
  assert.equal(got?.page, `${base}/tag/v0.2.0`);
  assert.equal(got?.download, undefined, 'the page is still offered, the download is not');
  assert.equal(pick(release('v0.2.0-not-a-version!'), '0.1.0', 'x64'), undefined);
  assert.equal(pick(release('v0.2.0garbage'), '0.1.0', 'x64'), undefined);
});

test('it asks GitHub once a day, not on every start', async () => {
  const store = memory();
  const c = { asked: 0 };
  const fetch = answering(c);
  assert.equal((await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch, now: 1000 }))?.version, '0.2.0');
  assert.equal((await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch, now: 1000 + DAY - 1 }))?.version, '0.2.0');
  assert.equal(c.asked, 1);
  await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch, now: 1000 + DAY });
  assert.equal(c.asked, 2);
  // Once the app is updated past what was found, the kept answer no longer shows.
  assert.equal(await checkForUpdate({ current: '0.2.0', arch: 'x64', store, fetch, now: 1000 + DAY + 5 }), undefined);
});

test('turned off, it never asks; a failure is no update, not an error', async () => {
  const store = memory();
  assert.equal(setUpdateCheck(store, false), true);
  assert.equal(updateCheckOn(store), false);
  const c = { asked: 0 };
  assert.equal(await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch: answering(c) }), undefined);
  assert.equal(c.asked, 0);
  // Check now still works with it off.
  assert.equal((await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch: answering(c), force: true }))?.version, '0.2.0');
  const offline = async () => {
    throw new Error('offline');
  };
  assert.equal(await checkForUpdate({ current: '0.1.0', arch: 'x64', store: memory(), fetch: offline }), undefined);
  assert.equal(await checkForUpdate({ current: '0.1.0', arch: 'x64', store: memory(), fetch: async () => ({ ok: false, json: async () => ({}) }) }), undefined);
});

test('a setting that cannot be read counts as off, so a lost choice never sends a request', async () => {
  assert.equal(updateCheckOn(blocked), false);
  const c = { asked: 0 };
  assert.equal(await checkForUpdate({ current: '0.1.0', arch: 'x64', store: blocked, fetch: answering(c) }), undefined);
  assert.equal(c.asked, 0);
  // Nothing set yet (a fresh install) is the default, which is on.
  assert.equal(updateCheckOn(memory()), true);
  // Turning it on or off where nothing can be kept says so.
  assert.equal(setUpdateCheck(blocked, true), false);
  const forgetful = { getItem: () => null, setItem: () => {} };
  assert.equal(setUpdateCheck(forgetful, false), false);
});

test('a failed check is remembered, and the next one waits longer each time up to a day', async () => {
  const store = memory();
  const c = { asked: 0 };
  const failing = async () => {
    c.asked++;
    throw new Error('offline');
  };
  const at = (now: number) => checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch: failing, now });
  let now = 10 * DAY;
  await at(now);
  assert.equal(c.asked, 1);
  // The same start-up again, a minute later, does not ask.
  await at(now + 60_000);
  assert.equal(c.asked, 1);
  // After an hour it may.
  now += HOUR;
  await at(now);
  assert.equal(c.asked, 2);
  // Then two hours, four, eight, sixteen, and from there a day.
  for (const wait of [2, 4, 8, 16, 24, 24]) {
    const before: number = c.asked;
    await at(now + wait * HOUR - 1);
    assert.equal(c.asked, before, `${wait} h not yet`);
    now += wait * HOUR;
    await at(now);
    assert.equal(c.asked, before + 1, `${wait} h later`);
  }
  // A good answer clears it.
  const ok = { asked: 0 };
  assert.equal((await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch: answering(ok), now: now + DAY }))?.version, '0.2.0');
  assert.equal((await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch: answering(ok), now: now + DAY + 5 * 60_000 }))?.version, '0.2.0');
  assert.equal(ok.asked, 1);
});

test('a failure does not make an update that was found earlier disappear', async () => {
  const store = memory();
  const c = { asked: 0 };
  await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch: answering(c), now: 0 });
  const offline = async () => {
    throw new Error('offline');
  };
  assert.equal((await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch: offline, now: DAY }))?.version, '0.2.0');
});

test('a kept answer with a bad address in it is not trusted', async () => {
  const store = memory();
  store.setItem('threadbear.update', JSON.stringify({ at: 1000, found: { version: '9.9.9', page: 'javascript:alert(1)' } }));
  const c = { asked: 0 };
  const got = await checkForUpdate({ current: '0.1.0', arch: 'x64', store, fetch: answering(c), now: 1001 });
  assert.equal(c.asked, 1, 'asked again rather than using it');
  assert.equal(got?.page, `${base}/tag/v0.2.0`);
});
