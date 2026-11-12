// The pickup picker as a timetable (#573, Round 2 of the picker
// bracket on #540), drawn in partials/order/pickup-picker.html: one
// row per place and routine, one column per week, and every open
// pickup a chip, one tap. A summary of the chosen pickup sits under
// the board. One component on the order page (date-lists.js), in the
// lapsed dialog (lapsed.js) and in the account's Change pickup
// (account/main.js). lib/timetable.mjs lays the board out, and
// lib/picker.mjs decides which pickup a list lands on.
//
// The chips are native radios of one group across the board, so the
// arrow keys move chip to chip, place by place, and an empty cell is a
// dash, never a stop. The value chosen is the group's checked radio,
// as it was before the timetable (the submitted body, drafts and the
// error anchor don't change).

import {
  chosenText, closedEntry, keptNote, NONE, resolveChoice, withBooked,
} from "./lib/picker.mjs";
import {
  board, chipCutoff, chipName, chipText, summary,
} from "./lib/timetable.mjs";
import { today } from "./lib/zoned.mjs";

let seq = 0;

const qs = (root, selector) => root.querySelector(selector);

const fill = (node, text) => {
  node.textContent = text;
  node.hidden = !text;
};

export class PickupPicker {
  // `locate(entry)` gives the entry's location (data/locations.json)
  // for the row heads' addresses, or null to use the entry's own;
  // `onChange` hears a choice the customer made.
  constructor(root, { locate = () => null, onChange = () => {} } = {}) {
    this.root = root;
    this.locate = locate;
    this.onChange = onChange;
    this.prefix = `picker-${++seq}`;
    this.timeZone = root.dataset.timeZone || "America/New_York";
    this.list = [];
    this.shown = [];
    this.booked = "";
    this.today = "";

    const q = (s) => qs(root, s);

    this.empty = q("[data-picker-empty]");
    this.note = q("[data-picker-note]");
    this.board = q("[data-picker-board]");
    this.heads = q("[data-picker-heads]");
    this.group = q("[data-picker-pickups]");
    this.summary = q("[data-picker-summary]");
    this.live = q("[data-picker-live]");
    this.tpl = Object.fromEntries(
      ["head", "place", "routine", "cell", "none", "chip", "closed"]
        .map((name) => [name, q(`template[data-picker-tpl='${name}']`)]),
    );

    // The board is one radio group named "Choose a pickup".
    q("[data-picker-legend]").id = `${this.prefix}-legend`;
    this.group.setAttribute("aria-labelledby", `${this.prefix}-legend`);

    this.group.addEventListener("change", (e) => {
      if (!e.target.matches("input")) return;

      const entry = this.entry(e.target.value);

      this.setNote("");
      this.unflag();
      this.showSummary();
      if (entry) this.say(chosenText(entry, this.locate(entry)));
      this.onChange();
    });
    // An error's focus (errors.js) lands on the board, the field: it
    // goes on to the chosen chip, or else the first open one.
    this.group.addEventListener("focus", (e) => {
      if (e.target === this.group) this.focus({ preventScroll: true });
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
  // draft's, `booked` the pickup an order being changed holds (tagged
  // "As booked", and kept on the board when the list lacks it),
  // `closed` a pickup to show struck (the one that lapsed, in the
  // dialog), `quiet` keeps the closed note back, and `now` is the
  // server's clock. The pickup chosen stays chosen while the list has
  // it; one that has gone says so, and stays struck in its cell until
  // the next list.
  render(list, {
    want = "", series = "", booked = null, closed = null, quiet = false,
    now = new Date(),
  } = {}) {
    const before = this.value();
    const known = this.entry(before);
    const pick = resolveChoice({
      list, current: before, want, series, booked, quiet,
    });

    this.today = today(now, this.timeZone);
    this.booked = booked ? booked.value : "";
    this.list = pick.booked ? withBooked(list, booked)
      : list.map((d) => (booked && d.value === booked.value
        ? { ...d, booked: true } : d));

    const gone = closed ? { ...closed, closed: true, booked: false }
      : closedEntry({ pick, before, known });

    this.shown = gone && !this.entry(gone.value)
      ? withBooked(this.list, gone) : this.list;

    const some = this.list.length > 0;

    this.empty.textContent = NONE;
    this.empty.hidden = some;
    this.board.hidden = !some;
    this.setNote(keptNote({
      pick, before, shown: this.note.textContent, some,
    }));
    this.draw(pick.value);
    // A draft moved to another date: its chip is ringed once, so the
    // eye lands on it (no motion, so nothing for reduced motion).
    if (pick.note && pick.value) this.flag(pick.value);
    this.showSummary();
  }

  // The board: the weeks' names, then each place with its routines,
  // each routine a row of cells, one per week.
  draw(value) {
    const { columns, places } = board(this.shown, {
      today: this.today, locate: this.locate,
    });

    this.root.dataset.columns = String(columns.length);
    this.heads.textContent = "";
    for (const column of columns) {
      const node = this.tpl.head.content.cloneNode(true);

      qs(node, ".pickup-picker-head-name").textContent = column.name;
      fill(qs(node, ".pickup-picker-head-range"), column.range);
      this.heads.appendChild(node);
    }

    this.group.textContent = "";
    for (const place of places) {
      const node = this.tpl.place.content.cloneNode(true);
      const set = qs(node, "fieldset");
      const head = qs(set, ".pickup-picker-place-head");

      qs(set, "legend").textContent = place.spoken;
      head.hidden = !place.several;
      if (place.several) {
        qs(head, ".pickup-picker-title").textContent = place.title;
        fill(qs(head, ".pickup-picker-address"), place.address);
      }
      for (const routine of place.routines) {
        set.appendChild(this.routineRow(place, routine, columns, value));
      }
      this.group.appendChild(node);
    }
  }

  routineRow(place, routine, columns, value) {
    const node = this.tpl.routine.content.cloneNode(true);
    const row = qs(node, ".pickup-picker-routine");
    const head = qs(row, ".pickup-picker-rowhead");
    const cells = qs(row, ".pickup-picker-cells");

    // With several routines at a place, each row is a group named for
    // its routine; with one, the place's legend names it all.
    if (routine.spoken) {
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", routine.spoken);
    }
    qs(head, ".pickup-picker-title").textContent = place.several
      ? routine.name : place.title;
    fill(qs(head, ".pickup-picker-address"),
      place.several ? "" : place.address);
    fill(qs(head, ".pickup-picker-when"), routine.when);
    qs(head, ".pickup-picker-round").hidden = !routine.round;

    routine.cells.forEach((entries, i) => {
      const cell = this.tpl.cell.content.cloneNode(true);
      const box = qs(cell, ".pickup-picker-cell");

      if (!entries.length) {
        box.appendChild(this.tpl.none.content.cloneNode(true));
      }
      for (const entry of entries) {
        box.appendChild(this.chip(entry, columns[i].key, value));
      }
      cells.appendChild(cell);
    });

    return node;
  }

  chip(entry, column, value) {
    if (entry.closed) {
      const node = this.tpl.closed.content.cloneNode(true);

      qs(node, ".pickup-picker-date").textContent = chipText(entry.date,
        column);
      qs(node, ".visually-hidden").textContent = chipName(entry, column);

      return node;
    }

    const node = this.tpl.chip.content.cloneNode(true);
    const input = qs(node, "input");
    const text = qs(node, "label");

    input.id = `${this.prefix}-${entry.value.toLowerCase()}`;
    input.value = entry.value;
    input.checked = entry.value === value;
    text.htmlFor = input.id;
    qs(text, ".pickup-picker-date").textContent = chipText(entry.date,
      column);
    fill(qs(text, ".pickup-picker-by"), chipCutoff(entry.cutoff,
      this.timeZone));
    qs(text, ".visually-hidden").textContent = chipName(entry, column);
    qs(node, ".pickup-picker-tag").hidden = !entry.booked;

    return node;
  }

  radio(value) {
    return Array.from(this.group.querySelectorAll("input"))
      .find((input) => input.value === value) || null;
  }

  flag(value) {
    const radio = this.radio(value);

    if (radio) radio.closest(".pickup-picker-chip").classList.add("is-ringed");
  }

  unflag() {
    for (const chip of this.group.querySelectorAll(".is-ringed")) {
      chip.classList.remove("is-ringed");
    }
  }

  // The chosen pickup in words, under the board; hidden while none is
  // chosen.
  showSummary() {
    const entry = this.entry(this.value());

    this.summary.hidden = !entry;
    if (!entry) return;

    const words = summary(entry, this.locate(entry), {
      timeZone: this.timeZone, booked: this.booked,
    });
    const q = (s) => qs(this.summary, s);

    q("[data-picker-summary-title]").textContent = words.title;
    q("[data-picker-when]").textContent = words.when;
    fill(q("[data-picker-place]"), words.name);
    fill(q("[data-picker-cutoff]"), words.orderBy);
  }

  check(value) {
    const radio = this.radio(value);

    if (radio) radio.checked = true;

    return radio;
  }

  // Chooses a pickup, if the list has it.
  choose(value) {
    if (!this.entry(value) || !this.check(value)) return false;
    this.setNote("");
    this.unflag();
    this.showSummary();

    return true;
  }

  setNote(text) {
    fill(this.note, text);
  }

  // The live region, emptied first so the same words are said again.
  say(text) {
    this.live.textContent = "";
    requestAnimationFrame(() => {
      this.live.textContent = text;
    });
  }

  // Forgets the pickup chosen, for a picker opened afresh.
  reset() {
    this.group.textContent = "";
    this.setNote("");
    this.summary.hidden = true;
  }

  // Asked for a pickup while none is chosen (the lapsed dialog's "Use
  // this", the account's Save changes): the focus goes to the board
  // and the live region says why, which the move alone would not.
  ask(text) {
    this.say(text);

    return this.focus();
  }

  // Where the focus goes when the picker opens in a dialog or panel,
  // or an error points at it: the chosen chip, or the first open one.
  // Focus on a radio of a group with none checked chooses nothing.
  focus(options = {}) {
    const chip = qs(this.group, "input:checked")
      || qs(this.group, "input:not(:disabled)");

    if (chip) chip.focus(options);

    return Boolean(chip);
  }
}
