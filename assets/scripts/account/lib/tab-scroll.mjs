// The account's tab row on a narrow screen (#579), on the cart's
// pattern (#560): a round arrow and a fade at the row's end while any
// tab lies past it, and a tap that brings the first tab cut off to the
// row's start. Pure, so the tests can reach it.

import { moreStop } from "../../order/lib/cart-scroll.mjs";

// `view` is { left, width, full } (scrollLeft, clientWidth,
// scrollWidth). A pixel's allowance: a row can rest at a fractional
// scrollLeft, as the cart's list does at a fractional scrollTop.
export const tabsMore = ({ left, width, full }) => left + width < full - 1;

// Where the arrow takes the row: `tabs` are { left, right } in the
// row's own scroll space. Never past the end.
export const tabsStop = (tabs, { left, width, full }) => moreStop(
  tabs.map((t) => ({ top: t.left, bottom: t.right })),
  { top: left, height: width, full }, 1
);
