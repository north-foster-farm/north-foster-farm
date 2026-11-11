// The pickup-day picker (#540, the design approved on #539), drawn in
// partials/order/pickup-picker.html: a week strip, Sunday to Saturday,
// the chosen day's pickups as radio cards, and a details panel for the
// chosen pickup. One component on the order page (date-lists.js), in
// the lapsed dialog (lapsed.js) and in the account's Change pickup
// (account/main.js). lib/picker.mjs works out what it draws.
//
// The days are native radios, so the arrow keys move between them and
// skip the disabled ones. Every pickup of the list has its radio in the
// pickups group, the other days' cards hidden, so the value chosen is
// the group's checked radio, as it was before the strip (the submitted
// body, drafts and the error anchor don't change).

import {
  NONE, availability, chosenText, dayLabel, detailsOf, keptNote, onePlace,
  pagedText, pagerLabel, pickerWeeks, resolveChoice, weekIndex, weekTitle,
  withBooked,
} from "./lib/picker.mjs";
import { label, today } from "./lib/zoned.mjs";

let seq = 0;

const qs = (root, selector) => root.querySelector(selector);

const span = (text, className = "") => {
  const node = document.createElement("span");

  node.textContent = text;
  if (className) node.className = className;

  return node;
};

export class PickupPicker {
  // `locate(entry)` gives the entry's location (data/locations.json)
  // for the details panel's address, or null to use the entry's own;
  // `onChange` hears a choice the customer made.
  constructor(root, { locate = () => null, onChange = () => {} } = {}) {
    this.root = root;
    this.locate = locate;
    this.onChange = onChange;
    this.prefix = `picker-${++seq}`;
    this.timeZone = root.dataset.timeZone || "America/New_York";
    this.list = [];
    this.weeks = [];
    this.week = 0;
    this.day = "";
    this.today = "";

    const q = (s) => qs(root, s);

    this.empty = q("[data-picker-empty]");
    this.strip = q("[data-picker-strip]");
    this.title = q("[data-picker-title]");
    this.days = q("[data-picker-week]");
    this.pagers = Array.from(root.querySelectorAll("[data-picker-page]"));
    this.note = q("[data-picker-note]");
    this.body = q("[data-picker-body]");
    this.heading = q("[data-picker-day]");
    this.group = q("[data-picker-pickups]");
    this.details = q("[data-picker-details]");
    this.live = q("[data-picker-live]");
    this.tpl = {
      day: q("template[data-picker-tpl='day']"),
      pickup: q("template[data-picker-tpl='pickup']"),
    };

    this.heading.id = `${this.prefix}-day`;
    // The days are one radio group named "Pickup day".
    q("[data-picker-legend]").id = `${this.prefix}-legend`;
    this.days.setAttribute("aria-labelledby", `${this.prefix}-legend`);

    this.days.addEventListener("change", (e) => {
      if (e.target.matches("input")) this.chooseDay(e.target.value);
    });
    for (const button of this.pagers) {
      button.addEventListener("click", () => this.page(
        Number(button.dataset.pickerPage), button
      ));
    }
    this.group.addEventListener("change", () => {
      this.setNote("");
      this.showDetails();
      this.onChange();
    });
    // An error's focus (errors.js) lands on the group, the field: it
    // goes on to the strip's chosen day, or else its first open one.
    this.group.addEventListener("focus", (e) => {
      if (e.target !== this.group) return;

      const day = qs(this.days, "input:checked")
        || qs(this.days, "input:not(:disabled)");

      if (day) day.focus({ preventScroll: true });
    });
  }

  // The occurrence id of the pickup chosen, "" while none is.
  value() {
    const on = qs(this.group, "input:checked");

    return on ? on.value : "";
  }

  entry(value) {
    return this.list.find((d) => d.value === value) || null;
  }

