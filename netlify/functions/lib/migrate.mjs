// `bin/nff migrate scheduled-pickup`: the orders of Stage 1 name a
// scheduled pickup by method `scituate`, or `market` and a `site`; the
// model names one occurrence. The migration rewrites each to
// `{ method: "scheduled", occurrence }`, the date unchanged, and notes
// it in the order's history. It touches neither Square nor money, only
// the fulfilment block, and is safe to run twice: an order already in
// the new shape is left alone. It stops, changing nothing, when an
// order cannot be mapped (a date its site never had).

import terms from "./terms.mjs";
import { modelled } from "../../../assets/scripts/order/lib/dates.mjs";
import { allOrders, saveOrder } from "./records.mjs";
import { now as clock } from "./clock.mjs";

const OLD = ["scituate", "market"];

// -> { changes: [{ id, from, to }], unmapped: [{ id, reason }] }
export const planMigration = (orders, model = terms) => {
  const changes = [];
  const unmapped = [];

  for (const o of orders) {
    const f = o.fulfilment;

    if (!f || !OLD.includes(f.method)) continue;

    const next = modelled(model, f);

    if (next.occurrence) {
      changes.push({
        id: o.id,
        from: { method: f.method, site: f.site || null, date: f.date },
        to: next.occurrence,
      });
    } else {
      unmapped.push({
        id: o.id,
        reason: `${f.method}${f.site ? ` at "${f.site}"` : ""} on ${
          f.date} matches no occurrence.`,
      });
    }
  }

  return { changes, unmapped };
};

// `backup` is called once, before the first write, and must throw if
// it cannot back up. -> { ok, changes, unmapped, dryRun }
export const migrateScheduledPickup = async (stores, {
  dryRun = false, backup, now = clock(), model = terms,
} = {}) => {
  const orders = await allOrders(stores);
  const { changes, unmapped } = planMigration(orders, model);

  if (unmapped.length) return { ok: false, changes, unmapped, dryRun };
  if (dryRun || !changes.length) return { ok: true, changes, unmapped, dryRun };

  await backup();

  for (const change of changes) {
    const order = orders.find((o) => o.id === change.id);

    await saveOrder(stores, {
      ...order,
      fulfilment: modelled(model, order.fulfilment),
      history: [...(order.history || []), {
        at: now.toISOString(),
        event: "fulfilment.migrated",
        from: change.from,
        to: change.to,
      }],
    }, now);
  }

  return { ok: true, changes, unmapped, dryRun };
};
