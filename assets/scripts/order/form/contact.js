// The customer's phone field and the "Prefer text or call?" row under
// it (docs/refactors/order-form.md, phase 2). `form` is the order form.

import { phoneOk } from "../lib/validate.mjs";
import { all, qs } from "./dom.js";
import { maskPhone } from "./phone.mjs";

const phoneField = (form) => qs(form, "[data-field='customer.phone']");

// The phone number as "(xxx) xxx-xxxx" while it is typed (phone.mjs).
export const formatPhone = (form, deleting = false) => {
  const input = phoneField(form);
  const raw = input.value;
  const out = maskPhone(raw, deleting);

  if (out !== raw) input.value = out;
};

// "Prefer text or call?" shows once the phone number is one we could
// use, and fades in when it appears.
export const showContact = (form) => {
  const row = qs(form, "[data-contact-row]");
  const phone = phoneField(form);
  const on = phoneOk(phone.value.trim());

  if (row.dataset.shown === String(on)) return;
  row.dataset.shown = String(on);
  if (on) {
    row.classList.add("is-entering");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      row.classList.remove("is-entering");
    }));
  }
};

// Name, email and phone from the customer's record, filled in as
// ordinary fields. `onFilled` runs when any was (the form saves its
// draft).
export const prefill = (form, customer, onFilled) => {
  let any = false;

  for (const input of all(form, "[data-prefill]")) {
    const value = customer[input.dataset.prefill];

    if (!value) continue;
    if (!input.value) input.value = value;
    any = true;
  }
  formatPhone(form);

  showContact(form);
  if (any) onFilled();
};

// The mask and the row follow each keystroke, and start from what the
// field holds.
export const wirePhone = (form) => {
  phoneField(form).addEventListener("input", (e) => {
    formatPhone(form, (e.inputType || "").startsWith("delete"));
    showContact(form);
  });
  formatPhone(form);
  showContact(form);
};
