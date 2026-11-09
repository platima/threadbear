// A thread's patches: action chips, panels, hooks, and the patch files waiting
// to be trusted (docs/protocol.md, "Patches").
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { PaneDef, PaneProps } from '../registry.ts';
import type { AppStore } from '../../core/store.ts';
import type { Action, Hook, ImageRef, PanelItem, PatchInfo, PersistedEvent, ThreadSummary } from '../../core/types.ts';
import { Chev, FilePreview } from '../pages-lib/filePreview.tsx';
import { baseName, relativeTo } from '../pages-lib/pathStyle.ts';
import { errorText, useRunnerFile } from '../pages-lib/runnerFiles.ts';
import './actions.css';

const webUrl = (u?: string): string | undefined => (u && /^https?:\/\//i.test(u) ? u : undefined);
const hostOf = (u: string): string => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

// ---- running an action ------------------------------------------------------

type RunInfo = {
  status: 'running' | 'done' | 'error';
  startedAt: number;
  ok?: boolean;
  exitCode?: number;
  durationMs?: number;
  output?: string;
  truncated?: boolean;
  sent?: boolean; // a prompt action: the prompt went to the thread
  message?: string;
};

// Kept outside the pane, so a run that is going when the tab is closed is
// still there when it is opened again.
const runs = new Map<string, RunInfo>();
const runListeners = new Set<() => void>();
let runVersion = 0;
const setRun = (key: string, info: RunInfo): void => {
  runs.set(key, info);
  runVersion++;
  for (const l of runListeners) l();
};
const subscribeRuns = (l: () => void): (() => void) => {
  runListeners.add(l);
  return () => runListeners.delete(l);
};

async function runAction(store: AppStore, threadId: string, a: Action): Promise<void> {
  const key = `${threadId}/${a.id}`;
  if (runs.get(key)?.status === 'running') return;
  const startedAt = Date.now();
  setRun(key, { status: 'running', startedAt });
  try {
    const res = await store.rpc.request<{ ok?: boolean; exitCode?: number; durationMs?: number; seq?: number; turnId?: string }>('actions.run', { threadId, actionId: a.id });
    if (a.kind === 'prompt') {
      setRun(key, { status: 'done', startedAt, ok: true, sent: true });
      return;
    }
    let output: string | undefined;
    let truncated = false;
    if (typeof res.seq === 'number') {
      // The output went into the transcript as an action.run event.
      try {
        const page = await store.rpc.request<{ events: PersistedEvent[] }>('threads.events', { threadId, afterSeq: res.seq - 1, limit: 1 });
        const ev = page.events.find((e) => e.seq === res.seq);
        if (ev && ev.type === 'action.run') {
          output = ev.text;
          truncated = ev.truncated;
        }
      } catch {
        // The result still shows without the output.
      }
    }
    setRun(key, { status: 'done', startedAt, ok: res.ok, exitCode: res.exitCode, durationMs: res.durationMs, output, truncated });
  } catch (e) {
    const code = (e as { code?: number }).code;
    setRun(key, { status: 'error', startedAt, message: code === -32020 ? 'This is already running.' : errorText(e, 'run actions') });
  }
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  return <>{seconds(now - since)}</>;
}

function seconds(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
}

// ---- action rows --------------------------------------------------------------

function RunResult({ info }: { info: RunInfo }) {
  if (info.status === 'running') {
    return (
      <div className="ac-result">
        <span className="ac-dot run" /> Running, <Elapsed since={info.startedAt} />
      </div>
    );
  }
  if (info.status === 'error') {
    return <div className="ac-result ac-bad">{info.message}</div>;
  }
  if (info.sent) return <div className="ac-result">Sent to the thread.</div>;
  const took = info.durationMs !== undefined ? ` in ${seconds(info.durationMs)}` : '';
  return (
    <div className="ac-result">
      <div className={info.ok ? 'ac-good' : 'ac-bad'}>
        {info.ok ? 'Finished' : `Failed${info.exitCode !== undefined ? ` (exit code ${info.exitCode})` : ''}`}
        {took}
      </div>
      {info.output && (
        <pre className="ac-out" tabIndex={0}>
          {info.output.trimEnd()}
          {info.truncated ? '\n(The output was cut short.)' : ''}
        </pre>
      )}
    </div>
  );
}

function ActionRow({ store, thread, a }: { store: AppStore; thread: ThreadSummary; a: Action }) {
  useSyncExternalStore(subscribeRuns, () => runVersion);
  const info = runs.get(`${thread.id}/${a.id}`);
  const running = info?.status === 'running';
  const url = webUrl(a.url);
  const tip = [a.note, a.command ? `Runs: ${a.command}` : undefined, a.prompt ? `Sends: ${a.prompt}` : undefined, a.url].filter(Boolean).join('\n');
  const detail = a.kind === 'command' ? a.command : a.kind === 'prompt' ? a.prompt : a.url ? hostOf(a.url) : undefined;
  const label = (
    <>
      {a.title}
      {a.badge ? <span className="ac-count">{a.badge}</span> : null}
    </>
  );
  return (
    <li className="ac-row">
      {a.kind === 'url' ? (
        url ? (
          <a className="ac-btn" href={url} target="_blank" rel="noopener noreferrer" title={`Open ${url} in a new tab`}>
            {label}
          </a>
        ) : (
          <button disabled title="This address can't be opened from here">
            {label}
          </button>
        )
      ) : (
        <button
          className="ac-btn"
          disabled={running}
          title={tip || (a.kind === 'prompt' ? 'Send this to the thread' : 'Run this in the thread’s folder')}
          onClick={() => void runAction(store, thread.id, a)}
        >
          {label}
        </button>
      )}
      {detail && (
        <span className={`ac-detail ${a.kind === 'command' ? 'mono' : ''}`} title={detail}>
          {detail}
        </span>
      )}
      {a.note && <div className="ac-sub">{a.note}</div>}
      {info && <RunResult info={info} />}
    </li>
  );
}

// ---- panels -------------------------------------------------------------------

type Rendered = { image?: ImageRef; items?: PanelItem[]; note?: string };

// panels.render, again every 15 seconds while the panel is open.
function usePanelRender(store: AppStore, threadId: string, panelId: string, active: boolean) {
  const [st, setSt] = useState<{ loading: boolean; error?: string; value?: Rendered; n: number }>({ loading: false, n: 0 });
  const busy = useRef(false);
  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setSt((s) => ({ ...s, loading: true }));
    try {
      const value = await store.rpc.request<Rendered>('panels.render', { threadId, panelId });
      setSt((s) => ({ loading: false, value, n: s.n + 1 }));
    } catch (e) {
      setSt((s) => ({ ...s, loading: false, error: errorText(e, 'draw panels') }));
    } finally {
      busy.current = false;
    }
  }, [store, threadId, panelId]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const t = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15_000);
    return () => clearInterval(t);
  }, [active, refresh]);
  return { ...st, refresh };
}

