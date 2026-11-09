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

// The shell's own choice and request (src-tauri/src/lib.rs): whether closing
// the window ends the app (Settings, This app), and starting the runner. In a
// plain browser tab they do nothing.

// (`using.call` is the shell's channel; the tests pass their own.)
type Using = { call?: Invoke | null };
const channel = (using: Using): Invoke | undefined => (using.call === undefined ? invoke() : (using.call ?? undefined));

// Whether closing the window ends the app. Undefined outside the shell, when it won't
// say, and on Linux, where closing always ends the app so there is no choice to show.
export async function getExitOnClose(using: Using = {}): Promise<boolean | undefined> {
  const call = channel(using);
  if (!call) return undefined;
  try {
    return (await call<boolean | null>('get_exit_on_close')) ?? undefined;
  } catch {
    return undefined;
  }
}

// Sets it. Gives back what went wrong, or undefined when it worked.
export async function setExitOnClose(on: boolean, using: Using = {}): Promise<string | undefined> {
  const call = channel(using);
  if (!call) return 'Only the installed app can change this.';
  try {
    await call('set_exit_on_close', { on });
    return undefined;
  } catch (e) {
    return typeof e === 'string' ? e : ((e as Error)?.message ?? 'unknown');
  }
}

// A terminal window running one of two fixed Claude Code sign-in commands, for a
// login that ran out: `claude auth login` ('login') or `claude setup-token`
// ('setup-token'). `configDir` is the login's own folder when it isn't the default one.
// Gives back what went wrong, or undefined when the window opened. The shell decides
// what is run; the page only names which.
export async function openClaudeLogin(kind: 'login' | 'setup-token', configDir?: string, using: Using = {}): Promise<string | undefined> {
  const call = channel(using);
  if (!call) return 'Only the installed app can open a terminal.';
  try {
    await call('open_claude_login', { kind, ...(configDir ? { configDir } : {}) });
    return undefined;
  } catch (e) {
    return typeof e === 'string' ? e : ((e as Error)?.message ?? 'unknown');
  }
}

// Starts the runner if it is set up, or offers to set one up that runs only while
// the app is open. It answers when the start is done, or the offer taken or declined,
// not before (the shell waits), so the page can show it is working until then. Gives
// back what went wrong, or undefined when it started or was declined.
export async function startRunner(using: Using = {}): Promise<string | undefined> {
  const call = channel(using);
  if (!call) return 'Only the installed app can start the runner.';
  try {
    await call('start_runner');
    return undefined;
  } catch (e) {
    return typeof e === 'string' ? e : ((e as Error)?.message ?? 'unknown');
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

// A link the shell could not open: say so, with the address in a box the
// person can copy it from. Drawn by hand rather than by React so it works
// wherever the failure happens (a link in a Markdown message, the rail).
function showLinkNotice(href: string): void {
  document.getElementById('linkNotice')?.remove();
  const box = document.createElement('div');
  box.id = 'linkNotice';
  box.className = 'linkNotice';
  box.setAttribute('role', 'alert');
  const text = document.createElement('span');
  text.textContent = "Couldn't open that link. You can copy the address:";
  const address = document.createElement('input');
  address.readOnly = true;
  address.value = href;
  address.title = 'The address. Select it and copy it into your browser.';
  address.setAttribute('aria-label', 'Link address');
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.title = 'Close this notice';
  close.addEventListener('click', () => box.remove());
  box.append(text, address, close);
  document.body.append(box);
  address.focus();
  address.select();
  setTimeout(() => box.remove(), 30_000);
}

// Opens an address in the default browser, through the shell. When that fails
// (the shell turned it down, or there is no browser) the person is shown the
// address instead of nothing happening. Gives back whether it opened.
// `call` and `failed` are the shell's channel and the notice; the tests pass their own.
export async function openExternal(href: string, using: { call?: Invoke | null; failed?: (href: string, why: string) => void } = {}): Promise<boolean> {
  const call = using.call === undefined ? invoke() : using.call;
  if (!call) return false;
  try {
    await call('plugin:opener|open_url', { url: href });
    return true;
  } catch (e) {
    (using.failed ?? showLinkNotice)(href, typeof e === 'string' ? e : ((e as Error)?.message ?? 'unknown'));
    return false;
  }
}

// In the shell a link must open in the browser, not inside the app's window.
export function openLinksOutside(): void {
  if (!isNative()) return;
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]');
    const href = a?.getAttribute('href');
    if (!a || !href || !/^(https?:\/\/|mailto:)/i.test(href) || href.startsWith(location.origin)) return;
    e.preventDefault();
    void openExternal(href);
  });
}
