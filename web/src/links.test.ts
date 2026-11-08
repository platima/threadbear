import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchLinksWith, type TauriGlobal } from './links.ts';

const tick = () => new Promise((r) => setImmediate(r));

// A Tauri global that answers like the deep-link plugin: `started` for
// get_current, and `emit` sends a link that arrives while the app is open.
function fake(started: unknown) {
  const calls: string[] = [];
  let handler: ((e: { payload: unknown }) => void) | undefined;
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
        handler = h;
        return () => undefined;
      },
    },
  };
  return { tauri, calls, emit: (payload: unknown) => handler?.({ payload }) };
}

test('the link the app was started by, and one that arrives later, both reach the page', async () => {
  const f = fake(['threadbear://pair?url=https%3A%2F%2Fa.convex.cloud&token=t1']);
  const got: string[] = [];
  watchLinksWith(f.tauri, (u) => got.push(u));
  await tick();
  assert.deepEqual(f.calls, ['plugin:deep-link|get_current', 'listen deep-link://new-url']);
  assert.deepEqual(got, ['threadbear://pair?url=https%3A%2F%2Fa.convex.cloud&token=t1']);
  f.emit(['threadbear://pair?url=https%3A%2F%2Fb.convex.cloud&token=t2']);
  assert.equal(got.length, 2);
  assert.equal(got[1], 'threadbear://pair?url=https%3A%2F%2Fb.convex.cloud&token=t2');
});

test('an app started from its icon has no link, and what is not a list of strings is no link', async () => {
  const f = fake(null);
  const got: string[] = [];
  watchLinksWith(f.tauri, (u) => got.push(u));
  await tick();
  f.emit('not a list');
  f.emit([1, null, { url: 'x' }]);
  f.emit(['threadbear://pair?x', 7]);
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
