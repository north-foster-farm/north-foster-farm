// Criteria tests for #913 (Site search in the header: open from the
// icon, animate, and match the navbar), the six (test) boxes of its
// "Done when" list, one test each, named for its box. Box 7 is the
// existing search specs, changed only where a box here replaces one
// (a patch handed to the implementer with these tests). Every box is
// about the page after a press, a computed style or a layout, so none
// is a unit test.
// Held out of every run by its name until the change lands: renamed to
// header-search.spec.mjs, it runs in the desktop project at the widths
// each box names and in the phone project at its own (390 px).
//
// PROVISIONAL, until James settles the two points #913 leaves open:
// - search is closed to the magnifying glass at every width until it
//   is pressed (no field standing in the navbar from 992 px), so boxes
//   1, 2, 3, 4, 5 and 6 open it from the glass at 992 px and up too;
// - on wide screens the open field is about the width it has in the
//   navbar today, its results panel anchored under it (box 3), not
//   the "small reveal item that floats above the hero".
//
// The seam, what the tests rely on:
// - The control is a button in the banner named "Search" or "Open
//   search" while closed and "Close search" while open, outside the
//   search landmark. Its icon is the inline SVG of
//   assets/images/icons/search.svg or search-close.svg, read here from
//   the files and matched by their paths; the one showing is the SVG
//   in the control that is rendered and not transparent.
// - The field is a combobox named "Search..." in a role="search"
//   landmark, shown while search is open and hidden while it is closed.
// - "Animated" is a CSS animation, or a transition of a property that
//   moves, sizes or reveals (opacity, transform, translate, scale,
//   width, height, max-width, max-height, clip-path, inset, top, left,
//   right, bottom, grid-template-rows or -columns), running on the
//   search landmark or inside it in the frame the press lands, with a
//   duration above 0. A focus ring's color is not a reveal. Under
//   reduced motion, none is longer than 1 ms. No duration is pinned.
// - The navbar's other controls are its text links (News, About,
//   Contact); their hover gives the outline and shadow of box 4, and
//   their computed font size is box 5's. The field's outline is that
//   of the combobox, hovered with the focus taken off it (blur), which
//   leaves search open.
// - Box 6 measures ink, as #327 did: a control's ink is its own border
//   box when it shows a border or a background, else the union of the
//   text, SVGs and painted parts inside it. The gap between two
//   controls is the space between their inks. The header's controls
//   fall in two groups, those in the main navigation landmark and the
//   rest of the banner's row, and only neighbors in one group are
//   compared, so the free space between the groups is never a gap.

import { readFileSync } from "node:fs";

import { expect, test } from "./support/order.mjs";

const ICON = (name) => [...readFileSync(new URL(
  `../assets/images/icons/${name}.svg`, import.meta.url
), "utf8").matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]).sort().join(" ");
const GLASS = ICON("search");
const CLOSE = ICON("search-close");

const WIDE = 1280;
const SETTLE_MS = 700;
// Ink gaps that differ by no more than this are equal.
const SAME_PX = 2;

const widthsFor = (project, widths) => (project === "desktop"
  ? widths : [null]);
const label = (w) => (w ? `${w} px` : "the phone's width");

const atWidth = async (page, width) => {
  if (width) {
    await page.setViewportSize({ width, height: width >= 992 ? 900 : 664 });
  }
};

const ui = (page) => {
  const field = page.getByRole("combobox", { name: /search/i });
  const region = page.getByRole("search").filter({ has: field });

  return {
    field,
    region,
    banner: page.getByRole("banner"),
    control: page.getByRole("banner")
      .getByRole("button", { name: /^(open |close )?search$/i }),
    listbox: region.getByRole("listbox"),
    options: region.getByRole("option"),
    links: page.locator("nav[aria-label='Main']")
      .getByRole("link", { name: /^(News|About|Contact)$/ }),
  };
};

