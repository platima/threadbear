// node --test desktop/src/core/store.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fake } from './fake-transport.ts';
import { RpcClient } from './rpc.ts';
import { AppStore } from './store.ts';
import { APP_VERSION } from './version.ts';

const THREAD = 't1';
const user = (seq: number) => ({ seq, ts: '2026-01-01T00:00:00Z', threadId: THREAD, turnId: `turn${seq}`, type: 'user.message', text: `message ${seq}`, images: [] });
const summary = (over: object = {}) => ({ id: THREAD, title: 'T', status: 'idle', lastSeq: 13, lastSeenSeq: 13, ...over });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => user(from + i));

// A store on a hand-driven carrier, with a runner that has 13 messages and
// answers a page of five at a time. Requests wait until the test lets them go.
function setup(opts: { fail?: (m: { method?: string; params?: Record<string, unknown> }) => boolean } = {}) {
  const { t, sent } = fake();
  const rpc = new RpcClient(() => t, { retryMs: 5_000, requestMs: 5_000 });
  const store = new AppStore(rpc);
  const held: { id: number; method: string; params: Record<string, unknown> }[] = [];
  let hold = false;
  const answer = (id: number, method: string, params: Record<string, unknown>): void => {
    if (opts.fail?.({ method, params })) return t.say({ id, error: { code: -32000, message: `${method} failed` } });
    switch (method) {
      case 'hello':
        return t.say({ id, result: { runnerVersion: 'x', protocol: 1, accounts: [], defaults: {} } });
      case 'threads.list':
        return t.say({ id, result: { threads: [summary()] } });
      case 'threads.events': {
        const before = (params.beforeSeq as number | undefined) ?? 14;
        const to = before - 1;
        const from = Math.max(1, to - 4);
        const events = to < 1 ? [] : range(from, to);
        return t.say({ id, result: { events, firstSeq: events[0]?.seq ?? before, lastSeq: 13, inProgress: [] } });
      }
      case 'threads.subscribe':
        return t.say({ id, result: { events: [], inProgress: [] } });
      case 'reviews.list':
        return t.say({ id, result: { reviews: [] } });
      default:
        return t.say({ id, result: {} });
    }
  };
  // The test sees each request as it is sent; `hold` keeps the thread-event ones waiting.
  const real = t.send;
  t.send = (text) => {
    real(text);
    const m = JSON.parse(text) as { id: number; method: string; params: Record<string, unknown> };
    if (hold && m.method === 'threads.events' && m.params.beforeSeq !== undefined) held.push(m);
    else queueMicrotask(() => answer(m.id, m.method, m.params ?? {}));
  };
  return {
    t,
    sent,
    rpc,
    store,
    holdEarlier: () => (hold = true),
    release: () => {
      hold = false;
      for (const m of held.splice(0)) answer(m.id, m.method, m.params);
    },
    held,
    async connect() {
      store.start();
      t.open();
      await until(() => store.getSnapshot().conn === 'open' && store.getSnapshot().threads.size === 1);
    },
  };
}

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const ids = (store: AppStore) => store.model.rows.map((r) => r.id);

