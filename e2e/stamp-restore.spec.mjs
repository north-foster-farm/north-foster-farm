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
//
// The second test, a signed-out visitor unaffected, is the criterion
// added on 2026-11-23 for PR #1001's client change; see its comment.

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

// The other side, asked for on 2026-11-23 after PR #1001 had the order
// form apply /api/me's answer on a load with no stamp: a visitor with
// no stamp and no session is unaffected. A fresh context holds no
// cookies, so the real /api/me answers signed out; nothing is faked.
//
// The count. On next, a stampless /order/ asks through me() from two
// places, the header (session.js Session.show) and the form's
// whileLoading (order-form.js start). me() fetches at most once a
// call, but the second call finds the first's answer in sessionStorage
// when that has landed, so next asks once or twice by timing, never
// more. That can't be shown to be 2 every time, so the test holds the
// ceiling, 2, and at least the header's 1.
const ME_ON_NEXT = 2;

test.describe("a signed-out visitor with no stamp (#985)", () => {
  test("On /order/ with no stamp and no live session, the sign-in prompt " +
    "stays, the contact fields stay empty, no skeleton is drawn over them, " +
    "and /api/me is asked no more times than on next",
  async ({ page, context }) => {
    expect((await context.cookies()).map((c) => c.name),
      "no stamp, no session").toEqual(
      expect.not.arrayContaining([STAMP, "nff_session"]),
    );

    let asked = 0;

    page.on("request", (req) => {
      if (new URL(req.url()).pathname === "/api/me") asked += 1;
    });

    // Every state a contact field's region takes, from the first paint.
    await page.addInitScript(() => {
      window.qaPrefill = [];
      new MutationObserver((changes) => {
        for (const c of changes) {
          if (!c.target.matches("[data-prefill-region]")) continue;
          window.qaPrefill.push(
            `${c.attributeName}=${c.target.getAttribute(c.attributeName)}`,
          );
        }
      }).observe(document, {
        attributes: true, attributeFilter: ["data-load", "aria-busy"],
        subtree: true,
      });
    });

    const answered = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/me",
    );

    await page.goto("/order/");

    expect(await (await answered).json(), "/api/me answers signed out")
      .toMatchObject({ signedIn: false });

    // The header has its answer; then time for the form's to land, and
    // for anything it would draw or fill.
    await expect(page.locator("[data-account].is-ready").first())
      .toBeAttached();
    await page.waitForTimeout(1_500);

    await expect(page.locator("[data-signin-prompt]")).toBeVisible();
    for (const id of ["first-name", "last-name", "email", "phone"]) {
      await expect(page.locator(`#customer-${id}`), id).toHaveValue("");
    }

    const regions = page.locator("[data-prefill-region]");

    await expect(regions).not.toHaveCount(0);
    for (const region of await regions.all()) {
      await expect(region).not.toHaveAttribute("data-load", /./);
      await expect(region).not.toHaveAttribute("aria-busy", /./);
    }
    expect(await page.evaluate(() => window.qaPrefill),
      "no skeleton was drawn at any point").toEqual([]);

    expect(asked, "/api/me is asked").toBeGreaterThanOrEqual(1);
    expect(asked, "no more than on next").toBeLessThanOrEqual(ME_ON_NEXT);
  });
});
