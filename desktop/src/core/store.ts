// What the window knows: the connection, the thread list, the open thread's
// transcript. A plain store with subscribe/getSnapshot, read in React with
// useSyncExternalStore. Every change makes a new snapshot object.

import { RpcClient, type ConnState } from './rpc.ts';
import { TranscriptModel, type Streaming } from './model.ts';
import type { Account, AnyEvent, ApprovalDecision, HelloResult, ImageRef, PermissionMode, PersistedEvent, Pool, ThreadSummary } from './types.ts';

export type Notice = { level: 'info' | 'warning' | 'error'; message: string };

export type Snapshot = {
  conn: ConnState;
  connWhy?: string;
  hello?: HelloResult;
  accounts: Account[];
  pools: Pool[];
  threads: Map<string, ThreadSummary>;
  archivedLoaded: boolean;
  selected?: string;
  loading: boolean;
  version: number; // the open thread's transcript
  notices: Notice[];
};

export class AppStore {
  readonly model = new TranscriptModel();
  private events: PersistedEvent[] = [];
  private listeners = new Set<() => void>();
  private snap: Snapshot = { conn: 'closed', accounts: [], pools: [], threads: new Map(), archivedLoaded: false, loading: false, version: 0, notices: [] };
  private subscribed?: string;
  private firstSeq = 0;
  hasEarlier = false;

  constructor(readonly rpc: RpcClient) {
    rpc.onState((s, why) => {
      this.set({ conn: s, connWhy: why });
      if (s === 'open') void this.onOpen();
    });
    rpc.on('thread.updated', (p: { thread: ThreadSummary }) => this.upsert(p.thread));
    rpc.on('thread.deleted', (p: { threadId: string }) => {
      const threads = new Map(this.snap.threads);
      threads.delete(p.threadId);
      this.set({ threads, ...(this.snap.selected === p.threadId ? { selected: undefined } : {}) });
    });
    rpc.on('thread.event', (p: { threadId: string; event: AnyEvent }) => {
      if (p.threadId !== this.snap.selected) return;
      this.applyLive(p.event);
    });
    rpc.on('accounts.updated', (p: { accounts: Account[] }) => this.set({ accounts: p.accounts }));
    rpc.on('pools.updated', (p: { pools: Pool[] }) => this.set({ pools: p.pools }));
    rpc.on('runner.notice', (p: Notice) => this.set({ notices: [...this.snap.notices.slice(-4), p] }));
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): Snapshot => this.snap;

  private set(patch: Partial<Snapshot>): void {
    this.snap = { ...this.snap, ...patch, version: this.model.version + (patch.version ?? 0) };
    for (const l of this.listeners) l();
  }

  private bump(): void {
    this.set({});
  }

  start(): void {
    this.rpc.start();
  }

  // ---- connection ---------------------------------------------------------

  private async onOpen(): Promise<void> {
    try {
      const hello = await this.rpc.request<HelloResult>('hello', { client: 'threadbear-desktop', version: '0.0.0' });
      this.set({ hello, accounts: hello.accounts, pools: hello.pools ?? [] });
      const { threads } = await this.rpc.request<{ threads: ThreadSummary[] }>('threads.list', { include: ['inbox', 'snoozed'] });
      const map = new Map<string, ThreadSummary>();
      for (const t of threads) map.set(t.id, t);
      // Archived ones already loaded stay.
      for (const [id, t] of this.snap.threads) if (t.archivedAt && !map.has(id)) map.set(id, t);
      this.set({ threads: map });
      if (this.snap.selected) await this.open(this.snap.selected, true);
    } catch (e) {
      this.set({ notices: [...this.snap.notices.slice(-4), { level: 'error', message: String((e as Error).message) }] });
    }
  }

  private upsert(t: ThreadSummary): void {
    const threads = new Map(this.snap.threads);
    threads.set(t.id, t);
    this.set({ threads });
  }

  async loadArchived(): Promise<void> {
    const { threads } = await this.rpc.request<{ threads: ThreadSummary[] }>('threads.list', { include: ['archived'] });
    const map = new Map(this.snap.threads);
    for (const t of threads) map.set(t.id, t);
    this.set({ threads: map, archivedLoaded: true });
  }

  // ---- the open thread ----------------------------------------------------

