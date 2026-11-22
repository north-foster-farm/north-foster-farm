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

import groupData from "../data/groups.json" with { type: "json" };
import { CUSTOMER, cannedDates } from "./support/canned.mjs";
import { TODAY, moneyFor } from "./support/money-day.mjs";
import { OrderPage, expect, settleCart, test } from "./support/order.mjs";
import { clearSession } from "./support/staging.mjs";

const FRIENDS = "Friends and family pricing";
const FAMILY = "Family pricing";
const NO_MINIMUM = "No delivery minimum";
const BADGE_TIP = "Your account receives free delivery on all orders.";

// The delivery terms (#717, "Delivery terms for perk customers"), with
// the amounts the site states today from data/delivery.json.
const MONEY = moneyFor(TODAY);
const FEE = `$${MONEY.deliveryFee}`;
const MINIMUM = `$${MONEY.deliveryMinimum}`;
const USUALLY = `Usually ${FEE} fee, ${MINIMUM} minimum.`;
// What a perk does to the terms: the main text, then the tooltip's
// line after USUALLY.
const TERMS = {
  both: {
    text: "Free delivery, no minimum",
    tip: "Your account receives free delivery with no minimum.",
  },
  minimum: {
    text: `${FEE} delivery, no minimum`,
    tip: "Your account has no delivery minimum.",
  },
  fee: {
    text: `Free delivery, ${MINIMUM} minimum`,
    tip: "Your account receives free delivery.",
  },
};
// The friends and family perks lift the fee and the minimum both
// (lib/perks.mjs PERKS), so their terms are "both".
const TERM_CASES = [
  { perks: ["free-delivery"], terms: TERMS.fee },
  { perks: ["minimum-waived"], terms: TERMS.minimum },
  { perks: ["free-delivery", "minimum-waived"], terms: TERMS.both },
  { perks: ["friends"], terms: TERMS.both },
  { perks: ["family"], terms: TERMS.both },
];

// Where the site states the fee and the minimum, and what each says
// today: the home page's "Three ways to get your order" Delivery card
// (partials/home/ways.html) and the order page's Delivery choice
// (partials/order/fulfilment.html). The delivery policy states each
// amount alone, in its own sentence, and stays as it is.
const PLACES = [
  {
    name: "the home page's Delivery card",
    path: "/",
    today: `${MINIMUM} minimum, ${FEE} fee`,
    terms: (page) => page.locator(".ways li.place-way")
      .filter({ has: page.getByRole("heading", { name: "Delivery" }) })
      .locator("li.place-note"),
  },
  {
    name: "the order page's Delivery choice",
    path: "/order/",
    today: `${MINIMUM} minimum, ${FEE} delivery fee`,
    terms: (page) => page.locator(
      "label[for='method-delivery'] dt:text-is('Cost') + dd"
    ),
  },
];

// The Village Family Fitness group (data/groups.json) and its perk
// line (#717, "Village Family Fitness member", wording approved final).
const VFF = groupData.groups.find((g) => g.key === "vff");
const VFF_LINE = "Village Family Fitness member";
// Revised for #749 (James, 2026-11-21 14:38 ET): gym delivery left the
// release, so the tip names group orders only.
const VFF_TIP = "Member pricing through 2027 and access to group orders.";
// What /api/me adds for a member (netlify/functions/auth.mjs).
const MEMBER = {
  member: { key: VFF.key, name: VFF.name, credit: 0 }, membership: true,
};

// Perks as /api/me sends them (lib/perks.mjs publicPerk).
const perk = (type, end = null) => ({ type, start: "2026-11-01", end });

let stamps = 0;

// What signIn answers, by route. Unanswered, the cart request gets a
// 401 that clears the stamp.
const signInAnswers = (perks, extra) => ({
  "**/api/me": {
    signedIn: true, customer: { ...CUSTOMER, perks }, ...extra,
  },
  "**/api/account/cart": { ok: true, cart: null },
  "**/api/account/orders": { orders: [] },
});

// The routes signIn adds, so a later sign-in can drop them alone and
// keep the suite's own (hideToolbar's stub of /api/staging/**, the
// stock pins).
const SIGN_IN_ROUTES = Object.keys(signInAnswers([], {}));
// The route cannedDates (support/canned.mjs) adds.
const DATES_ROUTE = "**/api/dates";

// Drops the routes a helper here added before it adds them again:
// signIn's, and any of `more`.
const dropOwnRoutes = (page, more = []) => Promise.all(
  [...SIGN_IN_ROUTES, ...more].map((url) => page.unroute(url))
);

