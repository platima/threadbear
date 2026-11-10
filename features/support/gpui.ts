// The GPUI app: the debug build with the `automation` feature, on the mock
// runner, driven over a local socket that only that build opens. On a Linux
// server with no display it gets a virtual one.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, type Driver, type Dump } from './driver.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exe = process.platform === 'win32' ? 'threadbear-gpui.exe' : 'threadbear-gpui';
const binary = process.env.TB_GPUI_BIN ?? path.join(process.env.CARGO_TARGET_DIR ?? path.join(root, 'desktop/target'), 'debug', exe);

async function waitForFile(file: string, what: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error(`${what} didn't start`);
    await sleep(50);
  }
}

export class GpuiDriver implements Driver {
  readonly name = 'gpui' as const;
  private home = '';
  private children: ChildProcess[] = [];
  private socket?: net.Socket;
  private token = '';
  private buffer = '';
  private waiting: ((line: string) => void)[] = [];
  private log = '';

  private child(cmd: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
    const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout?.on('data', (d) => (this.log += d));
    c.stderr?.on('data', (d) => (this.log += d));
    this.children.push(c);
    return c;
  }

  async start(): Promise<void> {
    if (!fs.existsSync(binary)) throw new Error(`No GPUI app at ${binary}: cargo build -p threadbear-gpui --features automation`);
    this.home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tb-spec-'));
    const ready = path.join(this.home, 'mock-ready');
    // TB_MOCK_FIXTURES swaps the demo threads for that folder's, for one-off checks.
    const fixtures = process.env.TB_MOCK_FIXTURES ? ['--fixtures', process.env.TB_MOCK_FIXTURES] : [];
    this.child(process.execPath, [path.join(root, 'app/Tools/mock-runner/server.mjs'), '--data-dir', this.home, '--port', '0', '--quiet', '--ready-file', ready, ...fixtures], { TB_MOCK_NO_REMOTE: '1' });
    await waitForFile(ready, 'The mock runner', 15_000);

    const file = path.join(this.home, 'automation.json');
    const env: NodeJS.ProcessEnv = {
      THREADBEAR_HOME: this.home,
      THREADBEAR_AUTOMATION: file,
    };
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      // A server: a virtual screen, and a session bus of its own for the
      // desktop settings and portals the app asks for.
      const display = `:${100 + (process.pid % 400)}`;
      this.child('Xvfb', [display, '-screen', '0', '1400x900x24'], {});
      await sleep(400);
      this.child('dbus-run-session', ['--', binary], { ...env, DISPLAY: display, NO_AT_BRIDGE: '1', LIBGL_ALWAYS_SOFTWARE: '1' });
    } else {
      this.child(binary, [], env);
    }
    try {
      await waitForFile(file, 'The app', 30_000);
    } catch (e) {
      throw new Error(`${(e as Error).message}. It said:\n${this.log.slice(-4000)}`);
    }
    const { port, token } = JSON.parse(fs.readFileSync(file, 'utf8')) as { port: number; token: string };
    this.token = token;
    this.socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let at: number;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        this.waiting.shift()?.(line);
      }
    });
  }

  private ask(body: Record<string, unknown>, timeoutSeconds: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${body.cmd} timed out. The app said:\n${this.log.slice(-2000)}`)), timeoutSeconds * 1000);
      this.waiting.push((line) => {
        clearTimeout(timer);
        resolve(JSON.parse(line) as Record<string, unknown>);
      });
      this.socket?.write(`${JSON.stringify({ ...body, token: this.token })}\n`);
    });
  }

  async do(cmd: Record<string, unknown>, timeoutSeconds = 30): Promise<string> {
    const r = await this.ask(cmd, timeoutSeconds);
    if (r.error) throw new Error(`${cmd.cmd}: ${r.error as string}`);
    return typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? '');
  }

  async dump(): Promise<Dump> {
    const r = await this.ask({ cmd: 'dump' }, 30);
    if (r.error) throw new Error(`dump: ${r.error as string}`);
    return r.result as Dump;
  }

  async shot(file: string): Promise<void> {
    await this.do({ cmd: 'screenshot', path: file });
  }

  async stop(): Promise<void> {
    this.socket?.destroy();
    for (const c of this.children.reverse()) c.kill();
    await sleep(100);
    if (this.home) fs.rmSync(this.home, { recursive: true, force: true });
  }
}
