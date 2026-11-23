// A paid order on the account, for the specs that change one (#643):
// kept-thursday.spec.mjs and order-locked.spec.mjs. The account's
// endpoints are canned (support/canned.mjs), so these run on a local
// build as on staging and save nothing.

import { CUSTOMER, ORDER } from "./canned.mjs";

// $56 of eggs and the $5 fee, for delivery on `date`, paid on the 1st.
export const paidDelivery = (id, date) => ({
  ...ORDER,
  id,
  submittedAt: "2026-12-01T14:00:00.000Z",
  paidAt: "2026-12-01T14:00:05.000Z",
  lines: [{ ...ORDER.lines[0], qty: 8, lineTotal: 56 }],
  totals: { subtotal: 5600, discountAmount: 0, deliveryFee: 500,
    total: 6100 },
  fulfilment: {
    method: "delivery", date, state: "agreed", onfarm: null,
    delivery: { address1: "1 Main St", town: "Foster", zip: "02825",
      cooler: "Porch" },
  },
  payments: [{ ...ORDER.payments[0], at: "2026-12-01T14:00:05.000Z",
    amount: 6100 }],
  keptFee: 0,
  keptDate: null,
});

// Signed in as the canned customer, with `orders` on the account and
// no cart saved.
export const signedInWith = async (page, context, baseURL, orders) => {
  await context.addCookies([{
    name: "nff_signed_in", value: "1", url: baseURL,
  }]);
  await page.route("**/api/me", (route) => route.fulfill({
    json: { signedIn: true, customer: CUSTOMER },
  }));
  await page.route("**/api/account/orders", (route) => route.fulfill({
    json: { orders },
  }));
  await page.route("**/api/account/cart", (route) => route.fulfill({
    json: { ok: true, cart: null },
  }));
};