// The paths of the icon the control shows, as ICON gives a file's.
const shownIcon = (control) => control.evaluate((el) => {
  const seen = (svg) => {
    const box = svg.getBoundingClientRect();

    if (!box.width || !box.height) return false;
    for (let n = svg; n && n !== el.parentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);

      if (cs.display === "none" || cs.visibility === "hidden"
        || Number(cs.opacity) < 0.5) return false;
    }

    return true;
  };

  return [...el.querySelectorAll("svg")].filter(seen).map((svg) => [
    ...svg.querySelectorAll("path"),
  ].map((p) => p.getAttribute("d")).sort().join(" "));
});

const open = async (page, s) => {
  await s.control.click();
  await expect(s.field).toBeVisible();
  await page.waitForTimeout(SETTLE_MS);
};

const REVEAL = new Set(["opacity", "transform", "translate", "scale",
  "width", "height", "max-width", "max-height", "clip-path", "inset",
  "top", "left", "right", "bottom", "grid-template-rows",
  "grid-template-columns", "all"]);

// Presses the control and, in the same frame, lists the reveal
// animations running on the search landmark or inside it, by duration.
const pressAndWatch = (s) => s.control.evaluate((button, reveal) => {
  const region = [...document.querySelectorAll("[role='search'], search")]
    .find((r) => r.querySelector("[role='combobox']"));

  button.click();

  return (region ? region.getAnimations({ subtree: true }) : [])
    .filter((a) => !("transitionProperty" in a)
      || reveal.includes(a.transitionProperty))
    .map((a) => ({
      what: a.transitionProperty || a.animationName,
      ms: Number(a.effect?.getComputedTiming().duration) || 0,
    }));
}, [...REVEAL]);

