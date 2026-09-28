import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fileName, ordersCsv, receiptsCsv,
} from "../assets/scripts/account/lib/history.mjs";

// Every file starts with a byte-order mark, for Excel.
const rows = (text) => {
  assert.equal(text[0], "\uFEFF");

  return text.slice(1).trimEnd().split("\r\n");
};

// The viewer's zone, pinned: New York's, like most of the farm's.
const NY = { timeZone: "America/New_York" };

const card = {
  at: "2026-09-20T15:00:00.000Z", amount: 4700, via: "square",
  method: "card", brand: "VISA", last4: "4242",
  receiptUrl: "https://squareup.com/receipt/preview/abc",
};

const venmo = {
  at: "2026-09-22T12:00:00.000Z", amount: 1000, via: "venmo",
  method: "venmo", paypalCaptureId: "CAP123", payer: "Pat Doe",
};

const order = (over = {}) => ({
  id: "NFF-A1",
  status: "paid",
  submittedAt: "2026-09-20T14:59:00.000Z",
  cancelRequested: false,
  lines: [
    { sku: "EGG", label: "Eggs, dozen", qty: 2, unitPrice: 8, lineTotal: 16 },
    { sku: "CHK", label: "Whole chicken", qty: 1, unitPrice: 26,
      lineTotal: 26 },
  ],
  totals: { subtotal: 4200, discountAmount: 0, deliveryFee: 500,
    total: 4700 },
  fulfilment: { method: "delivery", date: "2026-09-24" },
  payments: [card],
  refunds: [],
  ...over,
});

describe("ordersCsv", () => {
  it("writes a header and one row per order", () => {
    const [head, row] = rows(ordersCsv([order()], NY));

    assert.equal(head, "Order,Placed,Status,How,For,Items,Subtotal," +
      "Discount,Delivery fee,Total,Paid,Refunded");
    assert.equal(row, "NFF-A1,2026-09-20,Paid,Delivery,2026-09-24," +
      "\"2 x Eggs, dozen; 1 x Whole chicken\"," +
      "42.00,0.00,5.00,47.00,47.00,0.00");
  });

  it("dates an evening order by the viewer's day, not the UTC one", () => {
    // 9:30 PM in New York on the 20th is 01:30 UTC on the 21st.
    const late = order({ submittedAt: "2026-09-21T01:30:00.000Z" });

    assert.match(rows(ordersCsv([late], NY))[1], /^NFF-A1,2026-09-20,/);
    assert.match(rows(ordersCsv([late], { timeZone: "UTC" }))[1],
      /^NFF-A1,2026-09-21,/);
  });

  it("says Picked up for a finished pickup and totals the refunds", () => {
    const [, row] = rows(ordersCsv([order({
      status: "fulfilled",
      fulfilment: { method: "onfarm", date: "2026-09-24" },
      refunds: [{ at: "2026-09-25T00:00:00Z", amount: 800, payment: 0 }],
    })], NY));

    assert.match(row, /,Picked up,On-farm pickup,/);
    assert.match(row, /,8\.00$/);
  });

  it("is only a header with no orders", () => {
    assert.equal(rows(ordersCsv([], NY)).length, 1);
  });
});

describe("receiptsCsv", () => {
  it("lists payments and refunds oldest first", () => {
    const text = receiptsCsv([
      order({
        id: "NFF-B2",
        payments: [venmo],
        refunds: [{ at: "2026-09-23T00:00:00Z", amount: 300, payment: 0 }],
      }),
      order(),
    ], NY);

    // The refund at midnight UTC was the evening before in New York.
    assert.deepEqual(rows(text), [
      "Date,Order,Kind,Amount,Paid with,From,Receipt",
      "2026-09-20,NFF-A1,Payment,47.00,Visa ending 4242,," +
        "https://squareup.com/receipt/preview/abc",
      "2026-09-22,NFF-B2,Payment,10.00,Venmo,Pat Doe,PayPal CAP123",
      "2026-09-22,NFF-B2,Refund,-3.00,Venmo,,PayPal CAP123",
    ]);
  });

  it("names the payment a refund came out of", () => {
    const text = receiptsCsv([order({
      payments: [card, venmo],
      refunds: [{ at: "2026-09-26T16:00:00Z", amount: 1000, payment: 1 }],
    })], NY);

    assert.match(rows(text)[3], /^2026-09-26,NFF-A1,Refund,-10\.00,Venmo,/);
  });
});

describe("cells", () => {
  it("quote commas and quotes, and keep a formula as text", () => {
    const [, row] = rows(ordersCsv([order({
      lines: [{ sku: "X", label: "=HYPERLINK(\"x\"), big", qty: 1 }],
    })]));

    assert.match(row, /,"1 x =HYPERLINK\(""x""\), big",/);

    const [, evil] = rows(ordersCsv([order({ id: "=1+1" })]));

    assert.match(evil, /^'=1\+1,/);

    const [, spaced] = rows(ordersCsv([order({ id: "  =1+1" })]));

    assert.ok(spaced.startsWith("'  =1+1,"), "a formula behind spaces");
  });
});

describe("fileName", () => {
  it("dates the file", () => {
    assert.equal(fileName("orders", new Date("2026-09-28T12:00:00Z"), NY),
      "north-foster-farm-orders-2026-09-28.csv");
    assert.equal(fileName("receipts", new Date("2026-09-29T01:00:00Z"), NY),
      "north-foster-farm-receipts-2026-09-28.csv", "an evening download");
  });
});
