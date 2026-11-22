// Criteria test for #717 (Perks show as one pricing label with a
// tooltip), its "Tooltip text" box (James, 2026-11-21, on the member
// tooltip: "this text should be center aligned"), named for it. Held
// out of every run by its name until the change lands: renamed to
// tooltip-center.spec.mjs, it runs, in the desktop and phone projects.
//
// A signed-in customer's perks come from /api/me, canned as
// e2e/perk-revision.spec.mjs and e2e/info-align.spec.mjs can them, so
// this runs on a local build as on staging. Each tooltip is opened at
// 390 and at 1440 px wide.
//
// The seam, what the test relies on:
// - the cart's perk line is `[data-cart-perks]` in `#order-cart`, and
//   its info button is a button in it (as #728 built it): a Village
//   Family Fitness member's for the member line, a friends and family
//   customer's for a bundle;
// - the free delivery badge is `[data-badge="free-delivery"]`, and its
//   info button is a button in the badge's list item other than the
//   badge itself;
// - the delivery terms are the home page's Delivery card note
//   (`.ways li.place-way li.place-note`) and the order page's Delivery
//   choice's Cost (`label[for='method-delivery'] dt:text-is('Cost') +
//   dd`), each holding its info button;
// - an open tooltip has role="tooltip" and holds its text in
//   Bootstrap's `.tooltip-inner`; a bundle's parts are list items.
// "Centered, each line on its own" is measured as the box: every line
// of text a Range's client rects give, its center within 1 px of the
// center of `.tooltip-inner`'s content box. "Aligned to the start" is
// every bullet's text starting within 1 px of the list's content-box
// start edge, with the list's text-align at start.

import groupData from "../data/groups.json" with { type: "json" };
import { CUSTOMER } from "./support/canned.mjs";
import { OrderPage, expect, settleCart, test } from "./support/order.mjs";

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

let stamps = 0;

// Signed in as the canned customer, holding `perks`, each sign-in on a
// new session stamp so the session's cache never answers with the last
// one's perks. `extra` adds to /api/me's answer.
const signIn = async (page, baseURL, perks, extra = {}) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.context().clearCookies();
  await page.goto("about:blank");
  stamps += 1;
  await page.context().addCookies([
    { name: "nff_signed_in", value: `tc${stamps}`, url: baseURL },
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

const perkLine = (page) => page.locator("#order-cart [data-cart-perks]")
  .getByRole("button");

// Each tooltip, the customer that shows it, how to open its page, its
// button, and whether it lists a bundle's parts.
const TIPS = [
  {
    name: "the member line's tooltip",
    perks: [], extra: MEMBER, open: openCart, button: perkLine,
  },
  {
    name: "the free delivery badge's tooltip",
    perks: [perk("free-delivery")], open: openCart,
    button: (page) => page.locator("#order-cart li")
      .filter({ has: page.locator("[data-badge='free-delivery']") })
      .locator("button:not([data-badge]), [role='button']:not([data-badge])"),
  },
  {
    name: "the home page's delivery terms' tooltip",
    perks: [perk("free-delivery")], open: (page) => openPage(page, "/"),
    button: (page) => page.locator(".ways li.place-way")
      .filter({ has: page.getByRole("heading", { name: "Delivery" }) })
      .locator("li.place-note").getByRole("button"),
  },
  {
    name: "the order page's delivery terms' tooltip",
    perks: [perk("free-delivery")],
    open: (page) => openPage(page, "/order/"),
    button: (page) => page.locator(
      "label[for='method-delivery'] dt:text-is('Cost') + dd"
    ).getByRole("button"),
  },
  {
    name: "a bundle's tooltip",
    perks: [perk("friends")], open: openCart, button: perkLine,
    bullets: true,
  },
];

// A tap where the project has touch, a click where it has a mouse.
const tap = (locator, testInfo) => (testInfo.project.use.hasTouch
  ? locator.tap() : locator.click());

// Runs in the page, on the open tooltip: each line of its text and
// where it sits. -> { center, lines: [{ text, mid, left }],
// list: { align, start } | null } or { error }.
const linesOf = (tip) => {
  const inner = tip.querySelector(".tooltip-inner") || tip;
  const s = getComputedStyle(inner);
  const box = inner.getBoundingClientRect();
  const left = box.left + parseFloat(s.borderLeftWidth)
    + parseFloat(s.paddingLeft);
  const right = box.right - parseFloat(s.borderRightWidth)
    - parseFloat(s.paddingRight);
  const lines = [];
  const walk = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);

  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.textContent.trim()) continue;

    const range = document.createRange();

    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width > 0 && r.height > 0) {
        lines.push({
          text: n.textContent.trim().slice(0, 40),
          mid: r.left + r.width / 2, left: r.left,
        });
      }
    }
  }
  if (!lines.length) return { error: "no text in the tooltip" };

  const ul = inner.querySelector("ul");
  let list = null;

  if (ul) {
    const u = getComputedStyle(ul);
    const ur = ul.getBoundingClientRect();

    list = {
      align: u.textAlign,
      start: ur.left + parseFloat(u.borderLeftWidth)
        + parseFloat(u.paddingLeft),
    };
  }

  return { center: (left + right) / 2, lines, list };
};

test.describe("tooltip text centered (#717)", () => {
  test("Every perk and info tooltip's text is centered, each line on " +
    "its own (the member line, the delivery terms, the free delivery " +
    "badge's lines), while a bundle's bulleted parts stay aligned to " +
    "the start", async ({ page, baseURL }, testInfo) => {
    const off = [];

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT });
      for (const tip of TIPS) {
        const where = `${tip.name}, ${width} px`;

        await signIn(page, baseURL, tip.perks, tip.extra);
        await tip.open(page);

        const button = tip.button(page);

        await expect(button, `${where}: one info button`).toHaveCount(1);
        await expect(button, where).toBeVisible();
        const open = page.locator("[role='tooltip'].show");

        // The page may redraw the terms, and their button, just after
        // it answers; a tap on the old button opens nothing, so tap
        // again until a tooltip is open.
        await expect(async () => {
          await tap(button, testInfo);
          await expect(open).toHaveCount(1, { timeout: 2000 });
        }, `${where}: its tooltip`).toPass({ timeout: 15000 });

        const got = await open.evaluate(linesOf);

        expect(got.error, where).toBeUndefined();
        if (tip.bullets) {
          expect(got.list, `${where}: a bulleted list`).not.toBeNull();
          expect(["start", "left"], `${where}: the list's text-align`)
            .toContain(got.list.align);
          for (const line of got.lines) {
            const gap = line.left - got.list.start;

            if (Math.abs(gap) > TOLERANCE) {
              off.push(`${where}: "${line.text}" starts ` +
                `${gap.toFixed(2)} px from the list's start edge`);
            }
          }
        } else {
          for (const line of got.lines) {
            const gap = line.mid - got.center;

            if (Math.abs(gap) > TOLERANCE) {
              off.push(`${where}: "${line.text}" ` +
                `${Math.abs(gap).toFixed(2)} px ` +
                `${gap > 0 ? "right" : "left"} of center`);
            }
          }
        }
        await page.keyboard.press("Escape");
      }
    }

    expect(off, "tooltip lines out of place").toEqual([]);
  });
});
