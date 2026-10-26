// Two writers on one order record must both land. The record is one
// blob, read and written whole, so a note about an email (a send takes
// seconds, and the Square webhooks speak of the order at the same
// time) written over a cancel would put the order back to "paid" and
// leave the farm refunding or closing it twice.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fulfillOrder } from "../netlify/functions/lib/admin.mjs";
import { recordRefund } from "../netlify/functions/lib/payments.mjs";
import {
  amendOrder, getOrder, refundsOf, saveOrder, setStatus, updateOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const ID = "NFF-2610-RACE01";
const at = new Date("2026-10-26T12:00:00Z");

const seeded = async () => {
  const stores = testStores();

  await saveOrder(stores, {
    id: ID, status: "paid", submittedAt: at.toISOString(),
    customer: { email: "pat@example.com" },
    totals: { total: 2000 },
    payments: [{ squarePaymentId: "PAY-1", amount: 2000 }], refunds: [],
  }, at);

  return stores;
};

describe("concurrent writes to one order", () => {
  it("keeps a cancel and an email note written at the same time",
    async () => {
      const stores = await seeded();

      await Promise.all([
        setStatus(stores, ID, "cancelled", at),
        amendOrder(stores, ID, {
          emails: { orderConfirmed: { at: at.toISOString() } },
        }, "mail.orderConfirmed", at),
      ]);

      const order = await getOrder(stores, ID);

      assert.equal(order.status, "cancelled");
      assert.ok(order.emails.orderConfirmed, "the note is kept");
      assert.equal(await stores.orders.get(`open/${ID}`), null,
        "a cancelled order is not open");
    });

  it("keeps two notes written at the same time", async () => {
    const stores = await seeded();

    await Promise.all([
      amendOrder(stores, ID, { a: 1 }, "a", at),
      amendOrder(stores, ID, { b: 2 }, "b", at),
      amendOrder(stores, ID, { c: 3 }, "c", at),
    ]);

    const order = await getOrder(stores, ID);

    assert.deepEqual([order.a, order.b, order.c], [1, 2, 3]);
    assert.equal(order.history.filter((h) => ["a", "b", "c"]
      .includes(h.event)).length, 3);
  });

  it("never moves a cancelled or fulfilled order back to paid",
    async () => {
      for (const status of ["cancelled", "fulfilled"]) {
        const stores = await seeded();

        await setStatus(stores, ID, status, at);

        const again = await setStatus(stores, ID, "paid", at);

        assert.equal(again.status, status);
        assert.equal((await getOrder(stores, ID)).status, status);
      }
    });
});

describe("the order of a cancel and a close", () => {
  it("leaves a cancelled order cancelled when the jobs close it",
    async () => {
      const stores = await seeded();

      await setStatus(stores, ID, "cancelled", at);

      const closed = await setStatus(stores, ID, "fulfilled", at,
        { source: "jobs" });

      assert.equal(closed.status, "cancelled");
      await assert.rejects(fulfillOrder(stores, ID, {
        now: at, env: {}, mail: async () => ({}),
        square: { completeOrder: async () => assert.fail("not completed") },
      }), /This order is cancelled/);
    });

  it("leaves a fulfilled order fulfilled when a cancel arrives late",
    async () => {
      const stores = await seeded();

      await setStatus(stores, ID, "fulfilled", at);

      assert.equal((await setStatus(stores, ID, "cancelled", at)).status,
        "fulfilled");
    });

  it("settles a cancel and a close made together on one of them",
    async () => {
      const stores = await seeded();

      await Promise.all([
        setStatus(stores, ID, "cancelled", at),
        setStatus(stores, ID, "fulfilled", at, { source: "jobs" }),
      ]);

      const order = await getOrder(stores, ID);

      assert.ok(["cancelled", "fulfilled"].includes(order.status));
      assert.equal(order.history.filter((h) => ["cancelled", "fulfilled"]
        .includes(h.event)).length, 1, "only one of the two landed");
    });
});

describe("refunds recorded together", () => {
  const refund = (n, amount) => ({
    amount, payment: "PAY-1", squareRefundId: `R${n}`, status: "PENDING",
  });

  it("keeps both of two refunds written at the same time", async () => {
    const stores = await seeded();
    const order = await getOrder(stores, ID);

    await Promise.all([
      recordRefund(stores, order, refund(1, 1000), "farm", at),
      recordRefund(stores, order, refund(2, 500), "square", at),
    ]);

    assert.deepEqual(refundsOf(await getOrder(stores, ID))
      .map((r) => r.squareRefundId).sort(), ["R1", "R2"]);
  });

  it("records one refund once, however often it is reported",
    async () => {
      const stores = await seeded();
      const order = await getOrder(stores, ID);

      await Promise.all([
        recordRefund(stores, order, refund(1, 1000), "farm", at),
        recordRefund(stores, order, refund(1, 1000), "square", at),
      ]);

      assert.equal(refundsOf(await getOrder(stores, ID)).length, 1);
    });

  it("alerts the farm, then fails, when a taken refund cannot be recorded",
    async () => {
      const stores = await seeded();
      const order = await getOrder(stores, ID);
      const sent = [];

      stores.orders.swap = async () => { throw new Error("store down"); };

      await assert.rejects(recordRefund(stores, order, refund(1, 1000),
        "farm", at, {
          env: { DEV_NOTIFICATIONS_EMAIL: "dev@example.com" },
          mail: async (m) => { sent.push(m); return { id: "m1" }; },
        }), /store down/);
      assert.equal(sent.length, 1);
      assert.match(sent[0].subject + sent[0].text, /refund\.unrecorded|R1/);
    });
});

describe("the writer's retries and the open list", () => {
  it("gives up with an error, not silently, after eight misses",
    async () => {
      const stores = await seeded();

      stores.orders.swap = async () => false;

      await assert.rejects(updateOrder(stores, ID, (o) => ({
        ...o, note: "x",
      })), /changed too fast/);
    });

  it("changes nothing when a function patch answers null", async () => {
    const stores = await seeded();
    const before = await getOrder(stores, ID);
    const after = await amendOrder(stores, ID, () => null, "nothing", at);

    assert.deepEqual(after, before);
    assert.equal((await getOrder(stores, ID)).history.length,
      before.history.length);
  });

  it("keeps a cancelled order off the open list when a slower write ends",
    async () => {
      const stores = await seeded();
      const swap = stores.orders.swap.bind(stores.orders);
      let first = true;

      // The note's write lands, then a cancel completes before the
      // note's index is written.
      stores.orders.swap = async (...args) => {
        const ok = await swap(...args);

        if (ok && first) {
          first = false;
          await setStatus(stores, ID, "cancelled", at);
        }

        return ok;
      };
      await amendOrder(stores, ID, { note: "x" }, "note", at);

      assert.equal((await getOrder(stores, ID)).status, "cancelled");
      assert.equal(await stores.orders.get(`open/${ID}`), null);
    });
});
