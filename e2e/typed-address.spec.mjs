// A typed address changes nothing (#521): signed out, the order page
// looks and behaves the same whether the email address typed is a perk
// holder's or a stranger's. The prompt stays, the totals stay, no perk
// line shows, and the address goes to no endpoint while it is typed.
// The API half is test/perk-checkout.test.mjs. The back office sets
// the perk and takes it off after.

import {
  OrderPage, expect, test, uniqueEmail,
} from "./support/order.mjs";
import {
  BACK_OFFICE_MISSING, backOffice, clearSession, deleteCustomer, nff,
  teardown,
} from "./support/staging.mjs";

const PROMPT = "Have an account? Don't forget to sign in.";

test.describe("a typed address changes nothing (#521)", () => {
  test.skip(!backOffice().ready, BACK_OFFICE_MISSING);

  const holder = uniqueEmail("typed-perk");
  const stranger = uniqueEmail("typed-none");

  test.beforeAll(async () => {
    await nff(["perks", "add", holder, "friends"]);
  });

  test.afterAll(() => teardown([
    () => nff(["perks", "remove", holder, "friends"], { allowFail: true }),
    () => deleteCustomer(holder),
  ]));

  test("a perk holder's address reads as anyone's", async ({ page }) => {
    await clearSession(page.context());

    const sent = [];

    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/")) {
        sent.push(`${r.method()} ${r.url()} ${r.postData() || ""}`);
      }
    });

    const order = new OrderPage(page);

    await order.open({ whole: 3 });
    await order.delivery();
    await order.firstDate("delivery");

    const email = page.locator("#customer-email");
    // What the page shows that an address might sway.
    const shown = async () => ({
      prompt: await page.locator("[data-signin-prompt]").isVisible()
        && await page.locator("[data-signin-prompt]").textContent(),
      perks: await page.locator("[data-cart-perks]").isVisible(),
      fee: await order.fee.textContent(),
      discount: await order.discountRow.isVisible(),
      total: await order.total.textContent(),
    });
    const typed = async (address) => {
      await email.fill(address);
      await email.blur();
      // Room for anything the page might do with it.
      await page.waitForTimeout(1_500);

      return shown();
    };

    const before = await shown();

    expect(before.prompt).toBe(PROMPT);
    expect(before.perks).toBe(false);

    const theirs = await typed(holder);
    const anyones = await typed(stranger);

    expect(theirs).toEqual(before);
    expect(anyones).toEqual(before);
    expect(sent.filter((s) => s.includes(holder) || s.includes(stranger)
      || s.includes(encodeURIComponent(holder)))).toEqual([]);
  });
});
