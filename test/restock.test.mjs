// Restock types (#267): stock wins over every type but archived, an
// archived product is never sold, and one that stock shows on hand
// is reported to the farm (FARM_NOTIFICATIONS_EMAIL only), once a
// product a day, and in every morning report until resolved.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../netlify/functions/lib/terms.mjs";
import { checkOrder } from "../bin/schema/check.mjs";
import {
  archived, indexCatalog,
} from "../assets/scripts/order/lib/catalog.mjs";
import { showRows } from "../assets/scripts/order/restock.js";
import { withStock } from "../assets/scripts/order/schema.js";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { runJobs } from "../netlify/functions/lib/jobs.mjs";
import {
  archivedInStock, archivedKey, availability, setCount,
} from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/stock.mjs";
import { orderConfirmed } from "../netlify/functions/lib/templates.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";

const TZ = "America/New_York";
const at = (iso, h, m = 0) => instant(iso, h, m, TZ);

const ENV = {
  FARM_NOTIFICATIONS_EMAIL: "farm@x.com",
  DEV_NOTIFICATIONS_EMAIL: "dev@x.com",
};

// One product of each type, all flagged in stock in the catalog.
const TYPES = [
  "seasonal", "soon", "hiatus", "discontinued", "hidden", "archived",
];
const FIXTURE = indexCatalog({
  groups: [{
    key: "cuts", label: "Cuts",
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

  it("are one of the six on every product", () => {
    for (const item of items) {
      assert.ok(TYPES.includes(item.restock), item.sku);
    }
  });

  // #267's assignments with James's corrections (#274, 6330468558),
  // and the tiers #492 hides while empty, every other tier back next
  // season.
  it("follow the spec's assignments", () => {
    const SPEC = {
      "NFF-CHK-EGG-LG": "soon",
      "NFF-CHK-EGG-MD": "hiatus",
      "NFF-CHK-EGG-SM": "hiatus",
      "NFF-CHK-WHL-45-49": "hidden",
      "NFF-CHK-WHL-50-59": "hidden",
      "NFF-CHK-WHL-60-69": "hidden",
      "NFF-CHK-WHL-70-79": "hidden",
      "NFF-CHK-BRSBL-17-99": "hidden",
      "NFF-CHK-THGBN-20-99": "hidden",
      "NFF-CHK-WNG-30-99": "hidden",
      "NFF-CHK-FET-0075-0125": "soon",
    };

    for (const i of of("sausage")) SPEC[i.sku] = "hiatus";
    // Ground chicken was never sold (6304873363); Cornish hens are
    // discontinued and archived (6305037316).
    for (const i of [...of("ground"), ...of("cornish")]) {
      SPEC[i.sku] = "archived";
    }
    for (const i of items) {
      const want = SPEC[i.sku] || "seasonal";

      assert.equal(i.restock, want, i.sku);
      assert.equal(i.restockSeason, want === "seasonal" ? "spring"
        : undefined, i.sku);
    }
  });

  // A hidden tier is flagged in stock, so Square's count decides: the
  // whole birds from 5.0 lbs sat out while Square held them (#492).
  it("flag every hidden tier in stock", () => {
    for (const i of items.filter((x) => x.restock === "hidden")) {
      assert.equal(i.inStock, true, i.sku);
    }
  });
});

describe("availability by restock type", () => {
  it("lets stock win over every type but archived", async () => {
    const stores = testStores();
    const items = await availability(stores, { catalogIndex: FIXTURE });

    for (const type of ["SEASONAL", "SOON", "HIATUS", "DISCONTINUED",
      "HIDDEN", "PLAIN"]) {
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
    const sku = "NFF-CHK-WHL-35-39";
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
    assert.equal(validateOrder(payload, ctx).errors[`lines.${sku}`],
      "Whole Chicken, 3.5 – 3.9 lbs is not available.");

    // A paid order being changed keeps what it holds, never more.
    assert.ok(validateOrder(payload, { ...ctx, held: { [sku]: 2 } }).ok);
    assert.ok(!validateOrder(payload, { ...ctx, held: { [sku]: 1 } }).ok);
  });
});

// A tier hidden when empty (#492): off the order page, Full catalog
// and the Product markup while Square shows none, selling normally
// once it does, and named as any line on a past order.
describe("a hidden product", () => {
  const SKU = "NFF-CHK-WHL-50-59";
  const NAME = "Whole Chicken, 5.0 – 5.9 lbs";

  // A row as order/row.html writes it and order/stock.js marks it.
  const row = (out) => ({
    dataset: { restockLabel: "" },
    hidden: false,
    hasAttribute: (name) => name === "data-out" && out,
  });
  const shown = (r, only) => {
    showRows({ querySelectorAll: (s) => (s === ".order-item" ? [r] : []) },
      only);

    return !r.hidden;
  };

  it("is out at a count of 0 and in above it", async () => {
    const stores = testStores();

    await setCount(stores, "HIDDEN", 0);
    assert.equal((await availability(stores, { catalogIndex: FIXTURE }))
      .HIDDEN.inStock, false);
    await setCount(stores, "HIDDEN", 3);
    assert.deepEqual((await availability(stores, { catalogIndex: FIXTURE }))
      .HIDDEN, { inStock: true, available: 3 });
  });

  it("has no row while out, under either Show choice", () => {
    assert.equal(shown(row(true), true), false, "In stock");
    assert.equal(shown(row(true), false), false, "Full catalog");
    assert.equal(shown(row(false), true), true, "in stock, In stock");
    assert.equal(shown(row(false), false), true, "in stock, Full catalog");
  });

  it("leaves the Product markup while out and comes back", () => {
    const product = (sku) => ({
      "@type": "Product", sku,
      offers: { availability: "https://schema.org/InStock" },
    });
    const built = () => ({
      "@graph": [product(SKU), product("NFF-CHK-WHL-40-44")],
    });
    const hidden = new Set([SKU]);
    const skus = (data) => data["@graph"].map((n) => n.sku);
    const out = withStock(built(), {
      [SKU]: { inStock: false }, "NFF-CHK-WHL-40-44": { inStock: false },
    }, hidden);

    assert.deepEqual(skus(out), ["NFF-CHK-WHL-40-44"]);
    assert.equal(withStock(built(), { [SKU]: { inStock: true } }, hidden),
      null, "in stock, it stays as built");
    // A type that only labels stays in the markup, out of stock.
    assert.deepEqual(skus(withStock(built(), { [SKU]: { inStock: false } })),
      [SKU, "NFF-CHK-WHL-40-44"]);
  });

  it("is not wanted in the built markup while flagged out", () => {
    const item = { ...indexCatalog(catalog).get(SKU) };
    const graph = (...skus) => ({
      "@graph": skus.map((sku) => ({
        "@type": "Product", sku, offers: { price: String(item.price) },
      })),
    });

    assert.deepEqual(checkOrder(graph(SKU), [item]), []);
    item.inStock = false;
    assert.deepEqual(checkOrder(graph(), [item]), []);
  });

  it("is named on a past order's receipt", () => {
    const m = orderConfirmed({
      id: "NFF-2610-ABCD", status: "paid",
      customer: { name: "Pat Example", email: "pat@example.com" },
      lines: [{ sku: SKU, label: NAME, qty: 1, lineTotal: 46 }],
      totals: { subtotal: 4600, total: 4600 },
      fulfilment: {
        method: "onfarm", date: "2026-10-08",
        onfarm: { window: MORNING, from: "09:00", to: "12:00" },
      },
      payment: { via: "square", method: "card" },
    }, { links: {} });

    assert.match(m.text, new RegExp(`^- 1 × ${NAME}$`, "m"));
  });

  it("stays on a paid order being changed while out", () => {
    const index = indexCatalog(catalog);

    index.set(SKU, { ...index.get(SKU), inStock: false });
    const ctx = {
      index, terms, now: at("2026-10-06", 9),
      schedule: parseSchedule(SCHEDULE).windows,
    };
    const payload = {
      customer: {
        firstName: "Pat", lastName: "Example", email: "pat@example.com",
        phone: "401-555-0100", contact: "text",
      },
      lines: [{ sku: SKU, qty: 1 }],
      fulfilment: {
        method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
      },
      claimedTotal: 4600,
    };

    assert.ok(!validateOrder(payload, ctx).ok, "not sold while out");
    assert.ok(validateOrder(payload, { ...ctx, held: { [SKU]: 1 } }).ok);
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
