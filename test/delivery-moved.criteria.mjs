// Moving a week's delivery day from the schedule (#640): the criteria
// tests that fail until the change. Written before the change, from
// the issue's spec and "Done when" alone; one test per criterion,
// named for it. Held out of `npm test` by its name; the change that
// meets #640 turns it on with
//
//   git mv test/delivery-moved.criteria.mjs test/delivery-moved.test.mjs
//
// The criteria that hold today are in test/delivery-default.test.mjs;
// the order page's list and notice in e2e/delivery-moved.spec.mjs.
//
// THE CONTRACT. Where the issue leaves room, this decides, so the
// implementer does not guess.
//
// 1. The line. `YYYY-MM-DD delivery` is an entry of PICKUP_SCHEDULE
//    like any other (new lines, commas or semicolons between entries;
//    comments allowed), and nothing follows the word: the window is
//    `delivery.window`, never the line's. It means that date is the
//    delivery day of its week, Monday to Sunday, in place of the
//    week's Thursday (`delivery.weekday`), even when that Thursday is
//    a holiday. Its cutoff is `cutoffFor(date, terms)`, noon the day
//    before, as for a Thursday; the cutoff stays inclusive (an order
//    at 12:00:00 makes it, as "Wednesday 12:00:00 exactly still makes
//    it" in test/dates.test.mjs has it), so the 25th is offered at
//    11:59 and gone at 12:01 on Tuesday the 24th.
//
// 2. The parser. `parseSchedule(raw)` returns
//    `{ windows, lines, deliveries, errors }`. `deliveries` is a list
//    sorted by date, one `{ date }` per delivery line (more fields
//    are allowed; the tests read `date` only). Its errors, each naming
//    the date: a malformed delivery line (anything after the word,
//    or a date that doesn't exist), and two delivery lines in one
//    week (naming both dates). A delivery line on a listed holiday is
//    refused by `checkSchedule(raw, { now, timeZone, model, holidays
//    })`, whose new `holidays` option is `terms.holidays`; bin/check-
//    schedule.mjs and bin/nff pass it. Its result carries
//    `deliveries` too. The parser does not know the holidays, so the
//    check, which every deploy and `bin/nff schedule` run, refuses
//    it.
//
// 3. The schedule the functions read. `pickupSchedule(env)` puts
//    `deliveries` on the array, as it puts `lines`, so every caller
//    that passes the schedule along carries the moves. A schedule
//    without `deliveries` (an older caller, a test) moves nothing.
//
// 4. The dates. `deliveryDates(now, terms, count, schedule)` takes
//    the schedule as a new fourth argument (not a field on `terms`:
//    the schedule already rides through `allDates` and `datesFor` to
//    every server check, and `terms` is the build's data, not the
//    farm's weekly word). `allDates` passes it. Each entry is as
//    today, `{ date, label, cutoff }`; a moved day's label is the
//    zone label, "Wednesday, November 25". One rule decides a day:
//    `isDeliveryDay(iso, terms, schedule)`, exported from
//    lib/dates.mjs, true when the date is its week's delivery line,
//    or, in a week without one, its Thursday and not a holiday.
//
// 5. The page computes no list: the order page and the account take
//    theirs from /api/dates. But the order page checks a payload
//    itself (order-form.js `check`, validateOrder) against
//    `DateLists.schedule()`, which rebuilds a schedule from
//    /api/dates. That is where the page would otherwise need the
//    moves: `schedule()` adds `deliveries`, one `{ date }` for each
//    date in /api/dates' `delivery` list. /api/dates gains no field.
//
// 6. The server's readers that hold no schedule read it as the
//    functions do, `pickupSchedule()` from process.env, so their
//    signatures stay: admin.mjs `nextDeliveryDay(date)` and the
//    emails that name a next delivery day (`missedDelivery`,
//    `movedDelivery`). These tests set process.env.PICKUP_SCHEDULE.
//
// 7. bin/nff. `checkedSchedule(text, { now, terms })` moves from
//    bin/nff into bin/schedule-env.mjs and is exported; it takes the
//    file's text, returns `{ value, summary }` as today, keeps every
//    delivery line in `value`, and both `schedule check` and
//    `schedule set` use it. Its summary, and bin/check-schedule.mjs's,
//    names each moved week: "delivery moved to Wednesday, November
//    25". `paidOnReplaced(orders, deliveries, terms)`, exported from
//    bin/schedule-env.mjs, is what `schedule set` reports from: for
//    each delivery line, in date order, `{ date, replaced, ids }`,
//    `replaced` that week's Thursday and `ids` the paid delivery
//    orders on it, sorted. `schedule set` prints a count for each.
//
// 8. A buying group's round keys on the order's own date: the
//    group's first pickup day on or after it (groups.mjs roundFor),
//    never on the Thursday. So a member's delivery in a moved week
//    falls in the round its Thursday would have, unless a group day
//    falls between the two. Nothing in the rounds changes.
//
// 9. Not covered here: the morning report lists no delivery order
//    (only on-farm pickups awaiting a choice), so it has no delivery
//    date to name; the farm's new-order email names no delivery date
//    at all today, so it is held only to never saying Thursday.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import { devSchedule } from "../bin/dev-schedule.mjs";
// Namespaces, so a seam not yet written fails only the tests that
// use it, not the whole file.
import * as scheduleEnv from "../bin/schedule-env.mjs";
import { DateLists } from "../assets/scripts/order/date-lists.js";
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import * as datesLib from "../assets/scripts/order/lib/dates.mjs";
import {
  checkSchedule, parseSchedule,
} from "../assets/scripts/order/lib/schedule.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import {
  addDays, label, today, weekday,
} from "../assets/scripts/order/lib/zoned.mjs";
import { planChange, publicOrder } from "../netlify/functions/lib/account.mjs";
import { nextDeliveryDay } from "../netlify/functions/lib/admin.mjs";
import { planAmend } from "../netlify/functions/lib/amend.mjs";
import {
  groupOf, roundFor, setGroupCode,
} from "../netlify/functions/lib/groups.mjs";
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import { packetPdf } from "../netlify/functions/lib/packing.mjs";
import { pickupSchedule } from "../netlify/functions/lib/pickups.mjs";
import { getOrder } from "../netlify/functions/lib/records.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import {
  deliveryReminder, missedDelivery, movedDelivery, orderCancelled,
  orderChanged, orderConfirmed,
} from "../netlify/functions/lib/templates.mjs";
import terms from "../netlify/functions/lib/terms.mjs";
import {
  BASE, DECEMBER, EMAIL, THANKSGIVING, WINDOW, envWith, ny, outbox, place,
  placed, withLines, words,
} from "./delivery-moved-setup.mjs";

