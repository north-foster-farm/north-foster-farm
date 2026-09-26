// A tapped button lets go: a phone keeps :hover on whatever was last
// tapped, so without bin/postcss/hover-only.js a button stayed shaded
// and lifted after the tap. With a mouse the hover still shows, and a
// keyboard still gets its focus ring. The sign-up is sent empty, so it
// answers in the page and posts nothing.

import { expect, test } from "./support/order.mjs";

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
