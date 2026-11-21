// Criteria tests for James's revision of #717 (Perks show as one
// pricing label with a tooltip; "Revision from James", 2026-11-21),
// one per box of its "Done when" that only the page shows, each named
// for its box. Held out of every run by its name until the change
// lands: renamed to perk-revision.spec.mjs, it runs. The wording box
// is test/perk-wording.criteria.mjs.
//
// A signed-in customer's perks come from /api/me, canned here as
// e2e/perk-label.spec.mjs cans them, so this runs on a local build as
// on staging and reaches `family`, which the back office leaves to
// James alone. The cart holds two eggs, well short of the free
// delivery the order total earns, so anything free delivery shows
// comes from the perk.
//
// The seam, what the tests rely on:
// - the cart's perk line is `[data-cart-perks]` in `#order-cart`, and
//   the account page's "Your pricing" row holds its lines in
//   `#prof-group` (as #728 built them);
// - a bundled perk's info button is a button in that line, and its
//   tooltip has role="tooltip" and lists each part as a list item;
// - the free delivery badge is `[data-badge="free-delivery"]`, lit
//   (highlighted) when its `data-on` is "true";
// - the badge's own info button is a button in the badge's list item,
//   other than the badge itself, with an accessible name, and its
//   tooltip has role="tooltip".
// The words are the issue's, pinned word for word.

import { CUSTOMER, cannedDates } from "./support/canned.mjs";
import { OrderPage, expect, settleCart, test } from "./support/order.mjs";

const FRIENDS = "Friends and family pricing";
const FAMILY = "Family pricing";
const NO_MINIMUM = "No delivery minimum";
const BADGE_TIP = "Your account receives free delivery on all orders.";

// Perks as /api/me sends them (lib/perks.mjs publicPerk).
const perk = (type, end = null) => ({ type, start: "2026-11-01", end });

let stamps = 0;

// Signed in as the canned customer, holding `perks`; as in
// e2e/perk-label.spec.mjs, each sign-in takes a new session stamp so
// the session's cache never answers with the last test's perks.
const signIn = async (page, baseURL, perks) => {
  await page.goto("about:blank");
  stamps += 1;
  await page.context().addCookies([
    { name: "nff_signed_in", value: `qr${stamps}`, url: baseURL },
  ]);
  await page.route("**/api/me", (route) => route.fulfill({
    json: { signedIn: true, customer: { ...CUSTOMER, perks } },
  }));
  // Unanswered, the cart request gets a 401 that clears the stamp.
  await page.route("**/api/account/cart", (route) => route.fulfill({
    json: { ok: true, cart: null },
  }));
  await page.route("**/api/account/orders", (route) => route.fulfill({
    json: { orders: [] },
  }));
};

// The order page, signed in with `perks`, its cart open and settled.
// -> { order, note, badge, beside }: the perk line, the free delivery
// badge, and the buttons in the badge's list item but the badge.
const openCart = async (page, baseURL, perks) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await signIn(page, baseURL, perks);
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem("nff-cart-first-add", "1");
    } catch {
      // Blocked storage: the first Add's lesson runs; nothing here
      // depends on it.
    }
  });

  const order = new OrderPage(page);

  await order.open({ eggs: 2 });
  await settleCart(order);

  const badge = page.locator("#order-cart [data-badge='free-delivery']");

  await expect(badge).toBeVisible();

  const beside = page.locator("#order-cart li")
    .filter({ has: badge })
    .locator("button:not([data-badge]), [role='button']:not([data-badge])");

  return {
    order, note: page.locator("#order-cart [data-cart-perks]"), badge,
    beside,
  };
};

// The account page's "Your pricing" row, signed in with `perks`.
const openPricing = async (page, baseURL, perks) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await signIn(page, baseURL, perks);
  await cannedDates(page);
  await page.goto("/account/#settings");

  const row = page.locator("#prof-group");

  await expect(row).toBeVisible();

  return row;
};

// Runs in the page: what `el` shows, as one line of words, its
// stylesheet's ::before and ::after included and its buttons and
// visually hidden text left out (e2e/perk-label.spec.mjs's `shown`).
// A hidden element shows nothing.
const shown = (el) => {
  const words = [];
  const pseudo = (node, which) => {
    const m = /^"(.*)"$/.exec(getComputedStyle(node, which).content || "");

    if (m && m[1].trim()) words.push(m[1]);
  };
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent.trim()) words.push(node.textContent.trim());

      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const style = getComputedStyle(node);

    if (node.hidden || style.display === "none"
      || style.visibility === "hidden") return;
    if (node.matches("button, [role='button'], .visually-hidden")) return;
    pseudo(node, "::before");
    for (const child of node.childNodes) walk(child);
    pseudo(node, "::after");
  };

  if (el.hidden || getComputedStyle(el).display === "none") return "";
  for (const child of el.childNodes) walk(child);

  return words.join(" ").replace(/\s+/g, " ").trim();
};

