// Criteria test for #717 (Perks show as one pricing label with a
// tooltip), section "Info icons on the text's center line" (James, in
// chat, 2026-11-21 16:16 ET), its one (test) box, named for it. Held
// out of every run by its name until the change lands: renamed to
// info-align.spec.mjs, it runs, in the desktop and phone projects.
//
// A signed-in customer's perks come from /api/me, canned as
// e2e/perk-revision.spec.mjs cans them, so this runs on a local build
// as on staging. Each place is opened at 390 and at 1440 px wide.
//
// The seam, what the test relies on:
// - the cart's perk line is `[data-cart-perks]` in `#order-cart`, the
//   account page's "Your pricing" row is `#prof-group`, and a perk
//   line's info button is a button in it (as #728 built them);
// - the free delivery badge is `[data-badge="free-delivery"]`, and its
//   info button is a button in the badge's list item other than the
//   badge itself;
// - the delivery terms are the home page's Delivery card note
//   (`.ways li.place-way li.place-note`) and the order page's Delivery
//   choice's Cost (`label[for='method-delivery'] dt:text-is('Cost') +
//   dd`), each holding its info button;
// - the line of text beside a button is the text of the nearest
//   element around it that shows any text of its own, the button's,
//   tooltips' and visually hidden text left out.
// "Vertically centered" is measured as the box: the button's border
// box's center against the center of a Range's client rect for the
// last line of that text the button shares, within 1 px.

import groupData from "../data/groups.json" with { type: "json" };
import { CUSTOMER, cannedDates } from "./support/canned.mjs";
import { OrderPage, expect, settleCart, test } from "./support/order.mjs";
import { clearSession } from "./support/staging.mjs";

const WIDTHS = [390, 1440];
const HEIGHT = 900;
const TOLERANCE = 1;

const VFF = groupData.groups.find((g) => g.key === "vff");
// What /api/me adds for a member (netlify/functions/auth.mjs).
const MEMBER = {
  member: { key: VFF.key, name: VFF.name, credit: 0 }, membership: true,
};

// Perks as /api/me sends them (lib/perks.mjs publicPerk).
const perk = (type) => ({ type, start: "2026-11-01", end: null });

// The customers that show each button.
const WHO = {
  friends: { name: "friends and family", perks: [perk("friends")] },
  member: { name: "a Village Family Fitness member", perks: [],
    extra: MEMBER },
  free: { name: "free delivery only", perks: [perk("free-delivery")] },
};

let stamps = 0;

// Signed in as the canned customer, holding `perks`, each sign-in on a
// new session stamp so the session's cache never answers with the last
// one's perks. `extra` adds to /api/me's answer.
const signIn = async (page, baseURL, perks, extra = {}) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await clearSession(page.context());
  await page.goto("about:blank");
  stamps += 1;
  await page.context().addCookies([
    { name: "nff_signed_in", value: `ia${stamps}`, url: baseURL },
  ]);
  await page.route("**/api/me", (route) => route.fulfill({
    json: { signedIn: true, customer: { ...CUSTOMER, perks }, ...extra },
  }));
  // Unanswered, the cart request gets a 401 that clears the stamp.
  await page.route("**/api/account/cart", (route) => route.fulfill({
    json: { ok: true, cart: null },
  }));
  await page.route("**/api/account/orders", (route) => route.fulfill({
    json: { orders: [] },
  }));
};

// The order page with two eggs in the cart, open and settled.
const openCart = async (page) => {
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
};

// A page, its /api/me answered, the home page's "Three ways" band
// shown in any season (home.spec.mjs owns that swap).
const openPage = async (page, path) => {
  const me = page.waitForResponse((r) => r.url().includes("/api/me"));

  await page.goto(path);
  await me;
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-season-ways]")) {
      el.hidden = false;
    }
  });
};

