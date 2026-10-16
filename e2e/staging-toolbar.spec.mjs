// The staging toolbar itself: on the staging branch deploy only, and
// polite about a wrong token. docs/qa-launch.md, "Staging".

import { expect, test } from "./support/order.mjs";

// A pull request preview is deploy-preview-<n>--<site>, and a branch
// deploy <branch>--<site>; the toolbar is for the staging branch deploy
// alone (#255), never a preview or a local server.
const preview = (baseURL) =>
  new URL(baseURL).hostname.startsWith("deploy-preview-");
const branch = (baseURL) =>
  new URL(baseURL).hostname.includes("--") && !preview(baseURL);

test.describe("staging toolbar", () => {
  test.use({ hideToolbar: false });

  test("a deploy preview carries no toolbar", async ({ page, baseURL }) => {
    test.skip(!preview(baseURL), "only on a deploy preview");
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();
    expect(await page.locator("#staging").count()).toBe(0);
    expect(await page.locator("script[src*='staging']").count()).toBe(0);
  });

  test("the Staging tab is on the page, and the endpoints want a token",
    async ({ page, request, baseURL }) => {
      test.skip(!branch(baseURL), "only on a branch deploy");
      await page.goto("/");
      await expect(page.locator("#staging")).toBeVisible();
      expect((await request.get("/api/staging/info")).status()).toBe(401);
    });

  test("a wrong token is asked for once, not in a loop",
    async ({ page, baseURL }) => {
      test.skip(!branch(baseURL), "only on a branch deploy");
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
