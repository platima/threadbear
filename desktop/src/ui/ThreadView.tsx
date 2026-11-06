import { useState } from 'react';
import type { AppStore, Snapshot } from '../core/store.ts';
import { PANES } from './registry.ts';
import { modelLabel } from '../../../web/src/format.ts';
import { Transcript } from './Transcript.tsx';
import { Composer } from './Composer.tsx';

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

export function ThreadView({ store, snap }: { store: AppStore; snap: Snapshot }) {
  const [tab, setTab] = useState<string | undefined>(readPane);
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
  const status = t.status === 'running' || t.status === 'starting' ? 'live' : t.status === 'waiting' || t.needsYou ? 'warn' : '';
  return (
    <div className="thread">
      <div className="center">
      <div className="head">
        <div className="grow">
          <h1>{t.title || 'New thread'}</h1>
          <div className="sub" title={t.cwd}>
            {t.cwd}
          </div>
        </div>
        <span className={`chip ${status}`}>{t.status}</span>
        <span className="chip">{modelLabel(t.provider, t.modelInUse ?? t.model)}</span>
        <span className="chip" title="Permission mode">
          {t.permissionMode}
        </span>
        {t.costUsd !== undefined && <span className="chip">${t.costUsd.toFixed(2)}</span>}
        {panes.map((p) => (
          <button key={p.id} className={p.id === tab ? 'on' : ''} title={p.title} onClick={() => pick(p.id)}>
            {p.title}
            {p.badge?.(t) ? <span className="badge">{p.badge(t)}</span> : null}
          </button>
        ))}
        <button title={t.starredAt ? 'Unstar' : 'Star'} onClick={() => void store.update(t.id, { starred: !t.starredAt })}>
          {t.starredAt ? '★' : '☆'}
        </button>
        <select
          title="Hibernate"
          value=""
          onChange={(e) => {
            const v = e.target.value;
            const until = v === '1h' ? new Date(Date.now() + 3600_000).toISOString() : v === 'tomorrow' ? tomorrow9() : v === 'restart' ? 'restart' : null;
            void store.update(t.id, { snoozedUntil: until });
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
        <button onClick={() => void store.update(t.id, t.archivedAt ? { archived: false } : { archived: true, archivedBy: 'mike' })}>{t.archivedAt ? 'Bring back' : 'Archive'}</button>
      </div>
      {snap.loading ? <div className="empty">Opening...</div> : <Transcript store={store} snap={snap} />}
      <Composer store={store} snap={snap} busy={busy} />
      </div>
      {shown && (
        <div className="pane">
          <div className="tabs">
            <b style={{ padding: '4px 8px' }}>{shown.title}</b>
            <span className="grow" />
            <button className="ghost" title="Close" onClick={() => pick(shown.id)}>
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
