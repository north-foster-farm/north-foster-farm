// A customer's Venmo change that the page never finished is not made
// once the order has locked (#292): the jobs' rescue drops it before
// capture, so the packing slip already printed stays true. All fake.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rescueCheckout } from "../netlify/functions/lib/checkout.mjs";
import { editOpen } from "../netlify/functions/lib/jobs.mjs";
import {
  getCheckout, saveCheckout, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const at = (iso, h) => instant(iso, h, 0, "America/New_York");
const placed = at("2026-10-05", 9);
const TUESDAY = "2026-10-06";

// Paid Monday for delivery Thursday the 8th.
const order = (id) => ({
  id, status: "paid",
  submittedAt: placed.toISOString(), paidAt: placed.toISOString(),
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [{ sku: "EGG-L", label: "Eggs, Large", qty: 2, lineTotal: 14 }],
  totals: { subtotal: 1400, discountAmount: 0, deliveryFee: 500,
    total: 1900 },
  fulfilment: {
    method: "delivery", date: "2026-10-08", onfarm: null,
    delivery: { address1: "1 Example Rd", town: "Foster", zip: "02825" },
  },
  payments: [{ amount: 1900, via: "venmo", at: placed.toISOString() }],
});

describe("the Venmo change rescue after the lock", () => {
  const checkout = {
    key: "k-1", at: placed.toISOString(), paypalOrderId: "PPO-1", attempt: 1,
    edit: { id: "A", held: "h", next: {}, change: {} },
    order: { id: "A" },
  };
  const paypal = (status) => ({
    getOrder: async () => ({ status, updatedAt: placed.toISOString() }),
  });

  it("drops an uncaptured change once the order has locked", async () => {
    const stores = testStores();
    let finished = 0;

    await saveOrder(stores, order("A"), placed);
    await saveCheckout(stores, checkout);

    const out = await rescueCheckout(stores, checkout, {
      paypal: paypal("APPROVED"), env: {}, now: at("2026-10-08", 7),
      finishEdit: async () => { finished += 1; }, editOpen,
    });

    assert.equal(out, null);
    assert.equal(finished, 0, "nothing captured, no money moved");
    assert.equal(await getCheckout(stores, "k-1", "PPO-1"), null);
  });

  it("still finishes one before the lock, or one PayPal completed",
    async () => {
      const stores = testStores();
      const seen = [];
      const finishEdit = async (s, args) => {
        seen.push(args.paypalOrderId);

        return { id: "A", fulfilment: {} };
      };

      await saveOrder(stores, order("A"), placed);
      await rescueCheckout(stores, checkout, {
        paypal: paypal("APPROVED"), env: {}, now: at(TUESDAY, 7),
        finishEdit, editOpen,
      });
      await rescueCheckout(stores, checkout, {
        paypal: paypal("COMPLETED"), env: {}, now: at("2026-10-08", 7),
        finishEdit, editOpen,
      });

      assert.deepEqual(seen, ["PPO-1", "PPO-1"]);
    });
});
