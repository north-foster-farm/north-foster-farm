// The pane's view state and its folding (docs/refactors/cart.md, phase
// 6): the state.mjs record, written to the pane; every change of the
// pane's size, run through the view's motion; and the watchers that
// feed it, from view.mjs. Every other part asks it (open, setShare,
// state), and none writes an attribute of the pane's.

import { all, qs, reduced } from "./dom.js";
import { passedBy, pillWord } from "./plan.mjs";
import * as state from "./state.mjs";
import {
  SHEET, animateFold, clearFocusUnder, moveParts, moving, swapWords,
  toPx,
  watchKeyboard, watchList, watchPlacement, watchScroll, wordsOf,
} from "./view.mjs";

export class Fold {
  // `root` is #order-cart; its parent is the slot. `form` holds the
  // bars' readouts, `list` the lines and `pill` the floating pane's
  // toggle. `parts` are the badges (their tooltips shut on a fold or a
  // scroll), Proceed to checkout (its tooltip shuts on a scroll) and
  // Clear cart (asking, the pane is in use).
  constructor(root, { form, list, pill }, parts) {
    this.root = root;
    this.form = form;
    this.list = list;
    this.pill = pill;
    this.parts = parts;
    this.slot = root.parentElement;
    this.state = state.initial();
    this.passed = null;
    // The phone sheet's scroll rule (#559): where the page's travel is
    // counted from, how many eases of the pane run, and whether a
    // finger is down on the pane.
    this.scrollFrom = null;
    this.easing = 0;
    this.fingerDown = false;
    this.sheet = matchMedia(SHEET);
  }

  // Writes the state to the DOM: the attributes on the aside, the
  // pill's aria-expanded and the shared row's. A fold or a change of
  // placement shuts an open badge tooltip first (#569).
  apply(next) {
    const was = this.state;

    if (next.fold !== was.fold || next.placement !== was.placement) {
      this.parts.badges.shutTips();
    }
    this.state = next;

    for (const [name, value] of Object.entries(state.attributes(next))) {
      if (value === null) this.root.removeAttribute(name);
      else this.root.setAttribute(name, value);
    }
    this.drawPill(next, was);
    qs(this.root, "[data-way-toggle]").setAttribute(
      "aria-expanded", String(next.share === "way")
    );
    qs(this.root, "[data-code-toggle]").setAttribute(
      "aria-expanded", String(next.share === "code")
    );
  }

  // The pill is the floating pane's alone, so only a floating pane
  // writes it: settling, it leaves as it was, with no "Hide" written
  // into it on its way out (#559, round 3). New words fade in with
  // the move on the sheet, the old ones fading out first: the word
  // never changes in a frame of its own (swapWords).
  drawPill(next, was) {
    const text = pillWord(next);

    if (!text) return;

    const word = qs(this.root, "[data-cart-word]");

    this.pill.setAttribute("aria-expanded", String(next.fold === "open"));
    if (wordsOf(word) !== text) {
      swapWords(word, text, {
        reduce: reduced() || !this.sheet.matches || was === next,
      });
    }
  }

  // A render's state that moves nothing (plan.mjs changed), kept
  // without being written.
  hold(next) {
    this.state = next;
  }

  // Every change of the pane's size goes through here: the phone
  // sheet's parts move with the pane (view.mjs moveParts, #559), and
  // the tablet's panel and the column ease the pane's height as before.
  //
  // On the sheet the list's arrows and fades are set inside the change,
  // before the parts' end sizes are read, so a list that ends with no
  // strip under it is measured without one: nothing jumps once the ease
  // is over (#559), and a settled list shows every line from the start.
  motion(apply) {
    const sheet = this.sheet.matches;
    const run = sheet ? moveParts : animateFold;
    const change = sheet ? () => {
      apply();
      if (this.list.getClientRects().length) this.lines.sync();
    } : apply;

    this.easing += 1;

    return run(this.root, change, { reduce: reduced() }).finally(() => {
      this.easing -= 1;
    });
  }

  // Resolves once nothing animates the pane or moves its parts: an
  // ease that another ease cancelled resolves early, while the newer
  // one still runs.
  stilled() {
    return Promise.all(
      [...this.root.getAnimations(), ...moving(this.root)]
        .map((a) => a.finished.catch(() => {}))
    );
  }

