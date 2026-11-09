// The Terminal's shells as the window sees them: which shell each thread has and what
// state it is in, over the bridge's /terminal socket (bridge/terminal.ts has the other
// end and the protocol). The drawing is ui/TerminalDock.tsx, which hands this a sink per
// shell to write the output into; nothing here touches the DOM, so it is tested in Node.
//
// A shell is started only when the person asks (the Start a shell button, or opening the
// terminal with Ctrl+J). Looking at a thread, or reloading the window, only finds the
// shell that is already there. A thread's shell ends when the thread is archived or deleted.

import { bridgeKey, bridgeTransport, type Transport } from './rpc.ts';
import type { ThreadSummary } from './types.ts';

export type ShellChoice = { id: string; label: string };
export type ShellsInfo = { shells: ShellChoice[]; auto?: string; notes: string[]; unavailable?: string };

/** Where a terminal runs: its key (the thread, or "home") and folder, and a line when it isn't the thread's. */
export type Target = { key: string; cwd?: string; note?: string };

export const HOME_KEY = 'home';

export function targetFor(thread: ThreadSummary | undefined): Target {
  if (!thread) return { key: HOME_KEY };
  // An archived thread's worktree may have been handed to a newer thread since (archiving keeps it
  // as a spare), so its folder could be someone else's checkout now. Its own shell was stopped.
  if (thread.archivedAt) return { key: HOME_KEY, note: 'This thread is archived, so this terminal is in your home folder.' };
  if (!thread.cwd) return { key: HOME_KEY, note: "This thread has no folder, so this terminal is in your home folder." };
  return { key: thread.id, cwd: thread.cwd };
}

export type SessionStatus = 'looking' | 'none' | 'starting' | 'running' | 'exited';

export type Session = {
  status: SessionStatus;
  shell?: string;
  cwd?: string;
  /** Said above the terminal when it isn't where the person would expect. */
  note?: string;
  code?: number;
  error?: string;
};

/** What the drawing layer gives for one shell. */
export type Sink = {
  write(data: string): void;
  /** Wipe the screen: what the bridge is about to replay is all of it. */
  reset(): void;
  dispose(): void;
};

export type Snapshot = {
  sessions: ReadonlyMap<string, Session>;
  shells?: ShellsInfo;
  /** The shell chosen to start by default: an id from the list, or "auto". */
  choice: string;
  version: number;
};

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;
const CHOICE_KEY = 'threadbear.terminalShell';

