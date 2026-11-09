// The honey pot on the rail's Usage button (the Mac app's HoneyPot): how full it is is the room left on
// the login a new thread would use. Here that is the login with the most room, as a thread with no login
// chosen takes the one with the most.

import type { Account } from '../../core/types.ts';

const MAIN = ['five_hour', 'weekly'];

/** The room left on a login, as percent: the tighter of its 5-hour and weekly windows. Undefined when neither is known. */
export function roomOf(account: Account): number | undefined {
  const windows = (account.usage?.windows ?? []).filter((w) => MAIN.includes(w.kind));
  return windows.length ? Math.min(...windows.map((w) => w.remainingPercent)) : undefined;
}

/** A login at its limit, which the provider has said so about. */
const blocked = (account: Account): boolean => account.usage?.blocked === true;

/** The login the pot shows: the one with the most room. Undefined when no login has a reading. */
export function potLogin(accounts: Account[]): Account | undefined {
  let best: Account | undefined;
  let bestRoom = -1;
  for (const a of accounts) {
    const room = blocked(a) ? 0 : roomOf(a);
    if (room === undefined) continue;
    if (room > bestRoom) {
      best = a;
      bestRoom = room;
    }
  }
  return best;
}

/** How full the pot is, 0 to 1. Unknown, or at its limit, is an empty pot. */
export function potLevel(accounts: Account[]): number {
  const a = potLogin(accounts);
  if (!a || blocked(a)) return 0;
  return Math.min(1, Math.max(0, (roomOf(a) ?? 0) / 100));
}

/** What the rail's tooltip adds to the page's own: the room, said in words. */
export function potTip(accounts: Account[]): string {
  const a = potLogin(accounts);
  if (!a) return 'No login has a usage reading yet.';
  if (blocked(a)) return 'Every login with a reading is at its limit.';
  const room = roomOf(a) ?? 0;
  return `${Math.floor(room)}% left on ${a.title}, the login with the most room.`;
}
