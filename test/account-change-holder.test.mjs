// Criteria tests for #660: a quick change after a switch between
// delivery and pickup updates the old Square order. One test per box
// of the issue's "Done when" list, written before the fix from the
// issue and the security review of #661 alone. Held out of `npm test`
// by its name; turn it on with
//
//   git mv test/account-change-holder.criteria.mjs \
//     test/account-change-holder.test.mjs
//
// Boxes 2 and 5 pass today (the unswitched path, and a record the
// quick change leaves alone); boxes 1, 3 and 4 fail until the fix.
//
// THE CONTRACT
//
// The holder is the Square order that carries an order's fulfillment
// now: `square.fulfilmentOrderId`, or `square.squareOrderId` when the
// order was never switched (as amend.mjs `holderOf` and edit.mjs
// `syncFulfillment` name it). A quick change (`applyChange` in
// lib/account.mjs, reached from Account's `changeOrder`, from the
// farm's note through lib/edit.mjs and from a round in lib/rounds.mjs)
// makes exactly one Square call:
//
//   updateFulfillment(holder, <the changed record>, { env })
//
// and none to any other order:
//
//   never switched              squareOrderId (SQO)
//   switched once               fulfilmentOrderId (SQC1), not SQO
//   switched twice              fulfilmentOrderId (SQC2), not SQO or
//                               the first carrier SQC1
//   oldFulfilmentOrderId named  fulfilmentOrderId (SQC2), not the
//   (#658, a failed cancel)     stale holder SQC1, which the farm is
//                               told to cancel, nor SQO
//
// It cancels nothing and makes no change order. The record's `square`
// block after the change is the one before it: a quick change moves no
// holder, and `oldFulfilmentOrderId` stays for the farm. What a Square
// refusal does (flag `squareOutOfSync`, tell the farm) is unchanged
// and tested in test/account.test.mjs.
//
// The orders are made by test/switched-orders.mjs: placed and switched
// the way a customer does it, with Square stubbed at lib/square.mjs's
// surface. The quick change here is Account's (`changeOrder`), the way
// the issue says a person reaches it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { changeOrder } from "../netlify/functions/lib/account.mjs";
import { getOrder } from "../netlify/functions/lib/records.mjs";
import { AFTERNOON } from "./schedule-fixture.mjs";
import {
  called, customer, env, mail, neverSwitched, now, staleHolder,
  switchedOnce, switchedTwice,
} from "./switched-orders.mjs";

// The pickup's window moved from morning to afternoon, the issue's
// example. -> the changed record.
const movePickup = async ({ stores, id, square }) => {
  const r = await changeOrder(stores, customer, id, {
    onfarm: { window: AFTERNOON },
  }, { now, env, mail, square });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order.fulfilment.onfarm.window, AFTERNOON);

  return getOrder(stores, id);
};

// The delivery's cooler moved: a quick change of a delivery.
const moveCooler = async ({ stores, id, square }) => {
  const r = await changeOrder(stores, customer, id, {
    delivery: { cooler: "Back steps" },
  }, { now, env, mail, square });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order.fulfilment.delivery.cooler, "Back steps");

  return getOrder(stores, id);
};

// Every Square call but the update: there must be none.
const others = (calls) => calls.filter((c) => c[0] !== "updateFulfillment");

describe("#660: a quick change updates the Square order that holds " +
  "the fulfillment", () => {
  it("box 1: on a switched order, applyChange updates the carrier " +
    "(fulfilmentOrderId), not squareOrderId", async () => {
    const order = await switchedOnce();

    await moveCooler(order);

    assert.deepEqual(called(order.calls, "updateFulfillment"), ["SQC1"]);
    assert.deepEqual(others(order.calls), []);
  });

  it("box 2: on an order never switched, the update goes to " +
    "squareOrderId, once", async () => {
    const order = await neverSwitched();

    await movePickup(order);

    assert.deepEqual(called(order.calls, "updateFulfillment"), ["SQO"]);
    assert.deepEqual(others(order.calls), []);
  });

  it("box 3: on an order switched twice, the update goes to the second " +
    "carrier, once, and to neither squareOrderId nor the first " +
    "carrier", async () => {
    const order = await switchedTwice();

    await movePickup(order);

    assert.deepEqual(called(order.calls, "updateFulfillment"), ["SQC2"]);
    assert.deepEqual(others(order.calls), []);
  });

  it("box 4: on an order whose record names oldFulfilmentOrderId, the " +
    "update goes to fulfilmentOrderId only", async () => {
    const order = await staleHolder();

    await movePickup(order);

    assert.deepEqual(called(order.calls, "updateFulfillment"), ["SQC2"]);
    assert.deepEqual(others(order.calls), []);
  });

  it("box 5: a quick change leaves the record's square block as it " +
    "was", async () => {
    const cases = [
      ["never switched", neverSwitched, movePickup],
      ["switched once", switchedOnce, moveCooler],
      ["switched twice", switchedTwice, movePickup],
      ["oldFulfilmentOrderId named", staleHolder, movePickup],
    ];

    for (const [name, make, change] of cases) {
      const order = await make();
      const before = (await getOrder(order.stores, order.id)).square;
      const after = (await change(order)).square;

      assert.deepEqual(after, before, name);
    }
  });
});
