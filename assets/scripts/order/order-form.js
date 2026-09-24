import Tooltip from "bootstrap/js/dist/tooltip.js";

import { indexCatalog } from "./lib/catalog.mjs";
import { summarize } from "./lib/summary.mjs";
import {
  computeTotals, dollars, meetsMinimum, toCents,
} from "./lib/totals.mjs";
import {
  disallowedFor, normalizeCode, phoneOk, validateOrder, zipInfo,
} from "./lib/validate.mjs";
import { label } from "./lib/zoned.mjs";
import { celebrate } from "./celebrate.js";
import { DateLists } from "./date-lists.js";
import { Draft } from "./draft.js";
import { Errors } from "./errors.js";
import { Payment } from "./pay.js";
import { Pending } from "./pending.js";
import { Stock } from "./stock.js";
import { Submitter } from "./submit.js";
import ScrollSpy from "bootstrap/js/dist/scrollspy.js";
import { me } from "../session/session.js";
import { api } from "../utils/api.js";

const RETRY_DELAYS = [5000, 15000, 45000, 120000, 300000];
const AGREE_SEEN = "nff-delivery-policy-seen";
const MAX_ATTEMPTS = 6;

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


export class OrderForm {
  static init() {
    document.addEventListener("DOMContentLoaded", () => {
      const form = document.getElementById("order-form");

      if (form) new OrderForm(form).start();
    });
  }

  constructor(form) {
    const data = JSON.parse(document.getElementById("order-data").textContent);

    this.form = form;
    this.catalog = data.catalog;
    this.terms = data.terms;
    this.contact = data.contact;
    // Discount codes, by hash; the plain codes stay on the server.
    this.codes = data.codes || [];
    this.code = null;
    this.joke = null;
    this.index = indexCatalog(this.catalog);
    this.money = this.terms.money;
    this.errors = new Errors(form);
    this.draft = new Draft();
    this.dates = new DateLists(form, () => this.refresh());
    this.submitter = new Submitter();
    this.stock = new Stock(form, {
      onChange: (notice) => this.stockMoved(notice),
      setQty: (input, n) => this.setQty(input, n),
    });
    this.stockNotice = document.getElementById("order-stock");
    this.cart = document.getElementById("order-cart");
    this.result = document.getElementById("order-result");
    this.pending = new Pending(document.getElementById("order-pending"), {
      max: MAX_ATTEMPTS,
      onRetry: () => this.resume(this.draft.pending()),
      onCancel: () => this.cancelRetries(),
    });
    this.submitButton = document.getElementById("order-submit");
    this.payment = new Payment(document.getElementById("payment"), this);
    this.retryTimer = null;
    this.lastTotal = null;
    this.lastCount = null;
    this.busy = false;
    // Which badges were lit at the last render, so a badge that turns
    // on can celebrate. Null until the first render, which never does.
    this.lit = null;
    // The signed-in customer's discount group, from /api/me. The server
    // applies it again from the session; this only shows it.
    this.group = null;
  }

  start() {
    this.wire();

    const pending = this.draft.pending();

    if (pending) {
      this.restore(pending.payload);
      this.resume(pending);
      this.pending.focus();
    } else {
      const draft = this.draft.load();

      if (draft && draft.payload) this.restore(draft.payload);
    }

    this.addFromQuery();
    this.dates.load();
    this.applyCode({ quiet: true });
    this.refresh();
    this.stock.start();
    this.payment.start();

    // A signed-in customer sees their discount group as they shop, and
    // their details arrive already filled in.
    me().then((who) => {
      if (!who.signedIn || !who.customer) return;

      const group = who.customer.discountGroup || null;

      if (group && group !== this.group) {
        this.group = group;
        this.refresh();
      }
      this.prefill(who.customer);
    }).catch(() => {});
  }

