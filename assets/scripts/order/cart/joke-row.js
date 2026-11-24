// The joke's row in the cart's sums (joke.mjs), above the fee, ticking
// once a second (docs/refactors/cart.md, phase 1).

import { dollars } from "../lib/totals.mjs";
import { qs } from "./dom.js";
import { jokeAmount, jokeLabel } from "./joke.mjs";

// Draws the row in `root`, the cart, and starts its clock. Returns
// what stopJoke takes.
export const startJoke = (root) => {
  const row = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  const since = Date.now();

  row.className = "order-cart-row order-cart-credit order-cart-joke";
  dt.textContent = jokeLabel();
  row.appendChild(dt);
  row.appendChild(dd);
  qs(root, "[data-total-row='fee']").before(row);

  const tick = () => {
    dd.textContent = `−${dollars(jokeAmount(Date.now() - since))}`;
  };

  tick();

  return { row, timer: setInterval(tick, 1000) };
};

export const stopJoke = (joke) => {
  clearInterval(joke.timer);
  joke.row.remove();
};
