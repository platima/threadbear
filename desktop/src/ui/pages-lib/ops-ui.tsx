// Small pieces the Usage, Runners and Settings pages share.

import type { ReactNode } from 'react';
import type { ReqError } from './ops-rpc.ts';
import './ops.css';

export type Tone = 'ok' | 'warn' | 'bad' | undefined;

// A label and a figure over a bar. `percent` is how full the bar is.
export function Meter({ label, value, percent, tone, sub, title }: { label: ReactNode; value?: ReactNode; percent: number; tone?: Tone; sub?: ReactNode; title?: string }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <div className="ops-meter" title={title}>
      <div className="ops-meter-head">
        <span>{label}</span>
        {value !== undefined && <span className="ops-dim">{value}</span>}
      </div>
      <div className="ops-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
        <i className={tone} style={{ width: `${p}%` }} />
      </div>
      {sub ? <div className="ops-sub">{sub}</div> : null}
    </div>
  );
}

export function Chip({ children, tone, title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span className={`ops-chip${tone ? ` ${tone}` : ''}`} title={title ?? (typeof children === 'string' ? children : undefined)}>
      {children}
    </span>
  );
}

// Rows of a name and its figure.
// A row marked wide takes the whole line (long lists, paths).
export function Facts({ rows }: { rows: [string, ReactNode | undefined | false, boolean?][] }) {
  return (
    <dl className="ops-facts">
      {rows
        .filter(([, v]) => v !== undefined && v !== false && v !== '')
        .map(([k, v, wide]) => (
          <div key={k} className={wide ? 'wide' : undefined}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

export function Note({ children, tone }: { children: ReactNode; tone?: Tone }) {
  return <p className={`ops-note${tone ? ` ${tone}` : ''}`}>{children}</p>;
}

// Why a request couldn't be answered: a plain line, never a blank page.
export function Problem({ error, what }: { error?: ReqError; what: string }) {
  if (!error) return null;
  return <Note tone={error.missing ? undefined : 'bad'}>{error.missing ? `${what}: this runner doesn't have that yet. It may need updating.` : `${what}: ${error.message}`}</Note>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`ops-card ${className}`}>{children}</section>;
}

// Two-step action: the button asks, the bar beneath it confirms.
export function ConfirmBar({ text, yes, no = 'Never mind', onYes, onNo, busy }: { text: string; yes: string; no?: string; onYes: () => void; onNo: () => void; busy?: boolean }) {
  return (
    <div className="ops-confirm" role="alertdialog">
      <span>{text}</span>
      <span className="ops-confirm-btns">
        <button className="primary" onClick={onYes} disabled={busy} title={yes}>
          {yes}
        </button>
        <button onClick={onNo} disabled={busy} title="Close this without doing it">
          {no}
        </button>
      </span>
    </div>
  );
}