function PanelImage({ store, image, n }: { store: AppStore; image: ImageRef; n: number }) {
  const st = useRunnerFile(store.rpc, image.path, n);
  if (st.status === 'loading') return <div className="ac-sub">Loading the picture...</div>;
  if (st.status === 'error') return <div className="ac-sub ac-bad">{st.message}</div>;
  if (!st.file.url) return <div className="ac-sub">That isn't a picture this window can show.</div>;
  return <img className="ac-shot" src={st.file.url} alt="" />;
}

function Items({ store, items }: { store: AppStore; items: PanelItem[] }) {
  const [openPath, setOpenPath] = useState<string>();
  if (!items.length) return <div className="ac-sub">Nothing to show right now.</div>;
  let section: string | undefined;
  return (
    <ul className="ac-items">
      {items.map((it, i) => {
        const head = it.section && it.section !== section ? <li key={`s${i}`} className="ac-section">{it.section}</li> : null;
        section = it.section ?? section;
        const url = webUrl(it.url);
        const inner = (
          <>
            <span className={`ac-dot ${it.tone ?? ''}`} />
            <span className="ac-item-title">{it.title}</span>
            {it.trailing && <span className="ac-trailing">{it.trailing}</span>}
          </>
        );
        return (
          <FragmentRow key={i} head={head}>
            <li className="ac-item">
              {url ? (
                <a className="ac-item-main" href={url} target="_blank" rel="noopener noreferrer" title={`Open ${url} in a new tab`}>
                  {inner}
                </a>
              ) : it.path ? (
                <button className="ac-item-main" title={openPath === it.path ? 'Hide the file' : `Show ${it.path}`} onClick={() => setOpenPath(openPath === it.path ? undefined : it.path)}>
                  {inner}
                </button>
              ) : (
                <div className="ac-item-main">{inner}</div>
              )}
              {it.detail && <div className="ac-sub">{it.detail}</div>}
              {it.path && openPath === it.path && (
                <div className="ac-preview">
                  <FilePreview store={store} path={it.path} compact />
                </div>
              )}
            </li>
          </FragmentRow>
        );
      })}
    </ul>
  );
}

