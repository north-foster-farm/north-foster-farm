// The log lines of a cancel's Square holders (#662), the implementer's
// own test beside the criteria tests in farm-cancel-holders.test.mjs.
// Each cancel of a holder, each failure and the record's dropped
// `oldFulfilmentOrderId` is one line naming the order, the Square
// order, and who acted; none carries the customer's details.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cancelOrder } from "../netlify/functions/lib/admin.mjs";
import {
  amendOrder, getOrder,
} from "../netlify/functions/lib/records.mjs";
import {
  EMAIL, env, mail, now, staleHolder,
} from "./switched-orders.mjs";
import { CONFLICT, refusal } from "./version-conflict.mjs";

// The farm's cancel with the log's console lines captured, parsed.
const logged = async (t, { stores, id, square }) => {
  const lines = [];
  const keep = (...args) => {
    for (const a of args) {
      try {
        lines.push(JSON.parse(a));
      } catch {
        // Not a log line.
      }
    }
  };

  t.mock.method(console, "info", keep);
  t.mock.method(console, "error", keep);
  try {
    await cancelOrder(stores, id, { now, env, mail, square });
  } finally {
    t.mock.restoreAll();
  }

  return lines;
};

const of = (lines, event) => lines.filter((l) => l.event === event);

describe("#662: a cancel's Square holders are logged", () => {
  it("logs each holder cancelled and the stale holder cleared",
    async (t) => {
      const order = await staleHolder();
      const lines = await logged(t, order);

      assert.deepEqual(of(lines, "square.fulfilment_cancelled")
        .map((l) => [l.id, l.holder, l.by]), [
        [order.id, "SQC2", "farm"], [order.id, "SQC1", "farm"],
        [order.id, "SQO", "farm"],
      ]);

      const [cleared, ...more] = of(lines, "square.stale_cleared");

      assert.deepEqual(more, []);
      assert.equal(cleared.id, order.id);
      assert.equal(cleared.by, "farm");
      assert.equal(cleared.field, "square.oldFulfilmentOrderId");
      assert.equal(cleared.before, "SQC1");
      assert.equal(cleared.after, null);
    });

  it("logs a failed holder with Square's code and clears nothing",
    async (t) => {
      const order = await staleHolder();

      order.fail.cancelFulfillment = (holder) => (holder === "SQC1"
        ? refusal(CONFLICT, `/v2/orders/${holder}`) : null);

      const lines = await logged(t, order);
      const [failed, ...more] = of(lines, "square.fulfilment_cancel_failed");

      assert.deepEqual(more, []);
      assert.equal(failed.level, "error");
      assert.equal(failed.id, order.id);
      assert.equal(failed.holder, "SQC1");
      assert.equal(failed.by, "farm");
      assert.ok(failed.code);
      assert.deepEqual(of(lines, "square.stale_cleared"), []);
      assert.deepEqual(of(lines, "square.fulfilment_cancelled")
        .map((l) => l.holder), ["SQC2", "SQO"]);
    });

  it("logs no clearing when the record no longer names the stale holder",
    async (t) => {
      const order = await staleHolder();
      const { cancelFulfillment } = order.square;

      // Something else drops the field while SQC1's cancel is under
      // way, so the cancel's own drop finds nothing to change.
      order.square.cancelFulfillment = async (holder, opts) => {
        const done = await cancelFulfillment(holder, opts);

        if (holder === "SQC1") {
          await amendOrder(order.stores, order.id, (f) => {
            const rest = { ...f.square };

            delete rest.oldFulfilmentOrderId;

            return { square: rest };
          }, "test.cleared", now);
        }

        return done;
      };

      const lines = await logged(t, order);
      const saved = await getOrder(order.stores, order.id);

      assert.deepEqual(of(lines, "square.fulfilment_cancelled")
        .map((l) => l.holder), ["SQC2", "SQC1", "SQO"]);
      assert.deepEqual(of(lines, "square.stale_cleared"), []);
      assert.deepEqual(saved.history
        .filter((h) => h.event === "square.stale_cancelled"), []);
    });

  it("names no customer in any line", async (t) => {
    const order = await staleHolder();

    order.fail.cancelFulfillment = (holder) => (holder === "SQO"
      ? refusal(CONFLICT, `/v2/orders/${holder}`) : null);

    const lines = (await logged(t, order)).filter((l) => [
      "square.fulfilment_cancelled", "square.fulfilment_cancel_failed",
      "square.stale_cleared",
    ].includes(l.event));

    assert.equal(lines.length, 4);
    for (const line of lines) {
      const text = JSON.stringify(line);

      assert.ok(!text.includes(EMAIL), text);
      assert.ok(!text.includes("Pat"), text);
    }
  });
});
