import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../data/delivery.json" with { type: "json" };
import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { moneyOn } from "../assets/scripts/order/lib/money-on.mjs";
import {
  computeTotals, meetsMinimum,
} from "../assets/scripts/order/lib/totals.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { facts } from "../netlify/functions/lib/launch.mjs";
import { remindersOn } from "../netlify/functions/lib/reminders.mjs";
import { farmMorningReport } from "../netlify/functions/lib/templates.mjs";

const index = indexCatalog(catalog);
const EGG = "NFF-CHK-EGG-LG"; // $7
const CHICKEN = "NFF-CHK-WHL-35-39"; // $30

const NEW_YEAR = "2027-01-01";
const before = instant("2026-12-31", 23, 59, "America/New_York");
const after = instant(NEW_YEAR, 0, 0, "America/New_York");

describe("the 1 January 2027 money changes", () => {
  it("stay off through 31 December and come on with the day", () => {
    const old = moneyOn(terms.money, "2026-12-31");
    const now = moneyOn(terms.money, NEW_YEAR);

    assert.equal(old.deliveryMinimum, 40);
    assert.deepEqual(old.bulkTiers.map((t) => t.threshold),
      [50, 100, 150, 200]);
    assert.equal(now.deliveryMinimum, 50);
    assert.deepEqual(now.bulkTiers.map((t) => t.threshold),
      [100, 150, 200]);
    assert.equal(now.changes, undefined);
    assert.equal(moneyOn(terms.money, "2030-06-01").deliveryMinimum, 50);
  });

  it("drop the $5 off tier and keep free delivery at $150 stacking", () => {
    const at = (day, qty) => computeTotals({
      lines: [{ sku: CHICKEN, qty }], method: "delivery", index,
      money: moneyOn(terms.money, day),
    });

    // $60: $5 off in 2026, nothing from the new year.
    assert.equal(at("2026-12-31", 2).discountAmount, 500);
    assert.equal(at(NEW_YEAR, 2).discountAmount, 0);

    // $150 is still free delivery, with its $15 tier on top of it.
    const free = at(NEW_YEAR, 5);

    assert.equal(free.deliveryFee, 0);
    assert.equal(free.discountAmount, 1500);
    assert.equal(at(NEW_YEAR, 4).deliveryFee, 500, "$120 pays the fee");
    assert.equal(at(NEW_YEAR, 4).discountAmount, 1000);
  });

  it("raise the delivery minimum to $50 after discounts", () => {
    const totals = (qty) => computeTotals({
      lines: [{ sku: EGG, qty }], method: "delivery", index,
      money: moneyOn(terms.money, NEW_YEAR),
    });

    assert.ok(!meetsMinimum(totals(7), moneyOn(terms.money, NEW_YEAR)),
      "$49");
    assert.ok(meetsMinimum(totals(8), moneyOn(terms.money, NEW_YEAR)),
      "$56");
    assert.ok(meetsMinimum(totals(6), moneyOn(terms.money, "2026-12-31")),
      "$42 passes in 2026");
  });

  it("decide a delivery order the server takes, by the day it is placed",
    () => {
      const order = (qty) => ({
        customer: {
          firstName: "Pat", lastName: "Example", email: "pat@example.com",
          phone: "401-555-0100", contact: "text",
        },
        lines: [{ sku: EGG, qty }],
        fulfilment: {
          method: "delivery", date: "2027-01-07",
          delivery: {
            address1: "1 Main St", town: "Foster", zip: "02825",
            cooler: "Side porch",
          },
        },
      });
      const ctx = (now) => ({ index, terms, now });

      // $42: over the old minimum, under the new.
      assert.ok(validateOrder(order(6), ctx(before)).ok);

      const late = validateOrder(order(6), ctx(after));

      assert.equal(late.status, 422);
      assert.match(late.errors["delivery.minimum"], /\$50 or more/);
    });

  it("reach the launch email's facts from the date", () => {
    assert.equal(facts(before).minimum, "$40");
    assert.equal(facts(before).bulkFirstAt, "$50");
    assert.equal(facts(after).minimum, "$50");
    assert.equal(facts(after).bulkFirstAt, "$100");
    assert.equal(facts(after).bulkFirstOff, "$10");
  });
});

