import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MADE_CUSTOMER_GRACE, MADE_CUSTOMER_KEEP, SQUARE_OPEN_GRACE,
  SQUARE_SWEEP_HOUR,
  SQUARE_SYNC_GRACE, checkInvariants, cutoffAt, deliveryReminderAt,
  leftOpen, runJobs, runsSince, sweepMadeCustomers, sweepSquareOrders,
} from "../netlify/functions/lib/jobs.mjs";
import { SOURCE_NAME } from "../netlify/functions/lib/square.mjs";
import { readMark } from "../netlify/functions/lib/health.mjs";
import {
  CHECKOUT_TTL, getCheckout, getOrder, listMadeCustomers, noteMadeCustomer,
  openOrders, saveCheckout, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

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

  it("reminds again before a missed delivery's new day (#193)", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    await saveOrder(stores, order("A"), placed);
    await runJobs(stores, { ...opts, now: at("2026-10-07", 18, 5) });
    assert.equal(sent.length, 1);

    // Missed on the 8th, and the customer chose the 15th.
    await saveOrder(stores, {
      ...(await getOrder(stores, "A")),
      attempted: { at: at("2026-10-08", 13).toISOString(),
        cause: "no-cooler", fee: 500 },
      fulfilment: { ...order("A").fulfilment, date: "2026-10-15" },
      question: { kind: "missed", answeredAt: "x", answer: "reschedule" },
    }, placed);

    const r = await runJobs(stores, { ...opts, now: at("2026-10-14", 18, 5) });

    assert.deepEqual(r.deliveryReminded, ["A"]);
    assert.equal(sent.length, 2);

    const again = await runJobs(stores, {
      ...opts, now: at("2026-10-14", 20),
    });

    assert.deepEqual(again.deliveryReminded, []);
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

  it("sends the morning report once a morning, with the pickups " +
    "waiting on the customer", async () => {
    const stores = testStores();
    const { sent, opts } = harness();
    const env = { ADMIN_EMAILS: "farm@x.com", PICKUP_SCHEDULE: SCHEDULE };
    const waiting = order("A", "onfarm");
    const far = order("B", "onfarm");
    const delivery = order("C");
    // The farm gave up both times (W11d); only A is within two days.
    const gaveUp = {
      kind: "window", reason: "Frost.", openedAt: placed.toISOString(),
      answeredAt: null, answer: null, by: null,
    };

    waiting.question = gaveUp;
    far.question = gaveUp;
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
      /\nA\s+Pat Example\s+Wednesday, October 7, 9 AM – noon\s+under an hour/);
    assert.doesNotMatch(report[0].text, /\bunpaid\b/, "no Paid column");
    assert.doesNotMatch(report[0].text, /orders confirm|Pickup schedule/,
      "the fixture's schedule reaches far enough");
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
    assert.match(both[1].text, /No pickups waiting on the customer/);

    // A schedule that falls short is flagged every morning.
    const short = testStores();

    await runJobs(short, {
      ...opts, env: { ...env, PICKUP_SCHEDULE: "2026-10-09 09:00-12:00" },
      now: at("2026-10-05", 8),
    });
    assert.match(sent.at(-1).text, /The pickup schedule's last window is on /);
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
    assert.match(manifest[0].text, /\*\*B\*\*, Pat Example, 9 AM – noon/);
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

describe("Square orders left open (#241)", () => {
  const squareEnv = { SQUARE_ACCESS_TOKEN: "tok", SQUARE_LOCATION_ID: "LOC" };
  const now = at("2026-10-07", 9);
  const open = (id, referenceId, extra = {}) => ({
    id, referenceId, source: SOURCE_NAME, createdAt: placed.toISOString(),
    tenders: 0, total: 1200, ...extra,
  });
  const fakeSquare = (found, { fails = [] } = {}) => {
    const calls = [];

    return {
      calls,
      searchOpenOrders: async ({ before }) => {
        calls.push(["search", before.toISOString()]);

        return found;
      },
      cancelOrder: async (id, { unpaid }) => {
        calls.push(["cancel", id, unpaid]);
        if (fails.includes(id)) throw new Error("Square 500");

        return { id, cancelled: true };
      },
    };
  };

  it("counts only the site's own unpaid orders", () => {
    assert.equal(leftOpen(open("S", "NFF-2610-ABCD")), true);
    assert.equal(leftOpen(open("S", "NFF-2610-ABCD", { tenders: 1 })), false,
      "paid");
    assert.equal(leftOpen(open("S", "NFF-2610-ABCD", { source: null })),
      false, "made before the source was set, or by the farm");
    assert.equal(leftOpen(open("S", "INV-0042")), false, "an invoice");
    assert.equal(leftOpen(open("S", null)), false, "the POS");
  });

  it("reports the orders a day old with no record and no checkout " +
    "waiting, and cancels nothing", async () => {
    const stores = testStores();

    await saveOrder(stores, { ...order("NFF-2610-PAID"), square: null });
    await saveCheckout(stores, {
      key: "k", attempt: 1, at: placed.toISOString(),
      order: order("NFF-2610-VENM"), paypalOrderId: "PPO",
    });

    const square = fakeSquare([
      open("SQ-LEFT", "NFF-2610-LEFT"),
      open("SQ-CHANGE", "NFF-2610-PAID"),
      open("SQ-VENMO", "NFF-2610-VENM"),
      open("SQ-POS", null, { source: "Square Point of Sale" }),
    ]);
    const found = await sweepSquareOrders(stores, {
      env: squareEnv, now, square,
    });

    assert.deepEqual(found, [{
      squareOrderId: "SQ-LEFT", orderId: "NFF-2610-LEFT",
      createdAt: placed.toISOString(), total: 1200, cancelled: false,
    }]);
    assert.deepEqual(square.calls, [[
      "search", new Date(now.getTime() - SQUARE_OPEN_GRACE).toISOString(),
    ]]);
  });

  it("cancels them, unpaid only, when SQUARE_SWEEP_CANCEL is true, and " +
    "reports a failure as a job error", async () => {
    const stores = testStores();
    const square = fakeSquare([
      open("SQ-1", "NFF-2610-AAAA"), open("SQ-2", "NFF-2610-BBBB"),
    ], { fails: ["SQ-2"] });
    const r = await runJobs(stores, {
      ...harness().opts, square, now,
      env: { ...squareEnv, SQUARE_SWEEP_CANCEL: "true" },
    });

    assert.deepEqual(square.calls.slice(1), [
      ["cancel", "SQ-1", true], ["cancel", "SQ-2", true],
    ]);
    assert.deepEqual(r.squareOpen.map((o) => o.cancelled), [true, false]);
    assert.deepEqual(r.errors, [{
      id: "NFF-2610-BBBB", step: "squareCancel", error: "Square 500",
    }]);

    const [run] = await runsSince(stores, new Date(0));

    assert.equal(run.counts.squareOpen, 2);
    assert.equal(run.squareCancelled, 1);
  });

  it("runs once a day from 7:00, and the morning report says what it " +
    "found", async () => {
    const stores = testStores();
    const { sent, opts } = harness();
    const env = {
      ...squareEnv, ADMIN_EMAILS: "farm@x.com", PICKUP_SCHEDULE: SCHEDULE,
    };
    const square = fakeSquare([
      open("SQ-1", "NFF-2610-AAAA"), open("SQ-2", "NFF-2610-BBBB"),
    ]);
    const run = (h, m = 0) => runJobs(stores, {
      ...opts, env, square, now: at("2026-10-07", h, m),
    });

    assert.equal(SQUARE_SWEEP_HOUR, 7);
    assert.deepEqual((await run(6, 45)).squareOpen, []);
    assert.equal((await run(7)).squareOpen.length, 2);
    assert.deepEqual((await run(7, 15)).squareOpen, []);
    assert.deepEqual(square.calls.map((c) => c[0]), ["search"],
      "one search that day");
    await run(8);

    const [report] = sent.filter((m) => /Morning report/.test(m.subject));

    assert.match(report.text, /Left in Square/);
    assert.ok(report.text.includes("Failed payments left 2 orders open " +
      "in Square. To see them:"), report.text);
    assert.match(report.text, /\n {4}bin\/nff jobs square\n/);
  });

  it("does nothing where Square is not configured", async () => {
    const square = fakeSquare([open("SQ-1", "NFF-2610-AAAA")]);

    assert.equal(await sweepSquareOrders(testStores(), {
      env: {}, now, square,
    }), null);
    assert.deepEqual(square.calls, []);
  });
});

describe("Square profiles a failed checkout made (#236)", () => {
  const squareEnv = { SQUARE_ACCESS_TOKEN: "tok", SQUARE_LOCATION_ID: "LOC" };
  const now = new Date(placed.getTime() + MADE_CUSTOMER_GRACE + 60 * 60_000);
  const note = (stores, customerId, orderId, at = placed) =>
    noteMadeCustomer(stores, {
      customerId, orderId, email: `${customerId}@example.com`,
    }, at);
  const fakeSquare = ({ orders = {}, fails = [] } = {}) => {
    const calls = [];

    return {
      calls,
      // The jobs also sweep open orders (#241); there are none here.
      searchOpenOrders: async () => [],
      customerOrders: async (id, { since }) => {
        calls.push(["orders", id, since.toISOString()]);

        return orders[id] || { paid: false, recent: false };
      },
      deleteCustomer: async (id) => {
        calls.push(["delete", id]);
        if (fails.includes(id)) throw new Error("Square 500");

        return { id, deleted: true };
      },
    };
  };
  const noted = async (stores) => (await listMadeCustomers(stores))
    .map((m) => m.customerId).sort();

  it("reports a profile whose payment never succeeded, and deletes " +
    "nothing while the switch is off", async () => {
    const stores = testStores();
    const square = fakeSquare();

    await note(stores, "LOST", "NFF-2610-LOST");
    await note(stores, "FRESH", "NFF-2610-FRSH", now);

    const found = await sweepMadeCustomers(stores, {
      env: squareEnv, now, square,
    });

    assert.deepEqual(found, [{
      customerId: "LOST", orderId: "NFF-2610-LOST",
      at: placed.toISOString(), deleted: false,
    }]);
    assert.deepEqual(square.calls, [[
      "orders", "LOST",
      new Date(now.getTime() - MADE_CUSTOMER_GRACE).toISOString(),
    ]], "a note under a day old is not weighed yet");
    assert.deepEqual(await noted(stores), ["FRESH", "LOST"]);
  });

  it("keeps a profile a later attempt paid for, by record or in Square, " +
    "and waits on one with a recent order", async () => {
    const stores = testStores();
    const square = fakeSquare({ orders: {
      MARKET: { paid: true, recent: false },
      RETRY: { paid: false, recent: true },
    } });

    await saveOrder(stores, order("NFF-2610-PAID"));
    await note(stores, "PAID", "NFF-2610-PAID");
    await saveOrder(stores, {
      ...order("NFF-2610-LATR"),
      customer: { ...order("X").customer, email: "SAME@example.com" },
    });
    await note(stores, "SAME", "NFF-2610-GONE");
    await note(stores, "MARKET", "NFF-2610-MRKT");
    await note(stores, "RETRY", "NFF-2610-RTRY");

    const found = await sweepMadeCustomers(stores, {
      env: { ...squareEnv, SQUARE_CUSTOMER_CLEANUP: "true" }, now, square,
    });

    assert.deepEqual(found, []);
    assert.ok(!square.calls.some((c) => c[0] === "delete"));
    assert.deepEqual(await noted(stores), ["RETRY"],
      "kept ones are settled; the retry is weighed again later");
  });

  it("deletes them when SQUARE_CUSTOMER_CLEANUP is true, and reports a " +
    "Square error as a job error, keeping the note", async () => {
    const stores = testStores();
    const square = fakeSquare({ fails: ["BAD"] });

    await note(stores, "GONE", "NFF-2610-AAAA");
    await note(stores, "BAD", "NFF-2610-BBBB");

    const r = await runJobs(stores, {
      ...harness().opts, square, now,
      env: { ...squareEnv, SQUARE_CUSTOMER_CLEANUP: "true" },
    });

    assert.deepEqual(r.customersMade.map((c) => [c.customerId, c.deleted]),
      [["BAD", false], ["GONE", true]]);
    assert.deepEqual(r.errors, [{
      id: "NFF-2610-BBBB", step: "customerDelete", error: "Square 500",
    }]);
    assert.deepEqual(await noted(stores), ["BAD"]);

    const [run] = await runsSince(stores, new Date(0));

    assert.equal(run.counts.customersMade, 2);
    assert.equal(run.customersDeleted, 1);
  });

  it("drops a note after 30 days while the switch is off, and keeps " +
    "the profile", async () => {
    const stores = testStores();
    const square = fakeSquare();
    const late = new Date(placed.getTime() + MADE_CUSTOMER_KEEP + 60 * 60_000);

    await note(stores, "OLD", "NFF-2610-OLDD");
    assert.deepEqual(await sweepMadeCustomers(stores, {
      env: squareEnv, now: late, square,
    }), []);
    assert.deepEqual(await noted(stores), []);
    assert.deepEqual(square.calls, [], "nothing asked, nothing deleted");

    // With the switch on, an old note is weighed and deleted as ever.
    await note(stores, "OLD", "NFF-2610-OLDD");

    const found = await sweepMadeCustomers(stores, {
      env: { ...squareEnv, SQUARE_CUSTOMER_CLEANUP: "true" }, now: late,
      square,
    });

    assert.deepEqual(found.map((c) => c.deleted), [true]);
  });

  it("runs once a day from 7:00, and the morning report says what it " +
    "found", async () => {
    const stores = testStores();
    const { sent, opts } = harness();
    const env = {
      ...squareEnv, ADMIN_EMAILS: "farm@x.com", PICKUP_SCHEDULE: SCHEDULE,
    };
    const square = fakeSquare();
    const run = (h, m = 0) => runJobs(stores, {
      ...opts, env, square, now: at("2026-10-07", h, m),
    });

    await note(stores, "LOST", "NFF-2610-LOST");
    assert.deepEqual((await run(6, 45)).customersMade, []);
    assert.equal((await run(7)).customersMade.length, 1);
    assert.deepEqual((await run(7, 15)).customersMade, []);
    assert.deepEqual(square.calls.filter((c) => c[0] === "orders").length,
      1, "one look that day");
    await run(8);

    const [report] = sent.filter((m) => /Morning report/.test(m.subject));

    assert.ok(report.text.includes("Checkouts whose payment never went " +
      "through made 1 customer profile in Square. To see it:"),
    report.text);
    assert.match(report.text, /\n {4}bin\/nff jobs customers\n/);
  });

  it("does nothing where Square is not configured", async () => {
    const stores = testStores();
    const square = fakeSquare();

    await note(stores, "LOST", "NFF-2610-LOST");
    assert.equal(await sweepMadeCustomers(stores, {
      env: {}, now, square,
    }), null);
    assert.deepEqual(square.calls, []);
  });
});
