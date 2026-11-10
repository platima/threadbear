// A folder browser for the thread's working folder, on the runner's machine
// (files.list and files.read).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PaneDef, PaneProps } from '../registry.ts';
import { ago } from '../../../../web/src/format.ts';
import { FilePreview } from '../pages-lib/filePreview.tsx';
import { baseName, crumbs, joinPath, parentPath, samePath } from '../pages-lib/pathStyle.ts';
import { errorText, formatSize } from '../pages-lib/runnerFiles.ts';
import './files.css';

type Entry = { name: string; isFolder: boolean; hidden: boolean; size?: number; modifiedAt?: string };
type Listing = { path: string; entries: Entry[]; truncated: boolean };
type Load = { dir: string; status: 'loading' } | { dir: string; status: 'error'; message: string } | { dir: string; status: 'ready'; listing: Listing };

const HIDDEN_KEY = 'threadbear.files.hidden';
const readHidden = (): boolean => {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
};

// Where each thread's browser was left, so closing the tab and opening it again
// finds the same place.
const left = new Map<string, { dir: string; file?: string }>();

const SHOW_AT_FIRST = 600;

function when(iso?: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '' : ago(ms);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function Glyph({ folder }: { folder: boolean }) {
  return folder ? (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden>
      <path d="M1.5 3.5h4.5l1.5 1.5h6.5v7.5h-12.5z" />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden>
      <path d="M4 1.5h5l3 3v10H4z" />
      <path d="M9 1.5v3h3" />
    </svg>
  );
}

function Browser({ store, snap, thread }: PaneProps) {
  const start = thread.cwd;
  const saved = left.get(thread.id);
  const [dir, setDir] = useState(saved?.dir ?? start);
  const [file, setFile] = useState<string | undefined>(saved?.file);
  const [hidden, setHidden] = useState(readHidden);
  const [tries, setTries] = useState(0);
  const [all, setAll] = useState(false);
  const [load, setLoad] = useState<Load>({ dir, status: 'loading' });
  const trail = useRef<HTMLElement>(null);

  useEffect(() => {
    left.set(thread.id, { dir, file });
  }, [thread.id, dir, file]);

  useEffect(() => {
    if (snap.conn !== 'open') return;
    let live = true;
    setLoad((l) => (l.dir === dir && l.status === 'ready' ? l : { dir, status: 'loading' }));
    store.rpc.request<Listing>('files.list', { path: dir }).then(
      (listing) => live && setLoad({ dir, status: 'ready', listing }),
      (e) => live && setLoad({ dir, status: 'error', message: errorText(e, 'list folders') }),
    );
    return () => {
      live = false;
    };
  }, [store, snap.conn, dir, tries]);

  useEffect(() => {
    const el = trail.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [dir, file]);

  const go = (path: string) => {
    setDir(path);
    setFile(undefined);
    setAll(false);
  };
  const up = parentPath(dir);
  const shown = load.status === 'ready' && load.dir === dir ? load.listing : undefined;
  const entries = useMemo(() => {
    if (!shown) return [];
    return shown.entries
      .filter((e) => hidden || !e.hidden)
      .sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || collator.compare(a.name, b.name));
  }, [shown, hidden]);
  const hiddenCount = shown ? shown.entries.filter((e) => e.hidden).length : 0;
  const rows = all ? entries : entries.slice(0, SHOW_AT_FIRST);
  const here = crumbs(file ?? dir);

  return (
    <div className="fl">
      <div className="fl-tools">
        <button className="ghost" disabled={!up || Boolean(file)} title={up ? `Go up to ${up}` : 'This is the top'} onClick={() => up && go(up)}>
          ↑ Up
        </button>
        <button className="ghost" disabled={samePath(dir, start) && !file} title={`Back to the thread's folder, ${start}`} onClick={() => go(start)}>
          Thread folder
        </button>
        <button className="ghost" title="Read this folder again" onClick={() => setTries(tries + 1)}>
          Refresh
        </button>
        <label className="fl-hidden" title="Show files and folders whose names start with a dot">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => {
              setHidden(e.target.checked);
              try {
                localStorage.setItem(HIDDEN_KEY, e.target.checked ? '1' : '0');
              } catch {
                // not kept
              }
            }}
          />{' '}
          Hidden files
        </label>
      </div>
      <nav className="fl-crumbs" ref={trail} aria-label="Where you are">
        {here.map((c, i) => {
          const last = i === here.length - 1;
          return (
            <span key={c.path} className="fl-crumb">
              {i > 0 && <span className="fl-sep">›</span>}
              {last && file ? (
                <span className="fl-here" title={c.path}>
                  {c.label}
                </span>
              ) : (
                <button className={`ghost ${last ? 'fl-here' : ''}`} title={`Open ${c.path}`} onClick={() => go(c.path)}>
                  {c.label}
                </button>
              )}
            </span>
          );
        })}
      </nav>

      {file ? (
        <div className="fl-file">
          <button className="ghost fl-back" title="Back to the folder" onClick={() => setFile(undefined)}>
            ‹ Back to {baseName(dir)}
          </button>
          <FilePreview key={file} store={store} path={file} />
        </div>
      ) : load.dir !== dir || load.status === 'loading' ? (
        <div className="fl-note">Loading...</div>
      ) : load.status === 'error' ? (
        <div className="fl-note fl-bad">
          {load.message}
          {!samePath(dir, start) && (
            <div>
              <button title="Go back to the thread's folder" onClick={() => go(start)}>
                Go to the thread's folder
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {load.listing.truncated && <div className="fl-note">This folder has more entries than can be listed. Showing the first {load.listing.entries.length.toLocaleString()}.</div>}
          {!entries.length && (
            <div className="fl-note">{load.listing.entries.length ? `Nothing here except ${hiddenCount} hidden ${hiddenCount === 1 ? 'item' : 'items'}.` : 'This folder is empty.'}</div>
          )}
          <ul className="fl-list">
            {rows.map((e) => (
              <li key={e.name}>
                <button
                  className="fl-item"
                  title={e.isFolder ? `Open the folder ${e.name}` : `Preview ${e.name}`}
                  onClick={() => (e.isFolder ? go(joinPath(dir, e.name)) : setFile(joinPath(dir, e.name)))}
                >
                  <span className={`fl-icon ${e.isFolder ? 'folder' : ''}`}>
                    <Glyph folder={e.isFolder} />
                  </span>
                  <span className={`fl-name ${e.hidden ? 'dim' : ''}`}>{e.name}</span>
                  <span className="fl-size">{e.isFolder ? '' : formatSize(e.size)}</span>
                  <span className="fl-when">{when(e.modifiedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
          {entries.length > rows.length && (
            <button className="ghost fl-more" title="List the rest of this folder" onClick={() => setAll(true)}>
              Show all {entries.length.toLocaleString()}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function FilesPane(props: PaneProps) {
  return <Browser key={props.thread.id} {...props} />;
}

const pane: PaneDef = {
  id: 'files',
  title: 'Files',
  hint: "Browse and preview the files in this thread's folder",
  order: 40,
  available: (t) => Boolean(t.cwd),
  Pane: FilesPane,
};
export default pane;
