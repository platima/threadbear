import { useState } from 'react';
import type { PageDef, PageProps } from '../registry.ts';
import type { AppStore, Snapshot } from '../../core/store.ts';
import { agoWords, bytesWords, folderName, plural, spanWords, whenWords } from '../pages-lib/ops-format.ts';
import { useAction, useNotification, useNow, useRequest } from '../pages-lib/ops-rpc.ts';
import type { MachineStats, RemoteRunner, RemoteThread, RemoteThreads, RunnerInfo, RunnerStatus, RunnerUpdateState } from '../pages-lib/ops-types.ts';
import { Card, Chip, ConfirmBar, Facts, Meter, Note, Problem, type Tone } from '../pages-lib/ops-ui.tsx';
import './runners.css';

const POLL_MS = 15_000;

// What the runner's own update is doing, in a sentence.
function updateWords(state: RunnerUpdateState, reason?: string, commit?: string): { text: string; tone?: Tone } {
  switch (state) {
    case 'off':
      return { text: reason ? `Not following main: ${reason.replace(/[.]$/, '')}.` : 'Not following main.' };
    case 'idle':
      return { text: 'Following main. Nothing newer yet.' };
    case 'checking':
      return { text: 'Checking main for a newer version.' };
    case 'building':
      return { text: `Building a newer version${commit ? ` (${commit})` : ''}.` };
    case 'waiting':
      return { text: `A newer version${commit ? ` (${commit})` : ''} is built and starts at the next restart.`, tone: 'ok' };
    case 'failed':
      return { text: `The last build failed${reason ? `: ${reason.replace(/[.]$/, '')}` : ''}.`, tone: 'bad' };
  }
}

function MachineMeters({ s, now }: { s: MachineStats; now: number }) {
  const memPct = s.memTotal > 0 ? (s.memUsed / s.memTotal) * 100 : 0;
  const diskPct = s.diskTotal > 0 ? ((s.diskTotal - s.diskFree) / s.diskTotal) * 100 : 0;
  const tone = (p: number): Tone => (p >= 90 ? 'bad' : p >= 75 ? 'warn' : undefined);
  const old = now - Date.parse(s.at) > 60_000;
  return (
    <>
      <div className="ops-meters">
        <Meter label="Processor" value={`${Math.round(s.cpuPercent)}%`} percent={s.cpuPercent} tone={tone(s.cpuPercent)} sub={`${plural(s.cores, 'core')}${s.load1 !== undefined ? `, load ${s.load1}` : ''}`} />
        <Meter label="Memory" value={`${bytesWords(s.memUsed)} of ${bytesWords(s.memTotal)}`} percent={memPct} tone={tone(memPct)} />
        <Meter label="Disk" value={`${bytesWords(s.diskFree)} free of ${bytesWords(s.diskTotal)}`} percent={diskPct} tone={tone(diskPct)} />
      </div>
      <Note>
        {[s.machine, s.os].filter(Boolean).join(', ')}
        {s.machine || s.os ? '. ' : ''}Machine up for {spanWords(s.uptimeSec * 1000)}.{old ? ` These figures are from ${agoWords(Date.parse(s.at), now)}, when it last reported.` : ''}
      </Note>
    </>
  );
}

function titleOf(snap: Snapshot, id: string): string {
  return snap.threads.get(id)?.title ?? `thread ${id.slice(0, 8)}`;
}