  async open(threadId: string, again = false): Promise<void> {
    if (!again && this.snap.selected === threadId) return;
    const previous = this.subscribed;
    if (previous && previous !== threadId) void this.rpc.request('threads.unsubscribe', { threadId: previous }).catch(() => {});
    this.events = [];
    this.model.reset();
    this.subscribed = undefined;
    this.set({ selected: threadId, loading: true });
    try {
      const page = await this.rpc.request<{ events: PersistedEvent[]; firstSeq: number; lastSeq: number; inProgress: Streaming[] }>('threads.events', { threadId });
      if (this.snap.selected !== threadId) return;
      this.events = page.events;
      this.firstSeq = page.firstSeq;
      this.hasEarlier = page.events.length > 0 && page.firstSeq > 1;
      this.model.build(this.events);
      const sub = await this.rpc.request<{ events: PersistedEvent[]; inProgress: Streaming[] }>('threads.subscribe', { threadId, afterSeq: this.model.lastSeq });
      if (this.snap.selected !== threadId) return;
      this.subscribed = threadId;
      for (const e of sub.events) this.applyLive(e, true);
      this.model.setInProgress(sub.inProgress);
      this.set({ loading: false });
      const t = this.snap.threads.get(threadId);
      if (t && t.lastSeq > t.lastSeenSeq) void this.rpc.request('threads.markSeen', { threadId, seq: t.lastSeq }).catch(() => {});
    } catch (e) {
      if (this.snap.selected === threadId) this.set({ loading: false, notices: [...this.snap.notices.slice(-4), { level: 'error', message: String((e as Error).message) }] });
    }
  }

  // Back to the new thread page.
  deselect(): void {
    const previous = this.subscribed;
    if (previous) void this.rpc.request('threads.unsubscribe', { threadId: previous }).catch(() => {});
    this.subscribed = undefined;
    this.events = [];
    this.model.reset();
    this.set({ selected: undefined, loading: false });
  }

  private applyLive(e: AnyEvent, quiet = false): void {
    const persisted = !e.type.endsWith('.delta');
    if (persisted) {
      if (e.seq <= this.model.lastSeq) return;
      this.events.push(e as PersistedEvent);
    }
    this.model.apply(e);
    if (!quiet) this.bump();
  }

  async loadEarlier(): Promise<void> {
    const threadId = this.snap.selected;
    if (!threadId || !this.hasEarlier) return;
    const page = await this.rpc.request<{ events: PersistedEvent[]; firstSeq: number }>('threads.events', { threadId, beforeSeq: this.firstSeq });
    if (this.snap.selected !== threadId) return;
    this.events = [...page.events, ...this.events];
    this.firstSeq = page.firstSeq;
    this.hasEarlier = page.events.length > 0 && page.firstSeq > 1;
    this.model.build(this.events);
    this.bump();
  }

  // ---- actions ------------------------------------------------------------

  async send(threadId: string, text: string, images: ImageRef[] = []): Promise<void> {
    await this.rpc.request('threads.send', { threadId, text, ...(images.length ? { images } : {}) });
  }

  async create(text: string, opts: { cwd?: string; accountId?: string; model?: string; permissionMode?: PermissionMode; images?: ImageRef[] } = {}): Promise<ThreadSummary> {
    const { thread } = await this.rpc.request<{ thread: ThreadSummary }>('threads.create', { text, ...opts });
    this.upsert(thread);
    await this.open(thread.id);
    return thread;
  }

  interrupt(threadId: string): Promise<unknown> {
    return this.rpc.request('threads.interrupt', { threadId });
  }

  async update(threadId: string, patch: Record<string, unknown>): Promise<void> {
    const { thread } = await this.rpc.request<{ thread: ThreadSummary }>('threads.update', { threadId, ...patch });
    this.upsert(thread);
  }

  respond(threadId: string, approvalId: string, decision: ApprovalDecision, extra: { message?: string; answers?: Record<string, string> } = {}): Promise<unknown> {
    return this.rpc.request('approvals.respond', { threadId, approvalId, decision, ...extra });
  }

  answerSecret(threadId: string, approvalId: string, secret?: string): Promise<unknown> {
    return this.rpc.request('secrets.answer', { threadId, approvalId, ...(secret === undefined ? { decline: true } : { secret }) });
  }

  async search(query: string): Promise<ThreadSummary[]> {
    return (await this.rpc.request<{ threads: ThreadSummary[] }>('threads.search', { query, limit: 50 })).threads;
  }
}
