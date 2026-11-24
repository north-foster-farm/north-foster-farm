// The cart list's "more" arrows (docs/refactors/cart-view.md).

// Which "more" arrows show (#560): one wherever any part of the list
// lies past that edge, even a line only half under its fade. No count:
// counting whole rows missed the ones the fades half hide. A pixel's
// allowance at each end: iOS can rest a list at a fractional scrollTop.
export const moreShown = ({ top, height, full }) => ({
  up: top > 1,
  down: top + height < full - 1,
});

// How long the list's glide to a hidden row takes, from how far it
// goes in px: longer for a longer way, and never over 420 ms.
export const glideSpan = (px) => Math.min(420, 160 + px * 0.8);

// Where the glide is at `t` of its span, 0 to 1: eased out on a
// cubic curve, so it lands on the row gently.
export const glideAt = ({ from, to, t }) => from
  + (to - from) * (1 - (1 - t) ** 3);
