// Notifications on the Android app. The shell has a plugin for them
// (android/plugins/push, docs/android.md): it starts Firebase, asks for the
// permission, makes this phone's own push key, and answers two commands.
// This file only speaks to it and checks what comes back. Registering with the
// person's backend is the settings menu's job (push-row.tsx).
//
// Nothing here touches the page, so it can be tested alone.

export type Invoke = (command: string, args?: unknown) => Promise<unknown>;

export type PushStatus = { available: boolean; permission: string };
export type PushRegistration = { token: string; key: string };

// The backend that takes an Android phone's registration (convex/version.ts, 64)
export const PUSH_API_VERSION = 64;

// A push key as phone:registerDevice takes it: base64 of 32 bytes
const KEY = /^[A-Za-z0-9+/]{43}=$/;

export function readStatus(value: unknown): PushStatus | undefined {
  const v = value as { available?: unknown; permission?: unknown } | null;
  if (!v || typeof v.available !== 'boolean' || typeof v.permission !== 'string') return undefined;
  return { available: v.available, permission: v.permission };
}

export function readRegistration(value: unknown): PushRegistration | undefined {
  const v = value as { token?: unknown; key?: unknown } | null;
  if (!v || typeof v.token !== 'string' || !v.token || typeof v.key !== 'string' || !KEY.test(v.key)) return undefined;
  return { token: v.token, key: v.key };
}

type TauriWindow = { __TAURI_INTERNALS__?: { invoke(command: string, args?: unknown): Promise<unknown> } };

// Tauri's own invoke, when the page is in the app; undefined in a browser
export function tauriInvoke(win: TauriWindow | undefined = typeof window === 'undefined' ? undefined : (window as unknown as TauriWindow)): Invoke | undefined {
  const internals = win?.__TAURI_INTERNALS__;
  return internals ? (command, args) => internals.invoke(command, args) : undefined;
}

const PLUGIN = 'plugin:threadbear-push|';

// Whether this build can take notifications, and whether they are allowed. Undefined
// outside the app, or if the shell has no such plugin (an older build).
export async function pushStatus(invoke: Invoke | undefined = tauriInvoke()): Promise<PushStatus | undefined> {
  if (!invoke) return undefined;
  try {
    return readStatus(await invoke(`${PLUGIN}status`));
  } catch {
    return undefined;
  }
}

// Asks for the permission if need be, and gives the token and the key. Throws
// an Error whose message says why not, for the person to read.
export async function pushRegister(invoke: Invoke | undefined = tauriInvoke()): Promise<PushRegistration> {
  if (!invoke) throw new Error('Notifications need the Android app');
  let answer: unknown;
  try {
    answer = await invoke(`${PLUGIN}register`);
  } catch (e) {
    throw new Error(typeof e === 'string' && e ? e : e instanceof Error && e.message ? e.message : 'The phone would not register for notifications');
  }
  const registration = readRegistration(answer);
  if (!registration) throw new Error('The phone gave no usable token');
  return registration;
}

// What this phone last registered, so the menu can say it is on and turn it
// off: the Firebase token. Per viewer, in this app's own storage.
const SAVED = 'threadbear.push';

export function savedToken(storage: Pick<Storage, 'getItem'> = localStorage): string | undefined {
  try {
    return storage.getItem(SAVED) || undefined;
  } catch {
    return undefined;
  }
}

export function saveToken(token: string | undefined, storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage): void {
  try {
    if (token) storage.setItem(SAVED, token);
    else storage.removeItem(SAVED);
  } catch {
    // storage is off: the menu shows it as off, and turning it on again works
  }
}
