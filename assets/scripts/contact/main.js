// The contact page: one form, one request to POST /api/contact, then
// "Thanks, we have it". The fields are checked here first; errors the
// function returns land under their fields the same way. A signed-in
// customer finds their name and email filled in.

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

const prefill = async (form) => {
  const who = await me().catch(() => null);

  if (!who || !who.signedIn || !who.customer) return;

  for (const [key, value] of [
    ["name", who.customer.name], ["email", who.customer.email],
  ]) {
    const field = qs(form, `[data-field="${key}"]`);

    if (field && !field.value && value) field.value = value;
  }
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
