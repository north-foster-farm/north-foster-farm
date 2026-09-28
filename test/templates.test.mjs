import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CANCEL_REASONS, addressDecision, addressReview, deliveryReminder, farmAlert,
  farmMorningReport, farmOrderChanged, farmOrderPlaced, farmPickupChanged,
  farmRefundNeeded, farmReturnRequest, farmSquareOutOfSync, farmSupport,
  farmTomorrow, magicLink, missedDelivery, movedDelivery, orderCancelled,
  orderChanged, orderConfirmed, paymentPhrase, summaryLine,
} from "../netlify/functions/lib/templates.mjs";

const order = (method = "delivery") => ({
  id: "NFF-2610-ABCD",
  status: "paid",
  submittedAt: "2026-10-06T13:00:00Z",
  paidAt: "2026-10-06T13:00:00Z",
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [
    { sku: "A", label: "Whole Chicken, 3.5 – 3.9 lbs", qty: 2, lineTotal: 60 },
    { sku: "B", label: "Eggs (per dozen), Large", qty: 1, lineTotal: 7 },
  ],
  totals: {
    subtotal: 6700, discountTier: 50, discountAmount: 500,
    discountLabel: "Bulk discount ($50+)",
    deliveryFee: method === "delivery" ? 500 : 0,
    total: method === "delivery" ? 6700 : 6200,
  },
  fulfilment: {
    method,
    date: "2026-10-08",
    onfarm: method === "onfarm"
      ? { window: "09:00-12:00", from: "09:00", to: "12:00" } : null,
    delivery: method === "delivery" ? {
      address1: "1 Main St", address2: "", town: "Foster", state: "RI",
      zip: "02825", cooler: "Side porch", gate: "1234",
    } : null,
  },
  square: { squareOrderId: "SQO", customerId: "CUST" },
  payment: {
    via: "square", method: "card", at: "2026-10-06T13:00:00Z",
    squarePaymentId: "PAY-1", receiptUrl: "https://sq/receipt",
    brand: "VISA", last4: "4242",
  },
});

const links = {
  orders: "https://x/account/",
  contact: null,
  admin: "https://admin.example.com",
  order: "https://x/order/",
};
const url = "https://x/account/orders/NFF-2610-ABCD/";
const settings = "https://x/account/#settings";
const both = (m) => `${m.text}\n${m.html}`;
// A plain-text expectation, quoted as James wrote it.
const has = (haystack, needle, msg) =>
  assert.ok(haystack.includes(needle), msg || `missing: ${needle}`);

describe("the order details block", () => {
  it("names the order, the lines without prices, and where and when", () => {
    const m = orderConfirmed(order(), { links });

    assert.match(m.text, /\nOrder details\n/);
    assert.match(m.text, /Order number: \*\*NFF-2610-ABCD\*\*/);
    assert.match(m.html, /Order number: <strong>NFF-2610-ABCD<\/strong>/,
      "a plain line for the customer");
    assert.match(m.text, /^- 2 × Whole Chicken, 3.5 – 3.9 lbs$/m);
    assert.doesNotMatch(m.text, /\$60|Subtotal|Bulk discount|Delivery fee/);
    assert.match(m.text, /Order type: \*\*Delivery\*\*/);
    assert.match(m.text,
      /- Arrives: Thursday, October 8, between 10 AM and 4 PM/);
    assert.match(m.text, /- Address: 1 Main St, Foster, RI 02825/);
  });

  it("gives a pickup its when and where instead", () => {
    const farm = orderConfirmed(order("onfarm"), { links });

    assert.match(farm.text, /Order type: \*\*On-farm pickup\*\*/);
    assert.match(farm.text, /- When: Thursday, October 8, 9 AM – noon/);
    assert.match(farm.text, /- Where: 99 East Killingly Road, Foster, RI/);
    assert.doesNotMatch(farm.text, /Arrives:|Address:/);

    const o = order("scituate");

    o.fulfilment.date = "2026-10-17";
    const drop = orderConfirmed(o, { links });

    assert.match(drop.text, /Order type: \*\*Drop site\*\*/);
    assert.match(drop.text,
      /- When: Saturday, October 17, between 10 and 11 AM/);
    assert.match(drop.text, /- Where: Village Green/);
  });
});