// Signed in as the canned customer, holding `perks`; as in
// e2e/perk-label.spec.mjs, each sign-in takes a new session stamp so
// the session's cache never answers with the last test's perks.
// `extra` adds to /api/me's answer (a member's `member`).
const signIn = async (page, baseURL, perks, extra = {}) => {
  await page.goto("about:blank");
  stamps += 1;
  await page.context().addCookies([
    { name: "nff_signed_in", value: `qr${stamps}`, url: baseURL },
  ]);
  await Promise.all(Object.entries(signInAnswers(perks, extra)).map(
    ([url, json]) => page.route(url, (route) => route.fulfill({ json }))
  ));
};

// The order page, signed in with `perks`, its cart open and settled.
// -> { order, note, badge, beside }: the perk line, the free delivery
// badge, and the buttons in the badge's list item but the badge.
const openCart = async (page, baseURL, perks, extra = {}) => {
  await dropOwnRoutes(page);
  await signIn(page, baseURL, perks, extra);
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

  // `has` looks inside each list item, so its locator names the badge
  // from there: one that starts at #order-cart, above the item, finds
  // nothing.
  const beside = page.locator("#order-cart li")
    .filter({ has: page.locator("[data-badge='free-delivery']") })
    .locator("button:not([data-badge]), [role='button']:not([data-badge])");

  return {
    order, note: page.locator("#order-cart [data-cart-perks]"), badge,
    beside,
  };
};

// The account page's "Your pricing" row, signed in with `perks`. A
// customer with nothing to show there may have no row in sight, so
// with no perk and no group it waits for the account alone.
const openPricing = async (page, baseURL, perks, extra = {}) => {
  await dropOwnRoutes(page, [DATES_ROUTE]);
  await signIn(page, baseURL, perks, extra);
  await cannedDates(page);
  await page.goto("/account/#settings");

  const row = page.locator("#prof-group");

  if (perks.length || extra.member) await expect(row).toBeVisible();
  else await expect(page.locator("#account-app")).toBeVisible();

  return row;
};

// `place` (one of PLACES) for a customer holding `perks`, or signed
// out for null. -> { terms }: the terms as the page states them.
// On the home page the "Three ways" band waits hidden through a
// market season (home.spec.mjs owns that swap); it is shown here so
// its Delivery card can be read in any season.
const openPlace = async (page, baseURL, place, perks) => {
  await dropOwnRoutes(page);
  await clearSession(page.context());
  if (perks) await signIn(page, baseURL, perks);
  else await page.goto("about:blank");
  if (perks) {
    // The page asks /api/me once it loads; wait for its answer.
    const me = page.waitForResponse((r) => r.url().includes("/api/me"));

    await page.goto(place.path);
    await me;
  } else {
    await page.goto(place.path);
  }
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-season-ways]")) {
      el.hidden = false;
    }
  });

  const terms = place.terms(page);

  await expect(terms, place.name).toBeVisible();

  return { terms };
};

// Runs in the page: how a fact's words are set, read from the element
// that holds its text.
const typeOf = (el) => {
  const text = [...el.querySelectorAll("*")].reverse()
    .find((n) => [...n.childNodes].some((c) => c.nodeType === Node.TEXT_NODE
      && c.textContent.trim())) || el;
  const s = getComputedStyle(text);

  return {
    color: s.color, fontFamily: s.fontFamily, fontSize: s.fontSize,
    fontWeight: s.fontWeight, fontStyle: s.fontStyle,
    lineHeight: s.lineHeight, textDecoration: s.textDecorationLine,
    textTransform: s.textTransform,
  };
};

const looks = (locator) => locator.evaluate(typeOf);

// Runs in the page: an info button's size and shape.
const shapeOf = (el) => {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);

  return {
    width: Math.round(r.width), height: Math.round(r.height),
    radius: s.borderRadius,
  };
};

const shape = (locator) => locator.evaluate(shapeOf);