const { checkedSchedule, paidOnReplaced } = scheduleEnv;
const { allDates, cutoffFor, deliveryDates, isDeliveryDay } = datesLib;
const root = join(import.meta.dirname, "..");
const dates = (list) => list.map((d) => d.date);
// The schedule as the functions read it.
const read = (text) => pickupSchedule({ PICKUP_SCHEDULE: text });
// The week Wednesday the 25th moves: the clock on Thursday the 19th.
const THU_19 = ny("2026-11-19");

// The server's own schedule, process.env.PICKUP_SCHEDULE, for the
// readers that hold none (contract 6), put back after.
const serverSchedule = (text) => {
  let was;

  before(() => {
    was = process.env.PICKUP_SCHEDULE;
    process.env.PICKUP_SCHEDULE = text;
  });
  after(() => {
    process.env.PICKUP_SCHEDULE = was;
  });
};

// A schedule file for the CLIs, removed after. -> its path
const scheduleFile = (text) => {
  const dir = mkdtempSync(join(tmpdir(), "nff-640-"));
  const file = join(dir, "schedule.txt");

  writeFileSync(file, `${text}\n`);
  after(() => rmSync(dir, { recursive: true, force: true }));

  return file;
};

const run = (args) => spawnSync(process.execPath, args.map((a, i) =>
  (i === 0 ? join(root, a) : a)), {
  cwd: root, encoding: "utf8", env: { ...process.env },
});