function FragmentRow({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <>
      {head}
      {children}
    </>
  );
}

function PanelRow({ store, thread, panel }: { store: AppStore; thread: ThreadSummary; panel: NonNullable<ThreadSummary['panels']>[number] }) {
  const [open, setOpen] = useState(false);
  const live = panel.kind === 'image' || panel.kind === 'list';
  const r = usePanelRender(store, thread.id, panel.id, open && live);
  const url = webUrl(panel.url);
  const lines = panel.summary?.split('\n').filter(Boolean) ?? [];
  return (
    <li className="ac-row">
      <div className="ac-line">
        {live ? (
          <button className="ac-btn" aria-expanded={open} title={open ? `Hide ${panel.title}` : `Show ${panel.title}`} onClick={() => setOpen(!open)}>
            {panel.title}
            {panel.badge ? <span className="ac-count">{panel.badge}</span> : null}
            <span className="ac-chev"><Chev open={open} /></span>
          </button>
        ) : url ? (
          <a className="ac-btn" href={url} target="_blank" rel="noopener noreferrer" title={`Open ${url} in a new tab`}>
            {panel.title}
            {panel.badge ? <span className="ac-count">{panel.badge}</span> : null}
          </a>
        ) : (
          <button disabled title="This panel has no web address a browser can open">
            {panel.title}
          </button>
        )}
        {open && live && (
          <button className="ghost" disabled={r.loading} title="Draw this panel again" onClick={() => void r.refresh()}>
            {r.loading ? 'Drawing...' : 'Refresh'}
          </button>
        )}
      </div>
      {panel.note && <div className="ac-sub">{panel.note}</div>}
      {lines.map((l, i) => (
        <div key={i} className="ac-sub">
          {l}
        </div>
      ))}
      {open && live && (
        <div className="ac-panelbody">
          {r.error && <div className="ac-sub ac-bad">{r.error}</div>}
          {!r.value && !r.error && <div className="ac-sub">Drawing...</div>}
          {r.value?.note && <div className="ac-sub">{r.value.note}</div>}
          {r.value?.image && <PanelImage store={store} image={r.value.image} n={r.n} />}
          {r.value?.items && <Items store={store} items={r.value.items} />}
        </div>
      )}
    </li>
  );
}

// ---- hooks and patches -----------------------------------------------------------

