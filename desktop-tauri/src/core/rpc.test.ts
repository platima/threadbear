// node --test desktop-tauri/src/core/rpc.test.ts
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, mock, test } from 'node:test';
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

// The shell has just started the runner (the banner's Start the runner button): the page asks the
// connection for a try now and quick tries for a while, instead of the delay that grew while the
// runner was down (up to maxRetryMs).
describe('retryNow', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  // A client whose every connection is a hand-driven one, and a way to drop each new one as it
  // appears. `times` is the (virtual) milliseconds at which each attempt began.
  function client(opts: { retryMs?: number; maxRetryMs?: number } = {}) {
    const carriers: ReturnType<typeof fake>['t'][] = [];
    const rpc = new RpcClient(() => {
      const { t } = fake();
      carriers.push(t);
      return t;
    }, opts);
    let now = 0;
    let dropped = 0;
    const times: number[] = [];
    const settle = () => {
      while (dropped < carriers.length) {
        times.push(now);
        carriers[dropped++]!.drop('the runner isn\'t answering');
      }
    };
    // Moves the clock on in steps of 100 ms, dropping each connection the moment it is tried.
    const run = (ms: number) => {
      for (let i = 0; i < ms / 100; i++) {
        mock.timers.tick(100);
        now += 100;
        settle();
      }
    };
    return { rpc, carriers, times, run, settle };
  }

  test('a retry that is waiting is brought forward, and the delay starts over', () => {
    const { rpc, carriers, run, settle } = client({ retryMs: 500, maxRetryMs: 5000 });
    rpc.start();
    settle(); // 1: dropped, the next try in 500
    run(500); // 2: dropped, the next in 1000
    run(1000); // 3: dropped, the next in 2000
    assert.equal(carriers.length, 3);
    assert.equal(rpc.state, 'closed');
    rpc.retryNow();
    assert.equal(carriers.length, 4, 'tried at once, without waiting out the 2000 ms');
    assert.equal(rpc.state, 'connecting');
    // The timer it replaced does not fire as well.
    mock.timers.tick(5000);
    assert.equal(carriers.length, 4);
    // And the delay after this one is the first one again.
    carriers[3]!.drop();
    mock.timers.tick(499);
    assert.equal(carriers.length, 4);
    mock.timers.tick(1);
    assert.equal(carriers.length, 5);
    rpc.stop();
  });

  test('for the window the tries stay at the first delay, and after it the delay grows again to its cap', () => {
    const { rpc, times, run, settle } = client({ retryMs: 500, maxRetryMs: 5000 });
    rpc.start();
    settle();
    rpc.retryNow(2250);
    settle();
    run(20_000);
    // The first try, then the one that was asked for (both at 0), then one every 500 ms through the
    // window, which ends at 2250. The try at 2000 was already waiting its 500, so the one at 2500 is
    // the first after the window; from there the delays double: 500, 1000, 2000, 4000, then the
    // cap of 5000 for as long as it goes on.
    assert.deepEqual(times, [0, 0, 500, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 10_000, 15_000, 20_000]);
    rpc.stop();
  });

  test('on a connection that is open, being tried, not started or stopped, it changes nothing', () => {
    const idle = client();
    idle.rpc.retryNow(5000);
    assert.equal(idle.carriers.length, 0, 'before start() there is nothing to bring forward');

    const open = client();
    open.rpc.start();
    open.carriers[0]!.open();
    assert.equal(open.rpc.state, 'open');
    open.rpc.retryNow(5000);
    assert.equal(open.carriers.length, 1);
    assert.equal(open.rpc.state, 'open');
    open.rpc.stop();

    const trying = client();
    trying.rpc.start();
    assert.equal(trying.rpc.state, 'connecting');
    trying.rpc.retryNow(5000);
    assert.equal(trying.carriers.length, 1, 'one attempt at a time');
    trying.rpc.stop();

    const stopped = client();
    stopped.rpc.start();
    stopped.settle();
    stopped.rpc.stop();
    stopped.rpc.retryNow(5000);
    mock.timers.tick(60_000);
    assert.equal(stopped.carriers.length, 1, 'a window that has been closed does not reconnect');
  });
});

describe('a runner that comes up while the page waits to retry', () => {
  test('retryNow finds it at once, where the grown delay would have taken seconds', async () => {
    const port = await freePort();
    const bridge = await startBridge(env(port));
    const rpc = new RpcClient(() => wsTransport(bridge), { retryMs: 6000, maxRetryMs: 6000 });
    rpc.handshake = async (call) => {
      await call('hello');
    };
    let runner: Awaited<ReturnType<typeof stubRunner>> | undefined;
    try {
      rpc.start();
      await until('the first try to fail', () => rpc.state === 'closed');
      // The runner starts now. The page's own next try is six seconds off.
      runner = await stubRunner({ port });
      const asked = Date.now();
      rpc.retryNow(10_000);
      await until('open', () => rpc.state === 'open', 4000);
      assert.ok(Date.now() - asked < 4000, `found it in ${Date.now() - asked} ms`);
      assert.deepEqual(await rpc.request('anything'), { echo: 'anything' });
    } finally {
      rpc.stop();
      await bridge.shutdown();
      await runner?.close();
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
