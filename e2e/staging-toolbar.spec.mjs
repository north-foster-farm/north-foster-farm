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

  // A page after the reset is the page a stranger gets: nothing the
  // site keeps in the browser survives, and the farm news forms,
  // hidden for someone on the list, are back (#267).
  test("Reset to a first visit leaves a fresh browser",
    async ({ page, context, baseURL }) => {
      test.skip(!branch(baseURL), "only on a branch deploy");
      await context.addCookies([
        { name: "nff_signed_in", value: "1", url: baseURL },
      ]);
      await page.goto("/about/");
      await page.evaluate(() => {
        localStorage.setItem("nff-news", "joined");
        localStorage.setItem("nff-venmo", "1");
        localStorage.setItem("nff-order-draft", "{}");
        localStorage.setItem("nff:autoplay", "off");
        sessionStorage.setItem("nff-me", "seeded");
      });
      await page.reload();
      await page.locator("[data-staging-open]").click();
      // The click clears, then reloads. Waiting for "load" alone passes
      // at once on the page being left, so wait for the new document.
      await Promise.all([
        page.waitForEvent("load"),
        page.locator("[data-staging-forget]").click(),
      ]);

      const kept = await page.evaluate(() => ({
        local: Object.keys(localStorage)
          .filter((k) => !k.startsWith("staging.")),
        // The new page caches who is signed in again, as a first visit
        // does; the seeded value must be gone.
        session: sessionStorage.getItem("nff-me") === "seeded",
        cookie: document.cookie,
      }));

      expect(kept).toEqual({ local: [], session: false, cookie: "" });
      await expect(page.locator("footer [data-news-block]")).toBeVisible();
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
