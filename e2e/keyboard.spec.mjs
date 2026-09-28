// The keyboard half of the deferred manual pass (#197, #157): Tab
// through every page as a keyboard user would, wide and narrow, and
// check what a person tabbing would see.
//
// - Each stop is visible, on screen, and not hidden under something
//   else (a sticky header, a floating cart).
// - Each stop shows a focus ring: its outline or box-shadow, or a
//   near parent's, changes when it takes the focus. A radio or
//   checkbox drawn by its label shows the ring on the label.
// - Every visible control is reached (one radio per group is enough).
// - Tab reaches the end of the page and doesn't loop inside it.
// - Escape closes the site menu, the header's cart and account menus,
//   the order page's floating cart and product search, and gives the
//   focus back to what opened it; search and the site menu keep the
//   focus inside while open.
//
// WebKit tabs to form fields only unless Safari's "Press Tab to
// highlight each item" is on; Option-Tab is the same with it on, so
// WebKit presses Alt+Tab. Answers from the functions are canned, so
// this runs on a local build as well as staging and creates nothing.
// The order page's lapsed dialog opens only after a card is taken, so
// it isn't reached here.

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";
import {
  ACCOUNT_TABS, cannedDates, keepHome, signedIn, sitemap,
} from "./support/canned.mjs";

const WIDTHS = [1280, 390];

// Not in the sitemap. /account/ is walked signed in, below.
const UNLISTED = ["/login/", "/404.html"];

// Helpers the walk calls in the page, installed on every load.
const install = () => {
  const name = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const classes = [...el.classList].slice(0, 2).map((c) => `.${c}`);
    const label = (el.getAttribute("aria-label")
      || el.textContent || el.value || "").trim().replace(/\s+/g, " ");

    return `${el.tagName.toLowerCase()}${id}${classes.join("")}${
      label ? ` "${label.slice(0, 40)}"` : ""}`;
  };

  // A control hidden behind its label (shrunk to nothing, or clear
  // over it) shows focus on the label.
  const shownFor = (el) => {
    const r = el.getBoundingClientRect();
    const hidden = r.width <= 1 || r.height <= 1
      || getComputedStyle(el).opacity === "0";

    return hidden && el.labels?.length ? el.labels[0] : el;
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();

    if (r.width <= 1 || r.height <= 1) return false;
    // WebKit gives an SVG shape under display: none a box of its own.
    if (el.checkVisibility && !el.checkVisibility()) return false;
    if (getComputedStyle(el).visibility === "hidden") return false;
    for (let a = el; a; a = a.parentElement) {
      if (getComputedStyle(a).opacity === "0") return false;
    }

    return true;
  };

  const onScreen = (el) => {
    const r = el.getBoundingClientRect();

    return r.bottom > 0 && r.right > 0
      && r.top < innerHeight && r.left < innerWidth;
  };

  // What sits over the middle of the element, if anything.
  const coveredBy = (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const top = document.elementFromPoint(x, y);

    if (!top || el.contains(top) || top.contains(el)) return null;

    return name(top);
  };

  // An SVG control (a map pin) has no box to ring; its shape's
  // stroke, which the site restyles on focus, stands in for one.
  const ring = (el) => {
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== "none"
      && parseFloat(s.outlineWidth) > 0
      && s.outlineColor !== "rgba(0, 0, 0, 0)";
    const shape = el instanceof SVGElement && el.querySelector("path");
    const stroke = shape ? getComputedStyle(shape) : null;

    return {
      outline: outline ? `${s.outlineStyle} ${s.outlineWidth} ${
        s.outlineColor}` : "",
      shadow: s.boxShadow === "none" ? "" : s.boxShadow,
      stroke: stroke ? `${stroke.stroke} ${stroke.strokeWidth}` : "",
    };
  };

  // The ring may be drawn by the control or a near parent: an input
  // group rings its field and button as one, an order row its
  // stepper.
  const rings = (el) => {
    const chain = [];

    for (let a = el; a && chain.length < 4; a = a.parentElement) {
      chain.push(ring(a));
    }

    return chain;
  };

  const changed = (was, now) => (was.outline && was.outline !== now.outline)
    || (was.shadow && was.shadow !== now.shadow)
    || (was.stroke && was.stroke !== now.stroke);

  const kbd = { seen: new WeakSet(), stops: [], candidates: [] };

  // After each Tab: judge the stop now focused, and keep how it looks
  // for kbdNoRing.
  window.kbdStep = () => {
    const out = {};
    const el = document.activeElement;

    if (!el || el === document.body || el === document.documentElement) {
      return { end: true };
    }

    const shown = shownFor(el);

    out.name = name(el);
    out.iframe = el.tagName === "IFRAME";
    out.repeat = kbd.seen.has(el);
    kbd.seen.add(el);
    out.invisible = !visible(shown);
    out.offScreen = !out.invisible && !onScreen(shown);
    out.coveredBy = out.invisible || out.offScreen ? null : coveredBy(shown);
    if (!out.iframe && !out.repeat) {
      kbd.stops.push({ shown, name: out.name, rings: rings(shown) });
    }

    return out;
  };

  // Once nothing has the focus: the stops that looked no different
  // with it. Judged here rather than as the focus moves on, since a
  // parent's ring stays while the focus moves within it.
  window.kbdNoRing = () => {
    document.activeElement?.blur();

    return kbd.stops.filter(({ shown, rings: was }) => {
      const now = rings(shown);

      return !was.some((ring0, i) => now[i] && changed(ring0, now[i]));
    }).map((stop) => stop.name);
  };

  const TABBABLE = "a[href], button, input:not([type='hidden']), select, " +
    "textarea, summary, iframe, [tabindex], [contenteditable='true']";

  window.kbdStart = () => {
    kbd.candidates = [...document.querySelectorAll(TABBABLE)]
      .filter((el) => el.tabIndex >= 0 && !el.disabled
        && !el.closest("[inert]") && visible(shownFor(el)));

    // Blur alone leaves Tab going on from where the focus was, so
    // start from a mark at the very top, outside the Tab order.
    const start = document.createElement("span");

    start.tabIndex = -1;
    document.body.prepend(start);
    start.focus({ preventScroll: true });

    return kbd.candidates.length;
  };

  // Controls Tab never reached; a radio group counts once reached.
  window.kbdMissed = () => kbd.candidates
    .filter((el) => !kbd.seen.has(el))
    .filter((el) => !(el.type === "radio" && el.name
      && [...document.getElementsByName(el.name)]
        .some((r) => kbd.seen.has(r))))
    .map(name);
};

