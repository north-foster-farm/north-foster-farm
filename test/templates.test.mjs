import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addressReview, completeYourOrder, deliveryReminder, magicLink,
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
    deliveryFee: method === "delivery" ? 500 : 0,
    total: method === "delivery" ? 6700 : 6200,
  },
  fulfilment: {
    method,
    date: "2026-10-08",
    onfarm: method === "onfarm" ? { window: "morning" } : null,
    delivery: method === "delivery" ? {
      address1: "1 Main St", address2: "", town: "Foster", zip: "02825",
      cooler: "Side porch", gate: "1234",
    } : null,
  },
  square: { invoiceUrl: "https://squareup.com/pay/xyz", invoiceNumber: "7" },
});

const both = (m) => `${m.text}\n${m.html}`;

describe("complete your order", () => {
  it("leads with the pay link and the not-final warning", () => {
    const m = completeYourOrder(order(), {
      accountUrl: "https://example.com/account/",
    });

    assert.equal(m.subject, "One more step: pay for order NFF-2610-ABCD");
    assert.match(m.text, /isn't final until it's paid/);
    assert.match(m.text, /Pay your invoice: https:\/\/squareup.com\/pay\/xyz/);
    assert.match(m.text, /2 × Whole Chicken, 3.5 – 3.9 lbs \(\$60\)/);
    assert.match(m.text, /Bulk discount \(\$50\+\) −\$5/);
    assert.match(m.text, /Delivery fee \+\$5/);
    assert.match(m.text, /Total \$67/);
    assert.match(m.text, /Local delivery on Thursday, October 8/);
    assert.match(m.text, /https:\/\/example.com\/account\//);
    assert.match(m.html, /href="https:\/\/squareup.com\/pay\/xyz"/);
    assert.match(m.html, /Hi Pat,/);
  });

  it("escapes what the customer typed", () => {
    const o = order();

    o.customer.name = "<b>Pat</b>";
    const m = completeYourOrder(o);

    assert.match(m.html, /Hi &lt;b&gt;Pat&lt;\/b&gt;,/);
    assert.doesNotMatch(m.html, /<b>Pat<\/b>/);
  });

  it("says the fee is waived when it is", () => {
    const o = order();

    o.totals.deliveryFee = 0;
    assert.match(completeYourOrder(o).text, /Delivery fee waived/);
    assert.doesNotMatch(
      completeYourOrder(order("onfarm")).text, /Delivery fee/
    );
  });
});

describe("order confirmed", () => {
  it("says it is reserved and when", () => {
    const m = orderConfirmed(order("onfarm"));

    assert.equal(m.subject, "Order NFF-2610-ABCD is confirmed");
    assert.match(m.text, /\$62 came through/);
    assert.match(m.text, /On-farm pickup on Thursday, October 8, morning\./);
    assert.match(m.text, /By appointment/);
  });
});

describe("payment reminders", () => {
  it("escalate by stage and the final one names abandonment", () => {
    const soon = paymentReminder(order(), "soon");
    const next = paymentReminder(order(), "nextDay");
    const last = paymentReminder(order(), "final");

    assert.match(soon.subject, /Still need to pay/);
    assert.match(next.subject, /waiting for payment/);
    assert.match(last.subject, /Last call/);
    assert.match(last.text, /cancelled and marked abandoned/);
    assert.doesNotMatch(soon.text, /abandoned/);
    for (const m of [soon, next, last]) {
      assert.match(m.text, /https:\/\/squareup.com\/pay\/xyz/);
    }
  });
});

describe("delivery reminder", () => {
  it("names tomorrow, the cooler, the address and the gate", () => {
    const m = deliveryReminder(order());

    assert.equal(m.subject, "Your delivery is tomorrow, Thursday, October 8");
    assert.match(m.text, /leave a cooler with ice out tomorrow morning/);
    assert.match(m.text, /1 Main St, Foster 02825/);
    assert.match(m.text, /Cooler: Side porch\. Gate or keypad: 1234\./);
    assert.match(m.text, /2 × Whole Chicken/);
  });
});

describe("farm-side and sign-in mail", () => {
  it("asks the farm to review an address", () => {
    const m = addressReview({
      name: "Pat Example", email: "pat@example.com",
      address: {
        address1: "5 Far Rd", town: "Nowhere", state: "MA", zip: "01234",
        status: "pending",
      },
    }, { cliHint: "bin/nff address approve pat@example.com" });

    assert.match(m.subject, /Address to review: Pat Example/);
    assert.match(m.text, /5 Far Rd/);
    assert.match(m.text, /Status: pending/);
    assert.match(m.text, /bin\/nff address approve/);
  });

  it("sends a one-time link that says how long it lasts", () => {
    const m = magicLink("pat@example.com", "https://x/api/auth/verify?t=1");

    assert.match(m.text, /expires in 15 minutes/);
    assert.match(m.html, /href="https:\/\/x\/api\/auth\/verify\?t=1"/);
    assert.match(m.text, /sent to pat@example.com/);
  });

  it("summarises an order in one line", () => {
    assert.equal(
      summaryLine(order()),
      "NFF-2610-ABCD submitted $67 Local delivery 2026-10-08 pat@example.com"
    );
  });

  it("carries the farm's contact details in every message", () => {
    for (const m of [completeYourOrder(order()), orderConfirmed(order())]) {
      assert.match(both(m), /sales@northfosterfarm.com/);
      assert.match(both(m), /\(401\) 578-3713/);
    }
  });
});
