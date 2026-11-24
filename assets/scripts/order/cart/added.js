// The feedback for an Add (#267, docs/refactors/cart.md, phase 6): the
// live line, the first Add's lesson and the "Added" strip. Cart builds
// one, wires it with the pane and passes the form's added() on to it.

import { pulse, qs, say } from "./dom.js";
import { firstAdd } from "./first-add.js";
import { pulsePill, revealLine, showAdded, teach } from "./view.mjs";

// The first Add's lesson (#278): how long the pane stays open on the
// new line before it shuts and the pill pulses. 2000 until #274 round
// 4 added 1.5 s.
const TEACH_DWELL = 3500;

export class Added {
  // `root` is #order-cart, `list` its lines and `pill` the floating
  // pane's toggle. `fold` holds the view state and opens and closes
  // the pane (fold.js).
  constructor(root, { list, pill, fold }) {
    this.root = root;
    this.list = list;
    this.pill = pill;
    this.fold = fold;
    this.teaching = null;
  }

  // The first of a browser session opens the floating pane on the
  // lines, scrolled to the new line, shuts it after TEACH_DWELL and
  // pulses the pill in three pairs (#278). Every later Add leaves the
  // pane as it is: the count ticks, and while the pane is shut the
  // strip says what was added and the pill pulses once. Whatever the
  // pane is doing, a screen reader hears it, and the focus stays where
  // it is.
  add(sku, name) {
    const root = this.root;
    const live = qs(root, "[data-cart-live]");

    say(live, `Added ${name} to cart`);
    pulse(qs(root, "[data-cart-count]"), "is-ticked");

    this.keepOpen();

    const floating = this.fold.state.placement === "floating";

    if (floating && firstAdd()) {
      this.teach(sku);

      return;
    }

    // The pill pulses only to say where a closed cart went (#559): on
    // an open pane its ring read as a focus ring on Hide that nobody
    // had moved there.
    if (floating && this.fold.state.fold === "closed") {
      pulsePill(this.pill, "once");
      showAdded(qs(root, "[data-cart-added-box]"), `Added: ${name}`);
    }
  }

  // The lesson: the pane opens on the new line (`sku`'s), then shuts
  // after TEACH_DWELL and the pill pulses.
  teach(sku) {
    const root = this.root;

    this.fold.open().then(() => {
      const button = qs(root, `[data-remove="${CSS.escape(sku)}"]`);

      if (button) revealLine(this.list, button.closest("li"));
    });
    this.teaching = teach(root, this.pill, {
      dwell: TEACH_DWELL,
      onShut: () => {
        this.teaching = null;
        this.fold.close().then(() => pulsePill(this.pill, "teach"));
      },
    });
  }

  // The pane is the customer's once they focus in it or press a key:
  // the first Add's timer lapses. A touch is the view's to judge.
  wire() {
    for (const type of ["focusin", "keydown"]) {
      this.root.addEventListener(type, () => this.keepOpen(), {
        passive: true,
      });
    }
  }

  // The pane is the customer's once they focus in it, press a key in
  // it or tap it (the view judges a touch): the first Add's timer
  // lapses.
  keepOpen() {
    if (this.teaching) this.teaching.keep();
  }
}
