// The pickup-day picker (#540; the Flow-first layout of #574), drawn in
// partials/order/pickup-picker.html: every week with a pickup as a row
// of days, Sunday to Saturday, the chosen day's pickups as radio
// cards, the chosen card unfolding its address and order-by line. One
// component on the order page (date-lists.js), in the lapsed dialog
// (lapsed.js) and in the account's Change pickup (account/main.js).
// lib/picker.mjs works out what it draws.
//
// The days are native radios, one group across every row, so the
// arrow keys run from day to day in date order and skip the disabled
// ones. Every pickup of the list has its radio in the pickups group,
// the other days' cards hidden, so the value chosen is the group's
// checked radio, as it was before the strip (the submitted body,
// drafts and the error anchor don't change).
//
// Settling (#574): where the markup asks for it (`data-picker-settle`),
// a chosen pickup lets the rows and cards fold away, inert, behind one
// button. "card", on the order page, settles when the customer leaves
// the Pickup days card, and when a draft, a link or the lapsed dialog
// arrives with a pickup; the card's own facts are the receipt
// (order-form.js renderPickupFacts). "receipt", in the lapsed dialog,
// settles on the preset it opens with and shows its own receipt. The
// checked radio stays in the form either way.

import {
  CLOSED, NONE, availability, chosenText, dayLabel, detailsOf, insteadText,
  keptNote, nextAtSame, onePlace, pickerWeeks, receiptOf, resolveChoice,
  weekTitle, withBooked,
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
  // for a chosen card's address, or null to use the entry's own;
  // `onChange` hears a choice the customer made; `onState` hears any
  // change to what is chosen or to the fold, for a receipt kept outside
  // (the order page's card). `within` is the box whose leaving settles
  // a "card" picker: the Pickup days card.
  constructor(root, {
    locate = () => null, onChange = () => {}, onState = () => {},
    within = null,
  } = {}) {
    this.root = root;
    this.locate = locate;
    this.onChange = onChange;
    this.onState = onState;
    this.prefix = `picker-${++seq}`;
    this.timeZone = root.dataset.timeZone || "America/New_York";
    this.mode = root.dataset.pickerSettle || "";
    this.list = [];
    this.weeks = [];
    this.day = "";
    this.today = "";
    this.settled = false;
    this.offer = null;
    this.heading = "";

    const q = (s) => qs(root, s);

    this.empty = q("[data-picker-empty]");
    this.strip = q("[data-picker-strip]");
    this.rows = q("[data-picker-rows]");
    this.note = q("[data-picker-note]");
    this.noteText = q("[data-picker-note-text]");
    this.instead = q("[data-picker-instead]");
    this.fold = q("[data-picker-fold]");
    this.body = q("[data-picker-body]");
    this.dayHead = q("[data-picker-day]");
    this.group = q("[data-picker-pickups]");
    this.receipt = q("[data-picker-receipt]");
    this.toggle = q("[data-picker-toggle]");
    this.said = q("[data-picker-said]");
    this.live = q("[data-picker-live]");
    this.tpl = {
      row: q("template[data-picker-tpl='row']"),
      day: q("template[data-picker-tpl='day']"),
      pickup: q("template[data-picker-tpl='pickup']"),
    };

    this.dayHead.id = `${this.prefix}-day`;
    // The days are one radio group named "Pickup day".
    q("[data-picker-legend]").id = `${this.prefix}-legend`;
    this.rows.setAttribute("aria-labelledby", `${this.prefix}-legend`);
    this.fold.id = `${this.prefix}-fold`;

    this.rows.addEventListener("change", (e) => {
      if (e.target.matches("input")) this.chooseDay(e.target.value);
    });
    this.group.addEventListener("change", () => {
      this.setNote("");
      this.showState();
      this.onChange();
      this.onState();
    });
    // An error's focus (errors.js) lands on the group, the field: it
    // goes on to the strip's chosen day, or else its first open one.
    this.group.addEventListener("focus", (e) => {
      if (e.target !== this.group) return;

      const day = this.firstDay();

      if (day) day.focus({ preventScroll: true });
    });
    // An error marked on the field opens a settled picker, so the
    // focus that follows can reach it.
    new MutationObserver(() => {
      if (this.settled && this.group.classList.contains("is-invalid")) {
        this.open();
      }
    }).observe(this.group, { attributes: true, attributeFilter: ["class"] });
    this.instead.addEventListener("click", () => this.takeOffer());

    if (this.toggle) {
      this.toggle.setAttribute("aria-controls", this.fold.id);
      this.said.id = `${this.prefix}-said`;
      this.toggle.setAttribute("aria-describedby", this.said.id);
      this.toggle.addEventListener("click", () => {
        if (this.settled) {
          this.open({ focus: true });
        } else {
          this.settle();
        }
      });
    }
    if (this.mode === "card" && within) this.watchLeaving(within);
  }

  // Leaving the card with a pickup chosen settles it: the focus moving
  // out (to Your details, the next card) or a press outside it. Not on
  // choosing, so a customer comparing two days never has the rows fold
  // under them. A window losing focus moves it nowhere, so no settle.
  watchLeaving(within) {
    within.addEventListener("focusout", (e) => {
      if (e.relatedTarget && !within.contains(e.relatedTarget)) this.leave();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!within.contains(e.target)) this.leave();
    });
  }

  leave() {
    if (!this.settled && this.value()) this.settle();
  }

  // The occurrence id of the pickup chosen, "" while none is.
  value() {
    const on = qs(this.group, "input:checked");

    return on ? on.value : "";
  }

  entry(value) {
    return this.list.find((d) => d.value === value) || null;
  }

  // The pickup chosen, as its list entry, or null.
  chosen() {
    return this.entry(this.value());
  }

  // A pickup's receipt (lib/picker.mjs receiptOf), for the order page's
  // card.
  receiptFor(entry) {
    return receiptOf(entry, this.locate(entry), this.timeZone);
  }

  // Draws a list of scheduled choices (lib/scheduled.mjs). `want` is a
  // draft's or a link's pickup to choose, `series` the old drop site
  // draft's, `booked` the pickup an order being changed holds (shown
  // "As booked" when the list lacks it), `quiet` keeps the closed note
  // back, `now` is the server's clock and `heading` titles the
  // receipt. The pickup chosen stays chosen while the list has it; one
  // that has gone says so, and offers the same place's next date. A
  // pickup a draft, a link or an order brings settles the picker.
  render(list, {
    want = "", series = "", booked = null, quiet = false, now = new Date(),
    heading = "",
  } = {}) {
    const before = this.value();
    const gone = before && !list.some((d) => d.value === before)
      ? this.entry(before) : null;
    const pick = resolveChoice({
      list, current: before, want, series, booked, quiet,
    });

    this.today = today(now, this.timeZone);
    this.heading = heading;
    this.list = pick.booked ? withBooked(list, booked) : list;
    this.weeks = pickerWeeks(this.list);
    this.drawPickups(pick.value);

    const some = this.list.length > 0;
    const chosen = this.entry(pick.value);
    const open = (date) => this.list.some((d) => d.date === date);
    const note = keptNote({
      pick, before, shown: this.noteText.textContent, some,
    });

    this.empty.textContent = NONE;
    this.empty.hidden = some;
    this.strip.hidden = !some;
    this.body.hidden = !some;
    // The chosen pickup's day, or the day the customer was on if it
    // still has a pickup.
    this.day = chosen ? chosen.date : open(this.day) ? this.day : "";
    this.setNote(note, note === CLOSED ? this.offerFor(gone) : null);
    if (some) this.draw();
    if (!chosen) {
      this.open();
    } else if (pick.value !== before && (want || pick.booked)) {
      this.settle();
    } else {
      this.showState();
    }
  }

  // The same place's next date after `gone`, the pickup that just
  // closed; on a later refresh, the one offered before while the list
  // still has it.
  offerFor(gone) {
    const next = gone ? nextAtSame(this.list, gone)
      : this.offer && this.entry(this.offer.value);

    return next || null;
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
      const facts = this.detailsFor(entry);
      const address = qs(text, ".order-pickup-address");
      const cutoff = qs(text, ".order-pickup-cutoff");

      card.dataset.date = entry.date;
      input.id = `${this.prefix}-${entry.value.toLowerCase()}`;
      input.value = entry.value;
      input.checked = entry.value === value;
      text.htmlFor = input.id;
      qs(text, ".order-pickup-time").textContent = entry.window || entry.label;
      qs(text, ".order-pickup-booked").hidden = !entry.booked;
      // With one place, the receipt names it once.
      name.textContent = facts.name;
      name.hidden = one && !entry.booked;
      for (const line of facts.address) address.appendChild(span(line));
      address.hidden = !facts.address.length;
      cutoff.textContent = facts.orderBy;
      cutoff.hidden = !facts.orderBy;
      this.group.appendChild(node);
    }
  }

  detailsFor(entry) {
    return detailsOf(entry, this.locate(entry), this.timeZone);
  }

  // Every week as a row, its title over its seven days, then the
  // chosen day. The weekday names show on the first row only, so the
  // rows read as one small calendar.
  draw() {
    this.rows.textContent = "";
    for (const week of this.weeks) {
      const row = this.tpl.row.content.cloneNode(true);
      const box = qs(row, ".pickup-picker-row");
      const days = qs(row, ".pickup-picker-week");
      const [wide, narrow] = qs(row, ".pickup-picker-title").children;

      if (week.gap) box.dataset.gap = "";
      wide.textContent = weekTitle(week.start, this.today);
      narrow.textContent = weekTitle(week.start, this.today, { short: true });
      for (const day of week.days) days.appendChild(this.dayCell(day));
      this.rows.appendChild(row);
    }

    this.showDay();
  }

  dayCell(day) {
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

    return node;
  }

  // The chosen day's cards and its heading.
  showDay() {
    for (const card of this.group.querySelectorAll(".order-pickup")) {
      card.hidden = card.dataset.date !== this.day;
    }
    this.dayHead.hidden = !this.day;
    this.dayHead.textContent = this.day ? label(this.day) : "";
    this.group.setAttribute("aria-label", this.day
      ? `Pickups on ${label(this.day)}` : "Pickups");
    this.showState();
  }

  // The fold, the button and the receipt, as the state now is.
  showState() {
    const entry = this.chosen();

    this.root.toggleAttribute("data-picker-settled", this.settled);
    this.fold.inert = this.settled;
    if (this.toggle) {
      const text = this.settled ? this.toggle.dataset.settledLabel
        : this.toggle.dataset.openLabel;

      this.toggle.textContent = text;
      this.toggle.hidden = !entry || !text;
      this.toggle.setAttribute("aria-expanded", String(!this.settled));
      this.said.textContent = entry ? this.receiptFor(entry).spoken : "";
    }
    if (this.receipt) this.drawReceipt(entry);
  }

  // The lapsed dialog's own receipt, shown while settled.
  drawReceipt(entry) {
    this.receipt.hidden = !(this.settled && entry);
    if (this.receipt.hidden) return;

    const r = this.receiptFor(entry);
    const q = (s) => qs(this.receipt, s);
    const title = q("[data-picker-receipt-title]");

    title.textContent = this.heading;
    title.hidden = !this.heading;
    q("[data-picker-when]").textContent = r.when;
    q("[data-picker-where]").textContent = r.where;
    q("[data-picker-cutoff]").textContent = r.orderBy;
    for (const row of this.receipt.querySelectorAll(
      "[data-picker-cutoff-row]"
    )) {
      row.hidden = !r.orderBy;
    }
  }

  // Folds the picker into its receipt. Only with a pickup chosen, and
  // only where the markup asks for it. Nothing is said: the customer
  // moved on themselves, or the page arrived this way.
  settle() {
    if (!this.mode || !this.value()) return;

    this.settled = true;
    this.showState();
    this.onState();
  }

  // Opens a settled picker on its choice; `focus` puts the focus on
  // the chosen day, as Change pickup does.
  open({ focus = false } = {}) {
    const was = this.settled;

    this.settled = false;
    this.showState();
    if (focus) this.focus();
    if (was) this.onState();
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
    this.onState();
  }

  check(value) {
    const radio = Array.from(this.group.querySelectorAll("input"))
      .find((input) => input.value === value);

    if (radio) radio.checked = true;

    return radio || null;
  }

  // Chooses a pickup, if the list has it, and shows its day; one the
  // page chose (a link, the lapsed dialog) settles the picker.
  choose(value, { settle = true } = {}) {
    const entry = this.entry(value);

    if (!entry) return false;
    this.check(value);
    this.day = entry.date;
    this.setNote("");
    this.draw();
    if (settle) this.settle();
    this.onState();

    return true;
  }

  // The closed note's "Choose … instead": the same place's next date,
  // chosen with the customer's own press, the focus on its card.
  takeOffer() {
    const entry = this.offer && this.entry(this.offer.value);

    if (!entry || !this.choose(entry.value, { settle: false })) return;

    const radio = this.check(entry.value);

    if (radio) radio.focus();
    this.say(chosenText(entry));
    this.onChange();
  }

  setNote(text, offer = null) {
    this.noteText.textContent = text;
    this.note.hidden = !text;
    this.offer = text ? offer : null;
    this.instead.hidden = !this.offer;
    this.instead.textContent = this.offer ? insteadText(this.offer) : "";
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
    this.settled = false;
    this.showState();
  }

  // The first day the rows offer, chosen as a customer would: the
  // lapsed dialog opens on it when it has nothing to preset.
  chooseFirst() {
    const day = this.weeks.flatMap((w) => w.days).find((d) => d.open);

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

  firstDay() {
    return qs(this.rows, "input:checked")
      || qs(this.rows, "input:not(:disabled)");
  }

  // Where the focus goes when the picker opens in a dialog or panel:
  // the chosen day, or the first open one. A settled picker takes it
  // on its button.
  focus() {
    if (this.settled && this.toggle && !this.toggle.hidden) {
      this.toggle.focus();

      return true;
    }

    const day = this.firstDay();

    if (day) day.focus();

    return Boolean(day);
  }
}
