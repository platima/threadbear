// A small button with a menu under it: the thread's ..., the sidebar's sort
// and filter. A <details>, so it opens with no state of its own; usePopover
// adds what <details> doesn't do: closing on a click outside or Escape, and
// keeping the panel on the screen. The share panel is a <details> of its own
// and takes the same hook.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { popoverShift } from './popover';

// What the page lets a panel use across: the window less what the app is drawn
// under at the sides (a cutout, or the navigation bar on the side of a phone
// turned on its side), which #root pads by.
function room() {
  const root = document.getElementById('root');
  const pad = root ? getComputedStyle(root) : undefined;
  return {
    left: parseFloat(pad?.paddingLeft ?? '') || 0,
    right: document.documentElement.clientWidth - (parseFloat(pad?.paddingRight ?? '') || 0),
  };
}

// Slides an open panel back inside the page. The shift is a CSS variable (.pop-panel
// turns it into a transform), measured from where the stylesheet puts the panel, so it
// is worked out afresh each time and is gone when the panel is closed.
function keepOnScreen(pop: HTMLDetailsElement) {
  const panel = pop.querySelector<HTMLElement>(':scope > .pop-panel');
  if (!panel) return;
  panel.style.removeProperty('--pop-shift');
  if (!pop.open) return;
  const shift = Math.round(popoverShift(panel.getBoundingClientRect(), room()));
  if (shift) panel.style.setProperty('--pop-shift', `${shift}px`);
}

export function usePopover() {
  const ref = useRef<HTMLDetailsElement>(null);
  const close = () => {
    if (ref.current) ref.current.open = false;
  };
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ref.current) ref.current.open = false;
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  // Set up before the first paint, and each of these fits the panel before the next one,
  // so it is never seen where it would run off. Opening is a change of the `open`
  // attribute, which an observer hears in the same task as the tap (a toggle event comes
  // a frame later). A panel that changes size while open, and the phone turning, are the
  // others.
  useLayoutEffect(() => {
    const pop = ref.current;
    const panel = pop?.querySelector(':scope > .pop-panel');
    if (!pop || !panel) return;
    const fit = () => keepOnScreen(pop);
    const opened = new MutationObserver(fit);
    opened.observe(pop, { attributes: true, attributeFilter: ['open'] });
    const resized = new ResizeObserver(fit);
    resized.observe(panel);
    for (const type of ['resize', 'orientationchange']) window.addEventListener(type, fit);
    return () => {
      opened.disconnect();
      resized.disconnect();
      for (const type of ['resize', 'orientationchange']) window.removeEventListener(type, fit);
    };
  }, []);
  return { ref, close };
}

export function Pop({ title, icon, lit, children }: { title: string; icon: ReactNode; lit?: boolean; children: (close: () => void) => ReactNode }) {
  const { ref, close } = usePopover();
  return (
    <details className="pop" ref={ref}>
      <summary className={`icon-btn ${lit ? 'lit-btn' : ''}`} title={title} aria-label={title}>
        {icon}
      </summary>
      <div className="pop-panel menu">{children(close)}</div>
    </details>
  );
}

// A menu row that's one of a set: its icon, its words, and a tick on the one
// in force.
export function MenuChoice({ icon, label, note, on, pick }: { icon: ReactNode; label: string; note?: ReactNode; on: boolean; pick: () => void }) {
  return (
    <button className="menu-choice" role="menuitemradio" aria-checked={on} title={label} onClick={pick}>
      {icon}
      <span className="menu-label">{label}</span>
      {note !== undefined ? <span className="menu-note">{note}</span> : null}
      <span className="menu-tick">{on ? <Tick /> : null}</span>
    </button>
  );
}

function Tick() {
  return (
    <svg fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3 8.5 3.3 3.3L13 4.7" />
    </svg>
  );
}
