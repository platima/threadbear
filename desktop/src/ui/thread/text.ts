// The plain text rules of the thread view, kept apart from the components so
// they can be tested with node --test (text.test.ts).

import type { Ask } from '../../core/types.ts';

// What an ask offers to pick: its options, else the reply it wants ("done").
export function choices(a: Pick<Ask, 'options' | 'reply'>): string[] {
  if (a.options?.length) return a.options;
  return a.reply?.trim() ? [a.reply.trim()] : [];
}

export type Picked = { index: number; action: string; answer: string };

// The message sent for answered asks (docs/protocol.md, "Needs you",
// Answering): each question then its answer, numbered by the card's order
// when it had several, then anything else typed in the composer.
export function answerMessage(count: number, answers: Picked[], extra: string): string {
  const parts = answers.map((a) => (count === 1 ? `${a.action}\n${a.answer}` : `${a.index + 1}. ${a.action}\n   ${a.answer.replace(/\n/g, '\n   ')}`));
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}

// An ask as a sentence: its action on one line.
export function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').trim();
}

// ---- [Picture N] markers (docs/protocol.md, "Pictures in a message") -------

export const marker = (n: number): string => `[Picture ${n}]`;

// Puts picture n's marker into the text at a caret, with a space either side
// where the neighbours aren't already spaces. Returns the text and where the
// caret goes.
export function insertMarker(text: string, from: number, to: number, n: number): { text: string; caret: number } {
  const at = Math.max(0, Math.min(from, text.length));
  const end = Math.max(at, Math.min(to, text.length));
  const before = text.slice(0, at);
  const after = text.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const tail = after && !/^\s/.test(after) ? ' ' : '';
  const put = `${lead}${marker(n)}${tail || (after ? '' : ' ')}`;
  return { text: before + put + after, caret: (before + put).length };
}

// Takes picture n out: its marker goes and the later ones count down.
export function dropMarker(text: string, n: number): string {
  const out = text.replace(/(\s?)\[Picture ([1-9]\d{0,2})\]/g, (all, space: string, num: string, offset: number, whole: string) => {
    const m = Number(num);
    if (m !== n) return m > n ? `${space}${marker(m - 1)}` : all;
    const next = whole[offset + all.length];
    return next === undefined || /\s/.test(next) ? '' : space;
  });
  return text.startsWith(marker(n)) ? out.replace(/^ /, '') : out;
}

// A message's text as pieces: plain strings, and the numbers of pictures its
// markers stand for.
export function splitMarkers(text: string): (string | number)[] {
  const out: (string | number)[] = [];
  let at = 0;
  for (const m of text.matchAll(/\[Picture ([1-9]\d{0,2})\]/g)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push(Number(m[1]));
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
