// Farm news: the footer sign-up, the confirmation email in James's
// wording (findings 18, 2026-09-24) and double opt-in: nobody is on
// the list until they click. docs/qa-launch.md, "Farm news".

import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, customerRecord,
  deleteCustomer, linkIn, waitForMail,
} from "./support/staging.mjs";

const SUBJECT = "Confirm your email for North Foster Farm news and updates";

test.describe("farm news", () => {
  test.skip(!backOffice().cli, BACK_OFFICE_MISSING);

  test("the footer sign-up asks, the email confirms, the click opts in",
    { tag: "@regression" }, async ({ page }) => {
      const email = uniqueEmail("news");
      const since = new Date();
      const form = page.locator("footer [data-news-signup]");

      try {
        await page.goto("/");
        await form.locator("input[type='email']").fill(email);
        await form.getByRole("button").click();
        await expect(form.locator("[data-news-note]")).toContainText(
          `Check ${email} for an email from us.`
        );
        await expect(form.locator("input[type='email']")).toHaveValue("");

        const mail = await waitForMail({ to: email, subject: SUBJECT, since });

        expect(mail.text).toContain("Click the button below to receive news " +
          "and updates from North Foster Farm.");
        expect(mail.text).toContain("Sign up");
        expect(mail.text).toContain("This link expires in 7 days. If you " +
          "didn't request this email, you can safely ignore it.");
        expect(mail.text).toContain("Need help? Contact us");
        expect(mail.text.toLowerCase()).not.toContain("now and then");
        expect(mail.text).not.toContain("Nothing is sent until you do");

        // Double opt-in: asking changes nothing on the record.
        const before = await customerRecord(email);

        expect(before ? before.marketing : false).toBeFalsy();

        const link = linkIn(mail, /\/api\/news\/confirm\?token=/);

        expect(link, "confirmation link in the email").toBeTruthy();
        expect(new URL(link).host).toBe(new URL(page.url()).host);
        await page.goto(link);
        await expect(page).toHaveURL(/\/news\/$/);
        await expect(page.locator("[data-news-note]").first())
          .toHaveText("You're on the list. Thanks!");

        const after = await customerRecord(email);

        expect(after.marketing).toBe(true);
        expect(after.marketingAt).toBeTruthy();

        // The link is single use.
        await page.goto(link);
        await expect(page.locator("[data-news-note]").first())
          .toContainText("That link isn't valid any more.");
      } finally {
        await deleteCustomer(email);
        await clearMail({ to: email, since });
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
