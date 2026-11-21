// Criteria tests for #697 (a quieter farm inbox: no empty summary
// emails), item 3 of its spec only: the 8 AM morning report goes only
// when something is outside its healthy limits or waits on the farm.
// One test per open "Done when" box, named for it. Written 2026-11-21
// from the criteria alone, before any code.
//
// Held out of `npm test` by its name until the change lands; the
// implementer turns it on with
//
//   git mv test/quiet-morning.criteria.mjs test/quiet-morning.test.mjs
//
// Each test drives the real 15-minute jobs run with a pinned clock and
// captures the mail, as test/quiet-tomorrow.test.mjs does. A calm
// morning needs a full day of runs behind it: fewer than 90 in the
// last 24 hours is itself outside the limits, so a case runs from 8:00
// on Monday 5 October 2026 and is judged by Tuesday's 8:00 run (the
// too-few-runs case starts Tuesday instead, and a dated reminder runs
// on its own day).
//
// Not covered here: the alert channel's Healthchecks ping, which today
// rides on the report going out. That is a ping, not an email, and is
// the implementer's to settle with the coordinator.
//
// The vital signs and their limits are the morning report's own
// (VITALS in lib/templates.mjs): payments declined 3 or fewer, no
// email that could not be sent, 90 or more jobs runs, no jobs errors,
// no invariant violations. What waits on the farm is the spec's list:
// pickups to confirm, a short schedule, reminders, archived items, an
// open Square order (and the customer profiles the same sweep finds),
// unanswered messages.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listMessages } from "../netlify/functions/lib/admin.mjs";
import { funnel, pickupsDue, runJobs } from "../netlify/functions/lib/jobs.mjs";
import { openOrders, saveOrder } from "../netlify/functions/lib/records.mjs";
import {
  LEAD_DAYS, remindersOn,
} from "../netlify/functions/lib/reminders.mjs";
import terms from "../data/delivery.json" with { type: "json" };
import { mailLinks } from "../netlify/functions/lib/site.mjs";
import { deletionsPaused } from "../netlify/functions/lib/square-pause.mjs";
import { archivedOnHand, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import {
  farmMorningReport,
} from "../netlify/functions/lib/templates.mjs";
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import {
  coverUntil, parseSchedule,
} from "../assets/scripts/order/lib/schedule.mjs";
import { addDays, instant } from "../assets/scripts/order/lib/zoned.mjs";
import { scheduleFor } from "../bin/dev-schedule.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const TZ = "America/New_York";
const at = (iso, h, m = 0) => instant(iso, h, m, TZ);

const ENV = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
  PICKUP_SCHEDULE: SCHEDULE,
};

// Placed and paid Monday 5 October 2026 at 07:00 ET. The day judged is
// Tuesday the 6th; its 8:00 run looks back to Monday's 8:00.
const placed = at("2026-10-05", 7);
const MONDAY = "2026-10-05";
const TUESDAY = "2026-10-06";

const order = (id, method, date, extra = {}) => ({
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
  ...extra,
});

// A paid on-farm pickup two weeks out: an order on the books that asks
// nothing of the farm this morning.
const settled = (day = TUESDAY) =>
  order("QUIET", "onfarm", addDays(day, 14));

// One archived product, flagged in stock, as test/restock.test.mjs
// makes it.
const ARCHIVED_CATALOG = indexCatalog({
  groups: [{
    key: "cuts", label: "Cuts",
    items: [
      { sku: "ARCHIVED", label: "archived", price: 10, inStock: true,
        restock: "archived" },
      { sku: "PLAIN", label: "plain", price: 10, inStock: true },
    ],
  }],
});

// The runs from `from` (inclusive) to `to` (exclusive), every 15
// minutes, each with its own now. -> the mail sent, each with the run's
// time.
const runs = async (stores, from, to, {
  env = ENV, mail: wrap, catalogIndex,
} = {}) => {
  const sent = [];

  for (let t = from.getTime(); t < to.getTime(); t += 15 * 60_000) {
    const now = new Date(t);
    const mail = async (m) => {
      if (wrap) await wrap(m, now);
      sent.push({ ...m, ranAt: now });

      return { id: `m${sent.length}`, driver: "test" };
    };

    await runJobs(stores, {
      env, mail, now, realNow: now,
      ...(catalogIndex ? { catalogIndex } : {}),
    });
  }

  return sent;
};

