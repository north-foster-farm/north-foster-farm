// The wallets (docs/refactors/pay.md, phase 4): Square's payment
// request and its three wallets, Apple Pay on [data-apple-pay], Google
// Pay on [data-google-pay] and Cash App Pay on [data-cash-app-pay].
// Each pays the whole order on its own: the form is validated in the
// click, the wallet's token goes to the form, and the request follows
// the order's total. It holds the request and the wallets; the
// section's DOM is pay/section.js's, and what it asks of the form
// comes through the `checkout` port that order/pay.js builds.

import { paymentRequestOf } from "./requests.mjs";
import { dollarsOf, tokenMessage } from "./words.mjs";
import { crumb, reportError } from "../report.js";

const qs = (root, selector) => root.querySelector(selector);

export class Wallets {
  constructor({ root, section, checkout }) {
    this.root = root;
    this.section = section;
    this.checkout = checkout;
    this.payments = null;
    this.request = null;
    // The wallets this browser offers, by method (pay/states.mjs,
    // walletsShown).
    this.wallets = {};
  }

  // The payment request from `payments` (what Square.payments() gave),
  // and each wallet on it. A wallet the browser lacks keeps its button
  // hidden.
  async attach(payments) {
    this.payments = payments;
    this.request = payments.paymentRequest(paymentRequestOf(
      this.checkout.amount(), this.checkout.label()
    ));

    await Promise.all([
      this.initApplePay(), this.initGooglePay(), this.initCashAppPay(),
    ]);
    crumb("wallets.ready");
  }

  // A wallet button pays the whole order on its own. The form is
  // validated in the capture phase of the click, so an invalid form
  // stops the sheet from opening and shows its errors instead.
  guard(container) {
    container.addEventListener("click", (e) => {
      if (this.section.busy || !this.checkout.prepare()) {
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
        const payload = this.section.busy ? null : this.checkout.prepare();

        if (!payload) return;
        this.finish("applepay", applePay.tokenize(), payload);
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
        const payload = this.checkout.prepare();

        if (payload) {
          this.finish("googlepay", googlePay.tokenize(), payload);
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
        referenceId: this.checkout.referenceId(),
      });

      cashAppPay.addEventListener("ontokenization",
        (e) => this.cashAppTokenized(e));
      await cashAppPay.attach(container, { shape: "semiround", width: "full" });
      this.wallets.cashapp = cashAppPay;
      container.hidden = false;
      this.guard(container);
    } catch {
      container.hidden = true;
    }
  }

  // Cash App Pay opens its own sheet and answers here.
  cashAppTokenized(e) {
    const { tokenResult, error } = e.detail || {};
    const payload = this.checkout.prepare();

    if (error) {
      reportError("cashapp.tokenize", error);
      this.section.fail(error.message || "Cash App Pay didn't go through.");
    } else if (payload) {
      this.finish("cashapp", Promise.resolve(tokenResult), payload);
    }
  }

  async finish(method, tokenising, payload) {
    crumb("pay.press");
    this.section.setBusy(true);

    try {
      const result = await tokenising;

      if (result && result.status === "Cancel") return;
      if (!result || result.status !== "OK") {
        // The status only: the SDK's own messages can quote the card.
        reportError("wallet.tokenize", `${method}: ${
          result ? result.status : "no result"}`);
        this.section.fail(tokenMessage(result));

        return;
      }
      this.section.clearError();
      await this.checkout.pay(payload, { method, sourceId: result.token });
    } catch (error) {
      reportError("wallet.pay", error);
      this.section.fail(error.message || "The payment didn't go through.");
    } finally {
      this.section.setBusy(false);
    }
  }

  // The total changed: the wallets' sheets must show the new one.
  setAmount(cents) {
    if (!this.request) return;
    try {
      this.request.update({
        total: { amount: dollarsOf(cents), label: this.checkout.label() },
      });
    } catch {
      // The old amount is refused by the server anyway.
    }
  }
}
