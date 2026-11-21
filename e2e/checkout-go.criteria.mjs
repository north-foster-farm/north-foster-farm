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
    if (await pill.isVisible()) {
      await order.scrollSettled();
      await foldCart(page, order.cart);
    }
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
        text: "Please select a pickup time.",
      },
      {
        way: "scheduled", slot: "fulfilment.occurrence",
        text: "Choose a pickup day and place.",
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
