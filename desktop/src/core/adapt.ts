import type { ThreadRow } from '../../../web/src/sections.ts';
import type { ThreadSummary } from './types.ts';

// A thread as the sidebar's rules (web/src/sections.ts, shared with the
// website, and the same as the Mac's and the iPhone's) read it.
export type SummaryRow = ThreadRow & { summary: ThreadSummary };

export function toRow(s: ThreadSummary): SummaryRow {
  return {
    summary: s,
    threadId: s.id,
    title: s.title,
    preview: s.preview,
    cwd: s.cwd,
    status: s.status,
    needsYou: s.needsYou,
    unread: s.lastSeq > s.lastSeenSeq,
    lastActivityMs: Date.parse(s.lastActivityAt),
    starredAt: s.starredAt,
    archivedAt: s.archivedAt,
    snoozedUntil: s.snoozedUntil,
    snoozedUntilRestart: s.snoozedUntilRestart,
    needs: s.needs,
    pendingReviews: s.pendingReviews,
    pendingApproval: s.status === 'waiting' ? true : undefined,
    waitingForRoom: s.waitingForRoom,
    working: s.background?.length ? 'background' : undefined,
    asks: s.asks?.map((a) => ({ ticked: a.ticked === true })),
    projects: s.projects?.map((p) => ({ id: p.id, title: p.title })),
    share: s.share ? { access: s.share.access } : undefined,
  };
}
