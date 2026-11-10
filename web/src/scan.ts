// Scanning a pairing code from inside the Android app. The shell has Google's code
// scanner behind a command (android/plugins/push, `scan`): it opens over the app,
// with its own camera screen, and gives back the text of the QR code it reads. The
// page then treats that text as it does a pasted one (pairing.ts), and the person is
// asked before anything is kept. Reading the code with the phone's camera app and
// opening the link it shows still works; this is the way that stays in the app.
//
// Nothing here touches the page, so it can be tested alone.

import { tauriInvoke, type Invoke } from './push.ts';

// What the scanner gave: the code's text, or that the person backed out.
export type Scanned = { text: string } | { cancelled: true };

const SCAN = 'plugin:threadbear-push|scan';

export function readScan(value: unknown): Scanned | undefined {
  const v = value as { text?: unknown; cancelled?: unknown } | null;
  if (!v || typeof v !== 'object') return undefined;
  if (v.cancelled === true) return { cancelled: true };
  // An empty text is a code with nothing in it: not an answer.
  if (typeof v.text === 'string' && v.text) return { text: v.text };
  return undefined;
}

// Whether this page can scan: in the app, where the shell has the command. In a
// browser tab there is no scanner, and the page has its paste box.
export const canScan = (invoke: Invoke | undefined = tauriInvoke()): boolean => Boolean(invoke);

// How long the page waits for the scanner before it lets the person try again. The scanner is a
// screen of Google's over the app, with the person aiming at a code, so it is long; it only
// stops the button staying on "Scanning..." for ever if the scanner never answers at all.
const SCAN_WAIT_MS = 5 * 60_000;
export const SCAN_SILENT = 'The scanner did not answer. Tap Scan the code to try again, or paste the link.';

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(SCAN_SILENT)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Opens the scanner and gives what it read. Throws an Error whose message says why
// not, for the person to read (no Google Play services, say). `waitMs` is for the tests.
export async function scanCode(invoke: Invoke | undefined = tauriInvoke(), waitMs: number = SCAN_WAIT_MS): Promise<Scanned> {
  if (!invoke) throw new Error('Scanning needs the Android app');
  let answer: unknown;
  try {
    answer = await within(invoke(SCAN), waitMs);
  } catch (e) {
    if (e instanceof Error && e.message === SCAN_SILENT) throw e;
    throw new Error(typeof e === 'string' && e ? e : e instanceof Error && e.message ? e.message : 'The scanner would not open');
  }
  const scanned = readScan(answer);
  if (!scanned) throw new Error('The scanner gave nothing to read');
  return scanned;
}
