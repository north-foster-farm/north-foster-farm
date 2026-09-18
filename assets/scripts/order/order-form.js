import { indexCatalog } from "./lib/catalog.mjs";
import {
  computeTotals, dollars, meetsMinimum, nextTier,
} from "./lib/totals.mjs";
import { validateOrder, zipStatus } from "./lib/validate.mjs";
import { DateLists } from "./date-lists.js";
import { Draft } from "./draft.js";
import { Errors } from "./errors.js";
import { Submitter } from "./submit.js";

const NUDGE_WITHIN = 1500;
const RETRY_DELAYS = [5000, 15000, 45000, 120000, 300000];
const MAX_ATTEMPTS = 6;
const METHOD_DATES = ["onfarm", "scituate", "delivery"];

const qs = (root, selector) => root.querySelector(selector);
const all = (root, selector) => Array.from(root.querySelectorAll(selector));

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
    this.summary = document.getElementById("order-summary");
    this.result = document.getElementById("order-result");
    this.restored = document.getElementById("order-restored");
    this.pendingNotice = document.getElementById("order-pending");
    this.submitButton = document.getElementById("order-submit");
    this.retryTimer = null;
    this.busy = false;
  }

  start() {
    this.wire();

    const pending = this.draft.pending();

    if (pending) {
      this.restore(pending.payload);
      this.resume(pending);
    } else {
      const draft = this.draft.load();

      if (draft && draft.payload) {
        this.restore(draft.payload);
        this.restored.hidden = false;
      }
    }

    this.dates.load();
    this.refresh();
  }

  wire() {
    this.form.addEventListener("input", () => this.changed());
    this.form.addEventListener("change", () => this.changed());
    this.form.addEventListener("submit", (e) => this.submit(e));

    this.form.addEventListener("click", (e) => {
      const button = e.target.closest("[data-step]");

      if (!button) return;

      const input = qs(button.parentElement, "[data-qty]");
      const next = this.qty(input) + Number(button.dataset.step);

      input.value = String(Math.min(99, Math.max(0, next)));
      this.changed();
    });

    qs(document, "#order-discard").addEventListener("click", () => {
      this.draft.clear();
      this.form.reset();
      this.restored.hidden = true;
      this.errors.clear();
      this.refresh();
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

  // Everything derived from the current field values.

  qty(input) {
    const n = parseInt(String(input.value).replace(/\D/g, ""), 10);

    return Number.isFinite(n) ? Math.min(99, Math.max(0, n)) : 0;
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

  totals() {
    return computeTotals({
      lines: this.lines(),
      method: this.method(),
      index: this.index,
      money: this.money,
    });
  }

  refresh() {
    const method = this.method();
    const totals = this.totals();

    for (const input of all(this.form, "[data-qty]")) {
      const cell = qs(this.form, `[data-line-total="${input.dataset.qty}"]`);
      const item = this.index.get(input.dataset.qty);
      const qty = this.qty(input);

      if (cell) {
        cell.textContent = qty > 0 ? dollars(qty * item.price * 100) : "";
      }
    }

    for (const body of all(this.form, "[data-method-body]")) {
      body.hidden = body.dataset.methodBody !== method;
    }

    this.renderTotals(totals, method);
    this.renderZipNote();
  }

  renderTotals(totals, method) {
    const s = this.summary;

    qs(s, "[data-total='subtotal']").textContent = dollars(totals.subtotal);
    qs(s, "[data-total='total']").textContent = dollars(totals.total);

    const discountRow = qs(s, "[data-total-row='discount']");
    const feeRow = qs(s, "[data-total-row='fee']");

    discountRow.hidden = totals.discountAmount === 0;
    qs(s, "[data-total='discount']").textContent =
      `−${dollars(totals.discountAmount)}`;
    feeRow.hidden = totals.deliveryFee === 0;
    qs(s, "[data-total='fee']").textContent = dollars(totals.deliveryFee);

    const nudge = qs(s, "[data-nudge]");
    const next = nextTier(totals.subtotal, this.money);

    if (next && totals.subtotal > 0 && next.gap <= NUDGE_WITHIN) {
      nudge.textContent =
        `Add ${dollars(next.gap)} more to save ${dollars(next.off)}.`;
      nudge.hidden = false;
    } else {
      nudge.hidden = true;
    }

    const warning = qs(this.form, "[data-minimum-warning]");

    warning.hidden = !(
      method === "delivery" && totals.subtotal > 0 &&
      !meetsMinimum(totals, this.money)
    );
  }

  renderZipNote() {
    const zip = qs(this.form, "[data-field='delivery.zip']");
    const note = qs(this.form, "[data-zip-note]");
    const status = zipStatus(zip.value, this.terms.area);

    if (status === "unlisted") {
      note.textContent =
        "That's a little outside our usual area, but we'll make it work.";
    } else if (status === "outside") {
      note.textContent = "That's outside our delivery range.";
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
        const checked = qs(this.form, `[name="${el.getAttribute("name") ||
          qs(el, "input").name}"]:checked`);

        return checked ? checked.value : "";
      }

      return el.value;
    };
    const method = this.method();
    const dateSelect = qs(this.form, `[data-dates="${method}"]`);
    const acks = {};

    for (const box of all(this.form, "[data-ack]")) {
      acks[box.dataset.ack] = box.checked;
    }

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
          contactName: value("delivery.contactName"),
          contactPhone: value("delivery.contactPhone"),
          address1: value("delivery.address1"),
          address2: value("delivery.address2"),
          town: value("delivery.town"),
          zip: value("delivery.zip"),
          gate: value("delivery.gate"),
          cooler: value("delivery.cooler"),
          notes: value("delivery.notes"),
          acknowledgements: acks,
        },
      },
      vote: {
        southCounty: value("vote.southCounty"),
        town: value("vote.town"),
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
    const v = payload.vote || {};

    set("customer.name", c.name);
    set("customer.email", c.email);
    set("customer.phone", c.phone);

    for (const line of payload.lines || []) {
      const input = qs(this.form, `[data-qty="${line.sku}"]`);

      if (input) input.value = String(line.qty);
    }

    if (f.method) set("fulfilment.method", f.method);
    set("onfarm.window", o.window);
    set("onfarm.phone", o.phone);
    set("onfarm.textOk", o.textOk);

    for (const key of [
      "contactName", "contactPhone", "address1", "address2", "town", "zip",
      "gate", "cooler", "notes",
    ]) {
      set(`delivery.${key}`, d[key]);
    }
    for (const box of all(this.form, "[data-ack]")) {
      box.checked = !!(d.acknowledgements || {})[box.dataset.ack];
    }

    if (f.method && f.date) {
      const select = qs(this.form, `[data-dates="${f.method}"]`);

      if (select) {
        // Kept until the real list arrives; fill() honours it if the
        // date is still valid.
        select.value = f.date;
      }
    }

    set("vote.southCounty", v.southCounty);
    set("vote.town", v.town);
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

  async deliver(payload, attempts) {
    this.setBusy(true);

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
      this.pendingNotice.hidden = true;
      this.errors.show(outcome.errors);
      break;
    case "stale":
      this.draft.clearPending();
      this.pendingNotice.hidden = true;
      this.dates.replace(payload.fulfilment.method, outcome.dates);
      this.errors.show({
        "fulfilment.date": "That date just closed. We've updated the " +
            "list; please pick another and submit again.",
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

    this.draft.savePending(payload, attempts);
    this.pendingNotice.hidden = false;
    this.pendingNotice.textContent =
      "We're having trouble reaching our payment system. Your order is " +
      "saved on this device and we'll keep trying. You can leave this " +
      "page open or come back later.";

    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => this.resume(this.draft.pending()),
      RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]
    );
  }

  resume(pending) {
    if (!pending || this.busy) return;

    clearTimeout(this.retryTimer);
    this.pendingNotice.hidden = false;
    this.pendingNotice.textContent = "Sending your saved order…";
    this.deliver(pending.payload, pending.attempts);
  }

  setBusy(busy) {
    this.busy = busy;
    this.form.classList.toggle("order-busy", busy);
    this.submitButton.disabled = busy;
    this.submitButton.textContent = busy ? "Placing order…" : "Place order";
  }

  summaryText(payload) {
    const totals = this.totals();
    const lines = payload.lines.map((line) => {
      const item = this.index.get(line.sku);

      return `${line.qty} × ${item.groupLabel}, ${item.label} ` +
        `(${dollars(line.qty * item.price * 100)})`;
    });
    const f = payload.fulfilment;
    const where = {
      onfarm: "On-farm pickup",
      scituate: "Scituate drop site",
      delivery: "Local delivery",
    }[f.method] || f.method;

    return [
      `${payload.customer.name} <${payload.customer.email}>`,
      `${where}, ${f.date}`,
      ...lines,
      `Total ${dollars(totals.total)}`,
    ].join("\n");
  }

  succeed(data, payload) {
    this.pendingNotice.hidden = true;

    const template = document.getElementById("order-success");
    const node = template.content.cloneNode(true);
    const fill = (name, text) => {
      const el = qs(node, `[data-out="${name}"]`);

      if (el) el.textContent = text;
    };

    if (data) {
      fill("name", data.customer.name.split(" ")[0]);
      fill("email", data.customer.email);
      fill("orderId", data.orderId);
      fill("total", dollars(data.totals.total));

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

    this.result.textContent = "";
    this.result.appendChild(node);
    this.result.hidden = false;
    this.form.hidden = true;
    this.summary.hidden = true;
    this.restored.hidden = true;
    this.result.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  fail(payload, message) {
    this.pendingNotice.hidden = true;

    const template = document.getElementById("order-failed");
    const node = template.content.cloneNode(true);
    const text = this.summaryText(payload);
    const mail = qs(node, "[data-out='mailto']");

    qs(node, "[data-out='message']").textContent = message;
    qs(node, "[data-out='summary']").textContent = text;
    mail.href = `mailto:${this.contact.email}?subject=` +
      `${encodeURIComponent("Order from the website")}&body=` +
      `${encodeURIComponent(text)}`;
    mail.textContent = this.contact.email;

    const phone = qs(node, "[data-out='phone']");

    phone.href = `tel:${this.contact.phone.plain}`;
    phone.textContent = this.contact.phone.display;

    console.error(JSON.stringify({ event: "order.undeliverable", payload }));

    this.result.textContent = "";
    this.result.appendChild(node);
    this.result.hidden = false;
    this.result.scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

export { METHOD_DATES };
