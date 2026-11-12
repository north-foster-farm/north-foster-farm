// The date selects and the cutoff countdown. Dates come from the
// server on load, and the clock is anchored to the server's, so a
// visitor's wrong clock cannot offer a closed date.

import { asRounds, mergeScheduled } from "./lib/group.mjs";
import { earliestCutoff, stillOpen } from "./lib/picker.mjs";
import { scheduledChoices } from "./lib/scheduled.mjs";
import { dayName, weekday } from "./lib/zoned.mjs";
import { PickupPicker } from "./pickup-picker.js";
import { clear, whileLoading } from "../utils/skeleton.js";

const RETRY = [2000, 5000, 15000, 30000];
const HOUR = 3_600_000;
// The longest a timer can wait: setTimeout's limit, about 24.8 days.
const MAX_WAIT = 2_147_483_647;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "2 days, 5 hours, and 12 minutes"; the leading zero units are left
// off, so under an hour it is just the minutes.
export const countdown = (days, hours, minutes) => {
  const parts = [];

  if (days) parts.push(plural(days, "day"));
  if (days || hours) parts.push(plural(hours, "hour"));
  parts.push(plural(minutes, "minute"));

  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;

  return `${parts[0]}, ${parts[1]}, and ${parts[2]}`;
};

export class DateLists {
  constructor(form, onChange) {
    this.form = form;
    this.onChange = onChange;
    this.offset = 0;
    this.lists = null;
    this.attempt = 0;
    this.timer = null;
    this.chip = form.querySelector("[data-countdown]");
    this.text = form.querySelector("[data-countdown-text]");
    this.regions = form.querySelectorAll("[data-dates-region]");
    this.again = null;
    // Every occurrence /api/dates has listed, kept after it has gone, so
    // a confirmation can still name where an order is to be picked up.
    this.occurrences = new Map();
    // A buying group's rounds (#471), from /api/group once its code is
    // accepted: /api/dates never lists them, so every load of the
    // lists joins them back in.
    this.extra = [];
    // A location by its code, for a pickup's address; the form sets it
    // from the model (data/locations.json).
    this.place = () => null;
    // The pickup picker (the timetable, #573), made with the first
    // scheduled list.
    this.pickupPicker = null;
    // A paid order's pickup being changed (?edit=), offered "As
    // booked" once the lists no longer have it (lib/picker.mjs).
    this.booked = null;
    // Refreshes the lists when the earliest scheduled pickup closes.
    this.closing = null;
  }

  now() {
    return new Date(Date.now() + this.offset);
  }

  // The lists once, now; false if they couldn't be had. Before a
  // payment goes out, so a pickup time the farm has since dropped is
  // caught before a wallet opens (W11d).
  async refresh() {
    try {
      const res = await fetch("/api/dates", { cache: "no-store" });

      if (!res.ok) return false;
      this.apply(await res.json());

      return true;
    } catch {
      return false;
    }
  }

  // The farm's pickup windows as the validator takes them, rebuilt from
  // the lists: the page never holds the schedule itself. Each scheduled
  // pickup on offer comes back as the `pickup` line that opened it.
  schedule() {
    const windows = ((this.lists && this.lists.onfarm) || []).flatMap((d) =>
      (d.windows || []).map((w) => ({ date: d.date, ...w })));
    const lines = ((this.lists && this.lists.scheduled) || []).map((d) => ({
      date: d.date, code: d.series, action: "pickup",
    }));

    return Object.assign(windows, { lines });
  }

  // The first load, and a Try again: the date fields show their
  // skeletons while it runs (#271). A failure says so under the
  // field, and the lists are asked for again in the background.
  async load() {
    const data = await whileLoading(this.regions, () => this.fetchLists(), {
      render: (lists) => this.apply(lists),
      retry: () => this.load(),
    });

    if (data) {
      this.attempt = 0;
    } else {
      this.retryLater();
    }
  }

