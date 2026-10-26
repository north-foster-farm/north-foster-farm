// The order page's forms at every width James reviewed on 2026-09-24
// (.ignored/audits/2026-09-24/findings.md): about 1500, 1198 (just
// under xl), 990 (just under lg), 575 (just under sm) and the iPhone.
// Each test is one finding turned into a geometric check, so a
// regression shows as a number rather than a feeling. The cart's own
// checks are the cart-*.spec.mjs files (#477).
// docs/qa-launch.md, "The order page and cart".

import { OrderPage, expect, paymentFakes, test } from "./support/order.mjs";

const WIDTHS = [
  { width: 1500, height: 900 },
  { width: 1198, height: 900 },
  { width: 990, height: 800 },
  { width: 575, height: 800 },
  { width: 390, height: 664 },
];

const box = async (locator) => {
  const b = await locator.boundingBox();

  if (!b) throw new Error(`${locator} has no box`);

  return { ...b, right: b.x + b.width, bottom: b.y + b.height };
};

test.describe("contact form spacing", () => {
  for (const size of WIDTHS) {
    test(`${size.width}px: each label sits with its own field`, async ({
      page,
    }) => {
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open({ eggs: 1 });

      const first = await box(page.locator("label[for='customer-first-name']"));
      const firstField = await box(page.locator("#customer-first-name"));
      const last = await box(page.locator("label[for='customer-last-name']"));

      if (first.bottom <= firstField.y + 1) {
        // Stacked: the gap inside a group is smaller than between them.
        const inside = firstField.y - first.bottom;
        const between = last.y - firstField.bottom;

        expect(between).toBeGreaterThan(inside);
      }
    });
  }
});

test.describe("the card form", () => {
  for (const size of [WIDTHS[0], WIDTHS[1], WIDTHS[4]]) {
    test(`${size.width}px: the card box hugs Square's field`, async ({
      page, request,
    }) => {
      test.skip((await paymentFakes(request)).square,
        "Square's own card field; the stub SDK has none");
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open({ eggs: 1 });
      await order.method("onfarm");
      await order.openCard();

      const frame = page.locator("iframe[src*='single-card-element-iframe']");

      await expect(frame).toBeVisible();
      await page.waitForTimeout(800);

      const holder = await box(page.locator("[data-card]"));
      const field = await box(frame);
      // Square's own guidance line ("Enter your card number") sits
      // under the field; nothing but it should.
      const message = await box(page.locator("[data-card] .sq-card-message"));

      expect(message.y).toBeGreaterThanOrEqual(field.bottom - 1);
      expect(message.y - field.bottom).toBeLessThanOrEqual(16);
      expect(holder.bottom - message.bottom).toBeLessThanOrEqual(16);
      // One row of fields where there is room for it.
      if (size.width >= 576) expect(field.height).toBeLessThanOrEqual(60);
    });
  }

  for (const size of [WIDTHS[0], WIDTHS[4]]) {
    test(`${size.width}px: an empty card message takes no space`, async ({
      page, request,
    }) => {
      test.skip((await paymentFakes(request)).square,
        "Square's own card field; the stub SDK has none");
      await page.setViewportSize(size);

      const order = new OrderPage(page);

      await order.open({ eggs: 1 });
      await order.method("onfarm");
      await order.openCard();
      await expect(
        page.locator("iframe[src*='single-card-element-iframe']"),
      ).toBeVisible();
      await page.waitForTimeout(800);

      const message = page.locator("[data-card] .sq-card-message");

      // Whatever Square says, an empty line is flat; one with text keeps
      // its height.
      const text = (await message.textContent()).trim();
      const height = (await box(message)).height;

      if (text === "") expect(height).toBe(0);
      else expect(height).toBeGreaterThan(0);
    });
  }
});

// The sticky bar's scrollspy (#274, round 3): the category whose rows
// are under the bar is the one named, at phone, md and lg, scrolling
// up and down. Below lg the name is the sticky top bar's; from lg it
// is the sidebar's active link.
const PHONE = { width: 390, height: 844 };
const MD = { width: 768, height: 1024 };
const LG = { width: 1024, height: 768 };
const XL = { width: 1440, height: 900 };

