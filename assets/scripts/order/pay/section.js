// The payment section's state on the page (docs/refactors/pay.md,
// phase 2). The one writer of `[data-pay]`'s data-pay-state,
// data-card-open and data-pay-covered, of the class order-pay-busy and
// of the section's error line, and the holder of its two flags, busy
// and covered. order/pay.js asks it, through Payment's methods of the
// same names; the choices come from pay/states.mjs.

import { submitHidden, walletsShown } from "./states.mjs";

const qs = (root, selector) => root.querySelector(selector);

export class Section {
  constructor(root) {
    this.root = root;
    this.error = qs(root, "[data-error-for='payment']");
    this.state = qs(root, "[data-pay]");
    this.cardButton = qs(root, "[data-card-choose]");
    this.busy = false;
    this.setCardOpen(true);
  }

  // Card is one way among the buttons, and starts chosen: its fields
  // and the form's own Pay button show under the grid until card
  // payments turn out to be unavailable.
  setCardAvailable(on) {
    this.cardButton.hidden = !on;
    if (!on) this.setCardOpen(false);
  }

  setCardOpen(open) {
    const submit = document.getElementById("order-submit");

    this.state.dataset.cardOpen = String(open);
    this.cardButton.setAttribute("aria-pressed", String(open));
    if (submit) {
      submit.hidden = submitHidden({ cardOpen: open, covered: this.covered });
    }
  }

  // A member's credit covers the whole order (#471): nothing to
  // charge, so the wallets and the card fields step aside and the
  // form's own button places the order. Off again, the card is back
  // as it was.
  setCovered(on) {
    const submit = document.getElementById("order-submit");

    this.covered = !!on;
    this.state.dataset.payCovered = String(this.covered);
    qs(this.root, "[data-wallets]").hidden = this.covered;
    qs(this.root, "#pay-card-panel").hidden = this.covered;
    if (this.covered && submit) {
      submit.hidden = false;
      submit.disabled = false;
    } else if (!this.covered) {
      this.setCardOpen(this.state.dataset.cardOpen === "true");
    }
  }

  setState(state) {
    this.state.dataset.payState = state;
    // No card to pay with, so no Pay button to leave dead.
    if (state !== "loading" && state !== "ready") this.setCardOpen(false);
  }

  // The vendor parts' objects, as Payment holds them: the attached
  // card, the wallets by name and the unlocked Venmo button.
  showWallets({ card, wallets, venmo }) {
    qs(this.root, "[data-wallets]").hidden = !walletsShown({
      card, wallets, venmo,
    });
  }

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
