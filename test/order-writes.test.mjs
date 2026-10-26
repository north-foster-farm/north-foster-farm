// Two writers on one order record must both land. The record is one
// blob, read and written whole, so a note about an email (a send takes
// seconds, and the Square webhooks speak of the order at the same
// time) written over a cancel would put the order back to "paid" and
// leave the farm refunding or closing it twice.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  amendOrder, getOrder, saveOrder, setStatus,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const ID = "NFF-2610-RACE01";
const at = new Date("2026-10-26T12:00:00Z");

const seeded = async () => {
  const stores = testStores();

  await saveOrder(stores, {
    id: ID, status: "paid", submittedAt: at.toISOString(),
    customer: { email: "pat@example.com" },
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
