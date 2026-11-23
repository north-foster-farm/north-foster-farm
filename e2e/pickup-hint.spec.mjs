// Criteria tests for the third revision of #703, from James's staging
// look on his phone (2026-11-23, #703 to #706): the pick-up list's
// validation. One test per "Done when" box that begins "Third
// revision:" and is marked (test), named for it word for word, written
// from the box and James's words in that section before any change.
//
// James: the red outline read as an error before the customer had done
// anything wrong, and the message sat below the list, out of view. The
// new pattern, with no outline or ring around the list in any state:
// - Proceed to checkout with no day picked scrolls to the section
//   heading and shows "Choose a pick-up day and place" directly under
//   it, above the first card, as a neutral hint (not red, with an
//   arrow or info icon), and focuses the first card's radio;
// - Place your order with no day picked turns that line, in that spot,
//   red with an error icon, runs a thin red bar down the left of the
//   card list, and only then announces it to screen readers, with the
//   radio group described by the message.
//
// Provisional, written to what is checkable until the implementer and
// James settle it:
// - the markup of the hint and the error. The tests find the message
//   by its text inside the Pick-up days card, and read: its place (under
//   the heading, above the first card), its computed color (not red as
//   a hint, red as an error), an icon (an svg or img in it, or a
//   ::before or ::after with content), a role of alert, status or log
//   or an aria-live other than off on it or around it, or a live region
//   holding its text, in the error state only, and the radio group's
//   aria-describedby;
// - "the section heading": the Pick-up days card's title
//   (#method-scheduled-title), PICKUP.heading below. If James means another
//   heading, that one line changes;
// - "thin red bar": a red left border, at most 8 px wide, on the list
//   or a wrapper inside the card's body, or a ::before or ::after of
//   one drawn red at that width, present in the error state only;
// - the message's last character: the site says "Choose a pick-up day
//   and place." with a full stop, and James wrote it without one, so
//   either passes.
//
// Red is read, never written out: a color whose red channel is 150 or
// more and at least 80 above its green and blue, as Bootstrap's danger
// (220, 53, 69) is and the brand green is not.
//
// The desktop and phone projects run every test at 1500 and 390 px;
// the box that names phone and desktop widths also walks both sizes
// itself. No order reaches the server: /api/orders posts are refused.
//
// The Group orders date list follows the same pattern (James,
// 2026-11-23, about 03:43 ET): the hint on Proceed to checkout, the
// error on Place your order, no ring, and picking a date clears either,
// the red bar with it. Its four boxes, those that begin "Third
// revision, Group orders:", are the second describe below, read the
// same way and with the same provisions, except:
// - its message stays "Choose a group order date.", full stop and all;
// - "the section heading" is the Group orders card's title
//   (#method-group-title);
// - the member, the group's rounds and the way come from
//   e2e/support/vff.mjs, as in e2e/group-orders.spec.mjs.
// "Picking a day clears the hint or the error, the red bar with it" is
// confirmed by James, no longer provisional.

import { OrderPage, expect, test } from "./support/order.mjs";
import {
  DROP, FOSTER, cannedScheduled, datesWith,
} from "./support/scheduled.mjs";
import {
  GROUP_ORDERS, MEMBER, choose, openOrder, pick, signIn,
} from "./support/vff.mjs";

// The two lists: the way's value (its card is #method-<way>, its body
// [data-method-body='<way>']), the list's id, the section heading and
// the message.
const PICKUP = {
  way: "scheduled", list: "scheduled-pickups",
  heading: "#method-scheduled-title",
  text: /^Choose a pick-up day and place\.?$/,
};
const GROUP = {
  way: "group", list: "group-pickups",
  heading: "#method-group-title",
  text: /^Choose a group order date\.$/,
};
const TEXT = PICKUP.text;
const SIZES = [
  { width: 390, height: 664 },
  { width: 1500, height: 900 },
];

// Two dates, one with two pickups.
const lists = () => datesWith([
  { place: DROP, days: [3, 10] },
  { place: FOSTER, days: [3] },
]);

