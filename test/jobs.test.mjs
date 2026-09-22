import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  abandonAt, checkInvariants, deliveryReminderAt, finalReminderAt,
  reminderDue, runJobs, runsSince,
} from "../netlify/functions/lib/jobs.mjs";
import { readMark } from "../netlify/functions/lib/health.mjs";
import { markPaid } from "../netlify/functions/lib/payments.mjs";
import {
  getOrder, openOrders, saveCustomer, saveOrder,
} from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import {
  applyPayment, unreportedPayments,
} from "../netlify/functions/lib/venmo.mjs";
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

  it("sends no payment reminders to a customer who turned them off, " +
    "but still abandons", async () => {
    const stores = testStores();
    const { sent, cancelled, opts } = harness();

    await saveCustomer(stores, {
      email: "pat@example.com", reminders: { payment: false },
    });
    await saveOrder(stores, order("A"), placed);

    const soon = await runJobs(stores, { ...opts, now: at("2026-10-05", 10) });
    const final = await runJobs(stores, { ...opts, now: at("2026-10-07", 8) });

    assert.deepEqual(soon.reminded, []);
    assert.deepEqual(soon.muted, [{ id: "A", kind: "payment" }]);
    assert.deepEqual(final.muted, [{ id: "A", kind: "payment" }]);
    assert.equal(sent.length, 0);

    const r = await runJobs(stores, { ...opts, now: at("2026-10-07", 12, 1) });

    assert.deepEqual(r.abandoned, ["A"]);
    assert.deepEqual(cancelled, ["INV-A"]);
  });

  it("skips the delivery reminder when it is turned off and still " +
    "closes the order", async () => {
    const stores = testStores();
    const { sent, opts } = harness();

    await saveCustomer(stores, {
      email: "pat@example.com", reminders: { delivery: false },
    });
    await saveOrder(stores, order("A"), placed);
    await markPaid(stores, "A", { ...opts, now: placed });
    sent.length = 0;

    const evening = await runJobs(stores, {
      ...opts, now: at("2026-10-07", 18, 5),
    });

    assert.deepEqual(evening.deliveryReminded, []);
    assert.deepEqual(evening.muted, [{ id: "A", kind: "delivery" }]);
    assert.equal(sent.length, 0);

    const friday = await runJobs(stores, { ...opts, now: at("2026-10-09", 9) });

    assert.deepEqual(friday.closed, ["A"]);
  });

  it("leaves an order with an open question alone until it is answered",
    async () => {
      const stores = testStores();
      const { sent, cancelled, opts } = harness();
      const o = order("A", "onfarm");

      o.fulfilment.state = "requested";
      o.question = {
        kind: "window", reason: "", openedAt: placed.toISOString(),
        answeredAt: null, answer: null, by: null,
      };
      await saveOrder(stores, o, placed);

      const nag = await runJobs(stores, { ...opts, now: at("2026-10-05", 10) });
      const cutoff = await runJobs(stores, {
        ...opts, now: at("2026-10-07", 0, 1),
      });

      assert.deepEqual(nag.reminded, []);
      assert.deepEqual(cutoff.abandoned, []);
      assert.deepEqual(cancelled, []);
      assert.equal(sent.length, 0);

      // Answered by moving the date: the clocks run on the new one.
      await saveOrder(stores, {
        ...(await getOrder(stores, "A")),
        fulfilment: { ...o.fulfilment, date: "2026-10-14" },
        question: { ...o.question, answeredAt: "x", answer: "reschedule" },
      }, placed);
      const resumed = await runJobs(stores, {
        ...opts, now: at("2026-10-07", 9),
      });

      assert.deepEqual(resumed.reminded, [{ id: "A", stage: "nextDay" }]);
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
    assert.match(report[0].text,
      /\nA\s+Pat Example\s+Wednesday, October 7, morning\s+unpaid\s+/);
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
    await markPaid(stores, "A", { ...opts, now: placed });
    sent.length = 0;

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

      // Order B has no fulfilment, so its cutoff cannot be computed and
      // its work throws; A must still be abandoned.
      const broken = { ...order("B"), fulfilment: null };

      await saveOrder(stores, order("A"), placed);
      await saveOrder(stores, broken, placed);
      const r = await runJobs(stores, {
        ...opts, env, fetchImpl, now: at("2026-10-07", 12, 1),
      });

      assert.deepEqual(r.abandoned, ["A"]);
      assert.ok(r.errors.some((e) => e.id === "B" && e.step === "order"),
        JSON.stringify(r.errors));
      assert.equal((await getOrder(stores, "A")).status, "abandoned");

      const alerts = sent.filter((m) => /Site alert/.test(m.subject));

      assert.ok(alerts.some((m) => m.subject === "Site alert: jobs.errors"));
      assert.deepEqual(pings.filter((p) => /hc\/jobs/.test(p.url)),
        [{ url: "https://hc/jobs/fail", method: "POST" }]);
      assert.ok(r.invariants.some((v) => v.rule === "order.unreadable"
        && v.id === "B"), "the invariants name it too, and carry on");

      const runs = await runsSince(stores, at("2026-10-07", 0));

      assert.equal(runs.length, 1);
      assert.equal(runs[0].counts.abandoned, 1);
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

  const withEmail = (o) => ({ ...o, emails: { completeYourOrder: {} } });

  it("invariants are quiet for a healthy set of orders", () => {
    const fresh = withEmail(order("A"));

    assert.deepEqual(checkInvariants([fresh], at("2026-10-05", 9, 30)), []);
    assert.deepEqual(checkInvariants([{ ...fresh, emails: {
      ...fresh.emails, soon: {},
    } }], at("2026-10-05", 11)), []);
  });

  it("invariants name an unpaid order past its cutoff, unless held or " +
    "asked", () => {
    // Cutoff is midnight before the 7th; every reminder already went.
    const o = {
      ...order("A", "onfarm"),
      emails: { completeYourOrder: {}, soon: {}, nextDay: {}, final: {} },
    };
    const late = at("2026-10-07", 0, 31);

    assert.deepEqual(checkInvariants([o], late),
      [{ rule: "unpaid.past_cutoff", id: "A" }]);
    assert.deepEqual(checkInvariants([o], at("2026-10-07", 0, 29)), []);
    assert.deepEqual(checkInvariants([{
      ...o, paymentPending: { at: "x", source: "venmo" },
    }], late), []);
    assert.deepEqual(checkInvariants([{
      ...o, question: { kind: "window", openedAt: "x", answeredAt: null },
    }], late), []);
  });

  it("invariants name a paid order two days past its date, a missing " +
    "pay link, and an overdue reminder", () => {
    const paid = { ...withEmail(order("A", "onfarm")), status: "paid" };

    assert.deepEqual(checkInvariants([paid], at("2026-10-08", 9)), []);
    assert.deepEqual(checkInvariants([paid], at("2026-10-09", 9)),
      [{ rule: "paid.not_closed", id: "A" }]);

    const noLink = order("A");

    assert.deepEqual(checkInvariants([noLink], at("2026-10-05", 9, 19)), []);
    assert.deepEqual(checkInvariants([noLink], at("2026-10-05", 9, 21)),
      [{ rule: "order.no_pay_link", id: "A" }]);

    const quiet = withEmail(order("A"));

    assert.deepEqual(checkInvariants([quiet], at("2026-10-05", 10, 29)), []);
    assert.deepEqual(checkInvariants([quiet], at("2026-10-05", 10, 31)),
      [{ rule: "reminder.overdue", id: "A" }]);
    const prefs = new Map([["pat@example.com", { payment: false }]]);

    assert.deepEqual(checkInvariants([quiet], at("2026-10-05", 10, 31), prefs),
      [], "not when the customer turned reminders off");
  });

  it("reports the Venmo payments it could not apply, once an evening",
    async () => {
      const stores = testStores();
      const { sent, opts } = harness();
      const env = { ADMIN_EMAILS: "farm@x.com" };
      const payment = (transactionId, note, cents = 4500) => ({
        payer: "Pat Example", cents, note, transactionId,
      });

      await applyPayment(stores, payment("1", "Test7"), { ...opts, env });
      await applyPayment(stores, payment("2", "eggs"), { ...opts, env });

      const noon = await runJobs(stores, {
        ...opts, env, now: at("2026-10-05", 12),
      });
      const evening = await runJobs(stores, {
        ...opts, env, now: at("2026-10-05", 18),
      });
      const later = await runJobs(stores, {
        ...opts, env, now: at("2026-10-05", 18, 15),
      });

      assert.deepEqual(noon.venmoReported, []);
      assert.deepEqual([...evening.venmoReported].sort(), ["1", "2"]);
      assert.deepEqual(later.venmoReported, []);

      const report = sent.filter((m) => /Venmo payments/.test(m.subject));

      assert.equal(report.length, 1);
      assert.equal(report[0].subject,
        "Venmo payments with no order: Monday, October 5");
      assert.match(report[0].text, /\$45\s+Pat Example\s+Test7\n/);
      assert.deepEqual(await unreportedPayments(stores), []);

      // Tomorrow, only what arrived since.
      await applyPayment(stores, payment("3", "milk"), {
        ...opts, env, now: at("2026-10-06", 9),
      });
      const next = await runJobs(stores, {
        ...opts, env, now: at("2026-10-06", 18),
      });

      assert.deepEqual(next.venmoReported, ["3"]);
      assert.equal(sent.filter((m) => /Venmo payments/.test(m.subject)).length,
        2);
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
