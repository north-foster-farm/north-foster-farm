// Product search in the header (#142): a command palette opened with
// the search button or cmd/ctrl K, matches on the left, the selected
// product's card on the right, and its Add, which turns into the
// quantity in the cart as on the order page (#208).
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
    add: dialog.locator("[data-search-add]"),
    fewer: dialog.locator("[data-search-step='-1']"),
    more: dialog.locator("[data-search-step='1']"),
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

      // #208: a dot parts the group from the item, "Eggs · Large".
      await p.input.fill("egg");
      await expect(p.rows.first()).toHaveText(/^Eggs · Large\$/);

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
  // and the answer re-renders the card. A slow answer (a cold function)
  // lands after the customer has added, and must leave the cart alone.
  test("stock arriving late keeps what's in the cart", async ({ page }) => {
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
    await p.add.click();
    await p.more.click();
    await expect(p.qty).toHaveValue("2");

    const stock = page.waitForResponse("**/api/stock");

    release();
    await stock;
    await page.waitForTimeout(300);
    await expect(p.qty).toHaveValue("2");
  });

  // #208: one Add, as on the order page. It becomes the stepper, which
  // edits the cart itself; at 0 the product leaves and Add returns.
  test("Add becomes the stepper, and 0 takes it out", async ({ page }) => {
    await page.goto("/about/");

    const p = palette(page);

    await p.opener.click();
    await p.input.fill("eggs");
    await expect(p.card).not.toContainText("Stock");
    await expect(p.card.getByRole("button", { name: "Add to cart" }))
      .toHaveCount(0);
    await expect(p.qty).toBeHidden();
    await p.add.click();
    await expect(p.add).toBeHidden();
    await expect(p.qty).toHaveValue("1");
    await expect(p.more).toBeFocused();
    await expect(p.added).toHaveText(
      "1 × Eggs, Large in your cart. 1 item in all."
    );
    await expect(p.fewer).toHaveAttribute("aria-label", "Remove");
    await p.fewer.click();
    await expect(p.add).toBeVisible();
    await expect(p.add).toBeFocused();
    await expect(p.added).toHaveText(
      "Removed Eggs, Large. 0 items in your cart."
    );
    await expect(p.dialog.getByRole("button", { name: "Go to cart" }))
      .toBeHidden();
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
    await p.add.click();
    await p.more.click();
    await expect(p.qty).toHaveValue("2");
    await expect(p.added).toHaveText(
      "2 × Eggs, Large in your cart. 2 items in all."
    );

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
      await expect(p.qty).toHaveValue("1");
      await page.keyboard.press("Enter");
      await expect(p.added).toContainText("2 × Wings,");
      await expect(p.qty).toHaveValue("2");
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

  // #208: a tapped row leaves the field alone, or the phone's keyboard
  // rises over the card; a clicked one keeps it, as a combobox should.
  test("a tapped row doesn't take the focus to the field",
    async ({ page, isMobile }) => {
      await page.goto("/about/");

      const p = palette(page);

      await p.opener.click();
      await expect(p.input).toBeFocused();
      await p.input.fill("chicken");
      if (isMobile) {
        await p.rows.nth(1).tap();
        await expect(p.rows.nth(1)).toHaveAttribute("aria-selected", "true");
        await expect(p.input).not.toBeFocused();
      } else {
        await p.rows.nth(1).click();
        await expect(p.rows.nth(1)).toHaveAttribute("aria-selected", "true");
        await expect(p.input).toBeFocused();
      }
    });

  // #208: once something is in the cart, Go to cart closes search and
  // opens the header's cart.
  test("Go to cart opens the header's cart", async ({ page }) => {
    await page.goto("/about/");

    const p = palette(page);
    const goToCart = p.dialog.getByRole("button", { name: "Go to cart" });

    await p.opener.click();
    await p.input.fill("eggs");
    await expect(goToCart).toBeHidden();
    await p.add.click();
    await goToCart.click();
    await expect.poll(() => isOpen(p)).toBe(false);
    await expect(page.locator(".site-mini-cart")).toBeVisible();
  });
});
