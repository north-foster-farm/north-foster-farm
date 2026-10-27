// Stock nobody can order (#499): a tier Square counts above 0 that the
// order page won't sell, archived or `inStock: false`. `bin/nff stock
// hidden`, and the jobs' daily invariant and its alert. Square's answer
// is replayed from test/fixtures/square/inventory-counts-hidden.json
// through the real inventory read.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import {
  HIDDEN_TOLD, STOCK_HIDDEN_HOUR, runJobs,
} from "../netlify/functions/lib/jobs.mjs";
import { hiddenLine, stockHidden } from "../netlify/functions/lib/admin.mjs";
import { mark } from "../netlify/functions/lib/health.mjs";
import { inventoryCounts } from "../netlify/functions/lib/square.mjs";
import {
  availability, hiddenCounts, hiddenInStock,
} from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const TZ = "America/New_York";
const at = (iso, h, m = 0) => instant(iso, h, m, TZ);

const fixture = JSON.parse(readFileSync(new URL(
  "./fixtures/square/inventory-counts-hidden.json", import.meta.url,
), "utf8"));

const SQUARE = {
  SQUARE_ACCESS_TOKEN: "tok", SQUARE_LOCATION_ID: "<LOCATION_ID>",
  SQUARE_ENV: "production",
};
const ENV = { DEV_NOTIFICATIONS_EMAIL: "dev@x.com" };

const item = (sku, restock, inStock = true) => ({
  sku, name: sku, label: sku, price: 1, inStock, restock,
  squareVariationId: `VAR-${sku}`,
});

const FIXTURE = indexCatalog({
  groups: [{
    key: "cuts", label: "Cuts", lines: "name",
    items: [
      item("OUT-ZERO", "hidden", false),
      item("OUT-SOME", "seasonal", false),
      item("ARCH-SOME", "archived"),
      item("HIATUS-SOME", "hiatus"),
      item("DISC-SOME", "discontinued"),
    ],
  }],
});

// The real read, answered by the recording. `counts` changes a SKU's
// quantity, as the farm would in Square. -> { inventory, asked }.
const replay = (counts = {}) => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push(JSON.parse(init.body).catalog_object_ids);

    return new Response(JSON.stringify({
      ...fixture.response,
      counts: fixture.response.counts.map((c) => {
        const sku = c.catalog_object_id.replace(/^VAR-/, "");

        return Object.hasOwn(counts, sku)
          ? { ...c, quantity: String(counts[sku]) } : c;
      }),
    }));
  };

  return {
    asked,
    inventory: (ids, opts) => inventoryCounts(ids, {
      ...opts, env: SQUARE, fetchImpl,
    }),
  };
};

const mailer = () => {
  const sent = [];

  return { sent, mail: async (m) => { sent.push(m); return { id: "m" }; } };
};

const alerts = (sent) => sent
  .filter((m) => m.subject === "Site alert: jobs.invariants");

