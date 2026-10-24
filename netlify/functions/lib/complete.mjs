// Tells Square a fulfilled order is done (#328). Square keeps an order
// OPEN, and its fulfillment PROPOSED, until someone completes them, so
// the dashboard's open list would hold every web order for good. The
// record has already changed by the time this runs and stays changed
// whatever Square says: a Square that cannot follow flags the order
// `squareOutOfSync` and tells the farm, once, to complete it by hand.
//
// An order already complete in Square, by hand or by an earlier run,
// is no failure. The site's own completion raises no drift flag
// (lib/drift.mjs): the order is no longer paid, and only a paid order
// is compared.
import { alert } from "./health.mjs";
import { log } from "./log.mjs";
import { mailLinks } from "./site.mjs";
import { notifyFarm } from "./payments.mjs";
import { amendOrder, getOrder } from "./records.mjs";
import * as squareApi from "./square.mjs";
import { farmSquareNotCompleted } from "./templates.mjs";

// The Square orders that hold an order's fulfillment: the one that
// carries it now, and the one it was paid on if a change moved it.
const holders = (order) => {
  const sq = order.square || {};

  return [...new Set([sq.fulfilmentOrderId, sq.squareOrderId])]
    .filter(Boolean);
};

// -> the order, as saved.
export const completeInSquare = async (stores, order, {
  now, env = process.env, mail, square = squareApi, fetchImpl,
} = {}) => {
  try {
    for (const squareOrderId of holders(order)) {
      await square.completeOrder(squareOrderId, { env, fetchImpl });
    }

    return order;
  } catch (error) {
    log.error({
      event: "square.complete_failed", id: order.id,
      error: String(error && error.message),
    });

    await alert(stores, "square.complete_failed", {
      id: order.id, error: String(error && error.message),
    }, { env, mail, now });

    const flagged = await amendOrder(stores, order.id, {
      flags: { ...(order.flags || {}), squareOutOfSync: true },
    }, "square.out_of_sync", now);

    await notifyFarm(stores, await getOrder(stores, order.id),
      "farmSquareNotCompleted",
      farmSquareNotCompleted(flagged, { links: mailLinks(env) }),
      { mail, env, now });

    return getOrder(stores, order.id);
  }
};
