// The account page. Everything is rendered from /api/me and
// /api/account/orders with DOM APIs, never innerHTML, so nothing a
// customer typed can become markup. Sections are tabs keyed by the
// URL hash.

import { pickupTimes, windowLabel } from "../order/lib/schedule.mjs";
import { dollars } from "../order/lib/totals.mjs";
import { label } from "../order/lib/zoned.mjs";
import { forget, showChick, signOut } from "../session/session.js";
import { api } from "../utils/api.js";
import { isBusy, whileBusy } from "../utils/busy-button.js";

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

// A finished order was delivered only if it went by delivery; the
// rest were picked up (copy's #158 review; the wording is a draft).
const statusOf = (order) => (order.status === "fulfilled"
  && order.fulfilment && order.fulfilment.method !== "delivery"
  ? "Picked up"
  : STATUS[order.status]);

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
    // The window booked (W11d); a record from before may carry the
    // hours the farm confirmed inside it.
    const c = f.onfarm.confirmed;
    const times = pickupTimes(f.onfarm);
    const window = c ? `${hour12(c.from)} – ${hour12(c.to)}`
      : times ? windowLabel(times) : f.onfarm.window;

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
    this.emailChanged();
  }

  // Arrived from the link that moved the account (#240): say so once,
  // then drop the flag so a reload doesn't repeat it. Draft wording.
  emailChanged() {
    const params = new URLSearchParams(location.search);

    if (params.get("email") !== "changed") return;

    params.delete("email");
    history.replaceState(null, "", location.pathname
      + (params.size ? `?${params}` : "") + location.hash);
    document.getElementById("email-change-sent").textContent =
      `Your email is now ${this.customer.email}. Sign in with it from ` +
      "now on.";
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
      signOut);

    // The address saves once the street, town and ZIP are there; the
    // settings once both names are.
    this.autosave(document.getElementById("address-form"),
      () => this.saveAddress(),
      (f) => f.address1.trim() && f.town.trim()
        && f.zip.replace(/\D/g, "").length === 5);
    this.autosave(document.getElementById("profile-form"),
      () => this.saveProfile(),
      (f) => f.firstName.trim() && f.lastName.trim());
    // The chicken saves the moment one is picked, on its own: saved
    // with the names, it was lost whenever they were blank or another
    // field was wrong (#238). The one at the top and the header's
    // change at once.
    const profile = document.getElementById("profile-form");

    profile.addEventListener("change", (e) => {
      if (e.target.dataset.field !== "avatar") return;

      qs(document, "#account-avatar use").setAttribute(
        "href", `#avatar-${e.target.value}`
      );
      showChick(document, e.target.value);
      this.saving(profile, "avatar", () => this.saveAvatar(e.target.value));
    });
    document.getElementById("support-form").addEventListener("submit",
      (e) => this.sendSupport(e));
    this.wireEmailChange();
  }

  // The email changes by a link to the new address (#240): the page
  // asks for it, and following it moves the account and signs in
  // there. Until then nothing changes. The words are drafts.
  wireEmailChange() {
    const open = document.getElementById("email-change-open");
    const panel = document.getElementById("email-change");
    const input = document.getElementById("email-new");
    const send = document.getElementById("email-change-send");
    const error = document.getElementById("err-email-new");
    const sent = document.getElementById("email-change-sent");
    const show = (on) => {
      panel.hidden = !on;
      open.hidden = on;
      open.setAttribute("aria-expanded", String(on));
      input.classList.remove("is-invalid");
      error.textContent = "";
      if (on) {
        sent.textContent = "";
        input.focus();
      } else {
        open.focus();
      }
    };
    const fail = (message) => {
      input.classList.add("is-invalid");
      error.textContent = message;
      input.focus();
    };
    const request = async () => {
      if (isBusy(send)) return;

      const email = input.value.trim();

      if (!email) {
        fail("Enter your new email address.");

        return;
      }

      const { ok, data } = await whileBusy(send, api("/api/account/email", {
        method: "POST", body: { email },
      }).catch(() => ({ ok: false, data: {} })));

      if (!ok) {
        fail((data && data.errors && data.errors.email)
          || "We couldn't send the link. Try again in a moment.");

        return;
      }

      input.value = "";
      show(false);
      sent.textContent = `We sent a link to ${data.email}. Open it to ` +
        "make that your email; until then, sign in with this one.";
    };

    open.addEventListener("click", () => show(true));
    document.getElementById("email-change-cancel").addEventListener("click",
      () => show(false));
    send.addEventListener("click", request);
    // Enter sends the link, never the settings form around it.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") show(false);
      if (e.key !== "Enter") return;
      e.preventDefault();
      request();
    });
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
  // being filled in, or when its values are the ones last sent. The
  // chicken saves on its own (saveAvatar), and so does anything inside
  // [data-own-save] (the email change), so they are left out here.
  autosave(form, save, ready) {
    const own = (f) => f && f.closest && f.closest("[data-own-save]");
    const fields = () => all(form, "input, textarea")
      .filter((f) => f.name !== "avatar" && !own(f));
    const snapshot = () => JSON.stringify(fields()
      .map((f) => (f.type === "checkbox" || f.type === "radio"
        ? [f.name, f.value, f.checked]
        : [f.name, f.value])));
    const values = () => Object.fromEntries(all(form, "[data-field]")
      .filter((f) => f.type !== "checkbox" && f.type !== "radio")
      .map((f) => [f.dataset.field, f.value]));
    let last = null;
    const run = async (e) => {
      if (e && e.target && (e.target.name === "avatar" || own(e.target))) {
        return;
      }

      const now = snapshot();

      if (now === last || !ready(values())) return;
      last = now;
      await this.saving(form, e && e.target && e.target.name, save);
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

  // One save, told on the form's line (#238): "Saving…" with a
  // spinner while it is out, "Saved 👍" for ten seconds, or "Failed
  // to save: <why>" until the next save. A failure also goes to the
  // console with the field that sent it. `save` resolves to { ok,
  // error }.
  async saving(form, field, save) {
    this.saveLine(form, "saving", "Saving…");

    let result;

    try {
      result = await save();
    } catch (error) {
      result = { ok: false, error: "we couldn't reach the farm's site. " +
        "Check your connection." };
      console.error("Account save failed", { field, error });
    }

    if (result.ok) {
      this.saveLine(form, "saved", "Saved 👍");
    } else {
      console.error("Account save failed", { field, error: result.error });
      this.saveLine(form, "failed", `Failed to save: ${result.error}`);
    }

    return result.ok;
  }

  saveLine(form, state, text) {
    const line = qs(form, "[data-autosave]");

    this.fades ||= new Map();
    clearTimeout(this.fades.get(form));
    line.classList.remove("is-fading");
    line.dataset.save = state;
    qs(line, "[data-save-text]").textContent = text;
    if (state !== "saved") return;

    this.fades.set(form, setTimeout(() => {
      line.classList.add("is-fading");
      this.fades.set(form, setTimeout(() => {
        line.dataset.save = "";
        qs(line, "[data-save-text]").textContent = "";
        line.classList.remove("is-fading");
      }, 600));
    }, 10_000));
  }

  // What went wrong, in the words the server gave: the first field
  // error, or its message, or a plain fallback.
  static why(data) {
    const errors = Object.values((data && data.errors) || {});

    return errors[0] || (data && data.error)
      || "something went wrong on our side. Try again.";
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
    const email = document.getElementById("prof-email");

    email.value = c.email;
    // As wide as the address, so Change sits beside it (#240).
    email.size = Math.max(c.email.length, 10);
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
      this.showErrors(form, data && data.errors, { focus: false });

      return { ok: false, error: Account.why(data) };
    }

    // The save line says it saved; the address's own status line says
    // whether we'll check it first.
    this.clearErrors(form);
    this.customer = data.customer;
    this.renderAddress();

    return { ok: true };
  }

  async saveProfile() {
    const form = document.getElementById("profile-form");
    const body = {
      firstName: qs(form, "[data-field='firstName']").value,
      lastName: qs(form, "[data-field='lastName']").value,
      phone: qs(form, "[data-field='phone']").value,
      marketing: qs(form, "[data-field='marketing']").checked,
      reminders: Object.fromEntries(all(form, "[data-reminder]")
        .map((box) => [box.dataset.reminder, box.checked])),
    };
    const { ok, data } = await api("/api/account/profile", {
      method: "PATCH", body,
    });

    if (!ok) {
      this.showErrors(form, data && data.errors, { focus: false });

      return { ok: false, error: Account.why(data) };
    }

    this.clearErrors(form);
    this.customer = data.customer;
    this.renderHead();
    forget();

    return { ok: true };
  }

  // The chicken alone, so a blank name or a wrong phone never holds it
  // back. The header's cached answer is dropped so the next page asks
  // again.
  async saveAvatar(avatar) {
    const form = document.getElementById("profile-form");
    const { ok, data } = await api("/api/account/profile", {
      method: "PATCH", body: { avatar },
    });

    if (!ok) {
      this.showErrors(form, data && data.errors, { focus: false });

      return { ok: false, error: Account.why(data) };
    }

    this.customer = data.customer;
    forget();

    return { ok: true };
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
      : (statusOf(order) || order.status));

    // A booked pickup time the farm gave up asks them to pick again
    // (W11d).
    const pickup = qs(node, "[data-out='pickup']");
    const q = order.question;

    if (q && !q.answeredAt && q.kind === "window") {
      pickup.textContent = "We can't make that pickup time" +
        `${q.reason ? `: ${q.reason}` : "."} Please choose another day and ` +
        "time with Change, or cancel the order.";
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
      for (const part of all(form, "[data-onfarm]")) {
        part.hidden = order.fulfilment.method !== "onfarm";
      }
      if (order.fulfilment.method === "onfarm") {
        const draw = () => this.drawWindows(form, order, dates, select.value);

        select.addEventListener("change", draw);
        draw();
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

        body.onfarm = { window: window ? window.value : "" };
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

  // The chosen day's pickup times, from the farm's schedule (W11d).
  // The day as booked, if the schedule no longer has it, keeps just
  // the booked time, so the notes can change without moving it.
  drawWindows(form, order, dates, date) {
    const box = qs(form, "[data-windows]");
    const tpl = qs(form, "template");
    const o = order.fulfilment.onfarm || {};
    const checked = qs(box, "input:checked");
    const current = checked ? checked.value : o.window;
    const day = dates.find((d) => d.date === date);
    const booked = pickupTimes(o);
    const windows = day ? day.windows
      : date === order.fulfilment.date && booked
        ? [{ id: o.window, label: `${windowLabel(booked)} (as booked)` }]
        : [];
    const pick = windows.some((w) => w.id === current) ? current
      : windows[0] && windows[0].id;

    box.textContent = "";
    for (const w of windows) {
      const node = tpl.content.cloneNode(true);
      const input = qs(node, "input");

      input.value = w.id;
      input.checked = w.id === pick;
      qs(node, "span").textContent = w.label;
      box.appendChild(node);
    }
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
      // When the refund couldn't go through at once, the order is only
      // flagged for the farm to refund (copy's #158 review; draft).
      this.say(data.order.status === "cancelled"
        ? "Cancelled. Your refund is on its way."
        : "We've asked for this cancellation. We'll refund you the way " +
          "you paid and email you when it's done.");
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
        cell(statusOf(order) || "");
      }

      const td = el("td");

      if (payment.receiptUrl) {
        const a = el("a", "", "Receipt");

        a.href = payment.receiptUrl;
        a.target = "_blank";
        a.rel = "noopener";
        td.appendChild(a);
      } else if (payment.method === "venmo") {
        // PayPal gives Venmo no receipt link: ours, under the table.
        const a = el("a", "", "Receipt");

        a.href = "#receipt-card";
        a.addEventListener("click", (e) => {
          e.preventDefault();
          this.showReceipt(order, payment);
        });
        td.appendChild(a);
      }
      tr.appendChild(td);
      body.appendChild(tr);
    }
  }

  // Our receipt for one Venmo payment (#238): what PayPal and the
  // order hold, and the farm's name and address.
  showReceipt(order, payment) {
    const card = document.getElementById("receipt-card");
    const set = (key, text) => {
      qs(card, `[data-receipt="${key}"]`).textContent = text;
    };
    const row = (key, text) => {
      const dt = qs(card, `[data-receipt-row="${key}"]`);

      dt.hidden = !text;
      dt.nextElementSibling.hidden = !text;
      set(key, text || "");
    };

    document.getElementById("receipt-card-h").textContent =
      `Receipt for ${order.id}`;
    set("paid", payment.at ? placed(payment.at) : "");
    set("amount", dollars(payment.amount));
    row("payer", payment.payer);
    row("capture", payment.paypalCaptureId
      ? `PayPal ${payment.paypalCaptureId}` : "");
    card.hidden = false;
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
