// Whether the rail has a Connectors button: for a runner that answers connectors.status, even
// with no gateway set up (state 'off', where the page says so and where to read about one), and
// not for a runner too old to answer (-32601, which leaves the snapshot's `connectors` undefined).
//
// This loads the real page list (registry.ts and the pages, which are .tsx) through Vite's
// server-side loader, as the app is built, and asks the real store what each runner left in the
// snapshot. The rail's own rule is `PAGES.filter((p) => p.available?.(snap) ?? true)`.
//
// node --test desktop-tauri/src/ui/connectors-rail.test.ts
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { fake } from '../core/fake-transport.ts';
import { RpcClient } from '../core/rpc.ts';
import { AppStore, type Snapshot } from '../core/store.ts';
import type { PageDef } from './registry.ts';

let server: ViteDevServer;
let pages: PageDef[];

before(async () => {
  server = await createServer({
    root: path.resolve(import.meta.dirname, '../..'),
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  });
  pages = ((await server.ssrLoadModule('/src/ui/registry.ts')) as { PAGES: PageDef[] }).PAGES;
});

after(async () => {
  await server.close();
});

// What the snapshot holds once a runner has answered hello, the thread list and connectors.status
// with `answer`.
async function snapshotFrom(answer: { result?: unknown; error?: { code: number; message: string } }): Promise<Snapshot> {
  const { t } = fake();
  const rpc = new RpcClient(() => t, { retryMs: 5_000, requestMs: 5_000 });
  const store = new AppStore(rpc);
  const real = t.send;
  t.send = (text) => {
    real(text);
    const m = JSON.parse(text) as { id: number; method: string };
    queueMicrotask(() => {
      if (m.method === 'hello') t.say({ id: m.id, result: { runnerVersion: 'x', protocol: 1, accounts: [], defaults: {} } });
      else if (m.method === 'threads.list') t.say({ id: m.id, result: { threads: [] } });
      else if (m.method === 'connectors.status') t.say({ id: m.id, ...answer });
      else t.say({ id: m.id, result: {} });
    });
  };
  store.start();
  t.open();
  // The first look the store makes by itself, then the one the page makes when it opens.
  while (!store.getSnapshot().hello) await new Promise((r) => setTimeout(r, 5));
  await store.loadConnectors(true);
  const snap = store.getSnapshot();
  rpc.stop();
  return snap;
}

const inRail = (snap: Snapshot): string[] => pages.filter((p) => p.available?.(snap) ?? true).map((p) => p.id);

test('a runner with no gateway answers off, and the rail still has the Connectors button', async () => {
  const snap = await snapshotFrom({ result: { connectors: { state: 'off', services: [] } } });
  assert.equal(snap.connectors?.state, 'off', 'the store keeps the answer, which is how it differs from no answer');
  assert.ok(inRail(snap).includes('connectors'));
});

test('a runner with a gateway, working or not, has the Connectors button', async () => {
  for (const state of ['ok', 'unreachable'] as const) {
    const snap = await snapshotFrom({ result: { connectors: { state, url: 'https://gateway.example.ts.net:7200', services: [] } } });
    assert.ok(inRail(snap).includes('connectors'), state);
  }
});

test('a runner too old to know about Connectors has no button for it', async () => {
  const snap = await snapshotFrom({ error: { code: -32601, message: 'Method not found' } });
  assert.equal(snap.connectors, undefined);
  assert.ok(!inRail(snap).includes('connectors'));
  assert.ok(inRail(snap).includes('runners'), 'the other pages are not affected');
});
