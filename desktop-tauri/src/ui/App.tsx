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
import { TerminalDock } from './TerminalDock.tsx';
import { isNative, startRunner, type RunnerWay } from '../core/native.ts';
import { RUNNER_CHOICE_TEXT, RUNNER_WAYS, startClick } from '../core/runner-start.ts';
import { targetFor, terminals } from '../core/terminals.ts';
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

// Whether the Terminal under the thread is showing. A shell never starts from this being on
// at launch: it starts when the person opens the panel or asks for one in it.
const TERMINAL_KEY = 'threadbear.terminalOpen';
const savedTerminal = (): boolean => {
  try {
    return localStorage.getItem(TERMINAL_KEY) === '1';
  } catch {
    return false;
  }
};

export function App({ store }: { store: AppStore }) {
  const snap = useSnap(store);
  const [width, setWidth] = useState(() => clampWidth(readWidth(saved()), window.innerWidth));
  const [help, setHelp] = useState(false);
  // The banner's Start the runner button: busy until the shell has started the runner (or has
  // answered that none is set up), so a second click can't start it twice. With none set up, the
  // banner offers the two ways to start one, in the page, where it can be seen. What went wrong
  // is said beside the button.
  const [starting, setStarting] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [startProblem, setStartProblem] = useState<string>();
  const start = async (way?: RunnerWay) => {
    setStarting(true);
    setChoosing(false);
    setStartProblem(undefined);
    if (way) {
      setStartProblem(await startRunner(way));
      setStarting(false);
      return;
    }
    const clicked = await startClick();
    setStarting(false);
    if (clicked.kind === 'choose') setChoosing(true);
    else setStartProblem(clicked.problem);
  };
  const [tour, setTour] = useState(false);
  // The Terminal: its panel under the page, and a counter that asks the screen to take the keyboard.
  const [term, setTerm] = useState(savedTerminal);
  const [termFocus, setTermFocus] = useState(0);
  const sessions = terminals();
  const target = targetFor(snap.selected ? snap.threads.get(snap.selected) : undefined);
  const showTerminal = (show: boolean) => {
    setTerm(show);
    try {
      localStorage.setItem(TERMINAL_KEY, show ? '1' : '0');
    } catch {
      // not kept
    }
    // Opening it (Ctrl+J, the rail's button) is asking for a shell: the one already there, or a new one.
    if (show) {
      sessions.ensure(target.key, target.cwd);
      setTermFocus((n) => n + 1);
    }
  };
  const showTerminalRef = useRef(showTerminal);
  showTerminalRef.current = showTerminal;
  const termRef = useRef(term);
  termRef.current = term;
  // A thread archived or deleted takes its shell with it.
  useEffect(() => {
    sessions.reconcile(snap.threads, snap.listings > 0);
  }, [sessions, snap.threads, snap.listings]);
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
      // Ctrl+J (or Ctrl+backtick) shows or hides the Terminal. In the terminal itself it comes here too.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === 'j' || e.key === '`')) {
        e.preventDefault();
        showTerminalRef.current(!termRef.current);
      }
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
      <Rail route={page ? route : 'threads'} go={go} conn={snap.conn} help={() => setHelp(true)} snap={snap} terminal={term} toggleTerminal={() => showTerminal(!term)} />
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
                <button className="ghost" disabled={starting} aria-busy={starting} onClick={() => void start()} title={starting ? 'Working on it: waiting for the runner to start' : 'Start the runner, or choose how it should start if none is set up'}>
                  {starting ? 'Starting...' : 'Start the runner'}
                </button>
                {startProblem && <span className="error"> {startProblem}</span>}
              </>
            )}
            {snap.conn === 'closed' && isNative() && choosing && (
              <div className="runnerChoice">
                <p>{RUNNER_CHOICE_TEXT}</p>
                {RUNNER_WAYS.map((w) => (
                  <button key={w.way} className="ghost" disabled={starting} onClick={() => void start(w.way)} title={w.tip}>
                    {w.label}
                  </button>
                ))}
                <button className="ghost" onClick={() => setChoosing(false)} title="Close this without setting up a runner">
                  Not now
                </button>
              </div>
            )}
          </div>
        )}
        {snap.notices.slice(-1).map((n, i) => (
          <div key={i} className={n.level === 'error' ? 'banner bad' : 'banner'}>
            {n.message}
          </div>
        ))}
        {page ? <page.Main {...pageProps} /> : snap.selected ? <ThreadView store={store} snap={snap} /> : <NewThread store={store} snap={snap} />}
        {term && <TerminalDock target={target} close={() => showTerminal(false)} focusTick={termFocus} />}
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
