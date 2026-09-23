// The contact page: one form, one request, then "Thanks, we have it".
// Field errors from the function land under their fields.

import { api } from "../utils/api.js";

const qs = (root, selector) => root.querySelector(selector);
const all = (root, selector) => Array.from(root.querySelectorAll(selector));

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
    }
    error.hidden = true;
  };
  const showErrors = (errors) => {
    clearErrors();
    for (const [key, message] of Object.entries(errors || {})) {
      const slot = qs(form, `[data-error-for="${key}"]`);
      const field = qs(form, `[data-field="${key}"]`);

      if (slot) slot.textContent = message;
      if (field) field.classList.add("is-invalid");
    }
    const first = qs(form, ".is-invalid");

    if (first) first.focus();
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();

    const body = { website: qs(form, "[name='website']").value };

    for (const field of all(form, "[data-field]")) {
      body[field.dataset.field] = field.value;
    }

    submit.disabled = true;
    submit.textContent = "Sending…";

    const { ok, status, data } = await api("/api/contact", {
      method: "POST", body,
    });

    submit.disabled = false;
    submit.textContent = "Send";

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
};

document.addEventListener("DOMContentLoaded", start);
