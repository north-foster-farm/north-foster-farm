// The payment section: the card form and the wallet buttons from
// Square's Web Payments SDK, and the Venmo button from PayPal's. The
// SDKs load once the section is near the screen, from the hosts the
// content-security policy allows, with the ids /api/checkout/config
// gives for this deploy. Nothing here talks to our server about the
// order: it turns a card or a wallet into a token and hands it to the
// form, or runs the Venmo approval and hands the form the PayPal
// order to capture. The form validates first, every time.
//
// What the form gives:
//   prepare()            validate now; -> the payload, or null after
//                        showing the errors (synchronous: Apple Pay
//                        must tokenise inside the click)
//   prepareAsync()       the same plus a stock check, for buttons that
//                        can wait
//   amount()             the total in cents, for the wallets' sheets
//   billing()            the customer's details for card verification
//   pay(payload, source) send { method, sourceId }
//   venmoCreate(payload) -> the PayPal order id from our server
//   venmoCapture(payload, paypalOrderId)

import { venmoGate } from "./lib/venmo.mjs";

const qs = (root, selector) => root.querySelector(selector);

const VENMO = "nff-venmo";

// Whether this browser sees the Venmo button (lib/venmo.mjs).
const venmoShown = (hidden) => {
  let remembered = false;

  try {
    remembered = window.localStorage.getItem(VENMO) === "1";
  } catch {
    // Storage blocked: ?venmo still works for this page view.
  }

  const { show, remember } = venmoGate(hidden, location.search, remembered);

  try {
    if (remember) {
      window.localStorage.setItem(VENMO, "1");
    } else {
      window.localStorage.removeItem(VENMO);
    }
  } catch {
    // As above.
  }

  return show;
};

const loaded = new Map();

const loadScript = (src) => {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");

      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loaded.delete(src);
        reject(new Error(`Could not load ${src}`));
      };
      document.head.appendChild(s);
    }));
  }

  return loaded.get(src);
};

const money = (cents) => (cents / 100).toFixed(2);

// What the SDK says when a card will not tokenise, in our words.
const tokenMessage = (result) => {
  const first = result && result.errors && result.errors[0];

  if (!first) return "Check your card details and try again.";
  if (/postal|zip/i.test(first.field || "")) {
    return "Check the ZIP code and try again.";
  }
  if (/expir/i.test(first.field || first.message || "")) {
    return "Check the expiration date and try again.";
  }
  if (/cvv|security/i.test(first.field || first.message || "")) {
    return "Check the security code and try again.";
  }
  if (/cardNumber|number/i.test(first.field || "")) {
    return "That card number doesn't look right.";
  }

  return first.message || "Check your card details and try again.";
};

export class Payment {
  constructor(root, form) {
    this.root = root;
    this.form = form;
    this.card = null;
    this.payments = null;
    this.request = null;
    this.wallets = {};
    this.venmo = null;
    this.config = null;
    this.ready = false;
    this.starting = null;
    this.error = qs(root, "[data-error-for='payment']");
    this.state = qs(root, "[data-pay]");
    this.cardButton = qs(root, "[data-card-choose]");
    this.busy = false;
  }

  // Card is one way among the buttons: chosen, its fields and the
  // form's own Pay button appear under the grid.
  setCardAvailable(on) {
    this.cardButton.hidden = !on;
    if (!on) this.setCardOpen(false);
  }

  setCardOpen(open) {
    const submit = document.getElementById("order-submit");

    this.state.dataset.cardOpen = String(open);
    this.cardButton.setAttribute("aria-pressed", String(open));
    if (submit) submit.hidden = !open;
  }

