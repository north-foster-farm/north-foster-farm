// The contact page: one form, one request to POST /api/contact, then
// "Thanks, we have it". The fields are checked here first; errors the
// function returns land under their fields the same way. A signed-in
// customer finds their name and email filled in, and may pick one of
// their orders, as on the account page's help form.

import { dollars } from "../order/lib/totals.mjs";
import { api } from "../utils/api.js";
import { looksLikeEmail } from "../utils/email.js";
import { isBusy, whileBusy } from "../utils/busy-button.js";
import { me } from "../session/session.js";

const qs = (root, selector) => root.querySelector(selector);
const all = (root, selector) => Array.from(root.querySelectorAll(selector));

const check = (body) => {
  const errors = {};

  if (!body.name.trim()) errors.name = "Tell us your name.";
  if (!body.email.trim()) {
    errors.email = "Enter your email address, so we can answer.";
  } else if (!looksLikeEmail(body.email)) {
    errors.email = "Enter a valid email address, like you@example.com.";
  }
  if (!body.message.trim()) errors.message = "Write us a message first.";

  return errors;
};

// With this many orders or more, a filter box sits above the list.
const FILTER_FROM = 6;

const placed = (iso) => new Date(iso).toLocaleDateString("en-US", {
  month: "short", day: "numeric", year: "numeric",
});

// "NFF-2610-K3WM, Oct 6, 2026, $42"
const orderText = (order) => [
  order.id,
  order.submittedAt ? placed(order.submittedAt) : "",
  order.totals ? dollars(order.totals.total) : "",
].filter(Boolean).join(", ");

// The customer's own orders, newest first. Signed out, or with none,
// the order row stays hidden and orderId goes as "".
const offerOrders = async (form) => {
  const { ok, data } = await api("/api/account/orders")
    .catch(() => ({ ok: false }));
  const orders = ok && data && Array.isArray(data.orders)
    ? [...data.orders].sort((a, b) =>
      String(b.submittedAt).localeCompare(String(a.submittedAt)))
    : [];

  if (!orders.length) return;

  const row = qs(form, "[data-contact-orders]");
  const select = qs(row, "select");
  const filter = qs(row, "[data-contact-filter]");
  const status = qs(row, "[data-contact-filter-status]");
  const none = select.options[0];

  // The chosen order stays in the list whatever the filter says.
  const show = (term) => {
    const t = term.trim().toLowerCase();
    const chosen = select.value;
    const matches = orders.filter(
      (o) => !t || orderText(o).toLowerCase().includes(t)
    );
    const shown = orders.filter(
      (o) => o.id === chosen || matches.includes(o)
    );

    select.replaceChildren(none,
      ...shown.map((o) => new Option(orderText(o), o.id)));
    select.value = chosen;
    status.textContent = t
      ? `${matches.length} ${matches.length === 1
        ? "order matches" : "orders match"}`
      : "";
  };

  show("");
  if (orders.length >= FILTER_FROM) {
    filter.hidden = false;
    filter.addEventListener("input", () => show(filter.value));
    // Enter in the filter narrows the list; it never sends the form.
    filter.addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.preventDefault();
    });
  }
  row.hidden = false;
};

const prefill = async (form) => {
  const who = await me().catch(() => null);

  if (!who || !who.signedIn || !who.customer) return;

  for (const [key, value] of [
    ["name", who.customer.name], ["email", who.customer.email],
  ]) {
    const field = qs(form, `[data-field="${key}"]`);

    if (field && !field.value && value) field.value = value;
  }

  await offerOrders(form);
};

const start = () => {
  const form = document.getElementById("contact-form");

  if (!form) return;

  const sent = document.getElementById("contact-sent");
  const error = qs(form, "[data-contact-error]");
  const submit = document.getElementById("contact-submit");

  const clearErrors = () => {
    for (const slot of all(form, "[data-error-for]")) slot.textContent = "";
    for (const field of all(form, ".is-invalid")) {
      field.classList.remove("is-invalid");
      field.removeAttribute("aria-invalid");
    }
    error.hidden = true;
  };
  const showErrors = (errors) => {
    clearErrors();
    for (const [key, message] of Object.entries(errors || {})) {
      const slot = qs(form, `[data-error-for="${key}"]`);
      const field = qs(form, `[data-field="${key}"]`);

      if (slot) slot.textContent = message;
      if (field) {
        field.classList.add("is-invalid");
        field.setAttribute("aria-invalid", "true");
      }
    }

    const first = qs(form, ".is-invalid");

    if (first) first.focus();
  };

  // A field's error clears as soon as it is put right.
  form.addEventListener("input", (e) => {
    const field = e.target.closest("[data-field]");

    if (!field || !field.classList.contains("is-invalid")) return;

    const body = { name: "x", email: "x@x.xx", message: "x" };

    body[field.dataset.field] = field.value;
    if (check(body)[field.dataset.field]) return;
    field.classList.remove("is-invalid");
    field.removeAttribute("aria-invalid");
    qs(form, `[data-error-for="${field.dataset.field}"]`).textContent = "";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isBusy(submit)) return;
    clearErrors();

    const body = { website: qs(form, "[name='website']").value };

    for (const field of all(form, "[data-field]")) {
      body[field.dataset.field] = field.value;
    }

    const errors = check(body);

    if (Object.keys(errors).length) {
      showErrors(errors);

      return;
    }

    const { ok, status, data } = await whileBusy(submit,
      api("/api/contact", { method: "POST", body })
        .catch(() => ({ ok: false })));

    if (!ok) {
      if (status === 422 && data && data.errors) {
        showErrors(data.errors);
      } else {
        error.textContent = "We couldn't send that just now. Please try " +
          "again, or email us directly.";
        error.hidden = false;
      }

      return;
    }

    qs(sent, "[data-contact-email]").textContent = body.email.trim();
    form.hidden = true;
    sent.hidden = false;
    sent.scrollIntoView({ block: "nearest" });
  });

  prefill(form);
};

document.addEventListener("DOMContentLoaded", start);
