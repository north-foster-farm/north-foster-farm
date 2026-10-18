// The staging toolbar itself: on the staging branch deploy only, and
// for the owner's gate session alone. docs/qa-launch.md, "Staging".

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

  // The toolbar opens for the owner's gate session alone. The suite's
  // machine cookie passes the gate but is not that session, so for it
  // the page carries no toolbar and the staging API refuses.
  test("the suite's machine gets no toolbar, and the API refuses",
    async ({ page, request, baseURL }) => {
      test.skip(!branch(baseURL), "only on a branch deploy");
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      await expect(page.locator("#staging")).toBeHidden();
      expect((await request.get("/api/staging/info")).status()).toBe(401);
      expect((await request.get("/api/staging/outbox")).status()).toBe(401);
    });

  // A page after the reset is the page a stranger gets: nothing the
  // site keeps in the browser survives, and the farm news forms,
  // hidden for someone on the list, are back (#267).
  //
  // The button is the owner's: this runs only with the owner's gate
  // session cookie in E2E_GATE_SESSION (the nff_gate cookie's value,
  // from a browser signed in as GATE_TOOLBAR_EMAIL).
  test("Reset to a first visit leaves a fresh browser",
    async ({ page, context, baseURL }) => {
      test.skip(!branch(baseURL), "only on a branch deploy");
      test.skip(!process.env.E2E_GATE_SESSION,
        "needs the toolbar owner's gate session");
      await context.addCookies([
        {
          name: "nff_gate", value: process.env.E2E_GATE_SESSION,
          domain: new URL(baseURL).hostname, path: "/",
          httpOnly: true, secure: true, sameSite: "Lax",
        },
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
});
