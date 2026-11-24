// The orders #790's criteria tests (test/farm-notice-place.criteria.mjs)
// render the farm notices and the customer emails with: one for each
// way an order is handed over. The order is test/templates.test.mjs's
// fixture; a scheduled fulfillment is the occurrence shape the packing
// tests use (test/packing-jit.test.mjs), on series in data/series.json.
// Also read by the script that recorded the customer emails' snapshot
// (test/farm-notice-place.customer.json) from origin/next.

import {
  deliveryReminder, missedDelivery, movedDelivery, orderCancelled,
  orderChanged, orderConfirmed,
} from "../netlify/functions/lib/templates.mjs";

export const links = {
  orders: "https://x/account/",
  contact: null,
  admin: "https://admin.example.com",
  order: "https://x/order/",
};

const occurrence = (code, date) => ({
  method: "scheduled", occurrence: `${code}-${date.slice(2)
    .replaceAll("-", "")}`, date, onfarm: null, delivery: null,
});

const ONFARM = {
  method: "onfarm", date: "2026-10-08",
  onfarm: { window: "09:00-12:00", from: "09:00", to: "12:00" },
  delivery: null,
};
const DELIVERY = {
  method: "delivery", date: "2026-10-08", onfarm: null,
  delivery: {
    address1: "1 Main St", address2: "", town: "Foster", state: "RI",
    zip: "02825", cooler: "Side porch", gate: "1234",
  },
};

// Each way, with the day as the notices write it.
export const WAYS = {
  onfarm: { fulfilment: ONFARM, day: "Thursday, October 8" },
  delivery: { fulfilment: DELIVERY, day: "Thursday, October 8" },
  // VFVQ: the drop site; H3TQ: the Pawtucket market; W9MF: the
  // Thanksgiving Prep pop-up; 36TS: a buying group's round.
  dropSite: {
    fulfilment: occurrence("VFVQ", "2026-11-21"),
    day: "Saturday, November 21",
  },
  market: {
    fulfilment: occurrence("H3TQ", "2026-11-24"),
    day: "Tuesday, November 24",
  },
  popUp: {
    fulfilment: occurrence("W9MF", "2026-11-21"),
    day: "Saturday, November 21",
  },
  groupRound: {
    fulfilment: occurrence("36TS", "2026-11-22"),
    day: "Sunday, November 22",
  },
  // No series ZZZZ in the data: an occurrence gone from it.
  gone: {
    fulfilment: occurrence("ZZZZ", "2026-11-21"),
    day: "Saturday, November 21",
  },
};

export const SCHEDULED = ["dropSite", "market", "popUp", "groupRound"];

export const order = (way) => {
  const fulfilment = structuredClone(WAYS[way].fulfilment);
  const delivery = fulfilment.method === "delivery";

  return {
    id: "NFF-2610-ABCD",
    status: "paid",
    submittedAt: "2026-10-06T13:00:00Z",
    paidAt: "2026-10-06T13:00:00Z",
    customer: {
      name: "Pat Example", email: "pat@example.com",
      phone: "401-555-0100", contact: "text",
    },
    lines: [
      { sku: "A", label: "Whole Chicken, 3.5 – 3.9 lbs", qty: 2,
        lineTotal: 60 },
      { sku: "B", label: "Eggs (per dozen), Large", qty: 1, lineTotal: 7 },
    ],
    totals: {
      subtotal: 6700, discountTier: 50, discountAmount: 500,
      discountLabel: "Bulk discount ($50+)",
      deliveryFee: delivery ? 500 : 0,
      total: delivery ? 6700 : 6200,
    },
    fulfilment,
    refunds: [{ source: "customer", amount: 6200 }],
    square: { squareOrderId: "SQO", customerId: "CUST" },
    payment: {
      via: "square", method: "card", at: "2026-10-06T13:00:00Z",
      squarePaymentId: "PAY-1", receiptUrl: "https://sq/receipt",
      brand: "VISA", last4: "4242",
    },
  };
};

const orderUrl = "https://x/account/orders/NFF-2610-ABCD/";
const pickUrl = "https://x/account/orders/NFF-2610-ABCD/pick/";
const now = new Date("2026-10-08T22:00:00Z");

// Every customer email that names a fulfillment, for every way it
// applies to: { "<email>/<way>": { subject, text } }.
export const customerEmails = () => {
  const out = {};
  const keep = (key, m) => {
    out[key] = { subject: m.subject, text: m.text };
  };

  for (const way of Object.keys(WAYS)) {
    keep(`orderConfirmed/${way}`, orderConfirmed(order(way),
      { orderUrl, links }));
    keep(`orderChanged/${way}`, orderChanged(order(way),
      { orderUrl, links }));
    keep(`orderCancelled/${way}`, orderCancelled(order(way),
      { by: "customer", refunded: 6200, links }));
  }

  const moved = order("delivery");

  moved.attempted = { date: "2026-10-01" };
  keep("deliveryReminder/delivery", deliveryReminder(order("delivery"),
    { orderUrl, settingsUrl: "https://x/account/#settings", links }));
  keep("missedDelivery/delivery", missedDelivery(order("delivery"),
    { pickUrl, links, now }));
  keep("movedDelivery/delivery", movedDelivery(moved,
    { pickUrl, links, now }));

  return out;
};
