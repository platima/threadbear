// How the Android app hears of a link that opens it. Tauri's deep-link plugin
// has no global of its own (window.__TAURI__.deepLink does not exist: the first
// build looked there, and a pairing link did nothing), so the page asks the two
// things the plugin is made of, through the globals `withGlobalTauri` gives:
//
//   core.invoke('plugin:deep-link|get_current')    the link the app was started by, if any
//   event.listen('deep-link://new-url', ...)       a link that arrives while it is open
//
// Nothing here touches the page, so it can be tested alone.

export type TauriGlobal = {
  core?: { invoke(command: string, args?: unknown): Promise<unknown> };
  event?: { listen(event: string, handler: (e: { payload: unknown }) => void): Promise<unknown> };
};

// What the plugin hands over is a list of address strings; anything else is no link.
const urls = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

// Calls `onLink` for each link the app was started by, and for each that
// arrives later. Does nothing outside the app (no Tauri global), and a failure
// of either call leaves the other alone: the paste box still works.
export function watchLinksWith(tauri: TauriGlobal | undefined, onLink: (url: string) => void): void {
  if (!tauri?.core || !tauri.event) return;
  try {
    void tauri.core.invoke('plugin:deep-link|get_current').then((v) => urls(v).forEach(onLink), () => undefined);
  } catch {
    // no plugin: nothing started the app
  }
  try {
    void tauri.event.listen('deep-link://new-url', (e) => urls(e.payload).forEach(onLink)).then(undefined, () => undefined);
  } catch {
    // no events: only a started-by link will be heard
  }
}