// No order reaches the server from these tests.
const noPosts = (page) => page.route("**/api/orders", (route) => (
  route.request().method() === "POST" ? route.abort() : route.fallback()
));

// A tap where the project has touch, a click elsewhere; forced, since
// Proceed may be aria-disabled and still take the press (#706).
const press = (button) => (test.info().project.use.hasTouch
  ? button.tap({ force: true })
  : button.click({ force: true }));

const list = (page, which = PICKUP) => page.locator(`#${which.list}`);

// The order page with Pick-up days chosen, its cards shown, nothing
// picked.
const openPickups = async (page) => {
  await cannedScheduled(page, lists());
  await noPosts(page);

  const order = new OrderPage(page);

  await order.open({ eggs: 1 }, { method: "scheduled" });
  await expect(list(page).locator(".order-pickup").first()).toBeVisible();
  await order.scrollSettled();

  return order;
};

// The order page signed in as the group's member, Group orders chosen,
// its round cards shown, no date picked.
const openGroup = async (page, baseURL) => {
  await signIn(page, baseURL, MEMBER, {
    lists: datesWith([{ place: FOSTER, days: [3] }]),
  });
  await noPosts(page);

  const order = await openOrder(page, MEMBER);

  await choose(order, GROUP_ORDERS);
  await expect(list(page, GROUP).locator(".order-pickup").first())
    .toBeVisible();
  await order.scrollSettled();

  return order;
};

const MEMBER_CONTACT = {
  email: MEMBER.customer.email, phone: MEMBER.customer.phone,
};

// The page still: the scroll settled and every finite animation done.
const settle = async (order) => {
  await order.scrollSettled();
  await order.page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
    .map((a) => a.finished.catch(() => null))));
};

// Proceed to checkout, pressed with no day picked, and the page still.
const proceed = async (order) => {
  await press(order.next);
  await settle(order);
};

// Place your order with no day picked: the contact (`who`) and the
// card entered, then the button, and the page still.
const placeOrder = async (order, who = {
  email: "pickup-hint@example.com",
}) => {
  await order.contact(who);
  await order.openCard();
  await order.card();
  await order.submit.click();
  await settle(order);
};

// Puts on the page a test whether a CSS color is red (see the header),
// for the page-side helpers below; again after each navigation.
const withRed = (page) => page.evaluate(() => {
  window.e2eIsRed = (color) => {
    const m = String(color).match(/rgba?\(([^)]*)\)/);

    if (!m) return false;

    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean)
      .map(parseFloat);

    return a > 0.3 && r >= 150 && r - Math.max(g, b) >= 80;
  };
});

