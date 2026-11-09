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
//
// Settings, in the environment:
//
//   THREADBEAR_BRIDGE_PORT       the port to listen on (default 5185; 0 asks the
//                                system for a free one). The page's web origin is
//                                this address, and the browser keeps its saved
//                                state (localStorage) per origin, so the app
//                                shell gives the bridge the same port every time.
//   THREADBEAR_BRIDGE_FALLBACK   "random": if that port is taken, use a free one
//                                instead of stopping. /bridge-info then says
//                                {"stable":false}, since the saved state of the
//                                usual address isn't there for this run.
//   THREADBEAR_BRIDGE_WATCH_STDIN  "1": exit when standard input ends. The app
//                                shell keeps a pipe to it open for as long as it
//                                lives, so a crashed or killed shell can't leave
//                                this running (and holding node.exe open).
//   THREADBEAR_BRIDGE_DEV        "1": also trust pages served by the vite dev
//                                server on port 5183 (npm run dev).
//   THREADBEAR_BRIDGE_KEY, THREADBEAR_DIST, THREADBEAR_HOME, THREADBEAR_PORT
//                                the key, the built UI, the runner's data folder
//                                and the runner's port.
//
// A request this can't make sense of gets a 400, never a crash: the port is
// reachable by every program on the PC and by any web page's no-cors fetch.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { dataDirFor } from '../../runner/src/platform.ts';
import { Terminals } from './terminal.ts';

// What goes wrong in here is logged and the bridge carries on serving; the
// shell hides this process' output, so this is for a person running it by hand.
const log = (...args: unknown[]): void => {
  try {
    console.error('bridge:', ...args);
  } catch {
    // no stderr to write to
  }
};
process.on('uncaughtException', (e) => log('uncaught exception, still serving:', e));
process.on('unhandledRejection', (e) => log('unhandled rejection, still serving:', e));

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(process.env.THREADBEAR_DIST || path.join(here, '..', 'dist'));

function portFrom(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : fallback;
}
const REQUESTED_PORT = portFrom(process.env.THREADBEAR_BRIDGE_PORT, 5185);
const FALL_BACK = process.env.THREADBEAR_BRIDGE_FALLBACK === 'random';
let BRIDGE_PORT = REQUESTED_PORT;
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

// The origins this page may be served from: the bridge itself, and, only when
// asked for with THREADBEAR_BRIDGE_DEV, the vite dev server beside it.
const ALLOWED_PORTS = new Set<number>(process.env.THREADBEAR_BRIDGE_DEV === '1' ? [5183] : []);
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);

// The host name in a Host header, or undefined when there is none or it
// isn't a host at all (an empty header, spaces, a second @).
function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}
const hostOk = (host: string | undefined): boolean => ALLOWED_HOSTS.has(hostnameOf(host) ?? '');

function allowed(origin: string | undefined, host: string | undefined): boolean {
  try {
    const o = new URL(origin ?? '');
    return o.protocol === 'http:' && ALLOWED_HOSTS.has(o.hostname) && ALLOWED_PORTS.has(Number(o.port)) && hostOk(host);
  } catch {
    return false;
  }
}

// The path and query of a request target, or undefined when it isn't one this
// serves (it must start with a single slash). `path` is the path as sent,
// `decoded` has the %-escapes undone and is undefined when they're malformed.
function target(raw: string | undefined): { path: string; decoded?: string; query: URLSearchParams } | undefined {
  if (!raw || raw[0] !== '/' || raw[1] === '/') return undefined;
  const cut = raw.search(/[?#]/);
  const p = cut < 0 ? raw : raw.slice(0, cut);
  const q = cut >= 0 && raw[cut] === '?' ? raw.slice(cut + 1).split('#')[0]! : '';
  let decoded: string | undefined;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    decoded = undefined;
  }
  return { path: p, decoded, query: new URLSearchParams(q) };
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

// What the page may load and talk to. Agents' Markdown is shown in this page,
// and a remote picture in it would tell its server what the agent wanted to
// say (the address is the message), so nothing outside this bridge is loaded:
// pictures are this origin's own, blobs and data URLs. The one outside call
// the app makes itself is the update check to api.github.com. Scripts come
// only from the bridge's own files; the inline styles are React's. The HTML
// preview in a Files pane is an iframe with srcdoc and sandbox, which takes
// this policy too, so a previewed page can't load remote things either.
function policy(port: number): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port} https://api.github.com`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
}
let CSP = policy(BRIDGE_PORT);

