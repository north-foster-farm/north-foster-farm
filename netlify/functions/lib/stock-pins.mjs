// Stock counts pinned for one test (#507, James in #453 6458262765).
// No test may depend on a stock count it didn't set itself: not the
// sandbox's, not production's, not whatever the store holds. A test
// that needs a count pins it for its own scope, an id its browser and
// request fixture send as a cookie on the deploy's host, and removes
// the pin afterwards (e2e/support/stock.mjs).
//
//   pins/<scope>   { at, until, counts: { [sku]: n } } in the stock
//                  store, set and removed by the e2e ops stock.pin and
//                  stock.unpin (lib/e2e.mjs)
//
// liveCounts lays a scope's pins over every other source, the hand
// override STOCK_OVERRIDES included, and only for a request carrying
// that scope, so tests are kept from each other, from James's browsing
// and from parallel shards. A pin past its `until` reads as no pin,
// the backstop for a run that died before its teardown, and the sweep
// (bin/e2e/sweep.mjs, op stock.sweep) removes it.
//
// Never in production: only staging (branch-deploy), deploy previews
// and local development, and never where SQUARE_ENV is production.
// Anywhere else the op is refused and the cookie ignored.

import catalog from "../../../data/catalog.json" with { type: "json" };
import { indexCatalog } from "../../../assets/scripts/order/lib/catalog.mjs";
import { cookieValue } from "./gate.mjs";
import { deployContext } from "./store.mjs";

const index = indexCatalog(catalog);

export const PIN_CONTEXTS = ["branch-deploy", "deploy-preview", "dev"];

export const SCOPE_COOKIE = "nff_stock_scope";
export const SCOPE = /^[A-Za-z0-9_-]{8,64}$/;
export const PIN_PREFIX = "pins/";

export const TTL_SECONDS = 15 * 60;
export const MAX_TTL_SECONDS = 60 * 60;
export const MAX_SKUS = 200;

export const pinsAllowed = (env = process.env) =>
  PIN_CONTEXTS.includes(deployContext(env)) && env.SQUARE_ENV !== "production";

export const pinKey = (scope) => `${PIN_PREFIX}${scope}`;

// The scope a request carries, or null where pins never apply or the
// cookie is missing or malformed.
export const scopeOf = (headers, env = process.env) => {
  if (!headers || !pinsAllowed(env)) return null;

  const id = cookieValue(headers, SCOPE_COOKIE);

  return id && SCOPE.test(id) ? id : null;
};

const scopeFrom = (scope) => {
  const id = String(scope || "");

  if (!SCOPE.test(id)) {
    throw new Error("scope is required: 8 to 64 letters, digits, - or _.");
  }

  return id;
};

// { [sku]: n } -> the same, checked: SKUs of the catalog, whole counts.
const countsFrom = (counts, catalogIndex) => {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new Error("counts is required: { SKU: n }.");
  }

  const entries = Object.entries(counts);

  if (!entries.length || entries.length > MAX_SKUS) {
    throw new Error(`counts names 1 to ${MAX_SKUS} SKUs.`);
  }

  const out = {};

  for (const [sku, n] of entries) {
    if (!catalogIndex.has(sku)) throw new Error(`No such SKU: ${sku}.`);
    if (!Number.isInteger(n) || n < -999 || n > 9999) {
      throw new Error(`${sku}: a whole count, -999 to 9999.`);
    }
    out[sku] = n;
  }

  return out;
};

// Pins `counts` for `scope` until `ttlSeconds` from `now` (at most an
// hour), replacing what the scope pinned before. -> the record.
export const pin = async (stores, { scope, counts, ttlSeconds }, {
  env = process.env, now = new Date(), catalogIndex = index,
} = {}) => {
  if (!pinsAllowed(env)) throw new Error("Stock pins are off here.");

  const id = scopeFrom(scope);
  const ttl = ttlSeconds === undefined ? TTL_SECONDS : Number(ttlSeconds);

  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
    throw new Error(`ttlSeconds: 1 to ${MAX_TTL_SECONDS}.`);
  }

  const record = {
    at: now.toISOString(),
    until: new Date(now.getTime() + ttl * 1000).toISOString(),
    counts: countsFrom(counts, catalogIndex),
  };

  await stores.stock.set(pinKey(id), record);

  return record;
};

// Removes the scope's pins, if any.
export const unpin = async (stores, { scope }, { env = process.env } = {}) => {
  if (!pinsAllowed(env)) throw new Error("Stock pins are off here.");

  await stores.stock.delete(pinKey(scopeFrom(scope)));
};

const live = (record, now) => !!record && record.counts
  && Date.parse(record.until) > now.getTime();

// The counts pinned for `scope` and still in force, or {}. Nothing
// where pins are off, whatever the store holds.
export const pinsFor = async (stores, scope, {
  env = process.env, now = new Date(),
} = {}) => {
  if (!scope || !pinsAllowed(env) || !SCOPE.test(scope)) return {};

  const record = await stores.stock.get(pinKey(scope));

  return live(record, now) ? { ...record.counts } : {};
};

// `counts` with the scope's pins over them.
export const applyPins = async (stores, counts, { scope, env, now } = {}) =>
  Object.assign(counts, await pinsFor(stores, scope, { env, now }));

// Removes every pin past its `until`, the leftovers of a run that died
// before its teardown. A pin still in force is some test's, and stays.
// -> how many were removed.
export const sweepPins = async (stores, {
  env = process.env, now = new Date(),
} = {}) => {
  if (!pinsAllowed(env)) throw new Error("Stock pins are off here.");

  let removed = 0;

  for (const { key } of await stores.stock.list(PIN_PREFIX)) {
    if (!live(await stores.stock.get(key), now)) {
      await stores.stock.delete(key);
      removed += 1;
    }
  }

  return removed;
};