  // Name, email and phone from the customer's record, shown as plain
  // text. A click turns one back into a field; leaving it, filled,
  // turns it into text again.
  prefill(customer) {
    let any = false;

    for (const input of all(this.form, "[data-prefill]")) {
      const value = customer[input.dataset.prefill];

      if (!value) continue;
      if (!input.value) input.value = value;
      this.plain(input, true);
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

  // The farm-news request, once per address: the confirmation email
  // goes out now, and one click there adds them, so nobody is added
  // on the strength of a typo or a tick on someone else's behalf.
  async askNews() {
    const news = qs(this.form, "[data-field='customer.marketing']");
    const email = qs(this.form, "[data-field='customer.email']");
    const note = qs(this.form, "[data-news-note]");
    const address = email.value.trim().toLowerCase();

    if (!news.checked || !address || !email.checkValidity()) return;
    if (this.newsAsked.has(address)) return;
    this.newsAsked.add(address);

    const { ok } = await api("/api/news/subscribe", {
      method: "POST", body: { email: address },
    });

    if (ok) {
      note.textContent = `Check ${address} for an email from us. One click ` +
        "there and you're on the list.";
      note.hidden = false;
    } else {
      this.newsAsked.delete(address);
    }
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

  plain(input, on) {
    input.classList.toggle("form-control-plaintext", on);
    input.classList.toggle("form-control", !on);
    input.readOnly = on;
  }

  wire() {
    this.form.addEventListener("input", () => this.changed());
    this.form.addEventListener("change", (e) => {
      this.changed();
      if (e.target.name === "method") this.revealMethod();
    });
    this.form.addEventListener("submit", (e) => this.submit(e));
    this.form.addEventListener("click", (e) => this.step(e));

    // Blur normalises whatever was typed into a quantity box, and
    // turns an edited detail back into plain text.
    this.form.addEventListener("focusout", (e) => {
      if (e.target.matches("[data-qty]")) {
        this.setQty(e.target, this.qty(e.target));
      }
      if (e.target.matches("[data-prefill]") && e.target.value.trim()) {
        this.plain(e.target, true);
      }
    });

    // A click on a plain-text detail makes it a field again.
    this.form.addEventListener("click", (e) => {
      if (e.target.matches("[data-prefill][readonly]")) {
        this.plain(e.target, false);
        e.target.focus();
      }
    });

    const phone = qs(this.form, "[data-field='customer.phone']");

    phone.addEventListener("input", (e) => {
      this.formatPhone((e.inputType || "").startsWith("delete"));
      this.showContact();
    });
    this.formatPhone();
    this.showContact();

    // Ticking the farm-news box asks for the confirmation email at
    // once, with the address in the form, rather than at the order.
    const news = qs(this.form, "[data-field='customer.marketing']");
    const email = qs(this.form, "[data-field='customer.email']");

    this.newsAsked = new Set();
    news.addEventListener("change", () => this.askNews());
    email.addEventListener("focusout", () => this.askNews());

    // The delivery-policy note can be dismissed, and stays dismissed.
    const agree = qs(this.form, "[data-agree]");

    agree.hidden = this.draft.flag(AGREE_SEEN);
    qs(agree, "[data-agree-dismiss]").addEventListener("click", () => {
      this.draft.setFlag(AGREE_SEEN);
      agree.hidden = true;
    });

    // Below xl the cart folds down to the total and the Next button.
    qs(this.cart, "[data-cart-toggle]").addEventListener("click", () => {
      this.setOpen(this.cart.dataset.open !== "true");
    });
    qs(this.cart, ".order-cart-foot").addEventListener("click", (e) => {
      if (e.target.closest("[data-cart-toggle]")) return;
      this.setOpen(this.cart.dataset.open !== "true");
    });

    // Below xl the pane floats at the foot of the screen while its
    // place in the page is further down, and settles into the flow
    // after the last row. Floating it casts a shadow; settled it is
    // flat and carries its heading. Sticky gives no event for this,
    // so the rect says which.
    let stuckTick = null;
    const stuckWatch = () => {
      stuckTick = null;

      const r = this.cart.getBoundingClientRect();
      const floating = matchMedia("(max-width: 1199.98px)").matches
        && r.bottom > window.innerHeight - 13;

      this.cart.dataset.stuck = String(floating);
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
    qs(this.cart, ".order-cart-body").addEventListener(
      "transitionend", () => this.syncScroll()
    );
    qs(this.cart, "[data-cart-more]").addEventListener("click", () => {
      const list = qs(this.cart, "[data-cart-items]");

      list.scrollBy({ top: list.clientHeight * 0.8, behavior: "smooth" });
    });
    window.addEventListener("resize", () => this.syncScroll());

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

    // A tap on a badge explains it; the next tap, or a tap elsewhere,
    // closes it.
    const tips = all(this.cart, "[data-badge]").map((badge) => new Tooltip(
      badge, { title: badge.dataset.tip, trigger: "click", placement: "top" }
    ));

    this.cart.addEventListener("show.bs.tooltip", (e) => {
      for (const tip of tips) {
        if (tip._element !== e.target) tip.hide();
      }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("[data-badge]")) {
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

    // The sidebar is an outline of the whole page, so the spy watches
    // the page. Keep the active link in view, mark the category so its
    // heading can show the chevron, and below lg put the current name
    // in the sticky bar, where the heading lives on a phone.
    const catalog = document.getElementById("order-catalog");
    const topbar = document.querySelector("[data-topbar-title]");

    ScrollSpy.getOrCreateInstance(document.body, {
      target: "#order-nav", rootMargin: "-20% 0px -65%", smoothScroll: true,
    });
    document.body.addEventListener("activate.bs.scrollspy", (e) => {
      const link = e.relatedTarget;

      link.scrollIntoView({ block: "nearest", behavior: "smooth" });
      for (const cat of all(catalog, ".order-cat")) {
        cat.classList.toggle("is-active", `#${cat.id}` === link.hash);
      }
      if (topbar) {
        topbar.textContent = link.dataset.heading || link.textContent.trim();
      }
    });
    qs(catalog, ".order-cat").classList.add("is-active");

    const retryNow = () => {
      if (this.draft.pending() && !this.busy) this.resume(this.draft.pending());
    };

    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") retryNow();
    });
  }

  changed() {
    this.refresh();
    this.draft.save(this.collect());
    // A change after a payment attempt began means the next attempt
    // must not reuse that attempt's keys (the order may differ).
    this.draft.touch();
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

    for (const part of raw.split(",")) {
      const [sku, qtyText] = part.split(":");
      const input = qs(this.form, `[data-qty="${CSS.escape(sku || "")}"]`);
      const qty = Math.min(99, Math.max(1, parseInt(qtyText, 10) || 1));

      if (!input) {
        const item = this.index.get(sku);

        missing.push(item ? `${item.groupLabel}, ${item.label}` : sku);
        continue;
      }
      this.setQty(input, Math.min(99, this.qty(input) + qty));
      added.push(`${qty} × ${this.index.get(sku).label}`);
    }

    const notice = document.getElementById("order-added");
    const bits = [];

    if (added.length) bits.push(`Added to your cart: ${added.join(", ")}.`);
    if (missing.length) {
      bits.push(`No longer available: ${missing.join(", ")}.`);
    }
    notice.textContent = bits.join(" ");
    notice.hidden = !bits.length;
    notice.classList.toggle("alert-warning", !added.length);
    notice.classList.toggle("alert-success", added.length > 0);

    params.delete("add");
    history.replaceState(null, "", `${location.pathname}${
      params.toString() ? `?${params}` : ""}${location.hash}`);

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

  // Folds or opens the cart (below xl; the column ignores it).
  setOpen(open) {
    this.cart.dataset.open = String(open);
    qs(this.cart, "[data-cart-toggle]").setAttribute(
      "aria-expanded", String(open)
    );
    qs(this.cart, "[data-cart-word]").textContent = open ? "Hide" : "Show";
    if (open) this.syncScroll();
  }

  // Marks the scroller's wrapper with which edges have more beyond
  // them, so the CSS can fade those edges.
  syncScroll() {
    const list = qs(this.cart, "[data-cart-items]");
    const wrap = list.parentElement;
    const seen = list.scrollTop + list.clientHeight;
    const more = seen < list.scrollHeight - 1;
    const below = all(list, ".order-cart-item").filter(
      (li) => li.offsetTop + li.offsetHeight > seen + 1
    ).length;
    const button = qs(wrap, "[data-cart-more]");

    wrap.toggleAttribute("data-top", list.scrollTop > 0);
    wrap.toggleAttribute("data-more", more);
    button.hidden = !more || below === 0;
    button.textContent = `${below} more ↓`;
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
    const next = Math.min(99, Math.max(0, was + Number(button.dataset.step)));

    this.setQty(input, next);
    pulse(input, "order-qty-tick");

    if (was === 0 && next > 0) {
      qs(box, ".order-qty-step [data-step='1']").focus();
    } else if (next === 0) {
      button.closest(".order-item").focus();
    }

    this.changed();
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

    // Apply with the field empty takes the code off again.
    if (!typed) {
      this.stopJoke();
      this.code = null;
      say("");
      this.refresh();

      return;
    }
    // An accepted code leaves the field empty for the next one; the
    // discount line says it is on, and the note says so for a while.
    const accepted = (text) => {
      input.value = "";
      say(text, "good");
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
    } else if (!quiet) {
      // The code that was on stays on.
      say("Not a valid discount code.");
    }
    this.refresh();
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
    return meetsMinimum(totals, this.money);
  }

  // Everything derived from the current field values.

  refresh() {
    const method = this.method();
    const totals = this.totals();

    for (const input of all(this.form, "[data-qty]")) {
      const qty = this.qty(input);
      const box = input.closest(".order-qty");
      const state = qty > 0 ? "active" : "empty";

      if (box.dataset.qtyState !== state) box.dataset.qtyState = state;
      qs(box, "[data-step='-1']").setAttribute(
        "aria-label", qty === 1 ? "Remove" : "One fewer"
      );
    }

    for (const body of all(this.form, "[data-method-body]")) {
      body.toggleAttribute("inert", body.dataset.methodBody !== method);
    }

    this.renderCart(totals, method);
    this.renderZipNote();
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
      totals, method, money: this.money, count, lines, index: this.index,
    });

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
    this.payment.setAmount(totals.total);
    this.submitLabel();

    qs(c, "[data-cart-toggle]").setAttribute(
      "aria-label", `${s.countText}, total ${s.total}. Show or hide the cart.`
    );
    qs(c, "[data-cart-count]").textContent = s.countText;

    // Empty, the cart folds away; the first item opens it. A fold the
    // customer chose stays until the cart empties again.
    if (count === 0 && this.lastCount !== 0) {
      this.setOpen(false);
    } else if (count > 0 && !this.lastCount) {
      this.setOpen(true);
    }
    this.lastCount = count;

    // A badge that just turned on sends its chicks; the first render
    // (a restored draft) only sets the baseline.
    const lit = {};

    for (const badge of s.badges) {
      const el = qs(c, `[data-badge="${badge.key}"]`);

      lit[badge.key] = badge.on;
      if (!el) continue;
      el.dataset.on = String(badge.on);
      if (badge.on && this.lit && !this.lit[badge.key]) celebrate(el);
    }
    this.lit = lit;

    const nudge = qs(c, "[data-nudge]");

    if (nudge.textContent !== s.nudge) nudge.textContent = s.nudge;
    nudge.hidden = !s.nudge;
    nudge.dataset.tone = s.nudgeTone || "";
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
          "aria-label", `Remove ${group.label}, ${item.label} from the cart`
        );
        row.appendChild(remove);
        row.appendChild(make("span", "order-cart-item-name", item.label));
        row.appendChild(make("span", "order-cart-item-qty", item.qtyText));
        row.appendChild(make("span", "order-cart-item-sub", item.subtotal));
        items.appendChild(row);
      }
      li.appendChild(items);
      list.appendChild(li);
    }

    qs(list, ".order-cart-none").hidden = s.groups.length > 0;
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
        "and the Scituate drop site are open to everyone.";
      note.classList.add("text-danger-emphasis");
    } else if (info.status === "unlisted") {
      note.textContent = "A little outside our usual area: delivery is " +
        `${this.money.outsideAreaFee} more, and we'll confirm with you ` +
        "before we charge you.";
    } else if (bad.length) {
      note.textContent = "We can only deliver eggs to Connecticut for now. " +
        "Remove the chicken, or choose pickup.";
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
        const name = el.getAttribute("name") || qs(el, "input").name;
        const checked = qs(this.form, `[name="${name}"]:checked`);

        return checked ? checked.value : "";
      }

