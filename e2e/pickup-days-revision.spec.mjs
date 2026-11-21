// Criteria tests for the revision of #703 that James asked for after
// his staging review on his phone (2026-11-21, 06:57: "Too crunched."),
// written before the change from the issue's section "Revision from
// James's staging review" and its five new "Done when" boxes; one test
// per box, named for it word for word. The pickup-days layout itself,
// and what its parts are called (.order-pickup-day, .order-pickup,
// .order-pickup-name, -time, -place, -street, -city, Copy and Map),
// are those of e2e/pickup-days.spec.mjs.
//
// Held out of every run by its name (playwright.config.mjs matches
// *.spec.mjs). The change that meets the revision turns it on with
//
//   git mv e2e/pickup-days-revision.criteria.mjs \
//     e2e/pickup-days-revision.spec.mjs
//
// and maps it in e2e/dispatch.json wherever pickup-days.spec.mjs is.
//
// Sizes are read from the rendered styles and compared with the page's
// own references (the date heading, the Pickup days card's "When" row,
// a button as Bootstrap's btn-sm draws it), never with fixed pixels.
// Everything is measured at phone width, 390 px, where James saw it,
// and the flush test at a desktop width too.

import {
  OrderPage, expect, test,
} from "./support/order.mjs";
import {
  DROP, FOSTER, cannedScheduled, datesWith,
} from "./support/scheduled.mjs";

const PHONE = { width: 390, height: 844 };
const WIDE = { width: 1500, height: 900 };

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

const fontSize = (locator) => locator.evaluate(
  (el) => parseFloat(getComputedStyle(el).fontSize)
);

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

// How far past each side of its box an element draws its outline, and
// whether it draws one in the form's invalid color.
const outlineOf = (locator) => locator.evaluate((el) => {
  const s = getComputedStyle(el);
  const probe = document.createElement("span");

  probe.style.color = "var(--bs-form-invalid-border-color)";
  el.append(probe);

  const invalid = getComputedStyle(probe).color;

  probe.remove();

  const drawn = s.outlineStyle !== "none"
    && parseFloat(s.outlineWidth) > 0;
  const shadow = s.boxShadow !== "none" && s.boxShadow.includes(invalid);

  return {
    marked: (drawn && s.outlineColor === invalid) || shadow
      || s.borderTopColor === invalid,
    past: drawn
      ? parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth) : 0,
  };
});

// The left and right edges of the region an element can draw in: the
// viewport, cut by every ancestor that clips its overflow sideways.
const clipOf = (locator) => locator.evaluate((el) => {
  let left = 0;
  let right = document.documentElement.clientWidth;

  for (let a = el.parentElement; a; a = a.parentElement) {
    const s = getComputedStyle(a);

    if (s.overflowX !== "visible" || s.contain.includes("paint")) {
      const r = a.getBoundingClientRect();

      left = Math.max(left, r.left + parseFloat(s.borderLeftWidth));
      right = Math.min(right, r.right - parseFloat(s.borderRightWidth));
    }
  }
  return { left, right };
});