// On every response, errors and uploads included.
const baseHeaders = (): Record<string, string> => ({
  'content-security-policy': CSP,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
});

function send(res: http.ServerResponse, code: number, body: string | Buffer = '', headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(code, { ...baseHeaders(), 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

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
  const reply = (code: number, body = '', type = 'text/plain; charset=utf-8') => send(res, code, body, { 'content-type': type, connection: 'close' });
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

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!hostOk(req.headers.host)) {
    // Not a name this bridge answers to: a rebinding page, or no Host at all.
    send(res, req.headers.host ? 421 : 400);
    return;
  }
  const t = target(req.url);
  if (!t) {
    send(res, 400, 'bad request');
    return;
  }
  if (upload(req, res, t.path)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
    return;
  }
  // Whether the page is on the address that its saved state belongs to. Nothing
  // secret in it, and without CORS headers another site can't read it.
  if (t.path === '/bridge-info') {
    send(res, 200, JSON.stringify({ stable: stable() }), { 'content-type': 'application/json' });
    return;
  }
  if (t.decoded === undefined || t.decoded.includes('\0')) {
    send(res, 400, 'bad request');
    return;
  }
  const rel = t.decoded === '/' ? '/index.html' : t.decoded;
  const file = path.resolve(dist, '.' + rel);
  let ok = false;
  try {
    ok = file.startsWith(dist + path.sep) && fs.statSync(file).isFile();
  } catch {
    ok = false;
  }
  if (!ok) {
    send(res, 404, 'not found');
    return;
  }
  res.writeHead(200, { ...baseHeaders(), 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (e) {
    log('request failed:', e);
    send(res, 400, 'bad request');
  }
});
// A client that sends something that isn't HTTP gets a 400 from Node itself;
// this only makes sure its socket's errors are never left unhandled.
server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
  else socket.destroy();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
wss.on('error', (e) => log('websocket server:', e));

// The Terminal's shells (terminal.ts): their own socket, for typing and output, and
// small messages only. They end with this process, so a shell never outlives the app.
const terminals = new Terminals();
const termWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
termWss.on('error', (e) => log('terminal websocket server:', e));
process.on('exit', () => terminals.stopAll());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));

function refuse(socket: Duplex, code: number, text: string): void {
  try {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  } catch {
    // already gone
  }
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  // After an upgrade the HTTP server no longer watches this socket's errors.
  socket.on('error', () => {});
  try {
    const t = target(req.url);
    if (!t || (t.path !== '/bridge' && t.path !== '/terminal') || !allowed(req.headers.origin, req.headers.host) || !keyOk(t.query.get('k'))) {
      refuse(socket, 403, 'Forbidden');
      return;
    }
    if (t.path === '/terminal') termWss.handleUpgrade(req, socket, head, (ui) => terminals.serve(ui));
    else wss.handleUpgrade(req, socket, head, (ui) => pipe(ui));
  } catch (e) {
    log('upgrade failed:', e);
    refuse(socket, 400, 'Bad Request');
  }
});

