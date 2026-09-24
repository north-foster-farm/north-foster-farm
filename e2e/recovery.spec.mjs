// What the page does when the order endpoint cannot answer: the retry
// panel for a transient failure and the failure card for a permanent
// one. The endpoint is stubbed in the browser, so nothing reaches the
// server or Square beyond tokenising the sandbox card.
// docs/qa-launch.md, "Payments".

import {
  OrderPage, expect, test, uniqueEmail,
} from "./support/order.mjs";

const ready = async (page) => {
  const order = new OrderPage(page);

  await order.open({ eggs: 1 });
  await order.method("onfarm");
  await order.contact({ first: "Retry", email: uniqueEmail("retry") });
  await order.firstDate("onfarm");
  await order.openCard();
  await order.card();

  return order;
};

test.describe("recovery", () => {
  test("a transient failure shows the retry panel, and Stop trying " +
    "hands the form back", async ({ page }) => {
    let calls = 0;

    await page.route("**/api/orders", (route) => {
      calls += 1;

      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          retryable: true,
          message: "We couldn't reach our payment provider.",
        }),
      });
    });

    const order = await ready(page);
    const pending = page.locator("#order-pending");

    await order.submit.click();
    await expect(pending).toBeVisible({ timeout: 60_000 });
    await expect(pending.getByRole("button", { name: "Try now" }))
      .toBeVisible();
    await expect(pending.locator("[data-pending-countdown]"))
      .not.toBeEmpty();
    await expect(order.submit).toBeDisabled();

    // The draft keeps the pending order for the next visit.
    const stored = await page.evaluate(
      () => localStorage.getItem("nff-order-pending")
    );

    expect(stored).toBeTruthy();
    expect(calls).toBeGreaterThanOrEqual(1);

    await pending.getByRole("button", { name: "Stop trying" }).click();
    await expect(pending).toBeHidden();
    await expect(order.submit).toBeEnabled();
    expect(await page.evaluate(
      () => localStorage.getItem("nff-order-pending")
    )).toBeNull();
  });

  test("a permanent failure shows the order to send by hand",
    async ({ page }) => {
      await page.route("**/api/orders", (route) => route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          retryable: false,
          message: "Something went wrong taking your payment.",
        }),
      }));

      const order = await ready(page);
      const failed = page.locator(".order-result-failed");

      await order.submit.click();
      // A permanent failure is not worth retrying: the card should
      // show at once, not after the retry schedule (about 8 minutes).
      await expect(failed).toBeVisible({ timeout: 20_000 });
      await expect(failed.locator("h2")).toHaveText(
        "Send this to us and we'll finish it by hand"
      );
      await expect(failed.locator("[data-out='summary']")).toContainText(
        "1 × Eggs"
      );
      await expect(failed.locator("[data-out='summary']")).toContainText(
        "Total $7"
      );
      await expect(failed.locator("[data-out='mailto']")).toHaveAttribute(
        "href", /^mailto:.+\?subject=Order%20from%20the%20website&body=/
      );
      await expect(failed.locator("[data-out='phone']")).toHaveAttribute(
        "href", /^tel:/
      );
    });
});
