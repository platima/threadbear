// Projects: a list of them, and a page for the one picked. Everything here is
// the protocol's "Projects" and "Project tasks" (docs/protocol.md). The page
// keeps its own state; the runner's projects.updated keeps the list live.
import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mdComponents } from '../thread/mdComponents.tsx';
import type { PageDef, PageProps } from '../registry.ts';
import type { AppStore } from '../../core/store.ts';
import type { Project, ProjectLink, ProjectTask, ProjectTasks, ThreadSummary } from '../../core/types.ts';
import { ago, day, plain } from '../../../../web/src/format.ts';
import { Confirm, ErrorLine, Section, folderLabel } from '../pages-lib/bits.tsx';
import { NEW, useAction, useLive, useSelection, type LiveList, type LiveState } from '../pages-lib/live.ts';
import './projects.css';

function useProjects(store: AppStore): [LiveState<Project>, LiveList<Project>] {
  return useLive<Project>(store, 'projects', () => ({
    what: 'projects',
    load: async () => (await store.rpc.request<{ projects: Project[] }>('projects.list', { archived: true })).projects,
    notification: 'projects.updated',
    pick: (p) => p?.projects,
  }));
}

const when = (p: Project) => Date.parse(p.lastActivityAt ?? p.updatedAt);

// ---- the icon ---------------------------------------------------------------

// A project's picture lives on the runner's disk, so it is read with files.read.
// One that can't be read (or a symbol name, which is a Mac thing) shows the
// project's first letter instead.
const pictures = new Map<string, Promise<string>>();

function readPicture(store: AppStore, project: Project): Promise<string> | undefined {
  const image = project.icon?.image;
  if (!image) return undefined;
  const key = `${image.path}@${project.icon?.updatedAt}`;
  let found = pictures.get(key);
  if (!found) {
    found = store.rpc.request<{ data?: string; mediaType?: string }>('files.read', { path: image.path, maxBytes: 1_000_000 }).then((r) => {
      if (!r.data) throw new Error('no data');
      const type = image.mediaType || r.mediaType || 'image/png';
      return `data:${type};base64,${r.data}`;
    });
    found.catch(() => pictures.delete(key));
    pictures.set(key, found);
  }
  return found;
}

function ProjectIcon({ store, project, big }: { store: AppStore; project: Project; big?: boolean }) {
  const [url, setUrl] = useState<string | undefined>();
  const path = project.icon?.image?.path;
  const stamp = project.icon?.updatedAt;
  useEffect(() => {
    let off = false;
    setUrl(undefined);
    const read = readPicture(store, project);
    read?.then((u) => !off && setUrl(u)).catch(() => {});
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, path, stamp]);
  const letter = (project.title.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
  return (
    <span className={`pl-avatar${big ? ' big' : ''}`} aria-hidden="true">
      {url ? <img src={url} alt="" onError={() => setUrl(undefined)} /> : letter}
    </span>
  );
}

// ---- the list column ----------------------------------------------------------

function ProjectsSidebar({ store }: PageProps) {
  const [live] = useProjects(store);
  const [sel, select] = useSelection('projects');
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const q = query.trim().toLowerCase();
  const shown = live.items.filter((p) => !q || [p.title, p.goals, ...p.folders].join('\n').toLowerCase().includes(q));
  const active = shown.filter((p) => !p.archived);
  const archived = shown.filter((p) => p.archived);
  const selectedArchived = live.items.some((p) => p.id === sel && p.archived);
  const open = showArchived || selectedArchived || (q !== '' && archived.length > 0);

  const row = (p: Project) => (
    <div
      key={p.id}
      className={`pl-item${sel === p.id ? ' sel' : ''}${p.archived ? ' faded' : ''}`}
      role="button"
      tabIndex={0}
      title={`Open ${p.title}`}
      onClick={() => select(p.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select(p.id);
        }
      }}
    >
      <ProjectIcon store={store} project={p} />
      <div className="pl-itembody">
        <div className="pl-itemtitle">
          <b>{p.title}</b>
          <span>{ago(when(p))}</span>
        </div>
        <div className="pl-itemsub">{plain(p.state) || p.folders.map(folderLabel).join(', ') || 'No folders yet'}</div>
      </div>
    </div>
  );

  return (
    <>
      <div className="side-top">
        <input placeholder="Search projects" title="Search projects by name, goals or folder" aria-label="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button title="Make a new project" onClick={() => select(NEW)}>
          New
        </button>
      </div>
      <div className="side-list">
        {live.error && !live.items.length && <div className="pl-none">{live.error}</div>}
        {!live.loaded && <div className="pl-none">Loading projects...</div>}
        {live.loaded && !live.error && active.length === 0 && archived.length === 0 && <div className="pl-none">{q ? 'No projects match.' : 'No projects yet.'}</div>}
        {active.map(row)}
        {live.items.some((p) => p.archived) && (
          <>
            <button className="pl-fold" title={open ? 'Hide archived projects' : 'Show archived projects'} onClick={() => setShowArchived(!open)}>
              <span>{open ? '▾' : '▸'}</span>
              <span>Archived</span>
              <span style={{ fontWeight: 400 }}>{archived.length}</span>
            </button>
            {open && archived.map(row)}
          </>
        )}
      </div>
    </>
  );
}

