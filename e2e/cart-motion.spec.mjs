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
//   not;
// - on every consecutive frame pair, no part's edge jumps further than
//   the shared ease allows, or 8px at rest, and no two parts that
//   carry words overlap (round 3, James's second phone read).
//
// A person's scroll is a touch on the catalog and the page moving
// under it a frame at a time: Playwright's WebKit has no touch drag,
// and the cart reads only where the touch began (view.mjs
// watchScroll). Safari's toolbar is a visual viewport made shorter.
// Runs in the iphone project only.

import {
  OrderPage, SKU, expect, foldCart, paneStill, test, unfoldCart,
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
  // How much of a part shows: its opacity times its ancestors' up to the
  // pane, and its box cut by every ancestor that clips, up to the pane,
  // and by the screen. Null where nothing of it shows.
  const opacity = (el) => {
    let o = 1;

    for (let n = el; n; n = n.parentElement) {
      o *= parseFloat(getComputedStyle(n).opacity);
      if (n === pane) break;
    }

    return o;
  };
  const seen = (el) => {
    const b = box(el);

    if (!b) return null;

    let { top, bottom, left, right } = b;

    for (let n = el.parentElement; n && n !== pane; n = n.parentElement) {
      const s = getComputedStyle(n);

      if (s.overflowX !== "visible" || s.overflowY !== "visible") {
        const c = n.getBoundingClientRect();

        top = Math.max(top, c.top);
        bottom = Math.min(bottom, c.bottom);
        left = Math.max(left, c.left);
        right = Math.min(right, c.right);
      }
    }
    top = Math.max(top, 0);
    bottom = Math.min(bottom, innerHeight);

    return bottom - top > 0.5 && right - left > 0.5
      ? { top, bottom, left, right } : null;
  };
  // Every part that carries words, for the overlap rule.
  const TEXTS = {
    lines: "[data-part='lines']",
    sums: "[data-part='sums']",
    total: "[data-part='total']",
    edit: "[data-part='edit']",
    badges: "[data-part='badges']",
    share: "[data-part='share']",
    toggle: "[data-cart-toggle]",
    next: "[data-checkout]",
    nudge: "[data-nudge]",
    clear: "[data-cart-clear]",
  };
  const frames = [];
  const tick = () => {
    const s = getComputedStyle(pane);
    const list = q("[data-cart-items]");
    const wrap = q("[data-cart-scroll]");
    const body = q("[data-cart-body]");
    const badge = q("[data-badge='delivery']");
    const tip = document.querySelector(".tooltip");
    const word = q("[data-cart-word]");
    const clear = q("[data-cart-clear]");

    frames.push({
      t: performance.now(),
      vh: innerHeight,
      moving: pane.getAnimations().length + pane.getAnimations({
        subtree: true,
      }).filter((a) => a.id === "cart-move").length,
      fold: pane.dataset.fold,
      placement: pane.dataset.placement,
      kept: pane.hasAttribute("data-kept"),
      y: scrollY,
      pane: box(pane),
      texts: Object.entries(TEXTS).map(([name, sel]) => {
        const el = q(sel);
        const shows = seen(el);

        return shows && { name, box: shows, op: opacity(el) };
      }).filter(Boolean),
      ops: Object.fromEntries(Object.entries(TEXTS).map(([name, sel]) => [
        name, q(sel) && box(q(sel)) ? opacity(q(sel)) : 0,
      ])),
      toggle: box(q("[data-cart-toggle]")),
      next: box(q("[data-checkout]")),
      clear: box(clear),
      clearText: q("[data-cart-clear-word]").textContent.trim(),
      word: word.textContent,
      wordOp: opacity(word),
      share: box(q("[data-part='share']")),
      sums: box(q("[data-part='sums']")),
      badges: box(q("[data-part='badges']")),
      seenParts: Object.fromEntries(["sums", "share", "badges"]
        .map((n) => [n, seen(q(TEXTS[n]))])),
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
const op = (v) => (v === undefined ? "-" : v.toFixed(2));
const line = (f, i) => `#${i} ${f.placement}/${f.fold} y=${Math.round(f.y)}`
  + ` +${f.t === undefined ? "-" : Math.round(f.t)}ms`
  + ` pane ${r(f.pane)} lines ${r(f.lines)}@${op(f.ops?.lines)}`
  + ` total ${r(f.total)} foot ${r(f.foot)}`
  + ` next ${r(f.next)} pill "${f.word}"@${op(f.wordOp)}`
  + ` clear ${r(f.clear)}@${op(f.ops?.clear)}`
  + ` list ${r(f.list)}@${Math.round(f.listTop)} fades ${f.fades}`;
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

// Every consecutive frame pair, not samples (James, 2026-11-12, round
// 3: the strips missed jank that lasted a frame or two). No part's edge
// moves further in one frame than the shared ease would take it: at
// most STEP px while nothing of the pane moves (the minimized pane that
// dropped 23px mid-scroll), and while it moves, STEP more than the
// curve's steepest step for the way that edge goes in the whole run
// (the curve starts at 4 times its mean speed; a quarter more for the
// clock). A settled pane's parts are measured against the page, a
// floating one's against the screen, and the frame it lifts off or
// settles against whichever is nearer. An edge off the screen in both
// frames, or a part that does not show in either, is not measured.
const STEP = 8;
const MOVE_MS = 420;
const STEEPEST = 4 * 1.25;
const EDGES = {
  pane: ["top", "bottom"],
  total: ["top", "bottom"],
  foot: ["top", "bottom"],
  lines: ["top"],
  clear: ["top", "bottom"],
  toggle: ["top", "bottom", "left", "right"],
  next: ["top", "bottom", "left", "right"],
};
const DOWN = new Set(["top", "bottom"]);

const stepsHold = (name, frames) => {
  const shows = (f, part) => f[part]
    && (part === "pane" || part === "foot" || (f.ops[part] ?? 1) > 0.05);

  for (const [part, edges] of Object.entries(EDGES)) {
    for (const edge of edges) {
      const steps = frames.map((f, i) => {
        const g = frames[i + 1];

        if (!g || !shows(f, part) || !shows(g, part)) return null;

        const a = f[part][edge];
        const b = g[part][edge];

        if (DOWN.has(edge) && Math.max(a, b) < 0) return null;
        if (DOWN.has(edge) && Math.min(a, b) > f.vh) return null;

        const d = b - a;

        if (!DOWN.has(edge)) return d;

        // The page moved by s: its contents by -s on the screen.
        const page = d + (g.y - f.y);

        if (f.placement === "inline" && g.placement === "inline") return page;
        if (f.placement !== "inline" && g.placement !== "inline") return d;

        return Math.abs(page) < Math.abs(d) ? page : d;
      });
      let at = 0;
      let way = 0;

      for (const s of steps) {
        at += s || 0;
        way = Math.max(way, Math.abs(at));
      }
      steps.forEach((s, i) => {
        if (s === null) return;

        const f = frames[i];
        const g = frames[i + 1];
        const dt = Math.max(1, g.t - f.t);
        const allowed = f.moving || g.moving
          ? STEP + STEEPEST * way * dt / MOVE_MS : STEP;

        if (Math.abs(s) > allowed + PX) {
          fail(name, frames, i + 1, `the ${part}'s ${edge} jumped `
            + `${s.toFixed(1)}px in one frame (at most ${allowed.toFixed(1)})`);
        }
      });
    }
  }
};

// No two parts that carry words overlap on any frame, as much of each
// as shows (cut by what clips it and by the screen, and not faded to
// nothing): the clear's old lines faded over the new total row.
const textsApart = (name, frames) => {
  frames.forEach((f, i) => {
    const shown = f.texts.filter((p) => p.op > 0.05);

    shown.forEach((p, k) => {
      for (const o of shown.slice(k + 1)) {
        const high = Math.min(p.box.bottom, o.box.bottom)
          - Math.max(p.box.top, o.box.top);
        const wide = Math.min(p.box.right, o.box.right)
          - Math.max(p.box.left, o.box.left);

        if (high > PX && wide > PX) {
          fail(name, frames, i, `${p.name} (${p.op.toFixed(2)}) and `
            + `${o.name} (${o.op.toFixed(2)}) overlap by ${
              Math.round(high)}px`);
        }
      }
    });
  });
};

const transition = (name, frames) => {
  holdsEveryFrame(name, frames);
  movesTogether(name, frames);
  stepsHold(name, frames);
  textsApart(name, frames);
};

// The rules for a scroll that settles or lifts off the pane, whose
// parts move with the page while it is settled: every frame, every
// frame pair, and words apart.
const scrollPasses = (name, frames) => {
  holdsEveryFrame(name, frames);
  stepsHold(name, frames);
  textsApart(name, frames);
};

// A slow page scroll, `by` px at `step` px a frame, the page's own.
const slowly = (page, by, step = 6) => glide(page, by, step);

// The cart floating over the catalog: ?add= settles it in the page,
// and the scroll back up, to halfway, lifts it off. It may lift off
// open (the fill from empty opens it), so a test that needs it closed
// folds it first. The tests scroll a few hundred pixels either way
// from there and come back, so the cart never reaches its place or the
// page's top.
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

// A trace of the pane for a failure's report (#559, the Expand that
// never opened): every write of data-fold, with the stack that made
// it; every change of data-fold, data-placement and data-kept; every
// pointer, touch, mouse, click, focus, wheel, key and page scroll, with
// its target. Lands in window.cartTrace; installed once a page.
const trace = (page) => page.evaluate(() => {
  if (window.cartTrace) return;

  const pane = document.getElementById("order-cart");
  const log = [];
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const name = (el) => {
    if (!(el instanceof Element)) return el === window ? "window" : "doc";

    const data = Array.from(el.attributes)
      .filter((a) => a.name.startsWith("data-") && a.name !== "data-tip")
      .map((a) => a.name).slice(0, 2).join(",");

    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}`
      + `${el.classList[0] ? `.${el.classList[0]}` : ""}`
      + `${data ? `[${data}]` : ""}`;
  };
  // WebKit's stack has no "Error" line: the frames only, this one first.
  const stack = () => (new Error().stack || "").split("\n")
    .map((s) => s.trim()).filter((s) => s && !s.startsWith("Error"))
    .slice(1, 8).join(" < ");

  window.cartTrace = log;
  for (const write of ["setAttribute", "removeAttribute",
    "toggleAttribute"]) {
    const native = Element.prototype[write];

    pane[write] = function written(attr, ...rest) {
      if (attr === "data-fold") {
        log.push(`${at()} ${write}(data-fold, ${rest[0]}) y=${
          Math.round(scrollY)} from ${stack()}`);
      }

      return native.call(this, attr, ...rest);
    };
  }
  new MutationObserver((changes) => {
    for (const c of changes) {
      log.push(`${at()} changed ${c.attributeName}: ${c.oldValue} -> ${
        pane.getAttribute(c.attributeName)}`);
    }
  }).observe(pane, {
    attributes: true, attributeOldValue: true,
    attributeFilter: ["data-fold", "data-placement", "data-kept"],
  });
  const events = [
    "pointerdown", "pointerup", "pointercancel", "mousedown", "mouseup",
    "click", "touchstart", "touchend", "touchcancel", "focusin", "wheel",
    "keydown",
  ];

  for (const type of events) {
    document.addEventListener(type, (e) => {
      log.push(`${at()} ${type}${e.pointerType ? `(${e.pointerType})` : ""}`
        + `${e.isTrusted ? "" : " untrusted"} on ${name(e.target)}`
        + `${e.clientX !== undefined
          ? ` at ${Math.round(e.clientX)},${Math.round(e.clientY)}` : ""}`
        + ` fold=${pane.dataset.fold}`);
    }, { capture: true, passive: true });
  }
  window.addEventListener("scroll", () => {
    log.push(`${at()} scroll y=${Math.round(scrollY)}`
      + ` fold=${pane.dataset.fold}`);
  }, { passive: true });
});

// The pane as it stands, and what is under a locator's middle: for the
// trace.
const snap = (page, locator) => locator.evaluate((el) => {
  const pane = document.getElementById("order-cart");
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  const name = (n) => (n ? `${n.tagName.toLowerCase()}${
    n.id ? `#${n.id}` : ""}${n.classList[0] ? `.${n.classList[0]}` : ""}`
    : "none");

  return `fold=${pane.dataset.fold} placement=${pane.dataset.placement}`
    + ` kept=${pane.hasAttribute("data-kept")} y=${Math.round(scrollY)}`
    + ` focus=${name(document.activeElement)}`
    + ` middle=${Math.round(x)},${Math.round(y)} hits=${name(hit)}`
    + ` (${el.contains(hit) ? "the pill" : "not the pill"})`
    + ` moving=${pane.getAnimations({ subtree: true }).length}`;
});

// Clicks the pill as the tests always have, and expects `fold`; on a
// miss, fails with the trace and the pane before and after the click.
// `first` runs just before the click, as record() did when the Expand
// first failed.
const pillTo = async (page, order, fold, first = async () => {}) => {
  const pill = order.cart.locator("[data-cart-toggle]");

  await trace(page);
  const before = await snap(page, pill);

  await page.evaluate(() => window.cartTrace.push("-- the pill click"));
  await first();
  await pill.click();
  const after = await snap(page, pill);

  try {
    await expect(order.cart).toHaveAttribute("data-fold", fold,
      { timeout: 5_000 });
  } catch (error) {
    const log = await page.evaluate(() => window.cartTrace);

    throw new Error(`the pill click did not make the pane ${fold}\n`
      + `before: ${before}\nafter: ${after}\n`
      + `now: ${await snap(page, pill)}\n`
      + `trace (ms since installed):\n${log.join("\n")}\n\n${error.message}`,
    { cause: error });
  }
};

test.describe("each change moves the pane and its parts together", () => {
  test("Expand and Hide", async ({ page }) => {
    const order = await floating(page, SMALL);

    // Filling the cart from empty opens the pane by design, and it was
    // open here when the trace ran (run 43163475875), so the first pill
    // click was a Hide. A Hide first, unrecorded and only if it is open,
    // gives the Expand a closed pane at rest to start from.
    await foldCart(page, order.cart);

    await pillTo(page, order, "open", () => record(page));
    const expand = await recorded(page, order);

    transition("Expand", expand);
    // Round 3: the Subtotal, Pickup days and Add discount rows were
    // squeezed under Hide for a few frames. A row that shows at all
    // shows most of its height, and the body never scrolls under them.
    const end = expand[expand.length - 1];

    expand.forEach((f, i) => {
      if (f.bodyOver && !end.bodyOver) {
        fail("Expand", expand, i, "the body overflowed");
      }
      for (const part of ["sums", "share", "badges"]) {
        const shows = f.seenParts[part];
        const full = end[part] ? end[part].height : 0;

        if (shows && full && f.ops[part] >= 0.25
          && shows.bottom - shows.top < 0.75 * full) {
          fail("Expand", expand, i, `the ${part} showed squeezed (${
            Math.round(shows.bottom - shows.top)} of ${Math.round(full)}px)`);
        }
      }
    });

    await pillTo(page, order, "closed", () => record(page));
    transition("Hide", await recorded(page, order));
  });

  test("add a line, remove it, clear the cart", async ({ page }) => {
    const order = await floating(page, SMALL);

    await unfoldCart(order);
    // A tap on Expand leaves no focus on a phone, but a click may (it
    // did in WebKit here): the focus starts nowhere, so the check below
    // sees only what the Add did.
    const focused = () => page.evaluate(() => {
      const el = document.activeElement;

      return el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${
        el.classList[0] ? `.${el.classList[0]}` : ""}` : "none";
    });
    const wasFocused = await focused();

    await page.evaluate(() => document.activeElement?.blur());
    await record(page);
    // A JS click: the open sheet covers the row, as on the phone, and a
    // customer reaches it by scrolling, which would minimize the pane.
    await press(order.item("thighs").locator(".order-qty-add"));
    await expect(order.cart.locator(`[data-remove='${SKU.thighs}']`))
      .toHaveCount(1);
    transition("add", await recorded(page, order));
    // An Add moves no focus to Hide (#559).
    await expect(order.cart.locator("[data-cart-toggle]"),
      `the focus before the Expand's blur was ${wasFocused}, now ${
        await focused()}`).not.toBeFocused();
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
    // One motion (round 3): Clear cart fades out, still asking, rather
    // than going in one frame, and Expand fades in, so nothing swaps in
    // the frame before the ease.
    // A failure prints the timeline from the press, so a cut and a
    // fade too quick for the frames read apart (run 43312689748).
    const pill = frames.filter((f) => f.clear && f.ops.clear > 0.05);

    if (!pill.some((f) => f.ops.clear < 0.95)) {
      fail("clear", frames, Math.max(0, frames.findIndex((f) => (
        f.word === "Expand")) - 1), "Clear cart never showed faded");
    }
    pill.forEach((f) => {
      if (f.clearText !== "Clear cart?") {
        fail("clear", frames, frames.indexOf(f),
          `Clear cart said "${f.clearText}" as it went`);
      }
    });
    expect(frames.some((f) => f.word === "Expand" && f.wordOp > 0.05
      && f.wordOp < 0.95), "Expand faded in").toBe(true);
    // The lines and Clear cart went, so the focus is the pane's (#531),
    // and never the pill's.
    await expect(order.cart).toBeFocused();
    await expect(order.cart.locator("[data-cart-toggle]")).not.toBeFocused();
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

// Round 3 (James's second phone read, 2026-11-12): the cases the spec
// passed while his phone still showed them, every frame pair.
test.describe("every frame pair (#559, round 3)", () => {
  // Settles the cart in the page, open, by a slow scroll down.
  const settle = async (page, order) => {
    const top = await page.evaluate(() => document
      .getElementById("order-cart-heading").getBoundingClientRect().top);

    await glide(page, top - 80, 24);
    await order.scrollSettled();
    await expect(order.cart).toHaveAttribute("data-placement", "inline");
    await paneStill(order.cart);
  };

  test("lift-off from an open settled cart: one cart, no ghost lines",
    async ({ page }) => {
      const order = await floating(page, SMALL);

      await settle(page, order);
      await expect(order.cart).toHaveAttribute("data-fold", "open");

      await record(page);
      await slowly(page, -700);
      await order.scrollSettled();
      await expect(order.cart).toHaveAttribute("data-placement", "floating");
      await expect(order.cart).toHaveAttribute("data-fold", "closed");
      const frames = await recorded(page, order);

      scrollPasses("lift-off", frames);

      const lifted = frames.findIndex((f) => f.placement === "floating");
      const before = frames[lifted - 1];
      const end = frames[frames.length - 1];
      const from = frames[lifted].pane.height;
      const to = end.pane.height;

      expect(lifted, "the cart lifted off while recorded").toBeGreaterThan(0);
      frames.slice(lifted).forEach((f, k) => {
        const i = lifted + k;

        // One cart: the floating pane never stands over the settled
        // cart's place, above where it began or where it rests.
        if (f.pane.top < Math.min(before.pane.top, end.pane.top) - STEP) {
          fail("lift-off", frames, i, "the pane rose over the catalog");
        }
        // No ghost lines: they are gone well before the pane is
        // minimized.
        const way = from - to > 1 ? (from - f.pane.height) / (from - to) : 1;

        if (way >= 0.7 && f.lines && f.ops.lines > 0.05) {
          fail("lift-off", frames, i,
            `the lines still show (${f.ops.lines.toFixed(2)}) with the pane `
            + `${Math.round(way * 100)}% minimized`);
        }
      });
    });

  test("settling an empty minimized cart: no swap, no ghost Hide",
    async ({ page }) => {
      const order = new OrderPage(page);

      await order.open();
      // The slot just under the screen's foot, the pane floating and
      // minimized over the catalog.
      await page.evaluate(() => {
        const slot = document.getElementById("order-cart-heading");

        window.scrollBy(0, slot.getBoundingClientRect().top - innerHeight);
      });
      await order.scrollSettled();
      await expect(order.cart).toHaveAttribute("data-placement", "floating");
      await expect(order.cart).toHaveAttribute("data-fold", "closed");
      await expect(order.cart).toHaveAttribute("data-empty", "");
      await paneStill(order.cart);

      await record(page);
      await slowly(page, 500, 4);
      await order.scrollSettled();
      await expect(order.cart).toHaveAttribute("data-placement", "inline");
      const frames = await recorded(page, order);

      scrollPasses("empty settle", frames);
      const first = frames[0];

      frames.forEach((f, i) => {
        // The pill leaves as it was: no "Hide" on its way out.
        if (f.toggle && f.ops.toggle > 0.05 && f.word !== first.word) {
          fail("empty settle", frames, i, `the pill said "${f.word}"`);
        }
        // Proceed to checkout keeps the foot's first row: it never
        // wraps onto a row of its own.
        if (Math.abs((f.next.top - f.foot.top)
          - (first.next.top - first.foot.top)) > 2 * PX) {
          fail("empty settle", frames, i,
            "Proceed to checkout left the foot's first row");
        }
      });
    });

  test("a slow scroll never moves the minimized pane in a step",
    async ({ page }) => {
      const order = await floating(page, SMALL);

      await foldCart(page, order.cart);
      await record(page);
      // A finger's slow drag, with Safari's toolbar coming and going.
      await swipe(page, 240, { step: 2, toolbar: true });
      await swipe(page, -240, { step: 3, toolbar: true });
      await order.scrollSettled();
      const frames = await recorded(page, order);

      frames.forEach((f, i) => {
        if (f.fold !== "closed" || f.placement !== "floating") {
          fail("slow scroll", frames, i, "the pane did not stay minimized");
        }
      });
      holdsEveryFrame("slow scroll", frames);
      stepsHold("slow scroll", frames);
      textsApart("slow scroll", frames);
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
