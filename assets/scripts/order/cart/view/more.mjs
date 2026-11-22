// The cart list's "more" arrows (docs/refactors/cart-view.md).

// Which "more" arrows show (#560): one wherever any part of the list
// lies past that edge, even a line only half under its fade. No count:
// counting whole rows missed the ones the fades half hide. A pixel's
// allowance at each end: iOS can rest a list at a fractional scrollTop.
export const moreShown = ({ top, height, full }) => ({
  up: top > 1,
  down: top + height < full - 1,
});
