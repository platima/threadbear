// What the window knows: the connection, the thread list, the open thread's
// transcript. A plain store with subscribe/getSnapshot, read in React with
// useSyncExternalStore. Every change makes a new snapshot object.

import { RpcClient, RpcError, bridgeKey, type ConnState } from './rpc.ts';
import { APP_VERSION } from './version.ts';
import { notifyTransition } from './native.ts';
import { TranscriptModel, type Streaming } from './model.ts';
import type { Account, AnyEvent, ApprovalDecision, AskAnswer, DesignReview, EffortLevel, HelloResult, ImageRef, PermissionMode, PersistedEvent, Pool, ReviewDraft, ThreadSummary } from './types.ts';

// What to show a person when a request fails: a runner that doesn't have the
// method (-32601) is too old for it, not broken.
export function errorText(e: unknown): string {
  if (e instanceof RpcError && e.code === -32601) return "This runner can't do that yet.";
  return (e as Error)?.message || 'Something went wrong.';
}

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
  loadingEarlier: boolean; // older messages are on their way
  notices: Notice[];
};

export class AppStore {
  readonly model = new TranscriptModel();
  private events: PersistedEvent[] = [];
  private listeners = new Set<() => void>();
  private snap: Snapshot = { conn: 'closed', accounts: [], pools: [], threads: new Map(), archivedLoaded: false, loading: false, version: 0, loadingEarlier: false, notices: [] };
  private subscribed?: string;
  private firstSeq = 0;
  private earlierToken = 0;
  hasEarlier = false;

  readonly rpc: RpcClient;

  constructor(rpc: RpcClient) {
    this.rpc = rpc;
    // The connection counts as open once the runner has answered hello (see
    // RpcClient), so the banner and the retry delay follow the runner, not just
    // the bridge's socket.
    rpc.handshake = async (call) => {
      const hello = await call<HelloResult>('hello', { client: 'threadbear-desktop', version: APP_VERSION });
      this.set({ hello, accounts: hello.accounts, pools: hello.pools ?? [] });
    };
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
    rpc.on('runner.notice', (p: Notice) => this.notify(p.level, p.message));
  }

