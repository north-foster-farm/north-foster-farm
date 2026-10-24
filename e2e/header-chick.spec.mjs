// The signed-in header shows the customer's chicken in place of the
// word "Account" (#347): the picked one, or the brown hen. The name
// stays for screen readers. Link-styled buttons carry the hairline
// underline of text links (#342). Who is signed in is answered in the
// browser.

import { expect, test } from "./support/order.mjs";

const signedIn = (page, customer) => page.route("**/api/me", (route) =>
  route.fulfill({ json: { signedIn: true, customer } }));

const slot = (page) => page.locator("header .site-account.dropdown:visible");

test.describe("the header's chicken", () => {
  test("shows the picked chicken, named Account", async ({ page }) => {
    await signedIn(page, { email: "qa-e2e-chick@example.com",
      avatar: "hen-brown" });
    await page.goto("/about/");

    const button = slot(page).locator("[data-account-menu]");
    const chick = button.locator("[data-account-chick]");

    await expect(chick).toBeVisible();
    await expect(chick.locator("use")).toHaveAttribute(
      "href", "#avatar-hen-brown"
    );
    await expect(button).toHaveAccessibleName("Account");
    await expect(button).not.toContainText(/^\s*Account\s*$/);
  });

  test("shows the brown hen before one is picked", async ({ page }) => {
    await signedIn(page, { email: "qa-e2e-chick@example.com" });
    await page.goto("/about/");

    const chick = slot(page).locator("[data-account-chick]");

    await expect(chick).toBeVisible();
    await expect(chick.locator("use")).toHaveAttribute(
      "href", "#avatar-hen-brown"
    );
  });

  test("signed out still says Sign in", async ({ page }) => {
    await page.route("**/api/me", (route) =>
      route.fulfill({ json: { signedIn: false } }));
    await page.goto("/about/");

    await expect(slot(page).locator("[data-account-signin]"))
      .toContainText(/Sign in/);
  });
});

test.describe("link-styled buttons", () => {
  test("Try again on the sign-in page is underlined", async ({ page }) => {
    await page.goto("/login/");

    const line = await page.locator("#login-again").evaluate(
      (node) => getComputedStyle(node).textDecorationLine
    );

    expect(line).toBe("underline");
  });

  test("a filled button is not", async ({ page }) => {
    await page.goto("/login/");

    const line = await page.locator("button.btn-primary").first().evaluate(
      (node) => getComputedStyle(node).textDecorationLine
    );

    expect(line).toBe("none");
  });
});
