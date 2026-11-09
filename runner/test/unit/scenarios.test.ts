// Each scenario plays one thread and reads it three ways (helpers/routes.ts):
// on this runner, on another runner's thread from the Mac through Convex, and
// on the iPhone and the website. What a person sees (the card, its notes and
// pick, the follow-ups, the messages and their pictures) has to be the same
// on all three, or the difference has to be in KNOWN below with why. A
// decision card's notes (8 Nov) went missing on the way to another Mac with
// every test passing, as nothing compared the routes.
//
// A new feature that changes what a thread shows gets a scenario here. The
// agent building it writes it; it runs in the quick check in a second or two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { threeWays, type Play, type View } from '../helpers/routes.ts';
import { makePng } from '../helpers/png.ts';
import { tmpDir } from '../helpers/fakes.ts';

type Route = 'relay' | 'phone';
type Field = 'needs' | 'asks' | 'next' | 'messages' | 'pictures';

// Differences that are meant, each with why. A test below fails once one
// of these stops being a difference, so the list can't outlive its reason.
const KNOWN: { route: Route; field: Field; why: string }[] = [
  { route: 'relay', field: 'pictures', why: "Pictures in messages stay on that runner; the Mac shows each one's chip in the words." },
  { route: 'phone', field: 'pictures', why: "phone:thread carries words only; the phone gets a message's pictures from phone:images." },
];

const SCENARIOS: { name: string; play: (p: Play) => void }[] = [
  {
    name: 'a decision card, with what each answer does and a pick',
    play: (p) => {
      p.say('Two ways to go.');
      p.endTurn({ needs: 'you', asks: [{ question: 'Same thread or new?', options: [{ label: 'Same', does: 'One thread that moves' }, { label: 'New', does: 'The old one is archived' }], suggested: 1 }] });
    },
  },
  {
    name: 'two asks, one with a link to look at',
    play: (p) => {
      p.say('Two things.');
      p.endTurn({ needs: 'you', asks: [
        { question: 'Deploy the fix?', options: [{ label: 'Deploy' }, { label: 'Wait' }], links: [{ title: 'See the diff', url: 'https://github.com/mikecann/threadbear/pull/1' }] },
        { question: 'Plug in the phone and say when.' },
      ] });
    },
  },
  {
    name: 'a done card with follow-ups',
    play: (p) => {
      p.say('Landed it.');
      p.endTurn({ needs: 'nothing', next: ['Make the phone show Stop on a running thread', 'Check the website draws the new card'] });
    },
  },
  {
    name: 'a reply with no card',
    play: (p) => {
      p.say('Just an answer.');
      p.endTurn({ needs: 'nothing' });
    },
  },
  {
    name: 'Mike sends two pictures placed in his words',
    play: (p) => {
      p.say('Ready.');
      p.endTurn({ needs: 'nothing' });
      const dir = tmpDir('tb-scenario-');
      const pics = [1, 2].map((i) => {
        const file = path.join(dir, `p${i}.png`);
        fs.writeFileSync(file, makePng(4, 4));
        return { path: file, mediaType: 'image/png' };
      });
      p.send('this [Picture 1] should look like [Picture 2]', pics);
      p.say('They differ in colour.');
      p.endTurn({ needs: 'nothing' });
    },
  },
];

function pick(v: View, field: Field): unknown {
  switch (field) {
    case 'messages':
      return v.messages.map(({ role, text }) => ({ role, text }));
    case 'pictures':
      return v.messages.map((m) => m.pictures);
    default:
      return field === 'needs' ? (v.needs ?? null) : v[field];
  }
}
const FIELDS: Field[] = ['needs', 'asks', 'next', 'messages', 'pictures'];
const known = (route: Route, field: Field) => KNOWN.find((k) => k.route === route && k.field === field);

for (const s of SCENARIOS) {
  test(`the same on every route: ${s.name}`, async () => {
    const { views, refused } = await threeWays(s.play);
    assert.deepEqual(refused, [], 'the backend took everything the runner sent');
    for (const route of ['relay', 'phone'] as const) {
      for (const field of FIELDS) {
        if (known(route, field)) continue;
        assert.deepEqual(pick(views[route], field), pick(views.here, field), `${field} differs on ${route === 'relay' ? 'another Mac (through Convex)' : 'the phone and website'}`);
      }
    }
  });
}

test('each known difference is still a difference, and says why', async () => {
  const all = await Promise.all(SCENARIOS.map((s) => threeWays(s.play)));
  for (const k of KNOWN) {
    assert.ok(k.why.trim().endsWith('.'), 'says why, as a sentence');
    const differs = all.some(({ views }) => JSON.stringify(pick(views[k.route], k.field)) !== JSON.stringify(pick(views.here, k.field)));
    assert.ok(differs, `${k.field} on ${k.route} is the same as here now: take it out of KNOWN`);
  }
});
