// The payment section's loading (docs/refactors/pay.md, phase 6):
// when the SDKs load, the config /api/checkout/config gives for this
// deploy, the state the section ends in, and the backstop for an SDK
// that never answers. The SDKs themselves are the parts': `square`
// runs Square's half, the card and the wallets, and `paypal` the Venmo
// button, each given its config and answering with what it attached.
// The section's DOM is pay/section.js's, and the form hears through
// the `checkout` port that order/pay.js builds.

import { endState } from "./states.mjs";
import { crumb, reportUnavailable } from "../report.js";
import { whileLoading } from "../../utils/skeleton.js";

const qs = (root, selector) => root.querySelector(selector);

// How long the payment SDKs get to load before the page calls payment
// unavailable and reports it (#268, rec 8). The skeleton over the card
// fields gives up at 10 s with Try again; this is the backstop.
const INIT_TIMEOUT_MS = 20_000;

export class Loader {
  constructor({ root, section, checkout, square, paypal }) {
    this.root = root;
    this.section = section;
    this.checkout = checkout;
    this.square = square;
    this.paypal = paypal;
    this.config = null;
    this.ready = false;
    this.starting = null;
    // The section's data-pay-state, which the page starts at
    // "loading" and only setState below changes.
    this.payState = "loading";
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

  // The card fields wait under a skeleton (#271). A payment that
  // turns out unavailable says so itself; one still loading after
  // the skeleton gives up offers Try again, a reload.
  load() {
    if (this.starting) return this.starting;

    this.starting = whileLoading(qs(this.root, "#pay-card-panel"),
      () => this.settle(), { failed: (done) => !done });

    return this.starting;
  }

  // An SDK that loads but never settles (payments() or attach()
  // hanging) left the page loading for good, with Pay disabled and
  // nothing reported (#268, rec 8). After INIT_TIMEOUT_MS it is
  // unavailable and reported; a late success still takes over.
  settle() {
    const timer = setTimeout(() => this.timedOut(), INIT_TIMEOUT_MS);

    return this.init().then(() => true, (error) => {
      console.error(error);
      reportUnavailable("checkout.init", error);
      this.setState("unavailable");

      return true;
    }).finally(() => clearTimeout(timer));
  }

  timedOut() {
    if (this.ready || this.payState !== "loading") return;
    reportUnavailable("checkout.init", `No answer in ${
      INIT_TIMEOUT_MS / 1000} s.`);
    this.setState("unavailable");
  }

  setState(state) {
    this.payState = state;
    this.section.setState(state);
  }

  async init() {
    crumb("pay.load");

    const res = await fetch("/api/checkout/config", { cache: "no-store" });

    this.config = res.ok ? await res.json() : {};
    crumb(res.ok ? "config.ok" : "config.failed");

    if (this.config.off) {
      crumb("config.off");
      this.setState("off");

      return;
    }

    await this.attach(res.status);
  }

  // Square's half first, then PayPal's, each that the config names.
  async attach(status) {
    const card = this.config.square ? this.square(this.config.square) : null;
    const venmo = this.config.paypal ? this.paypal(this.config.paypal) : null;

    if (!card && !venmo) {
      reportUnavailable("checkout.config", `No payment configured (HTTP ${
        status}).`);
      this.setState("unavailable");

      return;
    }

    this.finish(await Promise.all([card, venmo]));
  }

  finish([card, venmo]) {
    const state = endState({ card, venmo });

    if (state === "unavailable") {
      reportUnavailable("sdks.gone", "Neither the card nor Venmo is " +
        "available.");
      this.setState("unavailable");

      return;
    }

    this.ready = true;
    this.setState(state);
    this.checkout.ready();
  }
}
