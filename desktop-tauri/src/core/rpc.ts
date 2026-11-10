// JSON-RPC 2.0 to the runner (docs/protocol.md), over whatever carries it:
// the Tauri shell's channel or, in a browser, the bridge's WebSocket. The
// carrier has already authenticated (the page never holds the token), so
// this only sends requests, hands out notifications, and reconnects.

export type Transport = {
  send(text: string): void;
  close(): void;
  onopen: () => void;
  onmessage: (text: string) => void;
  onclose: (why: string) => void;
};

export type ConnState = 'connecting' | 'open' | 'closed';

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> };

// What the page does as soon as the carrier is up, before anything else may
// use it: say hello. A connection counts as open (and the retry delay starts
// over) only once this has gone through, since the bridge accepts the page's
// socket before it knows whether the runner is there at all.
export type Handshake = (call: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>) => Promise<void>;

export type RpcOptions = {
  /** The wait before the first retry, doubling up to maxRetryMs. */
  retryMs?: number;
  maxRetryMs?: number;
  /** How long a request may wait for its answer before it fails. */
  requestMs?: number;
  /** How long the handshake may take. */
  handshakeMs?: number;
};

export class RpcClient {
  private transport?: Transport;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<(params: any) => void>>();
  private stateListeners = new Set<(s: ConnState, why?: string) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failure?: string;
  private readonly firstRetry: number;
  private readonly maxRetry: number;
  private readonly requestMs: number;
  private readonly handshakeMs: number;
  private retry: number;
  // While set, a retry comes after the first delay every time instead of growing (see retryNow).
  private hurrying?: ReturnType<typeof setTimeout>;
  handshake?: Handshake;
  state: ConnState = 'closed';

  private readonly connect: () => Transport;

  constructor(connect: () => Transport, opts: RpcOptions = {}) {
    this.connect = connect;
    this.firstRetry = opts.retryMs ?? 500;
    this.maxRetry = opts.maxRetryMs ?? 5000;
    this.requestMs = opts.requestMs ?? 90_000;
    this.handshakeMs = opts.handshakeMs ?? 15_000;
    this.retry = this.firstRetry;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.hurrying);
    this.hurrying = undefined;
    this.transport?.close();
  }

  // Asks for a connection now. For when something outside knows the runner has just come up
  // (the shell started it): waiting out the delay, which grows to maxRetryMs, would show a
  // closed connection beside a runner that is already there. The delay starts over, and for
  // `hurryMs` it stays at its first value, so the runner is found within that long of
  // answering. A connection already open, or being tried, is left alone. Does nothing before
  // start() or after stop().
  retryNow(hurryMs = 0): void {
    if (this.stopped) return;
    this.retry = this.firstRetry;
    clearTimeout(this.hurrying);
    this.hurrying = undefined;
    if (hurryMs > 0) {
      this.hurrying = setTimeout(() => {
        this.hurrying = undefined;
      }, hurryMs);
    }
    // Only a retry that is waiting is brought forward: before the first start() there is none.
    if (this.state === 'closed' && this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.open();
    }
  }

  private setState(s: ConnState, why?: string): void {
    this.state = s;
    for (const l of this.stateListeners) l(s, why);
  }

  private open(): void {
    this.setState('connecting');
    const t = this.connect();
    this.transport = t;
    t.onopen = () => {
      const shake = this.handshake;
      if (!shake) {
        this.opened();
        return;
      }
      const call = <T = unknown>(method: string, params: Record<string, unknown> = {}) => this.send<T>(t, method, params);
      const give = setTimeout(() => this.refuse(t, "The runner didn't answer."), this.handshakeMs);
      shake(call).then(
        () => {
          clearTimeout(give);
          if (this.transport === t) this.opened();
        },
        (e: unknown) => {
          clearTimeout(give);
          this.refuse(t, (e as Error)?.message || 'The runner turned the connection down.');
        },
      );
    };
    t.onmessage = (text) => this.receive(text);
    t.onclose = (why) => {
      if (this.transport !== t) return;
      this.transport = undefined;
      const reason = this.failure ?? why;
      this.failure = undefined;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new RpcError(-1, 'The connection to the runner closed.'));
      }
      this.pending.clear();
      this.setState('closed', reason);
      if (!this.stopped) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.open();
        }, this.retry);
        if (!this.hurrying) this.retry = Math.min(this.retry * 2, this.maxRetry);
      }
    };
  }

  private opened(): void {
    this.retry = this.firstRetry;
    this.setState('open');
  }

  // The handshake failed: end this connection, and let the close be the one
  // way back to trying again (with the delay growing), saying why.
  private refuse(t: Transport, why: string): void {
    if (this.transport !== t) return;
    this.failure ??= why;
    t.close();
  }

  private receive(text: string): void {
    let m: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.error) p.reject(new RpcError(m.error.code, m.error.message));
      else p.resolve(m.result);
    } else if (m.method) {
      for (const h of this.handlers.get(m.method) ?? []) h(m.params);
    }
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.state !== 'open' || !this.transport) return Promise.reject(new RpcError(-1, 'Not connected to the runner.'));
    return this.send<T>(this.transport, method, params);
  }

  // A request that fails after a while rather than waiting for ever on a
  // runner that has stopped answering (a button waiting on it would never come back).
  private send<T>(t: Transport, method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(-2, 'The runner took too long to answer.'));
      }, this.requestMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        t.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RpcError(-1, (e as Error)?.message || 'The connection to the runner closed.'));
      }
    });
  }

  on(method: string, fn: (params: any) => void): () => void {
    const set = this.handlers.get(method) ?? new Set();
    set.add(fn);
    this.handlers.set(method, set);
    return () => set.delete(fn);
  }

  onState(fn: (s: ConnState, why?: string) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
}

// In a browser: the bridge's WebSocket, on the page's own origin.
// The key this launch's bridge wants comes in the address's #key=..., is kept
// for this tab and wiped from the address bar.
const KEY_STORE = 'threadbear.bridgeKey';
export function bridgeKey(): string {
  const m = /(?:^|[#&])key=([\w-]+)/.exec(location.hash);
  try {
    if (m) {
      sessionStorage.setItem(KEY_STORE, m[1]!);
      history.replaceState(null, '', location.pathname + location.search);
    }
    return sessionStorage.getItem(KEY_STORE) ?? m?.[1] ?? '';
  } catch {
    return m?.[1] ?? '';
  }
}

export function bridgeTransport(url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/bridge?k=${encodeURIComponent(bridgeKey())}`): Transport {
  const ws = new WebSocket(url);
  const t: Transport = {
    send: (text) => ws.send(text),
    close: () => ws.close(),
    onopen: () => {},
    onmessage: () => {},
    onclose: () => {},
  };
  ws.onopen = () => t.onopen();
  ws.onmessage = (e) => t.onmessage(String(e.data));
  ws.onclose = (e) => t.onclose(e.reason || `closed (${e.code})`);
  return t;
}
