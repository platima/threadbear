// Small parts shared by the Projects and Schedules pages.
import { useState, type ReactNode } from 'react';
import './pages-lib.css';

// The last part of a path, either kind of slash: "acme-web".
export function folderLabel(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

// "in 5m", "in 3h", "in 2d", then the date. For a time that may be ahead.
export function until(ms: number, now = Date.now()): string {
  const s = (ms - now) / 1000;
  if (s <= 0) return 'now';
  if (s < 60) return 'in under a minute';
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `in ${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// "Fri 6 Nov, 9:00 am", in a named zone when there is one.
export function stamp(iso: string | number, timeZone?: string): string {
  const d = new Date(iso);
  const options: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
  try {
    return d.toLocaleString(undefined, timeZone ? { ...options, timeZone } : options);
  } catch {
    return d.toLocaleString(undefined, options);
  }
}

// A button that asks first, in place: "Delete" becomes "Delete it? Yes, delete / Keep it".
export function Confirm({
  label,
  question,
  yes,
  tip,
  danger,
  disabled,
  onConfirm,
}: {
  label: string;
  question: string;
  yes: string;
  tip: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button className={danger ? 'danger' : undefined} title={tip} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="pl-confirm" role="alert">
      <span>{question}</span>
      <button
        className={danger ? 'primary danger' : 'primary'}
        title={tip}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {yes}
      </button>
      <button title="Do nothing" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}

// A line under a heading that says what went wrong, or nothing.
export function ErrorLine({ text, onClear }: { text?: string; onClear?: () => void }) {
  if (!text) return null;
  return (
    <div className="pl-err" role="alert">
      <span>{text}</span>
      {onClear && (
        <button className="ghost" title="Hide this message" onClick={onClear}>
          Hide
        </button>
      )}
    </div>
  );
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="pl-section">
      <h3>
        <span>{title}</span>
        {aside && <span className="pl-aside">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}
