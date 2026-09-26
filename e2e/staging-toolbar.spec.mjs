// The staging toolbar itself: present off production, and polite
// about a wrong token. docs/qa-launch.md, "Staging".

import { expect, test } from "./support/order.mjs";

test.describe("staging toolbar", () => {
  test.use({ hideToolbar: false });

  test("the Staging tab is on the page, and the endpoints want a token",
    async ({ page, request }) => {
      await page.goto("/");
      await expect(page.locator("#staging")).toBeVisible();
      expect((await request.get("/api/staging/info")).status()).toBe(401);
    });

  test("a wrong token is asked for once, not in a loop", async ({ page }) => {
    let prompts = 0;

    // Replaces the fixture's handler: answer every prompt wrongly.
    page.removeAllListeners("dialog");
    page.on("dialog", async (dialog) => {
      prompts += 1;
      if (prompts > 20) {
        await dialog.dismiss();
      } else {
        await dialog.accept("wrong-token");
      }
    });
    await page.goto("/");
    await page.locator("[data-staging-open]").click().catch(() => {});
    await page.waitForTimeout(6_000);
    expect(prompts, "prompts in six seconds").toBeLessThanOrEqual(2);
  });
});
