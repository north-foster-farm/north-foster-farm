// Criteria tests for #706 (Proceed to checkout says why, and goes to
// what is missing), one per "Done when" box marked (test), named for
// it and written before the fix. Held out of every run by its name:
// playwright.config.mjs takes *.spec.mjs only, so the implementer
// turns it on by renaming it e2e/checkout-go.spec.mjs.
//
// The markup these rely on, as it stands on next at 8759c761:
// - the cart, #order-cart: its button [data-checkout], its fold
//   (data-fold, open or closed) and its pill [data-cart-toggle], the
//   way's button [data-way-toggle] (the pickup method button), the
//   subtotal [data-total='subtotal'] and the discount's row
//   [data-total-row='discount'] (layouts/partials/order/cart.html);
// - Pickup or delivery, #pickup: one .order-method per way, holding
//   its radio [name='method'] and its body [data-method-body]; the
//   on-farm day #onfarm-date and times [name='onfarm.window'] in
//   [data-windows]; the slots [data-error-for='onfarm.window'],
//   [data-error-for='fulfilment.occurrence'] and
//   [data-error-for='delivery.address1']
//   (layouts/partials/order/fulfilment.html);
// - Contact information #details, Payment #payment and Place your
//   order #confirm, each a fieldset (customer.html, payment.html,
//   wrap.html);
// - a tooltip as Bootstrap draws one: [role='tooltip'] whose id the
//   button names in aria-describedby while it shows;
// - the pill's pulse: the order-pill keyframes (_cart.scss), which
//   the way's button reuses.
//
// A button that cannot go on looks disabled (aria-disabled) but takes
// the press (#706, Spec), and Playwright will not click an
// aria-disabled button: the press is forced, as a customer's tap is.

import {
  OrderPage, addQuery, expect, foldCart, test,
} from "./support/order.mjs";
import {
  DAYS, TODAY, moneyFor, onDay,
} from "./support/money-day.mjs";

const SECTION = {
  contact: "#details", payment: "#payment", confirm: "#confirm",
};

// A tap where the project has touch, a click elsewhere; forced, since
// the button may be aria-disabled.
const press = (button) => (test.info().project.use.hasTouch
  ? button.tap({ force: true })
  : button.click({ force: true }));

// What the button's description says now: the text of each visible
// element its aria-describedby names, and of each visible tooltip
// among them.
const described = (button) => button.evaluate((el) => {
  const seen = (node) => {
    const r = node.getBoundingClientRect();

    return r.width > 0 && r.height > 0
      && getComputedStyle(node).visibility !== "hidden";
  };
  const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/)
    .filter(Boolean);
  const nodes = ids.map((id) => document.getElementById(id))
    .filter((node) => node && seen(node));

  return {
    texts: nodes.map((node) => node.textContent.trim()).filter(Boolean),
    tips: nodes.filter((node) => node.getAttribute("role") === "tooltip")
      .map((node) => node.textContent.trim()),
  };
});

// The focused element: whether it lies inside `selector` (or, given
// a way, inside that way's .order-method) and on screen.
const focusAt = (page, { selector, way }) => page.evaluate(
  ({ selector: s, way: w }) => {
    const el = document.activeElement;

    if (!el || el === document.body) return { inside: false, seen: false };

    const box = w
      ? el.closest(".order-method")
      : el.closest(s);
    const inside = !!box && (!w
      || box.querySelector("[name='method']")?.value === w);
    const r = el.getBoundingClientRect();
    const seen = r.bottom > 0 && r.top < innerHeight
      && r.right > 0 && r.left < innerWidth;

    return { inside, seen };
  },
  { selector, way }
);

const expectFocusAt = (page, where, message) => expect.poll(
  () => focusAt(page, where),
  { message, timeout: 5_000 }
).toEqual({ inside: true, seen: true });

// The top of the page, settled, so a scroll the press makes shows.
const toTop = async (order) => {
  await order.scrollSettled();
  await order.page.evaluate(() => scrollTo(0, 0));
  await order.scrollSettled();
};

// The on-farm time a customer chooses, the day's first.
const chooseTime = async (page) => {
  const first = page.locator("[data-windows] [name='onfarm.window']")
    .first();

  await first.check();
  await expect(first).toBeChecked();
};

