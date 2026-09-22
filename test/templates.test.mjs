import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addressDecision, addressReview, completeYourOrder, deliveryReminder,
  farmOrderPaid, farmOrderPlaced, magicLink, orderCancelled, orderChanged,
  orderConfirmed, paymentReminder, summaryLine,
} from "../netlify/functions/lib/templates.mjs";

const order = (method = "delivery") => ({
  id: "NFF-2610-ABCD",
  status: "submitted",
  submittedAt: "2026-10-06T13:00:00Z",
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
  square: { invoiceUrl: "https://squareup.com/pay/xyz", invoiceNumber: "7" },
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
    const m = completeYourOrder(order(), { links });

    assert.match(m.text, /\nOrder details\n/);
    assert.match(m.text, /Order number: \*\*NFF-2610-ABCD\*\*/);
    assert.match(m.html, /Order number: <strong>NFF-2610-ABCD<\/strong>/);
    assert.match(m.text, /^- 2 × Whole Chicken, 3.5 – 3.9 lbs$/m);
    assert.doesNotMatch(m.text, /\$60|Subtotal|Bulk discount|Delivery fee/);
    assert.match(m.text, /Order type: \*\*Delivery\*\*/);
    assert.match(m.text,
      /- Arrives: Thursday, October 8, usually between 10 AM and 4 PM/);
    assert.match(m.text, /- Address: 1 Main St, Foster, RI 02825/);
  });

  it("gives a pickup its when and where instead", () => {
    const farm = completeYourOrder(order("onfarm"), { links });

    assert.match(farm.text, /Order type: \*\*On-farm pickup\*\*/);
    assert.match(farm.text, /- When: Thursday, October 8, morning/);
    assert.match(farm.text, /- Where: 99 East Killingly Road, Foster, RI/);
    assert.doesNotMatch(farm.text, /Arrives:|Address:/);

    const o = order("scituate");

    o.fulfilment.date = "2026-10-17";
    const drop = completeYourOrder(o, { links });

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

  it("makes the Square link a button on the paid notice", () => {
    const m = farmOrderPaid(order(), {
      squareUrl: "https://sq/1", links,
    });

    assert.match(m.html,
      /<a href="https:\/\/sq\/1" style="[^"]*background:#186243">/);
    has(m.html, ">View invoice in Square</a>");
  });
});

