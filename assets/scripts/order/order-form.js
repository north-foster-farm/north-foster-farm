import { indexCatalog } from "./lib/catalog.mjs";
import { summarize } from "./lib/summary.mjs";
import {
  computeTotals, dollars, meetsMinimum, toCents,
} from "./lib/totals.mjs";
import {
  disallowedFor, validateOrder, zipInfo,
} from "./lib/validate.mjs";
import { label } from "./lib/zoned.mjs";
import { celebrate } from "./celebrate.js";
import { DateLists } from "./date-lists.js";
import { Draft } from "./draft.js";
import { Errors } from "./errors.js";
import { Pending } from "./pending.js";
import { Submitter } from "./submit.js";

const RETRY_DELAYS = [5000, 15000, 45000, 120000, 300000];
const MAX_ATTEMPTS = 6;

const qs = (root, selector) => root.querySelector(selector);
const all = (root, selector) => Array.from(root.querySelectorAll(selector));

// Restart a CSS animation by re-applying its class.
const pulse = (el, className) => {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
};

// Where an element is, in viewport pixels, for a keyboard-driven change.
const centre = (el) => {
  const r = el.getBoundingClientRect();

  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
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
    this.index = indexCatalog(this.catalog);
    this.money = this.terms.money;
    this.errors = new Errors(form);
    this.draft = new Draft();
    this.dates = new DateLists(form, () => this.refresh());
    this.submitter = new Submitter();
    this.cart = document.getElementById("order-cart");
    this.result = document.getElementById("order-result");
    this.restored = document.getElementById("order-restored");
    this.pending = new Pending(document.getElementById("order-pending"), {
      max: MAX_ATTEMPTS,
      onRetry: () => this.resume(this.draft.pending()),
      onCancel: () => this.cancelRetries(),
    });
    this.submitButton = document.getElementById("order-submit");
    this.retryTimer = null;
    this.lastTotal = null;
    this.crossed = false;
    this.busy = false;
    // Where the last change came from, so the feathers start there.
    this.pointer = null;
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

      if (draft && draft.payload) {
        this.restore(draft.payload);
        this.restored.hidden = false;
      }
    }

    // Anything restored has already been through the threshold.
    this.crossed = this.eligible(this.totals());
    this.dates.load();
    this.refresh();
  }

  wire() {
    // A typed quantity celebrates from the box; a click from the cursor.
    this.form.addEventListener("input", (e) => {
      if (e.target.matches("[data-qty]")) this.pointer = centre(e.target);
      this.changed();
    });
    this.form.addEventListener("change", (e) => {
      this.changed();
      if (e.target.name === "method") this.revealMethod();
    });
    this.form.addEventListener("submit", (e) => this.submit(e));
    this.form.addEventListener("click", (e) => this.step(e));

    // Blur normalises whatever was typed into a quantity box.
    this.form.addEventListener("focusout", (e) => {
      if (e.target.matches("[data-qty]")) {
        this.setQty(e.target, this.qty(e.target));
      }
    });

    qs(document, "#order-discard").addEventListener("click", () => {
      this.draft.clear();
      this.form.reset();
      for (const input of all(this.form, "[data-qty]")) this.setQty(input, 0);
      this.restored.hidden = true;
      this.errors.clear();
      this.crossed = false;
      this.refresh();
    });

    qs(this.cart, "[data-checkout]").addEventListener("click", () => {
      const target = document.getElementById("pickup");

      target.scrollIntoView({ behavior: "smooth", block: "start" });
      qs(target, "legend").focus({ preventScroll: true });
    });

    // Keep the active category link in view as the list scrolls.
    const catalog = document.getElementById("order-catalog");

    catalog.addEventListener("activate.bs.scrollspy", (e) => {
      e.relatedTarget.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });

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

    // A real click carries its coordinates; a keyboard click has none.
    this.pointer = e.clientX || e.clientY
      ? { x: e.clientX, y: e.clientY }
      : centre(button);
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
    });
  }

  eligible(totals) {
    return meetsMinimum(totals, this.money);
  }

  // Everything derived from the current field values.

  refresh() {
    const method = this.method();
    const totals = this.totals();

    for (const input of all(this.form, "[data-qty]")) {
      const item = this.index.get(input.dataset.qty);
      const qty = this.qty(input);
      const line = qs(this.form, `[data-line-total="${input.dataset.qty}"]`);
      const box = input.closest(".order-qty");
      const state = qty > 0 ? "active" : "empty";

      if (box.dataset.qtyState !== state) box.dataset.qtyState = state;
      qs(box, "[data-step='-1']").setAttribute(
        "aria-label", qty === 1 ? "Remove" : "One fewer"
      );
      if (line) {
        line.textContent = qty > 0 ? dollars(qty * toCents(item.price)) : "";
      }
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
    const count = this.lines().reduce((n, line) => n + line.qty, 0);
    const s = summarize({ totals, method, money: this.money, count });

    qs(c, "[data-total='subtotal']").textContent = s.subtotal;

    qs(c, "[data-total-row='discount']").hidden = !s.discount;
    qs(c, "[data-total='tier']").textContent =
      s.discount ? s.discount.tier : "";
    qs(c, "[data-total='discount']").textContent =
      s.discount ? s.discount.text : "";

    const fee = qs(c, "[data-total='fee']");

    qs(c, "[data-total-row='fee']").hidden = !s.fee.show;
    fee.textContent = "";
    if (s.fee.show && s.fee.waived) {
      const free = document.createElement("span");
      const struck = document.createElement("s");

      free.className = "order-cart-free";
      struck.textContent = s.fee.was;
      free.append(struck, "Free");
      fee.appendChild(free);
    } else if (s.fee.show) {
      fee.textContent = s.fee.text;
    }

    const total = qs(c, "[data-total='total']");

    if (this.lastTotal !== null && this.lastTotal !== s.total) {
      pulse(total, "is-bumped");
    }
    total.textContent = s.total;
    this.lastTotal = s.total;

    qs(c, "[data-total='count']").textContent = s.countText;
    qs(c, ".order-cart-toggle").setAttribute(
      "aria-label",
      `Order total ${s.total}, ${s.countText}. Show the breakdown.`
    );
    qs(c, "[data-checkout]").disabled = count === 0;

    for (const badge of s.badges) {
      const el = qs(c, `[data-badge="${badge.key}"]`);

      if (el) el.dataset.on = String(badge.on);
    }

    const nudge = qs(c, "[data-nudge]");

    if (nudge.textContent !== s.nudge) nudge.textContent = s.nudge;
    nudge.hidden = !s.nudge;

    if (s.eligible && !this.crossed) {
      this.crossed = true;
      celebrate(this.pointer || centre(total));
    } else if (!s.eligible) {
      this.crossed = false;
    }
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
      note.textContent = "A little outside our usual area. We'll confirm " +
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
        name: value("customer.name"),
        email: value("customer.email"),
        phone: value("customer.phone"),
      },
      lines: this.lines(),
      fulfilment: {
        method,
        date: dateSelect ? dateSelect.value : "",
        onfarm: {
          window: value("onfarm.window"),
          phone: value("onfarm.phone"),
          textOk: value("onfarm.textOk"),
        },
        delivery: {
          address1: value("delivery.address1"),
          address2: value("delivery.address2"),
          town: value("delivery.town"),
          zip: value("delivery.zip"),
          gate: value("delivery.gate"),
          cooler: value("delivery.cooler"),
          notes: value("delivery.notes"),
        },
      },
      notes: value("notes"),
      source: value("source"),
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

    set("customer.name", c.name);
    set("customer.email", c.email);
    set("customer.phone", c.phone);

    for (const line of payload.lines || []) {
      const input = qs(this.form, `[data-qty="${line.sku}"]`);

      if (input) this.setQty(input, line.qty);
    }

    if (f.method) set("fulfilment.method", f.method);
    set("onfarm.window", o.window);
    set("onfarm.phone", o.phone);
    set("onfarm.textOk", o.textOk);

    for (const key of [
      "address1", "address2", "town", "zip", "gate", "cooler", "notes",
    ]) {
      set(`delivery.${key}`, d[key]);
    }

    if (f.method && f.date) {
      const select = qs(this.form, `[data-dates="${f.method}"]`);

      // Kept until the real list arrives; fill() honours it if the
      // date is still valid.
      if (select) select.value = f.date;
    }

    set("notes", payload.notes);
    set("source", payload.source);
  }

  // Submission and recovery.

  async submit(e) {
    e.preventDefault();

    if (this.busy) return;

    const payload = this.collect();
    const check = validateOrder(payload, {
      index: this.index, terms: this.terms, now: this.dates.now(),
    });

    if (!check.ok) {
      if (check.dates) {
        this.dates.replace(payload.fulfilment.method, check.dates);
      }
      this.errors.show(check.errors);

      return;
    }

    this.errors.clear();
    payload.idempotencyKey = this.draft.key();
    this.draft.save(payload);
    await this.deliver(payload, 0);
  }

  // `attempts` is how many have already failed.
  async deliver(payload, attempts) {
    this.setBusy(true);
    this.pending.sending(attempts + 1);

    const outcome = await this.submitter.send(payload);

    this.setBusy(false);

    switch (outcome.kind) {
    case "ok":
      this.draft.clearPending();
      this.draft.clear();
      this.succeed(outcome.data, payload);
      break;
    case "invalid":
      this.draft.clearPending();
      this.pending.hide();
      this.errors.show(outcome.errors);
      break;
    case "stale":
      this.draft.clearPending();
      this.pending.hide();
      this.dates.replace(payload.fulfilment.method, outcome.dates);
      this.errors.show({
        "fulfilment.date": "That date just closed. Pick another from the " +
            "updated list and try again.",
      });
      break;
    case "retry":
      this.defer(payload, attempts + 1);
      break;
    default:
      this.draft.clearPending();
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
    this.submitButton.disabled = busy;
    this.submitButton.textContent = busy
      ? "Placing your order…"
      : "Place your order";
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
      `${payload.customer.name} <${payload.customer.email}>`,
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
      fill("name", data.customer.name.split(" ")[0]);
      fill("email", data.customer.email);
      fill("orderId", data.orderId);
      fill("total", dollars(data.totals.total));
      fill("when", this.when(data.fulfilment));

      const link = qs(node, "[data-out='invoiceUrl']");

      if (data.invoiceUrl) {
        link.href = data.invoiceUrl;
      } else {
        link.parentElement.hidden = true;
      }

      const list = qs(node, "[data-out='lines']");

      for (const line of data.lines) {
        const li = document.createElement("li");

        li.textContent = `${line.qty} × ${line.label}`;
        list.appendChild(li);
      }
    } else {
      // Dropped silently by the server: show nothing that could be
      // used to probe the filter, just a plain thank-you.
      fill("name", payload.customer.name.split(" ")[0]);
      qs(node, "[data-out='details']").hidden = true;
    }

    this.form.hidden = true;
    this.restored.hidden = true;
    this.finish(node);
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
    this.finish(node);
  }
}
