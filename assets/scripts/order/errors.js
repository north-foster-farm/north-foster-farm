// Field errors from the validator, shown next to the field they name.
// Some keys (the date, for one) have a slot in every fulfilment
// section, so the visible one wins.

const visible = (el) => !el.closest("[hidden], [inert]");

// Marked for the eye (Bootstrap's red border) and for a screen
// reader alike.
const mark = (field, invalid) => {
  field.classList.toggle("is-invalid", invalid);
  if (invalid) field.setAttribute("aria-invalid", "true");
  else field.removeAttribute("aria-invalid");
};

export class Errors {
  constructor(form) {
    this.form = form;
  }

  find(attr, key) {
    const matches = Array.from(
      this.form.querySelectorAll(`[${attr}="${key}"]`)
    );

    return matches.find(visible) || matches[0] || null;
  }

  clear() {
    for (const el of this.form.querySelectorAll("[data-error-for]")) {
      el.textContent = "";
      el.style.display = "";
    }
    for (const el of this.form.querySelectorAll(".is-invalid")) {
      mark(el, false);
    }
  }

  // Whether an attempt has put field errors on the page (not the
  // payment's own, and not the Delivery card's warning, which shows
  // before any attempt).
  showing() {
    return Array.from(this.form.querySelectorAll("[data-error-for]"))
      .some((el) => el.dataset.errorFor !== "payment"
        && el.style.display === "block");
  }

  // Brings the errors on the page up to date with a fresh check: a
  // fixed one goes, a changed one is reworded. A field just left shows
  // its own error even if it had none before; others are not added.
  update(errors, left = null) {
    const leftKey = left && left.dataset ? left.dataset.field : null;

    for (const slot of this.form.querySelectorAll("[data-error-for]")) {
      const key = slot.dataset.errorFor;

      if (key === "payment" || !slot.textContent) continue;
      if (errors[key]) {
        slot.textContent = errors[key];
      } else {
        slot.textContent = "";
        slot.style.display = "";
      }
    }
    for (const field of this.form.querySelectorAll(".is-invalid")) {
      if (!errors[field.dataset.field]) mark(field, false);
    }

    if (leftKey && errors[leftKey]) {
      const slot = this.find("data-error-for", leftKey);
      const field = this.find("data-field", leftKey);

      if (slot) {
        slot.textContent = errors[leftKey];
        slot.style.display = "block";
      }
      if (field) mark(field, true);
    }
  }

  show(errors) {
    this.clear();

    let first = null;

    for (const [key, message] of Object.entries(errors)) {
      const slot = this.find("data-error-for", key);
      const field = this.find("data-field", key);

      if (slot) {
        slot.textContent = message;
        slot.style.display = "block";
      }
      if (field) mark(field, true);

      first = first || field || slot;
    }

    if (first) {
      first.scrollIntoView({ block: "center", behavior: "smooth" });
      if (first.focus) first.focus({ preventScroll: true });
    }
  }
}