test.describe("Proceed to checkout says why, and goes to what is " +
  "missing (#706)", () => {
  test("A tap on Proceed to checkout while it cannot go on always " +
    "explains why; it is never a dead button", async ({ page }) => {
    const cases = [
      { name: "an empty cart", cart: null },
      { name: "an empty cart by delivery", cart: null, method: "delivery" },
      {
        name: "a delivery below the minimum", cart: { eggs: 1 },
        method: "delivery",
      },
      // Stock not yet known (#333): /api/stock held unanswered. Last,
      // since the hold stays for the rest of the test.
      { name: "stock not yet known", cart: { wings: 5 }, hold: true },
    ];

    for (const c of cases) {
      await test.step(c.name, async () => {
        if (c.hold) await page.route("**/api/stock*", () => {});

        const order = new OrderPage(page);

        await order.open(c.cart, { method: c.method });
        await expect(order.next, "it looks disabled")
          .toHaveAttribute("aria-disabled", "true");
        await expect(order.next, "but takes the press")
          .not.toHaveAttribute("disabled");
        await press(order.next);
        await expect.poll(async () => (await described(order.next))
          .texts.length, {
          message: `${c.name}: the press is explained`, timeout: 5_000,
        }).toBeGreaterThan(0);
      });
    }
  });

  for (const day of DAYS) {
    test.describe(`on ${day}`, () => {
      test.beforeEach(({ context, baseURL }) => onDay(context, baseURL,
        day));

      test("For a delivery below the minimum, the tap shows a tooltip " +
        "reading the minimum and the current order, filled in from the " +
        "data and the cart", async ({ page }) => {
        const { deliveryMinimum: MIN } = moneyFor(day);

        for (const eggs of [1, 3]) {
          await test.step(`${eggs} dozen eggs`, async () => {
            const order = new OrderPage(page);

            // OrderPage.open waits for the on-farm dates, and the local
            // build's pickup schedule reaches six weeks past the build
            // (bin/dev-schedule.mjs), so a later day may offer none:
            // there it waits for the delivery dates, as pricing.spec
            // does.
            if (day === TODAY) {
              await order.open({ eggs }, { method: "delivery" });
            } else {
              await page.goto(`/order/?add=${addQuery({ eggs })}`, {
                waitUntil: "domcontentloaded",
              });
              await expect(page.locator("#delivery-date")).toBeEnabled();
              await page.evaluate(() => document.fonts.ready.then(() => {}));
              // ?add= scrolls the cart into view after load.
              await page.waitForTimeout(1_000);
              await order.method("delivery");
            }

            // The current order is what the minimum is measured on:
            // the goods after discounts, never the delivery fee (the
            // cart's Total adds it). Eggs alone take no discount, so
            // it is the cart's Subtotal.
            await expect(order.discountRow).toBeHidden();

            const current = (await order.subtotal.textContent()).trim();

            expect(Number(current.replace(/\D/g, "")),
              "the cart is below the minimum").toBeLessThan(MIN);
            await press(order.next);
            await expect.poll(async () => (await described(order.next))
              .tips, { timeout: 5_000 }).toEqual([
              `Delivery orders have a $${MIN} minimum (current order ` +
              `is ${current}). Please add more to your cart or choose a ` +
              "different pick-up option.",
            ]);
          });
        }
      });
    });
  }

  test("While that tooltip shows, the cart is expanded and the pickup " +
    "method button pulses, as the expand button does",
  async ({ page }) => {
    const order = new OrderPage(page);
    const pill = order.cart.locator("[data-cart-toggle]");

    await order.open({ eggs: 1 }, { method: "delivery" });
    // Folded first wherever it folds, so expanding it is the press's.
    // Looked for once the page is still: on an iPhone the scroll to
    // the cart ends with it settled, its pill gone.
    await order.scrollSettled();
    if (await pill.isVisible()) await foldCart(page, order.cart);
    await press(order.next);

    // One look at all three at once: the tooltip up, the pane open
    // and the way's button running the pill's pulse.
    const look = () => page.evaluate(() => {
      const pane = document.getElementById("order-cart");
      const next = pane.querySelector("[data-checkout]");
      const way = pane.querySelector("[data-way-toggle]");
      const ids = (next.getAttribute("aria-describedby") || "")
        .split(/\s+/).filter(Boolean);
      const tip = ids.map((id) => document.getElementById(id))
        .some((node) => node && node.getAttribute("role") === "tooltip"
          && node.getBoundingClientRect().height > 0);
      const pulse = way.getAnimations().some((a) => /^order-pill/
        .test(a.animationName || "") && a.playState === "running");

      return { tip, open: pane.dataset.fold === "open", pulse };
    });

    await expect.poll(look, {
      message: "the tooltip, the open pane and the pulse together",
      timeout: 5_000, intervals: [50],
    }).toEqual({ tip: true, open: true, pulse: true });
  });

  test("A new visitor gets on-farm pickup and the first available day " +
    "as today, but no pickup time selected until they choose one",
  async ({ page }) => {
    const order = new OrderPage(page);
    const select = page.locator("#onfarm-date");
    const times = page.locator("[data-windows] [name='onfarm.window']");

    await order.open({ wings: 5 });
    await expect(page.locator("#method-onfarm")).toBeChecked();

    const first = await select.locator("option").evaluateAll(
      (options) => options.map((o) => o.value).find(Boolean)
    );

    await expect(select).toHaveValue(first);
    await expect.poll(() => times.count(), {
      message: "the first day offers its times",
    }).toBeGreaterThan(0);
    await expect(page.locator(
      "[data-windows] [name='onfarm.window']:checked"
    )).toHaveCount(0);
  });

  test("With no pickup time chosen, Proceed to checkout scrolls to and " +
    "focuses the selected pickup option and shows its message, the " +
    "same way for all three methods", async ({ page }) => {
    const ways = [
      {
        way: "onfarm", slot: "onfarm.window",
        text: "Please select a pick-up time.",
      },
      {
        way: "scheduled", slot: "fulfilment.occurrence",
        text: "Choose a pick-up day and place.",
      },
      {
        way: "delivery", slot: "delivery.address1",
        text: "Please enter your street address.",
      },
    ];

    for (const w of ways) {
      await test.step(w.way, async () => {
        const order = new OrderPage(page);

        await order.open({ wings: 5 }, { method: w.way });
        await toTop(order);
        await press(order.next);
        await expect(page.locator(`[data-error-for='${w.slot}']`))
          .toHaveText(w.text);
        await expect(page.locator(`[data-error-for='${w.slot}']`))
          .toBeVisible();
        await expectFocusAt(page, { way: w.way },
          `${w.way}: the focus is on its option, on screen`);
      });
    }
  });

  test("With pickup or delivery complete, Proceed to checkout goes to " +
    "the next section still missing something: contact information, " +
    "then payment, then Place your order", async ({ page }) => {
    const complete = {
      onfarm: (order) => chooseTime(order.page),
      scheduled: (order) => order.scheduled(),
      delivery: (order) => order.delivery(),
    };

    // Contact first, whichever way is complete.
    for (const [way, fill] of Object.entries(complete)) {
      await test.step(`${way}: contact information`, async () => {
        const order = new OrderPage(page);

        await order.open({ wings: 5 }, { method: way });
        await fill(order);
        await toTop(order);
        await press(order.next);
        await expectFocusAt(page, { selector: SECTION.contact },
          `${way}: to Contact information`);
      });
    }

    // Then payment, then Place your order, on one page.
    await test.step("payment, then Place your order", async () => {
      const order = new OrderPage(page);

      await order.open({ wings: 5 });
      await chooseTime(page);
      await order.contact({
        email: "checkout-go@example.com", phone: "401-555-0100",
      });
      // The card form open and empty: Square's starts empty, the fake
      // SDK's (a local build) starts filled, so it is emptied.
      await order.openCard();

      const fake = page.locator("[data-fake-card] [name='cardNumber']");

      if (await fake.count()) await fake.fill("");
      await toTop(order);
      await press(order.next);
      await expectFocusAt(page, { selector: SECTION.payment },
        "to Payment, the card not yet entered");

      await order.card();
      await toTop(order);
      await press(order.next);
      await expectFocusAt(page, { selector: SECTION.confirm },
        "to Place your order, everything entered");
    });
  });
});

