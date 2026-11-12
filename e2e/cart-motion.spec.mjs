// The phone sheet's motion, frame by frame (#559, #569), in WebKit at
// iPhone size: the measurement plan James agreed on 2026-11-11. Each
// transition (add, remove, clear, Expand, Hide, the minimize on a
// scroll, the settle and the lift-off) is recorded on every animation
// frame: the boxes of the pane, the items list, the sums, the total row
// and the foot, the list's scroll and its fades. Every frame is held
// to the plan's rules, and a failure prints the frames around it, so
// the report reads like a timeline:
//
// - no part overlaps another or leaves the pane;
// - the total row never leaves the pane, and the pane is never empty
//   white (it is never taller than its parts);
// - the pane's height moves one way only during a transition;
// - every part starts moving within one frame of the others and keeps
//   the same share of its way as the others on every frame;
// - the list does not change while the page scrolls and the cart does
//   not.
//
// A person's scroll is a touch on the catalog and the page moving
// under it a frame at a time: Playwright's WebKit has no touch drag,
// and the cart reads only where the touch began (view.mjs
// watchScroll). Safari's toolbar is a visual viewport made shorter.
// Runs in the iphone project only.

import {
  OrderPage, SKU, expect, paneStill, test, unfoldCart,
} from "./support/order.mjs";

test.skip(({ browserName }) => browserName !== "webkit",
  "WebKit at iPhone size, #559");

// Two lines, so a third has room to come and the list does not scroll.
const SMALL = { eggs: 2, wings: 1 };
// A list long enough to scroll inside its cap, with fades.
const LONG = {
  eggs: 3, wings: 4, thighs: 3, drums: 2, breasts: 2, sausage: 2, necks: 4,
  whole: 2,
};

// A pixel of rounding on every comparison, as the other cart specs.
const PX = 1;

test.beforeEach(async ({ page }) => {
  // The first Add's lesson (#278) has its own spec: here every Add is
  // a later one.
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem("nff-cart-first-add", "1");
    } catch {
      // Blocked storage: the lesson runs, and its own spec covers it.
    }
  });
});

// Starts recording a frame on every requestAnimationFrame.
const record = (page) => page.evaluate(() => {
  const pane = document.getElementById("order-cart");
  const q = (s) => pane.querySelector(s);
  const box = (el) => {
    if (!el || !el.getClientRects().length) return null;

    const r = el.getBoundingClientRect();

    return {
      top: r.top, bottom: r.bottom, left: r.left, right: r.right,
      height: r.height,
    };
  };
  const frames = [];
  const tick = () => {
    const s = getComputedStyle(pane);
    const list = q("[data-cart-items]");
    const wrap = q("[data-cart-scroll]");
    const body = q("[data-cart-body]");
    const badge = q("[data-badge='delivery']");
    const tip = document.querySelector(".tooltip");

    frames.push({
      fold: pane.dataset.fold,
      placement: pane.dataset.placement,
      kept: pane.hasAttribute("data-kept"),
      y: scrollY,
      pane: box(pane),
      pad: {
        top: parseFloat(s.paddingTop) + parseFloat(s.borderTopWidth),
        bottom: parseFloat(s.paddingBottom) + parseFloat(s.borderBottomWidth),
      },
      body: box(body),
      bodyOver: body.scrollHeight > body.clientHeight + 1,
      parts: Array.from(body.children).map(box).filter((b) => b && b.height),
      lines: box(q("[data-part='lines']")),
      list: box(list),
      listTop: list.scrollTop,
      fades: ["data-scroll", "data-top", "data-more"]
        .map((a) => wrap.hasAttribute(a)).join(),
      total: box(q("[data-part='total']")),
      foot: box(q("[data-part='foot']")),
      strip: box(q("[data-cart-added-box]")),
      badge: box(badge),
      tip: box(tip),
    });
    window.cartTick = requestAnimationFrame(tick);
  };

  window.cartFrames = frames;
  window.cartTick = requestAnimationFrame(tick);
});

// Stops recording, a few still frames after the pane is at rest.
const recorded = async (page, order) => {
  await paneStill(order.cart);
  await page.evaluate(() => new Promise((done) => {
    let n = 0;
    const wait = () => (++n > 8 ? done() : requestAnimationFrame(wait));

    requestAnimationFrame(wait);
  }));

  return page.evaluate(() => {
    cancelAnimationFrame(window.cartTick);

    return window.cartFrames;
  });
};

