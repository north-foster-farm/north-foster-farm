// Pricing as the cart shows it: bulk tiers, the delivery fee and its
// waiver, the $40 minimum, the outside-area fee and discount codes.
// Every figure is a whole dollar. docs/qa-launch.md, "Pricing and
// discounts". The same rules are unit-tested in lib/totals.mjs; these
// check that the page says them.

import { OrderPage, expect, test } from "./support/order.mjs";

// [cart, subtotal, discount label or null, discount, delivery fee,
// total with Delivery chosen]. Wings $10, eggs $7, thighs $12.
const TIERS = [
  [{ eggs: 7 }, "$49", null, null, "+$5", "$54"],
  [{ wings: 5 }, "$50", "Bulk discount ($50+)", "−$5", "+$5", "$50"],
  [{ wings: 10 }, "$100", "Bulk discount ($100+)", "−$10", "+$5", "$95"],
  [{ wings: 13, eggs: 1, thighs: 1 }, "$149", "Bulk discount ($100+)",
    "−$10", "+$5", "$144"],
  [{ wings: 15 }, "$150", "Bulk discount ($150+)", "−$15", "Free", "$135"],
  [{ wings: 20 }, "$200", "Bulk discount ($200+)", "−$20", "Free", "$180"],
  [{ wings: 25 }, "$250", "Bulk discount ($200+)", "−$20", "Free", "$230"],
];

