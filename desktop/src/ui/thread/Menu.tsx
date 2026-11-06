import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <span className="tb-menu" ref={box}>
      <button type="button" className={`tb-menu-btn ${className}`} title={title} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {label}
        <span className="tb-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className={`tb-menu-list ${down ? 'down' : 'up'}`} role="menu">
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
