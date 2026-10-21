// Restock types (#267): stock wins over every type but archived, an
// archived product is never sold, and one that stock shows on hand
// is reported to the farm (FARM_NOTIFICATIONS_EMAIL only), once a
// product a day, and in every morning report until resolved.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../data/delivery.json" with { type: "json" };
import {
  archived, indexCatalog,
} from "../assets/scripts/order/lib/catalog.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import {
  archivedInStock, archivedKey, availability, setCount,
} from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/stock.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";

const TZ = "America/New_York";
const at = (iso, h, m = 0) => instant(iso, h, m, TZ);

const ENV = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
};

// One product of each type, all flagged in stock in the catalog.
const TYPES = ["seasonal", "soon", "hiatus", "discontinued", "archived"];
const FIXTURE = indexCatalog({
  groups: [{
    key: "cuts", label: "Cuts", unit: "per pack",
    items: [
      ...TYPES.map((restock) => ({
        sku: restock.toUpperCase(), label: restock, price: 10,
        inStock: true, restock,
        ...(restock === "seasonal" ? { restockSeason: "spring" } : {}),
      })),
      { sku: "PLAIN", label: "plain", price: 10, inStock: true },
    ],
  }],
});

const mailer = () => {
  const sent = [];

  return {
    sent,
    mail: async (m) => {
      sent.push(m);

      return { id: `m${sent.length}`, driver: "test" };
    },
  };
};

describe("the catalog's restock types", () => {
  const items = [...indexCatalog(catalog).values()];
  const of = (key) => items.filter((i) => i.groupKey === key);

  it("are one of the five on every product", () => {
    for (const item of items) {
      assert.ok(TYPES.includes(item.restock), item.sku);
    }
  });

  it("follow the spec's assignments", () => {
    for (const i of of("sausage")) assert.equal(i.restock, "hiatus");
    for (const i of of("eggs")) assert.equal(i.restock, "soon");
    // Ground chicken was never sold (6304873363); Cornish hens are
    // discontinued and archived (6305037316).
    for (const i of [...of("ground"), ...of("cornish")]) {
      assert.equal(i.restock, "archived", i.sku);
      assert.equal(i.restockSeason, undefined, i.sku);
    }
    for (const i of items.filter((x) =>
      !["cornish", "sausage", "eggs", "ground"].includes(x.groupKey))) {
      assert.equal(i.restock, "seasonal", i.sku);
      assert.equal(i.restockSeason, "spring", i.sku);
    }
  });
});

describe("availability by restock type", () => {
  it("lets stock win over every type but archived", async () => {
    const stores = testStores();
    const items = await availability(stores, { catalogIndex: FIXTURE });

    for (const type of ["SEASONAL", "SOON", "HIATUS", "DISCONTINUED",
      "PLAIN"]) {
      assert.equal(items[type].inStock, true, type);
    }
    assert.equal(items.ARCHIVED.inStock, false);
  });

  it("is out at a count of 0, whatever the type", async () => {
    const stores = testStores();

    for (const type of TYPES) await setCount(stores, type.toUpperCase(), 0);
    const items = await availability(stores, { catalogIndex: FIXTURE });

    for (const type of TYPES) {
      assert.equal(items[type.toUpperCase()].inStock, false, type);
    }
  });

  it("never sells an archived product", () => {
    const sku = "NFF-CHK-WHL-0350-0400";
    const index = indexCatalog(catalog);
    const item = index.get(sku);
    const ctx = {
      index, terms, now: at("2026-10-06", 9),
      schedule: parseSchedule(SCHEDULE).windows,
    };
    const payload = {
      customer: {
        firstName: "Pat", lastName: "Example", email: "pat@example.com",
        phone: "401-555-0100", contact: "text",
      },
      lines: [{ sku, qty: 2 }],
      fulfilment: {
        method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
      },
      claimedTotal: 5500,
    };

    assert.equal(item.inStock, true);
    assert.ok(validateOrder(payload, ctx).ok);

    index.set(sku, { ...item, restock: "archived" });
    assert.equal(archived(index.get(sku)), true);
    assert.match(validateOrder(payload, ctx).errors[`lines.${sku}`] || "",
      /sold out/);
  });
});

