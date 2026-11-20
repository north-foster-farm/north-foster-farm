// Criteria tests for #697 (a quieter farm inbox: no empty summary
// emails), box 1 of its spec only: the 6 PM "Tomorrow" email does not
// go on a day with no orders due tomorrow, and goes as today on any
// other day. One test per "Done when" box, named for it. Written
// 2026-11-20 from the criteria alone, before any code.
//
// Held out of `npm test` by its name until the change lands; the
// implementer turns it on with
//
//   git mv test/quiet-tomorrow.criteria.mjs test/quiet-tomorrow.test.mjs
//
// Each test drives the real 15-minute jobs run with a pinned clock
// and captures the mail, as test/jobs.test.mjs does.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import { saveOrder } from "../netlify/functions/lib/records.mjs";
import { mailLinks } from "../netlify/functions/lib/site.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { farmTomorrow } from "../netlify/functions/lib/templates.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const ENV = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
};

const TZ = "America/New_York";
const at = (iso, h, m = 0) => instant(iso, h, m, TZ);

// Placed and paid Monday 5 October 2026 at 09:00 ET. The runs are on
// Tuesday the 6th, so "tomorrow" is Wednesday the 7th.
const placed = at("2026-10-05", 9);
const TODAY = "2026-10-06";
const TOMORROW = "2026-10-07";

const order = (id, method, date) => ({
  id,
  status: "paid",
  submittedAt: placed.toISOString(),
  paidAt: placed.toISOString(),
  customer: { name: "Pat Example", email: "pat@example.com", phone: "" },
  lines: [{ sku: "A", label: "Eggs (per dozen), Large", qty: 1, lineTotal: 7 }],
  totals: { subtotal: 700, discountAmount: 0, deliveryFee: 500, total: 1200 },
  fulfilment: {
    method,
    date,
    state: "agreed",
    onfarm: method === "onfarm" ? { window: "morning" } : null,
    delivery: method === "delivery" ? {
      address1: "1 Main St", town: "Foster", zip: "02825", cooler: "Porch",
    } : null,
  },
  square: { squareOrderId: "SQO", customerId: "CUST" },
  emails: {
    orderConfirmed: { at: placed.toISOString() },
    farmOrderPlaced: { at: placed.toISOString() },
  },
  payment: {
    via: "square", method: "card", at: placed.toISOString(),
    squarePaymentId: `PAY-${id}`, receiptUrl: "https://sq/receipt",
    brand: "VISA", last4: "4242",
  },
});

// Every 15-minute run of `day`, 00:00 through 23:45 -> the mail sent.
const runDay = async (stores, day = TODAY) => {
  const sent = [];
  const mail = async (m) => {
    sent.push(m);

    return { id: `m${sent.length}`, driver: "test" };
  };

  for (let q = 0; q !== 96; q += 1) {
    const now = at(day, Math.floor(q / 4), (q % 4) * 15);

    await runJobs(stores, { env: ENV, mail, now, realNow: now });
  }

  return sent;
};

const isTomorrow = (m) => /^Tomorrow, /.test(m.subject);
const summary = (m) => ({ to: [m.to].flat(), subject: m.subject });

describe("#697: no empty Tomorrow email", () => {
  it("on a day with no orders due tomorrow, the 6 PM run sends no " +
    "\"Tomorrow\" email; with one or more, it sends the same email " +
    "as today", async () => {
    // No orders at all.
    const empty = await runDay(testStores());

    assert.deepEqual(empty.filter(isTomorrow).map((m) => m.subject), [],
      "no Tomorrow email when nothing is due tomorrow");

    // Orders, none of them due tomorrow: one due today, one the day
    // after tomorrow.
    const elsewhere = testStores();

    await saveOrder(elsewhere, order("C", "onfarm", TODAY), placed);
    await saveOrder(elsewhere, order("D", "delivery", "2026-10-08"), placed);
    assert.deepEqual((await runDay(elsewhere)).filter(isTomorrow)
      .map((m) => m.subject), [],
    "no Tomorrow email when orders exist but none is due tomorrow");

    // Two due tomorrow, one not: the email goes once, at 18:00, as the
    // template makes it today.
    const stores = testStores();
    const due = [
      order("A", "delivery", TOMORROW),
      order("B", "onfarm", TOMORROW),
    ];

    for (const o of due) await saveOrder(stores, o, placed);
    await saveOrder(stores, order("E", "delivery", "2026-10-08"), placed);

    const sent = await runDay(stores);
    const manifest = sent.filter(isTomorrow);

    assert.equal(manifest.length, 1, "one Tomorrow email");

    const expected = farmTomorrow(due, {
      date: TOMORROW, links: mailLinks(ENV),
    });
    const [m] = manifest;

    assert.deepEqual([m.to].flat(), ["farm@x.com"]);
    assert.equal(m.idempotencyKey, `report/tomorrow/${TODAY}`);
    assert.equal(m.subject, "Tomorrow, Wednesday, October 7: 2 orders");
    assert.equal(m.subject, expected.subject);
    assert.equal(m.text, expected.text);
    assert.equal(m.html, expected.html);
    assert.doesNotMatch(m.text, /^E,/m, "E is Thursday");

    // Sent at 18:00, not before: the 17:45 run had not sent it.
    const before = testStores();

    for (const o of due) await saveOrder(before, o, placed);
    const early = [];

    for (const [h, min] of [[17, 45], [18, 0]]) {
      await runJobs(before, {
        env: ENV, now: at(TODAY, h, min), realNow: at(TODAY, h, min),
        mail: async (x) => {
          early.push({ x, h });

          return { id: `m${early.length}`, driver: "test" };
        },
      });
    }
    assert.deepEqual(early.filter(({ x }) => isTomorrow(x))
      .map(({ h }) => h), [18], "sent by the 18:00 run");
  });

  it("nothing else the jobs run sends changes", async () => {
    // A day with nothing due tomorrow: everything but the Tomorrow
    // email, as next sent it on 2026-11-20 (8e7eccae).
    const empty = await runDay(testStores());

    assert.deepEqual(empty.filter((m) => !isTomorrow(m)).map(summary), [
      { to: ["farm@x.com"], subject: "Morning report: Tuesday, October 6" },
      { to: ["farm@x.com"],
        subject: "No packing slips for Wednesday 10/7" },
    ]);

    // A day with orders due tomorrow and after: the same.
    const stores = testStores();

    await saveOrder(stores, order("A", "delivery", TOMORROW), placed);
    await saveOrder(stores, order("B", "onfarm", TOMORROW), placed);
    await saveOrder(stores, order("E", "delivery", "2026-10-08"), placed);

    const busy = await runDay(stores);

    assert.deepEqual(busy.filter((m) => !isTomorrow(m)).map(summary),
      BUSY_DAY);
  });
});

// Everything but the Tomorrow email on the busy day, as next sent it
// on 2026-11-20 (8e7eccae).
const BUSY_DAY = [
  { to: ["farm@x.com"], subject: "Morning report: Tuesday, October 6" },
  { to: ["farm@x.com"],
    subject: "Delivery packing slips for Wednesday 10/7" },
  { to: ["farm@x.com"],
    subject: "On-farm pickup packing slips for Wednesday 10/7" },
  { to: ["pat@example.com"], subject: "Your delivery is tomorrow" },
];
