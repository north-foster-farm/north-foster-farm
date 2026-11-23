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
import { awayFrom } from "../lib/share-away.mjs";
import { Badges } from "./badges.js";
import { CheckoutButton } from "./checkout.js";
import { ClearCart } from "./clear.js";
import { codeNote } from "./code-note.mjs";
import { all, pulse, qs, reduced, say } from "./dom.js";
import { firstAdd } from "./first-add.js";
import { startJoke, stopJoke } from "./joke-row.js";
import { drawItems, dropRows } from "./lines-view.js";
import { changed, passedBy } from "./plan.mjs";
import * as state from "./state.mjs";
import {
  drawEdit, drawNudge, drawReadouts, drawSums, drawWays,
} from "./sums-view.js";
import {
  SHEET, animateFold, clearFocusUnder, focusAfterScroll, moveParts,
  moving, pulsePill,
  revealLine, ringCart, showAdded, shutShare, swapWords, teach, toPx,
  watchKeyboard, watchList, watchPlacement, watchScroll, wordsOf,
} from "./view.mjs";
import { whyOf } from "./why.mjs";

// The joke's code, for the form (joke.mjs).
export { JOKE_CODE } from "./joke.mjs";

// The first Add's lesson (#278): how long the pane stays open on the
// new line before it shuts and the pill pulses. 2000 until #274 round
// 4 added 1.5 s.
export const TEACH_DWELL = 3500;

