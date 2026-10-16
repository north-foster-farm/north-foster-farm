// A tapped button lets go: a phone keeps :hover on whatever was last
// tapped, so without bin/postcss/hover-only.js a button stayed shaded
// and lifted after the tap. With a mouse the hover still shows, and a
// keyboard still gets its focus ring. The sign-up is sent empty, so it
// answers in the page and posts nothing.

import { OrderPage, SKU, expect, test } from "./support/order.mjs";

const look = (el) => el.evaluate((node) => {
  const cs = getComputedStyle(node);

  return {
    background: cs.backgroundColor,
    shadow: cs.boxShadow,
    transform: cs.transform,
  };
});

const signUp = (page) => page.locator("footer [data-news-signup] button");

test.describe("button states", () => {
  test("a tapped button returns to rest", async ({ page }, info) => {
    test.skip(info.project.name !== "phone", "touch only");
    await page.goto("/about/");

    const button = signUp(page);

    await button.scrollIntoViewIfNeeded();
    const rest = await look(button);

    await button.tap();
    await expect(page.locator("footer [data-news-note]"))
      .toHaveText("Enter your email address.");
    await page.waitForTimeout(400);
    expect(await look(button)).toEqual(rest);
  });

  test("a hovered button lifts; a tabbed one shows its ring",
    async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "mouse and keyboard");
      await page.goto("/about/");

      const button = signUp(page);

      await button.scrollIntoViewIfNeeded();
      const rest = await look(button);

      await button.hover();
      await page.waitForTimeout(400);
      const hovered = await look(button);

      expect(hovered.transform).not.toBe(rest.transform);
      expect(hovered.shadow).not.toBe(rest.shadow);

      await page.mouse.move(0, 0);
      await page.locator("footer [data-news-signup] input").focus();
      await page.keyboard.press("Tab");
      await expect(button).toBeFocused();
      await page.waitForTimeout(400);
      expect((await look(button)).shadow).not.toBe(rest.shadow);
    });
});

// Two quick taps are two taps. Without touch-action a phone reads them
// as a double-tap zoom: adding eggs fast, taking items out of the cart
// or picking towns on the map zoomed the page instead.
const touchAction = (el) =>
  el.evaluate((node) => getComputedStyle(node).touchAction);

test.describe("double taps", () => {
  test("the order page's controls never zoom", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open({ eggs: 1 });

    const eggs = page.locator(`.order-item[data-sku='${SKU.eggs}']`);
    const add = page.locator(".order-qty-add").last();
    const plus = eggs.locator(".order-qty-step [data-step='1']");
    const remove = page.locator("#order-cart .order-cart-remove").first();

    for (const el of [add, plus, remove]) {
      expect(await touchAction(el)).toBe("manipulation");
    }
    for (const el of [eggs.locator(".order-qty"), order.cart]) {
      expect(await touchAction(el)).toBe("manipulation");
    }
  });

  test("a double tap on a town picks it; the map stays put",
    async ({ page }, info) => {
      test.skip(info.project.name !== "phone", "touch only");
      await page.goto("/");

      const svg = page.locator("[data-map-svg]");
      const town = page.locator(".map-zip.is-ours").first();

      expect(await touchAction(page.locator("[data-map-frame]")))
        .toBe("manipulation");
      expect(await touchAction(svg)).toBe("pan-y");

      await town.scrollIntoViewIfNeeded();
      const before = await svg.getAttribute("viewBox");

      await town.tap();
      await town.tap();
      // Chromium's emulated taps never make a dblclick; Safari's do.
      await town.evaluate((node) => {
        const at = { bubbles: true, clientX: 200, clientY: 200 };

        node.dispatchEvent(new PointerEvent("pointerdown",
          { ...at, pointerType: "touch" }));
        node.dispatchEvent(new MouseEvent("dblclick", at));
      });
      await page.waitForTimeout(400);
      expect(await svg.getAttribute("viewBox")).toBe(before);
      expect(await page.evaluate(() => visualViewport.scale)).toBe(1);
    });
});
