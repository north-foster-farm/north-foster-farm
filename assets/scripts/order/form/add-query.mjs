// /order/?add=SKU:qty,SKU:qty, read and answered
// (docs/refactors/order-form.md, phase 3). Pure: links.js adds the
// lines and writes the notice.

import { sentence } from "../lib/sentence.mjs";

// Draft wording.
const CHANGED = "Some items from that order have changed. Please add " +
  "them again.";

// Each part of ?add='s value as { sku, qty }, in order, the SKU as
// given (links.js resolves the aliases). A quantity that is missing,
// zero or not a number is 1, and one over 99 is 99.
export const parseAdd = (raw) => raw.split(",").map((part) => {
  const [given, qtyText] = part.split(":");

  return {
    sku: given || "",
    qty: Math.min(99, Math.max(1, parseInt(qtyText, 10) || 1)),
  };
});

// What the notice says: the lines added (`added`, [{ qty, name }]),
// the products that are not available, by name (`missing`), and that
// some SKUs are unknown (`unknown`), never naming one. Some added is
// the success tone; none, the warning tone.
export const addNotice = ({ added, missing, unknown }) => {
  const bits = [];

  if (added.length) {
    const lines = added.map(({ qty, name }) => `${qty} × ${name}`);

    bits.push(sentence(`Added to your cart: ${lines.join(", ")}`));
  }
  if (missing.length) {
    bits.push(sentence(`Not available: ${missing.join(", ")}`));
  }
  if (unknown.length) bits.push(CHANGED);

  return {
    text: bits.join(" "),
    tone: added.length ? "success" : "warning",
    hidden: !bits.length,
  };
};
