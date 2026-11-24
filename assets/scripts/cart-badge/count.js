// How many items the cart holds. On the order page that is its
// quantity boxes; anywhere else the saved draft the order page
// restores on load, read against the catalog the page carries
// (partials/cart-catalog.html), so the count, the cart link and the
// order page agree (#322).

import { Draft } from "../order/draft.js";
import { shownLines } from "../order/lib/catalog.mjs";

const onOrderPage = () => !!document.getElementById("order-form");

const pageCount = () => [...document.querySelectorAll(
  "#order-form [data-qty]")]
  .reduce((sum, input) => sum + (parseInt(input.value, 10) || 0), 0);

// The catalog's SKUs, and the renames a saved cart may predate. Empty
// when the page has neither.
const pageCatalog = () => {
  try {
    const el = document.querySelector("[data-cart-catalog]");

    return {
      skus: new Set(JSON.parse(el.textContent)),
      aliases: JSON.parse(el.dataset.aliases || "{}"),
    };
  } catch {
    return { skus: new Set(), aliases: {} };
  }
};

const savedLines = () => {
  const saved = new Draft().load();

  return (saved && saved.payload && saved.payload.lines) || [];
};

// The saved cart's lines the cart can show: renamed SKUs brought up to
// date, unknown ones and empty ones left out. A page with no catalog
// can't tell, and takes the lines as saved.
const draftLines = () => {
  const { skus, aliases } = pageCatalog();

  return skus.size ? shownLines(savedLines(), aliases, skus) : savedLines();
};

// -> the number of items in the cart.
export const cartCount = () => (onOrderPage()
  ? pageCount()
  : draftLines().reduce((sum, line) => sum + line.qty, 0));