test.describe("pickup days, James's revision (#703)", () => {
  test("The validation outline and message show in full at 390 px, " +
    "with nothing clipped on the left or right", async ({ page }) => {
    const order = await openPickups(page);

    // Paying without a choice marks the pickups and says so.
    await order.contact({ email: "unclipped@example.com" });
    await order.openCard();
    await order.card();
    await order.submit.click();

    const pickups = page.locator("#scheduled-pickups");
    const message = page.locator("#err-scheduled-date");

    await expect(pickups).toHaveClass(/\bis-invalid\b/);
    await expect(message).toHaveText("Choose a pick-up day and place.");
    await expect(message).toBeVisible();
    await order.scrollSettled();

    const outline = await outlineOf(pickups);

    expect(outline.marked, "the pickups are outlined in red").toBe(true);

    const at = await box(pickups);
    const clip = await clipOf(pickups);

    expect(at.x - outline.past, "the outline's left edge shows")
      .toBeGreaterThanOrEqual(clip.left - 0.5);
    expect(at.right + outline.past, "the outline's right edge shows")
      .toBeLessThanOrEqual(clip.right + 0.5);

    const said = await box(message);
    const room = await clipOf(message);

    expect(said.x, "the message's left edge shows")
      .toBeGreaterThanOrEqual(room.left - 0.5);
    expect(said.right, "the message's right edge shows")
      .toBeLessThanOrEqual(room.right + 0.5);
    expect(await message.evaluate((el) => el.scrollWidth - el.clientWidth),
      "the message's text fits its box").toBeLessThanOrEqual(0);
  });

  test("The choices sit flush under their date heading, with no left " +
    "indent", async ({ page }) => {
    const order = await openPickups(page);

    for (const size of [PHONE, WIDE]) {
      await page.setViewportSize(size);
      await order.scrollSettled();

      const days = page.locator("#scheduled-pickups .order-pickup-day");

      await expect(days).toHaveCount(3);
      for (const day of await days.all()) {
        const head = await box(day.getByRole("heading"));
        const pickups = day.locator(".order-pickup");

        await expect(pickups.first()).toBeVisible();
        for (const pickup of await pickups.all()) {
          const at = await box(pickup);

          expect(Math.abs(at.x - head.x), `indent at ${size.width}px`)
            .toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test("The card's text is smaller than the date heading and larger " +
    "than the fulfillment method card's \"When\", \"Where\", \"Cost\" " +
    "text", async ({ page }) => {
    const lists = grouped();

    await openPickups(page, lists);

    const facts = page.locator("[data-scheduled-facts]");
    const labels = [];

    for (const name of ["When", "Where", "Cost"]) {
      const row = facts.locator("dt", { hasText: name });

      await expect(row).toBeVisible();
      labels.push(await fontSize(row));
    }

    const small = Math.max(...labels);
    const home = page.locator("#scheduled-pickups");
    const heading = await fontSize(home.locator(".order-pickup-day")
      .first().getByRole("heading"));

    expect(heading, "the heading is larger than the When row")
      .toBeGreaterThan(small);
    for (const series of [DROP.series, FOSTER.series]) {
      const pickup = card(home, first(lists, series));
      // Not the name: the second revision sets it in the date
      // heading's font ("The pickup's name line has the date heading's
      // font family, size and weight", pickup-days-revision-2).
      const parts = [".order-pickup-time", ".order-pickup-street",
        ".order-pickup-city"];

      if (series === FOSTER.series) parts.push(".order-pickup-place");
      for (const part of parts) {
        const size = await fontSize(pickup.locator(part));

        expect(size, `${part} smaller than the date heading`)
          .toBeLessThan(heading);
        expect(size, `${part} larger than the When row`)
          .toBeGreaterThan(small);
      }
    }
  });

  test("The card shows three groups, the name, the time and the " +
    "address, with tighter line height inside each and more space " +
    "between them than inside them", async ({ page }) => {
    const lists = grouped();

    await openPickups(page, lists);

    const home = page.locator("#scheduled-pickups");
    const body = await page.evaluate(() => {
      const s = getComputedStyle(document.body);

      return parseFloat(s.lineHeight) / parseFloat(s.fontSize);
    });

    for (const series of [DROP.series, FOSTER.series]) {
      const pickup = card(home, first(lists, series));
      const address = series === FOSTER.series
        ? [".order-pickup-place", ".order-pickup-street",
          ".order-pickup-city"]
        : [".order-pickup-street", ".order-pickup-city"];
      const groups = [[".order-pickup-name"], [".order-pickup-time"],
        address];

      // Tighter: each part's line height below the page's own.
      for (const part of groups.flat()) {
        const ratio = await pickup.locator(part).evaluate((el) => {
          const s = getComputedStyle(el);

          return parseFloat(s.lineHeight) / parseFloat(s.fontSize);
        });

        expect(ratio, `${part}'s line height, tighter than the page's`)
          .toBeLessThan(body - 0.01);
      }

      // The lines of each group, top to bottom.
      const lines = [];

      for (const group of groups) {
        const of = [];

        for (const part of group) {
          of.push(...await glyphLines(pickup.locator(part)));
        }
        expect(of.length, `${group.join(" ")} shows`)
          .toBeGreaterThanOrEqual(1);
        lines.push(of);
      }

      const inside = lines.flatMap((of) => of.slice(1)
        .map((line, i) => line.top - of[i].bottom));
      const between = lines.slice(1)
        .map((of, i) => of[0].top - lines[i].at(-1).bottom);

      expect(inside.length, "the address has more than one line")
        .toBeGreaterThanOrEqual(1);
      for (const [i, gap] of between.entries()) {
        expect(gap, `space after group ${i + 1}, more than inside one`)
          .toBeGreaterThan(Math.max(...inside) + 1);
      }
      // The groups are in order: name, time, address.
      for (const gap of between) {
        expect(gap, "each group below the one before")
          .toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("Copy and Map are shorter than today's buttons, each with an " +
    "icon before its text, and Map's icon is the same \"opens in a new " +
    "tab\" icon the card's \"map\" link uses; Map opens in a new tab",
  async ({ page }) => {
    const lists = grouped();

    await openPickups(page, lists);

    // Today's buttons: Bootstrap's small outline button, as the page
    // draws one outside the pickups.
    const today = await page.evaluate(() => {
      const b = document.createElement("button");

      b.className = "btn btn-sm btn-outline-primary";
      b.type = "button";
      b.textContent = "Copy";
      document.querySelector("main, body").append(b);

      const height = b.getBoundingClientRect().height;

      b.remove();

      return height;
    });

    // The "map" link's icon, on the Pickup days card's Where row.
    const shapes = (svg) => svg.evaluate((el) => [...el.querySelectorAll(
      "path, line, polyline, polygon, circle, rect"
    )].map((s) => [s.tagName, ...[...s.attributes]
      .filter((a) => !["class", "style"].includes(a.name))
      .map((a) => `${a.name}=${a.value}`).sort()].join(" ")));
    const linkIcon = page.locator("[data-scheduled-where] a svg");

    await expect(linkIcon).toHaveCount(1);

    const newTab = await shapes(linkIcon);

    expect(newTab.length, "the map link's icon has shapes")
      .toBeGreaterThan(0);

    const home = page.locator("#scheduled-pickups");
    const pickups = home.locator(".order-pickup");

    await expect(pickups).toHaveCount(lists.scheduled.length);
    for (const pickup of await pickups.all()) {
      const copy = pickup.getByRole("button", { name: "Copy" });
      const map = pickup.getByRole("link", { name: /^Map\b/ });

      for (const [name, control] of [["Copy", copy], ["Map", map]]) {
        await expect(control).toBeVisible();
        expect((await box(control)).height, `${name} shorter than today`)
          .toBeLessThan(today - 1);

        // An icon, hidden from screen readers, before the text.
        const icon = control.locator("svg");

        await expect(icon, `${name} has one icon`).toHaveCount(1);
        await expect(icon).toBeVisible();
        await expect(icon).toHaveAttribute("aria-hidden", "true");

        const order = await control.evaluate((el) => {
          const svg = el.querySelector("svg");
          const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let text = null;

          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            if (n.textContent.trim()
              && !n.parentElement.closest(".visually-hidden")) {
              text = n;
              break;
            }
          }

          const range = document.createRange();

          range.selectNodeContents(text);

          return {
            text: text.textContent.trim(),
            icon: svg.getBoundingClientRect().right,
            start: range.getBoundingClientRect().left,
          };
        });

        expect(order.text).toBe(name);
        expect(order.icon, `${name}'s icon before its text`)
          .toBeLessThanOrEqual(order.start + 0.5);
      }

      expect(await shapes(map.locator("svg")),
        "Map's icon is the map link's").toEqual(newTab);
    }

    // Map opens in a new tab, and the order page stays.
    const map = card(home, first(lists, DROP.series))
      .getByRole("link", { name: /^Map\b/ });

    await expect(map).toHaveAttribute("target", "_blank");

    const [tab] = await Promise.all([
      page.context().waitForEvent("page"),
      map.click(),
    ]);

    await tab.waitForLoadState("domcontentloaded");
    expect(new URL(tab.url()).pathname).toBe("/");
    expect(new URL(page.url()).pathname).toBe("/order/");
    await tab.close();
  });
});