// The message as the page shows it now, or null: the deepest visible
// element in the way's card (Pick-up days unless `which` says) whose
// text is the message, the block around it that holds that text alone,
// and what the tests read of them.
const messageOf = async (page, which = PICKUP) => (await withRed(page),
page.evaluate((
  { text, heading, way, listId }
) => {
  const isRed = window.e2eIsRed;
  const card = document.querySelector(`#method-${way}`)
    ?.closest(".order-method");
  const words = (el) => el.innerText.replace(/\s+/g, " ").trim();
  const pattern = new RegExp(text.source);
  const seen = (el) => {
    const r = el.getBoundingClientRect();

    return r.width > 0 && r.height > 0
      && getComputedStyle(el).visibility !== "hidden";
  };
  const hits = [...card.querySelectorAll("*")]
    .filter((el) => seen(el) && pattern.test(words(el)))
    .filter((el, _, all) => !all.some((o) => o !== el && el.contains(o)));

  if (!hits.length) return null;

  const node = hits[0];
  let block = node;

  while (block.parentElement !== card
    && pattern.test(words(block.parentElement))) block = block.parentElement;

  const box = (el) => {
    const r = el.getBoundingClientRect();

    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const drawn = (el, pseudo) => {
    const c = getComputedStyle(el, pseudo).content;

    return c !== "none" && c !== "normal" && c !== "\"\"";
  };
  const icon = !!block.querySelector("svg, img")
    || [block, ...block.querySelectorAll("*")]
      .some((el) => drawn(el, "::before") || drawn(el, "::after"));
  const lives = (el) => {
    const role = el.getAttribute("role");
    const live = el.getAttribute("aria-live");

    return ["alert", "status", "log"].includes(role)
      || (!!live && live !== "off");
  };
  let around = false;

  for (let el = node; el && el !== document.body; el = el.parentElement) {
    if (lives(el)) around = true;
  }

  // A live region elsewhere on the page holding the text, shown or
  // only to screen readers.
  const region = [...document.querySelectorAll(
    "[role='alert'], [role='status'], [role='log'], [aria-live]"
  )].some((el) => lives(el) && pattern.test(
    el.textContent.replace(/\s+/g, " ").trim()
  ));
  const group = document.getElementById(listId);
  const described = (group.getAttribute("aria-describedby") || "")
    .split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id))
    .some((el) => el && (el.contains(node) || node.contains(el))
      && pattern.test(el.textContent.replace(/\s+/g, " ").trim()));
  const head = document.querySelector(heading);
  const firstCard = group.querySelector(".order-pickup");
  const firstDay = group.querySelector(".order-pickup-day") || firstCard;
  const center = (el) => {
    const r = el.getBoundingClientRect();
    const x = (r.left + r.right) / 2;
    const y = (r.top + r.bottom) / 2;
    const top = document.elementFromPoint(x, y);

    return {
      inView: r.top >= 0 && r.bottom <= innerHeight
        && r.left >= 0 && r.right <= innerWidth,
      unseen: !top || !(el.contains(top) || top.contains(el)),
    };
  };

  return {
    text: words(node),
    box: box(node),
    color: getComputedStyle(node).color,
    red: isRed(getComputedStyle(node).color),
    icon,
    live: around || region,
    described,
    heading: box(head),
    firstCard: box(firstCard),
    firstDay: box(firstDay),
    view: center(node),
    headView: center(head),
  };
}, {
  text: { source: which.text.source }, heading: which.heading,
  way: which.way, listId: which.list,
}));

// Every visible element on the page drawn in red now: its color, a
// border, an outline or a glow. A path for each, to compare two looks.
const redNow = async (page) => (await withRed(page), page.evaluate(() => {
  const isRed = window.e2eIsRed;
  const out = [];
  const path = (el) => {
    const parts = [];

    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const i = e.parentElement
        ? [...e.parentElement.children].indexOf(e) : 0;

      parts.unshift(`${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}` +
        `:${i}`);
    }
    return parts.join(">");
  };

  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();

    if (!r.width || !r.height) continue;

    const s = getComputedStyle(el);

    if (s.visibility === "hidden") continue;

    const sides = ["Top", "Right", "Bottom", "Left"].filter((d) => (
      s[`border${d}Style`] !== "none" && parseFloat(s[`border${d}Width`]) > 0
        && isRed(s[`border${d}Color`])));
    const outline = s.outlineStyle !== "none"
      && parseFloat(s.outlineWidth) > 0 && isRed(s.outlineColor);
    const glow = s.boxShadow !== "none" && (s.boxShadow
      .match(/rgba?\([^)]*\)/g) || []).some(isRed);
    // Its own text only, so a red word is counted once.
    const text = [...el.childNodes].some((n) => n.nodeType === 3
      && n.textContent.trim()) && isRed(s.color);

    if (sides.length || outline || glow || text) {
      out.push(`${path(el)} ${[text && "color", outline && "outline",
        glow && "glow", ...sides.map((d) => `border-${d}`)]
        .filter(Boolean).join(" ")}`);
    }
  }
  return out;
}));

