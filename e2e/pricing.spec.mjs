// Pricing as the cart shows it: bulk tiers, the delivery fee and its
// waiver, the delivery minimum, the outside-area fee and discount
// codes. Every figure is a whole dollar. docs/qa-launch.md, "Pricing
// and discounts". The same rules are unit-tested in lib/totals.mjs;
// these check that the page says them.
//
// The figures come from data/delivery.json for the day the spec runs
// (#362): on 2027-01-01 the minimum goes to $50 and the $50 tier ends,
// and the page follows the same `moneyOn`, so nothing here is pinned.

import terms from "../data/delivery.json" with { type: "json" };
import { moneyOn } from "../assets/scripts/order/lib/money-on.mjs";
import { today } from "../assets/scripts/order/lib/zoned.mjs";
import { OrderPage, expect, test } from "./support/order.mjs";

const money = moneyOn(terms.money, today(new Date(), terms.timeZone));
const {
  deliveryMinimum: MIN, deliveryFee: FEE, outsideAreaFee: AREA,
  feeWaivedAt: WAIVED_AT, bulkTiers: TIERS,
} = money;

// Wings $10, eggs $7, thighs $12.
const WINGS = 10;
const EGGS = 7;

// What the cart shows for goods worth `subtotal` by delivery: the
// bulk tier reached (label and amount off), the fee cell and the
// total. `area` adds the outside-area fee, which is never waived.
const expected = (subtotal, { area = false } = {}) => {
  const tier = [...TIERS].reverse().find((t) => subtotal >= t.threshold);
  const off = tier ? tier.off : 0;
  const delivery = subtotal >= WAIVED_AT ? 0 : FEE;
  const fee = delivery + (area ? AREA : 0);

  return {
    label: tier ? `Bulk discount ($${tier.threshold}+)` : null,
    off: tier ? `−$${off}` : null,
    fee: fee ? `+$${fee}` : "Free",
    total: `$${subtotal - off + fee}`,
  };
};

// The next tier above `subtotal`, as the nudge names it.
const nextTier = (subtotal) => TIERS.find((t) => t.threshold > subtotal);

