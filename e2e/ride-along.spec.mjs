// A ride-along (#183) is a delivery the farm grants on a run it drives
// anyway: no fee, no minimum. Only the farm grants one, with a
// ride-along pass (bin/nff passes issue --ride-along) that the
// customer types in the code box. The page half cans /api/pass and the
// dates, so it runs on a local build as on staging and spends no pass;
// the API half checks that nothing a customer sends makes a delivery a
// ride-along without one. Issuing, the cap, the hold and the paid
// record are in test/passes.test.mjs.

import { randomUUID } from "node:crypto";

import { firstDate, postOrder } from "./support/api.mjs";
import { cannedDates } from "./support/canned.mjs";
import {
  OrderPage, SKU, expect, test, uniqueEmail,
} from "./support/order.mjs";

const PASS = "RYDE-AAAA";

// A delivery of `lines` that says it is a ride-along everywhere a
// customer could put it, with no pass. None of it should count.
const claimed = async (request, lines, claimedTotal) => ({
  customer: {
    firstName: "QA", lastName: "Ride", email: uniqueEmail("ride-along"),
    phone: "4015550100", contact: "text", marketing: false,
  },
  lines,
  fulfilment: {
    method: "delivery",
    date: await firstDate(request, "delivery"),
    delivery: {
      address1: "1 Test Lane", town: "Scituate", zip: "02857",
      cooler: "By the front steps",
    },
    onfarm: {},
    rideAlong: true,
  },
  rideAlong: true,
  code: "",
  claimedTotal,
  website: "",
  idempotencyKey: randomUUID(),
  attempt: 1,
  payment: { method: "card", sourceId: "cnon:card-nonce-ok" },
});

test.describe("ride-along deliveries (#183)", () => {
  test("a ride-along pass lifts the fee and the minimum",
    { tag: "@regression" }, async ({ page }) => {
      const order = new OrderPage(page);
      const apply = async (value) => {
        if (!await order.codeInput.isVisible()) await order.codeOpen.click();
        await order.codeInput.fill(value);
        await order.codeApply.click();
      };

      await page.route("**/api/pass?*", (route) => route.fulfill(
        new URL(route.request().url()).searchParams.get("code") === PASS
          ? { json: { ok: true, rideAlong: true } }
          : { status: 404, json: { ok: false, message: "Not a valid code." } }
      ));
      await cannedDates(page);
      await order.open({ eggs: 5 }, { method: "delivery" });
      await expect(order.fee).toHaveText("+$5");
      await expect(order.total).toHaveText("$40");
      await expect(order.short).toBeVisible();
      await expect(order.next).toBeDisabled();

      await apply(PASS.toLowerCase());
      await expect(order.codeNote).toContainText("ride-along delivery");
      await expect(order.fee).toHaveText("None (ride-along)");
      await expect(order.total).toHaveText("$35");
      await expect(order.short).toBeHidden();
      await expect(order.next).toBeEnabled();

      // Pickup has no fee to lift; back to delivery, it rides again.
      await order.method("onfarm");
      await expect(order.feeRow).toBeHidden();
      await order.method("delivery");
      await expect(order.fee).toHaveText("None (ride-along)");

      // Apply with the box empty takes the pass off again.
      await apply("");
      await expect(order.fee).toHaveText("+$5");
      await expect(order.short).toBeVisible();
    });

  // Both are refused before any payment is taken, and sent once: the
  // phone has nothing to add to an API answer.
  test("a payload's claim without a pass is ignored: the fee is charged",
    async ({ request }) => {
      test.skip(test.info().project.name !== "desktop", "desktop only");

      const { status, body } = await postOrder(request, await claimed(
        request, [{ sku: SKU.wings, qty: 4 }], 4000
      ));

      expect(status, JSON.stringify(body)).toBe(422);
      expect(body.errors.total).toBeTruthy();
      expect(body.totals.rideAlong).toBeFalsy();
      expect(body.totals).toMatchObject({ deliveryFee: 500, total: 4500 });
    });

  test("a payload's claim without a pass is ignored: the minimum holds",
    async ({ request }) => {
      test.skip(test.info().project.name !== "desktop", "desktop only");

      const { status, body } = await postOrder(request, await claimed(
        request, [{ sku: SKU.eggs, qty: 5 }], 3500
      ));

      expect(status, JSON.stringify(body)).toBe(422);
      expect(body.errors["delivery.minimum"])
        .toEqual(expect.stringContaining("$40 or more"));
    });
});
