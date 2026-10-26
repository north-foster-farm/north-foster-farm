// The cart (#477, docs/cart.md): one class owning everything inside
// #order-cart and the page's two readouts of its count and total, and
// nothing else. The order form keeps the model (the quantities in the
// catalog's rows, the method radios, the draft, stock, payment) and
// calls render() with what summary.mjs says about it; the cart calls
// back when a line is removed, a way picked, a code applied or
// Proceed to checkout pressed. Its view state (where it sits, whether
// it is folded) lives in state.mjs; the layout, the keyboard and the
// animations in view.mjs.

import Tooltip from "bootstrap/js/dist/tooltip.js";

import { celebrate } from "../celebrate.js";
import { ringsCart } from "../lib/cart-scroll.mjs";
import { packLabel } from "../lib/catalog.mjs";
import { awayFrom } from "../lib/share-away.mjs";
import { dollars } from "../lib/totals.mjs";
import { label } from "../lib/zoned.mjs";
import * as state from "./state.mjs";
import {
  animateFold, clearFocusUnder, pulsePill, revealLine, ringCart,
  showAdded, teach, watchKeyboard, watchList, watchPlacement,
} from "./view.mjs";

// The code that is a joke: the cart shows a discount growing by this
// much a minute for as long as the page is open, and nothing else
// changes. The server has never heard of it.
export const JOKE_CODE = "EGGBOI";
const JOKE_PER_MINUTE = 4000;

// The first Add's lesson (#278): how long the pane stays open on the
// new line before it shuts and the pill pulses. 2000 until #274 round
// 4 added 1.5 s.
export const TEACH_DWELL = 3500;

// How long an accepted code's note stays before it fades.
const NOTE_STAY = 15_000;
const NOTE_FADE = 700;

// How far above the screen's foot the settled cart's bottom edge is
// before the readouts in the bars take over.
const PASSED_AT = 60;

const qs = (root, selector) => root.querySelector(selector);
const all = (root, selector) => Array.from(root.querySelectorAll(selector));

