// AR-26 (#146): the privacy policy covers farm news, accounts, payments
// and what is stored, as #146 asks. Its wording is a draft for James,
// so this checks the topics and facts, not the sentences. The page's
// language tag is checked on the policy pages too (99e4717).
// docs/qa-launch.md, "The autumn refresh".

import terms from "../data/delivery.json" with { type: "json" };
import { today } from "../assets/scripts/order/lib/zoned.mjs";
import { expect, test } from "./support/order.mjs";

const PRIVACY_TOPICS = [
  "Accounts and sign-in links", "Farm News", "What we store and where",
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

    // Farm news: Resend, single opt-in, one-click unsubscribe.
    expect(text).toMatch(/Resend keeps the list/);
    expect(text).toMatch(/Signing up adds\s+you to the list at once/);
    expect(text).toMatch(/not one asking you to\s+confirm/);
    expect(text).toMatch(/unsubscribe link that takes you off the list in one/);
    // Payments: Square and PayPal, and no card details on the site.
    expect(text).toMatch(/Square/);
    expect(text).toMatch(/Venmo payments go through PayPal/);
    expect(text).toMatch(/We never see your card number/);
    expect(text).not.toMatch(/invoice/i);

    const updated = text.match(/Last updated (\w+ \d{1,2}, \d{4})/);

    expect(updated, "a Last updated line").toBeTruthy();
    expect(new Date(`${updated[1]} 12:00`).getTime())
      .toBeGreaterThanOrEqual(new Date("2026-09-24T12:00").getTime());
  });

  // #313: the delivery policy has a section on pickup days, with the
  // drop site, how markets and pop-ups work and the cutoff. No
  // market's hours are copied into it.
  test("the delivery policy names pickup days (#313)",
    async ({ page }) => {
      await page.goto("/delivery-policy/");

      const main = page.locator("main");

      await expect(main.getByRole("heading", { name: "Pickup days" }))
        .toBeVisible();

      const text = await main.innerText();
      const section = text.slice(text.indexOf("Pickup days"));

      expect(section).toMatch(/the drop site, a market or a pop-up/);
      expect(section).toMatch(/Saturdays from\s+10:00 to 11:00 AM/);
      expect(section).toMatch(/opened one event at a time/);
      expect(section).toMatch(/11:59 PM the day before/);
      expect(section).toMatch(/no minimum or fee/i);
      expect(section).not.toMatch(/Farmers Market|9:00 AM|Tilted Barn/);
      expect(text).toMatch(/Pickup days:\s+11:59 PM the day before/);
    });

  // #426: a money change still ahead (data/delivery.json
  // `money.changes`) is announced under the fee table, from the data;
  // once its day comes the sentence goes and the figures above change.
  test("the delivery policy announces the next money change (#426)",
    async ({ page }) => {
      const day = today(new Date(), terms.timeZone);
      const ahead = (terms.money.changes || []).filter((c) => c.from > day);

      await page.goto("/delivery-policy/");

      const text = await page.locator("main").innerText();

      if (!ahead.length) {
        expect(text).not.toMatch(/^From [A-Z][a-z]+ \d+, \d{4}, /m);

        return;
      }
      for (const change of ahead) {
        const [y, m, d] = change.from.split("-").map(Number);
        const when = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(
          "en-US", { month: "long", day: "numeric", year: "numeric",
            timeZone: "UTC" }
        );

        expect(text).toContain(`From ${when}, `);
        if (change.deliveryMinimum) {
          expect(text).toContain(`delivery is available for orders of $${
            change.deliveryMinimum} or more`);
        }
        for (const threshold of change.dropTiers || []) {
          const tier = terms.money.bulkTiers.find(
            (t) => t.threshold === threshold
          );

          expect(text).toContain(`the $${tier.off} off $${threshold} ` +
            "discount ends");
        }
      }
    });

  for (const path of ["/privacy/", "/delivery-policy/", "/accessibility/"]) {
    test(`${path} names its language as en-US`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    });
  }
});
