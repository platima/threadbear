// A carrier for tests (rpc.test.ts, store.test.ts) that the test drives by hand:
// open it, say what the runner says, drop it, and read what was sent.
import type { Transport } from './rpc.ts';

export function fake() {
  const sent: { id?: number; method?: string; params?: Record<string, unknown> }[] = [];
  const t: Transport & { open(): void; say(m: object): void; drop(why?: string): void } = {
    send: (text) => sent.push(JSON.parse(text)),
    close: () => t.drop('closed (1005)'),
    onopen: () => {},
    onmessage: () => {},
    onclose: () => {},
    open: () => t.onopen(),
    say: (m) => t.onmessage(JSON.stringify({ jsonrpc: '2.0', ...m })),
    drop: (why = 'dropped') => t.onclose(why),
  };
  return { t, sent };
}
