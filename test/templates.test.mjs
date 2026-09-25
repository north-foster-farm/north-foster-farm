import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addressDecision, addressReview, deliveryReminder, farmAlert,
  farmMorningReport, farmOrderPlaced, farmPickupChanged, farmTomorrow,
  magicLink, orderCancelled, orderChanged, orderConfirmed, paymentPhrase,
  paymentReceived, pickNewTime, summaryLine,
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
    onfarm: method === "onfarm" ? { window: "morning" } : null,
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
    assert.match(farm.text, /- When: Thursday, October 8, morning/);
    assert.match(farm.text, /- Where: 99 East Killingly Road, Foster, RI/);
    assert.doesNotMatch(farm.text, /Arrives:|Address:/);

    const o = order("scituate");

    o.fulfilment.date = "2026-10-17";
    const drop = orderConfirmed(o, { links });

    assert.match(drop.text, /Order type: \*\*Scituate drop site\*\*/);
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
    for (const m of [paymentReceived(order("onfarm"), { links }),
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

  it("escapes what the customer typed, and still marks up the bold", () => {
    const o = order("onfarm");

    o.fulfilment.state = "requested";
    o.customer.name = "<b>Pat</b>";
    const m = pickNewTime(o);

    assert.match(m.html, /Hi &lt;b&gt;Pat&lt;\/b&gt;,/);
    assert.doesNotMatch(m.html, /<b>Pat<\/b>/);
    has(m.html, "<strong>The morning of Thursday, October 8 doesn't work " +
      "for us.</strong>");
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

  it("tells a pickup its time is set, with the hours the farm confirmed",
    () => {
      const m = orderConfirmed(order("onfarm"), { links });

      has(m.text, "Thanks, Pat. Your payment of $62 came through and your " +
        "pickup time is set, so your order is confirmed.");
      assert.match(m.text, /- When: Thursday, October 8, morning/,
        "a legacy order without confirmed hours keeps the window word");
      assert.doesNotMatch(m.text, /not a booking|Requested:/);

      const o = order("onfarm");

      o.fulfilment.state = "agreed";
      o.fulfilment.onfarm.confirmed = { from: 9, to: 11 };
      const set = orderConfirmed(o, { orderUrl: url, links });

      assert.match(set.text,
        /- When: Thursday, October 8, 9 – 11 AM \(morning\)/);
      has(set.text, `View or edit this order: ${url}`);
      has(set.text, `Reschedule pickup: ${url}`);
      assert.doesNotMatch(orderConfirmed(order(), { orderUrl: url, links })
        .text, /Reschedule pickup/, "a delivery has no pickup to move");

      const late = order("onfarm");

      late.fulfilment.state = "agreed";
      late.fulfilment.onfarm = { window: "afternoon",
        confirmed: { from: 11, to: 13 } };
      assert.match(orderConfirmed(late, { links }).text,
        /11 AM – 1 PM \(afternoon\)/);
    });
});

// An on-farm window the farm has not agreed to yet.
const requested = () => {
  const o = order("onfarm");

  o.fulfilment.state = "requested";

  return o;
};

describe("an on-farm pickup awaiting the farm", () => {
  it("hears that the payment arrived and the window is being checked",
    () => {
      const m = paymentReceived(requested(), { orderUrl: url, links });

      assert.equal(m.subject, "Payment received");
      has(m.text, "Thanks, Pat. Your payment of $62 came through.\n" +
        "We're checking the schedule to make sure we can accommodate your " +
        "requested pick-up time, and will confirm it by Wednesday, " +
        "October 7.");
      assert.match(m.html, /came through\.<\/p><p>We're checking/,
        "two paragraphs");
      assert.match(m.text, /- Requested: Thursday, October 8, morning/);
      has(m.text, `View or edit this order: ${url}`);
    });

  it("is sent back to pick again when the farm says no", () => {
    const o = requested();
    const pick = "https://x/api/auth/verify?token=abc";
    const m = pickNewTime(o, {
      reason: "We're at the Scituate market that morning.", pickUrl: pick,
      links,
    });

    assert.equal(m.subject, "One more step: pick a new pickup time");
    has(m.text, "Hi Pat,");
    has(m.text, "**The morning of Thursday, October 8 doesn't work for " +
      "us.**");
    has(m.text, "Here's why: _**We're at the Scituate market that " +
      "morning.**_");
    assert.match(m.html,
      /<em><strong>We're at the Scituate market that morning.<\/strong><\/em>/);
    has(m.text, "Please pick another day or window, and we'll be in touch " +
      "to confirm. If rescheduling isn't an option, you can cancel your " +
      "order from the same page for a full refund.");
    has(m.text, `Pick a new time: ${pick}`);
    assert.doesNotMatch(m.text, /reminders are paused/,
      "the pause is not disclosed");
    assert.match(m.text, /- Requested: Thursday, October 8, morning/);

    // No reason typed: no italic line; paid reads the same.
    const paid = { ...o, status: "paid" };
    const bare = pickNewTime(paid, { pickUrl: pick, links });

    assert.doesNotMatch(bare.text, /_\*\*|Here's why/);
    has(bare.text, "from the same page for a full refund.");

    // Accounts off: no button, a reply instead.
    const reply = pickNewTime(o, { links });

    assert.doesNotMatch(reply.text, /Pick a new time:/);
    has(reply.text, "Please reply with another day or window, and we'll " +
      "be in touch to confirm. If rescheduling isn't an option, reply and " +
      "we'll cancel your order for a full refund.");
  });

  it("gives the farm the confirm and deny commands on the new order", () => {
    const m = farmOrderPlaced(requested(), { links });

    has(m.text, "Pickup time: **Requested, not yet confirmed**");
    has(m.text, "They asked for the morning, which runs 9:00 to 12:00. " +
      "Confirming with no hours tells them you'll be there for the first " +
      "two hours of it, 9:00 to 11:00:\n\n    bin/nff orders confirm " +
      "NFF-2610-ABCD\n");
    has(m.text, "10:00 to 12:00, then 10:00 to 12:00:\n\n    bin/nff orders " +
      "confirm NFF-2610-ABCD --at 10\n\n\n    bin/nff orders confirm " +
      "NFF-2610-ABCD --at 10 --until 12\n");
    has(m.text, "in your words:\n\n    bin/nff orders deny NFF-2610-ABCD " +
      "--reason \"...\"\n");
    assert.ok(m.text.indexOf("Requested: Thursday")
      < m.text.indexOf("Pickup time:"), "after the order details");
    assert.ok(m.text.indexOf("Pickup time:")
      < m.text.indexOf("Paid: **"), "before the paid line");
    assert.doesNotMatch(farmOrderPlaced(order(), { links }).text,
      /Pickup time:|orders confirm/);
  });

  it("tells the farm when the customer moves the time", () => {
    const m = farmPickupChanged(requested(), { links });

    assert.equal(m.subject, "Pickup time to confirm: NFF-2610-ABCD");
    has(m.text, "Pat Example moved order NFF-2610-ABCD to a new pickup " +
      "time. It needs confirming again.");
    has(m.text, "Requested: **Thursday, October 8, morning**");
    has(m.text, "\n    bin/nff orders confirm NFF-2610-ABCD\n");
    has(m.text, "View order: https://admin.example.com/orders/NFF-2610-ABCD");
    has(m.text, "Admin: https://admin.example.com");
  });

});

describe("the monitoring emails", () => {
  const stats = {
    placed: 4, paidByCard: 3, paidByVenmo: 1, declined: 1, cancelled: 0,
    refunded: 0, open: 2, mailFailures: 0, runs: 96, jobErrors: 0,
    invariants: 0,
  };

  it("morning report: the day in numbers, then the pickups to decide",
    () => {
      const waiting = requested();
      const denied = { ...requested(), id: "NFF-2610-EFGH", status: "paid" };

      denied.question = { kind: "window", openedAt: "x", answeredAt: null };
      const m = farmMorningReport(stats, [waiting, denied], {
        date: "2026-10-06", links,
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
      has(m.text, "These on-farm pickups are within two days and not " +
        "confirmed, oldest order first.");
      assert.match(m.text,
        /Order\s+Customer\s+Requested\s+Waiting\s+Status\n/);
      assert.match(m.text, new RegExp("NFF-2610-ABCD\\s+Pat Example\\s+" +
        "Thursday, October 8, morning\\s+.*\\s+to confirm\\n"));
      assert.match(m.text, new RegExp("NFF-2610-EFGH\\s+Pat Example\\s+" +
        "Thursday, October 8, morning\\s+.*\\*\\*denied, not " +
        "re-picked\\*\\*"));
      assert.doesNotMatch(m.text, /\bunpaid\b/, "no Paid column");
      has(m.text, "\n    bin/nff orders confirm <id>\n");
      has(m.text, "\n    bin/nff orders confirm\n");
      has(m.text, "Admin: https://admin.example.com");

      const quiet = farmMorningReport({ ...stats, declined: 4 }, [], {
        date: "2026-10-06", links, now: new Date("2026-10-06T12:00:00Z"),
      });

      has(quiet.text, "No pickups waiting on a decision.");
      assert.match(quiet.text, /Payments declined\s+4\s+🤮\n/,
        "many declines are worth a look");
    });

  it("tomorrow: every order due, by method, with what to pack", () => {
    const delivery = { ...order(), status: "paid" };
    const drop = { ...order("scituate"), id: "NFF-2610-DROP" };
    const farm = { ...requested(), id: "NFF-2610-FARM", status: "paid" };

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
    has(m.text, "\nScituate drop, 10:00 – 11:00 AM (1)\n");
    has(m.text, "**NFF-2610-DROP**, Pat Example, paid");
    has(m.text, "\nOn-farm pickups (1)\n");
    has(m.text, "**NFF-2610-FARM**, Pat Example, morning, NOT CONFIRMED, paid");

    // A confirmed pickup shows the hours; a delivery still unpaid from
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
    has(odd.text, "**NFF-2610-CONF**, Pat Example, 9 – 11 AM (morning), " +
      "confirmed, paid");

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
      [farmPickupChanged(requested(), { links }), "PICKUP TIME TO CONFIRM"],
    ];

    for (const [m, tag] of tagged) {
      assert.equal(m.text.split("\n")[2], tag, m.subject);
      assert.match(m.html, new RegExp("text-transform:uppercase;" +
        `color:#5e5e5f">${tag.charAt(0)}${tag.slice(1).toLowerCase()}</p>`),
      m.subject);
    }
    for (const m of [paymentReceived(order("onfarm"), { links }),
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
    assert.match(m.text, /Pat, here's your current order\./);
    assert.match(m.text, /Order number: \*\*NFF-2610-ABCD\*\*/);
    assert.doesNotMatch(m.text, /\nOrder details\n/, "no heading here");
    has(m.text, "Where will we find your cooler? _**Side porch**_");
    assert.match(m.text, /Gate or door code: _\*\*1234\*\*_/);
    assert.match(m.text, /Other notes or instructions: _\*\*Ring twice\.\*\*_/);
    assert.match(m.text, new RegExp(`View or edit this order: ${url}`));
  });

  it("tells a cancellation without a refund nothing more is charged", () => {
    const m = orderCancelled(order(), { links });

    assert.equal(m.subject, "Your order is cancelled");
    has(m.text, "We cancelled your order. Nothing more will be charged.");
    assert.match(m.text, /Order number: \*\*NFF-2610-ABCD\*\*/);
    assert.doesNotMatch(m.text, /refund/i);
  });

  it("tells a paid cancellation the refund is coming", () => {
    const m = orderCancelled(order(), { refund: true, links });

    has(m.text, "We cancelled your order for delivery on Thursday, " +
      "October 8.");
    has(m.text, "**Your refund is on its way.** Most refunds arrive within " +
      "a few business days.");
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
      has(m.html, '<a href="https://admin.example.com/customers/' +
        'pat%40example.com" style="color:#186243">Pat Example</a> saved an ' +
        "address outside of the published delivery area.");
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
    for (const m of [paymentReceived(order("onfarm")),
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
      paymentReceived(o),
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
    has(m.text, "View customer: https://admin.example.com/customers/" +
      "pat%40example.com");
    assert.match(m.text, /\nOrder details\n/);
    assert.match(m.text,
      /View order: https:\/\/admin.example.com\/orders\/NFF-2610-ABCD/);
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
    assert.match(m.text, /- When: Thursday, October 8, morning/);
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
