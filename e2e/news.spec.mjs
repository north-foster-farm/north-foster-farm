// Farm news: the footer sign-up joins at once, with no email (W1,
// 2026-09-26). Only the old list is asked to confirm, by bin/nff
// audience invite. docs/qa-launch.md, "Farm news".

import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, customerRecord, deleteCustomer, mailTo,
} from "./support/staging.mjs";

test.describe("farm news", () => {
  test.skip(!backOffice().cli, BACK_OFFICE_MISSING);

  test("the footer sign-up joins at once, with no email",
    { tag: "@regression" }, async ({ page }) => {
      const email = uniqueEmail("news");
      const since = new Date();
      const form = page.locator("footer [data-news-signup]");

      try {
        await page.goto("/");
        await form.locator("input[type='email']").fill(email);
        await form.getByRole("button").click();
        await expect(form.locator("[data-news-note]"))
          .toHaveText("You're on the list. Thanks!");
        await expect(form.locator("input[type='email']")).toHaveValue("");

        const record = await customerRecord(email);

        expect(record.marketing).toBe(true);
        expect(record.marketingAt).toBeTruthy();
        expect(record.marketingSource).toBe("signup");
        expect(await mailTo(email, since), "no email").toHaveLength(0);
      } finally {
        await deleteCustomer(email);
      }
    });

  test("an address that is not one is refused at the field",
    async ({ page }) => {
      const form = page.locator("footer [data-news-signup]");
      let sent = 0;

      page.on("request", (req) => {
        if (req.url().includes("/api/news/subscribe")) sent += 1;
      });
      await page.goto("/");
      await form.locator("input[type='email']").fill("not-an-email");
      await form.getByRole("button").click();
      await expect(form.locator("[data-news-note]"))
        .toHaveText("Enter a valid email address, like you@example.com.");
      expect(sent, "no request for a malformed address").toBe(0);
    });

  test("the news page carries the same sign-up", async ({ page }) => {
    await page.goto("/news/");
    await expect(page.locator("main [data-news-signup], " +
      "[data-news-signup]").first()).toBeVisible();
  });
});
