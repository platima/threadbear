// Which Convex deployment this build talks to. The website is built for one
// (VITE_CONVEX_URL, baked in, and the deployment serves the site itself). The
// Android app is built for none: it is told by the link that pairs it
// (pairing.ts) and keeps the address in this app's storage, beside the token.
import type { Pairing } from './pairing';

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
// plugin (the Android shell turns on withGlobalTauri, so the page needs no
// package for it). Nothing in a browser.
type DeepLinkApi = { getCurrent(): Promise<string[] | null>; onOpenUrl(cb: (urls: string[]) => void): Promise<unknown> };

export function watchLinks(onLink: (url: string) => void): void {
  const api = (window as unknown as { __TAURI__?: { deepLink?: DeepLinkApi } }).__TAURI__?.deepLink;
  if (!api) return;
  void api.getCurrent().then((urls) => urls?.forEach(onLink), () => undefined);
  void api.onOpenUrl((urls) => urls.forEach(onLink)).catch(() => undefined);
}
