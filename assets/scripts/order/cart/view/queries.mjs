// The cart view's media queries (docs/refactors/cart-view.md).

// The width and height classes the state reads. The stylesheet's
// $cart-short and the xl breakpoint are the same queries.
export const COLUMN = "(min-width: 1200px)";
export const SHORT = "(max-height: 500px)";
// The one-column sheet: the stylesheet's $cart-sheet. The rules for a
// scroll (#559) and the motion of its parts are the sheet's alone; the
// tablet's panel keeps its own.
export const SHEET = "(max-width: 575.98px), "
  + "(max-width: 1199.98px) and (max-height: 500px)";
