import Tooltip from "bootstrap/js/dist/tooltip.js";

import {
  FLOAT_AGAIN, floatsAgain, look, segOn,
} from "./lib/cart-float.mjs";
import { current, indexCatalog, packLabel } from "./lib/catalog.mjs";
import {
  keyboardInset, moreStop, rowsFloor, visibleArea,
} from "./lib/cart-scroll.mjs";
import { buildModel } from "./lib/events.mjs";
import { moneyOn } from "./lib/money-on.mjs";
import {
  draftOccurrence, dropOnly, dropSeriesCode, fulfilmentDate, locationCount,
  placesFact,
} from "./lib/scheduled.mjs";
import { linkedMethod, withoutParam } from "./lib/query.mjs";
import { sentence } from "./lib/sentence.mjs";
import { summarize } from "./lib/summary.mjs";
import {
  computeTotals, dollars, meetsMinimum, toCents,
} from "./lib/totals.mjs";
import {
  disallowedFor, normalizeCode, phoneOk, validateOrder, zipInfo,
} from "./lib/validate.mjs";
import { pickupTimes, windowLabel } from "./lib/schedule.mjs";
import { label, today } from "./lib/zoned.mjs";
import { celebrate } from "./celebrate.js";
import { DateLists } from "./date-lists.js";
import { Draft } from "./draft.js";
import { Errors } from "./errors.js";
import { Lapsed } from "./lapsed.js";
import { Payment } from "./pay.js";
import { Pending } from "./pending.js";
import { crumb } from "./report.js";
import { wireSwitch } from "./restock.js";
import { Stock } from "./stock.js";
import { Submitter } from "./submit.js";
import { announceCart } from "../cart-badge/announce.js";
import { stampFrom } from "../session/cache.js";
import { me } from "../session/session.js";
import { api } from "../utils/api.js";
import { setBusy as spin } from "../utils/busy-button.js";
import { whileLoading } from "../utils/skeleton.js";

// A send that can't get through is tried once more this soon, while
// the page still shows it being placed, and then not again (#154).
const RETRY_DELAY = 3000;

// The code that is a joke: the cart shows a discount growing by this
// much a minute for as long as the page is open, and nothing else
// changes. The server has never heard of it.
const JOKE_CODE = "EGGBOI";
const JOKE_PER_MINUTE = 4000;

const sha256 = async (text) => {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0")).join("");
};

const qs = (root, selector) => root.querySelector(selector);
const all = (root, selector) => Array.from(root.querySelectorAll(selector));

// Restart a CSS animation by re-applying its class.
const pulse = (el, className) => {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
};

// Brings the rail's lit link into view inside whatever box scrolls the
// rail, never the page. scrollIntoView moved Chromium's Tab starting
// point to the link, so on load the first Tab skipped the skip link
// for the link after it (#291).
const keepInRail = (link) => {
  let box = link.parentElement;

  while (box && box !== document.body) {
    const { overflowY } = getComputedStyle(box);

    const scrolls = /auto|scroll/.test(overflowY);

    if (scrolls && box.scrollHeight > box.clientHeight) break;
    box = box.parentElement;
  }
  if (!box || box === document.body) return;

  const a = link.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const by = a.top < b.top ? a.top - b.top
    : a.bottom > b.bottom ? a.bottom - b.bottom : 0;

  if (by) box.scrollBy({ top: by, behavior: "smooth" });
};

// Where the cart is a one-column sheet with the total row's two as
// tabs: a phone, upright or on its side (#278). A phone on its side is
// tablet-wide but too short for the tablet's two columns. The
// stylesheet's $cart-sheet is the same query.
const SHEET = "(max-width: 767.98px), "
  + "(max-width: 1199.98px) and (max-height: 500px)";

// Too short for the cart to float or a bar to ride along, at any
// width: a phone on its side, whatever Safari's bars are doing (#274,
// round 4). The cart stays settled. The stylesheet's $cart-short.
const SHORT = "(max-height: 500px)";

// The first Add's lesson (#278): how long the pane stays open on the
// new line, then the Hide/Show pill's three pairs of pulses (the
// stylesheet's order-pill-teach), or its still emphasis under reduced
// motion. 2000 until #274 round 4 added 1.5 s.
const TEACH_DWELL = 3500;
const PULSE_MS = { teach: 4400, once: 520, still: 2600 };

export class OrderForm {
  static init() {
    document.addEventListener("DOMContentLoaded", () => {
      const form = document.getElementById("order-form");

      if (form) new OrderForm(form).start();
    });
  }

  // The prices in force today in the farm's zone, so the 1 January
  // changes (data/delivery.json, money.changes) arrive with the day;
  // an order being changed keeps those of the day it was placed.
  get money() {
    const placed = this.editing && this.editing.placed;

    return moneyOn(this.terms.money, today(
      placed ? new Date(placed) : this.dates.now(), this.terms.timeZone
    ));
  }

  constructor(form) {
    const data = JSON.parse(document.getElementById("order-data").textContent);

    this.form = form;
    this.catalog = data.catalog;
    this.aliases = data.aliases || {};
    // The scheduled pickups the page validates against, built as the
    // functions build them (lib/events.mjs).
    this.terms = {
      ...data.terms, model: buildModel(data.locations, data.series),
    };
    // The drop site's series code (data/series.json), for the old
    // ?method=scituate link and a draft saved before scheduled pickup.
    this.dropSeries = dropSeriesCode(this.terms.model);
    this.drop = this.terms.model.series
      .find((s) => s.code === this.dropSeries) || {};
    this.contact = data.contact;
    // Discount codes, by hash; the plain codes stay on the server.
    this.codes = data.codes || [];
    this.code = null;
    // A pass the farm issued (#182): its code, once /api/pass says it
    // lifts the delivery minimum, and whether it waives the delivery
    // fee too. The server checks it again. To the customer it is a
    // discount code like any other.
    this.pass = null;
    this.passFee = false;
    this.joke = null;
    this.index = indexCatalog(this.catalog);
    this.errors = new Errors(form);
    // /order/?edit=<id> changes a paid order (startEdit): its own draft,
    // so the cart the header reads is left alone, and its own endpoint.
    const edit = new URLSearchParams(location.search).get("edit") || "";

    this.editId = /^[A-Za-z0-9-]{1,32}$/.test(edit) ? edit : null;
    this.editing = null;
    this.draft = new Draft(this.editId ? { name: `nff-edit-${this.editId}` }
      : {});
    this.dates = new DateLists(form, () => this.refresh());
    this.dates.place = (code) => this.terms.model.location(code);
    // A pickup time to select once its day's windows are drawn: a
    // restored draft's, or the dialog's.
    this.wantedWindow = null;
    this.lapsed = new Lapsed(document.getElementById("order-lapsed"), {
      onUse: (choice) => this.useLapsed(choice),
      onOther: (method) => this.otherWay(method),
    });
    this.submitter = new Submitter(this.editId
      ? { url: `/api/account/orders/${this.editId}/edit` }
      : {});
    this.saveButton = document.getElementById("order-save");
    this.stock = new Stock(form, {
      onChange: (notice) => this.stockMoved(notice),
      setQty: (input, n) => this.setQty(input, n),
      inStockOnly: wireSwitch(form),
    });
    this.stockNotice = document.getElementById("order-stock");
    this.cart = document.getElementById("order-cart");
    this.result = document.getElementById("order-result");
    this.pending = new Pending(document.getElementById("order-pending"));
    this.submitButton = document.getElementById("order-submit");
    this.payment = new Payment(document.getElementById("payment"), this);
    this.lastTotal = null;
    this.lastCount = null;
    this.busy = false;
    // The quantity box with focus, which refresh() keeps open.
    this.typing = null;
    // Which badges were lit at the last render, so a badge that turns
    // on can celebrate. Null until the first render, which never does.
    this.lit = null;
    // The signed-in customer's discount group, from /api/me. The server
    // applies it again from the session; this only shows it.
    this.group = null;
    // Whether /api/me said so: the thank-you card then leaves out the
    // line about the account the order made (#114).
    this.isSignedIn = false;
  }

  start() {
    if (this.editId) {
      this.startEdit();

      return;
    }

    this.wire();

    // Nothing is retried in the background any more (#154); an order
    // an older page left to retry is forgotten, its draft kept.
    this.draft.clearPending();

    const draft = this.draft.load();

    if (draft && draft.payload) this.restore(draft.payload);

    this.methodFromQuery();
    this.addFromQuery();
    this.dates.load();
    this.applyCode({ quiet: true });
    this.refresh();
    this.stock.start();
    this.payment.start();

    // A signed-in customer sees their discount group as they shop, and
    // their details arrive already filled in, under skeletons while
    // they come (#271). Someone with no session stamp is signed out,
    // so their fields never wait; if the answer fails, they type.
    const fields = stampFrom(document.cookie)
      ? all(this.form, "[data-prefill-region]")
      : [];

    whileLoading(fields, me, { render: (who) => this.signedIn(who) });
  }

  signedIn(who) {
    if (!who.signedIn || !who.customer) return;

    this.isSignedIn = true;

    const group = who.customer.discountGroup || null;

    if (group && group !== this.group) {
      this.group = group;
      this.refresh();
    }
    this.prefill(who.customer);
  }

  // /order/?edit=<id>: the page opens one of the customer's paid orders
  // for a change (#160), priced by the same code as a new order. What
  // is paid shows under the total with the difference, which is all
  // the payment section takes; with nothing to pay, Save changes sends
  // it. An order that cannot be changed goes back to the account page.
  async startEdit() {
    this.wire();

    const { ok, status, data } = await api("/api/account/orders");

    if (status === 401) {
      location.replace(`/login/?next=${encodeURIComponent(
        location.pathname + location.search
      )}`);

      return;
    }

    const order = ok
      ? (data.orders || []).find((o) => o.id === this.editId)
      : null;

    if (!order || !order.canChange) {
      location.replace("/account/#orders");

      return;
    }

    const sum = (list) => (list || []).reduce((s, x) => s + (x.amount || 0),
      0);

    // A fee a missed delivery kept paid for that trip: it counts toward
    // nothing now (#193).
    this.editing = {
      id: order.id, held: sum(order.payments) - sum(order.refunds),
      kept: order.keptFee || 0, placed: order.submittedAt,
    };
    for (const line of order.lines) {
      this.stock.held[line.sku] = line.qty;
      this.hold(line);
    }

    const who = await me().catch(() => ({}));
    const customer = (who && who.customer) || {};

    this.group = customer.discountGroup || null;
    this.pass = order.pass || null;
    this.passFee = !!(order.pass && order.passWaivesFee);

    const saved = this.draft.load();

    this.restore(saved ? saved.payload : {
      customer: { ...order.customer, email: customer.email },
      lines: order.lines.map(({ sku, qty }) => ({ sku, qty })),
      fulfilment: order.fulfilment,
      code: order.code,
    });

    const banner = document.getElementById("order-editing");

    // Draft wording.
    banner.textContent = `You're changing order ${order.id}. You pay ` +
      "only the difference, or we refund it.";
    banner.hidden = false;
    for (const heading of document.querySelectorAll(
      ".page-heading h1, [data-topbar-title]"
    )) {
      heading.textContent = "Change your order";
    }
    this.saveButton.addEventListener("click", (e) => this.submit(e));

    this.dates.load();
    this.applyCode({ quiet: true });
    this.refresh();
    this.stock.start();
    this.payment.start();
  }

