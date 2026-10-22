// Cart round 4 (#278): the first line clear of the top fade; the
// column easing to its new height; a tap on the toggle opening a hidden
// pane; the top bar over the cart; a phone on its side; one line of
// badges; pack labels capitalized at render; the first Add's dwell and
// three pairs of pulses; and from #274 round 4, nothing riding along
// on a short screen. It sets its own sizes, and runs in WebKit too
// (the iphone project), where the first line's fault showed.

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
  await expect(order.cart.locator(".order-cart-item")).toHaveCount(1);
  await expect(order.cart).toHaveAttribute("data-open", "true");
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

// A phone on its side was given the tablet's two columns (#278, item
// 5). Since #274 round 4 its cart no longer floats (see "nothing rides
// along" below); settled, it keeps the phone's one column: the lines
// over the sums, the sums over the badges, the way and the code.
test.describe("a phone on its side", () => {
  test.use({ viewport: SIDE, isMobile: true, hasTouch: true });

  test("the settled cart keeps one column", async ({ page }) => {
    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await page.evaluate(() => {
      document.getElementById("order-cart-heading")
        .scrollIntoView({ block: "start" });
    });
    await order.scrollSettled();
    await expect(order.cart).toHaveAttribute("data-stuck", "false");

    const seen = await page.evaluate(() => {
      const cart = document.getElementById("order-cart");
      const rect = (s) => cart.querySelector(s).getBoundingClientRect();
      const list = rect("#order-cart-list");
      const money = rect("#order-cart-money");
      const badges = rect(".order-badges");

      return {
        stacked: list.bottom <= money.top + 1
          && money.bottom <= badges.top + 1,
        wide: list.width > cart.getBoundingClientRect().width * 0.8,
      };
    });

    expect(seen).toEqual({ stacked: true, wide: true });
    await expect(order.cart.locator(".order-badges")).toBeVisible();
    await expect(order.cart.locator("[data-way-toggle]")).toBeVisible();
  });
});

// "Delivery" lights at the minimum and "Free delivery" at the waiver,
// each a badge of its own, on a pickup too (#278, item 6; two badges
// since #274 round 4).
for (const [wings, delivery, free] of [
  [3, "false", "false"], [4, "true", "false"], [15, "true", "true"],
]) {
  test(`the delivery badges at $${wings * 10} on a pickup`, async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);

    const order = new OrderPage(page);

    await order.open({ wings });
    await expect(order.cart.locator("[data-badge='delivery']"))
      .toHaveAttribute("data-on", delivery);
    await expect(order.cart.locator("[data-badge='free-delivery']"))
      .toHaveAttribute("data-on", free);
  });
}

// All but $200+ lit, the floating pane open. One line where it fits
// with room to spare; with "Delivery" and "Free delivery" two badges
// again (#274 round 4), a phone up to 414px puts the tiers on a second
// line, the delivery badges on the first.
for (const width of [320, 360, 390, 414, 430]) {
  const lines = width >= 430 ? 1 : 2;

  test(`the lit badges take ${lines} line(s) at ${width}px`, async ({
    page,
  }) => {
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
      const lis = [...ul.querySelectorAll("li")]
        .filter((li) => li.getBoundingClientRect().height > 0);
      const top = (li) => Math.round(li.getBoundingClientRect().top);
      const tops = [...new Set(lis.map(top))];
      const row = (t) => lis.filter((li) => top(li) === t);

      return {
        lines: tops.length,
        first: row(tops[0]).map((li) => li.textContent.trim()),
        over: ul.scrollWidth - ul.clientWidth,
        spare: Math.min(...tops.map((t) => ul.clientWidth - row(t).reduce(
          (n, li) => n + li.getBoundingClientRect().width, 0
        ))),
      };
    });

    expect({ lines: seen.lines, over: seen.over }).toEqual({ lines, over: 0 });
    if (lines === 2) expect(seen.first).toEqual(["Delivery", "Free delivery"]);
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
  // After the pane's 3.5 s on the new line (TEACH_DWELL, #274).
  await expect(pill).toHaveAttribute("data-pulse", "teach", {
    timeout: 6_000,
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

// #274, round 4: 500px tall or less, at any width, nothing rides
// along. The cart never floats; it sits where it settles, and the top
// bar scrolls away with the page. An iPhone on its side, Safari's bar
// shown (340) or not (390), the tallest one (430), and a short laptop
// window; one pixel over the line, it floats as before.
const SHORT_SIZES = [
  { width: 844, height: 340 },
  { width: 844, height: 390 },
  { width: 932, height: 430 },
  { width: 1280, height: 480 },
];

const midCatalog = async (order) => {
  await order.item("thighs").evaluate(
    (el) => el.scrollIntoView({ block: "center" })
  );
  await order.scrollSettled();
};

for (const size of SHORT_SIZES) {
  test(`at ${size.width} x ${size.height} nothing rides along`, async ({
    page,
  }) => {
    await page.setViewportSize(size);

    const order = new OrderPage(page);

    await order.open(FULL_CART);
    await midCatalog(order);

    const state = await page.evaluate(() => {
      const cart = document.getElementById("order-cart");
      const bar = document.querySelector(".order-topbar");
      const r = cart.getBoundingClientRect();

      return {
        position: getComputedStyle(cart).position,
        onScreen: r.top < innerHeight && r.bottom > 0,
        bar: bar.offsetParent ? getComputedStyle(bar).position : "hidden",
        barOnScreen: bar.getBoundingClientRect().bottom > 0,
      };
    });

    expect(state.position).not.toBe("sticky");
    expect(state.onScreen).toBe(false);
    expect(state.bar).not.toBe("sticky");
    expect(state.barOnScreen).toBe(false);
    await expect(order.cart).not.toHaveAttribute("data-stuck", "true");
  });
}

test("at 501px tall the cart floats again", async ({ page }, testInfo) => {
  phonesOnly(testInfo);
  await page.setViewportSize({ width: 844, height: 501 });

  const order = new OrderPage(page);

  await order.open(FULL_CART);
  await midCatalog(order);
  await expect(order.cart).toHaveAttribute("data-stuck", "true");
});