describe("hiddenCounts (#499)", () => {
  it("asks Square for the tiers the page won't sell alone", async () => {
    const { inventory, asked } = replay();

    await hiddenCounts({ catalogIndex: FIXTURE, inventory });
    assert.deepEqual(asked,
      [["VAR-OUT-ZERO", "VAR-OUT-SOME", "VAR-ARCH-SOME"]]);
  });

  it("names each with why and its count, and passes one at 0",
    async () => {
      const list = await hiddenCounts({
        catalogIndex: FIXTURE, inventory: replay().inventory,
      });

      assert.deepEqual(list.map((i) => [i.sku, i.why, i.count]), [
        ["OUT-ZERO", "inStock false", 0],
        ["OUT-SOME", "inStock false", 3],
        ["ARCH-SOME", "archived", 2],
      ]);
      assert.deepEqual(hiddenInStock(list).map((i) => i.sku),
        ["OUT-SOME", "ARCH-SOME"]);
    });

  it("ignores a hiatus or discontinued tier with stock, which sells",
    async () => {
      const { inventory } = replay();
      const list = await hiddenCounts({ catalogIndex: FIXTURE, inventory });
      const counts = Object.fromEntries(fixture.response.counts.map((c) =>
        [c.catalog_object_id.replace(/^VAR-/, ""), Number(c.quantity)]));
      const items = await availability(null, {
        catalogIndex: FIXTURE, counts,
      });

      assert.equal(list.some((i) => /HIATUS|DISC/.test(i.sku)), false);
      for (const sku of Object.keys(counts)) {
        assert.equal(items[sku].inStock,
          counts[sku] > 0 && !hiddenInStock(list).some((i) => i.sku === sku),
          `${sku}: named exactly when stock can't be ordered`);
      }
    });

  it("is null when Square doesn't answer", async () => {
    assert.equal(await hiddenCounts({
      catalogIndex: FIXTURE,
      inventory: async () => { throw new Error("Square 503"); },
    }), null);
  });
});

describe("bin/nff stock hidden (#499)", () => {
  it("prints every tier the page won't sell and fails on the ones with " +
    "stock", async () => {
    const r = await stockHidden({
      catalogIndex: FIXTURE, inventory: replay().inventory,
    });

    assert.deepEqual(r.list.map(hiddenLine), [
      "ok        OUT-ZERO  inStock false  0  OUT-ZERO",
      "IN STOCK  OUT-SOME  inStock false  3  OUT-SOME",
      "IN STOCK  ARCH-SOME  archived  2  ARCH-SOME",
    ]);
    assert.deepEqual(r.inStock.map((i) => i.sku), ["OUT-SOME", "ARCH-SOME"]);
  });

  it("passes when every one is at 0, and ignores the rest", async () => {
    const r = await stockHidden({
      catalogIndex: FIXTURE,
      inventory: replay({ "OUT-SOME": 0, "ARCH-SOME": 0 }).inventory,
    });

    assert.deepEqual(r.inStock, []);
    assert.equal(r.list.some((i) => /HIATUS|DISC/.test(i.sku)), false);
  });

  it("says a variation Square doesn't count is not counted", () => {
    assert.equal(hiddenLine({ sku: "S", why: "archived", count: null,
      name: "N" }), "ok        S  archived  not counted  N");
  });

  it("refuses to pass when Square can't be read", async () => {
    await assert.rejects(stockHidden({
      catalogIndex: FIXTURE, inventory: async () => null,
    }), /could not be read/);
  });
});

