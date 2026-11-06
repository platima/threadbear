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

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class RpcClient {
  private transport?: Transport;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<(params: any) => void>>();
  private stateListeners = new Set<(s: ConnState, why?: string) => void>();
  private retry = 500;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  state: ConnState = 'closed';

  constructor(private connect: () => Transport) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.transport?.close();
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
      this.retry = 500;
      this.setState('open');
    };
    t.onmessage = (text) => this.receive(text);
    t.onclose = (why) => {
      if (this.transport !== t) return;
      this.transport = undefined;
      for (const p of this.pending.values()) p.reject(new RpcError(-1, 'The connection to the runner closed.'));
      this.pending.clear();
      this.setState('closed', why);
      if (!this.stopped) {
        this.timer = setTimeout(() => this.open(), this.retry);
        this.retry = Math.min(this.retry * 2, 5000);
      }
    };
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
      this.pending.delete(m.id);
      if (m.error) p.reject(new RpcError(m.error.code, m.error.message));
      else p.resolve(m.result);
    } else if (m.method) {
      for (const h of this.handlers.get(m.method) ?? []) h(m.params);
    }
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.state !== 'open' || !this.transport) return Promise.reject(new RpcError(-1, 'Not connected to the runner.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.transport!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
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
export function bridgeTransport(url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/bridge`): Transport {
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
