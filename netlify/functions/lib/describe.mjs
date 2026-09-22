// The sentences that say when and where an order is fulfilled. Used
// by the Square invoice, the emails and the account pages, so the
// customer reads the same words everywhere.

import terms from "../../../data/delivery.json" with { type: "json" };
import { label } from "../../../assets/scripts/order/lib/zoned.mjs";

// "10:00 AM – 4:00 PM" -> "10 AM and 4 PM", for "between ... and ...".
export const between = (window) =>
  window.replace(/:00/g, "").split(/\s*–\s*/).join(" and ");

// "Delivery on Thursday, October 8" and so on, one clause. The
// delivery window is approximate and says so (James, 2026-09-22).
export const whenWhere = (order) => {
  const f = order.fulfilment;
  const when = label(f.date);

  if (f.method === "delivery") {
    return `Delivery on ${when}, between ${
      between(terms.delivery.window)}`;
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
    return `Delivery on ${when}, between ${
      between(terms.delivery.window)}. Please have a cooler with ice out ` +
      "that morning.";
  }
  if (f.method === "scituate") {
    return `Scituate drop site, ${when}, ${terms.scituate.window}, at the ` +
      `${terms.scituate.location}.`;
  }

  // What "by appointment" means for the customer is a paragraph, not a
  // clause; the emails that need it say it in full.
  return `On-farm pickup on ${when}, ${f.onfarm.window}, at ` +
    `${terms.onFarm.address}.`;
};

export const methodName = (method) => ({
  delivery: "Delivery",
  scituate: "Scituate drop site",
  onfarm: "On-farm pickup",
}[method] || method);
