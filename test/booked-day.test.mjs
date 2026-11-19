// The delivery day an order's change keeps as booked (#643), bookedDay.
// An order with the farm's question open (a missed delivery) keeps none,
// so its past Thursday is never offered back (e2e/missed-delivery.spec).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bookedDay } from "../assets/scripts/order/lib/dates.mjs";

const delivery = { method: "delivery", date: "2026-12-10" };

describe("bookedDay", () => {
  it("keeps a delivery order's own day", () => {
    assert.equal(bookedDay({ fulfilment: delivery }), "2026-12-10");
  });

  it("keeps none for a pickup", () => {
    assert.equal(bookedDay({
      fulfilment: { method: "onfarm", date: "2026-12-12" },
    }), null);
  });

  it("keeps none while the farm's question is open", () => {
    assert.equal(bookedDay({
      fulfilment: delivery,
      question: { kind: "missed", answeredAt: null },
    }), null);
  });

  it("keeps the day once the question is answered", () => {
    assert.equal(bookedDay({
      fulfilment: delivery,
      question: { kind: "missed", answeredAt: "2026-12-01T12:00:00Z" },
    }), "2026-12-10");
  });

  it("keeps none for an order with no fulfilment", () => {
    assert.equal(bookedDay({}), null);
    assert.equal(bookedDay(null), null);
  });
});