// Resolves once nothing animates the pane or moves its parts: an ease
// that another ease cancelled resolves early, while the newer one
// still runs.
const stilled = (pane) => Promise.all(
  [...pane.getAnimations(), ...moving(pane)]
    .map((a) => a.finished.catch(() => {}))
);

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
    this.slot = root.parentElement;
    this.heading = document.getElementById("order-cart-heading");
    this.on = { onRemove, onClear, onWay, onCode, onCheckout, onBlocked };
    this.state = state.initial();
    this.lastCount = null;
    this.lastTotal = null;
    // The lines last drawn (lines-view.js), null before the first.
    this.drawn = null;
    this.joke = null;
    this.teaching = null;
    this.passed = null;
    // The phone sheet's scroll rule (#559): where the page's travel is
    // counted from, how many eases of the pane run, and whether a
    // finger is down on the pane.
    this.scrollFrom = null;
    this.easing = 0;
    this.fingerDown = false;
    this.sheet = matchMedia(SHEET);
    // The badges, their tooltips and the perks' (badges.js).
    this.badges = new Badges(root);
    // Proceed to checkout (checkout.js) and Clear cart (clear.js).
    this.checkout = new CheckoutButton(root, this.on, () => this.open());
    this.clear = new ClearCart(root, this.on);

    this.list = qs(root, "[data-cart-items]");
    this.pill = qs(root, "[data-cart-toggle]");

    this.apply(this.state);
    this.wire(bar);
  }

  // Writes the state to the DOM: the attributes on the aside, the
  // pill's aria-expanded and the shared row's. A fold or a change of
  // placement shuts an open badge tooltip first (#569).
  apply(next) {
    const was = this.state;

    if (next.fold !== was.fold || next.placement !== was.placement) {
      this.badges.shutTips();
    }
    this.state = next;

    for (const [name, value] of Object.entries(state.attributes(next))) {
      if (value === null) this.root.removeAttribute(name);
      else this.root.setAttribute(name, value);
    }

    // The pill is the floating pane's alone, so only a floating pane
    // writes it: settling, it leaves as it was, with no "Hide" written
    // into it on its way out (#559, round 3). New words fade in with
    // the move on the sheet, the old ones fading out first: the word
    // never changes in a frame of its own (swapWords).
    if (next.placement === "floating") {
      const open = next.fold === "open";
      const word = qs(this.root, "[data-cart-word]");
      const text = open ? "Hide" : "Expand";

      this.pill.setAttribute("aria-expanded", String(open));
      if (wordsOf(word) !== text) {
        swapWords(word, text, {
          reduce: reduced() || !this.sheet.matches || was === next,
        });
      }
    }
    qs(this.root, "[data-way-toggle]").setAttribute(
      "aria-expanded", String(next.share === "way")
    );
    qs(this.root, "[data-code-toggle]").setAttribute(
      "aria-expanded", String(next.share === "code")
    );
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
      || this.clear.armed || this.fingerDown;
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

  // Folds the shared row. The code field goes the way it came in, the
  // opening reversed, and instantly under reduced motion (#532); the
  // way's switch shuts at once, as before. Resolves once the row's two
  // buttons are back, so the caller can focus one.
  shutRow() {
    const part = qs(this.root, "#order-cart-code");

    if (this.state.share !== "code") {
      if (this.state.share) this.setShare("");

      return Promise.resolve();
    }

    return shutShare(part, () => {
      if (this.state.share === "code") this.setShare("");
    }, { reduce: reduced() });
  }

  wire(bar) {
    const root = this.root;

    // Where the cart sits: the view's tick feeds place() and this
    // applies what it decides. Settling opens; lifting off closes.
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

    // The open sheet minimizes when the person scrolls the page (#559),
    // and any scroll shuts a badge's tooltip before it moves (#569).
    this.scrolls = watchScroll(root, {
      look: (seen) => this.scrolled(seen),
      // Proceed's tooltip stays through the pane's own ease (#706).
      onMove: () => {
        this.badges.shutTips();
        if (!this.easing) this.checkout.shut();
      },
    });
    // The pane changes form: the stay-open choice goes with the old
    // one.
    this.sheet.addEventListener("change", () => {
      this.apply(state.forget(this.state));
    });
    root.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") this.fingerDown = true;
    }, { passive: true });
    for (const type of ["pointerup", "pointercancel"]) {
      document.addEventListener(type, (e) => {
        if (e.pointerType === "touch") this.fingerDown = false;
      }, { passive: true });
    }

    // The pill folds a floating cart; Escape folds it too and leaves
    // the focus on the pill (#159). Escape in the shared row folds the
    // row first.
    this.pill.addEventListener("click", () => this.toggle());
    root.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;

      // An open badge tooltip goes first (#569), and Proceed's (#706).
      if (this.badges.allTips().some((tip) => tip.tip)
        || this.checkout.tip.tip) {
        e.preventDefault();
        this.badges.shutTips();
        this.checkout.shut();

        return;
      }

      if (this.clear.armed) {
        e.preventDefault();
        this.clear.reset();

        return;
      }

      if (this.state.share) {
        const was = this.state.share;

        e.preventDefault();
        this.shutRow().then(() => qs(
          root, was === "way" ? "[data-way-toggle]" : "[data-code-toggle]"
        ).focus());

        return;
      }

      const { state: next, handled } = state.escape(this.state);

      if (!handled) return;
      e.preventDefault();
      this.fold(next).then(() => this.pill.focus());
    });

    // The pane is the customer's once they focus in it or press a key:
    // the first Add's timer lapses. A touch is the view's to judge.
    for (const type of ["focusin", "keydown"]) {
      root.addEventListener(type, () => this.keepOpen(), { passive: true });
    }

    // The remove icon on a cart line takes every unit of that product
    // out.
    root.addEventListener("click", (e) => {
      const button = e.target.closest("[data-remove]");

      if (button) this.on.onRemove(button.dataset.remove);
    });

    this.checkout.wire();
    this.clear.wire();
    this.wireShare();
    this.badges.wire();

    // The readouts in the bars go back to the cart.
    for (const button of all(this.form, "[data-to-cart]")) {
      button.addEventListener("click", () => this.show({ smooth: true }));
    }
  }

  // The shared row (#203): the way and Add discount side by side; each
  // opens over the whole row. A pick, Apply (#532), a tap or a
  // focus outside the row, or Escape folds it back. Blur alone does
  // not: a tap on Apply blurs the field on iOS before its click lands.
  wireShare() {
    const share = qs(this.root, "[data-cart-share]");
    const input = qs(share, "[data-field='code']");

    qs(share, "[data-way-toggle]").addEventListener("click", () => {
      this.setShare("way");
      (qs(share, "[data-way][aria-pressed='true']")
        || qs(share, "[data-way]")).focus();
    });
    qs(share, "[data-code-toggle]").addEventListener("click", () => {
      this.setShare("code");
      input.focus();
    });

    share.addEventListener("click", (e) => {
      const pick = e.target.closest("[data-way]");

      if (!pick) return;
      this.setShare("");
      qs(share, "[data-way-toggle]").focus();
      this.on.onWay(pick.dataset.way);
    });

    // A focus on an ancestor of the row is not away: Safari focuses
    // the pane, not the pick it tapped (#383, share-away.mjs).
    const away = (e) => {
      if (this.state.share && awayFrom(
        { dataset: { share: this.state.share }, contains: (n) =>
          share.contains(n) }, e.target, e.type === "focusin"
      )) {
        this.shutRow();
      }
    };

    document.addEventListener("pointerdown", away);
    document.addEventListener("focusin", away);

    // The discount code: Apply, or Enter in the field (#532). An empty
    // field takes the code off and closes at once; a code closes the
    // field once the form has an answer (codeResult), accepted or
    // refused, the refused one left in the field for the next open. A
    // group's code asks first, and Cancel there leaves the field open
    // with the code in it (#495, decision 5).
    const submit = () => {
      const empty = !input.value.trim();

      this.on.onCode(input.value);
      if (empty) this.shutCode();
    };

    qs(share, "[data-code-apply]").addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    this.note = this.wireCodeNote();
  }

  // Folds the code field after Apply and hands the focus back to Add
  // discount, unless something else took it meanwhile (a dialog).
  shutCode() {
    const share = qs(this.root, "[data-cart-share]");

    return this.shutRow().then(() => {
      const at = document.activeElement;

      if (!at || at === document.body || share.contains(at)) {
        qs(share, "[data-code-toggle]").focus();
      }
    });
  }

  // The line under the code (code-note.mjs): drawn here, timed there.
  wireCodeNote() {
    const input = qs(this.root, "[data-field='code']");
    const note = qs(this.root, "[data-code-note]");

    return codeNote({
      show: ({ text, tone, fading }) => {
        note.classList.toggle("is-fading", fading);
        note.textContent = text;
        note.hidden = !text;
        if (tone) note.dataset.tone = tone;
        else delete note.dataset.tone;
      },
      clear: () => { input.value = ""; },
    });
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
    const root = this.root;
    const count = s.count;

    this.summary = s;

    const draw = () => {
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
    };

    drawReadouts({ root, form: this.form, pill: this.pill }, s);

    this.checkout.setWhy(whyOf(s, { method, locked, down }));

    // The lines came or went, or the cart emptied or filled: the fold
    // rule decides, and the pane eases to its new height (the column's
    // ease, #278 item 2; the sheet's fold).
    const next = state.rendered(this.state, {
      count, was: this.lastCount, adding,
    });

    this.lastCount = count;

    const moved = changed({
      next, was: this.state, lines: s.groups, drawn: this.drawn,
      nudge: s.nudge, nudgeShown: !qs(root, "[data-nudge]").hidden,
    });

    if (moved) {
      next.empty = count === 0;
      // The badges after the ease: a badge that lights sends its chicks
      // from where it is seen, and mid-ease it may lie past the pane's
      // old edge. A render that follows at once cancels this ease and
      // starts its own, and the ease it cancels resolves early: only
      // the latest render's end counts. A render with nothing to ease
      // may come before it ends (a sign-in's perks, #717): the badges
      // follow the latest summary, not this one.
      const seq = this.renders = (this.renders || 0) + 1;

      this.motion(() => {
        this.apply(next);
        draw();
      }).then(() => stilled(root)).then(() => {
        if (seq !== this.renders) return;
        dropRows(this.list, this.drawn);
        this.placement.refresh();
        this.lines.sync();
        this.badges.draw(this.summary);
      });
    } else {
      this.state = next;
      draw();
      this.placement.refresh();
      this.lines.sync();
      this.badges.draw(s);
    }
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

  // The feedback for an Add (#267). The first of a browser session
  // opens the floating pane on the lines, scrolled to the new line,
  // shuts it after TEACH_DWELL and pulses the pill in three pairs
  // (#278). Every later Add leaves the pane as it is: the count ticks,
  // and while the pane is shut the strip says what was added and the
  // pill pulses once. Whatever the pane is doing, a screen reader hears
  // it, and the focus stays where it is.
  added(sku, name) {
    const root = this.root;
    const live = qs(root, "[data-cart-live]");

    say(live, `Added ${name} to cart`);
    pulse(qs(root, "[data-cart-count]"), "is-ticked");

    this.keepOpen();

    const floating = this.state.placement === "floating";

    if (floating && firstAdd()) {
      this.open().then(() => {
        const button = qs(root, `[data-remove="${CSS.escape(sku)}"]`);

        if (button) revealLine(this.list, button.closest("li"));
      });
      this.teaching = teach(root, this.pill, {
        dwell: TEACH_DWELL,
        onShut: () => {
          this.teaching = null;
          this.close().then(() => pulsePill(this.pill, "teach"));
        },
      });

      return;
    }

    // The pill pulses only to say where a closed cart went (#559): on
    // an open pane its ring read as a focus ring on Hide that nobody
    // had moved there.
    if (floating && this.state.fold === "closed") {
      pulsePill(this.pill, "once");
      showAdded(qs(root, "[data-cart-added-box]"), `Added: ${name}`);
    }
  }

  // The pane is the customer's once they focus in it, press a key in
  // it or tap it (the view judges a touch): the first Add's timer
  // lapses.
  keepOpen() {
    if (this.teaching) this.teaching.keep();
  }

  // The signed-in customer's perks (#514, badges.js), with a buying
  // group's `member`.
  setPerks(perks, options) {
    this.badges.setPerks(perks, options);
  }

  // The outcome of a code the form applied: `text` and `tone` for the
  // note ("good" for an accepted one). An accepted code also empties
  // the field; its note, and that of a code `refused` on Apply, fades
  // after a short while (code-note.mjs), and either folds the field if
  // it is open (#532). A note that `stays` (the rate limit's) folds the
  // field too but stays until the next one.
  codeResult({
    text = "", tone = "", accepted = false, refused = false, stays = false,
  } = {}) {
    this.note.result({ text, tone, accepted, refused, stays });
    if ((accepted || refused) && this.state.share === "code") {
      this.shutCode();
    }
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
    const column = this.state.placement === "column";
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

  // The cart's own fields, for the form's collect() and restore().
  codeValue() {
    return qs(this.root, "[data-field='code']").value;
  }

  setCodeValue(value) {
    qs(this.root, "[data-field='code']").value = value;
  }
}
