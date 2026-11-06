// Schedules: messages sent at a set time, once or on a cron. The protocol's
// "Schedules" section (docs/protocol.md). A list of them, and a page for the one
// picked, where it can be paused, run now, edited or deleted.
import { useEffect, useMemo, useState } from 'react';
import type { PageDef, PageProps } from '../registry.ts';
import type { AppStore } from '../../core/store.ts';
import type { Schedule } from '../../core/types.ts';
import { ago, plain } from '../../../../web/src/format.ts';
import { Confirm, ErrorLine, Section, folderLabel, stamp, until } from '../pages-lib/bits.tsx';
import { NEW, explain, useAction, useLive, useSelection, type LiveList, type LiveState } from '../pages-lib/live.ts';
import './schedules.css';

function useSchedules(store: AppStore): [LiveState<Schedule>, LiveList<Schedule>] {
  return useLive<Schedule>(store, 'schedules', () => ({
    what: 'schedules',
    load: async () => (await store.rpc.request<{ schedules: Schedule[] }>('schedules.list', {})).schedules,
    notification: 'schedules.updated',
    pick: (p) => p?.schedules,
  }));
}

const nameOf = (s: Schedule) => s.title || plain(s.text).slice(0, 80) || 'Untitled schedule';

// What a row says on the right: when it next runs, or why it won't.
function stateOf(s: Schedule): { text: string; tone?: 'warn' | 'dim' } {
  if (s.finishedAt) return { text: 'Finished', tone: 'dim' };
  if (s.paused) return { text: 'Paused', tone: 'warn' };
  if (s.nextRunAt) return { text: until(Date.parse(s.nextRunAt)) };
  return { text: '' };
}

// ---- the next runs ------------------------------------------------------------------

type Preview = { whenText: string; runs: string[] };

