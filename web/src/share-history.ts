// A shared thread's rows as far back as the reader has gone: the newest from
// share:view live, and older chunks read once with beforeSeq. The part of
// share.tsx with no Convex in it, so it can be tested alone (the phone's
// MessageHistory.swift does the same).
//
// The live query stays the size it opened with. It used to grow by raising
// its limit, up to 2,000 rows, and a live query reads its whole page again for
// every new row: a scrolled-back phone doing the same cost 37.6 MB of Convex
// I/O in a day (8 Nov). Older rows are read once, as past rows don't change.

export type Row = { seq: number };
export type Picture = { seq: number; url: string };
export type Page<R extends Row, P extends Picture> = { messages: R[]; images: P[]; hasMore: boolean };

export type History<R extends Row, P extends Picture> = {
  live?: Page<R, P>;
  // Older rows from chunks, oldest first, all before the live page's.
  older: R[];
  olderImages: P[];
  // Whether there's more before `older`; undefined until a chunk has come.
  olderHasMore?: boolean;
};

export function empty<R extends Row, P extends Picture>(): History<R, P> {
  return { older: [], olderImages: [] };
}

export function rows<R extends Row, P extends Picture>(h: History<R, P>): R[] {
  return [...h.older, ...(h.live?.messages ?? [])];
}

// The pictures of every row shown, each once.
export function pictures<R extends Row, P extends Picture>(h: History<R, P>): P[] {
  const seen = new Set<string>();
  return [...h.olderImages, ...(h.live?.images ?? [])].filter((p) => !seen.has(p.url) && seen.add(p.url));
}

export function hasMore<R extends Row, P extends Picture>(h: History<R, P>): boolean {
  return h.olderHasMore ?? h.live?.hasMore ?? false;
}

export function firstSeq<R extends Row, P extends Picture>(h: History<R, P>): number | undefined {
  return h.older[0]?.seq ?? h.live?.messages[0]?.seq;
}

// A new answer from the live query. Rows that slide off its top as new ones
// come in move to `older`, or there'd be a hole above the live ones.
export function takeLive<R extends Row, P extends Picture>(h: History<R, P>, page: Page<R, P>): History<R, P> {
  const first = page.messages[0]?.seq;
  const old = h.live;
  if (!old || first === undefined) return { ...h, live: page };
  const last = old.messages[old.messages.length - 1]?.seq;
  // Nothing in common with the answer before (the page was away while a whole
  // page of new rows came): what's between is unknown, so start again from
  // the newest rather than show a hole.
  if (last !== undefined && last < first) return { ...empty<R, P>(), live: page };
  // Its top can also move back up (big rows above the byte cap that got
  // smaller): those rows are the live page's again.
  const older = h.older.filter((m) => m.seq < first);
  const olderImages = h.olderImages.filter((p) => p.seq < first);
  const after = older[older.length - 1]?.seq ?? -Infinity;
  return {
    ...h,
    live: page,
    older: [...older, ...old.messages.filter((m) => m.seq < first && m.seq > after)],
    olderImages: [...olderImages, ...old.images.filter((p) => p.seq < first && p.seq > after)],
  };
}

// The seq "Load earlier messages" reads a chunk before, or undefined when
// there's no more.
export function nextBefore<R extends Row, P extends Picture>(h: History<R, P>): number | undefined {
  return hasMore(h) ? firstSeq(h) : undefined;
}

// A chunk of rows before `before`, or undefined if the shown rows no longer
// start there (it came too late).
export function takeOlder<R extends Row, P extends Picture>(h: History<R, P>, chunk: Page<R, P>, before: number): History<R, P> | undefined {
  if (firstSeq(h) !== before) return undefined;
  return {
    ...h,
    older: [...chunk.messages.filter((m) => m.seq < before), ...h.older],
    olderImages: [...chunk.images.filter((p) => p.seq < before), ...h.olderImages],
    olderHasMore: chunk.hasMore,
  };
}
