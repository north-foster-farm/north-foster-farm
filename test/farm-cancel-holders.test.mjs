// Criteria tests for #662: a farm cancel leaves a switched order open
// in Square. One test per box of the issue's "Done when" list, written
// before the fix from the issue and the security review of #661 alone.
// Held out of `npm test` by its name; turn it on with
//
//   git mv test/farm-cancel-holders.criteria.mjs \
//     test/farm-cancel-holders.test.mjs
//
// Box 2 passes today (the unswitched path); boxes 1, 3, 4, 5, 6 and 7
// fail until the fix.
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
// test/admin.test.mjs.
//
// The record after (box 6). Once the cancel of the order named in
// `oldFulfilmentOrderId` succeeds, the saved record no longer carries
// that field; when that one cancel fails, the field stays. Nothing
// else in the `square` block changes. `flags.squareOutOfSync` is not
// tested: when it clears is not decided here.
//
// A cancel that fails (box 7). A failure on one holder stops none of
// the others: each holder is tried once, in the order above, and each
// failure is logged (a console.error or log line that names the
// holder, as Square's error message does). The farm's cancel then
// does what it does today for its single failed cancel: it throws
// nothing and returns the saved record, `cancelled`. Flags are not
// tested here either.
//
// Boxes 6 and 7 are James's answers of 2026-11-19, through the
// coordinator, to the two questions this file first left open. A
// failed cancel throws the recorded version conflict
// (test/version-conflict.mjs), as lib/square.mjs raises it.
//
// The orders are made by test/switched-orders.mjs: placed and switched
// the way a customer does it, with Square stubbed at lib/square.mjs's
// surface.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cancelOrder } from "../netlify/functions/lib/admin.mjs";
import { getOrder } from "../netlify/functions/lib/records.mjs";
import {
  called, env, mail, neverSwitched, now, staleHolder, switchedOnce,
  switchedTwice,
} from "./switched-orders.mjs";
import { CONFLICT, refusal } from "./version-conflict.mjs";

// Makes the cancel of each Square order in `ids` fail with the recorded
// conflict.
const failOn = (order, ids) => {
  order.fail.cancelFulfillment = (holder) => (ids.includes(holder)
    ? refusal(CONFLICT, `/v2/orders/${holder}`) : null);
};

// The farm's cancel with console.error captured.
// -> { result, thrown, errors }, errors as one string per call.
const capturedCancel = async (t, { stores, id, square }) => {
  const errors = [];
  let result = null;
  let thrown = null;

  t.mock.method(console, "error", (...args) => {
    errors.push(args.map((a) => (typeof a === "string" ? a
      : a instanceof Error ? a.message : JSON.stringify(a))).join(" "));
  });
  try {
    result = await cancelOrder(stores, id, { now, env, mail, square });
  } catch (error) {
    thrown = error;
  } finally {
    t.mock.restoreAll();
  }

  return { result, thrown, errors };
};

// The square block without the field box 6 is about.
const withoutOld = (square) => {
  const copy = { ...square };

  delete copy.oldFulfilmentOrderId;

  return copy;
};

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

  it("box 6: once oldFulfilmentOrderId's cancel succeeds the record " +
    "drops the field, and keeps it when that cancel fails", async (t) => {
    const cancelled = await staleHolder();
    const before = (await getOrder(cancelled.stores, cancelled.id)).square;

    await capturedCancel(t, cancelled);

    const after = (await getOrder(cancelled.stores, cancelled.id)).square;

    assert.equal(after.oldFulfilmentOrderId, undefined,
      "the stale holder, cancelled, is no longer named");
    assert.ok(!Object.hasOwn(after, "oldFulfilmentOrderId"));
    assert.deepEqual(after, withoutOld(before),
      "nothing else in the square block changes");

    const refused = await staleHolder();
    const kept = (await getOrder(refused.stores, refused.id)).square;

    failOn(refused, ["SQC1"]);
    await capturedCancel(t, refused);

    assert.deepEqual(called(refused.calls, "cancelFulfillment"),
      ["SQC2", "SQC1", "SQO"], "the stale holder's cancel was tried");
    assert.deepEqual((await getOrder(refused.stores, refused.id)).square,
      kept, "a stale holder still open stays named");
  });

  it("box 7: a cancel that fails on one holder stops none of the " +
    "others; each failure is logged and the farm's cancel ends as " +
    "today's single failure does", async (t) => {
    // Today's single failure, the result every case below must match.
    const single = await neverSwitched();

    failOn(single, ["SQO"]);

    const one = await capturedCancel(t, single);

    assert.equal(one.thrown, null, "a failed cancel throws nothing");
    assert.equal(one.result.status, "cancelled");
    assert.deepEqual(one.result, await getOrder(single.stores, single.id),
      "it returns the saved record");
    assert.ok(one.errors.some((e) => e.includes("/v2/orders/SQO")),
      "the failure is logged");

    // Two of three holders fail: the first and the last.
    const order = await staleHolder();

    failOn(order, ["SQC2", "SQO"]);

    const many = await capturedCancel(t, order);

    assert.deepEqual(called(order.calls, "cancelFulfillment"),
      ["SQC2", "SQC1", "SQO"], "every holder tried once, in order");
    assert.equal(many.thrown, null, "a partial failure throws nothing");
    assert.equal(many.result.status, "cancelled");
    assert.deepEqual(many.result, await getOrder(order.stores, order.id),
      "it returns the saved record");
    for (const holder of ["SQC2", "SQO"]) {
      assert.ok(many.errors.some((e) => e.includes(`/v2/orders/${holder}`)),
        `the failure on ${holder} is logged`);
    }
  });
});
