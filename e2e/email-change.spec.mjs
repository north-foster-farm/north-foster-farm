// A customer changes their own email (#240): Settings asks for a link
// to the new address, and only following it moves the account. Until
// then nothing changes; after, the old address is told and the account
// signs in at the new one. Accounts are made by signing in, so nothing
// is paid. The rules behind each answer are unit-tested in
// test/email-change.test.mjs.

import { expect, test, uniqueEmail } from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearMail, clearSession, customerRecord,
  deleteCustomer, linkIn, teardown, waitForMail,
} from "./support/staging.mjs";

const SIGN_IN = "Your secure sign-in link to North Foster Farm";
const CONFIRM = "Confirm your new email address for North Foster Farm";
const CHANGED = "The email address on your North Foster Farm account " +
  "was changed";
const VERIFY = /\/api\/auth\/verify\?token=/;

test.describe.configure({ mode: "serial" });

test.describe("changing your own email", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

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

    await clearSession(page.context());
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

  // Quarantined on staging (#508, e2e/quarantine.json): the confirm
  // takes about 15 s there while renameCustomer scans every sign-in
  // record.
  test("a link to the new address moves the account, only once confirmed",
    { tag: ["@regression", "@quarantine"] }, async ({ page }) => {
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

      // Following the link only peeks at it: the confirm card shows on
      // the account's Settings tab, still signed in, and nothing has
      // moved yet (#240, #345).
      // The answers on the way, for a run that lands somewhere else.
      const hops = [];

      page.on("response", (r) => {
        if (r.request().isNavigationRequest()) {
          const next = (r.headers().location || "")
            .replace(/confirm=[^&]*/, "confirm=_");

          hops.push(`${r.status()} ${r.url().replace(/token=[^&#]*/,
            "token=_")} -> ${next}`);
        }
      });
      await page.goto(linkIn(mail, VERIFY));
      // The redirect has a query of its own, so Netlify copies none
      // onto it: the token stays in the fragment the page then drops.
      await expect(page, hops.join("\n"))
        .toHaveURL(/\/account\/\?via=link#settings$/);
      await expect(page.locator("#account-confirm")).toBeVisible();
      await expect(page.locator("#account-confirm [data-confirm-email]"))
        .toHaveText(to);
      await expect(page.locator("#account-email")).toHaveText(from);
      expect(await customerRecord(from)).not.toBeNull();
      expect(await customerRecord(to)).toBeNull();

      // Reloading the same link is another bare GET: still nothing
      // moved, and the card still shows.
      await page.goto(linkIn(mail, VERIFY));
      await expect(page.locator("#account-confirm")).toBeVisible();
      expect(await customerRecord(to)).toBeNull();

      // Cancel backs out without confirming, beside Confirm.
      await expect(page.locator("#account-confirm-submit")).toBeVisible();
      await page.locator("#account-confirm-cancel").click();
      await expect(page.locator("#account-confirm")).toBeHidden();
      await expect(page.locator("#email-change-open")).toBeFocused();
      expect(await customerRecord(to)).toBeNull();

      // The button is what actually moves it.
      await page.goto(linkIn(mail, VERIFY));
      await page.locator("#account-confirm-submit").click();
      await expect(page).toHaveURL(/\/account\/?#settings$/);
      await expect(page.locator("#account-email")).toHaveText(to);
      await expect(page.locator("#prof-email")).toHaveValue(to);
      await expect(page.locator("#email-change-sent")).toContainText(
        `Your email address has been changed to ${to}.`
      );

      await waitForMail({ to: from, subject: CHANGED, since: asked });
      expect(await customerRecord(to)).not.toBeNull();
      expect(await customerRecord(from)).toBeNull();

      // Spent: the same link no longer works.
      await clearSession(page.context());
      await page.goto(linkIn(mail, VERIFY));
      await expect(page).toHaveURL(/\/login\/\?error=unknown/);
    });

  test("the same address, a bad one and one with an account are refused",
    async ({ page }) => {
      const error = page.locator("#err-email-new");

      await signIn(page, taken);
      await signIn(page, to);

      await ask(page, to);
      await expect(error).toHaveText("That's already your email address.");
      await page.locator("#email-new").fill("not-an-email");
      await page.locator("#email-change-send").click();
      await expect(error)
        .toHaveText("Please enter a valid email address.");
      await page.locator("#email-new").fill(taken);
      await page.locator("#email-new").press("Enter");
      await expect(error).toContainText(
        "That email address already exists."
      );
      await expect(error.getByRole("link", { name: "contact us" }))
        .toHaveAttribute("href", "mailto:sales@northfosterfarm.com");

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
      await clearSession(page.context());

      // The GET still only peeks: with no session here, the account
      // page hands the link to the sign-in page's card (#345), not
      // knowing yet that the address was taken meanwhile.
      await page.goto(linkIn(mail, VERIFY));
      await expect(page).toHaveURL(/\/login\//);
      await expect(page.locator("#login-confirm")).toBeVisible();
      await page.locator("#login-confirm-submit").click();
      await expect(page.locator("[data-confirm-error]")).toContainText(
        "That email address already exists."
      );
      expect(await customerRecord(to)).not.toBeNull();
    });
});
