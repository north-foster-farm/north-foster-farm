// What the palette may offer of a product, from the live stock
// /api/stock returns: { sku: { inStock, available } }, or null before
// it answers, when the build's stock stands in: `out`, the catalog's
// own word on the product (#267).

export const MAX = 99;

export const soldOut = (stock, sku, out = false) => (stock && stock[sku]
  ? stock[sku].inStock === false : !!out);

// -> how many are left, or null if the farm doesn't count them.
const left = (stock, sku) => {
  const n = stock && stock[sku] ? stock[sku].available : null;

  return typeof n === "number" ? n : null;
};

// -> how many more can go in a cart that holds `have` already.
export const room = (stock, sku, have, out = false) => {
  if (soldOut(stock, sku, out)) return 0;

  const n = left(stock, sku);

  return Math.max(0, Math.min(MAX, n === null ? MAX : n) - have);
};
