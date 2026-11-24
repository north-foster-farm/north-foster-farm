// Criteria tests for the second revision of #703 that James asked for
// after his staging review on his phone at 2e14cf88 (2026-11-21, 1:13
// PM: "Not right yet."), written before the change from the issue's
// section "Second revision from James's staging review" and its six
// "Done when" boxes; one test per box, named for it word for word.
// The layout and its parts are those of e2e/pickup-days.spec.mjs.
//
// Held out of every run by its name (playwright.config.mjs matches
// *.spec.mjs). The change that meets the second revision turns it on
// with
//
//   git mv e2e/pickup-days-revision-2.criteria.mjs \
//     e2e/pickup-days-revision-2.spec.mjs
//
// and maps it in e2e/dispatch.json wherever
// pickup-days-revision.spec.mjs is, with a row for its own path.
//
// Sizes are read from the rendered styles and boxes. Two boxes compare
// with the layout at an earlier commit: those numbers were measured
// once in GitHub Actions, on that commit, by the same steps the test
// takes, and are fixed below with the commit and the run. Everything
// is measured at phone width, 390 px, where James saw it, and at a
// desktop width, 1440 px, where the box allows.

import {
  OrderPage, expect, test,
} from "./support/order.mjs";
import {
  DROP, FOSTER, cannedScheduled, datesWith,
} from "./support/scheduled.mjs";

const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1440, height: 900 };

// Copy and Map's heights at 2e14cf88 (the first revision, which James
// found too small) and at f77eaab0 (before the first revision, a
// btn-sm, which he found too big), the same in the desktop and phone
// projects, at 390 and 1440 px, for both places: Actions runs
// 44946507674 (2e14cf88) and 44946937462 (f77eaab0).
const SMALL = { Copy: 22.25, Map: 22.25 };
const BIG = { Copy: 37.59375, Map: 37.59375 };

// The space at 2e14cf88 at 390 px from the bottom of the address's
// last line (its glyphs) to the top of Copy and Map, the same in both
// projects and for both places (run 44946507674; f77eaab0 had 12).
const GAP = 9.59375;

// Two pickups on one date, then one date each; the Foster market has
// a place name, so its card shows all three lines of the address.
const grouped = () => datesWith([
  { place: DROP, days: [3, 10] },
  { place: FOSTER, days: [3, 9] },
]);

const card = (scope, value) => scope.locator(
  `.order-pickup:has(input[value='${value}'])`
);
const first = (lists, series) => lists.scheduled
  .find((d) => d.series === series).occurrence;

// The order page at `size` with `lists`, the Pickup days card open and
// still.
const openPickups = async (page, lists = grouped(), size = PHONE) => {
  await page.setViewportSize(size);
  await cannedScheduled(page, lists);

  const order = new OrderPage(page);

  await order.open({ eggs: 1 }, { method: "scheduled" });
  await expect(page.locator("#scheduled-pickups .order-pickup").first())
    .toBeVisible();
  await order.scrollSettled();

  return order;
};

const box = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();

  return { x: r.left, y: r.top, right: r.right, bottom: r.bottom,
    height: r.height };
});

// The boxes of an element's own glyphs, one per line, top to bottom:
// the text's content area, without the line box's leading, so the
// space between two of them is the space the reader sees.
const glyphLines = (locator) => locator.evaluate((el) => {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const rects = [];

  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.textContent.trim()) continue;

    const range = document.createRange();

    range.selectNodeContents(n);
    rects.push(...[...range.getClientRects()].filter((r) => r.width > 0)
      .map((r) => ({ top: r.top, bottom: r.bottom })));
  }
  rects.sort((a, b) => a.top - b.top);

  return rects.filter((r, i) => i === 0 || r.top - rects[i - 1].top > 2);
});

// The address group's parts a card shows, top to bottom: the place
// name when the location has one, the street, the town line.
const addressOf = (series) => (series === FOSTER.series
  ? [".order-pickup-place", ".order-pickup-street", ".order-pickup-city"]
  : [".order-pickup-street", ".order-pickup-city"]);

