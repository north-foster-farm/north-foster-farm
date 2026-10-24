// What the customer chose lapsed as they paid (W11d; UX's U1 to U3): a
// pickup time the farm's schedule dropped, or a day that closed. A
// blocking dialog (partials/order/lapsed.html) offers what is open
// now. It pays nothing: "Use this" puts the choice on the form and the
// customer pays again with the same button. Draft wording.

// Keyed by the form's way: `scheduled` is scheduled pickup, the drop site
// and every market or pop-up in one list.
const NOUN = {
  onfarm: "pickup time",
  scheduled: "pickup",
  delivery: "delivery day",
};
const NONE = {
  onfarm: "No pickup times are open right now",
  scheduled: "No pickup days are open right now",
  delivery: "No delivery days are open right now",
};
const OTHER = {
  onfarm: "Choose a pickup day or delivery instead",
  scheduled: "Choose on-farm pickup or delivery instead",
  delivery: "Choose on-farm pickup or a pickup day instead",
};
const LEGEND = {
  onfarm: "Pickup times", scheduled: "Pickup days", delivery: "Days",
};
const USE = {
  onfarm: "Use this time",
  scheduled: "Use this pickup",
  delivery: "Use this day",
};

export class Lapsed {
  constructor(dialog, { onUse, onOther }) {
    this.dialog = dialog;
    this.onUse = onUse;
    this.onOther = onOther;
    this.method = null;
    this.returnTo = null;

    if (!dialog) return;

    const q = (s) => dialog.querySelector(s);

    this.title = q("#order-lapsed-title");
    this.lead = q("#order-lapsed-lead");
    this.choices = q("[data-lapsed-choices]");
    this.legend = q("[data-lapsed-legend]");
    this.list = q("[data-lapsed-list]");
    this.use = q("[data-lapsed-use]");
    this.other = q("[data-lapsed-other]");
    this.never = q("[data-lapsed-never]");

    this.use.addEventListener("click", () => {
      const picked = this.list.querySelector("input:checked");

      if (!picked) return;

      // A scheduled pickup's value is its occurrence id, which the
      // form's picker takes whole; an on-farm time's is its date and
      // window.
      const [date, window] = this.method === "scheduled"
        ? [picked.value] : picked.value.split("|");

      this.close();
      this.onUse({ method: this.method, date, window: window || null });
    });
    this.other.addEventListener("click", () => {
      this.close();
      this.onOther(this.method);
    });
    this.never.addEventListener("click", () => this.close(true));
    // Escape is "Never mind" too.
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      this.close(true);
    });
  }

  // `dates` is the fresh list for `method`, a way of the form, as
  // /api/dates gives it: for on-farm pickup, each day with its windows;
  // for scheduled pickup, its choices (lib/scheduled.mjs). `returnTo` gets
  // the focus back on "Never mind".
  open(method, dates, returnTo) {
    if (!this.dialog) return;

    const choices = method === "onfarm"
      ? dates.flatMap((d) => (d.windows || []).map((w) => ({
        value: `${d.date}|${w.id}`, text: `${d.label}, ${w.label}`,
      })))
      : dates.map((d) => ({
        value: d.value || d.date, text: d.text || d.label,
      }));
    const some = choices.length > 0;

    this.method = method;
    this.returnTo = returnTo || document.activeElement;
    this.title.textContent = some
      ? `That ${NOUN[method]} is no longer available`
      : NONE[method];
    this.lead.textContent = some
      ? `Nothing has been charged. Choose another ${
        method === "onfarm" ? "time" : method === "scheduled" ? "pickup" : "day"
      }, then pay as before.`
      : "Nothing has been charged. You can still choose another way to " +
        "get your order.";
    this.legend.textContent = LEGEND[method];
    this.list.textContent = "";
    choices.forEach((choice, i) => {
      const node = document.getElementById("tpl-lapsed-choice").content
        .cloneNode(true);
      const input = node.querySelector("input");
      const label = node.querySelector("label");

      input.id = `order-lapsed-${i}`;
      input.value = choice.value;
      input.checked = i === 0;
      label.htmlFor = input.id;
      label.textContent = choice.text;
      this.list.appendChild(node);
    });
    this.choices.hidden = !some;
    this.use.hidden = !some;
    this.use.textContent = USE[method];
    // With nothing left of this way, the other ways are the way on.
    this.other.textContent = some ? OTHER[method]
      : OTHER[method].replace(/ instead$/, "");
    this.other.classList.toggle("btn-primary", !some);
    this.other.classList.toggle("btn-link", some);

    this.dialog.showModal();
    (this.list.querySelector("input") || this.other).focus();
  }

  close(restore = false) {
    if (!this.dialog || !this.dialog.open) return;

    this.dialog.close();
    if (restore && this.returnTo && this.returnTo.focus) this.returnTo.focus();
  }
}