// The ring or outline around the list, and the thin red bar: the list
// itself and each wrapper up to the card's body, with their ::before
// and ::after. Runs in the page, through frameOf below.
function frameIn(el, way) {
  const isRed = window.e2eIsRed;
  const body = el.closest(`[data-method-body='${way}']`);
  const shows = (s, d) => s[`border${d}Style`] !== "none"
    && s[`border${d}Style`] !== "hidden"
    && parseFloat(s[`border${d}Width`]) > 0
    && !/rgba\([^)]*,\s*0\)|transparent/.test(s[`border${d}Color`]);
  const shadows = (s) => s.boxShadow !== "none" && (s.boxShadow
    .match(/rgba?\([^)]*\)/g) || ["x"])
    .some((c) => !/rgba\([^)]*,\s*0\)/.test(c));
  const lined = (s) => s.outlineStyle !== "none"
    && parseFloat(s.outlineWidth) > 0
    && !/rgba\([^)]*,\s*0\)|transparent/.test(s.outlineColor);
  const own = getComputedStyle(el);
  const wrappers = [];

  for (let a = el.parentElement; a && body?.contains(a);
    a = a.parentElement) wrappers.push(a);

  const cards = el.querySelectorAll(".order-pickup");
  const firstCard = cards[0].getBoundingClientRect();
  const lastCard = cards[cards.length - 1].getBoundingClientRect();
  const thin = (s) => parseFloat(s.borderLeftWidth) <= 8;
  const bars = [];

  for (const node of [el, ...wrappers]) {
    const s = getComputedStyle(node);

    if (shows(s, "Left") && isRed(s.borderLeftColor) && thin(s)) {
      const r = node.getBoundingClientRect();

      bars.push({
        on: node.id || node.className, left: r.left,
        runs: r.top <= firstCard.top + 1 && r.bottom >= lastCard.bottom - 1,
      });
    }
    for (const pseudo of ["::before", "::after"]) {
      const p = getComputedStyle(node, pseudo);

      if (p.content === "none" || p.content === "normal") continue;

      const width = parseFloat(p.width);
      const fill = isRed(p.backgroundColor) && width > 0 && width <= 8;
      const edge = shows(p, "Left") && isRed(p.borderLeftColor) && thin(p);

      if (fill || edge) {
        bars.push({
          on: `${node.id || node.className}${pseudo}`, left: NaN,
          runs: p.height === "auto" || parseFloat(p.height)
            >= lastCard.bottom - firstCard.top - 1,
        });
      }
    }
  }

  return {
    // The list's own frame, any color.
    list: {
      sides: ["Top", "Right", "Bottom"].filter((d) => shows(own, d)),
      left: shows(own, "Left")
        ? { red: isRed(own.borderLeftColor), thin: thin(own) } : null,
      glow: shadows(own),
      outline: lined(own),
    },
    // A wrapper's frame in red, the bar's side aside.
    wrappers: wrappers.flatMap((a) => {
      const s = getComputedStyle(a);
      const name = a.id || a.className;

      return [
        ...["Top", "Right", "Bottom"]
          .filter((d) => shows(s, d) && isRed(s[`border${d}Color`]))
          .map((d) => `${name} border-${d}`),
        ...(s.boxShadow !== "none" && (s.boxShadow
          .match(/rgba?\([^)]*\)/g) || []).some(isRed) ? [`${name} glow`] : []),
        ...(lined(s) && isRed(s.outlineColor) ? [`${name} outline`] : []),
      ];
    }),
    bars,
    cardsLeft: firstCard.left,
  };
}

const frameOf = async (page, which = PICKUP) => {
  await withRed(page);

  return list(page, which).evaluate(frameIn, which.way);
};

// No ring or outline around the list: none of its own, no red one on a
// wrapper, and on the left only the thin red bar where `bar` allows it.
const expectNoRing = (frame, state, { bar = false } = {}) => {
  expect(frame.list.sides, `${state}: no border on the list's top, ` +
    "right or bottom").toEqual([]);
  expect(frame.list.glow, `${state}: no glow around the list`).toBe(false);
  expect(frame.list.outline, `${state}: no outline around the list`)
    .toBe(false);
  expect(frame.wrappers, `${state}: no red frame around the list`)
    .toEqual([]);
  if (frame.list.left) {
    expect(bar && frame.list.left.red && frame.list.left.thin,
      `${state}: the list's left border is the thin red bar or nothing`)
      .toBe(true);
  }
};

