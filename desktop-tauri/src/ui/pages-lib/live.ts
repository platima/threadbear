// Small helpers for pages that keep a list from the runner live: a list that
// loads when the connection opens and follows a notification, a selection
// shared by a page's list column and its main area, and a wrapper for an
// action that shows a plain error instead of throwing.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AppStore } from '../../core/store.ts';

// A runner that doesn't know a method answers -32601; say so plainly.
export function explain(e: unknown, what = 'that'): string {
  const code = (e as { code?: number } | undefined)?.code;
  if (code === -32601) return `This runner doesn't have ${what} yet.`;
  const message = (e as Error | undefined)?.message;
  return message ? message : 'Something went wrong.';
}

// ---- a live list ----------------------------------------------------------

export type LiveState<T> = { items: T[]; loaded: boolean; error?: string };

export class LiveList<T> {
  private state: LiveState<T> = { items: [], loaded: false };
  private listeners = new Set<() => void>();
  private epoch = 0;

  constructor(
    private store: AppStore,
    private what: string,
    private load: () => Promise<T[]>,
    notification: string,
    pick: (params: any) => T[] | undefined,
  ) {
    store.rpc.on(notification, (params) => {
      const items = pick(params);
      if (!items) return;
      this.epoch++;
      this.set({ items, loaded: true, error: undefined });
    });
    store.rpc.onState((s) => {
      if (s === 'open') void this.refresh();
    });
    if (store.rpc.state === 'open') void this.refresh();
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): LiveState<T> => this.state;

  private set(patch: Partial<LiveState<T>>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  async refresh(): Promise<void> {
    const mine = ++this.epoch;
    try {
      const items = await this.load();
      if (mine === this.epoch) this.set({ items, loaded: true, error: undefined });
    } catch (e) {
      if (mine === this.epoch) this.set({ loaded: true, error: explain(e, this.what) });
    }
  }

  // An answer to an action that the notification may be slow to repeat.
  change(fn: (items: T[]) => T[]): void {
    this.set({ items: fn(this.state.items) });
  }
}

const lists = new WeakMap<AppStore, Map<string, LiveList<any>>>();

// One list per store and name, shared by the list column and the main area.
export function useLive<T>(
  store: AppStore,
  name: string,
  make: () => { what: string; load: () => Promise<T[]>; notification: string; pick: (params: any) => T[] | undefined },
): [LiveState<T>, LiveList<T>] {
  let byName = lists.get(store);
  if (!byName) lists.set(store, (byName = new Map()));
  let list = byName.get(name) as LiveList<T> | undefined;
  if (!list) {
    const m = make();
    list = new LiveList<T>(store, m.what, m.load, m.notification, m.pick);
    byName.set(name, list);
  }
  const state = useSyncExternalStore(list.subscribe, list.getSnapshot);
  return [state, list];
}

// ---- the selected item ----------------------------------------------------

// Kept outside React so the list column and the main area agree, and in the
// address (#/projects/<id>) so a link or a reload comes back to it.
const chosen = new Map<string, string | undefined>();
const watchers = new Map<string, Set<() => void>>();

function fromHash(route: string): string | undefined {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  return parts[0] === route && parts[1] ? decodeURIComponent(parts[1]) : undefined;
}

export const NEW = 'new';

export function useSelection(route: string): [string | undefined, (id?: string) => void] {
  if (!chosen.has(route)) chosen.set(route, fromHash(route));
  const subscribe = useCallback(
    (l: () => void) => {
      const set = watchers.get(route) ?? new Set();
      set.add(l);
      watchers.set(route, set);
      return () => {
        set.delete(l);
      };
    },
    [route],
  );
  const value = useSyncExternalStore(subscribe, () => chosen.get(route));
  useEffect(() => {
    if (location.hash.replace(/^#\/?/, '').split('/')[0] !== route) return;
    const want = value && value !== NEW ? `#/${route}/${encodeURIComponent(value)}` : `#/${route}`;
    if (location.hash !== want) history.replaceState(null, '', want);
  }, [route, value]);
  const select = useCallback(
    (id?: string) => {
      chosen.set(route, id);
      for (const l of watchers.get(route) ?? []) l();
    },
    [route],
  );
  return [value, select];
}

// ---- an action ------------------------------------------------------------

// Runs one request at a time and keeps its error as a line of text.
export function useAction(what = 'that') {
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(
    async <R>(fn: () => Promise<R>): Promise<R | undefined> => {
      setBusy(true);
      setError(undefined);
      try {
        return await fn();
      } catch (e) {
        if (alive.current) setError(explain(e, what));
        return undefined;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [what],
  );
  return { run, error, busy, clear: () => setError(undefined) };
}
