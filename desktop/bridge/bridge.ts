// The desktop UI's way to the runner when it isn't inside the Tauri shell: a
// small local server that serves the built UI and passes its WebSocket on to
// the runner. It holds the runner's token and does the challenge handshake
// (docs/protocol.md, "Auth"), so the page never sees the token, as it never
// does in the shell either. Run from desktop/:
//
//   node bridge/bridge.ts                 serves dist/ on 127.0.0.1:5185
//   THREADBEAR_HOME=... THREADBEAR_PORT=... node bridge/bridge.ts
//
// Loopback only, and with a key. A web page on any other origin must not be
// able to open the pipe to the runner, so the upgrade checks Origin and Host;
// and since any program on this PC can reach a loopback port (and Origin is
// only a browser's word), every WebSocket and upload also needs this launch's
// key, which is in the address printed at start (after the #) or passed in by
// the app that started the bridge (THREADBEAR_BRIDGE_KEY).

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { dataDirFor } from '../../runner/src/platform.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(process.env.THREADBEAR_DIST || path.join(here, '..', 'dist'));
// 0 asks the system for a free port.
let BRIDGE_PORT = Number(process.env.THREADBEAR_BRIDGE_PORT ?? 5185);
const KEY = process.env.THREADBEAR_BRIDGE_KEY || crypto.randomBytes(24).toString('base64url');
function keyOk(given: string | string[] | null | undefined): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
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
const ALLOWED_PORTS = new Set([5183]);
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

// Pictures the person pastes, drops or chooses: a page can't hand the runner a
// path, so it posts the bytes here, we keep them in a temp file the runner can
// read, the page calls media.import with that path, and then deletes the file
// (DELETE /upload/<id>). Images only, 20 MB at most. Same Origin and Host
// checks as the WebSocket. Anything left behind is swept after an hour.
const UPLOAD_DIR = path.join(os.tmpdir(), 'threadbear-uploads');
const UPLOAD_MAX = 20 * 1024 * 1024;
const UPLOAD_KEEP_MS = 60 * 60 * 1000;

function imageExt(b: Buffer): string | undefined {
  const at = (i: number, s: string) => b.length >= i + s.length && b.toString('latin1', i, i + s.length) === s;
  if (at(1, 'PNG')) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (at(0, 'GIF8')) return 'gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  if (at(0, 'BM')) return 'bmp';
  if (at(0, 'II*\0') || at(0, 'MM\0*')) return 'tiff';
  if (at(4, 'ftyp') && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(b.toString('latin1', 8, 12))) return 'heic';
  return undefined;
}

function sweepUploads(): void {
  try {
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      const file = path.join(UPLOAD_DIR, name);
      if (Date.now() - fs.statSync(file).mtimeMs > UPLOAD_KEEP_MS) fs.rmSync(file, { force: true });
    }
  } catch {
    // no folder yet
  }
}
sweepUploads();
setInterval(sweepUploads, 10 * 60 * 1000).unref();

function upload(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  const del = /^\/upload\/([0-9a-f]{32})$/.exec(pathname);
  if (pathname !== '/upload' && !del) return false;
  const reply = (code: number, body = '', type = 'text/plain; charset=utf-8') => res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', connection: 'close' }).end(body);
  if (!allowed(req.headers.origin, req.headers.host) || !keyOk(req.headers['x-threadbear-key'])) {
    reply(403, 'not allowed');
    return true;
  }
  if (del && req.method === 'DELETE') {
    try {
      for (const name of fs.readdirSync(UPLOAD_DIR)) if (name.startsWith(`${del[1]}.`)) fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
    } catch {
      // already gone
    }
    reply(204);
    return true;
  }
  if (pathname !== '/upload' || req.method !== 'POST') {
    reply(405, 'method not allowed');
    return true;
  }
  if (!/^image\//i.test(req.headers['content-type'] ?? '')) {
    reply(415, 'Pictures only.');
    return true;
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > UPLOAD_MAX) {
    reply(413, 'That picture is over 20 MB.');
    return true;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  req.on('data', (c: Buffer) => {
    if (over) return;
    size += c.length;
    if (size > UPLOAD_MAX) {
      over = true;
      chunks.length = 0;
      reply(413, 'That picture is over 20 MB.');
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (over) return;
    const body = Buffer.concat(chunks);
    const ext = imageExt(body);
    if (!ext) {
      reply(415, "That doesn't look like a picture.");
      return;
    }
    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
      const id = crypto.randomBytes(16).toString('hex');
      const file = path.join(UPLOAD_DIR, `${id}.${ext}`);
      fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
      reply(200, JSON.stringify({ id, path: file }), 'application/json');
    } catch {
      reply(500, "The picture couldn't be saved.");
    }
  });
  req.on('error', () => res.destroy());
  return true;
}

const server = http.createServer((req, res) => {
  if (!ALLOWED_HOSTS.has(new URL(`http://${req.headers.host ?? ''}`).hostname)) {
    res.writeHead(421).end();
    return;
  }
  if (upload(req, res, new URL(req.url ?? '/', 'http://x').pathname)) return;
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
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname !== '/bridge' || !allowed(req.headers.origin, req.headers.host) || !keyOk(u.searchParams.get('k'))) {
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
  BRIDGE_PORT = (server.address() as { port: number }).port;
  ALLOWED_PORTS.add(BRIDGE_PORT);
  console.log(`threadbear desktop bridge -> runner port ${runnerPort()}, data ${home} (${os.platform()})`);
  // The address to open: the key is after the #, which a browser never sends
  // to a server. The page keeps it and wipes it from the address bar.
  console.log(`READY http://127.0.0.1:${BRIDGE_PORT}/#key=${KEY}`);
});
