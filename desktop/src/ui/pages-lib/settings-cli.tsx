import { useEffect, useState } from 'react';
import type { AppStore, Snapshot } from '../../core/store.ts';
import type { CliPolicy, CliStatus } from '../../core/types.ts';
import { agoWords, plural } from './ops-format.ts';
import { useAction, useNotification, useNow, useRequest } from './ops-rpc.ts';
import { Card, Chip, Facts, Note, Problem, type Tone } from './ops-ui.tsx';

const POLICIES: { id: CliPolicy; label: string; hint: string }[] = [
  { id: 'auto', label: 'Update by itself', hint: 'Installs a newer version once no thread is using the old one.' },
  { id: 'notify', label: 'Tell me, but leave it', hint: 'Says when a newer version is out and waits for you to update it.' },
  { id: 'off', label: "Don't check", hint: 'Never looks for a newer version.' },
];

function statusWords(c: CliStatus): { text: string; tone?: Tone } {
  switch (c.status) {
    case 'current':
      return { text: 'Up to date', tone: 'ok' };
    case 'behind':
      return { text: 'A newer version is out', tone: 'warn' };
    case 'held':
      return { text: 'A newer version is out, but it is held back', tone: 'warn' };
    case 'missing':
      return { text: "Claude Code wasn't found", tone: 'bad' };
    default:
      return { text: 'Not checked yet' };
  }
}

function updateWords(c: CliStatus, titleOf: (id: string) => string): { text: string; tone?: Tone } | undefined {
  const u = c.update;
  if (!u) return undefined;
  switch (u.state) {
    case 'waiting':
      return { text: `Waiting for ${u.waitingFor?.length ? u.waitingFor.map(titleOf).join(', ') : 'threads'} to finish before it updates.` };
    case 'running':
      return { text: `Updating${u.targetVersion ? ` to ${u.targetVersion}` : ''}...` };
    case 'succeeded':
      return { text: `Updated${u.targetVersion ? ` to ${u.targetVersion}` : ''}.`, tone: 'ok' };
    case 'unchanged':
      return { text: 'Checked: already on the newest version.', tone: 'ok' };
    case 'failed':
      return { text: `The update failed${u.message ? `: ${u.message}` : '.'}`, tone: 'bad' };
  }
}

export function CliSection({ store, snap }: { store: AppStore; snap: Snapshot }) {
  const req = useRequest<{ clis: CliStatus[] }>(store, snap.conn, 'clis.list');
  const [clis, setClis] = useState<CliStatus[] | undefined>(snap.hello?.clis);
  const act = useAction();
  const now = useNow(30_000);

  useEffect(() => {
    if (req.data) setClis(req.data.clis);
  }, [req.data]);
  useNotification(store, 'clis.updated', (p: { clis: CliStatus[] }) => setClis(p.clis));

  // Claude Code only: there's no Codex on Windows.
  const c = clis?.find((x) => x.provider === 'claude');
  const titleOf = (id: string) => snap.threads.get(id)?.title ?? `thread ${id.slice(0, 8)}`;

  const call = async (name: string, method: string, params: Record<string, unknown>) => {
    const r = await act.run(name, () => store.rpc.request<{ clis: CliStatus[] }>(method, params));
    if (r) setClis(r.clis);
  };

  if (!c) {
    if (req.error && !clis) return <Problem error={req.error} what="Claude Code updates" />;
    return <Note>{snap.conn === 'open' ? (clis ? "The runner doesn't report on Claude Code." : 'Asking the runner...') : 'Waiting for the runner.'}</Note>;
  }

  const s = statusWords(c);
  const u = updateWords(c, titleOf);
  const working = c.update?.state === 'running' || c.update?.state === 'waiting';
  const canUpdate = c.status === 'behind' || c.status === 'held';
  const used = c.inUse.filter((x) => x.threadIds.length);

  return (
    <Card>
      <h3>
        Claude Code
        <Chip tone={s.tone}>{s.text}</Chip>
      </h3>
      <Facts
        rows={[
          ['Installed', c.installedVersion],
          ['Newest', c.latestVersion],
          ['Where', c.path],
          ['Updated by', c.managedBy === 'cli' ? "Claude Code's own installer" : c.managedBy === 'threadbear' ? 'Threadbear' : 'Nothing, you update it by hand'],
          ['Last checked', c.checkedAt ? agoWords(Date.parse(c.checkedAt), now) : 'Not yet'],
          ['In use', used.length ? used.map((x) => `${x.version} by ${plural(x.threadIds.length, 'thread')}`).join(', ') : undefined],
        ]}
      />
      {c.hold && (
        <Note tone="warn">
          {c.hold.version} is held back: {c.hold.reason}.
        </Note>
      )}
      {u && <Note tone={u.tone}>{u.text}</Note>}
      {act.error && <Note tone="bad">{act.error}</Note>}

      <div className="ops-row">
        <button onClick={() => void call('check', 'clis.check', { provider: 'claude' })} disabled={act.busy !== undefined || snap.conn !== 'open'} title="Look for a newer version now">
          Check now
        </button>
        <button
          className="primary"
          onClick={() => void call('update', 'clis.update', { provider: 'claude' })}
          disabled={!canUpdate || c.status === 'held' || working || act.busy !== undefined}
          title={c.latestVersion ? `Update Claude Code to ${c.latestVersion}` : 'Update Claude Code'}
        >
          Update{c.latestVersion && c.status === 'behind' ? ` to ${c.latestVersion}` : ''}
        </button>
        {c.status === 'held' && (
          <button onClick={() => void call('force', 'clis.update', { provider: 'claude', force: true })} disabled={working || act.busy !== undefined} title="Install the held version even though it was held back">
            Install it anyway
          </button>
        )}
      </div>

      <div className="set-row">
        <div className="set-label">When a newer version comes out</div>
        <div className="set-control">
          <select value={c.policy} onChange={(e) => void call('policy', 'clis.setPolicy', { provider: 'claude', policy: e.target.value })} disabled={act.busy !== undefined} title="What the runner does about new versions">
            {POLICIES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <div className="ops-sub">{POLICIES.find((p) => p.id === c.policy)?.hint}</div>
        </div>
      </div>
    </Card>
  );
}
