// node --test desktop/bridge/bridge.test.ts
//
// Runs the real bridge in a child process, on free ports, with a throwaway
// data folder, and a stand-in for the runner. Each case that follows came from
// something that once stopped the bridge or got past its checks.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { freePort, openUi, outcome, raw, scratch, startBridge, stubRunner, type Running } from './testkit.ts';

const files = scratch();
after(() => files.remove());
const env = (runnerPort: number, more: Record<string, string> = {}) => ({
  THREADBEAR_HOME: files.home,
  THREADBEAR_DIST: files.dist,
  THREADBEAR_PORT: String(runnerPort),
  THREADBEAR_BRIDGE_PORT: '0',
  THREADBEAR_BRIDGE_WATCH_STDIN: '1',
  ...more,
});
const get = (b: Running, p: string, headers: Record<string, string> = {}) => fetch(`${b.origin}${p}`, { headers });

describe('a bridge with no runner behind it', () => {
  let bridge: Running;
  before(async () => {
    bridge = await startBridge(env(await freePort()));
  });
  after(async () => {
    await bridge.shutdown();
  });
  const alive = async () => {
    const res = await get(bridge, '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Threadbear/);
    assert.equal(bridge.child.exitCode, null, `the bridge stopped: ${bridge.errors()}`);
  };

  test('it serves the page, and only files under the UI folder', async () => {
    await alive();
    assert.equal((await get(bridge, '/assets/app.js')).status, 200);
    assert.equal((await get(bridge, '/assets/nothing.js')).status, 404);
    assert.equal((await get(bridge, '/assets')).status, 404);
    assert.equal((await get(bridge, '/..%5c..%5csecret.txt')).status, 404);
    assert.equal((await get(bridge, '/..%2f..%2fsecret.txt')).status, 404);
    assert.equal((await get(bridge, '/%2e%2e/secret.txt')).status, 404);
    assert.equal((await get(bridge, '/index.html%00.png')).status, 400);
    await alive();
  });

  test('a request with no Host, an empty Host or a malformed address gets an error, not a crash', async () => {
    const noHost = await raw(bridge.port, 'GET / HTTP/1.0\r\n\r\n');
    assert.equal(noHost.status, 400);
    const emptyHost = await raw(bridge.port, 'GET / HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n');
    assert.equal(emptyHost.status, 400);
    const junkHost = await raw(bridge.port, 'GET / HTTP/1.1\r\nHost: a b@@c\r\nConnection: close\r\n\r\n');
    assert.ok(junkHost.status === 400 || junkHost.status === 421, `status ${junkHost.status}`);
    for (const target of ['/%', '/%zz', '/..%5c', '/%00', '/%E0%A4%A', 'x', '//evil.test/x', '*']) {
      const r = await raw(bridge.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${bridge.port}\r\nConnection: close\r\n\r\n`);
      assert.ok(r.status >= 400 && r.status < 500, `${target} gave ${r.status}`);
    }
    // Not HTTP at all.
    await raw(bridge.port, '\x00\x01\x02 not http\r\n\r\n', 300);
    await alive();
  });

  test('a Host that is not this PC is turned away (DNS rebinding)', async () => {
    for (const host of ['evil.example', `evil.example:${bridge.port}`, '127.0.0.1.evil.example', `[::1]:${bridge.port}`]) {
      const r = await raw(bridge.port, `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      assert.equal(r.status, 421, host);
      assert.ok(!/<div id="root">/.test(r.text), 'the page must not be served');
    }
    await alive();
  });

  test('/bridge is a WebSocket path: a plain request to it is not found, and it is not a way in', async () => {
    assert.equal((await get(bridge, '/bridge')).status, 404);
    assert.equal((await get(bridge, `/bridge?k=${bridge.key}`)).status, 404);
    await alive();
  });

  test('the WebSocket needs the key, an allowed Origin and this PC as its Host', async () => {
    assert.equal((await outcome(openUi(bridge, { key: 'wrong' }))).refused, 403);
    assert.equal((await outcome(openUi(bridge, { key: null }))).refused, 403);
    assert.equal((await outcome(openUi(bridge, { key: '' }))).refused, 403);
    assert.equal((await outcome(openUi(bridge, { origin: 'http://evil.example' }))).refused, 403);
    assert.equal((await outcome(openUi(bridge, { origin: `http://evil.example:${bridge.port}` }))).refused, 403);
    assert.equal((await outcome(openUi(bridge, { origin: `http://127.0.0.1:${bridge.port + 1}` }))).refused, 403);
    assert.equal((await outcome(openUi(bridge, { origin: 'null' }))).refused, 403);
    assert.equal((await outcome(openUi(bridge, { origin: null }))).refused, 403);
    assert.equal((await outcome(openUi(bridge, { host: 'evil.example' }))).refused, 403);
    // Not a dev run, so the vite dev server's address is not trusted.
    assert.equal((await outcome(openUi(bridge, { origin: 'http://127.0.0.1:5183' }))).refused, 403);
    await alive();
  });

  test('with the right key and Origin it opens, then says the runner is not there', async () => {
    const got = await outcome(openUi(bridge));
    assert.equal(got.opened, true);
    assert.equal(got.code, 4503);
    assert.match(got.reason ?? '', /isn't answering/);
    await alive();
  });

  test('every answer carries the content security policy and no referrer', async () => {
    const answers = [await get(bridge, '/'), await get(bridge, '/assets/app.js'), await get(bridge, '/nothing'), await get(bridge, '/bridge-info')];
    answers.push(new Response(null, { status: (await raw(bridge.port, 'GET / HTTP/1.0\r\n\r\n')).status }));
    for (const res of answers.slice(0, 4)) {
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /img-src 'self' blob: data:/);
      assert.ok(!/img-src[^;]*https?:/.test(csp), 'no remote pictures');
      assert.match(csp, /connect-src 'self' ws:\/\/127\.0\.0\.1:\d+ ws:\/\/localhost:\d+ https:\/\/api\.github\.com/);
      assert.match(csp, /object-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
    // An early error is covered too.
    const bad = await raw(bridge.port, 'GET / HTTP/1.0\r\n\r\n');
    assert.match(bad.head, /content-security-policy: default-src 'self'/i);
    assert.match(bad.head, /referrer-policy: no-referrer/i);
    const wrongHost = await raw(bridge.port, 'GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
    assert.match(wrongHost.head, /content-security-policy: default-src 'self'/i);
  });

  test('the upload route is covered by the same checks and refuses without the key', async () => {
    const res = await fetch(`${bridge.origin}/upload`, { method: 'POST', headers: { 'content-type': 'image/png', origin: bridge.origin }, body: new Uint8Array([1, 2, 3]) });
    assert.equal(res.status, 403);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    const noHost = await raw(bridge.port, 'POST /upload HTTP/1.0\r\ncontent-length: 0\r\n\r\n');
    assert.equal(noHost.status, 400);
    const badDelete = await raw(bridge.port, `DELETE /upload/% HTTP/1.1\r\nHost: 127.0.0.1:${bridge.port}\r\nConnection: close\r\n\r\n`);
    assert.ok(badDelete.status >= 400 && badDelete.status < 500);
    await alive();
  });

  test('other methods on the page are refused', async () => {
    const res = await fetch(bridge.origin + '/', { method: 'POST', body: 'x' });
    assert.equal(res.status, 405);
    await alive();
  });
});

describe('a bridge with a runner behind it', () => {
  test('the handshake completes and requests and answers pass through', async () => {
    const runner = await stubRunner();
    const bridge = await startBridge(env(runner.port));
    try {
      const ws = openUi(bridge);
      const answer = await new Promise<string>((resolve, reject) => {
        ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'hello', params: {} })));
        ws.on('message', (d) => resolve(d.toString()));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('no answer')), 5000);
      });
      assert.equal(JSON.parse(answer).result.runnerVersion, 'stub');
      ws.close();
    } finally {
      await bridge.shutdown();
      await runner.close();
    }
  });

  test('something on the runner port that sends rubbish before the handshake closes that page, not the bridge', async () => {
    // The last one is a message that means nothing yet: the page is left to the handshake's own time limit.
    for (const rubbish of ['null', '42', '"text"', '[1,2]', '{', '{"method":5}']) {
      const runner = await stubRunner({ beforeAuth: rubbish });
      const bridge = await startBridge(env(runner.port));
      try {
        const meaningless = rubbish === '{"method":5}';
        const got = await outcome(openUi(bridge), meaningless ? 400 : 5000);
        assert.equal(got.opened, true, rubbish);
        if (!meaningless) assert.ok(got.code === 4401 || got.code === 4503, `${rubbish} closed with ${got.code}`);
        const res = await get(bridge, '/');
        assert.equal(res.status, 200, `still serving after ${rubbish}`);
        assert.equal(bridge.child.exitCode, null, bridge.errors());
      } finally {
        await bridge.shutdown();
        await runner.close();
      }
    }
  });
});

