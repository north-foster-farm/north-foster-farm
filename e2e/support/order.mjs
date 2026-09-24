// The order page, driven the way a customer drives it. Every spec
// starts from a fresh browser context, so the draft in localStorage
// never leaks between tests.

import { test as base, expect } from "@playwright/test";

// SKUs and prices from data/catalog.json (price list 2026-v6). The
// sums below are chosen to land on the thresholds in
// data/delivery.json.
export const SKU = {
  eggs: "NFF-CHK-EGG-LG", // $7
  wings: "NFF-CHK-WNG-0000-0200", // $10
  thighs: "NFF-CHK-THGBN-0000-0150", // $12
  drums: "NFF-CHK-DRM-0000-0150", // $8
  whole: "NFF-CHK-WHL-0200-0250", // $20
  breasts: "NFF-CHK-BRSBL-0000-0125", // $15
  sausage: "NFF-CHK-SAUMPL-0075-0125", // $18
  necks: "NFF-CHK-NCK-0075-0125", // $5
};

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
  // The staging toolbar polls the outbox, which needs a token; with a
  // wrong one it asks again and again. Tests start with it hidden (its
  // own "Hide", per tab) and answer any prompt once, then dismiss.
  hideToolbar: [true, { option: true }],
  page: async ({ page, hideToolbar }, use) => {
    if (hideToolbar) {
      await page.addInitScript(() => {
        try {
          sessionStorage.setItem("staging.hidden", "1");
        } catch {
          // Storage off: the toolbar shows, and the prompt handler
          // below answers it.
        }
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
  async open(cart = null) {
    const query = cart ? `?add=${addQuery(cart)}` : "";

    await this.page.goto(`/order/${query}`);
    await expect(this.page.locator("#onfarm-date")).toBeEnabled();
    // ?add= scrolls the cart into view 300 ms after load, smoothly; a
    // test that scrolls first would be scrolled back. Let it finish.
    if (cart) await this.page.waitForTimeout(1_000);
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
  async showRow(name) {
    const floating = await this.cart.evaluate(
      (el) => el.dataset.stuck === "true" && el.dataset.open === "true"
    );

    if (floating) {
      await this.cart.locator("[data-cart-toggle]").click();
      await expect(this.cart).toHaveAttribute("data-open", "false");
    }
    await this.item(name).evaluate(
      (el) => el.scrollIntoView({ block: "center" })
    );

    return this.item(name);
  }

  // The radio is visually replaced by its card, so click the label.
  async method(value) {
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

  async delivery({
    address1 = "1 Test Lane", town = "Scituate", zip = "02857",
    cooler = "By the front steps",
  } = {}) {
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
    await this.cardChoose.click();
    await expect(this.submit).toBeVisible();
    await expect(this.submit).toBeEnabled();
  }

  cardFrame() {
    return this.page.frameLocator(
      "iframe[src*='single-card-element-iframe']"
    );
  }

  async card(number = "4111111111111111", {
    expiry = "12/30", cvv = "111", postal = "11111",
  } = {}) {
    const f = this.cardFrame();

    await f.locator("#cardNumber").fill(number);
    await f.locator("#expirationDate").fill(expiry);
    await f.locator("#cvv").fill(cvv);
    await f.locator("#postalCode").fill(postal);
  }

  // Presses Pay and waits for the server's answer to /api/orders.
  async pay() {
    const answer = this.page.waitForResponse(
      (r) => r.url().includes("/api/orders") && r.request().method() === "POST",
      { timeout: 60_000 }
    );

    await this.submit.click();

    const res = await answer;

    if (res.status() === 204) {
      throw new Error("Dropped with 204: the order endpoint's rate limit " +
        "(12 per 10 minutes per IP) was hit. Wait ten minutes and run " +
        "again.");
    }

    return { status: res.status(), body: await res.json().catch(() => null) };
  }

  errorFor(key) {
    return this.page.locator(`[data-error-for='${key}']:visible`);
  }
}
