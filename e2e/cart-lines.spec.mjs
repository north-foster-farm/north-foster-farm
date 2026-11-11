// The cart's lines (#477, docs/cart.md 3): each category under its
// short name, each line with its remove icon, the pack label, the
// quantity at the unit price and the line total; the "N more" pills
// that glide a long list row by row; Clear cart and its two presses
// (#531). Adding, removing and typing a quantity are the order page's
// (order-page.spec.mjs).

import {
  CONFIRM_GUARD, CONFIRM_WAIT,
} from "../assets/scripts/order/cart/confirm.mjs";
import {
  FULL_CART, OrderPage, SKU, SUITE_STOCK, expect, test,
  unfoldCart as unfold,
} from "./support/order.mjs";
import { PLENTY } from "./support/stock.mjs";

const PHONE = { width: 390, height: 664 };
const XL = { width: 1280, height: 800 };

const DRUMS_LARGE = "NFF-CHK-DRM-15-99";
const LIVERS = "NFF-CHK-LVR-10-14";

// The two lines beyond the suite's own SKUs, in stock for this spec
// alone (#507).
test.use({
  stockPins: { ...SUITE_STOCK, [DRUMS_LARGE]: PLENTY, [LIVERS]: PLENTY },
});

// No label on sale starts with a letter since 2026-v9 (#267), so this
// holds the figures as written; test/pack-label.test.mjs holds the
// capital.
test("lines carry the pack label, under the group's short name",
  async ({ page }) => {
    await page.setViewportSize(PHONE);

    const order = new OrderPage(page);

    await order.open({ wings: 1, [DRUMS_LARGE]: 1, [LIVERS]: 1 });
    await expect(order.cart.locator(".order-cart-item-name"))
      .toHaveText(["1.5 lbs and up", "1.0 – 1.9 lbs",
        "Livers, 1.0 – 1.4 lbs"]);
    await expect(order.cart.locator(".order-cart-group-name"))
      .toHaveText(["Drumsticks", "Wings", "Other Items"]);
    await expect(order.cart.locator(".order-cart-item-qty").first())
      .toHaveText("1 × $10");
    await expect(order.cart.locator(".order-cart-item-sub").first())
      .toHaveText("$10");
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
    // The pill sits on the strip under the list's box, never on a
    // line: a row half under the list's edge is clipped there.
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

// The saved draft's lines, as the header and another tab read them.
const draftLines = (page) => page.evaluate(() => JSON.parse(
  localStorage.getItem("nff-order-draft")
).payload.lines);

// The remove control shows James's remove-item icon in place of the ×,
// keeps its name and still takes the line out (#531).
test("a line's remove icon keeps its name and takes the line out",
  async ({ page }) => {
    await page.setViewportSize(PHONE);

    const order = new OrderPage(page);

    await order.open({ eggs: 1, [LIVERS]: 1 });
    await unfold(order);

    const remove = order.cart.getByRole("button", {
      name: "Remove Livers, 1.0 – 1.4 lbs from your cart",
    });

    await expect(remove.locator("svg")).toBeVisible();
    await expect(remove).not.toContainText("×");
    await remove.click();
    await expect(remove).toHaveCount(0);
    await expect(page.locator(`[data-qty='${LIVERS}']`)).toHaveValue("0");
    await expect(order.count).toHaveText("1 item");
    expect(await draftLines(page)).toEqual([{ sku: SKU.eggs, qty: 1 }]);
  });

for (const [width, viewport] of [["a phone", PHONE], ["the column", XL]]) {
  test.describe(`Clear cart on ${width}`, () => {
    test.use({ viewport });

    const opened = async (page) => {
      const order = new OrderPage(page);

      await order.open({ eggs: 2, wings: 1 });
      // The column has no fold; a floating pane opens by its pill.
      if (await order.cart.getAttribute("data-placement") === "floating") {
        await unfold(order);
      }
      await expect(order.count).toHaveText("3 items");

      return order;
    };

    test("sits at the top of the cart, and two presses empty it",
      async ({ page }) => {
        const order = await opened(page);
        const clear = order.cart.getByRole("button", { name: "Clear cart" });

        // At the top of the cart: on the first heading's row, the lines
        // and the totals all below its top edge.
        await expect(clear).toBeVisible();
        await expect(clear.locator("svg")).toBeVisible();

        const at = await clear.boundingBox();
        const heading = await order.cart.locator(".order-cart-group-name")
          .first().boundingBox();
        const firstLine = await order.cart.locator(".order-cart-item")
          .first().boundingBox();

        expect(Math.abs(at.y - heading.y)).toBeLessThan(4);
        expect(at.y + at.height).toBeLessThanOrEqual(firstLine.y + 2);
        // Clear of the heading's words.
        expect(at.x).toBeGreaterThan(heading.x + 60);

        // A double tap is one press: the second comes too soon after
        // the first to count.
        await clear.dblclick();
        await expect(clear).toHaveText("Clear cart?");
        await expect(order.count).toHaveText("3 items");

        await page.waitForTimeout(CONFIRM_GUARD + 100);
        await clear.click();
        // The button goes with the lines, so the focus lands on the pane.
        await expect(order.cart).toBeFocused();
        await expect(order.count).toHaveText("0 items");
        await expect(order.total).toHaveText("$0");
        await expect(order.cart).toHaveAttribute("data-empty", "");
        await expect(order.cart.locator(".order-cart-item")).toHaveCount(0);
        await expect(order.next).toBeDisabled();
        for (const sku of [SKU.eggs, SKU.wings]) {
          await expect(page.locator(`[data-qty='${sku}']`)).toHaveValue("0");
        }
        expect(await draftLines(page)).toEqual([]);
        await expect(page.locator("[data-cart-live]"))
          .toHaveText("Your cart is empty.");
      });

    test("one press, then waiting, leaves the cart as it was",
      async ({ page }) => {
        const order = await opened(page);
        const clear = order.cart.locator("[data-cart-clear]");
        const before = await draftLines(page);

        await clear.click();
        await expect(clear).toHaveText("Clear cart?");
        await expect(clear).toHaveText("Clear cart", {
          timeout: CONFIRM_WAIT + 3_000,
        });
        await expect(clear).not.toHaveAttribute("data-armed");
        await expect(order.count).toHaveText("3 items");
        expect(await draftLines(page)).toEqual(before);

        // The next press asks again rather than clearing.
        await clear.click();
        await expect(clear).toHaveText("Clear cart?");
        await expect(order.count).toHaveText("3 items");
      });

    test("Escape puts an asking Clear cart back", async ({ page }) => {
      const order = await opened(page);
      const clear = order.cart.locator("[data-cart-clear]");
      const before = await draftLines(page);

      // By keyboard, the way Escape is met.
      await clear.focus();
      await page.keyboard.press("Enter");
      await expect(clear).toHaveText("Clear cart?");
      await page.keyboard.press("Escape");
      await expect(clear).toHaveText("Clear cart");
      await expect(clear).not.toHaveAttribute("data-armed");
      // Escape spent itself on the button: the pane stays open.
      await expect(clear).toBeVisible();

      // The next press asks again rather than clearing.
      await page.waitForTimeout(CONFIRM_GUARD + 100);
      await clear.click();
      await expect(clear).toHaveText("Clear cart?");
      await expect(order.count).toHaveText("3 items");
      expect(await draftLines(page)).toEqual(before);
    });
  });
}
