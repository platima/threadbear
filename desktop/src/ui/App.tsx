import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AppStore } from '../core/store.ts';
import { clampWidth, readWidth } from '../../../web/src/sections.ts';
import { Sidebar } from './Sidebar.tsx';
import { ThreadView } from './ThreadView.tsx';
import { Composer } from './Composer.tsx';

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        store.deselect();
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
    <div className="app" style={{ ['--side' as string]: `${width}px` }}>
      <Sidebar store={store} snap={snap} />
      <div className="grip" onPointerDown={drag} />
      <main className="main">
        {offline && (
          <div className={snap.conn === 'closed' ? 'banner bad' : 'banner'}>
            {snap.conn === 'connecting' ? 'Connecting to the runner...' : `Not connected to the runner${snap.connWhy ? `: ${snap.connWhy}` : ''}. Trying again.`}
          </div>
        )}
        {snap.notices.slice(-1).map((n, i) => (
          <div key={i} className={n.level === 'error' ? 'banner bad' : 'banner'}>
            {n.message}
          </div>
        ))}
        {snap.selected ? <ThreadView store={store} snap={snap} /> : <NewThread store={store} snap={snap} />}
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
