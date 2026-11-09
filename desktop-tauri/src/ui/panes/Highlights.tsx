// What the thread made, shared and pinned (docs/protocol.md, "Highlights").
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PaneDef, PaneProps } from '../registry.ts';
import type { AppStore } from '../../core/store.ts';
import type { ThreadSummary } from '../../core/types.ts';
import { ago } from '../../../../web/src/format.ts';
import { Chev, FilePreview } from '../pages-lib/filePreview.tsx';
import { dirName, relativeTo } from '../pages-lib/pathStyle.ts';
import { errorText } from '../pages-lib/runnerFiles.ts';
import './highlights.css';

// threads.highlights' answer (docs/protocol.md, "Highlights"). The runner's
// protocol.ts doesn't carry these types, so they are written out here.
type Item = {
  id: string;
  kind: 'file' | 'link' | 'pr' | 'commit';
  title: string;
  url?: string;
  path?: string;
  how: 'pinned' | 'written' | 'opened' | 'mentioned' | 'created' | 'committed';
  note?: string;
  show?: true;
  sha?: string;
  branch?: string;
  pushed?: true;
  seq: number;
  lastSeq: number;
  at: string;
};
type ThreadHighlights = { highlights: Item[]; edited: string[]; brief?: { text: string; at: string } };

const webUrl = (u?: string): string | undefined => (u && /^https?:\/\//i.test(u) ? u : undefined);

function when(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const a = ago(ms);
  return a === 'now' ? 'just now' : /^\d+[mhd]$/.test(a) ? `${a} ago` : a;
}

const HOW: Record<Item['how'], string> = {
  pinned: 'Pinned',
  written: 'Written',
  opened: 'Opened',
  mentioned: 'Mentioned',
  created: 'Created',
  committed: 'Committed',
};

function Glyph({ kind }: { kind: Item['kind'] | 'edited' }) {
  const p = { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
  if (kind === 'link') {
    return (
      <svg {...p}>
        <path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 014.5 9l1-1" />
      </svg>
    );
  }
  if (kind === 'pr') {
    return (
      <svg {...p}>
        <circle cx="4.5" cy="3.5" r="1.5" />
        <circle cx="4.5" cy="12.5" r="1.5" />
        <circle cx="11.5" cy="12.5" r="1.5" />
        <path d="M4.5 5v6M11.5 11V6.5a2 2 0 00-2-2H8M9.5 3l-1.5 1.5L9.5 6" />
      </svg>
    );
  }
  if (kind === 'commit') {
    return (
      <svg {...p}>
        <circle cx="8" cy="8" r="2.5" />
        <path d="M1.5 8h4M10.5 8h4" />
      </svg>
    );
  }
  return (
    <svg {...p}>
      <path d="M4 1.5h5l3 3v10H4z" />
      <path d="M9 1.5v3h3" />
    </svg>
  );
}

function RemoveButton({ onRemove, what }: { onRemove: () => void; what: string }) {
  return (
    <button className="ghost hl-x" title={`Take ${what} off this list. It will not come back if the agent mentions it again.`} aria-label={`Remove ${what}`} onClick={onRemove}>
      ✕
    </button>
  );
}

function Row({
  item,
  cwd,
  open,
  toggle,
  remove,
  store,
}: {
  item: Item;
  cwd: string;
  open: boolean;
  toggle: () => void;
  remove: () => void;
  store: AppStore;
}) {
  const href = webUrl(item.url);
  const [copied, setCopied] = useState(false);
  let where: ReactNode = null;
  if (item.kind === 'file' && item.path) {
    const rel = relativeTo(cwd, dirName(item.path));
    const dir = rel === undefined ? dirName(item.path) : rel;
    where = dir ? <span className="hl-dir" title={item.path}>{dir}</span> : null;
  }
  const meta = [HOW[item.how], when(item.at)].filter(Boolean).join(', ');
  const head =
    item.kind === 'file' ? (
      <button className="hl-main" title={open ? 'Hide the preview' : `Preview ${item.title}`} aria-expanded={open} onClick={toggle}>
        <Glyph kind="file" />
        <span className="hl-title">{item.title}</span>
        <span className="hl-chev"><Chev open={open} /></span>
      </button>
    ) : item.kind === 'commit' ? (
      <button
        className="hl-main"
        title="Copy the commit id"
        onClick={() => {
          void navigator.clipboard?.writeText(item.sha ?? item.id.replace(/^commit:/, '')).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }, () => {});
        }}
      >
        <Glyph kind="commit" />
        <span className="hl-title">{item.title}</span>
        <code className="hl-sha">{copied ? 'copied' : (item.sha ?? '').slice(0, 7)}</code>
      </button>
    ) : href ? (
      <a className="hl-main" href={href} target="_blank" rel="noopener noreferrer" title={`Open ${href} in a new tab`}>
        <Glyph kind={item.kind} />
        <span className="hl-title">{item.title}</span>
      </a>
    ) : (
      <span className="hl-main" title={item.url}>
        <Glyph kind={item.kind} />
        <span className="hl-title">{item.title}</span>
      </span>
    );
  return (
    <li className="hl-row">
      <div className="hl-head">
        {head}
        <RemoveButton onRemove={remove} what={item.title} />
      </div>
      {item.note && <div className="hl-note">{item.note}</div>}
      <div className="hl-meta">
        {where}
        <span>{meta}</span>
        {item.kind === 'commit' && item.branch && <span>on {item.branch}</span>}
        {item.kind === 'commit' && item.pushed && <span>pushed</span>}
        {item.kind !== 'file' && item.kind !== 'commit' && href && <span className="hl-dir" title={href}>{new URL(href).host}</span>}
      </div>
      {open && item.kind === 'file' && item.path && (
        <div className="hl-preview">
          <FilePreview store={store} path={item.path} compact />
        </div>
      )}
    </li>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="hl-sec">
      <h3>
        {title}
        {count !== undefined && <span className="hl-count"> {count}</span>}
      </h3>
      {children}
    </section>
  );
}