// #1013: the go-to held every time, not once. The test above checks
// each go-to once per run, and on the iphone project its Payment step
// failed or flaked in about half of runs on next at 78d9af3e: the
// smooth scroll toward the section stopped short of it while the focus
// went in. So each go-to here runs ROUNDS times in one run, each round
// on a fresh page load, and any one of them failing fails the test.
//
// Fresh loads, not one page sent to each section in turn: Square's card
// field (staging) cannot be emptied once entered, so a page goes to
// Payment once. The load is also where a customer starts.
//
// No retries: a retry would pass a fault that shows only some of the
// time, and catching that is what these are for. The repetition inside
// each test stands in for them.
//
// Each round starts from a fresh draft. The form keeps what was entered
// in localStorage and restores it on the next load, so without this
// round 2 opened with round 1's pickup time chosen, and "none chosen"
// was false from there on (proof runs at 75b34250, all projects).
const ROUNDS = 6;

// The order form's draft and pending submission gone from this origin's
// localStorage, as pickup-hint.spec.mjs's freshDraft does (the keys,
// nff-order-draft and nff-order-pending, are assets/scripts/order/
// draft.js's). Called on the order page, before the next load: the form
// saves on a change, not on unload, so the draft stays gone.
const freshDraft = (page) => page.evaluate(() => {
  for (const key of Object.keys(localStorage)) {
    if (/^nff-order-(draft|pending)/.test(key)) localStorage.removeItem(key);
  }
});

