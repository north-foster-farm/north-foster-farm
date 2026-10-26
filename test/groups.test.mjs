// Buying groups (#471): the group's series runs every other week, is
// listed nowhere a request without the group can see, and runs its
// rounds without a schedule line.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allDates, datesFor, eventDates, scheduledDates,
} from "../assets/scripts/order/lib/dates.mjs";
import {
  buildModel, hasDate, offered, seriesDates,
} from "../assets/scripts/order/lib/events.mjs";
import {
  checkSchedule, parseSchedule,
} from "../assets/scripts/order/lib/schedule.mjs";
import {
  computeTotals, lockDiscountFor,
} from "../assets/scripts/order/lib/totals.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import catalog from "../data/catalog.json" with { type: "json" };
import groupData from "../data/groups.json" with { type: "json" };
import locationData from "../data/locations.json" with { type: "json" };
import seriesData from "../data/series.json" with { type: "json" };
import terms from "../netlify/functions/lib/terms.mjs";
import {
  buildOrder, settings,
} from "../netlify/functions/lib/square.mjs";
import { SCHEDULE } from "./schedule-fixture.mjs";

const ny = (iso, hour = 9, minute = 0) =>
  instant(iso, hour, minute, "America/New_York");

const LOCATIONS = [
  {
    code: "AAAA", name: "Town Common", street: "1 Main St", city: "Foster",
    state: "RI", zip: "02825", town: "Foster", lat: 41.8, lng: -71.7,
  },
  {
    code: "GGGG", name: "The Gym", street: "2 Fit St", city: "Warwick",
    state: "RI", zip: "02888", town: "Warwick", lat: 41.7, lng: -71.4,
    private: true,
  },
];
const SERIES = [
  {
    code: "BBBB", kind: "drop-site", name: "Drop site", location: "AAAA",
    start: "2026-10-17", opens: "10:00", closes: "11:00",
  },
  {
    code: "HHHH", kind: "group", name: "The Gym", location: "GGGG",
    start: "2026-11-08", every: 2, opens: "08:30", closes: "09:00",
    group: "gym",
  },
];
const model = buildModel(LOCATIONS, SERIES);
const base = { ...terms, model };
const member = { ...base, groups: ["gym"] };
// The schedule as the functions hold it: the windows, with the
// occurrence lines on them.
const lines = (text) => {
  const parsed = parseSchedule(text);

  return Object.assign(parsed.windows, { lines: parsed.lines });
};

describe("a series every other week", () => {
  const s = model.seriesOf("HHHH");

  it("has its start, and every second Sunday after", () => {
    assert.equal(hasDate(s, "2026-11-08"), true);
    assert.equal(hasDate(s, "2026-11-15"), false);
    assert.equal(hasDate(s, "2026-11-22"), true);
    assert.equal(hasDate(s, "2026-11-29"), false);
    assert.equal(hasDate(s, "2026-12-06"), true);
    assert.equal(hasDate(s, "2026-11-01"), false);
    assert.deepEqual(seriesDates(s, "2026-11-01", "2026-12-31"),
      ["2026-11-08", "2026-11-22", "2026-12-06", "2026-12-20"]);
  });

  it("leaves a weekly series weekly", () => {
    const weekly = model.seriesOf("BBBB");

    assert.deepEqual(seriesDates(weekly, "2026-11-01", "2026-11-14"),
      ["2026-11-07", "2026-11-14"]);
  });
});

