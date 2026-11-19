// #606: the news post's "our map" link (/news/three-quarters-of-the-way/
// to /#map) must land with the home page's ZIP field well inside the
// window, not at its bottom edge. map.spec.mjs's "the news post's ZIP
// link leads to the map's check" asks only that the field be in the
// viewport at all, which it was by 51 px on desktop and 81 px on a
// phone (measured on next at e146cd21), and lost once when the content
// above it grew.
//
// "Well inside" is measured as: once the scroll has settled, the
// field's whole box lies in the upper two thirds of the window. The
// lower third is the margin the page needs to keep: a third of the
// window (300 px at 1500 x 900, 221 px at 390 x 664) is more than the
// rows the places list has added before, so a taller page above still
// lands with the field in view, and the reader sees the field without
// hunting for it at the fold. On next the field's top sits at 849 of
// 900 and 583 of 664, so both sizes fail today.
//
// The desktop (1500 x 900) and phone (390 x 664) projects run it at
// the issue's own sizes.

import { expect, test } from "./support/order.mjs";

const POST = "/news/three-quarters-of-the-way/";
const INPUT = "#home-map-zip-input";

// The home page scrolls smoothly to #map, and the schedule (/api/dates,
// /api/events) can lay out rows above the map after the first paint.
// Wait for the network to go quiet, then for the field's box and the
// scroll position to hold still across half a second of frames.
const settledBox = async (page) => {
  await page.waitForLoadState("networkidle");

  let last = null;
  let still = 0;

  await expect.poll(async () => {
    const now = await page.locator(INPUT).evaluate((el) => {
      const r = el.getBoundingClientRect();

      return {
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        scrollY: Math.round(window.scrollY),
      };
    });
    const same = last && now.top === last.top && now.bottom === last.bottom
      && now.scrollY === last.scrollY;

    still = same ? still + 1 : 0;
    last = now;

    return still;
  }, { intervals: [100], timeout: 15_000 }).toBeGreaterThanOrEqual(5);

  return last;
};

test.describe("the news post's map link (#606)", () => {
  test("the link lands with the ZIP field well inside the window",
    async ({ page }) => {
      await page.goto(POST);
      await page.locator("main .prose")
        .getByRole("link", { name: "our map" }).click();
      // The home page, at whichever anchor the fix puts the link on.
      await expect(page).toHaveURL(/\/#[\w-]+$/);

      const box = await settledBox(page);
      const height = page.viewportSize().height;
      const limit = Math.floor(height * 2 / 3);

      expect(box.top, "the field's top is on screen")
        .toBeGreaterThanOrEqual(0);
      expect(box.bottom,
        `the field's bottom (${box.bottom} of ${height}) is within the ` +
        `window's upper two thirds (${limit})`)
        .toBeLessThanOrEqual(limit);
    });
});
