// The account's tab row on a narrow screen (#579), on the cart's
// pattern (#560): a round arrow and a fade at the row's end while any
// tab lies past it, and a tap that brings the first tab cut off to the
// row's start. Their mirror at the row's start (#591): an arrow and a
// fade while any tab lies before it, and a tap that brings the last
// tab cut off there to the row's end. Pure, so the tests can reach it.

// `view` is { left, width, full } (scrollLeft, clientWidth,
// scrollWidth). A pixel's allowance: a row can rest at a fractional
// scrollLeft, as the cart's list does at a fractional scrollTop.
export const tabsMore = ({ left, width, full }) => left + width < full - 1;

// The same at the row's start, with the same allowance.
export const tabsBack = ({ left }) => left > 1;

// `tabs` are { left, right } in the row's own scroll space, and `edge`
// the width of each end's fade, with its arrow on it. A tab that lies
// under a fade is cut off: the arrow would cover its first or last
// letters (#591, "Membership" read "embership"). So each arrow brings
// the tab clear of the fade at the far end as well, where the other
// arrow shows once the row has moved, and a tab the row stops short of
// is visibly faded under the arrow, at both ends alike. Neither goes
// past its end, where that end's arrow and fade are gone.

// The end's arrow: the first tab cut off at the end starts just past
// the start's fade, or at the row's start when it's that close.
export const tabsStop = (tabs, { left, width, full }, edge = 0) => {
  const max = Math.max(0, full - width);
  const next = tabs.find((t) => t.right > left + width - edge + 1);
  let to = left;

  if (next) {
    to = next.left - edge;
    // A tab too wide for the row between the fades: its end comes
    // clear of the end's fade instead, so the row still moves on.
    if (to <= left + 1) to = next.right - width + edge;
  }

  return Math.min(max, Math.max(0, Math.round(to)));
};

// The start's arrow: the last tab cut off at the start ends just
// before the end's fade, or, too wide for the row between the fades,
// starts just past the start's.
export const tabsBackStop = (tabs, { left, width, full }, edge = 0) => {
  const max = Math.max(0, full - width);
  const prev = tabs.findLast((t) => t.left < left + edge - 1);
  const to = prev
    ? Math.min(prev.left - edge, prev.right - width + edge) : 0;

  return Math.min(max, Math.max(0, Math.round(to)));
};
