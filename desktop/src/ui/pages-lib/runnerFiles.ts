// Reading files from the runner's machine (files.read) for a preview: the
// bytes come back as base64, become a blob URL for a picture or text for
// everything else, and are kept in a small cache so opening the same file
// twice is one round trip that only asks "has it changed?".
import { useEffect, useState } from 'react';
import type { RpcClient } from '../../core/rpc.ts';

export type FileKind = 'image' | 'markdown' | 'html' | 'text' | 'binary';

export type LoadedFile = {
  path: string;
  size: number;
  modifiedAt: string;
  mediaType: string;
  kind: FileKind;
  bytes: Uint8Array;
  truncated: boolean;
  limit: number; // the maxBytes it was read with
  text?: string; // markdown, html and text
  url?: string; // image: a blob URL
};

type ReadResult = { path: string; size: number; modifiedAt: string; mediaType: string; data?: string; truncated?: boolean; unchanged?: true };

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
};
const TEXT_EXT = new Set(
  'txt log json jsonc js mjs cjs ts mts cts tsx jsx css scss less csv tsv yml yaml toml xml sh bash zsh ps1 bat cmd py rb go rs swift kt java c h cc cpp hpp cs sql ini cfg conf env lock gitignore gitattributes editorconfig plist strings diff patch vue svelte astro php lua r gradle properties'.split(' '),
);

export function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : dot === 0 ? name.slice(1).toLowerCase() : '';
}

// What the name says; 'unknown' when it says nothing and the bytes must.
export function guessKind(path: string, mediaType = ''): FileKind | 'unknown' {
  const ext = extOf(path);
  if (ext in IMAGE_TYPES || mediaType.startsWith('image/')) return 'image';
  if (ext === 'md' || ext === 'markdown' || mediaType === 'text/markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm' || mediaType === 'text/html') return 'html';
  if (TEXT_EXT.has(ext) || mediaType.startsWith('text/') || mediaType === 'application/json') return 'text';
  if (['pdf', 'zip', 'gz', 'tar', '7z', 'exe', 'dll', 'mp4', 'mov', 'mp3', 'wav', 'woff', 'woff2', 'ttf', 'otf', 'docx', 'xlsx', 'pptx'].includes(ext)) return 'binary';
  return 'unknown';
}

const TEXT_LIMIT = 512 * 1024;
const SNIFF_LIMIT = 64 * 1024;

function limitFor(kind: FileKind | 'unknown'): number {
  return kind === 'image' ? 16 * 1024 * 1024 : kind === 'binary' ? 1024 : kind === 'unknown' ? SNIFF_LIMIT : TEXT_LIMIT;
}

function toBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const looksBinary = (bytes: Uint8Array): boolean => {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
};

// ---- the cache -------------------------------------------------------------

const MAX_CACHED = 96 * 1024 * 1024;
const cache = new Map<string, LoadedFile>(); // insertion order is least recently used first
const inflight = new Map<string, Promise<LoadedFile>>();
let cachedBytes = 0;

const touch = (f: LoadedFile): void => {
  cache.delete(f.path);
  cache.set(f.path, f);
};

function keep(f: LoadedFile): void {
  const old = cache.get(f.path);
  if (old) {
    cachedBytes -= old.bytes.length;
    const url = old.url;
    // A row may still be showing the old picture for a moment.
    if (url) setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  cache.delete(f.path);
  cache.set(f.path, f);
  cachedBytes += f.bytes.length;
  for (const [key, victim] of cache) {
    if (cachedBytes <= MAX_CACHED || cache.size <= 1) break;
    if (key === f.path) continue;
    cache.delete(key);
    cachedBytes -= victim.bytes.length;
    if (victim.url) URL.revokeObjectURL(victim.url);
  }
}

export function peekFile(path: string): LoadedFile | undefined {
  return cache.get(path);
}

export function readRunnerFile(rpc: RpcClient, path: string): Promise<LoadedFile> {
  const running = inflight.get(path);
  if (running) return running;
  const job = (async () => {
    const existing = cache.get(path);
    const guess = guessKind(path);
    const limit = limitFor(guess);
    const reusable = existing && (!existing.truncated || existing.limit >= limit);
    const res = await rpc.request<ReadResult>('files.read', {
      path,
      maxBytes: limit,
      ...(reusable ? { known: { size: existing.size, modifiedAt: existing.modifiedAt } } : {}),
    });
    if (res.unchanged && existing) {
      touch(existing);
      return existing;
    }
    const bytes = toBytes(res.data ?? '');
    const truncated = Boolean(res.truncated);
    let kind: FileKind = guess === 'unknown' ? (looksBinary(bytes) ? 'binary' : 'text') : guess;
    const file: LoadedFile = { path, size: res.size, modifiedAt: res.modifiedAt, mediaType: res.mediaType, kind, bytes, truncated, limit };
    if (kind === 'image') {
      if (truncated) {
        file.kind = 'binary';
      } else {
        const type = res.mediaType.startsWith('image/') ? res.mediaType : (IMAGE_TYPES[extOf(path)] ?? 'image/png');
        file.url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
      }
    } else if (kind !== 'binary') {
      file.text = new TextDecoder().decode(bytes);
    }
    keep(file);
    return file;
  })();
  inflight.set(path, job);
  const done = () => inflight.delete(path);
  job.then(done, done);
  return job;
}

// ---- errors ----------------------------------------------------------------

// A plain sentence for a failed request. `what` finishes "This runner can't ...".
export function errorText(e: unknown, what = 'do that'): string {
  const code = (e as { code?: number } | undefined)?.code;
  if (code === -32601) return `This runner can't ${what}.`;
  if (code === -1) return 'Not connected to the runner.';
  const message = (e as Error | undefined)?.message;
  return message || 'Something went wrong.';
}

// ---- the hook --------------------------------------------------------------

export type FileState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; file: LoadedFile };

// The file at `path`, from the cache at once when it is there and checked
// against the runner as well.
export function useRunnerFile(rpc: RpcClient, path: string | undefined, tries = 0): FileState {
  const [state, setState] = useState<{ path?: string; value: FileState }>(() => ({
    path,
    value: path && peekFile(path) ? { status: 'ready', file: peekFile(path)! } : { status: 'loading' },
  }));
  useEffect(() => {
    if (!path) return;
    let live = true;
    const cached = peekFile(path);
    setState({ path, value: cached ? { status: 'ready', file: cached } : { status: 'loading' } });
    readRunnerFile(rpc, path).then(
      (file) => live && setState({ path, value: { status: 'ready', file } }),
      (e) => live && setState((s) => (s.path === path && s.value.status === 'ready' ? s : { path, value: { status: 'error', message: errorText(e, 'send files') } })),
    );
    return () => {
      live = false;
    };
  }, [rpc, path, tries]);
  return state.path === path ? state.value : { status: 'loading' };
}

// ---- saving ----------------------------------------------------------------

export function formatSize(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// Gives the browser the file to save, whole: a file read in part is read again.
export async function saveCopy(rpc: RpcClient, file: LoadedFile, name: string): Promise<void> {
  let bytes = file.bytes;
  if (file.truncated) {
    const res = await rpc.request<ReadResult>('files.read', { path: file.path, maxBytes: 48 * 1024 * 1024 });
    bytes = toBytes(res.data ?? '');
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
