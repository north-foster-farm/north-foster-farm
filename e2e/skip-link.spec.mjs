// AR-30 (#159, WCAG 2.4.1): the first Tab on any page shows "Skip to
// main content", and following it takes the keyboard past the top bar
// and the header into <main>. docs/qa-launch.md, "The autumn refresh".

import { expect, test } from "./support/order.mjs";

test.describe("skip link", () => {
  for (const path of ["/", "/order/", "/about/", "/news/"]) {
    test(`${path}: the first Tab skips to the content`, async ({ page }) => {
      await page.goto(path);

      const skip = page.getByRole("link", { name: "Skip to main content" });

      await expect(skip).not.toBeInViewport();
      await page.keyboard.press("Tab");
      await expect(skip).toBeFocused();
      await expect(skip).toBeInViewport();

      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/#main$/);
      await page.keyboard.press("Tab");
      expect(await page.evaluate(
        () => !!document.activeElement.closest("main#main")
      ), "the next Tab lands inside main").toBe(true);
    });
  }
});
