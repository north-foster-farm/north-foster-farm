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

//
// A product the catalog marks `restock: "archived"` is never sold,
// whatever its count (#267). If stock shows one on hand anyway, the
// farm is told (archivedInStock, below): it would otherwise sit
// hidden from the people waiting for it, and nobody would know why.

import catalog from "../../../data/catalog.json" with { type: "json" };
import {
  archived, indexCatalog,
} from "../../../assets/scripts/order/lib/catalog.mjs";
import terms from "../../../data/delivery.json" with { type: "json" };
import { today } from "../../../assets/scripts/order/lib/zoned.mjs";
import { now as clock } from "./clock.mjs";
import { log } from "./log.mjs";
import { farmEmails, sendMail } from "./mail.mjs";
import { mailLinks } from "./site.mjs";
import { farmArchivedInStock } from "./templates.mjs";

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

// Whether stock has this item on hand, its restock type aside: the
// catalog flag, and the count above 0 where there is one.
const onHand = (item, counts, sku) => !!item.inStock
  && (!Object.hasOwn(counts, sku) || counts[sku] > 0);

// What the page needs for every catalog item, counted or not.
//   { sku: { inStock, available } }  available is null when uncounted.
// An archived item is never in stock. `catalogIndex` is for tests.
export const availability = async (stores, { catalogIndex = index } = {}) => {
  const counts = await getCounts(stores);
  const items = {};

  for (const [sku, item] of catalogIndex) {
    const counted = Object.hasOwn(counts, sku);
    const available = counted ? Math.max(0, counts[sku]) : null;

    items[sku] = {
      inStock: onHand(item, counts, sku) && !archived(item),
      available,
    };
  }

  return items;
};

// The archived items stock has on hand. -> [{ sku, name, count }],
// count null for one in stock by its flag and not counted.
export const archivedOnHand = async (stores, {
  catalogIndex = index,
} = {}) => {
  const counts = await getCounts(stores);

  return [...catalogIndex].filter(([sku, item]) => archived(item)
    && onHand(item, counts, sku)).map(([sku, item]) => ({
    sku,
    name: item.lineName,
    count: Object.hasOwn(counts, sku) ? counts[sku] : null,
  }));
};

// Every read of stock looks for archived items on hand, and emails
// FARM_NOTIFICATIONS_EMAIL, and no one else, about each one once a
// day (the jobs store's `stock/archived/<day>` keeps which). The
// morning report lists them every day until they are resolved. It
// never fails the read it rides on. -> the items newly reported.
export const archivedKey = (day) => `stock/archived/${day}`;

export const archivedInStock = async (stores, {
  env = process.env, mail = sendMail, now = clock(),
  catalogIndex = index,
} = {}) => {
  try {
    const found = await archivedOnHand(stores, { catalogIndex });
    const to = farmEmails(env);

    if (!found.length || !to.length) return [];

    const key = archivedKey(today(now, terms.timeZone));
    const told = ((await stores.jobs.get(key)) || {}).skus || [];
    const fresh = found.filter((i) => !told.includes(i.sku));

    if (!fresh.length) return [];

    // Marked once sent, so a failed send tries again on the next read.
    // Two reads racing share the idempotency key, so Resend sends one.
    await mail({
      to,
      idempotencyKey: `${key}/${fresh.map((i) => i.sku).join(",")}`,
      ...farmArchivedInStock(fresh, { links: mailLinks(env) }),
    }, { env, stores });
    await stores.jobs.set(key, {
      at: now.toISOString(), skus: [...told, ...fresh.map((i) => i.sku)],
    });
    log.warn({
      event: "stock.archived_in_stock", skus: fresh.map((i) => i.sku),
    });

    return fresh;
  } catch (error) {
    log.error({ event: "stock.archived_check_failed", error: String(error) });

    return [];
  }
};

// Errors keyed like the validator's, for lines that cannot be filled.
export const checkLines = async (stores, lines) => {
  const items = await availability(stores);
  const errors = {};

  for (const line of lines || []) {
    const state = items[line.sku];
    const item = index.get(line.sku);

    if (!state || !item) continue;

    const name = item.lineName;

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
