// Changing a product's quantity from outside the product list. On the
// order page the list is right there, so the palette sets its quantity
// box and fires the input event the page already listens for. Anywhere
// else it writes the same saved draft the order page restores on load.

import { announceCart } from "../cart-badge/announce.js";
import { Draft } from "../order/draft.js";

const MAX = 99;

const box = (sku) => document.querySelector(
  `#order-form [data-qty="${CSS.escape(sku)}"]`);

const onOrderPage = () => !!document.getElementById("order-form");

const pageCount = () => [...document.querySelectorAll(
  "#order-form [data-qty]")]
  .reduce((sum, input) => sum + (parseInt(input.value, 10) || 0), 0);

const draftLines = () => {
  const saved = new Draft().load();

  return (saved && saved.payload && saved.payload.lines) || [];
};

// -> how many of this product are in the cart now.
export const inCart = (sku) => {
  if (onOrderPage()) {
    const input = box(sku);

    return input ? parseInt(input.value, 10) || 0 : 0;
  }

  const line = draftLines().find((l) => l.sku === sku);

  return line ? line.qty : 0;
};

// -> the number of items in the cart.
export const cartCount = () => (onOrderPage()
  ? pageCount()
  : draftLines().reduce((sum, line) => sum + line.qty, 0));

// Sets how many of this product the cart holds, from 0, which takes
// the line out, to 99. -> the quantity now in the cart, or null when
// the order page has no box for it.
export const setCart = (sku, qty) => {
  const n = Math.max(0, Math.min(MAX, qty));

  if (onOrderPage()) {
    const input = box(sku);

    if (!input) return null;
    input.value = String(n);
    input.setAttribute("value", String(n));
    input.dispatchEvent(new Event("input", { bubbles: true }));

    return n;
  }

  const draft = new Draft();
  const saved = draft.load();
  const payload = { ...((saved && saved.payload) || {}) };
  const was = payload.lines || [];
  const at = was.findIndex((l) => l.sku === sku);
  const lines = was.filter((l) => l.sku !== sku);

  // A line keeps its place in the cart as its quantity changes.
  if (n > 0) {
    if (at === -1) lines.push({ sku, qty: n });
    else lines.splice(at, 0, { ...was[at], qty: n });
  }
  payload.lines = lines;
  draft.save(payload);
  draft.touch();
  announceCart(cartCount());

  return n;
};
