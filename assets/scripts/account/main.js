// The account page. Everything is rendered from /api/me and
// /api/account/orders with DOM APIs, never innerHTML, so nothing a
// customer typed can become markup. Sections are tabs keyed by the
// URL hash.

import { dollars } from "../order/lib/totals.mjs";
import { label } from "../order/lib/zoned.mjs";
import { forget } from "../session/session.js";
import { api } from "../utils/api.js";

const qs = (root, selector) => root.querySelector(selector);
const all = (root, selector) => Array.from(root.querySelectorAll(selector));

const STATUS = {
  submitted: "Awaiting payment",
  paid: "Paid",
  fulfilled: "Delivered",
  cancelled: "Cancelled",
  abandoned: "Not paid",
};

const METHOD = {
  delivery: "Local delivery",
  scituate: "Scituate drop site",
  onfarm: "On-farm pickup",
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);

  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;

  return node;
};

const clone = (id) => document.getElementById(id).content.cloneNode(true);

const when = (order) => {
  const f = order.fulfilment;
  const day = f.date ? label(f.date) : "";

  if (f.method === "onfarm" && f.onfarm) {
    return `${METHOD.onfarm}, ${day}, ${f.onfarm.window}`;
  }

  return `${METHOD[f.method] || f.method}, ${day}`;
};

const placed = (iso) => new Date(iso).toLocaleDateString("en-US", {
  month: "short", day: "numeric", year: "numeric",
});

// The order page takes ?add=SKU:qty,... and puts those in the cart.
const addUrl = (lines) => `/order/?add=${encodeURIComponent(
  lines.map((l) => `${l.sku}:${l.qty}`).join(",")
)}`;

class Account {
  constructor() {
    const data = JSON.parse(
      document.getElementById("account-data").textContent
    );

    this.avatars = data.avatars;
    this.terms = data.terms;
    this.app = document.getElementById("account-app");
    this.loading = document.getElementById("account-loading");
    this.flash = document.getElementById("account-flash");
    this.customer = null;
    this.orders = [];
    this.dates = null;
  }

  async start() {
    const me = await api("/api/me");

    if (!me.ok || !me.data.signedIn) {
      location.replace(`/login/?next=${encodeURIComponent("/account/")}`);

      return;
    }

    this.customer = me.data.customer;
    this.wire();
    this.renderHead();
    this.renderAddress();
    this.renderProfile();
    await this.loadOrders();
    this.loading.hidden = true;
    this.app.hidden = false;
    this.showTab(location.hash.replace("#", "") || "orders");
  }

  wire() {
    window.addEventListener("hashchange", () => {
      this.showTab(location.hash.replace("#", "") || "orders");
    });

    document.getElementById("account-signout").addEventListener("click",
      async () => {
        await api("/api/auth/signout", { method: "POST", body: {} });
        forget();
        location.href = "/";
      });

    document.getElementById("address-form").addEventListener("submit",
      (e) => this.saveAddress(e));
    document.getElementById("profile-form").addEventListener("submit",
      (e) => this.saveProfile(e));
    document.getElementById("support-form").addEventListener("submit",
      (e) => this.sendSupport(e));
  }

  showTab(name) {
    const known = all(document, "[data-section]").map((s) => s.dataset.section);
    const tab = known.includes(name) ? name : "orders";

    for (const section of all(document, "[data-section]")) {
      section.hidden = section.dataset.section !== tab;
    }
    for (const link of all(document, "[data-tab]")) {
      const active = link.dataset.tab === tab;

      link.classList.toggle("is-active", active);
      if (active) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    }
  }

  say(message) {
    this.flash.textContent = message;
    this.flash.hidden = !message;
    if (message) this.flash.scrollIntoView({ block: "nearest" });
  }

  // Field errors from the API, next to the fields of one form.
  showErrors(form, errors) {
    this.clearErrors(form);
    for (const [key, message] of Object.entries(errors || {})) {
      const slot = qs(form, `[data-error-for="${key}"]`);
      const field = qs(form, `[data-field="${key}"], [name="${key}"]`);

      if (slot) {
        slot.textContent = message;
        slot.style.display = "block";
      }
      if (field) field.classList.add("is-invalid");
    }
    const first = qs(form, ".is-invalid");

    if (first) first.focus();
  }

  clearErrors(form) {
    for (const slot of all(form, "[data-error-for]")) {
      slot.textContent = "";
      slot.style.display = "";
    }
    for (const field of all(form, ".is-invalid")) {
      field.classList.remove("is-invalid");
    }
  }

  // Head, address and settings

  renderHead() {
    const c = this.customer;

    qs(document, "#account-avatar use").setAttribute(
      "href", `#avatar-${c.avatar || "hen-brown"}`
    );
    document.getElementById("account-name").textContent = c.name || "Welcome";
    document.getElementById("account-email").textContent = c.email;
  }

