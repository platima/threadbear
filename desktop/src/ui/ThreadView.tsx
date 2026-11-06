import type { AppStore, Snapshot } from '../core/store.ts';
import { modelLabel } from '../../../web/src/format.ts';
import { Transcript } from './Transcript.tsx';
import { Composer } from './Composer.tsx';

const tomorrow9 = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
};

export function ThreadView({ store, snap }: { store: AppStore; snap: Snapshot }) {
  const t = snap.threads.get(snap.selected!);
  if (!t) return <div className="empty">{snap.loading ? 'Opening...' : 'That thread has gone.'}</div>;
  const busy = store.model.busy;
  const status = t.status === 'running' || t.status === 'starting' ? 'live' : t.status === 'waiting' || t.needsYou ? 'warn' : '';
  return (
    <>
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
    </>
  );
}