describe("the schedule's delivery line (contract 1 to 3)", () => {
  it("parses into `deliveries`, which the functions' schedule carries",
    () => {
      const parsed = parseSchedule(withLines("2026-12-09 delivery",
        "2026-11-25 delivery # Thanksgiving"));

      assert.deepEqual(parsed.errors, []);
      assert.deepEqual(dates(parsed.deliveries),
        ["2026-11-25", "2026-12-09"]);
      assert.deepEqual(dates(read(THANKSGIVING).deliveries), ["2026-11-25"]);
      assert.deepEqual(dates(read(BASE).deliveries), []);
    });
});

describe("the schedule check accepts, refuses and summarizes delivery " +
  "lines as the spec says", () => {
  const now = ny("2026-11-18");
  const check = (text) => checkSchedule(text, {
    now, timeZone: terms.timeZone, model: terms.model,
    holidays: terms.holidays,
  });
  const base = devSchedule(now);

  it("accepts a delivery line, one per week, a week Monday to Sunday",
    () => {
      const result = check([base, "2026-11-25 delivery",
        "2026-12-06 delivery", "2026-12-07 delivery"].join("\n"));

      assert.deepEqual(result.errors, []);
      assert.equal(result.ok, true);
      assert.deepEqual(dates(result.deliveries),
        ["2026-11-25", "2026-12-06", "2026-12-07"],
        "Sunday the 6th and Monday the 7th are two weeks");
    });

  it("refuses two delivery lines in one week", () => {
    const result = check([base, "2026-12-08 delivery",
      "2026-12-09 delivery"].join("\n"));

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("2026-12-08")
      && e.includes("2026-12-09")), result.errors.join("\n"));
  });

  it("refuses a delivery line on a listed holiday", () => {
    assert.ok(terms.holidays.includes("2026-12-25"));

    const result = check(`${base}\n2026-12-25 delivery`);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("2026-12-25")
      && /holiday/i.test(e)), result.errors.join("\n"));
  });

  it("refuses a malformed delivery line", () => {
    for (const line of ["2026-11-25 delivery 10:00-16:00",
      "2026-02-30 delivery"]) {
      const result = check(`${base}\n${line}`);

      assert.equal(result.ok, false, line);
      assert.ok(result.errors.some((e) => e.includes(line.slice(0, 10))),
        result.errors.join("\n"));
    }
  });

  // The CLIs run on the real clock, so the moved week is three weeks
  // out from today, in the schedule a fresh clone makes.
  const wednesday = () => {
    let d = addDays(today(new Date(), terms.timeZone), 14);

    while (weekday(d) !== 3 || terms.holidays.includes(d)) d = addDays(d, 1);

    return d;
  };

  it("says in its summary which weeks are moved, in the deploy's check " +
    "and in bin/nff schedule check", () => {
    const moved = wednesday();
    const file = scheduleFile(`${devSchedule()}\n${moved} delivery`);
    const says = `delivery moved to ${label(moved)}`;
    const deploy = run(["bin/check-schedule.mjs", file]);

    assert.equal(deploy.status, 0, deploy.stderr);
    assert.ok(deploy.stdout.includes(says), deploy.stdout);

    const nff = run(["bin/nff", "schedule", "check", file]);

    assert.equal(nff.status, 0, nff.stderr);
    assert.ok(nff.stdout.includes(says), nff.stdout);

    assert.ok(checkedSchedule(`${devSchedule(now)}\n2026-11-25 delivery`,
      { now, terms }).summary.includes(
      "delivery moved to Wednesday, November 25"));
  });

  it("refuses, in the deploy's check, a delivery line on a holiday", () => {
    const file = scheduleFile(`${devSchedule()}\n2026-12-25 delivery`);
    const deploy = run(["bin/check-schedule.mjs", file]);

    assert.equal(deploy.status, 1, deploy.stdout);
    assert.ok(deploy.stderr.includes("2026-12-25"), deploy.stderr);
  });

  it("keeps the delivery line in the value bin/nff schedule set sets",
    () => {
      const { value } = checkedSchedule(
        `${devSchedule(now)}\n2026-11-25 delivery`, { now, terms });

      assert.deepEqual(dates(parseSchedule(value).deliveries),
        ["2026-11-25"]);
      assert.match(readFileSync(join(root, "bin/nff"), "utf8"),
        /checkedSchedule[\s\S]*from "\.\/schedule-env\.mjs"/,
        "bin/nff uses the exported checkedSchedule");
    });
});

