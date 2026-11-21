// Criteria tests for #717 (Perks show as one pricing label with a
// tooltip), one per box of its "Done when" marked (test), each named
// for its box. Held out of every run by its name until the change
// lands: renamed to perk-label.spec.mjs, it runs.
//
// A signed-in customer's perks come from /api/me, canned here as
// payment.spec and missed-delivery.spec can them, so this runs on a
// local build as on staging and needs no back office. That also
// reaches `family`, which the back office leaves to James alone.
//
// What the tests rely on:
// - the cart note is `[data-cart-perks]` in `#order-cart`, and the
//   account page's "Your pricing" row holds its lines in `#prof-group`;
// - a bundled perk's info button is a button inside that note or row,
//   apart from the label's own text;
// - its tooltip has role="tooltip" and lists each part as a list item;
// - the badges' separator is the "·" of `.order-cart-badges li + li`.
// The words are the issue's, pinned word for word; the family wording
// is approved (James, 2026-11-21).

import { CUSTOMER, cannedDates } from "./support/canned.mjs";
import { OrderPage, expect, settleCart, test } from "./support/order.mjs";

const FRIENDS = "Friends and family pricing";
const FRIENDS_PARTS = [
  "Friends and family discount", "Free delivery", "No order minimum",
];
const FAMILY = "Family pricing";
const FAMILY_PARTS = ["Family discount", "Free delivery", "No order minimum"];
const BOTH = "Free delivery · No order minimum";

// Perks as /api/me sends them (lib/perks.mjs publicPerk).
const perk = (type, end = null) => ({ type, start: "2026-11-01", end });

let stamps = 0;