function ThisRunner({ store, snap, status, info, stats, now }: { store: AppStore; snap: Snapshot; status: ReturnType<typeof useRequest<RunnerStatus>>; info?: RunnerInfo; stats?: MachineStats; now: number }) {
  const [updates, setUpdates] = useState(() => (snap.hello as { updates?: { state: RunnerUpdateState; reason?: string; commit?: string; subject?: string } } | undefined)?.updates);
  useNotification(store, 'runner.updates', (p: { updates: typeof updates }) => setUpdates(p.updates));
  const act = useAction();
  const [asking, setAsking] = useState(false);
  const [said, setSaid] = useState<string>();
  const s = status.data;

  const restart = async () => {
    setAsking(false);
    const r = await act.run('restart', () => store.rpc.request<{ scheduled: boolean; waitingFor: string[]; note?: string }>('runner.restart', { when: 'idle', reason: 'Restarted from the desktop app' }));
    if (r) {
      setSaid(r.waitingFor.length ? `Restart is waiting for ${plural(r.waitingFor.length, 'thread')} to finish.` : r.scheduled ? 'Restarting now. The app reconnects by itself.' : (r.note ?? 'Nothing was scheduled.'));
      void status.reload();
    }
  };
  const cancel = async () => {
    const r = await act.run('cancel', () => store.rpc.request<{ scheduled: boolean; note?: string }>('runner.restart', { cancel: true }));
    if (r) {
      setSaid(r.note ?? 'The restart was cancelled.');
      void status.reload();
    }
  };

  const upd = s?.update ?? updates;
  const u = upd ? updateWords(upd.state, upd.reason, upd.commit) : undefined;
  const subject = updates && 'subject' in updates ? updates.subject : undefined;
  const pending = s?.pendingRestart;
  const working = s?.running ?? [];
  const bg = s?.background ?? [];

  return (
    <Card>
      <h3>
        <span className="ops-dot ok" title="This runner is answering" />
        {info?.name ?? 'This runner'}
        <Chip>This one</Chip>
        <span className="ops-spacer" />
        <button onClick={() => setAsking(true)} disabled={asking || !!pending || snap.conn !== 'open' || act.busy === 'restart'} title="Restart the runner once no thread is busy">
          Restart when idle
        </button>
      </h3>

      {asking && (
        <ConfirmBar
          text="Restart the runner? It waits until no thread is busy, then restarts. Threads that are working finish first, and this window reconnects by itself."
          yes="Restart when idle"
          onYes={() => void restart()}
          onNo={() => setAsking(false)}
        />
      )}
      {pending && (
        <div className="ops-confirm">
          <span>
            A restart is waiting{pending.waitingFor.length ? ` for ${pending.waitingFor.length <= 3 ? pending.waitingFor.map((id) => titleOf(snap, id)).join(', ') : plural(pending.waitingFor.length, 'thread')}` : ''}. Asked {agoWords(Date.parse(pending.requestedAt), now)}
            {pending.reason ? `: ${pending.reason}` : '.'}
          </span>
          <button onClick={() => void cancel()} disabled={act.busy === 'cancel'} title="Withdraw the restart if it hasn't begun">
            Cancel the restart
          </button>
        </div>
      )}
      {said && <Note tone="ok">{said}</Note>}
      {act.error && <Note tone="bad">{act.error}</Note>}
      <Problem error={status.error} what="The runner's status" />
      {s?.rolledBack && <Note tone="warn">This version is running because the newer one ({s.rolledBack.from}) kept failing to start.</Note>}

      <Facts
        rows={[
          ['Version', s?.version ?? info?.version ?? snap.hello?.runnerVersion],
          ['Branch', s?.branch],
          ['Running for', s ? `${spanWords(now - Date.parse(s.startedAt))}, since ${whenWords(s.startedAt)}` : undefined],
          ['Process id', s ? String(s.pid) : undefined],
          ['Threads working', s ? (working.length ? <ul className="ops-list">{working.map((id) => <li key={id}>{titleOf(snap, id)}</li>)}</ul> : 'None') : undefined, true],
          ['Sessions open', s ? plural(s.liveClis, 'session') : undefined],
          ['Background', s ? (bg.length ? <ul className="ops-list">{bg.map((b) => <li key={b.threadId}>{titleOf(snap, b.threadId)}: {b.tasks.join(', ')}</li>)}</ul> : 'None') : undefined, true],
          ['Sync', s?.sync ? `${s.sync.state}${s.sync.reason ? `: ${s.sync.reason}` : ''}` : undefined],
          ['Data folder', s?.home, true],
          ['Log file', s?.logFile, true],
        ]}
      />
      {u && (
        <Note tone={u.tone}>
          {u.text}
          {subject ? ` Latest change: ${subject.replace(/[.]$/, '')}.` : ''}
        </Note>
      )}
      {s?.draining?.length ? <Note>{plural(s.draining.length, 'older runner')} still finishing {s.draining.reduce((n, d) => n + d.threads.length, 0) === 1 ? 'a thread' : 'threads'} after a handover.</Note> : null}

      {stats ? <MachineMeters s={stats} now={now} /> : <Note>No machine figures for this runner. The runner only has them through the sync backend.</Note>}
    </Card>
  );
}

const statusWords: Record<string, string> = { running: 'Working', starting: 'Starting', waiting: 'Waiting on you', error: 'Stopped with an error', stopped: 'Stopped', idle: 'Idle' };

function dotTone(t: RemoteThread): string {
  if (t.needsYou || t.status === 'waiting') return 'warn';
  if (t.status === 'running' || t.status === 'starting') return 'ok';
  if (t.status === 'error') return 'bad';
  if (t.unread) return 'accent';
  return '';
}

function RemoteRows({ threads, now }: { threads: RemoteThread[]; now: number }) {
  const [all, setAll] = useState(false);
  const live = threads.filter((t) => !t.archivedAt).sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  const archived = threads.length - live.length;
  const shown = all ? live : live.slice(0, 8);
  if (!live.length) return <Note>No threads here{archived ? `, only ${plural(archived, 'archived one')}` : ''}.</Note>;
  return (
    <div className="runners-threads">
      {shown.map((t) => (
        <div className="runners-thread" key={t.threadId} title={t.preview || t.title}>
          <span className={`ops-dot ${dotTone(t)}`} />
          <div className="runners-thread-body">
            <div className="runners-thread-title">{t.title || 'Untitled'}</div>
            <div className="ops-sub">
              {[statusWords[t.status] ?? t.status, t.needsYou ? 'Needs you' : undefined, folderName(t.cwd), t.snoozedUntil ? `hibernating until ${whenWords(t.snoozedUntil)}` : undefined].filter(Boolean).join(' · ')}
            </div>
          </div>
          <span className="ops-sub">{agoWords(Date.parse(t.lastActivityAt), now)}</span>
        </div>
      ))}
      {live.length > 8 && (
        <button className="ghost" onClick={() => setAll(!all)} title={all ? 'Show fewer threads' : `Show all ${live.length} threads`}>
          {all ? 'Show fewer' : `Show all ${live.length}`}
        </button>
      )}
      {archived > 0 && <Note>And {plural(archived, 'archived thread')}, not shown.</Note>}
    </div>
  );
}

