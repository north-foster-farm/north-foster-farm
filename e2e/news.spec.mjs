// Farm news: the public sign-up asks to confirm by email, and the link
// joins the list and sends one welcome with a one-click unsubscribe
// (#303, 63e09442; T6, 6166efa). The checkout and settings boxes and the
// old list's import join at once. docs/qa-launch.md, "Farm news".

import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, customerRecord, deleteCustomer,
  linkIn, mailTo,
} from "./support/staging.mjs";

test.describe("farm news", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  test("the footer sign-up asks to confirm, then joins and sends a welcome",
    { tag: "@regression" }, async ({ page }) => {
      const email = uniqueEmail("news");
      const since = new Date();
      const form = page.locator("footer [data-farm-list-form]");

      try {
        await page.goto("/");
        await form.locator("input[type='email']").fill(email);
        await form.getByRole("button").click();
        await expect(form.locator("[data-farm-list-note]"))
          .toHaveText("Check your email: click the link we sent you to join.");
        await expect(form.locator("input[type='email']")).toHaveValue("");

        // Not on the list, and no welcome, until the link is followed.
        expect(await customerRecord(email), "no record yet").toBeNull();

        const asked = await mailTo(email, since);

        expect(asked.map((m) => m.subject), "only the confirmation")
          .toEqual(["Confirm your email address for Farm News"]);

        const link = linkIn(asked[0], /\/api\/news\/confirm\?token=/);

        expect(link, "the confirmation's link").toBeTruthy();
        // The link lands on /news/, which says so and drops the query.
        await page.goto(link);
        await expect(page).toHaveURL(/\/news\/$/);
        await expect(page.locator("[data-farm-list-note]").first())
          .toHaveText("You're on the list. Thanks!");

        const record = await customerRecord(email);

        expect(record.marketing).toBe(true);
        expect(record.marketingAt).toBeTruthy();
        expect(record.marketingSource).toBe("signup");

        const mail = await mailTo(email, since);

        expect(mail.map((m) => m.subject).sort(), "one welcome after it")
          .toEqual(["Confirm your email address for Farm News",
            "Welcome to Farm News"]);
        expect(linkIn(mail.find((m) => m.subject === "Welcome to Farm News"),
          /unsubscribe=/)).toBeTruthy();
      } finally {
        await deleteCustomer(email);
        await clearMail({ to: email, since });
      }
    });

  test("an address that is not one is refused at the field",
    async ({ page }) => {
      const form = page.locator("footer [data-farm-list-form]");
      let sent = 0;

      page.on("request", (req) => {
        if (req.url().includes("/api/news/subscribe")) sent += 1;
      });
      await page.goto("/");
      await form.locator("input[type='email']").fill("not-an-email");
      await form.getByRole("button").click();
      await expect(form.locator("[data-farm-list-note]"))
        .toHaveText("Please enter a valid email address.");
      expect(sent, "no request for a malformed address").toBe(0);
    });

  test("the news page carries the same sign-up", async ({ page }) => {
    await page.goto("/news/");
    await expect(page.locator("main [data-farm-list-form], " +
      "[data-farm-list-form]").first()).toBeVisible();
  });
});