// ---- the page ---------------------------------------------------------------------

function ProjectsMain(props: PageProps) {
  const { store } = props;
  const [live] = useProjects(store);
  const [sel, select] = useSelection('projects');

  if (sel === NEW) return <NewProject store={store} />;
  if (!sel) {
    return (
      <div className="pl-empty">
        <h2>Projects</h2>
        <p>A project groups threads and folders, and keeps goals and notes that carry forward from thread to thread.</p>
        {live.error && !live.items.length ? <p className="error">{live.error}</p> : <button className="primary" title="Make a new project" onClick={() => select(NEW)}>New project</button>}
      </div>
    );
  }
  const project = live.items.find((p) => p.id === sel);
  if (!project) {
    return (
      <div className="pl-empty">
        {live.error ? <p className="error">{live.error}</p> : <p>{live.loaded ? 'That project is gone.' : 'Loading...'}</p>}
        {live.loaded && <button title="Go back to the project list" onClick={() => select(undefined)}>Close</button>}
      </div>
    );
  }
  return <ProjectPage key={project.id} {...props} project={project} />;
}

function maker(by: Project['createdBy']): string {
  return by === 'mike' ? 'you' : by === 'librarian' ? 'the librarian' : 'an agent';
}

function ProjectPage({ store, snap, openThread, project }: PageProps & { project: Project }) {
  const [state, list] = useProjects(store);
  const [, select] = useSelection('projects');
  const { run, error, clear } = useAction('projects');
  const [title, setTitle] = useState(project.title);
  const [threadIds, setThreadIds] = useState<string[] | undefined>();

  useEffect(() => setTitle(project.title), [project.title]);

  const update = async (patch: Record<string, unknown>): Promise<boolean> => {
    const r = await run(() => store.rpc.request<{ project: Project }>('projects.update', { projectId: project.id, ...patch }));
    if (!r) return false;
    list.change((items) => items.map((p) => (p.id === r.project.id ? r.project : p)));
    return true;
  };

  // The threads in it: what the runner says, else what the loaded threads say.
  const members = useMemo(() => [...snap.threads.values()].filter((t) => t.projects?.some((x) => x.id === project.id)).length, [snap.threads, project.id]);
  useEffect(() => {
    let off = false;
    if (snap.conn !== 'open') return;
    store.rpc
      .request<{ threadIds: string[] }>('projects.get', { projectId: project.id })
      .then((r) => !off && setThreadIds(r.threadIds))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [store, snap.conn, project.id, project.updatedAt, project.threadCount, members]);
  const ids = threadIds ?? [...snap.threads.values()].filter((t) => t.projects?.some((x) => x.id === project.id)).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).map((t) => t.id);

  const commitTitle = () => {
    const next = title.trim();
    if (!next) return setTitle(project.title);
    if (next !== project.title) void update({ title: next });
  };

  return (
    <div className="page">
      <div className="pl-inner">
        <div className="pj-head">
          <ProjectIcon store={store} project={project} big />
          <div className="grow">
            <input
              className="pj-title"
              value={title}
              title="Rename this project"
              aria-label="Project title"
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                  setTitle(project.title);
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
            <div className="pl-dim pj-meta">
              Made by {maker(project.createdBy)} on {day(project.createdAt)}. Last active {ago(when(project))}{ago(when(project)) === 'now' ? '' : ' ago'}.
            </div>
          </div>
          {project.archived && <span className="chip warn" title="This project is archived">Archived</span>}
          <button title={project.archived ? 'Bring this project back to the list' : 'Put this project away in the archive'} onClick={() => void update({ archived: !project.archived })}>
            {project.archived ? 'Unarchive' : 'Archive'}
          </button>
        </div>

        <ErrorLine text={error} onClear={clear} />

        <TextBlock title="Goals" value={project.goals} empty="No goals written down yet." tip="Edit the goals" onSave={(goals) => update({ goals })} />
        <TextBlock title="State" value={project.state} empty="Nothing about where it stands yet." tip="Edit the state" onSave={(state) => update({ state })} />
        <Folders folders={project.folders} onChange={(folders) => update({ folders })} />
        <Links links={project.links} onChange={(links) => update({ links })} />
        <TextBlock title="Notes" value={project.notes} empty="No notes yet." tip="Edit the notes" rows={10} onSave={(notes) => update({ notes })} />
        <Threads store={store} ids={ids} snap={snap} openThread={openThread} />
        {project.notion && <Tasks store={store} project={project} snap={snap} openThread={openThread} />}
        <Manage store={store} project={project} live={state} projects={list} />
      </div>
    </div>
  );
}

