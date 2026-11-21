// The implementer's own test for #697 item 3 (2026-11-21), beside the
// criteria tests in test/quiet-morning.test.mjs, which cover the email
// and leave the ping alone: the 8:00 run pings the alert channel's
// Healthchecks check well once a morning, whether the morning report
// went or the morning was calm and nothing did. The check's period is
// a day, so a calm morning without the ping would page.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import { saveOrder } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const TZ = "America/New_York";
const at = (iso, h, m = 0) => instant(iso, h, m, TZ);
const ALERT = "https://hc/alert";
const ENV = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  PICKUP_SCHEDULE: SCHEDULE,
  HEALTHCHECKS_ALERT_URL: ALERT,
};
const placed = at("2026-10-05", 7);

// A paid on-farm pickup two weeks out, which asks nothing of the farm.
const settled = {
  id: "QUIET",
  status: "paid",
  submittedAt: placed.toISOString(),
  paidAt: placed.toISOString(),
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [{ sku: "A", label: "Eggs (per dozen), Large", qty: 1, lineTotal: 7 }],
  totals: { subtotal: 700, discountAmount: 0, deliveryFee: 0, total: 700 },
  fulfilment: {
    method: "onfarm", date: "2026-10-20", state: "agreed",
    onfarm: { window: "morning" }, delivery: null,
  },
  square: { squareOrderId: "SQO", customerId: "CUST" },
  emails: {
    orderConfirmed: { at: placed.toISOString() },
    farmOrderPlaced: { at: placed.toISOString() },
  },
  payment: {
    via: "square", method: "card", at: placed.toISOString(),
    squarePaymentId: "PAY-QUIET", receiptUrl: "https://sq/receipt",
    brand: "VISA", last4: "4242",
  },
};

// Every 15-minute run from `from` (inclusive) to `to` (exclusive). ->
// { reports: the morning reports sent, pings: each request to the
// alert check }, both with the run's time. `failing(now)` true makes
// that run's morning report fail to send.
const runs = async (stores, from, to, { failing = () => false } = {}) => {
  const reports = [];
  const pings = [];

  for (let t = from.getTime(); t < to.getTime(); t += 15 * 60_000) {
    const now = new Date(t);

    await runJobs(stores, {
      env: ENV, now, realNow: now,
      mail: async (m) => {
        if (/^Morning report: /.test(m.subject)) {
          if (failing(now)) throw new Error("Resend is down");
          reports.push(now);
        }

        return { id: "m", driver: "test" };
      },
      fetchImpl: async (url, init = {}) => {
        if (url.startsWith(ALERT)) {
          pings.push({ url, method: init.method || "GET", at: now });
        }

        return { ok: true };
      },
    });
  }

  return { reports, pings };
};

const well = (when) => [{ url: ALERT, method: "GET", at: when }];

describe("#697: the 8:00 run's ping to the alert check", () => {
  it("pings well once on a calm morning that sends no report", async () => {
    const stores = testStores();

    await saveOrder(stores, settled, placed);
    // Monday from 8:00, so Tuesday's 8:00 run has a full day behind it.
    await runs(stores, at("2026-10-05", 8), at("2026-10-06", 8));

    const tuesday = await runs(stores, at("2026-10-06", 8),
      at("2026-10-07", 0));

    assert.deepEqual(tuesday.reports, [], "a calm morning: no report");
    assert.deepEqual(tuesday.pings, well(at("2026-10-06", 8)),
      "one ping, well, from the 8:00 run");
  });

  it("pings well once on a morning whose report goes", async () => {
    const stores = testStores();

    await saveOrder(stores, settled, placed);

    // A store's first morning: far fewer than 90 runs in the last day.
    const monday = await runs(stores, at("2026-10-05", 7, 45),
      at("2026-10-05", 12));

    assert.deepEqual(monday.reports, [at("2026-10-05", 8)],
      "the report goes at 8:00");
    assert.deepEqual(monday.pings, well(at("2026-10-05", 8)),
      "one ping, well, from the 8:00 run");
  });

  it("does not ping for a report that failed to send, and pings once " +
    "when the next run sends it", async () => {
    const stores = testStores();
    const eight = at("2026-10-05", 8);
    const next = at("2026-10-05", 8, 15);

    await saveOrder(stores, settled, placed);

    // The 8:00 send throws. The run's error raises an alert, which
    // posts to the check's /fail and then pings it well to re-arm it
    // (`alert` in lib/health.mjs). Those two are the alert's; the
    // morning's own ping would be one more, and there is none.
    const failed = await runs(stores, eight, next, {
      failing: (now) => now.getTime() === eight.getTime(),
    });

    assert.deepEqual(failed.reports, [], "the 8:00 report did not go");
    assert.deepEqual(failed.pings, [
      { url: `${ALERT}/fail`, method: "POST", at: eight },
      { url: ALERT, method: "GET", at: eight },
    ], "only the alert's pair, no ping of the morning's own");

    // 8:15 sends it and pings well, once, and no run after does.
    const later = await runs(stores, next, at("2026-10-05", 12));

    assert.deepEqual(later.reports, [next], "the 8:15 run sends it");
    assert.deepEqual(later.pings, well(next),
      "one ping, well, from the run that sent it");
  });
});
