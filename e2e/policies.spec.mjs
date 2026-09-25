// AR-26 (#146): the privacy policy covers farm news, accounts, payments
// and what is stored, as #146 asks. Its wording is a draft for James,
// so this checks the topics and facts, not the sentences. The page's
// language tag is checked on the policy pages too (99e4717).
// docs/qa-launch.md, "The autumn refresh".

import { expect, test } from "./support/order.mjs";

const PRIVACY_TOPICS = [
  "Accounts and sign-in links", "Farm news", "What we store and where",
  "What your browser keeps", "Hosting and service providers",
];

test.describe("policies", () => {
  test("the privacy policy covers what #146 asks", async ({ page }) => {
    await page.goto("/privacy/");

    const main = page.locator("main");

    for (const topic of PRIVACY_TOPICS) {
      await expect(main.getByRole("heading", { name: topic })).toBeVisible();
    }

    const text = await main.innerText();

    // Farm news: Resend, double opt-in, one-click unsubscribe.
    expect(text).toMatch(/Resend keeps the list/);
    expect(text).toMatch(/follow the link in the email we send to confirm/);
    expect(text).toMatch(/unsubscribe link that takes you off the list in one/);
    // Payments: Square and PayPal, and no card details on the site.
    expect(text).toMatch(/Square/);
    expect(text).toMatch(/Venmo payments go through PayPal/);
    expect(text).toMatch(/We never see your card details/);
    expect(text).not.toMatch(/invoice/i);

    const updated = text.match(/Last updated (\w+ \d{1,2}, \d{4})/);

    expect(updated, "a Last updated line").toBeTruthy();
    expect(new Date(`${updated[1]} 12:00`).getTime())
      .toBeGreaterThanOrEqual(new Date("2026-09-24T12:00").getTime());
  });

  for (const path of ["/privacy/", "/delivery-policy/", "/accessibility/"]) {
    test(`${path} names its language as en-US`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    });
  }
});
