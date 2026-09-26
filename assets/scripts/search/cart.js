// Putting a product in the cart from outside the product list. On the
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

// Adds qty, capped at 99 in all. -> the quantity now in the cart, or
// null when the order page has no box for it.
export const addToCart = (sku, qty) => {
  if (onOrderPage()) {
    const input = box(sku);

    if (!input) return null;

    const next = String(Math.min(MAX, inCart(sku) + qty));

    input.value = next;
    input.setAttribute("value", next);
    input.dispatchEvent(new Event("input", { bubbles: true }));

    return Number(next);
  }

  const draft = new Draft();
  const saved = draft.load();
  const payload = { ...((saved && saved.payload) || {}) };
  const lines = (payload.lines || []).map((line) => ({ ...line }));
  const line = lines.find((l) => l.sku === sku);

  if (line) {
    line.qty = Math.min(MAX, line.qty + qty);
  } else {
    lines.push({ sku, qty: Math.min(MAX, qty) });
  }
  payload.lines = lines;
  draft.save(payload);
  draft.touch();
  announceCart(cartCount());

  return (line || lines[lines.length - 1]).qty;
};
