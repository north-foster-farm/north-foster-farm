// Changing the items in a paid order (#160): the account page's Change
// items opens the order page on the order, which prices the change
// and pays or refunds only the difference. The order is placed through
// the API with Square's approved sandbox nonce (one post against the
// order limit), then changed twice: fewer items on the page, refunded;
// more through the endpoint, charged to the sandbox card. Cancelled,
// refunded and deleted after.

import { NONCE, eggOrder, postOrder } from "./support/api.mjs";
import { SKU, expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, BASE_URL, backOffice, clearMail, closeOrder,
  deleteCustomer, linkIn, orderRecord, teardown, waitForMail,
} from "./support/staging.mjs";

const SIGN_IN = "Your secure sign-in link to North Foster Farm";
const UPDATED = "Your order is updated";

test.describe.configure({ mode: "serial" });

test.describe("changing a paid order", () => {
  test.skip(!backOffice().cli, BACK_OFFICE_MISSING);

  const email = uniqueEmail("edit");
  let orderId;
  let since;
  let cookies;

  test.beforeAll(async ({ request }) => {
    since = new Date();

    const { status, body } = await postOrder(request, await eggOrder(
      request, { email, nonce: NONCE.ok, qty: 2, claimedTotal: 1400 }
    ));

    expect(status, JSON.stringify(body)).toBe(200);
    orderId = body.orderId;
  });

  test.afterAll(() => teardown([
    () => (orderId ? closeOrder(orderId) : null),
    () => deleteCustomer(email),
    () => clearMail({ to: email, since }),
  ]));

  test("fewer items: the difference goes back", { tag: "@regression" },
    async ({ page }) => {
      const asked = new Date();

      await page.goto("/login/");
      await page.locator("#login-email").fill(email);
      await page.locator("#login-submit").click();

      const mail = await waitForMail({ to: email, subject: SIGN_IN,
        since: asked });

      await page.goto(linkIn(mail, /\/api\/auth\/verify\?token=/));
      await expect(page).toHaveURL(/\/account\/?/);
      cookies = await page.context().cookies();

      await page.getByRole("link", { name: "Change items" }).first().click();
      await expect(page).toHaveURL(new RegExp(`edit=${orderId}`));
      await expect(page.locator("#order-editing")).toContainText(orderId);

      const qty = page.locator(`[data-qty="${SKU.eggs}"]`);
      const money = page.locator("[data-edit-money]");

      await expect(qty).toHaveValue("2");
      await expect(money.locator("[data-total='paid']")).toHaveText("$14");
      await qty.fill("1");
      await qty.blur();
      await expect(money.locator("[data-total='due-label']"))
        .toHaveText("To refund");
      await expect(money.locator("[data-total='due']")).toHaveText("$7");
      await expect(page.locator("#payment")).toBeHidden();

      await page.locator("#order-save").click();
      await expect(page).toHaveURL(/\/account\/#orders/);

      const record = await orderRecord(orderId);

      expect(record.lines[0].qty).toBe(1);
      expect(record.refunds.map((r) => [r.amount, r.source]))
        .toEqual([[700, "customer"]]);
      await waitForMail({ to: email, subject: UPDATED, since: asked });
    });

  test("more items: the difference is charged", async ({ playwright }) => {
    test.skip(!cookies, "Needs the sign-in from the test before.");

    const request = await playwright.request.newContext({
      baseURL: BASE_URL, storageState: { cookies, origins: [] },
      extraHTTPHeaders: { Origin: BASE_URL },
    });
    const url = `/api/account/orders/${orderId}/edit`;
    const body = {
      idempotencyKey: `qa-e2e-edit-${Date.now().toString(36)}`,
      lines: [{ sku: SKU.eggs, qty: 3 }],
      payment: { method: "card", sourceId: NONCE.ok },
    };
    // The first answer names the new total, as the page's own pricing
    // would; the second pays the difference.
    const first = await (await request.post(url, { data: body })).json();

    expect(first.totals.total).toBe(2100);

    const res = await request.post(url, {
      data: { ...body, claimedTotal: first.totals.total },
    });

    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).difference).toBe(1400);

    const record = await orderRecord(orderId);

    expect(record.lines[0].qty).toBe(3);
    expect(record.payments.map((p) => p.amount)).toEqual([1400, 1400]);
    expect(record.square.changes).toHaveLength(1);
    await request.dispose();
  });
});