  // Draws a list of scheduled choices (lib/scheduled.mjs). `want` is a
  // draft's or a link's pickup to choose, `series` the old drop site
  // draft's, `booked` the pickup an order being changed holds (shown
  // "As booked" when the list lacks it), `quiet` keeps the closed note
  // back, and `now` is the server's clock. The pickup chosen stays
  // chosen while the list has it; one that has gone says so.
  render(list, {
    want = "", series = "", booked = null, quiet = false, now = new Date(),
  } = {}) {
    const before = this.value();
    const pick = resolveChoice({
      list, current: before, want, series, booked, quiet,
    });

    this.today = today(now, this.timeZone);
    this.list = pick.booked ? withBooked(list, booked) : list;
    this.weeks = pickerWeeks(this.list);
    this.drawPickups(pick.value);

    const some = this.list.length > 0;
    const chosen = this.entry(pick.value);
    const open = (date) => this.list.some((d) => d.date === date);

    this.empty.textContent = NONE;
    this.empty.hidden = some;
    this.strip.hidden = !some;
    this.body.hidden = !some;
    // The chosen pickup's day, or the day the customer was on if it
    // still has a pickup.
    this.day = chosen ? chosen.date : open(this.day) ? this.day : "";
    this.week = weekIndex(this.weeks, this.day);
    this.setNote(keptNote({
      pick, before, shown: this.note.textContent, some,
    }));
    if (some) this.draw();
  }

  drawPickups(value) {
    const one = onePlace(this.list);

    this.group.textContent = "";
    for (const entry of this.list) {
      const node = this.tpl.pickup.content.cloneNode(true);
      const card = qs(node, ".order-pickup");
      const input = qs(node, "input");
      const text = qs(node, "label");
      const name = qs(text, ".order-pickup-name");

      card.dataset.date = entry.date;
      input.id = `${this.prefix}-${entry.value.toLowerCase()}`;
      input.value = entry.value;
      input.checked = entry.value === value;
      text.htmlFor = input.id;
      qs(text, ".order-pickup-time").textContent = entry.window || entry.label;
      qs(text, ".order-pickup-booked").hidden = !entry.booked;
      // With one place, the details panel names it once.
      name.textContent = this.detailsFor(entry).name;
      name.hidden = one && !entry.booked;
      this.group.appendChild(node);
    }
  }

  detailsFor(entry) {
    return detailsOf(entry, this.locate(entry), this.timeZone);
  }

  // The week shown, its title and buttons, then the chosen day.
  draw() {
    const week = this.weeks[this.week];

    if (!week) return;

    this.days.textContent = "";
    for (const day of week.days) {
      const node = this.tpl.day.content.cloneNode(true);
      const input = qs(node, "input");
      const text = qs(node, "label");
      const [wide, narrow] = text.querySelectorAll(
        ".pickup-picker-avail > span:not(.pickup-picker-dot)"
      );
      const n = day.entries.length;

      input.id = `${this.prefix}-day-${day.date}`;
      input.value = day.date;
      input.disabled = !day.open;
      input.checked = day.date === this.day;
      text.htmlFor = input.id;
      qs(text, ".pickup-picker-wd").textContent = day.weekday;
      qs(text, ".pickup-picker-num").textContent = day.number;
      wide.textContent = availability(n);
      narrow.textContent = n ? String(n) : "–";
      qs(text, ".visually-hidden").textContent = dayLabel(day);
      this.days.appendChild(node);
    }

    this.title.textContent = "";
    this.title.append(
      span(weekTitle(week.start, this.today), "pickup-picker-wide"),
      span(weekTitle(week.start, this.today, { short: true }),
        "pickup-picker-narrow"),
    );

    for (const button of this.pagers) {
      const step = Number(button.dataset.pickerPage);
      const to = this.weeks[this.week + step];

      // At an end the button is disabled and named for its way alone.
      button.disabled = !to;
      button.setAttribute("aria-label", to ? pagerLabel(step, to.start)
        : `${step > 0 ? "Next" : "Previous"} week`);
    }

    this.showDay();
  }

