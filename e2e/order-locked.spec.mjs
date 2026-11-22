// The locked card (#643, #818): a change to a paid order that the
// server refuses with `errors.order` shows the card from
// `#order-locked`, with the server's message and the farm's email and
// phone, and clears the change's draft. No spec opened it before
// #818, phase 4 of the split of order-form.js, moved `locked` into
// form/result.js; this one pins it first, on today's code, and must
// keep passing through the move.
//
// The account's endpoints are canned, as in kept-thursday.spec.mjs,
// so this runs on a local build as on staging and saves nothing. The
// refusal is lib/edit.mjs's own (`fail(409, { order: ... })`, as the
// account function sends it), and the dates are lib/dates.mjs's at a
// fixed clock, which the page anchors to.

import { readFileSync } from "node:fs";

import { CUSTOMER, ORDER, dates } from "./support/canned.mjs";
import { SKU, expect, test } from "./support/order.mjs";
import { deliveryDates } from "../assets/scripts/order/lib/dates.mjs";
import { instant } from "../assets/scripts/order/lib/zoned.mjs";

const read = (path) => JSON.parse(readFileSync(
  new URL(path, import.meta.url), "utf8",
));
const TERMS = read("../data/delivery.json");
const COMPANY = read("../data/company.json");

// A week ahead of a Thursday delivery, well before its cutoff.
const NOW = instant("2026-12-03", 9, 0, "America/New_York");
const DAY = "2026-12-10";
const REFUSED = "This order can't be changed any more.";

// $56 of eggs and the $5 fee, for delivery on Thursday the 10th.
const PAID = {
  ...ORDER,
  id: "NFF-2612-QA61",
  submittedAt: "2026-12-01T14:00:00.000Z",
  paidAt: "2026-12-01T14:00:05.000Z",
  lines: [{ ...ORDER.lines[0], qty: 8, lineTotal: 56 }],
  totals: { subtotal: 5600, discountAmount: 0, deliveryFee: 500,
    total: 6100 },
  fulfilment: {
    method: "delivery", date: DAY, state: "agreed", onfarm: null,
    delivery: { address1: "1 Main St", town: "Foster", zip: "02825",
      cooler: "Porch" },
  },
  payments: [{ ...ORDER.payments[0], at: "2026-12-01T14:00:05.000Z",
    amount: 6100 }],
  keptFee: 0,
  keptDate: null,
};
const DRAFT = `nff-edit-${PAID.id}`;

// Signed in with the order on the account, the dates at NOW, and every
// change refused as the server refuses one it can no longer take.
// -> the bodies the page sent
const setUp = async (page, context, baseURL) => {
  const sent = [];

  await context.addCookies([{
    name: "nff_signed_in", value: "1", url: baseURL,
  }]);
  await page.route("**/api/me", (route) => route.fulfill({
    json: { signedIn: true, customer: CUSTOMER },
  }));
  await page.route("**/api/account/orders", (route) => route.fulfill({
    json: { orders: [PAID] },
  }));
  await page.route("**/api/account/cart", (route) => route.fulfill({
    json: { ok: true, cart: null },
  }));
  await page.route("**/api/dates", (route) => route.fulfill({ json: {
    ...dates(),
    now: NOW.toISOString(),
    onfarm: [],
    scheduled: [],
    delivery: deliveryDates(NOW, TERMS),
  } }));
  await page.route(`**/api/account/orders/${PAID.id}/*`, async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 409, json: {
      ok: false, errors: { order: REFUSED },
    } });
  });

  return sent;
};

test.describe("a change the server refuses (#643, #818)", () => {
  test("shows the locked card with the server's message and the farm's "
    + "email and phone, and clears the change's draft",
  { tag: "@regression" }, async ({ page, context, baseURL }) => {
    const sent = await setUp(page, context, baseURL);

    await page.goto(`/order/?edit=${PAID.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator("[data-edit-money] [data-total='paid']"))
      .toHaveText("$61");
    await expect(page.locator("#delivery-date")).toHaveValue(DAY);

    // Seven dozen for eight: nothing is due, so Save changes sends it.
    const qty = page.locator(`[data-qty="${SKU.eggs}"]`);

    await expect(qty).toHaveValue("8");
    await qty.fill("7");
    await qty.blur();
    await expect.poll(
      () => page.evaluate((key) => localStorage.getItem(key), DRAFT),
      "the change is drafted"
    ).not.toBeNull();

    await page.locator("#order-save").click();
    await expect.poll(() => sent.length, "Save changes sent it").toBe(1);

    const card = page.locator(".order-result-card").filter({
      has: page.getByRole("heading", { name: "Your change wasn't saved" }),
    });

    await expect(card).toBeVisible();
    await expect(card.locator("[data-out='message']")).toHaveText(REFUSED);

    const mail = card.locator("[data-out='mailto']");

    await expect(mail).toHaveText(COMPANY.email);
    await expect(mail).toHaveAttribute("href", new RegExp(
      `^mailto:${encodeURIComponent(COMPANY.email)
        .replace(/[.]/g, "\\.")}\\?subject=`
    ));

    const phone = card.locator("[data-out='phone']");

    await expect(phone).toHaveText(COMPANY.phone.display);
    await expect(phone).toHaveAttribute("href", `tel:${COMPANY.phone.plain}`);

    // The failed card is not shown: this is a refusal, not a failure.
    await expect(page.locator(".order-result-failed [data-out='summary']"))
      .toHaveCount(0);

    expect(await page.evaluate((key) => localStorage.getItem(key), DRAFT),
      "the change's draft is cleared").toBeNull();
  });
});