describe("the site's look", () => {
  it("opens on the wordmark, not a repeat of the subject", () => {
    const m = orderConfirmed(order(), {
      orderUrl: url, links: { ...links, site: "https://x" },
    });

    has(m.html, '<p style="margin:0 0 20px;text-align:center"><img ' +
      'src="https://x/images/email/logo.png"');
    assert.doesNotMatch(m.html, /<h1/);
    assert.match(m.html, /aller-regular\.woff2/);
    assert.match(m.html, /a\[x-apple-data-detectors\]/);
    // Green buttons, the site's radius; the order link is a button.
    has(m.html, '<a href="https://x/account/orders/NFF-2610-ABCD/" ' +
      'style="display:inline-block;padding:8px 16px;border-radius:4px;' +
      "font-weight:bold;line-height:1.5;text-decoration:none;" +
      'border:1px solid #186243;color:#fff;background:#186243">' +
      "View or edit this order</a>");
  });

  it("falls back to the name in text when it has no site to load from", () => {
    const m = orderConfirmed(order(), { links });

    assert.doesNotMatch(m.html, /<img/);
    assert.match(m.html, /NORTH FOSTER FARM|North Foster Farm<\/p>/);
  });

  it("ends on four centred lines", () => {
    const m = orderConfirmed(order(), { links });

    assert.ok(m.text.endsWith("\nNorth Foster Farm\n" +
      "99 E Killingly Rd, Foster, RI 02825\nsales@northfosterfarm.com\n" +
      "(401) 578-3713"));
    has(m.html, 'text-align:center;color:#5e5e5f">North Foster Farm<br>' +
      "99 E Killingly Rd, Foster, RI 02825<br>sales@northfosterfarm.com" +
      "<br>(401) 578-3713</p>");
  });

  it("makes the Square link a button on the farm's notice", () => {
    const m = farmOrderPlaced(order(), {
      squareUrl: "https://sq/1", links,
    });

    assert.match(m.html,
      /<a href="https:\/\/sq\/1" style="[^"]*background:#186243">/);
    has(m.html, ">View order in Square</a>");
  });
});

