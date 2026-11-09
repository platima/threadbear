import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppStore, Snapshot } from '../../core/store.ts';
import type { Pool } from '../../core/types.ts';
import { useAction } from './ops-rpc.ts';
import { Card, Chip, ConfirmBar, Note } from './ops-ui.tsx';

type PoolDraft = { key: string; id: string; title: string; accountIds: string[]; folders: string; icon?: string; builtIn?: boolean; isNew?: boolean };

let keys = 0;
const fromPools = (pools: Pool[]): PoolDraft[] =>
  pools.map((p) => ({ key: `k${++keys}`, id: p.id, title: p.title, accountIds: [...p.accountIds], folders: (p.folders ?? []).join('\n'), icon: p.icon, builtIn: p.builtIn }));

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'pool';

// The drafts as pools.save wants them. A new pool's id comes from its title.
function toPools(drafts: PoolDraft[]): Pool[] {
  const taken = new Set(drafts.filter((d) => !d.isNew).map((d) => d.id));
  return drafts.map((d) => {
    let id = d.id;
    if (d.isNew) {
      const base = slug(d.title);
      id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      taken.add(id);
    }
    const folders = d.folders
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    return { id, title: d.title.trim(), accountIds: d.accountIds, ...(folders.length ? { folders } : {}), ...(d.icon ? { icon: d.icon } : {}) };
  });
}

const same = (a: Pool[], b: Pool[]) => JSON.stringify(a) === JSON.stringify(b);
const providerName = (p: string) => (p === 'codex' ? 'Codex' : 'Claude');

export function PoolsSection({ store, snap }: { store: AppStore; snap: Snapshot }) {
  const source = useMemo(() => toPools(fromPools(snap.pools)), [snap.pools]);
  const [draft, setDraft] = useState<PoolDraft[]>(() => fromPools(snap.pools));
  const was = useRef(source);
  const act = useAction();
  const [said, setSaid] = useState<string>();
  const [resetting, setResetting] = useState(false);

  // The runner's list replaces the form unless there are edits in it.
  useEffect(() => {
    const previous = was.current;
    was.current = source;
    setDraft((d) => (same(toPools(d), previous) ? fromPools(snap.pools) : d));
  }, [source, snap.pools]);

  const dirty = !same(toPools(draft), source);
  const edit = (key: string, patch: Partial<PoolDraft>) => {
    setDraft((d) => d.map((p) => (p.key === key ? { ...p, ...patch } : p)));
    setSaid(undefined);
  };
  const toggle = (p: PoolDraft, id: string, on: boolean) => edit(p.key, { accountIds: on ? [...p.accountIds, id] : p.accountIds.filter((x) => x !== id) });
  const custom = snap.pools.some((p) => !p.builtIn);

  const save = async () => {
    const r = await act.run('save', () => store.rpc.request<{ pools: Pool[] }>('pools.save', { pools: toPools(draft) }));
    if (r) {
      setDraft(fromPools(r.pools));
      setSaid('Saved.');
    }
  };
  const reset = async () => {
    setResetting(false);
    const r = await act.run('reset', () => store.rpc.request<{ pools: Pool[] }>('pools.save', { pools: [] }));
    if (r) {
      setDraft(fromPools(r.pools));
      setSaid('Back to the built-in pools.');
    }
  };

  return (
    <>
      <Card>
        <h3>Logins</h3>
        {snap.accounts.length ? (
          <div className="set-logins">
            {snap.accounts.map((a) => (
              <div key={a.id} className="set-login" title={a.configDir}>
                <span className="set-login-name">{a.title}</span>
                <Chip>{providerName(a.provider)}</Chip>
                {a.plan && <Chip>{a.plan}</Chip>}
                {a.note && <Chip tone="warn">{a.note}</Chip>}
                <span className="ops-sub">{a.configDir}</span>
              </div>
            ))}
          </div>
        ) : (
          <Note>The runner hasn't found a login yet. Sign in with Claude Code and it shows here.</Note>
        )}
        <Note>The runner finds logins by itself. Pools decide which of them a thread may use.</Note>
      </Card>

      <Card>
        <h3>Pools</h3>
        <Note>A pool is a named set of logins. A thread in a pool runs each turn on whichever of its logins has room. Saving writes the whole list to the runner's settings, built-in pools included.</Note>
        {draft.map((p) => (
          <div className="set-pool" key={p.key}>
            <div className="ops-row">
              <input className="set-pool-title" value={p.title} onChange={(e) => edit(p.key, { title: e.target.value })} title="The pool's name" placeholder="Name" />
              <span className="ops-sub">{p.isNew ? 'new' : p.id}</span>
              {p.builtIn && <Chip title="Worked out from the logins the runner found, until you save a list">Built in</Chip>}
              <span className="ops-spacer" />
              <button className="ghost" onClick={() => setDraft((d) => d.filter((x) => x.key !== p.key))} title="Take this pool out of the list">
                Remove
              </button>
            </div>
            <div className="set-members">
              {snap.accounts.map((a) => (
                <label key={a.id} className="set-check" title={`Let this pool use ${a.title}`}>
                  <input type="checkbox" checked={p.accountIds.includes(a.id)} onChange={(e) => toggle(p, a.id, e.target.checked)} title={`Let this pool use ${a.title}`} /> {a.title}
                </label>
              ))}
              {p.accountIds.filter((id) => !snap.accounts.some((a) => a.id === id)).map((id) => (
                <span key={id} className="ops-sub" title="The runner doesn't know this login">{id} (not found)</span>
              ))}
            </div>
            <textarea
              rows={2}
              value={p.folders}
              onChange={(e) => edit(p.key, { folders: e.target.value })}
              title="Folders for this pool, one per line"
              placeholder="Folders, one per line. A new thread in one of them starts in this pool."
              spellCheck={false}
            />
          </div>
        ))}
        {!draft.length && <Note>No pools. Saving an empty list is refused; add one, or go back to the built-in pools.</Note>}

        {resetting && <ConfirmBar text="Throw away the saved list and go back to the pools the runner works out from the logins it finds?" yes="Use the built-in pools" onYes={() => void reset()} onNo={() => setResetting(false)} busy={act.busy === 'reset'} />}
        <div className="ops-row">
          <button
            onClick={() => setDraft((d) => [...d, { key: `k${++keys}`, id: '', title: 'New pool', accountIds: [], folders: '', isNew: true }])}
            title="Add an empty pool to the list"
          >
            Add a pool
          </button>
          <button className="primary" onClick={() => void save()} disabled={!dirty || act.busy === 'save'} title="Save this list of pools to the runner">
            Save pools
          </button>
          <button
            onClick={() => {
              setDraft(fromPools(snap.pools));
              setSaid(undefined);
              act.clearError();
            }}
            disabled={!dirty}
            title="Put the list back to what the runner has"
          >
            Revert
          </button>
          {custom && !resetting && (
            <button className="ghost" onClick={() => setResetting(true)} title="Go back to the pools the runner works out by itself">
              Back to the built-in pools
            </button>
          )}
          {said && <Note tone="ok">{said}</Note>}
          {act.error && <Note tone="bad">{act.error}</Note>}
        </div>
      </Card>
    </>
  );
}
