// #182: a pass the farm issues, typed in the code box, lifts the
// delivery minimum, and the fee if it was issued so. To the customer
// it is a discount code like any other. /api/pass and the dates are
// canned, so this runs on a local build as on staging and spends no
// pass; the server's side (single use, the hold, standing passes, the
// fee in Square, POST /api/orders) is in test/passes.test.mjs.
//
// /api/group is canned too, as the miss it would answer: the page asks
// it first about any code of six characters or more, and four misses
// a project here drained its limit of 10 in 10 minutes from one
// address (group.mjs, RATE), which then refused the real code in
// group-code.spec.mjs on the next project (#495). Groups are not what
// this spec checks.

import catalog from "../data/catalog.json" with { type: "json" };
import terms from "../data/delivery.json" with { type: "json" };
import { cannedDates } from "./support/canned.mjs";
import { OrderPage, SKU, expect, test } from "./support/order.mjs";

// From the data, so the spec follows a new minimum (it goes to $50 on
// 1 January 2027) or a new price. One dozen eggs is under any minimum.
const { deliveryMinimum: MINIMUM, deliveryFee: FEE_DOLLARS } = terms.money;
const EGGS = catalog.groups.flatMap((g) => g.items)
  .find((i) => i.sku === SKU.eggs).price;

const PASS = "ABCD-EFGH";
const FEE = "WAVE-FEE2";

// What /api/group answers for a code that is no group's (group.mjs).
const noGroup = (page) => page.route("**/api/group",
  (route) => route.fulfill({
    status: 404, json: { ok: false, message: "That code isn't valid." },
  }));

test.describe("a delivery pass (#182)", () => {
  test("lets a small delivery through, and says why one fails",
    async ({ page }) => {
      const order = new OrderPage(page);
      const asked = [];

      await page.route("**/api/pass?*", (route) => {
        const code = new URL(route.request().url()).searchParams.get("code");

        asked.push(code);

        return code === PASS
          ? route.fulfill({ json: { ok: true, waivesFee: false } })
          : route.fulfill({
            status: 404,
            json: { ok: false, message: "That code isn't valid." },
          });
      });

      const apply = async (value) => {
        if (!await order.codeInput.isVisible()) await order.codeOpen.click();
        await order.codeInput.fill(value);
        await order.codeApply.click();
      };

      await noGroup(page);
      await cannedDates(page);
      await order.open({ eggs: 1 }, { method: "delivery" });
      await expect(order.short).toBeVisible();
      await expect(order.next).toBeDisabled();

      // A used pass: the page says only that it isn't valid, and
      // delivery stays blocked.
      await apply("wxyz-2345");
      await expect(order.codeNote).toHaveText("That code isn't valid.");
      await expect(order.short).toBeVisible();
      await expect(order.next).toBeDisabled();

      // A miss not shaped like a pass never asks the server.
      await apply("SPRING");
      await expect(order.codeNote).toHaveText("That code isn't valid.");
      expect(asked).toEqual(["WXYZ-2345"]);

      // A good one, typed without its dash.
      await apply("abcdefgh");
      await expect(order.codeNote).toHaveText(
        `Applied: this order can be delivered under the $${MINIMUM} minimum.`
      );
      await expect(order.short).toBeHidden();
      await expect(order.next).toBeEnabled();
      // It changes what the page accepts, not what it charges.
      await expect(order.total).toHaveText(`$${EGGS + FEE_DOLLARS}`);
    });

  // 6333306849: a code that waives the fee shows it at $0, and the
  // note says only "Applied." (James, on #182).
  test("a fee-waiving code takes the fee to $0", async ({ page }) => {
    const order = new OrderPage(page);

    await page.route("**/api/pass?*", (route) => route.fulfill({
      json: { ok: true, waivesFee: true },
    }));
    await noGroup(page);
    await cannedDates(page);
    await order.open({ eggs: 1 }, { method: "delivery" });
    await expect(order.fee).toHaveText(`+$${FEE_DOLLARS}`);
    if (!await order.codeInput.isVisible()) await order.codeOpen.click();
    await order.codeInput.fill(FEE);
    await order.codeApply.click();
    await expect(order.codeNote).toHaveText("Applied.");
    await expect(order.fee).toHaveText("$0");
    await expect(order.total).toHaveText(`$${EGGS}`);
    await expect(order.next).toBeEnabled();
  });
});
