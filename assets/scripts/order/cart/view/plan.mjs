// What the cart view decides from what it measured: pure, for the unit
// tests (docs/refactors/cart-view.md).

import { moves } from "./frames.mjs";
import { toPx } from "./units.mjs";

// The closed height the lift-off threshold uses (view/placement.js):
// the pane's own height as last measured floating and closed (`seen`),
// and the stylesheet's --cart-closed-h (`css`, at the root font size
// `font`), a lower bound, only until one has been measured.
export const closedHeight = ({ seen, css, font }) => seen || toPx(css, font);

// The band a focused control is kept within (view/focus.js): under the
// top bar's foot (`barFoot`), and above the floating pane's top while
// it covers the foot (`over`), or above the screen's foot (`screen`)
// otherwise. The floating pane covers the foot only while it rides
// there; one the page has scrolled past is above the screen.
export const focusRoom = ({ floating, paneTop, barFoot, screen }) => {
  const over = floating && paneTop > barFoot;

  return {
    over,
    floor: over ? Math.min(paneTop, screen) : screen,
    ceiling: barFoot,
  };
};

// The parts a move eases (view/move.js): those still in the page whose
// size changes (moves), each with `heldAt`, the height its inner
// scroller keeps while it eases, the larger of its two. Every other key
// of a part is kept.
export const movePlan = (parts) => parts
  .map((p) => ({ ...p, heldAt: Math.max(p.heldWas, p.heldNow) }))
  .filter((p) => p.connected && moves(p.was, p.now));

// Whether Clear cart moves: it comes, it goes, or it stays and its
// place changes.
export const pillMoves = (was, now) => was.shown !== now.shown
  || (was.shown && (was.transform !== now.transform
    || was.right !== now.right));

// A lift-off: the pane floats after the change and did not before.
export const lifting = ({ floatingWas, floating }) => floating && !floatingWas;

// Whether the body stays held at its end through a move. A scroll from
// anywhere but where the hold last left it (`left`), the person's or
// the code field brought into view, is kept, and the hold lets go.
// Under the keyboard (`kb`) the body scrolls as a whole and the field
// is the place to keep, so nothing is held (cart-keyboard spec: a body
// scrolled to its top was put back at its end, 166px down). A body
// that shrank under its scroll, clamped to its new end, is still at
// its end.
export const holds = ({ kb, top, left, height, full }) => !(kb > 0)
  && !(Math.abs(top - left) > 1 && top + height < full - 1);
