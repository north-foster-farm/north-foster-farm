// The sentences that say when and where an order is fulfilled. Used
// by the Square invoice, the emails and the account pages, so the
// customer reads the same words everywhere.

import terms from "../../../data/delivery.json" with { type: "json" };
import { label } from "../../../assets/scripts/order/lib/zoned.mjs";

// "Local delivery on Thursday, October 8" and so on, one clause.
export const whenWhere = (order) => {
  const f = order.fulfilment;
  const when = label(f.date);

  if (f.method === "delivery") {
    return `Local delivery on ${when}, ${terms.delivery.window}`;
  }
  if (f.method === "scituate") {
    return `Scituate drop site, ${when}, ${terms.scituate.window}`;
  }

  return `On-farm pickup on ${when}, ${f.onfarm.window}`;
};

// The fuller version for an invoice description or a first email.
export const describe = (order) => {
  const f = order.fulfilment;
  const when = label(f.date);

  if (f.method === "delivery") {
    return `Local delivery on ${when}, ${terms.delivery.window}. ` +
      "Please have a cooler with ice out that morning.";
  }
  if (f.method === "scituate") {
    return `Scituate drop site, ${when}, ${terms.scituate.window}, at the ` +
      `${terms.scituate.location}.`;
  }

  return `On-farm pickup on ${when}, ${f.onfarm.window}, at ` +
    `${terms.onFarm.address}. By appointment: we'll confirm a time.`;
};

export const methodName = (method) => ({
  delivery: "Local delivery",
  scituate: "Scituate drop site",
  onfarm: "On-farm pickup",
}[method] || method);