// The report's mark for a vital sign outside its limits.
const BAD = "\u{1F648}";
const isMorning = (m) => /^Morning report: /.test(m.subject);
const tuesdayReport = (m) => m.subject === "Morning report: Tuesday, " +
  "October 6";

// What the morning report would say if it went at `now`: its inputs
// read from the records exactly as the 8:00 run reads them, and the
// template as it stands today.
const expectedReport = async (stores, now, {
  env = ENV, catalogIndex, day = TUESDAY,
} = {}) => {
  const { windows } = parseSchedule(env.PICKUP_SCHEDULE);
  const open = await stores.jobs.get(`square/open/${day}`);
  const profiles = await stores.jobs.get(`square/profiles/${day}`);

  return farmMorningReport(
    await funnel(stores, now),
    pickupsDue(await openOrders(stores), day),
    {
      date: day,
      links: mailLinks(env),
      now,
      schedule: {
        last: windows.length ? windows[windows.length - 1].date : null,
        until: coverUntil(now, TZ),
      },
      archived: await archivedOnHand(stores, {
        env, ...(catalogIndex ? { catalogIndex } : {}),
      }),
      messages: await listMessages(stores),
      square: {
        open: (open && open.count) || 0,
        cancelled: (open && open.done) || 0,
        profiles: (profiles && profiles.count) || 0,
        deleted: (profiles && profiles.done) || 0,
        paused: await deletionsPaused(stores, env),
      },
      reminders: remindersOn(day),
    }
  );
};

// One case: the stores set up by `arrange`, the day before `day` from
// 8:00 and `day` through 7:45, then `day`'s 8:00 run and the rest of
// it. `day` is Tuesday unless a case needs its own calendar. -> {
// tuesday: the morning reports `day`'s runs sent, expected: the report
// as today's template makes it from the records just before 8:00 }.
const morningOf = async ({
  arrange = async () => {}, env = ENV, catalogIndex, day = TUESDAY,
  from = at(addDays(day, -1), 8), mail,
} = {}) => {
  const stores = testStores();

  await saveOrder(stores, settled(), placed);
  await arrange(stores);
  await runs(stores, from, at(day, 8), { env, catalogIndex, mail });

  const eight = at(day, 8);
  const expected = await expectedReport(stores, eight, {
    env, catalogIndex, day,
  });
  const sent = await runs(stores, eight, at(addDays(day, 1), 0), {
    env, catalogIndex,
  });

  return { stores, tuesday: sent.filter(isMorning), expected, day };
};

// The report goes once, from the 8:00 run, and is the same report as
// today's code sends: the same recipient, key, subject and body.
const assertSameReport = ({ tuesday, expected, day }, why, shows) => {
  // The case is the one named: the report today's template makes
  // shows that sign or that section.
  assert.match(expected.text, shows, `${why}: the report shows it`);
  assert.equal(tuesday.length, 1, `${why}: one morning report`);

  const [m] = tuesday;

  if (day === TUESDAY) assert.ok(tuesdayReport(m), `${why}: Tuesday's`);
  assert.equal(m.ranAt.getTime(), at(day, 8).getTime(),
    `${why}: sent by the 8:00 run`);
  assert.deepEqual([m.to].flat(), ["farm@x.com"], why);
  assert.equal(m.idempotencyKey, `report/morning/${day}`, why);
  assert.equal(m.subject, expected.subject, why);
  assert.equal(m.text, expected.text, why);
  assert.equal(m.html, expected.html, why);
};

