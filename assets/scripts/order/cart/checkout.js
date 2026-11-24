// Proceed to checkout (#706, docs/refactors/cart.md, phase 4): the
// button's tooltip that says why a press cannot go on, and the
// button's state from each render. Cart builds one, wires it with the
// rest of the pane, and shuts its tooltip on a scroll or Escape.

import Tooltip from "bootstrap/js/dist/tooltip.js";

import { qs } from "./dom.js";
import { shutTip } from "./tip.js";
import { pulsePill } from "./view.mjs";

export class CheckoutButton {
  // `root` is #order-cart. `on` is Cart's callbacks, of which this
  // calls onCheckout and onBlocked; `open` opens the pane and resolves
  // once it has.
  constructor(root, on, open) {
    this.root = root;
    this.on = on;
    this.open = open;
    // Why Proceed to checkout cannot go on, or null (#706).
    this.why = null;
    this.button = null;
    this.tip = null;
    this.shownWhy = null;
  }

  // When it cannot go on it only looks disabled (aria-disabled), so a
  // press still lands and says why in a tooltip; for a delivery short
  // of the minimum the pane opens too and the way's button pulses as
  // the pill does. The tooltip goes on the next press elsewhere,
  // Escape, a scroll of the page, or once the reason is gone.
  // Otherwise the form takes the press.
  wire() {
    const button = qs(this.root, "[data-checkout]");

    this.button = button;
    this.tip = new Tooltip(button, {
      title: () => (this.why ? this.why.text : ""),
      trigger: "manual",
      placement: "top",
    });
    button.addEventListener("click", () => {
      if (this.why) this.explain();
      else this.on.onCheckout();
    });
    document.addEventListener("click", (e) => {
      if (!button.contains(e.target)) this.shut();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.root.contains(e.target)) {
        this.shut();
      }
    });
  }

  // Says why the press cannot go on. The pane opens first, so the
  // tooltip is drawn where the button comes to rest.
  explain() {
    const { reason } = this.why;
    const open = reason === "minimum" ? this.open() : Promise.resolve();

    this.on.onBlocked(reason);
    open.then(() => {
      if (!this.why) return;
      shutTip(this.tip);
      this.tip.show();
      this.shownWhy = this.why.text;
      if (reason === "minimum") {
        pulsePill(qs(this.root, "[data-way-toggle]"), "teach");
      }
    });
  }

  shut() {
    this.shownWhy = null;
    if (this.tip) shutTip(this.tip);
  }

  // The button's state from a render: aria-disabled, never disabled,
  // with the reason kept for a press. A tooltip showing a reason that
  // has changed or gone is shut.
  setWhy(why) {
    this.why = why;
    this.button.disabled = false;
    if (why) this.button.setAttribute("aria-disabled", "true");
    else this.button.removeAttribute("aria-disabled");
    if (this.shownWhy && (!why || why.text !== this.shownWhy)) {
      this.shut();
    }
  }
}