// The gaps between neighboring controls' inks, as the header's comment
// describes, the search control named SEARCH.
const SEARCH = "(search control)";
const inks = (page) => page.evaluate((SEARCH) => {
  const banner = document.querySelector("header, [role='banner']");
  const main = banner.querySelector("nav[aria-label='Main']");
  const brand = banner.querySelector("a[aria-label$=', home']");
  const row = brand.getBoundingClientRect();
  const painted = (cs) => {
    const bg = cs.backgroundColor;
    const border = parseFloat(cs.borderLeftWidth) > 0
      && !/rgba\(.*,\s*0\)|transparent/.test(cs.borderLeftColor);

    return border || !(bg === "transparent" || /rgba\(.*,\s*0\)/.test(bg));
  };
  const visible = (el) => {
    const box = el.getBoundingClientRect();

    return box.width > 0 && box.height > 0
      && getComputedStyle(el).visibility !== "hidden";
  };
  const ink = (el) => {
    if (painted(getComputedStyle(el))) return el.getBoundingClientRect();

    const boxes = [];
    const walk = (n) => {
      if (n.nodeType === 3 && n.textContent.trim()) {
        const range = document.createRange();

        range.selectNodeContents(n);
        boxes.push(...range.getClientRects());
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
      && !el.closest("[role='search'], search, .offcanvas:not(.show)")
      && (() => {
        const b = el.getBoundingClientRect();
        const mid = b.top + b.height / 2;

        return mid >= row.top && mid <= row.bottom;
      })())
    .map((el) => ({
      name: el.hasAttribute("data-e2e-search-control") ? SEARCH
        : el.getAttribute("aria-label") || el.textContent.trim(),
      group: main && main.contains(el) ? "nav" : "actions",
      ink: ink(el),
    }))
    .filter((c) => c.ink)
    .sort((a, b) => a.ink.left - b.ink.left);
  const gaps = [];

  for (let i = 1; i < controls.length; i += 1) {
    const [a, b] = [controls[i - 1], controls[i]];

    if (a.group === b.group) {
      gaps.push({
        between: [a.name, b.name], px: b.ink.left - a.ink.right,
      });
    }
  }

  return gaps;
}, SEARCH);

test.describe("#913 site search in the header", () => {
  test("Search opens from the magnifying glass and closes again from the "
    + "same control, at every width; the control shows search.svg closed "
    + "and search-close.svg open, and says which in its accessible name",
  async ({ page }, info) => {
    for (const width of widthsFor(info.project.name,
      [390, 768, 992, WIDE])) {
      const at = label(width);

      await atWidth(page, width);
      await page.goto("/about/");

      const s = ui(page);

      await expect(s.field, `${at}: closed until pressed`).toBeHidden();
      await expect(s.control, `${at}: the glass shows`).toBeVisible();
      await expect(s.control, `${at}: named for opening`)
        .toHaveAccessibleName(/^(open )?search$/i);
      expect(await shownIcon(s.control), `${at}: search.svg, closed`)
        .toEqual([GLASS]);

      await open(page, s);
      await expect(s.field, `${at}: focused once open`).toBeFocused();
      await expect(s.control, `${at}: named for closing`)
        .toHaveAccessibleName(/^close search$/i);
      expect(await shownIcon(s.control), `${at}: search-close.svg, open`)
        .toEqual([CLOSE]);

      await s.control.click();
      await expect(s.field, `${at}: the same control closes it`)
        .toBeHidden();
      await page.waitForTimeout(SETTLE_MS);
      await expect(s.control, `${at}: named for opening again`)
        .toHaveAccessibleName(/^(open )?search$/i);
      expect(await shownIcon(s.control), `${at}: search.svg again`)
        .toEqual([GLASS]);
    }
  });

  test("Opening and closing are animated, on the phone and on wide "
    + "screens, and are instant under reduced motion",
  async ({ page }, info) => {
    for (const width of widthsFor(info.project.name, [390, WIDE])) {
      const at = label(width);

      await atWidth(page, width);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto("/about/");

      const s = ui(page);

      await expect(s.control, `${at}: the glass shows`).toBeVisible();

      const opening = await pressAndWatch(s);

      expect(opening.filter((a) => a.ms > 0), `${at}: opening animates`)
        .not.toEqual([]);
      await expect(s.field).toBeVisible();
      await page.waitForTimeout(SETTLE_MS);

      const closing = await pressAndWatch(s);

      expect(closing.filter((a) => a.ms > 0), `${at}: closing animates`)
        .not.toEqual([]);
      await expect(s.field).toBeHidden();

      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/about/");

      const still = await pressAndWatch(s);

      expect(still.filter((a) => a.ms > 1),
        `${at}: opening is instant under reduced motion`).toEqual([]);
      await expect(s.field).toBeVisible();
      await page.waitForTimeout(SETTLE_MS);
      expect((await pressAndWatch(s)).filter((a) => a.ms > 1),
        `${at}: closing is instant under reduced motion`).toEqual([]);
      await expect(s.field).toBeHidden();
    }
  });

  test("On wide screens the open search is about the width it has "
    + "sitting in the navbar: it never spans the header",
  async ({ page, isMobile }) => {
    test.skip(isMobile, "wide screens");

    for (const width of [WIDE, 1920]) {
      const at = `${width} px`;

      await atWidth(page, width);
      await page.goto("/about/");

      const s = ui(page);

      await open(page, s);
      await s.field.fill("eggs");
      await expect(s.options.first()).toBeVisible();
      await page.waitForTimeout(SETTLE_MS);

      const header = await s.banner.boundingBox();
      const field = await s.field.boundingBox();
      const region = await s.region.boundingBox();
      const panel = await s.listbox.boundingBox();

      expect(region.width, `${at}: never spans the header`)
        .toBeLessThan(header.width / 3);
      expect(field.width, `${at}: a navbar field's width`)
        .toBeLessThan(header.width / 3);
      for (const link of await s.links.all()) {
        const box = await link.boundingBox();
        const apart = box.x + box.width <= region.x
          || box.x >= region.x + region.width;

        expect(apart, `${at}: clear of ${await link.textContent()}`)
          .toBe(true);
      }
      expect(panel.y, `${at}: the panel under the field`)
        .toBeGreaterThanOrEqual(field.y + field.height - 4);
      expect(panel.y, `${at}: right under it`)
        .toBeLessThanOrEqual(field.y + field.height + 32);
      expect(panel.x < field.x + field.width
        && panel.x + panel.width > field.x, `${at}: anchored to the field`)
        .toBe(true);
      expect(panel.width, `${at}: the panel never spans the header`)
        .toBeLessThan(header.width / 2);
    }
  });

  test("The field's outline matches the navbar's other controls: the "
    + "light gray outline and the shadow the non-CTA buttons take on "
    + "hover", async ({ page, isMobile }) => {
    test.skip(isMobile, "the navbar's controls are in the menu");

    await atWidth(page, WIDE);
    await page.goto("/about/");

    const s = ui(page);
    const link = s.links.first();
    const outline = (locator) => locator.evaluate((el) => {
      const cs = getComputedStyle(el);

      return {
        width: parseFloat(cs.borderTopWidth) > 0,
        color: cs.borderTopColor,
        shadow: cs.boxShadow,
      };
    });

    await link.hover();
    await page.waitForTimeout(SETTLE_MS);

    const want = await outline(link);

    await open(page, s);
    await s.field.evaluate((el) => el.blur());
    await s.field.hover();
    await page.waitForTimeout(SETTLE_MS);
    await expect(s.field, "search stays open").toBeVisible();

    const got = await outline(s.field);

    expect(got.width, "the field has an outline").toBe(true);
    expect(got.color, "the light gray outline").toBe(want.color);
    expect(got.shadow, "the hover shadow").toBe(want.shadow);
  });

  test("In the navbar, the placeholder and the typed text are the menu "
    + "buttons' font size", async ({ page, isMobile }) => {
    test.skip(isMobile, "the navbar's buttons are in the menu");

    for (const width of [992, WIDE]) {
      const at = `${width} px`;

      await atWidth(page, width);
      await page.goto("/about/");

      const s = ui(page);
      const size = await s.links.first().evaluate(
        (el) => getComputedStyle(el).fontSize
      );

      await open(page, s);

      const placeholder = await s.field.evaluate(
        (el) => getComputedStyle(el, "::placeholder").fontSize
      );

      expect(placeholder, `${at}: the placeholder`).toBe(size);
      await s.field.fill("eggs");
      expect(await s.field.evaluate((el) => getComputedStyle(el).fontSize),
        `${at}: the typed text`).toBe(size);
    }
  });

  test("The space to the left and right of the search control in the "
    + "header equals the space around the other header links",
  async ({ page }, info) => {
    for (const width of widthsFor(info.project.name,
      [390, 768, 992, WIDE])) {
      const at = label(width);

      await atWidth(page, width);
      await page.goto("/about/");
      await page.waitForTimeout(SETTLE_MS);

      await ui(page).control.evaluate((el) => {
        el.dataset.e2eSearchControl = "";
      });

      const gaps = await inks(page);
      const mine = gaps.filter((g) => g.between.includes(SEARCH));
      const others = gaps.filter((g) => !g.between.includes(SEARCH));

      expect(mine.length, `${at}: the search control has neighbors`)
        .toBeGreaterThan(0);
      expect(others.length, `${at}: other gaps to compare`)
        .toBeGreaterThan(0);

      const sorted = others.map((g) => g.px).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];

      for (const g of mine) {
        expect(Math.abs(g.px - median),
          `${at}: ${g.between.join(" to ")} is ${g.px.toFixed(1)} px, `
          + `the rest ${median.toFixed(1)}`).toBeLessThanOrEqual(SAME_PX);
      }
    }
  });
});
