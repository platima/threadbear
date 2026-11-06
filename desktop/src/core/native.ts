// What only the desktop shell (src-tauri) can do for the page: pick a folder,
// show a toast, open a link in the default browser. In a plain browser tab
// there is no `window.__TAURI__`, so each of these quietly does nothing and
// the page falls back to its own behaviour.
//
// The shell's plugins are reached through `core.invoke` rather than their own
// globals, which Tauri doesn't add for a page served from loopback. What the
// page may call is in src-tauri/capabilities/default.json.

import type { ThreadSummary } from './types.ts';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const invoke = (): Invoke | undefined => (window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke;

export const isNative = (): boolean => !!invoke();

export async function pickFolder(defaultPath?: string): Promise<string | undefined> {
  const call = invoke();
  if (!call) return undefined;
  const picked = await call<string | string[] | null>('plugin:dialog|open', { options: { directory: true, multiple: false, title: 'Choose a folder', ...(defaultPath ? { defaultPath } : {}) } });
  return typeof picked === 'string' ? picked : undefined;
}

async function toast(title: string, body: string): Promise<void> {
  const call = invoke();
  if (!call) return;
  try {
    if (!(await call<boolean>('plugin:notification|is_permission_granted')) && (await call<string>('plugin:notification|request_permission')) !== 'granted') return;
    await call('plugin:notification|notify', { options: { title, body } });
  } catch {
    // no toast is not worth an error
  }
}

// A toast when a thread starts needing the person, or finishes, and they
// aren't looking at the window.
export function notifyTransition(before: ThreadSummary, after: ThreadSummary): void {
  if (!isNative() || document.hasFocus() || after.archivedAt || after.sample) return;
  const busy = (s: ThreadSummary) => s.status === 'running' || s.status === 'starting';
  const title = after.title || 'Threadbear';
  const preview = (after.preview || '').replace(/\s+/g, ' ').slice(0, 160);
  if ((!before.needsYou && after.needsYou) || (before.status !== 'waiting' && after.status === 'waiting')) void toast(`${title} needs you`, preview);
  else if (busy(before) && !busy(after) && after.status === 'idle') void toast(`${title} finished`, preview);
  else if (busy(before) && (after.status === 'error' || after.status === 'stopped')) void toast(`${title} stopped`, preview);
}

// In the shell a link must open in the browser, not inside the app's window.
export function openLinksOutside(): void {
  if (!isNative()) return;
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]');
    const href = a?.getAttribute('href');
    if (!a || !href || !/^https?:\/\//i.test(href) || href.startsWith(location.origin)) return;
    e.preventDefault();
    void invoke()?.('plugin:opener|open_url', { url: href });
  });
}
