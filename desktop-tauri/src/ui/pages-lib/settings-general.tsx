import { useEffect, useRef, useState } from 'react';
import type { AppStore, Snapshot } from '../../core/store.ts';
import { useAction, useNotification, useRequest } from './ops-rpc.ts';
import type { Settings } from './ops-types.ts';
import { Card, Note, Problem } from './ops-ui.tsx';

type Draft = { defaultCwd: string; idle: string; max: string; followMain: boolean; bulletReplies: boolean; oneReply: boolean; pool: string; folders: string };

const toDraft = (s: Settings): Draft => ({
  defaultCwd: s.defaultCwd,
  idle: String(s.idleMinutes),
  max: String(s.maxLiveCLIs),
  followMain: s.followMain,
  bulletReplies: s.bulletReplies,
  oneReply: s.oneReply,
  pool: s.models.pool ?? '',
  folders: s.models.privateFolders.join('\n'),
});

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

// What the person changed, as a settings.update. Only what differs goes.
function patchOf(d: Draft, s: Settings): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (d.defaultCwd.trim() !== s.defaultCwd) patch.defaultCwd = d.defaultCwd.trim();
  if (Number(d.idle) !== s.idleMinutes) patch.idleMinutes = d.idle.trim() === '' ? NaN : Number(d.idle);
  if (Number(d.max) !== s.maxLiveCLIs) patch.maxLiveCLIs = d.max.trim() === '' ? NaN : Number(d.max);
  if (d.followMain !== s.followMain) patch.followMain = d.followMain;
  if (d.bulletReplies !== s.bulletReplies) patch.bulletReplies = d.bulletReplies;
  if (d.oneReply !== s.oneReply) patch.oneReply = d.oneReply;
  const models: Record<string, unknown> = {};
  if ((d.pool || null) !== s.models.pool) models.pool = d.pool || null;
  const folders = lines(d.folders);
  if (JSON.stringify(folders) !== JSON.stringify(s.models.privateFolders)) models.privateFolders = folders;
  if (Object.keys(models).length) patch.models = models;
  return patch;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">{label}</div>
      <div className="set-control">
        {children}
        {hint && <div className="ops-sub">{hint}</div>}
      </div>
    </div>
  );
}

export function GeneralSection({ store, snap }: { store: AppStore; snap: Snapshot }) {
  const req = useRequest<{ settings: Settings }>(store, snap.conn, 'settings.get');
  const [saved, setSaved] = useState<Settings>();
  const [draft, setDraft] = useState<Draft>();
  const before = useRef<string>('');
  const act = useAction();
  const [said, setSaid] = useState<string>();
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (req.data) setSaved(req.data.settings);
  }, [req.data]);
  useNotification(store, 'settings.updated', (p: { settings: Settings }) => setSaved(p.settings));

  // New settings from the runner replace the form, unless there are edits in it.
  useEffect(() => {
    if (!saved) return;
    const was = before.current;
    before.current = JSON.stringify(toDraft(saved));
    setDraft((d) => (!d || JSON.stringify(d) === was ? toDraft(saved) : d));
  }, [saved]);

  if (req.error && !saved) return <Problem error={req.error} what="The runner's settings" />;
  if (!saved || !draft) return <Note>{snap.conn === 'open' ? 'Loading the settings...' : 'Waiting for the runner.'}</Note>;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft({ ...draft, [k]: v });
    setSaid(undefined);
    setProblem(undefined);
  };
  const patch = patchOf(draft, saved);
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    for (const [key, name] of [['idleMinutes', 'Release idle sessions after'], ['maxLiveCLIs', 'Most sessions kept open']] as const) {
      if (key in patch && !Number.isFinite(patch[key] as number)) {
        setProblem(`${name} needs a number.`);
        return;
      }
    }
    const r = await act.run('save', () => store.rpc.request<{ settings: Settings }>('settings.update', patch));
    if (r) {
      setSaved(r.settings);
      setDraft(toDraft(r.settings));
      before.current = JSON.stringify(toDraft(r.settings));
      setSaid('followMain' in patch ? 'Saved. Following main changes when the runner next restarts.' : 'Saved.');
    }
  };

  const poolIds = snap.pools.map((p) => ({ id: p.id, title: p.title }));
  if (draft.pool && !poolIds.some((p) => p.id === draft.pool)) poolIds.push({ id: draft.pool, title: draft.pool });

  return (
    <Card>
      <Row label="Default folder" hint="Where a new thread starts when it doesn't name a folder. It has to exist already.">
        <input value={draft.defaultCwd} onChange={(e) => set('defaultCwd', e.target.value)} title="Default folder for new threads" spellCheck={false} />
      </Row>
      <Row label="Release idle sessions after" hint="A Claude Code session with no turn for this long is let go. It starts again when you next send.">
        <span className="set-inline">
          <input type="number" min={1} step={1} value={draft.idle} onChange={(e) => set('idle', e.target.value)} title="Minutes before an idle session is released" /> minutes
        </span>
      </Row>
      <Row label="Most sessions kept open" hint="The most Claude Code sessions the runner keeps open at once, from 1 to 20.">
        <input type="number" min={1} max={20} step={1} value={draft.max} onChange={(e) => set('max', e.target.value)} title="The most sessions kept open at once" />
      </Row>
      <Row label="Following main" hint="Builds and restarts onto the main branch by itself. A change takes effect when the runner next restarts.">
        <label className="set-check">
          <input type="checkbox" checked={draft.followMain} onChange={(e) => set('followMain', e.target.checked)} title="Follow main by itself" /> Update from main by itself
        </label>
      </Row>
      <Row label="Bullet replies" hint="A turn's reply is the agent's own short bullet summary, not its whole message.">
        <label className="set-check">
          <input type="checkbox" checked={draft.bulletReplies} onChange={(e) => set('bulletReplies', e.target.checked)} title="Replies are short bullet summaries" /> Short bullet-point replies
        </label>
      </Row>
      <Row label="One reply" hint="The agent gives its summary first, then its message, as one reply. On by default.">
        <label className="set-check">
          <input type="checkbox" checked={draft.oneReply} onChange={(e) => set('oneReply', e.target.checked)} title="The agent gives its summary first, then its message, as one reply. On by default." /> One reply per turn
        </label>
      </Row>
      <Row label="Titles and small jobs" hint="The pool whose Claude logins write thread titles and do other small jobs. Off means no model-written titles.">
        <select value={draft.pool} onChange={(e) => set('pool', e.target.value)} title="Which pool answers small jobs">
          <option value="">Off</option>
          {poolIds.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Private folders" hint="One folder per line. Nothing from a thread in one of these, or under one, is sent for small jobs.">
        <textarea rows={3} value={draft.folders} onChange={(e) => set('folders', e.target.value)} title="Folders whose threads are never used for small jobs" spellCheck={false} />
      </Row>

      <div className="ops-row">
        <button className="primary" onClick={() => void save()} disabled={!dirty || act.busy === 'save'} title="Save these settings to the runner">
          Save
        </button>
        <button
          onClick={() => {
            setDraft(toDraft(saved));
            setSaid(undefined);
            setProblem(undefined);
            act.clearError();
          }}
          disabled={!dirty}
          title="Put the form back to what the runner has"
        >
          Revert
        </button>
        {said && <Note tone="ok">{said}</Note>}
        {(problem || act.error) && <Note tone="bad">{problem ?? act.error}</Note>}
      </div>
    </Card>
  );
}
