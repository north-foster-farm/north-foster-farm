// Clear cart (#531, docs/refactors/cart.md, phase 4): its two presses.
// Cart builds one, wires it with the rest of the pane, and asks it
// whether it is asking (busy, Escape) and to put itself back.

import { twoStep } from "./confirm.mjs";
import { qs, say } from "./dom.js";
import { moving } from "./view.mjs";

// Clear cart's words (#531): at rest, and asking for the second press.
// Drafts for comms.
const CLEAR_WORD = "Clear cart";
const CLEAR_ASK = "Clear cart?";
const CLEAR_HINT = "Press again to remove every item from your cart.";
const CLEAR_DONE = "Your cart is empty.";

// An animation's end, cancelled or not.
const ended = (a) => a.finished.catch(() => {});

// Runs `put` a frame on, once nothing still fades `button` out of the
// pane, which `root` is.
const afterFade = (root, button, put) => {
  requestAnimationFrame(() => {
    const fading = moving(root).filter((a) => (
      a.effect && a.effect.target === button
    ));

    if (!fading.length) {
      put();

      return;
    }
    Promise.all(fading.map(ended)).then(put);
  });
};

export class ClearCart {
  // `root` is #order-cart. `on` is Cart's callbacks, of which this
  // calls onClear.
  constructor(root, on) {
    this.root = root;
    this.on = on;
    this.clearing = null;
  }

  // Whether the first press is waiting for its second.
  get armed() {
    return this.clearing.armed;
  }

  // Puts the button back as at rest.
  reset() {
    this.clearing.reset();
  }

  // The first press turns it into "Clear cart?" for 6 s (confirm.mjs),
  // and a second press in that time, but not within 400 ms of the
  // first, takes every line out. Waiting, Escape or the focus leaving
  // puts it back.
  // An emptied cart hides the lines and the button with them, so the
  // focus goes to the pane.
  wire() {
    const button = qs(this.root, "[data-cart-clear]");
    const word = qs(button, "[data-cart-clear-word]");
    const live = qs(this.root, "[data-cart-live]");

    this.clearing = twoStep({
      onArm: () => {
        button.dataset.armed = "";
        word.textContent = CLEAR_ASK;
        say(live, CLEAR_HINT);
      },
      onDisarm: () => this.disarm(button, word),
      onConfirm: () => {
        this.on.onClear();
        this.root.focus({ preventScroll: true });
        say(live, CLEAR_DONE);
      },
    });
    button.addEventListener("click", () => this.clearing.press());
    button.addEventListener("focusout", () => this.clearing.reset());
  }

  // A pill fading out with the clear keeps its "Clear cart?" until it
  // is gone (#559, round 3): the disarm lands inside the change, before
  // its eases start, so it looks a frame later.
  disarm(button, word) {
    afterFade(this.root, button, () => {
      if (this.clearing.armed) return;
      delete button.dataset.armed;
      word.textContent = CLEAR_WORD;
    });
  }
}
