// The account's tab row on a narrow screen (#579), on the cart's
// pattern (#560): a round arrow and a fade at the row's end while any
// tab lies past it, and a tap that brings the first tab cut off to the
// row's start. Their mirror at the row's start (#591): an arrow and a
// fade while any tab lies before it, and a tap that brings the last
// tab cut off there to the row's end. Pure, so the tests can reach it.

import { moreStop } from "../../order/lib/cart-scroll.mjs";

// `view` is { left, width, full } (scrollLeft, clientWidth,
// scrollWidth). A pixel's allowance: a row can rest at a fractional
// scrollLeft, as the cart's list does at a fractional scrollTop.
export const tabsMore = ({ left, width, full }) => left + width < full - 1;

// The same at the row's start, with the same allowance.
export const tabsBack = ({ left }) => left > 1;

// Where the arrow takes the row: `tabs` are { left, right } in the
// row's own scroll space. Never past the end.
export const tabsStop = (tabs, { left, width, full }) => moreStop(
  tabs.map((t) => ({ top: t.left, bottom: t.right })),
  { top: left, height: width, full }, 1
);

// Where the start's arrow takes the row: the last tab cut off at the
// start ends at the row's end, or, wider than the row, starts at its
// start. Never past the start.
export const tabsBackStop = (tabs, { left, width, full }) => {
  const max = Math.max(0, full - width);
  const prev = tabs.findLast((t) => t.left < left - 1);
  const to = prev ? Math.min(prev.left, prev.right - width) : 0;

  return Math.min(max, Math.max(0, Math.round(to)));
};
