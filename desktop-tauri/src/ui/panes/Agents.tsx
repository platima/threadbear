// The thread's sub-agents and background jobs, and a sub-agent's own
// transcript (threads.subagent).
import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mdComponents } from '../thread/mdComponents.tsx';
import type { PaneDef, PaneProps } from '../registry.ts';
import type { AppStore } from '../../core/store.ts';
import type { BackgroundTask, PersistedEvent, Subagent, ThreadSummary } from '../../core/types.ts';
import { ago } from '../../../../web/src/format.ts';
import { errorText } from '../pages-lib/runnerFiles.ts';
import './agents.css';

const plugins = [remarkGfm];

const running = (t: ThreadSummary): number =>
  (t.subagents ?? []).filter((s) => s.status === 'running').length + (t.background ?? []).filter((b) => !b.finished && (b.kind !== 'agent' || !t.subagents?.length)).length;

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function took(s: Subagent, now: number): string {
  const start = Date.parse(s.startedAt);
  if (Number.isNaN(start)) return '';
  if (s.status === 'running') return `running for ${elapsed(now - start)}`;
  const end = s.endedAt ? Date.parse(s.endedAt) : NaN;
  if (!Number.isNaN(end)) return `took ${elapsed(end - start)}`;
  const a = ago(start);
  return a === 'now' ? 'just started' : /^\d+[mhd]$/.test(a) ? `started ${a} ago` : `started ${a}`;
}

const STATUS: Record<Subagent['status'], string> = { running: 'Running', completed: 'Finished', failed: 'Failed', stopped: 'Stopped' };

// Roots first (the ones still running on top, then newest), each followed by
// the sub-agents it started.
function arrange(list: Subagent[]): { s: Subagent; depth: number }[] {
  const ids = new Set(list.map((s) => s.id));
  const kids = new Map<string, Subagent[]>();
  const roots: Subagent[] = [];
  for (const s of list) {
    if (s.parentId && ids.has(s.parentId)) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s]);
    else roots.push(s);
  }
  const rank = (s: Subagent) => (s.status === 'running' ? 0 : 1);
  const order = (a: Subagent, b: Subagent) => rank(a) - rank(b) || Date.parse(b.startedAt) - Date.parse(a.startedAt);
  const out: { s: Subagent; depth: number }[] = [];
  const walk = (s: Subagent, depth: number) => {
    out.push({ s, depth });
    for (const k of (kids.get(s.id) ?? []).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) walk(k, depth + 1);
  };
  for (const r of roots.sort(order)) walk(r, 0);
  return out;
}

