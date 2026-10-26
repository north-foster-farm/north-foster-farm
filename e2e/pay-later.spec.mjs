// Paying later for an order the farm made (#181): the account page
// lists it unpaid with a Pay now button, the order page opens it with
// the lines and the way fixed and takes what is due by card, and the
// record is paid. A declined card leaves it unpaid. The order is made
// through the back office as `bin/nff orders create` would make it.
// docs/qa-launch.md, "After the order".

import { OrderPage, expect, test, uniqueEmail } from "./support/order.mjs";
import { signIn } from "./support/session.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, closeOrder, deleteCustomer,
  op, teardown,
} from "./support/staging.mjs";

test.describe("paying later for an order the farm made (#181)", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);
  test.describe.configure({ mode: "serial" });

  const email = uniqueEmail("pay-later");
  let orderId;
  let total;
  let since;

  test.beforeAll(async ({ request }) => {
    since = new Date();

    const dates = await (await request.get("/api/dates")).json();
    const day = dates.onfarm[0];
    const made = await op("farmOrder", {
      email,
      fulfilment: {
        method: "onfarm", date: day.date,
        onfarm: { window: day.windows[0].id }, delivery: {},
      },
    });

    expect(made.status).toBe("unpaid");
    orderId = made.id;
    total = made.total;
  });

  test.afterAll(() => teardown([
    () => (orderId ? closeOrder(orderId) : null),
    () => deleteCustomer(email),
    () => clearMail({ to: email, since }),
  ]));

  test("the account page says what is due and leads to the fixed order",
    async ({ page }) => {
      await signIn(page, email);
      await page.goto("/account/#orders");

      const card = page.locator("[data-order]", { hasText: orderId })
        .first();

      await expect(card).toContainText("Unpaid");
      await expect(card).toContainText("Not paid yet");
      await card.getByRole("link", { name: /^Pay now/ }).click();
      await expect(page).toHaveURL(new RegExp(`/order/\\?pay=${orderId}`));

      const order = new OrderPage(page);

      await expect(page.locator("#order-editing"))
        .toContainText(`paying for order ${orderId}`);
      await expect(page.locator(".page-heading h1").first())
        .toHaveText("Pay for your order");
      // The lines, the way and the code are the farm's.
      for (const input of await page.locator("[data-qty]").all()) {
        await expect(input).toBeDisabled();
      }
      await expect(page.locator("#pickup")).toBeDisabled();
      await expect(page.locator("[data-field='code']")).toBeDisabled();
      await expect(page.locator("[data-venmo-cell]")).toBeHidden();
      await expect(order.total).toHaveText(/\$/);
      await order.openCard();
      await expect(order.submit).toHaveAccessibleName(/^Pay \$/);
    });

  test("a declined card leaves it unpaid; a good one pays it",
    async ({ page }) => {
      await signIn(page, email);
      await page.goto(`/order/?pay=${orderId}`);

      const order = new OrderPage(page);
      const paid = () => page.waitForResponse((r) => r.url()
        .includes(`/api/account/orders/${orderId}/pay`)
        && r.request().method() === "POST", { timeout: 60_000 });

      await order.openCard();
      await order.card("4000000000000002");

      let answer = paid();

      await order.submit.click();
      expect((await answer).status()).toBe(402);
      await expect(order.errorFor("payment")).toBeVisible();
      expect((await op("orderShow", { id: orderId })).order.status)
        .toBe("unpaid");

      await order.card();
      answer = paid();
      await order.submit.click();

      const res = await answer;

      expect(res.status(), await res.text()).toBe(200);
      await expect(page).toHaveURL(/\/account\/#orders/);

      const { order: record } = await op("orderShow", { id: orderId });

      expect(record.status).toBe("paid");
      expect(record.payments.map((p) => [p.via, p.method, p.amount]))
        .toEqual([["square", "card", total]]);
      await expect(page.locator("[data-order]", { hasText: orderId })
        .first()).toContainText("Paid");
    });
});
