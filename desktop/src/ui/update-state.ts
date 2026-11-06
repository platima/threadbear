// The newest release this app knows of, shared by the rail (a link) and
// Settings > This app (a switch and Check now). The logic is in
// core/updates.ts; this is only where its answer lives while the app runs.

import { useSyncExternalStore } from 'react';
import { checkForUpdate, detectArch, type Available } from '../core/updates.ts';

// Set by vite from desktop/package.json.
declare const __APP_VERSION__: string;
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

let available: Available | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export async function runUpdateCheck(force = false): Promise<Available | undefined> {
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
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => available,
  );
}
