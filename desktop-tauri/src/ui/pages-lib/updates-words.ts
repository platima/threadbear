// What the Updates page says about the runner's own updates (RunnerUpdates, from
// hello and runner.updates), in plain words. Kept apart from the page so it can be
// tested with node --test (updates-words.test.ts).

import type { RunnerUpdates, UpstreamStatus } from '../../core/types.ts';

export type Tone = 'ok' | 'warn' | 'bad' | undefined;
export type Words = { text: string; tone?: Tone };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Whether the runner follows main, and how that is going.
export function followingWords(u: RunnerUpdates | undefined): Words {
  if (!u) return { text: "This runner doesn't report how it updates. It may need updating itself." };
  const at = u.commit ? `main at ${u.commit}${u.subject ? `: ${u.subject}` : ''}` : 'main';
  switch (u.state) {
    case 'off':
      return { text: `Not following main${u.reason ? `: ${u.reason}` : ''}.` };
    case 'idle':
      return { text: `Following main, and up to date (${at}).`, tone: 'ok' };
    case 'checking':
      return { text: 'Checking main for something new...' };
    case 'building':
      return { text: `Building the runner from ${at}.` };
    case 'waiting':
      return { text: `Built from ${at}. Waiting for the threads that are running to finish before it restarts.`, tone: 'warn' };
    case 'failed':
      return { text: `The last build failed${u.reason ? `: ${u.reason}` : ''}. It tries again when main changes.`, tone: 'bad' };
    default:
      return { text: 'The runner reports an update state this app does not know.' };
  }
}

// Threads still finishing their turns on a runner that handed over, by version.
export function oldRunnerWords(u: RunnerUpdates | undefined): Words | undefined {
  const old = u?.oldRunners ?? [];
  const threads = old.reduce((n, r) => n + r.threads.length, 0);
  if (!old.length) return undefined;
  const versions = [...new Set(old.map((r) => r.version))].join(', ');
  return { text: `${plural(threads, 'thread is', 'threads are')} finishing ${threads === 1 ? 'its turn' : 'their turns'} on the previous version (${versions}). Each moves to the new one when its turn ends.` };
}

// Whether this copy has the newest release of the project it follows (Mike's, for a fork).
// Nothing when the runner isn't following one.
export function upstreamWords(up: UpstreamStatus | undefined): Words | undefined {
  if (!up || up.state === 'off') return undefined;
  const rel = up.release;
  switch (up.state) {
    case 'available':
      return { text: `A newer release is out${rel ? `: ${rel.tag}${rel.date ? ` (${rel.date.slice(0, 10)})` : ''}, with ${plural(rel.changes, 'change', 'changes')} this copy does not have yet` : ''}.`, tone: 'warn' };
    case 'idle':
      return { text: `This copy has the newest release${rel ? ` (${rel.tag})` : ''}.`, tone: 'ok' };
    case 'checking':
      return { text: 'Looking for a newer release...' };
    case 'failed':
      return { text: `Looking for a newer release failed${up.reason ? `: ${up.reason}` : ''}.`, tone: 'bad' };
    default:
      return undefined;
  }
}