const shownText = (locator) => locator.evaluate(shown);

// A tap where the project has touch, a click where it has a mouse.
const tap = (locator, testInfo) => (testInfo.project.use.hasTouch
  ? locator.tap() : locator.click());

// The one open tooltip.
const openTip = (page) => page.locator("[role='tooltip']:visible");

// The parts a bundled perk's tooltip lists, once its button is tapped.
const bullets = async (page, place, testInfo) => {
  const info = place.getByRole("button");

  await expect(info, "one info button").toHaveCount(1);
  await tap(info, testInfo);
  await expect(openTip(page)).toHaveCount(1);

  const items = await openTip(page).getByRole("listitem").allInnerTexts();

  await page.keyboard.press("Escape");

  return items.map((t) => t.trim());
};

test.describe("perks, revised (#717, James, 2026-11-21)", () => {
  // Free delivery held twice, by the bundle and on its own, is the
  // case the perk line used to repeat.
  test("A friends and family or family customer's perk line does not " +
    "mention free delivery, while its tooltip still lists it and the " +
    "free delivery badge at the top stays highlighted", async ({
    page, baseURL,
  }, testInfo) => {
    for (const [type, label] of [["friends", FRIENDS], ["family", FAMILY]]) {
      for (const perks of [[perk(type)], [perk(type), perk("free-delivery")]]) {
        const name = perks.map((p) => p.type).join(" and ");
        const { note, badge } = await openCart(page, baseURL, perks);

        await expect(note, name).toBeVisible();

        const text = await shownText(note);

        expect(text, `${name}: the perk line`).not.toMatch(/free delivery/i);
        expect(text, `${name}: the perk line`).toContain(label);
        expect(await bullets(page, note, testInfo), `${name}: the tooltip`)
          .toContain("Free delivery");
        await expect(badge, `${name}: the badge is highlighted`)
          .toHaveAttribute("data-on", "true");
      }
    }
  });

  test("A customer awarded free delivery with no pricing info button " +
    "sees an info button beside the free delivery badge, whose tooltip " +
    "reads \"Your account receives free delivery on all orders.\"",
  async ({ page, baseURL }, testInfo) => {
    for (const perks of [
      [perk("free-delivery")],
      [perk("free-delivery"), perk("minimum-waived")],
    ]) {
      const name = perks.map((p) => p.type).join(" and ");
      const { note, beside } = await openCart(page, baseURL, perks);

      await expect(note.getByRole("button"), `${name}: no pricing button`)
        .toHaveCount(0);
      await expect(beside, `${name}: one info button by the badge`)
        .toHaveCount(1);
      await expect(beside).toBeVisible();
      await expect(beside, `${name}: its name`).toHaveAccessibleName(/\S/);
      await tap(beside, testInfo);
      await expect(openTip(page), `${name}: its tooltip`).toHaveCount(1);
      await expect(openTip(page)).toHaveText(BADGE_TIP);
    }

    // A pricing info button explains free delivery, and a customer
    // with no perk is not awarded it: neither has one by the badge.
    for (const perks of [[perk("friends")], [perk("family")], []]) {
      const name = perks.map((p) => p.type).join(" and ") || "no perk";
      const { beside } = await openCart(page, baseURL, perks);

      await expect(beside, `${name}: no info button by the badge`)
        .toHaveCount(0);
    }
  });

  // In the cart the free delivery badge shows free delivery; on the
  // account page no badge does, so the row keeps it.
  test("The perk line lists only what no badge or tooltip shows: " +
    "\"No delivery minimum\" appears there only when no tooltip covers " +
    "it", async ({ page, baseURL }) => {
    const cart = [
      { perks: [perk("friends"), perk("minimum-waived")], line: FRIENDS },
      { perks: [perk("family"), perk("minimum-waived")], line: FAMILY },
      { perks: [perk("minimum-waived")], line: NO_MINIMUM },
      { perks: [perk("free-delivery"), perk("minimum-waived")],
        line: NO_MINIMUM },
      { perks: [perk("free-delivery")], line: "" },
    ];

    for (const { perks, line } of cart) {
      const name = perks.map((p) => p.type).join(" and ");
      const { note } = await openCart(page, baseURL, perks);

      expect(await shownText(note), `the cart, ${name}`).toBe(line);
    }

    const account = [
      { perks: [perk("friends"), perk("minimum-waived")], line: FRIENDS },
      { perks: [perk("family"), perk("minimum-waived")], line: FAMILY },
      { perks: [perk("minimum-waived")], line: NO_MINIMUM },
    ];

    for (const { perks, line } of account) {
      const name = perks.map((p) => p.type).join(" and ");
      const row = await openPricing(page, baseURL, perks);

      expect(await shownText(row), `the account row, ${name}`).toBe(line);
    }
  });
});
