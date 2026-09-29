// A customer changes their own email (#240): Settings asks for a link
// to the new address, and only following it moves the account. Until
// then nothing changes; after, the old address is told and the account
// signs in at the new one. Accounts are made by signing in, so nothing
// is paid. The rules behind each answer are unit-tested in
// test/email-change.test.mjs.

import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, customerRecord,
  deleteCustomer, linkIn, teardown, waitForMail,
} from "./support/staging.mjs";

const SIGN_IN = "Your secure sign-in link to North Foster Farm";
const CONFIRM = "Confirm your new email for North Foster Farm";
const CHANGED = "Your email with North Foster Farm was changed";
const VERIFY = /\/api\/auth\/verify\?token=/;

test.describe.configure({ mode: "serial" });

test.describe("changing your own email", () => {
  test.skip(!backOffice().cli, BACK_OFFICE_MISSING);

  const from = uniqueEmail("email-from");
  const to = uniqueEmail("email-to");
  const taken = uniqueEmail("email-taken");
  const late = uniqueEmail("email-late");
  let since;

  test.beforeAll(() => {
    since = new Date();
  });

  test.afterAll(() => teardown([from, to, taken, late].flatMap((email) => [
    () => deleteCustomer(email),
    () => clearMail({ to: email, since }),
  ])));

  // Signs in by emailed link, which makes the account if it is new,
  // and opens Settings.
  const signIn = async (page, email) => {
    const asked = new Date();

    await page.context().clearCookies();
    await page.goto("/login/");
    await page.locator("#login-email").fill(email);
    await page.locator("#login-submit").click();
    await expect(page.locator("#login-sent")).toBeVisible();

    const mail = await waitForMail({ to: email, subject: SIGN_IN,
      since: asked });

    await page.goto(linkIn(mail, VERIFY));
    await expect(page).toHaveURL(/\/account\/?/);
    await page.locator("[data-tab='settings']").click();
    await expect(page.locator("#prof-email")).toHaveValue(email);
  };

  // Opens the field, asks for a link to `email` and returns its
  // answer: the note under the field, or the error on it.
  const ask = async (page, email) => {
    await page.locator("#email-change-open").click();
    await expect(page.locator("#email-new")).toBeFocused();
    await page.locator("#email-new").fill(email);
    await page.locator("#email-change-send").click();
  };

  test("a link to the new address moves the account, only once confirmed",
    { tag: "@regression" }, async ({ page }) => {
      await signIn(page, from);

      const asked = new Date();

      await ask(page, to);
      await expect(page.locator("#email-change-sent")).toContainText(
        `We sent a link to ${to}.`
      );
      await expect(page.locator("#email-change")).toBeHidden();

      // Nothing has moved yet.
      expect(await customerRecord(from)).not.toBeNull();
      expect(await customerRecord(to)).toBeNull();

      const mail = await waitForMail({ to, subject: CONFIRM, since: asked });

      // Following the link only peeks at it: the confirm step shows,
      // and nothing has moved yet (#240).
      await page.goto(linkIn(mail, VERIFY));
      await expect(page).toHaveURL(/\/login\/#confirm=/);
      await expect(page.locator("#login-confirm")).toBeVisible();
      await expect(page.locator("[data-confirm-email]")).toHaveText(to);
      expect(await customerRecord(from)).not.toBeNull();
      expect(await customerRecord(to)).toBeNull();

      // Reloading the same link is another bare GET: still nothing
      // moved, and the confirm step still shows.
      await page.goto(linkIn(mail, VERIFY));
      await expect(page.locator("#login-confirm")).toBeVisible();
      expect(await customerRecord(to)).toBeNull();

      // Cancel backs out without confirming.
      await page.locator("#login-confirm-cancel").click();
      await expect(page.locator("#login-confirm")).toBeHidden();
      await expect(page.locator("#login-form")).toBeVisible();
      expect(await customerRecord(to)).toBeNull();

      // The button is what actually moves it.
      await page.goto(linkIn(mail, VERIFY));
      await page.locator("#login-confirm-submit").click();
      await expect(page).toHaveURL(/\/account\/?#settings$/);
      await expect(page.locator("#account-email")).toHaveText(to);
      await expect(page.locator("#prof-email")).toHaveValue(to);
      await expect(page.locator("#email-change-sent")).toContainText(
        `Your email is now ${to}.`
      );

      await waitForMail({ to: from, subject: CHANGED, since: asked });
      expect(await customerRecord(to)).not.toBeNull();
      expect(await customerRecord(from)).toBeNull();

      // Spent: the same link no longer works.
      await page.context().clearCookies();
      await page.goto(linkIn(mail, VERIFY));
      await expect(page).toHaveURL(/\/login\/\?error=unknown/);
    });

  test("the same address, a bad one and one with an account are refused",
    async ({ page }) => {
      const error = page.locator("#err-email-new");

      await signIn(page, taken);
      await signIn(page, to);

      await ask(page, to);
      await expect(error).toHaveText("That's already your email.");
      await page.locator("#email-new").fill("not-an-email");
      await page.locator("#email-change-send").click();
      await expect(error).toHaveText("That email address doesn't look right.");
      await page.locator("#email-new").fill(taken);
      await page.locator("#email-new").press("Enter");
      await expect(error).toContainText(
        "That address already has an account with us."
      );

      // Escape closes the field and gives the focus back to Change.
      await page.locator("#email-new").press("Escape");
      await expect(page.locator("#email-change")).toBeHidden();
      await expect(page.locator("#email-change-open")).toBeFocused();
      await expect(page.locator("#prof-email")).toHaveValue(to);
    });

  test("a link whose address took an account meanwhile changes nothing",
    async ({ page }) => {
      await signIn(page, to);

      const asked = new Date();

      await ask(page, late);
      await expect(page.locator("#email-change-sent")).toContainText(
        `We sent a link to ${late}.`
      );

      const mail = await waitForMail({ to: late, subject: CONFIRM,
        since: asked });

      // The new address signs in on its own before the link is used.
      await signIn(page, late);
      await page.context().clearCookies();

      // The GET still only peeks: the confirm step shows, not knowing
      // yet that the address was taken meanwhile.
      await page.goto(linkIn(mail, VERIFY));
      await expect(page.locator("#login-confirm")).toBeVisible();
      await page.locator("#login-confirm-submit").click();
      await expect(page.locator("[data-confirm-error]")).toContainText(
        "your email wasn't changed"
      );
      expect(await customerRecord(to)).not.toBeNull();
    });
});
