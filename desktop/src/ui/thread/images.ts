// Pictures in a thread live as files on the runner's machine (a message's
// pictures, a tool's results, a design review's options). The page can't read
// them, so it asks the runner for the bytes (files.read, base64) and keeps a
// blob URL per path. A small cache holds the ones drawn lately; one still on
// screen is never dropped.

import { useEffect, useState } from 'react';
import type { AppStore } from '../../core/store.ts';
import type { ImageRef } from '../../core/types.ts';

type Entry = { url?: string; error?: string; bytes: number; refs: number; used: number; loading?: Promise<void>; listeners: Set<() => void> };

const MAX_BYTES = 120 * 1024 * 1024;
const MAX_ENTRIES = 80;
const cache = new Map<string, Entry>();
let tick = 0;

function entryFor(path: string): Entry {
  let e = cache.get(path);
  if (!e) {
    e = { bytes: 0, refs: 0, used: 0, listeners: new Set() };
    cache.set(path, e);
  }
  e.used = ++tick;
  return e;
}

function trim(): void {
  let total = 0;
  for (const e of cache.values()) total += e.bytes;
  if (total <= MAX_BYTES && cache.size <= MAX_ENTRIES) return;
  const idle = [...cache].filter(([, e]) => e.refs === 0 && !e.loading).sort((a, b) => a[1].used - b[1].used);
  for (const [path, e] of idle) {
    if (total <= MAX_BYTES && cache.size <= MAX_ENTRIES) break;
    if (e.url) URL.revokeObjectURL(e.url);
    total -= e.bytes;
    cache.delete(path);
  }
}

function load(store: AppStore, ref: ImageRef, e: Entry): Promise<void> {
  if (e.url || e.loading) return e.loading ?? Promise.resolve();
  const done = (): void => {
    e.loading = undefined;
    for (const l of e.listeners) l();
    trim();
  };
  e.loading = store
    .readFile(ref.path)
    .then(async (r) => {
      // The blob is made from a data URL: the browser decodes the base64 itself.
      const blob = await (await fetch(`data:${ref.mediaType || r.mediaType};base64,${r.data}`)).blob();
      e.url = URL.createObjectURL(blob);
      e.bytes = blob.size;
      e.error = undefined;
    })
    .catch((err: unknown) => {
      e.error = (err as Error)?.message || "The runner couldn't read the picture.";
    })
    .finally(done);
  return e.loading;
}

// The blob URL for a picture once it has loaded. Nothing is fetched until
// `want` is true, so a row that has not been seen does not cost a read.
export function useImage(store: AppStore, ref: ImageRef | undefined, want: boolean): { url?: string; error?: string } {
  const path = ref?.path;
  const [, setN] = useState(0);
  useEffect(() => {
    if (!ref || !path || !want) return;
    const e = entryFor(path);
    e.refs++;
    const l = () => setN((n) => n + 1);
    e.listeners.add(l);
    if (!e.url) void load(store, ref, e);
    l();
    return () => {
      e.listeners.delete(l);
      e.refs--;
      e.used = ++tick;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, path, want]);
  const e = path && want ? cache.get(path) : undefined;
  return { url: e?.url, error: e?.error };
}

// For a picture the person just attached, which is already in the page.
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