// One runner connection per page connection, authenticated before the page
// is told anything.
function pipe(ui: WebSocket): void {
  const port = runnerPort();
  let token: string;
  try {
    token = readToken();
  } catch {
    ui.close(4404, `no runner token in ${home}`.slice(0, 120));
    return;
  }
  const runner = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { maxPayload: 256 * 1024 * 1024 });
  const clientNonce = crypto.randomBytes(32).toString('hex');
  let runnerNonce = '';
  let authed = false;
  const queued: string[] = [];
  const toRunner = (text: string) => {
    if (runner.readyState === WebSocket.OPEN) runner.send(text);
  };
  const toUi = (text: string) => {
    if (ui.readyState === WebSocket.OPEN) ui.send(text);
  };
  // A runner that never answers the handshake shouldn't leave the page waiting.
  const timer = setTimeout(() => {
    if (!authed) fail(4503, "the runner didn't answer the handshake");
  }, 10_000);
  const fail = (code: number, why: string) => {
    clearTimeout(timer);
    try {
      ui.close(code, why.slice(0, 120));
    } catch {
      // already closed
    }
    try {
      runner.close();
    } catch {
      // already closed
    }
  };

  runner.on('error', () => fail(4503, `the runner isn't answering on port ${port}`));
  runner.on('close', () => fail(4503, 'the runner closed the connection'));
  ui.on('close', () => {
    clearTimeout(timer);
    try {
      runner.close();
    } catch {
      // already closed
    }
  });
  ui.on('error', () => fail(1011, 'the page connection failed'));

  runner.on('message', (data) => {
    try {
      const text = data.toString();
      if (authed) {
        toUi(text);
        return;
      }
      let msg: { method?: string; params?: { nonce?: string }; id?: number; result?: { proof?: string }; error?: unknown } | null;
      try {
        msg = JSON.parse(text);
      } catch {
        return fail(4401, 'bad message before auth');
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail(4401, 'bad message before auth');
      if (msg.method === 'auth.challenge' && typeof msg.params?.nonce === 'string') {
        runnerNonce = msg.params.nonce;
        const proof = hmac(token, `threadbear-rpc-auth-v1 client\n${runnerNonce}\n${clientNonce}\nprimary ${port}`);
        toRunner(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth.prove', params: { nonce: clientNonce, proof } }));
      } else if (msg.id === 1 && typeof msg.result?.proof === 'string') {
        const expected = hmac(token, `threadbear-rpc-auth-v1 runner\n${runnerNonce}\n${clientNonce}\nprimary ${port}`);
        const a = Buffer.from(expected);
        const b = Buffer.from(msg.result.proof);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(4401, "the runner didn't prove it holds the token");
        authed = true;
        clearTimeout(timer);
        for (const q of queued) toRunner(q);
        queued.length = 0;
      } else if (msg.error) {
        fail(4401, 'the runner turned the token down');
      }
    } catch (e) {
      log('runner message failed:', e);
      fail(1011, 'the bridge could not read the runner');
    }
  });

  ui.on('message', (data) => {
    const text = data.toString();
    if (authed) toRunner(text);
    else queued.push(text);
  });
}

// True when this run is on the address the shell asked for, so the page's
// saved state (localStorage, which belongs to the address) is the usual one.
function stable(): boolean {
  return REQUESTED_PORT !== 0 && BRIDGE_PORT === REQUESTED_PORT;
}

let tryPort = REQUESTED_PORT;
server.on('error', (e: NodeJS.ErrnoException) => {
  if (!server.listening) {
    if (FALL_BACK && tryPort !== 0 && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) {
      tryPort = 0;
      server.listen(0, '127.0.0.1');
      return;
    }
    log(`can't listen on 127.0.0.1:${tryPort}: ${e.message}`);
    process.exit(1);
  }
  log('server error:', e);
});
server.on('listening', () => {
  BRIDGE_PORT = (server.address() as { port: number }).port;
  CSP = policy(BRIDGE_PORT);
  ALLOWED_PORTS.add(BRIDGE_PORT);
  console.log(`threadbear desktop bridge -> runner port ${runnerPort()}, data ${home} (${os.platform()})`);
  // The address to open: the key is after the #, which a browser never sends
  // to a server. The page keeps it and wipes it from the address bar.
  console.log(`READY http://127.0.0.1:${BRIDGE_PORT}/#key=${KEY}`);
});
server.listen(tryPort, '127.0.0.1');

// The app shell that started this keeps the other end of our standard input
// open for as long as it lives; the system closes it if the shell is killed or
// crashes, which is the one case it can't tidy up after itself.
if (process.env.THREADBEAR_BRIDGE_WATCH_STDIN === '1') {
  const quit = () => process.exit(0);
  process.stdin.on('end', quit);
  process.stdin.on('close', quit);
  process.stdin.on('error', quit);
  process.stdin.resume();
}
