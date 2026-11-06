// The desktop UI's way to the runner when it isn't inside the Tauri shell: a
// small local server that serves the built UI and passes its WebSocket on to
// the runner. It holds the runner's token and does the challenge handshake
// (docs/protocol.md, "Auth"), so the page never sees the token, as it never
// does in the shell either. Run from desktop/:
//
//   node bridge/bridge.ts                 serves dist/ on 127.0.0.1:5185
//   THREADBEAR_HOME=... THREADBEAR_PORT=... node bridge/bridge.ts
//
// Loopback only. A web page on any other origin must not be able to open
// the pipe to the runner, so the upgrade checks Origin and Host.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { dataDirFor } from '../../runner/src/platform.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', 'dist');
const BRIDGE_PORT = Number(process.env.THREADBEAR_BRIDGE_PORT || 5185);
const home = path.resolve(process.env.THREADBEAR_HOME || process.env.THREADBEAR_DATA_DIR || dataDirFor());

function runnerPort(): number {
  if (process.env.THREADBEAR_PORT) return Number(process.env.THREADBEAR_PORT);
  try {
    const json = JSON.parse(fs.readFileSync(path.join(home, 'runner.json'), 'utf8'));
    if (Number.isInteger(json.port)) return json.port;
  } catch {
    // no runner.json yet
  }
  return 8797;
}

const readToken = () => fs.readFileSync(path.join(home, 'secrets', 'runner-token'), 'utf8').trim();
const hmac = (token: string, text: string) => crypto.createHmac('sha256', token).update(text).digest('hex');

// The origins this page may be served from: the bridge itself, and the vite
// dev server beside it.
const ALLOWED_PORTS = new Set([BRIDGE_PORT, 5183]);
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);
function allowed(origin: string | undefined, host: string | undefined): boolean {
  try {
    const o = new URL(origin ?? '');
    const h = new URL(`http://${host ?? ''}`);
    return ALLOWED_HOSTS.has(o.hostname) && ALLOWED_PORTS.has(Number(o.port)) && ALLOWED_HOSTS.has(h.hostname);
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  if (!ALLOWED_HOSTS.has(new URL(`http://${req.headers.host ?? ''}`).hostname)) {
    res.writeHead(421).end();
    return;
  }
  let rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(dist, '.' + rel);
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/bridge' || !allowed(req.headers.origin, req.headers.host)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ui) => pipe(ui));
});

// One runner connection per page connection, authenticated before the page
// is told anything.
function pipe(ui: WebSocket): void {
  const port = runnerPort();
  let token: string;
  try {
    token = readToken();
  } catch {
    ui.close(4404, `no runner token in ${home}`);
    return;
  }
  const runner = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { maxPayload: 256 * 1024 * 1024 });
  const clientNonce = crypto.randomBytes(32).toString('hex');
  let authed = false;
  const queued: string[] = [];
  const fail = (code: number, why: string) => {
    ui.close(code, why.slice(0, 120));
    runner.close();
  };

  runner.on('error', () => fail(4503, `the runner isn't answering on port ${port}`));
  runner.on('close', () => ui.close(4503, 'the runner closed the connection'));
  ui.on('close', () => runner.close());
  ui.on('error', () => runner.close());

  runner.on('message', (data) => {
    const text = data.toString();
    if (authed) {
      if (ui.readyState === WebSocket.OPEN) ui.send(text);
      return;
    }
    let msg: { method?: string; params?: { nonce?: string }; id?: number; result?: { proof?: string }; error?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return fail(4401, 'bad message before auth');
    }
    if (msg.method === 'auth.challenge' && typeof msg.params?.nonce === 'string') {
      const runnerNonce = msg.params.nonce;
      const proof = hmac(token, `threadbear-rpc-auth-v1 client\n${runnerNonce}\n${clientNonce}\nprimary ${port}`);
      runner.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth.prove', params: { nonce: clientNonce, proof } }));
      (runner as unknown as { _runnerNonce: string })._runnerNonce = runnerNonce;
    } else if (msg.id === 1 && msg.result?.proof) {
      const runnerNonce = (runner as unknown as { _runnerNonce: string })._runnerNonce;
      const expected = hmac(token, `threadbear-rpc-auth-v1 runner\n${runnerNonce}\n${clientNonce}\nprimary ${port}`);
      const a = Buffer.from(expected);
      const b = Buffer.from(msg.result.proof);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(4401, "the runner didn't prove it holds the token");
      authed = true;
      for (const q of queued) runner.send(q);
      queued.length = 0;
    } else if (msg.error) {
      fail(4401, 'the runner turned the token down');
    }
  });

  ui.on('message', (data) => {
    const text = data.toString();
    if (authed) runner.send(text);
    else queued.push(text);
  });
}

server.listen(BRIDGE_PORT, '127.0.0.1', () => {
  console.log(`threadbear desktop bridge on http://127.0.0.1:${BRIDGE_PORT} -> runner port ${runnerPort()}, data ${home} (${os.platform()})`);
});
