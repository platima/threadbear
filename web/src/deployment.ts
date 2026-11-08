// Which Convex deployment this build talks to. The website is built for one
// (VITE_CONVEX_URL, baked in, and the deployment serves the site itself). The
// Android app is built for none: it is told by the link that pairs it
// (pairing.ts) and keeps the address in this app's storage, beside the token.
import type { Pairing } from './pairing';
import { watchLinksWith, type TauriGlobal } from './links';

const KEY = 'threadbear.deployment';

export const builtInDeployment: string | undefined = (import.meta.env?.VITE_CONVEX_URL as string | undefined) || undefined;

// True in the app, which learns its deployment by pairing; false on the website.
export const isApp = builtInDeployment === undefined;

export function deploymentUrl(): string | undefined {
  if (builtInDeployment) return builtInDeployment;
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

// Keeps a pairing and starts again on it: the page has one client for the
// deployment it was loaded with, so the simplest change of deployment is a
// fresh load.
export function savePairing(p: Pairing): void {
  localStorage.setItem(KEY, p.url);
  localStorage.setItem('threadbear.token', p.token);
  location.reload();
}

// The app, forgetting where it was paired.
export function unpair(): void {
  localStorage.removeItem(KEY);
  localStorage.removeItem('threadbear.token');
  location.reload();
}

// The link that opened the app, or arrives while it is open: Tauri's deep-link
// plugin, through the globals the Android shell's withGlobalTauri gives the
// page (links.ts says how). Nothing in a browser.
export function watchLinks(onLink: (url: string) => void): void {
  const w = window as unknown as { __TAURI__?: TauriGlobal; __TAURI_INTERNALS__?: { invoke(command: string, args?: unknown): Promise<unknown> } };
  // What the page found goes to the shell's log (`adb logcat`), never a link
  const note = (text: string) => {
    try {
      void w.__TAURI_INTERNALS__?.invoke('page_note', { note: text }).catch(() => undefined);
    } catch {
      // not in the app
    }
  };
  watchLinksWith(w.__TAURI__, onLink, note);
}
