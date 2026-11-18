// Words the account page keeps together keep their space (#598). #593
// joined them with a no-break space, which Aller draws with no width
// (its U+00A0 has an advance of 0) in Chromium and Firefox ("The
// Village FamilyFitness"). Now each pair sits in a text-nowrap span
// with an ordinary space. Each gap is measured as drawn, so a space
// with no width fails, on desktop, the phone and the iPhone. Signed in
// with canned answers, so this runs on a local build and saves
// nothing.

import { CUSTOMER, cannedDates } from "./support/canned.mjs";
import { wordGaps } from "./support/gaps.mjs";
import { expect, test } from "./support/order.mjs";

const CLOSES = "2026-11-22T04:59:00.000Z";
const VIEW = {
  member: {
    key: "vff",
    group: {
      name: "The Village Family Fitness",
      place: {
        name: "The Village Family Fitness", street: "53 Venturi Ave",
        city: "Warwick", state: "RI", zip: "02888",
      },
    },
    rounds: {
      every: 2, opens: "08:30", closes: "09:00",
      current: { date: "2026-11-22", closesAt: CLOSES },
      next: { date: "2026-12-06", opensAt: CLOSES },
    },
  },
  hosts: [],
};

// U+00A0 and U+202F.
const NO_BREAK = new RegExp(`[${String.fromCharCode(0xa0, 0x202f)}]`);

test("the Membership tab's joined words keep their space", async ({
  page, context, baseURL,
}) => {
  await context.addCookies([{
    name: "nff_signed_in", value: "1", url: baseURL,
  }]);
  await page.route("**/api/me", (route) => route.fulfill({
    json: { signedIn: true, customer: CUSTOMER, membership: true },
  }));
  await page.route("**/api/account/orders", (route) => route.fulfill({
    json: { orders: [] },
  }));
  await page.route("**/api/account/cart", (route) => route.fulfill({
    json: { ok: true, cart: null },
  }));
  await page.route("**/api/membership", (route) => route.fulfill({
    json: VIEW,
  }));
  await cannedDates(page);
  await page.goto("/account/#membership");

  const own = page.locator("#mem-groups [data-mem-group]").nth(0);

  await expect(own.locator("[data-mem='name']"))
    .toHaveText("The Village Family Fitness");

  // No no-break space anywhere in what the tab wrote, and the text a
  // reader copies has ordinary spaces.
  expect(await own.textContent()).not.toMatch(NO_BREAK);
  expect(await own.innerText()).toContain("Family Fitness");

  // Every gap between two words on one line is drawn wider than 1 px:
  // #593's no-break space measured 0 px in Chromium, an ordinary space
  // 3.8 px. (WebKit rounds a character's box out to whole pixels, so
  // a space there measures 2 or 3 px, never more than its true width.)
  // A pair the page keeps together is on one line, and the kept pairs
  // James saw closed up are among them.
  const gaps = (await Promise.all([
    own.locator("[data-mem='name']"),
    ...await own.locator(".account-membership-value").all(),
  ].map((row) => row.evaluate(wordGaps)))).flat();

  for (const g of gaps) {
    if (g.kept) expect(g.sameLine, `${g.words} on one line`).toBe(true);
    if (g.sameLine) {
      expect(g.width, `the space in ${g.words}`).toBeGreaterThan(1);
    }
  }

  const kept = gaps.filter((g) => g.kept).map((g) => g.words);

  for (const words of ["Family Fitness", "8:30 AM", "RI 02888",
    "to 9:00", "21, 11:59"]) {
    expect(kept.some((w) => w.includes(words)), words).toBe(true);
  }
});
