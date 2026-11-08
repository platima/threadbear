import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushRegister, pushStatus, readRegistration, readStatus, saveToken, savedToken, tauriInvoke } from './push.ts';

const KEY = 'A'.repeat(43) + '=';

test('the status is what the plugin says, and nothing else is a status', () => {
  assert.deepEqual(readStatus({ available: true, permission: 'granted' }), { available: true, permission: 'granted' });
  assert.deepEqual(readStatus({ available: false, permission: 'unsupported', extra: 1 }), { available: false, permission: 'unsupported' });
  for (const bad of [null, undefined, 'x', 1, {}, { available: 'yes', permission: 'granted' }, { available: true }, { available: true, permission: 3 }]) {
    assert.equal(readStatus(bad), undefined, JSON.stringify(bad));
  }
});

test('a registration needs a token and a key of 32 bytes in base64', () => {
  assert.deepEqual(readRegistration({ token: 'tok:APA91b', key: KEY, permission: 'granted' }), { token: 'tok:APA91b', key: KEY });
  for (const bad of [null, {}, { token: '', key: KEY }, { token: 'tok', key: 'short' }, { token: 'tok', key: 'A'.repeat(44) }, { token: 1, key: KEY }, { token: 'tok', key: KEY.slice(0, 42) + '$=' }]) {
    assert.equal(readRegistration(bad), undefined, JSON.stringify(bad));
  }
});

test('in a browser there is no plugin, and asking for one does nothing', async () => {
  assert.equal(tauriInvoke({}), undefined);
  assert.equal(await pushStatus(undefined), undefined);
  await assert.rejects(pushRegister(undefined), /Android app/);
});

test('the page asks the plugin by its command names', async () => {
  const asked: string[] = [];
  const invoke = async (command: string) => {
    asked.push(command);
    return command.endsWith('status') ? { available: true, permission: 'prompt' } : { token: 'tok:APA91b', key: KEY };
  };
  assert.deepEqual(await pushStatus(invoke), { available: true, permission: 'prompt' });
  assert.deepEqual(await pushRegister(invoke), { token: 'tok:APA91b', key: KEY });
  assert.deepEqual(asked, ['plugin:threadbear-push|status', 'plugin:threadbear-push|register']);
  // Through Tauri's internals, which is what the page has
  const calls: unknown[][] = [];
  const viaTauri = tauriInvoke({ __TAURI_INTERNALS__: { invoke: async (...a: unknown[]) => (calls.push(a), { available: false, permission: 'unsupported' }) } });
  assert.deepEqual(await pushStatus(viaTauri), { available: false, permission: 'unsupported' });
  assert.deepEqual(calls, [['plugin:threadbear-push|status', undefined]]);
});

test('a shell with no plugin, or a refusal, is said in words', async () => {
  assert.equal(await pushStatus(async () => Promise.reject('plugin not found')), undefined);
  assert.equal(await pushStatus(async () => ({ nonsense: true })), undefined);
  await assert.rejects(pushRegister(async () => Promise.reject('Notifications were not allowed for this app')), /Notifications were not allowed/);
  await assert.rejects(pushRegister(async () => Promise.reject(new Error('Firebase gave no token: x'))), /Firebase gave no token/);
  await assert.rejects(pushRegister(async () => Promise.reject(undefined)), /would not register/);
  await assert.rejects(pushRegister(async () => ({ token: 'tok', key: 'bad' })), /no usable token/);
});

test('the token it registered with is kept, and kept out of the way when storage is off', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  assert.equal(savedToken(storage), undefined);
  saveToken('tok:APA91b', storage);
  assert.equal(savedToken(storage), 'tok:APA91b');
  saveToken(undefined, storage);
  assert.equal(savedToken(storage), undefined);
  const broken = {
    getItem: () => {
      throw new Error('off');
    },
    setItem: () => {
      throw new Error('off');
    },
    removeItem: () => {
      throw new Error('off');
    },
  };
  assert.equal(savedToken(broken), undefined);
  assert.doesNotThrow(() => saveToken('x', broken));
  assert.doesNotThrow(() => saveToken(undefined, broken));
});