describe("a group's series is offered only to its group", () => {
  const now = ny("2026-11-02");
  const schedule = lines("2026-11-07 BBBB pickup\n2026-11-14 BBBB pickup");

  it("is left out of the series a request may see", () => {
    assert.deepEqual(offered(model).map((s) => s.code), ["BBBB"]);
    assert.deepEqual(offered(model, ["gym"]).map((s) => s.code),
      ["BBBB", "HHHH"]);
    assert.deepEqual(offered(model, ["other"]).map((s) => s.code),
      ["BBBB"]);
  });

  it("is left out of /api/dates and /api/events for everyone else", () => {
    const codes = (list) => list.map((d) => d.series);

    assert.deepEqual(codes(scheduledDates(now, base, schedule)),
      ["BBBB", "BBBB"]);
    assert.deepEqual(codes(eventDates(now, base, schedule)),
      ["BBBB", "BBBB"]);
    assert.deepEqual(codes(allDates(now, base, schedule).scheduled),
      ["BBBB", "BBBB"]);
  });

  it("is offered to the group, open without a schedule line", () => {
    const mine = scheduledDates(now, member, schedule);

    assert.deepEqual(mine.map((d) => [d.series, d.date]),
      [["BBBB", "2026-11-07"], ["HHHH", "2026-11-08"],
        ["BBBB", "2026-11-14"]]);

    const round = mine.find((d) => d.series === "HHHH");

    assert.equal(round.occurrence, "HHHH-261108");
    assert.equal(round.name, "The Gym");
    assert.equal(round.window, "8:30 – 9:00 AM");
    assert.equal(round.location, "GGGG");
    // Orders close 11:59 PM the Saturday before (James, 6424212209).
    assert.equal(round.cutoff, ny("2026-11-07", 23, 59).toISOString());
  });

  it("opens the next round whatever the horizon, one at a time", () => {
    // Monday 2026-10-26: the horizon is Saturday 2026-11-07, and the
    // first round, Sunday the 8th, is open to the group all the same.
    const early = ny("2026-10-26");
    const mine = scheduledDates(early, member, schedule);

    assert.deepEqual(mine.filter((d) => d.series === "HHHH")
      .map((d) => d.date), ["2026-11-08"]);
    assert.equal(mine.some((d) => d.date > "2026-11-07"
      && d.series !== "HHHH"), false);
    assert.equal(scheduledDates(early, base, schedule)
      .some((d) => d.series === "HHHH"), false);
    // The round after opens the moment this one closes.
    assert.deepEqual(scheduledDates(ny("2026-11-08", 0, 1), member, schedule)
      .filter((d) => d.series === "HHHH").map((d) => d.date),
    ["2026-11-22"]);
  });

  it("closes once its cutoff has passed", () => {
    const late = ny("2026-11-08", 0, 1);
    const mine = scheduledDates(late, member, schedule);

    assert.equal(mine.some((d) => d.occurrence === "HHHH-261108"), false);
  });

  it("sits out a round the schedule skips, and attends one it says", () => {
    const skipped = lines("2026-11-07 BBBB pickup\n2026-11-08 HHHH skip");
    const attended = lines("2026-11-07 BBBB pickup\n" +
      "2026-11-08 HHHH attend");

    assert.equal(scheduledDates(now, member, skipped)
      .some((d) => d.series === "HHHH"), false);
    assert.equal(scheduledDates(now, member, attended)
      .some((d) => d.series === "HHHH"), false);
    assert.equal(eventDates(now, member, attended)
      .find((d) => d.series === "HHHH").status, "attend");
  });

  it("is validated by datesFor the same way", () => {
    const has = (t) => datesFor("scheduled", now, t, schedule)
      .some((d) => d.occurrence === "HHHH-261108");

    assert.equal(has(base), false);
    assert.equal(has(member), true);
  });

  it("is the farm's to book, like any live series", () => {
    assert.equal(datesFor("scheduled", now, base, schedule, true)
      .some((d) => d.occurrence === "HHHH-261122"), true);
  });
});

describe("the schedule check and a group's series", () => {
  const now = ny("2026-11-02");
  const windows = "2026-11-03 09:00-12:00\n2026-11-17 09:00-12:00\n";

  it("asks for no line for a group's rounds", () => {
    const result = checkSchedule(
      `${windows}2026-11-07 BBBB pickup\n2026-11-14 BBBB pickup`,
      { now, timeZone: terms.timeZone, model },
    );

    assert.deepEqual(result.errors, []);
  });

  it("still asks for the other series' lines", () => {
    const result = checkSchedule(`${windows}2026-11-14 BBBB pickup`,
      { now, timeZone: terms.timeZone, model });

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /2026-11-07: BBBB/);
  });

  it("takes a skip or attend line for a round", () => {
    const result = checkSchedule(
      `${windows}2026-11-07 BBBB pickup\n2026-11-14 BBBB pickup\n` +
      "2026-11-08 HHHH skip",
      { now, timeZone: terms.timeZone, model },
    );

    assert.deepEqual(result.errors, []);
  });

  it("refuses a line on a Sunday the series skips", () => {
    const result = checkSchedule(
      `${windows}2026-11-07 BBBB pickup\n2026-11-14 BBBB pickup\n` +
      "2026-11-15 HHHH pickup",
      { now, timeZone: terms.timeZone, model },
    );

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /2026-11-15: HHHH .* has no occurrence/);
  });
});