describe("the footer row", () => {
  it("links the orders page and a way to write, on every customer mail", () => {
    for (const m of [completeYourOrder(order(), { links }),
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
    const m = completeYourOrder(order());

    assert.doesNotMatch(m.text, /Your orders/);
    assert.match(m.text, /Contact us: mailto:sales@northfosterfarm.com/);
  });

  it("uses CONTACT_URL when the site has a contact page", () => {
    const m = completeYourOrder(order(), {
      links: { ...links, contact: "https://x/#contact" },
    });

    assert.match(m.text, /Contact us: https:\/\/x\/#contact/);
  });
});

describe("complete your order", () => {
  it("leads with the not-final warning and the pay button", () => {
    const m = completeYourOrder(order(), { links });

    assert.equal(m.subject, "One more step: pay for your order");
    assert.match(m.text, /Hi Pat,/);
    assert.match(m.text, /\*\*Your order isn't final until it's paid\.\*\*/);
    assert.match(m.text, /Here's your invoice for \$67\. Pay it to complete/);
    assert.match(m.text,
      /Pay and confirm your order: https:\/\/squareup.com\/pay\/xyz/);
    assert.match(m.html, /href="https:\/\/squareup.com\/pay\/xyz"/);
  });

  it("greets by the first name on the record when there is one", () => {
    const o = order();

    o.customer.firstName = "Mary Ann";
    o.customer.name = "Mary Ann Smith";
    assert.match(completeYourOrder(o).html, /Hi Mary Ann,/);
    assert.match(completeYourOrder(order()).html, /Hi Pat,/,
      "an order from before the split still greets by the first word");
  });

  it("escapes what the customer typed, and still marks up the bold", () => {
    const o = order();

    o.customer.name = "<b>Pat</b>";
    const m = completeYourOrder(o);

    assert.match(m.html, /Hi &lt;b&gt;Pat&lt;\/b&gt;,/);
    assert.doesNotMatch(m.html, /<b>Pat<\/b>/);
    has(m.html, "<strong>Your order isn't final until it's paid.</strong>");
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

  it("warns a pickup that its window is not a booking", () => {
    for (const m of [orderConfirmed(order("onfarm")),
      completeYourOrder(order("onfarm"))]) {
      assert.match(m.text, /the time you asked for, not a booking yet/);
      assert.match(m.text, /in touch to settle it before Thursday, October 8/);
    }

    assert.doesNotMatch(orderConfirmed(order()).text, /not a booking/,
      "a delivery has a window the farm already committed to");
  });
});

describe("payment reminders", () => {
  it("say the amount, show the button, and link the order", () => {
    for (const stage of ["soon", "nextDay", "final"]) {
      const m = paymentReminder(order(), stage, {
        orderUrl: url, settingsUrl: settings, links,
      });

      assert.match(m.text, /\$67/, stage);
      assert.match(m.text, /Pay and confirm your order: https:\/\/squareup/,
        stage);
      assert.match(m.text, /Order number: \*\*NFF-2610-ABCD\*\*/, stage);
      assert.doesNotMatch(m.text, /\(\$60\)|Subtotal/, stage);
      assert.match(m.text, new RegExp(`View or cancel this order: ${url}`),
        stage);
      has(m.text, `Turn off payment reminders: ${settings}`, stage);
      assert.doesNotMatch(m.subject, /NFF-2610-ABCD/, "not in the subject");
    }
  });

  it("read as James wrote them, stage by stage", () => {
    const at = (iso) => new Date(`${iso}T12:00:00Z`);
    const soon = paymentReminder(order(), "soon");
    const next = paymentReminder(order(), "nextDay", { now: at("2026-10-05") });
    const last = paymentReminder(order(), "final", { now: at("2026-10-07") });

    assert.equal(soon.subject, "Still waiting for payment");
    has(soon.text, "You placed an order about an hour ago, and the " +
      "invoice for $67 is still open. **Your order isn't final until " +
      "it's paid.**");

    assert.equal(next.subject, "Your order is waiting for payment");
    has(next.text, "Your invoice for $67 from yesterday hasn't been paid " +
      "yet. **Your order isn't final until we receive your payment.**");
    has(next.text, "Confirm your order by 12 PM on Wednesday to keep your " +
      "delivery appointment.");

    assert.equal(last.subject,
      "Last call: your unpaid order will be cancelled");
    has(last.text, "**Your order will be cancelled and marked abandoned " +
      "in your order history, unless you submit your payment today.**");
    has(last.text, "Your invoice for $67 is still unpaid. Pay before 12 PM " +
      "today to receive your delivery tomorrow.");
    assert.doesNotMatch(soon.text, /abandoned/);
  });

  it("names the cutoff day in full when it is a week or more off", () => {
    const m = paymentReminder(order(), "nextDay", {
      now: new Date("2026-09-29T12:00:00Z"),
    });

    assert.match(m.text, /by 12 PM on Wednesday, October 7 to keep/);
  });

  it("gives a pickup, which has no cutoff, the plain last call", () => {
    const m = paymentReminder(order("onfarm"), "final", {
      now: new Date("2026-10-07T12:00:00Z"),
    });

    assert.doesNotMatch(m.text, /Pay before/);
    has(m.text, "and on-farm pickup on Thursday, October 8, morning is " +
      "coming up. Pay now to keep your spot.");
    assert.doesNotMatch(paymentReminder(order("onfarm"), "nextDay").text,
      /Confirm your order by/);
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

  it("tells an unpaid cancellation nothing was charged", () => {
    const m = orderCancelled(order(), { links });

    assert.equal(m.subject, "Your order is cancelled");
    has(m.text, "We cancelled your order. Your invoice is closed and you " +
      "were not charged.");
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

  it("asks the farm to review an address, with a map", () => {
    const m = addressReview(customer, {
      cliHint: "bin/nff address approve pat@example.com", links,
    });

    assert.match(m.subject, /Address to review: Pat Example/);
    has(m.html, '<a href="https://admin.example.com/customers/' +
      'pat%40example.com">Pat Example</a> saved an address outside of the ' +
      "published delivery area.");
    assert.match(m.text, /Location: \*\*5 Far Rd, Nowhere, MA 01234\*\*/);
    has(m.text, "View location in Maps: https://maps.apple.com/?address=" +
      "5%20Far%20Rd%2C%20Nowhere%2C%20MA%2001234");
    assert.match(m.text, /Approve or deny it: bin\/nff address approve/);
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
      "NFF-2610-ABCD submitted $67 Delivery 2026-10-08 pat@example.com"
    );
  });

  it("carries the farm's contact details in every message", () => {
    for (const m of [completeYourOrder(order()), orderConfirmed(order())]) {
      assert.match(both(m), /sales@northfosterfarm.com/);
      assert.match(both(m), /\(401\) 578-3713/);
    }
  });
});

describe("where the order id belongs", () => {
  const o = order();

  it("is out of every subject the customer reads, and in the body", () => {
    const customerMail = [
      completeYourOrder(o),
      orderConfirmed(o),
      paymentReminder(o, "soon"),
      paymentReminder(o, "nextDay"),
      paymentReminder(o, "final"),
      deliveryReminder(o),
      orderCancelled(o),
      orderChanged(o),
    ];

    for (const m of customerMail) {
      assert.doesNotMatch(m.subject, /NFF-/, m.subject);
      assert.match(m.text, /Order number: \*\*NFF-2610-ABCD\*\*/, m.subject);
      // The invoice prices the lines; no customer email repeats it.
      assert.doesNotMatch(m.text, /\(\$/, m.subject);
    }
  });

  it("stays in the farm's subjects, which list many orders", () => {
    for (const m of [farmOrderPlaced(o), farmOrderPaid(o)]) {
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
      farmOrderPaid(reachable("onfarm")).subject,
      "Paid: order NFF-2610-ABCD — $62"
    );
  });

  it("packs the order: who, what, how much, where, and the links", () => {
    const o = reachable("delivery");

    o.fulfilment.delivery.notes = "Dog in the yard";
    const m = farmOrderPlaced(o, { squareUrl: square, links });

    assert.match(m.text, /\nCustomer details\n/);
    has(m.text, "- Pat Example\n- pat@example.com\n- 401-555-0100, " +
      "prefers a text");
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
    assert.match(m.text, /Invoice status: \*\*Sent, unpaid\*\*/);
    assert.ok(m.text.includes(`View invoice in Square: ${square}`));
    has(m.html, '<a href="https://admin.example.com" ' +
      'style="color:#186243">Admin</a>');
  });

  it("says the fee is waived when it is", () => {
    const o = order();

    o.totals.deliveryFee = 0;
    assert.match(farmOrderPlaced(o).text, /Delivery fee waived/);
    assert.doesNotMatch(farmOrderPlaced(order("onfarm")).text, /Delivery fee/);
  });

  it("gives a pickup its when and where", () => {
    const m = farmOrderPlaced(reachable("onfarm"), { links });

    assert.match(m.text, /Order type: \*\*On-farm pickup\*\*/);
    assert.match(m.text, /- When: Thursday, October 8, morning/);
    assert.doesNotMatch(m.text, /prefers a call|Cooler/);
  });

  it("reports a payment in three lines", () => {
    const m = farmOrderPaid(reachable("delivery"), {
      squareUrl: square, links,
    });

    assert.match(m.text, /Payment received\./);
    assert.match(m.text,
      /View order: https:\/\/admin.example.com\/orders\/NFF-2610-ABCD/);
    assert.ok(m.text.includes(`View invoice in Square: ${square}`));
    assert.doesNotMatch(m.text, /Whole Chicken/);
  });

  it("leaves out the links it has no address for", () => {
    const m = farmOrderPlaced(order("onfarm"));

    assert.doesNotMatch(m.text, /View customer|View order|Square|Admin:/);
  });
});