// Each place an info button appears, the customers that show it, how
// to open it and the button there.
const PLACES = [
  {
    name: "the cart's perk line",
    who: [WHO.friends, WHO.member],
    open: openCart,
    button: (page) => page.locator("#order-cart [data-cart-perks]")
      .getByRole("button"),
  },
  {
    name: "the free delivery badge",
    who: [WHO.free],
    open: openCart,
    button: (page) => page.locator("#order-cart li")
      .filter({ has: page.locator("[data-badge='free-delivery']") })
      .locator("button:not([data-badge]), [role='button']:not([data-badge])"),
  },
  {
    name: "the home page's delivery terms",
    who: [WHO.free, WHO.friends],
    open: (page) => openPage(page, "/"),
    button: (page) => page.locator(".ways li.place-way")
      .filter({ has: page.getByRole("heading", { name: "Delivery" }) })
      .locator("li.place-note").getByRole("button"),
  },
  {
    name: "the order page's delivery terms",
    who: [WHO.free, WHO.friends],
    open: (page) => openPage(page, "/order/"),
    button: (page) => page.locator(
      "label[for='method-delivery'] dt:text-is('Cost') + dd"
    ).getByRole("button"),
  },
  {
    name: "the account row",
    who: [WHO.friends, WHO.member],
    open: async (page) => {
      await cannedDates(page);
      await page.goto("/account/#settings");
      await expect(page.locator("#prof-group")).toBeVisible();
    },
    button: (page) => page.locator("#prof-group").getByRole("button"),
  },
];

// Runs in the page: how far the button's center sits from the center
// line of the text beside it, in px, positive when the button is
// above. -> { offset, line } or { error }.
const offsetOf = (button) => {
  const skip = (node) => {
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (el === button || button.contains(el)) return true;
      if (el.matches("[role='tooltip'], .tooltip, .visually-hidden")) {
        return true;
      }
    }

    return false;
  };
  const rects = (root) => {
    const out = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent.trim() || skip(n)) continue;

      const range = document.createRange();

      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width > 0 && r.height > 0) out.push(r);
      }
    }

    return out;
  };

  let found = [];

  for (let el = button.parentElement; el && !found.length;
    el = el.parentElement) {
    found = rects(el);
  }
  if (!found.length) return { error: "no text beside the button" };

  const b = button.getBoundingClientRect();
  const mid = b.top + b.height / 2;
  const shared = found.filter((r) => r.bottom > b.top && r.top < b.bottom);
  // The last line the button shares; failing that, the nearest line.
  const pool = shared.length ? shared : found;
  const near = (r) => Math.min(Math.abs(r.right - b.left),
    Math.abs(b.right - r.left));
  const line = shared.length
    ? pool.reduce((a, r) => (near(r) < near(a) ? r : a))
    : pool.reduce((a, r) => (Math.abs(r.top + r.height / 2 - mid)
      < Math.abs(a.top + a.height / 2 - mid) ? r : a));

  return {
    offset: line.top + line.height / 2 - mid,
    line: { top: line.top, height: line.height },
  };
};

test.describe("info buttons on the text's center line (#717)", () => {
  test("Every info button sits vertically centered on the line of text " +
    "beside it, wherever it appears (cart perk line, free delivery " +
    "badge, delivery terms on the home and order pages, account row), " +
    "at 390 and 1440 px", async ({ page, baseURL }) => {
    const off = [];

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT });
      for (const place of PLACES) {
        for (const who of place.who) {
          const where = `${place.name}, ${who.name}, ${width} px`;

          await signIn(page, baseURL, who.perks, who.extra);
          await place.open(page);

          const button = place.button(page);

          await expect(button, `${where}: one info button`).toHaveCount(1);
          await expect(button, where).toBeVisible();

          const got = await button.evaluate(offsetOf);

          expect(got.error, where).toBeUndefined();
          if (Math.abs(got.offset) > TOLERANCE) {
            const px = Math.abs(got.offset).toFixed(2);

            off.push(`${where}: ${px} px ` +
              `${got.offset > 0 ? "above" : "below"} the center line`);
          }
        }
      }
    }

    expect(off, "info buttons off the text's center line").toEqual([]);
  });
});