function useNow(live: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

// ---- one sub-agent's transcript -----------------------------------------------

type Loaded = { key: string; events: PersistedEvent[]; subagent?: Subagent };

// Read again, at most every 300 ms, when the thread's record of it changes.
function useSubagentEvents(store: AppStore, threadId: string, id: string, signature: string, conn: string) {
  const key = `${threadId}/${id}`;
  const [data, setData] = useState<Loaded>();
  const [error, setError] = useState<{ key: string; message: string }>();
  const busy = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const first = useRef(true);

  useEffect(() => {
    first.current = true;
    return () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [key]);

  useEffect(() => {
    if (conn !== 'open' || timer.current) return;
    const load = async (): Promise<void> => {
      if (busy.current) {
        again.current = true;
        return;
      }
      busy.current = true;
      try {
        const r = await store.rpc.request<{ subagent?: Subagent; events: PersistedEvent[] }>('threads.subagent', { threadId, subagentId: id });
        setData({ key, events: r.events, subagent: r.subagent });
        setError(undefined);
      } catch (e) {
        const code = (e as { code?: number }).code;
        const message = code === -32006 ? 'There is no record of this sub-agent any more. The thread may be old, or Claude has cleaned it up.' : errorText(e, 'show a sub-agent’s work');
        setError({ key, message });
      } finally {
        busy.current = false;
        if (again.current) {
          again.current = false;
          void load();
        }
      }
    };
    timer.current = setTimeout(() => {
      timer.current = undefined;
      first.current = false;
      void load();
    }, first.current ? 0 : 300);
  }, [store, threadId, id, key, signature, conn]);

  return { data: data?.key === key ? data : undefined, error: error?.key === key ? error.message : undefined };
}

function oneLine(s: string, n = 140): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function Brief({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > 280 || text.split('\n').length > 5;
  return (
    <div className="ag-brief">
      <div className={`ag-brief-text ${all || !long ? '' : 'clamp'}`}>{text}</div>
      {long && (
        <button className="ghost" title={all ? 'Show less of the brief' : 'Show all of the brief'} onClick={() => setAll(!all)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

function ToolLine({ call, result }: { call: Extract<PersistedEvent, { type: 'tool.call' }>; result?: Extract<PersistedEvent, { type: 'tool.result' }> }) {
  const [open, setOpen] = useState(false);
  const bad = result && !result.ok;
  return (
    <div className={`ag-tool ${bad ? 'bad' : ''}`}>
      <button className="ag-toolhead" aria-expanded={open} disabled={!result?.text} title={open ? 'Hide the output' : result?.text ? 'Show what it printed' : 'No output yet'} onClick={() => setOpen(!open)}>
        <span className="ag-kind">{call.name}</span>
        <span className="ag-tooltitle">{oneLine(call.title)}</span>
        <span className="ag-mark">{!result ? '...' : result.ok ? '' : 'failed'}</span>
      </button>
      {open && result && (
        <pre className="ag-out" tabIndex={0}>
          {result.text.trimEnd()}
          {result.truncated ? '\n(The output was cut short.)' : ''}
        </pre>
      )}
    </div>
  );
}

function Events({ events }: { events: PersistedEvent[] }) {
  const results = useMemo(() => {
    const m = new Map<string, Extract<PersistedEvent, { type: 'tool.result' }>>();
    for (const e of events) if (e.type === 'tool.result') m.set(e.itemId, e);
    return m;
  }, [events]);
  const called = new Set<string>();
  for (const e of events) if (e.type === 'tool.call') called.add(e.itemId);
  const [thinking, setThinking] = useState<Set<number>>(new Set());
  return (
    <div className="ag-events">
      {events.map((e) => {
        switch (e.type) {
          case 'user.message':
            return <Brief key={e.seq} text={e.text} />;
          case 'assistant.text':
            return (
              <div key={e.seq} className="md ag-text">
                <Markdown remarkPlugins={plugins} components={mdComponents}>
                  {e.text}
                </Markdown>
              </div>
            );
          case 'reasoning':
            return (
              <button
                key={e.seq}
                className="ghost ag-think"
                aria-expanded={thinking.has(e.seq)}
                title={thinking.has(e.seq) ? 'Hide the agent’s thinking' : 'Show the agent’s thinking'}
                onClick={() =>
                  setThinking((s) => {
                    const n = new Set(s);
                    if (!n.delete(e.seq)) n.add(e.seq);
                    return n;
                  })
                }
              >
                {thinking.has(e.seq) ? e.text : oneLine(e.text, 100)}
              </button>
            );
          case 'tool.call':
            return <ToolLine key={e.seq} call={e} result={results.get(e.itemId)} />;
          case 'tool.result':
            if (called.has(e.itemId)) return null;
            return (
              <div key={e.seq} className="ag-tool">
                <div className="ag-toolhead static">
                  <span className="ag-kind">result</span>
                  <span className="ag-tooltitle">{oneLine(e.text)}</span>
                </div>
              </div>
            );
          case 'edit.diff': {
            let add = 0;
            let del = 0;
            for (const h of e.hunks) {
              for (const l of h.lines) {
                if (l.startsWith('+')) add++;
                else if (l.startsWith('-')) del++;
              }
            }
            return (
              <div key={e.seq} className="ag-tool">
                <div className="ag-toolhead static" title={e.path}>
                  <span className="ag-kind">edit</span>
                  <span className="ag-tooltitle">{e.path}</span>
                  <span className="ag-mark">
                    +{add} -{del}
                  </span>
                </div>
              </div>
            );
          }
          default:
            return null;
        }
      })}
    </div>
  );
}

function Detail({ store, snap, thread, id, back }: PaneProps & { id: string; back: () => void }) {
  const s = (thread.subagents ?? []).find((x) => x.id === id);
  const signature = s ? [s.status, s.toolUses, s.activity, s.summary, s.endedAt].join('|') : 'gone';
  const { data, error } = useSubagentEvents(store, thread.id, id, signature, snap.conn);
  const sub = s ?? data?.subagent;
  const now = useNow(sub?.status === 'running');
  const end = useRef<HTMLDivElement>(null);
  const near = useRef(true);
  const count = data?.events.length ?? 0;

  // Stay at the bottom while it works, unless the person has scrolled up.
  useEffect(() => {
    const scroller = end.current?.closest('.body');
    if (!scroller) return;
    const onScroll = () => {
      near.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    };
    scroller.addEventListener('scroll', onScroll);
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (near.current) end.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  return (
    <div className="ag">
      <div className="ag-detailhead">
        <button className="ghost" title="Back to the list of sub-agents" onClick={back}>
          ‹ Back
        </button>
      </div>
      {sub && (
        <div className="ag-summary">
          <div className="ag-name">{sub.description}</div>
          <div className="ag-sub">
            <span className={`ag-dot ${sub.status}`} /> {STATUS[sub.status]}
            {sub.agentType ? `, ${sub.agentType}` : ''}
            {sub.toolUses !== undefined ? `, ${sub.toolUses} ${sub.toolUses === 1 ? 'tool call' : 'tool calls'}` : ''}
            {`, ${took(sub, now)}`}
          </div>
          {sub.status === 'running' && sub.activity && <div className="ag-sub">Now: {sub.activity}</div>}
          {sub.summary && <div className="ag-sub">{sub.summary}</div>}
        </div>
      )}
      {error && <div className="ag-empty ag-bad">{error}</div>}
      {!data && !error && <div className="ag-empty">Loading...</div>}
      {data && (data.events.length ? <Events events={data.events} /> : <div className="ag-empty">It has not done anything yet.</div>)}
      <div ref={end} />
    </div>
  );
}

// ---- the list --------------------------------------------------------------------

const KIND: Record<BackgroundTask['kind'], string> = { agent: 'Sub-agent', shell: 'Shell job', monitor: 'Monitor', other: 'Background task' };

function List({ thread, open }: { thread: ThreadSummary; open: (id: string) => void }) {
  const subs = thread.subagents ?? [];
  const background = thread.background ?? [];
  const rows = useMemo(() => arrange(subs), [subs]);
  const now = useNow(subs.some((s) => s.status === 'running'));
  return (
    <div className="ag">
      {rows.length > 0 && (
        <section className="ag-sec">
          <h3>Sub-agents</h3>
          <ul className="ag-list">
            {rows.map(({ s, depth }) => (
              <li key={s.id} style={{ marginLeft: depth * 14 }}>
                <button className="ag-item" title={`Read what ${s.description} did`} onClick={() => open(s.id)}>
                  <span className="ag-line">
                    <span className={`ag-dot ${s.status}`} title={STATUS[s.status]} />
                    <span className="ag-name">{s.description}</span>
                  </span>
                  <span className="ag-sub">
                    {STATUS[s.status]}
                    {s.agentType ? `, ${s.agentType}` : ''}
                    {s.background ? ', in the background' : ''}
                    {s.toolUses ? `, ${s.toolUses} ${s.toolUses === 1 ? 'tool call' : 'tool calls'}` : ''}
                    {`, ${took(s, now)}`}
                  </span>
                  {s.status === 'running' && s.activity && <span className="ag-sub">{s.activity}</span>}
                  {s.status !== 'running' && s.summary && <span className="ag-sub ag-summaryline">{s.summary}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {background.length > 0 && (
        <section className="ag-sec">
          <h3>Background</h3>
          <ul className="ag-list">
            {background.map((b, i) => (
              <li key={i} className="ag-bg">
                <span className="ag-line">
                  <span className={`ag-dot ${b.finished ? 'completed' : 'running'}`} title={b.finished ? 'Finished' : 'Running'} />
                  <span className="ag-name">{b.description}</span>
                </span>
                <span className="ag-sub">
                  {KIND[b.kind]}, {b.finished ? 'just finished' : 'running'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!rows.length && !background.length && <div className="ag-empty">No sub-agents or background jobs.</div>}
    </div>
  );
}

function AgentsPane(props: PaneProps) {
  const { thread } = props;
  const [picked, setPicked] = useState<{ thread: string; id: string }>();
  const id = picked?.thread === thread.id ? picked.id : undefined;
  if (id) return <Detail {...props} id={id} back={() => setPicked(undefined)} />;
  return <List thread={thread} open={(sid) => setPicked({ thread: thread.id, id: sid })} />;
}

const pane: PaneDef = {
  id: 'agents',
  title: 'Agents',
  hint: 'The subagents and background jobs this thread has started, running or done',
  order: 30,
  available: (t) => Boolean(t.subagents?.length || t.background?.length),
  badge: (t) => running(t) || undefined,
  Pane: AgentsPane,
};
export default pane;