test.describe("pickup days, James's second revision (#703)", () => {
  test("Second revision: Copy and Map are larger than at 2e14cf88 and " +
    "smaller than before the first revision", async ({ page }) => {
    const lists = grouped();
    const order = await openPickups(page, lists);
    const pickups = page.locator("#scheduled-pickups .order-pickup");

    for (const size of [PHONE, WIDE]) {
      await page.setViewportSize(size);
      await order.scrollSettled();
      await expect(pickups).toHaveCount(lists.scheduled.length);
      for (const pickup of await pickups.all()) {
        for (const [name, control] of [
          ["Copy", pickup.getByRole("button", { name: "Copy" })],
          ["Map", pickup.getByRole("link", { name: /^Map\b/ })],
        ]) {
          await expect(control).toBeVisible();

          const { height } = await box(control);

          expect(height, `${name} taller than at 2e14cf88, ${size.width}px`)
            .toBeGreaterThan(SMALL[name] + 0.5);
          expect(height,
            `${name} shorter than before the first revision, ${size.width}px`)
            .toBeLessThan(BIG[name] - 0.5);
        }
      }
    }
  });

  test("Second revision: The pickup's name line has the date heading's " +
    "font family, size and weight", async ({ page }) => {
    const order = await openPickups(page);
    const days = page.locator("#scheduled-pickups .order-pickup-day");
    // The family is the face the stack asks for first: the fallbacks
    // after it are the browser's, not a second font.
    const font = (locator) => locator.evaluate((el) => {
      const s = getComputedStyle(el);
      const family = s.fontFamily.split(",")[0].trim()
        .replace(/^["']|["']$/g, "");

      return { family, size: parseFloat(s.fontSize),
        weight: s.fontWeight };
    });

    for (const size of [PHONE, WIDE]) {
      await page.setViewportSize(size);
      await order.scrollSettled();
      await expect(days).toHaveCount(3);
      for (const day of await days.all()) {
        const heading = await font(day.getByRole("heading"));
        const names = day.locator(".order-pickup-name");

        await expect(names.first()).toBeVisible();
        for (const name of await names.all()) {
          const it = await font(name);

          expect(it.family, `the heading's family at ${size.width}px`)
            .toBe(heading.family);
          expect(Math.abs(it.size - heading.size),
            `the heading's size at ${size.width}px`).toBeLessThanOrEqual(0.1);
          expect(it.weight, `the heading's weight at ${size.width}px`)
            .toBe(heading.weight);
        }
      }
    }
  });

  test("Second revision: The gap between the name and the time is " +
    "smaller than the gap between the time and the address",
  async ({ page }) => {
    const lists = grouped();
    const order = await openPickups(page, lists);
    const home = page.locator("#scheduled-pickups");

    for (const size of [PHONE, WIDE]) {
      await page.setViewportSize(size);
      await order.scrollSettled();
      for (const series of [DROP.series, FOSTER.series]) {
        const pickup = card(home, first(lists, series));
        const name = await glyphLines(pickup.locator(".order-pickup-name"));
        const time = await glyphLines(pickup.locator(".order-pickup-time"));
        const address = await glyphLines(
          pickup.locator(addressOf(series)[0])
        );

        expect(name.length * time.length * address.length,
          "the name, the time and the address show").toBeGreaterThan(0);

        const above = time[0].top - name.at(-1).bottom;
        const below = address[0].top - time.at(-1).bottom;

        expect(above, "the time below the name").toBeGreaterThanOrEqual(0);
        expect(above,
          `${series}: the time closer to the name than to the address ` +
          `at ${size.width}px`).toBeLessThan(below - 1);
      }
    }
  });

  test("Second revision: Every line of the address group (place name, " +
    "street, town line) has the same line height", async ({ page }) => {
    const lists = grouped();
    const order = await openPickups(page, lists);
    const home = page.locator("#scheduled-pickups");

    for (const size of [PHONE, WIDE]) {
      await page.setViewportSize(size);
      await order.scrollSettled();
      for (const series of [DROP.series, FOSTER.series]) {
        const pickup = card(home, first(lists, series));
        const heights = {};

        for (const part of addressOf(series)) {
          await expect(pickup.locator(part)).toBeVisible();
          heights[part] = await pickup.locator(part).evaluate(
            (el) => parseFloat(getComputedStyle(el).lineHeight)
          );
        }

        const all = Object.values(heights);

        expect(all.every(Number.isFinite),
          `${series}: each line height set, ${JSON.stringify(heights)}`)
          .toBe(true);
        expect(Math.max(...all) - Math.min(...all),
          `${series}: one line height at ${size.width}px, ${
            JSON.stringify(heights)}`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  test("Second revision: A wrapped line within the address group sits " +
    "closer to the line it continues than that line's gap to the next " +
    "address line", async ({ page }) => {
    const lists = grouped();

    await openPickups(page, lists);

    const foster = card(page.locator("#scheduled-pickups"),
      first(lists, FOSTER.series));
    const place = foster.locator(".order-pickup-place");
    const street = foster.locator(".order-pickup-street");
    const city = foster.locator(".order-pickup-city");

    // A long street address, and a long place name, each wrapping at
    // 390 px.
    await street.evaluate((el) => {
      el.textContent = "1640 Old Danielson Pike Extension, Building 2, " +
        "Rear Entrance";
    });
    await place.evaluate((el) => {
      el.textContent = "Inside of Shady Acres Diner And Really Long " +
        "Location Name";
    });

    const lines = {
      place: await glyphLines(place),
      street: await glyphLines(street),
      city: await glyphLines(city),
    };

    for (const [part, next] of [["place", "street"], ["street", "city"]]) {
      const of = lines[part];

      expect(of.length, `the long ${part} wraps`).toBeGreaterThanOrEqual(2);
      expect(lines[next].length, `the ${next} shows`)
        .toBeGreaterThanOrEqual(1);

      const after = lines[next][0].top - of.at(-1).bottom;

      for (const [i, line] of of.slice(1).entries()) {
        const wrapped = line.top - of[i].bottom;

        expect(wrapped, `the ${part}'s wrapped line closer to the line ` +
          `it continues than the ${part} to the ${next}`)
          .toBeLessThan(after - 0.5);
      }
    }
  });

  test("Second revision: The space between the address and the Copy and " +
    "Map buttons is larger than at 2e14cf88", async ({ page }) => {
    const lists = grouped();

    await openPickups(page, lists);

    const home = page.locator("#scheduled-pickups");

    for (const series of [DROP.series, FOSTER.series]) {
      const pickup = card(home, first(lists, series));
      const town = await glyphLines(pickup.locator(".order-pickup-city"));
      const copy = await box(pickup.getByRole("button", { name: "Copy" }));
      const map = await box(pickup.getByRole("link", { name: /^Map\b/ }));
      const space = Math.min(copy.y, map.y) - town.at(-1).bottom;

      expect(space, `${series}: more space above Copy and Map than at ` +
        "2e14cf88").toBeGreaterThan(GAP + 0.5);
    }
  });
});
