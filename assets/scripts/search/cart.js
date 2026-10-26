// Changing a product's quantity from outside the product list. On the
// order page the list is right there, so the palette sets its quantity
// box and fires the input event the page already listens for. Anywhere
// else it writes the same saved draft the order page restores on load.

import { announceCart } from "../cart-badge/announce.js";
import { Draft } from "../order/draft.js";
import { currentLines, shownLines } from "../order/lib/catalog.mjs";

const MAX = 99;

const box = (sku) => document.querySelector(
  `#order-form [data-qty="${CSS.escape(sku)}"]`);

const onOrderPage = () => !!document.getElementById("order-form");

const pageCount = () => [...document.querySelectorAll(
  "#order-form [data-qty]")]
  .reduce((sum, input) => sum + (parseInt(input.value, 10) || 0), 0);

// The catalog product search carries on every page, by SKU, and the
// renames a saved cart may predate. Empty when the page has neither.
export const pageCatalog = () => {
  try {
    const products = JSON.parse(document.querySelector(
      "[data-search-products]").textContent);
    const aliases = JSON.parse(document.querySelector(
      "[data-search-palette]").dataset.aliases || "{}");

    return { products: new Map(products.map((p) => [p.sku, p])), aliases };
  } catch {
    return { products: new Map(), aliases: {} };
  }
};

const savedLines = () => {
  const saved = new Draft().load();

  return (saved && saved.payload && saved.payload.lines) || [];
};

// The saved cart's lines the cart can show (#322): renamed SKUs
// brought up to date, unknown ones and empty ones left out, so the
// count, the cart link and the order page agree. A page with no
// catalog can't tell, and takes the lines as saved.
export const draftLines = () => {
  const { products, aliases } = pageCatalog();

  return products.size ? shownLines(savedLines(), aliases, products)
    : savedLines();
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
  // Renamed SKUs brought up to date so one is not kept beside its new
  // name; a line the page can't show stays in the cart, for an order
  // being edited may hold it.
  const was = currentLines(payload.lines, pageCatalog().aliases);
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