describe("the real group data", () => {
  it("names a series and a private location that exist", () => {
    for (const g of groupData.groups) {
      const s = seriesData.series.find((x) => x.code === g.series);
      const loc = locationData.locations.find((x) => x.code === g.location);

      assert.ok(s, `${g.key} series`);
      assert.equal(s.group, g.key);
      assert.equal(s.location, g.location);
      assert.equal(s.kind, "group");
      assert.ok(loc, `${g.key} location`);
      assert.equal(loc.private, true);
      assert.equal(typeof g.name, "string");
      assert.ok(g.name.length);
    }
  });

  it("keeps every group's series off the public lists", () => {
    const now = ny("2026-11-02");

    for (const d of eventDates(now, terms, { lines: [] })) {
      assert.equal(terms.model.seriesOf(d.series).group, undefined);
    }
  });

  it("runs the first round on Sunday 2026-11-08, then every other", () => {
    const s = terms.model.seriesOf("36TS");

    assert.deepEqual(seriesDates(s, "2026-11-01", "2026-12-07"),
      ["2026-11-08", "2026-11-22", "2026-12-06"]);
  });
});

describe("a buying group's price lock", () => {
  const { money } = terms;
  // Retail as the catalog has it today, and a catalog after a rise.
  const index = indexCatalog(catalog);
  const raised = new Map([...index].map(([sku, item]) =>
    [sku, { ...item, price: item.price + 2 }]));
  const lock = groupData.groups[0].priceLock;
  const lines = [
    { sku: "NFF-CHK-WHL-35-39", qty: 2 }, { sku: "NFF-CHK-EGG-LG", qty: 1 },
  ];
  const at = (idx, extra = {}) => computeTotals({
    lines, method: "onfarm", index: idx, money, lock, ...extra,
  });

  it("is today's retail price of every SKU, locked through 2027", () => {
    assert.equal(lock.from, "2026-10-26");
    assert.equal(lock.through, "2027-12-31");
    for (const [sku, item] of index) {
      assert.equal(lock.prices[sku], item.price, sku);
    }
    assert.equal(Object.keys(lock.prices).length, index.size);
  });

  it("holds nothing down while the locked prices are retail", () => {
    assert.equal(lockDiscountFor(lines, index, lock), null);

    const t = at(index);

    // $67: the $50 tier, as for anyone.
    assert.equal(t.subtotal, 6700);
    assert.equal(t.discountTier, 50);
    assert.equal(t.discountAmount, 500);
    assert.equal(t.discountLock, undefined);
    assert.equal(t.lockLines, undefined);
    assert.equal(t.total, 6200);
  });

  it("charges the locked price once retail rises, per item", () => {
    const found = lockDiscountFor(lines, raised, lock);

    assert.equal(found.amount, 600);
    assert.equal(found.label, "Price lock");
    assert.deepEqual(found.lines, [
      { sku: "NFF-CHK-WHL-35-39", off: 200, qty: 2, amount: 400 },
      { sku: "NFF-CHK-EGG-LG", off: 200, qty: 1, amount: 200 },
    ]);

    const t = at(raised);

    // $73 at the new retail, $6 held down: more than the $50 tier.
    assert.equal(t.subtotal, 7300);
    assert.equal(t.discountAmount, 600);
    assert.equal(t.discountLabel, "Price lock");
    assert.equal(t.discountTier, null);
    assert.equal(t.discountLock, true);
    assert.equal(t.lockLines.length, 2);
    assert.equal(t.total, 6700);
  });

  it("never stacks: the larger of the lock and the tier, a tie to the lock",
    () => {
      const one = new Map([["X", { price: 52 }]]);
      const held = { prices: { X: 50 } };
      // $2 held down against the $50 tier's $5: the tier wins.
      const tier = computeTotals({
        lines: [{ sku: "X", qty: 1 }], method: "onfarm", index: one, money,
        lock: held,
      });

      assert.equal(tier.discountAmount, 500);
      assert.equal(tier.discountTier, 50);
      assert.equal(tier.discountLock, undefined);

      // $5 held down against $5: the lock.
      const tie = computeTotals({
        lines: [{ sku: "X", qty: 1 }], method: "onfarm", index: one, money,
        lock: { prices: { X: 47 } },
      });

      assert.equal(tie.discountAmount, 500);
      assert.equal(tie.discountLock, true);
      assert.equal(tie.discountTier, null);
    });

  it("gives a code its due, and a SKU outside the lock retail", () => {
    const code = { code: "TEN", label: "Ten", off: 10 };
    const t = at(raised, { code });

    assert.equal(t.discountCode, "TEN");
    assert.equal(t.discountAmount, 1000);
    assert.equal(t.discountLock, undefined);

    const partial = { prices: { "NFF-CHK-EGG-LG": 7 } };
    const found = lockDiscountFor(lines, raised, partial);

    assert.deepEqual(found.lines.map((l) => l.sku), ["NFF-CHK-EGG-LG"]);
    assert.equal(lockDiscountFor(lines, raised, null), null);
    assert.equal(lockDiscountFor(lines, raised, { prices: {} }), null);
  });

  it("reaches the order through validateOrder", () => {
    const payload = {
      customer: {
        firstName: "Pat", lastName: "Example", email: "pat@example.com",
        phone: "401-555-0100", contact: "call",
      },
      lines,
      fulfilment: { method: "onfarm", date: "2026-10-07",
        onfarm: { window: "09:00-12:00" } },
      claimedTotal: 6700,
    };
    const schedule = Object.assign(parseSchedule(SCHEDULE).windows,
      { lines: parseSchedule(SCHEDULE).lines });
    const result = validateOrder(payload, {
      index: raised, terms, now: ny("2026-10-06"), schedule, lock,
    });

    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.order.totals.total, 6700);
    assert.equal(result.order.totals.discountLock, true);
    assert.equal(result.order.lines[0].unitPrice, 32);
  });

  it("reaches Square as one line-item discount per held item", () => {
    const cfg = settings({
      SQUARE_ACCESS_TOKEN: "tok", SQUARE_LOCATION_ID: "LOC",
      SQUARE_ENV: "sandbox",
    });
    const t = at(raised);
    const order = {
      id: "NFF-2611-ABCD",
      customer: { name: "Pat Example", email: "pat@example.com",
        phone: "401-555-0100", contact: "text" },
      fulfilment: { method: "onfarm", date: "2026-11-03",
        onfarm: { window: "09:00-12:00", from: "09:00", to: "12:00" },
        delivery: null },
      lines: lines.map(({ sku, qty }) => ({
        sku, label: sku, name: sku, unitPrice: raised.get(sku).price, qty,
        lineTotal: raised.get(sku).price * qty, squareVariationId: null,
      })),
      totals: t,
      notes: "", source: "",
      flags: { zipUnlisted: false, totalMismatch: false },
    };
    const built = buildOrder(order, "CUST", cfg);

    assert.deepEqual(built.discounts, [
      { uid: "lock-NFF-CHK-WHL-35-39", name: "Price lock",
        amount_money: { amount: 400, currency: "USD" }, scope: "LINE_ITEM" },
      { uid: "lock-NFF-CHK-EGG-LG", name: "Price lock",
        amount_money: { amount: 200, currency: "USD" }, scope: "LINE_ITEM" },
    ]);
    assert.deepEqual(built.line_items[0].applied_discounts,
      [{ discount_uid: "lock-NFF-CHK-WHL-35-39" }]);
    assert.deepEqual(built.line_items[1].applied_discounts,
      [{ discount_uid: "lock-NFF-CHK-EGG-LG" }]);
    assert.equal(built.line_items[0].base_price_money.amount, 3200);

    // Nothing held down: the usual one order-scope discount.
    const plain = buildOrder({ ...order, totals: at(index) }, "CUST", cfg);

    assert.equal(plain.discounts.length, 1);
    assert.equal(plain.discounts[0].scope, "ORDER");
    assert.equal(plain.line_items[0].applied_discounts, undefined);
  });
});
