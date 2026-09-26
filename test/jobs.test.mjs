import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SQUARE_SYNC_GRACE, checkInvariants, cutoffAt, deliveryReminderAt, runJobs,
  runsSince,
} from "../netlify/functions/lib/jobs.mjs";
import { readMark } from "../netlify/functions/lib/health.mjs";
import {
  CHECKOUT_TTL, getCheckout, getOrder, openOrders, saveCheckout,
  saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const TZ = "America/New_York";
const at = (iso, h, m = 0) => instant(iso, h, m, TZ);

// Placed and paid Monday 5 October 2026 at 09:00 ET for delivery
// Thursday the 8th, or on-farm pickup Wednesday the 7th.
const placed = at("2026-10-05", 9);

const order = (id, method = "delivery") => ({
  id,
  status: "paid",
  submittedAt: placed.toISOString(),
  paidAt: placed.toISOString(),
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [{ sku: "A", label: "Eggs (per dozen), Large", qty: 1, lineTotal: 7 }],
  totals: { subtotal: 700, discountAmount: 0, deliveryFee: 500, total: 1200 },
  fulfilment: {
    method,
    date: method === "delivery" ? "2026-10-08" : "2026-10-07",
    state: "agreed",
    onfarm: method === "onfarm" ? { window: "morning" } : null,
    delivery: method === "delivery" ? {
      address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
    } : null,
  },
  square: { squareOrderId: "SQO", customerId: "CUST" },
  payment: {
    via: "square", method: "card", at: placed.toISOString(),
    squarePaymentId: `PAY-${id}`, receiptUrl: "https://sq/receipt",
    brand: "VISA", last4: "4242",
  },
});

// A Venmo order whose Square copy never got made.
const venmo = (id, method = "delivery") => ({
  ...order(id, method),
  square: null,
  meta: { idempotencyKey: "0f7c1e3a-9c9b-4b3a-8e9d-1a2b3c4d5e6f", attempt: 1 },
  payment: {
    via: "venmo", method: "venmo", at: placed.toISOString(),
    squarePaymentId: null, receiptUrl: null,
    paypalOrderId: "PPO", paypalCaptureId: "CAP",
  },
});

const harness = () => {
  const sent = [];

  return {
    sent,
    opts: {
      env: {},
      mail: async (m) => {
        sent.push(m);

        return { id: `m${sent.length}`, driver: "test" };
      },
    },
  };
};

describe("the timetable", () => {
  it("closes changes at the Wednesday-noon cutoff for a delivery and " +
    "midnight before a pickup", () => {
    assert.equal(cutoffAt(order("A")).toISOString(),
      at("2026-10-07", 12).toISOString());
    assert.equal(cutoffAt(order("A", "onfarm")).toISOString(),
      at("2026-10-07", 0).toISOString());
  });

  it("closes changes to a drop-site order at the end of Friday", () => {
    const drop = order("A", "onfarm");

    drop.fulfilment = { ...drop.fulfilment, method: "scituate",
      date: "2026-10-17", onfarm: null };
    assert.equal(cutoffAt(drop).toISOString(),
      at("2026-10-17", 0).toISOString());
  });

  it("reminds about a delivery at 18:00 the evening before", () => {
    assert.equal(deliveryReminderAt(order("A")).toISOString(),
      at("2026-10-07", 18).toISOString());
  });
});

describe("runJobs", () => {
  it("reminds deliveries the evening before, once, then closes",
    async () => {
      const stores = testStores();
      const { sent, opts } = harness();

      await saveOrder(stores, order("A"), placed);
      await saveOrder(stores, order("B", "onfarm"), placed);

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

  it("skips the delivery reminder when it is turned off and still " +
    "closes the order", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    await saveCustomer(stores, {
      email: "pat@example.com", reminders: { delivery: false },
    });
    await saveOrder(stores, order("A"), placed);

    const evening = await runJobs(stores, {
      ...opts, now: at("2026-10-07", 18, 5),
    });

    assert.deepEqual(evening.deliveryReminded, []);
    assert.deepEqual(evening.muted, [{ id: "A", kind: "delivery" }]);
    assert.equal(sent.length, 0);

    const friday = await runJobs(stores, { ...opts, now: at("2026-10-09", 9) });

    assert.deepEqual(friday.closed, ["A"]);
  });

  it("does not remind about a delivery the morning of", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    await saveOrder(stores, order("A"), placed);
    const r = await runJobs(stores, { ...opts, now: at("2026-10-08", 7) });

    assert.deepEqual(r.deliveryReminded, []);
    assert.equal(sent.length, 0);
  });

  it("leaves an order with an open question alone until it is answered",
    async () => {
      const stores = testStores();
      const { sent, opts } = harness();
      const o = order("A", "onfarm");

      o.fulfilment.state = "requested";
      o.question = {
        kind: "window", reason: "", openedAt: placed.toISOString(),
        answeredAt: null, answer: null, by: null,
      };
      await saveOrder(stores, o, placed);

      // The day after its date, an order still asking is not closed.
      const dayAfter = await runJobs(stores, {
        ...opts, now: at("2026-10-08", 9),
      });

      assert.deepEqual(dayAfter.closed, []);
      assert.equal(sent.length, 0);
      assert.equal((await getOrder(stores, "A")).status, "paid");

      // Answered by moving the date: the clocks run on the new one.
      await saveOrder(stores, {
        ...(await getOrder(stores, "A")),
        fulfilment: { ...o.fulfilment, date: "2026-10-14" },
        question: { ...o.question, answeredAt: "x", answer: "reschedule" },
      }, placed);
      const still = await runJobs(stores, {
        ...opts, now: at("2026-10-14", 9),
      });
      const closed = await runJobs(stores, {
        ...opts, now: at("2026-10-15", 9),
      });

      assert.deepEqual(still.closed, []);
      assert.deepEqual(closed.closed, ["A"]);
    });

  it("makes the Square copy of a Venmo order that lacks one", async () => {
    const stores = testStores();
    const { opts } = harness();
    const calls = [];
    const square = {
      createOrder: async (o, key) => {
        calls.push(["order", o.id, key]);

        return { squareOrderId: "SQO-2", customerId: "CUST-2" };
      },
      createPayment: async ({ order: o, squareOrderId, source, key }) => {
        calls.push(["payment", o.id, squareOrderId, source, key]);

        return { squarePaymentId: "PAY-X", status: "COMPLETED" };
      },
    };

    await saveOrder(stores, venmo("A"), placed);
    await saveOrder(stores, order("B"), placed);
    const r = await runJobs(stores, {
      ...opts, square, now: at("2026-10-05", 10),
    });

    assert.deepEqual(r.squareSynced, ["A"]);
    assert.equal(calls.length, 2, "only the Venmo order without a copy");
    assert.equal(calls[0][1], "A");
    assert.deepEqual(calls[1][3], {
      external: { source: "Venmo", sourceId: "CAP" },
    });
    assert.equal(calls[0][2], calls[1][4], "one key for both steps");

    const synced = await getOrder(stores, "A");

    assert.deepEqual(synced.square, {
      squareOrderId: "SQO-2", customerId: "CUST-2",
    });
    assert.equal(synced.payments[0].squarePaymentId, "PAY-X");
    assert.equal(synced.history.at(-1).event, "square.recorded");

    const again = await runJobs(stores, {
      ...opts, square, now: at("2026-10-05", 10, 15),
    });

    assert.deepEqual(again.squareSynced, []);
    assert.equal(calls.length, 2);
  });

  it("keeps trying the Square copy while Square is down, without " +
    "failing the run", async () => {
    const stores = testStores();
    const { sent, opts } = harness();
    const square = {
      createOrder: async () => {
        throw Object.assign(new Error("503"), { retryable: false });
      },
      createPayment: async () => ({}),
    };

    await saveOrder(stores, venmo("A"), placed);
    const r = await runJobs(stores, {
      ...opts, square, env: { ADMIN_EMAILS: "farm@x.com" },
      now: at("2026-10-05", 10),
    });

    assert.deepEqual(r.squareSynced, []);
    assert.deepEqual(r.errors, []);
    assert.equal((await getOrder(stores, "A")).square, null);
    assert.ok(sent.some((m) =>
      m.subject === "Site alert: square.record_failed"));
  });

  it("sweeps checkouts nobody finished after a day", async () => {
    const stores = testStores();
    const { opts } = harness();

    await saveCheckout(stores, {
      key: "k-old", attempt: 1, at: placed.toISOString(), order: order("A"),
      paypalOrderId: "PPO-1",
    });
    await saveCheckout(stores, {
      key: "k-new", attempt: 1, at: at("2026-10-06", 8).toISOString(),
      order: order("B"), paypalOrderId: "PPO-2",
    });

    const before = await runJobs(stores, {
      ...opts, now: new Date(placed.getTime() + CHECKOUT_TTL - 60_000),
    });

    assert.equal(before.checkoutsSwept, 0);

    const after = await runJobs(stores, {
      ...opts, now: new Date(placed.getTime() + CHECKOUT_TTL + 60_000),
    });

    assert.equal(after.checkoutsSwept, 1);
    assert.equal(await getCheckout(stores, "k-old"), null);
    assert.ok(await getCheckout(stores, "k-new"));
    assert.equal(await stores.orders.get("by-paypal/PPO-1"), null);
  });

  it("rescues an approved Venmo checkout before the sweep", async () => {
    const stores = testStores();
    const { opts } = harness();
    const calls = [];
    const paypal = {
      getOrder: async (id) => ({
        status: id === "PPO-1" ? "APPROVED" : "CREATED",
        updatedAt: placed.toISOString(), capture: null,
      }),
      captureOrder: async (id) => {
        calls.push(id);

        return {
          paypalOrderId: id, paypalCaptureId: "CAP-1", status: "COMPLETED",
          amount: 1200, payer: { email: null, name: null },
        };
      },
    };
    const square = {
      createOrder: async () => ({ squareOrderId: "SQO", customerId: "C" }),
      createPayment: async () => ({ squarePaymentId: "PAY" }),
    };

    await saveCheckout(stores, {
      key: "k-approved", attempt: 1, at: placed.toISOString(),
      order: { ...order("A"), status: undefined }, paypalOrderId: "PPO-1",
    });
    await saveCheckout(stores, {
      key: "k-abandoned", attempt: 1, at: placed.toISOString(),
      order: { ...order("B"), status: undefined }, paypalOrderId: "PPO-2",
    });

    const r = await runJobs(stores, {
      ...opts, paypal, square,
      now: new Date(placed.getTime() + CHECKOUT_TTL + 60_000),
    });

    assert.deepEqual(r.checkoutsRescued, ["A"]);
    assert.deepEqual(calls, ["PPO-1"]);
    assert.equal(r.checkoutsSwept, 1);
    assert.equal((await getOrder(stores, "A")).payments[0].paypalCaptureId,
      "CAP-1");
    assert.equal(await getOrder(stores, "B"), null);
    assert.deepEqual(r.errors, []);
  });

  it("sends the morning report once a morning, with the pickups to " +
    "decide", async () => {
    const stores = testStores();
    const { sent, opts } = harness();
    const env = { ADMIN_EMAILS: "farm@x.com" };
    const waiting = order("A", "onfarm");
    const far = order("B", "onfarm");
    const delivery = order("C");

    waiting.fulfilment.state = "requested";
    far.fulfilment.state = "requested";
    far.fulfilment.date = "2026-10-14";
    await saveOrder(stores, waiting, placed);
    await saveOrder(stores, far, placed);
    await saveOrder(stores, delivery, placed);

    // Wednesday the 7th is two days from Monday the 5th; before 8:00
    // nothing, then once, then not again that day.
    const early = await runJobs(stores, {
      ...opts, env, now: at("2026-10-05", 7, 59),
    });
    const eight = await runJobs(stores, {
      ...opts, env, now: at("2026-10-05", 8),
    });
    const noon = await runJobs(stores, {
      ...opts, env, now: at("2026-10-05", 12),
    });

    assert.deepEqual(early.pickupsToConfirm, []);
    assert.deepEqual(eight.pickupsToConfirm, ["A"]);
    assert.deepEqual(noon.pickupsToConfirm, []);

    const report = sent.filter((m) => /Morning report/.test(m.subject));

    assert.equal(report.length, 1);
    assert.deepEqual(report[0].to, ["farm@x.com"]);
    assert.equal(report[0].subject, "Morning report: Monday, October 5");
    assert.match(report[0].text, /Orders placed\s+3\s+🫥\n/, "the funnel");
    assert.match(report[0].text, /Paid by card or a wallet\s+3\s+🫥\n/);
    assert.match(report[0].text,
      /\nA\s+Pat Example\s+Wednesday, October 7, morning\s+under an hour/);
    assert.doesNotMatch(report[0].text, /\bunpaid\b/, "no Paid column");
    assert.ok(report[0].text.includes("\n    bin/nff orders confirm <id>\n"));
    assert.doesNotMatch(report[0].text, /\nB\s+Pat|\nC\s+Pat/);

    // Nothing to decide: the report still goes, and says so.
    const quiet = testStores();

    await saveOrder(quiet, far, placed);
    const none = await runJobs(quiet, {
      ...opts, env, now: at("2026-10-05", 8),
    });

    assert.deepEqual(none.pickupsToConfirm, []);
    const both = sent.filter((m) => /Morning report/.test(m.subject));

    assert.equal(both.length, 2);
    assert.match(both[1].text, /No pickups waiting on a decision/);
  });

  it("sends tomorrow's manifest at 18:00, even when empty", async () => {
    const stores = testStores();
    const { sent, opts } = harness();
    const env = { ADMIN_EMAILS: "farm@x.com" };
    const pickup = order("B", "onfarm"); // Wednesday the 7th.

    await saveOrder(stores, order("A"), placed); // Thursday the 8th.
    await saveOrder(stores, pickup, placed);

    const before = await runJobs(stores, {
      ...opts, env, now: at("2026-10-06", 17, 59),
    });
    const evening = await runJobs(stores, {
      ...opts, env, now: at("2026-10-06", 18),
    });
    const again = await runJobs(stores, {
      ...opts, env, now: at("2026-10-06", 18, 30),
    });

    assert.equal(before.tomorrow, null);
    assert.equal(evening.tomorrow, 1);
    assert.equal(again.tomorrow, null);

    const manifest = sent.filter((m) => /^Tomorrow, /.test(m.subject));

    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].subject,
      "Tomorrow, Wednesday, October 7: 1 order");
    assert.match(manifest[0].text, /\*\*B\*\*, Pat Example, morning/);
    assert.doesNotMatch(manifest[0].text, /\*\*A\*\*/, "A is Thursday");

    const thursdayEve = await runJobs(stores, {
      ...opts, env, now: at("2026-10-07", 18),
    });

    assert.equal(thursdayEve.tomorrow, 1);
    const next = sent.filter((m) => /^Tomorrow, /.test(m.subject));

    assert.match(next[1].subject, /Thursday, October 8: 1 order/);
    assert.match(next[1].text, /Deliveries \(1\)/);
    assert.match(next[1].text, /- Address: 1 Main St, Foster/);

    const empty = testStores();
    const nothing = await runJobs(empty, {
      ...opts, env, now: at("2026-10-06", 18),
    });

    assert.equal(nothing.tomorrow, 0);
    assert.match(sent.at(-1).subject, /Tomorrow, Wednesday, October 7: 0/);
    assert.match(sent.at(-1).text, /Nothing due Wednesday, October 7/);
  });

  it("isolates a failing order, records the run, alerts and pings",
    async () => {
      const stores = testStores();
      const { sent, opts } = harness();
      const pings = [];
      const fetchImpl = async (url, init = {}) => {
        pings.push({ url, method: init.method || "GET" });

        return { ok: true };
      };
      const env = {
        ADMIN_EMAILS: "farm@x.com", HEALTHCHECKS_JOBS_URL: "https://hc/jobs",
      };

      // Order B has no fulfilment, so its date cannot be read and its
      // work throws; A must still be closed the day after its date.
      const broken = { ...order("B"), fulfilment: null };

      await saveOrder(stores, order("A"), placed);
      await saveOrder(stores, broken, placed);
      const r = await runJobs(stores, {
        ...opts, env, fetchImpl, now: at("2026-10-09", 9),
      });

      assert.deepEqual(r.closed, ["A"]);
      assert.ok(r.errors.some((e) => e.id === "B" && e.step === "order"),
        JSON.stringify(r.errors));
      assert.equal((await getOrder(stores, "A")).status, "fulfilled");

      const alerts = sent.filter((m) => /Site alert/.test(m.subject));

      assert.ok(alerts.some((m) => m.subject === "Site alert: jobs.errors"));
      assert.deepEqual(pings.filter((p) => /hc\/jobs/.test(p.url)),
        [{ url: "https://hc/jobs/fail", method: "POST" }]);
      assert.ok(r.invariants.some((v) => v.rule === "order.unreadable"
        && v.id === "B"), "the invariants name it too, and carry on");

      const runs = await runsSince(stores, at("2026-10-09", 0));

      assert.equal(runs.length, 1);
      assert.equal(runs[0].counts.closed, 1);
      assert.ok(runs[0].errors.some((e) => e.id === "B"));
      assert.ok((await readMark(stores, "alert/jobs.errors")));

      // A clean run pings well with a GET.
      const fine = testStores();

      await runJobs(fine, {
        ...opts, env, fetchImpl, now: at("2026-10-05", 9),
      });
      assert.deepEqual(pings.at(-1), { url: "https://hc/jobs", method: "GET" });
    });

  it("keeps two days of runs in the ledger", async () => {
    const stores = testStores();
    const { opts } = harness();
    const hour = 3_600_000;

    const after = (h) => new Date(placed.getTime() + h * hour);

    for (const h of [0, 12, 24, 36, 47, 49]) {
      await runJobs(stores, { ...opts, now: after(h) });
    }
    const runs = await runsSince(stores, placed);

    assert.equal(runs.length, 5, "the run 49 hours old is pruned");
    assert.equal(runs[0].at, after(49).toISOString());
    assert.equal(runs.at(-1).at, after(12).toISOString());
  });

  it("invariants are quiet for a healthy set of orders", () => {
    const fresh = [order("A"), order("B", "onfarm"), venmo("C")];

    assert.deepEqual(checkInvariants(fresh, at("2026-10-05", 9, 30)), []);
    assert.deepEqual(checkInvariants(fresh.slice(0, 2), at("2026-10-08", 9)),
      [], "the day after their dates, not yet two");
  });

  it("invariants name a paid order two days past its date, unless it " +
    "is still asking", () => {
    const paid = order("A", "onfarm");

    assert.deepEqual(checkInvariants([paid], at("2026-10-08", 9)), []);
    assert.deepEqual(checkInvariants([paid], at("2026-10-09", 9)),
      [{ rule: "paid.not_closed", id: "A" }]);
    assert.deepEqual(checkInvariants([{
      ...paid, question: { kind: "window", openedAt: "x", answeredAt: null },
    }], at("2026-10-09", 9)), []);
  });

  it("invariants name a record still unpaid from the invoice era, a " +
    "Venmo order missing its Square copy, and one it cannot read", () => {
    const legacy = { ...order("A"), status: "submitted" };

    assert.deepEqual(checkInvariants([legacy], at("2026-10-05", 9, 30)),
      [{ rule: "legacy.unpaid", id: "A" }]);

    const copyless = venmo("B");
    const soon = new Date(placed.getTime() + SQUARE_SYNC_GRACE - 60_000);
    const late = new Date(placed.getTime() + SQUARE_SYNC_GRACE + 60_000);

    assert.deepEqual(checkInvariants([copyless], soon), []);
    assert.deepEqual(checkInvariants([copyless], late),
      [{ rule: "square.missing", id: "B" }]);

    assert.deepEqual(checkInvariants([{ ...order("C"), fulfilment: null }],
      at("2026-10-05", 9, 30)), [{ rule: "order.unreadable", id: "C" }]);
  });
});
