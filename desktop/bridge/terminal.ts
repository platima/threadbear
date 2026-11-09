// The Terminal's shells: one pseudo-terminal per thread (or the home folder), held
// here in the bridge so they outlive a page reload and a thread being looked away
// from, and reached by the page over one WebSocket (/terminal) that carries every
// shell's input and output. It lives here, not in the Rust shell, because this is
// Node: node-pty has ConPTY and prebuilt binaries, the shells can be tested on any
// machine, and it works in a browser tab as well as in the installed app.
//
// What the page sends (JSON text):
//   {t:'shells', refresh?}                       the shells this PC has, and the default
//   {t:'open', key, shell?, cwd?, cols, rows, create?}
//                                                 attach to key's shell, starting one when
//                                                 create is true and there isn't one running
//   {t:'in', key, d}  {t:'resize', key, cols, rows}  {t:'stop', key}
//   {t:'prune', keep:[key...]}                   stop every shell whose key isn't listed
// What it gets back:
//   {t:'shells', ...}  {t:'opened', key, shell, cwd, replay?}  {t:'none', key}
//   {t:'out', key, d}  {t:'exit', key, code}  {t:'error', key?, message}
//
// A shell starts only when the page asks for one with create. It stops when the page
// stops it (the thread was archived or deleted), when it exits, and when the bridge
// ends, which the app shell does when the app quits.

import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import type WebSocket from 'ws';
import { command, pick, shellsNow, type Shell, type ShellList } from './shells.ts';

/** The part of node-pty's terminal this uses, so a test can stand one in. */
export type Pty = {
  pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (e: { exitCode: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pause(): void;
  resume(): void;
};
export type Spawn = (file: string, args: string[], opts: { cols: number; rows: number; cwd: string; env: Record<string, string> }) => Pty;

/** The real node-pty, loaded when the first shell starts. Throws what went wrong if it can't be. */
export function realSpawn(): Spawn {
  const require = createRequire(import.meta.url);
  let pty: { spawn: (file: string, args: string[], opts: Record<string, unknown>) => Pty };
  try {
    pty = require('@lydell/node-pty');
  } catch (e) {
    throw new Error(`The terminal is not available in this copy of Threadbear: ${(e as Error).message.split('\n')[0]}`);
  }
  return (file, args, opts) => pty.spawn(file, args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env });
}

const SCROLLBACK = 256 * 1024;
const MAX_SHELLS = 16;
const HIGH = 1024 * 1024;
const LOW = 256 * 1024;

// The shell's environment: the bridge's, less what must not reach a program typed
// into it, and what a terminal says about itself. A thread's id is what tells `tb`
// that its caller is that thread's agent (runner/src/cli.ts), and the bridge's key
// opens its pipe to the runner.
export function shellEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') env[k] = v;
  for (const k of Object.keys(env)) if (/^THREADBEAR_(BRIDGE_KEY|THREAD_ID)$|^THREADBARE_THREAD_ID$/i.test(k)) delete env[k];
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Threadbear';
  if (platform !== 'win32' && !env.LANG) env.LANG = 'en_US.UTF-8';
  return env;
}

type Sink = (message: Record<string, unknown>) => void;

type Session = {
  key: string;
  pty: Pty;
  shell: Shell;
  cwd: string;
  chunks: string[];
  size: number;
  exited?: number;
  sinks: Set<Sink>;
  paused: boolean;
};

export type OpenOptions = { shell?: string; cwd?: string; cols?: number; rows?: number; create?: boolean };

const clamp = (n: unknown, lo: number, hi: number, fallback: number): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback);

export class Terminals {
  private sessions = new Map<string, Session>();

  // Node runs this file with its types stripped, which has no parameter properties.
  private readonly deps: {
    spawn?: () => Spawn;
    shells?: (refresh?: boolean) => Promise<ShellList>;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    home?: string;
    isDir?: (dir: string) => boolean;
  };

  constructor(deps: Terminals['deps'] = {}) {
    this.deps = deps;
  }

  private get home(): string {
    return this.deps.home ?? os.homedir();
  }

  // node-pty, loaded on first use: a copy without it still serves everything else, and
  // says why in the Terminal. Undefined when it loads, otherwise what went wrong.
  private loaded?: { spawn?: Spawn; why?: string };
  private ptySpawn(): Spawn {
    if (!this.loaded) {
      try {
        this.loaded = { spawn: (this.deps.spawn ?? realSpawn)() };
      } catch (e) {
        this.loaded = { why: (e as Error).message };
      }
    }
    if (!this.loaded.spawn) throw new Error(this.loaded.why);
    return this.loaded.spawn;
  }

