// Stock in near real time. The catalog's inStock flags are the coarse
// switch, set with bin/stock and shipped with a deploy. On top of them
// the `stock` store keeps a count of packs on hand per SKU, set by the
// CLI and moved by orders: down when an order is placed, back up when
// it is cancelled or abandoned. A SKU without a count is not counted,
// only flagged.
//
//   counts        { [sku]: number }
//
// Netlify Blobs has no transactions. Two orders in the same second
// could both see the last pack; the count then goes to -1, the next
// customer sees it sold out, and the farm sees the shortfall in the
// CLI. For a farm that sells dozens of packs a week, that is the
// right trade.

import catalog from "../../../data/catalog.json" with { type: "json" };
import { indexCatalog } from "../../../assets/scripts/order/lib/catalog.mjs";

const index = indexCatalog(catalog);

export const COUNTS = "counts";

export const getCounts = async (stores) =>
  (await stores.stock.get(COUNTS)) || {};

export const setCounts = (stores, counts) => stores.stock.set(COUNTS, counts);

// A null count clears it: the SKU goes back to flag only.
export const setCount = async (stores, sku, n) => {
  const counts = await getCounts(stores);

  if (n === null || n === undefined) {
    delete counts[sku];
  } else {
    counts[sku] = Math.max(-999, Math.trunc(Number(n)));
  }
  await setCounts(stores, counts);

  return counts;
};

// Moves counted SKUs by the order's lines: sign -1 on placing, +1 on
// release. Uncounted SKUs are untouched.
export const adjust = async (stores, lines, sign) => {
  const counts = await getCounts(stores);
  let touched = false;

  for (const line of lines || []) {
    if (Object.hasOwn(counts, line.sku)) {
      counts[line.sku] += sign * line.qty;
      touched = true;
    }
  }
  if (touched) await setCounts(stores, counts);

  return counts;
};

// What the page needs for every catalog item, counted or not.
//   { sku: { inStock, available } }  available is null when uncounted.
export const availability = async (stores) => {
  const counts = await getCounts(stores);
  const items = {};

  for (const [sku, item] of index) {
    const counted = Object.hasOwn(counts, sku);
    const available = counted ? Math.max(0, counts[sku]) : null;

    items[sku] = {
      inStock: !!item.inStock && (!counted || available > 0),
      available,
    };
  }

  return items;
};

// Errors keyed like the validator's, for lines that cannot be filled.
export const checkLines = async (stores, lines) => {
  const items = await availability(stores);
  const errors = {};

  for (const line of lines || []) {
    const state = items[line.sku];
    const item = index.get(line.sku);

    if (!state || !item) continue;

    const name = `${item.groupName}, ${item.label}`;

    if (!state.inStock) {
      errors[`lines.${line.sku}`] = `${name} just sold out.`;
    } else if (state.available !== null && line.qty > state.available) {
      errors[`lines.${line.sku}`] = state.available === 1
        ? `Only 1 ${name} left.`
        : `Only ${state.available} of ${name} left.`;
    }
  }

  return { ok: Object.keys(errors).length === 0, errors, items };
};