// The thin red bar, running down the `what` at its left.
const expectBar = (frame, what) => {
  expect(frame.bars.length, "a thin red bar").toBeGreaterThan(0);
  expect(frame.bars.some((b) => b.runs),
    `the bar runs down the ${what} (${JSON.stringify(frame.bars)})`)
    .toBe(true);
  for (const b of frame.bars.filter((one) => !Number.isNaN(one.left))) {
    expect(b.left, `the bar on ${b.on} is at the list's left`)
      .toBeLessThanOrEqual(frame.cardsLeft + 0.5);
  }
};

test.describe("the pick-up list's hint and error (#703, third revision)",
  () => {
    test("The pick-up list has no outline or ring around it in any " +
      "state: untouched, after Proceed to checkout, and after Place your " +
      "order", async ({ page }) => {
      const order = await openPickups(page);

      expectNoRing(await frameOf(page), "untouched");

      await proceed(order);
      expect(await messageOf(page), "Proceed shows the message")
        .not.toBeNull();
      expectNoRing(await frameOf(page), "after Proceed to checkout");

      await placeOrder(order);
      expect(await messageOf(page), "Place your order shows the message")
        .not.toBeNull();
      expectNoRing(await frameOf(page), "after Place your order",
        { bar: true });
    });

    test("Proceed to checkout with no day picked scrolls to the section " +
      "heading and shows \"Choose a pick-up day and place\" directly " +
      "under it, above the first card", async ({ page }) => {
      const order = await openPickups(page);

      await page.evaluate(() => scrollTo(0, 0));
      await settle(order);
      await proceed(order);

      const m = await messageOf(page);

      expect(m, "the message shows").not.toBeNull();
      expect(m.text).toMatch(TEXT);
      expect(m.headView.inView, "the heading is on screen").toBe(true);
      expect(m.headView.unseen, "nothing covers the heading").toBe(false);
      expect(m.box.top, "the message is under the heading")
        .toBeGreaterThanOrEqual(m.heading.bottom - 0.5);
      expect(m.box.bottom, "the message is above the first date")
        .toBeLessThanOrEqual(m.firstDay.top + 0.5);
      expect(m.box.bottom, "the message is above the first card")
        .toBeLessThanOrEqual(m.firstCard.top + 0.5);
    });

    test("That line is then a neutral hint: plain text with an arrow or " +
      "info icon, not red, and nothing on the page turns red",
    async ({ page }) => {
      const order = await openPickups(page);
      const before = new Set(await redNow(page));

      await proceed(order);

      const m = await messageOf(page);

      expect(m, "the hint shows").not.toBeNull();
      expect(m.red, `the hint is not red (${m.color})`).toBe(false);
      expect(m.icon, "the hint has an icon").toBe(true);
      expect((await redNow(page)).filter((r) => !before.has(r)),
        "nothing on the page turned red").toEqual([]);
    });

    test("Proceed to checkout with no day picked puts the focus on the " +
      "first card's radio", async ({ page }) => {
      const order = await openPickups(page);

      await proceed(order);
      await expect.poll(() => page.evaluate(() => {
        const first = document.querySelector(
          "#scheduled-pickups .order-pickup input[type='radio']"
        );

        return !!first && document.activeElement === first;
      }), { message: "the first card's radio has the focus", timeout: 5_000 })
        .toBe(true);
    });

    test("Place your order with no day picked turns the same line, in the " +
      "same spot, red with an error icon, and a thin red bar runs down the " +
      "left of the card list", async ({ page }) => {
      const order = await openPickups(page);

      await proceed(order);

      const hint = await messageOf(page);

      expect(hint, "Proceed shows the hint").not.toBeNull();
      expect((await frameOf(page)).bars, "no red bar with the hint")
        .toEqual([]);

      await placeOrder(order);

      const error = await messageOf(page);

      expect(error, "Place your order shows the message").not.toBeNull();
      expect(error.text).toMatch(TEXT);
      expect(Math.abs((error.box.top - error.firstCard.top)
        - (hint.box.top - hint.firstCard.top)),
      "the same spot: as far above the first card as the hint")
        .toBeLessThanOrEqual(1);
      expect(Math.abs((error.box.top - error.heading.bottom)
        - (hint.box.top - hint.heading.bottom)),
      "the same spot: as far under the heading as the hint")
        .toBeLessThanOrEqual(1);
      expect(error.red, `the error is red (${error.color})`).toBe(true);
      expect(error.icon, "the error has an icon").toBe(true);

      expectBar(await frameOf(page), "card list");
    });

    test("The message is announced to screen readers only on Place your " +
      "order (role=alert or a live region on submit), never on Proceed to " +
      "checkout, and the radio group is described by the message",
    async ({ page }) => {
      const order = await openPickups(page);

      await proceed(order);

      const hint = await messageOf(page);

      expect(hint, "Proceed shows the hint").not.toBeNull();
      expect(hint.live, "the hint is not announced").toBe(false);

      await placeOrder(order);

      const error = await messageOf(page);

      expect(error, "Place your order shows the message").not.toBeNull();
      expect(error.live, "the error is announced").toBe(true);
      expect(error.described,
        "the radio group's aria-describedby names the message").toBe(true);
    });

    test("In both cases the message sits where the scroll lands: it is " +
      "inside the viewport when the scroll settles, at phone and desktop " +
      "widths", async ({ page }) => {
      for (const size of SIZES) {
        const at = `at ${size.width}px`;

        await page.setViewportSize(size);

        const order = await openPickups(page);

        await page.evaluate(() => scrollTo(0, 0));
        await settle(order);
        await proceed(order);

        const hint = await messageOf(page);

        expect(hint, `Proceed shows the hint ${at}`).not.toBeNull();
        expect(hint.view.inView, `the hint is on screen ${at}`).toBe(true);
        expect(hint.view.unseen, `nothing covers the hint ${at}`)
          .toBe(false);

        await placeOrder(order);

        const error = await messageOf(page);

        expect(error, `Place your order shows the message ${at}`)
          .not.toBeNull();
        expect(error.view.inView, `the error is on screen ${at}`).toBe(true);
        expect(error.view.unseen, `nothing covers the error ${at}`)
          .toBe(false);
      }
    });

    test("Picking a day clears the hint or the error, the red bar with it",
      async ({ page }) => {
        const first = () => list(page)
          .locator(".order-pickup input[type='radio']").first();

        for (const state of ["hint", "error"]) {
          await test.step(state, async () => {
            const order = await openPickups(page);

            await proceed(order);
            if (state === "error") await placeOrder(order);
            expect(await messageOf(page), `the ${state} shows`)
              .not.toBeNull();

            await first().check();
            await settle(order);
            expect(await messageOf(page), `the ${state} is gone`).toBeNull();
            expect((await frameOf(page)).bars, "no red bar").toEqual([]);
          });
        }
      });
  });

