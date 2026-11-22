// The account page's arrivals, deletion and credit, pinned before
// account/main.js is split (#832, docs/refactors/account.md, phase 0,
// criteria 9 to 11): phases 6, 7 and 9 move the head, the delete
// dialog and the arrivals. Canned answers (support/account-page.mjs,
// support/membership.mjs), so this runs on a local build. Passes
// against today's page.

import {
  CUSTOMER, openAccount, shown, writes,
} from "./support/account-page.mjs";
import { MEMBER_GROUP, signIn } from "./support/membership.mjs";
import { expect, test } from "./support/order.mjs";

test.describe("the account page's arrivals and head (#832)", () => {
  test("?joined=1 shows the joined banner once, on Membership, and drops "
    + "the flag", async ({ page, context, baseURL }) => {
    await signIn(page, context, baseURL);
    await page.goto("/account/?joined=1");
    await shown(page);

    const banner = page.locator("#membership-joined");

    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(`You've joined ${MEMBER_GROUP}.`);
    await expect(page.locator("#acct-membership")).toBeVisible();
    await expect(page).not.toHaveURL(/joined=/);

    await page.reload();
    await shown(page);
    await expect(banner).toBeHidden();
  });

  test("Delete with another address typed is refused in words and sends "
    + "nothing", async ({ page, context, baseURL }) => {
    const state = await openAccount(page, { context, baseURL });

    await page.goto("/account/#settings");
    await shown(page);
    await page.locator("#account-delete").click();
    await page.locator("#delete-confirm-email").fill("someone@example.com");
    await page.locator("#delete-confirm-email").press("Enter");
    await expect(page.locator("#delete-confirm-note"))
      .toHaveText("That isn't the email address on this account.");
    await page.waitForTimeout(500);
    expect(writes(state, "POST", "/api/account/delete")).toHaveLength(0);
  });

  test("a member's credit shows beside Sign out, and credit kept after "
    + "leaving a group does too", async ({ page, context, baseURL }) => {
    await signIn(page, context, baseURL);
    await page.goto("/account/");
    await shown(page);

    const credit = page.locator("#account-under #account-credit");

    await expect(credit).toBeVisible();
    await expect(credit).toHaveText("Credit: $15");

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await openAccount(page, { context, baseURL }, {
      me: { signedIn: true, customer: CUSTOMER, credit: 300 },
    });
    await page.reload();
    await shown(page);
    await expect(credit).toBeVisible();
    await expect(credit).toHaveText("Credit: $3");
  });
});