  // The chosen day's cards, its heading, and the details of the pickup
  // chosen.
  showDay() {
    for (const card of this.group.querySelectorAll(".order-pickup")) {
      card.hidden = card.dataset.date !== this.day;
    }
    this.heading.hidden = !this.day;
    this.heading.textContent = this.day ? label(this.day) : "";
    if (this.day) {
      this.group.setAttribute("aria-label", `Pickups on ${label(this.day)}`);
    } else {
      this.group.setAttribute("aria-label", "Pickups");
    }
    this.showDetails();
  }

  showDetails() {
    const entry = this.entry(this.value());

    this.details.hidden = !entry;
    if (!entry) return;

    const facts = this.detailsFor(entry);
    const address = qs(this.details, "[data-picker-address]");
    const cutoff = qs(this.details, "[data-picker-cutoff]");

    qs(this.details, "[data-picker-place]").textContent = facts.name;
    address.textContent = "";
    for (const line of facts.address) address.appendChild(span(line));
    address.hidden = !facts.address.length;
    cutoff.textContent = facts.orderBy;
    cutoff.hidden = !facts.orderBy;
  }

  // A day chosen on the strip. A pickup chosen on another day is let
  // go; a day with one pickup chooses it, and the live region says so.
  chooseDay(date) {
    const on = qs(this.group, "input:checked");
    const entries = this.list.filter((d) => d.date === date);

    if (on && this.entry(on.value).date !== date) {
      // A note about the pickup let go no longer holds.
      on.checked = false;
      this.setNote("");
    }
    this.day = date;
    if (entries.length === 1) {
      this.check(entries[0].value);
      this.setNote("");
      this.say(chosenText(entries[0]));
    }
    this.showDay();
    this.onChange();
  }

  check(value) {
    const radio = Array.from(this.group.querySelectorAll("input"))
      .find((input) => input.value === value);

    if (radio) radio.checked = true;

    return radio || null;
  }

  // Chooses a pickup, if the list has it, and shows its day and week.
  choose(value) {
    const entry = this.entry(value);

    if (!entry) return false;
    this.check(value);
    this.day = entry.date;
    this.week = weekIndex(this.weeks, entry.date);
    this.setNote("");
    this.draw();

    return true;
  }

  // ‹ or ›: the next week with a pickup either way. The focus stays on
  // the button, or moves to the other one when this end is reached.
  page(step, button) {
    if (!this.weeks[this.week + step]) return;

    this.week += step;
    this.draw();
    this.say(pagedText(this.weeks[this.week], this.today));
    if (button.disabled) {
      const other = this.pagers.find((b) => b !== button && !b.disabled);

      if (other) other.focus();
    }
  }

  setNote(text) {
    this.note.textContent = text;
    this.note.hidden = !text;
  }

  // The live region, emptied first so the same words are said again.
  say(text) {
    this.live.textContent = "";
    requestAnimationFrame(() => {
      this.live.textContent = text;
    });
  }

  // Forgets the pickup and day chosen, for a picker opened afresh.
  reset() {
    this.group.textContent = "";
    this.day = "";
    this.setNote("");
  }

  // The first day the strip offers, chosen as a customer would: the
  // lapsed dialog opens on it.
  chooseFirst() {
    const week = this.weeks[this.week];
    const day = week && week.days.find((d) => d.open);

    if (day && !this.day) this.chooseDay(day.date);
    if (this.day) this.draw();
  }

  // Asked for a pickup while none is chosen (the lapsed dialog's "Use
  // this", the account's Save changes): the focus goes to the strip and
  // the live region says why, which the move alone would not.
  ask(text) {
    this.say(text);

    return this.focus();
  }

  // Where the focus goes when the picker opens in a dialog or panel:
  // the chosen day, or the first open one.
  focus() {
    const day = qs(this.days, "input:checked")
      || qs(this.days, "input:not(:disabled)");

    if (day) day.focus();

    return Boolean(day);
  }
}
