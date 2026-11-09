import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { listPlace } from './menuPlace.ts';
import './thread.css';

export type MenuItem = {
  key: string;
  label: ReactNode;
  note?: string; // a quieter line under the label
  on?: boolean; // the current choice
  disabled?: boolean;
  onPick: () => void;
};

// A button that opens a short list. It opens upwards by default, as these sit
// at the bottom of the thread.
export function Menu({ label, title, items, down = false, className = '', disabled = false }: { label: ReactNode; title: string; items: MenuItem[]; down?: boolean; className?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>();
  const box = useRef<HTMLSpanElement>(null);
  const toggle = () => {
    if (open) return setOpen(false);
    const r = box.current?.getBoundingClientRect();
    setPlace(r ? listPlace(r, { width: window.innerWidth, height: window.innerHeight }, down) : undefined);
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    // The list is fixed to the window, so a scroll or a resize that moves the button shuts it
    // (a scroll inside the list itself does not).
    const moved = (e: Event) => !box.current?.contains(e.target as Node) && setOpen(false);
    const resized = () => setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', moved, true);
    window.addEventListener('resize', resized);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', resized);
    };
  }, [open]);
  return (
    <span className="tb-menu" ref={box}>
      <button type="button" className={`tb-menu-btn ${className}`} title={title} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={toggle}>
        {label}
        <span className="tb-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className={`tb-menu-list ${down ? 'down' : 'up'}`} role="menu" style={place}>
          {items.map((it) => (
            <button
              type="button"
              key={it.key}
              role="menuitemradio"
              aria-checked={!!it.on}
              className={it.on ? 'on' : ''}
              disabled={it.disabled}
              title={it.note ? `${typeof it.label === 'string' ? it.label : ''} ${it.note}`.trim() : typeof it.label === 'string' ? it.label : it.key}
              onClick={() => {
                setOpen(false);
                it.onPick();
              }}
            >
              <span className="tb-tick">{it.on ? '✓' : ''}</span>
              <span className="tb-item">
                <span>{it.label}</span>
                {it.note && <small>{it.note}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