  renderAddress() {
    const a = this.customer.address;
    const form = document.getElementById("address-form");
    const status = document.getElementById("address-status");

    for (const key of [
      "address1", "address2", "town", "zip", "cooler", "gate", "notes",
    ]) {
      qs(form, `[data-field="${key}"]`).value = (a && a[key]) || "";
    }

    let text = "";
    let tone = "";

    if (a && a.status === "approved") {
      text = "Approved for delivery.";
      tone = "ok";
    } else if (a && a.status === "pending") {
      text = "Outside our usual area. We're checking whether we can " +
        "deliver here and will email you.";
      tone = "wait";
    } else if (a && a.status === "denied") {
      text = "We can't deliver to this address. On-farm pickup and the " +
        "Scituate drop site are open to everyone.";
      tone = "no";
    }
    status.textContent = text;
    status.dataset.tone = tone;
    status.hidden = !text;
  }

  renderProfile() {
    const c = this.customer;
    const form = document.getElementById("profile-form");

    qs(form, "[data-field='name']").value = c.name || "";
    qs(form, "[data-field='phone']").value = c.phone || "";
    document.getElementById("prof-email").value = c.email;
    for (const radio of all(form, "[data-field='avatar']")) {
      radio.checked = radio.value === c.avatar;
    }

    const groups = (this.terms.money && this.terms.money.discountGroups) || {};
    const group = c.discountGroup && groups[c.discountGroup];
    const row = document.getElementById("prof-group-row");

    row.hidden = !group;
    if (group) {
      document.getElementById("prof-group").textContent =
        `${group.label}: ${group.percent}% off, whenever that beats the ` +
        "bulk discount.";
    }
  }

  async saveAddress(e) {
    e.preventDefault();

    const form = e.target;
    const body = {};

    for (const field of all(form, "[data-field]")) {
      body[field.dataset.field] = field.value;
    }

    const { ok, data } = await api("/api/account/address", {
      method: "PUT", body,
    });

    if (!ok) {
      this.showErrors(form, data.errors);

      return;
    }

    this.clearErrors(form);
    this.customer = data.customer;
    this.renderAddress();
    this.say(data.customer.address.status === "approved"
      ? "Address saved."
      : "Address saved. We'll check it and email you.");
  }

  async saveProfile(e) {
    e.preventDefault();

    const form = e.target;
    const avatar = qs(form, "[data-field='avatar']:checked");
    const body = {
      name: qs(form, "[data-field='name']").value,
      phone: qs(form, "[data-field='phone']").value,
      avatar: avatar ? avatar.value : null,
    };
    const { ok, data } = await api("/api/account/profile", {
      method: "PATCH", body,
    });

    if (!ok) {
      this.showErrors(form, data.errors);

      return;
    }

    this.clearErrors(form);
    this.customer = data.customer;
    this.renderHead();
    forget();
    this.say("Settings saved.");
  }

  async sendSupport(e) {
    e.preventDefault();

    const form = e.target;
    const body = {};

    for (const field of all(form, "[data-field]")) {
      body[field.dataset.field] = field.value;
    }

    const { ok, data } = await api("/api/account/support", {
      method: "POST", body,
    });

    if (!ok) {
      this.showErrors(form, data.errors);

      return;
    }

    this.clearErrors(form);
    form.reset();
    this.say("Sent. We'll answer by email.");
  }

  // Orders and invoices

  async loadOrders() {
    const { ok, data } = await api("/api/account/orders");

    this.orders = ok ? data.orders : [];
    this.renderOrders();
    this.renderInvoices();
    this.renderSupportOrders();
  }

  renderOrders() {
    const list = document.getElementById("orders-list");

    list.textContent = "";
    document.getElementById("orders-empty").hidden = this.orders.length > 0;
    for (const order of this.orders) list.appendChild(this.orderCard(order));
  }

