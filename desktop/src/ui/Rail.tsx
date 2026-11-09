import { useState } from 'react';
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
export function Rail({ route, go, conn, help }: { route: string; go: (route: string) => void; conn: string; help: () => void }) {
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
  const items = [
    { id: 'threads', title: 'Threads', hint: 'Your threads: the inbox, what is running, and what is hibernating or archived', icon: '☰', news: undefined as string | undefined },
    ...PAGES.map((p) => ({ id: p.id, title: p.title, hint: p.hint, icon: p.icon, news: p.id === 'updates' && update ? `Version ${update.version} is out.` : undefined })),
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
          {p.news && <span className="railBadge" aria-hidden="true" />}
        </button>
      ))}
      <span className="grow" />
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
