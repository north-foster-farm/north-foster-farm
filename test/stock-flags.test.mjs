// A variation flagged hiatus or discontinued with stock in Square
// (#499): the jobs' daily invariant and its alert. Square's answer is
// replayed from test/fixtures/square/inventory-counts-flagged.json
// through the real inventory read.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { indexCatalog } from "../assets/scripts/order/lib/catalog.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import {
  FLAGGED_TOLD, STOCK_FLAGS_HOUR, runJobs,
} from "../netlify/functions/lib/jobs.mjs";
import { mark } from "../netlify/functions/lib/health.mjs";
import { inventoryCounts } from "../netlify/functions/lib/square.mjs";
import {
  flaggedCounts, flaggedInStock,
} from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";

const TZ = "America/New_York";
const at = (iso, h, m = 0) => instant(iso, h, m, TZ);

const fixture = JSON.parse(readFileSync(new URL(
  "./fixtures/square/inventory-counts-flagged.json", import.meta.url,
), "utf8"));

const SQUARE = {
  SQUARE_ACCESS_TOKEN: "tok", SQUARE_LOCATION_ID: "<LOCATION_ID>",
  SQUARE_ENV: "production",
};
const ENV = { DEV_NOTIFICATIONS_EMAIL: "dev@x.com" };

const item = (sku, restock) => ({
  sku, name: sku, label: sku, price: 1, inStock: true, restock,
  squareVariationId: `VAR-${sku}`,
});

export const FIXTURE = indexCatalog({
  groups: [{
    key: "cuts", label: "Cuts", lines: "name",
    items: [
      item("HIATUS-ZERO", "hiatus"),
      item("HIATUS-SOME", "hiatus"),
      item("DISC-SOME", "discontinued"),
      item("PLAIN-SOME", "seasonal"),
    ],
  }],
});

// The real read, answered by the recording. `counts` changes a SKU's
// quantity, as the farm would in Square. -> { inventory, asked }.
export const replay = (counts = {}) => {
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

describe("flaggedCounts (#499)", () => {
  it("asks Square for the flagged variations alone", async () => {
    const { inventory, asked } = replay();

    await flaggedCounts({ catalogIndex: FIXTURE, inventory });
    assert.deepEqual(asked,
      [["VAR-HIATUS-ZERO", "VAR-HIATUS-SOME", "VAR-DISC-SOME"]]);
  });

  it("names each flagged one with its flag and count, and passes one " +
    "at 0", async () => {
    const list = await flaggedCounts({
      catalogIndex: FIXTURE, inventory: replay().inventory,
    });

    assert.deepEqual(list.map((i) => [i.sku, i.restock, i.count]), [
      ["HIATUS-ZERO", "hiatus", 0],
      ["HIATUS-SOME", "hiatus", 3],
      ["DISC-SOME", "discontinued", 2],
    ]);
    assert.deepEqual(flaggedInStock(list).map((i) => i.sku),
      ["HIATUS-SOME", "DISC-SOME"]);
  });

  it("ignores an unflagged one, whatever Square counts", async () => {
    const list = await flaggedCounts({
      catalogIndex: FIXTURE, inventory: replay().inventory,
    });

    assert.equal(list.some((i) => i.sku === "PLAIN-SOME"), false);
  });

  it("is null when Square doesn't answer", async () => {
    assert.equal(await flaggedCounts({
      catalogIndex: FIXTURE,
      inventory: async () => { throw new Error("Square 503"); },
    }), null);
  });
});

describe("the stock.flagged invariant (#499)", () => {
  const run = (stores, now, counts) => {
    const { sent, mail } = mailer();

    return runJobs(stores, {
      now, env: ENV, mail, catalogIndex: FIXTURE,
      inventory: replay(counts).inventory,
    }).then((report) => ({ report, sent }));
  };
  const flagged = (report) => report.invariants
    .filter((v) => v.rule === "stock.flagged");

  it("names each flagged SKU above 0 with its flag and count, and " +
    "alerts", async () => {
    const stores = testStores();
    const { report, sent } = await run(stores, at("2026-10-27", 7));

    assert.deepEqual(flagged(report), [
      { rule: "stock.flagged", id: "HIATUS-SOME", restock: "hiatus",
        count: 3 },
      { rule: "stock.flagged", id: "DISC-SOME", restock: "discontinued",
        count: 2 },
    ]);
    assert.equal(alerts(sent).length, 1);
    assert.deepEqual(alerts(sent)[0].to, ["dev@x.com"]);
    assert.match(alerts(sent)[0].text, /HIATUS-SOME.+hiatus.+3/);
    assert.match(alerts(sent)[0].text, /DISC-SOME.+discontinued.+2/);
    assert.doesNotMatch(alerts(sent)[0].text, /HIATUS-ZERO|PLAIN-SOME/);
  });

  it("is quiet when every flagged one is at 0", async () => {
    const { report, sent } = await run(testStores(), at("2026-10-27", 7),
      { "HIATUS-SOME": 0, "DISC-SOME": 0 });

    assert.deepEqual(flagged(report), []);
    assert.equal(alerts(sent).length, 0);
  });

  it("waits for 07:00, then reads once a day", async () => {
    const stores = testStores();
    const early = await run(stores, at("2026-10-27", STOCK_FLAGS_HOUR - 1));

    assert.deepEqual(flagged(early.report), []);
    assert.equal((await run(stores, at("2026-10-27", 7))).report
      .invariants.length, 2);
    assert.deepEqual(flagged((await run(stores, at("2026-10-27", 7, 15)))
      .report), [], "done for the day");
  });

  it("alerts once per SKU and count", async () => {
    const stores = testStores();

    await run(stores, at("2026-10-27", 7));

    const same = await run(stores, at("2026-10-28", 7));

    assert.deepEqual(flagged(same.report), [], "same counts, next day");
    assert.equal(alerts(same.sent).length, 0);

    const moved = await run(stores, at("2026-10-29", 7),
      { "HIATUS-SOME": 4 });

    assert.deepEqual(flagged(moved.report).map((v) => [v.id, v.count]),
      [["HIATUS-SOME", 4]], "a new count is told; the other is not");
    assert.equal(alerts(moved.sent).length, 1);

    await run(stores, at("2026-10-30", 7),
      { "HIATUS-SOME": 4, "DISC-SOME": 0 });

    const back = await run(stores, at("2026-10-31", 7), { "HIATUS-SOME": 4 });

    assert.deepEqual(flagged(back.report).map((v) => [v.id, v.count]),
      [["DISC-SOME", 2]], "back above 0 after 0 is told again");
    assert.deepEqual((await stores.jobs.get(FLAGGED_TOLD)).counts,
      { "HIATUS-SOME": 4, "DISC-SOME": 2 });
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

    assert.deepEqual(flagged(down), []);
    assert.equal((await run(stores, at("2026-10-27", 7, 15))).report
      .invariants.length, 2);
  });
});