// ---- goals, state and notes ----------------------------------------------------

function TextBlock({ title, value, empty, tip, rows, onSave }: { title: string; value: string; empty: string; tip: string; rows?: number; onSave: (v: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const ok = draft === value ? true : await onSave(draft);
    setSaving(false);
    if (ok) setEditing(false);
  };
  return (
    <Section
      title={title}
      aside={
        !editing && (
          <button
            title={tip}
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
          >
            Edit
          </button>
        )
      }
    >
      {editing ? (
        <div className="pj-edit">
          <textarea
            autoFocus
            value={draft}
            rows={Math.min(24, Math.max(rows ?? 4, draft.split('\n').length + 1))}
            title={`${title}, as Markdown. Ctrl+Enter saves, Escape cancels.`}
            aria-label={title}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
          <div className="pl-actions">
            <button className="primary" disabled={saving} title={`Save the ${title.toLowerCase()}`} onClick={() => void save()}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button disabled={saving} title="Leave it as it was" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : value.trim() ? (
        <div className="md pj-view">
          <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {value}
          </Markdown>
        </div>
      ) : (
        <div className="pl-dim">{empty}</div>
      )}
    </Section>
  );
}

// ---- folders and links ------------------------------------------------------------

function Folders({ folders, onChange }: { folders: string[]; onChange: (next: string[]) => Promise<boolean> }) {
  const [adding, setAdding] = useState('');
  const add = async () => {
    const path = adding.trim();
    if (!path) return;
    if (folders.includes(path)) return setAdding('');
    if (await onChange([...folders, path])) setAdding('');
  };
  return (
    <Section title="Folders">
      {folders.length === 0 && <div className="pl-dim">No folders yet.</div>}
      {folders.map((f) => (
        <div key={f} className="pj-line">
          <code className="grow" title={f}>{f}</code>
          <button className="ghost" title={`Take ${f} out of this project`} onClick={() => void onChange(folders.filter((x) => x !== f))}>
            Remove
          </button>
        </div>
      ))}
      <div className="pj-add">
        <input
          className="grow"
          value={adding}
          placeholder="Add a folder, such as C:\dev\my-app"
          title="The full path of a folder that exists"
          aria-label="Folder to add"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <button disabled={!adding.trim()} title="Add this folder to the project" onClick={() => void add()}>
          Add
        </button>
      </div>
    </Section>
  );
}

const MAX_LINKS = 8;

function Links({ links, onChange }: { links: ProjectLink[]; onChange: (next: ProjectLink[]) => Promise<boolean> }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [problem, setProblem] = useState<string | undefined>();
  const add = async () => {
    const address = url.trim();
    if (!/^https?:\/\/\S+$/i.test(address)) return setProblem('A link needs a web address that starts with http:// or https://.');
    setProblem(undefined);
    if (await onChange([...links, { title: name.trim() || address, url: address }])) {
      setName('');
      setUrl('');
    }
  };
  return (
    <Section title="Links" aside={`${links.length} of ${MAX_LINKS}`}>
      {links.length === 0 && <div className="pl-dim">No links yet. Add the places you keep going back to, such as the live site or a dashboard.</div>}
      {links.map((l, i) => (
        <div key={`${l.url}${i}`} className="pj-line">
          <a href={l.url} target="_blank" rel="noreferrer noopener" title={l.url}>{l.title || l.url}</a>
          <span className="pl-dim grow pj-url">{l.title && l.title !== l.url ? l.url : ''}</span>
          <button className="ghost" title={`Remove the link to ${l.title || l.url}`} onClick={() => void onChange(links.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      {links.length < MAX_LINKS ? (
        <div className="pj-add">
          <input value={name} placeholder="Name" title="What to call the link" aria-label="Link name" style={{ width: 150 }} onChange={(e) => setName(e.target.value)} />
          <input
            className="grow"
            value={url}
            placeholder="https://"
            title="The web address"
            aria-label="Link address"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <button disabled={!url.trim()} title="Add this link to the project" onClick={() => void add()}>
            Add
          </button>
        </div>
      ) : (
        <div className="pl-dim">That is the most a project can hold. Remove one to add another.</div>
      )}
      <ErrorLine text={problem} />
    </Section>
  );
}

// ---- threads --------------------------------------------------------------------------

function Threads({ store, ids, snap, openThread }: { store: AppStore; ids: string[]; snap: PageProps['snap']; openThread: (id: string) => void }) {
  // A thread that is put away isn't loaded until the archive is: ask once, so its title shows.
  const asked = useRef(false);
  const missing = ids.some((id) => !snap.threads.has(id));
  useEffect(() => {
    if (!missing || snap.archivedLoaded || asked.current || snap.conn !== 'open') return;
    asked.current = true;
    store.loadArchived().catch(() => {});
  }, [store, missing, snap.archivedLoaded, snap.conn]);
  return (
    <Section title="Threads" aside={ids.length ? String(ids.length) : undefined}>
      {ids.length === 0 && <div className="pl-dim">No threads are in this project yet.</div>}
      {ids.map((id) => {
        const t: ThreadSummary | undefined = snap.threads.get(id);
        const dot = !t ? '' : t.status === 'running' || t.status === 'starting' ? 'running' : t.status === 'waiting' || t.needsYou ? 'needs' : t.status === 'error' || t.status === 'stopped' ? 'broken' : '';
        return (
          <div
            key={id}
            className="pl-item pj-thread"
            role="button"
            tabIndex={0}
            title={t ? `Open ${t.title || 'this thread'}` : 'Open this thread'}
            onClick={() => openThread(id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openThread(id);
              }
            }}
          >
            <span className={`pl-dot ${dot}`} />
            <div className="pl-itembody">
              <div className="pl-itemtitle">
                <b className={t ? undefined : 'pl-dim'}>{t ? t.title || 'New thread' : `Thread ${id.slice(0, 8)}`}</b>
                {t && <span>{ago(Date.parse(t.lastActivityAt))}</span>}
              </div>
              <div className="pl-itemsub">{t ? `${t.archivedAt ? 'Archived. ' : ''}${folderLabel(t.cwd)}` : 'Not loaded yet'}</div>
            </div>
          </div>
        );
      })}
    </Section>
  );
}

// ---- the Notion task board, read only ----------------------------------------------

function newest(a?: ProjectTasks, b?: ProjectTasks): ProjectTasks | undefined {
  if (!a || !b) return a ?? b;
  return (b.fetchedAt ?? '') > (a.fetchedAt ?? '') ? b : a;
}

function Tasks({ store, project, snap, openThread }: PageProps & { project: Project }) {
  const [fresh, setFresh] = useState<ProjectTasks | undefined>();
  const act = useAction('the task board');
  const refresh = async (force: boolean) => {
    const r = await act.run(() => store.rpc.request<{ project: Project }>('projects.refreshTasks', { projectId: project.id, force }));
    if (r?.project.tasks) setFresh(r.project.tasks);
  };
  // The page asks for a fresh read when it opens.
  useEffect(() => {
    if (snap.conn === 'open') void refresh(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.notion, snap.conn]);

  const tasks = newest(project.tasks, fresh);
  const columns = useMemo(() => {
    if (!tasks) return [];
    const known = new Set(tasks.columns.map((c) => c.name));
    const cols: { name: string; kind?: string; items: ProjectTask[] }[] = tasks.columns.map((c) => ({ name: c.name, kind: c.kind, items: tasks.items.filter((i) => i.status === c.name) }));
    const other = tasks.items.filter((i) => !known.has(i.status));
    if (other.length) cols.push({ name: tasks.columns.length ? 'Other' : 'Tasks', items: other });
    return cols;
  }, [tasks]);

  const threadFor = (prefix?: string): string | undefined => (prefix ? [...snap.threads.keys()].find((id) => id.startsWith(prefix)) : undefined);

  return (
    <Section
      title="Tasks"
      aside={
        <>
          {tasks?.fetchedAt && <span title={new Date(tasks.fetchedAt).toLocaleString()}>Read {ago(Date.parse(tasks.fetchedAt))}{ago(Date.parse(tasks.fetchedAt)) === 'now' ? '' : ' ago'}</span>}
          <a href={tasks?.url ?? project.notion} target="_blank" rel="noreferrer noopener" title="Open the board in Notion, where cards are moved">
            Open in Notion
          </a>
          <button title="Read the board from Notion again" onClick={() => void refresh(true)}>
            Refresh
          </button>
        </>
      }
    >
      <ErrorLine text={act.error} onClear={act.clear} />
      {tasks?.error && <ErrorLine text={tasks.error} />}
      {(!tasks || tasks.loading) && !tasks?.error && <div className="pl-dim">Reading the board from Notion...</div>}
      {tasks && !tasks.loading && columns.length === 0 && !tasks.error && <div className="pl-dim">The board has no cards.</div>}
      {columns.length > 0 && (
        <div className="pj-board">
          {columns.map((c) => (
            <div key={c.name} className="pj-col">
              <div className="pj-colhead">
                <span className={`pl-dot ${c.kind === 'doing' ? 'needs' : c.kind === 'done' ? 'running' : ''}`} style={c.kind === 'todo' ? { background: 'var(--dim)' } : undefined} />
                <b>{c.name || 'No status'}</b>
                <span className="pl-dim">{c.items.length}</span>
              </div>
              {c.items.map((i) => {
                const tid = threadFor(i.thread);
                return (
                  <div key={i.id} className="pj-card">
                    <a href={i.url} target="_blank" rel="noreferrer noopener" title="Open this card in Notion">{i.title || 'Untitled'}</a>
                    {(i.who.length > 0 || i.due) && (
                      <div className="pl-dim pj-cardsub">
                        {[i.who.join(', '), i.due ? `due ${day(i.due)}` : ''].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    {tid && (
                      <button className="ghost" title="Open the thread working on this card" onClick={() => openThread(tid)}>
                        Open thread
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {tasks?.more && <div className="pl-dim">There are more cards in Notion than are shown here.</div>}
    </Section>
  );
}

// ---- merge, delete -------------------------------------------------------------------

function Manage({ store, project, live, projects }: { store: AppStore; project: Project; live: LiveState<Project>; projects: LiveList<Project> }) {
  const [, select] = useSelection('projects');
  const { run, error, clear } = useAction('that');
  const [into, setInto] = useState('');
  const others = live.items.filter((p) => p.id !== project.id && !p.archived);
  const target = others.find((p) => p.id === into);

  const merge = async () => {
    if (!target) return;
    const r = await run(() => store.rpc.request<{ project: Project }>('projects.merge', { projectId: project.id, intoId: target.id }));
    if (!r) return;
    projects.change((items) => items.filter((p) => p.id !== project.id).map((p) => (p.id === r.project.id ? r.project : p)));
    select(target.id);
  };
  const remove = async () => {
    const r = await run(async () => {
      await store.rpc.request('projects.delete', { projectId: project.id });
      return true;
    });
    if (!r) return;
    projects.change((items) => items.filter((p) => p.id !== project.id));
    select(undefined);
  };

  return (
    <Section title="Merge or delete">
      <ErrorLine text={error} onClear={clear} />
      <div className="pl-actions pj-merge">
        <select value={into} title="The project to merge this one into" aria-label="Project to merge into" onChange={(e) => setInto(e.target.value)}>
          <option value="">Merge into...</option>
          {others.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <Confirm
          label="Merge"
          disabled={!target}
          tip={target ? `Merge this project into ${target.title}` : 'Pick a project to merge into first'}
          question={`Merge into ${target?.title ?? ''}? This project goes away.`}
          yes="Yes, merge"
          onConfirm={() => void merge()}
        />
      </div>
      <div className="pl-dim pj-note">Merging moves the folders, links, notes and threads across.</div>
      <div className="pl-actions" style={{ marginTop: 12 }}>
        <Confirm
          danger
          label="Delete project"
          tip="Delete this project. Its threads stay."
          question={`Delete ${project.title}? Its threads stay, they just leave it.`}
          yes="Yes, delete"
          onConfirm={() => void remove()}
        />
      </div>
    </Section>
  );
}

// ---- a new project ---------------------------------------------------------------------

function NewProject({ store }: { store: AppStore }) {
  const [, live] = useProjects(store);
  const [, select] = useSelection('projects');
  const { run, error, busy, clear } = useAction('projects');
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState('');
  const [goals, setGoals] = useState('');

  const create = async () => {
    if (!title.trim()) return;
    const r = await run(() =>
      store.rpc.request<{ project: Project }>('projects.create', {
        title: title.trim(),
        ...(folder.trim() ? { folders: [folder.trim()] } : {}),
        ...(goals.trim() ? { goals: goals.trim() } : {}),
      }),
    );
    if (!r) return;
    live.change((items) => (items.some((p) => p.id === r.project.id) ? items : [r.project, ...items]));
    select(r.project.id);
  };

  return (
    <div className="page">
      <div className="pl-inner">
        <h2>New project</h2>
        <ErrorLine text={error} onClear={clear} />
        <Section title="Name">
          <input className="pj-wide" autoFocus value={title} title="What to call the project" aria-label="Project name" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
        </Section>
        <Section title="Folder">
          <input className="pj-wide" value={folder} placeholder="Optional, such as C:\dev\my-app" title="The full path of a folder that exists. More can be added later." aria-label="Folder" onChange={(e) => setFolder(e.target.value)} />
        </Section>
        <Section title="Goals">
          <textarea className="pj-wide" rows={4} value={goals} placeholder="Optional. What done looks like." title="What the project is for" aria-label="Goals" onChange={(e) => setGoals(e.target.value)} />
        </Section>
        <div className="pl-actions">
          <button className="primary" disabled={busy || !title.trim()} title="Make the project" onClick={() => void create()}>
            {busy ? 'Making...' : 'Make project'}
          </button>
          <button title="Go back without making one" onClick={() => select(undefined)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const def: PageDef = {
  id: 'projects',
  title: 'Projects',
  hint: 'Threads grouped by the work they belong to, with where each project stands, its folders and links',
  icon: '▤',
  order: 10,
  Sidebar: ProjectsSidebar,
  Main: ProjectsMain,
};
export default def;
