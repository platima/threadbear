import { useId } from 'react';

// The Usage icon, as the Mac app draws it: a little line-drawn honey pot on a 24 grid, with honey
// filled to `level` (0 to 1) behind its outline. The outline takes the rail's colour; the honey is
// the one amber on the rail, and faint.
const BODY = 'M8.2 9.6 C4.2 10.6 3.6 19.4 7.6 20.8 L16.4 20.8 C20.4 19.4 19.8 10.6 15.8 9.6 Z';

export function HoneyPot({ level }: { level: number }) {
  const clip = useId();
  // Rim to floor is 9.6 to 20.8 on the grid.
  const top = 9.6 + (1 - Math.min(1, Math.max(0, level))) * 11.2;
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={clip}>
          <path d={BODY} />
        </clipPath>
      </defs>
      <rect x="0" y={top} width="24" height={24 - top} fill="#d9a441" fillOpacity="0.55" clipPath={`url(#${clip})`} />
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d={BODY} />
        <rect x="7" y="7.1" width="10" height="2.5" rx="1.25" />
        <path d="M8.4 7.1 C9 4.9 15 4.9 15.6 7.1" />
        <circle cx="12" cy="4.1" r="0.9" />
      </g>
    </svg>
  );
}
