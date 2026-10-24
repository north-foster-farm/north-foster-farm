// James's walkthrough of 2026-10-24: white button faces (#339), the
// markets block (#340) and the footer's sign-up (#341). The How to
// buy wording (#338) is asserted in home.spec.mjs.

import { expect, test } from "./support/order.mjs";

const WHITE = "rgb(255, 255, 255)";
const background = (locator) => locator.evaluate(
  (el) => getComputedStyle(el).backgroundColor
);

test.describe("walkthrough of 2026-10-24", () => {
  test("outline buttons keep a white face on hover (#339)",
    async ({ page }) => {
      await page.goto("/");

      const more = page.getByRole("link", { name: "More news and updates" });

      await more.scrollIntoViewIfNeeded();
      expect(await background(more)).toBe(WHITE);
      await more.hover();
      await page.waitForTimeout(300);
      expect(await background(more)).toBe(WHITE);
    });

  test("white buttons do not dim on hover (#339)", async ({ page }) => {
    await page.goto("/");

    const email = page.getByRole("link", { name: "Email us" });

    await email.scrollIntoViewIfNeeded();
    await email.hover();
    await page.waitForTimeout(300);
    expect(await background(email)).toBe(WHITE);
  });

  test("the dark band's outline button stays transparent (#339)",
    async ({ page }) => {
      await page.goto("/");

      const call = page.getByRole("link", { name: "Call or text us" });

      expect(await background(call)).toBe("rgba(0, 0, 0, 0)");
    });

  test("the markets block is three address lines and no season note (#340)",
    async ({ page }) => {
      await page.goto("/");

      const band = page.locator(".places");

      await expect(band.locator(".places-note")).toHaveCount(0);
      await expect(band).not.toContainText("Between seasons");
      for (const place of await band.locator(".place").all()) {
        const lines = place.locator(".place-where .place-line");

        await expect(lines).toHaveCount(3);
        await expect(lines.nth(2)).toHaveText(/, Rhode Island$/);
      }
    });

  test("the footer sign-up sits under the links, over the contact line (#341)",
    async ({ page }) => {
      await page.goto("/about/");

      const footer = page.locator("footer");
      const y = async (locator) => (await locator.boundingBox()).y;

      await expect(footer.locator("[data-news-block]")).toBeVisible();
      expect(await y(footer.locator("nav")))
        .toBeLessThan(await y(footer.locator("[data-news-block]")));
      expect(await y(footer.locator("[data-news-block]")))
        .toBeLessThan(await y(footer.locator(".footer-contact")));

      const field = footer.getByPlaceholder("Email address");

      expect(await background(field)).toBe("rgba(0, 0, 0, 0)");
      expect(await background(footer.getByRole("button", { name: "Yes" })))
        .toBe("rgba(0, 0, 0, 0)");
    });
});
