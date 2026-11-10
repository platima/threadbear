// The Usage page's two charts, drawn as plain inline SVG: tokens by the hour
// (bars) and limit readings over time (lines). Hovering a chart reads the
// figures under the pointer into the line above it.

import { useEffect, useRef, useState } from 'react';
import { compact } from './ops-format.ts';

const HOUR = 3_600_000;
const H = 150;
const L = 40;
const R = 8;
const T = 8;
const B = 20;
const PH = H - T - B;

// The chart is drawn at the width it has, so its text stays one size.
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, Math.floor(el.clientWidth))));
    ro.observe(el);
    setW(Math.max(280, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export type HourRow = [number, number, number, number, number];
export type Sample = [number, number];

// Local midnights inside the range, with a label for each.
function dayMarks(from: number, to: number, long: boolean): { t: number; label: string }[] {
  const marks: { t: number; label: string }[] = [];
  const d = new Date(from);
  d.setHours(24, 0, 0, 0);
  let n = 0;
  for (; d.getTime() < to; d.setDate(d.getDate() + 1), n++) {
    marks.push({ t: d.getTime(), label: long ? (n % 2 === 0 ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '') : d.toLocaleDateString(undefined, { weekday: 'short' }) });
  }
  return marks;
}

// 1, 2, 5 times a power of ten, at or above n.
function niceMax(n: number): number {
  if (n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

const stamp = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function TokensChart({ hours, since, now, cache, label }: { hours: HourRow[]; since: number; now: number; cache: boolean; label: string }) {
  const start = Math.floor(since / HOUR) * HOUR;
  const n = Math.max(1, Math.floor((now - start) / HOUR) + 1);
  const fresh = new Array<number>(n).fill(0);
  const cached = new Array<number>(n).fill(0);
  for (const [t, input, output, read, write] of hours) {
    const i = Math.round((t - start) / HOUR);
    if (i < 0 || i >= n) continue;
    fresh[i] += input + output;
    cached[i] += read + write;
  }
  const totals = fresh.map((f, i) => f + (cache ? cached[i]! : 0));
  const top = niceMax(Math.max(...totals));
  const y = (v: number) => T + PH - (v / top) * PH;
  const [ref, W] = useWidth();
  const PW = W - L - R;
  const slot = PW / n;
  const [hover, setHover] = useState<number>();
  const days = (now - start) / (24 * HOUR);
  const marks = dayMarks(start, now, days > 7);

  const move = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.floor((x - L) / slot))));
  };

  const readout =
    hover === undefined
      ? 'Point at the chart to read an hour.'
      : `${stamp(start + hover * HOUR)}: ${compact(fresh[hover]!)} new tokens${cache ? `, ${compact(cached[hover]!)} cached` : ''}`;

  return (
    <div className="usage-chart" ref={ref}>
      <div className="usage-readout">{readout}</div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onMouseMove={move} onMouseLeave={() => setHover(undefined)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={y(top * f)} y2={y(top * f)} className="usage-grid" />
            <text x={L - 5} y={y(top * f) + 3} textAnchor="end" className="usage-tick">
              {compact(top * f)}
            </text>
          </g>
        ))}
        {marks.map((m) => {
          const x = L + ((m.t - start) / HOUR) * slot;
          return (
            <g key={m.t}>
              <line x1={x} x2={x} y1={T} y2={T + PH} className="usage-day" />
              <text x={x + 3} y={H - 6} className="usage-tick">
                {m.label}
              </text>
            </g>
          );
        })}
        {fresh.map((f, i) => {
          const x = L + i * slot;
          const w = Math.max(slot - (n <= 100 ? 1 : 0.3), 0.6);
          return (
            <g key={i}>
              {f > 0 && <rect x={x} y={y(f)} width={w} height={T + PH - y(f)} className="usage-bar fresh" />}
              {cache && cached[i]! > 0 && <rect x={x} y={y(f + cached[i]!)} width={w} height={y(f) - y(f + cached[i]!)} className="usage-bar cache" />}
            </g>
          );
        })}
        {hover !== undefined && <rect x={L + hover * slot} y={T} width={Math.max(slot, 1)} height={PH} className="usage-hover" />}
      </svg>
    </div>
  );
}

export type LimitSeries = { kind: 'five_hour' | 'weekly'; label: string; className: string; samples: Sample[] };

export function LimitsChart({ series, since, now, label }: { series: LimitSeries[]; since: number; now: number; label: string }) {
  const span = Math.max(now - since, 1);
  const [ref, W] = useWidth();
  const PW = W - L - R;
  const x = (t: number) => L + ((Math.min(Math.max(t, since), now) - since) / span) * PW;
  const y = (used: number) => T + PH - (Math.max(0, Math.min(100, used)) / 100) * PH;
  const [hover, setHover] = useState<number>();
  const marks = dayMarks(since, now, span / (24 * HOUR) > 7);

  const move = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(since + Math.max(0, Math.min(1, (px - L) / PW)) * span);
  };

  // A reading holds until the next one, so the figure at a time is the last
  // reading at or before it.
  const at = (s: Sample[], t: number): number | undefined => {
    let found: number | undefined;
    for (const [when, remaining] of s) {
      if (when > t) break;
      found = 100 - remaining;
    }
    return found;
  };

  const readout =
    hover === undefined
      ? 'Point at the chart to read a time.'
      : `${stamp(hover)}: ` +
        (series
          .map((s) => {
            const v = at(s.samples, hover);
            return v === undefined ? undefined : `${s.label} ${Math.round(v)}% used`;
          })
          .filter(Boolean)
          .join(', ') || 'no reading yet');

  return (
    <div className="usage-chart" ref={ref}>
      <div className="usage-readout">{readout}</div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onMouseMove={move} onMouseLeave={() => setHover(undefined)}>
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="usage-grid" />
            <text x={L - 5} y={y(v) + 3} textAnchor="end" className="usage-tick">
              {v}%
            </text>
          </g>
        ))}
        {marks.map((m) => (
          <g key={m.t}>
            <line x1={x(m.t)} x2={x(m.t)} y1={T} y2={T + PH} className="usage-day" />
            <text x={x(m.t) + 3} y={H - 6} className="usage-tick">
              {m.label}
            </text>
          </g>
        ))}
        {series.map((s) => {
          const pts = s.samples.filter(([t]) => t >= since && t <= now);
          if (!pts.length) return null;
          const last = pts[pts.length - 1]!;
          const d = pts.map(([t, remaining], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(100 - remaining).toFixed(1)}`).join('') + `L${x(now).toFixed(1)} ${y(100 - last[1]).toFixed(1)}`;
          return <path key={s.kind} d={d} className={`usage-line ${s.className}`} />;
        })}
        {hover !== undefined && <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + PH} className="usage-cursor" />}
      </svg>
    </div>
  );
}
