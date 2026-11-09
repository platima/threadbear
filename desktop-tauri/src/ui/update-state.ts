// The newest release this app knows of, shared by the rail (a link) and
// Settings > This app (a switch and Check now). The logic is in
// core/updates.ts; this is only where its answer lives while the app runs.

import { useSyncExternalStore } from 'react';
import { APP_VERSION } from '../core/version.ts';
import { checkForUpdate, detectArch, type Available } from '../core/updates.ts';

export { APP_VERSION };

let available: Available | undefined;
// Whether this run of the app has its saved settings (see sessionKeepsSettings).
let keepsSettings: boolean | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

// The window keeps its saved settings (the update check's off switch among
// them) under the address it is served from, and the app shell gives it the
// same address every time. If that address was busy and the bridge used
// another, this run starts with nothing saved, and "on" would be only the
// default. The bridge says so, and the daily check then waits for the next
// start rather than overrule a choice it cannot see. Anything but a clear yes
// counts as no.
async function sessionKeepsSettings(): Promise<boolean> {
  if (keepsSettings !== undefined) return keepsSettings;
  try {
    const res = await fetch('bridge-info', { cache: 'no-store' });
    keepsSettings = res.ok && ((await res.json()) as { stable?: unknown }).stable === true;
  } catch {
    keepsSettings = false;
  }
  emit();
  return keepsSettings;
}

export async function runUpdateCheck(force = false): Promise<Available | undefined> {
  // "Check now" is the person asking, so it goes ahead; the daily check by itself does not.
  if (!force && !(await sessionKeepsSettings())) return available;
  available = await checkForUpdate({
    current: APP_VERSION,
    arch: await detectArch(),
    store: localStorage,
    fetch: (url) => fetch(url, { headers: { Accept: 'application/vnd.github+json' } }),
    force,
  });
  emit();
  return available;
}

export function useAvailableUpdate(): Available | undefined {
  return useSyncExternalStore(subscribe, () => available);
}

// False when this run started without its saved settings; undefined until known.
export function useSessionKeepsSettings(): boolean | undefined {
  return useSyncExternalStore(subscribe, () => keepsSettings);
}
