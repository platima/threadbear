import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AppStore } from '../core/store.ts';
import { clampWidth, readWidth } from '../../../web/src/sections.ts';
import { Sidebar } from './Sidebar.tsx';
import { ThreadView } from './ThreadView.tsx';
import { Composer } from './Composer.tsx';
import { Rail } from './Rail.tsx';
import { Shortcuts } from './Shortcuts.tsx';
import { TOUR_KEY, Tour } from './Tour.tsx';
import { PAGES } from './registry.ts';
import { isNative, startRunner } from '../core/native.ts';
import { runUpdateCheck } from './update-state.ts';

export function useSnap(store: AppStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

const WIDTH_KEY = 'threadbear.sidebarWidth';
const saved = (): string | null => {
  try {
    return localStorage.getItem(WIDTH_KEY);
  } catch {
    return null;
  }
};

export function App({ store }: { store: AppStore }) {
  const snap = useSnap(store);
  const [width, setWidth] = useState(() => clampWidth(readWidth(saved()), window.innerWidth));
  const [help, setHelp] = useState(false);
  // The banner's Start the runner button: busy until the shell has started the runner, or the
  // person has taken or turned down the set-up it offered (the shell answers only then), so a second
  // click can't open a second offer. What went wrong is said beside it.
  const [starting, setStarting] = useState(false);
  const [startProblem, setStartProblem] = useState<string>();
  const start = async () => {
    setStarting(true);
    setStartProblem(undefined);
    const problem = await startRunner();
    setStarting(false);
    setStartProblem(problem);
  };
  const [tour, setTour] = useState(false);
  // The installed app asks once a day whether a newer release is out
  // (core/updates.ts); a page in an ordinary browser tab never does.
  useEffect(() => {
    if (isNative()) void runUpdateCheck();
  }, []);
  // Once, on a window that has never had a thread, after the runner has answered.
  const tourChecked = useRef(false);
  useEffect(() => {
    if (tourChecked.current || snap.conn !== 'open' || !snap.hello) return;
    tourChecked.current = true;
    let done = false;
    try {
      done = localStorage.getItem(TOUR_KEY) === '1';
    } catch {
      done = true;
    }
    if (!done && snap.threads.size === 0) setTour(true);
  }, [snap.conn, snap.hello, snap.threads.size]);
  const [route, setRoute] = useState(() => location.hash.replace(/^#\/?/, '').split('/')[0] || 'threads');
  const go = (r: string) => {
    setRoute(r);
    history.replaceState(null, '', r === 'threads' ? '#/' : `#/${r}`);
  };
  const goRef = useRef(go);
  goRef.current = go;
  const page = PAGES.find((p) => p.id === route);
  const pageProps = { store, snap, openThread: (id: string) => { go('threads'); void store.open(id); } };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        store.deselect();
      }
      if (e.key === 'Escape') setHelp(false);
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        setHelp((h) => !h);
      }
      if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        const target = e.key === '1' ? 'threads' : PAGES[Number(e.key) - 2]?.id;
        if (target) {
          e.preventDefault();
          goRef.current(target);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('.side-top input')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  const drag = (e: React.PointerEvent) => {
    const start = e.clientX;
    const from = width;
    const move = (m: PointerEvent) => setWidth(clampWidth(from + m.clientX - start, window.innerWidth));
    const up = (m: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(WIDTH_KEY, String(clampWidth(from + m.clientX - start, window.innerWidth)));
      } catch {
        // not kept
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const offline = snap.conn !== 'open';
  return (
    <div className="app" style={{ ['--side' as string]: `${page && !page.Sidebar ? 0 : width}px` }}>
      <Rail route={page ? route : 'threads'} go={go} conn={snap.conn} help={() => setHelp(true)} snap={snap} />
      {page ? page.Sidebar ? <aside className="side"><page.Sidebar {...pageProps} /></aside> : <div /> : <Sidebar store={store} snap={snap} />}
      <div className="grip" onPointerDown={drag} />
      {help && <Shortcuts onClose={() => setHelp(false)} onTour={() => { setHelp(false); setTour(true); }} />}
      {tour && <Tour store={store} snap={snap} close={() => setTour(false)} />}
      <main className="main">
        {offline && (
          <div className={snap.conn === 'closed' ? 'banner bad' : 'banner'}>
            {snap.conn === 'connecting' ? 'Connecting to the runner...' : `Not connected to the runner${snap.connWhy ? `: ${snap.connWhy}` : ''}. Trying again.`}
            {snap.conn === 'closed' && /^no runner token/i.test(snap.connWhy ?? '') && " That means the runner isn't running, so there is nothing to connect to."}
            {snap.conn === 'closed' && isNative() && (
              <>
                {' '}
                <button className="ghost" disabled={starting} aria-busy={starting} onClick={() => void start()} title={starting ? 'Working on it: waiting for the runner to start, or for your answer to the window that opened' : 'Start the runner, or choose how it should start'}>
                  {starting ? 'Starting...' : 'Start the runner'}
                </button>
                {startProblem && <span className="error"> {startProblem}</span>}
              </>
            )}
          </div>
        )}
        {snap.notices.slice(-1).map((n, i) => (
          <div key={i} className={n.level === 'error' ? 'banner bad' : 'banner'}>
            {n.message}
          </div>
        ))}
        {page ? <page.Main {...pageProps} /> : snap.selected ? <ThreadView store={store} snap={snap} /> : <NewThread store={store} snap={snap} />}
      </main>
    </div>
  );
}

function NewThread({ store, snap }: { store: AppStore; snap: ReturnType<typeof useSnap> }) {
  return (
    <>
      <div className="empty">
        <h2>New thread</h2>
        <p>Pick a folder, then say what you'd like done.</p>
      </div>
      <Composer store={store} snap={snap} />
    </>
  );
}
