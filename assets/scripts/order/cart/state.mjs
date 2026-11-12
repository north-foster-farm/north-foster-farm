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
// shutByScroll: a page scroll minimized the open phone sheet (#559).
// kept: the person tapped Expand after that, so the sheet stays open
//   while the page scrolls, until one of the resets below. Nothing on
//   screen shows it: "you asked for it back, so it stays".

export const initial = () => ({
  placement: "floating", fold: "closed", empty: true, share: "",
  shutByScroll: false, kept: false,
});

// The stay-open choice and its cause, forgotten: Hide or Escape, the
// cart emptying, a settle or a lift-off, the pane changing form (a
// turn of the phone, a wider window). A reload starts from initial().
// The same object when there is nothing to forget.
export const forget = (state) => (state.kept || state.shutByScroll
  ? { ...state, kept: false, shutByScroll: false } : state);

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
  // A change of placement forgets the stay-open choice (#559): a
  // settled cart lifts off minimized, as before.
  if (column) return { ...forget(state), placement: "column", fold: "open" };
  if (short) return { ...forget(state), placement: "inline", fold: "open" };

  if (state.placement === "inline") {
    return slotTop > room - closedH
      ? { ...forget(state), placement: "floating", fold: "closed" }
      : state;
  }

  // Floating, or the first look: the column never floats, so a cart
  // leaving it is judged as a floating one.
  const settles = state.placement === "floating"
    ? slotTop <= room - height
    : slotTop <= room - closedH;

  return settles
    ? { ...forget(state), placement: "inline", fold: "open" }
    : { ...state, placement: "floating" };
};

const floating = (state) => state.placement === "floating";

// The same state object when nothing changes, so a caller can tell a
// move from a no-op by identity and start no ease for nothing. These
// two are the automatic folds (a fill from empty, the first Add's
// lesson and its shut): neither touches the stay-open choice.
export const open = (state) => (floating(state) && state.fold !== "open"
  ? { ...state, fold: "open" } : state);

export const close = (state) => (floating(state) && state.fold !== "closed"
  ? { ...state, fold: "closed" } : state);

// The person's own folds, the pill's Expand and Hide (#559). Expand
// after a scroll minimized the sheet keeps it open while the page
// scrolls (comparison shopping); Hide forgets that.
export const expand = (state) => {
  const next = open(state);

  if (next === state || !state.shutByScroll) return next;

  return { ...next, shutByScroll: false, kept: true };
};

export const hide = (state) => forget(close(state));

export const toggle = (state) => (state.fold === "open"
  ? hide(state) : expand(state));

// Escape folds a floating open cart, as Hide does. -> the state and
// whether it did, so the caller can move the focus to the pill.
export const escape = (state) => {
  const handled = floating(state) && state.fold === "open";

  return { state: handled ? hide(state) : state, handled };
};

// After a render: a floating cart that empties folds, and forgets the
// stay-open choice; one that fills from empty opens, unless an Add
// filled it (the Add's own word, the teach or the strip, says what
// happened). `was` is the last count, null before the first render,
// which counts as a fill. An Add to a kept cart keeps it: the person
// is mid-comparison.
export const rendered = (state, { count, was, adding = false }) => {
  const next = { ...state, empty: count === 0 };

  if (!floating(state)) return next;
  if (count === 0 && was !== 0) return forget(close(next));
  if (count > 0 && !was && !adding) return open(next);

  return next;
};

// How far the page must scroll, in either direction, to minimize the
// open phone sheet (#559, James agreed 2026-11-12): about one catalog
// line, so a nudge never does it.
export const MINIMIZE_AT = 48;

// One look at the page's scroll for the open phone sheet (#559). `y`
// is the page's scrollY, `from` where the count started (null: not
// counting). `sheet` is the phone's width class; `counts` that the
// person moved the page (not a scroll the page made, and not during
// an ease of the pane); `busy` that the pane is in use (the keyboard
// up, the focus on a field or a keyed control in it, the shared row
// open, Clear cart asking, a finger on the pane). -> the state and the
// new `from`. A scroll that does not count, or one while the pane is
// busy, moves the start along with it, so only the person's own
// travel since then adds up.
export const scrolled = (state, { y, from, sheet, counts, busy }) => {
  const watching = sheet && floating(state) && state.fold === "open"
    && !state.kept;

  if (!watching) return { state, from: null };
  if (!counts || busy || from === null) return { state, from: y };
  if (Math.abs(y - from) < MINIMIZE_AT) return { state, from };

  return {
    state: { ...state, fold: "closed", shutByScroll: true, kept: false },
    from: null,
  };
};

export const setShare = (state, share) => ({ ...state, share });

// The part of the data attributes the DOM mirrors. data-kept styles
// nothing: it is there for the specs and a look in the inspector.
export const attributes = (state) => ({
  "data-placement": state.placement,
  "data-fold": state.placement === "floating" ? state.fold : "open",
  "data-empty": state.empty ? "" : null,
  "data-share": state.share,
  "data-kept": state.kept ? "" : null,
});
