// What the customer chose lapsed as they paid (W11d; UX's U1 to U3): a
// pickup time the farm's schedule dropped, or a day that closed. A
// blocking dialog (partials/order/lapsed.html) offers what is open
// now. It pays nothing: "Use this" puts the choice on the form and the
// customer pays again with the same button. Draft wording.

const NOUN = {
  onfarm: "pickup time",
  scituate: "drop-site day",
  delivery: "delivery day",
};
const NONE = {
  onfarm: "No pickup times are open right now",
  scituate: "No drop-site days are open right now",
  delivery: "No delivery days are open right now",
};
const OTHER = {
  onfarm: "Choose the drop site or delivery instead",
  scituate: "Choose on-farm pickup or delivery instead",
  delivery: "Choose a pickup instead",
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

      const [date, window] = picked.value.split("|");

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

  // `dates` is the fresh list for `method`, as /api/dates gives it: for
  // a pickup, each day with its windows. `returnTo` gets the focus back
  // on "Never mind".
  open(method, dates, returnTo) {
    if (!this.dialog) return;

    const choices = method === "onfarm"
      ? dates.flatMap((d) => (d.windows || []).map((w) => ({
        value: `${d.date}|${w.id}`, text: `${d.label}, ${w.label}`,
      })))
      : dates.map((d) => ({ value: d.date, text: d.label }));
    const some = choices.length > 0;

    this.method = method;
    this.returnTo = returnTo || document.activeElement;
    this.title.textContent = some
      ? `That ${NOUN[method]} is no longer available`
      : NONE[method];
    this.lead.textContent = some
      ? `Nothing has been charged. Choose another ${
        method === "onfarm" ? "time" : "day"}, then pay as before.`
      : "Nothing has been charged. You can still choose another way to " +
        "get your order.";
    this.legend.textContent = method === "onfarm" ? "Pickup times" : "Days";
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
    this.use.textContent = method === "onfarm" ? "Use this time"
      : "Use this day";
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