  /** Why no shell can start in this copy, or undefined when one can. */
  unavailable(): string | undefined {
    try {
      this.ptySpawn();
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  }

  private isDir(dir: string): boolean {
    try {
      return (this.deps.isDir ?? ((d: string) => fs.statSync(d).isDirectory()))(dir);
    } catch {
      return false;
    }
  }

  shells(refresh = false): Promise<ShellList> {
    return (this.deps.shells ?? shellsNow)(refresh);
  }

  /** Which shells are running, for the page after a reload. */
  running(): string[] {
    return [...this.sessions.values()].filter((s) => s.exited === undefined).map((s) => s.key);
  }

  /**
   * Attaches `sink` to key's shell. With no shell running there, starts one when
   * `create` is true and otherwise says there is none. A shell that has exited is
   * replaced by a new one only on create.
   */
  async open(key: string, o: OpenOptions, sink: Sink): Promise<void> {
    const existing = this.sessions.get(key);
    if (existing && (existing.exited === undefined || !o.create)) {
      existing.sinks.add(sink);
      sink({ t: 'opened', key, shell: existing.shell.label, cwd: existing.cwd, replay: existing.chunks.join(''), exited: existing.exited });
      if (existing.exited !== undefined) sink({ t: 'exit', key, code: existing.exited });
      return;
    }
    if (!o.create) {
      sink({ t: 'none', key });
      return;
    }
    if (existing) this.stop(key);
    if (this.sessions.size >= MAX_SHELLS) throw new Error(`There are ${MAX_SHELLS} shells running already. Close one first.`);
    const list = await this.shells();
    const { shell, fellBack } = pick(list, o.shell);
    if (!shell) throw new Error('No shell was found on this PC to start.');
    const cwd = o.cwd && this.isDir(o.cwd) ? o.cwd : this.home;
    const { file, args } = command(shell, cwd);
    const pty = this.ptySpawn()(file, args, { cols: clamp(o.cols, 2, 1000, 80), rows: clamp(o.rows, 1, 500, 24), cwd, env: shellEnv(this.deps.env ?? process.env, this.deps.platform) });
    const s: Session = { key, pty, shell, cwd, chunks: [], size: 0, sinks: new Set([sink]), paused: false };
    this.sessions.set(key, s);
    pty.onData((d) => this.output(s, d));
    pty.onExit((e) => {
      s.exited = e.exitCode ?? 0;
      this.tell(s, { t: 'exit', key, code: s.exited });
    });
    sink({ t: 'opened', key, shell: shell.label, cwd, fresh: true, fellBack });
  }

  private output(s: Session, d: string): void {
    s.chunks.push(d);
    s.size += d.length;
    while (s.size > SCROLLBACK && s.chunks.length > 1) s.size -= s.chunks.shift()!.length;
    this.tell(s, { t: 'out', key: s.key, d });
  }

  private tell(s: Session, message: Record<string, unknown>): void {
    for (const sink of s.sinks) sink(message);
  }

  /** The page's connection can't keep up: hold the shell's output until it does (a `cat` of a big file). */
  hold(key: string, hold: boolean): void {
    const s = this.sessions.get(key);
    if (!s || s.exited !== undefined || s.paused === hold) return;
    s.paused = hold;
    try {
      if (hold) s.pty.pause();
      else s.pty.resume();
    } catch {
      // the shell has just gone
    }
  }

  detach(sink: Sink): void {
    for (const s of this.sessions.values()) s.sinks.delete(sink);
  }

  write(key: string, data: string): void {
    const s = this.sessions.get(key);
    if (s && s.exited === undefined) s.pty.write(data);
  }

  resize(key: string, cols: number, rows: number): void {
    const s = this.sessions.get(key);
    if (!s || s.exited !== undefined) return;
    try {
      s.pty.resize(clamp(cols, 2, 1000, 80), clamp(rows, 1, 500, 24));
    } catch {
      // the shell has just gone
    }
  }

  stop(key: string): void {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    s.sinks.clear();
    if (s.exited === undefined) {
      try {
        s.pty.kill();
      } catch {
        // already gone
      }
    }
  }

  prune(keep: string[]): void {
    const wanted = new Set(keep);
    for (const key of [...this.sessions.keys()]) if (!wanted.has(key)) this.stop(key);
  }

  stopAll(): void {
    for (const key of [...this.sessions.keys()]) this.stop(key);
  }

  /** Serves one page connection until it closes. */
  serve(ws: WebSocket): void {
    const send: Sink = (message) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(message), () => {
        if (ws.bufferedAmount < LOW) for (const k of this.running()) this.hold(k, false);
      });
      if (ws.bufferedAmount > HIGH) for (const k of this.running()) this.hold(k, true);
    };
    ws.on('close', () => this.detach(send));
    ws.on('error', () => this.detach(send));
    ws.on('message', (data) => {
      let m: { t?: unknown; key?: unknown; [k: string]: unknown };
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
      const key = typeof m.key === 'string' && m.key.length > 0 && m.key.length <= 200 ? m.key : undefined;
      try {
        switch (m.t) {
          case 'shells':
            void this.shells(m.refresh === true).then(
              (list) => send({ t: 'shells', shells: list.shells.map((s) => ({ id: s.id, label: s.label })), auto: list.auto, notes: list.notes, unavailable: this.unavailable() }),
              (e: unknown) => send({ t: 'error', message: (e as Error).message }),
            );
            break;
          case 'open':
            if (!key) break;
            this.open(
              key,
              { shell: typeof m.shell === 'string' ? m.shell : undefined, cwd: typeof m.cwd === 'string' ? m.cwd : undefined, cols: m.cols as number, rows: m.rows as number, create: m.create === true },
              send,
            ).catch((e: unknown) => send({ t: 'error', key, message: (e as Error).message }));
            break;
          case 'in':
            if (key && typeof m.d === 'string') this.write(key, m.d);
            break;
          case 'resize':
            if (key) this.resize(key, m.cols as number, m.rows as number);
            break;
          case 'stop':
            if (key) this.stop(key);
            break;
          case 'prune':
            if (Array.isArray(m.keep)) this.prune(m.keep.filter((k): k is string => typeof k === 'string'));
            break;
        }
      } catch (e) {
        send({ t: 'error', key, message: (e as Error).message });
      }
    });
  }
}
