// Venmo (docs/refactors/pay.md, phase 5): PayPal's Venmo button on
// [data-venmo], in [data-venmo-cell], and its six callbacks, each a
// method here. It holds the button, the payload createOrder prepared
// and its two flags; the section's DOM is pay/section.js's, the
// choices are pay/venmo-flow.mjs's, and what it asks of the form comes
// through the `checkout` port that order/pay.js builds.

import { loadScript } from "./scripts.js";
import { clickAllowed, shouldRestart } from "./venmo-flow.mjs";
import { venmoEnabled } from "./venmo-gate.js";
import { venmoRefusal } from "./words.mjs";
import { crumb, reportError, sdk } from "../report.js";

const qs = (root, selector) => root.querySelector(selector);

export class Venmo {
  constructor({ root, section, checkout }) {
    this.root = root;
    this.section = section;
    this.checkout = checkout;
    this.locked = false;
    // The unlocked button once rendered: a way to pay. Otherwise null.
    this.button = null;
    this.venmoPayload = null;
    this.venmoRestarted = false;
    this.venmoSettled = false;
  }

  // PayPal's script from `cfg` (/api/checkout/config's paypal), then
  // the button. -> true when the cell is shown, so the section shows
  // the wallets again.
  async attach(cfg) {
    const cell = qs(this.root, "[data-venmo-cell]");
    const container = qs(cell, "[data-venmo]");

    // Held back: PayPal's button, inert and greyed, over "Coming soon".
    // It never counts as a way to pay, and never opens anything.
    this.locked = !venmoEnabled(cfg.hidden);
    container.inert = this.locked;

    if (!await this.load(cfg)) return false;

    const paypal = window.paypal;

    if (!paypal || !paypal.Buttons) return false;

    return this.render(paypal.Buttons(this.options(paypal)), cell, container);
  }

  async load(cfg) {
    sdk("paypal", "loading");
    try {
      await loadScript(cfg.sdkUrl);
    } catch (error) {
      console.error(error);
      sdk("paypal", "failed");
      crumb("paypal.load_failed");
      reportError("paypal.load", error);

      return false;
    }
    sdk("paypal", "ready");
    crumb("paypal.ready");

    return true;
  }

  // What paypal.Buttons takes: the funding source, the style and the
  // six callbacks.
  options(paypal) {
    return {
      fundingSource: paypal.FUNDING.VENMO,
      style: { shape: "rect", height: 44, label: "pay" },
      onInit: (data, actions) => this.onInit(data, actions),
      onClick: (data, actions) => this.onClick(data, actions),
      createOrder: () => this.createOrder(),
      onApprove: (data, actions) => this.onApprove(data, actions),
      onCancel: () => this.onCancel(),
      onError: (error) => this.onError(error),
    };
  }

  async render(button, cell, container) {
    if (!button.isEligible()) {
      cell.hidden = true;

      return false;
    }

    try {
      await button.render(container);
      crumb("venmo.ready");
      if (!this.locked) this.button = button;
      qs(cell, "[data-venmo-soon]").hidden = !this.locked;
      cell.hidden = false;

      return true;
    } catch (error) {
      console.error(error);
      crumb("venmo.render_failed");
      reportError("paypal.render", error);
      cell.hidden = true;

      return false;
    }
  }

  onInit(data, actions) {
    if (this.locked) actions.disable();
  }

  onClick(data, actions) {
    if (!clickAllowed({ locked: this.locked, busy: this.section.busy },
      () => this.checkout.prepare())) {
      return actions.reject();
    }

    return actions.resolve();
  }

  async createOrder() {
    const payload = await this.checkout.prepareAsync();

    if (!payload) {
      throw new Error(venmoRefusal(this.checkout.stockLocked()));
    }
    this.venmoPayload = payload;
    this.venmoRestarted = false;
    this.section.clearError();

    const id = await this.checkout.venmoCreate(payload);

    // Paid already, and the page says so: PayPal is stopped the
    // only way it can be, and onError keeps quiet.
    if (!id) {
      this.venmoSettled = true;
      throw new Error("The order is already paid.");
    }

    return id;
  }

  // A decline for the funding source opens the sheet again, once
  // (pay/venmo-flow.mjs, shouldRestart). The decline is settled
  // first, so a buyer who closes the sheet is where any decline
  // leaves them.
  async onApprove(data, actions) {
    crumb("venmo.approve");
    this.section.setBusy(true);
    try {
      const restart = !!this.venmoRestarted;
      const outcome = await this.checkout.venmoCapture(
        this.venmoPayload, data.orderID, { restart }
      );

      if (shouldRestart({ restarted: restart, outcome, actions })) {
        this.venmoRestarted = true;
        crumb("venmo.restart");

        return await actions.restart();
      }
    } catch (error) {
      this.section.fail(error.message
        || "The Venmo payment didn't go through.");
    } finally {
      this.section.setBusy(false);
    }
  }

  onCancel() {
    crumb("venmo.cancel");
    this.section.setBusy(false);
  }

  onError(error) {
    if (this.venmoSettled) {
      this.venmoSettled = false;
      this.section.setBusy(false);

      return;
    }
    console.error(error);
    reportError("paypal.error", error);
    this.section.setBusy(false);
    this.section.fail(
      "Venmo didn't go through. Try again, or pay another way."
    );
  }
}
