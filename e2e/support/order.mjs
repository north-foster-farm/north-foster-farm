// The order page, driven the way a customer drives it. Every spec
// starts from a fresh browser context, so the draft in localStorage
// never leaks between tests.

import { test as base, expect } from "@playwright/test";

import { orderLimitHeaders } from "./staging.mjs";

// SKUs and prices from data/catalog.json (price list 2026-v9). The
// sums below are chosen to land on the thresholds in
// data/delivery.json.
export const SKU = {
  eggs: "NFF-CHK-EGG-LG", // $7
  wings: "NFF-CHK-WNG-10-19", // $10
  thighs: "NFF-CHK-THGBN-10-14", // $12
  drums: "NFF-CHK-DRM-10-14", // $8
  whole: "NFF-CHK-WHL-20-24", // $20
  breasts: "NFF-CHK-BRSBL-10-12", // $15
  sausage: "NFF-CHK-SAUMPL", // $18
  necks: "NFF-CHK-NCK-10-19", // $5
};

// Folds or opens a floating cart as a customer does, with its pill
// (#477): one fold at every width, data-fold open or closed. What
// closed hides is the stylesheet's: a phone keeps the total row and
// the foot, a panel its right column.
const setFold = async (cart, fold) => {
  if (await cart.getAttribute("data-fold") !== fold) {
    await cart.locator("[data-cart-toggle]").click();
  }
  await expect(cart).toHaveAttribute("data-fold", fold);
};

export const foldCart = (page, cart) => setFold(cart, "closed");
export const unfoldCart = (order) => setFold(order.cart, "open");

// A cart as ?add= wants it: { eggs: 2 } -> "NFF-CHK-EGG-LG:2".
export const addQuery = (cart) => Object.entries(cart)
  .map(([name, qty]) => `${SKU[name] || name}:${qty}`)
  .join(",");

// A cart of 20 items across seven categories, $199 before discounts:
// as long as the one in the 2026-09-24 walkthrough, and one dollar
// short of the top tier, so the nudge still has something to say.
export const FULL_CART = {
  eggs: 3, wings: 4, thighs: 3, drums: 2, breasts: 2, sausage: 2, necks: 4,
};

// A unique address per test, so rate limits, records and the outbox
// never collide between runs. example.com never receives mail.
export const uniqueEmail = (tag) => `qa-e2e-${tag}-${Date.now().toString(36)}${
  Math.random().toString(36).slice(2, 6)}@example.com`;

export const test = base.extend({
  // The staging toolbar sits over the page, and it polls the outbox,
  // which needs a token; with a wrong one it asks again and again.
  // Tests start with it out of sight (a style: its own "Hide" no
  // longer lasts past a reload, e5c2072) and answer any prompt once,
  // then dismiss.
  hideToolbar: [true, { option: true }],
  page: async ({ page, hideToolbar }, use) => {
    if (hideToolbar) {
      // The toolbar's first request is refused (401), it asks for a
      // token and sends the request again without reading the first
      // answer, so the page never reaches "networkidle". Answered
      // here with a 403 it neither asks nor waits.
      await page.route("**/api/staging/**", (route) => route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "Stubbed by the QA suite." }),
      }));
      await page.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          const style = document.createElement("style");

          style.textContent = "#staging { display: none !important; }";
          document.head.append(style);
        });
      });
    }

    let answered = false;

    page.on("dialog", async (dialog) => {
      if (dialog.type() === "prompt" && !answered) {
        answered = true;
        await dialog.accept("qa");
      } else {
        await dialog.dismiss();
      }
    });
    await use(page);
  },
});

export { expect };

// Which payment drivers are the fakes here: none on any Netlify deploy,
// both on a local run (SQUARE_ENV and PAYPAL_ENV fake work only where
// SITE_CONTEXT is dev; netlify/functions/lib/fake.mjs).
export const paymentFakes = async (request) => {
  const res = await request.get("/api/checkout/config");
  const cfg = res.ok() ? await res.json() : {};

  return {
    square: !!cfg.square && cfg.square.env === "fake",
    paypal: !!cfg.paypal && cfg.paypal.env === "fake",
  };
};

// The scheduled pickup radios, their values, and the one chosen.
export const pickupRadios = (page) => page.locator(
  "#scheduled-pickups input"
);
export const pickupValues = (page) => pickupRadios(page)
  .evaluateAll((inputs) => inputs.map((i) => i.value));
export const pickupChosen = (page) => page.locator(
  "#scheduled-pickups input:checked"
);

