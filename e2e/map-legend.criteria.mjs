// Criteria tests for #917 (Home page map: lay the legend out as a grid
// when it sits below the map), one per tested box, named for it. Box
// 6 is James's look on staging. Measured in the browser by the desktop
// project, which sets each width itself; positions are compared with
// each other and with the room the legend has, never with pixel
// values.
//
// "Room" is measured, not assumed: an item's natural width is its
// swatch or icons and its label laid out on one line. The legend has
// room for a row when the four natural widths, with a generous 2rem
// between each, fit the width it may take; it lacks room for one when
// they do not fit with none. The same goes for a pair, two to a row.
// Between those two marks either layout passes. Boxes 1 to 3 sweep
// the widths where the legend sits below the map and check each one,
// and each requires its own layout to turn up at one width at least.
//
// Held out of every run by its name until the change lands: renamed
// to map-legend.spec.mjs and added to e2e/dispatch.json.
//
// The seam, what the tests rely on: the legend is the Delivery layer's
// key, `.map-key-delivery`, in `.map-key`, beside or below the map's
// `.map-frame` in `#map`; its items are the `li` of its list, in
// order, each a swatch or icons then a label `span`. An item's box is
// the union of its children's boxes, so an `li` drawn as
// `display: contents`, as today, measures too.

import { expect, test } from "./support/order.mjs";

const BELOW = [320, 360, 390, 430, 480, 576, 640, 700, 768, 860, 991];
const WORDS = [320, 390, 576, 768];
const GAP = 32;

const desktopOnly = (info) => test.skip(info.project.name !== "desktop",
  "the desktop project measures the widths the box names");

// The legend at one width: each item's box and natural width, the
// width it may take, and where it sits against the map.
const measure = (page) => page.locator("#map .map-key-delivery")
  .evaluate((card) => {
    const union = (els) => {
      const rects = els.map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);

      return {
        left: Math.min(...rects.map((r) => r.left)),
        right: Math.max(...rects.map((r) => r.right)),
        top: Math.min(...rects.map((r) => r.top)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
      };
    };
    const shown = (li) => [...li.children]
      .filter((c) => !c.classList.contains("visually-hidden"));
    const items = [...card.querySelectorAll("li")];
    const natural = items.map((li) => {
      const [first, second] = shown(li);
      const inner = second.getBoundingClientRect().left
        - first.getBoundingClientRect().right;
      const probe = li.cloneNode(true);

      Object.assign(probe.style, { display: "inline-flex",
        alignItems: "center", gap: `${Math.max(inner, 0)}px`,
        whiteSpace: "nowrap", position: "absolute", visibility: "hidden",
        width: "max-content" });
      li.parentElement.append(probe);

      const width = probe.getBoundingClientRect().width;

      probe.remove();

      return width;
    });
    const css = getComputedStyle(card);
    const key = card.closest(".map-key");
    const frame = card.closest("#map").querySelector(".map-frame")
      .getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const room = key.getBoundingClientRect().width
      - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)
      - parseFloat(css.borderLeftWidth) - parseFloat(css.borderRightWidth);

    return {
      room, natural,
      items: items.map((li) => {
        const label = [...li.querySelectorAll(":scope > span")]
          .find((s) => s.textContent.trim()
            && !s.getAttribute("aria-hidden"));
        const range = document.createRange();

        range.selectNodeContents(label);

        const lines = new Set([...range.getClientRects()]
          .filter((r) => r.width > 1).map((r) => Math.round(r.top)));

        return { ...union(shown(li)), lines: lines.size,
          clipped: label.scrollWidth > label.clientWidth + 1 };
      }),
      card: { left: box.left, right: box.right, top: box.top,
        bottom: box.bottom },
      frame: { left: frame.left, right: frame.right, top: frame.top,
        bottom: frame.bottom },
      viewport: innerWidth,
    };
  });

// The rows the items fall into, by their tops, as counts per row.
const rows = (items) => {
  const out = [];

  for (const it of items) {
    const row = out.find((r) => Math.abs(r.top - it.top) <= 2
      || (it.top < r.bottom - 2 && it.bottom > r.top + 2));

    if (row) row.items.push(it);
    else out.push({ top: it.top, bottom: it.bottom, items: [it] });
  }

  return out.map((r) => r.items.length);
};

const shape = (items) => rows(items).join("+");

// In reading order: left to right in a row, rows top to bottom.
const inOrder = (items) => items.slice(1).every((b, i) => {
  const a = items[i];

  return b.top >= a.bottom - 2 || (Math.abs(b.top - a.top) <= 2
    && b.left >= a.right - 1);
});

