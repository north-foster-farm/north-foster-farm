// Whether a page scroll is the person's own (#559): one that follows
// a finger, a wheel or a scrolling key outside the pane, or the
// momentum that carries on from one. A scroll the page makes (Proceed
// to checkout, the bar's total going back to the cart, Tab moving a
// field clear of the pane, the code field coming into view) has none
// of those before it. Inside the pane a touch or a wheel scrolls the
// pane, never the page (overscroll-behavior: contain).

// How long after the person's last input, or the last scroll that was
// theirs, a scroll still counts: momentum sends one a frame.
export const OWN_MS = 150;

export const ownScroll = ({ now, input, last, touching }) => touching
  || now - input < OWN_MS || now - last < OWN_MS;

const SCROLL_KEYS = new Set([
  "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " ",
]);

// Whether a key scrolls the page: one of SCROLL_KEYS, never in a
// field that takes text (`field`), and never Space on a button or a
// link (`control`), which presses it and scrolls nothing.
export const scrollKey = ({ key, field, control }) => SCROLL_KEYS.has(key)
  && !field && !(key === " " && control);
