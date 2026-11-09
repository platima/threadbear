// Where a menu's list goes (Menu.tsx): fixed to the window, from the button's own
// place, so that no scrolling box around the button can cut it off. The done
// card's Archive menu sits in the dock, which scrolls, and its list was clipped
// there and made a scrollbar. It opens upwards unless `down`, grows leftwards from
// a button in the right half of the window rather than off its edge, and keeps
// within the room there is.

import type { CSSProperties } from 'react';

export type Box = { left: number; right: number; top: number; bottom: number };

export function listPlace(r: Box, win: { width: number; height: number }, down: boolean): CSSProperties {
  const far = r.left > win.width / 2;
  const room = down ? win.height - r.bottom - 14 : r.top - 14;
  return {
    position: 'fixed',
    ...(down ? { top: r.bottom + 6, bottom: 'auto' } : { bottom: win.height - r.top + 6, top: 'auto' }),
    ...(far ? { right: Math.max(8, win.width - r.right), left: 'auto' } : { left: Math.max(8, r.left), right: 'auto' }),
    maxHeight: Math.max(120, Math.min(340, room)),
  };
}
