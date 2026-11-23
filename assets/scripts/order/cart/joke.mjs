// The code that is a joke: the cart shows a discount growing by this
// much a minute for as long as the page is open, and nothing else
// changes. The server has never heard of it. Pure
// (docs/refactors/cart.md, phase 1); joke-row.js draws it.

import { dollars } from "../lib/totals.mjs";

export const JOKE_CODE = "EGGBOI";
export const JOKE_PER_MINUTE = 4000;

// The row's label, as the cart shows it.
export const jokeLabel = () => `Discount (${JOKE_CODE}, ${
  dollars(JOKE_PER_MINUTE)}/min)`;

// The discount in whole cents, `ms` after the joke began.
export const jokeAmount = (ms) => {
  const minutes = ms / 60_000;

  return Math.floor(minutes * JOKE_PER_MINUTE);
};
