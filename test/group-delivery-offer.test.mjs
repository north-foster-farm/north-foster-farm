// The cart readers carry a member's tick for a delivery to the group's
// place (#471, #521). Moved here unchanged from cart-sync.test.mjs:
// these describe the offer that #626 takes off the order page, and
// group-delivery-removal.criteria.mjs supersedes them. The change that
// meets #626 deletes this file as it renames that one to .test.mjs;
// `parked/group-delivery` keeps them.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  carryOf, cartOf,
} from "../assets/scripts/order/lib/cart-sync.mjs";

const payload = () => ({
  formVersion: "3",
  customer: { firstName: "Pat", lastName: "Example",
    email: "pat@example.com", phone: "", contact: "text", marketing: false },
  lines: [{ sku: "A", qty: 2 }],
  fulfilment: { method: "onfarm", date: "2026-10-07",
    onfarm: { window: "morning" }, delivery: {} },
  code: "HELLO",
  claimedTotal: 1400,
  idempotencyKey: "k",
  attempt: 2,
  website: "",
});

describe("a group's delivery in the cart (#521, superseded by #626)", () => {
  it("the account's cart carries the tick, and junk as no tick", () => {
    const cart = cartOf({
      ...payload(),
      fulfilment: { method: "scheduled", occurrence: "36TS-261010",
        delivery: { toGroup: true } },
    });

    assert.equal(cart.fulfilment.delivery.toGroup, true);

    const none = cartOf({
      ...payload(),
      fulfilment: { occurrence: 7, delivery: { toGroup: "yes" } },
    });

    assert.equal(none.fulfilment.delivery.toGroup, false);
  });

  it("a sign-in link carries the tick and no address", () => {
    const scheduled = carryOf({ savedAt: 1, payload: {
      lines: [{ sku: "A", qty: 1 }],
      fulfilment: { method: "scheduled", occurrence: "36TS-261010",
        delivery: { toGroup: true, address1: "1 Main St" } },
    } });

    assert.deepEqual(scheduled.payload.fulfilment, {
      method: "scheduled", occurrence: "36TS-261010",
      delivery: { toGroup: true },
    });
  });
});