export class OrderPage {
  constructor(page) {
    this.page = page;
    this.cart = page.locator("#order-cart");
    this.total = page.locator("#order-cart [data-total='total']");
    this.subtotal = page.locator("#order-cart [data-total='subtotal']");
    this.discountRow = page.locator("#order-cart [data-total-row='discount']");
    this.discountLabel = page.locator(
      "#order-cart [data-total='discount-label']"
    );
    this.discount = page.locator("#order-cart [data-total='discount']");
    this.feeRow = page.locator("#order-cart [data-total-row='fee']");
    this.fee = page.locator("#order-cart [data-total='fee']");
    this.count = page.locator("#order-cart [data-cart-count]");
    this.nudge = page.locator("#order-cart [data-nudge]");
    this.next = page.locator("#order-cart [data-checkout]");
    this.short = page.locator("[data-delivery-short]");
    // The field opens from Add discount, over the cart's shared row
    // (#203).
    this.codeOpen = page.locator("#order-cart [data-code-toggle]");
    this.codeInput = page.locator("#order-code");
    this.codeApply = page.locator("[data-code-apply]");
    this.codeNote = page.locator("[data-code-note]");
    this.zip = page.locator("#delivery-zip");
    this.zipNote = page.locator("[data-zip-note]");
    this.submit = page.locator("#order-submit");
    this.cardChoose = page.locator("[data-card-choose]");
    this.payError = page.locator("[data-error-for='payment']");
    this.result = page.locator("#order-result");
  }

  // Opens /order/, optionally with a cart, and waits for the dates.
  // On-farm pickup is chosen on load (#196); `method` chooses another
  // way, as a customer would.
  async open(cart = null, { method } = {}) {
    const query = cart ? `?add=${addQuery(cart)}` : "";

    await this.page.goto(`/order/${query}`);
    await expect(this.page.locator("#onfarm-date")).toBeEnabled();
    // ?add= scrolls the cart into view 300 ms after load, smoothly; a
    // test that scrolls first would be scrolled back. Let it finish.
    if (cart) await this.page.waitForTimeout(1_000);
    if (method) await this.method(method);
  }

  item(name) {
    return this.page.locator(`.order-item[data-sku='${SKU[name] || name}']`);
  }

  qty(name) {
    return this.page.locator(`[data-qty='${SKU[name] || name}']`);
  }

  // Below xl an open cart floats over the bottom of the catalog (on a
  // phone, most of it), and the sticky topbar covers the top. A
  // customer folds the cart and scrolls the row to the middle; so do
  // the tests, before they press a row's buttons.
  // Until the page stops scrolling: a smooth scroll the page started
  // (choosing a method scrolls to its date) would override ours.
  async scrollSettled() {
    await this.page.evaluate(() => new Promise((done) => {
      let last = scrollY;
      let still = 0;
      const tick = () => {
        still = scrollY === last ? still + 1 : 0;
        last = scrollY;
        if (still >= 10) done();
        else requestAnimationFrame(tick);
      };

      requestAnimationFrame(tick);
    }));
  }

  // Scroll first: a cart that settled below opens in full. The scroll
  // up floats it hidden since #274 round 5 (it floated open, a28065b),
  // but a cart that never settled may still be open.
  async showRow(name) {
    await this.scrollSettled();
    await this.item(name).evaluate(
      (el) => el.scrollIntoView({ block: "center" })
    );
    // The cart's scroll watch runs on the next frames.
    await this.scrollSettled();

    // A closed pane floats over the foot or a corner only, and the row
    // at the middle is clear of it; an open one covers it (#477).
    const floating = await this.cart.evaluate(
      (el) => el.dataset.placement === "floating"
        && el.dataset.fold === "open"
    );

    if (floating) {
      await foldCart(this.page, this.cart);
      await this.item(name).evaluate(
        (el) => el.scrollIntoView({ block: "center" })
      );
    }

    return this.item(name);
  }

  // The radio is visually replaced by its card, so click the label.
  async method(value) {
    // A tap mid-scroll can land beside the card (WebKit, now and then).
    await this.scrollSettled();
    await this.page.locator(`label[for='method-${value}']`).click();
    await expect(this.page.locator(`#method-${value}`)).toBeChecked();
  }

  async contact({ first = "QA", last = "Tester", email, phone } = {}) {
    await this.page.locator("#customer-first-name").fill(first);
    await this.page.locator("#customer-last-name").fill(last);
    if (email) await this.page.locator("#customer-email").fill(email);
    if (phone) await this.page.locator("#customer-phone").fill(phone);
  }

