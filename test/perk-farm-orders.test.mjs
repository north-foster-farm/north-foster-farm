// The farm's own orders with perks (#514): `bin/nff orders create` for
// a customer, one who has never ordered online included, goes through
// the order path with their perks, gets a packing slip, and a family
// order is paid with nothing charged.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { createFarmOrder } from "../netlify/functions/lib/farm-orders.mjs";
import * as recordedSquare from "../netlify/functions/lib/fake-square.mjs";
import { PACKED } from "../netlify/functions/lib/packing.mjs";
import { addPerk } from "../netlify/functions/lib/perks.mjs";
import { getCustomer, getOrder } from "../netlify/functions/lib/records.mjs";
import { FRIENDS_SQUARE_NAME } from "../netlify/functions/lib/square.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const now = instant("2026-10-06", 9, 0, "America/New_York");
const SKU = "NFF-CHK-WHL-35-39";
const LEE = "lee.neighbor@example.net";
const env = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  PICKUP_SCHEDULE: SCHEDULE,
};
const KEY = "farm-3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";

beforeEach(() => recordedSquare.forgetFake());

const delivery = (qty = 1) => ({
  customer: {
    firstName: "Lee", lastName: "Neighbor", email: LEE,
    phone: "401-555-0142", contact: "call",
  },
  lines: [{ sku: SKU, qty }],
  fulfilment: {
    method: "delivery", date: "2026-10-08",
    delivery: {
      address1: "9 Hill Rd", town: "Foster", zip: "02825", cooler: "Porch",
    },
  },
});

// The fake Square (lib/fake-square.mjs), which answers from Square's
// recordings (order-create-discount-fee-zero, order-pay-zero), with
// its calls counted. `zeroFails` makes PayOrder fail that many times
// first, as a Square outage would, before the fake is asked.
const fakeSquare = ({ zeroFails = 0 } = {}) => {
  const calls = [];
  let failing = zeroFails;
  const square = {
    ...recordedSquare,
    createOrder: (order, key, opts) => {
      calls.push(["order", key, order.totals.total]);

      return recordedSquare.createOrder(order, key, opts);
    },
    payZeroOrder: async (id, key, opts) => {
      calls.push(["zero", id]);
      if (failing > 0) {
        failing -= 1;
        throw new Error("Square 503");
      }

      return recordedSquare.payZeroOrder(id, key, opts);
    },
    createPayment: (args, opts) => {
      calls.push(["payment", args.amount]);

      return recordedSquare.createPayment(args, opts);
    },
  };

  return { square, calls };
};

const mailbox = () => {
  const sent = [];

  return { sent, mail: async (m) => { sent.push(m); return { id: "m" }; } };
};

const quiet = (t) => {
  for (const level of ["log", "info", "warn", "error"]) {
    t.mock.method(console, level, () => {});
  }
};

describe("orders create for a customer with a perk", () => {
  it("serves one who has never ordered online, with the perk and a slip",
    async (t) => {
      quiet(t);

      const stores = testStores();

      await addPerk(stores, LEE, "friends", { by: "james", now });

      const { square } = fakeSquare();
      const { mail } = mailbox();
      // One $30 chicken, $3 off, no fee, under the minimum: $27.
      const r = await createFarmOrder(stores, delivery(1), {
        key: KEY, now, env, mail, square,
      });

      assert.equal(r.ok, true, JSON.stringify(r.errors));
      assert.equal(r.order.status, "unpaid");
      assert.equal(r.order.totals.total, 2700);
      assert.equal(r.order.totals.discountPerk, "friends");
      assert.deepEqual(r.order.totals.perks, ["friends"]);
      assert.equal(r.order.flags.minimumWaived, true);
      assert.ok(PACKED.includes(r.order.status), "it gets a packing slip");

      // Square's copy, in the shape of order-get-line-discount: the
      // chicken's own Friends and Fam discount and the $0 delivery.
      const copy = await square.getOrder(r.order.square.squareOrderId);

      assert.deepEqual(copy.discounts.map((d) => [d.name, d.scope,
        d.amount_money.amount]), [[FRIENDS_SQUARE_NAME, "LINE_ITEM", 300]]);
      assert.equal(copy.line_items[0].applied_discounts[0].discount_uid,
        copy.discounts[0].uid);
      assert.deepEqual(copy.service_charges.map((c) => [c.name,
        c.amount_money.amount]), [["Delivery fee", 0]]);
      assert.equal(copy.total_money.amount, 2700);

      // The record the perk made now has the customer's details.
      const lee = await getCustomer(stores, LEE);

      assert.equal(lee.firstName, "Lee");
      assert.equal(lee.perks.length, 1);
    });

  it("applies none once the perk has ended", async (t) => {
    quiet(t);

    const stores = testStores();

    await addPerk(stores, LEE, "minimum-waived", {
      start: "2026-09-01", end: "2026-10-05", now,
    });

    const r = await createFarmOrder(stores, delivery(1), {
      key: KEY, now, env, mail: mailbox().mail, square: fakeSquare().square,
    });

    assert.equal(r.ok, false);
    assert.ok(r.errors["delivery.minimum"]);
  });
});

