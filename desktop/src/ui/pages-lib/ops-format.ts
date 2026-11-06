// Plain-words formatting shared by the Usage, Runners and Settings pages.

import { RpcError } from '../../core/rpc.ts';

export function bytesWords(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// 1.2M, 340k, 812
export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

// "16 min", "2 h 10 min", "4 days 1 h"
export function spanWords(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return 'under a minute';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const rest = h % 24;
  return `${d} ${d === 1 ? 'day' : 'days'}${rest ? ` ${rest} h` : ''}`;
}

export function untilWords(iso: string, now: number): string {
  const diff = Date.parse(iso) - now;
  return diff <= 0 ? 'now' : `in ${spanWords(diff)}`;
}

export function agoWords(ms: number, now: number): string {
  return now - ms < 60_000 ? 'just now' : `${spanWords(now - ms)} ago`;
}

// "Fri 6:10 pm" within the week either side, else "3 Nov, 6:10 pm".
export function whenWords(time: string | number): string {
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return '';
  const near = Math.abs(d.getTime() - Date.now()) < 6 * 86_400_000;
  return d.toLocaleString(undefined, near ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function dateWords(time: string | number): string {
  const d = new Date(time);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// A request's failure, in a sentence. -32601 is a runner without the method.
export function errorText(e: unknown): string {
  const code = e instanceof RpcError ? e.code : (e as { code?: number } | undefined)?.code;
  if (code === -32601) return "This runner doesn't have that yet.";
  if (code === -1) return 'Not connected to the runner.';
  return e instanceof Error ? e.message : String(e);
}

export function isMissing(e: unknown): boolean {
  return (e instanceof RpcError ? e.code : (e as { code?: number } | undefined)?.code) === -32601;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// The last folder of a path, either slash.
export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
