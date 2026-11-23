// The account page signed in with canned answers, for the specs that
// pin it before account/main.js is split (#832,
// docs/refactors/account.md, phase 0). Nothing is saved anywhere, so
// these run on a local build as on staging.
//
// Every write the page sends to /api/account/* is kept in `sent`, as
// { method, path, body }, and answered by `answer`, which a spec
// replaces to refuse or hold a save. The canned answers follow the
// functions' own shapes: a save answers { ok, customer } as
// netlify/functions/lib/account.mjs does, a refusal { ok: false,
// errors }.

import { CUSTOMER, ORDER } from "./canned.mjs";
import { expect } from "./order.mjs";

export { CUSTOMER, ORDER };

// A paid order of two lines, for the order card and the receipts.
export const PAID = {
  ...ORDER,
  id: "NFF-2610-QA87",
  lines: [
    { sku: "NFF-CHK-EGG-LG", label: "Eggs, Grade A · Large", qty: 2,
      unitPrice: 7, lineTotal: 14 },
    { sku: "NFF-CHK-EGG-MD", label: "Eggs, Grade A · Medium", qty: 1,
      unitPrice: 6, lineTotal: 6 },
  ],
  totals: { subtotal: 2000, discountAmount: 0, deliveryFee: 0,
    total: 2000 },
  payments: [{ ...ORDER.payments[0], amount: 2000 }],
};

// The customer as a save leaves it: the record with `changes` on it.
export const saved = (changes) => ({
  ok: true, customer: { ...CUSTOMER, ...changes },
});

const record = async (route, state) => {
  const request = route.request();

  state.sent.push({
    method: request.method(),
    path: new URL(request.url()).pathname,
    body: request.postDataJSON(),
  });
  await state.answer(route, state.sent.at(-1));
};

// The default answer: every save goes through.
const accept = (route, { body }) => route.fulfill({ json: saved(body) });

// Signed in as `me`'s customer, with `orders` on the account.
// -> { sent, answer } (set `answer` to change how writes are answered)
export const openAccount = async (page, { context, baseURL }, {
  me = { signedIn: true, customer: CUSTOMER }, orders = [],
} = {}) => {
  const state = { sent: [], answer: accept, me };

  await context.addCookies([{
    name: "nff_signed_in", value: "1", url: baseURL,
  }]);
  // The writes first: a route added later answers first, so the reads
  // below take their own paths.
  await page.route("**/api/account/**", (route) => record(route, state));

  const reads = {
    "**/api/me": () => state.me,
    "**/api/account/orders": () => ({ orders }),
    "**/api/account/cart": () => ({ ok: true, cart: null }),
  };

  for (const [glob, json] of Object.entries(reads)) {
    await page.route(glob, (route) => route.fulfill({ json: json() }));
  }

  return state;
};

// The writes sent to one path, by method.
export const writes = (state, method, path) => state.sent
  .filter((s) => s.method === method && s.path === path);

// The two helpers below are account-settings.spec.mjs's. Next dropped
// them as unused (PR #960, ce71ae89) when only
// account-orders-pinned.spec.mjs had landed: whoever lands
// account-settings.spec.mjs or account-arrivals.spec.mjs from this
// branch brings them back with it.

// Holds the next write until the function returned is called with its
// answer (route.fulfill's options).
export const hold = (state) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });

  state.answer = async (route) => route.fulfill(await held);

  return (answer) => release(answer);
};

// Fills `field` and leaves it, as a person does: its change event.
export const leave = async (page, field, value) => {
  await page.locator(field).fill(value);
  await page.locator(field).blur();
};

// Waits until the page has drawn the account.
export const shown = (page) => expect(page.locator("#account-app"))
  .toBeVisible();
