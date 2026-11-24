// Criteria tests for #913's revision from James's staging look
// (2026-11-23), the "Revision:" boxes of its "Done when" list marked
// (test), one test each, named for its box. James: "768 to 991 px: the
// slide-down bar is far too wide. Full width under 768 px; from 768 px
// cap the field at the page container's width, lined up with the
// content below, Cancel at its right edge. 992 px and up unchanged."
// Held out of every run (`held` in playwright.config.mjs) until the
// change lands: deleting its line there turns it on.
// The desktop project measures at the widths each box names; the phone
// project runs the first box at its own width (390 px) and skips the
// others, which are wider than a phone.
//
// The box "At 992 px and up nothing changes" has no test here: it is
// the existing specs passing unedited (e2e/site-search.spec.mjs,
// e2e/header-search.spec.mjs, e2e/overflow.spec.mjs).
//
// PROVISIONAL, until James confirms the reading:
// - "lined up with the content below" is read as the field's left edge
//   on the page container's left edge and Cancel's right edge on the
//   container's right edge, within one pixel;
// - the container's edge is its content edge, inside its padding,
//   which is where the content below it starts (a Bootstrap row's
//   negative margins and its columns' padding cancel out, so a page's
//   text starts there).
//
// The seam, what the tests rely on:
// - The bar is the `role="search"` landmark holding the field, as in
//   e2e/site-search.spec.mjs; the field is the combobox named
//   "Search..." in it, and Cancel the button named "Cancel" in it.
// - Search opens from the header's magnifier, a button in the banner
//   named "Search" or "Open search".
// - The page container is the first `.container` inside <main>, the
//   one the content below the header sits in. /about/ is measured.

import { expect, test } from "./support/order.mjs";

const PAGE = "/about/";
const HEIGHT = 664;
const SETTLE_MS = 600;
// Edges this close are on each other.
const ONE_PX = 1;

const ui = (page) => {
  const field = page.getByRole("combobox", { name: /search/i });
  const bar = page.getByRole("search").filter({ has: field });

  return {
    field,
    bar,
    magnifier: page.getByRole("banner")
      .getByRole("button", { name: /^(open )?search$/i }),
    cancel: bar.getByRole("button", { name: "Cancel", exact: true }),
    container: page.locator("main .container").first(),
  };
};

// The container's content box: its border box less its padding.
const contentBox = (locator) => locator.evaluate((el) => {
  const box = el.getBoundingClientRect();
  const cs = getComputedStyle(el);

  return {
    left: box.left + parseFloat(cs.paddingLeft)
      + parseFloat(cs.borderLeftWidth),
    right: box.right - parseFloat(cs.paddingRight)
      - parseFloat(cs.borderRightWidth),
  };
});

const openAt = async (page, width) => {
  if (width) await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(PAGE);

  const s = ui(page);

  await s.magnifier.click();
  await expect(s.field).toBeVisible();
  await expect(s.cancel).toBeVisible();
  await page.waitForTimeout(SETTLE_MS);

  return s;
};

test.describe("#913 revision: the search bar's width, 768 to 991 px", () => {
  test("Revision: Under 768 px the slide-down search bar is full width, "
    + "as it is today", async ({ page }, info) => {
    const widths = info.project.name === "desktop" ? [390, 767] : [null];

    for (const width of widths) {
      const at = width ? `${width} px` : "the phone's width";
      const s = await openAt(page, width);
      const vw = page.viewportSize().width;
      const bar = await s.bar.boundingBox();

      expect(bar.x, `${at}: from the left edge`).toBeLessThanOrEqual(ONE_PX);
      expect(bar.x + bar.width, `${at}: to the right edge`)
        .toBeGreaterThanOrEqual(vw - ONE_PX);
    }
  });

  test("Revision: From 768 to 991 px the field is capped at the page "
    + "container's width and lines up with the content below it: its "
    + "left edge on the container's left edge", async ({ page, isMobile }) => {
    test.skip(isMobile, "768 px and up");

    for (const width of [768, 991]) {
      const at = `${width} px`;
      const s = await openAt(page, width);
      const box = await contentBox(s.container);
      const field = await s.field.boundingBox();

      expect(Math.abs(field.x - box.left),
        `${at}: the field's left edge, ${field.x.toFixed(1)} px, on the `
        + `container's, ${box.left.toFixed(1)} px`)
        .toBeLessThanOrEqual(ONE_PX);
      expect(field.x + field.width, `${at}: within the container`)
        .toBeLessThanOrEqual(box.right + ONE_PX);
      expect(field.width, `${at}: no wider than the container`)
        .toBeLessThanOrEqual(box.right - box.left + ONE_PX);
    }
  });

  test("Revision: From 768 to 991 px Cancel sits at the bar's right edge, "
    + "on the container's right edge", async ({ page, isMobile }) => {
    test.skip(isMobile, "768 px and up");

    for (const width of [768, 991]) {
      const at = `${width} px`;
      const s = await openAt(page, width);
      const box = await contentBox(s.container);
      const cancel = await s.cancel.boundingBox();
      const field = await s.field.boundingBox();
      const right = cancel.x + cancel.width;

      expect(Math.abs(right - box.right),
        `${at}: Cancel's right edge, ${right.toFixed(1)} px, on the `
        + `container's, ${box.right.toFixed(1)} px`)
        .toBeLessThanOrEqual(ONE_PX);
      expect(cancel.x, `${at}: Cancel right of the field`)
        .toBeGreaterThanOrEqual(field.x + field.width - ONE_PX);
      expect(Math.abs((cancel.y + cancel.height / 2)
        - (field.y + field.height / 2)), `${at}: in the field's row`)
        .toBeLessThanOrEqual(field.height / 2);

      // At the bar's right edge: nothing the bar shows in its row ends
      // further right than Cancel.
      const furthest = await s.bar.evaluate((bar, row) => Math.max(
        ...[...bar.querySelectorAll("*")].filter((el) => {
          const b = el.getBoundingClientRect();
          const cs = getComputedStyle(el);

          return b.width > 1 && b.height > 1 && cs.visibility !== "hidden"
            && b.bottom > row.top && b.top < row.bottom;
        }).map((el) => el.getBoundingClientRect().right)
      ), { top: cancel.y, bottom: cancel.y + cancel.height });

      expect(furthest, `${at}: Cancel is the bar's rightmost`)
        .toBeLessThanOrEqual(right + ONE_PX);
    }
  });
});