const tabKey = (browserName) => (browserName === "webkit" ? "Alt+Tab"
  : "Tab");

// Tabs from the top of the page to its end and returns what went
// wrong, each once.
const walk = async (page, key) => {
  const problems = [];
  const count = await page.evaluate(() => window.kbdStart());
  const limit = count + 40;
  let steps = 0;

  for (; steps < limit; steps += 1) {
    await page.keyboard.press(key);

    // WebKit scrolls to the focus a frame or two after it moves.
    const s = await page.evaluate(() => new Promise((done) => {
      requestAnimationFrame(() => requestAnimationFrame(
        () => done(window.kbdStep()),
      ));
    }));

    if (s.end) break;
    if (s.iframe) continue;
    if (s.repeat) {
      problems.push(`Tab loops without reaching the end, back at ${s.name}`);
      break;
    }
    if (s.invisible) problems.push(`focus on something unseen: ${s.name}`);
    if (s.offScreen) problems.push(`focus off screen: ${s.name}`);
    if (s.coveredBy) {
      problems.push(`focus hidden under ${s.coveredBy}: ${s.name}`);
    }
  }
  if (steps >= limit) problems.push(`no end after ${limit} presses of Tab`);
  for (const name of await page.evaluate(() => window.kbdNoRing())) {
    problems.push(`no focus ring: ${name}`);
  }
  for (const missed of await page.evaluate(() => window.kbdMissed())) {
    problems.push(`not reached by Tab: ${missed}`);
  }

  return [...new Set(problems)];
};

const settle = async (page) => {
  await page.waitForLoadState("load");
  await page.evaluate(() => document.fonts.ready);
};

// Escape closes what `open` opened and gives the focus back to
// `opener`; for a modal, Tab stays inside `inside` while it is open.
const escapes = async (page, key, { opener, isOpen, inside, modal }) => {
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect.poll(isOpen, "it opens from the keyboard").toBe(true);
  if (modal) {
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press(key);
      expect.soft(await inside.evaluate((box) => {
        const el = document.activeElement;

        return box.contains(el) || el === document.body;
      }), "Tab stays inside while it is open").toBe(true);
    }
  }
  await page.keyboard.press("Escape");
  await expect.poll(isOpen, "Escape closes it").toBe(false);
  await expect.soft(opener, "the focus goes back to its opener")
    .toBeFocused();
};

