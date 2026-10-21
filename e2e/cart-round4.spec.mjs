// Cart round 4 (#278): the first line clear of the top fade; the
// column easing to its new height; a tap on the toggle opening a hidden
// pane; the top bar over the cart; a phone on its side; one line of
// badges with "Free Delivery"; pack labels capitalized at render; the
// first Add's shorter dwell and three pairs of pulses. It sets its own
// sizes, and runs in WebKit too (the iphone project), where the first
// line's fault showed.

import { FULL_CART, OrderPage, expect, test } from "./support/order.mjs";

const SHORT = { width: 393, height: 600 };
const PHONE = { width: 390, height: 844 };
const SIDE = { width: 852, height: 340 };
const XL = { width: 1440, height: 900 };

// Only the phone sizes in WebKit; the column is Chromium's.
const phonesOnly = (testInfo) => test.skip(
  testInfo.project.name === "iphone", "a desktop size"
);

const addRow = async (order, name) => {
  const row = await order.showRow(name);

  await row.locator(".order-qty-add").click();
};

// The line was scrolled under the fade at the top of the list, and the
// strip kept for the "more" pills held it there (#278, item 1).
test("the first line stays clear of the top fade", async ({ page }) => {
  await page.setViewportSize(SHORT);

  const order = new OrderPage(page);

  await order.open();
  await addRow(order, "wings");
  await expect(order.cart.locator(".order-cart-item.is-new")).toHaveCount(1);
  await page.waitForTimeout(500);

  const state = await order.cart.evaluate((cart) => {
    const list = cart.querySelector("[data-cart-items]");
    const wrap = list.parentElement;

    return {
      scrollTop: list.scrollTop,
      top: wrap.hasAttribute("data-top"),
      strip: wrap.hasAttribute("data-scroll"),
      fits: list.scrollHeight <= list.clientHeight + 1,
    };
  });

  expect(state).toEqual({
    scrollTop: 0, top: false, strip: false, fits: true,
  });
});

test("the column eases to its new height", async ({ page }, testInfo) => {
  phonesOnly(testInfo);
  await page.setViewportSize(XL);

  const order = new OrderPage(page);

  await order.open({ eggs: 1 });

  const before = await order.cart.evaluate((el) => el.offsetHeight);

  await order.item("wings").locator(".order-qty-add").click();

  const eased = await order.cart.evaluate((el) => el.getAnimations()
    .some((a) => a.effect.getKeyframes().some((k) => k.height)));

  expect(eased).toBe(true);
  await expect.poll(() => order.cart.evaluate((el) => el.offsetHeight))
    .toBeGreaterThan(before);
  await expect.poll(() => order.cart.evaluate((el) => el.getAnimations()
    .length)).toBe(0);
});

for (const [part, toggle] of [
  ["money", "[data-cart-money-toggle]"],
  ["items", "[data-cart-items-toggle]"],
]) {
  test(`a tap on the toggle's ${part} side opens a hidden pane`, async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);

    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect(order.cart).toHaveAttribute("data-stuck", "true");
    if (await order.cart.getAttribute("data-open") === "true") {
      await order.cart.locator("[data-cart-toggle]").click();
    }
    await expect(order.cart).toHaveAttribute("data-open", "false");

    // From the side not showing, and from the side showing.
    await order.cart.locator(toggle).click();
    await expect(order.cart).toHaveAttribute("data-open", "true");
    await expect(order.cart).toHaveAttribute(`data-${part}`, "open");
    await order.cart.locator("[data-cart-toggle]").click();
    await expect(order.cart).toHaveAttribute("data-open", "false");
    await order.cart.locator(toggle).click();
    await expect(order.cart).toHaveAttribute("data-open", "true");
    await expect(order.cart).toHaveAttribute(`data-${part}`, "open");
  });
}