describe("orders create for family", () => {
  it("records the order paid, charges nothing and sends the " +
    "confirmation", async (t) => {
    quiet(t);

    const stores = testStores();

    await addPerk(stores, LEE, "family", { by: "james", owner: true, now });

    const { square, calls } = fakeSquare();
    const { sent, mail } = mailbox();
    const r = await createFarmOrder(stores, delivery(2), {
      key: KEY, now, env, mail, square,
    });

    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.order.status, "paid");
    assert.equal(r.order.totals.total, 0);
    assert.equal(r.order.totals.discountAmount, 6000);
    assert.deepEqual(r.order.payments, []);
    assert.deepEqual(calls.map((c) => c[0]), ["order", "zero"]);

    // Square's copy, in the shape of order-get-discount-fee-zero: one
    // whole-order discount and the $0 delivery, closed, nothing due.
    const copy = await square.getOrder(r.order.square.squareOrderId);

    assert.equal(copy.state, "COMPLETED");
    assert.deepEqual(copy.discounts.map((d) => [d.scope, d.amount_money
      .amount, d.applied_money.amount]), [["ORDER", 6000, 6000]]);
    assert.deepEqual(copy.service_charges.map((c) => [c.name,
      c.amount_money.amount, c.calculation_phase]),
    [["Delivery fee", 0, "SUBTOTAL_PHASE"]]);
    assert.equal(copy.total_money.amount, 0);
    assert.ok(PACKED.includes(r.order.status));
    assert.ok(sent.some((m) => [].concat(m.to).includes(LEE)),
      "the customer has the confirmation");

    const stored = await getOrder(stores, r.order.id);

    const paid = stored.history.find((h) => h.event === "paid");

    assert.equal(paid.source, "family");
  });

  it("refuses money for an order with nothing due, making nothing",
    async (t) => {
      quiet(t);

      const stores = testStores();

      await addPerk(stores, LEE, "family", { owner: true, now });

      const { square, calls } = fakeSquare();
      const r = await createFarmOrder(stores, delivery(2), {
        key: KEY, now, env, mail: mailbox().mail, square,
        paid: { tender: "cash" },
      });

      assert.equal(r.ok, false);
      assert.match(r.errors.paid, /Nothing is due/);
      assert.deepEqual(calls, []);
    });

  it("finishes on the same key when Square would not close its copy",
    async (t) => {
      quiet(t);

      const stores = testStores();

      await addPerk(stores, LEE, "family", { owner: true, now });

      const { square, calls } = fakeSquare({ zeroFails: 1 });
      const opts = { key: KEY, now, env, mail: mailbox().mail, square };
      const first = await createFarmOrder(stores, delivery(2), opts);

      assert.equal(first.ok, false);
      assert.match(first.errors.order, /would not close its copy/);
      assert.equal((await getOrder(stores, first.order.id)).status,
        "unpaid");

      const again = await createFarmOrder(stores, delivery(2), opts);

      assert.equal(again.ok, true);
      assert.equal(again.found, true);
      assert.equal(again.order.status, "paid");
      assert.equal(calls.filter((c) => c[0] === "order").length, 1,
        "one Square order");
    });
});