for (const width of WIDTHS) {
  test.describe(`keyboard at ${width}px (#197)`, () => {
    test.use({
      viewport: { width, height: 900 }, isMobile: false, hasTouch: false,
    });

    test.beforeEach(async ({ page, baseURL }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript(install);
      await keepHome(page, baseURL);
    });

    test("every page tabs cleanly", async ({ page, request, browserName }) => {
      const paths = [...await sitemap(request), ...UNLISTED];

      // A Tab walk of some 30 pages takes WebKit over two minutes.
      test.setTimeout(10 * 60_000);

      for (const path of paths) {
        await page.goto(path);
        await settle(page);
        expect.soft(await walk(page, tabKey(browserName)), path).toEqual([]);
      }
    });

    test("the order page with a cart tabs cleanly",
      async ({ page, browserName }) => {
        await cannedDates(page);
        await new OrderPage(page).open(FULL_CART);
        await page.evaluate(() => scrollTo(0, 0));
        expect.soft(await walk(page, tabKey(browserName)), "/order/")
          .toEqual([]);
      });

    test("the account tabs cleanly, signed in",
      async ({ page, browserName }) => {
        await signedIn(page);
        for (const tab of ACCOUNT_TABS) {
          // A new hash alone wouldn't load the page again.
          await page.goto("about:blank");
          await page.goto(`/account/#${tab}`);
          await expect(page.locator("#account-app")).toBeVisible();
          await settle(page);
          expect.soft(await walk(page, tabKey(browserName)),
            `/account/#${tab}`).toEqual([]);
        }
      });

    test("Escape closes search", async ({ page, browserName }) => {
      const dialog = page.locator("#search-palette");

      await page.goto("/about/");
      await escapes(page, tabKey(browserName), {
        opener: page.locator("[data-search-open]:visible").first(),
        isOpen: () => dialog.evaluate((d) => d.classList.contains("is-open")),
        inside: dialog,
        modal: true,
      });
    });

    test("Escape closes the site menu", async ({ page, browserName }) => {
      const toggle = page.locator(".site-toggle");
      const menu = page.locator("#site-menu");

      await page.goto("/about/");
      test.skip(!await toggle.isVisible(), "the menu is inline this wide");
      await escapes(page, tabKey(browserName), {
        opener: toggle,
        isOpen: () => menu.evaluate((m) => m.classList.contains("show")),
        inside: menu,
        modal: true,
      });
    });

    test("Escape closes the header's cart", async ({ page, browserName }) => {
      const toggle = page.locator(".site-cart-toggle");
      const menu = page.locator(".site-mini-cart");

      await cannedDates(page);
      await new OrderPage(page).open({ eggs: 2 });
      await page.goto("/about/");
      await expect(toggle).toBeVisible();
      await escapes(page, tabKey(browserName), {
        opener: toggle,
        isOpen: () => menu.evaluate((m) => m.classList.contains("show")),
      });
    });

    test("Escape closes the account menu", async ({ page, browserName }) => {
      // One in the header, one in the site menu; the menu's is flat.
      const button = page.locator("[data-account-menu]:visible").first();
      const menu = button.locator("xpath=following-sibling::ul");

      await signedIn(page);
      await page.goto("/about/");
      await settle(page);
      test.skip(!await button.count(), "the account links are flat here");
      await escapes(page, tabKey(browserName), {
        opener: button,
        isOpen: () => menu.evaluate((m) => m.classList.contains("show")),
      });
    });

    // Below xl the cart floats over the catalog, open, until the
    // customer folds it.
    test("Escape folds the order page's floating cart",
      async ({ page }) => {
        const order = new OrderPage(page);
        const toggle = order.cart.locator("[data-cart-toggle]");

        await cannedDates(page);
        await order.open(FULL_CART);
        await page.evaluate(() => scrollTo(0, 0));

        const floats = () => order.cart.evaluate((el) => (
          el.dataset.stuck === "true" && el.dataset.open === "true"
        ));

        test.skip(!await floats(), "the cart doesn't float this wide");
        await order.cart.locator("[data-checkout]").focus();
        await page.keyboard.press("Escape");
        await expect.soft(order.cart, "Escape folds it")
          .toHaveAttribute("data-open", "false");
        await expect.soft(toggle, "the focus goes to its toggle")
          .toBeFocused();
      });
  });
}