describe("the reminder to remove the POS discount", () => {
  it("shows from 20 December until two weeks past the change", () => {
    assert.deepEqual(remindersOn("2026-12-19"), []);
    assert.equal(remindersOn("2026-12-20").length, 1);
    assert.equal(remindersOn("2026-12-31").length, 1);
    assert.equal(remindersOn("2027-01-15").length, 1);
    assert.deepEqual(remindersOn("2027-01-16"), []);
  });

  it("names the discount, the minimum and the point of sale", () => {
    const [text] = remindersOn("2026-12-20");

    assert.match(text, /\$5 off at \$50 discount ends/);
    assert.match(text, /delivery minimum becomes \$50/);
    assert.match(text, /point of sale in Square/);
  });

  it("rides in the morning report only while it shows", () => {
    const stats = {};
    const links = { site: "https://x" };
    const report = (reminders) => farmMorningReport(stats, [], {
      date: "2026-12-21", links, reminders,
    });

    assert.match(report(remindersOn("2026-12-21")).text, /Reminders/);
    assert.doesNotMatch(report(remindersOn("2026-12-19")).text,
      /Reminders/);
  });
});

describe("the build the jobs start on the day", () => {
  const HOOK = "https://api.netlify.com/build_hooks/abc";
  const run = (stores, when, { hook = HOOK, ok = true } = {}) => {
    const posts = [];
    const fetchImpl = async (url, init) => {
      assert.ok(init.signal instanceof AbortSignal, "the post can time out");
      posts.push([url, init.method]);

      return { ok, status: ok ? 200 : 500 };
    };

    return runJobs(stores, {
      env: hook ? { PICKUP_SCHEDULE_HOOK: hook } : {},
      mail: async () => ({ id: "m" }), fetchImpl,
      now: when, realNow: when,
    }).then((report) => ({ report, posts }));
  };

  it("waits for the day, posts once, and not again", async () => {
    const stores = testStores();
    const eve = await run(stores, instant("2026-12-31", 23, 50,
      "America/New_York"));

    assert.deepEqual(eve.posts, []);

    const day = await run(stores, instant(NEW_YEAR, 0, 10,
      "America/New_York"));

    assert.deepEqual(day.posts, [[HOOK, "POST"]]);
    assert.deepEqual(day.report.rebuilt, [NEW_YEAR]);

    const later = await run(stores, instant(NEW_YEAR, 9, 0,
      "America/New_York"));

    assert.deepEqual(later.posts, []);
  });

  it("tries again after a hook that failed, and gives up after a week",
    async () => {
      const stores = testStores();
      const down = await run(stores, instant(NEW_YEAR, 0, 10,
        "America/New_York"), { ok: false });

      assert.equal(down.posts.length, 1);
      assert.deepEqual(down.report.rebuilt, []);
      assert.ok(down.report.errors.some((e) => e.step === "rebuild"));

      const up = await run(stores, instant(NEW_YEAR, 0, 25,
        "America/New_York"));

      assert.equal(up.posts.length, 1);

      const old = await run(testStores(), instant("2027-01-09", 9, 0,
        "America/New_York"));

      assert.deepEqual(old.posts, [], "too late to matter");
    });

  it("does nothing without a hook", async () => {
    const none = await run(testStores(), instant(NEW_YEAR, 0, 10,
      "America/New_York"), { hook: "" });

    assert.deepEqual(none.posts, []);
    assert.deepEqual(none.report.rebuilt, []);
  });
});

describe("a change to an order placed before the day", () => {
  it("keeps the prices of the day it was placed", () => {
    const edit = (placed) => validateOrder({
      customer: {
        firstName: "Pat", lastName: "Example", email: "pat@example.com",
        phone: "401-555-0100", contact: "text",
      },
      lines: [{ sku: EGG, qty: 6 }],
      fulfilment: {
        method: "delivery", date: "2027-01-07",
        delivery: {
          address1: "1 Main St", town: "Foster", zip: "02825",
          cooler: "Side porch",
        },
      },
    }, { index, terms, now: after, placed });

    // $42 meets the 2026 minimum, not the 2027 one.
    assert.ok(edit("2026-12-20T15:00:00Z").ok);
    assert.equal(edit(undefined).status, 422);
    assert.equal(edit("2027-01-02T15:00:00Z").status, 422);
  });
});
