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
  paid: "Paid",
  fulfilled: "Delivered",
  cancelled: "Cancelled",
  // From before the checkout moved onto the page.
  submitted: "Awaiting payment",
  abandoned: "Not paid",
};

// "Visa ending 4242", "Apple Pay", "Venmo".
const paidWith = (payment) => {
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
};

const total = (items) => (items || [])
  .reduce((s, x) => s + (x.amount || 0), 0);

const METHOD = {
  delivery: "Delivery",
  scituate: "Drop site",
  onfarm: "On-farm pickup",
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);

  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;

  return node;
};

const clone = (id) => document.getElementById(id).content.cloneNode(true);

const hour12 = (h) => `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`;

const when = (order) => {
  const f = order.fulfilment;
  const day = f.date ? label(f.date) : "";

  if (f.method === "onfarm" && f.onfarm) {
    // Once the farm has confirmed, the window narrows to the hours it
    // picked inside the one the customer asked for.
    const c = f.state === "agreed" && f.onfarm.confirmed;
    const window = c ? `${hour12(c.from)} – ${hour12(c.to)}` : f.onfarm.window;

    return `${METHOD.onfarm}, ${day}, ${window}`;
  }

  return `${METHOD[f.method] || f.method}, ${day}`;
};

const placed = (iso) => new Date(iso).toLocaleDateString("en-US", {
  month: "short", day: "numeric", year: "numeric",
});