  // A line the paid order holds. An archived one's row shows, and its
  // quantity can fall but never rise past what is held (6305650920):
  // the line stays in the order rather than vanishing and being
  // refunded on save.
  hold({ sku, qty }) {
    const input = this.form.querySelector(`[data-qty="${CSS.escape(sku)}"]`);
    const row = input && input.closest(".order-item[data-archived]");

    if (!row) return;
    row.dataset.held = "";
    input.dataset.max = String(qty);
  }

  // Under the total while changing a paid order: what is paid and the
  // difference. With nothing to pay, Save changes stands in for the
  // payment section.
  renderEdit(total) {
    if (!this.editing) return;

    const box = qs(this.cart, "[data-edit-money]");
    const { held, kept } = this.editing;
    const diff = total - (held - kept);

    box.hidden = false;
    qs(box, "[data-total='paid']").textContent = dollars(held);
    qs(box, "[data-edit-kept]").hidden = !kept;
    qs(box, "[data-total='kept']").textContent = `−${dollars(kept)}`;
    // Draft wording.
    qs(box, "[data-total='due-label']").textContent = diff < 0
      ? "To refund"
      : "To pay";
    qs(box, "[data-total='due']").textContent = dollars(Math.abs(diff));
    this.payment.root.hidden = diff <= 0;
    this.saveButton.hidden = diff > 0;
    // The card's own Pay button shows only with the card chosen.
    this.submitButton.hidden = diff <= 0
      || this.payment.state.dataset.cardOpen !== "true";
  }

  // Name, email and phone from the customer's record, filled in as
  // ordinary fields.
  prefill(customer) {
    let any = false;

    for (const input of all(this.form, "[data-prefill]")) {
      const value = customer[input.dataset.prefill];

      if (!value) continue;
      if (!input.value) input.value = value;
      any = true;
    }
    this.formatPhone();

    // A customer who already said yes to farm news sees the box ticked;
    // it starts unticked for everyone else.
    const news = qs(this.form, "[data-field='customer.marketing']");

    if (news && customer.marketing === true && !news.checked) {
      news.checked = true;
      any = true;
    }

    this.showContact();
    if (any) this.draft.save(this.collect());
  }