// The perk line's info button's size and shape, as the account row
// draws it for `friends`.
const perkButton = async (page, baseURL) => {
  const row = await openPricing(page, baseURL, [perk("friends")]);
  const info = row.getByRole("button");

  await expect(info).toHaveCount(1);

  return shape(info);
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

  test("Where the site states the $5 fee and $40 minimum, a customer " +
    "with no perk sees exactly today's text and styling", async ({
    page, baseURL, browser,
  }, testInfo) => {
    // Today's styling is the page as built, before any script runs
    // (and so before any account is read), in this project's device.
    const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } =
      testInfo.project.use;
    const built = await browser.newContext({
      baseURL, viewport, deviceScaleFactor, isMobile, hasTouch, userAgent,
      javaScriptEnabled: false,
    });
    const today = {};

    for (const place of PLACES) {
      const plain = await built.newPage();

      await plain.goto(place.path);
      await plain.evaluate(() => {
        for (const el of document.querySelectorAll("[data-season-ways]")) {
          el.hidden = false;
        }
      });
      today[place.path] = await looks(place.terms(plain));
    }
    await built.close();

    // Signed out, and signed in holding no perk.
    for (const perks of [null, []]) {
      const who = perks ? "signed in, no perk" : "signed out";

      for (const place of PLACES) {
        const { terms } = await openPlace(page, baseURL, place, perks);

        await expect.poll(() => shownText(terms), `${place.name}, ${who}`)
          .toBe(place.today);
        await expect(terms.getByRole("button"),
          `${place.name}, ${who}: no info button`).toHaveCount(0);
        expect(await looks(terms), `${place.name}, ${who}: its styling`)
          .toEqual(today[place.path]);
      }
    }
  });

  test("A customer with free delivery, the minimum waived, or both sees " +
    "the terms that apply (\"Free delivery, no minimum\", \"$5 " +
    "delivery, no minimum\", \"Free delivery, $40 minimum\") with the " +
    "perk line's info button beside them", async ({ page, baseURL }) => {
    const model = await perkButton(page, baseURL);

    for (const { perks, terms: applies } of TERM_CASES) {
      const name = perks.join(" and ");

      for (const place of PLACES) {
        const { terms } = await openPlace(page, baseURL, place,
          perks.map((t) => perk(t)));
        const info = terms.getByRole("button");

        await expect.poll(() => shownText(terms), `${place.name}, ${name}`)
          .toBe(applies.text);
        await expect(info, `${place.name}, ${name}: one info button`)
          .toHaveCount(1);
        await expect(info).toBeVisible();
        await expect(info, `${place.name}, ${name}: its name`)
          .toHaveAccessibleName(/\S/);
        expect(await shape(info), `${place.name}, ${name}: the perk ` +
          "line's button, same size and shape").toEqual(model);
      }
    }
  });

  test("That info button's tooltip reads \"Usually $5 fee, $40 " +
    "minimum.\" and then the one line that applies, never the word " +
    "\"perks\"", async ({ page, baseURL }, testInfo) => {
    for (const { perks, terms: applies } of TERM_CASES) {
      const name = perks.join(" and ");

      for (const place of PLACES) {
        const { terms } = await openPlace(page, baseURL, place,
          perks.map((t) => perk(t)));
        const info = terms.getByRole("button");

        await expect(info, `${place.name}, ${name}`).toHaveCount(1);
        await tap(info, testInfo);
        await expect(openTip(page), `${place.name}, ${name}: its tooltip`)
          .toHaveCount(1);

        const text = (await openTip(page).innerText())
          .replace(/\s+/g, " ").trim();

        expect(text, `${place.name}, ${name}`)
          .toBe(`${USUALLY} ${applies.tip}`);
        expect(text, `${place.name}, ${name}: never "perks"`)
          .not.toMatch(/perks/i);
      }
    }
  });

  test("A Village Family Fitness member sees the perk line \"Village " +
    "Family Fitness member\" with the info button, whose tooltip reads " +
    "\"Member pricing through 2027 and access to group orders.\" in " +
    "the cart and on the account page; a non-member does not", async ({
    page, baseURL,
  }, testInfo) => {
    const places = [
      ["the cart", async (perks, extra) => (await openCart(page, baseURL,
        perks, extra)).note],
      ["the account row", (perks, extra) => openPricing(page, baseURL,
        perks, extra)],
    ];

    for (const [where, open] of places) {
      const line = await open([], MEMBER);
      const info = line.getByRole("button");

      await expect(line, `${where}: a member`).toBeVisible();
      await expect.poll(() => shownText(line),
        `${where}: a member's perk line`).toBe(VFF_LINE);
      await expect(info, `${where}: one info button`).toHaveCount(1);
      await expect(info, `${where}: its name`).toHaveAccessibleName(/\S/);
      await tap(info, testInfo);
      await expect(openTip(page), `${where}: its tooltip`).toHaveCount(1);
      await expect(openTip(page)).toHaveText(VFF_TIP);

      // A non-member, with no perk and with one.
      for (const perks of [[], [perk("friends")]]) {
        const other = await open(perks, {});

        expect(await shownText(other), `${where}: a non-member, ` +
          `${perks.map((p) => p.type).join(" ") || "no perk"}`)
          .not.toContain("Village Family Fitness");
      }
    }
  });
});
