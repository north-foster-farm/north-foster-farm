// The pending payment's marker, kept apart from lib/farm-orders.mjs so
// lib/admin.mjs reads it without importing the farm's orders (#967,
// docs/refactors/server-cycles.md). From lib/ it imports clock.mjs
// alone. lib/farm-orders.mjs re-exports paymentPending and PENDING_MS
// and writes the marker under pendingKey in its claim helpers.

import { now as clock } from "./clock.mjs";

// A pending payment's marker stands this long: a request that died
// with the money taken is finished by the jobs' or the farm's hand
// before then, and a stale marker never locks an order for good.
export const PENDING_MS = 10 * 60_000;

export const pendingKey = (id) => `pay-pending/${id}`;

// Whether a payment of the order is under way: a fresh claim stands
// (#181). The farm's cancel waits for it, so money is never taken on
// an order being cancelled.
export const paymentPending = async (stores, id, now = clock()) => {
  const held = await stores.orders.get(pendingKey(id));

  return !!held && now.getTime() - Date.parse(held.at) < PENDING_MS;
};
