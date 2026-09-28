// #182: a pass the farm issues, typed in the code box, lifts the
// delivery minimum for one order. /api/pass and the dates are canned,
// so this runs on a local build as on staging and spends no pass; the
// server's side (single use, the hold, POST /api/orders) is in
// test/passes.test.mjs.

import { cannedDates } from "./support/canned.mjs";
import { OrderPage, expect, test } from "./support/order.mjs";

const PASS = "ABCD-EFGH";

test.describe("a delivery pass (#182)", () => {
  test("lets a small delivery through, and says why one fails",
    async ({ page }) => {
      const order = new OrderPage(page);
      const asked = [];

      await page.route("**/api/pass?*", (route) => {
        const code = new URL(route.request().url()).searchParams.get("code");

        asked.push(code);

        return code === PASS
          ? route.fulfill({ json: { ok: true } })
          : route.fulfill({
            status: 404,
            json: { ok: false, message: "That code has already been used." },
          });
      });

      const apply = async (value) => {
        if (!await order.codeInput.isVisible()) await order.codeOpen.click();
        await order.codeInput.fill(value);
        await order.codeApply.click();
      };

      await cannedDates(page);
      await order.open({ eggs: 5 }, { method: "delivery" });
      await expect(order.short).toBeVisible();
      await expect(order.next).toBeDisabled();

      // A used pass: the page says why, and delivery stays blocked.
      await apply("wxyz-2345");
      await expect(order.codeNote)
        .toHaveText("That code has already been used.");
      await expect(order.short).toBeVisible();
      await expect(order.next).toBeDisabled();

      // A miss not shaped like a pass never asks the server.
      await apply("SPRING");
      await expect(order.codeNote).toHaveText("Not a valid discount code.");
      expect(asked).toEqual(["WXYZ-2345"]);

      // A good one, typed without its dash.
      await apply("abcdefgh");
      await expect(order.codeNote).toContainText("under the $40 minimum");
      await expect(order.short).toBeHidden();
      await expect(order.next).toBeEnabled();
      // It changes what the page accepts, not what it charges.
      await expect(order.total).toHaveText("$40");
    });
});
