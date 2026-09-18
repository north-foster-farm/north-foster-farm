// Field errors from the validator, shown next to the field they name.
// Some keys (the date, for one) have a slot in every fulfilment
// section, so the visible one wins.

const visible = (el) => !el.closest("[hidden], [inert]");

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
      el.classList.remove("is-invalid");
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
      if (field) field.classList.add("is-invalid");

      first = first || field || slot;
    }

    if (first) {
      first.scrollIntoView({ block: "center", behavior: "smooth" });
      if (first.focus) first.focus({ preventScroll: true });
    }
  }
}
