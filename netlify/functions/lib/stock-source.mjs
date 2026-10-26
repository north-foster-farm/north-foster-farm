// Where staging's stock counts come from (#453). Staging sells through
// the Square sandbox, whose counts are not what customers see, so it
// never shows the low-stock tiers production has. Two settings change
// that, and only where counts are read from: orders, payments,
// fulfilments and every stock change still go to the sandbox.
//
//   STOCK_SOURCE=production   counts are read from production Square,
//                             matched to the catalog by SKU, with a
//                             token that can only read
//                             (STOCK_SOURCE_TOKEN, INVENTORY_READ and
//                             ITEMS_READ) at STOCK_SOURCE_LOCATION_ID
//   STOCK_OVERRIDES           a few SKUs pinned to a count, for the
//                             browser tests: "SKU:n,SKU:n". Each one
//                             listed wins over every read; the rest
//                             read as they would without it.
//
// Neither ever applies in production: only staging (branch-deploy) and
// deploy previews, and never where SQUARE_ENV is production. Anywhere
// else, or with no context set, both are ignored.
//
// A test order on staging moves the sandbox's count, not production's,
// so with the production read on, staging never sells out by its own
// orders. Pin the SKU at 0 with STOCK_OVERRIDES for that.

import { deployContext } from "./store.mjs";

export const SOURCE_CONTEXTS = ["branch-deploy", "deploy-preview"];

const allowed = (env) => SOURCE_CONTEXTS.includes(deployContext(env))
  && env.SQUARE_ENV !== "production";

// -> true where counts are read from production Square.
export const productionRead = (env = process.env) => allowed(env)
  && env.STOCK_SOURCE === "production";

// "SKU:n,SKU:n" -> { [sku]: n }. A part without a SKU or a whole
// number is skipped.
export const parseOverrides = (text) => {
  const out = {};

  for (const part of String(text || "").split(",")) {
    const at = part.lastIndexOf(":");
    const sku = part.slice(0, at).trim();
    const raw = part.slice(at + 1).trim();
    const n = Number(raw);

    if (at < 1 || !sku || !raw || !Number.isInteger(n)) continue;
    out[sku] = n;
  }

  return out;
};

// The counts STOCK_OVERRIDES pins, or none where it can't apply.
export const stockOverrides = (env = process.env) =>
  (allowed(env) ? parseOverrides(env.STOCK_OVERRIDES) : {});
