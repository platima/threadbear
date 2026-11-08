import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINK_EVENTS, watchLinksWith, type TauriGlobal } from './links.ts';

const tick = () => new Promise((r) => setImmediate(r));

// A Tauri global that answers like the deep-link plugin: `started` for
// get_current, and `emit` sends a link that arrives, on one of the events.
function fake(started: unknown) {
  const calls: string[] = [];
  const handlers = new Map<string, (e: { payload: unknown }) => void>();
  const tauri: TauriGlobal = {
    core: {
      invoke: async (command) => {
        calls.push(command);
        return started;
      },
    },
    event: {
      listen: async (event, h) => {
        calls.push(`listen ${event}`);
        handlers.set(event, h);
        return () => undefined;
      },
    },
  };
  return { tauri, calls, emit: (event: string, payload: unknown) => handlers.get(event)?.({ payload }) };
}

test('the link the app was started by, and one that arrives later, both reach the page', async () => {
  const f = fake(['threadbear://pair?url=https%3A%2F%2Fa.convex.cloud&token=t1']);
  const got: string[] = [];
  watchLinksWith(f.tauri, (u) => got.push(u));
  await tick();
  assert.deepEqual(f.calls, ['plugin:deep-link|get_current', ...LINK_EVENTS.map((e) => `listen ${e}`)]);
  assert.deepEqual(got, ['threadbear://pair?url=https%3A%2F%2Fa.convex.cloud&token=t1']);
  f.emit('deep-link://new-url', ['threadbear://pair?url=https%3A%2F%2Fb.convex.cloud&token=t2']);
  assert.equal(got.length, 2);
  assert.equal(got[1], 'threadbear://pair?url=https%3A%2F%2Fb.convex.cloud&token=t2');
});

test("the shell's own pairing-link event reaches the page as well, in case the plugin's does not", async () => {
  const f = fake(null);
  const got: string[] = [];
  watchLinksWith(f.tauri, (u) => got.push(u));
  await tick();
  f.emit('pairing-link', ['threadbear://pair?x']);
  assert.deepEqual(got, ['threadbear://pair?x']);
});

test('an app started from its icon has no link, and what is not a list of strings is no link', async () => {
  const f = fake(null);
  const got: string[] = [];
  watchLinksWith(f.tauri, (u) => got.push(u));
  await tick();
  f.emit('deep-link://new-url', 'not a list');
  f.emit('deep-link://new-url', [1, null, { url: 'x' }]);
  f.emit('deep-link://new-url', ['threadbear://pair?x', 7]);
  assert.deepEqual(got, ['threadbear://pair?x']);
});

test('in a browser, with no Tauri global, nothing happens and nothing throws', () => {
  watchLinksWith(undefined, () => assert.fail('no link can come'));
  watchLinksWith({}, () => assert.fail('no link can come'));
  watchLinksWith({ core: { invoke: async () => null } }, () => assert.fail('no link can come'));
});

test('a plugin that fails leaves the other half working', async () => {
  const got: string[] = [];
  let handler: ((e: { payload: unknown }) => void) | undefined;
  watchLinksWith(
    {
      core: { invoke: async () => Promise.reject(new Error('no such plugin')) },
      event: { listen: async (_e, h) => ((handler = h), undefined) },
    },
    (u) => got.push(u),
  );
  await tick();
  handler?.({ payload: ['threadbear://pair?y'] });
  assert.deepEqual(got, ['threadbear://pair?y']);
  // And the other way round: events throw at once, the started-by link is still heard
  const got2: string[] = [];
  watchLinksWith(
    {
      core: { invoke: async () => ['threadbear://pair?z'] },
      event: {
        listen: () => {
          throw new Error('no events');
        },
      },
    },
    (u) => got2.push(u),
  );
  await tick();
  assert.deepEqual(got2, ['threadbear://pair?z']);
});

test('the notes say what the page found, and never a link', async () => {
  const f = fake(['threadbear://pair?url=https%3A%2F%2Fsecret.convex.cloud&token=SECRETTOKEN']);
  const notes: string[] = [];
  watchLinksWith(f.tauri, () => undefined, (t) => notes.push(t));
  await tick();
  f.emit('pairing-link', ['threadbear://pair?url=https%3A%2F%2Fsecret.convex.cloud&token=SECRETTOKEN']);
  assert.equal(notes[0], 'Tauri globals: core yes, event yes');
  assert.ok(notes.includes('1 link(s) reached the page by get_current'));
  assert.ok(notes.includes('1 link(s) reached the page by pairing-link'));
  assert.ok(notes.every((n) => !/SECRETTOKEN|secret\.convex|threadbear:\/\//.test(n)), notes.join(' | '));
  const none: string[] = [];
  watchLinksWith(undefined, () => undefined, (t) => none.push(t));
  assert.deepEqual(none, ['Tauri globals: core no, event no']);
});