// A round's fresh start: the draft gone, then the page left for
// about:blank, as support/staging.mjs's leavePage leaves one, before the
// next load. Opening the same /order/?add= URL from the page itself is
// taken as a reload, and on phone and iphone the browser then puts the
// form's fields back, round 1's pickup time among them, which the form
// saves again (#1013: round 2 failed "none chosen" there with the draft
// already cleared). From about:blank the load is a new one, with
// nothing to put back.
const freshRound = async (page) => {
  await freshDraft(page);
  await page.goto("about:blank");
};

// The draft keys gone again at the start of every load, in the top
// frame, before the page's own scripts run, so a round starts fresh
// whoever wrote the draft last (#1013: with freshRound alone, rounds 2
// to 6 still opened on phone and iphone with a pickup time chosen,
// since a save on the page being left, which writes the form as it
// stands, can land after freshDraft). It is added to the page of each
// round test alone, and holds for every later load of that page in
// the test: each load of /order/ there starts with no draft, which is
// what each round wants, and the round tests load nothing else.
const clearDraftAtLoad = (page) => page.addInitScript(() => {
  if (window !== window.top) return;
  try {
    for (const key of Object.keys(localStorage)) {
      if (/^nff-order-(draft|pending)/.test(key)) localStorage.removeItem(key);
    }
  } catch {
    // An about:blank page has no localStorage: nothing to clear there.
  }
});

