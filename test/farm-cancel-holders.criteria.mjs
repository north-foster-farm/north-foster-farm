// Criteria tests for #662: a farm cancel leaves a switched order open
// in Square. One test per box of the issue's "Done when" list, written
// before the fix from the issue and the security review of #661 alone.
// Held out of `npm test` by its name; turn it on with
//
//   git mv test/farm-cancel-holders.criteria.mjs \
//     test/farm-cancel-holders.test.mjs
//
// Box 2 passes today (the unswitched path); boxes 1, 3, 4 and 5 fail
// until the fix.
//
// THE CONTRACT
//
// The holders are the Square orders the record names under `square`:
// `fulfilmentOrderId` (the carrier, which holds the fulfillment now),
// `oldFulfilmentOrderId` (a holder whose cancel failed during a switch,
// #658, still open in Square) and `squareOrderId` (the order the
// customer paid on), each that is set, deduplicated. The farm's cancel
// (`cancelOrder` in lib/admin.mjs, which the customer's cancel from
// Account and the jobs' cancel share) calls
//
//   cancelFulfillment(holder, { env, fetchImpl })
//
// once for each holder, in this order: fulfilmentOrderId, then
// oldFulfilmentOrderId, then squareOrderId, so the fulfillment the farm
// packs from is closed first. It calls it for no order the record does
// not name:
//
//   never switched              SQO
//   switched once               SQC1, SQO
//   switched twice              SQC2, SQO (SQO's fulfillment is already
//                               cancelled, which lib/square.mjs's
//                               cancelFulfillment treats as done; the
//                               first carrier SQC1, no longer named,
//                               is not asked for)
//   oldFulfilmentOrderId named  SQC2, SQC1, SQO: the stale holder's
//   (#658, a failed cancel)     fulfillment is cancelled with the rest
//
// It makes no other fulfillment call (no update, no completion). The
// refund, stock, status and email are as before and tested in
// test/admin.test.mjs. After the cancel the record is `cancelled` and
// keeps `squareOrderId` and `fulfilmentOrderId` as they were. Not
// stated by the issue, so not tested: whether `oldFulfilmentOrderId`
// is dropped once its cancel succeeds, and whether a cancel that fails
// on one holder still tries the others (both asked of the coordinator,
// 2026-11-19).
//
// The orders are made by test/switched-orders.mjs: placed and switched
// the way a customer does it, with Square stubbed at lib/square.mjs's
// surface.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cancelOrder } from "../netlify/functions/lib/admin.mjs";
import {
  called, env, mail, neverSwitched, now, staleHolder, switchedOnce,
  switchedTwice,
} from "./switched-orders.mjs";

// The farm's cancel, refund and all, as `bin/nff orders cancel` makes
// it. -> the Square order ids cancelFulfillment was called with.
const farmCancel = async ({ stores, id, square, calls }) => {
  const order = await cancelOrder(stores, id, { now, env, mail, square });

  assert.equal(order.status, "cancelled");

  return called(calls, "cancelFulfillment");
};

// The same ids, in a fixed order, for the boxes about which orders are
// cancelled; box 5 is about the order they are cancelled in.
const sorted = (ids) => [...ids].sort();

// No fulfillment call but the cancels.
const noOther = (calls) => {
  assert.deepEqual(called(calls, "updateFulfillment"), []);
  assert.deepEqual(called(calls, "completeOrder"), []);
};

describe("#662: a farm cancel cancels the fulfillment on every holder " +
  "the record names", () => {
  it("box 1: on a switched order, the farm's cancel cancels each holder " +
    "the record names, once", async () => {
    const order = await switchedOnce();
    const cancelled = await farmCancel(order);

    assert.deepEqual(sorted(cancelled), ["SQC1", "SQO"]);
    noOther(order.calls);
  });

  it("box 2: on an order never switched, one cancel, on squareOrderId",
    async () => {
      const order = await neverSwitched();
      const cancelled = await farmCancel(order);

      assert.deepEqual(cancelled, ["SQO"]);
      noOther(order.calls);
    });

  it("box 3: on an order switched twice, the second carrier and " +
    "squareOrderId are cancelled once each, and the first carrier is " +
    "not asked for", async () => {
    const order = await switchedTwice();
    const cancelled = await farmCancel(order);

    assert.deepEqual(sorted(cancelled), ["SQC2", "SQO"]);
    noOther(order.calls);
  });

  it("box 4: on an order whose record names oldFulfilmentOrderId, the " +
    "stale holder is cancelled too, with the carrier and squareOrderId",
  async () => {
    const order = await staleHolder();
    const cancelled = await farmCancel(order);

    assert.deepEqual(sorted(cancelled), ["SQC1", "SQC2", "SQO"]);
    noOther(order.calls);
  });

  it("box 5: the cancels go fulfilmentOrderId, then " +
    "oldFulfilmentOrderId, then squareOrderId", async () => {
    const order = await staleHolder();

    assert.deepEqual(await farmCancel(order), ["SQC2", "SQC1", "SQO"]);

    const once = await switchedOnce();

    assert.deepEqual(await farmCancel(once), ["SQC1", "SQO"]);
  });
});
