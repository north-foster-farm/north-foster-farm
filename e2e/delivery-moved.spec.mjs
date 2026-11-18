// Moving a week's delivery day (#640), on the order page: with
// `2026-11-25 delivery` in the farm's schedule and the clock on
// Thursday 2026-11-19, the Delivery day list offers Wednesday,
// November 25 and then Thursday, December 3, not the 26th, and the
// countdown notice names Wednesday. Criteria tests, written before the
// change; the unit tests and the contract are in
// test/delivery-moved.criteria.mjs.
//
// /api/dates is answered as the server would answer with the move:
// the real lib/dates.mjs over the parsed line, the schedule carrying
// `deliveries` as pickupSchedule() does, and the server's clock, which
// the page anchors to.

import { readFileSync } from "node:fs";

import { OrderPage, expect, test } from "./support/order.mjs";
import { dates } from "./support/canned.mjs";
import { deliveryDates } from "../assets/scripts/order/lib/dates.mjs";
import { parseSchedule } from "../assets/scripts/order/lib/schedule.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const TERMS = JSON.parse(readFileSync(
  new URL("../data/delivery.json", import.meta.url), "utf8",
));
const NOW = instant("2026-11-19", 9, 0, "America/New_York");

const answer = () => {
  const parsed = parseSchedule("2026-11-25 delivery");
  const schedule = Object.assign([], {
    lines: [], deliveries: parsed.deliveries,
  });

  return {
    ...dates(),
    now: NOW.toISOString(),
    delivery: deliveryDates(NOW, TERMS, undefined, schedule),
  };
};

const SIZES = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 900 },
};

test.describe("a moved delivery week on the order page (#640)", () => {
  for (const [name, size] of Object.entries(SIZES)) {
    test(`offers Wednesday, November 25 and names it in the notice, on ${
      name}`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.route("**/api/dates",
        (route) => route.fulfill({ json: answer() }));

      const order = new OrderPage(page);

      await order.open({ eggs: 1 }, { method: "delivery" });

      const select = page.locator("#delivery-date");

      await expect(select).toBeEnabled();

      const options = await select.locator("option").evaluateAll((list) =>
        list.filter((o) => o.value)
          .map((o) => [o.value, o.textContent.trim()]));

      expect(options.map(([value]) => value))
        .toEqual(["2026-11-25", "2026-12-03"]);
      expect(options[0][1]).toContain("Wednesday, November 25");
      expect(options[1][1]).toContain("Thursday, December 3");

      const notice = page.locator("[data-countdown-text]");

      await expect(notice).toBeVisible();
      await expect(notice).toContainText("for delivery on Wednesday");
      await expect(notice).not.toContainText("Thursday");
    });
  }
});
