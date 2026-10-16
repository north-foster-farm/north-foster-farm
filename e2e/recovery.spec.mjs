// What the page does when the order endpoint cannot answer: one more
// try for a transient failure, then the failure card, as for a
// permanent one. The endpoint is stubbed in the browser, so nothing reaches the
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
  // #154: one more try a few seconds later while the button spins,
  // then the failure card; nothing retries in the background.
  test("a transient failure is tried once more, then stops",
    async ({ page }) => {
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
      const failed = page.locator(".order-result-failed");

      await order.submit.click();
      await expect(order.submit).toHaveAttribute("data-busy", "true");
      await expect(page.locator("#order-pending")).toBeHidden();
      await expect(failed).toBeVisible({ timeout: 20_000 });
      expect(calls, "one send and one more, no more (#154)").toBe(2);
      await expect(failed.locator("[data-out='message']")).toHaveText(
        "We couldn't reach our payment system."
      );
      expect(await page.evaluate(
        () => localStorage.getItem("nff-order-pending")
      )).toBeNull();
    });

  test("a permanent failure shows the order to send by hand",
    async ({ page }) => {
      let calls = 0;

      await page.route("**/api/orders", (route) => {
        calls += 1;

        return route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({
            retryable: false,
            message: "Something went wrong taking your payment.",
          }),
        });
      });

      const order = await ready(page);
      const failed = page.locator(".order-result-failed");

      await order.submit.click();
      // A permanent failure is not worth retrying: the card should
      // show at once, without the second try.
      await expect(failed).toBeVisible({ timeout: 20_000 });
      expect(calls, "a 502 is sent once, not retried (#156)").toBe(1);
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

  // #154: past the rate limit the endpoint once answered 204, and the
  // page said the order was placed. The live lockout is PY-18 in
  // rate-limit.spec.mjs; this stub checks the page alone.
  test("too many tries says so by the Pay button and keeps the order",
    async ({ page }) => {
      const message = "There have been too many tries from here. Wait a " +
        "few minutes and try again; your order is saved on this page.";

      await page.route("**/api/orders", (route) => route.fulfill({
        status: 429,
        contentType: "application/json",
        headers: { "Retry-After": "600" },
        body: JSON.stringify({ message }),
      }));

      const order = await ready(page);

      await order.submit.click();
      await expect(order.payError).toHaveText(message);
      await expect(order.result).not.toContainText("Your order is placed");
      await expect(page.locator(".order-result-failed")).toHaveCount(0);
      await expect(page.locator("#order-pending")).toBeHidden();
      await expect(order.submit).toBeEnabled();
      await expect(order.qty("eggs")).toHaveValue("1");

      const draft = await page.evaluate(
        () => JSON.parse(localStorage.getItem("nff-order-draft") || "null")
      );

      expect(JSON.stringify(draft)).toContain("Retry");
    });

  test("an empty 204 is never taken for a placed order",
    async ({ page }) => {
      await page.route("**/api/orders", (route) => route.fulfill({
        status: 204,
      }));

      const order = await ready(page);

      await order.submit.click();
      await expect(page.locator(".order-result-failed")).toBeVisible();
      await expect(order.result).not.toContainText("Your order is placed");
    });
});
