// A buying group's code (#471): typed into the code box, it unlocks
// the group's pickup, which the page lists nowhere until then, and the
// order is placed at it and paid. The group's place never appears in
// the page source. Runs on the local build with fake payments
// (bin/e2e/serve.mjs), where the back office mints the group's code
// if none is set; on staging it uses the code in force.

import { normalizeCode } from "../assets/scripts/order/lib/validate.mjs";
import {
  OrderPage, expect, paymentFakes as fakes, pickupValues, test,
  uniqueEmail,
} from "./support/order.mjs";
import { backOffice, op } from "./support/staging.mjs";

const GROUP = "vff";
const SERIES = "36TS";
const GYM = "The Village Family Fitness";

test.describe("a buying group's code (#471)", () => {
  test("unlocks the gym pickup and pays an order there",
    async ({ page, request }) => {
      test.skip(!backOffice().ready, "Needs the e2e back office.");
      test.skip(!(await fakes(request)).square, "SQUARE_ENV is not fake here");

      const { code } = await op("groupCode", { key: GROUP });
      const order = new OrderPage(page);
      const email = uniqueEmail("group");

      // Three whole chickens: $60, so the $50 tier shows as for anyone.
      await order.open({ whole: 3 }, { method: "scheduled" });

      // Nothing of the group is on the page before the code.
      const source = await page.content();

      expect(source).not.toContain(SERIES);
      expect(source).not.toContain("Venturi");
      expect(await pickupValues(page))
        .not.toContainEqual(expect.stringMatching(`^${SERIES}-`));

      // A wrong code says only that it isn't valid. /api/group holds an
      // address after 10 misses in 10 minutes (group.mjs, RATE), and
      // the whole suite shares one address, so only the specs about
      // codes send it real misses: one a project here, in cart-way and
      // in pricing. Others answer their misses in the browser
      // (delivery-pass), or this spec's code is refused on the next
      // project (#495).
      await order.codeOpen.click();
      await order.codeInput.fill("NOT-A-CODE");
      await order.codeApply.click();
      await expect(order.codeNote).toHaveText("That code isn't valid.");
      expect(await pickupValues(page))
        .not.toContainEqual(expect.stringMatching(`^${SERIES}-`));

      // The group's code asks first (#495, decision 5): Cancel leaves
      // it unapplied, Join group unlocks its pickup.
      const dialog = page.locator("#group-join");

      await order.codeInput.fill(code);
      await order.codeApply.click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("The group's host can see your " +
        "name and email address.");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      // The row stays open under the dialog: the code waits in the box
      // and the focus is back on Apply.
      await expect(order.codeApply).toBeFocused();
      await expect(order.codeInput).toHaveValue(normalizeCode(code));
      expect(await pickupValues(page))
        .not.toContainEqual(expect.stringMatching(`^${SERIES}-`));

      await order.codeApply.click();
      await dialog.getByRole("button", { name: "Join group" }).click();
      await expect(order.codeNote)
        .toHaveText("Code applied. Welcome to the group!");

      const round = await order.scheduled(SERIES);

      const chosen = `label[for='scheduled-${round.toLowerCase()}']`;

      await expect(page.locator(chosen)).toContainText(GYM);
      // Priced at retail today: the member prices are the retail ones.
      await expect(order.discountLabel).toContainText("Bulk discount");

      await order.contact({ first: "Group", email });
      await order.openCard();
      await expect(page.locator("[data-fake-card]")).toBeVisible();

      const { status, body } = await order.pay();

      expect(status, JSON.stringify(body)).toBe(200);
      expect(body.fulfilment.occurrence).toBe(round);
      await expect(order.result).toBeVisible();
      await expect(order.result).toContainText(GYM);

      // The record carries the tag.
      const { order: placed } = await op("orderShow", { id: body.orderId });

      expect(placed.group).toEqual({
        key: GROUP, round: placed.fulfilment.date, viaCode: true,
      });

      await op("orderDelete", { id: body.orderId }, { allowFail: true });
      await op("customerDelete", { email }, { allowFail: true });
    });
});
