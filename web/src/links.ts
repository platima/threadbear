// How the Android app hears of a link that opens it. Tauri's deep-link plugin
// has no global of its own (window.__TAURI__.deepLink does not exist: the first
// build looked there, and a pairing link did nothing), so the page asks the two
// things the plugin is made of, through the globals `withGlobalTauri` gives:
//
//   core.invoke('plugin:deep-link|get_current')    the link the app was started by, if any
//   event.listen('deep-link://new-url', ...)       a link that arrives while it is open
//
// and a third way in, in case the plugin's own event does not reach the page:
// the shell (android/src-tauri/src/lib.rs) sends `pairing-link` with the same
// list when the plugin hands it a link.
//
// Nothing here touches the page, so it can be tested alone.

export type TauriGlobal = {
  core?: { invoke(command: string, args?: unknown): Promise<unknown> };
  event?: { listen(event: string, handler: (e: { payload: unknown }) => void): Promise<unknown> };
};

// The events a link can arrive on, once the app is open
export const LINK_EVENTS = ['deep-link://new-url', 'pairing-link'];

// What the plugin hands over is a list of address strings; anything else is no link.
const urls = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

// Calls `onLink` for each link the app was started by, and for each that
// arrives later. Does nothing outside the app (no Tauri global), and a failure
// of one call leaves the others alone: the paste box still works. `note` is
// told, in a few words and never with a link in them, what the page found, for
// the app's log.
export function watchLinksWith(tauri: TauriGlobal | undefined, onLink: (url: string) => void, note: (text: string) => void = () => undefined): void {
  note(`Tauri globals: core ${tauri?.core ? 'yes' : 'no'}, event ${tauri?.event ? 'yes' : 'no'}`);
  if (!tauri?.core || !tauri.event) return;
  const heard = (from: string, value: unknown) => {
    const list = urls(value);
    if (list.length) note(`${list.length} link(s) reached the page by ${from}`);
    list.forEach(onLink);
  };
  try {
    void tauri.core.invoke('plugin:deep-link|get_current').then((v) => heard('get_current', v), () => note('get_current failed'));
  } catch {
    note('get_current threw');
  }
  for (const name of LINK_EVENTS) {
    try {
      void tauri.event.listen(name, (e) => heard(name, e.payload)).then(
        () => note(`listening for ${name}`),
        () => note(`listen ${name} failed`),
      );
    } catch {
      note(`listen ${name} threw`);
    }
  }
}