// The settled cart painted over the bar as it scrolled up, and the
// floating sheet rode over it (#278, item 4).
test("the top bar stays over the cart", async ({ page }) => {
  await page.setViewportSize(PHONE);

  const order = new OrderPage(page);

  await order.open(FULL_CART);

  // Floating and grown, the pane stops under the bar.
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect(order.cart).toHaveAttribute("data-stuck", "true");
  await page.waitForTimeout(500);

  const gap = await page.evaluate(() => {
    const bar = document.querySelector(".order-topbar");

    return document.getElementById("order-cart").getBoundingClientRect().top
      - bar.getBoundingClientRect().bottom;
  });

  expect(gap).toBeGreaterThanOrEqual(0);

  // Settled and scrolled up past the bar, the bar is on top.
  await page.locator("#order-cart-heading").evaluate((el) => {
    window.scrollTo({
      top: el.getBoundingClientRect().top + scrollY + 140,
      behavior: "instant",
    });
  });
  await expect(order.cart).toHaveAttribute("data-stuck", "false");

  const onTop = await page.evaluate(() => {
    const bar = document.querySelector(".order-topbar");
    const r = bar.getBoundingClientRect();
    const cart = document.getElementById("order-cart").getBoundingClientRect();
    const points = [
      [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2],
      [innerWidth / 2, r.bottom - 2],
    ];

    return {
      under: cart.top < r.bottom,
      hits: points.map(([x, y]) => bar.contains(
        document.elementFromPoint(x, y)
      )),
    };
  });

  expect(onTop).toEqual({ under: true, hits: [true, true, true] });
});

// A phone on its side was given the tablet's two columns (#278, item 5).
test.describe("a phone on its side", () => {
  test.use({ viewport: SIDE, isMobile: true, hasTouch: true });

  test("one tab filled, the foot on one row, the lines fill the height",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open(FULL_CART);
      await page.evaluate(() => window.scrollTo(0, 400));
      await expect(order.cart).toHaveAttribute("data-stuck", "true");
      if (await order.cart.getAttribute("data-open") !== "true") {
        await order.cart.locator("[data-cart-toggle]").click();
      }
      await order.cart.locator("[data-cart-items-toggle]").click();
      await page.waitForTimeout(500);

      const seen = await page.evaluate(() => {
        const cart = document.getElementById("order-cart");
        const q = (s) => cart.querySelector(s);
        const rect = (s) => q(s).getBoundingClientRect();
        const bar = document.querySelector(".order-topbar")
          .getBoundingClientRect();
        const on = [...cart.querySelectorAll(".order-cart-disclose")]
          .filter((b) => b.dataset.on === "true").length;
        const toggle = rect("[data-cart-toggle]");
        const next = rect("[data-checkout]");
        const box = cart.getBoundingClientRect();

        return {
          multi: q("[data-cart-seg]").hasAttribute("data-multi"),
          role: q("[data-cart-seg]").getAttribute("role"),
          on,
          row: Math.abs(toggle.top - next.top) < 4,
          beside: next.left - toggle.right >= 0
            && next.left - toggle.right < 24,
          right: box.right - next.right < 40,
          under: box.top - bar.bottom >= 0 && box.top - bar.bottom < 24,
          inView: box.bottom <= innerHeight,
          lines: rect(".order-cart-scroll").height,
          badges: q(".order-badges").offsetHeight,
        };
      });

      expect(seen).toMatchObject({
        multi: false, role: "tablist", on: 1, row: true, beside: true,
        right: true, under: true, inView: true, badges: 0,
      });
      expect(seen.lines).toBeGreaterThan(100);

      // The Total tab carries the sums, the badges, the way and the code.
      await order.cart.locator("[data-cart-money-toggle]").click();
      await expect(order.cart.locator(".order-badges")).toBeVisible();
      await expect(order.cart.locator("[data-way-toggle]")).toBeVisible();
    });
});

// "Delivery" lights at the minimum and "Free" at free delivery, on a
// pickup too (#278, item 6).
for (const [wings, delivery, free] of [
  [3, "false", "false"], [4, "true", "false"], [15, "true", "true"],
]) {
  test(`Free Delivery at $${wings * 10} on a pickup`, async ({ page }) => {
    await page.setViewportSize(PHONE);

    const order = new OrderPage(page);

    await order.open({ wings });
    await expect(order.cart.locator("[data-badge='delivery']"))
      .toHaveAttribute("data-on", delivery);
    await expect(order.cart.locator("[data-badge='free-delivery']"))
      .toHaveAttribute("data-on", free);
  });
}