test.describe("A step that sends the customer on to a section leaves " +
  "it in view and focused, every time (#706, #1013)", () => {
  test.describe.configure({ retries: 0 });

  // Proceed to checkout's go-to (goTo in order-form.js): to Payment
  // while the card is not entered, then to Place your order. Two per
  // round.
  test("Every time, Proceed to checkout brings Payment, then Place " +
    "your order, into view with the focus in it", async ({ page }) => {
    test.setTimeout(ROUNDS * 60_000);
    await clearDraftAtLoad(page);

    for (let round = 1; round <= ROUNDS; round += 1) {
      await test.step(`round ${round} of ${ROUNDS}`, async () => {
        const order = new OrderPage(page);

        if (round > 1) await freshRound(page);
        await order.open({ wings: 5 });
        await chooseTime(page);
        await order.contact({
          email: "checkout-go@example.com", phone: "401-555-0100",
        });
        // Open and empty, as in the test above.
        await order.openCard();

        const fake = page.locator("[data-fake-card] [name='cardNumber']");

        if (await fake.count()) await fake.fill("");
        await toTop(order);
        await press(order.next);
        await expectFocusAt(page, { selector: SECTION.payment },
          `round ${round}: to Payment, the card not yet entered`);

        await order.card();
        await toTop(order);
        await press(order.next);
        await expectFocusAt(page, { selector: SECTION.confirm },
          `round ${round}: to Place your order, everything entered`);
      });
    }
  });

  // The errors' go-to (Errors.show in errors.js: the first field in
  // error brought into view, then focused), which Proceed to checkout
  // reaches by its own path, not goTo: to the way's pickup time while
  // none is chosen, then, with one chosen, to Contact information. Two
  // per round, on one page, since nothing here needs emptying.
  test("Every time, the errors Proceed to checkout shows bring the " +
    "first field in error into view with the focus on it",
  async ({ page }) => {
    test.setTimeout(ROUNDS * 60_000);
    await clearDraftAtLoad(page);

    for (let round = 1; round <= ROUNDS; round += 1) {
      await test.step(`round ${round} of ${ROUNDS}`, async () => {
        const order = new OrderPage(page);

        if (round > 1) await freshRound(page);
        await order.open({ wings: 5 });
        await toTop(order);
        await press(order.next);
        await expectFocusAt(page, { way: "onfarm" },
          `round ${round}: to the pickup time, none chosen`);

        await chooseTime(page);
        await toTop(order);
        await press(order.next);
        await expectFocusAt(page, { selector: SECTION.contact },
          `round ${round}: to Contact information, none entered`);
      });
    }
  });
});

// #1013, the cause and not the weather. The tests above fail only where
// WebKit is slow enough to have drawn little of the smooth scroll when
// the focus lands (5 of 7 slow runners, 0 of 7 fast ones), and
// Playwright cannot slow WebKit's CPU. The order of what the page does
// is the same on every runner, so this test reads that order.
//
// Before each press, watchGoTo arms a watch in the page:
// - the scroll's start: the first smooth scrollIntoView call (patched
//   on Element.prototype, the native one still run) whose element lies
//   in the destination or holds it;
// - its end: the viewport's scrollend, or, where the engine fires none
//   ("onscrollend" absent, or the scroll cut short before one), the
//   scroll settled, no scroll event for SETTLED_MS;
// - each focusin, and each later scrollIntoView call, between the two.
// A focus change between start and end is the fault: the go-to has
// moved the focus while its own scroll was under way. A go-to that
// focuses first and scrolls after, or scrolls and focuses once the
// scroll has ended, passes; one that focuses straight after starting
// the scroll fails, on any runner and in any engine.
//
// Each test records, as a "scrollend" annotation, whether the engine
// has scrollend and whether the viewport fired one, so a run's report
// says what WebKit on the runner does.
const SETTLED_MS = 300;

const watchGoTo = (page, selector) => page.evaluate(({ sel, quiet }) => {
  const now = () => performance.now();
  const name = (node) => {
    if (!node || node === document || node === window) return "document";
    if (node.id) return `#${node.id}`;

    const tag = node.tagName.toLowerCase();
    const field = node.getAttribute("name");
    const home = node.closest("[id]");

    return `${tag}${field ? `[name='${field}']` : ""}`
      + `${home ? ` in #${home.id}` : ""}`;
  };
  const viewport = (target) => target === document || target === window
    || target === document.documentElement || target === document.body;

  if (!window.goToWatch) {
    const watch = { log: [] };
    const native = Element.prototype.scrollIntoView;

    window.goToWatch = watch;
    Element.prototype.scrollIntoView = function scrollIntoView(arg) {
      if (watch.armed && !watch.ended) {
        const smooth = !!arg && typeof arg === "object"
          && arg.behavior === "smooth";
        const to = document.querySelector(watch.sel);
        const toward = !!to && (to.contains(this) || this.contains(to));

        if (!watch.started && smooth && toward) {
          watch.started = true;
          watch.last = now();
          watch.log.push({ type: "start", what: name(this) });
        } else if (watch.started) {
          watch.log.push({ type: "scroll-call", what: name(this), smooth });
        }
      }

      return native.call(this, arg);
    };
    addEventListener("focusin", (e) => {
      if (watch.armed && !watch.ended) {
        watch.log.push({ type: "focusin", what: name(e.target) });
      }
    }, true);
    addEventListener("scroll", () => {
      if (watch.started && !watch.ended) watch.last = now();
    }, true);
    addEventListener("scrollend", (e) => {
      if (!viewport(e.target)) return;
      watch.fired = true;
      if (watch.started && !watch.ended) {
        watch.ended = true;
        watch.log.push({ type: "scrollend" });
      }
    }, true);
    setInterval(() => {
      if (watch.started && !watch.ended && now() - watch.last > quiet) {
        watch.ended = true;
        watch.log.push({ type: "settled" });
      }
    }, 50);
  }

  Object.assign(window.goToWatch, {
    log: [], sel, armed: true, started: false, ended: false, fired: false,
    last: 0, has: "onscrollend" in window,
  });
}, { sel: selector, quiet: SETTLED_MS });