describe("#697: no empty morning report", () => {
  it("on a day when every vital sign is within its healthy limits and " +
    "nothing waits on the farm, the 8 AM run sends no morning report; " +
    "when anything is outside its limits or waits on the farm, it sends " +
    "the same report as today", async () => {
    // The calm morning. First, that the fixture is calm by the
    // report's own measures, so a report here is the one the box
    // forbids and not a fault in the fixture.
    const calm = await morningOf();
    const stats = await funnel(calm.stores, at(TUESDAY, 8));

    assert.ok(stats.declined <= 3, "declined within limits");
    assert.equal(stats.mailFailures, 0, "no mail failures");
    assert.ok(stats.runs >= 90, `90 or more runs (${stats.runs})`);
    assert.equal(stats.jobErrors, 0, "no jobs errors");
    assert.equal(stats.invariants, 0, "no invariant violations");
    for (const section of [
      "Pickup schedule", "Reminders", "Hidden but in stock", "Square sweep",
      "Pickups waiting on the customer", "Messages waiting on an answer",
    ]) {
      assert.ok(!calm.expected.text.includes(section),
        `nothing waits on the farm: no ${section}`);
    }
    assert.doesNotMatch(calm.expected.text, new RegExp(`\\d\\s+${BAD}`),
      "no sign outside limits");

    assert.deepEqual(calm.tuesday.map((m) => m.subject), [],
      "no morning report on a calm day");

    // Each vital sign outside its limits, alone.

    // Too few runs: Tuesday's 8:00 run is the 33rd since midnight,
    // with none on Monday.
    assertSameReport(await morningOf({ from: at(TUESDAY, 0) }),
      "fewer than 90 runs",
      new RegExp(`Jobs runs \\(one every 15 minutes is 96\\)\\s+\\d+\\s+${
        BAD}`));

    // Four declined payments today.
    assertSameReport(await morningOf({
      arrange: (stores) => stores.jobs.set(`health/declined/${TUESDAY}`,
        { n: 4, at: at(TUESDAY, 6).toISOString() }),
    }), "4 payments declined",
    new RegExp(`Payments declined\\s+\\d+\\s+${BAD}`));

    // An email that could not be sent, yesterday.
    assertSameReport(await morningOf({
      arrange: (stores) => stores.jobs.set("health/mail", {
        lastOkAt: at(MONDAY, 9).toISOString(), fails: [],
        days: { [MONDAY]: 1 },
      }),
    }), "an email not sent",
    new RegExp(`Emails that could not be sent\\s+\\d+\\s+${BAD}`));

    // A jobs error: Monday's 8:00 morning report fails once to send,
    // and the 8:15 run sends it.
    let failed = false;

    assertSameReport(await morningOf({
      mail: async (m) => {
        if (!failed && isMorning(m)) {
          failed = true;
          throw new Error("Resend is down");
        }
      },
    }), "a jobs error",
    new RegExp(`Jobs errors\\s+\\d+\\s+${BAD}`));
    assert.ok(failed, "the jobs error happened");

    // An invariant violation: a paid order with no Square copy, past
    // the grace for one (square.missing).
    assertSameReport(await morningOf({
      arrange: (stores) => saveOrder(stores, order("NOSQUARE", "onfarm",
        "2026-10-21", { square: null }), placed),
    }), "an invariant violation",
    new RegExp(`Invariant violations\\s+\\d+\\s+${BAD}`));

    // Each thing that waits on the farm, alone.

    // A pickup the farm gave up, within two days, the customer yet to
    // choose another time.
    assertSameReport(await morningOf({
      arrange: (stores) => saveOrder(stores, order("WAIT", "onfarm",
        "2026-10-07", {
          question: {
            kind: "window", reason: "Frost.",
            openedAt: placed.toISOString(), answeredAt: null, answer: null,
            by: null,
          },
        }), placed),
    }), "a pickup to confirm",
    /Pickups waiting on the customer/);

    // A pickup schedule that runs short.
    assertSameReport(await morningOf({
      env: { ...ENV, PICKUP_SCHEDULE: scheduleFor("2026-10-01",
        "2026-10-09") },
    }), "a short schedule",
    /Pickup schedule/);

    // An archived product that stock shows on hand.
    assertSameReport(await morningOf({
      catalogIndex: ARCHIVED_CATALOG,
      arrange: (stores) => setCount(stores, "ARCHIVED", 4),
    }), "an archived item in stock",
    /Hidden but in stock/);

    // A Square order a failed payment left open, found by today's
    // sweep.
    assertSameReport(await morningOf({
      arrange: (stores) => stores.jobs.set(`square/open/${TUESDAY}`, {
        at: at(TUESDAY, 7).toISOString(), count: 1, done: 0,
      }),
    }), "an open Square order",
    /Square sweep: open orders/);

    // A Square customer profile a failed checkout made, found by the
    // same sweep.
    assertSameReport(await morningOf({
      arrange: (stores) => stores.jobs.set(`square/profiles/${TUESDAY}`, {
        at: at(TUESDAY, 7).toISOString(), count: 1, done: 0,
      }),
    }), "a Square customer profile",
    /Square sweep: customer profiles/);

    // A message not yet marked answered.
    assertSameReport(await morningOf({
      arrange: (stores) => stores.customers.set("messages/m1", {
        id: "m1", at: at(MONDAY, 12).toISOString(), name: "Sam Okafor",
        email: "sam@example.com", orderId: "", order: null,
        message: "Duck eggs?", status: "open",
      }),
    }), "an unanswered message",
    /Messages waiting on an answer/);

    // A dated reminder (lib/reminders.mjs, from data/delivery.json's
    // money.changes): its own calendar, the first day the first change's
    // reminder shows, with a schedule that reaches far enough then.
    const [change] = terms.money.changes || [];

    if (change) {
      const day = addDays(change.from, -LEAD_DAYS);

      assert.notDeepEqual(remindersOn(day), [], "a reminder shows");
      assertSameReport(await morningOf({
        day,
        env: { ...ENV, PICKUP_SCHEDULE: scheduleFor(addDays(day, -30),
          addDays(day, 60)) },
      }), "a dated reminder",
      /Reminders/);
    }
  });

  it("nothing else the jobs run sends changes", async () => {
    // The calm morning and a busy one: everything but the morning
    // report, as next sent it on 2026-11-21 (8759c761), across Monday
    // from 8:00 and all of Tuesday.
    const day = async ({ arrange = async () => {} } = {}) => {
      const stores = testStores();

      await saveOrder(stores, settled(), placed);
      await arrange(stores);

      return (await runs(stores, at(MONDAY, 8), at("2026-10-07", 0)))
        .filter((m) => !isMorning(m))
        .map((m) => ({ to: [m.to].flat(), subject: m.subject }));
    };
    const bySubject = (a, b) => a.subject.localeCompare(b.subject)
      || a.to.join().localeCompare(b.to.join());

    assert.deepEqual(await day(), [], "a calm day sends nothing else");

    // Busy: a delivery and a pickup due Wednesday, a delivery due
    // Thursday, and a message waiting.
    const busy = await day({
      arrange: async (stores) => {
        await saveOrder(stores, order("A", "delivery", "2026-10-07"), placed);
        await saveOrder(stores, order("B", "onfarm", "2026-10-07"), placed);
        await saveOrder(stores, order("E", "delivery", "2026-10-08"), placed);
        await stores.customers.set("messages/m1", {
          id: "m1", at: at(MONDAY, 12).toISOString(), name: "Sam Okafor",
          email: "sam@example.com", orderId: "", order: null,
          message: "Duck eggs?", status: "open",
        });
      },
    });

    assert.deepEqual(busy.sort(bySubject), [...BUSY].sort(bySubject));
  });
});

// Everything but the morning report on the busy case, as next sent it
// on 2026-11-21 (8759c761). The order the emails go in is no part of
// the spec, so it is not compared.
const BUSY = [
  { to: ["farm@x.com"],
    subject: "Packing slips: deliveries for Wednesday, 10/7" },
  { to: ["farm@x.com"],
    subject: "Packing slips: on-farm pickups for Wednesday, 10/7" },
  { to: ["farm@x.com"], subject: "Tomorrow, Wednesday, October 7: 2 orders" },
  { to: ["pat@example.com"], subject: "Your delivery is tomorrow" },
];