// All but $200+ lit, the floating pane open: one line down to 320px.
for (const width of [320, 360, 390]) {
  test(`the lit badges keep one line at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });

    const order = new OrderPage(page);

    await order.open({ wings: 15, thighs: 4 });
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect(order.cart).toHaveAttribute("data-stuck", "true");
    if (await order.cart.getAttribute("data-open") !== "true") {
      await order.cart.locator("[data-cart-toggle]").click();
    }
    await expect(order.cart.locator("[data-badge='tier-150']"))
      .toHaveAttribute("data-on", "true");

    const seen = await order.cart.locator(".order-badges").evaluate((ul) => {
      const lis = [...ul.querySelectorAll("li")];

      return {
        lines: new Set(lis.map((li) => Math.round(li.getBoundingClientRect()
          .top))).size,
        over: ul.scrollWidth - ul.clientWidth,
        spare: ul.clientWidth - lis.reduce(
          (n, li) => n + li.getBoundingClientRect().width, 0
        ),
      };
    });

    expect({ lines: seen.lines, over: seen.over })
      .toEqual({ lines: 1, over: 0 });
    // Room to spare: Linux's Chromium rounds each letter to a whole
    // pixel, and wrapped the line where a Mac left 5.5px (#289).
    expect(seen.spare, "px to spare").toBeGreaterThanOrEqual(6);
  });
}

// No label on sale starts with a letter since 2026-v9 (#267), so this
// holds the figures as written; test/pack-label.test.mjs holds the
// capital.
test("pack labels show as the catalog writes them, in rows and lines",
  async ({ page }) => {
    await page.setViewportSize(PHONE);

    const order = new OrderPage(page);

    await order.open({
      wings: 1, "NFF-CHK-DRM-15-99": 1, "NFF-CHK-LVR-10-14": 1,
    });
    await expect(order.item("wings").locator("label"))
      .toHaveText("1.0 – 1.9 lbs");
    await expect(order.item("NFF-CHK-DRM-15-99").locator("label"))
      .toHaveText("1.5 lbs and up");
    await expect(order.cart.locator(".order-cart-item-name"))
      .toHaveText(["1.5 lbs and up", "1.0 – 1.9 lbs",
        "Livers, 1.0 – 1.4 lbs"]);

    // Other Items' lines take the item's own name, under the group's
    // heading (#267).
    await expect(order.cart.locator(".order-cart-group-name").last())
      .toHaveText("Other Items");
    await expect(order.cart.getByRole("button", {
      name: "Remove Livers, 1.0 – 1.4 lbs from the cart",
    })).toBeAttached();

  });

// Three pairs of pulses, 400ms apart within a pair and a second's rest
// between pairs; under reduced motion, a still emphasis (#278, item 8).
test("the teach pulse runs three pairs", async ({ page }) => {
  await page.setViewportSize(PHONE);

  const order = new OrderPage(page);

  await order.open();

  const teach = await page.evaluate(() => {
    const pill = document.querySelector("[data-cart-toggle]");

    pill.setAttribute("data-pulse", "teach");

    const [a] = pill.getAnimations();
    const peaks = a.effect.getKeyframes()
      .filter((k) => k.transform && k.transform !== "scale(1)")
      .map((k) => Math.round(k.offset * a.effect.getTiming().duration));

    pill.removeAttribute("data-pulse");

    return peaks;
  });

  expect(teach).toEqual([160, 560, 1960, 2360, 3760, 4160]);
});

test("under reduced motion the pill holds still", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.emulateMedia({ reducedMotion: "reduce" });

  const order = new OrderPage(page);
  const pill = order.cart.locator("[data-cart-toggle]");

  await order.open();
  await addRow(order, "wings");
  await expect(pill).toHaveAttribute("data-pulse", "teach", {
    timeout: 4_000,
  });

  // The pulse is a keyframe animation (a CSSAnimation, which names
  // its keyframes). The ring's own transition may still be running
  // as it comes on; WebKit counts it too, but nothing moves.
  const still = await pill.evaluate((el) => ({
    animations: el.getAnimations().filter((a) => "animationName" in a)
      .length,
    ring: getComputedStyle(el).boxShadow,
  }));

  expect(still.animations).toBe(0);
  expect(still.ring).not.toBe("none");
  await expect(pill).not.toHaveAttribute("data-pulse", /./, {
    timeout: 4_000,
  });
});