// Walks the catalog down and back up in uneven steps and, at each
// stop, compares the name in view with the category of the first row
// showing under the bar (more than 8px of it).
const walk = (page) => page.evaluate(async () => {
  const frames = () => new Promise((done) => requestAnimationFrame(
    () => requestAnimationFrame(done)
  ));
  const catalog = document.getElementById("order-catalog");
  // Rows that show: an archived line is in the catalog, hidden, at the
  // end, and measuring it put the end above the top.
  const rows = [...catalog.querySelectorAll(".order-item")]
    .filter((el) => el.getClientRects().length);
  const top = catalog.getBoundingClientRect().top + scrollY;
  const end = rows.at(-1).getBoundingClientRect().bottom + scrollY;
  const stops = [];

  for (let y = top; y < end; y += 53) stops.push(y);
  for (let y = end; y > top; y -= 61) stops.push(y);

  const wrong = [];
  let checked = 0;

  for (const y of stops) {
    window.scrollTo({ top: y, behavior: "instant" });
    await frames();

    const bar = [...document.querySelectorAll(".order-topbar")]
      .find((el) => el.offsetParent);
    const stuck = bar && bar.getBoundingClientRect().top <= 0.5;
    const edge = stuck ? bar.getBoundingClientRect().bottom : 0;
    const row = rows.find((el) => el.getBoundingClientRect().bottom
      > edge + 8);

    if (!row || row.getBoundingClientRect().top > innerHeight) continue;
    if (bar && !stuck) continue;

    const want = row.closest(".order-cat")
      .querySelector(".order-cat-text").textContent.trim();
    const title = bar && bar.querySelector(".order-bar-title");
    const side = document.querySelector(".order-side-sub .nav-link.active");
    const seen = title
      ? title.textContent.trim()
      : side && side.textContent.trim();

    checked += 1;
    if (seen !== want || (title && !title.hasAttribute("data-cat"))) {
      wrong.push({ y: Math.round(y), want, seen });
    }
  }

  return { checked, wrong };
});

for (const [name, size] of [["phone", PHONE], ["md", MD], ["lg", LG]]) {
  test(`the bar names the category under it at ${name}`, async ({ page }) => {
    await page.setViewportSize(size);

    const order = new OrderPage(page);

    await order.open();

    const { checked, wrong } = await walk(page);

    expect(checked).toBeGreaterThan(20);
    expect(wrong).toEqual([]);
    // No heading carries the chevron: it may be off screen.
    await expect(page.locator(".order-cat .order-bar-chev, .order-cat-chev"))
      .toHaveCount(0);
  });
}

for (const [name, size] of [["phone", PHONE], ["md", MD]]) {
  test(`the bar never shows the page name at ${name} (#327)`, async ({
    page,
  }) => {
    await page.setViewportSize(size);

    const order = new OrderPage(page);

    await order.open();

    const title = page.locator(".order-topbar .order-bar-name");

    await expect(title).not.toHaveText(/Place an order/);
    await expect(title).toHaveText("");
    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect(title).not.toHaveText("");
    await expect(title).not.toHaveText(/Place an order/);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(title).toHaveText("");
  });
}

// The blank bar takes no room at the top of the page (#384): the
// switcher sits a section gap under the header, and the bar appearing
// moves nothing.
for (const width of [375, 390, 576, 768]) {
  test(`no empty band above the switcher at ${width} (#384)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });

    const order = new OrderPage(page);

    await order.open();

    const bar = page.locator(".order-topbar");
    const filter = page.locator(".order-filter");
    const gaps = await page.evaluate(() => {
      const header = document.querySelector("body > header, header");
      const filter = document.querySelector(".order-filter")
        .getBoundingClientRect();
      const title = document
        .querySelector(".order-cat:not([hidden]) .order-cat-title")
        .getBoundingClientRect();

      return {
        above: filter.top - header.getBoundingClientRect().bottom,
        below: title.top - filter.bottom,
      };
    });

    // The same room above the switcher as below it: 1.5rem each.
    expect(gaps.above).toBeCloseTo(24, 0);
    expect(gaps.below).toBeCloseTo(24, 0);
    expect(gaps.above).toBeCloseTo(gaps.below, 0);
    await expect(bar).toBeHidden();

    const before = (await filter.boundingBox()).y;

    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect(bar).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(bar).toBeHidden();
    expect((await filter.boundingBox()).y).toBe(before);
  });
}

// Checkout's alignment (#274, round 5).
test("Pay and its agreement sit right on a phone, left from md", async ({
  page,
}) => {
  const order = new OrderPage(page);

  for (const [size, side] of [[PHONE, "right"], [MD, "left"]]) {
    await page.setViewportSize(size);
    await order.open({ eggs: 1 });

    const seen = await page.locator(".order-submit").evaluate((el) => {
      const pay = el.querySelector("#order-submit");

      pay.hidden = false;

      const box = el.getBoundingClientRect();
      const r = pay.getBoundingClientRect();

      return {
        right: Math.abs(box.right - r.right) < 2,
        left: Math.abs(r.left - box.left) < 2,
        align: getComputedStyle(el.querySelector(".order-agree")).textAlign,
      };
    });

    expect(seen[side], `${size.width}px`).toBe(true);
    expect(seen.align, `${size.width}px`)
      .toMatch(side === "right" ? /right|end/ : /left|start/);
  }
});

test("every date dropdown is as wide as the fields", async ({ page }) => {
  const order = new OrderPage(page);

  for (const size of [MD, LG, XL]) {
    await page.setViewportSize(size);
    await order.open({ eggs: 1 }, { method: "delivery" });

    const [date, street] = await page.evaluate(() => [
      "#delivery-date", "#delivery-address1",
    ].map((s) => document.querySelector(s).offsetWidth));

    expect(date, `${size.width}px`).toBe(street);
  }
});
