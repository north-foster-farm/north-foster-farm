// Cart round 3 (#274): the scrollspy names the category whose rows
// are under the sticky bar; the Items/Total toggle keeps a phone's
// width and is plain text in the column; the badge row is back and
// the chicks leave the badge just earned; the total's flash stays
// light on the green; settled, the pane shows every line; empty, it
// shows only the way and the code. It sets its own widths.

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";

const PHONE = { width: 390, height: 844 };
const MD = { width: 768, height: 1024 };
const LG = { width: 1024, height: 768 };
const XL = { width: 1280, height: 800 };

// Walks the catalog down and back up in uneven steps and, at each
// stop, compares the name in view with the category of the first row
// showing under the bar (more than 8px of it). Below lg the name is
// the sticky top bar's; from lg it is the sidebar's active link.
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

// A panel's count and total are a readout, not a control (#274, round
// 6): cart-round6.spec.mjs.
test("a panel's count and total are plain text", async ({ page }) => {
  for (const size of [{ width: 600, height: 900 }, MD, LG]) {
    await page.setViewportSize(size);

    const order = new OrderPage(page);

    await order.open({ wings: 1 });
    await page.evaluate(() => window.scrollTo(0, 300));
    await expect(order.cart.locator("[data-cart-seg]"))
      .toHaveAttribute("data-plain", "");
  }
});

test("in the column the count and total are plain text", async ({ page }) => {
  await page.setViewportSize(XL);

  const order = new OrderPage(page);

  await order.open();

  const fills = await order.cart.locator(".order-cart-disclose").evaluateAll(
    (els) => els.map((el) => getComputedStyle(el).backgroundColor)
  );

  expect(fills).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
  await expect(order.cart.locator(".order-cart-seg-fill"))
    .toHaveCSS("opacity", "0");
});

// The new line's outline (#274, round 3) is gone since round 4;
// cart-added.spec.mjs checks that it stays gone.

test("the chicks leave the tier just earned", async ({ page }) => {
  await page.setViewportSize(PHONE);

  const order = new OrderPage(page);

  // $48: two dollars short of the first tier.
  await order.open({ wings: 4, eggs: 1 });
  await page.evaluate(() => window.scrollTo(0, 300));
  await order.scrollSettled();

  const hide = order.cart.locator("[data-cart-toggle]");

  if ((await hide.getAttribute("aria-expanded")) !== "true") {
    await hide.click();
  }

  const badge = order.cart.locator("[data-badge='tier-50']");

  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("data-on", "false");

  const b = await badge.boundingBox();

  // The row's Add under the open pane, pressed as a tap would.
  await order.item("drums").locator(".order-qty-add")
    .evaluate((el) => el.click());
  await expect(badge).toHaveAttribute("data-on", "true");

  // The canvas is a box around where the chicks start: 480 wide and
  // centered on it, 70% of its 360 above it, clamped to the screen
  // (celebrate.js).
  const box = await page.locator(".order-chicks").first().evaluate((c) => {
    const r = c.getBoundingClientRect();

    return { left: r.left, top: r.top };
  });
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;

  expect(Math.abs(box.left - Math.max(0, Math.round(x - 240))))
    .toBeLessThan(2);
  expect(Math.abs(box.top - Math.max(0, Math.round(y - 252))))
    .toBeLessThan(2);
});

test("the total's flash stays light on the green", async ({ page }) => {
  await page.setViewportSize(PHONE);

  const order = new OrderPage(page);

  await order.open({ wings: 1 });
  await page.evaluate(() => window.scrollTo(0, 300));

  const money = order.cart.getByRole("tab", { name: /^Total/ });

  await money.click();

  // The flash's peak, held there to read it.
  const peak = await order.total.evaluate((el) => {
    el.classList.add("is-bumped");

    const [a] = el.getAnimations();

    a.pause();
    a.currentTime = a.effect.getTiming().duration * 0.4;

    const color = getComputedStyle(el).color;

    a.cancel();

    return color;
  });
  const [r, g, b] = peak.match(/\d+/g).map(Number);

  // Light: a luminance well above the green under it.
  expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeGreaterThan(180);
});

test("settled, the pane shows every line", async ({ page }) => {
  for (const size of [PHONE, MD]) {
    await page.setViewportSize(size);

    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await page.locator("#order-cart-heading").evaluate(
      (el) => el.scrollIntoView({ block: "start" })
    );
    await order.scrollSettled();
    await expect(order.cart).toHaveAttribute("data-stuck", "false");

    const list = order.cart.locator("[data-cart-items]");
    const over = await list.evaluate((el) => el.scrollHeight - el.clientHeight);

    expect(over, `${size.width}px`).toBeLessThanOrEqual(1);
    await expect(order.cart.locator("[data-cart-more]")).toBeHidden();

    // Continue is as wide as its words.
    const next = await order.next.evaluate((el) => {
      const range = document.createRange();

      range.selectNodeContents(el);

      return el.offsetWidth - range.getBoundingClientRect().width;
    });

    expect(next).toBeLessThan(5 * 16);
  }
});

test("empty, the pane shows the way and the code only", async ({ page }) => {
  for (const size of [PHONE, MD, XL]) {
    await page.setViewportSize(size);

    const order = new OrderPage(page);

    // The last width's Add is in the saved draft: start empty.
    await page.evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch { /* */ }
    });
    await order.open();
    await page.evaluate(() => window.scrollTo(0, 300));

    const hide = order.cart.locator("[data-cart-toggle]");

    if (await hide.isVisible()
      && (await hide.getAttribute("aria-expanded")) !== "true") {
      await hide.click();
    }
    await expect(order.subtotal, `${size.width}px`).toBeHidden();
    await expect(order.cart.locator(".order-badges")).toBeHidden();
    await expect(order.cart.locator("[data-way-toggle]")).toBeVisible();
    await expect(order.codeOpen).toBeVisible();

    // No room left above the total row.
    const gap = await order.cart.evaluate((el) => (
      el.querySelector(".order-cart-total-row").getBoundingClientRect().top
        - el.getBoundingClientRect().top
    ));

    expect(gap, `${size.width}px`).toBeLessThan(2 * 16);

    await (await order.showRow("wings")).locator(".order-qty-add").click();
    await expect(order.cart).not.toHaveAttribute("data-empty", "");
  }
});

test("the rule under the total row is like the others", async ({ page }) => {
  await page.setViewportSize(PHONE);

  const order = new OrderPage(page);

  await order.open({ wings: 1 });

  const look = (sel) => order.cart.locator(sel).first().evaluate((el) => {
    const css = getComputedStyle(el);

    return [css.borderTopWidth, css.borderTopColor];
  });

  expect(await look(".order-cart-rule-dark"))
    .toEqual(await look(".order-cart-rule-end"));
});
