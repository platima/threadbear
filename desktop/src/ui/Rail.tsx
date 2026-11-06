import { PAGES } from './registry.ts';

// The strip down the left edge: Threads, then each page.
export function Rail({ route, go, conn }: { route: string; go: (route: string) => void; conn: string }) {
  const items = [{ id: 'threads', title: 'Threads', icon: '☰' }, ...PAGES.map((p) => ({ id: p.id, title: p.title, icon: p.icon }))];
  return (
    <nav className="rail">
      {items.map((p) => (
        <button key={p.id} className={`ghost${route === p.id ? ' on' : ''}`} title={p.title} aria-label={p.title} onClick={() => go(p.id)}>
          {p.icon}
        </button>
      ))}
      <span className="grow" />
      <span className={`railDot ${conn}`} title={conn === 'open' ? 'Connected to the runner' : 'Not connected to the runner'} />
    </nav>
  );
}
