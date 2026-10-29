// A card order and a Venmo order against the fake payment drivers
// (#265), on `netlify dev` with the development sample as .env:
//
//   E2E_BASE_URL=http://localhost:8888 npm run e2e -- fake-payments
//
// Skipped anywhere the deploy does not offer the fakes, which is every
// deploy on Netlify: SQUARE_ENV=fake and PAYPAL_ENV=fake work only
// where SITE_CONTEXT is dev (netlify/functions/lib/fake.mjs).

import {
  OrderPage, expect, paymentFakes as fakes, recordedCard, test, uniqueEmail,
} from "./support/order.mjs";

test.describe("fake payments", () => {
  test("a card pays for an on-farm pickup", async ({ page, request }) => {
    test.skip(!(await fakes(request)).square, "SQUARE_ENV is not fake here");

    const order = new OrderPage(page);
    const email = uniqueEmail("fake-card");

    await order.open({ eggs: 1 });
    await order.method("onfarm");
    await order.contact({ first: "Card", email });
    await order.firstDate("onfarm");
    await order.openCard();
    await expect(page.locator("[data-fake-card]")).toBeVisible();

    const { status, body } = await order.pay();

    expect(status, JSON.stringify(body)).toBe(200);
    await expect(order.result).toBeVisible();
    await expect(order.result.locator("[data-out='how']"))
      .toHaveText(recordedCard().how);
  });

  test("Venmo pays for an on-farm pickup", async ({ page, request }) => {
    test.skip(!(await fakes(request)).paypal, "PAYPAL_ENV is not fake here");

    const order = new OrderPage(page);
    const email = uniqueEmail("fake-venmo");

    // ?venmo shows the button even where VENMO_HIDDEN holds it back.
    await page.goto("/order/?venmo&add=NFF-CHK-EGG-LG:1");
    await expect(page.locator("#onfarm-date")).toBeEnabled();
    await page.waitForTimeout(1_000);
    await order.method("onfarm");
    await order.contact({ first: "Venmo", email });
    await order.firstDate("onfarm");
    await page.locator("#payment").scrollIntoViewIfNeeded();

    const venmo = page.locator("[data-fake-venmo]");

    await expect(venmo).toBeEnabled({ timeout: 30_000 });

    const captured = page.waitForResponse((r) =>
      r.url().includes("/api/orders") && r.request().method() === "POST"
      && (r.request().postDataJSON() || {}).payment
      && r.request().postDataJSON().payment.stage === "capture",
    { timeout: 60_000 });

    await venmo.click();

    const res = await captured;

    expect(res.status(), await res.text()).toBe(200);
    await expect(order.result).toBeVisible();
  });
});