describe('the address the page is served from', () => {
  test('is the same on every start when the port is given, so the browser keeps its saved state', async () => {
    const port = await freePort();
    const runnerPort = await freePort();
    const first = await startBridge(env(runnerPort, { THREADBEAR_BRIDGE_PORT: String(port) }));
    assert.equal(first.origin, `http://127.0.0.1:${port}`);
    assert.deepEqual(await (await get(first, '/bridge-info')).json(), { stable: true });
    await first.shutdown();
    const second = await startBridge(env(runnerPort, { THREADBEAR_BRIDGE_PORT: String(port) }));
    try {
      assert.equal(second.origin, first.origin);
      assert.notEqual(second.key, '');
      assert.deepEqual(await (await get(second, '/bridge-info')).json(), { stable: true });
    } finally {
      await second.shutdown();
    }
  });

  test('falls back to a free port only when asked to, and then says it is not the usual address', async () => {
    const port = await freePort();
    const runnerPort = await freePort();
    const holder = await startBridge(env(runnerPort, { THREADBEAR_BRIDGE_PORT: String(port) }));
    try {
      const fallback = await startBridge(env(runnerPort, { THREADBEAR_BRIDGE_PORT: String(port), THREADBEAR_BRIDGE_FALLBACK: 'random' }));
      try {
        assert.notEqual(fallback.port, port);
        assert.deepEqual(await (await get(fallback, '/bridge-info')).json(), { stable: false });
        // It is fully usable on its own address.
        assert.equal((await outcome(openUi(fallback))).code, 4503);
        assert.equal((await get(fallback, '/')).status, 200);
      } finally {
        await fallback.shutdown();
      }
      // Without the fallback a busy port is an error, not a silent change of address.
      const strict = await startBridge(env(runnerPort, { THREADBEAR_BRIDGE_PORT: String(port) }), { waitReady: false });
      assert.equal(await strict.exited, 1);
      assert.match(strict.errors(), /can't listen on 127\.0\.0\.1/);
      assert.ok(!/READY/.test(strict.output()));
    } finally {
      await holder.shutdown();
    }
  });

  test('port 0 asks for any free port and is never called the usual address', async () => {
    const bridge = await startBridge(env(await freePort()));
    try {
      assert.deepEqual(await (await get(bridge, '/bridge-info')).json(), { stable: false });
    } finally {
      await bridge.shutdown();
    }
  });

  test('the dev server on 5183 is trusted only when asked for', async () => {
    const dev = await startBridge(env(await freePort(), { THREADBEAR_BRIDGE_DEV: '1' }));
    try {
      const got = await outcome(openUi(dev, { origin: 'http://127.0.0.1:5183' }));
      assert.equal(got.refused, undefined);
      assert.equal(got.opened, true);
    } finally {
      await dev.shutdown();
    }
  });
});

describe('when the app that started it goes away', () => {
  test('it exits as soon as its standard input ends, if told to watch it', async () => {
    const bridge = await startBridge(env(await freePort()));
    assert.equal(bridge.child.exitCode, null);
    bridge.closeStdin();
    const code = await Promise.race([bridge.exited, new Promise<string>((r) => setTimeout(() => r('still running'), 8000))]);
    if (code === 'still running') await bridge.stop();
    assert.equal(code, 0);
  });

  test('it keeps running without that setting, which is how the dev stack and tests start it', async () => {
    const bridge = await startBridge(env(await freePort(), { THREADBEAR_BRIDGE_WATCH_STDIN: '' }));
    try {
      bridge.closeStdin();
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(bridge.child.exitCode, null);
      assert.equal((await get(bridge, '/')).status, 200);
    } finally {
      await bridge.stop();
    }
  });

  test('a bridge started with no standard input at all (the dev stack) is not stopped by that', async () => {
    const bridge = await startBridge(env(await freePort(), { THREADBEAR_BRIDGE_WATCH_STDIN: '' }), { stdin: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(bridge.child.exitCode, null);
    } finally {
      await bridge.stop();
    }
  });
});
