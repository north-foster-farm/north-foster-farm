// The cart's view state and every rule that moves it (#477, docs/cart.md
// 4.3). Pure: the Cart class reads the viewport and writes the DOM;
// nothing here touches either, so each rule is a unit test.
//
// placement: "column" from xl, where the cart is a column beside the
//   catalog; "inline" in its slot in the page's flow; "floating" fixed
//   at the foot of the screen below xl.
// fold: "open" or "closed". Only a floating cart folds; inline and
//   column are always open. What "closed" hides is the stylesheet's,
//   by width: a phone keeps the total and the foot, a tablet its right
//   column.
// empty: no lines.
// share: which side of the shared row is open: "way", "code" or "".

export const initial = () => ({
  placement: "floating", fold: "closed", empty: true, share: "",
});

// Where the cart goes, from one look at the page. `column` and `short`
// are the media queries (from xl; 500px tall or less). `slotTop` is
// the slot's top in the viewport, `room` the visible height less the
// rest margin, `height` the pane's height now and `closedH` the height
// it has closed. A floating cart settles when its slot's top rises to
// where the pane's top is; an inline one lifts off, closed, when its
// slot's top sinks below where the closed pane's top would be. The
// two thresholds differ by the pane's own growth, so a cart that
// settles and opens does not lift off again at once.
export const place = (state, {
  column, short, slotTop, room, height, closedH,
}) => {
  if (column) return { ...state, placement: "column", fold: "open" };
  if (short) return { ...state, placement: "inline", fold: "open" };

  if (state.placement === "inline") {
    return slotTop > room - closedH
      ? { ...state, placement: "floating", fold: "closed" }
      : state;
  }

  // Floating, or the first look: the column never floats, so a cart
  // leaving it is judged as a floating one.
  const settles = state.placement === "floating"
    ? slotTop <= room - height
    : slotTop <= room - closedH;

  return settles
    ? { ...state, placement: "inline", fold: "open" }
    : { ...state, placement: "floating" };
};

const floating = (state) => state.placement === "floating";

export const open = (state) => (floating(state)
  ? { ...state, fold: "open" } : state);

export const close = (state) => (floating(state)
  ? { ...state, fold: "closed" } : state);

export const toggle = (state) => (state.fold === "open"
  ? close(state) : open(state));

// Escape folds a floating open cart. -> the state and whether it did,
// so the caller can move the focus to the pill.
export const escape = (state) => {
  const handled = floating(state) && state.fold === "open";

  return { state: handled ? close(state) : state, handled };
};

// After a render: a floating cart that empties folds; one that fills
// from empty opens, unless an Add filled it (the Add's own word, the
// teach or the strip, says what happened). `was` is the last count,
// null before the first render, which counts as a fill.
export const rendered = (state, { count, was, adding = false }) => {
  const next = { ...state, empty: count === 0 };

  if (!floating(state)) return next;
  if (count === 0 && was !== 0) return close(next);
  if (count > 0 && !was && !adding) return open(next);

  return next;
};

export const setShare = (state, share) => ({ ...state, share });

// The part of the data attributes the DOM mirrors.
export const attributes = (state) => ({
  "data-placement": state.placement,
  "data-fold": state.placement === "floating" ? state.fold : "open",
  "data-empty": state.empty ? "" : null,
  "data-share": state.share,
});