  // A line in the banner. The same one twice in a row is shown once.
  notify(level: Notice['level'], message: string): void {
    const last = this.snap.notices.at(-1);
    if (last && last.level === level && last.message === message) return;
    this.set({ notices: [...this.snap.notices.slice(-4), { level, message }] });
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
      const { threads } = await this.rpc.request<{ threads: ThreadSummary[] }>('threads.list', { include: ['inbox', 'snoozed'] });
      const map = new Map<string, ThreadSummary>();
      for (const t of threads) map.set(t.id, t);
      // Archived ones already loaded stay.
      for (const [id, t] of this.snap.threads) if (t.archivedAt && !map.has(id)) map.set(id, t);
      this.set({ threads: map });
      if (this.snap.selected) await this.open(this.snap.selected, true);
    } catch (e) {
      // The connection closing under this is already said by the banner.
      if (this.snap.conn === 'open') this.notify('error', errorText(e));
    }
  }

  private upsert(t: ThreadSummary): void {
    const threads = new Map(this.snap.threads);
    const before = threads.get(t.id);
    threads.set(t.id, t);
    this.set({ threads });
    if (before) notifyTransition(before, t);
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
    this.earlierToken++;
    this.set({ selected: threadId, loading: true, loadingEarlier: false });
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
      void this.loadPendingReviews(threadId);
      const t = this.snap.threads.get(threadId);
      if (t && t.lastSeq > t.lastSeenSeq) void this.rpc.request('threads.markSeen', { threadId, seq: t.lastSeq }).catch(() => {});
    } catch (e) {
      if (this.snap.selected === threadId) {
        this.set({ loading: false });
        this.notify('error', errorText(e));
      }
    }
  }

  // Back to the new thread page.
  deselect(): void {
    const previous = this.subscribed;
    if (previous) void this.rpc.request('threads.unsubscribe', { threadId: previous }).catch(() => {});
    this.subscribed = undefined;
    this.events = [];
    this.model.reset();
    this.earlierToken++;
    this.set({ selected: undefined, loading: false, loadingEarlier: false });
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

  // Older messages, a page at a time. One request at a time: a second click
  // while one is out would fetch the same page again and double its rows. The
  // reply being written right now and the pending reviews are kept as they are.
  async loadEarlier(): Promise<void> {
    const threadId = this.snap.selected;
    if (!threadId || !this.hasEarlier || this.snap.loadingEarlier) return;
    const token = ++this.earlierToken;
    this.set({ loadingEarlier: true });
    try {
      const page = await this.rpc.request<{ events: PersistedEvent[]; firstSeq: number }>('threads.events', { threadId, beforeSeq: this.firstSeq });
      if (token !== this.earlierToken || this.snap.selected !== threadId) return;
      const older = page.events.filter((e) => e.seq < this.firstSeq);
      this.events = [...older, ...this.events];
      this.firstSeq = page.firstSeq;
      this.hasEarlier = older.length > 0 && page.firstSeq > 1;
      const streaming = [...this.model.streaming.values()].map((s) => ({ ...s }));
      const reviews = [...this.model.reviews.values()];
      this.model.build(this.events, streaming);
      for (const r of reviews) this.model.mergeReview(r);
    } catch (e) {
      if (token === this.earlierToken) this.notify('error', errorText(e));
    } finally {
      if (token === this.earlierToken) this.set({ loadingEarlier: false });
    }
  }

  // ---- actions ------------------------------------------------------------

  async send(threadId: string, text: string, images: ImageRef[] = [], answers: AskAnswer[] = []): Promise<void> {
    await this.rpc.request('threads.send', { threadId, text, ...(images.length ? { images } : {}), ...(answers.length ? { answers } : {}) });
  }

  async create(text: string, opts: { cwd?: string; accountId?: string; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode; images?: ImageRef[] } = {}): Promise<ThreadSummary> {
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

  // Ticks or unticks one ask on the open card. Sends nothing to the agent.
  async tickAsk(threadId: string, asksSeq: number, index: number, ticked: boolean): Promise<void> {
    const { thread } = await this.rpc.request<{ thread: ThreadSummary }>('threads.tickAsk', { threadId, asksSeq, index, ticked });
    this.upsert(thread);
  }

  // Edits one of the person's own messages and carries on from there. A
  // runner with background work running answers -32050 (an RpcError) until
  // stopBackground is true.
  edit(threadId: string, seq: number, text: string, images: ImageRef[] = [], stopBackground = false): Promise<unknown> {
    return this.rpc.request('threads.edit', { threadId, seq, text, ...(images.length ? { images } : {}), ...(stopBackground ? { stopBackground: true } : {}) });
  }

  // The pending reviews the runner lists for the thread, including ones from
  // before the page of events the window loaded. A runner without reviews
  // (-32601) just has none here.
  async loadPendingReviews(threadId: string): Promise<void> {
    try {
      const { reviews } = await this.rpc.request<{ reviews: DesignReview[] }>('reviews.list', { threadId });
      if (this.snap.selected !== threadId) return;
      for (const r of reviews) this.model.mergeReview(r);
      if (reviews.length) this.bump();
    } catch {
      // not there on this runner
    }
  }

  // Sends the answer to a design review. A stale revision (another client
  // saved meanwhile) is read again and tried once more.
  async respondReview(threadId: string, review: DesignReview, draft: ReviewDraft): Promise<void> {
    let revision = review.revision;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.rpc.request('reviews.respond', { threadId, reviewId: review.id, revision, draft });
        return;
      } catch (e) {
        if (attempt > 0 || !(e instanceof RpcError) || e.code !== -32602) throw e;
        const { review: fresh } = await this.rpc.request<{ review: DesignReview }>('reviews.get', { threadId, reviewId: review.id });
        if (fresh.status !== 'pending') throw new RpcError(-32602, `This review is ${fresh.status}.`);
        this.model.mergeReview(fresh);
        revision = fresh.revision;
      }
    }
  }

  async cancelReview(threadId: string, review: DesignReview): Promise<void> {
    await this.rpc.request('reviews.cancel', { threadId, reviewId: review.id, revision: review.revision });
  }

  // A file on the runner's machine, as base64 (a picture's bytes). The page
  // can't read the runner's disk itself.
  readFile(path: string): Promise<{ data: string; mediaType: string; size: number; truncated: boolean }> {
    return this.rpc.request('files.read', { path });
  }

  // A picture the person pasted, dropped or chose: the bridge keeps it in a
  // temp file the runner can reach (POST /upload), the runner imports it
  // (media.import) and the temp file is removed again.
  async importImage(file: Blob): Promise<ImageRef> {
    const key = bridgeKey();
    const up = await fetch('upload', { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', 'x-threadbear-key': key }, body: file });
    if (up.status === 404) throw new Error("This build can't take pictures yet.");
    if (!up.ok) throw new Error((await up.text().catch(() => '')) || `The picture wasn't accepted (${up.status}).`);
    const { id, path } = (await up.json()) as { id: string; path: string };
    try {
      const { image } = await this.rpc.request<{ image: ImageRef }>('media.import', { path });
      return image;
    } finally {
      void fetch(`upload/${id}`, { method: 'DELETE', headers: { 'x-threadbear-key': key } }).catch(() => {});
    }
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