// The watch's record once the scroll has ended: whether it started and
// ended, the focus changes between, and the whole log for the message.
const goToOrder = async (page, label) => {
  await expect.poll(() => page.evaluate(() => window.goToWatch.ended), {
    message: `${label}: the go-to's smooth scroll starts and ends`,
    timeout: 10_000,
  }).toBe(true);

  return page.evaluate(() => {
    const { log, fired, has } = window.goToWatch;
    const start = log.findIndex((e) => e.type === "start");
    const end = log.findIndex((e) => e.type === "scrollend"
      || e.type === "settled");
    const between = start < 0 ? [] : log.slice(start + 1, end < 0
      ? log.length : end);

    window.goToWatch.armed = false;

    return {
      verdict: {
        started: start >= 0,
        ended: end > start,
        focusDuring: between.filter((e) => e.type === "focusin")
          .map((e) => e.what),
      },
      log: log.map((e) => `${e.type}${e.what ? ` ${e.what}` : ""}`),
      scrollend: { has, fired },
    };
  });
};

test.describe("While a step's smooth scroll to a section is under way, " +
  "nothing the page does ends it early (#706, #1013)", () => {
  // The order is the code's, the same on every try: a retry only
  // repeats the failure.
  test.describe.configure({ retries: 0 });

  test("The focus does not move between the start of a go-to's smooth " +
    "scroll and its end, and the section ends in view with the focus " +
    "in it", async ({ page }) => {
    const order = new OrderPage(page);

    // One go-to, watched: the order checked softly, so every go-to of
    // the run reports, then the section in view with the focus in it.
    const goTo = async (label, where, watchFor) => {
      await toTop(order);
      await watchGoTo(page, watchFor);
      await press(order.next);

      const got = await goToOrder(page, label);

      test.info().annotations.push({
        type: "scrollend",
        description: `${label}: has ${got.scrollend.has}, fired `
          + `${got.scrollend.fired}`,
      });
      expect.soft(got.verdict,
        `${label}: no focus change during the scroll (${got.log.join(", ")})`)
        .toEqual({ started: true, ended: true, focusDuring: [] });
      await expectFocusAt(page, where, `${label}: in view, focused`);
    };

    // One page sent to each section in turn, four go-tos by both paths:
    // Errors.show (errors.js) to the pickup time, then goTo
    // (order-form.js) to Contact information, Payment and Place your
    // order. The card comes last, so nothing needs emptying twice.
    await order.open({ wings: 5 });

    await test.step("the errors' go-to: to the pickup time, none chosen",
      () => goTo("to the pickup time", { way: "onfarm" }, "#pickup"));

    await chooseTime(page);
    await test.step("to Contact information, none entered",
      () => goTo("to Contact information", { selector: SECTION.contact },
        SECTION.contact));

    await order.contact({
      email: "checkout-go@example.com", phone: "401-555-0100",
    });
    // Open and empty, as in the #706 test above.
    await order.openCard();

    const fake = page.locator("[data-fake-card] [name='cardNumber']");

    if (await fake.count()) await fake.fill("");
    await test.step("to Payment, the card not yet entered",
      () => goTo("to Payment", { selector: SECTION.payment },
        SECTION.payment));

    await order.card();
    await test.step("to Place your order, everything entered",
      () => goTo("to Place your order", { selector: SECTION.confirm },
        SECTION.confirm));
  });
});
