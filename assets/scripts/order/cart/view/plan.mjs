// What the cart view decides from what it measured: pure, for the unit
// tests (docs/refactors/cart-view.md).

import { toPx } from "./units.mjs";

// The closed height the lift-off threshold uses (view/placement.js):
// the pane's own height as last measured floating and closed (`seen`),
// and the stylesheet's --cart-closed-h (`css`, at the root font size
// `font`), a lower bound, only until one has been measured.
export const closedHeight = ({ seen, css, font }) => seen || toPx(css, font);