type Other = { id: string; name: string; online: boolean; lastSeenAt?: string; version?: string; release?: string; startedAt?: string; draining?: boolean; reachable?: boolean };

function OtherRunner({ r, stats, threads, now, remoteKnown }: { r: Other; stats?: MachineStats; threads: RemoteThread[]; now: number; remoteKnown: boolean }) {
  return (
    <Card className={r.online ? '' : 'dim'}>
      <h3>
        <span className={`ops-dot ${r.online ? 'ok' : ''}`} title={r.online ? 'Heard from in the last 3 minutes' : 'Not heard from in the last 3 minutes'} />
        {r.name}
        <Chip tone={r.online ? 'ok' : undefined}>{r.online ? 'Online' : 'Offline'}</Chip>
        {r.draining && <Chip>Finishing threads</Chip>}
      </h3>
      <Facts
        rows={[
          ['Version', r.version],
          ['Running for', r.startedAt && r.online ? `${spanWords(now - Date.parse(r.startedAt))}, since ${whenWords(r.startedAt)}` : undefined],
          ['Last heard from', r.lastSeenAt ? (r.online ? 'Just now' : agoWords(Date.parse(r.lastSeenAt), now)) : undefined],
          ['Opening threads', r.reachable === undefined ? undefined : r.reachable ? 'Set up on this machine' : "Not set up here yet, so they can be listed but not opened"],
        ]}
      />
      {stats && r.online ? <MachineMeters s={stats} now={now} /> : null}
      <h4>Threads</h4>
      {remoteKnown ? <RemoteRows threads={threads} now={now} /> : <Note>Not available from this runner.</Note>}
    </Card>
  );
}

function RunnersPage({ store, snap }: PageProps) {
  const now = useNow(15_000);
  const status = useRequest<RunnerStatus>(store, snap.conn, 'runner.status', {}, POLL_MS);
  const list = useRequest<{ runners: RunnerInfo[] }>(store, snap.conn, 'runners.list', {}, POLL_MS);
  // Asked while this page is showing, every 15 seconds; the runner only
  // reports a machine's figures to someone who is asking.
  const stats = useRequest<{ stats: MachineStats[] }>(store, snap.conn, 'runners.stats', {}, POLL_MS);
  const remote = useRequest<RemoteThreads>(store, snap.conn, 'remoteThreads.list', {});
  useNotification(store, 'remoteThreads.updated', (p: RemoteThreads) => remote.setData(p));

  const runners = list.data?.runners ?? [];
  const self = runners.find((r) => r.self);
  const figures = stats.data?.stats ?? [];
  const remoteRunners: RemoteRunner[] = remote.data?.runners ?? [];
  const others: Other[] = runners
    .filter((r) => !r.self)
    .map((r) => ({ id: r.id, name: r.name, online: r.online, lastSeenAt: r.lastSeenAt, version: r.version, startedAt: r.startedAt, draining: r.draining }));
  for (const r of remoteRunners) if (!others.some((o) => o.id === r.id) && r.id !== self?.id) others.push({ id: r.id, name: r.name, online: r.online, lastSeenAt: r.lastSeenAt });
  for (const o of others) {
    const rr = remoteRunners.find((r) => r.id === o.id);
    if (rr) o.reachable = !!rr.tokenFile && !!rr.rpcUrl;
  }
  others.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));

  return (
    <div className="page ops runners">
      <div className="ops-col">
        <div className="ops-title">
          <h2>Runners</h2>
          <button
            onClick={() => {
              void status.reload();
              void list.reload();
              void stats.reload();
            }}
            disabled={snap.conn !== 'open'}
            title="Ask again now"
          >
            Refresh
          </button>
        </div>
        <ThisRunner store={store} snap={snap} status={status} info={self} stats={self ? figures.find((s) => s.runnerId === self.id) : undefined} now={now} />
        <Problem error={list.error} what="The list of runners" />
        <Problem error={stats.error} what="Machine figures" />
        {others.length === 0 && !list.error && !remote.error && <Note>No other runners have reported in. Other machines running Threadbear show here when sync is on.</Note>}
        {others.map((o) => (
          <OtherRunner key={o.id} r={o} stats={figures.find((s) => s.runnerId === o.id)} threads={(remote.data?.threads ?? []).filter((t) => t.runnerId === o.id)} now={now} remoteKnown={!remote.error} />
        ))}
        <Problem error={remote.error} what="Other runners' threads" />
      </div>
    </div>
  );
}

const page: PageDef = { id: 'runners', title: 'Runners', hint: 'The machines that run Threadbear for you, whether each is connected, and what is on each', icon: '▣', order: 60, Main: RunnersPage };
export default page;