test.describe("pricing and discounts", () => {
  for (const [cart, subtotal, label, off, fee, total] of TIERS) {
    test(`${subtotal} of goods by delivery: ${off || "no discount"}, fee ${
      fee}, total ${total}`, { tag: "@regression" }, async ({ page }) => {
      const order = new OrderPage(page);

      await order.open(cart);
      await expect(order.subtotal).toHaveText(subtotal);
      if (label) {
        await expect(order.discountRow).toBeVisible();
        await expect(order.discountLabel).toHaveText(label);
        await expect(order.discount).toHaveText(off);
      } else {
        await expect(order.discountRow).toBeHidden();
      }
      await expect(order.fee).toHaveText(fee);
      await expect(order.total).toHaveText(total);
    });
  }

  test("pickup and the drop site carry no fee", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ eggs: 7 });
    await order.method("onfarm");
    await expect(order.feeRow).toBeHidden();
    await expect(order.total).toHaveText("$49");
    await order.method("scituate");
    await expect(order.feeRow).toBeHidden();
    await expect(order.total).toHaveText("$49");
  });

  test("the badges light as the tiers are reached", async ({ page }) => {
    const order = new OrderPage(page);
    const badge = (key) => order.cart.locator(`[data-badge='${key}']`);

    await order.open({ wings: 15 });
    for (const key of ["delivery", "free-delivery", "tier-50", "tier-100",
      "tier-150"]) {
      await expect(badge(key)).toHaveAttribute("data-on", "true");
    }
    await expect(badge("tier-200")).toHaveAttribute("data-on", "false");
  });

  test("the nudge names the next tier, and says nothing at the top",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open({ wings: 10 });
      await expect(order.nudge).toHaveText(
        "Next discount: add $50 for $15 off and free delivery."
      );
      await order.method("onfarm");
      await expect(order.nudge).toHaveText(
        "Next discount: add $50 for $15 off."
      );
      await order.qty("wings").fill("20");
      await order.qty("wings").blur();
      await expect(order.total).toHaveText("$180");
      await expect(order.nudge).toBeHidden();
    });

  test("exactly $40 meets the delivery minimum", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ wings: 4 });
    await expect(order.short).toBeHidden();
    await expect(order.next).toBeEnabled();
    await expect(order.fee).toHaveText("+$5");
    await expect(order.total).toHaveText("$45");
    await expect(order.cart.locator("[data-badge='delivery']"))
      .toHaveAttribute("data-on", "true");
  });

  test("$35 by delivery is short; the drop site takes it",
    { tag: "@regression" }, async ({ page }) => {
      const order = new OrderPage(page);

      await order.open({ eggs: 5 });
      await expect(order.nudge).toHaveText(
        "Add $5 to reach the $40 delivery minimum."
      );
      await expect(order.short).toHaveText(
        "You need $40 or more in your cart to use this option. Add $5 more."
      );
      await expect(order.next).toBeDisabled();
      await order.method("scituate");
      await expect(order.short).toBeHidden();
      await expect(order.next).toBeEnabled();
      await expect(order.total).toHaveText("$35");
    });

  test("an unlisted Rhode Island ZIP adds $3, never waived",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open({ wings: 5 });
      // 02830 (Harrisville) is in Rhode Island but not on the list.
      await order.zip.fill("02830");
      await expect(order.fee).toHaveText("+$8");
      await expect(order.total).toHaveText("$53");
      await order.qty("wings").fill("15");
      await order.qty("wings").blur();
      await expect(order.fee).toHaveText("+$3");
      await expect(order.total).toHaveText("$138");
      await order.zip.fill("02857");
      await expect(order.fee).toHaveText("Free");
      await expect(order.total).toHaveText("$135");
    });

  test("the unlisted-ZIP note states the fee in dollars and charges now",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open({ wings: 5 });
      await order.zip.fill("02830");
      await expect(order.zipNote).toContainText("A little outside our usual");
      // The fee is money: "$3 more", not "3 more".
      await expect(order.zipNote).toContainText("$3");
      // The card is charged on this page, with the fee in the total;
      // nothing is confirmed "before we charge you" any more.
      await expect(order.zipNote).not.toContainText("before we charge you");
    });

  test("the delivery policy's ZIP check hedges the same way",
    async ({ page }) => {
      const check = page.locator("[data-zip-check]").first();

      await page.goto("/delivery-policy/");
      await check.locator("input[name='zip']").fill("02830");
      await expect(check.locator("[data-zip-result]")).toContainText(
        "A little outside our usual area: delivery is $3 more"
      );
      await expect(check.locator("[data-zip-result]")).not.toContainText(
        "before we charge you"
      );
      await check.locator("input[name='zip']").fill("02857");
      await expect(check.locator("[data-zip-result]")).toContainText(
        "Yes! We deliver to"
      );
    });

  test("a ZIP outside the area is refused at the field", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ wings: 5 });
    await order.zip.fill("10001");
    await expect(order.zipNote).toHaveText(
      "That's outside our delivery area. On-farm pickup and the drop " +
      "site are open to everyone."
    );
    await expect(order.fee).toHaveText("+$5");
  });

  test("Connecticut takes eggs only", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ wings: 5 });
    await order.zip.fill("06239");
    await expect(order.zipNote).toHaveText(
      "We can only deliver eggs to Connecticut for now. Remove the " +
      "chicken, or choose pickup."
    );
    // Steps, not the cart's ×: see the order-page spec for why.
    await order.qty("wings").fill("0");
    await order.qty("wings").blur();
    await order.item("eggs").locator(".order-qty-add").click();
    await expect(order.zipNote).toContainText(
      "We are only able to deliver eggs in Connecticut at this time."
    );
  });

  test("an unknown code says so and changes nothing", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ wings: 5 });
    await order.codeInput.fill("nosuchcode");
    await order.codeApply.click();
    await expect(order.codeNote).toHaveText("Not a valid discount code.");
    await expect(order.codeInput).toHaveValue("NOSUCHCODE");
    await expect(order.discountLabel).toHaveText("Bulk discount ($50+)");
    await expect(order.total).toHaveText("$50");
  });

  test("EGGBOI counts up $40 a minute and changes no real figure",
    async ({ page }) => {
      const order = new OrderPage(page);
      const joke = order.cart.locator(".order-cart-joke");

      await order.open({ wings: 5 });
      await order.codeInput.fill("eggboi");
      await order.codeInput.press("Enter");
      await expect(order.codeNote).toHaveText("Code applied.");
      await expect(order.codeInput).toHaveValue("");
      await expect(joke.locator("dt")).toHaveText(
        "Discount (EGGBOI, $40/min)"
      );
      // $40 a minute is 67 cents a second: past $1 within two seconds.
      await expect(joke.locator("dd")).toHaveText(/^−\$([1-9]|\d{2,})/, {
        timeout: 10_000,
      });
      await expect(order.discountLabel).toHaveText("Bulk discount ($50+)");
      await expect(order.total).toHaveText("$50");
    });
});
