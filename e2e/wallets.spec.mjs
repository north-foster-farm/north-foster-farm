// G4 (#457): Google Pay and Cash App Pay are configured on the deploy
// and Square's SDK mounts both buttons on the order page. This proves
// the SDKs and the deploy's configuration, not a payment: nothing is
// tokenised and no order is placed, so there is nothing to tear down.
// The sheets and their approvals stay a hand check (docs/qa-launch.md,
// "Payments"). On a local run the SDK is the fake, which mounts no
// wallet, so the spec skips there.
//
// Which wallets a browser offers is the SDK's call: Google Pay needs
// Chromium, Apple Pay needs Safari with a wallet, Cash App Pay mounts
// anywhere. Each test says what it expects of the browser it runs in.

import {
  OrderPage, expect, paymentFakes, test,
} from "./support/order.mjs";

const READY = { timeout: 30_000 };

// The payment section mounts its SDKs once it is near the screen: a
// cart, scroll it in, wait for the state the card helper waits for.
const payment = async (page) => {
  const order = new OrderPage(page);

  await order.open({ eggs: 1 });
  await page.locator("#payment").scrollIntoViewIfNeeded();
  await expect(page.locator("[data-pay]"))
    .toHaveAttribute("data-pay-state", /ready|venmo-only/, READY);
  // The wallets come after the card; the panel's skeleton clears last.
  await expect(page.locator("#pay-card-panel"))
    .not.toHaveAttribute("data-load", /./, READY);

  return order;
};

// A mounted wallet button: its container shown, with the SDK's own
// element inside (Google's button, or Square's Cash App frame).
const mounted = async (container, name) => {
  await expect(container, `${name} shown`).toBeVisible(READY);
  expect(await container.locator("button, iframe").count(),
    `${name} has the SDK's button`).toBeGreaterThan(0);
};

test.describe("the wallet buttons render (#457)", () => {
  test.beforeEach(async ({ request }) => {
    test.skip((await paymentFakes(request)).square,
      "the fake SDK mounts no wallet button");
  });

  test("Cash App Pay mounts its button", async ({ page }) => {
    await payment(page);
    await mounted(page.locator("[data-cash-app-pay]"), "Cash App Pay");
  });

  test("Google Pay mounts its button in Chromium", async ({
    page, browserName,
  }) => {
    test.skip(browserName !== "chromium", "Google Pay is Chromium's");
    await payment(page);
    await mounted(page.locator("[data-google-pay]"), "Google Pay");
  });

  // A wallet pays the whole order in one step, so its button is
  // guarded: with the form unfilled a click shows the errors and no
  // sheet opens (pay.js guard). Google Pay's button is in the page
  // itself, so the click reaches the guard.
  test("Google Pay's button shows the form's errors instead of a sheet",
    async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "Google Pay is Chromium's");

      await payment(page);

      const button = page.locator("[data-google-pay]");

      await mounted(button, "Google Pay");
      await button.click();
      await expect(page.locator("#order-form [aria-invalid='true']").first())
        .toBeVisible();
      await expect(page.locator("[data-pay]"))
        .toHaveAttribute("data-pay-state", /ready|venmo-only/);
    });
});
