// The words of the result panels (docs/refactors/order-form.md, phase
// 4). Pure: result.js draws them. What the page knows comes in `ctx`:
// `occurrence(id)`, the lists' entry for a pickup day's occurrence or
// null; `drop`, the drop site's record; `dropSeries`, its series code;
// `deliveryWindow`, delivery's window; `location(id)`, a location's
// { street, city, state } or null; and `farm`, the farm's address.

import { fulfilmentDate } from "../lib/scheduled.mjs";
import { pickupTimes, windowLabel } from "../lib/schedule.mjs";
import { dollars, toCents } from "../lib/totals.mjs";
import { label } from "../lib/zoned.mjs";
import { looksLikeEmail } from "../../utils/email.js";

const WALLETS = {
  applepay: "Apple Pay", googlepay: "Google Pay", cashapp: "Cash App Pay",
  venmo: "Venmo",
};

// "Visa ending 4242", "Apple Pay", "Venmo".
export const paidWith = (payment) => {
  const p = payment || {};

  if (WALLETS[p.method]) return WALLETS[p.method];

  const brand = String(p.brand || "card").toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());

  return p.last4 ? `${brand} ending ${p.last4}` : brand;
};

// "10:00 – 11:00 AM, at the drop site" or "9:00 AM – 1:00 PM, at
// Foster Farmers’ Market": the occurrence's own hours and name, from
// the lists (one that has since left them is still remembered). A
// draft saved before scheduled pickup (`scituate`) reads as the drop
// site's did; an occurrence the page cannot name, as "the pickup you
// chose".
export const pickupAt = (f, ctx) => {
  if (f.method === "scituate") {
    return `${ctx.drop.window}, at the drop site`;
  }

  const entry = ctx.occurrence(f.occurrence);

  if (!entry) return "at the pickup you chose";

  const place = entry.series === ctx.dropSeries
    ? "the drop site" : entry.name;

  return `${entry.window}, at ${place}`;
};

// One line saying when and where, the sentence people screenshot.
export const when = (f, ctx) => {
  const date = fulfilmentDate(f, ctx.occurrence);
  const day = date ? label(date) : "";

  if (f.method === "delivery" && f.delivery) {
    return `${day}, delivered to ${f.delivery.address1}.`;
  }
  if (f.method === "scituate" || f.method === "scheduled") {
    return `${day}, ${pickupAt(f, ctx)}.`;
  }
  if (f.method === "onfarm" && f.onfarm) {
    const times = pickupTimes(f.onfarm);

    return `${day}, ${times ? windowLabel(times) : ""}, at the farm.`;
  }

  return day;
};

// "Saturday, November 22, 10:00 – 11:00 AM": the day, then the
// pickup's window or the delivery's.
export const dateTime = (f, ctx) => {
  const date = fulfilmentDate(f, ctx.occurrence);
  const entry = f.method === "scheduled" && ctx.occurrence(f.occurrence);
  const times = f.method === "onfarm" && f.onfarm
    && pickupTimes(f.onfarm);
  const time = {
    delivery: ctx.deliveryWindow,
    onfarm: times && windowLabel(times),
    scheduled: entry && entry.window,
    scituate: ctx.drop.window,
  }[f.method];

  return [date && label(date), time].filter(Boolean).join(", ");
};

// Where a pickup is handed over: the farm's address or the
// occurrence's location's street. None for a delivery.
export const pickupAddress = (f, ctx) => {
  if (f.method === "onfarm") return ctx.farm;

  const entry = f.method === "scheduled"
    ? ctx.occurrence(f.occurrence)
    : f.method === "scituate" && ctx.drop;
  const loc = entry && ctx.location(entry.location);

  if (loc) return [loc.street, loc.city, loc.state].join(", ");

  return entry ? entry.short || entry.place || "" : "";
};

// A group's round is a Group order (#749 item 10): a pickup day of the
// offered group's series (`group`, or null).
export const isRound = (f, group) => Boolean(
  f.method === "scheduled" && group
  && String(f.occurrence).startsWith(`${group.series}-`)
);

// The order as the failed panel's summary gives it, to copy or send:
// the customer, the when line, each line with its price, and the
// total. `ctx.item(sku)` is the catalog's entry and `ctx.total` the
// order's total in cents.
export const summaryText = (payload, ctx) => {
  const lines = payload.lines.map((line) => {
    const item = ctx.item(line.sku);

    return `${line.qty} × ${item.groupLabel}, ${item.label} ` +
      `(${dollars(line.qty * toCents(item.price))})`;
  });

  return [
    `${payload.customer.firstName} ${payload.customer.lastName} ` +
      `<${payload.customer.email}>`,
    when(payload.fulfilment, ctx),
    ...lines,
    `Total ${dollars(ctx.total)}`,
  ].join("\n");
};

// The farm's links in a card: only a plain address or number becomes
// one. The address goes into the link encoded, so the one email rule
// is enough (#678). `contact` is data/company.json's; each is null
// when there is no link.
export const contactHrefs = (contact, subject, body) => {
  const tail = body ? `&body=${encodeURIComponent(body)}` : "";

  return {
    mailto: looksLikeEmail(contact.email)
      ? `mailto:${encodeURIComponent(contact.email)}` +
        `?subject=${encodeURIComponent(subject)}${tail}`
      : null,
    tel: /^\+?\d+$/.test(contact.phone.plain)
      ? `tel:${contact.phone.plain}` : null,
  };
};

// What tells the farm a checkout could not complete: the message, the
// way and the page's `path`, never the customer's details.
export const failureBeacon = (payload, message, path) => ({
  kind: "checkout.failed",
  message,
  method: payload.fulfilment && payload.fulfilment.method,
  page: path,
});
