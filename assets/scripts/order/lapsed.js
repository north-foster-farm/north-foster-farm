// What the customer chose lapsed as they paid (W11d; UX's U1 to U3): a
// pickup time the farm's schedule dropped, or a day that closed. A
// blocking dialog (partials/order/lapsed.html) offers what is open
// now. It pays nothing: "Use this" puts the choice on the form and the
// customer pays again with the same button. Draft wording.

import { CHOOSE } from "./lib/picker.mjs";
import { PickupPicker } from "./pickup-picker.js";

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
  // `locate(entry)` gives a pickup's location for the picker's details
  // panel, as on the form.
  constructor(dialog, { onUse, onOther, locate = () => null }) {
    this.dialog = dialog;
    this.onUse = onUse;
    this.onOther = onOther;
    this.method = null;
    this.returnTo = null;

    if (!dialog) return;

    const q = (s) => dialog.querySelector(s);

    this.title = q("[data-lapsed-title]");
    this.lead = q("[data-lapsed-lead]");
    this.choices = q("[data-lapsed-choices]");
    this.legend = q("[data-lapsed-legend]");
    this.list = q("[data-lapsed-list]");
    this.use = q("[data-lapsed-use]");
    this.other = q("[data-lapsed-other]");
    this.never = q("[data-lapsed-never]");
    // A scheduled pickup is chosen on the form's own picker, the
    // timetable (#573).
    this.pickerBox = q("[data-lapsed-picker]");
    this.picker = new PickupPicker(q("[data-picker]"), { locate });

    this.use.addEventListener("click", () => {
      // A scheduled pickup's value is its occurrence id, which the
      // form's picker takes whole; an on-farm time's is its date and
      // window.
      if (this.method === "scheduled") {
        const value = this.picker.value();

        // None yet: the note says so, and the live region speaks it as
        // the focus goes to the board.
        if (!value) {
          this.picker.setNote(CHOOSE);
          this.picker.ask(CHOOSE);

          return;
        }
        this.close();
        this.onUse({ method: this.method, date: value, window: null });

        return;
      }

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

  // `dates` is the fresh list for `method`, a way of the form, as
  // /api/dates gives it: for on-farm pickup, each day with its windows;
  // for scheduled pickup, its choices (lib/scheduled.mjs), shown on the
  // picker. `returnTo` gets the focus back on "Never mind"; `now` is the
  // server's clock, for the picker's weeks; `closed` is the scheduled
  // pickup that lapsed, if the page knows it, shown struck in its cell
  // so the customer sees what went.
  open(method, dates, returnTo, now = new Date(), { closed = null } = {}) {
    if (!this.dialog) return;

    const scheduled = method === "scheduled";
    const choices = scheduled ? [] : method === "onfarm"
      ? dates.flatMap((d) => (d.windows || []).map((w) => ({
        value: `${d.date}|${w.id}`, text: `${d.label}, ${w.label}`,
      })))
      : dates.map((d) => ({ value: d.date, text: d.label }));
    const some = (scheduled ? dates : choices).length > 0;

    this.method = method;
    this.returnTo = returnTo || document.activeElement;
    this.title.textContent = some
      ? `That ${NOUN[method]} is no longer available`
      : NONE[method];
    this.lead.textContent = some
      ? `Nothing has been charged. Pay again once you've chosen another ${
        method === "onfarm" ? "time" : method === "scheduled" ? "pickup" : "day"
      }.`
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
    this.choices.hidden = !some || scheduled;
    this.pickerBox.hidden = !some || !scheduled;
    if (scheduled && some) {
      // Nothing carried over from the last time it opened, and nothing
      // chosen until the customer chooses: every pickup is one tap.
      this.picker.reset();
      this.picker.render(dates, { now, closed });
    }
    this.use.hidden = !some;
    this.use.textContent = USE[method];
    // With nothing left of this way, the other ways are the way on.
    this.other.textContent = some ? OTHER[method]
      : OTHER[method].replace(/ instead$/, "");
    this.other.classList.toggle("btn-primary", !some);
    this.other.classList.toggle("btn-link", some);

    this.dialog.showModal();
    if (!(scheduled && some && this.picker.focus())) {
      (this.list.querySelector("input") || this.other).focus();
    }
  }

  close(restore = false) {
    if (!this.dialog || !this.dialog.open) return;

    this.dialog.close();
    if (restore && this.returnTo && this.returnTo.focus) this.returnTo.focus();
  }
}
