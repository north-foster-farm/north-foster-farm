// The account page's orders and receipts, pinned before
// account/main.js is split (#832, docs/refactors/account.md, phase 0,
// criteria 6 to 8): phases 2, 3 and 9 move the card, the receipts and
// the arrival by an order's link. Canned answers
// (support/account-page.mjs), so this runs on a local build. Passes
// against today's page.

import { PAID, openAccount, shown, writes } from "./support/account-page.mjs";
import { expect, test } from "./support/order.mjs";

const RETURN = `/api/account/orders/${PAID.id}/return`;
const card = (page) => page.locator(`#order-${PAID.id}`);

// Venmo pays with no processor receipt: the page's own card (#238).
const BY_VENMO = {
  ...PAID,
  payments: [{
    at: "2026-09-26T14:00:05.000Z", amount: 2000, via: "venmo",
    method: "venmo", payer: "Ada Hen", paypalCaptureId: "3C679366HH908993F",
  }],
};

const reported = (body) => ({
  ok: true,
  order: { ...PAID, returns: [{
    at: "2026-09-28T15:00:00.000Z", status: "requested", ...body,
  }] },
});

test.describe("the account page's orders (#832)", () => {
  test("Report a problem lists the order's items, sends the reason and the "
    + "items ticked, and the card then says a problem was reported",
  async ({ page, context, baseURL }) => {
    const state = await openAccount(page, { context, baseURL },
      { orders: [PAID] });

    state.answer = (route, { body }) => route.fulfill({ json: reported(body) });
    await page.goto("/account/#orders");
    await shown(page);
    await card(page).getByRole("button", { name: "Report a problem" }).click();

    const items = card(page).locator("[data-items] label");

    await expect(items).toHaveText([
      "2 × Eggs, Grade A · Large", "1 × Eggs, Grade A · Medium",
    ]);
    await items.nth(1).locator("input").check();
    await card(page).locator("[name='reason']").fill("Two were cracked.");
    await card(page).getByRole("button", { name: "Send" }).click();
    await expect.poll(() => writes(state, "POST", RETURN).length).toBe(1);
    expect(writes(state, "POST", RETURN)[0].body).toEqual({
      reason: "Two were cracked.", skus: ["NFF-CHK-EGG-MD"],
    });
    await expect(card(page).locator(".account-return"))
      .toContainText("Problem reported");
    await expect(card(page).locator(".account-return"))
      .toContainText("we're on it.");
  });

  test("a Venmo payment's Receipt opens the receipt card with the payer and "
    + "the PayPal capture", async ({ page, context, baseURL }) => {
    await openAccount(page, { context, baseURL }, { orders: [BY_VENMO] });
    await page.goto("/account/#receipts");
    await shown(page);
    await page.locator("#receipts-list").getByRole("link", { name: "Receipt" })
      .click();

    const receipt = page.locator("#receipt-card");

    await expect(receipt).toBeVisible();
    await expect(page.locator("#receipt-card-h"))
      .toHaveText(`Receipt for ${PAID.id}`);
    await expect(receipt.locator("[data-receipt='payer']"))
      .toHaveText("Ada Hen");
    await expect(receipt.locator("[data-receipt='capture']"))
      .toHaveText("PayPal 3C679366HH908993F");
  });

  test("/account/orders/<id>/ opens Orders with that card focused and "
    + "marked; an id the account lacks says so",
  async ({ page, context, baseURL }) => {
    const state = await openAccount(page, { context, baseURL },
      { orders: [PAID] });

    await page.goto(`/account/orders/${PAID.id}/`);
    await shown(page);
    await expect(page.locator("#acct-orders")).toBeVisible();
    await expect(card(page)).toHaveClass(/\bis-linked\b/);
    await expect(card(page)).toBeFocused();
    // #924: the head's avatar is a <use> of the page's own sprite,
    // which a base element can send to another document.
    await expect.poll(() => page.locator("#account-avatar use")
      .evaluate((use) => use.getBBox().width),
    { message: "the avatar draws" }).toBeGreaterThan(0);

    await page.goto("/account/orders/NFF-0000-NOPE/");
    await shown(page);
    await expect(page.locator("#account-flash")).toHaveText(
      "We couldn't find order NFF-0000-NOPE on this account. Here's "
      + "everything you've ordered."
    );

    // #924: signed out, the way back from signing in still names
    // the order.
    state.me = { signedIn: false };
    await page.goto(`/account/orders/${PAID.id}/`);
    await expect(page).toHaveURL(/\/login\/\?next=/);
    expect(new URL(page.url()).searchParams.get("next"),
      "the return address carries the order").toContain(PAID.id);
  });
});