  // -> the lists, or null.
  async fetchLists() {
    const res = await fetch("/api/dates", { cache: "no-store" });

    return res.ok ? res.json() : null;
  }

  retryLater() {
    const delay = RETRY[Math.min(this.attempt++, RETRY.length - 1)];

    this.note("We couldn't load the dates. Retrying…");
    clearTimeout(this.again);
    this.again = setTimeout(async () => {
      if (await this.refresh()) {
        this.attempt = 0;
        clear(this.regions);
      } else {
        this.retryLater();
      }
    }, delay);
  }

  apply(data) {
    this.offset = Date.parse(data.now) - Date.now();
    // A round that closed since /api/group gave it goes for good.
    this.extra = stillOpen(this.extra, this.now().getTime());
    this.lists = {
      ...data,
      scheduled: this.scheduled(mergeScheduled(data.scheduled,
        asRounds(this.extra))),
    };

    for (const select of this.form.querySelectorAll("[data-dates]")) {
      this.fill(select, this.lists[select.dataset.dates] || []);
    }

    this.tick();
    this.onChange();
  }

  // The scheduled pickup entries as choices (lib/scheduled.mjs), each
  // remembered by its occurrence id.
  scheduled(list) {
    const choices = scheduledChoices(list);

    for (const c of choices) this.occurrences.set(c.occurrence, c);

    return choices;
  }

  // An occurrence's place and window, from any entry it has had.
  occurrence(id) {
    return this.occurrences.get(id) || null;
  }

  // A buying group's rounds (#471), joined to the scheduled list now
  // and on every load after; `dropExtra` takes them out again when
  // the code is dropped. The pickup chosen stays chosen.
  addScheduled(entries) {
    this.setExtra(entries || []);
  }

  dropExtra() {
    this.setExtra([]);
  }

  setExtra(entries) {
    const gone = new Set(this.extra.map((e) => e.occurrence));

    this.extra = stillOpen(entries, this.now().getTime());
    if (!this.lists) return;

    const base = this.lists.scheduled.filter((d) => !gone.has(d.occurrence));

    this.lists.scheduled = this.scheduled(mergeScheduled(base,
      asRounds(this.extra)));
    this.fill(this.form.querySelector("[data-dates='scheduled']"),
      this.lists.scheduled);
    this.watchClosing();
    this.onChange();
  }

  // A date to choose once the lists come: a restored draft's, or the
  // paid order's being changed. Set on the select before its options
  // exist, the browser would drop it and the first date would win
  // (#284). For `scheduled` the "date" is the pickup's value, the
  // occurrence id; `quiet` keeps the picker's closed note back for a
  // buying group's round the lists gain once its code is checked.
  want(method, date, series = "", { quiet = false } = {}) {
    const select = this.form.querySelector(`[data-dates="${method}"]`);

    if (!select || !date) return;
    select.dataset.want = date;
    if (series) select.dataset.series = series;
    if (quiet) select.dataset.quiet = "true";
    if (this.lists) this.fill(select, this.lists[method] || []);
  }

  // The occurrence id of the pickup chosen, "" while none is.
  scheduledValue() {
    const box = this.form.querySelector("[data-dates='scheduled']");
    const on = box && box.querySelector("input:checked");

    return on ? on.value : "";
  }

  // Chooses a pickup in the list, if it is there, and shows its day.
  choose(value) {
    const box = this.form.querySelector("[data-dates='scheduled']");

    return Boolean(box) && this.picker(box).choose(value);
  }

  // The one picker (pickup-picker.js) round the pickups group.
  picker(box) {
    if (!this.pickupPicker) {
      this.pickupPicker = new PickupPicker(box.closest("[data-picker]"), {
        locate: (entry) => this.place(entry.location),
      });
    }

    return this.pickupPicker;
  }

