// node --test desktop/src/ui/pages-lib/honey.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Account } from '../../core/types.ts';
import { potLevel, potLogin, potTip, roomOf } from './honey.ts';

const login = (id: string, windows: { kind: string; remainingPercent: number }[] | undefined, more: { blocked?: boolean } = {}): Account =>
  ({ id, title: `Login ${id}`, usage: windows ? { windows, readAt: 'x', source: 'live', ...more } : undefined }) as unknown as Account;

test('the room on a login is the tighter of its 5-hour and weekly windows, and no other window counts', () => {
  assert.equal(roomOf(login('a', [{ kind: 'five_hour', remainingPercent: 80 }, { kind: 'weekly', remainingPercent: 35.5 }])), 35.5);
  assert.equal(roomOf(login('a', [{ kind: 'weekly', remainingPercent: 60 }, { kind: 'weekly_model', remainingPercent: 2 }])), 60, "a model's own week never decides it");
  assert.equal(roomOf(login('a', [{ kind: 'allowance', remainingPercent: 50 }])), undefined);
  assert.equal(roomOf(login('a', undefined)), undefined);
});

test('the pot shows the login with the most room', () => {
  const a = login('a', [{ kind: 'weekly', remainingPercent: 20 }]);
  const b = login('b', [{ kind: 'five_hour', remainingPercent: 90 }, { kind: 'weekly', remainingPercent: 70 }]);
  assert.equal(potLogin([a, b])?.id, 'b');
  assert.equal(potLevel([a, b]), 0.7);
  assert.match(potTip([a, b]), /^70% left on Login b/);
});

test('a login at its limit counts as no room, and a pot of only those is empty', () => {
  const full = login('a', [{ kind: 'weekly', remainingPercent: 80 }], { blocked: true });
  assert.equal(potLevel([full]), 0);
  assert.equal(potTip([full]), 'Every login with a reading is at its limit.');
  const other = login('b', [{ kind: 'weekly', remainingPercent: 10 }]);
  assert.equal(potLogin([full, other])?.id, 'b');
});

test('with no reading the pot is empty and says so', () => {
  assert.equal(potLevel([]), 0);
  assert.equal(potLevel([login('a', undefined)]), 0);
  assert.equal(potTip([login('a', undefined)]), 'No login has a usage reading yet.');
});

test('the level stays between empty and full', () => {
  assert.equal(potLevel([login('a', [{ kind: 'weekly', remainingPercent: 140 }])]), 1);
  assert.equal(potLevel([login('a', [{ kind: 'weekly', remainingPercent: -5 }])]), 0);
});