// Restarts a CSS animation by re-applying its class.
const pulse = (el, className) => {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
};

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class Cart {
  // `root` is #order-cart; its parent is the slot and the heading sits
  // before the slot. `bar` is the phone's sticky top bar, if any. The
  // readouts are the form's [data-total-bar-count], [data-total-bar-total]
  // and [data-to-cart], found from `form`.
  constructor(root, {
    form, bar = null, onRemove, onWay, onCode, onCheckout,
  }) {
    this.root = root;
    this.form = form;
    this.slot = root.parentElement;
    this.heading = document.getElementById("order-cart-heading");
    this.on = { onRemove, onWay, onCode, onCheckout };
    this.state = state.initial();
    this.lastCount = null;
    this.lastTotal = null;
    this.itemsKey = null;
    // Which badges were lit at the last render, so a badge that turns
    // on can celebrate. Null until the first render, which never does.
    this.lit = null;
    this.joke = null;
    this.teaching = null;
    this.noteTimer = null;
    this.passed = null;

    this.list = qs(root, "[data-cart-items]");
    this.pill = qs(root, "[data-cart-toggle]");

    this.apply(this.state);
    this.wire(bar);
  }

  // Writes the state to the DOM: the four attributes on the aside, the
  // pill's aria-expanded and the shared row's.
  apply(next) {
    this.state = next;

    for (const [name, value] of Object.entries(state.attributes(next))) {
      if (value === null) this.root.removeAttribute(name);
      else this.root.setAttribute(name, value);
    }

    const open = next.placement !== "floating" || next.fold === "open";

    this.pill.setAttribute("aria-expanded", String(open));
    qs(this.root, "[data-cart-word]").textContent = open ? "Hide" : "Expand";
    qs(this.root, "[data-way-toggle]").setAttribute(
      "aria-expanded", String(next.share === "way")
    );
    qs(this.root, "[data-code-toggle]").setAttribute(
      "aria-expanded", String(next.share === "code")
    );
  }

  // A fold change: applied inside the view's animation, which measures
  // the pane before and after, then the placement tick learns the new
  // height.
  fold(next) {
    if (next === this.state) return Promise.resolve();

    return animateFold(this.root, () => this.apply(next), {
      reduce: reduced(),
    }).then(() => this.placement.refresh());
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
    });
    this.focusClear = clearFocusUnder(root, bar);

    // The pill folds a floating cart; Escape folds it too and leaves
    // the focus on the pill (#159). Escape in the shared row folds the
    // row first.
    this.pill.addEventListener("click", () => this.toggle());
    root.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;

      if (this.state.share) {
        const was = this.state.share;

        e.preventDefault();
        this.setShare("");
        qs(root, was === "way" ? "[data-way-toggle]" : "[data-code-toggle]")
          .focus();

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

    // The × on a cart line takes every unit of that product out.
    root.addEventListener("click", (e) => {
      const button = e.target.closest("[data-remove]");

      if (button) this.on.onRemove(button.dataset.remove);
    });

    qs(root, "[data-checkout]").addEventListener("click", () => {
      this.on.onCheckout();
    });

    this.wireShare();
    this.wireBadges();

    // The readouts in the bars go back to the cart.
    for (const button of all(this.form, "[data-to-cart]")) {
      button.addEventListener("click", () => this.show({ smooth: true }));
    }
  }

  // The shared row (#203): the way and Add discount side by side; each
  // opens over the whole row. A pick, Apply that takes, a tap or a
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
        this.setShare("");
      }
    };

    document.addEventListener("pointerdown", away);
    document.addEventListener("focusin", away);

    // The discount code: Apply, or Enter in the field.
    qs(share, "[data-code-apply]").addEventListener("click", () => {
      this.on.onCode(input.value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.on.onCode(input.value);
      }
    });
  }

  // A tap on a badge explains it; the next tap, or a tap elsewhere,
  // closes it.
  wireBadges() {
    const tips = all(this.root, "[data-tip]").map((badge) => new Tooltip(
      badge, { title: badge.dataset.tip, trigger: "click", placement: "top" }
    ));

    this.root.addEventListener("show.bs.tooltip", (e) => {
      for (const tip of tips) {
        if (tip._element !== e.target) tip.hide();
      }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("[data-tip]")) {
        for (const tip of tips) tip.hide();
      }
    });
  }

  // A page built before a money change (data/delivery.json,
  // money.changes) still carries the old tiers and minimum: bring them
  // to the day's. `money` is moneyOn()'s for the day.
  setMoney(money) {
    const tiers = money.bulkTiers.map((t) => `tier-${t.threshold}`);

    for (const badge of all(this.root, "[data-badge^='tier-']")) {
      if (!tiers.includes(badge.dataset.badge)) badge.closest("li").remove();
    }

    const delivery = qs(this.root, "[data-badge='delivery']");

    if (delivery) {
      delivery.dataset.tip = delivery.dataset.tip.replace(
        /^Orders of \$\d+ or more/,
        `Orders of $${money.deliveryMinimum} or more`
      );
    }
  }

  // Everything the cart shows, from the form's summary (summary.mjs
  // summarize) and what else the form knows: `method`, the way the
  // page holds; `ways`, which of the three can be picked; `edit`, a
  // paid order being changed ({ held, kept, keptDate, total }) or null;
  // `locked`, the stock gate; `adding`, that an Add caused this render.
  render(s, {
    method, ways = {}, edit = null, locked = false, adding = false,
  }) {
    const root = this.root;
    const count = s.count;

    const draw = () => {
      this.renderItems(s);
      this.renderSums(s);
      this.renderEdit(edit);
      this.renderWays(method, ways);
      root.toggleAttribute("data-empty", count === 0);
    };

    // The readouts, in the pane and in the bars.
    qs(root, "[data-cart-count]").textContent = s.countText;
    for (const el of all(this.form, "[data-total-bar-count]")) {
      el.textContent = s.countText;
    }
    for (const el of all(this.form, "[data-total-bar-total]")) {
      el.textContent = s.total;
    }
    for (const el of all(this.form, "[data-to-cart]")) {
      el.setAttribute(
        "aria-label", `${s.countText}, total ${s.total}. Go to the cart.`
      );
    }
    this.pill.setAttribute(
      "aria-label", `${s.countText}, total ${s.total}. Show or hide the cart.`
    );

    qs(root, "[data-checkout]").disabled = count === 0 || locked
      || (method === "delivery" && !s.eligible);

    // The lines came or went, or the cart emptied or filled: the fold
    // rule decides, and the pane eases to its new height (the column's
    // ease, #278 item 2; the sheet's fold).
    const next = state.rendered(this.state, {
      count, was: this.lastCount, adding,
    });

    this.lastCount = count;
    if (next.fold !== this.state.fold || next.empty !== this.state.empty) {
      next.empty = count === 0;
      animateFold(root, () => {
        this.apply(next);
        draw();
      }, { reduce: reduced() }).then(() => {
        this.placement.refresh();
        this.lines.sync();
      });
    } else {
      this.state = next;
      draw();
      this.placement.refresh();
      this.lines.sync();
    }

    this.renderBadges(s);

    const nudge = qs(root, "[data-nudge]");

    if (nudge.textContent !== s.nudge) nudge.textContent = s.nudge;
    nudge.hidden = !s.nudge;
    nudge.dataset.tone = s.nudgeTone || "";
  }

  // The cart's lines: each category, with its tiers indented beneath,
  // from the templates in the markup (so PurgeCSS keeps their
  // classes). Rebuilt only when the lines change: a render that
  // follows a field's change event would otherwise replace the ×
  // under the pointer between press and release, and the click would
  // be lost (#155).
  renderItems(s) {
    const key = JSON.stringify(s.groups);

    if (key === this.itemsKey) return;
    this.itemsKey = key;

    const groupTpl = qs(this.root, "template[data-cart-group]");
    const lineTpl = qs(this.root, "template[data-cart-line]");

    for (const row of all(this.list, ":scope > *")) row.remove();

    for (const group of s.groups) {
      const g = groupTpl.content.cloneNode(true);
      const items = qs(g, "[data-group-items]");

      qs(g, "[data-group-name]").textContent = group.label;
      for (const item of group.items) {
        const li = lineTpl.content.cloneNode(true);
        const remove = qs(li, "[data-remove]");

        remove.dataset.remove = item.sku;
        remove.setAttribute(
          "aria-label", `Remove ${item.lineName} from your cart`
        );
        qs(li, "[data-line-name]").textContent = packLabel(item.row);
        qs(li, "[data-line-qty]").textContent = item.qtyText;
        qs(li, "[data-line-sub]").textContent = item.subtotal;
        items.appendChild(li);
      }
      this.list.appendChild(g);
    }
  }

  renderSums(s) {
    const root = this.root;

    qs(root, "[data-total='subtotal']").textContent = s.subtotal;
    qs(root, "[data-total-row='discount']").hidden = !s.discount;
    qs(root, "[data-total='discount-label']").textContent =
      s.discount ? s.discount.label : "";
    qs(root, "[data-total='discount']").textContent =
      s.discount ? s.discount.text : "";

    const fee = qs(root, "[data-total='fee']");

    qs(root, "[data-total-row='fee']").hidden = !s.fee.show;
    fee.textContent = s.fee.show ? s.fee.text : "";
    fee.classList.toggle("order-cart-free", !!s.fee.waived);

    const total = qs(root, "[data-total='total']");

    if (this.lastTotal !== null && this.lastTotal !== s.total) {
      pulse(total, "is-bumped");
    }
    total.textContent = s.total;
    this.lastTotal = s.total;
  }

  // Changing a paid order: what is paid, a fee a missed delivery kept
  // (#193), and the difference to pay or to get back. Draft wording.
  renderEdit(edit) {
    const box = qs(this.root, "[data-edit-money]");

    box.hidden = !edit;
    if (!edit) return;

    const { held, kept, keptDate, total } = edit;
    const diff = total - (held - kept);

    qs(box, "[data-total='paid']").textContent = dollars(held);
    qs(box, "[data-edit-kept]").hidden = !kept;
    qs(box, "[data-total='kept']").textContent = `−${dollars(kept)}`;
    qs(box, "[data-total='kept-label']").textContent = keptDate
      ? `Delivery fee for the trip on ${label(keptDate)}`
      : "Delivery fee for the trip";
    qs(box, "[data-total='due-label']").textContent = diff < 0
      ? "We refund" : "You pay";
    qs(box, "[data-total='due']").textContent = dollars(Math.abs(diff));
  }

  // The shared row's button names the way the page holds; the cart
  // never picks one of its own (#203). Only the method (#352): the
  // day, time and place stay in the method's card.
  renderWays(method, ways) {
    let wayName = "";

    for (const way of all(this.root, "[data-way]")) {
      const on = way.dataset.way === method;

      way.setAttribute("aria-pressed", String(on));
      way.classList.toggle("btn-primary", on);
      way.classList.toggle("btn-outline-primary", !on);
      way.disabled = ways[way.dataset.way] === false;
      if (on) wayName = way.textContent.trim();
    }
    qs(this.root, "[data-way-name]").textContent = wayName
      || "Pickup or delivery";
  }

  // A badge that just turned on sends its chicks; the first render (a
  // restored draft) only sets the baseline. They leave the badge
  // itself; with the pane folded or the badge out of sight, the total.
  renderBadges(s) {
    const root = this.root;
    const lit = {};
    const seen = (el) => {
      const r = el.getBoundingClientRect();
      const box = root.getBoundingClientRect();

      return r.height > 0
        && r.top >= Math.max(0, box.top) - 1
        && r.bottom <= Math.min(window.innerHeight, box.bottom) + 1;
    };

    for (const badge of s.badges) {
      const el = qs(root, `[data-badge="${badge.key}"]`);

      lit[badge.key] = badge.on;
      if (!el) continue;
      el.dataset.on = String(badge.on);
      if (badge.on && this.lit && !this.lit[badge.key]) {
        celebrate(seen(el) ? el : qs(root, "[data-total='total']"));
      }
    }
    this.lit = lit;
  }

  // Scrolled past: the readouts in the bars take over, and their tap
  // becomes a way back. `seen.slotBottom` is the slot's bottom edge in
  // the viewport.
  markPassed(seen) {
    const passed = this.state.placement === "inline" && !seen.short
      && seen.slotBottom < PASSED_AT;

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
  // (#278). Every later Add leaves the pane as it is: the strip says
  // what was added while it is shut, the count ticks, the pill pulses
  // once. Whatever the pane is doing, a screen reader hears it, and the
  // focus stays where it is.
  added(sku, name) {
    const root = this.root;
    const live = qs(root, "[data-cart-live]");

    // A repeated name must be heard again: clear, then set.
    live.textContent = "";
    setTimeout(() => { live.textContent = `Added ${name} to cart`; }, 60);
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

    pulsePill(this.pill, "once");
    if (floating && this.state.fold === "closed") {
      showAdded(qs(root, "[data-cart-added-box]"), `Added: ${name}`);
    }
  }

  // The pane is the customer's once they focus in it, press a key in
  // it or tap it (the view judges a touch): the first Add's timer
  // lapses.
  keepOpen() {
    if (this.teaching) this.teaching.keep();
  }

  // The outcome of a code the form applied: `text` and `tone` for the
  // note ("good" for an accepted one); an accepted code also empties
  // the field, folds the row and moves the focus to Add discount, and
  // its note fades after a while.
  codeResult({ text = "", tone = "", accepted = false } = {}) {
    const root = this.root;
    const input = qs(root, "[data-field='code']");
    const note = qs(root, "[data-code-note]");

    clearTimeout(this.noteTimer);
    note.classList.remove("is-fading");
    note.textContent = text;
    note.hidden = !text;
    if (tone) note.dataset.tone = tone;
    else delete note.dataset.tone;

    if (!accepted) return;
    input.value = "";
    if (this.state.share === "code") {
      this.setShare("");
      qs(root, "[data-code-toggle]").focus();
    }
    this.noteTimer = setTimeout(() => {
      note.classList.add("is-fading");
      this.noteTimer = setTimeout(() => {
        note.textContent = "";
        note.hidden = true;
        note.classList.remove("is-fading");
      }, NOTE_FADE);
    }, NOTE_STAY);
  }

  startJoke() {
    if (this.joke) return;

    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    const since = Date.now();

    row.className = "order-cart-row order-cart-credit order-cart-joke";
    dt.textContent = `Discount (${JOKE_CODE}, ${
      dollars(JOKE_PER_MINUTE)}/min)`;
    row.appendChild(dt);
    row.appendChild(dd);
    qs(this.root, "[data-total-row='fee']").before(row);

    const tick = () => {
      const minutes = (Date.now() - since) / 60_000;

      dd.textContent = `−${dollars(Math.floor(minutes * JOKE_PER_MINUTE))}`;
    };

    tick();
    this.joke = { row, timer: setInterval(tick, 1000) };
  }

  stopJoke() {
    if (!this.joke) return;
    clearInterval(this.joke.timer);
    this.joke.row.remove();
    this.joke = null;
  }

  // Brings the cart into view and gives it the focus: the readouts'
  // tap, the rail's Cart link, the header's cart link and #order-cart
  // in the URL (#203, #337, #402). In the column the pane itself is
  // brought into view, only as far as it takes; below xl the heading,
  // at the top. `ring` rings the pane where the link would otherwise
  // seem to do nothing (ringsCart).
  show({ smooth = false, ring = false } = {}) {
    const column = this.state.placement === "column";
    const target = column ? this.root : this.heading;
    const block = column ? "nearest" : "start";

    if (ring && ringsCart(
      column, this.root.getBoundingClientRect(), window.innerHeight
    )) {
      ringCart(this.root);
    }
    target.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block });
    target.focus({ preventScroll: true });
  }

  // The cart's own fields, for the form's collect() and restore().
  codeValue() {
    return qs(this.root, "[data-field='code']").value;
  }

  setCodeValue(value) {
    qs(this.root, "[data-field='code']").value = value;
  }
}

// True once per browser session; the session's own storage, so a new
// page keeps the count and a new visit starts it over.
let addedBefore = false;

const firstAdd = () => {
  const key = "nff-cart-first-add";

  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, "1");

    return true;
  } catch {
    const first = !addedBefore;

    addedBefore = true;

    return first;
  }
};