describe("the footer row", () => {
  it("links the orders page and a way to write, on every customer mail", () => {
    for (const m of [orderConfirmed(order("onfarm"), { links }),
      orderConfirmed(order(), { links }),
      orderCancelled(order(), { links })]) {
      has(m.html, '<a href="https://x/account/" style="color:#186243">' +
        'Your orders</a> | <a href="mailto:sales@northfosterfarm.com" ' +
        'style="color:#186243">Contact us</a>');
      assert.match(m.text, /Your orders: https:\/\/x\/account\//);
      assert.match(m.text, /Contact us: mailto:sales@northfosterfarm.com/);
    }
  });

  it("drops the orders link while accounts are off, keeps contact", () => {
    const m = orderConfirmed(order());

    assert.doesNotMatch(m.text, /Your orders/);
    assert.match(m.text, /Contact us: mailto:sales@northfosterfarm.com/);
  });

  it("uses CONTACT_URL when the site has a contact page", () => {
    const m = orderConfirmed(order(), {
      links: { ...links, contact: "https://x/#contact" },
    });

    assert.match(m.text, /Contact us: https:\/\/x\/#contact/);
  });
});

describe("the greeting", () => {
  it("is the first name on the record when there is one", () => {
    const o = order();

    o.customer.firstName = "Mary Ann";
    o.customer.name = "Mary Ann Smith";
    assert.match(orderConfirmed(o).html, /Thanks, Mary Ann\./);
    assert.match(orderConfirmed(order()).html, /Thanks, Pat\./,
      "an order from before the split still greets by the first word");
  });

  it("escapes what the customer typed", () => {
    const o = order("onfarm");

    o.customer.name = "<b>Pat</b>";
    const m = orderConfirmed(o);

    assert.match(m.html, /Thanks, &lt;b&gt;Pat&lt;\/b&gt;\./);
    assert.doesNotMatch(m.html, /<b>Pat<\/b>/);
  });
});

describe("order confirmed", () => {
  it("says the payment came through and links the order", () => {
    const m = orderConfirmed(order(), { orderUrl: url, links });

    assert.equal(m.subject, "Your order is confirmed");
    has(m.text, "Thanks, Pat. Your payment of $67 came through and your " +
      "order is confirmed.");
    assert.match(m.text, new RegExp(`View or edit this order: ${url}`));
  });

  it("tells a pickup its time is set, with its window's times", () => {
    const m = orderConfirmed(order("onfarm"), { orderUrl: url, links });

    has(m.text, "Thanks, Pat. Your payment of $62 came through and your " +
      "pickup time is set, so your order is confirmed.");
    assert.match(m.text, /- When: Thursday, October 8, 9 AM – noon\n/);
    assert.doesNotMatch(m.text, /not a booking|Requested:/);
    has(m.text, `View or edit this order: ${url}`);
    has(m.text, `Reschedule pickup: ${url}`);
    assert.doesNotMatch(orderConfirmed(order(), { orderUrl: url, links })
      .text, /Reschedule pickup/, "a delivery has no pickup to move");

    // A record from before W11d: a fixed window's word, or the hours the
    // farm confirmed inside it.
    const legacy = order("onfarm");

    legacy.fulfilment.onfarm = { window: "afternoon" };
    assert.match(orderConfirmed(legacy, { links }).text,
      /- When: Thursday, October 8, 1 – 5 PM\n/);
    legacy.fulfilment.onfarm.confirmed = { from: 11, to: 13 };
    assert.match(orderConfirmed(legacy, { links }).text,
      /- When: Thursday, October 8, 11 AM – 1 PM\n/);
  });
});

describe("a booked pickup time (W11d)", () => {
  it("gives the farm nothing to confirm on the new order", () => {
    const m = farmOrderPlaced(order("onfarm"), { links });

    has(m.text, "- When: Thursday, October 8, 9 AM – noon");
    assert.doesNotMatch(m.text, /Pickup time:|Requested|orders confirm|deny/);
  });

  it("tells the farm when the customer moves the time", () => {
    const m = farmPickupChanged(order("onfarm"), { links });

    assert.equal(m.subject, "Pickup moved: NFF-2610-ABCD");
    has(m.text, "Pat Example moved order NFF-2610-ABCD to a new pickup " +
      "time.");
    has(m.text, "Now: **Thursday, October 8, 9 AM – noon**");
    assert.doesNotMatch(m.text, /orders confirm|confirming/);
    assert.doesNotMatch(m.text, /View order:|View customer/);
    has(m.text, "Admin: https://admin.example.com");
  });
});

describe("the monitoring emails", () => {
  const stats = {
    placed: 4, paidByCard: 3, paidByVenmo: 1, declined: 1, cancelled: 0,
    refunded: 0, open: 2, mailFailures: 0, runs: 96, jobErrors: 0,
    invariants: 0,
  };

  it("morning report: the day in numbers, the pickups waiting on the " +
    "customer, and a schedule running short", () => {
    const denied = { ...order("onfarm"), id: "NFF-2610-EFGH",
      status: "paid" };

    denied.question = { kind: "window", openedAt: "2026-10-05T12:00:00Z",
      answeredAt: null };
    const m = farmMorningReport(stats, [denied], {
      date: "2026-10-06", links, now: new Date("2026-10-06T12:00:00Z"),
      schedule: { last: "2026-10-16", until: "2026-10-19" },
    });

    assert.equal(m.subject, "Morning report: Tuesday, October 6");
    has(m.text, "Vital signs: the last 24 hours");
    assert.match(m.text, /Orders placed\s+4\s+🫥\n/, "a plain number");
    assert.match(m.text, /Paid by card or a wallet\s+3\s+🫥\n/);
    assert.match(m.text, /Paid by Venmo\s+1\s+🫥\n/);
    assert.match(m.text, /Payments declined\s+1\s+🐣\n/,
      "a few declines are a healthy day");
    assert.match(m.text, /Refunded\s+0\s+🫥\n/);
    assert.match(m.text,
      /Open orders, paid and not yet fulfilled\s+2\s+🫥\n/);
    assert.match(m.text,
      /Jobs runs \(one every 15 minutes is 96\)\s+96\s+🐣\n/);
    assert.match(m.html, new RegExp("text-align:right[^>]*>4</td><td " +
        "[^>]*text-align:center[^>]*>🫥"), "figures right, marks centred");
    assert.doesNotMatch(m.text, /poll|Venmo check|invoice/i);
    has(m.text, "The pickup schedule's last window is on Friday, " +
        "October 16; it must reach the week of Monday, October 19.");
    has(m.text, "\n    bin/nff schedule set <file>\n");
    has(m.text, "We couldn't keep these pickup times and the customer " +
        "hasn't chosen another yet, oldest order first.");
    assert.match(m.text, /Order\s+Customer\s+Was\s+Waiting\n/);
    assert.match(m.text, new RegExp("NFF-2610-EFGH\\s+Pat Example\\s+" +
        "Thursday, October 8, 9 AM – noon\\s+24 h"));
    assert.doesNotMatch(m.text, /\bunpaid\b|orders confirm/);
    has(m.text, "Admin: https://admin.example.com");

    const quiet = farmMorningReport({ ...stats, declined: 4 }, [], {
      date: "2026-10-06", links, now: new Date("2026-10-06T12:00:00Z"),
      schedule: { last: "2026-10-23", until: "2026-10-19" },
    });

    has(quiet.text, "No pickups waiting on the customer.");
    assert.doesNotMatch(quiet.text, /Pickup schedule/);
    assert.match(quiet.text, /Payments declined\s+4\s+🙈\n/,
      "many declines are worth a look");
  });

  it("tomorrow: every order due, by method, with what to pack", () => {
    const delivery = { ...order(), status: "paid" };
    const drop = { ...order("scituate"), id: "NFF-2610-DROP" };
    const farm = { ...order("onfarm"), id: "NFF-2610-FARM", status: "paid" };

    delivery.fulfilment.delivery.notes = "Dog in the yard";
    delivery.customer.phone = "401-555-0100";
    const m = farmTomorrow([delivery, drop, farm], {
      date: "2026-10-08", links,
    });

    assert.equal(m.subject, "Tomorrow, Thursday, October 8: 3 orders");
    has(m.text, "\nDeliveries (1)\n");
    has(m.text, "**NFF-2610-ABCD**, Pat Example, 401-555-0100, paid");
    has(m.text, "- Address: 1 Main St, Foster, RI 02825");
    has(m.text, "- Cooler: Side porch");
    has(m.text, "- Gate or door code: 1234");
    has(m.text, "- Notes: Dog in the yard.");
    has(m.text, "- Pack:\n  - 2 × Whole Chicken, 3.5 – 3.9 lbs\n  - 1 × Eggs " +
      "(per dozen), Large", "the pack list is nested");
    assert.match(m.html,
      /<li>Pack:<ul style="[^"]*padding-left:1.25em"><li>2 × Whole Chicken/);
    has(m.text, "\nDrop site, 10:00 – 11:00 AM (1)\n");
    has(m.text, "**NFF-2610-DROP**, Pat Example, paid");
    has(m.text, "\nOn-farm pickups (1)\n");
    has(m.text, "**NFF-2610-FARM**, Pat Example, 9 AM – noon, paid");

    // A pickup confirmed before W11d shows its hours; a delivery unpaid
    // from
    // the invoice era is flagged, since nothing will pay it now.
    const legacy = { ...order(), status: "submitted", payment: undefined };
    const confirmedFarm = { ...order("onfarm"), id: "NFF-2610-CONF",
      status: "paid" };

    confirmedFarm.fulfilment.state = "agreed";
    confirmedFarm.fulfilment.onfarm = { window: "morning",
      confirmed: { from: 9, to: 11 } };
    const odd = farmTomorrow([legacy, confirmedFarm], {
      date: "2026-10-08", links,
    });

    has(odd.text, "**NFF-2610-ABCD**, Pat Example, **UNPAID, past the " +
      "cutoff: it should have been cancelled; check it before loading**");
    has(odd.text, "**NFF-2610-CONF**, Pat Example, 9 – 11 AM, paid");

    const none = farmTomorrow([], { date: "2026-10-09", links });

    assert.equal(none.subject, "Tomorrow, Friday, October 9: 0 orders");
    has(none.text, "Nothing due Friday, October 9.");
  });

  it("every farm email opens with a small capital line naming it; a " +
    "customer's does not", () => {
    const tagged = [
      [farmMorningReport(stats, [], { date: "2026-10-06", links }),
        "MORNING REPORT"],
      [farmTomorrow([], { date: "2026-10-08", links }), "TOMORROW"],
      [farmAlert("mail.failed", {}, { links }), "SITE ALERT"],
      [farmOrderPlaced(order(), { links }), "NEW ORDER"],
      [farmPickupChanged(order("onfarm"), { links }), "PICKUP MOVED"],
    ];

    for (const [m, tag] of tagged) {
      assert.equal(m.text.split("\n")[2], tag, m.subject);
      assert.match(m.html, new RegExp("text-transform:uppercase;" +
        `color:#5e5e5f">${tag.charAt(0)}${tag.slice(1).toLowerCase()}</p>`),
      m.subject);
    }
    for (const m of [orderConfirmed(order("onfarm"), { links }),
      orderConfirmed(order(), { links })]) {
      assert.doesNotMatch(m.html,
        /letter-spacing:\.12em;text-transform:uppercase;color:#5e5e5f/,
        m.subject);
      assert.notEqual(m.text.split("\n")[2], m.text.split("\n")[2]
        .toUpperCase(), "no capital line under the title");
    }
  });

  it("alert: the kind, the time, the detail as a table, and the runbook",
    () => {
      const m = farmAlert("order.create_failed", {
        id: "NFF-2610-ABCD", retryable: false, error: "Square 400",
        empty: "", nothing: null,
      }, { at: new Date("2026-10-06T13:05:00Z"), links });

      assert.equal(m.subject, "Site alert: order.create_failed");
      has(m.text, "**order.create_failed** at 2026-10-06 13:05 UTC. " +
        "Further alerts of this kind are held for an hour.");
      assert.match(m.text, /Field\s+Value\n/);
      assert.match(m.text, /id\s+NFF-2610-ABCD\n/);
      assert.match(m.text, /retryable\s+false\n/);
      assert.doesNotMatch(m.text, /empty|nothing/);
      has(m.text, "docs/monitoring.md");
      has(m.text, "Admin: https://admin.example.com");
    });
});

describe("delivery reminder", () => {
  it("says tomorrow, the window, the cooler spot and the notes", () => {
    const o = order();

    o.fulfilment.delivery.notes = "Dog is friendly";
    o.notes = "Eggs on top please";
    const m = deliveryReminder(o, {
      orderUrl: url, settingsUrl: settings, links,
    });

    assert.equal(m.subject, "Your delivery is tomorrow");
    has(m.text, "Tomorrow is delivery day! Your order will arrive between " +
      "10 AM and 4 PM.");
    assert.match(m.text, /- Leave your cooler with ice outside in the morning/);
    assert.match(m.text, /- Provide gate or door codes, if needed/);
    has(m.text, "We'll look for your cooler here: _**Side porch.**_");
    assert.match(m.html, /<em><strong>Side porch\.<\/strong><\/em>/);
    assert.match(m.text, /Gate or door code you gave us: _\*\*1234\*\*_/);
    has(m.text, "Your notes and instructions: _**Dog is friendly. Eggs on " +
      "top please.**_");
    assert.match(m.text, /Order number: \*\*NFF-2610-ABCD\*\*/);
    assert.match(m.text, new RegExp(`View or edit this order: ${url}`));
    assert.ok(m.text.includes(`Turn off delivery reminders: ${settings}`));
  });

  it("leaves out what the order doesn't have", () => {
    const o = order();

    delete o.fulfilment.delivery.gate;
    const m = deliveryReminder(o);

    assert.doesNotMatch(m.text, /Gate or door code you|notes and instructions/);
  });
});

describe("order changed and cancelled", () => {
  it("shows the current order with the cooler and notes", () => {
    const o = order();

    o.notes = "Ring twice";
    const m = orderChanged(o, { orderUrl: url, links });

    assert.equal(m.subject, "Your order is updated");
    assert.match(m.text, /Pat, your order has been updated\./);
    assert.match(m.text, /Order number: \*\*NFF-2610-ABCD\*\*/);
    assert.doesNotMatch(m.text, /\nOrder details\n/, "no heading here");
    has(m.text, "Where will we find your cooler? _**Side porch**_");
    assert.match(m.text, /Gate or door code: _\*\*1234\*\*_/);
    assert.match(m.text, /Other notes or instructions: _\*\*Ring twice\.\*\*_/);
    assert.match(m.text, new RegExp(`View or edit this order: ${url}`));
  });

  it("marks each changed line and says what the change cost", () => {
    const was = order();
    const o = order();

    was.lines = [
      { sku: "A", label: "Whole Chicken", qty: 2 },
      { sku: "B", label: "Eggs (per dozen)", qty: 1 },
      { sku: "C", label: "Sausage", qty: 1 },
    ];
    was.totals = { ...was.totals, total: 9400 };
    o.lines = [
      { sku: "A", label: "Whole Chicken", qty: 2 },
      { sku: "B", label: "Eggs (per dozen)", qty: 3 },
    ];
    o.totals = { ...o.totals, total: 10100 };

    const before = { lines: was.lines, totals: was.totals };
    const more = orderChanged(o, { links, difference: 700, before });

    // Removals head the list, as plain lines (James, T4).
    has(more.text, "\nRemoved\n- 1 × Sausage\n\nYour order now\n" +
      "- 2 × Whole Chicken\n- 3 × Eggs (per dozen) (2 added)\n");
    assert.doesNotMatch(more.text, /0 ×|removed\)/);
    has(more.text, "- Total $101 (was $94, you paid $7 more)\n");
    assert.doesNotMatch(more.text, /You paid|few days/);

    const back = orderChanged(o, { links, difference: -2500, before });

    has(back.text, "- Total $101 (was $94, you were refunded $25)\n");
    has(back.text, "Your refund can take a few days to reach you.");
  });

  it("groups part of a line taken out, and nothing when none was", () => {
    const was = order();
    const o = order();

    o.lines = [{ ...was.lines[0], qty: 1 }, was.lines[1]];

    const before = { lines: was.lines, totals: was.totals,
      method: "delivery" };

    has(orderChanged(o, { links, before }).text,
      "\nRemoved\n- 1 × Whole Chicken, 3.5 – 3.9 lbs\n");
    has(farmOrderChanged(o, { links, before }).text,
      "\nRemoved\n- 1 × Whole Chicken, 3.5 – 3.9 lbs\n");
    assert.doesNotMatch(
      orderChanged(was, { links, before }).text, /Removed|order now/);
  });

  it("states the refund a cancellation sends back (T1a)", () => {
    const m = orderCancelled(order(), { refunded: 6700, links });

    assert.equal(m.subject, "Your order is cancelled");
    has(m.text, "We cancelled your order for delivery on Thursday, " +
      "October 8.\n**A refund of $67 is on its way.**\nMost refunds " +
      "arrive within a few business days.");
    assert.match(m.text, /Order number: \*\*NFF-2610-ABCD\*\*/);
    assert.doesNotMatch(m.text, /charged/);
  });

  it("says a customer's own cancel was as they asked", () => {
    const m = orderCancelled(order(), {
      by: "customer", refunded: 6700, reason: "delay", links,
    });

    has(m.text, "October 8, as requested.");
    assert.doesNotMatch(m.text, /ready in time/);
  });

  it("leaves out \"as requested\" after a missed delivery (C4)", () => {
    const o = { ...order(), attempted: { cause: "customer", fee: 500 } };
    const m = orderCancelled(o, { by: "customer", refunded: 6200, links });

    has(m.text, "on Thursday, October 8.\n");
    assert.doesNotMatch(m.text, /as requested/);
  });

  it("gives the farm's reason from the list, or its own words (T2a)", () => {
    const pickup = {
      ...order(), fulfilment: { ...order().fulfilment, method: "onfarm" },
    };
    const says = (o, options) =>
      orderCancelled(o, { refunded: 6700, links, ...options }).text;

    has(says(order(), { reason: "sold-out" }), "Something in your order " +
      "sold out before our stock count caught up. We're sorry we didn't " +
      "catch it before you placed your order.");
    has(says(order(), { reason: "delay" }), "We couldn't get your order " +
      "ready in time for Thursday, October 8.");
    has(says(order(), { reason: "weather" }), "For everyone's safety, we " +
      "won't deliver on Thursday, October 8 due to severe weather.");
    has(says(pickup, { reason: "weather" }), "won't open for pickup on");
    has(says(order(), { reason: "emergency" }), "Something urgent came up " +
      "on the farm that needs us that day.");
    has(says(order(), { reason: "mistake" }), "We made a mistake with " +
      "your order so we had to cancel it. We're sorry we didn't catch it " +
      "before you placed your order.");
    has(says(order(), { reasonText: "The truck broke down." }),
      "October 8.\nThe truck broke down.\n**A refund");
    assert.equal(Object.keys(CANCEL_REASONS).length, 5);
  });

  it("dates a refund made before the cancel", () => {
    const m = orderCancelled(order(), {
      refunded: 6700, refundedOn: "2026-10-07T02:00:00.000Z", links,
    });

    has(m.text, "**We refunded $67 on Tuesday, October 6.**");
    assert.doesNotMatch(m.text, /on its way/);
  });

  const attempted = (fee) => ({
    ...order(), attempted: { cause: "customer", fee, waived: !fee },
  });

  it("warns a missed delivery that keeps its fee before they choose", () => {
    const pick = "https://example.test/pick";
    const m = missedDelivery(attempted(500), { pickUrl: pick, links });

    assert.equal(m.subject, "We couldn't deliver your order");
    has(m.text, "- Deliver it next Thursday, October 15, for " +
      "another delivery fee of $5");
    has(m.text, "- Cancel it, and we'll refund $62 for your items");
    has(m.text, "Today's delivery fee of $5 isn't refunded, whichever " +
      "you choose.");
    has(m.text, `Reschedule or cancel: ${pick}`);
    has(m.text, "We'll hold your order until Thursday, October 15. If " +
      "you haven't chosen by then, we'll cancel it and refund $62 for " +
      "your items.");
  });

  it("promises everything back when the missed fee is waived", () => {
    const m = missedDelivery(attempted(0), { links });

    has(m.text, "- Deliver it next Thursday, October 15, at no " +
      "extra charge");
    has(m.text, "- Cancel it for a full refund of $67");
    has(m.text, "we'll cancel it and refund it in full.");
    assert.doesNotMatch(m.text, /isn't refunded|fee/);
  });

  it("says what we saw for each of the customer's causes (C6a)", () => {
    const missed = (cause, extra = {}) => missedDelivery({
      ...attempted(500), attempted: { cause, fee: 500, ...extra },
    }, { links }).text;
    const d = order().fulfilment.delivery;
    const lead = "We came by today with your order but couldn't leave it: ";
    const tail = ". Your order is back at the farm.";

    has(missed("no-cooler"), `${lead}we didn't find a cooler where you ` +
      `told us (${d.cooler}), and we couldn't reach you by phone, text ` +
      `or the doorbell${tail}`);
    has(missed("no-access", { detail: "the gate was locked" }), `${lead}we ` +
      "couldn't get to where you asked us to leave it (the gate was " +
      "locked), and we couldn't reach you by phone, text or the doorbell");
    has(missed("no-access"), "leave it, and we couldn't reach you");
    has(missed("no-address"), `${lead}we couldn't find your address as ` +
      `you gave it (${d.address1}, ${d.town}), and we couldn't reach ` +
      `you${tail}`);
    has(missed("customer"), `${lead}there was no cooler out, and we ` +
      `couldn't reach you${tail}`);
  });

  it("moves a farm or weather miss to next Thursday, fee and all", () => {
    const weather = { ...attempted(0), attempted: { cause: "weather" } };
    const w = movedDelivery(weather, { links });
    const f = movedDelivery({ ...attempted(0),
      attempted: { cause: "farm" } }, { links });

    assert.equal(w.subject, "Your delivery is moved to next Thursday");
    has(w.text, "The weather kept us from delivering your order today, so " +
      "we've moved your delivery to next Thursday, October 15.");
    has(f.text, "We weren't able to deliver your order today, so");
    has(f.text, "cancel for a full refund of $67, delivery fee included.");
  });

  it("says why when the hold ran out", () => {
    const m = orderCancelled(attempted(500),
      { by: "hold", refunded: 6200, links });

    has(m.text, "We held your order for seven days and didn't hear from " +
      "you, so we've cancelled it.");
    has(m.text, "**A refund of $62 is on its way.**");
  });

  it("states the refund that went out after a missed delivery", () => {
    const kept = orderCancelled(attempted(500), { refunded: 6200, links });
    const full = orderCancelled(attempted(0), { refunded: 6700, links });

    has(kept.text, "**A refund of $62 is on its way.**\nThe delivery " +
      "fee of $5 isn't refunded because we made the trip.");
    has(full.text, "**A refund of $67 is on its way.**");
    assert.doesNotMatch(full.text, /delivery fee/);
  });
});

describe("addresses and sign-in", () => {
  const customer = {
    name: "Pat Example", email: "pat@example.com",
    address: {
      address1: "5 Far Rd", town: "Nowhere", state: "MA", zip: "01234",
      status: "pending",
    },
  };

  it("tells an approved address to start a delivery order", () => {
    const m = addressDecision(customer, "approved", { links });

    assert.equal(m.subject, "We can deliver to your address");
    has(m.text, "Good news! We can deliver to you at 5 Far Rd, Nowhere " +
      "01234.");
    assert.match(m.text, /Start a delivery order: https:\/\/x\/order\//);
    assert.match(m.html, /href="https:\/\/x\/order\/"/);
  });

  it("asks the farm to review an address, with a map and the commands",
    () => {
      const m = addressReview(customer, { links });

      assert.match(m.subject, /Address to review: Pat Example/);
      has(m.text, "Pat Example (pat@example.com) saved an address " +
        "outside of the published delivery area.");
      assert.doesNotMatch(m.html, /admin.example.com\/customers/,
        "no link to a dashboard page without the customer (T5b)");
      assert.match(m.text, /Location: \*\*5 Far Rd, Nowhere, MA 01234\*\*/);
      has(m.text, "View location in Maps: https://maps.apple.com/?address=" +
        "5%20Far%20Rd%2C%20Nowhere%2C%20MA%2001234");
      has(m.text, "Approve it:\n\n    bin/nff address approve " +
        "pat@example.com\n");
      has(m.text, "Or deny it:\n\n    bin/nff address deny pat@example.com\n");
      assert.match(m.html, new RegExp("<pre [^>]*user-select:all\">" +
        "bin/nff address approve pat@example.com</pre>"));
      assert.match(m.text, /Admin: https:\/\/admin.example.com/);
    });

  it("sends a one-time link that says how long it lasts", () => {
    const m = magicLink("pat@example.com", "https://x/api/auth/verify?t=1",
      { links });

    assert.equal(m.subject, "Your secure sign-in link to North Foster Farm");
    assert.match(m.text,
      /Click the button below to sign in\. This link expires in 15 minutes\./);
    assert.match(m.html, /href="https:\/\/x\/api\/auth\/verify\?t=1"/);
    has(m.text, "If you didn't request this email, you can safely ignore " +
      "it.");
    has(m.text, "Need help? Contact us: mailto:sales@northfosterfarm.com");
  });

  it("summarises an order in one line", () => {
    assert.equal(
      summaryLine(order()),
      "NFF-2610-ABCD paid $67 Delivery 2026-10-08 pat@example.com"
    );
  });

  it("carries the farm's contact details in every message", () => {
    for (const m of [orderConfirmed(order("onfarm")),
      orderConfirmed(order())]) {
      assert.match(both(m), /sales@northfosterfarm.com/);
      assert.match(both(m), /\(401\) 578-3713/);
    }
  });
});

describe("where the order id belongs", () => {
  const o = order();

  it("is out of every subject the customer reads, and in the body", () => {
    const customerMail = [
      orderConfirmed(o),
      deliveryReminder(o),
      orderCancelled(o),
      orderChanged(o),
    ];

    for (const m of customerMail) {
      assert.doesNotMatch(m.subject, /NFF-/, m.subject);
      assert.match(m.text, /Order number: \*\*NFF-2610-ABCD\*\*/, m.subject);
      // The receipt prices the lines; no customer email repeats it.
      assert.doesNotMatch(m.text, /\(\$/, m.subject);
    }
  });

  it("stays in the farm's subjects, which list many orders", () => {
    for (const m of [farmOrderPlaced(o), farmPickupChanged(order("onfarm"))]) {
      assert.match(m.subject, /NFF-2610-ABCD/);
    }
  });
});

describe("the farm's own notices", () => {
  const reachable = (method) => {
    const o = order(method);

    o.customer = {
      name: "Pat Example", email: "pat@example.com",
      phone: "401-555-0100", contact: "text",
    };

    return o;
  };
  const square = "https://app.squareup.com/dashboard/orders/overview/SO-1";

  it("sends the account page's notices on the farm card", () => {
    const o = reachable("delivery");
    const c = o.customer;
    const refund = farmRefundNeeded(o, c, { links });
    const sync = farmSquareOutOfSync(o, c, { links });
    const back = farmReturnRequest(o, c, {
      id: "r1", reason: "Cracked <eggs>", skus: ["B"],
    }, { links });
    const help = farmSupport(c, {
      subject: "Eggs", message: "Hi", orderId: o.id,
    }, { links });

    for (const [m, tag] of [[refund, "REFUND NEEDED"],
      [sync, "SQUARE OUT OF SYNC"], [back, "RETURN REQUEST"],
      [help, "SUPPORT"]]) {
      has(m.text, `\n${tag}\n`);
      assert.doesNotMatch(m.text, /View order:|View customer/, "T5b");
      has(m.text, "Admin: https://admin.example.com");
    }
    has(refund.text, "Pat Example cancelled paid order NFF-2610-ABCD, " +
      "delivery on Thursday, October 8. Refund it and close it:\n\n" +
      "    bin/nff orders cancel NFF-2610-ABCD\n");
    has(sync.text, "Check the fulfilment in Square: delivery on " +
      "Thursday, October 8.");
    has(back.text, "Items: Eggs (per dozen), Large");
    has(back.html, "Cracked &lt;eggs&gt;");
    has(back.text, "    bin/nff returns resolve NFF-2610-ABCD r1\n");
    has(help.text, "Pat Example wrote from their account page. Reply to " +
      "this email to answer them.");
  });

  it("says in the subject what it is, which order and how much", () => {
    assert.equal(
      farmOrderPlaced(reachable("delivery")).subject,
      "New order NFF-2610-ABCD — $67, delivery"
    );
    assert.equal(
      farmOrderPlaced(reachable("onfarm")).subject,
      "New order NFF-2610-ABCD — $62, on-farm pickup"
    );
  });

  it("packs the order: who, what, how much, where, and the links", () => {
    const o = reachable("delivery");

    o.fulfilment.delivery.notes = "Dog in the yard";
    const m = farmOrderPlaced(o, { squareUrl: square, links });

    assert.match(m.text, /\nCustomer details\n/);
    has(m.text, "- Pat Example\n- pat@example.com\n- 401-555-0100, " +
      "prefers a text");
    assert.match(m.html, new RegExp("<li><span [^>]*user-select:all\">" +
      "pat@example.com</span></li>"), "the address is set for copying");
    assert.match(m.text, /\nOrder details\n/);
    assert.doesNotMatch(m.text, /View order:|View customer/,
      "the dashboard doesn't show the site's orders yet (T5b)");
    assert.match(m.text, /Order number: \*\*NFF-2610-ABCD\*\*/);
    assert.match(m.text, /- 2 × Whole Chicken, 3.5 – 3.9 lbs \(\$60\)/);
    has(m.text, "- Subtotal $67\n- Bulk discount ($50+) −$5\n" +
      "- Delivery fee +$5\n- Total $67");
    assert.match(m.text, /Order type: \*\*Delivery\*\*/);
    assert.match(m.text, /- Address: 1 Main St, Foster, RI 02825/);
    assert.match(m.text, /- Cooler: Side porch/);
    assert.match(m.text, /- Gate or door code: 1234/);
    assert.match(m.text, /- Notes: Dog in the yard\./);
    has(m.text, "Paid: **$67 by Visa ending 4242**");
    assert.ok(m.text.includes(`View order in Square: ${square}`));
    assert.doesNotMatch(m.text, /invoice/i);
    has(m.html, '<a href="https://admin.example.com" ' +
      'style="color:#186243">Admin</a>');
  });

  it("says the fee is waived when it is", () => {
    const o = order();

    o.totals.deliveryFee = 0;
    assert.match(farmOrderPlaced(o).text, /Delivery fee waived/);
    assert.doesNotMatch(farmOrderPlaced(order("onfarm")).text, /Delivery fee/);
  });

  it("names a ride-along as the delivery it is (#183)", () => {
    const o = order();

    o.totals.deliveryFee = 0;
    o.fulfilment.rideAlong = true;
    assert.match(farmOrderPlaced(o).text, /- Ride-along delivery, no fee\n/);
    assert.doesNotMatch(farmOrderPlaced(o).text, /Delivery fee/);
  });

  it("names the outside-area fee on its own line", () => {
    const o = order("delivery");

    o.totals = {
      ...o.totals, deliveryFee: 800, areaFee: 300, total: o.totals.total + 300,
    };
    has(farmOrderPlaced(o).text,
      "- Delivery fee +$5\n- Outside-area fee +$3\n- Total $70");
  });

  it("sets the order number for copying, farm side only", () => {
    const m = farmOrderPlaced(reachable("delivery"), { links });

    assert.match(m.html, new RegExp("Order number</p><p[^>]*><span [^>]*" +
      "user-select:all\">NFF-2610-ABCD</span>"));
    assert.match(m.text, /Order number: \*\*NFF-2610-ABCD\*\*/);
  });

  it("gives a pickup its when and where", () => {
    const m = farmOrderPlaced(reachable("onfarm"), { links });

    assert.match(m.text, /Order type: \*\*On-farm pickup\*\*/);
    assert.match(m.text, /- When: Thursday, October 8, 9 AM – noon/);
    assert.doesNotMatch(m.text, /prefers a call|Cooler/);
  });

  it("says how the money came, in the farm's words", () => {
    const paidBy = (payment) => paymentPhrase({ ...order(), payment });

    assert.equal(paymentPhrase(order()), "$67 by Visa ending 4242");
    assert.equal(paidBy({ via: "square", method: "card", brand: "MASTERCARD",
      last4: "0005" }), "$67 by Mastercard ending 0005");
    assert.equal(paidBy({ via: "square", method: "card", brand:
      "AMERICAN_EXPRESS", last4: "1001" }),
    "$67 by American Express ending 1001");
    assert.equal(paidBy({ via: "square", method: "applepay", brand: "VISA",
      last4: "4242" }), "$67 by Apple Pay");
    assert.equal(paidBy({ via: "square", method: "googlepay" }),
      "$67 by Google Pay");
    assert.equal(paidBy({ via: "square", method: "cashapp" }),
      "$67 by Cash App Pay");
    assert.equal(paidBy({ via: "venmo", method: "venmo" }), "$67 by Venmo");
    assert.equal(paidBy({ via: "cash" }), "$67 by cash");
    assert.equal(paidBy({ via: "square", method: "card" }), "$67 by card",
      "no last four known");
    assert.equal(paymentPhrase({ ...order(), payment: undefined }),
      "$67 by card", "a record from before payments were kept");
    has(farmOrderPlaced({ ...order(), payment: { via: "venmo",
      method: "venmo" } }).text, "Paid: **$67 by Venmo**");
    // Changed after paying: each payment, in order.
    assert.equal(paymentPhrase({ ...order(), payments: [
      { amount: 6200, via: "square", method: "card", brand: "VISA",
        last4: "4242" },
      { amount: 500, via: "venmo", method: "venmo" },
    ] }), "$62 by Visa ending 4242, then $5 by Venmo");
  });

  it("leaves out the links it has no address for", () => {
    const m = farmOrderPlaced(order("onfarm"));

    assert.doesNotMatch(m.text, /View customer|View order|Square|Admin:/);
  });
});