  // The scheduled pickups on the picker. Nothing is chosen but what
  // the customer chose, or a draft or link named; a draft's closed
  // occurrence of the old drop site falls to that series' next, and a
  // paid order's pickup the list has lost shows "As booked" (`booked`,
  // set by the form for ?edit=).
  fillPickups(box, list) {
    const want = box.dataset.want || "";
    const series = box.dataset.series || "";
    const quiet = box.dataset.quiet === "true";

    delete box.dataset.want;
    delete box.dataset.series;
    delete box.dataset.quiet;
    this.picker(box).render(list, {
      want, series, quiet, booked: this.booked || null, now: this.now(),
    });
  }

  fill(select, list) {
    if (select.dataset.dates === "scheduled") {
      this.fillPickups(select, list);

      return;
    }

    const current = select.dataset.want || select.value;

    select.textContent = "";

    if (list.length === 0) {
      const option = document.createElement("option");

      option.value = "";
      option.textContent = "No dates available right now";
      select.appendChild(option);
      select.disabled = true;

      return;
    }

    for (const entry of list) {
      const option = document.createElement("option");

      option.value = entry.date;
      option.textContent = entry.label;
      select.appendChild(option);
    }

    select.disabled = false;
    select.value = list.some((d) => d.date === current)
      ? current : list[0].date;
    delete select.dataset.want;
  }

  // The 409 answer carries a fresh list for the way that went stale.
  replace(method, list) {
    const select = this.form.querySelector(`[data-dates="${method}"]`);
    const fresh = method === "scheduled" ? this.scheduled(list) : list;

    if (this.lists) this.lists[method] = fresh;
    if (select) this.fill(select, fresh);
    if (method === "delivery" && this.lists) this.tick();
    if (method === "scheduled") this.watchClosing();
    this.onChange();
  }

  note(text, urgency = "") {
    if (!this.chip) return;

    this.text.textContent = text;
    if (urgency) {
      this.chip.dataset.urgency = urgency;
    } else {
      delete this.chip.dataset.urgency;
    }
  }

  // The lists refresh once the earliest scheduled pickup's cutoff has
  // passed, so a closed pickup leaves the picker without a reload or a
  // 409 at payment (#540). A second's margin lets the server's list
  // drop it; a wait past a timer's limit refreshes early and waits
  // again.
  watchClosing() {
    clearTimeout(this.closing);

    const at = this.lists && earliestCutoff(this.lists.scheduled);

    if (at === null || at === undefined) return;

    const wait = Math.max(at - this.now().getTime(), 0) + 1000;

    this.closing = setTimeout(() => {
      this.refresh().then((ok) => ok || this.retryLater());
    }, Math.min(wait, MAX_WAIT));
  }

  tick() {
    clearTimeout(this.timer);
    this.watchClosing();

    if (!this.chip || !this.lists) return;

    const next = this.lists.delivery[0];

    if (!next) {
      this.note("Delivery ordering is closed right now.");

      return;
    }

    const remaining = Date.parse(next.cutoff) - this.now().getTime();

    if (remaining < 0) {
      // The cutoff passed while the page was open: refresh the lists
      // so the closed date leaves the select without a reload.
      this.note("That cutoff just passed. Updating dates…");
      this.refresh().then((ok) => ok || this.retryLater());

      return;
    }

    const minutes = Math.floor(remaining / 60_000);
    const hours = Math.floor(remaining / HOUR);
    const days = Math.floor(hours / 24);
    let urgency = "";
    let every = 60_000;

    if (remaining < HOUR) {
      urgency = "last";
      every = 10_000;
    } else if (remaining < 6 * HOUR) {
      urgency = "soon";
    }

    this.note(`Order within ${countdown(days, hours % 24,
      Math.max(minutes % 60, days || hours ? 0 : 1))} for delivery on ${
      dayName(weekday(next.date))}.`, urgency);
    this.timer = setTimeout(() => this.tick(), every);
  }
}