// Signed in as the canned customer, holding `perks`. Without the
// session stamp the order page never applies /api/me's answer. Each
// sign-in takes a new stamp, so a test that signs in again with other
// perks never reads the last answer from the session's cache
// (session/cache.js).
//
// The last page goes first: its requests end there, so a cart push it
// sent while the routes were away cannot come back a 401 that clears
// the new stamp, and the account page loads again rather than only
// changing its hash.
const signIn = async (page, baseURL, perks) => {
  await page.goto("about:blank");
  stamps += 1;
  await page.context().addCookies([
    { name: "nff_signed_in", value: `qa${stamps}`, url: baseURL },
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
const openCart = async (page, baseURL, perks) => {
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

  const note = page.locator("#order-cart [data-cart-perks]");

  await expect(note).toBeVisible();

  return { order, note };
};

// The account page's "Your pricing" row, signed in with `perks`.
const openPricing = async (page, baseURL, perks) => {
  await signIn(page, baseURL, perks);
  await cannedDates(page);
  await page.goto("/account/#settings");

  const row = page.locator("#prof-group");

  await expect(row).toBeVisible();

  return row;
};

// Runs in the page: what `el` shows, as one line of words. It reads
// the text of every shown element with its ::before and ::after, so
// a separator drawn by the stylesheet counts as one typed in. Buttons
// and visually hidden text are left out: the label is what is read
// here, and its info button is checked on its own. Each separator
// "·" found comes back with its color.
const shown = (el) => {
  const words = [];
  const dots = [];
  const pseudo = (node, which) => {
    const style = getComputedStyle(node, which);
    const m = /^"(.*)"$/.exec(style.content || "");

    if (!m || !m[1].trim()) return;
    words.push(m[1]);
    if (m[1].trim() === "·") dots.push(style.color);
  };
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.trim();

      if (!text) return;
      words.push(text);
      if (text.includes("·")) {
        dots.push(getComputedStyle(node.parentElement).color);
      }

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

  for (const child of el.childNodes) walk(child);

  return { text: words.join(" ").replace(/\s+/g, " ").trim(), dots };
};

const shownText = async (locator) => (await locator.evaluate(shown)).text;

// The color of the discount badges' own separator.
const badgeDot = (page) => page.locator(
  "#order-cart .order-cart-badges li + li"
).first().evaluate((li) => getComputedStyle(li, "::before").color);

// A tap where the project has touch, a click where it has a mouse.
const tap = (locator, testInfo) => (testInfo.project.use.hasTouch
  ? locator.tap() : locator.click());

// The one open tooltip.
const openTip = (page) => page.locator("[role='tooltip']:visible");

// The parts an info button's tooltip lists, once it is open.
const parts = async (page) => {
  const tip = openTip(page);

  await expect(tip).toHaveCount(1);

  return tip.getByRole("listitem").allInnerTexts()
    .then((items) => items.map((t) => t.trim()));
};

// A bundled perk in `place`: its label, its info button and the
// bullets the button opens.
const expectBundle = async (page, place, label, bullets, testInfo) => {
  expect(await shownText(place), "the line, its button aside")
    .toBe(label);

  const info = place.getByRole("button");

  await expect(info, "one info button").toHaveCount(1);
  await expect(info).toBeVisible();
  await tap(info, testInfo);
  expect(await parts(page), "the tooltip's bullets").toEqual(bullets);
};

test.describe("perks as one pricing label (#717)", () => {
  test("A customer with `friends` sees \"Friends and family pricing\" " +
    "with an info button in the cart note, and its tooltip lists " +
    "\"Friends and family discount\", \"Free delivery\" and \"No order " +
    "minimum\" as bullets", async ({ page, baseURL }, testInfo) => {
    const { note } = await openCart(page, baseURL, [perk("friends")]);

    await expectBundle(page, note, FRIENDS, FRIENDS_PARTS, testInfo);
  });

  test("A customer with `family` sees \"Family pricing\" with an info " +
    "button and its bullets, as approved", async ({ page, baseURL },
    testInfo) => {
    const { note } = await openCart(page, baseURL, [perk("family")]);

    await expectBundle(page, note, FAMILY, FAMILY_PARTS, testInfo);
  });

  test("A customer with `free-delivery` and `minimum-waived` sees " +
    "\"Free delivery · No order minimum\" with the badges' separator; " +
    "with one of them, that one alone", async ({ page, baseURL }) => {
    const { note } = await openCart(page, baseURL, [
      perk("free-delivery"), perk("minimum-waived"),
    ]);
    const both = await note.evaluate(shown);

    expect(both.text, "both perks").toBe(BOTH);
    expect(both.dots, "one separator, the badges' own")
      .toEqual([await badgeDot(page)]);
    await expect(note.getByRole("button"), "no info button")
      .toHaveCount(0);

    for (const [type, alone] of [
      ["free-delivery", "Free delivery"],
      ["minimum-waived", "No order minimum"],
    ]) {
      await page.unrouteAll({ behavior: "ignoreErrors" });

      const one = (await openCart(page, baseURL, [perk(type)])).note;
      const got = await one.evaluate(shown);

      expect(got.text, `${type} alone`).toBe(alone);
      expect(got.dots, `${type} alone: no separator`).toEqual([]);
    }
  });

  // The cart shows no end dates and the account page keeps each beside
  // its label (James, on #717, 2026-11-21): without an end date the two
  // read the same; with one, the row adds it after the cart's words.
  test("The account page's \"Your pricing\" row shows the same as the " +
    "cart", async ({ page, baseURL }, testInfo) => {
    const cases = [
      { perks: [perk("friends")], label: FRIENDS, bullets: FRIENDS_PARTS },
      { perks: [perk("family")], label: FAMILY, bullets: FAMILY_PARTS },
      { perks: [perk("free-delivery"), perk("minimum-waived")],
        label: BOTH },
      { perks: [perk("free-delivery")], label: "Free delivery" },
      { perks: [perk("minimum-waived")], label: "No order minimum" },
    ];

    for (const { perks, label, bullets } of cases) {
      await page.unrouteAll({ behavior: "ignoreErrors" });

      const row = await openPricing(page, baseURL, perks);
      const name = perks.map((p) => p.type).join(" and ");

      if (bullets) {
        await expectBundle(page, row, label, bullets, testInfo);
      } else {
        const got = await row.evaluate(shown);

        expect(got.text, name).toBe(label);
        await expect(row.getByRole("button"), `${name}: no info button`)
          .toHaveCount(0);
        if (perks.length > 1) {
          expect(got.dots, `${name}: one separator`).toHaveLength(1);
        }
      }
    }

    // With an end date: the cart has the label alone, the row the
    // label with its date beside it.
    const dated = [perk("friends", "2027-12-31")];

    await page.unrouteAll({ behavior: "ignoreErrors" });

    const { note } = await openCart(page, baseURL, dated);

    expect(await shownText(note), "the cart: no date").toBe(FRIENDS);
    await page.unrouteAll({ behavior: "ignoreErrors" });

    const row = await openPricing(page, baseURL, dated);
    const text = await shownText(row);

    expect(text.startsWith(FRIENDS), `the row: ${text}`).toBe(true);
    expect(text, "the row keeps the end date").toMatch(/\b2027\b/);
    await expect(row.getByRole("button")).toHaveCount(1);
  });

  // Like the discount badges' tooltips (#569, #644): any scroll of the
  // cart's body shuts it at once, before the page can move it.
  test("The tooltip opens on tap, hover and keyboard focus, has an " +
    "accessible name, and closes on scroll like the discount badges' " +
    "tooltips", async ({ page, baseURL }, testInfo) => {
    const { note } = await openCart(page, baseURL, [perk("friends")]);
    const info = note.getByRole("button");
    const tip = openTip(page);

    await expect(info).toHaveCount(1);
    await expect(info, "the info button's name").toHaveAccessibleName(/\S/);

    // Scrolls the cart's body; -> whether a tooltip was still shown
    // straight after, in the same task.
    const scrollShuts = () => page.evaluate(() => {
      document.querySelector("#order-cart [data-cart-body]")
        .dispatchEvent(new Event("scroll"));

      return [...document.querySelectorAll("[role='tooltip']")]
        .every((el) => !el.checkVisibility());
    });

    const ways = [
      ["tap", () => tap(info, testInfo)],
      ["hover", () => info.hover()],
      ["keyboard focus", async () => {
        await info.evaluate((el) => el.blur());
        await info.focus();
      }],
    ];

    for (const [way, open] of ways) {
      await expect(tip, `shut before the ${way}`).toHaveCount(0);
      await open();
      await expect(tip, `open on ${way}`).toHaveCount(1);
      await expect(tip, `the tooltip's name, on ${way}`)
        .toHaveAccessibleName(/\S/);
      expect(await parts(page), `its bullets, on ${way}`)
        .toEqual(FRIENDS_PARTS);
      expect(await scrollShuts(), `a scroll shuts it at once (${way})`)
        .toBe(true);
      await expect(tip, `shut after the scroll (${way})`).toHaveCount(0);
      // Off the button, and the focus elsewhere, for the next way.
      await page.mouse.move(0, 0);
      await info.evaluate((el) => el.blur());
    }
  });
});
