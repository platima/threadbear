// Helpers for the tests that run the real bridge (bridge.test.ts) or talk
// to it (src/core/rpc.test.ts): start it in a child process on a free port,
// with a throwaway data folder and built UI, and stand in for the runner.
// Nothing here touches the real data folder or the real runner.

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import type { Transport } from '../src/core/rpc.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
// TB_BRIDGE_FILE points the tests at another copy of the bridge (to see them fail on an older one).
export const BRIDGE = path.resolve(here, process.env.TB_BRIDGE_FILE || 'bridge.ts');
export const TOKEN = 'test-token-not-a-real-one';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

// A data folder with a runner token in it and a built UI with a page in it.
export function scratch(): { home: string; dist: string; remove(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-bridge-test-'));
  const home = path.join(root, 'home');
  const dist = path.join(root, 'dist');
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, 'secrets', 'runner-token'), TOKEN);
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Threadbear</title><div id="root"></div>');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'export {};');
  // A file just outside the UI folder, which no request may be able to read.
  fs.writeFileSync(path.join(root, 'secret.txt'), 'outside');
  return { home, dist, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export type Running = {
  child: ChildProcess;
  port: number;
  key: string;
  origin: string;
  output(): string;
  errors(): string;
  exited: Promise<number | null>;
  /** Ends it the way the app shell's death would: the pipe to its stdin closes. */
  closeStdin(): void;
  /** Closes stdin, and if it has not gone in a few seconds stops it by its own process id. */
  shutdown(): Promise<void>;
  /** Stops this child by its own process id; for the ones that don't watch stdin. */
  stop(): Promise<void>;
};

export async function startBridge(env: Record<string, string>, opts: { stdin?: 'pipe' | 'ignore'; waitReady?: boolean } = {}): Promise<Running> {
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, THREADBEAR_BRIDGE_KEY: 'test-key-0123456789', ...env },
    stdio: [opts.stdin ?? 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (err += d));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const running: Running = {
    child,
    port: 0,
    key: '',
    origin: '',
    output: () => out,
    errors: () => err,
    exited,
    closeStdin: () => child.stdin?.end(),
    shutdown: async () => {
      child.stdin?.end();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 4000))]);
      if (child.exitCode === null) child.kill();
      await exited;
    },
    stop: async () => {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
  if (opts.waitReady === false) return running;
  const ready = await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 20_000);
    const look = () => {
      const m = /^READY (http:\/\/127\.0\.0\.1:(\d+)\/#key=(\S+))$/m.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout!.on('data', look);
    void exited.then(() => {
      clearTimeout(timer);
      resolve(undefined);
    });
    look();
  });
  if (!ready) {
    await running.stop();
    throw new Error(`the bridge did not get ready. stdout: ${out} stderr: ${err}`);
  }
  const m = /^http:\/\/127\.0\.0\.1:(\d+)\/#key=(\S+)$/.exec(ready)!;
  running.port = Number(m[1]);
  running.key = m[2]!;
  running.origin = `http://127.0.0.1:${running.port}`;
  return running;
}

// Sends these bytes to the port and gives back what came back until it closes.
export function raw(port: number, bytes: string, waitMs = 1500): Promise<{ status: number; head: string; text: string }> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let text = '';
    const done = () => {
      s.destroy();
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0);
      resolve({ status, head: text.split('\r\n\r\n')[0] ?? '', text });
    };
    const timer = setTimeout(done, waitMs);
    s.on('connect', () => s.write(bytes));
    s.on('data', (d) => (text += d.toString('latin1')));
    s.on('close', () => {
      clearTimeout(timer);
      done();
    });
    s.on('error', () => {});
  });
}

const hmac = (text: string) => crypto.createHmac('sha256', TOKEN).update(text).digest('hex');

// A stand-in for the runner on a port of its own: it does the challenge
// handshake (docs/protocol.md, "Auth") and answers `hello` and `echo`.
export async function stubRunner(opts: { port?: number; beforeAuth?: string } = {}): Promise<{ port: number; connections(): number; close(): Promise<void> }> {
  const port = opts.port ?? (await freePort());
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  let count = 0;
  wss.on('connection', (ws) => {
    count++;
    const runnerNonce = crypto.randomBytes(16).toString('hex');
    if (opts.beforeAuth !== undefined) {
      ws.send(opts.beforeAuth);
      return;
    }
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'auth.challenge', params: { nonce: runnerNonce } }));
    let authed = false;
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as { id?: number; method?: string; params?: { nonce?: string; proof?: string } };
      if (!authed) {
        const clientNonce = m.params?.nonce ?? '';
        if (m.method === 'auth.prove' && m.params?.proof === hmac(`threadbear-rpc-auth-v1 client\n${runnerNonce}\n${clientNonce}\nprimary ${port}`)) {
          authed = true;
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { proof: hmac(`threadbear-rpc-auth-v1 runner\n${runnerNonce}\n${clientNonce}\nprimary ${port}`) } }));
        } else ws.close(4401, 'bad proof');
        return;
      }
      if (m.method === 'hello') ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { runnerVersion: 'stub', protocol: 1, accounts: [], defaults: {} } }));
      else ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { echo: m.method } }));
    });
  });
  return {
    port,
    connections: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

// Opens the page's WebSocket the way a browser on the bridge's own address does.
export function openUi(bridge: Pick<Running, 'port' | 'key' | 'origin'>, over: { key?: string | null; origin?: string | null; host?: string } = {}): WebSocket {
  const key = over.key === undefined ? bridge.key : over.key;
  const headers: Record<string, string> = {};
  const origin = over.origin === undefined ? bridge.origin : over.origin;
  if (origin !== null) headers.Origin = origin;
  if (over.host) headers.Host = over.host;
  return new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge${key === null ? '' : `?k=${encodeURIComponent(key)}`}`, { headers });
}

// Resolves with how the connection ended: a refused upgrade (its status) or a close (code and reason).
export function outcome(ws: WebSocket, waitMs = 5000): Promise<{ refused?: number; opened: boolean; code?: number; reason?: string }> {
  return new Promise((resolve) => {
    let opened = false;
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ opened });
    }, waitMs);
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.destroy();
      resolve({ refused: res.statusCode, opened });
    });
    ws.on('open', () => (opened = true));
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ opened, code, reason: reason.toString() });
    });
    ws.on('error', () => {});
  });
}

// The page's carrier (core/rpc.ts, bridgeTransport) as a browser would use it
// on the bridge's own address, built on `ws` because Node's own WebSocket sends
// no Origin, which the bridge insists on.
export function wsTransport(bridge: Pick<Running, 'port' | 'key' | 'origin'>): Transport {
  const ws = openUi(bridge);
  const t: Transport = {
    send: (text) => ws.send(text),
    close: () => ws.close(),
    onopen: () => {},
    onmessage: () => {},
    onclose: () => {},
  };
  ws.on('open', () => t.onopen());
  ws.on('message', (d) => t.onmessage(d.toString()));
  ws.on('close', (code, reason) => t.onclose(reason.toString() || `closed (${code})`));
  ws.on('unexpected-response', (_req, res) => {
    res.destroy();
    t.onclose(`refused (${res.statusCode})`);
  });
  ws.on('error', () => {});
  return t;
}
