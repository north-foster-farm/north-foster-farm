// Line names (#267): "Group, label" everywhere but Other Items, whose
// lines take each item's own name ("Livers, 1.0 – 1.4 lbs"), in the
// cart, the stored order, the emails and the errors.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../data/delivery.json" with { type: "json" };
import { indexCatalog, short } from "../assets/scripts/order/lib/catalog.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import { itemGroups } from "../assets/scripts/order/lib/summary.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { checkLines, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";

const index = indexCatalog(catalog);
const LIVERS = "NFF-CHK-LVR-0075-0125";
const FEET = "NFF-CHK-FET-0075-0125";
const WINGS = "NFF-CHK-WNG-0000-0200";

describe("line names", () => {
  it("are Group, label in every group but Other Items", () => {
    for (const group of catalog.groups) {
      if (group.key === "other") continue;
      for (const item of group.items) {
        const got = index.get(item.sku);

        assert.equal(got.lineName, `${short(group.label)}, ${item.label}`);
        assert.equal(got.row, item.label);
      }
    }
    assert.equal(index.get(WINGS).lineName, "Wings, 1.0 – 1.9 lbs");
    assert.equal(index.get("NFF-CHK-SAUMPL-0075-0125").lineName,
      "Chicken Sausage, Maple breakfast links");
  });

  it("are the item's own name in Other Items", () => {
    const names = catalog.groups.find((g) => g.key === "other").items
      .map((i) => index.get(i.sku).lineName);

    assert.deepEqual(names, ["Livers, 1.0 – 1.4 lbs", "Necks, 1.0 – 1.9 lbs",
      "Feet, 1 lb avg.", "Backs, 1.0 – 1.9 lbs"]);
    assert.equal(index.get(LIVERS).row, "Livers, 1.0 – 1.4 lbs");
  });

  it("reach the grouped cart under the group's own heading", () => {
    const [group] = itemGroups([{ sku: LIVERS, qty: 1 }], index);

    assert.equal(group.label, "Other Items");
    assert.equal(group.items[0].row, "Livers, 1.0 – 1.4 lbs");
    assert.equal(group.items[0].lineName, "Livers, 1.0 – 1.4 lbs");
  });

  describe("in an order", () => {
    const ctx = {
      index, terms,
      now: instant("2026-10-06", 9, 0, "America/New_York"),
      schedule: parseSchedule(SCHEDULE).windows,
    };
    const order = (lines) => validateOrder({
      customer: {
        firstName: "Pat", lastName: "Example", email: "pat@example.com",
        phone: "401-555-0100", contact: "text",
      },
      lines,
      fulfilment: {
        method: "onfarm", date: "2026-10-07", onfarm: { window: MORNING },
      },
      claimedTotal: 0,
    }, ctx);

    it("store the line name as the line's label", () => {
      const r = order([{ sku: LIVERS, qty: 1 }, { sku: WINGS, qty: 1 }]);

      assert.ok(r.ok, JSON.stringify(r.errors));
      assert.deepEqual(r.order.lines.map((l) => l.label),
        ["Livers, 1.0 – 1.4 lbs", "Wings, 1.0 – 1.9 lbs"]);
    });

    it("name a sold-out line", () => {
      const r = order([{ sku: FEET, qty: 1 }]);

      assert.equal(r.errors[`lines.${FEET}`],
        "Feet, 1 lb avg. is sold out.");
    });

    it("name a line stock can't fill", async () => {
      const stores = testStores();

      await setCount(stores, LIVERS, 0);
      const { errors } = await checkLines(stores, [{ sku: LIVERS, qty: 1 }]);

      assert.equal(errors[`lines.${LIVERS}`],
        "Livers, 1.0 – 1.4 lbs just sold out.");
    });
  });
});