function Edited({ files, cwd, store, open, toggle }: { files: string[]; cwd: string; store: AppStore; open: Set<string>; toggle: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, 12);
  return (
    <>
      <ul className="hl-list">
        {shown.map((f) => {
          const rel = relativeTo(cwd, f) ?? f;
          const id = `edited:${f}`;
          return (
            <li key={f} className="hl-row">
              <button className="hl-main" title={open.has(id) ? 'Hide the file' : `Show ${f}`} aria-expanded={open.has(id)} onClick={() => toggle(id)}>
                <Glyph kind="edited" />
                <span className="hl-title" title={f}>{rel}</span>
                <span className="hl-chev"><Chev open={open.has(id)} /></span>
              </button>
              {open.has(id) && (
                <div className="hl-preview">
                  <FilePreview store={store} path={f} compact />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {files.length > shown.length && (
        <button className="ghost hl-more" title="Show the rest of the edited files" onClick={() => setAll(true)}>
          Show all {files.length}
        </button>
      )}
    </>
  );
}

type Loaded = { id: string; value: ThreadHighlights };

// threads.highlights, read again (at most every 400 ms) when the thread's
// lastSeq or highlightsAt moves.
function useHighlights(store: AppStore, thread: ThreadSummary, conn: string) {
  const [data, setData] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const busy = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const id = thread.id;

  const load = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      const value = await store.rpc.request<ThreadHighlights>('threads.highlights', { threadId: id });
      setData({ id, value });
      setError(undefined);
    } catch (e) {
      setError(errorText(e, 'list highlights'));
    } finally {
      setReady(true);
      busy.current = false;
      if (again.current) {
        again.current = false;
        void load();
      }
    }
  }, [store, id]);

  const first = useRef(true);
  useEffect(() => {
    setReady(false);
    first.current = true;
    return () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [id]);

  useEffect(() => {
    if (conn !== 'open' || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      first.current = false;
      void load();
    }, first.current ? 0 : 400);
  }, [load, conn, id, thread.lastSeq, thread.highlightsAt]);

  return { data: data?.id === id ? data.value : undefined, error, ready, reload: load, setData: (value: ThreadHighlights) => setData({ id, value }) };
}

function HighlightsPane({ store, snap, thread }: PaneProps) {
  const { data, error, ready, reload, setData } = useHighlights(store, thread, snap.conn);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<string>();
  const seenShow = useRef<Set<string>>(new Set());

  // A new thread starts with nothing open or announced.
  useEffect(() => {
    setOpen(new Set());
    setFailed(undefined);
    seenShow.current = new Set();
  }, [thread.id]);

  // A pin the agent asked to have shown opens by itself, once.
  useEffect(() => {
    if (!data) return;
    const fresh = data.highlights.filter((h) => h.show && h.kind === 'file' && !seenShow.current.has(h.id));
    if (!fresh.length) return;
    for (const h of fresh) seenShow.current.add(h.id);
    setOpen((o) => new Set([...o, ...fresh.map((h) => h.id)]));
  }, [data]);

  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  const remove = async (item: Item) => {
    if (data) setData({ ...data, highlights: data.highlights.filter((h) => h.id !== item.id) });
    try {
      await store.rpc.request('threads.removeHighlight', { threadId: thread.id, highlightId: item.id });
      setFailed(undefined);
    } catch (e) {
      setFailed(errorText(e, 'remove highlights'));
      void reload();
    }
  };

  if (!data) {
    if (error) return <div className="hl-empty hl-bad">{error}</div>;
    return <div className="hl-empty">{ready ? 'Nothing here yet.' : 'Loading...'}</div>;
  }

  const items = data.highlights;
  const pinned = items.filter((h) => h.how === 'pinned');
  const rest = items.filter((h) => h.how !== 'pinned');
  const files = rest.filter((h) => h.kind === 'file');
  const links = rest.filter((h) => h.kind === 'link' || h.kind === 'pr');
  const commits = rest.filter((h) => h.kind === 'commit');
  const nothing = !items.length && !data.edited.length && !data.brief;
  const list = (xs: Item[]) => (
    <ul className="hl-list">
      {xs.map((h) => (
        <Row key={h.id} item={h} cwd={thread.cwd} open={open.has(h.id)} toggle={() => toggle(h.id)} remove={() => void remove(h)} store={store} />
      ))}
    </ul>
  );
  return (
    <div className="hl">
      {error && <div className="hl-bad hl-line">{error}</div>}
      {failed && <div className="hl-bad hl-line">{failed}</div>}
      {data.brief && <p className="hl-brief">{data.brief.text}</p>}
      {nothing && <div className="hl-empty">Nothing yet. Files the agent writes or pins, and links and commits it shares, turn up here.</div>}
      {pinned.length > 0 && <Section title="Pinned">{list(pinned)}</Section>}
      {files.length > 0 && <Section title="Files">{list(files)}</Section>}
      {links.length > 0 && <Section title="Links and pull requests">{list(links)}</Section>}
      {commits.length > 0 && <Section title="Commits">{list(commits)}</Section>}
      {data.edited.length > 0 && (
        <Section title="Files edited" count={data.edited.length}>
          <Edited files={data.edited} cwd={thread.cwd} store={store} open={open} toggle={toggle} />
        </Section>
      )}
    </div>
  );
}

const pane: PaneDef = {
  id: 'highlights',
  title: 'Highlights',
  hint: 'The files, links and commits the agent pinned in this thread for you to look at',
  order: 10,
  available: (t) => t.lastSeq > 0 || Boolean(t.highlightsAt),
  Pane: HighlightsPane,
};
export default pane;
