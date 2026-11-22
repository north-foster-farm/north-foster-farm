// What a move measures of the pane and its parts
// (docs/refactors/cart-view.md).

import { CHROME } from "./frames.mjs";

// The foot's buttons, which ease their width in a move.
export const SIDEWAYS = ".order-cart-toggle, .order-cart-next";

export const movers = (pane) => [
  ...(pane.querySelector("[data-cart-body]")?.children || []),
  ...(pane.querySelector("[data-part='foot']")?.children || []),
];

// What a part that comes or goes takes up besides its size: its
// padding, its borders and its margins, which display: none takes away
// in one frame. A body part's are above and below it, a foot button's
// beside it, where the foot's gap after it goes too (its right margin
// takes the gap back). Eased with the size, so nothing is left to snap
// when the ease ends (#559: the sums', the badges' and the shared
// row's padding, about 40px, dropped in the last frame of a minimize).
const ROOM = {
  down: [
    "paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth",
    "marginTop", "marginBottom",
  ],
  across: [
    "paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth",
    "marginRight",
  ],
};

// The scroller inside a part, which keeps one size while its part
// eases: see view/move.js moveParts.
export const HELD = "[data-cart-scroll]";

export const outerHeight = (el) => (el && el.getClientRects().length
  ? el.getBoundingClientRect().height : 0);

export const sizeOf = (el) => {
  const rects = el.getClientRects();

  if (!rects.length) return { shown: false, size: 0 };

  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const sideways = el.matches(SIDEWAYS);
  const room = Object.fromEntries(
    ROOM[sideways ? "across" : "down"].map((name) => [name, style[name]])
  );

  return {
    shown: true,
    size: sideways ? r.width : r.height,
    display: style.display,
    room,
    gap: sideways && el.nextElementSibling?.getClientRects().length
      ? parseFloat(getComputedStyle(el.parentElement).columnGap) || 0 : 0,
  };
};

export const chromeOf = (pane) => {
  const style = getComputedStyle(pane);

  return Object.fromEntries(CHROME.map((name) => [name, style[name]]));
};

// Clear cart, which stands astride the pane's edge and takes no room:
// where it stands and whether it shows.
export const CLEAR = "[data-cart-clear]";

export const pillOf = (el) => {
  if (!el || !el.getClientRects().length) return { shown: false };

  const style = getComputedStyle(el);

  return {
    shown: true, display: style.display, transform: style.transform,
    right: style.right,
  };
};
