// The Membership tab, signed in with canned answers, for
// membership.spec.mjs and membership-layout.spec.mjs: a member of one
// group (its pickup place named as the group, #602) who hosts
// another. Nothing is saved anywhere, so this runs on a local build.

import { CUSTOMER, cannedDates } from "./canned.mjs";

export const MEMBER_GROUP = "The Village Family Fitness";
export const HOSTED_GROUP = "Second Gym";

const place = (name) => ({
  name, street: "1 Main St", city: "Foster", state: "RI", zip: "02825",
});

// The rounds as lib/membership.mjs's roundsNow gives them on Saturday,
// Nov 21: the Nov 22 pickup open, the Dec 6 one next.
export const CLOSES = "2026-11-22T04:59:00.000Z";
export const ROUNDS = {
  every: 2, opens: "08:30", closes: "09:00",
  current: { date: "2026-11-22", closesAt: CLOSES },
  next: { date: "2026-12-06", opensAt: CLOSES },
};

// Between the Nov 22 round's close and its pickup (#600).
const LATER = "2026-12-06T04:59:00.000Z";

export const CLOSED_ROUNDS = {
  ...ROUNDS,
  closed: { date: "2026-11-22", closedAt: CLOSES },
  current: { date: "2026-12-06", closesAt: LATER },
  next: { date: "2026-12-20", opensAt: LATER },
};

export const VIEW = {
  member: {
    key: "vff", group: { name: MEMBER_GROUP, place: place(MEMBER_GROUP) },
    rounds: ROUNDS, code: { id: "NFM-7K4T9WXR" },
  },
  hosts: [{
    key: "gym2", group: { name: HOSTED_GROUP, place: place("Canned Gym") },
    rounds: { ...ROUNDS, next: null },
    qr: { link: "http://localhost/gym2" },
    members: [{
      email: "rob@example.com", name: "Rob Example",
      joinedAt: "2026-10-28T00:00:00.000Z", via: "farm",
    }],
  }],
};

export const SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" "
  + "viewBox=\"0 0 1 1\"><rect width=\"1\" height=\"1\"/></svg>";

// /api/me for a member of "vff" (lib/auth.mjs gives `memberGroup` as
// the group's key) with the head's group and credit.
export const ME = {
  signedIn: true, membership: true,
  customer: { ...CUSTOMER, memberGroup: "vff" },
  member: { name: MEMBER_GROUP, credit: 1500 },
};

export const signIn = async (page, context, baseURL, {
  view = VIEW, me = ME,
} = {}) => {
  await context.addCookies([{
    name: "nff_signed_in", value: "1", url: baseURL,
  }]);
  await page.route("**/api/me", (route) => route.fulfill({ json: me }));
  await page.route("**/api/account/orders", (route) => route.fulfill({
    json: { orders: [] },
  }));
  await page.route("**/api/account/cart", (route) => route.fulfill({
    json: { ok: true, cart: null },
  }));
  // The QR codes and the member's code image, then the view (the last
  // route added answers first).
  await page.route("**/api/membership/**", (route) => route.fulfill({
    contentType: "image/svg+xml", body: SVG,
  }));
  await page.route("**/api/membership", (route) => route.fulfill({
    json: view,
  }));
  await cannedDates(page);
};

// The tab's group blocks: the member's own first, then the hosted one.
export const groups = (page) => {
  const blocks = page.locator("#mem-groups [data-mem-group]");

  return { blocks, own: blocks.nth(0), hosted: blocks.nth(1) };
};