describe('connecting', () => {
  test('hello carries the app version, and the connection is open only once it was answered', async () => {
    const s = setup();
    s.store.start();
    s.t.open();
    assert.equal(s.store.getSnapshot().conn, 'connecting');
    assert.equal(s.sent[0]?.method, 'hello');
    assert.equal(s.sent[0]?.params?.version, APP_VERSION);
    await until(() => s.store.getSnapshot().conn === 'open');
    assert.ok(s.store.getSnapshot().hello);
    s.rpc.stop();
  });

  test('a runner that is not there adds no notice per try, only the banner reason', async () => {
    const { t, sent } = fake();
    const rpc = new RpcClient(() => t, { retryMs: 5_000 });
    const store = new AppStore(rpc);
    store.start();
    for (let i = 0; i < 4; i++) {
      // Each try: the bridge accepts the page's socket, hello is sent, and the
      // bridge then closes it because the runner isn't there.
      if (i > 0) (rpc as unknown as { open(): void }).open(); // what the retry timer does
      t.open();
      assert.equal(sent.at(-1)?.method, 'hello');
      t.drop("the runner isn't answering on port 8797");
      assert.equal(store.getSnapshot().conn, 'closed');
      assert.match(store.getSnapshot().connWhy ?? '', /isn't answering/);
    }
    assert.equal(store.getSnapshot().notices.length, 0);
    rpc.stop();
  });

  test('the same notice twice in a row is kept once', () => {
    const { store } = setup();
    store.notify('error', 'Something failed.');
    store.notify('error', 'Something failed.');
    store.notify('error', 'Something else failed.');
    assert.deepEqual(
      store.getSnapshot().notices.map((n) => n.message),
      ['Something failed.', 'Something else failed.'],
    );
  });
});

describe('Load earlier messages', () => {
  test('two quick clicks ask once and the rows are not doubled', async () => {
    const s = setup();
    await s.connect();
    await s.store.open(THREAD);
    assert.deepEqual(ids(s.store), range(9, 13).map((e) => `u${e.seq}`));
    assert.equal(s.store.hasEarlier, true);

    s.holdEarlier();
    const first = s.store.loadEarlier();
    const second = s.store.loadEarlier();
    assert.equal(s.store.getSnapshot().loadingEarlier, true);
    await Promise.resolve();
    assert.equal(s.held.length, 1, 'the second click must not send another request');
    s.release();
    await Promise.all([first, second]);
    assert.deepEqual(ids(s.store), range(4, 13).map((e) => `u${e.seq}`));
    assert.equal(new Set(ids(s.store)).size, ids(s.store).length, 'no row twice');
    assert.equal(s.store.getSnapshot().loadingEarlier, false);

    await s.store.loadEarlier();
    assert.deepEqual(ids(s.store), range(1, 13).map((e) => `u${e.seq}`));
    assert.equal(s.store.hasEarlier, false);
    s.rpc.stop();
  });

  test('the reply being written is still there afterwards', async () => {
    const s = setup();
    await s.connect();
    await s.store.open(THREAD);
    s.t.say({ method: 'thread.event', params: { threadId: THREAD, event: { type: 'assistant.text.delta', itemId: 'i1', text: 'Half a sent' } } });
    s.t.say({ method: 'thread.event', params: { threadId: THREAD, event: { type: 'assistant.text.delta', itemId: 'i1', text: 'ence so far' } } });
    assert.equal(s.store.model.streaming.get('i1')?.text, 'Half a sentence so far');
    await s.store.loadEarlier();
    assert.equal(s.store.model.streaming.get('i1')?.text, 'Half a sentence so far');
    // And it carries on from there.
    s.t.say({ method: 'thread.event', params: { threadId: THREAD, event: { type: 'assistant.text.delta', itemId: 'i1', text: '.' } } });
    assert.equal(s.store.model.streaming.get('i1')?.text, 'Half a sentence so far.');
    s.rpc.stop();
  });

  test('a failure is a notice, not an unhandled rejection, and it can be tried again', async () => {
    let failing = true;
    const s = setup({ fail: (m) => failing && m.method === 'threads.events' && m.params?.beforeSeq !== undefined });
    await s.connect();
    await s.store.open(THREAD);
    await s.store.loadEarlier();
    assert.equal(s.store.getSnapshot().loadingEarlier, false);
    assert.match(s.store.getSnapshot().notices.at(-1)?.message ?? '', /threads\.events failed/);
    failing = false;
    await s.store.loadEarlier();
    assert.deepEqual(ids(s.store), range(4, 13).map((e) => `u${e.seq}`));
    s.rpc.stop();
  });

  test('moving to another thread while it loads leaves the other thread alone', async () => {
    const s = setup();
    await s.connect();
    await s.store.open(THREAD);
    s.holdEarlier();
    const pending = s.store.loadEarlier();
    s.store.deselect();
    s.release();
    await pending;
    assert.deepEqual(ids(s.store), []);
    assert.equal(s.store.getSnapshot().loadingEarlier, false);
    s.rpc.stop();
  });
});
