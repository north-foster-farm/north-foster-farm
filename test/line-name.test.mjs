// Line names (#267): "Group, label" everywhere but Other Items, whose
// lines take each item's own name ("Livers, 1.0 – 1.4 lbs"), in the
// cart, the stored order, the emails and the errors.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../netlify/functions/lib/terms.mjs";
import {
  graded, indexCatalog, short,
} from "../assets/scripts/order/lib/catalog.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import { itemGroups } from "../assets/scripts/order/lib/summary.mjs";
import { validateOrder } from "../assets/scripts/order/lib/validate.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";
import { checkLines, setCount } from "../netlify/functions/lib/stock.mjs";
import { testStores } from "../netlify/functions/lib/store.mjs";
import { MORNING, SCHEDULE } from "./schedule-fixture.mjs";

const index = indexCatalog(catalog);
const LIVERS = "NFF-CHK-LVR-10-14";
// Out of stock in the catalog (hiatus), so the order is refused.
const SWEET = "NFF-CHK-SAUSWT";
const WINGS = "NFF-CHK-WNG-10-19";
const EGGS = "NFF-CHK-EGG-LG";

describe("line names", () => {
  it("are Group, label in every group but Other Items, with the "
    + "grade where the catalog gives one", () => {
    for (const group of catalog.groups) {
      if (group.key === "other") continue;
      for (const item of group.items) {
        const got = index.get(item.sku);

        assert.equal(got.lineName,
          `${short(group.label)}, ${graded(item)}`);
        assert.equal(got.row, graded(item));
      }
    }
    assert.equal(index.get(WINGS).lineName, "Wings, 1.0 – 1.9 lbs");
    assert.equal(index.get(EGGS).lineName, "Eggs, Grade A · Large");
    assert.equal(index.get(EGGS).row, "Grade A · Large");
    assert.equal(index.get(EGGS).note, "Grade A");
    assert.equal(index.get("NFF-CHK-SAUMPL").lineName,
      "Chicken Sausage, Maple breakfast links");
  });

  // Every egg has a grade, from the catalog's one `grade` (#300), in
  // its name (#336); nothing else has one.
  it("put each egg's grade in its name and no one else's", () => {
    const eggs = catalog.groups.find((g) => g.key === "eggs").items;

    assert.deepEqual(eggs.map((i) => index.get(i.sku).lineName), [
      "Eggs, Grade A · Large", "Eggs, Grade A · Medium",
      "Eggs, Grade A · Small",
    ]);
    for (const group of catalog.groups) {
      if (group.key === "eggs") continue;
      for (const item of group.items) assert.equal(item.grade, undefined);
    }
  });

  // Square's line takes the line name; other lines keep the catalog's
  // own name, which for the sausages differs from the line name.
  it("name the Square line with the grade", () => {
    assert.equal(index.get(EGGS).squareName, "Eggs, Grade A · Large");
    assert.equal(index.get("NFF-CHK-SAUMPL").squareName,
      "Maple Breakfast Sausage, Links");
    assert.equal(index.get(WINGS).squareName, index.get(WINGS).name);
  });

  it("are the item's own name in Other Items", () => {
    const names = catalog.groups.find((g) => g.key === "other").items
      .map((i) => index.get(i.sku).lineName);

    assert.deepEqual(names, ["Livers, 1.0 – 1.4 lbs", "Necks, 1.0 – 1.9 lbs",
      "Feet, 1.0 – 1.4 lbs", "Backs, 1.0 – 1.9 lbs"]);
    assert.equal(index.get(LIVERS).row, "Livers, 1.0 – 1.4 lbs");
  });

  it("reach the grouped cart under the group's own heading", () => {
    const [group] = itemGroups([{ sku: LIVERS, qty: 1 }], index);

    assert.equal(group.label, "Other Items");
    assert.equal(group.items[0].row, "Livers, 1.0 – 1.4 lbs");
    assert.equal(group.items[0].lineName, "Livers, 1.0 – 1.4 lbs");
  });

  it("show the egg grade in the cart (#336)", () => {
    const [group] = itemGroups([{ sku: EGGS, qty: 1 }], index);

    assert.equal(group.label, "Eggs");
    assert.equal(group.items[0].note, undefined);
    assert.equal(group.items[0].row, "Grade A · Large");
    assert.equal(group.items[0].lineName, "Eggs, Grade A · Large");
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
      const r = order([
        { sku: LIVERS, qty: 1 }, { sku: WINGS, qty: 1 }, { sku: EGGS, qty: 1 },
      ]);

      assert.ok(r.ok, JSON.stringify(r.errors));
      assert.deepEqual(r.order.lines.map((l) => l.label), [
        "Livers, 1.0 – 1.4 lbs", "Wings, 1.0 – 1.9 lbs",
        "Eggs, Grade A · Large",
      ]);
      // The stored label and Square's name both carry the grade (#300,
      // Rhode Island wants it on the invoice) in the one line name.
      assert.equal(r.order.lines[2].name, "Eggs, Grade A · Large");
    });

    it("name a sold-out line", () => {
      const r = order([{ sku: SWEET, qty: 1 }]);

      assert.equal(r.errors[`lines.${SWEET}`],
        "Chicken Sausage, Sweet Italian links: out of stock.");
    });

    it("name a line stock can't fill", async () => {
      const stores = testStores();

      await setCount(stores, LIVERS, 0);
      const { errors } = await checkLines(stores, [{ sku: LIVERS, qty: 1 }]);

      assert.equal(errors[`lines.${LIVERS}`],
        "Livers, 1.0 – 1.4 lbs: out of stock.");
    });
  });
});
