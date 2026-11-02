// Signing in partway through an order, with a perk (#521). A customer
// with free delivery starts a delivery signed out, so the fee shows.
// "Have an account? Don't forget to sign in." takes them to /login/
// and back to /order/. Where the link opens in another browser (a
// phone's mail app), the cart lines and the delivery choice arrive with
// it, and nothing typed; where an order tab stayed open, it notices
// the sign-in when the customer comes back to it, prices with the perk
// and pays at that price. The back office sets the perk (perks add) and
// takes it off after.

import {
  OrderPage, expect, test, uniqueEmail,
} from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, clearSession, closeOrder,
  deleteCustomer, linkIn, nff, teardown, waitForMail,
} from "./support/staging.mjs";

const SIGN_IN = "Your secure sign-in link to North Foster Farm";
const PROMPT = "Have an account? Don't forget to sign in.";
const PERK = "Free delivery";

test.describe("signing in partway through an order (#521)", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const email = uniqueEmail("signin-perk");
  const orders = [];
  let since;

  test.beforeAll(async () => {
    since = new Date();
    await nff(["perks", "add", email, "free-delivery"]);
  });

  test.afterAll(() => teardown([
    ...orders.map((id) => () => closeOrder(id)),
    () => nff(["perks", "remove", email, "free-delivery"],
      { allowFail: true }),
    () => deleteCustomer(email),
    () => clearMail({ to: email, since }),
  ]));

  // Three whole chickens to Scituate, signed out: the fee shows.
  const start = async (page) => {
    await clearSession(page.context());

    const order = new OrderPage(page);

    await order.open({ whole: 3 });
    await order.delivery();

    const date = await order.firstDate("delivery");

    await expect(order.fee).toHaveText("+$5");
    await expect(page.locator("[data-cart-perks]")).toBeHidden();
    await expect(page.locator("[data-signin-prompt]")).toHaveText(PROMPT);

    return { order, date };
  };

  test("the link in another browser brings the cart and the perk",
    async ({ page }) => {
      const { order, date } = await start(page);

      await page.locator("[data-signin-prompt]")
        .getByRole("link", { name: "sign in" }).click();
      await expect(page).toHaveURL(/\/login\/\?next=(\/|%2F)order(\/|%2F)$/i);

      const asked = new Date();

      await page.locator("#login-email").fill(email);
      await page.locator("#login-submit").click();

      const mail = await waitForMail({ to: email, subject: SIGN_IN,
        since: asked });

      // Another browser: nothing of this one's draft or session.
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await clearSession(page.context());
      await page.goto(linkIn(mail, /\/api\/auth\/verify\?token=/));
      await expect(page).toHaveURL(/\/order\/(\?|$)/);

      // The lines and the delivery choice came; the address did not.
      await expect(order.qty("whole")).toHaveValue("3");
      await expect(page.locator("#method-delivery")).toBeChecked();
      await expect(page.locator("#delivery-date")).toHaveValue(date);
      await expect(page.locator("#delivery-address1")).toHaveValue("");
      await expect(page.locator("#customer-email")).toHaveValue(email);

      // Priced with the perk, and the prompt gone.
      await expect(page.locator("[data-cart-perks]")).toHaveText(PERK);
      await expect(order.fee).toHaveText("$0");
      await expect(page.locator("[data-signin-prompt]")).toBeHidden();
    });

  test("an order tab left open notices the sign-in and pays with the perk",
    { tag: "@regression" }, async ({ page }) => {
      const { order } = await start(page);

      await order.contact({ first: "Perk", email, phone: "4015550100" });

      // Signed in in another tab, as the emailed link would.
      const other = await page.context().newPage();

      await other.goto(await nff(["login", email]));
      await expect(other).toHaveURL(/\/account\/?/);
      await other.close();

      // Back to the order tab.
      await page.bringToFront();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));

      await expect(page.locator("[data-cart-perks]")).toHaveText(PERK);
      await expect(order.fee).toHaveText("$0");
      await expect(page.locator("[data-signin-prompt]")).toBeHidden();
      // What was typed here stays.
      await expect(page.locator("#customer-first-name")).toHaveValue("Perk");
      await expect(page.locator("#delivery-address1"))
        .toHaveValue("1 Test Lane");

      await order.openCard();
      await order.card();

      const { status, body } = await order.pay();

      expect(status, JSON.stringify(body)).toBe(200);
      orders.push(body.orderId);
      expect(body.totals.perks).toEqual(["free-delivery"]);
      expect(body.totals.deliveryFee).toBe(0);
    });
});
