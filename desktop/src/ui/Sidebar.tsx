import { useMemo, useState } from 'react';
import { errorText, type AppStore, type Snapshot } from '../core/store.ts';
import { toRow, type SummaryRow } from '../core/adapt.ts';
import { INITIAL_FOLDED, SECTIONS, archiveShown, archived as sortArchived, build, hibernating, isSnoozed, neighbour, readFolded, readOrder, shows, NO_FILTER, placesOf, ARCHIVE_FIRST, ARCHIVE_STEP, type InboxOrder, type SectionKey } from '../../../web/src/sections.ts';
import { ago, plain } from '../../../web/src/format.ts';

const FOLD_KEY = 'threadbear.folded';
const ORDER_KEY = 'threadbear.order';
const get = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const put = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // not kept
  }
};

const TITLES: Record<SectionKey, string> = { starred: 'Starred', inbox: 'Inbox', running: 'Running', hibernating: 'Hibernating', archived: 'Archived' };

export function Sidebar({ store, snap }: { store: AppStore; snap: Snapshot }) {
  const [query, setQuery] = useState('');
  const [folded, setFolded] = useState<Set<SectionKey>>(() => readFolded(get(FOLD_KEY)));
  const [order] = useState<InboxOrder>(() => readOrder(get(ORDER_KEY)));
  const [archiveLimit, setArchiveLimit] = useState(ARCHIVE_FIRST);

  const lists = useMemo(() => {
    const now = Date.now();
    const rows = [...snap.threads.values()].map(toRow);
    const wakes = new Map<string, number>();
    const { starred, inbox, running, scheduled } = build(rows, now, wakes, order);
    const snoozed = rows.filter((r) => !r.archivedAt && !r.starredAt && isSnoozed(r, now));
    return {
      starred,
      inbox,
      running,
      hibernating: hibernating(scheduled, snoozed, wakes),
      archived: sortArchived(rows.filter((r) => r.archivedAt)),
    } as Record<SectionKey, SummaryRow[]>;
  }, [snap.threads, order]);

  const narrowing = query.trim() !== '';
  const visible = (key: SectionKey) => lists[key].filter((r) => shows(r, query, NO_FILTER, snap.selected));
  const archive = archiveShown(visible('archived'), archiveLimit, narrowing, snap.selected);

  const toggle = (key: SectionKey) => {
    const next = new Set(folded);
    if (!next.delete(key)) next.add(key);
    setFolded(next);
    put(FOLD_KEY, JSON.stringify([...next]));
    if (key === 'archived' && !next.has('archived') && !snap.archivedLoaded) void store.loadArchived();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const order = SECTIONS.filter((k) => !folded.has(k) || narrowing).flatMap((k) => (k === 'archived' ? archive.rows : visible(k)).map((r) => r.threadId));
    const next = neighbour(order, snap.selected, e.key === 'ArrowDown' ? 1 : -1);
    if (next) {
      e.preventDefault();
      void store.open(next);
    }
  };

  return (
    <aside className="side" onKeyDown={onKey}>
      <div className="side-top">
        <input placeholder="Search" title="Search the threads in the list. Ctrl+K comes here." aria-label="Search threads" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button title="New thread (Ctrl+N)" onClick={() => store.deselect()}>
          New
        </button>
      </div>
      <div className="side-list">
        {SECTIONS.map((key) => {
          const rows = key === 'archived' ? archive.rows : visible(key);
          if (key === 'starred' && rows.length === 0) return null;
          const open = !folded.has(key) || (narrowing && rows.length > 0);
          return (
            <section key={key}>
              <div className="section-head" title={open ? `Hide the ${TITLES[key].toLowerCase()} threads` : `Show the ${TITLES[key].toLowerCase()} threads`} onClick={() => toggle(key)}>
                <span>{open ? '▾' : '▸'}</span>
                <span>{TITLES[key]}</span>
                <span className="count">{key === 'archived' && !snap.archivedLoaded ? '' : lists[key].length || ''}</span>
              </div>
              {open && rows.map((r) => <ThreadRowView key={r.threadId} row={r} selected={snap.selected === r.threadId} store={store} />)}
              {open && key === 'archived' && archive.more > 0 && (
                <div className="loadmore">
                  <button className="ghost" title="Show more archived threads" onClick={() => setArchiveLimit(archiveLimit + ARCHIVE_STEP)}>
                    {archive.more} more
                  </button>
                </div>
              )}
              {open && rows.length === 0 && key !== 'archived' && <div className="tsub" style={{ padding: '2px 22px' }}>{narrowing ? 'No matches' : 'Nothing here'}</div>}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function ThreadRowView({ row, selected, store }: { row: SummaryRow; selected: boolean; store: AppStore }) {
  const s = row.summary;
  // One change at a time: the buttons wait, with a spinner, until the runner has
  // answered, and a refusal is said in the banner.
  const [pending, setPending] = useState<'star' | 'archive'>();
  const change = async (which: 'star' | 'archive') => {
    if (pending) return;
    // What the thread is now, not what this row was drawn with.
    const now = store.getSnapshot().threads.get(row.threadId) ?? s;
    const patch = which === 'star' ? { starred: !now.starredAt } : now.archivedAt ? { archived: false } : { archived: true, archivedBy: 'mike' };
    setPending(which);
    try {
      await store.update(row.threadId, patch);
    } catch (e) {
      store.notify('error', errorText(e));
    } finally {
      setPending(undefined);
    }
  };
  const broken = s.status === 'error' || s.status === 'stopped';
  const dot = s.status === 'running' || s.status === 'starting' ? 'running' : s.status === 'waiting' || s.needsYou ? 'needs' : broken ? 'broken' : row.unread ? 'unread' : '';
  return (
    <div className={`trow${selected ? ' sel' : ''}`} onClick={() => void store.open(row.threadId)}>
      <span className={`dot ${dot}`} />
      <div className="tbody">
        <div className="ttitle">
          <b>{row.title || 'New thread'}</b>
          <span>{ago(row.lastActivityMs)}</span>
        </div>
        <div className="tsub">{plain(row.preview) || placesOf(row)[0]}</div>
      </div>
      <div className="acts" onClick={(e) => e.stopPropagation()}>
        <button title={pending === 'star' ? 'Waiting for the runner' : s.starredAt ? 'Unstar' : 'Star'} disabled={!!pending} aria-busy={pending === 'star'} onClick={() => void change('star')}>
          {pending === 'star' ? <span className="spin" aria-hidden="true" /> : s.starredAt ? '★' : '☆'}
        </button>
        <button title={pending === 'archive' ? 'Waiting for the runner' : s.archivedAt ? 'Bring back' : 'Archive'} disabled={!!pending} aria-busy={pending === 'archive'} onClick={() => void change('archive')}>
          {pending === 'archive' ? <span className="spin" aria-hidden="true" /> : s.archivedAt ? '↩\uFE0E' : '▣'}
        </button>
      </div>
    </div>
  );
}
