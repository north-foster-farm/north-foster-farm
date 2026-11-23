// Criteria tests for #915 (Header: label the account icon "Account"),
// the three (test) boxes of its "Done when" list, one test each, named
// for its box. Each is about the page as it draws once /api/me has
// answered, so none is a unit test. Held out of every run by its name
// until the change lands: renamed to header-account-label.spec.mjs, it
// runs in the desktop project at the widths each box names and in the
// phone project at its own (390 px).
//
// PROVISIONAL, until James settles the widths #915 leaves open: the
// word shows from 768 px up, and below that the icon stands alone
// (box 1), with its accessible name unchanged.
//
// The seam, what the tests rely on:
// - /api/me is answered with a canned body (signed in: the session
//   cookie nff_signed_in and CUSTOMER from support/canned.mjs), as
//   e2e/header-account.spec.mjs does, so this runs on a local build as
//   on staging.
// - The account control is the visible button in the banner named
//   "Account" when signed in, the visible link named "Sign in" when
//   signed out. Its icon is the SVG inside it that is rendered (the
//   customer's chicken or the account glyph).
// - Box 3 compares the header signed in with the same header signed
//   out, in the brand's row, the account control named "(account)" in
//   both: the same controls in the same order, none overlapping, the
//   controls outside the main navigation where they were, and the
//   space between each pair of neighbors in one group (the main
//   navigation landmark, or the rest of the row) what it was. Space is
//   measured by ink, as #327 did: a control's own border box when it
//   shows a border or a background, else the union of the text, SVGs
//   and painted parts inside it.

import { CUSTOMER } from "./support/canned.mjs";
import { expect, test } from "./support/order.mjs";

const WIDE = 1280;
const SETTLE_MS = 700;
// Ink gaps that differ by no more than this are equal.
const SAME_PX = 2;
// From this width the word shows (provisional).
const LABEL_FROM = 768;

const widthsFor = (project, widths) => (project === "desktop"
  ? widths : [null]);
const label = (w) => (w ? `${w} px` : "the phone's width");

const atWidth = async (page, width) => {
  if (width) {
    await page.setViewportSize({ width, height: width >= 992 ? 900 : 664 });
  }
};

const signIn = async (page, context, baseURL) => {
  await context.addCookies([{
    name: "nff_signed_in", value: "qa", url: baseURL,
  }]);
  await page.route("**/api/me", (route) => route.fulfill({
    json: { signedIn: true, customer: CUSTOMER },
  }));
};

const signOut = (page) => page.route("**/api/me", (route) => route.fulfill({
  json: { signedIn: false },
}));

const account = (page) => page.getByRole("banner")
  .getByRole("button", { name: "Account", exact: true });
const signin = (page) => page.getByRole("banner")
  .getByRole("link", { name: "Sign in", exact: true });

// The control's rendered text, and whether it shows an icon, and how
// the text sits beside the icon.
const looks = (control) => control.evaluate((el) => {
  const shown = (n) => {
    for (let e = n; e && e !== el.parentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);

      if (cs.display === "none" || cs.visibility === "hidden"
        || Number(cs.opacity) < 0.5) return false;
    }

    return true;
  };
  const clipped = (n) => {
    for (let e = n; e && e !== el.parentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const box = e.getBoundingClientRect();

      if (box.width <= 1 || box.height <= 1
        || cs.clipPath === "inset(50%)" || /rect\(0/.test(cs.clip)) {
        return true;
      }
    }

    return false;
  };
  const words = [];
  const walk = (n) => {
    if (n.nodeType === 3 && n.textContent.trim()) {
      if (shown(n.parentElement) && !clipped(n.parentElement)) {
        const range = document.createRange();

        range.selectNodeContents(n);
        words.push({ text: n.textContent.trim(),
          box: range.getBoundingClientRect().toJSON() });
      }
    } else if (n.nodeType === 1) {
      n.childNodes.forEach(walk);
    }
  };

  el.childNodes.forEach(walk);

  const icon = [...el.querySelectorAll("svg")].find((svg) => {
    const box = svg.getBoundingClientRect();

    return box.width > 0 && box.height > 0 && shown(svg);
  });

  return {
    text: words.map((w) => w.text).join(" "),
    word: words[0]?.box || null,
    icon: icon ? icon.getBoundingClientRect().toJSON() : null,
  };
});