describe("with 2026-11-25 delivery and the clock on Thursday " +
  "2026-11-19", () => {
  const schedule = read(THANKSGIVING);

  it("offers Wednesday, November 25 then Thursday, December 3, not the " +
    "26th", () => {
    const got = allDates(THU_19, terms, schedule).delivery;

    assert.deepEqual(dates(got), ["2026-11-25", "2026-12-03"]);
    assert.equal(got[0].label, "Wednesday, November 25");
    assert.equal(got[1].label, "Thursday, December 3");
    assert.deepEqual(dates(deliveryDates(THU_19, terms, 3, schedule)),
      ["2026-11-25", "2026-12-03", "2026-12-10"]);
    assert.equal(isDeliveryDay("2026-11-25", terms, schedule), true);
    assert.equal(isDeliveryDay("2026-11-26", terms, schedule), false);
    assert.equal(isDeliveryDay("2026-12-03", terms, schedule), true);
  });

  it("closes the 25th on Tuesday the 24th at noon", () => {
    const [first] = allDates(THU_19, terms, schedule).delivery;

    assert.equal(first.cutoff, "2026-11-24T17:00:00.000Z");
    assert.equal(cutoffFor("2026-11-25", terms).toISOString(),
      "2026-11-24T17:00:00.000Z");

    const at = (h, m) => dates(deliveryDates(ny("2026-11-24", h, m), terms,
      undefined, schedule));

    assert.deepEqual(at(11, 59), ["2026-11-25", "2026-12-03"]);
    assert.deepEqual(at(12, 1), ["2026-12-03", "2026-12-10"]);
  });

  it("lets the order page's own check accept the 25th and refuse the " +
    "26th (contract 5)", () => {
    const lists = new DateLists({
      querySelector: () => null, querySelectorAll: () => [],
    });

    lists.lists = allDates(THU_19, terms, schedule);

    const index = indexCatalog(catalog);
    const check = (date) => validateOrder({
      customer: {
        firstName: "Pat", lastName: "Example", email: EMAIL,
        phone: "401-555-0100", contact: "text",
      },
      lines: [{ sku: "NFF-CHK-WHL-35-39", qty: 2 }],
      fulfilment: {
        method: "delivery", date,
        delivery: { address1: "1 Main St", town: "Foster", zip: "02825",
          cooler: "Porch" },
      },
      claimedTotal: 6000,
    }, { index, terms, now: THU_19, schedule: lists.schedule() });

    assert.deepEqual(dates(lists.schedule().deliveries),
      ["2026-11-25", "2026-12-03"]);

    const ok = check("2026-11-25");

    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
    assert.equal(check("2026-11-26").ok, false);
  });
});

describe("a moved week on the server", () => {
  it("validates a new order for the 25th", async () => {
    const { id, stores } = await placed({
      date: "2026-11-25", now: THU_19, schedule: THANKSGIVING,
    });

    assert.equal((await getOrder(stores, id)).fulfilment.date, "2026-11-25");
  });

  it("refuses a new order for the replaced Thursday", async () => {
    const { res, data } = await place({
      date: "2026-12-10", now: ny("2026-12-03"), schedule: DECEMBER,
    });

    assert.equal(res.status, 409, JSON.stringify(data));
    assert.ok(data.errors["fulfilment.date"], JSON.stringify(data.errors));
    assert.deepEqual(dates(data.dates), ["2026-12-09", "2026-12-17"],
      "the fresh list the lapsed dialog offers");
  });

  it("lets the account's Change delivery take the moved day and not the " +
    "replaced Thursday", async () => {
    const now = ny("2026-12-03");
    const { id, stores } = await placed({
      date: "2026-12-17", now, schedule: DECEMBER,
    });
    const order = await getOrder(stores, id);
    const env = envWith(DECEMBER);
    const to = planChange(order, { date: "2026-12-09" }, { now, env });

    assert.equal(to.errors, undefined, JSON.stringify(to.errors));
    assert.equal(to.patch.fulfilment.date, "2026-12-09");
    assert.ok(planChange(order, { date: "2026-12-10" }, { now, env })
      .errors.date);
  });

  describe("in bin/nff's orders change and the admin's next delivery day",
    () => {
      serverSchedule(DECEMBER);

      it("follow the moved day", async () => {
        const now = ny("2026-12-03");
        const { id, stores } = await placed({
          date: "2026-12-17", now, schedule: DECEMBER,
        });
        const env = envWith(DECEMBER);
        const warned = async (date) => {
          const r = await planAmend(stores, id,
            { fulfilment: { date } }, { now, env, noSquare: true });

          assert.equal(r.ok, true, JSON.stringify(r.errors));

          return r.plan.warnings.some((w) => w.includes(date));
        };

        assert.equal(await warned("2026-12-09"), false);
        assert.equal(await warned("2026-12-10"), true);
        assert.equal(nextDeliveryDay("2026-12-03"), "2026-12-09");
        assert.equal(nextDeliveryDay("2026-12-09"), "2026-12-17");
      });
    });
});

