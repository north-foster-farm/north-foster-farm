// What the cart view decides from what it measured: pure, for the unit
// tests (docs/refactors/cart-view.md).

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