// The emails about one order link to /account/orders/<id>/, which
// netlify.toml rewrites to this page. The session says whose order it
// is, so the path carries nothing but the id.
const orderFromPath = () => {
  const found = /^\/account\/orders\/([^/]+)\/?$/.exec(location.pathname);

  return found ? decodeURIComponent(found[1]) : "";
};

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
      // Come back to where they were headed, not just the account
      // page, so a link to one order survives signing in.
      location.replace(`/login/?next=${encodeURIComponent(
        location.pathname + location.search + location.hash
      )}`);

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
    this.openOrder(orderFromPath());
  }

  // Arrived from an email about one order: show that order rather
  // than the top of the list.
  openOrder(id) {
    if (!id) return;

    const card = document.getElementById(`order-${id}`);

    if (!card) {
      this.say(`We couldn't find order ${id} on this account. Here's ` +
        "everything you've ordered.");

      return;
    }

    this.showTab("orders");
    card.classList.add("is-linked");
    card.tabIndex = -1;
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: "center" });
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

    // The address saves once the street, town and ZIP are there; the
    // settings once both names are.
    this.autosave(document.getElementById("address-form"),
      () => this.saveAddress(),
      (f) => f.address1.trim() && f.town.trim()
        && f.zip.replace(/\D/g, "").length === 5);
    this.autosave(document.getElementById("profile-form"),
      () => this.saveProfile(),
      (f) => f.firstName.trim() && f.lastName.trim());
    // The chicken at the top changes the moment one is picked; the
    // save that follows makes it stick.
    document.getElementById("profile-form").addEventListener("change",
      (e) => {
        if (e.target.dataset.field === "avatar") {
          qs(document, "#account-avatar use").setAttribute(
            "href", `#avatar-${e.target.value}`
          );
        }
      });
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

  // A form that saves itself: a checkbox or radio as soon as it
  // changes, a text field when the customer leaves it, and Enter as
  // before. Nothing is sent while `ready` says the form is still
  // being filled in, or when its values are the ones last sent.
  autosave(form, save, ready) {
    const status = qs(form, "[data-autosave]");
    const idle = status.textContent;
    const snapshot = () => JSON.stringify(all(form, "input, textarea")
      .map((f) => (f.type === "checkbox" || f.type === "radio"
        ? [f.name, f.value, f.checked]
        : [f.name, f.value])));
    const values = () => Object.fromEntries(all(form, "[data-field]")
      .filter((f) => f.type !== "checkbox" && f.type !== "radio")
      .map((f) => [f.dataset.field, f.value]));
    let last = null;
    const run = async () => {
      const now = snapshot();

      if (now === last) return;
      if (!ready(values())) {
        status.textContent = idle;

        return;
      }
      last = now;
      status.textContent = "Saving…";
      status.textContent = (await save())
        ? "Saved."
        : "Not saved yet. Check the fields above.";
    };

    // The values are the saved ones once the page has filled them in,
    // so the first edit is measured against those.
    form.addEventListener("focusin", () => {
      if (last === null) last = snapshot();
    });
    form.addEventListener("change", run);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      run();
    });
  }

  // Field errors from the API, next to the fields of one form. A form
  // that saves itself does not pull the focus back to the error.
  showErrors(form, errors, { focus = true } = {}) {
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

    if (first && focus) first.focus();
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
        "drop site are open to everyone.";
      tone = "no";
    }
    status.textContent = text;
    status.dataset.tone = tone;
    status.hidden = !text;
  }

  renderProfile() {
    const c = this.customer;
    const form = document.getElementById("profile-form");

    qs(form, "[data-field='firstName']").value = c.firstName || "";
    qs(form, "[data-field='lastName']").value = c.lastName || "";
    qs(form, "[data-field='phone']").value = c.phone || "";
    qs(form, "[data-field='marketing']").checked = c.marketing === true;
    document.getElementById("prof-email").value = c.email;
    for (const radio of all(form, "[data-field='avatar']")) {
      radio.checked = radio.value === c.avatar;
    }
    for (const box of all(form, "[data-reminder]")) {
      box.checked = !c.reminders || c.reminders[box.dataset.reminder] !== false;
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

  async saveAddress() {
    const form = document.getElementById("address-form");
    const body = {};

    for (const field of all(form, "[data-field]")) {
      body[field.dataset.field] = field.value;
    }

    const { ok, data } = await api("/api/account/address", {
      method: "PUT", body,
    });

    if (!ok) {
      this.showErrors(form, data.errors, { focus: false });

      return false;
    }

    this.clearErrors(form);
    this.customer = data.customer;
    this.renderAddress();
    this.say(data.customer.address.status === "approved"
      ? "Address saved."
      : "Address saved. We'll check it and email you.");

    return true;
  }

  async saveProfile() {
    const form = document.getElementById("profile-form");
    const avatar = qs(form, "[data-field='avatar']:checked");
    const body = {
      firstName: qs(form, "[data-field='firstName']").value,
      lastName: qs(form, "[data-field='lastName']").value,
      phone: qs(form, "[data-field='phone']").value,
      avatar: avatar ? avatar.value : null,
      marketing: qs(form, "[data-field='marketing']").checked,
      reminders: Object.fromEntries(all(form, "[data-reminder]")
        .map((box) => [box.dataset.reminder, box.checked])),
    };
    const { ok, data } = await api("/api/account/profile", {
      method: "PATCH", body,
    });

    if (!ok) {
      this.showErrors(form, data.errors, { focus: false });

      return false;
    }

    this.clearErrors(form);
    this.customer = data.customer;
    this.renderHead();
    forget();

    return true;
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

  // Orders and receipts

  async loadOrders() {
    const { ok, data } = await api("/api/account/orders");

    this.orders = ok ? data.orders : [];
    this.renderOrders();
    this.renderReceipts();
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

    // The farm's side of a pickup: a denied window asks them to pick
    // again; a requested one is waiting on the farm.
    const pickup = qs(node, "[data-out='pickup']");
    const q = order.question;

    if (q && !q.answeredAt && q.kind === "window") {
      pickup.textContent = "We can't do that pickup time" +
        `${q.reason ? `: ${q.reason}` : "."} Please choose another day or ` +
        "window with Change, or cancel the order.";
      pickup.hidden = false;
    } else if (order.fulfilment.method === "onfarm"
      && order.fulfilment.state === "requested"
      && order.status === "paid") {
      pickup.textContent = "Pickup time requested. We'll confirm it by " +
        "email.";
      pickup.hidden = false;
    }

    const note = qs(node, "[data-out='note']");

    if (order.cancelRequested) {
      note.textContent = "We're refunding this order. Your money goes back " +
        "to the way you paid.";
      note.hidden = false;
    } else if (order.refunds.length) {
      const back = total(order.refunds);
      const what = back >= total(order.payments)
        ? "Refunded"
        : `Refunded ${dollars(back)}`;

      note.textContent = `${what} on ${
        placed(order.refunds.at(-1).at)}, back to the way you paid.`;
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
    if (order.payments.length) {
      row("Paid with", order.payments.map(paidWith).join(", then "));
    }

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

      // What is in it and how it comes are changed on the order page,
      // which prices the change (#160). Draft wording.
      const items = el("a", "btn btn-sm btn-outline-primary", "Change items");

      items.href = `/order/?edit=${encodeURIComponent(order.id)}`;
      actions.appendChild(items);
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

  // A one-press action on an order. The answer is the order as it now
  // stands, or an error.
  async post(order, action, thanks) {
    const { ok, data } = await api(
      `/api/account/orders/${order.id}/${action}`, { method: "POST", body: {} }
    );

    if (!ok) {
      this.say((data.errors && data.errors.order) || "That didn't work.");

      return;
    }

    this.replaceOrder(data.order);
    this.say(thanks);
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

    qs(form, "[data-out='explain']").textContent = "We'll refund you the " +
      "way you paid. It usually shows within a few business days.";
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
      this.say("Cancelled. Your refund is on its way.");
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
    this.renderReceipts();
    const card = document.getElementById(`order-${order.id}`);

    if (card) card.scrollIntoView({ block: "nearest" });
  }

  renderReceipts() {
    const body = document.getElementById("receipts-body");
    // One row per payment: an order changed after paying has several.
    const rows = this.orders.flatMap((order) => order.payments
      .map((payment, i) => ({ order, payment, i })));

    body.textContent = "";
    document.getElementById("receipts-empty").hidden = rows.length > 0;
    document.getElementById("receipts-table").hidden = rows.length === 0;

    for (const { order, payment, i } of rows) {
      const tr = el("tr");
      const cell = (text) => tr.appendChild(el("td", "", text));
      const back = total(order.refunds.filter((r) => r.payment === i));

      cell(order.id);
      cell(payment.at ? placed(payment.at) : "");
      cell(dollars(payment.amount));
      cell(paidWith(payment));
      if (back) {
        cell(back >= payment.amount ? "Refunded" : `Refunded ${
          dollars(back)}`);
      } else {
        cell(STATUS[order.status] || "");
      }

      const td = el("td");

      if (payment.receiptUrl) {
        const a = el("a", "", "Receipt");

        a.href = payment.receiptUrl;
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
