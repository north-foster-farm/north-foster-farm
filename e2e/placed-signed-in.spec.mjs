// Criteria test for #723's box from James's approval in chat
// (2026-11-21 16:54 ET, "Signed-in customers"): a signed-in customer
// is not asked to sign in, and is pointed at the account page's
// Orders tab instead.
//
// Held out of every run by its name: the config takes *.spec.mjs only,
// so renaming it to placed-signed-in.spec.mjs turns it on. It places
// each order against the fake payment drivers (#265), skipping where
// they are not offered. Signed in is as far as the page knows, as in
// payment.spec.mjs: the session stamp and a faked /api/me.

import {
  OrderPage, expect, paymentFakes as fakes, test, uniqueEmail,
} from "./support/order.mjs";

const SIGNED_IN = "View or change your order on your account page.";
const SIGN_IN = new RegExp(
  "To view or change your order,\\s+sign in\\s+using your email" +
    "\\s+address\\."
);

const signIn = async (page, baseURL, email) => {
  // Without the session stamp the order page never applies /api/me's
  // answer.
  await page.context().addCookies([
    { name: "nff_signed_in", value: "1", url: baseURL },
  ]);
  // Unanswered, the cart request gets a 401 that clears the stamp.
  await page.route("**/api/account/cart", (route) => route.fulfill({
    json: { ok: true, cart: null },
  }));
  await page.route("**/api/me", (route) => route.fulfill({
    json: {
      signedIn: true,
      customer: {
        email, firstName: "Placed", lastName: "Tester",
        phone: "4015550100", discountGroup: null, address: null,
      },
    },
  }));
};

const place = async (page, email) => {
  const order = new OrderPage(page);

  await order.open({ eggs: 1 });
  await order.method("onfarm");
  await order.contact({ first: "Placed", email, phone: "4015550100" });
  await order.firstDate("onfarm");
  await order.openCard();
  await order.card();

  const { status, body } = await order.pay();

  expect(status, JSON.stringify(body)).toBe(200);
  await expect(order.result).toBeVisible();

  return order.result;
};

test.describe("#723 the order placed panel, signed in", () => {
  test.beforeEach(async ({ request }) => {
    test.skip(!(await fakes(request)).square, "SQUARE_ENV is not fake here");
  });

  test("A signed-in customer sees \"View or change your order on your " +
    "account page.\" in place of the sign-in sentence, with \"your " +
    "account page\" linking to the account page's Orders tab; a " +
    "signed-out customer still sees the sign-in sentence",
  async ({ page, baseURL }) => {
    // Signed out first, so the signed-in stamp and routes come after.
    await test.step("signed out", async () => {
      const card = await place(page, uniqueEmail("placed-signed-out"));

      await expect(card.getByText(SIGN_IN)).toBeVisible();
      await expect(card.getByRole("link", { name: /^sign in$/i }))
        .toBeVisible();
      await expect(card.getByText(SIGNED_IN)).toBeHidden();
      await expect(card.getByRole("link", { name: /your account page/i }))
        .toBeHidden();
    });

    await test.step("signed in", async () => {
      const email = uniqueEmail("placed-signed-in");

      await signIn(page, baseURL, email);

      const card = await place(page, email);
      const line = card.getByText(SIGNED_IN);
      const link = card.getByRole("link", {
        name: "your account page", exact: true,
      });

      // The sentence word for word, its case and full stop included.
      await expect(line).toBeVisible();
      await expect(card).toContainText(SIGNED_IN);
      await expect(link).toBeVisible();
      await expect(line.getByRole("link", { name: "your account page" }))
        .toBeVisible();

      const href = new URL(await link.getAttribute("href"), page.url());

      expect(href.origin, "the link stays on the site")
        .toBe(new URL(page.url()).origin);
      expect(href.pathname, "the link goes to the account page")
        .toBe("/account/");
      expect(href.hash, "the link opens the Orders tab")
        .toMatch(/^#orders\b/);
      await expect(card.getByText(SIGN_IN)).toBeHidden();
      await expect(card.getByRole("link", { name: /^sign in$/i }))
        .toBeHidden();
    });
  });
});
