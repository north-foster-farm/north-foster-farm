// The footer of a full post (#483), on the post's own page and in the
// home page's card: the invitation to Farm News, hidden for people
// already on the list, and a small way back to the archive that
// stays. "All news" and "More news and updates" are gone.

import { expect, test } from "./support/order.mjs";

const SIGN_UP = "Sign up for news like this.";
const MORE = "More from the farm";

const openLatest = async (page) => {
  await page.goto("/news/");
  await page.locator(".news-lead-title a").click();
  // Visible is a box, not a styled box: the stylesheet can still be on
  // its way after the click, and a measure then sees plain text (both
  // buttons 17 px on a cold desktop run). Load waits for it.
  await page.waitForLoadState("load");
  await expect(page.locator(".news-footer")).toBeVisible();
};

// How a button looks to a reader: its height, its type and its fill.
const look = (link) => link.evaluate((el) => {
  const css = getComputedStyle(el);

  return {
    height: el.getBoundingClientRect().height,
    type: parseFloat(css.fontSize),
    fill: css.backgroundColor,
  };
});

test.describe("a post's footer (#483)", () => {
  test("offers the sign-up, then the archive, in a small button",
    async ({ page }) => {
      await openLatest(page);

      const footer = page.locator(".news-footer");
      const signUp = footer.getByRole("link", { name: SIGN_UP });
      const more = footer.getByRole("link", { name: MORE });

      await expect(signUp).toBeVisible();
      await expect(more).toHaveJSProperty("pathname", "/news/");

      // James's rule (#483): the small button is clearly quieter than
      // the sign-up. Smaller, in smaller type, and not filled like it.
      const loud = await look(signUp);
      const quiet = await look(more);

      expect(quiet.height, "shorter than the sign-up")
        .toBeLessThan(loud.height);
      expect(quiet.type, "smaller type than the sign-up")
        .toBeLessThan(loud.type);
      expect(quiet.fill, "not filled like the sign-up")
        .not.toBe(loud.fill);
      await expect(page.getByText("All news", { exact: true }))
        .toHaveCount(0);
    });

  test("the sign-up link scrolls to the footer's field and focuses it",
    async ({ page }) => {
      await openLatest(page);
      await page.getByRole("link", { name: SIGN_UP }).click();
      await expect(page.locator("#farm-list-footer-email")).toBeFocused();
      await expect(page.locator("#farm-list-footer-email")).toBeInViewport();
    });

  test("the sign-up hides for a browser that has joined, the archive stays",
    async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("nff-news",
        "joined"));
      await openLatest(page);
      await expect(page.getByRole("link", { name: SIGN_UP })).toBeHidden();
      await expect(page.locator(".news-footer").getByRole("link",
        { name: MORE })).toBeVisible();
    });

  test("closes the latest post on the home page, once",
    async ({ page }) => {
      await page.goto("/");

      const footer = page.locator(".home-update .news-footer");

      await expect(footer.getByRole("link", { name: SIGN_UP }))
        .toHaveAttribute("href", "#farm-list-footer-email");
      await expect(footer.getByRole("link", { name: MORE }))
        .toHaveJSProperty("pathname", "/news/");
      await expect(page.getByRole("link", { name: MORE })).toHaveCount(1);
      await expect(page.getByRole("link", { name: "More news and updates" }))
        .toHaveCount(0);
    });
});
