// The cart (#477, docs/cart.md): one class owning everything inside
// #order-cart and the page's two readouts of its count and total, and
// nothing else. The order form keeps the model (the quantities in the
// catalog's rows, the method radios, the draft, stock, payment) and
// calls render() with what summary.mjs says about it; the cart calls
// back when a line is removed, a way picked, a code applied or
// Proceed to checkout pressed. Its view state (where it sits, whether
// it is folded) lives in state.mjs; the layout, the keyboard and the
// animations in view.mjs.

import { ringsCart } from "../lib/cart-scroll.mjs";
import { Added } from "./added.js";
import { Badges } from "./badges.js";
import { CheckoutButton } from "./checkout.js";
import { ClearCart } from "./clear.js";
import { all, qs, reduced } from "./dom.js";
import { escapeStep } from "./escape.mjs";
import { Fold } from "./fold.js";
import { startJoke, stopJoke } from "./joke-row.js";
import { drawItems, dropRows } from "./lines-view.js";
import { changed } from "./plan.mjs";
import { ShareRow } from "./share-row.js";
import * as state from "./state.mjs";
import {
  drawEdit, drawNudge, drawReadouts, drawSums, drawWays,
} from "./sums-view.js";
import { focusAfterScroll, ringCart } from "./view.mjs";
import { whyOf } from "./why.mjs";

// The joke's code, for the form (joke.mjs).
export { JOKE_CODE } from "./joke.mjs";

// The root (docs/refactors/cart.md, phase 7): it builds the parts,
// orders one render and the Escape, and passes the form's calls on.
export class Cart {
  // `root` is #order-cart; its parent is the slot and the heading sits
  // before the slot. `bar` is the phone's sticky top bar, if any. The
  // readouts are the form's [data-total-bar-count], [data-total-bar-total]
  // and [data-to-cart], found from `form`.
  // `onBlocked(reason)` hears a press of Proceed to checkout that
  // cannot go on ("empty", "locked" or "minimum"), after the cart has
  // said why.
  constructor(root, {
    form, bar = null, onRemove, onClear, onWay, onCode, onCheckout,
    onBlocked = () => {},
  }) {
    this.root = root;
    this.form = form;
    this.heading = document.getElementById("order-cart-heading");
    this.on = { onRemove, onClear, onWay, onCode, onCheckout, onBlocked };
    this.lastCount = null;
    this.lastTotal = null;
    // The lines last drawn (lines-view.js), null before the first.
    this.drawn = null;
    this.joke = null;
    this.list = qs(root, "[data-cart-items]");
    this.pill = qs(root, "[data-cart-toggle]");
    this.build();
    this.fold.apply(this.fold.state);
    this.wire(bar);
  }

  // The parts, each in its own file. Fold reaches the first three.
  build() {
    const { root, list, pill } = this;

    this.badges = new Badges(root);
    this.checkout = new CheckoutButton(root, this.on, () => this.fold.open());
    this.clear = new ClearCart(root, this.on);
    this.fold = new Fold(root, { form: this.form, list, pill }, {
      badges: this.badges, checkout: this.checkout, clear: this.clear,
    });
    this.shareRow = new ShareRow(root, this.on, this.fold);
    this.adds = new Added(root, { list, pill, fold: this.fold });
  }

  // Every listener, in its old order.
  wire(bar) {
    this.fold.wire(bar);
    // The pill folds a floating cart; Escape folds it too and leaves
    // the focus on the pill (#159). Escape in the shared row folds the
    // row first.
    this.pill.addEventListener("click", () => this.fold.toggle());
    this.wireEscape();
    this.adds.wire();
    this.wireRemove();
    this.checkout.wire();
    this.clear.wire();
    this.shareRow.wire();
    this.badges.wire();

    // The readouts in the bars go back to the cart.
    for (const button of all(this.form, "[data-to-cart]")) {
      button.addEventListener("click", () => this.show({ smooth: true }));
    }
  }

