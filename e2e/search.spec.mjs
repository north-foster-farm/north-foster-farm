// Product search in the header (#142): a command palette opened with
// the search button or cmd/ctrl K, matches on the left, the selected
// product's card on the right, and Add to cart from the results.
// docs/qa-launch.md, "The autumn refresh".

import { OrderPage, expect, test } from "./support/order.mjs";

const palette = (page) => {
  const dialog = page.locator("#search-palette");

  return {
    dialog,
    opener: page.locator("[data-search-open]"),
    input: dialog.locator("#search-palette-input"),
    rows: dialog.locator("#search-palette-list [role='option']"),
    card: dialog.locator("[data-search-card]"),
    qty: dialog.locator("[data-search-qty]"),
    add: dialog.locator("[data-search-button]"),
    added: dialog.locator("[data-search-added]"),
    empty: dialog.locator("[data-search-empty]"),
  };
};

const isOpen = (p) => p.dialog.evaluate((d) => d.open);

// Opens with the shortcut and waits for the animation.
const open = async (page) => {
  const p = palette(page);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(p.dialog).toHaveClass(/\bis-open\b/);
  await expect(p.input).toBeFocused();
  await page.waitForTimeout(300);

  return p;
};

test.describe("search (#142)", () => {
  test("cmd/ctrl K opens it, arrows move, Escape closes to the button",
    async ({ page, isMobile }) => {
      test.skip(isMobile, "a keyboard shortcut");
      await page.goto("/");

      const p = await open(page);

      await expect(p.opener).toHaveAttribute("aria-expanded", "true");
      await expect(p.input).toHaveAttribute("role", "combobox");

      await p.input.fill("wing");
      await expect(p.rows.first()).toContainText("Wings");
      await expect(p.rows.first()).toHaveAttribute("aria-selected", "true");
      await expect(p.input).toHaveAttribute(
        "aria-activedescendant", await p.rows.first().getAttribute("id")
      );
      await expect(p.card.locator("[data-search-group]")).toHaveText("Wings");
      await expect(p.card.locator("[data-search-price]")).toContainText("$");

      if (await p.rows.count() > 1) {
        const second = await p.rows.nth(1).textContent();

        await page.keyboard.press("ArrowDown");
        await expect(p.rows.nth(1)).toHaveAttribute("aria-selected", "true");
        await expect(p.input).toHaveAttribute(
          "aria-activedescendant", await p.rows.nth(1).getAttribute("id")
        );
        expect(second).toContain(
          await p.card.locator("[data-search-name]").textContent()
        );
      }

      // Tab never reaches the page behind. A modal dialog lets focus
      // pass to the browser's own controls after its last field, which
      // leaves the body active here; the page itself is inert.
      for (let i = 0; i < 12; i += 1) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => {
          const el = document.activeElement;

          return !el || el === document.body
            || !!el.closest("#search-palette");
        }), `tab ${i + 1}`).toBe(true);
      }

      await page.keyboard.press("Escape");
      await expect.poll(() => isOpen(p)).toBe(false);
      await expect(p.opener).toBeFocused();
      await expect(p.opener).toHaveAttribute("aria-expanded", "false");
    });

  // A phone's sheet fills the screen, so there it closes with Esc.
  test("the button opens it; a click outside, or Esc, closes it",
    async ({ page, isMobile }) => {
      await page.goto("/");

      const p = palette(page);

      await p.opener.click();
      await expect(p.dialog).toHaveClass(/\bis-open\b/);
      await expect(p.input).toBeFocused();
      await page.waitForTimeout(300);
      if (isMobile) {
        await p.dialog.getByRole("button", { name: "Close search" }).click();
      } else {
        await page.mouse.click(5, page.viewportSize().height - 5);
      }
      await expect.poll(() => isOpen(p)).toBe(false);
      await expect(p.opener).toHaveAttribute("aria-expanded", "false");
    });

  // Found by QA, 2026-09-24: close() leaves a 400 ms timer that closes
  // the dialog if it is still open, and a shortcut pressed while the
  // palette fades out is swallowed; reopening at once fails.
  test("it reopens right after it closes", async ({ page, isMobile }) => {
    test.skip(isMobile, "a keyboard shortcut");
    await page.goto("/");

    const p = await open(page);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForTimeout(700);
    expect(await isOpen(p), "open 700 ms after reopening").toBe(true);
    await expect(p.opener).toHaveAttribute("aria-expanded", "true");
  });

  test("words people use find the products, and nonsense says so",
    async ({ page, isMobile }) => {
      test.skip(isMobile, "a keyboard shortcut");
      await page.goto("/");

      const p = await open(page);

      for (const [query, group] of [
        ["egg", "Eggs"], ["breast", "Boneless Breasts"],
        ["drumstick", "Drumsticks"], ["whole", "Whole Chicken"],
      ]) {
        await p.input.fill(query);
        await expect(p.rows.first(), query).toContainText(group);
      }

      await p.input.fill("zzz");
      await expect(p.rows).toHaveCount(0);
      await expect(p.empty).toHaveText(
        "Nothing matches “zzz”. Try eggs, whole, breast or wings."
      );
      await expect(p.card).toBeHidden();
    });

  // Found by QA, 2026-09-24: the palette asks /api/stock as it opens,
  // and the answer re-renders the card, putting the quantity back to 1
  // and wiping the "Added" line. A slow answer (a cold function) lands
  // after the customer has chosen.
  test("stock arriving late keeps the quantity chosen", async ({ page }) => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });

    await page.route("**/api/stock", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("/about/");

    const p = palette(page);

    await p.opener.click();
    await expect(p.input).toBeFocused();
    await p.input.fill("eggs");
    await p.dialog.getByRole("button", { name: "One more" }).click();
    await expect(p.qty).toHaveValue("2");

    const stock = page.waitForResponse("**/api/stock");

    release();
    await stock;
    await page.waitForTimeout(300);
    await expect(p.qty).toHaveValue("2");
  });

  test("add from any page, and the order page has it", async ({ page }) => {
    await page.goto("/about/");

    const p = palette(page);
    // Let the stock answer land first; the test above covers a late one.
    const stock = page.waitForResponse("**/api/stock");

    await p.opener.click();
    await stock;
    await expect(p.input).toBeFocused();
    await p.input.fill("eggs");
    await expect(p.card.locator("[data-search-name]")).toHaveText("Large");
    await expect(p.card.locator("[data-search-stock]")).toHaveText("In stock");
    await p.dialog.getByRole("button", { name: "One more" }).click();
    await expect(p.qty).toHaveValue("2");
    await p.add.click();
    await expect(p.added).toHaveText(
      "Added 2 × Eggs, Large. 2 items in your cart."
    );
    await expect(p.add).toHaveText("Added · 2 in cart");

    const order = new OrderPage(page);

    await order.open();
    await expect(order.qty("eggs")).toHaveValue("2");
    await expect(order.count).toHaveText("2 items");
    await expect(order.subtotal).toHaveText("$14");
  });

  test("on the order page it fills the row and the cart at once",
    async ({ page, isMobile }) => {
      test.skip(isMobile, "a keyboard shortcut");

      const order = new OrderPage(page);

      await order.open({ wings: 1 });

      const p = await open(page);

      await p.input.fill("wings");
      await expect(p.card.locator("[data-search-group]")).toHaveText("Wings");
      await page.keyboard.press("Enter");
      await expect(p.added).toContainText("Added 1 × Wings,");
      await page.keyboard.press("Escape");
      await expect.poll(() => isOpen(p)).toBe(false);
      await expect(order.qty("wings")).toHaveValue("2");
      await expect(order.count).toHaveText("2 items");
      await expect(order.subtotal).toHaveText("$20");
    });

  test("on a phone it is a full-screen sheet", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 664 });
    await page.goto("/");

    const p = palette(page);

    await p.opener.click();
    await expect(p.dialog).toHaveClass(/\bis-open\b/);
    await page.waitForTimeout(400);

    const box = await p.dialog.boundingBox();

    expect(box.x).toBeLessThanOrEqual(1);
    expect(box.y).toBeLessThanOrEqual(1);
    expect(box.width).toBeGreaterThanOrEqual(389);
    expect(box.height).toBeGreaterThanOrEqual(663);
    await p.input.fill("egg");
    await expect(p.card).toBeVisible();
    await expect(p.card).toBeInViewport();
    await expect(p.add).toBeInViewport();
  });
});
