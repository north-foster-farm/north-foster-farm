// Accounts: sign-in by emailed link, and a paid order
// on the account page's Orders and Receipts tabs. The order is placed
// through the API with Square's approved sandbox nonce, then
// cancelled, refunded and deleted. docs/qa-launch.md, "After the
// order".

import { NONCE, eggOrder, postOrder } from "./support/api.mjs";
import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, closeOrder, deleteCustomer,
  linkIn, mailTo, teardown, waitForMail,
} from "./support/staging.mjs";

const SIGN_IN = "Your secure sign-in link to North Foster Farm";

test.describe.configure({ mode: "serial" });

test.describe("accounts", () => {
  test.skip(!backOffice().cli, BACK_OFFICE_MISSING);

  const email = uniqueEmail("account");
  let orderId;
  let since;

  test.beforeAll(async ({ request }) => {
    since = new Date();

    const { status, body } = await postOrder(request, await eggOrder(
      request, { email, nonce: NONCE.ok }
    ));

    expect(status, JSON.stringify(body)).toBe(200);
    orderId = body.orderId;
  });

  test.afterAll(() => teardown([
    () => (orderId ? closeOrder(orderId) : null),
    () => deleteCustomer(email),
    () => clearMail({ to: email, since }),
  ]));

  test("a link by email signs in, once", { tag: "@regression" },
    async ({ page }) => {
      const asked = new Date();

      await page.goto("/login/");
      await page.locator("#login-email").fill(email);
      await page.locator("#login-submit").click();
      await expect(page.locator("#login-sent")).toBeVisible();
      await expect(page.locator("[data-login-email]")).toHaveText(email);

      const mail = await waitForMail({ to: email, subject: SIGN_IN,
        since: asked });
      const link = linkIn(mail, /\/api\/auth\/verify\?token=/);

      expect(link, "sign-in link in the email").toBeTruthy();
      expect(new URL(link).host).toBe(new URL(page.url()).host);

      await page.goto(link);
      await expect(page).toHaveURL(/\/account\/?/);
      await expect(page.locator("#account-email")).toHaveText(email);

      // Every other page knows at once, though /login/ cached "signed
      // out" in this tab (16122c2, #159).
      await page.goto("/about/");
      await expect(page.locator("[data-account-menu]").first())
        .toBeVisible();
      await expect(page.locator("[data-account-signin]").first())
        .toBeHidden();

      // The same link a second time explains itself on /login/.
      await page.context().clearCookies();
      await page.goto(link);
      await expect(page).toHaveURL(/\/login\//);
      await expect(page.locator("[data-login-notice]")).toContainText(
        "already used"
      );
    });

  test("the account page lists the order and its receipt",
    async ({ page }) => {
      const asked = new Date();

      await page.goto("/login/");
      await page.locator("#login-email").fill(email);
      await page.locator("#login-submit").click();

      const mail = await waitForMail({ to: email, subject: SIGN_IN,
        since: asked });

      await page.goto(linkIn(mail, /\/api\/auth\/verify\?token=/));
      await expect(page).toHaveURL(/\/account\/?/);
      await expect(page.locator("#orders-list")).toContainText(orderId);
      await expect(page.locator("#orders-list")).toContainText(
        "Pickup time requested. We'll confirm it by email."
      );
      await page.locator("[data-tab='receipts']").click();
      await expect(page.locator("#receipts-body")).toContainText(orderId);
      // The sandbox's approved nonce is a Visa ending 5858.
      await expect(page.locator("#receipts-body")).toContainText(
        /Visa ending \d{4}/
      );
      await expect(page.locator("#receipts-body")).toContainText("$7");
      await expect(page.locator("body")).not.toContainText("Pay now");
      await expect(page.locator("body")).not.toContainText(
        "I paid by Venmo"
      );
    });
});

// AO-04: three links per address per 15 minutes. The fourth request is
// answered like the others, and the links already sent still work.
test.describe("sign-in links are rate limited", () => {
  test.skip(!backOffice().cli, BACK_OFFICE_MISSING);

  const email = uniqueEmail("links");
  let since;

  test.afterAll(() => teardown([
    () => deleteCustomer(email),
    () => clearMail({ to: email, since }),
  ]));

  test("a fourth link is refused quietly, the first three kept",
    async ({ page }) => {
      since = new Date();

      for (let i = 1; i <= 4; i += 1) {
        await page.goto("/login/");
        await page.locator("#login-email").fill(email);
        await page.locator("#login-submit").click();
        await expect(page.locator("#login-sent"), `request ${i}`)
          .toBeVisible();
        await expect(page.locator("[data-login-email]")).toHaveText(email);
      }

      const links = async () => (await mailTo(email, since))
        .filter((m) => m.subject.includes(SIGN_IN));

      await expect.poll(async () => (await links()).length,
        { timeout: 45_000 }).toBeGreaterThanOrEqual(3);
      // Give a fourth message time to land, then count again.
      await page.waitForTimeout(10_000);

      const sent = await links();

      expect(sent).toHaveLength(3);

      for (const message of [sent[0], sent[2]]) {
        await page.context().clearCookies();
        await page.goto(linkIn(message, /\/api\/auth\/verify\?token=/));
        await expect(page).toHaveURL(/\/account\/?/);
        await expect(page.locator("#account-email")).toHaveText(email);
      }
    });
});
