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

// A list of dates, Pick-up days' or Group orders' (#703, third
// revision). Its message sits above the cards in a box marked
// `data-error-mode`: a quiet hint on Proceed to checkout, with the
// list left unmarked; an error on Place your order, announced, the
// list marked and drawn with its red bar.
const dates = (field) => !!field && field.hasAttribute("data-dates");

const say = (slot, hint) => {
  const box = slot.closest("[data-error-mode]");

  if (!box) return;
  box.dataset.errorMode = hint ? "hint" : "error";
  if (hint) slot.removeAttribute("role");
  else slot.setAttribute("role", "alert");
};

// Whether a list's message is the hint: `hint` true or false says, and
// null keeps what it is, a hint unless an error is showing.
const quiet = (field, slot, hint) => {
  if (!dates(field)) return false;
  if (hint !== null) return hint;

  const box = slot && slot.closest("[data-error-mode]");

  return !(box && box.dataset.errorMode === "error" && slot.textContent);
};

// Where an error is brought into view: a list of dates by its way's
// title, so the message under it shows too; any other field itself.
const reveal = (first) => {
  const title = dates(first)
    && first.closest(".order-method")?.querySelector(".order-method-title");

  if (title) title.scrollIntoView({ block: "start", behavior: "smooth" });
  else first.scrollIntoView({ block: "center", behavior: "smooth" });
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
      // A list left without a choice stays a hint until an attempt
      // to place the order makes it an error (#703).
      this.put(leftKey, errors[leftKey], null);
    }
  }

  // One message in its slot and its field marked; a list of dates
  // quietly, as a hint, when `hint` asks or, null, it is one already.
  // -> the field, or else the slot.
  put(key, message, hint) {
    const slot = this.find("data-error-for", key);
    const field = this.find("data-field", key);
    const soft = quiet(field, slot, hint);

    if (slot) {
      say(slot, soft);
      slot.textContent = message;
      slot.style.display = "block";
    }
    if (field) mark(field, !soft);

    return field || slot;
  }

  // Every error shown, the first brought into view and focused. With
  // `hint` (Proceed to checkout), a list of dates says its message as
  // a hint (#703).
  show(errors, { hint = false } = {}) {
    this.clear();

    let first = null;

    for (const [key, message] of Object.entries(errors)) {
      const shown = this.put(key, message, hint);

      first = first || shown;
    }

    if (first) {
      reveal(first);
      if (first.focus) first.focus({ preventScroll: true });
    }
  }
}