  wireEscape() {
    this.root.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;

      const step = escapeStep({
        tipOpen: this.badges.allTips().some((tip) => tip.tip)
          || this.checkout.tip.tip,
        clearAsking: this.clear.armed,
        share: this.fold.state.share,
        state: this.fold.state,
      });

      if (!step) return;
      e.preventDefault();
      this.escape(step);
    });
  }

  // The remove icon on a cart line takes every unit of that product
  // out.
  wireRemove() {
    this.root.addEventListener("click", (e) => {
      const button = e.target.closest("[data-remove]");

      if (button) this.on.onRemove(button.dataset.remove);
    });
  }

  // Escape, by the part escapeStep names (escape.mjs); the fold leaves
  // the focus on the pill.
  escape(step) {
    if (step === "tips") {
      this.badges.shutTips();
      this.checkout.shut();
    } else if (step === "clear") {
      this.clear.reset();
    } else if (step === "row") {
      this.shareRow.escape();
    } else {
      const { state: next } = state.escape(this.fold.state);

      this.fold.fold(next).then(() => this.pill.focus());
    }
  }

  // The day's tiers and minimum on the badges (badges.js).
  setMoney(money) {
    this.badges.setMoney(money);
  }

  // Everything the cart shows, from the form's summary (summary.mjs
  // summarize) and what else the form knows: `method`, the way the
  // page holds; `ways`, which of the three can be picked; `edit`, a
  // paid order being changed ({ held, kept, keptDate, total }) or null;
  // `locked`, the stock gate; `adding`, that an Add caused this render;
  // `fixed`, that the lines cannot change (an unpaid order being paid,
  // #181): no remove icon on a line and no Clear cart; `down`, that the
  // stock gate is shut because stock could not be checked.
  render(s, {
    method, ways = {}, edit = null, locked = false, adding = false,
    fixed = false, down = false,
  }) {
    const draw = () => this.draw(s, { method, ways, edit, fixed });

    this.summary = s;
    drawReadouts({ root: this.root, form: this.form, pill: this.pill }, s);
    this.checkout.setWhy(whyOf(s, { method, locked, down }));

    // The lines came or went, or the cart emptied or filled: the fold
    // rule decides, and the pane eases to its new height (the column's
    // ease, #278 item 2; the sheet's fold).
    const next = state.rendered(this.fold.state, {
      count: s.count, was: this.lastCount, adding,
    });

    this.lastCount = s.count;
    if (this.moves(next, s)) {
      next.empty = s.count === 0;
      this.ease(next, draw);
    } else {
      this.settle(next, draw, s);
    }
  }

  // Whether the render moves the pane (plan.mjs changed).
  moves(next, s) {
    return changed({
      next, was: this.fold.state, lines: s.groups, drawn: this.drawn,
      nudge: s.nudge, nudgeShown: !qs(this.root, "[data-nudge]").hidden,
    });
  }

  // The lines, the sums and the rest of the pane, from the summary.
  draw(s, { method, ways, edit, fixed }) {
    const root = this.root;
    const count = s.count;

    this.drawn = drawItems(root, this.list, s.groups, this.drawn);
    for (const button of all(root, "[data-remove]")) button.hidden = fixed;
    qs(root, "[data-cart-clear]").hidden = fixed;
    if (fixed || count === 0) this.clear.reset();
    drawSums(root, s, this.lastTotal);
    this.lastTotal = s.total;
    drawEdit(root, edit);
    drawWays(root, method, ways);
    root.toggleAttribute("data-empty", count === 0);
    drawNudge(root, s);
  }

  // The badges after the ease: a badge that lights sends its chicks
  // from where it is seen, and mid-ease it may lie past the pane's
  // old edge. A render that follows at once cancels this ease and
  // starts its own, and the ease it cancels resolves early: only
  // the latest render's end counts. A render with nothing to ease
  // may come before it ends (a sign-in's perks, #717): the badges
  // follow the latest summary, not this one.
  ease(next, draw) {
    const fold = this.fold;
    const seq = this.renders = (this.renders || 0) + 1;

    fold.motion(() => {
      fold.apply(next);
      draw();
    }).then(() => fold.stilled()).then(() => {
      if (seq !== this.renders) return;
      dropRows(this.list, this.drawn);
      fold.placement.refresh();
      fold.lines.sync();
      this.badges.draw(this.summary);
    });
  }

  // A render that moves nothing: drawn at once, the badges with it.
  settle(next, draw, s) {
    this.fold.hold(next);
    draw();
    this.fold.placement.refresh();
    this.fold.lines.sync();
    this.badges.draw(s);
  }

  // The feedback for an Add (#267, added.js).
  added(sku, name) {
    this.adds.add(sku, name);
  }

  // The signed-in customer's perks (#514, badges.js), with a buying
  // group's `member`.
  setPerks(perks, options) {
    this.badges.setPerks(perks, options);
  }

  // The outcome of a code the form applied (share-row.js).
  codeResult(result) {
    this.shareRow.codeResult(result);
  }

  // The joke's row (joke-row.js).
  startJoke() {
    if (!this.joke) this.joke = startJoke(this.root);
  }

  stopJoke() {
    if (!this.joke) return;
    stopJoke(this.joke);
    this.joke = null;
  }

  // Brings the cart into view and gives it the focus: the readouts'
  // tap, the rail's Cart link, the header's cart link and #order-cart
  // in the URL (#203, #337, #402). In the column the pane itself is
  // brought into view, only as far as it takes; below xl the heading,
  // at the top. `ring` rings the pane where the link would otherwise
  // seem to do nothing (ringsCart). One scroll, to one place: the
  // focus moves no further (focusAfterScroll), and reduced motion
  // jumps there (#619).
  show({ smooth = false, ring = false } = {}) {
    const column = this.fold.state.placement === "column";
    const target = column ? this.root : this.heading;
    const block = column ? "nearest" : "start";

    if (ring && ringsCart(
      column, this.root.getBoundingClientRect(), window.innerHeight
    )) {
      ringCart(this.root);
    }
    target.scrollIntoView({
      behavior: smooth && !reduced() ? "smooth" : "auto", block,
    });
    focusAfterScroll(target);
  }

  // The cart's own fields, for the form's collect() and restore()
  // (share-row.js).
  codeValue() {
    return this.shareRow.codeValue();
  }

  setCodeValue(value) {
    this.shareRow.setCodeValue(value);
  }
}
