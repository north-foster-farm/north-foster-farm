// Moving a week's delivery day (#640): the criteria that hold today
// and must go on holding once the schedule can move a week. Written
// before the change, from the issue's spec and "Done when"; one test
// per criterion, named for it. The contract and the criteria that
// fail until the change are in test/delivery-moved.criteria.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allDates, deliveryDates,
} from "../assets/scripts/order/lib/dates.mjs";
import { publicOrder } from "../netlify/functions/lib/account.mjs";
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import { pickupSchedule } from "../netlify/functions/lib/pickups.mjs";
import { getOrder } from "../netlify/functions/lib/records.mjs";
import {
  movedDelivery,
} from "../netlify/functions/lib/templates.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import {
  BASE, DECEMBER, SKU, WINDOW, edit, ny, outbox, placed, words,
} from "./delivery-moved-setup.mjs";

// Clock time in New York -> the delivery days offered, each with its
// label and cutoff, as the site offers them today. Noon Eastern is
// 17:00 UTC all through these weeks.
const TODAY = [
  ["Monday 16 Nov, 9:00", ny("2026-11-16"), [
    ["2026-11-19", "Thursday, November 19", "2026-11-18T17:00:00.000Z"],
    ["2026-12-03", "Thursday, December 3", "2026-12-02T17:00:00.000Z"],
  ]],
  ["Wednesday 18 Nov, 11:59", ny("2026-11-18", 11, 59), [
    ["2026-11-19", "Thursday, November 19", "2026-11-18T17:00:00.000Z"],
    ["2026-12-03", "Thursday, December 3", "2026-12-02T17:00:00.000Z"],
  ]],
  ["Wednesday 18 Nov, 12:00 exactly", ny("2026-11-18", 12), [
    ["2026-11-19", "Thursday, November 19", "2026-11-18T17:00:00.000Z"],
    ["2026-12-03", "Thursday, December 3", "2026-12-02T17:00:00.000Z"],
  ]],
  ["Wednesday 18 Nov, 12:01", ny("2026-11-18", 12, 1), [
    ["2026-12-03", "Thursday, December 3", "2026-12-02T17:00:00.000Z"],
    ["2026-12-10", "Thursday, December 10", "2026-12-09T17:00:00.000Z"],
  ]],
  ["Thursday 19 Nov, 9:00", ny("2026-11-19"), [
    ["2026-12-03", "Thursday, December 3", "2026-12-02T17:00:00.000Z"],
    ["2026-12-10", "Thursday, December 10", "2026-12-09T17:00:00.000Z"],
  ]],
  ["Tuesday 24 Nov, 12:00", ny("2026-11-24", 12), [
    ["2026-12-03", "Thursday, December 3", "2026-12-02T17:00:00.000Z"],
    ["2026-12-10", "Thursday, December 10", "2026-12-09T17:00:00.000Z"],
  ]],
  ["Wednesday 16 Dec, 13:00", ny("2026-12-16", 13), [
    ["2026-12-31", "Thursday, December 31", "2026-12-30T17:00:00.000Z"],
    ["2027-01-07", "Thursday, January 7", "2027-01-06T17:00:00.000Z"],
  ]],
  ["Wednesday 30 Dec, 11:00", ny("2026-12-30", 11), [
    ["2026-12-31", "Thursday, December 31", "2026-12-30T17:00:00.000Z"],
    ["2027-01-07", "Thursday, January 7", "2027-01-06T17:00:00.000Z"],
  ]],
  ["Wednesday 30 Dec, 12:01", ny("2026-12-30", 12, 1), [
    ["2027-01-07", "Thursday, January 7", "2027-01-06T17:00:00.000Z"],
    ["2027-01-14", "Thursday, January 14", "2027-01-13T17:00:00.000Z"],
  ]],
];

const rows = (list) => list.map((d) => [d.date, d.label, d.cutoff]);

describe("with no delivery line in the schedule (#640)", () => {
  it("offers the dates, cutoffs and labels exactly as today", () => {
    const schedule = pickupSchedule({ PICKUP_SCHEDULE: BASE });

    for (const [when, now, want] of TODAY) {
      assert.deepEqual(rows(deliveryDates(now, terms)), want, when);
      assert.deepEqual(rows(allDates(now, terms, schedule).delivery), want,
        `${when}, as /api/dates answers`);
    }
  });

  it("writes every email exactly as today", async () => {
    const now = ny("2026-11-30");
    const { id, sent, stores } = await placed({
      date: "2026-12-03", now, schedule: BASE,
    });
    const order = await getOrder(stores, id);
    const confirmed = sent.find((m) => m.subject === "Your order is " +
      "confirmed");

    assert.ok(confirmed, "the customer's confirmation");
    assert.ok(confirmed.text.includes(
      `Arrives: Thursday, December 3, ${WINDOW}`), confirmed.text);

    const jobs = outbox();

    await runJobs(stores, {
      env: { FARM_NOTIFICATIONS_EMAIL: "farm@x.com", PICKUP_SCHEDULE: BASE },
      mail: jobs.mail, now: ny("2026-12-02", 18, 5),
      realNow: ny("2026-12-02", 18, 5),
    });

    const reminder = jobs.sent.find((m) => m.subject === "Your delivery is " +
      "tomorrow");

    assert.ok(reminder, "the reminder, at 18:00 the evening before");
    assert.match(reminder.text,
      /Your order will arrive between 10:00 AM and 4:00 PM\./);
    assert.match(reminder.text, /Arrives: Thursday, December 3, between/);

    const moved = movedDelivery({
      ...order,
      fulfilment: { ...order.fulfilment, date: "2026-12-10" },
      attempted: { date: "2026-12-03", cause: "farm",
        at: ny("2026-12-03", 15).toISOString() },
    }, { now: ny("2026-12-03", 16) });

    assert.equal(moved.subject, "Your delivery has moved to next Thursday");
    assert.match(words(moved),
      /moved your delivery to next Thursday, December 10\./);
  });
});

describe("an order already placed for a Thursday the schedule moves",
  () => {
    it("is untouched: it displays, edits and is reminded as before",
      async () => {
        // Placed for Thursday December 10 before the move was set.
        const { id, stores } = await placed({
          date: "2026-12-10", now: ny("2026-12-01"), schedule: BASE,
        });
        // The farm then moves that week to Wednesday the 9th.
        const now = ny("2026-12-03");
        const shown = publicOrder(await getOrder(stores, id), now);

        assert.equal(shown.fulfilment.method, "delivery");
        assert.equal(shown.fulfilment.date, "2026-12-10");

        const { result } = await edit(stores, id, {
          idempotencyKey: "edit-key-000000-640",
          lines: [{ sku: SKU, qty: 3 }],
          payment: { method: "card", sourceId: "cnon:tok" },
        }, { now, schedule: DECEMBER });

        assert.equal(result.ok, true, JSON.stringify(result.errors));

        const saved = await getOrder(stores, id);

        assert.equal(saved.fulfilment.date, "2026-12-10",
          "the schedule never changes a placed order's date");
        assert.equal(saved.lines.find((l) => l.sku === SKU).qty, 3);

        const jobs = outbox();
        const evening = ny("2026-12-09", 18, 5);

        await runJobs(stores, {
          env: { FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
            PICKUP_SCHEDULE: DECEMBER },
          mail: jobs.mail, now: evening, realNow: evening,
        });

        assert.ok(jobs.sent.some((m) => m.idempotencyKey ===
          `${id}-deliveryReminder-2026-12-10`),
        "reminded the evening before its own day");
        assert.equal((await getOrder(stores, id)).fulfilment.date,
          "2026-12-10");
      });
  });