describe("an order for the 25th", () => {
  serverSchedule(THANKSGIVING);

  const arrives = `Arrives: Wednesday, November 25, ${WINDOW}`;

  it("shows the 25th and the unchanged window in its emails and the " +
    "account", async () => {
    const { id, sent, stores } = await placed({
      date: "2026-11-25", now: THU_19, schedule: THANKSGIVING,
    });
    const theirs = sent.find((m) => m.to === EMAIL);

    assert.ok(theirs, "the customer's confirmation");
    assert.ok(theirs.text.includes(arrives), theirs.text);
    assert.ok(sent.some((m) => m.to !== EMAIL), "the farm's notice");

    const shown = publicOrder(await getOrder(stores, id), THU_19);

    assert.equal(shown.fulfilment.date, "2026-11-25");
  });

  it("shows the 25th and the window on its packing slip", async () => {
    const { id, stores } = await placed({
      date: "2026-11-25", now: THU_19, schedule: THANKSGIVING,
    });
    const order = await getOrder(stores, id);
    const pdf = packetPdf({
      entries: [{ order, kind: "new", changes: [] }],
      now: ny("2026-11-24", 15), title: "Packing slips", env: {},
    }).toString("latin1");

    assert.ok(pdf.includes("(Wednesday, November 25)"));
    // The en dash, as WinAnsi writes it.
    assert.ok(pdf.includes("(10:00 AM \\226 4:00 PM)"));
    assert.ok(!pdf.includes("Thursday"));
  });

  it("is in tomorrow's manifest and the evening packet on Tuesday the " +
    "24th, and reminded at 18:00 that evening", async () => {
    const { id, stores } = await placed({
      date: "2026-11-25", now: THU_19, schedule: THANKSGIVING,
    });
    const env = envWith(THANKSGIVING);
    const early = outbox();
    const before18 = ny("2026-11-24", 17, 55);

    await runJobs(stores, {
      env, mail: early.mail, now: before18, realNow: before18,
    });
    assert.ok(!early.sent.some((m) => /deliveryReminder/
      .test(m.idempotencyKey || "")), "not before 18:00");

    const jobs = outbox();
    const evening = ny("2026-11-24", 18, 5);

    await runJobs(stores, { env, mail: jobs.mail, now: evening,
      realNow: evening });

    const reminder = jobs.sent.find((m) => m.idempotencyKey ===
      `${id}-deliveryReminder-2026-11-25`);

    assert.ok(reminder, "the reminder, the evening before the 25th");
    assert.ok(reminder.text.includes(arrives), reminder.text);

    const manifest = jobs.sent.find((m) => /^Tomorrow, /.test(m.subject));

    assert.equal(manifest && manifest.subject,
      "Tomorrow, Wednesday, November 25: 1 order");
    assert.ok(manifest.text.includes(id));
    assert.ok(jobs.sent.some((m) => m.subject.startsWith(
      "Packing slips for tomorrow, Wednesday, November 25")),
    jobs.sent.map((m) => m.subject).join("\n"));
  });
});

