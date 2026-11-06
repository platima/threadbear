import { useEffect, useRef, useState } from 'react';
import { errorText, type AppStore, type Snapshot } from '../core/store.ts';
import { PANES } from './registry.ts';
import { Transcript } from './Transcript.tsx';
import { Composer } from './Composer.tsx';
import './thread/thread.css';

const tomorrow9 = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
};

const PANE_KEY = 'threadbear.pane';
const readPane = (): string | undefined => {
  try {
    return localStorage.getItem(PANE_KEY) || undefined;
  } catch {
    return undefined;
  }
};

// The thread's name; double-click to change it.
function Title({ store, id, title }: { store: AppStore; id: string; title: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setEditing(false), [id]);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  const save = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === title) return;
    setError(undefined);
    store.update(id, { title: next }).catch((e: unknown) => {
      setError(errorText(e));
      setTimeout(() => setError(undefined), 6000);
    });
  };
  if (editing) {
    return (
      <input
        ref={input}
        className="tb-title-edit"
        title="The thread's name. Enter saves, Escape leaves it as it was."
        value={draft}
        maxLength={200}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          else if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <>
      <h1
        title="Double-click to rename this thread"
        onDoubleClick={() => {
          setDraft(title);
          setEditing(true);
        }}
      >
        {title || 'New thread'}
      </h1>
      {error && <div className="error">{error}</div>}
    </>
  );
}

export function ThreadView({ store, snap }: { store: AppStore; snap: Snapshot }) {
  const [tab, setTab] = useState<string | undefined>(readPane);
  const [problem, setProblem] = useState<string>();
  const t = snap.threads.get(snap.selected!);
  if (!t) return <div className="empty">{snap.loading ? 'Opening...' : 'That thread has gone.'}</div>;
  const busy = store.model.busy;
  const panes = PANES.filter((p) => p.available?.(t) ?? true);
  const shown = panes.find((p) => p.id === tab);
  const pick = (id: string) => {
    const next = tab === id ? undefined : id;
    setTab(next);
    try {
      localStorage.setItem(PANE_KEY, next ?? '');
    } catch {
      // not kept
    }
  };
  // A change the runner refused or can't do is said in the header, then forgotten.
  const change = (patch: Record<string, unknown>) => {
    setProblem(undefined);
    store.update(t.id, patch).catch((e: unknown) => {
      setProblem(errorText(e));
      setTimeout(() => setProblem(undefined), 6000);
    });
  };
  const status = t.status === 'running' || t.status === 'starting' ? 'live' : t.status === 'waiting' || t.needsYou ? 'warn' : '';
  return (
    <div className="thread">
      <div className="center">
      <div className="head">
        <div className="grow">
          <Title store={store} id={t.id} title={t.title} />
          <div className="sub" title={t.cwd}>
            {t.cwd}
          </div>
        </div>
        <span className={`chip ${status}`} title="What the thread is doing">
          {t.status}
        </span>
        {t.costUsd !== undefined && (
          <span className="chip" title="What the thread has cost so far">
            ${t.costUsd.toFixed(2)}
          </span>
        )}
        {problem && <span className="error">{problem}</span>}
        {panes.map((p) => (
          <button key={p.id} className={p.id === tab ? 'on' : ''} title={p.title} onClick={() => pick(p.id)}>
            {p.title}
            {p.badge?.(t) ? <span className="badge">{p.badge(t)}</span> : null}
          </button>
        ))}
        <button title={t.starredAt ? 'Unstar' : 'Star'} onClick={() => change({ starred: !t.starredAt })}>
          {t.starredAt ? '★' : '☆'}
        </button>
        <select
          title="Hibernate"
          value=""
          onChange={(e) => {
            const v = e.target.value;
            const until = v === '1h' ? new Date(Date.now() + 3600_000).toISOString() : v === 'tomorrow' ? tomorrow9() : v === 'restart' ? 'restart' : null;
            change({ snoozedUntil: until });
          }}
        >
          <option value="" disabled>
            Hibernate
          </option>
          <option value="1h">For an hour</option>
          <option value="tomorrow">Until tomorrow</option>
          <option value="restart">Until restart</option>
          {(t.snoozedUntil || t.snoozedUntilRestart) && <option value="wake">Wake now</option>}
        </select>
        <button title={t.archivedAt ? 'Move this thread back to the inbox' : 'Put this thread away'} onClick={() => change(t.archivedAt ? { archived: false } : { archived: true, archivedBy: 'mike' })}>
          {t.archivedAt ? 'Bring back' : 'Archive'}
        </button>
      </div>
      {snap.loading ? <div className="empty">Opening...</div> : <Transcript store={store} snap={snap} />}
      <Composer store={store} snap={snap} busy={busy} />
      </div>
      {shown && (
        <div className="pane">
          <div className="tabs">
            <b style={{ padding: '4px 8px' }}>{shown.title}</b>
            <span className="grow" />
            <button className="ghost" title="Close this panel" onClick={() => pick(shown.id)}>
              ✕
            </button>
          </div>
          <div className="body">
            <shown.Pane store={store} snap={snap} thread={t} />
          </div>
        </div>
      )}
    </div>
  );
}