test.describe("pricing and discounts", () => {
  // [cart, subtotal in dollars]: one under the first tier, one at
  // each tier, one between, one past the top.
  const CARTS = [
    [{ eggs: 7 }, 49],
    ...TIERS.map((t) => [{ wings: t.threshold / WINGS }, t.threshold]),
    [{ wings: 13, eggs: 1, thighs: 1 }, 149],
    [{ wings: 25 }, 250],
  ];

  for (const [cart, subtotal] of CARTS) {
    const want = expected(subtotal);

    test(`$${subtotal} of goods by delivery: ${want.off || "no discount"}, ` +
      `fee ${want.fee}, total ${want.total}`, { tag: "@regression" },
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open(cart, { method: "delivery" });
      await expect(order.subtotal).toHaveText(`$${subtotal}`);
      if (want.label) {
        await expect(order.discountRow).toBeVisible();
        await expect(order.discountLabel).toHaveText(want.label);
        await expect(order.discount).toHaveText(want.off);
      } else {
        await expect(order.discountRow).toBeHidden();
      }
      await expect(order.fee).toHaveText(want.fee);
      await expect(order.total).toHaveText(want.total);
    });
  }

  test("on-farm and scheduled pickup carry no fee", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ eggs: 7 }, { method: "delivery" });
    await order.method("onfarm");
    await expect(order.feeRow).toBeHidden();
    await expect(order.total).toHaveText("$49");
    await order.method("scheduled");
    await expect(order.feeRow).toBeHidden();
    await expect(order.total).toHaveText("$49");
  });

  test("the badges light as the tiers are reached", async ({ page }) => {
    const order = new OrderPage(page);
    const badge = (key) => order.cart.locator(`[data-badge='${key}']`);
    const reached = (t) => t.threshold <= WAIVED_AT;

    await order.open({ wings: WAIVED_AT / WINGS }, { method: "delivery" });
    for (const key of ["delivery", "free-delivery",
      ...TIERS.filter(reached).map((t) => `tier-${t.threshold}`)]) {
      await expect(badge(key)).toHaveAttribute("data-on", "true");
    }
    for (const t of TIERS.filter((x) => !reached(x))) {
      await expect(badge(`tier-${t.threshold}`))
        .toHaveAttribute("data-on", "false");
    }
  });

  test("the nudge names the next tier, and says nothing at the top",
    async ({ page }) => {
      const order = new OrderPage(page);
      const subtotal = 100;
      const next = nextTier(subtotal);
      const add = next.threshold - subtotal;
      const top = TIERS.at(-1);

      await order.open({ wings: subtotal / WINGS }, { method: "delivery" });
      await expect(order.nudge).toHaveText(
        `Next discount: add $${add} for $${next.off} off${
          next.threshold >= WAIVED_AT && subtotal < WAIVED_AT
            ? " and free delivery" : ""}.`
      );
      await order.method("onfarm");
      await expect(order.nudge).toHaveText(
        `Next discount: add $${add} for $${next.off} off.`
      );
      await order.qty("wings").fill(String(top.threshold / WINGS));
      await order.qty("wings").blur();
      await expect(order.total)
        .toHaveText(`$${top.threshold - top.off}`);
      await expect(order.nudge).toBeHidden();
    });

  test("exactly the minimum meets the delivery minimum", async ({ page }) => {
    const order = new OrderPage(page);
    const want = expected(MIN);

    await order.open({ wings: MIN / WINGS }, { method: "delivery" });
    await expect(order.short).toBeHidden();
    await expect(order.next).toBeEnabled();
    await expect(order.fee).toHaveText(`+$${FEE}`);
    await expect(order.total).toHaveText(want.total);
    await expect(order.cart.locator("[data-badge='delivery']"))
      .toHaveAttribute("data-on", "true");
  });

  test("$35 by delivery is short; scheduled pickup takes it",
    { tag: "@regression" }, async ({ page }) => {
      const order = new OrderPage(page);
      const gap = MIN - 5 * EGGS;

      await order.open({ eggs: 5 }, { method: "delivery" });
      await expect(order.nudge).toHaveText(
        `Add $${gap} to reach the $${MIN} delivery minimum.`
      );
      await expect(order.short).toHaveText(
        `Delivery requires $${MIN} or more after discounts. Add $${gap} more.`
      );
      await expect(order.next).toBeDisabled();
      await order.method("scheduled");
      await expect(order.short).toBeHidden();
      await expect(order.next).toBeEnabled();
      await expect(order.total).toHaveText("$35");
    });

  test(`an unlisted Rhode Island ZIP adds $${AREA}, never waived`,
    async ({ page }) => {
      const order = new OrderPage(page);
      const small = expected(50, { area: true });
      const big = expected(WAIVED_AT, { area: true });
      const listed = expected(WAIVED_AT);

      await order.open({ wings: 5 }, { method: "delivery" });
      // 02830 (Harrisville) is in Rhode Island but not on the list.
      await order.zip.fill("02830");
      await expect(order.fee).toHaveText(`+$${FEE + AREA}`);
      await expect(order.total).toHaveText(small.total);
      await order.qty("wings").fill(String(WAIVED_AT / WINGS));
      await order.qty("wings").blur();
      await expect(order.fee).toHaveText(`+$${AREA}`);
      await expect(order.total).toHaveText(big.total);
      await order.zip.fill("02857");
      await expect(order.fee).toHaveText("Free");
      await expect(order.total).toHaveText(listed.total);
    });

  test("the unlisted-ZIP note states the fee in dollars and charges now",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open({ wings: 5 }, { method: "delivery" });
      await order.zip.fill("02830");
      await expect(order.zipNote).toContainText("A little outside our usual");
      // The fee is money: "$3 more", not "3 more".
      await expect(order.zipNote).toContainText(`$${AREA}`);
      // The card is charged on this page, with the fee in the total;
      // nothing is confirmed "before we charge you" any more.
      await expect(order.zipNote).not.toContainText("before we charge you");
    });

  // The map's field names the price outright, not the difference
  // (#214); its words are for screen readers.
  test("the delivery policy's ZIP field prices the same way",
    async ({ page }) => {
      const check = page.locator("[data-zip-check]").first();

      await page.goto("/delivery-policy/");
      await check.locator("input[name='zip']").fill("02830");
      await expect(check.locator("[data-zip-result]")).toHaveText(
        `We deliver eggs and chicken to 02830 for $${FEE + AREA}.`
      );
      await check.locator("input[name='zip']").fill("02857");
      await expect(check.locator("[data-zip-result]")).toHaveText(
        `We deliver eggs and chicken to North Scituate for $${FEE}.`
      );
    });

  test("a ZIP outside the area is refused at the field", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ wings: 5 }, { method: "delivery" });
    await order.zip.fill("10001");
    await expect(order.zipNote).toHaveText(
      "That's outside our delivery area. On-farm pickup and our pickup " +
      "days are open to everyone."
    );
    await expect(order.fee).toHaveText(`+$${FEE}`);
  });

  test("Connecticut takes eggs only", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ wings: 5 }, { method: "delivery" });
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

  // A code that does nothing leaves the figures where the tiers put
  // them: with a $50 tier, $50 of wings shows it; without one, no row.
  const unchanged = async (order) => {
    const want = expected(50);

    if (want.label) {
      await expect(order.discountLabel).toHaveText(want.label);
    } else {
      await expect(order.discountRow).toBeHidden();
    }
    await expect(order.total).toHaveText(want.total);
  };

  test("an unknown code says so and changes nothing", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ wings: 5 }, { method: "delivery" });
    await order.codeOpen.click();
    await order.codeInput.fill("nosuchcode");
    await order.codeApply.click();
    await expect(order.codeNote).toHaveText("That code isn't valid.");
    await expect(order.codeInput).toHaveValue("NOSUCHCODE");
    await unchanged(order);
  });

  test("EGGBOI counts up $40 a minute and changes no real figure",
    async ({ page }) => {
      const order = new OrderPage(page);
      const joke = order.cart.locator(".order-cart-joke");

      await order.open({ wings: 5 }, { method: "delivery" });
      await order.codeOpen.click();
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
      await unchanged(order);
    });
});
