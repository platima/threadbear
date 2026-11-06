// Hooks for pages that ask the runner things: a request that loads when the
// connection opens, can repeat while the page is showing, and never throws.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppStore } from '../../core/store.ts';
import { errorText, isMissing } from './ops-format.ts';

export type ReqError = { message: string; missing: boolean };

export function toReqError(e: unknown): ReqError {
  return { message: errorText(e), missing: isMissing(e) };
}

// `every` (ms) asks again on that beat, but only while the page is mounted
// and the window can be seen; coming back to a hidden window asks at once.
export function useRequest<T>(store: AppStore, conn: string, method: string, params: Record<string, unknown> = {}, every?: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ReqError>();
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify(params);
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (store.rpc.state !== 'open') return;
    const mine = ++latest.current;
    setLoading(true);
    try {
      const result = await store.rpc.request<T>(method, JSON.parse(key));
      if (mine !== latest.current) return;
      setData(result);
      setError(undefined);
    } catch (e) {
      if (mine === latest.current) setError(toReqError(e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [store, method, key]);

  useEffect(() => {
    if (conn !== 'open') return;
    void load();
    if (!every) return;
    const tick = () => {
      if (!document.hidden) void load();
    };
    const timer = setInterval(tick, every);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [conn, load, every]);

  // Late answers after the page has gone are dropped.
  useEffect(
    () => () => {
      latest.current++;
    },
    [],
  );

  return { data, error, loading, reload: load, setData };
}

// A notification from the runner, for as long as the page is mounted.
export function useNotification<P = any>(store: AppStore, method: string, fn: (params: P) => void): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => store.rpc.on(method, (p) => ref.current(p)), [store, method]);
}

// The time, kept fresh for "resets in 2 h" style labels.
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// Runs an action that can fail, keeping its busy flag and its error.
export function useAction() {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const run = useCallback(async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(name);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(undefined) };
}