// A person's scroll: a touch on the catalog, `by` px a frame at a time,
// `step` px a frame, and the finger lifted. In the page.
const swipe = (page, by, { step = 6, toolbar = false } = {}) => page.evaluate(
  ({ by: total, step: px, toolbar: bar }) => new Promise((done) => {
    const target = document.querySelector(".order-item");
    const visual = window.visualViewport;
    let moved = 0;
    let n = 0;

    // Safari's toolbar, shown and hidden every few frames: a visual
    // viewport 50px shorter, under the keyboard's 120.
    const toolbar = (shown) => {
      if (!bar || !visual) return;
      Object.defineProperty(visual, "height", {
        configurable: true,
        get: () => window.innerHeight - (shown ? 50 : 0),
      });
      visual.dispatchEvent(new Event("resize"));
    };

    target.dispatchEvent(new Event("touchstart", { bubbles: true }));
    const frame = () => {
      n += 1;
      if (n % 4 === 0) toolbar(n % 8 === 0);
      if (Math.abs(moved) >= Math.abs(total)) {
        target.dispatchEvent(new Event("touchend", { bubbles: true }));
        if (bar && visual) delete visual.height;
        done();

        return;
      }

      const d = Math.sign(total)
        * Math.min(px, Math.abs(total) - Math.abs(moved));

      window.scrollBy(0, d);
      moved += d;
      requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
  }), { by, step, toolbar }
);

// The page scrolls itself, `by` px in `step`s a frame, with no touch.
const glide = (page, by, step) => page.evaluate(
  ({ by: total, step: px }) => new Promise((done) => {
    let moved = 0;
    const frame = () => {
      if (Math.abs(moved) >= Math.abs(total)) {
        done();

        return;
      }

      const d = Math.sign(total)
        * Math.min(px, Math.abs(total) - Math.abs(moved));

      window.scrollBy(0, d);
      moved += d;
      requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
  }), { by, step }
);

// A frame as a line of the timeline: whole pixels.
const r = (b) => (b ? `${Math.round(b.top)}..${Math.round(b.bottom)}` : "-");
const line = (f, i) => `#${i} ${f.placement}/${f.fold} y=${Math.round(f.y)}`
  + ` pane ${r(f.pane)} lines ${r(f.lines)} total ${r(f.total)}`
  + ` foot ${r(f.foot)} list ${r(f.list)}@${Math.round(f.listTop)}`
  + ` fades ${f.fades}`;
const timeline = (frames, at) => frames
  .slice(Math.max(0, at - 3), at + 4)
  .map((f, k) => line(f, Math.max(0, at - 3) + k)).join("\n");

const fail = (name, frames, at, why) => {
  throw new Error(`${name}: ${why} at frame ${at}\n${timeline(frames, at)}`);
};

const inside = (b, pane) => b.top >= pane.top - PX
  && b.bottom <= pane.bottom + PX;

// The rules every frame keeps, at rest and in motion.
const holdsEveryFrame = (name, frames) => {
  frames.forEach((f, i) => {
    const no = (why) => fail(name, frames, i, why);

    if (!f.pane || !f.total || !f.foot) no("a part is gone");
    if (!inside(f.total, f.pane)) no("the total row left the pane");
    if (!inside(f.foot, f.pane)) no("the foot left the pane");
    if (f.total.bottom > f.foot.top + PX) {
      fail(name, frames, i, "the total row overlaps the foot");
    }
    // The body's parts in order, none over the next.
    f.parts.forEach((p, k) => {
      if (k && p.top < f.parts[k - 1].bottom - PX) {
        fail(name, frames, i, `part ${k} overlaps the one above it`);
      }
    });
    // Never empty white: no room between the last part and the foot,
    // or under the foot's strip, or, the body unscrolled, above the
    // first part.
    const last = f.parts[f.parts.length - 1];
    const end = f.strip ? f.strip.bottom : f.foot.bottom;

    const gap = last ? f.foot.top - last.bottom : 0;

    if (gap > 2 * PX && !f.bodyOver) {
      no(`${Math.round(gap)}px of empty pane over the foot`);
    }
    if (f.pane.bottom - end - f.pad.bottom > 2 * PX) {
      fail(name, frames, i, "empty pane under the foot");
    }
    if (f.parts[0] && !f.bodyOver
      && f.parts[0].top - f.pane.top - f.pad.top > 2 * PX) {
      fail(name, frames, i, "empty pane over the first part");
    }
  });
};

// The frames in which anything moved, with one still frame each side.
const motion = (frames) => {
  const key = (f) => [f.pane, f.total, f.foot, f.lines]
    .map((b) => (b ? `${Math.round(b.top)},${Math.round(b.bottom)}` : "-"))
    .join("|");
  let first = -1;
  let last = -1;

  for (let i = 1; i < frames.length; i += 1) {
    if (key(frames[i]) !== key(frames[i - 1])) {
      if (first < 0) first = i - 1;
      last = i;
    }
  }

  return first < 0 ? [] : frames.slice(first, last + 1);
};

// The pane's height one way, the parts together: each series that
// moves more than 4px starts within a frame of the others, and on every
// frame has gone the same share of its way as the others, give or take
// a fifth. Measured from the pane's resting edge, its foot, so a
// scroll under a floating pane changes nothing.
const movesTogether = (name, frames) => {
  const moved = motion(frames);

  if (moved.length < 3) return;

  const heights = moved.map((f) => f.pane.height);
  const way = Math.sign(heights[heights.length - 1] - heights[0]);

  heights.forEach((h, i) => {
    if (i && way && (h - heights[i - 1]) * way < -PX) {
      fail(name, moved, i, "the pane's height turned back");
    }
  });

  const series = {
    paneTop: (f) => f.pane.bottom - f.pane.top,
    total: (f) => f.pane.bottom - f.total.top,
    foot: (f) => f.pane.bottom - f.foot.top,
    lines: (f) => (f.lines ? f.lines.height : 0),
  };
  const movers = Object.entries(series).map(([label, at]) => {
    const values = moved.map(at);

    return { label, values, from: values[0], to: values[values.length - 1] };
  }).filter((s) => Math.abs(s.to - s.from) > 4);

  if (movers.length < 2) return;

  const each = (values) => movers
    .map((s, k) => `${s.label} ${values[k]}`).join(", ");
  const starts = movers.map((s) => s.values
    .findIndex((v) => Math.abs(v - s.from) > 0.5));

  if (Math.max(...starts) - Math.min(...starts) > 1) {
    fail(name, moved, Math.max(...starts),
      `the parts started apart (${each(starts)})`);
  }
  moved.forEach((f, i) => {
    const shares = movers
      .map((s) => (s.values[i] - s.from) / (s.to - s.from));

    if (Math.max(...shares) - Math.min(...shares) > 0.2) {
      fail(name, moved, i, "the parts moved apart "
        + `(${each(shares.map((v) => v.toFixed(2)))})`);
    }
  });
};

const transition = (name, frames) => {
  holdsEveryFrame(name, frames);
  movesTogether(name, frames);
};

// The cart floating over the catalog: ?add= settles it in the page,
// and the scroll back up, to halfway, lifts it off closed. The tests
// scroll a few hundred pixels either way from there and come back, so
// the cart never reaches its place or the page's top.
const floating = async (page, cart) => {
  const order = new OrderPage(page);

  await order.open(cart);
  await order.scrollSettled();
  const room = await page.evaluate(() => {
    const half = Math.round(window.scrollY / 2);

    window.scrollTo(0, half);

    return half;
  });

  test.skip(room < 600, "the catalog is too short to scroll in");
  await order.scrollSettled();
  await expect(order.cart).toHaveAttribute("data-placement", "floating");
  await paneStill(order.cart);

  return order;
};

const press = (locator) => locator.evaluate((el) => el.click());

test.describe("each change moves the pane and its parts together", () => {
  test("Expand and Hide", async ({ page }) => {
    const order = await floating(page, SMALL);
    const pill = order.cart.locator("[data-cart-toggle]");

    await record(page);
    await pill.click();
    await expect(order.cart).toHaveAttribute("data-fold", "open");
    transition("Expand", await recorded(page, order));

    await record(page);
    await pill.click();
    await expect(order.cart).toHaveAttribute("data-fold", "closed");
    transition("Hide", await recorded(page, order));
  });

  test("add a line, remove it, clear the cart", async ({ page }) => {
    const order = await floating(page, SMALL);

    await unfoldCart(order);
    await record(page);
    // A JS click: the open sheet covers the row, as on the phone, and a
    // customer reaches it by scrolling, which would minimize the pane.
    await press(order.item("thighs").locator(".order-qty-add"));
    await expect(order.cart.locator(`[data-remove='${SKU.thighs}']`))
      .toHaveCount(1);
    transition("add", await recorded(page, order));
    // An Add moves no focus to Hide (#559).
    await expect(order.cart.locator("[data-cart-toggle]")).not.toBeFocused();
    await expect(order.cart.locator("[data-cart-toggle]"))
      .not.toHaveAttribute("data-pulse", /./);

    await record(page);
    await press(order.cart.locator(`[data-remove='${SKU.thighs}']`));
    await expect(order.cart.locator(`[data-remove='${SKU.thighs}']`))
      .toHaveCount(0);
    transition("remove", await recorded(page, order));

    const clear = order.cart.locator("[data-cart-clear]");

    await press(clear);
    await expect(clear).toHaveAttribute("data-armed", "");
    // The second press counts only 400 ms after the first.
    await page.waitForTimeout(600);
    await record(page);
    await press(clear);
    await expect(order.cart).toHaveAttribute("data-empty", "");
    const frames = await recorded(page, order);

    transition("clear", frames);
    // The pane eased to its minimized size, and never stood empty.
    expect(frames[frames.length - 1].fold).toBe("closed");
  });
});

test.describe("a scroll of the page (#559)", () => {
  test("minimizes the open pane, unless it was reopened after one",
    async ({ page }) => {
      const order = await floating(page, SMALL);
      const pill = order.cart.locator("[data-cart-toggle]");

      await unfoldCart(order);

      // A scroll the page makes is not the person's.
      await glide(page, 200, 10);
      await order.scrollSettled();
      await expect(order.cart).toHaveAttribute("data-fold", "open");

      // A nudge is not enough.
      await swipe(page, 30);
      await order.scrollSettled();
      await expect(order.cart).toHaveAttribute("data-fold", "open");

      // The person's own scroll minimizes it, partway through.
      await swipe(page, -10);
      await order.scrollSettled();
      await record(page);
      await swipe(page, 160);
      await expect(order.cart).toHaveAttribute("data-fold", "closed");
      const frames = await recorded(page, order);

      transition("minimize on scroll", frames);
      // Once, while the swipe went on.
      expect(frames.filter((f, i) => i && f.fold !== frames[i - 1].fold))
        .toHaveLength(1);

      // Expand after that keeps it open while the page scrolls.
      await pill.click();
      await expect(order.cart).toHaveAttribute("data-fold", "open");
      await expect(order.cart).toHaveAttribute("data-kept", "");
      await paneStill(order.cart);
      await swipe(page, -300);
      await order.scrollSettled();
      await expect(order.cart).toHaveAttribute("data-fold", "open");

      // An Add keeps the choice.
      await press(order.item("thighs").locator(".order-qty-add"));
      await paneStill(order.cart);
      await swipe(page, 200);
      await order.scrollSettled();
      await expect(order.cart).toHaveAttribute("data-fold", "open");
      await expect(order.cart).toHaveAttribute("data-kept", "");

      // Hide resets it: the next Expand starts fresh.
      await pill.click();
      await paneStill(order.cart);
      await pill.click();
      await expect(order.cart).toHaveAttribute("data-fold", "open");
      await expect(order.cart).not.toHaveAttribute("data-kept", "");
      await paneStill(order.cart);
      await swipe(page, -120);
      await expect(order.cart).toHaveAttribute("data-fold", "closed");
    });

  test("never minimizes a pane in use", async ({ page }) => {
    const order = await floating(page, SMALL);

    await unfoldCart(order);
    await order.codeOpen.click();
    await expect(order.cart).toHaveAttribute("data-share", "code");
    await swipe(page, 200);
    await order.scrollSettled();
    await expect(order.cart).toHaveAttribute("data-fold", "open");
  });

  test("leaves the list as it was while the page and toolbar move",
    async ({ page }) => {
      const order = await floating(page, LONG);
      const pill = order.cart.locator("[data-cart-toggle]");

      // Kept open, so the pane stays up for the whole scroll.
      await unfoldCart(order);
      await swipe(page, 120);
      await expect(order.cart).toHaveAttribute("data-fold", "closed");
      await paneStill(order.cart);
      await pill.click();
      await expect(order.cart).toHaveAttribute("data-kept", "");
      await paneStill(order.cart);

      const list = order.cart.locator("[data-cart-items]");
      const scrolls = await list.evaluate((el) => (
        el.scrollHeight > el.clientHeight + 1
      ));

      test.skip(!scrolls, "the whole list fits this tall");
      // The middle of the list, so both fades show.
      await list.evaluate((el) => {
        el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
      });
      await page.waitForTimeout(200);

      await record(page);
      // Small steps, as James's 10px, then longer ones, with Safari's
      // toolbar coming and going under them.
      await swipe(page, 10, { step: 1, toolbar: true });
      await swipe(page, -10, { step: 2, toolbar: true });
      await swipe(page, 400, { step: 12, toolbar: true });
      await swipe(page, -300, { step: 8, toolbar: true });
      const frames = await recorded(page, order);
      const first = frames[0];

      frames.forEach((f, i) => {
        const no = (why) => fail("list", frames, i, why);

        if (f.fold !== "open") no("the pane closed");
        if (Math.abs(f.list.height - first.list.height) > 0.5) {
          no("the list's height changed");
        }
        if (Math.abs(f.listTop - first.listTop) > 0.5) {
          no("the list's scroll moved");
        }
        if (f.fades !== first.fades) no("the fades changed");
      });
      holdsEveryFrame("list", frames);
    });
});

test.describe("the settle and the lift-off (#559)", () => {
  test("the total row and the minimized pane keep their height",
    async ({ page }) => {
      const order = await floating(page, SMALL);

      // Down into the page, a frame at a time, until it settles.
      await record(page);
      const top = await page.evaluate(() => document
        .getElementById("order-cart-heading").getBoundingClientRect().top);

      await glide(page, top - 80, 24);
      await order.scrollSettled();
      await expect(order.cart).toHaveAttribute("data-placement", "inline");
      const settle = await recorded(page, order);

      holdsEveryFrame("settle", settle);

      // And back up until it lifts off, minimized.
      await record(page);
      await glide(page, -700, 20);
      await order.scrollSettled();
      await expect(order.cart).toHaveAttribute("data-placement", "floating");
      await expect(order.cart).toHaveAttribute("data-fold", "closed");
      const lift = await recorded(page, order);

      holdsEveryFrame("lift-off", lift);
      const row = lift[0].total.height;

      lift.forEach((f, i) => {
        if (Math.abs(f.total.height - row) > PX) {
          fail("lift-off", lift, i, "the total row changed height");
        }
      });

      // Once minimized and still, the pane keeps its height to the end.
      const still = lift.length - 6;
      const rest = lift[lift.length - 1].pane.height;

      lift.slice(still).forEach((f, k) => {
        if (Math.abs(f.pane.height - rest) > PX) {
          fail("lift-off", lift, still + k,
            "the minimized pane changed height");
        }
      });
      const lifted = lift.findIndex((f) => f.placement === "floating");
      const heights = lift.slice(lifted).map((f) => f.pane.height);

      heights.forEach((h, i) => {
        if (i && h - heights[i - 1] > PX) {
          fail("lift-off", lift, lifted + i, "the minimizing pane grew");
        }
      });
    });
});

test.describe("a badge's tooltip (#569)", () => {
  const tip = (page) => page.locator(".tooltip");

  test("shuts on any scroll, before it moves", async ({ page }) => {
    const order = await floating(page, SMALL);
    const badge = order.cart.locator("[data-badge='delivery']");

    await unfoldCart(order);
    await badge.click();
    await expect(tip(page)).toBeVisible();

    // The page, by a pixel.
    await record(page);
    await page.evaluate(() => window.scrollBy(0, 1));
    await expect(tip(page)).toHaveCount(0);
    const frames = await recorded(page, order);

    frames.forEach((f, i) => {
      if (f.tip && f.y !== frames[0].y) {
        fail("tooltip", frames, i, "a tooltip was drawn after the page moved");
      }
    });

    // The pane's own body, and the list.
    await badge.click();
    await expect(tip(page)).toBeVisible();
    await order.cart.locator("[data-cart-body]").evaluate((el) => {
      el.dispatchEvent(new Event("scroll"));
    });
    await expect(tip(page)).toHaveCount(0);

    await badge.click();
    await expect(tip(page)).toBeVisible();
    await order.cart.locator("[data-cart-items]").evaluate((el) => {
      el.dispatchEvent(new Event("scroll"));
    });
    await expect(tip(page)).toHaveCount(0);
  });

  test("shuts as Hide minimizes the pane", async ({ page }) => {
    const order = await floating(page, SMALL);
    const badge = order.cart.locator("[data-badge='delivery']");

    await unfoldCart(order);
    await badge.click();
    await expect(tip(page)).toBeVisible();
    await order.cart.locator("[data-cart-toggle]").click();
    await expect(tip(page)).toHaveCount(0);
  });

  test("opens on a tap and shuts on the next, a tap away or Escape",
    async ({ page }) => {
      const order = await floating(page, SMALL);
      const badge = order.cart.locator("[data-badge='delivery']");

      await unfoldCart(order);
      await badge.click();
      await expect(tip(page)).toBeVisible();
      await badge.click();
      await expect(tip(page)).toHaveCount(0);

      await badge.click();
      await expect(tip(page)).toBeVisible();
      await order.cart.locator("[data-part='total']").click();
      await expect(tip(page)).toHaveCount(0);

      await badge.click();
      await expect(tip(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(tip(page)).toHaveCount(0);
      // Escape shut the tooltip, not the pane.
      await expect(order.cart).toHaveAttribute("data-fold", "open");
    });
});