function HookRow({ h }: { h: Hook }) {
  const when = h.on === 'turn.end' ? 'After each turn' : h.on;
  const edited = h.edited ? `, when a file matching ${h.edited} was edited` : '';
  const tell = h.tell === 'always' ? 'Its result always goes to the agent.' : h.tell === 'never' ? 'Its result stays in the transcript.' : 'The agent is told when it fails.';
  return (
    <li className="ac-row">
      <div className="ac-hook" title={h.command}>
        <b>{h.title}</b>
      </div>
      <div className="ac-sub">
        {when}
        {edited}. {tell}
      </div>
      <div className="ac-detail mono" title={h.command}>
        {h.command}
      </div>
      {h.note && <div className="ac-sub">{h.note}</div>}
    </li>
  );
}

const SOURCE: Record<PatchInfo['source'], string> = {
  builtin: 'Built in',
  home: 'Yours, for every folder',
  project: 'From the project',
  claude: 'Claude Code settings',
};

function PatchRow({ p }: { p: PatchInfo }) {
  const where = p.file ? (p.folder ? (relativeTo(p.folder, p.file) ?? p.file) : p.file) : undefined;
  return (
    <li className="ac-row">
      <div className="ac-line">
        <b title={p.id}>{p.id}</b>
        <span className="ac-sub">{SOURCE[p.source]}</span>
      </div>
      {where && (
        <div className="ac-sub" title={p.file}>
          {where}
        </div>
      )}
      {p.untrusted && <div className="ac-sub ac-warn">Waiting for you to trust it.</div>}
      {p.error && <div className="ac-sub ac-bad">{p.error}</div>}
      {p.liveError && <div className="ac-sub ac-warn">{p.liveError}</div>}
    </li>
  );
}

// ---- trusting a patch ----------------------------------------------------------

