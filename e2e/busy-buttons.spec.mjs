// The egg spinner on every button that sends a request (#299): while
// the request is held, the button shows the egg and its busy word, says
// aria-busy, keeps its width and ignores a second press. The contact
// form and the footer's news sign-up are covered in their own specs.
// Every answer is canned, so this runs on a local build as on staging.

import { expectBusy, expectIdle, holdRequests } from "./support/busy.mjs";
import { CUSTOMER, ORDER } from "./support/canned.mjs";
import { expect, test } from "./support/order.mjs";

const signedIn = async (page) => {
  await page.route("**/api/me", (route) => route.fulfill({
    json: { signedIn: true, customer: CUSTOMER },
  }));
  await page.route("**/api/account/orders", (route) => route.fulfill({
    json: { orders: [ORDER] },
  }));
};

const width = async (button) => (await button.boundingBox()).width;

test.describe("busy buttons", () => {
  test("/login: the sign-in link", async ({ page }) => {
    const button = page.locator("#login-submit");
    const hold = await holdRequests(page, "**/api/auth/request");

    await page.goto("/login/");
    await page.locator("#login-email").fill("qa-e2e-busy@example.com");

    const at = await width(button);

    await button.click();
    await expectBusy(page, button, { busyWord: "Sending", width: at });
    await button.click({ force: true });
    hold.release();
    await expect(page.locator("#login-sent")).toBeVisible();
    expect(hold.calls()).toBe(1);
  });

  test("/account: Support's Send", async ({ page }) => {
    await signedIn(page);

    const form = page.locator("#support-form");
    const button = form.locator(".busy-button");
    const hold = await holdRequests(page, "**/api/account/support");

    await page.goto("/account/#help");
    await form.locator("#sup-message").fill("Do you have wings?");

    const at = await width(button);

    await button.click();
    await expectBusy(page, button, { busyWord: "Sending", width: at });
    await button.click({ force: true });
    hold.release();
    await expectIdle(button, { width: at });
    await expect(page.locator("#account-flash"))
      .toHaveText("Sent. We'll answer by email.");
    expect(hold.calls()).toBe(1);
  });

  test("/account: an order's Yes, cancel it", async ({ page }) => {
    await signedIn(page);

    const hold = await holdRequests(page, "**/api/account/orders/*/cancel", {
      body: { order: { ...ORDER, status: "cancelled", canCancel: false } },
    });

    await page.goto("/account/#orders");
    await page.getByRole("button", { name: "Cancel order" }).click();

    const button = page.locator(".account-panel-form .busy-button");
    const at = await width(button);

    await button.click();
    await expectBusy(page, button, { busyWord: "Cancelling", width: at });
    hold.release();
    await expect(button).toBeHidden();
    expect(hold.calls()).toBe(1);
  });

  test("/account: Sign out stays busy until the home page",
    async ({ page }) => {
      await signedIn(page);

      const button = page.locator("#account-signout");
      const hold = await holdRequests(page, "**/api/auth/signout");

      await page.goto("/account/");

      const at = await width(button);

      await button.click();
      await expectBusy(page, button, { busyWord: "Signing out", width: at });
      hold.release();
      await expect(page).toHaveURL(/\/$/);
    });

  test("the header menu stays open to show Sign out busy",
    async ({ page }) => {
      await signedIn(page);

      const hold = await holdRequests(page, "**/api/auth/signout");

      await page.setViewportSize({ width: 1200, height: 800 });
      await page.goto("/about/");

      const toggle = page.locator("[data-account] .site-account-btn");
      const menu = page.locator("[data-account] .dropdown-menu");
      const button = menu.locator(".busy-button");

      await toggle.click();
      await expect(menu).toBeVisible();

      const at = await width(button);

      await button.click();
      await expectBusy(page, button, { busyWord: "Signing out", width: at });
      await expect(menu).toBeVisible();
      hold.release();
      await expect(page).toHaveURL(/\/$/);
    });

  // A dropped connection: the request never arrives, so the button
  // must come back rather than spin for good.
  test("a dropped connection leaves Delete idle, with its error",
    async ({ page }) => {
      await signedIn(page);
      await page.route("**/api/account/delete", (route) => route.abort());
      // The fixture dismisses every dialog; this one is a yes.
      await page.addInitScript(() => {
        window.confirm = () => true;
      });
      await page.goto("/account/#settings");

      const button = page.locator("#account-delete");

      await button.click();
      await expect(page.locator("#account-delete-status"))
        .toHaveText("Something went wrong. Please try again.");
      await expect(button).toHaveAttribute("data-busy", "false");
      await expect(button).not.toHaveAttribute("aria-busy");
    });

  test("a dropped connection leaves Sign out idle", async ({ page }) => {
    await signedIn(page);
    await page.route("**/api/auth/signout", (route) => route.abort());
    await page.goto("/account/");

    const button = page.locator("#account-signout");

    await button.click();
    await expect(button).toHaveAttribute("data-busy", "false");
    await expect(button).not.toHaveAttribute("aria-busy");
    await expect(page).toHaveURL(/\/account\/?$/);
  });

  test("with reduced motion the egg holds still", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });

    const button = page.locator("#login-submit");
    const hold = await holdRequests(page, "**/api/auth/request");

    await page.goto("/login/");
    await page.locator("#login-email").fill("qa-e2e-busy@example.com");
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(button.locator(".egg-spinner")).toBeVisible();
    await expect(button.locator(".egg-spinner-run"))
      .toHaveCSS("animation-name", "none");
    hold.release();
  });
});