      return el.value;
    };
    const method = this.method();
    const dateSelect = qs(this.form, `[data-dates="${method}"]`);

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
        method,
        date: dateSelect ? dateSelect.value : "",
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

    for (const line of payload.lines || []) {
      const input = qs(this.form, `[data-qty="${line.sku}"]`);

      if (input) this.setQty(input, line.qty);
    }

    if (f.method) set("fulfilment.method", f.method);
    set("onfarm.window", o.window);

    for (const key of [
      "address1", "address2", "town", "zip", "cooler", "notes",
    ]) {
      set(`delivery.${key}`, d[key]);
    }

    if (f.method && f.date) {
      const select = qs(this.form, `[data-dates="${f.method}"]`);

      // Kept until the real list arrives; fill() honours it if the
      // date is still valid.
      if (select) select.value = f.date;
    }
    this.showContact();
  }

  // What the payment section asks of the form (pay.js).

  amount() {
    return this.total || 0;
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
  prepare() {
    if (this.busy) return null;

    const payload = this.collect();
    const check = validateOrder(payload, {
      index: this.index, terms: this.terms, now: this.dates.now(),
      group: this.group, code: this.code,
    });

    if (!check.ok) {
      if (check.dates) {
        this.dates.replace(payload.fulfilment.method, check.dates);
      }
      this.errors.show(check.errors);

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
    const payload = this.prepare();

    if (!payload) return null;

    this.moved = false;
    await this.stock.refresh();
    if (this.moved) return null;

    return payload;
  }

  // A wallet's token, or the card's: send it.
  pay(payload, source) {
    return this.deliver({ ...payload, payment: source }, 0);
  }

  // Venmo's two steps. The first answers with the PayPal order the
  // button pays; the second captures it and records the order.
  async venmoCreate(payload) {
    this.setBusy(true);
    this.pending.sending(1);

    const outcome = await this.submitter.send({
      ...payload, payment: { method: "venmo", stage: "create" },
    });

    this.setBusy(false);
    this.pending.hide();
    if (outcome.kind === "ok" && outcome.data && outcome.data.paypalOrderId) {
      this.draft.markAttempted();

      return outcome.data.paypalOrderId;
    }

    this.settle(outcome, payload);
    throw new Error(outcome.message || "Couldn't start the Venmo payment.");
  }

  venmoCapture(payload, paypalOrderId) {
    return this.deliver({
      ...payload, payment: { method: "venmo", stage: "capture", paypalOrderId },
    }, 0);
  }

  // Submission and recovery.

  // The main button: the card form.
  async submit(e) {
    e.preventDefault();

    const payload = await this.prepareAsync();

    if (!payload) return;

    let source;

    this.setBusy(true);
    try {
      source = await this.payment.tokenizeCard(payload);
    } catch (error) {
      this.setBusy(false);
      this.payment.fail(error.message);

      return;
    }
    this.setBusy(false);
    await this.pay(payload, source);
  }

  // `attempts` is how many have already failed.
  async deliver(payload, attempts) {
    this.setBusy(true);
    this.pending.sending(attempts + 1);
    this.draft.markAttempted();

    const outcome = await this.submitter.send(payload);

    this.setBusy(false);

    switch (outcome.kind) {
    case "ok":
      this.draft.clearPending();
      this.draft.clear();
      this.succeed(outcome.data, payload);
      break;
    case "retry":
      this.defer(payload, attempts + 1);
      break;
    default:
      this.settle(outcome, payload);
    }
  }

  // Every answer but success and retry: the customer decides again.
  settle(outcome, payload) {
    this.draft.clearPending();
    this.pending.hide();
    switch (outcome.kind) {
    case "invalid":
      if (outcome.stock) {
        this.stock.items = outcome.stock;
        this.stock.apply();
      }
      if (outcome.errors.total) {
        this.refresh();
        this.payment.fail(outcome.errors.total);
      }
      this.errors.show(outcome.errors);
      break;
    case "stale":
      this.dates.replace(payload.fulfilment.method, outcome.dates);
      this.errors.show({
        "fulfilment.date": "That date just closed. Pick another from the " +
            "updated list and try again.",
      });
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
    default:
      this.fail(payload, outcome.message);
    }
  }

  defer(payload, attempts) {
    if (attempts >= MAX_ATTEMPTS) {
      this.draft.clearPending();
      this.fail(payload,
        "We couldn't reach our payment system after several tries.");

      return;
    }

    const delay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)];

    this.draft.savePending(payload, attempts);
    this.pending.waiting(attempts, delay);
    // One submission at a time: the notice owns the next attempt.
    this.submitButton.disabled = true;

    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => this.resume(this.draft.pending()), delay
    );
  }

  resume(pending) {
    if (!pending || this.busy) return;

    clearTimeout(this.retryTimer);
    this.deliver(pending.payload, pending.attempts);
  }

  // The customer stops the background retries. The form keeps their
  // order and stays editable; the draft key is kept, so a later
  // submission cannot duplicate anything an earlier try created.
  cancelRetries() {
    clearTimeout(this.retryTimer);
    this.draft.clearPending();
    this.pending.hide();
    this.submitButton.disabled = false;
    this.submitButton.focus();
  }

  setBusy(busy) {
    this.busy = busy;
    this.form.classList.toggle("order-busy", busy);
    this.submitButton.disabled = busy || !this.payment.ready;
    this.submitLabel(busy);
  }

  // "Pay $55 and place your order", with the total as it stands.
  submitLabel(busy = this.busy) {
    const total = this.total ? `${dollars(this.total)} ` : "";

    this.submitButton.textContent = busy
      ? "Taking your payment…"
      : `Pay ${total}and place your order`;
  }

  // One line saying when and where, the sentence people screenshot.
  when(fulfilment) {
    const f = fulfilment;
    const day = f.date ? label(f.date) : "";

    if (f.method === "delivery" && f.delivery) {
      return `${day}, delivered to ${f.delivery.address1}.`;
    }
    if (f.method === "scituate") {
      return `${day}, Scituate drop site, ${this.terms.scituate.window}.`;
    }
    if (f.method === "onfarm" && f.onfarm) {
      return `${day}, ${f.onfarm.window}, at the farm.`;
    }

    return day;
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
      // An on-farm window is a request the farm still has to agree
      // to, so paying alone does not confirm that order.
      if (data.fulfilment && data.fulfilment.method === "onfarm") {
        fill("confirms", "The pickup time you chose is a request; we'll " +
          "check the schedule and confirm it by email.");
      }

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
    mail.href = `mailto:${this.contact.email}?subject=` +
      `${encodeURIComponent("Order from the website")}&body=` +
      `${encodeURIComponent(text)}`;
    mail.textContent = this.contact.email;
    phone.href = `tel:${this.contact.phone.plain}`;
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

    console.error(JSON.stringify({ event: "order.undeliverable", payload }));
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