function Code({ store, path, open }: { store: AppStore; path: string; open?: boolean }) {
  const st = useRunnerFile(store.rpc, path);
  const [all, setAll] = useState(false);
  if (st.status === 'loading') return <div className="ac-sub">Reading {baseName(path)}...</div>;
  if (st.status === 'error') return <div className="ac-sub ac-bad">Couldn't read {baseName(path)}: {st.message}</div>;
  const f = st.file;
  if (f.text === undefined) return <div className="ac-sub">{baseName(path)} isn't a text file.</div>;
  const lines = f.text.split('\n').length;
  return (
    <div className="ac-codewrap">
      <pre className={`ac-code ${all || open ? 'all' : ''}`} tabIndex={0} title={path}>
        {f.text}
      </pre>
      {lines > 14 && !open && (
        <button className="ghost" title={all ? 'Show less of the file' : `Show all ${lines} lines`} onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${lines} lines`}
        </button>
      )}
      {f.truncated && <div className="ac-sub">Only the start of the file is shown.</div>}
    </div>
  );
}

function TrustCard({ store, thread, p }: { store: AppStore; thread: ThreadSummary; p: PatchInfo }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [helper, setHelper] = useState<string>();
  const settings = p.source === 'claude';
  const changed = p.untrusted === 'changed';
  const file = p.file!;
  const trust = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await store.rpc.request('patches.trust', { threadId: thread.id, files: [{ file, hash: p.hash! }] });
    } catch (e) {
      const code = (e as { code?: number }).code;
      setError(code === -32602 ? 'The file has changed since it was shown. Read it again before you trust it.' : errorText(e, 'trust patches'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="ac-trust">
      <div className="ac-trust-head">
        <b>{settings ? 'Claude Code settings' : baseName(file)}</b>
        <span className="ac-sub">{changed ? 'Changed since you last trusted it' : 'New'}</span>
      </div>
      <p className="ac-sub ac-why">
        {settings
          ? 'These settings run commands for Claude Code in this folder, such as hooks and servers. Until you trust them, Claude runs without them.'
          : 'This file is code. Once you trust it, Threadbear runs it on the machine the runner is on, and its hooks run by themselves. Read it first.'}
      </p>
      <div className="ac-sub ac-path" title={file}>
        {p.folder ? (relativeTo(p.folder, file) ?? file) : file}
      </div>
      <Code key={p.hash} store={store} path={file} />
      {p.helpers && p.helpers.length > 0 && (
        <div className="ac-helpers">
          <div className="ac-sub">The trust also covers {p.helpers.length === 1 ? 'one more file' : `${p.helpers.length} more files`}:</div>
          {p.helpers.map((h) => (
            <div key={h}>
              <button className="ghost ac-helper" aria-expanded={helper === h} title={helper === h ? 'Hide this file' : `Read ${h}`} onClick={() => setHelper(helper === h ? undefined : h)}>
                <Chev open={helper === h} /> {(p.folder ? relativeTo(p.folder, h) : undefined) ?? baseName(h)}
              </button>
              {helper === h && <Code key={h} store={store} path={h} />}
            </div>
          ))}
        </div>
      )}
      {error && <div className="ac-sub ac-bad">{error}</div>}
      <div className="ac-trust-btns">
        <button className="primary" disabled={busy} title="Trust this version of the file, so Threadbear loads and runs it" onClick={() => void trust()}>
          {busy ? 'Trusting...' : 'Trust and load'}
        </button>
      </div>
    </li>
  );
}

// ---- the pane ---------------------------------------------------------------------

const waiting = (t: ThreadSummary): PatchInfo[] => (t.patches ?? []).filter((p) => p.untrusted && p.file && p.hash);

function Group({ title, children, count }: { title: string; children: ReactNode; count?: number }) {
  return (
    <section className="ac-sec">
      <h3>
        {title}
        {count !== undefined && <span className="ac-secount"> {count}</span>}
      </h3>
      {children}
    </section>
  );
}

function ActionsPane({ store, thread }: PaneProps) {
  const trust = waiting(thread);
  const actions = thread.actions ?? [];
  const panels = thread.panels ?? [];
  const hooks = thread.hooks ?? [];
  const patches = thread.patches ?? [];
  const patchNames = [...new Set(actions.map((a) => a.patch))];
  return (
    <div className="ac">
      {trust.length > 0 && (
        <Group title="Waiting for you to trust">
          <ul className="ac-list">
            {trust.map((p) => (
              <TrustCard key={`${p.id}:${p.file}`} store={store} thread={thread} p={p} />
            ))}
          </ul>
        </Group>
      )}
      {actions.length > 0 && (
        <Group title="Actions">
          {patchNames.map((name) => (
            <div key={name}>
              {patchNames.length > 1 && <div className="ac-patchname">{name}</div>}
              <ul className="ac-list">
                {actions
                  .filter((a) => a.patch === name)
                  .map((a) => (
                    <ActionRow key={a.id} store={store} thread={thread} a={a} />
                  ))}
              </ul>
            </div>
          ))}
        </Group>
      )}
      {panels.length > 0 && (
        <Group title="Panels">
          <ul className="ac-list">
            {panels.map((p) => (
              <PanelRow key={p.id} store={store} thread={thread} panel={p} />
            ))}
          </ul>
        </Group>
      )}
      {hooks.length > 0 && (
        <Group title="Hooks">
          <ul className="ac-list">
            {hooks.map((h) => (
              <HookRow key={h.id} h={h} />
            ))}
          </ul>
        </Group>
      )}
      {patches.length > 0 && (
        <Group title="Patches" count={patches.length}>
          <ul className="ac-list">
            {patches.map((p) => (
              <PatchRow key={`${p.id}:${p.file ?? ''}`} p={p} />
            ))}
          </ul>
        </Group>
      )}
      {!trust.length && !actions.length && !panels.length && !hooks.length && !patches.length && <div className="ac-empty">This thread's folder has no actions or panels.</div>}
    </div>
  );
}

const pane: PaneDef = {
  id: 'actions',
  title: 'Actions',
  hint: "The buttons, panels and hooks this folder defines (Threadbear patches), and what is waiting on you",
  order: 20,
  available: (t) => Boolean(t.actions?.length || t.panels?.length || t.hooks?.length || t.patches?.some((p) => p.source !== 'builtin')),
  badge: (t) => waiting(t).length || undefined,
  Pane: ActionsPane,
};
export default pane;
