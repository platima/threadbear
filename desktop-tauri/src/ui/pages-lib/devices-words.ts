// What the Phone & browser page says when pairing can't work yet: the runner's
// devices.list gives a `reason` while its sync backend is off (runner/src/sync.ts,
// offReason). Kept apart from the page so it can be tested with node --test
// (devices-words.test.ts).

import { REPO } from '../../core/updates.ts';

// The runner's reason when runner.json has no sync.url: no Convex backend has been set up.
export const NO_SYNC_URL = 'no sync.url in runner.json';

// The note under the page's heading while pairing is off. Every reason is said as the
// runner gave it. The one that means no backend has been set up also says what to do:
// scripts/setup-sync.mjs is in the repository, not in an installed copy of the app,
// so it says where to get one.
export function pairingOffNote(reason: string, repo: string = REPO): string {
  const base = `Pairing needs the sync backend, and it's off: ${reason}`;
  if (reason.trim() !== NO_SYNC_URL) return base;
  return `${base}. To turn it on, run node scripts/setup-sync.mjs from a copy of the repository (git clone https://github.com/${repo}.git), as this app doesn't include it. It needs Node 24 or newer and git, and docs/pairing.md in the repository says what it does.`;
}