test.describe("the Group orders date list's hint and error (#703, third " +
  "revision)", () => {
  test("The Group orders date list has no outline or ring around it in " +
    "any state", async ({ page, baseURL }) => {
    const order = await openGroup(page, baseURL);

    expectNoRing(await frameOf(page, GROUP), "untouched");

    await proceed(order);
    expect(await messageOf(page, GROUP), "Proceed shows the message")
      .not.toBeNull();
    expectNoRing(await frameOf(page, GROUP), "after Proceed to checkout");

    await placeOrder(order, MEMBER_CONTACT);
    expect(await messageOf(page, GROUP), "Place your order shows the message")
      .not.toBeNull();
    expectNoRing(await frameOf(page, GROUP), "after Place your order",
      { bar: true });
  });

  test("Proceed to checkout with Group orders chosen and no date picked " +
    "scrolls to the section heading and shows \"Choose a group order " +
    "date.\" directly under it, above the first card, as a neutral hint, " +
    "not red, with the focus on the first card's radio",
  async ({ page, baseURL }) => {
    const order = await openGroup(page, baseURL);
    const before = new Set(await redNow(page));

    await page.evaluate(() => scrollTo(0, 0));
    await settle(order);
    await proceed(order);

    const m = await messageOf(page, GROUP);

    expect(m, "the message shows").not.toBeNull();
    expect(m.text).toMatch(GROUP.text);
    expect(m.headView.inView, "the heading is on screen").toBe(true);
    expect(m.headView.unseen, "nothing covers the heading").toBe(false);
    expect(m.view.inView, "the hint is on screen").toBe(true);
    expect(m.box.top, "the message is under the heading")
      .toBeGreaterThanOrEqual(m.heading.bottom - 0.5);
    expect(m.box.bottom, "the message is above the first card")
      .toBeLessThanOrEqual(m.firstCard.top + 0.5);
    expect(m.red, `the hint is not red (${m.color})`).toBe(false);
    expect(m.icon, "the hint has an icon, as Pick-up days' does")
      .toBe(true);
    expect(m.live, "the hint is not announced").toBe(false);
    expect((await redNow(page)).filter((r) => !before.has(r)),
      "nothing on the page turned red").toEqual([]);
    await expect.poll(() => page.evaluate((id) => {
      const first = document.querySelector(
        `#${id} .order-pickup input[type='radio']`
      );

      return !!first && document.activeElement === first;
    }, GROUP.list), {
      message: "the first card's radio has the focus", timeout: 5_000,
    }).toBe(true);
  });

  test("Place your order with no date picked turns that line red with an " +
    "error icon, puts a thin red bar down the left of the date list, and " +
    "announces it to screen readers only then, with the radio group " +
    "described by the message", async ({ page, baseURL }) => {
    const order = await openGroup(page, baseURL);

    await proceed(order);

    const hint = await messageOf(page, GROUP);

    expect(hint, "Proceed shows the hint").not.toBeNull();
    expect(hint.live, "the hint is not announced").toBe(false);
    expect((await frameOf(page, GROUP)).bars, "no red bar with the hint")
      .toEqual([]);

    await placeOrder(order, MEMBER_CONTACT);

    const error = await messageOf(page, GROUP);

    expect(error, "Place your order shows the message").not.toBeNull();
    expect(error.text).toMatch(GROUP.text);
    expect(Math.abs((error.box.top - error.firstCard.top)
      - (hint.box.top - hint.firstCard.top)),
    "that line: as far above the first card as the hint")
      .toBeLessThanOrEqual(1);
    expect(error.red, `the error is red (${error.color})`).toBe(true);
    expect(error.icon, "the error has an icon").toBe(true);
    expect(error.live, "the error is announced").toBe(true);
    expect(error.described,
      "the radio group's aria-describedby names the message").toBe(true);

    expectBar(await frameOf(page, GROUP), "date list");
  });

  test("Picking a date clears the hint or the error, the red bar with it",
    async ({ page, baseURL }) => {
      for (const state of ["hint", "error"]) {
        await test.step(state, async () => {
          const order = await openGroup(page, baseURL);

          await proceed(order);
          if (state === "error") await placeOrder(order, MEMBER_CONTACT);
          expect(await messageOf(page, GROUP), `the ${state} shows`)
            .not.toBeNull();

          await pick(page, list(page, GROUP)
            .locator(".order-pickup input[type='radio']").first());
          await settle(order);
          expect(await messageOf(page, GROUP), `the ${state} is gone`)
            .toBeNull();
          expect((await frameOf(page, GROUP)).bars, "no red bar")
            .toEqual([]);
        });
      }
    });
});
