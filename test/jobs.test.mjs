import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  abandonAt, deliveryReminderAt, finalReminderAt, reminderDue, runJobs,
} from "../netlify/functions/lib/jobs.mjs";
import { markPaid } from "../netlify/functions/lib/payments.mjs";
import {
  getOrder, openOrders, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const TZ = "America/New_York";
const at = (iso, h, m = 0) => instant(iso, h, m, TZ);

// Placed Monday 5 October 2026 at 09:00 ET for delivery Thursday the
// 8th, or on-farm pickup Wednesday the 7th.
const placed = at("2026-10-05", 9);

const order = (id, method = "delivery", invoiceId = `INV-${id}`) => ({
  id,
  status: "submitted",
  submittedAt: placed.toISOString(),
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [{ sku: "A", label: "Eggs (per dozen), Large", qty: 1, lineTotal: 7 }],
  totals: { subtotal: 700, discountAmount: 0, deliveryFee: 500, total: 1200 },
  fulfilment: {
    method,
    date: method === "delivery" ? "2026-10-08" : "2026-10-07",
    onfarm: method === "onfarm" ? { window: "morning" } : null,
    delivery: method === "delivery" ? {
      address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
    } : null,
  },
  square: { invoiceId, invoiceUrl: "https://pay/x" },
});

const harness = (invoiceStatus = "UNPAID") => {
  const sent = [];
  const cancelled = [];
  const bankClosed = [];

  return {
    sent,
    cancelled,
    bankClosed,
    opts: {
      env: {},
      mail: async (m) => {
        sent.push(m);

        return { id: `m${sent.length}`, driver: "test" };
      },
      invoice: async (id) => ({ id, status: invoiceStatus }),
      cancel: async (id) => {
        cancelled.push(id);

        return { id, cancelled: true };
      },
      close: async (id) => {
        bankClosed.push(id);

        return { id, status: "UNPAID", closed: true };
      },
    },
  };
};

describe("the timetable", () => {
  it("puts the final reminder at 8:00 the day before", () => {
    assert.equal(finalReminderAt(order("A")).toISOString(),
      at("2026-10-07", 8).toISOString());
    assert.equal(finalReminderAt(order("A", "onfarm")).toISOString(),
      at("2026-10-06", 8).toISOString());
  });

  it("abandons a delivery at the Wednesday-noon cutoff and a pickup at " +
    "midnight before", () => {
    assert.equal(abandonAt(order("A")).toISOString(),
      at("2026-10-07", 12).toISOString());
    assert.equal(abandonAt(order("A", "onfarm")).toISOString(),
      at("2026-10-07", 0).toISOString());
  });

  it("reminds about a delivery at 18:00 the evening before", () => {
    assert.equal(deliveryReminderAt(order("A")).toISOString(),
      at("2026-10-07", 18).toISOString());
  });

  it("picks the reminder stage from the clock and what was sent", () => {
    const o = order("A");

    // Placed at 09:00, so the first reminder is due at 10:00.
    assert.equal(reminderDue(o, at("2026-10-05", 9, 59)), null);
    assert.equal(reminderDue(o, at("2026-10-05", 10)), "soon");
    assert.equal(reminderDue({ ...o, emails: { soon: {} } },
      at("2026-10-05", 10)), null);
    assert.equal(reminderDue({ ...o, emails: { soon: {} } },
      at("2026-10-06", 9)), "nextDay");
    assert.equal(reminderDue({ ...o, emails: { soon: {}, nextDay: {} } },
      at("2026-10-07", 7, 59)), null);
    assert.equal(reminderDue({ ...o, emails: { soon: {}, nextDay: {} } },
      at("2026-10-07", 8)), "final");
    // A late first run still sends only the most urgent stage.
    assert.equal(reminderDue(o, at("2026-10-07", 8)), "final");
  });
});

describe("runJobs", () => {
  it("sends each reminder once as time passes, then abandons", async () => {
    const stores = testStores();
    const { sent, cancelled, opts } = harness();

    await saveOrder(stores, order("A"), placed);

    const stages = async (when) => {
      const r = await runJobs(stores, { ...opts, now: when });

      return r.reminded.map((x) => x.stage);
    };

    assert.deepEqual(await stages(at("2026-10-05", 9, 45)), []);
    assert.deepEqual(await stages(at("2026-10-05", 10, 1)), ["soon"]);
    assert.deepEqual(await stages(at("2026-10-05", 10, 16)), []);
    assert.deepEqual(await stages(at("2026-10-06", 9, 1)), ["nextDay"]);
    assert.deepEqual(await stages(at("2026-10-06", 20)), []);
    assert.deepEqual(await stages(at("2026-10-07", 8, 1)), ["final"]);
    assert.deepEqual(await stages(at("2026-10-07", 8, 16)), []);
    assert.equal(sent.length, 3);
    assert.match(sent[2].subject, /Last call/);
    assert.match(sent[2].text, /cancelled and marked abandoned/);

    const r = await runJobs(stores, { ...opts, now: at("2026-10-07", 12, 1) });

    assert.deepEqual(r.abandoned, ["A"]);
    assert.deepEqual(cancelled, ["INV-A"]);
    assert.equal((await getOrder(stores, "A")).status, "abandoned");
    assert.equal((await openOrders(stores)).length, 0);

    const again = await runJobs(stores, { ...opts, now: at("2026-10-07", 13) });

    assert.deepEqual(again.abandoned, []);
    assert.equal(sent.length, 3);
  });

  it("pays through the poll and stops reminding", async () => {
    const stores = testStores();
    const { sent, opts } = harness("PAID");

    await saveOrder(stores, order("A"), placed);
    const r = await runJobs(stores, { ...opts, now: at("2026-10-05", 10) });

    assert.deepEqual(r.paid, ["A"]);
    assert.deepEqual(r.reminded, []);
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /confirmed/);
  });

  it("holds a pending bank transfer: no reminders, no abandoning",
    async () => {
      const stores = testStores();
      const { sent, cancelled, opts } = harness("PAYMENT_PENDING");

      await saveOrder(stores, order("A"), placed);
      const nagTime = await runJobs(stores, {
        ...opts, now: at("2026-10-05", 9, 31),
      });
      const cutoff = await runJobs(stores, {
        ...opts, now: at("2026-10-07", 12, 1),
      });

      assert.deepEqual(nagTime.reminded, []);
      assert.deepEqual(cutoff.abandoned, []);
      assert.deepEqual(cancelled, []);
      assert.equal(sent.length, 0);
      assert.equal((await getOrder(stores, "A")).status, "submitted");

      const cleared = harness("PAID");
      const r = await runJobs(stores, {
        ...cleared.opts, now: at("2026-10-07", 13),
      });

      assert.deepEqual(r.paid, ["A"]);
    });

  it("takes bank transfer off an invoice once the date is too close",
    async () => {
      const stores = testStores();
      const { bankClosed, opts } = harness();
      // Placed Monday the 5th for Thursday the 15th: eight business
      // days out, so the invoice offered bank transfer. Five business
      // days remain on Thursday the 8th; four on Friday the 9th.
      const farOut = order("A");

      farOut.fulfilment.date = "2026-10-15";
      farOut.square.bankTransfer = true;
      await saveOrder(stores, farOut, placed);

      const still = await runJobs(stores, {
        ...opts, now: at("2026-10-08", 9),
      });
      const closed = await runJobs(stores, {
        ...opts, now: at("2026-10-09", 9),
      });
      const again = await runJobs(stores, {
        ...opts, now: at("2026-10-09", 9, 15),
      });

      assert.deepEqual(still.bankTransferClosed, []);
      assert.deepEqual(closed.bankTransferClosed, ["A"]);
      assert.deepEqual(again.bankTransferClosed, []);
      assert.deepEqual(bankClosed, ["INV-A"]);
      assert.ok((await getOrder(stores, "A")).square.bankTransferClosedAt);
    });

  it("never closes an invoice that did not offer bank transfer",
    async () => {
      const stores = testStores();
      const { bankClosed, opts } = harness();

      await saveOrder(stores, order("A"), placed);
      await runJobs(stores, { ...opts, now: at("2026-10-06", 9) });

      assert.deepEqual(bankClosed, []);
    });

  it("reminds paid deliveries the evening before, once, then closes",
    async () => {
      const stores = testStores();
      const { sent, opts } = harness();

      await saveOrder(stores, order("A"), placed);
      await saveOrder(stores, order("B", "onfarm"), placed);
      await markPaid(stores, "A", { ...opts, now: placed });
      await markPaid(stores, "B", { ...opts, now: placed });
      sent.length = 0;

      const early = await runJobs(stores, {
        ...opts, now: at("2026-10-07", 17),
      });

      assert.deepEqual(early.deliveryReminded, []);

      const evening = await runJobs(stores, {
        ...opts, now: at("2026-10-07", 18, 5),
      });

      assert.deepEqual(evening.deliveryReminded, ["A"]);
      assert.equal(sent.length, 1);
      assert.match(sent[0].subject, /delivery is tomorrow/);
      assert.match(sent[0].text, /cooler/);

      const later = await runJobs(stores, {
        ...opts, now: at("2026-10-07", 21),
      });

      assert.deepEqual(later.deliveryReminded, []);
      assert.equal(sent.length, 1);

      // The pickup was Wednesday: closed on Thursday. The delivery is
      // Thursday: closed on Friday.
      const thursday = await runJobs(stores, {
        ...opts, now: at("2026-10-08", 9),
      });

      assert.deepEqual(thursday.closed, ["B"]);

      const friday = await runJobs(stores, {
        ...opts, now: at("2026-10-09", 9),
      });

      assert.deepEqual(friday.closed, ["A"]);
      assert.equal((await openOrders(stores)).length, 0);
      assert.equal((await getOrder(stores, "A")).status, "fulfilled");
    });

  it("does not remind about a delivery the morning of", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    await saveOrder(stores, order("A"), placed);
    await markPaid(stores, "A", { ...opts, now: placed });
    sent.length = 0;
    const r = await runJobs(stores, { ...opts, now: at("2026-10-08", 7) });

    assert.deepEqual(r.deliveryReminded, []);
  });
});