  // The first offered date for the chosen method.
  async firstDate(method) {
    const select = this.page.locator(`#${method}-date`);

    await expect(select).toBeEnabled();

    const value = await select.locator("option").evaluateAll(
      (options) => options.map((o) => o.value).find(Boolean)
    );

    await select.selectOption(value);

    return value;
  }

  // Chooses scheduled pickup and the first occurrence of a series
  // (the drop site's, `VFVQ`, by default); returns the occurrence id
  // chosen. The pickups are a list of radios whose values are
  // occurrence ids, "<code>-<YYMMDD>"; none is chosen until one is.
  async scheduled(code = "VFVQ") {
    await this.method("scheduled");
    await expect(pickupRadios(this.page).first()).toBeVisible();

    const value = (await pickupValues(this.page))
      .find((v) => v.startsWith(`${code}-`));

    expect(value, `a ${code} occurrence on offer`).toBeTruthy();
    await this.page.locator(`#scheduled-pickups input[value='${value}']`)
      .check();

    return value;
  }

  async delivery({
    address1 = "1 Test Lane", town = "Scituate", zip = "02857",
    cooler = "By the front steps",
  } = {}) {
    await this.method("delivery");
    await this.page.locator("#delivery-address1").fill(address1);
    await this.page.locator("#delivery-town").fill(town);
    await this.zip.fill(zip);
    await this.page.locator("#delivery-cooler").fill(cooler);
  }

  // Waits for Square's card form and opens it; the Pay button shows
  // only once Card is chosen.
  async openCard() {
    await this.page.locator("#payment").scrollIntoViewIfNeeded();
    await expect(this.page.locator("[data-pay]")).toHaveAttribute(
      "data-pay-state", /ready|venmo-only/, { timeout: 30_000 }
    );
    // The state turns ready before the panel's skeleton clears (it
    // waits for the wallets too), and the fields stay unseen under it:
    // a spec that typed at once found them hidden for its whole wait.
    await expect(this.page.locator("#pay-card-panel"))
      .not.toHaveAttribute("data-load", /./, { timeout: 30_000 });
    await this.cardChoose.click();
    await expect(this.submit).toBeVisible();
    await expect(this.submit).toBeEnabled();
  }

  cardFrame() {
    return this.page.frameLocator(
      "iframe[src*='single-card-element-iframe']"
    );
  }

  // Fills Square's card field, or the stub SDK's plain fields where
  // payments are fake (a local run, as CI's e2e makes; docs/order-form.md).
  async card(number = "4111111111111111", {
    expiry = "12/30", cvv = "111", postal = "11111",
  } = {}) {
    const fake = this.page.locator("[data-fake-card]");
    const frame = this.page.locator(
      "iframe[src*='single-card-element-iframe']"
    );

    await expect(fake.or(frame)).toBeVisible();
    if (await fake.count()) {
      await fake.locator("[name='cardNumber']").fill(number);
      await fake.locator("[name='expirationDate']").fill(expiry);
      await fake.locator("[name='cvv']").fill(cvv);
      await fake.locator("[name='postalCode']").fill(postal);
      return;
    }

    const f = this.cardFrame();

    await f.locator("#cardNumber").fill(number);
    await f.locator("#expirationDate").fill(expiry);
    await f.locator("#cvv").fill(cvv);
    await f.locator("#postalCode").fill(postal);
  }

  // Presses Pay and waits for the server's answer to /api/orders.
  // `limited` lets the rate-limit spec see its 429: the post then goes
  // without the staging token, so the limit applies.
  async pay({ limited = false } = {}) {
    const headers = limited ? {} : orderLimitHeaders();

    if (Object.keys(headers).length) {
      await this.page.route("**/api/orders", (route) => (
        route.request().method() === "POST"
          ? route.continue({
            headers: { ...route.request().headers(), ...headers },
          })
          : route.fallback()
      ));
    }

    const answer = this.page.waitForResponse(
      (r) => r.url().includes("/api/orders") && r.request().method() === "POST",
      { timeout: 60_000 }
    );

    await this.submit.click();

    const res = await answer;

    if (res.status() === 429 && !limited) {
      throw new Error("Answered 429: the order endpoint's rate limit " +
        "(12 per 10 minutes per IP) was hit. Wait ten minutes and run " +
        "again.");
    }

    return { status: res.status(), body: await res.json().catch(() => null) };
  }

  errorFor(key) {
    return this.page.locator(`[data-error-for='${key}']:visible`);
  }
}