  orderCard(order) {
    const node = clone("tpl-order");
    const card = qs(node, "[data-order]");
    const set = (name, text) => {
      qs(node, `[data-out="${name}"]`).textContent = text;
    };

    card.id = `order-${order.id}`;
    card.dataset.status = order.status;
    set("when", when(order));
    set("id", order.id);
    set("placed", placed(order.submittedAt));
    set("status", order.cancelRequested
      ? "Cancellation requested"
      : (STATUS[order.status] || order.status));

    const note = qs(node, "[data-out='note']");

    if (order.status === "submitted" && order.invoice && order.invoice.url) {
      note.textContent = "Not final until it's paid. ";
      const link = el("a", "", "Pay the invoice");

      link.href = order.invoice.url;
      link.target = "_blank";
      link.rel = "noopener";
      note.appendChild(link);
      note.hidden = false;
    } else if (order.cancelRequested) {
      note.textContent = "We're refunding this order. Your money goes back " +
        "to the card you paid with.";
      note.hidden = false;
    } else if (order.status === "abandoned") {
      note.textContent = "This order wasn't paid by the cutoff, so it was " +
        "cancelled.";
      note.hidden = false;
    }

    const lines = qs(node, "[data-out='lines']");

    // Each line links back to the order page with that item in the
    // cart; a plain link, so it works everywhere and needs no state.
    for (const line of order.lines) {
      const li = clone("tpl-line");
      const add = qs(li, "[data-out='add']");

      qs(li, "[data-out='qty']").textContent = `${line.qty} ×`;
      qs(li, "[data-out='label']").textContent = line.label;
      qs(li, "[data-out='total']").textContent = dollars(line.lineTotal * 100);
      add.href = addUrl([line]);
      add.setAttribute("aria-label", `Add ${line.qty} × ${line.label} to ` +
        "your cart again");
      lines.appendChild(li);
    }

    const totals = qs(node, "[data-out='totals']");
    const row = (dt, dd, className) => {
      const wrap = el("div", className);

      wrap.appendChild(el("dt", "", dt));
      wrap.appendChild(el("dd", "", dd));
      totals.appendChild(wrap);
    };
    const t = order.totals;

    if (t.discountAmount) {
      row(t.discountLabel || "Discount", `−${dollars(t.discountAmount)}`);
    }
    if (order.fulfilment.method === "delivery") {
      row("Delivery fee",
        t.deliveryFee ? `+${dollars(t.deliveryFee)}` : "Free");
    }
    row("Total", dollars(t.total), "account-totals-total");

    const actions = qs(node, "[data-out='actions']");
    const button = (text, className, onClick) => {
      const b = el("button", `btn btn-sm ${className}`, text);

      b.type = "button";
      b.addEventListener("click", onClick);
      actions.appendChild(b);
    };

    // Reorder is a plain link: the order page does the adding.
    const again = el("a", "btn btn-sm btn-outline-primary", "Reorder");

    again.href = addUrl(order.lines);
    again.setAttribute("aria-label", `Add everything in ${order.id} to ` +
      "your cart again");
    actions.appendChild(again);

    if (order.canChange) {
      button("Change", "btn-outline-primary",
        () => this.openChange(order, card));
    }
    if (order.canCancel) {
      button("Cancel order", "btn-outline-secondary",
        () => this.openCancel(order, card));
    }
    if (["paid", "fulfilled"].includes(order.status)) {
      button("Report a problem", "btn-outline-secondary",
        () => this.openReturn(order, card));
    }
    for (const r of order.returns || []) {
      const p = el("p", "account-return", `Problem reported ${placed(r.at)}: ${
        r.status === "requested" ? "we're on it." : r.status}`);

      actions.appendChild(p);
    }

    return node;
  }

  panel(card) {
    const p = qs(card, "[data-out='panel']");

    p.textContent = "";
    p.hidden = false;

    return p;
  }

  closePanel(card) {
    const p = qs(card, "[data-out='panel']");

    p.textContent = "";
    p.hidden = true;
  }

  async dateList(method) {
    if (!this.dates) {
      const { ok, data } = await api("/api/dates");

      this.dates = ok ? data : {};
    }

    return this.dates[method] || [];
  }