/** The shell the person chose to start by default: an id from the list, or "auto". */
export function shellChoice(store: KeyValue | undefined = safeStorage()): string {
  try {
    return store?.getItem(CHOICE_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

/** Keeps the choice. False when this window can't keep it. */
export function setShellChoice(id: string, store: KeyValue | undefined = safeStorage()): boolean {
  try {
    if (!store) return false;
    store.setItem(CHOICE_KEY, id);
    return store.getItem(CHOICE_KEY) === id;
  } catch {
    return false;
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** What the default shell is called, for a button or a tooltip. */
export function choiceLabel(info: ShellsInfo | undefined, choice: string): string {
  const auto = info?.shells.find((s) => s.id === info.auto)?.label;
  if (choice === 'auto' || !info) return auto ? `Automatic (${auto})` : 'Automatic';
  return info.shells.find((s) => s.id === choice)?.label ?? (auto ? `${auto} (the one you chose is gone)` : 'Automatic');
}

type Message = Record<string, unknown> & { t: string; key?: string };

const DEFAULT_SIZE = { cols: 80, rows: 24 };

export class TerminalSessions {
  private sinks = new Map<string, Sink>();
  private sizes = new Map<string, { cols: number; rows: number }>();
  // Output that came before the drawing layer had a sink for it (a replay on reload).
  private pending = new Map<string, string[]>();
  private listeners = new Set<() => void>();
  private snap: Snapshot;
  private transport?: Transport;
  private up = false;
  private queue: string[] = [];
  private retry = 500;
  private timer?: ReturnType<typeof setTimeout>;
  private shellsWaiting: ((info: ShellsInfo) => void)[] = [];
  private readonly connect: () => Transport;
  private readonly store: KeyValue | undefined;

  constructor(connect: () => Transport, store?: KeyValue) {
    this.connect = connect;
    this.store = store;
    this.snap = { sessions: new Map(), choice: shellChoice(store), version: 0 };
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): Snapshot => this.snap;

  private set(key: string, patch: Partial<Session> | undefined): void {
    const sessions = new Map(this.snap.sessions);
    if (patch === undefined) sessions.delete(key);
    else sessions.set(key, { ...(sessions.get(key) ?? { status: 'none' as const }), ...patch });
    this.publish({ sessions });
  }

  private publish(patch: Partial<Snapshot>): void {
    this.snap = { ...this.snap, ...patch, version: this.snap.version + 1 };
    for (const l of this.listeners) l();
  }

  session(key: string): Session | undefined {
    return this.snap.sessions.get(key);
  }

  // ---- the socket -----------------------------------------------------------

  private send(m: Message): void {
    const text = JSON.stringify(m);
    if (this.up && this.transport) this.transport.send(text);
    else {
      this.queue.push(text);
      this.reach();
    }
  }

  private reach(): void {
    if (this.transport) return;
    clearTimeout(this.timer);
    const t = this.connect();
    this.transport = t;
    t.onopen = () => {
      this.up = true;
      this.retry = 500;
      // Shells found again after a drop come back with what they printed meanwhile. (A start or a
      // look that was waiting for the socket is in the queue and goes out after.)
      const queued = this.queue;
      this.queue = [];
      for (const key of this.keys()) if (this.session(key)!.status === 'running') this.sendOpen(key, false);
      for (const text of queued) t.send(text);
    };
    t.onmessage = (text) => {
      try {
        this.heard(JSON.parse(text) as Message);
      } catch {
        // not ours
      }
    };
    t.onclose = () => {
      if (this.transport !== t) return;
      this.transport = undefined;
      this.up = false;
      // Typing queued for a socket that never came up is dropped, not typed later.
      this.queue = [];
      for (const w of this.shellsWaiting.splice(0)) w({ shells: [], notes: [], unavailable: "The window couldn't reach the Terminal." });
      // A start or a look whose answer never came is over; a running shell is found again on reconnecting.
      for (const key of this.keys()) {
        const s = this.session(key)!;
        if (s.status === 'starting' || s.status === 'looking') this.set(key, { status: 'none', error: "The window lost its connection to the Terminal. Try again." });
      }
      if (this.keys().some((k) => this.session(k)!.status === 'running')) {
        this.timer = setTimeout(() => this.reach(), this.retry);
        this.retry = Math.min(this.retry * 2, 5000);
      }
    };
  }

  private keys(): string[] {
    return [...this.snap.sessions.keys()];
  }

  private heard(m: Message): void {
    const key = typeof m.key === 'string' ? m.key : undefined;
    switch (m.t) {
      case 'shells': {
        const info: ShellsInfo = {
          shells: Array.isArray(m.shells) ? (m.shells as ShellChoice[]) : [],
          auto: typeof m.auto === 'string' ? m.auto : undefined,
          notes: Array.isArray(m.notes) ? (m.notes as string[]) : [],
          unavailable: typeof m.unavailable === 'string' ? m.unavailable : undefined,
        };
        this.publish({ shells: info });
        for (const w of this.shellsWaiting.splice(0)) w(info);
        break;
      }
      case 'opened': {
        if (!key || !this.session(key)) break; // stopped meanwhile
        const before = this.session(key);
        // The bridge puts a shell whose folder isn't there in the home folder; say so.
        const asked = this.asked.get(key);
        const moved = asked !== undefined && typeof m.cwd === 'string' && m.cwd.toLowerCase() !== asked.toLowerCase();
        const note =
          (m.fellBack === true ? 'The shell you chose is not on this PC any more, so the default one was started. ' : '') + (moved ? "This thread's folder isn't on this PC any more, so this terminal is in your home folder." : '');
        if (typeof m.replay === 'string') {
          this.sinks.get(key)?.reset();
          this.pending.delete(key);
          if (m.replay) this.give(key, m.replay);
        }
        this.set(key, { status: typeof m.exited === 'number' ? 'exited' : 'running', shell: String(m.shell ?? ''), cwd: String(m.cwd ?? ''), note: note.trim() || before?.note, error: undefined, ...(typeof m.exited === 'number' ? { code: m.exited } : {}) });
        const size = this.sizes.get(key);
        if (size && typeof m.exited !== 'number') this.send({ t: 'resize', key, cols: size.cols, rows: size.rows });
        break;
      }
      case 'none':
        if (key && this.session(key)) this.set(key, { status: 'none', shell: undefined, code: undefined, error: this.session(key)?.status === 'running' ? 'The shell ended when Threadbear restarted.' : undefined });
        break;
      case 'out':
        if (key && typeof m.d === 'string') this.give(key, m.d);
        break;
      case 'exit':
        if (key && this.session(key)) this.set(key, { status: 'exited', code: typeof m.code === 'number' ? m.code : 0 });
        break;
      case 'error': {
        const was = key ? this.session(key)?.status : undefined;
        const message = String(m.message ?? 'The terminal reported an error.');
        if (key && was) this.set(key, { status: was === 'starting' || was === 'looking' ? 'none' : was, error: message });
        else this.publish({ shells: { ...(this.snap.shells ?? { shells: [], notes: [] }), unavailable: message } });
        break;
      }
    }
  }

  private give(key: string, data: string): void {
    if (!this.session(key)) return; // a shell already stopped
    const sink = this.sinks.get(key);
    if (sink) sink.write(data);
    else this.pending.set(key, [...(this.pending.get(key) ?? []), data]);
  }

  // ---- what the window does -------------------------------------------------

  private asked = new Map<string, string>();

  private sendOpen(key: string, create: boolean, extra: Record<string, unknown> = {}): void {
    const size = this.sizes.get(key) ?? DEFAULT_SIZE;
    this.send({ t: 'open', key, cols: size.cols, rows: size.rows, create, ...extra });
  }

  /** The Terminal's list of shells (the bridge looks at the PC; `refresh` makes it look again). */
  loadShells(refresh = false): Promise<ShellsInfo> {
    return new Promise((resolve) => {
      this.shellsWaiting.push(resolve);
      this.send({ t: 'shells', refresh });
    });
  }

  /** Finds the shell already running for this key, if any, without starting one. */
  look(key: string): void {
    if (this.session(key)) return;
    this.set(key, { status: 'looking' });
    this.sendOpen(key, false);
  }

  /** Changes the default shell. False when this window can't keep it (it still applies until it closes). */
  setChoice(id: string): boolean {
    const kept = setShellChoice(id, this.store);
    this.publish({ choice: id });
    return kept;
  }

  /** Makes sure the key has a shell: finds the one running or starts one. A shell that has ended is left to the person. */
  ensure(key: string, cwd: string | undefined): void {
    const s = this.session(key)?.status;
    if (!s || s === 'none' || s === 'looking') this.start(key, cwd);
  }

  /** Starts a shell for the key in its folder: the default one, or the one the person chose. */
  start(key: string, cwd: string | undefined, choice = this.snap.choice): void {
    const s = this.session(key);
    if (s && (s.status === 'running' || s.status === 'starting')) return;
    if (cwd) this.asked.set(key, cwd);
    else this.asked.delete(key);
    this.set(key, { status: 'starting', shell: undefined, code: undefined, error: undefined, note: undefined });
    this.pending.delete(key);
    this.sinks.get(key)?.reset();
    this.sendOpen(key, true, { ...(cwd ? { cwd } : {}), ...(choice && choice !== 'auto' ? { shell: choice } : {}) });
  }

  input(key: string, data: string): void {
    if (this.session(key)?.status === 'running') this.send({ t: 'in', key, d: data });
  }

  resize(key: string, cols: number, rows: number): void {
    this.sizes.set(key, { cols, rows });
    const s = this.session(key)?.status;
    if (s === 'running' || s === 'starting') this.send({ t: 'resize', key, cols, rows });
  }

  /** Ends the shell and forgets it (the thread was archived or deleted, or the person stopped it). */
  stop(key: string): void {
    if (!this.session(key)) return;
    this.send({ t: 'stop', key });
    this.forget(key);
  }

  private forget(key: string): void {
    this.sinks.get(key)?.dispose();
    this.sinks.delete(key);
    this.pending.delete(key);
    this.asked.delete(key);
    this.sizes.delete(key);
    this.set(key, undefined);
  }

  /** Stops the shells of threads that were archived or have gone. Called as the thread list changes. */
  reconcile(threads: ReadonlyMap<string, ThreadSummary>, listed: boolean): void {
    for (const key of this.keys()) {
      if (key === HOME_KEY) continue;
      const t = threads.get(key);
      // A thread missing from the list is deleted, or archived and not loaded: either way its shell ends.
      // But not before the list has come, or a window just opened would end them all.
      if (t?.archivedAt || (!t && listed)) this.stop(key);
    }
  }

  /** The drawing layer's sink for a shell: output waiting for it is written at once. */
  register(key: string, sink: Sink): void {
    this.sinks.set(key, sink);
    const waiting = this.pending.get(key);
    this.pending.delete(key);
    for (const d of waiting ?? []) sink.write(d);
  }

  unregister(key: string, sink: Sink): void {
    if (this.sinks.get(key) === sink) this.sinks.delete(key);
  }

  /** Closes the socket; the shells stay in the bridge. */
  close(): void {
    clearTimeout(this.timer);
    this.transport?.close();
    this.transport = undefined;
    this.up = false;
  }
}

let shared: TerminalSessions | undefined;
/** The window's terminals: one socket, made when the first one is needed. */
export function terminals(): TerminalSessions {
  shared ??= new TerminalSessions(() => bridgeTransport(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/terminal?k=${encodeURIComponent(bridgeKey())}`));
  return shared;
}