  // Loads once the section is near the screen, or the first time
  // anything inside it is focused, whichever comes first.
  start() {
    const go = () => this.load();

    if ("IntersectionObserver" in window) {
      const watcher = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          watcher.disconnect();
          go();
        }
      }, { rootMargin: "600px 0px" });

      watcher.observe(this.root);
    } else {
      go();
    }
    this.root.addEventListener("focusin", go, { once: true });
  }

  async load() {
    if (this.starting) return this.starting;

    this.starting = this.init().catch((error) => {
      console.error(error);
      this.setState("unavailable");
    });

    return this.starting;
  }

  setState(state) {
    this.state.dataset.payState = state;
  }

  async init() {
    const res = await fetch("/api/checkout/config", { cache: "no-store" });

    this.config = res.ok ? await res.json() : {};

    const jobs = [];

    if (this.config.square) jobs.push(this.initSquare(this.config.square));
    if (this.config.paypal) jobs.push(this.initVenmo(this.config.paypal));

    if (!jobs.length) {
      this.setState("unavailable");

      return;
    }

    await Promise.all(jobs);

    if (!this.card && !this.venmo) {
      this.setState("unavailable");

      return;
    }

    this.ready = true;
    this.setState(this.card ? "ready" : "venmo-only");
    this.form.paymentReady();
  }

  // --- Square -------------------------------------------------------

  async initSquare(cfg) {
    try {
      await loadScript(cfg.sdkUrl);
      this.payments = window.Square.payments(cfg.applicationId, cfg.locationId);
    } catch (error) {
      console.error(error);

      return;
    }

    try {
      // The iframe cannot see our stylesheet, so the field is told
      // our colours by value (_variables.scss).
      this.card = await this.payments.card({
        style: {
          input: { fontSize: "16px", color: "#212529" },
          "input::placeholder": { color: "#8a8a8b" },
          ".input-container": { borderColor: "#e7e7e7", borderRadius: "6px" },
          ".input-container.is-focus": { borderColor: "#1e7b54" },
          ".input-container.is-error": { borderColor: "#dc3545" },
          ".message-text": { color: "#5e5e5f" },
          ".message-icon": { color: "#5e5e5f" },
          ".message-text.is-error": { color: "#dc3545" },
          ".message-icon.is-error": { color: "#dc3545" },
        },
      });
      await this.card.attach(qs(this.root, "[data-card]"));
      this.setCardAvailable(true);
      this.setCardOpen(false);
      this.cardButton.addEventListener("click", () => {
        this.setCardOpen(true);
        this.card.focus("cardNumber").catch(() => {});
      });
    } catch (error) {
      console.error(error);
      this.card = null;
      this.setCardAvailable(false);
    }

    this.request = this.payments.paymentRequest({
      countryCode: "US",
      currencyCode: "USD",
      total: { amount: money(this.form.amount()), label: "North Foster Farm" },
    });

    await Promise.all([
      this.initApplePay(), this.initGooglePay(), this.initCashAppPay(),
    ]);
    this.showWallets();
  }

  showWallets() {
    const any = !!this.card || Object.keys(this.wallets).length > 0
      || !!this.venmo;

    qs(this.root, "[data-wallets]").hidden = !any;
  }

  // A wallet button pays the whole order on its own. The form is
  // validated in the capture phase of the click, so an invalid form
  // stops the sheet from opening and shows its errors instead.
  guard(container) {
    container.addEventListener("click", (e) => {
      if (this.busy || !this.form.prepare()) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }

  async initApplePay() {
    const button = qs(this.root, "[data-apple-pay]");

    try {
      const applePay = await this.payments.applePay(this.request);

      this.wallets.applepay = applePay;
      button.hidden = false;
      button.addEventListener("click", () => {
        // Tokenise inside the click: Safari refuses the sheet after
        // an await.
        const payload = this.busy ? null : this.form.prepare();

        if (!payload) return;
        this.finishWallet("applepay", applePay.tokenize(), payload);
      });
    } catch {
      button.hidden = true;
    }
  }

  async initGooglePay() {
    const container = qs(this.root, "[data-google-pay]");

    try {
      const googlePay = await this.payments.googlePay(this.request);

      await googlePay.attach(container, {
        buttonColor: "black", buttonType: "long", buttonSizeMode: "fill",
      });
      this.wallets.googlepay = googlePay;
      container.hidden = false;
      this.guard(container);
      container.addEventListener("click", () => {
        const payload = this.form.prepare();

        if (payload) {
          this.finishWallet("googlepay", googlePay.tokenize(), payload);
        }
      });
    } catch {
      container.hidden = true;
    }
  }

  async initCashAppPay() {
    const container = qs(this.root, "[data-cash-app-pay]");

    try {
      const cashAppPay = await this.payments.cashAppPay(this.request, {
        redirectURL: location.href.split("#")[0],
        referenceId: this.form.referenceId(),
      });

      cashAppPay.addEventListener("ontokenization", (e) => {
        const { tokenResult, error } = e.detail || {};
        const payload = this.form.prepare();

        if (error) {
          this.fail(error.message || "Cash App Pay didn't go through.");
        } else if (payload) {
          this.finishWallet("cashapp", Promise.resolve(tokenResult), payload);
        }
      });
      await cashAppPay.attach(container, { shape: "semiround", width: "full" });
      this.wallets.cashapp = cashAppPay;
      container.hidden = false;
      this.guard(container);
    } catch {
      container.hidden = true;
    }
  }

  async finishWallet(method, tokenising, payload) {
    this.setBusy(true);

    try {
      const result = await tokenising;

      if (!result || result.status !== "OK") {
        if (result && result.status === "Cancel") return;
        this.fail(tokenMessage(result));

        return;
      }
      this.clearError();
      await this.form.pay(payload, { method, sourceId: result.token });
    } catch (error) {
      this.fail(error.message || "The payment didn't go through.");
    } finally {
      this.setBusy(false);
    }
  }

  // The card form's token, with the customer's details for the
  // bank's verification. -> { method, sourceId }; throws with a
  // message for the customer.
  async tokenizeCard(payload) {
    if (!this.card) {
      throw new Error("Card payments aren't available right now.");
    }

    const b = this.form.billing(payload);
    const result = await this.card.tokenize({
      amount: money(this.form.amount()),
      currencyCode: "USD",
      intent: "CHARGE",
      customerInitiated: true,
      sellerKeyedIn: false,
      billingContact: {
        givenName: b.firstName,
        familyName: b.lastName,
        email: b.email,
        phone: b.phone,
        countryCode: "US",
        ...(b.address1 ? {
          addressLines: [b.address1, b.address2].filter(Boolean),
          city: b.town,
          state: b.state || undefined,
          postalCode: b.zip,
        } : {}),
      },
    });

    if (result.status !== "OK") throw new Error(tokenMessage(result));

    return { method: "card", sourceId: result.token };
  }

  // The total changed: the wallets' sheets must show the new one.
  setAmount(cents) {
    if (!this.request) return;
    try {
      this.request.update({
        total: { amount: money(cents), label: "North Foster Farm" },
      });
    } catch {
      // The old amount is refused by the server anyway.
    }
  }

  // --- Venmo --------------------------------------------------------

  async initVenmo(cfg) {
    const container = qs(this.root, "[data-venmo]");

    if (!venmoShown(cfg.hidden)) return;

    try {
      await loadScript(cfg.sdkUrl);
    } catch (error) {
      console.error(error);

      return;
    }

    const paypal = window.paypal;

    if (!paypal || !paypal.Buttons) return;

    const button = paypal.Buttons({
      fundingSource: paypal.FUNDING.VENMO,
      style: { shape: "rect", height: 44, label: "pay" },
      onClick: (data, actions) => {
        if (this.busy || !this.form.prepare()) return actions.reject();

        return actions.resolve();
      },
      createOrder: async () => {
        const payload = await this.form.prepareAsync();

        if (!payload) throw new Error("Check the form and try again.");
        this.venmoPayload = payload;
        this.clearError();

        return this.form.venmoCreate(payload);
      },
      onApprove: async (data) => {
        this.setBusy(true);
        try {
          await this.form.venmoCapture(this.venmoPayload, data.orderID);
        } catch (error) {
          this.fail(error.message || "The Venmo payment didn't go through.");
        } finally {
          this.setBusy(false);
        }
      },
      onCancel: () => {
        this.setBusy(false);
      },
      onError: (error) => {
        console.error(error);
        this.setBusy(false);
        this.fail("Venmo didn't go through. Try again, or pay another way.");
      },
    });

    if (!button.isEligible()) {
      container.hidden = true;

      return;
    }

    try {
      await button.render(container);
      this.venmo = button;
      container.hidden = false;
      this.showWallets();
    } catch (error) {
      console.error(error);
      container.hidden = true;
    }
  }

  // --- Errors and state ---------------------------------------------

  fail(message) {
    this.error.textContent = message;
    this.error.hidden = false;
    this.root.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  clearError() {
    this.error.textContent = "";
    this.error.hidden = true;
  }

  setBusy(busy) {
    this.busy = busy;
    this.root.classList.toggle("order-pay-busy", busy);
  }
}