  async openChange(order, card) {
    const isDelivery = order.fulfilment.method === "delivery";
    const node = clone(
      isDelivery ? "tpl-change-delivery" : "tpl-change-pickup"
    );
    const form = qs(node, "form");
    const select = qs(form, "[data-dates]");
    const dates = await this.dateList(order.fulfilment.method);

    for (const d of dates) {
      const option = document.createElement("option");

      option.value = d.date;
      option.textContent = d.label;
      select.appendChild(option);
    }
    if (!dates.some((d) => d.date === order.fulfilment.date)) {
      const option = document.createElement("option");

      option.value = order.fulfilment.date;
      option.textContent = `${label(order.fulfilment.date)} (as booked)`;
      select.prepend(option);
    }
    select.value = order.fulfilment.date;
    qs(form, "[name='notes']").value = order.notes || "";

    if (isDelivery) {
      const d = order.fulfilment.delivery || {};

      qs(form, "[name='cooler']").value = d.cooler || "";
      qs(form, "[name='gate']").value = d.gate || "";
      qs(form, "[name='dnotes']").value = d.notes || "";
    } else {
      const o = order.fulfilment.onfarm;

      for (const part of all(form, "[data-onfarm]")) {
        part.hidden = order.fulfilment.method !== "onfarm";
      }
      if (o) {
        const radio = qs(form, `[name='window'][value='${o.window}']`);

        if (radio) radio.checked = true;
        qs(form, "[name='phone']").value = o.phone || "";
      }
    }

    qs(form, "[data-close]").addEventListener("click",
      () => this.closePanel(card));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const body = {
        date: select.value, notes: qs(form, "[name='notes']").value,
      };

      if (isDelivery) {
        body.delivery = {
          cooler: qs(form, "[name='cooler']").value,
          gate: qs(form, "[name='gate']").value,
          notes: qs(form, "[name='dnotes']").value,
        };
      } else if (order.fulfilment.method === "onfarm") {
        const window = qs(form, "[name='window']:checked");

        body.onfarm = {
          window: window ? window.value : "",
          phone: qs(form, "[name='phone']").value,
        };
      }

      const { ok, data } = await api(
        `/api/account/orders/${order.id}/change`, { method: "POST", body }
      );

      if (!ok) {
        this.showErrors(form, data.errors);

        return;
      }

      this.replaceOrder(data.order);
      this.say("Order updated. We emailed you the new details.");
    });

    this.panel(card).appendChild(node);
    select.focus();
  }

  openCancel(order, card) {
    const node = clone("tpl-cancel");
    const form = qs(node, "form");

    qs(form, "[data-out='explain']").textContent = order.status === "paid"
      ? "You've paid, so we'll refund you through Square to the card you " +
        "used. It usually shows within a few business days."
      : "Nothing has been charged. The invoice will be closed.";
    qs(form, "[data-close]").addEventListener("click",
      () => this.closePanel(card));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const { ok, data } = await api(
        `/api/account/orders/${order.id}/cancel`, { method: "POST", body: {} }
      );

      if (!ok) {
        this.say((data.errors && data.errors.order) || "That didn't work.");

        return;
      }

      this.replaceOrder(data.order);
      this.say(order.status === "paid"
        ? "Cancelled. Your refund is on its way."
        : "Cancelled. Nothing was charged.");
    });

    this.panel(card).appendChild(node);
    qs(card, "[data-close]").focus();
  }

  openReturn(order, card) {
    const node = clone("tpl-return");
    const form = qs(node, "form");
    const items = qs(form, "[data-items]");

    for (const line of order.lines) {
      const wrap = el("label", "form-check");
      const box = el("input", "form-check-input");

      box.type = "checkbox";
      box.name = "skus";
      box.value = line.sku;
      wrap.appendChild(box);
      wrap.appendChild(el("span", "form-check-label",
        ` ${line.qty} × ${line.label}`));
      items.appendChild(wrap);
    }

    qs(form, "[data-close]").addEventListener("click",
      () => this.closePanel(card));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const body = {
        reason: qs(form, "[name='reason']").value,
        skus: all(form, "[name='skus']:checked").map((b) => b.value),
      };
      const { ok, data } = await api(
        `/api/account/orders/${order.id}/return`, { method: "POST", body }
      );

      if (!ok) {
        this.showErrors(form, data.errors);

        return;
      }

      this.replaceOrder(data.order);
      this.say("Thanks. We'll be in touch by email.");
    });

    this.panel(card).appendChild(node);
    qs(card, "[name='reason']").focus();
  }

  replaceOrder(order) {
    this.orders = this.orders.map((o) => (o.id === order.id ? order : o));
    this.renderOrders();
    this.renderInvoices();
    const card = document.getElementById(`order-${order.id}`);

    if (card) card.scrollIntoView({ block: "nearest" });
  }

  renderInvoices() {
    const body = document.getElementById("invoices-body");
    const withInvoice = this.orders.filter((o) => o.invoice);

    body.textContent = "";
    document.getElementById("invoices-empty").hidden = withInvoice.length > 0;
    document.getElementById("invoices-table").hidden = withInvoice.length === 0;

    for (const order of withInvoice) {
      const tr = el("tr");
      const cell = (text) => tr.appendChild(el("td", "", text));

      cell(order.id);
      cell(order.invoice.number ? `#${order.invoice.number}` : "—");
      cell(dollars(order.totals.total));
      cell(order.status === "submitted"
        ? "Open"
        : (STATUS[order.status] || ""));

      const td = el("td");

      if (order.invoice.url && ["submitted", "paid", "fulfilled"]
        .includes(order.status)) {
        const a = el("a", "", order.status === "submitted" ? "Pay" : "Receipt");

        a.href = order.invoice.url;
        a.target = "_blank";
        a.rel = "noopener";
        td.appendChild(a);
      }
      tr.appendChild(td);
      body.appendChild(tr);
    }
  }

  renderSupportOrders() {
    const select = document.getElementById("sup-order");

    for (const order of this.orders) {
      const option = document.createElement("option");

      option.value = order.id;
      option.textContent = `${order.id}, ${when(order)}`;
      select.appendChild(option);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("account-app")) new Account().start();
});
