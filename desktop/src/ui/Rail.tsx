import { useState } from 'react';
import { PAGES } from './registry.ts';

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

// The strip down the left edge: Threads, then each page.
export function Rail({ route, go, conn, help }: { route: string; go: (route: string) => void; conn: string; help: () => void }) {
  const [theme, setTheme] = useState<Theme>(readTheme);
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
  const items = [{ id: 'threads', title: 'Threads', icon: '☰' }, ...PAGES.map((p) => ({ id: p.id, title: p.title, icon: p.icon }))];
  return (
    <nav className="rail">
      {items.map((p) => (
        <button key={p.id} className={`ghost${route === p.id ? ' on' : ''}`} title={p.title} aria-label={p.title} onClick={() => go(p.id)}>
          {p.icon}
        </button>
      ))}
      <span className="grow" />
      <button className="ghost" title={`Appearance: ${theme}. Click to change.`} aria-label="Appearance" onClick={cycle}>
        {theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}
      </button>
      <button className="ghost" title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onClick={help}>
        ?
      </button>
      <span className={`railDot ${conn}`} title={conn === 'open' ? 'Connected to the runner' : 'Not connected to the runner'} />
    </nav>
  );
}