const fits = (m) => {
  const sum = m.natural.reduce((s, w) => s + w, 0);
  const pair = Math.max(m.natural[0] + m.natural[1],
    m.natural[2] + m.natural[3]);

  return {
    row: sum + 3 * GAP <= m.room,
    noRow: sum > m.room,
    pair: pair + GAP <= m.room,
    noPair: pair > m.room,
  };
};

const sweep = async (page) => {
  const seen = [];

  await page.goto("/#map");
  for (const width of BELOW) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    await page.locator("#map .map-key-delivery").scrollIntoViewIfNeeded();

    const m = await measure(page);

    expect(m.card.top, `${width} px: the legend below the map`)
      .toBeGreaterThanOrEqual(m.frame.bottom - 1);
    seen.push({ width, m, fit: fits(m), shape: shape(m.items) });
  }

  return seen;
};

test.describe("the home map's legend below the map (#917)", () => {
  test("With the legend below the map and room for it, the four items "
    + "sit in one row", async ({ page }, info) => {
    desktopOnly(info);

    const seen = await sweep(page);

    for (const { width, m, fit, shape: s } of seen) {
      if (fit.row) {
        expect(s, `${width} px: room for a row, so one row`).toBe("4");
        expect(inOrder(m.items), `${width} px: in order`).toBe(true);
      }
    }
    expect(seen.some((w) => w.fit.row && w.shape === "4"),
      "one row at one width at least").toBe(true);
  });

  test("With less room they form two rows of two", async ({ page }, info) => {
    desktopOnly(info);

    const seen = await sweep(page);

    for (const { width, m, fit, shape: s } of seen) {
      if (fit.noRow && fit.pair) {
        expect(s, `${width} px: no room for a row, room for pairs`)
          .toBe("2+2");
        expect(inOrder(m.items), `${width} px: in order`).toBe(true);
      }
    }
    expect(seen.some((w) => w.fit.noRow && w.fit.pair && w.shape === "2+2"),
      "two rows of two at one width at least").toBe(true);
  });

  test("With the least room they stack, one to a row",
    async ({ page }, info) => {
      desktopOnly(info);

      const seen = await sweep(page);

      for (const { width, m, fit, shape: s } of seen) {
        if (fit.noPair) {
          expect(s, `${width} px: no room for pairs, so a stack`)
            .toBe("1+1+1+1");
          expect(inOrder(m.items), `${width} px: in order`).toBe(true);
        }
      }
      expect(seen.some((w) => w.fit.noPair && w.shape === "1+1+1+1"),
        "a stack at one width at least").toBe(true);
    });

  test("No item's text wraps or is cut off in any of the three, at 320, "
    + "390, 576 and 768 px", async ({ page }, info) => {
    desktopOnly(info);
    await page.goto("/#map");
    for (const width of WORDS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);

      const m = await measure(page);

      m.items.forEach((it, i) => {
        expect(it.lines, `${width} px: item ${i + 1} on one line`).toBe(1);
        expect(it.clipped, `${width} px: item ${i + 1} not cut off`)
          .toBe(false);
        expect(it.left, `${width} px: item ${i + 1} inside the legend`)
          .toBeGreaterThanOrEqual(m.card.left - 1);
        expect(it.right, `${width} px: item ${i + 1} inside the legend`)
          .toBeLessThanOrEqual(m.card.right + 1);
      });
      expect(m.card.left, `${width} px: the legend on the screen`)
        .toBeGreaterThanOrEqual(0);
      expect(m.card.right, `${width} px: the legend on the screen`)
        .toBeLessThanOrEqual(m.viewport);
    }
  });

  test("With the legend beside the map, on wide screens, it is as today",
    async ({ page }, info) => {
      desktopOnly(info);
      await page.goto("/#map");
      for (const width of [992, 1200, 1500]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(150);

        const m = await measure(page);

        expect(m.card.left, `${width} px: beside the map`)
          .toBeGreaterThanOrEqual(m.frame.right - 1);
        expect(m.card.top, `${width} px: beside the map, not below it`)
          .toBeLessThan(m.frame.bottom);
        expect(shape(m.items), `${width} px: one item to a row`)
          .toBe("1+1+1+1");
        expect(inOrder(m.items), `${width} px: in order`).toBe(true);
        for (const it of m.items) {
          expect(Math.abs(it.left - m.items[0].left),
            `${width} px: the swatches in one column`)
            .toBeLessThanOrEqual(1);
          expect(it.lines, `${width} px: each label on one line`).toBe(1);
        }
      }
    });
});
