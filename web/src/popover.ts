// Keeping a menu's panel on the screen. A panel hangs off a button and is as wide as
// its content, so wherever the button is near an edge it can run past it: the share
// panel, anchored to the share button's right edge, began 24 px left of a 360 px
// phone. CSS cannot know where the button is, so menu.tsx measures the panel after it
// opens and slides it back in by what this says. It is pure (no DOM) so it can be tested.

// A horizontal extent, in the same units as getBoundingClientRect.
export type Span = { left: number; right: number };

// How far to move `panel` sideways (positive is right) to bring it inside `view` with
// `margin` clear on each side. A panel that is already inside is left alone (0). One
// wider than the room cannot fit, so its left edge is put on the margin: the start of
// its text matters more than its end.
export function popoverShift(panel: Span, view: Span, margin = 8): number {
  const min = view.left + margin;
  const max = view.right - margin;
  if (panel.right - panel.left > max - min) return min - panel.left;
  if (panel.left < min) return min - panel.left;
  if (panel.right > max) return max - panel.right;
  return 0;
}