// Asks the runner for the next times a cron or a one-off time would run, a
// moment after the last change. Null params clears it.
function usePreview(store: AppStore, params: Record<string, unknown> | null): { preview?: Preview; error?: string } {
  const key = JSON.stringify(params);
  const [out, setOut] = useState<{ preview?: Preview; error?: string }>({});
  useEffect(() => {
    if (!params) return setOut({});
    let off = false;
    const timer = setTimeout(() => {
      store.rpc
        .request<Preview>('schedules.preview', { ...params, count: 5 })
        .then((preview) => !off && setOut({ preview }))
        .catch((e) => !off && setOut({ error: explain(e, 'previews of the next runs') }));
    }, 300);
    return () => {
      off = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key]);
  return out;
}

function NextRuns({ out, timezone, once }: { out: { preview?: Preview; error?: string }; timezone?: string; once?: boolean }) {
  if (out.error) return <div className="pl-err"><span>{out.error}</span></div>;
  if (!out.preview) return <div className="pl-dim">Working out the next runs...</div>;
  const { whenText, runs } = out.preview;
  return (
    <div className="sc-runs">
      <div>{whenText}</div>
      {runs.length === 0 ? (
        <div className="pl-dim">{once ? 'That time has passed, so it would run straight away.' : 'It would not run again.'}</div>
      ) : (
        <ol title={timezone ? `Shown in ${timezone}` : 'Shown in this computer\'s time'}>
          {runs.map((r) => (
            <li key={r}>{stamp(r, timezone || undefined)}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---- the list column ----------------------------------------------------------------

function SchedulesSidebar({ store }: PageProps) {
  const [live] = useSchedules(store);
  const [sel, select] = useSelection('schedules');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = live.items.filter((s) => !q || [s.title, s.text, s.whenText].join('\n').toLowerCase().includes(q));

  return (
    <>
      <div className="side-top">
        <input placeholder="Search schedules" title="Search schedules by name or message" aria-label="Search schedules" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button title="Make a new schedule" onClick={() => select(NEW)}>
          New
        </button>
      </div>
      <div className="side-list">
        {live.error && !live.items.length && <div className="pl-none">{live.error}</div>}
        {!live.loaded && <div className="pl-none">Loading schedules...</div>}
        {live.loaded && !live.error && shown.length === 0 && <div className="pl-none">{q ? 'No schedules match.' : 'No schedules yet.'}</div>}
        {shown.map((s) => {
          const st = stateOf(s);
          const failed = s.lastRun?.outcome === 'failed';
          return (
            <div
              key={s.id}
              className={`pl-item${sel === s.id ? ' sel' : ''}${s.paused || s.finishedAt ? ' faded' : ''}`}
              role="button"
              tabIndex={0}
              title={`Open ${nameOf(s)}`}
              onClick={() => select(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  select(s.id);
                }
              }}
            >
              <div className="pl-itembody">
                <div className="pl-itemtitle">
                  <b>{nameOf(s)}</b>
                  <span className={st.tone === 'warn' ? 'sc-warn' : undefined}>{st.text}</span>
                </div>
                <div className="pl-itemsub">
                  {s.whenText}
                  {failed && <span className="sc-bad"> · last run failed</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---- the page --------------------------------------------------------------------------

function SchedulesMain(props: PageProps) {
  const { store } = props;
  const [live] = useSchedules(store);
  const [sel, select] = useSelection('schedules');

  if (sel === NEW) return <ScheduleForm key="new" {...props} onDone={(id) => select(id)} onCancel={() => select(undefined)} />;
  if (!sel) {
    return (
      <div className="pl-empty">
        <h2>Schedules</h2>
        <p>A schedule sends a message at a set time, once or over and over, to a thread or to a new one each time.</p>
        {live.error && !live.items.length ? <p className="error">{live.error}</p> : <button className="primary" title="Make a new schedule" onClick={() => select(NEW)}>New schedule</button>}
      </div>
    );
  }
  const schedule = live.items.find((s) => s.id === sel);
  if (!schedule) {
    return (
      <div className="pl-empty">
        {live.error ? <p className="error">{live.error}</p> : <p>{live.loaded ? 'That schedule is gone.' : 'Loading...'}</p>}
        {live.loaded && <button title="Go back to the schedule list" onClick={() => select(undefined)}>Close</button>}
      </div>
    );
  }
  return <ScheduleView key={schedule.id} {...props} schedule={schedule} />;
}

type Note = { text: string; threadId?: string };

function ScheduleView({ store, snap, openThread, schedule: s }: PageProps & { schedule: Schedule }) {
  const [, list] = useSchedules(store);
  const [, select] = useSelection('schedules');
  const { run, error, busy, clear } = useAction('schedules');
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<Note | undefined>();

  const put = (next: Schedule) => list.change((items) => items.map((x) => (x.id === next.id ? next : x)));

  const toggle = async () => {
    setNote(undefined);
    const r = await run(() => store.rpc.request<{ schedule: Schedule }>('schedules.update', { scheduleId: s.id, paused: !s.paused }));
    if (r) put(r.schedule);
  };
  const runNow = async () => {
    setNote(undefined);
    const r = await run(() => store.rpc.request<{ schedule: Schedule; threadId?: string; queued?: boolean }>('schedules.run', { scheduleId: s.id }));
    if (!r) return;
    put(r.schedule);
    setNote(r.queued ? { text: 'Asked. The runner it belongs to will send it when it next hears.' } : r.threadId ? { text: 'Sent.', threadId: r.threadId } : { text: 'Sent.' });
  };
  const remove = async () => {
    const r = await run(async () => {
      await store.rpc.request('schedules.delete', { scheduleId: s.id });
      return true;
    });
    if (!r) return;
    list.change((items) => items.filter((x) => x.id !== s.id));
    select(undefined);
  };

  const cronNext = s.cron && !s.paused && !s.finishedAt ? { cron: s.cron, ...(s.timezone ? { timezone: s.timezone } : {}) } : null;
  const out = usePreview(store, editing ? null : cronNext);
  const target = s.threadId ? snap.threads.get(s.threadId) : undefined;
  const st = stateOf(s);
  const settings = [s.accountId && `login ${s.accountId}`, s.poolId && `pool ${s.poolId}`, s.model, s.effort, s.permissionMode].filter(Boolean).join(', ');

  if (editing) {
    return <ScheduleForm store={store} snap={snap} openThread={openThread} initial={s} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />;
  }

  return (
    <div className="page">
      <div className="pl-inner">
        <div className="sc-head">
          <div className="grow">
            <h2>{nameOf(s)}</h2>
            <div className="pl-dim sc-sub">
              {s.cron ? 'Repeats' : 'Once'}
              {s.runnerName ? ` · on ${s.runnerName}` : ''}
              {s.createdBy ? ` · made by ${s.createdBy === 'mike' ? 'you' : 'a thread'}` : ''}
            </div>
          </div>
          {s.finishedAt && <span className="chip" title="A one-off that has run">Finished</span>}
          {s.paused && !s.finishedAt && <span className="chip warn" title="It will not run until resumed">Paused</span>}
        </div>

        <div className="pl-actions">
          {!s.finishedAt && (
            <button disabled={busy} title={s.paused ? 'Let it run at its time again' : 'Stop it running until resumed'} onClick={() => void toggle()}>
              {s.paused ? 'Resume' : 'Pause'}
            </button>
          )}
          <button disabled={busy} title="Send the message now, as if it were due" onClick={() => void runNow()}>
            Run now
          </button>
          <button disabled={busy} title="Change the message or the time" onClick={() => setEditing(true)}>
            Edit
          </button>
          <Confirm danger label="Delete" tip="Delete this schedule" question="Delete this schedule?" yes="Yes, delete" onConfirm={() => void remove()} />
        </div>

        <ErrorLine text={error} onClear={clear} />
        {note && (
          <div className="pl-ok" role="status">
            <span>{note.text}</span>
            {note.threadId && (
              <button title="Open the thread it went to" onClick={() => openThread(note.threadId!)}>
                Open thread
              </button>
            )}
            <button className="ghost" title="Hide this message" onClick={() => setNote(undefined)}>
              Hide
            </button>
          </div>
        )}

        <Section title="Message">
          <div className="bubble sc-text">{s.text}</div>
        </Section>

        <Section title="When">
          <div>{s.whenText}</div>
          {s.cron && (
            <div className="pl-dim sc-sub">
              <code>{s.cron}</code> in {s.timezone ?? 'the runner\'s own time zone'}
            </div>
          )}
          {s.at && !s.nextRunAt && <div className="pl-dim sc-sub">{stamp(s.at)}</div>}
          <div className="sc-next">
            {s.finishedAt ? (
              <span className="pl-dim">Ran on {stamp(s.finishedAt)}. Edit the time to run it again.</span>
            ) : s.paused ? (
              <span className="pl-dim">Paused, so no next run.</span>
            ) : s.nextRunAt ? (
              <span title={new Date(s.nextRunAt).toLocaleString()}>
                Next run {stamp(s.nextRunAt, s.timezone)} ({st.text})
              </span>
            ) : null}
          </div>
          {cronNext && <NextRuns out={out} timezone={s.timezone} />}
        </Section>

        <Section title="Sends to">
          {s.threadId ? (
            <div className="sc-line">
              <span>{target ? target.title || 'New thread' : `Thread ${s.threadId.slice(0, 8)}`}</span>
              <button title="Open that thread" onClick={() => openThread(s.threadId!)}>
                Open thread
              </button>
            </div>
          ) : (
            <>
              <div>A new thread each time{s.cwd ? ` in ${folderLabel(s.cwd)}` : ', in the default folder'}.</div>
              {s.cwd && <code className="sc-path" title={s.cwd}>{s.cwd}</code>}
              {settings && <div className="pl-dim sc-sub">{settings}</div>}
            </>
          )}
        </Section>

        <Section title="History">
          <div>{s.runs === 0 ? 'Has not run yet.' : `Has run ${s.runs} time${s.runs === 1 ? '' : 's'}.`}</div>
          {s.lastRun && (
            <div className={s.lastRun.outcome === 'failed' ? 'sc-bad' : undefined}>
              Last run {ago(Date.parse(s.lastRun.at))}
              {ago(Date.parse(s.lastRun.at)) === 'now' ? '' : ' ago'}: {s.lastRun.outcome}
              {s.lastRun.note ? `. ${s.lastRun.note}` : ''}
              {s.lastRun.threadId && (
                <>
                  {' '}
                  <button className="ghost" title="Open the thread that run made" onClick={() => openThread(s.lastRun!.threadId!)}>
                    Open thread
                  </button>
                </>
              )}
            </div>
          )}
          <div className="pl-dim sc-sub">Made {stamp(s.createdAt)}.</div>
        </Section>
      </div>
    </div>
  );
}

// ---- making and editing -----------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
const toInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toIso = (v: string): string | undefined => {
  const d = new Date(v);
  return v && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
};

const PRESETS: { label: string; cron: string }[] = [
  { label: 'Every day at 9:00', cron: '0 9 * * *' },
  { label: 'Weekdays at 9:00', cron: '0 9 * * 1-5' },
  { label: 'Mondays at 9:00', cron: '0 9 * * 1' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
];

function tomorrowNine(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return toInput(d);
}

const zones: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
})();

function ScheduleForm({ store, snap, initial, onDone, onCancel }: PageProps & { initial?: Schedule; onDone: (id?: string) => void; onCancel: () => void }) {
  const [, list] = useSchedules(store);
  const { run, error, busy, clear } = useAction('schedules');
  const editing = Boolean(initial);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [text, setText] = useState(initial?.text ?? '');
  const [kind, setKind] = useState<'at' | 'cron'>(initial ? (initial.cron ? 'cron' : 'at') : 'at');
  const [cron, setCron] = useState(initial?.cron ?? '0 9 * * 1-5');
  const [at, setAt] = useState(initial?.at ? toInput(new Date(initial.at)) : tomorrowNine());
  const [timezone, setTimezone] = useState(initial?.timezone ?? '');
  const [toThread, setToThread] = useState(Boolean(initial?.threadId));
  const [threadId, setThreadId] = useState(initial?.threadId ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? snap.hello?.defaults.cwd ?? '');
  const [paused, setPaused] = useState(false);

  const threads = useMemo(() => [...snap.threads.values()].filter((t) => !t.archivedAt).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)), [snap.threads]);

  const atIso = toIso(at);
  const params = kind === 'cron' ? (cron.trim() ? { cron: cron.trim(), ...(timezone.trim() ? { timezone: timezone.trim() } : {}) } : null) : atIso ? { at: atIso } : null;
  const out = usePreview(store, params);

  const sendsToThread = editing ? Boolean(initial?.threadId) : toThread;
  const ready = text.trim() !== '' && params !== null && (!sendsToThread || threadId !== '') && !busy;

  const save = async () => {
    if (!ready) return;
    if (!initial) {
      const r = await run(() =>
        store.rpc.request<{ schedule: Schedule }>('schedules.create', {
          text: text.trim(),
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(kind === 'cron' ? { cron: cron.trim(), ...(timezone.trim() ? { timezone: timezone.trim() } : {}) } : { at: atIso }),
          ...(toThread ? { threadId } : cwd.trim() ? { cwd: cwd.trim() } : {}),
          ...(paused ? { paused: true } : {}),
        }),
      );
      if (!r) return;
      list.change((items) => (items.some((x) => x.id === r.schedule.id) ? items : [...items, r.schedule]));
      onDone(r.schedule.id);
      return;
    }
    // Only what changed: sending a time again would restart a finished one-off.
    const patch: Record<string, unknown> = {};
    if (title.trim() && title.trim() !== initial.title) patch.title = title.trim();
    if (text.trim() !== initial.text) patch.text = text.trim();
    if (kind === 'cron') {
      if (cron.trim() !== initial.cron) patch.cron = cron.trim();
      if (timezone.trim() !== (initial.timezone ?? '')) patch.timezone = timezone.trim() || null;
    } else if (!initial.at || !atIso || Date.parse(atIso) !== Date.parse(initial.at)) {
      patch.at = atIso;
    }
    if (!initial.threadId && cwd.trim() !== (initial.cwd ?? '') && cwd.trim()) patch.cwd = cwd.trim();
    if (Object.keys(patch).length === 0) return onDone();
    const r = await run(() => store.rpc.request<{ schedule: Schedule }>('schedules.update', { scheduleId: initial.id, ...patch }));
    if (!r) return;
    list.change((items) => items.map((x) => (x.id === r.schedule.id ? r.schedule : x)));
    onDone(initial.id);
  };

  return (
    <div className="page">
      <div className="pl-inner">
        <h2>{editing ? 'Edit schedule' : 'New schedule'}</h2>
        <ErrorLine text={error} onClear={clear} />

        <Section title="Message">
          <textarea
            className="sc-wide"
            rows={5}
            autoFocus
            value={text}
            placeholder="What to send, as if you had typed it"
            title="The message the agent receives each time"
            aria-label="Message"
            onChange={(e) => setText(e.target.value)}
          />
        </Section>

        <Section title="Name">
          <input className="sc-wide" value={title} placeholder="Optional. The start of the message is used if left out." title="A short name for the list" aria-label="Name" onChange={(e) => setTitle(e.target.value)} />
        </Section>

        <Section title="When">
          <div className="sc-kind" role="radiogroup" aria-label="Once or repeating">
            <label title="Run one time, at a set date and time">
              <input type="radio" name="kind" checked={kind === 'at'} onChange={() => setKind('at')} /> Once
            </label>
            <label title="Run over and over, on a cron pattern">
              <input type="radio" name="kind" checked={kind === 'cron'} onChange={() => setKind('cron')} /> Repeating
            </label>
          </div>
          {kind === 'at' ? (
            <input type="datetime-local" value={at} title="The date and time to send it, in this computer's time" aria-label="Date and time" onChange={(e) => setAt(e.target.value)} />
          ) : (
            <div className="sc-cron">
              <input
                className="sc-mono"
                value={cron}
                placeholder="0 9 * * 1-5"
                title="Five fields: minute, hour, day of month, month, day of week"
                aria-label="Cron pattern"
                spellCheck={false}
                onChange={(e) => setCron(e.target.value)}
              />
              <div className="sc-presets">
                {PRESETS.map((p) => (
                  <button key={p.cron} className="ghost" title={`Use ${p.cron}`} onClick={() => setCron(p.cron)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="pl-dim sc-sub">Five fields: minute, hour, day of month, month and day of week.</div>
              <input
                className="sc-zone"
                list="sc-zones"
                value={timezone}
                placeholder="Time zone, such as Australia/Perth (optional)"
                title="The time zone the pattern is read in. Left empty it uses the runner's own."
                aria-label="Time zone"
                onChange={(e) => setTimezone(e.target.value)}
              />
              <datalist id="sc-zones">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </div>
          )}
          <div className="sc-preview">
            {params ? <NextRuns out={out} timezone={kind === 'cron' ? timezone.trim() : undefined} once={kind === 'at'} /> : <div className="pl-dim">{kind === 'cron' ? 'Write a cron pattern to see when it runs.' : 'Pick a date and time.'}</div>}
          </div>
        </Section>

        <Section title="Sends to">
          {editing ? (
            initial?.threadId ? (
              <div className="pl-dim">An existing thread. A schedule cannot be moved to another thread, so make a new one for that.</div>
            ) : (
              <input className="sc-wide" value={cwd} placeholder="Folder for each new thread" title="The folder each new thread starts in" aria-label="Folder" onChange={(e) => setCwd(e.target.value)} />
            )
          ) : (
            <>
              <div className="sc-kind" role="radiogroup" aria-label="Where it goes">
                <label title="Start a new thread each time it runs">
                  <input type="radio" name="target" checked={!toThread} onChange={() => setToThread(false)} /> A new thread each time
                </label>
                <label title="Send to a thread that already exists">
                  <input type="radio" name="target" checked={toThread} onChange={() => setToThread(true)} /> An existing thread
                </label>
              </div>
              {toThread ? (
                <select className="sc-wide" value={threadId} title="The thread to send the message to" aria-label="Thread" onChange={(e) => setThreadId(e.target.value)}>
                  <option value="">Pick a thread...</option>
                  {threads.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title || 'New thread'}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="sc-wide" value={cwd} placeholder="Folder for each new thread (the default if left empty)" title="The folder each new thread starts in" aria-label="Folder" onChange={(e) => setCwd(e.target.value)} />
              )}
            </>
          )}
        </Section>

        {!editing && (
          <label className="sc-check" title="Make it, but do not let it run until resumed">
            <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} /> Start paused
          </label>
        )}

        <div className="pl-actions">
          <button className="primary" disabled={!ready} title={editing ? 'Save the changes' : 'Make the schedule'} onClick={() => void save()}>
            {busy ? 'Saving...' : editing ? 'Save' : 'Make schedule'}
          </button>
          <button disabled={busy} title="Leave without saving" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const def: PageDef = {
  id: 'schedules',
  title: 'Schedules',
  icon: '◷',
  order: 20,
  Sidebar: SchedulesSidebar,
  Main: SchedulesMain,
};
export default def;