describe("nothing tells a customer of a Wednesday delivery that it is " +
  "Thursday", () => {
  serverSchedule(THANKSGIVING);

  it("in any email built for the order", async () => {
    const { id, sent, stores } = await placed({
      date: "2026-11-25", now: THU_19, schedule: THANKSGIVING,
    });
    const order = await getOrder(stores, id);
    const emails = {
      sent: sent.map(words).join("\n"),
      confirmed: words(orderConfirmed(order, { orderUrl: "https://x/o" })),
      reminder: words(deliveryReminder(order, { orderUrl: "https://x/o" })),
      changed: words(orderChanged(order, { orderUrl: "https://x/o" })),
      cancelled: words(orderCancelled(order, { by: "customer" })),
      // The farm missed Thursday the 19th and moved it to the 25th.
      moved: words(movedDelivery({
        ...order,
        attempted: { date: "2026-11-19", cause: "farm",
          at: ny("2026-11-19", 15).toISOString() },
      }, { now: ny("2026-11-19", 16) })),
    };

    for (const [name, text] of Object.entries(emails)) {
      assert.ok(!text.includes("Thursday"), `${name}:\n${text}`);
    }
  });

  it("nor names a holiday Thursday as the next delivery after a miss",
    async () => {
      // A Thursday the 19th delivery, missed: the next day is the 25th.
      const { id, stores } = await placed({
        date: "2026-11-19", now: ny("2026-11-16"), schedule: THANKSGIVING,
      });
      const order = await getOrder(stores, id);
      const text = words(missedDelivery({
        ...order,
        attempted: { date: "2026-11-19", cause: "farm",
          at: ny("2026-11-19", 15).toISOString() },
      }, { now: ny("2026-11-19", 16) }));

      assert.ok(text.includes("November 25"), text);
      assert.ok(!text.includes("November 26"), text);
      assert.ok(!/next Thursday|Thursday, November 25/.test(text), text);
      assert.equal(nextDeliveryDay("2026-11-19"), "2026-11-25");
    });
});

describe("bin/nff schedule set", () => {
  it("reports paid delivery orders on a Thursday being replaced", () => {
    const order = (id, date, extra = {}) => ({
      id, status: "paid", fulfilment: { method: "delivery", date }, ...extra,
    });
    const orders = [
      order("B", "2026-12-10"),
      order("A", "2026-12-10"),
      order("C", "2026-12-10", { status: "cancelled" }),
      order("D", "2026-12-10", { status: "fulfilled" }),
      order("E", "2026-12-10", {
        fulfilment: { method: "onfarm", date: "2026-12-10" },
      }),
      order("F", "2026-12-17"),
      order("G", "2026-12-09"),
    ];
    const deliveries = parseSchedule(withLines("2026-12-09 delivery",
      "2026-11-25 delivery")).deliveries;

    assert.deepEqual(paidOnReplaced(orders, deliveries, terms), [
      { date: "2026-11-25", replaced: "2026-11-26", ids: [] },
      { date: "2026-12-09", replaced: "2026-12-10", ids: ["A", "B"] },
    ]);
    assert.match(readFileSync(join(root, "bin/nff"), "utf8"),
      /paidOnReplaced\(/, "schedule set calls it");
  });
});

describe("a buying group's round in a moved week (contract 8)", () => {
  it("is the round the Thursday would have had: the order's own date " +
    "decides it", async () => {
    const vff = groupOf("vff");
    const stores = testStores();

    await setGroupCode(stores, "vff", { code: "GYM-2026", now: THU_19 });

    const round = roundFor(vff, terms, "2026-11-26");

    assert.equal(roundFor(vff, terms, "2026-11-25"), round);

    const { id } = await placed({
      date: "2026-11-25", now: THU_19, schedule: THANKSGIVING, stores,
      extra: { groupCode: "GYM-2026" },
    });
    const saved = await getOrder(stores, id);

    assert.equal(saved.group && saved.group.key, "vff");
    assert.equal(saved.group.round, round);
  });
});

describe("the docs", () => {
  it("say how to move a week's delivery (docs/order-form.md)", () => {
    const doc = readFileSync(join(root, "docs/order-form.md"), "utf8");
    const sections = doc.split(/^#+ /m);
    const moving = sections.find((s) => /\b\d{4}-\d{2}-\d{2} delivery\b/
      .test(s));

    assert.ok(moving, "an example delivery line");
    assert.match(moving, /bin\/nff schedule set/);
  });
});