  // The phone number as "(xxx) xxx-xxxx" while it is typed. A
  // deletion that lands on a bracket or a dash takes the digit before
  // it too, so backspace never fights the mask. A leading 1 is dropped.
  formatPhone(deleting = false) {
    const input = qs(this.form, "[data-field='customer.phone']");
    const raw = input.value;
    let digits = raw.replace(/\D/g, "");

    if (digits.length === 11 && digits.startsWith("1")) {
      digits = digits.slice(1);
    }
    if (deleting && /\D$/.test(raw)) digits = digits.slice(0, -1);
    digits = digits.slice(0, 10);

    const out = digits.length <= 3 ? (digits ? `(${digits}` : "")
      : digits.length <= 6 ? `(${digits.slice(0, 3)}) ${digits.slice(3)}`
        : `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;

    if (out !== raw) input.value = out;
  }

  // "Prefer text or call?" shows once the phone number is one we could
  // use, and fades in when it appears.
  showContact() {
    const row = qs(this.form, "[data-contact-row]");
    const phone = qs(this.form, "[data-field='customer.phone']");
    const on = phoneOk(phone.value.trim());

    if (row.dataset.shown === String(on)) return;
    row.dataset.shown = String(on);
    if (on) {
      row.classList.add("is-entering");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        row.classList.remove("is-entering");
      }));
    }
  }

  wire() {
    this.form.addEventListener("input", () => {
      this.changed();
      this.revalidate();
    });
    this.form.addEventListener("change", (e) => {
      this.changed();
      this.revalidate();
      if (e.target.name === "method" && !this.quietMethod) {
        this.revealMethod();
      }
      if (e.target.name === "customer.marketing" && e.target.checked) {
        celebrate(e.target);
      }
    });
    this.form.addEventListener("submit", (e) => this.submit(e));
    this.form.addEventListener("click", (e) => this.step(e));

    // Blur normalises whatever was typed into a quantity box.
    this.form.addEventListener("focusin", (e) => {
      if (e.target.matches("[data-qty]")) this.typing = e.target;
    });
    this.form.addEventListener("focusout", (e) => {
      if (e.target.matches("[data-qty]")) {
        this.typing = null;
        this.setQty(e.target, this.qty(e.target));
        this.refresh();
      }
      this.revalidate(e.target);
    });

    const phone = qs(this.form, "[data-field='customer.phone']");

    phone.addEventListener("input", (e) => {
      this.formatPhone((e.inputType || "").startsWith("delete"));
      this.showContact();
    });
    this.formatPhone();
    this.showContact();

    // Below xl the cart folds down to the total row and the foot: the
    // toggle, the way on and the nudge.
    const cartToggle = qs(this.cart, "[data-cart-toggle]");

    for (const type of ["pointerdown", "touchstart", "focusin", "keydown"]) {
      this.cart.addEventListener(type, () => this.keepOpen(), {
        passive: true,
      });
    }
    cartToggle.addEventListener("click", () => {
      this.setOpen(this.cart.dataset.open !== "true");
    });
    // Escape folds it while it floats, and leaves the focus on the
    // toggle that opens it again (#159).
    this.cart.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || this.cart.dataset.stuck !== "true"
        || this.cart.dataset.open !== "true") return;
      e.preventDefault();
      this.setOpen(false);
      cartToggle.focus();
    });
    // A control the Tab key reaches under the floating cart scrolls up
    // clear of it, never under the top bar (#159, WCAG 2.4.11). The
    // cart's own are its own, and a scroller taller than the room is
    // left where it is. The cart may grow once the bar sticks, so it
    // looks again a frame later.
    const clear = (el) => {
      if (this.cart.dataset.stuck !== "true" || this.cart.contains(el)
        || document.activeElement !== el) return;

      const r = el.getBoundingClientRect();
      const floor = this.cart.getBoundingClientRect().top;
      const ceiling = bar ? Math.max(0, bar.getBoundingClientRect().bottom)
        : 0;

      if (r.height > (floor - ceiling) / 2) return;

      const over = Math.min(r.bottom + 12 - floor, r.top - ceiling - 12);

      if (over > 0) window.scrollBy({ top: over, behavior: "instant" });
    };

    document.addEventListener("focusin", (e) => {
      clear(e.target);
      requestAnimationFrame(() => requestAnimationFrame(
        () => clear(e.target)
      ));
    });
    qs(this.cart, "[data-checkout]").addEventListener("click", () => {
      const target = document.getElementById("pickup");

      target.scrollIntoView({ behavior: "smooth", block: "start" });
      qs(target, "legend").focus({ preventScroll: true });
    });

    // The total row's two controls (#203, #267): one segmented control.
    // On a phone it is a pair of tabs that take turns, one always
    // showing; from md the two fold their own parts. Below xl only; the
    // column shows both and its count and total are plain text.
    const itemsToggle = qs(this.cart, "[data-cart-items-toggle]");
    const moneyToggle = qs(this.cart, "[data-cart-money-toggle]");
    const seg = qs(this.cart, "[data-cart-seg]");
    const narrow = matchMedia(SHEET);
    const other = { items: "money", money: "items" };
    // A tap on either while the pane is hidden opens it on that part
    // (#278).
    const unfold = () => {
      if (this.cart.dataset.open !== "false") return false;
      this.setOpen(true);

      return true;
    };
    const pick = (part) => {
      unfold();
      this.setPart(part, true);
      this.setPart(other[part], false);
    };
    const flip = (part) => {
      if (narrow.matches) return pick(part);
      this.setPart(part, unfold() || this.cart.dataset[part] !== "open");
    };

    itemsToggle.addEventListener("click", () => flip("items"));
    moneyToggle.addEventListener("click", () => flip("money"));
    // Tabs: the arrows move the pick and the focus with it.
    seg.addEventListener("keydown", (e) => {
      if (!narrow.matches || seg.hasAttribute("data-plain")) return;

      const keys = {
        ArrowLeft: "items", ArrowUp: "items", Home: "items",
        ArrowRight: "money", ArrowDown: "money", End: "money",
      };
      const part = keys[e.key];

      if (!part) return;
      e.preventDefault();
      pick(part);
      (part === "items" ? itemsToggle : moneyToggle).focus();
    });
    narrow.addEventListener("change", () => this.syncSeg());
    this.syncSeg();
    // Settled, the cart shows everything and the two are plain text
    // too (#203): stuckWatch below calls this when it settles.
    const column = matchMedia("(min-width: 1200px)");
    const folds = all(this.cart, ".order-cart-fold");
    const plain = () => {
      const still = column.matches || this.cart.dataset.stuck === "false";

      itemsToggle.disabled = still;
      moneyToggle.disabled = still;
      seg.toggleAttribute("data-plain", still);
      this.syncSeg();
      // Folded, what the fold hides is out of the Tab order too, or the
      // focus goes under the bar (#159). The column never folds.
      const folded = !column.matches && this.cart.dataset.open === "false";

      for (const fold of folds) fold.inert = folded;
    };

    this.plainTotals = plain;
    column.addEventListener("change", plain);
    plain();

    this.wireShare();
    this.watchKeyboard();

    // The header's total, once the cart has scrolled away, goes back
    // to it (#203).
    for (const button of all(this.form, "[data-to-cart]")) {
      button.addEventListener("click", () => {
        const heading = document.getElementById("order-cart-heading");

        heading.scrollIntoView({ behavior: "smooth", block: "start" });
        heading.focus({ preventScroll: true });
      });
    }

    // Below xl the pane floats at the foot of the screen while its
    // place in the page is further down, and settles into the flow
    // after the last row. Floating it casts a shadow; settled it is
    // flat and carries its heading. Sticky gives no event for this,
    // so the rect says which.
    // On a phone the cart may grow up to the top bar, wherever the bar
    // is: until the page scrolls it to the top, it sits lower (#180).
    let stuckTick = null;
    const bar = document.querySelector(".order-topbar");
    const cartHeading = document.getElementById("order-cart-heading");
    // The pane's height while it last floated, under its cap.
    let floatH = 0;
    const stuckWatch = () => {
      stuckTick = null;

      const r = this.cart.getBoundingClientRect();
      const short = matchMedia(SHORT).matches;
      const below = matchMedia("(max-width: 1199.98px)").matches;
      // The pane rests a margin and the toolbar's gap above the foot
      // of the layout viewport (--cart-gap), the keyboard aside.
      const rest = (parseFloat(getComputedStyle(this.cart).bottom) || 12)
        - (this.keyboard || 0);
      // Its place in the flow, under the heading, and its height as it
      // last floated decide (lib/cart-float.mjs look); settled it is no
      // longer sticky (_order.scss). Not while its padding eases back
      // in: short for that moment, it would settle again for a frame.
      const place = cartHeading.getBoundingClientRect().bottom
        + parseFloat(getComputedStyle(cartHeading).marginBottom);
      const seen = look({ stuck: this.cart.dataset.stuck, floatH }, {
        place,
        height: r.height,
        room: window.innerHeight - rest - 1,
        easing: this.cart.getAnimations().length > 0,
        hidden: () => this.hiddenHeight(r.width),
      });

      floatH = seen.floatH;

      const floating = below && !short && seen.stuck === "true";
      const barRect = bar ? bar.getBoundingClientRect() : null;
      const barBottom = barRect ? barRect.bottom : 0;

      // The phone bar casts its shadow only once stuck; at rest it
      // lies flat under the header (O5).
      if (bar) bar.dataset.stuck = String(barRect.top <= 0.5);
      this.cart.style.setProperty(
        "--cart-bar", `${Math.max(0, Math.round(barBottom))}px`
      );
      const was = this.cart.dataset.stuck;

      if (was !== String(floating)) {
        this.cart.dataset.stuck = String(floating);
        // On the way back up it lifts off hidden, on its lines,
        // whatever it was when it settled (#274, round 5).
        if (below && floatsAgain(was, floating)) {
          this.setOpen(FLOAT_AGAIN.open);
          this.setPart("items", FLOAT_AGAIN.items === "open");
          this.setPart("money", FLOAT_AGAIN.money === "open");
        }
        // The cap and what gives way to it apply only while it floats.
        this.syncScroll();
      }
      // Settled, the cart is always open and its toggle fades.
      if (below && !floating && this.cart.dataset.open === "false") {
        this.setOpen(true);
      }
      // So are the lines and the sums, subtotal included (#203).
      if (below && !floating) {
        if (this.cart.dataset.items !== "open") this.setPart("items", true);
        if (this.cart.dataset.money !== "open") this.setPart("money", true);
      }
      this.plainTotals();
      // Scrolled past: the total bar takes over, and its total becomes
      // a way back.
      const passed = below && !short && r.bottom < 60;

      if (this.form.dataset.cartPassed !== String(passed)) {
        this.form.dataset.cartPassed = String(passed);
        for (const button of all(this.form, "[data-to-cart]")) {
          button.inert = !passed;
        }
      }
    };
    const onScroll = () => {
      if (stuckTick === null) stuckTick = requestAnimationFrame(stuckWatch);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    stuckWatch();

    // The list of lines scrolls once the cart would take half the
    // screen; the fades at its edges say there is more.
    qs(this.cart, "[data-cart-items]").addEventListener(
      "scroll", () => this.syncScroll(), { passive: true }
    );
    qs(this.cart, ".order-cart-fold").addEventListener(
      "transitionend", () => this.syncScroll()
    );
    qs(this.cart, "[data-cart-more]").addEventListener("click", () => {
      this.scrollMore(1);
    });
    qs(this.cart, "[data-cart-more-top]").addEventListener("click", () => {
      this.scrollMore(-1);
    });
    window.addEventListener("resize", () => this.syncScroll());
    // The cap follows the top bar on a phone, so the list also grows
    // and shrinks as the page scrolls; recount what is beyond it.
    new ResizeObserver(() => this.syncScroll()).observe(
      qs(this.cart, "[data-cart-items]")
    );

    // The × on a cart line takes every unit of that product out.
    this.cart.addEventListener("click", (e) => {
      const button = e.target.closest("[data-remove]");

      if (!button) return;

      const sku = CSS.escape(button.dataset.remove);
      const input = qs(this.form, `[data-qty="${sku}"]`);

      if (!input) return;
      this.setQty(input, 0);
      this.changed();
    });

    // A page built before a money change (data/delivery.json,
    // money.changes) took effect still carries the old badges and
    // minimum: bring them to today's.
    const tiers = this.money.bulkTiers.map((t) => `tier-${t.threshold}`);

    for (const badge of this.editId ? [] : all(this.cart,
      "[data-badge^='tier-']")) {
      if (!tiers.includes(badge.dataset.badge)) badge.remove();
    }

    const delivery = qs(this.cart, "[data-badge='delivery']");

    if (delivery && !this.editId) {
      delivery.dataset.tip = delivery.dataset.tip.replace(
        /^Orders of \$\d+ or more/,
        `Orders of $${this.money.deliveryMinimum} or more`
      );
    }

    // A tap on a badge explains it; the next tap, or a tap elsewhere,
    // closes it.
    const tips = all(this.cart, "[data-tip]").map((badge) => new Tooltip(
      badge, { title: badge.dataset.tip, trigger: "click", placement: "top" }
    ));

    this.cart.addEventListener("show.bs.tooltip", (e) => {
      for (const tip of tips) {
        if (tip._element !== e.target) tip.hide();
      }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("[data-tip]")) {
        for (const tip of tips) tip.hide();
      }
    });

    // The discount code: Apply, or Enter in the field.
    qs(this.cart, "[data-code-apply]").addEventListener("click", () => {
      this.applyCode();
    });
    qs(this.cart, "[data-field='code']").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.applyCode();
      }
    });

    this.watchSections();
  }

  // The section on screen, named in three places: the sidebar's
  // outline from lg up, the phone's sticky bar below lg, and the total
  // bar from lg to xl. Bootstrap's spy only hears sections crossing a
  // band, so a fast scroll left a stale name, and the last section,
  // too short to reach the band, never lit (#204). This asks where
  // each section is on every frame the page moves.
  watchSections() {
    const nav = document.getElementById("order-nav");
    const catalog = document.getElementById("order-catalog");
    const titles = all(document, "[data-topbar-title]");
    const bars = all(document, ".order-topbar, .order-total-bar");
    const heading = document.querySelector(".page-heading h1");
    const wide = window.matchMedia("(min-width: 992px)");
    const xl = window.matchMedia("(min-width: 1200px)");
    const sections = all(nav, "a")
      .map((link) => ({
        link, target: document.querySelector(link.hash),
      }))
      .filter(({ target }) => target);
    // Each category's link, by its section; the catalog's rows, top to
    // bottom.
    const cats = new Map(sections
      .filter(({ target }) => target.classList.contains("order-cat"))
      .map(({ link, target }) => [target, link]));
    const rows = all(catalog, ".order-item");
    const cartHeading = document.getElementById("order-cart-heading");
    let shown = null;
    let tick = null;

    // Mark the link and its parent in the outline (Catalog, over a
    // category).
    const mark = (link) => {
      const parent = link.closest(".order-side-sub")
        ?.closest(".nav-item").querySelector(":scope > .nav-link");

      for (const a of all(nav, ".nav-link")) {
        a.classList.toggle("active", a === link || a === parent);
      }
      if (wide.matches) keepInRail(link);
    };

    const update = () => {
      tick = null;

      // A section is current once its top reaches the lower edge of
      // whichever bar is stuck at the top, less a little so a jump to
      // it lands inside it. The floating cart is at the foot of the
      // screen, not at its place in the page, so it counts only once
      // settled. From xl it is a column stuck beside the others and
      // never counts.
      const column = xl.matches;
      const edge = bars.reduce((low, bar) => {
        const r = bar.getBoundingClientRect();

        return bar.offsetParent && getComputedStyle(bar).opacity !== "0"
          && r.top <= 1 ? Math.max(low, r.bottom) : low;
      }, 0);
      const line = edge + 24;
      const end = window.innerHeight + window.scrollY
        >= document.documentElement.scrollHeight - 2;
      let current = null;
      let best = -Infinity;

      for (const { link, target } of sections) {
        if (target.dataset.stuck === "true") continue;
        if (column && target.id === "order-cart") continue;
        // Settled, the cart begins at its heading, above the pane.
        const top = (target.id === "order-cart" ? cartHeading : target)
          .getBoundingClientRect().top;

        // On a tie the later link wins: a category over the catalog.
        // At the foot of the page the last section on screen wins,
        // since it may be too short ever to reach the line.
        if ((top <= line || (end && top < window.innerHeight))
          && (top >= best || end)) {
          best = top;
          current = link;
        }
      }

      // Within the catalog, the category is the one whose rows are
      // under the bar: the first row still showing below its edge
      // names it. A section's top crossing the line named it too late,
      // after the gap above its heading, while the rows under the bar
      // were already its own (#274).
      if (current && (current.hash === `#${catalog.id}`
        || cats.has(document.querySelector(current.hash)))) {
        const row = rows.find((el) => el.getBoundingClientRect().bottom
          > edge + 8);

        if (row && row.getBoundingClientRect().top < window.innerHeight) {
          current = cats.get(row.closest(".order-cat")) || current;
        }
      }

      if (current && current !== shown) mark(current);
      shown = current || shown;

      const name = current
        ? current.dataset.heading || current.textContent.trim()
        : heading ? heading.textContent.trim() : "";
      // A category's name in the bar carries the double chevron.
      const cat = !!current && current.hash.startsWith("#cat-");

      for (const title of titles) {
        if (title.textContent !== name) title.textContent = name;
        title.parentElement.toggleAttribute("data-cat", cat);
      }
    };
    const onScroll = () => {
      if (tick === null) tick = requestAnimationFrame(update);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    update();
  }

  changed() {
    this.refresh();
    this.draft.save(this.collect());
    // A change after a payment attempt began means the next attempt
    // must not reuse that attempt's keys (the order may differ).
    this.draft.touch();
  }

  // /order/?method=onfarm (or scheduled, delivery) chooses that way, as
  // a click on its card would: the home page's off-season band and the
  // map's pin cards. ?method=scheduled&series=<code> also chooses that
  // series' next date once the lists come, and the old
  // ?method=scituate the drop site series'. The link wins over a
  // restored draft's way. An unknown value is ignored. The query is
  // cleared, as ?add= is.
  methodFromQuery() {
    const radios = all(this.form, "[name='method']");
    const link = linkedMethod(
      location.search, radios.map((radio) => radio.value), this.dropSeries
    );

    this.clearQuery("method");
    this.clearQuery("series");
    if (!link) return;

    this.wantedSeries = link.series;
    if (link.method === this.method()) {
      this.chooseSeries();

      return;
    }

    radios.find((radio) => radio.value === link.method).checked = true;
    this.draft.save(this.collect());
  }

  // A linked series' next date, chosen on the picker once its list is
  // here. A series the list lacks (closed, or none open) leaves the
  // picker as it was.
  chooseSeries() {
    const lists = this.dates.lists;

    if (!this.wantedSeries || !lists) return;

    const first = lists.scheduled.find((c) => c.series === this.wantedSeries);

    this.wantedSeries = null;
    if (!first || this.method() !== "scheduled") return;
    this.dates.choose(first.value);
    this.draft.save(this.collect());
  }

  clearQuery(name) {
    if (!new URLSearchParams(location.search).has(name)) return;

    history.replaceState(null, "", `${location.pathname}${
      withoutParam(location.search, name)}${location.hash}`);
  }

  // /order/?add=SKU:qty,SKU:qty puts those items in the cart: the
  // "Add again" links on the account page, and anything else that
  // wants to. Unknown or sold-out SKUs are named, not added; a live
  // stock check right after brings any quantity down if it must. The
  // query is cleared so a reload does not add again.
  addFromQuery() {
    const params = new URLSearchParams(location.search);
    const raw = params.get("add");

    if (!raw) return;

    const added = [];
    const missing = [];
    let unknown = false;

    for (const part of raw.split(",")) {
      const [given, qtyText] = part.split(":");
      const sku = current(given || "", this.aliases);
      const input = qs(this.form, `[data-qty="${CSS.escape(sku || "")}"]`);
      const qty = Math.min(99, Math.max(1, parseInt(qtyText, 10) || 1));

      // A row out of stock is on the page to say when it is back, not
      // to be added (#267).
      if (!input || input.closest("[data-out]")) {
        const item = this.index.get(sku);

        // Named, never a raw SKU.
        if (item) missing.push(item.lineName);
        else unknown = true;
        continue;
      }
      this.setQty(input, Math.min(99, this.qty(input) + qty));
      added.push(`${qty} × ${this.index.get(sku).lineName}`);
    }

    const notice = document.getElementById("order-added");
    const bits = [];

    if (added.length) {
      bits.push(sentence(`Added to your cart: ${added.join(", ")}`));
    }
    if (missing.length) {
      bits.push(sentence(`Not available: ${missing.join(", ")}`));
    }
    // Draft wording.
    if (unknown) {
      bits.push("Some items from that order have changed. Please add " +
        "them again.");
    }
    notice.textContent = bits.join(" ");
    notice.hidden = !bits.length;
    notice.classList.toggle("alert-warning", !added.length);
    notice.classList.toggle("alert-success", added.length > 0);

    this.clearQuery("add");

    if (added.length) {
      this.draft.save(this.collect());
      setTimeout(() => this.cart.scrollIntoView({
        block: "end", behavior: "smooth",
      }), 300);
    }
  }

  // Stock moved under the cart: quantities were already brought into
  // line by Stock; say so, and let a submission in flight stop.
  stockMoved(notice) {
    this.moved = true;
    this.stockNotice.textContent = notice;
    this.stockNotice.hidden = false;
    this.stockNotice.scrollIntoView({ block: "nearest", behavior: "smooth" });
    this.changed();
  }

  // The shared row (#203): the way and Add discount side by side; each
  // opens over the whole row. A pick, Apply that takes, a tap or a
  // focus outside the row, or Escape folds it back. Blur alone does
  // not: a tap on Apply blurs the field on iOS before its click lands.
  wireShare() {
    const share = qs(this.cart, "[data-share]");
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

      const radio = qs(
        this.form, `[name='method'][value='${pick.dataset.way}']`
      );

      this.setShare("");
      qs(share, "[data-way-toggle]").focus();
      if (!radio || radio.checked) return;
      radio.checked = true;
      // As a click on its card would, less the scroll to its fields:
      // the customer is in the cart, not at the section.
      this.quietMethod = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
      this.quietMethod = false;
    });

    const away = (e) => {
      if (share.dataset.share && !share.contains(e.target)) {
        this.setShare("");
      }
    };

    document.addEventListener("pointerdown", away);
    document.addEventListener("focusin", away);
    share.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !share.dataset.share) return;

      const was = share.dataset.share;

      this.setShare("");
      qs(share, was === "way" ? "[data-way-toggle]" : "[data-code-toggle]")
        .focus();
    });
  }

  // The keyboard covers the foot of the layout viewport on iOS, and
  // the floating cart sits at that foot: while the code field is open
  // the cart rides up by the keyboard's height (--cart-kb), so the
  // field stays in sight. The inset is read from the share row's state,
  // not from focus: a tap on Apply blurs the field before its click.
  //
  // A browser toolbar is the same kind of gap, smaller: the layout
  // viewport reaches under it, so the cart rests --cart-gap above the
  // foot, just clear of the toolbar, and its cap is a share of the
  // visible height (--cart-vis), not of the screen's.
  watchKeyboard() {
    const visual = window.visualViewport;
    const share = qs(this.cart, "[data-share]");

    if (!visual) return;

    const sync = () => {
      const inset = share.dataset.share === "code"
        ? keyboardInset(window.innerHeight, visual) : 0;
      const area = visibleArea(window.innerHeight, visual);

      this.keyboard = inset;
      this.cart.style.setProperty("--cart-kb", `${inset}px`);
      this.cart.style.setProperty("--cart-gap", `${area.gap}px`);
      this.cart.style.setProperty("--cart-vis", `${area.height}px`);

      // Settled in the page's flow, the cart does not ride: the page
      // scrolls the field above the keyboard instead.
      const field = qs(share, "[data-field='code']");

      if (inset && this.cart.dataset.stuck !== "true"
        && document.activeElement === field) {
        const over = field.getBoundingClientRect().bottom + 12
          - (visual.offsetTop + visual.height);

        if (over > 0) window.scrollBy({ top: over, behavior: "instant" });
      }
    };

    visual.addEventListener("resize", sync);
    visual.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    this.syncKeyboard = sync;
    sync();
  }

  // The "N more" buttons: the list glides to the row that was hidden,
  // landing on it exactly. A drive of our own, not the browser's smooth
  // scroll, which overshot on iOS and snapped back.
  scrollMore(dir) {
    const list = qs(this.cart, "[data-cart-items]");
    const rows = all(list, ".order-cart-item").map((li) => ({
      top: li.offsetTop - list.offsetTop,
      bottom: li.offsetTop - list.offsetTop + li.offsetHeight,
    }));
    const to = moreStop(rows, {
      top: list.scrollTop, height: list.clientHeight,
      full: list.scrollHeight,
    }, dir);
    const from = list.scrollTop;

    cancelAnimationFrame(this.glide);
    if (to === from) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      list.scrollTop = to;

      return;
    }

    const began = performance.now();
    const span = Math.min(420, 160 + Math.abs(to - from) * 0.8);
    const stop = () => cancelAnimationFrame(this.glide);
    const step = (now) => {
      const t = Math.min(1, (now - began) / span);

      list.scrollTop = from + (to - from) * (1 - (1 - t) ** 3);
      if (t < 1) this.glide = requestAnimationFrame(step);
    };

    list.addEventListener("touchstart", stop, { once: true, passive: true });
    list.addEventListener("wheel", stop, { once: true, passive: true });
    this.glide = requestAnimationFrame(step);
  }

  // Opens one side of the shared row over the other, or neither ("").
  setShare(open) {
    const share = qs(this.cart, "[data-share]");

    share.dataset.share = open;
    if (this.syncKeyboard) this.syncKeyboard();
    qs(share, "[data-way-toggle]").setAttribute(
      "aria-expanded", String(open === "way")
    );
    qs(share, "[data-code-toggle]").setAttribute(
      "aria-expanded", String(open === "code")
    );
  }

  // Folds or opens the lines or the sums, from the total row.
  setPart(part, open) {
    this.cart.dataset[part] = open ? "open" : "closed";
    this.syncSeg();
    if (part === "items" && open) this.syncScroll();
  }

  // Dresses the total row's two controls for what they are at this
  // width: on a phone tabs (aria-selected, one tab stop, the panes
  // above as their panels), from md buttons that fold a part
  // (aria-expanded), and a fill that slides only for the tabs.
  syncSeg() {
    const narrow = matchMedia(SHEET).matches;
    const seg = qs(this.cart, "[data-cart-seg]");
    const parts = {
      items: [qs(this.cart, "[data-cart-items-toggle]"), "order-cart-list"],
      money: [qs(this.cart, "[data-cart-money-toggle]"), "order-cart-money"],
    };

    seg.toggleAttribute("data-multi", !narrow);
    if (narrow) {
      seg.setAttribute("role", "tablist");
      seg.setAttribute("aria-label", "Cart view");
    } else {
      seg.removeAttribute("role");
      seg.removeAttribute("aria-label");
    }

    // Settling opens both parts; the tabs then show the lines, where
    // the fill is. "Total" lit white beside it was white on the grey
    // track (#274).
    const on = segOn(this.cart.dataset, narrow);

    for (const [part, [button, panelId]] of Object.entries(parts)) {
      const open = on[part];
      const panel = document.getElementById(panelId);

      button.dataset.on = String(open);
      if (narrow) {
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(open));
        button.tabIndex = open ? 0 : -1;
        button.removeAttribute("aria-expanded");
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", button.id);
      } else {
        button.removeAttribute("role");
        button.removeAttribute("aria-selected");
        button.removeAttribute("tabindex");
        button.setAttribute("aria-expanded", String(open));
        panel.removeAttribute("role");
        panel.removeAttribute("aria-labelledby");
      }
    }
  }

  // The pane's height floating hidden at this width, from an unseen
  // copy: what it lifts off at on the way back up. Its folds can't be
  // summed: from md they dissolve into the pane's grid and measure 0
  // (#274, round 5). A copy put in the page has no earlier style, so
  // it starts in its end state with nothing easing.
  hiddenHeight(width) {
    const ghost = this.cart.cloneNode(true);

    ghost.removeAttribute("id");
    ghost.inert = true;
    ghost.setAttribute("aria-hidden", "true");
    Object.assign(ghost.dataset, {
      stuck: "true",
      open: String(FLOAT_AGAIN.open),
      items: FLOAT_AGAIN.items,
      money: FLOAT_AGAIN.money,
    });
    Object.assign(ghost.style, {
      position: "absolute",
      top: "0",
      bottom: "auto",
      left: "0",
      width: `${width}px`,
      visibility: "hidden",
      pointerEvents: "none",
    });
    qs(ghost, "[data-cart-word]").textContent = "Expand";
    this.cart.after(ghost);

    const height = ghost.getBoundingClientRect().height;

    ghost.remove();

    return height;
  }

  // Folds or opens the cart (below xl; the column ignores it).
  setOpen(open) {
    this.cart.dataset.open = String(open);
    qs(this.cart, "[data-cart-toggle]").setAttribute(
      "aria-expanded", String(open)
    );
    qs(this.cart, "[data-cart-word]").textContent = open ? "Hide" : "Expand";
    if (open) this.syncScroll();
    if (this.plainTotals) this.plainTotals();
  }

  // Marks the scroller's wrapper with which edges have more beyond
  // them, so the CSS can fade those edges.
  syncScroll() {
    const list = qs(this.cart, "[data-cart-items]");
    const wrap = list.parentElement;

    if (this.easing) return;

    // The floor under the lines is three rows, or the list's own
    // height when it is shorter: one item leaves no gap (#203).
    wrap.style.setProperty("--cart-list-h", `${list.scrollHeight}px`);
    this.measureFloor(list, wrap);
    // Room for the "more" pills above and below the rows, only while
    // the rows overflow: the pills never sit on a heading or a line.
    // The strip is counted back first: taken from the rows, it kept
    // them overflowing once a pane in mid-opening had let them, and
    // the first line stayed scrolled under the top fade (#278).
    const strip = wrap.hasAttribute("data-scroll")
      ? parseFloat(getComputedStyle(wrap).paddingBottom) || 0 : 0;

    wrap.toggleAttribute(
      "data-scroll", list.scrollHeight > list.clientHeight + strip + 1
    );

    const seen = list.scrollTop + list.clientHeight;
    const more = seen < list.scrollHeight - 1;
    const items = all(list, ".order-cart-item");
    const below = items.filter(
      (li) => li.offsetTop + li.offsetHeight > seen + 1
    ).length;
    const above = items.filter(
      (li) => li.offsetTop + li.offsetHeight <= list.scrollTop + 1
    ).length;
    const button = qs(wrap, "[data-cart-more]");
    const top = qs(wrap, "[data-cart-more-top]");

    wrap.toggleAttribute("data-top", list.scrollTop > 0);
    wrap.toggleAttribute("data-more", more);
    // A hidden pill keeps its last count: it never reads "0 more".
    button.hidden = !more || below === 0;
    if (!button.hidden) button.textContent = `${below} more ↓`;
    top.hidden = list.scrollTop <= 0 || above === 0;
    if (!top.hidden) top.textContent = `${above} more ↑`;
  }

  // The floor under the pane (#267): three rows of the lines, the total
  // row and Continue. The lines' wrapper keeps the rows' room
  // (--cart-scroll-min), and the pane's cap gives way to the whole
  // floor (--cart-min-h), up to the visible area. Only measured while
  // the lines show; a folded list keeps the last figure.
  measureFloor(list, wrap) {
    const fold = qs(this.cart, ".order-cart-fold");
    const after = qs(this.cart, ".order-cart-after");

    if (!list.offsetParent || this.cart.dataset.open !== "true") return;

    const rows = all(list, ".order-cart-item").map((li) => ({
      top: li.offsetTop - list.offsetTop,
      bottom: li.offsetTop - list.offsetTop + li.offsetHeight,
    }));
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const room = rowsFloor(
      rows, list.scrollHeight,
      parseFloat(getComputedStyle(list).paddingBottom) || 0, 1.75 * rem
    );
    // A fold clips what does not fit and the parts under the total row
    // give way, so the floor is summed from the parts' own heights: the
    // lines' floor, what shares their fold, the pane around the folds,
    // and what is under the total row at its natural height.
    const outer = (el) => {
      const css = getComputedStyle(el);

      return el.offsetHeight + parseFloat(css.marginTop)
        + parseFloat(css.marginBottom);
    };
    const others = (box, ...but) => Array.from(box.children)
      .filter((el) => !but.includes(el))
      .reduce((n, el) => n + outer(el), 0);
    const spacer = 0.3 * rem;
    const listBox = wrap.parentElement;
    const foldMin = room + others(wrap.parentElement, wrap)
      + others(listBox.parentElement, listBox) + spacer;
    // What is under the total row: the badges, the way and the code.
    // The badges once gave way first; they are where a discount's
    // chicks come from, so they stay and the cap gives way (#274).
    const below = others(after.firstElementChild) + spacer;
    const css = getComputedStyle(this.cart);
    const pane = others(this.cart, fold, after)
      + ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"]
        .reduce((n, key) => n + parseFloat(css[key]), 0);
    const set = (el, name, px) => {
      const now = parseFloat(el.style.getPropertyValue(name));

      if (!(Math.abs(now - px) < 1)) el.style.setProperty(name, `${px}px`);
    };
    const floor = pane + foldMin + below;
    const visible = parseFloat(this.cart.style.getPropertyValue("--cart-vis"))
      || window.innerHeight;
    // The room ends at the top bar's foot: the bar stays over the pane
    // (#278).
    const bar = parseFloat(this.cart.style.getPropertyValue("--cart-bar")) || 0;
    const roomPx = visible - rem - bar;

    set(wrap, "--cart-scroll-min", room);
    set(this.cart, "--cart-fold-min", Math.ceil(foldMin));
    set(this.cart, "--cart-min-h", Math.ceil(floor));

    // Too short for the floor itself, what is under the total row
    // scrolls, so the rows, the total and Continue keep their room.
    this.cart.toggleAttribute("data-tight", floor > roomPx);
  }

  // Quantity controls.

  qty(input) {
    const n = parseInt(String(input.value).replace(/\D/g, ""), 10);

    return Number.isFinite(n) ? Math.min(99, Math.max(0, n)) : 0;
  }

  // Both the property and the attribute, so CSS can see the state.
  setQty(input, n) {
    const value = String(n);

    input.value = value;
    input.setAttribute("value", value);
  }

  step(e) {
    const button = e.target.closest("[data-step]");

    if (!button) return;

    const box = button.closest(".order-qty");
    const input = qs(box, "[data-qty]");
    const was = this.qty(input);
    const max = Number(input.dataset.max) || 99;
    const next = Math.min(max, Math.max(0, was + Number(button.dataset.step)));

    this.setQty(input, next);
    pulse(input, "order-qty-tick");

    if (was === 0 && next > 0) {
      qs(box, ".order-qty-step [data-step='1']").focus();
    } else if (next === 0) {
      button.closest(".order-item").focus();
    }

    // The first item into an empty cart opens the pane on its own for
    // a restored draft; an Add has its own say (added() below).
    this.adding = next > was;
    this.changed();
    if (this.adding) this.added(input.dataset.qty);
    this.adding = false;
  }

  // The feedback for an Add (#267). The first of a browser session
  // opens the pane on the lines, scrolled to the new line, shuts the
  // pane after TEACH_DWELL and pulses the Hide/Show pill in three
  // pairs (#278). Every
  // later Add leaves the pane shut: the bar says what was added, the
  // count ticks, the pill pulses once. Whatever the pane is doing,
  // a screen reader hears it, and the focus stays where it is.
  added(sku) {
    const item = this.index.get(sku);

    if (!item) return;

    const name = item.lineName;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const floating = this.cart.dataset.stuck === "true";
    const first = this.firstAdd();
    const pill = qs(this.cart, "[data-cart-toggle]");
    const live = qs(this.cart, "[data-cart-live]");

    // A repeated name must be heard again: clear, then set.
    live.textContent = "";
    setTimeout(() => { live.textContent = `Added ${name} to cart`; }, 60);
    pulse(qs(this.cart, "[data-cart-count]"), "is-ticked");

    clearTimeout(this.addedTimer);
    clearTimeout(this.closeTimer);

    if (first && floating) {
      this.setOpen(true);
      this.setPart("items", true);
      this.setPart("money", false);
      // Once the pane has opened, the line is in reach: bring it into
      // view inside the list.
      setTimeout(() => this.reveal(sku), reduced ? 0 : 260);
      this.closeTimer = setTimeout(() => {
        this.setOpen(false);
        this.pulsePill(pill, "teach");
      }, TEACH_DWELL);

      return;
    }

    this.pulsePill(pill, "once");
    if (!floating || this.cart.dataset.open === "true") return;

    const box = qs(this.cart, "[data-cart-added-box]");

    qs(box, "[data-cart-added]").textContent = `Added: ${name}`;
    box.setAttribute("data-show", "");
    this.addedTimer = setTimeout(() => box.removeAttribute("data-show"), 2600);
  }

  // True once per browser session; the session's own storage, so a new
  // page keeps the count and a new visit starts it over.
  firstAdd() {
    const key = "nff-cart-first-add";

    try {
      if (sessionStorage.getItem(key)) return false;
      sessionStorage.setItem(key, "1");

      return true;
    } catch {
      const first = !this.addedBefore;

      this.addedBefore = true;

      return first;
    }
  }

  // Scrolls the list, and only the list, to a line. The line itself is
  // not marked: the open pane and the pill's pulses say enough (#274).
  reveal(sku) {
    const button = qs(this.cart, `[data-remove="${CSS.escape(sku)}"]`);
    const row = button ? button.closest(".order-cart-item") : null;

    if (!row) return;

    const list = qs(this.cart, "[data-cart-items]");
    const top = row.offsetTop - list.offsetTop;

    if (top < list.scrollTop
      || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - 8);
    }
  }

  // The Hide/Show pill pulses: "teach" the first time, three pairs
  // (#278), "once" on a later Add. With reduced motion it holds a still
  // emphasis for a moment instead. A timer, not animationend, ends it:
  // the still one has no animation to end.
  pulsePill(pill, kind) {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

    clearTimeout(this.pulseTimer);
    pill.removeAttribute("data-pulse");
    void pill.offsetWidth;
    pill.setAttribute("data-pulse", kind);
    this.pulseTimer = setTimeout(() => {
      pill.removeAttribute("data-pulse");
    }, PULSE_MS[still ? "still" : kind]);
  }

  // The pane is the customer's once they touch it or focus in it: the
  // timer that was to shut it lapses.
  keepOpen() {
    clearTimeout(this.closeTimer);
  }

  method() {
    const checked = qs(this.form, "[name='method']:checked");

    return checked ? checked.value : "";
  }

  lines() {
    return all(this.form, "[data-qty]")
      .map((input) => ({ sku: input.dataset.qty, qty: this.qty(input) }))
      .filter((line) => line.qty > 0);
  }

  // Lines with their catalog entries, for rules that need the group.
  lineDetails() {
    return this.lines().map((line) => ({
      ...line, groupKey: this.index.get(line.sku).groupKey,
    }));
  }

  totals() {
    return computeTotals({
      lines: this.lines(),
      method: this.method(),
      index: this.index,
      money: this.money,
      group: this.group,
      code: this.code,
      zipStatus: this.zipStatus(),
      waiveFee: !!this.pass && this.passFee,
    });
  }

  // Looks the typed code up by its hash. A known one becomes
  // `this.code` and shows in the totals; the joke starts its clock;
  // anything else is ignored by the server, and the note says so.
  async applyCode({ quiet = false } = {}) {
    const input = qs(this.cart, "[data-field='code']");
    const note = qs(this.cart, "[data-code-note]");
    const typed = normalizeCode(input.value);
    const say = (text, tone) => {
      note.textContent = text;
      note.hidden = !text;
      if (tone) {
        note.dataset.tone = tone;
      } else {
        delete note.dataset.tone;
      }
    };

    input.value = typed;
    clearTimeout(this.noteTimer);
    note.classList.remove("is-fading");

    // Apply with the field empty takes the code off again, and a pass
    // with it; a change keeps the pass its order was placed with.
    if (!typed) {
      this.stopJoke();
      this.code = null;
      if (!this.editing) {
        this.pass = null;
        this.passFee = false;
      }
      say("");
      this.refresh();

      return;
    }
    // An accepted code leaves the field empty for the next one; the
    // discount line says it is on, and the note says so for a while.
    const accepted = (text) => {
      const open = qs(this.cart, "[data-share]").dataset.share === "code";

      input.value = "";
      say(text, "good");
      // Done with the field: the row folds back, and focus goes to
      // the button that opens it.
      if (open) {
        this.setShare("");
        qs(this.cart, "[data-code-toggle]").focus();
      }
      this.noteTimer = setTimeout(() => {
        note.classList.add("is-fading");
        this.noteTimer = setTimeout(() => {
          say("");
          note.classList.remove("is-fading");
        }, 700);
      }, 15_000);
    };

    if (typed === JOKE_CODE) {
      this.code = null;
      this.startJoke();
      accepted("Code applied.");
      this.refresh();

      return;
    }

    const hash = await sha256(typed);
    const found = this.codes.find((c) => c.hash === hash);

    if (found) {
      this.stopJoke();
      this.code = { code: typed, label: found.label, off: found.off };
      accepted(`Code applied: $${found.off} off.`);
      this.refresh();

      return;
    }

    const pass = this.editing ? { ok: false } : await this.applyPass(typed);

    // James's wording (6333286808, and on #182 since): the minimum is
    // the live one from data/delivery.json; a code that waives the fee
    // says only "Applied.", as the fee cell already shows $0.
    if (pass.ok) {
      accepted(this.passFee ? "Applied."
        : "Applied: this order can be delivered under the " +
          `$${this.money.deliveryMinimum} minimum.`);
    } else if (!quiet) {
      // The code that was on stays on. Every code refused says only
      // this (James, on #182).
      say(pass.message || "That code isn't valid.");
    }
    this.refresh();
  }

  // Asks the server whether a typed code is a pass (#182). Only the
  // pass shape, eight letters and digits, is worth a request.
  // -> { ok, message? }; an accepted one becomes `this.pass`.
  async applyPass(value) {
    const raw = String(value || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();

    if (raw.length !== 8) return { ok: false };

    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    // The submission's key: a pass it holds, after a declined card and
    // a reload, is still its own.
    const holder = encodeURIComponent(this.draft.key());
    const { ok, data } = await api(
      `/api/pass?code=${encodeURIComponent(code)}&holder=${holder}`
    ).catch(() => ({ ok: false, data: null }));

    if (ok) {
      this.pass = code;
      this.passFee = !!(data && data.waivesFee);
    }

    return { ok, message: data && data.message };
  }

  // Takes a pass the server refused off the order and says why by the
  // code box, as a code refused on Apply would.
  dropPass(message) {
    const note = qs(this.cart, "[data-code-note]");

    this.pass = null;
    this.passFee = false;
    note.textContent = message;
    note.hidden = false;
    delete note.dataset.tone;
    this.refresh();
  }

  // The money rules the page holds the order to: a pass lifts the
  // delivery minimum, and nothing else.
  rules() {
    return this.pass ? { ...this.money, deliveryMinimum: 0 } : this.money;
  }

  startJoke() {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    const since = Date.now();

    row.className = "order-cart-row order-cart-credit order-cart-joke";
    dt.textContent = `Discount (${JOKE_CODE}, ${
      dollars(JOKE_PER_MINUTE)}/min)`;
    row.appendChild(dt);
    row.appendChild(dd);
    qs(this.cart, "[data-total-row='fee']").before(row);

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

  // The delivery ZIP's status, for the outside-area fee. Null unless
  // delivery is chosen, so the fee shows the moment it applies.
  zipStatus() {
    if (this.method() !== "delivery") return null;

    return zipInfo(
      qs(this.form, "[data-field='delivery.zip']").value, this.terms.area
    ).status;
  }

  eligible(totals) {
    return meetsMinimum(totals, this.rules());
  }

  // Everything derived from the current field values.

  refresh() {
    // First: an empty list unchooses scheduled pickup, and the rest
    // reads the way that leaves.
    this.renderScheduledCard();

    const method = this.method();
    const totals = this.totals();

    this.renderWindows();

    for (const input of all(this.form, "[data-qty]")) {
      const qty = this.qty(input);
      const box = input.closest(".order-qty");
      // A box being typed in stays open at 0 or blank: an empty box
      // hides its stepper, which would blur the box and lose what the
      // customer types after clearing it. Leaving it settles the state.
      const state = qty > 0 || input === this.typing ? "active" : "empty";

      if (box.dataset.qtyState !== state) box.dataset.qtyState = state;
      qs(box, "[data-step='-1']").setAttribute(
        "aria-label", qty === 1 ? "Remove" : "One fewer"
      );
    }

    for (const body of all(this.form, "[data-method-body]")) {
      body.toggleAttribute("inert", body.dataset.methodBody !== method);
    }

    // Delivery needs a phone for the driver; the rest can do without.
    const phone = qs(this.form, "[data-field='customer.phone']");

    phone.required = method === "delivery";
    qs(this.form, "[data-phone-optional]").hidden = method === "delivery";

    this.renderCart(totals, method);
    this.renderZipNote();
  }

  // The scheduled pickup card from the list: its Where summarizes
  // every place once the list reaches more than the drop site (as
  // built, it reads as the drop site does; When is always "During
  // markets, pop-ups, and drops"); an empty list says so
  // and the card cannot be chosen; the lists not yet here leave it as
  // built.
  renderScheduledCard() {
    const lists = this.dates.lists;
    const radio = qs(this.form, "#method-scheduled");
    const facts = qs(this.form, "[data-scheduled-facts]");

    if (!lists || !radio || !facts) return;

    const choices = lists.scheduled;
    const none = !choices.length;
    const where = qs(facts, "[data-scheduled-where]");

    if (where.dataset.built === undefined) {
      where.dataset.built = where.textContent;
    }
    // Beyond one place, Where counts the locations and links to the
    // map in a new tab, so the order stays as it is (#places-scheduled
    // opens the Places layer on scheduled pickups, #314). The link is
    // kept while its text and href hold, so a focused one stays focused.
    const places = locationCount(choices);

    if (!none && places > 1) {
      const text = `${places} locations`;
      const href = facts.dataset.placesHref;
      const kept = where.firstElementChild;

      if (!kept || where.children.length !== 1 || kept.textContent !== text
        || kept.getAttribute("href") !== href) {
        const link = document.createElement("a");

        link.href = href;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = text;
        where.textContent = "";
        where.appendChild(link);
      }
    } else {
      where.textContent = none || dropOnly(choices, this.dropSeries)
        ? where.dataset.built : placesFact(choices);
    }
    facts.hidden = none;
    qs(this.form, "[data-scheduled-none]").hidden = !none;
    radio.disabled = none;
    if (none && radio.checked) qs(this.form, "#method-onfarm").checked = true;
    this.chooseSeries();
  }

  // The chosen pickup day's windows, one radio each, from the farm's
  // schedule (W11d). The time chosen carries over to a new day that
  // has it; otherwise the day's first is chosen.
  renderWindows() {
    const box = qs(this.form, "[data-windows]");
    const select = qs(this.form, "[data-dates='onfarm']");

    if (!box || !select) return;

    const lists = this.dates.lists;
    const day = lists && (lists.onfarm || [])
      .find((d) => d.date === select.value);
    const windows = day ? day.windows : [];
    const key = `${select.value} ${windows.map((w) => w.id).join(" ")}`;

    if (box.dataset.key === key && !this.wantedWindow) return;

    const checked = qs(box, "input:checked");
    const current = this.wantedWindow || (checked && checked.value);
    const pick = windows.some((w) => w.id === current) ? current
      : windows[0] && windows[0].id;

    box.dataset.key = key;
    box.textContent = "";
    if (!windows.length) {
      const none = document.createElement("p");

      none.className = "order-windows-none";
      none.textContent = lists ? "No pickup times on this day."
        : "Loading times…";
      box.appendChild(none);
    }
    for (const w of windows) {
      const node = document.getElementById("tpl-window").content
        .cloneNode(true);
      const input = qs(node, "input");
      const text = qs(node, "label");

      input.id = `onfarm-window-${w.id.replace(/\D/g, "")}`;
      input.value = w.id;
      input.checked = w.id === pick;
      text.htmlFor = input.id;
      text.textContent = w.label;
      box.appendChild(node);
    }
    if (lists) this.wantedWindow = null;
  }

  // The dialog's choice, put on the form; the customer pays again with
  // the same button (U1).
  useLapsed({ method, date, window }) {
    const select = qs(this.form, `[data-dates="${method}"]`);
    const status = document.querySelector("[data-lapsed-status]");
    const place = method === "scheduled" && this.pickupAt({ occurrence: date });

    if (method === "scheduled") this.dates.choose(date);
    else if (select) select.value = date;
    if (window) this.wantedWindow = window;
    this.refresh();
    this.errors.clear();
    this.draft.save(this.collect());

    const chosen = method === "scheduled" && this.dates.occurrence(date);
    const day = label(chosen ? chosen.date : date);
    const times = window && windowLabel(pickupTimes({ window }));

    if (status) {
      status.textContent = `${method === "onfarm"
        ? `Pickup is now ${day}, ${times}`
        : method === "scheduled" ? `Pickup is now ${day}, ${place}`
          : `Delivery is now ${day}`}. Pay to place your order.`;
      status.hidden = false;
    }

    const pay = [this.submitButton, this.saveButton]
      .find((button) => !button.hidden)
      || qs(document.getElementById("payment"), "legend");

    pay.focus();
  }

  // The dialog's other way: to the choice of ways, which the customer
  // makes themselves.
  otherWay(method) {
    const other = qs(this.form, `[name="method"]:not([value="${method}"])`);

    document.getElementById("pickup").scrollIntoView({ block: "start" });
    if (other) other.focus({ preventScroll: true });
  }

  // A 409: what was chosen lapsed. The fresh list goes on the form and
  // the dialog offers it (U1, U3).
  lapse(stored, dates) {
    const method = stored;
    const list = method === "scheduled" ? this.dates.scheduled(dates) : dates;

    this.dates.replace(method, dates);
    this.lapsed.open(method, list, this.submitButton.hidden ? null
      : this.submitButton);
  }

  revealMethod() {
    const body = qs(this.form, `[data-method-body="${this.method()}"]`);

    if (!body) return;

    setTimeout(() => {
      const field = qs(body, "select, input");

      if (field) {
        field.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }, 240);
  }

  // Every string in the panel comes from summarize(), which the tests
  // pin; this only puts them in the DOM.
  renderCart(totals, method) {
    const c = this.cart;
    const lines = this.lines();
    const count = lines.reduce((n, line) => n + line.qty, 0);
    const s = summarize({
      totals, method, money: this.rules(), count, lines, index: this.index,
    });
    const from = c.offsetHeight;

    this.renderItems(s);

    qs(c, "[data-total='subtotal']").textContent = s.subtotal;

    qs(c, "[data-total-row='discount']").hidden = !s.discount;
    qs(c, "[data-total='discount-label']").textContent =
      s.discount ? s.discount.label : "";
    qs(c, "[data-total='discount']").textContent =
      s.discount ? s.discount.text : "";

    const fee = qs(c, "[data-total='fee']");

    qs(c, "[data-total-row='fee']").hidden = !s.fee.show;
    fee.textContent = s.fee.show ? s.fee.text : "";
    fee.classList.toggle("order-cart-free", !!s.fee.waived);

    const total = qs(c, "[data-total='total']");

    if (this.lastTotal !== null && this.lastTotal !== s.total) {
      pulse(total, "is-bumped");
    }
    total.textContent = s.total;
    this.lastTotal = s.total;
    this.total = totals.total;
    this.payment.setAmount(this.amount());
    this.submitLabel();
    this.renderEdit(totals.total);

    qs(c, "[data-cart-toggle]").setAttribute(
      "aria-label", `${s.countText}, total ${s.total}. Show or hide the cart.`
    );
    qs(c, "[data-cart-count]").textContent = s.countText;
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

    // The shared row's button names the way the page holds; the cart
    // never picks one of its own (#203).
    let wayName = "";

    for (const way of all(c, "[data-way]")) {
      const on = way.dataset.way === method;

      way.setAttribute("aria-pressed", String(on));
      way.classList.toggle("btn-primary", on);
      way.classList.toggle("btn-outline-primary", !on);
      if (on) wayName = way.textContent.trim();
      if (way.dataset.way === "scheduled") {
        way.disabled = !this.dates.lists
          || !this.dates.lists.scheduled.length;
      }
    }

    // A scheduled pickup names its day, window and place, from the
    // picker, as the summary line does.
    const picked = method === "scheduled"
      && this.dates.occurrence(this.dates.scheduledValue());

    if (picked) {
      wayName += `: ${picked.label}, ${
        this.pickupAt({ occurrence: picked.occurrence })}`;
    }
    qs(c, "[data-way-name]").textContent = wayName || "Pickup or delivery";
    c.toggleAttribute("data-empty", count === 0);
    this.syncScroll();
    // The header's Order link shows the same count; a change to a paid
    // order is not the cart.
    if (!this.editing) announceCart(count);

    const short = qs(this.form, "[data-delivery-short]");

    if (short.textContent !== s.deliveryShort) {
      short.textContent = s.deliveryShort;
    }
    short.hidden = !s.deliveryShort;
    qs(c, "[data-checkout]").disabled = count === 0
      || (method === "delivery" && !s.eligible);

    // Empty, the cart folds away; the first item opens it. A fold the
    // customer chose stays until the cart empties again.
    if (count === 0 && this.lastCount !== 0) {
      this.setOpen(false);
    } else if (count > 0 && !this.lastCount && !this.adding) {
      this.setOpen(true);
    }
    this.lastCount = count;

    // A badge that just turned on sends its chicks; the first render
    // (a restored draft) only sets the baseline. They leave the badge
    // itself; with the pane folded or the badge out of sight, the total.
    const lit = {};
    const seen = (el) => {
      const r = el.getBoundingClientRect();
      const box = c.getBoundingClientRect();

      return c.dataset.open !== "false" && r.height > 0
        && r.top >= Math.max(0, box.top) - 1
        && r.bottom <= Math.min(window.innerHeight, box.bottom) + 1;
    };

    for (const badge of s.badges) {
      const el = qs(c, `[data-badge="${badge.key}"]`);

      lit[badge.key] = badge.on;
      if (!el) continue;
      el.dataset.on = String(badge.on);
      if (badge.on && this.lit && !this.lit[badge.key]) {
        celebrate(seen(el) ? el : qs(c, "[data-total='total']"));
      }
    }
    this.lit = lit;

    const nudge = qs(c, "[data-nudge]");

    if (nudge.textContent !== s.nudge) nudge.textContent = s.nudge;
    nudge.hidden = !s.nudge;
    nudge.dataset.tone = s.nudgeTone || "";
    this.ease(from);
  }

  // In the column (xl), the pane eases to its new height as lines come
  // and go, rather than jumping (#278). Its content is laid out at the
  // new height at once; the pane's own edge follows.
  ease(from) {
    const c = this.cart;
    const to = c.offsetHeight;

    if (!matchMedia("(min-width: 1200px)").matches || !from
      || Math.abs(to - from) < 1 || typeof c.animate !== "function"
      || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    if (this.easing) this.easing.cancel();
    this.easing = c.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { duration: 420, easing: "cubic-bezier(0.2, 0.8, 0.25, 1)" }
    );
    // The lines give way while it eases, as they do to the cap: the
    // fades and the "more" pills wait for the end, or they would flash.
    this.easing.onfinish = () => {
      this.easing = null;
      this.syncScroll();
    };
  }

  // The cart's lines: each category, with its tiers indented beneath,
  // or "0 items". The list is small, so it is rebuilt on each render.
  renderItems(s) {
    const list = qs(this.cart, "[data-cart-items]");
    const make = (tag, className, text) => {
      const el = document.createElement(tag);

      el.className = className;
      if (text !== undefined) el.textContent = text;

      return el;
    };

    // Rebuilt only when the lines change: a render that follows a
    // field's change event would otherwise replace the × under the
    // pointer between press and release, and the click would be lost.
    const key = JSON.stringify(s.groups);

    if (key === this.itemsKey) {
      this.syncScroll();

      return;
    }
    this.itemsKey = key;

    for (const row of all(list, ".order-cart-group")) row.remove();

    for (const group of s.groups) {
      const li = make("li", "order-cart-group");
      const items = make("ul", "order-cart-group-items list-unstyled");

      li.appendChild(make("span", "order-cart-group-name", group.label));
      for (const item of group.items) {
        const row = make("li", "order-cart-item");

        const remove = make("button", "order-cart-remove", "×");

        remove.type = "button";
        remove.dataset.remove = item.sku;
        remove.setAttribute(
          "aria-label", `Remove ${item.lineName} from the cart`
        );
        row.appendChild(remove);
        row.appendChild(
          make("span", "order-cart-item-name", packLabel(item.row))
        );
        row.appendChild(make("span", "order-cart-item-qty", item.qtyText));
        row.appendChild(make("span", "order-cart-item-sub", item.subtotal));
        items.appendChild(row);
      }
      li.appendChild(items);
      list.appendChild(li);
    }

    this.syncScroll();
  }

  renderZipNote() {
    const zip = qs(this.form, "[data-field='delivery.zip']");
    const note = qs(this.form, "[data-zip-note]");
    const info = zipInfo(zip.value, this.terms.area);
    const bad = disallowedFor(this.lineDetails(), info.state);

    note.classList.remove("text-danger-emphasis");

    if (info.status === "outside") {
      note.textContent = "That's outside our delivery area. On-farm pickup " +
        "and scheduled pickup are open to everyone.";
      note.classList.add("text-danger-emphasis");
    } else if (info.status === "unlisted") {
      note.textContent = "A little outside our usual area: delivery is " +
        `$${this.money.outsideAreaFee} more. If we can't get to your ` +
        "address, we'll call, text, or email you.";
    } else if (bad.length) {
      note.textContent = "We can only deliver " +
        `${info.state.onlyGroups.join(" and ")} to ${info.state.name} ` +
        "for now. Remove the chicken, or choose pickup.";
      note.classList.add("text-danger-emphasis");
    } else if (info.state && info.state.note) {
      note.textContent = info.state.note;
    } else {
      note.textContent = "";
    }
  }

  // The payload as the server expects it.

  collect() {
    const value = (key) => {
      const el = qs(this.form, `[data-field="${key}"]`);

      if (!el) return "";
      if (el.type === "checkbox") return el.checked;
      if (el.type === "radio" || el.getAttribute("role") === "radiogroup") {
        // A group drawn from the lists (the pickup times) may have no
        // radios yet.
        const first = el.getAttribute("name") ? el : qs(el, "input");
        const checked = first
          && qs(this.form, `[name="${first.name}"]:checked`);

        return checked ? checked.value : "";
      }

      return el.value;
    };
    const way = this.method();
    const dateSelect = qs(this.form, `[data-dates="${way}"]`);
    // Scheduled pickup stores its occurrence, which holds the date; the
    // picker's value is the occurrence id.
    const picked = way === "scheduled" ? this.dates.scheduledValue()
      : dateSelect ? dateSelect.value : "";

    return {
      formVersion: this.form.dataset.version,
      customer: {
        firstName: value("customer.firstName"),
        lastName: value("customer.lastName"),
        email: value("customer.email"),
        phone: value("customer.phone"),
        contact: value("customer.contact"),
        marketing: value("customer.marketing") === true,
      },
      lines: this.lines(),
      fulfilment: {
        method: way,
        ...(way === "scheduled" ? { occurrence: picked } : { date: picked }),
        onfarm: {
          window: value("onfarm.window"),
        },
        delivery: {
          address1: value("delivery.address1"),
          address2: value("delivery.address2"),
          town: value("delivery.town"),
          zip: value("delivery.zip"),
          cooler: value("delivery.cooler"),
          notes: value("delivery.notes"),
        },
      },
      code: this.code
        ? this.code.code
        : normalizeCode(qs(this.form, "[data-field='code']").value),
      pass: this.pass,
      claimedTotal: this.totals().total,
      website: qs(this.form, "[name='website']").value,
    };
  }

  restore(payload) {
    if (!payload) return;

    const set = (key, v) => {
      const el = qs(this.form, `[data-field="${key}"]`);

      if (!el || v === undefined || v === null) return;
      if (el.type === "checkbox") {
        el.checked = !!v;
      } else if (el.type === "radio" || el.getAttribute("role")) {
        const name = el.getAttribute("name") || qs(el, "input").name;
        const radio = qs(this.form, `[name="${name}"][value="${v}"]`);

        if (radio) radio.checked = true;
      } else {
        el.value = v;
      }
    };
    const c = payload.customer || {};
    const f = payload.fulfilment || {};
    const o = f.onfarm || {};
    const d = f.delivery || {};

    set("customer.firstName", c.firstName);
    set("customer.lastName", c.lastName);
    set("customer.email", c.email);
    set("customer.phone", c.phone);
    this.formatPhone();
    set("customer.contact", c.contact);
    set("code", payload.code);
    // A saved draft's pass is asked about again: it may be gone.
    if (payload.pass && !this.editing) {
      this.applyPass(payload.pass).then(() => this.refresh());
    }

    for (const line of payload.lines || []) {
      // A saved cart may predate a rename; a paid order being changed
      // never does (its SKUs are all known, or it can't be changed).
      const sku = this.editing ? line.sku : current(line.sku, this.aliases);
      const input = qs(this.form, `[data-qty="${CSS.escape(sku)}"]`);

      if (input) this.setQty(input, line.qty);
    }

    // A draft saved before scheduled pickup holds `scituate`, which is
    // scheduled pickup at the drop site.
    const way = f.method === "scituate" ? "scheduled" : f.method;

    if (way) set("fulfilment.method", way);
    // The radios are drawn from the lists when they come.
    this.wantedWindow = o.window || null;

    for (const key of [
      "address1", "address2", "town", "zip", "cooler", "notes",
    ]) {
      set(`delivery.${key}`, d[key]);
    }

    // Kept until the real list arrives; fill() honours it if the date
    // is still valid (#284).
    if (way === "scheduled") {
      this.dates.want(way, draftOccurrence(f, this.dropSeries),
        f.method === "scituate" ? this.dropSeries : "");
    } else if (way && f.date) {
      this.dates.want(way, f.date);
    }
    this.showContact();
  }

  // What the payment section asks of the form (pay.js).

  amount() {
    return this.editing
      ? Math.max(0, (this.total || 0) - this.editing.held + this.editing.kept)
      : this.total || 0;
  }

  referenceId() {
    return this.draft.key();
  }

  paymentReady() {
    this.submitButton.disabled = false;
    this.submitLabel();
  }

  // The customer's details for the card's verification, and the
  // delivery address when there is one.
  billing(payload) {
    const c = payload.customer;
    const d = payload.fulfilment.method === "delivery"
      ? payload.fulfilment.delivery
      : {};

    return {
      firstName: c.firstName, lastName: c.lastName, email: c.email,
      phone: c.phone,
      address1: d.address1 || "", address2: d.address2 || "",
      town: d.town || "", zip: d.zip || "",
      state: d.zip ? (zipInfo(d.zip, this.terms.area).state || {}).code : "",
    };
  }

  // Validates now and returns the payload the server expects, with
  // its key and attempt, or null after showing the errors. Nothing
  // asynchronous: a wallet must tokenise inside its click.
  check(payload) {
    return validateOrder(payload, {
      index: this.index, terms: this.terms, now: this.dates.now(),
      placed: this.editing && this.editing.placed,
      group: this.group, code: this.code, schedule: this.dates.schedule(),
      waive: { minimum: !!this.pass, fee: !!this.pass && this.passFee },
    });
  }

  // Once errors are showing, each change clears the ones it fixes and
  // rewords the ones it changes; leaving a field shows its own. Before
  // the first attempt nothing is said while the customer fills in.
  revalidate(left = null) {
    if (this.busy || !this.errors.showing()) return;

    const check = this.check(this.collect());

    this.errors.update(check.ok ? {} : check.errors, left);
    this.refresh();
  }

  prepare() {
    if (this.busy) return null;

    const payload = this.collect();
    const check = this.check(payload);
    const status = document.querySelector("[data-lapsed-status]");

    if (status) status.hidden = true;
    if (!check.ok) {
      // Only the day or time lapsed: the dialog. Before the lists have
      // come there is nothing to offer, so the errors say it.
      if (check.status === 409 && this.dates.lists) {
        this.lapse(payload.fulfilment.method, check.dates);

        return null;
      }
      if (check.dates && this.dates.lists) {
        this.dates.replace(payload.fulfilment.method, check.dates);
      }
      this.errors.show(check.errors);
      this.refresh();

      return null;
    }

    this.errors.clear();
    this.payment.clearError();
    payload.idempotencyKey = this.draft.key();
    payload.attempt = this.draft.attempt();
    this.draft.save(payload);

    return payload;
  }

  // The same with one last look at stock. If the cart had to change,
  // the customer sees why and decides again; nothing is sent.
  async prepareAsync() {
    // Pressed before the dates came: wait for them, rather than check
    // the order against no dates at all and send nothing (#284).
    if (!this.dates.lists) await this.dates.refresh();

    const payload = this.prepare();

    if (!payload) return null;

    // The farm may have dropped the time since the page loaded: ask
    // now, before a wallet or Venmo opens (UX's point 2). The server
    // checks again whatever happens here.
    if (await this.dates.refresh()) {
      const again = this.check(payload);

      if (!again.ok && again.status === 409) {
        this.lapse(payload.fulfilment.method, again.dates);

        return null;
      }
    }

    this.moved = false;
    await this.stock.refresh();
    if (this.moved) return null;

    return payload;
  }

  // A wallet's token, or the card's: send it.
  pay(payload, source) {
    return this.deliver({ ...payload, payment: source });
  }

  // Venmo's two steps. The first answers with the PayPal order the
  // button pays; the second captures it and records the order. A draft
  // whose payment already went through (its answer was lost) gets the
  // paid order instead and no PayPal order: it is done, and the button
  // is told so with null, to stop without a word (#253).
  async venmoCreate(payload) {
    this.setBusy(true);

    const outcome = await this.submitter.send({
      ...payload, payment: { method: "venmo", stage: "create" },
    });

    this.setBusy(false);
    if (outcome.kind === "ok" && outcome.data && outcome.data.paypalOrderId) {
      this.draft.markAttempted();

      return outcome.data.paypalOrderId;
    }
    if (outcome.kind === "ok" && outcome.data && outcome.data.orderId) {
      this.paid(outcome.data, payload);

      return null;
    }

    this.settle(outcome, payload);
    throw new Error(outcome.message || "Couldn't start the Venmo payment.");
  }

  venmoCapture(payload, paypalOrderId) {
    return this.deliver({
      ...payload, payment: { method: "venmo", stage: "capture", paypalOrderId },
    });
  }

  // Submission and recovery.

  // The main button: the card form.
  // A second press while the first is still checking the dates and the
  // stock (before the button goes busy) is ignored: it would tokenize
  // and send again (#268, rec 7). The server would only dedupe it.
  async submit(e) {
    e.preventDefault();
    if (this.preparing) return;

    crumb("pay.press");

    this.preparing = true;

    let payload;

    try {
      payload = await this.prepareAsync();
    } finally {
      this.preparing = false;
    }

    if (!payload) return;
    // A change with nothing more to pay: no payment at all.
    if (this.editing && this.amount() <= 0) {
      await this.deliver(payload);

      return;
    }

    let source;

    // Busy from here to the answer, so the spinner runs unbroken.
    this.setBusy(true);
    try {
      source = await this.payment.tokenizeCard(payload);
    } catch (error) {
      this.setBusy(false);
      this.payment.fail(error.message);

      return;
    }
    await this.pay(payload, source);
  }

  // A send that can't get through goes once more, under the same keys,
  // so it can't pay twice. If that one can't either, it stops.
  async deliver(payload) {
    this.setBusy(true);
    this.draft.markAttempted();

    let outcome = await this.submitter.send(payload);

    if (outcome.kind === "retry") {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      outcome = await this.submitter.send(payload);
    }

    this.setBusy(false);
    crumb(outcome.kind === "ok" ? "pay.ok" : "pay.failed");

    switch (outcome.kind) {
    case "ok":
      this.paid(outcome.data, payload);
      break;
    case "retry":
      // Draft wording.
      this.fail(payload, "We couldn't reach our payment system.");
      break;
    default:
      this.settle(outcome, payload);
    }
  }

  // The order is paid: the draft goes, and the page says so.
  paid(data, payload) {
    this.draft.clearPending();
    this.draft.clear();
    if (this.editing) {
      location.assign("/account/#orders");

      return;
    }
    announceCart(0);
    this.succeed(data, payload);
  }

  // Every answer but success and retry: the customer decides again.
  settle(outcome, payload) {
    switch (outcome.kind) {
    case "invalid":
      if (outcome.stock) {
        this.stock.items = outcome.stock;
        this.stock.apply();
      }
      // A code the server refused (#182): it comes off, the totals
      // follow, and the words go by the code box, not under a field.
      if (outcome.errors.pass) {
        this.dropPass(outcome.errors.pass);

        return;
      }
      // The fields first: showing them clears every slot, the
      // payment's too, so the changed total is said after (#302).
      this.errors.show(outcome.errors);
      if (outcome.errors.total) {
        this.refresh();
        this.payment.fail(outcome.errors.total);
      }
      break;
    case "stale":
      this.lapse(payload.fulfilment.method, outcome.dates);
      break;
    case "declined":
      // The next try is a new attempt: fresh keys for the processor.
      this.draft.nextAttempt();
      this.payment.fail(outcome.message);
      break;
    case "checkout":
      this.draft.nextAttempt();
      this.payment.fail(outcome.message);
      break;
    case "busy":
      this.payment.fail(outcome.message);
      break;
    default:
      this.fail(payload, outcome.message);
    }
  }

  // While an order is sent, the button that sent it spins its egg. A
  // wallet or Venmo has no button of ours on show, so the notice says
  // it instead. The busy flag and the form's pointer-events stop a
  // second press; the button is not disabled, which would dim it.
  setBusy(busy) {
    const shown = [this.submitButton, this.saveButton]
      .find((button) => !button.hidden);

    this.busy = busy;
    this.form.classList.toggle("order-busy", busy);
    this.submitButton.disabled = !busy && !this.payment.ready;
    for (const button of [this.submitButton, this.saveButton]) {
      spin(button, busy && button === shown);
    }
    if (busy && !shown) {
      this.pending.sending();
    } else {
      this.pending.hide();
    }
  }

  // The cart says the total; the button says what it does.
  submitLabel() {
    qs(this.submitButton, ".busy-button-idle").textContent = this.editing
      // Draft wording.
      ? `Pay ${dollars(this.amount())} and save`
      : "Place your order";
  }

  // One line saying when and where, the sentence people screenshot.
  when(fulfilment) {
    const f = fulfilment;
    const date = fulfilmentDate(f, (id) => this.dates.occurrence(id));
    const day = date ? label(date) : "";

    if (f.method === "delivery" && f.delivery) {
      return `${day}, delivered to ${f.delivery.address1}.`;
    }
    if (f.method === "scituate" || f.method === "scheduled") {
      return `${day}, ${this.pickupAt(f)}.`;
    }
    if (f.method === "onfarm" && f.onfarm) {
      const times = pickupTimes(f.onfarm);

      return `${day}, ${times ? windowLabel(times) : ""}, at the farm.`;
    }

    return day;
  }

  // "10:00 – 11:00 AM, at the drop site" or "9:00 AM – 1:00 PM, at
  // Foster Farmers Market": the occurrence's own hours and name, from
  // the lists (one that has since left them is still remembered). A
  // draft saved before scheduled pickup (`scituate`) reads as the drop
  // site's did; an occurrence the page cannot name, as "the scheduled pickup".
  pickupAt(f) {
    if (f.method === "scituate") {
      return `${this.drop.window}, at the drop site`;
    }

    const entry = this.dates.occurrence(f.occurrence);

    if (!entry) return "at the scheduled pickup";

    const place = entry.series === this.dropSeries
      ? "the drop site" : entry.name;

    return `${entry.window}, at ${place}`;
  }

  summaryText(payload) {
    const totals = this.totals();
    const lines = payload.lines.map((line) => {
      const item = this.index.get(line.sku);

      return `${line.qty} × ${item.groupLabel}, ${item.label} ` +
        `(${dollars(line.qty * toCents(item.price))})`;
    });

    return [
      `${payload.customer.firstName} ${payload.customer.lastName} ` +
        `<${payload.customer.email}>`,
      this.when(payload.fulfilment),
      ...lines,
      `Total ${dollars(totals.total)}`,
    ].join("\n");
  }

  finish(node) {
    this.pending.hide();
    this.result.textContent = "";
    this.result.appendChild(node);
    this.result.hidden = false;
    this.result.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  succeed(data, payload) {
    const node = document.getElementById("order-success").content
      .cloneNode(true);
    const fill = (name, text) => {
      const el = qs(node, `[data-out="${name}"]`);

      if (el) el.textContent = text;
    };

    if (data) {
      fill("name", data.customer.firstName || data.customer.name);
      fill("email", data.customer.email);
      fill("total", dollars(data.totals.total));
      fill("orderId", data.orderId);
      fill("how", this.paidWith(data.payment));
      fill("when", this.when(data.fulfilment));

      const account = qs(node, "[data-out='account']");

      if (account) account.hidden = this.isSignedIn;

      const receipt = qs(node, "[data-out='receiptUrl']");

      if (data.payment && data.payment.receiptUrl) {
        receipt.href = data.payment.receiptUrl;
      } else {
        receipt.parentElement.hidden = true;
      }
    } else {
      // Dropped silently by the server: show nothing that could be
      // used to probe the filter, just a plain thank-you.
      fill("name", payload.customer.firstName);
      qs(node, "[data-out='details']").hidden = true;
    }

    this.form.hidden = true;
    this.finish(node);
  }

  // "Visa ending 4242", "Apple Pay", "Venmo".
  paidWith(payment) {
    const p = payment || {};
    const wallets = {
      applepay: "Apple Pay", googlepay: "Google Pay", cashapp: "Cash App Pay",
      venmo: "Venmo",
    };

    if (wallets[p.method]) return wallets[p.method];

    const brand = String(p.brand || "card").toLowerCase()
      .replace(/_/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase());

    return p.last4 ? `${brand} ending ${p.last4}` : brand;
  }

  fail(payload, message) {
    const node = document.getElementById("order-failed").content
      .cloneNode(true);
    const text = this.summaryText(payload);
    const mail = qs(node, "[data-out='mailto']");
    const phone = qs(node, "[data-out='phone']");
    const copy = qs(node, "[data-out='copy']");

    qs(node, "[data-out='message']").textContent = message;
    qs(node, "[data-out='summary']").textContent = text;
    // The farm's own address and number, from the page's data; only a
    // plain address or number becomes a link.
    if (/^[^\s@?&#:/]+@[^\s@?&#:/]+$/.test(this.contact.email)) {
      mail.href = `mailto:${encodeURIComponent(this.contact.email)}` +
        `?subject=` +
        `${encodeURIComponent("Order from the website")}&body=` +
        `${encodeURIComponent(text)}`;
    }
    mail.textContent = this.contact.email;
    if (/^\+?\d+$/.test(this.contact.phone.plain)) {
      phone.href = `tel:${this.contact.phone.plain}`;
    }
    phone.textContent = this.contact.phone.display;

    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy summary"; }, 2000);
      } catch {
        copy.textContent = "Select the text above to copy it";
      }
    });

    // The key, never the payload: it holds the customer's details, and
    // the console is read by whoever sits down at the machine (#258).
    console.error(JSON.stringify({
      event: "order.undeliverable",
      idempotencyKey: payload && payload.meta && payload.meta.idempotencyKey,
    }));
    // Tell the farm a checkout could not complete. A beacon survives
    // the page being closed; nothing here can fail the customer.
    try {
      const beacon = JSON.stringify({
        kind: "checkout.failed",
        message,
        method: payload.fulfilment && payload.fulfilment.method,
        page: location.pathname,
      });

      if (!navigator.sendBeacon || !navigator.sendBeacon("/api/health",
        new Blob([beacon], { type: "application/json" }))) {
        fetch("/api/health", {
          method: "POST", body: beacon, keepalive: true,
          headers: { "Content-Type": "application/json" },
        }).catch(() => {});
      }
    } catch {
      // The failure itself is already on screen.
    }
    this.finish(node);
  }
}
