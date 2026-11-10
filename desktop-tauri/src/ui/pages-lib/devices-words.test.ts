// node --test desktop-tauri/src/ui/pages-lib/devices-words.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { NO_SYNC_URL, pairingOffNote } from './devices-words.ts';

test('with no sync.url the note says how to set the backend up, and where to get the script', () => {
  const note = pairingOffNote(NO_SYNC_URL);
  assert.ok(note.startsWith("Pairing needs the sync backend, and it's off: no sync.url in runner.json."), note);
  assert.match(note, /node scripts\/setup-sync\.mjs/);
  // An installed copy has no repository, so it says to get one.
  assert.match(note, /git clone https:\/\/github\.com\/platima\/threadbear\.git/);
  assert.match(note, /doesn't include it/);
  assert.match(note, /docs\/pairing\.md/);
  assert.match(note, /Node 24 or newer and git/);
  // The fork's name comes from one place, so a fork that changes it gets its own address.
  assert.match(pairingOffNote(NO_SYNC_URL, 'someone/their-fork'), /github\.com\/someone\/their-fork\.git/);
});

test('every other reason is said as the runner gave it, with nothing added', () => {
  for (const reason of ['sync.enabled is false', 'no secrets/convex-key', 'sync.url in runner.json must be https, or http to this computer', 'THREADBEAR_SYNC_URL must be https']) {
    assert.equal(pairingOffNote(reason), `Pairing needs the sync backend, and it's off: ${reason}`);
  }
  // Only the exact reason gets the advice, not one that happens to mention it.
  const near = 'sync.url is set but no sync.url in runner.json worked';
  assert.equal(pairingOffNote(near), `Pairing needs the sync backend, and it's off: ${near}`);
});

// The page has to use the helper: the typecheck and the tests above would pass just the same if the
// note went back to being written out by hand in the page, without the advice. This reads the page's
// source, as tips.test.ts does.
test('the Phone & browser page shows the note from pairingOffNote, and keeps no wording of its own', () => {
  const page = fs.readFileSync(path.join(import.meta.dirname, 'settings-devices.tsx'), 'utf8');
  assert.match(page, /import \{ pairingOffNote \} from '\.\/devices-words\.ts';/);
  assert.match(page, /\{off && <Note>\{pairingOffNote\(reason \?\? ''\)\}<\/Note>\}/, "the note is shown while pairing is off, with the runner's reason");
  assert.doesNotMatch(page, /Pairing needs the sync backend/, 'the words live in devices-words.ts only');
});