describe("the stock.hidden invariant (#499)", () => {
  const run = (stores, now, counts) => {
    const { sent, mail } = mailer();

    return runJobs(stores, {
      now, env: ENV, mail, catalogIndex: FIXTURE,
      inventory: replay(counts).inventory,
    }).then((report) => ({ report, sent }));
  };
  const hidden = (report) => report.invariants
    .filter((v) => v.rule === "stock.hidden");

  it("names each SKU above 0 the page won't sell, with why and its " +
    "count, and alerts", async () => {
    const stores = testStores();
    const { report, sent } = await run(stores, at("2026-10-27", 7));

    assert.deepEqual(hidden(report), [
      { rule: "stock.hidden", id: "OUT-SOME", why: "inStock false",
        count: 3 },
      { rule: "stock.hidden", id: "ARCH-SOME", why: "archived", count: 2 },
    ]);
    assert.equal(alerts(sent).length, 1);
    assert.deepEqual(alerts(sent)[0].to, ["dev@x.com"]);
    assert.match(alerts(sent)[0].text, /OUT-SOME.+inStock false.+3/);
    assert.match(alerts(sent)[0].text, /ARCH-SOME.+archived.+2/);
    assert.doesNotMatch(alerts(sent)[0].text,
      /OUT-ZERO|HIATUS-SOME|DISC-SOME/);
  });

  it("is quiet when every one is at 0", async () => {
    const { report, sent } = await run(testStores(), at("2026-10-27", 7),
      { "OUT-SOME": 0, "ARCH-SOME": 0 });

    assert.deepEqual(hidden(report), []);
    assert.equal(alerts(sent).length, 0);
  });

  it("waits for 07:00, then reads once a day", async () => {
    const stores = testStores();
    const early = await run(stores, at("2026-10-27", STOCK_HIDDEN_HOUR - 1));

    assert.deepEqual(hidden(early.report), []);
    assert.equal((await run(stores, at("2026-10-27", 7))).report
      .invariants.length, 2);
    assert.deepEqual(hidden((await run(stores, at("2026-10-27", 7, 15)))
      .report), [], "done for the day");
  });

  it("reads on the first run after 07:00 when that one was missed",
    async () => {
      const { report } = await run(testStores(), at("2026-10-27", 9));

      assert.equal(hidden(report).length, 2);
    });

  it("alerts once per SKU and count", async () => {
    const stores = testStores();

    await run(stores, at("2026-10-27", 7));

    const same = await run(stores, at("2026-10-28", 7));

    assert.deepEqual(hidden(same.report), [], "same counts, next day");
    assert.equal(alerts(same.sent).length, 0);

    const moved = await run(stores, at("2026-10-29", 7), { "OUT-SOME": 4 });

    assert.deepEqual(hidden(moved.report).map((v) => [v.id, v.count]),
      [["OUT-SOME", 4]], "a new count is told; the other is not");
    assert.equal(alerts(moved.sent).length, 1);

    await run(stores, at("2026-10-30", 7), { "OUT-SOME": 4, "ARCH-SOME": 0 });

    const back = await run(stores, at("2026-10-31", 7), { "OUT-SOME": 4 });

    assert.deepEqual(hidden(back.report).map((v) => [v.id, v.count]),
      [["ARCH-SOME", 2]], "back above 0 after 0 is told again");
    assert.deepEqual((await stores.jobs.get(HIDDEN_TOLD)).counts,
      { "OUT-SOME": 4, "ARCH-SOME": 2 });
  });

  it("tells again next run when the alert isn't sent", async () => {
    const stores = testStores();
    const down = await runJobs(stores, {
      now: at("2026-10-27", 7), env: ENV, catalogIndex: FIXTURE,
      inventory: replay().inventory,
      mail: async () => { throw new Error("Resend 500"); },
    });

    assert.equal(hidden(down).length, 2);
    assert.equal(await stores.jobs.get(HIDDEN_TOLD), null, "not told");

    const again = await run(stores, at("2026-10-27", 7, 15));

    assert.equal(hidden(again.report).length, 2);
    assert.equal(alerts(again.sent).length, 1);
    assert.deepEqual((await stores.jobs.get(HIDDEN_TOLD)).counts,
      { "OUT-SOME": 3, "ARCH-SOME": 2 });
    assert.deepEqual(hidden((await run(stores, at("2026-10-27", 7, 30)))
      .report), [], "told, and done for the day");
  });

  it("is not muted by an invariants alert in the last hour", async () => {
    const stores = testStores();

    await mark(stores, "alert/jobs.invariants", { muted: 0 },
      at("2026-10-27", 6, 50));

    const { sent } = await run(stores, at("2026-10-27", 7));

    assert.equal(alerts(sent).length, 1);
  });

  it("asks again next run when Square doesn't answer", async () => {
    const stores = testStores();
    const { mail } = mailer();
    const down = await runJobs(stores, {
      now: at("2026-10-27", 7), env: ENV, mail, catalogIndex: FIXTURE,
      inventory: async () => { throw new Error("Square 503"); },
    });

    assert.deepEqual(hidden(down), []);
    assert.equal((await run(stores, at("2026-10-27", 7, 15))).report
      .invariants.length, 2);
  });
});
