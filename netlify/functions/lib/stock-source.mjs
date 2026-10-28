// Where staging's stock counts come from (#453). Staging sells through
// the Square sandbox, whose counts are not what customers see, so it
// never shows the low-stock tiers production has. Two settings change
// that, and only where counts are read from: orders, payments,
// fulfilments and every stock change still go to the sandbox.
//
//   STOCK_SOURCE=production   counts are read from production's public
//                             /api/stock, the answer the live order
//                             page reads, matched to the catalog by
//                             SKU. No credential: staging never calls
//                             production Square at all (James,
//                             2026-10-27)
//   STOCK_OVERRIDES           a few SKUs pinned to a count, for James's
//                             hand testing only: "SKU:n,SKU:n". Optional
//                             and normally unset. Each one listed wins
//                             over every source; the rest read as they
//                             would without it. No test uses it: a test
//                             pins its own counts for its own requests
//                             (lib/stock-pins.mjs, #507).
//
// Neither ever applies in production: only staging (branch-deploy) and
// deploy previews, and the overrides in local development too, never
// where SQUARE_ENV is production. Anywhere else, or with no context
// set, both are ignored.
//
// A test order on staging moves the sandbox's count, not production's,
// so with the production read on, staging never sells out by its own
// orders. A test that needs a SKU sold out pins it at 0.

import { timedFetch } from "./http.mjs";
import { deployContext } from "./store.mjs";

export const SOURCE_CONTEXTS = ["branch-deploy", "deploy-preview"];

const allowed = (env) => SOURCE_CONTEXTS.includes(deployContext(env))
  && env.SQUARE_ENV !== "production";

// -> true where counts are read from production Square.
export const productionRead = (env = process.env) => allowed(env)
  && env.STOCK_SOURCE === "production";

// Production's public stock answer. Production allows one address 120
// reads in ten minutes (functions/stock.mjs); staging's 15 s snapshot
// (lib/stock.mjs) keeps it far under that.
export const PRODUCTION_STOCK_URL =
  "https://www.northfosterfarm.com/api/stock";
export const PRODUCTION_MS = 1500;

// Production's counts by SKU, for the SKUs asked about: each item's
// `available`, where production counts it. A SKU production doesn't
// answer for, or doesn't count (available null), is left out, so it
// reads as it would without the production read. A GET and nothing
// else. Throws on a 429, any other status but 200, a timeout or an
// answer that isn't JSON; liveCounts logs it and keeps the sandbox's.
// -> { [sku]: n }
export const productionStock = async (skus, {
  fetchImpl = globalThis.fetch, deadline,
} = {}) => {
  const res = await timedFetch(fetchImpl, PRODUCTION_STOCK_URL, {
    method: "GET", headers: { Accept: "application/json" },
  }, {
    cap: PRODUCTION_MS, deadline, name: "production /api/stock",
    fail: (message, options) => Object.assign(new Error(message), options),
  });

  if (!res.ok) {
    throw Object.assign(new Error(`production /api/stock: ${res.status}`),
      { status: res.status });
  }

  const items = ((await res.json()) || {}).items || {};
  const out = {};

  for (const sku of skus) {
    const n = Object.hasOwn(items, sku) ? (items[sku] || {}).available
      : null;

    if (Number.isInteger(n)) out[sku] = n;
  }

  return out;
};

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
// Local development reads its own sandbox or fake, so it may override
// too, though it never reads production.
const handAllowed = (env) => (allowed(env) || deployContext(env) === "dev")
  && env.SQUARE_ENV !== "production";

export const stockOverrides = (env = process.env) =>
  (handAllowed(env) ? parseOverrides(env.STOCK_OVERRIDES) : {});
