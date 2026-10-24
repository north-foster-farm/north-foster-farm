// AR-30 (#159, WCAG 2.4.1): the first Tab on any page shows "Skip to
// main content", and following it takes the keyboard past the top bar
// and the header into <main>. docs/qa-launch.md, "The autumn refresh".

import { expect, test } from "./support/order.mjs";

// The order page marks the rail's link once /api/stock answers; that
// once moved the Tab starting point to the link (#291). Its cases wait
// for the answer, under each Show choice (restock.js's key).
const CASES = [
  { path: "/" },
  { path: "/order/", stock: true },
  { path: "/order/", stock: true, show: "off", name: "Full catalog" },
  { path: "/about/" },
  { path: "/news/" },
];

test.describe("skip link", () => {
  for (const { path, stock, show, name } of CASES) {
    const title = `${path}${name ? ` (${name})` : ""}`;

    test(`${title}: the first Tab skips to the content`, async ({ page }) => {
      if (show) {
        await page.addInitScript((value) => {
          localStorage.setItem("nff-order-in-stock-only", value);
        }, show);
      }

      const answered = stock && page.waitForResponse("**/api/stock");

      await page.goto(path);
      if (answered) {
        await answered;
        // The rail is marked on the next frame after the rows change.
        await page.evaluate(() => new Promise((done) => {
          requestAnimationFrame(() => requestAnimationFrame(done));
        }));
      }

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