// The header's controls in the brand's row, by ink, left to right,
// with the gaps between neighbors in one group.
const row = (page) => page.evaluate(() => {
  const banner = document.querySelector("header, [role='banner']");
  const main = banner.querySelector("nav[aria-label='Main']");
  const brand = banner.querySelector("a[aria-label$=', home']");
  const line = brand.getBoundingClientRect();
  const clear = (c) => c === "transparent" || /rgba\(.*,\s*0\)/.test(c);
  const painted = (cs) => (parseFloat(cs.borderLeftWidth) > 0
    && !clear(cs.borderLeftColor)) || !clear(cs.backgroundColor);
  const visible = (el) => {
    const box = el.getBoundingClientRect();

    return box.width > 1 && box.height > 1
      && getComputedStyle(el).visibility !== "hidden";
  };
  const ink = (el) => {
    if (painted(getComputedStyle(el))) return el.getBoundingClientRect();

    const boxes = [];
    const walk = (n) => {
      if (n.nodeType === 3 && n.textContent.trim()) {
        const range = document.createRange();

        range.selectNodeContents(n);
        boxes.push(...[...range.getClientRects()]
          .filter((r) => r.width > 1));
      } else if (n.nodeType === 1 && visible(n)) {
        const cs = getComputedStyle(n);

        if (Number(cs.opacity) < 0.5) return;
        if (n.localName === "svg" || painted(cs)) {
          boxes.push(n.getBoundingClientRect());

          return;
        }
        n.childNodes.forEach(walk);
      }
    };

    el.childNodes.forEach(walk);
    if (!boxes.length) return null;

    return {
      left: Math.min(...boxes.map((b) => b.left)),
      right: Math.max(...boxes.map((b) => b.right)),
    };
  };
  const controls = [...banner.querySelectorAll("a, button")]
    .filter((el) => el !== brand && visible(el)
      && !el.closest("[role='search'], search, .offcanvas:not(.show), "
        + ".dropdown-menu")
      && (() => {
        const b = el.getBoundingClientRect();
        const mid = b.top + b.height / 2;

        return mid >= line.top && mid <= line.bottom;
      })())
    .map((el) => {
      const name = el.getAttribute("aria-label")
        || el.textContent.trim().replace(/\s+/g, " ");

      return {
        name: /^(Account|Sign in)\b/.test(name) ? "(account)" : name,
        group: main && main.contains(el) ? "nav" : "actions",
        box: el.getBoundingClientRect().toJSON(),
        ink: ink(el),
      };
    })
    .filter((c) => c.ink)
    .sort((a, b) => a.ink.left - b.ink.left);
  const gaps = [];

  for (let i = 1; i < controls.length; i += 1) {
    const [a, b] = [controls[i - 1], controls[i]];

    if (a.group === b.group) {
      gaps.push({ between: [a.name, b.name], px: b.ink.left - a.ink.right });
    }
  }

  return { controls, gaps };
});

test.describe("#915 the header's account label", () => {
  test("The header's account control shows the word \"Account\" beside "
    + "its icon", async ({ page, context, baseURL }, info) => {
    await signIn(page, context, baseURL);

    for (const width of widthsFor(info.project.name,
      [390, LABEL_FROM, 992, WIDE])) {
      const at = label(width);

      await atWidth(page, width);
      await page.goto("/about/");

      const control = account(page);

      await expect(control, `${at}: the account control`).toBeVisible();
      await page.waitForTimeout(SETTLE_MS);

      const look = await looks(control);

      expect(look.icon, `${at}: its icon shows`).not.toBeNull();
      if (page.viewportSize().width >= LABEL_FROM) {
        expect(look.text, `${at}: the word shows`).toBe("Account");

        const middle = (b) => b.y + b.height / 2;

        expect(look.word.x, `${at}: beside the icon, after it`)
          .toBeGreaterThanOrEqual(look.icon.x + look.icon.width - 1);
        expect(Math.abs(middle(look.word) - middle(look.icon)),
          `${at}: in the icon's line`)
          .toBeLessThanOrEqual(look.icon.height / 2);
      } else {
        expect(look.text, `${at}: the icon alone (provisional)`).toBe("");
      }
    }
  });

  test("Signed in or out, its accessible name is what it is today, said "
    + "once, not twice", async ({ page, context, baseURL }, info) => {
    for (const width of widthsFor(info.project.name,
      [390, LABEL_FROM, 992, WIDE])) {
      const at = label(width);

      await atWidth(page, width);
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await context.clearCookies();
      await signOut(page);
      await page.goto("/about/");
      await expect(signin(page), `${at}: signed out, one "Sign in"`)
        .toHaveCount(1);
      await expect(signin(page)).toHaveAccessibleName("Sign in");

      await page.unrouteAll({ behavior: "ignoreErrors" });
      await signIn(page, context, baseURL);
      await page.goto("/about/");
      await expect(account(page), `${at}: signed in, one "Account"`)
        .toHaveCount(1);
      await expect(account(page), `${at}: said once`)
        .toHaveAccessibleName("Account");
    }
  });

  test("The header's other controls keep their places and spacing at "
    + "390, 768, 992 and 1280 px", async ({ page, context, baseURL },
    info) => {
    for (const width of widthsFor(info.project.name,
      [390, LABEL_FROM, 992, WIDE])) {
      const at = label(width);

      await atWidth(page, width);
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await context.clearCookies();
      await signOut(page);
      await page.goto("/about/");
      await expect(signin(page)).toBeVisible();
      await page.waitForTimeout(SETTLE_MS);

      const out = await row(page);

      await page.unrouteAll({ behavior: "ignoreErrors" });
      await signIn(page, context, baseURL);
      await page.goto("/about/");
      await expect(account(page)).toBeVisible();
      await page.waitForTimeout(SETTLE_MS);

      const inside = await row(page);

      expect(inside.controls.map((c) => c.name),
        `${at}: the same controls in the same order`)
        .toEqual(out.controls.map((c) => c.name));
      for (let i = 1; i < inside.controls.length; i += 1) {
        const [a, b] = [inside.controls[i - 1], inside.controls[i]];

        expect(b.box.x, `${at}: ${b.name} clear of ${a.name}`)
          .toBeGreaterThanOrEqual(a.box.x + a.box.width - 1);
      }

      for (const [i, c] of inside.controls.entries()) {
        if (c.group === "actions") {
          expect(Math.abs(c.box.x - out.controls[i].box.x),
            `${at}: ${c.name} keeps its place`).toBeLessThanOrEqual(SAME_PX);
        }
      }
      expect(inside.gaps.length, `${at}: gaps to compare`)
        .toBe(out.gaps.length);
      for (const [i, g] of inside.gaps.entries()) {
        expect(Math.abs(g.px - out.gaps[i].px),
          `${at}: ${g.between.join(" to ")} is ${g.px.toFixed(1)} px, `
          + `${out.gaps[i].px.toFixed(1)} signed out`)
          .toBeLessThanOrEqual(SAME_PX);
      }
    }
  });
});
