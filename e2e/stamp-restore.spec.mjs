// Criteria test for #985 (a late 401 can leave the header signed in
// and the order form not), the box marked "(test, in a browser)",
// named for it and written from the issue's words before the
// implementation. The unit boxes are test/me-stamp.criteria.mjs.
//
// Provisional: written to security's proposal, "Let /api/me set the
// stamp again when it finds a live session and the request carried
// none".
//
// A real session, signed in by the back office's link, with a name on
// the account so the contact fields have something to fill. Then only
// the stamp goes, as the late 401 of the issue clears it, and the
// session lives on. The next page load is the order form. Written and
// linted in a cloud run, never run there (no browser).

import { expect, test, uniqueEmail } from "./support/order.mjs";
import { followLink } from "./support/request-error.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearSession, deleteCustomer, nff,
  teardown,
} from "./support/staging.mjs";

// No retries (#693): a retry would reuse a single-use sign-in link.
test.describe.configure({ retries: 0 });

const STAMP = "nff_signed_in";
const FIRST = "Stamp";
const LAST = "Restore";

test.describe("a stamp cleared while the session lives (#985)", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const email = uniqueEmail("stamp-restore");

  test.afterAll(() => teardown([() => deleteCustomer(email)]));

  test("After a stamp is cleared while the session lives, the next page " +
    "load shows the order form signed in, with the contact fields filled",
  async ({ page, context }) => {
    await clearSession(context);
    await followLink(page, await nff(["login", email]));
    await expect(page).toHaveURL(/\/account\/?/);

    // The account's name, as the account page saves it.
    const saved = await page.evaluate(async (name) => {
      const res = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(name),
      });

      return res.status;
    }, { firstName: FIRST, lastName: LAST });

    expect(saved, "the name is saved").toBe(200);

    const cookies = async () => context.cookies();
    const stamp = async () => (await cookies())
      .find((c) => c.name === STAMP && c.value);

    expect(await stamp(), "signed in with a stamp").toBeTruthy();

    // Only the stamp goes; the session cookie stays.
    await context.clearCookies({ name: STAMP });
    expect(await stamp(), "the stamp is gone").toBeFalsy();
    expect((await cookies()).some((c) => c.name === "nff_session"),
      "the session lives").toBe(true);

    // The next page load: the order form.
    await page.goto("/order/");

    await expect(page.locator("[data-signin-prompt]")).toBeHidden();
    await expect(page.locator("#customer-first-name")).toHaveValue(FIRST);
    await expect(page.locator("#customer-last-name")).toHaveValue(LAST);
    await expect(page.locator("#customer-email")).toHaveValue(email);

    // And the stamp is back, so cart sync and the next pages agree.
    await expect.poll(async () => !!(await stamp()),
      { message: "the stamp is set again" }).toBe(true);
  });
});
