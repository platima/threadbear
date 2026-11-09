// What the runner tells the window about itself, besides threads: the Connectors
// gateway's services (connectors.status, connectors.updated) and its own updates
// (hello's `updates`, runner.updates). node --test desktop/src/core/store-news.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fake } from './fake-transport.ts';
import { RpcClient } from './rpc.ts';
import { AppStore } from './store.ts';

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

// A runner that answers hello and the thread list, and connectors.status with what `connectors` says.
function connected(connectors: (params: Record<string, unknown>) => { result?: unknown; error?: { code: number; message: string } }, helloExtra: object = {}) {
  const { t, sent } = fake();
  const rpc = new RpcClient(() => t, { retryMs: 5_000, requestMs: 5_000 });
  const store = new AppStore(rpc);
  const real = t.send;
  t.send = (text) => {
    real(text);
    const m = JSON.parse(text) as { id: number; method: string; params?: Record<string, unknown> };
    queueMicrotask(() => {
      if (m.method === 'hello') t.say({ id: m.id, result: { runnerVersion: 'x', protocol: 1, accounts: [], defaults: {}, ...helloExtra } });
      else if (m.method === 'threads.list') t.say({ id: m.id, result: { threads: [] } });
      else if (m.method === 'connectors.status') t.say({ id: m.id, ...connectors(m.params ?? {}) });
      else t.say({ id: m.id, result: {} });
    });
  };
  store.start();
  t.open();
  return { t, sent, rpc, store };
}

const gateway = (state: 'ok' | 'off' = 'ok') => ({ state, url: 'https://bruce.example.ts.net:7200', services: [{ id: 'gmail', title: 'Gmail', state: 'signed_out' }] });

test('the gateway status is asked for once the runner answers, kept, and replaced when the runner says it changed', async () => {
  const s = connected(() => ({ result: { connectors: gateway() } }));
  await until(() => s.store.getSnapshot().connectors !== undefined);
  assert.equal(s.store.getSnapshot().connectors?.services[0]?.title, 'Gmail');
  assert.deepEqual(s.sent.find((m) => m.method === 'connectors.status')?.params, {}, 'not a refresh: the runner looks by itself');

  s.t.say({ method: 'connectors.updated', params: { connectors: { ...gateway(), services: [{ id: 'gmail', title: 'Gmail', state: 'connected' }] } } });
  assert.equal(s.store.getSnapshot().connectors?.services[0]?.state, 'connected');

  await s.store.loadConnectors(true);
  assert.deepEqual(s.sent.filter((m) => m.method === 'connectors.status').at(-1)?.params, { refresh: true }, 'the page asks for a fresh look');
  s.rpc.stop();
});

test("a runner from before Connectors has none and the page is left out; another failure keeps what was known", async () => {
  let reply: ReturnType<Parameters<typeof connected>[0]> = { result: { connectors: gateway() } };
  const s = connected(() => reply);
  await until(() => s.store.getSnapshot().connectors !== undefined);
  reply = { error: { code: -32000, message: 'the gateway is thinking' } };
  await s.store.loadConnectors(true);
  assert.ok(s.store.getSnapshot().connectors, 'a failed ask leaves the last answer');
  reply = { error: { code: -32601, message: 'Method not found' } };
  await s.store.loadConnectors(true);
  assert.equal(s.store.getSnapshot().connectors, undefined, 'a runner that has never heard of it has none');
  s.rpc.stop();
});

test("the runner's own update state comes with hello and is replaced by runner.updates", async () => {
  const first = { state: 'idle', oldRunners: [], commit: 'abc1234' };
  const s = connected(() => ({ result: { connectors: gateway('off') } }), { updates: first });
  await until(() => s.store.getSnapshot().hello !== undefined);
  assert.deepEqual(s.store.getSnapshot().hello?.updates, first);
  s.t.say({ method: 'runner.updates', params: { updates: { state: 'building', oldRunners: [{ version: '1', threads: ['t'] }] } } });
  assert.equal(s.store.getSnapshot().hello?.updates?.state, 'building');
  assert.equal(s.store.getSnapshot().hello?.updates?.oldRunners.length, 1);
  s.rpc.stop();
});

test('an update notice before the runner has answered hello is ignored, not made into half a hello', () => {
  const { t } = fake();
  const store = new AppStore(new RpcClient(() => t, { retryMs: 5_000 }));
  store.start();
  t.open();
  t.say({ method: 'runner.updates', params: { updates: { state: 'idle', oldRunners: [] } } });
  assert.equal(store.getSnapshot().hello, undefined);
});
