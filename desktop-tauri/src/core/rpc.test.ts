// node --test desktop-tauri/src/core/rpc.test.ts
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { freePort, scratch, startBridge, stubRunner, wsTransport } from '../../bridge/testkit.ts';
import { fake } from './fake-transport.ts';
import { RpcClient, RpcError, type ConnState } from './rpc.ts';

const files = scratch();
after(() => files.remove());
const env = (runnerPort: number) => ({ THREADBEAR_HOME: files.home, THREADBEAR_DIST: files.dist, THREADBEAR_PORT: String(runnerPort), THREADBEAR_BRIDGE_PORT: '0', THREADBEAR_BRIDGE_WATCH_STDIN: '1' });
const until = async (what: string, ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('reconnecting while the runner is down', () => {
  test('the delay grows to its cap, and the connection is never called open', async () => {
    const bridge = await startBridge(env(await freePort())); // nothing listens on the runner's port
    const attempts: number[] = [];
    const states: ConnState[] = [];
    const reasons = new Set<string>();
    const rpc = new RpcClient(
      () => {
        attempts.push(Date.now());
        return wsTransport(bridge);
      },
      { retryMs: 40, maxRetryMs: 320 },
    );
    rpc.handshake = async (call) => {
      await call('hello');
    };
    rpc.onState((s, why) => {
      states.push(s);
      if (why) reasons.add(why);
    });
    try {
      rpc.start();
      await until('seven attempts', () => attempts.length >= 7);
    } finally {
      rpc.stop();
      await bridge.shutdown();
    }
    const gaps = attempts.slice(1).map((t, i) => t - attempts[i]!);
    // 40, 80, 160, 320, 320 and more, not 40 every time. Each gap also holds the
    // time the failed connection took, which a busy CI machine stretches (the
    // first was 176 ms there), so the early gaps are not compared with each
    // other: the fourth and fifth only have to be well past the 40 ms start.
    assert.ok(gaps[3]! >= 250, `the fourth wait was ${gaps[3]} ms: ${gaps}`);
    assert.ok(gaps[4]! >= 250, `the fifth wait was ${gaps[4]} ms: ${gaps}`);
    assert.ok(!states.includes('open'), `it flashed open: ${states}`);
    assert.ok([...reasons].some((r) => /isn't answering/.test(r)), `the reason was lost: ${[...reasons]}`);
  });

  test('once the runner answers, it is open and requests go through', async () => {
    const runner = await stubRunner();
    const bridge = await startBridge(env(runner.port));
    const attempts: number[] = [];
    const rpc = new RpcClient(
      () => {
        attempts.push(Date.now());
        return wsTransport(bridge);
      },
      { retryMs: 60, maxRetryMs: 480 },
    );
    let hello: unknown;
    rpc.handshake = async (call) => {
      hello = await call('hello');
    };
    try {
      rpc.start();
      await until('open', () => rpc.state === 'open');
      assert.equal((hello as { runnerVersion: string }).runnerVersion, 'stub');
      assert.deepEqual(await rpc.request('anything'), { echo: 'anything' });
      assert.equal(attempts.length, 1);
    } finally {
      rpc.stop();
      await bridge.shutdown();
      await runner.close();
    }
  });
});

describe('the handshake', () => {
  test('a refusal closes the connection with its reason, and it is not open', async () => {
    const { t, sent } = fake();
    const whys: (string | undefined)[] = [];
    const rpc = new RpcClient(() => t, { retryMs: 30, maxRetryMs: 240 });
    rpc.handshake = async (call) => {
      await call('hello');
    };
    rpc.onState((s, why) => s === 'closed' && whys.push(why));
    rpc.start();
    t.open();
    assert.equal(rpc.state, 'connecting', 'not open until hello is answered');
    assert.equal(sent[0]?.method, 'hello');
    t.say({ id: sent[0]!.id, error: { code: -32000, message: 'The token was turned down.' } });
    await until('closed', () => rpc.state === 'closed');
    assert.deepEqual(whys, ['The token was turned down.']);
    rpc.stop();
  });

  test('with no answer at all it gives up on that connection after its time', async () => {
    const { t } = fake();
    const rpc = new RpcClient(() => t, { retryMs: 30, handshakeMs: 40 });
    rpc.handshake = async (call) => {
      await call('hello');
    };
    rpc.start();
    t.open();
    await until('closed', () => rpc.state === 'closed');
    rpc.stop();
  });

  test('a good answer opens it', async () => {
    const { t, sent } = fake();
    const rpc = new RpcClient(() => t, { retryMs: 30 });
    rpc.handshake = async (call) => {
      await call('hello');
    };
    rpc.start();
    t.open();
    t.say({ id: sent[0]!.id, result: {} });
    await until('open', () => rpc.state === 'open');
    rpc.stop();
  });
});

describe('requests', () => {
  test('one the runner never answers fails after a while, and says so', async () => {
    const { t, sent } = fake();
    const rpc = new RpcClient(() => t, { requestMs: 40 });
    rpc.start();
    t.open();
    assert.equal(rpc.state, 'open');
    await assert.rejects(rpc.request('threads.send'), (e: unknown) => e instanceof RpcError && e.code === -2 && /too long/.test(e.message));
    // A late answer to it is ignored, and later requests still work.
    t.say({ id: sent[0]!.id, result: 'late' });
    const next = rpc.request('again');
    t.say({ id: sent[1]!.id, result: 'fine' });
    assert.equal(await next, 'fine');
    rpc.stop();
  });

  test('the ones waiting when the connection drops fail at once', async () => {
    const { t } = fake();
    const rpc = new RpcClient(() => t, { requestMs: 10_000, retryMs: 10_000 });
    rpc.start();
    t.open();
    const waiting = rpc.request('x');
    t.drop();
    await assert.rejects(waiting, (e: unknown) => e instanceof RpcError && e.code === -1);
    rpc.stop();
  });
});