describe("an archived product stock has on hand", () => {
  it("is emailed to the farm alone, naming it and its count",
    async () => {
      const stores = testStores();
      const { sent, mail } = mailer();

      await setCount(stores, "ARCHIVED", 4);
      const res = await handle(new Request("https://x/api/stock"), {
        stores, env: ENV, mail, catalogIndex: FIXTURE,
        now: at("2026-10-20", 10),
      });

      assert.equal(res.status, 200);
      assert.equal((await res.json()).items.ARCHIVED.inStock, false);
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].to, ["farm@x.com"]);
      assert.equal(sent[0].subject, "Hidden but in stock: Cuts, archived");
      assert.match(sent[0].text, /Cuts, archived\s+ARCHIVED\s+4/);
      assert.doesNotMatch(JSON.stringify(sent[0]), /dev@x\.com/);
    });

  it("counts when flagged in stock and not counted", async () => {
    const { sent, mail } = mailer();

    await archivedInStock(testStores(), {
      env: ENV, mail, catalogIndex: FIXTURE, now: at("2026-10-20", 10),
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /in stock, not counted/);
  });

  it("goes once a product a day, not once a page load", async () => {
    const stores = testStores();
    const { sent, mail } = mailer();
    const read = (now) => handle(new Request("https://x/api/stock"), {
      stores, env: ENV, mail, catalogIndex: FIXTURE, now,
    });

    await setCount(stores, "ARCHIVED", 4);
    await read(at("2026-10-20", 10));
    await read(at("2026-10-20", 10, 1));
    await read(at("2026-10-20", 23, 59));
    assert.equal(sent.length, 1);
    assert.deepEqual((await stores.jobs.get(archivedKey("2026-10-20"))).skus,
      ["ARCHIVED"]);

    await read(at("2026-10-21", 0, 1));
    assert.equal(sent.length, 2, "again the next day, while unresolved");
  });

  it("tries again on the next read when the send fails", async () => {
    const stores = testStores();
    const { sent, mail } = mailer();
    let fail = true;
    const flaky = async (m) => {
      if (fail) throw new Error("Resend down");

      return mail(m);
    };
    const opts = {
      env: ENV, mail: flaky, catalogIndex: FIXTURE, now: at("2026-10-20", 10),
    };

    await setCount(stores, "ARCHIVED", 4);
    assert.deepEqual(await archivedInStock(stores, opts), []);
    fail = false;
    assert.equal((await archivedInStock(stores, opts)).length, 1);
    assert.equal(sent.length, 1);
  });

  it("is not raised for a product that is not archived", async () => {
    const stores = testStores();
    const { sent, mail } = mailer();
    const catalogIndex = new Map([...FIXTURE]
      .filter(([sku]) => sku !== "ARCHIVED"));

    for (const sku of catalogIndex.keys()) await setCount(stores, sku, 9);
    await handle(new Request("https://x/api/stock"), {
      stores, env: ENV, mail, catalogIndex, now: at("2026-10-20", 10),
    });
    assert.equal(sent.length, 0);
  });

  it("is not raised at a count of 0, or below", async () => {
    const { sent, mail } = mailer();

    for (const n of [0, -1]) {
      const stores = testStores();

      await setCount(stores, "ARCHIVED", n);
      await handle(new Request("https://x/api/stock"), {
        stores, env: ENV, mail, catalogIndex: FIXTURE,
        now: at("2026-10-20", 10),
      });
    }
    assert.equal(sent.length, 0);
  });

  it("is not raised by the real catalog, which archives nothing",
    async () => {
      const { sent, mail } = mailer();

      await archivedInStock(testStores(), {
        env: ENV, mail, now: at("2026-10-20", 10),
      });
      assert.equal(sent.length, 0);
    });

  it("is in the morning report until resolved", async () => {
    const stores = testStores();
    const { sent, mail } = mailer();
    const env = { ...ENV, PICKUP_SCHEDULE: SCHEDULE };
    const morning = async (day) => {
      await runJobs(stores, {
        env, mail, catalogIndex: FIXTURE, now: at(day, 8),
      });

      return sent.filter((m) => /Morning report/.test(m.subject)).at(-1);
    };

    await setCount(stores, "ARCHIVED", 4);
    const first = await morning("2026-10-05");

    assert.match(first.text, /Hidden but in stock/);
    assert.match(first.text, /Cuts, archived\s+ARCHIVED\s+4/);

    const second = await morning("2026-10-06");

    assert.match(second.text, /Hidden but in stock/, "still unresolved");

    await setCount(stores, "ARCHIVED", 0);
    const third = await morning("2026-10-07");

    assert.doesNotMatch(third.text, /Hidden but in stock/, "resolved");
  });
});
