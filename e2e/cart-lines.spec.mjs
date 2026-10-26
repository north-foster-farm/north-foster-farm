// The cart's lines (#477, docs/cart.md 3): each category under its
// short name, each line with its remove ×, the pack label, the
// quantity at the unit price and the line total; the "N more" pills
// that glide a long list row by row. Adding, removing and typing a
// quantity are the order page's (order-page.spec.mjs).

import {
  FULL_CART, OrderPage, expect, test, unfoldCart as unfold,
} from "./support/order.mjs";

const PHONE = { width: 390, height: 664 };
const XL = { width: 1280, height: 800 };

// No label on sale starts with a letter since 2026-v9 (#267), so this
// holds the figures as written; test/pack-label.test.mjs holds the
// capital.
test("lines carry the pack label, under the group's short name",
  async ({ page }) => {
    await page.setViewportSize(PHONE);

    const order = new OrderPage(page);

    await order.open({
      wings: 1, "NFF-CHK-DRM-15-99": 1, "NFF-CHK-LVR-10-14": 1,
    });
    await expect(order.cart.locator(".order-cart-item-name"))
      .toHaveText(["1.5 lbs and up", "1.0 – 1.9 lbs",
        "Livers, 1.0 – 1.4 lbs"]);
    await expect(order.cart.locator(".order-cart-group-name"))
      .toHaveText(["Drumsticks", "Wings", "Other Items"]);
    await expect(order.cart.locator(".order-cart-item-qty").first())
      .toHaveText("1 × $8");
    await expect(order.cart.locator(".order-cart-item-sub").first())
      .toHaveText("$8");
    await expect(order.cart.getByRole("button", {
      name: "Remove Livers, 1.0 – 1.4 lbs from your cart",
    })).toBeAttached();
    await expect(order.count).toHaveText("3 items");
  });

test("the lines are kept in catalog order as quantities change",
  async ({ page }) => {
    await page.setViewportSize(XL);

    const order = new OrderPage(page);

    await order.open({ necks: 1, eggs: 1 });
    await expect(order.cart.locator(".order-cart-group-name"))
      .toHaveText(["Eggs", "Other Items"]);
    await order.item("eggs").getByRole("button", { name: "One more" })
      .click();
    await expect(order.cart.locator(".order-cart-item-qty").first())
      .toHaveText("2 × $7");
    await expect(order.cart.locator(".order-cart-group-name"))
      .toHaveText(["Eggs", "Other Items"]);
  });

// A line taken out in another tab (search, or the order page there)
// leaves this one too, so the next change here does not save the old
// cart back over the draft (#356).
test("another tab's change to the cart arrives here", async ({
  page, context,
}) => {
  await page.setViewportSize(XL);

  const order = new OrderPage(page);

  await order.open({ eggs: 2, wings: 1 });
  await expect(order.count).toHaveText("3 items");

  const other = await context.newPage();

  await other.goto("/about/");
  await other.evaluate(() => {
    const draft = JSON.parse(localStorage.getItem("nff-order-draft"));

    draft.payload.lines = [{ sku: "NFF-CHK-EGG-LG", qty: 1 }];
    draft.savedAt = Date.now();
    localStorage.setItem("nff-order-draft", JSON.stringify(draft));
  });
  await expect(order.qty("eggs")).toHaveValue("1");
  await expect(order.qty("wings")).toHaveValue("0");
  await expect(order.count).toHaveText("1 item");

  // A change here saves the lines as they now are.
  await order.item("eggs").getByRole("button", { name: "One more" }).click();
  await expect(order.count).toHaveText("2 items");
  expect(await page.evaluate(() => JSON.parse(
    localStorage.getItem("nff-order-draft")
  ).payload.lines)).toEqual([{ sku: "NFF-CHK-EGG-LG", qty: 2 }]);
});

test.describe("a long list on a phone", () => {
  test.use({ viewport: PHONE });

  test("the more pills count the rows beyond the list's edges and never "
    + "sit over a line", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await page.evaluate(() => window.scrollTo(0, 400));
    await unfold(order);

    const list = order.cart.locator("[data-cart-items]");
    const down = order.cart.locator("[data-cart-more]");
    const up = order.cart.locator("[data-cart-more-top]");
    const apart = async (pill) => {
      const l = await list.boundingBox();
      const p = await pill.boundingBox();

      expect(p.y).toBeGreaterThanOrEqual(l.y + l.height - 1);
    };

    await expect(down).toBeVisible();
    await expect(down).toHaveText(/^\d+ more ↓$/);
    await expect(up).toBeHidden();
    await apart(down);

    const rows = await list.locator(".order-cart-item").count();
    const below = Number((await down.textContent()).match(/\d+/)[0]);

    expect(below).toBeGreaterThan(0);
    expect(below).toBeLessThan(rows);

    await list.evaluate((el) => { el.scrollTop = 140; });
    await expect(up).toBeVisible();
    await expect(up).toHaveText(/^\d+ more ↑$/);
    await apart(up);
    await apart(down);

    // At the end, only the way back up.
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(down).toBeHidden();
    await expect(up).toBeVisible();
  });

  test("a more pill glides the list to the next row, exactly",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await page.evaluate(() => window.scrollTo(0, 400));
      await unfold(order);

      const list = order.cart.locator("[data-cart-items]");
      const down = order.cart.locator("[data-cart-more]");

      await expect(down).toBeVisible();
      await down.click();
      // The glide lands on a row's top edge, never past it (#366).
      await expect.poll(() => list.evaluate((el) => {
        const rows = [...el.querySelectorAll(".order-cart-item")];
        const tops = rows.map((li) => li.offsetTop - el.offsetTop);

        return tops.some((t) => Math.abs(t - el.scrollTop) < 1.5);
      }), { message: "the list rests on a row" }).toBe(true);
      await expect(order.cart.locator("[data-cart-more-top]")).toBeVisible();
    });
});

test("in the column a long list scrolls inside the sticky pane",
  async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });

    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await expect(order.cart).toHaveAttribute("data-placement", "column");

    const list = order.cart.locator("[data-cart-items]");
    const over = await list.evaluate((el) => el.scrollHeight - el.clientHeight);

    expect(over).toBeGreaterThan(0);
    await expect(order.cart.locator("[data-cart-more]")).toBeVisible();
    await expect(order.next).toBeInViewport();
  });
