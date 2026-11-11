// The cart's lines (#477, docs/cart.md 3): each category under its
// short name, each line with its remove icon, the pack label, the
// quantity at the unit price and the line total; the "more" arrows
// that glide a long list row by row (#560: an arrow, no count); Clear
// cart on the pane's edge and its two presses (#531, #560). Adding,
// removing and typing a quantity are the order page's
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

  test("an arrow shows each way lines are hidden, with no count, and "
    + "never sits over a line", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await page.evaluate(() => window.scrollTo(0, 400));
    await unfold(order);

    const list = order.cart.locator("[data-cart-items]");
    const down = order.cart.getByRole("button", { name: "More lines below" });
    const up = order.cart.getByRole("button", { name: "More lines above" });
    // The arrow sits on the strip under the list's box, never on a
    // line: a row half under the list's edge is clipped there.
    const apart = async (arrow) => {
      const l = await list.boundingBox();
      const p = await arrow.boundingBox();

      expect(p.y).toBeGreaterThanOrEqual(l.y + l.height - 1);
    };
    // A glyph and nothing else: no count, no words.
    const bare = async (arrow) => {
      await expect(arrow.locator("svg")).toBeVisible();
      await expect(arrow).toHaveText("");
    };

    await expect(down).toBeVisible();
    await bare(down);
    await expect(up).toBeHidden();
    await apart(down);

    await list.evaluate((el) => { el.scrollTop = 140; });
    await expect(up).toBeVisible();
    await bare(up);
    await apart(up);
    await apart(down);

    // A line only partly under the foot's fade still counts as hidden.
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight - el.clientHeight - 6;
    });
    await expect(down).toBeVisible();

    // At the end, only the way back up.
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(down).toBeHidden();
    await expect(up).toBeVisible();

    // Back at the top, only the way down.
    await list.evaluate((el) => { el.scrollTop = 0; });
    await expect(up).toBeHidden();
    await expect(down).toBeVisible();
  });

  // The list takes what the two thirds leave (#560), within James's
  // rule for the open sheet (#267, #475; cart-float.spec.mjs holds the
  // pane to it). Before, its cap was 0.66 of the visible height less
  // the chrome as measured with a nudge (20.5rem), never under the
  // floor (124px): 229px here, whether the cart had a nudge or not. A
  // cart past the top tier has none, so its lines now take that line
  // too: at least one more row.
  test("the list is taller than it was", async ({ page }) => {
    const size = { width: 390, height: 844 };

    await page.setViewportSize(size);

    const order = new OrderPage(page);

    // $206, past the top tier: no next discount to nudge toward.
    await order.open({ ...FULL_CART, eggs: FULL_CART.eggs + 1 });
    await page.evaluate(() => window.scrollTo(0, 400));
    await unfold(order);
    await expect(order.cart.locator("[data-nudge]")).toBeHidden();

    const lines = order.cart.locator("[data-part='lines']");
    const before = Math.max(124, 0.66 * size.height - 20.5 * 16);
    const row = 0.875 * 16 * 1.5 + 0.25 * 16;
    const box = await lines.boundingBox();
    const pane = await order.cart.boundingBox();

    expect(box.height).toBeGreaterThanOrEqual(before + row);
    // The pane keeps to about two thirds, as cart-float's spec has it.
    expect(pane.height).toBeLessThanOrEqual(size.height * 0.7);
    // Still a scroller, with the foot in reach.
    await expect(order.cart.locator("[data-cart-more]")).toBeVisible();
    await expect(order.next).toBeInViewport();
  });

  test("a more arrow glides the list to the next row, exactly",
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

// The remove control shows Tabler's trash can (#560), in place of
// James's remove-item icon (#531) and the × before it, keeps its name
// and still takes the line out.
test("a line's trash icon keeps its name and takes the line out",
  async ({ page }) => {
    await page.setViewportSize(PHONE);

    const order = new OrderPage(page);

    await order.open({ eggs: 1, [LIVERS]: 1 });
    await unfold(order);

    const remove = order.cart.getByRole("button", {
      name: "Remove Livers, 1.0 – 1.4 lbs from your cart",
    });

    await expect(remove.locator("svg")).toBeVisible();
    // The can's lid, from icons/trash.svg.
    await expect(remove.locator("path[d*='M9 7V4']")).toHaveCount(1);
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

    test("sits on the pane's top edge as an outline pill, and two "
      + "presses empty it", async ({ page }) => {
      const order = await opened(page);
      const clear = order.cart.getByRole("button", { name: "Clear cart" });

      await expect(clear).toBeVisible();
      await expect(clear.locator("svg")).toBeVisible();

      // Astride the pane's top edge (#560), as the count badges sit on
      // the mini cart and the order menu item: its middle on the edge,
      // at the pane's right, wider than tall.
      const at = await clear.boundingBox();
      const pane = await order.cart.boundingBox();
      const middle = at.y + at.height / 2;

      expect(Math.abs(middle - pane.y)).toBeLessThan(4);
      expect(at.x + at.width).toBeLessThanOrEqual(pane.x + pane.width);
      expect(at.x + at.width).toBeGreaterThan(pane.x + pane.width - 40);
      expect(at.width).toBeGreaterThan(2 * at.height);

      // An outline: a green border around the page's own background,
      // not the badges' solid green.
      const look = await clear.evaluate((el) => {
        const s = getComputedStyle(el);
        const pane = getComputedStyle(el.closest(".order-cart"));

        return {
          border: s.borderTopColor, color: s.color,
          fill: s.backgroundColor, pane: pane.backgroundColor,
          pill: parseFloat(s.borderTopLeftRadius) >= el.offsetHeight / 2,
        };
      });

      expect(look.border).toBe(look.color);
      expect(look.fill).toBe(look.pane);
      expect(look.pill).toBe(true);

      // A double tap is one press: the second comes too soon after the
      // first to count.
      await clear.dblclick();
      await expect(clear).toHaveText("Clear cart?");
      await expect(order.count).toHaveText("3 items");

      await page.waitForTimeout(CONFIRM_GUARD + 100);
      await clear.click();
      // The button goes with the lines, so the focus lands on the pane.
      await expect(order.cart).toBeFocused();
      await expect(clear).toBeHidden();
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