  // A fold change: applied inside the view's motion, which measures
  // the pane before and after, then the placement tick learns the new
  // height. An open sheet counts the page's travel from where it ended.
  fold(next) {
    if (next === this.state) return Promise.resolve();

    return this.motion(() => this.apply(next)).then(() => {
      this.placement.refresh();
      if (!this.easing) this.lines.sync();
      this.scrollFrom = this.easing ? null : window.scrollY;
    });
  }

  open() {
    return this.fold(state.open(this.state));
  }

  close() {
    return this.fold(state.close(this.state));
  }

  toggle() {
    return this.fold(state.toggle(this.state));
  }

  // Opens one side of the shared row over the other, or neither ("").
  setShare(share) {
    this.apply(state.setShare(this.state, share));
  }

  // The pane is in use, so a page scroll never minimizes it (#559): the
  // keyboard is up, the focus is on a field in it or on a control the
  // keys moved to, the shared row is open, Clear cart is asking, or a
  // finger is down on it.
  busy() {
    const at = document.activeElement;
    const focused = at && at !== this.root && this.root.contains(at)
      && (at.matches("input, select, textarea")
        || at.matches(":focus-visible"));

    return toPx(this.root.style.getPropertyValue("--cart-kb")) > 0
      || Boolean(focused) || Boolean(this.state.share)
      || this.parts.clear.armed || this.fingerDown;
  }

  // A page scroll's look, from the view (#559): state.mjs scrolled
  // decides; a scroll during an ease of the pane does not count.
  scrolled({ y, counts }) {
    const { state: next, from } = state.scrolled(this.state, {
      y,
      from: this.scrollFrom,
      sheet: this.sheet.matches,
      counts: counts && this.easing === 0,
      busy: this.busy(),
    });

    this.scrollFrom = from;
    if (next !== this.state) this.fold(next);
  }

  // Scrolled past: the readouts in the bars take over, and their tap
  // becomes a way back. `seen.slotBottom` is the slot's bottom edge in
  // the viewport.
  markPassed(seen) {
    const passed = passedBy({
      placement: this.state.placement, short: seen.short,
      slotBottom: seen.slotBottom,
    });

    if (this.passed === passed) return;
    this.passed = passed;
    this.form.dataset.cartPassed = String(passed);
    for (const button of all(this.form, "[data-to-cart]")) {
      button.inert = !passed;
    }
  }

  // The watchers, in their old order. `bar` is the phone's sticky top
  // bar, if any.
  wire(bar) {
    this.wireWatchers(bar);
    this.wireScroll();
    this.wireFinger();
  }

  // Where the cart sits: the view's tick feeds place() and this
  // applies what it decides. Settling opens; lifting off closes.
  wireWatchers(bar) {
    const root = this.root;

    this.placement = watchPlacement(root, this.slot, {
      bar,
      look: (seen) => {
        const next = state.place(this.state, seen);

        if (next.placement !== this.state.placement) this.fold(next);
        this.markPassed(seen);
      },
    });
    this.keyboard = watchKeyboard(root, {
      onInset: () => {},
    });
    this.lines = watchList(this.list, this.list.parentElement, {
      more: qs(root, "[data-cart-more]"),
      moreTop: qs(root, "[data-cart-more-top]"),
      paused: () => this.easing > 0 && this.sheet.matches,
    });
    this.focusClear = clearFocusUnder(root, bar);
  }

  // The open sheet minimizes when the person scrolls the page (#559),
  // and any scroll shuts a badge's tooltip before it moves (#569).
  // The pane changes form: the stay-open choice goes with the old one.
  wireScroll() {
    this.scrolls = watchScroll(this.root, {
      look: (seen) => this.scrolled(seen),
      // Proceed's tooltip stays through the pane's own ease (#706).
      onMove: () => {
        this.parts.badges.shutTips();
        if (!this.easing) this.parts.checkout.shut();
      },
    });
    this.sheet.addEventListener("change", () => {
      this.apply(state.forget(this.state));
    });
  }

  wireFinger() {
    this.root.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") this.fingerDown = true;
    }, { passive: true });
    for (const type of ["pointerup", "pointercancel"]) {
      document.addEventListener(type, (e) => {
        if (e.pointerType === "touch") this.fingerDown = false;
      }, { passive: true });
    }
  }
}
