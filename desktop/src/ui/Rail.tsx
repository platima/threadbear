import { useState } from 'react';
import type { Snapshot } from '../core/store.ts';
import { PAGES, tip } from './registry.ts';
import { useAvailableUpdate } from './update-state.ts';

type Theme = 'auto' | 'dark' | 'light';
const THEME_KEY = 'threadbear.theme';
const apply = (t: Theme) => {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
};
const readTheme = (): Theme => {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'dark' || v === 'light' ? v : 'auto';
  } catch {
    return 'auto';
  }
};
apply(readTheme());

// The strip down the left edge: Threads, then each page. The Updates page's button
// carries a dot, and says so in its tooltip, while a newer release is out.
export function Rail({ route, go, conn, help, snap, terminal, toggleTerminal }: { route: string; go: (route: string) => void; conn: string; help: () => void; snap: Snapshot; terminal: boolean; toggleTerminal: () => void }) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const update = useAvailableUpdate();
  const cycle = () => {
    const next: Theme = theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto';
    setTheme(next);
    apply(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // not kept
    }
  };
  type Item = { id: string; title: string; hint?: string; icon: string; dot?: 'accent' | 'quiet'; news?: string };
  const items: Item[] = [
    { id: 'threads', title: 'Threads', hint: 'Your threads: the inbox, what is running, and what is hibernating or archived', icon: '☰' },
    ...PAGES.filter((p) => p.available?.(snap) ?? true).map((p): Item => {
      // Updates: a dot while a newer release is out. Others say it themselves (Connectors).
      const signal = p.id === 'updates' && update ? { dot: 'accent' as const, tip: `Version ${update.version} is out.` } : p.signal?.(snap);
      return { id: p.id, title: p.title, hint: p.hint, icon: p.icon, dot: signal?.dot, news: signal?.tip };
    }),
  ];
  return (
    <nav className="rail">
      {items.map((p) => (
        <button
          key={p.id}
          className={`ghost${route === p.id ? ' on' : ''}`}
          title={tip(p.title, p.news ? `${p.news} ${p.hint ?? ''}`.trim() : p.hint)}
          aria-label={p.news ? `${p.title}: ${p.news}` : p.title}
          onClick={() => go(p.id)}
        >
          {p.icon}
          {p.dot && <span className={`railBadge${p.dot === 'quiet' ? ' quiet' : ''}`} aria-hidden="true" />}
        </button>
      ))}
      <span className="grow" />
      <button className={`ghost${terminal ? ' on' : ''}`} title="Terminal: a shell in this thread's folder, under the thread. Ctrl+J shows or hides it. Its shells keep running while it is hidden." aria-label="Terminal" aria-pressed={terminal} onClick={toggleTerminal}>
        &gt;_
      </button>
      <button className="ghost" title={`Appearance: ${theme === 'auto' ? "follows your system's light or dark setting" : theme}. Click to go round: system, dark, light.`} aria-label="Appearance" onClick={cycle}>
        {theme === 'dark' ? '☾' : theme === 'light' ? '☀︎' : '◐'}
      </button>
      <button className="ghost" title="Keyboard shortcuts, and a replay of the tour of the app" aria-label="Keyboard shortcuts" onClick={help}>
        ?
      </button>
      <span className={`railDot ${conn}`} title={conn === 'open' ? 'Connected to the runner, which does the work behind the app' : 'Not connected to the runner, which does the work behind the app. The banner at the top has a button to start it.'} />
    </nav>
  );
}
